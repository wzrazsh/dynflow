import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { scanWorkspaceChanges } from './workspace-scanner.js';

let workspace: string;

beforeEach(() => {
  workspace = mkdtempSync(join(tmpdir(), 'wscan-'));
  mkdirSync(join(workspace, 'src'));
  writeFileSync(join(workspace, 'src', 'a.ts'), 'a');
  writeFileSync(join(workspace, 'README.md'), 'readme');
  mkdirSync(join(workspace, '.git'));
  writeFileSync(join(workspace, '.git', 'HEAD'), 'ref: refs/heads/main');
  mkdirSync(join(workspace, 'node_modules'));
  writeFileSync(join(workspace, 'node_modules', 'pkg.js'), 'module');
});

afterEach(() => rmSync(workspace, { recursive: true, force: true }));

describe('scanWorkspaceChanges', () => {
  it('lists files excluding .git and node_modules', async () => {
    const result = await scanWorkspaceChanges(workspace);
    expect(result.list.sort()).toEqual(['README.md', 'src/a.ts']);
  });

  it('skips files larger than 1MB', async () => {
    const big = 'x'.repeat(2 * 1024 * 1024);
    writeFileSync(join(workspace, 'big.txt'), big);
    const result = await scanWorkspaceChanges(workspace);
    expect(result.list).not.toContain('big.txt');
  });

  it('returns correct count and size', async () => {
    const result = await scanWorkspaceChanges(workspace);
    expect(result.count).toBe(2);
    expect(result.size).toBe(1 + 6); // 'a' (1 byte) + 'readme' (6 bytes)
  });
});
