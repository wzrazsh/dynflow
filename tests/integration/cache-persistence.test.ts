import { describe, it, expect } from 'vitest';
import { WorkflowRuntime } from '../../src/runtime/WorkflowRuntime.js';
import { createMockLLM } from '../helpers/mock-llm.js';
import { rmSync, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

const TEST_DIR = join(process.cwd(), '.test-cache-persist');

describe('Integration: Cache persistence', () => {
  it('should persist cache to disk and reuse across runtime instances', async () => {
    // Clean up before test
    if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });
    mkdirSync(TEST_DIR, { recursive: true });

    const mockLLM = createMockLLM();

    // First run: create runtime with cacheDir — no cache exists yet
    const runtime1 = new WorkflowRuntime({
      llm: mockLLM,
      defaultModel: 'test',
      cacheDir: TEST_DIR,
    });

    const result1 = await runtime1.run({
      name: 'cache-persist',
      sessionId: 'test-session',
      phases: [
        { name: 'p1', tasks: [{ id: 'a1', systemPrompt: 'sys', task: 'test' }] },
      ],
    });

    // First run: no cache existed, agent executed fresh
    expect(result1.summary.cachedAgents).toBe(0);
    expect(result1.summary.completedAgents).toBe(1);
    expect(result1.summary.totalAgents).toBe(1);

    // Second run: new runtime, same cacheDir + same sessionId — cache file exists
    const runtime2 = new WorkflowRuntime({
      llm: mockLLM,
      defaultModel: 'test',
      cacheDir: TEST_DIR,
    });

    const result2 = await runtime2.run({
      name: 'cache-persist',
      sessionId: 'test-session',
      phases: [
        { name: 'p1', tasks: [{ id: 'a1', systemPrompt: 'sys', task: 'test' }] },
      ],
    });

    // Second run: agent was loaded from disk cache
    expect(result2.summary.cachedAgents).toBe(1);
    expect(result2.summary.completedAgents).toBe(1);
    expect(result2.summary.totalAgents).toBe(1);

    // Verify cached content is identical
    const cachedResult = result2.results.get('p1')?.get('a1');
    expect(cachedResult?.content).toBe('Echo: test');
    expect(cachedResult?.cached).toBe(true);
    expect(cachedResult?.status).toBe('success');

    // Clean up
    rmSync(TEST_DIR, { recursive: true });
  });
});
