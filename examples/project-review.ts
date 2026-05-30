/**
 * Project review workflow using gstack agents
 *
 * This workflow uses gstack's review agents to evaluate project decisions:
 * - Feature design review (CEO + Engineering + Design)
 * - PR code review (Engineering + QA)
 * - Release readiness (Ship)
 *
 * Usage:
 *   OPENCODE_API_KEY=your-key npx tsx examples/project-review.ts
 *
 * Environment variables:
 *   OPENCODE_API_KEY     - Required. Your OpenCode API key.
 *   REVIEW_TYPE          - Optional. "feature" | "pr" | "release" (default: "feature")
 *   REVIEW_DESCRIPTION   - Required. Description of what to review.
 *   GSTACK_REPO_DIR      - Optional. Path to gstack checkout.
 */

import { Workflow, OpenAICompatibleClient } from '../src/index.js';
import { loadSkillForPrompt } from '../src/gstack/index.js';

type ReviewType = 'feature' | 'pr' | 'release';

interface ReviewConfig {
  type: ReviewType;
  description: string;
  agents: Array<{
    id: string;
    skillName: string;
    systemPrompt: string;
    task: string;
  }>;
}

// ─── Client ───────────────────────────────────────────────────────────────────

const client = new OpenAICompatibleClient({
  baseUrl: process.env.OPENCODE_BASE_URL ?? 'https://opencode.ai/zen/v1',
  apiKey: process.env.OPENCODE_API_KEY ?? 'your-api-key',
  defaultModel: process.env.OPENCODE_MODEL ?? 'mimo-v2.5-free',
});

// ─── Prompt Loading ───────────────────────────────────────────────────────────

async function loadGstackPrompt(skillName: string, fallback: string): Promise<string> {
  return loadSkillForPrompt({ skillName, fallbackPrompt: fallback });
}

// ─── Review Configurations ────────────────────────────────────────────────────

async function buildFeatureReviewConfig(description: string): Promise<ReviewConfig> {
  const ceoPrompt = await loadGstackPrompt('plan-ceo-review', [
    'You are a CEO/founder mode reviewer.',
    'Challenge whether this feature is worth building, whether the scope is right,',
    'and whether it aligns with the project goals.',
  ].join(' '));

  const engPrompt = await loadGstackPrompt('plan-eng-review', [
    'You are an engineering manager reviewer.',
    'Review the technical design for implementation risk, testability, API fit,',
    'and whether it follows existing patterns in the codebase.',
  ].join(' '));

  const designPrompt = await loadGstackPrompt('plan-design-review', [
    'You are a design reviewer.',
    'Evaluate the user experience, API design, and developer ergonomics.',
  ].join(' '));

  return {
    type: 'feature',
    description,
    agents: [
      {
        id: 'ceo-review',
        skillName: 'plan-ceo-review',
        systemPrompt: ceoPrompt,
        task: `Review this feature proposal for the dynamic-workflow-engine project:\n\n${description}\n\nFocus on: product value, scope clarity, user benefit, and whether this should be built.`,
      },
      {
        id: 'eng-review',
        skillName: 'plan-eng-review',
        systemPrompt: engPrompt,
        task: `Review the technical design of this feature:\n\n${description}\n\nFocus on: implementation risk, testability, API fit, and consistency with existing patterns.`,
      },
      {
        id: 'design-review',
        skillName: 'plan-design-review',
        systemPrompt: designPrompt,
        task: `Review the design of this feature:\n\n${description}\n\nFocus on: user experience, API ergonomics, and developer experience.`,
      },
    ],
  };
}

