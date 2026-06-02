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
      updated_at TEXT NOT NULL,
      template_id TEXT,
      template_version INTEGER,
      workspace_path TEXT,
      workspace_git_url TEXT,
      workspace_branch TEXT,
      script TEXT
    );
    -- Note: the idx_workflow_runs_template_id index is created in
    -- migration v3 so that older databases (where the template_id column
    -- doesn't exist yet) don't hit "no such column" on a CREATE INDEX.
    -- For fresh installs the migration still runs and creates the index.

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
      docker_container_id TEXT,
      no_vnc_url TEXT,
      cua_api_url TEXT
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

    -- Workflow Template tables
    CREATE TABLE IF NOT EXISTS workflow_templates (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      description TEXT,
      script TEXT NOT NULL,
      current_version INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      deleted_at TEXT
    );
    -- Note: the idx_workflow_templates_deleted_at index is created in
    -- migration v2 so that older databases (where the deleted_at column
    -- doesn't exist yet) don't hit "no such column" on a CREATE INDEX.
    -- For fresh installs the migration still runs and creates the index.

    CREATE TABLE IF NOT EXISTS workflow_template_versions (
      id TEXT PRIMARY KEY,
      template_id TEXT NOT NULL REFERENCES workflow_templates(id) ON DELETE CASCADE,
      version INTEGER NOT NULL,
      script TEXT NOT NULL,
      name TEXT NOT NULL,
      description TEXT,
      created_at TEXT NOT NULL,
      UNIQUE(template_id, version)
    );

    CREATE TABLE IF NOT EXISTS workflow_template_tags (
      id TEXT PRIMARY KEY,
      template_id TEXT NOT NULL REFERENCES workflow_templates(id) ON DELETE CASCADE,
      tag TEXT NOT NULL,
      UNIQUE(template_id, tag)
    );
  `);
}
