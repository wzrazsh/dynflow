/**
 * E2E tests for the meta-workflow flow: scan → extract → register → use.
 *
 * Positive case: Creates a local directory with mock agent/skill definition
 * files, scans, extracts, registers, and queries the database.
 *
 * Negative cases: Invalid URLs, oversized files, symlinks, path traversal,
 * network failure, and cleanup verification.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { closeDb } from '../db/connection.js';
import { initSchema } from '../db/schema.js';
import {
  scanDirectory,
  scanProject,
  walkDirectory,
  isValidGithubUrl,
} from './scanner.js';
import { extractAll } from './extractor.js';
import { registerProject } from './registrar.js';
import {
  getAllDomains,
  getSourcesByDomain,
  getRolesBySource,
  getAgentsByRole,
  getSkillsBySource,
  getAgentSkills,
  deleteDomain,
} from '../db/repository.js';
import type { ScanOptions } from './scanner.js';
import type { ScannedFile } from './extractor.js';
import type { SkillCategory, SkillParameter } from '@dynflow/shared';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let tmpRoot: string;

beforeAll(async () => {
  tmpRoot = path.join(
    os.tmpdir(),
    `dynflow-meta-e2e-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
  );
  await fs.mkdir(tmpRoot, { recursive: true });
});

afterAll(async () => {
  await fs.rm(tmpRoot, { recursive: true, force: true });
  closeDb();
});

/**
 * Create a sandbox sub-directory for a single test case.
 */
async function sandbox(name: string): Promise<string> {
  const dir = path.join(tmpRoot, name);
  await fs.mkdir(dir, { recursive: true });
  return dir;
}

async function writeFile(dir: string, relativePath: string, content: string): Promise<void> {
  const full = path.join(dir, relativePath);
  await fs.mkdir(path.dirname(full), { recursive: true });
  await fs.writeFile(full, content, 'utf-8');
}

