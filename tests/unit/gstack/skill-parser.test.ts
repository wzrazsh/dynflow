import { describe, it, expect } from 'vitest';
import {
  extractFrontmatter,
  extractFrontmatterValue,
  extractFrontmatterList,
  extractSection,
  parseSkillReference,
  formatSkillReference,
} from '../../../src/gstack/skill-parser.js';

const sampleSKILL = `---
name: test-skill
preamble-tier: 3
version: 1.0.0
description: A test skill for unit testing
allowed-tools:
  - Bash
  - Read
triggers:
  - test trigger
  - run tests
interactive: true
---
## When to invoke this skill

Use this skill when you need to test something.

## Important Rules

1. Always test first.
2. Never break existing tests.

## Workflow

Step 1: Do something
`;

describe('extractFrontmatter', () => {
  it('extracts frontmatter from SKILL.md', () => {
    const fm = extractFrontmatter(sampleSKILL);
    expect(fm).toContain('name: test-skill');
    expect(fm).toContain('version: 1.0.0');
  });

  it('returns empty string for no frontmatter', () => {
    expect(extractFrontmatter('no frontmatter here')).toBe('');
  });

  it('returns empty string for single fence', () => {
    expect(extractFrontmatter('---\nno closing fence')).toBe('');
  });
});

describe('extractFrontmatterValue', () => {
  it('extracts a string value', () => {
    const fm = extractFrontmatter(sampleSKILL);
    expect(extractFrontmatterValue(fm, 'name')).toBe('test-skill');
    expect(extractFrontmatterValue(fm, 'description')).toBe('A test skill for unit testing');
  });

  it('returns undefined for missing key', () => {
    const fm = extractFrontmatter(sampleSKILL);
    expect(extractFrontmatterValue(fm, 'nonexistent')).toBeUndefined();
  });
});

describe('extractFrontmatterList', () => {
  it('extracts a list value', () => {
    const fm = extractFrontmatter(sampleSKILL);
    expect(extractFrontmatterList(fm, 'triggers')).toEqual(['test trigger', 'run tests']);
    expect(extractFrontmatterList(fm, 'allowed-tools')).toEqual(['Bash', 'Read']);
  });

  it('returns empty array for missing key', () => {
    const fm = extractFrontmatter(sampleSKILL);
    expect(extractFrontmatterList(fm, 'nonexistent')).toEqual([]);
  });
});

describe('extractSection', () => {
  it('extracts a section by heading', () => {
    const section = extractSection(sampleSKILL, '## Important Rules', 2000);
    expect(section).toContain('Always test first');
    expect(section).toContain('Never break existing tests');
  });

  it('returns undefined for missing heading', () => {
    expect(extractSection(sampleSKILL, '## Missing', 1000)).toBeUndefined();
  });

  it('truncates long sections', () => {
    const longMarkdown = '## Long\n' + 'x'.repeat(2000);
    const result = extractSection(longMarkdown, '## Long', 100);
    expect(result).toContain('...');
  });
});

describe('parseSkillReference', () => {
  it('parses a full SKILL.md into a reference', () => {
    const ref = parseSkillReference('test-skill', sampleSKILL);
    expect(ref.name).toBe('test-skill');
    expect(ref.description).toBe('A test skill for unit testing');
    expect(ref.triggers).toEqual(['test trigger', 'run tests']);
    expect(ref.whenToInvoke).toContain('Use this skill when');
    expect(ref.importantRules).toContain('Always test first');
  });
});

describe('formatSkillReference', () => {
  it('formats a reference with fallback prompt', () => {
    const ref = parseSkillReference('test-skill', sampleSKILL);
    const result = formatSkillReference(ref, 'You are a test agent.');
    expect(result).toContain('You are a test agent.');
    expect(result).toContain('Local gstack skill material follows');
    expect(result).toContain('Do not execute preamble commands');
    expect(result).toContain('Referenced gstack skill: test-skill');
    expect(result).toContain('Description: A test skill');
    expect(result).toContain('Triggers: test trigger, run tests');
  });
});
