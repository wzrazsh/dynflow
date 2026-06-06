import { initSchema } from '../db/schema.js';
import { runMigrations, getMigrationStatus } from '../db/migrations.js';
import { markOrphanRunsAsInterrupted } from '../db/repository.js';
import { logger } from '../logger.js';

/**
 * Initialize the database: create tables, run pending migrations,
 * and mark any orphan running workflows as interrupted.
 *
 * Safe to call multiple times -- initSchema and runMigrations are
 * idempotent, and markOrphanRunsAsInterrupted only affects rows
 * that are still in 'running' status.
 *
 * @returns The number of workflow runs that were converted from
 *          'running' to 'interrupted' (orphan recovery count).
 */
export function initializeDatabase(): number {
  initSchema();
  logger.info('Database tables initialized');

  runMigrations();
  const statuses = getMigrationStatus();
  const applied = statuses.filter((s) => s.applied).length;
  const pending = statuses.filter((s) => !s.applied).length;
  logger.info(`Migrations: ${applied} applied, ${pending} pending`);

  const orphanCount = markOrphanRunsAsInterrupted();
  if (orphanCount > 0) {
    logger.info({ count: orphanCount }, 'Converted orphan running workflows to interrupted');
  }
  return orphanCount;
}
