/**
 * Cua Computer Server — typed WebSocket/HTTP client.
 *
 * Talks to the Cua Computer Server (Python FastAPI on :8000) that the
 * `cua-computer-server` package exposes. The client supports two
 * transports:
 *
 *   1. WebSocket at `${baseUrl}/ws` — preferred, allows multiple commands
 *      in flight with a per-message response.
 *   2. HTTP POST to `${baseUrl}/cmd` (SSE response) — used as a fallback
 *      if the WebSocket handshake fails. The server's SSE stream emits a
 *      single `data: { ... }` line containing the JSON result.
 *
 * For local development (no `CONTAINER_NAME` env var on the server) no
 * authentication is required. See `cua-pi-runner.ts` for the protocol
 * details and `E:\workspace\cua\libs\python\computer-server\...` for
 * the server source.
 */

import { request as httpRequest, Agent as HttpAgent } from 'node:http';
import { request as httpsRequest, Agent as HttpsAgent } from 'node:https';
import { URL } from 'node:url';

// ---------------------------------------------------------------------------
// Result types
// ---------------------------------------------------------------------------

export interface CuaCommandResult<T = Record<string, unknown>> {
  success: boolean;
  error?: string;
  /** Server-specific response fields (e.g., `image_data`, `content`, `stdout`). */
  data?: T;
}

export interface ScreenshotResult {
  /** Base64-encoded PNG (or JPEG, depending on `format` param) bytes. */
  imageDataB64: string;
  /** Always "png" for the installed Cua server (v0.1.25). */
  format: 'png' | 'jpeg';
}

export interface RunCommandResult {
  success: boolean;
  stdout: string;
  stderr: string;
  returnCode: number;
  /** Set by Cua server when the command exceeded its timeout. */
  timedOut?: boolean;
}

export interface ListDirResult {
  files: string[];
}

export interface ReadTextResult {
  content: string;
}

// ---------------------------------------------------------------------------
// Internal WS frame
// ---------------------------------------------------------------------------

interface WsResponse {
  success: boolean;
  error?: string;
  // Additional server fields — see protocol contract.
  [key: string]: unknown;
}

/**
 * One outstanding command on the WebSocket. Stores the per-request
 * resolve/reject and the per-request timeout timer so they can be
 * cleared atomically. The Cua WS protocol is one-response-per-message
 * (no per-message correlation), so we must use a strict FIFO and
 * resolve requests in order. Storing the timer alongside the
 * resolvers lets `close()` clear every outstanding request without
 * racing the message handler.
 */
interface PendingRequest {
  resolve: (resp: WsResponse) => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout> | null;
  /** Set true when the request has been removed from the FIFO (resolved/rejected). */
  settled: boolean;
}

// ---------------------------------------------------------------------------
// Client
// ---------------------------------------------------------------------------

export interface CuaHttpClientOptions {
  baseUrl: string;
  /** Per-command timeout in milliseconds (default: 30_000). */
  commandTimeoutMs?: number;
  /** WebSocket connect timeout in milliseconds (default: 5_000). */
  connectTimeoutMs?: number;
}

/**
 * Lightweight typed client for the Cua Computer Server.
 *
 * The constructor is synchronous and does not open a connection — the
 * WebSocket is established lazily on the first command and recycled
 * across subsequent calls. A FIFO of pending requests is maintained so
 * that even though the Cua WS protocol is one-response-per-message
 * (no per-message correlation), commands resolve in order. This matches
 * the typical access pattern of a coding agent, where commands are
 * naturally sequential.
 */
export class CuaHttpClient {
  private readonly baseUrl: string;
  private readonly commandTimeoutMs: number;
  private readonly connectTimeoutMs: number;

  /** Lazily-opened WebSocket. */
  private ws: WebSocket | null = null;
  /** FIFO of pending requests, each with its own resolve/reject/timer. */
  private readonly pending: PendingRequest[] = [];
  /** Whether the underlying socket is currently OPEN. */
  private wsReady: Promise<void> | null = null;

  constructor(options: CuaHttpClientOptions) {
    this.baseUrl = options.baseUrl.replace(/\/+$/, '');
    this.commandTimeoutMs = options.commandTimeoutMs ?? 30_000;
    this.connectTimeoutMs = options.connectTimeoutMs ?? 5_000;
  }

