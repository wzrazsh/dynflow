import type { LLMProvider, LLMCompletionRequest, LLMCompletionResponse, LLMClientConfig } from '../types/llm.js';
import { LLMError } from '../errors.js';

/**
 * Abstract base class for LLM clients. Handles retry and timeout.
 * Concrete implementations only need to implement the HTTP call.
 */
export abstract class LLMClient implements LLMProvider {
  protected config: Required<LLMClientConfig>;

  constructor(config: LLMClientConfig) {
    this.config = {
      baseUrl: config.baseUrl.replace(/\/+$/, ''),
      apiKey: config.apiKey,
      defaultModel: config.defaultModel,
      maxRetries: config.maxRetries ?? 3,
      retryDelayMs: config.retryDelayMs ?? 1000,
      timeout: config.timeout ?? 120_000,
      defaultTemperature: config.defaultTemperature ?? 0.7,
      defaultMaxTokens: config.defaultMaxTokens ?? 4096,
    };
  }

  abstract complete(request: LLMCompletionRequest): Promise<LLMCompletionResponse>;

  /**
   * Execute an async operation with retry and timeout.
   * Merges external cancellation signal with internal timeout-based AbortController.
   */
  protected async withRetry<T>(
    fn: (signal: AbortSignal) => Promise<T>,
    externalSignal?: AbortSignal
  ): Promise<T> {
    let lastError: Error | undefined;

    for (let attempt = 0; attempt <= this.config.maxRetries; attempt++) {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), this.config.timeout);

      // Merge external cancellation signal with the internal controller
      const onExternalAbort = () => controller.abort();
      if (externalSignal) {
        if (externalSignal.aborted) {
          clearTimeout(timeoutId);
          throw new LLMError('Request cancelled');
        }
        externalSignal.addEventListener('abort', onExternalAbort, { once: true });
      }

      try {
        const result = await fn(controller.signal);
        clearTimeout(timeoutId);
        return result;
      } catch (error) {
        clearTimeout(timeoutId);
        lastError = error as Error;

        // Detect cancellation source: external abort vs internal timeout vs normal error
        if (error instanceof Error && error.name === 'AbortError') {
          if (externalSignal?.aborted) {
            throw new LLMError('Request cancelled');
          }
          throw new LLMError(`Request timed out after ${this.config.timeout}ms`);
        }

        if (error instanceof LLMError && error.statusCode) {
          // Only retry on 429 (rate limit) and 5xx (server errors)
          if (error.statusCode !== 429 && error.statusCode < 500) {
            throw error;
          }
        }

        if (attempt < this.config.maxRetries) {
          const delayMs = this.config.retryDelayMs * Math.pow(2, attempt) + Math.random() * 1000;
          // Also respect external cancellation during retry waits
          await this.delay(delayMs, externalSignal);
        }
      } finally {
        if (externalSignal) {
          externalSignal.removeEventListener('abort', onExternalAbort);
        }
      }
    }

    throw lastError ?? new LLMError('Max retries exceeded');
  }

  /**
   * Wait for a given number of milliseconds, or until external signal is aborted.
   * Returns immediately if external signal is already aborted.
   */
  private delay(ms: number, externalSignal?: AbortSignal): Promise<void> {
    if (!externalSignal) {
      return new Promise(resolve => setTimeout(resolve, ms));
    }
    return new Promise<void>(resolve => {
      if (externalSignal.aborted) {
        resolve();
        return;
      }
      const timer = setTimeout(resolve, ms);
      const onAbort = () => {
        clearTimeout(timer);
        resolve();
      };
      externalSignal.addEventListener('abort', onAbort, { once: true });
    });
  }

  /**
   * Simple token count approximation (1 token ≈ 4 chars).
   * Providers that return usage data will override this.
   */
  protected countTokens(text: string): number {
    return Math.ceil(text.length / 4);
  }
}
