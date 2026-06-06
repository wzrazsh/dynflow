/**
 * DACL (Discretionary Access Control List) manipulation.
 *
 * Used in **strict mode** to make the workspace accessible only to a
 * synthetic SID created for the sandbox. The original DACL is always
 * backed up before modification so it can be restored on cleanup.
 *
 * The flow:
 *   1. `getPathDacl(path)` — read the existing DACL (backup).
 *   2. `buildDacl({grantedSids})` — build a new DACL with explicit
 *      allow ACEs for the granted SIDs.
 *   3. `applyDaclToPath(path, acl)` — apply the new DACL to the path.
 *   4. ... (do sandbox work) ...
 *   5. `restorePathDacl(path, originalAcl)` — restore from backup.
 *   6. `freeAcl(acl)` — free the ACL buffer.
 *
 * SECURITY: DACLs are persistent on disk. If the server crashes between
 * step 3 and step 5, the workspace will be locked out. The cleanup
 * script `Remove-SandboxProfile.ps1` is the manual recovery path.
 */

import { getKoffi } from './koffi-loader.js';
import { DaclError, mapWin32Error } from './errors.js';
import { readPointer, type SID } from './types.js';

/** Access mask constants for file generic access. */
export const FileAccessMask = {
  FILE_GENERIC_READ: 0x00120089,
  FILE_GENERIC_WRITE: 0x00120116,
  FILE_GENERIC_EXECUTE: 0x001200a0,
  FILE_GENERIC_ALL: 0x001f01ff,
} as const;

/** Access mask constants for directory generic access. */
export const DirectoryAccessMask = {
  DIR_GENERIC_READ: 0x00120089,
  DIR_GENERIC_WRITE: 0x00120116,
  DIR_GENERIC_EXECUTE: 0x001200a0,
} as const;

/** Opaque pointer to a Win32 ACL structure. */
export type ACL = Buffer & { readonly __aclBrand: unique symbol };

/** Cast a raw Buffer to an ACL handle. */
export function asAcl(buf: Buffer): ACL {
  return buf as ACL;
}

/** Security descriptor flags used by SetNamedSecurityInfo. */
const DACL_SECURITY_INFORMATION = 0x00000004;
const UNPROTECTED_DACL_SECURITY_INFORMATION = 0x01000000;

/** SE_OBJECT_TYPE for file/directory. */
const SE_FILE_OBJECT = 1;

/** Cached koffi struct handle. */
let explicitAccessT: unknown | null = null;

/** TRUSTEE form. TRUSTEE_IS_SID = 0 means the Trustee union is a PSID. */
const TRUSTEE_IS_SID = 0;
const TRUSTEE_IS_USER = 1;

/** Inheritance flags. */
const OBJECT_INHERIT_ACE = 0x01;
const CONTAINER_INHERIT_ACE = 0x02;

/** Access modes for EXPLICIT_ACCESS_W. */
const GRANT_ACCESS = 2;
const DENY_ACCESS = 1;

/** Grant mode for `buildDacl`. */
export type DaclGrantMode = 'grant' | 'deny';

/** A single ACE entry: { SID, access mask, mode }. */
export interface DaclEntry {
  readonly sid: SID;
  readonly accessMask: number;
  readonly mode: DaclGrantMode;
}

/**
 * Build a new ACL with the given entries.
 * Uses `SetEntriesInAclW` and `LocalAlloc` under the hood.
 * The returned ACL must be freed with `freeAcl`.
 */
