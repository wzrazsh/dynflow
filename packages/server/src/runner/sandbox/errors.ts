/**
 * Typed error classes for the Windows native sandbox.
 *
 * All sandbox errors derive from `SandboxError` so callers can catch
 * the entire family with a single catch. Each subclass carries a
 * numeric `errno` (Win32 error code) when applicable, plus a stable
 * `code` string for programmatic matching.
 *
 * On non-Windows platforms, every error type can still be constructed
 * and matched (so unit tests pass on Linux/macOS), but the FFI loader
 * throws `SandboxUnsupportedError` at the boundary.
 */

import { Win32ErrorCodes } from './types.js';

export interface SandboxErrorContext {
  /** Win32 error code, if available. */
  readonly errno?: number;
  /** Originating Win32 API call (e.g., "CreateProcessAsUserW"). */
  readonly operation?: string;
  /** Underlying cause, if any. */
  readonly cause?: unknown;
}

/**
 * Base class for all sandbox-related errors. Subclasses add a stable
 * `code` string used by callers for programmatic matching.
 */
export class SandboxError extends Error {
  public readonly code: string;
  public readonly errno?: number;
  public readonly operation?: string;

  constructor(message: string, code: string, context: SandboxErrorContext = {}) {
    super(formatMessage(message, context));
    this.name = this.constructor.name;
    this.code = code;
    this.errno = context.errno;
    this.operation = context.operation;
    if (context.cause !== undefined) {
      (this as Error & { cause?: unknown }).cause = context.cause;
    }
  }
}

/**
 * The sandbox cannot run on this platform (non-Windows, missing koffi
 * native binding, or unsupported architecture).
 */
export class SandboxUnsupportedError extends SandboxError {
  constructor(message: string, context: SandboxErrorContext = {}) {
    super(message, 'SANDBOX_UNSUPPORTED', context);
  }
}

/**
 * A privilege required for the operation is not held by the current
 * token (e.g., SE_ASSIGNPRIMARYTOKEN_PRIVILEGE). On Windows this maps
 * to ERROR_PRIVILEGE_NOT_HELD (1314) or ERROR_NOT_ALL_ASSIGNED (1300).
 */
export class PrivilegeError extends SandboxError {
  constructor(message: string, context: SandboxErrorContext = {}) {
    super(message, 'PRIVILEGE_NOT_HELD', context);
  }
}

/**
 * Failure creating, duplicating, or otherwise manipulating a Windows
 * access token (OpenProcessToken, DuplicateTokenEx, CreateRestrictedToken).
 */
export class TokenCreationError extends SandboxError {
  constructor(message: string, context: SandboxErrorContext = {}) {
    super(message, 'TOKEN_CREATION_FAILED', context);
  }
}

/**
 * Failure creating or configuring a Job Object (CreateJobObjectW,
 * SetInformationJobObject, AssignProcessToJobObject).
 */
export class JobObjectError extends SandboxError {
  constructor(message: string, context: SandboxErrorContext = {}) {
    super(message, 'JOB_OBJECT_FAILED', context);
  }
}

/**
 * Failure spawning a process via CreateProcessAsUserW.
 */
export class ProcessCreationError extends SandboxError {
  constructor(message: string, context: SandboxErrorContext = {}) {
    super(message, 'PROCESS_CREATION_FAILED', context);
  }
}

/**
 * Failure manipulating DACLs / security descriptors (SetEntriesInAclW,
 * SetNamedSecurityInfo, GetNamedSecurityInfo).
 */
export class DaclError extends SandboxError {
  constructor(message: string, context: SandboxErrorContext = {}) {
    super(message, 'DACL_FAILED', context);
  }
}

function formatMessage(message: string, context: SandboxErrorContext): string {
  const parts: string[] = [message];
  if (context.operation) parts.push(`(op=${context.operation})`);
  if (context.errno !== undefined) parts.push(`(errno=${context.errno})`);
  return parts.join(' ');
}

