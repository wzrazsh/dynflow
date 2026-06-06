import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ChildProcess } from 'node:child_process';
import { CuaPiRunner } from './cua-pi-runner.js';

/**
 * Build a minimal ChildProcess mock that fires its exit/close events LAZILY,
 * the first time one of the `on('exit'|'close'|'error')` handlers is
 * registered. This is more realistic than a setTimeout-based mock: real
 * spawn() never exits before the parent has had a chance to attach listeners.
 */
function makeChildMock(opts: {
  code?: number;
  signal?: NodeJS.Signals | null;
  exitImmediately?: boolean;
  pid?: number;
} = {}): ChildProcess {
  const handlers: Record<string, Array<(...args: unknown[]) => void>> = {};
  let fired = false;
  const fireExit = () => {
    if (fired) return;
    fired = true;
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
      if (
        (evt === 'exit' || evt === 'close' || evt === 'error') &&
        opts.exitImmediately !== false
      ) {
        fireExit();
      }
      return child;
    }),
    stdout: { on: vi.fn() },
    stderr: { on: vi.fn() },
    kill: vi.fn(),
    pid: opts.pid ?? null,
    exitCode: null,
  } as unknown as ChildProcess;

  if (opts.exitImmediately === true) {
    queueMicrotask(() => {
      const exitCb = (handlers.exit ?? [])[0];
      if (exitCb) exitCb(opts.code ?? 0, opts.signal ?? null);
      const closeCb = (handlers.close ?? [])[0];
      if (closeCb) closeCb(opts.code ?? 0, opts.signal ?? null);
    });
  }

  return child;
}

