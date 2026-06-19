import { Router } from 'express';
import type { WorkflowTemplate, ApiResponse, CreateTemplateRequest, UpdateTemplateRequest, ImportTemplateRequest } from '@dynflow/shared';
import * as templateRepo from '../db/template-repository.js';
import * as repo from '../db/repository.js';
import { getDb } from '../db/connection.js';
import { normalizeWorkflowScript } from '../workflow/script-migration.js';

const router = Router();

// GET / — List templates (paginated, optional ?tag= filter)
router.get('/', (req, res) => {
  const page = Math.max(1, parseInt(req.query.page as string) || 1);
  const pageSize = Math.min(100, Math.max(1, parseInt(req.query.pageSize as string) || 20));
  const tag = req.query.tag as string | undefined;
  const { items, total } = templateRepo.getTemplates(page, pageSize, tag);
  res.json({ success: true, data: items, page, pageSize, total });
});

// POST / — Create template
router.post('/', (req, res) => {
  try {
    const { name, description, script, tags } = req.body;

    // Validate required fields
    if (!name || typeof name !== 'string' || name.trim().length === 0) {
      return res.status(400).json({ success: false, error: 'Name is required' });
    }
    if (!script || typeof script !== 'string' || script.trim().length === 0) {
      return res.status(400).json({ success: false, error: 'Script is required' });
    }

    // Validate optional fields
    if (description !== undefined && typeof description !== 'string') {
      return res.status(400).json({ success: false, error: 'Description must be a string' });
    }
    if (tags !== undefined && (!Array.isArray(tags) || !tags.every((t: unknown) => typeof t === 'string'))) {
      return res.status(400).json({ success: false, error: 'Tags must be an array of strings' });
    }

    const data: CreateTemplateRequest = {
      name: name.trim(),
      description: description?.trim(),
      script,
      tags,
    };

    const template = templateRepo.createTemplate(data);

    // Auto-create version 1
    try {
      templateRepo.createVersion(template.id, {
        script: template.script,
        name: template.name,
        description: template.description,
      });
    } catch {
      // Version creation failure should not block template creation
    }

    res.status(201).json({ success: true, data: template } as ApiResponse<WorkflowTemplate>);
  } catch (error) {
    res.status(500).json({ success: false, error: String(error) });
  }
});

// POST /import — Import template from .ts file content
router.post('/import', (req, res) => {
  try {
    const { content } = req.body as ImportTemplateRequest;

    if (!content || typeof content !== 'string' || content.trim().length === 0) {
      return res.status(400).json({ success: false, error: 'Content is required' });
    }

    // Parse header comments to extract metadata
    const lines = content.split('\n');
    let name = '';
    let description = '';
    let lastHeaderIndex = -1;

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const trimmed = line.trim();

      if (trimmed.startsWith('//')) {
        const nameMatch = line.match(/^\/\/\s*Name:\s*(.+)$/);
        const descMatch = line.match(/^\/\/\s*Description:\s*(.+)$/);

        if (nameMatch) {
          name = nameMatch[1].trim();
        } else if (descMatch) {
          description = descMatch[1].trim();
        }

        lastHeaderIndex = i;
      } else {
        break;
      }
    }

    if (!name) {
      name = 'Imported Template';
    }

    // Extract script: everything after the last header line
    const script = lines.slice(lastHeaderIndex + 1).join('\n').trim();

    if (script.length === 0) {
      return res.status(400).json({ success: false, error: 'No script content found in the file' });
    }

    const data: CreateTemplateRequest = {
      name,
      description: description || undefined,
      script,
    };

    const template = templateRepo.createTemplate(data);

    // Auto-create version 1
    try {
      templateRepo.createVersion(template.id, {
        script: template.script,
        name: template.name,
        description: template.description,
      });
    } catch {
      // Version creation failure should not block template creation
    }

    res.status(201).json({ success: true, data: template } as ApiResponse<WorkflowTemplate>);
  } catch (error) {
    res.status(500).json({ success: false, error: String(error) });
  }
});

