import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const mockFetch = vi.fn();

beforeEach(() => {
  globalThis.fetch = mockFetch;
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('fetchSystemInfo', () => {
  it('returns parsed SystemInfo from /api/system/info', async () => {
    const mockResponse = {
      success: true,
      data: {
        runners: [{ id: 'cua', label: 'Cua', description: 'Test', available: true }],
        providers: [{ id: 'opencode', label: 'OpenCode', available: true }],
        models: { opencode: ['gpt-4o'] },
        defaults: { runner: 'cua', provider: 'opencode', model: 'gpt-4o' },
      },
    };

    mockFetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      text: () => Promise.resolve(JSON.stringify(mockResponse)),
    });

    const { fetchSystemInfo } = await import('./system.js');
    const result = await fetchSystemInfo();
    expect(result.success).toBe(true);
    expect(result.data?.runners).toHaveLength(1);
    expect(result.data?.defaults.runner).toBe('cua');
    expect(mockFetch).toHaveBeenCalledWith('/api/system/info', expect.any(Object));
  });

  it('throws on non-ok response', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 500,
      text: () => Promise.resolve(JSON.stringify({ error: 'Server error' })),
    });

    const { fetchSystemInfo } = await import('./system.js');
    await expect(fetchSystemInfo()).rejects.toThrow('Server error');
  });
});

describe('createWorkflow with runtimeConfig', () => {
  it('sends runtimeConfig in request body', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      status: 201,
      text: () => Promise.resolve(JSON.stringify({ success: true, data: { id: 'wf-1' } })),
    });

    const { createWorkflow } = await import('./workflows.js');
    await createWorkflow('test', 'script', { runtimeConfig: { runner: 'cua' } });

    const callUrl = mockFetch.mock.calls[0][0];
    const callBody = JSON.parse(mockFetch.mock.calls[0][1].body);
    expect(callUrl).toContain('/api/workflows');
    expect(callBody.runtimeConfig).toEqual({ runner: 'cua' });
  });

  it('sends workspace in request body', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      status: 201,
      text: () => Promise.resolve(JSON.stringify({ success: true, data: { id: 'wf-2' } })),
    });

    const { createWorkflow } = await import('./workflows.js');
    await createWorkflow('test', 'script', {
      workspace: { git: 'https://github.com/foo/bar', branch: 'main' },
    });

    const callBody = JSON.parse(mockFetch.mock.calls[0][1].body);
    expect(callBody.workspace).toEqual({ git: 'https://github.com/foo/bar', branch: 'main' });
    expect(callBody.name).toBe('test');
    expect(callBody.script).toBe('script');
  });

  it('works without options (backward compat)', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      status: 201,
      text: () => Promise.resolve(JSON.stringify({ success: true, data: { id: 'wf-3' } })),
    });

    const { createWorkflow } = await import('./workflows.js');
    await createWorkflow('test', 'script');

    const callBody = JSON.parse(mockFetch.mock.calls[0][1].body);
    expect(callBody).toEqual({ name: 'test', script: 'script' });
    expect(callBody.runtimeConfig).toBeUndefined();
    expect(callBody.workspace).toBeUndefined();
  });
});

describe('controlWorkflow with runtimeConfig', () => {
  it('sends runtimeConfig in request body', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      text: () => Promise.resolve(JSON.stringify({ success: true, data: { status: 'running' } })),
    });

    const { controlWorkflow } = await import('./workflows.js');
    await controlWorkflow('wf-1', 'start', { runtimeConfig: { runner: 'pi-direct' } });

    const callBody = JSON.parse(mockFetch.mock.calls[0][1].body);
    expect(callBody.runtimeConfig).toEqual({ runner: 'pi-direct' });
  });

  it('works without runtimeConfig (backward compat)', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      text: () => Promise.resolve(JSON.stringify({ success: true, data: { status: 'paused' } })),
    });

    const { controlWorkflow } = await import('./workflows.js');
    await controlWorkflow('wf-1', 'pause');

    const callBody = JSON.parse(mockFetch.mock.calls[0][1].body);
    expect(callBody).toEqual({});
  });
});
