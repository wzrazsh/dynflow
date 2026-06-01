/**
 * Integration test: multi-agent flow.
 *
 * Tests the full pipeline end-to-end:
 *   1. Register  → add domain / source / role / predefined agent via registry
 *   2. Query     → browse the registry via API routes
 *   3. Orchestrate → call the orchestrator with a mocked LLM
 *   4. Generate  → convert orchestrator output to WorkflowDefinition
 *   5. Validate  → run against the shared Zod schema
 *   6. Execute   → run a sandbox script producing dynamic + predefined agents
 *
 * Also covers edge cases: prompt override, invalid agentId resolution,
 * mixed syntax in the sandbox, and generator error handling.
 */

import { describe, it, expect, beforeEach, afterEach, afterAll, vi } from 'vitest';
import request from 'supertest';
import { createApp } from '../app.js';
import { closeDb } from '../db/connection.js';
import { initSchema } from '../db/schema.js';
import * as registry from '../agent/registry.js';
import { orchestrate, OrchestratorValidationError } from '../orchestrator/index.js';
import { generateWorkflow } from '../workflow/generator.js';
import { validateWorkflowDefinition } from '@dynflow/shared';
import { executeScript } from '../sandbox/isolated-runtime.js';
import type {
  Domain,
  AgentSource,
  AgentRole,
  PredefinedAgent,
  Skill,
  SkillCategory,
  WorkflowDefinition,
  AgentDefinition,
} from '@dynflow/shared';

// =========================================================================
// Helpers
// =========================================================================

/**
 * Create a mock fetch Response that looks like an OpenAI chat-completions
 * response carrying the given JSON content.
 */
function mockOkResponse(jsonContent: unknown): Response {
  const body = JSON.stringify(jsonContent);
  const openaiPayload = JSON.stringify({
    choices: [{ message: { content: body } }],
  });
  return {
    ok: true,
    status: 200,
    text: () => Promise.resolve(openaiPayload),
    json: () => Promise.resolve(JSON.parse(openaiPayload)),
  } as Response;
}

/**
 * Strip leading indentation from a template literal.
 */
function stripIndent(code: string): string {
  const lines = code.split('\n');
  while (lines.length > 0 && lines[0].trim() === '') lines.shift();
  while (lines.length > 0 && lines[lines.length - 1].trim() === '') lines.pop();
  const indents = lines
    .filter((l) => l.trim().length > 0)
    .map((l) => l.match(/^ */)?.[0].length ?? 0);
  const minIndent = Math.min(...indents);
  return lines.map((l) => l.slice(minIndent)).join('\n');
}

// =========================================================================
// Fixtures
// =========================================================================

const sandboxOpts = { timeoutMs: 30_000, memoryLimitMb: 64 };

// =========================================================================
// Setup — fresh in-memory DB before each test
// =========================================================================

beforeEach(() => {
  closeDb();
  process.env.DB_PATH = ':memory:';
  initSchema();
});

afterAll(() => {
  closeDb();
  delete process.env.DB_PATH;
});

// =====================================================================
// 1. Full pipeline: register → query → orchestrate → generate → execute
// =====================================================================

