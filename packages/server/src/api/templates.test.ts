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
// Tests
// ---------------------------------------------------------------------------

describe('GET /api/templates', () => {
  it('1 — returns empty list initially', async () => {
    const app = createApp();
    const res = await request(app)
      .get('/api/templates')
      .expect('Content-Type', /json/);

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data).toEqual([]);
    expect(res.body.total).toBe(0);
    expect(res.body.page).toBe(1);
    expect(res.body.pageSize).toBe(20);
  });

  it('2 — returns paginated list of templates', async () => {
    templateRepo.createTemplate({ name: 'Alpha', script: VALID_SCRIPT });
    templateRepo.createTemplate({ name: 'Beta', script: VALID_SCRIPT });

    const app = createApp();
    const res = await request(app)
      .get('/api/templates')
      .expect('Content-Type', /json/);

    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(2);
    expect(res.body.total).toBe(2);
  });

  it('3 — filters by tag query param', async () => {
    const t1 = templateRepo.createTemplate({ name: 'Tagged', script: VALID_SCRIPT, tags: ['hello'] });
    templateRepo.createTemplate({ name: 'Untagged', script: VALID_SCRIPT });

    const app = createApp();
    const res = await request(app)
      .get('/api/templates?tag=hello')
      .expect('Content-Type', /json/);

    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(1);
    expect(res.body.data[0].id).toBe(t1.id);
    expect(res.body.data[0].name).toBe('Tagged');
  });

  it('4 — paginates with page and pageSize params', async () => {
    for (let i = 0; i < 5; i++) {
      templateRepo.createTemplate({ name: `T${i}`, script: VALID_SCRIPT });
    }

    const app = createApp();
    const res = await request(app)
      .get('/api/templates?page=2&pageSize=2')
      .expect('Content-Type', /json/);

    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(2);
    expect(res.body.total).toBe(5);
    expect(res.body.page).toBe(2);
    expect(res.body.pageSize).toBe(2);
  });
});

describe('POST /api/templates', () => {
  it('5 — creates a template successfully with 201', async () => {
    const app = createApp();
    const res = await request(app)
      .post('/api/templates')
      .send({ name: 'My Template', script: VALID_SCRIPT })
      .expect('Content-Type', /json/);

    expect(res.status).toBe(201);
    expect(res.body.success).toBe(true);
    expect(res.body.data).toBeDefined();
    expect(res.body.data.id).toBeDefined();
    expect(res.body.data.name).toBe('My Template');
    expect(res.body.data.script).toBe(VALID_SCRIPT);
    expect(res.body.data.currentVersion).toBe(1);
    expect(res.body.data.tags).toEqual([]);
    expect(res.body.data.createdAt).toBeDefined();
    expect(res.body.data.updatedAt).toBeDefined();
  });

  it('6 — creates template with description and tags', async () => {
    const app = createApp();
    const res = await request(app)
      .post('/api/templates')
      .send({
        name: 'Tagged Template',
        description: 'A template with tags',
        script: VALID_SCRIPT,
        tags: ['research', 'data'],
      })
      .expect('Content-Type', /json/);

    expect(res.status).toBe(201);
    expect(res.body.data.name).toBe('Tagged Template');
    expect(res.body.data.description).toBe('A template with tags');
    expect(res.body.data.tags).toEqual(['data', 'research']); // sorted
  });

  it('7 — returns 400 when name is missing', async () => {
    const app = createApp();
    const res = await request(app)
      .post('/api/templates')
      .send({ script: VALID_SCRIPT })
      .expect('Content-Type', /json/);

    expect(res.status).toBe(400);
    expect(res.body.success).toBe(false);
    expect(res.body.error).toBe('Name is required');
  });

  it('8 — returns 400 when name is empty string', async () => {
    const app = createApp();
    const res = await request(app)
      .post('/api/templates')
      .send({ name: '', script: VALID_SCRIPT })
      .expect('Content-Type', /json/);

    expect(res.status).toBe(400);
    expect(res.body.success).toBe(false);
    expect(res.body.error).toBe('Name is required');
  });

  it('9 — returns 400 when script is missing', async () => {
    const app = createApp();
    const res = await request(app)
      .post('/api/templates')
      .send({ name: 'No Script' })
      .expect('Content-Type', /json/);

    expect(res.status).toBe(400);
    expect(res.body.success).toBe(false);
    expect(res.body.error).toBe('Script is required');
  });

  it('10 — returns 400 when tags is not an array of strings', async () => {
    const app = createApp();
    const res = await request(app)
      .post('/api/templates')
      .send({ name: 'Bad Tags', script: VALID_SCRIPT, tags: 'not-an-array' })
      .expect('Content-Type', /json/);

    expect(res.status).toBe(400);
    expect(res.body.success).toBe(false);
    expect(res.body.error).toBe('Tags must be an array of strings');
  });
});

