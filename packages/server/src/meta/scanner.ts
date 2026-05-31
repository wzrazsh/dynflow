import { execFile } from 'node:child_process';
import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ScanOptions {
  /** Git clone timeout in ms (default: 60000) */
  timeoutMs?: number;
  /** Max files to walk before aborting (default: 1000) */
  maxFileCount?: number;
  /** Max cumulative bytes across all files (default: 50 MB) */
  maxTotalBytes?: number;
  /** Max bytes for a single file (default: 1 MB) */
  maxFileBytes?: number;
  /** Parent directory for the clone temp folder (default: os.tmpdir()) */
  workspaceDir?: string;
}

export interface ScanResult {
  /** Whether the scan completed without errors */
  success: boolean;
  /** Human-readable project identifier (e.g. "owner/repo") */
  projectName?: string;
  /** Scanned files (only contents for definition files) */
  files?: ScannedFile[];
  /** Error description when success is false */
  error?: string;
  /** Whether the temporary clone directory was cleaned up */
  cleanedUp: boolean;
}

export interface ScannedFile {
  /** Relative path within the repository */
  path: string;
  /** File contents (populated only for definition files) */
  content: string;
  /** File size in bytes */
  size: number;
  /** True when the file looks like an agent/skill definition */
  isDefinition: boolean;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DEFINITION_EXTENSIONS = new Set(['.md', '.json', '.yaml', '.yml']);
const MAX_FIRST_BYTES_FOR_CONTENT_CHECK = 4096;

const DEFAULT_OPTIONS: Required<ScanOptions> = {
  timeoutMs: 60_000,
  maxFileCount: 1000,
  maxTotalBytes: 50 * 1024 * 1024,
  maxFileBytes: 1024 * 1024,
  workspaceDir: os.tmpdir(),
};

// ---------------------------------------------------------------------------
// URL validation  (exported for testing)
// ---------------------------------------------------------------------------

/**
 * Returns `true` when `url` matches the only accepted pattern:
 * `https://github.com/<owner>/<repo>` (with optional trailing `.git` or `/`).
 */
export function isValidGithubUrl(url: string): boolean {
  if (!url.startsWith('https://github.com/')) return false;

  const afterPrefix = url.slice('https://github.com/'.length);
  // Normalise: strip trailing slashes and .git
  const cleaned = afterPrefix.replace(/\/+$/, '').replace(/\.git$/, '');
  const parts = cleaned.split('/').filter(Boolean);

  // Must be exactly <owner>/<repo>
  if (parts.length !== 2) return false;

  const [owner, repo] = parts;
  const validSegment = /^[a-zA-Z0-9._-]+$/;
  return validSegment.test(owner) && validSegment.test(repo);
}

/**
 * Extract the `owner/repo` project name from a validated GitHub URL.
 */
export function extractProjectName(url: string): string {
  const afterPrefix = url.slice('https://github.com/'.length);
  const cleaned = afterPrefix.replace(/\/+$/, '').replace(/\.git$/, '');
  const parts = cleaned.split('/').filter(Boolean);
  if (parts.length < 2) {
    throw new Error(`Cannot extract project name from: ${url}`);
  }
  return `${parts[0]}/${parts[1]}`;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function resolveOptions(partial?: ScanOptions): Required<ScanOptions> {
  return {
    timeoutMs: partial?.timeoutMs ?? DEFAULT_OPTIONS.timeoutMs,
    maxFileCount: partial?.maxFileCount ?? DEFAULT_OPTIONS.maxFileCount,
    maxTotalBytes: partial?.maxTotalBytes ?? DEFAULT_OPTIONS.maxTotalBytes,
    maxFileBytes: partial?.maxFileBytes ?? DEFAULT_OPTIONS.maxFileBytes,
    workspaceDir: partial?.workspaceDir ?? DEFAULT_OPTIONS.workspaceDir,
  };
}

async function createTempDir(baseDir: string): Promise<string> {
  const suffix = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const dir = path.join(baseDir, `dynflow-scan-${suffix}`);
  await fs.mkdir(dir, { recursive: true });
  return dir;
}

/**
 * Thin wrapper around `child_process.execFile` so vitest mocks work at call time.
 */
function execGitClone(url: string, targetDir: string, timeoutMs: number): Promise<void> {
  return new Promise((resolve, reject) => {
    execFile(
      'git',
      ['clone', '--depth', '1', url, targetDir],
      { timeout: timeoutMs },
      (err) => {
        if (err) reject(err);
        else resolve();
      },
    );
  });
}

// ---------------------------------------------------------------------------
// File walking
// ---------------------------------------------------------------------------

/**
 * Walk `dir` recursively, collecting files and checking limits.
 *
 * Exported for testing — use `scanDirectory` or `scanProject` for the public API.
 * When a limit is hit (file count / total bytes), returns partial results with
 * an `error` string rather than throwing.
 */
export async function walkDirectory(
  dir: string,
  rootDir: string,
  options: Required<ScanOptions>,
): Promise<{ files: ScannedFile[]; error?: string }> {
  const files: ScannedFile[] = [];
  try {
    await walkDirectoryInner(dir, rootDir, options, files, { totalBytes: 0, fileCount: 0 });
  } catch (err: unknown) {
    if (err instanceof LimitError) {
      return { files, error: err.message };
    }
    throw err;
  }
  return { files };

  async function walkDirectoryInner(
    currentDir: string,
    rootDir: string,
    opts: Required<ScanOptions>,
    collected: ScannedFile[],
    counters: { totalBytes: number; fileCount: number },
  ): Promise<void> {
    const entries = await fs.readdir(currentDir, { withFileTypes: true });

    for (const entry of entries) {
      if (counters.fileCount >= opts.maxFileCount) {
        throw new LimitError(`Exceeded maximum file count of ${opts.maxFileCount}`);
      }
      if (counters.totalBytes >= opts.maxTotalBytes) {
        throw new LimitError(`Exceeded maximum total bytes of ${opts.maxTotalBytes}`);
      }

      const fullPath = path.join(currentDir, entry.name);

      // ---- Symlinks: silently skip (do NOT follow) ----
      if (entry.isSymbolicLink()) continue;

      // ---- Path traversal: defence in depth ----
      if (path.relative(rootDir, fullPath).startsWith('..')) continue;

      if (entry.isDirectory()) {
        // Skip common noise directories
        if (entry.name === 'node_modules' || entry.name === '.git') continue;
        await walkDirectoryInner(fullPath, rootDir, opts, collected, counters);
      } else if (entry.isFile()) {
        counters.fileCount++;

        let stat;
        try {
          stat = await fs.stat(fullPath);
        } catch {
          continue; // skip inaccessible files
        }

        const relativePath = path.relative(rootDir, fullPath);

        // ---- Scan one file ----
        const result = await scanFile(fullPath, relativePath, stat, opts);
        if (result) {
          collected.push(result);
          counters.totalBytes += stat.size;
        }
      }
    }
  }
}

/**
 * Internal error class to break out of deep recursion when a limit is hit.
 */
class LimitError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'LimitError';
  }
}

