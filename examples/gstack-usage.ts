/**
 * gstack skill direct reference example (Layer 2)
 *
 * Demonstrates referencing gstack skills directly in TaskDefinition
 * without manually loading and assembling systemPrompt.
 *
 * Usage:
 *   OPENCODE_API_KEY=your-key npx tsx examples/gstack-usage.ts
 */
import { Workflow, OpenAICompatibleClient } from '../src/index.js';

const client = new OpenAICompatibleClient({
  baseUrl: process.env.OPENCODE_BASE_URL ?? 'https://opencode.ai/zen/v1',
  apiKey: process.env.OPENCODE_API_KEY ?? 'your-api-key',
  defaultModel: process.env.OPENCODE_MODEL ?? 'mimo-v2.5-free',
});

const workflow = Workflow.from({
  name: 'gstack-direct-usage',
  llm: client,
  defaultModel: process.env.OPENCODE_MODEL ?? 'mimo-v2.5-free',
  maxConcurrency: 2,
  phases: [
    {
      name: 'review',
      tasks: [
        {
          id: 'ceo-review',
          systemPrompt: 'You are a CEO reviewer evaluating a product decision.',
          skillName: 'plan-ceo-review',
          fallbackPrompt: 'You are a CEO reviewer. Focus on product value and scope clarity.',
          task: 'Review whether we should add streaming support to the workflow engine.',
        },
        {
          id: 'eng-review',
          systemPrompt: 'You are an engineering reviewer evaluating technical design.',
          skillName: 'plan-eng-review',
          fallbackPrompt: 'You are an engineering reviewer. Focus on architecture and risk.',
          task: 'Evaluate the technical approach for adding streaming support.',
        },
      ],
    },
    {
      name: 'decision',
      concurrency: 1,
      tasks: [
        {
          id: 'summary',
          systemPrompt: 'Synthesize review feedback into a decision.',
          task: (ctx) => {
            const ceo = ctx.get('review', 'ceo-review')?.content ?? 'No CEO review';
            const eng = ctx.get('review', 'eng-review')?.content ?? 'No eng review';
            return `Synthesize these reviews into a decision:\n\nCEO:\n${ceo}\n\nEngineering:\n${eng}`;
          },
        },
      ],
    },
  ],
  onEvent: (event) => {
    if (event.type === 'agent:complete') {
      console.log(`[${event.phaseName}/${event.agentId}] ${event.result.status}`);
    }
  },
});

async function main() {
  console.log('Running gstack direct usage workflow...');
  const result = await workflow.run();
  const decision = result.results.get('decision')?.get('summary');
  console.log('\n=== Decision ===');
  console.log(decision?.content ?? 'No decision generated.');
}

main().catch(console.error);
