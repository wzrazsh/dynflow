import { describe, it, expect } from 'vitest';
import type {
  DynamicWorkflowStatus,
  SSEEvent,
  WorkflowDefinition,
  WorkflowStep,
} from './types.js';

describe('WorkspaceConfig', () => {
  it('can be attached to WorkflowDefinition', () => {
    const def: WorkflowDefinition = {
      name: 'test',
      workspace: { git: 'https://github.com/foo/bar', branch: 'main' },
      phases: [],
    };
    expect(def.workspace?.git).toBe('https://github.com/foo/bar');
    expect(def.workspace?.branch).toBe('main');
  });

  it('is optional', () => {
    const def: WorkflowDefinition = { name: 'test', phases: [] };
    expect(def.workspace).toBeUndefined();
  });
});

describe('dynamic workflow types', () => {
  it('models durable workflow steps and events', () => {
    const status: DynamicWorkflowStatus = 'recovering';
    const step: WorkflowStep = {
      id: 'step-1',
      workflowRunId: 'run-1',
      key: 'compile',
      stepKey: 'compile',
      type: 'agent',
      kind: 'agent',
      sequence: 0,
      status: 'running',
      attempt: 1,
      createdAt: '2026-06-08T00:00:00.000Z',
      updatedAt: '2026-06-08T00:00:01.000Z',
    };
    const event: SSEEvent = {
      type: 'step_started',
      workflowId: step.workflowRunId,
      stepId: step.id,
      timestamp: step.updatedAt,
    };

    expect(status).toBe('recovering');
    expect(event.type).toBe('step_started');
  });
});
