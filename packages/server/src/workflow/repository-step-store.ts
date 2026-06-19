import type { WorkflowStatus, WorkflowStep } from '@dynflow/shared';
import * as repo from '../db/repository.js';
import type {
  DurableStepRecord,
  DurableStepStore,
} from './dynamic-runtime.js';

function toRecord(step: WorkflowStep): DurableStepRecord {
  return {
    workflowRunId: step.workflowRunId,
    stepKey: step.key,
    parentKey: step.parentKey,
    kind:
      step.kind === 'phase_start' || step.kind === 'phase_complete'
        ? 'phase'
        : step.kind,
    sequence: step.sequence,
    status:
      step.status === 'skipped'
        ? 'cancelled'
        : step.status,
    inputHash: step.inputHash ?? '',
    input: step.input,
    output: step.output,
    attempt: step.attempt,
    error: step.error,
  };
}

export class RepositoryStepStore implements DurableStepStore {
  getStep(workflowRunId: string, stepKey: string): DurableStepRecord | undefined {
    const step = repo.getWorkflowStepByKey(workflowRunId, stepKey);
    return step ? toRecord(step) : undefined;
  }

  beginStep(input: {
    workflowRunId: string;
    stepKey: string;
    parentKey?: string;
    kind: DurableStepRecord['kind'];
    sequence: number;
    inputHash: string;
    input: unknown;
  }): DurableStepRecord {
    const existing = repo.getWorkflowStepByKey(
      input.workflowRunId,
      input.stepKey,
    );
    if (
      existing &&
      (existing.status === 'failed' || existing.status === 'cancelled')
    ) {
      repo.updateWorkflowStep(existing.id, {
        status: 'pending',
        error: null,
      });
    }

    const step = repo.beginWorkflowStep(input);
    if (!step) {
      const current = repo.getWorkflowStepByKey(
        input.workflowRunId,
        input.stepKey,
      );
      if (current) return toRecord(current);
      throw new Error(`Unable to claim workflow step "${input.stepKey}"`);
    }
    return toRecord(step);
  }

  completeStep(
    workflowRunId: string,
    stepKey: string,
    output: unknown,
    metadata?: Record<string, unknown>,
  ): void {
    const completed = repo.completeWorkflowStep(
      workflowRunId,
      stepKey,
      output,
      metadata,
    );
    if (!completed && repo.getWorkflowStepByKey(workflowRunId, stepKey)?.status !== 'completed') {
      throw new Error(`Unable to complete workflow step "${stepKey}"`);
    }
  }

  failStep(workflowRunId: string, stepKey: string, error: string): void {
    repo.failWorkflowStep(workflowRunId, stepKey, error);
  }

  getWorkflowStatus(workflowRunId: string): WorkflowStatus | undefined {
    return repo.getWorkflowRun(workflowRunId)?.status;
  }
}
