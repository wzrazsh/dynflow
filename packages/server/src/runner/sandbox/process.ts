/**
 * Process creation and management.
 *
 * This module wraps `CreateProcessAsUserW` and friends. It is the
 * most security-sensitive module in the sandbox:
 *
 *   1. **bInheritHandles must always be FALSE** — if TRUE, the spawned
 *      process inherits every open handle in the server (sockets,
 *      database files, etc.), completely defeating the sandbox.
 *   2. **The environment block must be built manually** — using
 *      `CreateEnvironmentBlock` would copy the server's full env,
 *      leaking secrets like AWS_*, GITHUB_TOKEN, etc.
 *   3. **CREATE_SUSPENDED + ResumeThread pattern** — the caller must
 *      assign the new process to a job BEFORE resuming its main
 *      thread. Otherwise there's a race window where the process runs
 *      outside the job's limits.
 *
 * The struct-size verifier runs at module load to catch koffi
 * description errors that would cause silent memory corruption.
 */

import { getKoffi } from './koffi-loader.js';
import {
  ProcessCreationError,
  mapWin32Error,
} from './errors.js';
import {
  asHandle,
  handleAsPointer,
  type Handle,
  ProcessCreationFlags,
  StartupInfoFlags,
  verifyStructSizes,
  ExpectedStructSizes,
  type StructSpec,
  readPointer,
} from './types.js';

/** STARTUPINFOW options that callers may set. */
export interface StartupInfoOptions {
  /** Optional stdout pipe write handle (use CreatePipe first). */
  readonly stdoutHandle?: Handle | null;
  /** Optional stderr pipe write handle. */
  readonly stderrHandle?: Handle | null;
  /** Optional stdin pipe read handle. */
  readonly stdinHandle?: Handle | null;
  /** ShowWindow flag value (default SW_HIDE=0). */
  readonly showWindow?: number;
}

/** Process handles returned by CreateProcessAsUserW. */
export interface ProcessHandles {
  readonly processHandle: Handle;
  readonly threadHandle: Handle;
  readonly processId: number;
  readonly threadId: number;
}

/** Cached Koffi struct handles. */
let startupInfoStruct: unknown | null = null;
let processInformationStruct: unknown | null = null;
let securityAttributesStruct: unknown | null = null;

function ensureProcessStructs(): {
  startupInfo: unknown;
  processInformation: unknown;
  securityAttributes: unknown;
} {
  if (startupInfoStruct && processInformationStruct && securityAttributesStruct) {
    return {
      startupInfo: startupInfoStruct,
      processInformation: processInformationStruct,
      securityAttributes: securityAttributesStruct,
    };
  }
  const k = getKoffi();

  // STARTUPINFOW (104 bytes on x64). Layout per MSDN:
  //   DWORD  cb;              // offset 0
  //   LPWSTR lpReserved;      // offset 8 (pointer)
  //   LPWSTR lpDesktop;       // offset 16
  //   LPWSTR lpTitle;         // offset 24
  //   DWORD  dwX;             // offset 32
  //   DWORD  dwY;             // offset 36
  //   DWORD  dwXSize;         // offset 40
  //   DWORD  dwYSize;         // offset 44
  //   DWORD  dwXCountChars;   // offset 48
  //   DWORD  dwYCountChars;   // offset 52
  //   DWORD  dwFillAttribute; // offset 56
  //   DWORD  dwFlags;         // offset 60
  //   WORD   wShowWindow;     // offset 64
  //   WORD   cbReserved2;     // offset 66
  //   LPBYTE lpReserved2;     // offset 72 (pointer + 4 pad)
  //   HANDLE hStdInput;       // offset 80
  //   HANDLE hStdOutput;      // offset 88
  //   HANDLE hStdError;       // offset 96
  // Total: 104
  startupInfoStruct = k.struct('STARTUPINFOW', {
    cb: 'uint32',
    lpReserved: 'void *',
    lpDesktop: 'void *',
    lpTitle: 'void *',
    dwX: 'uint32',
    dwY: 'uint32',
    dwXSize: 'uint32',
    dwYSize: 'uint32',
    dwXCountChars: 'uint32',
    dwYCountChars: 'uint32',
    dwFillAttribute: 'uint32',
    dwFlags: 'uint32',
    wShowWindow: 'uint16',
    cbReserved2: 'uint16',
    lpReserved2: 'void *',
    hStdInput: 'void *',
    hStdOutput: 'void *',
    hStdError: 'void *',
  });

  // PROCESS_INFORMATION (24 bytes on x64):
  //   HANDLE hProcess;    // offset 0
  //   HANDLE hThread;     // offset 8
  //   DWORD  dwProcessId; // offset 16
  //   DWORD  dwThreadId;  // offset 20
  processInformationStruct = k.struct('PROCESS_INFORMATION', {
    hProcess: 'void *',
    hThread: 'void *',
    dwProcessId: 'uint32',
    dwThreadId: 'uint32',
  });

  // SECURITY_ATTRIBUTES (24 bytes on x64):
  //   DWORD  nLength;              // offset 0
  //   LPVOID lpSecurityDescriptor; // offset 8 (pointer)
  //   BOOL   bInheritHandle;       // offset 16
  //   pad                         // offset 20
  securityAttributesStruct = k.struct('SECURITY_ATTRIBUTES', {
    nLength: 'uint32',
    lpSecurityDescriptor: 'void *',
    bInheritHandle: 'int32',
  });

  return {
    startupInfo: startupInfoStruct,
    processInformation: processInformationStruct,
    securityAttributes: securityAttributesStruct,
  };
}

