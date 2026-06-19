import * as repo from '../db/repository.js';
import { createAgentRunner } from '../runner/index.js';
import { StreamManager } from '../sse/stream-manager.js';
import { logger } from '../logger.js';
import { DynamicWorkflowRuntime } from './dynamic-runtime.js';
import { RepositoryStepStore } from './repository-step-store.js';
import { prepareWorkflowWorkspace } from './workspace-preparer.js';
import { normalizeWorkflowScript } from './script-migration.js';
import { activeRuntimes } from './active-runtime-registry.js';

function resolveRecoveryApiKey(provider?: string): string | null {
  const keys: Record<string, string | undefined> = {
    opencode: process.env.OPENCODE_API_KEY,
    openai: process.env.OPENAI_API_KEY,
    anthropic: process.env.ANTHROPIC_API_KEY,
  };
  if (provider) return keys[provider] ?? null;
  return keys.opencode ?? keys.openai ?? keys.anthropic ?? null;
}

export function recoverDynamicWorkflows(): void {
  const runs = [];
  for (let page = 1; ; page++) {
    const batch = repo.listWorkflowRuns(page, 50, { status: 'recovering' });
    runs.push(...batch.runs);
    if (runs.length >= batch.total || batch.runs.length === 0) break;
  }
  for (const run of runs) {
    setImmediate(async () => {
      const stream = StreamManager.getInstance();
      stream.emit(run.id, {
        type: 'workflow_recovering',
        workflowId: run.id,
        timestamp: new Date().toISOString(),
        data: { recoveryCount: (run.recoveryCount ?? 0) + 1 },
      });
      try {
        if (!run.script) throw new Error('Dynamic workflow script is missing');
        const normalized = await normalizeWorkflowScript(run.script, run.name);
        if (!normalized.success) throw new Error(normalized.error);
        const apiKey = resolveRecoveryApiKey(run.runtimeConfig?.llmProvider);
        if (!apiKey) throw new Error('No API key available for recovery');
        repo.resetRunningWorkflowSteps(run.id);
        const controller = new AbortController();
        const runtime = new DynamicWorkflowRuntime(
          createAgentRunner(run.runtimeConfig),
          new RepositoryStepStore(),
          stream,
        );
        activeRuntimes.set(run.id, { abort: () => controller.abort() });
        await runtime.execute({
          workflowRunId: run.id,
          script: normalized.script,
          apiKey,
          workspacePath: await prepareWorkflowWorkspace(run),
          runtimeConfig: run.runtimeConfig,
          signal: controller.signal,
        });
        repo.updateWorkflowStatus(run.id, 'completed');
        stream.emit(run.id, {
          type: 'workflow_recovered',
          workflowId: run.id,
          timestamp: new Date().toISOString(),
        });
        stream.emit(run.id, {
          type: 'workflow_completed',
          workflowId: run.id,
          timestamp: new Date().toISOString(),
        });
      } catch (error) {
        const currentStatus = repo.getWorkflowRun(run.id)?.status;
        if (currentStatus === 'paused' || currentStatus === 'stopped') {
          return;
        }
        logger.error('Dynamic workflow recovery failed:', error);
        repo.updateWorkflowStatus(run.id, 'failed');
        stream.emit(run.id, {
          type: 'workflow_failed',
          workflowId: run.id,
          timestamp: new Date().toISOString(),
          data: { error: error instanceof Error ? error.message : String(error) },
        });
      } finally {
        activeRuntimes.delete(run.id);
      }
    });
  }
}
