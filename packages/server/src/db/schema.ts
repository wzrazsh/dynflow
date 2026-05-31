import { getDb } from './connection.js';

/**
 * Create all tables if they don't exist.
 * Safe to call multiple times — uses IF NOT EXISTS.
 *
 * Tables:
 * - workflow_runs: top-level workflow execution record
 * - phase_runs: sequential phases within a workflow run
 * - agent_runs: parallel agents within a phase
 */
export function initSchema(): void {
  const db = getDb();

  db.exec(`
    CREATE TABLE IF NOT EXISTS workflow_runs (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      definition_json TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS phase_runs (
      id TEXT PRIMARY KEY,
      workflow_run_id TEXT NOT NULL REFERENCES workflow_runs(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      order_num INTEGER NOT NULL,
      started_at TEXT,
      completed_at TEXT
    );

    CREATE TABLE IF NOT EXISTS agent_runs (
      id TEXT PRIMARY KEY,
      phase_run_id TEXT NOT NULL REFERENCES phase_runs(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      prompt TEXT NOT NULL,
      model TEXT NOT NULL DEFAULT 'gpt-4o',
      output TEXT,
      error TEXT,
      started_at TEXT,
      completed_at TEXT,
      docker_container_id TEXT
    );

    -- Registry tables for multi-agent orchestration
    CREATE TABLE IF NOT EXISTS domains (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      description TEXT NOT NULL,
      icon TEXT
    );

    CREATE TABLE IF NOT EXISTS agent_sources (
      id TEXT PRIMARY KEY,
      domain_id TEXT NOT NULL REFERENCES domains(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      url TEXT NOT NULL,
      description TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS agent_roles (
      id TEXT PRIMARY KEY,
      source_id TEXT NOT NULL REFERENCES agent_sources(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      description TEXT NOT NULL,
      tier INTEGER NOT NULL DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS predefined_agents (
      id TEXT PRIMARY KEY,
      role_id TEXT NOT NULL REFERENCES agent_roles(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      description TEXT NOT NULL,
      system_prompt TEXT NOT NULL,
      available_skills TEXT NOT NULL DEFAULT '[]'
    );

    CREATE TABLE IF NOT EXISTS skills (
      id TEXT PRIMARY KEY,
      source_id TEXT NOT NULL REFERENCES agent_sources(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      description TEXT NOT NULL,
      category TEXT NOT NULL,
      parameters TEXT NOT NULL DEFAULT '[]',
      input_schema TEXT,
      output_schema TEXT
    );

    CREATE TABLE IF NOT EXISTS agent_skills (
      agent_id TEXT NOT NULL REFERENCES predefined_agents(id) ON DELETE CASCADE,
      skill_id TEXT NOT NULL REFERENCES skills(id) ON DELETE CASCADE,
      PRIMARY KEY (agent_id, skill_id)
    );
  `);
}
