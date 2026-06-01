import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { getDb, closeDb } from '../db/connection.js';
import { initSchema } from '../db/schema.js';
import * as repo from '../db/repository.js';
import { WorkflowRuntime } from './runtime.js';
import type { AgentRunner, AgentRunConfig } from '../runner/types.js';
import type { SSEEvent } from '@dynflow/shared';
import type { WorkflowDefinition } from '@dynflow/shared';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function sampleDefinition(): WorkflowDefinition {
  return {
    name: 'test-flow',
    phases: [
      {
        name: 'phase-1',
        agents: [
          { name: 'agent-1', prompt: 'Do first thing' },
          { name: 'agent-2', prompt: 'Do second thing' },
        ],
      },
      {
        name: 'phase-2',
        agents: [{ name: 'agent-3', prompt: 'Do final thing' }],
      },
    ],
  };
}

function onePhaseDefinition(): WorkflowDefinition {
  return {
    name: 'single-phase',
    phases: [
      {
        name: 'phase-1',
        agents: [
          { name: 'agent-a', prompt: 'Task A' },
          { name: 'agent-b', prompt: 'Task B' },
        ],
      },
    ],
  };
}

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

class MockStreamManager {
  public events: Array<{ workflowId: string; event: SSEEvent }> = [];

  emit(workflowId: string, event: SSEEvent): void {
    this.events.push({ workflowId, event });
  }

  /** For convenience: return just the event types in order */
  get eventTypes(): string[] {
    return this.events.map((e) => e.event.type);
  }
}

class MockAgentRunner implements AgentRunner {
  /** Map agentId -> result override */
  private results = new Map<
    string,
    { success: boolean; output?: string; error?: string }
  >();

  /** Callback invoked after each successful run (for pause/stop tests) */
  onAfterRun?: (agentId: string) => void;

  setResult(
    agentId: string,
    result: { success: boolean; output?: string; error?: string },
  ): void {
    this.results.set(agentId, result);
  }

  async run(
    config: AgentRunConfig,
  ): Promise<import('../runner/types.js').AgentResult> {
    const override = this.results.get(config.agentId);
    if (override && !override.success) {
      return {
        success: false,
        error: override.error ?? 'Simulated failure',
        containerId: `ctr-${config.agentId}`,
        files: [],
        fileCount: 0,
        totalSize: 0,
        outputDir: '/app/output',
      };
    }

    const output = override?.output ?? `result for ${config.agentId}`;

    // Allow the test to inject side-effects between agent executions
    this.onAfterRun?.(config.agentId);

    return {
      success: true,
      output,
      containerId: `ctr-${config.agentId}`,
      files: [],
      fileCount: 0,
      totalSize: 0,
      outputDir: '/app/output',
    };
  }

  async stop(): Promise<void> {
    // no-op
  }

  async cleanup(): Promise<void> {
    // no-op
  }
}

// ---------------------------------------------------------------------------
// Setup — fresh in-memory DB before each test
// ---------------------------------------------------------------------------

beforeEach(() => {
  closeDb();
  process.env.DB_PATH = ':memory:';
  initSchema();
});

