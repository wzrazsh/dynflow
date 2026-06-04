/**
 * Job object creation and configuration.
 *
 * A Win32 Job Object is a kernel object that groups one or more processes
 * and applies collective limits to them. We use it for two things:
 *
 *   1. **KILL_ON_JOB_CLOSE** — if the job handle is closed (and no
 *      other handle is open), all assigned processes are terminated.
 *      This guarantees the sandboxed process can never outlive the
 *      server's job handle, even on a hard crash.
 *   2. **PROCESS_MEMORY / JOB_MEMORY** — enforce memory limits. The
 *      runner defaults to 2GB per process (matching CuaAgentRunner).
 *
 * Job objects do NOT enforce CPU limits, network limits, or filesystem
 * limits. For filesystem isolation we use DACLs (see dacl.ts). For
 * network isolation we deliberately do nothing (Pi needs API access).
 *
 * UI restrictions are an extra hardening layer: we can disallow the
 * sandboxed process from accessing the desktop, changing display
 * settings, or shutting down the workstation. We apply these when the
 * runner is configured with `enableUiRestrictions: true`.
 */

import { getKoffi } from './koffi-loader.js';
import { JobObjectError, mapWin32Error } from './errors.js';
import {
  asHandle,
  handleAsPointer,
  type Handle,
  JobObjectLimits,
  verifyStructSizes,
  ExpectedStructSizes,
  type StructSpec,
  readPointer,
} from './types.js';

/** Configuration for the basic limit information of a job object. */
export interface JobLimits {
  /** Kill all assigned processes when the last job handle is closed. */
  readonly killOnJobClose: boolean;
  /** Cap on total memory for the entire job (across all processes).
   *  0 means "no cap". */
  readonly maxJobMemoryBytes: number;
  /** Cap on memory for any single process in the job. 0 means "no cap". */
  readonly maxProcessMemoryBytes: number;
  /** Allow assigned processes to escape the job (breakaway).
   *  Default: false (we never want this). */
  readonly breakawayOk: boolean;
}

/** Default job limits used by the runner. */
export const DEFAULT_JOB_LIMITS: JobLimits = {
  killOnJobClose: true,
  maxJobMemoryBytes: 0,
  maxProcessMemoryBytes: 2 * 1024 * 1024 * 1024, // 2 GB
  breakawayOk: false,
};

/** UI restriction bits. Each is a JOB_OBJECT_UILIMIT_* constant. */
export const JobObjectUiRestrictions = {
  JOB_OBJECT_UILIMIT_DESKTOP: 0x00000040,
  JOB_OBJECT_UILIMIT_DISPLAYSETTINGS: 0x00000010,
  JOB_OBJECT_UILIMIT_EXITWINDOWS: 0x00000080,
  JOB_OBJECT_UILIMIT_GLOBALATOMS: 0x00000020,
  JOB_OBJECT_UILIMIT_HANDLES: 0x00000001,
  JOB_OBJECT_UILIMIT_READCLIPBOARD: 0x00000002,
  JOB_OBJECT_UILIMIT_SYSTEMPARAMETERS: 0x00000008,
  JOB_OBJECT_UILIMIT_WRITECLIPBOARD: 0x00000004,
} as const;

/** A bitmask of UI restriction flags. */
export type JobObjectUiRestrictionFlags = number;

/** JobObjectInfoClass values for SetInformationJobObject. */
const JobObjectExtendedLimitInformation = 9;
const JobObjectBasicUiRestrictions = 4;

/** Cached Koffi struct handles so verifyStructSizes can sizeof them. */
let jobLimitStruct: unknown | null = null;
let jobUiRestrictionsStruct: unknown | null = null;

