import { existsSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Result of resolving a Pi binary path on the current platform.
 *
 * The `executable` field is always an absolute or PATH-relative path to a
 * real executable file (never a Windows shell script). The `args` field
 * contains any additional arguments that must be passed to that executable
 * (most commonly, the path to Pi's `cli.js` entrypoint when the user
 * asked for a `.cmd` shim that we cannot run directly under a sandboxed
 * child process).
 */
export interface ResolvedPiBinary {
  /** Path to a real executable. On POSIX: the binary itself. On Windows:
   *  either the `.exe` directly, or `process.execPath` (Node) when the
   *  caller originally asked for a `.cmd` shim. */
  executable: string;
  /** Extra args to prepend before the caller's args. Empty for `.exe` and
   *  POSIX binaries. Contains the resolved `cli.js` path for shims. */
  args: string[];
}

/**
 * Resolve a Pi binary path to a (executable, args) pair suitable for
 * `child_process.spawn` (i.e. without a shell).
 *
 * On non-Windows platforms this is a no-op — `bin` is returned as-is
 * (after PATH resolution, performed by the caller / the OS).
 *
 * On Windows, the npm-installed Pi is a `.cmd` (or `.bat`/`.ps1`) shim
 * that requires `cmd.exe` to interpret. We cannot run a shell under our
 * sandboxed process, so we resolve the shim to the underlying
 * `node dist/cli.js` invocation. This is the same trick that lets the
 * Python/Node ecosystem run npm shims under supervisors that forbid
 * `cmd.exe`.
 *
 * The function is **pure** in the sense that it never reads from the
 * network, never spawns a process, and never mutates global state — but
 * it does hit the local filesystem (`existsSync`) and reads
 * `process.env.PATH` to find unqualified binaries. The `platform`
 * parameter is passed in (rather than read from `process.platform`)
 * so that tests can exercise both branches deterministically.
 *
 * @param bin       The user-requested binary. May be unqualified
 *                  (`'pi'`), absolute (`'C:\node\pi.cmd'`), or
 *                  relative (`'./node_modules/.bin/pi'`).
 * @param platform  The platform the resolution is running on. Pass
 *                  `process.platform` in production code.
 */
export function resolvePiBinary(
  bin: string,
  platform: NodeJS.Platform,
): ResolvedPiBinary {
  if (platform !== 'win32') return { executable: bin, args: [] };

  // Find the actual shim path. If `bin` is unqualified (just 'pi'),
  // search PATH for the .cmd shim.
  let shimPath = bin;
  if (!/[\\/]/.test(bin)) {
    const pathSep = ';';
    const dirs = (process.env.PATH ?? '').split(pathSep).filter(Boolean);
    for (const dir of dirs) {
      for (const ext of ['.cmd', '.bat', '.ps1', '']) {
        const candidate = join(dir, bin + ext);
        if (existsSync(candidate)) {
          shimPath = candidate;
          break;
        }
      }
      if (shimPath !== bin) break;
    }
  }
  if (!/\.(cmd|bat|ps1)$/i.test(shimPath)) {
    // Already a real .exe / script — pass through.
    return { executable: shimPath, args: [] };
  }

  // shimPath is a Windows shim — find the underlying node + cli.js.
  const shimDir = shimPath.replace(/[\\/][^\\/]+$/, '');
  const candidates = [
    join(shimDir, 'node_modules', '@earendil-works', 'pi-coding-agent', 'dist', 'cli.js'),
    join(shimDir, '..', 'node_modules', '@earendil-works', 'pi-coding-agent', 'dist', 'cli.js'),
    join(shimDir, '..', '..', 'node_modules', '@earendil-works', 'pi-coding-agent', 'dist', 'cli.js'),
    join(shimDir, '..', '..', '..', 'node_modules', '@earendil-works', 'pi-coding-agent', 'dist', 'cli.js'),
  ];
  for (const cliPath of candidates) {
    if (existsSync(cliPath)) {
      return { executable: process.execPath, args: [cliPath] };
    }
  }
  // Fallback: still try the shim. The sandbox layer or `CreateProcessAsUserW`
  // may fail later with a clear error, which is preferable to silently
  // returning an unresolvable path.
  return { executable: shimPath, args: [] };
}
