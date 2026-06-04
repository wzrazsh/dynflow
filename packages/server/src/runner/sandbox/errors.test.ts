import { describe, it, expect } from 'vitest';
import {
  SandboxError,
  SandboxUnsupportedError,
  TokenCreationError,
  JobObjectError,
  ProcessCreationError,
  DaclError,
  PrivilegeError,
  mapWin32Error,
} from './errors.js';
import { Win32ErrorCodes } from './types.js';

describe('sandbox/errors', () => {
  describe('error class hierarchy', () => {
    it('all typed errors extend SandboxError', () => {
      const e = new TokenCreationError('test');
      expect(e).toBeInstanceOf(SandboxError);
      expect(e).toBeInstanceOf(Error);
    });

    it('preserves message and sets name', () => {
      const e = new JobObjectError('something went wrong');
      expect(e.message).toContain('something went wrong');
      expect(e.name).toBe('JobObjectError');
    });

    it('attaches errno and operation to the formatted message', () => {
      const e = new ProcessCreationError('create failed', {
        errno: 5,
        operation: 'CreateProcessAsUserW',
      });
      expect(e.errno).toBe(5);
      expect(e.operation).toBe('CreateProcessAsUserW');
      expect(e.message).toContain('create failed');
      expect(e.message).toContain('CreateProcessAsUserW');
      expect(e.message).toContain('5');
    });

    it('attaches cause when provided', () => {
      const cause = new Error('root');
      const e = new DaclError('wrapped', { cause });
      expect((e as Error & { cause?: unknown }).cause).toBe(cause);
    });

    it('exposes a stable code per error class', () => {
      expect(new SandboxUnsupportedError('x').code).toBe('SANDBOX_UNSUPPORTED');
      expect(new PrivilegeError('x').code).toBe('PRIVILEGE_NOT_HELD');
      expect(new TokenCreationError('x').code).toBe('TOKEN_CREATION_FAILED');
      expect(new JobObjectError('x').code).toBe('JOB_OBJECT_FAILED');
      expect(new ProcessCreationError('x').code).toBe('PROCESS_CREATION_FAILED');
      expect(new DaclError('x').code).toBe('DACL_FAILED');
    });
  });

  describe('mapWin32Error', () => {
    it('maps ERROR_PRIVILEGE_NOT_HELD to PrivilegeError', () => {
      const e = mapWin32Error(Win32ErrorCodes.ERROR_PRIVILEGE_NOT_HELD, { operation: 'op' });
      expect(e).toBeInstanceOf(PrivilegeError);
      expect(e.errno).toBe(Win32ErrorCodes.ERROR_PRIVILEGE_NOT_HELD);
    });

    it('maps ERROR_NOT_ALL_ASSIGNED to PrivilegeError', () => {
      const e = mapWin32Error(Win32ErrorCodes.ERROR_NOT_ALL_ASSIGNED, { operation: 'op' });
      expect(e).toBeInstanceOf(PrivilegeError);
    });

    it('maps ERROR_NOT_ENOUGH_QUOTA to ProcessCreationError', () => {
      const e = mapWin32Error(Win32ErrorCodes.ERROR_NOT_ENOUGH_QUOTA, { operation: 'op' });
      expect(e).toBeInstanceOf(ProcessCreationError);
    });

    it('maps ERROR_ACCESS_DENIED based on operation keyword', () => {
      // assignprocess contains "process" — must be checked BEFORE "process".
      const eJob = mapWin32Error(Win32ErrorCodes.ERROR_ACCESS_DENIED, { operation: 'AssignProcessToJobObject' });
      expect(eJob).toBeInstanceOf(JobObjectError);

      const eToken = mapWin32Error(Win32ErrorCodes.ERROR_ACCESS_DENIED, { operation: 'openProcessToken' });
      expect(eToken).toBeInstanceOf(TokenCreationError);

      const eProc = mapWin32Error(Win32ErrorCodes.ERROR_ACCESS_DENIED, { operation: 'CreateProcessAsUserW' });
      expect(eProc).toBeInstanceOf(ProcessCreationError);

      const eDacl = mapWin32Error(Win32ErrorCodes.ERROR_ACCESS_DENIED, { operation: 'SetSecurityInfo' });
      expect(eDacl).toBeInstanceOf(DaclError);

      const eUnknown = mapWin32Error(Win32ErrorCodes.ERROR_ACCESS_DENIED, { operation: 'mystery' });
      expect(eUnknown).toBeInstanceOf(SandboxError);
      expect(eUnknown.code).toBe('ACCESS_DENIED');
    });

    it('maps ERROR_BAD_LENGTH to a generic SandboxError with code BAD_LENGTH', () => {
      const e = mapWin32Error(Win32ErrorCodes.ERROR_BAD_LENGTH);
      expect(e).toBeInstanceOf(SandboxError);
      expect(e.code).toBe('BAD_LENGTH');
    });

    it('maps ERROR_INVALID_PARAMETER to INVALID_PARAMETER', () => {
      const e = mapWin32Error(Win32ErrorCodes.ERROR_INVALID_PARAMETER);
      expect(e.code).toBe('INVALID_PARAMETER');
    });

    it('maps unknown errors to UNKNOWN_WIN32', () => {
      const e = mapWin32Error(99999);
      expect(e).toBeInstanceOf(SandboxError);
      expect(e.code).toBe('UNKNOWN_WIN32');
    });

    it('preserves errno on mapped errors', () => {
      const e = mapWin32Error(Win32ErrorCodes.ERROR_NOT_ENOUGH_QUOTA);
      expect(e.errno).toBe(Win32ErrorCodes.ERROR_NOT_ENOUGH_QUOTA);
    });
  });
});
