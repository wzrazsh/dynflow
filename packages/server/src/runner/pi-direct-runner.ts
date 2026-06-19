import { execFile, execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, writeFile, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import type { AgentRunConfig, AgentResult, AgentRunner } from './types.js';
import { parsePiJsonLines } from './pi-output-parser.js';
import { scanWorkspaceChanges } from './workspace-scanner.js';
import { buildPiPrompt } from './prompt-builder.js';

const execFileAsync = promisify(execFile);

/** Cap buffered stdout/stderr per stream to avoid unbounded memory growth. */
const MAX_BUFFER_BYTES = 32 * 1024 * 1024; // 32 MiB

/** Timeout for the binary probe in isAvailable(). */
const PROBE_TIMEOUT_MS = 3000;

export interface PiDirectRunnerOptions {
  /** Pi CLI binary (default: 'pi'). */
  binary?: string;
  /** Default provider (default: 'opencode'). */
  provider?: string;
  /** Default model pattern (default: 'mimo-v2.5-free'). */
  model?: string;
  /** Working directory where Pi will run. Defaults to a per-run temp dir. */
  workingDir?: string;
  /** Optional registry for tracking active child processes (for stop()). */
  processRegistry?: Map<string, ChildProcess>;
}

/**
 * PiDirectRunner — runs the local `pi` CLI (no Docker, no Cua sandbox).
 *
 * SECURITY NOTE: This runner executes `pi` directly on the host with the
 * current user's privileges. The Cua sandbox layer (Docker / trycua/cua-xfce)
 * is NOT applied. Workflow prompts are written to `.dynflow-prompt.md` inside
 * the workspace and a short instruction is passed via argv, never via a
 * shell interpreter. Workflows should be reviewed before enabling this
 * runner.
 *
 * This runner exists for environments where Docker is unavailable but the
 * `@earendil-works/pi-coding-agent` npm package is installed locally
 * (typically via `npm install -g @earendil-works/pi-coding-agent`). The agent
 * is the same `pi` binary the Cua+Pi image uses inside `trycua/cua-xfce` —
 * only the Cua sandbox layer is omitted.
 */
export class PiDirectRunner implements AgentRunner {
  private readonly binary: string;
  private readonly provider: string;
  private readonly model: string;
  private readonly defaultWorkingDir: string;
  private readonly processRegistry: Map<string, ChildProcess>;

  constructor(options: PiDirectRunnerOptions = {}) {
    this.binary = options.binary ?? process.env.DYNFLOW_PI_BINARY ?? 'pi';
    this.provider = options.provider ?? process.env.DYNFLOW_PI_PROVIDER ?? 'opencode';
    this.model = options.model ?? process.env.DYNFLOW_PI_MODEL ?? 'mimo-v2.5-free';
    this.defaultWorkingDir = options.workingDir ?? '';
    this.processRegistry = options.processRegistry ?? new Map();
  }

  /**
   * Probe for the `pi` binary on PATH using `execFile` (no shell), so this
   * is safe to call with any env-controlled binary path. Bounded by a
   * short timeout so a hanging executable cannot block startup.
   */
  static isAvailable(binaryOverride?: string): boolean {
    const bin = binaryOverride ?? process.env.DYNFLOW_PI_BINARY ?? 'pi';
    try {
      execFileSync(bin, ['--version'], { stdio: 'ignore', timeout: PROBE_TIMEOUT_MS });
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Build the child-process environment. We use a minimal allowlist so the
   * host-side coding agent does not inherit unrelated server secrets
   * (database credentials, CI tokens, cloud keys, etc.). The only things
   * forwarded are: PATH (so the global `pi` binary can be located on
   * systems where the user-specific npm prefix is not on the inherited
   * PATH), a small set of OS-required variables (HOME / USERPROFILE /
   * SYSTEMROOT / TEMP / LANG), and the API key the workflow control layer
   * explicitly passed in via `config.apiKey`.
   *
   * The key is set only on the env var that matches the configured provider
   * (e.g., `OPENAI_API_KEY` for provider=openai, `ANTHROPIC_API_KEY` for
   * provider=anthropic, `OPENCODE_API_KEY` for provider=opencode) so that a
   * single OpenCode key is never sent to the Anthropic or OpenAI provider
   * with mismatched semantics.
   */
  private buildChildEnv(config: AgentRunConfig): NodeJS.ProcessEnv {
    const env: NodeJS.ProcessEnv = {};
    if (process.env.PATH) env.PATH = process.env.PATH;
    if (process.env.HOME) env.HOME = process.env.HOME;
    if (process.env.USERPROFILE) env.USERPROFILE = process.env.USERPROFILE;
    if (process.env.SYSTEMROOT) env.SYSTEMROOT = process.env.SYSTEMROOT;
    if (process.env.TEMP) env.TEMP = process.env.TEMP;
    if (process.env.LANG) env.LANG = process.env.LANG;
    // OpenAI-compatible providers (openai, minimax, azure-openai-responses)
    // honor an alternate `OPENAI_BASE_URL`; pass it through so a configured
    // proxy / private endpoint reaches the child `pi` process.
    if (process.env.OPENAI_BASE_URL) env.OPENAI_BASE_URL = process.env.OPENAI_BASE_URL;
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
        default:
          // Unknown provider: be conservative and set none of the provider
          // env vars. The runner will fail with a clear "no API key" error
          // from `pi` rather than silently using the wrong credentials.
          break;
      }
    }
    return env;
  }

  async run(config: AgentRunConfig): Promise<AgentResult> {
    if (!PiDirectRunner.isAvailable(this.binary)) {
      return {
        success: false,
        error: `Pi CLI ('${this.binary}') is not available on PATH. Install with: npm install -g @earendil-works/pi-coding-agent`,
        containerId: '',
      };
    }

    // Determine working directory.
    const workDir = config.workspacePath || this.defaultWorkingDir;
    if (!workDir) {
      return {
        success: false,
        error: 'workspacePath is required for PiDirectRunner (no default workingDir configured)',
        containerId: '',
      };
    }
    await mkdir(workDir, { recursive: true });

    // Build the prompt and write it to a per-agent file inside the
    // workspace. Each agent in a parallel phase gets a unique prompt file
    // so that one agent cannot overwrite another's prompt before `pi`
    // reads it.
    const promptText = buildPiPrompt({
      userPrompt: config.prompt,
      workspaceMount: workDir,
    });
    const safeAgentId = config.agentId.replace(/[^a-zA-Z0-9_-]/g, '_');
    const promptFile = join(workDir, `.dynflow-prompt-${safeAgentId}-${Date.now()}.md`);
    await writeFile(promptFile, promptText, 'utf-8');

    // Resolve provider/model: prefer agent config, fall back to defaults.
    const model = config.model ?? this.model;
    const provider = config.llmProvider ?? this.provider;

    // We pass a SHORT instruction that tells `pi` to read the prompt from
    // the file we just wrote. This keeps argv length bounded regardless of
    // user-prompt size, and avoids Windows command-line length limits.
    const shortInstruction = `Read the instructions in ${promptFile} and execute them.`;

    const args = [
      '--print',
      '--no-session',
      '--mode', 'json',
      '--provider', provider,
      '--model', model,
      '--append-system-prompt',
      `你的工作目录是 ${workDir}。请只在该目录内修改文件,不要访问其他路径。`,
      '--',
      shortInstruction,
    ];

    const containerId = `pi-direct-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    let stdout = '';
    let stderr = '';
    let exitCode = 0;
    let signal: NodeJS.Signals | null = null;
    let timedOut = false;
    let spawnError: Error | null = null;

    let child: ChildProcess;
    try {
      child = spawn(this.binary, args, {
        cwd: workDir,
        env: this.buildChildEnv(config),
        stdio: ['ignore', 'pipe', 'pipe'],
        // CRITICAL: shell: false. The short instruction cannot influence a
        // shell even if it contains metacharacters, and the full user prompt
        // is delivered via the .dynflow-prompt.md file (not argv).
        shell: false,
        windowsHide: true,
        // On POSIX, spawn the child in its own process group so the
        // process-group kill in `killProcessTree` (process.kill(-pid, ...))
        // actually reaches descendants. On Windows, taskkill /T handles
        // tree-kill independently of process groups.
        detached: process.platform !== 'win32',
      });
    } catch (err) {
      return {
        success: false,
        error: `Failed to spawn pi: ${String(err)}`,
        containerId,
      };
    }

    // Register the child so stop() can terminate it.
    this.processRegistry.set(containerId, child);
    const abortFromCaller = () => {
      void killProcessTree(child);
    };
    config.signal?.addEventListener('abort', abortFromCaller, { once: true });

    // Buffer stdout/stderr with a hard cap. Once either stream exceeds the
    // cap, kill the child — a single `>` check + a `truncated` flag handles
    // any chunk size without missing the boundary. Both cap and timeout
    // routes go through killProcessTree so the entire subprocess tree is
    // terminated, not just the immediate `pi` process.
    let outBytes = 0;
    let errBytes = 0;
    let outTruncated = false;
    let errTruncated = false;
    const outChunks: Buffer[] = [];
    const errChunks: Buffer[] = [];
    child.stdout?.on('data', (b: Buffer) => {
      outBytes += b.length;
      if (!outTruncated) {
        if (outBytes > MAX_BUFFER_BYTES) {
          outTruncated = true;
          void killProcessTree(child);
        } else {
          outChunks.push(b);
        }
      }
    });
    child.stderr?.on('data', (b: Buffer) => {
      errBytes += b.length;
      if (!errTruncated) {
        if (errBytes > MAX_BUFFER_BYTES) {
          errTruncated = true;
          void killProcessTree(child);
        } else {
          errChunks.push(b);
        }
      }
    });

    // Handle spawn errors asynchronously (these don't reach the synchronous
    // try/catch above).
    child.on('error', (err) => {
      spawnError = err;
    });

    // Race the child against a timeout. Use killProcessTree so subprocesses
    // (which may be doing host-privileged work) are also terminated.
    const timeoutMs = config.timeoutMs ?? 300_000;
    const timeoutHandle = setTimeout(() => {
      timedOut = true;
      void killProcessTree(child);
    }, timeoutMs);

    // Wait for close (NOT exit) — `close` fires only after stdio streams are
    // fully drained. `exit` can fire before all stdout is delivered, which
    // would cause parsePiJsonLines to miss the trailing `agent_end` event.
    // We still listen to `exit` to capture the exit code, but we resolve the
    // wait on `close` (or `error`).
    await new Promise<void>((resolve) => {
      let settled = false;
      const done = () => {
        if (settled) return;
        settled = true;
        resolve();
      };
      child.on('exit', (code, sig) => {
        // Record exit code, but DO NOT resolve — wait for `close` so the
        // stdout buffer is fully drained.
        if (code !== null) exitCode = code;
        if (sig) signal = sig;
      });
      child.on('close', (code, sig) => {
        if (code !== null && exitCode === 0) exitCode = code;
        if (sig) signal = sig;
        done();
      });
      child.on('error', () => done());
    });
    clearTimeout(timeoutHandle);
    config.signal?.removeEventListener('abort', abortFromCaller);
    this.processRegistry.delete(containerId);

    // Best-effort cleanup: delete the per-agent prompt file we wrote so it
    // does not linger on the host filesystem with the user prompt content.
    // (The legacy single-file path used by Cua is not touched here.)
    try {
      await unlink(promptFile);
    } catch {
      /* ignore — file may already be gone */
    }

    stdout = Buffer.concat(outChunks).toString('utf-8');
    stderr = Buffer.concat(errChunks).toString('utf-8');

    if (spawnError) {
      return {
        success: false,
        error: `Failed to spawn pi: ${String(spawnError)}`,
        containerId,
      };
    }

    if (timedOut) {
      return {
        success: false,
        error: `pi timed out after ${timeoutMs}ms (signal=${signal ?? 'SIGKILL'})`,
        containerId,
        output: stdout.slice(0, 4000),
      };
    }

    if (exitCode !== 0 && !stdout.trim()) {
      return {
        success: false,
        error: `pi exited with code ${exitCode} (signal=${signal ?? 'none'}): ${stderr.slice(0, 500) || '(no stderr)'}`,
        containerId,
        output: stderr.slice(0, 4000),
      };
    }

    const parsed = parsePiJsonLines(stdout);
    const files = await scanWorkspaceChanges(workDir);

    // If the runner truncated stdout or stderr because the child exceeded
    // the buffer cap, that is a hard failure. The trailing JSONL events
    // may be missing, so any "success" from parsePiJsonLines is unreliable.
    if (outTruncated || errTruncated) {
      return {
        success: false,
        error: `pi produced more than ${MAX_BUFFER_BYTES} bytes on ${
          outTruncated ? 'stdout' : 'stderr'
        } — output truncated`,
        containerId,
        output: stdout.slice(0, 4000),
        files: files.list,
        fileCount: files.count,
        totalSize: files.size,
        outputDir: workDir,
      };
    }

    return {
      success: parsed.success,
      output: parsed.lastText,
      error: parsed.error ?? (exitCode !== 0 ? `pi exited with code ${exitCode} (signal=${signal ?? 'none'})` : undefined),
      containerId,
      files: files.list,
      fileCount: files.count,
      totalSize: files.size,
      outputDir: workDir,
    };
  }

  async stop(containerId: string): Promise<void> {
    // For host-privileged runs, stop() MUST actually terminate the child
    // AND any subprocess tree it spawned (e.g., `pi` running inside the
    // child may have spawned shell tools, editors, etc.). On Windows we
    // use `taskkill /F /T` to kill the process tree; on POSIX we send
    // SIGKILL to the entire process group.
    const child = this.processRegistry.get(containerId);
    if (child && child.exitCode === null) {
      await killProcessTree(child);
    }
    this.processRegistry.delete(containerId);
  }

  async cleanup(): Promise<void> {
    // Terminate any leaked children.
    for (const [id, child] of this.processRegistry.entries()) {
      if (child.exitCode === null) {
        await killProcessTree(child);
      }
      this.processRegistry.delete(id);
    }
  }
}

/**
 * Internal: confirm that `execFile` can resolve the configured `pi` binary
 * without a shell. Exposed for tests.
 */
export async function _probePiBinaryForTest(binary: string): Promise<boolean> {
  try {
    await execFileAsync(binary, ['--version'], { timeout: PROBE_TIMEOUT_MS });
    return true;
  } catch {
    return false;
  }
}

/**
 * Kill a child process AND its entire process tree. On Windows we use
 * `taskkill /F /T /PID <pid>` which kills children recursively. On POSIX
 * we send SIGKILL to the negative-PID process group so that any
 * subprocesses spawned by `pi` are also terminated.
 *
 * This is critical for `pi-direct` because the runner executes on the
 * host without a container boundary. A bare `child.kill('SIGKILL')` only
 * kills the immediate `pi` process — any subprocesses it spawned (shell
 * tools, editors, etc.) would survive and continue modifying the host
 * filesystem. Exposed for tests.
 */
export async function killProcessTree(child: ChildProcess): Promise<void> {
  const pid = child.pid;
  if (pid === undefined || pid === null) {
    // No PID — best we can do is a regular kill.
    try { child.kill('SIGKILL'); } catch { /* ignore */ }
    return;
  }
  if (process.platform === 'win32') {
    try {
      // /T = terminate process tree, /F = force
      await execFileAsync('taskkill', ['/F', '/T', '/PID', String(pid)]);
    } catch {
      // Fall back to plain kill if taskkill is unavailable.
      try { child.kill('SIGKILL'); } catch { /* ignore */ }
    }
  } else {
    try {
      // Negate the PID to signal the entire process group.
      process.kill(-pid, 'SIGKILL');
    } catch {
      try { child.kill('SIGKILL'); } catch { /* ignore */ }
    }
  }
}