function ensureJobStructs(): { jobLimit: unknown; jobUi: unknown } {
  if (jobLimitStruct && jobUiRestrictionsStruct) {
    return { jobLimit: jobLimitStruct, jobUi: jobUiRestrictionsStruct };
  }
  const k = getKoffi();
  // JOBOBJECT_BASIC_LIMIT_INFORMATION (48 bytes on x64):
  //   LARGE_INTEGER PerProcessUserTimeLimit (8)
  //   LARGE_INTEGER PerJobUserTimeLimit (8)
  //   DWORD LimitFlags (4)
  //   SIZE_T MinimumWorkingSetSize (8) -- pointer-sized
  //   SIZE_T MaximumWorkingSetSize (8)
  //   DWORD ActiveProcessLimit (4)
  //   LARGE_INTEGER Affinity (8)
  //   DWORD PriorityClass (4)
  //   DWORD SchedulingClass (4)
  // Total: 8+8+4+8+8+4+8+4+4 = 56
  // Wait — the standard says 48. The discrepancy is that SIZE_T in some
  // headers is 4 bytes (32-bit). On x64 SIZE_T is 8 bytes, but the
  // JOBOBJECT_BASIC_LIMIT_INFORMATION was originally defined when
  // SIZE_T was 4. The 48-byte layout uses 4-byte fields:
  //   PerProcessUserTimeLimit (8)
  //   PerJobUserTimeLimit (8)
  //   LimitFlags (4)
  //   MinimumWorkingSetSize (4)
  //   MaximumWorkingSetSize (4)
  //   ActiveProcessLimit (4)
  //   pad (4)
  //   Affinity (8)
  //   PriorityClass (4)
  //   SchedulingClass (4)
  // = 8+8+4+4+4+4+4+8+4+4 = 52
  // The Windows header actually documents this as 48 bytes with a
  // different alignment. To stay safe and match the documented size, we
  // declare the struct as 48 bytes with these field widths:
  //   8 + 8 + 4 + 4 + 4 + 4 + 4(pad) + 8 + 4 + 4 = 52
  // We add 4 bytes of trailing padding to reach 48. Actually, the
  // 48-byte layout is achieved with a different field order; we follow
  // the MSDN layout and rely on verifyStructSizes to confirm.
  // For Koffi, we declare with the natural field sizes and pad manually.

  // JOBOBJECT_BASIC_LIMIT_INFORMATION (64 bytes on x64):
  //   int64  PerProcessUserTimeLimit;       // offset 0
  //   int64  PerJobUserTimeLimit;           // offset 8
  //   uint32 LimitFlags;                    // offset 16
  //   uint32 pad;                           // offset 20
  //   uintptr_t MinimumWorkingSetSize;      // offset 24 (SIZE_T on x64 = 8)
  //   uintptr_t MaximumWorkingSetSize;      // offset 32
  //   uint32 ActiveProcessLimit;            // offset 40
  //   uint32 pad2;                          // offset 44
  //   uintptr_t Affinity;                   // offset 48
  //   uint32 PriorityClass;                 // offset 56
  //   uint32 SchedulingClass;               // offset 60
  // Total: 64
  jobLimitStruct = k.struct('JOBOBJECT_BASIC_LIMIT_INFORMATION', {
    PerProcessUserTimeLimit: 'int64',
    PerJobUserTimeLimit: 'int64',
    LimitFlags: 'uint32',
    __pad0: 'uint32',
    MinimumWorkingSetSize: 'uintptr_t',
    MaximumWorkingSetSize: 'uintptr_t',
    ActiveProcessLimit: 'uint32',
    __pad1: 'uint32',
    Affinity: 'uintptr_t',
    PriorityClass: 'uint32',
    SchedulingClass: 'uint32',
  });

  // JOBOBJECT_EXTENDED_LIMIT_INFORMATION (144 bytes on x64):
  //   JOBOBJECT_BASIC_LIMIT_INFORMATION BasicLimitInformation; // 64 @ 0
  //   IO_COUNTERS IoInfo;                                      // 48 @ 64
  //   SIZE_T ProcessMemoryLimit;                               // 8  @ 112
  //   SIZE_T JobMemoryLimit;                                   // 8  @ 120
  //   SIZE_T PeakProcessMemoryUsed;                            // 8  @ 128
  //   SIZE_T PeakJobMemoryUsed;                                // 8  @ 136
  // Total: 144
  jobLimitStruct = k.struct('JOBOBJECT_EXTENDED_LIMIT_INFORMATION', {
    PerProcessUserTimeLimit: 'int64',
    PerJobUserTimeLimit: 'int64',
    LimitFlags: 'uint32',
    __pad0: 'uint32',
    MinimumWorkingSetSize: 'uintptr_t',
    MaximumWorkingSetSize: 'uintptr_t',
    ActiveProcessLimit: 'uint32',
    __pad1: 'uint32',
    Affinity: 'uintptr_t',
    PriorityClass: 'uint32',
    SchedulingClass: 'uint32',
    ReadOperationCount: 'uint64',
    WriteOperationCount: 'uint64',
    OtherOperationCount: 'uint64',
    ReadTransferCount: 'uint64',
    WriteTransferCount: 'uint64',
    OtherTransferCount: 'uint64',
    ProcessMemoryLimit: 'uintptr_t',
    JobMemoryLimit: 'uintptr_t',
    PeakProcessMemoryUsed: 'uintptr_t',
    PeakJobMemoryUsed: 'uintptr_t',
  });

  // JOBOBJECT_BASIC_UI_RESTRICTIONS (4 bytes):
  //   UIRestrictionsLimit (4)
  jobUiRestrictionsStruct = k.struct('JOBOBJECT_BASIC_UI_RESTRICTIONS', {
    UIRestrictionsLimit: 'uint32',
  });

  return { jobLimit: jobLimitStruct, jobUi: jobUiRestrictionsStruct };
}

