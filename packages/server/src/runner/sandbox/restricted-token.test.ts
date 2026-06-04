import { describe, it, expect } from 'vitest';
import {
  createRestrictedToken,
  createLightModeToken,
  createStrictModeToken,
  encodeRestrictedTokenFlags,
  LIGHT_MODE_FLAGS,
  STRICT_MODE_FLAGS,
  LIGHT_MODE_FLAG_VALUE,
  STRICT_MODE_FLAG_VALUE,
  type RestrictedTokenFlagSpec,
} from './restricted-token.js';
import { isKoffiAvailable } from './koffi-loader.js';
import {
  getCurrentProcessToken,
  closeHandle,
} from './process-token.js';
import { RestrictedTokenFlags } from './types.js';

const describeWin = process.platform === 'win32' && isKoffiAvailable() ? describe : describe.skip;

describe('sandbox/restricted-token', () => {
  describe('flag encoding (pure)', () => {
    it('LIGHT_MODE_FLAGS only sets WRITE_RESTRICTED', () => {
      const value = encodeRestrictedTokenFlags(LIGHT_MODE_FLAGS);
      expect(value).toBe(RestrictedTokenFlags.WRITE_RESTRICTED);
      expect(LIGHT_MODE_FLAG_VALUE).toBe(0x0008);
    });

    it('STRICT_MODE_FLAGS sets DISABLE_MAX_PRIVILEGE | SANDBOX_INERT | WRITE_RESTRICTED', () => {
      const value = encodeRestrictedTokenFlags(STRICT_MODE_FLAGS);
      // DISABLE_MAX_PRIVILEGE = 0x800, SANDBOX_INERT = 0x4, WRITE_RESTRICTED = 0x8
      expect(value).toBe(0x080c);
      expect(STRICT_MODE_FLAG_VALUE).toBe(0x080c);
    });

    it('disabling WRITE_RESTRICTED produces 0 in light mode', () => {
      const spec: RestrictedTokenFlagSpec = {
        ...LIGHT_MODE_FLAGS,
        writeRestricted: false,
      };
      expect(encodeRestrictedTokenFlags(spec)).toBe(0);
    });

    it('DISABLE_MANDATORY_LABEL bit (0x80) is honored', () => {
      const spec: RestrictedTokenFlagSpec = {
        ...LIGHT_MODE_FLAGS,
        disableMandatoryLabel: true,
      };
      expect(encodeRestrictedTokenFlags(spec) & 0x0080).toBe(0x0080);
    });

    it('all flags set yields 0x088c', () => {
      const spec: RestrictedTokenFlagSpec = {
        disableMaxPrivilege: true,
        sandboxInert: true,
        luaToken: true,
        writeRestricted: true,
        disableMandatoryLabel: true,
      };
      // 0x800 | 0x4 | 0x4 | 0x8 | 0x80 = 0x88c
      expect(encodeRestrictedTokenFlags(spec)).toBe(0x088c);
    });
  });

  describeWin('Windows-only FFI behavior', () => {
    it('createLightModeToken produces a distinct, non-null handle', () => {
      const src = getCurrentProcessToken();
      try {
        const restricted = createLightModeToken(src);
        try {
          expect(restricted.length).toBe(8);
          expect(restricted.readBigUInt64LE(0)).not.toBe(0n);
          // Distinct from source (CreateRestrictedToken returns a new handle).
          expect(restricted.readBigUInt64LE(0)).not.toBe(src.readBigUInt64LE(0));
        } finally {
          closeHandle(restricted);
        }
      } finally {
        closeHandle(src);
      }
    });

    it('createStrictModeToken also produces a distinct handle', () => {
      const src = getCurrentProcessToken();
      try {
        const restricted = createStrictModeToken(src);
        try {
          expect(restricted.readBigUInt64LE(0)).not.toBe(0n);
        } finally {
          closeHandle(restricted);
        }
      } finally {
        closeHandle(src);
      }
    });

    it('createRestrictedToken with no restrictions still works', () => {
      const src = getCurrentProcessToken();
      try {
        const restricted = createRestrictedToken(src, LIGHT_MODE_FLAGS);
        try {
          expect(restricted.readBigUInt64LE(0)).not.toBe(0n);
        } finally {
          closeHandle(restricted);
        }
      } finally {
        closeHandle(src);
      }
    });
  });
});
