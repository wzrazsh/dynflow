import type { AgentResult, TokenUsage } from './agent.js';

/**
 * Union type of all workflow events.
 */
export type WorkflowEvent =
  | WorkflowStartEvent
  | WorkflowCompleteEvent
  | WorkflowErrorEvent
  | PhaseStartEvent
  | PhaseCompleteEvent
  | AgentStartEvent
  | AgentCompleteEvent;

export interface WorkflowStartEvent {
  type: 'workflow:start';
  workflowId: string;
  sessionId: string;
  timestamp: number;
  phaseCount: number;
}

export interface WorkflowCompleteEvent {
  type: 'workflow:complete';
  workflowId: string;
  sessionId: string;
  timestamp: number;
  summary: WorkflowSummary;
}

export interface WorkflowErrorEvent {
  type: 'workflow:error';
  workflowId: string;
  sessionId: string;
  timestamp: number;
  error: string;
  phaseName?: string;
  agentId?: string;
}

export interface PhaseStartEvent {
  type: 'phase:start';
  phaseName: string;
  timestamp: number;
  taskCount: number;
}

export interface PhaseCompleteEvent {
  type: 'phase:complete';
  phaseName: string;
  timestamp: number;
  tokenUsage: TokenUsage;
  durationMs: number;
  agentCount: number;
  errorCount: number;
}

export interface AgentStartEvent {
  type: 'agent:start';
  agentId: string;
  phaseName: string;
  timestamp: number;
  model: string;
}

export interface AgentCompleteEvent {
  type: 'agent:complete';
  agentId: string;
  phaseName: string;
  result: AgentResult;
  timestamp: number;
}

/**
 * Summary of a completed workflow run.
 */
export interface WorkflowSummary {
  totalDurationMs: number;
  totalAgents: number;
  completedAgents: number;
  failedAgents: number;
  cachedAgents: number;
  totalTokenUsage: TokenUsage;
  phases: Array<{
    phaseName: string;
    durationMs: number;
    tokenUsage: TokenUsage;
    agentCount: number;
    errorCount: number;
  }>;
}

/**
 * Handler function for workflow events.
 */
export type EventHandler = (event: WorkflowEvent) => void | Promise<void>;
