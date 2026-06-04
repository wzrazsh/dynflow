/**
 * Restricted token creation.
 *
 * `CreateRestrictedToken` is the Win32 API that produces a *primary* token
 * with optional restrictions:
 *   - flag combinations (DISABLE_MAX_PRIVILEGE, SANDBOX_INERT,
 *     WRITE_RESTRICTED, LUA_TOKEN, DISABLE_MANDATORY_LABEL)
 *   - "restrict" SIDs that are ADDED to the deny-only list (the resulting
 *     token can no longer use them for access checks, but they still
 *     appear in `GetTokenInformation` so the process knows it has them)
 *   - "deny" SIDs (explicitly disabled)
 *   - privileges to delete from the token (the process can't enable them
 *     at runtime, even with AdjustTokenPrivileges)
 *
 * We use this to build a *child* token for the sandboxed process, then
 * pass it to `CreateProcessAsUserW`. The original process token is
 * untouched; on cleanup we close both the source and the new handle.
 *
 * Flag presets (matching Chrome's sandbox policy):
 *   LIGHT_MODE  = WRITE_RESTRICTED                  (0x0008)
 *   STRICT_MODE = DISABLE_MAX_PRIVILEGE|SANDBOX_INERT|WRITE_RESTRICTED
 *                                                    (0x0804)
 *
 * Note: in Win32, WRITE_RESTRICTED plus the standard set of deny-only
 * SIDs for the user's own group makes the token unable to write to
 * anything that the user couldn't write to anyway. This is the
 * "low-privilege" baseline that works non-elevated.
 */

import { getKoffi } from './koffi-loader.js';
import { TokenCreationError, mapWin32Error } from './errors.js';
import {
  asHandle,
  handleAsPointer,
  type Handle,
  RestrictedTokenFlags,
  type SID,
  TokenAccess,
  readPointer,
} from './types.js';

/** Builder-friendly flags for CreateRestrictedToken. */
export interface RestrictedTokenFlagSpec {
  /** DISABLE_MAX_PRIVILEGE (0x800): remove all privileges from the token. */
  readonly disableMaxPrivilege: boolean;
  /** SANDBOX_INERT (0x4): mark the token as sandbox-inert. */
  readonly sandboxInert: boolean;
  /** LUA_TOKEN (0x4): same value as SANDBOX_INERT in current Windows. */
  readonly luaToken: boolean;
  /** WRITE_RESTRICTED (0x8): deny write access for INTEGRITY-LEVEL-protected
   *  resources. This is the magic flag that blocks most writes when paired
   *  with the right deny-only SIDs. */
  readonly writeRestricted: boolean;
  /** DISABLE_MANDATORY_LABEL (0x80): do not assign a mandatory integrity
   *  label to the token. NOT used in either light or strict mode currently
   *  (we want the label to apply). */
  readonly disableMandatoryLabel: boolean;
}

/** SIDs to add to the token's deny-only list (sometimes called "restrict" SIDs). */
export interface RestrictionParams {
  /** SIDs that are added to the deny-only SID list. The process still
   *  "has" these SIDs for identification but cannot use them for access
   *  checks. */
  readonly addRestrictSids: readonly SID[];
  /** SIDs to explicitly deny. */
  readonly denySids: readonly SID[];
  /** LUIDs of privileges to permanently remove from the token. */
  readonly privilegesToDelete: readonly bigint[];
}

/** Flag preset matching Chrome's "low integrity" level. */
export const LIGHT_MODE_FLAGS: RestrictedTokenFlagSpec = {
  disableMaxPrivilege: false,
  sandboxInert: false,
  luaToken: false,
  writeRestricted: true,
  disableMandatoryLabel: false,
};

/** Flag preset matching Chrome's "lockdown" sandbox (no privileges, inert, write-restricted). */
export const STRICT_MODE_FLAGS: RestrictedTokenFlagSpec = {
  disableMaxPrivilege: true,
  sandboxInert: true,
  luaToken: true,
  writeRestricted: true,
  disableMandatoryLabel: false,
};

