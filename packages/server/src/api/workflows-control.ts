import { Router } from 'express';
import * as repo from '../db/repository.js';
import * as templateRepo from '../db/template-repository.js';
import { WorkflowFSM } from '../workflow/state-machine.js';
import { WorkflowRuntime } from '../workflow/runtime.js';
import type { WorkflowExecuteOptions } from '../workflow/runtime.js';
import { ProjectService } from '../project/project-service.js';
import { createAgentRunner } from '../runner/index.js';
import { StreamManager } from '../sse/stream-manager.js';
import type { RuntimeConfig } from '@dynflow/shared';
import { RuntimeConfigSchema } from '@dynflow/shared';
import { CuaAgentRunner } from '../runner/cua-runner.js';
import { CuaPiRunner } from '../runner/cua-pi-runner.js';
import { PiDirectRunner } from '../runner/pi-direct-runner.js';
import { PiCuaNativeRunner } from '../runner/pi-cua-native-runner.js';
import { DockerAgentRunner } from '../runner/docker-runner.js';
import { WslDockerAgentRunner } from '../runner/wsl-docker-runner.js';

const router = Router();

// ---------------------------------------------------------------------------
// In-memory registry of active runtime instances (for stop/abort)
// ---------------------------------------------------------------------------
const activeRuntimes = new Map<string, WorkflowRuntime>();

// ---------------------------------------------------------------------------
// ProjectService singleton for output directory management
// ---------------------------------------------------------------------------
const projectService = new ProjectService();

/**
 * Check if a runner ID is available on this server.
 */
function isRunnerAvailable(runnerId: string): boolean {
  switch (runnerId) {
    case 'cua': return CuaAgentRunner.isAvailable();
    case 'cua-pi': return CuaPiRunner.isAvailable();
    case 'pi-cua-native': return PiCuaNativeRunner.isAvailable();
    case 'pi-direct': return PiDirectRunner.isAvailable();
    case 'docker': return DockerAgentRunner.isAvailable() || WslDockerAgentRunner.isAvailable();
    default: return false;
  }
}

/**
 * Resolve the API key based on the requested LLM provider.
 * When provider is specified, returns its key or null (fail fast, no silent fallback).
 * When provider is undefined, falls back through OPENCODE -> OPENAI -> ANTHROPIC.
 */
