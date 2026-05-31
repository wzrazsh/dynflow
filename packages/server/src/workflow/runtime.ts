import type { AgentRunner } from '../runner/types.js';
import { PhaseExecutor } from './phase-executor.js';
import type { SSEEvent } from '@dynflow/shared';
import * as repo from '../db/repository.js';
import * as sseFactory from '../sse/event-factory.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Maximum output size before truncation (100 KB). */
const MAX_OUTPUT_SIZE = 100_000;
const TRUNCATION_SUFFIX = '...[truncated]';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Truncate agent output if it exceeds the maximum allowed size.
 * The truncation suffix is appended as a signal that content was cut.
 */
function truncateOutput(output: string | undefined): string | undefined {
  if (!output) return output;
  if (output.length <= MAX_OUTPUT_SIZE) return output;
  return output.slice(0, MAX_OUTPUT_SIZE) + TRUNCATION_SUFFIX;
}

export class WorkflowRuntime {
  private aborted = false;

  constructor(
    private runner: AgentRunner,
    private streamManager: { emit: (workflowId: string, event: SSEEvent) => void },
  ) {}

  abort(): void {
    this.aborted = true;
  }

  /**
   * Execute a workflow run from start to finish.
   *
   * - Loads the workflow run from the database
   * - Transitions it to `running` and emits a `workflow_started` event
   * - Runs each phase sequentially, executing agents within a phase in parallel
   * - Checks for pause/stop signals between phases
   * - Updates the database with agent results, phase status, and final workflow status
   * - Emits SSE events throughout for real-time progress tracking
   *
   * @param workflowRunId – ID of the workflow run to execute
   * @param openaiApiKey  – API key forwarded to the AgentRunner
   */
  async execute(workflowRunId: string, openaiApiKey: string): Promise<void> {
    // 1. Load workflow from DB
    const workflowRun = repo.getWorkflowRun(workflowRunId);
    if (!workflowRun) throw new Error('Workflow not found');

    // 2. Transition to running
    repo.updateWorkflowStatus(workflowRunId, 'running');
    this.streamManager.emit(
      workflowRunId,
      sseFactory.createWorkflowStartedEvent(workflowRunId),
    );

    // 3. Execute phases sequentially
    for (const phase of workflowRun.phases) {
      // Reload from DB to pick up fresh statuses (phases may have been
      // completed during a previous partial run before a pause).
      const currentRun = repo.getWorkflowRun(workflowRunId);
      if (!currentRun) return;

      const latestPhase = currentRun.phases.find((p) => p.id === phase.id);

      // Skip phases that are already done from a previous partial run
      if (
        latestPhase &&
        (latestPhase.status === 'completed' ||
          latestPhase.status === 'completed_with_errors')
      ) {
        continue;
      }

      // Check if aborted/paused/stopped (after resume the status will be
      // 'running', so this will only trigger if paused/stopped again)
      if (this.aborted) {
        repo.updateWorkflowStatus(workflowRunId, 'stopped');
        return; // Exit early — aborted
      }

      if (currentRun.status === 'paused' || currentRun.status === 'stopped') {
        return; // Exit early — paused/stopped
      }

      // Update phase to running
      repo.updatePhaseStatus(phase.id, 'running');
      this.streamManager.emit(
        workflowRunId,
        sseFactory.createPhaseStartedEvent(
          workflowRunId,
          phase.id,
          phase.name,
        ),
      );

      // Execute agents in parallel
      const executor = new PhaseExecutor(this.runner);
      const agents = repo.getPhaseAgents(phase.id);
      const maxConcurrency = 16;

      const phaseResult = await executor.execute(agents, openaiApiKey, maxConcurrency);

      // Process agent results
      for (const agentResult of phaseResult.agentResults) {
        const agent = agents.find((a) => a.id === agentResult.agentId);
        if (!agent) continue;

        if (agentResult.status === 'completed') {
          repo.updateAgentStatus(agent.id, 'completed', {
            output: truncateOutput(agentResult.output),
          });
          this.streamManager.emit(
            workflowRunId,
            sseFactory.createAgentCompletedEvent(
              workflowRunId,
              phase.id,
              agent.id,
              agent.name,
              truncateOutput(agentResult.output) || '',
            ),
          );
        } else {
          repo.updateAgentStatus(agent.id, 'failed', {
            error: agentResult.error,
          });
          this.streamManager.emit(
            workflowRunId,
            sseFactory.createAgentFailedEvent(
              workflowRunId,
              phase.id,
              agent.id,
              agent.name,
              agentResult.error || '',
            ),
          );
        }
      }

      // Update phase status
      const phaseStatus =
        phaseResult.status === 'completed' ? 'completed' : 'completed_with_errors';
      repo.updatePhaseStatus(phase.id, phaseStatus);
      this.streamManager.emit(
        workflowRunId,
        sseFactory.createPhaseCompletedEvent(
          workflowRunId,
          phase.id,
          phase.name,
          phaseStatus,
        ),
      );
    }

    // 4. Mark workflow completed
    repo.updateWorkflowStatus(workflowRunId, 'completed');
    this.streamManager.emit(
      workflowRunId,
      sseFactory.createWorkflowCompletedEvent(workflowRunId),
    );
  }
}
