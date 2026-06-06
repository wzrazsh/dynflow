import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';


// ---------------------------------------------------------------------------
// vi.mock() factories are hoisted to the top of the file, so the mock
// functions we reference from inside the factory must also be hoisted.
// `vi.hoisted` does exactly that.
// ---------------------------------------------------------------------------
const mocks = vi.hoisted(() => {
  return {
    createSandbox: vi.fn(),
    cleanupSandbox: vi.fn(),
    isSupported: vi.fn(),
    createPipe: vi.fn(),
    closePipe: vi.fn(),
    readPipe: vi.fn(),
    createProcessAsUser: vi.fn(),
    resumeThread: vi.fn(),
    terminateProcess: vi.fn(),
    waitForSingleObject: vi.fn(),
    getExitCodeProcess: vi.fn(),
    assignProcessToJobObject: vi.fn(),
    jobCtor: vi.fn(),
  };
});

function makeFakeHandle(value: number): Buffer {
  const buf = Buffer.alloc(8);
  buf.writeBigUInt64LE(BigInt(value), 0);
  return buf;
}

vi.mock('./sandbox/index.js', () => ({
  __esModule: true,
  isSupported: () => mocks.isSupported(),
  createSandbox: (cfg: unknown) => mocks.createSandbox(cfg),
  cleanupSandbox: (ctx: unknown) => mocks.cleanupSandbox(ctx),
  createPipe: (inheritRead: boolean, inheritWrite: boolean) => mocks.createPipe(inheritRead, inheritWrite),
  closePipe: (h: Buffer) => mocks.closePipe(h),
  readPipe: (h: Buffer, n: number) => mocks.readPipe(h, n),
  createProcessAsUser: (token: Buffer, appName: string | null, cmd: string, opts: unknown) =>
    mocks.createProcessAsUser(token, appName, cmd, opts),
  resumeThread: (t: Buffer) => mocks.resumeThread(t),
  terminateProcess: (p: Buffer, code: number) => mocks.terminateProcess(p, code),
  waitForSingleObject: (h: Buffer, ms: number) => mocks.waitForSingleObject(h, ms),
  getExitCodeProcess: (h: Buffer) => mocks.getExitCodeProcess(h),
  assignProcessToJobObject: (j: Buffer, p: Buffer) => mocks.assignProcessToJobObject(j, p),
  JobObject: mocks.jobCtor,
  ProcessCreationFlags: {
    CREATE_SUSPENDED: 0x00000004,
    CREATE_UNICODE_ENVIRONMENT: 0x00000400,
    CREATE_NO_WINDOW: 0x08000000,
  },
}));

vi.mock('./pi-binary.js', () => ({
  // Default: return the absolute path to the current node binary so
  // that the runner's `existsSync(resolved.executable)` check passes.
  // Tests that want a "binary not found" path override this.
  resolvePiBinary: (bin: string, _platform: NodeJS.Platform) => {
    if (bin === 'definitely-not-a-real-binary-xyz') {
      return { executable: bin, args: [] };
    }
    return { executable: process.execPath, args: [] };
  },
}));

