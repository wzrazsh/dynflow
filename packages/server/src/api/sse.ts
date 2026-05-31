import { Router } from 'express';
import { StreamManager } from '../sse/stream-manager.js';
import * as repo from '../db/repository.js';

const router = Router();

router.get('/:id/stream', (req, res) => {
  const run = repo.getWorkflowRun(req.params.id);

  // Set SSE headers
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  const streamManager = StreamManager.getInstance();
  const clientId = streamManager.addClient(req.params.id, res);

  // Send initial status event
  if (run) {
    res.write(`event: workflow_status\ndata: ${JSON.stringify({ workflowId: run.id, status: run.status })}\n\n`);
  }

  // Cleanup on disconnect
  req.on('close', () => {
    streamManager.removeClient(req.params.id, clientId);
  });
});

export default router;
