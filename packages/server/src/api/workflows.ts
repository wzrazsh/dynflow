import { Router } from 'express';
import type { WorkflowRun, ApiResponse, WorkflowListResponse, WorkflowListFilters, WorkflowStatus } from '@dynflow/shared';
import { RuntimeConfigSchema } from '@dynflow/shared';
import { executeScript } from '../sandbox/isolated-runtime.js';
import * as repo from '../db/repository.js';

const router = Router();

// POST /api/workflows — Create workflow from JS script
router.post('/', async (req, res) => {
  try {
    const { name, script, workspace, runtimeConfig } = req.body;
    if (!name || !script) {
      return res.status(400).json({ success: false, error: 'Name and script are required' });
    }

    // Run through sandbox
    const result = await executeScript(script, { timeoutMs: 30000, memoryLimitMb: 128 });
    if (!result.success) {
      return res.status(400).json({ success: false, error: result.error, details: { line: result.line } });
    }

    // Merge workspace from the request body into the parsed definition.
    if (workspace && typeof workspace === 'object') {
      result.definition!.workspace = workspace;
    }

    // Validate extracted definition (now including workspace)
    const { validateWorkflowDefinition } = await import('@dynflow/shared');
    const validation = validateWorkflowDefinition(result.definition!);
    if (!validation.valid) {
      return res.status(400).json({ success: false, error: 'Validation failed', details: validation.errors });
    }

    // Validate optional runtimeConfig
    if (runtimeConfig !== undefined) {
      const parsed = RuntimeConfigSchema.safeParse(runtimeConfig);
      if (!parsed.success) {
        return res.status(400).json({
          success: false,
          error: 'Invalid runtime config',
          details: parsed.error.issues,
        });
      }
    }

    // Persist
    const workflowRun = repo.createWorkflowRun(result.definition!, name, {
      script,
      runtimeConfig: runtimeConfig !== undefined ? RuntimeConfigSchema.parse(runtimeConfig) : undefined,
    });
    res.status(201).json({ success: true, data: workflowRun } as ApiResponse<WorkflowRun>);
  } catch (error) {
    res.status(500).json({ success: false, error: String(error) });
  }
});

// GET /api/workflows — List workflows (paginated, filterable)
router.get('/', (req, res) => {
  const page = Math.max(1, parseInt(req.query.page as string) || 1);
  const pageSize = Math.min(50, Math.max(1, parseInt(req.query.pageSize as string) || 10));
  const filters: WorkflowListFilters = {};
  if (req.query.name) filters.name = req.query.name as string;
  if (req.query.status) filters.status = req.query.status as WorkflowStatus;
  if (req.query.templateId) filters.templateId = req.query.templateId as string;
  if (req.query.sinceDays) filters.sinceDays = parseInt(req.query.sinceDays as string);
  const { runs, total } = repo.listWorkflowRuns(page, pageSize, filters);
  res.json({ success: true, data: runs, page, pageSize, total } as WorkflowListResponse);
});

// GET /api/workflows/:id — Get workflow detail
router.get('/:id', (req, res) => {
  const run = repo.getWorkflowRun(req.params.id);
  if (!run) return res.status(404).json({ success: false, error: 'Workflow not found' });
  res.json({ success: true, data: run } as ApiResponse<WorkflowRun>);
});

// DELETE /api/workflows/:id — Delete (terminal states only)
router.delete('/:id', (req, res) => {
  const run = repo.getWorkflowRun(req.params.id);
  if (!run) return res.status(404).json({ success: false, error: 'Workflow not found' });
  if (run.status === 'running' || run.status === 'paused') {
    return res.status(409).json({ success: false, error: `Cannot delete ${run.status} workflow` });
  }
  repo.deleteWorkflowRun(req.params.id);
  res.json({ success: true });
});

export default router;
