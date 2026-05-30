/**
 * Basic workflow example: Research + Synthesize
 *
 * This example demonstrates:
 * - Creating a workflow with config object
 * - Parallel agents in a phase
 * - Context passing between phases
 * - Event handling
 *
 * Usage:
 *   OPENCODE_API_KEY=your-key npx tsx examples/basic.ts
 */

import { Workflow, OpenAICompatibleClient } from '../src/index.js';

const client = new OpenAICompatibleClient({
  baseUrl: 'https://opencode.ai/zen/v1',
  apiKey: process.env.OPENCODE_API_KEY ?? 'your-api-key',
  defaultModel: 'mimo-v2.5-free',
});

const workflow = Workflow.from({
  name: 'research-summary',
  llm: client,
  defaultModel: 'mimo-v2.5-free',
  maxConcurrency: 4,
  phases: [
    {
      name: 'research',
      tasks: [
        {
          id: 'web-search',
          systemPrompt: 'You are a web researcher. Find information about the given topic.',
          task: 'Explain how TypeScript workflow engines work and their key features.',
        },
        {
          id: 'code-search',
          systemPrompt: 'You are a code analyst. Analyze code patterns.',
          task: 'Describe the key design patterns used in workflow orchestration systems.',
        },
      ],
    },
    {
      name: 'synthesize',
      concurrency: 1,
      tasks: [
        {
          id: 'summary',
          systemPrompt: 'You are a technical writer who creates clear, concise summaries.',
          task: (ctx) => {
            const web = ctx.get('research', 'web-search')?.content ?? 'No web research';
            const code = ctx.get('research', 'code-search')?.content ?? 'No code analysis';
            return `Combine these findings into a comprehensive summary:\n\nWeb Research:\n${web}\n\nCode Analysis:\n${code}`;
          },
        },
      ],
    },
  ],
  onEvent: (event) => {
    if (event.type === 'agent:complete') {
      console.log(`[${event.phaseName}/${event.agentId}] ${event.result.status} (${event.result.tokenUsage.totalTokens} tokens)`);
    }
  },
});

async function main() {
  console.log('Starting workflow...');
  const result = await workflow.run();

  console.log('\n=== Results ===');
  console.log(`Total agents: ${result.summary.totalAgents}`);
  console.log(`Completed: ${result.summary.completedAgents}`);
  console.log(`Failed: ${result.summary.failedAgents}`);
  console.log(`Total tokens: ${result.summary.totalTokenUsage.totalTokens}`);
  console.log(`Duration: ${result.summary.totalDurationMs}ms`);

  const summary = result.results.get('synthesize')?.get('summary');
  if (summary) {
    console.log('\n=== Summary ===');
    console.log(summary.content);
  }
}

main().catch(console.error);
