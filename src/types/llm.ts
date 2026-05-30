import type { TokenUsage } from './agent.js';

/**
 * Interface for LLM providers. Implement this to add custom providers.
 */
export interface LLMProvider {
  complete(request: LLMCompletionRequest): Promise<LLMCompletionResponse>;
}

/**
 * Request to send to an LLM provider.
 */
export interface LLMCompletionRequest {
  systemPrompt: string;
  messages: Array<{ role: 'user' | 'assistant'; content: string }>;
  model?: string;
  temperature?: number;
  maxTokens?: number;
  signal?: AbortSignal;
}

/**
 * Response from an LLM provider.
 */
export interface LLMCompletionResponse {
  content: string;
  tokenUsage: TokenUsage;
  model: string;
  durationMs: number;
}

/**
 * Configuration for creating an LLM client.
 */
export interface LLMClientConfig {
  baseUrl: string;
  apiKey: string;
  defaultModel: string;
  maxRetries?: number;
  retryDelayMs?: number;
  timeout?: number;
  defaultTemperature?: number;
  defaultMaxTokens?: number;
}
