import { exec, execSync } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import type { AgentRunConfig, AgentResult, AgentRunner } from './types.js';

const execAsync = promisify(exec);

/**
 * Docker runner that executes Docker commands through WSL.
 * This allows using Docker Desktop's WSL backend from Windows.
 * 
 * Features:
 * - Passes host environment variables (API keys, etc.)
 * - Mounts output volume for persistent logs
 * - Supports configurable WSL distribution
 */
export class WslDockerAgentRunner implements AgentRunner {
  private readonly image: string;
  private readonly wslDistro: string;
  private readonly outputDir: string;

  constructor(
    image = 'dynflow-agent', 
    wslDistro = 'Ubuntu-24.04',
    outputDir = 'E:/workspace/dynflow/data/agent-logs'
  ) {
    this.image = image;
    this.wslDistro = wslDistro;
    this.outputDir = outputDir;
    
    // Ensure output directory exists
    if (!existsSync(outputDir)) {
      mkdirSync(outputDir, { recursive: true });
    }
  }

  /**
   * Execute a Docker command through WSL.
   */
  private async execDocker(cmd: string): Promise<string> {
    const wslCmd = `wsl -d ${this.wslDistro} -- docker ${cmd}`;
    const { stdout } = await execAsync(wslCmd);
    return stdout;
  }

  /**
   * Execute a Docker command through WSL synchronously.
   */
  private execDockerSync(cmd: string): string {
    const wslCmd = `wsl -d ${this.wslDistro} -- docker ${cmd}`;
    return execSync(wslCmd, { encoding: 'utf-8' });
  }

  /**
   * Check if Docker is available via WSL.
   * Returns `true` if `docker info` succeeds in WSL, `false` otherwise.
   */
  static isAvailable(wslDistro = 'Ubuntu-24.04'): boolean {
    try {
      execSync(`wsl -d ${wslDistro} -- docker info`, { stdio: 'ignore' });
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Get environment variables to pass to the container.
   * Passes through relevant host environment variables.
   */
  private getEnvVars(): string[] {
    const envVars: string[] = [];
    
    // Pass through API-related environment variables
    const envKeys = [
      'OPENAI_API_KEY',
      'OPENAI_BASE_URL', 
      'OPENCODE_MODEL',
      'OPENAI_MODEL',
      'ANTHROPIC_API_KEY',
      'ANTHROPIC_BASE_URL',
    ];
    
    for (const key of envKeys) {
      const value = process.env[key];
      if (value) {
        envVars.push(`-e ${key}="${value.replace(/"/g, '\\"')}"`);
      }
    }
    
    return envVars;
  }

  async run(config: AgentRunConfig): Promise<AgentResult> {
    if (!WslDockerAgentRunner.isAvailable(this.wslDistro)) {
      return {
        success: false,
        error: `Docker is not available in WSL (${this.wslDistro}). Please ensure Docker Desktop is running with WSL integration enabled.`,
        containerId: '',
      };
    }

    // Determine output directory
    const runId = `run-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    let runOutputDir: string;
    if (config.workspacePath) {
      runOutputDir = config.workspacePath;
    } else {
      runOutputDir = join(this.outputDir, runId);
    }
    mkdirSync(runOutputDir, { recursive: true });

    // Convert Windows path to WSL path for volume mounting
    // Only lowercase the drive letter, not the full path
    const wslOutputDir = runOutputDir.replace(/^([A-Z]):/, (_, d) => '/mnt/' + d.toLowerCase()).replace(/\\/g, '/');

    // Escape the prompt for shell execution
    const escapedPrompt = config.prompt.replace(/"/g, '\\"').replace(/\n/g, '\\n');
    const escapedApiKey = (config.apiKey || process.env.OPENAI_API_KEY || '').replace(/"/g, '\\"');

    // Build environment variable arguments
    const envArgs = this.getEnvVars();
    
    // Always pass the config values (they override host env)
    const configEnvArgs = [
      `-e AGENT_PROMPT="${escapedPrompt}"`,
      `-e AGENT_MODEL="${config.model}"`,
      `-e AGENT_TIMEOUT_MS="${config.timeoutMs}"`,
      `-e OPENAI_API_KEY="${escapedApiKey}"`,
    ];

    const runCmd =
      `run -d --memory=512m --cpus=1 --stop-timeout=30 --label dynflow=true --label run-id=${runId} ` +
      `--volume "${wslOutputDir}:/app/output" ` +
      `${envArgs.join(' ')} ` +
      `${configEnvArgs.join(' ')} ` +
      `${this.image}`;

    const containerId = await this.execDocker(runCmd);
    const cid = containerId.trim();

    // Wait for container to complete
    await this.execDocker(`wait ${cid}`);

    // Get container logs (before removal)
    const logs = await this.execDocker(`logs ${cid}`);

    // Save logs to file
    const logFile = join(runOutputDir, 'output.log');
    const { writeFileSync } = await import('node:fs');
    writeFileSync(logFile, logs, 'utf-8');

    // Remove the container after getting logs
    await this.execDocker(`rm ${cid}`);

    try {
      const parsed = JSON.parse(logs.trim());
      
      // Save parsed result
      const resultFile = join(runOutputDir, 'result.json');
      writeFileSync(resultFile, JSON.stringify(parsed, null, 2), 'utf-8');
      
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
    } catch (parseError) {
      return {
        success: false,
        output: logs,
        error: `Failed to parse agent output: ${parseError instanceof Error ? parseError.message : 'Unknown error'}`,
        containerId: cid,
      };
    }
  }

  async stop(containerId: string): Promise<void> {
    try {
      await this.execDocker(`stop ${containerId}`);
    } catch {
      // Ignore errors
    }
    try {
      await this.execDocker(`rm -f ${containerId}`);
    } catch {
      // Ignore errors
    }
  }

  async cleanup(): Promise<void> {
    try {
      this.execDockerSync(`ps -a --filter "label=dynflow" -q | xargs -r docker rm -f`);
    } catch {
      // Ignore errors
    }
  }
}