describe('Full pipeline: register → query → orchestrate → generate → execute', () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('completes the full integration flow', async () => {
    // -------------------------------------------------------------------
    // Step 1 — REGISTER entities in the agent registry
    // -------------------------------------------------------------------
    const domain: Domain = registry.addDomain({
      name: 'Code Analysis',
      description: 'Tools and agents for automated code analysis',
    });

    const source: AgentSource = registry.addSource({
      domainId: domain.id,
      name: 'GitHub Tools',
      url: 'https://github.com/tools',
      description: 'GitHub-hosted code analysis tools',
    });

    const role: AgentRole = registry.addRole({
      sourceId: source.id,
      name: 'Code Reviewer',
      description: 'Reviews pull requests for bugs and style issues',
    });

    const reviewer: PredefinedAgent = registry.addAgent({
      roleId: role.id,
      name: 'reviewer-bot',
      description: 'Automated code reviewer',
      systemPrompt: 'You are a senior code reviewer. Be thorough and detailed.',
      availableSkills: ['code-analysis'],
    });

    expect(domain.id).toBeDefined();
    expect(source.id).toBeDefined();
    expect(role.id).toBeDefined();
    expect(reviewer.id).toBeDefined();

    // -------------------------------------------------------------------
    // Step 2 — QUERY via API routes
    // -------------------------------------------------------------------
    const app = createApp();

    // 2a. List domains
    const domainsRes = await request(app)
      .get('/api/domains')
      .expect(200);
    expect(domainsRes.body.success).toBe(true);
    expect(domainsRes.body.data).toHaveLength(1);
    expect(domainsRes.body.data[0].name).toBe('Code Analysis');

    // 2b. List agent sources under the domain
    const sourcesRes = await request(app)
      .get(`/api/domains/${domain.id}/agent-sources`)
      .expect(200);
    expect(sourcesRes.body.success).toBe(true);
    expect(sourcesRes.body.data).toHaveLength(1);
    expect(sourcesRes.body.data[0].name).toBe('GitHub Tools');

    // 2c. List roles under the source
    const rolesRes = await request(app)
      .get(`/api/agent-sources/${source.id}/roles`)
      .expect(200);
    expect(rolesRes.body.success).toBe(true);
    expect(rolesRes.body.data).toHaveLength(1);
    expect(rolesRes.body.data[0].name).toBe('Code Reviewer');

    // 2d. List predefined agents under the role
    const agentsRes = await request(app)
      .get(`/api/predefined-agents/roles/${role.id}/agents`)
      .expect(200);
    expect(agentsRes.body.success).toBe(true);
    expect(agentsRes.body.data).toHaveLength(1);
    expect(agentsRes.body.data[0].name).toBe('reviewer-bot');
    expect(agentsRes.body.data[0].systemPrompt).toContain('senior code reviewer');

    // -------------------------------------------------------------------
    // Step 3 — ORCHESTRATE with mocked LLM
    // -------------------------------------------------------------------
    const llmWorkflow = {
      name: 'Code Review Pipeline',
      phases: [
        {
          name: 'Review',
          agents: [
            {
              name: 'Primary Reviewer',
              agentId: reviewer.id,
              prompt: 'Review the PR for bugs and style issues.',
            },
            {
              name: 'Security Scanner',
              prompt: 'Scan for security vulnerabilities in the code.',
            },
          ],
        },
      ],
    };

    fetchMock.mockResolvedValue(mockOkResponse(llmWorkflow));

    const orchestrateResult = await orchestrate({
      userRequest: 'Review a pull request for bugs and security issues',
      domains: [domain],
      sources: [source],
      roles: [role],
      agents: [reviewer],
      skills: [],
      apiKey: 'sk-test-key',
    });

    expect(orchestrateResult.workflow.name).toBe('Code Review Pipeline');
    expect(orchestrateResult.workflow.phases).toHaveLength(1);
    expect(orchestrateResult.workflow.phases[0].agents).toHaveLength(2);

    // Predefined agent reference is preserved
    const primaryAgent = orchestrateResult.workflow.phases[0].agents[0];
    expect(primaryAgent.name).toBe('Primary Reviewer');
    expect(primaryAgent.agentId).toBe(reviewer.id);
    expect(primaryAgent.prompt).toBe('Review the PR for bugs and style issues.');

    // Dynamic agent (no agentId)
    const secAgent = orchestrateResult.workflow.phases[0].agents[1];
    expect(secAgent.name).toBe('Security Scanner');
    expect(secAgent.agentId).toBeUndefined();
    expect(secAgent.prompt).toBe('Scan for security vulnerabilities in the code.');

    // -------------------------------------------------------------------
    // Step 4 — GENERATE WorkflowDefinition from orchestrator-like input
    // -------------------------------------------------------------------
    const agentRegistry = {
      getPredefinedAgent: (id: string) => {
        if (id === reviewer.id) {
          return { id: reviewer.id, name: reviewer.name, systemPrompt: reviewer.systemPrompt };
        }
        return undefined;
      },
    };

    const generated = generateWorkflow(
      {
        name: 'Generated Pipeline',
        phases: [
          {
            name: 'Phase 1',
            agents: [
              // Predefined agent (only agentId, no prompt)
              { name: 'Predefined Only', agentId: reviewer.id },
              // Dynamic agent (only prompt, no agentId)
              { name: 'Dynamic Only', prompt: 'Do something dynamic' },
              // Predefined with prompt override
              { name: 'Override', agentId: reviewer.id, prompt: 'Override prompt here' },
            ],
          },
        ],
      },
      { registry: agentRegistry },
    );

    expect(generated.workflow.phases).toHaveLength(1);
    expect(generated.workflow.phases[0].agents).toHaveLength(3);
    expect(generated.warnings).toBeUndefined();

    const agentsOut = generated.workflow.phases[0].agents;

    // 4a. Predefined only: agentId present, prompt omitted
    expect(agentsOut[0].name).toBe('Predefined Only');
    expect(agentsOut[0].agentId).toBe(reviewer.id);
    expect(agentsOut[0].prompt).toBeUndefined();

    // 4b. Dynamic only: prompt present, no agentId
    expect(agentsOut[1].name).toBe('Dynamic Only');
    expect(agentsOut[1].prompt).toBe('Do something dynamic');
    expect(agentsOut[1].agentId).toBeUndefined();

    // 4c. Override: both present
    expect(agentsOut[2].name).toBe('Override');
    expect(agentsOut[2].agentId).toBe(reviewer.id);
    expect(agentsOut[2].prompt).toBe('Override prompt here');

    // -------------------------------------------------------------------
    // Step 5 — VALIDATE against Zod schema
    // -------------------------------------------------------------------
    const validation = validateWorkflowDefinition(generated.workflow);
    expect(validation.valid).toBe(true);

    // Also validate the orchestrate result
    const orchestrateValidation = validateWorkflowDefinition(orchestrateResult.workflow);
    expect(orchestrateValidation.valid).toBe(true);

    // -------------------------------------------------------------------
    // Step 6 — EXECUTE sandbox script (dynamic + predefined agents)
    // -------------------------------------------------------------------
    const script = stripIndent(`
      phase("Review", () => {
        agent("dynamic-agent", "Dynamic prompt here");
        agent("predefined-agent", { agentId: "${reviewer.id}" });
        agent("override-agent", { agentId: "${reviewer.id}", prompt: "Override prompt" });
      });
    `);

    const sandboxResult = await executeScript(script, sandboxOpts);
    expect(sandboxResult.success).toBe(true);
    expect(sandboxResult.definition).toBeDefined();
    expect(sandboxResult.definition!.phases).toHaveLength(1);
    expect(sandboxResult.definition!.phases[0].agents).toHaveLength(3);

    const sandboxAgents = sandboxResult.definition!.phases[0].agents;

    // 6a. Dynamic agent: name + prompt, no agentId
    expect(sandboxAgents[0].name).toBe('dynamic-agent');
    expect(sandboxAgents[0].prompt).toBe('Dynamic prompt here');
    expect(sandboxAgents[0].agentId).toBeUndefined();

    // 6b. Predefined agent: name + agentId, prompt omitted (undefined)
    expect(sandboxAgents[1].name).toBe('predefined-agent');
    expect(sandboxAgents[1].agentId).toBe(reviewer.id);
    expect(sandboxAgents[1].prompt).toBeUndefined();

    // 6c. Override: both present
    expect(sandboxAgents[2].name).toBe('override-agent');
    expect(sandboxAgents[2].agentId).toBe(reviewer.id);
    expect(sandboxAgents[2].prompt).toBe('Override prompt');

    // Sanity: sandbox output should also validate
    const sandboxValidation = validateWorkflowDefinition(sandboxResult.definition!);
    expect(sandboxValidation.valid).toBe(true);
  });
});

