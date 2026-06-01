import { appendFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Project root is two levels up from packages/server/src/
const PROJECT_ROOT = join(__dirname, '../../..');
const LOG_DIR = join(PROJECT_ROOT, 'logs');
const LOG_FILE = join(LOG_DIR, 'server.log');

type LogLevel = 'info' | 'warn' | 'error';

function timestamp(): string {
  return new Date().toISOString();
}

function formatMessage(level: LogLevel, args: unknown[]): string {
  const message = args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' ');
  return `[${timestamp()}] [${level.toUpperCase()}] ${message}`;
}

let initialized = false;

async function ensureLogDir(): Promise<void> {
  if (initialized) return;
  if (!existsSync(LOG_DIR)) {
    await mkdir(LOG_DIR, { recursive: true });
  }
  initialized = true;
}

async function writeLog(level: LogLevel, args: unknown[]): Promise<void> {
  try {
    await ensureLogDir();
    const line = formatMessage(level, args) + '\n';

    // Console output
    if (level === 'error') {
      process.stderr.write(line);
    } else {
      process.stdout.write(line);
    }

    // File output (fire-and-forget)
    appendFile(LOG_FILE, line).catch(() => {
      /* silent — best-effort file logging */
    });
  } catch {
    // Fallback to console only
    const line = formatMessage(level, args);
    if (level === 'error') {
      console.error(line);
    } else {
      console.log(line);
    }
  }
}

export const logger = {
  info(...args: unknown[]): void {
    void writeLog('info', args);
  },
  warn(...args: unknown[]): void {
    void writeLog('warn', args);
  },
  error(...args: unknown[]): void {
    void writeLog('error', args);
  },
  /** Current log file path (for reference) */
  logPath: LOG_FILE,
};
