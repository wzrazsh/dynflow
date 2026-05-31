import { Router } from 'express';
import type { ApiResponse, Domain, AgentSource } from '@dynflow/shared';
import * as repo from '../db/repository.js';

const router = Router();

// GET / — List all domains with pagination
router.get('/', (req, res) => {
  try {
    const page = Math.max(1, parseInt(req.query.page as string) || 1);
    const pageSize = Math.min(100, Math.max(1, parseInt(req.query.pageSize as string) || 20));
    const { domains, total } = repo.getDomainsPaginated(page, pageSize);
    res.json({ success: true, data: domains, page, pageSize, total } as any);
  } catch (error) {
    res.status(500).json({ success: false, error: String(error) });
  }
});

// POST / — Create domain
router.post('/', (req, res) => {
  try {
    const { name, description, icon } = req.body;
    if (!name || !description) {
      return res.status(400).json({ success: false, error: 'Name and description are required' });
    }
    const domain = repo.createDomain({ name, description, icon });
    res.status(201).json({ success: true, data: domain } as ApiResponse<Domain>);
  } catch (error) {
    res.status(500).json({ success: false, error: String(error) });
  }
});

// GET /:id — Get domain by ID
router.get('/:id', (req, res) => {
  try {
    const domain = repo.getDomain(req.params.id);
    if (!domain) {
      return res.status(404).json({ success: false, error: 'Domain not found' });
    }
    res.json({ success: true, data: domain } as ApiResponse<Domain>);
  } catch (error) {
    res.status(500).json({ success: false, error: String(error) });
  }
});

// DELETE /:id — Delete domain
router.delete('/:id', (req, res) => {
  try {
    const domain = repo.getDomain(req.params.id);
    if (!domain) {
      return res.status(404).json({ success: false, error: 'Domain not found' });
    }
    repo.deleteDomain(req.params.id);
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ success: false, error: String(error) });
  }
});

// GET /:id/agent-sources — List agent sources for a domain
router.get('/:id/agent-sources', (req, res) => {
  try {
    const domain = repo.getDomain(req.params.id);
    if (!domain) {
      return res.status(404).json({ success: false, error: 'Domain not found' });
    }
    const sources = repo.getSourcesByDomain(req.params.id);
    res.json({ success: true, data: sources } as ApiResponse<AgentSource[]>);
  } catch (error) {
    res.status(500).json({ success: false, error: String(error) });
  }
});

export default router;