/** Verify the struct sizes match MSVC layout. Throws on mismatch. */
export function verifyJobObjectStructSizes(): void {
  const k = getKoffi();
  const { jobLimit, jobUi } = ensureJobStructs();
  const specs: StructSpec[] = [
    {
      name: 'JOBOBJECT_EXTENDED_LIMIT_INFORMATION',
      expectedSize: ExpectedStructSizes.JOBOBJECT_EXTENDED_LIMIT_INFORMATION,
      koffiStruct: jobLimit,
    },
    {
      name: 'JOBOBJECT_BASIC_UI_RESTRICTIONS',
      expectedSize: 4,
      koffiStruct: jobUi,
    },
  ];
  verifyStructSizes(k, specs);
}

/**
 * Create an unnamed job object. The handle is owned by the caller and
 * must be closed (use `JobObject` for RAII cleanup).
 *
 * SECURITY: always pair this with `setJobObjectLimits` configured to
 * killOnJobClose=true. Without that, an orphaned process would not be
 * terminated on cleanup.
 */
export function createJobObject(): Handle {
  const k = getKoffi();
  const kernel32 = k.load('kernel32.dll');
  // CreateJobObjectW returns HANDLE directly (a pointer-sized value or
  // NULL on failure).
  const fn = (kernel32 as { func: (s: string) => (...args: unknown[]) => unknown }).func(
    'void *__stdcall CreateJobObjectW(void *lpJobAttributes, void *lpName)',
  );
  const GetLastError = (kernel32 as { func: (s: string) => (...args: unknown[]) => unknown }).func(
    'uint32 GetLastError()',
  );

  // SECURITY_ATTRIBUTES pointer is null (default: non-inheritable, no
  // security descriptor — the server process owns the job).
  const result = fn(null, null) as bigint;
  if (!result || result === 0n) {
    const errCode = GetLastError() as number;
    throw mapWin32Error(errCode, { operation: 'createJobObject' });
  }
  const out = Buffer.alloc(8);
  out.writeBigUInt64LE(result, 0);
  return asHandle(out);
}

/**
 * Set the extended limit information on a job.
 * Encodes the JobLimits into a JOBOBJECT_BASIC_LIMIT_INFORMATION struct.
 */
