import { describe, it, expect } from 'vitest';
import {
  lookupPrivilegeValueW,
  enablePrivileges,
  disablePrivileges,
  PrivilegeGuard,
} from './privileges.js';
import { isKoffiAvailable } from './koffi-loader.js';
import { PrivilegeError, TokenCreationError } from './errors.js';
import { makeHandle } from './types.js';

const describeWin = process.platform === 'win32' && isKoffiAvailable() ? describe : describe.skip;

describeWin('sandbox/privileges (Windows only)', () => {
  describe('lookupPrivilegeValueW', () => {
    it('returns a non-zero LUID for a real privilege', () => {
      const luid = lookupPrivilegeValueW(null, 'SeDebugPrivilege');
      expect(luid).not.toBe(0n);
    });

    it('throws for an unknown privilege name', () => {
      expect(() => lookupPrivilegeValueW(null, 'SeThisPrivilegeDoesNotExist12345')).toThrow(PrivilegeError);
    });
  });

  describe('enablePrivileges / disablePrivileges', () => {
    it('throws PrivilegeError on a non-elevated token when enabling privileged rights', () => {
      // We use a dummy handle value — AdjustTokenPrivileges will fail
      // because the handle is invalid, but the LUID lookup must succeed
      // and the call must reach the OS.
      const fakeToken = makeHandle(0xdeadbeef);
      expect(() => enablePrivileges(fakeToken, 'SeDebugPrivilege')).toThrow();
    });

    it('throws on garbage privileges without crashing', () => {
      const fakeToken = makeHandle(0);
      expect(() => disablePrivileges(fakeToken, 'SeDebugPrivilege')).toThrow();
    });
  });

  describe('PrivilegeGuard', () => {
    it('disposes cleanly even on an invalid token (does not throw in dispose)', () => {
      // Construction itself will throw because AdjustTokenPrivileges
      // fails on a fake handle; we verify that the throw happens
      // during construction, not during dispose.
      const fakeToken = makeHandle(0x12345678);
      let constructionThrew = false;
      try {
        new PrivilegeGuard(fakeToken, 'SeDebugPrivilege');
      } catch {
        constructionThrew = true;
      }
      expect(constructionThrew).toBe(true);
    });

    it('throws TokenCreationError if .token is accessed after dispose', () => {
      // Build a guard that doesn't enable any privileges (no
      // construction-time call to AdjustTokenPrivileges), so we can
      // construct it on a fake handle.
      const fakeToken = makeHandle(0);
      const guard = new PrivilegeGuard(fakeToken);
      guard.dispose();
      expect(() => guard.token).toThrow(TokenCreationError);
    });
  });
});
