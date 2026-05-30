import type { LLMCompletionRequest, LLMCompletionResponse } from '../types/llm.js';
import { LLMClient } from './LLMClient.js';
import { LLMError } from '../errors.js';

interface OpenAIResponse {
  id: string;
  object: string;
  model: string;
  choices: Array<{
    message: { role: string; content: string };
    finish_reason: string;
  }>;
  usage: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
  };
}

/**
 * LLM client for OpenAI-compatible APIs (OpenAI, Anthropic via proxy, local models, etc.)
 */
export class OpenAICompatibleClient extends LLMClient {
  async complete(request: LLMCompletionRequest): Promise<LLMCompletionResponse> {
    const startTime = Date.now();

    return this.withRetry(async (signal) => {
      const model = request.model ?? this.config.defaultModel;
      const messages = [
        { role: 'system' as const, content: request.systemPrompt },
        ...request.messages,
      ];

      const response = await fetch(`${this.config.baseUrl}/chat/completions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${this.config.apiKey}`,
        },
        body: JSON.stringify({
          model,
          messages,
          max_tokens: request.maxTokens ?? this.config.defaultMaxTokens,
          temperature: request.temperature ?? this.config.defaultTemperature,
        }),
        signal,
      });

      if (!response.ok) {
        const errorText = await response.text().catch(() => 'unknown');
        // Truncate to avoid leaking full response; include status + model for diagnosis
        const truncated = errorText.length > 200 ? errorText.slice(0, 200) + '...' : errorText;
        throw new LLMError(
          `OpenAI API error (status ${response.status}, model ${model}): ${truncated}`,
          response.status
        );
      }

      let data: OpenAIResponse;
      try {
        data = await response.json() as OpenAIResponse;
      } catch {
        throw new LLMError(
          `Failed to parse JSON response from ${this.config.baseUrl} (status ${response.status})`,
          response.status
        );
      }

      if (!data.choices || data.choices.length === 0) {
        throw new LLMError('No choices returned from LLM');
      }

      const choice = data.choices[0];
      const durationMs = Date.now() - startTime;

      const promptTokens = data.usage?.prompt_tokens
        ?? this.countTokens(request.systemPrompt + (request.messages[0]?.content ?? ''));
      const completionTokens = data.usage?.completion_tokens
        ?? this.countTokens(choice.message.content);

      return {
        content: choice.message.content,
        tokenUsage: {
          promptTokens,
          completionTokens,
          totalTokens: data.usage?.total_tokens ?? (promptTokens + completionTokens),
        },
        model: data.model ?? model,
        durationMs,
      };
    }, request.signal);
  }
}
