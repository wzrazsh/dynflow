import { Router } from 'express';
import type { ApiResponse, AgentSource, AgentRole } from '@dynflow/shared';
import * as repo from '../db/repository.js';

const router = Router();

// GET / — List all agent sources with pagination
router.get('/', (req, res) => {
  try {
    const page = Math.max(1, parseInt(req.query.page as string) || 1);
    const pageSize = Math.min(100, Math.max(1, parseInt(req.query.pageSize as string) || 20));
    const { sources, total } = repo.getSourcesPaginated(page, pageSize);
    res.json({ success: true, data: sources, page, pageSize, total } as any);
  } catch (error) {
    res.status(500).json({ success: false, error: String(error) });
  }
});

// POST / — Create agent source
router.post('/', (req, res) => {
  try {
    const { domainId, name, url, description } = req.body;
    if (!domainId || !name || !url || !description) {
      return res.status(400).json({ success: false, error: 'domainId, name, url, and description are required' });
    }
    const source = repo.createAgentSource({ domainId, name, url, description });
    res.status(201).json({ success: true, data: source } as ApiResponse<AgentSource>);
  } catch (error) {
    res.status(500).json({ success: false, error: String(error) });
  }
});

// GET /:id — Get agent source by ID
router.get('/:id', (req, res) => {
  try {
    const source = repo.getAgentSource(req.params.id);
    if (!source) {
      return res.status(404).json({ success: false, error: 'Agent source not found' });
    }
    res.json({ success: true, data: source } as ApiResponse<AgentSource>);
  } catch (error) {
    res.status(500).json({ success: false, error: String(error) });
  }
});

// DELETE /:id — Delete agent source with check for roles
router.delete('/:id', (req, res) => {
  try {
    const source = repo.getAgentSource(req.params.id);
    if (!source) {
      return res.status(404).json({ success: false, error: 'Agent source not found' });
    }
    const roles = repo.getRolesBySource(req.params.id);
    if (roles.length > 0) {
      return res.status(409).json({
        success: false,
        error: `Cannot delete agent source with ${roles.length} attached role(s). Remove roles first.`,
      });
    }
    repo.deleteAgentSource(req.params.id);
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ success: false, error: String(error) });
  }
});

// GET /:id/roles — List roles for an agent source
router.get('/:id/roles', (req, res) => {
  try {
    const source = repo.getAgentSource(req.params.id);
    if (!source) {
      return res.status(404).json({ success: false, error: 'Agent source not found' });
    }
    const roles = repo.getRolesBySource(req.params.id);
    res.json({ success: true, data: roles } as ApiResponse<AgentRole[]>);
  } catch (error) {
    res.status(500).json({ success: false, error: String(error) });
  }
});

export default router;
