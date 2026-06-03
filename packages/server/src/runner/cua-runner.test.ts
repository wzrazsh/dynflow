import { describe, it, expect, vi, beforeEach } from 'vitest';
import { CuaAgentRunner } from './cua-runner.js';

const { execSyncMock, execAsyncMock } = vi.hoisted(() => ({
  execSyncMock: vi.fn(),
  execAsyncMock: vi.fn(),
}));

vi.mock('node:child_process', () => ({
  execSync: (...args: unknown[]) => execSyncMock(...args),
  exec: vi.fn(),
}));

vi.mock('node:util', () => ({
  promisify: () => execAsyncMock,
}));

vi.mock('node:fs/promises', () => ({
  mkdir: vi.fn().mockResolvedValue(undefined),
  writeFile: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('./pi-output-parser.js', () => ({
  parsePiJsonLines: vi.fn().mockReturnValue({ success: true, lastText: 'done', error: undefined }),
}));

vi.mock('./workspace-scanner.js', () => ({
  scanWorkspaceChanges: vi.fn().mockResolvedValue({ list: [], count: 0, size: 0 }),
}));

vi.mock('./prompt-builder.js', () => ({
  buildPiPrompt: vi.fn().mockReturnValue('# full prompt'),
}));

describe('CuaAgentRunner — basic checks', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('uses the configured image or the default', () => {
    const r1 = new CuaAgentRunner();
    expect(r1['image']).toBe('dynflow-cua-pi:latest');

    const r2 = new CuaAgentRunner({ image: 'custom:latest' });
    expect(r2['image']).toBe('custom:latest');
  });

  it('reads image from env var DYNFLOW_CUA_IMAGE', () => {
    const original = process.env.DYNFLOW_CUA_IMAGE;
    process.env.DYNFLOW_CUA_IMAGE = 'env-image:v1';
    try {
      const r = new CuaAgentRunner();
      expect(r['image']).toBe('env-image:v1');
    } finally {
      if (original === undefined) delete process.env.DYNFLOW_CUA_IMAGE;
      else process.env.DYNFLOW_CUA_IMAGE = original;
    }
  });

  it('isAvailable returns true when docker info succeeds', () => {
    execSyncMock.mockReturnValue(Buffer.from(''));
    expect(CuaAgentRunner.isAvailable()).toBe(true);
  });

  it('isAvailable returns false when docker info throws', () => {
    execSyncMock.mockImplementation(() => {
      throw new Error('docker not found');
    });
    expect(CuaAgentRunner.isAvailable()).toBe(false);
  });
});

describe('CuaAgentRunner — run() with --model/--provider flags', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // isAvailable() returns true
    execSyncMock.mockReturnValue(Buffer.from(''));
    // After clearAllMocks, re-mock execAsyncMock so it returns the expected shape
    execAsyncMock.mockResolvedValue({ stdout: '' });
  });

  const baseConfig = {
    agentId: 'test',
    prompt: 'do something',
    timeoutMs: 30000,
    workspacePath: '/tmp/test-workspace',
    workspaceMount: '/home/cua/workspace',
  };

  const testTimeout = 30000;

  it('includes --model flag when config.model is set', async () => {
    execAsyncMock.mockResolvedValue({ stdout: '' });

    const runner = new CuaAgentRunner({ noVncPort: 6901, cuaApiPort: 8001 });
    await runner.run({ ...baseConfig, model: 'gpt-4' });

    // First call = startContainer (docker run), second = pi command (docker exec)
    const execCall = execAsyncMock.mock.calls[1][0] as string;
    expect(execCall).toContain('--model gpt-4');
  }, testTimeout);

  it('includes --provider flag when config.llmProvider is set', async () => {
    execAsyncMock.mockResolvedValue({ stdout: '' });

    const runner = new CuaAgentRunner({ noVncPort: 6901, cuaApiPort: 8001 });
    await runner.run({ ...baseConfig, llmProvider: 'opencode' });

    const execCall = execAsyncMock.mock.calls[1][0] as string;
    expect(execCall).toContain('--provider opencode');
  }, testTimeout);

  it('includes both --model and --provider when both are set', async () => {
    execAsyncMock.mockResolvedValue({ stdout: '' });

    const runner = new CuaAgentRunner({ noVncPort: 6901, cuaApiPort: 8001 });
    await runner.run({ ...baseConfig, model: 'gpt-4', llmProvider: 'opencode' });

    const execCall = execAsyncMock.mock.calls[1][0] as string;
    expect(execCall).toContain('--model gpt-4');
    expect(execCall).toContain('--provider opencode');
  }, testTimeout);

  it('does NOT include --model or --provider when neither is set (backward compat)', async () => {
    execAsyncMock.mockResolvedValue({ stdout: '' });

    const runner = new CuaAgentRunner({ noVncPort: 6901, cuaApiPort: 8001 });
    await runner.run(baseConfig);

    const execCall = execAsyncMock.mock.calls[1][0] as string;
    expect(execCall).not.toContain('--model');
    expect(execCall).not.toContain('--provider');
    expect(execCall).toContain('pi --mode json --no-session');
  }, testTimeout);
});
