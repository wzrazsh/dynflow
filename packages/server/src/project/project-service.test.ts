import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  mkdirSync,
  writeFileSync,
  readFileSync,
  rmSync,
  existsSync,
  readdirSync,
  statSync,
} from 'node:fs';
import { join, resolve, relative, normalize } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';

// ---------------------------------------------------------------------------
// Contract Types – will be extracted to @dynflow/shared or ProjectService in
// Phase 3.  Defined inline so the test file stands alone.
// ---------------------------------------------------------------------------

interface ProjectMeta {
  projectName: string;
  currentVersion: number;
  createdAt: string;
  updatedAt: string;
}

interface VersionMeta {
  version: string;
  status: 'running' | 'completed' | 'failed';
  fileCount: number;
  totalSize: number;
  files: string[];
  createdAt: string;
  updatedAt: string;
}

interface FileEntry {
  path: string;
  size: number;
}

// ---------------------------------------------------------------------------
// Contract Helpers
// ---------------------------------------------------------------------------
// These minimal implementations define the expected API contract.  They will
// be replaced by the real ProjectService class in Phase 3.
// ---------------------------------------------------------------------------

/** Maximum allowed path length after resolution. */
const MAX_PATH_LENGTH = 4096;

/**
 * Safely resolves a user-supplied relative path inside a base directory.
 * Throws if the path escapes the base, is absolute, empty, or too long.
 */
function resolveSafePath(baseDir: string, userPath: string): string {
  if (userPath.length === 0) {
    throw new Error('Path must not be empty');
  }
  if (userPath.includes('\0')) {
    throw new Error('Path must not contain null bytes');
  }
  if (userPath.startsWith('/') || /^[A-Za-z]:[/\\]/.test(userPath)) {
    throw new Error('Path must not be absolute');
  }

  const resolved = resolve(baseDir, userPath);
  const normalizedBase = normalize(baseDir);

  // Guard: ensure the resolved path stays inside baseDir.
  // Use a trailing separator to prevent false match on sibling prefixes
  // (e.g. "/base/v1-extra" must not pass when baseDir is "/base/v1").
  if (resolved !== normalizedBase && !resolved.startsWith(normalizedBase + (normalizedBase.endsWith('/') || normalizedBase.endsWith('\\') ? '' : '/'))) {
    // Try with backslash on Windows in case the resolve produced backslashes
    if (resolved !== normalizedBase && !resolved.startsWith(normalizedBase + '\\')) {
      throw new Error('Path must not escape base directory');
    }
  }

  if (resolved.length > MAX_PATH_LENGTH) {
    throw new Error('Path exceeds maximum length');
  }

  return resolved;
}

/**
 * Atomically reserves the next available version number inside `projectDir`.
 * Uses `mkdirSync` (atomic filesystem operation) to prevent races:
 * if two callers try to reserve the same version, one succeeds and the
 * other sees EEXIST and moves to the next number.
 * Returns the 1-indexed version number.
 */
function nextVersion(projectDir: string): number {
  mkdirSync(projectDir, { recursive: true });

  let version = 1;
  while (true) {
    const versionDir = join(projectDir, `v${version}`);
    try {
      mkdirSync(versionDir);
      return version;
    } catch (err: unknown) {
      if ((err as NodeJS.ErrnoException).code === 'EEXIST') {
        version++;
        continue;
      }
      throw err;
    }
  }
}

// ---- Meta read / write ----------------------------------------------------

function writeProjectMeta(projectDir: string, meta: ProjectMeta): void {
  mkdirSync(projectDir, { recursive: true });
  writeFileSync(
    join(projectDir, 'project.json'),
    JSON.stringify(meta, null, 2),
    'utf-8',
  );
}

function readProjectMeta(projectDir: string): ProjectMeta {
  const raw = readFileSync(join(projectDir, 'project.json'), 'utf-8');
  return JSON.parse(raw) as ProjectMeta;
}

