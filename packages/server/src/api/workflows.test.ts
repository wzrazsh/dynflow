import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import request from 'supertest';
import { createApp } from '../app.js';
import { getDb, closeDb } from '../db/connection.js';
import { initSchema } from '../db/schema.js';
import * as repo from '../db/repository.js';
import type { WorkflowDefinition, RuntimeConfig } from '@dynflow/shared';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const VALID_SCRIPT = `
phase("Research", () => {
  agent("researcher-1", "Research quantum computing");
  agent("researcher-2", "Review literature");
});
phase("Build", () => {
  agent("builder-1", "Implement the solution");
});
`;

const INVALID_SCRIPT = `
phase("Research", () => {
  agent("researcher-1", "Research quantum computing");
`;

function sampleDefinition(): WorkflowDefinition {
  return {
    name: 'test-flow',
    phases: [
      { name: 'phase-1', agents: [{ name: 'agent-1', prompt: 'Do work' }] },
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

describe('POST /api/workflows', () => {
  it('1 — returns 201 with full workflow tree for valid script', async () => {
    const app = createApp();
    const res = await request(app)
      .post('/api/workflows')
      .send({ name: 'My Workflow', script: VALID_SCRIPT })
      .expect('Content-Type', /json/);

    expect(res.status).toBe(201);
    expect(res.body.success).toBe(true);
    expect(res.body.data).toBeDefined();
    expect(res.body.data.id).toBeDefined();
    expect(res.body.data.name).toBe('My Workflow');
    expect(res.body.data.status).toBe('pending');
    expect(res.body.data.createdAt).toBeDefined();
    expect(res.body.data.updatedAt).toBeDefined();

    // Phase tree
    expect(res.body.data.phases).toHaveLength(2);
    expect(res.body.data.phases[0].name).toBe('Research');
    expect(res.body.data.phases[0].status).toBe('pending');
    expect(res.body.data.phases[0].agents).toHaveLength(2);
    expect(res.body.data.phases[0].agents[0].name).toBe('researcher-1');
    expect(res.body.data.phases[0].agents[0].prompt).toBe(
      'Research quantum computing',
    );
    expect(res.body.data.phases[1].name).toBe('Build');
    expect(res.body.data.phases[1].agents).toHaveLength(1);
    expect(res.body.data.phases[1].agents[0].name).toBe('builder-1');
    expect(res.body.data.phases[1].agents[0].prompt).toBe(
      'Implement the solution',
    );
  });

  it('2 — returns 400 for invalid script (unmatched brace)', async () => {
    const app = createApp();
    const res = await request(app)
      .post('/api/workflows')
      .send({ name: 'Bad', script: INVALID_SCRIPT })
      .expect('Content-Type', /json/);

    expect(res.status).toBe(400);
    expect(res.body.success).toBe(false);
    expect(res.body.error).toBeDefined();
    expect(res.body.details).toBeDefined();
  });

  it('3 — returns 400 when name is empty', async () => {
    const app = createApp();
    const res = await request(app)
      .post('/api/workflows')
      .send({ name: '', script: VALID_SCRIPT })
      .expect('Content-Type', /json/);

    expect(res.status).toBe(400);
    expect(res.body.success).toBe(false);
    expect(res.body.error).toBe('Name and script are required');
  });

  it('4 — returns 400 when script is missing', async () => {
    const app = createApp();
    const res = await request(app)
      .post('/api/workflows')
      .send({ name: 'No Script' })
      .expect('Content-Type', /json/);

    expect(res.status).toBe(400);
    expect(res.body.success).toBe(false);
    expect(res.body.error).toBe('Name and script are required');
  });

  it('17 — stores script and returns it in response', async () => {
    const app = createApp();
    const res = await request(app)
      .post('/api/workflows')
      .send({ name: 'Script Test', script: VALID_SCRIPT })
      .expect('Content-Type', /json/);
    expect(res.status).toBe(201);
    expect(res.body.data.script).toBe(VALID_SCRIPT);
  });
});

describe('GET /api/workflows', () => {
  it('5 — returns paginated list', async () => {
    // Seed 3 workflows directly
    for (let i = 0; i < 3; i++) {
      repo.createWorkflowRun(sampleDefinition(), `Workflow ${i}`);
    }

    const app = createApp();
    const res = await request(app)
      .get('/api/workflows')
      .expect('Content-Type', /json/);

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data).toHaveLength(3);
    expect(res.body.total).toBe(3);
    expect(res.body.page).toBe(1);
    expect(res.body.pageSize).toBe(10);
  });

  it('6 — paginates with page and pageSize params', async () => {
    for (let i = 0; i < 5; i++) {
      repo.createWorkflowRun(sampleDefinition(), `Workflow ${i}`);
    }

    const app = createApp();
    const res = await request(app)
      .get('/api/workflows?page=2&pageSize=2')
      .expect('Content-Type', /json/);

    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(2);
    expect(res.body.total).toBe(5);
    expect(res.body.page).toBe(2);
    expect(res.body.pageSize).toBe(2);
  });

  it('7 — returns empty array when no workflows exist', async () => {
    const app = createApp();
    const res = await request(app)
      .get('/api/workflows')
      .expect('Content-Type', /json/);

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data).toEqual([]);
    expect(res.body.total).toBe(0);
  });

  it('14 — filters by name query param', async () => {
    repo.createWorkflowRun(sampleDefinition(), 'MathQuest v15');
    repo.createWorkflowRun(sampleDefinition(), 'Test Workflow');
    const app = createApp();
    const res = await request(app)
      .get('/api/workflows?name=MathQuest')
      .expect('Content-Type', /json/);
    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(1);
    expect(res.body.data[0].name).toBe('MathQuest v15');
    expect(res.body.total).toBe(1);
  });

  it('15 — filters by status query param', async () => {
    repo.createWorkflowRun(sampleDefinition(), 'Running Wf');
    const db = getDb();
    db.prepare('UPDATE workflow_runs SET status = ? WHERE name = ?').run('running', 'Running Wf');
    repo.createWorkflowRun(sampleDefinition(), 'Pending Wf');
    const app = createApp();
    const res = await request(app)
      .get('/api/workflows?status=running')
      .expect('Content-Type', /json/);
    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(1);
    expect(res.body.data[0].name).toBe('Running Wf');
  });

  it('16 — pageSize clamped to max 50', async () => {
    for (let i = 0; i < 60; i++) repo.createWorkflowRun(sampleDefinition(), `Wf ${i}`);
    const app = createApp();
    const res = await request(app)
      .get('/api/workflows?pageSize=999')
      .expect('Content-Type', /json/);
    expect(res.status).toBe(200);
    expect(res.body.pageSize).toBe(50);
  });
});

describe('GET /api/workflows/:id', () => {
  it('8 — returns 200 with full workflow detail', async () => {
    const created = repo.createWorkflowRun(sampleDefinition(), 'Detail Test');

    const app = createApp();
    const res = await request(app)
      .get(`/api/workflows/${created.id}`)
      .expect('Content-Type', /json/);

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data.id).toBe(created.id);
    expect(res.body.data.name).toBe('Detail Test');
    expect(res.body.data.status).toBe('pending');
    expect(res.body.data.phases).toHaveLength(1);
    expect(res.body.data.phases[0].agents).toHaveLength(1);
  });

  it('9 — returns 404 for non-existent ID', async () => {
    const app = createApp();
    const res = await request(app)
      .get('/api/workflows/non-existent-id')
      .expect('Content-Type', /json/);

    expect(res.status).toBe(404);
    expect(res.body.success).toBe(false);
    expect(res.body.error).toBe('Workflow not found');
  });
});

