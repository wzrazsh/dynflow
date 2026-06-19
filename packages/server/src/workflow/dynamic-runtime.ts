import { createHash } from 'node:crypto';
import type { RuntimeConfig, SSEEvent, WorkflowStatus } from '@dynflow/shared';
import type { AgentRunner } from '../runner/types.js';
import {
  executeDynamicScript,
  type DynamicHostCall,
  type DynamicScriptHost,
} from './dynamic-script-engine.js';
import {
  MergeConflictError,
  WorkspaceManager,
  type FinalizedAgentWorkspace,
} from './workspace-manager.js';

export type DurableStepKind = 'phase' | 'agent' | 'checkpoint' | 'apply' | 'log';
export type DurableStepStatus =
  | 'pending'
  | 'running'
  | 'completed'
  | 'failed'
  | 'cancelled';

export interface DurableStepRecord {
  workflowRunId: string;
  stepKey: string;
  parentKey?: string;
  kind: DurableStepKind;
  sequence: number;
  status: DurableStepStatus;
  inputHash: string;
  input?: unknown;
  output?: unknown;
  attempt: number;
  error?: string;
  replayed?: boolean;
}

export interface DurableStepStore {
  getStep(workflowRunId: string, stepKey: string): DurableStepRecord | undefined;
  beginStep(input: {
    workflowRunId: string;
    stepKey: string;
    parentKey?: string;
    kind: DurableStepKind;
    sequence: number;
    inputHash: string;
    input: unknown;
  }): DurableStepRecord;
  completeStep(
    workflowRunId: string,
    stepKey: string,
    output: unknown,
    metadata?: Record<string, unknown>,
  ): void;
  failStep(workflowRunId: string, stepKey: string, error: string): void;
  getWorkflowStatus(workflowRunId: string): WorkflowStatus | undefined;
}

export interface DynamicRuntimeOptions {
  workflowRunId: string;
  script: string;
  apiKey: string;
  workspacePath: string;
  runtimeConfig?: RuntimeConfig;
  signal?: AbortSignal;
  timeoutMs?: number;
}

export class NonDeterministicReplayError extends Error {
  readonly code = 'NON_DETERMINISTIC_REPLAY';

  constructor(stepKey: string) {
    super(`NON_DETERMINISTIC_REPLAY: input changed for completed step "${stepKey}"`);
    this.name = 'NonDeterministicReplayError';
  }
}

export class WorkflowPausedError extends Error {
  constructor() {
    super('Workflow paused');
    this.name = 'WorkflowPausedError';
  }
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, item]) => [key, canonicalize(item)]),
    );
  }
  return value;
}

export function hashStepInput(value: unknown): string {
  return createHash('sha256')
    .update(JSON.stringify(canonicalize(value)))
    .digest('hex');
}

function event(
  type: SSEEvent['type'],
  workflowId: string,
  data?: Record<string, unknown>,
): SSEEvent {
  return {
    type,
    workflowId,
    timestamp: new Date().toISOString(),
    data,
  };
}

export class DynamicWorkflowRuntime implements DynamicScriptHost {
  private sequence = 0;
  private options?: DynamicRuntimeOptions;
  private readonly workspaceManager = new WorkspaceManager();
  private readonly activeWorkspaces = new Map<string, FinalizedAgentWorkspace>();

  constructor(
    private readonly runner: AgentRunner,
    private readonly store: DurableStepStore,
    private readonly streamManager: {
      emit(workflowId: string, event: SSEEvent): void;
    },
  ) {}

  async execute(options: DynamicRuntimeOptions): Promise<void> {
    this.options = options;
    this.sequence = 0;
    await executeDynamicScript(options.script, this, {
      signal: options.signal,
      timeoutMs: options.timeoutMs,
      memoryLimitMb: 128,
    });
  }

  async call(request: DynamicHostCall): Promise<unknown> {
    const options = this.requireOptions();
    this.ensureSchedulable(options);
    if (request.kind === 'phase_complete') {
      const current = this.store.getStep(options.workflowRunId, request.key);
      if (!current) {
        throw new Error(`phase_complete without phase_start for "${request.key}"`);
      }
      if (current.status !== 'completed') {
        const output = { id: request.key, status: 'completed' };
        this.store.completeStep(options.workflowRunId, request.key, output);
        this.streamManager.emit(
          options.workflowRunId,
          event('step_completed', options.workflowRunId, {
            stepKey: request.key,
            parentKey: request.parentKey,
            kind: 'phase',
            attempt: current.attempt,
            output,
          }),
        );
      }
      return { id: request.key, status: 'completed' };
    }
    const kind = this.toStepKind(request.kind);
    const stepInput = {
      kind,
      parentKey: request.parentKey,
      input: request.input,
    };
    const inputHash = hashStepInput(stepInput);
    const existing = this.store.getStep(options.workflowRunId, request.key);

    if (existing?.status === 'completed') {
      if (existing.inputHash !== inputHash) {
        throw new NonDeterministicReplayError(request.key);
      }
      this.streamManager.emit(
        options.workflowRunId,
        event('step_completed', options.workflowRunId, {
          stepKey: request.key,
          kind,
          replayed: true,
          output: existing.output,
        }),
      );
      return existing.output;
    }
    if (existing?.status === 'running') {
      throw new Error(
        `DUPLICATE_STEP_KEY: step "${request.key}" is already running`,
      );
    }
    if (existing && existing.inputHash !== inputHash) {
      throw new NonDeterministicReplayError(request.key);
    }

    const step = this.store.beginStep({
      workflowRunId: options.workflowRunId,
      stepKey: request.key,
      parentKey: request.parentKey,
      kind,
      sequence: this.sequence++,
      inputHash,
      input: request.input,
    });
    this.streamManager.emit(
      options.workflowRunId,
      event(
        step.attempt > 1 ? 'step_started' : 'step_created',
        options.workflowRunId,
        {
          stepKey: request.key,
          parentKey: request.parentKey,
          kind,
          attempt: step.attempt,
        },
      ),
    );

    if (request.kind === 'phase_start') {
      return { id: request.key, status: 'running' };
    }

    try {
      const output = await this.executeStep(request);
      const metadata =
        kind === 'agent' && output && typeof output === 'object'
          ? {
              baseCommit: Reflect.get(output, 'baseCommit'),
              resultCommit: Reflect.get(output, 'resultCommit'),
              worktree: Reflect.get(output, 'worktree'),
              files: Reflect.get(output, 'files'),
              usage: Reflect.get(output, 'usage'),
            }
          : undefined;
      this.store.completeStep(
        options.workflowRunId,
        request.key,
        output,
        metadata,
      );
      this.streamManager.emit(
        options.workflowRunId,
        event('step_completed', options.workflowRunId, {
          stepKey: request.key,
          parentKey: request.parentKey,
          kind,
          attempt: step.attempt,
          output,
        }),
      );
      return output;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.store.failStep(options.workflowRunId, request.key, message);
      this.streamManager.emit(
        options.workflowRunId,
        event(
          error instanceof MergeConflictError ? 'apply_conflict' : 'step_failed',
          options.workflowRunId,
          {
            stepKey: request.key,
            parentKey: request.parentKey,
            kind,
            attempt: step.attempt,
            error: message,
            ...(error instanceof MergeConflictError
              ? { conflictFiles: error.files }
              : {}),
          },
        ),
      );
      throw error;
    }
  }

