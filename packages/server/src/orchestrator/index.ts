/**
 * Orchestrator — the LLM-powered workflow designer.
 *
 * Receives a natural-language user request, caps all entity lists through
 * {@link CandidateSelector}, builds system + user prompts, calls an LLM via
 * the OpenAI-compatible API, validates the response against
 * {@link WorkflowDefinition}, and returns it for execution.
 *
 * @module orchestrator
 */

import type {
  Domain,
  AgentSource,
  AgentRole,
  Skill,
} from '@dynflow/shared';
import type { PredefinedAgent } from '@dynflow/shared';
import { validateWorkflowDefinition } from '@dynflow/shared';
import type { WorkflowDefinition } from '@dynflow/shared';
import { CandidateSelector } from './candidates.js';
import { buildSystemPrompt, buildUserPrompt } from './prompt.js';
import type { OrchestratorContext } from './prompt.js';

// ---------------------------------------------------------------------------
// Public interface
// ---------------------------------------------------------------------------

export interface OrchestrateOptions {
  /** Free-form user request describing the workflow to design. */
  userRequest: string;

  /** Full list of available domains (will be capped to 10). */
  domains: Domain[];

  /** Full list of available agent sources (will be capped to 10). */
  sources: AgentSource[];

  /** Full list of available agent roles (will be capped to 10). */
  roles: AgentRole[];

  /** Full list of available predefined agents (will be capped to 10). */
  agents: PredefinedAgent[];

  /** Full list of available skills (will be capped to 10). */
  skills: Skill[];

  /**
   * OpenAI API key. Defaults to `process.env.OPENCODE_API_KEY`, then
   * `process.env.OPENAI_API_KEY`.
   */
  apiKey?: string;

  /**
   * OpenAI-compatible API base URL.
   * Defaults to `process.env.OPENAI_BASE_URL` or `'https://opencode.ai/zen/v1'`.
   */
  baseUrl?: string;

  /**
   * Model identifier.
   * Defaults to `process.env.OPENCODE_MODEL` or `'gpt-4o'`.
   */
  model?: string;

  /** Optional — override the hard cap on per-category choices (default: 10). */
  maxChoicesPerCategory?: number;
}

export interface OrchestrateResult {
  /** Validated workflow definition ready for execution. */
  workflow: WorkflowDefinition;

  /** Raw JSON string returned by the LLM (for debugging / observability). */
  rawResponse: string;
}

// ---------------------------------------------------------------------------
// Defaults
// ---------------------------------------------------------------------------

const DEFAULT_BASE_URL = 'https://opencode.ai/zen/v1';
const DEFAULT_MODEL = 'gpt-4o';

/**
 * Build the effective API key by checking the option first, then env vars.
 */
function resolveApiKey(provided?: string): string {
  return (
    provided ??
    process.env.OPENCODE_API_KEY ??
    process.env.OPENAI_API_KEY ??
    ''
  );
}

/**
 * Build the effective base URL.
 */
function resolveBaseUrl(provided?: string): string {
  return provided ?? process.env.OPENAI_BASE_URL ?? DEFAULT_BASE_URL;
}

/**
 * Build the effective model name.
 */
function resolveModel(provided?: string): string {
  return provided ?? process.env.OPENCODE_MODEL ?? DEFAULT_MODEL;
}

// ---------------------------------------------------------------------------
// Error types
// ---------------------------------------------------------------------------

/**
 * Thrown when the LLM call fails (network error, non-200 status, etc.).
 */
export class OrchestratorLLMError extends Error {
  constructor(
    message: string,
    public readonly statusCode?: number,
    public readonly responseBody?: string,
  ) {
    super(message);
    this.name = 'OrchestratorLLMError';
  }
}

/**
 * Thrown when the LLM response cannot be parsed as valid JSON, or when the
 * parsed JSON does not conform to the WorkflowDefinition schema.
 */
export class OrchestratorValidationError extends Error {
  constructor(
    message: string,
    public readonly rawResponse: string,
    public readonly validationErrors?: Array<{ path: string; message: string; code: string }>,
  ) {
    super(message);
    this.name = 'OrchestratorValidationError';
  }
}

// ---------------------------------------------------------------------------
// Core function
// ---------------------------------------------------------------------------

/**
 * Design a multi-agent workflow from a natural-language request.
 *
 * 1. Caps all entity lists through {@link CandidateSelector} (max 10 each).
 * 2. Builds the system + user prompt.
 * 3. Calls the LLM via the OpenAI-compatible chat completions API.
 * 4. Parses and validates the JSON response against
 *    {@link WorkflowDefinition}.
 *
 * @returns The validated workflow and the raw LLM response.
 * @throws {OrchestratorLLMError} When the LLM call fails.
 * @throws {OrchestratorValidationError} When the response is invalid JSON or
 *   fails schema validation.
 */
