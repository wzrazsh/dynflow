import { useEffect, useState, useRef, useCallback } from 'react';
import type { SSEEvent } from '@dynflow/shared';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const MAX_RECONNECT_DELAY_MS = 30_000;
const INITIAL_RECONNECT_DELAY_MS = 1_000;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface SSEStatus {
  /** Whether the SSE connection is currently established. */
  connected: boolean;
  /** Whether we are in a reconnection loop. */
  reconnecting: boolean;
  /** Last connection error message, if any. */
  error: string | null;
}

// ---------------------------------------------------------------------------
// Hook
// ---------------------------------------------------------------------------

export function useSSE(workflowId: string | null) {
  const [events, setEvents] = useState<SSEEvent[]>([]);
  const [status, setStatus] = useState<SSEStatus>({
    connected: false,
    reconnecting: false,
    error: null,
  });
  const eventSourceRef = useRef<EventSource | null>(null);
  const reconnectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const reconnectAttemptRef = useRef(0);
  const mountedRef = useRef(true);

  const connect = useCallback(() => {
    if (!workflowId || !mountedRef.current) return;

    // Gracefully skip in environments without EventSource (e.g. jsdom tests)
    if (typeof EventSource === 'undefined') return;

    // Close any existing connection
    if (eventSourceRef.current) {
      eventSourceRef.current.close();
      eventSourceRef.current = null;
    }

    const es = new EventSource(`/api/workflows/${workflowId}/stream`);
    eventSourceRef.current = es;

    es.onopen = () => {
      if (!mountedRef.current) {
        es.close();
        return;
      }
      setStatus({ connected: true, reconnecting: false, error: null });
      reconnectAttemptRef.current = 0;
    };

    // Listen for all SSE event types via the generic message listener
    es.addEventListener('message', (e: MessageEvent) => {
      if (!mountedRef.current) return;
      try {
        const data = JSON.parse(e.data) as SSEEvent;
        setEvents((prev) => [...prev, data]);
      } catch {
        // ignore malformed messages
      }
    });

    // Listen for specific event types
    const types = [
      'agent_started',
      'agent_completed',
      'agent_failed',
      'agent_timeout',
      'phase_started',
      'phase_completed',
      'workflow_started',
      'workflow_completed',
      'workflow_failed',
      'workflow_paused',
      'workflow_stopped',
      'workflow_status',
      'workflow_recovering',
      'step_created',
      'step_started',
      'step_completed',
      'step_failed',
      'apply_conflict',
    ] as const;

    for (const type of types) {
      es.addEventListener(type, (e: Event) => {
        if (!mountedRef.current) return;
        try {
          const msg = e as MessageEvent;
          const data = JSON.parse(msg.data) as SSEEvent;
          setEvents((prev) => [...prev, { ...data, type } as SSEEvent]);
        } catch {
          // ignore malformed messages
        }
      });
    }

    es.onerror = () => {
      if (!mountedRef.current) return;
      es.close();
      eventSourceRef.current = null;

      setStatus({
        connected: false,
        reconnecting: true,
        error: 'SSE connection lost — reconnecting...',
      });

      // Schedule reconnect with exponential backoff
      const attempt = reconnectAttemptRef.current;
      const delay = Math.min(
        INITIAL_RECONNECT_DELAY_MS * Math.pow(2, attempt),
        MAX_RECONNECT_DELAY_MS,
      );
      reconnectAttemptRef.current = attempt + 1;

      reconnectTimerRef.current = setTimeout(() => {
        if (mountedRef.current) {
          connect();
        }
      }, delay);
    };
  }, [workflowId]);

  useEffect(() => {
    mountedRef.current = true;
    connect();

    return () => {
      mountedRef.current = false;

      if (eventSourceRef.current) {
        eventSourceRef.current.close();
        eventSourceRef.current = null;
      }
      if (reconnectTimerRef.current) {
        clearTimeout(reconnectTimerRef.current);
        reconnectTimerRef.current = null;
      }
    };
  }, [connect]);

  return { events, status };
}
