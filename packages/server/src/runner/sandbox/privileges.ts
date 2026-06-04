/**
 * Token privilege utilities.
 *
 * Adjusting token privileges is a two-step process:
 *   1. `LookupPrivilegeValueW` translates a name like
 *      "SeAssignPrimaryTokenPrivilege" into a 64-bit LUID.
 *   2. `AdjustTokenPrivileges` applies an array of {LUID, Attributes}
 *      to a token.
 *
 * The default caller token does NOT have SE_ASSIGNPRIMARYTOKEN_PRIVILEGE
 * or SE_INCREASE_QUOTA_PRIVILEGE; on a non-elevated host, attempting to
 * enable them will fail with ERROR_NOT_ALL_ASSIGNED (1300). The light-mode
 * sandbox path does not need either of those, so it works fine.
 */

import { getKoffi } from './koffi-loader.js';
import { PrivilegeError, TokenCreationError, mapWin32Error } from './errors.js';
import { asHandle, handleAsPointer, type Handle, PrivilegeAttributes, PrivilegeNames } from './types.js';

/** A single {LUID, Attributes} pair fed to AdjustTokenPrivileges. */
export interface TokenPrivilegeEntry {
  readonly luid: bigint;
  readonly attributes: number;
}

/** High-level wrapper: enable the given privileges on `token`. */
export function enablePrivileges(token: Handle, ...privilegeNames: string[]): void {
  const entries: TokenPrivilegeEntry[] = [];
  for (const name of privilegeNames) {
    const luid = lookupPrivilegeValueW(null, name);
    entries.push({ luid, attributes: PrivilegeAttributes.SE_PRIVILEGE_ENABLED });
  }
  if (entries.length === 0) return;
  adjustTokenPrivileges(token, false, entries);
}

/** High-level wrapper: disable (remove) the given privileges. */
export function disablePrivileges(token: Handle, ...privilegeNames: string[]): void {
  const entries: TokenPrivilegeEntry[] = [];
  for (const name of privilegeNames) {
    const luid = lookupPrivilegeValueW(null, name);
    entries.push({ luid, attributes: PrivilegeAttributes.SE_PRIVILEGE_REMOVED });
  }
  if (entries.length === 0) return;
  adjustTokenPrivileges(token, false, entries);
}

/**
 * Look up the LUID (Locally Unique Identifier) for a privilege name.
 * `systemName` is always null on Windows for local privilege names.
 */
export function lookupPrivilegeValueW(_systemName: string | null, privilegeName: string): bigint {
  const k = getKoffi();
  const advapi32 = k.load('advapi32.dll');
  const fn = (advapi32 as { func: (s: string) => (...args: unknown[]) => unknown }).func(
    'int __stdcall LookupPrivilegeValueW(void *lpSystemName, const char16_t *lpName, void *lpLuid)',
  );
  // Win32 string APIs expect a null-terminated UTF-16LE string.
  // Buffer.from(s, 'utf16le') does NOT add a null terminator.
  const nameBuf = Buffer.from(privilegeName + '\0', 'utf16le');
  const luidBuf = Buffer.alloc(8);
  const ok = fn(null, nameBuf, luidBuf);
  if (!ok) {
    throw new PrivilegeError(`LookupPrivilegeValueW failed for "${privilegeName}"`, {
      operation: 'lookupPrivilegeValueW',
    });
  }
  return luidBuf.readBigUInt64LE(0);
}

/**
 * Apply a set of privilege changes to a token.
 *
 * Per MSDN, `AdjustTokenPrivileges` may return TRUE even when it
 * could not assign all privileges. The caller MUST call
 * `GetLastError` to check the real status; if it's nonzero, the
 * operation partially or fully failed.
 */
export function adjustTokenPrivileges(
  token: Handle,
  _disableAll: boolean,
  newState: readonly TokenPrivilegeEntry[],
): void {
  const k = getKoffi();
  const advapi32 = k.load('advapi32.dll');
  const fn = (advapi32 as { func: (s: string) => (...args: unknown[]) => unknown }).func(
    'int __stdcall AdjustTokenPrivileges(void *TokenHandle, int DisableAllPrivileges, void *NewState, uint32 BufferLength, void *PreviousState, void *ReturnLength)',
  );
  const GetLastError = (k.load('kernel32.dll') as { func: (s: string) => (...args: unknown[]) => unknown }).func(
    'uint32 GetLastError()',
  );

  // Build a TOKEN_PRIVILEGES struct on the wire.
  // Layout: DWORD PrivilegeCount + DWORD LUID_AND_ATTRIBUTES[n]
  // Each LUID_AND_ATTRIBUTES = LUID (8 bytes) + DWORD Attributes (4 bytes) = 12 bytes
  // We need to add 4 bytes of padding so the array is 8-byte aligned.
  // On x64 the actual struct header is 8 bytes (count + pad).
  const count = newState.length;
  const bufferSize = 8 + count * 12;
  const buf = Buffer.alloc(bufferSize);
  buf.writeUInt32LE(count, 0);
  for (let i = 0; i < count; i++) {
    const e = newState[i]!;
    const off = 8 + i * 12;
    buf.writeBigUInt64LE(e.luid, off);
    buf.writeUInt32LE(e.attributes >>> 0, off + 8);
  }

  const ok = fn(handleAsPointer(token), 0, buf, 0, null, null);
  if (!ok) {
    const errCode = GetLastError() as number;
    throw mapWin32Error(errCode, { operation: 'adjustTokenPrivileges' });
  }
  // AdjustTokenPrivileges returns TRUE even on partial failure;
  // GetLastError tells us if anything was unassigned.
  const realErr = GetLastError() as number;
  if (realErr !== 0) {
    throw mapWin32Error(realErr, { operation: 'adjustTokenPrivileges' });
  }
}

/**
 * RAII guard: enables the named privileges on a token at construction
 * and disables them on dispose.
 *
 * Use case: the spike / runner may need to briefly enable
 * SE_DEBUG_PRIVILEGE for a sensitive operation, then turn it off.
 */
export class PrivilegeGuard implements Disposable {
  private _token: Handle | null;
  private readonly _privileges: readonly string[];

  constructor(token: Handle, ...privileges: string[]) {
    this._token = asHandle(Buffer.from(token));
    this._privileges = privileges;
    if (privileges.length > 0) {
      enablePrivileges(token, ...privileges);
    }
  }

  get token(): Handle {
    if (!this._token) {
      throw new TokenCreationError('PrivilegeGuard has been disposed', {
        operation: 'PrivilegeGuard.token',
      });
    }
    return this._token;
  }

  dispose(): void {
    if (!this._token) return;
    try {
      disablePrivileges(this._token, ...this._privileges);
    } catch {
      // best effort
    }
    this._token = null;
  }

  [Symbol.dispose](): void {
    this.dispose();
  }
}

/** Re-export for convenience. */
export { PrivilegeNames };
