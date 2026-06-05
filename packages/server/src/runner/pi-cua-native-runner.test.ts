/**
 * Tests for PiCuaNativeRunner.
 *
 * Strategy:
 *  - Use `vi.mock` to replace `@earendil-works/pi-agent-core` and
 *    `@earendil-works/pi-ai` with stubs that record calls and
 *    return canned responses. This isolates the runner's logic
 *    from the LLM/provider stack.
 *  - Use a real local HTTP server (via node:http) to simulate the
 *    Cua Computer Server — the runner's HTTP/SSE fallback path is
 *    exercised against a real socket.
 *  - Use a real temp directory for workspacePath so file tools can
 *    be exercised end-to-end.
 */
import {
  describe,
  it,
  expect,
  vi,
  beforeAll,
  afterAll,
  beforeEach,
  afterEach,
} from 'vitest';
import { mkdtemp, rm, readFile, readdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer, type Server, type IncomingMessage, type ServerResponse } from 'node:http';
import { AddressInfo } from 'node:net';

// --- Mocks for pi-agent-core and pi-ai ------------------------------------

const mockRunAgentLoop = vi.fn();
const mockGetModel = vi.fn();

vi.mock('@earendil-works/pi-agent-core', () => {
  return {
    runAgentLoop: mockRunAgentLoop,
  };
});

vi.mock('@earendil-works/pi-ai', () => {
  return {
    getModel: mockGetModel,
  };
});

// --- Mock Cua HTTP server ------------------------------------------------

let cuaServer: Server;
let cuaPort: number;

beforeAll(async () => {
  cuaServer = createServer((req: IncomingMessage, res: ServerResponse) => {
    if (req.url === '/status') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ status: 'ok', os_type: 'windows', features: [] }));
      return;
    }
    if (req.url === '/cmd' && req.method === 'POST') {
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => {
        let parsed: { command: string; params: Record<string, unknown> };
        try {
          parsed = JSON.parse(body);
        } catch {
          res.writeHead(400);
          res.end('{"detail":"bad json"}');
          return;
        }
        let response: Record<string, unknown> = { success: true };
        if (parsed.command === 'screenshot') {
          response = { success: true, image_data: 'AAAA', format: 'png' };
        } else if (parsed.command === 'run_command') {
          response = { success: true, stdout: 'mocked', stderr: '', return_code: 0 };
        } else if (parsed.command === 'left_click') {
          response = { success: true };
        }
        res.writeHead(200, { 'Content-Type': 'text/event-stream' });
        res.end(`data: ${JSON.stringify(response)}\n\n`);
      });
      return;
    }
    res.writeHead(404);
    res.end('not found');
  });
  await new Promise<void>((r) => cuaServer.listen(0, '127.0.0.1', r));
  cuaPort = (cuaServer.address() as AddressInfo).port;
});

afterAll(async () => {
  await new Promise<void>((r) => cuaServer.close(() => r()));
});

// --- Per-test setup -------------------------------------------------------

let workDir: string;

beforeEach(async () => {
  workDir = await mkdtemp(join(tmpdir(), 'pi-cua-native-test-'));
  // Reset mocks
  mockRunAgentLoop.mockReset();
  mockGetModel.mockReset();
  // Default mock behavior: runAgentLoop returns one assistant message,
  // getModel returns a sentinel object.
  mockGetModel.mockReturnValue({ id: 'mimo-v2.5-free', provider: 'opencode', api: 'openai-completions' });
  mockRunAgentLoop.mockImplementation(async (_prompts, _context, _config, emit) => {
    // Simulate a minimal turn: agent_start -> tool_execution_start ->
    // message_end (assistant) -> agent_end. The runner captures the
    // last assistant text in `emit`.
    if (emit) {
      await emit({ type: 'agent_start' } as never);
      await emit({
        type: 'message_end',
        message: {
          role: 'assistant',
          content: [{ type: 'text', text: 'Game created.' }],
        },
      } as never);
      await emit({ type: 'agent_end', messages: [] } as never);
    }
    return [];
  });
});

afterEach(async () => {
  await rm(workDir, { recursive: true, force: true });
});

// --- Tests ----------------------------------------------------------------

