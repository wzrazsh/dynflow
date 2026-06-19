import type { WorkflowRun } from '@dynflow/shared';

export interface DynamicWorkflowStep {
  id: string;
  key?: string;
  stepKey?: string;
  name?: string;
  kind: string;
  status: string;
  attempt?: number;
  replayed?: boolean;
  parentKey?: string;
  parentStepId?: string;
  parentId?: string;
  parentStepKey?: string;
  worktree?: unknown;
  workspacePath?: string;
  resultCommit?: string;
  metadata?: Record<string, unknown>;
  error?: unknown;
  output?: unknown;
  children?: DynamicWorkflowStep[];
}

export type WorkflowRunWithDynamicSteps = Omit<WorkflowRun, 'steps'> & {
  executionModel?: string;
  steps?: DynamicWorkflowStep[];
};
