import { execFile } from 'node:child_process';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { promisify } from 'node:util';
import type { WorkflowRun } from '@dynflow/shared';

const execFileAsync = promisify(execFile);

export async function prepareWorkflowWorkspace(
  run: WorkflowRun,
): Promise<string> {
  if (run.workspacePath) {
    const resolved = path.resolve(run.workspacePath);
    await fs.mkdir(resolved, { recursive: true });
    return resolved;
  }

  const target = path.resolve('outputs', 'workflows', run.id, 'workspace');
  if (!run.workspaceGitUrl) {
    await fs.mkdir(target, { recursive: true });
    return target;
  }

  try {
    await fs.access(path.join(target, '.git'));
    return target;
  } catch {
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.rm(target, { recursive: true, force: true });
    const args = ['clone'];
    if (run.workspaceBranch) {
      args.push('--branch', run.workspaceBranch);
    }
    args.push(run.workspaceGitUrl, target);
    await execFileAsync('git', args, {
      windowsHide: true,
      maxBuffer: 10 * 1024 * 1024,
    });
    return target;
  }
}
