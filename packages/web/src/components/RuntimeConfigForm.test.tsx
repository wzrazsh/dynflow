import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, screen, cleanup, fireEvent } from '@testing-library/react';
import RuntimeConfigForm from './RuntimeConfigForm';
import type { SystemInfo } from '@dynflow/shared';

afterEach(() => {
  cleanup();
});

const mockSystemInfo: SystemInfo = {
  runners: [
    { id: 'cua', label: 'Cua Sandbox (Pi)', description: 'Default', available: true },
    { id: 'docker', label: 'Docker (Legacy)', description: 'Legacy', available: false },
    { id: 'pi-direct', label: 'Pi Direct', description: 'Direct', available: true },
  ],
  providers: [
    { id: 'opencode', label: 'OpenCode', available: true },
    { id: 'anthropic', label: 'Anthropic', available: false },
  ],
  models: {
    opencode: ['mimo-v2.5-free', 'kimi-k2', 'gpt-4o-mini'],
    anthropic: ['claude-3-5-sonnet-20241022'],
  },
  defaults: { runner: 'cua', provider: 'opencode', model: 'gpt-4o' },
};

describe('RuntimeConfigForm', () => {
  it('renders 3 fields', () => {
    render(
      <RuntimeConfigForm
        value={{}}
        onChange={() => {}}
        systemInfo={mockSystemInfo}
      />,
    );
    expect(screen.getByText('Runner')).toBeDefined();
    expect(screen.getByText('Provider')).toBeDefined();
    expect(screen.getByText('Model')).toBeDefined();
  });

  it('shows only available runners', () => {
    render(
      <RuntimeConfigForm
        value={{}}
        onChange={() => {}}
        systemInfo={mockSystemInfo}
      />,
    );
    const runnerSelect = screen.getByLabelText('Runner') as HTMLSelectElement;
    // Should have 3 options: (default), cua, pi-direct (docker not available)
    expect(runnerSelect.options.length).toBe(3);
    expect(runnerSelect.options[1].value).toBe('cua');
    expect(runnerSelect.options[2].value).toBe('pi-direct');
  });

  it('shows only available providers', () => {
    render(
      <RuntimeConfigForm
        value={{}}
        onChange={() => {}}
        systemInfo={mockSystemInfo}
      />,
    );
    const providerSelect = screen.getByLabelText('Provider') as HTMLSelectElement;
    expect(providerSelect.options.length).toBe(2); // (default) + opencode
    expect(providerSelect.options[1].value).toBe('opencode');
  });

  it('changing runner calls onChange', () => {
    const onChange = vi.fn();
    render(
      <RuntimeConfigForm
        value={{}}
        onChange={onChange}
        systemInfo={mockSystemInfo}
      />,
    );
    fireEvent.change(screen.getByLabelText('Runner'), { target: { value: 'cua' } });
    expect(onChange).toHaveBeenCalledWith({ runner: 'cua' });
  });

  it('changing provider calls onChange', () => {
    const onChange = vi.fn();
    render(
      <RuntimeConfigForm
        value={{}}
        onChange={onChange}
        systemInfo={mockSystemInfo}
      />,
    );
    fireEvent.change(screen.getByLabelText('Provider'), { target: { value: 'opencode' } });
    expect(onChange).toHaveBeenCalledWith({ llmProvider: 'opencode' });
  });

  it('model datalist reflects selected provider', () => {
    render(
      <RuntimeConfigForm
        value={{ llmProvider: 'opencode' }}
        onChange={() => {}}
        systemInfo={mockSystemInfo}
      />,
    );
    const datalist = document.getElementById('runtime-config-models');
    expect(datalist).toBeDefined();
    const options = datalist!.querySelectorAll('option');
    expect(options.length).toBe(3);
    expect(options[0].getAttribute('value')).toBe('mimo-v2.5-free');
  });

  it('disables all fields when disabled prop is set', () => {
    render(
      <RuntimeConfigForm
        value={{}}
        onChange={() => {}}
        systemInfo={mockSystemInfo}
        disabled={true}
      />,
    );
    const selects = document.querySelectorAll('select');
    const inputs = document.querySelectorAll('input');
    selects.forEach((s) => expect(s.disabled).toBe(true));
    inputs.forEach((i) => expect(i.disabled).toBe(true));
  });
});