// =====================================================================
// 2. Sandbox agent syntaxes
// =====================================================================

describe('Sandbox: agent syntax variations', () => {
  // No DB needed for sandbox tests, but DB state shouldn't interfere
  // because executeScript doesn't touch the database.

  it('creates a dynamic agent with string prompt', async () => {
    const script = `phase("P", () => { agent("a1", "Hello world"); });`;
    const result = await executeScript(script, sandboxOpts);

    expect(result.success).toBe(true);
    expect(result.definition!.phases[0].agents).toHaveLength(1);
    const agent = result.definition!.phases[0].agents[0];
    expect(agent.name).toBe('a1');
    expect(agent.prompt).toBe('Hello world');
    expect(agent.agentId).toBeUndefined();
  });

  it('creates a predefined agent with { agentId } object syntax', async () => {
    const script = `phase("P", () => { agent("a1", { agentId: "my-agent-id" }); });`;
    const result = await executeScript(script, sandboxOpts);

    expect(result.success).toBe(true);
    const agent = result.definition!.phases[0].agents[0];
    expect(agent.name).toBe('a1');
    expect(agent.prompt).toBeUndefined();
    expect(agent.agentId).toBe('my-agent-id');
  });

  it('creates a predefined agent with { agentId, prompt } override syntax', async () => {
    const script = `phase("P", () => { agent("a1", { agentId: "my-id", prompt: "Override" }); });`;
    const result = await executeScript(script, sandboxOpts);

    expect(result.success).toBe(true);
    const agent = result.definition!.phases[0].agents[0];
    expect(agent.name).toBe('a1');
    expect(agent.agentId).toBe('my-id');
    expect(agent.prompt).toBe('Override');
  });

  it('mixes dynamic and predefined agents in the same phase', async () => {
    const script = stripIndent(`
      phase("Mixed", () => {
        agent("dynamic", "Dynamic task");
        agent("predefined", { agentId: "agent-xyz" });
        agent("override", { agentId: "agent-abc", prompt: "Custom override" });
      });
    `);
    const result = await executeScript(script, sandboxOpts);

    expect(result.success).toBe(true);
    const agents = result.definition!.phases[0].agents;
    expect(agents).toHaveLength(3);

    // Dynamic
    expect(agents[0].name).toBe('dynamic');
    expect(agents[0].prompt).toBe('Dynamic task');
    expect(agents[0].agentId).toBeUndefined();

    // Predefined
    expect(agents[1].name).toBe('predefined');
    expect(agents[1].agentId).toBe('agent-xyz');
    expect(agents[1].prompt).toBeUndefined();

    // Override
    expect(agents[2].name).toBe('override');
    expect(agents[2].agentId).toBe('agent-abc');
    expect(agents[2].prompt).toBe('Custom override');
  });
});

