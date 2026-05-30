import { describe, it, expect } from 'vitest';
import { WorkflowRuntime } from '../../src/runtime/WorkflowRuntime.js';
import { createMockLLM } from '../helpers/mock-llm.js';

describe('Integration: Multi-phase workflow', () => {
  it('should execute a 3-phase workflow with context passing', async () => {
    const llm = createMockLLM();
    const runtime = new WorkflowRuntime({
      llm,
      defaultModel: 'test-model',
      maxConcurrency: 4,
    });

    const result = await runtime.run({
      name: 'multi-phase-test',
      phases: [
        {
          name: 'research',
          tasks: [
            { id: 'web', systemPrompt: 'Researcher', task: 'Search web' },
            { id: 'docs', systemPrompt: 'Doc reader', task: 'Read docs' },
          ],
        },
        {
          name: 'analyze',
          concurrency: 2,
          tasks: [
            {
              id: 'analyze-web',
              systemPrompt: 'Analyst',
              task: (ctx) => `Analyze: ${ctx.get('research', 'web')?.content}`,
            },
            {
              id: 'analyze-docs',
              systemPrompt: 'Analyst',
              task: (ctx) => `Analyze: ${ctx.get('research', 'docs')?.content}`,
            },
          ],
        },
        {
          name: 'write',
          concurrency: 1,
          tasks: [
            {
              id: 'report',
              systemPrompt: 'Writer',
              task: (ctx) => {
                const web = ctx.get('analyze', 'analyze-web')?.content;
                const docs = ctx.get('analyze', 'analyze-docs')?.content;
                return `Write report based on:\n${web}\n${docs}`;
              },
            },
          ],
        },
      ],
    });

    // Verify all phases executed
    expect(result.results.size).toBe(3);

    // Verify context flow
    const webResult = result.results.get('research')?.get('web');
    expect(webResult?.content).toContain('Echo: Search web');

    const analyzeWeb = result.results.get('analyze')?.get('analyze-web');
    expect(analyzeWeb?.content).toContain('Echo: Analyze:');

    // Verify summary
    expect(result.summary.totalAgents).toBe(5);
    expect(result.summary.completedAgents).toBe(5);
    expect(result.summary.totalTokenUsage.totalTokens).toBeGreaterThan(0);
  });

  it('should share ctx.variables across phases', async () => {
    const mockLLM = createMockLLM();
    const runtime = new WorkflowRuntime({
      llm: mockLLM,
      defaultModel: 'test',
    });

    const result = await runtime.run({
      name: 'vars-test',
      phases: [
        {
          name: 'setter',
          tasks: [{
            id: 'write',
            systemPrompt: 'writer',
            task: (ctx) => {
              ctx.variables['key'] = 'value from phase 1';
              return 'set';
            },
          }],
        },
        {
          name: 'reader',
          tasks: [{
            id: 'read',
            systemPrompt: 'reader',
            task: (ctx) => {
              return `Read: ${ctx.variables['key']}`;
            },
          }],
        },
      ],
    });

    const readerResult = result.results.get('reader')?.get('read');
    expect(readerResult?.content).toContain('value from phase 1');
  });
});
