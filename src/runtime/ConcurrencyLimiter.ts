import { ConfigurationError } from '../errors.js';

/**
 * Async semaphore that limits concurrent execution.
 * Fair (FIFO queue) and works with Promise.all + Array.map.
 */
export class ConcurrencyLimiter {
  private running = 0;
  private queue: Array<() => void> = [];

  constructor(private max: number) {
    if (typeof max !== 'number' || !Number.isInteger(max) || max <= 0) {
      throw new ConfigurationError('Concurrency must be a positive integer');
    }
  }

  /**
   * Run a function with concurrency control.
   */
  async run<T>(fn: () => Promise<T>): Promise<T> {
    if (this.running >= this.max) {
      await new Promise<void>(resolve => this.queue.push(resolve));
    }
    this.running++;
    try {
      return await fn();
    } finally {
      this.running--;
      if (this.queue.length > 0) {
        this.queue.shift()!();
      }
    }
  }

  /**
   * Number of currently running tasks.
   */
  get activeCount(): number {
    return this.running;
  }

  /**
   * Number of tasks waiting in queue.
   */
  get queuedCount(): number {
    return this.queue.length;
  }
}
