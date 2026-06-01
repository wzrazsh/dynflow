import { readdir, stat } from 'node:fs/promises';
import { join, relative, resolve } from 'node:path';

const MAX_FILE_SIZE = 1024 * 1024; // 1 MB
const DEFAULT_EXCLUDE = new Set(['.git', 'node_modules', '.dynflow-prompt.md']);

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
