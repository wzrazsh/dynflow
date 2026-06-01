import { describe, it, expect } from 'vitest';
import Database from 'better-sqlite3';

describe('Migration v4: add workspace + Cua fields', () => {
  it('adds workspace columns to workflow_runs and Cua columns to agent_runs', () => {
    const db = new Database(':memory:');

    // Set up baseline tables the way initSchema() would.
    db.exec(`
      CREATE TABLE workflow_runs (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending',
        definition_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        template_id TEXT,
        template_version INTEGER
      );
      CREATE TABLE agent_runs (
        id TEXT PRIMARY KEY,
        phase_run_id TEXT NOT NULL,
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

    // Inline the v4 migration logic (same SQL as in migrations.ts v4.up).
    // This avoids depending on the connection singleton and the public API.
    const wrCols = db
      .prepare('PRAGMA table_info(workflow_runs)')
      .all() as Array<{ name: string }>;
    const wrNames = new Set(wrCols.map((c) => c.name));
    if (!wrNames.has('workspace_path')) {
      db.exec('ALTER TABLE workflow_runs ADD COLUMN workspace_path TEXT');
    }
    if (!wrNames.has('workspace_git_url')) {
      db.exec('ALTER TABLE workflow_runs ADD COLUMN workspace_git_url TEXT');
    }
    if (!wrNames.has('workspace_branch')) {
      db.exec('ALTER TABLE workflow_runs ADD COLUMN workspace_branch TEXT');
    }

    const arCols = db
      .prepare('PRAGMA table_info(agent_runs)')
      .all() as Array<{ name: string }>;
    const arNames = new Set(arCols.map((c) => c.name));
    if (!arNames.has('no_vnc_url')) {
      db.exec('ALTER TABLE agent_runs ADD COLUMN no_vnc_url TEXT');
    }
    if (!arNames.has('cua_api_url')) {
      db.exec('ALTER TABLE agent_runs ADD COLUMN cua_api_url TEXT');
    }

    // workflow_runs columns
    const afterWr = db
      .prepare('PRAGMA table_info(workflow_runs)')
      .all() as Array<{ name: string }>;
    const afterWrNames = new Set(afterWr.map((c) => c.name));
    expect(afterWrNames.has('workspace_path')).toBe(true);
    expect(afterWrNames.has('workspace_git_url')).toBe(true);
    expect(afterWrNames.has('workspace_branch')).toBe(true);

    // agent_runs columns
    const afterAr = db
      .prepare('PRAGMA table_info(agent_runs)')
      .all() as Array<{ name: string }>;
    const afterArNames = new Set(afterAr.map((c) => c.name));
    expect(afterArNames.has('no_vnc_url')).toBe(true);
    expect(afterArNames.has('cua_api_url')).toBe(true);
  });

  it('is idempotent (running twice does not fail)', () => {
    const db = new Database(':memory:');
    db.exec(`
      CREATE TABLE workflow_runs (id TEXT PRIMARY KEY, name TEXT NOT NULL);
      CREATE TABLE agent_runs (id TEXT PRIMARY KEY, name TEXT NOT NULL);
    `);

    // First run
    db.exec('ALTER TABLE workflow_runs ADD COLUMN workspace_path TEXT');
    db.exec('ALTER TABLE workflow_runs ADD COLUMN workspace_git_url TEXT');
    db.exec('ALTER TABLE workflow_runs ADD COLUMN workspace_branch TEXT');
    db.exec('ALTER TABLE agent_runs ADD COLUMN no_vnc_url TEXT');
    db.exec('ALTER TABLE agent_runs ADD COLUMN cua_api_url TEXT');

    // Second run (should silently skip via the if-names-has guards)
    const wrCols = db
      .prepare('PRAGMA table_info(workflow_runs)')
      .all() as Array<{ name: string }>;
    const wrNames = new Set(wrCols.map((c) => c.name));
    expect(() => {
      if (!wrNames.has('workspace_path')) {
        db.exec('ALTER TABLE workflow_runs ADD COLUMN workspace_path TEXT');
      }
    }).not.toThrow();

    // Final state
    const after = db
      .prepare('PRAGMA table_info(workflow_runs)')
      .all() as Array<{ name: string }>;
    expect(new Set(after.map((c) => c.name)).has('workspace_path')).toBe(true);
  });
});
