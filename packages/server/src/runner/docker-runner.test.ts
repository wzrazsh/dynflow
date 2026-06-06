import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { AgentRunConfig } from './types.js';

const { execMock, execSyncMock } = vi.hoisted(() => ({
  execMock: vi.fn(),
  execSyncMock: vi.fn(),
}));

vi.mock('node:child_process', () => ({
  exec: execMock,
  execSync: execSyncMock,
}));

// Node's util.promisify has built-in custom handling for child_process.exec
// that resolves to { stdout, stderr }. Since we mock exec, that custom handling
// is lost, so we mock promisify to replicate the { stdout, stderr } behavior.
vi.mock('node:util', () => ({
  promisify: (fn: (...args: unknown[]) => unknown) => {
    return (...args: unknown[]) =>
      new Promise((resolve, reject) => {
        const callback = (
          err: Error | null,
          stdout: string,
          stderr: string,
        ) => {
          if (err) reject(Object.assign(err, { stdout, stderr }));
          else resolve({ stdout, stderr });
        };
        fn(...args, callback);
      });
  },
}));

import { DockerAgentRunner } from './docker-runner.js';

function makeConfig(overrides: Partial<AgentRunConfig> = {}): AgentRunConfig {
  return {
    agentId: 'agent-1',
    prompt: 'Do something',
    model: 'gpt-4',
    timeoutMs: 30000,
    apiKey: 'sk-test-key',
    workspacePath: '/tmp/workspace',
    workspaceMount: '/app/output',
    ...overrides,
  };
}

function setupDefaultMock() {
  // Make execSync succeed by default (Docker available)
  execSyncMock.mockReturnValue(Buffer.from(''));

  execMock.mockImplementation((...args: unknown[]) => {
    const cmd = args[0] as string;
    const callback = (
      typeof args[args.length - 1] === 'function' ? args[args.length - 1] : null
    ) as ((err: Error | null, stdout: string, stderr: string) => void) | null;

    if (cmd.startsWith('docker run')) {
      callback?.(null, 'container-123\n', '');
    } else if (cmd.startsWith('docker wait')) {
      callback?.(null, '0\n', '');
    } else if (cmd.startsWith('docker logs')) {
      callback?.(null, '{"success":true,"output":"Task completed"}\n', '');
    } else if (cmd.startsWith('docker stop') || cmd.startsWith('docker rm')) {
      callback?.(null, '', '');
    } else {
      callback?.(null, '', '');
    }
  });
}

