import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor, cleanup, fireEvent } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import SkillPicker from './SkillPicker';
import type { Skill, AgentSource } from '@dynflow/shared';

// Mock the API module
vi.mock('../api/skills', () => ({
  fetchSkills: vi.fn(),
  fetchAgentSources: vi.fn(),
}));

import { fetchSkills, fetchAgentSources } from '../api/skills';

const mockSources: AgentSource[] = [
  { id: 'src-1', domainId: 'd-1', name: 'GitHub', url: 'https://github.com', description: 'GitHub trending agents' },
  { id: 'src-2', domainId: 'd-1', name: 'OpenAI', url: 'https://openai.com', description: 'OpenAI GPT Store' },
];

const mockSkills: Skill[] = [
  {
    id: 'skill-1',
    sourceId: 'src-1',
    name: 'Code Review',
    description: 'Reviews code for issues and suggests improvements',
    category: 'development',
    parameters: [
      { name: 'code', type: 'string', description: 'The code to review', required: true },
    ],
  },
  {
    id: 'skill-2',
    sourceId: 'src-1',
    name: 'Bug Finder',
    description: 'Finds bugs in source code using static analysis',
    category: 'analysis',
    parameters: [
      { name: 'filePath', type: 'string', description: 'Path to file', required: true },
      { name: 'language', type: 'string', description: 'Programming language', required: false },
    ],
  },
  {
    id: 'skill-3',
    sourceId: 'src-2',
    name: 'Content Writer',
    description: 'Generates written content for various formats',
    category: 'creative',
    parameters: [
      { name: 'topic', type: 'string', description: 'Topic to write about', required: true },
      { name: 'tone', type: 'string', description: 'Writing tone', required: false },
      { name: 'wordCount', type: 'number', description: 'Target word count', required: false, defaultValue: 500 },
    ],
  },
  {
    id: 'skill-4',
    sourceId: 'src-2',
    name: 'Data Analyzer',
    description: 'Analyzes data and generates insights',
    category: 'analysis',
    parameters: [],
  },
];

