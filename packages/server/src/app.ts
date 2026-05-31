import express, { type Request, type Response, type NextFunction } from 'express'
import cors from 'cors'
import workflowCrudRoutes from './api/workflows.js'
import sseRoutes from './api/sse.js'
import workflowControlRoutes from './api/workflows-control.js'
import domainsRouter from './api/domains.js'
import agentSourcesRouter from './api/agent-sources.js'
import predefinedAgentsRouter from './api/predefined-agents.js'
import skillsRouter from './api/skills.js'
import orchestrateRouter from './api/orchestrate.js'
import metaRouter from './api/meta.js'
import templatesRouter from './api/templates.js'

export function createApp() {
  const app = express()
  app.use(cors())
  app.use(express.json({ limit: '1mb' }))

  app.get('/api/health', (_req, res) => {
    res.json({ status: 'ok', timestamp: new Date().toISOString() })
  })

  // Order matters:
  //   1. CRUD routes first  — POST /, GET /, GET /:id, DELETE /:id
  //   2. SSE  stream        — GET /:id/stream  (more specific than /:id)
  //   3. Control actions    — POST /:id/start, POST /:id/pause, …
  app.use('/api/workflows', workflowCrudRoutes)
  app.use('/api/workflows', sseRoutes)
  app.use('/api/workflows', workflowControlRoutes)

  app.use('/api/domains', domainsRouter)
  app.use('/api/agent-sources', agentSourcesRouter)
  app.use('/api/predefined-agents', predefinedAgentsRouter)
  app.use('/api/skills', skillsRouter)
  app.use('/api/templates', templatesRouter)

  app.use('/api/orchestrate', orchestrateRouter)
  app.use('/api/meta', metaRouter)

  return app
}

/**
 * Global Express error handler middleware.
 * Must be registered AFTER all routes (typically in index.ts).
 */
export function errorHandler(
  err: unknown,
  _req: Request,
  res: Response,
  _next: NextFunction,
): void {
  console.error('Unhandled error:', err);
  res.status(500).json({
    success: false,
    error: err instanceof Error ? err.message : 'Internal server error',
  });
}
