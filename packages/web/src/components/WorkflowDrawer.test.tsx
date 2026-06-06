import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, waitFor, cleanup } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import WorkflowDrawer from './WorkflowDrawer';

vi.mock('../api/workflows', () => ({
  fetchWorkflow: vi.fn(),
}));

import { fetchWorkflow } from '../api/workflows';
import type { WorkflowRun, ApiResponse } from '@dynflow/shared';

const baseWorkflow: WorkflowRun = {
  id: 'wf-1',
  name: 'Test Workflow',
  status: 'completed',
  phases: [
    {
      id: 'p1',
      name: 'Phase 1',
      status: 'completed',
      agents: [
        { id: 'a1', name: 'Agent-1', status: 'completed', prompt: 'Test prompt' },
      ],
      order: 0,
    },
  ],
  createdAt: '2025-06-01T00:00:00Z',
  updatedAt: '2025-06-01T01:00:00Z',
};

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('WorkflowDrawer', () => {
  it('renders drawer with workflow details', async () => {
    vi.mocked(fetchWorkflow).mockResolvedValue({
      success: true,
      data: baseWorkflow,
    } as ApiResponse<WorkflowRun>);

    render(<WorkflowDrawer workflowId="wf-1" onClose={() => {}} />);
    await waitFor(() => expect(screen.getByText('Test Workflow')).toBeDefined());
    await waitFor(() => {
      const badges = screen.getAllByText(/completed/);
      expect(badges.length).toBeGreaterThanOrEqual(1);
    });
  });

  it('calls onClose when X button is clicked', async () => {
    const onClose = vi.fn();
    const user = userEvent.setup();
    vi.mocked(fetchWorkflow).mockResolvedValue({
      success: true,
      data: baseWorkflow,
    } as ApiResponse<WorkflowRun>);

    render(<WorkflowDrawer workflowId="wf-1" onClose={onClose} />);
    await waitFor(() => expect(screen.getByText('Test Workflow')).toBeDefined());
    await user.click(screen.getByRole('button', { name: /close/i }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('calls onClose when overlay backdrop is clicked', async () => {
    const onClose = vi.fn();
    const user = userEvent.setup();
    vi.mocked(fetchWorkflow).mockResolvedValue({
      success: true,
      data: baseWorkflow,
    } as ApiResponse<WorkflowRun>);

    const { container } = render(<WorkflowDrawer workflowId="wf-1" onClose={onClose} />);
    await waitFor(() => expect(screen.getByText('Test Workflow')).toBeDefined());
    // Click the overlay backdrop (directly on the overlay div, not the drawer panel)
    const overlay = container.firstElementChild as HTMLElement;
    await user.click(overlay);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('does NOT call onClose when drawer panel content is clicked', async () => {
    const onClose = vi.fn();
    const user = userEvent.setup();
    vi.mocked(fetchWorkflow).mockResolvedValue({
      success: true,
      data: baseWorkflow,
    } as ApiResponse<WorkflowRun>);

    render(<WorkflowDrawer workflowId="wf-1" onClose={onClose} />);
    await waitFor(() => expect(screen.getByText('Test Workflow')).toBeDefined());
    // Click the drawer header title (first occurrence) to verify drawer panel doesn't close
    await user.click(screen.getAllByText('Test Workflow')[0]);
    expect(onClose).not.toHaveBeenCalled();
  });

  it('shows "View Code" button when script exists', async () => {
    vi.mocked(fetchWorkflow).mockResolvedValue({
      success: true,
      data: { ...baseWorkflow, script: 'workflow("test", () => {})' },
    } as ApiResponse<WorkflowRun>);

    render(<WorkflowDrawer workflowId="wf-1" onClose={() => {}} />);
    await waitFor(() => expect(screen.getByText('View Code')).toBeDefined());
  });

  it('hides "View Code" button when script is undefined', async () => {
    vi.mocked(fetchWorkflow).mockResolvedValue({
      success: true,
      data: baseWorkflow,
    } as ApiResponse<WorkflowRun>);

    render(<WorkflowDrawer workflowId="wf-1" onClose={() => {}} />);
    await waitFor(() => expect(screen.getByText('Test Workflow')).toBeDefined());
    expect(screen.queryByText('View Code')).toBeNull();
  });
});