// GET /used-in-workflows — Templates sorted by how many workflow runs reference each
router.get('/used-in-workflows', (_req, res) => {
  const rows = getDb()
    .prepare(
      `SELECT t.id, t.name, t.description, COUNT(w.id) as workflowCount
       FROM workflow_templates t
       INNER JOIN workflow_runs w ON w.template_id = t.id
       WHERE t.deleted_at IS NULL
       GROUP BY t.id, t.name, t.description
       ORDER BY workflowCount DESC, t.name ASC`,
    )
    .all();
  res.json({ success: true, data: rows });
});

// GET /:id — Get template by ID
router.get('/:id', (req, res) => {
  const template = templateRepo.getTemplate(req.params.id);
  if (!template) {
    return res.status(404).json({ success: false, error: 'Template not found' });
  }
  res.json({ success: true, data: template } as ApiResponse<WorkflowTemplate>);
});

// POST /:id/export — Export template as .ts file content
router.post('/:id/export', (req, res) => {
  try {
    const template = templateRepo.getTemplate(req.params.id);
    if (!template) {
      return res.status(404).json({ success: false, error: 'Template not found' });
    }

    // Generate .ts file content with header comments
    const content = [
      '// DynFlow Workflow Template',
      `// Name: ${template.name}`,
      `// Description: ${template.description || ''}`,
      `// Version: ${template.currentVersion}`,
      `// Exported at: ${new Date().toISOString()}`,
      '',
      template.script,
    ].join('\n');

    // Generate a safe filename from the template name
    const filename = template.name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '') + '.ts';

    res.json({
      success: true,
      data: { content, filename },
    });
  } catch (error) {
    res.status(500).json({ success: false, error: String(error) });
  }
});

// PUT /:id — Update template fields
router.put('/:id', (req, res) => {
  try {
    const { name, description, script, tags } = req.body;

    // Validate at least one field is provided
    if (name === undefined && description === undefined && script === undefined && tags === undefined) {
      return res.status(400).json({ success: false, error: 'At least one field (name, description, script, tags) must be provided' });
    }

    // Validate individual fields if present
    if (name !== undefined && (typeof name !== 'string' || name.trim().length === 0)) {
      return res.status(400).json({ success: false, error: 'Name must be a non-empty string' });
    }
    if (description !== undefined && typeof description !== 'string') {
      return res.status(400).json({ success: false, error: 'Description must be a string' });
    }
    if (script !== undefined && (typeof script !== 'string' || script.trim().length === 0)) {
      return res.status(400).json({ success: false, error: 'Script must be a non-empty string' });
    }
    if (tags !== undefined && (!Array.isArray(tags) || !tags.every((t: unknown) => typeof t === 'string'))) {
      return res.status(400).json({ success: false, error: 'Tags must be an array of strings' });
    }

    // Get existing template before update (for script comparison)
    const existing = templateRepo.getTemplate(req.params.id);
    if (!existing) {
      return res.status(404).json({ success: false, error: 'Template not found' });
    }

    const data: UpdateTemplateRequest = {};
    if (name !== undefined) data.name = name.trim();
    if (description !== undefined) data.description = description?.trim();
    if (script !== undefined) data.script = script;
    if (tags !== undefined) data.tags = tags;

    const updatedTemplate = templateRepo.updateTemplate(req.params.id, data);
    if (!updatedTemplate) {
      return res.status(404).json({ success: false, error: 'Template not found' });
    }

    // Auto-create version if script changed
    if (script !== undefined && script !== existing.script) {
      try {
        templateRepo.createVersion(req.params.id, {
          script,
          name: updatedTemplate.name,
          description: updatedTemplate.description,
        });
        // Re-fetch to get updated currentVersion
        const refreshed = templateRepo.getTemplate(req.params.id);
        if (refreshed) {
          return res.json({ success: true, data: refreshed } as ApiResponse<WorkflowTemplate>);
        }
      } catch {
        // Version creation failure should not block template update
      }
    }

    res.json({ success: true, data: updatedTemplate } as ApiResponse<WorkflowTemplate>);
  } catch (error) {
    res.status(500).json({ success: false, error: String(error) });
  }
});

