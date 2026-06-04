import { DockerAgentRunner } from './docker-runner.js';
import { WslDockerAgentRunner } from './wsl-docker-runner.js';
import { CuaAgentRunner } from './cua-runner.js';
import { PiDirectRunner } from './pi-direct-runner.js';
import { CuaPiRunner } from './cua-pi-runner.js';
import { PiCuaNativeRunner } from './pi-cua-native-runner.js';
import { WindowsNativeRunner } from './windows-native-runner.js';
import type { AgentRunner } from './types.js';
import type { RuntimeConfig } from '@dynflow/shared';
import { logger } from '../logger.js';

/**
 * Union type of all supported runner identifiers.
 */
export type RunnerType = 'cua' | 'cua-pi' | 'pi-cua-native' | 'pi-direct' | 'windows-native' | 'docker';

/**
 * Get the appropriate agent runner.
 *
 * Selection via env var `DYNFLOW_RUNNER`:
 *   - 'cua' (default): CuaAgentRunner — runs Pi inside a Cua-based Docker
 *     sandbox image (`dynflow-cua-pi:latest` or `trycua/cua-xfce`).
 *   - 'cua-pi': CuaPiRunner — runs Pi on the host, talking to a Cua
 *     Computer Server (Python HTTP service) for sandboxed computer use.
 *     This is the Docker-less path: Cua runs as a Python service on the
 *     host (or a remote VM) and exposes its computer-use API to Pi.
 *   - 'pi-cua-native': PiCuaNativeRunner — in-process variant of
 *     cua-pi. Calls `runAgentLoop` from `@earendil-works/pi-agent-core`
 *     directly, with custom Cua-backed `AgentTool[]` definitions. This
 *     is the programmatic, low-overhead path: no CLI fork, no JSONL
 *     parsing, full event-stream visibility.
 *   - 'windows-native': WindowsNativeRunner — runs Pi under a Win32
 *     restricted-token + job-object sandbox via Koffi FFI. Windows-only.
 *     Auto-selected on Windows when Cua and CuaPi are unavailable.
 *   - 'docker': legacy DockerAgentRunner / WslDockerAgentRunner — the
 *     pre-Cua OpenAI-only runner.
 *   - 'pi-direct': PiDirectRunner — runs the local `pi` CLI directly,
 *     without any sandbox (host-privileged, opt-in only).
 *
 * Backward compatibility: if `DYNFLOW_RUNNER` is unset, we try 'cua'
 * first (full Cua+Pi sandbox), then 'cua-pi' (Cua Computer Server path),
 * then 'windows-native' (Windows hosts only, no Docker), then fall
 * back to 'docker'. `pi-cua-native` and `pi-direct` are explicit-only —
 * they require `DYNFLOW_RUNNER=pi-cua-native` or `DYNFLOW_RUNNER=pi-direct`
 * respectively. `windows-native` is auto-selected on Windows when
 * nothing better is available, but can also be forced via
 * `DYNFLOW_RUNNER=windows-native`.
 */
export function createAgentRunner(override?: RuntimeConfig): AgentRunner {
  // If a runner override is provided, use it explicitly, bypassing env-var
  // checks and auto-detection.
  if (override?.runner) {
    return selectRunnerByName(override.runner);
  }

  const explicit = process.env.DYNFLOW_RUNNER;
  if (explicit === 'docker') {
    logger.info('Runner: docker (legacy, DYNFLOW_RUNNER=docker)');
    return selectDockerRunner();
  }
  if (explicit === 'cua') {
    logger.info('Runner: cua (default)');
    return new CuaAgentRunner();
  }
  if (explicit === 'cua-pi') {
    logger.info('Runner: cua-pi (Cua Computer Server + Pi, DYNFLOW_RUNNER=cua-pi)');
    return new CuaPiRunner();
  }
  if (explicit === 'pi-cua-native') {
    logger.info(
      'Runner: pi-cua-native (in-process Pi + Cua Computer Server, DYNFLOW_RUNNER=pi-cua-native)',
    );
    return new PiCuaNativeRunner();
  }
  if (explicit === 'pi-direct') {
    logger.info('Runner: pi-direct (opt-in, DYNFLOW_RUNNER=pi-direct)');
    return new PiDirectRunner();
  }
  if (explicit === 'windows-native') {
    logger.info('Runner: windows-native (opt-in, DYNFLOW_RUNNER=windows-native)');
    if (!WindowsNativeRunner.isAvailable()) {
      throw new Error(
        'windows-native runner requested but the host does not support it (Windows + Koffi required)',
      );
    }
    return new WindowsNativeRunner();
  }
  // Unset or unknown — try cua first, then cua-pi, then windows-native
  // (Windows hosts only), then docker. `pi-cua-native`, `pi-direct`, and
  // `windows-native` (when explicit) are NOT auto-selected — they
  // require an opt-in flag.
  if (CuaAgentRunner.isAvailable()) {
    logger.info('Runner: cua (auto-selected)');
    return new CuaAgentRunner();
  }
  if (CuaPiRunner.isAvailable()) {
    logger.info('Runner: cua-pi (auto-selected, Cua Computer Server + Pi)');
    return new CuaPiRunner();
  }
  if (WindowsNativeRunner.isAvailable()) {
    logger.info('Runner: windows-native (auto-selected, Win32 sandbox)');
    return new WindowsNativeRunner();
  }
  if (PiDirectRunner.isAvailable()) {
    logger.info(
      'Runner: local `pi` CLI detected. Set DYNFLOW_RUNNER=pi-direct to use it (no auto-fallback for security).',
    );
  }
  logger.warn('Runner: cua + cua-pi + windows-native unavailable, falling back to docker');
  return selectDockerRunner();
}

/**
 * Select a runner by its string identifier.
 * Throws a clear error if the runner is unknown.
 */
function selectRunnerByName(runnerId: string): AgentRunner {
  switch (runnerId) {
    case 'docker':
      logger.info('Runner: docker (override)');
      return selectDockerRunner();
    case 'cua':
      logger.info('Runner: cua (override)');
      return new CuaAgentRunner();
    case 'cua-pi':
      logger.info('Runner: cua-pi (override)');
      return new CuaPiRunner();
    case 'pi-cua-native':
      logger.info('Runner: pi-cua-native (override)');
      return new PiCuaNativeRunner();
    case 'pi-direct':
      logger.info('Runner: pi-direct (override)');
      return new PiDirectRunner();
    case 'windows-native':
      logger.info('Runner: windows-native (override)');
      if (!WindowsNativeRunner.isAvailable()) {
        throw new Error(
          'windows-native runner requested but the host does not support it (Windows + Koffi required)',
        );
      }
      return new WindowsNativeRunner();
    default:
      throw new Error(
        `Unknown runner: "${runnerId}". Valid runners: cua, cua-pi, pi-cua-native, pi-direct, windows-native, docker`,
      );
  }
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