function writeVersionMeta(versionDir: string, meta: VersionMeta): void {
  mkdirSync(versionDir, { recursive: true });
  writeFileSync(
    join(versionDir, 'version.json'),
    JSON.stringify(meta, null, 2),
    'utf-8',
  );
}

function readVersionMeta(versionDir: string): VersionMeta {
  const raw = readFileSync(join(versionDir, 'version.json'), 'utf-8');
  return JSON.parse(raw) as VersionMeta;
}

// ---- File listing / stats -------------------------------------------------

function listFiles(versionDir: string): FileEntry[] {
  const entries: FileEntry[] = [];

  function walk(dir: string) {
    const items = readdirSync(dir, { withFileTypes: true });
    for (const item of items) {
      const fullPath = join(dir, item.name);
      if (item.isDirectory()) {
        walk(fullPath);
      } else if (item.isFile()) {
        const stats = statSync(fullPath);
        // Normalise to forward slashes for platform-independent output
        const relativePath = relative(versionDir, fullPath).replace(/\\/g, '/');
        entries.push({ path: relativePath, size: stats.size });
      }
    }
  }

  walk(versionDir);
  return entries.sort((a, b) => a.path.localeCompare(b.path));
}

function computeFileStats(
  versionDir: string,
): { fileCount: number; totalSize: number; files: string[] } {
  const fileEntries = listFiles(versionDir);
  const totalSize = fileEntries.reduce((sum, f) => sum + f.size, 0);
  return {
    fileCount: fileEntries.length,
    totalSize,
    files: fileEntries.map((f) => f.path),
  };
}

// ---------------------------------------------------------------------------
// Helpers – temp directory management
// ---------------------------------------------------------------------------

function tempDir(): string {
  return join(tmpdir(), 'dynflow-test-' + randomUUID());
}

function ensureCleanDir(dir: string): void {
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
}

function removeDir(dir: string): void {
  rmSync(dir, { recursive: true, force: true });
}

// ===========================================================================
// Tests
// ===========================================================================

// ---------------------------------------------------------------------------
// Safe Path Resolution
// ---------------------------------------------------------------------------

describe('resolveSafePath', () => {
  it('resolves a normal relative path inside the base directory', () => {
    const base = resolve('/outputs/myproject/v1');
    const result = resolveSafePath(base, 'index.html');
    expect(result).toBe(resolve(base, 'index.html'));
  });

  it('resolves nested relative paths correctly', () => {
    const base = resolve('/outputs/myproject/v1');
    const result = resolveSafePath(base, 'subdir/style.css');
    expect(result).toBe(resolve(base, 'subdir/style.css'));
  });

  it('rejects parent-directory traversal (../)', () => {
    const base = resolve('/outputs/myproject/v1');
    expect(() => resolveSafePath(base, '../secret.txt')).toThrow(
      'Path must not escape base directory',
    );
  });

  it('rejects deep parent-directory traversal', () => {
    const base = resolve('/outputs/myproject/v1');
    expect(() => resolveSafePath(base, '../../etc/passwd')).toThrow(
      'Path must not escape base directory',
    );
  });

  it('rejects paths that only appear to be inside the base due to prefix similarities', () => {
    // base = /outputs/myproject/v1, userPath = ../v1-extra/file.txt
    // resolve -> /outputs/myproject/v1-extra/file.txt
    // v1-extra is a sibling of v1, NOT inside it.  Without the separator
    // guard v1-extra would pass the naive startsWith(base) check.
    const base = resolve('/outputs/myproject/v1');
    expect(() => resolveSafePath(base, '../v1-extra/file.txt')).toThrow(
      'Path must not escape base directory',
    );
  });

  it('rejects absolute paths', () => {
    const base = resolve('/outputs/myproject/v1');
    expect(() => resolveSafePath(base, '/etc/passwd')).toThrow(
      'Path must not be absolute',
    );
  });

  it('rejects absolute Windows-style paths', () => {
    const base = resolve('/outputs/myproject/v1');
    expect(() => resolveSafePath(base, 'C:\\Windows\\system32')).toThrow(
      'Path must not be absolute',
    );
  });

  it('rejects empty paths', () => {
    const base = resolve('/outputs/myproject/v1');
    expect(() => resolveSafePath(base, '')).toThrow('Path must not be empty');
  });

  it('rejects null byte characters in path', () => {
    const base = resolve('/outputs/myproject/v1');
    expect(() => resolveSafePath(base, "index.html\0")).toThrow(
      'Path must not contain null bytes',
    );
  });

  it('rejects paths that exceed maximum length', () => {
    const base = resolve('/outputs/myproject/v1');
    const longName = 'a'.repeat(MAX_PATH_LENGTH + 1);
    expect(() => resolveSafePath(base, longName)).toThrow(
      'Path exceeds maximum length',
    );
  });

  it('allows paths at exactly the maximum length', () => {
    const base = resolve('/outputs/myproject/v1');
    // Pad the filename so the *resolved* path is exactly MAX_PATH_LENGTH
    const fileName = 'a'.repeat(MAX_PATH_LENGTH - base.length - 1); // +1 for sep
    const result = resolveSafePath(base, fileName);
    expect(result.length).toBeLessThanOrEqual(MAX_PATH_LENGTH);
  });
});

