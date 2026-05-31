import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';

let db: Database.Database | null = null;

/**
 * Get or create the singleton SQLite database connection.
 * Uses WAL mode and enables foreign keys.
 * Set `DB_PATH` env var to control the database file location,
 * or use `':memory:'` for an in-memory database (ideal for tests).
 */
export function getDb(): Database.Database {
  if (!db) {
    const dbPath = process.env.DB_PATH || path.join(process.cwd(), 'data', 'workflows.db');

    if (dbPath !== ':memory:') {
      const dir = path.dirname(dbPath);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
    }

    db = new Database(dbPath);
    db.pragma('journal_mode = WAL');
    db.pragma('foreign_keys = ON');
  }
  return db;
}

// ---------------------------------------------------------------------------
// SQLite retry wrapper
// ---------------------------------------------------------------------------

/**
 * SQLITE_BUSY / SQLITE_LOCKED error codes from better-sqlite3.
 */
const SQLITE_BUSY = 5;
const SQLITE_LOCKED = 6;

/**
 * Execute a synchronous database operation with automatic retry on
 * SQLITE_BUSY / SQLITE_LOCKED errors using exponential backoff with jitter.
 *
 * @param fn        – the database operation to execute
 * @param retries   – maximum number of retries (default: 3)
 * @param delayMs   – base delay in ms before the first retry (default: 100)
 */
export function withRetry<T>(
  fn: () => T,
  retries = 3,
  delayMs = 100,
): T {
  for (let attempt = 0; ; attempt++) {
    try {
      return fn();
    } catch (err: unknown) {
      if (attempt >= retries) throw err;

      // Only retry on SQLite lock/busy errors
      if (err instanceof Error && 'code' in err) {
        const code = (err as { code?: number }).code;
        if (code !== SQLITE_BUSY && code !== SQLITE_LOCKED) throw err;
      } else {
        throw err;
      }

      // Exponential backoff with jitter (±50%)
      const jitter = 0.5 + Math.random();
      const wait = delayMs * Math.pow(2, attempt) * jitter;
      // Synchronous busy-wait for better-sqlite3
      const deadline = Date.now() + wait;
      while (Date.now() < deadline) {
        /* busy-wait */
      }
    }
  }
}

/**
 * Close the database connection and reset the singleton.
 * Primarily used in tests to get a fresh database.
 */
export function closeDb(): void {
  if (db) {
    db.close();
    db = null;
  }
}
