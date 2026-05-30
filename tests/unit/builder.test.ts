import { describe, it, expect } from 'vitest';
import { WorkflowBuilder } from '../../src/builder/WorkflowBuilder.js';
import { ConfigurationError } from '../../src/errors.js';

describe('WorkflowBuilder', () => {
  it('should build a workflow definition', () => {
    const def = new WorkflowBuilder('test-workflow')
      .concurrency(4)
      .session('session-1')
      .phase('research', { concurrency: 2 })
        .task('search-web', {
          systemPrompt: 'You are a researcher',
          task: 'Search for info',
        })
        .task('search-docs', {
          systemPrompt: 'You are a doc reader',
          task: 'Read docs',
        })
      .phase('write', { concurrency: 1 })
        .task('summary', {
          systemPrompt: 'You are a writer',
          task: (ctx) => `Write about: ${ctx.get('research', 'search-web')?.content}`,
        })
      .build();

    expect(def.name).toBe('test-workflow');
    expect(def.defaultConcurrency).toBe(4);
    expect(def.sessionId).toBe('session-1');
    expect(def.phases).toHaveLength(2);
    expect(def.phases[0].name).toBe('research');
    expect(def.phases[0].concurrency).toBe(2);
    expect(def.phases[0].tasks).toHaveLength(2);
    expect(def.phases[1].name).toBe('write');
    expect(def.phases[1].tasks).toHaveLength(1);
  });

  it('should throw on empty name', () => {
    expect(() => new WorkflowBuilder('')).toThrow(ConfigurationError);
    expect(() => new WorkflowBuilder('  ')).toThrow(ConfigurationError);
  });

  it('should support dynamic task resolvers', () => {
    const resolver = (ctx: { get: (p: string, a: string) => { content: string } | undefined }) =>
      `Dynamic: ${ctx.get('p1', 'a1')?.content}`;

    const def = new WorkflowBuilder('dynamic')
      .phase('p1')
        .task('a1', { systemPrompt: 'sys', task: 'static' })
      .phase('p2')
        .task('a2', { systemPrompt: 'sys', task: resolver })
      .build();

    expect(typeof def.phases[1].tasks[0].task).toBe('function');
  });
});
