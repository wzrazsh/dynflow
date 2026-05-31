import { Router } from 'express';
import type { ApiResponse, AgentSource, AgentRole } from '@dynflow/shared';

const router = Router();

// GET / — List all agent sources
router.get('/', (_req, res) => {
  res.json({ success: true, data: [] } as ApiResponse<AgentSource[]>);
});

// POST / — Create agent source
router.post('/', (req, res) => {
  try {
    const { domainId, name, url, description } = req.body;
    if (!domainId || !name || !url || !description) {
      return res.status(400).json({ success: false, error: 'domainId, name, url, and description are required' });
    }
    const source: AgentSource = {
      id: `src_${Date.now()}`,
      domainId,
      name,
      url,
      description,
    };
    res.status(201).json({ success: true, data: source } as ApiResponse<AgentSource>);
  } catch (error) {
    res.status(500).json({ success: false, error: String(error) });
  }
});

// GET /:id — Get agent source by ID
router.get('/:id', (req, res) => {
  if (!req.params.id) {
    return res.status(404).json({ success: false, error: 'Agent source not found' });
  }
  const source: AgentSource = {
    id: req.params.id,
    domainId: 'domain_placeholder',
    name: 'Sample Source',
    url: 'https://example.com',
    description: 'Placeholder agent source',
  };
  res.json({ success: true, data: source } as ApiResponse<AgentSource>);
});

// DELETE /:id — Delete agent source
// TODO: Check if any roles/agents are attached before allowing deletion
router.delete('/:id', (req, res) => {
  if (!req.params.id) {
    return res.status(404).json({ success: false, error: 'Agent source not found' });
  }
  res.json({ success: true });
});

// GET /:id/roles — List roles for an agent source
router.get('/:id/roles', (req, res) => {
  if (!req.params.id) {
    return res.status(404).json({ success: false, error: 'Agent source not found' });
  }
  res.json({ success: true, data: [] } as ApiResponse<AgentRole[]>);
});

export default router;
