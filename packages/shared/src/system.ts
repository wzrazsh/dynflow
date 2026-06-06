import { z } from 'zod';

export interface RuntimeConfig {
  runner?: string;
  llmProvider?: string;
  model?: string;
}

export interface SystemInfo {
  runners: RunnerInfo[];
  providers: ProviderInfo[];
  models: Record<string, string[]>;
  defaults: { runner: string; provider: string; model: string };
}

export interface RunnerInfo {
  id: string;
  label: string;
  description: string;
  available: boolean;
}

export interface ProviderInfo {
  id: string;
  label: string;
  available: boolean;
}

export const RuntimeConfigSchema = z.object({
  runner: z.string().optional(),
  llmProvider: z.string().optional(),
  model: z.string().optional(),
});

export const SystemInfoSchema = z.object({
  runners: z.array(z.object({
    id: z.string(),
    label: z.string(),
    description: z.string(),
    available: z.boolean(),
  })),
  providers: z.array(z.object({
    id: z.string(),
    label: z.string(),
    available: z.boolean(),
  })),
  models: z.record(z.string(), z.array(z.string())),
  defaults: z.object({
    runner: z.string(),
    provider: z.string(),
    model: z.string(),
  }),
});

// Hardcoded model lists per provider
export const PROVIDER_MODELS: Record<string, string[]> = {
  opencode: ['mimo-v2.5-free', 'kimi-k2', 'gpt-4o-mini'],
  openai: ['gpt-4o', 'gpt-4-turbo', 'gpt-3.5-turbo'],
  anthropic: ['claude-3-5-sonnet-20241022', 'claude-3-opus-20240229'],
};

// Runner metadata
export const RUNNER_INFO: RunnerInfo[] = [
  { id: 'cua', label: 'Cua Sandbox (Pi)', description: 'Default Cua XFCE desktop container with Pi agent', available: true },
  { id: 'cua-pi', label: 'Cua Pi (Internal)', description: 'Pi agent running inside Cua container (internal)', available: true },
  { id: 'pi-cua-native', label: 'Pi Cua Native', description: 'Pi agent with native Cua integration', available: true },
  { id: 'pi-direct', label: 'Pi Direct', description: 'Direct Pi agent (no sandbox)', available: true },
  { id: 'docker', label: 'Docker (Legacy)', description: 'Legacy OpenAI-only Docker agent', available: true },
];

// Provider metadata
export const PROVIDER_INFO: ProviderInfo[] = [
  { id: 'opencode', label: 'OpenCode', available: true },
  { id: 'openai', label: 'OpenAI', available: true },
  { id: 'anthropic', label: 'Anthropic', available: true },
];

// Default runtime config (fallback)
export const DEFAULT_RUNTIME_CONFIG = Object.freeze({
  runner: 'cua',
  provider: 'opencode',
  model: 'gpt-4o',
});
