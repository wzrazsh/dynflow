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

// WindowsNativeRunner mock: isAvailable() returns false on non-Windows
// hosts (which is the test environment). The tests below override
// isAvailable to exercise the auto-select chain and explicit override.
vi.mock('./windows-native-runner.js', () => ({
  WindowsNativeRunner: class {
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
import { WindowsNativeRunner } from './windows-native-runner.js';

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

describe('createAgentRunner — WindowsNativeRunner', () => {
  const OLD_ENV = { ...process.env };
  let isAvailableSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.clearAllMocks();
    isAvailableSpy = vi.spyOn(WindowsNativeRunner, 'isAvailable');
  });

  afterEach(() => {
    process.env = { ...OLD_ENV };
    isAvailableSpy.mockRestore();
  });

  it('selects WindowsNativeRunner when DYNFLOW_RUNNER=windows-native is explicit', () => {
    process.env.DYNFLOW_RUNNER = 'windows-native';
    isAvailableSpy.mockReturnValue(true);
    const runner = createAgentRunner();
    expect(runner.constructor.name).toBe('WindowsNativeRunner');
  });

  it('throws when DYNFLOW_RUNNER=windows-native is set but not supported', () => {
    process.env.DYNFLOW_RUNNER = 'windows-native';
    isAvailableSpy.mockReturnValue(false);
    expect(() => createAgentRunner()).toThrow(/does not support it/);
  });

  it('returns WindowsNativeRunner when override.runner=windows-native and supported', () => {
    isAvailableSpy.mockReturnValue(true);
    const runner = createAgentRunner({ runner: 'windows-native' });
    expect(runner.constructor.name).toBe('WindowsNativeRunner');
  });

  it('throws when override.runner=windows-native but not supported', () => {
    isAvailableSpy.mockReturnValue(false);
    expect(() => createAgentRunner({ runner: 'windows-native' })).toThrow(
      /does not support it/,
    );
  });

  it('auto-selects WindowsNativeRunner when Cua/CuaPi are unavailable and WindowsNativeRunner is supported', () => {
    delete process.env.DYNFLOW_RUNNER;
    isAvailableSpy.mockReturnValue(true);
    const runner = createAgentRunner();
    expect(runner.constructor.name).toBe('WindowsNativeRunner');
  });

  it('does NOT auto-select WindowsNativeRunner when Cua is available (Cua takes priority)', async () => {
    delete process.env.DYNFLOW_RUNNER;
    isAvailableSpy.mockReturnValue(true);
    // All other isAvailable mocks return false except Cua (we override).
    const cuaSpy = vi.spyOn(
      (await import('./cua-runner.js')).CuaAgentRunner,
      'isAvailable',
    ).mockReturnValue(true);
    const runner = createAgentRunner();
    expect(runner.constructor.name).toBe('CuaAgentRunner');
    cuaSpy.mockRestore();
  });

  it('does NOT auto-select WindowsNativeRunner when CuaPi is available (CuaPi takes priority over WindowsNativeRunner)', async () => {
    delete process.env.DYNFLOW_RUNNER;
    isAvailableSpy.mockReturnValue(true);
    const cuaPiSpy = vi.spyOn(
      (await import('./cua-pi-runner.js')).CuaPiRunner,
      'isAvailable',
    ).mockReturnValue(true);
    const runner = createAgentRunner();
    expect(runner.constructor.name).toBe('CuaPiRunner');
    cuaPiSpy.mockRestore();
  });

  it('does NOT auto-select WindowsNativeRunner when it reports unavailable', () => {
    delete process.env.DYNFLOW_RUNNER;
    isAvailableSpy.mockReturnValue(false);
    // Falls through to Docker, which is also unavailable in this test.
    expect(() => createAgentRunner()).toThrow('Docker is not available');
  });
});