export function buildDacl(entries: readonly DaclEntry[]): ACL {
  if (entries.length === 0) {
    throw new DaclError('buildDacl requires at least one entry', { operation: 'buildDacl' });
  }
  const k = getKoffi();
  const advapi32 = k.load('advapi32.dll');
  const kernel32 = k.load('kernel32.dll');
  const SetEntriesInAclW = (
    advapi32 as { func: (s: string) => (...args: unknown[]) => unknown })
      .func('uint32 __stdcall SetEntriesInAclW(uint32 cCountOfExplicitEntries, void *pListOfExplicitEntries, void *OldAcl, void **NewAcl)');
  const GetLastError = (kernel32 as { func: (s: string) => (...args: unknown[]) => unknown }).func(
    'uint32 GetLastError()',
  );

  // EXPLICIT_ACCESS_W is 48 bytes on x64. The Trustee field is an
  // EMBEDDED TRUSTEE_W struct (32 bytes), not a pointer.
  //
  // Layout:
  //   DWORD grfAccessPermissions;     // offset 0
  //   DWORD grfAccessMode;            // offset 4
  //   DWORD grfInheritance;           // offset 8
  //   // 4 bytes of implicit padding to align the next field to 8
  //   TRUSTEE_W Trustee;              // offset 16, 32 bytes
  // Total: 48
  if (!explicitAccessT) {
    explicitAccessT = k.struct('__dynflow_explicit_access_w', {
      grfAccessPermissions: 'uint32',
      grfAccessMode: 'uint32',
      grfInheritance: 'uint32',
      __pad0: 'uint32', // 4 bytes of padding to align Trustee to 8
      // Embedded TRUSTEE_W (32 bytes). The first 4 fields are 4 bytes
      // each (16 bytes), then ptstrName is 8-byte pointer at offset 24.
      // We don't need a __pad1 — the natural alignment of the struct
      // gives us 32 bytes total.
      pMultipleTrustee: 'void *',
      MultipleTrusteeOperation: 'int32',
      TrusteeForm: 'int32',
      TrusteeType: 'int32',
      ptstrName: 'void *', // union member — the only one we set
    });
  }

  // Allocate the EXPLICIT_ACCESS_W array on the koffi heap.
  const eaHeap = k.alloc(explicitAccessT, entries.length) as unknown;

  // Populate each entry. Koffi's encode(ref, offset, type, value)
  // writes a single struct at a byte offset within the heap.
  for (let i = 0; i < entries.length; i++) {
    const e = entries[i]!;
    const sidPtr = readPointer(e.sid);
    const modeCode = e.mode === 'grant' ? GRANT_ACCESS : DENY_ACCESS;
    k.encode(eaHeap, i * 48, explicitAccessT, {
      grfAccessPermissions: e.accessMask >>> 0,
      grfAccessMode: modeCode,
      grfInheritance: OBJECT_INHERIT_ACE | CONTAINER_INHERIT_ACE,
      pMultipleTrustee: null,
      MultipleTrusteeOperation: 0,
      TrusteeForm: TRUSTEE_IS_SID,
      TrusteeType: TRUSTEE_IS_USER,
      ptstrName: sidPtr,
    });
  }

  // SetEntriesInAclW(cCount, pList, OldAcl, &NewAcl).
  // We need to pass the eaHeap as a `void *` (uintptr_t). Get its address.
  const eaBase = k.address(eaHeap) as bigint;
  const newAclPtr = Buffer.alloc(8);
  const result = SetEntriesInAclW(entries.length, eaBase, null, newAclPtr) as number;
  // Free the temporary heap — SetEntriesInAclW copies what it needs.
  k.free(eaHeap);
  if (result !== 0) {
    throw mapWin32Error(result, { operation: 'buildDacl' });
  }
  // The returned NewAcl is a LocalAlloc'd PACL. We return a 64-bit
  // pointer (bigint) wrapped in an 8-byte Buffer so callers can
  // forward it to other APIs.
  const aclAddr = newAclPtr.readBigUInt64LE(0);
  if (aclAddr === 0n) {
    const errCode = GetLastError() as number;
    throw mapWin32Error(errCode, { operation: 'buildDacl' });
  }
  return asAcl(newAclPtr);
}

/**
 * Apply an ACL to a path (file or directory).
 * Caller should backup the original ACL first via `getPathDacl`.
 */
export function applyDaclToPath(path: string, acl: ACL, _inherit: boolean = true): void {
  void _inherit;
  if (!acl || readPointer(acl) === 0n) {
    throw new DaclError('applyDaclToPath: ACL is null or empty', { operation: 'applyDaclToPath' });
  }
  const k = getKoffi();
  const advapi32 = k.load('advapi32.dll');
  const fn = (advapi32 as { func: (s: string) => (...args: unknown[]) => unknown }).func(
    'uint32 __stdcall SetNamedSecurityInfoW(char16_t *pObjectName, uint32 ObjectType, uint32 SecurityInfo, void *pOwner, void *pGroup, void *pDacl, void *pSacl)',
  );
  const pathBuf = Buffer.from(path + '\0', 'utf16le');
  const info = DACL_SECURITY_INFORMATION | UNPROTECTED_DACL_SECURITY_INFORMATION;
  // For `void *pDacl` (a pointer value, not output param), pass the
  // bigint address.
  const aclAddr = readPointer(acl);
  const result = fn(pathBuf, SE_FILE_OBJECT, info, null, null, aclAddr, null) as number;
  if (result !== 0) {
    throw mapWin32Error(result, { operation: 'applyDaclToPath' });
  }
}

