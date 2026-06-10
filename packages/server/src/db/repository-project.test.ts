import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { getDb, closeDb } from './connection.js';
import { initSchema } from './schema.js';
import { createWorkflowRun, listWorkflowRuns, getWorkflowRun } from './repository.js';
import type { WorkflowDefinition } from '@dynflow/shared';

describe('project-workflow integration', () => {
  beforeEach(() => {
    closeDb();
    process.env.DB_PATH = ':memory:';
    initSchema();
  });

  afterAll(() => {
    const db = getDb();
    db.exec('DELETE FROM workflow_runs');
    closeDb();
    delete process.env.DB_PATH;
  });

  it('stores projectName on createWorkflowRun', () => {
    const def: WorkflowDefinition = { name: 'test', phases: [] };
    const run = createWorkflowRun(def, 'test-run', { projectName: 'my-project' });
    expect(run.projectName).toBe('my-project');
    const fetched = getWorkflowRun(run.id);
    expect(fetched?.projectName).toBe('my-project');
  });

  it('filters workflow runs by projectName', () => {
    const def: WorkflowDefinition = { name: 'test', phases: [] };
    createWorkflowRun(def, 'run-a', { projectName: 'proj-x' });
    createWorkflowRun(def, 'run-b', { projectName: 'proj-y' });
    createWorkflowRun(def, 'run-c', { projectName: 'proj-x' });
    const { runs } = listWorkflowRuns(1, 10, { projectName: 'proj-x' });
    expect(runs).toHaveLength(2);
    expect(runs.every(r => r.projectName === 'proj-x')).toBe(true);
  });

  it('returns all runs when projectName filter is empty', () => {
    const def: WorkflowDefinition = { name: 'test', phases: [] };
    createWorkflowRun(def, 'run-a', { projectName: 'proj-x' });
    createWorkflowRun(def, 'run-b', {});
    createWorkflowRun(def, 'run-c', { projectName: 'proj-y' });
    const { runs } = listWorkflowRuns(1, 10, {});
    expect(runs.length).toBeGreaterThanOrEqual(3);
  });
});
