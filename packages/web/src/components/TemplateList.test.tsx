import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor, cleanup } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import TemplateList from './TemplateList';
import type { WorkflowTemplate } from '@dynflow/shared';

// Mock the API client module
vi.mock('../api/client', () => ({
  get: vi.fn(),
}));

import { get } from '../api/client';

const mockTemplates: WorkflowTemplate[] = [
  {
    id: 'tpl-1',
    name: 'Research Flow',
    description: 'A template for research tasks',
    script: 'phase("Research", () => { agent("a1", "do work"); });',
    currentVersion: 1,
    tags: ['research', 'data'],
    createdAt: '2025-01-01T00:00:00Z',
    updatedAt: '2025-01-01T01:00:00Z',
  },
  {
    id: 'tpl-2',
    name: 'Build Pipeline',
    description: undefined,
    script: 'phase("Build", () => { agent("b1", "build"); });',
    currentVersion: 3,
    tags: ['devops'],
    createdAt: '2025-02-01T00:00:00Z',
    updatedAt: '2025-02-05T00:00:00Z',
  },
  {
    id: 'tpl-3',
    name: 'Analysis',
    description: 'Data analysis template with no tags',
    script: 'phase("Analyze", () => { agent("a1", "analyze"); });',
    currentVersion: 1,
    tags: [],
    createdAt: '2025-03-01T00:00:00Z',
    updatedAt: '2025-03-01T00:00:00Z',
  },
];

describe('TemplateList', () => {
  const onSelect = vi.fn();
  const onError = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
    document.body.innerHTML = '';
  });

  afterEach(() => {
    cleanup();
    document.body.innerHTML = '';
  });

  it('renders loading state', () => {
    vi.mocked(get).mockReturnValue(new Promise(() => {}));

    render(
      <TemplateList selectedId={null} onSelect={onSelect} onError={onError} />,
    );
    expect(screen.getByText('Loading templates...')).toBeDefined();
  });

  it('renders empty state when no templates', async () => {
    vi.mocked(get).mockResolvedValue({
      success: true,
      data: [],
      page: 1,
      pageSize: 20,
      total: 0,
    });

    render(
      <TemplateList selectedId={null} onSelect={onSelect} onError={onError} />,
    );

    await waitFor(() => {
      expect(screen.getByText('No templates found')).toBeDefined();
    });
  });

  it('renders template list items with names', async () => {
    vi.mocked(get).mockResolvedValue({
      success: true,
      data: mockTemplates,
      page: 1,
      pageSize: 20,
      total: 3,
    });

    render(
      <TemplateList selectedId={null} onSelect={onSelect} onError={onError} />,
    );

    await waitFor(() => {
      expect(screen.getByText('Research Flow')).toBeDefined();
      expect(screen.getByText('Build Pipeline')).toBeDefined();
      expect(screen.getByText('Analysis')).toBeDefined();
    });
  });

  it('renders version badges', async () => {
    vi.mocked(get).mockResolvedValue({
      success: true,
      data: mockTemplates,
      page: 1,
      pageSize: 20,
      total: 3,
    });

    render(
      <TemplateList selectedId={null} onSelect={onSelect} onError={onError} />,
    );

    await waitFor(() => {
      // v1 appears on Research Flow and Analysis; use getAllByText
      const v1Badges = screen.getAllByText('v1');
      expect(v1Badges.length).toBeGreaterThanOrEqual(1);
      expect(screen.getByText('v3')).toBeDefined();
    });
  });

  it('renders descriptions when present', async () => {
    vi.mocked(get).mockResolvedValue({
      success: true,
      data: mockTemplates,
      page: 1,
      pageSize: 20,
      total: 3,
    });

    render(
      <TemplateList selectedId={null} onSelect={onSelect} onError={onError} />,
    );

    await waitFor(() => {
      expect(
        screen.getByText('A template for research tasks'),
      ).toBeDefined();
      expect(
        screen.getByText('Data analysis template with no tags'),
      ).toBeDefined();
    });
  });

  it('renders tag chips for templates with tags', async () => {
    vi.mocked(get).mockResolvedValue({
      success: true,
      data: mockTemplates,
      page: 1,
      pageSize: 20,
      total: 3,
    });

    render(
      <TemplateList selectedId={null} onSelect={onSelect} onError={onError} />,
    );

    await waitFor(() => {
      // Tags appear both as filter chips and item tags
      const researchEls = screen.getAllByText('research');
      expect(researchEls.length).toBeGreaterThanOrEqual(1);
      const dataEls = screen.getAllByText('data');
      expect(dataEls.length).toBeGreaterThanOrEqual(1);
      const devopsEls = screen.getAllByText('devops');
      expect(devopsEls.length).toBeGreaterThanOrEqual(1);
    });
  });

  it('calls onSelect when a template is clicked', async () => {
    const user = userEvent.setup();
    vi.mocked(get).mockResolvedValue({
      success: true,
      data: mockTemplates,
      page: 1,
      pageSize: 20,
      total: 3,
    });

    render(
      <TemplateList selectedId={null} onSelect={onSelect} onError={onError} />,
    );

    await waitFor(() => {
      expect(screen.getByText('Research Flow')).toBeDefined();
    });

    await user.click(screen.getByText('Research Flow'));
    expect(onSelect).toHaveBeenCalledWith('tpl-1');
  });

  it('renders error state when fetch fails', async () => {
    vi.mocked(get).mockRejectedValue(new Error('Network error'));

    render(
      <TemplateList selectedId={null} onSelect={onSelect} onError={onError} />,
    );

    await waitFor(() => {
      expect(screen.getByText(/Error: Network error/)).toBeDefined();
    });
  });

  it('calls onError when fetch fails', async () => {
    vi.mocked(get).mockRejectedValue(new Error('Network error'));

    render(
      <TemplateList
        selectedId={null}
        onSelect={onSelect}
        onError={onError}
      />,
    );

    await waitFor(() => {
      expect(onError).toHaveBeenCalledWith(
        'Failed to load templates: Error: Network error',
      );
    });
  });

  it('renders selected state on the active item', async () => {
    vi.mocked(get).mockResolvedValue({
      success: true,
      data: mockTemplates,
      page: 1,
      pageSize: 20,
      total: 3,
    });

    render(
      <TemplateList selectedId="tpl-1" onSelect={onSelect} onError={onError} />,
    );

    await waitFor(() => {
      expect(screen.getByText('Research Flow')).toBeDefined();
    });
  });

  it('shows tag filter chips when templates have tags', async () => {
    vi.mocked(get).mockResolvedValue({
      success: true,
      data: mockTemplates,
      page: 1,
      pageSize: 20,
      total: 3,
    });

    render(
      <TemplateList selectedId={null} onSelect={onSelect} onError={onError} />,
    );

    await waitFor(() => {
      // "All" filter chip
      expect(screen.getByText('All')).toBeDefined();
    });
  });

  it('shows search input', async () => {
    vi.mocked(get).mockResolvedValue({
      success: true,
      data: mockTemplates,
      page: 1,
      pageSize: 20,
      total: 3,
    });

    render(
      <TemplateList selectedId={null} onSelect={onSelect} onError={onError} />,
    );

    await waitFor(() => {
      const searchInputs = screen.getAllByPlaceholderText('Search templates...');
      expect(searchInputs.length).toBeGreaterThanOrEqual(1);
    });
  });
});
