import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import request from 'supertest';
import { createApp } from '../app.js';
import { closeDb } from '../db/connection.js';
import { initSchema } from '../db/schema.js';
import * as templateRepo from '../db/template-repository.js';

const VALID_SCRIPT = `
phase("Research", () => {
  agent("researcher-1", "Research quantum computing");
});
`.trim();

const MUTATION_RESPONSE_BUDGET_MS = 2000;

// ---------------------------------------------------------------------------
// Setup — fresh in-memory DB before each test
// ---------------------------------------------------------------------------

beforeEach(() => {
  closeDb();
  process.env.DB_PATH = ':memory:';
  initSchema();
});

afterAll(() => {
  closeDb();
  delete process.env.DB_PATH;
});

// ---------------------------------------------------------------------------
// Performance baseline tests
// ---------------------------------------------------------------------------

describe('Performance', () => {
  it('responds to GET /api/templates within 200ms', async () => {
    // Seed some data so the response isn't trivially fast on empty DB
    for (let i = 0; i < 10; i++) {
      templateRepo.createTemplate({ name: `Perf-T${i}`, script: VALID_SCRIPT });
    }

    const app = createApp();
    const start = performance.now();
    const res = await request(app)
      .get('/api/templates')
      .expect('Content-Type', /json/);
    const duration = performance.now() - start;

    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(10);
    expect(duration).toBeLessThan(200);
  });

  it('responds to POST /api/templates within the mutation response budget', async () => {
    const app = createApp();
    const start = performance.now();
    const res = await request(app)
      .post('/api/templates')
      .send({ name: 'Perf-Create', script: VALID_SCRIPT })
      .expect('Content-Type', /json/);
    const duration = performance.now() - start;

    expect(res.status).toBe(201);
    expect(res.body.data.name).toBe('Perf-Create');
    expect(duration).toBeLessThan(MUTATION_RESPONSE_BUDGET_MS);
  });

  it('responds to GET /api/templates/:id within 200ms', async () => {
    const created = templateRepo.createTemplate({
      name: 'Perf-Detail',
      script: VALID_SCRIPT,
    });

    const app = createApp();
    const start = performance.now();
    const res = await request(app)
      .get(`/api/templates/${created.id}`)
      .expect('Content-Type', /json/);
    const duration = performance.now() - start;

    expect(res.status).toBe(200);
    expect(res.body.data.name).toBe('Perf-Detail');
    expect(duration).toBeLessThan(200);
  });

  it('handles pagination efficiently', async () => {
    // Create 25 templates to exercise pagination
    for (let i = 0; i < 25; i++) {
      templateRepo.createTemplate({ name: `Page-T${i}`, script: VALID_SCRIPT });
    }

    const app = createApp();

    // Measure full list time
    const start = performance.now();
    const res = await request(app)
      .get('/api/templates')
      .expect('Content-Type', /json/);
    const duration = performance.now() - start;

    expect(res.status).toBe(200);
    expect(res.body.total).toBe(25);
    // Paginated list of 25 items should still be fast
    expect(duration).toBeLessThan(300);

    // Verify pagination still works correctly under load
    const page2 = await request(app)
      .get('/api/templates?page=2&pageSize=10')
      .expect('Content-Type', /json/);

    expect(page2.status).toBe(200);
    expect(page2.body.data).toHaveLength(10);
    expect(page2.body.page).toBe(2);
    expect(page2.body.total).toBe(25);
  });
});
