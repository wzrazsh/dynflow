import { describe, it, expect } from 'vitest';
import { TokenTracker } from '../../src/token/TokenTracker.js';
import type { AgentResult } from '../../src/types/agent.js';

function makeResult(overrides: Partial<AgentResult>): AgentResult {
  return {
    id: 'agent-1',
    phaseName: 'phase-1',
    content: 'test content',
    tokenUsage: { promptTokens: 100, completionTokens: 50, totalTokens: 150 },
    durationMs: 1000,
    status: 'success',
    cached: false,
    model: 'test-model',
    startedAt: Date.now(),
    completedAt: Date.now(),
    ...overrides,
  };
}

describe('TokenTracker', () => {
  it('should track per-agent token usage', () => {
    const tracker = new TokenTracker();

    tracker.record(makeResult({ id: 'a1', phaseName: 'p1', tokenUsage: { promptTokens: 100, completionTokens: 50, totalTokens: 150 } }));
    tracker.record(makeResult({ id: 'a2', phaseName: 'p1', tokenUsage: { promptTokens: 200, completionTokens: 100, totalTokens: 300 } }));

    const perAgent = tracker.getPerAgent();
    expect(perAgent.get('p1:a1')?.totalTokens).toBe(150);
    expect(perAgent.get('p1:a2')?.totalTokens).toBe(300);
  });

  it('should track per-phase token usage', () => {
    const tracker = new TokenTracker();

    tracker.record(makeResult({ id: 'a1', phaseName: 'p1', tokenUsage: { promptTokens: 100, completionTokens: 50, totalTokens: 150 } }));
    tracker.record(makeResult({ id: 'a2', phaseName: 'p1', tokenUsage: { promptTokens: 200, completionTokens: 100, totalTokens: 300 } }));
    tracker.record(makeResult({ id: 'a3', phaseName: 'p2', tokenUsage: { promptTokens: 50, completionTokens: 25, totalTokens: 75 } }));

    const perPhase = tracker.getPerPhase();
    expect(perPhase.get('p1')?.totalTokens).toBe(450);
    expect(perPhase.get('p2')?.totalTokens).toBe(75);
  });

  it('should track total token usage', () => {
    const tracker = new TokenTracker();

    tracker.record(makeResult({ tokenUsage: { promptTokens: 100, completionTokens: 50, totalTokens: 150 } }));
    tracker.record(makeResult({ tokenUsage: { promptTokens: 200, completionTokens: 100, totalTokens: 300 } }));

    const total = tracker.getTotal();
    expect(total.promptTokens).toBe(300);
    expect(total.completionTokens).toBe(150);
    expect(total.totalTokens).toBe(450);
  });

  it('should reset all counters', () => {
    const tracker = new TokenTracker();

    tracker.record(makeResult({ tokenUsage: { promptTokens: 100, completionTokens: 50, totalTokens: 150 } }));
    tracker.reset();

    const total = tracker.getTotal();
    expect(total.totalTokens).toBe(0);
    expect(tracker.getPerAgent().size).toBe(0);
    expect(tracker.getPerPhase().size).toBe(0);
  });
});
