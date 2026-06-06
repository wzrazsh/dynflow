/**
 * PiCuaNativeRunner — runs Pi programmatically inside the Cua Computer Server.
 *
 * Unlike `CuaPiRunner` (which shells out to the `pi` CLI and parses JSONL
 * over stdout), this runner calls `runAgentLoop` from
 * `@earendil-works/pi-agent-core` in-process. The Cua Computer Server
 * (Python FastAPI on :8000) is the sandbox, and the agent talks to it
 * via custom `AgentTool[]` definitions that call the Cua HTTP/WS API.
 *
 * Architecture:
 *
 *   ┌───────────────────────────────────────┐        ┌────────────────────────────┐
 *   │  Pi agent loop (in-process)          │        │  Cua Computer Server      │
 *   │  @earendil-works/pi-agent-core        │        │  (Python FastAPI on :8000) │
 *   │                                       │        │                            │
 *   │  Custom AgentTool[]:                  │        │  Tools exposed via WS/HTTP:│
 *   │   - read_file / write_file / edit     │  HTTP  │  - screenshot              │
 *   │     (host filesystem, in workspace)   │  /WS   │  - left_click / type_text  │
 *   │   - bash (host, sandboxed via Cua)    │ ◄────► │  - run_command (shell)     │
 *   │   - cua_screenshot / cua_click        │        │  - file operations         │
 *   │   - cua_type / cua_run                │        │                            │
 *   │   - cua_a11y (accessibility tree)     │        │                            │
 *   │                                       │        │                            │
 *   │  Writes game files to workspace ──────┼───────►│  Sandbox OS / desktop      │
 *   └───────────────────────────────────────┘        └────────────────────────────┘
 *
 * This is the in-process sibling of `CuaPiRunner`. Both runners share the
 * same conceptual model: the agent writes files locally and uses the Cua
 * sandbox to verify them (screenshot, accessibility tree, run a server).
 * The difference is the transport — CLI subprocess vs. in-process API
 * calls — and the level of control: this runner can react to streamed
 * events (e.g., to abort early on certain tool results) and the agent
 * loop is one TypeScript call rather than a process fork.
 *
 * No Docker. No shell metacharacter risk (tools receive typed params).
 */

import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, resolve, relative, sep } from 'node:path';
import {
  runAgentLoop,
  type AgentContext,
  type AgentLoopConfig,
  type AgentMessage,
  type AgentTool,
  type AgentToolResult,
  type AgentEvent,
} from '@earendil-works/pi-agent-core';
import { Type } from 'typebox';
import type { Message as PiAiMessage } from '@earendil-works/pi-ai';
import type { AgentRunConfig, AgentResult, AgentRunner } from './types.js';
import { scanWorkspaceChanges } from './workspace-scanner.js';
import { CuaHttpClient, decodeScreenshotBase64 } from './cua-http-client.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Default Cua Computer Server URL. */
const DEFAULT_CUA_SERVER_URL = 'http://127.0.0.1:8000';

/** Default model provider for the in-process agent. */
const DEFAULT_PROVIDER = 'opencode';

/** Default model ID for the in-process agent. */
const DEFAULT_MODEL = 'mimo-v2.5-free';

/** Timeout for the Cua server reachability probe (in ms). */
const PROBE_TIMEOUT_MS = 3_000;

/** Maximum size of an individual tool result before truncation. */
const MAX_TOOL_RESULT_BYTES = 1024 * 1024; // 1 MiB

// ---------------------------------------------------------------------------
// Tool parameter schemas (TypeBox)
// ---------------------------------------------------------------------------

const ReadFileParams = Type.Object({
  path: Type.String({ description: 'Absolute path to a UTF-8 text file' }),
});

const WriteFileParams = Type.Object({
  path: Type.String({ description: 'Absolute path to the file to write' }),
  content: Type.String({ description: 'UTF-8 text content' }),
});

const EditFileParams = Type.Object({
  path: Type.String({ description: 'Absolute path to the file to edit' }),
  oldText: Type.String({ description: 'Existing substring to replace' }),
  newText: Type.String({ description: 'Replacement string' }),
});

const ListDirParams = Type.Object({
  path: Type.String({ description: 'Absolute path to the directory' }),
});

