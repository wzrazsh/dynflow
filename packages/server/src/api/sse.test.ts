import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import http from 'http';
import express from 'express';
import { StreamManager } from '../sse/stream-manager.js';
import * as repo from '../db/repository.js';
import { closeDb } from '../db/connection.js';
import { initSchema } from '../db/schema.js';
import type { WorkflowDefinition } from '@dynflow/shared';
import sseRouter from './sse.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function sampleDefinition(): WorkflowDefinition {
  return {
    name: 'test-flow',
    phases: [
      {
        name: 'phase-1',
        agents: [{ name: 'agent-1', prompt: 'Do work' }],
      },
    ],
  };
}

/** Create a minimal Express app with just the SSE router */
function createApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/workflows', sseRouter);
  return app;
}

/** Start an app on a random port and return the server + port */
function startServer(
  app: express.Express,
): Promise<{ server: http.Server; port: number }> {
  return new Promise((resolve) => {
    const server = app.listen(0, () => {
      const addr = server.address();
      const port = typeof addr === 'object' && addr ? addr.port : 0;
      resolve({ server, port });
    });
  });
}

/** HTTP GET helper — returns the IncomingMessage */
function httpGet(
  url: string,
): Promise<http.IncomingMessage> {
  return new Promise((resolve) => {
    http.get(url, resolve);
  });
}

/** Read the first data chunk from an IncomingMessage */
function readFirstChunk(res: http.IncomingMessage): Promise<string> {
  return new Promise((resolve) => {
    res.once('data', (chunk: Buffer) => {
      resolve(chunk.toString());
    });
  });
}

// ---------------------------------------------------------------------------
// Mock — spy on StreamManager.getInstance so we can verify addClient/removeClient
// ---------------------------------------------------------------------------

let mockAddClient: ReturnType<typeof vi.fn>;
let mockRemoveClient: ReturnType<typeof vi.fn>;

beforeEach(() => {
  mockAddClient = vi.fn().mockReturnValue('client-1');
  mockRemoveClient = vi.fn();

  vi.spyOn(StreamManager, 'getInstance').mockImplementation(() =>
    ({
      addClient: mockAddClient,
      removeClient: mockRemoveClient,
    }) as unknown as StreamManager,
  );

  closeDb();
  process.env.DB_PATH = ':memory:';
  initSchema();
});

afterEach(() => {
  vi.restoreAllMocks();
  closeDb();
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('GET /api/workflows/:id/stream', () => {
  it('1 — sets SSE headers', async () => {
    const app = createApp();
    const { server, port } = await startServer(app);

    try {
      const res = await httpGet(`http://localhost:${port}/api/workflows/test-id/stream`);

      expect(res.headers['content-type']).toBe('text/event-stream');
      expect(res.headers['cache-control']).toBe('no-cache');
      expect(res.headers['connection']).toBe('keep-alive');
    } finally {
      server.close();
    }
  });

  it('2 — calls StreamManager.addClient with workflow ID and response', async () => {
    const app = createApp();
    const { server, port } = await startServer(app);

    try {
      const res = await httpGet(`http://localhost:${port}/api/workflows/test-id/stream`);

      expect(mockAddClient).toHaveBeenCalledTimes(1);
      expect(mockAddClient).toHaveBeenCalledWith('test-id', expect.any(Object));
      res.destroy();
    } finally {
      server.close();
    }
  });

  it('3 — sends initial workflow_status event when workflow exists', async () => {
    const run = repo.createWorkflowRun(sampleDefinition(), 'Test');
    const app = createApp();
    const { server, port } = await startServer(app);

    try {
      const res = await httpGet(`http://localhost:${port}/api/workflows/${run.id}/stream`);
      const chunk = await readFirstChunk(res);

      expect(chunk).toContain('event: workflow_status');
      expect(chunk).toContain(run.id);
      expect(chunk).toContain('"status":"pending"');
      res.destroy();
    } finally {
      server.close();
    }
  });

  it('4 — still connects when workflow does not exist (no initial event)', async () => {
    const app = createApp();
    const { server, port } = await startServer(app);

    try {
      const res = await httpGet(`http://localhost:${port}/api/workflows/non-existent/stream`);

      // addClient should still be called even if workflow doesn't exist
      expect(mockAddClient).toHaveBeenCalledTimes(1);
      expect(mockAddClient).toHaveBeenCalledWith('non-existent', expect.any(Object));

      // No data should arrive immediately
      let dataReceived = false;
      const waitForData = new Promise<void>((resolve) => {
        const onData = () => {
          dataReceived = true;
          resolve();
        };
        res.once('data', onData);
        // Resolve after a short delay if no data comes
        setTimeout(resolve, 200);
      });
      await waitForData;

      expect(dataReceived).toBe(false);
      res.destroy();
    } finally {
      server.close();
    }
  });

  it('5 — calls removeClient on disconnect', async () => {
    const app = createApp();
    const { server, port } = await startServer(app);

    try {
      const res = await httpGet(`http://localhost:${port}/api/workflows/test-id/stream`);

      // Clear the call from addClient
      mockRemoveClient.mockClear();

      // Destroy the connection to trigger the close event
      res.destroy();

      // Wait a tick for the close handler to fire
      await new Promise((r) => setTimeout(r, 100));

      expect(mockRemoveClient).toHaveBeenCalledTimes(1);
      expect(mockRemoveClient).toHaveBeenCalledWith('test-id', 'client-1');
    } finally {
      server.close();
    }
  });

  it('6 — multiple clients can subscribe to the same workflow', async () => {
    const app = createApp();
    const { server, port } = await startServer(app);
    const url = `http://localhost:${port}/api/workflows/wf-multi/stream`;

    try {
      const [res1, res2] = await Promise.all([
        httpGet(url),
        httpGet(url),
      ]);

      // addClient should have been called for each connection
      expect(mockAddClient).toHaveBeenCalledTimes(2);
      expect(mockAddClient).toHaveBeenCalledWith('wf-multi', expect.any(Object));

      res1.destroy();
      res2.destroy();
    } finally {
      server.close();
    }
  });

  it('7 — respond with 200 status on SSE connection', async () => {
    const app = createApp();
    const { server, port } = await startServer(app);

    try {
      const res = await httpGet(`http://localhost:${port}/api/workflows/test-id/stream`);
      expect(res.statusCode).toBe(200);
      res.destroy();
    } finally {
      server.close();
    }
  });
});
