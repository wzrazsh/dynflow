import dotenv from 'dotenv';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

// Load .env file from project root
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
dotenv.config({ path: join(__dirname, '../../../.env') });

import { createApp, errorHandler } from './app.js'
import { isDockerAvailable, cleanupContainers } from './runner/index.js';
import { initializeDatabase } from './bootstrap/initialize.js';
import { logger } from './logger.js';

const port = Number(process.env.PORT) || 3001
const host = process.env.HOST || '127.0.0.1'
const app = createApp()

// ---------------------------------------------------------------------------
// Initialize database tables, run migrations & recover orphan workflows
// ---------------------------------------------------------------------------

initializeDatabase();

// ---------------------------------------------------------------------------
// Startup checks & cleanup
// ---------------------------------------------------------------------------

// Check Docker availability
if (isDockerAvailable()) {
  logger.info('Docker is available');

  // Clean up orphaned dynflow containers from previous runs
  cleanupContainers()
    .then(() => logger.info('Orphaned dynflow containers cleaned up'))
    .catch((err: unknown) => logger.warn('Container cleanup warning:', String(err)));
} else {
  logger.warn(
    'Docker is not available. Workflow execution will fail until Docker is started.',
  );
}

// ---------------------------------------------------------------------------
// Start server
// ---------------------------------------------------------------------------

// Global error handler 鈥?must be registered AFTER all routes
app.use(errorHandler);

const server = app.listen(port, host, () => {
  logger.info(`DynFlow server listening on ${host}:${port}`)
});

// ---------------------------------------------------------------------------
// Graceful shutdown
// ---------------------------------------------------------------------------

async function shutdown(signal: string): Promise<void> {
  logger.info(`Received ${signal}. Shutting down gracefully...`);

  // Stop accepting new connections
  server.close(() => {
    logger.info('HTTP server closed');
  });

  // Clean up any running Docker containers
  try {
    await cleanupContainers();
    logger.info('Docker containers cleaned up');
  } catch (err) {
    logger.warn('Cleanup warning:', String(err));
  }

  process.exit(0);
}

process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));
