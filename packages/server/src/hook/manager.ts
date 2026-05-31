// ---------------------------------------------------------------------------
// Hook Manager — lightweight event system for workflow lifecycle hooks
// ---------------------------------------------------------------------------

export type HookEvent =
  | 'workflow_started'
  | 'workflow_completed'
  | 'workflow_failed'
  | 'phase_started'
  | 'phase_completed'
  | 'phase_failed'
  | 'agent_started'
  | 'agent_completed'
  | 'agent_failed'
  | 'orchestration_started'
  | 'orchestration_completed';

export interface HookContext {
  workflowId?: string;
  workflowName?: string;
  phaseId?: string;
  phaseName?: string;
  agentId?: string;
  agentName?: string;
  status?: string;
  error?: string;
  timestamp: string;
  [key: string]: unknown;
}

export type HookCallback = (context: HookContext) => void | Promise<void>;

/**
 * In-memory hook manager.
 *
 * - Register callbacks for lifecycle events
 * - Trigger all registered callbacks in parallel with error isolation
 * - Unregister individual callbacks or clear all
 */
export class HookManager {
  private readonly callbacks = new Map<HookEvent, Set<HookCallback>>();

  constructor() {
    // Initialise empty sets for all known events so getCallbacks() always
    // returns an array (empty if nothing registered).
    for (const event of ALL_EVENTS) {
      this.callbacks.set(event, new Set());
    }
  }

  // -----------------------------------------------------------------------
  // Registration
  // -----------------------------------------------------------------------

  /**
   * Register a callback for the given event.
   */
  register(event: HookEvent, callback: HookCallback): void {
    const set = this.callbacks.get(event);
    if (set) {
      set.add(callback);
    }
  }

  /**
   * Remove a previously registered callback.
   * Returns `true` if the callback was found and removed, `false` otherwise.
   */
  unregister(event: HookEvent, callback: HookCallback): boolean {
    const set = this.callbacks.get(event);
    if (!set) {
      return false;
    }
    return set.delete(callback);
  }

  // -----------------------------------------------------------------------
  // Execution
  // -----------------------------------------------------------------------

  /**
   * Trigger all callbacks registered for `event`.
   *
   * Callbacks are run in parallel via `Promise.all`. A single failing callback
   * does **not** prevent other callbacks from executing (error isolation).
   *
   * If multiple callbacks reject, only the **first** rejection reason is
   * re-thrown after all callbacks have settled.
   */
  async trigger(event: HookEvent, context: Partial<HookContext>): Promise<void> {
    const set = this.callbacks.get(event);
    if (!set || set.size === 0) {
      return;
    }

    const fullContext: HookContext = {
      ...context,
      timestamp: context.timestamp ?? new Date().toISOString(),
    };

    const results = await Promise.allSettled(
      [...set].map((cb) => cb(fullContext)),
    );

    // Collect rejections — if any callback failed, throw the first error.
    const rejections = results.filter(
      (r): r is PromiseRejectedResult => r.status === 'rejected',
    );

    if (rejections.length > 0) {
      throw rejections[0].reason;
    }
  }

  // -----------------------------------------------------------------------
  // Introspection
  // -----------------------------------------------------------------------

  /**
   * Return all event types that currently have at least one registered
   * callback.
   */
  getRegisteredEvents(): HookEvent[] {
    const result: HookEvent[] = [];
    for (const [event, set] of this.callbacks) {
      if (set.size > 0) {
        result.push(event);
      }
    }
    return result;
  }

  /**
   * Return all callbacks registered for a given event (a copy, so callers
   * cannot mutate internal state).
   */
  getCallbacks(event: HookEvent): HookCallback[] {
    const set = this.callbacks.get(event);
    if (!set) {
      return [];
    }
    return [...set];
  }

  // -----------------------------------------------------------------------
  // Cleanup
  // -----------------------------------------------------------------------

  /**
   * Remove **all** registered callbacks across every event type.
   */
  clear(): void {
    for (const [, set] of this.callbacks) {
      set.clear();
    }
  }
}

// ---------------------------------------------------------------------------
// Internal
// ---------------------------------------------------------------------------

const ALL_EVENTS: HookEvent[] = [
  'workflow_started',
  'workflow_completed',
  'workflow_failed',
  'phase_started',
  'phase_completed',
  'phase_failed',
  'agent_started',
  'agent_completed',
  'agent_failed',
  'orchestration_started',
  'orchestration_completed',
];
