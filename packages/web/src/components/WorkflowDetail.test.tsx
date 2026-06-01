import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor, cleanup } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import WorkflowDetail from './WorkflowDetail';

// Mock the API module
vi.mock('../api/workflows', () => ({
  fetchWorkflow: vi.fn(),
  controlWorkflow: vi.fn(),
}));

import { fetchWorkflow, controlWorkflow } from '../api/workflows';

const mockWorkflow = {
  id: 'wf-1',
  name: 'Test Workflow',
  status: 'pending',
  createdAt: '2024-01-15T10:00:00.000Z',
  updatedAt: '2024-01-15T10:00:00.000Z',
  phases: [
    {
      id: 'phase-1',
      name: 'Research',
      status: 'pending',
      order: 0,
      agents: [
        {
          id: 'agent-1',
          name: 'researcher-1',
          status: 'pending',
          prompt: 'Research quantum computing impact on cryptography',
        },
        {
          id: 'agent-2',
          name: 'researcher-2',
          status: 'completed',
          prompt: 'Research post-quantum cryptography standards',
          output: 'Found 3 major standards: CRYSTALS-Kyber, CRYSTALS-Dilithium, Falcon',
        },
      ],
    },
    {
      id: 'phase-2',
      name: 'Synthesis',
      status: 'pending',
      order: 1,
      agents: [
        {
          id: 'agent-3',
          name: 'synthesizer',
          status: 'failed',
          prompt: 'Synthesize findings into a report',
          error: 'Agent execution failed: API timeout',
        },
      ],
    },
  ],
};

const runningWorkflow = { ...mockWorkflow, status: 'running' };
const pausedWorkflow = { ...mockWorkflow, status: 'paused' };
const completedWorkflow = { ...mockWorkflow, status: 'completed' };

describe('WorkflowDetail', () => {
  const onBack = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    cleanup();
  });

  it('shows loading state initially', () => {
    vi.mocked(fetchWorkflow).mockReturnValue(new Promise(() => {}));
    render(<WorkflowDetail workflowId="wf-1" onBack={onBack} />);
    expect(screen.getByText('Loading...')).toBeDefined();
  });

  it('renders workflow details after loading', async () => {
    vi.mocked(fetchWorkflow).mockResolvedValue({ success: true, data: mockWorkflow });
    render(<WorkflowDetail workflowId="wf-1" onBack={onBack} />);
    await waitFor(() => expect(screen.getByText('Test Workflow')).toBeDefined());
    expect(screen.getAllByText('pending').length).toBeGreaterThanOrEqual(1);
    expect(screen.getByText('Phases (2)')).toBeDefined();
  });

  it('shows Start button for pending workflow', async () => {
    vi.mocked(fetchWorkflow).mockResolvedValue({ success: true, data: mockWorkflow });
    render(<WorkflowDetail workflowId="wf-1" onBack={onBack} />);
    await waitFor(() => expect(screen.getByRole('button', { name: 'Start' })).toBeDefined());
  });

  it('shows Pause and Stop buttons for running workflow', async () => {
    vi.mocked(fetchWorkflow).mockResolvedValue({ success: true, data: runningWorkflow });
    render(<WorkflowDetail workflowId="wf-1" onBack={onBack} />);
    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Pause' })).toBeDefined();
      expect(screen.getByRole('button', { name: 'Stop' })).toBeDefined();
    });
  });

  it('shows Resume and Stop buttons for paused workflow', async () => {
    vi.mocked(fetchWorkflow).mockResolvedValue({ success: true, data: pausedWorkflow });
    render(<WorkflowDetail workflowId="wf-1" onBack={onBack} />);
    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Resume' })).toBeDefined();
      expect(screen.getByRole('button', { name: 'Stop' })).toBeDefined();
    });
  });

  it('does not show control buttons for completed workflow', async () => {
    vi.mocked(fetchWorkflow).mockResolvedValue({ success: true, data: completedWorkflow });
    render(<WorkflowDetail workflowId="wf-1" onBack={onBack} />);
    await waitFor(() => expect(screen.getByText('Test Workflow')).toBeDefined());
    expect(screen.queryByRole('button', { name: 'Start' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Pause' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Stop' })).toBeNull();
  });

  it('calls controlWorkflow when Start is clicked', async () => {
    const user = userEvent.setup();
    vi.mocked(fetchWorkflow).mockResolvedValue({ success: true, data: mockWorkflow });
    vi.mocked(controlWorkflow).mockResolvedValue({ success: true, data: { status: 'running' } });
    render(<WorkflowDetail workflowId="wf-1" onBack={onBack} />);
    await waitFor(() => expect(screen.getByRole('button', { name: 'Start' })).toBeDefined());
    await user.click(screen.getByRole('button', { name: 'Start' }));
    await waitFor(() => expect(controlWorkflow).toHaveBeenCalledWith('wf-1', 'start'));
  });

  it('expands phase to show agents', async () => {
    const user = userEvent.setup();
    vi.mocked(fetchWorkflow).mockResolvedValue({ success: true, data: mockWorkflow });
    render(<WorkflowDetail workflowId="wf-1" onBack={onBack} />);
    await waitFor(() => expect(screen.getByText('Research')).toBeDefined());
    await user.click(screen.getByText('Research'));
    expect(screen.getByText('researcher-1')).toBeDefined();
    expect(screen.getByText('researcher-2')).toBeDefined();
  });

  it('shows agent output when expanded', async () => {
    const user = userEvent.setup();
    vi.mocked(fetchWorkflow).mockResolvedValue({ success: true, data: mockWorkflow });
    render(<WorkflowDetail workflowId="wf-1" onBack={onBack} />);
    await waitFor(() => expect(screen.getByText('Research')).toBeDefined());
    await user.click(screen.getByText('Research'));
    expect(screen.getByText(/Found 3 major standards: CRYSTALS-Kyber/)).toBeDefined();
  });

  it('shows agent error when expanded', async () => {
    const user = userEvent.setup();
    vi.mocked(fetchWorkflow).mockResolvedValue({ success: true, data: mockWorkflow });
    render(<WorkflowDetail workflowId="wf-1" onBack={onBack} />);
    await waitFor(() => expect(screen.getByText('Synthesis')).toBeDefined());
    await user.click(screen.getByText('Synthesis'));
    expect(screen.getByText(/Agent execution failed: API timeout/)).toBeDefined();
  });

  it('shows error state when fetch fails', async () => {
    vi.mocked(fetchWorkflow).mockResolvedValue({ success: false, error: 'Workflow not found' });
    render(<WorkflowDetail workflowId="wf-1" onBack={onBack} />);
    await waitFor(() => expect(screen.getByText('Workflow not found')).toBeDefined());
  });

  it('calls onBack when back button is clicked', async () => {
    const user = userEvent.setup();
    vi.mocked(fetchWorkflow).mockResolvedValue({ success: true, data: mockWorkflow });
    render(<WorkflowDetail workflowId="wf-1" onBack={onBack} />);
    await waitFor(() => expect(screen.getByText('Test Workflow')).toBeDefined());
    await user.click(screen.getByRole('button', { name: /Back to list/i }));
    expect(onBack).toHaveBeenCalledTimes(1);
  });
});