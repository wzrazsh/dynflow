import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { closeDb } from '../db/connection.js';
import { initSchema } from '../db/schema.js';
import * as repo from '../db/repository.js';
import * as registry from './registry.js';
import type { Skill, SkillCategory } from '@dynflow/shared';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Create a minimal domain + agent source so skill FK constraints are met.
 */
function setupSource(): { domainId: string; sourceId: string } {
  const domain = repo.createDomain({
    name: 'RegistryTestDomain',
    description: 'Temp domain for skill registry tests',
  });
  const source = repo.createAgentSource({
    domainId: domain.id,
    name: 'RegistryTestSource',
    url: 'https://example.com/skills',
    description: 'Temp source for skill registry tests',
  });
  return { domainId: domain.id, sourceId: source.id };
}

/**
 * Sample skill data (without id) using a given source.
 */
function sampleSkill(sourceId: string): Omit<Skill, 'id'> {
  return {
    sourceId,
    name: 'Code Search',
    description: 'Search code in repository',
    category: 'development',
    parameters: [
      { name: 'query', type: 'string', description: 'The search query', required: true },
      { name: 'limit', type: 'number', description: 'Max results', required: false, defaultValue: 10 },
    ],
    inputSchema: { type: 'object', properties: { query: { type: 'string' } } },
    outputSchema: { type: 'array', items: { type: 'string' } },
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

describe('getSkills', () => {
  it('1 — returns empty array when no skills exist', () => {
    const skills = registry.getSkills();
    expect(skills).toEqual([]);
  });

  it('2 — returns all skills ordered by name', () => {
    const { sourceId } = setupSource();

    registry.addSkill({
      sourceId,
      name: 'Beta',
      description: 'Second skill',
      category: 'analysis',
      parameters: [],
    });
    registry.addSkill({
      sourceId,
      name: 'Alpha',
      description: 'First skill',
      category: 'development',
      parameters: [],
    });
    registry.addSkill({
      sourceId,
      name: 'Gamma',
      description: 'Third skill',
      category: 'research',
      parameters: [],
    });

    const skills = registry.getSkills();
    expect(skills).toHaveLength(3);
    expect(skills[0].name).toBe('Alpha');
    expect(skills[1].name).toBe('Beta');
    expect(skills[2].name).toBe('Gamma');
  });
});

describe('getSkillsBySource', () => {
  it('3 — returns skills for a specific source only', () => {
    const { sourceId: srcA } = setupSource();
    // Create a second source under the same domain
    // Simpler: just create a second source under existing domain
    const domainId = repo.getAllDomains()[0].id;
    const srcB = repo.createAgentSource({
      domainId,
      name: 'SourceB',
      url: 'https://b.example.com',
      description: 'Second source',
    });

    registry.addSkill({
      sourceId: srcA,
      name: 'Only in A',
      description: 'Skill for source A',
      category: 'development',
      parameters: [],
    });
    registry.addSkill({
      sourceId: srcB.id,
      name: 'Only in B',
      description: 'Skill for source B',
      category: 'analysis',
      parameters: [],
    });

    const skillsA = registry.getSkillsBySource(srcA);
    expect(skillsA).toHaveLength(1);
    expect(skillsA[0].name).toBe('Only in A');

    const skillsB = registry.getSkillsBySource(srcB.id);
    expect(skillsB).toHaveLength(1);
    expect(skillsB[0].name).toBe('Only in B');
  });

  it('4 — returns empty array for source with no skills', () => {
    const { sourceId } = setupSource();
    const skills = registry.getSkillsBySource(sourceId);
    expect(skills).toEqual([]);
  });
});

describe('getSkillsByCategory', () => {
  it('5 — filters skills by category', () => {
    const { sourceId } = setupSource();

    registry.addSkill({
      sourceId,
      name: 'Dev Skill',
      description: 'A development skill',
      category: 'development',
      parameters: [],
    });
    registry.addSkill({
      sourceId,
      name: 'Analysis Skill',
      description: 'An analysis skill',
      category: 'analysis',
      parameters: [],
    });
    registry.addSkill({
      sourceId,
      name: 'Another Dev',
      description: 'Another dev skill',
      category: 'development',
      parameters: [],
    });

    const devSkills = registry.getSkillsByCategory('development');
    expect(devSkills).toHaveLength(2);
    expect(devSkills[0].name).toBe('Another Dev');
    expect(devSkills[1].name).toBe('Dev Skill');

    const analysisSkills = registry.getSkillsByCategory('analysis');
    expect(analysisSkills).toHaveLength(1);
    expect(analysisSkills[0].name).toBe('Analysis Skill');
  });

  it('6 — returns empty array for category with no skills', () => {
    const { sourceId } = setupSource();
    registry.addSkill({
      sourceId,
      name: 'Only Dev',
      description: 'Only dev skill',
      category: 'development',
      parameters: [],
    });

    const researchSkills = registry.getSkillsByCategory('research');
    expect(researchSkills).toEqual([]);
  });
});

describe('addSkill', () => {
  it('7 — creates a skill with all fields and returns it with an id', () => {
    const { sourceId } = setupSource();
    const data = sampleSkill(sourceId);

    const skill = registry.addSkill(data);

    expect(skill.id).toBeDefined();
    expect(typeof skill.id).toBe('string');
    expect(skill.sourceId).toBe(sourceId);
    expect(skill.name).toBe('Code Search');
    expect(skill.description).toBe('Search code in repository');
    expect(skill.category).toBe('development');
    expect(skill.parameters).toHaveLength(2);
    expect(skill.parameters[0].name).toBe('query');
    expect(skill.parameters[0].required).toBe(true);
    expect(skill.parameters[1].defaultValue).toBe(10);
    expect(skill.inputSchema).toBeDefined();
    expect(skill.outputSchema).toBeDefined();

    // Verify it is persisted
    const retrieved = repo.getSkill(skill.id);
    expect(retrieved).toBeDefined();
    expect(retrieved!.name).toBe('Code Search');
  });

  it('8 — creates a skill with minimal fields', () => {
    const { sourceId } = setupSource();
    const skill = registry.addSkill({
      sourceId,
      name: 'Minimal',
      description: 'Minimal skill',
      category: 'other',
      parameters: [],
    });

    expect(skill.id).toBeDefined();
    expect(skill.parameters).toEqual([]);
    expect(skill.inputSchema).toBeUndefined();
    expect(skill.outputSchema).toBeUndefined();
  });
});

describe('updateSkill', () => {
  it('9 — partially updates a skill', () => {
    const { sourceId } = setupSource();
    const skill = registry.addSkill(sampleSkill(sourceId));

    const updated = registry.updateSkill(skill.id, {
      name: 'Updated Name',
      category: 'research',
    });

    expect(updated).toBeDefined();
    expect(updated!.id).toBe(skill.id);
    expect(updated!.name).toBe('Updated Name');
    expect(updated!.category).toBe('research');
    // Unchanged fields preserved
    expect(updated!.description).toBe('Search code in repository');
    expect(updated!.sourceId).toBe(sourceId);
    expect(updated!.parameters).toHaveLength(2);
  });

  it('10 — updates parameters and schemas', () => {
    const { sourceId } = setupSource();
    const skill = registry.addSkill(sampleSkill(sourceId));

    const updated = registry.updateSkill(skill.id, {
      parameters: [
        { name: 'newParam', type: 'boolean', description: 'A new param', required: true },
      ],
      inputSchema: { type: 'object', properties: { newParam: { type: 'boolean' } } },
    });

    expect(updated).toBeDefined();
    expect(updated!.parameters).toHaveLength(1);
    expect(updated!.parameters[0].name).toBe('newParam');
    expect(updated!.inputSchema).toBeDefined();
    // outputSchema not provided in update data so it keeps the original value
    expect(updated!.outputSchema).toEqual({ type: 'array', items: { type: 'string' } });
  });

  it('11 — returns undefined for non-existent skill', () => {
    const result = registry.updateSkill('non-existent-id', { name: 'Nope' });
    expect(result).toBeUndefined();
  });

  it('12 — returns existing skill when no fields are provided to update', () => {
    const { sourceId } = setupSource();
    const skill = registry.addSkill(sampleSkill(sourceId));

    const updated = registry.updateSkill(skill.id, {});
    expect(updated).toBeDefined();
    expect(updated!.name).toBe('Code Search');
  });
});

describe('deleteSkill', () => {
  it('13 — returns true and removes an existing skill', () => {
    const { sourceId } = setupSource();
    const skill = registry.addSkill(sampleSkill(sourceId));

    const deleted = registry.deleteSkill(skill.id);
    expect(deleted).toBe(true);

    // Verify it's gone
    expect(repo.getSkill(skill.id)).toBeUndefined();
    expect(registry.getSkills()).toHaveLength(0);
  });

  it('14 — returns false for non-existent skill', () => {
    const result = registry.deleteSkill('non-existent-id');
    expect(result).toBe(false);
  });
});

describe('importFromJSON', () => {
  it('15 — imports multiple skills', () => {
    const { sourceId } = setupSource();

    const result = registry.importFromJSON({
      skills: [
        {
          sourceId,
          name: 'Imported A',
          description: 'First imported skill',
          category: 'analysis' as SkillCategory,
          parameters: [],
        },
        {
          sourceId,
          name: 'Imported B',
          description: 'Second imported skill',
          category: 'development' as SkillCategory,
          parameters: [],
        },
      ],
    });

    expect(result.count).toBe(2);
    const all = registry.getSkills();
    expect(all).toHaveLength(2);
    expect(all[0].name).toBe('Imported A');
    expect(all[1].name).toBe('Imported B');
  });

  it('16 — handles empty skills array', () => {
    const result = registry.importFromJSON({ skills: [] });
    expect(result.count).toBe(0);
    expect(registry.getSkills()).toHaveLength(0);
  });
});
