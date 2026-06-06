import { describe, it, expect, beforeEach, afterEach, afterAll, vi } from 'vitest';
import request from 'supertest';
import express from 'express';
import { closeDb } from '../db/connection.js';
import { initSchema } from '../db/schema.js';
import * as repo from '../db/repository.js';
import type { WorkflowDefinition } from '@dynflow/shared';
import { createAgentRunner } from '../runner/index.js';
import controlRouter, { activeRuntimes } from './workflows-control.js';

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
  it('1 — start pending workflow → 200, DB updated atomically', async () => {
    const run = repo.createWorkflowRun(sampleDefinition(), 'Test');
    const app = createApp();

    const res = await request(app)
      .post(`/api/workflows/${run.id}/start`)
      .expect(200);

    expect(res.body.success).toBe(true);
    // The endpoint returns 'running' before async execution completes
    expect(res.body.data.status).toBe('running');

    // Verify the atomic transition wrote to the DB immediately.
    // The mocked runner may have already completed execution, so accept
    // either 'running' or 'completed' — the key point is it left 'pending'.
    const saved = repo.getWorkflowRun(run.id)!;
    expect(['running', 'completed']).toContain(saved.status);
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

  it('3 — start failed workflow → 409', async () => {
    const run = repo.createWorkflowRun(sampleDefinition(), 'Test');
    repo.updateWorkflowStatus(run.id, 'failed');
    const app = createApp();

    const res = await request(app)
      .post(`/api/workflows/${run.id}/start`)
      .expect(409);

    expect(res.body.success).toBe(false);
    expect(res.body.error).toMatch(/Cannot 'start'/);
  });

  it('4 — start non-existent workflow → 404', async () => {
    const app = createApp();

    const res = await request(app)
      .post('/api/workflows/non-existent-id/start')
      .expect(404);

    expect(res.body.success).toBe(false);
    expect(res.body.error).toBe('Workflow run not found');
  });
});

