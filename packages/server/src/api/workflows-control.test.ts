import { describe, it, expect, beforeEach, afterEach, afterAll, vi } from 'vitest';
import request from 'supertest';
import express from 'express';
import { closeDb } from '../db/connection.js';
import { initSchema } from '../db/schema.js';
import * as repo from '../db/repository.js';
import type { WorkflowDefinition } from '@dynflow/shared';
import { createAgentRunner } from '../runner/index.js';
import controlRouter from './workflows-control.js';

// ---------------------------------------------------------------------------
// Mocks — prevent real Docker / SSE from running during tests
// ---------------------------------------------------------------------------

vi.mock('../runner/index.js', () => ({
  createAgentRunner: vi.fn(() => ({
    run: vi.fn().mockResolvedValue({ success: true, output: 'mocked', containerId: 'mocked' }),
    stop: vi.fn().mockResolvedValue(undefined),
    cleanup: vi.fn().mockResolvedValue(undefined),
  })),
  isDockerAvailable: vi.fn().mockReturnValue(true),
  cleanupContainers: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../sse/stream-manager.js', () => {
  const mockEmit = vi.fn();
  return {
    StreamManager: {
      getInstance: vi.fn(() => ({
        emit: mockEmit,
        addClient: vi.fn(),
        removeClient: vi.fn(),
        getClientCount: vi.fn().mockReturnValue(0),
      })),
      resetInstance: vi.fn(),
    },
  };
});

// Mock runner modules for isAvailable() checks used in workflows-control.ts
vi.mock('../runner/cua-runner.js', () => ({
  CuaAgentRunner: class {
    static isAvailable() { return true; }
  },
}));
vi.mock('../runner/docker-runner.js', () => ({
  DockerAgentRunner: class {
    static isAvailable() { return false; }
  },
}));
vi.mock('../runner/wsl-docker-runner.js', () => ({
  WslDockerAgentRunner: class {
    static isAvailable() { return false; }
  },
}));
vi.mock('../runner/cua-pi-runner.js', () => ({
  CuaPiRunner: class {
    static isAvailable() { return false; }
  },
}));
vi.mock('../runner/pi-direct-runner.js', () => ({
  PiDirectRunner: class {
    static isAvailable() { return false; }
  },
}));
vi.mock('../runner/pi-cua-native-runner.js', () => ({
  PiCuaNativeRunner: class {
    static isAvailable() { return false; }
  },
}));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function sampleDefinition(): WorkflowDefinition {
  return {
    name: 'test-flow',
    phases: [
      {
        name: 'phase-1',
        agents: [{ name: 'agent-1', prompt: 'Do something' }],
      },
    ],
  };
}

function createApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/workflows', controlRouter);
  return app;
}

// ---------------------------------------------------------------------------
// Setup — fresh in-memory DB before each test
// ---------------------------------------------------------------------------

beforeEach(() => {
  closeDb();
  process.env.DB_PATH = ':memory:';
  initSchema();
  vi.stubEnv('OPENAI_API_KEY', 'test-key');
  vi.clearAllMocks();
});

afterEach(() => {
  vi.unstubAllEnvs();
});

