import type { LLMProvider } from './types/llm.js';
import type { EventHandler } from './types/events.js';
import type { WorkflowDefinition, PhaseDefinition } from './types/workflow.js';
import { WorkflowRuntime } from './runtime/WorkflowRuntime.js';
import type { WorkflowResult } from './runtime/WorkflowRuntime.js';
import { WorkflowBuilder } from './builder/WorkflowBuilder.js';
import { ConfigurationError } from './errors.js';

/**
 * Configuration for creating a workflow via Workflow.from().
 */
export interface WorkflowConfig {
  name: string;
  phases: PhaseDefinition[];
  llm: LLMProvider;
  defaultModel?: string;
  maxConcurrency?: number;
  sessionId?: string;
  cacheDir?: string;
  onEvent?: EventHandler;
}

/**
 * Top-level entry point for creating and running workflows.
 *
 * Usage:
 * ```ts
 * // Config object
 * const wf = Workflow.from({ name: 'my-workflow', phases: [...], llm: provider });
 * await wf.run();
 *
 * // Builder
 * const wf = Workflow.define('my-workflow')
 *   .phase('research')
 *     .task('search', { systemPrompt: '...', task: '...' })
 *   .build();
 * const runtime = new WorkflowRuntime({ llm: provider, defaultModel: 'gpt-4o' });
 * await runtime.run(wf);
 * ```
 */
export class Workflow {
  private definition: WorkflowDefinition;
  private runtime: WorkflowRuntime;

  private constructor(definition: WorkflowDefinition, runtime: WorkflowRuntime) {
    this.definition = definition;
    this.runtime = runtime;
  }

  /**
   * Start building a workflow with the fluent API.
   */
  static define(name: string): WorkflowBuilder {
    return new WorkflowBuilder(name);
  }

  /**
   * Create a workflow from a configuration object.
   */
  static from(config: WorkflowConfig): Workflow {
    if (!config.name || config.name.trim().length === 0) {
      throw new ConfigurationError('Workflow name is required');
    }
    if (!config.phases || config.phases.length === 0) {
      throw new ConfigurationError('Workflow must have at least one phase');
    }
    if (!config.llm) {
      throw new ConfigurationError('LLM provider is required');
    }
    if (config.maxConcurrency !== undefined) {
      if (typeof config.maxConcurrency !== 'number' || !Number.isInteger(config.maxConcurrency) || config.maxConcurrency <= 0) {
        throw new ConfigurationError(`maxConcurrency must be a positive integer, got: ${config.maxConcurrency}`);
      }
    }

    for (const phase of config.phases) {
      if (!phase.name || phase.name.trim().length === 0) {
        throw new ConfigurationError('Phase name is required');
      }
      if (phase.concurrency !== undefined) {
        if (typeof phase.concurrency !== 'number' || !Number.isInteger(phase.concurrency) || phase.concurrency <= 0) {
          throw new ConfigurationError(`Phase concurrency must be a positive integer, got: ${phase.concurrency}`);
        }
      }
      if (!phase.tasks || phase.tasks.length === 0) {
        throw new ConfigurationError(`Phase "${phase.name}" has no tasks`);
      }
      const seenIds = new Set<string>();
      for (const task of phase.tasks) {
        if (!task.id || task.id.trim().length === 0) {
          throw new ConfigurationError('Task id is required');
        }
        if (!task.systemPrompt || task.systemPrompt.trim().length === 0) {
          throw new ConfigurationError('Task systemPrompt is required');
        }
        if (task.task === undefined || task.task === null || (typeof task.task === 'string' && task.task.trim().length === 0)) {
          throw new ConfigurationError('Task must be a non-empty string or a function');
        }
        if (seenIds.has(task.id)) {
          throw new ConfigurationError(`Duplicate task id "${task.id}" in phase "${phase.name}"`);
        }
        seenIds.add(task.id);
      }
    }

    const runtime = new WorkflowRuntime({
      llm: config.llm,
      defaultModel: config.defaultModel ?? 'gpt-4o',
      maxConcurrency: config.maxConcurrency,
      cacheDir: config.cacheDir,
      onEvent: config.onEvent,
    });

    const definition: WorkflowDefinition = {
      name: config.name,
      defaultConcurrency: config.maxConcurrency,
      sessionId: config.sessionId,
      phases: config.phases,
    };

    return new Workflow(definition, runtime);
  }

  /**
   * Execute this workflow.
   */
  async run(): Promise<WorkflowResult> {
    return this.runtime.run(this.definition);
  }

  /**
   * Subscribe to workflow events.
   */
  onEvent(handler: EventHandler): () => void {
    return this.runtime.onEvent(handler);
  }

  /**
   * Get the workflow definition.
   */
  getDefinition(): WorkflowDefinition {
    return { ...this.definition };
  }
}
