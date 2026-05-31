import { Router } from 'express';
import type { ApiResponse, PredefinedAgent } from '@dynflow/shared';

const router = Router();

// GET / — List all predefined agents
router.get('/', (_req, res) => {
  res.json({ success: true, data: [] } as ApiResponse<PredefinedAgent[]>);
});

// POST / — Create predefined agent
router.post('/', (req, res) => {
  try {
    const { roleId, name, description, systemPrompt, availableSkills } = req.body;
    if (!roleId || !name || !description || !systemPrompt) {
      return res.status(400).json({ success: false, error: 'roleId, name, description, and systemPrompt are required' });
    }
    const agent: PredefinedAgent = {
      id: `agent_${Date.now()}`,
      roleId,
      name,
      description,
      systemPrompt,
      availableSkills: availableSkills || [],
    };
    res.status(201).json({ success: true, data: agent } as ApiResponse<PredefinedAgent>);
  } catch (error) {
    res.status(500).json({ success: false, error: String(error) });
  }
});

// GET /:id — Get predefined agent by ID
router.get('/:id', (req, res) => {
  if (!req.params.id) {
    return res.status(404).json({ success: false, error: 'Predefined agent not found' });
  }
  const agent: PredefinedAgent = {
    id: req.params.id,
    roleId: 'role_placeholder',
    name: 'Sample Agent',
    description: 'Placeholder predefined agent',
    systemPrompt: 'You are a helpful assistant.',
    availableSkills: [],
  };
  res.json({ success: true, data: agent } as ApiResponse<PredefinedAgent>);
});

// DELETE /:id — Delete predefined agent
router.delete('/:id', (req, res) => {
  if (!req.params.id) {
    return res.status(404).json({ success: false, error: 'Predefined agent not found' });
  }
  res.json({ success: true });
});

// GET /roles/:id/agents — List predefined agents for a role
// When mounted at /api/predefined-agents, full path is /api/predefined-agents/roles/:id/agents
router.get('/roles/:id/agents', (req, res) => {
  if (!req.params.id) {
    return res.status(404).json({ success: false, error: 'Role not found' });
  }
  res.json({ success: true, data: [] } as ApiResponse<PredefinedAgent[]>);
});

export default router;
