import { describe, it, expect, vi } from 'vitest';
import { WorkflowRuntime } from '../../src/runtime/WorkflowRuntime.js';
import { SessionManager } from '../../src/runtime/SessionManager.js';
import { createMockLLM, createFailingMockLLM } from '../helpers/mock-llm.js';
import { mkdirSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const TEST_DIR = join(process.cwd(), '.test-sessions');

describe('Integration: Resume capability', () => {
  it('should save and load session state', async () => {
    const manager = new SessionManager(TEST_DIR);

    if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });

    const state = {
      sessionId: 'test-session',
      workflowName: 'test-workflow',
      createdAt: Date.now(),
      updatedAt: Date.now(),
      completedPhases: ['phase-1'],
      results: {
        'phase-1': {
          'task-1': {
            id: 'task-1',
            phaseName: 'phase-1',
            content: 'result',
            tokenUsage: { promptTokens: 100, completionTokens: 50, totalTokens: 150 },
            durationMs: 1000,
            status: 'success' as const,
            cached: false,
            model: 'test',
            startedAt: Date.now(),
            completedAt: Date.now(),
          },
        },
      },
      tokenTracker: {
        perAgent: {},
        perPhase: {},
        total: { promptTokens: 100, completionTokens: 50, totalTokens: 150 },
      },
    };

    await manager.save(state);
    const loaded = await manager.load('test-session');

    expect(loaded).not.toBeNull();
    expect(loaded?.sessionId).toBe('test-session');
    expect(loaded?.completedPhases).toContain('phase-1');

    // Cleanup
    rmSync(TEST_DIR, { recursive: true });
  });

  it('should list sessions', async () => {
    const manager = new SessionManager(TEST_DIR);

    if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });

    await manager.save({
      sessionId: 's1',
      workflowName: 'w1',
      createdAt: Date.now(),
      updatedAt: Date.now(),
      completedPhases: [],
      results: {},
      tokenTracker: { perAgent: {}, perPhase: {}, total: { promptTokens: 0, completionTokens: 0, totalTokens: 0 } },
    });

    const sessions = await manager.listSessions();
    expect(sessions).toContain('s1');

    rmSync(TEST_DIR, { recursive: true });
  });

  it('should skip completed phases on resume with same sessionId', async () => {
    const mockLLM = createMockLLM();
    const resumeTestDir = join(process.cwd(), '.test-resume-e2e');

    // Clean up before test
    if (existsSync(resumeTestDir)) rmSync(resumeTestDir, { recursive: true });

    // First run: execute a 2-phase workflow
    const runtime1 = new WorkflowRuntime({
      llm: mockLLM,
      defaultModel: 'test',
      cacheDir: resumeTestDir,
    });

    const result1 = await runtime1.run({
      name: 'resume-e2e',
      sessionId: 'resume-session',
      phases: [
        { name: 'phase-1', tasks: [{ id: 't1', systemPrompt: 'sys', task: 'first' }] },
        { name: 'phase-2', tasks: [{ id: 't2', systemPrompt: 'sys', task: 'second' }] },
      ],
    });

    expect(result1.summary.completedAgents).toBe(2);
    // On a fresh run, no agents should be cached via session resume
    expect(result1.summary.cachedAgents).toBe(0);

    // Second run: new runtime, same cacheDir + same sessionId + same workflow
    const runtime2 = new WorkflowRuntime({
      llm: mockLLM,
      defaultModel: 'test',
      cacheDir: resumeTestDir,
    });

    const result2 = await runtime2.run({
      name: 'resume-e2e',
      sessionId: 'resume-session',
      phases: [
        { name: 'phase-1', tasks: [{ id: 't1', systemPrompt: 'sys', task: 'first' }] },
        { name: 'phase-2', tasks: [{ id: 't2', systemPrompt: 'sys', task: 'second' }] },
      ],
    });

    // On resume, all phases are completedPhasesSet → marked cached
    expect(result2.summary.completedAgents).toBe(2);
    expect(result2.summary.cachedAgents).toBe(2);
    expect(result2.summary.totalAgents).toBe(2);

    // Verify all results are marked as cached
    for (const [phaseName, phaseResults] of result2.results) {
      for (const [agentId, agentResult] of phaseResults) {
        expect(agentResult.cached).toBe(true);
        expect(agentResult.status).toBe('success');
      }
    }

    // Clean up
    rmSync(resumeTestDir, { recursive: true });
  });
});
