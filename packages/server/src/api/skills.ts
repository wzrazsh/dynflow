import { Router } from 'express';
import type { ApiResponse, Skill } from '@dynflow/shared';
import * as repo from '../db/repository.js';

const router = Router();

// GET / — List all skills with pagination and optional filtering
router.get('/', (req, res) => {
  try {
    const page = Math.max(1, parseInt(req.query.page as string) || 1);
    const pageSize = Math.min(100, Math.max(1, parseInt(req.query.pageSize as string) || 20));
    const sourceId = req.query.sourceId as string | undefined;
    const category = req.query.category as string | undefined;
    const { skills, total } = repo.getSkillsPaginated(page, pageSize, sourceId, category);
    res.json({ success: true, data: skills, page, pageSize, total } as any);
  } catch (error) {
    res.status(500).json({ success: false, error: String(error) });
  }
});

// POST / — Create skill
router.post('/', (req, res) => {
  try {
    const { sourceId, name, description, category, parameters, inputSchema, outputSchema } = req.body;
    if (!sourceId || !name || !description || !category || !parameters) {
      return res.status(400).json({ success: false, error: 'sourceId, name, description, category, and parameters are required' });
    }
    const skill: Skill = {
      id: `skill_${Date.now()}`,
      sourceId,
      name,
      description,
      category,
      parameters,
      inputSchema,
      outputSchema,
    };
    res.status(201).json({ success: true, data: skill } as ApiResponse<Skill>);
  } catch (error) {
    res.status(500).json({ success: false, error: String(error) });
  }
});

// GET /:id — Get skill by ID
router.get('/:id', (req, res) => {
  if (!req.params.id) {
    return res.status(404).json({ success: false, error: 'Skill not found' });
  }
  const skill: Skill = {
    id: req.params.id,
    sourceId: 'src_placeholder',
    name: 'Sample Skill',
    description: 'Placeholder skill',
    category: 'development',
    parameters: [],
  };
  res.json({ success: true, data: skill } as ApiResponse<Skill>);
});

// DELETE /:id — Delete skill
router.delete('/:id', (req, res) => {
  if (!req.params.id) {
    return res.status(404).json({ success: false, error: 'Skill not found' });
  }
  res.json({ success: true });
});

export default router;
