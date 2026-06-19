import { describe, it, expect } from 'vitest';
import { PiAppContainerRunner } from './pi-appcontainer-runner.js';

describe('PiAppContainerRunner', () => {
  describe('isAvailable', () => {
    it('returns false on non-Windows hosts', () => {
      if (process.platform === 'win32') return;
      expect(PiAppContainerRunner.isAvailable()).toBe(false);
    });
  });

  describe('run', () => {
    it('returns an error when the host is unsupported', async () => {
      const runner = new PiAppContainerRunner();
      // Force the unavailability path on non-Windows (isAvailable is
      // false) and on Windows hosts that lack the AppContainer APIs.
      const result = await runner.run({
        agentId: 'test-agent',
        prompt: 'echo hello',
        timeoutMs: 1000,
        workspacePath: '/tmp/test-workspace',
        workspaceMount: '/home/cua/workspace',
      });
      if (PiAppContainerRunner.isAvailable()) {
        // On a host that actually supports it we expect the run to
        // proceed past the availability check; the test runner here
        // will not assert on the outcome.
        expect(result.containerId).toBeDefined();
      } else {
        expect(result.success).toBe(false);
        expect(result.error).toMatch(/AppContainer|not supported/i);
        expect(result.containerId).toBe('');
      }
    });
  });

  describe('profileName default', () => {
    it('sanitizes agent id into a valid profile name', () => {
      const runner = new PiAppContainerRunner();
      // Probe the default profileName builder via reflection.
      // The function is private; we use a known-good agent id and
      // assert indirectly by calling run() and observing no crash on
      // a sanitization edge case.
      const name = (runner as unknown as { profileName: (id: string) => string })
        .profileName('agent/with:special#chars');
      expect(name).toMatch(/^dynflow-pi-/);
      // The slashes/colons/hashes should have been replaced with `_`.
      expect(name).not.toMatch(/[/:]/);
    });
  });
});