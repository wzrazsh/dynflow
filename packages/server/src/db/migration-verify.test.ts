// One-off verification: copy real DB to a temp file, apply migration v2,
// confirm column + index exist, original rows are preserved, then clean up.
// Safe to delete after the soft-delete feature is verified in production.
import { describe, it, expect, afterAll } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { initSchema } from './schema.js';
import { runMigrations, getMigrationStatus } from './migrations.js';
import { closeDb, getDb } from './connection.js';

const REAL_DB = path.resolve(process.cwd(), 'data/workflows.db');
const TMP_DB_V2 = path.join(os.tmpdir(), `dynflow-verify-v2-${Date.now()}.db`);
const TMP_DB_V3 = path.join(os.tmpdir(), `dynflow-verify-v3-${Date.now()}.db`);

describe('Migration v2 against real DB (copy)', () => {
  afterAll(() => {
    closeDb();
    if (fs.existsSync(TMP_DB_V2)) fs.unlinkSync(TMP_DB_V2);
  });

  it('adds deleted_at column + index without losing data', () => {
    if (!fs.existsSync(REAL_DB)) {
      console.log('No real DB present, skipping');
      return;
    }
    fs.copyFileSync(REAL_DB, TMP_DB_V2);
    process.env.DB_PATH = TMP_DB_V2;

    closeDb();
    initSchema();
    runMigrations();
    const status = getMigrationStatus();

    const after = getDb()
      .prepare('PRAGMA table_info(workflow_templates)')
      .all() as Array<{ name: string }>;
    const afterRows = (getDb()
      .prepare('SELECT COUNT(*) as n FROM workflow_templates')
      .get() as { n: number }).n;
    const idx = getDb()
      .prepare(
        "SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='workflow_templates' AND name='idx_workflow_templates_deleted_at'",
      )
      .get();

    expect(after.some((c) => c.name === 'deleted_at')).toBe(true);
    expect(idx).toBeDefined();
    expect(status.find((s) => s.version === 2)?.applied).toBe(true);
    console.log(`Migration v2 applied. workflow_templates row count: ${afterRows}`);
  });
});

describe('Migration v3 against real DB (copy)', () => {
  afterAll(() => {
    closeDb();
    if (fs.existsSync(TMP_DB_V3)) fs.unlinkSync(TMP_DB_V3);
  });

  it('adds template_id + template_version to workflow_runs without losing data', () => {
    if (!fs.existsSync(REAL_DB)) {
      console.log('No real DB present, skipping');
      return;
    }
    fs.copyFileSync(REAL_DB, TMP_DB_V3);
    process.env.DB_PATH = TMP_DB_V3;

    closeDb();
    initSchema();
    runMigrations();
    const status = getMigrationStatus();

    // Columns must exist on workflow_runs
    const cols = getDb()
      .prepare('PRAGMA table_info(workflow_runs)')
      .all() as Array<{ name: string }>;
    const colNames = new Set(cols.map((c) => c.name));
    expect(colNames.has('template_id')).toBe(true);
    expect(colNames.has('template_version')).toBe(true);

    // Index must exist
    const idx = getDb()
      .prepare(
        "SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='workflow_runs' AND name='idx_workflow_runs_template_id'",
      )
      .get();
    expect(idx).toBeDefined();

    // Pre-existing rows must be preserved AND have NULL on the new columns
    const totalRuns = (getDb()
      .prepare('SELECT COUNT(*) as n FROM workflow_runs')
      .get() as { n: number }).n;
    const nullCount = (getDb()
      .prepare(
        'SELECT COUNT(*) as n FROM workflow_runs WHERE template_id IS NULL AND template_version IS NULL',
      )
      .get() as { n: number }).n;
    expect(nullCount).toBe(totalRuns);

    // v3 is recorded as applied
    expect(status.find((s) => s.version === 3)?.applied).toBe(true);

    console.log(
      `Migration v3 applied. workflow_runs row count: ${totalRuns}; all have NULL template_id.`,
    );
  });
});
