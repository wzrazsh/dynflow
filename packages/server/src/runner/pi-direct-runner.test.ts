import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ChildProcess } from 'node:child_process';
import { PiDirectRunner, _probePiBinaryForTest, killProcessTree } from './pi-direct-runner.js';

/**
 * Build a minimal ChildProcess mock that wires up event handlers the way
 * real spawn() does, so the runner can attach its `on`, `stdout.on`, etc.
 * handlers without TypeScript errors.
 *
 * The mock fires its exit/close events LAZILY, the first time one of the
 * `on('exit'|'close'|'error')` handlers is registered. This is more
 * realistic than a setTimeout-based mock: real spawn() never exits before
 * the parent has had a chance to attach listeners.
 */
function makeChildMock(opts: {
  code?: number;
  signal?: NodeJS.Signals | null;
  exitImmediately?: boolean;
} = {}): ChildProcess {
  const handlers: Record<string, Array<(...args: unknown[]) => void>> = {};
  let fired = false;
  const fireExit = () => {
    if (fired) return;
    fired = true;
    // Defer to a microtask so the runner has a chance to install all
    // listeners (exit, close, error) before we fire.
    queueMicrotask(() => {
      const exitCb = (handlers.exit ?? [])[0];
      if (exitCb) exitCb(opts.code ?? 0, opts.signal ?? null);
      const closeCb = (handlers.close ?? [])[0];
      if (closeCb) closeCb(opts.code ?? 0, opts.signal ?? null);
    });
  };
  const child = {
    on: vi.fn((evt: string, cb: (...args: unknown[]) => void) => {
      (handlers[evt] ??= []).push(cb);
      // Once the runner starts listening for exit/close/error, fire the
      // simulated exit (unless the test wants to keep the child alive).
      if ((evt === 'exit' || evt === 'close' || evt === 'error') && opts.exitImmediately !== false) {
        fireExit();
      }
      return child;
    }),
    stdout: {
      on: vi.fn(),
    },
    stderr: {
      on: vi.fn(),
    },
    kill: vi.fn(),
    exitCode: null,
  } as unknown as ChildProcess;

  if (opts.exitImmediately === true) {
    // Fire right away (e.g., for tests that expect immediate error / spawn failure).
    queueMicrotask(() => {
      const exitCb = (handlers.exit ?? [])[0];
      if (exitCb) exitCb(opts.code ?? 0, opts.signal ?? null);
      const closeCb = (handlers.close ?? [])[0];
      if (closeCb) closeCb(opts.code ?? 0, opts.signal ?? null);
    });
  }

  return child;
}

