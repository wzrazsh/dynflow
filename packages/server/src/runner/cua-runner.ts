import { exec, execSync } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { AgentRunConfig, AgentResult, AgentRunner } from './types.js';
import { parsePiJsonLines } from './pi-output-parser.js';
import { scanWorkspaceChanges } from './workspace-scanner.js';
import { buildPiPrompt } from './prompt-builder.js';

const execAsync = promisify(exec);

export interface CuaRunnerOptions {
  /** Cua-based Docker image to use. */
  image?: string;
  /** Memory limit (e.g., '2GB'). */
  memory?: string;
  /** CPU limit (e.g., '2'). */
  cpu?: string;
  /** VNC display resolution inside the container. */
  display?: string;
  /** Pre-assigned noVNC host port (bypasses pickFreePort). */
  noVncPort?: number;
  /** Pre-assigned Cua API host port (bypasses pickFreePort). */
  cuaApiPort?: number;
}

/**
 * CuaAgentRunner — runs Pi coding agent inside a Cua sandbox container.
 *
 * Implementation note: we use the `docker` CLI directly rather than the
 * @trycua/computer TypeScript SDK because that SDK is currently cloud-only
 * (it requires a Cua Cloud API key). The Cua image itself (`trycua/cua-xfce`
 * or our `dynflow-cua-pi` derivative) provides the desktop, computer-server,
 * and noVNC; we just need to manage the Docker container.
 *
 * The container is started detached, then we use `docker exec` to run Pi
 * inside it. The container remains alive after the agent exits so that the
 * noVNC URL and computer-server API stay available for the rest of the
 * workflow run (subsequent agents in later phases).
 */
export class CuaAgentRunner implements AgentRunner {
  private readonly image: string;
  private readonly memory: string;
  private readonly cpu: string;
  private readonly display: string;
  private readonly noVncPort?: number;
  private readonly cuaApiPort?: number;

  constructor(options: CuaRunnerOptions = {}) {
    this.image = options.image ?? process.env.DYNFLOW_CUA_IMAGE ?? 'dynflow-cua-pi:latest';
    this.memory = options.memory ?? '2GB';
    this.cpu = options.cpu ?? '2';
    this.display = options.display ?? '1280x720';
    this.noVncPort = options.noVncPort;
    this.cuaApiPort = options.cuaApiPort;
  }

  static isAvailable(): boolean {
    try {
      execSync('docker info', { stdio: 'ignore' });
      return true;
    } catch {
      return false;
    }
  }

  async run(config: AgentRunConfig): Promise<AgentResult> {
    if (!CuaAgentRunner.isAvailable()) {
      return {
        success: false,
        error: 'Docker is not available on this host. Please start Docker and try again.',
        containerId: '',
      };
    }

    if (!config.workspacePath) {
      return {
        success: false,
        error: 'workspacePath is required for CuaAgentRunner',
        containerId: '',
      };
    }

    // Ensure the workspace directory exists.
    await mkdir(config.workspacePath, { recursive: true });

    // Pick a free host port for noVNC and computer-server.
    // Tests can provide pre-assigned ports via constructor options to bypass port scan.
    const noVncPort = this.noVncPort ?? await pickFreePort(6900, 6999);
    const cuaApiPort = this.cuaApiPort ?? await pickFreePort(8000, 8099);

    // Build and run the container in detached mode.
    const containerId = await this.startContainer(config, noVncPort, cuaApiPort);

    try {
      // Write the prompt into the workspace (it gets mounted into the container
      // at config.workspaceMount, so Pi can read it once running).
      const promptFile = join(config.workspacePath, '.dynflow-prompt.md');
      await writeFile(
        promptFile,
        buildPiPrompt({
          userPrompt: config.prompt,
          workspaceMount: config.workspaceMount,
        }),
        'utf-8',
      );

      // Run Pi inside the container via docker exec.
      const piFlags = ['--mode json', '--no-session'];
      if (config.model) {
        piFlags.push(`--model ${config.model}`);
      }
      if (config.llmProvider) {
        piFlags.push(`--provider ${config.llmProvider}`);
      }
      const piCmd =
        `cd ${config.workspaceMount} && ` +
        `pi ${piFlags.join(' ')} "$(cat .dynflow-prompt.md)"`;
      const { stdout } = await execAsync(
        `docker exec ${containerId} bash -lc ${shellQuote(piCmd)}`,
        { maxBuffer: 32 * 1024 * 1024, timeout: config.timeoutMs },
      );

      const parsed = parsePiJsonLines(stdout);
      const files = await scanWorkspaceChanges(config.workspacePath);

      return {
        success: parsed.success,
        output: parsed.lastText,
        error: parsed.error,
        containerId,
        files: files.list,
        fileCount: files.count,
        totalSize: files.size,
        outputDir: config.workspacePath,
        noVncUrl: `http://localhost:${noVncPort}`,
        cuaApiUrl: `http://localhost:${cuaApiPort}`,
      };
    } finally {
      // The container is left running so noVNC stays available to the user.
      // Cleanup happens via stop() or cleanup() (label-based removal).
    }
  }

  async stop(containerId: string): Promise<void> {
    await execAsync(`docker stop ${containerId}`).catch(() => {});
    await execAsync(`docker rm -f ${containerId}`).catch(() => {});
  }

  async cleanup(): Promise<void> {
    try {
      execSync('docker ps -a --filter "label=dynflow" -q | xargs -r docker rm -f', {
        stdio: 'ignore',
      });
    } catch {
      /* ignore */
    }
  }

  private async startContainer(
    config: AgentRunConfig,
    noVncPort: number,
    cuaApiPort: number,
  ): Promise<string> {
    const runCmd =
      `docker run -d ` +
      `--memory=${this.memory} --cpus=${this.cpu} --stop-timeout=10 ` +
      `--shm-size=512m ` +
      `--label dynflow=true ` +
      `-p ${noVncPort}:6901 ` +
      `-p ${cuaApiPort}:8000 ` +
      `--volume ${shellQuote(config.workspacePath)}:${config.workspaceMount} ` +
      `-e ANTHROPIC_API_KEY="${config.apiKey ?? process.env.ANTHROPIC_API_KEY ?? ''}" ` +
      `-e OPENAI_API_KEY="${config.apiKey ?? process.env.OPENAI_API_KEY ?? ''}" ` +
      `-e PI_CWD=${config.workspaceMount} ` +
      `${this.image}`;
    const { stdout } = await execAsync(runCmd);
    return stdout.trim();
  }
}

async function pickFreePort(min: number, max: number): Promise<number> {
  // Pick a random port in the range and trust that the host has a wide
  // enough window. Real implementation would track allocated ports to
  // avoid races. Tests can override the runner to inject ports.
  for (let attempt = 0; attempt < 10; attempt++) {
    const port = min + Math.floor(Math.random() * (max - min));
    try {
      const net = await import('node:net');
      const ok = await new Promise<boolean>((resolve) => {
        const timer = setTimeout(() => resolve(false), 100);
        const srv = net.createServer();
        srv.unref();
        srv.on('error', () => {
          clearTimeout(timer);
          resolve(false);
        });
        srv.listen(port, () => {
          clearTimeout(timer);
          srv.close(() => resolve(true));
        });
      });
      if (ok) return port;
    } catch {
      /* ignore */
    }
  }
  // Fallback: just return a port in range (last attempt).
  return min + Math.floor(Math.random() * (max - min));
}

function shellQuote(s: string): string {
  // Wrap in single quotes; escape any single quote inside as '\''
  return `'${s.replaceAll("'", "'\\''")}'`;
}
