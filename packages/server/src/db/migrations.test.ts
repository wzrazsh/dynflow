import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import crypto from 'node:crypto';
import { getDb, closeDb } from './connection.js';
import { initSchema } from './schema.js';
import { runMigrations, getMigrationStatus } from './migrations.js';

// ---------------------------------------------------------------------------
// Setup — fresh in-memory DB before each test
// ---------------------------------------------------------------------------

beforeEach(() => {
  closeDb();
  process.env.DB_PATH = ':memory:';
});

afterAll(() => {
  closeDb();
  delete process.env.DB_PATH;
});

// ---------------------------------------------------------------------------
// Migration v5 tests
// ---------------------------------------------------------------------------

describe('Migration v5: add script column to workflow_runs', () => {
  it('1 — adds script column via full pipeline and records v5 as applied', () => {
    initSchema();
    runMigrations();
    const status = getMigrationStatus();

    // All 5 migrations recorded as applied
    expect(status).toHaveLength(5);
    for (const s of status) {
      expect(s.applied).toBe(true);
    }

    // script column exists with correct attributes
    const cols = getDb()
      .prepare('PRAGMA table_info(workflow_runs)')
      .all() as Array<{
      name: string;
      type: string;
      notnull: number;
      dflt_value: string | null;
    }>;
    const scriptCol = cols.find((c) => c.name === 'script');
    expect(scriptCol).toBeDefined();
    expect(scriptCol!.type).toBe('TEXT');
    expect(scriptCol!.notnull).toBe(0);
    expect(scriptCol!.dflt_value).toBeNull();

    // Insert row without script → succeeds (nullable)
    const id = crypto.randomUUID();
    getDb()
      .prepare(
        'INSERT INTO workflow_runs (id, name, status, definition_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)',
      )
      .run(id, 'test', 'pending', '{}', new Date().toISOString(), new Date().toISOString());
    const row = getDb()
      .prepare('SELECT id, script FROM workflow_runs WHERE id = ?')
      .get(id) as { id: string; script: string | null };
    expect(row).toBeDefined();
    expect(row.script).toBeNull();
  });

  it('2 — is idempotent when column already exists (defensive PRAGMA check)', () => {
    initSchema();
    runMigrations();

    // Column exists from initSchema
    const cols = getDb()
      .prepare('PRAGMA table_info(workflow_runs)')
      .all() as Array<{ name: string }>;
    expect(cols.some((c) => c.name === 'script')).toBe(true);

    // Running migrations again does not throw
    expect(() => runMigrations()).not.toThrow();

    // v5 still recorded as applied
    const status = getMigrationStatus();
    expect(status).toHaveLength(5);
    expect(status.find((s) => s.version === 5)?.applied).toBe(true);
  });
});
