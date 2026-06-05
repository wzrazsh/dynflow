import { describe, it, expect } from 'vitest';
import Database from 'better-sqlite3';
import { getMigrations } from './migrations.js';

describe('Migration v6: add runtime_config_json to workflow_runs', () => {
  const v6 = getMigrations().find((m) => m.version === 6);

  // -------------------------------------------------------------------------
  // Sanity check
  // -------------------------------------------------------------------------

  it('v6 migration is defined in migrations.ts', () => {
    expect(v6).toBeDefined();
    expect(v6!.name).toBe('add-runtime-config-to-workflow-runs');
  });

  // -------------------------------------------------------------------------
  // Contract test: DB at v5 state → apply v6.up → verify column
  // -------------------------------------------------------------------------

  it('contract: DB at v5 state — v6.up adds runtime_config_json as nullable TEXT', () => {
    const db = new Database(':memory:');

    // Simulate workflow_runs at v5 state (all pre-v6 columns, no runtime_config_json)
    db.exec(`
      CREATE TABLE workflow_runs (
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
    `);

    // Apply the real v6 migration
    v6!.up(db);

    // Column exists with correct attributes
    const cols = db
      .prepare('PRAGMA table_info(workflow_runs)')
      .all() as Array<{
      name: string;
      type: string;
      notnull: number;
      dflt_value: string | null;
    }>;
    const col = cols.find((c) => c.name === 'runtime_config_json');
    expect(col).toBeDefined();
    expect(col!.type).toBe('TEXT');
    expect(col!.notnull).toBe(0); // nullable
    expect(col!.dflt_value).toBeNull();
  });

  // -------------------------------------------------------------------------
  // Value persistence: nullable by default, stores JSON values
  // -------------------------------------------------------------------------

  it('column is nullable — NULL by default, JSON values round-trip', () => {
    const db = new Database(':memory:');

    db.exec(`
      CREATE TABLE workflow_runs (
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
    `);

    v6!.up(db);

    // NULL by default (omitting runtime_config_json)
    db.prepare(
      'INSERT INTO workflow_runs (id, name, status, definition_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)',
    ).run('null-id', 'test', 'pending', '{}', '2024-06-01', '2024-06-01');
    const nullRow = db
      .prepare('SELECT runtime_config_json FROM workflow_runs WHERE id = ?')
      .get('null-id') as { runtime_config_json: string | null };
    expect(nullRow.runtime_config_json).toBeNull();

    // Non-null JSON value persists
    const config = { runner: 'cua', provider: 'opencode', model: 'gpt-4o' };
    db.prepare(
      'INSERT INTO workflow_runs (id, name, status, definition_json, created_at, updated_at, runtime_config_json) VALUES (?, ?, ?, ?, ?, ?, ?)',
    ).run(
      'json-id',
      'test',
      'pending',
      '{}',
      '2024-06-01',
      '2024-06-01',
      JSON.stringify(config),
    );
    const jsonRow = db
      .prepare('SELECT runtime_config_json FROM workflow_runs WHERE id = ?')
      .get('json-id') as { runtime_config_json: string };
    expect(JSON.parse(jsonRow.runtime_config_json)).toEqual(config);
  });

  // -------------------------------------------------------------------------
  // Idempotency: calling v6.up twice does not error
  // -------------------------------------------------------------------------

  it('is idempotent — calling v6.up twice does not throw', () => {
    const db = new Database(':memory:');

    db.exec(`
      CREATE TABLE workflow_runs (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL
      );
    `);

    // First call
    v6!.up(db);

    // Second call — guarded by PRAGMA table_info check, should not throw
    expect(() => v6!.up(db)).not.toThrow();

    // Column still exists
    const cols = db
      .prepare('PRAGMA table_info(workflow_runs)')
      .all() as Array<{ name: string }>;
    expect(cols.some((c) => c.name === 'runtime_config_json')).toBe(true);
  });

  // -------------------------------------------------------------------------
  // Full pipeline idempotency: all v1-v6 migrations run twice
  // -------------------------------------------------------------------------

  it('full pipeline — running all v1-v6 migrations twice is a no-op', () => {
    const db = new Database(':memory:');

    // Create baseline tables (pre-migration state, runtime_config_json absent)
    db.exec(`
      CREATE TABLE workflow_runs (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending',
        definition_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE workflow_templates (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        description TEXT,
        script TEXT NOT NULL,
        current_version INTEGER NOT NULL DEFAULT 1,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
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

    const allMigrations = getMigrations();

    // First pass: run all v1-v6
    for (const m of allMigrations) {
      m.up(db);
    }

    // Second pass: run all again — should not throw
    expect(() => {
      for (const m of allMigrations) {
        m.up(db);
      }
    }).not.toThrow();

    // Verify runtime_config_json column exists after both passes
    const cols = db
      .prepare('PRAGMA table_info(workflow_runs)')
      .all() as Array<{ name: string }>;
    expect(cols.some((c) => c.name === 'runtime_config_json')).toBe(true);
  });
});
