import { describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { getMigrations } from './migrations.js';

describe('Migration v7: dynamic workflow persistence', () => {
  const v7 = getMigrations().find((migration) => migration.version === 7);

  it('defines migration v7', () => {
    expect(v7).toBeDefined();
    expect(v7!.name).toBe('add-dynamic-workflow-persistence');
  });

  it('adds run metadata and creates the workflow_steps table', () => {
    const db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    db.exec(`
      CREATE TABLE workflow_runs (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending',
        definition_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
    `);

    v7!.up(db);

    const runColumns = db
      .prepare('PRAGMA table_info(workflow_runs)')
      .all() as Array<{ name: string; dflt_value: string | null }>;
    expect(runColumns.find((column) => column.name === 'execution_model')?.dflt_value)
      .toBe("'static'");
    expect(runColumns.find((column) => column.name === 'recovery_count')?.dflt_value)
      .toBe('0');
    expect(runColumns.some((column) => column.name === 'script_hash')).toBe(true);

    const stepColumns = db
      .prepare('PRAGMA table_info(workflow_steps)')
      .all() as Array<{ name: string }>;
    expect(stepColumns.map((column) => column.name)).toEqual([
      'id',
      'workflow_run_id',
      'step_key',
      'parent_step_key',
      'type',
      'sequence',
      'status',
      'input_hash',
      'input_json',
      'output_json',
      'metadata_json',
      'error',
      'attempt',
      'created_at',
      'updated_at',
      'started_at',
      'completed_at',
    ]);

    const indexes = db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'workflow_steps'",
      )
      .all() as Array<{ name: string }>;
    expect(indexes.map((index) => index.name)).toEqual(
      expect.arrayContaining([
        'idx_workflow_steps_run_status',
        'idx_workflow_steps_run_parent',
        'idx_workflow_steps_run_sequence',
      ]),
    );
  });

  it('is idempotent and preserves existing workflow rows', () => {
    const db = new Database(':memory:');
    db.exec(`
      CREATE TABLE workflow_runs (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending',
        definition_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      INSERT INTO workflow_runs
        (id, name, status, definition_json, created_at, updated_at)
      VALUES ('run-1', 'legacy', 'completed', '{"phases":[]}', 'now', 'now');
    `);

    v7!.up(db);
    expect(() => v7!.up(db)).not.toThrow();

    const row = db
      .prepare(
        'SELECT execution_model, recovery_count, script_hash FROM workflow_runs WHERE id = ?',
      )
      .get('run-1') as {
      execution_model: string;
      recovery_count: number;
      script_hash: string | null;
    };
    expect(row).toEqual({
      execution_model: 'static',
      recovery_count: 0,
      script_hash: null,
    });
  });

  it('rolls back the step table', () => {
    const db = new Database(':memory:');
    db.exec(`
      CREATE TABLE workflow_runs (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending',
        definition_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
    `);
    v7!.up(db);
    v7!.down(db);

    const table = db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'workflow_steps'",
      )
      .get();
    expect(table).toBeUndefined();
  });
});