  /** Close the underlying WebSocket. Idempotent. */
  async close(): Promise<void> {
    if (this.ws) {
      try {
        this.ws.close();
      } catch {
        /* ignore */
      }
      this.ws = null;
    }
    this.wsReady = null;
    // Reject every outstanding request. The array is iterated in FIFO
    // order so callers see rejections in the order they were issued.
    while (this.pending.length > 0) {
      const req = this.pending.shift()!;
      if (req.timer) clearTimeout(req.timer);
      if (req.settled) continue;
      req.settled = true;
      req.reject(new Error('CuaHttpClient closed'));
    }
  }

  /**
   * Send a command to the Cua server over the established WebSocket.
   * Falls back to HTTP POST `/cmd` (SSE) if the WebSocket cannot be
   * opened.
   */
  private async send<T extends WsResponse = WsResponse>(
    command: string,
    params: Record<string, unknown>,
  ): Promise<T> {
    if (this.ws) {
      try {
        return await this.sendOverWs<T>(command, params);
      } catch (err) {
        // WS failed mid-stream — fall back to HTTP for this and
        // subsequent commands in this run.
        const message = err instanceof Error ? err.message : String(err);
        // Reset WS so the next call retries.
        await this.close();
        // Try HTTP fallback once.
        return await this.sendOverHttp<T>(command, params, message);
      }
    }
    try {
      await this.ensureWs();
      return await this.sendOverWs<T>(command, params);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      await this.close();
      return await this.sendOverHttp<T>(command, params, message);
    }
  }

