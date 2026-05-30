/**
 * Base error class for all workflow-related errors.
 */
export class WorkflowError extends Error {
  constructor(message: string, public readonly code: string) {
    super(message);
    this.name = 'WorkflowError';
  }
}

/**
 * Error thrown when an LLM call fails.
 */
export class LLMError extends WorkflowError {
  constructor(message: string, public readonly statusCode?: number) {
    super(message, 'LLM_ERROR');
    this.name = 'LLMError';
  }
}

/**
 * Error thrown for invalid configuration.
 */
export class ConfigurationError extends WorkflowError {
  constructor(message: string) {
    super(message, 'CONFIG_ERROR');
    this.name = 'ConfigurationError';
  }
}
