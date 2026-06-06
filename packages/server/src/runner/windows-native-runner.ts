import { existsSync } from 'node:fs';
import { mkdir, writeFile, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import type { AgentRunConfig, AgentResult, AgentRunner } from './types.js';
import { parsePiJsonLines } from './pi-output-parser.js';
import { scanWorkspaceChanges } from './workspace-scanner.js';
import { buildPiPrompt } from './prompt-builder.js';
import { resolvePiBinary } from './pi-binary.js';
import * as sandbox from './sandbox/index.js';
import { logger } from '../logger.js';

/** Cap buffered stdout/stderr per stream to avoid unbounded memory growth. */
const MAX_BUFFER_BYTES = 64 * 1024 * 1024; // 64 MiB

/** Default memory limit per sandboxed process, in bytes. Matches CuaAgentRunner. */
const DEFAULT_MEMORY_LIMIT_BYTES = 2 * 1024 * 1024 * 1024; // 2 GiB

/** Pipe read buffer size when draining stdout/stderr. */
const PIPE_READ_CHUNK = 64 * 1024;

/** Still-Active exit code from GetExitCodeProcess. */
const STILL_ACTIVE = 259;

/** Env vars that the runner will pass to the child. Any other
 *  server-side env var (e.g. AWS_*, GITHUB_TOKEN, DOCKER_*) is filtered
 *  out — this is the strict whitelist pattern from CuaPiRunner, but
 *  with extra entries removed because the sandboxed process must not
 *  have access to the server's secrets. */
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
  // DYNFLOW_*: opt-in runner-specific configuration.
  'DYNFLOW_CUA_SERVER_URL',
  'DYNFLOW_PI_PROVIDER',
  'DYNFLOW_PI_MODEL',
  'DYNFLOW_PI_BINARY',
]);

/**
 * The handle/registry for a sandboxed process run. Stored per
 * `containerId` so `stop()` can quickly look it up.
 */
interface ProcessSlot {
  /** The job object — closing it triggers KILL_ON_JOB_CLOSE. */
  readonly job: sandbox.JobObject;
  /** The process handle (closed after wait). */
  readonly processHandle: sandbox.Handle;
  /** The thread handle from CreateProcessAsUserW (closed after wait). */
  readonly threadHandle: sandbox.Handle;
  /** Sandbox cleanup callback. */
  readonly cleanup: () => Promise<void>;
  /** The prompt file we wrote to disk (so we can delete it on exit). */
  readonly promptFile: string | null;
}

export interface WindowsNativeRunnerOptions {
  /** Pi CLI binary (default: 'pi'). */
  binary?: string;
  /** Default provider (default: 'opencode'). */
  provider?: string;
  /** Default model pattern (default: 'mimo-v2.5-free'). */
  model?: string;
  /** Memory limit per process in bytes (default: 2 GiB). */
  memoryLimitBytes?: number;
  /** Per-runner process registry, exposed for tests + stop() calls. */
  processRegistry?: Map<string, ProcessSlot>;
}

/**
 * WindowsNativeRunner — runs Pi inside a Win32 sandbox (Restricted Token
 * + Job Object) using the local Koffi FFI bridge.
 *
 * Auto-selected on Windows hosts when neither Cua nor CuaPi is
 * available (no Docker, no Cua Computer Server). Opt-in via
 * `DYNFLOW_RUNNER=windows-native` or the runtime config.
 *
 * Two modes:
 *  - light (default): WRITE_RESTRICTED token + KILL_ON_JOB_CLOSE job
 *    with a 2 GiB memory cap. No admin required.
 *  - strict (DYNFLOW_WIN_SANDBOX_STRICT=1): DISABLE_MAX_PRIVILEGE |
 *    SANDBOX_INERT | WRITE_RESTRICTED + DACL on the workspace. Admin
 *    required for DACL manipulation.
 */
export class WindowsNativeRunner implements AgentRunner {
  private readonly binary: string;
  private readonly provider: string;
  private readonly model: string;
  private readonly memoryLimitBytes: number;
  private readonly processRegistry: Map<string, ProcessSlot>;

  constructor(options: WindowsNativeRunnerOptions = {}) {
    this.binary = options.binary ?? process.env.DYNFLOW_PI_BINARY ?? 'pi';
    this.provider = options.provider ?? process.env.DYNFLOW_PI_PROVIDER ?? 'opencode';
    this.model = options.model ?? process.env.DYNFLOW_PI_MODEL ?? 'mimo-v2.5-free';
    this.memoryLimitBytes = options.memoryLimitBytes ?? DEFAULT_MEMORY_LIMIT_BYTES;
    this.processRegistry = options.processRegistry ?? new Map();
  }

