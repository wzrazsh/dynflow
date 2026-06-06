import { getSkillsBySource } from './registry.js';
import { getSkill } from '../db/repository.js';
import type { Skill, SkillCategory } from '@dynflow/shared';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * Standardised result returned by every skill execution.
 */
export interface SkillResult {
  /** Whether the execution completed without errors */
  success: boolean;
  /** The output produced by the skill (if any) */
  output?: unknown;
  /** Error message when success is false */
  error?: string;
  /** Wall-clock execution time in milliseconds */
  executionTimeMs?: number;
}

// ---------------------------------------------------------------------------
// Executor
// ---------------------------------------------------------------------------

/**
 * Executes skills by looking them up in the registry, validating inputs,
 * and dispatching to the appropriate handler per category.
 */
export class SkillExecutor {
  /**
   * Execute a skill by its unique ID.
   *
   * @param skillId – the skill's UUID
   * @param input   – key-value map of parameters
   */
  async execute(
    skillId: string,
    input: Record<string, unknown>,
  ): Promise<SkillResult> {
    const startTime = Date.now();

    // 1. Look up the skill ---------------------------------------------------
    const skill = getSkill(skillId);
    if (!skill) {
      return {
        success: false,
        error: `Skill not found: ${skillId}`,
        executionTimeMs: Date.now() - startTime,
      };
    }

    return this.executeSkill(skill, input, startTime);
  }

  /**
   * Execute a skill by its source ID and name.
   *
   * @param sourceId  – the agent source the skill belongs to
   * @param skillName – the human-readable skill name
   * @param input     – key-value map of parameters
   */
  async executeByName(
    sourceId: string,
    skillName: string,
    input: Record<string, unknown>,
  ): Promise<SkillResult> {
    const startTime = Date.now();

    const skills = getSkillsBySource(sourceId);
    const skill = skills.find((s) => s.name === skillName);
    if (!skill) {
      return {
        success: false,
        error: `Skill "${skillName}" not found for source "${sourceId}"`,
        executionTimeMs: Date.now() - startTime,
      };
    }

    return this.executeSkill(skill, input, startTime);
  }

  // ---------------------------------------------------------------------------
  // Internal
  // ---------------------------------------------------------------------------

  /**
   * Shared execution pipeline: validate → dispatch → wrap result.
   */
  private async executeSkill(
    skill: Skill,
    input: Record<string, unknown>,
    startTime: number,
  ): Promise<SkillResult> {
    // 2. Validate required parameters ----------------------------------------
    const validationError = this.validateInput(skill, input);
    if (validationError) {
      return {
        success: false,
        error: validationError,
        executionTimeMs: Date.now() - startTime,
      };
    }

    // 3. Dispatch to category handler ----------------------------------------
    try {
      const output = await this.dispatchByCategory(skill, input);
      return {
        success: true,
        output,
        executionTimeMs: Date.now() - startTime,
      };
    } catch (err: unknown) {
      return {
        success: false,
        error: err instanceof Error ? err.message : String(err),
        executionTimeMs: Date.now() - startTime,
      };
    }
  }

  /**
   * Validate that all required parameters are present in the input.
   * Returns an error message string or `null` when valid.
   */
  private validateInput(
    skill: Skill,
    input: Record<string, unknown>,
  ): string | null {
    for (const param of skill.parameters) {
      if (
        param.required &&
        (input[param.name] === undefined || input[param.name] === null)
      ) {
        return `Missing required parameter: ${param.name}`;
      }
    }
    return null;
  }

  /**
   * Route execution to the handler matching the skill's category.
   */
  private async dispatchByCategory(
    skill: Skill,
    input: Record<string, unknown>,
  ): Promise<unknown> {
    const handlers: Record<SkillCategory, (s: Skill, i: Record<string, unknown>) => Promise<unknown>> = {
      analysis: this.executeAnalysis,
      research: this.executeResearch,
      development: this.executeDevelopment,
      communication: this.executeCommunication,
      automation: this.executeAutomation,
      creative: this.executeCreative,
      other: this.executeOther,
    };

    const handler = handlers[skill.category] ?? this.executeOther;
    return handler.call(this, skill, input);
  }

  // --------------------------------------------------------------------------
  // Category handlers
  // --------------------------------------------------------------------------

  /**
   * **analysis** – performs a structured analysis of the input data.
   * This is the only handler with genuinely non-trivial logic.
   */
  private async executeAnalysis(
    skill: Skill,
    input: Record<string, unknown>,
  ): Promise<unknown> {
    const analyzed: Record<string, { value: unknown; type: string; analyzed: true }> = {};
    for (const [key, value] of Object.entries(input)) {
      analyzed[key] = { value, type: typeof value, analyzed: true };
    }
    return {
      analysis: analyzed,
      skillName: skill.name,
      category: 'analysis',
    };
  }

  /**
   * **research** – placeholder for web-based research skills.
   */
  private async executeResearch(
    skill: Skill,
    input: Record<string, unknown>,
  ): Promise<unknown> {
    return {
      message: 'Research skill executed (placeholder)',
      skillName: skill.name,
      query: input.query ?? input.q ?? 'unknown',
      results: [],
      category: 'research',
    };
  }

  /**
   * **development** – placeholder for code-generation or dev-task skills.
   */
  private async executeDevelopment(
    skill: Skill,
    _input: Record<string, unknown>,
  ): Promise<unknown> {
    return {
      message: 'Development skill executed (placeholder)',
      skillName: skill.name,
      category: 'development',
    };
  }

  /**
   * **communication** – placeholder for output-formatting skills.
   */
  private async executeCommunication(
    skill: Skill,
    _input: Record<string, unknown>,
  ): Promise<unknown> {
    return {
      message: 'Communication skill executed (placeholder)',
      skillName: skill.name,
      category: 'communication',
    };
  }

  /**
   * **automation** – placeholder for automation-task skills.
   */
  private async executeAutomation(
    skill: Skill,
    _input: Record<string, unknown>,
  ): Promise<unknown> {
    return {
      message: 'Automation skill executed (placeholder)',
      skillName: skill.name,
      category: 'automation',
    };
  }

  /**
   * **creative** – placeholder for content-generation skills.
   */
  private async executeCreative(
    skill: Skill,
    _input: Record<string, unknown>,
  ): Promise<unknown> {
    return {
      message: 'Creative skill executed (placeholder)',
      skillName: skill.name,
      category: 'creative',
    };
  }

  /**
   * **other** – generic fallback for uncategorised skills.
   */
  private async executeOther(
    skill: Skill,
    input: Record<string, unknown>,
  ): Promise<unknown> {
    return {
      message: 'Generic skill executed (placeholder)',
      skillName: skill.name,
      category: 'other',
      input,
    };
  }
}
