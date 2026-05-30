/**
 * Status of an agent execution.
 */
export type AgentStatus = 'success' | 'error' | 'cancelled';

/**
 * Token usage statistics.
 */
export interface TokenUsage {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
}

/**
 * Result of a single agent execution.
 */
export interface AgentResult {
  id: string;
  phaseName: string;
  content: string;
  tokenUsage: TokenUsage;
  durationMs: number;
  status: AgentStatus;
  error?: string;
  cached: boolean;
  model: string;
  startedAt: number;
  completedAt: number;
}
