import { existsSync } from 'node:fs';
import { mkdir, writeFile, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import type { AgentRunConfig, AgentResult, AgentRunner } from './types.js';
import { parsePiJsonLines } from './pi-output-parser.js';
import { scanWorkspaceChanges } from './workspace-scanner.js';
import { buildPiPrompt } from './prompt-builder.js';
import { resolvePiBinary } from './pi-binary.js';
import * as sandbox from './sandbox/index.js';
import {
  createAppContainerProfile,
  isSupported as isAppContainerSupported,
  type AppContainerProfile,
} from './sandbox/appcontainer.js';
import { logger } from '../logger.js';

/** Cap buffered stdout/stderr per stream. */
const MAX_BUFFER_BYTES = 64 * 1024 * 1024;

/** Default memory limit per sandboxed process, in bytes. */
const DEFAULT_MEMORY_LIMIT_BYTES = 2 * 1024 * 1024 * 1024;

/** Pipe read chunk size. */
const PIPE_READ_CHUNK = 64 * 1024;

/** Still-Active exit code from GetExitCodeProcess. */
const STILL_ACTIVE = 259;

/** WAIT_TIMEOUT return value from WaitForSingleObject. */
const WAIT_TIMEOUT = 0x102;

/**
 * Env vars that the runner passes to the child. Same allowlist as
 * WindowsNativeRunner / CuaPiRunner.
 */
const ALLOWED_ENV_KEYS = new Set<string>([
  'PATH',
  'HOME',
  'USERPROFILE',
  'SYSTEMROOT',
  'TEMP',
  'TMP',
  'LANG',
  'LC_ALL',
  'NODE_PATH',
  'NODE_OPTIONS',
  'DYNFLOW_CUA_SERVER_URL',
  'DYNFLOW_PI_PROVIDER',
  'DYNFLOW_PI_MODEL',
  'DYNFLOW_PI_BINARY',
]);

interface ProcessSlot {
  readonly job: sandbox.JobObject;
  readonly processHandle: sandbox.Handle;
  readonly threadHandle: sandbox.Handle;
  readonly cleanup: () => Promise<void>;
  readonly promptFile: string | null;
  readonly appContainerProfile: AppContainerProfile;
}

export interface PiAppContainerRunnerOptions {
  binary?: string;
  provider?: string;
  model?: string;
  memoryLimitBytes?: number;
  processRegistry?: Map<string, ProcessSlot>;
  /**
   * Override the per-run profile name. Defaults to
   * `dynflow-pi-<agentId>` (sanitized). Set to a stable name to
   * reuse the same profile across runs.
   */
  profileName?: (agentId: string) => string;
}

/**
 * PiAppContainerRunner — runs Pi inside a Windows AppContainer
 * profile.
 *
 * Availability
 * ------------
 * `isAvailable()` returns `true` only when:
 *   - `process.platform === 'win32'`
 *   - Koffi is loadable
 *   - `userenv.dll` exports the AppContainer profile APIs
 *     (`CreateAppContainerProfile`, etc.)
 *
 * What it actually does
 * ---------------------
 * On every `run()` this runner:
 *   1. Creates (or reuses) an AppContainer profile named
 *      `dynflow-pi-<agentId>` via the Win32 profile API.
 *   2. Launches the child Pi process through the same
 *      Restricted-Token + Job-Object sandbox as
 *      `WindowsNativeRunner`.
 *   3. Waits for the process to exit, parses its JSONL output,
 *      and returns the result.
 *   4. On cleanup, deletes the AppContainer profile.
 *
 * Process-attribute caveat
 * ------------------------
 * The "real" AppContainer enforcement on Windows requires
 * `STARTUPINFOEXW.lpAttributeList` carrying
 * `PROC_THREAD_ATTRIBUTE_SECURITY_CAPABILITIES` whose
 * `AppContainerSid` and `Capabilities` point at the profile SID
 * and the granted capability SIDs (e.g. `internetClient`). Wiring
 * that into `process.ts`'s `createProcessAsUser` requires
 * extending its struct layout to `STARTUPINFOEXW` and managing the
 * `PROC_THREAD_ATTRIBUTE_LIST` arena. That work is intentionally
 * deferred — the AppContainer profile is created and disposed
 * correctly, providing a per-run isolation namespace and a
 * discoverable SID/folder (visible in `Get-AppxPackage` output),
 * but the actual process security boundary is the existing
 * Restricted Token + Job Object sandbox.
 */
export class PiAppContainerRunner implements AgentRunner {
  private readonly binary: string;
  private readonly provider: string;
  private readonly model: string;
  private readonly memoryLimitBytes: number;
  private readonly processRegistry: Map<string, ProcessSlot>;
  private readonly profileName: (agentId: string) => string;

  constructor(options: PiAppContainerRunnerOptions = {}) {
    this.binary = options.binary ?? process.env.DYNFLOW_PI_BINARY ?? 'pi';
    this.provider = options.provider ?? process.env.DYNFLOW_PI_PROVIDER ?? 'opencode';
    this.model = options.model ?? process.env.DYNFLOW_PI_MODEL ?? 'mimo-v2.5-free';
    this.memoryLimitBytes = options.memoryLimitBytes ?? DEFAULT_MEMORY_LIMIT_BYTES;
    this.processRegistry = options.processRegistry ?? new Map();
    this.profileName =
      options.profileName ?? ((id) => `dynflow-pi-${id.replace(/[^a-zA-Z0-9._-]/g, '_')}`);
  }

  /** True iff the host supports Restricted-Token + AppContainer APIs. */
  static isAvailable(): boolean {
    return sandbox.isSupported() && isAppContainerSupported();
  }

  private buildChildEnv(config: AgentRunConfig): NodeJS.ProcessEnv {
    const env: NodeJS.ProcessEnv = {};
    for (const key of ALLOWED_ENV_KEYS) {
      const v = process.env[key];
      if (v !== undefined) env[key] = v;
    }
    if (config.apiKey) {
      const provider = config.llmProvider ?? this.provider;
      switch (provider) {
        case 'openai':
        case 'azure-openai-responses':
        case 'minimax':
          env.OPENAI_API_KEY = config.apiKey;
          break;
        case 'anthropic':
          env.ANTHROPIC_API_KEY = config.apiKey;
          break;
        case 'opencode':
        case 'opencode-go':
          env.OPENCODE_API_KEY = config.apiKey;
          break;
      }
    }
    if (process.env.OPENAI_BASE_URL) env.OPENAI_BASE_URL = process.env.OPENAI_BASE_URL;
    return env;
  }

  private buildPrompt(userPrompt: string, workDir: string): string {
    return buildPiPrompt({ userPrompt, workspaceMount: workDir });
  }

  async run(config: AgentRunConfig): Promise<AgentResult> {
    if (!PiAppContainerRunner.isAvailable()) {
      return {
        success: false,
        error:
          'Pi AppContainer runner is not supported on this host ' +
          '(non-Windows, Koffi unavailable, or userenv.dll AppContainer APIs missing).',
        containerId: '',
      };
    }

    const workDir = config.workspacePath;
    if (!workDir) {
      return {
        success: false,
        error: 'workspacePath is required for PiAppContainerRunner',
        containerId: '',
      };
    }
    await mkdir(workDir, { recursive: true });

    // Create the AppContainer profile before the sandbox so a
    // profile-creation failure surfaces a clear error.
    const profileName = this.profileName(config.agentId);
    let profile: AppContainerProfile;
    try {
      profile = createAppContainerProfile({
        name: profileName,
        displayName: `DynFlow Pi (${config.agentId})`,
        description: `AppContainer profile for DynFlow Pi agent run "${config.agentId}".`,
      });
      logger.info(
        { profileName: profile.name, sidLength: profile.sid.length, folder: profile.folderPath },
        'AppContainer profile created',
      );
    } catch (err) {
      return {
        success: false,
        error: `Failed to create AppContainer profile: ${String(err)}`,
        containerId: '',
      };
    }

    const resolved = resolvePiBinary(this.binary, process.platform);
    if (!existsSync(resolved.executable)) {
      profile.dispose();
      return {
        success: false,
        error: `Pi CLI ('${this.binary}') is not available. Resolved to '${resolved.executable}' which does not exist.`,
        containerId: '',
      };
    }

    const promptText = this.buildPrompt(config.prompt, workDir);
    const safeAgentId = config.agentId.replace(/[^a-zA-Z0-9_-]/g, '_');
    const promptFile = join(workDir, `.dynflow-prompt-${safeAgentId}-${Date.now()}.md`);
    try {
      await writeFile(promptFile, promptText, 'utf-8');
    } catch (err) {
      profile.dispose();
      return {
        success: false,
        error: `Failed to write prompt file: ${String(err)}`,
        containerId: '',
      };
    }

    const shortInstruction = `Read the instructions in ${promptFile} and execute them.`;
    const piArgs = [shortInstruction];

    let ctx: sandbox.SandboxContext;
    try {
      ctx = sandbox.createSandbox({
        mode: 'light',
        memoryLimitBytes: this.memoryLimitBytes,
        workspacePath: workDir,
        enableUiRestrictions: false,
        environment: envToRecord(this.buildChildEnv(config)),
      });
    } catch (err) {
      profile.dispose();
      await this.bestEffortUnlink(promptFile);
      return {
        success: false,
        error: `Failed to create sandbox: ${String(err)}`,
        containerId: '',
      };
    }

    let stdoutPipe: sandbox.PipePair | null = null;
    let stderrPipe: sandbox.PipePair | null = null;
    try {
      stdoutPipe = sandbox.createPipe(false, true);
      stderrPipe = sandbox.createPipe(false, true);
    } catch (err) {
      await sandbox.cleanupSandbox(ctx);
      profile.dispose();
      await this.bestEffortUnlink(promptFile);
      return {
        success: false,
        error: `Failed to create stdout/stderr pipes: ${String(err)}`,
        containerId: '',
      };
    }

    let processHandles: sandbox.ProcessHandles;
    try {
      processHandles = sandbox.createProcessAsUser(
        ctx.token,
        process.platform === 'win32' && resolved.args.length > 0 ? resolved.executable : null,
        process.platform === 'win32' && resolved.args.length > 0
          ? [resolved.executable, ...resolved.args, ...piArgs].map(quoteForCmd).join(' ')
          : [resolved.executable, ...piArgs].map(quoteForCmd).join(' '),
        {
          environment: envToRecord(this.buildChildEnv(config)),
          currentDirectory: workDir,
          startupInfo: {
            stdoutHandle: stdoutPipe.writeHandle,
            stderrHandle: stderrPipe.writeHandle,
            showWindow: 0, // SW_HIDE
          },
          creationFlags:
            sandbox.ProcessCreationFlags.CREATE_SUSPENDED |
            sandbox.ProcessCreationFlags.CREATE_UNICODE_ENVIRONMENT |
            sandbox.ProcessCreationFlags.CREATE_NO_WINDOW,
        },
      );
    } catch (err) {
      try { sandbox.closePipe(stdoutPipe.writeHandle); } catch { /* ignore */ }
      try { sandbox.closePipe(stderrPipe.writeHandle); } catch { /* ignore */ }
      await sandbox.cleanupSandbox(ctx);
      profile.dispose();
      await this.bestEffortUnlink(promptFile);
      return {
        success: false,
        error: `CreateProcessAsUserW failed: ${String(err)}`,
        containerId: '',
      };
    }

    // Close the parent's copy of the write ends — the child owns them.
    try { sandbox.closePipe(stdoutPipe.writeHandle); } catch { /* ignore */ }
    try { sandbox.closePipe(stderrPipe.writeHandle); } catch { /* ignore */ }

    // Assign the process to the job BEFORE resuming.
    try {
      ctx.job.assignProcess(processHandles.processHandle);
    } catch (err) {
      try { sandbox.terminateProcess(processHandles.processHandle, 1); } catch { /* ignore */ }
      try { sandbox.closePipe(processHandles.processHandle); } catch { /* ignore */ }
      try { sandbox.closePipe(processHandles.threadHandle); } catch { /* ignore */ }
      try { sandbox.closePipe(stdoutPipe.readHandle); } catch { /* ignore */ }
      try { sandbox.closePipe(stderrPipe.readHandle); } catch { /* ignore */ }
      await sandbox.cleanupSandbox(ctx);
      profile.dispose();
      await this.bestEffortUnlink(promptFile);
      return {
        success: false,
        error: `AssignProcessToJobObject failed: ${String(err)}`,
        containerId: '',
      };
    }

    try {
      sandbox.resumeThread(processHandles.threadHandle);
    } catch (err) {
      try { sandbox.terminateProcess(processHandles.processHandle, 1); } catch { /* ignore */ }
      try { sandbox.closePipe(processHandles.processHandle); } catch { /* ignore */ }
      try { sandbox.closePipe(processHandles.threadHandle); } catch { /* ignore */ }
      try { sandbox.closePipe(stdoutPipe.readHandle); } catch { /* ignore */ }
      try { sandbox.closePipe(stderrPipe.readHandle); } catch { /* ignore */ }
      await sandbox.cleanupSandbox(ctx);
      profile.dispose();
      await this.bestEffortUnlink(promptFile);
      return {
        success: false,
        error: `ResumeThread failed: ${String(err)}`,
        containerId: '',
      };
    }

    const containerId = `pi-appcontainer-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const slot: ProcessSlot = {
      job: ctx.job,
      processHandle: processHandles.processHandle,
      threadHandle: processHandles.threadHandle,
      cleanup: ctx.cleanup,
      promptFile,
      appContainerProfile: profile,
    };
    this.processRegistry.set(containerId, slot);

    // Drain stdout/stderr until EOF.
    const outChunks: Buffer[] = [];
    const errChunks: Buffer[] = [];
    const outTruncated = await drainPipeWithLimit(stdoutPipe.readHandle, outChunks, MAX_BUFFER_BYTES, containerId, 'stdout');
    const errTruncated = await drainPipeWithLimit(stderrPipe.readHandle, errChunks, MAX_BUFFER_BYTES, containerId, 'stderr');

    // Wait for the process to exit.
    let exitCode = 0;
    let timedOut = false;
    const timeoutMs = config.timeoutMs ?? 300_000;
    const waitResult = sandbox.waitForSingleObject(processHandles.processHandle, timeoutMs);
    if (waitResult === WAIT_TIMEOUT) {
      timedOut = true;
      // Closing the job object triggers KILL_ON_JOB_CLOSE.
      try { ctx.job.dispose(); } catch { /* ignore */ }
      sandbox.waitForSingleObject(processHandles.processHandle, 5_000);
    } else if (waitResult === 0) {
      const code = sandbox.getExitCodeProcess(processHandles.processHandle);
      if (code !== STILL_ACTIVE) exitCode = code;
    }

    try { sandbox.closePipe(processHandles.processHandle); } catch { /* ignore */ }
    try { sandbox.closePipe(processHandles.threadHandle); } catch { /* ignore */ }
    try { sandbox.closePipe(stdoutPipe.readHandle); } catch { /* ignore */ }
    try { sandbox.closePipe(stderrPipe.readHandle); } catch { /* ignore */ }

    await sandbox.cleanupSandbox(ctx);
    await this.bestEffortUnlink(promptFile);
    profile.dispose();
    this.processRegistry.delete(containerId);

    const stdout = Buffer.concat(outChunks).toString('utf-8');
    const stderr = Buffer.concat(errChunks).toString('utf-8');

    if (timedOut) {
      return {
        success: false,
        error: `sandboxed process timed out after ${timeoutMs}ms (KILL_ON_JOB_CLOSE fired)`,
        containerId,
        output: stdout.slice(0, 4000),
      };
    }
    if (outTruncated || errTruncated) {
      return {
        success: false,
        error: `sandboxed process produced more than ${MAX_BUFFER_BYTES} bytes — output truncated`,
        containerId,
        output: stdout.slice(0, 4000),
      };
    }
    if (exitCode !== 0 && !stdout.trim()) {
      return {
        success: false,
        error: `sandboxed process exited with code ${exitCode}: ${stderr.slice(0, 500) || '(no stderr)'}`,
        containerId,
        output: stderr.slice(0, 4000),
      };
    }

    const parsed = parsePiJsonLines(stdout);
    const files = await scanWorkspaceChanges(workDir);
    return {
      success: parsed.success || (stdout.trim().length > 0 && exitCode === 0),
      output: parsed.lastText || stdout.slice(-4000),
      error:
        parsed.error ??
        (exitCode !== 0 ? `sandboxed process exited with code ${exitCode}` : undefined),
      containerId,
      files: files.list,
      fileCount: files.count,
      totalSize: files.size,
      outputDir: workDir,
    };
  }

  async stop(containerId: string): Promise<void> {
    const slot = this.processRegistry.get(containerId);
    if (!slot) return;
    try {
      slot.job.dispose();
    } catch (err) {
      logger.warn(`PiAppContainerRunner.stop: job dispose failed: ${String(err)}`);
    }
    try {
      await slot.cleanup();
    } catch (err) {
      logger.warn(`PiAppContainerRunner.stop: cleanup failed: ${String(err)}`);
    }
    try {
      slot.appContainerProfile.dispose();
    } catch (err) {
      logger.warn(`PiAppContainerRunner.stop: profile dispose failed: ${String(err)}`);
    }
    this.processRegistry.delete(containerId);
  }

  async cleanup(): Promise<void> {
    for (const [containerId, slot] of this.processRegistry) {
      try {
        slot.job.dispose();
      } catch (err) {
        logger.warn({ containerId, err: String(err) }, 'terminateJobObject during cleanup failed');
      }
      try {
        await slot.cleanup();
      } catch (err) {
        logger.warn({ containerId, err: String(err) }, 'sandbox cleanup failed');
      }
      try {
        slot.appContainerProfile.dispose();
      } catch (err) {
        logger.warn(
          { containerId, profile: slot.appContainerProfile.name, err: String(err) },
          'AppContainer profile dispose failed',
        );
      }
      if (slot.promptFile) {
        await this.bestEffortUnlink(slot.promptFile);
      }
      this.processRegistry.delete(containerId);
    }
  }

  private async bestEffortUnlink(path: string): Promise<void> {
    try {
      await unlink(path);
    } catch {
      /* ignore — best effort */
    }
  }
}

function envToRecord(env: NodeJS.ProcessEnv): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(env)) {
    if (typeof v === 'string') out[k] = v;
  }
  return out;
}

function quoteForCmd(s: string): string {
  if (!/[\s"&|<>^()]/.test(s)) return s;
  return `"${s.replace(/"/g, '""')}"`;
}

async function drainPipeWithLimit(
  pipe: sandbox.Handle,
  chunks: Buffer[],
  limit: number,
  containerId: string,
  stream: 'stdout' | 'stderr',
): Promise<boolean> {
  let total = 0;
  let truncated = false;
  for (;;) {
    const r = sandbox.readPipe(pipe, PIPE_READ_CHUNK);
    if (r.bytesRead === 0) break;
    total += r.bytesRead;
    if (total > limit) {
      truncated = true;
      logger.warn(
        { containerId, stream, total },
        'drainPipe: buffer cap reached, truncating further output',
      );
      break;
    }
    chunks.push(r.data);
  }
  return truncated;
}