describe('SkillPicker', () => {
  const onSelectionChange = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(fetchAgentSources).mockResolvedValue({ success: true, data: mockSources });
  });

  afterEach(() => {
    cleanup();
  });

  // === Rendering States ===

  it('shows loading state initially', () => {
    vi.mocked(fetchSkills).mockReturnValue(new Promise(() => {}));
    render(
      <SkillPicker selectedSkills={[]} onSelectionChange={onSelectionChange} />,
    );
    expect(screen.getByText('Loading skills...')).toBeDefined();
  });

  it('shows empty state when no skills returned', async () => {
    vi.mocked(fetchSkills).mockResolvedValue({ success: true, data: [] });
    render(
      <SkillPicker selectedSkills={[]} onSelectionChange={onSelectionChange} />,
    );
    await waitFor(() => {
      expect(screen.getByText('No skills found')).toBeDefined();
    });
  });

  it('shows error state when fetch fails', async () => {
    vi.mocked(fetchSkills).mockResolvedValue({ success: false, error: 'Failed to load' });
    render(
      <SkillPicker selectedSkills={[]} onSelectionChange={onSelectionChange} />,
    );
    await waitFor(() => {
      expect(screen.getByText(/Error: Failed to load/)).toBeDefined();
    });
  });

  it('shows error state when fetch throws', async () => {
    vi.mocked(fetchSkills).mockRejectedValue(new Error('Network error'));
    render(
      <SkillPicker selectedSkills={[]} onSelectionChange={onSelectionChange} />,
    );
    await waitFor(() => {
      expect(screen.getByText(/Error: Network error/)).toBeDefined();
    });
  });

  // === Rendering Skills ===

  it('renders skills list with names and descriptions', async () => {
    vi.mocked(fetchSkills).mockResolvedValue({ success: true, data: mockSkills });
    render(
      <SkillPicker selectedSkills={[]} onSelectionChange={onSelectionChange} />,
    );
    await waitFor(() => {
      expect(screen.getByText('Code Review')).toBeDefined();
      expect(screen.getByText('Bug Finder')).toBeDefined();
      expect(screen.getByText('Content Writer')).toBeDefined();
    });
    expect(screen.getByText(/Reviews code for issues/)).toBeDefined();
  });

  it('shows category badges for each skill', async () => {
    vi.mocked(fetchSkills).mockResolvedValue({ success: true, data: mockSkills });
    render(
      <SkillPicker selectedSkills={[]} onSelectionChange={onSelectionChange} />,
    );
    await waitFor(() => {
      expect(screen.getByText('Development')).toBeDefined();
      expect(screen.getByText('Analysis')).toBeDefined();
      expect(screen.getByText('Creative')).toBeDefined();
    });
  });

  it('shows parameter count for each skill', async () => {
    vi.mocked(fetchSkills).mockResolvedValue({ success: true, data: mockSkills });
    render(
      <SkillPicker selectedSkills={[]} onSelectionChange={onSelectionChange} />,
    );
    await waitFor(() => {
      expect(screen.getByText('1 parameter')).toBeDefined();
      expect(screen.getByText('2 parameters')).toBeDefined();
      expect(screen.getByText('3 parameters')).toBeDefined();
      expect(screen.getByText('0 parameters')).toBeDefined();
    });
  });

  // === Selection ===

  it('renders with pre-selected skills', async () => {
    vi.mocked(fetchSkills).mockResolvedValue({ success: true, data: mockSkills });
    render(
      <SkillPicker
        selectedSkills={['skill-1', 'skill-3']}
        onSelectionChange={onSelectionChange}
      />,
    );
    await waitFor(() => {
      const checkboxes = screen.getAllByRole('checkbox') as HTMLInputElement[];
      const skill1Checkbox = checkboxes.find((cb) => cb.getAttribute('aria-label') === 'Select Code Review');
      const skill3Checkbox = checkboxes.find((cb) => cb.getAttribute('aria-label') === 'Select Content Writer');
      const skill2Checkbox = checkboxes.find((cb) => cb.getAttribute('aria-label') === 'Select Bug Finder');
      expect(skill1Checkbox?.checked).toBe(true);
      expect(skill3Checkbox?.checked).toBe(true);
      expect(skill2Checkbox?.checked).toBe(false);
    });
  });

  it('calls onSelectionChange when selecting a skill', async () => {
    const user = userEvent.setup();
    vi.mocked(fetchSkills).mockResolvedValue({ success: true, data: mockSkills });
    render(
      <SkillPicker selectedSkills={[]} onSelectionChange={onSelectionChange} />,
    );
    await waitFor(() => {
      expect(screen.getByText('Code Review')).toBeDefined();
    });
    await user.click(screen.getByLabelText('Select Code Review'));
    expect(onSelectionChange).toHaveBeenCalledWith(['skill-1']);
  });

  it('calls onSelectionChange when deselecting a skill', async () => {
    const user = userEvent.setup();
    vi.mocked(fetchSkills).mockResolvedValue({ success: true, data: mockSkills });
    render(
      <SkillPicker
        selectedSkills={['skill-1', 'skill-2']}
        onSelectionChange={onSelectionChange}
      />,
    );
    await waitFor(() => {
      expect(screen.getByText('Code Review')).toBeDefined();
    });
    await user.click(screen.getByLabelText('Select Code Review'));
    expect(onSelectionChange).toHaveBeenCalledWith(['skill-2']);
  });

  it('respects maxSelections limit', async () => {
    const user = userEvent.setup();
    vi.mocked(fetchSkills).mockResolvedValue({ success: true, data: mockSkills });
    render(
      <SkillPicker
        selectedSkills={['skill-1']}
        onSelectionChange={onSelectionChange}
        maxSelections={1}
      />,
    );
    await waitFor(() => {
      expect(screen.getByText('Code Review')).toBeDefined();
    });
    // Try to select another skill - should not call onSelectionChange
    await user.click(screen.getByLabelText('Select Bug Finder'));
    expect(onSelectionChange).not.toHaveBeenCalled();
  });

  // === Selected Count Indicator ===

  it('displays selected count', async () => {
    vi.mocked(fetchSkills).mockResolvedValue({ success: true, data: mockSkills });
    render(
      <SkillPicker
        selectedSkills={['skill-1', 'skill-3']}
        onSelectionChange={onSelectionChange}
      />,
    );
    await waitFor(() => {
      expect(screen.getByText('2 skills selected')).toBeDefined();
    });
  });

  it('displays singular for one selected skill', async () => {
    vi.mocked(fetchSkills).mockResolvedValue({ success: true, data: mockSkills });
    render(
      <SkillPicker
        selectedSkills={['skill-1']}
        onSelectionChange={onSelectionChange}
      />,
    );
    await waitFor(() => {
      expect(screen.getByText('1 skill selected')).toBeDefined();
    });
  });

  it('shows max selection hint when limit reached', async () => {
    vi.mocked(fetchSkills).mockResolvedValue({ success: true, data: mockSkills });
    render(
      <SkillPicker
        selectedSkills={['skill-1', 'skill-2']}
        onSelectionChange={onSelectionChange}
        maxSelections={2}
      />,
    );
    await waitFor(() => {
      expect(screen.getByText(/max 2/)).toBeDefined();
    });
  });

  // === Clear All ===

  it('calls onSelectionChange with empty array on clear all', async () => {
    const user = userEvent.setup();
    vi.mocked(fetchSkills).mockResolvedValue({ success: true, data: mockSkills });
    render(
      <SkillPicker
        selectedSkills={['skill-1', 'skill-2']}
        onSelectionChange={onSelectionChange}
      />,
    );
    await waitFor(() => {
      expect(screen.getByText('Clear all')).toBeDefined();
    });
    await user.click(screen.getByText('Clear all'));
    expect(onSelectionChange).toHaveBeenCalledWith([]);
  });

  it('does not show clear all when no skills selected', async () => {
    vi.mocked(fetchSkills).mockResolvedValue({ success: true, data: mockSkills });
    render(
      <SkillPicker selectedSkills={[]} onSelectionChange={onSelectionChange} />,
    );
    await waitFor(() => {
      expect(screen.queryByText('Clear all')).toBeNull();
    });
  });

  // === Filtering ===

  it('passes sourceFilter query param when source is selected', async () => {
    const user = userEvent.setup();
    vi.mocked(fetchSkills).mockResolvedValue({ success: true, data: [] });
    render(
      <SkillPicker selectedSkills={[]} onSelectionChange={onSelectionChange} />,
    );
    await waitFor(() => {
      expect(screen.getByLabelText('Filter by source')).toBeDefined();
    });
    await user.selectOptions(screen.getByLabelText('Filter by source'), 'src-1');
    await waitFor(() => {
      expect(fetchSkills).toHaveBeenCalledWith(
        expect.objectContaining({ sourceId: 'src-1' }),
      );
    });
  });

  it('passes categoryFilter query param when category is selected', async () => {
    const user = userEvent.setup();
    vi.mocked(fetchSkills).mockResolvedValue({ success: true, data: [] });
    render(
      <SkillPicker selectedSkills={[]} onSelectionChange={onSelectionChange} />,
    );
    await waitFor(() => {
      expect(screen.getByLabelText('Filter by category')).toBeDefined();
    });
    await user.selectOptions(screen.getByLabelText('Filter by category'), 'analysis');
    await waitFor(() => {
      expect(fetchSkills).toHaveBeenCalledWith(
        expect.objectContaining({ category: 'analysis' }),
      );
    });
  });

  it('uses external sourceFilter when provided', async () => {
    vi.mocked(fetchSkills).mockResolvedValue({ success: true, data: [] });
    render(
      <SkillPicker
        selectedSkills={[]}
        onSelectionChange={onSelectionChange}
        sourceFilter="src-1"
      />,
    );
    await waitFor(() => {
      expect(fetchSkills).toHaveBeenCalledWith(
        expect.objectContaining({ sourceId: 'src-1' }),
      );
    });
    // Local source filter should not be rendered
    expect(screen.queryByLabelText('Filter by source')).toBeNull();
  });

  it('uses external categoryFilter when provided', async () => {
    vi.mocked(fetchSkills).mockResolvedValue({ success: true, data: [] });
    render(
      <SkillPicker
        selectedSkills={[]}
        onSelectionChange={onSelectionChange}
        categoryFilter="analysis"
      />,
    );
    await waitFor(() => {
      expect(fetchSkills).toHaveBeenCalledWith(
        expect.objectContaining({ category: 'analysis' }),
      );
    });
    expect(screen.queryByLabelText('Filter by category')).toBeNull();
  });

  // === Search ===

  it('debounces search input and passes search query', async () => {
    vi.mocked(fetchSkills).mockResolvedValue({ success: true, data: [] });
    render(
      <SkillPicker selectedSkills={[]} onSelectionChange={onSelectionChange} />,
    );
    const searchInput = screen.getByLabelText('Search skills') as HTMLInputElement;

    // Type using fireEvent - synchronous, no timer conflict
    fireEvent.change(searchInput, { target: { value: 'code' } });

    // Immediately: should not have called with search yet (debounce pending)
    expect(fetchSkills).not.toHaveBeenCalledWith(
      expect.objectContaining({ search: 'code' }),
    );

    // Wait for debounce to complete (300ms + React state flush)
    await waitFor(() => {
      expect(fetchSkills).toHaveBeenCalledWith(
        expect.objectContaining({ search: 'code' }),
      );
    });
  });

  it('resets local filters when controlled sourceFilter changes', async () => {
    // When sourceFilter is controlled, local filter dropdown is hidden
    vi.mocked(fetchSkills).mockResolvedValue({ success: true, data: [] });
    const { rerender } = render(
      <SkillPicker
        selectedSkills={[]}
        onSelectionChange={onSelectionChange}
        sourceFilter="src-1"
      />,
    );
    await waitFor(() => {
      expect(fetchSkills).toHaveBeenCalledWith(
        expect.objectContaining({ sourceId: 'src-1' }),
      );
    });

    rerender(
      <SkillPicker
        selectedSkills={[]}
        onSelectionChange={onSelectionChange}
        sourceFilter="src-2"
      />,
    );
    await waitFor(() => {
      expect(fetchSkills).toHaveBeenCalledWith(
        expect.objectContaining({ sourceId: 'src-2' }),
      );
    });
  });
});
