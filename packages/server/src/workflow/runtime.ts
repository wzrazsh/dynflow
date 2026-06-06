import type { AgentRunner } from '../runner/types.js';
import type { ProjectService } from '../project/project-service.js';
import { PhaseExecutor } from './phase-executor.js';
import { PiDirectRunner } from '../runner/pi-direct-runner.js';
import { PiCuaNativeRunner } from '../runner/pi-cua-native-runner.js';
import { CuaPiRunner } from '../runner/cua-pi-runner.js';
import type { RuntimeConfig, SSEEvent } from '@dynflow/shared';
import * as repo from '../db/repository.js';
import * as sseFactory from '../sse/event-factory.js';
import { logger } from '../logger.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Maximum output size before truncation (100 KB). */
const MAX_OUTPUT_SIZE = 100_000;
const TRUNCATION_SUFFIX = '...[truncated]';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface WorkflowExecuteOptions {
  /** Optional project name for output directory management. */
  projectName?: string;
  /** Version number within the project (paired with projectName). */
  version?: number;
  /** Output directory for agent file artifacts. */
  outputDir?: string;
}

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
    private projectService?: ProjectService,
    private runtimeConfig?: RuntimeConfig,
  ) {}

  abort(): void {
    this.aborted = true;
    // Forward abort to the runner so any host-privileged child processes
    // (e.g., PiDirectRunner's `pi` process) are terminated. Without this,
    // the workflow's stopped status is recorded in the DB, but the local
    // `pi` process continues modifying the host filesystem until its own
    // timeout — a real safety concern for `pi-direct` because the runner
    // runs on the host without a container boundary.
    //
    // IMPORTANT: we only forward abort to the runner if its `cleanup()`
    // is per-instance safe. `DockerAgentRunner.cleanup()` and
    // `CuaAgentRunner.cleanup()` both do label-based removal of ALL
    // `dynflow` containers globally, which would kill containers belonging
    // to other active workflows. We detect that case by checking whether
    // the constructor is `PiDirectRunner`, `PiCuaNativeRunner`, or
    // `CuaPiRunner` (all iterate their own per-instance processRegistry /
    // AbortController map). For Docker/Cua we still rely on the natural
    // phase boundary to stop new agents from launching — the existing
    // in-flight container will complete on its own.
    //
    // We do this in a fire-and-forget manner because cleanup() is async
    // and the abort path is synchronous.
    if (
      this.runner instanceof PiDirectRunner ||
      this.runner instanceof PiCuaNativeRunner ||
      this.runner instanceof CuaPiRunner
    ) {
      void this.runner.cleanup().catch((err) => {
        logger.warn('runner cleanup during abort failed:', String(err));
      });
    } else {
      logger.info(
        'abort: runner is containerized; relying on phase boundary to stop new agents',
      );
    }
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
   * - When project context is provided, updates version meta via ProjectService
   *
   * @param workflowRunId – ID of the workflow run to execute
   * @param apiKey  – API key forwarded to the AgentRunner
   * @param executeOpts   – Optional project/version/output-dir context
   */
  async execute(
    workflowRunId: string,
    apiKey: string,
    executeOpts?: WorkflowExecuteOptions,
  ): Promise<void> {
    // 1. Load workflow from DB
    const workflowRun = repo.getWorkflowRun(workflowRunId);
    if (!workflowRun) throw new Error('Workflow not found');

    // Resolve runtime config: run override wins, then constructor arg, then env-var defaults
    const resolvedRuntimeConfig: RuntimeConfig | undefined =
      workflowRun.runtimeConfig ?? this.runtimeConfig;

    const { projectName, version, outputDir: legacyOutputDir } = executeOpts ?? {};

    // 1a. Resolve the shared workspace path. If the workflow's definition
    // includes a workspace, its host path is stored on the workflow run
    // (set when the run was created in the API layer). Otherwise fall back
    // to the legacy `outputDir` (from project/version) for backward compat.
    const workspacePath = workflowRun.workspacePath ?? legacyOutputDir ?? '';

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
        // _allPhasesSuccessful tracking removed (variable was unused)
        continue;
      }

      // Check if aborted/paused/stopped (after resume the status will be
      // 'running', so this will only trigger if paused/stopped again)
      if (this.aborted) {
        repo.updateWorkflowStatus(workflowRunId, 'stopped');
        await this.updateVersionMetaOnTerminal(
          projectName,
          version,
          'Workflow stopped',
        );
        return; // Exit early — aborted
      }

      if (currentRun.status === 'stopped') {
        await this.updateVersionMetaOnTerminal(
          projectName,
          version,
          'Workflow stopped',
        );
        return; // Exit early stopped
      }

      if (currentRun.status === 'paused') {
        return; // Exit early paused
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
      const executor = new PhaseExecutor(this.runner, 2000, resolvedRuntimeConfig);
      const agents = repo.getPhaseAgents(phase.id);
      const maxConcurrency = 16;

      const phaseResult = await executor.execute(
        agents,
        apiKey,
        maxConcurrency,
        workspacePath,
      );

      // Process agent results
      for (const agentResult of phaseResult.agentResults) {
        const agent = agents.find((a) => a.id === agentResult.agentId);
        if (!agent) continue;

        if (agentResult.status === 'completed') {
          const truncated = truncateOutput(agentResult.output);

          // Build file summary if the agent returned file info
          // Only consider file summary meaningful when there are actual file entries.
          // The runner may always set outputDir even without files; we distinguish
          // by checking for non-empty file arrays or positive counts.
          const hasFiles = (agentResult.files !== undefined && agentResult.files.length > 0)
            || (agentResult.fileCount !== undefined && agentResult.fileCount > 0)
            || (agentResult.totalSize !== undefined && agentResult.totalSize > 0);
          const fileSummary = hasFiles
            ? {
                files: agentResult.files,
                fileCount: agentResult.fileCount,
                totalSize: agentResult.totalSize,
                outputDir: agentResult.outputDir,
              }
            : undefined;

          // noVncUrl and cuaApiUrl were stored but unused downstream

          repo.updateAgentStatus(agent.id, 'completed', {
            output: truncated,
            ...(hasFiles
              ? {
                  files: agentResult.files,
                  fileCount: agentResult.fileCount,
                  totalSize: agentResult.totalSize,
                  outputDir: agentResult.outputDir,
                }
              : {}),
            ...(agentResult.noVncUrl
              ? { noVncUrl: agentResult.noVncUrl }
              : {}),
            ...(agentResult.cuaApiUrl
              ? { cuaApiUrl: agentResult.cuaApiUrl }
              : {}),
          });
          this.streamManager.emit(
            workflowRunId,
            sseFactory.createAgentCompletedEvent(
              workflowRunId,
              phase.id,
              agent.id,
              agent.name,
              truncated || '',
              fileSummary,
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
      if (phaseStatus !== 'completed') {
        // allPhasesSuccessful tracking removed (variable was unused downstream)
      }
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

      // Update version meta after each phase if project context is available
      if (this.projectService && projectName && version !== undefined) {
        try {
          await this.projectService.updateVersionStatus(
            projectName,
            version,
            phaseStatus === 'completed' ? 'completed' : 'failed',
          );
        } catch {
          // Logged but non-fatal — do not abort the workflow
        }
      }
    }

    // 4. Determine the final workflow status. If abort() was called during
    //    execution (e.g., the user clicked Stop), the workflow must end as
    //    `stopped`, not `completed`, even if all phases technically finished.
    //    This prevents the in-flight phase results from overwriting a
    //    user-requested stop.
    if (this.aborted) {
      const dbStatus = repo.getWorkflowRun(workflowRunId)?.status;
      if (dbStatus !== 'stopped') {
        repo.updateWorkflowStatus(workflowRunId, 'stopped');
      }
      // Emit a *stopped* event (not a completed event) so SSE consumers
      // don't get a misleading "completed" signal for a stopped workflow.
      this.streamManager.emit(
        workflowRunId,
        sseFactory.createWorkflowStoppedEvent(workflowRunId),
      );
      return;
    }

    // 4a. If any phase ended with errors, mark the workflow as failed so
    //     consumers (UI, SSE, etc.) can distinguish a clean completion from
    //     one with agent failures. The phases array is reloaded from the DB
    //     because in-memory phase objects still hold their original statuses.
    const finalRun = repo.getWorkflowRun(workflowRunId);
    if (finalRun) {
      const hasPhaseErrors = finalRun.phases.some(
        (p) => p.status === 'completed_with_errors' || p.status === 'failed',
      );
      if (hasPhaseErrors) {
        repo.updateWorkflowStatus(workflowRunId, 'failed');
        await this.updateVersionMetaOnTerminal(
          projectName,
          version,
          'Workflow failed due to phase errors',
        );
        this.streamManager.emit(
          workflowRunId,
          sseFactory.createWorkflowFailedEvent(workflowRunId, {
            phases: finalRun.phases.map((p) => ({
              name: p.name,
              status: p.status,
            })),
            agentResults: finalRun.phases.flatMap((p) =>
              p.agents.map((a) => ({
                agentId: a.id,
                agentName: a.name,
                phaseName: p.name,
                status: a.status,
                output: a.output,
                error: a.error,
              })),
            ),
            error: 'One or more phases completed with errors',
          }),
        );
        return;
      }
    }

    // 4b. All phases completed cleanly — mark as completed.
    repo.updateWorkflowStatus(workflowRunId, 'completed');
    this.streamManager.emit(
      workflowRunId,
      sseFactory.createWorkflowCompletedEvent(workflowRunId),
    );
  }

  private async updateVersionMetaOnTerminal(
    projectName: string | undefined,
    version: number | undefined,
    error: string,
  ): Promise<void> {
    if (!this.projectService || !projectName || version === undefined) return;

    try {
      await this.projectService.updateVersionStatus(
        projectName,
        version,
        'failed',
        error,
      );
    } catch {
      // Version metadata is best-effort and must not mask workflow termination.
    }
  }
}
