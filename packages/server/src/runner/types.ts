export interface AgentRunConfig {
  agentId: string;
  prompt: string;
  model: string;
  timeoutMs: number;
  openaiApiKey: string;
}

export interface AgentResult {
  success: boolean;
  output?: string;
  error?: string;
  containerId: string;
}

export interface AgentRunner {
  run(config: AgentRunConfig): Promise<AgentResult>;
  stop(containerId: string): Promise<void>;
  cleanup(): Promise<void>;
}
