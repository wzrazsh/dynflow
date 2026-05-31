import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import WorkflowList from './WorkflowList';
import { fetchWorkflows } from '../api/workflows';
import type { WorkflowRun } from '@dynflow/shared';

vi.mock('../api/workflows');

const mockWorkflows: WorkflowRun[] = [
  {
    id: '1',
    name: 'Test Workflow',
    status: 'running',
    phases: [
      { id: 'p1', name: 'Phase 1', status: 'running', agents: [{ id: 'a1', name: 'Agent 1', status: 'running', prompt: 'do stuff' }], order: 1 },
    ],
    createdAt: '2025-01-01T00:00:00Z',
    updatedAt: '2025-01-01T01:00:00Z',
  },
  {
    id: '2',
    name: 'Failed Job',
    status: 'failed',
    phases: [
      { id: 'p2', name: 'Phase 1', status: 'failed', agents: [{ id: 'a2', name: 'Agent 1', status: 'failed', prompt: 'do stuff' }], order: 1 },
      { id: 'p3', name: 'Phase 2', status: 'pending', agents: [], order: 2 },
    ],
    createdAt: '2025-01-02T00:00:00Z',
    updatedAt: '2025-01-02T02:00:00Z',
  },
];

describe('WorkflowList', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('renders loading state', () => {
    vi.mocked(fetchWorkflows).mockResolvedValueOnce({
      success: true,
      data: [],
      page: 1,
      pageSize: 20,
      total: 0,
    });

    render(<WorkflowList onSelect={() => {}} />);
    expect(screen.getByText('Loading...')).toBeDefined();
  });

  it('renders empty state when no workflows', async () => {
    vi.mocked(fetchWorkflows).mockResolvedValueOnce({
      success: true,
      data: [],
      page: 1,
      pageSize: 20,
      total: 0,
    });

    render(<WorkflowList onSelect={() => {}} />);

    await waitFor(() => {
      expect(screen.getByText('No workflows yet. Create your first workflow.')).toBeDefined();
    });
  });

  it('renders workflow items with status badges', async () => {
    vi.mocked(fetchWorkflows).mockResolvedValueOnce({
      success: true,
      data: mockWorkflows,
      page: 1,
      pageSize: 20,
      total: 2,
    });

    render(<WorkflowList onSelect={() => {}} />);

    await waitFor(() => {
      expect(screen.getByText('Test Workflow')).toBeDefined();
      expect(screen.getByText('Failed Job')).toBeDefined();
      expect(screen.getByText('running')).toBeDefined();
      expect(screen.getByText('failed')).toBeDefined();
    });
  });

  it('renders agent and phase counts', async () => {
    vi.mocked(fetchWorkflows).mockResolvedValueOnce({
      success: true,
      data: mockWorkflows,
      page: 1,
      pageSize: 20,
      total: 2,
    });

    render(<WorkflowList onSelect={() => {}} />);

    await waitFor(() => {
      expect(screen.getByText(/1 phase\(s\) \| 1 agent\(s\)/)).toBeDefined();
      expect(screen.getByText(/2 phase\(s\) \| 1 agent\(s\)/)).toBeDefined();
    });
  });

  it('auto-refresh triggers on interval', () => {
    vi.useFakeTimers();

    vi.mocked(fetchWorkflows).mockResolvedValue({
      success: true,
      data: mockWorkflows,
      page: 1,
      pageSize: 20,
      total: 2,
    });

    render(<WorkflowList onSelect={() => {}} />);

    // Initial fetch on mount
    expect(fetchWorkflows).toHaveBeenCalledTimes(1);

    // Advance time past the 5s interval
    vi.advanceTimersByTime(5000);

    expect(fetchWorkflows).toHaveBeenCalledTimes(2);

    vi.useRealTimers();
  });

  it('renders error state when fetch fails', async () => {
    vi.mocked(fetchWorkflows).mockRejectedValue(new Error('Network error'));

    render(<WorkflowList onSelect={() => {}} />);

    const errorEl = await screen.findByText(/Error:/);
    expect(errorEl).toBeDefined();
  });
});