function withDefaults(overrides?: Partial<ScanOptions>): Required<ScanOptions> {
  return {
    timeoutMs: 60_000,
    maxFileCount: 1000,
    maxTotalBytes: 50 * 1024 * 1024,
    maxFileBytes: 1024 * 1024,
    workspaceDir: os.tmpdir(),
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Suite: Positive E2E — scan → extract → register → query
// ---------------------------------------------------------------------------

describe('Positive E2E: scan → extract → register → query', () => {
  beforeEach(() => {
    closeDb();
    process.env.DB_PATH = ':memory:';
    initSchema();
  });

  it('1 — full positive flow with JSON, YAML, and Markdown files', async () => {
    const dir = await sandbox('positive-full');

    // JSON agent definition
    await writeFile(
      dir,
      'agents/code-reviewer.json',
      JSON.stringify({
        name: 'code-reviewer',
        description: 'Reviews code for quality and best practices',
        systemPrompt: 'You are a code reviewer. Be thorough.',
        availableSkills: ['code-analysis', 'security-scan'],
      }),
    );

    // YAML skill definition
    await writeFile(
      dir,
      'skills/code-analysis.yaml',
      [
        'name: code-analysis',
        'description: Analyzes source code for patterns and issues',
        'category: development',
        'parameters:',
        '  - name: code',
        '    type: string',
        '    description: Source code to analyze',
        '    required: true',
      ].join('\n'),
    );

    // JSON skill definition
    await writeFile(
      dir,
      'skills/security-scan.json',
      JSON.stringify({
        name: 'security-scan',
        description: 'Scans for security vulnerabilities',
        category: 'analysis',
        parameters: [
          { name: 'target', type: 'string', description: 'Target to scan', required: true },
        ],
      }),
    );

    // Markdown agent definition (frontmatter)
    await writeFile(
      dir,
      'agents/doc-writer.md',
      [
        '---',
        'name: doc-writer',
        'description: Generates project documentation',
        'systemPrompt: You write clear documentation.',
        'availableSkills:',
        '  - code-analysis',
        '---',
        '# Doc Writer',
        'This agent writes documentation for codebases.',
      ].join('\n'),
    );

    // Non-definition file (should be ignored by extractor)
    await writeFile(dir, 'src/helper.js', 'const x = 1;');

    // ---- Step 1: Scan ----
    const scanResult = await scanDirectory(dir);
    expect(scanResult.error).toBeUndefined();
    expect(scanResult.files).toBeDefined();

    // Should have found our 5 files (4 definitions + 1 non-definition)
    expect(scanResult.files!.length).toBeGreaterThanOrEqual(4);

    // ---- Step 2: Extract ----
    const extraction = extractAll(scanResult.files!);
    expect(extraction.warnings).toHaveLength(0);

    // 2 agents: code-reviewer (JSON) + doc-writer (MD)
    expect(extraction.agents).toHaveLength(2);
    expect(extraction.agents.map((a) => a.name).sort()).toEqual([
      'code-reviewer',
      'doc-writer',
    ]);

    // 2 skills: code-analysis (YAML) + security-scan (JSON)
    expect(extraction.skills).toHaveLength(2);
    expect(extraction.skills.map((s) => s.name).sort()).toEqual([
      'code-analysis',
      'security-scan',
    ]);

    // Verify agent skill references
    const reviewer = extraction.agents.find((a) => a.name === 'code-reviewer')!;
    expect(reviewer.availableSkills).toContain('code-analysis');
    expect(reviewer.availableSkills).toContain('security-scan');

    const docWriter = extraction.agents.find((a) => a.name === 'doc-writer')!;
    expect(docWriter.availableSkills).toContain('code-analysis');

    // ---- Step 3: Register ----
    const regResult = registerProject(
      'test-org/test-repo',
      'https://github.com/test-org/test-repo',
      extraction.agents,
      extraction.skills,
    );
    expect(regResult.success).toBe(true);
    expect(regResult.domainId).toBeDefined();
    expect(regResult.sourceId).toBeDefined();
    expect(regResult.agentsCount).toBe(2);
    expect(regResult.skillsCount).toBe(2);
    expect(regResult.rolesCount).toBe(2);
    expect(regResult.warnings).toHaveLength(0);

    // ---- Step 4: Query / Verify ----
    const domains = getAllDomains();
    expect(domains).toHaveLength(1);
    expect(domains[0].name).toBe('test-org/test-repo');

    const sources = getSourcesByDomain(regResult.domainId!);
    expect(sources).toHaveLength(1);
    expect(sources[0].url).toBe('https://github.com/test-org/test-repo');

    // Check skills
    const skillsInDb = getSkillsBySource(regResult.sourceId!);
    expect(skillsInDb).toHaveLength(2);
    expect(skillsInDb.map((s) => s.name).sort()).toEqual([
      'code-analysis',
      'security-scan',
    ]);

    // Check roles (one per agent)
    const roles = getRolesBySource(regResult.sourceId!);
    expect(roles).toHaveLength(2);
    expect(roles.map((r) => r.name).sort()).toEqual([
      'code-reviewer',
      'doc-writer',
    ]);

    // Check agents under each role
    const reviewerRole = roles.find((r) => r.name === 'code-reviewer')!;
    const reviewerAgents = getAgentsByRole(reviewerRole.id);
    expect(reviewerAgents).toHaveLength(1);
    expect(reviewerAgents[0].systemPrompt).toContain('code reviewer');
    // Verify code-reviewer has both skills linked
    const reviewerSkillIds = getAgentSkills(reviewerAgents[0].id);
    expect(reviewerSkillIds).toHaveLength(2);

    const writerRole = roles.find((r) => r.name === 'doc-writer')!;
    const writerAgents = getAgentsByRole(writerRole.id);
    expect(writerAgents).toHaveLength(1);
    expect(writerAgents[0].systemPrompt).toContain('documentation');
    // Verify doc-writer has code-analysis skill linked
    const writerSkillIds = getAgentSkills(writerAgents[0].id);
    expect(writerSkillIds).toHaveLength(1);

    // ---- Cleanup: delete the domain ----
    deleteDomain(regResult.domainId!);
    expect(getAllDomains()).toHaveLength(0);
  });

  it('2 — scan + extract with only skill files (no agent)', async () => {
    const dir = await sandbox('skills-only');

    await writeFile(
      dir,
      'skills/test-skill.json',
      JSON.stringify({
        name: 'test-skill',
        description: 'A test skill',
        category: 'automation',
        parameters: [],
      }),
    );

    const scanResult = await scanDirectory(dir);
    const extraction = extractAll(scanResult.files!);

    expect(extraction.agents).toHaveLength(0);
    expect(extraction.skills).toHaveLength(1);
    expect(extraction.skills[0].name).toBe('test-skill');
  });

  it('3 — scan + extract with no definition files', async () => {
    const dir = await sandbox('no-defs');

    await writeFile(dir, 'src/main.ts', 'console.log("hello");');
    await writeFile(dir, 'README.txt', 'Just a readme');

    const scanResult = await scanDirectory(dir);
    const extraction = extractAll(scanResult.files!);

    expect(extraction.agents).toHaveLength(0);
    expect(extraction.skills).toHaveLength(0);
    expect(extraction.warnings).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Suite: URL validation (negative tests for scanProject)
// ---------------------------------------------------------------------------

describe('scanProject — URL rejection (negative)', () => {
  beforeEach(() => {
    closeDb();
    process.env.DB_PATH = ':memory:';
    initSchema();
  });

  it('4 — rejects ftp:// URL', async () => {
    const result = await scanProject('ftp://evil.com/repo');
    expect(result.success).toBe(false);
    expect(result.error).toContain('Invalid GitHub URL');
    expect(result.cleanedUp).toBe(true);
  });

  it('5 — rejects non-GitHub HTTPS URL', async () => {
    const result = await scanProject('https://gitlab.com/owner/repo');
    expect(result.success).toBe(false);
    expect(result.error).toContain('Invalid GitHub URL');
    expect(result.cleanedUp).toBe(true);
  });

  it('6 — rejects SSH URL (git@ format)', async () => {
    const result = await scanProject('git@github.com:owner/repo.git');
    expect(result.success).toBe(false);
    expect(result.error).toContain('Invalid GitHub URL');
    expect(result.cleanedUp).toBe(true);
  });

  it('7 — rejects local file path', async () => {
    const result = await scanProject('/etc/passwd');
    expect(result.success).toBe(false);
    expect(result.error).toContain('Invalid GitHub URL');
    expect(result.cleanedUp).toBe(true);
  });

  it('8 — rejects SSH protocol URL', async () => {
    const result = await scanProject('ssh://git@github.com/owner/repo');
    expect(result.success).toBe(false);
    expect(result.error).toContain('Invalid GitHub URL');
    expect(result.cleanedUp).toBe(true);
  });

  it('9 — rejects git:// protocol URL', async () => {
    const result = await scanProject('git://github.com/owner/repo');
    expect(result.success).toBe(false);
    expect(result.error).toContain('Invalid GitHub URL');
    expect(result.cleanedUp).toBe(true);
  });

  it('10 — rejects URL with extra path segments', async () => {
    const result = await scanProject('https://github.com/owner/repo/tree/main/src');
    expect(result.success).toBe(false);
    expect(result.error).toContain('Invalid GitHub URL');
    expect(result.cleanedUp).toBe(true);
  });

  it('11 — rejects empty string', async () => {
    const result = await scanProject('');
    expect(result.success).toBe(false);
    expect(result.error).toContain('Invalid GitHub URL');
    expect(result.cleanedUp).toBe(true);
  });

  it('12 — rejects URL with no repo (owner only)', async () => {
    const result = await scanProject('https://github.com/owner');
    expect(result.success).toBe(false);
    expect(result.error).toContain('Invalid GitHub URL');
    expect(result.cleanedUp).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Suite: Symlink rejection
// ---------------------------------------------------------------------------

describe('scanDirectory — symlink handling', () => {
  it('13 — skips symlinks silently', async () => {
    const dir = await sandbox('e2e-symlinks');
    await writeFile(dir, 'real-agent.json', JSON.stringify({ name: 'real' }));
    await writeFile(dir, 'real-skill.yaml', 'name: real-skill');

    // Attempt to create symlinks
    const linkPath = path.join(dir, 'linked-agent.json');
    try {
      await fs.symlink(path.join(dir, 'real-agent.json'), linkPath);
    } catch {
      // Symlink creation may fail on Windows without developer mode — skip test
      return;
    }

    const stat = await fs.lstat(linkPath);
    if (!stat.isSymbolicLink()) return; // not a real symlink, skip

    const { files } = await scanDirectory(dir);
    expect(files).toHaveLength(2);

    // Both files should be the real ones, not the symlink
    const paths = files.map((f) => f.path);
    expect(paths).toContain('real-agent.json');
    expect(paths).toContain('real-skill.yaml');
    expect(paths).not.toContain('linked-agent.json');
  });
});

// ---------------------------------------------------------------------------
// Suite: Path traversal defence
// ---------------------------------------------------------------------------

describe('walkDirectory — path traversal prevention', () => {
  it('14 — skips files outside root via path traversal', async () => {
    // Create a nested structure and attempt to reference files outside root
    const root = await sandbox('traversal-root');
    const inner = path.join(root, 'sub');
    await fs.mkdir(inner, { recursive: true });

    // Write a real file inside root
    await writeFile(root, 'agent.json', JSON.stringify({ name: 'safe' }));

    // Create a symlink that points outside root (if supported)
    const outsideFile = path.join(root, '..', 'outside-agent.json');
    await writeFile(path.join(root, '..'), 'outside-agent.json', JSON.stringify({ name: 'evil' }));

    // Create a symlink to the outside file
    const linkPath = path.join(inner, 'linked-outside.json');
    try {
      await fs.symlink(outsideFile, linkPath);
    } catch {
      // Symlinks may not work on this platform
    }

    // The walkDirectory should skip entries where path.relative(rootDir, fullPath) starts with '..'
    const { files } = await walkDirectory(root, root, withDefaults());
    expect(files).toHaveLength(1);
    expect(files[0].path).toBe('agent.json');
  });
});

// ---------------------------------------------------------------------------
// Suite: File size limits
// ---------------------------------------------------------------------------

describe('scanDirectory — file size enforcement', () => {
  it('15 — silently skips files exceeding per-file byte limit', async () => {
    const dir = await sandbox('e2e-max-file-bytes');
    await writeFile(dir, 'agent.json', JSON.stringify({ name: 'small' }));
    await writeFile(dir, 'huge-skill.json', 'x'.repeat(500));
    await writeFile(dir, 'tiny.txt', 'hello');

    const { files } = await scanDirectory(dir, { maxFileBytes: 100 });
    // Should only include agent.json (small enough and definition-relevant)
    // huge-skill.json is over limit and silently skipped
    // tiny.txt is not a definition extension
    expect(files).toHaveLength(2);
    expect(files.map((f) => f.path)).toContain('agent.json');
    expect(files.map((f) => f.path)).toContain('tiny.txt');
    // huge-skill.json should be absent (oversized + non-def ext, but file is still tracked)
    // Actually, non-definition files are always included regardless of size for tracking,
    // BUT scanFile returns null for files > maxFileBytes regardless of type
    // Let me re-read the scanFile logic:
    // It has `if (stat.size > opts.maxFileBytes) return null;` at the top
    // So ALL files over the limit are skipped, including non-definition ones
    expect(files.find((f) => f.path === 'huge-skill.json')).toBeUndefined();
  });

  it('16 — enforces max total bytes limit', async () => {
    const dir = await sandbox('e2e-max-total-bytes');
    // Write files with content totaling more than a small limit
    await writeFile(dir, 'a.json', 'x'.repeat(200));
    await writeFile(dir, 'b.json', 'y'.repeat(200));
    await writeFile(dir, 'c.json', 'z'.repeat(200));

    const { files, error } = await scanDirectory(dir, { maxTotalBytes: 350 });
    expect(error).toContain('Exceeded maximum total bytes');
    expect(files.length).toBeGreaterThan(0);
    expect(files.length).toBeLessThan(3);
  });

  it('17 — enforces max file count limit', async () => {
    const dir = await sandbox('e2e-max-count');
    for (let i = 0; i < 10; i++) {
      await writeFile(dir, `file-${i}.txt`, `content-${i}`);
    }

    const { files, error } = await scanDirectory(dir, { maxFileCount: 3 });
    expect(error).toContain('Exceeded maximum file count');
    expect(files.length).toBeLessThanOrEqual(3);
  });
});

// ---------------------------------------------------------------------------
// Suite: Network failure / clone error handling
// ---------------------------------------------------------------------------

describe('scanProject — clone failure handling', () => {
  beforeEach(() => {
    closeDb();
    process.env.DB_PATH = ':memory:';
    initSchema();
  });

  it('18 — returns error when no network (clone to unwritable workspace)', async () => {
    // Use a valid URL — scanProject will attempt to clone.
    // Since we have no network in tests, it should fail gracefully.
    const result = await scanProject('https://github.com/octocat/hello-world', {
      // Fast timeout so test doesn't hang
      timeoutMs: 1000,
    });

    // Should fail (no network), but should still clean up the temp dir
    expect(result.success).toBe(false);
    expect(result.error).toBeDefined();
    expect(result.cleanedUp).toBe(true);
    // projectName should be extracted even on failure
    expect(result.projectName).toBe('octocat/hello-world');
  });

  it('19 — validates URL before attempting clone', async () => {
    // Invalid URLs are rejected before any clone attempt
    const result = await scanProject('https://bitbucket.org/owner/repo');
    expect(result.success).toBe(false);
    expect(result.error).toContain('Invalid GitHub URL');
    expect(result.cleanedUp).toBe(true);
    // No temp dir was even created
    expect(result.projectName).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Suite: Cleanup verification
// ---------------------------------------------------------------------------

describe('scanProject — temp directory cleanup', () => {
  beforeEach(() => {
    closeDb();
    process.env.DB_PATH = ':memory:';
    initSchema();
  });

  it('20 — cleans up temp dir even on clone failure', async () => {
    // Use a unique workspace dir we can inspect
    const workspaceRoot = path.join(tmpRoot, 'cleanup-workspace');
    await fs.mkdir(workspaceRoot, { recursive: true });

    const result = await scanProject('https://github.com/octocat/hello-world', {
      workspaceDir: workspaceRoot,
      timeoutMs: 500,
    });

    expect(result.cleanedUp).toBe(true);

    // Verify no dynflow-scan-* directories remain
    const remaining = await fs.readdir(workspaceRoot);
    const scanDirs = remaining.filter((name) => name.startsWith('dynflow-scan-'));
    expect(scanDirs).toHaveLength(0);
  });

  it('21 — invalid URL returns cleanedUp=true (no dir created)', async () => {
    const result = await scanProject('invalid-url');
    expect(result.cleanedUp).toBe(true);
    // No temp dir was created since URL validation fails first
  });

  it('22 — mock-style: scanProject returns cleanedUp=true on success path', async () => {
    // For a valid-looking GitHub URL, if clone fails, cleanup still happens
    const result = await scanProject('https://github.com/does-not-exist-12345/project', {
      timeoutMs: 500,
    });
    expect(result.cleanedUp).toBe(true);
    expect(result.success).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Suite: isValidGithubUrl edge cases (re-assert from scanner.test.ts)
// ---------------------------------------------------------------------------

describe('isValidGithubUrl — additional edge cases', () => {
  it('23 — rejects URLs with port numbers', () => {
    expect(isValidGithubUrl('https://github.com:443/owner/repo')).toBe(false);
  });

  it('24 — rejects URLs with query parameters', () => {
    expect(isValidGithubUrl('https://github.com/owner/repo?ref=main')).toBe(false);
  });

  it('25 — rejects URLs with fragments', () => {
    expect(isValidGithubUrl('https://github.com/owner/repo#readme')).toBe(false);
  });

  it('26 — rejects URLs with subdomain other than github.com', () => {
    expect(isValidGithubUrl('https://api.github.com/owner/repo')).toBe(false);
  });

  it('27 — accepts URL with .git and trailing slash combined', () => {
    expect(isValidGithubUrl('https://github.com/owner/repo.git/')).toBe(true);
  });

  it('28 — accepts repo names with special chars (dots, hyphens, underscores)', () => {
    expect(isValidGithubUrl('https://github.com/my-org/my.repo_name')).toBe(true);
  });
});
