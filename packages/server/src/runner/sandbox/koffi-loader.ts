/**
 * Lazy Koffi loader.
 *
 * Why lazy: importing `koffi` at the top of a module causes Node to
 * fail at process start on non-Windows or when the native binding is
 * not built. The sandbox module is loaded only when the
 * `WindowsNativeRunner` is selected, so we want any koffi errors to
 * surface there, not at app boot.
 *
 * Contract:
 *   - `isKoffiAvailable()` returns true iff koffi can be loaded on
 *     this host (Windows + native binding present).
 *   - `getKoffi()` returns the koffi module. On non-Windows it throws
 *     `SandboxUnsupportedError` so callers can branch cleanly.
 *   - `loadLibrary(name)` returns a koffi library handle, throwing
 *     `SandboxUnsupportedError` on non-Windows.
 *   - All three functions are safe to call concurrently (the load
 *     is memoized).
 */

import { createRequire } from 'node:module';
import { SandboxUnsupportedError } from './errors.js';

// We use a small structural type for koffi so this module stays
// testable without a real native binding present.
export interface KoffiModule {
  load: (name: string) => unknown;
  func: (signature: string) => (...args: unknown[]) => unknown;
  sizeof: (struct: unknown) => number;
  struct: (name: string, fields: Record<string, unknown>) => unknown;
  array: (inner: unknown, length: number) => unknown;
  pointer: (target: string | unknown, release?: boolean) => unknown;
  alias: (name: string, target: string) => void;
  decode: (ptr: unknown, target: unknown) => unknown;
  // koffi.encode has multiple signatures:
  //   encode(ref, type, value)
  //   encode(ref, offset, type, value)
  //   encode(ref, offset, type, value, len)
  // We model this as a single variadic function and let callers pick
  // the right one.
  encode: (...args: unknown[]) => void;
  // koffi.alloc(type, length) — typed heap allocation.
  alloc: (...args: unknown[]) => unknown;
  // koffi.address(value) — returns the absolute address of an allocation.
  address: (value: unknown) => bigint;
  free: (ptr: unknown) => void;
  // Koffi exposes many more APIs; we type only what we use.
  [key: string]: unknown;
}

let cachedModule: KoffiModule | null = null;
let loadAttempted = false;
let loadFailure: Error | null = null;

/**
 * Synchronous check: returns true if koffi is loadable on this host.
 * Never throws.
 */
export function isKoffiAvailable(): boolean {
  // Avoid the real load if we already know.
  if (loadAttempted) return cachedModule !== null;
  if (process.platform !== 'win32') return false;
  try {
    // Use require under the hood so we can do a sync load check.
    // We use a hidden helper so test mocks can intercept.
    const k = requireKoffi();
    if (k) {
      cachedModule = k as KoffiModule;
      loadAttempted = true;
      return true;
    }
    return false;
  } catch {
    loadAttempted = true;
    loadFailure = new Error('koffi load threw');
    return false;
  }
}

/**
 * Get the koffi module. Throws SandboxUnsupportedError on non-Windows
 * or if the load fails.
 */
export function getKoffi(): KoffiModule {
  if (cachedModule) return cachedModule;
  if (loadFailure) {
    throw new SandboxUnsupportedError(
      `Koffi is not available: ${loadFailure.message}`,
      { operation: 'getKoffi', cause: loadFailure },
    );
  }
  if (process.platform !== 'win32') {
    throw new SandboxUnsupportedError(
      `Koffi-backed sandbox is only supported on Windows (this host: ${process.platform})`,
      { operation: 'getKoffi' },
    );
  }
  try {
    const k = requireKoffi();
    if (!k) {
      throw new SandboxUnsupportedError('koffi import returned empty', { operation: 'getKoffi' });
    }
    cachedModule = k as KoffiModule;
    loadAttempted = true;
    return cachedModule;
  } catch (e) {
    loadAttempted = true;
    loadFailure = e instanceof Error ? e : new Error(String(e));
    throw new SandboxUnsupportedError(
      `Koffi is not available: ${loadFailure.message}`,
      { operation: 'getKoffi', cause: loadFailure },
    );
  }
}

/**
 * Load a DLL via koffi. Throws SandboxUnsupportedError on non-Windows.
 */
export function loadLibrary(name: string): unknown {
  const k = getKoffi();
  return k.load(name);
}

/** Internal: dynamic import. Cached and recoverable. */
function requireKoffi(): unknown {
  // We use createRequire to load koffi as a CJS module from this
  // ESM file. This keeps the loader side-effect-free at module import
  // (koffi's native binding is only resolved when this function runs).
  const req = createRequire(import.meta.url);
  return req('koffi');
}

/**
 * Reset the module cache. Test-only utility.
 */
export function _resetKoffiCache(): void {
  cachedModule = null;
  loadAttempted = false;
  loadFailure = null;
}
