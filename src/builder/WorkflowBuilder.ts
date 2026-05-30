import type { PhaseDefinition, TaskDefinition, TaskResolver, WorkflowDefinition } from '../types/workflow.js';
import { ConfigurationError } from '../errors.js';

/**
 * Builder for creating phase definitions.
 * Supports chaining multiple tasks, then returning to WorkflowBuilder via .phase().
 */
export class PhaseBuilder {
  private tasks: TaskDefinition[] = [];

  constructor(
    private name: string,
    private concurrency: number | undefined,
    private parent: WorkflowBuilder
  ) {
    if (!name || name.trim().length === 0) {
      throw new ConfigurationError('Phase name is required');
    }
    if (concurrency !== undefined) {
      if (typeof concurrency !== 'number' || !Number.isInteger(concurrency) || concurrency <= 0) {
        throw new ConfigurationError(`Phase concurrency must be a positive integer, got: ${concurrency}`);
      }
    }
  }

  /**
   * Add a task to this phase. Returns this PhaseBuilder for chaining more tasks.
   */
  task(id: string, config: {
    systemPrompt: string;
    task: string | TaskResolver;
    model?: string;
    temperature?: number;
    maxTokens?: number;
    skillName?: string;
    fallbackPrompt?: string;
  }): this {
    if (!id || id.trim().length === 0) {
      throw new ConfigurationError('Task id is required');
    }
    if (!config.systemPrompt || config.systemPrompt.trim().length === 0) {
      throw new ConfigurationError('Task systemPrompt is required');
    }
    if (config.task === undefined || config.task === null || (typeof config.task === 'string' && config.task.trim().length === 0)) {
      throw new ConfigurationError('Task must be a non-empty string or a function');
    }
    if (this.tasks.find(t => t.id === id)) {
      throw new ConfigurationError(`Duplicate task id "${id}" in phase "${this.name}"`);
    }
    this.tasks.push({
      id,
      systemPrompt: config.systemPrompt,
      task: config.task,
      model: config.model,
      temperature: config.temperature,
      maxTokens: config.maxTokens,
      skillName: config.skillName,
      fallbackPrompt: config.fallbackPrompt,
    });
    return this;
  }

  /**
   * Start a new phase. Returns the parent WorkflowBuilder.
   */
  phase(name: string, config?: { concurrency?: number }): PhaseBuilder {
    return this.parent.phase(name, config);
  }

  /**
   * Build the complete workflow definition.
   * Can be called on any PhaseBuilder — delegates to the parent WorkflowBuilder.
   */
  build(): WorkflowDefinition {
    return this.parent.build();
  }

  buildPhase(): PhaseDefinition {
    if (this.tasks.length === 0) {
      throw new ConfigurationError(`Phase "${this.name}" has no tasks`);
    }
    return {
      name: this.name,
      concurrency: this.concurrency,
      tasks: this.tasks,
    };
  }
}

/**
 * Fluent builder for creating workflow definitions.
 */
export class WorkflowBuilder {
  private _name: string;
  private defaultConcurrency?: number;
  private sessionId?: string;
  private phases: PhaseBuilder[] = [];

  constructor(name: string) {
    if (!name || name.trim().length === 0) {
      throw new ConfigurationError('Workflow name is required');
    }
    this._name = name;
  }

  /**
   * Set default concurrency for all phases.
   */
  concurrency(n: number): this {
    if (typeof n !== 'number' || !Number.isInteger(n) || n <= 0) {
      throw new ConfigurationError(`Concurrency must be a positive integer, got: ${n}`);
    }
    this.defaultConcurrency = n;
    return this;
  }

  /**
   * Set a session ID for resume capability.
   */
  session(id: string): this {
    this.sessionId = id;
    return this;
  }

  /**
   * Add a phase to the workflow. Returns a PhaseBuilder for chaining tasks.
   */
  phase(name: string, config?: { concurrency?: number }): PhaseBuilder {
    if (!name || name.trim().length === 0) {
      throw new ConfigurationError('Phase name is required');
    }
    const pb = new PhaseBuilder(name, config?.concurrency, this);
    this.phases.push(pb);
    return pb;
  }

  build(): WorkflowDefinition {
    if (this.phases.length === 0) {
      throw new ConfigurationError('Workflow must have at least one phase');
    }
    if (this.defaultConcurrency !== undefined) {
      if (typeof this.defaultConcurrency !== 'number' || !Number.isInteger(this.defaultConcurrency) || this.defaultConcurrency <= 0) {
        throw new ConfigurationError(`Concurrency must be a positive integer, got: ${this.defaultConcurrency}`);
      }
    }
    return {
      name: this._name,
      defaultConcurrency: this.defaultConcurrency,
      sessionId: this.sessionId,
      phases: this.phases.map(p => p.buildPhase()),
    };
  }
}
