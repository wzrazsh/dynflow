/**
 * Current-process token utilities.
 *
 * The "current process" here is the Node.js host (`dynflow server`).
 * We open a handle to its primary token, duplicate it as a primary
 * token, and use that duplicated handle as the hToken argument to
 * `CreateProcessAsUserW`.
 *
 * All handles returned by these functions are RAII-wrapped (Handle
 * class) so they are closed automatically via try/finally or TS
 * `using` declarations.
 */

import { getKoffi } from './koffi-loader.js';
import { TokenCreationError, mapWin32Error } from './errors.js';
import { asHandle, TokenAccess, handleAsPointer, type Handle, makeHandle } from './types.js';

// Security impersonation level (SECURITY_IMPERSONATION_LEVEL)
const SecurityAnonymous = 0;
const SecurityIdentification = 1;
const SecurityImpersonation = 2;
const SecurityDelegation = 3;

// Token type (TOKEN_TYPE)
const TokenPrimary = 1;
const TokenImpersonation = 2;

/**
 * Open a handle to the current process's primary token.
 * The returned handle is the caller's responsibility to close.
 */
export function getCurrentProcessToken(tokenAccess: number = TokenAccess.TOKEN_ALL_ACCESS): Handle {
  const k = getKoffi();
  const kernel32 = k.load('kernel32.dll');
  const advapi32 = k.load('advapi32.dll');
  const GetCurrentProcess = (kernel32 as { func: (s: string) => (...args: unknown[]) => unknown }).func(
    'void *GetCurrentProcess()',
  );
  const OpenProcessToken = (advapi32 as { func: (s: string) => (...args: unknown[]) => unknown }).func(
    'int __stdcall OpenProcessToken(void *ProcessHandle, uint32 DesiredAccess, void **TokenHandle)',
  );
  const GetLastError = (kernel32 as { func: (s: string) => (...args: unknown[]) => unknown }).func(
    'uint32 GetLastError()',
  );

  const hProcess = GetCurrentProcess() as number;
  const outPtr = Buffer.alloc(8);
  const ok = OpenProcessToken(hProcess, tokenAccess >>> 0, outPtr);
  if (!ok) {
    const err = GetLastError() as number;
    throw mapWin32Error(err, { operation: 'openProcessToken' });
  }
  return asHandle(outPtr);
}

/**
 * Duplicate a token (primary or impersonation) into a new primary token
 * suitable for `CreateProcessAsUserW`.
 *
 * The duplicated token is independent of the source — closing the source
 * does not invalidate it.
 */
export function duplicateTokenEx(
  sourceToken: Handle,
  desiredAccess: number = TokenAccess.TOKEN_ALL_ACCESS,
  options: {
    readonly impersonationLevel?: 'anonymous' | 'identification' | 'impersonation' | 'delegation';
    readonly tokenType?: 'primary' | 'impersonation';
  } = {},
): Handle {
  const k = getKoffi();
  const advapi32 = k.load('advapi32.dll');
  const DuplicateTokenEx = (advapi32 as { func: (s: string) => (...args: unknown[]) => unknown }).func(
    'int __stdcall DuplicateTokenEx(void *hExistingToken, uint32 dwDesiredAccess, void *lpTokenAttributes, int ImpersonationLevel, int TokenType, void **phNewToken)',
  );
  const kernel32 = k.load('kernel32.dll');
  const GetLastError = (kernel32 as { func: (s: string) => (...args: unknown[]) => unknown }).func(
    'uint32 GetLastError()',
  );

  const impMap: Record<string, number> = {
    anonymous: SecurityAnonymous,
    identification: SecurityIdentification,
    impersonation: SecurityImpersonation,
    delegation: SecurityDelegation,
  };
  const tokenTypeMap: Record<string, number> = {
    primary: TokenPrimary,
    impersonation: TokenImpersonation,
  };

  const impLevel = impMap[options.impersonationLevel ?? 'identification']!;
  const tokType = tokenTypeMap[options.tokenType ?? 'primary']!;

  const outPtr = Buffer.alloc(8);
  // Pass the source handle as a 64-bit pointer (Koffi `void *`).
  const sourcePtr = handleAsPointer(sourceToken);
  // lpTokenAttributes is null (no security inheritance).
  const ok = DuplicateTokenEx(sourcePtr, desiredAccess >>> 0, null, impLevel, tokType, outPtr);
  if (!ok) {
    const err = GetLastError() as number;
    throw mapWin32Error(err, { operation: 'duplicateTokenEx' });
  }
  return asHandle(outPtr);
}

