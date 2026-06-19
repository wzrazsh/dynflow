/**
 * AppContainer profile management via Koffi FFI.
 *
 * Scope: this module owns the Win32 calls needed to *create* an
 * AppContainer profile, derive its SID, find its per-profile folder,
 * and delete it. It does NOT spawn processes — that lives in
 * `process.ts` and is composed by the `PiAppContainerRunner`.
 *
 * Background
 * ----------
 * Windows AppContainer is a process-isolation model introduced in
 * Windows 8. Every AppContainer process is associated with a
 * "profile" identified by a SID of the form
 *   S-1-15-3-1024-<...>-<...>
 *
 * The profile grants the process a private filesystem root
 * (`GetAppContainerFolderPath` returns its absolute path) and a
 * deny-by-default set of capabilities (no network, no broad
 * filesystem, no read of user files). To run an agent inside an
 * AppContainer, you:
 *
 *   1. Create or reuse a profile (CreateAppContainerProfile).
 *   2. Derive the SID for the profile name
 *      (DeriveAppContainerSidFromAppContainerName).
 *   3. Launch the process with `STARTUPINFOEXW.lpAttributeList`
 *      containing `PROC_THREAD_ATTRIBUTE_SECURITY_CAPABILITIES` whose
 *      `AppContainerSid` is the SID from step 2 and whose
 *      `Capabilities` enumerates the granted capability SIDs
 *      (e.g. `internetClient` so the LLM HTTP call works).
 *
 * This file implements step 1, 2, and the lookup helper. Step 3 is
 * the runner's responsibility — it composes the SECURITY_CAPABILITIES
 * struct from the SID returned here and feeds it to a koffi-backed
 * `CreateProcessW` call in `process.ts`.
 *
 * Availability
 * ------------
 * The profile APIs are exported by `userenv.dll` and require
 * Windows 8+ and the AppContainer feature (enabled by default on
 * Windows 11). On hosts where the functions are absent (e.g.
 * stripped-down Windows Server Core containers) `isSupported()`
 * returns false and the runner exposes itself as unavailable.
 *
 * All calls are wrapped in try/catch and re-thrown as `SandboxError`
 * subclasses so the runner sees a stable error surface across koffi
 * binding quirks.
 */

import {
  getKoffi,
  loadLibrary,
  SandboxError,
  SandboxUnsupportedError,
} from './index.js';

/**
 * AppContainer profile name — must be unique per host and follow
 * the package-family naming rules (alphanumeric + '.', '-').
 */
export type AppContainerName = string;

/**
 * Self-relative SID bytes (Revision, SubAuthorityCount, then
 * authority + sub-authorities). Suitable for embedding into
 * SECURITY_CAPABILITIES.AppContainerSid at CreateProcessW time.
 */
export type AppContainerSid = Buffer;

export interface CreateProfileOptions {
  readonly name: AppContainerName;
  /** User-facing label shown in the Windows Settings app list. */
  readonly displayName: string;
  /** User-facing description shown next to the label. */
  readonly description: string;
}

export interface AppContainerProfile {
  /** The profile name (input to create). */
  readonly name: AppContainerName;
  /** The AppContainer SID (self-relative bytes). */
  readonly sid: AppContainerSid;
  /** Absolute path to the per-profile folder. */
  readonly folderPath: string;
  /**
   * Tear down the profile and release its resources. After this
   * call the SID and folder handle MUST NOT be reused.
   *
   * The SID Buffer is left intact; we don't own its memory.
   */
  readonly dispose: () => void;
}

interface AppContainerBindings {
  readonly CreateAppContainerProfile: (
    appContainerName: string,
    displayName: string,
    description: string,
    pCapabilities: unknown,
    dwCapabilityCount: number,
    pSidAppContainerSid: unknown,
  ) => number;
  readonly DeriveAppContainerSidFromAppContainerName: (
    appContainerName: string,
    pDerivedAppContainerSid: unknown,
  ) => number;
  readonly DeleteAppContainerProfile: (appContainerName: string) => number;
  readonly GetAppContainerFolderPath: (
    appContainerSid: unknown,
    dwFlags: number,
    ppszPath: unknown,
  ) => number;
}

let userenv: unknown | null = null;
let cachedBindings: AppContainerBindings | null = null;

/**
 * Returns true if the AppContainer profile APIs are loadable on
 * this host (Windows + koffi present + userenv.dll exports the
 * symbols). Never throws.
 */
export function isSupported(): boolean {
  if (process.platform !== 'win32') return false;
  try {
    getBindings();
    return cachedBindings !== null;
  } catch {
    return false;
  }
}

