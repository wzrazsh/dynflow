import { execFile } from 'node:child_process';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';
import { WorkspaceManager } from './workspace-manager.js';

const execFileAsync = promisify(execFile);
const roots: string[] = [];

async function git(cwd: string, ...args: string[]): Promise<string> {
  const { stdout } = await execFileAsync('git', args, { cwd, windowsHide: true });
  return stdout.trim();
}

async function createRepository(): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'dynflow-worktree-'));
  roots.push(root);
  await git(root, 'init');
  await git(root, 'config', 'user.name', 'DynFlow Test');
  await git(root, 'config', 'user.email', 'test@dynflow.local');
  await fs.writeFile(path.join(root, 'file.txt'), 'base\n');
  await git(root, 'add', '-A');
  await git(root, 'commit', '-m', 'base');
  return root;
}

afterEach(async () => {
  for (const root of roots.splice(0)) {
    await fs.rm(root, { recursive: true, force: true });
  }
});

describe('WorkspaceManager', () => {
  it('isolates write agents in git worktrees and applies commits', async () => {
    const root = await createRepository();
    const manager = new WorkspaceManager();
    const prepared = await manager.prepare('run-1', 'writer-1', root, 'write');

    expect(prepared.kind).toBe('git-worktree');
    await fs.writeFile(path.join(prepared.path, 'file.txt'), 'changed\n');
    const finalized = await manager.finalize(prepared, 'writer-1');
    expect(finalized.resultCommit).toBeTruthy();
    expect(await fs.readFile(path.join(root, 'file.txt'), 'utf8')).toBe('base\n');

    const applied = await manager.apply(root, finalized);
    expect(applied.applied).toBe(true);
    expect(
      (await fs.readFile(path.join(root, 'file.txt'), 'utf8')).replace(/\r\n/g, '\n'),
    ).toBe('changed\n');
  }, 20_000);
});
