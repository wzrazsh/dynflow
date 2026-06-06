import { describe, it, expect, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import RuntimeConfigChips from './RuntimeConfigChips';

afterEach(() => {
  cleanup();
});

describe('RuntimeConfigChips', () => {
  it('renders 3 chips when all 3 fields are set', () => {
    render(
      <RuntimeConfigChips runner="cua" llmProvider="opencode" model="gpt-4o" />,
    );
    expect(screen.getByText('cua')).toBeDefined();
    expect(screen.getByText('opencode')).toBeDefined();
    expect(screen.getByText('gpt-4o')).toBeDefined();
    // Labels
    expect(screen.getByText('Runner')).toBeDefined();
    expect(screen.getByText('Provider')).toBeDefined();
    expect(screen.getByText('Model')).toBeDefined();
  });

  it('renders placeholders for missing fields', () => {
    render(<RuntimeConfigChips runner="cua" />);
    expect(screen.getByText('cua')).toBeDefined();
    // two placeholders for missing provider and model
    const dashes = screen.getAllByText('—');
    expect(dashes.length).toBe(2);
  });

  it('shows "Resolved" badge when source=resolved', () => {
    render(
      <RuntimeConfigChips runner="cua" source="resolved" />,
    );
    expect(screen.getByText('Resolved')).toBeDefined();
    expect(screen.getByText('Config')).toBeDefined();
  });

  it('shows "Override" badge when source=override', () => {
    render(
      <RuntimeConfigChips runner="cua" source="override" />,
    );
    expect(screen.getByText('Override')).toBeDefined();
  });

  it('does not show source badge when source=default', () => {
    render(
      <RuntimeConfigChips runner="cua" source="default" />,
    );
    expect(screen.queryByText('Config')).toBeNull();
  });
});
