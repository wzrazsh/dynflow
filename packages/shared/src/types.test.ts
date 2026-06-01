import { describe, it, expect } from 'vitest';
import type { WorkspaceConfig, WorkflowDefinition } from './types.js';

describe('WorkspaceConfig', () => {
  it('can be attached to WorkflowDefinition', () => {
    const def: WorkflowDefinition = {
      name: 'test',
      workspace: { git: 'https://github.com/foo/bar', branch: 'main' },
      phases: [],
    };
    expect(def.workspace?.git).toBe('https://github.com/foo/bar');
    expect(def.workspace?.branch).toBe('main');
  });

  it('is optional', () => {
    const def: WorkflowDefinition = { name: 'test', phases: [] };
    expect(def.workspace).toBeUndefined();
  });
});