describe('POST /api/workflows/:id/pause', () => {
  it('5 — pause running workflow → 200', async () => {
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

  it('6 — pause completed workflow → 409', async () => {
    const run = repo.createWorkflowRun(sampleDefinition(), 'Test');
    repo.updateWorkflowStatus(run.id, 'completed');
    const app = createApp();

    const res = await request(app)
      .post(`/api/workflows/${run.id}/pause`)
      .expect(409);

    expect(res.body.success).toBe(false);
    expect(res.body.error).toMatch(/Cannot 'pause'/);
  });

  it('7 — pause pending workflow → 409', async () => {
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
  it('8 — resume paused workflow → 200', async () => {
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

  it('9 — resume running workflow → 409', async () => {
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
  it('10 — stop running workflow → 200', async () => {
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

  it('11 — stop already stopped workflow → 409', async () => {
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
  it('12 — returns the workflow run', async () => {
    const run = repo.createWorkflowRun(sampleDefinition(), 'Test');
    const app = createApp();

    const res = await request(app)
      .get(`/api/workflows/${run.id}`)
      .expect(200);

    expect(res.body.success).toBe(true);
    expect(res.body.data.id).toBe(run.id);
    expect(res.body.data.status).toBe('pending');
  });

  it('13 — returns 404 for non-existent', async () => {
    const app = createApp();

    const res = await request(app)
      .get('/api/workflows/non-existent')
      .expect(404);

    expect(res.body.success).toBe(false);
  });
});

describe('Full lifecycle via status manipulation', () => {
  it('14 — start→pause→resume→stop validates all transitions', async () => {
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

  it('15 — start with OPENCODE_API_KEY only → 200', async () => {
    vi.stubEnv('OPENAI_API_KEY', '');
    vi.stubEnv('OPENCODE_API_KEY', 'opencode-key');
    const run = repo.createWorkflowRun(sampleDef, 'Test');
    const app = createApp();
    const res = await request(app).post(`/api/workflows/${run.id}/start`).expect(200);
    expect(res.body.data.status).toBe('running');
  });

  it('16 — start with OPENAI_API_KEY only → 200', async () => {
    vi.stubEnv('OPENCODE_API_KEY', '');
    vi.stubEnv('OPENAI_API_KEY', 'openai-key');
    const run = repo.createWorkflowRun(sampleDef, 'Test');
    const app = createApp();
    const res = await request(app).post(`/api/workflows/${run.id}/start`).expect(200);
    expect(res.body.data.status).toBe('running');
  });

  it('17 — start with both set → OPENCODE_API_KEY wins, runner created', async () => {
    vi.stubEnv('OPENAI_API_KEY', 'openai-key');
    vi.stubEnv('OPENCODE_API_KEY', 'opencode-key');
    const run = repo.createWorkflowRun(sampleDef, 'Test');
    const app = createApp();
    const res = await request(app).post(`/api/workflows/${run.id}/start`).expect(200);
    expect(res.body.data.status).toBe('running');
    expect(createAgentRunner).toHaveBeenCalled();
  });

  it('18 — start with neither set → 400, no runner created', async () => {
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

  it('19 — resume with OPENCODE_API_KEY only → 200', async () => {
    vi.stubEnv('OPENAI_API_KEY', '');
    vi.stubEnv('OPENCODE_API_KEY', 'opencode-key');
    const run = repo.createWorkflowRun(sampleDef, 'Test');
    repo.updateWorkflowStatus(run.id, 'paused');
    const app = createApp();
    const res = await request(app).post(`/api/workflows/${run.id}/resume`).expect(200);
    expect(res.body.data.status).toBe('running');
  });

  it('20 — resume with neither set → 400, workflow remains paused', async () => {
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
  it('21 — accepts valid runtimeConfig and calls createAgentRunner with override', async () => {
    const run = repo.createWorkflowRun(sampleDefinition(), 'Test');
    const app = createApp();

    const res = await request(app).post(`/api/workflows/${run.id}/start`).send({
      runtimeConfig: { runner: 'cua', model: 'gpt-4o' },
    });
    expect(res.status).toBe(200);
    expect(res.body.data.status).toBe('running');
    expect(createAgentRunner).toHaveBeenCalledWith({ runner: 'cua', model: 'gpt-4o' });
  });

  it('22 — returns 400 when runner is not available', async () => {
    const run = repo.createWorkflowRun(sampleDefinition(), 'Test');
    const app = createApp();

    const res = await request(app).post(`/api/workflows/${run.id}/start`).send({
      runtimeConfig: { runner: 'docker' },
    });
    expect(res.status).toBe(400);
    expect(res.body.error).toContain('not available');
  });

  it('23 — returns 400 for invalid runtimeConfig schema', async () => {
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
  it('24 — accepts runtimeConfig and calls createAgentRunner with override', async () => {
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

  it('25 — returns 400 when runner is not available on resume', async () => {
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

// ---------------------------------------------------------------------------
// activeRuntimes cleanup — verify try/finally always removes from registry
// ---------------------------------------------------------------------------

describe('activeRuntimes cleanup', () => {
  it('26 — cleaned up after successful execution', async () => {
    const run = repo.createWorkflowRun(sampleDefinition(), 'Test');
    const app = createApp();

    await request(app).post(`/api/workflows/${run.id}/start`).expect(200);

    // Wait for async execution to complete and finally to run
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(activeRuntimes.size).toBe(0);
  });

  it('27 — cleaned up after failed execution', async () => {
    // Override the runner mock to reject
    vi.mocked(createAgentRunner).mockImplementationOnce(() => ({
      run: vi.fn().mockRejectedValue(new Error('deliberate failure')),
      stop: vi.fn().mockResolvedValue(undefined),
      cleanup: vi.fn().mockResolvedValue(undefined),
    }));

    const run = repo.createWorkflowRun(sampleDefinition(), 'Test');
    const app = createApp();

    await request(app).post(`/api/workflows/${run.id}/start`).expect(200);

    // Wait for async execution to complete and finally to run
    await new Promise((resolve) => setTimeout(resolve, 50));

    // ActiveRuntimes cleaned up by finally regardless of outcome
    expect(activeRuntimes.size).toBe(0);

    // PhaseExecutor catches agent errors internally via Promise.allSettled,
    // so runtime.execute() completes rather than rejects. The workflow will
    // be marked 'failed' because phases with errors aggregate into a terminal
    // failed status.
    const saved = repo.getWorkflowRun(run.id)!;
    expect(saved.status).toBe('failed');
  });

  it('28 — cleaned up after stop', async () => {
    // Use a deferred runner so the phase stays in-flight while we inject stop
    let resolveRunner!: () => void;
    const deferred = new Promise<void>((resolve) => { resolveRunner = resolve; });

    vi.mocked(createAgentRunner).mockImplementationOnce(() => ({
      run: vi.fn().mockReturnValue(deferred),
      stop: vi.fn().mockResolvedValue(undefined),
      cleanup: vi.fn().mockResolvedValue(undefined),
    }));

    const run = repo.createWorkflowRun(sampleDefinition(), 'Test');
    const app = createApp();

    await request(app).post(`/api/workflows/${run.id}/start`).expect(200);

    // Wait for setImmediate to fire and runtime.execute() to block on the runner
    await new Promise((resolve) => setImmediate(resolve));

    // Execution is in flight — runtime is in activeRuntimes
    expect(activeRuntimes.size).toBe(1);

    // Stop — aborts the runtime and removes from activeRuntimes
    await request(app).post(`/api/workflows/${run.id}/stop`).expect(200);

    // Stop handler already cleaned up; the async finally provides safe
    // double-cleanup (Map.delete on missing key is a no-op)
    expect(activeRuntimes.size).toBe(0);

    // Resolve the runner so the promise chain unwinds without hanging
    resolveRunner();
    await new Promise((resolve) => setTimeout(resolve, 10));

    // Still clean after the finally runs
    expect(activeRuntimes.size).toBe(0);
  });

  it('29 — cleaned up after pause (runtime exits on paused status)', async () => {
    // Use a deferred runner so we can control phase completion timing
    let resolveRunner!: () => void;
    const deferred = new Promise<void>((resolve) => { resolveRunner = resolve; });

    vi.mocked(createAgentRunner).mockImplementationOnce(() => ({
      run: vi.fn().mockReturnValue(deferred),
      stop: vi.fn().mockResolvedValue(undefined),
      cleanup: vi.fn().mockResolvedValue(undefined),
    }));

    const run = repo.createWorkflowRun(sampleDefinition(), 'Test');
    const app = createApp();

    await request(app).post(`/api/workflows/${run.id}/start`).expect(200);

    // Wait for setImmediate to fire and runtime.execute() to block on the runner
    await new Promise((resolve) => setImmediate(resolve));

    // Runtime should still be in activeRuntimes during execution
    expect(activeRuntimes.size).toBe(1);

    // Pause the workflow — status set to 'paused'
    await request(app).post(`/api/workflows/${run.id}/pause`).expect(200);

    // Resolve the runner so the phase completes, causing runtime.execute()
    // to finish (runtime checks status at phase boundary and exits early)
    resolveRunner();

    // Wait for runtime.execute() to unwind and finally to run
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(activeRuntimes.size).toBe(0);
  });
});
