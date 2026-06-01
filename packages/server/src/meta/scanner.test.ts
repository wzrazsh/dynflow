import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

vi.mock('node:child_process', () => ({
  execFile: vi.fn(
    (
      _cmd: string,
      _args: string[],
      _opts: unknown,
      callback: (err: Error | null) => void,
    ) => {
      callback(new Error('mock clone failure'));
      return {};
    },
  ),
}));

import {
  isValidGithubUrl,
  extractProjectName,
  walkDirectory,
  scanDirectory,
  scanProject,
} from './scanner.js';
import type { ScanOptions } from './scanner.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Shared temp root — created once, cleaned up once. */
let tmpRoot: string;

beforeAll(async () => {
  tmpRoot = path.join(
    os.tmpdir(),
    `dynflow-scanner-test-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
  );
  await fs.mkdir(tmpRoot, { recursive: true });
});

afterAll(async () => {
  await fs.rm(tmpRoot, { recursive: true, force: true });
});

/**
 * Create a sandbox sub-directory for a single test case.
 * Contents are cleaned up after each test.
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

/**
 * Resolve options with defaults so we can pass them to `walkDirectory` which
 * requires `Required<ScanOptions>`.
 */
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
// URL validation
// ---------------------------------------------------------------------------

describe('isValidGithubUrl', () => {
  // valid
  it('1 — accepts standard GitHub URL', () => {
    expect(isValidGithubUrl('https://github.com/owner/repo')).toBe(true);
  });

  it('2 — accepts URL with .git suffix', () => {
    expect(isValidGithubUrl('https://github.com/owner/repo.git')).toBe(true);
  });

  it('3 — accepts URL with trailing slash', () => {
    expect(isValidGithubUrl('https://github.com/owner/repo/')).toBe(true);
  });

  it('4 — accepts repo with dots', () => {
    expect(isValidGithubUrl('https://github.com/owner/my.repo')).toBe(true);
  });

  it('5 — accepts repo with hyphens and underscores', () => {
    expect(isValidGithubUrl('https://github.com/my-org/my_repo')).toBe(true);
  });

  // invalid
  it('6 — rejects SSH URL (git@)', () => {
    expect(isValidGithubUrl('git@github.com:owner/repo.git')).toBe(false);
  });

  it('7 — rejects SSH protocol URL', () => {
    expect(isValidGithubUrl('ssh://git@github.com/owner/repo')).toBe(false);
  });

  it('8 — rejects git protocol URL', () => {
    expect(isValidGithubUrl('git://github.com/owner/repo')).toBe(false);
  });

  it('9 — rejects local file path', () => {
    expect(isValidGithubUrl('/home/user/repo')).toBe(false);
    expect(isValidGithubUrl('C:\\Users\\user\\repo')).toBe(false);
  });

  it('10 — rejects non-GitHub host', () => {
    expect(isValidGithubUrl('https://gitlab.com/owner/repo')).toBe(false);
  });

  it('11 — rejects URL with extra path segments', () => {
    expect(isValidGithubUrl('https://github.com/owner/repo/tree/main/src')).toBe(false);
  });

  it('12 — rejects empty string', () => {
    expect(isValidGithubUrl('')).toBe(false);
  });

  it('13 — rejects malformed URL with no repo', () => {
    expect(isValidGithubUrl('https://github.com/owner')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// extractProjectName
// ---------------------------------------------------------------------------

describe('extractProjectName', () => {
  it('14 — extracts owner/repo from standard URL', () => {
    expect(extractProjectName('https://github.com/owner/repo')).toBe('owner/repo');
  });

  it('15 — strips .git suffix', () => {
    expect(extractProjectName('https://github.com/owner/repo.git')).toBe('owner/repo');
  });

  it('16 — strips trailing slash', () => {
    expect(extractProjectName('https://github.com/owner/repo/')).toBe('owner/repo');
  });

  it('17 — preserves dots in repo name', () => {
    expect(extractProjectName('https://github.com/owner/my.repo')).toBe('owner/my.repo');
  });
});

// ---------------------------------------------------------------------------
// walkDirectory / scanDirectory
// ---------------------------------------------------------------------------

describe('scanDirectory', () => {
  it('18 — returns empty list for empty directory', async () => {
    const dir = await sandbox('empty');
    const { files, error } = await scanDirectory(dir);
    expect(error).toBeUndefined();
    expect(files).toHaveLength(0);
  });

  it('19 — identifies definition files by filename (agent/skill)', async () => {
    const dir = await sandbox('def-filename');
    await writeFile(dir, 'agent-config.json', JSON.stringify({ name: 'test' }));
    await writeFile(dir, 'README.md', '# My Skill Repo');
    await writeFile(dir, 'skill.yaml', 'name: helper');
    await writeFile(dir, 'src/utils.ts', 'export const x = 1;');

    const { files, error } = await scanDirectory(dir);
    expect(error).toBeUndefined();

    const defFiles = files.filter((f) => f.isDefinition);
    // agent-config.json (filename match) + README.md (content match) + skill.yaml (filename match)
    expect(defFiles).toHaveLength(3);
    expect(defFiles.find((f) => f.path.endsWith('agent-config.json'))?.content).toBeTruthy();
    expect(defFiles.find((f) => f.path.endsWith('skill.yaml'))?.content).toBeTruthy();

    // README.md has "skill" in content but NOT in filename — content check covers it
    const readme = files.find((f) => f.path.endsWith('README.md'));
    expect(readme).toBeDefined();
    // README.md content has "Skill" — should be a definition file via content match
    expect(readme!.isDefinition).toBe(true);
    expect(readme!.content).toBeTruthy();

    // src/utils.ts is not a definition extension
    const util = files.find((f) => f.path.endsWith('utils.ts'));
    expect(util).toBeDefined();
    expect(util!.isDefinition).toBe(false);
    expect(util!.content).toBe('');
  });

  it('20 — identifies definition files by content match only', async () => {
    const dir = await sandbox('def-content');
    // filename does NOT contain agent/skill, but content does
    await writeFile(dir, 'config.yaml', 'name: my-agent\nversion: 1');
    await writeFile(dir, 'notes.md', 'This is about skills and how they work');
    await writeFile(dir, 'plain.json', '{"x": 1}');

    const { files, error } = await scanDirectory(dir);
    expect(error).toBeUndefined();

    const config = files.find((f) => f.path === 'config.yaml');
    expect(config).toBeDefined();
    expect(config!.isDefinition).toBe(true);
    expect(config!.content).toContain('my-agent');

    const notes = files.find((f) => f.path === 'notes.md');
    expect(notes).toBeDefined();
    expect(notes!.isDefinition).toBe(true);
    expect(notes!.content).toContain('skills');

    const plain = files.find((f) => f.path === 'plain.json');
    expect(plain).toBeDefined();
    expect(plain!.isDefinition).toBe(false);
    expect(plain!.content).toBe('');
  });

  it('21 — skips node_modules and .git directories', async () => {
    const dir = await sandbox('skip-noise');
    await writeFile(dir, 'agent.json', '{}');
    await writeFile(dir, 'node_modules/some-pkg/agent.json', '{}');
    await writeFile(dir, '.git/config', '[core]');

    const { files, error } = await scanDirectory(dir);
    expect(error).toBeUndefined();
    expect(files).toHaveLength(1);
    expect(files[0].path).toBe('agent.json');
  });

  it('22 — provides correct file sizes', async () => {
    const dir = await sandbox('sizes');
    await writeFile(dir, 'agent.json', '{"name":"test"}');

    const { files } = await scanDirectory(dir);
    expect(files).toHaveLength(1);
    expect(files[0].size).toBeGreaterThan(0);
    expect(files[0].path).toBe('agent.json');
  });

  it('23 — enforces max file count limit', async () => {
    const dir = await sandbox('max-count');
    for (let i = 0; i < 5; i++) {
      await writeFile(dir, `file-${i}.txt`, `content-${i}`);
    }

    const { files, error } = await scanDirectory(dir, { maxFileCount: 3 });
    // Should error but return partial results
    expect(error).toContain('Exceeded maximum file count');
    expect(files.length).toBeLessThanOrEqual(3);
  });

  it('24 — enforces max total bytes limit', async () => {
    const dir = await sandbox('max-bytes');
    // Write files with enough content to exceed a small total limit
    await writeFile(dir, 'big-1.txt', 'x'.repeat(200));
    await writeFile(dir, 'big-2.txt', 'y'.repeat(200));
    await writeFile(dir, 'big-3.txt', 'z'.repeat(200));

    const { files, error } = await scanDirectory(dir, { maxTotalBytes: 350 });
    // Should error but return partial results
    expect(error).toContain('Exceeded maximum total bytes');
    expect(files.length).toBeGreaterThan(0);
    expect(files.length).toBeLessThan(3);
  });

  it('25 — silently skips files exceeding per-file byte limit', async () => {
    const dir = await sandbox('max-file-bytes');
    await writeFile(dir, 'agent.json', '{"name":"t"}');
    await writeFile(dir, 'huge.txt', 'x'.repeat(500));

    const { files } = await scanDirectory(dir, { maxFileBytes: 100 });
    expect(files).toHaveLength(1);
    expect(files[0].path).toBe('agent.json');
  });

  it('26 — rejects symlinks (silently skips)', async () => {
    const dir = await sandbox('symlinks');
    await writeFile(dir, 'real-agent.json', '{}');

    // Try to create a symlink to the real file
    const linkPath = path.join(dir, 'linked-agent.json');
    try {
      await fs.symlink(path.join(dir, 'real-agent.json'), linkPath);
    } catch {
      // Symlink creation may fail on Windows without developer mode — skip test
      return;
    }

    // Verify symlink exists
    const stat = await fs.lstat(linkPath);
    if (!stat.isSymbolicLink()) return; // not a real symlink, skip

    const { files } = await scanDirectory(dir);
    expect(files).toHaveLength(1);
    expect(files[0].path).toBe('real-agent.json');
  });

  it('27 — walks nested directories', async () => {
    const dir = await sandbox('nested');
    await writeFile(dir, 'src/agents/test.json', '{"name":"test"}');
    await writeFile(dir, 'docs/skills.md', '# Skills');
    await writeFile(dir, 'lib/helper.js', '// code');

    const { files } = await scanDirectory(dir);
    // Should find all 3 files
    expect(files).toHaveLength(3);
    const defs = files.filter((f) => f.isDefinition);
    expect(defs).toHaveLength(2); // test.json + skills.md
  });

  it('28 — walks directory with trailing path separator', async () => {
    const dir = await sandbox('trailing-sep');
    await writeFile(dir, 'agent.json', '{}');

    const { files } = await scanDirectory(dir + path.sep);
    expect(files).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// scanProject (with mocked child_process.execFile)
// ---------------------------------------------------------------------------

describe('scanProject — URL validation', () => {
  it('29 — returns error for invalid URL', async () => {
    const result = await scanProject('ssh://git@github.com/owner/repo');
    expect(result.success).toBe(false);
    expect(result.error).toContain('Invalid GitHub URL');
    expect(result.cleanedUp).toBe(true);
  });

  it('30 — returns error for non-GitHub URL', async () => {
    const result = await scanProject('https://gitlab.com/owner/repo');
    expect(result.success).toBe(false);
    expect(result.error).toContain('Invalid GitHub URL');
  });
});

// ---------------------------------------------------------------------------
// scanProject clone error handling (mock execFile)
// ---------------------------------------------------------------------------

describe('scanProject — clone failure', () => {
  it('31 — returns error when clone fails', async () => {
    const result = await scanProject('https://github.com/owner/repo', {
      workspaceDir: tmpRoot,
    });

    expect(result.success).toBe(false);
    expect(result.error).toContain('mock clone failure');
    expect(result.cleanedUp).toBe(true);
  });
});

describe('scanProject — cleanup behaviour', () => {
  it('32 — cleans up temp dir after clone failure', async () => {
    const result = await scanProject('https://github.com/owner/repo', {
      workspaceDir: tmpRoot,
    });

    expect(result.cleanedUp).toBe(true);
    expect(result.success).toBe(false);
    expect(result.error).toContain('mock clone failure');
  });
});

// ---------------------------------------------------------------------------
// Large-scale limit test
// ---------------------------------------------------------------------------

describe('walkDirectory — limits with many files', () => {
  it('33 — maxFileCount = 1 only captures first file', async () => {
    const dir = await sandbox('limit-exact');
    await writeFile(dir, 'a.txt', 'a');
    await writeFile(dir, 'b.txt', 'b');

    const { files, error } = await walkDirectory(dir, dir, withDefaults({ maxFileCount: 1 }));
    expect(error).toContain('Exceeded maximum file count');
    expect(files).toHaveLength(1);
  });

  it('34 — maxFileCount = 0 stops immediately', async () => {
    const dir = await sandbox('limit-zero');
    await writeFile(dir, 'a.txt', 'a');

    const { files, error } = await walkDirectory(dir, dir, withDefaults({ maxFileCount: 0 }));
    expect(error).toBeDefined();
    expect(files).toHaveLength(0);
  });

  it('35 — walkDirectory returns partial files on limit hit', async () => {
    const dir = await sandbox('limit-partial');
    await writeFile(dir, 'a.json', '{"a":1}');
    await writeFile(dir, 'b.json', '{"b":2}');
    await writeFile(dir, 'c.json', '{"c":3}');
    await writeFile(dir, 'd.json', '{"d":4}');

    const { files, error } = await walkDirectory(dir, dir, withDefaults({ maxFileCount: 3 }));
    expect(error).toContain('Exceeded maximum file count');
    // Should have some files (partial results, not necessarily 3 due to async ordering)
    expect(files.length).toBeGreaterThan(0);
    expect(files.length).toBeLessThanOrEqual(3);
  });
});
