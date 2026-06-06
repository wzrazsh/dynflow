import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import {
  FileAccessMask,
  DirectoryAccessMask,
  buildDacl,
  applyDaclToPath,
  getPathDacl,
  restorePathDacl,
  freeAcl,
  DaclHandle,
  asAcl,
} from './dacl.js';
import { isKoffiAvailable } from './koffi-loader.js';
import { allocateSyntheticSid, freeSid, WellKnownSidType } from './sid.js';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

void WellKnownSidType;

const describeWin = process.platform === 'win32' && isKoffiAvailable() ? describe : describe.skip;

describe('sandbox/dacl', () => {
  describe('pure logic', () => {
    it('exposes the expected FILE_GENERIC_* constants', () => {
      expect(FileAccessMask.FILE_GENERIC_READ).toBe(0x00120089);
      expect(FileAccessMask.FILE_GENERIC_WRITE).toBe(0x00120116);
      expect(FileAccessMask.FILE_GENERIC_EXECUTE).toBe(0x001200a0);
    });

    it('exposes the expected DIR_GENERIC_* constants', () => {
      expect(DirectoryAccessMask.DIR_GENERIC_READ).toBe(0x00120089);
      expect(DirectoryAccessMask.DIR_GENERIC_WRITE).toBe(0x00120116);
      expect(DirectoryAccessMask.DIR_GENERIC_EXECUTE).toBe(0x001200a0);
    });

    it('asAcl returns a typed view of the same buffer', () => {
      const b = Buffer.alloc(8);
      b.writeBigUInt64LE(0xdeadbeefn, 0);
      const a = asAcl(b);
      expect(a).toBe(b);
    });
  });

  describeWin('Windows-only FFI behavior', () => {
    it('freeAcl is safe on an empty/null buffer', () => {
      const b = Buffer.alloc(8);
      expect(() => freeAcl(asAcl(b))).not.toThrow();
    });
    let tmpDir: string;
    let tmpFile: string;

    beforeAll(() => {
      tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dynflow-sandbox-dacl-'));
      tmpFile = path.join(tmpDir, 'sandbox-test.txt');
      fs.writeFileSync(tmpFile, 'hello');
    });

    afterAll(() => {
      try {
        fs.unlinkSync(tmpFile);
        fs.rmdirSync(tmpDir);
      } catch {
        // best effort
      }
    });

    it('buildDacl requires at least one entry', () => {
      expect(() => buildDacl([])).toThrow();
    });

    it('getPathDacl returns a non-null ACL for a real file', () => {
      const acl = getPathDacl(tmpFile);
      try {
        // The 8-byte buffer should contain a non-zero pointer.
        expect(acl.readBigUInt64LE(0)).not.toBe(0n);
      } finally {
        freeAcl(acl);
      }
    });

    it('buildDacl produces a valid ACL pointer', () => {
      const sid = allocateSyntheticSid(5, [32, 544]);
      try {
        const acl = buildDacl([{ sid, accessMask: FileAccessMask.FILE_GENERIC_READ, mode: 'grant' }]);
        try {
          expect(acl.readBigUInt64LE(0)).not.toBe(0n);
        } finally {
          freeAcl(acl);
        }
      } finally {
        freeSid(sid);
      }
    });

    it('apply + restore round-trip preserves access', () => {
      const sid = allocateSyntheticSid(5, [32, 544]);
      const target = path.join(tmpDir, 'round-trip.txt');
      fs.writeFileSync(target, 'data');
      try {
        const originalAcl = getPathDacl(target);
        const newAcl = buildDacl([
          { sid, accessMask: FileAccessMask.FILE_GENERIC_READ, mode: 'grant' },
        ]);
        try {
          applyDaclToPath(target, newAcl, true);
          // Restore the original.
          restorePathDacl(target, originalAcl);
        } finally {
          freeAcl(newAcl);
          freeAcl(originalAcl);
        }
        // After restore, the current user must still be able to read.
        const data = fs.readFileSync(target, 'utf8');
        expect(data).toBe('data');
      } finally {
        freeSid(sid);
        try {
          fs.unlinkSync(target);
        } catch {
          // best effort
        }
      }
    });

    it('DaclHandle RAII works (apply + restore on dispose)', () => {
      const sid = allocateSyntheticSid(5, [32, 544]);
      const target = path.join(tmpDir, 'handle-test.txt');
      fs.writeFileSync(target, 'data');
      try {
        const originalAcl = getPathDacl(target);
        const newAcl = buildDacl([
          { sid, accessMask: FileAccessMask.FILE_GENERIC_READ, mode: 'grant' },
        ]);
        const handle = new DaclHandle(target, newAcl, originalAcl);
        try {
          handle.apply();
          expect(handle.applied).toBe(true);
        } finally {
          handle.dispose();
          expect(handle.applied).toBe(false);
        }
        // After dispose, DACL must be restored and file readable.
        const data = fs.readFileSync(target, 'utf8');
        expect(data).toBe('data');
      } finally {
        freeSid(sid);
        try {
          fs.unlinkSync(target);
        } catch {
          // best effort
        }
      }
    });

    it('Symbol.dispose also disposes', () => {
      const sid = allocateSyntheticSid(5, [32, 544]);
      const target = path.join(tmpDir, 'symbol-dispose.txt');
      fs.writeFileSync(target, 'data');
      try {
        const originalAcl = getPathDacl(target);
        const newAcl = buildDacl([
          { sid, accessMask: FileAccessMask.FILE_GENERIC_READ, mode: 'grant' },
        ]);
        const handle = new DaclHandle(target, newAcl, originalAcl);
        handle[Symbol.dispose]();
        expect(handle.applied).toBe(false);
      } finally {
        freeSid(sid);
        try {
          fs.unlinkSync(target);
        } catch {
          // best effort
        }
      }
    });

    it('DaclHandle with null originalAcl is allowed (no restore on dispose)', () => {
      const sid = allocateSyntheticSid(5, [32, 544]);
      const target = path.join(tmpDir, 'no-restore.txt');
      fs.writeFileSync(target, 'data');
      try {
        const newAcl = buildDacl([
          { sid, accessMask: FileAccessMask.FILE_GENERIC_READ, mode: 'grant' },
        ]);
        const handle = new DaclHandle(target, newAcl, null);
        handle.apply();
        // No restore should happen (originalAcl is null).
        handle.dispose();
      } finally {
        freeSid(sid);
        try {
          fs.unlinkSync(target);
        } catch {
          // best effort
        }
      }
    });
  });
});

// (moved imports to top)
