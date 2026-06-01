import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import type { ProjectMeta, VersionMeta, FileEntry } from './types.js';
import {
  ProjectNotFoundError,
  VersionNotFoundError,
  PathSafetyError,
  ProjectNameValidationError,
} from './errors.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Maximum resolved path length before rejection. */
const MAX_PATH_LENGTH = 4096;

/** Maximum file size for readFile (10 MB). */
const MAX_FILE_SIZE = 10 * 1024 * 1024;

/** Simple extension-to-MIME lookup. */
const MIME_TYPES: Record<string, string> = {
  '.html': 'text/html',
  '.css': 'text/css',
  '.js': 'application/javascript',
  '.mjs': 'application/javascript',
  '.cjs': 'application/javascript',
  '.json': 'application/json',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.txt': 'text/plain',
  '.md': 'text/markdown',
  '.xml': 'application/xml',
  '.yaml': 'text/yaml',
  '.yml': 'text/yaml',
  '.zip': 'application/zip',
  '.pdf': 'application/pdf',
};

/** Regex for valid project names: lowercase alphanumeric + hyphens. */
const PROJECT_NAME_REGEX = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/;

// ===========================================================================
// Project Service
// ===========================================================================

/**
 * Manages project output directories and versioned file storage.
 *
 * Directory layout:
 * ```
 * {outputsRootDir}/
 *   └── {projectName}/
 *       ├── project.json      (ProjectMeta)
 *       ├── v1/
 *       │   ├── version.json  (VersionMeta)
 *       │   └── ... output files
 *       ├── v2/
 *       └── ...
 * ```
 */
export class ProjectService {
  constructor(private outputsRootDir: string = './outputs') {}

  // -----------------------------------------------------------------------
  // Path Resolution & Validation
  // -----------------------------------------------------------------------

  /**
   * Validates a project name against allowed patterns.
   * Must be 1-100 characters, lowercase alphanumeric with hyphens,
   * no leading/trailing hyphens, not `.` or `..`.
   */
  validateProjectName(name: string): void {
    if (!name || name.length === 0) {
      throw new ProjectNameValidationError('Project name must not be empty');
    }
    if (name.length > 100) {
      throw new ProjectNameValidationError(
        'Project name must not exceed 100 characters',
      );
    }
    if (name === '.' || name === '..') {
      throw new ProjectNameValidationError(
        'Project name must not be "." or ".."',
      );
    }
    if (!PROJECT_NAME_REGEX.test(name)) {
      throw new ProjectNameValidationError(
        'Project name must match /^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/',
      );
    }
  }

  /** Returns the project directory path for a given project name. */
  resolveProjectDir(projectName: string): string {
    this.validateProjectName(projectName);
    return path.join(this.outputsRootDir, projectName);
  }

  /** Returns the version directory path: {projectDir}/v{version}. */
  resolveVersionDir(projectName: string, version: number): string {
    return path.join(this.resolveProjectDir(projectName), `v${version}`);
  }

  /**
   * Safely resolves a user-supplied relative path inside a base directory.
   * Throws `PathSafetyError` if the path escapes the base, is absolute,
   * empty, contains null bytes, or exceeds the maximum length.
   */
  resolveSafePath(baseDir: string, userPath: string): string {
    if (userPath.length === 0) {
      throw new PathSafetyError('Path must not be empty');
    }
    if (userPath.includes('\0')) {
      throw new PathSafetyError('Path must not contain null bytes');
    }
    if (userPath.startsWith('/') || /^[A-Za-z]:[/\\]/.test(userPath)) {
      throw new PathSafetyError('Path must not be absolute');
    }

    const resolved = path.resolve(baseDir, userPath);
    const normalizedBase = path.resolve(baseDir);

    // Guard: ensure the resolved path stays inside baseDir.
    // Use a trailing separator to prevent false match on sibling prefixes
    // (e.g. "/base/v1-extra" must not pass when baseDir is "/base/v1").
    const sep =
      normalizedBase.endsWith('/') || normalizedBase.endsWith('\\') ? '' : '/';
    if (
      resolved !== normalizedBase &&
      !resolved.startsWith(normalizedBase + sep) &&
      !resolved.startsWith(normalizedBase + '\\')
    ) {
      throw new PathSafetyError('Path must not escape base directory');
    }

    if (resolved.length > MAX_PATH_LENGTH) {
      throw new PathSafetyError('Path exceeds maximum length');
    }

    return resolved;
  }

  // -----------------------------------------------------------------------
  // Version Reservation (Atomic)
  // -----------------------------------------------------------------------

