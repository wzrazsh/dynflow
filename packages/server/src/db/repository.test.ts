import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { getDb, closeDb, withRetry } from './connection.js';
import { initSchema } from './schema.js';
import * as repo from './repository.js';
import type { WorkflowDefinition } from '@dynflow/shared';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function sampleDefinition(): WorkflowDefinition {
  return {
    name: 'test-flow',
    phases: [
      {
        name: 'phase-1',
        agents: [
          { name: 'agent-1', prompt: 'Do first thing' },
          { name: 'agent-2', prompt: 'Do second thing' },
        ],
      },
      {
        name: 'phase-2',
        agents: [{ name: 'agent-3', prompt: 'Do final thing' }],
      },
    ],
  };
}

// ---------------------------------------------------------------------------
// Setup — fresh in-memory DB before each test
// ---------------------------------------------------------------------------

beforeEach(() => {
  closeDb();
  process.env.DB_PATH = ':memory:';
  initSchema();
});

afterAll(() => {
  closeDb();
  delete process.env.DB_PATH;
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('createWorkflowRun', () => {
  it('1 — returns full workflow with phases and agents', () => {
    const run = repo.createWorkflowRun(sampleDefinition(), 'My Workflow');

    expect(run.id).toBeDefined();
    expect(run.name).toBe('My Workflow');
    expect(run.status).toBe('pending');
    expect(run.createdAt).toBeDefined();
    expect(run.updatedAt).toBeDefined();

    // Phase tree
    expect(run.phases).toHaveLength(2);

    // Phase 1
    expect(run.phases[0].name).toBe('phase-1');
    expect(run.phases[0].status).toBe('pending');
    expect(run.phases[0].order).toBe(0);
    expect(run.phases[0].agents).toHaveLength(2);

    expect(run.phases[0].agents[0].name).toBe('agent-1');
    expect(run.phases[0].agents[0].prompt).toBe('Do first thing');
    expect(run.phases[0].agents[0].status).toBe('pending');

    expect(run.phases[0].agents[1].name).toBe('agent-2');
    expect(run.phases[0].agents[1].prompt).toBe('Do second thing');

    // Phase 2
    expect(run.phases[1].name).toBe('phase-2');
    expect(run.phases[1].order).toBe(1);
    expect(run.phases[1].agents).toHaveLength(1);
    expect(run.phases[1].agents[0].name).toBe('agent-3');
  });
});

describe('getWorkflowRun', () => {
  it('2 — retrieves complete tree', () => {
    const created = repo.createWorkflowRun(sampleDefinition(), 'Test');
    const retrieved = repo.getWorkflowRun(created.id);

    expect(retrieved).toBeDefined();
    expect(retrieved!.id).toBe(created.id);
    expect(retrieved!.name).toBe('Test');
    expect(retrieved!.phases).toHaveLength(2);
    expect(retrieved!.phases[0].agents).toHaveLength(2);
    expect(retrieved!.phases[1].agents).toHaveLength(1);

    // Verify timestamps
    expect(retrieved!.createdAt).toBe(created.createdAt);
    expect(retrieved!.updatedAt).toBe(created.updatedAt);
  });

  it('7 — returns undefined for non-existent ID', () => {
    const result = repo.getWorkflowRun('non-existent-id');
    expect(result).toBeUndefined();
  });
});

describe('listWorkflowRuns', () => {
  it('3 — paginates correctly', () => {
    const def = sampleDefinition();
    for (let i = 0; i < 5; i++) {
      repo.createWorkflowRun(def, `Workflow ${i}`);
    }

    // Page 1: 3 items
    const page1 = repo.listWorkflowRuns(1, 3);
    expect(page1.runs).toHaveLength(3);
    expect(page1.total).toBe(5);

    // Page 2: 2 items
    const page2 = repo.listWorkflowRuns(2, 3);
    expect(page2.runs).toHaveLength(2);
    expect(page2.total).toBe(5);

    // All run names appear across the two pages
    const allNames = [...page1.runs, ...page2.runs].map((r) => r.name);
    for (let i = 0; i < 5; i++) {
      expect(allNames).toContain(`Workflow ${i}`);
    }
  });
});

describe('updateWorkflowStatus', () => {
  it('4 — changes status and updated_at', () => {
    const run = repo.createWorkflowRun(sampleDefinition(), 'Test');

    const originalUpdated = run.updatedAt;

    repo.updateWorkflowStatus(run.id, 'running');

    const updated = repo.getWorkflowRun(run.id)!;
    expect(updated.status).toBe('running');
    // Timestamp must be >= original (same-ms operations are valid)
    expect(new Date(updated.updatedAt).getTime()).toBeGreaterThanOrEqual(
      new Date(originalUpdated).getTime(),
    );
  });
});

describe('updateAgentStatus', () => {
  it('5 — stores output and sets completed_at', () => {
    const run = repo.createWorkflowRun(sampleDefinition(), 'Test');
    const agentId = run.phases[0].agents[0].id;

    repo.updateAgentStatus(agentId, 'completed', { output: 'Task done' });

    const retrieved = repo.getWorkflowRun(run.id)!;
    const agent = retrieved.phases[0].agents[0];
    expect(agent.status).toBe('completed');
    expect(agent.output).toBe('Task done');
    expect(agent.completedAt).toBeDefined();
    expect(agent.error).toBeUndefined();
  });

  it('6 — stores error', () => {
    const run = repo.createWorkflowRun(sampleDefinition(), 'Test');
    const agentId = run.phases[0].agents[0].id;

    repo.updateAgentStatus(agentId, 'failed', { error: 'Something broke' });

    const retrieved = repo.getWorkflowRun(run.id)!;
    const agent = retrieved.phases[0].agents[0];
    expect(agent.status).toBe('failed');
    expect(agent.error).toBe('Something broke');
    expect(agent.completedAt).toBeDefined();
    expect(agent.output).toBeUndefined();
  });
});

describe('concurrent-style updates', () => {
  it('8 — multiple updates to same agent work (simulating WAL concurrency)', () => {
    const run = repo.createWorkflowRun(sampleDefinition(), 'Test');
    const agentId = run.phases[0].agents[0].id;

    // Rapid sequential updates (simulating concurrent access in WAL mode)
    for (let i = 0; i < 10; i++) {
      repo.updateAgentStatus(agentId, 'running');
    }

    repo.updateAgentStatus(agentId, 'completed', { output: 'Final' });

    const retrieved = repo.getWorkflowRun(run.id)!;
    const agent = retrieved.phases[0].agents[0];
    expect(agent.status).toBe('completed');
    expect(agent.output).toBe('Final');
  });
});

describe('foreign key cascade', () => {
  it('9 — deleting workflow removes phases and agents', () => {
    const run = repo.createWorkflowRun(sampleDefinition(), 'Test');
    const db = getDb();

    // Confirm everything exists before delete
    expect(run.phases).toHaveLength(2);
    expect(run.phases[0].agents).toHaveLength(2);

    // Direct delete to test cascade
    db.prepare('DELETE FROM workflow_runs WHERE id = ?').run(run.id);

    // Phases should be gone
    const phases = db
      .prepare('SELECT * FROM phase_runs WHERE workflow_run_id = ?')
      .all(run.id);
    expect(phases).toHaveLength(0);

    // Workflow not found
    expect(repo.getWorkflowRun(run.id)).toBeUndefined();
  });
});

describe('edge cases', () => {
  it('10 — createWorkflowRun with empty definition has 0 phases', () => {
    const def: WorkflowDefinition = { name: 'empty', phases: [] };
    const run = repo.createWorkflowRun(def, 'Empty');
    expect(run.phases).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// SQLite retry wrapper tests
// ---------------------------------------------------------------------------

describe('withRetry', () => {
  it('returns the result of a successful function', () => {
    const result = withRetry(() => 42);
    expect(result).toBe(42);
  });

  it('propagates non-lock errors immediately', () => {
    expect(() =>
      withRetry(() => {
        throw new Error('not a lock error');
      }, 3),
    ).toThrow('not a lock error');
  });

  it('succeeds on the retry after transient failures', () => {
    let attempts = 0;
    const fn = () => {
      attempts++;
      if (attempts < 2) {
        const err = new Error('SQLITE_BUSY') as Error & { code: number };
        err.code = 5; // SQLITE_BUSY
        throw err;
      }
      return 'ok';
    };

    const result = withRetry(fn, 3, 1);
    expect(result).toBe('ok');
    expect(attempts).toBe(2);
  });

  it('throws after exhausting all retries', () => {
    let attempts = 0;
    const fn = () => {
      attempts++;
      const err = new Error('SQLITE_BUSY') as Error & { code: number };
      err.code = 5; // SQLITE_BUSY
      throw err;
    };

    expect(() => withRetry(fn, 2, 1)).toThrow('SQLITE_BUSY');
    expect(attempts).toBe(3); // initial + 2 retries
  });
});
