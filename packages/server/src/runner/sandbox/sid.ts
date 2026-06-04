/**
 * SID (Security Identifier) utilities.
 *
 * A Win32 SID is a variable-length structure; the on-wire layout is:
 *   Revision  (1 byte)
 *   SubAuthorityCount (1 byte)
 *   IdentifierAuthority (6 bytes, big-endian)
 *   SubAuthority[]  (4 bytes each, little-endian on the wire)
 *
 * Most callers should use `SidHandle` (RAII) to ensure the SID is
 * freed exactly once. Raw SID buffers obtained from
 * `convertStringSidToSidW` are also valid `SID` values but do NOT
 * need FreeSid (they are LocalAlloc'd by the API; lifecycle is
 * managed by the FFI binding).
 */

import { getKoffi } from './koffi-loader.js';
import { TokenCreationError, type SandboxError } from './errors.js';
import { asSid, readPointer, type SID } from './types.js';

// Well-known SID types (subset we actually need; see WELL_KNOWN_SID_TYPE).
// Full list: https://learn.microsoft.com/en-us/windows/win32/api/winnt/ne-winnt-well_known_sid_type
export const WellKnownSidType = {
  WinNullSid: 0,
  WinWorldSid: 1,
  WinLocalSid: 2,
  WinCreatorOwnerSid: 3,
  WinCreatorGroupSid: 4,
  WinCreatorOwnerServerSid: 5,
  WinCreatorGroupServerSid: 6,
  WinNtAuthoritySid: 7,
  WinDialupSid: 8,
  WinNetworkSid: 9,
  WinBatchSid: 10,
  WinInteractiveSid: 11,
  WinServiceSid: 12,
  WinAnonymousSid: 13,
  WinProxySid: 14,
  WinEnterpriseControllersSid: 15,
  WinSelfSid: 16,
  WinAuthenticatedUserSid: 17,
  WinRestrictedCodeSid: 18,
  WinTerminalServerSid: 19,
  WinRemoteLogonIdSid: 20,
  WinLogonIdsSid: 21,
  WinLocalSystemSid: 22,
  WinLocalServiceSid: 23,
  WinNetworkServiceSid: 24,
  WinBuiltinDomainSid: 25,
  WinBuiltinAdministratorsSid: 26,
  WinBuiltinUsersSid: 27,
  WinBuiltinGuestsSid: 28,
  WinBuiltinPowerUsersSid: 29,
  WinBuiltinAccountOperatorsSid: 30,
  WinBuiltinSystemOperatorsSid: 31,
  WinBuiltinPrintOperatorsSid: 32,
  WinBuiltinBackupOperatorsSid: 33,
  WinBuiltinReplicatorSid: 34,
  WinBuiltinPreWindows2000CompatibleAccessSid: 35,
  WinBuiltinRemoteDesktopUsersSid: 36,
  WinBuiltinNetworkConfigurationOperatorsSid: 37,
  WinAccountAdministratorSid: 38,
  WinAccountGuestSid: 39,
  WinAccountKrbtgtSid: 40,
  WinAccountDomainAdminsSid: 41,
  WinAccountDomainUsersSid: 42,
  WinAccountDomainGuestsSid: 43,
  WinAccountComputersSid: 44,
  WinAccountControllersSid: 45,
  WinAccountCertAdminsSid: 46,
  WinAccountSchemaAdminsSid: 47,
  WinAccountEnterpriseAdminsSid: 48,
  WinAccountPolicyAdminsSid: 49,
  WinAccountRasAndIasServersSid: 50,
  WinNTLMAuthenticationSid: 51,
  WinDigestAuthenticationSid: 52,
  WinSChannelAuthenticationSid: 53,
  WinThisOrganizationSid: 54,
  WinOtherOrganizationSid: 55,
  WinBuiltinIncomingForestTrustBuildersSid: 56,
  WinBuiltinPerfMonitoringUsersSid: 57,
  WinBuiltinPerfLoggingUsersSid: 58,
  WinBuiltinAuthorizationAccessSid: 59,
  WinBuiltinTerminalServerLicenseServersSid: 60,
} as const;

let sidKoffiStruct: unknown | null = null;

