import { describe, it, expect } from 'vitest';
import {
  isSupported,
  createSandbox,
  cleanupSandbox,
  LIGHT_MODE_FLAGS,
  STRICT_MODE_FLAGS,
  SandboxError,
  SandboxUnsupportedError,
} from './index.js';
import { isKoffiAvailable } from './koffi-loader.js';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const describeWin = process.platform === 'win32' && isKoffiAvailable() ? describe : describe.skip;

describe('sandbox/index', () => {
  describe('isSupported', () => {
    it('returns true on Windows with koffi available', () => {
      if (process.platform === 'win32' && isKoffiAvailable()) {
        expect(isSupported()).toBe(true);
      } else {
        expect(isSupported()).toBe(false);
      }
    });
  });

  describe('flag presets are exported', () => {
    it('exposes LIGHT_MODE_FLAGS with WRITE_RESTRICTED only', () => {
      expect(LIGHT_MODE_FLAGS.writeRestricted).toBe(true);
      expect(LIGHT_MODE_FLAGS.disableMaxPrivilege).toBe(false);
    });
    it('exposes STRICT_MODE_FLAGS with all hardening flags', () => {
      expect(STRICT_MODE_FLAGS.writeRestricted).toBe(true);
      expect(STRICT_MODE_FLAGS.sandboxInert).toBe(true);
      expect(STRICT_MODE_FLAGS.luaToken).toBe(true);
      expect(STRICT_MODE_FLAGS.disableMaxPrivilege).toBe(true);
    });
  });

  describe('createSandbox config validation', () => {
    it('rejects memoryLimitBytes <= 0', () => {
      if (!isSupported()) return;
      expect(() =>
        createSandbox({
          mode: 'light',
          memoryLimitBytes: 0,
          workspacePath: os.tmpdir(),
          enableUiRestrictions: false,
          environment: {},
        }),
      ).toThrow(SandboxError);
    });

    it('rejects empty workspacePath', () => {
      if (!isSupported()) return;
      expect(() =>
        createSandbox({
          mode: 'light',
          memoryLimitBytes: 1024 * 1024,
          workspacePath: '',
          enableUiRestrictions: false,
          environment: {},
        }),
      ).toThrow(SandboxError);
    });

    it('throws SandboxUnsupportedError on non-Windows', () => {
      if (isSupported()) return;
      expect(() =>
        createSandbox({
          mode: 'light',
          memoryLimitBytes: 1024 * 1024,
          workspacePath: os.tmpdir(),
          enableUiRestrictions: false,
          environment: {},
        }),
      ).toThrow(SandboxUnsupportedError);
    });
  });

  describeWin('Windows-only sandbox lifecycle', () => {
    it('light mode: create + cleanup round-trip', async () => {
      const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'dynflow-sb-light-'));
      try {
        const ctx = createSandbox({
          mode: 'light',
          memoryLimitBytes: 256 * 1024 * 1024,
          workspacePath: workspace,
          enableUiRestrictions: false,
          environment: { TEST: '1' },
        });
        // The context has a token, a job, no dacl (light mode), and a cleanup.
        expect(ctx.token).toBeDefined();
        expect(ctx.job).toBeDefined();
        expect(ctx.dacl).toBeNull();
        expect(typeof ctx.cleanup).toBe('function');

        // Cleanup is idempotent and never throws.
        await cleanupSandbox(ctx);
        await cleanupSandbox(ctx); // idempotent
      } finally {
        try {
          fs.rmdirSync(workspace);
        } catch {
          // best effort
        }
      }
    });

    it('strict mode: create + cleanup restores DACL', async () => {
      const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'dynflow-sb-strict-'));
      try {
        const ctx = createSandbox({
          mode: 'strict',
          memoryLimitBytes: 256 * 1024 * 1024,
          workspacePath: workspace,
          enableUiRestrictions: true,
          environment: { TEST: '1' },
        });
        // Strict mode creates a DaclHandle.
        expect(ctx.dacl).not.toBeNull();
        expect(ctx.dacl!.applied).toBe(true);

        // After cleanup, the DACL must be restored.
        await cleanupSandbox(ctx);
        // The current user must still be able to write to the workspace.
        const testFile = path.join(workspace, 'post-cleanup.txt');
        fs.writeFileSync(testFile, 'ok');
        expect(fs.readFileSync(testFile, 'utf8')).toBe('ok');
      } finally {
        try {
          const testFile = path.join(workspace, 'post-cleanup.txt');
          if (fs.existsSync(testFile)) fs.unlinkSync(testFile);
          fs.rmdirSync(workspace);
        } catch {
          // best effort
        }
      }
    });

    it('cleanupSandbox does not throw on a context that was already cleaned', async () => {
      const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'dynflow-sb-clean-'));
      try {
        const ctx = createSandbox({
          mode: 'light',
          memoryLimitBytes: 256 * 1024 * 1024,
          workspacePath: workspace,
          enableUiRestrictions: false,
          environment: {},
        });
        await cleanupSandbox(ctx);
        // Calling cleanup again must not throw.
        await expect(cleanupSandbox(ctx)).resolves.toBeUndefined();
      } finally {
        try {
          fs.rmdirSync(workspace);
        } catch {
          // best effort
        }
      }
    });
  });
});
