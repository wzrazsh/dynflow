import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, delimiter } from 'node:path';
import { resolvePiBinary } from './pi-binary.js';

const describeWin = process.platform === 'win32' ? describe : describe.skip;

/**
 * Tests for the shared `resolvePiBinary()` helper.
 *
 * The function is platform-aware: on non-Windows it returns the input
 * unchanged; on Windows it resolves `.cmd` / `.bat` / `.ps1` shims to
 * the underlying `node dist/cli.js` invocation.
 *
 * Tests use a fresh temp dir per case so they can fabricate fake
 * shims + cli.js without polluting the host filesystem.
 */
describe('resolvePiBinary()', () => {
  const originalPath = process.env.PATH;

  let tmp: string;
  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'pi-binary-test-'));
  });
  afterEach(() => {
    process.env.PATH = originalPath;
    rmSync(tmp, { recursive: true, force: true });
  });

  describe('non-Windows platforms', () => {
    it('returns bin as-is on linux', () => {
      const r = resolvePiBinary('/usr/local/bin/pi', 'linux');
      expect(r.executable).toBe('/usr/local/bin/pi');
      expect(r.args).toEqual([]);
    });

    it('returns bin as-is on darwin', () => {
      const r = resolvePiBinary('pi', 'darwin');
      expect(r.executable).toBe('pi');
      expect(r.args).toEqual([]);
    });

    it('does not search PATH on non-Windows', () => {
      // The shared helper is explicitly platform-passed; verify that
      // we don't accidentally consult PATH for a bare 'pi' name.
      process.env.PATH = tmp; // a temp dir that does NOT contain 'pi'
      const r = resolvePiBinary('pi', 'linux');
      expect(r.executable).toBe('pi');
      expect(r.args).toEqual([]);
    });
  });

  describeWin('Windows: .cmd shim resolution', () => {
    it('resolves an unqualified "pi" to a .cmd shim found in PATH', () => {
      // Create a fake .cmd shim in the temp dir, then point PATH there.
      writeFileSync(join(tmp, 'pi.cmd'), '@echo off\r\n');
      // Also create the underlying cli.js that the shim should resolve to.
      const pkgRoot = join(tmp, 'node_modules', '@earendil-works', 'pi-coding-agent', 'dist');
      mkdirSync(pkgRoot, { recursive: true });
      writeFileSync(join(pkgRoot, 'cli.js'), '// entry\n');
      process.env.PATH = [tmp, originalPath].join(delimiter);

      const r = resolvePiBinary('pi', 'win32');
      // Should now resolve to node + cli.js.
      expect(r.executable).toBe(process.execPath);
      expect(r.args).toHaveLength(1);
      expect(r.args[0]).toMatch(/cli\.js$/);
      expect(r.args[0]).toContain('@earendil-works');
    });

    it('resolves an absolute .cmd path to the same node + cli.js form', () => {
      const shimDir = join(tmp, 'shims');
      mkdirSync(shimDir, { recursive: true });
      const shimPath = join(shimDir, 'pi.cmd');
      writeFileSync(shimPath, '@echo off\r\n');
      // Place cli.js in a sibling of the shim dir under node_modules.
      const cliDir = join(shimDir, 'node_modules', '@earendil-works', 'pi-coding-agent', 'dist');
      mkdirSync(cliDir, { recursive: true });
      writeFileSync(join(cliDir, 'cli.js'), '// entry\n');

      const r = resolvePiBinary(shimPath, 'win32');
      expect(r.executable).toBe(process.execPath);
      expect(r.args).toEqual([join(cliDir, 'cli.js')]);
    });

    it('resolves a .bat shim to node + cli.js', () => {
      writeFileSync(join(tmp, 'pi.bat'), '@echo off\r\n');
      const pkgRoot = join(tmp, 'node_modules', '@earendil-works', 'pi-coding-agent', 'dist');
      mkdirSync(pkgRoot, { recursive: true });
      writeFileSync(join(pkgRoot, 'cli.js'), '// entry\n');
      process.env.PATH = [tmp, originalPath].join(delimiter);

      const r = resolvePiBinary('pi', 'win32');
      expect(r.executable).toBe(process.execPath);
      expect(r.args[0]).toMatch(/cli\.js$/);
    });

    it('resolves a .ps1 shim to node + cli.js', () => {
      writeFileSync(join(tmp, 'pi.ps1'), 'Write-Host hi\n');
      const pkgRoot = join(tmp, 'node_modules', '@earendil-works', 'pi-coding-agent', 'dist');
      mkdirSync(pkgRoot, { recursive: true });
      writeFileSync(join(pkgRoot, 'cli.js'), '// entry\n');
      process.env.PATH = [tmp, originalPath].join(delimiter);

      const r = resolvePiBinary('pi', 'win32');
      expect(r.executable).toBe(process.execPath);
      expect(r.args[0]).toMatch(/cli\.js$/);
    });

    it('walks up parent directories to find cli.js (nested install)', () => {
      // Shim is at tmp/.bin/pi.cmd, cli.js is at tmp/node_modules/.../cli.js
      const binDir = join(tmp, '.bin');
      mkdirSync(binDir, { recursive: true });
      writeFileSync(join(binDir, 'pi.cmd'), '@echo off\r\n');
      join(tmp, '..', '..', 'node_modules', '@earendil-works', 'pi-coding-agent', 'dist');
      // Note: this case uses the shimDir.replace trick. We need the cli.js
      // to be reachable from the shim dir, so we create it under tmp's
      // parent traversal chain. For simplicity, just place it in tmp.
      const localCli = join(tmp, 'node_modules', '@earendil-works', 'pi-coding-agent', 'dist', 'cli.js');
      mkdirSync(join(tmp, 'node_modules', '@earendil-works', 'pi-coding-agent', 'dist'), { recursive: true });
      writeFileSync(localCli, '// entry\n');

      const r = resolvePiBinary(join(binDir, 'pi.cmd'), 'win32');
      expect(r.executable).toBe(process.execPath);
      // Args should be the local cli.js, not the (uncreated) pkgRoot above.
      expect(r.args[0]).toBe(localCli);
    });
  });

  describeWin('Windows: .exe passthrough', () => {
    it('returns an existing .exe path with no extra args', () => {
      const exe = join(tmp, 'pi.exe');
      writeFileSync(exe, 'fake exe\n');

      const r = resolvePiBinary(exe, 'win32');
      expect(r.executable).toBe(exe);
      expect(r.args).toEqual([]);
    });

    it('returns a path with no extension as-is', () => {
      const naked = join(tmp, 'pi');
      writeFileSync(naked, 'fake binary\n');

      const r = resolvePiBinary(naked, 'win32');
      expect(r.executable).toBe(naked);
      expect(r.args).toEqual([]);
    });
  });

  describeWin('Windows: not-found / fallback paths', () => {
    it('returns shim path unchanged when no cli.js can be located', () => {
      // Shim exists but no @earendil-works/pi-coding-agent/dist/cli.js
      // anywhere up the parent chain. We get the fallback (shim passthrough).
      const shimDir = join(tmp, 'shims');
      mkdirSync(shimDir, { recursive: true });
      const shimPath = join(shimDir, 'pi.cmd');
      writeFileSync(shimPath, '@echo off\r\n');

      const r = resolvePiBinary(shimPath, 'win32');
      // Fallback: still try the shim, with empty args (may fail later
      // when CreateProcessAsUserW is invoked, but the resolver itself
      // does not throw).
      expect(r.executable).toBe(shimPath);
      expect(r.args).toEqual([]);
    });

    it('returns a missing unqualified "pi" as-is with empty args', () => {
      // PATH does not contain 'pi' anywhere.
      process.env.PATH = tmp; // empty dir
      const r = resolvePiBinary('pi', 'win32');
      // No shim found → passthrough with empty args.
      expect(r.executable).toBe('pi');
      expect(r.args).toEqual([]);
    });

    it('does not throw when cli.js is missing (graceful fallback)', () => {
      const shimDir = join(tmp, 'shims');
      mkdirSync(shimDir, { recursive: true });
      const shimPath = join(shimDir, 'pi.cmd');
      writeFileSync(shimPath, '@echo off\r\n');

      expect(() => resolvePiBinary(shimPath, 'win32')).not.toThrow();
    });
  });
});