/**
 * Check if `processHandle` is already in a job. Pass `null` for
 * `jobHandle` to test membership in ANY job on the system.
 */
export function isProcessInJob(processHandle: Handle, jobHandle: Handle | null): boolean {
  const k = getKoffi();
  const kernel32 = k.load('kernel32.dll');
  const fn = (kernel32 as { func: (s: string) => (...args: unknown[]) => unknown }).func(
    'int __stdcall IsProcessInJob(void *ProcessHandle, void *JobHandle, int *Result)',
  );
  const outBuf = Buffer.alloc(4);
  const procPtr = handleAsPointer(processHandle);
  const jobPtr = jobHandle ? handleAsPointer(jobHandle) : 0n;
  const ok = fn(procPtr, jobPtr, outBuf);
  if (!ok) {
    throw new TokenCreationError('IsProcessInJob failed', { operation: 'isProcessInJob' });
  }
  return outBuf.readInt32LE(0) !== 0;
}

/**
 * Close a handle opened by any of the other helpers in this module
 * or by Win32 APIs that return HANDLEs. Safe to call on a null handle
 * or an already-closed handle (best effort, swallows errors).
 */
export function closeHandle(handle: Handle): void {
  if (!handle || handle.length === 0) return;
  const k = getKoffi();
  const kernel32 = k.load('kernel32.dll');
  const fn = (kernel32 as { func: (s: string) => (...args: unknown[]) => unknown }).func(
    'int __stdcall CloseHandle(void *hObject)',
  );
  try {
    const ptr = handleAsPointer(handle);
    if (ptr !== 0n) {
      fn(ptr);
    }
  } catch {
    // best effort
  }
  // Mark as closed by zeroing (in-place).
  handle.fill(0);
}

/**
 * Get a pseudo-handle to the current process. The pseudo-handle does
 * NOT need to be closed (it's not a real handle), and behaves as -1
 * when interpreted as a signed integer.
 *
 * On 64-bit Windows, the pseudo-handle value is 0xFFFFFFFFFFFFFFFF
 * (-1 as a signed 64-bit integer). On 32-bit it's 0xFFFFFFFF.
 * We store the 64-bit value so the handle is correct in either arch.
 */
export function getCurrentProcess(): Handle {
  return makeHandle(0xffffffffffffffffn);
}

/**
 * RAII wrapper for a Win32 HANDLE. Calls `closeHandle` on `dispose()`.
 * Multiple dispose() calls are safe (idempotent).
 */
export class HandleImpl implements Disposable {
  private _handle: Handle | null;
  public readonly value: number;

  constructor(handle: Handle) {
    this._handle = handle;
    this.value = handle.readUInt32LE(0);
  }

  get handle(): Handle {
    if (!this._handle) {
      throw new TokenCreationError('Handle has been disposed', { operation: 'Handle.handle' });
    }
    return this._handle;
  }

  get disposed(): boolean {
    return this._handle === null;
  }

  /** Return the raw numeric value (low 32 bits). */
  get rawValue(): number {
    return this.value;
  }

  dispose(): void {
    if (this._handle) {
      closeHandle(this._handle);
      this._handle = null;
    }
  }

  [Symbol.dispose](): void {
    this.dispose();
  }
}
