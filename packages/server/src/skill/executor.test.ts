import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { closeDb } from '../db/connection.js';
import { initSchema } from '../db/schema.js';
import * as repo from '../db/repository.js';
import * as registry from './registry.js';
import { SkillExecutor } from './executor.js';
import type { Skill, SkillCategory } from '@dynflow/shared';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Create a minimal domain + agent source so skill FK constraints are met.
 */
function setupSource(): { domainId: string; sourceId: string } {
  const domain = repo.createDomain({
    name: 'ExecutorTestDomain',
    description: 'Temp domain for executor tests',
  });
  const source = repo.createAgentSource({
    domainId: domain.id,
    name: 'ExecutorTestSource',
    url: 'https://example.com/executor-test',
    description: 'Temp source for executor tests',
  });
  return { domainId: domain.id, sourceId: source.id };
}

/**
 * Build a sample skill for each category.
 */
function skillForCategory(
  sourceId: string,
  category: SkillCategory,
  name?: string,
): Omit<Skill, 'id'> {
  return {
    sourceId,
    name: name ?? `${category.charAt(0).toUpperCase() + category.slice(1)} Skill`,
    description: `A ${category} skill for testing`,
    category,
    parameters: [
      { name: 'input', type: 'string', description: 'Main input', required: true },
      { name: 'optional', type: 'number', description: 'Optional param', required: false, defaultValue: 42 },
    ],
    inputSchema: { type: 'object', properties: { input: { type: 'string' } } },
    outputSchema: { type: 'object' },
  };
}

// ---------------------------------------------------------------------------
// Setup — fresh in-memory DB before each test
// ---------------------------------------------------------------------------

beforeEach(() => {
  closeDb();
  process.env.DB_PATH = ':memory:';
  initSchema();
});

