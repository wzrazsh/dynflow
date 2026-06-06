import { Router } from 'express';
import type { Dirent } from 'node:fs';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { ProjectService } from '../project/project-service.js';
import type { ProjectMeta, VersionMeta } from '../project/types.js';
import {
  ProjectNotFoundError,
  VersionNotFoundError,
  PathSafetyError,
} from '../project/errors.js';
import { executeScript } from '../sandbox/isolated-runtime.js';
import { validateWorkflowDefinition } from '@dynflow/shared';
import * as repo from '../db/repository.js';
import { StreamManager } from '../sse/stream-manager.js';
import { createAgentRunner } from '../runner/index.js';
import { WorkflowRuntime } from '../workflow/runtime.js';
import type { WorkflowExecuteOptions } from '../workflow/runtime.js';

const router = Router();
const projectService = new ProjectService();
const activeRuntimes = new Map<string, WorkflowRuntime>();

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Escape a string for safe embedding inside single quotes in a generated
 * workflow script. Handles backslashes, single quotes, and newlines.
 */
function escapeScriptValue(value: string): string {
  return value
    .replace(/\\/g, '\\\\')
    .replace(/'/g, "\\'")
    .replace(/\n/g, '\\n')
    .replace(/\r/g, '\\r');
}

/**
 * Determine whether a MIME type represents textual content that can be
 * safely returned as a UTF-8 string to the client.
 */
function isTextMimeType(mimeType: string): boolean {
  return (
    mimeType.startsWith('text/') ||
    mimeType === 'application/json' ||
    mimeType === 'application/javascript'
  );
}

// ---------------------------------------------------------------------------
// POST / — Create a new project
// ---------------------------------------------------------------------------
router.post('/', async (req, res) => {
  try {
    const { name } = req.body;

    if (!name || typeof name !== 'string') {
      return res
        .status(400)
        .json({ success: false, error: 'Project name is required' });
    }

    projectService.validateProjectName(name);

    // nextVersion() atomically creates the first version directory
    const version = await projectService.nextVersion(name);
    const now = new Date().toISOString();

    const projectMeta: ProjectMeta = {
      projectName: name,
      currentVersion: version,
      createdAt: now,
      updatedAt: now,
    };
    await projectService.writeProjectMeta(name, projectMeta);

    res.status(201).json({
      success: true,
      data: { projectName: name, currentVersion: version },
    });
  } catch (error) {
    res.status(500).json({ success: false, error: String(error) });
  }
});

// ---------------------------------------------------------------------------
// GET / — List all projects
// ---------------------------------------------------------------------------
router.get('/', async (req, res) => {
  try {
    let entries: Dirent[];
    try {
      entries = await fs.readdir(path.resolve('./outputs'), {
        withFileTypes: true,
      });
    } catch {
      // Outputs directory does not exist yet — no projects
      return res.json({ success: true, data: [] });
    }

    const projects: ProjectMeta[] = [];
    for (const entry of entries) {
      if (entry.isDirectory()) {
        try {
          const meta = await projectService.readProjectMeta(entry.name);
          projects.push(meta);
        } catch {
          // Skip directories without a valid project.json
        }
      }
    }

    res.json({ success: true, data: projects });
  } catch (error) {
    res.status(500).json({ success: false, error: String(error) });
  }
});

// ---------------------------------------------------------------------------
// GET /:name — Get project detail with current version
// ---------------------------------------------------------------------------
router.get('/:name', async (req, res) => {
  try {
    const { name } = req.params;
    const meta = await projectService.readProjectMeta(name);
    res.json({ success: true, data: meta });
  } catch (error) {
    if (error instanceof ProjectNotFoundError) {
      return res.status(404).json({ success: false, error: error.message });
    }
    res.status(500).json({ success: false, error: String(error) });
  }
});

// ---------------------------------------------------------------------------
// GET /:name/versions — List all versions with summaries
// ---------------------------------------------------------------------------
router.get('/:name/versions', async (req, res) => {
  try {
    const { name } = req.params;
    const projectDir = projectService.resolveProjectDir(name);

    let entries: Dirent[];
    try {
      entries = await fs.readdir(projectDir, { withFileTypes: true });
    } catch {
      return res.status(404).json({ success: false, error: 'Project not found' });
    }

    const versions: VersionMeta[] = [];
    for (const entry of entries) {
      if (entry.isDirectory() && /^v\d+$/.test(entry.name)) {
        const versionNum = parseInt(entry.name.slice(1), 10);
        try {
          const meta = await projectService.readVersionMeta(name, versionNum);
          versions.push(meta);
        } catch {
          // Skip version directories without a valid version.json
        }
      }
    }

    // Sort descending (newest first)
    versions.sort((a, b) => parseInt(b.version) - parseInt(a.version));

    res.json({ success: true, data: versions });
  } catch (error) {
    res.status(500).json({ success: false, error: String(error) });
  }
});

// ---------------------------------------------------------------------------
// GET /:name/versions/:version — Get version detail
// ---------------------------------------------------------------------------
router.get('/:name/versions/:version', async (req, res) => {
  try {
    const { name } = req.params;
    const version = parseInt(req.params.version, 10);

    if (isNaN(version)) {
      return res
        .status(400)
        .json({ success: false, error: 'Version must be a number' });
    }

    const meta = await projectService.readVersionMeta(name, version);
    res.json({ success: true, data: meta });
  } catch (error) {
    if (
      error instanceof ProjectNotFoundError ||
      error instanceof VersionNotFoundError
    ) {
      return res.status(404).json({ success: false, error: error.message });
    }
    res.status(500).json({ success: false, error: String(error) });
  }
});

// ---------------------------------------------------------------------------
// GET /:name/versions/:version/files — List / read files
// ---------------------------------------------------------------------------
router.get('/:name/versions/:version/files', async (req, res) => {
  try {
    const { name } = req.params;
    const version = parseInt(req.params.version, 10);

    if (isNaN(version)) {
      return res
        .status(400)
        .json({ success: false, error: 'Version must be a number' });
    }

    const filePath = req.query.path as string | undefined;

    if (filePath) {
      // Read a specific file
      const { content, mimeType } = await projectService.readFile(
        name,
        version,
        filePath,
      );

      if (isTextMimeType(mimeType)) {
        return res.json({
          success: true,
          data: {
            path: filePath,
            content: content.toString('utf-8'),
            mimeType,
          },
        });
      }

      // Binary file — metadata only (no content)
      return res.json({
        success: true,
        data: {
          path: filePath,
          size: content.length,
          mimeType,
        },
      });
    }

    // No path query — list all files in the version
    const files = await projectService.listFiles(name, version);
    return res.json({ success: true, data: files });
  } catch (error) {
    if (
      error instanceof ProjectNotFoundError ||
      error instanceof VersionNotFoundError ||
      error instanceof PathSafetyError
    ) {
      return res.status(404).json({ success: false, error: error.message });
    }
    res.status(500).json({ success: false, error: String(error) });
  }
});

// ---------------------------------------------------------------------------
// POST /:name/versions/:version/approve — Mark version as approved
// ---------------------------------------------------------------------------
router.post('/:name/versions/:version/approve', async (req, res) => {
  try {
    const { name } = req.params;
    const version = parseInt(req.params.version, 10);

    if (isNaN(version)) {
      return res
        .status(400)
        .json({ success: false, error: 'Version must be a number' });
    }

    const meta = await projectService.readVersionMeta(name, version);
    const updatedMeta: VersionMeta & { approved?: boolean } = {
      ...meta,
      approved: true,
      updatedAt: new Date().toISOString(),
    };
    // Cast to VersionMeta — the extra `approved` field is serialised
    // to the JSON file and preserved across read/write cycles.
    await projectService.writeVersionMeta(
      name,
      version,
      updatedMeta as VersionMeta,
    );

    res.json({
      success: true,
      data: { projectName: name, version, approved: true },
    });
  } catch (error) {
    if (
      error instanceof ProjectNotFoundError ||
      error instanceof VersionNotFoundError
    ) {
      return res.status(404).json({ success: false, error: error.message });
    }
    res.status(500).json({ success: false, error: String(error) });
  }
});

// ---------------------------------------------------------------------------
// POST /:name/run — Start a new iteration run
// ---------------------------------------------------------------------------
router.post('/:name/run', async (req, res) => {
  try {
    const { name } = req.params;
    const { prompt } = req.body;

    // --- Validate input ---
    if (!prompt || typeof prompt !== 'string') {
      return res
        .status(400)
        .json({ success: false, error: 'Prompt is required' });
    }

    projectService.validateProjectName(name);

    const apiKey =
      process.env.OPENCODE_API_KEY || process.env.OPENAI_API_KEY || '';
    if (!apiKey) {
      return res
        .status(400)
        .json({
          success: false,
          error:
            'No API key found. Set OPENCODE_API_KEY or OPENAI_API_KEY.',
        });
    }

    // --- Atomically reserve the next version ---
    const version = await projectService.nextVersion(name);

    // --- Write initial VersionMeta ---
    const now = new Date().toISOString();
    const versionMeta: VersionMeta = {
      version: String(version),
      status: 'running',
      fileCount: 0,
      totalSize: 0,
      files: [],
      createdAt: now,
      updatedAt: now,
    };
    await projectService.writeVersionMeta(name, version, versionMeta);

    // --- Update / create ProjectMeta ---
    let projectMeta: ProjectMeta;
    try {
      projectMeta = await projectService.readProjectMeta(name);
    } catch {
      projectMeta = {
        projectName: name,
        currentVersion: version,
        createdAt: now,
        updatedAt: now,
      };
    }
    projectMeta.currentVersion = version;
    projectMeta.updatedAt = now;
    await projectService.writeProjectMeta(name, projectMeta);

    // --- Build inline workflow script from the prompt ---
    const escapedPrompt = escapeScriptValue(prompt);
    const script = [
      `phase('generate', () => {`,
      `  agent('generator', '${escapedPrompt}');`,
      `});`,
    ].join('\n');

    // --- Execute script in the sandbox ---
    const sandboxResult = await executeScript(script, {
      timeoutMs: 30000,
      memoryLimitMb: 128,
    });

    if (!sandboxResult.success || !sandboxResult.definition) {
      return res.status(400).json({
        success: false,
        error: sandboxResult.error || 'Failed to parse script',
        line: sandboxResult.line,
      });
    }

    // --- Validate the extracted workflow definition ---
    const validation = validateWorkflowDefinition(sandboxResult.definition);
    if (!validation.valid) {
      return res.status(400).json({
        success: false,
        error: 'Workflow validation failed',
        errors: validation.errors,
      });
    }

    // --- Create the workflow run in the DB ---
    const run = repo.createWorkflowRun(
      sandboxResult.definition,
      `Project: ${name} v${version}`,
    );

    // --- Set up output context (resolve to absolute path for Docker volume mount) ---
    const outputDir = path.resolve(projectService.resolveVersionDir(name, version));
    const executeOpts: WorkflowExecuteOptions = {
      projectName: name,
      version,
      outputDir,
    };

    // --- Create and register the runtime ---
    const runtime = new WorkflowRuntime(
      createAgentRunner(),
      StreamManager.getInstance(),
      projectService,
    );
    activeRuntimes.set(run.id, runtime);

    // --- Respond immediately with run metadata ---
    res.status(201).json({
      success: true,
      data: {
        projectName: name,
        version,
        workflowRunId: run.id,
        status: 'running',
      },
    });

    // --- Start execution asynchronously ---
    setImmediate(() => {
      runtime.execute(run.id, apiKey, executeOpts).catch((err: unknown) => {
        activeRuntimes.delete(run.id);
        repo.updateWorkflowStatus(run.id, 'failed');
        projectService
          .updateVersionStatus(name, version, 'failed', String(err))
          .catch(() => {});
        StreamManager.getInstance().emit(run.id, {
          type: 'workflow_failed',
          workflowId: run.id,
          timestamp: new Date().toISOString(),
          data: { error: String(err) },
        });
      });
    });
  } catch (error) {
    res.status(500).json({ success: false, error: String(error) });
  }
});

export default router;
