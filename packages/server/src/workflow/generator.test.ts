import { describe, it, expect } from 'vitest';
import { generateWorkflow } from './generator.js';
import type {
  OrchestratorWorkflowInput,
  AgentRegistry,
} from './generator.js';
import { validateWorkflowDefinition } from '@dynflow/shared';

// ---------------------------------------------------------------------------
// Fake registry for testing agentId resolution
// ---------------------------------------------------------------------------

function createFakeRegistry(): AgentRegistry {
  return {
    getPredefinedAgent(id: string) {
      const agents: Record<string, { id: string; name: string; systemPrompt: string }> = {
        'reviewer-1': { id: 'reviewer-1', name: 'Code Reviewer', systemPrompt: 'You review code.' },
        'writer-1': { id: 'writer-1', name: 'Technical Writer', systemPrompt: 'You write docs.' },
        'analyzer-1': { id: 'analyzer-1', name: 'Data Analyzer', systemPrompt: 'You analyze data.' },
      };
      return agents[id];
    },
  };
}

const registry = createFakeRegistry();

// ---------------------------------------------------------------------------
// Factory helpers
// ---------------------------------------------------------------------------

function validInput(overrides: Partial<OrchestratorWorkflowInput> = {}): OrchestratorWorkflowInput {
  return {
    name: 'Test Workflow',
    phases: [
      {
        name: 'Analysis',
        agents: [{ name: 'Analyzer', prompt: 'Analyze the data.' }],
      },
    ],
    ...overrides,
  };
}

// ===================================================================
// Tests — Happy paths
// ===================================================================

describe('generateWorkflow() — happy paths', () => {
  it('generates a valid WorkflowDefinition from orchestrator output', () => {
    const input = validInput();
    const result = generateWorkflow(input);

    expect(result.workflow.name).toBe('Test Workflow');
    expect(result.workflow.phases).toHaveLength(1);
    expect(result.workflow.phases[0].name).toBe('Analysis');
    expect(result.workflow.phases[0].agents).toHaveLength(1);
    expect(result.workflow.phases[0].agents[0].name).toBe('Analyzer');
    expect(result.workflow.phases[0].agents[0].prompt).toBe('Analyze the data.');
    expect(result.warnings).toBeUndefined();

    // Should pass schema validation
    const validation = validateWorkflowDefinition(result.workflow);
    expect(validation.valid).toBe(true);
  });

  it('generates a valid workflow with multiple phases and agents', () => {
    const input: OrchestratorWorkflowInput = {
      name: 'Multi-Phase Flow',
      phases: [
        {
          name: 'Phase 1',
          agents: [
            { name: 'Agent A', prompt: 'Task A' },
            { name: 'Agent B', prompt: 'Task B' },
          ],
        },
        {
          name: 'Phase 2',
          agents: [{ name: 'Agent C', prompt: 'Task C' }],
          maxConcurrency: 4,
        },
      ],
    };

    const result = generateWorkflow(input);

    expect(result.workflow.name).toBe('Multi-Phase Flow');
    expect(result.workflow.phases).toHaveLength(2);
    expect(result.workflow.phases[0].agents).toHaveLength(2);
    expect(result.workflow.phases[1].agents).toHaveLength(1);
    expect(result.workflow.phases[1].maxConcurrency).toBe(4);
    expect(result.warnings).toBeUndefined();

    const validation = validateWorkflowDefinition(result.workflow);
    expect(validation.valid).toBe(true);
  });

  it('preserves model and timeoutMs on agents', () => {
    const input: OrchestratorWorkflowInput = {
      name: 'Configured Agents',
      phases: [
        {
          name: 'Phase 1',
          agents: [
            {
              name: 'GPU Agent',
              prompt: 'Run heavy computation.',
              model: 'gpt-4-turbo',
              timeoutMs: 300000,
            },
          ],
        },
      ],
    };

    const result = generateWorkflow(input);
    const agent = result.workflow.phases[0].agents[0];

    expect(agent.model).toBe('gpt-4-turbo');
    expect(agent.timeoutMs).toBe(300000);
    expect(result.warnings).toBeUndefined();
  });

  it('preserves maxConcurrency on phases', () => {
    const input: OrchestratorWorkflowInput = {
      name: 'Concurrency Test',
      phases: [
        {
          name: 'Parallel Phase',
          agents: [
            { name: 'A', prompt: 'A' },
            { name: 'B', prompt: 'B' },
          ],
          maxConcurrency: 8,
        },
      ],
    };

    const result = generateWorkflow(input);
    expect(result.workflow.phases[0].maxConcurrency).toBe(8);
  });
});

// ===================================================================
// Tests — AgentId resolution
// ===================================================================

