/**
 * Integration test: startup-boundary orphan recovery.
 *
 * Verifies that workflow runs stuck in 'running' status are converted to
 * 'interrupted' when the database initializes, simulating a server crash
 * or restart scenario.
 *
 * Tests three scenarios:
 *   1. One running + one pending + one completed → only running is interrupted
 *   2. Second call → returns 0, already-interrupted rows unchanged
 *   3. No orphan runs → returns 0
 */

import { describe, it, expect, afterEach } from 'vitest';
import { closeDb, getDb } from '../db/connection.js';
import { initializeDatabase } from '../bootstrap/initialize.js';

describe('startup-boundary orphan recovery', () => {
  afterEach(() => {
    closeDb();
  });

  it('converts running workflows to interrupted but leaves pending/completed alone', () => {
    process.env.DB_PATH = ':memory:';
    closeDb();

    // Bootstrap schema + migrations on the fresh in-memory database
    initializeDatabase();

    // Seed workflow runs directly (not via repository) to avoid creating
    // phase/agent rows that are irrelevant to this test
    const db = getDb();
    const now = new Date().toISOString();

    db.prepare(
      "INSERT INTO workflow_runs (id, name, status, definition_json, created_at, updated_at) VALUES (?, ?, ?, '{}', ?, ?)",
    ).run('run-running', 'Orphan Running', 'running', now, now);

    db.prepare(
      "INSERT INTO workflow_runs (id, name, status, definition_json, created_at, updated_at) VALUES (?, ?, ?, '{}', ?, ?)",
    ).run('run-pending', 'Pending Workflow', 'pending', now, now);

    db.prepare(
      "INSERT INTO workflow_runs (id, name, status, definition_json, created_at, updated_at) VALUES (?, ?, ?, '{}', ?, ?)",
    ).run('run-completed', 'Completed Workflow', 'completed', now, now);

    // Act — call initializeDatabase again; this runs markOrphanRunsAsInterrupted
    const orphanCount = initializeDatabase();

    // Assert — only the 'running' row was touched
    expect(orphanCount).toBe(1);

    const rows = db
      .prepare('SELECT id, status FROM workflow_runs ORDER BY id')
      .all() as Array<{ id: string; status: string }>;

    expect(rows).toEqual([
      { id: 'run-completed', status: 'completed' },
      { id: 'run-pending', status: 'pending' },
      { id: 'run-running', status: 'interrupted' },
    ]);
  });

  it('returns 0 on subsequent calls and does not change already-interrupted rows', () => {
    process.env.DB_PATH = ':memory:';
    closeDb();

    initializeDatabase();

    const db = getDb();
    const now = new Date().toISOString();

    db.prepare(
      "INSERT INTO workflow_runs (id, name, status, definition_json, created_at, updated_at) VALUES (?, ?, ?, '{}', ?, ?)",
    ).run('run-1', 'Orphan Running', 'running', now, now);

    // First call — marks the orphan
    expect(initializeDatabase()).toBe(1);

    // Second call — no running rows remain
    expect(initializeDatabase()).toBe(0);

    // Verify the row is still 'interrupted' (not modified again)
    const row = db
      .prepare('SELECT status FROM workflow_runs WHERE id = ?')
      .get('run-1') as { status: string };
    expect(row.status).toBe('interrupted');
  });

  it('returns 0 when no orphan running workflows exist', () => {
    process.env.DB_PATH = ':memory:';
    closeDb();

    initializeDatabase();

    const db = getDb();
    const now = new Date().toISOString();

    // Seed only terminal-status rows
    db.prepare(
      "INSERT INTO workflow_runs (id, name, status, definition_json, created_at, updated_at) VALUES (?, ?, ?, '{}', ?, ?)",
    ).run('run-completed', 'Completed', 'completed', now, now);

    db.prepare(
      "INSERT INTO workflow_runs (id, name, status, definition_json, created_at, updated_at) VALUES (?, ?, ?, '{}', ?, ?)",
    ).run('run-failed', 'Failed', 'failed', now, now);

    expect(initializeDatabase()).toBe(0);
  });
});
