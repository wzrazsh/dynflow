import { DockerAgentRunner } from './docker-runner.js';
import { WslDockerAgentRunner } from './wsl-docker-runner.js';
import { CuaAgentRunner } from './cua-runner.js';
import type { AgentRunner } from './types.js';
import { logger } from '../logger.js';

/**
 * Get the appropriate agent runner.
 *
 * Selection via env var `DYNFLOW_RUNNER`:
 *   - 'cua' (default): CuaAgentRunner — runs Pi inside a Cua-based Docker
 *     sandbox image (`dynflow-cua-pi:latest` or `trycua/cua-xfce`).
 *   - 'docker': legacy DockerAgentRunner / WslDockerAgentRunner — the
 *     pre-Cua OpenAI-only runner.
 *
 * Backward compatibility: if `DYNFLOW_RUNNER` is unset, we default to
 * 'cua' but fall back to 'docker' if Cua's image is not present.
 */
export function createAgentRunner(): AgentRunner {
  const explicit = process.env.DYNFLOW_RUNNER;
  if (explicit === 'docker') {
    logger.info('Runner: docker (legacy, DYNFLOW_RUNNER=docker)');
    return selectDockerRunner();
  }
  if (explicit === 'cua') {
    logger.info('Runner: cua (default)');
    return new CuaAgentRunner();
  }
  // Unset or unknown — try cua first, fall back to docker.
  if (CuaAgentRunner.isAvailable()) {
    logger.info('Runner: cua (auto-selected)');
    return new CuaAgentRunner();
  }
  logger.warn('Runner: cua unavailable, falling back to docker');
  return selectDockerRunner();
}

/**
 * Pick the best legacy Docker runner (WSL preferred on Windows).
 */
function selectDockerRunner(): AgentRunner {
  logger.info('Checking Docker availability...');
  const wslAvailable = WslDockerAgentRunner.isAvailable();
  logger.info(`WSL Docker available: ${wslAvailable}`);
  if (wslAvailable) {
    logger.info('Using Docker via WSL');
    return new WslDockerAgentRunner();
  }
  const nativeAvailable = DockerAgentRunner.isAvailable();
  logger.info(`Native Docker available: ${nativeAvailable}`);
  if (nativeAvailable) {
    logger.info('Using native Docker');
    return new DockerAgentRunner();
  }
  throw new Error(
    'Docker is not available. Please start Docker Desktop with WSL integration enabled.',
  );
}

/**
 * Check if any Docker runtime is available (WSL or native).
 */
export function isDockerAvailable(): boolean {
  return WslDockerAgentRunner.isAvailable() || DockerAgentRunner.isAvailable();
}

/**
 * Clean up orphaned dynflow containers from all available Docker runtimes.
 * (Both legacy Docker and Cua-based images use the `dynflow` label, so a
 * single sweep handles both.)
 */
export async function cleanupContainers(): Promise<void> {
  const runners: AgentRunner[] = [];

  if (WslDockerAgentRunner.isAvailable()) {
    runners.push(new WslDockerAgentRunner());
  }

  if (DockerAgentRunner.isAvailable()) {
    runners.push(new DockerAgentRunner());
  }

  for (const runner of runners) {
    try {
      await runner.cleanup();
    } catch (err) {
      logger.warn('Container cleanup warning:', String(err));
    }
  }
}