export async function orchestrate(
  options: OrchestrateOptions,
): Promise<OrchestrateResult> {
  // -----------------------------------------------------------------------
  // 1. Cap candidate lists
  // -----------------------------------------------------------------------
  const selector = new CandidateSelector();
  const capped: OrchestratorContext = {
    domains: selector.selectDomains(options.domains, options.maxChoicesPerCategory),
    sources: selector.selectSources(options.sources, undefined, options.maxChoicesPerCategory),
    roles: selector.selectRoles(options.roles, undefined, options.maxChoicesPerCategory),
    agents: selector.selectAgents(options.agents, undefined, options.maxChoicesPerCategory),
    skills: selector.selectSkills(options.skills, undefined, undefined, options.maxChoicesPerCategory),
  };

  // -----------------------------------------------------------------------
  // 2. Build prompts
  // -----------------------------------------------------------------------
  const systemPrompt = buildSystemPrompt(capped);
  const userPrompt = buildUserPrompt(options.userRequest);

  // -----------------------------------------------------------------------
  // 3. Call LLM
  // -----------------------------------------------------------------------
  const apiKey = resolveApiKey(options.apiKey);
  const baseUrl = resolveBaseUrl(options.baseUrl);
  const model = resolveModel(options.model);

  if (!apiKey) {
    throw new OrchestratorLLMError(
      'No API key available. Set OPENCODE_API_KEY, OPENAI_API_KEY, or pass apiKey in options.',
    );
  }

  const url = `${baseUrl.replace(/\/$/, '')}/chat/completions`;

  let response: Response;
  try {
    response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userPrompt },
        ],
        temperature: 0.2,
      }),
    });
  } catch (err) {
    throw new OrchestratorLLMError(
      `LLM request failed: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  if (!response.ok) {
    let responseBody = '';
    try {
      responseBody = await response.text();
    } catch {
      // ignore — best-effort read
    }
    throw new OrchestratorLLMError(
      `LLM returned status ${response.status}`,
      response.status,
      responseBody,
    );
  }

  let completionBody: string;
  try {
    completionBody = await response.text();
  } catch (err) {
    throw new OrchestratorLLMError(
      `Failed to read LLM response body: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  // -----------------------------------------------------------------------
  // 4. Parse JSON response
  // -----------------------------------------------------------------------
  let parsed: unknown;
  try {
    const data = JSON.parse(completionBody);

    // OpenAI chat completions response shape:
    // { choices: [{ message: { content: "..." } }] }
    const content =
      data?.choices?.[0]?.message?.content ?? data?.content ?? data?.response ?? completionBody;

    // The content may be wrapped in markdown code fences — extract JSON
    parsed = parseJSONContent(String(content));
  } catch (err) {
    if (err instanceof OrchestratorValidationError) throw err;
    throw new OrchestratorValidationError(
      `Failed to parse LLM response as JSON: ${err instanceof Error ? err.message : String(err)}`,
      completionBody,
    );
  }

  // -----------------------------------------------------------------------
  // 5. Validate against WorkflowDefinition schema
  // -----------------------------------------------------------------------
  const validationResult = validateWorkflowDefinition(parsed);

  if (!validationResult.valid) {
    throw new OrchestratorValidationError(
      `WorkflowDefinition validation failed with ${validationResult.errors?.length ?? 0} error(s)`,
      JSON.stringify(parsed),
      validationResult.errors,
    );
  }

  return {
    workflow: parsed as WorkflowDefinition,
    rawResponse: completionBody,
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Attempt to extract a JSON object from a string that may be wrapped in
 * markdown code fences or contain surrounding text.
 *
 * Supports:
 * - ```json ... ```
 * - ``` ... ```
 * - Plain JSON (no fences)
 */
function parseJSONContent(content: string): unknown {
  const trimmed = content.trim();

  // Try extracting from markdown code blocks first
  const jsonFenceMatch = trimmed.match(/^```(?:json)?\s*\n?([\s\S]*?)```$/);
  if (jsonFenceMatch) {
    return JSON.parse(jsonFenceMatch[1].trim());
  }

  // Try parsing the trimmed string directly as JSON
  return JSON.parse(trimmed);
}

// ---------------------------------------------------------------------------
// Convenience class
// ---------------------------------------------------------------------------

/**
 * Convenience wrapper that holds a reusable {@link CandidateSelector} and
 * delegates to {@link orchestrate}.
 */
export class Orchestrator {
  private readonly selector = new CandidateSelector();

  /**
   * Design a workflow from a natural-language request.
   *
   * Identical to the standalone {@link orchestrate} function but bound to
   * this instance (useful when dependency-injecting the orchestrator).
   */
  async design(options: OrchestrateOptions): Promise<OrchestrateResult> {
    return orchestrate(options);
  }
}
