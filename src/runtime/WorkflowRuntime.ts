import type { LLMProvider } from '../types/llm.js';
import type { WorkflowDefinition } from '../types/workflow.js';
import type { AgentResult } from '../types/agent.js';
import type { EventHandler, WorkflowSummary } from '../types/events.js';
import { EventEmitter } from '../events/EventEmitter.js';
import { TokenTracker } from '../token/TokenTracker.js';
import { AgentExecutor } from '../agent/AgentExecutor.js';
import { PhaseExecutor } from './PhaseExecutor.js';
import { WorkflowCache } from './Cache.js';
import { SessionManager } from './SessionManager.js';
import type { SessionState } from './SessionManager.js';

export interface RuntimeOptions {
  llm: LLMProvider;
  defaultModel: string;
  maxConcurrency?: number;
  cacheDir?: string;
  onEvent?: EventHandler;
}

export interface WorkflowResult {
  results: Map<string, Map<string, AgentResult>>;
  summary: WorkflowSummary;
  sessionId: string;
}

/**
 * The main workflow runtime. Orchestrates phases and agents.
 */
export class WorkflowRuntime {
  private eventEmitter: EventEmitter;
  private tokenTracker: TokenTracker;
  private options: Required<Pick<RuntimeOptions, 'defaultModel' | 'maxConcurrency'>> & RuntimeOptions;

  constructor(options: RuntimeOptions) {
    this.options = {
      ...options,
      defaultModel: options.defaultModel ?? 'gpt-4o',
      maxConcurrency: options.maxConcurrency ?? 16,
    };
    this.eventEmitter = new EventEmitter();
    this.tokenTracker = new TokenTracker();

    if (options.onEvent) {
      this.eventEmitter.on(options.onEvent);
    }
  }

  /**
   * Execute a workflow definition.
   */
  async run(definition: WorkflowDefinition): Promise<WorkflowResult> {
    const sessionId = definition.sessionId ?? crypto.randomUUID();
    const cache = new WorkflowCache(sessionId, { storageDir: this.options.cacheDir });
    const agentExecutor = new AgentExecutor({
      llm: this.options.llm,
      defaultModel: this.options.defaultModel,
    });
    const phaseExecutor = new PhaseExecutor(
      agentExecutor, cache, this.eventEmitter, this.tokenTracker
    );

    const maxConcurrency = definition.defaultConcurrency ?? this.options.maxConcurrency;
    const allResults = new Map<string, Map<string, AgentResult>>();
    const sessionVariables: Record<string, unknown> = {};
    const phaseTimings = new Map<string, number>();
    const workflowStart = Date.now();

    // Load persisted cache
    await cache.load();

    // Session manager for resume
    let sessionManager: SessionManager | undefined;
    let existingSession: SessionState | undefined;
    const completedPhasesSet = new Set<string>();

    if (this.options.cacheDir) {
      sessionManager = new SessionManager(this.options.cacheDir);
      existingSession = (await sessionManager.load(sessionId)) ?? undefined;
      if (existingSession) {
        for (const p of existingSession.completedPhases) {
          completedPhasesSet.add(p);
        }
        // Rebuild allResults from deserialized session results
        const deserialized = SessionManager.deserializeResults(existingSession.results);
        for (const [phaseName, phaseResults] of deserialized) {
          // Mark all results from previous run as cached
          for (const result of phaseResults.values()) {
            result.cached = true;
          }
          allResults.set(phaseName, phaseResults);
        }
        // Restore token tracker from resumed results
        for (const phaseResults of deserialized.values()) {
          for (const result of phaseResults.values()) {
            this.tokenTracker.record(result);
          }
        }
      }
    }

    this.eventEmitter.emit({
      type: 'workflow:start',
      workflowId: definition.name,
      sessionId,
      timestamp: workflowStart,
      phaseCount: definition.phases.length,
    });

    try {
      for (const phase of definition.phases) {
        // Skip already completed phases on resume
        if (completedPhasesSet.has(phase.name)) {
          phaseTimings.set(phase.name, 0);
          continue;
        }

        const ctx = AgentExecutor.createContext(definition.name, sessionId, allResults, sessionVariables);
        const phaseStart = Date.now();
        const phaseResults = await phaseExecutor.execute(phase, ctx, maxConcurrency);
        phaseTimings.set(phase.name, Date.now() - phaseStart);
        allResults.set(phase.name, phaseResults);

        // Save session state after each phase
        if (sessionManager) {
          const currentCompletedPhases = [];
          for (const p of definition.phases) {
            if (completedPhasesSet.has(p.name) || p.name === phase.name) {
              currentCompletedPhases.push(p.name);
            }
          }
          const sessionState: SessionState = {
            sessionId,
            workflowName: definition.name,
            createdAt: existingSession?.createdAt ?? Date.now(),
            updatedAt: Date.now(),
            completedPhases: currentCompletedPhases,
            results: SessionManager.serializeResults(allResults),
            tokenTracker: {
              perAgent: {},
              perPhase: {},
              total: this.tokenTracker.getTotal(),
            },
          };
          await sessionManager.save(sessionState);
        }
      }

      // Persist final cache
      await cache.save();

      const summary = this.buildSummary(allResults, workflowStart, phaseTimings);

      this.eventEmitter.emit({
        type: 'workflow:complete',
        workflowId: definition.name,
        sessionId,
        timestamp: Date.now(),
        summary,
      });

      return { results: allResults, summary, sessionId };
    } catch (error) {
      this.eventEmitter.emit({
        type: 'workflow:error',
        workflowId: definition.name,
        sessionId,
        timestamp: Date.now(),
        error: (error as Error).message,
      });
      throw error;
    }
  }