const BashParams = Type.Object({
  command: Type.String({ description: 'Shell command to run in the workspace cwd' }),
  timeout: Type.Optional(
    Type.Number({ description: 'Timeout in seconds (default: 30)', minimum: 1 }),
  ),
});

const CuaScreenshotParams = Type.Object({});

const CuaLeftClickParams = Type.Object({
  x: Type.Number({ description: 'X coordinate in screen pixels' }),
  y: Type.Number({ description: 'Y coordinate in screen pixels' }),
});

const CuaTypeParams = Type.Object({
  text: Type.String({ description: 'Text to type into the focused element' }),
});

const CuaRunParams = Type.Object({
  command: Type.String({ description: 'Shell command to run in the Cua sandbox' }),
  timeout: Type.Optional(Type.Number({ description: 'Timeout in seconds', minimum: 1 })),
});

const CuaA11yParams = Type.Object({});

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------

export interface PiCuaNativeRunnerOptions {
  /** Provider name (e.g. 'opencode', 'anthropic', 'openai'). */
  provider?: string;
  /** Model ID (e.g. 'mimo-v2.5-free', 'claude-sonnet-4-20250514'). */
  model?: string;
  /** Cua Computer Server base URL. */
  cuaServerUrl?: string;
  /**
   * Optional registry for tracking active AbortControllers keyed by
   * containerId. Used by `stop()` and `cleanup()` to abort in-flight
   * agent loops.
   */
  processRegistry?: Map<string, AbortController>;
}

// ---------------------------------------------------------------------------
// Runner
// ---------------------------------------------------------------------------

/**
 * PiCuaNativeRunner — runs Pi in-process, talking to the Cua Computer
 * Server via custom `AgentTool[]` definitions.
 *
 * The runner is auto-selectable when both the `@earendil-works/pi-agent-core`
 * package is installed (transitively via `@earendil-works/pi-coding-agent`)
 * and the Cua Computer Server is reachable at the configured URL.
 */
export class PiCuaNativeRunner implements AgentRunner {
  private readonly provider: string;
  private readonly model: string;
  private readonly cuaServerUrl: string;
  private readonly processRegistry: Map<string, AbortController>;

  constructor(options: PiCuaNativeRunnerOptions = {}) {
    this.provider = options.provider ?? process.env.DYNFLOW_PI_PROVIDER ?? DEFAULT_PROVIDER;
    this.model = options.model ?? process.env.DYNFLOW_PI_MODEL ?? DEFAULT_MODEL;
    this.cuaServerUrl =
      options.cuaServerUrl ??
      process.env.DYNFLOW_CUA_SERVER_URL ??
      DEFAULT_CUA_SERVER_URL;
    this.processRegistry = options.processRegistry ?? new Map();
  }

  // -------------------------------------------------------------------------
  // Availability
  // -------------------------------------------------------------------------

