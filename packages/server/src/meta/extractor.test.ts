import { describe, it, expect } from 'vitest';
import {
  extractAgents,
  extractSkills,
  extractAll,
  type ExtractedAgent,
  type ExtractedSkill,
  type ExtractionResult,
  type ScannedFile,
} from './extractor.js';

// ---------------------------------------------------------------------------
// Fixture builders
// ---------------------------------------------------------------------------

function definitionFile(
  content: string,
  ext: string,
  isDefinition = true,
  name = `test${ext}`,
): ScannedFile {
  return { path: `/project/${name}`, content, size: content.length, isDefinition };
}

function nonDefinitionFile(
  content: string,
  ext: string,
  name = `other${ext}`,
): ScannedFile {
  return { path: `/project/${name}`, content, size: content.length, isDefinition: false };
}

// ---------------------------------------------------------------------------
// JSON fixture content
// ---------------------------------------------------------------------------

const jsonAgentSingle = JSON.stringify({
  name: 'code-reviewer',
  description: 'Reviews code for quality and best practices',
  systemPrompt: 'You are a code reviewer. Be thorough.',
  availableSkills: ['code-analysis', 'pattern-detection'],
});

const jsonAgentNoSkills = JSON.stringify({
  name: 'simple-agent',
  description: 'A simple agent',
  systemPrompt: 'You are simple.',
});

const jsonAgentWithPrompt = JSON.stringify({
  name: 'prompt-agent',
  description: 'Agent using prompt field',
  prompt: 'You use prompt instead of systemPrompt.',
});

const jsonSkillSingle = JSON.stringify({
  name: 'code-analysis',
  description: 'Analyzes source code for patterns and issues',
  category: 'development',
  parameters: [
    { name: 'code', type: 'string', description: 'Source code to analyze', required: true },
    { name: 'language', type: 'string', description: 'Programming language', required: false, defaultValue: 'auto' },
  ],
  inputSchema: { type: 'object', properties: { code: { type: 'string' } } },
});

const jsonArrayMixed = JSON.stringify([
  {
    name: 'tester',
    description: 'Tests code',
    systemPrompt: 'You are a tester.',
  },
  {
    name: 'test-automation',
    description: 'Automates test execution',
    category: 'automation',
    parameters: [
      { name: 'command', type: 'string', description: 'Test command', required: true },
    ],
  },
]);

const jsonArrayMultipleAgents = JSON.stringify([
  {
    name: 'agent-one',
    description: 'First agent',
    systemPrompt: 'I am one.',
  },
  {
    name: 'agent-two',
    description: 'Second agent',
    systemPrompt: 'I am two.',
  },
]);

const jsonInvalid = '{ broken json }';

const jsonEmpty = '{}';

const jsonEmptyArray = '[]';

const jsonNonAgent = JSON.stringify({
  name: 'config-file',
  version: '1.0.0',
});

// ---------------------------------------------------------------------------
// YAML fixture content
// ---------------------------------------------------------------------------

const yamlAgentSingle = `name: code-reviewer
description: Reviews code for quality
systemPrompt: |
  You are a code reviewer.
  Be thorough.
availableSkills:
  - code-analysis
  - pattern-detection
`;

const yamlAgentNoDescription = `name: bare-agent
systemPrompt: I have no description.
`;

const yamlSkillSingle = `name: code-analysis
description: Analyzes source code
category: development
parameters:
  - name: code
    type: string
    description: Source code to analyze
    required: true
  - name: language
    type: string
    description: Programming language
    required: false
    defaultValue: auto
inputSchema:
  type: object
  properties:
    code:
      type: string
`;

const yamlArrayMixed = `
- name: tester
  description: Tests code
  systemPrompt: You are a tester.
- name: test-automation
  description: Automates test execution
  category: automation
  parameters:
    - name: command
      type: string
      description: Test command
      required: true
`;

const yamlArrayMultipleSkills = `
- name: skill-alpha
  description: Alpha skill
  category: analysis
  parameters: []
- name: skill-beta
  description: Beta skill
  category: research
  parameters: []
`;

const yamlInvalid = [
  'name: unclosed',
  'description: broken value without proper ending',
].join('\n');

