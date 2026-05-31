import { Router } from 'express';
import type { ApiResponse, Domain, AgentSource } from '@dynflow/shared';

const router = Router();

// GET / — List all domains
router.get('/', (_req, res) => {
  res.json({ success: true, data: [] } as ApiResponse<Domain[]>);
});

// POST / — Create domain
router.post('/', (req, res) => {
  try {
    const { name, description, icon } = req.body;
    if (!name || !description) {
      return res.status(400).json({ success: false, error: 'Name and description are required' });
    }
    const domain: Domain = {
      id: `domain_${Date.now()}`,
      name,
      description,
      icon,
    };
    res.status(201).json({ success: true, data: domain } as ApiResponse<Domain>);
  } catch (error) {
    res.status(500).json({ success: false, error: String(error) });
  }
});

// GET /:id — Get domain by ID
router.get('/:id', (req, res) => {
  if (!req.params.id) {
    return res.status(404).json({ success: false, error: 'Domain not found' });
  }
  const domain: Domain = {
    id: req.params.id,
    name: 'Sample Domain',
    description: 'Placeholder domain',
  };
  res.json({ success: true, data: domain } as ApiResponse<Domain>);
});

// DELETE /:id — Delete domain
router.delete('/:id', (req, res) => {
  if (!req.params.id) {
    return res.status(404).json({ success: false, error: 'Domain not found' });
  }
  res.json({ success: true });
});

// GET /:id/agent-sources — List agent sources for a domain
router.get('/:id/agent-sources', (req, res) => {
  if (!req.params.id) {
    return res.status(404).json({ success: false, error: 'Domain not found' });
  }
  res.json({ success: true, data: [] } as ApiResponse<AgentSource[]>);
});

export default router;
