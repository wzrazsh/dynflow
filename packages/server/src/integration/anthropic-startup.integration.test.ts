/**
 * Integration test: Anthropic-only env startup.
 *
 * Verifies that the /:id/start endpoint correctly handles requests when
 * ANTHROPIC_API_KEY is the only key available, and returns a 400 when
 * provider=anthropic is requested but no Anthropic key is set.
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
// Setup / teardown
// ---------------------------------------------------------------------------

beforeEach(() => {
  closeDb();
  process.env.DB_PATH = ':memory:';
  // All keys explicitly cleared in each test setup
  delete process.env.OPENCODE_API_KEY;
  delete process.env.OPENAI_API_KEY;
  delete process.env.ANTHROPIC_API_KEY;
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

describe('Anthropic-only env startup', () => {
  it('succeeds when only ANTHROPIC_API_KEY is set and provider=anthropic', async () => {
    // Only set Anthropic key — mimic an Anthropic-only environment
    process.env.ANTHROPIC_API_KEY = 'sk-ant-test';

    // Create a workflow first
    const createRes = await request(app)
      .post('/api/workflows')
      .send({
        name: 'Anthropic Only',
        script: `phase("p1", () => { agent("a1", "do it"); });`,
      });
    expect(createRes.status).toBe(201);
    expect(createRes.body.success).toBe(true);

    const workflowId = createRes.body.data.id;

    // Start with llmProvider=anthropic — should resolve ANTHROPIC_API_KEY
    const startRes = await request(app)
      .post(`/api/workflows/${workflowId}/start`)
      .send({ runtimeConfig: { runner: 'cua', llmProvider: 'anthropic' } });

    // Should succeed (not 400) when Anthropic key is available
    expect(startRes.status).toBe(200);
    expect(startRes.body.success).toBe(true);
  });

  it('returns 400 when provider=anthropic but ANTHROPIC_API_KEY is not set', async () => {
    // All keys remain unset (OPENDCODE/OPENAI/ANTHROPIC all empty)

    // Create a workflow first
    const createRes = await request(app)
      .post('/api/workflows')
      .send({
        name: 'Missing Anthropic Key',
        script: `phase("p1", () => { agent("a1", "do it"); });`,
      });
    expect(createRes.status).toBe(201);
    expect(createRes.body.success).toBe(true);

    const workflowId = createRes.body.data.id;

    // Start with llmProvider=anthropic — should fail because no key
    const startRes = await request(app)
      .post(`/api/workflows/${workflowId}/start`)
      .send({ runtimeConfig: { runner: 'cua', llmProvider: 'anthropic' } });

    expect(startRes.status).toBe(400);
    expect(startRes.body.success).toBe(false);
    expect(startRes.body.error).toContain('ANTHROPIC_API_KEY');
  });
});