  /**
   * Subscribe to workflow events.
   */
  onEvent(handler: EventHandler): () => void {
    return this.eventEmitter.on(handler);
  }

  /**
   * Get event history.
   */
  getEventHistory() {
    return this.eventEmitter.getHistory();
  }

  /**
   * Get token usage summary.
   */
  getTokenUsage() {
    return this.tokenTracker.getTotal();
  }

  private buildSummary(
    allResults: Map<string, Map<string, AgentResult>>,
    workflowStart: number,
    phaseTimings: Map<string, number>
  ): WorkflowSummary {
    let completedAgents = 0;
    let failedAgents = 0;
    let cachedAgents = 0;
    const totalTokenUsage = { promptTokens: 0, completionTokens: 0, totalTokens: 0 };
    const phaseSummaries: WorkflowSummary['phases'] = [];

    for (const [phaseName, phaseResults] of allResults) {
      const phaseTokens = { promptTokens: 0, completionTokens: 0, totalTokens: 0 };
      let phaseErrors = 0;

      for (const result of phaseResults.values()) {
        if (result.status === 'success') completedAgents++;
        else if (result.status === 'error') failedAgents++;
        if (result.cached) cachedAgents++;

        phaseTokens.promptTokens += result.tokenUsage.promptTokens;
        phaseTokens.completionTokens += result.tokenUsage.completionTokens;
        phaseTokens.totalTokens += result.tokenUsage.totalTokens;

        if (result.status === 'error') phaseErrors++;
      }

      totalTokenUsage.promptTokens += phaseTokens.promptTokens;
      totalTokenUsage.completionTokens += phaseTokens.completionTokens;
      totalTokenUsage.totalTokens += phaseTokens.totalTokens;

      phaseSummaries.push({
        phaseName,
        durationMs: phaseTimings.get(phaseName) ?? 0,
        tokenUsage: phaseTokens,
        agentCount: phaseResults.size,
        errorCount: phaseErrors,
      });
    }

    return {
      totalDurationMs: Date.now() - workflowStart,
      totalAgents: completedAgents + failedAgents,
      completedAgents,
      failedAgents,
      cachedAgents,
      totalTokenUsage,
      phases: phaseSummaries,
    };
  }
}
