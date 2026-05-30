import type { LLMProvider } from '../types/llm.js';
import type { TaskDefinition, WorkflowContext } from '../types/workflow.js';
import type { AgentResult } from '../types/agent.js';

export interface AgentExecutorOptions {
  llm: LLMProvider;
  defaultModel: string;
}

/**
 * Executes a single agent task. Stateless — all state management is the runtime's job.
 */
export class AgentExecutor {
  private llm: LLMProvider;
  private defaultModel: string;

  constructor(options: AgentExecutorOptions) {
    this.llm = options.llm;
    this.defaultModel = options.defaultModel;
  }

  /**
   * Execute a single task and return the result.
   */
  async execute(
    task: TaskDefinition,
    phaseName: string,
    ctx: WorkflowContext,
    signal?: AbortSignal
  ): Promise<AgentResult> {
    const startedAt = Date.now();

    // Resolve task string (static or dynamic)
    const resolvedTask = typeof task.task === 'function'
      ? await task.task(ctx)
      : task.task;

    const response = await this.llm.complete({
      systemPrompt: task.systemPrompt,
      messages: [{ role: 'user', content: resolvedTask }],
      model: task.model ?? this.defaultModel,
      temperature: task.temperature,
      maxTokens: task.maxTokens,
      signal,
    });

    const completedAt = Date.now();

    return {
      id: task.id,
      phaseName,
      content: response.content,
      tokenUsage: response.tokenUsage,
      durationMs: completedAt - startedAt,
      status: 'success',
      cached: false,
      model: response.model,
      startedAt,
      completedAt,
    };
  }

  /**
   * Create a WorkflowContext from accumulated results.
   */
  static createContext(
    workflowName: string,
    sessionId: string,
    allResults: Map<string, Map<string, AgentResult>>,
    variables?: Record<string, unknown>
  ): WorkflowContext {
    return {
      workflowName,
      sessionId,
      variables: variables ?? {},
      get(phaseName: string, agentId: string): AgentResult | undefined {
        return allResults.get(phaseName)?.get(agentId);
      },
    };
  }
}