  /** Open a WebSocket if one is not already open. */
  private ensureWs(): Promise<void> {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) return Promise.resolve();
    if (this.wsReady) return this.wsReady;
    this.wsReady = new Promise<void>((resolve, reject) => {
      const url = this.baseUrl.replace(/^http/, 'ws') + '/ws';
      let settled = false;
      const settle = (fn: () => void) => {
        if (settled) return;
        settled = true;
        fn();
      };
      const timer = setTimeout(() => {
        settle(() => reject(new Error(`WebSocket connect timeout after ${this.connectTimeoutMs}ms (${url})`)));
        try {
          this.ws?.close();
        } catch {
          /* ignore */
        }
      }, this.connectTimeoutMs);
      let socket: WebSocket;
      try {
        socket = new WebSocket(url);
      } catch (err) {
        clearTimeout(timer);
        settle(() => reject(err instanceof Error ? err : new Error(String(err))));
        return;
      }
      this.ws = socket;
      socket.addEventListener('open', () => {
        clearTimeout(timer);
        settle(resolve);
      });
      socket.addEventListener('error', (ev: Event) => {
        clearTimeout(timer);
        settle(() => reject(new Error(`WebSocket error: ${(ev as ErrorEvent).message ?? 'unknown'}`)));
      });
      socket.addEventListener('close', () => {
        // Reject all outstanding requests — the next call will try
        // HTTP fallback. We use the FIFO in send-order so the caller's
        // `Promise.race`/await sees rejections in the right order.
        while (this.pending.length > 0) {
          const req = this.pending.shift()!;
          if (req.timer) clearTimeout(req.timer);
          if (req.settled) continue;
          req.settled = true;
          req.reject(new Error('WebSocket closed unexpectedly'));
        }
      });
      socket.addEventListener('message', (ev: MessageEvent) => {
        // Cua server sends JSON-encoded responses, one per command.
        const data = typeof ev.data === 'string' ? ev.data : '';
        if (!data) return;
        let parsed: WsResponse;
        try {
          parsed = JSON.parse(data) as WsResponse;
        } catch {
          // Not JSON — treat as a generic error.
          parsed = { success: false, error: `non-JSON response: ${data.slice(0, 200)}` };
        }
        const req = this.pending.shift();
        if (!req) return; // unexpected response with no waiting request
        if (req.timer) clearTimeout(req.timer);
        if (req.settled) return;
        req.settled = true;
        req.resolve(parsed);
      });
    });
    // Always reset the cached promise on completion so future calls can retry.
    return this.wsReady.finally(() => {
      // Leave the open socket in place; only null wsReady so we don't
      // re-resolve. Keep `this.ws` for subsequent calls.
    });
  }

  private async sendOverWs<T extends WsResponse>(
    command: string,
    params: Record<string, unknown>,
  ): Promise<T> {
    await this.ensureWs();
    const socket = this.ws;
    if (!socket || socket.readyState !== WebSocket.OPEN) {
      throw new Error('WebSocket not open');
    }
    // Push a single PendingRequest onto the FIFO. The message handler
    // will pop the head and resolve/reject it; the close handler
    // drains all pending requests with a rejection.
    const entry: PendingRequest = {
      resolve: () => {
        /* replaced below */
      },
      reject: () => {
        /* replaced below */
      },
      timer: null,
      settled: false,
    };
    const responsePromise = new Promise<T>((resolve, reject) => {
      entry.resolve = (resp) => resolve(resp as T);
      entry.reject = reject;
    });
    entry.timer = setTimeout(() => {
      // Find and remove this exact entry from the FIFO. We can't just
      // pop the head — another request may have been enqueued first.
      const idx = this.pending.indexOf(entry);
      if (idx >= 0) this.pending.splice(idx, 1);
      if (entry.settled) return;
      entry.settled = true;
      entry.reject(
        new Error(`Cua command '${command}' timed out after ${this.commandTimeoutMs}ms`),
      );
    }, this.commandTimeoutMs);
    this.pending.push(entry);
    try {
      socket.send(JSON.stringify({ command, params }));
    } catch (err) {
      if (entry.timer) clearTimeout(entry.timer);
      // Also remove from the FIFO so the response handler doesn't try
      // to resolve a settled request.
      const idx = this.pending.indexOf(entry);
      if (idx >= 0) this.pending.splice(idx, 1);
      throw err instanceof Error ? err : new Error(String(err));
    }
    return await responsePromise;
  }

  private async sendOverHttp<T extends WsResponse>(
    command: string,
    params: Record<string, unknown>,
    fallbackReason?: string,
  ): Promise<T> {
    const url = this.baseUrl + '/cmd';
    const body = JSON.stringify({ command, params });
    const parsed = new URL(url);
    const isHttps = parsed.protocol === 'https:';
    const lib = isHttps ? httpsRequest : httpRequest;
    const agent = isHttps ? new HttpsAgent({ keepAlive: false }) : new HttpAgent({ keepAlive: false });
    return await new Promise<T>((resolve, reject) => {
      const req = lib(
        {
          method: 'POST',
          hostname: parsed.hostname,
          port: parsed.port || (isHttps ? 443 : 80),
          path: parsed.pathname + (parsed.search ?? ''),
          headers: {
            'Content-Type': 'application/json',
            'Content-Length': Buffer.byteLength(body),
            Accept: 'text/event-stream',
          },
          agent,
        },
        (res) => {
          const chunks: Buffer[] = [];
          res.on('data', (c: Buffer) => chunks.push(c));
          res.on('end', () => {
            const text = Buffer.concat(chunks).toString('utf-8');
            // SSE: parse `data: <json>` line(s)
            const dataLine = text
              .split(/\r?\n/)
              .map((l) => l.trim())
              .find((l) => l.startsWith('data:'));
            if (!dataLine) {
              reject(new Error(`Cua HTTP fallback returned no data line: ${text.slice(0, 200)}`));
              return;
            }
            const payload = dataLine.replace(/^data:\s*/, '');
            try {
              resolve(JSON.parse(payload) as T);
            } catch {
              reject(new Error(`Cua HTTP fallback returned non-JSON: ${payload.slice(0, 200)}`));
            }
          });
          res.on('error', (err) => reject(err));
        },
      );
      req.setTimeout(this.commandTimeoutMs, () => {
        req.destroy(new Error(`Cua HTTP fallback timed out after ${this.commandTimeoutMs}ms (ws failed: ${fallbackReason ?? 'unknown'})`));
      });
      req.on('error', (err) => reject(err));
      req.write(body);
      req.end();
    });
  }

  // -------------------------------------------------------------------------
  // High-level API used by AgentTool definitions
  // -------------------------------------------------------------------------

  /** Take a screenshot. Returns base64-encoded image data. */
  async screenshot(format: 'png' | 'jpeg' = 'png'): Promise<ScreenshotResult> {
    const resp = await this.send<WsResponse & { image_data?: string; format?: string }>(
      'screenshot',
      { format },
    );
    if (!resp.success) {
      throw new Error(`screenshot failed: ${resp.error ?? 'unknown error'}`);
    }
    if (!resp.image_data) {
      throw new Error('screenshot response missing image_data');
    }
    return {
      imageDataB64: resp.image_data,
      format: (resp.format as 'png' | 'jpeg') ?? format,
    };
  }

  /** Click at absolute screen coordinates. */
  async leftClick(x: number, y: number): Promise<void> {
    const resp = await this.send('left_click', { x, y });
    if (!resp.success) {
      throw new Error(`left_click failed: ${resp.error ?? 'unknown error'}`);
    }
  }

  /** Type text into the focused element. */
  async typeText(text: string): Promise<void> {
    const resp = await this.send('type_text', { text });
    if (!resp.success) {
      throw new Error(`type_text failed: ${resp.error ?? 'unknown error'}`);
    }
  }

  /** Run a shell command in the Cua sandbox. */
  async runCommand(command: string, timeoutSec?: number): Promise<RunCommandResult> {
    const params: Record<string, unknown> = { command };
    if (typeof timeoutSec === 'number') params.timeout = timeoutSec;
    const resp = await this.send<WsResponse & {
      stdout?: string;
      stderr?: string;
      return_code?: number;
    }>('run_command', params);
    return {
      success: resp.success,
      stdout: resp.stdout ?? '',
      stderr: resp.stderr ?? '',
      returnCode: resp.return_code ?? (resp.success ? 0 : -1),
      timedOut: resp.error?.toLowerCase().includes('timed out') ?? false,
    };
  }

  /** List files in a directory. */
  async listDir(path: string): Promise<ListDirResult> {
    const resp = await this.send<WsResponse & { files?: string[] }>('list_dir', { path });
    if (!resp.success) {
      throw new Error(`list_dir failed: ${resp.error ?? 'unknown error'}`);
    }
    return { files: resp.files ?? [] };
  }

  /** Read a UTF-8 text file. */
  async readText(path: string): Promise<ReadTextResult> {
    const resp = await this.send<WsResponse & { content?: string }>('read_text', { path });
    if (!resp.success) {
      throw new Error(`read_text failed: ${resp.error ?? 'unknown error'}`);
    }
    return { content: resp.content ?? '' };
  }

  /**
   * Read the accessibility tree of the Cua sandbox desktop. Returns
   * the raw `tree` object from the server — typically a recursive
   * structure of `role`/`title`/`position`/`size`/`children`. The
   * caller (an LLM tool) is expected to JSON-stringify and pass it
   * through.
   */
  async getAccessibilityTree(): Promise<unknown> {
    const resp = await this.send<WsResponse & { tree?: unknown }>(
      'get_accessibility_tree',
      {},
    );
    if (!resp.success) {
      throw new Error(
        `get_accessibility_tree failed: ${resp.error ?? 'unknown error'}`,
      );
    }
    return resp.tree;
  }

  /** Write a UTF-8 text file. */
  async writeText(path: string, content: string): Promise<void> {
    const resp = await this.send('write_text', { path, content });
    if (!resp.success) {
      throw new Error(`write_text failed: ${resp.error ?? 'unknown error'}`);
    }
  }

  /** Probe /status to check whether the server is reachable. */
  async isReachable(): Promise<boolean> {
    try {
      const res = await fetch(`${this.baseUrl}/status`, {
        signal: AbortSignal.timeout(2_000),
      });
      return res.ok;
    } catch {
      return false;
    }
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Decode a base64-encoded screenshot to a Buffer (PNG/JPEG bytes).
 * Useful for saving the screenshot to disk or embedding in a tool result.
 */
export function decodeScreenshotBase64(imageDataB64: string): Buffer {
  return Buffer.from(imageDataB64, 'base64');
}