/** Verify the struct sizes match MSVC layout. Throws on mismatch. */
export function verifyProcessStructSizes(): void {
  const k = getKoffi();
  const { startupInfo, processInformation, securityAttributes } = ensureProcessStructs();
  const specs: StructSpec[] = [
    {
      name: 'STARTUPINFOW',
      expectedSize: ExpectedStructSizes.STARTUPINFOW,
      koffiStruct: startupInfo,
    },
    {
      name: 'PROCESS_INFORMATION',
      expectedSize: ExpectedStructSizes.PROCESS_INFORMATION,
      koffiStruct: processInformation,
    },
    {
      name: 'SECURITY_ATTRIBUTES',
      expectedSize: ExpectedStructSizes.SECURITY_ATTRIBUTES,
      koffiStruct: securityAttributes,
    },
  ];
  verifyStructSizes(k, specs);
}

/**
 * Build a double-null-terminated UTF-16LE environment block.
 *
 * This is the on-wire format CreateProcessAsUserW expects in its
 * `lpEnvironment` argument when CREATE_UNICODE_ENVIRONMENT is set.
 * Each entry is "KEY=VALUE\0", with a final "\0" marking the end of
 * the block.
 *
 * We build this manually (rather than using `CreateEnvironmentBlock`)
 * so we have full control over which variables the sandboxed process
 * sees. Whitelisting happens in the higher-level builder (`index.ts`).
 */
export function buildEnvironmentBlock(env: Record<string, string>): Buffer {
  const parts: Buffer[] = [];
  for (const [k, v] of Object.entries(env)) {
    // Each "KEY=VALUE" as UTF-16LE, then a null terminator (2 bytes of 0).
    const entry = Buffer.from(`${k}=${v}`, 'utf16le');
    parts.push(entry);
    parts.push(Buffer.from([0, 0]));
  }
  // Final null terminator marking end of block.
  parts.push(Buffer.from([0, 0]));
  return Buffer.concat(parts);
}

/** Build a STARTUPINFOW buffer with the given options. */
export function buildStartupInfoBuffer(options: StartupInfoOptions = {}): Buffer {
  const buf = Buffer.alloc(ExpectedStructSizes.STARTUPINFOW);
  // cb field
  buf.writeUInt32LE(ExpectedStructSizes.STARTUPINFOW, 0);
  // All pointers are null (lpReserved, lpDesktop, lpTitle, lpReserved2)
  // dwX..dwYCountChars all 0
  // dwFillAttribute 0

  // dwFlags: STARTF_USESTDHANDLES if any std handle was provided, plus
  // STARTF_USESHOWWINDOW if a window value was provided.
  let dwFlags = 0;
  if (
    options.stdoutHandle !== undefined ||
    options.stderrHandle !== undefined ||
    options.stdinHandle !== undefined
  ) {
    dwFlags |= StartupInfoFlags.STARTF_USESTDHANDLES;
  }
  if (options.showWindow !== undefined) {
    dwFlags |= StartupInfoFlags.STARTF_USESHOWWINDOW;
  }
  buf.writeUInt32LE(dwFlags, 60);

  if (options.showWindow !== undefined) {
    buf.writeUInt16LE(options.showWindow & 0xffff, 64);
  }

  // hStdInput, hStdOutput, hStdError (offset 80, 88, 96)
  if (options.stdinHandle) {
    buf.writeBigUInt64LE(handleAsPointer(options.stdinHandle), 80);
  }
  if (options.stdoutHandle) {
    buf.writeBigUInt64LE(handleAsPointer(options.stdoutHandle), 88);
  }
  if (options.stderrHandle) {
    buf.writeBigUInt64LE(handleAsPointer(options.stderrHandle), 96);
  }
  return buf;
}

