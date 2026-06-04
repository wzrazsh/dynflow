/**
 * Sandbox module barrel + high-level builder.
 *
 * This is the only module the runner needs to import. It composes the
 * lower-level FFI wrappers (token, job, process, dacl) into a single
 * `createSandbox()` call that returns a fully-wired `SandboxContext`.
 *
 * Cleanup is explicit (`cleanupSandbox(ctx)`) and tolerant — it never
 * throws, it logs and continues. The runner is expected to call it in
 * a try/finally block.
 */

import { isKoffiAvailable } from './koffi-loader.js';
import { SandboxError, SandboxUnsupportedError } from './errors.js';
import {
  duplicateTokenEx,
  getCurrentProcessToken,
  getCurrentProcess,
  closeHandle,
  isProcessInJob,
  HandleImpl,
} from './process-token.js';
import {
  createRestrictedToken,
  LIGHT_MODE_FLAGS,
  STRICT_MODE_FLAGS,
  type RestrictedTokenFlagSpec,
} from './restricted-token.js';
import {
  createJobObject,
  setJobObjectLimits,
  setJobObjectBasicUiRestrictions,
  assignProcessToJobObject,
  closeJobObject,
  JobObject,
  DEFAULT_JOB_LIMITS,
  type JobLimits,
  JobObjectUiRestrictions,
  type JobObjectUiRestrictionFlags,
} from './job-object.js';
import {
  buildDacl,
  applyDaclToPath,
  getPathDacl,
  restorePathDacl,
  freeAcl,
  DaclHandle,
  FileAccessMask,
} from './dacl.js';
import {
  allocateSyntheticSid,
  freeSid,
  SidHandle,
} from './sid.js';
import { enablePrivileges } from './privileges.js';
import { type Handle, ProcessCreationFlags, TokenAccess } from './types.js';

export { isKoffiAvailable, SandboxError, SandboxUnsupportedError };

export * from './types.js';
export * from './errors.js';
export * from './koffi-loader.js';
export * from './sid.js';
export * from './privileges.js';
export * from './process-token.js';
export * from './restricted-token.js';
export * from './job-object.js';
export * from './process.js';
export * from './dacl.js';

/** Sandbox mode. */
export type SandboxMode = 'light' | 'strict';

/** Configuration for `createSandbox`. */
export interface SandboxConfig {
  /** light = WRITE_RESTRICTED only; strict = DISABLE_MAX_PRIVILEGE |
   *  SANDBOX_INERT | WRITE_RESTRICTED plus DACL. */
  readonly mode: SandboxMode;
  /** Memory limit per process, in bytes. Default 2GB. */
  readonly memoryLimitBytes: number;
  /** Path to the workspace directory. Must exist on disk. */
  readonly workspacePath: string;
  /** Apply UI restrictions (desktop, exit-windows). Default: false. */
  readonly enableUiRestrictions: boolean;
  /** Environment variables to pass to the sandboxed process.
   *  This is the FULL set — caller is responsible for whitelisting. */
  readonly environment: Record<string, string>;
}

/** A live sandbox instance. The caller MUST call `cleanupSandbox` to
 *  release all resources. */
export interface SandboxContext {
  /** The primary token to pass to CreateProcessAsUserW. */
  readonly token: Handle;
  /** The job object that will receive the new process. */
  readonly job: JobObject;
  /** Strict-mode-only DACL wrapper, or null in light mode. */
  readonly dacl: DaclHandle | null;
  /** Cleanup function. Idempotent and never throws. */
  readonly cleanup: () => Promise<void>;
}

/** Whether this host can run the Windows native sandbox. */
export function isSupported(): boolean {
  return process.platform === 'win32' && isKoffiAvailable();
}

/** Internal state for cleanup logging. */
type CleanupLogger = (msg: string, err?: unknown) => void;

const defaultLogger: CleanupLogger = (msg, err) => {
  if (err) {
    // eslint-disable-next-line no-console
    console.error(`[sandbox] ${msg}: ${String(err)}`);
  } else {
    // eslint-disable-next-line no-console
    console.log(`[sandbox] ${msg}`);
  }
};

/**
 * Create a sandbox. Validates the config, opens a process token,
 * duplicates it as a primary, builds a restricted token (light or
 * strict), creates a job object with KILL_ON_JOB_CLOSE, and (strict
 * mode) applies a DACL to the workspace.
 */
