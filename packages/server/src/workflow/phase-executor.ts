import type { AgentRun } from '@dynflow/shared';
import type { AgentRunner, AgentRunConfig } from '../runner/types.js';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface AgentResult {
  agentId: string;
  name: string;
  status: 'completed' | 'failed' | 'timeout' | 'cancelled';
  output?: string;
  error?: string;
  startedAt: string;
  completedAt: string;
  files?: string[];
  fileCount?: number;
  totalSize?: number;
  outputDir?: string;
  noVncUrl?: string;
  cuaApiUrl?: string;
}

export type PhaseStatus = 'completed' | 'completed_with_errors';

export interface PhaseResult {
  status: PhaseStatus;
  agentResults: AgentResult[];
}

// ---------------------------------------------------------------------------
// ConcurrencyLimiter – a lightweight semaphore (≈30 lines)
// ---------------------------------------------------------------------------

export class ConcurrencyLimiter {
  private running = 0;
  private queue: Array<() => void> = [];

  constructor(private max: number) {}

  async run<T>(fn: () => Promise<T>): Promise<T> {
    while (this.running >= this.max) {
      await new Promise<void>(resolve => this.queue.push(resolve));
    }
    this.running++;
    try {
      return await fn();
    } finally {
      this.running--;
      const next = this.queue.shift();
      if (next) next();
    }
  }

  get currentRunning(): number {
    return this.running;
  }
}

// ---------------------------------------------------------------------------
// PhaseExecutor
// ---------------------------------------------------------------------------

export class PhaseExecutor {
  private cancelled = false;

  /**
   * @param runner           – the AgentRunner to delegate agent execution to
   * @param retryBaseDelayMs – base delay (ms) before the first retry on transient errors
   *                           (default 2000). Exposed for testability.
   */
  constructor(
    private runner: AgentRunner,
    private retryBaseDelayMs: number = 2000,
  ) {}

  /**
   * Execute all agents with the given concurrency limit.
   *
   * - Each agent is converted to an AgentRunConfig and passed to the runner.
   * - Errors are isolated: a single agent failure does not stop others.
   * - The phase status is `completed` only when every agent succeeds.
   *
   * @param agents        – the agents to run (from shared types)
   * @param apiKey        – OpenAI API key forwarded to the runner
   * @param maxConcurrency– maximum number of agents running simultaneously (default 16)
   */
  async execute(
    agents: AgentRun[],
    apiKey: string,
    maxConcurrency: number = 16,
    outputDir?: string,
  ): Promise<PhaseResult> {
    this.cancelled = false;

    if (agents.length === 0) {
      return { status: 'completed', agentResults: [] };
    }

    const limiter = new ConcurrencyLimiter(maxConcurrency);

    // Create one task per agent. All tasks are submitted immediately; the
    // limiter controls how many run concurrently.
    const tasks = agents.map(agent =>
      limiter.run(async () => {
        if (this.cancelled) {
          return cancelledResult(agent);
        }
        return this.runAgent(agent, apiKey, outputDir);
      }),
    );

    const settled = await Promise.allSettled(tasks);
    const agentResults: AgentResult[] = [];
    let hasError = false;

    for (const s of settled) {
      if (s.status === 'fulfilled') {
        agentResults.push(s.value);
        if (s.value.status !== 'completed') {
          hasError = true;
        }
      } else {
        // This branch should never fire because the callbacks catch everything,
        // but we guard against it for completeness.
        hasError = true;
        agentResults.push({
          agentId: 'unknown',
          name: 'unknown',
          status: 'failed',
          error:
            s.reason instanceof Error ? s.reason.message : String(s.reason),
          startedAt: new Date().toISOString(),
          completedAt: new Date().toISOString(),
        });
      }
    }

    return {
      status: hasError ? 'completed_with_errors' : 'completed',
      agentResults,
    };
  }

  /**
   * Cancel all **future** agents. Already-running agents finish normally.
   * Agents that have not yet started will receive a `cancelled` status.
   */
  cancel(): void {
    this.cancelled = true;
  }

  // -----------------------------------------------------------------------
  // Private helpers
  // -----------------------------------------------------------------------

  private async runAgent(agent: AgentRun, apiKey: string, workspacePath?: string): Promise<AgentResult> {
    const startedAt = new Date().toISOString();
    const maxRetries = 3;

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      try {
        const config: AgentRunConfig = {
          agentId: agent.id,
          prompt: agent.prompt,
          model: agent.model ?? 'gpt-4o',
          timeoutMs: agent.timeoutMs ?? 300_000,
          openaiApiKey: apiKey,
          workspacePath: workspacePath ?? '',
          workspaceMount: '/app/output',
        };
        const result = await this.runner.run(config);
        const completedAt = new Date().toISOString();

        // If the agent succeeded, return immediately
        if (result.success) {
          return {
            agentId: agent.id,
            name: agent.name,
            status: 'completed',
            output: result.output,
            error: result.error,
            startedAt,
            completedAt,
            files: result.files,
            fileCount: result.fileCount,
            totalSize: result.totalSize,
            outputDir: result.outputDir,
            noVncUrl: result.noVncUrl,
            cuaApiUrl: result.cuaApiUrl,
          };
        }

        // Agent returned a failure — check if it's a retryable OpenAI error
        const errMsg = result.error || '';
        const isRateLimit = errMsg.includes('429') || /rate.limit/i.test(errMsg);
        const isAuthError = errMsg.includes('401') || /(unauthorized|invalid.api.key)/i.test(errMsg);

        // Auth errors are NOT retryable
        if (isAuthError) {
          return {
            agentId: agent.id,
            name: agent.name,
            status: 'failed',
            error: result.error,
            startedAt,
            completedAt,
          };
        }

        // Rate-limit or other transient errors: retry with exponential backoff
        if (isRateLimit && attempt < maxRetries) {
          const delay = this.retryBaseDelayMs * Math.pow(2, attempt) + Math.random() * 1000;
          await new Promise((resolve) => setTimeout(resolve, delay));
          continue; // Retry
        }

        // Non-retryable failure
        return {
          agentId: agent.id,
          name: agent.name,
          status: 'failed',
          error: result.error,
          startedAt,
          completedAt,
        };
      } catch (err) {
        const isTimeout = err instanceof Error && (
          err.message.includes('timed out') ||
          err.message.includes('ETIMEDOUT') ||
          (err as NodeJS.ErrnoException).code === 'ETIMEDOUT'
        );

        // Retry on timeout but not on the last attempt
        if (isTimeout && attempt < maxRetries) {
          const delay = this.retryBaseDelayMs * Math.pow(2, attempt) + Math.random() * 1000;
          await new Promise((resolve) => setTimeout(resolve, delay));
          continue;
        }

        const completedAt = new Date().toISOString();
        return {
          agentId: agent.id,
          name: agent.name,
          status: 'failed',
          error: err instanceof Error ? err.message : String(err),
          startedAt,
          completedAt,
        };
      }
    }

    // Should never reach here, but TypeScript needs a return
    const completedAt = new Date().toISOString();
    return {
      agentId: agent.id,
      name: agent.name,
      status: 'failed',
      error: 'Max retries exceeded',
      startedAt,
      completedAt,
    };
  }
}

function cancelledResult(agent: AgentRun): AgentResult {
  const now = new Date().toISOString();
  return {
    agentId: agent.id,
    name: agent.name,
    status: 'cancelled',
    startedAt: now,
    completedAt: now,
  };
}