describe('generateWorkflow() — agentId resolution', () => {
  it('resolves a valid agentId without prompt (relies on registry)', () => {
    const input: OrchestratorWorkflowInput = {
      name: 'Predefined Agent Flow',
      phases: [
        {
          name: 'Review',
          agents: [{ name: 'Reviewer', agentId: 'reviewer-1' }],
        },
      ],
    };

    const result = generateWorkflow(input, { registry });
    expect(result.warnings).toBeUndefined();

    const agent = result.workflow.phases[0].agents[0];
    expect(agent.name).toBe('Reviewer');
    expect(agent.agentId).toBe('reviewer-1');
    // prompt is omitted when agentId is sufficient for zod validation
    expect(agent.prompt).toBeUndefined();

    const validation = validateWorkflowDefinition(result.workflow);
    expect(validation.valid).toBe(true);
  });

  it('uses prompt as user instruction override when both agentId and prompt are provided', () => {
    const input: OrchestratorWorkflowInput = {
      name: 'Override Flow',
      phases: [
        {
          name: 'Review',
          agents: [
            {
              name: 'Reviewer',
              agentId: 'reviewer-1',
              prompt: 'Check for security vulnerabilities only.',
            },
          ],
        },
      ],
    };

    const result = generateWorkflow(input, { registry });
    expect(result.warnings).toBeUndefined();

    const agent = result.workflow.phases[0].agents[0];
    expect(agent.agentId).toBe('reviewer-1');
    expect(agent.prompt).toBe('Check for security vulnerabilities only.');
  });

  it('adds a warning when agentId is not found in registry but prompt fallback exists', () => {
    const input: OrchestratorWorkflowInput = {
      name: 'Fallback Flow',
      phases: [
        {
          name: 'Review',
          agents: [
            {
              name: 'Unknown Agent',
              agentId: 'non-existent-id',
              prompt: 'Fallback prompt.',
            },
          ],
        },
      ],
    };

    const result = generateWorkflow(input, { registry });
    expect(result.warnings).toBeDefined();
    expect(result.warnings!.length).toBeGreaterThanOrEqual(1);
    expect(result.warnings![0]).toContain('non-existent-id');
    expect(result.warnings![0]).toContain('not found in registry');
    expect(result.warnings![0]).toContain('Falling back');

    // Workflow should still be valid since prompt is present
    const validation = validateWorkflowDefinition(result.workflow);
    expect(validation.valid).toBe(true);
  });

  it('adds a fatal warning when agentId is not found and no prompt fallback exists', () => {
    const input: OrchestratorWorkflowInput = {
      name: 'Broken Flow',
      phases: [
        {
          name: 'Review',
          agents: [{ name: 'Ghost Agent', agentId: 'ghost-id' }],
        },
      ],
    };

    const result = generateWorkflow(input, { registry });
    expect(result.warnings).toBeDefined();
    expect(result.warnings!.length).toBeGreaterThanOrEqual(1);
    expect(result.warnings![0]).toContain('ghost-id');
    expect(result.warnings![0]).toContain('not found in registry');
    expect(result.warnings![0]).toContain('no fallback prompt');

    // Workflow will fail schema validation because prompt is empty and agentId is invalid
    const validation = validateWorkflowDefinition(result.workflow);
    expect(validation.valid).toBe(false);
  });

  it('warns when agentId is present but no registry is provided', () => {
    const input: OrchestratorWorkflowInput = {
      name: 'No Registry Flow',
      phases: [
        {
          name: 'Review',
          agents: [{ name: 'Reviewer', agentId: 'reviewer-1', prompt: 'Do review.' }],
        },
      ],
    };

    const result = generateWorkflow(input); // no registry option
    expect(result.warnings).toBeDefined();
    expect(result.warnings!.length).toBeGreaterThanOrEqual(1);
    expect(result.warnings![0]).toContain('no registry provided');

    // Workflow is still valid — prompt is present
    const validation = validateWorkflowDefinition(result.workflow);
    expect(validation.valid).toBe(true);
  });
});

// ===================================================================
// Tests — Dynamic agents (prompt only)
// ===================================================================

describe('generateWorkflow() — dynamic agents', () => {
  it('handles agents with only a prompt (dynamic agent)', () => {
    const input: OrchestratorWorkflowInput = {
      name: 'Dynamic Flow',
      phases: [
        {
          name: 'Generation',
          agents: [
            { name: 'Writer', prompt: 'Write a blog post about TypeScript.' },
          ],
        },
      ],
    };

    const result = generateWorkflow(input);
    expect(result.warnings).toBeUndefined();

    const agent = result.workflow.phases[0].agents[0];
    expect(agent.name).toBe('Writer');
    expect(agent.prompt).toBe('Write a blog post about TypeScript.');
    expect(agent.agentId).toBeUndefined();
  });

  it('ignores agentId lookup for dynamic agents (no agentId field)', () => {
    const input: OrchestratorWorkflowInput = {
      name: 'Dynamic Only',
      phases: [
        {
          name: 'Phase 1',
          agents: [
            { name: 'Agent 1', prompt: 'Do something.' },
            { name: 'Agent 2', prompt: 'Do something else.' },
          ],
        },
      ],
    };

    const result = generateWorkflow(input, { registry });
    expect(result.warnings).toBeUndefined();
    expect(result.workflow.phases[0].agents).toHaveLength(2);
  });
});

