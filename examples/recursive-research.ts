/**
 * Recursive research workflow example
 *
 * This example demonstrates:
 * - Dynamic task generation (TaskResolver)
 * - Dynamic agent spawning based on previous results
 * - Builder API usage
 *
 * Usage:
 *   OPENCODE_API_KEY=your-key npx tsx examples/recursive-research.ts
 */

import { Workflow, OpenAICompatibleClient } from '../src/index.js';
import type { PhaseDefinition } from '../src/types/workflow.js';

const client = new OpenAICompatibleClient({
  baseUrl: 'https://opencode.ai/zen/v1',
  apiKey: process.env.OPENCODE_API_KEY ?? 'your-api-key',
  defaultModel: 'mimo-v2.5-free',
});

async function main() {
  // Step 1: Generate research questions
  const questionsWf = Workflow.from({
    name: 'generate-questions',
    llm: client,
    defaultModel: 'mimo-v2.5-free',
    phases: [
      {
        name: 'generate',
        concurrency: 1,
        tasks: [
          {
            id: 'questions',
            systemPrompt: 'You are a research planner. Generate research questions.',
            task: 'Generate 3 specific research questions about TypeScript async patterns. Return them as a numbered list.',
          },
        ],
      },
    ],
  });

  console.log('Generating research questions...');
  const questionsResult = await questionsWf.run();
  const questionsContent = questionsResult.results.get('generate')?.get('questions')?.content ?? '';

  // Parse questions (simplified - in production you'd use LLM to parse)
  const questions = questionsContent
    .split('\n')
    .filter(line => /^\d/.test(line.trim()))
    .map(line => line.replace(/^\d+[\.\)]\s*/, '').trim())
    .slice(0, 3);

  console.log(`Found ${questions.length} questions`);

  // Step 2: Answer each question in parallel
  const answerPhases: PhaseDefinition[] = questions.map((q, i) => ({
    name: `answer-${i}`,
    concurrency: 1,
    tasks: [
      {
        id: `answer-${i}`,
        systemPrompt: 'You are a technical researcher. Provide detailed answers.',
        task: q,
      },
    ],
  }));

  // Step 3: Synthesize all answers
  answerPhases.push({
    name: 'synthesize',
    concurrency: 1,
    tasks: [
      {
        id: 'report',
        systemPrompt: 'You are a technical writer. Synthesize research findings.',
        task: (ctx) => {
          const answers = questions
            .map((q, i) => `Q: ${q}\nA: ${ctx.get(`answer-${i}`, `answer-${i}`)?.content ?? 'No answer'}`)
            .join('\n\n');
          return `Synthesize this research into a concise report:\n\n${answers}`;
        },
      },
    ],
  });

  const researchWf = Workflow.from({
    name: 'recursive-research',
    llm: client,
    defaultModel: 'mimo-v2.5-free',
    maxConcurrency: 4,
    phases: answerPhases,
    onEvent: (event) => {
      if (event.type === 'phase:start') {
        console.log(`\nPhase: ${event.phaseName} (${event.taskCount} tasks)`);
      }
    },
  });

  console.log('\nExecuting research workflow...');
  const result = await researchWf.run();

  console.log('\n=== Research Report ===');
  const report = result.results.get('synthesize')?.get('report');
  console.log(report?.content ?? 'No report generated');
}

main().catch(console.error);
