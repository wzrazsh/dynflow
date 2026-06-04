import { describe, it, expect } from 'vitest';
import {
  makeHandle,
  getHandleValue,
  getHandleValue64,
  asHandle,
  asSid,
  verifyStructSizes,
  Win32ErrorCodes,
  TokenAccess,
  ProcessCreationFlags,
  StartupInfoFlags,
  JobObjectLimits,
  RestrictedTokenFlags,
  ExpectedStructSizes,
} from './types.js';

describe('sandbox/types', () => {
  describe('makeHandle / getHandleValue', () => {
    it('round-trips a 32-bit value', () => {
      const h = makeHandle(0xdeadbeef);
      expect(getHandleValue(h)).toBe(0xdeadbeef >>> 0);
    });

    it('round-trips a bigint value', () => {
      const h = makeHandle(0x1122334455667788n);
      expect(getHandleValue64(h)).toBe(0x1122334455667788n);
    });

    it('allocates an 8-byte buffer', () => {
      const h = makeHandle(0);
      expect(h.length).toBe(8);
    });

    it('coerces negative number to unsigned 32-bit', () => {
      const h = makeHandle(-1);
      expect(getHandleValue(h)).toBe(0xffffffff);
    });
  });

  describe('asHandle / asSid', () => {
    it('asHandle returns a typed view of the same buffer', () => {
      const b = Buffer.alloc(8);
      b.writeUInt32LE(42, 0);
      const h = asHandle(b);
      expect(h).toBe(b);
      expect(getHandleValue(h)).toBe(42);
    });

    it('asSid returns a typed view of the same buffer', () => {
      const b = Buffer.from([1, 2, 3, 4]);
      const s = asSid(b);
      expect(s).toBe(b);
      expect(s.length).toBe(4);
    });
  });

  describe('Win32 error code constants', () => {
    it('exposes the documented values', () => {
      expect(Win32ErrorCodes.ERROR_ACCESS_DENIED).toBe(5);
      expect(Win32ErrorCodes.ERROR_INVALID_HANDLE).toBe(6);
      expect(Win32ErrorCodes.ERROR_INVALID_PARAMETER).toBe(87);
      expect(Win32ErrorCodes.ERROR_NOT_ENOUGH_QUOTA).toBe(1816);
      expect(Win32ErrorCodes.ERROR_PRIVILEGE_NOT_HELD).toBe(1314);
      expect(Win32ErrorCodes.ERROR_NOT_ALL_ASSIGNED).toBe(1300);
      expect(Win32ErrorCodes.ERROR_BAD_LENGTH).toBe(24);
    });
  });

  describe('flag constants', () => {
    it('exposes expected TokenAccess values', () => {
      expect(TokenAccess.TOKEN_DUPLICATE).toBe(0x0002);
      expect(TokenAccess.TOKEN_QUERY).toBe(0x0008);
      expect(TokenAccess.TOKEN_ALL_ACCESS).toBe(0x000f01ff);
    });

    it('exposes expected ProcessCreationFlags values', () => {
      expect(ProcessCreationFlags.CREATE_SUSPENDED).toBe(0x00000004);
      expect(ProcessCreationFlags.CREATE_NO_WINDOW).toBe(0x08000000);
      expect(ProcessCreationFlags.CREATE_BREAKAWAY_FROM_JOB).toBe(0x01000000);
    });

    it('exposes expected StartupInfoFlags values', () => {
      expect(StartupInfoFlags.STARTF_USESTDHANDLES).toBe(0x00000100);
      expect(StartupInfoFlags.STARTF_USESHOWWINDOW).toBe(0x00000001);
    });

    it('exposes expected JobObjectLimits values', () => {
      expect(JobObjectLimits.JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE).toBe(0x2000);
      expect(JobObjectLimits.JOB_OBJECT_LIMIT_BREAKAWAY_OK).toBe(0x0800);
      expect(JobObjectLimits.JOB_OBJECT_LIMIT_PROCESS_MEMORY).toBe(0x0100);
    });

    it('exposes expected RestrictedTokenFlags values', () => {
      expect(RestrictedTokenFlags.WRITE_RESTRICTED).toBe(0x0008);
      expect(RestrictedTokenFlags.DISABLE_MAX_PRIVILEGE).toBe(0x0800);
      expect(RestrictedTokenFlags.SANDBOX_INERT).toBe(0x0004);
    });
  });

  describe('verifyStructSizes', () => {
    const fakeStruct = { __name: 'fake' };

    it('throws on non-Windows', () => {
      if (process.platform === 'win32') return; // skip on Windows
      const koffi = {
        sizeof: () => {
          throw new Error('should not be called on non-Windows');
        },
      };
      expect(() =>
        verifyStructSizes(koffi, [{ name: 'X', expectedSize: 8, koffiStruct: fakeStruct }]),
      ).toThrow(/only run on Windows/);
    });

    it('passes when sizes match on Windows', () => {
      if (process.platform !== 'win32') return; // skip on non-Windows
      const koffi = { sizeof: () => 104 };
      expect(() =>
        verifyStructSizes(koffi, [{ name: 'STARTUPINFOW', expectedSize: 104, koffiStruct: fakeStruct }]),
      ).not.toThrow();
    });

    it('throws with actionable message on size mismatch', () => {
      if (process.platform !== 'win32') return;
      const koffi = { sizeof: () => 100 };
      expect(() =>
        verifyStructSizes(koffi, [{ name: 'STARTUPINFOW', expectedSize: 104, koffiStruct: fakeStruct }]),
      ).toThrow(/size mismatch.*STARTUPINFOW.*expected 104.*got 100/);
    });

    it('wraps sizeof errors', () => {
      if (process.platform !== 'win32') return;
      const koffi = {
        sizeof: () => {
          throw new Error('boom');
        },
      };
      expect(() =>
        verifyStructSizes(koffi, [{ name: 'X', expectedSize: 1, koffiStruct: fakeStruct }]),
      ).toThrow(/sizeof failed for X/);
    });
  });

  describe('ExpectedStructSizes', () => {
    it('declares the documented MSVC x64 sizes', () => {
      expect(ExpectedStructSizes.STARTUPINFOW).toBe(104);
      expect(ExpectedStructSizes.JOBOBJECT_EXTENDED_LIMIT_INFORMATION).toBe(144);
      expect(ExpectedStructSizes.SECURITY_ATTRIBUTES).toBe(24);
      expect(ExpectedStructSizes.LUID).toBe(8);
      expect(ExpectedStructSizes.LUID_AND_ATTRIBUTES).toBe(12);
      expect(ExpectedStructSizes.PROCESS_INFORMATION).toBe(24);
    });
  });
});
