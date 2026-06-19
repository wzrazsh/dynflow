import express, { type Request, type Response, type NextFunction } from 'express'
import cors from 'cors'
import { logger } from './logger.js'
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
import projectsRouter from './api/projects.js'
import systemRouter from './api/system.js'

export function createApp() {
  const app = express()
  const allowedOrigins = process.env.DYNFLOW_CORS_ORIGINS
    ? process.env.DYNFLOW_CORS_ORIGINS.split(',').map(s => s.trim())
    : ['http://localhost:15173', 'http://127.0.0.1:15173'];

  app.use(cors({
    origin: (origin, callback) => {
      if (!origin || allowedOrigins.includes(origin)) {
        callback(null, true);
      } else {
        callback(null, false);
      }
    },
  }))
  app.use(express.json({ limit: '10mb' }))

  app.get('/api/health', (_req, res) => {
    res.json({ status: 'ok', timestamp: new Date().toISOString() })
  })

  // Order matters:
  //   1. CRUD routes first  â€?POST /, GET /, GET /:id, DELETE /:id
  //   2. SSE  stream        â€?GET /:id/stream  (more specific than /:id)
  //   3. Control actions    â€?POST /:id/start, POST /:id/pause, â€?
  app.use('/api/workflows', workflowCrudRoutes)
  app.use('/api/workflows', sseRoutes)
  app.use('/api/workflows', workflowControlRoutes)

  app.use('/api/domains', domainsRouter)
  app.use('/api/agent-sources', agentSourcesRouter)
  app.use('/api/predefined-agents', predefinedAgentsRouter)
  app.use('/api/skills', skillsRouter)
  app.use('/api/templates', templatesRouter)
  app.use('/api/projects', projectsRouter)

  app.use('/api/orchestrate', orchestrateRouter)
  app.use('/api/meta', metaRouter)
  app.use('/api/system', systemRouter)

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
  logger.error('Unhandled error:', err);
  res.status(500).json({
    success: false,
    error: err instanceof Error ? err.message : 'Internal server error',
  });
}