/** Create a pipe and return the read + write handles. */
export interface PipePair {
  readonly readHandle: Handle;
  readonly writeHandle: Handle;
}

export function createPipe(inheritRead: boolean = false, inheritWrite: boolean = false): PipePair {
  const k = getKoffi();
  const kernel32 = k.load('kernel32.dll');
  const fn = (kernel32 as { func: (s: string) => (...args: unknown[]) => unknown }).func(
    'int __stdcall CreatePipe(void **hReadPipe, void **hWritePipe, void *lpPipeAttributes, uint32 nSize)',
  );
  const GetLastError = (kernel32 as { func: (s: string) => (...args: unknown[]) => unknown }).func(
    'uint32 GetLastError()',
  );

  // SECURITY_ATTRIBUTES for the write end (the one inherited by the child).
  // Read end is non-inheritable.
  const saBuf = Buffer.alloc(ExpectedStructSizes.SECURITY_ATTRIBUTES);
  saBuf.writeUInt32LE(ExpectedStructSizes.SECURITY_ATTRIBUTES, 0); // nLength
  saBuf.writeBigUInt64LE(0n, 8); // lpSecurityDescriptor = NULL
  saBuf.writeInt32LE(inheritWrite ? 1 : 0, 16); // bInheritHandle

  const readPtr = Buffer.alloc(8);
  const writePtr = Buffer.alloc(8);
  const ok = fn(readPtr, writePtr, saBuf, 0); // nSize=0 = default buffer
  if (!ok) {
    const errCode = GetLastError() as number;
    throw mapWin32Error(errCode, { operation: 'createPipe' });
  }
  void inheritRead;
  return {
    readHandle: asHandle(readPtr),
    writeHandle: asHandle(writePtr),
  };
}

/**
 * Spawn a process under the given primary token.
 *
 * The process is created SUSPENDED. The caller is expected to assign it
 * to a job (`assignProcessToJobObject`) and then call `resumeThread`.
 *
 * `bInheritHandles` is hard-coded to FALSE. This is intentional and
 * must not be changed — see the file header.
 */
