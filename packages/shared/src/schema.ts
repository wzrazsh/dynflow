import { z } from 'zod';
import { RuntimeConfigSchema } from './system.js';
import type { ValidationResult, ValidationError } from './types.js';

// ---------------------------------------------------------------------------
// Zod schemas for WorkflowDefinition
// ---------------------------------------------------------------------------

const AgentSchema = z
  .object({
    name: z.string().min(1, 'Agent name is required'),
    prompt: z.string().min(1, 'Agent prompt is required').optional(),
    agentId: z.string().optional(),
    model: z.string().optional(),
    timeoutMs: z
      .number()
      .int()
      .min(1000, 'Timeout must be at least 1000ms')
      .max(600000, 'Timeout must not exceed 600000ms')
      .optional(),
  })
  .superRefine((data, ctx) => {
    if (!data.prompt && !data.agentId) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['prompt'],
        message:
          'Agent must have either a prompt (for dynamic agents) or an agentId (for predefined agents)',
      });
    }
  });

const PhaseSchema = z.object({
  name: z.string().min(1, 'Phase name is required'),
  agents: z
    .array(AgentSchema)
    .min(1, 'At least one agent is required per phase')
    .max(100, 'Maximum 100 agents per phase'),
  maxConcurrency: z
    .number()
    .int()
    .min(1, 'Max concurrency must be at least 1')
    .max(16, 'Max concurrency must not exceed 16')
    .optional(),
});

const WorkspaceConfigSchema = z
  .object({
    git: z.string().url('workspace.git must be a valid URL').optional(),
    branch: z.string().optional(),
    path: z.string().min(1, 'workspace.path must not be empty').optional(),
    commit: z.string().optional(),
  })
  .refine((data) => data.git !== undefined || data.path !== undefined, {
    message: 'workspace must specify either git or path',
  });

const WorkflowDefinitionSchema = z
  .object({
    name: z
      .string()
      .min(1, 'Workflow name is required')
      .max(200, 'Workflow name must not exceed 200 characters'),
    workspace: WorkspaceConfigSchema.optional(),
    runtimeConfig: RuntimeConfigSchema.optional(),
    phases: z
      .array(PhaseSchema)
      .min(1, 'At least one phase is required')
      .max(50, 'Maximum 50 phases allowed'),
  })
  .superRefine((data, ctx) => {
    // --- Total agents across all phases ≤ 1000 ---
    const totalAgents = data.phases.reduce(
      (sum, phase) => sum + phase.agents.length,
      0,
    );
    if (totalAgents > 1000) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['phases'],
        message: `Total agents (${totalAgents}) exceeds maximum of 1000`,
      });
    }

    // --- Duplicate phase names ---
    const phaseNameSet = new Set<string>();
    for (const phase of data.phases) {
      if (phaseNameSet.has(phase.name)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['phases'],
          message: `Duplicate phase name: "${phase.name}"`,
        });
      }
      phaseNameSet.add(phase.name);
    }

    // --- Duplicate agent names within each phase ---
    for (let i = 0; i < data.phases.length; i++) {
      const phase = data.phases[i];
      const agentNameSet = new Set<string>();
      for (const agent of phase.agents) {
        if (agentNameSet.has(agent.name)) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ['phases', i, 'agents'],
            message: `Duplicate agent name in phase "${phase.name}": "${agent.name}"`,
          });
        }
        agentNameSet.add(agent.name);
      }
    }
  });

// ---------------------------------------------------------------------------
// Public validation function
// ---------------------------------------------------------------------------

/**
 * Validate an unknown input against the WorkflowDefinition schema.
 * Returns a structured `ValidationResult` with path, message, and error code.
 */
export function validateWorkflowDefinition(
  input: unknown,
): ValidationResult {
  const result = WorkflowDefinitionSchema.safeParse(input);

  if (result.success) {
    return { valid: true };
  }

  const errors: ValidationError[] = result.error.issues.map(mapIssue);
  return { valid: false, errors };
}