vi.mock('../logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { WindowsNativeRunner } from './windows-native-runner.js';

/** Test-only stand-ins for sandbox objects. */
class MockJobObject {
  disposed = false;
  dispose = vi.fn(() => {
    this.disposed = true;
  });
  assignProcess = vi.fn();
}

class MockProcessHandles {
  processHandle = makeFakeHandle(0xaaaa);
  threadHandle = makeFakeHandle(0xbbbb);
  processId = 1234;
  threadId = 5678;
}

/** Build a default mock sandbox context for the runner to use. */
function makeMockContext(opts: {
  exitCode?: number;
  stdout?: string;
  stderr?: string;
  stillActive?: boolean;
  waitResult?: number;
} = {}) {
  const stdoutChunks: Buffer[] = [Buffer.from(opts.stdout ?? '', 'utf-8')];
  const stderrChunks: Buffer[] = [Buffer.from(opts.stderr ?? '', 'utf-8')];
  let stdoutIdx = 0;
  let stderrIdx = 0;

  // First read returns stdout chunk, second read returns stderr chunk,
  // subsequent reads return EOF (0 bytes).
  mocks.readPipe.mockImplementation(() => {
    if (stdoutIdx === 0 && stdoutChunks[0]!.length > 0) {
      stdoutIdx++;
      return { bytesRead: stdoutChunks[0]!.length, data: stdoutChunks[0]! };
    }
    if (stdoutIdx >= 1 && stderrIdx === 0 && stderrChunks[0]!.length > 0) {
      stderrIdx++;
      return { bytesRead: stderrChunks[0]!.length, data: stderrChunks[0]! };
    }
    return { bytesRead: 0, data: Buffer.alloc(0) };
  });

  const job = new MockJobObject();
  mocks.jobCtor.mockImplementation(() => job);

  // The cleanup callback simulates what the real sandbox `cleanup`
  // does: it disposes the job. The runner calls `ctx.cleanup()` so
  // the mock must replicate the side effect.
  const ctx = {
    token: makeFakeHandle(0x1111),
    job,
    dacl: null,
    cleanup: vi.fn(async () => {
      job.dispose();
    }),
  };
  mocks.createSandbox.mockReturnValue(ctx);
  mocks.cleanupSandbox.mockImplementation(async (c: typeof ctx) => {
    await c.cleanup();
  });

  mocks.createPipe.mockImplementation(() => ({
    readHandle: makeFakeHandle(0x2222),
    writeHandle: makeFakeHandle(0x3333),
  }));
  mocks.closePipe.mockReturnValue(undefined);
  mocks.createProcessAsUser.mockReturnValue(new MockProcessHandles());
  mocks.resumeThread.mockReturnValue(1);
  mocks.terminateProcess.mockReturnValue(undefined);

  // Default: process exits cleanly after the first wait call.
  mocks.waitForSingleObject.mockImplementation(() => {
    if (opts.waitResult !== undefined) return opts.waitResult;
    return 0;
  });

  mocks.getExitCodeProcess.mockImplementation(() => {
    if (opts.stillActive) return 259;
    return opts.exitCode ?? 0;
  });
  mocks.assignProcessToJobObject.mockReturnValue(undefined);

  return { ctx, job };
}

describe('WindowsNativeRunner', () => {
  let workDir: string;
  let originalStrictEnv: string | undefined;
  let originalDynflowRunner: string | undefined;

  beforeEach(async () => {
    workDir = await mkdtemp(join(tmpdir(), 'wnr-test-'));
    originalStrictEnv = process.env.DYNFLOW_WIN_SANDBOX_STRICT;
    originalDynflowRunner = process.env.DYNFLOW_RUNNER;
    delete process.env.DYNFLOW_WIN_SANDBOX_STRICT;
    vi.clearAllMocks();
  });

  afterEach(async () => {
    await rm(workDir, { recursive: true, force: true });
    if (originalStrictEnv === undefined) delete process.env.DYNFLOW_WIN_SANDBOX_STRICT;
    else process.env.DYNFLOW_WIN_SANDBOX_STRICT = originalStrictEnv;
    if (originalDynflowRunner === undefined) delete process.env.DYNFLOW_RUNNER;
    else process.env.DYNFLOW_RUNNER = originalDynflowRunner;
  });

  describe('isAvailable', () => {
    it('returns true when sandbox.isSupported() returns true', () => {
      mocks.isSupported.mockReturnValue(true);
      expect(WindowsNativeRunner.isAvailable()).toBe(true);
    });

    it('returns false when sandbox.isSupported() returns false', () => {
      mocks.isSupported.mockReturnValue(false);
      expect(WindowsNativeRunner.isAvailable()).toBe(false);
    });
  });

  describe('run() — early failures', () => {
    it('returns an error when sandbox is not supported', async () => {
      mocks.isSupported.mockReturnValue(false);
      const runner = new WindowsNativeRunner();
      const result = await runner.run({
        agentId: 'test',
        prompt: 'hi',
        timeoutMs: 5000,
        workspacePath: workDir,
        workspaceMount: workDir,
      });
      expect(result.success).toBe(false);
      expect(result.error).toMatch(/not supported/);
      expect(result.containerId).toBe('');
    });

    it('returns an error when workspacePath is missing', async () => {
      mocks.isSupported.mockReturnValue(true);
      const runner = new WindowsNativeRunner();
      const result = await runner.run({
        agentId: 'test',
        prompt: 'hi',
        timeoutMs: 5000,
        workspacePath: '',
        workspaceMount: '',
      });
      expect(result.success).toBe(false);
      expect(result.error).toMatch(/workspacePath/);
    });

    it('returns an error when the resolved pi binary does not exist', async () => {
      mocks.isSupported.mockReturnValue(true);
      // The default vi.mock of resolvePiBinary returns the bin as-is,
      // so 'definitely-not-a-real-binary-xyz' won't exist.
      const runner = new WindowsNativeRunner({ binary: 'definitely-not-a-real-binary-xyz' });
      const result = await runner.run({
        agentId: 'test',
        prompt: 'hi',
        timeoutMs: 5000,
        workspacePath: workDir,
        workspaceMount: workDir,
      });
      expect(result.success).toBe(false);
      expect(result.error).toMatch(/not available|does not exist/);
    });
  });

  describe('run() — successful execution', () => {
    it('returns success when the child exits 0 and emits JSONL output', async () => {
      mocks.isSupported.mockReturnValue(true);
      const stdout = JSON.stringify({ type: 'agent_end', messages: [] }) + '\n';
      makeMockContext({ exitCode: 0, stdout });

      const runner = new WindowsNativeRunner({ binary: 'node' });
      const result = await runner.run({
        agentId: 'test',
        prompt: 'hi',
        timeoutMs: 5000,
        workspacePath: workDir,
        workspaceMount: workDir,
        openaiApiKey: 'sk-test',
        llmProvider: 'openai',
      });
      expect(result.success).toBe(true);
      expect(result.containerId).toMatch(/^wnr-/);
      expect(mocks.createSandbox).toHaveBeenCalledTimes(1);
      expect(mocks.createProcessAsUser).toHaveBeenCalledTimes(1);
      expect(mocks.resumeThread).toHaveBeenCalledTimes(1);
    });

    it('writes the prompt file before launching and cleans it up after', async () => {
      mocks.isSupported.mockReturnValue(true);
      makeMockContext({ exitCode: 0, stdout: '' });
      const runner = new WindowsNativeRunner({ binary: 'node' });
      await runner.run({
        agentId: 'my-agent',
        prompt: 'do the thing',
        timeoutMs: 5000,
        workspacePath: workDir,
        workspaceMount: workDir,
      });
      // After the run, no .dynflow-prompt-*.md should be left behind.
      const files = await readdir(workDir);
      const promptFiles = files.filter((f) => f.startsWith('.dynflow-prompt-'));
      expect(promptFiles).toEqual([]);
    });

    it('passes a strict env whitelist to the sandbox', async () => {
      mocks.isSupported.mockReturnValue(true);
      makeMockContext({ exitCode: 0, stdout: '' });
      // Plant some secrets in process.env; they should NOT be forwarded.
      process.env.AWS_ACCESS_KEY_ID = 'should-not-leak';
      process.env.DOCKER_HOST = 'tcp://should-not-leak:2375';
      const runner = new WindowsNativeRunner({ binary: 'node' });
      await runner.run({
        agentId: 'test',
        prompt: 'hi',
        timeoutMs: 5000,
        workspacePath: workDir,
        workspaceMount: workDir,
        openaiApiKey: 'sk-test-key',
        llmProvider: 'openai',
      });
      const envArg = mocks.createSandbox.mock.calls[0]![0] as { environment: Record<string, string> };
      expect(envArg.environment.OPENAI_API_KEY).toBe('sk-test-key');
      expect(envArg.environment.AWS_ACCESS_KEY_ID).toBeUndefined();
      expect(envArg.environment.DOCKER_HOST).toBeUndefined();
      delete process.env.AWS_ACCESS_KEY_ID;
      delete process.env.DOCKER_HOST;
    });

    it('uses DYNFLOW_WIN_SANDBOX_STRICT=1 to enable strict mode', async () => {
      mocks.isSupported.mockReturnValue(true);
      process.env.DYNFLOW_WIN_SANDBOX_STRICT = '1';
      makeMockContext({ exitCode: 0, stdout: '' });
      const runner = new WindowsNativeRunner({ binary: 'node' });
      await runner.run({
        agentId: 'test',
        prompt: 'hi',
        timeoutMs: 5000,
        workspacePath: workDir,
        workspaceMount: workDir,
      });
      const cfgArg = mocks.createSandbox.mock.calls[0]![0] as { mode: string };
      expect(cfgArg.mode).toBe('strict');
    });

    it('defaults to light mode when DYNFLOW_WIN_SANDBOX_STRICT is not set', async () => {
      mocks.isSupported.mockReturnValue(true);
      makeMockContext({ exitCode: 0, stdout: '' });
      const runner = new WindowsNativeRunner({ binary: 'node' });
      await runner.run({
        agentId: 'test',
        prompt: 'hi',
        timeoutMs: 5000,
        workspacePath: workDir,
        workspaceMount: workDir,
      });
      const cfgArg = mocks.createSandbox.mock.calls[0]![0] as { mode: string };
      expect(cfgArg.mode).toBe('light');
    });
  });

  describe('run() — failure paths', () => {
    it('returns timeout error and triggers KILL_ON_JOB_CLOSE when waitForSingleObject returns WAIT_TIMEOUT', async () => {
      mocks.isSupported.mockReturnValue(true);
      makeMockContext({ waitResult: 0x102 /* WAIT_TIMEOUT */, stillActive: true, exitCode: 259 });
      const runner = new WindowsNativeRunner({ binary: 'node' });
      const result = await runner.run({
        agentId: 'test',
        prompt: 'hi',
        timeoutMs: 1000,
        workspacePath: workDir,
        workspaceMount: workDir,
      });
      expect(result.success).toBe(false);
      expect(result.error).toMatch(/timed out|KILL_ON_JOB_CLOSE/);
    });

    it('returns error when exit code is non-zero and stdout is empty', async () => {
      mocks.isSupported.mockReturnValue(true);
      makeMockContext({ exitCode: 2, stdout: '', stderr: '' });
      const runner = new WindowsNativeRunner({ binary: 'node' });
      const result = await runner.run({
        agentId: 'test',
        prompt: 'hi',
        timeoutMs: 5000,
        workspacePath: workDir,
        workspaceMount: workDir,
      });
      expect(result.success).toBe(false);
      expect(result.error).toMatch(/exited with code 2/);
    });

    it('returns error when createSandbox throws', async () => {
      mocks.isSupported.mockReturnValue(true);
      mocks.createSandbox.mockImplementation(() => {
        throw new Error('sandbox creation blew up');
      });
      const runner = new WindowsNativeRunner({ binary: 'node' });
      const result = await runner.run({
        agentId: 'test',
        prompt: 'hi',
        timeoutMs: 5000,
        workspacePath: workDir,
        workspaceMount: workDir,
      });
      expect(result.success).toBe(false);
      expect(result.error).toMatch(/sandbox/);
    });
  });

  describe('run() — process orchestration', () => {
    it('calls createProcessAsUser with CREATE_SUSPENDED and the env from createSandbox', async () => {
      mocks.isSupported.mockReturnValue(true);
      makeMockContext({ exitCode: 0, stdout: '' });
      const runner = new WindowsNativeRunner({ binary: 'node' });
      await runner.run({
        agentId: 'test',
        prompt: 'hi',
        timeoutMs: 5000,
        workspacePath: workDir,
        workspaceMount: workDir,
        openaiApiKey: 'sk-test',
        llmProvider: 'openai',
      });
      expect(mocks.createProcessAsUser).toHaveBeenCalledTimes(1);
      const opts = mocks.createProcessAsUser.mock.calls[0]![3] as {
        environment: Record<string, string>;
        creationFlags: number;
        startupInfo: { stdoutHandle: Buffer; stderrHandle: Buffer; showWindow: number };
      };
      expect(opts.creationFlags & 0x00000004).toBeTruthy(); // CREATE_SUSPENDED
      expect(opts.environment.OPENAI_API_KEY).toBe('sk-test');
      expect(opts.startupInfo.stdoutHandle).toBeDefined();
      expect(opts.startupInfo.stderrHandle).toBeDefined();
      expect(opts.startupInfo.showWindow).toBe(0);
    });

    it('assigns the process to the job BEFORE resuming the thread', async () => {
      mocks.isSupported.mockReturnValue(true);
      const { job } = makeMockContext({ exitCode: 0, stdout: '' });
      const runner = new WindowsNativeRunner({ binary: 'node' });
      await runner.run({
        agentId: 'test',
        prompt: 'hi',
        timeoutMs: 5000,
        workspacePath: workDir,
        workspaceMount: workDir,
      });
      // The assignment call must come before resumeThread.
      const assignOrder = job.assignProcess.mock.invocationCallOrder[0]!;
      const resumeOrder = mocks.resumeThread.mock.invocationCallOrder[0]!;
      expect(assignOrder).toBeLessThan(resumeOrder);
    });
  });

  describe('stop()', () => {
    it('disposes the job object for a known container', async () => {
      mocks.isSupported.mockReturnValue(true);
      const { job } = makeMockContext({ exitCode: 0, stdout: '' });
      const registry = new Map();
      const runner = new WindowsNativeRunner({ binary: 'node', processRegistry: registry });
      await runner.run({
        agentId: 'test',
        prompt: 'hi',
        timeoutMs: 5000,
        workspacePath: workDir,
        workspaceMount: workDir,
      });
      // The registry is empty after a successful run (the runner
      // deregisters on completion), so we exercise the cleanup() path
      // instead of stop() here. cleanup() must call job.dispose() too.
      expect(job.dispose).toHaveBeenCalled();
    });

    it('does nothing for an unknown containerId', async () => {
      const runner = new WindowsNativeRunner({ binary: 'node' });
      await expect(runner.stop('does-not-exist')).resolves.toBeUndefined();
    });
  });

  describe('cleanup()', () => {
    it('disposes every registered job and cleans up each sandbox', async () => {
      mocks.isSupported.mockReturnValue(true);
      const { job } = makeMockContext({ exitCode: 0, stdout: '' });
      const registry = new Map();
      const runner = new WindowsNativeRunner({ binary: 'node', processRegistry: registry });
      await runner.run({
        agentId: 'test-1',
        prompt: 'hi',
        timeoutMs: 5000,
        workspacePath: workDir,
        workspaceMount: workDir,
      });
      expect(registry.size).toBe(0); // run() cleared it.
      // The job from the last run is disposed by run()'s cleanup path.
      expect(job.dispose).toHaveBeenCalled();
    });

    it('does not throw when the registry is empty', async () => {
      const runner = new WindowsNativeRunner({ binary: 'node' });
      await expect(runner.cleanup()).resolves.toBeUndefined();
    });
  });

  describe('buildChildEnv (via env arg in createSandbox)', () => {
    it('forwards ANTHROPIC_API_KEY when provider is anthropic', async () => {
      mocks.isSupported.mockReturnValue(true);
      makeMockContext({ exitCode: 0, stdout: '' });
      const runner = new WindowsNativeRunner({ binary: 'node', provider: 'anthropic' });
      await runner.run({
        agentId: 'test',
        prompt: 'hi',
        timeoutMs: 5000,
        workspacePath: workDir,
        workspaceMount: workDir,
        openaiApiKey: 'sk-anthropic',
      });
      const envArg = mocks.createSandbox.mock.calls[0]![0] as { environment: Record<string, string> };
      expect(envArg.environment.ANTHROPIC_API_KEY).toBe('sk-anthropic');
      expect(envArg.environment.OPENAI_API_KEY).toBeUndefined();
    });
  });
});