  /**
   * `true` iff this runner can be used on this host (Windows + Koffi
   * loadable). Used by `createAgentRunner` to decide whether to add
   * this runner to the auto-select chain.
   */
  static isAvailable(): boolean {
    return sandbox.isSupported();
  }

  /**
   * Strict-mode switch. Reads DYNFLOW_WIN_SANDBOX_STRICT at call time
   * so a runtime config flip is reflected on the next run without
   * re-instantiating the runner.
   */
  private isStrictMode(): boolean {
    return process.env.DYNFLOW_WIN_SANDBOX_STRICT === '1';
  }

  /**
   * Build the child-process environment. Same allowlist as
   * CuaPiRunner, with the same per-provider API-key mapping. We do NOT
   * forward DOCKER_* or other server-side secrets.
   */
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
    return env;
  }

  /**
   * Build the prompt for the sandboxed child. Mirrors CuaPiRunner's
   * `buildCuaPrompt` minus the Cua-specific section (this runner does
   * not drive a Cua Computer Server).
   */
  private buildPrompt(userPrompt: string, workDir: string): string {
    return buildPiPrompt({ userPrompt, workspaceMount: workDir });
  }

  async run(config: AgentRunConfig): Promise<AgentResult> {
    if (!WindowsNativeRunner.isAvailable()) {
      return {
        success: false,
        error: 'Windows native sandbox is not supported on this host (non-Windows or Koffi unavailable).',
        containerId: '',
      };
    }

    const workDir = config.workspacePath;
    if (!workDir) {
      return {
        success: false,
        error: 'workspacePath is required for WindowsNativeRunner',
        containerId: '',
      };
    }
    await mkdir(workDir, { recursive: true });

    // Resolve the Pi binary. On Windows this returns a (node, cli.js)
    // pair when the user-supplied bin is a .cmd shim, so the
    // CreateProcessAsUserW call below can use `executable = process.execPath`
    // and `args = [cliPath, ...userArgs]`. We honor the same convention
    // on POSIX: pass `bin` through as the executable.
    const resolved = resolvePiBinary(this.binary, process.platform);
    if (!existsSync(resolved.executable)) {
      return {
        success: false,
        error: `Pi CLI ('${this.binary}') is not available. Resolved to '${resolved.executable}' which does not exist.`,
        containerId: '',
      };
    }

    // Build and write the prompt file. We delete it again at the end
    // (and on any error path).
    const promptText = this.buildPrompt(config.prompt, workDir);
    const safeAgentId = config.agentId.replace(/[^a-zA-Z0-9_-]/g, '_');
    const promptFile = join(workDir, `.dynflow-prompt-${safeAgentId}-${Date.now()}.md`);
    try {
      await writeFile(promptFile, promptText, 'utf-8');
    } catch (err) {
      return {
        success: false,
        error: `Failed to write prompt file: ${String(err)}`,
        containerId: '',
      };
    }

    const shortInstruction = `Read the instructions in ${promptFile} and execute them.`;

    // Build the args list. The runner is binary-agnostic — it never
    // hard-codes the `pi` CLI's argv; it just invokes the resolved
    // executable with the caller's args.
    const piArgs = [shortInstruction];

    // Create the sandbox (token + job + DACL).
    let ctx: sandbox.SandboxContext;
    try {
      ctx = sandbox.createSandbox({
        mode: this.isStrictMode() ? 'strict' : 'light',
        memoryLimitBytes: this.memoryLimitBytes,
        workspacePath: workDir,
        enableUiRestrictions: false,
        environment: envToRecord(this.buildChildEnv(config)),
      });
    } catch (err) {
      await this.bestEffortUnlink(promptFile);
      return {
        success: false,
        error: `Failed to create sandbox: ${String(err)}`,
        containerId: '',
      };
    }

    // Create pipes for stdout/stderr capture.
    let stdoutPipe: sandbox.PipePair | null = null;
    let stderrPipe: sandbox.PipePair | null = null;
    try {
      stdoutPipe = sandbox.createPipe(false, true);
      stderrPipe = sandbox.createPipe(false, true);
    } catch (err) {
      await sandbox.cleanupSandbox(ctx);
      await this.bestEffortUnlink(promptFile);
      return {
        success: false,
        error: `Failed to create stdout/stderr pipes: ${String(err)}`,
        containerId: '',
      };
    }

    // CreateProcessAsUserW — the new process is suspended.
    let processHandles: sandbox.ProcessHandles;
    try {
      processHandles = sandbox.createProcessAsUser(
        ctx.token,
        // Application name: node (process.execPath) on Windows when the
        // shim was resolved; the original binary elsewhere.
        process.platform === 'win32' && resolved.args.length > 0 ? resolved.executable : null,
        // Command line: `node cli.js ...args` on Windows shim, else `bin ...args`.
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
      // Best-effort pipe close. process.ts's createPipe is non-inheritable
      // for the read end; we close the write ends here because the
      // child never started.
      try { sandbox.closePipe(stdoutPipe.writeHandle); } catch { /* ignore */ }
      try { sandbox.closePipe(stderrPipe.writeHandle); } catch { /* ignore */ }
      await sandbox.cleanupSandbox(ctx);
      await this.bestEffortUnlink(promptFile);
      return {
        success: false,
        error: `CreateProcessAsUserW failed: ${String(err)}`,
        containerId: '',
      };
    }

    // Close the parent's copy of the write ends — the child now owns
    // them. The read ends stay open in the parent so we can drain.
    try { sandbox.closePipe(stdoutPipe.writeHandle); } catch { /* ignore */ }
    try { sandbox.closePipe(stderrPipe.writeHandle); } catch { /* ignore */ }

    // Assign the process to the job BEFORE resuming. This is the
    // race-free pattern from the design doc.
    try {
      ctx.job.assignProcess(processHandles.processHandle);
    } catch (err) {
      try { sandbox.terminateProcess(processHandles.processHandle, 1); } catch { /* ignore */ }
      try { sandbox.closePipe(processHandles.processHandle); } catch { /* ignore */ }
      try { sandbox.closePipe(processHandles.threadHandle); } catch { /* ignore */ }
      try { sandbox.closePipe(stdoutPipe.readHandle); } catch { /* ignore */ }
      try { sandbox.closePipe(stderrPipe.readHandle); } catch { /* ignore */ }
      await sandbox.cleanupSandbox(ctx);
      await this.bestEffortUnlink(promptFile);
      return {
        success: false,
        error: `AssignProcessToJobObject failed: ${String(err)}`,
        containerId: '',
      };
    }

    // Resume the main thread.
    try {
      sandbox.resumeThread(processHandles.threadHandle);
    } catch (err) {
      try { sandbox.terminateProcess(processHandles.processHandle, 1); } catch { /* ignore */ }
      try { sandbox.closePipe(processHandles.processHandle); } catch { /* ignore */ }
      try { sandbox.closePipe(processHandles.threadHandle); } catch { /* ignore */ }
      try { sandbox.closePipe(stdoutPipe.readHandle); } catch { /* ignore */ }
      try { sandbox.closePipe(stderrPipe.readHandle); } catch { /* ignore */ }
      await sandbox.cleanupSandbox(ctx);
      await this.bestEffortUnlink(promptFile);
      return {
        success: false,
        error: `ResumeThread failed: ${String(err)}`,
        containerId: '',
      };
    }

    const containerId = `wnr-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const slot: ProcessSlot = {
      job: ctx.job,
      processHandle: processHandles.processHandle,
      threadHandle: processHandles.threadHandle,
      cleanup: ctx.cleanup,
      promptFile,
    };
    this.processRegistry.set(containerId, slot);

    // Drain stdout/stderr in a loop until both pipes hit EOF.
    const outChunks: Buffer[] = [];
    const errChunks: Buffer[] = [];
    const outTruncated = await this.drainPipeWithLimit(stdoutPipe.readHandle, outChunks, MAX_BUFFER_BYTES);
    const errTruncated = await this.drainPipeWithLimit(stderrPipe.readHandle, errChunks, MAX_BUFFER_BYTES);

    // Wait for the process to exit.
    let exitCode = 0;
    let timedOut = false;
    const timeoutMs = config.timeoutMs ?? 300_000;
    const waitResult = sandbox.waitForSingleObject(processHandles.processHandle, timeoutMs);
    if (waitResult === 0x102 /* WAIT_TIMEOUT */) {
      timedOut = true;
      // Closing the job object triggers KILL_ON_JOB_CLOSE.
      try { ctx.job.dispose(); } catch { /* ignore */ }
      // Best-effort: wait a bit more for the process to actually die.
      sandbox.waitForSingleObject(processHandles.processHandle, 5_000);
    } else if (waitResult === 0) {
      // Process signaled/exited normally.
      const code = sandbox.getExitCodeProcess(processHandles.processHandle);
      if (code !== STILL_ACTIVE) exitCode = code;
    }

    // Best-effort: close the process/thread handles. We intentionally
    // do this BEFORE running the sandbox cleanup so the token is
    // still valid (token is the one we use to query exit codes).
    try { sandbox.closePipe(processHandles.processHandle); } catch { /* ignore */ }
    try { sandbox.closePipe(processHandles.threadHandle); } catch { /* ignore */ }
    try { sandbox.closePipe(stdoutPipe.readHandle); } catch { /* ignore */ }
    try { sandbox.closePipe(stderrPipe.readHandle); } catch { /* ignore */ }

    // Cleanup the sandbox (job + DACL + token).
    await sandbox.cleanupSandbox(ctx);
    // Best-effort: delete the prompt file. The workspace scanner
    // already filters `.dynflow-prompt-*.md` from the user's artifact
    // list, so a leftover is not a user-visible bug, but we still
    // want to clean it up.
    await this.bestEffortUnlink(promptFile);
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

    // If we have a pi-output-parser, use it. Otherwise (the runner is
    // binary-agnostic) we just report stdout as the output.
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

  /**
   * Stop a sandboxed process. We rely on KILL_ON_JOB_CLOSE: closing
   * the job handle triggers termination of every process assigned to
   * it. Cleanup is delegated to the slot's cleanup callback.
   */
  async stop(containerId: string): Promise<void> {
    const slot = this.processRegistry.get(containerId);
    if (!slot) return;
    try {
      // Closing the job triggers KILL_ON_JOB_CLOSE for all assigned
      // processes.
      slot.job.dispose();
    } catch (err) {
      logger.warn(`WindowsNativeRunner.stop: job dispose failed: ${String(err)}`);
    }
    try {
      await slot.cleanup();
    } catch (err) {
      logger.warn(`WindowsNativeRunner.stop: cleanup failed: ${String(err)}`);
    }
    this.processRegistry.delete(containerId);
  }

  /**
   * Clean up every slot we still own. Idempotent and never throws.
   */
  async cleanup(): Promise<void> {
    for (const [id, slot] of this.processRegistry.entries()) {
      try {
        slot.job.dispose();
      } catch (err) {
        logger.warn(`WindowsNativeRunner.cleanup: job dispose failed (${id}): ${String(err)}`);
      }
      try {
        await slot.cleanup();
      } catch (err) {
        logger.warn(`WindowsNativeRunner.cleanup: sandbox cleanup failed (${id}): ${String(err)}`);
      }
      if (slot.promptFile) {
        await this.bestEffortUnlink(slot.promptFile);
      }
      this.processRegistry.delete(id);
    }
  }

  /**
   * Drain a pipe into chunks until EOF. Returns true if the buffer
   * limit was hit (truncation flag).
   */
  private async drainPipeWithLimit(
    pipe: sandbox.Handle,
    chunks: Buffer[],
    limit: number,
  ): Promise<boolean> {
    let total = 0;
    let truncated = false;
    for (;;) {
      const r = sandbox.readPipe(pipe, PIPE_READ_CHUNK);
      if (r.bytesRead === 0) break;
      total += r.bytesRead;
      if (total > limit) {
        truncated = true;
        break;
      }
      chunks.push(r.data);
    }
    return truncated;
  }

  private async bestEffortUnlink(path: string): Promise<void> {
    try {
      await unlink(path);
    } catch {
      /* ignore — best effort */
    }
  }
}

/**
 * Convert a `NodeJS.ProcessEnv` (which has `string | undefined`
 * values) to the strict `Record<string, string>` shape the sandbox
 * API requires. Undefined values are dropped — they would crash
 * `buildEnvironmentBlock` which writes UTF-16LE pairs.
 */
function envToRecord(env: NodeJS.ProcessEnv): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(env)) {
    if (v !== undefined) out[k] = v;
  }
  return out;
}

/**
 * Quote a single argument for the Win32 command line. Win32's
 * CommandLineToArgvW rules: a backslash is literal unless it
 * precedes a quote; runs of backslashes followed by a quote double
 * in length; surrounding quotes are added when the arg contains
 * whitespace or quotes. We always quote so the child sees the
 * literal string.
 */
function quoteForCmd(arg: string): string {
  if (arg === '') return '""';
  if (!/[\s"&|<>^()]/.test(arg)) return arg;
  let backslashes = 0;
  let out = '';
  for (const ch of arg) {
    if (ch === '\\') {
      backslashes++;
      out += '\\';
    } else if (ch === '"') {
      out += '\\'.repeat(backslashes * 2 + 1) + '"';
      backslashes = 0;
    } else {
      backslashes = 0;
      out += ch;
    }
  }
  return `"${out}"`;
}
