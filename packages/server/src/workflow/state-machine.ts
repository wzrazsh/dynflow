import type { WorkflowStatus } from '@dynflow/shared';

export type WorkflowAction = 'start' | 'pause' | 'resume' | 'complete' | 'fail' | 'stop' | 'interrupt';

export interface TransitionResult {
  allowed: boolean;
  next?: WorkflowStatus;
  error?: string;
}

// Allowed transitions: [current, action] -> next
const TRANSITIONS: Record<WorkflowStatus, Partial<Record<WorkflowAction, WorkflowStatus>>> = {
  pending: {
    start: 'running',
  },
  running: {
    pause: 'paused',
    complete: 'completed',
    fail: 'failed',
    stop: 'stopped',
    interrupt: 'interrupted',
  },
  paused: {
    resume: 'running',
    stop: 'stopped',
  },
  completed: {},
  failed: {},
  stopped: {},
  interrupted: {},
};

export class WorkflowFSM {
  static transition(current: WorkflowStatus, action: WorkflowAction): TransitionResult {
    const next = TRANSITIONS[current]?.[action];
    if (next) {
      return { allowed: true, next };
    }
    return {
      allowed: false,
      error: `Cannot '${action}' a workflow with status '${current}'`,
    };
  }

  static canTransition(current: WorkflowStatus, action: WorkflowAction): boolean {
    return this.transition(current, action).allowed;
  }
}