describe('GET /api/templates/:id', () => {
  it('11 — returns created template by id', async () => {
    const created = templateRepo.createTemplate({
      name: 'Detail Test',
      script: VALID_SCRIPT,
    });

    const app = createApp();
    const res = await request(app)
      .get(`/api/templates/${created.id}`)
      .expect('Content-Type', /json/);

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data.id).toBe(created.id);
    expect(res.body.data.name).toBe('Detail Test');
    expect(res.body.data.script).toBe(VALID_SCRIPT);
    expect(res.body.data.currentVersion).toBe(1);
  });

  it('12 — returns 404 for non-existent id', async () => {
    const app = createApp();
    const res = await request(app)
      .get('/api/templates/non-existent-id')
      .expect('Content-Type', /json/);

    expect(res.status).toBe(404);
    expect(res.body.success).toBe(false);
    expect(res.body.error).toBe('Template not found');
  });
});

describe('PUT /api/templates/:id', () => {
  it('13 — updates template name', async () => {
    const created = templateRepo.createTemplate({
      name: 'Before',
      script: VALID_SCRIPT,
    });

    const app = createApp();
    const res = await request(app)
      .put(`/api/templates/${created.id}`)
      .send({ name: 'After' })
      .expect('Content-Type', /json/);

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data.name).toBe('After');
  });

  it('14 — updates template script and triggers new version', async () => {
    // Create via API so v1 is auto-created
    const app = createApp();
    const createRes = await request(app)
      .post('/api/templates')
      .send({ name: 'Script Update', script: VALID_SCRIPT })
      .expect('Content-Type', /json/);

    const templateId = createRes.body.data.id;

    const newScript = `
phase("Build", () => {
  agent("builder-1", "Build the solution");
});
`.trim();

    const res = await request(app)
      .put(`/api/templates/${templateId}`)
      .send({ script: newScript })
      .expect('Content-Type', /json/);

    expect(res.status).toBe(200);
    expect(res.body.data.script).toBe(newScript);
    expect(res.body.data.currentVersion).toBe(2);
  });

  it('15 — updates template description', async () => {
    const created = templateRepo.createTemplate({
      name: 'Desc Update',
      script: VALID_SCRIPT,
    });

    const app = createApp();
    const res = await request(app)
      .put(`/api/templates/${created.id}`)
      .send({ description: 'Updated description' })
      .expect('Content-Type', /json/);

    expect(res.status).toBe(200);
    expect(res.body.data.description).toBe('Updated description');
  });

  it('16 — updates template tags', async () => {
    const created = templateRepo.createTemplate({
      name: 'Tags Update',
      script: VALID_SCRIPT,
      tags: ['old'],
    });

    const app = createApp();
    const res = await request(app)
      .put(`/api/templates/${created.id}`)
      .send({ tags: ['new1', 'new2'] })
      .expect('Content-Type', /json/);

    expect(res.status).toBe(200);
    expect(res.body.data.tags).toEqual(['new1', 'new2']);
  });

  it('17 — returns 400 when no fields provided', async () => {
    const created = templateRepo.createTemplate({
      name: 'No Fields',
      script: VALID_SCRIPT,
    });

    const app = createApp();
    const res = await request(app)
      .put(`/api/templates/${created.id}`)
      .send({})
      .expect('Content-Type', /json/);

    expect(res.status).toBe(400);
    expect(res.body.success).toBe(false);
    expect(res.body.error).toBe(
      'At least one field (name, description, script, tags) must be provided',
    );
  });

  it('18 — returns 404 for non-existent id', async () => {
    const app = createApp();
    const res = await request(app)
      .put('/api/templates/non-existent')
      .send({ name: 'Nope' })
      .expect('Content-Type', /json/);

    expect(res.status).toBe(404);
    expect(res.body.success).toBe(false);
    expect(res.body.error).toBe('Template not found');
  });
});

