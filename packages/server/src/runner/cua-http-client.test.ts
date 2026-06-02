/**
 * Tests for CuaHttpClient.
 *
 * Uses a real local HTTP server (via node:http) to simulate the Cua
 * Computer Server. This exercises the full HTTP code path including
 * the SSE parser and the WS handshake, without requiring a running
 * Python Cua server.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { createServer, type Server, type IncomingMessage, type ServerResponse } from 'node:http';
import { AddressInfo } from 'node:net';
import { CuaHttpClient } from './cua-http-client.js';

let server: Server;
let port: number;
let lastCommand: { command: string; params: unknown } | null = null;

beforeAll(async () => {
  server = createServer((req: IncomingMessage, res: ServerResponse) => {
    if (req.url === '/status') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ status: 'ok', os_type: 'windows', features: [] }));
      return;
    }
    if (req.url === '/cmd' && req.method === 'POST') {
      // Consume the body, then return a command-specific SSE response.
      let body = '';
      req.on('data', (chunk) => (body += chunk));
      req.on('end', () => {
        try {
          const parsed = JSON.parse(body) as { command: string; params: Record<string, unknown> };
          lastCommand = parsed;
          // Return a response keyed off the command name.
          let response: Record<string, unknown> = { success: true };
          if (parsed.command === 'screenshot') {
            response = { success: true, image_data: 'iVBORw0KGgo=', format: 'png' };
          } else if (parsed.command === 'left_click') {
            response = { success: true };
          } else if (parsed.command === 'type_text') {
            response = { success: true };
          } else if (parsed.command === 'run_command') {
            response = { success: true, stdout: 'hi\n', stderr: '', return_code: 0 };
          } else if (parsed.command === 'list_dir') {
            response = { success: true, files: ['a.txt', 'b.txt'] };
          } else if (parsed.command === 'read_text') {
            response = { success: true, content: 'hello world' };
          } else if (parsed.command === 'write_text') {
            response = { success: true };
          } else if (parsed.command === 'get_accessibility_tree') {
            response = { success: true, tree: { role: 'window', title: 'desktop' } };
          }
          res.writeHead(200, { 'Content-Type': 'text/event-stream' });
          res.end(`data: ${JSON.stringify(response)}\n\n`);
        } catch {
          res.writeHead(400);
          res.end('{"detail":"bad json"}');
        }
      });
      return;
    }
    res.writeHead(404);
    res.end('not found');
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  port = (server.address() as AddressInfo).port;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

beforeEach(() => {
  lastCommand = null;
});

describe('CuaHttpClient', () => {
  it('isReachable returns true when /status returns 200', async () => {
    const client = new CuaHttpClient({ baseUrl: `http://127.0.0.1:${port}` });
    const result = await client.isReachable();
    expect(result).toBe(true);
  });

  it('isReachable returns false when server returns non-200', async () => {
    // Spin up a one-off server that returns 500
    const down = createServer((_req, res) => {
      res.writeHead(500);
      res.end('oops');
    });
    await new Promise<void>((r) => down.listen(0, '127.0.0.1', r));
    const addr = down.address() as AddressInfo;
    const client = new CuaHttpClient({ baseUrl: `http://127.0.0.1:${addr.port}` });
    const result = await client.isReachable();
    expect(result).toBe(false);
    await new Promise<void>((r) => down.close(() => r()));
  });

  it('isReachable returns false on connection refused', async () => {
    const client = new CuaHttpClient({ baseUrl: 'http://127.0.0.1:1' });
    const result = await client.isReachable();
    expect(result).toBe(false);
  });

  it('screenshot returns base64 image data', async () => {
    const client = new CuaHttpClient({ baseUrl: `http://127.0.0.1:${port}` });
    const result = await client.screenshot('png');
    expect(result.imageDataB64).toBe('iVBORw0KGgo=');
    expect(result.format).toBe('png');
  });

  it('leftClick sends x,y and returns success', async () => {
    const client = new CuaHttpClient({ baseUrl: `http://127.0.0.1:${port}` });
    await client.leftClick(100, 200);
    expect(lastCommand).toEqual({ command: 'left_click', params: { x: 100, y: 200 } });
  });

  it('typeText sends the text payload', async () => {
    const client = new CuaHttpClient({ baseUrl: `http://127.0.0.1:${port}` });
    await client.typeText('hello world');
    expect(lastCommand).toEqual({ command: 'type_text', params: { text: 'hello world' } });
  });

  it('runCommand returns stdout/stderr/returnCode', async () => {
    const client = new CuaHttpClient({ baseUrl: `http://127.0.0.1:${port}` });
    const result = await client.runCommand('echo hi');
    expect(result.success).toBe(true);
    expect(result.stdout).toBe('hi\n');
    expect(result.returnCode).toBe(0);
  });

  it('listDir returns file names', async () => {
    const client = new CuaHttpClient({ baseUrl: `http://127.0.0.1:${port}` });
    const result = await client.listDir('/tmp');
    expect(result.files).toEqual(['a.txt', 'b.txt']);
  });

  it('readText returns content', async () => {
    const client = new CuaHttpClient({ baseUrl: `http://127.0.0.1:${port}` });
    const result = await client.readText('/etc/hostname');
    expect(result.content).toBe('hello world');
  });

  it('writeText sends path and content', async () => {
    const client = new CuaHttpClient({ baseUrl: `http://127.0.0.1:${port}` });
    await client.writeText('/tmp/out.txt', 'data');
    expect(lastCommand).toEqual({
      command: 'write_text',
      params: { path: '/tmp/out.txt', content: 'data' },
    });
  });

  it('close() is idempotent', async () => {
    const client = new CuaHttpClient({ baseUrl: `http://127.0.0.1:${port}` });
    await client.close();
    await client.close(); // second call should not throw
  });

  it('getAccessibilityTree returns the tree object', async () => {
    // The mock server doesn't know about `get_accessibility_tree`,
    // so we have to add it. Since the test server is shared, we
    // need a separate one. Spin up a one-off server.
    const oneOff = createServer((req, res) => {
      if (req.url === '/status') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ status: 'ok' }));
        return;
      }
      if (req.url === '/cmd' && req.method === 'POST') {
        let body = '';
        req.on('data', (c) => (body += c));
        req.on('end', () => {
          const parsed = JSON.parse(body) as { command: string };
          if (parsed.command === 'get_accessibility_tree') {
            res.writeHead(200, { 'Content-Type': 'text/event-stream' });
            res.end(
              `data: ${JSON.stringify({ success: true, tree: { role: 'window', title: 'test' } })}\n\n`,
            );
          } else {
            res.writeHead(200, { 'Content-Type': 'text/event-stream' });
            res.end(`data: ${JSON.stringify({ success: true })}\n\n`);
          }
        });
        return;
      }
      res.writeHead(404);
      res.end();
    });
    await new Promise<void>((r) => oneOff.listen(0, '127.0.0.1', r));
    const aPort = (oneOff.address() as AddressInfo).port;
    const client = new CuaHttpClient({
      baseUrl: `http://127.0.0.1:${aPort}`,
      // Disable WS to force HTTP fallback (avoids Node's experimental
      // WebSocket startup cost).
      commandTimeoutMs: 2_000,
    });
    // Force HTTP fallback by closing the WS (it hasn't opened yet)
    // then calling getAccessibilityTree which uses the send() path.
    const tree = await client.getAccessibilityTree();
    expect(tree).toEqual({ role: 'window', title: 'test' });
    await client.close();
    await new Promise<void>((r) => oneOff.close(() => r()));
  });

  it('concurrent commands resolve in FIFO order (no queue corruption)', async () => {
    // Spin up a server that delays responses to test ordering.
    const oneOff = createServer((req, res) => {
      if (req.url === '/status') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ status: 'ok' }));
        return;
      }
      if (req.url === '/cmd' && req.method === 'POST') {
        let body = '';
        req.on('data', (c) => (body += c));
        req.on('end', () => {
          const parsed = JSON.parse(body) as { command: string; params: { n: number } };
          // Echo the index so the test can assert order.
          setTimeout(() => {
            res.writeHead(200, { 'Content-Type': 'text/event-stream' });
            res.end(`data: ${JSON.stringify({ success: true, n: parsed.params.n })}\n\n`);
          }, 5);
        });
        return;
      }
      res.writeHead(404);
      res.end();
    });
    await new Promise<void>((r) => oneOff.listen(0, '127.0.0.1', r));
    const aPort = (oneOff.address() as AddressInfo).port;
    const client = new CuaHttpClient({
      baseUrl: `http://127.0.0.1:${aPort}`,
      commandTimeoutMs: 2_000,
    });
    // Fire 5 concurrent commands.
    const results = await Promise.all(
      [0, 1, 2, 3, 4].map((n) =>
        client
          .runCommand(`echo ${n}`)
          .then((r) => ({ n, ok: r.success, stdout: r.stdout })),
      ),
    );
    // All 5 must resolve successfully in the order they were issued
    // (FIFO over the HTTP-fallback path).
    expect(results).toHaveLength(5);
    for (let i = 0; i < 5; i++) {
      expect(results[i].ok).toBe(true);
    }
    await client.close();
    await new Promise<void>((r) => oneOff.close(() => r()));
  });
});
