import { execFile, execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, writeFile, unlink } from 'node:fs/promises';
import { statSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import type { AgentRunConfig, AgentResult, AgentRunner } from './types.js';
import { parsePiJsonLines } from './pi-output-parser.js';
import { scanWorkspaceChanges } from './workspace-scanner.js';
import { buildPiPrompt } from './prompt-builder.js';
import { killProcessTree } from './pi-direct-runner.js';

const execFileAsync = promisify(execFile);

/** Cap buffered stdout/stderr per stream to avoid unbounded memory growth.
 *  Pi in --mode json emits a JSONL event per line and a typical
 *  multi-step task (read + write + bash verification) can produce tens
 *  of MB of events, so we use a generous 64 MiB cap.
 */
const MAX_BUFFER_BYTES = 64 * 1024 * 1024; // 64 MiB

/** Timeout for the binary probe in isAvailable(). */
const PROBE_TIMEOUT_MS = 3000;

/**
 * Resolve a Pi binary path to a (cmd, args) pair that can be execFile'd
 * without a shell. On Windows, npm-installed Pi is a `.cmd` shim that
 * requires `cmd.exe` to interpret — which we cannot use safely. Resolve
 * to the underlying `node dist/cli.js` invocation instead.
 */
function resolvePiBinary(bin: string): { cmd: string; args: string[] } {
  if (process.platform !== 'win32') return { cmd: bin, args: [] };

  // Find the actual shim path. If `bin` is unqualified (just 'pi'),
  // search PATH for the .cmd shim.
  let shimPath = bin;
  if (!/[\\/]/.test(bin)) {
    const pathSep = process.platform === 'win32' ? ';' : ':';
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
  if (!/\.(cmd|bat|ps1)$/i.test(shimPath)) return { cmd: shimPath, args: [] };

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
      return { cmd: process.execPath, args: [cliPath] };
    }
  }
  // Fallback: still try the shim (may work via shell).
  return { cmd: shimPath, args: [] };
}

/** Default Cua Computer Server URL. Override via env DYNFLOW_CUA_SERVER_URL. */
const DEFAULT_CUA_SERVER_URL = 'http://127.0.0.1:8000';

export interface CuaPiRunnerOptions {
  /** Pi CLI binary (default: 'pi'). */
  binary?: string;
  /** Default provider (default: 'opencode'). */
  provider?: string;
  /** Default model pattern (default: 'mimo-v2.5-free'). */
  model?: string;
  /** Cua Computer Server base URL (default: 'http://127.0.0.1:8000'). */
  cuaServerUrl?: string;
  /** Auto-start the Cua Computer Server if it is not already running. */
  autoStartServer?: boolean;
  /** Python executable to use when auto-starting the server. */
  pythonExe?: string;
  /** Optional registry for tracking active child processes (for stop()). */
  processRegistry?: Map<string, ChildProcess>;
}

/**
 * CuaPiRunner — runs Pi inside a Cua Computer Server sandbox.
 *
 * Architecture:
 *
 *   ┌─────────────────────────┐       ┌────────────────────────────┐
 *   │  Pi (CLI, host process) │       │  Cua Computer Server      │
 *   │  @earendil-works/...    │       │  (Python FastAPI on :8000) │
 *   │                         │       │                            │
 *   │  Tools: read/write/edit │       │  Tools exposed via WS/HTTP:│
 *   │         bash            │       │  - screenshot              │
 *   │                         │  HTTP │  - left_click / type_text  │
 *   │      curl/bash ─────────┼──────►│  - get_accessibility_tree  │
 *   │      ↓                  │       │  - run_command (shell)     │
 *   │      writes game files  │       │  - file operations         │
 *   │      to workspace       │       │                            │
 *   └─────────────────────────┘       └────────────────────────────┘
 *
 * Pi is the same `pi` binary that ships in the official `trycua/cua-xfce`
 * Docker image. The Cua "container" is the Cua Computer Server running on
 * the host (Python, no Docker required). Pi interacts with Cua over HTTP
 * via the bash tool, so it can take screenshots, click, type, and execute
 * shell commands inside the Cua sandbox.
 *
 * This is the most authentic interpretation of "use Pi inside Cua" on a
 * Docker-less host:
 *   - The "Cua" layer is the Cua Computer Server (Python HTTP service).
 *   - The "Pi" layer is the @earendil-works/pi-coding-agent CLI.
 *   - The two talk over HTTP, with Pi acting as the agent that drives Cua.
 */
