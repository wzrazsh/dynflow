import type { WorkflowDefinition } from '@dynflow/shared';

/**
 * Result returned from executing a user workflow script.
 */
export interface SandboxResult {
  /** Whether the script was parsed successfully */
  success: boolean;
  /** The extracted workflow definition (only on success) */
  definition?: WorkflowDefinition;
  /** Human-readable error description (only on failure) */
  error?: string;
  /** Approximate line number where the error occurred */
  line?: number;
}

/**
 * Options that constrain sandbox execution.
 */
export interface SandboxOptions {
  /** Maximum wall-clock time in milliseconds */
  timeoutMs: number;
  /** Memory limit in megabytes (applied when using isolated-vm) */
  memoryLimitMb: number;
}
