import type { LLMProvider, LLMCompletionRequest, LLMCompletionResponse } from '../../src/types/llm.js';
import { vi } from 'vitest';

/**
 * Create a mock LLM provider for testing.
 * Returns a fixed response for any request, or maps system prompts to responses.
 */
export function createMockLLM(
  responseMap?: Record<string, string>
): LLMProvider {
  return {
    complete: vi.fn().mockImplementation(async (request: LLMCompletionRequest): Promise<LLMCompletionResponse> => {
      const content = responseMap?.[request.systemPrompt]
        ?? `Echo: ${request.messages[0]?.content ?? ''}`;

      // Simulate small delay
      await new Promise(resolve => setTimeout(resolve, 10));

      const promptText = request.systemPrompt + (request.messages[0]?.content ?? '');
      const promptTokens = Math.ceil(promptText.length / 4);
      const completionTokens = Math.ceil(content.length / 4);

      return {
        content,
        tokenUsage: {
          promptTokens,
          completionTokens,
          totalTokens: promptTokens + completionTokens,
        },
        model: request.model ?? 'mock-model',
        durationMs: 10,
      };
    }),
  };
}

/**
 * Create a mock LLM that fails on specific system prompts.
 */
export function createFailingMockLLM(
  failPrompts: string[],
  errorMessage = 'Mock LLM error'
): LLMProvider {
  return {
    complete: vi.fn().mockImplementation(async (request: LLMCompletionRequest): Promise<LLMCompletionResponse> => {
      if (failPrompts.includes(request.systemPrompt)) {
        throw new Error(errorMessage);
      }

      const content = `Echo: ${request.messages[0]?.content ?? ''}`;
      await new Promise(resolve => setTimeout(resolve, 10));

      return {
        content,
        tokenUsage: { promptTokens: 10, completionTokens: 10, totalTokens: 20 },
        model: request.model ?? 'mock-model',
        durationMs: 10,
      };
    }),
  };
}
