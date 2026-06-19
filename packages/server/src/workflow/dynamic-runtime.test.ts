import { describe, expect, it, vi } from 'vitest';
import type { AgentRunner } from '../runner/types.js';
import {
  DynamicWorkflowRuntime,
  type DurableStepRecord,
  type DurableStepStore,
} from './dynamic-runtime.js';

class MemoryStore implements DurableStepStore {
  steps = new Map<string, DurableStepRecord>();
  status: 'running' | 'paused' | 'stopped' = 'running';

  getStep(_runId: string, key: string) {
    return this.steps.get(key);
  }

  beginStep(input: Omit<DurableStepRecord, 'status' | 'attempt'>) {
    const previous = this.steps.get(input.stepKey);
    const step: DurableStepRecord = {
      ...input,
      status: 'running',
      attempt: (previous?.attempt ?? 0) + 1,
    };
    this.steps.set(input.stepKey, step);
    return step;
  }

  completeStep(_runId: string, key: string, output: unknown) {
    Object.assign(this.steps.get(key)!, { status: 'completed', output });
  }

  failStep(_runId: string, key: string, error: string) {
    Object.assign(this.steps.get(key)!, { status: 'failed', error });
  }

  getWorkflowStatus() {
    return this.status;
  }
}

function runner(): AgentRunner {
  return {
    run: vi.fn(async (config) => ({
      success: true,
      output: `result:${config.prompt}`,
      containerId: 'test',
    })),
    stop: vi.fn(async () => undefined),
    cleanup: vi.fn(async () => undefined),
  };
}

describe('dynamic workflow runtime', () => {
  it('replays completed steps without running the agent twice', async () => {
    const store = new MemoryStore();
    const agentRunner = runner();
    const runtime = new DynamicWorkflowRuntime(agentRunner, store, {
      emit: vi.fn(),
    });
    const options = {
      workflowRunId: 'run-1',
      script: `
        workflow("test", async () => {
          await agent("stable", { prompt: "hello", mode: "read" });
        });
      `,
      apiKey: 'key',
      workspacePath: process.cwd(),
    };

    await runtime.execute(options);
    await runtime.execute(options);

    expect(agentRunner.run).toHaveBeenCalledTimes(1);
    expect(store.steps.get('stable')?.status).toBe('completed');
  });

  it('rejects a changed input for an existing step key', async () => {
    const store = new MemoryStore();
    const runtime = new DynamicWorkflowRuntime(runner(), store, {
      emit: vi.fn(),
    });
    const base = {
      workflowRunId: 'run-1',
      apiKey: 'key',
      workspacePath: process.cwd(),
    };

    await runtime.execute({
      ...base,
      script: `workflow("test", async () => {
        await checkpoint("stable", "first");
      });`,
    });

    await expect(
      runtime.execute({
        ...base,
        script: `workflow("test", async () => {
          await checkpoint("stable", "second");
        });`,
      }),
    ).rejects.toThrow('NON_DETERMINISTIC_REPLAY');
  });
});