// =====================================================================
// 3. Generator edge cases
// =====================================================================

describe('Generator: agentId resolution edge cases', () => {
  const emptyRegistry = { getPredefinedAgent: () => undefined };

  it('handles valid predefined agent (no prompt) — omits prompt from output', () => {
    const registryWithAgent = {
      getPredefinedAgent: (id: string) => {
        if (id === 'valid-id') {
          return { id: 'valid-id', name: 'Valid', systemPrompt: 'You are valid.' };
        }
        return undefined;
      },
    };

    const result = generateWorkflow(
      {
        name: 'Test',
        phases: [
          {
            name: 'P1',
            agents: [{ name: 'Valid Agent', agentId: 'valid-id' }],
          },
        ],
      },
      { registry: registryWithAgent },
    );

    expect(result.warnings).toBeUndefined();
    expect(result.workflow.phases[0].agents[0].agentId).toBe('valid-id');
    expect(result.workflow.phases[0].agents[0].prompt).toBeUndefined();

    // Schema should accept agentId without prompt
    const validation = validateWorkflowDefinition(result.workflow);
    expect(validation.valid).toBe(true);
  });

  it('produces warnings for invalid agentId with fallback prompt', () => {
    const result = generateWorkflow(
      {
        name: 'Test',
        phases: [
          {
            name: 'P1',
            agents: [
              { name: 'Ghost', agentId: 'nonexistent-id', prompt: 'Fallback prompt' },
            ],
          },
        ],
      },
      { registry: emptyRegistry },
    );

    // Should warn about unresolved agentId
    expect(result.warnings).toBeDefined();
    expect(result.warnings!.length).toBeGreaterThanOrEqual(1);
    expect(result.warnings!.some((w) => w.includes('not found'))).toBe(true);

    // agentId should be stripped, prompt should serve as fallback
    const agent = result.workflow.phases[0].agents[0];
    expect(agent.agentId).toBeUndefined();
    expect(agent.prompt).toBe('Fallback prompt');

    // The output should still validate
    const validation = validateWorkflowDefinition(result.workflow);
    expect(validation.valid).toBe(true);
  });

  it('produces validation errors for invalid agentId without fallback', () => {
    const result = generateWorkflow(
      {
        name: 'Test',
        phases: [
          {
            name: 'P1',
            agents: [{ name: 'Ghost', agentId: 'nonexistent-id' }],
          },
        ],
      },
      { registry: emptyRegistry },
    );

    // Should warn about unresolved agentId and missing prompt
    expect(result.warnings).toBeDefined();
    expect(result.warnings!.some((w) => w.includes('not found'))).toBe(true);

    // Schema validation should fail because no prompt and no valid agentId
    const validation = validateWorkflowDefinition(result.workflow);
    expect(validation.valid).toBe(false);
    expect(validation.errors).toBeDefined();
    expect(validation.errors!.some((e) => e.code === 'MISSING_PROMPT_OR_AGENT_ID')).toBe(true);
  });

  it('passes agentId through when no registry is provided (with warning)', () => {
    const result = generateWorkflow({
      name: 'Test',
      phases: [
        {
          name: 'P1',
          agents: [{ name: 'Ghost', agentId: 'unknown-id' }],
        },
      ],
    });

    // Should warn about unvalidated agentId
    expect(result.warnings).toBeDefined();
    expect(result.warnings!.some((w) => w.includes('no registry'))).toBe(true);

    // agentId should still be present in output
    expect(result.workflow.phases[0].agents[0].agentId).toBe('unknown-id');
  });
});
