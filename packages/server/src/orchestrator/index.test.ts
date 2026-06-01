import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type {
  Domain,
  AgentSource,
  AgentRole,
  Skill,
  SkillCategory,
} from '@dynflow/shared';
import type { PredefinedAgent } from '@dynflow/shared';
import {
  orchestrate,
  Orchestrator,
  OrchestratorLLMError,
  OrchestratorValidationError,
} from './index.js';

// ---------------------------------------------------------------------------
// Test data factories (mirrored from prompt.test.ts for consistency)
// ---------------------------------------------------------------------------

function makeDomain(id: string, name: string, description = ''): Domain {
  return { id, name, description };
}

function makeSource(
  id: string,
  domainId: string,
  description = '',
): AgentSource {
  return { id, domainId, name: id, url: `https://example.com/${id}`, description };
}

function makeRole(
  id: string,
  sourceId: string,
  tier: number,
  description = '',
): AgentRole {
  return { id, sourceId, name: id, description, tier };
}

function makeAgent(
  id: string,
  roleId: string,
  description = '',
): PredefinedAgent {
  return { id, roleId, name: id, description, systemPrompt: '', availableSkills: [] };
}

function makeSkill(
  id: string,
  sourceId: string,
  category: SkillCategory,
  description = '',
): Skill {
  return {
    id,
    sourceId,
    name: id,
    description,
    category,
    parameters: [],
  };
}

// ---------------------------------------------------------------------------
// Helpers for generating many items
// ---------------------------------------------------------------------------

function manyDomains(n: number): Domain[] {
  return Array.from({ length: n }, (_, i) =>
    makeDomain(`d${i}`, `Domain ${i}`, `Description ${i}`),
  );
}

function manySources(n: number, domainId = 'd0'): AgentSource[] {
  return Array.from({ length: n }, (_, i) =>
    makeSource(`s${i}`, domainId, `Source ${i}`),
  );
}

function manyRoles(
  n: number,
  sourceId = 's0',
  startTier = 1,
): AgentRole[] {
  return Array.from({ length: n }, (_, i) =>
    makeRole(`r${i}`, sourceId, startTier + (i % 5), `Role ${i}`),
  );
}

function manyAgents(n: number, roleId = 'r0'): PredefinedAgent[] {
  return Array.from({ length: n }, (_, i) =>
    makeAgent(`a${i}`, roleId, `Agent ${i}`),
  );
}

function manySkills(
  n: number,
  sourceId = 's0',
  category: SkillCategory = 'analysis',
): Skill[] {
  return Array.from({ length: n }, (_, i) =>
    makeSkill(`sk${i}`, sourceId, category, `Skill ${i}`),
  );
}

// ---------------------------------------------------------------------------
// A valid WorkflowDefinition that the mock LLM returns
// ---------------------------------------------------------------------------

const VALID_WORKFLOW_JSON = {
  name: 'Code Review Workflow',
  phases: [
    {
      name: 'Analysis',
      agents: [
        {
          name: 'Code Reviewer',
          agentId: 'reviewer-1',
          prompt: 'Review the code for bugs and style issues.',
        },
      ],
    },
    {
      name: 'Reporting',
      agents: [
        {
          name: 'Report Generator',
          prompt: 'Generate a summary report of the code review findings.',
        },
      ],
      maxConcurrency: 2,
    },
  ],
};

// ---------------------------------------------------------------------------
// Markdown table extraction helper
// ---------------------------------------------------------------------------

/**
 * Extract a markdown table from the prompt text by its section heading,
 * then count the number of data rows (excluding header + separator).
 */
function extractTable(
  text: string,
  heading: string,
): { rowCount: number } | null {
  // Find the heading, then look for the table within ~30 lines after it
  const headingIdx = text.indexOf(heading);
  if (headingIdx === -1) return null;

  const afterHeading = text.slice(headingIdx);
  const lines = afterHeading.split('\n');

  // Skip heading, blank, and header lines
  let rowCount = 0;
  let pastSeparator = false;
  for (const line of lines) {
    // The separator row is the line that starts with '|' and contains '---'
    if (!pastSeparator && line.startsWith('|') && line.includes('---')) {
      pastSeparator = true;
      continue;
    }
    if (pastSeparator) {
      if (line.startsWith('|') && line.endsWith('|')) {
        rowCount++;
      } else {
        break; // end of table
      }
    }
  }

  return { rowCount };
}