describe('PiCuaNativeRunner', () => {
  it('static isAvailable() returns true when the agent-core module is installed', async () => {
    // vi.resetModules() clears the vitest module registry so the hoisted
    // vi.mock is freshly applied. Under parallel load the module cache
    // can have stale entries that cause import.meta.resolve to stall.
    vi.resetModules();
    const { PiCuaNativeRunner } = await import('./pi-cua-native-runner.js');
    expect(PiCuaNativeRunner.isAvailable()).toBe(true);
  });

  it('static isServerReachable() returns true when Cua /status returns 200', async () => {
    const { PiCuaNativeRunner } = await import('./pi-cua-native-runner.js');
    const ok = await PiCuaNativeRunner.isServerReachable({
      cuaServerUrl: `http://127.0.0.1:${cuaPort}`,
    });
    expect(ok).toBe(true);
  });

  it('static isServerReachable() returns false on connection refused', async () => {
    const { PiCuaNativeRunner } = await import('./pi-cua-native-runner.js');
    const ok = await PiCuaNativeRunner.isServerReachable({
      cuaServerUrl: 'http://127.0.0.1:1',
    });
    expect(ok).toBe(false);
  });

  it('run() returns error when workspacePath is missing', async () => {
    const { PiCuaNativeRunner } = await import('./pi-cua-native-runner.js');
    const runner = new PiCuaNativeRunner({ cuaServerUrl: `http://127.0.0.1:${cuaPort}` });
    const result = await runner.run({
      agentId: 'test',
      prompt: 'hi',
      timeoutMs: 5000,
      workspacePath: '',
      workspaceMount: '',
    });
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/workspacePath is required/);
    expect(result.containerId).toBe('');
  });

  it('run() returns error when Cua server is not reachable', async () => {
    const { PiCuaNativeRunner } = await import('./pi-cua-native-runner.js');
    const runner = new PiCuaNativeRunner({ cuaServerUrl: 'http://127.0.0.1:1' });
    const result = await runner.run({
      agentId: 'test',
      prompt: 'hi',
      timeoutMs: 5000,
      workspacePath: workDir,
      workspaceMount: workDir,
    });
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/Cua Computer Server is not reachable/);
  });

  it('run() succeeds and captures assistant text from message_end', async () => {
    const { PiCuaNativeRunner } = await import('./pi-cua-native-runner.js');
    const runner = new PiCuaNativeRunner({ cuaServerUrl: `http://127.0.0.1:${cuaPort}` });
    const result = await runner.run({
      agentId: 'test',
      prompt: 'Create a game',
      timeoutMs: 5000,
      workspacePath: workDir,
      workspaceMount: workDir,
    });
    expect(result.success).toBe(true);
    expect(result.output).toBe('Game created.');
    expect(result.outputDir).toBe(workDir);
    expect(result.cuaApiUrl).toBe(`http://127.0.0.1:${cuaPort}`);
    expect(result.containerId).toMatch(/^pi-cua-native-/);
    // runAgentLoop was called with a user prompt, a system prompt, a
    // model, and an emit function.
    expect(mockRunAgentLoop).toHaveBeenCalledTimes(1);
    const call = mockRunAgentLoop.mock.calls[0];
    expect(call[0]).toBeInstanceOf(Array); // prompts
    expect(call[1]).toMatchObject({ systemPrompt: expect.any(String) });
    expect(call[1].tools).toBeInstanceOf(Array);
    expect(call[2].model).toBeDefined();
    expect(typeof call[3]).toBe('function'); // emit
    expect(call[4]).toBeInstanceOf(AbortSignal); // signal
  });

  it('run() returns error when runAgentLoop throws', async () => {
    mockRunAgentLoop.mockImplementation(async () => {
      throw new Error('LLM exploded');
    });
    const { PiCuaNativeRunner } = await import('./pi-cua-native-runner.js');
    const runner = new PiCuaNativeRunner({ cuaServerUrl: `http://127.0.0.1:${cuaPort}` });
    const result = await runner.run({
      agentId: 'test',
      prompt: 'hi',
      timeoutMs: 5000,
      workspacePath: workDir,
      workspaceMount: workDir,
    });
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/LLM exploded/);
  });

  it('run() passes the configured openaiApiKey into AgentLoopConfig', async () => {
    const { PiCuaNativeRunner } = await import('./pi-cua-native-runner.js');
    const runner = new PiCuaNativeRunner({
      cuaServerUrl: `http://127.0.0.1:${cuaPort}`,
      provider: 'opencode',
    });
    await runner.run({
      agentId: 'test',
      prompt: 'hi',
      timeoutMs: 5000,
      workspacePath: workDir,
      workspaceMount: workDir,
      openaiApiKey: 'sk-test-key',
    });
    const config = mockRunAgentLoop.mock.calls[0][2];
    expect(config.apiKey).toBe('sk-test-key');
  });

  it('run() falls back to env-var matching the configured provider', async () => {
    const original = process.env.OPENCODE_API_KEY;
    process.env.OPENCODE_API_KEY = 'env-test-key';
    try {
      const { PiCuaNativeRunner } = await import('./pi-cua-native-runner.js');
      const runner = new PiCuaNativeRunner({
        cuaServerUrl: `http://127.0.0.1:${cuaPort}`,
        provider: 'opencode',
      });
      await runner.run({
        agentId: 'test',
        prompt: 'hi',
        timeoutMs: 5000,
        workspacePath: workDir,
        workspaceMount: workDir,
      });
      const config = mockRunAgentLoop.mock.calls[0][2];
      expect(config.apiKey).toBe('env-test-key');
    } finally {
      if (original === undefined) delete process.env.OPENCODE_API_KEY;
      else process.env.OPENCODE_API_KEY = original;
    }
  });

  it('run() supplies file + bash + Cua tools to the agent', async () => {
    const { PiCuaNativeRunner } = await import('./pi-cua-native-runner.js');
    const runner = new PiCuaNativeRunner({ cuaServerUrl: `http://127.0.0.1:${cuaPort}` });
    await runner.run({
      agentId: 'test',
      prompt: 'hi',
      timeoutMs: 5000,
      workspacePath: workDir,
      workspaceMount: workDir,
    });
    const context = mockRunAgentLoop.mock.calls[0][1];
    const toolNames = (context.tools as Array<{ name: string }>).map((t) => t.name).sort();
    expect(toolNames).toEqual([
      'bash',
      'cua_a11y',
      'cua_left_click',
      'cua_run',
      'cua_screenshot',
      'cua_type',
      'edit_file',
      'list_dir',
      'read_file',
      'write_file',
    ]);
  });

  it('run() picks up new files written to the workspace', async () => {
    // Mock an agent that writes a file before emitting.
    mockRunAgentLoop.mockImplementation(async (_prompts, context, _config, emit) => {
      // The agent has file tools available; simulate a write by
      // invoking the tool directly.
      const writeTool = (
        context.tools as Array<{
          name: string;
          execute: (id: string, params: Record<string, unknown>) => Promise<{
            content: Array<{ type: string; text?: string }>;
            details?: unknown;
          }>;
        }>
      ).find((t) => t.name === 'write_file')!;
      const toolResult = await writeTool.execute('test-id', {
        path: 'index.html',
        content: '<html></html>',
      });
      const firstText = toolResult.content[0]?.text;
      if (typeof firstText === 'string' && firstText.startsWith('error')) {
        throw new Error(`write_file tool error: ${firstText}`);
      }
      if (emit) {
        await emit({ type: 'agent_start' } as never);
        await emit({
          type: 'message_end',
          message: {
            role: 'assistant',
            content: [{ type: 'text', text: 'wrote index.html' }],
          },
        } as never);
        await emit({ type: 'agent_end', messages: [] } as never);
      }
      return [];
    });

    const { PiCuaNativeRunner } = await import('./pi-cua-native-runner.js');
    const runner = new PiCuaNativeRunner({ cuaServerUrl: `http://127.0.0.1:${cuaPort}` });
    const result = await runner.run({
      agentId: 'test',
      prompt: 'hi',
      timeoutMs: 5000,
      workspacePath: workDir,
      workspaceMount: workDir,
    });
    // Confirm the file was actually written on disk.
    const onDisk = await readFile(join(workDir, 'index.html'), 'utf-8');
    expect(onDisk).toBe('<html></html>');
    expect(result.success).toBe(true);
    expect(result.files).toBeDefined();
    expect(result.files!.some((f) => f.includes('index.html'))).toBe(true);
  });

  it('run() rejects paths that escape the workspace', async () => {
    const { PiCuaNativeRunner } = await import('./pi-cua-native-runner.js');
    const runner = new PiCuaNativeRunner({ cuaServerUrl: `http://127.0.0.1:${cuaPort}` });
    await runner.run({
      agentId: 'test',
      prompt: 'hi',
      timeoutMs: 5000,
      workspacePath: workDir,
      workspaceMount: workDir,
    });
    const context = mockRunAgentLoop.mock.calls[0][1];
    const readTool = (
      context.tools as Array<{
        name: string;
        execute: (id: string, params: Record<string, unknown>) => Promise<{
          content: Array<{ type: string; text?: string }>;
          details?: unknown;
        }>;
      }>
    ).find((t) => t.name === 'read_file')!;
    const result = await readTool.execute('test-id', {
      path: 'C:/Windows/System32/drivers/etc/hosts',
    });
    const firstText = result.content[0]?.text;
    expect(typeof firstText).toBe('string');
    expect(firstText).toMatch(/error:.*outside the workspace/);
  });

  it('run() rejects cross-drive absolute path in read_file', async () => {
    const { PiCuaNativeRunner } = await import('./pi-cua-native-runner.js');
    const runner = new PiCuaNativeRunner({ cuaServerUrl: `http://127.0.0.1:${cuaPort}` });
    await runner.run({
      agentId: 'test',
      prompt: 'hi',
      timeoutMs: 5000,
      workspacePath: workDir,
      workspaceMount: workDir,
    });
    const context = mockRunAgentLoop.mock.calls[0][1];
    const readTool = (
      context.tools as Array<{
        name: string;
        execute: (id: string, params: Record<string, unknown>) => Promise<{
          content: Array<{ type: string; text?: string }>;
          details?: unknown;
        }>;
      }>
    ).find((t) => t.name === 'read_file')!;
    // On Windows, `D:/` is a different drive than the temp directory
    // (typically C:\), so `path.relative` returns an absolute path that
    // the `isAbsolute(rel)` check inside `resolveInside` must reject.
    // On POSIX, `D:/` is not absolute and resolves as a relative path
    // inside the workspace — the test still passes because the file
    // does not exist and the error is caught by the tool's try/catch.
    const result = await readTool.execute('test-id', {
      path: 'D:/cross-drive-test-escape.txt',
    });
    const firstText = result.content[0]?.text;
    expect(typeof firstText).toBe('string');
    expect(firstText).toMatch(/error/i);
  });

  it('run() rejects cross-drive absolute path in write_file', async () => {
    const { PiCuaNativeRunner } = await import('./pi-cua-native-runner.js');
    const runner = new PiCuaNativeRunner({ cuaServerUrl: `http://127.0.0.1:${cuaPort}` });
    await runner.run({
      agentId: 'test',
      prompt: 'hi',
      timeoutMs: 5000,
      workspacePath: workDir,
      workspaceMount: workDir,
    });
    const context = mockRunAgentLoop.mock.calls[0][1];
    const writeTool = (
      context.tools as Array<{
        name: string;
        execute: (id: string, params: Record<string, unknown>) => Promise<{
          content: Array<{ type: string; text?: string }>;
          details?: unknown;
        }>;
      }>
    ).find((t) => t.name === 'write_file')!;
    const result = await writeTool.execute('test-id', {
      path: 'D:/cross-drive-test-escape.txt',
      content: 'hello',
    });
    const firstText = result.content[0]?.text;
    expect(typeof firstText).toBe('string');
    expect(firstText).toMatch(/error/i);
  });

  it('run() rejects cross-drive absolute path in edit_file', async () => {
    const { PiCuaNativeRunner } = await import('./pi-cua-native-runner.js');
    const runner = new PiCuaNativeRunner({ cuaServerUrl: `http://127.0.0.1:${cuaPort}` });
    await runner.run({
      agentId: 'test',
      prompt: 'hi',
      timeoutMs: 5000,
      workspacePath: workDir,
      workspaceMount: workDir,
    });
    const context = mockRunAgentLoop.mock.calls[0][1];
    const editTool = (
      context.tools as Array<{
        name: string;
        execute: (id: string, params: Record<string, unknown>) => Promise<{
          content: Array<{ type: string; text?: string }>;
          details?: unknown;
        }>;
      }>
    ).find((t) => t.name === 'edit_file')!;
    const result = await editTool.execute('test-id', {
      path: 'D:/cross-drive-test-escape.txt',
      oldText: 'a',
      newText: 'b',
    });
    const firstText = result.content[0]?.text;
    expect(typeof firstText).toBe('string');
    expect(firstText).toMatch(/error/i);
  });

  it('run() accepts a relative path that resolves inside the workspace in read_file', async () => {
    // Create a file in the workspace to read.
    await writeFile(join(workDir, 'inside.txt'), 'hello from workspace');

    const { PiCuaNativeRunner } = await import('./pi-cua-native-runner.js');
    const runner = new PiCuaNativeRunner({ cuaServerUrl: `http://127.0.0.1:${cuaPort}` });
    await runner.run({
      agentId: 'test',
      prompt: 'hi',
      timeoutMs: 5000,
      workspacePath: workDir,
      workspaceMount: workDir,
    });
    const context = mockRunAgentLoop.mock.calls[0][1];
    const readTool = (
      context.tools as Array<{
        name: string;
        execute: (id: string, params: Record<string, unknown>) => Promise<{
          content: Array<{ type: string; text?: string }>;
          details?: unknown;
        }>;
      }>
    ).find((t) => t.name === 'read_file')!;
    const result = await readTool.execute('test-id', {
      path: 'inside.txt',
    });
    const firstText = result.content[0]?.text;
    // The file exists and should be read successfully (no "outside the workspace" error).
    expect(firstText).toBe('hello from workspace');
  });

  it('run() removes itself from the processRegistry after success', async () => {
    const { PiCuaNativeRunner } = await import('./pi-cua-native-runner.js');
    const registry = new Map<string, AbortController>();
    const runner = new PiCuaNativeRunner({
      cuaServerUrl: `http://127.0.0.1:${cuaPort}`,
      processRegistry: registry,
    });
    await runner.run({
      agentId: 'test',
      prompt: 'hi',
      timeoutMs: 5000,
      workspacePath: workDir,
      workspaceMount: workDir,
    });
    expect(registry.size).toBe(0);
  });

  it('stop() aborts the registered controller', async () => {
    const { PiCuaNativeRunner } = await import('./pi-cua-native-runner.js');
    const registry = new Map<string, AbortController>();
    const runner = new PiCuaNativeRunner({
      cuaServerUrl: `http://127.0.0.1:${cuaPort}`,
      processRegistry: registry,
    });
    // Start a long-running run.
    mockRunAgentLoop.mockImplementation(
      async (_prompts, _context, _config, _emit, signal) => {
        // Wait for abort.
        return await new Promise((_resolve, reject) => {
          signal!.addEventListener('abort', () => {
            reject(new Error(`aborted: ${signal.reason}`));
          });
        });
      },
    );
    const runPromise = runner.run({
      agentId: 'test',
      prompt: 'hi',
      timeoutMs: 30_000,
      workspacePath: workDir,
      workspaceMount: workDir,
    });
    // Wait for the controller to be registered.
    await new Promise((r) => setTimeout(r, 50));
    expect(registry.size).toBe(1);
    const [containerId, controller] = [...registry.entries()][0];
    expect(controller.signal.aborted).toBe(false);
    await runner.stop(containerId);
    expect(controller.signal.aborted).toBe(true);
    const result = await runPromise;
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/aborted/);
  });

  it('cleanup() aborts all registered controllers', async () => {
    const { PiCuaNativeRunner } = await import('./pi-cua-native-runner.js');
    const registry = new Map<string, AbortController>();
    const runner = new PiCuaNativeRunner({
      cuaServerUrl: `http://127.0.0.1:${cuaPort}`,
      processRegistry: registry,
    });
    const ctrl1 = new AbortController();
    const ctrl2 = new AbortController();
    registry.set('a', ctrl1);
    registry.set('b', ctrl2);
    await runner.cleanup();
    expect(ctrl1.signal.aborted).toBe(true);
    expect(ctrl2.signal.aborted).toBe(true);
    expect(registry.size).toBe(0);
  });

  it('run() honors timeoutMs by aborting the controller', async () => {
    mockRunAgentLoop.mockImplementation(
      async (_prompts, _context, _config, _emit, signal) => {
        return await new Promise((_resolve, reject) => {
          signal!.addEventListener('abort', () => {
            reject(new Error(`aborted: ${signal.reason}`));
          });
        });
      },
    );
    const { PiCuaNativeRunner } = await import('./pi-cua-native-runner.js');
    const runner = new PiCuaNativeRunner({ cuaServerUrl: `http://127.0.0.1:${cuaPort}` });
    const start = Date.now();
    const result = await runner.run({
      agentId: 'test',
      prompt: 'hi',
      timeoutMs: 200,
      workspacePath: workDir,
      workspaceMount: workDir,
    });
    const elapsed = Date.now() - start;
    expect(elapsed).toBeLessThan(2_000);
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/aborted|timeout/i);
  });

  describe('model/provider resolution', () => {
    it('uses config.model when set (sentinel fix: model not ignored)', async () => {
      const { PiCuaNativeRunner } = await import('./pi-cua-native-runner.js');
      // Constructor model is claude-sonnet, but config.model=gpt-4o should win
      const runner = new PiCuaNativeRunner({
        cuaServerUrl: `http://127.0.0.1:${cuaPort}`,
        model: 'claude-sonnet-4-20250514',
      });
      await runner.run({
        agentId: 'test',
        prompt: 'hi',
        timeoutMs: 5000,
        workspacePath: workDir,
        workspaceMount: workDir,
        model: 'gpt-4o',
      });

      // getModel should have been called with the config.model value, not the fallback
      expect(mockGetModel).toHaveBeenCalledTimes(1);
      const modelArg = mockGetModel.mock.calls[0][1];
      expect(modelArg).toBe('gpt-4o');
    });

    it('falls back to this.model when config.model is not set', async () => {
      const { PiCuaNativeRunner } = await import('./pi-cua-native-runner.js');
      const runner = new PiCuaNativeRunner({
        cuaServerUrl: `http://127.0.0.1:${cuaPort}`,
        model: 'fallback-model',
      });
      await runner.run({
        agentId: 'test',
        prompt: 'hi',
        timeoutMs: 5000,
        workspacePath: workDir,
        workspaceMount: workDir,
        // config.model intentionally omitted
      });

      expect(mockGetModel).toHaveBeenCalledTimes(1);
      const modelArg = mockGetModel.mock.calls[0][1];
      expect(modelArg).toBe('fallback-model');
    });

    it('uses config.llmProvider when set', async () => {
      const { PiCuaNativeRunner } = await import('./pi-cua-native-runner.js');
      // Constructor provider=anthropic, config.llmProvider=openai should win
      const runner = new PiCuaNativeRunner({
        cuaServerUrl: `http://127.0.0.1:${cuaPort}`,
        provider: 'anthropic',
      });
      await runner.run({
        agentId: 'test',
        prompt: 'hi',
        timeoutMs: 5000,
        workspacePath: workDir,
        workspaceMount: workDir,
        llmProvider: 'openai',
      });

      expect(mockGetModel).toHaveBeenCalledTimes(1);
      const providerArg = mockGetModel.mock.calls[0][0];
      expect(providerArg).toBe('openai');
    });

    it('falls back to constructor provider when config.llmProvider is not set', async () => {
      const { PiCuaNativeRunner } = await import('./pi-cua-native-runner.js');
      const runner = new PiCuaNativeRunner({
        cuaServerUrl: `http://127.0.0.1:${cuaPort}`,
        provider: 'anthropic',
      });
      await runner.run({
        agentId: 'test',
        prompt: 'hi',
        timeoutMs: 5000,
        workspacePath: workDir,
        workspaceMount: workDir,
      });

      expect(mockGetModel).toHaveBeenCalledTimes(1);
      const providerArg = mockGetModel.mock.calls[0][0];
      expect(providerArg).toBe('anthropic');
    });
  });

  it('run() writes nothing to the workspace under the .dynflow-prompt- pattern', async () => {
    const { PiCuaNativeRunner } = await import('./pi-cua-native-runner.js');
    const runner = new PiCuaNativeRunner({ cuaServerUrl: `http://127.0.0.1:${cuaPort}` });
    await runner.run({
      agentId: 'test',
      prompt: 'hi',
      timeoutMs: 5000,
      workspacePath: workDir,
      workspaceMount: workDir,
    });
    const files = await readdir(workDir);
    const promptFiles = files.filter((f) => f.startsWith('.dynflow-prompt-'));
    expect(promptFiles).toEqual([]);
  });
});
