import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import AgentPicker from './AgentPicker';
import type { Domain, AgentSource, AgentRole, PredefinedAgent } from '@dynflow/shared';

// Mock the registry API module
vi.mock('../api/registry', () => ({
  fetchDomains: vi.fn(),
  fetchAgentSources: vi.fn(),
  fetchRoles: vi.fn(),
  fetchAgentsByRole: vi.fn(),
}));

import { fetchDomains, fetchAgentSources, fetchRoles, fetchAgentsByRole } from '../api/registry';

const mockDomains: Domain[] = [
  { id: 'd-1', name: 'Code Analysis', description: 'Analyze code quality and patterns' },
  { id: 'd-2', name: 'Testing', description: 'Automated testing agents' },
];

const mockSources: AgentSource[] = [
  { id: 's-1', domainId: 'd-1', name: 'GitHub', url: 'https://github.com', description: 'GitHub-powered agents' },
  { id: 's-2', domainId: 'd-1', name: 'OpenAI', url: 'https://openai.com', description: 'OpenAI GPT agents' },
];

const mockRoles: AgentRole[] = [
  { id: 'r-1', sourceId: 's-1', name: 'Reviewer', description: 'Code review specialist', tier: 1 },
  { id: 'r-2', sourceId: 's-1', name: 'Bug Finder', description: 'Finds bugs in code', tier: 2 },
];

const mockAgents: PredefinedAgent[] = [
  {
    id: 'a-1',
    roleId: 'r-1',
    name: 'Alpha Reviewer',
    description: 'Reviews pull requests',
    systemPrompt: 'You are a code reviewer.',
    availableSkills: ['code-review', 'lint'],
  },
  {
    id: 'a-2',
    roleId: 'r-1',
    name: 'Beta Reviewer',
    description: 'Deep code analysis',
    systemPrompt: 'You are a deep reviewer.',
    availableSkills: ['code-review'],
  },
  {
    id: 'a-3',
    roleId: 'r-1',
    name: 'Gamma Bot',
    description: 'General purpose',
    systemPrompt: 'You are helpful.',
    availableSkills: [],
  },
];

