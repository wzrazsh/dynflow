import { describe, it, expect } from 'vitest';
import {
  getCurrentProcessToken,
  duplicateTokenEx,
  isProcessInJob,
  closeHandle,
  getCurrentProcess,
  HandleImpl,
} from './process-token.js';
import { isKoffiAvailable } from './koffi-loader.js';
import { TokenCreationError, mapWin32Error } from './errors.js';
import { makeHandle, TokenAccess } from './types.js';

const describeWin = process.platform === 'win32' && isKoffiAvailable() ? describe : describe.skip;

describeWin('sandbox/process-token (Windows only)', () => {
  describe('getCurrentProcessToken', () => {
    it('returns a non-zero handle for the current process', () => {
      const h = getCurrentProcessToken();
      try {
        expect(h.length).toBe(8);
        expect(h.readUInt32LE(0)).not.toBe(0);
      } finally {
        closeHandle(h);
      }
    });
  });

  describe('duplicateTokenEx', () => {
    it('produces a distinct handle from the source', () => {
      const src = getCurrentProcessToken();
      try {
        const dup = duplicateTokenEx(src);
        try {
          expect(dup.length).toBe(8);
          expect(dup.readUInt32LE(0)).not.toBe(0);
          // Distinct handle value (very likely, since DuplicateTokenEx
          // returns a new OS handle).
          expect(dup.readUInt32LE(0)).not.toBe(src.readUInt32LE(0));
        } finally {
          closeHandle(dup);
        }
      } finally {
        closeHandle(src);
      }
    });
  });

  describe('isProcessInJob', () => {
    it('returns a boolean', () => {
      const h = getCurrentProcess();
      const inJob = isProcessInJob(h, null);
      expect(typeof inJob).toBe('boolean');
    });
  });

  describe('closeHandle', () => {
    it('is safe to call on a real handle', () => {
      const h = getCurrentProcessToken();
      closeHandle(h);
      // Calling again should not crash.
      closeHandle(h);
      expect(h.readUInt32LE(0)).toBe(0); // zeroed by closeHandle
    });

    it('is safe to call on a null/empty handle', () => {
      const h = makeHandle(0);
      expect(() => closeHandle(h)).not.toThrow();
    });
  });

  describe('getCurrentProcess', () => {
    it('returns the pseudo-handle (-1 cast as HANDLE, 64-bit)', () => {
      const h = getCurrentProcess();
      expect(h.length).toBe(8);
      // On 64-bit Windows the pseudo-handle is 0xFFFFFFFFFFFFFFFF (-1).
      expect(h.readBigUInt64LE(0)).toBe(0xffffffffffffffffn);
    });
  });

  describe('HandleImpl (RAII)', () => {
    it('round-trips the numeric value', () => {
      const h = getCurrentProcessToken();
      try {
        const wrapper = new HandleImpl(h);
        expect(wrapper.disposed).toBe(false);
        expect(wrapper.rawValue).toBe(h.readUInt32LE(0));
        wrapper.dispose();
        expect(wrapper.disposed).toBe(true);
      } finally {
        closeHandle(h);
      }
    });

    it('throws on .handle after dispose', () => {
      const h = getCurrentProcessToken();
      try {
        const wrapper = new HandleImpl(h);
        wrapper.dispose();
        expect(() => wrapper.handle).toThrow(TokenCreationError);
      } finally {
        closeHandle(h);
      }
    });

    it('Symbol.dispose works', () => {
      const h = getCurrentProcessToken();
      try {
        const wrapper = new HandleImpl(h);
        wrapper[Symbol.dispose]();
        expect(wrapper.disposed).toBe(true);
      } finally {
        closeHandle(h);
      }
    });
  });

  describe('error mapping', () => {
    it('mapWin32Error returns a TokenCreationError for invalid token access', () => {
      // ERROR_INVALID_HANDLE
      const e = mapWin32Error(6, { operation: 'openProcessToken' });
      expect(e).toBeInstanceOf(TokenCreationError);
    });
  });
});

// Suppress unused-import warnings while keeping the file self-documenting.
void TokenAccess;