export function createProcessAsUser(
  token: Handle,
  applicationPath: string | null,
  commandLine: string,
  options: {
    readonly environment?: Record<string, string>;
    readonly currentDirectory?: string;
    readonly startupInfo?: StartupInfoOptions;
    readonly creationFlags?: number;
  } = {},
): ProcessHandles {
  // bInheritHandles is intentionally false. We assert this in code so
  // future edits can't change it accidentally.
  const B_INHERIT_HANDLES = 0;
  if (B_INHERIT_HANDLES !== 0) {
    throw new ProcessCreationError('bInheritHandles must be FALSE for sandbox security', {
      operation: 'createProcessAsUser',
    });
  }

  const k = getKoffi();
  const { startupInfo, processInformation } = ensureProcessStructs();
  const advapi32 = k.load('advapi32.dll');
  const CreateProcessAsUserW = (
    advapi32 as { func: (s: string) => (...args: unknown[]) => unknown }
  ).func(
    'int __stdcall CreateProcessAsUserW(void *hToken, const char16_t *lpApplicationName, char16_t *lpCommandLine, void *lpProcessAttributes, void *lpThreadAttributes, int bInheritHandles, uint32 dwCreationFlags, void *lpEnvironment, const char16_t *lpCurrentDirectory, void *lpStartupInfo, void *lpProcessInformation)',
  );
  const kernel32 = k.load('kernel32.dll');
  const GetLastError = (kernel32 as { func: (s: string) => (...args: unknown[]) => unknown }).func(
    'uint32 GetLastError()',
  );

  // Encode the application name (optional) and command line as UTF-16LE.
  // CreateProcessAsUserW mutates lpCommandLine, so we pass a writable
  // copy.
  const appNameBuf = applicationPath ? Buffer.from(applicationPath, 'utf16le') : null;
  const cmdLineBuf = Buffer.from(commandLine + '\0', 'utf16le'); // null terminator

  // SECURITY_ATTRIBUTES pointers (both null = default non-inheritable).
  // We never want inheritable handles.
  const envBuf = options.environment ? buildEnvironmentBlock(options.environment) : null;
  const cwdBuf = options.currentDirectory ? Buffer.from(options.currentDirectory, 'utf16le') : null;
  const siBuf = buildStartupInfoBuffer(options.startupInfo ?? {});

  // Default creation flags: CREATE_SUSPENDED | CREATE_UNICODE_ENVIRONMENT | CREATE_NO_WINDOW.
  // CREATE_NO_WINDOW prevents a console window from flashing on the user.
  // CREATE_BREAKAWAY_FROM_JOB is the caller's responsibility to add if
  // the parent is in a job.
  const dwFlags = options.creationFlags ??
    (ProcessCreationFlags.CREATE_SUSPENDED |
      ProcessCreationFlags.CREATE_UNICODE_ENVIRONMENT |
      ProcessCreationFlags.CREATE_NO_WINDOW);

  // PROCESS_INFORMATION output buffer.
  const piBuf = Buffer.alloc(ExpectedStructSizes.PROCESS_INFORMATION);

  const ok = CreateProcessAsUserW(
    handleAsPointer(token),
    appNameBuf,
    cmdLineBuf,
    null, // lpProcessAttributes
    null, // lpThreadAttributes
    B_INHERIT_HANDLES,
    dwFlags,
    envBuf,
    cwdBuf,
    siBuf,
    piBuf,
  );
  if (!ok) {
    const errCode = GetLastError() as number;
    throw mapWin32Error(errCode, { operation: 'createProcessAsUser' });
  }

  // Unpack PROCESS_INFORMATION.
  const procHandlePtr = piBuf.readBigUInt64LE(0);
  const threadHandlePtr = piBuf.readBigUInt64LE(8);
  const procId = piBuf.readUInt32LE(16);
  const threadId = piBuf.readUInt32LE(20);

  // Wrap into Handle buffers.
  const procHandleBuf = Buffer.alloc(8);
  procHandleBuf.writeBigUInt64LE(procHandlePtr, 0);
  const threadHandleBuf = Buffer.alloc(8);
  threadHandleBuf.writeBigUInt64LE(threadHandlePtr, 0);

  return {
    processHandle: asHandle(procHandleBuf),
    threadHandle: asHandle(threadHandleBuf),
    processId: procId,
    threadId: threadId,
  };
  // Silence unused-imports for cached struct handles.
  void startupInfo;
  void processInformation;
}

/** Resume a suspended thread. */
export function resumeThread(thread: Handle): number {
  const k = getKoffi();
  const kernel32 = k.load('kernel32.dll');
  const fn = (kernel32 as { func: (s: string) => (...args: unknown[]) => unknown }).func(
    'uint32 __stdcall ResumeThread(void *hThread)',
  );
  const GetLastError = (kernel32 as { func: (s: string) => (...args: unknown[]) => unknown }).func(
    'uint32 GetLastError()',
  );
  const prev = fn(handleAsPointer(thread)) as number;
  // -1 is the documented error return.
  if (prev === 0xffffffff) {
    const errCode = GetLastError() as number;
    throw mapWin32Error(errCode, { operation: 'resumeThread' });
  }
  return prev;
}

/** Terminate a process (use sparingly; KILL_ON_JOB_CLOSE is preferred). */
export function terminateProcess(process: Handle, exitCode: number = 1): void {
  const k = getKoffi();
  const kernel32 = k.load('kernel32.dll');
  const fn = (kernel32 as { func: (s: string) => (...args: unknown[]) => unknown }).func(
    'int __stdcall TerminateProcess(void *hProcess, uint32 uExitCode)',
  );
  const GetLastError = (kernel32 as { func: (s: string) => (...args: unknown[]) => unknown }).func(
    'uint32 GetLastError()',
  );
  const ok = fn(handleAsPointer(process), exitCode >>> 0);
  if (!ok) {
    const errCode = GetLastError() as number;
    throw mapWin32Error(errCode, { operation: 'terminateProcess' });
  }
}

