import { DockerAgentRunner } from './docker-runner.js';
import { WslDockerAgentRunner } from './wsl-docker-runner.js';
import type { AgentRunner } from './types.js';
import { logger } from '../logger.js';

/**
 * Get the appropriate Docker agent runner based on availability.
 * 
 * Priority:
 * 1. WSL Docker (if WSL is available and Docker is running in WSL)
 * 2. Native Docker (if Docker is available on Windows)
 * 3. Throws error if neither is available
 */
export function createAgentRunner(): AgentRunner {
  logger.info('Checking Docker availability...');
  
  // Check WSL Docker first (preferred for Windows)
  const wslAvailable = WslDockerAgentRunner.isAvailable();
  logger.info(`WSL Docker available: ${wslAvailable}`);
  
  if (wslAvailable) {
    logger.info('Using Docker via WSL');
    return new WslDockerAgentRunner();
  }

  // Fall back to native Docker
  const nativeAvailable = DockerAgentRunner.isAvailable();
  logger.info(`Native Docker available: ${nativeAvailable}`);
  
  if (nativeAvailable) {
    logger.info('Using native Docker');
    return new DockerAgentRunner();
  }

  // No Docker available
  logger.error('No Docker runtime available');
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
