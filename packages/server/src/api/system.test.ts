import { describe, it, expect, vi, afterEach } from 'vitest';
import request from 'supertest';
import express from 'express';
import systemRouter from './system.js';

// Mock all runner isAvailable()
vi.mock('../runner/cua-runner.js', () => ({
  CuaAgentRunner: { isAvailable: () => true },
}));
vi.mock('../runner/cua-pi-runner.js', () => ({
  CuaPiRunner: { isAvailable: () => false },
}));
vi.mock('../runner/pi-cua-native-runner.js', () => ({
  PiCuaNativeRunner: { isAvailable: () => false },
}));
vi.mock('../runner/pi-direct-runner.js', () => ({
  PiDirectRunner: { isAvailable: () => false },
}));
vi.mock('../runner/docker-runner.js', () => ({
  DockerAgentRunner: { isAvailable: () => false },
}));
vi.mock('../runner/wsl-docker-runner.js', () => ({
  WslDockerAgentRunner: { isAvailable: () => false },
}));

describe('GET /api/system', () => {
  const app = express();
  app.use('/api/system', systemRouter);

  const OLD_ENV = { ...process.env };

  afterEach(() => {
    process.env = { ...OLD_ENV };
  });

  it('returns expected structure with runners, providers, models, defaults', async () => {
    process.env.OPENCODE_API_KEY = 'test-key';
    process.env.OPENAI_API_KEY = 'test-key-2';
    process.env.ANTHROPIC_API_KEY = 'test-key-3';

    const res = await request(app).get('/api/system');
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data).toHaveProperty('runners');
    expect(res.body.data).toHaveProperty('providers');
    expect(res.body.data).toHaveProperty('models');
    expect(res.body.data).toHaveProperty('defaults');
  });

  it('marks opencode provider unavailable when no key set', async () => {
    delete process.env.OPENCODE_API_KEY;
    delete process.env.OPENAI_API_KEY;
    delete process.env.ANTHROPIC_API_KEY;

    const res = await request(app).get('/api/system');
    const opencodeProvider = res.body.data.providers.find((p: { id: string }) => p.id === 'opencode');
    expect(opencodeProvider.available).toBe(false);
  });

  it('marks only cua as available runner', async () => {
    process.env.OPENCODE_API_KEY = 'test-key';

    const res = await request(app).get('/api/system');
    const cua = res.body.data.runners.find((r: { id: string }) => r.id === 'cua');
    const docker = res.body.data.runners.find((r: { id: string }) => r.id === 'docker');
    expect(cua.available).toBe(true);
    expect(docker.available).toBe(false);
  });

  it('returns models from PROVIDER_MODELS', async () => {
    const res = await request(app).get('/api/system');
    expect(res.body.data.models).toHaveProperty('opencode');
    expect(res.body.data.models).toHaveProperty('openai');
    expect(res.body.data.models).toHaveProperty('anthropic');
  });

  it('defaults reflect first available runner when keys present', async () => {
    process.env.OPENCODE_API_KEY = 'test-key';

    const res = await request(app).get('/api/system');
    expect(res.body.data.defaults.runner).toBe('cua');
    expect(res.body.data.defaults.provider).toBe('opencode');
  });
});

describe('GET /api/system/info', () => {
  const app = express();
  app.use('/api/system', systemRouter);

  it('returns the same data as /api/system (frontend contract)', async () => {
    process.env.OPENCODE_API_KEY = 'test-key';

    const res = await request(app).get('/api/system/info');
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data).toHaveProperty('runners');
    expect(res.body.data).toHaveProperty('providers');
    expect(res.body.data).toHaveProperty('models');
    expect(res.body.data).toHaveProperty('defaults');
  });
});
