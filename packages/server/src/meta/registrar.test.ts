import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { closeDb } from '../db/connection.js';
import { initSchema } from '../db/schema.js';
import { registerProject } from './registrar.js';
import {
  getAllDomains,
  getSourcesByDomain,
  getRolesBySource,
  getAgentsByRole,
  getSkillsBySource,
  getAgentSkills,
} from '../db/repository.js';
import type { ExtractedAgent, ExtractedSkill } from './extractor.js';
import type { SkillCategory, SkillParameter } from '@dynflow/shared';

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
// Fixture helpers
// ---------------------------------------------------------------------------

function sampleAgent(overrides?: Partial<ExtractedAgent>): ExtractedAgent {
  return {
    name: 'code-reviewer',
    description: 'Reviews code for quality and best practices',
    systemPrompt: 'You are a code reviewer. Be thorough.',
    availableSkills: [],
    source: 'agents/reviewer.json',
    ...overrides,
  };
}

function sampleSkill(overrides?: Partial<ExtractedSkill>): ExtractedSkill {
  const params: SkillParameter[] = [
    { name: 'code', type: 'string', description: 'Source code', required: true },
  ];
  return {
    name: 'code-analysis',
    description: 'Analyzes source code for patterns and issues',
    category: 'development' as SkillCategory,
    parameters: params,
    source: 'skills/analysis.json',
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('registerProject', () => {
  // -----------------------------------------------------------------------
  // Basic registration
  // -----------------------------------------------------------------------

  it('1 — registers a project with agents and skills', () => {
    const agents = [sampleAgent()];
    const skills = [sampleSkill()];

    const result = registerProject('TestProject', 'https://github.com/test/project', agents, skills);

    // Result metadata
    expect(result.success).toBe(true);
    expect(result.domainId).toBeDefined();
    expect(result.sourceId).toBeDefined();
    expect(result.agentsCount).toBe(1);
    expect(result.skillsCount).toBe(1);
    expect(result.rolesCount).toBe(1);
    expect(result.warnings).toHaveLength(0);

    // Verify domain exists
    const domains = getAllDomains();
    expect(domains).toHaveLength(1);
    expect(domains[0].name).toBe('TestProject');

    // Verify source exists under domain
    const sources = getSourcesByDomain(result.domainId!);
    expect(sources).toHaveLength(1);
    expect(sources[0].url).toBe('https://github.com/test/project');

    // Verify role exists under source
    const roles = getRolesBySource(result.sourceId!);
    expect(roles).toHaveLength(1);
    expect(roles[0].name).toBe('code-reviewer');

    // Verify predefined agent exists under role
    const agentsInDb = getAgentsByRole(roles[0].id);
    expect(agentsInDb).toHaveLength(1);
    expect(agentsInDb[0].name).toBe('code-reviewer');
    expect(agentsInDb[0].systemPrompt).toBe('You are a code reviewer. Be thorough.');

    // Verify skill exists under source
    const skillsInDb = getSkillsBySource(result.sourceId!);
    expect(skillsInDb).toHaveLength(1);
    expect(skillsInDb[0].name).toBe('code-analysis');
    expect(skillsInDb[0].category).toBe('development');
  });

  it('2 — registers multiple agents and skills', () => {
    const agents: ExtractedAgent[] = [
      sampleAgent({ name: 'reviewer', description: 'Code reviewer' }),
      sampleAgent({ name: 'tester', description: 'Test runner' }),
    ];
    const skills: ExtractedSkill[] = [
      sampleSkill({ name: 'lint', category: 'development' }),
      sampleSkill({ name: 'test', category: 'automation' }),
    ];

    const result = registerProject('Multi', 'https://github.com/test/multi', agents, skills);

    expect(result.success).toBe(true);
    expect(result.agentsCount).toBe(2);
    expect(result.skillsCount).toBe(2);
    expect(result.rolesCount).toBe(2);
    expect(result.warnings).toHaveLength(0);

    // Verify 2 skills in DB
    const skillsInDb = getSkillsBySource(result.sourceId!);
    expect(skillsInDb).toHaveLength(2);
    expect(skillsInDb.map((s) => s.name).sort()).toEqual(['lint', 'test']);

    // Verify 2 roles in DB
    const roles = getRolesBySource(result.sourceId!);
    expect(roles).toHaveLength(2);
  });

  // -----------------------------------------------------------------------
  // Empty lists
  // -----------------------------------------------------------------------

  it('3 — registers a project with only agents (no skills)', () => {
    const agents = [sampleAgent()];

    const result = registerProject('AgentsOnly', 'https://github.com/test/agents-only', agents, []);

    expect(result.success).toBe(true);
    expect(result.agentsCount).toBe(1);
    expect(result.skillsCount).toBe(0);
    expect(result.rolesCount).toBe(1);
    expect(result.warnings).toHaveLength(0);

    const skillsInDb = getSkillsBySource(result.sourceId!);
    expect(skillsInDb).toHaveLength(0);
  });

  it('4 — registers a project with only skills (no agents)', () => {
    const skills = [sampleSkill()];

    const result = registerProject('SkillsOnly', 'https://github.com/test/skills-only', [], skills);

    expect(result.success).toBe(true);
    expect(result.agentsCount).toBe(0);
    expect(result.skillsCount).toBe(1);
    expect(result.rolesCount).toBe(0);
    expect(result.warnings).toHaveLength(0);

    const roles = getRolesBySource(result.sourceId!);
    expect(roles).toHaveLength(0);
  });

  it('5 — registers a project with empty agents and skills', () => {
    const result = registerProject('Empty', 'https://github.com/test/empty', [], []);

    expect(result.success).toBe(true);
    expect(result.agentsCount).toBe(0);
    expect(result.skillsCount).toBe(0);
    expect(result.rolesCount).toBe(0);
    expect(result.warnings).toHaveLength(0);

    // Domain and source should still be created
    const domains = getAllDomains();
    expect(domains).toHaveLength(1);
    expect(domains[0].name).toBe('Empty');
  });

  // -----------------------------------------------------------------------
  // Duplicate handling
  // -----------------------------------------------------------------------

  it('6 — warns when registering the same project twice', () => {
    const agents = [sampleAgent()];
    const skills = [sampleSkill()];

    // First registration
    const first = registerProject('Dup', 'https://github.com/test/dup', agents, skills);
    expect(first.warnings).toHaveLength(0);

    // Second registration with same project name & URL
    const second = registerProject('Dup', 'https://github.com/test/dup', agents, skills);
    expect(second.warnings.length).toBeGreaterThanOrEqual(1);
    // Should contain domain reuse warning
    expect(second.warnings.some((w) => w.includes('Domain'))).toBe(true);
    // Should contain source reuse warning
    expect(second.warnings.some((w) => w.includes('Source'))).toBe(true);
  });

  it('7 — warns when registering duplicate agents under the same project', () => {
    const agents = [sampleAgent()];

    // First pass
    const first = registerProject('DupAgent', 'https://github.com/test/dup-agent', agents, []);
    expect(first.warnings).toHaveLength(0);

    // Second pass — same agent names
    const second = registerProject('DupAgent', 'https://github.com/test/dup-agent', agents, []);
    expect(second.warnings.length).toBeGreaterThanOrEqual(1);
    expect(second.warnings.some((w) => w.includes('already exists'))).toBe(true);
  });

  it('8 — warns when registering duplicate skills', () => {
    const skills = [sampleSkill()];

    const first = registerProject('DupSkill', 'https://github.com/test/dup-skill', [], skills);
    expect(first.warnings).toHaveLength(0);

    const second = registerProject('DupSkill', 'https://github.com/test/dup-skill', [], skills);
    expect(second.warnings.length).toBeGreaterThanOrEqual(1);
    expect(second.warnings.some((w) => w.includes('already exists'))).toBe(true);
  });

  // -----------------------------------------------------------------------
  // Agent-skill linking
  // -----------------------------------------------------------------------

  it('9 — links agents to skills when skill names match', () => {
    const skill = sampleSkill({ name: 'code-analysis' });
    const agent = sampleAgent({
      name: 'reviewer',
      availableSkills: ['code-analysis'],
    });

    const result = registerProject('Linked', 'https://github.com/test/linked', [agent], [skill]);
    expect(result.warnings).toHaveLength(0);

    // Verify the agent-skill link exists
    const roles = getRolesBySource(result.sourceId!);
    const agentsInDb = getAgentsByRole(roles[0].id);
    const agentSkills = getAgentSkills(agentsInDb[0].id);
    expect(agentSkills).toHaveLength(1);

    // Verify the skill ID matches
    const skillsInDb = getSkillsBySource(result.sourceId!);
    expect(agentSkills[0]).toBe(skillsInDb[0].id);
  });

  it('10 — warns when agent references a nonexistent skill', () => {
    const agent = sampleAgent({
      name: 'reviewer',
      availableSkills: ['nonexistent-skill'],
    });

    const result = registerProject('MissingSkill', 'https://github.com/test/missing-skill', [agent], []);
    expect(result.warnings.length).toBeGreaterThanOrEqual(1);
    expect(result.warnings.some((w) => w.includes('not found'))).toBe(true);
  });

  it('11 — links agents to multiple skills', () => {
    const skills: ExtractedSkill[] = [
      sampleSkill({ name: 'lint', category: 'development' }),
      sampleSkill({ name: 'test', category: 'automation' }),
    ];
    const agent = sampleAgent({
      name: 'multi-skill-agent',
      availableSkills: ['lint', 'test'],
    });

    const result = registerProject('MultiLink', 'https://github.com/test/multi-link', [agent], skills);
    expect(result.warnings).toHaveLength(0);

    const roles = getRolesBySource(result.sourceId!);
    const agentsInDb = getAgentsByRole(roles[0].id);
    const agentSkills = getAgentSkills(agentsInDb[0].id);
    expect(agentSkills).toHaveLength(2);
  });

  it('12 — agent with no availableSkills gets no links', () => {
    const skills = [sampleSkill()];
    const agent = sampleAgent({ name: 'no-skill-agent', availableSkills: [] });

    const result = registerProject('NoLinks', 'https://github.com/test/no-links', [agent], skills);
    expect(result.warnings).toHaveLength(0);

    const roles = getRolesBySource(result.sourceId!);
    const agentsInDb = getAgentsByRole(roles[0].id);
    const agentSkills = getAgentSkills(agentsInDb[0].id);
    expect(agentSkills).toHaveLength(0);
  });

  // -----------------------------------------------------------------------
  // Warning collection edge cases
  // -----------------------------------------------------------------------

  it('13 — collects multiple warnings from the same pass', () => {
    // Register the same project twice to trigger domain + source warnings,
    // then verify warnings contains both
    const agent = sampleAgent();
    const skill = sampleSkill();

    registerProject('WarnTest', 'https://github.com/test/warn', [agent], [skill]);
    const second = registerProject('WarnTest', 'https://github.com/test/warn', [agent], [skill]);

    // Should have at least: domain reuse, source reuse, role reuse, agent skip, skill reuse
    expect(second.warnings.length).toBeGreaterThanOrEqual(4);
  });

  it('14 — registration still succeeds despite warnings', () => {
    const agent = sampleAgent({ availableSkills: ['missing-skill'] });

    const result = registerProject('WarnButOk', 'https://github.com/test/warn-ok', [agent], []);

    expect(result.success).toBe(true);
    expect(result.warnings.length).toBeGreaterThanOrEqual(1);
    expect(result.domainId).toBeDefined();
    expect(result.sourceId).toBeDefined();
  });
});
