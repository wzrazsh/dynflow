import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { OpenAICompatibleClient } from '../../src/llm/OpenAICompatibleClient.js';
import { LLMError } from '../../src/errors.js';

/**
 * Helper: create a mock fetch that hangs forever but rejects with AbortError
 * when the provided AbortSignal is aborted.
 */
function hangingFetch(): typeof fetch {
  return vi.fn().mockImplementation(async (_url: string, init?: RequestInit) => {
    const signal = init?.signal;
    await new Promise<Response>((_resolve, reject) => {
      if (signal?.aborted) {
        const err = new Error('The operation was aborted');
        err.name = 'AbortError';
        reject(err);
        return;
      }
      const onAbort = () => {
        const err = new Error('The operation was aborted');
        err.name = 'AbortError';
        reject(err);
      };
      signal?.addEventListener('abort', onAbort, { once: true });
    });
  }) as unknown as typeof fetch;
}

describe('OpenAICompatibleClient', () => {
  let client: OpenAICompatibleClient;

  beforeEach(() => {
    client = new OpenAICompatibleClient({
      baseUrl: 'https://api.test.com',
      apiKey: 'test-key',
      defaultModel: 'test-model',
      maxRetries: 2,
      retryDelayMs: 10,
      timeout: 5000,
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  // ---------------------------------------------------------------------------
  // Retry behavior
  // ---------------------------------------------------------------------------

  it('should retry on 429 and succeed', async () => {
    let callCount = 0;
    vi.stubGlobal('fetch', vi.fn().mockImplementation(async () => {
      callCount++;
      if (callCount === 1) {
        return new Response('rate limited', { status: 429 });
      }
      return new Response(JSON.stringify({
        choices: [{ message: { content: 'ok' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
        model: 'test',
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    }));

    const result = await client.complete({
      systemPrompt: 'sys',
      messages: [{ role: 'user', content: 'hi' }],
    });

    expect(callCount).toBe(2); // first 429, second 200
    expect(result.content).toBe('ok');
    expect(result.tokenUsage.totalTokens).toBe(15);
  });

  it('should retry on 5xx and succeed', async () => {
    let callCount = 0;
    vi.stubGlobal('fetch', vi.fn().mockImplementation(async () => {
      callCount++;
      if (callCount === 1) {
        return new Response('server error', { status: 503 });
      }
      return new Response(JSON.stringify({
        choices: [{ message: { content: 'ok' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
        model: 'test',
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    }));

    const result = await client.complete({
      systemPrompt: 'sys',
      messages: [{ role: 'user', content: 'hi' }],
    });

    expect(callCount).toBe(2);
    expect(result.content).toBe('ok');
  });

  it('should NOT retry on 4xx', async () => {
    let callCount = 0;
    vi.stubGlobal('fetch', vi.fn().mockImplementation(async () => {
      callCount++;
      return new Response('bad request', { status: 400 });
    }));

    await expect(client.complete({
      systemPrompt: 'sys',
      messages: [{ role: 'user', content: 'hi' }],
    })).rejects.toThrow(LLMError);

    expect(callCount).toBe(1); // no retry on 4xx
  });

  it('should throw after max retries exceeded (always 429)', async () => {
    let callCount = 0;
    vi.stubGlobal('fetch', vi.fn().mockImplementation(async () => {
      callCount++;
      return new Response('rate limited', { status: 429 });
    }));

    await expect(client.complete({
      systemPrompt: 'sys',
      messages: [{ role: 'user', content: 'hi' }],
    })).rejects.toThrow(LLMError);

    // maxRetries=2 → 3 calls (attempt 0, 1, 2)
    expect(callCount).toBe(3);
  });

  // ---------------------------------------------------------------------------
  // Timeout
  // ---------------------------------------------------------------------------

  it('should timeout after configured duration', async () => {
    vi.stubGlobal('fetch', hangingFetch());

    const fastClient = new OpenAICompatibleClient({
      baseUrl: 'https://api.test.com',
      apiKey: 'test-key',
      defaultModel: 'test-model',
      maxRetries: 0, // no retries to isolate timeout behavior
      timeout: 100,
    });

    await expect(fastClient.complete({
      systemPrompt: 'sys',
      messages: [{ role: 'user', content: 'hi' }],
    })).rejects.toThrow(/timed out/);
  }, 10000);

  // ---------------------------------------------------------------------------
  // External cancellation
  // ---------------------------------------------------------------------------

  it('should cancel on external AbortSignal', async () => {
    vi.stubGlobal('fetch', hangingFetch());

    const controller = new AbortController();

    const promise = client.complete({
      systemPrompt: 'sys',
      messages: [{ role: 'user', content: 'hi' }],
      signal: controller.signal,
    });

    controller.abort();

    await expect(promise).rejects.toThrow(LLMError);
    await expect(promise).rejects.toThrow(/cancelled/);
  }, 10000);

  // ---------------------------------------------------------------------------
  // Token usage fallback
  // ---------------------------------------------------------------------------

  it('should fallback total_tokens to promptTokens + completionTokens when missing', async () => {
    vi.stubGlobal('fetch', vi.fn().mockImplementation(async () => {
      return new Response(JSON.stringify({
        choices: [{ message: { content: 'ok' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 10, completion_tokens: 5 }, // no total_tokens
        model: 'test',
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    }));

    const result = await client.complete({
      systemPrompt: 'sys',
      messages: [{ role: 'user', content: 'hi' }],
    });

    expect(result.tokenUsage.promptTokens).toBe(10);
    expect(result.tokenUsage.completionTokens).toBe(5);
    expect(result.tokenUsage.totalTokens).toBe(15); // 10 + 5
  });

  it('should return token usage when all fields present', async () => {
    vi.stubGlobal('fetch', vi.fn().mockImplementation(async () => {
      return new Response(JSON.stringify({
        choices: [{ message: { content: 'ok' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 20 },
        model: 'test',
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    }));

    const result = await client.complete({
      systemPrompt: 'sys',
      messages: [{ role: 'user', content: 'hi' }],
    });

    expect(result.tokenUsage.promptTokens).toBe(10);
    expect(result.tokenUsage.completionTokens).toBe(5);
    expect(result.tokenUsage.totalTokens).toBe(20);
  });

  it('should fallback all token fields using countTokens when usage is absent', async () => {
    vi.stubGlobal('fetch', vi.fn().mockImplementation(async () => {
      return new Response(JSON.stringify({
        choices: [{ message: { content: 'world' }, finish_reason: 'stop' }],
        model: 'test',
        // no usage field at all
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    }));

    const result = await client.complete({
      systemPrompt: 'hello',
      messages: [{ role: 'user', content: 'test' }],
    });

    // countTokens('hellotest') = ceil(9/4) = 3
    expect(result.tokenUsage.promptTokens).toBe(3);
    // countTokens('world') = ceil(5/4) = 2
    expect(result.tokenUsage.completionTokens).toBe(2);
    // total = prompt + completion = 5
    expect(result.tokenUsage.totalTokens).toBe(5);
  });

  // ---------------------------------------------------------------------------
  // JSON parse error
  // ---------------------------------------------------------------------------

  it('should throw LLMError when response is not valid JSON', async () => {
    vi.stubGlobal('fetch', vi.fn().mockImplementation(async () => {
      return new Response('not-json-at-all', { status: 200, headers: { 'content-type': 'application/json' } });
    }));

    await expect(client.complete({
      systemPrompt: 'sys',
      messages: [{ role: 'user', content: 'hi' }],
    })).rejects.toThrow(LLMError);

    await expect(client.complete({
      systemPrompt: 'sys',
      messages: [{ role: 'user', content: 'hi' }],
    })).rejects.toThrow(/parse JSON/);
  });
});
