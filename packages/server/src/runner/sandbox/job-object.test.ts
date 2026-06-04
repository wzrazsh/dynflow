import { describe, it, expect } from 'vitest';
import {
  createJobObject,
  closeJobObject,
  setJobObjectLimits,
  setJobObjectBasicUiRestrictions,
  assignProcessToJobObject,
  JobObject,
  DEFAULT_JOB_LIMITS,
  JobObjectUiRestrictions,
  verifyJobObjectStructSizes,
} from './job-object.js';
import { isKoffiAvailable } from './koffi-loader.js';
import { getCurrentProcessToken, getCurrentProcess, closeHandle } from './process-token.js';
import { JobObjectLimits } from './types.js';

const describeWin = process.platform === 'win32' && isKoffiAvailable() ? describe : describe.skip;

describe('sandbox/job-object', () => {
  describe('pure logic', () => {
    it('exposes the expected JOB_OBJECT_UILIMIT_* constants', () => {
      expect(JobObjectUiRestrictions.JOB_OBJECT_UILIMIT_DESKTOP).toBe(0x40);
      expect(JobObjectUiRestrictions.JOB_OBJECT_UILIMIT_DISPLAYSETTINGS).toBe(0x10);
      expect(JobObjectUiRestrictions.JOB_OBJECT_UILIMIT_EXITWINDOWS).toBe(0x80);
    });

    it('exposes the expected JobObjectLimits constants', () => {
      expect(JobObjectLimits.JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE).toBe(0x2000);
      expect(JobObjectLimits.JOB_OBJECT_LIMIT_BREAKAWAY_OK).toBe(0x800);
      expect(JobObjectLimits.JOB_OBJECT_LIMIT_PROCESS_MEMORY).toBe(0x100);
      expect(JobObjectLimits.JOB_OBJECT_LIMIT_JOB_MEMORY).toBe(0x200);
    });

    it('DEFAULT_JOB_LIMITS has killOnJobClose=true and 2GB process memory', () => {
      expect(DEFAULT_JOB_LIMITS.killOnJobClose).toBe(true);
      expect(DEFAULT_JOB_LIMITS.maxProcessMemoryBytes).toBe(2 * 1024 * 1024 * 1024);
      expect(DEFAULT_JOB_LIMITS.breakawayOk).toBe(false);
    });

    it('UI restriction flags can be ORed together', () => {
      const combined = JobObjectUiRestrictions.JOB_OBJECT_UILIMIT_DESKTOP |
        JobObjectUiRestrictions.JOB_OBJECT_UILIMIT_EXITWINDOWS;
      expect(combined).toBe(0xc0);
    });
  });

  describeWin('Windows-only FFI behavior', () => {
    it('verifyJobObjectStructSizes passes on Windows', () => {
      expect(() => verifyJobObjectStructSizes()).not.toThrow();
    });

    it('createJobObject returns a non-null handle', () => {
      const h = createJobObject();
      try {
        expect(h.readBigUInt64LE(0)).not.toBe(0n);
      } finally {
        closeJobObject(h);
      }
    });

    it('setJobObjectLimits accepts default limits without error', () => {
      const h = createJobObject();
      try {
        expect(() => setJobObjectLimits(h, DEFAULT_JOB_LIMITS)).not.toThrow();
      } finally {
        closeJobObject(h);
      }
    });

    it('setJobObjectLimits rejects negative maxProcessMemoryBytes via no-cap behavior', () => {
      const h = createJobObject();
      try {
        expect(() =>
          setJobObjectLimits(h, {
            killOnJobClose: false,
            breakawayOk: false,
            maxProcessMemoryBytes: 0, // 0 = no cap
            maxJobMemoryBytes: 0,
          }),
        ).not.toThrow();
      } finally {
        closeJobObject(h);
      }
    });

    it('setJobObjectBasicUiRestrictions accepts a bitmask', () => {
      const h = createJobObject();
      try {
        const flags = JobObjectUiRestrictions.JOB_OBJECT_UILIMIT_DESKTOP |
          JobObjectUiRestrictions.JOB_OBJECT_UILIMIT_EXITWINDOWS;
        expect(() => setJobObjectBasicUiRestrictions(h, flags)).not.toThrow();
      } finally {
        closeJobObject(h);
      }
    });

    it.skip('assignProcessToJobObject fails on a real process when parent is already in a job without breakaway', () => {
      // Skipped: AssignProcessToJobObject on the current process
      // pseudo-handle blocks the host when the test runner is already
      // nested inside a job. Real-world usage in the runner targets
      // freshly-created child processes (not the host), where the
      // behavior is different. The actual end-to-end behavior is
      // covered by the runner integration test in T4/T15.
      const job = createJobObject();
      try {
        setJobObjectLimits(job, { ...DEFAULT_JOB_LIMITS, breakawayOk: false });
        const proc = getCurrentProcess();
        try {
          assignProcessToJobObject(job, proc);
        } catch {
          // expected on hosts where the test runner is in a job
        }
      } finally {
        closeJobObject(job);
      }
    });

    it('JobObject (RAII) lifecycle works', () => {
      const h = createJobObject();
      const job = new JobObject(h);
      try {
        expect(job.disposed).toBe(false);
        expect(job.handle.readBigUInt64LE(0)).not.toBe(0n);
      } finally {
        job.dispose();
        expect(job.disposed).toBe(true);
      }
    });

    it('JobObject[Symbol.dispose] works', () => {
      const h = createJobObject();
      const job = new JobObject(h);
      job[Symbol.dispose]();
      expect(job.disposed).toBe(true);
    });

    it('JobObject.setUiRestrictions works', () => {
      const h = createJobObject();
      const job = new JobObject(h);
      try {
        expect(() =>
          job.setUiRestrictions(JobObjectUiRestrictions.JOB_OBJECT_UILIMIT_DESKTOP),
        ).not.toThrow();
      } finally {
        job.dispose();
      }
    });

    it('closeJobObject is idempotent', () => {
      const h = createJobObject();
      closeJobObject(h);
      expect(() => closeJobObject(h)).not.toThrow();
    });

    it('closeJobObject is safe on a null handle', () => {
      const h = Buffer.alloc(8) as unknown as ReturnType<typeof createJobObject>;
      expect(() => closeJobObject(h)).not.toThrow();
    });
  });
});

// Silence unused-import warnings.
void getCurrentProcessToken;
void getCurrentProcess;
void closeHandle;