// ---------------------------------------------------------------------------
// Single file scanning
// ---------------------------------------------------------------------------

async function scanFile(
  fullPath: string,
  relativePath: string,
  stat: { size: number },
  opts: Required<ScanOptions>,
): Promise<ScannedFile | null> {
  // Enforce per-file size cap (silently skip oversized files)
  if (stat.size > opts.maxFileBytes) return null;

  const ext = path.extname(relativePath).toLowerCase();
  const isDefExt = DEFINITION_EXTENSIONS.has(ext);

  if (!isDefExt) {
    return {
      path: relativePath,
      content: '',
      size: stat.size,
      isDefinition: false,
    };
  }

  // ---- Determine if this is a definition file ----
  // Check the full relative path (including subdirectories) for agent/skill keywords
  const lowerPath = relativePath.toLowerCase();
  const nameMatches = lowerPath.includes('agent') || lowerPath.includes('skill');

  if (nameMatches) {
    const content = await fs.readFile(fullPath, 'utf-8');
    return { path: relativePath, content, size: stat.size, isDefinition: true };
  }

  // Check file content for agent/skill keywords
  const handle = await fs.open(fullPath, 'r');
  try {
    const buffer = Buffer.alloc(Math.min(stat.size, MAX_FIRST_BYTES_FOR_CONTENT_CHECK));
    await handle.read(buffer, 0, buffer.length, 0);
    const head = buffer.toString('utf-8').toLowerCase();
    if (head.includes('agent') || head.includes('skill')) {
      const content = await fs.readFile(fullPath, 'utf-8');
      return { path: relativePath, content, size: stat.size, isDefinition: true };
    }
  } finally {
    await handle.close();
  }

  return {
    path: relativePath,
    content: '',
    size: stat.size,
    isDefinition: false,
  };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Scan a local directory for agent/skill definition files.
 *
 * Exported for testing and for callers that already have the directory on disk.
 */
export async function scanDirectory(
  dir: string,
  options?: ScanOptions,
): Promise<{ files: ScannedFile[]; error?: string }> {
  const opts = resolveOptions(options);
  const rootDir = path.resolve(dir);
  const { files, error } = await walkDirectory(rootDir, rootDir, opts);
  return { files, error };
}

/**
 * Clone a GitHub repository and scan its contents for agent/skill definitions.
 *
 * - Only `https://github.com/<owner>/<repo>` URLs are accepted
 * - The clone is shallow (`--depth 1`) for speed
 * - Temporary files are cleaned up in a `finally` block
 * - Enforces limits on file count, total bytes, and per-file bytes
 */
export async function scanProject(
  url: string,
  options?: ScanOptions,
): Promise<ScanResult> {
  const opts = resolveOptions(options);

  // 1. Validate URL ----------------------------------------------------------
  if (!isValidGithubUrl(url)) {
    return {
      success: false,
      error:
        `Invalid GitHub URL: "${url}". ` +
        'Only https://github.com/<owner>/<repo> URLs are accepted.',
      cleanedUp: true,
    };
  }

  const projectName = extractProjectName(url);
  const tempDir = await createTempDir(opts.workspaceDir);
  const result: ScanResult = {
    success: false,
    projectName,
    cleanedUp: false,
  };

  try {
    // 2. Shallow clone -------------------------------------------------------
    await execGitClone(url, tempDir, opts.timeoutMs);

    // 3. Walk files ----------------------------------------------------------
    const { files } = await walkDirectory(tempDir, tempDir, opts);
    result.success = true;
    result.files = files;
  } catch (err: unknown) {
    result.error = err instanceof Error ? err.message : String(err);
  } finally {
    // 4. Cleanup -------------------------------------------------------------
    try {
      await fs.rm(tempDir, { recursive: true, force: true });
      result.cleanedUp = true;
    } catch {
      result.cleanedUp = false;
    }
  }

  return result;
}
