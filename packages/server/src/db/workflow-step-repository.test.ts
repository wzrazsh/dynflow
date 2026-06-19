import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import type { WorkflowDefinition } from '@dynflow/shared';
import { closeDb } from './connection.js';
import * as repo from './repository.js';
import { initSchema } from './schema.js';

const definition: WorkflowDefinition = {
  name: 'dynamic-test',
  phases: [],
};

describe('workflow step repository', () => {
  beforeEach(() => {
    closeDb();
    process.env.DB_PATH = ':memory:';
    initSchema();
  });

  afterAll(() => {
    closeDb();
    delete process.env.DB_PATH;
  });

  it('creates, reads, lists, updates, and deletes steps', () => {
    const run = repo.createWorkflowRun(definition, 'Dynamic', {
      executionModel: 'dynamic',
      scriptHash: 'sha256:test',
    });
    const phase = repo.createWorkflowStep(run.id, {
      key: 'build',
      type: 'phase',
      input: { label: 'Build' },
    });
    const agent = repo.createWorkflowStep(run.id, {
      key: 'compile',
      parentKey: 'build',
      type: 'agent',
      input: { prompt: 'Compile the project' },
    });

    expect(repo.getWorkflowStep(phase.id)).toEqual(phase);
    expect(repo.getWorkflowStepByKey(run.id, 'compile')).toEqual(agent);
    expect(repo.listWorkflowSteps(run.id).map((step) => step.key)).toEqual([
      'build',
      'compile',
    ]);

    const updated = repo.updateWorkflowStep(agent.id, {
      status: 'completed',
      output: { summary: 'ok' },
    });
    expect(updated?.status).toBe('completed');
    expect(updated?.output).toEqual({ summary: 'ok' });
    expect(updated?.completedAt).toBeDefined();

    expect(repo.deleteWorkflowStep(agent.id)).toBe(true);
    expect(repo.getWorkflowStep(agent.id)).toBeUndefined();
  });

  it('enforces one stable key per run', () => {
    const run = repo.createWorkflowRun(definition, 'Dynamic');
    repo.createWorkflowStep(run.id, { key: 'same', type: 'checkpoint' });
    expect(() =>
      repo.createWorkflowStep(run.id, { key: 'same', type: 'agent' }),
    ).toThrow();
  });

  it('claims a pending step exactly once', () => {
    const run = repo.createWorkflowRun(definition, 'Dynamic');
    repo.createWorkflowStep(run.id, { key: 'agent-1', type: 'agent' });

    const claimed = repo.claimWorkflowStep(run.id, 'agent-1');
    expect(claimed?.status).toBe('running');
    expect(claimed?.attempt).toBe(1);
    expect(claimed?.startedAt).toBeDefined();
    expect(repo.claimWorkflowStep(run.id, 'agent-1')).toBeUndefined();
  });

  it('supports the durable runtime begin and complete contract', () => {
    const run = repo.createWorkflowRun(definition, 'Dynamic');
    const begun = repo.beginWorkflowStep({
      workflowRunId: run.id,
      stepKey: 'stable-agent',
      parentKey: 'phase',
      kind: 'agent',
      sequence: 3,
      inputHash: 'sha256:input',
      input: { prompt: 'work' },
    });

    expect(begun).toMatchObject({
      stepKey: 'stable-agent',
      kind: 'agent',
      sequence: 3,
      inputHash: 'sha256:input',
      status: 'running',
      attempt: 1,
    });
    expect(
      repo.completeWorkflowStep(run.id, 'stable-agent', { answer: 42 }, {
        workspace: 'branch',
      }),
    ).toMatchObject({
      status: 'completed',
      output: { answer: 42 },
      metadata: { workspace: 'branch' },
    });
    expect(
      repo.beginWorkflowStep({
        workflowRunId: run.id,
        stepKey: 'stable-agent',
        kind: 'agent',
        sequence: 3,
        inputHash: 'sha256:input',
        input: { prompt: 'work' },
      }),
    ).toBeUndefined();
  });

  it('supports compare-and-set updates', () => {
    const run = repo.createWorkflowRun(definition, 'Dynamic');
    const step = repo.createWorkflowStep(run.id, {
      key: 'checkpoint-1',
      type: 'checkpoint',
    });

    expect(
      repo.updateWorkflowStep(
        step.id,
        { status: 'completed', output: 'done' },
        'running',
      ),
    ).toBeUndefined();
    expect(repo.getWorkflowStep(step.id)?.status).toBe('pending');

    expect(
      repo.updateWorkflowStep(step.id, { status: 'running' }, 'pending')?.status,
    ).toBe('running');
  });

  it('resets running steps for recovery without changing completed steps', () => {
    const run = repo.createWorkflowRun(definition, 'Dynamic');
    repo.createWorkflowStep(run.id, { key: 'running', type: 'agent' });
    const completed = repo.createWorkflowStep(run.id, {
      key: 'completed',
      type: 'checkpoint',
    });
    repo.claimWorkflowStep(run.id, 'running');
    repo.updateWorkflowStep(completed.id, { status: 'completed', output: 42 });

    expect(repo.resetRunningWorkflowSteps(run.id)).toBe(1);
    expect(repo.getWorkflowStepByKey(run.id, 'running')).toMatchObject({
      status: 'pending',
      attempt: 1,
      startedAt: undefined,
    });
    expect(repo.getWorkflowStepByKey(run.id, 'completed')).toMatchObject({
      status: 'completed',
      output: 42,
    });
    expect(repo.getWorkflowRun(run.id)?.recoveryCount).toBe(1);
  });

  it('keeps legacy phase and agent reads intact', () => {
    const legacy = repo.createWorkflowRun(
      {
        name: 'legacy',
        phases: [
          {
            name: 'phase',
            agents: [{ name: 'agent', prompt: 'work' }],
          },
        ],
      },
      'Legacy',
    );
    repo.createWorkflowStep(legacy.id, { key: 'extra', type: 'checkpoint' });

    const fetched = repo.getWorkflowRun(legacy.id)!;
    expect(fetched.executionModel).toBe('static');
    expect(fetched.phases[0].agents[0].prompt).toBe('work');
    expect(fetched.steps?.map((step) => step.key)).toEqual(['extra']);
  });
});
