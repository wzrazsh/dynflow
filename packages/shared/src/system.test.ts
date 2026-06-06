import { describe, it, expect } from 'vitest';
import {
  RuntimeConfigSchema,
  SystemInfoSchema,
  PROVIDER_MODELS,
  RUNNER_INFO,
  PROVIDER_INFO,
  DEFAULT_RUNTIME_CONFIG,
} from './system.js';
import type { RuntimeConfig, SystemInfo } from './system.js';

describe('RuntimeConfigSchema', () => {
  it('accepts valid input with all fields', () => {
    const result = RuntimeConfigSchema.safeParse({
      runner: 'cua',
      llmProvider: 'opencode',
      model: 'gpt-4o',
    });
    expect(result.success).toBe(true);
  });

  it('accepts empty object', () => {
    const result = RuntimeConfigSchema.safeParse({});
    expect(result.success).toBe(true);
  });

  it('accepts partial input with only runner', () => {
    const result = RuntimeConfigSchema.safeParse({ runner: 'pi-direct' });
    expect(result.success).toBe(true);
  });

  it('accepts partial input with only llmProvider', () => {
    const result = RuntimeConfigSchema.safeParse({ llmProvider: 'openai' });
    expect(result.success).toBe(true);
  });

  it('accepts partial input with only model', () => {
    const result = RuntimeConfigSchema.safeParse({ model: 'claude-3-5-sonnet-20241022' });
    expect(result.success).toBe(true);
  });

  it('rejects non-string runner', () => {
    const result = RuntimeConfigSchema.safeParse({ runner: 123 });
    expect(result.success).toBe(false);
  });

  it('rejects non-string llmProvider', () => {
    const result = RuntimeConfigSchema.safeParse({ llmProvider: true });
    expect(result.success).toBe(false);
  });

  it('rejects non-string model', () => {
    const result = RuntimeConfigSchema.safeParse({ model: null });
    expect(result.success).toBe(false);
  });

  it('accepts any string values — no validation against known lists', () => {
    const result = RuntimeConfigSchema.safeParse({
      runner: 'some-custom-runner',
      llmProvider: 'custom-provider',
      model: 'custom-model',
    });
    expect(result.success).toBe(true);
  });

  it('strips unknown fields', () => {
    const result = RuntimeConfigSchema.safeParse({
      runner: 'cua',
      temperature: 0.7,
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data).not.toHaveProperty('temperature');
    }
  });
});

describe('SystemInfoSchema', () => {
  it('accepts valid SystemInfo', () => {
    const info: SystemInfo = {
      runners: [
        { id: 'cua', label: 'Cua', description: 'Test', available: true },
      ],
      providers: [{ id: 'opencode', label: 'OpenCode', available: true }],
      models: { opencode: ['gpt-4o'] },
      defaults: { runner: 'cua', provider: 'opencode', model: 'gpt-4o' },
    };
    const result = SystemInfoSchema.safeParse(info);
    expect(result.success).toBe(true);
  });

  it('accepts empty arrays for runners and providers', () => {
    const info: SystemInfo = {
      runners: [],
      providers: [],
      models: {},
      defaults: { runner: '', provider: '', model: '' },
    };
    const result = SystemInfoSchema.safeParse(info);
    expect(result.success).toBe(true);
  });

  it('rejects missing runners array', () => {
    const info = {
      providers: [],
      models: {},
      defaults: { runner: 'cua', provider: 'opencode', model: 'gpt-4o' },
    };
    const result = SystemInfoSchema.safeParse(info);
    expect(result.success).toBe(false);
  });

  it('rejects missing defaults', () => {
    const info = {
      runners: [],
      providers: [],
      models: {},
    };
    const result = SystemInfoSchema.safeParse(info);
    expect(result.success).toBe(false);
  });

  it('rejects non-boolean available on runner', () => {
    const info = {
      runners: [{ id: 'cua', label: 'Cua', description: 'Test', available: 'yes' }],
      providers: [],
      models: {},
      defaults: { runner: 'cua', provider: 'opencode', model: 'gpt-4o' },
    };
    const result = SystemInfoSchema.safeParse(info);
    expect(result.success).toBe(false);
  });
});

describe('PROVIDER_MODELS', () => {
  it('has opencode, openai, and anthropic providers', () => {
    expect(Object.keys(PROVIDER_MODELS).sort()).toEqual([
      'anthropic',
      'openai',
      'opencode',
    ]);
  });

  it('has at least 2 models per provider', () => {
    for (const [provider, models] of Object.entries(PROVIDER_MODELS)) {
      expect(
        models.length,
        `${provider} should have at least 2 models`,
      ).toBeGreaterThanOrEqual(2);
    }
  });

  it('opencode provider has mimo-v2.5-free, kimi-k2, and gpt-4o-mini', () => {
    expect(PROVIDER_MODELS.opencode).toEqual([
      'mimo-v2.5-free',
      'kimi-k2',
      'gpt-4o-mini',
    ]);
  });

  it('openai provider has expected models', () => {
    expect(PROVIDER_MODELS.openai).toContain('gpt-4o');
    expect(PROVIDER_MODELS.openai).toContain('gpt-4-turbo');
  });

  it('anthropic provider has expected models', () => {
    expect(PROVIDER_MODELS.anthropic).toContain('claude-3-5-sonnet-20241022');
    expect(PROVIDER_MODELS.anthropic).toContain('claude-3-opus-20240229');
  });
});

