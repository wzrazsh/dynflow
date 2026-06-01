/**
 * Orchestrator system-prompt builder.
 *
 * Generates the system prompt that instructs the LLM _orchestrator_ how to
 * design a multi-agent workflow.  The prompt is composed by first passing
 * available entity lists through {@link CandidateSelector} so that every
 * LLM-facing choice list stays ≤10 items.
 *
 * The output format is JSON conforming to `WorkflowDefinition` from the
 * shared type library.
 */

import type {
  Domain,
  AgentSource,
  AgentRole,
  Skill,
} from '@dynflow/shared';
import type { PredefinedAgent } from '@dynflow/shared';
import { CandidateSelector, maxChoicesPerStep } from './candidates.js';

// ---------------------------------------------------------------------------
// Context
// ---------------------------------------------------------------------------

/**
 * All available entities that the orchestrator can reference when designing
 * a workflow.
 *
 * These lists should already have been passed through
 * {@link CandidateSelector} before being supplied to the prompt builder so
 * that no list exceeds `maxChoicesPerStep` items.
 */
export interface OrchestratorContext {
  domains: Domain[];
  sources: AgentSource[];
  roles: AgentRole[];
  agents: PredefinedAgent[];
  skills: Skill[];
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Format an array of labelled items into a compact markdown table.
 */
function formatTable<T extends { id: string; name: string; description: string }>(
  label: string,
  items: T[],
): string {
  if (items.length === 0) return '';
  const header = `### ${label}`;
  const cols = `| ID | Name | Description |`;
  const sep = `|---|---|---|`;
  const rows = items
    .map((i) => `| \`${i.id}\` | ${i.name} | ${i.description} |`)
    .join('\n');
  return `${header}\n${cols}\n${sep}\n${rows}`;
}

/**
 * Format a list of skills as a compact table.
 */
function formatSkills(items: Skill[]): string {
  if (items.length === 0) return '';
  const header = `### Available Skills`;
  const cols = `| ID | Name | Category | Description |`;
  const sep = `|---|---|---|---|`;
  const rows = items
    .map(
      (s) =>
        `| \`${s.id}\` | ${s.name} | ${s.category} | ${s.description} |`,
    )
    .join('\n');
  return `${header}\n${cols}\n${sep}\n${rows}`;
}

// ---------------------------------------------------------------------------
// Prompt builders
// ---------------------------------------------------------------------------

/**
 * Build the orchestrator's system prompt by injecting available building
 * blocks (domains, sources, roles, agents, skills) into a template.
 *
 * The caller is responsible for pre-filtering the context through
 * {@link CandidateSelector}; this function does NOT apply the cap itself.
 */
export function buildSystemPrompt(context: OrchestratorContext): string {
  const sections: string[] = [];

  // ── Role ──────────────────────────────────────────────────────────────
  sections.push(`# Role

You are a **workflow orchestrator**. Your job is to design a multi-agent workflow that fulfils the user's request as effectively as possible.

You break the user's goal into sequential **phases** and populate each phase with one or more **agents** that execute in parallel. Agents can be either **predefined** (referenced by \`agentId\` from the registry below) or **custom** (defined inline with their own prompt).`);

  // ── Available building blocks ─────────────────────────────────────────
  const blocks: string[] = [];

  if (context.domains.length > 0) {
    blocks.push(formatTable('Domains', context.domains));
  }
  if (context.sources.length > 0) {
    blocks.push(formatTable('Agent Sources', context.sources));
  }
  if (context.roles.length > 0) {
    blocks.push(formatTable('Agent Roles', context.roles));
  }
  if (context.agents.length > 0) {
    // Agents need a slightly wider table so we inline "Available Agents"
    const header = `### Available Predefined Agents`;
    const cols = `| ID | Name | Role ID | Available Skills | Description |`;
    const sep = `|---|---|---|---|---|`;
    const rows = context.agents
      .map(
        (a) =>
          `| \`${a.id}\` | ${a.name} | \`${a.roleId}\` | ${(a.availableSkills ?? []).join(', ') || '—'} | ${a.description} |`,
      )
      .join('\n');
    blocks.push(`${header}\n${cols}\n${sep}\n${rows}`);
  }
  if (context.skills.length > 0) {
    blocks.push(formatSkills(context.skills));
  }

  if (blocks.length > 0) {
    sections.push(`# Available Building Blocks

The following agents, roles, and capabilities are available for designing the workflow. **You must choose from these lists** — do not invent agents or skills that are not listed.

${blocks.join('\n\n')}`);
  }

  // ── Output format ─────────────────────────────────────────────────────
  sections.push(`# Output Format

Respond with **only** a valid JSON object conforming to the following TypeScript types. Do not include any explanatory text before or after the JSON.

\`\`\`typescript
interface WorkflowDefinition {
  name: string;
  phases: PhaseDefinition[];
}

interface PhaseDefinition {
  name: string;
  agents: AgentDefinition[];
  maxConcurrency?: number;  // optional — defaults to 4
}

interface AgentDefinition {
  name: string;
  prompt: string;
  agentId?: string;   // reference a predefined agent from the list above
  model?: string;     // optional — defaults to the system default
  timeoutMs?: number; // optional — defaults to 300 000 (5 min)
}
\`\`\`

**Rules for using \`agentId\` vs \`prompt\`**:
- If a suitable **predefined agent** exists in the list above, set \`agentId\` to its ID and provide a concise task-specific \`prompt\`.
- If you need a **custom agent** that doesn't match any predefined agent, provide a detailed \`prompt\` (system prompt) and omit \`agentId\`.
- At least one of \`agentId\` or \`prompt\` must be present.`);

  // ── Constraints ───────────────────────────────────────────────────────
  sections.push(`# Constraints

1. **Maximum 50 phases** per workflow.
2. **Maximum 100 agents** per phase.
3. **Maximum 1 000 agents** total across all phases.
4. **Maximum ${maxChoicesPerStep} choices per category** — only the options listed above are available; do not invent new domains, sources, roles, agents, or skills.
5. Phases execute **sequentially**, one after another.
6. Agents within a phase execute **in parallel** (respecting \`maxConcurrency\`).
7. Use descriptive phase and agent names that reflect the task.`);

  // ── Guidelines ────────────────────────────────────────────────────────
  sections.push(`# Guidelines

1. Analyse the user's request carefully. Break it into logical steps.
2. For each step, determine which agents should execute in parallel.
3. Assign each agent a clear, focused task via \`prompt\`.
4. Prefer predefined agents (\`agentId\`) when their capabilities match the task.
5. Keep prompts concise but specific — include all necessary context from earlier phases.
6. If a phase depends on output from a previous phase, mention that dependency in the agent prompt.`);

  return sections.join('\n\n');
}

/**
 * Wrap a free-form user request into a structured message.
 */
export function buildUserPrompt(userRequest: string): string {
  return `# User Request

Design a workflow for the following request:

${userRequest}

---

Output a valid WorkflowDefinition JSON object that satisfies the request above.`;
}