export function setJobObjectLimits(job: Handle, limits: JobLimits): void {
  const k = getKoffi();
  const { jobLimit } = ensureJobStructs();
  const kernel32 = k.load('kernel32.dll');
  const fn = (kernel32 as { func: (s: string) => (...args: unknown[]) => unknown }).func(
    'int __stdcall SetInformationJobObject(void *hJob, int JobObjectInfoClass, void *lpJobObjectInfo, uint32 cbJobObjectInfoLength)',
  );
  const GetLastError = (kernel32 as { func: (s: string) => (...args: unknown[]) => unknown }).func(
    'uint32 GetLastError()',
  );

  let limitFlags = 0;
  if (limits.killOnJobClose) limitFlags |= JobObjectLimits.JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
  if (limits.breakawayOk) limitFlags |= JobObjectLimits.JOB_OBJECT_LIMIT_BREAKAWAY_OK;
  if (limits.maxProcessMemoryBytes > 0) limitFlags |= JobObjectLimits.JOB_OBJECT_LIMIT_PROCESS_MEMORY;
  if (limits.maxJobMemoryBytes > 0) limitFlags |= JobObjectLimits.JOB_OBJECT_LIMIT_JOB_MEMORY;

  // Build the JOBOBJECT_EXTENDED_LIMIT_INFORMATION buffer (144 bytes on x64).
  const buf = Buffer.alloc(ExpectedStructSizes.JOBOBJECT_EXTENDED_LIMIT_INFORMATION);
  // --- BasicLimitInformation (64 bytes) ---
  // 0..7: PerProcessUserTimeLimit (no cap)
  buf.writeBigInt64LE(0n, 0);
  // 8..15: PerJobUserTimeLimit (no cap)
  buf.writeBigInt64LE(0n, 8);
  // 16..19: LimitFlags
  buf.writeUInt32LE(limitFlags >>> 0, 16);
  // 20..23: pad
  buf.writeUInt32LE(0, 20);
  // 24..31: MinimumWorkingSetSize (uintptr_t, no cap)
  buf.writeBigUInt64LE(0n, 24);
  // 32..39: MaximumWorkingSetSize (uintptr_t, no cap)
  buf.writeBigUInt64LE(0n, 32);
  // 40..43: ActiveProcessLimit (0 = no cap)
  buf.writeUInt32LE(0, 40);
  // 44..47: pad2
  buf.writeUInt32LE(0, 44);
  // 48..55: Affinity
  buf.writeBigUInt64LE(0n, 48);
  // 56..59: PriorityClass
  buf.writeUInt32LE(0, 56);
  // 60..63: SchedulingClass
  buf.writeUInt32LE(0, 60);
  // --- IoInfo (48 bytes) ---
  // 64..71: ReadOperationCount
  buf.writeBigUInt64LE(0n, 64);
  // 72..79: WriteOperationCount
  buf.writeBigUInt64LE(0n, 72);
  // 80..87: OtherOperationCount
  buf.writeBigUInt64LE(0n, 80);
  // 88..95: ReadTransferCount
  buf.writeBigUInt64LE(0n, 88);
  // 96..103: WriteTransferCount
  buf.writeBigUInt64LE(0n, 96);
  // 104..111: OtherTransferCount
  buf.writeBigUInt64LE(0n, 104);
  // --- Memory limits ---
  // 112..119: ProcessMemoryLimit (uintptr_t)
  if (limits.maxProcessMemoryBytes > 0) {
    buf.writeBigUInt64LE(BigInt(limits.maxProcessMemoryBytes), 112);
  } else {
    buf.writeBigUInt64LE(0n, 112);
  }
  // 120..127: JobMemoryLimit (uintptr_t)
  if (limits.maxJobMemoryBytes > 0) {
    buf.writeBigUInt64LE(BigInt(limits.maxJobMemoryBytes), 120);
  } else {
    buf.writeBigUInt64LE(0n, 120);
  }
  // 128..135: PeakProcessMemoryUsed (read-only, zero)
  buf.writeBigUInt64LE(0n, 128);
  // 136..143: PeakJobMemoryUsed (read-only, zero)
  buf.writeBigUInt64LE(0n, 136);

  const ok = fn(handleAsPointer(job), JobObjectExtendedLimitInformation, buf, buf.length);
  if (!ok) {
    const errCode = GetLastError() as number;
    throw mapWin32Error(errCode, { operation: 'setJobObjectLimits' });
  }
  // Silence the unused-import warning while keeping the koffi struct
  // around for verifyStructSizes checks at module load.
  void jobLimit;
}

/**
 * Set UI restrictions on a job.
 * `flags` is a bitmask of JOB_OBJECT_UILIMIT_* constants.
 */
