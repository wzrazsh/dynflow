import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { isKoffiAvailable, getKoffi, loadLibrary, _resetKoffiCache } from './koffi-loader.js';
import { SandboxUnsupportedError } from './errors.js';

describe('sandbox/koffi-loader', () => {
  beforeEach(() => {
    _resetKoffiCache();
  });

  afterEach(() => {
    _resetKoffiCache();
  });

  describe('isKoffiAvailable', () => {
    it('returns false on non-Windows without throwing', () => {
      if (process.platform === 'win32') return; // skip on Windows
      expect(isKoffiAvailable()).toBe(false);
    });

    it('returns a boolean on any platform', () => {
      const result = isKoffiAvailable();
      expect(typeof result).toBe('boolean');
    });
  });

  describe('getKoffi', () => {
    it('throws SandboxUnsupportedError on non-Windows', () => {
      if (process.platform === 'win32') return; // skip on Windows
      expect(() => getKoffi()).toThrow(SandboxUnsupportedError);
    });

    it('returns the koffi module on Windows when koffi is installed', () => {
      if (process.platform !== 'win32') return;
      if (!isKoffiAvailable()) return; // skip if native binding not built
      const k = getKoffi();
      expect(k).toBeTruthy();
      expect(typeof (k as { sizeof?: unknown }).sizeof).toBe('function');
    });
  });

  describe('loadLibrary', () => {
    it('throws SandboxUnsupportedError on non-Windows', () => {
      if (process.platform === 'win32') return;
      expect(() => loadLibrary('kernel32.dll')).toThrow(SandboxUnsupportedError);
    });

    it('loads a Windows DLL on Windows', () => {
      if (process.platform !== 'win32') return;
      if (!isKoffiAvailable()) return;
      const lib = loadLibrary('kernel32.dll');
      expect(lib).toBeTruthy();
    });
  });
});
