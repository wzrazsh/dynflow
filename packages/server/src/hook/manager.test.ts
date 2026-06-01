import { describe, it, expect, beforeEach } from 'vitest';
import { HookManager } from './manager.js';
import type { HookEvent, HookContext } from './manager.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** A callback that records every invocation for later assertions. */
function recorder() {
  const calls: HookContext[] = [];
  const fn = (ctx: HookContext) => {
    calls.push(ctx);
  };
  fn.calls = calls;
  return fn;
}

/** Async callback that resolves after a tick. */
function asyncRecorder() {
  const calls: HookContext[] = [];
  const fn = async (ctx: HookContext) => {
    await Promise.resolve();
    calls.push(ctx);
  };
  fn.calls = calls;
  return fn;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

let manager: HookManager;

beforeEach(() => {
  manager = new HookManager();
});

// ── register + trigger ────────────────────────────────────────────────────

describe('register + trigger', () => {
  it('1 — invokes a registered callback on trigger', async () => {
    const cb = recorder();
    manager.register('workflow_started', cb);

    await manager.trigger('workflow_started', { workflowId: 'w-1' });

    expect(cb.calls).toHaveLength(1);
    expect(cb.calls[0].workflowId).toBe('w-1');
    expect(cb.calls[0].timestamp).toBeDefined();
  });

  it('2 — passes context with all fields', async () => {
    const cb = recorder();
    manager.register('agent_completed', cb);

    const ctx = {
      workflowId: 'w-1',
      workflowName: 'Test WF',
      agentId: 'a-1',
      agentName: 'Code Reviewer',
      status: 'success',
      timestamp: '2025-01-01T00:00:00.000Z',
    };
    await manager.trigger('agent_completed', ctx);

    expect(cb.calls).toHaveLength(1);
    expect(cb.calls[0]).toMatchObject(ctx);
  });

  it('3 — auto-fills timestamp if not provided', async () => {
    const cb = recorder();
    manager.register('phase_started', cb);

    await manager.trigger('phase_started', {});

    expect(cb.calls[0].timestamp).toBeDefined();
    expect(typeof cb.calls[0].timestamp).toBe('string');
    expect(() => new Date(cb.calls[0].timestamp)).not.toThrow();
  });

  it('4 — does nothing when triggering an event with no callbacks', async () => {
    // Should not throw
    await expect(
      manager.trigger('workflow_started', {}),
    ).resolves.toBeUndefined();
  });

  it('5 — does nothing when triggering an event with empty callbacks after clear', async () => {
    const cb = recorder();
    manager.register('workflow_started', cb);
    manager.clear();

    await expect(
      manager.trigger('workflow_started', {}),
    ).resolves.toBeUndefined();

    expect(cb.calls).toHaveLength(0);
  });
});

// ── unregister ────────────────────────────────────────────────────────────

describe('unregister', () => {
  it('6 — removes a specific callback so it is no longer invoked', async () => {
    const cb = recorder();
    manager.register('workflow_failed', cb);

    const removed = manager.unregister('workflow_failed', cb);
    expect(removed).toBe(true);

    await manager.trigger('workflow_failed', { error: 'oh no' });
    expect(cb.calls).toHaveLength(0);
  });

  it('7 — returns false when callback was not registered', () => {
    const cb = recorder();
    const removed = manager.unregister('workflow_failed', cb);
    expect(removed).toBe(false);
  });

  it('8 — returns false for non-existent event type', () => {
    const cb = recorder();
    const removed = manager.unregister('agent_completed' as HookEvent, cb);
    expect(removed).toBe(false);
  });

  it('9 — only removes the specific callback, others remain', async () => {
    const cbA = recorder();
    const cbB = recorder();
    manager.register('phase_completed', cbA);
    manager.register('phase_completed', cbB);

    manager.unregister('phase_completed', cbA);

    await manager.trigger('phase_completed', { phaseId: 'p-1' });

    expect(cbA.calls).toHaveLength(0);
    expect(cbB.calls).toHaveLength(1);
  });
});

// ── multiple callbacks for same event ─────────────────────────────────────

describe('multiple callbacks for same event', () => {
  it('10 — invokes all registered callbacks', async () => {
    const cbA = recorder();
    const cbB = recorder();
    const cbC = recorder();

    manager.register('workflow_started', cbA);
    manager.register('workflow_started', cbB);
    manager.register('workflow_started', cbC);

    await manager.trigger('workflow_started', { workflowId: 'w-1' });

    expect(cbA.calls).toHaveLength(1);
    expect(cbB.calls).toHaveLength(1);
    expect(cbC.calls).toHaveLength(1);
  });

  it('11 — each callback receives the same context', async () => {
    const cbA = recorder();
    const cbB = recorder();

    manager.register('workflow_started', cbA);
    manager.register('workflow_started', cbB);

    await manager.trigger('workflow_started', { workflowId: 'shared' });

    expect(cbA.calls[0].workflowId).toBe('shared');
    expect(cbB.calls[0].workflowId).toBe('shared');
  });
});

// ── multiple events ───────────────────────────────────────────────────────

describe('multiple events', () => {
  it('12 — events are isolated from each other', async () => {
    const started = recorder();
    const completed = recorder();

    manager.register('workflow_started', started);
    manager.register('workflow_completed', completed);

    await manager.trigger('workflow_started', { workflowId: 'w-1' });
    await manager.trigger('workflow_completed', { workflowId: 'w-1' });

    expect(started.calls).toHaveLength(1);
    expect(completed.calls).toHaveLength(1);
  });

  it('13 — triggering one event does not fire other events', async () => {
    const cb = recorder();
    manager.register('phase_failed', cb);

    await manager.trigger('phase_completed', { phaseId: 'p-1' });

    expect(cb.calls).toHaveLength(0);
  });

  it('14 — can register the same callback for multiple events', async () => {
    const cb = recorder();

    manager.register('agent_started', cb);
    manager.register('agent_completed', cb);

    await manager.trigger('agent_started', { agentId: 'a-1' });
    await manager.trigger('agent_completed', { agentId: 'a-1' });

    expect(cb.calls).toHaveLength(2);
  });
});

// ── async callbacks ───────────────────────────────────────────────────────

describe('async callbacks', () => {
  it('15 — awaits async callbacks', async () => {
    const cb = asyncRecorder();
    manager.register('phase_started', cb);

    await manager.trigger('phase_started', { phaseId: 'p-1' });

    expect(cb.calls).toHaveLength(1);
  });

  it('16 — mixed sync and async callbacks all execute', async () => {
    const syncCb = recorder();
    const asyncCb = asyncRecorder();

    manager.register('agent_completed', syncCb);
    manager.register('agent_completed', asyncCb);

    await manager.trigger('agent_completed', { agentId: 'a-1' });

    expect(syncCb.calls).toHaveLength(1);
    expect(asyncCb.calls).toHaveLength(1);
  });
});

// ── error isolation ───────────────────────────────────────────────────────

describe('error isolation', () => {
  it('17 — a failing callback does not prevent others from running', async () => {
    const good = recorder();
    const bad = () => {
      throw new Error('callback error');
    };

    manager.register('workflow_started', good);
    manager.register('workflow_started', bad);

    // trigger should reject because at least one callback failed
    await expect(
      manager.trigger('workflow_started', {}),
    ).rejects.toThrow('callback error');

    // The good callback should still have been called
    expect(good.calls).toHaveLength(1);
  });

  it('18 — async rejection does not prevent others', async () => {
    const good = recorder();
    const bad = async () => {
      throw new Error('async error');
    };

    manager.register('workflow_started', good);
    manager.register('workflow_started', bad);

    await expect(
      manager.trigger('workflow_started', {}),
    ).rejects.toThrow('async error');

    expect(good.calls).toHaveLength(1);
  });

  it('19 — only the first rejection is thrown when multiple callbacks fail', async () => {
    const errA = new Error('error A');
    const errB = new Error('error B');

    manager.register('workflow_started', () => {
      throw errA;
    });
    manager.register('workflow_started', () => {
      throw errB;
    });

    await expect(
      manager.trigger('workflow_started', {}),
    ).rejects.toThrow('error A');
  });

  it('20 — continues even when every callback fails', async () => {
    manager.register('workflow_started', () => {
      throw new Error('fail 1');
    });
    manager.register('workflow_started', () => {
      throw new Error('fail 2');
    });

    await expect(
      manager.trigger('workflow_started', {}),
    ).rejects.toThrow(); // at least one error
  });
});

// ── clear ─────────────────────────────────────────────────────────────────

describe('clear', () => {
  it('21 — removes all callbacks across all events', async () => {
    const cb = recorder();
    manager.register('workflow_started', cb);
    manager.register('phase_completed', cb);
    manager.register('agent_failed', cb);

    manager.clear();

    expect(manager.getRegisteredEvents()).toHaveLength(0);
    expect(manager.getCallbacks('workflow_started')).toHaveLength(0);
    expect(manager.getCallbacks('phase_completed')).toHaveLength(0);
    expect(manager.getCallbacks('agent_failed')).toHaveLength(0);
  });

  it('22 — after clear, previously registered callbacks are not invoked', async () => {
    const cb = recorder();
    manager.register('workflow_started', cb);
    manager.clear();

    await manager.trigger('workflow_started', {});
    expect(cb.calls).toHaveLength(0);
  });
});

// ── introspection ─────────────────────────────────────────────────────────

describe('getRegisteredEvents', () => {
  it('23 — returns empty array when nothing is registered', () => {
    expect(manager.getRegisteredEvents()).toEqual([]);
  });

  it('24 — returns only events that have callbacks', () => {
    const cb = recorder();
    manager.register('agent_started', cb);
    manager.register('agent_failed', cb);

    const events = manager.getRegisteredEvents();
    expect(events).toHaveLength(2);
    expect(events).toContain('agent_started');
    expect(events).toContain('agent_failed');
    expect(events).not.toContain('workflow_started');
  });
});

describe('getCallbacks', () => {
  it('25 — returns a copy of callbacks for an event', () => {
    const cb = recorder();
    manager.register('phase_started', cb);

    const callbacks = manager.getCallbacks('phase_started');
    expect(callbacks).toHaveLength(1);
    expect(callbacks[0]).toBe(cb);
  });

  it('26 — returns empty array when no callbacks for event', () => {
    expect(manager.getCallbacks('workflow_completed')).toEqual([]);
  });

  it('27 — returned array is a copy (mutating it does not affect manager)', () => {
    const cb = recorder();
    manager.register('agent_completed', cb);

    const callbacks = manager.getCallbacks('agent_completed');
    callbacks.length = 0; // clear the copy

    expect(manager.getCallbacks('agent_completed')).toHaveLength(1);
  });
});

// ── all known events ──────────────────────────────────────────────────────

describe('all event types', () => {
  const ALL_EVENTS: HookEvent[] = [
    'workflow_started',
    'workflow_completed',
    'workflow_failed',
    'phase_started',
    'phase_completed',
    'phase_failed',
    'agent_started',
    'agent_completed',
    'agent_failed',
    'orchestration_started',
    'orchestration_completed',
  ];

  it.each(ALL_EVENTS)('28 — can register and trigger %s', async (event) => {
    const cb = recorder();
    manager.register(event, cb);
    await manager.trigger(event, {});
    expect(cb.calls).toHaveLength(1);
  });

  it('29 — custom extra fields in context are preserved', async () => {
    const cb = recorder();
    manager.register('workflow_started', cb);

    await manager.trigger('workflow_started', {
      customField: 'custom-value',
      nested: { key: 42 },
    } as Partial<HookContext>);

    expect(cb.calls[0].customField).toBe('custom-value');
    expect((cb.calls[0].nested as { key: number }).key).toBe(42);
  });
});