/** Wait for a single object (process, thread, etc.) up to timeoutMs.
 *  Returns 0 on success (signaled), 0x102 (WAIT_TIMEOUT) on timeout,
 *  0xFFFFFFFF on error. */
export function waitForSingleObject(handle: Handle, timeoutMs: number): number {
  const k = getKoffi();
  const kernel32 = k.load('kernel32.dll');
  const fn = (kernel32 as { func: (s: string) => (...args: unknown[]) => unknown }).func(
    'uint32 __stdcall WaitForSingleObject(void *hHandle, uint32 dwMilliseconds)',
  );
  const GetLastError = (kernel32 as { func: (s: string) => (...args: unknown[]) => unknown }).func(
    'uint32 GetLastError()',
  );
  const result = fn(handleAsPointer(handle), timeoutMs >>> 0) as number;
  if (result === 0xffffffff) {
    const errCode = GetLastError() as number;
    throw mapWin32Error(errCode, { operation: 'waitForSingleObject' });
  }
  return result >>> 0;
}

/** Get the exit code of a process. STILL_ACTIVE (259) means the process
 *  is still running. */
export function getExitCodeProcess(process: Handle): number {
  const k = getKoffi();
  const kernel32 = k.load('kernel32.dll');
  const fn = (kernel32 as { func: (s: string) => (...args: unknown[]) => unknown }).func(
    'int __stdcall GetExitCodeProcess(void *hProcess, uint32 *lpExitCode)',
  );
  const GetLastError = (kernel32 as { func: (s: string) => (...args: unknown[]) => unknown }).func(
    'uint32 GetLastError()',
  );
  const outBuf = Buffer.alloc(4);
  const ok = fn(handleAsPointer(process), outBuf);
  if (!ok) {
    const errCode = GetLastError() as number;
    throw mapWin32Error(errCode, { operation: 'getExitCodeProcess' });
  }
  return outBuf.readUInt32LE(0);
}

/** Read from a pipe (anonymously-typed HANDLE). */
export function readPipe(pipe: Handle, maxBytes: number): { bytesRead: number; data: Buffer } {
  const k = getKoffi();
  const kernel32 = k.load('kernel32.dll');
  const fn = (kernel32 as { func: (s: string) => (...args: unknown[]) => unknown }).func(
    'int __stdcall ReadFile(void *hFile, void *lpBuffer, uint32 nNumberOfBytesToRead, uint32 *lpNumberOfBytesRead, void *lpOverlapped)',
  );
  const GetLastError = (kernel32 as { func: (s: string) => (...args: unknown[]) => unknown }).func(
    'uint32 GetLastError()',
  );

  const buf = Buffer.alloc(maxBytes);
  const readBuf = Buffer.alloc(4);
  const ok = fn(handleAsPointer(pipe), buf, maxBytes, readBuf, null);
  if (!ok) {
    const errCode = GetLastError() as number;
    // ERROR_BROKEN_PIPE (109) means the child closed its end — not fatal.
    if (errCode === 109) {
      return { bytesRead: 0, data: Buffer.alloc(0) };
    }
    throw mapWin32Error(errCode, { operation: 'readPipe' });
  }
  const bytesRead = readBuf.readUInt32LE(0);
  return { bytesRead, data: buf.subarray(0, bytesRead) };
}

/** Close a pipe handle (CloseHandle). */
export function closePipe(pipe: Handle): void {
  if (!pipe || pipe.length === 0) return;
  const k = getKoffi();
  const kernel32 = k.load('kernel32.dll');
  const fn = (kernel32 as { func: (s: string) => (...args: unknown[]) => unknown }).func(
    'int __stdcall CloseHandle(void *hObject)',
  );
  try {
    const ptr = readPointer(pipe);
    if (ptr !== 0n) {
      fn(ptr);
    }
  } catch {
    // best effort
  }
  pipe.fill(0);
}