describe('CuaPiRunner', () => {
  let workDir: string;

  beforeEach(async () => {
    workDir = await mkdtemp(join(tmpdir(), 'cua-pi-test-'));
  });

  afterEach(async () => {
    await rm(workDir, { recursive: true, force: true });
  });

  describe('isAvailable', () => {
    it('returns a boolean without throwing', () => {
      const result = CuaPiRunner.isAvailable('node');
      expect(typeof result).toBe('boolean');
    });

    it('returns true for process.execPath (always exists)', () => {
      // Use the absolute path to the current Node.js binary so the test
      // passes regardless of platform PATH resolution quirks.
      expect(CuaPiRunner.isAvailable(process.execPath)).toBe(true);
    });

    it('returns false when the binary does not exist', () => {
      expect(CuaPiRunner.isAvailable('definitely-not-a-real-binary-xyz123')).toBe(false);
    });
  });

  describe('stop', () => {
    it('kills a registered child and removes it from the registry', async () => {
      const registry = new Map<string, ChildProcess>();
      const killFn = vi.fn();
      const child = {
        pid: undefined,
        kill: killFn,
        exitCode: null,
      } as unknown as ChildProcess;
      registry.set('test-id', child);

      const runner = new CuaPiRunner({ binary: 'node', processRegistry: registry });
      await runner.stop('test-id');

      expect(killFn).toHaveBeenCalledWith('SIGKILL');
      expect(registry.has('test-id')).toBe(false);
    });

    it('does nothing when containerId is not in the registry', async () => {
      const runner = new CuaPiRunner({ binary: 'node' });
      await expect(runner.stop('nonexistent-id')).resolves.toBeUndefined();
    });

    it('calls process.kill(-pid) on POSIX when the child has a PID', async () => {
      if (process.platform === 'win32') return;
      const registry = new Map<string, ChildProcess>();
      const child = {
        pid: 99999,
        kill: vi.fn(),
        exitCode: null,
      } as unknown as ChildProcess;
      registry.set('test-id', child);

      const processKillSpy = vi.spyOn(process, 'kill').mockImplementation(() => true);
      try {
        const runner = new CuaPiRunner({ binary: 'node', processRegistry: registry });
        await runner.stop('test-id');
        expect(processKillSpy).toHaveBeenCalledWith(-99999, 'SIGKILL');
      } finally {
        processKillSpy.mockRestore();
      }
    });
  });

  describe('cleanup', () => {
    it('kills all registered children and clears the registry', async () => {
      const registry = new Map<string, ChildProcess>();
      const kill1 = vi.fn();
      const kill2 = vi.fn();
      registry.set(
        'child-1',
        { pid: undefined, kill: kill1, exitCode: null } as unknown as ChildProcess,
      );
      registry.set(
        'child-2',
        { pid: undefined, kill: kill2, exitCode: null } as unknown as ChildProcess,
      );

      const runner = new CuaPiRunner({ binary: 'node', processRegistry: registry });
      await runner.cleanup();

      expect(kill1).toHaveBeenCalledWith('SIGKILL');
      expect(kill2).toHaveBeenCalledWith('SIGKILL');
      expect(registry.size).toBe(0);
    });

    it('skips children that have already exited', async () => {
      const registry = new Map<string, ChildProcess>();
      const killFn = vi.fn();
      registry.set(
        'exited-child',
        { pid: undefined, kill: killFn, exitCode: 0 } as unknown as ChildProcess,
      );

      const runner = new CuaPiRunner({ binary: 'node', processRegistry: registry });
      await runner.cleanup();

      expect(killFn).not.toHaveBeenCalled();
      expect(registry.size).toBe(0);
    });
  });

  describe('run() — model/provider selection', () => {
    /**
     * Use `process.execPath` (absolute path to Node) as binary to bypass
     * Windows `.cmd` shim resolution in `resolvePiBinary`.  On Windows,
     * `resolvePiBinary('node')` resolves to a `.cmd` shim, which Vitest's
     * `vi.doMock` for `node:child_process` may not intercept correctly
     * after `resetModules()`.
     */
    const BINARY = process.execPath;

    it('uses config.model even when it is "gpt-4o" (sentinel fix)', async () => {
      const child = makeChildMock({ code: 0 });
      const spawnMock = vi.fn().mockReturnValue(child);

      vi.doMock('node:child_process', () => ({
        spawn: spawnMock,
        execFile: () => Promise.reject(new Error('unused')),
        execFileSync: () => { throw new Error('unused'); },
      }));
      vi.resetModules();
      const { CuaPiRunner: MockedRunner } = await import('./cua-pi-runner.js');

      const reachableSpy = vi
        .spyOn(MockedRunner, 'isServerReachable')
        .mockResolvedValue(true);

      const runner = new MockedRunner({ binary: BINARY, model: 'claude-sonnet-4-20250514' });
      await runner.run({
        agentId: 'test',
        prompt: 'hi',
        timeoutMs: 5000,
        workspacePath: workDir,
        workspaceMount: workDir,
        model: 'gpt-4o',
      });

      expect(spawnMock).toHaveBeenCalled();
      const args = spawnMock.mock.calls[0][1] as string[];
      const modelIdx = args.indexOf('--model');
      expect(modelIdx).not.toBe(-1);
      expect(args[modelIdx + 1]).toBe('gpt-4o');
      reachableSpy.mockRestore();
    });

    it('falls back to this.model when config.model is not set', async () => {
      const child = makeChildMock({ code: 0 });
      const spawnMock = vi.fn().mockReturnValue(child);

      vi.doMock('node:child_process', () => ({
        spawn: spawnMock,
        execFile: () => Promise.reject(new Error('unused')),
        execFileSync: () => { throw new Error('unused'); },
      }));
      vi.resetModules();
      const { CuaPiRunner: MockedRunner } = await import('./cua-pi-runner.js');

      const reachableSpy = vi
        .spyOn(MockedRunner, 'isServerReachable')
        .mockResolvedValue(true);

      const runner = new MockedRunner({ binary: BINARY, model: 'default-fallback-model' });
      await runner.run({
        agentId: 'test',
        prompt: 'hi',
        timeoutMs: 5000,
        workspacePath: workDir,
        workspaceMount: workDir,
        // config.model intentionally omitted
      });

      expect(spawnMock).toHaveBeenCalled();
      const args = spawnMock.mock.calls[0][1] as string[];
      const modelIdx = args.indexOf('--model');
      expect(modelIdx).not.toBe(-1);
      expect(args[modelIdx + 1]).toBe('default-fallback-model');
      reachableSpy.mockRestore();
    });

    it('uses config.llmProvider for --provider arg and env var mapping', async () => {
      const child = makeChildMock({ code: 0 });
      const spawnMock = vi.fn().mockReturnValue(child);

      vi.doMock('node:child_process', () => ({
        spawn: spawnMock,
        execFile: () => Promise.reject(new Error('unused')),
        execFileSync: () => { throw new Error('unused'); },
      }));
      vi.resetModules();
      const { CuaPiRunner: MockedRunner } = await import('./cua-pi-runner.js');

      const reachableSpy = vi
        .spyOn(MockedRunner, 'isServerReachable')
        .mockResolvedValue(true);

      // provider=anthropic in constructor, but config.llmProvider=openai should override
      const runner = new MockedRunner({ binary: BINARY, provider: 'anthropic' });
      await runner.run({
        agentId: 'test',
        prompt: 'hi',
        timeoutMs: 5000,
        workspacePath: workDir,
        workspaceMount: workDir,
        apiKey: 'sk-test-key',
        llmProvider: 'openai',
      });

      expect(spawnMock).toHaveBeenCalled();
      const args = spawnMock.mock.calls[0][1] as string[];
      const providerIdx = args.indexOf('--provider');
      expect(providerIdx).not.toBe(-1);
      expect(args[providerIdx + 1]).toBe('openai');

      // buildChildEnv should map to OPENAI_API_KEY (openai provider),
      // not ANTHROPIC_API_KEY (anthropic would be the constructor default).
      const env = spawnMock.mock.calls[0][2].env as NodeJS.ProcessEnv;
      expect(env.OPENAI_API_KEY).toBe('sk-test-key');
      expect(env.ANTHROPIC_API_KEY).toBeUndefined();
      reachableSpy.mockRestore();
    });

    it('falls back to constructor provider when config.llmProvider is not set', async () => {
      const child = makeChildMock({ code: 0 });
      const spawnMock = vi.fn().mockReturnValue(child);

      vi.doMock('node:child_process', () => ({
        spawn: spawnMock,
        execFile: () => Promise.reject(new Error('unused')),
        execFileSync: () => { throw new Error('unused'); },
      }));
      vi.resetModules();
      const { CuaPiRunner: MockedRunner } = await import('./cua-pi-runner.js');

      const reachableSpy = vi
        .spyOn(MockedRunner, 'isServerReachable')
        .mockResolvedValue(true);

      const runner = new MockedRunner({ binary: BINARY, provider: 'anthropic' });
      await runner.run({
        agentId: 'test',
        prompt: 'hi',
        timeoutMs: 5000,
        workspacePath: workDir,
        workspaceMount: workDir,
        apiKey: 'sk-anthropic-key',
        // llmProvider intentionally omitted
      });

      expect(spawnMock).toHaveBeenCalled();
      const args = spawnMock.mock.calls[0][1] as string[];
      const providerIdx = args.indexOf('--provider');
      expect(providerIdx).not.toBe(-1);
      expect(args[providerIdx + 1]).toBe('anthropic');

      const env = spawnMock.mock.calls[0][2].env as NodeJS.ProcessEnv;
      expect(env.ANTHROPIC_API_KEY).toBe('sk-anthropic-key');
      expect(env.OPENAI_API_KEY).toBeUndefined();
      reachableSpy.mockRestore();
    });
  });

  describe('run() — process registration', () => {
    it('deregisters the child from the registry after the child closes', async () => {
      const registry = new Map<string, ChildProcess>();
      const child = makeChildMock({ code: 0 });

      vi.doMock('node:child_process', () => ({
        spawn: vi.fn().mockReturnValue(child),
        execFile: () => Promise.reject(new Error('unused')),
        execFileSync: () => { throw new Error('unused'); },
      }));
      vi.resetModules();
      const { CuaPiRunner: MockedRunner } = await import('./cua-pi-runner.js');

      // Mock isServerReachable so we don't need a real Cua server.
      const reachableSpy = vi
        .spyOn(MockedRunner, 'isServerReachable')
        .mockResolvedValue(true);

      const runner = new MockedRunner({ binary: 'node', processRegistry: registry });
      await runner.run({
        agentId: 'test',
        prompt: 'hi',
        timeoutMs: 5000,
        workspacePath: workDir,
        workspaceMount: workDir,
      });

      expect(registry.size).toBe(0);
      reachableSpy.mockRestore();
    });

    it('registers the child after spawn succeeds', async () => {
      const registry = new Map<string, ChildProcess>();
      const child = makeChildMock({ code: 0 });

      vi.doMock('node:child_process', () => ({
        spawn: vi.fn().mockReturnValue(child),
        execFile: () => Promise.reject(new Error('unused')),
        execFileSync: () => { throw new Error('unused'); },
      }));
      vi.resetModules();
      const { CuaPiRunner: MockedRunner } = await import('./cua-pi-runner.js');

      const reachableSpy = vi
        .spyOn(MockedRunner, 'isServerReachable')
        .mockResolvedValue(true);

      const runner = new MockedRunner({ binary: 'node', processRegistry: registry });
      await runner.run({
        agentId: 'test',
        prompt: 'hello',
        timeoutMs: 5000,
        workspacePath: workDir,
        workspaceMount: workDir,
      });

      // After the run, the registry should have been populated and then
      // emptied (child was registered, then deregistered on close).
      // If the registry entry leaked, the test would fail because
      // makeChildMock has exitCode: null and would remain in the map.
      expect(registry.size).toBe(0);
      reachableSpy.mockRestore();
    });
  });
});
