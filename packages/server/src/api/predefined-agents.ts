import { Router } from 'express';
import type { ApiResponse, PredefinedAgent } from '@dynflow/shared';
import * as repo from '../db/repository.js';

const router = Router();

// GET / — List all predefined agents with pagination
router.get('/', (req, res) => {
  try {
    const page = Math.max(1, parseInt(req.query.page as string) || 1);
    const pageSize = Math.min(100, Math.max(1, parseInt(req.query.pageSize as string) || 20));
    const { agents, total } = repo.getPredefinedAgentsPaginated(page, pageSize);
    res.json({ success: true, data: agents, page, pageSize, total } as ApiResponse<PredefinedAgent[]> & { page: number; pageSize: number; total: number });
  } catch (error) {
    res.status(500).json({ success: false, error: String(error) });
  }
});

// POST / — Create predefined agent
router.post('/', (req, res) => {
  try {
    const { roleId, name, description, systemPrompt, availableSkills } = req.body;
    if (!roleId || !name || !description || !systemPrompt) {
      return res.status(400).json({ success: false, error: 'roleId, name, description, and systemPrompt are required' });
    }
    const agent = repo.createPredefinedAgent({
      roleId,
      name,
      description,
      systemPrompt,
      availableSkills,
    });
    res.status(201).json({ success: true, data: agent } as ApiResponse<PredefinedAgent>);
  } catch (error) {
    res.status(500).json({ success: false, error: String(error) });
  }
});

// GET /:id — Get predefined agent by ID
router.get('/:id', (req, res) => {
  try {
    const agent = repo.getPredefinedAgent(req.params.id);
    if (!agent) {
      return res.status(404).json({ success: false, error: 'Predefined agent not found' });
    }
    res.json({ success: true, data: agent } as ApiResponse<PredefinedAgent>);
  } catch (error) {
    res.status(500).json({ success: false, error: String(error) });
  }
});

// DELETE /:id — Delete predefined agent
router.delete('/:id', (req, res) => {
  try {
    const agent = repo.getPredefinedAgent(req.params.id);
    if (!agent) {
      return res.status(404).json({ success: false, error: 'Predefined agent not found' });
    }
    repo.deletePredefinedAgent(req.params.id);
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ success: false, error: String(error) });
  }
});

// GET /roles/:id/agents — List predefined agents for a role
// When mounted at /api/predefined-agents, full path is /api/predefined-agents/roles/:id/agents
router.get('/roles/:id/agents', (req, res) => {
  try {
    const agents = repo.getAgentsByRole(req.params.id);
    res.json({ success: true, data: agents } as ApiResponse<PredefinedAgent[]>);
  } catch (error) {
    res.status(500).json({ success: false, error: String(error) });
  }
});

export default router;
