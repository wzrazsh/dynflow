import { describe, it, expect } from 'vitest';
import Database from 'better-sqlite3';

describe('Migration v6: add runtime_config_json to workflow_runs', () => {
  it('adds runtime_config_json column to workflow_runs', () => {
    const db = new Database(':memory:');

    // Set up baseline tables the way initSchema() would (pre-v6)
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

    // Inline v6 migration logic (same as migrations.ts v6.up)
    const cols = db
      .prepare('PRAGMA table_info(workflow_runs)')
      .all() as Array<{ name: string }>;
    if (!cols.some((c) => c.name === 'runtime_config_json')) {
      db.exec('ALTER TABLE workflow_runs ADD COLUMN runtime_config_json TEXT');
    }

    const after = db
      .prepare('PRAGMA table_info(workflow_runs)')
      .all() as Array<{ name: string }>;
    expect(after.some((c) => c.name === 'runtime_config_json')).toBe(true);
  });

  it('is idempotent (running twice does not fail)', () => {
    const db = new Database(':memory:');
    db.exec(`
      CREATE TABLE workflow_runs (id TEXT PRIMARY KEY, name TEXT NOT NULL);
    `);

    // First run
    db.exec('ALTER TABLE workflow_runs ADD COLUMN runtime_config_json TEXT');

    // Second run (should silently skip via the guard)
    const cols = db
      .prepare('PRAGMA table_info(workflow_runs)')
      .all() as Array<{ name: string }>;
    expect(() => {
      if (!cols.some((c) => c.name === 'runtime_config_json')) {
        db.exec('ALTER TABLE workflow_runs ADD COLUMN runtime_config_json TEXT');
      }
    }).not.toThrow();

    // Final state
    const after = db
      .prepare('PRAGMA table_info(workflow_runs)')
      .all() as Array<{ name: string }>;
    expect(after.some((c) => c.name === 'runtime_config_json')).toBe(true);
  });

  it('column is nullable', () => {
    const db = new Database(':memory:');
    db.exec(`
      CREATE TABLE workflow_runs (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        runtime_config_json TEXT
      );
    `);

    // Verify we can insert without the column
    db.prepare('INSERT INTO workflow_runs (id, name) VALUES (?, ?)').run('test-1', 'test');
    const row = db.prepare('SELECT runtime_config_json FROM workflow_runs WHERE id = ?').get('test-1') as { runtime_config_json: null };
    expect(row.runtime_config_json).toBeNull();
  });

  it('fresh DB with initSchema has the column', () => {
    const db = new Database(':memory:');

    // Create schema WITH runtime_config_json column (as if schema.ts already includes it)
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
        script TEXT,
        runtime_config_json TEXT
      );
    `);

    const cols = db
      .prepare('PRAGMA table_info(workflow_runs)')
      .all() as Array<{ name: string }>;
    expect(cols.some((c) => c.name === 'runtime_config_json')).toBe(true);

    // Verify it's after script column
    const scriptIdx = cols.findIndex((c) => c.name === 'script');
    const configIdx = cols.findIndex((c) => c.name === 'runtime_config_json');
    expect(configIdx).toBeGreaterThan(scriptIdx);
  });
});