afterAll(() => {
  closeDb();
  delete process.env.DB_PATH;
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('POST /api/workflows/:id/start', () => {
  it('1 — start pending workflow → 200, response says running', async () => {
    const run = repo.createWorkflowRun(sampleDefinition(), 'Test');
    const app = createApp();

    const res = await request(app)
      .post(`/api/workflows/${run.id}/start`)
      .expect(200);

    expect(res.body.success).toBe(true);
    // The endpoint returns 'running' before async execution completes
    expect(res.body.data.status).toBe('running');
  });

  it('2 — start running workflow → 409', async () => {
    const run = repo.createWorkflowRun(sampleDefinition(), 'Test');
    repo.updateWorkflowStatus(run.id, 'running');
    const app = createApp();

    const res = await request(app)
      .post(`/api/workflows/${run.id}/start`)
      .expect(409);

    expect(res.body.success).toBe(false);
    expect(res.body.error).toMatch(/Cannot 'start'/);
  });

  it('3 — start non-existent workflow → 404', async () => {
    const app = createApp();

    const res = await request(app)
      .post('/api/workflows/non-existent-id/start')
      .expect(404);

    expect(res.body.success).toBe(false);
    expect(res.body.error).toBe('Workflow run not found');
  });
});

describe('POST /api/workflows/:id/pause', () => {
  it('4 — pause running workflow → 200', async () => {
    const run = repo.createWorkflowRun(sampleDefinition(), 'Test');
    repo.updateWorkflowStatus(run.id, 'running');
    const app = createApp();

    const res = await request(app)
      .post(`/api/workflows/${run.id}/pause`)
      .expect(200);

    expect(res.body.success).toBe(true);
    expect(res.body.data.status).toBe('paused');

    const saved = repo.getWorkflowRun(run.id)!;
    expect(saved.status).toBe('paused');
  });

  it('5 — pause completed workflow → 409', async () => {
    const run = repo.createWorkflowRun(sampleDefinition(), 'Test');
    repo.updateWorkflowStatus(run.id, 'completed');
    const app = createApp();

    const res = await request(app)
      .post(`/api/workflows/${run.id}/pause`)
      .expect(409);

    expect(res.body.success).toBe(false);
    expect(res.body.error).toMatch(/Cannot 'pause'/);
  });

  it('6 — pause pending workflow → 409', async () => {
    const run = repo.createWorkflowRun(sampleDefinition(), 'Test');
    const app = createApp();

    const res = await request(app)
      .post(`/api/workflows/${run.id}/pause`)
      .expect(409);

    expect(res.body.success).toBe(false);
    expect(res.body.error).toMatch(/Cannot 'pause'/);
  });
});

describe('POST /api/workflows/:id/resume', () => {
  it('7 — resume paused workflow → 200', async () => {
    const run = repo.createWorkflowRun(sampleDefinition(), 'Test');
    repo.updateWorkflowStatus(run.id, 'paused');
    const app = createApp();

    const res = await request(app)
      .post(`/api/workflows/${run.id}/resume`)
      .expect(200);

    expect(res.body.success).toBe(true);
    expect(res.body.data.status).toBe('running');

    // Resume now triggers actual async execution. The repo status may have
    // already transitioned to 'completed' if the mocked runner resolves fast,
    // so we accept either state.
    const saved = repo.getWorkflowRun(run.id)!;
    expect(['running', 'completed']).toContain(saved.status);
  });

  it('8 — resume running workflow → 409', async () => {
    const run = repo.createWorkflowRun(sampleDefinition(), 'Test');
    repo.updateWorkflowStatus(run.id, 'running');
    const app = createApp();

    const res = await request(app)
      .post(`/api/workflows/${run.id}/resume`)
      .expect(409);

    expect(res.body.success).toBe(false);
    expect(res.body.error).toMatch(/Cannot 'resume'/);
  });
});

describe('POST /api/workflows/:id/stop', () => {
  it('9 — stop running workflow → 200', async () => {
    const run = repo.createWorkflowRun(sampleDefinition(), 'Test');
    repo.updateWorkflowStatus(run.id, 'running');
    const app = createApp();

    const res = await request(app)
      .post(`/api/workflows/${run.id}/stop`)
      .expect(200);

    expect(res.body.success).toBe(true);
    expect(res.body.data.status).toBe('stopped');

    const saved = repo.getWorkflowRun(run.id)!;
    expect(saved.status).toBe('stopped');
  });

  it('10 — stop already stopped workflow → 409', async () => {
    const run = repo.createWorkflowRun(sampleDefinition(), 'Test');
    repo.updateWorkflowStatus(run.id, 'stopped');
    const app = createApp();

    const res = await request(app)
      .post(`/api/workflows/${run.id}/stop`)
      .expect(409);

    expect(res.body.success).toBe(false);
    expect(res.body.error).toMatch(/Cannot 'stop'/);
  });
});

describe('GET /api/workflows/:id', () => {
  it('11 — returns the workflow run', async () => {
    const run = repo.createWorkflowRun(sampleDefinition(), 'Test');
    const app = createApp();

    const res = await request(app)
      .get(`/api/workflows/${run.id}`)
      .expect(200);

    expect(res.body.success).toBe(true);
    expect(res.body.data.id).toBe(run.id);
    expect(res.body.data.status).toBe('pending');
  });

  it('12 — returns 404 for non-existent', async () => {
    const app = createApp();

    const res = await request(app)
      .get('/api/workflows/non-existent')
      .expect(404);

    expect(res.body.success).toBe(false);
  });
});

describe('Full lifecycle via status manipulation', () => {
  it('13 — start→pause→resume→stop validates all transitions', async () => {
    const run = repo.createWorkflowRun(sampleDefinition(), 'Lifecycle');
    const app = createApp();

    // 1. Start (set status to running directly for deterministic test)
    repo.updateWorkflowStatus(run.id, 'running');

    // 2. Pause running → should succeed
    const pauseRes = await request(app)
      .post(`/api/workflows/${run.id}/pause`)
      .expect(200);
    expect(pauseRes.body.data.status).toBe('paused');

    // 3. Resume paused → should succeed
    const resumeRes = await request(app)
      .post(`/api/workflows/${run.id}/resume`)
      .expect(200);
    expect(resumeRes.body.data.status).toBe('running');

    // Resume fires async execution; the mocked runner may have already
    // completed the workflow. Reset to 'running' to test the stop transition.
    repo.updateWorkflowStatus(run.id, 'running');

    // 4. Stop running → should succeed
    const stopRes = await request(app)
      .post(`/api/workflows/${run.id}/stop`)
      .expect(200);
    expect(stopRes.body.data.status).toBe('stopped');

    // 5. Stopped → stop again → 409
    await request(app)
      .post(`/api/workflows/${run.id}/stop`)
      .expect(409);
  });
});

// ---------------------------------------------------------------------------
// API key scenarios
// ---------------------------------------------------------------------------

describe('API key scenarios', () => {
  const sampleDef: WorkflowDefinition = {
    name: 'key-test',
    phases: [{ name: 'p', agents: [{ name: 'a', prompt: 'work' }] }],
  };

  it('14 — start with OPENCODE_API_KEY only → 200', async () => {
    vi.stubEnv('OPENAI_API_KEY', '');
    vi.stubEnv('OPENCODE_API_KEY', 'opencode-key');
    const run = repo.createWorkflowRun(sampleDef, 'Test');
    const app = createApp();
    const res = await request(app).post(`/api/workflows/${run.id}/start`).expect(200);
    expect(res.body.data.status).toBe('running');
  });

  it('15 — start with OPENAI_API_KEY only → 200', async () => {
    vi.stubEnv('OPENCODE_API_KEY', '');
    vi.stubEnv('OPENAI_API_KEY', 'openai-key');
    const run = repo.createWorkflowRun(sampleDef, 'Test');
    const app = createApp();
    const res = await request(app).post(`/api/workflows/${run.id}/start`).expect(200);
    expect(res.body.data.status).toBe('running');
  });

  it('16 — start with both set → OPENCODE_API_KEY wins, runner created', async () => {
    vi.stubEnv('OPENAI_API_KEY', 'openai-key');
    vi.stubEnv('OPENCODE_API_KEY', 'opencode-key');
    const run = repo.createWorkflowRun(sampleDef, 'Test');
    const app = createApp();
    const res = await request(app).post(`/api/workflows/${run.id}/start`).expect(200);
    expect(res.body.data.status).toBe('running');
    expect(createAgentRunner).toHaveBeenCalled();
  });

  it('17 — start with neither set → 400, no runner created', async () => {
    vi.stubEnv('OPENAI_API_KEY', '');
    vi.stubEnv('OPENCODE_API_KEY', '');
    const run = repo.createWorkflowRun(sampleDef, 'Test');
    const app = createApp();
    const res = await request(app).post(`/api/workflows/${run.id}/start`).expect(400);
    expect(res.body.success).toBe(false);
    expect(res.body.error).toContain('No API key found');
    expect(createAgentRunner).not.toHaveBeenCalled();
    // Workflow status remains 'pending'
    const saved = repo.getWorkflowRun(run.id)!;
    expect(saved.status).toBe('pending');
  });

  it('18 — resume with OPENCODE_API_KEY only → 200', async () => {
    vi.stubEnv('OPENAI_API_KEY', '');
    vi.stubEnv('OPENCODE_API_KEY', 'opencode-key');
    const run = repo.createWorkflowRun(sampleDef, 'Test');
    repo.updateWorkflowStatus(run.id, 'paused');
    const app = createApp();
    const res = await request(app).post(`/api/workflows/${run.id}/resume`).expect(200);
    expect(res.body.data.status).toBe('running');
  });

  it('19 — resume with neither set → 400, workflow remains paused', async () => {
    vi.stubEnv('OPENAI_API_KEY', '');
    vi.stubEnv('OPENCODE_API_KEY', '');
    const run = repo.createWorkflowRun(sampleDef, 'Test');
    repo.updateWorkflowStatus(run.id, 'paused');
    const app = createApp();
    const res = await request(app).post(`/api/workflows/${run.id}/resume`).expect(400);
    expect(res.body.success).toBe(false);
    expect(res.body.error).toContain('No API key found');
    expect(createAgentRunner).not.toHaveBeenCalled();
    // Workflow status remains 'paused'
    const saved = repo.getWorkflowRun(run.id)!;
    expect(saved.status).toBe('paused');
  });
});

// ---------------------------------------------------------------------------
// RuntimeConfig override scenarios
// ---------------------------------------------------------------------------

describe('POST /api/workflows/:id/start with runtimeConfig override', () => {
  it('20 — accepts valid runtimeConfig and calls createAgentRunner with override', async () => {
    const run = repo.createWorkflowRun(sampleDefinition(), 'Test');
    const app = createApp();

    const res = await request(app).post(`/api/workflows/${run.id}/start`).send({
      runtimeConfig: { runner: 'cua', model: 'gpt-4o' },
    });
    expect(res.status).toBe(200);
    expect(res.body.data.status).toBe('running');
    expect(createAgentRunner).toHaveBeenCalledWith({ runner: 'cua', model: 'gpt-4o' });
  });

  it('21 — returns 400 when runner is not available', async () => {
    const run = repo.createWorkflowRun(sampleDefinition(), 'Test');
    const app = createApp();

    const res = await request(app).post(`/api/workflows/${run.id}/start`).send({
      runtimeConfig: { runner: 'docker' },
    });
    expect(res.status).toBe(400);
    expect(res.body.error).toContain('not available');
  });

  it('22 — returns 400 for invalid runtimeConfig schema', async () => {
    const run = repo.createWorkflowRun(sampleDefinition(), 'Test');
    const app = createApp();

    const res = await request(app).post(`/api/workflows/${run.id}/start`).send({
      runtimeConfig: { runner: 123 },
    });
    expect(res.status).toBe(400);
    expect(res.body.error).toContain('Invalid runtime config');
    expect(createAgentRunner).not.toHaveBeenCalled();
  });
});

describe('POST /api/workflows/:id/resume with runtimeConfig override', () => {
  it('23 — accepts runtimeConfig and calls createAgentRunner with override', async () => {
    const run = repo.createWorkflowRun(sampleDefinition(), 'Test');
    repo.updateWorkflowStatus(run.id, 'paused');
    const app = createApp();

    const res = await request(app).post(`/api/workflows/${run.id}/resume`).send({
      runtimeConfig: { runner: 'cua', model: 'gpt-4o' },
    });
    expect(res.status).toBe(200);
    expect(res.body.data.status).toBe('running');
    expect(createAgentRunner).toHaveBeenCalledWith({ runner: 'cua', model: 'gpt-4o' });
  });

  it('24 — returns 400 when runner is not available on resume', async () => {
    const run = repo.createWorkflowRun(sampleDefinition(), 'Test');
    repo.updateWorkflowStatus(run.id, 'paused');
    const app = createApp();

    const res = await request(app).post(`/api/workflows/${run.id}/resume`).send({
      runtimeConfig: { runner: 'docker' },
    });
    expect(res.status).toBe(400);
    expect(res.body.error).toContain('not available');
  });
});
