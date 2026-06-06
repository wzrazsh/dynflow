/**
 * Workflow Generator — converts orchestrator output into a validated
 * {@link WorkflowDefinition}.
 *
 * The generator bridges the orchestrator (which produces a high-level design)
 * and the runtime (which executes phases sequentially). It validates agentId
 * references against an optional registry, resolves fallback prompts, and
 * ensures the final output conforms to the {@link WorkflowDefinition} schema.
 *
 * @module generator
 */

import type { WorkflowDefinition, PhaseDefinition, AgentDefinition } from '@dynflow/shared';
import { validateWorkflowDefinition } from '@dynflow/shared';

// ---------------------------------------------------------------------------
// Input types (orchestrator output)
// ---------------------------------------------------------------------------

export interface OrchestratorWorkflowInput {
  name: string;
  phases: OrchestratorPhaseInput[];
}

export interface OrchestratorPhaseInput {
  name: string;
  agents: OrchestratorAgentInput[];
  maxConcurrency?: number;
}

export interface OrchestratorAgentInput {
  name: string;
  prompt?: string;
  agentId?: string;
  model?: string;
  timeoutMs?: number;
}

// ---------------------------------------------------------------------------
// Agent registry interface
// ---------------------------------------------------------------------------

/**
 * Minimal interface for looking up predefined agents by ID.
 *
 * The caller provides a registry conforming to this interface (e.g. wrapping
 * `repo.getPredefinedAgent`). When no registry is provided, agentId
 * references cannot be validated and will produce warnings.
 */
export interface AgentRegistry {
  getPredefinedAgent(id: string): { id: string; name: string; systemPrompt: string } | undefined;
}

// ---------------------------------------------------------------------------
// Result type
// ---------------------------------------------------------------------------

export interface GenerateWorkflowResult {
  /** The generated workflow definition (may be invalid if fatal warnings exist). */
  workflow: WorkflowDefinition;
  /** Non-fatal warnings collected during generation (e.g. unresolvable agentId with fallback). */
  warnings?: string[];
}

// ---------------------------------------------------------------------------
// Generator
// ---------------------------------------------------------------------------

/**
 * Convert orchestrator output into a validated {@link WorkflowDefinition}.
 *
 * Validation steps:
 * 1. For each agent with an `agentId`, look it up in the optional registry.
 * 2. If `agentId` is not found but a `prompt` fallback exists → warning.
 * 3. If `agentId` is not found and no `prompt` → fatal warning (zod will also fail).
 * 4. If `agentId` is found and `prompt` exists → use prompt as override.
 * 5. If only `prompt` → dynamic agent (no registry lookup).
 * 6. Final output is validated against the shared `validateWorkflowDefinition()`.
 *
 * @param input  – The orchestrator output to convert.
 * @param options – Optional registry for agentId resolution.
 * @returns The generated workflow and any warnings.
 */
export function generateWorkflow(
  input: OrchestratorWorkflowInput,
  options?: { registry?: AgentRegistry },
): GenerateWorkflowResult {
  const warnings: string[] = [];

  // -----------------------------------------------------------------------
  // Convert phases
  // -----------------------------------------------------------------------
  const phases: PhaseDefinition[] = [];

  for (const phaseInput of input.phases) {
    const agents: AgentDefinition[] = [];

    for (const agentInput of phaseInput.agents) {
      // -------------------------------------------------------------------
      // Resolve agentId (if present)
      // -------------------------------------------------------------------
      const effectivePrompt = agentInput.prompt;
      let useAgentId = !!agentInput.agentId;

      if (agentInput.agentId) {
        if (options?.registry) {
          const predefined = options.registry.getPredefinedAgent(agentInput.agentId);
          if (!predefined) {
            // agentId not found in registry
            if (agentInput.prompt) {
              // Recoverable — fall back to inline prompt (strip invalid agentId)
              useAgentId = false;
              warnings.push(
                `Agent "${agentInput.name}": agentId "${agentInput.agentId}" not found in registry. ` +
                  `Falling back to provided prompt.`,
              );
            } else {
              // Fatal — no prompt fallback and agentId cannot be resolved.
              // Strip the agentId so the zod schema catches the missing prompt
              // (superRefine requires at least one of prompt or agentId).
              useAgentId = false;
              warnings.push(
                `Agent "${agentInput.name}": agentId "${agentInput.agentId}" not found in registry ` +
                  `and no fallback prompt provided. This agent will fail schema validation.`,
              );
            }
          }
          // else: agentId is valid — keep it, effectivePrompt remains as provided
          // (prompt may be undefined, which is fine when agentId is valid)
        } else {
          // No registry provided — keep agentId but warn
          warnings.push(
            `Agent "${agentInput.name}": agentId "${agentInput.agentId}" could not be validated ` +
              `(no registry provided).`,
          );
        }
      }
      // else: dynamic agent (no agentId) — use prompt as-is

      // -------------------------------------------------------------------
      // Build AgentDefinition
      //
      // `prompt` is only set when a non-empty value is available. When the
      // agent has only a valid `agentId` (no prompt), we omit `prompt` entirely
      // — the zod schema accepts this because it requires `prompt` OR `agentId`,
      // not both. Setting `prompt: ''` would fail the `min(1)` check.
      //
      // If the agentId could not be resolved in the registry and there is no
      // fallback prompt, we also strip the agentId from the output so that zod
      // catches the missing prompt (superRefine requires at least one of them).
      // -------------------------------------------------------------------
      const agentDef: AgentDefinition = {
        name: agentInput.name,
      } as AgentDefinition;

      if (effectivePrompt) {
        agentDef.prompt = effectivePrompt;
      } else if (!useAgentId) {
        // No prompt and no valid agentId — set empty string so zod catches this
        agentDef.prompt = '';
      }
      // else: has valid agentId, no prompt — omit `prompt`, zod accepts with agentId

      if (useAgentId) {
        agentDef.agentId = agentInput.agentId!;
      }
      if (agentInput.model) {
        agentDef.model = agentInput.model;
      }
      if (agentInput.timeoutMs !== undefined) {
        agentDef.timeoutMs = agentInput.timeoutMs;
      }

      agents.push(agentDef);
    }

    const phaseDef: PhaseDefinition = {
      name: phaseInput.name,
      agents,
    };

    if (phaseInput.maxConcurrency !== undefined) {
      phaseDef.maxConcurrency = phaseInput.maxConcurrency;
    }

    phases.push(phaseDef);
  }

  // -----------------------------------------------------------------------
  // Build WorkflowDefinition
  // -----------------------------------------------------------------------
  const workflow: WorkflowDefinition = {
    name: input.name,
    phases,
  };

  // -----------------------------------------------------------------------
  // Validate against shared schema
  // -----------------------------------------------------------------------
  const validation = validateWorkflowDefinition(workflow);

  if (!validation.valid) {
    for (const err of validation.errors ?? []) {
      warnings.push(`Validation error [${err.code}] at ${err.path}: ${err.message}`);
    }
  }

  return {
    workflow,
    warnings: warnings.length > 0 ? warnings : undefined,
  };
}
