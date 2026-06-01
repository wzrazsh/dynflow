import { Router } from 'express';
import { orchestrate, OrchestratorLLMError, OrchestratorValidationError } from '../orchestrator/index.js';
import type { Domain, AgentSource, AgentRole, PredefinedAgent, Skill, ApiResponse, WorkflowDefinition } from '@dynflow/shared';

const router = Router();

// POST /api/orchestrate — Design a workflow from natural language
router.post('/', async (req, res) => {
  try {
    const { userRequest, domains, sources, roles, agents, skills, apiKey, baseUrl, model, maxChoicesPerCategory } = req.body;

    if (!userRequest) {
      return res.status(400).json({ success: false, error: 'userRequest is required' });
    }

    const result = await orchestrate({
      userRequest,
      domains: domains || [],
      sources: sources || [],
      roles: roles || [],
      agents: agents || [],
      skills: skills || [],
      apiKey,
      baseUrl,
      model,
      maxChoicesPerCategory,
    });

    res.json({ success: true, data: result.workflow, rawResponse: result.rawResponse } as ApiResponse<WorkflowDefinition> & { rawResponse: string });
  } catch (error) {
    if (error instanceof OrchestratorLLMError) {
      return res.status(502).json({ success: false, error: error.message, statusCode: error.statusCode });
    }
    if (error instanceof OrchestratorValidationError) {
      return res.status(422).json({ success: false, error: error.message, validationErrors: (error as any).validationErrors });
    }
    res.status(500).json({ success: false, error: String(error) });
  }
});

export default router;
