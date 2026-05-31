import { Router } from 'express';
import * as repo from '../db/repository.js';
import * as templateRepo from '../db/template-repository.js';
import { WorkflowFSM } from '../workflow/state-machine.js';
import { WorkflowRuntime } from '../workflow/runtime.js';
import { createAgentRunner } from '../runner/index.js';
import { StreamManager } from '../sse/stream-manager.js';
import type { WorkflowStatus } from '@dynflow/shared';

const router = Router();

// ---------------------------------------------------------------------------
// In-memory registry of active runtime instances (for stop/abort)
// ---------------------------------------------------------------------------
const activeRuntimes = new Map<string, WorkflowRuntime>();

// ---------------------------------------------------------------------------
// GET /:id — Retrieve a workflow run
// ---------------------------------------------------------------------------
router.get('/:id', (req, res) => {
  const run = repo.getWorkflowRun(req.params.id);
  if (!run) {
    return res
      .status(404)
      .json({ success: false, error: 'Workflow run not found' });
  }
  return res.json({ success: true, data: run });
});

// ---------------------------------------------------------------------------
// POST /:id/start — Start execution of a pending workflow
// ---------------------------------------------------------------------------
router.post('/:id/start', (req, res) => {
  const run = repo.getWorkflowRun(req.params.id);
  if (!run) {
    return res
      .status(404)
      .json({ success: false, error: 'Workflow run not found' });
  }

  const transition = WorkflowFSM.transition(run.status, 'start');
  if (!transition.allowed) {
    return res.status(409).json({ success: false, error: transition.error });
  }

  // Resolve API key before any side effects
  const apiKey = process.env.OPENCODE_API_KEY || process.env.OPENAI_API_KEY || '';
  if (!apiKey) {
    return res.status(400).json({ success: false, error: 'No API key found. Set OPENCODE_API_KEY or OPENAI_API_KEY.' });
  }

  const runtime = new WorkflowRuntime(
    createAgentRunner(),
    StreamManager.getInstance(),
  );
  activeRuntimes.set(req.params.id, runtime);

  // Respond immediately, then start execution asynchronously
  res.json({ success: true, data: { status: 'running' } });

  setImmediate(() => {
    runtime.execute(run.id, apiKey).catch((err: unknown) => {
      activeRuntimes.delete(run.id);
      repo.updateWorkflowStatus(run.id, 'failed');
      StreamManager.getInstance().emit(run.id, {
        type: 'workflow_failed',
        workflowId: run.id,
        timestamp: new Date().toISOString(),
        data: { error: String(err) },
      });
    });
  });
});

// ---------------------------------------------------------------------------
// POST /:id/pause — Pause a running workflow
// ---------------------------------------------------------------------------
router.post('/:id/pause', (req, res) => {
  const run = repo.getWorkflowRun(req.params.id);
  if (!run) {
    return res
      .status(404)
      .json({ success: false, error: 'Workflow run not found' });
  }

  const transition = WorkflowFSM.transition(run.status, 'pause');
  if (!transition.allowed) {
    return res.status(409).json({ success: false, error: transition.error });
  }

  repo.updateWorkflowStatus(run.id, 'paused');
  return res.json({ success: true, data: { status: 'paused' } });
});