// ===================================================================
// Tests — Edge cases
// ===================================================================

describe('generateWorkflow() — edge cases', () => {
  it('handles empty phases array (returns validation warnings)', () => {
    const input: OrchestratorWorkflowInput = {
      name: 'Empty Workflow',
      phases: [],
    };

    const result = generateWorkflow(input);
    expect(result.warnings).toBeDefined();
    expect(result.warnings!.length).toBeGreaterThanOrEqual(1);
    expect(result.warnings!.some((w) => w.includes('NO_PHASES') || w.includes('At least one'))).toBe(true);

    const validation = validateWorkflowDefinition(result.workflow);
    expect(validation.valid).toBe(false);
  });

  it('handles empty agents array in a phase (returns validation warnings)', () => {
    const input: OrchestratorWorkflowInput = {
      name: 'Empty Agents',
      phases: [
        {
          name: 'Empty Phase',
          agents: [],
        },
      ],
    };

    const result = generateWorkflow(input);
    expect(result.warnings).toBeDefined();
    expect(result.warnings!.some((w) => w.includes('At least one agent'))).toBe(true);

    const validation = validateWorkflowDefinition(result.workflow);
    expect(validation.valid).toBe(false);
  });

  it('handles empty workflow name (returns validation warnings)', () => {
    const input: OrchestratorWorkflowInput = {
      name: '',
      phases: [
        {
          name: 'Phase 1',
          agents: [{ name: 'Agent 1', prompt: 'Do stuff.' }],
        },
      ],
    };

    const result = generateWorkflow(input);
    expect(result.warnings).toBeDefined();
    expect(result.warnings!.some((w) => w.includes('MISSING_NAME') || w.includes('name is required'))).toBe(true);

    const validation = validateWorkflowDefinition(result.workflow);
    expect(validation.valid).toBe(false);
  });

  it('handles missing phase name (returns validation warnings)', () => {
    const input: OrchestratorWorkflowInput = {
      name: 'Test',
      phases: [
        {
          name: '',
          agents: [{ name: 'Agent 1', prompt: 'Do stuff.' }],
        },
      ],
    };

    const result = generateWorkflow(input);
    expect(result.warnings).toBeDefined();
    expect(result.warnings!.some((w) => w.includes('name is required'))).toBe(true);

    const validation = validateWorkflowDefinition(result.workflow);
    expect(validation.valid).toBe(false);
  });

  it('handles duplicate phase names (returns validation warnings)', () => {
    const input: OrchestratorWorkflowInput = {
      name: 'Duplicates',
      phases: [
        {
          name: 'Phase',
          agents: [{ name: 'A', prompt: 'Task A' }],
        },
        {
          name: 'Phase',
          agents: [{ name: 'B', prompt: 'Task B' }],
        },
      ],
    };

    const result = generateWorkflow(input);
    expect(result.warnings).toBeDefined();
    expect(result.warnings!.some((w) => w.includes('DUPLICATE_PHASE_NAME') || w.includes('Duplicate phase'))).toBe(true);

    const validation = validateWorkflowDefinition(result.workflow);
    expect(validation.valid).toBe(false);
  });

  it('handles duplicate agent names within a phase', () => {
    const input: OrchestratorWorkflowInput = {
      name: 'Dup Agents',
      phases: [
        {
          name: 'Phase 1',
          agents: [
            { name: 'Agent', prompt: 'First' },
            { name: 'Agent', prompt: 'Second' },
          ],
        },
      ],
    };

    const result = generateWorkflow(input);
    expect(result.warnings).toBeDefined();
    expect(result.warnings!.some((w) => w.includes('DUPLICATE_AGENT_NAME') || w.includes('Duplicate agent'))).toBe(true);

    const validation = validateWorkflowDefinition(result.workflow);
    expect(validation.valid).toBe(false);
  });

  it('handles too many phases (>50)', () => {
    const input: OrchestratorWorkflowInput = {
      name: 'Too Many Phases',
      phases: Array.from({ length: 51 }, (_, i) => ({
        name: `Phase ${i}`,
        agents: [{ name: `Agent ${i}`, prompt: `Task ${i}` }],
      })),
    };

    const result = generateWorkflow(input);
    expect(result.warnings).toBeDefined();
    expect(result.warnings!.some((w) => w.includes('TOO_MANY_PHASES') || w.includes('50 phases'))).toBe(true);

    const validation = validateWorkflowDefinition(result.workflow);
    expect(validation.valid).toBe(false);
  });

  it('handles too many total agents (>1000 across all phases)', () => {
    const input: OrchestratorWorkflowInput = {
      name: 'Too Many Agents',
      phases: Array.from({ length: 20 }, (_, i) => ({
        name: `Phase ${i}`,
        agents: Array.from({ length: 51 }, (_, j) => ({
          name: `Agent-${i}-${j}`,
          prompt: `Task ${i}-${j}`,
        })),
      })),
    };

    const result = generateWorkflow(input);
    expect(result.warnings).toBeDefined();
    expect(result.warnings!.some((w) => w.includes('TOO_MANY_AGENTS') || w.includes('exceeds maximum'))).toBe(true);

    const validation = validateWorkflowDefinition(result.workflow);
    expect(validation.valid).toBe(false);
  });
});