describe('DELETE /api/templates/:id', () => {
  it('19 — deletes template and returns 204', async () => {
    const created = templateRepo.createTemplate({
      name: 'To Delete',
      script: VALID_SCRIPT,
    });

    const app = createApp();
    const res = await request(app).delete(`/api/templates/${created.id}`);

    expect(res.status).toBe(204);

    // Confirm removed from DB
    expect(templateRepo.getTemplate(created.id)).toBeUndefined();
  });

  it('20 — returns 404 for non-existent template', async () => {
    const app = createApp();
    const res = await request(app)
      .delete('/api/templates/does-not-exist')
      .expect('Content-Type', /json/);

    expect(res.status).toBe(404);
    expect(res.body.success).toBe(false);
    expect(res.body.error).toBe('Template not found');
  });
});

describe('GET /api/templates/:id/versions', () => {
  it('21 — returns version list for a template', async () => {
    // Create via API so v1 is auto-created
    const app = createApp();
    const createRes = await request(app)
      .post('/api/templates')
      .send({ name: 'Versioned', script: VALID_SCRIPT })
      .expect('Content-Type', /json/);

    const templateId = createRes.body.data.id;

    const res = await request(app)
      .get(`/api/templates/${templateId}/versions`)
      .expect('Content-Type', /json/);

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data).toBeDefined();
    expect(Array.isArray(res.body.data)).toBe(true);
    expect(res.body.data.length).toBeGreaterThanOrEqual(1);

    // v1 should be present
    const v1 = res.body.data.find(
      (v: { version: number }) => v.version === 1,
    );
    expect(v1).toBeDefined();
    expect(v1.script).toBe(VALID_SCRIPT);
    expect(v1.name).toBe('Versioned');
    expect(v1.templateId).toBe(templateId);
  });

  it('22 — multiple versions appear after script updates', async () => {
    // Create via API so v1 is auto-created
    const app = createApp();
    const createRes = await request(app)
      .post('/api/templates')
      .send({ name: 'Multi Version', script: VALID_SCRIPT })
      .expect('Content-Type', /json/);

    const templateId = createRes.body.data.id;

    // Update script twice via API to create v2 and v3
    await request(app)
      .put(`/api/templates/${templateId}`)
      .send({ script: VALID_SCRIPT + '\n// v2' });

    await request(app)
      .put(`/api/templates/${templateId}`)
      .send({ script: VALID_SCRIPT + '\n// v3' });

    const res = await request(app)
      .get(`/api/templates/${templateId}/versions`)
      .expect('Content-Type', /json/);

    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(3);

    const versions = res.body.data;
    expect(versions[0].version).toBe(3); // newest first
    expect(versions[1].version).toBe(2);
    expect(versions[2].version).toBe(1);
  });

  it('23 — returns 404 for non-existent template versions', async () => {
    const app = createApp();
    const res = await request(app)
      .get('/api/templates/non-existent/versions')
      .expect('Content-Type', /json/);

    expect(res.status).toBe(404);
    expect(res.body.success).toBe(false);
    expect(res.body.error).toBe('Template not found');
  });
});