/** Convert a flag spec to the CreateRestrictedToken dwFlags bitmask. */
export function encodeRestrictedTokenFlags(spec: RestrictedTokenFlagSpec): number {
  let flags = 0;
  if (spec.disableMaxPrivilege) flags |= RestrictedTokenFlags.DISABLE_MAX_PRIVILEGE;
  if (spec.sandboxInert || spec.luaToken) flags |= RestrictedTokenFlags.SANDBOX_INERT;
  if (spec.writeRestricted) flags |= RestrictedTokenFlags.WRITE_RESTRICTED;
  // DISABLE_MANDATORY_LABEL = 0x0080 (not in our constants map; defined
  // in the Win32 header as a CreateRestrictedToken flag, distinct from
  // the token mandatory policy setting).
  if (spec.disableMandatoryLabel) flags |= 0x0080;
  return flags >>> 0;
}

/** Backwards-compatible alias: many callers expect a constant form. */
export const LIGHT_MODE_FLAG_VALUE: number = encodeRestrictedTokenFlags(LIGHT_MODE_FLAGS);
export const STRICT_MODE_FLAG_VALUE: number = encodeRestrictedTokenFlags(STRICT_MODE_FLAGS);

/**
 * Create a restricted token from `sourceToken`.
 *
 * The returned handle is a *new primary* token suitable for
 * `CreateProcessAsUserW`. The caller owns the handle and must close it
 * (use `HandleImpl` for RAII cleanup).
 *
 * The `restrictions` parameter is optional. If omitted, the new token
 * is just a "newer" copy of the source with the given flags.
 */
export function createRestrictedToken(
  sourceToken: Handle,
  flags: RestrictedTokenFlagSpec,
  restrictions: RestrictionParams = { addRestrictSids: [], denySids: [], privilegesToDelete: [] },
): Handle {
  const k = getKoffi();
  const advapi32 = k.load('advapi32.dll');
  const kernel32 = k.load('kernel32.dll');

  // Signature: CreateRestrictedToken(
  //   HANDLE ExistingTokenHandle,
  //   DWORD Flags,
  //   DWORD DisableSidCount, PSID_AND_ATTRIBUTES SidsToDisable,
  //   DWORD DeletePrivilegeCount, PLUID_AND_ATTRIBUTES PrivilegesToDelete,
  //   DWORD RestrictedSidCount, PSID_AND_ATTRIBUTES SidsToRestrict,
  //   PHANDLE NewTokenHandle)
  const fn = (advapi32 as { func: (s: string) => (...args: unknown[]) => unknown }).func(
    'int __stdcall CreateRestrictedToken(void *ExistingTokenHandle, uint32 Flags, uint32 DisableSidCount, void *SidsToDisable, uint32 DeletePrivilegeCount, void *PrivilegesToDelete, uint32 RestrictedSidCount, void *SidsToRestrict, void **NewTokenHandle)',
  );
  const GetLastError = (kernel32 as { func: (s: string) => (...args: unknown[]) => unknown }).func(
    'uint32 GetLastError()',
  );

  // Pack the parameters into a single Koffi struct.
  // SID_AND_ATTRIBUTES on x64: PSID (8 bytes) + DWORD (4 bytes) + pad (4 bytes) = 16 bytes.
  // LUID_AND_ATTRIBUTES on x64: LUID (8 bytes) + DWORD (4 bytes) = 12 bytes.
  // (No trailing pad for LUID_AND_ATTRIBUTES because LUID is naturally 8-aligned.)
  // We allocate the arrays contiguously with their counts. The first
  // 4 bytes of each array is the count (DWORD), then the elements.
  // Koffi sees this as a `void *` so we just need the byte layout to be
  // right; the OS only reads the elements it was promised.
  const SIDS_TO_DISABLE = 'SIDS_TO_DISABLE';
  const SIDS_TO_RESTRICT = 'SIDS_TO_RESTRICT';
  const PRIVS_TO_DELETE = 'PRIVS_TO_DELETE';

  // We pack arrays into Buffers and pass pointers to them.
  // CreateRestrictedToken's "SidsToDisable" / "SidsToRestrict" arrays
  // are SID_AND_ATTRIBUTES structs: { PSID Sid; DWORD Attributes; } = 16 bytes on x64.
  // We use Attributes=0 (SE_GROUP_USE_FOR_DENY_ONLY not set; OS adds it automatically for restrict sids).
  // For "deny" (disable) sids, the OS marks them as SE_GROUP_USE_FOR_DENY_ONLY when DisableSidCount > 0.

  const denyBuf = packSidAndAttributes(restrictions.denySids);
  const restrictBuf = packSidAndAttributes(restrictions.addRestrictSids);
  const privBuf = packLuidAndAttributes(restrictions.privilegesToDelete);

  const outPtr = Buffer.alloc(8);
  const ok = fn(
    handleAsPointer(sourceToken),
    encodeRestrictedTokenFlags(flags),
    restrictions.denySids.length >>> 0,
    denyBuf,
    restrictions.privilegesToDelete.length >>> 0,
    privBuf,
    restrictions.addRestrictSids.length >>> 0,
    restrictBuf,
    outPtr,
  );

  if (!ok) {
    const errCode = GetLastError() as number;
    throw mapWin32Error(errCode, { operation: 'createRestrictedToken' });
  }

  // Sanity: ensure the OS actually wrote a non-null pointer.
  const newTokenPtr = readPointer(outPtr);
  if (newTokenPtr === 0n) {
    throw new TokenCreationError('CreateRestrictedToken returned a null handle', {
      operation: 'createRestrictedToken',
    });
  }

  return asHandle(outPtr);
}