// ---------------------------------------------------------------------------
// Mock helpers
// ---------------------------------------------------------------------------

/** Create a mock fetch response that returns the given JSON content. */
function mockOkResponse(jsonContent: unknown, wrapInFence = false): Response {
  const body = wrapInFence
    ? '```json\n' + JSON.stringify(jsonContent) + '\n```'
    : JSON.stringify(jsonContent);

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

/** Create a mock fetch response that returns non-OK status. */
function mockErrorResponse(status: number, body = ''): Response {
  return {
    ok: false,
    status,
    text: () => Promise.resolve(body),
  } as Response;
}

/** Default set of small entity lists for most tests. */
function defaultOptions(overrides: Record<string, unknown> = {}) {
  return {
    userRequest: 'Build a code review workflow with analysis and reporting',
    domains: manyDomains(3),
    sources: manySources(3),
    roles: manyRoles(3),
    agents: manyAgents(3),
    skills: manySkills(3),
    apiKey: 'sk-test-key',
    ...overrides,
  };
}

// ===================================================================
// Tests
// ===================================================================

describe('orchestrate()', () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  // -----------------------------------------------------------------------
  // Successful orchestration
  // -----------------------------------------------------------------------

  it('returns a validated workflow and raw response for valid LLM output', async () => {
    fetchMock.mockResolvedValue(mockOkResponse(VALID_WORKFLOW_JSON));

    const result = await orchestrate(defaultOptions());

    expect(result.workflow).toBeDefined();
    expect(result.workflow.name).toBe('Code Review Workflow');
    expect(result.workflow.phases).toHaveLength(2);
    expect(result.rawResponse).toBeTruthy();
    expect(typeof result.rawResponse).toBe('string');
  });

  it('calls the LLM with the correct endpoint and headers', async () => {
    fetchMock.mockResolvedValue(mockOkResponse(VALID_WORKFLOW_JSON));

    await orchestrate(defaultOptions());

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, opts] = fetchMock.mock.calls[0];

    expect(url).toContain('/chat/completions');
    expect(opts.method).toBe('POST');
    expect(opts.headers['Content-Type']).toBe('application/json');
    expect(opts.headers['Authorization']).toBe('Bearer sk-test-key');
  });

  it('includes system and user messages in the LLM request body', async () => {
    fetchMock.mockResolvedValue(mockOkResponse(VALID_WORKFLOW_JSON));

    await orchestrate(defaultOptions());

    const [, opts] = fetchMock.mock.calls[0];
    const body = JSON.parse(opts.body);

    expect(body.messages).toHaveLength(2);
    expect(body.messages[0].role).toBe('system');
    expect(body.messages[1].role).toBe('user');
    expect(body.messages[1].content).toContain('code review workflow');
  });

  it('passes the model from options', async () => {
    fetchMock.mockResolvedValue(mockOkResponse(VALID_WORKFLOW_JSON));

    await orchestrate(defaultOptions({ model: 'gpt-4-turbo' }));

    const [, opts] = fetchMock.mock.calls[0];
    const body = JSON.parse(opts.body);
    expect(body.model).toBe('gpt-4-turbo');
  });

  it('uses the model from env when not explicitly provided', async () => {
    const origModel = process.env.OPENCODE_MODEL;
    process.env.OPENCODE_MODEL = 'env-model-test';
    fetchMock.mockResolvedValue(mockOkResponse(VALID_WORKFLOW_JSON));

    try {
      await orchestrate(defaultOptions({ model: undefined }));
      const [, opts] = fetchMock.mock.calls[0];
      const body = JSON.parse(opts.body);
      expect(body.model).toBe('env-model-test');
    } finally {
      process.env.OPENCODE_MODEL = origModel;
    }
  });

  // -----------------------------------------------------------------------
  // Candidate selection verification
  // -----------------------------------------------------------------------

  it('caps large entity lists before building the prompt', async () => {
    fetchMock.mockResolvedValue(mockOkResponse(VALID_WORKFLOW_JSON));

    // Pass 100 of each — the LLM should still receive ≤10 of each
    await orchestrate({
      userRequest: 'Any workflow',
      domains: manyDomains(100),
      sources: manySources(100),
      roles: manyRoles(100),
      agents: manyAgents(100),
      skills: manySkills(100),
      apiKey: 'sk-test-key',
    });

    const [, opts] = fetchMock.mock.calls[0];
    const body = JSON.parse(opts.body);
    const systemMsg = body.messages[0].content;

    // --- Domains: count `|` rows — exactly 10 plus the 2 header rows ---
    const domainTable = extractTable(systemMsg, '### Domains');
    expect(domainTable).not.toBeNull();
    expect(domainTable!.rowCount).toBe(10);

    // --- Sources: exactly 10 rows ---
    const sourceTable = extractTable(systemMsg, '### Agent Sources');
    expect(sourceTable).not.toBeNull();
    expect(sourceTable!.rowCount).toBe(10);

    // --- Roles: roles are sorted by tier so IDs aren't sequential,
    // but the table still has at most 10 rows ---
    const roleTable = extractTable(systemMsg, '### Agent Roles');
    expect(roleTable).not.toBeNull();
    expect(roleTable!.rowCount).toBe(10);

    // --- Agents: at most 10 rows ---
    const agentTable = extractTable(systemMsg, '### Available Predefined Agents');
    expect(agentTable).not.toBeNull();
    expect(agentTable!.rowCount).toBe(10);

    // --- Skills: at most 10 rows ---
    const skillTable = extractTable(systemMsg, '### Available Skills');
    expect(skillTable).not.toBeNull();
    expect(skillTable!.rowCount).toBe(10);

    // Sanity: items 0–9 should appear in their respective tables
    // (note: roles are sorted by tier, not by index, so r9 might not appear)
    expect(systemMsg).toMatch(/\bd9\b/);
    expect(systemMsg).toMatch(/\bs9\b/);
    expect(systemMsg).toMatch(/\ba9\b/);
    expect(systemMsg).toMatch(/\bsk9\b/);
  });

  // -----------------------------------------------------------------------
  // LLM error handling
  // -----------------------------------------------------------------------

  it('throws OrchestratorLLMError when fetch rejects (network error)', async () => {
    fetchMock.mockRejectedValue(new Error('Network timeout'));

    await expect(orchestrate(defaultOptions())).rejects.toThrow(
      OrchestratorLLMError,
    );
    await expect(orchestrate(defaultOptions())).rejects.toThrow(
      'LLM request failed',
    );
  });

  it('throws OrchestratorLLMError when LLM returns non-200 status', async () => {
    fetchMock.mockResolvedValue(mockErrorResponse(429, 'Rate limited'));

    await expect(orchestrate(defaultOptions())).rejects.toThrow(
      OrchestratorLLMError,
    );
    await expect(orchestrate(defaultOptions())).rejects.toThrow(
      'LLM returned status 429',
    );
  });

  it('throws OrchestratorLLMError when API key is missing', async () => {
    const origKey = process.env.OPENCODE_API_KEY;
    const origKey2 = process.env.OPENAI_API_KEY;
    delete process.env.OPENCODE_API_KEY;
    delete process.env.OPENAI_API_KEY;

    try {
      await expect(
        orchestrate(defaultOptions({ apiKey: undefined })),
      ).rejects.toThrow(OrchestratorLLMError);
      await expect(
        orchestrate(defaultOptions({ apiKey: undefined })),
      ).rejects.toThrow('No API key available');
    } finally {
      process.env.OPENCODE_API_KEY = origKey;
      process.env.OPENAI_API_KEY = origKey2;
    }
  });

  // -----------------------------------------------------------------------
  // Parse / validation error handling
  // -----------------------------------------------------------------------

  it('throws OrchestratorValidationError when LLM returns non-JSON content', async () => {
    const badPayload = JSON.stringify({
      choices: [{ message: { content: 'This is not JSON at all' } }],
    });
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      text: () => Promise.resolve(badPayload),
    } as Response);

    await expect(orchestrate(defaultOptions())).rejects.toThrow(
      OrchestratorValidationError,
    );
    await expect(orchestrate(defaultOptions())).rejects.toThrow(
      'Failed to parse LLM response as JSON',
    );
  });

  it('throws OrchestratorValidationError when JSON fails schema validation', async () => {
    fetchMock.mockResolvedValue(
      mockOkResponse({
        name: 'Bad Workflow',
        // Missing "phases" — violates schema
      }),
    );

    await expect(orchestrate(defaultOptions())).rejects.toThrow(
      OrchestratorValidationError,
    );
    await expect(orchestrate(defaultOptions())).rejects.toThrow(
      'WorkflowDefinition validation failed',
    );
  });

  it('includes validation errors in the exception', async () => {
    fetchMock.mockResolvedValue(
      mockOkResponse({
        name: '',
        phases: [],
      }),
    );

    try {
      await orchestrate(defaultOptions());
      // Should not reach here
      expect(true).toBe(false);
    } catch (err) {
      expect(err).toBeInstanceOf(OrchestratorValidationError);
      const ve = err as OrchestratorValidationError;
      expect(ve.validationErrors).toBeDefined();
      expect(ve.validationErrors!.length).toBeGreaterThan(0);
    }
  });

  // -----------------------------------------------------------------------
  // Markdown code fence extraction
  // -----------------------------------------------------------------------

  it('extracts JSON from markdown code fences', async () => {
    fetchMock.mockResolvedValue(mockOkResponse(VALID_WORKFLOW_JSON, true));

    const result = await orchestrate(defaultOptions());
    expect(result.workflow.name).toBe('Code Review Workflow');
    expect(result.workflow.phases).toHaveLength(2);
  });

  // -----------------------------------------------------------------------
  // API key resolution
  // -----------------------------------------------------------------------

  it('uses OPENCODE_API_KEY env var when no key is provided', async () => {
    const origKey = process.env.OPENCODE_API_KEY;
    process.env.OPENCODE_API_KEY = 'env-opencode-key';
    fetchMock.mockResolvedValue(mockOkResponse(VALID_WORKFLOW_JSON));

    try {
      await orchestrate(defaultOptions({ apiKey: undefined }));
      const [, opts] = fetchMock.mock.calls[0];
      expect(opts.headers['Authorization']).toBe('Bearer env-opencode-key');
    } finally {
      process.env.OPENCODE_API_KEY = origKey;
    }
  });

  it('falls back to OPENAI_API_KEY when OPENCODE_API_KEY is not set', async () => {
    const origCodex = process.env.OPENCODE_API_KEY;
    const origOpenai = process.env.OPENAI_API_KEY;
    delete process.env.OPENCODE_API_KEY;
    process.env.OPENAI_API_KEY = 'env-openai-key';
    fetchMock.mockResolvedValue(mockOkResponse(VALID_WORKFLOW_JSON));

    try {
      await orchestrate(defaultOptions({ apiKey: undefined }));
      const [, opts] = fetchMock.mock.calls[0];
      expect(opts.headers['Authorization']).toBe('Bearer env-openai-key');
    } finally {
      process.env.OPENCODE_API_KEY = origCodex;
      process.env.OPENAI_API_KEY = origOpenai;
    }
  });

  // -----------------------------------------------------------------------
  // Base URL resolution
  // -----------------------------------------------------------------------

  it('uses the provided baseUrl', async () => {
    fetchMock.mockResolvedValue(mockOkResponse(VALID_WORKFLOW_JSON));

    await orchestrate(
      defaultOptions({ baseUrl: 'https://custom.api.com/v1' }),
    );

    const [url] = fetchMock.mock.calls[0];
    expect(url).toBe('https://custom.api.com/v1/chat/completions');
  });

  it('defaults to the standard base URL', async () => {
    const origBase = process.env.OPENAI_BASE_URL;
    delete process.env.OPENAI_BASE_URL;
    fetchMock.mockResolvedValue(mockOkResponse(VALID_WORKFLOW_JSON));

    try {
      await orchestrate(defaultOptions({ baseUrl: undefined }));
      const [url] = fetchMock.mock.calls[0];
      expect(url).toBe('https://opencode.ai/zen/v1/chat/completions');
    } finally {
      process.env.OPENAI_BASE_URL = origBase;
    }
  });
});

// ===================================================================
// Orchestrator class
// ===================================================================

describe('Orchestrator (class)', () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('delegates to orchestrate()', async () => {
    fetchMock.mockResolvedValue(mockOkResponse(VALID_WORKFLOW_JSON));

    const orchestrator = new Orchestrator();
    const result = await orchestrator.design(defaultOptions());

    expect(result.workflow.name).toBe('Code Review Workflow');
  });

  it('propagates errors from orchestrate()', async () => {
    fetchMock.mockRejectedValue(new Error('Network error'));

    const orchestrator = new Orchestrator();
    await expect(orchestrator.design(defaultOptions())).rejects.toThrow(
      OrchestratorLLMError,
    );
  });
});
