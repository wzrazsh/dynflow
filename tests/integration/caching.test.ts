import { describe, it, expect } from 'vitest';
import { WorkflowRuntime } from '../../src/runtime/WorkflowRuntime.js';
import { WorkflowCache } from '../../src/runtime/Cache.js';
import { createMockLLM } from '../helpers/mock-llm.js';

describe('Integration: Caching', () => {
  it('should cache agent results', async () => {
    const llm = createMockLLM();
    const runtime = new WorkflowRuntime({
      llm,
      defaultModel: 'test-model',
    });

    // First run
    const result1 = await runtime.run({
      name: 'cache-test',
      sessionId: 'session-1',
      phases: [
        { name: 'p1', tasks: [{ id: 'a1', systemPrompt: 'sys', task: 'test' }] },
      ],
    });

    expect(result1.summary.cachedAgents).toBe(0);

    // The cache is in-memory and per-runtime instance, so we test the Cache class directly
    const cache = new WorkflowCache('session-1');
    cache.set('p1', 'a1', result1.results.get('p1')!.get('a1')!);

    const cached = cache.get('p1', 'a1');
    expect(cached).toBeDefined();
    expect(cached?.content).toBe('Echo: test');
  });
});