  private async executeStep(request: DynamicHostCall): Promise<unknown> {
    switch (request.kind) {
      case 'phase_start':
        return { id: request.key, status: 'running' };
      case 'checkpoint':
        return request.input.value;
      case 'log':
        return { logged: true };
      case 'agent':
        return this.executeAgent(request);
      case 'apply':
        return this.executeApply(request);
    }
  }

  private async executeAgent(request: DynamicHostCall): Promise<unknown> {
    const options = this.requireOptions();
    const prompt = String(request.input.prompt ?? '');
    const mode = request.input.mode === 'write' ? 'write' : 'read';
    const workspace = await this.workspaceManager.prepare(
      options.workflowRunId,
      request.key,
      options.workspacePath,
      mode,
    );

    const result = await this.runner.run({
      agentId: request.key,
      prompt,
      model:
        typeof request.input.model === 'string'
          ? request.input.model
          : options.runtimeConfig?.model,
      timeoutMs:
        typeof request.input.timeoutMs === 'number'
          ? request.input.timeoutMs
          : 300_000,
      apiKey: options.apiKey,
      workspacePath: workspace.path,
      workspaceMount: '/home/cua/workspace',
      llmProvider: options.runtimeConfig?.llmProvider,
      provider: options.runtimeConfig?.llmProvider,
      signal: options.signal,
    });
    if (!result.success) {
      throw new Error(result.error || `Agent "${request.key}" failed`);
    }

    const finalized = await this.workspaceManager.finalize(workspace, request.key);
    this.activeWorkspaces.set(request.key, finalized);
    return {
      id: request.key,
      status: 'completed',
      output: result.output ?? '',
      data: null,
      files: finalized.files,
      worktree: finalized.kind === 'shared' ? undefined : finalized.path,
      baseCommit: finalized.baseCommit,
      resultCommit: finalized.resultCommit,
      usage: null,
    };
  }

  private async executeApply(request: DynamicHostCall): Promise<unknown> {
    const options = this.requireOptions();
    const result = request.input.result as
      | { id?: unknown; worktree?: unknown; baseCommit?: unknown; resultCommit?: unknown; files?: unknown }
      | undefined;
    const agentKey = typeof result?.id === 'string' ? result.id : '';
    let workspace = this.activeWorkspaces.get(agentKey);
    if (!workspace && typeof result?.worktree === 'string') {
      workspace = {
        path: result.worktree,
        kind:
          typeof result.resultCommit === 'string'
            ? 'git-worktree'
            : 'directory-copy',
        baseCommit:
          typeof result.baseCommit === 'string' ? result.baseCommit : undefined,
        resultCommit:
          typeof result.resultCommit === 'string'
            ? result.resultCommit
            : undefined,
        files: Array.isArray(result.files)
          ? result.files.filter((file): file is string => typeof file === 'string')
          : [],
      };
    }
    if (!workspace) {
      throw new Error(`apply() cannot find workspace for agent result "${agentKey}"`);
    }
    const applied = await this.workspaceManager.apply(
      options.workspacePath,
      workspace,
    );
    await this.workspaceManager.cleanup(workspace, options.workspacePath);
    this.activeWorkspaces.delete(agentKey);
    return applied;
  }

  private ensureSchedulable(options: DynamicRuntimeOptions): void {
    if (options.signal?.aborted) {
      throw new Error('Workflow stopped');
    }
    const status = this.store.getWorkflowStatus(options.workflowRunId);
    if (status === 'paused') throw new WorkflowPausedError();
    if (status === 'stopped') throw new Error('Workflow stopped');
  }

  private requireOptions(): DynamicRuntimeOptions {
    if (!this.options) throw new Error('Dynamic runtime has not been started');
    return this.options;
  }

  private toStepKind(kind: DynamicHostCall['kind']): DurableStepKind {
    if (kind === 'phase_start' || kind === 'phase_complete') return 'phase';
    return kind;
  }
}