// DELETE /:id — Delete template
router.delete('/:id', (req, res) => {
  const existing = templateRepo.getTemplate(req.params.id);
  if (!existing) {
    return res.status(404).json({ success: false, error: 'Template not found' });
  }
  templateRepo.deleteTemplate(req.params.id);
  res.status(204).send();
});

// ===== Version Control Endpoints =====

// GET /:id/versions — List all versions for a template
router.get('/:id/versions', (req, res) => {
  const template = templateRepo.getTemplate(req.params.id);
  if (!template) {
    return res.status(404).json({ success: false, error: 'Template not found' });
  }
  const versions = templateRepo.getVersions(req.params.id);
  res.json({ success: true, data: versions });
});

// GET /:id/versions/compare — Compare two versions
router.get('/:id/versions/compare', (req, res) => {
  const template = templateRepo.getTemplate(req.params.id);
  if (!template) {
    return res.status(404).json({ success: false, error: 'Template not found' });
  }

  const fromVersion = parseInt(req.query.from as string, 10);
  const toVersion = parseInt(req.query.to as string, 10);

  if (isNaN(fromVersion) || isNaN(toVersion)) {
    return res.status(400).json({
      success: false,
      error: 'Both from and to query parameters are required and must be valid version numbers',
    });
  }

  const versions = templateRepo.getVersions(req.params.id);
  const from = versions.find((v) => v.version === fromVersion);
  const to = versions.find((v) => v.version === toVersion);

  if (!from) {
    return res.status(404).json({ success: false, error: `Version ${fromVersion} not found` });
  }
  if (!to) {
    return res.status(404).json({ success: false, error: `Version ${toVersion} not found` });
  }

  // Simple line-by-line diff using Set
  const fromLines = from.script.split('\n');
  const toLines = to.script.split('\n');
  const fromSet = new Set(fromLines);
  const toSet = new Set(toLines);

  const added = toLines.filter((line) => !fromSet.has(line));
  const removed = fromLines.filter((line) => !toSet.has(line));

  res.json({
    success: true,
    data: {
      from: { version: from.version, name: from.name },
      to: { version: to.version, name: to.name },
      added,
      removed,
    },
  });
});

// POST /:id/rollback — Rollback to a specific version
router.post('/:id/rollback', (req, res) => {
  try {
    const template = templateRepo.getTemplate(req.params.id);
    if (!template) {
      return res.status(404).json({ success: false, error: 'Template not found' });
    }

    const targetVersion = parseInt(req.body.version, 10);
    if (isNaN(targetVersion)) {
      return res.status(400).json({ success: false, error: 'Version number is required and must be a number' });
    }

    const versions = templateRepo.getVersions(req.params.id);
    const target = versions.find((v) => v.version === targetVersion);
    if (!target) {
      return res.status(404).json({ success: false, error: `Version ${targetVersion} not found` });
    }

    const newVersion = templateRepo.createVersion(req.params.id, {
      script: target.script,
      name: target.name,
      description: target.description,
    });

    // Update the template script to match the rolled-back version
    templateRepo.updateTemplate(req.params.id, { script: target.script });

    res.json({ success: true, data: newVersion });
  } catch (error) {
    res.status(500).json({ success: false, error: String(error) });
  }
});

// POST /:id/run — Create a workflow run from this template
router.post('/:id/run', async (req, res) => {
  try {
    const template = templateRepo.getTemplate(req.params.id);
    if (!template) {
      return res.status(404).json({ success: false, error: 'Template not found' });
    }

    const result = await normalizeWorkflowScript(template.script, template.name);
    if (!result.success) {
      return res.status(400).json({
        success: false,
        error: result.error,
        line: result.line,
      });
    }

    // Create the workflow run, linking it back to the source template +
    // its current version so the connection survives in the DB and can be
    // surfaced in the UI (see WorkflowDetail "Source: ... v<n>" pill).
    const run = repo.createWorkflowRun(result.definition, template.name, {
      templateId: template.id,
      templateVersion: template.currentVersion,
      script: template.script,
      executionModel: 'dynamic',
    });
    return res.status(201).json({ success: true, data: run });
  } catch (error) {
    return res.status(500).json({ success: false, error: String(error) });
  }
});

export default router;
