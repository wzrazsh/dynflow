import { exec, execSync } from 'node:child_process';
import { promisify } from 'node:util';
import type { AgentRunConfig, AgentResult, AgentRunner } from './types.js';

const execAsync = promisify(exec);

export class DockerAgentRunner implements AgentRunner {
  private readonly image: string;

  constructor(image = 'dynflow-agent') {
    this.image = image;
  }

  /**
   * Check if Docker is available on the host.
   * Returns `true` if `docker info` succeeds, `false` otherwise.
   */
  static isAvailable(): boolean {
    try {
      execSync('docker info', { stdio: 'ignore' });
      return true;
    } catch {
      return false;
    }
  }

  async run(config: AgentRunConfig): Promise<AgentResult> {
    if (!DockerAgentRunner.isAvailable()) {
      return {
        success: false,
        error: 'Docker is not available on this host. Please start Docker and try again.',
        containerId: '',
      };
    }
    let volumeArg = '';
    if (config.workspacePath) {
      volumeArg = `--volume "${config.workspacePath}:/app/output" `;
    }
    const runCmd =
      `docker run --rm -d --memory=512m --cpus=1 --stop-timeout=10 --label dynflow=true ` +
      volumeArg +
      `-e AGENT_PROMPT="${config.prompt.replace(/"/g, '\\"')}" ` +
      `-e AGENT_MODEL="${config.model}" ` +
      `-e AGENT_TIMEOUT_MS="${config.timeoutMs}" ` +
      `-e OPENAI_API_KEY="${config.openaiApiKey}" ` +
      `${this.image}`;
    const { stdout: containerId } = await execAsync(runCmd);
    const cid = containerId.trim();

    await execAsync(`docker wait ${cid}`, { timeout: config.timeoutMs + 10000 });

    const { stdout: logs } = await execAsync(`docker logs ${cid}`);

    const parsed = JSON.parse(logs.trim());
    return {
      success: parsed.success,
      output: parsed.output,
      error: parsed.error,
      containerId: cid,
      files: parsed.files,
      fileCount: parsed.fileCount,
      totalSize: parsed.totalSize,
      outputDir: parsed.outputDir,
    };
  }

  async stop(containerId: string): Promise<void> {
    await execAsync(`docker stop ${containerId}`).catch(() => {});
    await execAsync(`docker rm -f ${containerId}`).catch(() => {});
  }

  async cleanup(): Promise<void> {
    try {
      execSync(
        'docker ps -a --filter "label=dynflow" -q | xargs -r docker rm -f',
        { stdio: 'ignore' },
      );
    } catch {
      /* ignore */
    }
  }
}
