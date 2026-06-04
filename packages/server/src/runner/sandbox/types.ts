/**
 * Common types, constants, and runtime struct-size verification for the
 * Windows native sandbox.
 *
 * On non-Windows platforms, the constants and the `verifyStructSizes`
 * function are still importable. `verifyStructSizes` throws a clear
 * `Error` with a stable `code` field when invoked there, which lets
 * test files express "this only runs on Windows" cleanly.
 */

/**
 * A Win32 HANDLE. The value is stored in an 8-byte little-endian
 * Buffer so it can be passed to Koffi as a `void *` without going
 * through BigInt conversions on every call.
 *
 * The Handle is a *pointer holder*: when Win32 APIs write to a
 * `void **` output parameter, they write the pointer into the
 * buffer's first 8 bytes. To pass a Handle to a function expecting
 * `void *`, read the 64-bit pointer with `handleAsPointer(handle)`
 * and pass the bigint — Koffi accepts bigint for `void *`.
 */
export type Handle = Buffer & { readonly __handleBrand: unique symbol };

/** Create a Handle wrapping a numeric pointer value. */
export function makeHandle(value: number | bigint): Handle {
  const buf = Buffer.alloc(8);
  if (typeof value === 'bigint') {
    buf.writeBigUInt64LE(value, 0);
  } else {
    // Treat as unsigned 32-bit, stored low 32 bits.
    buf.writeUInt32LE(value >>> 0, 0);
  }
  return buf as Handle;
}

/** Read a Handle's numeric value (low 32 bits). */
export function getHandleValue(handle: Handle): number {
  return handle.readUInt32LE(0);
}

/** Read a Handle's value as a 64-bit BigInt (the actual pointer). */
export function getHandleValue64(handle: Handle): bigint {
  return handle.readBigUInt64LE(0);
}

/**
 * Get a Handle's value as a bigint suitable to pass to a Koffi
 * function expecting `void *` (e.g., when calling DuplicateTokenEx
 * with a source handle).
 */
export function handleAsPointer(handle: Handle): bigint {
  return handle.readBigUInt64LE(0);
}

/**
 * Read a 64-bit pointer from any 8-byte buffer-shaped object.
 * Useful for SID and Handle types interchangeably when both are
 * just pointer holders.
 */
export function readPointer(buf: Buffer): bigint {
  return buf.readBigUInt64LE(0);
}

/**
 * Opaque pointer to a Win32 SID. Always use `getSidLength(sid)` to
 * discover its size — do not assume any fixed length.
 */
export type SID = Buffer & { readonly __sidBrand: unique symbol };

/** Cast a raw Buffer to a SID handle. Caller is responsible for ownership. */
export function asSid(buf: Buffer): SID {
  return buf as SID;
}

/** Cast a raw Buffer to a Handle. Caller is responsible for ownership. */
export function asHandle(buf: Buffer): Handle {
  return buf as Handle;
}

/** Access rights for tokens. */
export const TokenAccess = {
  TOKEN_ASSIGN_PRIMARY: 0x0001,
  TOKEN_DUPLICATE: 0x0002,
  TOKEN_IMPERSONATE: 0x0004,
  TOKEN_QUERY: 0x0008,
  TOKEN_QUERY_SOURCE: 0x0010,
  TOKEN_ADJUST_PRIVILEGES: 0x0020,
  TOKEN_ADJUST_GROUPS: 0x0040,
  TOKEN_ADJUST_DEFAULT: 0x0080,
  TOKEN_ADJUST_SESSIONID: 0x0100,
  TOKEN_ALL_ACCESS: 0x000f01ff,
  TOKEN_READ: 0x000200e8,
} as const;

