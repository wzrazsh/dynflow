import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor, cleanup } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import TemplateDetail from './TemplateDetail';
import type { WorkflowTemplate } from '@dynflow/shared';

// Mock the API client module
vi.mock('../api/client', () => ({
  get: vi.fn(),
}));

import { get } from '../api/client';

const mockTemplate: WorkflowTemplate = {
  id: 'tpl-1',
  name: 'Research Flow',
  description: 'A template for research tasks',
  script: 'phase("Research", () => {\n  agent("a1", "do work");\n});',
  currentVersion: 2,
  tags: ['research', 'data'],
  createdAt: '2025-01-01T00:00:00Z',
  updatedAt: '2025-01-15T00:00:00Z',
};

const minimalTemplate: WorkflowTemplate = {
  id: 'tpl-2',
  name: 'Minimal',
  description: undefined,
  script: 'phase("Build", () => { agent("b1", "build"); });',
  currentVersion: 1,
  tags: [],
  createdAt: '2025-02-01T00:00:00Z',
  updatedAt: '2025-02-01T00:00:00Z',
};

describe('TemplateDetail', () => {
  const onBack = vi.fn();
  const onEdit = vi.fn();
  const onError = vi.fn();
  const onSuccess = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    cleanup();
    document.body.innerHTML = '';
  });

  it('renders loading state initially', () => {
    vi.mocked(get).mockReturnValue(new Promise(() => {}));

    render(
      <TemplateDetail
        templateId="tpl-1"
        onBack={onBack}
        onError={onError}
        onSuccess={onSuccess}
      />,
    );
    expect(screen.getByText('Loading template...')).toBeDefined();
  });

  it('shows back button during loading', () => {
    vi.mocked(get).mockReturnValue(new Promise(() => {}));

    render(
      <TemplateDetail
        templateId="tpl-1"
        onBack={onBack}
        onError={onError}
        onSuccess={onSuccess}
      />,
    );
    expect(screen.getByRole('button', { name: /Back to templates/i })).toBeDefined();
  });

  it('renders template details after loading', async () => {
    vi.mocked(get).mockResolvedValue({
      success: true,
      data: mockTemplate,
    });

    render(
      <TemplateDetail
        templateId="tpl-1"
        onBack={onBack}
        onError={onError}
        onSuccess={onSuccess}
      />,
    );

    await waitFor(() => {
      expect(screen.getByText('Research Flow')).toBeDefined();
    });

    // Version badge
    expect(screen.getByText('v2')).toBeDefined();

    // Description
    expect(
      screen.getByText('A template for research tasks'),
    ).toBeDefined();

    // Script
    expect(
      screen.getByText(/phase\("Research",/),
    ).toBeDefined();

    // Timestamps
    expect(screen.getByText(/Created:/)).toBeDefined();
    expect(screen.getByText(/Updated:/)).toBeDefined();
  });

  it('renders tags with colored pills', async () => {
    vi.mocked(get).mockResolvedValue({
      success: true,
      data: mockTemplate,
    });

    render(
      <TemplateDetail
        templateId="tpl-1"
        onBack={onBack}
        onError={onError}
        onSuccess={onSuccess}
      />,
    );

    await waitFor(() => {
      expect(screen.getByText('Tags')).toBeDefined();
    });

    expect(screen.getByText('research')).toBeDefined();
    expect(screen.getByText('data')).toBeDefined();
  });

  it('renders action buttons', async () => {
    vi.mocked(get).mockResolvedValue({
      success: true,
      data: mockTemplate,
    });

    render(
      <TemplateDetail
        templateId="tpl-1"
        onBack={onBack}
        onError={onError}
        onSuccess={onSuccess}
      />,
    );

    await waitFor(() => {
      expect(screen.getByText('Research Flow')).toBeDefined();
    });

    expect(screen.getByRole('button', { name: 'Run' })).toBeDefined();
    expect(screen.getByRole('button', { name: 'Edit' })).toBeDefined();
    expect(screen.getByRole('button', { name: 'Export' })).toBeDefined();
  });

  it('handles template with no description and no tags', async () => {
    vi.mocked(get).mockResolvedValue({
      success: true,
      data: minimalTemplate,
    });

    render(
      <TemplateDetail
        templateId="tpl-2"
        onBack={onBack}
        onError={onError}
        onSuccess={onSuccess}
      />,
    );

    await waitFor(() => {
      expect(screen.getByText('Minimal')).toBeDefined();
    });

    // No description rendered
    expect(screen.queryByText('A template for research tasks')).toBeNull();

    // v1 badge
    expect(screen.getByText('v1')).toBeDefined();

    // No tags section
    expect(screen.queryByText('Tags')).toBeNull();
  });

  it('calls onBack when back button is clicked', async () => {
    const user = userEvent.setup();
    vi.mocked(get).mockResolvedValue({
      success: true,
      data: mockTemplate,
    });

    render(
      <TemplateDetail
        templateId="tpl-1"
        onBack={onBack}
        onError={onError}
        onSuccess={onSuccess}
      />,
    );

    await waitFor(() => {
      expect(screen.getByText('Research Flow')).toBeDefined();
    });

    await user.click(screen.getByRole('button', { name: /Back to templates/i }));
    expect(onBack).toHaveBeenCalledTimes(1);
  });

  it('shows error state when fetch fails', async () => {
    vi.mocked(get).mockResolvedValue({
      success: false,
      error: 'Template not found',
    });

    render(
      <TemplateDetail
        templateId="tpl-1"
        onBack={onBack}
        onError={onError}
        onSuccess={onSuccess}
      />,
    );

    await waitFor(() => {
      expect(screen.getByText('Template not found')).toBeDefined();
    });

    // Back button still shows
    expect(screen.getByRole('button', { name: /Back to templates/i })).toBeDefined();
  });

  it('calls onError when template fetch fails', async () => {
    vi.mocked(get).mockResolvedValue({
      success: false,
      error: 'Template not found',
    });

    render(
      <TemplateDetail
        templateId="tpl-1"
        onBack={onBack}
        onError={onError}
        onSuccess={onSuccess}
      />,
    );

    await waitFor(() => {
      expect(onError).toHaveBeenCalledWith('Template not found');
    });
  });

  it('shows template not found message when data is null', async () => {
    vi.mocked(get).mockResolvedValue({
      success: true,
      data: null,
    });

    render(
      <TemplateDetail
        templateId="tpl-missing"
        onBack={onBack}
        onError={onError}
        onSuccess={onSuccess}
      />,
    );

    await waitFor(() => {
      expect(screen.getByText('Template not found')).toBeDefined();
    });
  });

  it('handles fetch rejection', async () => {
    vi.mocked(get).mockRejectedValue(new Error('Network error'));

    render(
      <TemplateDetail
        templateId="tpl-1"
        onBack={onBack}
        onError={onError}
        onSuccess={onSuccess}
      />,
    );

    await waitFor(() => {
      expect(screen.getByText('Error: Network error')).toBeDefined();
    });
  });

  it('calls onError on fetch rejection', async () => {
    vi.mocked(get).mockRejectedValue(new Error('Network error'));

    render(
      <TemplateDetail
        templateId="tpl-1"
        onBack={onBack}
        onError={onError}
        onSuccess={onSuccess}
      />,
    );

    await waitFor(() => {
      expect(onError).toHaveBeenCalledWith(
        'Failed to load template: Error: Network error',
      );
    });
  });

  it('calls onSuccess when Run button is clicked', async () => {
    const user = userEvent.setup();
    vi.mocked(get).mockResolvedValue({
      success: true,
      data: mockTemplate,
    });

    render(
      <TemplateDetail
        templateId="tpl-1"
        onBack={onBack}
        onError={onError}
        onSuccess={onSuccess}
      />,
    );

    await waitFor(() => {
      expect(screen.getByText('Research Flow')).toBeDefined();
    });

    await user.click(screen.getByRole('button', { name: 'Run' }));
    expect(onSuccess).toHaveBeenCalledWith(
      'Run template: Research Flow',
    );
  });

  it('calls onEdit with the template when Edit button is clicked', async () => {
    const user = userEvent.setup();
    vi.mocked(get).mockResolvedValue({
      success: true,
      data: mockTemplate,
    });

    render(
      <TemplateDetail
        templateId="tpl-1"
        onBack={onBack}
        onEdit={onEdit}
        onError={onError}
        onSuccess={onSuccess}
      />,
    );

    await waitFor(() => {
      expect(screen.getByText('Research Flow')).toBeDefined();
    });

    await user.click(screen.getByRole('button', { name: 'Edit' }));
    expect(onEdit).toHaveBeenCalledWith(mockTemplate);
  });
});
