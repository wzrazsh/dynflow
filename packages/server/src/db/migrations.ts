import Database from 'better-sqlite3';
import { getDb, withRetry } from './connection.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface Migration {
  version: number;
  name: string;
  up: (db: Database.Database) => void;
  down: (db: Database.Database) => void;
}

export interface MigrationRecord {
  version: number;
  name: string;
  applied_at: string;
}

export interface MigrationStatus {
  version: number;
  name: string;
  applied: boolean;
  applied_at: string | null;
}

// ---------------------------------------------------------------------------
// Migration definitions
// ---------------------------------------------------------------------------

const migrations: Migration[] = [
  {
    version: 1,
    name: 'create-workflow-templates',
    up: () => {
      // Tables already created by initSchema() (schema.ts).
      // This migration records the baseline state for future schema changes.
    },
    down: (db) => {
      db.exec(`
        DROP TABLE IF EXISTS workflow_template_tags;
        DROP TABLE IF EXISTS workflow_template_versions;
        DROP TABLE IF EXISTS workflow_templates;
      `);
    },
  },
];

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Ensure the _migrations meta table exists.
 */
function ensureMetaTable(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS _migrations (
      version INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      applied_at TEXT NOT NULL
    );
  `);
}

/**
 * Get the list of already-applied migrations from the meta table.
 */
function getAppliedMigrations(db: Database.Database): MigrationRecord[] {
  return db
    .prepare('SELECT version, name, applied_at FROM _migrations ORDER BY version ASC')
    .all() as MigrationRecord[];
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Run all pending migrations in order.
 * Safe to call multiple times — only unapplied migrations will execute.
 *
 * Must be called AFTER initSchema() so the _migrations meta table
 * and any baseline tables already exist.
 */
export function runMigrations(): void {
  withRetry(() => {
    const db = getDb();
    ensureMetaTable(db);
    const applied = getAppliedMigrations(db);
    const appliedVersions = new Set(applied.map((r) => r.version));

    for (const migration of migrations) {
      if (appliedVersions.has(migration.version)) continue;

      console.log(`[migrations] Applying v${migration.version}: ${migration.name}`);
      migration.up(db);
      db.prepare(
        'INSERT INTO _migrations (version, name, applied_at) VALUES (?, ?, ?)',
      ).run(migration.version, migration.name, new Date().toISOString());
      console.log(`[migrations] Applied v${migration.version}: ${migration.name}`);
    }
  });
}

/**
 * Get the status of all defined migrations.
 * Returns an array indicating which migrations have been applied.
 */
export function getMigrationStatus(): MigrationStatus[] {
  return withRetry(() => {
    const db = getDb();
    ensureMetaTable(db);
    const applied = getAppliedMigrations(db);
    const appliedMap = new Map(applied.map((r) => [r.version, r]));

    return migrations.map((m) => {
      const record = appliedMap.get(m.version);
      return {
        version: m.version,
        name: m.name,
        applied: !!record,
        applied_at: record?.applied_at ?? null,
      };
    });
  });
}

/**
 * Roll back the most recently applied migration.
 * Returns the rolled-back migration, or null if no migrations have been applied.
 */
export function rollbackLastMigration(): MigrationRecord | null {
  return withRetry(() => {
    const db = getDb();
    ensureMetaTable(db);
    const applied = getAppliedMigrations(db);

    if (applied.length === 0) {
      console.log('[migrations] No migrations to roll back');
      return null;
    }

    const last = applied[applied.length - 1];
    const migration = migrations.find((m) => m.version === last.version);

    if (!migration) {
      console.warn(
        `[migrations] No definition found for v${last.version} — cannot roll back`,
      );
      return null;
    }

    console.log(`[migrations] Rolling back v${migration.version}: ${migration.name}`);
    migration.down(db);
    db.prepare('DELETE FROM _migrations WHERE version = ?').run(migration.version);
    console.log(`[migrations] Rolled back v${migration.version}: ${migration.name}`);

    return last;
  });
}

/**
 * Return the raw list of migration definitions (for introspection).
 */
export function getMigrations(): readonly Migration[] {
  return migrations;
}
