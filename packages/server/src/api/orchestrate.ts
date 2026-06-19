import { Router } from 'express';
import { orchestrate, OrchestratorLLMError, OrchestratorValidationError } from '../orchestrator/index.js';
import type { ApiResponse, WorkflowDefinition } from '@dynflow/shared';
import { definitionToDynamicScript } from '../workflow/script-migration.js';

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

    const script = definitionToDynamicScript(result.workflow);
    const estimatedAgentCalls = result.workflow.phases.reduce(
      (total, phase) => total + phase.agents.length,
      0,
    );
    const maxConcurrency = Math.max(
      1,
      ...result.workflow.phases.map((phase) => phase.maxConcurrency ?? 16),
    );
    res.json({
      success: true,
      data: result.workflow,
      script,
      estimates: {
        estimatedAgentCalls,
        maxConcurrency,
        writeStrategy: 'isolated-worktree',
      },
      rawResponse: result.rawResponse,
    } as ApiResponse<WorkflowDefinition> & {
      script: string;
      estimates: {
        estimatedAgentCalls: number;
        maxConcurrency: number;
        writeStrategy: string;
      };
      rawResponse: string;
    });
  } catch (error) {
    if (error instanceof OrchestratorLLMError) {
      return res.status(502).json({ success: false, error: error.message, statusCode: error.statusCode });
    }
    if (error instanceof OrchestratorValidationError) {
      return res.status(422).json({ success: false, error: error.message, validationErrors: error.validationErrors });
    }
    res.status(500).json({ success: false, error: String(error) });
  }
});

export default router;