// ===================================================================
// Tests — Mixed scenarios
// ===================================================================

describe('generateWorkflow() — mixed scenarios', () => {
  it('handles a mix of predefined and dynamic agents', () => {
    const input: OrchestratorWorkflowInput = {
      name: 'Hybrid Workflow',
      phases: [
        {
          name: 'Phase 1',
          agents: [
            { name: 'Predefined', agentId: 'reviewer-1' },
            { name: 'Dynamic', prompt: 'Do dynamic work.' },
            {
              name: 'Overridden',
              agentId: 'writer-1',
              prompt: 'Write a summary.',
            },
          ],
        },
      ],
    };

    const result = generateWorkflow(input, { registry });
    expect(result.warnings).toBeUndefined();
    expect(result.workflow.phases[0].agents).toHaveLength(3);

    // Predefined agent
    expect(result.workflow.phases[0].agents[0].agentId).toBe('reviewer-1');
    // Dynamic agent
    expect(result.workflow.phases[0].agents[1].agentId).toBeUndefined();
    expect(result.workflow.phases[0].agents[1].prompt).toBe('Do dynamic work.');
    // Overridden agent
    expect(result.workflow.phases[0].agents[2].agentId).toBe('writer-1');
    expect(result.workflow.phases[0].agents[2].prompt).toBe('Write a summary.');

    const validation = validateWorkflowDefinition(result.workflow);
    expect(validation.valid).toBe(true);
  });

  it('returns multiple warnings for multiple issues', () => {
    const input: OrchestratorWorkflowInput = {
      name: 'Many Issues',
      phases: [
        {
          name: 'Phase 1',
          agents: [
            { name: 'Ghost', agentId: 'ghost-1' },
            { name: 'Valid', agentId: 'reviewer-1' },
          ],
        },
        {
          name: 'Phase 1', // duplicate name
          agents: [
            { name: 'Unregistered', agentId: 'missing-id', prompt: 'Fallback.' },
          ],
        },
      ],
    };

    const result = generateWorkflow(input, { registry });
    expect(result.warnings).toBeDefined();
    // At minimum: ghost-1 not found, duplicate phase name, missing-id not found
    expect(result.warnings!.length).toBeGreaterThanOrEqual(3);

    const validation = validateWorkflowDefinition(result.workflow);
    expect(validation.valid).toBe(false);
  });
});

// ===================================================================
// Tests — Registry interface contract
// ===================================================================

describe('generateWorkflow() — registry interface', () => {
  it('works with a registry that returns undefined for all IDs', () => {
    const emptyRegistry: AgentRegistry = {
      getPredefinedAgent: () => undefined,
    };

    const input: OrchestratorWorkflowInput = {
      name: 'Empty Registry',
      phases: [
        {
          name: 'Phase 1',
          agents: [
            { name: 'Agent', agentId: 'any-id', prompt: 'Fallback prompt.' },
          ],
        },
      ],
    };

    const result = generateWorkflow(input, { registry: emptyRegistry });
    expect(result.warnings).toBeDefined();
    expect(result.warnings![0]).toContain('not found in registry');
    // Still valid because prompt is present
    const validation = validateWorkflowDefinition(result.workflow);
    expect(validation.valid).toBe(true);
  });

  it('works with no options at all', () => {
    const input = validInput();
    const result = generateWorkflow(input);
    expect(result.workflow.name).toBe('Test Workflow');
    expect(result.warnings).toBeUndefined();
  });

  it('works with empty options object', () => {
    const input = validInput();
    const result = generateWorkflow(input, {});
    expect(result.workflow.name).toBe('Test Workflow');
    expect(result.warnings).toBeUndefined();
  });
});
