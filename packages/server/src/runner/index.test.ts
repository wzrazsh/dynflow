import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// ---------------------------------------------------------------------------
// Mocks — control isAvailable for all runners, silence logger
// ---------------------------------------------------------------------------

vi.mock('../logger.js', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

vi.mock('./cua-runner.js', () => ({
  CuaAgentRunner: class {
    static isAvailable() {
      return false;
    }
    run() {
      return Promise.resolve({ success: false, error: 'mock', containerId: '' });
    }
    stop() {
      return Promise.resolve();
    }
    cleanup() {
      return Promise.resolve();
    }
  },
}));

vi.mock('./cua-pi-runner.js', () => ({
  CuaPiRunner: class {
    static isAvailable() {
      return false;
    }
    run() {
      return Promise.resolve({ success: false, error: 'mock', containerId: '' });
    }
    stop() {
      return Promise.resolve();
    }
    cleanup() {
      return Promise.resolve();
    }
  },
}));

// PiCuaNativeRunner mock: isAvailable() returns true to prove it's NOT
// auto-selected (it's explicit-only).
vi.mock('./pi-cua-native-runner.js', () => ({
  PiCuaNativeRunner: class {
    static isAvailable() {
      return true;
    }
    run() {
      return Promise.resolve({ success: false, error: 'mock', containerId: '' });
    }
    stop() {
      return Promise.resolve();
    }
    cleanup() {
      return Promise.resolve();
    }
  },
}));

vi.mock('./pi-direct-runner.js', () => ({
  PiDirectRunner: class {
    static isAvailable() {
      return false;
    }
    run() {
      return Promise.resolve({ success: false, error: 'mock', containerId: '' });
    }
    stop() {
      return Promise.resolve();
    }
    cleanup() {
      return Promise.resolve();
    }
  },
}));

vi.mock('./docker-runner.js', () => ({
  DockerAgentRunner: class {
    static isAvailable() {
      return false;
    }
    run() {
      return Promise.resolve({ success: false, error: 'mock', containerId: '' });
    }
    stop() {
      return Promise.resolve();
    }
    cleanup() {
      return Promise.resolve();
    }
  },
}));

vi.mock('./wsl-docker-runner.js', () => ({
  WslDockerAgentRunner: class {
    static isAvailable() {
      return false;
    }
    run() {
      return Promise.resolve({ success: false, error: 'mock', containerId: '' });
    }
    stop() {
      return Promise.resolve();
    }
    cleanup() {
      return Promise.resolve();
    }
  },
}));

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

import { createAgentRunner, RunnerType } from './index.js';

describe('createAgentRunner selection chain', () => {
  const OLD_ENV = { ...process.env };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    process.env = { ...OLD_ENV };
  });

  it('selects PiCuaNativeRunner when DYNFLOW_RUNNER=pi-cua-native is explicit', () => {
    process.env.DYNFLOW_RUNNER = 'pi-cua-native';
    const runner = createAgentRunner();
    expect(runner.constructor.name).toBe('PiCuaNativeRunner');
  });

  it('does NOT auto-select PiCuaNativeRunner when DYNFLOW_RUNNER is unset', () => {
    delete process.env.DYNFLOW_RUNNER;
    // All isAvailable() mocks return false, so the chain falls through
    // to Docker, which throws because Docker is also unavailable.
    expect(() => createAgentRunner()).toThrow('Docker is not available');
  });
});

describe('createAgentRunner override', () => {
  it('returns PiDirectRunner when override.runner=pi-direct', () => {
    const runner = createAgentRunner({ runner: 'pi-direct' });
    expect(runner.constructor.name).toBe('PiDirectRunner');
  });

  it('returns CuaAgentRunner when override.runner=cua', () => {
    const runner = createAgentRunner({ runner: 'cua' });
    expect(runner.constructor.name).toBe('CuaAgentRunner');
  });

  it('returns PiCuaNativeRunner when override.runner=pi-cua-native', () => {
    const runner = createAgentRunner({ runner: 'pi-cua-native' });
    expect(runner.constructor.name).toBe('PiCuaNativeRunner');
  });

  it('returns CuaPiRunner when override.runner=cua-pi', () => {
    const runner = createAgentRunner({ runner: 'cua-pi' });
    expect(runner.constructor.name).toBe('CuaPiRunner');
  });

  it('throws for invalid runner name', () => {
    expect(() => createAgentRunner({ runner: 'nonexistent' })).toThrow(
      'Unknown runner',
    );
  });

  it('uses env var when override is empty object', () => {
    delete process.env.DYNFLOW_RUNNER;
    // All mocked isAvailable() return false, falls through to docker which throws
    expect(() => createAgentRunner({})).toThrow('Docker is not available');
  });

  it('uses env var when override is undefined', () => {
    delete process.env.DYNFLOW_RUNNER;
    expect(() => createAgentRunner()).toThrow('Docker is not available');
  });

  it('explicit env var still works with no override', () => {
    process.env.DYNFLOW_RUNNER = 'pi-cua-native';
    const runner = createAgentRunner();
    expect(runner.constructor.name).toBe('PiCuaNativeRunner');
  });
});
