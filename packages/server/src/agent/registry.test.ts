import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { closeDb } from '../db/connection.js';
import { initSchema } from '../db/schema.js';
import * as repo from '../db/repository.js';
import * as registry from './registry.js';

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
// Helpers
// ---------------------------------------------------------------------------

/** Seed a minimal hierarchy and return IDs. */
function seedMinimal() {
  const domain = repo.createDomain({
    name: 'Code Analysis',
    description: 'Tools for analyzing code',
  });
  const source = repo.createAgentSource({
    domainId: domain.id,
    name: 'GitHub',
    url: 'https://github.com',
    description: 'GitHub trending repos',
  });
  const role = repo.createAgentRole({
    sourceId: source.id,
    name: 'Reviewer',
    description: 'Code reviewer role',
    tier: 1,
  });
  const agent = repo.createPredefinedAgent({
    roleId: role.id,
    name: 'Linter',
    description: 'Lints code',
    systemPrompt: 'You are a linter.',
  });
  return { domain, source, role, agent };
}

// ---------------------------------------------------------------------------
// getDomains / addDomain / updateDomain / deleteDomain
// ---------------------------------------------------------------------------

describe('domains', () => {
  it('1 — getDomains returns empty array initially', () => {
    expect(registry.getDomains()).toEqual([]);
  });

  it('2 — addDomain creates a domain and returns it with an ID', () => {
    const d = registry.addDomain({
      name: 'Web Dev',
      description: 'Web development tools',
      icon: 'globe',
    });
    expect(d.id).toBeDefined();
    expect(d.name).toBe('Web Dev');
    expect(d.description).toBe('Web development tools');
    expect(d.icon).toBe('globe');

    const all = registry.getDomains();
    expect(all).toHaveLength(1);
    expect(all[0].id).toBe(d.id);
  });

  it('3 — getDomains returns alphabetical order', () => {
    registry.addDomain({ name: 'Zoo', description: 'Last' });
    registry.addDomain({ name: 'Alpha', description: 'First' });
    registry.addDomain({ name: 'Beta', description: 'Middle' });

    const all = registry.getDomains();
    expect(all.map((d) => d.name)).toEqual(['Alpha', 'Beta', 'Zoo']);
  });

  it('4 — updateDomain updates selected fields', () => {
    const d = registry.addDomain({ name: 'Old', description: 'Old desc' });
    const updated = registry.updateDomain(d.id, { name: 'New', icon: 'star' });

    expect(updated).toBeDefined();
    expect(updated!.name).toBe('New');
    expect(updated!.description).toBe('Old desc'); // unchanged
    expect(updated!.icon).toBe('star');
  });

  it('5 — updateDomain returns undefined for non-existent id', () => {
    const result = registry.updateDomain('nonexistent', { name: 'Nope' });
    expect(result).toBeUndefined();
  });

  it('6 — updateDomain with no changes returns the existing entity', () => {
    const d = registry.addDomain({ name: 'Stable', description: 'Stable' });
    const updated = registry.updateDomain(d.id, {});
    expect(updated).toBeDefined();
    expect(updated!.name).toBe('Stable');
  });

  it('7 — deleteDomain returns true and removes the domain', () => {
    const d = registry.addDomain({ name: 'Temp', description: 'Temporary' });
    const deleted = registry.deleteDomain(d.id);
    expect(deleted).toBe(true);
    expect(registry.getDomains()).toHaveLength(0);
  });

  it('8 — deleteDomain returns false for non-existent id', () => {
    expect(registry.deleteDomain('nonexistent')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// getSourcesByDomain / addSource / updateSource / deleteSource
// ---------------------------------------------------------------------------

describe('agent sources', () => {
  it('9 — getSourcesByDomain returns empty for a domain with no sources', () => {
    const d = registry.addDomain({ name: 'Empty', description: 'No sources' });
    expect(registry.getSourcesByDomain(d.id)).toEqual([]);
  });

  it('10 — addSource under a domain', () => {
    const d = registry.addDomain({ name: 'Data', description: 'Data domain' });
    const s = registry.addSource({
      domainId: d.id,
      name: 'Hugging Face',
      url: 'https://huggingface.co',
      description: 'ML models',
    });

    expect(s.id).toBeDefined();
    expect(s.domainId).toBe(d.id);
    expect(s.name).toBe('Hugging Face');
  });

  it('11 — getSourcesByDomain lists sources in alphabetical order', () => {
    const d = registry.addDomain({ name: 'D', description: 'D' });
    registry.addSource({ domainId: d.id, name: 'Zeta', url: 'https://z', description: 'Z' });
    registry.addSource({ domainId: d.id, name: 'Alpha', url: 'https://a', description: 'A' });

    const sources = registry.getSourcesByDomain(d.id);
    expect(sources.map((s) => s.name)).toEqual(['Alpha', 'Zeta']);
  });

  it('12 — updateSource updates url and name', () => {
    const d = registry.addDomain({ name: 'D', description: 'D' });
    const s = registry.addSource({
      domainId: d.id,
      name: 'Old Source',
      url: 'https://old',
      description: 'Old',
    });
    const updated = registry.updateSource(s.id, { name: 'New Source', url: 'https://new' });
    expect(updated).toBeDefined();
    expect(updated!.name).toBe('New Source');
    expect(updated!.url).toBe('https://new');
    expect(updated!.description).toBe('Old'); // unchanged
  });

  it('13 — updateSource returns undefined for non-existent id', () => {
    expect(registry.updateSource('nonexistent', { name: 'Nope' })).toBeUndefined();
  });

  it('14 — deleteSource returns true and removes the source', () => {
    const d = registry.addDomain({ name: 'D', description: 'D' });
    const s = registry.addSource({
      domainId: d.id,
      name: 'Del',
      url: 'https://del',
      description: 'Delete me',
    });
    expect(registry.deleteSource(s.id)).toBe(true);
    expect(registry.getSourcesByDomain(d.id)).toHaveLength(0);
  });

  it('15 — deleteSource returns false for non-existent id', () => {
    expect(registry.deleteSource('nonexistent')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// getRolesBySource / addRole / updateRole / deleteRole
// ---------------------------------------------------------------------------

describe('agent roles', () => {
  it('16 — getRolesBySource returns empty for a source with no roles', () => {
    const d = registry.addDomain({ name: 'D', description: 'D' });
    const s = registry.addSource({
      domainId: d.id,
      name: 'S',
      url: 'https://s',
      description: 'S',
    });
    expect(registry.getRolesBySource(s.id)).toEqual([]);
  });

  it('17 — addRole creates a role and defaults tier to 0', () => {
    const d = registry.addDomain({ name: 'D', description: 'D' });
    const s = registry.addSource({
      domainId: d.id,
      name: 'S',
      url: 'https://s',
      description: 'S',
    });
    const r = registry.addRole({
      sourceId: s.id,
      name: 'Tester',
      description: 'Tests things',
    });
    expect(r.id).toBeDefined();
    expect(r.sourceId).toBe(s.id);
    expect(r.name).toBe('Tester');
    expect(r.tier).toBe(0);
  });

  it('18 — getRolesBySource returns roles ordered by tier then name', () => {
    const d = registry.addDomain({ name: 'D', description: 'D' });
    const s = registry.addSource({
      domainId: d.id,
      name: 'S',
      url: 'https://s',
      description: 'S',
    });
    registry.addRole({ sourceId: s.id, name: 'Low', description: 'Low', tier: 2 });
    registry.addRole({ sourceId: s.id, name: 'High', description: 'High', tier: 0 });
    registry.addRole({ sourceId: s.id, name: 'Mid', description: 'Mid', tier: 1 });

    const roles = registry.getRolesBySource(s.id);
    expect(roles.map((r) => r.name)).toEqual(['High', 'Mid', 'Low']);
  });

  it('19 — updateRole updates tier and name', () => {
    const d = registry.addDomain({ name: 'D', description: 'D' });
    const s = registry.addSource({
      domainId: d.id,
      name: 'S',
      url: 'https://s',
      description: 'S',
    });
    const r = registry.addRole({
      sourceId: s.id,
      name: 'Old Role',
      description: 'Desc',
      tier: 5,
    });
    const updated = registry.updateRole(r.id, { name: 'New Role', tier: 1 });
    expect(updated).toBeDefined();
    expect(updated!.name).toBe('New Role');
    expect(updated!.tier).toBe(1);
    expect(updated!.description).toBe('Desc'); // unchanged
  });

  it('20 — updateRole returns undefined for non-existent id', () => {
    expect(registry.updateRole('nonexistent', { name: 'Nope' })).toBeUndefined();
  });

  it('21 — deleteRole returns true and removes the role', () => {
    const d = registry.addDomain({ name: 'D', description: 'D' });
    const s = registry.addSource({
      domainId: d.id,
      name: 'S',
      url: 'https://s',
      description: 'S',
    });
    const r = registry.addRole({
      sourceId: s.id,
      name: 'Del',
      description: 'Delete me',
    });
    expect(registry.deleteRole(r.id)).toBe(true);
    expect(registry.getRolesBySource(s.id)).toHaveLength(0);
  });

  it('22 — deleteRole returns false for non-existent id', () => {
    expect(registry.deleteRole('nonexistent')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// getAgentsByRole / addAgent / updateAgent / deleteAgent
// ---------------------------------------------------------------------------

describe('predefined agents', () => {
  it('23 — getAgentsByRole returns empty for a role with no agents', () => {
    const d = registry.addDomain({ name: 'D', description: 'D' });
    const s = registry.addSource({
      domainId: d.id,
      name: 'S',
      url: 'https://s',
      description: 'S',
    });
    const r = registry.addRole({
      sourceId: s.id,
      name: 'Empty Role',
      description: 'No agents',
    });
    expect(registry.getAgentsByRole(r.id)).toEqual([]);
  });

  it('24 — addAgent creates a predefined agent with optional skills', () => {
    const { role } = seedMinimal();
    const a = registry.addAgent({
      roleId: role.id,
      name: 'Bug Finder',
      description: 'Finds bugs in code',
      systemPrompt: 'You find bugs.',
      availableSkills: ['search', 'analyze'],
    });
    expect(a.id).toBeDefined();
    expect(a.roleId).toBe(role.id);
    expect(a.name).toBe('Bug Finder');
    expect(a.availableSkills).toEqual(['search', 'analyze']);
  });

  it('25 — addAgent defaults availableSkills to empty array', () => {
    const { role } = seedMinimal();
    const a = registry.addAgent({
      roleId: role.id,
      name: 'Minimal',
      description: 'Minimal agent',
      systemPrompt: 'Be minimal.',
    });
    expect(a.availableSkills).toEqual([]);
  });

  it('26 — getAgentsByRole returns agents in alphabetical order', () => {
    const d = registry.addDomain({ name: 'D', description: 'D' });
    const s = registry.addSource({
      domainId: d.id,
      name: 'S',
      url: 'https://s',
      description: 'S',
    });
    const r = registry.addRole({
      sourceId: s.id,
      name: 'Sorted Role',
      description: 'Role for sorting test',
    });
    registry.addAgent({
      roleId: r.id,
      name: 'Zed',
      description: 'Z',
      systemPrompt: 'P',
    });
    registry.addAgent({
      roleId: r.id,
      name: 'Alpha',
      description: 'A',
      systemPrompt: 'P',
    });

    const agents = registry.getAgentsByRole(r.id);
    expect(agents.map((a) => a.name)).toEqual(['Alpha', 'Zed']);
  });

  it('27 — updateAgent updates systemPrompt and name', () => {
    const { role } = seedMinimal();
    const a = registry.addAgent({
      roleId: role.id,
      name: 'Old Name',
      description: 'Desc',
      systemPrompt: 'Old prompt',
    });
    const updated = registry.updateAgent(a.id, {
      name: 'New Name',
      systemPrompt: 'New prompt',
    });
    expect(updated).toBeDefined();
    expect(updated!.name).toBe('New Name');
    expect(updated!.systemPrompt).toBe('New prompt');
    expect(updated!.description).toBe('Desc'); // unchanged
  });

  it('28 — updateAgent updates availableSkills', () => {
    const { role } = seedMinimal();
    const a = registry.addAgent({
      roleId: role.id,
      name: 'Skillful',
      description: 'Has skills',
      systemPrompt: 'P',
      availableSkills: ['a'],
    });
    const updated = registry.updateAgent(a.id, { availableSkills: ['x', 'y', 'z'] });
    expect(updated).toBeDefined();
    expect(updated!.availableSkills).toEqual(['x', 'y', 'z']);
  });

  it('29 — updateAgent returns undefined for non-existent id', () => {
    expect(registry.updateAgent('nonexistent', { name: 'Nope' })).toBeUndefined();
  });

  it('30 — deleteAgent returns true and removes the agent', () => {
    const d = registry.addDomain({ name: 'D', description: 'D' });
    const s = registry.addSource({
      domainId: d.id,
      name: 'S',
      url: 'https://s',
      description: 'S',
    });
    const r = registry.addRole({
      sourceId: s.id,
      name: 'Del Role',
      description: 'Role for delete test',
    });
    const a = registry.addAgent({
      roleId: r.id,
      name: 'Del',
      description: 'D',
      systemPrompt: 'P',
    });
    expect(registry.deleteAgent(a.id)).toBe(true);
    expect(registry.getAgentsByRole(r.id)).toHaveLength(0);
  });

  it('31 — deleteAgent returns false for non-existent id', () => {
    expect(registry.deleteAgent('nonexistent')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// importFromJSON
// ---------------------------------------------------------------------------

describe('importFromJSON', () => {
  it('32 — imports a complete hierarchy using name-based references', () => {
    const result = registry.importFromJSON({
      domains: [
        { name: 'Code Analysis', description: 'Code analysis tools' },
        { name: 'Web Dev', description: 'Web development tools' },
      ],
      sources: [
        {
          domainName: 'Code Analysis',
          name: 'GitHub',
          url: 'https://github.com',
          description: 'GitHub repos',
        },
        {
          domainName: 'Web Dev',
          name: 'npm',
          url: 'https://npmjs.com',
          description: 'npm packages',
        },
      ],
      roles: [
        {
          sourceName: 'GitHub',
          name: 'Reviewer',
          description: 'Code reviewer',
          tier: 1,
        },
        {
          sourceName: 'GitHub',
          name: 'Bug Finder',
          description: 'Finds bugs',
          tier: 2,
        },
        {
          sourceName: 'npm',
          name: 'Dependency Checker',
          description: 'Checks deps',
          tier: 0,
        },
      ],
      agents: [
        {
          roleName: 'Reviewer',
          name: 'Linter',
          description: 'Lints code',
          systemPrompt: 'You lint.',
        },
        {
          roleName: 'Bug Finder',
          name: 'Security Scanner',
          description: 'Finds vulns',
          systemPrompt: 'Find vulns.',
        },
      ],
    });

    expect(result).toEqual({ domains: 2, sources: 2, roles: 3, agents: 2 });

    // Verify the tree is queryable
    const allDomains = registry.getDomains();
    expect(allDomains).toHaveLength(2);
    expect(allDomains[0].name).toBe('Code Analysis');

    const sources = registry.getSourcesByDomain(allDomains[0].id);
    expect(sources).toHaveLength(1);
    expect(sources[0].name).toBe('GitHub');

    const roles = registry.getRolesBySource(sources[0].id);
    expect(roles).toHaveLength(2);
    expect(roles.map((r) => r.name)).toEqual(['Reviewer', 'Bug Finder']); // tier 1 then 2

    const agents = registry.getAgentsByRole(roles[0].id);
    expect(agents).toHaveLength(1);
    expect(agents[0].name).toBe('Linter');
  });

  it('33 — imports with ID-based references', () => {
    // Pre-seed entities
    const d = registry.addDomain({ name: 'PreD', description: 'Pre domain' });
    const s = registry.addSource({
      domainId: d.id,
      name: 'PreS',
      url: 'https://pre',
      description: 'Pre source',
    });

    const result = registry.importFromJSON({
      domains: [], // none to add
      sources: [], // none to add
      roles: [
        {
          sourceId: s.id,
          name: 'Imported Role',
          description: 'Imported role',
        },
      ],
      agents: [
        {
          roleName: 'Imported Role',
          name: 'Imported Agent',
          description: 'Imported',
          systemPrompt: 'Hi',
        },
      ],
    });

    expect(result).toEqual({ domains: 0, sources: 0, roles: 1, agents: 1 });
  });

  it('34 — throws when a domainName reference cannot be resolved', () => {
    expect(() =>
      registry.importFromJSON({
        sources: [
          {
            domainName: 'DoesNotExist',
            name: 'Orphan',
            url: 'https://x',
            description: 'Orphan source',
          },
        ],
      }),
    ).toThrow(/Domain.*DoesNotExist.*not found/i);
  });

  it('35 — throws when a sourceName reference cannot be resolved', () => {
    expect(() =>
      registry.importFromJSON({
        roles: [
          {
            sourceName: 'MissingSource',
            name: 'Orphan Role',
            description: 'Orphan role',
          },
        ],
      }),
    ).toThrow(/Source.*MissingSource.*not found/i);
  });

  it('36 — throws when a roleName reference cannot be resolved', () => {
    expect(() =>
      registry.importFromJSON({
        agents: [
          {
            roleName: 'MissingRole',
            name: 'Orphan Agent',
            description: 'Orphan agent',
            systemPrompt: 'Hi',
          },
        ],
      }),
    ).toThrow(/Role.*MissingRole.*not found/i);
  });

  it('37 — throws when a source has neither domainId nor domainName', () => {
    expect(() =>
      registry.importFromJSON({
        domains: [{ name: 'D', description: 'D' }],
        sources: [
          {
            name: 'Bad Source',
            url: 'https://x',
            description: 'No parent ref',
          },
        ],
      }),
    ).toThrow(/requires a valid domainId or domainName/i);
  });

  it('38 — importFromJSON with empty arrays returns zero counts', () => {
    const result = registry.importFromJSON({});
    expect(result).toEqual({ domains: 0, sources: 0, roles: 0, agents: 0 });
  });

  it('39 — multiple imports are additive', () => {
    registry.importFromJSON({
      domains: [{ name: 'First', description: 'First domain' }],
    });
    registry.importFromJSON({
      domains: [{ name: 'Second', description: 'Second domain' }],
    });

    expect(registry.getDomains()).toHaveLength(2);
  });

  it('40 — import with icon on domain', () => {
    const result = registry.importFromJSON({
      domains: [{ name: 'Icons', description: 'Has icon', icon: 'star' }],
    });
    expect(result.domains).toBe(1);

    const domains = registry.getDomains();
    expect(domains[0].icon).toBe('star');
  });
});

// ---------------------------------------------------------------------------
// Hierarchical queries — end-to-end
// ---------------------------------------------------------------------------

describe('hierarchical queries', () => {
  it('41 — full tree walk from domains to agents', () => {
    const { domain, agent } = seedMinimal();

    // Walk down
    const sources = registry.getSourcesByDomain(domain.id);
    expect(sources).toHaveLength(1);
    const roles = registry.getRolesBySource(sources[0].id);
    expect(roles).toHaveLength(1);
    const agents = registry.getAgentsByRole(roles[0].id);
    expect(agents).toHaveLength(1);
    expect(agents[0].id).toBe(agent.id);
  });

  it('42 — cascade: deleting domain removes sources, roles, agents', () => {
    const { domain, source, role, agent } = seedMinimal();

    // Confirm everything exists
    expect(repo.getDomain(domain.id)).toBeDefined();
    expect(repo.getAgentSource(source.id)).toBeDefined();
    expect(repo.getAgentRole(role.id)).toBeDefined();
    expect(repo.getPredefinedAgent(agent.id)).toBeDefined();

    // Delete domain — CASCADE should wipe everything
    registry.deleteDomain(domain.id);

    expect(repo.getDomain(domain.id)).toBeUndefined();
    expect(repo.getAgentSource(source.id)).toBeUndefined();
    expect(repo.getAgentRole(role.id)).toBeUndefined();
    expect(repo.getPredefinedAgent(agent.id)).toBeUndefined();
  });
});
