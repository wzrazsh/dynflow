import type { AgentResult } from './agent.js';

/**
 * A workflow is a collection of phases executed sequentially.
 */
export interface WorkflowDefinition {
  name: string;
  phases: PhaseDefinition[];
  defaultConcurrency?: number;
  sessionId?: string;
}

/**
 * A phase contains tasks that run in parallel (within concurrency limits).
 */
export interface PhaseDefinition {
  name: string;
  tasks: TaskDefinition[];
  concurrency?: number;
}

/**
 * A single task to be executed by an agent.
 */
export interface TaskDefinition {
  id: string;
  systemPrompt: string;
  task: string | TaskResolver;
  model?: string;
  temperature?: number;
  maxTokens?: number;
}

/**
 * Function that resolves a task string dynamically based on workflow context.
 */
export type TaskResolver = (ctx: WorkflowContext) => string | Promise<string>;

/**
 * Context available to task resolvers, containing results from previous phases.
 */
export interface WorkflowContext {
  workflowName: string;
  sessionId: string;
  variables: Record<string, unknown>;
  get(phaseName: string, agentId: string): AgentResult | undefined;
}