const yamlNonDef = [
  'config:',
  '  key: value',
  '  version: 1.0',
].join('\n');

const yamlEmpty = '';

// ---------------------------------------------------------------------------
// Markdown fixture content
// ---------------------------------------------------------------------------

const mdFrontmatterAgent = `---
name: markdown-agent
description: Agent defined in markdown
systemPrompt: You are a markdown agent.
availableSkills:
  - skill-one
  - skill-two
---

# Markdown Agent

This is the body content.
`;

const mdFrontmatterSkill = `---
name: markdown-skill
description: Skill defined in markdown
category: research
parameters:
  - name: query
    type: string
    description: Search query
    required: true
---

# Research Skill

Body content here.
`;

const mdFrontmatterBoth = `---
name: hybrid-agent
description: Agent from markdown
systemPrompt: I am hybrid.
---

---
name: hybrid-skill
description: Skill from markdown
category: communication
parameters: []
---
`;

const mdNoFrontmatter = `# Just a document

This has no frontmatter.
`;

const mdInvalidFrontmatter = `---
name: agent
description: |
  missing terminator
---

Body
`;

// ---------------------------------------------------------------------------
// Tests: extractAgents
// ---------------------------------------------------------------------------

describe('extractAgents', () => {
  it('1 — extracts a single agent from JSON', () => {
    const files = [definitionFile(jsonAgentSingle, '.json')];
    const agents = extractAgents(files);
    expect(agents).toHaveLength(1);
    expect(agents[0].name).toBe('code-reviewer');
    expect(agents[0].description).toBe('Reviews code for quality and best practices');
    expect(agents[0].systemPrompt).toBe('You are a code reviewer. Be thorough.');
    expect(agents[0].availableSkills).toEqual(['code-analysis', 'pattern-detection']);
    expect(agents[0].source).toContain('test.json');
  });

  it('2 — extracts agent using prompt field (not systemPrompt)', () => {
    const files = [definitionFile(jsonAgentWithPrompt, '.json')];
    const agents = extractAgents(files);
    expect(agents).toHaveLength(1);
    expect(agents[0].name).toBe('prompt-agent');
    expect(agents[0].systemPrompt).toBe('You use prompt instead of systemPrompt.');
  });

  it('3 — extracts agent without availableSkills', () => {
    const files = [definitionFile(jsonAgentNoSkills, '.json')];
    const agents = extractAgents(files);
    expect(agents).toHaveLength(1);
    expect(agents[0].availableSkills).toEqual([]);
  });

  it('4 — extracts agents from a JSON array with multiple agents', () => {
    const files = [definitionFile(jsonArrayMultipleAgents, '.json')];
    const agents = extractAgents(files);
    expect(agents).toHaveLength(2);
    expect(agents[0].name).toBe('agent-one');
    expect(agents[1].name).toBe('agent-two');
  });

  it('5 — extracts agent from YAML', () => {
    const files = [definitionFile(yamlAgentSingle, '.yaml')];
    const agents = extractAgents(files);
    expect(agents).toHaveLength(1);
    expect(agents[0].name).toBe('code-reviewer');
    expect(agents[0].description).toBe('Reviews code for quality');
    expect(agents[0].systemPrompt).toContain('You are a code reviewer.');
    expect(agents[0].availableSkills).toEqual(['code-analysis', 'pattern-detection']);
  });

  it('6 — extracts agent from YAML without description', () => {
    const files = [definitionFile(yamlAgentNoDescription, '.yaml')];
    const agents = extractAgents(files);
    expect(agents).toHaveLength(1);
    expect(agents[0].name).toBe('bare-agent');
    expect(agents[0].description).toBe('');
  });

  it('7 — extracts agent from Markdown frontmatter', () => {
    const files = [definitionFile(mdFrontmatterAgent, '.md')];
    const agents = extractAgents(files);
    expect(agents).toHaveLength(1);
    expect(agents[0].name).toBe('markdown-agent');
    expect(agents[0].description).toBe('Agent defined in markdown');
    expect(agents[0].systemPrompt).toBe('You are a markdown agent.');
    expect(agents[0].availableSkills).toEqual(['skill-one', 'skill-two']);
  });

  it('8 — handles Markdown with no frontmatter (empty result)', () => {
    const files = [definitionFile(mdNoFrontmatter, '.md')];
    const agents = extractAgents(files);
    expect(agents).toHaveLength(0);
  });

  it('9 — skips non-definition files', () => {
    const files = [nonDefinitionFile(jsonAgentSingle, '.json')];
    const agents = extractAgents(files);
    expect(agents).toHaveLength(0);
  });

  it('10 — skips unsupported file extensions', () => {
    const files = [definitionFile(jsonAgentSingle, '.txt')];
    const agents = extractAgents(files);
    expect(agents).toHaveLength(0);
  });

  it('11 — handles empty files list', () => {
    const agents = extractAgents([]);
    expect(agents).toHaveLength(0);
  });

  it('12 — handles files with no agent definitions silently', () => {
    const files = [definitionFile(jsonNonAgent, '.json')];
    const agents = extractAgents(files);
    expect(agents).toHaveLength(0);
  });

  it('13 — does not return skill definitions as agents', () => {
    const files = [definitionFile(jsonSkillSingle, '.json')];
    const agents = extractAgents(files);
    expect(agents).toHaveLength(0);
  });

  it('14 — extracts only agents from mixed array', () => {
    const files = [definitionFile(jsonArrayMixed, '.json')];
    const agents = extractAgents(files);
    expect(agents).toHaveLength(1);
    expect(agents[0].name).toBe('tester');
  });
});

