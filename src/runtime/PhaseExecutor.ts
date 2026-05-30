import type { PhaseDefinition, WorkflowContext } from '../types/workflow.js';
import type { AgentResult, TokenUsage } from '../types/agent.js';
import type { EventEmitter } from '../events/EventEmitter.js';
import type { TokenTracker } from '../token/TokenTracker.js';
import type { AgentExecutor } from '../agent/AgentExecutor.js';
import { ConcurrencyLimiter } from './ConcurrencyLimiter.js';
import type { WorkflowCache } from './Cache.js';

/**
 * Executes a single phase with parallel agents and concurrency control.
 */
export class PhaseExecutor {
  constructor(
    private agentExecutor: AgentExecutor,
    private cache: WorkflowCache,
    private eventEmitter: EventEmitter,
    private tokenTracker: TokenTracker,
  ) {}

  /**
   * Execute all tasks in a phase with concurrency limit.
   */
  async execute(
    phase: PhaseDefinition,
    ctx: WorkflowContext,
    defaultConcurrency: number,
  ): Promise<Map<string, AgentResult>> {
    const concurrency = phase.concurrency ?? defaultConcurrency;
    const limiter = new ConcurrencyLimiter(concurrency);
    const results = new Map<string, AgentResult>();
    const phaseStart = Date.now();
    let errorCount = 0;

    // Emit phase start
    this.eventEmitter.emit({
      type: 'phase:start',
      phaseName: phase.name,
      timestamp: phaseStart,
      taskCount: phase.tasks.length,
    });

    // Run all tasks with concurrency limit
    const taskPromises = phase.tasks.map(task =>
      limiter.run(async () => {
        // Check cache first
        const cached = this.cache.get(phase.name, task.id);
        if (cached) {
          this.eventEmitter.emit({
            type: 'agent:complete',
            agentId: task.id,
            phaseName: phase.name,
            result: { ...cached, cached: true },
            timestamp: Date.now(),
          });
          return { ...cached, cached: true };
        }

        // If task has a skillName, load and inject the skill into systemPrompt
        let effectiveTask = task;
        if (task.skillName) {
          const { loadSkillForPrompt } = await import('../gstack/skill-loader.js');
          const skillPrompt = await loadSkillForPrompt({
            skillName: task.skillName,
            fallbackPrompt: task.fallbackPrompt ?? task.systemPrompt,
          });
          effectiveTask = {
            ...task,
            systemPrompt: skillPrompt,
          };
        }

        this.eventEmitter.emit({
          type: 'agent:start',
          agentId: effectiveTask.id,
          phaseName: phase.name,
          timestamp: Date.now(),
          model: effectiveTask.model ?? 'default',
        });

        try {
          const result = await this.agentExecutor.execute(effectiveTask, phase.name, ctx);

          // Cache successful results only
          if (result.status === 'success') {
            this.cache.set(phase.name, task.id, result);
          }
          this.tokenTracker.record(result);

          this.eventEmitter.emit({
            type: 'agent:complete',
            agentId: task.id,
            phaseName: phase.name,
            result,
            timestamp: Date.now(),
          });

          return result;
        } catch (error) {
          errorCount++;
          const errorResult: AgentResult = {
            id: effectiveTask.id,
            phaseName: phase.name,
            content: '',
            tokenUsage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
            durationMs: 0,
            status: 'error',
            error: (error as Error).message,
            cached: false,
            model: effectiveTask.model ?? 'default',
            startedAt: Date.now(),
            completedAt: Date.now(),
          };

          this.eventEmitter.emit({
            type: 'agent:complete',
            agentId: task.id,
            phaseName: phase.name,
            result: errorResult,
            timestamp: Date.now(),
          });

          return errorResult;
        }
      })
    );

    const agentResults = await Promise.allSettled(taskPromises);

    // Collect results
    for (const [i, settled] of agentResults.entries()) {
      const task = phase.tasks[i];
      if (settled.status === 'fulfilled') {
        results.set(task.id, settled.value);
      } else {
        errorCount++;
        results.set(task.id, {
          id: task.id,
          phaseName: phase.name,
          content: '',
          tokenUsage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
          durationMs: 0,
          status: 'error',
          error: settled.reason?.message ?? 'Unknown error',
          cached: false,
          model: task.model ?? 'default',
          startedAt: 0,
          completedAt: 0,
        });
      }
    }

    // Emit phase complete
    const phaseTokenUsage = this.sumTokenUsage(results);
    this.eventEmitter.emit({
      type: 'phase:complete',
      phaseName: phase.name,
      timestamp: Date.now(),
      tokenUsage: phaseTokenUsage,
      durationMs: Date.now() - phaseStart,
      agentCount: results.size,
      errorCount,
    });

    return results;
  }

  private sumTokenUsage(results: Map<string, AgentResult>): TokenUsage {
    let pt = 0, ct = 0;
    for (const r of results.values()) {
      pt += r.tokenUsage.promptTokens;
      ct += r.tokenUsage.completionTokens;
    }
    return { promptTokens: pt, completionTokens: ct, totalTokens: pt + ct };
  }
}