/** Read the current DACL from a path (for backup).
 *  Returns the security descriptor handle (caller must call
 *  `freeAcl` on the returned ACL).
 *
 *  IMPORTANT: We must request the full security descriptor
 *  (DACL_SECURITY_INFORMATION | OWNER_SECURITY_INFORMATION |
 *  GROUP_SECURITY_INFORMATION) so that the DACL pointer is part of
 *  a single allocated block. Freeing a sub-pointer is undefined. */
export function getPathDacl(path: string): ACL {
  const k = getKoffi();
  const advapi32 = k.load('advapi32.dll');
  const fn = (advapi32 as { func: (s: string) => (...args: unknown[]) => unknown }).func(
    'uint32 __stdcall GetNamedSecurityInfoW(const char16_t *pObjectName, uint32 ObjectType, uint32 SecurityInfo, void **pOwner, void **pGroup, void **pDacl, void **pSacl, void **ppSecurityDescriptor)',
  );
  const pathBuf = Buffer.from(path + '\0', 'utf16le');
  // Request DACL + owner + group (3 | 4 | 0x10) so the returned buffer
  // is one LocalAlloc'd block. We return the security descriptor
  // pointer (last output param) so freeAcl can release it.
  const OWNER_SECURITY_INFORMATION = 0x00000001;
  const GROUP_SECURITY_INFORMATION = 0x00000002;
  const secDescPtr = Buffer.alloc(8);
  const result = fn(
    pathBuf,
    SE_FILE_OBJECT,
    DACL_SECURITY_INFORMATION | OWNER_SECURITY_INFORMATION | GROUP_SECURITY_INFORMATION,
    null,
    null,
    null, // we don't need the DACL pointer separately
    null,
    secDescPtr,
  ) as number;
  if (result !== 0) {
    throw mapWin32Error(result, { operation: 'getPathDacl' });
  }
  return asAcl(secDescPtr);
}

/** Restore a previously backed-up DACL. */
export function restorePathDacl(path: string, originalAcl: ACL): void {
  applyDaclToPath(path, originalAcl, true);
}

/** Free an ACL buffer (calls LocalFree). */
export function freeAcl(acl: ACL): void {
  if (!acl || acl.length === 0) return;
  const k = getKoffi();
  const kernel32 = k.load('kernel32.dll');
  const fn = (kernel32 as { func: (s: string) => (...args: unknown[]) => unknown }).func(
    'void *LocalFree(void *hMem)',
  );
  try {
    const ptr = readPointer(acl);
    if (ptr !== 0n) {
      fn(ptr);
    }
  } catch {
    // best effort
  }
  acl.fill(0);
}

/**
 * RAII wrapper for a DACL. Tracks the path it was applied to so
 * dispose() can restore the original DACL.
 */
export class DaclHandle implements Disposable {
  private _acl: ACL | null;
  private _originalAcl: ACL | null;
  private readonly _path: string;
  private _applied: boolean;

  constructor(path: string, acl: ACL, originalAcl: ACL | null) {
    this._path = path;
    this._acl = acl;
    this._originalAcl = originalAcl;
    this._applied = false;
  }

  get path(): string {
    return this._path;
  }

  get applied(): boolean {
    return this._applied;
  }

  apply(): void {
    if (this._applied) return;
    if (!this._acl) {
      throw new DaclError('DaclHandle has been disposed', { operation: 'DaclHandle.apply' });
    }
    applyDaclToPath(this._path, this._acl, true);
    this._applied = true;
  }

  restore(): void {
    if (!this._applied) return;
    if (this._originalAcl) {
      try {
        restorePathDacl(this._path, this._originalAcl);
      } catch (e) {
        // Best effort — log and continue. The PowerShell cleanup script
        // is the manual recovery path.
        console.error(`[sandbox] failed to restore DACL on ${this._path}: ${String(e)}`);
      }
    }
    this._applied = false;
  }

  dispose(): void {
    this.restore();
    if (this._acl) {
      freeAcl(this._acl);
      this._acl = null;
    }
    if (this._originalAcl) {
      freeAcl(this._originalAcl);
      this._originalAcl = null;
    }
  }

  [Symbol.dispose](): void {
    this.dispose();
  }
}
