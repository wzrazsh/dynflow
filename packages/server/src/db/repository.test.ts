import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { getDb, closeDb, withRetry } from './connection.js';
import { initSchema } from './schema.js';
import * as repo from './repository.js';
import type { RuntimeConfig, WorkflowDefinition } from '@dynflow/shared';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function daysAgo(days: number): string {
  return new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
}

function seedSixWorkflows(): void {
  const db = getDb();
  const def = JSON.stringify({ name: 'test', phases: [] });
  const now = new Date().toISOString();

  const insert = db.prepare(`
    INSERT INTO workflow_runs (id, name, status, definition_json, created_at, updated_at, template_id)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `);

  // wf-1: completed, 8 days ago, template 'mq'
  insert.run('wf-1', 'MathQuest v1', 'completed', def, daysAgo(8), now, 'mq');
  // wf-2: completed, template 'mq'
  insert.run('wf-2', 'MathQuest v15', 'completed', def, now, now, 'mq');
  // wf-3: pending
  insert.run('wf-3', 'Test Workflow', 'pending', def, now, now, null);
  // wf-4: failed, 30 days ago
  insert.run('wf-4', 'Failed Job', 'failed', def, daysAgo(30), now, null);
  // wf-5: completed
  insert.run('wf-5', 'probe-test', 'completed', def, now, now, null);
  // wf-6: running, template 'foo'
  insert.run('wf-6', 'Recent Foo', 'running', def, now, now, 'foo');
}