export function setJobObjectBasicUiRestrictions(job: Handle, flags: number): void {
  const k = getKoffi();
  const { jobUi } = ensureJobStructs();
  const kernel32 = k.load('kernel32.dll');
  const fn = (kernel32 as { func: (s: string) => (...args: unknown[]) => unknown }).func(
    'int __stdcall SetInformationJobObject(void *hJob, int JobObjectInfoClass, void *lpJobObjectInfo, uint32 cbJobObjectInfoLength)',
  );
  const GetLastError = (kernel32 as { func: (s: string) => (...args: unknown[]) => unknown }).func(
    'uint32 GetLastError()',
  );

  const buf = Buffer.alloc(4);
  buf.writeUInt32LE(flags >>> 0, 0);

  const ok = fn(handleAsPointer(job), JobObjectBasicUiRestrictions, buf, buf.length);
  if (!ok) {
    const errCode = GetLastError() as number;
    throw mapWin32Error(errCode, { operation: 'setJobObjectBasicUiRestrictions' });
  }
  void jobUi;
}

/**
 * Assign a process to a job. The process must not already be in a job
 * (unless the job has breakawayOk=true), or the call fails with
 * ERROR_ACCESS_DENIED.
 */
export function assignProcessToJobObject(job: Handle, process: Handle): void {
  const k = getKoffi();
  const kernel32 = k.load('kernel32.dll');
  const fn = (kernel32 as { func: (s: string) => (...args: unknown[]) => unknown }).func(
    'int __stdcall AssignProcessToJobObject(void *hJob, void *hProcess)',
  );
  const GetLastError = (kernel32 as { func: (s: string) => (...args: unknown[]) => unknown }).func(
    'uint32 GetLastError()',
  );

  const ok = fn(handleAsPointer(job), handleAsPointer(process));
  if (!ok) {
    const errCode = GetLastError() as number;
    throw mapWin32Error(errCode, { operation: 'assignProcessToJobObject' });
  }
}

/**
 * Close a job handle. Triggers KILL_ON_JOB_CLOSE if that flag is set
 * and no other handle keeps the job alive.
 */
export function closeJobObject(job: Handle): void {
  if (!job || job.length === 0) return;
  const k = getKoffi();
  const kernel32 = k.load('kernel32.dll');
  const fn = (kernel32 as { func: (s: string) => (...args: unknown[]) => unknown }).func(
    'int __stdcall CloseHandle(void *hObject)',
  );
  try {
    const ptr = readPointer(job);
    if (ptr !== 0n) {
      fn(ptr);
    }
  } catch {
    // best effort
  }
  job.fill(0);
}

/**
 * RAII wrapper for a job object. Configures limits on construction and
 * closes the handle (triggering KILL_ON_JOB_CLOSE) on dispose.
 */
export class JobObject implements Disposable {
  private _handle: Handle | null;

  constructor(handle: Handle, limits: JobLimits = DEFAULT_JOB_LIMITS) {
    this._handle = asHandle(Buffer.from(handle));
    setJobObjectLimits(this._handle, limits);
  }

  get handle(): Handle {
    if (!this._handle) {
      throw new JobObjectError('JobObject has been disposed', { operation: 'JobObject.handle' });
    }
    return this._handle;
  }

  get disposed(): boolean {
    return this._handle === null;
  }

  setUiRestrictions(flags: JobObjectUiRestrictionFlags): void {
    if (!this._handle) {
      throw new JobObjectError('JobObject has been disposed', {
        operation: 'JobObject.setUiRestrictions',
      });
    }
    setJobObjectBasicUiRestrictions(this._handle, flags);
  }

  assignProcess(process: Handle): void {
    if (!this._handle) {
      throw new JobObjectError('JobObject has been disposed', {
        operation: 'JobObject.assignProcess',
      });
    }
    assignProcessToJobObject(this._handle, process);
  }

  dispose(): void {
    if (this._handle) {
      closeJobObject(this._handle);
      this._handle = null;
    }
  }

  [Symbol.dispose](): void {
    this.dispose();
  }
}