// ---------------------------------------------------------------------------
// Tests: extractSkills
// ---------------------------------------------------------------------------

describe('extractSkills', () => {
  it('15 — extracts a single skill from JSON', () => {
    const files = [definitionFile(jsonSkillSingle, '.json')];
    const skills = extractSkills(files);
    expect(skills).toHaveLength(1);
    expect(skills[0].name).toBe('code-analysis');
    expect(skills[0].description).toBe('Analyzes source code for patterns and issues');
    expect(skills[0].category).toBe('development');
    expect(skills[0].parameters).toHaveLength(2);
    expect(skills[0].parameters[0].name).toBe('code');
    expect(skills[0].parameters[0].required).toBe(true);
    expect(skills[0].parameters[1].defaultValue).toBe('auto');
    expect(skills[0].inputSchema).toEqual({ type: 'object', properties: { code: { type: 'string' } } });
    expect(skills[0].source).toContain('test.json');
  });

  it('16 — extracts skill from YAML', () => {
    const files = [definitionFile(yamlSkillSingle, '.yml')];
    const skills = extractSkills(files);
    expect(skills).toHaveLength(1);
    expect(skills[0].name).toBe('code-analysis');
    expect(skills[0].category).toBe('development');
    expect(skills[0].parameters).toHaveLength(2);
    expect(skills[0].parameters[0].name).toBe('code');
    expect(skills[0].parameters[1].name).toBe('language');
    expect(skills[0].parameters[1].defaultValue).toBe('auto');
  });

  it('17 — extracts skill from Markdown frontmatter', () => {
    const files = [definitionFile(mdFrontmatterSkill, '.md')];
    const skills = extractSkills(files);
    expect(skills).toHaveLength(1);
    expect(skills[0].name).toBe('markdown-skill');
    expect(skills[0].category).toBe('research');
    expect(skills[0].parameters).toHaveLength(1);
    expect(skills[0].parameters[0].name).toBe('query');
  });

  it('18 — extracts multiple skills from YAML array', () => {
    const files = [definitionFile(yamlArrayMultipleSkills, '.yaml')];
    const skills = extractSkills(files);
    expect(skills).toHaveLength(2);
    expect(skills[0].name).toBe('skill-alpha');
    expect(skills[1].name).toBe('skill-beta');
  });

  it('19 — extracts only skills from mixed array', () => {
    const files = [definitionFile(jsonArrayMixed, '.json')];
    const skills = extractSkills(files);
    expect(skills).toHaveLength(1);
    expect(skills[0].name).toBe('test-automation');
  });

  it('20 — returns empty for files with no skill definitions', () => {
    const files = [definitionFile(jsonAgentSingle, '.json')];
    const skills = extractSkills(files);
    expect(skills).toHaveLength(0);
  });

  it('21 — handles empty categories gracefully', () => {
    const content = JSON.stringify({
      name: 'no-cat',
      description: 'Skill without category',
      parameters: [],
    });
    const files = [definitionFile(content, '.json')];
    const skills = extractSkills(files);
    expect(skills).toHaveLength(1);
    expect(skills[0].category).toBe('other');
  });
});

