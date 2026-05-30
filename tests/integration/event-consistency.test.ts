import { describe, it, expect } from 'vitest';
import { WorkflowRuntime } from '../../src/runtime/WorkflowRuntime.js';
import { createMockLLM } from '../helpers/mock-llm.js';
import { rmSync, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import type { WorkflowEvent } from '../../src/types/events.js';

const TEST_DIR = join(process.cwd(), '.test-event-consistency');

describe('Integration: Event ordering and summary consistency', () => {
  it('should emit events in correct order and maintain consistent summary stats', async () => {
    // Clean up before test
    if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });
    mkdirSync(TEST_DIR, { recursive: true });

    const mockLLM = createMockLLM();
    const runtime = new WorkflowRuntime({
      llm: mockLLM,
      defaultModel: 'test',
      cacheDir: TEST_DIR,
    });

    // Collect all events
    const events: WorkflowEvent[] = [];
    runtime.onEvent(event => events.push(event));

    // Run a 2-phase workflow (1 task each for deterministic ordering)
    const result = await runtime.run({
      name: 'event-consistency',
      sessionId: 'event-session',
      phases: [
        { name: 'p1', tasks: [{ id: 'a1', systemPrompt: 'sys', task: 'first' }] },
        { name: 'p2', tasks: [{ id: 'a2', systemPrompt: 'sys', task: 'second' }] },
      ],
    });

    // 1. Verify event ordering is correct
    const eventTypes = events.map(e => e.type);
    expect(eventTypes).toEqual([
      'workflow:start',
      'phase:start',
      'agent:start',
      'agent:complete',
      'phase:complete',
      'phase:start',
      'agent:start',
      'agent:complete',
      'phase:complete',
      'workflow:complete',
    ]);

    // 2. Verify phase:start → agent:start → agent:complete → phase:complete within each phase
    const p1Start = events.findIndex(e => e.type === 'phase:start' && e.phaseName === 'p1');
    const p1Complete = events.findIndex(e => e.type === 'phase:complete' && e.phaseName === 'p1');
    const p2Start = events.findIndex(e => e.type === 'phase:start' && e.phaseName === 'p2');
    const p2Complete = events.findIndex(e => e.type === 'phase:complete' && e.phaseName === 'p2');

    expect(p1Start).toBeLessThan(p1Complete);
    expect(p2Start).toBeLessThan(p2Complete);
    expect(p1Complete).toBeLessThan(p2Start); // Phases are sequential

    // 3. Verify summary completedAgents matches count of successful agent:complete events
    const successfulAgentCompletes = events.filter(
      e => e.type === 'agent:complete' && e.result.status === 'success'
    ).length;
    expect(result.summary.completedAgents).toBe(successfulAgentCompletes);

    // 4. Verify summary totalTokenUsage matches runtime.getTokenUsage()
    const runtimeTokens = runtime.getTokenUsage();
    expect(result.summary.totalTokenUsage.totalTokens).toBe(runtimeTokens.totalTokens);
    expect(result.summary.totalTokenUsage.promptTokens).toBe(runtimeTokens.promptTokens);
    expect(result.summary.totalTokenUsage.completionTokens).toBe(runtimeTokens.completionTokens);

    // 5. Verify phase durationMs > 0 for each executed phase
    for (const phase of result.summary.phases) {
      expect(phase.durationMs).toBeGreaterThan(0);
    }

    // 6. Verify totalAgents = completedAgents + failedAgents
    expect(result.summary.totalAgents).toBe(
      result.summary.completedAgents + result.summary.failedAgents
    );

    // 7. Verify result.results size matches phase count
    expect(result.results.size).toBe(2);
    expect(result.summary.phases.length).toBe(2);

    // Clean up
    rmSync(TEST_DIR, { recursive: true });
  });

  it('should handle session resume with correct event flow', async () => {
    // Clean up before test
    if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });
    mkdirSync(TEST_DIR, { recursive: true });

    const mockLLM = createMockLLM();

    // First run to establish session
    const runtime1 = new WorkflowRuntime({
      llm: mockLLM,
      defaultModel: 'test',
      cacheDir: TEST_DIR,
    });

    await runtime1.run({
      name: 'resume-events',
      sessionId: 'resume-event-session',
      phases: [
        { name: 'p1', tasks: [{ id: 'a1', systemPrompt: 'sys', task: 'first run' }] },
      ],
    });

    // Second run with same session — session resume skips completed phases
    const runtime2 = new WorkflowRuntime({
      llm: mockLLM,
      defaultModel: 'test',
      cacheDir: TEST_DIR,
    });

    const resumeEvents: WorkflowEvent[] = [];
    runtime2.onEvent(event => resumeEvents.push(event));

    const result2 = await runtime2.run({
      name: 'resume-events',
      sessionId: 'resume-event-session',
      phases: [
        { name: 'p1', tasks: [{ id: 'a1', systemPrompt: 'sys', task: 'first run' }] },
      ],
    });

    // Session resume skips completed phases — only workflow events fire
    const resumeEventTypes = resumeEvents.map(e => e.type);
    expect(resumeEventTypes).toEqual([
      'workflow:start',
      'workflow:complete',
    ]);

    // Summary reflects the resumed (cached) agents
    expect(result2.summary.cachedAgents).toBe(1);
    expect(result2.summary.completedAgents).toBe(1);
    expect(result2.summary.totalAgents).toBe(1);

    // Clean up
    rmSync(TEST_DIR, { recursive: true });
  });
});