// ---------------------------------------------------------------------------
// Error-code mapping
// ---------------------------------------------------------------------------

const ERROR_CODE_MAP: Record<string, Record<string, string>> = {
  name: {
    too_small: 'MISSING_NAME',
    too_big: 'INVALID_INPUT',
  },
  prompt: {
    too_small: 'EMPTY_PROMPT',
  },
  maxConcurrency: {
    too_small: 'INVALID_CONCURRENCY',
    too_big: 'INVALID_CONCURRENCY',
    invalid_type: 'INVALID_CONCURRENCY',
  },
  timeoutMs: {
    too_small: 'INVALID_TIMEOUT',
    too_big: 'INVALID_TIMEOUT',
    invalid_type: 'INVALID_TIMEOUT',
  },
};

const PHASE_ARRAY_CODES: Record<string, string> = {
  too_small: 'NO_PHASES',
  too_big: 'TOO_MANY_PHASES',
};

const AGENT_ARRAY_CODES: Record<string, string> = {
  too_big: 'INVALID_INPUT',
};

/**
 * Detect the appropriate error code for custom (superRefine) issues
 * based on the issue path and message content.
 */
function detectCustomErrorCode(issue: z.ZodIssue): string {
  const pathStr = issue.path.length > 0 ? issue.path.join('.') : '';
  const msg = issue.message.toLowerCase();

  // TOO_MANY_AGENTS — at path "phases", message mentions "exceeds" and "maximum"
  if (pathStr === 'phases' && msg.includes('exceeds maximum')) {
    return 'TOO_MANY_AGENTS';
  }

  // DUPLICATE_PHASE_NAME — at path "phases", message mentions "duplicate phase name"
  if (pathStr === 'phases' && msg.includes('duplicate phase name')) {
    return 'DUPLICATE_PHASE_NAME';
  }

  // DUPLICATE_AGENT_NAME — at path "phases.N.agents", message mentions "duplicate agent name"
  if (/^phases\.\d+\.agents$/.test(pathStr) && msg.includes('duplicate agent name')) {
    return 'DUPLICATE_AGENT_NAME';
  }

  // MISSING_PROMPT_OR_AGENT_ID — message mentions "must have either a prompt or an agentId"
  if (msg.includes('must have either a prompt')) {
    return 'MISSING_PROMPT_OR_AGENT_ID';
  }

  return 'INVALID_INPUT';
}

function mapIssue(issue: z.ZodIssue): ValidationError {
  const pathStr = issue.path.length > 0 ? issue.path.join('.') : '<root>';
  const lastSegment =
    issue.path.length > 0
      ? String(issue.path[issue.path.length - 1])
      : '';

  // 1. If this is a custom issue from superRefine, detect the error code
  if (issue.code === 'custom') {
    const customCode = detectCustomErrorCode(issue);
    return {
      path: pathStr,
      message: issue.message,
      code: customCode,
    };
  }

  // 2. Check if the last path segment maps to a specific error code
  const fieldMap = ERROR_CODE_MAP[lastSegment];
  if (fieldMap && fieldMap[issue.code]) {
    return {
      path: pathStr,
      message: issue.message,
      code: fieldMap[issue.code],
    };
  }

  // 3. Array-level validation on "phases"
  if (issue.path.length === 1 && issue.path[0] === 'phases') {
    const code = PHASE_ARRAY_CODES[issue.code];
    if (code) {
      return { path: pathStr, message: issue.message, code };
    }
  }

  // 4. Array-level validation on agents array within a phase
  const parentSegment =
    issue.path.length >= 2
      ? String(issue.path[issue.path.length - 2])
      : '';
  if (parentSegment === 'agents' && AGENT_ARRAY_CODES[issue.code]) {
    return {
      path: pathStr,
      message: issue.message,
      code: AGENT_ARRAY_CODES[issue.code],
    };
  }

  // 5. Fallback
  return { path: pathStr, message: issue.message, code: 'INVALID_INPUT' };
}