  /**
   * Synchronous availability probe. Returns true when the
   * `@earendil-works/pi-agent-core` module can be loaded. This is
   * cheap and used by the selection chain (which is sync).
   *
   * Cua server reachability is NOT part of this probe — it is checked
   * at `run()` time and returns a clear error if the server is down.
   * That keeps the selection chain simple and avoids async probing
   * during server startup.
   *
   * `isServerReachable` is the async variant for tests / explicit
   * verification.
   */
  static isAvailable(): boolean {
    try {
      // `import.meta.resolve` (Node 20.6+) is the cheapest sync probe
      // for an ESM package. Throws synchronously if the module is not
      // installed.
      (import.meta as { resolve?: (s: string) => string }).resolve?.(
        '@earendil-works/pi-agent-core',
      );
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Async probe that checks the Cua Computer Server's `/status` endpoint
   * in addition to module availability. Used by tests and by the `run()`
   * method to fail fast with a clear error.
   */
  static async isServerReachable(
    options?: { cuaServerUrl?: string },
  ): Promise<boolean> {
    const url =
      options?.cuaServerUrl ??
      process.env.DYNFLOW_CUA_SERVER_URL ??
      DEFAULT_CUA_SERVER_URL;
    try {
      const res = await fetch(`${url}/status`, {
        signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
      });
      return res.ok;
    } catch {
      return false;
    }
  }

  // -------------------------------------------------------------------------
  // AgentRunner interface
  // -------------------------------------------------------------------------

  async run(config: AgentRunConfig): Promise<AgentResult> {
    const workDir = config.workspacePath;
    if (!workDir) {
      return {
        success: false,
        error: 'workspacePath is required for PiCuaNativeRunner',
        containerId: '',
      };
    }
    await mkdir(workDir, { recursive: true });

    // Fail fast if the Cua server is not reachable. This produces a
    // clear error message instead of a confusing tool failure mid-run.
    if (!(await PiCuaNativeRunner.isServerReachable({ cuaServerUrl: this.cuaServerUrl }))) {
      return {
        success: false,
        error:
          `Cua Computer Server is not reachable at ${this.cuaServerUrl}. ` +
          `Start it with: python -m computer_server --port 8000`,
        containerId: '',
      };
    }

    // Build the Cua client and a fresh AbortController for this run.
    const cua = new CuaHttpClient({ baseUrl: this.cuaServerUrl });
    const abortController = new AbortController();

    const containerId = `pi-cua-native-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    this.processRegistry.set(containerId, abortController);

    // Wire a timeout onto the AbortController. `runAgentLoop` honors
    // AbortSignal for cancellation; aborting during a tool call will
    // propagate through the `signal` parameter to the in-flight tool.
    const timeoutMs = config.timeoutMs ?? 300_000;
    const timeoutHandle = setTimeout(() => {
      abortController.abort(new Error(`PiCuaNativeRunner timed out after ${timeoutMs}ms`));
    }, timeoutMs);

    try {
      return await this.runInner(config, workDir, cua, abortController, containerId);
    } finally {
      clearTimeout(timeoutHandle);
      this.processRegistry.delete(containerId);
      // Best-effort WS close.
      try {
        await cua.close();
      } catch {
        /* ignore */
      }
    }
  }

  private async runInner(
    config: AgentRunConfig,
    workDir: string,
    cua: CuaHttpClient,
    abortController: AbortController,
    containerId: string,
  ): Promise<AgentResult> {
    // ----- Build tools -----
    const tools = this.buildTools(workDir, cua, abortController.signal);

    // ----- Build context + config -----
    const systemPrompt = this.buildSystemPrompt(workDir);

    const context: AgentContext = {
      systemPrompt,
      messages: [],
      tools,
    };

    // Resolve the model lazily so `getModel` failure becomes a graceful
    // error message rather than a crash at import time.
    const model = await this.resolveModel(config);

    const agentConfig: AgentLoopConfig = {
      model,
      // Identity pass-through: agent-core's runAgentLoop already filters
      // out non-LLM message roles, so this is safe to leave as identity.
      // The cast through `unknown` is safe because `AgentMessage` is a
      // structural superset of `Message` (both are unions over
      // user/assistant/toolResult, and AgentMessage adds custom roles
      // that we've already filtered out).
      convertToLlm: ((msgs: AgentMessage[]) =>
        msgs.filter(
          (m) =>
            m.role === 'user' ||
            m.role === 'assistant' ||
            m.role === 'toolResult',
        ) as unknown as PiAiMessage[]) as AgentLoopConfig['convertToLlm'],
      // Sequential by default — Cua actions (click, screenshot) and
      // file writes are inherently ordered. The pi-agent-core default
      // is parallel which can cause file-write races for our pattern.
      toolExecution: 'sequential',
    };

    // Forward the API key into the stream options. We pick the env var
    // name based on the configured provider (mirrors the
    // PiDirectRunner.buildChildEnv allowlist).
    if (config.apiKey) {
      agentConfig.apiKey = config.apiKey;
    } else {
      // Fall back to env-var name matching the (possibly overridden) provider
      // so we don't send an OpenCode key to the Anthropic endpoint or vice versa.
      const effectiveProvider = config.llmProvider ?? this.provider;
      const envKey = this.envApiKeyForProvider(effectiveProvider);
      if (envKey) agentConfig.apiKey = envKey;
    }

    // Build the user prompt. We include the workspace path explicitly
    // so the agent knows where to write files.
    const userPrompt = `${config.prompt}

## Working Directory
Your workspace is \`${workDir}\`. Create and modify files only in this directory. Do not access any path outside it.

## Verification
When the task involves UI / web / game output, verify it by:
1. \`cua_run\` to start a local server (e.g., \`python -m http.server 8000\`) in the workspace,
2. \`cua_screenshot\` to capture the rendered result,
3. \`cua_a11y\` to read the accessibility tree and confirm the output is rendered correctly.`;

    const prompts: AgentMessage[] = [
      {
        role: 'user',
        content: userPrompt,
        timestamp: Date.now(),
      },
    ];

    // ----- Event capture -----
    let lastText = '';
    const toolCalls: string[] = [];
    let loopError: string | undefined;

    const emit = async (event: AgentEvent): Promise<void> => {
      switch (event.type) {
        case 'message_update': {
          // Stream assistant text deltas. `assistantMessageEvent` is a
          // pi-ai event; we only care about text_delta for the final
          // output capture.
          const inner = (event as { assistantMessageEvent?: { type?: string; delta?: string } })
            .assistantMessageEvent;
          if (inner?.type === 'text_delta' && typeof inner.delta === 'string') {
            lastText += inner.delta;
          }
          break;
        }
        case 'message_end': {
          // Capture the final assistant text content from the persisted
          // message. This is more reliable than accumulating deltas
          // because it works regardless of stream framing.
          const msg = event.message;
          if (msg.role === 'assistant') {
            const content = (msg as { content?: Array<{ type: string; text?: string }> }).content ?? [];
            const text = content
              .filter((b) => b.type === 'text' && typeof b.text === 'string')
              .map((b) => b.text as string)
              .join('');
            if (text) lastText = text;
          }
          break;
        }
        case 'tool_execution_start': {
          toolCalls.push(`${event.toolName}(${JSON.stringify(event.args).slice(0, 200)})`);
          break;
        }
        case 'tool_execution_end': {
          if (event.isError) {
            // Surface tool errors as warnings in the final output.
            lastText += `\n[tool error: ${event.toolName}: ${truncate(String((event.result as { content?: Array<{ type: string; text?: string }> })?.content?.find((b) => b.type === 'text')?.text ?? 'unknown'), 500)}]`;
          }
          break;
        }
        case 'agent_end': {
          // Final barrier — agent-core waits for awaited subscribers.
          break;
        }
        default:
          // No-op for turn_start/turn_end/message_start/etc.
          break;
      }
    };

    // ----- Run the loop -----
    try {
      await runAgentLoop(prompts, context, agentConfig, emit, abortController.signal);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (abortController.signal.aborted) {
        // Treat abort as a stop, not a failure.
        return {
          success: false,
          error: `pi-cua-native aborted: ${(abortController.signal.reason as Error | undefined)?.message ?? message}`,
          containerId,
          output: lastText || undefined,
        };
      }
      loopError = message;
    }

    if (loopError) {
      return {
        success: false,
        error: loopError,
        containerId,
        output: lastText || undefined,
      };
    }

    // ----- Scan workspace for changed files (used by SSE event payload) -----
    const files = await scanWorkspaceChanges(workDir);

    return {
      success: true,
      output: lastText || undefined,
      containerId,
      files: files.list,
      fileCount: files.count,
      totalSize: files.size,
      outputDir: workDir,
      cuaApiUrl: this.cuaServerUrl,
    };
  }

  async stop(containerId: string): Promise<void> {
    const controller = this.processRegistry.get(containerId);
    if (controller) {
      try {
        controller.abort(new Error(`stop() called for ${containerId}`));
      } catch {
        /* ignore */
      }
      this.processRegistry.delete(containerId);
    }
  }

  async cleanup(): Promise<void> {
    for (const [id, controller] of this.processRegistry.entries()) {
      try {
        controller.abort(new Error(`cleanup() called for ${id}`));
      } catch {
        /* ignore */
      }
      this.processRegistry.delete(id);
    }
  }

  // -------------------------------------------------------------------------
  // Tool factory
  // -------------------------------------------------------------------------

  private buildTools(
    workDir: string,
    cua: CuaHttpClient,
    signal: AbortSignal,
  ): AgentTool[] {
    const safeWorkDir = workDir;

    /** Helper: throw if the signal has been aborted. */
    const assertNotAborted = () => {
      if (signal.aborted) {
        const reason = signal.reason;
        const message = reason instanceof Error ? reason.message : String(reason);
        throw new Error(`aborted: ${message}`);
      }
    };

    /** Helper: build a successful text AgentToolResult. */
    const ok = (text: string, details?: unknown): AgentToolResult<unknown> => ({
      content: [{ type: 'text', text: truncate(text, MAX_TOOL_RESULT_BYTES) }],
      details: details ?? {},
    });

    /** Helper: build an error text AgentToolResult. */
    const fail = (err: unknown): AgentToolResult<unknown> => {
      const message = err instanceof Error ? err.message : String(err);
      return {
        content: [{ type: 'text', text: `error: ${message}` }],
        details: { isError: true, error: message },
        // Mark as error so the LLM retries; this maps to `isError: true`
        // on the tool result message.
        terminate: false,
      };
    };

    // -------- read_file (host filesystem, sandboxed to workspace) --------
    const readFileTool: AgentTool<typeof ReadFileParams> = {
      name: 'read_file',
      label: 'Read File',
      description: `Read a UTF-8 text file. Path must be inside the workspace (${safeWorkDir}).`,
      parameters: ReadFileParams,
      execute: async (_toolCallId, params) => {
        try {
          assertNotAborted();
          const resolved = resolveInside(safeWorkDir, params.path);
          assertNotAborted();
          const { readFile } = await import('node:fs/promises');
          const content = await readFile(resolved, 'utf-8');
          return ok(content, { path: resolved, size: content.length });
        } catch (err) {
          return fail(err);
        }
      },
    };

    // -------- write_file (host filesystem, sandboxed to workspace) --------
    const writeFileTool: AgentTool<typeof WriteFileParams> = {
      name: 'write_file',
      label: 'Write File',
      description: `Write a UTF-8 text file. Path must be inside the workspace (${safeWorkDir}).`,
      parameters: WriteFileParams,
      execute: async (_toolCallId, params) => {
        try {
          assertNotAborted();
          const resolved = resolveInside(safeWorkDir, params.path);
          // Ensure the parent directory exists. `mkdir` on the file
          // path itself would create a directory at that path, which
          // is a footgun.
          const parent = dirname(resolved);
          if (parent && parent !== resolved) {
            await mkdir(parent, { recursive: true });
          }
          assertNotAborted();
          await writeFile(resolved, params.content, 'utf-8');
          return ok(`wrote ${params.content.length} bytes to ${resolved}`, {
            path: resolved,
            size: params.content.length,
          });
        } catch (err) {
          return fail(err);
        }
      },
    };

    // -------- edit_file (host filesystem, sandboxed to workspace) --------
    const editFileTool: AgentTool<typeof EditFileParams> = {
      name: 'edit_file',
      label: 'Edit File',
      description: `Replace one occurrence of oldText with newText in a file. Path must be inside the workspace (${safeWorkDir}).`,
      parameters: EditFileParams,
      execute: async (_toolCallId, params) => {
        try {
          assertNotAborted();
          const resolved = resolveInside(safeWorkDir, params.path);
          const { readFile } = await import('node:fs/promises');
          const current = await readFile(resolved, 'utf-8');
          assertNotAborted();
          const idx = current.indexOf(params.oldText);
          if (idx === -1) {
            return {
              content: [
                {
                  type: 'text',
                  text: `error: oldText not found in ${resolved} (searched ${params.oldText.length} chars)`,
                },
              ],
              details: { isError: true, error: 'oldText not found' },
            };
          }
          const next =
            current.slice(0, idx) +
            params.newText +
            current.slice(idx + params.oldText.length);
          await writeFile(resolved, next, 'utf-8');
          return ok(`edited ${resolved}`, { path: resolved });
        } catch (err) {
          return fail(err);
        }
      },
    };

    // -------- list_dir --------
    const listDirTool: AgentTool<typeof ListDirParams> = {
      name: 'list_dir',
      label: 'List Directory',
      description: `List the names of files in a directory. Path must be inside the workspace (${safeWorkDir}).`,
      parameters: ListDirParams,
      execute: async (_toolCallId, params) => {
        try {
          assertNotAborted();
          const resolved = resolveInside(safeWorkDir, params.path);
          const { readdir } = await import('node:fs/promises');
          const entries = await readdir(resolved);
          return ok(entries.join('\n') || '(empty)', { path: resolved, count: entries.length });
        } catch (err) {
          return fail(err);
        }
      },
    };

    // -------- bash (host, sandboxed to workspace cwd) --------
    //
    // SECURITY NOTE: This tool runs `cmd.exe /c <command>` on the host
    // with the current user's privileges. The Cua "sandbox" layer is
    // NOT applied to bash — Cua sandbox only covers `cua_*` tools. The
    // workspace directory is the cwd, but no other filesystem or
    // network restrictions are applied.
    //
    // Mitigation: the child environment is restricted to a small
    // allowlist (PATH, HOME, USERPROFILE, SYSTEMROOT, TEMP, LANG +
    // the Cua server URL) so the host agent does not inherit unrelated
    // server secrets (database credentials, CI tokens, etc.). This
    // mirrors `PiDirectRunner.buildChildEnv` and `CuaPiRunner.buildChildEnv`.
    //
    // For sandboxed shell access, prefer `cua_run` which runs inside
    // the Cua Computer Server.
    const bashTool: AgentTool<typeof BashParams> = {
      name: 'bash',
      label: 'Bash',
      description:
        `Run a shell command on the host (sandboxed to workspace cwd ${safeWorkDir}). ` +
        'Prefer `cua_run` for sandboxed shell access inside the Cua Computer Server.',
      parameters: BashParams,
      executionMode: 'sequential',
      execute: async (_toolCallId, params) => {
        try {
          assertNotAborted();
          const timeoutSec = params.timeout ?? 30;
          const { execFile } = await import('node:child_process');
          const { promisify } = await import('node:util');
          const execFileAsync = promisify(execFile);
          assertNotAborted();
          // execFile is used (not spawn with shell:true) so the command
          // string is passed positionally. On Windows, `cmd.exe /d /s /c`
          // is invoked to support pipes/redirects. On POSIX, the
          // default shell is `/bin/sh -c`. No argv injection is
          // possible because the command is a single positional
          // argument, not split across argv entries.
          const isWindows = process.platform === 'win32';
          const shellCmd = isWindows ? 'cmd.exe' : '/bin/sh';
          const shellArgs = isWindows
            ? ['/d', '/s', '/c', params.command]
            : ['-c', params.command];
          const { stdout, stderr } = await execFileAsync(shellCmd, shellArgs, {
            cwd: safeWorkDir,
            env: buildBashEnv(this.cuaServerUrl),
            timeout: timeoutSec * 1000,
            maxBuffer: 4 * 1024 * 1024,
            windowsHide: true,
            signal,
          });
          return ok(
            `stdout:\n${truncate(String(stdout), MAX_TOOL_RESULT_BYTES / 2)}\nstderr:\n${truncate(String(stderr), MAX_TOOL_RESULT_BYTES / 2)}`,
            { cwd: safeWorkDir, timeoutSec },
          );
        } catch (err) {
          return fail(err);
        }
      },
    };

    // -------- Cua sandbox tools --------

    const cuaScreenshotTool: AgentTool<typeof CuaScreenshotParams> = {
      name: 'cua_screenshot',
      label: 'Cua Screenshot',
      description:
        'Take a screenshot of the Cua sandbox desktop. Returns the image as base64-encoded PNG.',
      parameters: CuaScreenshotParams,
      execute: async (_toolCallId, _params) => {
        try {
          assertNotAborted();
          const result = await cua.screenshot('png');
          assertNotAborted();
          // Return the base64 string. The agent can see image content
          // when models support vision, but for mimo-v2.5-free we
          // mostly just want the tool to confirm the desktop state.
          return ok(
            `screenshot taken (${result.format}, ${result.imageDataB64.length} base64 chars). ` +
              `Use cua_a11y for text-based inspection.`,
            { imageDataB64: result.imageDataB64, format: result.format },
          );
        } catch (err) {
          return fail(err);
        }
      },
    };

    const cuaLeftClickTool: AgentTool<typeof CuaLeftClickParams> = {
      name: 'cua_left_click',
      label: 'Cua Left Click',
      description: 'Click at absolute screen coordinates inside the Cua sandbox.',
      parameters: CuaLeftClickParams,
      execute: async (_toolCallId, params) => {
        try {
          assertNotAborted();
          await cua.leftClick(params.x, params.y);
          return ok(`clicked at (${params.x}, ${params.y})`);
        } catch (err) {
          return fail(err);
        }
      },
    };

    const cuaTypeTool: AgentTool<typeof CuaTypeParams> = {
      name: 'cua_type',
      label: 'Cua Type',
      description: 'Type text into the focused element in the Cua sandbox.',
      parameters: CuaTypeParams,
      execute: async (_toolCallId, params) => {
        try {
          assertNotAborted();
          await cua.typeText(params.text);
          return ok(`typed ${params.text.length} chars`);
        } catch (err) {
          return fail(err);
        }
      },
    };

    const cuaRunTool: AgentTool<typeof CuaRunParams> = {
      name: 'cua_run',
      label: 'Cua Run Command',
      description:
        'Run a shell command inside the Cua sandbox (NOT the host). Returns stdout/stderr/return_code.',
      parameters: CuaRunParams,
      execute: async (_toolCallId, params) => {
        try {
          assertNotAborted();
          const result = await cua.runCommand(params.command, params.timeout);
          assertNotAborted();
          const body = JSON.stringify(
            {
              success: result.success,
              stdout: result.stdout,
              stderr: result.stderr,
              returnCode: result.returnCode,
              timedOut: result.timedOut ?? false,
            },
            null,
            2,
          );
          return ok(truncate(body, MAX_TOOL_RESULT_BYTES), result);
        } catch (err) {
          return fail(err);
        }
      },
    };

    const cuaA11yTool: AgentTool<typeof CuaA11yParams> = {
      name: 'cua_a11y',
      label: 'Cua Accessibility Tree',
      description:
        'Read the accessibility tree of the Cua sandbox desktop. Returns a JSON-serialized tree.',
      parameters: CuaA11yParams,
      execute: async (_toolCallId, _params) => {
        try {
          assertNotAborted();
          // Use the typed helper on CuaHttpClient. It handles both
          // the WS and HTTP-fallback paths, so this tool works even
          // if the WebSocket has not been opened yet (the helper will
          // open it lazily).
          const tree = await cua.getAccessibilityTree();
          assertNotAborted();
          return ok(
            truncate(JSON.stringify({ tree }, null, 2), MAX_TOOL_RESULT_BYTES),
            { tree },
          );
        } catch (err) {
          return fail(err);
        }
      },
    };

    return [
      readFileTool,
      writeFileTool,
      editFileTool,
      listDirTool,
      bashTool,
      cuaScreenshotTool,
      cuaLeftClickTool,
      cuaTypeTool,
      cuaRunTool,
      cuaA11yTool,
    ];
  }

  // -------------------------------------------------------------------------
  // System prompt
  // -------------------------------------------------------------------------

  private buildSystemPrompt(workDir: string): string {
    return [
      'You are Pi, a coding agent running inside DynFlow.',
      'Your job is to complete the user task using the provided tools.',
      '',
      '## Working directory',
      `Your workspace is \`${workDir}\`. All file tools (read/write/edit/list) are sandboxed to this directory. Do not access any path outside it.`,
      '',
      '## Available tools',
      '- `read_file` / `write_file` / `edit_file` / `list_dir`: host filesystem (sandboxed to workspace).',
      '- `bash`: run a shell command on the host (in the workspace cwd).',
      '- `cua_screenshot` / `cua_left_click` / `cua_type` / `cua_run` / `cua_a11y`: drive the Cua sandbox.',
      '',
      '## Verification',
      'When the task produces UI / web / game output, verify it by:',
      '1. `cua_run` to start a local server (e.g., `python -m http.server 8000`) in the workspace,',
      '2. `cua_run` to open a browser if needed (or just `cua_screenshot` to capture the desktop),',
      '3. `cua_a11y` to read the accessibility tree and confirm the output is rendered correctly.',
      '',
      '## Output style',
      'Be concise. After completing the task, briefly summarize what you did and which files you changed.',
    ].join('\n');
  }

  // -------------------------------------------------------------------------
  // Model resolution
  // -------------------------------------------------------------------------

  private async resolveModel(config?: { model?: string; llmProvider?: string }): Promise<AgentLoopConfig['model']> {
    const piAi = await import('@earendil-works/pi-ai');
    const effectiveModel = config?.model ?? this.model;
    const effectiveProvider = config?.llmProvider ?? this.provider;
    try {
      // `getModel`'s provider parameter is typed as the strict literal
      // union `KnownProvider`. Our env-driven `effectiveProvider` is a
      // plain string; we cast to `never` and rely on the runtime lookup
      // to validate. If the provider is unknown, `getModel` throws.
      return piAi.getModel(
        effectiveProvider as Parameters<typeof piAi.getModel>[0],
        effectiveModel as Parameters<typeof piAi.getModel>[1],
      ) as unknown as AgentLoopConfig['model'];
    } catch (err) {
      throw new Error(
        `Failed to resolve model ${effectiveProvider}/${effectiveModel}: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  }

  /** Look up the env-var name for the configured provider. */
  private envApiKeyForProvider(provider?: string): string | undefined {
    const p = provider ?? this.provider;
    switch (p) {
      case 'openai':
      case 'azure-openai-responses':
        return process.env.OPENAI_API_KEY;
      case 'anthropic':
        return process.env.ANTHROPIC_API_KEY;
      case 'opencode':
      case 'opencode-go':
        return process.env.OPENCODE_API_KEY;
      default:
        return undefined;
    }
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Build a minimal env for the bash tool's child process. The host
 * shell does NOT need server secrets, agent API keys, or anything
 * beyond what an interactive shell needs to find its binary and
 * libraries. This mirrors `PiDirectRunner.buildChildEnv` and
 * `CuaPiRunner.buildChildEnv` for consistency.
 */
function buildBashEnv(cuaServerUrl: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  if (process.env.PATH) env.PATH = process.env.PATH;
  if (process.env.HOME) env.HOME = process.env.HOME;
  if (process.env.USERPROFILE) env.USERPROFILE = process.env.USERPROFILE;
  if (process.env.SYSTEMROOT) env.SYSTEMROOT = process.env.SYSTEMROOT;
  if (process.env.TEMP) env.TEMP = process.env.TEMP;
  if (process.env.LANG) env.LANG = process.env.LANG;
  // Inform the child about the Cua server URL for `curl` invocations
  // and ad-hoc scripts.
  env.DYNFLOW_CUA_SERVER_URL = cuaServerUrl;
  return env;
}

/**
 * Resolve `path` to an absolute path and confirm it lives inside
 * `root`. Throws if the path is absolute and points outside `root`, or
 * if `path` is relative and resolves to a location outside `root`.
 *
 * This is the workspace sandbox: file tools can only touch files under
 * the workspace. This protects the host from the agent overreaching
 * (e.g., a `read_file('/etc/passwd')` call).
 */
function resolveInside(root: string, path: string): string {
  const normRoot = resolve(root);
  const abs = isAbsolute(path) ? path : resolve(normRoot, path);
  const rel = relative(normRoot, abs);
  // On Windows, `relative('D:\\foo', 'C:\\bar')` returns `'C:\\bar'`
  // (an absolute path) — this does NOT start with `..` and therefore
  // would silently bypass the `..` check below.  Also catch UNC paths
  // (`\\server\share\...`) that escape the workspace root.
  if (isAbsolute(rel) || rel.startsWith('..' + sep) || rel === '..') {
    throw new Error(`path '${path}' resolves outside the workspace root '${root}'`);
  }
  return abs;
}

/** Truncate a string to at most `maxBytes` bytes (UTF-8 safe). */
function truncate(text: string, maxBytes: number): string {
  const buf = Buffer.from(text, 'utf-8');
  if (buf.length <= maxBytes) return text;
  // Reserve a few bytes for the truncation marker.
  return buf.subarray(0, Math.max(0, maxBytes - 16)).toString('utf-8') + '...[truncated]';
}

// ---------------------------------------------------------------------------
// Internal: probe function exposed for tests.
// ---------------------------------------------------------------------------

/**
 * Probe the Cua server reachability, exposed for tests.
 * Mirrors the static `isAvailable` semantics for the Cua half only.
 */
export async function _probeCuaServerForTest(url: string): Promise<boolean> {
  try {
    const res = await fetch(`${url}/status`, {
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
    });
    return res.ok;
  } catch {
    return false;
  }
}

// Re-export decodeScreenshotBase64 for downstream consumers
export { decodeScreenshotBase64 };
