import { describe, it, expect } from 'vitest';
import {
  PhaseExecutor,
  ConcurrencyLimiter,
  type AgentResult,
} from './phase-executor.js';
import type { AgentRun, RuntimeConfig } from '@dynflow/shared';
import type { AgentRunner, AgentRunConfig } from '../runner/types.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createAgentRun(
  id: string,
  name?: string,
  overrides?: Partial<AgentRun>,
): AgentRun {
  return {
    id,
    name: name ?? id,
    status: 'pending',
    prompt: `prompt for ${name ?? id}`,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Mock AgentRunner – tracks concurrency & can simulate delays / failures
// ---------------------------------------------------------------------------

class ConcurrencyTrackingMock implements AgentRunner {
  /** Number of agents currently in run() */
  currentConcurrent = 0;
  /** Highest value currentConcurrent ever reached */
  maxConcurrentObserved = 0;
  /** Set of agent IDs that should throw on run() */
  failIds = new Set<string>();
  /** Set of agent IDs that simulate rate limit on first calls */
  rateLimitIds = new Map<string, number>();
  /** Set of agent IDs that return auth error */
  authErrorIds = new Set<string>();
  /** Artificial delay injected into each run() (ms) */
  delayMs = 30;

  async run(config: AgentRunConfig): Promise<import('../runner/types.js').AgentResult> {
    this.currentConcurrent++;
    this.maxConcurrentObserved = Math.max(
      this.maxConcurrentObserved,
      this.currentConcurrent,
    );

    await new Promise(resolve => setTimeout(resolve, this.delayMs));

    this.currentConcurrent--;

    if (this.failIds.has(config.agentId)) {
      throw new Error(`Simulated failure for ${config.agentId}`);
    }

    if (this.authErrorIds.has(config.agentId)) {
      return {
        success: false,
        error: '401 Unauthorized - Invalid API key',
        containerId: '',
        files: [],
        fileCount: 0,
        totalSize: 0,
        outputDir: '/app/output',
      };
    }

    // Rate limit simulation: fail on first N calls, succeed after
    const remaining = this.rateLimitIds.get(config.agentId) ?? 0;
    if (remaining > 0) {
      this.rateLimitIds.set(config.agentId, remaining - 1);
      return {
        success: false,
        error: '429 Too Many Requests - Rate limit exceeded',
        containerId: '',
        files: [],
        fileCount: 0,
        totalSize: 0,
        outputDir: '/app/output',
      };
    }

    return {
      success: true,
      output: `result for ${config.agentId}`,
      containerId: `ctr-${config.agentId}`,
      files: [],
      fileCount: 0,
      totalSize: 0,
      outputDir: '/app/output',
    };
  }

  async stop(): Promise<void> {
    // no-op
  }

  async cleanup(): Promise<void> {
    // no-op
  }
}

// ---------------------------------------------------------------------------
// PhaseExecutor tests
// ---------------------------------------------------------------------------

describe('PhaseExecutor', () => {
  describe('execute', () => {
    it('runs 5 agents with maxConcurrency=3 – at most 3 concurrent, all complete', async () => {
      const runner = new ConcurrencyTrackingMock();
      runner.delayMs = 50;
      const executor = new PhaseExecutor(runner);

      const agents = Array.from({ length: 5 }, (_, i) =>
        createAgentRun(`a${i}`, `Agent ${i}`),
      );
      const result = await executor.execute(agents, 'test-key', 3);

      expect(result.status).toBe('completed');
      expect(result.agentResults).toHaveLength(5);
      expect(result.agentResults.every(r => r.status === 'completed')).toBe(
        true,
      );
      // At most 3 ever ran concurrently
      expect(runner.maxConcurrentObserved).toBeLessThanOrEqual(3);
      // Should have observed at least some concurrency
      expect(runner.maxConcurrentObserved).toBeGreaterThanOrEqual(2);
    });

    it('agent failure does not block others – phase is completed_with_errors', async () => {
      const runner = new ConcurrencyTrackingMock();
      runner.failIds.add('a1');
      const executor = new PhaseExecutor(runner);

      const agents = Array.from({ length: 4 }, (_, i) =>
        createAgentRun(`a${i}`, `Agent ${i}`),
      );
      const result = await executor.execute(agents, 'test-key', 4);

      expect(result.status).toBe('completed_with_errors');
      expect(result.agentResults).toHaveLength(4);

      const succeeded = result.agentResults.filter(
        r => r.status === 'completed',
      );
      const failed = result.agentResults.filter(r => r.status === 'failed');
      expect(succeeded).toHaveLength(3);
      expect(failed).toHaveLength(1);
      expect(failed[0].agentId).toBe('a1');
      expect(failed[0].error).toContain('Simulated failure');
    });

    it('phase is completed when all agents succeed', async () => {
      const runner = new ConcurrencyTrackingMock();
      const executor = new PhaseExecutor(runner);

      const agents = Array.from({ length: 3 }, (_, i) =>
        createAgentRun(`a${i}`),
      );
      const result = await executor.execute(agents, 'test-key', 3);

      expect(result.status).toBe('completed');
      expect(result.agentResults).toHaveLength(3);
      expect(result.agentResults.every(r => r.status === 'completed')).toBe(
        true,
      );
    });

    it('cancel prevents new agents from starting', async () => {
      const runner = new ConcurrencyTrackingMock();
      runner.delayMs = 100; // long enough to observe mid-execution state
      const executor = new PhaseExecutor(runner);

      const agents = Array.from({ length: 10 }, (_, i) =>
        createAgentRun(`a${i}`, `Agent ${i}`),
      );
      const promise = executor.execute(agents, 'test-key', 3);

      // Give the first batch of agents time to start
      await new Promise(resolve => setTimeout(resolve, 30));

      // Record the max concurrency observed so far
      const maxAtCancel = runner.maxConcurrentObserved;

      // Cancel – future agents should not start
      executor.cancel();

      const result = await promise;

      // Some agents were cancelled
      const cancelled = result.agentResults.filter(
        r => r.status === 'cancelled',
      );
      expect(cancelled.length).toBeGreaterThan(0);

      // Each cancelled agent should have a basic result shape
      for (const c of cancelled) {
        expect(c.agentId).toBeTruthy();
        expect(c.name).toBeTruthy();
        expect(c.startedAt).toBeTruthy();
        expect(c.completedAt).toBeTruthy();
      }

      // At most 3 concurrent at any time
      expect(maxAtCancel).toBeLessThanOrEqual(3);
      // At least some concurrency was observed before cancel
      expect(maxAtCancel).toBeGreaterThanOrEqual(1);
    });

    it('0 agents returns empty results gracefully', async () => {
      const runner = new ConcurrencyTrackingMock();
      const executor = new PhaseExecutor(runner);

      const result = await executor.execute([], 'test-key', 3);

      expect(result.status).toBe('completed');
      expect(result.agentResults).toHaveLength(0);
    });

    it('maxConcurrency=1 runs agents sequentially', async () => {
      const runner = new ConcurrencyTrackingMock();
      runner.delayMs = 30;
      const executor = new PhaseExecutor(runner);

      const agents = Array.from({ length: 5 }, (_, i) =>
        createAgentRun(`a${i}`, `Agent ${i}`),
      );
      const result = await executor.execute(agents, 'test-key', 1);

      expect(result.status).toBe('completed');
      expect(result.agentResults).toHaveLength(5);
      // With maxConcurrency=1, only one agent should ever run at a time
      expect(runner.maxConcurrentObserved).toBe(1);
    });

    it('maxConcurrency > agent count runs all concurrently', async () => {
      const runner = new ConcurrencyTrackingMock();
      runner.delayMs = 30;
      const executor = new PhaseExecutor(runner);

      const agents = Array.from({ length: 3 }, (_, i) =>
        createAgentRun(`a${i}`, `Agent ${i}`),
      );
      const result = await executor.execute(agents, 'test-key', 10);

      expect(result.status).toBe('completed');
      expect(result.agentResults).toHaveLength(3);
      // All 3 should have run concurrently since the limit is 10
      expect(runner.maxConcurrentObserved).toBe(3);
    });

    it('agent results are preserved in input order', async () => {
      const runner = new ConcurrencyTrackingMock();
      runner.delayMs = 20;
      const executor = new PhaseExecutor(runner);

      const agents = [
        createAgentRun('first', 'Alpha'),
        createAgentRun('second', 'Beta'),
        createAgentRun('third', 'Gamma'),
      ];
      const result = await executor.execute(agents, 'test-key', 3);

      expect(result.agentResults).toHaveLength(3);
      expect(result.agentResults[0].agentId).toBe('first');
      expect(result.agentResults[1].agentId).toBe('second');
      expect(result.agentResults[2].agentId).toBe('third');
    });

    it('retries on rate limit (429) and eventually succeeds', async () => {
      const runner = new ConcurrencyTrackingMock();
      runner.delayMs = 1;
      runner.rateLimitIds.set('rate-limited-agent', 2); // fail twice, succeed 3rd time
      // Use tiny retry delay for fast tests
      const executor = new PhaseExecutor(runner, 1);

      const agents = [createAgentRun('rate-limited-agent', 'Rate Limited Agent')];
      const result = await executor.execute(agents, 'test-key', 1);

      expect(result.agentResults).toHaveLength(1);
      expect(result.agentResults[0].status).toBe('completed');
      expect(result.agentResults[0].output).toBe('result for rate-limited-agent');
    });

    it('fails immediately on auth error (401) without retry', async () => {
      const runner = new ConcurrencyTrackingMock();
      runner.delayMs = 1;
      runner.authErrorIds.add('auth-fail-agent');
      const executor = new PhaseExecutor(runner);

      const agents = [createAgentRun('auth-fail-agent', 'Auth Fail')];
      const result = await executor.execute(agents, 'test-key', 1);

      expect(result.agentResults).toHaveLength(1);
      expect(result.agentResults[0].status).toBe('failed');
      expect(result.agentResults[0].error).toContain('401');
      expect(result.agentResults[0].error).toContain('Invalid API key');
    });

    it('marks agent as failed after exhausting retries on persistent rate limit', async () => {
      const runner = new ConcurrencyTrackingMock();
      runner.delayMs = 1;
      runner.rateLimitIds.set('persistent-rate-limit', 10); // will always rate-limit
      const executor = new PhaseExecutor(runner, 1);

      const agents = [
        createAgentRun('persistent-rate-limit', 'Persistent Rate Limit'),
      ];
      const result = await executor.execute(agents, 'test-key', 1);

      expect(result.agentResults).toHaveLength(1);
      expect(result.agentResults[0].status).toBe('failed');
      expect(result.agentResults[0].error).toContain('429');
    });
  });
});

// ---------------------------------------------------------------------------
// ConcurrencyLimiter unit tests
// ---------------------------------------------------------------------------

describe('ConcurrencyLimiter', () => {
  it('limits concurrent execution to the configured max', async () => {
    const limiter = new ConcurrencyLimiter(2);
    let concurrent = 0;
    let maxConcurrent = 0;

    const tasks = Array.from({ length: 6 }, () =>
      limiter.run(async () => {
        concurrent++;
        maxConcurrent = Math.max(maxConcurrent, concurrent);
        await new Promise(resolve => setTimeout(resolve, 50));
        concurrent--;
      }),
    );

    await Promise.all(tasks);
    expect(maxConcurrent).toBeLessThanOrEqual(2);
  });

  it('executes all enqueued tasks', async () => {
    const limiter = new ConcurrencyLimiter(3);
    let count = 0;

    const tasks = Array.from({ length: 10 }, () =>
      limiter.run(async () => {
        await new Promise(resolve => setTimeout(resolve, 10));
        count++;
      }),
    );

    await Promise.all(tasks);
    expect(count).toBe(10);
  });
});

// ---------------------------------------------------------------------------
// PhaseExecutor with runtimeConfig
// ---------------------------------------------------------------------------

describe('PhaseExecutor with runtimeConfig', () => {
  it('uses runtimeConfig.model when agent.model is unset', async () => {
    const mockRunner = {
      run: async (config: AgentRunConfig) => {
        // Capture state on mock for assertions
        mockRunner.lastConfig = config;
        return { success: true, containerId: 'c1', output: 'done', files: [], fileCount: 0, totalSize: 0, outputDir: '/app/output' };
      },
      stop: async () => {},
      cleanup: async () => {},
      lastConfig: undefined as AgentRunConfig | undefined,
    };
    const executor = new PhaseExecutor(mockRunner as unknown as AgentRunner, 2000, { model: 'claude-sonnet' } as RuntimeConfig);

    const agents = [createAgentRun('a1', 'test', { prompt: 'do it' })];
    await executor.execute(agents, 'key', 16, '');

    expect(mockRunner.lastConfig?.model).toBe('claude-sonnet');
  });

  it('agent.model wins over runtimeConfig.model', async () => {
    const mockRunner = {
      run: async (config: AgentRunConfig) => {
        mockRunner.lastConfig = config;
        return { success: true, containerId: 'c1', output: 'done', files: [], fileCount: 0, totalSize: 0, outputDir: '/app/output' };
      },
      stop: async () => {},
      cleanup: async () => {},
      lastConfig: undefined as AgentRunConfig | undefined,
    };
    const executor = new PhaseExecutor(mockRunner as unknown as AgentRunner, 2000, { model: 'claude-sonnet' } as RuntimeConfig);

    const agents = [createAgentRun('a1', 'test', { prompt: 'do it', model: 'gpt-4o' })];
    await executor.execute(agents, 'key', 16, '');

    expect(mockRunner.lastConfig?.model).toBe('gpt-4o');
  });

  it('falls back to gpt-4o when neither agent.model nor runtimeConfig.model is set', async () => {
    const mockRunner = {
      run: async (config: AgentRunConfig) => {
        mockRunner.lastConfig = config;
        return { success: true, containerId: 'c1', output: 'done', files: [], fileCount: 0, totalSize: 0, outputDir: '/app/output' };
      },
      stop: async () => {},
      cleanup: async () => {},
      lastConfig: undefined as AgentRunConfig | undefined,
    };
    const executor = new PhaseExecutor(mockRunner as unknown as AgentRunner);

    const agents = [createAgentRun('a1', 'test', { prompt: 'do it' })];
    await executor.execute(agents, 'key', 16, '');

    expect(mockRunner.lastConfig?.model).toBe('gpt-4o');
  });

  it('threads llmProvider to AgentRunConfig', async () => {
    const mockRunner = {
      run: async (config: AgentRunConfig) => {
        mockRunner.lastConfig = config;
        return { success: true, containerId: 'c1', output: 'done', files: [], fileCount: 0, totalSize: 0, outputDir: '/app/output' };
      },
      stop: async () => {},
      cleanup: async () => {},
      lastConfig: undefined as AgentRunConfig | undefined,
    };
    const executor = new PhaseExecutor(mockRunner as unknown as AgentRunner, 2000, { llmProvider: 'anthropic' } as RuntimeConfig);

    const agents = [createAgentRun('a1', 'test', { prompt: 'do it' })];
    await executor.execute(agents, 'key', 16, '');

    expect(mockRunner.lastConfig?.llmProvider).toBe('anthropic');
    expect(mockRunner.lastConfig?.provider).toBe('anthropic');
  });

  it('llmProvider is undefined when unset', async () => {
    const mockRunner = {
      run: async (config: AgentRunConfig) => {
        mockRunner.lastConfig = config;
        return { success: true, containerId: 'c1', output: 'done', files: [], fileCount: 0, totalSize: 0, outputDir: '/app/output' };
      },
      stop: async () => {},
      cleanup: async () => {},
      lastConfig: undefined as AgentRunConfig | undefined,
    };
    const executor = new PhaseExecutor(mockRunner as unknown as AgentRunner);

    const agents = [createAgentRun('a1', 'test', { prompt: 'do it' })];
    await executor.execute(agents, 'key', 16, '');

    expect(mockRunner.lastConfig?.llmProvider).toBeUndefined();
  });
});