function sampleDefinition(): WorkflowDefinition {
  return {
    name: 'test-flow',
    phases: [
      {
        name: 'phase-1',
        agents: [
          { name: 'agent-1', prompt: 'Do first thing' },
          { name: 'agent-2', prompt: 'Do second thing' },
        ],
      },
      {
        name: 'phase-2',
        agents: [{ name: 'agent-3', prompt: 'Do final thing' }],
      },
    ],
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

describe('createWorkflowRun', () => {
  it('1 — returns full workflow with phases and agents', () => {
    const run = repo.createWorkflowRun(sampleDefinition(), 'My Workflow');

    expect(run.id).toBeDefined();
    expect(run.name).toBe('My Workflow');
    expect(run.status).toBe('pending');
    expect(run.createdAt).toBeDefined();
    expect(run.updatedAt).toBeDefined();

    // Phase tree
    expect(run.phases).toHaveLength(2);

    // Phase 1
    expect(run.phases[0].name).toBe('phase-1');
    expect(run.phases[0].status).toBe('pending');
    expect(run.phases[0].order).toBe(0);
    expect(run.phases[0].agents).toHaveLength(2);

    expect(run.phases[0].agents[0].name).toBe('agent-1');
    expect(run.phases[0].agents[0].prompt).toBe('Do first thing');
    expect(run.phases[0].agents[0].status).toBe('pending');

    expect(run.phases[0].agents[1].name).toBe('agent-2');
    expect(run.phases[0].agents[1].prompt).toBe('Do second thing');

    // Phase 2
    expect(run.phases[1].name).toBe('phase-2');
    expect(run.phases[1].order).toBe(1);
    expect(run.phases[1].agents).toHaveLength(1);
    expect(run.phases[1].agents[0].name).toBe('agent-3');
  });
});

describe('getWorkflowRun', () => {
  it('2 — retrieves complete tree', () => {
    const created = repo.createWorkflowRun(sampleDefinition(), 'Test');
    const retrieved = repo.getWorkflowRun(created.id);

    expect(retrieved).toBeDefined();
    expect(retrieved!.id).toBe(created.id);
    expect(retrieved!.name).toBe('Test');
    expect(retrieved!.phases).toHaveLength(2);
    expect(retrieved!.phases[0].agents).toHaveLength(2);
    expect(retrieved!.phases[1].agents).toHaveLength(1);

    // Verify timestamps
    expect(retrieved!.createdAt).toBe(created.createdAt);
    expect(retrieved!.updatedAt).toBe(created.updatedAt);
  });

  it('7 — returns undefined for non-existent ID', () => {
    const result = repo.getWorkflowRun('non-existent-id');
    expect(result).toBeUndefined();
  });
});

describe('listWorkflowRuns', () => {
  it('3 — paginates correctly', () => {
    const def = sampleDefinition();
    for (let i = 0; i < 5; i++) {
      repo.createWorkflowRun(def, `Workflow ${i}`);
    }

    // Page 1: 3 items
    const page1 = repo.listWorkflowRuns(1, 3);
    expect(page1.runs).toHaveLength(3);
    expect(page1.total).toBe(5);

    // Page 2: 2 items
    const page2 = repo.listWorkflowRuns(2, 3);
    expect(page2.runs).toHaveLength(2);
    expect(page2.total).toBe(5);

    // All run names appear across the two pages
    const allNames = [...page1.runs, ...page2.runs].map((r) => r.name);
    for (let i = 0; i < 5; i++) {
      expect(allNames).toContain(`Workflow ${i}`);
    }
  });

  // ---------------------------------------------------------------------------
  // T2 — listWorkflowRuns filters (11 new tests: F1–F9 + pagination + injection)
  // ---------------------------------------------------------------------------

  it('F1 — no filters returns all 6 workflows', () => {
    seedSixWorkflows();
    const result = repo.listWorkflowRuns(1, 10, {});
    expect(result.total).toBe(6);
    expect(result.runs).toHaveLength(6);
  });

  it('F2 — filters by name (LIKE, case-insensitive)', () => {
    seedSixWorkflows();
    const result = repo.listWorkflowRuns(1, 10, { name: 'MathQuest' });
    expect(result.total).toBe(2);
    expect(result.runs.map((r) => r.id).sort()).toEqual(['wf-1', 'wf-2']);
  });

  it('F3 — filters by status', () => {
    seedSixWorkflows();
    const result = repo.listWorkflowRuns(1, 10, { status: 'failed' });
    expect(result.total).toBe(1);
    expect(result.runs[0].id).toBe('wf-4');
  });

  it('F4 — filters by templateId', () => {
    seedSixWorkflows();
    const result = repo.listWorkflowRuns(1, 10, { templateId: 'mq' });
    expect(result.total).toBe(2);
    expect(result.runs.map((r) => r.id).sort()).toEqual(['wf-1', 'wf-2']);
  });

  it('F5 — filters by sinceDays (last 7 days)', () => {
    seedSixWorkflows();
    // Excludes wf-1 (8 days old) and wf-4 (30 days old)
    const result = repo.listWorkflowRuns(1, 10, { sinceDays: 7 });
    expect(result.total).toBe(4);
  });

  it('F6 — combines name + status + sinceDays filters', () => {
    seedSixWorkflows();
    const result = repo.listWorkflowRuns(1, 10, {
      name: 'MathQuest',
      status: 'completed',
      sinceDays: 0,
    });
    // Only wf-2 matches: name=MathQuest, status=completed, created "today"
    expect(result.total).toBe(1);
    expect(result.runs[0].id).toBe('wf-2');
  });

  it('F7 — pagination with filters (page 2, size 2)', () => {
    seedSixWorkflows();
    const result = repo.listWorkflowRuns(2, 2, {});
    expect(result.runs).toHaveLength(2);
    expect(result.total).toBe(6);
  });

  it('F9 — SQL injection attempt does not crash', () => {
    seedSixWorkflows();
    const result = repo.listWorkflowRuns(1, 10, {
      name: "'; DROP TABLE workflow_runs; --",
    });
    expect(result.total).toBe(0);
    // Verify table still exists
    const db = getDb();
    const check = db.prepare('SELECT COUNT(*) as count FROM workflow_runs').get() as { count: number };
    expect(check.count).toBe(6);
  });
});

describe('createWorkflowRun — script storage', () => {
  it('F8 — stores and retrieves script', () => {
    const script = 'workflow("test", () => { phase("p1", () => { agent("a1", "do stuff"); }); });';
    const run = repo.createWorkflowRun(
      sampleDefinition(),
      'Scripted',
      { script },
    );
    expect(run.script).toBe(script);

    const fetched = repo.getWorkflowRun(run.id);
    expect(fetched).toBeDefined();
    expect(fetched!.script).toBe(script);
  });
});

describe('updateWorkflowStatus', () => {
  it('4 — changes status and updated_at', () => {
    const run = repo.createWorkflowRun(sampleDefinition(), 'Test');

    const originalUpdated = run.updatedAt;

    repo.updateWorkflowStatus(run.id, 'running');

    const updated = repo.getWorkflowRun(run.id)!;
    expect(updated.status).toBe('running');
    // Timestamp must be >= original (same-ms operations are valid)
    expect(new Date(updated.updatedAt).getTime()).toBeGreaterThanOrEqual(
      new Date(originalUpdated).getTime(),
    );
  });
});

describe('updateAgentStatus', () => {
  it('5 — stores output and sets completed_at', () => {
    const run = repo.createWorkflowRun(sampleDefinition(), 'Test');
    const agentId = run.phases[0].agents[0].id;

    repo.updateAgentStatus(agentId, 'completed', { output: 'Task done' });

    const retrieved = repo.getWorkflowRun(run.id)!;
    const agent = retrieved.phases[0].agents[0];
    expect(agent.status).toBe('completed');
    expect(agent.output).toBe('Task done');
    expect(agent.completedAt).toBeDefined();
    expect(agent.error).toBeUndefined();
  });

  it('6 — stores error', () => {
    const run = repo.createWorkflowRun(sampleDefinition(), 'Test');
    const agentId = run.phases[0].agents[0].id;

    repo.updateAgentStatus(agentId, 'failed', { error: 'Something broke' });

    const retrieved = repo.getWorkflowRun(run.id)!;
    const agent = retrieved.phases[0].agents[0];
    expect(agent.status).toBe('failed');
    expect(agent.error).toBe('Something broke');
    expect(agent.completedAt).toBeDefined();
    expect(agent.output).toBeUndefined();
  });
});

describe('concurrent-style updates', () => {
  it('8 — multiple updates to same agent work (simulating WAL concurrency)', () => {
    const run = repo.createWorkflowRun(sampleDefinition(), 'Test');
    const agentId = run.phases[0].agents[0].id;

    // Rapid sequential updates (simulating concurrent access in WAL mode)
    for (let i = 0; i < 10; i++) {
      repo.updateAgentStatus(agentId, 'running');
    }

    repo.updateAgentStatus(agentId, 'completed', { output: 'Final' });

    const retrieved = repo.getWorkflowRun(run.id)!;
    const agent = retrieved.phases[0].agents[0];
    expect(agent.status).toBe('completed');
    expect(agent.output).toBe('Final');
  });
});

describe('foreign key cascade', () => {
  it('9 — deleting workflow removes phases and agents', () => {
    const run = repo.createWorkflowRun(sampleDefinition(), 'Test');
    const db = getDb();

    // Confirm everything exists before delete
    expect(run.phases).toHaveLength(2);
    expect(run.phases[0].agents).toHaveLength(2);

    // Direct delete to test cascade
    db.prepare('DELETE FROM workflow_runs WHERE id = ?').run(run.id);

    // Phases should be gone
    const phases = db
      .prepare('SELECT * FROM phase_runs WHERE workflow_run_id = ?')
      .all(run.id);
    expect(phases).toHaveLength(0);

    // Workflow not found
    expect(repo.getWorkflowRun(run.id)).toBeUndefined();
  });
});

describe('edge cases', () => {
  it('10 — createWorkflowRun with empty definition has 0 phases', () => {
    const def: WorkflowDefinition = { name: 'empty', phases: [] };
    const run = repo.createWorkflowRun(def, 'Empty');
    expect(run.phases).toHaveLength(0);
  });
});

describe('agentId prompt resolution in createWorkflowRun', () => {
  function setupPredefinedAgent(): { agentId: string } {
    const domain = repo.createDomain({ name: 'AgentResolveD', description: 'Resolve test domain' });
    const source = repo.createAgentSource({ domainId: domain.id, name: 'AgentResolveS', url: 'https://ar', description: 'Resolve test source' });
    const role = repo.createAgentRole({ sourceId: source.id, name: 'AgentResolveR', description: 'Resolve test role' });
    const agent = repo.createPredefinedAgent({
      roleId: role.id,
      name: 'RegCodeReviewer',
      description: 'A code reviewer from registry',
      systemPrompt: 'You are a code reviewer from registry.',
    });
    return { agentId: agent.id };
  }

  it('35 — agentId-only agent resolves to registry systemPrompt', () => {
    const { agentId } = setupPredefinedAgent();

    const def: WorkflowDefinition = {
      name: 'resolve-test',
      phases: [
        {
          name: 'phase-1',
          agents: [
            { name: 'reviewer', agentId },
          ],
        },
      ],
    };

    const run = repo.createWorkflowRun(def, 'Resolve Test');

    expect(run.phases[0].agents[0].prompt).toBe('You are a code reviewer from registry.');
    expect(run.phases[0].agents[0].name).toBe('reviewer');
  });

  it('36 — prompt-only agent keeps prompt unchanged', () => {
    const def: WorkflowDefinition = {
      name: 'inline-test',
      phases: [
        {
          name: 'phase-1',
          agents: [
            { name: 'inline-agent', prompt: 'Do something inline' },
          ],
        },
      ],
    };

    const run = repo.createWorkflowRun(def, 'Inline Test');

    expect(run.phases[0].agents[0].prompt).toBe('Do something inline');
  });

  it('37 — agentId + prompt override uses the inline prompt', () => {
    const { agentId } = setupPredefinedAgent();

    const def: WorkflowDefinition = {
      name: 'override-test',
      phases: [
        {
          name: 'phase-1',
          agents: [
            {
              name: 'overrider',
              agentId,
              prompt: 'Override prompt, not registry prompt.',
            },
          ],
        },
      ],
    };

    const run = repo.createWorkflowRun(def, 'Override Test');

    // The inline prompt must win over the registry systemPrompt
    expect(run.phases[0].agents[0].prompt).toBe('Override prompt, not registry prompt.');
  });

  it('38 — unresolved agentId throws a clear error', () => {
    const def: WorkflowDefinition = {
      name: 'bogus-agent',
      phases: [
        {
          name: 'phase-1',
          agents: [
            { name: 'ghost', agentId: 'non-existent-agent-id' },
          ],
        },
      ],
    };

    expect(() => repo.createWorkflowRun(def, 'Bogus Test')).toThrow(
      'Predefined agent "non-existent-agent-id" not found in registry',
    );
  });
});

// ---------------------------------------------------------------------------
// SQLite retry wrapper tests
// ---------------------------------------------------------------------------

describe('withRetry', () => {
  it('returns the result of a successful function', () => {
    const result = withRetry(() => 42);
    expect(result).toBe(42);
  });

  it('propagates non-lock errors immediately', () => {
    expect(() =>
      withRetry(() => {
        throw new Error('not a lock error');
      }, 3),
    ).toThrow('not a lock error');
  });

  it('succeeds on the retry after transient failures', () => {
    let attempts = 0;
    const fn = () => {
      attempts++;
      if (attempts < 2) {
        const err = new Error('SQLITE_BUSY') as Error & { code: number };
        err.code = 5; // SQLITE_BUSY
        throw err;
      }
      return 'ok';
    };

    const result = withRetry(fn, 3, 1);
    expect(result).toBe('ok');
    expect(attempts).toBe(2);
  });

  it('throws after exhausting all retries', () => {
    let attempts = 0;
    const fn = () => {
      attempts++;
      const err = new Error('SQLITE_BUSY') as Error & { code: number };
      err.code = 5; // SQLITE_BUSY
      throw err;
    };

    expect(() => withRetry(fn, 2, 1)).toThrow('SQLITE_BUSY');
    expect(attempts).toBe(3); // initial + 2 retries
  });
});

// ---------------------------------------------------------------------------
// Registry CRUD tests
// ---------------------------------------------------------------------------

describe('domain registry CRUD', () => {
  it('11 — creates and retrieves a domain', () => {
    const domain = repo.createDomain({ name: 'Code Analysis', description: 'Tools for analyzing code', icon: 'code' });
    expect(domain.id).toBeDefined();
    expect(domain.name).toBe('Code Analysis');
    expect(domain.description).toBe('Tools for analyzing code');
    expect(domain.icon).toBe('code');

    const retrieved = repo.getDomain(domain.id);
    expect(retrieved).toBeDefined();
    expect(retrieved!.name).toBe('Code Analysis');
  });

  it('12 — returns undefined for non-existent domain', () => {
    expect(repo.getDomain('nonexistent')).toBeUndefined();
  });

  it('13 — lists all domains', () => {
    repo.createDomain({ name: 'Domain A', description: 'First' });
    repo.createDomain({ name: 'Domain B', description: 'Second' });
    const all = repo.getAllDomains();
    expect(all).toHaveLength(2);
    expect(all[0].name).toBe('Domain A');
    expect(all[1].name).toBe('Domain B');
  });

  it('14 — deletes a domain', () => {
    const domain = repo.createDomain({ name: 'Temp', description: 'Temporary' });
    repo.deleteDomain(domain.id);
    expect(repo.getDomain(domain.id)).toBeUndefined();
  });

  it('15 — skips icon when not provided', () => {
    const domain = repo.createDomain({ name: 'No Icon', description: 'No icon test' });
    expect(domain.icon).toBeUndefined();
  });
});

describe('agent source CRUD', () => {
  it('16 — creates and retrieves an agent source under a domain', () => {
    const domain = repo.createDomain({ name: 'Web Dev', description: 'Web development tools' });
    const source = repo.createAgentSource({ domainId: domain.id, name: 'GitHub', url: 'https://github.com', description: 'GitHub trending' });

    expect(source.id).toBeDefined();
    expect(source.domainId).toBe(domain.id);
    expect(source.name).toBe('GitHub');
    expect(source.url).toBe('https://github.com');

    const retrieved = repo.getAgentSource(source.id);
    expect(retrieved).toBeDefined();
    expect(retrieved!.name).toBe('GitHub');
  });

  it('17 — lists sources by domain', () => {
    const domain = repo.createDomain({ name: 'Data', description: 'Data tools' });
    repo.createAgentSource({ domainId: domain.id, name: 'Source B', url: 'https://b.com', description: 'B' });
    repo.createAgentSource({ domainId: domain.id, name: 'Source A', url: 'https://a.com', description: 'A' });

    const sources = repo.getSourcesByDomain(domain.id);
    expect(sources).toHaveLength(2);
    expect(sources[0].name).toBe('Source A'); // alphabetical order
    expect(sources[1].name).toBe('Source B');
  });

  it('18 — deletes an agent source', () => {
    const domain = repo.createDomain({ name: 'Temp', description: 'Temp' });
    const source = repo.createAgentSource({ domainId: domain.id, name: 'TempSrc', url: 'https://t', description: 'T' });
    repo.deleteAgentSource(source.id);
    expect(repo.getAgentSource(source.id)).toBeUndefined();
  });
});

describe('agent role CRUD', () => {
  it('19 — creates and retrieves an agent role', () => {
    const domain = repo.createDomain({ name: 'D', description: 'D' });
    const source = repo.createAgentSource({ domainId: domain.id, name: 'S', url: 'https://s', description: 'S' });
    const role = repo.createAgentRole({ sourceId: source.id, name: 'Reviewer', description: 'Code review role', tier: 1 });

    expect(role.id).toBeDefined();
    expect(role.sourceId).toBe(source.id);
    expect(role.name).toBe('Reviewer');
    expect(role.tier).toBe(1);

    const retrieved = repo.getAgentRole(role.id);
    expect(retrieved).toBeDefined();
    expect(retrieved!.tier).toBe(1);
  });

  it('20 — defaults tier to 0', () => {
    const domain = repo.createDomain({ name: 'D2', description: 'D2' });
    const source = repo.createAgentSource({ domainId: domain.id, name: 'S2', url: 'https://s2', description: 'S2' });
    const role = repo.createAgentRole({ sourceId: source.id, name: 'Default', description: 'Default tier' });
    expect(role.tier).toBe(0);
  });

  it('21 — lists roles ordered by tier then name', () => {
    const domain = repo.createDomain({ name: 'D3', description: 'D3' });
    const source = repo.createAgentSource({ domainId: domain.id, name: 'S3', url: 'https://s3', description: 'S3' });
    repo.createAgentRole({ sourceId: source.id, name: 'Low', description: 'Low', tier: 2 });
    repo.createAgentRole({ sourceId: source.id, name: 'High', description: 'High', tier: 0 });
    repo.createAgentRole({ sourceId: source.id, name: 'Mid', description: 'Mid', tier: 1 });

    const roles = repo.getRolesBySource(source.id);
    expect(roles).toHaveLength(3);
    expect(roles[0].name).toBe('High');  // tier 0
    expect(roles[1].name).toBe('Mid');   // tier 1
    expect(roles[2].name).toBe('Low');   // tier 2
  });

  it('22 — deletes an agent role', () => {
    const domain = repo.createDomain({ name: 'D4', description: 'D4' });
    const source = repo.createAgentSource({ domainId: domain.id, name: 'S4', url: 'https://s4', description: 'S4' });
    const role = repo.createAgentRole({ sourceId: source.id, name: 'Del', description: 'Delete me' });
    repo.deleteAgentRole(role.id);
    expect(repo.getAgentRole(role.id)).toBeUndefined();
  });
});

describe('predefined agent CRUD', () => {
  function setupRole() {
    const domain = repo.createDomain({ name: 'AgentD', description: 'Agent domain' });
    const source = repo.createAgentSource({ domainId: domain.id, name: 'AgentS', url: 'https://as', description: 'Agent source' });
    const role = repo.createAgentRole({ sourceId: source.id, name: 'AgentR', description: 'Agent role' });
    return { domain, source, role };
  }

  it('23 — creates and retrieves a predefined agent', () => {
    const { role } = setupRole();
    const agent = repo.createPredefinedAgent({
      roleId: role.id,
      name: 'Code Reviewer',
      description: 'Reviews code changes',
      systemPrompt: 'You are a code reviewer.',
      availableSkills: ['skill-1', 'skill-2'],
    });

    expect(agent.id).toBeDefined();
    expect(agent.roleId).toBe(role.id);
    expect(agent.name).toBe('Code Reviewer');
    expect(agent.systemPrompt).toBe('You are a code reviewer.');
    expect(agent.availableSkills).toEqual(['skill-1', 'skill-2']);

    const retrieved = repo.getPredefinedAgent(agent.id);
    expect(retrieved).toBeDefined();
    expect(retrieved!.availableSkills).toEqual(['skill-1', 'skill-2']);
  });

  it('24 — defaults availableSkills to empty array', () => {
    const { role } = setupRole();
    const agent = repo.createPredefinedAgent({
      roleId: role.id,
      name: 'Minimal',
      description: 'Minimal agent',
      systemPrompt: 'Be minimal.',
    });
    expect(agent.availableSkills).toEqual([]);
  });

  it('25 — lists agents by role', () => {
    const { role } = setupRole();
    repo.createPredefinedAgent({ roleId: role.id, name: 'Alpha', description: 'A', systemPrompt: 'P1' });
    repo.createPredefinedAgent({ roleId: role.id, name: 'Beta', description: 'B', systemPrompt: 'P2' });

    const agents = repo.getAgentsByRole(role.id);
    expect(agents).toHaveLength(2);
    expect(agents[0].name).toBe('Alpha');
    expect(agents[1].name).toBe('Beta');
  });

  it('26 — deletes a predefined agent', () => {
    const { role } = setupRole();
    const agent = repo.createPredefinedAgent({ roleId: role.id, name: 'Del', description: 'D', systemPrompt: 'P' });
    repo.deletePredefinedAgent(agent.id);
    expect(repo.getPredefinedAgent(agent.id)).toBeUndefined();
  });
});

describe('skill CRUD', () => {
  function setupSource() {
    const domain = repo.createDomain({ name: 'SkillD', description: 'Skill domain' });
    const source = repo.createAgentSource({ domainId: domain.id, name: 'SkillS', url: 'https://sk', description: 'Skill source' });
    return { domain, source };
  }

  it('27 — creates and retrieves a skill with parameters and schema', () => {
    const { source } = setupSource();
    const skill = repo.createSkill({
      sourceId: source.id,
      name: 'Code Search',
      description: 'Search code in repository',
      category: 'development',
      parameters: [
        { name: 'query', type: 'string', description: 'Search query', required: true },
        { name: 'limit', type: 'number', description: 'Max results', required: false, defaultValue: 10 },
      ],
      inputSchema: { type: 'object', properties: { query: { type: 'string' } } },
      outputSchema: { type: 'array', items: { type: 'string' } },
    });

    expect(skill.id).toBeDefined();
    expect(skill.sourceId).toBe(source.id);
    expect(skill.name).toBe('Code Search');
    expect(skill.category).toBe('development');
    expect(skill.parameters).toHaveLength(2);
    expect(skill.parameters[0].name).toBe('query');
    expect(skill.parameters[0].required).toBe(true);
    expect(skill.parameters[1].defaultValue).toBe(10);
    expect(skill.inputSchema).toBeDefined();
    expect(skill.outputSchema).toBeDefined();

    const retrieved = repo.getSkill(skill.id);
    expect(retrieved).toBeDefined();
    expect(retrieved!.parameters).toEqual(skill.parameters);
  });

  it('28 — creates skill with minimal fields', () => {
    const { source } = setupSource();
    const skill = repo.createSkill({
      sourceId: source.id,
      name: 'Minimal Skill',
      description: 'No params or schema',
      category: 'other',
    });

    expect(skill.id).toBeDefined();
    expect(skill.parameters).toEqual([]);
    expect(skill.inputSchema).toBeUndefined();
    expect(skill.outputSchema).toBeUndefined();
  });

  it('29 — lists skills by source', () => {
    const { source } = setupSource();
    repo.createSkill({ sourceId: source.id, name: 'Skill B', description: 'B', category: 'analysis' });
    repo.createSkill({ sourceId: source.id, name: 'Skill A', description: 'A', category: 'research' });

    const skills = repo.getSkillsBySource(source.id);
    expect(skills).toHaveLength(2);
    expect(skills[0].name).toBe('Skill A');
    expect(skills[1].name).toBe('Skill B');
  });

  it('30 — deletes a skill', () => {
    const { source } = setupSource();
    const skill = repo.createSkill({ sourceId: source.id, name: 'Del', description: 'D', category: 'other' });
    repo.deleteSkill(skill.id);
    expect(repo.getSkill(skill.id)).toBeUndefined();
  });
});

describe('agent-skill association CRUD', () => {
  function setupAgentAndSkill() {
    const domain = repo.createDomain({ name: 'AssocD', description: 'Assoc domain' });
    const source = repo.createAgentSource({ domainId: domain.id, name: 'AssocS', url: 'https://assoc', description: 'Assoc source' });
    const role = repo.createAgentRole({ sourceId: source.id, name: 'AssocR', description: 'Assoc role' });
    const agent = repo.createPredefinedAgent({ roleId: role.id, name: 'AssocA', description: 'Assoc agent', systemPrompt: 'P' });
    const skill = repo.createSkill({ sourceId: source.id, name: 'AssocSkill', description: 'Assoc skill', category: 'development' });
    return { agent, skill };
  }

  it('31 — adds and retrieves agent skills', () => {
    const { agent, skill } = setupAgentAndSkill();
    repo.addAgentSkill(agent.id, skill.id);

    const skills = repo.getAgentSkills(agent.id);
    expect(skills).toEqual([skill.id]);
  });

  it('32 — ignores duplicate association', () => {
    const { agent, skill } = setupAgentAndSkill();
    repo.addAgentSkill(agent.id, skill.id);
    repo.addAgentSkill(agent.id, skill.id); // should not throw

    const skills = repo.getAgentSkills(agent.id);
    expect(skills).toHaveLength(1);
  });

  it('33 — removes an agent-skill association', () => {
    const { agent, skill } = setupAgentAndSkill();
    repo.addAgentSkill(agent.id, skill.id);
    expect(repo.getAgentSkills(agent.id)).toHaveLength(1);

    repo.removeAgentSkill(agent.id, skill.id);
    expect(repo.getAgentSkills(agent.id)).toHaveLength(0);
  });

  it('34 — cascading delete removes associations', () => {
    const { agent, skill } = setupAgentAndSkill();
    repo.addAgentSkill(agent.id, skill.id);
    expect(repo.getAgentSkills(agent.id)).toHaveLength(1);

    // Delete the agent, association should be gone via CASCADE
    repo.deletePredefinedAgent(agent.id);
    expect(repo.getAgentSkills(agent.id)).toHaveLength(0);
  });
});

describe('createWorkflowRun — template link', () => {
  it('35 — without opts, run has no templateId / templateVersion (inline-script path)', () => {
    const run = repo.createWorkflowRun(sampleDefinition(), 'Inline');
    expect(run.templateId).toBeUndefined();
    expect(run.templateVersion).toBeUndefined();

    const fetched = repo.getWorkflowRun(run.id);
    expect(fetched!.templateId).toBeUndefined();
    expect(fetched!.templateVersion).toBeUndefined();
  });

  it('36 — with opts, run round-trips templateId + templateVersion', () => {
    const run = repo.createWorkflowRun(sampleDefinition(), 'FromTemplate', {
      templateId: 'tpl-abc',
      templateVersion: 3,
    });
    expect(run.templateId).toBe('tpl-abc');
    expect(run.templateVersion).toBe(3);

    const fetched = repo.getWorkflowRun(run.id);
    expect(fetched!.templateId).toBe('tpl-abc');
    expect(fetched!.templateVersion).toBe(3);
  });

  it('37 — with only templateId, templateVersion is undefined', () => {
    const run = repo.createWorkflowRun(sampleDefinition(), 'FromTemplate', {
      templateId: 'tpl-abc',
    });
    expect(run.templateId).toBe('tpl-abc');
    expect(run.templateVersion).toBeUndefined();
  });
});

describe('createWorkflowRun — runtime config', () => {
  it('stores and retrieves runtimeConfig', () => {
    const def: WorkflowDefinition = { name: 'test', phases: [] };
    const rc: RuntimeConfig = { runner: 'cua', llmProvider: 'opencode', model: 'gpt-4o' };
    const run = repo.createWorkflowRun(def, 'With Config', { runtimeConfig: rc });
    expect(run.runtimeConfig).toEqual(rc);

    const fetched = repo.getWorkflowRun(run.id);
    expect(fetched).toBeDefined();
    expect(fetched!.runtimeConfig).toEqual(rc);
  });

  it('stores null runtime_config_json when not provided', () => {
    const def: WorkflowDefinition = { name: 'test', phases: [] };
    const run = repo.createWorkflowRun(def, 'No Config');
    expect(run.runtimeConfig).toBeUndefined();
  });

  it('stores partial runtimeConfig', () => {
    const def: WorkflowDefinition = { name: 'test', phases: [] };
    const rc: RuntimeConfig = { runner: 'pi-direct' };
    const run = repo.createWorkflowRun(def, 'Partial Config', { runtimeConfig: rc });
    expect(run.runtimeConfig?.runner).toBe('pi-direct');
    expect(run.runtimeConfig?.llmProvider).toBeUndefined();

    const fetched = repo.getWorkflowRun(run.id);
    expect(fetched!.runtimeConfig?.runner).toBe('pi-direct');
  });
});

describe('getWorkflowRun — definition parsed', () => {
  it('returns parsed definition from definition_json', () => {
    const def: WorkflowDefinition = { name: 'test-flow', phases: [{ name: 'p1', agents: [{ name: 'a1', prompt: 'do' }] }] };
    const run = repo.createWorkflowRun(def, 'Test Def');
    expect(run.definition).toBeDefined();
    expect(run.definition!.name).toBe('test-flow');
    expect(run.definition!.phases).toHaveLength(1);
  });

  it('handles malformed definition_json gracefully', () => {
    const db = getDb();
    db.prepare(`INSERT INTO workflow_runs (id, name, status, definition_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)`)
      .run('bad-def', 'Bad', 'pending', '{invalid json}', '2024-01-01', '2024-01-01');

    const fetched = repo.getWorkflowRun('bad-def');
    expect(fetched).toBeDefined();
    expect(fetched!.definition).toBeUndefined();
  });
});

describe('updateWorkflowRun', () => {
  it('updates runtimeConfig', () => {
    const def: WorkflowDefinition = { name: 'test', phases: [] };
    const run = repo.createWorkflowRun(def, 'Test');
    expect(run.runtimeConfig).toBeUndefined();

    const rc: RuntimeConfig = { runner: 'cua', model: 'gpt-4o' };
    repo.updateWorkflowRun(run.id, { runtimeConfig: rc });

    const fetched = repo.getWorkflowRun(run.id);
    expect(fetched!.runtimeConfig).toEqual(rc);
  });

  it('clears runtimeConfig to null', () => {
    const def: WorkflowDefinition = { name: 'test', phases: [] };
    const run = repo.createWorkflowRun(def, 'Test', { runtimeConfig: { runner: 'cua' } });
    expect(run.runtimeConfig).toBeDefined();

    repo.updateWorkflowRun(run.id, { runtimeConfig: null as unknown as RuntimeConfig });

    const fetched = repo.getWorkflowRun(run.id);
    expect(fetched!.runtimeConfig).toBeUndefined();
  });

  it('updates status', () => {
    const def: WorkflowDefinition = { name: 'test', phases: [] };
    const run = repo.createWorkflowRun(def, 'Test');

    repo.updateWorkflowRun(run.id, { status: 'running' });

    const fetched = repo.getWorkflowRun(run.id);
    expect(fetched!.status).toBe('running');
  });

  it('ignores unknown fields', () => {
    const def: WorkflowDefinition = { name: 'test', phases: [] };
    const run = repo.createWorkflowRun(def, 'Test');

    // @ts-expect-error — testing unknown field
    repo.updateWorkflowRun(run.id, { nonExistent: 'value' });

    const fetched = repo.getWorkflowRun(run.id);
    expect(fetched).toBeDefined();
  });
});