function resolveApiKey(provider?: string): string | null {
  const envMap: Record<string, string | undefined> = {
    opencode: process.env.OPENCODE_API_KEY,
    openai: process.env.OPENAI_API_KEY,
    anthropic: process.env.ANTHROPIC_API_KEY,
  };

  if (provider) {
    const key = envMap[provider];
    if (!key) return null; // Fail fast — don't fall back to a different provider
    return key;
  }

  // No provider specified — fallback chain
  return envMap.opencode || envMap.openai || envMap.anthropic || null;
}

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

  // Validate optional runtimeConfig override
  let overrideConfig: RuntimeConfig | undefined;
  if (req.body?.runtimeConfig !== undefined) {
    const parsed = RuntimeConfigSchema.safeParse(req.body.runtimeConfig);
    if (!parsed.success) {
      return res.status(400).json({ success: false, error: 'Invalid runtime config', details: parsed.error.issues });
    }
    if (parsed.data.runner && !isRunnerAvailable(parsed.data.runner)) {
      return res.status(400).json({ success: false, error: `Runner '${parsed.data.runner}' is not available on this server.` });
    }
    overrideConfig = parsed.data;
    // Persist the override
    repo.updateWorkflowRun(run.id, { runtimeConfig: parsed.data });
  }

  // Resolve API key with provider awareness
  const apiKey = resolveApiKey(overrideConfig?.llmProvider);
  if (!apiKey) {
    const missing = overrideConfig?.llmProvider 
      ? `${overrideConfig.llmProvider.toUpperCase()}_API_KEY is not set`
      : 'No API key found. Set OPENCODE_API_KEY, OPENAI_API_KEY, or ANTHROPIC_API_KEY.';
    return res.status(400).json({ success: false, error: missing });
  }

  // Atomically claim the workflow — ensures only one caller transitions
  // from 'pending' to 'running', preventing race conditions on concurrent
  // start requests.
  const claimed = repo.transitionWorkflowStatus(run.id, 'pending', 'running');
  if (!claimed) {
    return res.status(409).json({ success: false, error: 'Workflow is already running or in an invalid state.' });
  }

  const runtime = new WorkflowRuntime(
    createAgentRunner(overrideConfig),
    StreamManager.getInstance(),
    projectService,
  );
  activeRuntimes.set(req.params.id, runtime);

  // Extract optional project context from the request body
  // Use optional chaining to handle requests with no body/payload
  const executeOpts: WorkflowExecuteOptions = {};
  if (req.body?.projectName) executeOpts.projectName = req.body.projectName;
  if (req.body?.version !== undefined) executeOpts.version = req.body.version;
  if (req.body?.outputDir) executeOpts.outputDir = req.body.outputDir;
  const optsToPass = Object.keys(executeOpts).length > 0 ? executeOpts : undefined;

  // Respond immediately, then start execution asynchronously
  res.json({ success: true, data: { status: 'running' } });

  setImmediate(async () => {
    try {
      await runtime.execute(run.id, apiKey, optsToPass);
    } catch (err: unknown) {
      repo.updateWorkflowStatus(run.id, 'failed');
      StreamManager.getInstance().emit(run.id, {
        type: 'workflow_failed',
        workflowId: run.id,
        timestamp: new Date().toISOString(),
        data: { error: String(err) },
      });
    } finally {
      activeRuntimes.delete(run.id);
    }
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

  // Atomically transition from 'running' to 'paused'
  const claimed = repo.transitionWorkflowStatus(run.id, 'running', 'paused');
  if (!claimed) {
    return res.status(409).json({ success: false, error: 'Workflow is not in a running state.' });
  }
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

  // Check for runtime config override on resume
  let resumeOverrideConfig: RuntimeConfig | undefined;
  if (req.body?.runtimeConfig !== undefined) {
    const parsed = RuntimeConfigSchema.safeParse(req.body.runtimeConfig);
    if (!parsed.success) {
      return res.status(400).json({ success: false, error: 'Invalid runtime config', details: parsed.error.issues });
    }
    if (parsed.data.runner && !isRunnerAvailable(parsed.data.runner)) {
      return res.status(400).json({ success: false, error: `Runner '${parsed.data.runner}' is not available on this server.` });
    }
    resumeOverrideConfig = parsed.data;
    repo.updateWorkflowRun(run.id, { runtimeConfig: parsed.data });
  }

  // Resolve API key with provider awareness
  const apiKey = resolveApiKey(resumeOverrideConfig?.llmProvider);
  if (!apiKey) {
    const missing = resumeOverrideConfig?.llmProvider 
      ? `${resumeOverrideConfig.llmProvider.toUpperCase()}_API_KEY is not set`
      : 'No API key found. Set OPENCODE_API_KEY, OPENAI_API_KEY, or ANTHROPIC_API_KEY.';
    return res.status(400).json({ success: false, error: missing });
  }

  // Remove stale runtime if present (from the original start before pause)
  const stale = activeRuntimes.get(run.id);
  if (stale) {
    stale.abort();
    activeRuntimes.delete(run.id);
  }

  // Atomically transition from 'paused' to 'running'
  const claimed = repo.transitionWorkflowStatus(run.id, 'paused', 'running');
  if (!claimed) {
    return res.status(409).json({ success: false, error: 'Workflow is not in a paused state.' });
  }

  // Respond immediately, then start execution in the next tick
  res.json({ success: true, data: { status: 'running' } });

  const runtime = new WorkflowRuntime(
    createAgentRunner(resumeOverrideConfig),
    StreamManager.getInstance(),
    projectService,
  );
  activeRuntimes.set(run.id, runtime);

  // Extract optional project context from the request body
  // Use optional chaining to handle requests with no body/payload
  const executeOpts: WorkflowExecuteOptions = {};
  if (req.body?.projectName) executeOpts.projectName = req.body.projectName;
  if (req.body?.version !== undefined) executeOpts.version = req.body.version;
  if (req.body?.outputDir) executeOpts.outputDir = req.body.outputDir;
  const optsToPass = Object.keys(executeOpts).length > 0 ? executeOpts : undefined;

  setImmediate(async () => {
    try {
      await runtime.execute(run.id, apiKey, optsToPass);
    } catch (err: unknown) {
      repo.updateWorkflowStatus(run.id, 'failed');
      StreamManager.getInstance().emit(run.id, {
        type: 'workflow_failed',
        workflowId: run.id,
        timestamp: new Date().toISOString(),
        data: { error: String(err) },
      });
    } finally {
      activeRuntimes.delete(run.id);
    }
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

  // Atomically transition from 'running' or 'paused' to 'stopped'
  const claimed = repo.transitionWorkflowStatus(run.id, 'running', 'stopped')
    || repo.transitionWorkflowStatus(run.id, 'paused', 'stopped');
  if (!claimed) {
    return res.status(409).json({ success: false, error: 'Workflow is not running or paused.' });
  }

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

export { activeRuntimes };
export default router;
