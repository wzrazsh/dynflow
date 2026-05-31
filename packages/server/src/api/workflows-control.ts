import { Router } from 'express';
import * as repo from '../db/repository.js';
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

export default router;
