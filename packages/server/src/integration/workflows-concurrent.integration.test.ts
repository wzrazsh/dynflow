/**
 * Integration test: concurrent start requests.
 *
 * Verifies that when two POST /:id/start requests arrive simultaneously,
 * exactly one succeeds (200) and the other gets 409 (conflict).
 * The atomic SQL transition (UPDATE WHERE id=? AND status='pending')
 * ensures only one caller claims the workflow.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import request from 'supertest';
import { createApp } from '../app.js';
import { closeDb } from '../db/connection.js';
import { initSchema } from '../db/schema.js';
import { runMigrations } from '../db/migrations.js';
import * as repo from '../db/repository.js';

// ---------------------------------------------------------------------------
// Mocks — prevent real Docker / SSE from running during tests
// ---------------------------------------------------------------------------

vi.mock('../runner/index.js', () => ({
  createAgentRunner: vi.fn(() => ({
    run: vi.fn().mockResolvedValue({
      success: true,
      output: 'mocked',
      containerId: 'mocked',
    }),
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
    static isAvailable() {
      return true;
    }
  },
}));
vi.mock('../runner/docker-runner.js', () => ({
  DockerAgentRunner: class {
    static isAvailable() {
      return false;
    }
  },
}));
vi.mock('../runner/wsl-docker-runner.js', () => ({
  WslDockerAgentRunner: class {
    static isAvailable() {
      return false;
    }
  },
}));
vi.mock('../runner/cua-pi-runner.js', () => ({
  CuaPiRunner: class {
    static isAvailable() {
      return false;
    }
  },
}));
vi.mock('../runner/pi-direct-runner.js', () => ({
  PiDirectRunner: class {
    static isAvailable() {
      return false;
    }
  },
}));
vi.mock('../runner/pi-cua-native-runner.js', () => ({
  PiCuaNativeRunner: class {
    static isAvailable() {
      return false;
    }
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
  initSchema();
  runMigrations();
  vi.clearAllMocks();
});

afterEach(() => {
  delete process.env.OPENCODE_API_KEY;
});

// =====================================================================
// Tests
// =====================================================================

describe('Concurrent start requests', () => {
  it('two concurrent POST /:id/start: one succeeds (200), one gets conflict (409)', async () => {
    // Seed a pending workflow run directly via the repository
    const workflow = repo.createWorkflowRun(
      {
        name: 'concurrent-test',
        phases: [{ name: 'p1', agents: [{ name: 'a1', prompt: 'test' }] }],
      },
      'Concurrent Start Test',
    );

    // Fire two start requests simultaneously — NO artificial delay
    const [res1, res2] = await Promise.all([
      request(app).post(`/api/workflows/${workflow.id}/start`).send({}),
      request(app).post(`/api/workflows/${workflow.id}/start`).send({}),
    ]);

    // Classify responses by status code
    const ok = [res1, res2].filter((r) => r.status === 200);
    const conflict = [res1, res2].filter((r) => r.status === 409);

    // Exactly one request must succeed, the other must conflict
    expect(ok.length).toBe(1);
    expect(conflict.length).toBe(1);

    // Verify the 200 response body
    expect(ok[0].body.success).toBe(true);
    expect(ok[0].body.data.status).toBe('running');

    // Verify the 409 response body
    expect(conflict[0].body.success).toBe(false);
    expect(conflict[0].body.error).toBeDefined();
    expect(typeof conflict[0].body.error).toBe('string');
  });
});
