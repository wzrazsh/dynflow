import { describe, it, expect, vi, beforeEach } from 'vitest';
import { CuaAgentRunner } from './cua-runner.js';

const execSyncMock = vi.fn();

vi.mock('node:child_process', () => ({
  execSync: (...args: unknown[]) => execSyncMock(...args),
  exec: vi.fn(),
  promisify: () => vi.fn(),
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
