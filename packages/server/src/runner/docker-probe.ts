import { execSync } from 'node:child_process';

/**
 * Maximum time, in milliseconds, that `isAvailable()` probes are allowed to
 * block. The underlying `docker info` / `wsl -- docker info` calls can hang
 * indefinitely if the Docker daemon is unresponsive (Docker Desktop
 * installed but stopped, hung WSL distro, blocked named-pipe, etc.) — that
 * used to wedge `/api/system/info` for the entire Express request. Capping
 * the probe at this budget keeps the system-info endpoint bounded.
 */
export const DOCKER_PROBE_TIMEOUT_MS = 3000;

/**
 * Run a `docker info`-style probe with a hard timeout.
 *
 * Returns `true` only when the command exits successfully within the
 * budget. Any non-zero exit, missing binary, or timeout yields `false`.
 *
 * `command` may be either a plain `docker info` style invocation or a
 * `wsl -d <distro> -- docker info` style invocation; both are passed
 * through verbatim to `execSync`.
 */
export function probeDockerAvailability(command: string): boolean {
  try {
    execSync(command, {
      stdio: 'ignore',
      timeout: DOCKER_PROBE_TIMEOUT_MS,
    });
    return true;
  } catch {
    return false;
  }
}