// ---------------------------------------------------------------------------
// Atomic Version Reservation
// ---------------------------------------------------------------------------

describe('nextVersion', () => {
  let projectDir: string;

  beforeEach(() => {
    projectDir = tempDir();
  });

  afterEach(() => {
    removeDir(projectDir);
  });

  it('returns version 1 for an empty project directory', () => {
    const v = nextVersion(projectDir);
    expect(v).toBe(1);
  });

  it('increments the version number on each call', () => {
    expect(nextVersion(projectDir)).toBe(1);
    expect(nextVersion(projectDir)).toBe(2);
    expect(nextVersion(projectDir)).toBe(3);
  });

  it('never returns the same version number twice', () => {
    const versions = new Set<number>();
    for (let i = 0; i < 10; i++) {
      const v = nextVersion(projectDir);
      expect(versions.has(v)).toBe(false);
      versions.add(v);
    }
    expect(versions.size).toBe(10);
  });

  it('creates directories named v{N} inside the project dir', () => {
    const v1 = nextVersion(projectDir);
    expect(existsSync(join(projectDir, `v${v1}`))).toBe(true);
    expect(existsSync(join(projectDir, 'v1'))).toBe(true);

    const v2 = nextVersion(projectDir);
    expect(existsSync(join(projectDir, `v${v2}`))).toBe(true);
    expect(existsSync(join(projectDir, 'v2'))).toBe(true);
  });

  it('skips version numbers whose directory already exists', () => {
    // Manually create v1, v3 – nextVersion should return 2, then 4
    mkdirSync(join(projectDir, 'v1'), { recursive: true });
    mkdirSync(join(projectDir, 'v3'), { recursive: true });

    expect(nextVersion(projectDir)).toBe(2);
    expect(nextVersion(projectDir)).toBe(4);
  });

  it('creates the project directory if it does not exist', () => {
    const freshDir = tempDir();
    try {
      const v = nextVersion(freshDir);
      expect(v).toBe(1);
      expect(existsSync(freshDir)).toBe(true);
    } finally {
      removeDir(freshDir);
    }
  });
});

// ---------------------------------------------------------------------------
// Project / Version Meta Read / Write
// ---------------------------------------------------------------------------