afterAll(() => {
  closeDb();
  delete process.env.DB_PATH;
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('WorkflowRuntime', () => {
  describe('execute', () => {
    it('1 — executes 1 phase with 2 agents → completed, all events emitted', async () => {
      const run = repo.createWorkflowRun(onePhaseDefinition(), 'Test');
      const runner = new MockAgentRunner();
      const stream = new MockStreamManager();

      const runtime = new WorkflowRuntime(runner, stream);
      await runtime.execute(run.id, 'test-api-key');

      // Workflow ended completed
      const saved = repo.getWorkflowRun(run.id)!;
      expect(saved.status).toBe('completed');

      // Phase completed
      expect(saved.phases[0].status).toBe('completed');

      // Both agents completed with results
      expect(saved.phases[0].agents[0].status).toBe('completed');
      expect(saved.phases[0].agents[0].output).toBe('result for ' + saved.phases[0].agents[0].id);
      expect(saved.phases[0].agents[1].status).toBe('completed');
      expect(saved.phases[0].agents[1].output).toBe('result for ' + saved.phases[0].agents[1].id);

      // Events: workflow_started → phase_started → agent_completed × 2 → phase_completed → workflow_completed
      expect(stream.eventTypes).toContain('workflow_started');
      expect(stream.eventTypes).toContain('phase_started');
      expect(stream.eventTypes).toContain('agent_completed');
      expect(stream.eventTypes).toContain('phase_completed');
      expect(stream.eventTypes).toContain('workflow_completed');

      // Count of agent_completed events = 2
      const agentCompleted = stream.events.filter(
        (e) => e.event.type === 'agent_completed',
      );
      expect(agentCompleted).toHaveLength(2);
    });

    it('2 — executes 2 phases sequentially (phase 2 starts after phase 1)', async () => {
      const run = repo.createWorkflowRun(sampleDefinition(), 'Test');
      const runner = new MockAgentRunner();
      const stream = new MockStreamManager();

      // Track phase start order
      const phaseStartOrder: string[] = [];
      const originalGetRun = repo.getWorkflowRun.bind(repo);
      // Spy on phase_status updates to record order
      const originalUpdatePhase = repo.updatePhaseStatus.bind(repo);

      // We'll intercept after the fact — just verify events
      const runtime = new WorkflowRuntime(runner, stream);
      await runtime.execute(run.id, 'test-api-key');

      const saved = repo.getWorkflowRun(run.id)!;
      expect(saved.status).toBe('completed');
      expect(saved.phases).toHaveLength(2);
      expect(saved.phases[0].status).toBe('completed');
      expect(saved.phases[1].status).toBe('completed');

      // Verify event order: phase-1 starts before phase-2 starts
      const phaseStartedEvents = stream.events.filter(
        (e) => e.event.type === 'phase_started',
      );
      expect(phaseStartedEvents).toHaveLength(2);
      expect(phaseStartedEvents[0].event.phaseId).toBe(saved.phases[0].id);
      expect(phaseStartedEvents[1].event.phaseId).toBe(saved.phases[1].id);

      // Phase 1 completed event should come before phase 2 starts
      const phase1CompletedIdx = stream.events.findIndex(
        (e) =>
          e.event.type === 'phase_completed' &&
          e.event.phaseId === saved.phases[0].id,
      );
      const phase2StartedIdx = stream.events.findIndex(
        (e) =>
          e.event.type === 'phase_started' &&
          e.event.phaseId === saved.phases[1].id,
      );
      expect(phase1CompletedIdx).toBeLessThan(phase2StartedIdx);
    });

    it('3 — pauses mid-execution → stops before next phase', async () => {
      const run = repo.createWorkflowRun(sampleDefinition(), 'Test');
      const runner = new MockAgentRunner();
      const stream = new MockStreamManager();

      // After all phase-1 agents have been dispatched by the runner,
      // pause the workflow. We use an in-memory counter so we don't
      // depend on DB state (agents are only persisted after PhaseExecutor returns).
      const phase1AgentCount = run.phases[0].agents.length;
      let agentCallCount = 0;
      runner.onAfterRun = () => {
        agentCallCount++;
        if (agentCallCount >= phase1AgentCount) {
          repo.updateWorkflowStatus(run.id, 'paused');
        }
      };

      const runtime = new WorkflowRuntime(runner, stream);
      await runtime.execute(run.id, 'test-api-key');

      // Workflow should be paused (not completed)
      const saved = repo.getWorkflowRun(run.id)!;
      expect(saved.status).toBe('paused');

      // Phase 1 should have run, phase 2 should still be pending
      expect(saved.phases[0].status).toBe('completed');
      expect(saved.phases[1].status).toBe('pending');

      // Should NOT have a workflow_completed event
      const completedEvents = stream.events.filter(
        (e) => e.event.type === 'workflow_completed',
      );
      expect(completedEvents).toHaveLength(0);
    });

    it('4 — agent failure → phase completed_with_errors, workflow continues', async () => {
      const run = repo.createWorkflowRun(onePhaseDefinition(), 'Test');
      const runner = new MockAgentRunner();

      // Make agent-1 fail
      const agentId = run.phases[0].agents[0].id;
      runner.setResult(agentId, {
        success: false,
        error: 'Something went wrong',
      });

      const stream = new MockStreamManager();
      const runtime = new WorkflowRuntime(runner, stream);
      await runtime.execute(run.id, 'test-api-key');

      const saved = repo.getWorkflowRun(run.id)!;
      expect(saved.status).toBe('completed');

      // Phase should be completed_with_errors
      expect(saved.phases[0].status).toBe('completed_with_errors');

      // First agent failed, second succeeded
      expect(saved.phases[0].agents[0].status).toBe('failed');
      expect(saved.phases[0].agents[0].error).toBe('Something went wrong');
      expect(saved.phases[0].agents[1].status).toBe('completed');

      // Verify events
      const agentFailedEvents = stream.events.filter(
        (e) => e.event.type === 'agent_failed',
      );
      expect(agentFailedEvents).toHaveLength(1);
      expect(agentFailedEvents[0].event.agentId).toBe(agentId);

      const agentCompletedEvents = stream.events.filter(
        (e) => e.event.type === 'agent_completed',
      );
      expect(agentCompletedEvents).toHaveLength(1);
    });

    it('5 — SSE events emitted in correct order', async () => {
      const def: WorkflowDefinition = {
        name: 'ordered-events',
        phases: [
          {
            name: 'phase-A',
            agents: [{ name: 'only-agent', prompt: 'Work' }],
          },
        ],
      };
      const run = repo.createWorkflowRun(def, 'OrderTest');
      const runner = new MockAgentRunner();
      const stream = new MockStreamManager();

      const runtime = new WorkflowRuntime(runner, stream);
      await runtime.execute(run.id, 'test-api-key');

      // The expected event sequence for a single-phase run:
      // 1. workflow_started
      // 2. phase_started
      // 3. agent_completed  (1 agent)
      // 4. phase_completed
      // 5. workflow_completed
      expect(stream.eventTypes).toEqual([
        'workflow_started',
        'phase_started',
        'agent_completed',
        'phase_completed',
        'workflow_completed',
      ]);
    });

    it('6 — DB updated with agent results (output/error)', async () => {
      const run = repo.createWorkflowRun(sampleDefinition(), 'Test');
      const runner = new MockAgentRunner();

      // Phase 1: agent-1 succeeds, agent-2 fails
      const phase1Agent1 = run.phases[0].agents[0];
      const phase1Agent2 = run.phases[0].agents[1];
      runner.setResult(phase1Agent2.id, {
        success: false,
        error: 'Agent 2 error',
      });

      // Phase 2: agent-3 succeeds
      const phase2Agent = run.phases[1].agents[0];
      runner.setResult(phase2Agent.id, {
        success: true,
        output: 'Phase 2 done',
      });

      const stream = new MockStreamManager();
      const runtime = new WorkflowRuntime(runner, stream);
      await runtime.execute(run.id, 'test-api-key');

      const saved = repo.getWorkflowRun(run.id)!;

      // Phase 1 agents
      const a1 = saved.phases[0].agents[0];
      expect(a1.status).toBe('completed');
      expect(a1.output).toContain('result for');
      expect(a1.completedAt).toBeDefined();

      const a2 = saved.phases[0].agents[1];
      expect(a2.status).toBe('failed');
      expect(a2.error).toBe('Agent 2 error');
      expect(a2.completedAt).toBeDefined();

      // Phase 2 agent
      const a3 = saved.phases[1].agents[0];
      expect(a3.status).toBe('completed');
      expect(a3.output).toBe('Phase 2 done');
      expect(a3.completedAt).toBeDefined();
    });

    it('7 — phase status updated after execution', async () => {
      const run = repo.createWorkflowRun(sampleDefinition(), 'Test');
      const runner = new MockAgentRunner();
      const stream = new MockStreamManager();

      const runtime = new WorkflowRuntime(runner, stream);
      await runtime.execute(run.id, 'test-api-key');

      const saved = repo.getWorkflowRun(run.id)!;

      // Both phases should be completed
      expect(saved.phases[0].status).toBe('completed');
      expect(saved.phases[1].status).toBe('completed');

      // Phase 1 should have started_at set
      const db = getDb();
      const phase1Row = db
        .prepare('SELECT * FROM phase_runs WHERE id = ?')
        .get(saved.phases[0].id) as Record<string, unknown>;
      expect(phase1Row.started_at).toBeDefined();
      expect(phase1Row.completed_at).toBeDefined();
    });

    it('8 — workflow status updated to completed at end', async () => {
      const run = repo.createWorkflowRun(onePhaseDefinition(), 'Test');
      const runner = new MockAgentRunner();
      const stream = new MockStreamManager();

      const runtime = new WorkflowRuntime(runner, stream);
      await runtime.execute(run.id, 'test-api-key');

      const saved = repo.getWorkflowRun(run.id)!;
      expect(saved.status).toBe('completed');

      // Verify in raw DB too
      const db = getDb();
      const row = db
        .prepare('SELECT status FROM workflow_runs WHERE id = ?')
        .get(run.id) as Record<string, unknown>;
      expect(row.status).toBe('completed');
    });

    it('9 — workflow not found throws error', async () => {
      const runner = new MockAgentRunner();
      const stream = new MockStreamManager();
      const runtime = new WorkflowRuntime(runner, stream);

      await expect(
        runtime.execute('non-existent-id', 'test-key'),
      ).rejects.toThrow('Workflow not found');
    });

    it('10 — truncates large agent output (>100KB)', async () => {
      const def: WorkflowDefinition = {
        name: 'truncation-test',
        phases: [
          {
            name: 'phase-1',
            agents: [{ name: 'big-agent', prompt: 'Generate large output' }],
          },
        ],
      };
      const run = repo.createWorkflowRun(def, 'TruncationTest');
      const runner = new MockAgentRunner();

      // Create output just over 100KB
      const largeOutput = 'A'.repeat(100_050);
      const agentId = run.phases[0].agents[0].id;
      runner.setResult(agentId, { success: true, output: largeOutput });

      const stream = new MockStreamManager();
      const runtime = new WorkflowRuntime(runner, stream);
      await runtime.execute(run.id, 'test-key');

      const saved = repo.getWorkflowRun(run.id)!;
      const agent = saved.phases[0].agents[0];
      expect(agent.status).toBe('completed');
      expect(agent.output).toBeDefined();
      expect(agent.output!.length).toBeLessThanOrEqual(100_000 + '...[truncated]'.length);
      expect(agent.output).toMatch(/\.\.\.\[truncated\]$/);
    });
  });
});
