import dotenv from 'dotenv';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

// Load .env file from project root
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
dotenv.config({ path: join(__dirname, '../../.env') });

import { createApp, errorHandler } from './app.js'
import { isDockerAvailable, cleanupContainers } from './runner/index.js';
import { initSchema } from './db/schema.js';
import { runMigrations, getMigrationStatus } from './db/migrations.js';

const port = process.env.PORT || 3001
const app = createApp()

// ---------------------------------------------------------------------------
// Initialize database tables & run pending migrations
// ---------------------------------------------------------------------------

initSchema();
console.log('Database tables initialized');

runMigrations();
const statuses = getMigrationStatus();
const applied = statuses.filter((s) => s.applied).length;
const pending = statuses.filter((s) => !s.applied).length;
console.log(`Migrations: ${applied} applied, ${pending} pending`);

// ---------------------------------------------------------------------------
// Startup checks & cleanup
// ---------------------------------------------------------------------------

// Check Docker availability
if (isDockerAvailable()) {
  console.log('Docker is available');

  // Clean up orphaned dynflow containers from previous runs
  cleanupContainers()
    .then(() => console.log('Orphaned dynflow containers cleaned up'))
    .catch((err: unknown) => console.warn('Container cleanup warning:', String(err)));
} else {
  console.warn(
    'Docker is not available. Workflow execution will fail until Docker is started.',
  );
}

// ---------------------------------------------------------------------------
// Start server
// ---------------------------------------------------------------------------

// Global error handler — must be registered AFTER all routes
app.use(errorHandler);

const server = app.listen(port, () => {
  console.log(`DynFlow server listening on port ${port}`)
});

// ---------------------------------------------------------------------------
// Graceful shutdown
// ---------------------------------------------------------------------------

async function shutdown(signal: string): Promise<void> {
  console.log(`Received ${signal}. Shutting down gracefully...`);

  // Stop accepting new connections
  server.close(() => {
    console.log('HTTP server closed');
  });

  // Clean up any running Docker containers
  try {
    await cleanupContainers();
    console.log('Docker containers cleaned up');
  } catch (err) {
    console.warn('Cleanup warning:', String(err));
  }

  process.exit(0);
}

process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));