describe('Project Meta read/write', () => {
  let projectDir: string;

  beforeEach(() => {
    projectDir = tempDir();
  });

  afterEach(() => {
    removeDir(projectDir);
  });

  it('writes and reads ProjectMeta', () => {
    const meta: ProjectMeta = {
      projectName: 'my-project',
      currentVersion: 1,
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
    };

    writeProjectMeta(projectDir, meta);
    const loaded = readProjectMeta(projectDir);

    expect(loaded).toEqual(meta);
  });

  it('round-trips a ProjectMeta with currentVersion=5', () => {
    const meta: ProjectMeta = {
      projectName: 'versioned-app',
      currentVersion: 5,
      createdAt: '2026-06-01T12:00:00.000Z',
      updatedAt: '2026-06-01T12:30:00.000Z',
    };

    writeProjectMeta(projectDir, meta);
    const loaded = readProjectMeta(projectDir);
    expect(loaded.currentVersion).toBe(5);
    expect(loaded.projectName).toBe('versioned-app');
  });
});

describe('Version Meta read/write', () => {
  let versionDir: string;

  beforeEach(() => {
    versionDir = tempDir();
  });

  afterEach(() => {
    removeDir(versionDir);
  });

  it('writes and reads VersionMeta with status running', () => {
    const meta: VersionMeta = {
      version: 'v1',
      status: 'running',
      fileCount: 0,
      totalSize: 0,
      files: [],
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
    };

    writeVersionMeta(versionDir, meta);
    const loaded = readVersionMeta(versionDir);
    expect(loaded).toEqual(meta);
  });

  it('transitions VersionMeta status from running to completed', () => {
    const meta: VersionMeta = {
      version: 'v1',
      status: 'running',
      fileCount: 0,
      totalSize: 0,
      files: [],
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
    };
    writeVersionMeta(versionDir, meta);

    const updated: VersionMeta = {
      ...meta,
      status: 'completed',
      fileCount: 3,
      totalSize: 1024,
      files: ['a.txt', 'b.txt', 'c.txt'],
      updatedAt: '2026-01-01T01:00:00.000Z',
    };
    writeVersionMeta(versionDir, updated);
    const loaded = readVersionMeta(versionDir);
    expect(loaded.status).toBe('completed');
    expect(loaded.fileCount).toBe(3);
  });

  it('transitions VersionMeta status from running to failed', () => {
    const meta: VersionMeta = {
      version: 'v1',
      status: 'running',
      fileCount: 0,
      totalSize: 0,
      files: [],
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
    };
    writeVersionMeta(versionDir, meta);

    const updated: VersionMeta = {
      ...meta,
      status: 'failed',
      updatedAt: '2026-01-01T01:00:00.000Z',
    };
    writeVersionMeta(versionDir, updated);
    const loaded = readVersionMeta(versionDir);
    expect(loaded.status).toBe('failed');
  });

  it('stores file-related metadata in VersionMeta', () => {
    const meta: VersionMeta = {
      version: 'v2',
      status: 'completed',
      fileCount: 5,
      totalSize: 9999,
      files: ['main.js', 'style.css', 'index.html', 'data.json', 'icon.png'],
      createdAt: '2026-06-01T00:00:00.000Z',
      updatedAt: '2026-06-01T02:00:00.000Z',
    };
    writeVersionMeta(versionDir, meta);
    const loaded = readVersionMeta(versionDir);
    expect(loaded.fileCount).toBe(5);
    expect(loaded.totalSize).toBe(9999);
    expect(loaded.files).toHaveLength(5);
    expect(loaded.files).toContain('main.js');
  });
});

// ---------------------------------------------------------------------------
// File Listing and Size Stats
// ---------------------------------------------------------------------------

