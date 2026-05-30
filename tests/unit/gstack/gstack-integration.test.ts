import { describe, it, expect, vi } from 'vitest';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { WorkflowRuntime } from '../../../src/runtime/WorkflowRuntime.js';
import { createMockLLM } from '../../helpers/mock-llm.js';
import type { WorkflowDefinition } from '../../../src/types/workflow.js';

describe('Layer 2: skillName runtime injection', () => {
  it('injects skill content into systemPrompt when skillName is set', async () => {
    // Create a fixture skill on disk
    const repoDir = await mkdtemp(join(tmpdir(), 'wf-integration-'));
    const skillDir = join(repoDir, 'test-skill');
    await mkdir(skillDir, { recursive: true });
    await writeFile(
      join(skillDir, 'SKILL.md'),
      [
        '---',
        'name: test-skill',
        'description: A test skill',
        'triggers:',
        '  - test',
        '---',
        '## When to invoke',
        'Use when testing.',
      ].join('\n'),
    );

    const mockLLM = createMockLLM();

    const definition: WorkflowDefinition = {
      name: 'integration-test',
      phases: [
        {
          name: 'test-phase',
          tasks: [
            {
              id: 'task-with-skill',
              systemPrompt: 'You are a test agent.',
              skillName: 'test-skill',
              fallbackPrompt: 'Fallback prompt.',
              task: 'Do something',
            },
          ],
        },
      ],
    };

    const runtime = new WorkflowRuntime({
      llm: mockLLM,
      defaultModel: 'test-model',
    });

    // Override GSTACK_REPO_DIR to point at our fixture
    const original = process.env.GSTACK_REPO_DIR;
    process.env.GSTACK_REPO_DIR = repoDir;

    try {
      await runtime.run(definition);
    } finally {
      if (original === undefined) {
        delete process.env.GSTACK_REPO_DIR;
      } else {
        process.env.GSTACK_REPO_DIR = original;
      }
    }

    // Capture what was sent to the LLM
    expect(mockLLM.complete).toHaveBeenCalledTimes(1);
    const callArgs = (mockLLM.complete as ReturnType<typeof vi.fn>).mock.calls[0][0];
    const systemPrompt = callArgs.systemPrompt as string;

    // Should contain skill reference content, not just original prompt
    expect(systemPrompt).toContain('Fallback prompt.'); // fallbackPrompt becomes base
    expect(systemPrompt).toContain('test-skill'); // skill name referenced
    expect(systemPrompt).toContain('gstack skill reference'); // safety marker
  });

  it('does NOT inject skill content when skillName is absent', async () => {
    const mockLLM = createMockLLM();

    const definition: WorkflowDefinition = {
      name: 'no-skill-test',
      phases: [
        {
          name: 'test-phase',
          tasks: [
            {
              id: 'task-without-skill',
              systemPrompt: 'You are a plain agent.',
              task: 'Do something',
            },
          ],
        },
      ],
    };

    const runtime = new WorkflowRuntime({
      llm: mockLLM,
      defaultModel: 'test-model',
    });

    await runtime.run(definition);

    expect(mockLLM.complete).toHaveBeenCalledTimes(1);
    const callArgs = (mockLLM.complete as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(callArgs.systemPrompt).toBe('You are a plain agent.');
  });

  it('uses fallbackPrompt when skill is not found on disk', async () => {
    // Empty repo dir — no skills exist
    const repoDir = await mkdtemp(join(tmpdir(), 'wf-integration-empty-'));

    const mockLLM = createMockLLM();

    const definition: WorkflowDefinition = {
      name: 'fallback-test',
      phases: [
        {
          name: 'test-phase',
          tasks: [
            {
              id: 'task-missing-skill',
              systemPrompt: 'Original prompt.',
              skillName: 'nonexistent-skill',
              fallbackPrompt: 'This is the fallback.',
              task: 'Do something',
            },
          ],
        },
      ],
    };

    const runtime = new WorkflowRuntime({
      llm: mockLLM,
      defaultModel: 'test-model',
    });

    const original = process.env.GSTACK_REPO_DIR;
    process.env.GSTACK_REPO_DIR = repoDir;

    try {
      await runtime.run(definition);
    } finally {
      if (original === undefined) {
        delete process.env.GSTACK_REPO_DIR;
      } else {
        process.env.GSTACK_REPO_DIR = original;
      }
    }

    expect(mockLLM.complete).toHaveBeenCalledTimes(1);
    const callArgs = (mockLLM.complete as ReturnType<typeof vi.fn>).mock.calls[0][0];

    // Should use fallbackPrompt, not the original systemPrompt
    expect(callArgs.systemPrompt).toContain('This is the fallback.');
    expect(callArgs.systemPrompt).not.toBe('Original prompt.');
  });
});