/**
 * Map a Win32 error code to the most specific typed error.
 *
 * Mapping is based on what callers can recover from:
 *   - 5 / 1300 / 1314 -> PrivilegeError (or TokenCreationError if op is token-related)
 *   - 1314 -> PrivilegeError specifically
 *   - 1816 -> ProcessCreationError (quota)
 *   - 87 / 24 -> SandboxError (parameter error; usually a bug)
 *
 * Callers may pass `operation` to disambiguate; e.g. ERROR_ACCESS_DENIED
 * during DuplicateTokenEx is TokenCreationError, during CreateProcessAsUserW
 * is ProcessCreationError.
 */
export function mapWin32Error(errno: number, context: Omit<SandboxErrorContext, 'errno'> = {}): SandboxError {
  const op = (context.operation ?? '').toLowerCase();
  const message = errorMessageFor(errno);

  if (errno === Win32ErrorCodes.ERROR_PRIVILEGE_NOT_HELD) {
    return new PrivilegeError(message, { errno, ...context });
  }
  if (errno === Win32ErrorCodes.ERROR_NOT_ALL_ASSIGNED) {
    return new PrivilegeError(message, { errno, ...context });
  }
  if (errno === Win32ErrorCodes.ERROR_ACCESS_DENIED) {
    // Check most-specific keywords first. "assignprocess" contains "process"
    // but should be classified as JobObjectError.
    if (op.includes('assignprocess') || op.includes('job')) {
      return new JobObjectError(message, { errno, ...context });
    }
    if (op.includes('token') || op.includes('privilege')) {
      return new TokenCreationError(message, { errno, ...context });
    }
    if (op.includes('process') || op.includes('createprocess')) {
      return new ProcessCreationError(message, { errno, ...context });
    }
    if (op.includes('dacl') || op.includes('security') || op.includes('acl')) {
      return new DaclError(message, { errno, ...context });
    }
    return new SandboxError(message, 'ACCESS_DENIED', { errno, ...context });
  }
  if (errno === Win32ErrorCodes.ERROR_NOT_ENOUGH_QUOTA) {
    return new ProcessCreationError(message, { errno, ...context });
  }
  if (errno === Win32ErrorCodes.ERROR_BAD_LENGTH) {
    return new SandboxError(message, 'BAD_LENGTH', { errno, ...context });
  }
  if (errno === Win32ErrorCodes.ERROR_INVALID_PARAMETER) {
    return new SandboxError(message, 'INVALID_PARAMETER', { errno, ...context });
  }
  if (errno === Win32ErrorCodes.ERROR_INVALID_HANDLE) {
    // Try to disambiguate based on operation keyword.
    if (op.includes('token') || op.includes('privilege')) {
      return new TokenCreationError(message, { errno, ...context });
    }
    if (op.includes('process') || op.includes('createprocess')) {
      return new ProcessCreationError(message, { errno, ...context });
    }
    if (op.includes('assignprocess') || op.includes('job')) {
      return new JobObjectError(message, { errno, ...context });
    }
    return new SandboxError(message, 'INVALID_HANDLE', { errno, ...context });
  }
  return new SandboxError(message, 'UNKNOWN_WIN32', { errno, ...context });
}

function errorMessageFor(errno: number): string {
  switch (errno) {
    case Win32ErrorCodes.ERROR_SUCCESS:
      return 'Success (no error)';
    case Win32ErrorCodes.ERROR_ACCESS_DENIED:
      return 'Access is denied';
    case Win32ErrorCodes.ERROR_INVALID_HANDLE:
      return 'The handle is invalid';
    case Win32ErrorCodes.ERROR_INVALID_PARAMETER:
      return 'The parameter is incorrect';
    case Win32ErrorCodes.ERROR_NOT_ENOUGH_QUOTA:
      return 'Not enough quota is available to process this command';
    case Win32ErrorCodes.ERROR_PRIVILEGE_NOT_HELD:
      return 'A required privilege is not held by the client';
    case Win32ErrorCodes.ERROR_NOT_ALL_ASSIGNED:
      return 'Not all privileges or groups referenced are assigned to the caller';
    case Win32ErrorCodes.ERROR_BAD_LENGTH:
      return 'The system call level is not correct';
    default:
      return `Win32 error ${errno}`;
  }
}