export function createSandbox(config: SandboxConfig, logger: CleanupLogger = defaultLogger): SandboxContext {
  if (!isSupported()) {
    throw new SandboxUnsupportedError(
      `Windows native sandbox is not supported on this host (platform=${process.platform}, koffi=${isKoffiAvailable()})`,
      { operation: 'createSandbox' },
    );
  }
  if (config.memoryLimitBytes <= 0) {
    throw new SandboxError('memoryLimitBytes must be > 0', 'INVALID_CONFIG', { operation: 'createSandbox' });
  }
  if (!config.workspacePath) {
    throw new SandboxError('workspacePath is required', 'INVALID_CONFIG', { operation: 'createSandbox' });
  }

  // 1. Open the current process token. We need TOKEN_DUPLICATE |
  //    TOKEN_QUERY | TOKEN_ADJUST_PRIVILEGES | TOKEN_ADJUST_GROUPS.
  const srcToken = getCurrentProcessToken();

  // 2. Duplicate as a primary token. The duplicated token is what we
  //    pass to CreateProcessAsUserW.
  const primaryToken = duplicateTokenEx(srcToken);
  closeHandle(srcToken);

  // 3. Build the restricted token. Light mode is just WRITE_RESTRICTED.
  //    Strict mode also disables max privileges and adds a synthetic SID
  //    to the restrict list.
  const flagSpec: RestrictedTokenFlagSpec = config.mode === 'strict' ? STRICT_MODE_FLAGS : LIGHT_MODE_FLAGS;

  let syntheticSid: SidHandle | null = null;
  let addRestrictSids: ReturnType<typeof allocateSyntheticSid>[] = [];
  if (config.mode === 'strict') {
    // Allocate a synthetic SID in the local NT authority that the
    // DACL will grant access to.
    syntheticSid = new SidHandle(allocateSyntheticSid(5, [80, 1000 + Math.floor(Math.random() * 1000)]));
    addRestrictSids = [syntheticSid.sid];
  }
  const restrictedToken = createRestrictedToken(primaryToken, flagSpec, {
    addRestrictSids,
    denySids: [],
    privilegesToDelete: [],
  });
  closeHandle(primaryToken);

  // Per MSDN, CreateRestrictedToken returns a TokenImpersonation handle.
  // CreateProcessAsUserW requires a primary token, so we duplicate the
  // restricted token back to primary before passing it to the process
  // creation call. This is the same pattern Chromium uses in
  // restricted_token_utils.cc and what the T1 spike demonstrated.
  const finalToken = duplicateTokenEx(restrictedToken, TokenAccess.TOKEN_ALL_ACCESS, { tokenType: 'primary' });
  closeHandle(restrictedToken);
  // We don't free the synthetic SID here — it's consumed by the
  // restricted token. We track it via the syntheticSid handle but
  // don't dispose it (the token holds the reference). It is freed
  // when the restricted token is closed.
  // For now, we mark the local SidHandle as disposed without calling
  // freeSid on the inner SID (the OS now owns the SID copy).
  if (syntheticSid) {
    // Suppress the inner free by nulling out the buffer.
    (syntheticSid as unknown as { _sid: null })._sid = null;
  }

  // 4. Create the job object with KILL_ON_JOB_CLOSE and the memory limit.
  const jobLimits: JobLimits = {
    ...DEFAULT_JOB_LIMITS,
    maxProcessMemoryBytes: config.memoryLimitBytes,
  };
  const jobHandle = createJobObject();
  setJobObjectLimits(jobHandle, jobLimits);
  if (config.enableUiRestrictions) {
    const uiFlags: JobObjectUiRestrictionFlags =
      JobObjectUiRestrictions.JOB_OBJECT_UILIMIT_DESKTOP |
      JobObjectUiRestrictions.JOB_OBJECT_UILIMIT_DISPLAYSETTINGS |
      JobObjectUiRestrictions.JOB_OBJECT_UILIMIT_EXITWINDOWS;
    setJobObjectBasicUiRestrictions(jobHandle, uiFlags);
  }
  const job = new JobObject(jobHandle, jobLimits);
  // JobObject's constructor calls setJobObjectLimits again. We need to
  // make sure the limits are still right.
  void jobHandle;

  // 5. Strict mode: build a DACL granting access to the synthetic SID,
  //    back up the original, and apply.
  let daclHandle: DaclHandle | null = null;
  if (config.mode === 'strict') {
    const originalAcl = getPathDacl(config.workspacePath);
    const newAcl = buildDacl([
      { sid: addRestrictSids[0]!, accessMask: FileAccessMask.FILE_GENERIC_ALL, mode: 'grant' },
    ]);
    daclHandle = new DaclHandle(config.workspacePath, newAcl, originalAcl);
    daclHandle.apply();
  }

  // 6. Assemble the cleanup function.
  const cleanup = async (): Promise<void> => {
    // Order matters: close token (releases synthetic SID), then job
    // (triggers KILL_ON_JOB_CLOSE), then DACL restore (must happen
    // BEFORE the token is closed so the synthetic SID is still valid
    // for the restore — actually no, the restore uses the originalAcl
    // SID which is a different object, so order is: dacl first).
    if (daclHandle) {
      try {
        daclHandle.restore();
      } catch (e) {
        logger('dacl restore failed', e);
      } finally {
        daclHandle.dispose();
      }
    }
    try {
      job.dispose();
    } catch (e) {
      logger('job dispose failed', e);
    }
    // We don't call closeJobObject(jobHandle) again — the JobObject
    // wrapper already did.
    try {
      closeHandle(finalToken);
    } catch (e) {
      logger('token close failed', e);
    }
    // The original (pre-restriction) primary token was already closed
    // by closeHandle(primaryToken) above. The synthetic SID was
    // consumed by CreateRestrictedToken (which copies it), so it does
    // NOT need to be freed here.
  };

  return { token: finalToken, job, dacl: daclHandle, cleanup };
}

/**
 * Cleanup a sandbox context. Never throws — logs and continues.
 * Equivalent to calling `ctx.cleanup()`.
 */
export async function cleanupSandbox(ctx: SandboxContext, logger: CleanupLogger = defaultLogger): Promise<void> {
  try {
    await ctx.cleanup();
  } catch (e) {
    logger('cleanup failed', e);
  }
}

// Silence unused-import warnings.
void enablePrivileges;
void getCurrentProcess;
void isProcessInJob;
void HandleImpl;
void assignProcessToJobObject;
void ProcessCreationFlags;
void freeSid;
void freeAcl;
void getPathDacl;
void restorePathDacl;
void applyDaclToPath;