  /**
   * Atomically reserves the next available version number.
   * Uses atomic `mkdir` (fails with EEXIST if directory exists) to
   * prevent race conditions — concurrent callers see EEXIST and
   * move to the next number.
   * Returns the 1-indexed version number.
   */
  async nextVersion(projectName: string): Promise<number> {
    const projectDir = this.resolveProjectDir(projectName);
    await fs.mkdir(projectDir, { recursive: true });

    let version = 1;
    while (true) {
      const versionDir = path.join(projectDir, `v${version}`);
      try {
        await fs.mkdir(versionDir);
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

  // -----------------------------------------------------------------------
  // Project Meta
  // -----------------------------------------------------------------------

  /** Reads the ProjectMeta from {projectDir}/project.json. */
  async readProjectMeta(projectName: string): Promise<ProjectMeta> {
    const projectDir = this.resolveProjectDir(projectName);
    const metaPath = path.join(projectDir, 'project.json');
    try {
      const raw = await fs.readFile(metaPath, 'utf-8');
      return JSON.parse(raw) as ProjectMeta;
    } catch (err: unknown) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        throw new ProjectNotFoundError(projectName);
      }
      throw err;
    }
  }

  /** Writes the ProjectMeta to {projectDir}/project.json. */
  async writeProjectMeta(projectName: string, meta: ProjectMeta): Promise<void> {
    const projectDir = this.resolveProjectDir(projectName);
    await fs.mkdir(projectDir, { recursive: true });
    await fs.writeFile(
      path.join(projectDir, 'project.json'),
      JSON.stringify(meta, null, 2),
      'utf-8',
    );
  }

  // -----------------------------------------------------------------------
  // Version Meta
  // -----------------------------------------------------------------------

  /** Reads the VersionMeta from {versionDir}/version.json. */
  async readVersionMeta(
    projectName: string,
    version: number,
  ): Promise<VersionMeta> {
    const versionDir = this.resolveVersionDir(projectName, version);
    const metaPath = path.join(versionDir, 'version.json');
    try {
      const raw = await fs.readFile(metaPath, 'utf-8');
      return JSON.parse(raw) as VersionMeta;
    } catch (err: unknown) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        throw new VersionNotFoundError(projectName, version);
      }
      throw err;
    }
  }

  /** Writes the VersionMeta to {versionDir}/version.json. */
  async writeVersionMeta(
    projectName: string,
    version: number,
    meta: VersionMeta,
  ): Promise<void> {
    const versionDir = this.resolveVersionDir(projectName, version);
    await fs.mkdir(versionDir, { recursive: true });
    await fs.writeFile(
      path.join(versionDir, 'version.json'),
      JSON.stringify(meta, null, 2),
      'utf-8',
    );
  }

  /**
   * Updates the version status in VersionMeta.
   * When transitioning to 'completed', file stats are automatically computed.
   */
  async updateVersionStatus(
    projectName: string,
    version: number,
    status: 'completed' | 'failed',
    error?: string,
  ): Promise<void> {
    const meta = await this.readVersionMeta(projectName, version);
    meta.status = status;
    meta.updatedAt = new Date().toISOString();
    if (error !== undefined) {
      meta.error = error;
    }
    if (status === 'completed') {
      const stats = await this.computeFileStats(projectName, version);
      meta.fileCount = stats.fileCount;
      meta.totalSize = stats.totalSize;
      meta.files = stats.files;
    }
    await this.writeVersionMeta(projectName, version, meta);
  }

  // -----------------------------------------------------------------------
  // File Operations
  // -----------------------------------------------------------------------

  /**
   * Recursively lists all files in a version directory.
   * Returns sorted FileEntry[] with relative paths (forward slashes).
   * Skips `meta.json` files.
   */
  async listFiles(
    projectName: string,
    version: number,
  ): Promise<FileEntry[]> {
    const versionDir = this.resolveVersionDir(projectName, version);
    const entries: FileEntry[] = [];

    const walk = async (dir: string): Promise<void> => {
      const items = await fs.readdir(dir, { withFileTypes: true });
      for (const item of items) {
        if (item.name === 'meta.json') continue;
        const fullPath = path.join(dir, item.name);
        if (item.isDirectory()) {
          await walk(fullPath);
        } else if (item.isFile()) {
          const stats = await fs.stat(fullPath);
          // Normalise to forward slashes for platform-independent output
          const relativePath = path
            .relative(versionDir, fullPath)
            .replace(/\\/g, '/');
          entries.push({ path: relativePath, size: stats.size });
        }
      }
    };

    await walk(versionDir);
    return entries.sort((a, b) => a.path.localeCompare(b.path));
  }

  /**
   * Reads a file from a version directory with path-safety checks.
   * Limits file size to 10 MB.
   * Returns the content as a Buffer plus a MIME type string.
   */
  async readFile(
    projectName: string,
    version: number,
    filePath: string,
  ): Promise<{ content: Buffer; mimeType: string }> {
    const versionDir = this.resolveVersionDir(projectName, version);
    const safePath = this.resolveSafePath(versionDir, filePath);

    const stats = await fs.stat(safePath);
    if (stats.size > MAX_FILE_SIZE) {
      throw new Error('File exceeds maximum size of 10MB');
    }

    const content = await fs.readFile(safePath);
    const ext = path.extname(filePath).toLowerCase();
    const mimeType = MIME_TYPES[ext] || 'application/octet-stream';

    return { content, mimeType };
  }

  /**
   * Computes aggregate file stats for a version directory:
   * file count, total size in bytes, and sorted file path list.
   */
  async computeFileStats(
    projectName: string,
    version: number,
  ): Promise<{ fileCount: number; totalSize: number; files: string[] }> {
    const fileEntries = await this.listFiles(projectName, version);
    const totalSize = fileEntries.reduce((sum, f) => sum + f.size, 0);
    return {
      fileCount: fileEntries.length,
      totalSize,
      files: fileEntries.map((f) => f.path),
    };
  }
}
