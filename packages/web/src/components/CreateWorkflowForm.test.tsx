import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import CreateWorkflowForm from './CreateWorkflowForm';

vi.mock('../api/workflows', () => ({ createWorkflow: vi.fn() }));
import { createWorkflow } from '../api/workflows';

describe('CreateWorkflowForm', () => {
  const onBack = vi.fn();
  const onCreated = vi.fn();

  beforeEach(() => vi.clearAllMocks());
  afterEach(() => cleanup());

  it('renders form elements', () => {
    render(<CreateWorkflowForm onBack={onBack} onCreated={onCreated} />);
    expect(screen.getByLabelText('Workflow Name')).toBeDefined();
    expect(screen.getByLabelText('Workflow Script')).toBeDefined();
    expect(screen.getByRole('button', { name: 'Create Workflow' })).toBeDefined();
  });

  it('shows error when submitting with empty name', async () => {
    const user = userEvent.setup();
    render(<CreateWorkflowForm onBack={onBack} onCreated={onCreated} />);
    await user.click(screen.getByRole('button', { name: /Create Workflow/i }));
    expect(screen.getByText('Workflow name is required')).toBeDefined();
    expect(createWorkflow).not.toHaveBeenCalled();
  });

  it('shows error when submitting with empty script', async () => {
    const user = userEvent.setup();
    render(<CreateWorkflowForm onBack={onBack} onCreated={onCreated} />);
    await user.type(screen.getByLabelText('Workflow Name'), 'Test Workflow');
    await user.click(screen.getByRole('button', { name: /Create Workflow/i }));
    expect(screen.getByText('Workflow script is required')).toBeDefined();
    expect(createWorkflow).not.toHaveBeenCalled();
  });

  it('submits successfully and calls onCreated', async () => {
    const user = userEvent.setup();
    vi.mocked(createWorkflow).mockResolvedValue({ success: true, data: { id: 'wf-1', name: 'Test', status: 'pending', phases: [], createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() } });
    render(<CreateWorkflowForm onBack={onBack} onCreated={onCreated} />);
    await user.type(screen.getByLabelText('Workflow Name'), 'Test Workflow');
    await user.type(screen.getByLabelText('Workflow Script'), 'script');
    await user.click(screen.getByRole('button', { name: /Create Workflow/i }));
    expect(createWorkflow).toHaveBeenCalled();
    expect(onCreated).toHaveBeenCalledTimes(1);
  });

  it('shows API error message on failure', async () => {
    const user = userEvent.setup();
    vi.mocked(createWorkflow).mockResolvedValue({ success: false, error: 'Script validation failed' });
    render(<CreateWorkflowForm onBack={onBack} onCreated={onCreated} />);
    await user.type(screen.getByLabelText('Workflow Name'), 'Test');
    await user.type(screen.getByLabelText('Workflow Script'), 'bad script');
    await user.click(screen.getByRole('button', { name: /Create Workflow/i }));
    expect(screen.getByText('Script validation failed')).toBeDefined();
  });

  it('shows error when API throws', async () => {
    const user = userEvent.setup();
    vi.mocked(createWorkflow).mockRejectedValue(new Error('Network error'));
    render(<CreateWorkflowForm onBack={onBack} onCreated={onCreated} />);
    await user.type(screen.getByLabelText('Workflow Name'), 'Test');
    await user.type(screen.getByLabelText('Workflow Script'), 'some script');
    await user.click(screen.getByRole('button', { name: /Create Workflow/i }));
    expect(screen.getByText('Network error')).toBeDefined();
  });

  it('calls onBack when back button is clicked', async () => {
    const user = userEvent.setup();
    render(<CreateWorkflowForm onBack={onBack} onCreated={onCreated} />);
    await user.click(screen.getAllByRole('button')[0]);
    expect(onBack).toHaveBeenCalledTimes(1);
  });

  it('disables inputs while loading', async () => {
    const user = userEvent.setup();
    vi.mocked(createWorkflow).mockImplementation(() => new Promise(() => {}));
    render(<CreateWorkflowForm onBack={onBack} onCreated={onCreated} />);
    await user.type(screen.getByLabelText('Workflow Name'), 'Test');
    await user.type(screen.getByLabelText('Workflow Script'), 'script');
    await user.click(screen.getByRole('button', { name: /Create Workflow/i }));
    expect(screen.getByText('Creating...')).toBeDefined();
    expect((screen.getByLabelText('Workflow Name') as HTMLInputElement).disabled).toBe(true);
    expect((screen.getByLabelText('Workflow Script') as HTMLTextAreaElement).disabled).toBe(true);
  });
});