describe('Soft delete (deleted_at marker)', () => {
  it('24 — soft-deleted template is excluded from list and total decrements', async () => {
    const t1 = templateRepo.createTemplate({ name: 'Keep', script: VALID_SCRIPT });
    const t2 = templateRepo.createTemplate({ name: 'Drop', script: VALID_SCRIPT });

    const app = createApp();
    const before = await request(app).get('/api/templates');
    expect(before.body.data).toHaveLength(2);
    expect(before.body.total).toBe(2);

    await request(app).delete(`/api/templates/${t2.id}`).expect(204);

    const after = await request(app).get('/api/templates');
    expect(after.body.data).toHaveLength(1);
    expect(after.body.total).toBe(1);
    expect(after.body.data[0].id).toBe(t1.id);
  });

  it('25 — soft-deleted template returns 404 on single GET', async () => {
    const t = templateRepo.createTemplate({ name: 'Vanish', script: VALID_SCRIPT });
    const app = createApp();
    await request(app).delete(`/api/templates/${t.id}`).expect(204);

    const res = await request(app).get(`/api/templates/${t.id}`);
    expect(res.status).toBe(404);
    expect(res.body.error).toBe('Template not found');
  });

  it('26 — soft-deleted template returns 404 on PUT', async () => {
    const t = templateRepo.createTemplate({ name: 'Ghost', script: VALID_SCRIPT });
    const app = createApp();
    await request(app).delete(`/api/templates/${t.id}`).expect(204);

    const res = await request(app)
      .put(`/api/templates/${t.id}`)
      .send({ name: 'Resurrect' });
    expect(res.status).toBe(404);
    expect(res.body.error).toBe('Template not found');
  });

  it('27 — soft-deleted template returns 404 on POST /run', async () => {
    const t = templateRepo.createTemplate({ name: 'NoRun', script: VALID_SCRIPT });
    const app = createApp();
    await request(app).delete(`/api/templates/${t.id}`).expect(204);

    const res = await request(app).post(`/api/templates/${t.id}/run`).send({});
    expect(res.status).toBe(404);
    expect(res.body.error).toBe('Template not found');
  });

  it('28 — soft-deleted template returns 404 on versions endpoint', async () => {
    const t = templateRepo.createTemplate({ name: 'NoVersions', script: VALID_SCRIPT });
    const app = createApp();
    await request(app).delete(`/api/templates/${t.id}`).expect(204);

    const res = await request(app).get(`/api/templates/${t.id}/versions`);
    expect(res.status).toBe(404);
    expect(res.body.error).toBe('Template not found');
  });

  it('29 — re-deleting a soft-deleted template returns 404', async () => {
    const t = templateRepo.createTemplate({ name: 'Once', script: VALID_SCRIPT });
    const app = createApp();
    await request(app).delete(`/api/templates/${t.id}`).expect(204);

    const second = await request(app).delete(`/api/templates/${t.id}`);
    expect(second.status).toBe(404);
    expect(second.body.error).toBe('Template not found');
  });

  it('30 — soft delete preserves the row in the database (deleted_at set)', async () => {
    const t = templateRepo.createTemplate({ name: 'Preserved', script: VALID_SCRIPT });
    const app = createApp();
    await request(app).delete(`/api/templates/${t.id}`).expect(204);

    // The row must still be present in the raw table, just with deleted_at populated.
    const { getDb } = await import('../db/connection.js');
    const db = getDb();
    const row = db
      .prepare('SELECT id, name, deleted_at FROM workflow_templates WHERE id = ?')
      .get(t.id) as { id: string; name: string; deleted_at: string | null };
    expect(row).toBeDefined();
    expect(row.id).toBe(t.id);
    expect(row.name).toBe('Preserved');
    expect(row.deleted_at).not.toBeNull();
    expect(typeof row.deleted_at).toBe('string');
  });

  it('31 — soft delete is reversible by clearing deleted_at (manual DB recovery)', async () => {
    const t = templateRepo.createTemplate({ name: 'Recoverable', script: VALID_SCRIPT });
    const app = createApp();
    await request(app).delete(`/api/templates/${t.id}`).expect(204);

    // Simulate manual restoration: clear deleted_at directly in the DB.
    const { getDb } = await import('../db/connection.js');
    const db = getDb();
    db.prepare('UPDATE workflow_templates SET deleted_at = NULL WHERE id = ?').run(t.id);

    // Template is reachable again through the API.
    const res = await request(app).get(`/api/templates/${t.id}`);
    expect(res.status).toBe(200);
    expect(res.body.data.id).toBe(t.id);
  });
});

