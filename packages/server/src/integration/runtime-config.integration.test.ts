/**
 * Integration test: runtime config E2E flow.
 *
 * Tests the full pipeline end-to-end:
 *   1. GET /api/system/info — returns available runners, providers, models, defaults
 *   2. POST /api/workflows — create a workflow WITH runtimeConfig, verify stored
 *   3. POST /:id/start — start with runtimeConfig override
 *   4. POST /api/workflows — create a workflow WITHOUT runtimeConfig (backward compat)
 *   5. POST /:id/start — start without override
 */

import { describe, it, expect, vi, beforeEach, afterEach, afterAll } from 'vitest';
import request from 'supertest';
import { createApp } from '../app.js';
import { closeDb } from '../db/connection.js';
import { initSchema } from '../db/schema.js';
import { runMigrations } from '../db/migrations.js';

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

// Mock runner isAvailable() — cua is the only available runner
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

const app = createApp();

// ---------------------------------------------------------------------------
// Setup — fresh in-memory DB before each test
// ---------------------------------------------------------------------------

beforeEach(() => {
  closeDb();
  process.env.DB_PATH = ':memory:';
  process.env.OPENCODE_API_KEY = 'test-opencode-key';
  process.env.OPENAI_API_KEY = 'test-openai-key';
  process.env.ANTHROPIC_API_KEY = 'test-anthropic-key';
  initSchema();
  runMigrations();
  vi.clearAllMocks();
});

afterEach(() => {
  delete process.env.OPENCODE_API_KEY;
  delete process.env.OPENAI_API_KEY;
  delete process.env.ANTHROPIC_API_KEY;
});

afterAll(() => {
  closeDb();
  delete process.env.DB_PATH;
});

// =====================================================================
// Tests
// =====================================================================

describe('Runtime config integration', () => {
  it('E2E: create workflow with runtimeConfig, verify stored, start with override', async () => {
    // 1. Create workflow WITH runtimeConfig
    const createRes = await request(app)
      .post('/api/workflows')
      .send({
        name: 'Config Test',
        script: `phase("p1", () => { agent("a1", "do it"); });`,
        runtimeConfig: { runner: 'cua', llmProvider: 'opencode', model: 'gpt-4o' },
      });
    expect(createRes.status).toBe(201);
    expect(createRes.body.success).toBe(true);
    expect(createRes.body.data.runtimeConfig).toBeDefined();
    expect(createRes.body.data.runtimeConfig.runner).toBe('cua');
    expect(createRes.body.data.runtimeConfig.llmProvider).toBe('opencode');
    expect(createRes.body.data.runtimeConfig.model).toBe('gpt-4o');

    const workflowId = createRes.body.data.id;

    // 2. Start workflow with override
    const startRes = await request(app)
      .post(`/api/workflows/${workflowId}/start`)
      .send({ runtimeConfig: { runner: 'cua', model: 'claude-sonnet' } });
    expect(startRes.status).toBe(200);
    expect(startRes.body.success).toBe(true);
  });

  it('E2E: create workflow WITHOUT runtimeConfig (backward compat), start without override', async () => {
    // 1. Create workflow WITHOUT runtimeConfig
    const createRes = await request(app)
      .post('/api/workflows')
      .send({
        name: 'No Config',
        script: `phase("p1", () => { agent("a1", "do it"); });`,
      });
    expect(createRes.status).toBe(201);
    expect(createRes.body.success).toBe(true);
    expect(createRes.body.data.runtimeConfig).toBeUndefined();

    const workflowId = createRes.body.data.id;

    // 2. Start without override — should succeed
    const startRes = await request(app)
      .post(`/api/workflows/${workflowId}/start`)
      .send({});
    expect(startRes.status).toBe(200);
    expect(startRes.body.success).toBe(true);
  });

  it('GET /api/system/info returns available runners and providers', async () => {
    const res = await request(app).get('/api/system/');
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data.runners.length).toBeGreaterThan(0);
    expect(res.body.data.providers.length).toBeGreaterThan(0);
    expect(res.body.data.models).toBeDefined();
    expect(res.body.data.defaults).toBeDefined();

    // cua should be available (we mocked it), docker should not
    const cuaRunner = res.body.data.runners.find((r: { id: string }) => r.id === 'cua');
    const dockerRunner = res.body.data.runners.find((r: { id: string }) => r.id === 'docker');
    expect(cuaRunner).toBeDefined();
    expect(cuaRunner.available).toBe(true);
    expect(dockerRunner).toBeDefined();
    expect(dockerRunner.available).toBe(false);

    // All three providers should be available (env vars set)
    const opencodeProvider = res.body.data.providers.find((p: { id: string }) => p.id === 'opencode');
    const openaiProvider = res.body.data.providers.find((p: { id: string }) => p.id === 'openai');
    const anthropicProvider = res.body.data.providers.find((p: { id: string }) => p.id === 'anthropic');
    expect(opencodeProvider).toBeDefined();
    expect(opencodeProvider.available).toBe(true);
    expect(openaiProvider).toBeDefined();
    expect(openaiProvider.available).toBe(true);
    expect(anthropicProvider).toBeDefined();
    expect(anthropicProvider.available).toBe(true);
  });
});
