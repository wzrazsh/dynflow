import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor, cleanup } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import WorkflowList from './WorkflowList';
import { fetchWorkflows } from '../api/workflows';
import { fetchTemplates } from '../api/templates';
import type { WorkflowRun } from '@dynflow/shared';

vi.mock('../api/workflows');
vi.mock('../api/templates');

const mockWorkflows: WorkflowRun[] = [
  {
    id: '1',
    name: 'Test Workflow',
    status: 'running',
    phases: [
      { id: 'p1', name: 'Phase 1', status: 'running', agents: [{ id: 'a1', name: 'Agent 1', status: 'running', prompt: 'do stuff' }], order: 1 },
    ],
    createdAt: '2025-06-01T00:00:00Z',
    updatedAt: '2025-06-01T01:00:00Z',
  },
  {
    id: '2',
    name: 'Failed Job',
    status: 'failed',
    phases: [
      { id: 'p2', name: 'Phase 1', status: 'failed', agents: [{ id: 'a2', name: 'Agent 1', status: 'failed', prompt: 'do stuff' }], order: 1 },
      { id: 'p3', name: 'Phase 2', status: 'pending', agents: [], order: 2 },
    ],
    createdAt: '2025-06-02T00:00:00Z',
    updatedAt: '2025-06-02T02:00:00Z',
  },
];

function mockResponse(data: WorkflowRun[], total = 2) {
  return { success: true, data, page: 1, pageSize: 10, total };
}