describe('AgentPicker', () => {
  const onSelectionChange = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
    // Default: domains load successfully
    vi.mocked(fetchDomains).mockResolvedValue({
      success: true,
      data: mockDomains,
      page: 1,
      pageSize: 20,
      total: 2,
    });
  });

  afterEach(() => cleanup());

  // ── Rendering ──────────────────────────────────────────────

  it('renders title and loads domains on mount', async () => {
    render(<AgentPicker selectedAgents={[]} onSelectionChange={onSelectionChange} />);

    expect(screen.getByText('Select Agents')).toBeDefined();
    expect(screen.getByText('Select Domain')).toBeDefined();

    await waitFor(() => {
      expect(screen.getByText('Code Analysis')).toBeDefined();
      expect(screen.getByText('Testing')).toBeDefined();
    });
  });

  it('shows count of available domains', async () => {
    render(<AgentPicker selectedAgents={[]} onSelectionChange={onSelectionChange} />);

    await waitFor(() => {
      expect(screen.getByText('2 available')).toBeDefined();
    });
  });

  it('shows loading state while domains are being fetched', () => {
    vi.mocked(fetchDomains).mockImplementation(() => new Promise(() => {}));
    render(<AgentPicker selectedAgents={[]} onSelectionChange={onSelectionChange} />);
    expect(screen.getByText('Loading...')).toBeDefined();
  });

  it('shows error state when domain fetch fails', async () => {
    vi.mocked(fetchDomains).mockRejectedValue(new Error('Network error'));
    render(<AgentPicker selectedAgents={[]} onSelectionChange={onSelectionChange} />);

    await waitFor(() => {
      expect(screen.getByText('Network error')).toBeDefined();
    });
  });

  it('shows empty state when no domains exist', async () => {
    vi.mocked(fetchDomains).mockResolvedValue({
      success: true,
      data: [],
      page: 1,
      pageSize: 20,
      total: 0,
    });
    render(<AgentPicker selectedAgents={[]} onSelectionChange={onSelectionChange} />);

    await waitFor(() => {
      expect(screen.getByText('No domains available')).toBeDefined();
    });
  });

  // ── Selection flow ─────────────────────────────────────────

  it('loads sources when a domain is selected', async () => {
    const user = userEvent.setup();
    vi.mocked(fetchAgentSources).mockResolvedValue({
      success: true,
      data: mockSources,
    });

    render(<AgentPicker selectedAgents={[]} onSelectionChange={onSelectionChange} />);

    await waitFor(() => {
      expect(screen.getByText('Code Analysis')).toBeDefined();
    });

    await user.click(screen.getByText('Code Analysis'));

    await waitFor(() => {
      expect(fetchAgentSources).toHaveBeenCalledWith('d-1');
      expect(screen.getByText('Select Source')).toBeDefined();
      expect(screen.getByText('GitHub')).toBeDefined();
      expect(screen.getByText('OpenAI')).toBeDefined();
    });
  });

  it('loads roles when a source is selected', async () => {
    const user = userEvent.setup();
    vi.mocked(fetchAgentSources).mockResolvedValue({ success: true, data: mockSources });
    vi.mocked(fetchRoles).mockResolvedValue({ success: true, data: mockRoles });

    render(<AgentPicker selectedAgents={[]} onSelectionChange={onSelectionChange} />);

    await waitFor(() => expect(screen.getByText('Code Analysis')).toBeDefined());
    await user.click(screen.getByText('Code Analysis'));

    await waitFor(() => expect(screen.getByText('GitHub')).toBeDefined());
    await user.click(screen.getByText('GitHub'));

    await waitFor(() => {
      expect(fetchRoles).toHaveBeenCalledWith('s-1');
      expect(screen.getByText('Select Role')).toBeDefined();
      expect(screen.getByText('Reviewer')).toBeDefined();
      expect(screen.getByText('Bug Finder')).toBeDefined();
    });
  });

  it('loads agents when a role is selected', async () => {
    const user = userEvent.setup();
    vi.mocked(fetchAgentSources).mockResolvedValue({ success: true, data: mockSources });
    vi.mocked(fetchRoles).mockResolvedValue({ success: true, data: mockRoles });
    vi.mocked(fetchAgentsByRole).mockResolvedValue({ success: true, data: mockAgents });

    render(<AgentPicker selectedAgents={[]} onSelectionChange={onSelectionChange} />);

    await waitFor(() => expect(screen.getByText('Code Analysis')).toBeDefined());
    await user.click(screen.getByText('Code Analysis'));
    await waitFor(() => expect(screen.getByText('GitHub')).toBeDefined());
    await user.click(screen.getByText('GitHub'));
    await waitFor(() => expect(screen.getByText('Reviewer')).toBeDefined());
    await user.click(screen.getByText('Reviewer'));

    await waitFor(() => {
      expect(fetchAgentsByRole).toHaveBeenCalledWith('r-1');
      // "Select Agents" appears as both the card title and the level 4 header
      expect(screen.getAllByText('Select Agents').length).toBe(2);
      expect(screen.getByText('Alpha Reviewer')).toBeDefined();
      expect(screen.getByText('Beta Reviewer')).toBeDefined();
    });
  });

  // ── Agent selection ────────────────────────────────────────

  it('selects an agent when checkbox is clicked', async () => {
    const user = userEvent.setup();
    vi.mocked(fetchAgentSources).mockResolvedValue({ success: true, data: mockSources });
    vi.mocked(fetchRoles).mockResolvedValue({ success: true, data: mockRoles });
    vi.mocked(fetchAgentsByRole).mockResolvedValue({ success: true, data: mockAgents });

    render(<AgentPicker selectedAgents={[]} onSelectionChange={onSelectionChange} />);

    // Drill down to agent level
    await waitFor(() => expect(screen.getByText('Code Analysis')).toBeDefined());
    await user.click(screen.getByText('Code Analysis'));
    await waitFor(() => expect(screen.getByText('GitHub')).toBeDefined());
    await user.click(screen.getByText('GitHub'));
    await waitFor(() => expect(screen.getByText('Reviewer')).toBeDefined());
    await user.click(screen.getByText('Reviewer'));

    await waitFor(() => expect(screen.getByText('Alpha Reviewer')).toBeDefined());

    // Click checkbox
    const checkboxes = screen.getAllByRole('checkbox');
    await user.click(checkboxes[0]);

    expect(onSelectionChange).toHaveBeenCalledWith(['a-1']);
  });

  it('deselects an agent when checkbox is clicked again', async () => {
    const user = userEvent.setup();
    vi.mocked(fetchAgentSources).mockResolvedValue({ success: true, data: mockSources });
    vi.mocked(fetchRoles).mockResolvedValue({ success: true, data: mockRoles });
    vi.mocked(fetchAgentsByRole).mockResolvedValue({ success: true, data: mockAgents });

    render(
      <AgentPicker selectedAgents={['a-1']} onSelectionChange={onSelectionChange} />,
    );

    // Drill down
    await waitFor(() => expect(screen.getByText('Code Analysis')).toBeDefined());
    await user.click(screen.getByText('Code Analysis'));
    await waitFor(() => expect(screen.getByText('GitHub')).toBeDefined());
    await user.click(screen.getByText('GitHub'));
    await waitFor(() => expect(screen.getByText('Reviewer')).toBeDefined());
    await user.click(screen.getByText('Reviewer'));

    // Wait for agent checkboxes to appear (agent names also appear as chips)
    await waitFor(() => {
      expect(screen.getAllByText('Alpha Reviewer').length).toBeGreaterThan(0);
    });

    // Uncheck the first checkbox
    const checkboxes = screen.getAllByRole('checkbox');
    await user.click(checkboxes[0]);

    expect(onSelectionChange).toHaveBeenCalledWith([]);
  });

  it('displays selected count in the chips section', async () => {
    const user = userEvent.setup();
    vi.mocked(fetchAgentSources).mockResolvedValue({ success: true, data: mockSources });
    vi.mocked(fetchRoles).mockResolvedValue({ success: true, data: mockRoles });
    vi.mocked(fetchAgentsByRole).mockResolvedValue({ success: true, data: mockAgents });

    render(
      <AgentPicker selectedAgents={['a-1']} onSelectionChange={onSelectionChange} />,
    );

    await waitFor(() => {
      expect(screen.getByText(/Selected \(1\/10\)/)).toBeDefined();
    });
  });

  // ── Removal ────────────────────────────────────────────────

  it('removes a selected agent when chip X is clicked', async () => {
    const user = userEvent.setup();
    render(
      <AgentPicker selectedAgents={['a-1', 'a-2']} onSelectionChange={onSelectionChange} />,
    );

    await waitFor(() => {
      expect(screen.getByText(/Selected \(2\/10\)/)).toBeDefined();
    });

    const removeButtons = screen.getAllByRole('button', { name: /Remove/ });
    await user.click(removeButtons[0]);

    expect(onSelectionChange).toHaveBeenCalledWith(['a-2']);
  });

  // ── Max selections ─────────────────────────────────────────

  it('disables unselected checkboxes when max selections reached', async () => {
    const user = userEvent.setup();
    vi.mocked(fetchAgentSources).mockResolvedValue({ success: true, data: mockSources });
    vi.mocked(fetchRoles).mockResolvedValue({ success: true, data: mockRoles });
    vi.mocked(fetchAgentsByRole).mockResolvedValue({ success: true, data: mockAgents });

    // maxSelections=2, already have 2 selected
    render(
      <AgentPicker
        selectedAgents={['a-1', 'a-2']}
        onSelectionChange={onSelectionChange}
        maxSelections={2}
      />,
    );

    // Drill down to see agents
    await waitFor(() => expect(screen.getByText('Code Analysis')).toBeDefined());
    await user.click(screen.getByText('Code Analysis'));
    await waitFor(() => expect(screen.getByText('GitHub')).toBeDefined());
    await user.click(screen.getByText('GitHub'));
    await waitFor(() => expect(screen.getByText('Reviewer')).toBeDefined());
    await user.click(screen.getByText('Reviewer'));

    await waitFor(() => {
      expect(screen.getAllByText('Alpha Reviewer').length).toBeGreaterThan(0);
    });

    const checkboxes = screen.getAllByRole('checkbox') as HTMLInputElement[];
    // First two (a-1, a-2) are checked and should be enabled
    expect(checkboxes[0].disabled).toBe(false);
    expect(checkboxes[1].disabled).toBe(false);
    // Third (a-3) is not checked and should be disabled
    expect(checkboxes[2].disabled).toBe(true);
  });

  it('does not call onSelectionChange when max is reached and unchecked agent clicked', async () => {
    const user = userEvent.setup();
    vi.mocked(fetchAgentSources).mockResolvedValue({ success: true, data: mockSources });
    vi.mocked(fetchRoles).mockResolvedValue({ success: true, data: mockRoles });
    vi.mocked(fetchAgentsByRole).mockResolvedValue({ success: true, data: mockAgents });

    render(
      <AgentPicker
        selectedAgents={['a-1', 'a-2']}
        onSelectionChange={onSelectionChange}
        maxSelections={2}
      />,
    );

    await waitFor(() => expect(screen.getByText('Code Analysis')).toBeDefined());
    await user.click(screen.getByText('Code Analysis'));
    await waitFor(() => expect(screen.getByText('GitHub')).toBeDefined());
    await user.click(screen.getByText('GitHub'));
    await waitFor(() => expect(screen.getByText('Reviewer')).toBeDefined());
    await user.click(screen.getByText('Reviewer'));

    await waitFor(() => {
      expect(screen.getAllByText('Alpha Reviewer').length).toBeGreaterThan(0);
    });

    // Try clicking the disabled (third) checkbox
    const checkboxes = screen.getAllByRole('checkbox');
    await user.click(checkboxes[2]);

    // onSelectionChange should not be called since it's disabled
    expect(onSelectionChange).not.toHaveBeenCalled();
  });

  // ── Source/role errors ─────────────────────────────────────

  it('shows error when source fetch fails', async () => {
    const user = userEvent.setup();
    vi.mocked(fetchAgentSources).mockRejectedValue(new Error('Sources unavailable'));

    render(<AgentPicker selectedAgents={[]} onSelectionChange={onSelectionChange} />);

    await waitFor(() => expect(screen.getByText('Code Analysis')).toBeDefined());
    await user.click(screen.getByText('Code Analysis'));

    await waitFor(() => {
      expect(screen.getByText('Sources unavailable')).toBeDefined();
    });
  });

  it('shows error when role fetch fails', async () => {
    const user = userEvent.setup();
    vi.mocked(fetchAgentSources).mockResolvedValue({ success: true, data: mockSources });
    vi.mocked(fetchRoles).mockRejectedValue(new Error('Roles unavailable'));

    render(<AgentPicker selectedAgents={[]} onSelectionChange={onSelectionChange} />);

    await waitFor(() => expect(screen.getByText('Code Analysis')).toBeDefined());
    await user.click(screen.getByText('Code Analysis'));
    await waitFor(() => expect(screen.getByText('GitHub')).toBeDefined());
    await user.click(screen.getByText('GitHub'));

    await waitFor(() => {
      expect(screen.getByText('Roles unavailable')).toBeDefined();
    });
  });

  // ── Source/role empty states ───────────────────────────────

  it('shows empty state when no sources for selected domain', async () => {
    const user = userEvent.setup();
    vi.mocked(fetchAgentSources).mockResolvedValue({ success: true, data: [] });

    render(<AgentPicker selectedAgents={[]} onSelectionChange={onSelectionChange} />);

    await waitFor(() => expect(screen.getByText('Code Analysis')).toBeDefined());
    await user.click(screen.getByText('Code Analysis'));

    await waitFor(() => {
      expect(screen.getByText('No sources for this domain')).toBeDefined();
    });
  });

  it('shows empty state when no agents for selected role', async () => {
    const user = userEvent.setup();
    vi.mocked(fetchAgentSources).mockResolvedValue({ success: true, data: mockSources });
    vi.mocked(fetchRoles).mockResolvedValue({ success: true, data: mockRoles });
    vi.mocked(fetchAgentsByRole).mockResolvedValue({ success: true, data: [] });

    render(<AgentPicker selectedAgents={[]} onSelectionChange={onSelectionChange} />);

    await waitFor(() => expect(screen.getByText('Code Analysis')).toBeDefined());
    await user.click(screen.getByText('Code Analysis'));
    await waitFor(() => expect(screen.getByText('GitHub')).toBeDefined());
    await user.click(screen.getByText('GitHub'));
    await waitFor(() => expect(screen.getByText('Reviewer')).toBeDefined());
    await user.click(screen.getByText('Reviewer'));

    await waitFor(() => {
      expect(screen.getByText('No agents for this role')).toBeDefined();
    });
  });

  // ── Display skills ─────────────────────────────────────────

  it('displays agent skills as tags', async () => {
    const user = userEvent.setup();
    vi.mocked(fetchAgentSources).mockResolvedValue({ success: true, data: mockSources });
    vi.mocked(fetchRoles).mockResolvedValue({ success: true, data: mockRoles });
    vi.mocked(fetchAgentsByRole).mockResolvedValue({ success: true, data: mockAgents });

    render(<AgentPicker selectedAgents={[]} onSelectionChange={onSelectionChange} />);

    await waitFor(() => expect(screen.getByText('Code Analysis')).toBeDefined());
    await user.click(screen.getByText('Code Analysis'));
    await waitFor(() => expect(screen.getByText('GitHub')).toBeDefined());
    await user.click(screen.getByText('GitHub'));
    await waitFor(() => expect(screen.getByText('Reviewer')).toBeDefined());
    await user.click(screen.getByText('Reviewer'));

    await waitFor(() => {
      // code-review appears on two agents (a-1 and a-2), so use getAllByText
      expect(screen.getAllByText('code-review').length).toBe(2);
      expect(screen.getByText('lint')).toBeDefined();
    });
  });

  // ── Custom maxSelections ───────────────────────────────────

  it('respects custom maxSelections prop', async () => {
    const user = userEvent.setup();
    vi.mocked(fetchAgentSources).mockResolvedValue({ success: true, data: mockSources });
    vi.mocked(fetchRoles).mockResolvedValue({ success: true, data: mockRoles });
    vi.mocked(fetchAgentsByRole).mockResolvedValue({ success: true, data: mockAgents });

    render(
      <AgentPicker
        selectedAgents={['a-1']}
        onSelectionChange={onSelectionChange}
        maxSelections={1}
      />,
    );

    await waitFor(() => {
      expect(screen.getByText(/Selected \(1\/1\)/)).toBeDefined();
    });
  });

  // ── Switching domain clears lower levels ───────────────────

  it('clears lower levels when switching domain', async () => {
    const user = userEvent.setup();
    vi.mocked(fetchAgentSources).mockResolvedValue({ success: true, data: mockSources });
    vi.mocked(fetchRoles).mockResolvedValue({ success: true, data: mockRoles });
    vi.mocked(fetchAgentsByRole).mockResolvedValue({ success: true, data: mockAgents });

    render(<AgentPicker selectedAgents={[]} onSelectionChange={onSelectionChange} />);

    await waitFor(() => expect(screen.getByText('Code Analysis')).toBeDefined());

    // Select domain, source, role
    await user.click(screen.getByText('Code Analysis'));
    await waitFor(() => expect(screen.getByText('GitHub')).toBeDefined());
    await user.click(screen.getByText('GitHub'));
    await waitFor(() => expect(screen.getByText('Reviewer')).toBeDefined());
    await user.click(screen.getByText('Reviewer'));
    await waitFor(() => expect(screen.getByText('Alpha Reviewer')).toBeDefined());

    // Click a different domain
    await user.click(screen.getByText('Testing'));

    // Sources should re-fetch for the new domain
    await waitFor(() => {
      expect(fetchAgentSources).toHaveBeenCalledWith('d-2');
    });
  });
});
