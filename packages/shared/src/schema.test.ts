import { describe, it, expect } from 'vitest';
import { validateWorkflowDefinition } from './schema.js';
import type { ValidationResult } from './types.js';

function validResult(r: ValidationResult): boolean {
  return r.valid && (!r.errors || r.errors.length === 0);
}

function firstErrorCode(r: ValidationResult): string | undefined {
  return r.errors?.[0]?.code;
}

// ---------------------------------------------------------------------------
// 1. Valid minimal: 1 phase, 1 agent → passes
// ---------------------------------------------------------------------------
describe('validateWorkflowDefinition', () => {
  it('accepts a minimal valid workflow (1 phase, 1 agent)', () => {
    const result = validateWorkflowDefinition({
      name: 'Hello World',
      phases: [
        {
          name: 'phase-1',
          agents: [{ name: 'agent-1', prompt: 'Do something' }],
        },
      ],
    });
    expect(validResult(result)).toBe(true);
  });

  // -----------------------------------------------------------------------
  // 2. Valid complex: 3 phases, 5 agents each → passes
  // -----------------------------------------------------------------------
  it('accepts a complex workflow (3 phases, 5 agents each)', () => {
    const input = {
      name: 'Complex Workflow',
      phases: Array.from({ length: 3 }, (_, pi) => ({
        name: `phase-${pi + 1}`,
        maxConcurrency: 4,
        agents: Array.from({ length: 5 }, (_, ai) => ({
          name: `agent-${pi + 1}-${ai + 1}`,
          prompt: `Execute task ${ai + 1} in phase ${pi + 1}`,
          model: ai % 2 === 0 ? 'gpt-4' : undefined,
          timeoutMs: 30000,
        })),
      })),
    };
    expect(validResult(validateWorkflowDefinition(input))).toBe(true);
  });

  // -----------------------------------------------------------------------
  // 3. Empty name → rejected
  // -----------------------------------------------------------------------
  it('rejects a workflow with an empty name', () => {
    const result = validateWorkflowDefinition({
      name: '',
      phases: [
        {
          name: 'phase-1',
          agents: [{ name: 'agent-1', prompt: 'Do something' }],
        },
      ],
    });
    expect(result.valid).toBe(false);
    expect(firstErrorCode(result)).toBe('MISSING_NAME');
  });

  // -----------------------------------------------------------------------
  // 4. No phases → rejected
  // -----------------------------------------------------------------------
  it('rejects a workflow with no phases', () => {
    const result = validateWorkflowDefinition({
      name: 'No Phases',
      phases: [],
    });
    expect(result.valid).toBe(false);
    expect(firstErrorCode(result)).toBe('NO_PHASES');
  });

  // -----------------------------------------------------------------------
  // 5. Too many phases (51) → rejected
  // -----------------------------------------------------------------------
  it('rejects a workflow with 51 phases (over limit)', () => {
    const input = {
      name: 'Too Many Phases',
      phases: Array.from({ length: 51 }, (_, i) => ({
        name: `phase-${i + 1}`,
        agents: [{ name: 'agent-1', prompt: 'Do something' }],
      })),
    };
    const result = validateWorkflowDefinition(input);
    expect(result.valid).toBe(false);
    expect(firstErrorCode(result)).toBe('TOO_MANY_PHASES');
  });

  // -----------------------------------------------------------------------
  // 6. Too many agents total (1001) → rejected
  // -----------------------------------------------------------------------
  it('rejects a workflow with 1001 agents total', () => {
    const input = {
      name: 'Too Many Agents',
      phases: Array.from({ length: 11 }, (_, pi) => ({
        name: `phase-${pi + 1}`,
        agents: Array.from({ length: 91 }, (_, ai) => ({
          name: `agent-${pi + 1}-${ai + 1}`,
          prompt: `Execute task ${ai + 1}`,
        })),
      })),
    };
    const result = validateWorkflowDefinition(input);
    expect(result.valid).toBe(false);
    expect(firstErrorCode(result)).toBe('TOO_MANY_AGENTS');
  });

  // -----------------------------------------------------------------------
  // 7. Agent with empty prompt → rejected
  // -----------------------------------------------------------------------
  it('rejects an agent with an empty prompt', () => {
    const result = validateWorkflowDefinition({
      name: 'Empty Prompt',
      phases: [
        {
          name: 'phase-1',
          agents: [{ name: 'agent-1', prompt: '' }],
        },
      ],
    });
    expect(result.valid).toBe(false);
    expect(firstErrorCode(result)).toBe('EMPTY_PROMPT');
  });

  // -----------------------------------------------------------------------
  // 8. Duplicate phase names → rejected
  // -----------------------------------------------------------------------
  it('rejects duplicate phase names', () => {
    const result = validateWorkflowDefinition({
      name: 'Dup Phases',
      phases: [
        {
          name: 'same-name',
          agents: [{ name: 'agent-1', prompt: 'First' }],
        },
        {
          name: 'same-name',
          agents: [{ name: 'agent-2', prompt: 'Second' }],
        },
      ],
    });
    expect(result.valid).toBe(false);
    const codes = result.errors?.map((e) => e.code) ?? [];
    expect(codes).toContain('DUPLICATE_PHASE_NAME');
  });

  // -----------------------------------------------------------------------
  // 9. Names exceeding max length → rejected
  // -----------------------------------------------------------------------
  it('rejects a workflow name longer than 200 characters', () => {
    const result = validateWorkflowDefinition({
      name: 'x'.repeat(201),
      phases: [
        {
          name: 'phase-1',
          agents: [{ name: 'agent-1', prompt: 'Do something' }],
        },
      ],
    });
    expect(result.valid).toBe(false);
    expect(firstErrorCode(result)).toBe('INVALID_INPUT');
  });

  // -----------------------------------------------------------------------
  // 10. workspace with git URL → accepted
  // -----------------------------------------------------------------------
  it('accepts a workflow with a workspace.git config', () => {
    const result = validateWorkflowDefinition({
      name: 'With Workspace',
      workspace: { git: 'https://github.com/foo/bar', branch: 'main' },
      phases: [
        {
          name: 'phase-1',
          agents: [{ name: 'agent-1', prompt: 'Do something' }],
        },
      ],
    });
    expect(validResult(result)).toBe(true);
  });

  // -----------------------------------------------------------------------
  // 11. workspace with only path → accepted
  // -----------------------------------------------------------------------
  it('accepts a workspace with only path', () => {
    const result = validateWorkflowDefinition({
      name: 'Local Workspace',
      workspace: { path: '/tmp/local-repo' },
      phases: [
        {
          name: 'phase-1',
          agents: [{ name: 'agent-1', prompt: 'Do something' }],
        },
      ],
    });
    expect(validResult(result)).toBe(true);
  });

  // -----------------------------------------------------------------------
  // 12. empty workspace object → rejected
  // -----------------------------------------------------------------------
  it('rejects an empty workspace object (must specify git or path)', () => {
    const result = validateWorkflowDefinition({
      name: 'Empty Workspace',
      workspace: {},
      phases: [
        {
          name: 'phase-1',
          agents: [{ name: 'agent-1', prompt: 'Do something' }],
        },
      ],
    });
    expect(result.valid).toBe(false);
  });

  // -----------------------------------------------------------------------
  // 13. invalid git URL → rejected
  // -----------------------------------------------------------------------
  it('rejects a workspace with an invalid git URL', () => {
    const result = validateWorkflowDefinition({
      name: 'Bad Git URL',
      workspace: { git: 'not-a-url' },
      phases: [
        {
          name: 'phase-1',
          agents: [{ name: 'agent-1', prompt: 'Do something' }],
        },
      ],
    });
    expect(result.valid).toBe(false);
  });
});
