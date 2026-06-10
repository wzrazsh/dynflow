import Database from 'better-sqlite3';
import { getDb, withRetry } from './connection.js';
import { logger } from '../logger.js';

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
  {
    version: 2,
    name: 'add-template-soft-delete',
    up: (db) => {
      // Defensive: skip if column already exists (e.g. dev environment reset).
      const cols = db
        .prepare('PRAGMA table_info(workflow_templates)')
        .all() as Array<{ name: string }>;
      if (!cols.some((c) => c.name === 'deleted_at')) {
        db.exec('ALTER TABLE workflow_templates ADD COLUMN deleted_at TEXT');
      }
      db.exec(
        'CREATE INDEX IF NOT EXISTS idx_workflow_templates_deleted_at ON workflow_templates(deleted_at)',
      );
    },
    down: (db) => {
      // SQLite < 3.35 has no DROP COLUMN — rebuild table to drop the column.
      db.exec(`
        CREATE TABLE workflow_templates_backup AS
          SELECT id, name, description, script, current_version, created_at, updated_at
          FROM workflow_templates;
        DROP TABLE workflow_templates;
        ALTER TABLE workflow_templates_backup RENAME TO workflow_templates;
      `);
    },
  },
  {
    version: 3,
    name: 'add-workflow-run-template-link',
    up: (db) => {
      // Add template_id + template_version to workflow_runs so we can trace
      // any run created from a template back to the exact template + version
      // that produced it. Both columns are nullable: runs created via the
      // inline-script endpoint (POST /api/workflows) keep NULL.
      const cols = db
        .prepare('PRAGMA table_info(workflow_runs)')
        .all() as Array<{ name: string }>;
      const names = new Set(cols.map((c) => c.name));
      if (!names.has('template_id')) {
        db.exec('ALTER TABLE workflow_runs ADD COLUMN template_id TEXT');
      }
      if (!names.has('template_version')) {
        db.exec('ALTER TABLE workflow_runs ADD COLUMN template_version INTEGER');
      }
      db.exec(
        'CREATE INDEX IF NOT EXISTS idx_workflow_runs_template_id ON workflow_runs(template_id)',
      );
    },
    down: (db) => {
      // SQLite < 3.35 has no DROP COLUMN — rebuild the table without the
      // two new columns. Any non-NULL data is lost on rollback.
      db.exec(`
        CREATE TABLE workflow_runs_backup AS
          SELECT id, name, status, definition_json, created_at, updated_at
          FROM workflow_runs;
        DROP TABLE workflow_runs;
        ALTER TABLE workflow_runs_backup RENAME TO workflow_runs;
      `);
    },
  },
  {
    version: 4,
    name: 'add-workspace-and-cua-fields',
    up: (db) => {
      // Per-workflow shared workspace: host path on disk + git metadata.
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

      // Cua + Pi container metadata per agent run.
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
    },
    down: (db) => {
      // SQLite < 3.35 has no DROP COLUMN — rebuild both tables without the
      // new columns. Any non-NULL data on those columns is lost on rollback.
      db.exec(`
        CREATE TABLE workflow_runs_backup AS
          SELECT id, name, status, definition_json, created_at, updated_at,
                 template_id, template_version
          FROM workflow_runs;
        DROP TABLE workflow_runs;
        ALTER TABLE workflow_runs_backup RENAME TO workflow_runs;
      `);
      db.exec(`
        CREATE TABLE agent_runs_backup AS
          SELECT id, phase_run_id, name, status, prompt, model, output, error,
                 started_at, completed_at, docker_container_id
          FROM agent_runs;
        DROP TABLE agent_runs;
        ALTER TABLE agent_runs_backup RENAME TO agent_runs;
      `);
    },
  },
  {
    version: 5,
    name: 'add-script-to-workflow-runs',
    up: (db) => {
      // Store the original workflow script on each run so the UI can display
      // it without re-reading the user's filesystem.
      const cols = db
        .prepare('PRAGMA table_info(workflow_runs)')
        .all() as Array<{ name: string }>;
      if (!cols.some((c) => c.name === 'script')) {
        db.exec('ALTER TABLE workflow_runs ADD COLUMN script TEXT');
      }
    },
    down: (db) => {
      // SQLite < 3.35 has no DROP COLUMN — rebuild the table without the
      // script column. Any non-NULL data on that column is lost.
      db.exec(`
        CREATE TABLE workflow_runs_backup AS
          SELECT id, name, status, definition_json, created_at, updated_at,
                 template_id, template_version, workspace_path,
                 workspace_git_url, workspace_branch
          FROM workflow_runs;
        DROP TABLE workflow_runs;
        ALTER TABLE workflow_runs_backup RENAME TO workflow_runs;
      `);
    },
  },
  {
    version: 6,
    name: 'add-runtime-config-to-workflow-runs',
    up: (db) => {
      // Store runtime environment configuration (runner, provider, model) per run.
      const cols = db
        .prepare('PRAGMA table_info(workflow_runs)')
        .all() as Array<{ name: string }>;
      if (!cols.some((c) => c.name === 'runtime_config_json')) {
        db.exec('ALTER TABLE workflow_runs ADD COLUMN runtime_config_json TEXT');
      }
    },
    down: (db) => {
      // SQLite < 3.35 has no DROP COLUMN — rebuild the table without the
      // runtime_config_json column. Any non-NULL data on that column is lost.
      db.exec(`
        CREATE TABLE workflow_runs_backup AS
          SELECT id, name, status, definition_json, created_at, updated_at,
                 template_id, template_version, workspace_path,
                 workspace_git_url, workspace_branch, script
          FROM workflow_runs;
        DROP TABLE workflow_runs;
        ALTER TABLE workflow_runs_backup RENAME TO workflow_runs;
      `);
    },
  },
  {
    version: 7,
    name: 'add-dynamic-workflow-persistence',
    up: (db) => {
      const columns = db
        .prepare('PRAGMA table_info(workflow_runs)')
        .all() as Array<{ name: string }>;
      const names = new Set(columns.map((column) => column.name));
      if (!names.has('execution_model')) {
        db.exec(
          "ALTER TABLE workflow_runs ADD COLUMN execution_model TEXT NOT NULL DEFAULT 'static'",
        );
      }
      if (!names.has('recovery_count')) {
        db.exec(
          'ALTER TABLE workflow_runs ADD COLUMN recovery_count INTEGER NOT NULL DEFAULT 0',
        );
      }
      if (!names.has('script_hash')) {
        db.exec('ALTER TABLE workflow_runs ADD COLUMN script_hash TEXT');
      }

      db.exec(`
        CREATE TABLE IF NOT EXISTS workflow_steps (
          id TEXT PRIMARY KEY,
          workflow_run_id TEXT NOT NULL REFERENCES workflow_runs(id) ON DELETE CASCADE,
          step_key TEXT NOT NULL,
          parent_step_key TEXT,
          type TEXT NOT NULL,
          sequence INTEGER NOT NULL DEFAULT 0,
          status TEXT NOT NULL DEFAULT 'pending',
          input_hash TEXT,
          input_json TEXT,
          output_json TEXT,
          metadata_json TEXT,
          error TEXT,
          attempt INTEGER NOT NULL DEFAULT 0,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          started_at TEXT,
          completed_at TEXT,
          UNIQUE(workflow_run_id, step_key)
        );
        CREATE INDEX IF NOT EXISTS idx_workflow_steps_run_status
          ON workflow_steps(workflow_run_id, status);
        CREATE INDEX IF NOT EXISTS idx_workflow_steps_run_parent
          ON workflow_steps(workflow_run_id, parent_step_key);
        CREATE INDEX IF NOT EXISTS idx_workflow_steps_run_sequence
          ON workflow_steps(workflow_run_id, sequence);
      `);
    },
    down: (db) => {
      db.exec(`
        DROP TABLE IF EXISTS workflow_steps;
        ALTER TABLE workflow_runs DROP COLUMN script_hash;
        ALTER TABLE workflow_runs DROP COLUMN recovery_count;
        ALTER TABLE workflow_runs DROP COLUMN execution_model;
      `);
    },
  },
  {
    version: 8,
    name: 'add-project-name-to-workflow-runs',
    up(db: Database) {
      const cols = db
        .prepare('PRAGMA table_info(workflow_runs)')
        .all() as Array<{ name: string }>;
      if (!cols.some((c) => c.name === 'project_name')) {
        db.exec(`ALTER TABLE workflow_runs ADD COLUMN project_name TEXT`);
      }
    },
    down(db: Database) {
      db.exec(`
        CREATE TABLE workflow_runs_v8_backup (
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
          runtime_config_json TEXT,
          execution_model TEXT NOT NULL DEFAULT 'static',
          recovery_count INTEGER NOT NULL DEFAULT 0,
          script_hash TEXT
        );
        INSERT INTO workflow_runs_v8_backup SELECT
          id, name, status, definition_json, created_at, updated_at,
          template_id, template_version,
          workspace_path, workspace_git_url, workspace_branch,
          script, runtime_config_json,
          execution_model, recovery_count, script_hash
        FROM workflow_runs;
        DROP TABLE workflow_runs;
        ALTER TABLE workflow_runs_v8_backup RENAME TO workflow_runs;
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

      logger.info(`[migrations] Applying v${migration.version}: ${migration.name}`);
      migration.up(db);
      db.prepare(
        'INSERT INTO _migrations (version, name, applied_at) VALUES (?, ?, ?)',
      ).run(migration.version, migration.name, new Date().toISOString());
      logger.info(`[migrations] Applied v${migration.version}: ${migration.name}`);
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
      logger.info('[migrations] No migrations to roll back');
      return null;
    }

    const last = applied[applied.length - 1];
    const migration = migrations.find((m) => m.version === last.version);

    if (!migration) {
      logger.warn(
        `[migrations] No definition found for v${last.version} — cannot roll back`,
      );
      return null;
    }

    logger.info(`[migrations] Rolling back v${migration.version}: ${migration.name}`);
    migration.down(db);
    db.prepare('DELETE FROM _migrations WHERE version = ?').run(migration.version);
    logger.info(`[migrations] Rolled back v${migration.version}: ${migration.name}`);

    return last;
  });
}

/**
 * Return the raw list of migration definitions (for introspection).
 */
export function getMigrations(): readonly Migration[] {
  return migrations;
}
