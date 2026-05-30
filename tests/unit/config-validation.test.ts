import { describe, it, expect } from 'vitest';
import { Workflow } from '../../src/workflow.js';
import { ConcurrencyLimiter } from '../../src/runtime/ConcurrencyLimiter.js';
import { ConfigurationError } from '../../src/errors.js';
import { createMockLLM } from '../helpers/mock-llm.js';

describe('Config validation', () => {
  const mockLLM = createMockLLM();

  // --- Concurrency validation ---

  it('should reject concurrency = 0', () => {
    expect(() => new ConcurrencyLimiter(0)).toThrow(ConfigurationError);
  });

  it('should reject concurrency = -1', () => {
    expect(() => new ConcurrencyLimiter(-1)).toThrow(ConfigurationError);
  });

  it('should reject concurrency = 1.5', () => {
    expect(() => new ConcurrencyLimiter(1.5)).toThrow(ConfigurationError);
  });

  it('should reject builder concurrency = 0', () => {
    expect(() => Workflow.define('test').concurrency(0)).toThrow(ConfigurationError);
  });

  it('should reject Workflow.from maxConcurrency = 0', () => {
    expect(() => Workflow.from({
      name: 'test',
      llm: mockLLM,
      maxConcurrency: 0,
      phases: [{ name: 'p1', tasks: [{ id: 'a1', systemPrompt: 's', task: 't' }] }],
    })).toThrow(ConfigurationError);
  });

  // --- Duplicate task id ---

  it('should reject duplicate task id in builder', () => {
    const builder = Workflow.define('test').phase('p1');
    builder.task('a1', { systemPrompt: 's', task: 't' });
    expect(() => builder.task('a1', { systemPrompt: 's', task: 't' })).toThrow(ConfigurationError);
  });

  it('should reject duplicate task id in from()', () => {
    expect(() => Workflow.from({
      name: 'test',
      llm: mockLLM,
      phases: [{
        name: 'p1',
        tasks: [
          { id: 'a1', systemPrompt: 's', task: 't' },
          { id: 'a1', systemPrompt: 's', task: 't' },
        ],
      }],
    })).toThrow(ConfigurationError);
  });

  // --- Empty phase name ---

  it('should reject empty phase name in builder', () => {
    expect(() => Workflow.define('test').phase('')).toThrow(ConfigurationError);
  });

  it('should reject whitespace-only phase name in builder', () => {
    expect(() => Workflow.define('test').phase('   ')).toThrow(ConfigurationError);
  });

  it('should reject empty phase name in from()', () => {
    expect(() => Workflow.from({
      name: 'test',
      llm: mockLLM,
      phases: [{ name: '', tasks: [{ id: 'a1', systemPrompt: 's', task: 't' }] }],
    })).toThrow(ConfigurationError);
  });

  // --- Empty task id ---

  it('should reject empty task id in builder', () => {
    const pb = Workflow.define('test').phase('p1');
    expect(() => pb.task('', { systemPrompt: 's', task: 't' })).toThrow(ConfigurationError);
  });

  it('should reject whitespace-only task id in builder', () => {
    const pb = Workflow.define('test').phase('p1');
    expect(() => pb.task('   ', { systemPrompt: 's', task: 't' })).toThrow(ConfigurationError);
  });

  it('should reject empty task id in from()', () => {
    expect(() => Workflow.from({
      name: 'test',
      llm: mockLLM,
      phases: [{ name: 'p1', tasks: [{ id: '', systemPrompt: 's', task: 't' }] }],
    })).toThrow(ConfigurationError);
  });

  // --- Empty systemPrompt ---

  it('should reject empty systemPrompt in builder', () => {
    const pb = Workflow.define('test').phase('p1');
    expect(() => pb.task('a1', { systemPrompt: '', task: 't' })).toThrow(ConfigurationError);
  });

  it('should reject whitespace-only systemPrompt in builder', () => {
    const pb = Workflow.define('test').phase('p1');
    expect(() => pb.task('a1', { systemPrompt: '   ', task: 't' })).toThrow(ConfigurationError);
  });

  it('should reject empty systemPrompt in from()', () => {
    expect(() => Workflow.from({
      name: 'test',
      llm: mockLLM,
      phases: [{ name: 'p1', tasks: [{ id: 'a1', systemPrompt: '', task: 't' }] }],
    })).toThrow(ConfigurationError);
  });

  // --- Empty task string ---

  it('should reject empty task string in builder', () => {
    const pb = Workflow.define('test').phase('p1');
    expect(() => pb.task('a1', { systemPrompt: 's', task: '' })).toThrow(ConfigurationError);
  });

  it('should reject empty task string in from()', () => {
    expect(() => Workflow.from({
      name: 'test',
      llm: mockLLM,
      phases: [{ name: 'p1', tasks: [{ id: 'a1', systemPrompt: 's', task: '' }] }],
    })).toThrow(ConfigurationError);
  });

  // --- Phase with no tasks ---

  it('should reject phase with no tasks via builder build', () => {
    const builder = Workflow.define('test').phase('p1');
    // buildPhase() validates tasks.length === 0
    expect(() => builder['buildPhase']()).toThrow(ConfigurationError);
  });

  it('should reject phase with no tasks in from()', () => {
    expect(() => Workflow.from({
      name: 'test',
      llm: mockLLM,
      phases: [{ name: 'p1', tasks: [] }],
    })).toThrow(ConfigurationError);
  });

  // --- Workflow with no phases ---

  it('should reject workflow with no phases via builder build', () => {
    expect(() => Workflow.define('test').build()).toThrow(ConfigurationError);
  });

  it('should reject workflow with no phases in from()', () => {
    expect(() => Workflow.from({
      name: 'test',
      llm: mockLLM,
      phases: [],
    })).toThrow(ConfigurationError);
  });

  // --- Empty workflow name ---

  it('should reject empty workflow name', () => {
    expect(() => Workflow.define('')).toThrow(ConfigurationError);
  });

  it('should reject whitespace-only workflow name in from()', () => {
    expect(() => Workflow.from({
      name: '   ',
      llm: mockLLM,
      phases: [{ name: 'p1', tasks: [{ id: 'a1', systemPrompt: 's', task: 't' }] }],
    })).toThrow(ConfigurationError);
  });

  // --- Missing LLM ---

  it('should reject missing LLM in from()', () => {
    expect(() => Workflow.from({
      name: 'test',
      // @ts-expect-error Testing missing llm
      llm: undefined,
      phases: [{ name: 'p1', tasks: [{ id: 'a1', systemPrompt: 's', task: 't' }] }],
    })).toThrow(ConfigurationError);
  });
});
