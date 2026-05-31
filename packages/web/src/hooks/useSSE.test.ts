import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';
import { useSSE } from './useSSE';

interface MockEventSource extends EventSource {
  mockMessage: (type: string, data: unknown) => void;
  listeners: Map<string, Set<(event: Event) => void>>;
}

function createMockEventSource(): MockEventSource {
  const listeners = new Map<string, Set<(event: Event) => void>>();
  return {
    CONNECTING: 0, OPEN: 1, CLOSED: 2,
    readyState: 0, url: '', withCredentials: false,
    onopen: null, onmessage: null, onerror: null,
    listeners,
    close: vi.fn(),
    dispatchEvent: vi.fn(),
    addEventListener: vi.fn((type: string, handler: EventListenerOrEventListenerObject) => {
      if (!listeners.has(type)) listeners.set(type, new Set());
      listeners.get(type)!.add(handler as (event: Event) => void);
    }),
    removeEventListener: vi.fn(),
    mockMessage(type: string, data: unknown) {
      const handlers = listeners.get(type);
      if (handlers) {
        const event = new MessageEvent(type, { data: JSON.stringify(data) });
        handlers.forEach((h) => h(event));
      }
    },
  };
}

describe('useSSE', () => {
  let mockEventSource: MockEventSource;
  let eventSourceFactory: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    mockEventSource = createMockEventSource();
    eventSourceFactory = vi.fn(() => mockEventSource);
    vi.stubGlobal('EventSource', eventSourceFactory);
  });

  afterEach(() => { vi.unstubAllGlobals(); });

  it('handles null workflowId', () => {
    const { result } = renderHook(() => useSSE(null));
    expect(result.current.events).toEqual([]);
    expect(eventSourceFactory).not.toHaveBeenCalled();
  });

  it('creates EventSource for workflowId', () => {
    renderHook(() => useSSE('wf-1'));
    expect(eventSourceFactory).toHaveBeenCalledWith('/api/workflows/wf-1/stream');
  });

  it('receives message events', async () => {
    const { result } = renderHook(() => useSSE('wf-1'));
    await waitFor(() => expect(mockEventSource.addEventListener).toHaveBeenCalled());
    act(() => {
      mockEventSource.mockMessage('message', { type: 'workflow_started', workflowId: 'wf-1', timestamp: '2024-01-01T00:00:00Z' });
    });
    expect(result.current.events).toHaveLength(1);
    expect(result.current.events[0].type).toBe('workflow_started');
  });

  it('handles malformed JSON gracefully', async () => {
    const { result } = renderHook(() => useSSE('wf-1'));
    await waitFor(() => expect(mockEventSource.addEventListener).toHaveBeenCalled());
    act(() => {
      const handlers = mockEventSource.listeners.get('message');
      if (handlers) handlers.forEach((h) => h(new MessageEvent('message', { data: 'not json' })));
    });
    expect(result.current.events).toEqual([]);
  });

  it('receives typed events', async () => {
    const { result } = renderHook(() => useSSE('wf-1'));
    await waitFor(() => expect(mockEventSource.addEventListener).toHaveBeenCalled());
    act(() => {
      mockEventSource.mockMessage('agent_started', { workflowId: 'wf-1', agentId: 'agent-1', phaseId: 'phase-1', timestamp: '2024-01-01T00:00:00Z' });
    });
    expect(result.current.events).toHaveLength(1);
    expect(result.current.events[0].type).toBe('agent_started');
  });

  it('closes connection on unmount', () => {
    const { unmount } = renderHook(() => useSSE('wf-1'));
    unmount();
    expect(mockEventSource.close).toHaveBeenCalledTimes(1);
  });

  it('reconnects when workflowId changes', () => {
    const { rerender } = renderHook(({ id }) => useSSE(id), { initialProps: { id: 'wf-1' as string | null } });
    rerender({ id: 'wf-2' });
    expect(mockEventSource.close).toHaveBeenCalledTimes(1);
    expect(eventSourceFactory).toHaveBeenCalledWith('/api/workflows/wf-2/stream');
  });
});