function ensureSidStruct(): unknown {
  if (sidKoffiStruct) return sidKoffiStruct;
  const k = getKoffi();
  // We don't try to describe the full variable-length SID layout in
  // Koffi; we treat the SID as an opaque buffer and use GetLengthSid
  // for size. Koffi only needs a struct handle for sizeof() checks
  // (we don't call those on SIDs because the size is variable).
  sidKoffiStruct = k.struct('__dynflow_sid', {
    Revision: 'uint8',
    SubAuthorityCount: 'uint8',
    IdentifierAuthority: 'uint8[6]',
    SubAuthority: 'uint32[1]',
  });
  return sidKoffiStruct;
}

/**
 * Allocate a synthetic SID with the given authority and sub-authorities.
 *
 * The returned SID is owned by the caller and must eventually be passed
 * to `freeSid`, or wrapped in a `SidHandle` for automatic cleanup.
 */
export function allocateSyntheticSid(authority: number, subAuthorities: number[]): SID {
  const k = getKoffi();
  ensureSidStruct();
  const advapi32 = k.load('advapi32.dll');
  const fn = (advapi32 as { func: (s: string) => (...args: unknown[]) => unknown }).func(
    'int __stdcall AllocateAndInitializeSid(void *pIdentifierAuthority, uint8 nSubAuthorityCount, uint32 dwSubAuthority0, uint32 dwSubAuthority1, uint32 dwSubAuthority2, uint32 dwSubAuthority3, uint32 dwSubAuthority4, uint32 dwSubAuthority5, uint32 dwSubAuthority6, uint32 dwSubAuthority7, void **pSid)',
  );

  // IdentifierAuthority is a 6-byte structure; we pass an 8-byte buffer
  // (first 6 bytes are the authority, big-endian on the wire).
  const authBuf = Buffer.alloc(8);
  // Place authority in the LAST 2 bytes of the 6-byte field, big-endian,
  // to match SID's on-wire representation. Top 2 bytes are zero.
  authBuf.writeUInt16BE(0, 0);
  authBuf.writeUInt32BE(authority >>> 0, 2);

  const padded = [0, 0, 0, 0, 0, 0, 0, 0];
  for (let i = 0; i < subAuthorities.length && i < 8; i++) {
    padded[i] = subAuthorities[i] >>> 0;
  }

  const outPtr = Buffer.alloc(8);
  const ok = fn(
    authBuf,
    subAuthorities.length & 0xff,
    padded[0],
    padded[1],
    padded[2],
    padded[3],
    padded[4],
    padded[5],
    padded[6],
    padded[7],
    outPtr,
  );
  if (!ok) {
    throw new TokenCreationError('AllocateAndInitializeSid failed', { operation: 'allocateSyntheticSid' });
  }
  return asSid(outPtr);
}

/**
 * Convert a textual SID string (e.g. "S-1-5-18") to a SID structure.
 * The returned SID must be freed with `freeSid`.
 */
export function convertStringSidToSidW(stringSid: string): SID {
  const k = getKoffi();
  ensureSidStruct();
  const advapi32 = k.load('advapi32.dll');
  const fn = (advapi32 as { func: (s: string) => (...args: unknown[]) => unknown }).func(
    'int __stdcall ConvertStringSidToSidW(const char16_t *StringSid, void **Sid)',
  );
  // Null-terminated UTF-16LE is required.
  const nameBuf = Buffer.from(stringSid + '\0', 'utf16le');
  const outPtr = Buffer.alloc(8);
  const ok = fn(nameBuf, outPtr);
  if (!ok) {
    throw new TokenCreationError(`ConvertStringSidToSidW failed for "${stringSid}"`, {
      operation: 'convertStringSidToSidW',
    });
  }
  return asSid(outPtr);
}

/**
 * Get the length, in bytes, of a valid SID.
 *
 * The input can be either:
 *   - A pointer-wrapped SID (8-byte buffer holding a pointer to the
 *     actual SID), as returned by `allocateSyntheticSid` /
 *     `convertStringSidToSidW`.
 *   - An inline SID (the SID data is in the buffer itself, first
 *     byte is revision=1, second byte is sub-authority count),
 *     as returned by `createWellKnownSid`.
 *
 * We detect the case by inspecting the first byte: an inline SID
 * starts with revision=1 and a small sub-authority count.
 */
export function getSidLengthSid(sid: SID): number {
  if (looksLikeInlineSid(sid)) {
    return sid.length;
  }
  const k = getKoffi();
  ensureSidStruct();
  const advapi32 = k.load('advapi32.dll');
  const fn = (advapi32 as { func: (s: string) => (...args: unknown[]) => unknown }).func(
    'uint32 __stdcall GetLengthSid(void *pSid)',
  );
  const ptr = readPointer(sid);
  const len = fn(ptr) as number;
  if (len === 0 || len < 8) {
    throw new TokenCreationError('GetLengthSid returned invalid length', {
      operation: 'getSidLengthSid',
    });
  }
  return len;
}

