import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { Response } from 'express';
import type { SSEEvent } from '@dynflow/shared';
import { StreamManager } from './stream-manager.js';
import {
  createWorkflowStartedEvent,
  createWorkflowPausedEvent,
  createWorkflowResumedEvent,
  createWorkflowCompletedEvent,
  createWorkflowFailedEvent,
  createWorkflowStoppedEvent,
  createPhaseStartedEvent,
  createPhaseCompletedEvent,
  createAgentStartedEvent,
  createAgentCompletedEvent,
  createAgentFailedEvent,
  createAgentTimeoutEvent,
} from './event-factory.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

interface MockResponse extends Response {
  _chunks: string[];
}

function mockResponse(): MockResponse {
  const chunks: string[] = [];
  return {
    write: vi.fn((chunk: string) => {
      chunks.push(chunk);
      return true;
    }),
    end: vi.fn(),
    _chunks: chunks,
  } as unknown as MockResponse;
}

function lastChunk(res: MockResponse): string {
  return res._chunks[res._chunks.length - 1] ?? '';
}

const WF = 'wf-1';
const WF2 = 'wf-2';

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

beforeEach(() => {
  StreamManager.resetInstance();
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('StreamManager', () => {
  describe('emit — single client', () => {
    it('1 — client receives events for subscribed workflow', () => {
      const mgr = StreamManager.getInstance();
      const res = mockResponse();
      mgr.addClient(WF, res);

      const event: SSEEvent = createWorkflowStartedEvent(WF);
      mgr.emit(WF, event);

      expect(res.write).toHaveBeenCalledTimes(1);
      const written = lastChunk(res);
      expect(written).toContain(`event: workflow_started`);
      expect(written).toContain(`data: ${JSON.stringify(event)}`);
    });

    it('2 — client does NOT receive events for unsubscribed workflow', () => {
      const mgr = StreamManager.getInstance();
      const res = mockResponse();
      mgr.addClient(WF, res);

      const event: SSEEvent = createWorkflowStartedEvent(WF2);
      mgr.emit(WF2, event);

      expect(res.write).not.toHaveBeenCalled();
    });
  });

  describe('emit — multiple clients', () => {
    it('3 — multiple clients watching same workflow all get events', () => {
      const mgr = StreamManager.getInstance();
      const res1 = mockResponse();
      const res2 = mockResponse();
      const res3 = mockResponse();
      mgr.addClient(WF, res1);
      mgr.addClient(WF, res2);
      mgr.addClient(WF, res3);

      const event: SSEEvent = createWorkflowCompletedEvent(WF);
      mgr.emit(WF, event);

      expect(res1.write).toHaveBeenCalledTimes(1);
      expect(res2.write).toHaveBeenCalledTimes(1);
      expect(res3.write).toHaveBeenCalledTimes(1);
    });
  });

  describe('removeClient', () => {
    it('4 — client removed, no more events received', () => {
      const mgr = StreamManager.getInstance();
      const res = mockResponse();
      const clientId = mgr.addClient(WF, res);

      mgr.removeClient(WF, clientId);
      const event: SSEEvent = createWorkflowPausedEvent(WF);
      mgr.emit(WF, event);

      expect(res.write).not.toHaveBeenCalled();
    });
  });

  describe('getClientCount', () => {
    it('5 — correctly counts active connections', () => {
      const mgr = StreamManager.getInstance();
      expect(mgr.getClientCount()).toBe(0);

      mgr.addClient(WF, mockResponse());
      mgr.addClient(WF, mockResponse());
      mgr.addClient(WF2, mockResponse());

      expect(mgr.getClientCount(WF)).toBe(2);
      expect(mgr.getClientCount(WF2)).toBe(1);
      expect(mgr.getClientCount()).toBe(3);
    });
  });

  describe('heartbeat', () => {
    beforeEach(() => {
      vi.useFakeTimers();
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    it('6 — starts when first client connects, stops when last disconnects', () => {
      const mgr = StreamManager.getInstance();
      const res1 = mockResponse();
      const res2 = mockResponse();

      // Add first client → heartbeat starts
      const id1 = mgr.addClient(WF, res1);
      expect(res1.write).not.toHaveBeenCalled();

      // Tick past heartbeat interval
      vi.advanceTimersByTime(15000);
      expect(res1.write).toHaveBeenCalledWith(': heartbeat\n\n');

      // Add second client
      const id2 = mgr.addClient(WF2, res2);
      vi.advanceTimersByTime(15000);
      expect(res1.write).toHaveBeenCalledWith(': heartbeat\n\n');
      expect(res2.write).toHaveBeenCalledWith(': heartbeat\n\n');

      // Remove first client (one still remains) → heartbeat continues
      mgr.removeClient(WF, id1);
      vi.advanceTimersByTime(15000);
      expect(res2.write).toHaveBeenCalledWith(': heartbeat\n\n');

      // Remove last client → heartbeat stops
      mgr.removeClient(WF2, id2);
      // Wait another interval — no more heartbeats
      vi.mocked(res1.write).mockClear();
      vi.mocked(res2.write).mockClear();
      vi.advanceTimersByTime(15000);
      expect(res1.write).not.toHaveBeenCalled();
      expect(res2.write).not.toHaveBeenCalled();
    });
  });

  describe('SSE format', () => {
    it('7 — emitted data follows SSE protocol format', () => {
      const mgr = StreamManager.getInstance();
      const res = mockResponse();
      mgr.addClient(WF, res);

      const event: SSEEvent = createWorkflowStartedEvent(WF);
      mgr.emit(WF, event);

      const written = lastChunk(res);
      // SSE format: id: N\nevent: TYPE\ndata: JSON\n\n
      expect(written).toMatch(/^id: \d+\nevent: workflow_started\ndata: .+\n\n$/);
    });
  });

  describe('event factories', () => {
    it('8 — each factory produces correct SSEEvent shape', () => {
      const now = Date.now();

      const started = createWorkflowStartedEvent(WF);
      expect(started.type).toBe('workflow_started');
      expect(started.workflowId).toBe(WF);
      expect(new Date(started.timestamp).getTime()).toBeGreaterThanOrEqual(now);

      const paused = createWorkflowPausedEvent(WF);
      expect(paused.type).toBe('workflow_paused');

      const resumed = createWorkflowResumedEvent(WF);
      expect(resumed.type).toBe('workflow_resumed');

      const completed = createWorkflowCompletedEvent(WF);
      expect(completed.type).toBe('workflow_completed');

      const failed = createWorkflowFailedEvent(WF, 'err');
      expect(failed.type).toBe('workflow_failed');
      expect(failed.data).toEqual({ error: 'err' });

      const stopped = createWorkflowStoppedEvent(WF);
      expect(stopped.type).toBe('workflow_stopped');

      const phaseStarted = createPhaseStartedEvent(WF, 'p1', 'Phase 1');
      expect(phaseStarted.type).toBe('phase_started');
      expect(phaseStarted.phaseId).toBe('p1');

      const phaseCompleted = createPhaseCompletedEvent(
        WF,
        'p1',
        'Phase 1',
        'completed',
      );
      expect(phaseCompleted.type).toBe('phase_completed');
      expect(phaseCompleted.status).toBe('completed');

      const agentStarted = createAgentStartedEvent(WF, 'p1', 'a1', 'Agent 1');
      expect(agentStarted.type).toBe('agent_started');
      expect(agentStarted.agentId).toBe('a1');

      const agentFailed = createAgentFailedEvent(
        WF,
        'p1',
        'a1',
        'Agent 1',
        'fail',
      );
      expect(agentFailed.type).toBe('agent_failed');
      expect(agentFailed.data).toEqual({ agentName: 'Agent 1', error: 'fail' });

      const agentTimeout = createAgentTimeoutEvent(WF, 'p1', 'a1', 'Agent 1');
      expect(agentTimeout.type).toBe('agent_timeout');
    });

    it('9 — agentCompleted includes output in data', () => {
      const event = createAgentCompletedEvent(
        WF,
        'p1',
        'a1',
        'Agent 1',
        'task output',
      );
      expect(event.type).toBe('agent_completed');
      expect(event.data).toEqual({
        agentName: 'Agent 1',
        output: 'task output',
      });
    });
  });

  describe('resetInstance', () => {
    it('10 — resets singleton state', () => {
      const mgr = StreamManager.getInstance();
      mgr.addClient(WF, mockResponse());
      expect(mgr.getClientCount()).toBe(1);

      StreamManager.resetInstance();
      const fresh = StreamManager.getInstance();
      expect(fresh.getClientCount()).toBe(0);
    });
  });
});
