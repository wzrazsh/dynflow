import { describe, it, expect, vi } from 'vitest';
import { WorkflowRuntime } from '../../src/runtime/WorkflowRuntime.js';
import { createMockLLM } from '../helpers/mock-llm.js';
import type { WorkflowEvent } from '../../src/types/events.js';

describe('WorkflowRuntime', () => {
  it('should execute a simple workflow', async () => {
    const llm = createMockLLM();
    const runtime = new WorkflowRuntime({
      llm,
      defaultModel: 'test-model',
    });

    const result = await runtime.run({
      name: 'test-workflow',
      phases: [
        {
          name: 'phase-1',
          tasks: [
            { id: 'task-1', systemPrompt: 'You are a test', task: 'Hello' },
            { id: 'task-2', systemPrompt: 'You are a test', task: 'World' },
          ],
        },
      ],
    });

    expect(result.results.size).toBe(1);
    expect(result.results.get('phase-1')?.size).toBe(2);
    expect(result.summary.totalAgents).toBe(2);
    expect(result.summary.completedAgents).toBe(2);
  });

  it('should execute phases sequentially', async () => {
    const llm = createMockLLM();
    const runtime = new WorkflowRuntime({
      llm,
      defaultModel: 'test-model',
    });

    const events: WorkflowEvent[] = [];
    runtime.onEvent(event => events.push(event));

    await runtime.run({
      name: 'test-workflow',
      phases: [
        { name: 'phase-1', tasks: [{ id: 't1', systemPrompt: 'sys', task: 'task1' }] },
        { name: 'phase-2', tasks: [{ id: 't2', systemPrompt: 'sys', task: 'task2' }] },
      ],
    });

    const eventTypes = events.map(e => e.type);
    expect(eventTypes).toContain('workflow:start');
    expect(eventTypes).toContain('phase:start');
    expect(eventTypes).toContain('agent:complete');
    expect(eventTypes).toContain('phase:complete');
    expect(eventTypes).toContain('workflow:complete');

    // Phase 1 should start before phase 2
    const phase1Start = eventTypes.indexOf('phase:start');
    const phase2Start = eventTypes.lastIndexOf('phase:start');
    expect(phase1Start).toBeLessThan(phase2Start);
  });

  it('should pass context between phases', async () => {
    const llm = createMockLLM();
    const runtime = new WorkflowRuntime({
      llm,
      defaultModel: 'test-model',
    });

    const result = await runtime.run({
      name: 'context-test',
      phases: [
        { name: 'p1', tasks: [{ id: 'a1', systemPrompt: 'sys', task: 'result1' }] },
        {
          name: 'p2',
          tasks: [
            {
              id: 'a2',
              systemPrompt: 'sys',
              task: (ctx) => {
                const prev = ctx.get('p1', 'a1');
                return `Previous: ${prev?.content}`;
              },
            },
          ],
        },
      ],
    });

    const a2 = result.results.get('p2')?.get('a2');
    expect(a2?.content).toContain('Echo: Previous:');
  });

  it('should track token usage', async () => {
    const llm = createMockLLM();
    const runtime = new WorkflowRuntime({
      llm,
      defaultModel: 'test-model',
    });

    await runtime.run({
      name: 'token-test',
      phases: [
        { name: 'p1', tasks: [{ id: 'a1', systemPrompt: 'sys', task: 'test' }] },
      ],
    });

    const tokens = runtime.getTokenUsage();
    expect(tokens.totalTokens).toBeGreaterThan(0);
  });

  it('should emit events in correct order', async () => {
    const llm = createMockLLM();
    const runtime = new WorkflowRuntime({
      llm,
      defaultModel: 'test-model',
    });

    const events: string[] = [];
    runtime.onEvent(event => events.push(event.type));

    await runtime.run({
      name: 'order-test',
      phases: [
        { name: 'p1', tasks: [{ id: 'a1', systemPrompt: 'sys', task: 'test' }] },
      ],
    });

    expect(events).toEqual([
      'workflow:start',
      'phase:start',
      'agent:start',
      'agent:complete',
      'phase:complete',
      'workflow:complete',
    ]);
  });
});