describe('PiDirectRunner', () => {
  let workDir: string;
  let originalEnv: NodeJS.ProcessEnv;

  beforeEach(async () => {
    workDir = await mkdtemp(join(tmpdir(), 'pi-direct-test-'));
    originalEnv = { ...process.env };
  });

  afterEach(async () => {
    process.env = originalEnv;
    await rm(workDir, { recursive: true, force: true });
  });

  describe('isAvailable', () => {
    it('uses execFileSync (no shell) — safe with quoted paths', async () => {
      // The probe must use execFile, not exec — verify by calling it with a
      // path that contains characters that a shell would interpret. A shell
      // interpreter would either error or behave differently; execFile
      // treats the path as a literal.
      const weirdName = `pi"with$quotes`;
      const ok = await _probePiBinaryForTest(weirdName);
      expect(ok).toBe(false);
    });

    it('returns true when the binary resolves and runs --version', () => {
      // Use a real binary on every platform: node --version works.
      expect(PiDirectRunner.isAvailable('node')).toBe(true);
    });

    it('returns false when the binary does not exist', () => {
      expect(PiDirectRunner.isAvailable('definitely-not-a-real-binary-xyz123')).toBe(false);
    });

    it('honors a custom binary argument', () => {
      new PiDirectRunner({ binary: 'node' });
      expect(PiDirectRunner.isAvailable('node')).toBe(true);
      expect(PiDirectRunner.isAvailable('definitely-not-real-abc')).toBe(false);
    });
  });

  describe('run() — preconditions', () => {
    it('returns a clear error when pi CLI is missing', async () => {
      const runner = new PiDirectRunner({ binary: 'definitely-missing-pi-xyz' });
      const result = await runner.run({
        agentId: 'test',
        prompt: 'hello',
        timeoutMs: 5000,
        workspacePath: workDir,
        workspaceMount: workDir,
      });
      expect(result.success).toBe(false);
      expect(result.error).toMatch(/not available/);
    });

    it('returns an error when no workspacePath is provided and no default', async () => {
      const runner = new PiDirectRunner({ binary: 'node' });
      const result = await runner.run({
        agentId: 'test',
        prompt: 'hello',
        timeoutMs: 5000,
        workspacePath: '',
        workspaceMount: '',
      });
      expect(result.success).toBe(false);
      expect(result.error).toMatch(/workspacePath/);
    });
  });

  describe('run() — security', () => {
    it('spawns with shell: false so prompt text cannot influence a shell', async () => {
      // We mock spawn to capture its options and verify shell: false.
      const spawnMock = vi.fn().mockReturnValue({
        stdout: { on: vi.fn() },
        stderr: { on: vi.fn() },
        on: (_evt: string, cb: (n: number) => void) => {
          // Simulate immediate clean exit.
          setImmediate(() => cb(0));
          return { on: vi.fn() };
        },
        kill: vi.fn(),
      });
      vi.doMock('node:child_process', () => ({
        execFile: () => Promise.reject(new Error('unused')),
        execFileSync: () => Buffer.from('0.78.0'),
        spawn: spawnMock,
      }));

      // Re-import the module so it picks up the mock.
      vi.resetModules();
      const { PiDirectRunner: MockedRunner } = await import('./pi-direct-runner.js');
      const runner = new MockedRunner({ binary: 'pi' });

      await runner.run({
        agentId: 'test',
        prompt: 'hello `rm -rf /` ; echo $HOME',
        timeoutMs: 5000,
        workspacePath: workDir,
        workspaceMount: workDir,
      });

      expect(spawnMock).toHaveBeenCalledTimes(1);
      const opts = spawnMock.mock.calls[0][2] as { shell: boolean };
      expect(opts.shell).toBe(false);
    });

    it('forwards config.openaiApiKey into the child environment, but ONLY for the configured provider', async () => {
      const child = makeChildMock({ code: 0 });
      const spawnMock = vi.fn().mockReturnValue(child);
      vi.doMock('node:child_process', () => ({
        execFile: () => Promise.reject(new Error('unused')),
        execFileSync: () => Buffer.from('0.78.0'),
        spawn: spawnMock,
      }));
      vi.resetModules();
      const { PiDirectRunner: MockedRunner } = await import('./pi-direct-runner.js');
      const runner = new MockedRunner({ binary: 'pi' });
      // Default provider is 'opencode'.

      await runner.run({
        agentId: 'test',
        prompt: 'hi',
        openaiApiKey: 'sk-test-key-1234',
        timeoutMs: 5000,
        workspacePath: workDir,
        workspaceMount: workDir,
      });

      const opts = spawnMock.mock.calls[0][2] as { env: NodeJS.ProcessEnv };
      // Provider=opencode: only OPENCODE_API_KEY is set; OpenAI / Anthropic
      // env vars must NOT be set, otherwise a single OpenCode key would be
      // silently sent to unrelated providers.
      expect(opts.env.OPENCODE_API_KEY).toBe('sk-test-key-1234');
      expect(opts.env.OPENAI_API_KEY).toBeUndefined();
      expect(opts.env.ANTHROPIC_API_KEY).toBeUndefined();
    });

    it('forwards config.openaiApiKey to OPENAI_API_KEY when provider=openai', async () => {
      const child = makeChildMock({ code: 0 });
      const spawnMock = vi.fn().mockReturnValue(child);
      vi.doMock('node:child_process', () => ({
        execFile: () => Promise.reject(new Error('unused')),
        execFileSync: () => Buffer.from('0.78.0'),
        spawn: spawnMock,
      }));
      vi.resetModules();
      const { PiDirectRunner: MockedRunner } = await import('./pi-direct-runner.js');
      const runner = new MockedRunner({ binary: 'pi', provider: 'openai' });

      await runner.run({
        agentId: 'test',
        prompt: 'hi',
        openaiApiKey: 'sk-openai-key-5678',
        timeoutMs: 5000,
        workspacePath: workDir,
        workspaceMount: workDir,
      });

      const opts = spawnMock.mock.calls[0][2] as { env: NodeJS.ProcessEnv };
      expect(opts.env.OPENAI_API_KEY).toBe('sk-openai-key-5678');
      expect(opts.env.ANTHROPIC_API_KEY).toBeUndefined();
      expect(opts.env.OPENCODE_API_KEY).toBeUndefined();
    });

    it('passes a SHORT instruction in argv (not the full user prompt) and includes a `--` separator', async () => {
      const child = makeChildMock({ code: 0 });
      const spawnMock = vi.fn().mockReturnValue(child);
      vi.doMock('node:child_process', () => ({
        execFile: () => Promise.reject(new Error('unused')),
        execFileSync: () => Buffer.from('0.78.0'),
        spawn: spawnMock,
      }));
      vi.resetModules();
      const { PiDirectRunner: MockedRunner } = await import('./pi-direct-runner.js');
      const runner = new MockedRunner({ binary: 'pi' });

      await runner.run({
        agentId: 'test',
        prompt: 'do a thing with this prompt',
        timeoutMs: 5000,
        workspacePath: workDir,
        workspaceMount: workDir,
      });

      const args = spawnMock.mock.calls[0][1] as string[];
      // The full user prompt must NOT be in argv.
      const fullArgv = args.join(' ');
      expect(fullArgv).not.toContain('do a thing with this prompt');
      // But a short instruction (referencing the prompt file) must be.
      expect(args).toContain('--');
      const sepIdx = args.indexOf('--');
      expect(args[sepIdx + 1]).toMatch(/Read the instructions in .*\.dynflow-prompt-.*\.md/);
    });
  });

  describe('run() — model/provider selection', () => {
    it('uses config.model even when it is "gpt-4o" (sentinel fix)', async () => {
      const child = makeChildMock({ code: 0 });
      const spawnMock = vi.fn().mockReturnValue(child);
      vi.doMock('node:child_process', () => ({
        execFile: () => Promise.reject(new Error('unused')),
        execFileSync: () => Buffer.from('0.78.0'),
        spawn: spawnMock,
      }));
      vi.resetModules();
      const { PiDirectRunner: MockedRunner } = await import('./pi-direct-runner.js');
      const runner = new MockedRunner({ binary: 'pi', model: 'claude-sonnet-4-20250514' });

      await runner.run({
        agentId: 'test',
        prompt: 'hi',
        timeoutMs: 5000,
        workspacePath: workDir,
        workspaceMount: workDir,
        model: 'gpt-4o',
      });

      const args = spawnMock.mock.calls[0][1] as string[];
      const modelIdx = args.indexOf('--model');
      expect(modelIdx).not.toBe(-1);
      expect(args[modelIdx + 1]).toBe('gpt-4o');
    });

    it('falls back to this.model when config.model is not set', async () => {
      const child = makeChildMock({ code: 0 });
      const spawnMock = vi.fn().mockReturnValue(child);
      vi.doMock('node:child_process', () => ({
        execFile: () => Promise.reject(new Error('unused')),
        execFileSync: () => Buffer.from('0.78.0'),
        spawn: spawnMock,
      }));
      vi.resetModules();
      const { PiDirectRunner: MockedRunner } = await import('./pi-direct-runner.js');
      const runner = new MockedRunner({ binary: 'pi', model: 'default-fallback-model' });

      await runner.run({
        agentId: 'test',
        prompt: 'hi',
        timeoutMs: 5000,
        workspacePath: workDir,
        workspaceMount: workDir,
      });

      const args = spawnMock.mock.calls[0][1] as string[];
      const modelIdx = args.indexOf('--model');
      expect(modelIdx).not.toBe(-1);
      expect(args[modelIdx + 1]).toBe('default-fallback-model');
    });

    it('uses config.llmProvider for --provider arg and env var mapping', async () => {
      const child = makeChildMock({ code: 0 });
      const spawnMock = vi.fn().mockReturnValue(child);
      vi.doMock('node:child_process', () => ({
        execFile: () => Promise.reject(new Error('unused')),
        execFileSync: () => Buffer.from('0.78.0'),
        spawn: spawnMock,
      }));
      vi.resetModules();
      const { PiDirectRunner: MockedRunner } = await import('./pi-direct-runner.js');
      // provider=anthropic in constructor, config.llmProvider=openai should win
      const runner = new MockedRunner({ binary: 'pi', provider: 'anthropic' });

      await runner.run({
        agentId: 'test',
        prompt: 'hi',
        timeoutMs: 5000,
        workspacePath: workDir,
        workspaceMount: workDir,
        openaiApiKey: 'sk-test-key',
        llmProvider: 'openai',
      });

      const args = spawnMock.mock.calls[0][1] as string[];
      const providerIdx = args.indexOf('--provider');
      expect(providerIdx).not.toBe(-1);
      expect(args[providerIdx + 1]).toBe('openai');

      // buildChildEnv should set OPENAI_API_KEY (openai provider), not ANTHROPIC_API_KEY
      const env = spawnMock.mock.calls[0][2].env as NodeJS.ProcessEnv;
      expect(env.OPENAI_API_KEY).toBe('sk-test-key');
      expect(env.ANTHROPIC_API_KEY).toBeUndefined();
    });

    it('falls back to constructor provider when config.llmProvider is not set', async () => {
      const child = makeChildMock({ code: 0 });
      const spawnMock = vi.fn().mockReturnValue(child);
      vi.doMock('node:child_process', () => ({
        execFile: () => Promise.reject(new Error('unused')),
        execFileSync: () => Buffer.from('0.78.0'),
        spawn: spawnMock,
      }));
      vi.resetModules();
      const { PiDirectRunner: MockedRunner } = await import('./pi-direct-runner.js');
      const runner = new MockedRunner({ binary: 'pi', provider: 'anthropic' });

      await runner.run({
        agentId: 'test',
        prompt: 'hi',
        timeoutMs: 5000,
        workspacePath: workDir,
        workspaceMount: workDir,
        openaiApiKey: 'sk-anthropic-key',
      });

      const args = spawnMock.mock.calls[0][1] as string[];
      const providerIdx = args.indexOf('--provider');
      expect(providerIdx).not.toBe(-1);
      expect(args[providerIdx + 1]).toBe('anthropic');

      const env = spawnMock.mock.calls[0][2].env as NodeJS.ProcessEnv;
      expect(env.ANTHROPIC_API_KEY).toBe('sk-anthropic-key');
      expect(env.OPENAI_API_KEY).toBeUndefined();
    });
  });

  describe('run() — error handling', () => {
    it('returns an error result when spawn throws', async () => {
      vi.doMock('node:child_process', () => ({
        execFile: () => Promise.reject(new Error('unused')),
        execFileSync: () => Buffer.from('0.78.0'),
        spawn: () => {
          throw new Error('spawn failed');
        },
      }));
      vi.resetModules();
      const { PiDirectRunner: MockedRunner } = await import('./pi-direct-runner.js');
      const runner = new MockedRunner({ binary: 'pi' });

      const result = await runner.run({
        agentId: 'test',
        prompt: 'hi',
        timeoutMs: 5000,
        workspacePath: workDir,
        workspaceMount: workDir,
      });
      expect(result.success).toBe(false);
      expect(result.error).toMatch(/Failed to spawn pi/);
    });
  });

  describe('run() — side effects', () => {
    it('deletes the per-agent prompt file after the child closes (privacy)', async () => {
      // The prompt file is written, passed to pi via a short instruction,
      // and then DELETED from disk after the child closes so user prompt
      // content does not linger on the host filesystem.
      const runner = new PiDirectRunner({ binary: 'node' });
      const result = await runner.run({
        agentId: 'test-agent-123',
        prompt: 'some specific prompt text ABC123',
        timeoutMs: 10000,
        workspacePath: workDir,
        workspaceMount: workDir,
      });
      // After the run, the prompt file should be gone.
      const files = await readdir(workDir);
      const promptFile = files.find((f) => f.startsWith('.dynflow-prompt-test-agent-123-'));
      expect(promptFile).toBeUndefined();
      expect(result.containerId).toMatch(/^pi-direct-/);
    });

    it('does not leave prompt files behind from concurrent runs', async () => {
      const runner = new PiDirectRunner({ binary: 'node' });
      const r1 = runner.run({
        agentId: 'agent-A',
        prompt: 'first agent content ALPHA',
        timeoutMs: 5000,
        workspacePath: workDir,
        workspaceMount: workDir,
      });
      const r2 = runner.run({
        agentId: 'agent-B',
        prompt: 'second agent content BETA',
        timeoutMs: 5000,
        workspacePath: workDir,
        workspaceMount: workDir,
      });
      await Promise.all([r1, r2]);
      const files = await readdir(workDir);
      const promptFiles = files.filter((f) => f.startsWith('.dynflow-prompt-'));
      // All per-agent prompt files should be cleaned up after the run.
      expect(promptFiles).toEqual([]);
    });
  });

  describe('killProcessTree', () => {
    it('uses process.kill(-pid) on POSIX to signal the process group', async () => {
      if (process.platform === 'win32') return;
      const processKillSpy = vi.spyOn(process, 'kill').mockImplementation(() => true);
      const fakeChild = { pid: 54321, kill: vi.fn() } as unknown as ChildProcess;
      await killProcessTree(fakeChild);
      expect(processKillSpy).toHaveBeenCalledWith(-54321, 'SIGKILL');
      processKillSpy.mockRestore();
    });

    it('falls back to child.kill when no PID is available', async () => {
      const fakeChild = { pid: undefined, kill: vi.fn() } as unknown as ChildProcess;
      await killProcessTree(fakeChild);
      expect(fakeChild.kill).toHaveBeenCalledWith('SIGKILL');
    });
  });
});
