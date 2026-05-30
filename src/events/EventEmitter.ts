import type { WorkflowEvent } from '../types/events.js';

type EventHandlerFn = (event: WorkflowEvent) => void | Promise<void>;

/**
 * Typed event emitter for workflow events.
 * Supports history buffer and async handler fire-and-forget.
 */
export class EventEmitter {
  private handlers: Set<EventHandlerFn> = new Set();
  private history: WorkflowEvent[] = [];

  /**
   * Subscribe to events. Returns an unsubscribe function.
   */
  on(handler: EventHandlerFn): () => void {
    this.handlers.add(handler);
    return () => this.handlers.delete(handler);
  }

  /**
   * Unsubscribe from events.
   */
  off(handler: EventHandlerFn): void {
    this.handlers.delete(handler);
  }

  /**
   * Emit an event to all subscribers. Async handlers are fire-and-forget.
   */
  emit(event: WorkflowEvent): void {
    this.history.push(event);
    for (const handler of this.handlers) {
      try {
        void handler(event);
      } catch {
        // Suppress sync handler errors to prevent runtime crashes
      }
    }
  }

  /**
   * Get all emitted events (for replay or late subscribers).
   */
  getHistory(): ReadonlyArray<WorkflowEvent> {
    return this.history;
  }

  /**
   * Clear event history.
   */
  clearHistory(): void {
    this.history = [];
  }

  /**
   * Wait for a specific event type. Useful in tests.
   */
  waitFor(eventType: WorkflowEvent['type'], timeoutMs = 5000): Promise<WorkflowEvent> {
    return new Promise((resolve, reject) => {
      const off = this.on(event => {
        if (event.type === eventType) {
          off();
          resolve(event);
        }
      });
      setTimeout(() => {
        off();
        reject(new Error(`Timeout waiting for ${eventType}`));
      }, timeoutMs);
    });
  }

  /**
   * Remove all handlers.
   */
  clear(): void {
    this.handlers.clear();
  }
}