describe('RUNNER_INFO', () => {
  it('has at least 5 runners', () => {
    expect(RUNNER_INFO.length).toBeGreaterThanOrEqual(5);
  });

  it('each runner has all required fields', () => {
    for (const runner of RUNNER_INFO) {
      expect(runner.id, `runner ${runner.id} missing id`).toBeTruthy();
      expect(runner.label, `runner ${runner.id} missing label`).toBeTruthy();
      expect(
        runner.description,
        `runner ${runner.id} missing description`,
      ).toBeTruthy();
      expect(typeof runner.available).toBe('boolean');
    }
  });

  it('includes cua as the first/default runner', () => {
    expect(RUNNER_INFO[0].id).toBe('cua');
  });

  it('includes docker as a legacy runner', () => {
    const dockerRunner = RUNNER_INFO.find((r) => r.id === 'docker');
    expect(dockerRunner).toBeDefined();
    expect(dockerRunner!.label).toContain('Legacy');
  });

  it('all runner ids are unique', () => {
    const ids = RUNNER_INFO.map((r) => r.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});

describe('PROVIDER_INFO', () => {
  it('has opencode, openai, and anthropic providers', () => {
    const ids = PROVIDER_INFO.map((p) => p.id).sort();
    expect(ids).toEqual(['anthropic', 'openai', 'opencode']);
  });

  it('all providers are marked as available', () => {
    for (const provider of PROVIDER_INFO) {
      expect(provider.available, `${provider.id} should be available`).toBe(
        true,
      );
    }
  });
});

describe('DEFAULT_RUNTIME_CONFIG', () => {
  it('has runner, provider, and model fields', () => {
    expect(DEFAULT_RUNTIME_CONFIG).toHaveProperty('runner');
    expect(DEFAULT_RUNTIME_CONFIG).toHaveProperty('provider');
    expect(DEFAULT_RUNTIME_CONFIG).toHaveProperty('model');
  });

  it('defaults to cua runner', () => {
    expect(DEFAULT_RUNTIME_CONFIG.runner).toBe('cua');
  });

  it('defaults to opencode provider', () => {
    expect(DEFAULT_RUNTIME_CONFIG.provider).toBe('opencode');
  });

  it('defaults to gpt-4o model', () => {
    expect(DEFAULT_RUNTIME_CONFIG.model).toBe('gpt-4o');
  });

  it('is frozen / not extensible at runtime', () => {
    const frozen = Object.isFrozen(DEFAULT_RUNTIME_CONFIG);
    expect(frozen).toBe(true);
  });
});

describe('RuntimeConfig type', () => {
  it('RuntimeConfig type allows any string values for all fields', () => {
    const config: RuntimeConfig = {
      runner: 'custom-runner',
      llmProvider: 'custom-provider',
      model: 'custom-model',
    };
    expect(config.runner).toBe('custom-runner');
    expect(config.llmProvider).toBe('custom-provider');
    expect(config.model).toBe('custom-model');
  });

  it('RuntimeConfig type allows partial objects', () => {
    const config: RuntimeConfig = { model: 'gpt-4o' };
    expect(config.model).toBe('gpt-4o');
    expect(config.runner).toBeUndefined();
  });
});

describe('JSON round-trip', () => {
  it('preserves RuntimeConfig fields through JSON', () => {
    const config: RuntimeConfig = {
      runner: 'cua',
      llmProvider: 'opencode',
      model: 'gpt-4o',
    };
    const json = JSON.stringify(config);
    const parsed = RuntimeConfigSchema.parse(JSON.parse(json));
    expect(parsed).toEqual(config);
  });

  it('preserves empty RuntimeConfig through JSON', () => {
    const config: RuntimeConfig = {};
    const json = JSON.stringify(config);
    const parsed = RuntimeConfigSchema.parse(JSON.parse(json));
    expect(parsed).toEqual(config);
  });

  it('preserves SystemInfo through JSON', () => {
    const info: SystemInfo = {
      runners: [
        { id: 'cua', label: 'Cua', description: 'Test', available: true },
      ],
      providers: [{ id: 'opencode', label: 'OpenCode', available: true }],
      models: { opencode: ['gpt-4o'] },
      defaults: { runner: 'cua', provider: 'opencode', model: 'gpt-4o' },
    };
    const json = JSON.stringify(info);
    const parsed = SystemInfoSchema.parse(JSON.parse(json));
    expect(parsed).toEqual(info);
  });
});