/** Process creation flags. */
export const ProcessCreationFlags = {
  DEBUG_PROCESS: 0x00000001,
  DEBUG_ONLY_THIS_PROCESS: 0x00000002,
  CREATE_SUSPENDED: 0x00000004,
  DETACHED_PROCESS: 0x00000008,
  CREATE_NEW_CONSOLE: 0x00000010,
  CREATE_NEW_PROCESS_GROUP: 0x00000200,
  CREATE_UNICODE_ENVIRONMENT: 0x00000400,
  CREATE_SEPARATE_WOW_VDM: 0x00000800,
  CREATE_SHARED_WOW_VDM: 0x00001000,
  CREATE_FORCEDOS: 0x00002000,
  CREATE_IGNORE_SYSTEM_DEFAULT: 0x80000000,
  CREATE_NO_WINDOW: 0x08000000,
  CREATE_PROTECTED_PROCESS: 0x00000040,
  CREATE_BREAKAWAY_FROM_JOB: 0x01000000,
  CREATE_PRESERVE_CODE_AUTHZ_LEVEL: 0x02000000,
  CREATE_DEFAULT_ERROR_MODE: 0x04000000,
  CREATE_SECURE_PROCESS: 0x00000080,
} as const;

/** STARTF_* flags for the STARTUPINFOW `dwFlags` field. */
export const StartupInfoFlags = {
  STARTF_USESHOWWINDOW: 0x00000001,
  STARTF_USESIZE: 0x00000002,
  STARTF_USEPOSITION: 0x00000004,
  STARTF_USECOUNTCHARS: 0x00000008,
  STARTF_USEFILLATTRIBUTE: 0x00000010,
  STARTF_RUNFULLSCREEN: 0x00000020,
  STARTF_FORCEONFEEDBACK: 0x00000040,
  STARTF_FORCEOFFFEEDBACK: 0x00000080,
  STARTF_USESTDHANDLES: 0x00000100,
  STARTF_USEHOTKEY: 0x00000200,
  STARTF_TITLEISLINKNAME: 0x00000800,
  STARTF_TITLEISAPPID: 0x00001000,
  STARTF_PREVENTPINNING: 0x00002000,
  STARTF_UNTRUSTEDSOURCE: 0x00008000,
} as const;

/** Privileges commonly enabled/disabled. */
export const PrivilegeNames = {
  SE_ASSIGNPRIMARYTOKEN_PRIVILEGE: 'SeAssignPrimaryTokenPrivilege',
  SE_INCREASE_QUOTA_PRIVILEGE: 'SeIncreaseQuotaPrivilege',
  SE_DEBUG_PRIVILEGE: 'SeDebugPrivilege',
  SE_TCB_NAME: 'SeTcbPrivilege',
  SE_RESTORE_NAME: 'SeRestorePrivilege',
  SE_BACKUP_NAME: 'SeBackupPrivilege',
  SE_SHUTDOWN_NAME: 'SeShutdownPrivilege',
} as const;

/** SE_PRIVILEGE_* attribute values for AdjustTokenPrivileges. */
export const PrivilegeAttributes = {
  SE_PRIVILEGE_ENABLED: 0x00000002,
  SE_PRIVILEGE_ENABLED_BY_DEFAULT: 0x00000001,
  SE_PRIVILEGE_REMOVED: 0x00000004,
  SE_PRIVILEGE_USED_FOR_ACCESS: 0x80000000,
} as const;

/** Restricted-token creation flags (CREATE_RESTRICTED_TOKEN flags). */
export const RestrictedTokenFlags = {
  SANDBOX_INERT: 0x0004,
  LUA_TOKEN: 0x0004,
  WRITE_RESTRICTED: 0x0008,
  DISABLE_MAX_PRIVILEGE: 0x0800,
} as const;

