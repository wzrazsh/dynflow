import { Router } from 'express';
import {
  RUNNER_INFO,
  PROVIDER_INFO,
  PROVIDER_MODELS,
  DEFAULT_RUNTIME_CONFIG,
} from '@dynflow/shared';
import { CuaAgentRunner } from '../runner/cua-runner.js';
import { CuaPiRunner } from '../runner/cua-pi-runner.js';
import { PiCuaNativeRunner } from '../runner/pi-cua-native-runner.js';
import { PiDirectRunner } from '../runner/pi-direct-runner.js';
import { DockerAgentRunner } from '../runner/docker-runner.js';
import { WslDockerAgentRunner } from '../runner/wsl-docker-runner.js';

const router = Router();

router.get('/', (_req, res) => {
  const runners = RUNNER_INFO.map((r) => {
    let available = false;
    switch (r.id) {
      case 'cua':
        available = CuaAgentRunner.isAvailable();
        break;
      case 'cua-pi':
        available = CuaPiRunner.isAvailable();
        break;
      case 'pi-cua-native':
        available = PiCuaNativeRunner.isAvailable();
        break;
      case 'pi-direct':
        available = PiDirectRunner.isAvailable();
        break;
      case 'docker':
        available = DockerAgentRunner.isAvailable() || WslDockerAgentRunner.isAvailable();
        break;
    }
    return { ...r, available };
  });

  const providers = PROVIDER_INFO.map((p) => {
    let available = false;
    switch (p.id) {
      case 'opencode':
        available = !!process.env.OPENCODE_API_KEY;
        break;
      case 'openai':
        available = !!process.env.OPENAI_API_KEY;
        break;
      case 'anthropic':
        available = !!process.env.ANTHROPIC_API_KEY;
        break;
    }
    return { ...p, available };
  });

  // Find first available runner for defaults
  const firstAvailableRunner = runners.find((r) => r.available)?.id ?? DEFAULT_RUNTIME_CONFIG.runner;
  const firstAvailableProvider = providers.find((p) => p.available)?.id ?? DEFAULT_RUNTIME_CONFIG.provider;

  const data = {
    runners,
    providers,
    models: PROVIDER_MODELS,
    defaults: {
      runner: firstAvailableRunner,
      provider: firstAvailableProvider,
      model: DEFAULT_RUNTIME_CONFIG.model,
    },
  };

  res.json({ success: true, data });
});

export default router;
