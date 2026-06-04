import { describe, it, expect, beforeAll } from 'vitest';
import {
  allocateSyntheticSid,
  convertStringSidToSidW,
  getSidLengthSid,
  freeSid,
  createWellKnownSid,
  SidHandle,
  WellKnownSidType,
} from './sid.js';
import { isKoffiAvailable } from './koffi-loader.js';

const describeWin = process.platform === 'win32' && isKoffiAvailable() ? describe : describe.skip;

describeWin('sandbox/sid (Windows only)', () => {
  describe('allocateSyntheticSid + getSidLengthSid + freeSid', () => {
    it('allocates, measures, and frees a synthetic SID', () => {
      // S-1-5-32-544 = Builtin\Administrators, simplified synthetic form.
      const sid = allocateSyntheticSid(5, [32, 544]);
      try {
        const len = getSidLengthSid(sid);
        expect(len).toBeGreaterThanOrEqual(12); // 8 (header) + N * 4 (sub-auths)
        // 8 + 2 * 4 = 16
        expect(len).toBe(16);
      } finally {
        freeSid(sid);
      }
    });

    it('allocates a SID with up to 8 sub-authorities', () => {
      const sid = allocateSyntheticSid(5, [1, 2, 3, 4, 5, 6, 7, 8]);
      try {
        const len = getSidLengthSid(sid);
        expect(len).toBe(8 + 8 * 4); // = 40
      } finally {
        freeSid(sid);
      }
    });
  });

  describe('convertStringSidToSidW', () => {
    it('converts a textual SID to a SID structure', () => {
      // S-1-5-18 is LocalSystem, common built-in.
      const sid = convertStringSidToSidW('S-1-5-18');
      try {
        const len = getSidLengthSid(sid);
        expect(len).toBe(12); // 8 + 1*4
      } finally {
        freeSid(sid);
      }
    });

    it('rejects malformed SIDs', () => {
      expect(() => convertStringSidToSidW('not-a-sid')).toThrow();
    });
  });

  describe('createWellKnownSid', () => {
    it('creates the WinWorldSid (S-1-1-0)', () => {
      const sid = createWellKnownSid(WellKnownSidType.WinWorldSid);
      try {
        const len = getSidLengthSid(sid);
        expect(len).toBe(12);
      } finally {
        freeSid(sid);
      }
    });
  });

  describe('SidHandle (RAII)', () => {
    it('exposes the SID and disposes on dispose()', () => {
      const handle = new SidHandle(allocateSyntheticSid(5, [1]));
      expect(handle.disposed).toBe(false);
      expect(handle.sid.length).toBeGreaterThan(0);
      handle.dispose();
      expect(handle.disposed).toBe(true);
      expect(() => handle.sid).toThrow(/disposed/);
    });

    it('is idempotent on dispose', () => {
      const handle = new SidHandle(allocateSyntheticSid(5, [1]));
      handle.dispose();
      expect(() => handle.dispose()).not.toThrow();
    });

    it('Symbol.dispose also disposes', () => {
      const handle = new SidHandle(allocateSyntheticSid(5, [1]));
      handle[Symbol.dispose]();
      expect(handle.disposed).toBe(true);
    });
  });
});