describe('listFiles', () => {
  let versionDir: string;

  beforeEach(() => {
    versionDir = tempDir();
    mkdirSync(versionDir, { recursive: true });
  });

  afterEach(() => {
    removeDir(versionDir);
  });

  it('returns an empty array for an empty directory', () => {
    const files = listFiles(versionDir);
    expect(files).toEqual([]);
  });

  it('lists a single file with its size', () => {
    writeFileSync(join(versionDir, 'hello.txt'), 'world');
    const files = listFiles(versionDir);
    expect(files).toHaveLength(1);
    expect(files[0].path).toBe('hello.txt');
    expect(files[0].size).toBe(5); // 'world' = 5 bytes
  });

  it('recursively walks subdirectories', () => {
    mkdirSync(join(versionDir, 'css'));
    mkdirSync(join(versionDir, 'js'));
    writeFileSync(join(versionDir, 'index.html'), '<html></html>');
    writeFileSync(join(versionDir, 'css', 'style.css'), 'body {}');
    writeFileSync(join(versionDir, 'js', 'app.js'), 'console.log(1)');

    const files = listFiles(versionDir);
    expect(files).toHaveLength(3);

    const paths = files.map((f) => f.path);
    expect(paths).toContain('index.html');
    expect(paths).toContain('css/style.css');
    expect(paths).toContain('js/app.js');
  });

  it('returns correct sizes for each file', () => {
    writeFileSync(join(versionDir, 'a.txt'), '12345');       // 5 bytes
    writeFileSync(join(versionDir, 'b.txt'), '1234567890');  // 10 bytes
    mkdirSync(join(versionDir, 'sub'));
    writeFileSync(join(versionDir, 'sub', 'c.txt'), '1');    // 1 byte

    const files = listFiles(versionDir);
    expect(files.find((f) => f.path === 'a.txt')!.size).toBe(5);
    expect(files.find((f) => f.path === 'b.txt')!.size).toBe(10);
    expect(files.find((f) => f.path === 'sub/c.txt')!.size).toBe(1);
  });

  it('sorts files alphabetically by path', () => {
    writeFileSync(join(versionDir, 'z.txt'), '');
    writeFileSync(join(versionDir, 'a.txt'), '');
    writeFileSync(join(versionDir, 'm.txt'), '');

    const files = listFiles(versionDir);
    expect(files.map((f) => f.path)).toEqual(['a.txt', 'm.txt', 'z.txt']);
  });
});

describe('computeFileStats', () => {
  let versionDir: string;

  beforeEach(() => {
    versionDir = tempDir();
    mkdirSync(versionDir, { recursive: true });
  });

  afterEach(() => {
    removeDir(versionDir);
  });

  it('returns zero counts for an empty directory', () => {
    const stats = computeFileStats(versionDir);
    expect(stats.fileCount).toBe(0);
    expect(stats.totalSize).toBe(0);
    expect(stats.files).toEqual([]);
  });

  it('computes fileCount, totalSize, and file names correctly', () => {
    writeFileSync(join(versionDir, 'a.txt'), 'hello'); // 5
    writeFileSync(join(versionDir, 'b.txt'), 'world'); // 5
    mkdirSync(join(versionDir, 'nested'));
    writeFileSync(join(versionDir, 'nested', 'c.txt'), '12345'); // 5

    const stats = computeFileStats(versionDir);
    expect(stats.fileCount).toBe(3);
    expect(stats.totalSize).toBe(15);
    expect(stats.files).toHaveLength(3);
    expect(stats.files).toContain('a.txt');
    expect(stats.files).toContain('nested/c.txt');
  });

  it('aggregates deeply nested files into totalSize', () => {
    mkdirSync(join(versionDir, 'a', 'b', 'c'), { recursive: true });
    writeFileSync(join(versionDir, 'root.txt'), 'A'.repeat(100));
    writeFileSync(join(versionDir, 'a', 'l1.txt'), 'B'.repeat(200));
    writeFileSync(join(versionDir, 'a', 'b', 'l2.txt'), 'C'.repeat(300));
    writeFileSync(join(versionDir, 'a', 'b', 'c', 'l3.txt'), 'D'.repeat(400));

    const stats = computeFileStats(versionDir);
    expect(stats.fileCount).toBe(4);
    expect(stats.totalSize).toBe(100 + 200 + 300 + 400);
  });
});
