import { describe, it, expect } from 'vitest';
import {
  buildEnvironmentBlock,
  buildStartupInfoBuffer,
  createPipe,
  createProcessAsUser,
  resumeThread,
  terminateProcess,
  waitForSingleObject,
  getExitCodeProcess,
  closePipe,
  readPipe,
  verifyProcessStructSizes,
} from './process.js';
import { isKoffiAvailable, getKoffi } from './koffi-loader.js';
import { getCurrentProcessToken, duplicateTokenEx, closeHandle } from './process-token.js';
import { ExpectedStructSizes, ProcessCreationFlags } from './types.js';

const describeWin = process.platform === 'win32' && isKoffiAvailable() ? describe : describe.skip;

describe('sandbox/process', () => {
  describe('buildEnvironmentBlock (pure)', () => {
    it('produces a buffer that is double-null terminated', () => {
      const buf = buildEnvironmentBlock({ FOO: 'bar' });
      // The buffer must end with two zero bytes (a UTF-16LE null char).
      expect(buf.length).toBeGreaterThan(0);
      expect(buf[buf.length - 1]).toBe(0);
      expect(buf[buf.length - 2]).toBe(0);
    });

    it('encodes entries as UTF-16LE with null separators', () => {
      const buf = buildEnvironmentBlock({ A: '1' });
      // Find "A=1" in UTF-16LE.
      const expected = Buffer.from('A=1', 'utf16le');
      expect(buf.indexOf(expected)).toBe(0);
      // Right after that, a UTF-16LE null.
      expect(buf.readUInt16LE(expected.length)).toBe(0);
    });

    it('handles multiple entries separated by nulls', () => {
      const buf = buildEnvironmentBlock({ A: '1', B: '2', C: '3' });
      const expectedA = Buffer.from('A=1', 'utf16le');
      const expectedB = Buffer.from('B=2', 'utf16le');
      const expectedC = Buffer.from('C=3', 'utf16le');
      expect(buf.indexOf(expectedA)).toBe(0);
      // B should come after A + its null terminator.
      const aEnd = expectedA.length + 2;
      expect(buf.indexOf(expectedB)).toBe(aEnd);
      const bEnd = aEnd + expectedB.length + 2;
      expect(buf.indexOf(expectedC)).toBe(bEnd);
    });

    it('handles an empty env block', () => {
      const buf = buildEnvironmentBlock({});
      // Just a final null terminator (UTF-16LE).
      expect(buf.length).toBe(2);
      expect(buf.readUInt16LE(0)).toBe(0);
    });

    it('preserves non-ASCII characters', () => {
      const buf = buildEnvironmentBlock({ GREETING: 'héllo' });
      const expected = Buffer.from('héllo', 'utf16le');
      expect(buf.indexOf(expected)).toBeGreaterThan(0);
    });
  });

  describe('buildStartupInfoBuffer (pure)', () => {
    it('has correct cb field', () => {
      const buf = buildStartupInfoBuffer();
      expect(buf.readUInt32LE(0)).toBe(ExpectedStructSizes.STARTUPINFOW);
    });

    it('does not set STARTF_USESTDHANDLES by default', () => {
      const buf = buildStartupInfoBuffer();
      const dwFlags = buf.readUInt32LE(60);
      expect(dwFlags & 0x100).toBe(0);
    });

    it('does not set STARTF_USESHOWWINDOW by default', () => {
      const buf = buildStartupInfoBuffer();
      const dwFlags = buf.readUInt32LE(60);
      expect(dwFlags & 0x01).toBe(0);
    });

    it('sets STARTF_USESTDHANDLES when a handle is provided', () => {
      const fakeHandle = Buffer.alloc(8);
      fakeHandle.writeBigUInt64LE(0x12345678n, 0);
      const buf = buildStartupInfoBuffer({ stdoutHandle: fakeHandle as never });
      const dwFlags = buf.readUInt32LE(60);
      expect(dwFlags & 0x100).toBe(0x100);
      // The handle pointer is written at offset 88 (hStdOutput).
      expect(buf.readBigUInt64LE(88)).toBe(0x12345678n);
    });
  });

  describeWin('Windows-only FFI behavior', () => {
    it('verifyProcessStructSizes passes', () => {
      expect(() => verifyProcessStructSizes()).not.toThrow();
    });

    it('createPipe returns two non-null handles', () => {
      const pair = createPipe(false, false);
      try {
        expect(pair.readHandle.readBigUInt64LE(0)).not.toBe(0n);
        expect(pair.writeHandle.readBigUInt64LE(0)).not.toBe(0n);
        // Distinct handles.
        expect(pair.readHandle.readBigUInt64LE(0)).not.toBe(pair.writeHandle.readBigUInt64LE(0));
      } finally {
        closePipe(pair.readHandle);
        closePipe(pair.writeHandle);
      }
    });

    it('createProcessAsUser with cmd.exe and CREATE_SUSPENDED works', () => {
      // Build a primary token (duplicate the current process token).
      const src = getCurrentProcessToken();
      const token = duplicateTokenEx(src);
      closeHandle(src);
      try {
        const stdout = createPipe(false, true);
        try {
          const handles = createProcessAsUser(
            token,
            null,
            'cmd.exe /c echo hello-from-sandbox',
            {
              startupInfo: { stdoutHandle: stdout.writeHandle },
              creationFlags:
                ProcessCreationFlags.CREATE_SUSPENDED |
                ProcessCreationFlags.CREATE_UNICODE_ENVIRONMENT |
                ProcessCreationFlags.CREATE_NO_WINDOW,
            },
          );
          try {
            expect(handles.processId).toBeGreaterThan(0);
            expect(handles.threadId).toBeGreaterThan(0);
            // Resume the suspended thread.
            const prev = resumeThread(handles.threadHandle);
            expect(prev).toBeGreaterThanOrEqual(0);
            // Wait for it to finish.
            const waitResult = waitForSingleObject(handles.processHandle, 5000);
            expect(waitResult).toBe(0); // signaled
            const exitCode = getExitCodeProcess(handles.processHandle);
            expect(exitCode).toBe(0);
          } finally {
            closeHandle(handles.processHandle);
            closeHandle(handles.threadHandle);
          }
        } finally {
          closePipe(stdout.readHandle);
          closePipe(stdout.writeHandle);
        }
      } finally {
        closeHandle(token);
      }
    });

    it('terminateProcess ends a running process', () => {
      const src = getCurrentProcessToken();
      const token = duplicateTokenEx(src);
      closeHandle(src);
      try {
        const handles = createProcessAsUser(
          token,
          null,
          'cmd.exe /c ping -n 30 127.0.0.1',
          {
            creationFlags:
              ProcessCreationFlags.CREATE_SUSPENDED |
              ProcessCreationFlags.CREATE_UNICODE_ENVIRONMENT |
              ProcessCreationFlags.CREATE_NO_WINDOW,
          },
        );
        try {
          resumeThread(handles.threadHandle);
          // Give it a moment to actually start.
          waitForSingleObject(handles.threadHandle, 100);
          terminateProcess(handles.processHandle, 99);
          const waitResult = waitForSingleObject(handles.processHandle, 5000);
          expect(waitResult).toBe(0);
          const exitCode = getExitCodeProcess(handles.processHandle);
          expect(exitCode).toBe(99);
        } finally {
          closeHandle(handles.processHandle);
          closeHandle(handles.threadHandle);
        }
      } finally {
        closeHandle(token);
      }
    });

    it('readPipe round-trips a parent-written message', () => {
      // Use WriteFile to put data into the pipe, then readPipe to read it.
      // The child-process-stdout-inheritance path is exercised in the
      // runner integration test (T4/T15) where we control more knobs.
      const k = getKoffi();
      const kernel32 = k.load('kernel32.dll');
      const WriteFile = (kernel32 as { func: (s: string) => (...args: unknown[]) => unknown }).func(
        'int __stdcall WriteFile(void *hFile, const void *lpBuffer, uint32 nNumberOfBytesToWrite, uint32 *lpNumberOfBytesWritten, void *lpOverlapped)',
      );
      const stdout = createPipe(false, true);
      try {
        const msg = Buffer.from('hello-from-pipe', 'utf8');
        const written = Buffer.alloc(4);
        const writeOk = WriteFile((stdout.writeHandle as unknown as { readBigUInt64LE(n: number): bigint }).readBigUInt64LE(0), msg, msg.length, written, null);
        expect(writeOk).toBeTruthy();
        closePipe(stdout.writeHandle);
        const { bytesRead, data } = readPipe(stdout.readHandle, 4096);
        expect(bytesRead).toBe(msg.length);
        expect(data.toString('utf8')).toBe('hello-from-pipe');
      } finally {
        closePipe(stdout.readHandle);
      }
    });
  });
});
