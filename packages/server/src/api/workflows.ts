import { Router } from 'express';
import type { WorkflowRun, ApiResponse, WorkflowListResponse, WorkflowListFilters, WorkflowStatus } from '@dynflow/shared';
import { RuntimeConfigSchema } from '@dynflow/shared';
import { normalizeWorkflowScript } from '../workflow/script-migration.js';
import * as repo from '../db/repository.js';

const router = Router();

// POST /api/workflows — Create workflow from JS script
router.post('/', async (req, res) => {
  try {
    const { name, script, workspace, runtimeConfig, projectName } = req.body;
    if (!name || !script) {
      return res.status(400).json({ success: false, error: 'Name and script are required' });
    }

    const normalized = await normalizeWorkflowScript(script, name);
    if (!normalized.success) {
      return res.status(400).json({
        success: false,
        error: normalized.error,
        details: { line: normalized.line },
      });
    }

    if (
      workspace !== undefined &&
      (!workspace ||
        typeof workspace !== 'object' ||
        (typeof workspace.path !== 'string' &&
          typeof workspace.git !== 'string'))
    ) {
      return res.status(400).json({
        success: false,
        error: 'workspace must specify path or git',
      });
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
    const definition = {
      ...normalized.definition,
      name,
      ...(workspace ? { workspace } : {}),
    };
    const workflowRun = repo.createWorkflowRun(definition, name, {
      script,
      executionModel: 'dynamic',
      runtimeConfig: runtimeConfig !== undefined ? RuntimeConfigSchema.parse(runtimeConfig) : undefined,
      projectName: projectName || undefined,
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
  if (req.query.projectName) filters.projectName = req.query.projectName as string;
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
