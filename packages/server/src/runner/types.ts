import type { WorkspaceConfig } from '@dynflow/shared';

export interface AgentRunConfig {
  agentId: string;
  prompt: string;
  model?: string;
  timeoutMs: number;
  /** Legacy field, kept for DockerAgentRunner. */
  openaiApiKey?: string;

  // === Cua + Pi fields ===
  /** Absolute path on host to the shared workspace directory. */
  workspacePath: string;
  /** Container-internal mount point (default: '/home/cua/workspace'). */
  workspaceMount: string;
  /** Workspace config (used at run start to git clone / verify path). */
  workspaceConfig?: WorkspaceConfig;
  /** noVNC URL returned by Cua SDK after sandbox start. */
  noVncUrl?: string;
  /** Cua computer-server API URL. */
  cuaApiUrl?: string;
}

export interface AgentResult {
  success: boolean;
  output?: string;
  error?: string;
  containerId: string;
  files?: string[];
  fileCount?: number;
  totalSize?: number;
  outputDir?: string;

  // === Cua fields ===
  noVncUrl?: string;
  cuaApiUrl?: string;
  screenshotPaths?: string[];
}

export interface AgentRunner {
  run(config: AgentRunConfig): Promise<AgentResult>;
  stop(containerId: string): Promise<void>;
  cleanup(): Promise<void>;
}