// ---------------------------------------------------------------------------
// POST /:id/resume — Resume a paused workflow
// ---------------------------------------------------------------------------
router.post('/:id/resume', (req, res) => {
  const run = repo.getWorkflowRun(req.params.id);
  if (!run) {
    return res
      .status(404)
      .json({ success: false, error: 'Workflow run not found' });
  }

  const transition = WorkflowFSM.transition(run.status, 'resume');
  if (!transition.allowed) {
    return res.status(409).json({ success: false, error: transition.error });
  }

  // Resolve API key before any side effects
  const apiKey = process.env.OPENCODE_API_KEY || process.env.OPENAI_API_KEY || '';
  if (!apiKey) {
    return res.status(400).json({ success: false, error: 'No API key found. Set OPENCODE_API_KEY or OPENAI_API_KEY.' });
  }

  // Remove stale runtime if present (from the original start before pause)
  const stale = activeRuntimes.get(run.id);
  if (stale) {
    stale.abort();
    activeRuntimes.delete(run.id);
  }

  // Respond immediately, then start execution in the next tick
  repo.updateWorkflowStatus(run.id, 'running');
  res.json({ success: true, data: { status: 'running' } });

  const runtime = new WorkflowRuntime(
    createAgentRunner(),
    StreamManager.getInstance(),
  );
  activeRuntimes.set(run.id, runtime);

  setImmediate(() => {
    runtime.execute(run.id, apiKey).catch((err: unknown) => {
      activeRuntimes.delete(run.id);
      repo.updateWorkflowStatus(run.id, 'failed');
      StreamManager.getInstance().emit(run.id, {
        type: 'workflow_failed',
        workflowId: run.id,
        timestamp: new Date().toISOString(),
        data: { error: String(err) },
      });
    });
  });
});

// ---------------------------------------------------------------------------
// POST /:id/stop — Stop a running workflow (terminal)
// ---------------------------------------------------------------------------
router.post('/:id/stop', (req, res) => {
  const run = repo.getWorkflowRun(req.params.id);
  if (!run) {
    return res
      .status(404)
      .json({ success: false, error: 'Workflow run not found' });
  }

  // Accept 'stop' action from both 'running' and 'paused'
  const transition = WorkflowFSM.transition(run.status, 'stop');
  if (!transition.allowed) {
    return res.status(409).json({ success: false, error: transition.error });
  }

  repo.updateWorkflowStatus(run.id, 'stopped');

  // Abort active runtime instance if present
  const active = activeRuntimes.get(run.id);
  if (active) {
    active.abort();
    activeRuntimes.delete(run.id);
  }

  return res.json({ success: true, data: { status: 'stopped' } });
});

// ---------------------------------------------------------------------------
// POST /:id/clone — Clone a completed workflow run into a new template
// ---------------------------------------------------------------------------
router.post('/:id/clone', (req, res) => {
  const run = repo.getWorkflowRun(req.params.id);
  if (!run) {
    return res.status(404).json({ success: false, error: 'Workflow run not found' });
  }

  const { name, description, tags } = req.body;

  // Validate name
  if (!name || typeof name !== 'string' || name.trim().length === 0) {
    return res.status(400).json({ success: false, error: 'Name is required' });
  }

  // Validate optional fields
  if (description !== undefined && typeof description !== 'string') {
    return res.status(400).json({ success: false, error: 'Description must be a string' });
  }
  if (tags !== undefined && (!Array.isArray(tags) || !tags.every((t: unknown) => typeof t === 'string'))) {
    return res.status(400).json({ success: false, error: 'Tags must be an array of strings' });
  }

  // Construct a representative script from the workflow run's phases and agents
  const scriptLines: string[] = ['function main() {'];
  for (const phase of run.phases) {
    scriptLines.push(`  phase('${escapeScriptString(phase.name)}', () => {`);
    for (const agent of phase.agents) {
      const prompt = agent.prompt ? `'${escapeScriptString(agent.prompt)}'` : '';
      scriptLines.push(`    agent('${escapeScriptString(agent.name)}', ${prompt});`);
    }
    scriptLines.push('  });');
  }
  scriptLines.push('}');

  try {
    const template = templateRepo.createTemplate({
      name: name.trim(),
      description: description?.trim(),
      script: scriptLines.join('\n'),
      tags,
    });

    res.status(201).json({ success: true, data: template });
  } catch (error) {
    res.status(500).json({ success: false, error: String(error) });
  }
});

/**
 * Escape a string for use inside single quotes in a generated script.
 * Replaces backslashes, single quotes, and newlines with safe equivalents.
 */
function escapeScriptString(value: string): string {
  return value
    .replace(/\\/g, '\\\\')
    .replace(/'/g, "\\'")
    .replace(/\n/g, '\\n')
    .replace(/\r/g, '\\r');
}

export default router;