afterAll(() => {
  closeDb();
  delete process.env.DB_PATH;
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('SkillExecutor — execute (by ID)', () => {
  it('1 — returns error for non-existent skill ID', async () => {
    const executor = new SkillExecutor();
    const result = await executor.execute('non-existent-id', {});

    expect(result.success).toBe(false);
    expect(result.error).toContain('Skill not found');
    expect(result.executionTimeMs).toBeGreaterThanOrEqual(0);
    expect(result.output).toBeUndefined();
  });

  it('2 — returns error when required parameter is missing', async () => {
    const { sourceId } = setupSource();
    const skill = registry.addSkill(skillForCategory(sourceId, 'analysis'));

    const executor = new SkillExecutor();
    const result = await executor.execute(skill.id, {});

    expect(result.success).toBe(false);
    expect(result.error).toContain('Missing required parameter: input');
    expect(result.executionTimeMs).toBeGreaterThanOrEqual(0);
  });

  it('3 — returns error when required parameter is null', async () => {
    const { sourceId } = setupSource();
    const skill = registry.addSkill(skillForCategory(sourceId, 'analysis'));

    const executor = new SkillExecutor();
    const result = await executor.execute(skill.id, { input: null });

    expect(result.success).toBe(false);
    expect(result.error).toContain('Missing required parameter: input');
  });

  it('4 — executes analysis skill and returns structured output', async () => {
    const { sourceId } = setupSource();
    const skill = registry.addSkill(skillForCategory(sourceId, 'analysis'));

    const executor = new SkillExecutor();
    const result = await executor.execute(skill.id, { input: 'hello world', extra: true });

    expect(result.success).toBe(true);
    expect(result.executionTimeMs).toBeGreaterThanOrEqual(0);
    expect(result.output).toBeDefined();
    const out = result.output as Record<string, unknown>;
    expect(out.category).toBe('analysis');
    expect(out.skillName).toBe('Analysis Skill');

    const analysis = out.analysis as Record<string, unknown>;
    expect(analysis.input).toBeDefined();
    expect((analysis.input as Record<string, unknown>).value).toBe('hello world');
    expect((analysis.input as Record<string, unknown>).analyzed).toBe(true);
    expect(analysis.extra).toBeDefined();
    expect((analysis.extra as Record<string, unknown>).analyzed).toBe(true);
  });
});

describe('SkillExecutor — executeByName', () => {
  it('5 — returns error when source has no matching skill', async () => {
    const { sourceId } = setupSource();
    // Register one skill but look for a different name
    registry.addSkill(skillForCategory(sourceId, 'development', 'DevHelper'));

    const executor = new SkillExecutor();
    const result = await executor.executeByName(sourceId, 'NonExistent', {});

    expect(result.success).toBe(false);
    expect(result.error).toContain('"NonExistent" not found for source');
  });

  it('6 — executes skill found by source + name', async () => {
    const { sourceId } = setupSource();
    registry.addSkill(skillForCategory(sourceId, 'research', 'WebSearch'));

    const executor = new SkillExecutor();
    const result = await executor.executeByName(sourceId, 'WebSearch', { input: 'test query' });

    expect(result.success).toBe(true);
    expect(result.output).toBeDefined();
    const out = result.output as Record<string, unknown>;
    expect(out.skillName).toBe('WebSearch');
    expect(out.category).toBe('research');
  });

  it('7 — returns error for unknown source', async () => {
    const executor = new SkillExecutor();
    const result = await executor.executeByName('nonexistent-source', 'Any', {});

    expect(result.success).toBe(false);
    expect(result.error).toContain('not found for source');
  });
});

describe('SkillExecutor — all categories execute without error', () => {
  const categories: SkillCategory[] = [
    'analysis',
    'research',
    'development',
    'communication',
    'automation',
    'creative',
    'other',
  ];

  for (const category of categories) {
    it(`8 — executes ${category} skill successfully`, async () => {
      const { sourceId } = setupSource();
      const skill = registry.addSkill(skillForCategory(sourceId, category));

      const executor = new SkillExecutor();
      const result = await executor.execute(skill.id, { input: 'test' });

      expect(result.success).toBe(true);
      expect(result.output).toBeDefined();
      const out = result.output as Record<string, unknown>;
      expect(out.category).toBe(category);
      expect(out.skillName).toBe(
        `${category.charAt(0).toUpperCase() + category.slice(1)} Skill`,
      );
    });
  }
});

describe('SkillExecutor — execution time tracking', () => {
  it('9 — executionTimeMs is measured for successful execution', async () => {
    const { sourceId } = setupSource();
    const skill = registry.addSkill(skillForCategory(sourceId, 'analysis'));

    const executor = new SkillExecutor();
    const result = await executor.execute(skill.id, { input: 'timing test' });

    expect(result.success).toBe(true);
    expect(result.executionTimeMs).toBeGreaterThanOrEqual(0);
    expect(typeof result.executionTimeMs).toBe('number');
  });

  it('10 — executionTimeMs is reported for failed executions too', async () => {
    const executor = new SkillExecutor();
    const result = await executor.execute('bad-id', {});

    expect(result.success).toBe(false);
    expect(result.executionTimeMs).toBeGreaterThanOrEqual(0);
  });
});

describe('SkillExecutor — error handling', () => {
  it('11 — gracefully handles skills with empty parameters', async () => {
    const { sourceId } = setupSource();
    const skill = registry.addSkill({
      sourceId,
      name: 'NoParams',
      description: 'Skill with no parameters',
      category: 'other',
      parameters: [],
    });

    const executor = new SkillExecutor();
    const result = await executor.execute(skill.id, {});

    expect(result.success).toBe(true);
    expect(result.output).toBeDefined();
  });

  it('12 — optional parameter validation does not block execution', async () => {
    const { sourceId } = setupSource();
    const skill = registry.addSkill(skillForCategory(sourceId, 'communication'));

    const executor = new SkillExecutor();
    // Should succeed even without the optional param
    const result = await executor.execute(skill.id, { input: 'msg' });

    expect(result.success).toBe(true);
  });

  it('13 — default values from skill definition are not injected (executor is agnostic)', async () => {
    // The executor does not inject defaults — that's the caller's responsibility.
    // This test verifies the executor passes through whatever it receives.
    const { sourceId } = setupSource();
    const skill = registry.addSkill({
      sourceId,
      name: 'WithDefault',
      description: 'Skill with a default-valued param',
      category: 'other',
      parameters: [
        { name: 'requiredParam', type: 'string', description: 'Required', required: true },
        { name: 'withDefault', type: 'number', description: 'Has default', required: false, defaultValue: 100 },
      ],
    });

    const executor = new SkillExecutor();
    const result = await executor.execute(skill.id, { requiredParam: 'ok' });

    expect(result.success).toBe(true);
    const out = result.output as Record<string, unknown>;
    // The "other" handler includes the full input
    const inp = out.input as Record<string, unknown>;
    expect(inp.requiredParam).toBe('ok');
    // The default is NOT filled in by the executor
    expect(inp.withDefault).toBeUndefined();
  });

  it('14 — handles malformed input gracefully (non-object values)', async () => {
    const { sourceId } = setupSource();
    const skill = registry.addSkill(skillForCategory(sourceId, 'development'));

    const executor = new SkillExecutor();
    // The skill requires 'input' which is missing, so validation fails gracefully
    const result = await executor.execute(skill.id, { irrelevant: 'data' });

    expect(result.success).toBe(false);
    expect(result.error).toContain('Missing required parameter');
  });
});
