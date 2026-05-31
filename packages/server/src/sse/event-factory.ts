import type { SSEEvent } from '@dynflow/shared';

function ts(): string {
  return new Date().toISOString();
}

export function createWorkflowStartedEvent(workflowId: string): SSEEvent {
  return { type: 'workflow_started', workflowId, timestamp: ts() };
}

export function createWorkflowPausedEvent(workflowId: string): SSEEvent {
  return { type: 'workflow_paused', workflowId, timestamp: ts() };
}

export function createWorkflowResumedEvent(workflowId: string): SSEEvent {
  return { type: 'workflow_resumed', workflowId, timestamp: ts() };
}

export function createWorkflowCompletedEvent(workflowId: string): SSEEvent {
  return { type: 'workflow_completed', workflowId, timestamp: ts() };
}

export function createWorkflowFailedEvent(
  workflowId: string,
  error: string,
): SSEEvent {
  return {
    type: 'workflow_failed',
    workflowId,
    data: { error },
    timestamp: ts(),
  };
}

export function createWorkflowStoppedEvent(workflowId: string): SSEEvent {
  return { type: 'workflow_stopped', workflowId, timestamp: ts() };
}

export function createPhaseStartedEvent(
  workflowId: string,
  phaseId: string,
  phaseName: string,
): SSEEvent {
  return {
    type: 'phase_started',
    workflowId,
    phaseId,
    data: { phaseName },
    timestamp: ts(),
  };
}

export function createPhaseCompletedEvent(
  workflowId: string,
  phaseId: string,
  phaseName: string,
  status: string,
): SSEEvent {
  return {
    type: 'phase_completed',
    workflowId,
    phaseId,
    status,
    data: { phaseName },
    timestamp: ts(),
  };
}

export function createAgentStartedEvent(
  workflowId: string,
  phaseId: string,
  agentId: string,
  agentName: string,
): SSEEvent {
  return {
    type: 'agent_started',
    workflowId,
    phaseId,
    agentId,
    data: { agentName },
    timestamp: ts(),
  };
}

export function createAgentCompletedEvent(
  workflowId: string,
  phaseId: string,
  agentId: string,
  agentName: string,
  output: string,
): SSEEvent {
  return {
    type: 'agent_completed',
    workflowId,
    phaseId,
    agentId,
    data: { agentName, output },
    timestamp: ts(),
  };
}

export function createAgentFailedEvent(
  workflowId: string,
  phaseId: string,
  agentId: string,
  agentName: string,
  error: string,
): SSEEvent {
  return {
    type: 'agent_failed',
    workflowId,
    phaseId,
    agentId,
    data: { agentName, error },
    timestamp: ts(),
  };
}

export function createAgentTimeoutEvent(
  workflowId: string,
  phaseId: string,
  agentId: string,
  agentName: string,
): SSEEvent {
  return {
    type: 'agent_timeout',
    workflowId,
    phaseId,
    agentId,
    data: { agentName },
    timestamp: ts(),
  };
}
