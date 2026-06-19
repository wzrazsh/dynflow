import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export interface PreparedAgentWorkspace {
  path: string;
  kind: 'shared' | 'git-worktree' | 'directory-copy';
  sourcePath?: string;
  baseCommit?: string;
}

export interface FinalizedAgentWorkspace extends PreparedAgentWorkspace {
  resultCommit?: string;
  files: string[];
}

export interface ApplyWorkspaceResult {
  applied: boolean;
  commit?: string;
  files: string[];
}

export class MergeConflictError extends Error {
  readonly code = 'MERGE_CONFLICT';

  constructor(
    message: string,
    readonly files: string[] = [],
  ) {
    super(message);
    this.name = 'MergeConflictError';
  }
}

function safeStepName(stepKey: string): string {
  return createHash('sha256').update(stepKey).digest('hex').slice(0, 20);
}

async function runGit(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync('git', args, {
    cwd,
    windowsHide: true,
    maxBuffer: 10 * 1024 * 1024,
  });
  return stdout.trim();
}

async function isGitRepository(workspacePath: string): Promise<boolean> {
  try {
    return (await runGit(workspacePath, ['rev-parse', '--is-inside-work-tree'])) === 'true';
  } catch {
    return false;
  }
}

async function listFiles(root: string): Promise<string[]> {
  const result: string[] = [];
  const walk = async (dir: string): Promise<void> => {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.name === '.git' || entry.name === 'node_modules') continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(full);
      } else if (entry.isFile()) {
        result.push(path.relative(root, full).replace(/\\/g, '/'));
      }
    }
  };
  await walk(root);
  return result.sort();
}

export class WorkspaceManager {
  private nonGitWriteChain: Promise<void> = Promise.resolve();

  async prepare(
    workflowRunId: string,
    stepKey: string,
    workspacePath: string,
    mode: 'read' | 'write',
  ): Promise<PreparedAgentWorkspace> {
    if (mode === 'read') {
      return { path: workspacePath, kind: 'shared' };
    }

    const root = path.join(
      path.dirname(workspacePath),
      '.dynflow-worktrees',
      workflowRunId,
    );
    const target = path.join(root, safeStepName(stepKey));
    await fs.mkdir(root, { recursive: true });

    if (await isGitRepository(workspacePath)) {
      const baseCommit = await runGit(workspacePath, ['rev-parse', 'HEAD']);
      await fs.rm(target, { recursive: true, force: true });
      await runGit(workspacePath, [
        'worktree',
        'add',
        '--detach',
        target,
        baseCommit,
      ]);
      return {
        path: target,
        kind: 'git-worktree',
        sourcePath: workspacePath,
        baseCommit,
      };
    }

    // Non-git workspaces use a serialized directory copy. The lock only
    // protects creation; apply() serializes writes back to the source.
    await this.nonGitWriteChain;
    await fs.rm(target, { recursive: true, force: true });
    await fs.cp(workspacePath, target, {
      recursive: true,
      filter: (source) =>
        !source.includes(`${path.sep}.dynflow-worktrees${path.sep}`),
    });
    return { path: target, kind: 'directory-copy' };
  }

  async finalize(
    workspace: PreparedAgentWorkspace,
    stepKey: string,
  ): Promise<FinalizedAgentWorkspace> {
    if (workspace.kind === 'shared') {
      return { ...workspace, files: [] };
    }

    if (workspace.kind === 'git-worktree') {
      const status = await runGit(workspace.path, [
        'status',
        '--porcelain',
        '--untracked-files=all',
      ]);
      const files = status
        .split(/\r?\n/)
        .filter(Boolean)
        .map((line) => line.slice(3).trim());
      if (files.length === 0) return { ...workspace, files };

      await runGit(workspace.path, ['add', '-A']);
      await runGit(workspace.path, [
        '-c',
        'user.name=DynFlow',
        '-c',
        'user.email=dynflow@localhost',
        'commit',
        '-m',
        `dynflow: ${stepKey}`,
      ]);
      const resultCommit = await runGit(workspace.path, ['rev-parse', 'HEAD']);
      return { ...workspace, resultCommit, files };
    }

    return { ...workspace, files: await listFiles(workspace.path) };
  }

  async apply(
    mainWorkspacePath: string,
    workspace: FinalizedAgentWorkspace,
  ): Promise<ApplyWorkspaceResult> {
    if (workspace.kind === 'shared') {
      return { applied: true, files: [] };
    }

    if (workspace.kind === 'git-worktree') {
      if (!workspace.resultCommit) {
        return { applied: true, files: workspace.files };
      }
      try {
        await runGit(mainWorkspacePath, ['cherry-pick', workspace.resultCommit]);
        return {
          applied: true,
          commit: workspace.resultCommit,
          files: workspace.files,
        };
      } catch (error) {
        let conflicts: string[] = [];
        try {
          conflicts = (await runGit(mainWorkspacePath, [
            'diff',
            '--name-only',
            '--diff-filter=U',
          ]))
            .split(/\r?\n/)
            .filter(Boolean);
          await runGit(mainWorkspacePath, ['cherry-pick', '--abort']);
        } catch {
          // Preserve the original cherry-pick error.
        }
        throw new MergeConflictError(
          error instanceof Error ? error.message : String(error),
          conflicts,
        );
      }
    }

    let release!: () => void;
    const previous = this.nonGitWriteChain;
    this.nonGitWriteChain = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      for (const relative of workspace.files) {
        const source = path.resolve(workspace.path, relative);
        const destination = path.resolve(mainWorkspacePath, relative);
        if (!source.startsWith(path.resolve(workspace.path) + path.sep)) {
          throw new Error(`Unsafe workspace path: ${relative}`);
        }
        if (!destination.startsWith(path.resolve(mainWorkspacePath) + path.sep)) {
          throw new Error(`Unsafe destination path: ${relative}`);
        }
        await fs.mkdir(path.dirname(destination), { recursive: true });
        await fs.copyFile(source, destination);
      }
      return { applied: true, files: workspace.files };
    } finally {
      release();
    }
  }

  async cleanup(
    workspace: PreparedAgentWorkspace,
    repositoryPath?: string,
  ): Promise<void> {
    if (workspace.kind === 'shared') return;
    if (workspace.kind === 'git-worktree') {
      try {
        await runGit(repositoryPath ?? workspace.sourcePath ?? workspace.path, [
          'worktree',
          'remove',
          '--force',
          workspace.path,
        ]);
      } catch {
        await fs.rm(workspace.path, { recursive: true, force: true });
      }
      return;
    }
    await fs.rm(workspace.path, { recursive: true, force: true });
  }
}
