import { describe, it, expect } from 'vitest';
import type {
  Domain,
  AgentSource,
  AgentRole,
  Skill,
  SkillCategory,
} from '@dynflow/shared';
import type { PredefinedAgent } from '@dynflow/shared';
import {
  CandidateSelector,
  maxChoicesPerStep,
} from './candidates.js';
import { buildSystemPrompt, buildUserPrompt } from './prompt.js';
import type { OrchestratorContext } from './prompt.js';

// ---------------------------------------------------------------------------
// Test data factories
// ---------------------------------------------------------------------------

function makeDomain(id: string, name: string, description = ''): Domain {
  return { id, name, description };
}

function makeSource(id: string, domainId: string, description = ''): AgentSource {
  return { id, domainId, name: id, url: `https://example.com/${id}`, description };
}

function makeRole(id: string, sourceId: string, tier: number, description = ''): AgentRole {
  return { id, sourceId, name: id, description, tier };
}

function makeAgent(id: string, roleId: string, description = ''): PredefinedAgent {
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

function manyRoles(n: number, sourceId = 's0', startTier = 1): AgentRole[] {
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

// ===================================================================
// CandidateSelector
// ===================================================================

describe('CandidateSelector', () => {
  const selector = new CandidateSelector();

  // ── Domains ───────────────────────────────────────────────────────────

  describe('selectDomains', () => {
    it('returns at most maxChoicesPerStep items', () => {
      const all = manyDomains(25);
      const result = selector.selectDomains(all);
      expect(result.length).toBeLessThanOrEqual(maxChoicesPerStep);
    });

    it('returns all items when fewer than maxChoicesPerStep', () => {
      const all = manyDomains(3);
      const result = selector.selectDomains(all);
      expect(result).toHaveLength(3);
    });

    it('respects a custom count', () => {
      const all = manyDomains(20);
      const result = selector.selectDomains(all, 5);
      expect(result).toHaveLength(5);
    });

    it('does not exceed maxChoicesPerStep even with larger custom count', () => {
      const all = manyDomains(20);
      const result = selector.selectDomains(all, 99);
      expect(result).toHaveLength(maxChoicesPerStep);
    });

    it('prefers items with descriptions', () => {
      const noDesc = makeDomain('a', 'A', '');
      const withDesc = makeDomain('b', 'B', 'Has description');
      const result = selector.selectDomains([noDesc, withDesc]);
      expect(result[0].id).toBe('b');
    });

    it('handles empty input', () => {
      expect(selector.selectDomains([])).toEqual([]);
    });
  });

  // ── Sources ───────────────────────────────────────────────────────────

  describe('selectSources', () => {
    it('returns at most maxChoicesPerStep items', () => {
      const all = manySources(25);
      const result = selector.selectSources(all);
      expect(result.length).toBeLessThanOrEqual(maxChoicesPerStep);
    });

    it('filters by domainId', () => {
      const all = [
        ...manySources(5, 'domain-a'),
        ...manySources(5, 'domain-b'),
      ];
      const result = selector.selectSources(all, 'domain-a');
      expect(result.every((s) => s.domainId === 'domain-a')).toBe(true);
    });

    it('handles empty input', () => {
      expect(selector.selectSources([])).toEqual([]);
    });

    it('respects a custom count', () => {
      const all = manySources(20);
      const result = selector.selectSources(all, undefined, 3);
      expect(result).toHaveLength(3);
    });
  });

  // ── Roles ─────────────────────────────────────────────────────────────

  describe('selectRoles', () => {
    it('returns at most maxChoicesPerStep items', () => {
      const all = manyRoles(25);
      const result = selector.selectRoles(all);
      expect(result.length).toBeLessThanOrEqual(maxChoicesPerStep);
    });

    it('filters by sourceId', () => {
      const all = [
        ...manyRoles(5, 'src-a'),
        ...manyRoles(5, 'src-b'),
      ];
      const result = selector.selectRoles(all, 'src-a');
      expect(result.every((r) => r.sourceId === 'src-a')).toBe(true);
    });

    it('orders by tier (ascending)', () => {
      const r1 = makeRole('tier3', 's', 3, 'desc');
      const r2 = makeRole('tier1', 's', 1, 'desc');
      const r3 = makeRole('tier2', 's', 2, 'desc');
      const result = selector.selectRoles([r1, r2, r3]);
      expect(result.map((r) => r.id)).toEqual(['tier1', 'tier2', 'tier3']);
    });

    it('handles empty input', () => {
      expect(selector.selectRoles([])).toEqual([]);
    });
  });

  // ── Agents ────────────────────────────────────────────────────────────

  describe('selectAgents', () => {
    it('returns at most maxChoicesPerStep items', () => {
      const all = manyAgents(25);
      const result = selector.selectAgents(all);
      expect(result.length).toBeLessThanOrEqual(maxChoicesPerStep);
    });

    it('filters by roleId', () => {
      const all = [
        ...manyAgents(5, 'role-a'),
        ...manyAgents(5, 'role-b'),
      ];
      const result = selector.selectAgents(all, 'role-a');
      expect(result.every((a) => a.roleId === 'role-a')).toBe(true);
    });

    it('handles empty input', () => {
      expect(selector.selectAgents([])).toEqual([]);
    });

    it('respects a custom count', () => {
      const all = manyAgents(20);
      const result = selector.selectAgents(all, undefined, 7);
      expect(result).toHaveLength(7);
    });
  });

  // ── Skills ────────────────────────────────────────────────────────────

  describe('selectSkills', () => {
    it('returns at most maxChoicesPerStep items', () => {
      const all = manySkills(25);
      const result = selector.selectSkills(all);
      expect(result.length).toBeLessThanOrEqual(maxChoicesPerStep);
    });

    it('filters by sourceId', () => {
      const all = [
        ...manySkills(5, 'src-a'),
        ...manySkills(5, 'src-b'),
      ];
      const result = selector.selectSkills(all, 'src-a');
      expect(result.every((s) => s.sourceId === 'src-a')).toBe(true);
    });

    it('filters by category', () => {
      const all = [
        ...manySkills(5, 's', 'analysis'),
        ...manySkills(5, 's', 'development'),
      ];
      const result = selector.selectSkills(all, undefined, 'analysis');
      expect(result.every((s) => s.category === 'analysis')).toBe(true);
    });

    it('handles empty input', () => {
      expect(selector.selectSkills([])).toEqual([]);
    });
  });

  // ── Hard cap enforcement ──────────────────────────────────────────────

  describe('hard cap enforcement', () => {
    it('domain list never exceeds maxChoicesPerStep', () => {
      const sel = new CandidateSelector();
      const big = manyDomains(100);
      expect(sel.selectDomains(big).length).toBeLessThanOrEqual(maxChoicesPerStep);
    });

    it('source list never exceeds maxChoicesPerStep', () => {
      const sel = new CandidateSelector();
      const big = manySources(100);
      expect(sel.selectSources(big).length).toBeLessThanOrEqual(maxChoicesPerStep);
    });

    it('role list never exceeds maxChoicesPerStep', () => {
      const sel = new CandidateSelector();
      const big = manyRoles(100);
      expect(sel.selectRoles(big).length).toBeLessThanOrEqual(maxChoicesPerStep);
    });

    it('agent list never exceeds maxChoicesPerStep', () => {
      const sel = new CandidateSelector();
      const big = manyAgents(100);
      expect(sel.selectAgents(big).length).toBeLessThanOrEqual(maxChoicesPerStep);
    });

    it('skill list never exceeds maxChoicesPerStep', () => {
      const sel = new CandidateSelector();
      const big = manySkills(100);
      expect(sel.selectSkills(big).length).toBeLessThanOrEqual(maxChoicesPerStep);
    });
  });
});

// ===================================================================
// Prompt builders
// ===================================================================

describe('buildSystemPrompt', () => {
  it('returns a non-empty string with empty context', () => {
    const ctx: OrchestratorContext = {
      domains: [],
      sources: [],
      roles: [],
      agents: [],
      skills: [],
    };
    const prompt = buildSystemPrompt(ctx);
    expect(prompt).toBeTruthy();
    expect(prompt.length).toBeGreaterThan(100);
  });

  it('includes role description', () => {
    const ctx: OrchestratorContext = {
      domains: [],
      sources: [],
      roles: [],
      agents: [],
      skills: [],
    };
    const prompt = buildSystemPrompt(ctx);
    expect(prompt).toContain('workflow orchestrator');
    expect(prompt).toContain('phases');
    expect(prompt).toContain('WorkflowDefinition');
  });

  it('includes domain table when domains are present', () => {
    const ctx: OrchestratorContext = {
      domains: manyDomains(3),
      sources: [],
      roles: [],
      agents: [],
      skills: [],
    };
    const prompt = buildSystemPrompt(ctx);
    expect(prompt).toContain('Domains');
    expect(prompt).toContain('d0');
    expect(prompt).toContain('d2');
  });

  it('includes source table when sources are present', () => {
    const ctx: OrchestratorContext = {
      domains: [],
      sources: manySources(2),
      roles: [],
      agents: [],
      skills: [],
    };
    const prompt = buildSystemPrompt(ctx);
    expect(prompt).toContain('Agent Sources');
    expect(prompt).toContain('s0');
    expect(prompt).toContain('s1');
  });

  it('includes role table when roles are present', () => {
    const ctx: OrchestratorContext = {
      domains: [],
      sources: [],
      roles: manyRoles(2),
      agents: [],
      skills: [],
    };
    const prompt = buildSystemPrompt(ctx);
    expect(prompt).toContain('Agent Roles');
    expect(prompt).toContain('r0');
    expect(prompt).toContain('r1');
  });

  it('includes agent table when agents are present', () => {
    const ctx: OrchestratorContext = {
      domains: [],
      sources: [],
      roles: [],
      agents: manyAgents(2),
      skills: [],
    };
    const prompt = buildSystemPrompt(ctx);
    expect(prompt).toContain('Predefined Agents');
    expect(prompt).toContain('a0');
    expect(prompt).toContain('a1');
  });

  it('includes skill table when skills are present', () => {
    const ctx: OrchestratorContext = {
      domains: [],
      sources: [],
      roles: [],
      agents: [],
      skills: manySkills(2),
    };
    const prompt = buildSystemPrompt(ctx);
    expect(prompt).toContain('Available Skills');
    expect(prompt).toContain('sk0');
    expect(prompt).toContain('sk1');
  });

  it('includes constraints section', () => {
    const ctx: OrchestratorContext = {
      domains: [],
      sources: [],
      roles: [],
      agents: [],
      skills: [],
    };
    const prompt = buildSystemPrompt(ctx);
    expect(prompt).toContain('Maximum 50 phases');
    expect(prompt).toContain('Maximum 100 agents');
    expect(prompt).toContain('Maximum 1 000 agents');
    expect(prompt).toContain(maxChoicesPerStep.toString());
  });

  it('includes guidelines section', () => {
    const ctx: OrchestratorContext = {
      domains: [],
      sources: [],
      roles: [],
      agents: [],
      skills: [],
    };
    const prompt = buildSystemPrompt(ctx);
    expect(prompt).toContain('Guidelines');
    expect(prompt).toContain('agentId');
  });

  it('includes the output format JSON schema', () => {
    const ctx: OrchestratorContext = {
      domains: [],
      sources: [],
      roles: [],
      agents: [],
      skills: [],
    };
    const prompt = buildSystemPrompt(ctx);
    expect(prompt).toContain('WorkflowDefinition');
    expect(prompt).toContain('PhaseDefinition');
    expect(prompt).toContain('AgentDefinition');
  });

  it('handles a fully populated context without errors', () => {
    const sel = new CandidateSelector();
    const allDomains = manyDomains(15);
    const ctx: OrchestratorContext = {
      domains: sel.selectDomains(allDomains),
      sources: sel.selectSources(manySources(15, allDomains[0].id)),
      roles: sel.selectRoles(manyRoles(15)),
      agents: sel.selectAgents(manyAgents(15)),
      skills: sel.selectSkills(manySkills(15)),
    };
    const prompt = buildSystemPrompt(ctx);
    expect(prompt).toBeTruthy();
    expect(prompt.length).toBeGreaterThan(500);
    // Every injected list is at most 10
    expect(ctx.domains.length).toBeLessThanOrEqual(maxChoicesPerStep);
    expect(ctx.sources.length).toBeLessThanOrEqual(maxChoicesPerStep);
    expect(ctx.roles.length).toBeLessThanOrEqual(maxChoicesPerStep);
    expect(ctx.agents.length).toBeLessThanOrEqual(maxChoicesPerStep);
    expect(ctx.skills.length).toBeLessThanOrEqual(maxChoicesPerStep);
  });
});

describe('buildUserPrompt', () => {
  it('wraps the user request', () => {
    const result = buildUserPrompt('Build a code review workflow');
    expect(result).toContain('User Request');
    expect(result).toContain('Build a code review workflow');
    expect(result).toContain('WorkflowDefinition');
  });

  it('handles empty string', () => {
    const result = buildUserPrompt('');
    expect(result).toContain('User Request');
  });
});

describe('maxChoicesPerStep constant', () => {
  it('equals 10', () => {
    expect(maxChoicesPerStep).toBe(10);
  });
});