describe('DockerAgentRunner', () => {
  let runner: DockerAgentRunner;

  beforeEach(() => {
    vi.clearAllMocks();
    setupDefaultMock();
    runner = new DockerAgentRunner();
  });

  // -------------------------------------------------------------------------
  // 0. isAvailable
  // -------------------------------------------------------------------------
  describe('isAvailable', () => {
    it('returns true when docker info succeeds', () => {
      execSyncMock.mockReturnValue(Buffer.from(''));
      expect(DockerAgentRunner.isAvailable()).toBe(true);
      expect(execSyncMock).toHaveBeenCalledWith('docker info', { stdio: 'ignore' });
    });

    it('returns false when docker info fails', () => {
      execSyncMock.mockImplementation(() => {
        throw new Error('docker not found');
      });
      expect(DockerAgentRunner.isAvailable()).toBe(false);
    });
  });

  // -------------------------------------------------------------------------
  // 1a. run: Docker unavailable → returns error gracefully (no crash)
  // -------------------------------------------------------------------------
  it('returns error gracefully when Docker is unavailable', async () => {
    execSyncMock.mockImplementation(() => {
      throw new Error('docker not found');
    });

    const result = await runner.run(makeConfig());
    expect(result.success).toBe(false);
    expect(result.error).toContain('Docker is not available');
    expect(result.containerId).toBe('');
  });

  // -------------------------------------------------------------------------
  // 1b. run: starts container, waits, reads logs → returns success
  // -------------------------------------------------------------------------
  it('starts a container and returns successful result', async () => {
    const result = await runner.run(makeConfig());

    // docker run called with the dynflow-agent image
    expect(execMock).toHaveBeenCalledWith(
      expect.stringContaining('docker run'),
      expect.any(Function),
    );
    // docker wait called with the container id
    expect(execMock).toHaveBeenCalledWith(
      expect.stringContaining('docker wait container-123'),
      expect.objectContaining({ timeout: expect.any(Number) }),
      expect.any(Function),
    );
    // docker logs called
    expect(execMock).toHaveBeenCalledWith(
      expect.stringContaining('docker logs container-123'),
      expect.any(Function),
    );

    expect(result.success).toBe(true);
    expect(result.output).toBe('Task completed');
    expect(result.error).toBeUndefined();
  });

  // -------------------------------------------------------------------------
  // 2. run: agent error result in logs
  // -------------------------------------------------------------------------
  it('handles agent error result from docker logs', async () => {
    execMock.mockReset();
    execMock.mockImplementation((...args: unknown[]) => {
      const cmd = args[0] as string;
      const callback = (
        typeof args[args.length - 1] === 'function' ? args[args.length - 1] : null
      ) as ((err: Error | null, stdout: string, stderr: string) => void) | null;

      if (cmd.startsWith('docker run')) {
        callback?.(null, 'abc-456\n', '');
      } else if (cmd.startsWith('docker wait')) {
        callback?.(null, '1\n', '');
      } else if (cmd.startsWith('docker logs')) {
        callback?.(null, '{"success":false,"error":"Something went wrong"}\n', '');
      } else {
        callback?.(null, '', '');
      }
    });

    const result = await runner.run(makeConfig());

    expect(result.success).toBe(false);
    expect(result.error).toBe('Something went wrong');
    expect(result.output).toBeUndefined();
  });

  // -------------------------------------------------------------------------
  // 3. run: timeout from docker wait → propagation
  // -------------------------------------------------------------------------
  it('handles timeout from docker wait', async () => {
    execMock.mockReset();
    execMock.mockImplementation((...args: unknown[]) => {
      const cmd = args[0] as string;
      const callback = (
        typeof args[args.length - 1] === 'function' ? args[args.length - 1] : null
      ) as ((err: Error | null, stdout: string, stderr: string) => void) | null;

      if (cmd.startsWith('docker run')) {
        callback?.(null, 'abc-789\n', '');
      } else if (cmd.startsWith('docker wait')) {
        const err = new Error('Command timed out');
        (err as NodeJS.ErrnoException).code = 'ETIMEDOUT';
        callback?.(err, '', '');
      } else {
        callback?.(null, '', '');
      }
    });

    const promise = runner.run(makeConfig({ timeoutMs: 100 }));
    await expect(promise).rejects.toThrow('Command timed out');
  });

  // -------------------------------------------------------------------------
  // 4. stop: calls docker stop + docker rm
  // -------------------------------------------------------------------------
  it('calls docker stop and docker rm on stop', async () => {
    await runner.stop('container-123');

    expect(execMock).toHaveBeenCalledWith(
      'docker stop container-123',
      expect.any(Function),
    );
    expect(execMock).toHaveBeenCalledWith(
      'docker rm -f container-123',
      expect.any(Function),
    );
  });

  // -------------------------------------------------------------------------
  // 5. stop: does not throw on failure
  // -------------------------------------------------------------------------
  it('does not throw when docker stop or rm fails', async () => {
    execMock.mockReset();
    execMock.mockImplementation((...args: unknown[]) => {
      const callback = (
        typeof args[args.length - 1] === 'function' ? args[args.length - 1] : null
      ) as (err: Error | null, stdout: string, stderr: string) => void | null;
      callback?.(new Error('Container not found'), '', '');
    });

    await expect(runner.stop('container-123')).resolves.toBeUndefined();
  });

  // -------------------------------------------------------------------------
  // 6. cleanup: removes dynflow containers
  // -------------------------------------------------------------------------
  it('removes dynflow containers on cleanup', async () => {
    await runner.cleanup();

    expect(execSyncMock).toHaveBeenCalledWith(
      'docker ps -a --filter "label=dynflow" -q | xargs -r docker rm -f',
      { stdio: 'ignore' },
    );
  });

  // -------------------------------------------------------------------------
  // 7. run: special characters in prompt are escaped
  // -------------------------------------------------------------------------
  it('escapes double quotes in prompt for docker run', async () => {
    await runner.run(makeConfig({ prompt: 'Say "hello" and use $PATH' }));

    const dockerRunCall = execMock.mock.calls.find(
      (call: unknown[]) => (call[0] as string).startsWith('docker run'),
    );
    expect(dockerRunCall).toBeDefined();
    const cmd = dockerRunCall![0] as string;
    expect(cmd).toContain('AGENT_PROMPT="Say \\"hello\\" and use $PATH"');
  });

  // -------------------------------------------------------------------------
  // 8. run: config timeout passed as AGENT_TIMEOUT_MS env var
  // -------------------------------------------------------------------------
  it('passes config timeout to docker run command', async () => {
    await runner.run(makeConfig({ timeoutMs: 60000 }));

    const dockerRunCall = execMock.mock.calls.find(
      (call: unknown[]) => (call[0] as string).startsWith('docker run'),
    );
    expect(dockerRunCall).toBeDefined();
    const cmd = dockerRunCall![0] as string;
    expect(cmd).toContain('AGENT_TIMEOUT_MS="60000"');
  });

  // -------------------------------------------------------------------------
  // 9. run: returns containerId from docker run output
  // -------------------------------------------------------------------------
  it('returns the containerId from run', async () => {
    const result = await runner.run(makeConfig());

    expect(result.containerId).toBe('container-123');
  });
});