describe('DELETE /api/workflows/:id', () => {
  it('10 — deletes completed workflow (200)', async () => {
    const created = repo.createWorkflowRun(sampleDefinition(), 'To Delete');
    repo.updateWorkflowStatus(created.id, 'completed');

    const app = createApp();
    const res = await request(app)
      .delete(`/api/workflows/${created.id}`)
      .expect('Content-Type', /json/);

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);

    // Confirm deleted from DB
    expect(repo.getWorkflowRun(created.id)).toBeUndefined();
  });

  it('11 — returns 409 for running workflow', async () => {
    const created = repo.createWorkflowRun(sampleDefinition(), 'Running');
    repo.updateWorkflowStatus(created.id, 'running');

    const app = createApp();
    const res = await request(app)
      .delete(`/api/workflows/${created.id}`)
      .expect('Content-Type', /json/);

    expect(res.status).toBe(409);
    expect(res.body.success).toBe(false);
    expect(res.body.error).toBe('Cannot delete running workflow');
  });

  it('12 — returns 409 for paused workflow', async () => {
    const created = repo.createWorkflowRun(sampleDefinition(), 'Paused');
    repo.updateWorkflowStatus(created.id, 'paused');

    const app = createApp();
    const res = await request(app)
      .delete(`/api/workflows/${created.id}`)
      .expect('Content-Type', /json/);

    expect(res.status).toBe(409);
    expect(res.body.success).toBe(false);
    expect(res.body.error).toBe('Cannot delete paused workflow');
  });

  it('13 — returns 404 for non-existent workflow', async () => {
    const app = createApp();
    const res = await request(app)
      .delete('/api/workflows/does-not-exist')
      .expect('Content-Type', /json/);

    expect(res.status).toBe(404);
    expect(res.body.success).toBe(false);
    expect(res.body.error).toBe('Workflow not found');
  });
});

describe('POST /api/workflows — runtimeConfig', () => {
  it('accepts runtimeConfig and persists it', async () => {
    const app = createApp();
    const res = await request(app)
      .post('/api/workflows')
      .send({
        name: 'With Config',
        script: `phase("p1", () => { agent("a1", "do it"); });`,
        runtimeConfig: { runner: 'pi-direct', llmProvider: 'opencode', model: 'gpt-4o' },
      });
    expect(res.status).toBe(201);
    expect(res.body.success).toBe(true);
    expect(res.body.data.runtimeConfig).toBeDefined();
    expect(res.body.data.runtimeConfig.runner).toBe('pi-direct');
  });

  it('returns 400 for invalid runtimeConfig', async () => {
    const app = createApp();
    const res = await request(app)
      .post('/api/workflows')
      .send({
        name: 'Bad Config',
        script: `phase("p1", () => { agent("a1", "do it"); });`,
        runtimeConfig: { runner: 123 as unknown as string },
      });
    expect(res.status).toBe(400);
    expect(res.body.success).toBe(false);
  });

  it('works without runtimeConfig (backward compat)', async () => {
    const app = createApp();
    const res = await request(app)
      .post('/api/workflows')
      .send({
        name: 'No Config',
        script: `phase("p1", () => { agent("a1", "do it"); });`,
      });
    expect(res.status).toBe(201);
    expect(res.body.success).toBe(true);
  });
});