describe('WorkflowList', () => {
  beforeEach(() => {
    // Always restore real timers so leaking fake timers from a timed-out test
    // don't break subsequent tests' waitFor / findBy* queries.
    vi.useRealTimers();
    vi.clearAllMocks();
    vi.mocked(fetchTemplates).mockResolvedValue({
      success: true,
      data: [
        { id: 't1', name: 'MathQuest', description: 'Math game', workflowCount: 5 },
        { id: 't2', name: 'Release', description: 'Release check', workflowCount: 2 },
      ],
    });
  });

  afterEach(() => {
    cleanup();
  });

  it('1 — renders 4 filter inputs', async () => {
    vi.mocked(fetchWorkflows).mockResolvedValue(mockResponse([]));
    render(<WorkflowList onSelect={() => {}} />);

    await waitFor(() => {
      expect(screen.getByPlaceholderText(/filter by name/i)).toBeDefined();
    });
    expect(screen.getByRole('combobox', { name: /status/i })).toBeDefined();
    expect(screen.getByRole('combobox', { name: /template/i })).toBeDefined();
    expect(screen.getByRole('combobox', { name: /time|period/i })).toBeDefined();
  });

  it('2 — calls fetchWorkflows with defaults on mount', async () => {
    vi.mocked(fetchWorkflows).mockResolvedValue(mockResponse([]));
    render(<WorkflowList onSelect={() => {}} />);

    await waitFor(() => {
      expect(fetchWorkflows).toHaveBeenCalledWith(1, 10, {}, expect.any(AbortSignal));
    });
  });

  it('3 — name input triggers fetch with name filter after debounce', async () => {
    vi.mocked(fetchWorkflows).mockResolvedValue(mockResponse(mockWorkflows));
    const user = userEvent.setup();

    render(<WorkflowList onSelect={() => {}} />);

    const nameInput = screen.getByPlaceholderText(/filter by name/i);
    await user.type(nameInput, 'Test');

    // Wait for the 300ms debounce to fire (use real timers)
    await new Promise((r) => { setTimeout(r, 400); });

    expect(fetchWorkflows).toHaveBeenCalledWith(1, 10, { name: 'Test' }, expect.any(AbortSignal));
  }, 10000);

  it('4 — status select triggers fetch with status filter', async () => {
    vi.mocked(fetchWorkflows).mockResolvedValue(mockResponse(mockWorkflows));
    const user = userEvent.setup();

    render(<WorkflowList onSelect={() => {}} />);

    const statusSelect = await screen.findByRole('combobox', { name: /status/i });
    await user.selectOptions(statusSelect, 'running');

    await waitFor(() => {
      expect(fetchWorkflows).toHaveBeenCalledWith(1, 10, expect.objectContaining({ status: 'running' }), expect.any(AbortSignal));
    });
  });

  it('5 — filter change resets page to 1', async () => {
    vi.mocked(fetchWorkflows).mockResolvedValue(mockResponse(mockWorkflows));
    const user = userEvent.setup();

    render(<WorkflowList onSelect={() => {}} />);

    const statusSelect = await screen.findByRole('combobox', { name: /status/i });
    await user.selectOptions(statusSelect, 'completed');

    await waitFor(() => {
      expect(fetchWorkflows).toHaveBeenCalledWith(1, 10, expect.objectContaining({ status: 'completed' }), expect.any(AbortSignal));
    });
  });

  it('6 — click workflow row calls onSelect(id)', async () => {
    const onSelect = vi.fn();
    vi.mocked(fetchWorkflows).mockResolvedValue(mockResponse(mockWorkflows));
    const user = userEvent.setup();

    render(<WorkflowList onSelect={onSelect} />);

    await screen.findByText('Test Workflow');
    await user.click(screen.getByText('Test Workflow'));
    expect(onSelect).toHaveBeenCalledWith('1');
  });

  it('7 — renders pagination controls', async () => {
    const items = Array.from({ length: 25 }, (_, i) => ({
      ...mockWorkflows[0],
      id: String(i + 1),
      name: `Wf ${i + 1}`,
    }));
    vi.mocked(fetchWorkflows).mockResolvedValue(mockResponse(items, 25));

    render(<WorkflowList onSelect={() => {}} />);

    await screen.findByText(/page 1 of 3/i);

    const prevBtn = screen.getByText(/previous/i) as HTMLButtonElement;
    expect(prevBtn.disabled).toBe(true);

    const nextBtn = screen.getByText(/next/i) as HTMLButtonElement;
    expect(nextBtn.disabled).toBe(false);
  });

  it('8 — paginates on next click', async () => {
    const items = Array.from({ length: 25 }, (_, i) => ({
      ...mockWorkflows[0],
      id: String(i + 1),
      name: `Wf ${i + 1}`,
    }));
    vi.mocked(fetchWorkflows).mockResolvedValue(mockResponse(items, 25));
    const user = userEvent.setup();

    render(<WorkflowList onSelect={() => {}} />);

    await screen.findByText(/page 1 of 3/i);

    const nextBtn = screen.getByText(/next/i);
    await user.click(nextBtn);

    await screen.findByText(/page 2 of 3/i);
  });

  it('9 — shows empty filter state when no results match', async () => {
    vi.mocked(fetchWorkflows).mockResolvedValue(mockResponse([], 0));
    const user = userEvent.setup();
    render(<WorkflowList onSelect={() => {}} />);

    // Set a filter so the component shows "No workflows match..." instead of "No workflows yet"
    const statusSelect = await screen.findByRole('combobox', { name: /status/i });
    await user.selectOptions(statusSelect, 'running');

    await screen.findByText(/no workflows match/i);
    expect(screen.getByText(/clear filters/i)).toBeDefined();
  });

  it('10 — auto-refresh preserves current filters and page', async () => {
    vi.useFakeTimers();
    vi.mocked(fetchWorkflows).mockResolvedValue(mockResponse(mockWorkflows, 25));

    render(<WorkflowList onSelect={() => {}} />);

    // Initial mount fetch happens synchronously inside the effect
    expect(fetchWorkflows).toHaveBeenCalledTimes(1);

    // Advance 5s — the auto-refresh interval callback fires
    vi.advanceTimersByTime(5000);
    expect(fetchWorkflows).toHaveBeenCalledTimes(2);

    // Both calls should be with the same default args
    expect(fetchWorkflows).toHaveBeenCalledWith(1, 10, {}, expect.any(AbortSignal));

    vi.useRealTimers();
  });

  it('11 — Prev button disabled on page 1, Next disabled on last page', async () => {
    // Only 2 items, pageSize=10 → 1 page total
    vi.mocked(fetchWorkflows).mockResolvedValue(mockResponse(mockWorkflows, 2));
    render(<WorkflowList onSelect={() => {}} />);

    await screen.findByText(/page 1 of 1/i);

    expect((screen.getByText(/previous/i) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByText(/next/i) as HTMLButtonElement).disabled).toBe(true);
  });

  it('12 — renders error state when fetch fails', async () => {
    vi.mocked(fetchWorkflows).mockRejectedValue(new Error('Network error'));
    render(<WorkflowList onSelect={() => {}} />);

    const errorEl = await screen.findByText(/Error:/);
    expect(errorEl).toBeDefined();
  });
});
