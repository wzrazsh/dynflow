import { describe, it, expect, vi } from 'vitest';
import { Workflow } from '../../src/workflow.js';
import { createMockLLM } from '../helpers/mock-llm.js';

describe('Workflow', () => {
  it('should create workflow from config', async () => {
    const llm = createMockLLM();
    const wf = Workflow.from({
      name: 'test',
      llm,
      phases: [
        { name: 'p1', tasks: [{ id: 'a1', systemPrompt: 'sys', task: 'hello' }] },
      ],
    });

    const result = await wf.run();
    expect(result.results.size).toBe(1);
  });

  it('should create workflow from builder', async () => {
    const llm = createMockLLM();
    const definition = Workflow.define('builder-test')
      .phase('p1')
        .task('a1', { systemPrompt: 'sys', task: 'hello' })
      .build();

    // Builder produces definition, runtime executes it
    const { WorkflowRuntime } = await import('../../src/runtime/WorkflowRuntime.js');
    const runtime = new WorkflowRuntime({ llm, defaultModel: 'test' });
    const result = await runtime.run(definition);

    expect(result.results.size).toBe(1);
  });

  it('should validate config', () => {
    const llm = createMockLLM();

    expect(() => Workflow.from({ name: '', llm, phases: [] })).toThrow();
    expect(() => Workflow.from({ name: 'test', llm, phases: [] })).toThrow();
    // @ts-expect-error Testing missing llm
    expect(() => Workflow.from({ name: 'test', phases: [] })).toThrow();
  });
});