function getBindings(): AppContainerBindings {
  if (cachedBindings) return cachedBindings;
  if (!userenv) {
    try {
      userenv = loadLibrary('userenv.dll');
    } catch (err) {
      throw new SandboxUnsupportedError(
        'AppContainer profile APIs are unavailable: cannot load userenv.dll.',
        { operation: 'loadLibrary', cause: err },
      );
    }
  }
  const k = getKoffi() as {
    func: (lib: unknown, name: string, rtype: string, ...args: string[]) => unknown;
  };
  try {
    cachedBindings = {
      CreateAppContainerProfile: k.func(
        userenv,
        'CreateAppContainerProfile',
        'long',
        'str16', 'str16', 'str16', 'void*', 'uint32', 'void**',
      ) as AppContainerBindings['CreateAppContainerProfile'],
      DeriveAppContainerSidFromAppContainerName: k.func(
        userenv,
        'DeriveAppContainerSidFromAppContainerName',
        'long',
        'str16', 'void**',
      ) as AppContainerBindings['DeriveAppContainerSidFromAppContainerName'],
      DeleteAppContainerProfile: k.func(
        userenv,
        'DeleteAppContainerProfile',
        'long',
        'str16',
      ) as AppContainerBindings['DeleteAppContainerProfile'],
      GetAppContainerFolderPath: k.func(
        userenv,
        'GetAppContainerFolderPath',
        'long',
        'void*', 'uint32', 'void**',
      ) as AppContainerBindings['GetAppContainerFolderPath'],
    };
  } catch (err) {
    throw new SandboxUnsupportedError(
      'AppContainer profile APIs are unavailable: failed to bind koffi prototypes.',
      { operation: 'koffi.func', cause: err },
    );
  }
  return cachedBindings;
}

/**
 * Convert a returned native SID pointer into a Node Buffer so the
 * caller can reuse it. AppContainer SIDs (both profile and
 * capability) fit comfortably in 68 bytes (the documented maximum
 * for a 15-subauthority SID). We trust the convention that
 * byte[1] = SubAuthorityCount and that the actual SID is `8 +
 * SubAuthorityCount * 4` bytes long.
 */
function readSidFromPointer(sidPtr: unknown): Buffer {
  if (!sidPtr) {
    throw new SandboxError(
      'AppContainer SID pointer was null.',
      'APPCONTAINER_NULL_SID',
    );
  }
  const k = getKoffi() as { decode: (ptr: unknown, len: number) => Buffer };
  const raw = k.decode(sidPtr, 68);
  const subAuthCount = raw.readUInt8(1);
  const length = 8 + subAuthCount * 4;
  return raw.subarray(0, length);
}

function readWideStringFromPointer(pathPtr: unknown): string {
  if (!pathPtr) return '';
  const k = getKoffi() as { decode: (ptr: unknown, len: number, type?: string) => string };
  // pwstr is null-terminated UTF-16LE. Probe up to 1024 chars;
  // AppContainer folder paths are far shorter.
  return k.decode(pathPtr, 1024, 'str16').replace(/\0+$/, '');
}

/**
 * Create an AppContainer profile and return its handle. If a profile
 * with the same name already exists, the existing one is returned
 * (the Win32 API returns HRESULT_FROM_WIN32(ERROR_ALREADY_EXISTS) in
 * that case, which we treat as success and derive the SID for the
 * pre-existing profile).
 */
export function createAppContainerProfile(
  options: CreateProfileOptions,
): AppContainerProfile {
  const bindings = getBindings();
  const k = getKoffi() as { pointer: (type: string) => unknown };

  // Pass zero capabilities; capability grants are owned by the
  // SECURITY_CAPABILITIES struct the runner composes at
  // CreateProcessW time (see PiAppContainerRunner).
  const ALREADY_EXISTS = 0x800700b7; // HRESULT_FROM_WIN32(ERROR_ALREADY_EXISTS)
  const hr = bindings.CreateAppContainerProfile(
    options.name,
    options.displayName,
    options.description,
    null,
    0,
    k.pointer('void*'),
  );
  if (hr < 0 && hr !== ALREADY_EXISTS) {
    throw new SandboxError(
      `CreateAppContainerProfile failed for "${options.name}" (hr=0x${hr.toString(16)}).`,
      'APPCONTAINER_CREATE_FAILED',
    );
  }

  // Whether we created or re-opened, derive the SID.
  const sidPtr = k.pointer('void*');
  const sidHr = bindings.DeriveAppContainerSidFromAppContainerName(
    options.name,
    sidPtr,
  );
  if (sidHr < 0) {
    throw new SandboxError(
      `DeriveAppContainerSidFromAppContainerName failed for "${options.name}" (hr=0x${sidHr.toString(16)}).`,
      'APPCONTAINER_DERIVE_SID_FAILED',
    );
  }
  const sid = readSidFromPointer(sidPtr);

  // Per-profile folder.
  const pathPtr = k.pointer('void*');
  const pathHr = bindings.GetAppContainerFolderPath(sid, 0, pathPtr);
  if (pathHr < 0) {
    throw new SandboxError(
      `GetAppContainerFolderPath failed (hr=0x${pathHr.toString(16)}).`,
      'APPCONTAINER_FOLDER_PATH_FAILED',
    );
  }
  const folderPath = readWideStringFromPointer(pathPtr);

  return {
    name: options.name,
    sid,
    folderPath,
    dispose() {
      try {
        const disposeHr = bindings.DeleteAppContainerProfile(options.name);
        if (disposeHr < 0) {
          console.warn(
            `DeleteAppContainerProfile returned hr=0x${disposeHr.toString(16)} for "${options.name}".`,
          );
        }
      } catch (err) {
        console.warn(`DeleteAppContainerProfile threw: ${String(err)}`);
      }
    },
  };
}

/** Test-only: reset the binding cache. */
export function _resetBindingCache(): void {
  cachedBindings = null;
  userenv = null;
}