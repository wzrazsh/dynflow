import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import ViewCodeModal from './ViewCodeModal';

afterEach(() => {
  cleanup();
});

describe('ViewCodeModal', () => {
  it('renders script text in a readonly textarea', () => {
    render(
      <ViewCodeModal script='workflow("test", () => {})' workflowName="Test Wf" onClose={() => {}} />,
    );
    expect(screen.getByText(/Workflow Code/i)).toBeDefined();
    const textarea = screen.getByRole('textbox') as HTMLTextAreaElement;
    expect(textarea.readOnly).toBe(true);
    expect(textarea.value).toBe('workflow("test", () => {})');
  });

  it('calls onClose when Close button is clicked', async () => {
    const onClose = vi.fn();
    const user = userEvent.setup();
    render(
      <ViewCodeModal script="test script" workflowName="Test Wf" onClose={onClose} />,
    );
    await user.click(screen.getByText('Close'));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('calls onClose when overlay is clicked', async () => {
    const onClose = vi.fn();
    const user = userEvent.setup();
    const { container } = render(
      <ViewCodeModal script="test script" workflowName="Test Wf" onClose={onClose} />,
    );
    const overlay = container.firstElementChild as HTMLElement;
    await user.click(overlay);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('does NOT call onClose when modal content is clicked', async () => {
    const onClose = vi.fn();
    const user = userEvent.setup();
    render(
      <ViewCodeModal script="test script" workflowName="Test Wf" onClose={onClose} />,
    );
    await user.click(screen.getByRole('textbox'));
    expect(onClose).not.toHaveBeenCalled();
  });
});
