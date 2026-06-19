import { describe, it, expect, beforeEach } from 'vitest';
import {
  isSupported,
  createAppContainerProfile,
  _resetBindingCache,
} from './appcontainer.js';

describe('sandbox/appcontainer', () => {
  beforeEach(() => {
    _resetBindingCache();
  });

  describe('isSupported', () => {
    it('returns false on non-Windows', () => {
      if (process.platform === 'win32') return;
      expect(isSupported()).toBe(false);
    });

    it('does not throw on any platform', () => {
      expect(() => isSupported()).not.toThrow();
    });
  });

  describe('createAppContainerProfile', () => {
    it('throws on non-Windows hosts', () => {
      if (process.platform === 'win32') return;
      expect(() =>
        createAppContainerProfile({
          name: 'dynflow-test',
          displayName: 'Test',
          description: 'Test profile',
        }),
      ).toThrow();
    });
  });
});