async function buildPRReviewConfig(description: string): Promise<ReviewConfig> {
  const engPrompt = await loadGstackPrompt('plan-eng-review', [
    'You are an engineering manager reviewing a pull request.',
    'Review the code changes for quality, test coverage, and potential issues.',
  ].join(' '));

  const qaPrompt = await loadGstackPrompt('qa', [
    'You are a QA reviewer.',
    'Evaluate the test coverage and identify any gaps or risks.',
  ].join(' '));

  return {
    type: 'pr',
    description,
    agents: [
      {
        id: 'eng-review',
        skillName: 'plan-eng-review',
        systemPrompt: engPrompt,
        task: `Review this pull request:\n\n${description}\n\nFocus on: code quality, test coverage, potential issues, and whether it follows project conventions.`,
      },
      {
        id: 'qa-review',
        skillName: 'qa',
        systemPrompt: qaPrompt,
        task: `Evaluate the test coverage for this change:\n\n${description}\n\nFocus on: test gaps, edge cases, and regression risks.`,
      },
    ],
  };
}

async function buildReleaseReviewConfig(description: string): Promise<ReviewConfig> {
  const shipPrompt = await loadGstackPrompt('ship', [
    'You are a release readiness reviewer.',
    'Assess whether this release is ready to ship.',
  ].join(' '));

  return {
    type: 'release',
    description,
    agents: [
      {
        id: 'ship-review',
        skillName: 'ship',
        systemPrompt: shipPrompt,
        task: `Review whether this release is ready to ship:\n\n${description}\n\nReturn: ready/not ready, required fixes, validation checklist, and residual risks.`,
      },
    ],
  };
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  const reviewType = (process.env.REVIEW_TYPE ?? 'feature') as ReviewType;
  const description = process.env.REVIEW_DESCRIPTION;

  if (!description) {
    console.error('Error: REVIEW_DESCRIPTION environment variable is required.');
    console.error('');
    console.error('Usage:');
    console.error('  REVIEW_DESCRIPTION="Your feature description" npx tsx examples/project-review.ts');
    console.error('');
    console.error('Examples:');
    console.error('  REVIEW_DESCRIPTION="Add streaming response support" npx tsx examples/project-review.ts');
    console.error('  REVIEW_TYPE=pr REVIEW_DESCRIPTION="Fix cache invalidation bug" npx tsx examples/project-review.ts');
    console.error('  REVIEW_TYPE=release REVIEW_DESCRIPTION="v0.2.0 release with caching" npx tsx examples/project-review.ts');
    process.exitCode = 1;
    return;
  }

  console.log(`Running ${reviewType} review workflow...`);

  let config: ReviewConfig;
  switch (reviewType) {
    case 'feature':
      config = await buildFeatureReviewConfig(description);
      break;
    case 'pr':
      config = await buildPRReviewConfig(description);
      break;
    case 'release':
      config = await buildReleaseReviewConfig(description);
      break;
    default:
      console.error(`Unknown review type: ${reviewType}`);
      process.exitCode = 1;
      return;
  }

  const workflow = Workflow.from({
    name: `${reviewType}-review`,
    llm: client,
    defaultModel: process.env.OPENCODE_MODEL ?? 'mimo-v2.5-free',
    maxConcurrency: config.agents.length,
    phases: [
      {
        name: 'parallel-review',
        tasks: config.agents.map(agent => ({
          id: agent.id,
          systemPrompt: agent.systemPrompt,
          task: agent.task,
        })),
      },
      {
        name: 'synthesis',
        concurrency: 1,
        tasks: [
          {
            id: 'decision-brief',
            systemPrompt: [
              'You are a pragmatic project maintainer.',
              'Synthesize the review feedback into a clear decision brief.',
              'Return: proceed/defer/do not build, key concerns, required actions, and next steps.',
            ].join(' '),
            task: (ctx) => {
              const reviews = config.agents
                .map(agent => {
                  const result = ctx.get('parallel-review', agent.id)?.content ?? `No ${agent.id} result.`;
                  return `${agent.id}:\n${result}`;
                })
                .join('\n\n');

              return [
                `Review type: ${config.type}`,
                `Description: ${config.description}`,
                '',
                'Review feedback:',
                reviews,
                '',
                'Synthesize into a decision brief with: proceed/defer/do not build, key concerns, required actions, next steps.',
              ].join('\n');
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

  const result = await workflow.run();
  const decision = result.results.get('synthesis')?.get('decision-brief');

  console.log('\n=== Review Decision ===');
  console.log(decision?.content ?? 'No decision generated.');
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
