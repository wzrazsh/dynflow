import { describe, it, expect, vi } from 'vitest';
import { EventEmitter } from '../../src/events/EventEmitter.js';
import type { WorkflowEvent } from '../../src/types/events.js';

describe('EventEmitter', () => {
  it('should call handlers when events are emitted', () => {
    const emitter = new EventEmitter();
    const handler = vi.fn();

    emitter.on(handler);

    const event: WorkflowEvent = {
      type: 'workflow:start',
      workflowId: 'test',
      sessionId: 'session-1',
      timestamp: Date.now(),
      phaseCount: 1,
    };

    emitter.emit(event);

    expect(handler).toHaveBeenCalledWith(event);
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it('should support multiple handlers', () => {
    const emitter = new EventEmitter();
    const handler1 = vi.fn();
    const handler2 = vi.fn();

    emitter.on(handler1);
    emitter.on(handler2);

    emitter.emit({
      type: 'phase:start',
      phaseName: 'test',
      timestamp: Date.now(),
      taskCount: 1,
    });

    expect(handler1).toHaveBeenCalledTimes(1);
    expect(handler2).toHaveBeenCalledTimes(1);
  });

  it('should unsubscribe handlers', () => {
    const emitter = new EventEmitter();
    const handler = vi.fn();

    const unsub = emitter.on(handler);
    emitter.emit({
      type: 'agent:start',
      agentId: 'a1',
      phaseName: 'p1',
      timestamp: Date.now(),
      model: 'test',
    });

    expect(handler).toHaveBeenCalledTimes(1);

    unsub();
    emitter.emit({
      type: 'agent:start',
      agentId: 'a2',
      phaseName: 'p1',
      timestamp: Date.now(),
      model: 'test',
    });

    expect(handler).toHaveBeenCalledTimes(1);
  });

  it('should maintain event history', () => {
    const emitter = new EventEmitter();

    emitter.emit({
      type: 'workflow:start',
      workflowId: 'test',
      sessionId: 's1',
      timestamp: 1000,
      phaseCount: 2,
    });

    emitter.emit({
      type: 'phase:start',
      phaseName: 'p1',
      timestamp: 1001,
      taskCount: 1,
    });

    const history = emitter.getHistory();
    expect(history).toHaveLength(2);
    expect(history[0].type).toBe('workflow:start');
    expect(history[1].type).toBe('phase:start');
  });

  it('should wait for specific event types', async () => {
    const emitter = new EventEmitter();

    setTimeout(() => {
      emitter.emit({
        type: 'workflow:complete',
        workflowId: 'test',
        sessionId: 's1',
        timestamp: Date.now(),
        summary: {
          totalDurationMs: 100,
          totalAgents: 1,
          completedAgents: 1,
          failedAgents: 0,
          cachedAgents: 0,
          totalTokenUsage: { promptTokens: 10, completionTokens: 20, totalTokens: 30 },
          phases: [],
        },
      });
    }, 10);

    const event = await emitter.waitFor('workflow:complete');
    expect(event.type).toBe('workflow:complete');
  });

  it('should clear history', () => {
    const emitter = new EventEmitter();

    emitter.emit({
      type: 'phase:start',
      phaseName: 'p1',
      timestamp: Date.now(),
      taskCount: 1,
    });

    expect(emitter.getHistory()).toHaveLength(1);

    emitter.clearHistory();
    expect(emitter.getHistory()).toHaveLength(0);
  });
});