/**
 * Heuristic: detect an inline SID (first byte is the SID revision,
 * which is always 1; second byte is the sub-authority count, 0-15).
 * A pointer-wrapped SID would have a 64-bit pointer at byte 0.
 */
function looksLikeInlineSid(sid: SID): boolean {
  if (sid.length < 8 || sid.length > 68) return false;
  const revision = sid.readUInt8(0);
  const subAuthCount = sid.readUInt8(1);
  return revision === 1 && subAuthCount <= 15 && 8 + subAuthCount * 4 === sid.length;
}

/**
 * Free a SID previously returned by `allocateSyntheticSid` or
 * `convertStringSidToSidW`. Safe to call once; subsequent calls
 * are a no-op.
 *
 * SIDs from `createWellKnownSid` are inline and must NOT be passed
 * to this function (no kernel memory to free). Callers should know
 * which kind of SID they hold; this function silently skips
 * inline SIDs as a safety measure.
 */
export function freeSid(sid: SID): void {
  if (!sid || sid.length === 0) return;
  // Inline SIDs don't need to be freed; skip silently.
  if (looksLikeInlineSid(sid)) {
    sid.fill(0);
    return;
  }
  const k = getKoffi();
  const advapi32 = k.load('advapi32.dll');
  const fn = (advapi32 as { func: (s: string) => (...args: unknown[]) => unknown }).func(
    'void __stdcall FreeSid(void *pSid)',
  );
  try {
    const ptr = readPointer(sid);
    if (ptr !== 0n) {
      fn(ptr);
    }
  } catch {
    // ignore — best effort
  }
  // Mark as freed by zeroing the buffer; dispose()-like behavior.
  sid.fill(0);
}

/**
 * Create a well-known SID (e.g. WinWorldSid).
 *
 * Unlike `allocateSyntheticSid` (which returns a pointer to
 * kernel-allocated memory that must be freed with FreeSid), this
 * function returns the SID inline in a buffer. The caller does NOT
 * need to (and must not) call FreeSid on the result.
 *
 * The returned buffer is a self-contained SID of length returned by
 * `getSidLengthSid`; the rest of the buffer is unused.
 */
export function createWellKnownSid(wellKnownSidType: number): SID {
  const k = getKoffi();
  ensureSidStruct();
  const advapi32 = k.load('advapi32.dll');
  const fn = (advapi32 as { func: (s: string) => (...args: unknown[]) => unknown }).func(
    'int __stdcall CreateWellKnownSid(uint32 WellKnownSidType, void *DomainSid, void *pSid, uint32 *cbSid)',
  );
  const buf = Buffer.alloc(68); // SECURITY_MAX_SID_SIZE on Win10+
  const cbBuf = Buffer.alloc(4);
  cbBuf.writeUInt32LE(buf.length, 0);
  const ok = fn(wellKnownSidType, null, buf, cbBuf);
  if (!ok) {
    throw new TokenCreationError(`CreateWellKnownSid failed for type ${wellKnownSidType}`, {
      operation: 'createWellKnownSid',
    });
  }
  // `buf` now contains the SID *data* directly (not a pointer).
  // We trim it to the actual SID length so callers can use
  // `getSidLengthSid(buf)` directly (without dereferencing).
  const actualLen = cbBuf.readUInt32LE(0);
  return asSid(buf.subarray(0, actualLen));
}

/**
 * RAII wrapper for a SID. Calls `freeSid` on `dispose()`.
 * Designed to be used with `using` declarations (TS 5.2+) or
 * explicit try/finally.
 */
export class SidHandle implements Disposable {
  private _sid: SID | null;
  public readonly error?: SandboxError;

  constructor(sid: SID, error?: SandboxError) {
    this._sid = sid;
    this.error = error;
  }

  get sid(): SID {
    if (!this._sid) {
      throw new TokenCreationError('SidHandle has been disposed', { operation: 'SidHandle.sid' });
    }
    return this._sid;
  }

  get disposed(): boolean {
    return this._sid === null;
  }

  dispose(): void {
    if (this._sid) {
      freeSid(this._sid);
      this._sid = null;
    }
  }

  [Symbol.dispose](): void {
    this.dispose();
  }
}