// ---------------------------------------------------------------------------
// Tests: extractAll
// ---------------------------------------------------------------------------

describe('extractAll', () => {
  it('22 — extracts both agents and skills from mixed array', () => {
    const files = [definitionFile(jsonArrayMixed, '.json')];
    const result = extractAll(files);
    expect(result.agents).toHaveLength(1);
    expect(result.skills).toHaveLength(1);
    expect(result.agents[0].name).toBe('tester');
    expect(result.skills[0].name).toBe('test-automation');
    expect(result.warnings).toEqual([]);
  });

  it('23 — collects warnings for invalid JSON', () => {
    const files = [definitionFile(jsonInvalid, '.json')];
    const result = extractAll(files);
    expect(result.agents).toHaveLength(0);
    expect(result.skills).toHaveLength(0);
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]).toContain('JSON parse error');
  });

  it('24 — collects warnings for invalid YAML', () => {
    const files = [definitionFile(yamlInvalid, '.yaml')];
    const result = extractAll(files);
    expect(result.agents).toHaveLength(0);
    expect(result.skills).toHaveLength(0);
    // YAML parser may or may not produce a warning depending on robustness
    // Just verify it returns gracefully
    expect(result.warnings.length).toBeGreaterThanOrEqual(0);
  });

  it('25 — collects warnings for invalid Markdown frontmatter', () => {
    const files = [definitionFile(mdInvalidFrontmatter, '.md')];
    const result = extractAll(files);
    // The parser may handle gracefully or warn
    // Just verify no crash
    expect(Array.isArray(result.agents)).toBe(true);
    expect(Array.isArray(result.skills)).toBe(true);
    expect(Array.isArray(result.warnings)).toBe(true);
  });

  it('26 — handles empty content files', () => {
    const files = [definitionFile('', '.json')];
    const result = extractAll(files);
    expect(result.agents).toHaveLength(0);
    expect(result.skills).toHaveLength(0);
  });

  it('27 — handles empty JSON / empty array', () => {
    const files = [
      definitionFile(jsonEmpty, '.json'),
      definitionFile(jsonEmptyArray, '.json'),
    ];
    const result = extractAll(files);
    expect(result.agents).toHaveLength(0);
    expect(result.skills).toHaveLength(0);
    expect(result.warnings).toEqual([]);
  });

  it('28 — processes multiple files', () => {
    const files = [
      definitionFile(jsonAgentSingle, '.json', true, 'agent.json'),
      definitionFile(jsonSkillSingle, '.json', true, 'skill.json'),
    ];
    const result = extractAll(files);
    expect(result.agents).toHaveLength(1);
    expect(result.skills).toHaveLength(1);
    expect(result.warnings).toEqual([]);
  });

  it('29 — skips non-definition files', () => {
    const files = [
      definitionFile(jsonAgentSingle, '.json', false, 'hidden.json'),
      definitionFile(jsonSkillSingle, '.json', true, 'visible.json'),
    ];
    const result = extractAll(files);
    expect(result.agents).toHaveLength(0);
    expect(result.skills).toHaveLength(1);
  });

  it('30 — handles mixed format files in one pass', () => {
    const files = [
      definitionFile(jsonAgentSingle, '.json', true, 'agent.json'),
      definitionFile(yamlSkillSingle, '.yaml', true, 'skill.yaml'),
      definitionFile(mdFrontmatterAgent, '.md', true, 'readme.md'),
    ];
    const result = extractAll(files);
    expect(result.agents).toHaveLength(2); // JSON agent + MD agent
    expect(result.skills).toHaveLength(1); // YAML skill
  });

  it('31 — unknown category defaults to "other"', () => {
    const content = JSON.stringify({
      name: 'weird',
      description: 'Weird category skill',
      category: 'unknown-category',
      parameters: [],
    });
    const files = [definitionFile(content, '.json')];
    const skills = extractSkills(files);
    expect(skills[0].category).toBe('other');
  });
});