function packSidAndAttributes(sids: readonly SID[]): Buffer | null {
  if (sids.length === 0) return null;
  // SID_AND_ATTRIBUTES: { PSID Sid (8), DWORD Attributes (4), DWORD pad (4) }
  // We don't need the pad (the struct ends at offset 12, then the next
  // struct starts at offset 16). Allocating with 16-byte stride is safe.
  const STRIDE = 16;
  const buf = Buffer.alloc(sids.length * STRIDE);
  for (let i = 0; i < sids.length; i++) {
    const off = i * STRIDE;
    buf.writeBigUInt64LE(readPointer(sids[i]!), off);
    buf.writeUInt32LE(0, off + 8); // attributes
    // off + 12 stays zero (padding)
  }
  return buf;
}

function packLuidAndAttributes(luids: readonly bigint[]): Buffer | null {
  if (luids.length === 0) return null;
  // LUID_AND_ATTRIBUTES: { LUID LowPart:HighPart (8), DWORD Attributes (4) }
  // The struct is 12 bytes; padding isn't required between elements
  // because LUID is 8-aligned and the trailing DWORD ends at offset 12,
  // which is naturally aligned for the next LUID.
  const STRIDE = 12;
  const buf = Buffer.alloc(luids.length * STRIDE);
  for (let i = 0; i < luids.length; i++) {
    const off = i * STRIDE;
    buf.writeBigUInt64LE(luids[i]!, off);
    buf.writeUInt32LE(0, off + 8); // attributes (0 = privilege is removed)
  }
  return buf;
}

/**
 * Convenience: build a deny-only list from the user/group SIDs of the
 * current token. This is a *light-mode* trick: the new token still has
 * those SIDs (for "GetTokenInformation" reporting) but they are flagged
 * as deny-only and cannot be used for write access.
 *
 * NOTE: getting the user SIDs from a token requires a second FFI call
 * (GetTokenInformation). This helper is *not* used in our default light
 * mode — light mode relies solely on the WRITE_RESTRICTED flag. We keep
 * it here as a building block for future hardening.
 */
export function getCurrentTokenUserSids(_token: Handle): SID[] {
  // Placeholder for future expansion. Implementation would call
  // GetTokenInformation with TokenUser / TokenGroups / TokenPrimaryGroup
  // and unpack the SID_AND_ATTRIBUTES array.
  throw new TokenCreationError('getCurrentTokenUserSids is not yet implemented', {
    operation: 'getCurrentTokenUserSids',
  });
}

/** Backwards-compatible export: callers expect a "light" token constructor. */
export function createLightModeToken(sourceToken: Handle): Handle {
  return createRestrictedToken(sourceToken, LIGHT_MODE_FLAGS);
}

/** Backwards-compatible export: callers expect a "strict" token constructor. */
export function createStrictModeToken(sourceToken: Handle, restrictions?: RestrictionParams): Handle {
  return createRestrictedToken(sourceToken, STRICT_MODE_FLAGS, restrictions);
}

// Re-export commonly used bits for caller convenience.
export { TokenAccess, RestrictedTokenFlags };
