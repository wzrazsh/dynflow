import { v4 as uuidv4 } from 'uuid';
import { getDb, withRetry } from './connection.js';
import { RuntimeConfigSchema } from '@dynflow/shared';
import type {
  WorkflowDefinition,
  WorkflowListFilters,
  WorkflowRun,
  PhaseRun,
  AgentRun,
  WorkflowStatus,
  PhaseStatus,
  AgentStatus,
  PhaseDefinition,
  AgentDefinition,
  Domain,
  AgentSource,
  AgentRole,
  PredefinedAgent,
  Skill,
  SkillParameter,
  RuntimeConfig,
} from '@dynflow/shared';

// ---------------------------------------------------------------------------
// Workflow-level operations
// ---------------------------------------------------------------------------

/**
 * Create a new workflow run from a definition.
 * Inserts the workflow row, creates phases and agent runs,
 * then returns the fully assembled tree.
 *
 * If `opts.templateId` is provided, the run is linked back to the source
 * template (and its `currentVersion` at the time of creation) so the
 * connection survives in the DB and can be surfaced in the UI.
 * Inline-script runs (POST /api/workflows) leave these columns NULL.
 */
export function createWorkflowRun(
  definition: WorkflowDefinition,
  name: string,
  opts?: {
    templateId?: string;
    templateVersion?: number;
    script?: string;
    runtimeConfig?: RuntimeConfig;
  },
): WorkflowRun {
  const db = getDb();
  const id = uuidv4();
  const now = new Date().toISOString();

  withRetry(() =>
    db.prepare(
      `INSERT INTO workflow_runs (
         id, name, status, definition_json, created_at, updated_at,
         template_id, template_version,
         workspace_path, workspace_git_url, workspace_branch,
         script, runtime_config_json
       )
       VALUES (?, ?, 'pending', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      id,
      name,
      JSON.stringify(definition),
      now,
      now,
      opts?.templateId ?? null,
      opts?.templateVersion ?? null,
      definition.workspace?.path ?? null,
      definition.workspace?.git ?? null,
      definition.workspace?.branch ?? null,
      opts?.script ?? null,
      opts?.runtimeConfig ? JSON.stringify(opts.runtimeConfig) : null,
    ),
  );

  getOrCreatePhases(id, definition.phases);

  // Return the full assembled tree
  return getWorkflowRun(id)!;
}

/**
 * Retrieve a single workflow run with its full phase + agent tree.
 * Returns `undefined` if the ID does not exist.
 */
export function getWorkflowRun(id: string): WorkflowRun | undefined {
  const db = getDb();

  const workflow = withRetry(() =>
    db
      .prepare('SELECT * FROM workflow_runs WHERE id = ?')
      .get(id),
  ) as Record<string, unknown> | undefined;

  if (!workflow) return undefined;

  const phases = withRetry(() =>
    db
      .prepare(
        'SELECT * FROM phase_runs WHERE workflow_run_id = ? ORDER BY order_num ASC',
      )
      .all(id),
  ) as Record<string, unknown>[];

  const phaseRuns: PhaseRun[] = phases.map((phase) => {
    const agents = withRetry(() =>
      db
        .prepare('SELECT * FROM agent_runs WHERE phase_run_id = ?')
        .all(phase.id),
    ) as Record<string, unknown>[];
    return {
      id: phase.id as string,
      name: phase.name as string,
      status: phase.status as PhaseStatus,
      agents: agents.map(rowToAgentRun),
      order: phase.order_num as number,
    };
  });

  return {
    id: workflow.id as string,
    name: workflow.name as string,
    status: workflow.status as WorkflowStatus,
    phases: phaseRuns,
    createdAt: workflow.created_at as string,
    updatedAt: workflow.updated_at as string,
    templateId: (workflow.template_id as string | null) ?? undefined,
    templateVersion:
      workflow.template_version === null || workflow.template_version === undefined
        ? undefined
        : (workflow.template_version as number),
    workspacePath: (workflow.workspace_path as string | null) ?? undefined,
    workspaceGitUrl: (workflow.workspace_git_url as string | null) ?? undefined,
    workspaceBranch: (workflow.workspace_branch as string | null) ?? undefined,
    script: (workflow.script as string | null) ?? undefined,
    runtimeConfig: parseRuntimeConfig(workflow.runtime_config_json),
    definition: parseDefinition(workflow.definition_json),
  };
}

/**
 * List workflow runs with cursor-based pagination.
 * Results are ordered by creation date, newest first.
 */
export function listWorkflowRuns(
  page: number,
  pageSize: number,
  filters: WorkflowListFilters = {},
): { runs: WorkflowRun[]; total: number } {
  const db = getDb();

  const conditions: string[] = [];
  const params: unknown[] = [];

  if (filters.name) {
    conditions.push('name LIKE ?');
    params.push(`%${filters.name}%`);
  }
  if (filters.status) {
    conditions.push('status = ?');
    params.push(filters.status);
  }
  if (filters.templateId) {
    conditions.push('template_id = ?');
    params.push(filters.templateId);
  }
  if (filters.sinceDays !== undefined) {
    conditions.push('julianday(created_at) >= julianday(\'now\', ?)');
    params.push(`-${filters.sinceDays} days`);
  }

  const whereClause = conditions.length > 0 ? ` WHERE ${conditions.join(' AND ')}` : '';

  const countRow = withRetry(() =>
    db
      .prepare(`SELECT COUNT(*) as count FROM workflow_runs${whereClause}`)
      .get(...params),
  ) as { count: number };
  const total = countRow.count;

  const offset = (page - 1) * pageSize;
  const rows = withRetry(() =>
    db
      .prepare(
        `SELECT id FROM workflow_runs${whereClause} ORDER BY created_at DESC LIMIT ? OFFSET ?`,
      )
      .all(...params, pageSize, offset),
  ) as { id: string }[];

  const runs = rows.map((row) => getWorkflowRun(row.id)!);

  return { runs, total };
}

/**
 * Update the status of a workflow run and its updated_at timestamp.
 */
export function updateWorkflowStatus(
  id: string,
  status: WorkflowStatus,
): void {
  const db = getDb();
  const now = new Date().toISOString();
  withRetry(() =>
    db.prepare(
      'UPDATE workflow_runs SET status = ?, updated_at = ? WHERE id = ?',
    ).run(status, now, id),
  );
}

/**
 * Atomically transition a workflow run from one status to another.
 * The UPDATE only affects the row if the current status matches `from`,
 * preventing race conditions when two callers try to transition the same
 * run simultaneously.
 *
 * @returns `true` if exactly one row was updated, `false` otherwise.
 */
export function transitionWorkflowStatus(
  id: string,
  from: WorkflowStatus,
  to: WorkflowStatus,
): boolean {
  const db = getDb();
  const now = new Date().toISOString();
  const result = withRetry(() =>
    db
      .prepare(
        'UPDATE workflow_runs SET status = ?, updated_at = ? WHERE id = ? AND status = ?',
      )
      .run(to, now, id, from),
  );
  return result.changes === 1;
}

/**
 * Update a workflow run's mutable fields.
 * Uses a whitelist approach — only known fields can be updated.
 * For runtimeConfig: serializes to JSON; if null/undefined, stores NULL.
 */
export function updateWorkflowRun(
  id: string,
  partial: Partial<Pick<WorkflowRun, 'name' | 'status' | 'runtimeConfig'>>,
): void {
  const db = getDb();
  const now = new Date().toISOString();

  const setClauses: string[] = ['updated_at = ?'];
  const values: unknown[] = [now];

  if (partial.name !== undefined) {
    setClauses.push('name = ?');
    values.push(partial.name);
  }
  if (partial.status !== undefined) {
    setClauses.push('status = ?');
    values.push(partial.status);
  }
  if (partial.runtimeConfig !== undefined) {
    setClauses.push('runtime_config_json = ?');
    values.push(
      partial.runtimeConfig === null || partial.runtimeConfig === undefined
        ? null
        : JSON.stringify(partial.runtimeConfig),
    );
  }

  values.push(id);
  withRetry(() =>
    db.prepare(`UPDATE workflow_runs SET ${setClauses.join(', ')} WHERE id = ?`).run(...values),
  );
}

/**
 * Delete a workflow run and all associated phases/agents (CASCADE).
 * No-op if the ID does not exist.
 */
export function deleteWorkflowRun(id: string): void {
  const db = getDb();
  withRetry(() => db.prepare('DELETE FROM workflow_runs WHERE id = ?').run(id));
}

// ---------------------------------------------------------------------------
// Phase-level operations
// ---------------------------------------------------------------------------

/**
 * Get or create phase runs for a workflow run from phase definitions.
 * Returns the created PhaseRun[] for the given phases.
 */
export function getOrCreatePhases(
  workflowRunId: string,
  phases: PhaseDefinition[],
): PhaseRun[] {
  const db = getDb();

  const insertPhase = db.prepare(
    `INSERT INTO phase_runs (id, workflow_run_id, name, status, order_num, started_at, completed_at)
     VALUES (?, ?, ?, 'pending', ?, NULL, NULL)`,
  );

  const insertAgent = db.prepare(
    `INSERT INTO agent_runs (id, phase_run_id, name, status, prompt, model, output, error, started_at, completed_at, docker_container_id, no_vnc_url, cua_api_url)
     VALUES (?, ?, ?, 'pending', ?, 'gpt-4o', NULL, NULL, NULL, NULL, NULL, NULL, NULL)`,
  );

  return phases.map((phaseDef, index) => {
    const phaseId = uuidv4();
    withRetry(() => insertPhase.run(phaseId, workflowRunId, phaseDef.name, index));

    const agentRuns: AgentRun[] = phaseDef.agents.map((agentDef) => {
      const agentId = uuidv4();
      const effectivePrompt = resolveEffectivePrompt(agentDef);
      withRetry(() => insertAgent.run(agentId, phaseId, agentDef.name, effectivePrompt));
      return {
        id: agentId,
        name: agentDef.name,
        status: 'pending' as AgentStatus,
        prompt: effectivePrompt,
      };
    });

    return {
      id: phaseId,
      name: phaseDef.name,
      status: 'pending' as PhaseStatus,
      agents: agentRuns,
      order: index,
    };
  });
}

/**
 * Update the status of a phase run.
 * Automatically sets started_at when transitioning to 'running'
 * and completed_at for terminal states (completed, completed_with_errors, failed).
 */
export function updatePhaseStatus(id: string, status: PhaseStatus): void {
  const db = getDb();
  const now = new Date().toISOString();

  const setClauses: string[] = ['status = ?'];
  const values: unknown[] = [status];

  const terminalStates: PhaseStatus[] = ['completed', 'completed_with_errors', 'failed'];
  if (status === 'running') {
    setClauses.push('started_at = ?');
    values.push(now);
  } else if (terminalStates.includes(status)) {
    setClauses.push('completed_at = ?');
    values.push(now);
  }

  values.push(id);
  withRetry(() =>
    db.prepare(`UPDATE phase_runs SET ${setClauses.join(', ')} WHERE id = ?`).run(...values),
  );
}

// ---------------------------------------------------------------------------
// Agent-level operations
// ---------------------------------------------------------------------------

/**
 * Create agent runs for a given phase.
 */
export function createAgentRuns(
  phaseRunId: string,
  agents: AgentDefinition[],
): void {
  const db = getDb();
  const insert = db.prepare(
    `INSERT INTO agent_runs (id, phase_run_id, name, status, prompt, model, output, error, started_at, completed_at, docker_container_id)
     VALUES (?, ?, ?, 'pending', ?, 'gpt-4o', NULL, NULL, NULL, NULL, NULL)`,
  );

  for (const agent of agents) {
    const effectivePrompt = resolveEffectivePrompt(agent);
    withRetry(() => insert.run(uuidv4(), phaseRunId, agent.name, effectivePrompt));
  }
}

/**
 * Update an agent run's status and optional fields.
 * Only SET clauses for provided opts are included in the UPDATE.
 * When the status is terminal (completed/failed/timeout/cancelled),
 * completed_at is automatically set.
 */
export function updateAgentStatus(
  id: string,
  status: AgentStatus,
  opts?: {
    output?: string;
    error?: string;
    containerId?: string;
    noVncUrl?: string;
    cuaApiUrl?: string;
    files?: string[];
    fileCount?: number;
    totalSize?: number;
    outputDir?: string;
  },
): void {
  const db = getDb();
  const now = new Date().toISOString();

  const setClauses: string[] = ['status = ?'];
  const values: unknown[] = [status];

  // Set completed_at only for terminal states
  const terminalStates: AgentStatus[] = [
    'completed',
    'failed',
    'timeout',
    'cancelled',
  ];
  if (terminalStates.includes(status)) {
    setClauses.push('completed_at = ?');
    values.push(now);
  }

  // When actual file metadata is present, store both output text and file
  // info as a single JSON object in the `output` column.
  // Only triggers for non-empty file arrays or positive counts (empty arrays
  // or zero counts from runners that always set the field are treated as
  // "no files" to preserve backward compatibility with existing DB consumers).
  const hasFiles =
    (opts?.files !== undefined && opts.files.length > 0) ||
    (opts?.fileCount !== undefined && opts.fileCount > 0) ||
    (opts?.totalSize !== undefined && opts.totalSize > 0);
  if (hasFiles) {
    const outputPayload: Record<string, unknown> = {};
    if (opts?.output !== undefined) outputPayload.text = opts.output;
    if (opts?.files !== undefined) outputPayload.files = opts.files;
    if (opts?.fileCount !== undefined) outputPayload.fileCount = opts.fileCount;
    if (opts?.totalSize !== undefined) outputPayload.totalSize = opts.totalSize;
    if (opts?.outputDir !== undefined) outputPayload.outputDir = opts.outputDir;
    setClauses.push('output = ?');
    values.push(JSON.stringify(outputPayload));
  } else if (opts?.output !== undefined) {
    setClauses.push('output = ?');
    values.push(opts.output);
  }

  if (opts?.error !== undefined) {
    setClauses.push('error = ?');
    values.push(opts.error);
  }
  if (opts?.containerId !== undefined) {
    setClauses.push('docker_container_id = ?');
    values.push(opts.containerId);
  }
  if (opts?.noVncUrl !== undefined) {
    setClauses.push('no_vnc_url = ?');
    values.push(opts.noVncUrl);
  }
  if (opts?.cuaApiUrl !== undefined) {
    setClauses.push('cua_api_url = ?');
    values.push(opts.cuaApiUrl);
  }

  values.push(id);
  withRetry(() =>
    db.prepare(`UPDATE agent_runs SET ${setClauses.join(', ')} WHERE id = ?`).run(
      ...values,
    ),
  );
}

/**
 * Get all agent runs for a given phase.
 */
export function getPhaseAgents(phaseRunId: string): AgentRun[] {
  const db = getDb();
  const rows = withRetry(() =>
    db
      .prepare('SELECT * FROM agent_runs WHERE phase_run_id = ?')
      .all(phaseRunId),
  ) as Record<string, unknown>[];
  return rows.map(rowToAgentRun);
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Resolve the effective prompt for an AgentDefinition.
 *
 * - If `prompt` is provided, use it directly (inline or override).
 * - Otherwise, if `agentId` is provided, look it up in the predefined
 *   agent registry and use its `systemPrompt`.
 * - If neither exists, throw a controlled error.
 */
function resolveEffectivePrompt(agentDef: AgentDefinition): string {
  if (agentDef.prompt) return agentDef.prompt;
  if (agentDef.agentId) {
    const predefined = getPredefinedAgent(agentDef.agentId);
    if (!predefined) {
      throw new Error(
        `Predefined agent "${agentDef.agentId}" not found in registry`,
      );
    }
    return predefined.systemPrompt;
  }
  throw new Error(
    `Agent "${agentDef.name}" must have either a prompt or an agentId`,
  );
}

/**
 * Map a raw DB row to an AgentRun.
 */
function rowToAgentRun(row: Record<string, unknown>): AgentRun {
  return {
    id: row.id as string,
    name: row.name as string,
    status: row.status as AgentStatus,
    prompt: row.prompt as string,
    output: (row.output as string) ?? undefined,
    error: (row.error as string) ?? undefined,
    startedAt: (row.started_at as string) ?? undefined,
    completedAt: (row.completed_at as string) ?? undefined,
    noVncUrl: (row.no_vnc_url as string | null) ?? undefined,
    cuaApiUrl: (row.cua_api_url as string | null) ?? undefined,
  };
}

// ---------------------------------------------------------------------------
// Domain registry CRUD
// ---------------------------------------------------------------------------

/**
 * Create a new domain entry.
 */
export function createDomain(data: {
  name: string;
  description: string;
  icon?: string;
}): Domain {
  const db = getDb();
  const id = uuidv4();
  withRetry(() =>
    db
      .prepare(
        'INSERT INTO domains (id, name, description, icon) VALUES (?, ?, ?, ?)',
      )
      .run(id, data.name, data.description, data.icon ?? null),
  );
  return getDomain(id)!;
}

/**
 * Retrieve a single domain by ID.
 */
export function getDomain(id: string): Domain | undefined {
  const db = getDb();
  const row = withRetry(() =>
    db.prepare('SELECT * FROM domains WHERE id = ?').get(id),
  ) as Record<string, unknown> | undefined;
  if (!row) return undefined;
  return {
    id: row.id as string,
    name: row.name as string,
    description: row.description as string,
    icon: (row.icon as string) ?? undefined,
  };
}

/**
 * List all domains.
 */
export function getAllDomains(): Domain[] {
  const db = getDb();
  const rows = withRetry(() =>
    db.prepare('SELECT * FROM domains ORDER BY name ASC').all(),
  ) as Record<string, unknown>[];
  return rows.map((row) => ({
    id: row.id as string,
    name: row.name as string,
    description: row.description as string,
    icon: (row.icon as string) ?? undefined,
  }));
}

/**
 * List domains with pagination. Returns the subset for the requested page
 * along with the total number of domains.
 */
export function getDomainsPaginated(
  page: number,
  pageSize: number,
): { domains: Domain[]; total: number } {
  const db = getDb();
  const countRow = withRetry(() =>
    db.prepare('SELECT COUNT(*) as count FROM domains').get(),
  ) as { count: number };
  const total = countRow.count;
  const offset = (page - 1) * pageSize;
  const rows = withRetry(() =>
    db
      .prepare('SELECT * FROM domains ORDER BY name ASC LIMIT ? OFFSET ?')
      .all(pageSize, offset),
  ) as Record<string, unknown>[];
  return {
    domains: rows.map((row) => ({
      id: row.id as string,
      name: row.name as string,
      description: row.description as string,
      icon: (row.icon as string) ?? undefined,
    })),
    total,
  };
}

/**
 * Delete a domain by ID (cascades to sources, roles, agents, skills).
 */
export function deleteDomain(id: string): void {
  const db = getDb();
  withRetry(() => db.prepare('DELETE FROM domains WHERE id = ?').run(id));
}

// ---------------------------------------------------------------------------
// Agent source CRUD
// ---------------------------------------------------------------------------

/**
 * Create a new agent source under a domain.
 */
export function createAgentSource(data: {
  domainId: string;
  name: string;
  url: string;
  description: string;
}): AgentSource {
  const db = getDb();
  const id = uuidv4();
  withRetry(() =>
    db
      .prepare(
        'INSERT INTO agent_sources (id, domain_id, name, url, description) VALUES (?, ?, ?, ?, ?)',
      )
      .run(id, data.domainId, data.name, data.url, data.description),
  );
  return getAgentSource(id)!;
}

/**
 * Retrieve a single agent source by ID.
 */
export function getAgentSource(id: string): AgentSource | undefined {
  const db = getDb();
  const row = withRetry(() =>
    db.prepare('SELECT * FROM agent_sources WHERE id = ?').get(id),
  ) as Record<string, unknown> | undefined;
  if (!row) return undefined;
  return {
    id: row.id as string,
    domainId: row.domain_id as string,
    name: row.name as string,
    url: row.url as string,
    description: row.description as string,
  };
}

/**
 * List all agent sources belonging to a domain.
 */
export function getSourcesByDomain(domainId: string): AgentSource[] {
  const db = getDb();
  const rows = withRetry(() =>
    db
      .prepare('SELECT * FROM agent_sources WHERE domain_id = ? ORDER BY name ASC')
      .all(domainId),
  ) as Record<string, unknown>[];
  return rows.map((row) => ({
    id: row.id as string,
    domainId: row.domain_id as string,
    name: row.name as string,
    url: row.url as string,
    description: row.description as string,
  }));
}

/**
 * List all agent sources with pagination. Returns the subset for the
 * requested page along with the total number of sources.
 */
export function getSourcesPaginated(
  page: number,
  pageSize: number,
): { sources: AgentSource[]; total: number } {
  const db = getDb();
  const countRow = withRetry(() =>
    db.prepare('SELECT COUNT(*) as count FROM agent_sources').get(),
  ) as { count: number };
  const total = countRow.count;
  const offset = (page - 1) * pageSize;
  const rows = withRetry(() =>
    db
      .prepare('SELECT * FROM agent_sources ORDER BY name ASC LIMIT ? OFFSET ?')
      .all(pageSize, offset),
  ) as Record<string, unknown>[];
  return {
    sources: rows.map((row) => ({
      id: row.id as string,
      domainId: row.domain_id as string,
      name: row.name as string,
      url: row.url as string,
      description: row.description as string,
    })),
    total,
  };
}

/**
 * Delete an agent source by ID (cascades to roles, agents, skills).
 */
export function deleteAgentSource(id: string): void {
  const db = getDb();
  withRetry(() =>
    db.prepare('DELETE FROM agent_sources WHERE id = ?').run(id),
  );
}

// ---------------------------------------------------------------------------
// Agent role CRUD
// ---------------------------------------------------------------------------

/**
 * Create a new agent role under a source.
 */
export function createAgentRole(data: {
  sourceId: string;
  name: string;
  description: string;
  tier?: number;
}): AgentRole {
  const db = getDb();
  const id = uuidv4();
  withRetry(() =>
    db
      .prepare(
        'INSERT INTO agent_roles (id, source_id, name, description, tier) VALUES (?, ?, ?, ?, ?)',
      )
      .run(id, data.sourceId, data.name, data.description, data.tier ?? 0),
  );
  return getAgentRole(id)!;
}

/**
 * Retrieve a single agent role by ID.
 */
export function getAgentRole(id: string): AgentRole | undefined {
  const db = getDb();
  const row = withRetry(() =>
    db.prepare('SELECT * FROM agent_roles WHERE id = ?').get(id),
  ) as Record<string, unknown> | undefined;
  if (!row) return undefined;
  return {
    id: row.id as string,
    sourceId: row.source_id as string,
    name: row.name as string,
    description: row.description as string,
    tier: row.tier as number,
  };
}

/**
 * List all agent roles belonging to a source.
 */
export function getRolesBySource(sourceId: string): AgentRole[] {
  const db = getDb();
  const rows = withRetry(() =>
    db
      .prepare(
        'SELECT * FROM agent_roles WHERE source_id = ? ORDER BY tier ASC, name ASC',
      )
      .all(sourceId),
  ) as Record<string, unknown>[];
  return rows.map((row) => ({
    id: row.id as string,
    sourceId: row.source_id as string,
    name: row.name as string,
    description: row.description as string,
    tier: row.tier as number,
  }));
}

/**
 * Delete an agent role by ID (cascades to predefined agents).
 */
export function deleteAgentRole(id: string): void {
  const db = getDb();
  withRetry(() => db.prepare('DELETE FROM agent_roles WHERE id = ?').run(id));
}

// ---------------------------------------------------------------------------
// Predefined agent CRUD
// ---------------------------------------------------------------------------

/**
 * Create a new predefined agent under a role.
 */
export function createPredefinedAgent(data: {
  roleId: string;
  name: string;
  description: string;
  systemPrompt: string;
  availableSkills?: string[];
}): PredefinedAgent {
  const db = getDb();
  const id = uuidv4();
  withRetry(() =>
    db
      .prepare(
        'INSERT INTO predefined_agents (id, role_id, name, description, system_prompt, available_skills) VALUES (?, ?, ?, ?, ?, ?)',
      )
      .run(
        id,
        data.roleId,
        data.name,
        data.description,
        data.systemPrompt,
        JSON.stringify(data.availableSkills ?? []),
      ),
  );
  return getPredefinedAgent(id)!;
}

/**
 * Retrieve a single predefined agent by ID.
 */
export function getPredefinedAgent(id: string): PredefinedAgent | undefined {
  const db = getDb();
  const row = withRetry(() =>
    db.prepare('SELECT * FROM predefined_agents WHERE id = ?').get(id),
  ) as Record<string, unknown> | undefined;
  if (!row) return undefined;
  return {
    id: row.id as string,
    roleId: row.role_id as string,
    name: row.name as string,
    description: row.description as string,
    systemPrompt: row.system_prompt as string,
    availableSkills: JSON.parse(row.available_skills as string) as string[],
  };
}

/**
 * List all predefined agents belonging to a role.
 */
export function getAgentsByRole(roleId: string): PredefinedAgent[] {
  const db = getDb();
  const rows = withRetry(() =>
    db
      .prepare(
        'SELECT * FROM predefined_agents WHERE role_id = ? ORDER BY name ASC',
      )
      .all(roleId),
  ) as Record<string, unknown>[];
  return rows.map((row) => ({
    id: row.id as string,
    roleId: row.role_id as string,
    name: row.name as string,
    description: row.description as string,
    systemPrompt: row.system_prompt as string,
    availableSkills: JSON.parse(row.available_skills as string) as string[],
  }));
}

/**
 * List all predefined agents with pagination. Returns the subset for the
 * requested page along with the total number of predefined agents.
 */
export function getPredefinedAgentsPaginated(
  page: number,
  pageSize: number,
): { agents: PredefinedAgent[]; total: number } {
  const db = getDb();
  const countRow = withRetry(() =>
    db.prepare('SELECT COUNT(*) as count FROM predefined_agents').get(),
  ) as { count: number };
  const total = countRow.count;
  const offset = (page - 1) * pageSize;
  const rows = withRetry(() =>
    db
      .prepare(
        'SELECT * FROM predefined_agents ORDER BY name ASC LIMIT ? OFFSET ?',
      )
      .all(pageSize, offset),
  ) as Record<string, unknown>[];
  return {
    agents: rows.map((row) => ({
      id: row.id as string,
      roleId: row.role_id as string,
      name: row.name as string,
      description: row.description as string,
      systemPrompt: row.system_prompt as string,
      availableSkills: JSON.parse(row.available_skills as string) as string[],
    })),
    total,
  };
}

/**
 * Delete a predefined agent by ID.
 */
export function deletePredefinedAgent(id: string): void {
  const db = getDb();
  withRetry(() =>
    db.prepare('DELETE FROM predefined_agents WHERE id = ?').run(id),
  );
}

// ---------------------------------------------------------------------------
// Skill CRUD
// ---------------------------------------------------------------------------

/**
 * Create a new skill under a source.
 */
export function createSkill(data: {
  sourceId: string;
  name: string;
  description: string;
  category: string;
  parameters?: SkillParameter[];
  inputSchema?: Record<string, unknown>;
  outputSchema?: Record<string, unknown>;
}): Skill {
  const db = getDb();
  const id = uuidv4();
  withRetry(() =>
    db
      .prepare(
        'INSERT INTO skills (id, source_id, name, description, category, parameters, input_schema, output_schema) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      )
      .run(
        id,
        data.sourceId,
        data.name,
        data.description,
        data.category,
        JSON.stringify(data.parameters ?? []),
        data.inputSchema ? JSON.stringify(data.inputSchema) : null,
        data.outputSchema ? JSON.stringify(data.outputSchema) : null,
      ),
  );
  return getSkill(id)!;
}

/**
 * Retrieve a single skill by ID.
 */
export function getSkill(id: string): Skill | undefined {
  const db = getDb();
  const row = withRetry(() =>
    db.prepare('SELECT * FROM skills WHERE id = ?').get(id),
  ) as Record<string, unknown> | undefined;
  if (!row) return undefined;
  return {
    id: row.id as string,
    sourceId: row.source_id as string,
    name: row.name as string,
    description: row.description as string,
    category: row.category as Skill['category'],
    parameters: JSON.parse(row.parameters as string) as SkillParameter[],
    inputSchema: row.input_schema
      ? (JSON.parse(row.input_schema as string) as Record<string, unknown>)
      : undefined,
    outputSchema: row.output_schema
      ? (JSON.parse(row.output_schema as string) as Record<string, unknown>)
      : undefined,
  };
}

/**
 * List all skills belonging to a source.
 */
export function getSkillsBySource(sourceId: string): Skill[] {
  const db = getDb();
  const rows = withRetry(() =>
    db
      .prepare('SELECT * FROM skills WHERE source_id = ? ORDER BY name ASC')
      .all(sourceId),
  ) as Record<string, unknown>[];
  return rows.map((row) => ({
    id: row.id as string,
    sourceId: row.source_id as string,
    name: row.name as string,
    description: row.description as string,
    category: row.category as Skill['category'],
    parameters: JSON.parse(row.parameters as string) as SkillParameter[],
    inputSchema: row.input_schema
      ? (JSON.parse(row.input_schema as string) as Record<string, unknown>)
      : undefined,
    outputSchema: row.output_schema
      ? (JSON.parse(row.output_schema as string) as Record<string, unknown>)
      : undefined,
  }));
}

/**
 * List all skills with pagination and optional source/category filtering.
 */
export function getSkillsPaginated(
  page: number,
  pageSize: number,
  sourceId?: string,
  category?: string,
): { skills: Skill[]; total: number } {
  const db = getDb();

  const conditions: string[] = [];
  const params: unknown[] = [];

  if (sourceId) {
    conditions.push('source_id = ?');
    params.push(sourceId);
  }
  if (category) {
    conditions.push('category = ?');
    params.push(category);
  }

  const whereClause = conditions.length > 0 ? ` WHERE ${conditions.join(' AND ')}` : '';

  const countRow = withRetry(() =>
    db.prepare(`SELECT COUNT(*) as count FROM skills${whereClause}`).get(...params),
  ) as { count: number };
  const total = countRow.count;

  const offset = (page - 1) * pageSize;
  const rows = withRetry(() =>
    db
      .prepare(`SELECT * FROM skills${whereClause} ORDER BY name ASC LIMIT ? OFFSET ?`)
      .all(...params, pageSize, offset),
  ) as Record<string, unknown>[];

  return {
    skills: rows.map((row) => ({
      id: row.id as string,
      sourceId: row.source_id as string,
      name: row.name as string,
      description: row.description as string,
      category: row.category as Skill['category'],
      parameters: JSON.parse(row.parameters as string) as SkillParameter[],
      inputSchema: row.input_schema
        ? (JSON.parse(row.input_schema as string) as Record<string, unknown>)
        : undefined,
      outputSchema: row.output_schema
        ? (JSON.parse(row.output_schema as string) as Record<string, unknown>)
        : undefined,
    })),
    total,
  };
}

/**
 * Delete a skill by ID.
 */
export function deleteSkill(id: string): void {
  const db = getDb();
  withRetry(() => db.prepare('DELETE FROM skills WHERE id = ?').run(id));
}

// ---------------------------------------------------------------------------
// Agent-skill association CRUD
// ---------------------------------------------------------------------------

/**
 * Associate a skill with a predefined agent.
 */
export function addAgentSkill(agentId: string, skillId: string): void {
  const db = getDb();
  withRetry(() =>
    db
      .prepare(
        'INSERT OR IGNORE INTO agent_skills (agent_id, skill_id) VALUES (?, ?)',
      )
      .run(agentId, skillId),
  );
}

/**
 * List all skill IDs associated with a predefined agent.
 */
export function getAgentSkills(agentId: string): string[] {
  const db = getDb();
  const rows = withRetry(() =>
    db
      .prepare('SELECT skill_id FROM agent_skills WHERE agent_id = ?')
      .all(agentId),
  ) as { skill_id: string }[];
  return rows.map((r) => r.skill_id);
}

/**
 * Remove a skill association from a predefined agent.
 */
export function removeAgentSkill(agentId: string, skillId: string): void {
  const db = getDb();
  withRetry(() =>
    db
      .prepare(
        'DELETE FROM agent_skills WHERE agent_id = ? AND skill_id = ?',
      )
      .run(agentId, skillId),
  );
}

// ---------------------------------------------------------------------------
// JSON parsing helpers
// ---------------------------------------------------------------------------

/**
 * Parse `runtime_config_json` from the database into a RuntimeConfig object.
 * Returns undefined if the column is NULL, empty, or contains invalid JSON
 * that doesn't match the RuntimeConfigSchema.
 */
function parseRuntimeConfig(raw: unknown): RuntimeConfig | undefined {
  if (!raw || typeof raw !== 'string') return undefined;
  try {
    const parsed = JSON.parse(raw);
    const result = RuntimeConfigSchema.safeParse(parsed);
    return result.success ? result.data : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Parse `definition_json` from the database into a WorkflowDefinition object.
 * Uses basic structural validation (must have `name` and `phases` array).
 * Returns undefined if the column is NULL, empty, or contains invalid JSON.
 */
function parseDefinition(raw: unknown): WorkflowDefinition | undefined {
  if (!raw || typeof raw !== 'string') return undefined;
  try {
    const parsed = JSON.parse(raw) as WorkflowDefinition;
    // Basic structural validation: must have name and phases
    if (typeof parsed !== 'object' || !parsed || !parsed.name || !Array.isArray(parsed.phases)) {
      return undefined;
    }
    return parsed;
  } catch {
    return undefined;
  }
}
