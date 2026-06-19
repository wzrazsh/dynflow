import { describe, it, expect } from 'vitest'
import request from 'supertest'
import { createApp, errorHandler } from './app.js'

describe('GET /api/health', () => {
  const app = createApp()

  it('returns 200 with status ok', async () => {
    const res = await request(app).get('/api/health')
    expect(res.status).toBe(200)
    expect(res.body.status).toBe('ok')
    expect(res.body.timestamp).toBeDefined()
  })

  it('returns JSON content type', async () => {
    const res = await request(app).get('/api/health')
    expect(res.headers['content-type']).toMatch(/application\/json/)
  })

  it('handles CORS headers', async () => {
    const res = await request(app)
      .get('/api/health')
      .set('Origin', 'http://localhost:15173')
    expect(res.headers['access-control-allow-origin']).toBeDefined()
  })

  it('rejects unlisted CORS origin', async () => {
    const res = await request(app)
      .get('/api/health')
      .set('Origin', 'http://evil.example')
    expect(res.headers['access-control-allow-origin']).toBeUndefined()
  })

  it('allows 127.0.0.1 CORS origin (default)', async () => {
    const res = await request(app)
      .get('/api/health')
      .set('Origin', 'http://127.0.0.1:15173')
    expect(res.headers['access-control-allow-origin']).toBe('http://127.0.0.1:15173')
  })

  it('allows custom origin when DYNFLOW_CORS_ORIGINS is set', async () => {
    const original = process.env.DYNFLOW_CORS_ORIGINS
    process.env.DYNFLOW_CORS_ORIGINS = 'http://custom.example:3000'
    try {
      const customApp = createApp()
      const res = await request(customApp)
        .get('/api/health')
        .set('Origin', 'http://custom.example:3000')
      expect(res.headers['access-control-allow-origin']).toBe('http://custom.example:3000')
    } finally {
      process.env.DYNFLOW_CORS_ORIGINS = original
    }
  })
})

describe('Global error handler', () => {
  it('returns 500 JSON for unhandled errors', async () => {
    const { Router } = await import('express')
    const app = createApp()
    const router = Router()
    router.get('/api/throw', () => {
      throw new Error('Test unhandled error')
    })
    app.use(router)
    app.use(errorHandler)

    const res = await request(app).get('/api/throw')
    expect(res.status).toBe(500)
    expect(res.body).toEqual({
      success: false,
      error: 'Test unhandled error',
    })
  })

  it('returns generic message for non-Error throws', async () => {
    const { Router } = await import('express')
    const app = createApp()
    const router = Router()
    router.get('/api/throw-string', () => {
      throw 'string error'
    })
    app.use(router)
    app.use(errorHandler)

    const res = await request(app).get('/api/throw-string')
    expect(res.status).toBe(500)
    expect(res.body).toEqual({
      success: false,
      error: 'Internal server error',
    })
  })

  it('does not interfere with normal routes', async () => {
    const app = createApp()
    app.use(errorHandler)
    const res = await request(app).get('/api/health')
    expect(res.status).toBe(200)
    expect(res.body.status).toBe('ok')
  })
})
