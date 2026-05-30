import { access, readdir, readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { GstackSkillConfig } from './types.js';
import { extractFrontmatter, parseSkillReference, formatSkillReference } from './skill-parser.js';

const DEFAULT_GSTACK_REPO_DIR = 'E:\\workspace\\gstack';

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

function normalizeName(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]/g, '');
}

async function findAllSkillPaths(repoDir: string): Promise<Map<string, string>> {
  const skillMap = new Map<string, string>();

  async function walk(dir: string): Promise<void> {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      const fullPath = join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(fullPath);
      } else if (entry.name === 'SKILL.md') {
        try {
          const content = await readFile(fullPath, 'utf8');
          const fm = extractFrontmatter(content);
          const nameMatch = fm.match(/^name:\s*(.+)$/m);
          if (nameMatch) {
            skillMap.set(nameMatch[1].trim(), fullPath);
          }
        } catch {
          // Skip unreadable files
        }
      }
    }
  }

  await walk(repoDir);
  return skillMap;
}

/**
 * Load raw SKILL.md content from filesystem.
 * Searches the repo directory first, then the installed skills directory.
 */
export async function loadSkillRaw(
  skillName: string,
  repoDir?: string,
  skillsDir?: string,
): Promise<string | undefined> {
  const gstackRepoDir = repoDir ?? process.env.GSTACK_REPO_DIR ?? DEFAULT_GSTACK_REPO_DIR;
  const directSkillPath = join(gstackRepoDir, skillName, 'SKILL.md');

  if (await exists(directSkillPath)) {
    return readFile(directSkillPath, 'utf8');
  }

  // Strategy 1.5: Recursive scan with frontmatter matching
  // Handles skills nested in subdirectories (e.g. browser-skills/hackernews-frontpage)
  // and the root gstack skill (repoDir/SKILL.md)
  const skillMap = await findAllSkillPaths(gstackRepoDir);
  const matchedPath = skillMap.get(skillName);
  if (matchedPath) {
    return readFile(matchedPath, 'utf8');
  }

  const gstackSkillsDir =
    skillsDir ?? process.env.GSTACK_SKILLS_DIR ?? join(homedir(), '.codex', 'skills');

  if (!(await exists(gstackSkillsDir))) {
    return undefined;
  }

  const entries = await readdir(gstackSkillsDir, { withFileTypes: true });
  const normalizedTarget = normalizeName(skillName);
  const candidates = entries
    .filter(entry => entry.isDirectory())
    .map(entry => entry.name)
    .filter(name => {
      const normalizedName = normalizeName(name);
      return (
        normalizedName === normalizedTarget ||
        (normalizedName.includes('gstack') && normalizedName.includes(normalizedTarget))
      );
    });

  for (const candidate of candidates) {
    const skillPath = join(gstackSkillsDir, candidate, 'SKILL.md');
    if (await exists(skillPath)) {
      return readFile(skillPath, 'utf8');
    }
  }

  return undefined;
}

/**
 * Load a gstack skill and inject into systemPrompt.
 * Includes safety guard to prevent LLM from executing external instructions.
 */
export async function loadSkillForPrompt(config: GstackSkillConfig): Promise<string> {
  const raw = await loadSkillRaw(config.skillName, config.repoDir, config.skillsDir);

  if (raw) {
    const reference = parseSkillReference(config.skillName, raw);
    return formatSkillReference(reference, config.fallbackPrompt);
  }

  return [
    config.fallbackPrompt,
    '',
    `Fallback reference for gstack skill "${config.skillName}".`,
    'Install gstack locally or set GSTACK_SKILLS_DIR to load the real skill prompt.',
  ].join('\n');
}

/**
 * Check whether a gstack skill is available on disk.
 */
export async function isSkillAvailable(skillName: string): Promise<boolean> {
  return (await loadSkillRaw(skillName)) !== undefined;
}
