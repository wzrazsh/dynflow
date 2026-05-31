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
  `);
}