describe('POST /api/templates/:id/run — template link on workflow_runs', () => {
  it('32 — writes templateId + templateVersion matching the template (v1)', async () => {
    const t = templateRepo.createTemplate({ name: 'LinkedRun', script: VALID_SCRIPT });
    // Bump the version history once so the template is at v1 with a version row.
    templateRepo.createVersion(t.id, { script: VALID_SCRIPT, name: 'LinkedRun' });
    const fresh = templateRepo.getTemplate(t.id)!;
    expect(fresh.currentVersion).toBe(1);

    const app = createApp();
    const res = await request(app).post(`/api/templates/${t.id}/run`).send({});
    expect(res.status).toBe(201);
    expect(res.body.success).toBe(true);
    expect(res.body.data.templateId).toBe(t.id);
    expect(res.body.data.templateVersion).toBe(1);
  });

  it('33 — re-running after a version bump records the new version, not the old one', async () => {
    const t = templateRepo.createTemplate({ name: 'Versioned', script: VALID_SCRIPT });
    // Pre-create v1 so the next createVersion call is v2.
    templateRepo.createVersion(t.id, { script: VALID_SCRIPT, name: 'Versioned' });
    const app = createApp();

    // First run at v1
    const first = await request(app).post(`/api/templates/${t.id}/run`).send({});
    expect(first.status).toBe(201);
    expect(first.body.data.templateVersion).toBe(1);

    // Bump the template to v2 by creating a new version row.
    templateRepo.createVersion(t.id, { script: VALID_SCRIPT, name: 'Versioned' });
    const fresh = templateRepo.getTemplate(t.id)!;
    expect(fresh.currentVersion).toBe(2);

    // Second run should record v2
    const second = await request(app).post(`/api/templates/${t.id}/run`).send({});
    expect(second.status).toBe(201);
    expect(second.body.data.templateVersion).toBe(2);
    expect(second.body.data.id).not.toBe(first.body.data.id);
  });

  it('34 — link is persisted in the workflow_runs row (DB-level)', async () => {
    const t = templateRepo.createTemplate({ name: 'Persisted', script: VALID_SCRIPT });
    const app = createApp();
    const res = await request(app).post(`/api/templates/${t.id}/run`).send({});
    expect(res.status).toBe(201);
    const runId = res.body.data.id;

    const { getDb } = await import('../db/connection.js');
    const db = getDb();
    const row = db
      .prepare('SELECT template_id, template_version FROM workflow_runs WHERE id = ?')
      .get(runId) as { template_id: string | null; template_version: number | null };
    expect(row.template_id).toBe(t.id);
    expect(row.template_version).toBe(1);
  });
});

describe('GET /api/templates/used-in-workflows', () => {
  it('35 — returns templates sorted by workflow count descending', async () => {
    const { getDb } = await import('../db/connection.js');
    const db = getDb();

    // Create 2 templates
    const mqTemplate = templateRepo.createTemplate({
      name: 'MathQuest',
      description: 'Math game generator',
      script: VALID_SCRIPT,
    });
    const fooTemplate = templateRepo.createTemplate({
      name: 'Foo Template',
      description: 'Test template',
      script: VALID_SCRIPT,
    });

    const now = new Date().toISOString();
    const def = JSON.stringify({ name: 'test', phases: [] });

    // Insert workflow runs: 2 for MathQuest, 1 for Foo
    db.prepare(
      `INSERT INTO workflow_runs (id, name, status, definition_json, created_at, updated_at, template_id) VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run('run-1', 'MQ Run 1', 'completed', def, now, now, mqTemplate.id);
    db.prepare(
      `INSERT INTO workflow_runs (id, name, status, definition_json, created_at, updated_at, template_id) VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run('run-2', 'MQ Run 2', 'completed', def, now, now, mqTemplate.id);
    db.prepare(
      `INSERT INTO workflow_runs (id, name, status, definition_json, created_at, updated_at, template_id) VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run('run-3', 'Foo Run 1', 'completed', def, now, now, fooTemplate.id);

    const app = createApp();
    const res = await request(app)
      .get('/api/templates/used-in-workflows')
      .expect('Content-Type', /json/);

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data).toHaveLength(2);

    // MathQuest should be first with count 2 (most referenced)
    expect(res.body.data[0].name).toBe('MathQuest');
    expect(res.body.data[0].workflowCount).toBe(2);
    expect(res.body.data[0].id).toBe(mqTemplate.id);

    // Foo Template should be second with count 1
    expect(res.body.data[1].name).toBe('Foo Template');
    expect(res.body.data[1].workflowCount).toBe(1);
    expect(res.body.data[1].id).toBe(fooTemplate.id);
  });
});
