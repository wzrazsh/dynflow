import { describe, it, expect } from 'vitest';
import request from 'supertest';
import { createApp } from '../app.js';

describe('POST /api/workflows with projectName', () => {
  it('stores projectName when provided', async () => {
    const app = createApp();
    const res = await request(app)
      .post('/api/workflows')
      .send({
        name: 'project-linked-workflow',
        script: 'workflow("test", async () => { await phase("p", async () => { await agent("a", { prompt: "hi" }); }); })',
        projectName: 'my-project',
      });
    expect(res.status).toBe(201);
    expect(res.body.success).toBe(true);
    expect(res.body.data.projectName).toBe('my-project');
  });

  it('filters by projectName', async () => {
    const app = createApp();
    const listRes = await request(app)
      .get('/api/workflows?projectName=my-project');
    expect(listRes.status).toBe(200);
    expect(listRes.body.success).toBe(true);
    expect(listRes.body.data.every((r: Record<string, unknown>) => r.projectName === 'my-project')).toBe(true);
  });
});
