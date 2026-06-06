import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react';
import StartRunDialog from './StartRunDialog';
import type { SystemInfo } from '@dynflow/shared';

afterEach(() => {
  cleanup();
});

const mockSystemInfo: SystemInfo = {
  runners: [{ id: 'cua', label: 'Cua', description: 'Default', available: true }],
  providers: [{ id: 'opencode', label: 'OpenCode', available: true }],
  models: { opencode: ['gpt-4o'] },
  defaults: { runner: 'cua', provider: 'opencode', model: 'gpt-4o' },
};

describe('StartRunDialog', () => {
  it('renders when open=true', () => {
    render(
      <StartRunDialog
        open={true}
        onClose={() => {}}
        onConfirm={async () => {}}
        systemInfo={mockSystemInfo}
        workflowName="Test Workflow"
      />,
    );
    expect(screen.getByText('Start: Test Workflow')).toBeDefined();
    expect(screen.getByText('Cancel')).toBeDefined();
    expect(screen.getByText('Start')).toBeDefined();
  });

  it('does not render when open=false', () => {
    const { container } = render(
      <StartRunDialog
        open={false}
        onClose={() => {}}
        onConfirm={async () => {}}
        systemInfo={mockSystemInfo}
        workflowName="Test Workflow"
      />,
    );
    expect(container.innerHTML).toBe('');
  });

  it('pre-populates with defaultRuntimeConfig', () => {
    render(
      <StartRunDialog
        open={true}
        onClose={() => {}}
        onConfirm={async () => {}}
        defaultRuntimeConfig={{ runner: 'cua', model: 'gpt-4o' }}
        systemInfo={mockSystemInfo}
        workflowName="Test"
      />,
    );
    const runnerSelect = screen.getByLabelText('Runner') as HTMLSelectElement;
    expect(runnerSelect.value).toBe('cua');
    const modelInput = screen.getByLabelText('Model') as HTMLInputElement;
    expect(modelInput.value).toBe('gpt-4o');
  });

  it('calls onClose when Cancel is clicked', () => {
    const onClose = vi.fn();
    render(
      <StartRunDialog
        open={true}
        onClose={onClose}
        onConfirm={async () => {}}
        systemInfo={mockSystemInfo}
        workflowName="Test"
      />,
    );
    fireEvent.click(screen.getByText('Cancel'));
    expect(onClose).toHaveBeenCalledOnce();
  });

  it('calls onConfirm with config when Start is clicked', async () => {
    const onConfirm = vi.fn().mockResolvedValue(undefined);
    render(
      <StartRunDialog
        open={true}
        onClose={() => {}}
        onConfirm={onConfirm}
        defaultRuntimeConfig={{ runner: 'cua' }}
        systemInfo={mockSystemInfo}
        workflowName="Test"
      />,
    );
    fireEvent.click(screen.getByText('Start'));
    await waitFor(() => {
      expect(onConfirm).toHaveBeenCalledWith({ runner: 'cua' });
    });
  });

  it('shows error when onConfirm rejects', async () => {
    const onConfirm = vi.fn().mockRejectedValue(new Error('Workflow failed'));
    render(
      <StartRunDialog
        open={true}
        onClose={() => {}}
        onConfirm={onConfirm}
        systemInfo={mockSystemInfo}
        workflowName="Test"
      />,
    );
    fireEvent.click(screen.getByText('Start'));
    await waitFor(() => {
      expect(screen.getByText('Workflow failed')).toBeDefined();
    });
  });

  it('shows loading state during async onConfirm', async () => {
    const onConfirm = vi.fn().mockImplementation(
      () => new Promise<void>((resolve) => setTimeout(resolve, 100)),
    );
    render(
      <StartRunDialog
        open={true}
        onClose={() => {}}
        onConfirm={onConfirm}
        systemInfo={mockSystemInfo}
        workflowName="Test"
      />,
    );
    fireEvent.click(screen.getByText('Start'));
    expect(screen.getByText('Starting...')).toBeDefined();
    await waitFor(() => {
      expect(screen.queryByText('Starting...')).toBeNull();
    });
  });
});
