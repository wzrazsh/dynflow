import { readdir, stat } from 'node:fs/promises';
import { join, relative, resolve } from 'node:path';

const MAX_FILE_SIZE = 1024 * 1024; // 1 MB
const DEFAULT_EXCLUDE = new Set(['.git', 'node_modules']);

/**
 * Files matching these patterns are excluded from the workspace scan to
 * keep runner-internal artifacts out of the user's generated-artifact list:
 *   - `.dynflow-prompt.md` is written by CuaAgentRunner.
 *   - `.dynflow-prompt-{agentId}-{ts}.md` is written by PiDirectRunner
 *     (one per parallel agent).
 */
const LEGACY_PROMPT_FILE = '.dynflow-prompt.md';
const PER_AGENT_PROMPT_FILE_PATTERN = /^\.dynflow-prompt-[a-zA-Z0-9_-]+-\d+\.md$/;

export interface ScanResult {
  list: string[];
  count: number;
  size: number;
}

export async function scanWorkspaceChanges(
  workspacePath: string,
  exclude: Set<string> = DEFAULT_EXCLUDE,
): Promise<ScanResult> {
  const base = resolve(workspacePath);
  const result: ScanResult = { list: [], count: 0, size: 0 };

  async function walk(dir: string): Promise<void> {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (exclude.has(entry.name)) continue;
      if (entry.name === LEGACY_PROMPT_FILE) continue;
      if (PER_AGENT_PROMPT_FILE_PATTERN.test(entry.name)) continue;
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(full);
      } else if (entry.isFile()) {
        const s = await stat(full);
        if (s.size > MAX_FILE_SIZE) continue;
        result.list.push(relative(base, full).replaceAll('\\', '/'));
        result.count += 1;
        result.size += s.size;
      }
    }
  }

  await walk(base);
  return result;
}