export class CuaPiRunner implements AgentRunner {
  private readonly binary: string;
  private readonly provider: string;
  private readonly model: string;
  private readonly cuaServerUrl: string;
  private readonly autoStartServer: boolean;
  private readonly pythonExe: string;
  private readonly processRegistry: Map<string, ChildProcess>;
  private startedServer: { stop: () => void } | null = null;

  constructor(options: CuaPiRunnerOptions = {}) {
    this.binary = options.binary ?? process.env.DYNFLOW_PI_BINARY ?? 'pi';
    this.provider = options.provider ?? process.env.DYNFLOW_PI_PROVIDER ?? 'opencode';
    this.model = options.model ?? process.env.DYNFLOW_PI_MODEL ?? 'mimo-v2.5-free';
    this.cuaServerUrl = options.cuaServerUrl ?? process.env.DYNFLOW_CUA_SERVER_URL ?? DEFAULT_CUA_SERVER_URL;
    this.autoStartServer = options.autoStartServer ?? process.env.DYNFLOW_CUA_AUTOSTART !== 'false';
    this.pythonExe = options.pythonExe ?? process.env.DYNFLOW_PYTHON ?? 'python';
    this.processRegistry = options.processRegistry ?? new Map();
  }

  /**
   * Probe for the `pi` binary. We do NOT exec the binary because
   * `pi --version` triggers an interactive TUI on some versions and hangs
   * the probe. Instead, we resolve the binary to its underlying `node`
   * invocation (or skip resolution on POSIX) and confirm that the
   * resolved file actually exists and is executable.
   *
   * This is a shallower probe than running the binary, but it is the
   * only reliable cross-platform check that does not risk hanging the
   * server.
   */
  static isAvailable(binaryOverride?: string): boolean {
    const bin = binaryOverride ?? process.env.DYNFLOW_PI_BINARY ?? 'pi';
    const resolved = resolvePiBinary(bin);

    // On POSIX, resolvePiBinary returns the binary name as-is without
    // searching PATH. Search PATH here so that a bare binary name like
    // 'pi' is resolved against PATH directories rather than only CWD.
    if (process.platform !== 'win32' && !/[\\/]/.test(resolved.cmd)) {
      const dirs = (process.env.PATH ?? '').split(':').filter(Boolean);
      for (const dir of dirs) {
        const candidate = join(dir, resolved.cmd);
        if (existsSync(candidate)) {
          return true;
        }
      }
    }

    return existsSync(resolved.cmd);
  }

  /**
   * Check whether the Cua Computer Server is reachable at the configured URL.
   * Uses a 3-second timeout so a slow / hung server does not block startup.
   */
  static async isServerReachable(url: string): Promise<boolean> {
    try {
      const res = await fetch(`${url}/status`, {
        signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
      });
      return res.ok;
    } catch {
      return false;
    }
  }

  /**
   * Build the child-process environment. We use a minimal allowlist so the
   * host-side coding agent does not inherit unrelated server secrets. The
   * key is set only on the env var that matches the configured provider.
   */
  private buildChildEnv(config: AgentRunConfig): NodeJS.ProcessEnv {
    const env: NodeJS.ProcessEnv = {};
    if (process.env.PATH) env.PATH = process.env.PATH;
    if (process.env.HOME) env.HOME = process.env.HOME;
    if (process.env.USERPROFILE) env.USERPROFILE = process.env.USERPROFILE;
    if (process.env.SYSTEMROOT) env.SYSTEMROOT = process.env.SYSTEMROOT;
    if (process.env.TEMP) env.TEMP = process.env.TEMP;
    if (process.env.LANG) env.LANG = process.env.LANG;
    if (config.openaiApiKey) {
      const provider = config.llmProvider ?? this.provider;
      switch (provider) {
        case 'openai':
        case 'azure-openai-responses':
          env.OPENAI_API_KEY = config.openaiApiKey;
          break;
        case 'anthropic':
          env.ANTHROPIC_API_KEY = config.openaiApiKey;
          break;
        case 'opencode':
        case 'opencode-go':
          env.OPENCODE_API_KEY = config.openaiApiKey;
          break;
      }
    }
    // Inform Pi about the Cua server.
    env.DYNFLOW_CUA_SERVER_URL = this.cuaServerUrl;
    return env;
  }