/** Job-object limit flags. */
export const JobObjectLimits = {
  JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE: 0x2000,
  JOB_OBJECT_LIMIT_BREAKAWAY_OK: 0x0800,
  JOB_OBJECT_LIMIT_BREAKAWAY_OUT: 0x0200,
  JOB_OBJECT_LIMIT_SILENT_BREAKAWAY_OK: 0x1000,
  JOB_OBJECT_LIMIT_PROCESS_MEMORY: 0x0100,
  JOB_OBJECT_LIMIT_JOB_MEMORY: 0x0200,
  JOB_OBJECT_LIMIT_DIE_ON_UNHANDLED_EXCEPTION: 0x0400,
  JOB_OBJECT_LIMIT_ACTIVE_PROCESS: 0x0008,
} as const;

/** Standard Win32 error codes used by the sandbox. */
export const Win32ErrorCodes = {
  ERROR_SUCCESS: 0,
  ERROR_ACCESS_DENIED: 5,
  ERROR_INVALID_HANDLE: 6,
  ERROR_INVALID_PARAMETER: 87,
  ERROR_NOT_ENOUGH_QUOTA: 1816,
  ERROR_PRIVILEGE_NOT_HELD: 1314,
  ERROR_NOT_ALL_ASSIGNED: 1300,
  ERROR_BAD_LENGTH: 24,
  ERROR_FILE_NOT_FOUND: 2,
  ERROR_PATH_NOT_FOUND: 3,
  ERROR_ALREADY_EXISTS: 183,
} as const;

/** Verifier metadata for a struct definition. */
export interface StructSpec {
  readonly name: string;
  /** Expected size in bytes on x64. */
  readonly expectedSize: number;
  /** Koffi struct handle (so we can call koffi.sizeof). */
  readonly koffiStruct: unknown;
}

/**
 * Verify a set of Win32 struct sizes at runtime.
 *
 * Why: Koffi struct definitions are a JS-side description that must
 * match the C/asm layout bit-for-bit. A typo in field order or a
 * missing alignment pad leads to silent memory corruption (writes
 * go to the wrong place, or koffi.sizeof returns the wrong number
 * and the OS rejects the call with ERROR_BAD_LENGTH). This check
 * runs once at module load and bails loudly if anything is off.
 *
 * On non-Windows, throws SandboxUnsupportedError.
 */
export function verifyStructSizes(koffi: { sizeof: (s: unknown) => number }, specs: readonly StructSpec[]): void {
  if (process.platform !== 'win32') {
    const err = new Error('verifyStructSizes can only run on Windows');
    (err as Error & { code: string }).code = 'SANDBOX_UNSUPPORTED';
    throw err;
  }
  for (const spec of specs) {
    let actual: number;
    try {
      actual = koffi.sizeof(spec.koffiStruct);
    } catch (e) {
      const err = new Error(`koffi.sizeof failed for ${spec.name}: ${String(e)}`);
      (err as Error & { code: string }).code = 'SANDBOX_UNSUPPORTED';
      throw err;
    }
    if (actual !== spec.expectedSize) {
      throw new Error(
        `Struct size mismatch for ${spec.name}: expected ${spec.expectedSize}, got ${actual}. ` +
          'Check field order, padding, and pointer width. This is a serious bug that would cause silent memory corruption.',
      );
    }
  }
}

/** Known struct sizes on Windows x64. Used by verifyStructSizes callers. */
export const ExpectedStructSizes = {
  STARTUPINFOW: 104,
  STARTUPINFOEXW: 112,
  PROCESS_INFORMATION: 24,
  SECURITY_ATTRIBUTES: 24,
  JOBOBJECT_BASIC_LIMIT_INFORMATION: 48,
  JOBOBJECT_EXTENDED_LIMIT_INFORMATION: 144,
  IO_COUNTERS: 48,
  LUID: 8,
  LUID_AND_ATTRIBUTES: 12,
  TOKEN_PRIVILEGES: 16, // 4 (count) + 4 (pad) + 12 * 1 typical; header is 8
  SID: 12, // minimum; actual is variable
  ACL: 8, // header
  EXPLICIT_ACCESS_W: 48,
  SECURITY_DESCRIPTOR: 40,
} as const;
