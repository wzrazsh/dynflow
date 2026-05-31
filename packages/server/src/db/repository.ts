import { v4 as uuidv4 } from 'uuid';
import { getDb, withRetry } from './connection.js';
import type {
  WorkflowDefinition,
  WorkflowRun,
  PhaseRun,
  AgentRun,
  WorkflowStatus,
  PhaseStatus,
  AgentStatus,
  PhaseDefinition,
  AgentDefinition,
} from '@dynflow/shared';

// ---------------------------------------------------------------------------
// Workflow-level operations
// ---------------------------------------------------------------------------

/**
 * Create a new workflow run from a definition.
 * Inserts the workflow row, creates phases and agent runs,
 * then returns the fully assembled tree.
 */
export function createWorkflowRun(
  definition: WorkflowDefinition,
  name: string,
): WorkflowRun {
  const db = getDb();
  const id = uuidv4();
  const now = new Date().toISOString();

  withRetry(() =>
    db.prepare(
      `INSERT INTO workflow_runs (id, name, status, definition_json, created_at, updated_at)
       VALUES (?, ?, 'pending', ?, ?, ?)`,
    ).run(id, name, JSON.stringify(definition), now, now),
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
  };
}

/**
 * List workflow runs with cursor-based pagination.
 * Results are ordered by creation date, newest first.
 */
export function listWorkflowRuns(
  page: number,
  pageSize: number,
): { runs: WorkflowRun[]; total: number } {
  const db = getDb();

  const countRow = withRetry(() =>
    db
      .prepare('SELECT COUNT(*) as count FROM workflow_runs')
      .get(),
  ) as { count: number };
  const total = countRow.count;

  const offset = (page - 1) * pageSize;
  const rows = withRetry(() =>
    db
      .prepare(
        'SELECT id FROM workflow_runs ORDER BY created_at DESC LIMIT ? OFFSET ?',
      )
      .all(pageSize, offset),
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
    `INSERT INTO agent_runs (id, phase_run_id, name, status, prompt, model, output, error, started_at, completed_at, docker_container_id)
     VALUES (?, ?, ?, 'pending', ?, 'gpt-4o', NULL, NULL, NULL, NULL, NULL)`,
  );

  return phases.map((phaseDef, index) => {
    const phaseId = uuidv4();
    withRetry(() => insertPhase.run(phaseId, workflowRunId, phaseDef.name, index));

    const agentRuns: AgentRun[] = phaseDef.agents.map((agentDef) => {
      const agentId = uuidv4();
      withRetry(() => insertAgent.run(agentId, phaseId, agentDef.name, agentDef.prompt));
      return {
        id: agentId,
        name: agentDef.name,
        status: 'pending' as AgentStatus,
        prompt: agentDef.prompt,
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
    withRetry(() => insert.run(uuidv4(), phaseRunId, agent.name, agent.prompt));
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
  opts?: { output?: string; error?: string; containerId?: string },
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

  if (opts?.output !== undefined) {
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
  };
}