  /**
   * Ensure the Cua Computer Server is running. If it's not, start it in
   * the background (when `autoStartServer` is true). Returns a cleanup
   * callback that the caller should invoke when the runner is done.
   */
  private async ensureServer(): Promise<{ stop: () => void } | null> {
    if (await CuaPiRunner.isServerReachable(this.cuaServerUrl)) {
      return null; // already running
    }
    if (!this.autoStartServer) {
      throw new Error(
        `Cua Computer Server is not reachable at ${this.cuaServerUrl}. ` +
          `Start it with: ${this.pythonExe} -m computer_server --port 8000`,
      );
    }
    return await this.startServer();
  }

  /**
   * Start the Cua Computer Server in the background. The returned object
   * exposes a `stop()` method that should be called when the runner is
   * done with the server (e.g., on cleanup).
   */
  private async startServer(): Promise<{ stop: () => void }> {
    const port = new URL(this.cuaServerUrl).port || '8000';
    const child = spawn(this.pythonExe, ['-m', 'computer_server', '--port', port], {
      stdio: ['ignore', 'pipe', 'pipe'],
      // Detached so the server keeps running independently of the runner.
      detached: true,
      // shell: false; the Python path cannot be a metacharacter risk.
      shell: false,
      windowsHide: true,
    });
    // Wait for the server to come up (up to 10s).
    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline) {
      if (await CuaPiRunner.isServerReachable(this.cuaServerUrl)) {
        return {
          stop: () => {
            try { child.kill(); } catch { /* ignore */ }
          },
        };
      }
      await new Promise((r) => setTimeout(r, 250));
    }
    // Failed to start — kill the dangling child and throw.
    try { child.kill(); } catch { /* ignore */ }
    throw new Error(
      `Cua Computer Server failed to start at ${this.cuaServerUrl} within 10s`,
    );
  }

  /**
   * Build the prompt that wraps the user's task with Cua-aware instructions.
   * Tells Pi where the Cua Computer Server is and how to call it.
   */
  private buildCuaPrompt(userPrompt: string, workDir: string): string {
    const cuaSection = `
## Cua Computer Server (sandbox)

A Cua Computer Server is running at \`${this.cuaServerUrl}\`. You can use
\`curl\` (via the bash tool) to drive the Cua sandbox:

- Screenshot the desktop:
  \`\`\`bash
  curl -s -o /tmp/screen.png ${this.cuaServerUrl}/ws  # or use the WebSocket
  \`\`\`
- Status check: \`curl ${this.cuaServerUrl}/status\`
- HTTP command endpoint (POST): \`curl -X POST ${this.cuaServerUrl}/cmd -H 'Content-Type: application/json' -d '{"command":"screenshot","params":{}}'\`
- File commands (POST to /cmd): command=\`write_text\`, params=\`{"path":"...","content":"..."}\`
- File read: command=\`read_text\`, params=\`{"path":"..."}\`
- Run shell command in sandbox: command=\`run_command\`, params=\`{"command":"ls -la"}\`
- Mouse: command=\`left_click\`, params=\`{"x":100,"y":200}\`
- Keyboard: command=\`type_text\`, params=\`{"text":"hello"}\`

The full WebSocket protocol is also available at \`${this.cuaServerUrl}/ws\`.

When the task involves producing verifiable output (a web app, a UI, a
game), use the Cua Computer Server to confirm your output renders
correctly — take a screenshot, check the accessibility tree, and verify
the result before declaring success.
`;
    return buildPiPrompt({ userPrompt: cuaSection + '\n' + userPrompt, workspaceMount: workDir });
  }

  async run(config: AgentRunConfig): Promise<AgentResult> {
    if (!CuaPiRunner.isAvailable(this.binary)) {
      return {
        success: false,
        error: `Pi CLI ('${this.binary}') is not available on PATH. Install with: npm install -g @earendil-works/pi-coding-agent`,
        containerId: '',
      };
    }

    const workDir = config.workspacePath;
    if (!workDir) {
      return {
        success: false,
        error: 'workspacePath is required for CuaPiRunner',
        containerId: '',
      };
    }
    await mkdir(workDir, { recursive: true });

    // Ensure the Cua Computer Server is reachable.
    let serverHandle: { stop: () => void } | null = null;
    try {
      serverHandle = await this.ensureServer();
    } catch (err) {
      return {
        success: false,
        error: String(err),
        containerId: '',
      };
    }
    this.startedServer = serverHandle;

    // Build the per-agent prompt and write it to a unique file.
    const promptText = this.buildCuaPrompt(config.prompt, workDir);
    const safeAgentId = config.agentId.replace(/[^a-zA-Z0-9_-]/g, '_');
    const promptFile = join(workDir, `.dynflow-prompt-${safeAgentId}-${Date.now()}.md`);
    await writeFile(promptFile, promptText, 'utf-8');

    const shortInstruction = `Read the instructions in ${promptFile} and execute them. The Cua Computer Server is at ${this.cuaServerUrl}.`;

    const model = config.model ?? this.model;
    const effectiveProvider = config.llmProvider ?? this.provider;
    const args = [
      '--print',
      '--no-session',
      '--mode', 'json',
      '--provider', effectiveProvider,
      '--model', model,
      '--append-system-prompt',
      `你的工作目录是 ${workDir}。请只在该目录内修改文件,不要访问其他路径。` +
        ` 你可以通过 bash + curl 调用 Cua Computer Server at ${this.cuaServerUrl} 来截图、点击、运行命令。`,
      shortInstruction,
    ];

    // Resolve the binary: if it's a Windows .cmd shim, invoke the
    // underlying `node dist/cli.js` so we never need a shell. This is
    // identical to the probe's logic.
    const resolved = resolvePiBinary(this.binary);
    const resolvedArgs = resolved.args.concat(args);

    const containerId = `cua-pi-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    let stdout = '';
    let stderr = '';
    let exitCode = 0;
    let signal: NodeJS.Signals | null = null;
    let timedOut = false;
    let spawnError: Error | null = null;
    let outTruncated = false;
    let errTruncated = false;

    let child: ChildProcess;
    try {
      child = spawn(resolved.cmd, resolvedArgs, {
        cwd: workDir,
        env: this.buildChildEnv(config),
        stdio: ['ignore', 'pipe', 'pipe'],
        shell: false,
        windowsHide: true,
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

    let outBytes = 0;
    let errBytes = 0;
    const outChunks: Buffer[] = [];
    const errChunks: Buffer[] = [];
    child.stdout?.on('data', (b: Buffer) => {
      outBytes += b.length;
      if (!outTruncated) {
        if (outBytes > MAX_BUFFER_BYTES) {
          outTruncated = true;
          child.kill('SIGKILL');
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
          child.kill('SIGKILL');
        } else {
          errChunks.push(b);
        }
      }
    });

    child.on('error', (err) => {
      spawnError = err;
    });

    const timeoutMs = config.timeoutMs ?? 300_000;
    const timeoutHandle = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, timeoutMs);

    try {
      await new Promise<void>((resolve) => {
        let settled = false;
        const done = () => {
          if (settled) return;
          settled = true;
          resolve();
        };
        child.on('exit', (code, sig) => {
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
    } finally {
      clearTimeout(timeoutHandle);
      this.processRegistry.delete(containerId);
    }

    // Best-effort cleanup of the prompt file.
    try {
      await unlink(promptFile);
    } catch { /* ignore */ }

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
    if (outTruncated || errTruncated) {
      return {
        success: false,
        error: `pi produced more than ${MAX_BUFFER_BYTES} bytes — output truncated`,
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

    return {
      success: parsed.success,
      output: parsed.lastText,
      error: parsed.error ?? (exitCode !== 0 ? `pi exited with code ${exitCode} (signal=${signal ?? 'none'})` : undefined),
      containerId,
      files: files.list,
      fileCount: files.count,
      totalSize: files.size,
      outputDir: workDir,
      // Cua-specific: expose the server URL so the API layer can surface
      // it in the SSE event stream.
      cuaApiUrl: this.cuaServerUrl,
    };
  }

  async stop(containerId: string): Promise<void> {
    const child = this.processRegistry.get(containerId);
    if (child && child.exitCode === null) {
      await killProcessTree(child);
    }
    this.processRegistry.delete(containerId);
  }

  async cleanup(): Promise<void> {
    // Terminate any leaked children first (safety: these run on the host
    // without a container boundary, so they MUST be killed).
    for (const [id, child] of this.processRegistry.entries()) {
      if (child.exitCode === null) {
        await killProcessTree(child);
      }
      this.processRegistry.delete(id);
    }
    // Stop the server we started (if any). The server is the Cua "container".
    if (this.startedServer) {
      this.startedServer.stop();
      this.startedServer = null;
    }
  }
}

/**
 * Internal: probe function exposed for tests.
 */
export async function _probeCuaServerForTest(url: string): Promise<boolean> {
  return CuaPiRunner.isServerReachable(url);
}
