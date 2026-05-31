/**
 * Agent & Skill extractor for the meta-workflow system.
 *
 * Parses scanned project files in JSON, YAML, and Markdown formats to
 * extract agent and skill definitions. Filters candidate files via the
 * `isDefinition` flag provided by the scanner.
 *
 * ## File Format Handling
 *
 * - **JSON** (`.json`): Parses the full content. Handles both single objects
 *   and arrays of objects. A definition is considered an agent if it has
 *   `name` + (`systemPrompt` or `prompt`). A definition is considered a
 *   skill if it has `name` + `description` + (`category` or `parameters`).
 *
 * - **YAML** (`.yaml`, `.yml`): Uses a lightweight built-in parser that
 *   handles simple key-value pairs, arrays, and quoted values common in
 *   agent/skill definitions. No external YAML library is required.
 *
 * - **Markdown** (`.md`, `.mdx`): Extracts YAML frontmatter (content between
 *   `---` markers at the start of the file) and parses it as a definition.
 *   Headings and body content are not currently parsed for definitions.
 */

import * as path from 'node:path';
import type { SkillCategory, SkillParameter } from '@dynflow/shared';

// ---------------------------------------------------------------------------
// Types (mirrors scanner.ts — shared contract for meta-workflow)
// ---------------------------------------------------------------------------

/**
 * A file discovered during project scanning.
 * The scanner populates `content` only for definition files.
 */
export interface ScannedFile {
  /** Relative path within the repository */
  path: string;
  /** File contents (populated only for definition files) */
  content: string;
  /** File size in bytes */
  size: number;
  /** True when the file looks like an agent/skill definition */
  isDefinition: boolean;
}

// ---------------------------------------------------------------------------
// Exported interfaces
// ---------------------------------------------------------------------------

export interface ExtractedAgent {
  name: string;
  description: string;
  systemPrompt: string;
  availableSkills: string[];
  /** The source file path this agent was extracted from */
  source: string;
}

export interface ExtractedSkill {
  name: string;
  description: string;
  category: SkillCategory;
  parameters: SkillParameter[];
  inputSchema?: Record<string, unknown>;
  outputSchema?: Record<string, unknown>;
  /** The source file path this skill was extracted from */
  source: string;
}

export interface ExtractionResult {
  agents: ExtractedAgent[];
  skills: ExtractedSkill[];
  warnings: string[];
}

// ---------------------------------------------------------------------------
// Definition format detection helpers
// ---------------------------------------------------------------------------

const AGENT_EXTENSIONS = new Set(['.json', '.yaml', '.yml', '.md', '.mdx']);

function getExtension(filePath: string): string {
  return path.extname(filePath).toLowerCase();
}

function isAgentObject(obj: unknown): obj is Record<string, unknown> {
  if (!obj || typeof obj !== 'object') return false;
  const o = obj as Record<string, unknown>;
  return Boolean(
    typeof o.name === 'string' &&
    o.name.length > 0 &&
    (typeof o.systemPrompt === 'string' || typeof o.prompt === 'string'),
  );
}

function isSkillObject(obj: unknown): obj is Record<string, unknown> {
  if (!obj || typeof obj !== 'object') return false;
  const o = obj as Record<string, unknown>;
  return Boolean(
    typeof o.name === 'string' &&
    o.name.length > 0 &&
    typeof o.description === 'string' &&
    (typeof o.category === 'string' || Array.isArray(o.parameters)),
  );
}

function isSupportedFormat(ext: string): boolean {
  return AGENT_EXTENSIONS.has(ext.toLowerCase());
}

// ---------------------------------------------------------------------------
// Object-to-interface builders
// ---------------------------------------------------------------------------

function toExtractedAgent(obj: Record<string, unknown>, source: string): ExtractedAgent {
  const availableSkills: string[] = [];
  if (Array.isArray(obj.availableSkills)) {
    for (const s of obj.availableSkills) {
      if (typeof s === 'string') availableSkills.push(s);
    }
  }
  return {
    name: String(obj.name),
    description: String(obj.description ?? ''),
    systemPrompt: String(obj.systemPrompt ?? obj.prompt ?? ''),
    availableSkills,
    source,
  };
}

function toExtractedSkill(obj: Record<string, unknown>, source: string): ExtractedSkill {
  const parameters: SkillParameter[] = [];
  if (Array.isArray(obj.parameters)) {
    for (const p of obj.parameters) {
      if (p && typeof p === 'object') {
        parameters.push({
          name: String((p as Record<string, unknown>).name ?? ''),
          type: String((p as Record<string, unknown>).type ?? 'string'),
          description: String((p as Record<string, unknown>).description ?? ''),
          required: Boolean((p as Record<string, unknown>).required),
          defaultValue: (p as Record<string, unknown>).defaultValue,
        });
      }
    }
  }

  let category: SkillCategory = 'other';
  if (typeof obj.category === 'string') {
    const valid: SkillCategory[] = [
      'development', 'analysis', 'research', 'creative',
      'communication', 'automation', 'other',
    ];
    if (valid.includes(obj.category as SkillCategory)) {
      category = obj.category as SkillCategory;
    }
  }

  return {
    name: String(obj.name),
    description: String(obj.description ?? ''),
    category,
    parameters,
    inputSchema: obj.inputSchema as Record<string, unknown> | undefined,
    outputSchema: obj.outputSchema as Record<string, unknown> | undefined,
    source,
  };
}

// ---------------------------------------------------------------------------
// Lightweight YAML parser
// ---------------------------------------------------------------------------

/**
 * Parses a YAML string into a JavaScript value.
 *
 * This is deliberately simple — it handles only the subset of YAML that
 * agent/skill definition files commonly use:
 *   - Key-value pairs (`key: value`)
 *   - Quoted strings (`key: "value"`, `key: 'value'`)
 *   - Arrays (`- item`)
 *   - Multiline strings (literal `|` and folded `>` blocks)
 *   - Nested objects via indentation
 *   - Comments (`#`)
 *
 * It does NOT handle:
 *   - Anchors/aliases (`&anchor`, `*alias`)
 *   - Tags (`!!str`)
 *   - Complex types (dates, timestamps)
 *   - Multi-document streams (`---` separator)
 */
function parseSimpleYaml(input: string): unknown {
  const lines = input.split('\n');
  const result = parseYamlValue(lines, 0).value;
  return result;
}

interface ParseResult {
  value: unknown;
  consumed: number;
}

function parseYamlValue(lines: string[], start: number, indent = 0): ParseResult {
  // Skip empty lines
  let i = start;
  while (i < lines.length && lines[i].trim() === '') i++;

  if (i >= lines.length) return { value: undefined, consumed: i - start };

  const line = lines[i];
  const trimmed = line.trimStart();

  // Array item
  if (trimmed.startsWith('- ')) {
    return parseYamlArray(lines, i, indent);
  }

  // Object (key-value pairs)
  if (trimmed.includes(':')) {
    return parseYamlObject(lines, i, indent);
  }

  // Scalar
  return { value: parseYamlScalar(trimmed), consumed: 1 };
}

function parseYamlScalar(value: string): string | number | boolean | null {
  // Remove inline comments (but not inside quotes)
  const noComment = removeTrailingComment(value).trim();

  if (noComment === 'null' || noComment === '~') return null;
  if (noComment === 'true' || noComment === 'yes') return true;
  if (noComment === 'false' || noComment === 'no') return false;

  // Quoted strings
  if (
    (noComment.startsWith('"') && noComment.endsWith('"')) ||
    (noComment.startsWith("'") && noComment.endsWith("'"))
  ) {
    return noComment.slice(1, -1);
  }

  // Numbers
  const num = Number(noComment);
  if (!Number.isNaN(num) && noComment.length > 0) return num;

  // Plain string
  return noComment;
}

function removeTrailingComment(line: string): string {
  let inSingle = false;
  let inDouble = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === "'" && !inDouble) inSingle = !inSingle;
    else if (ch === '"' && !inSingle) inDouble = !inDouble;
    else if (ch === '#' && !inSingle && !inDouble) {
      return line.slice(0, i);
    }
  }
  return line;
}

function getIndent(line: string): number {
  return line.length - line.trimStart().length;
}

function parseYamlObject(lines: string[], start: number, baseIndent: number): ParseResult {
  const obj: Record<string, unknown> = {};
  let i = start;

  while (i < lines.length) {
    const line = lines[i];
    const trimmed = line.trimStart();
    if (trimmed === '' || trimmed.startsWith('#')) {
      i++;
      continue;
    }

    const indent = getIndent(line);
    if (indent < baseIndent) break; // Less indentation → end of object

    // Check if this is an array item (which belongs to parent)
    if (trimmed.startsWith('- ')) break;

    const colonIdx = trimmed.indexOf(':');
    if (colonIdx === -1) break; // Not a key-value pair

    const key = trimmed.slice(0, colonIdx).trim();
    let rest = trimmed.slice(colonIdx + 1).trim();

    if (rest === '') {
      // Value might be on the next line(s) with more indentation
      const nextIndent = i + 1 < lines.length ? getIndent(lines[i + 1]) : -1;
      if (nextIndent > indent) {
        const childResult = parseYamlValue(lines, i + 1, nextIndent);
        obj[key] = childResult.value;
        i += childResult.consumed + 1;
        continue;
      }
      obj[key] = null;
    } else if (rest === '|') {
      // Literal block scalar (preserves newlines)
      const block = collectBlock(lines, i + 1, getIndent(line) + 2);
      obj[key] = block.text;
      i += block.consumed + 1;
      continue;
    } else if (rest === '>') {
      // Folded block scalar (replaces newlines with spaces)
      const block = collectBlock(lines, i + 1, getIndent(line) + 2);
      obj[key] = block.text.replace(/\n\n/g, '\n').replace(/\n/g, ' ');
      i += block.consumed + 1;
      continue;
    } else {
      obj[key] = parseYamlScalar(rest);
    }

    i++;
  }

  return { value: obj, consumed: i - start };
}

function collectBlock(
  lines: string[],
  start: number,
  blockIndent: number,
): { text: string; consumed: number } {
  const parts: string[] = [];
  let i = start;
  while (i < lines.length) {
    const line = lines[i];
    if (line.trim() === '') {
      parts.push('');
      i++;
      continue;
    }
    const indent = getIndent(line);
    if (indent < blockIndent) break;
    // Remove exactly blockIndent spaces from the start
    parts.push(line.slice(blockIndent));
    i++;
  }
  return { text: parts.join('\n'), consumed: i - start };
}

function parseYamlArray(lines: string[], start: number, baseIndent: number): ParseResult {
  const items: unknown[] = [];
  let i = start;

  while (i < lines.length) {
    const line = lines[i];
    const trimmed = line.trimStart();
    if (trimmed === '' || trimmed.startsWith('#')) {
      i++;
      continue;
    }

    const indent = getIndent(line);
    if (indent < baseIndent) break;

    if (!trimmed.startsWith('- ')) {
      // Could be a sub-key of an object item — check if we're in a nested object
      if (trimmed.includes(':') && items.length > 0) {
        // Might be a continuation of the last array item's object
        const lastItem = items[items.length - 1];
        if (typeof lastItem === 'object' && lastItem !== null) {
          const colonIdx = trimmed.indexOf(':');
          const key = trimmed.slice(0, colonIdx).trim();
          const rest = trimmed.slice(colonIdx + 1).trim();
          (lastItem as Record<string, unknown>)[key] = parseYamlScalar(rest);
          i++;
          continue;
        }
      }
      break;
    }

    const valueStr = trimmed.slice(2).trimStart();
    if (valueStr === '') {
      // Complex item (next lines with more indent)
      const nextIndent = i + 1 < lines.length ? getIndent(lines[i + 1]) : -1;
      if (nextIndent > indent) {
        const childResult = parseYamlValue(lines, i + 1, nextIndent);
        items.push(childResult.value);
        i += childResult.consumed + 1;
        continue;
      }
      items.push(null);
    } else {
      // Check if this is key: value inline
      if (valueStr.includes(':') && !valueStr.startsWith('"') && !valueStr.startsWith("'")) {
        const colonIdx = valueStr.indexOf(':');
        const key = valueStr.slice(0, colonIdx).trim();
        const rest = valueStr.slice(colonIdx + 1).trim();
        const childObj: Record<string, unknown> = {};
        childObj[key] = rest ? parseYamlScalar(rest) : null;

        // Check for more key-value pairs on subsequent lines with the same indentation
        let j = i + 1;
        while (j < lines.length) {
          const nextLine = lines[j];
          const nextTrimmed = nextLine.trimStart();
          const nextIndent = getIndent(nextLine);
          if (nextIndent < indent || nextTrimmed.startsWith('- ')) break;
          if (nextTrimmed.includes(':') && !nextTrimmed.startsWith('- ')) {
            const nColon = nextTrimmed.indexOf(':');
            const nKey = nextTrimmed.slice(0, nColon).trim();
            const nRest = nextTrimmed.slice(nColon + 1).trim();
            childObj[nKey] = nRest ? parseYamlScalar(nRest) : null;
            j++;
          } else {
            break;
          }
        }

        items.push(childObj);
        i = j;
        continue;
      }

      items.push(parseYamlScalar(valueStr));
    }

    i++;
  }

  return { value: items, consumed: i - start };
}

// ---------------------------------------------------------------------------
// Per-format extraction
// ---------------------------------------------------------------------------

function extractFromJson(
  content: string,
  source: string,
): { agents: ExtractedAgent[]; skills: ExtractedSkill[]; warning?: string } {
  let data: unknown;
  try {
    data = JSON.parse(content);
  } catch (e) {
    return {
      agents: [],
      skills: [],
      warning: `JSON parse error in ${source}: ${(e as Error).message}`,
    };
  }

  const items = Array.isArray(data) ? data : [data];
  const agents: ExtractedAgent[] = [];
  const skills: ExtractedSkill[] = [];

  for (const item of items) {
    if (isAgentObject(item)) {
      agents.push(toExtractedAgent(item as Record<string, unknown>, source));
    } else if (isSkillObject(item)) {
      skills.push(toExtractedSkill(item as Record<string, unknown>, source));
    }
  }

  return { agents, skills };
}

function extractFromYaml(
  content: string,
  source: string,
): { agents: ExtractedAgent[]; skills: ExtractedSkill[]; warning?: string } {
  let data: unknown;
  try {
    data = parseSimpleYaml(content);
  } catch (e) {
    return {
      agents: [],
      skills: [],
      warning: `YAML parse error in ${source}: ${(e as Error).message}`,
    };
  }

  if (data === null || data === undefined) {
    return { agents: [], skills: [] };
  }

  const items = Array.isArray(data) ? data : [data];
  const agents: ExtractedAgent[] = [];
  const skills: ExtractedSkill[] = [];

  for (const item of items) {
    if (item && typeof item === 'object') {
      if (isAgentObject(item)) {
        agents.push(toExtractedAgent(item as Record<string, unknown>, source));
      } else if (isSkillObject(item)) {
        skills.push(toExtractedSkill(item as Record<string, unknown>, source));
      }
    }
  }

  return { agents, skills };
}

function extractFromMarkdown(
  content: string,
  source: string,
): { agents: ExtractedAgent[]; skills: ExtractedSkill[]; warning?: string } {
  const agents: ExtractedAgent[] = [];
  const skills: ExtractedSkill[] = [];

  // Try frontmatter (YAML between --- markers)
  const frontmatterMatch = content.match(/^---\n([\s\S]*?)\n---\n?/);
  if (!frontmatterMatch) {
    return { agents: [], skills: [] };
  }

  let fm: unknown;
  try {
    fm = parseSimpleYaml(frontmatterMatch[1]);
  } catch (e) {
    return {
      agents: [],
      skills: [],
      warning: `Frontmatter parse error in ${source}: ${(e as Error).message}`,
    };
  }

  if (fm && typeof fm === 'object' && !Array.isArray(fm)) {
    if (isAgentObject(fm)) {
      agents.push(toExtractedAgent(fm as Record<string, unknown>, source));
    }
    if (isSkillObject(fm)) {
      skills.push(toExtractedSkill(fm as Record<string, unknown>, source));
    }
  }

  return { agents, skills };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Extract agent definitions from scanned project files.
 *
 * Only files with `isDefinition === true` and supported extensions
 * (`.json`, `.yaml`, `.yml`, `.md`, `.mdx`) are processed.
 * Warnings for parse errors are collected but not returned from this
 * function — use `extractAll()` if you need warnings.
 */
export function extractAgents(files: ScannedFile[]): ExtractedAgent[] {
  const agents: ExtractedAgent[] = [];

  for (const file of files) {
    if (!file.isDefinition) continue;
    if (!isSupportedFormat(getExtension(file.path))) continue;

    const ext = getExtension(file.path);
    let result: { agents: ExtractedAgent[]; skills: ExtractedSkill[] };

    if (ext === '.json') {
      result = extractFromJson(file.content, file.path);
    } else if (ext === '.yaml' || ext === '.yml') {
      result = extractFromYaml(file.content, file.path);
    } else {
      // .md / .mdx
      result = extractFromMarkdown(file.content, file.path);
    }

    agents.push(...result.agents);
  }

  return agents;
}

/**
 * Extract skill definitions from scanned project files.
 *
 * Only files with `isDefinition === true` and supported extensions
 * are processed. Warnings for parse errors are collected but not
 * returned — use `extractAll()` if you need warnings.
 */
export function extractSkills(files: ScannedFile[]): ExtractedSkill[] {
  const skills: ExtractedSkill[] = [];

  for (const file of files) {
    if (!file.isDefinition) continue;
    if (!isSupportedFormat(getExtension(file.path))) continue;

    const ext = getExtension(file.path);
    let result: { agents: ExtractedAgent[]; skills: ExtractedSkill[] };

    if (ext === '.json') {
      result = extractFromJson(file.content, file.path);
    } else if (ext === '.yaml' || ext === '.yml') {
      result = extractFromYaml(file.content, file.path);
    } else {
      result = extractFromMarkdown(file.content, file.path);
    }

    skills.push(...result.skills);
  }

  return skills;
}

/**
 * Extract both agent and skill definitions from scanned project files.
 *
 * Returns an `ExtractionResult` containing both extracted entities
 * and any warnings collected during parsing.
 */
export function extractAll(files: ScannedFile[]): ExtractionResult {
  const agents: ExtractedAgent[] = [];
  const skills: ExtractedSkill[] = [];
  const warnings: string[] = [];

  for (const file of files) {
    if (!file.isDefinition) continue;
    if (!isSupportedFormat(getExtension(file.path))) continue;

    const ext = getExtension(file.path);
    let result: { agents: ExtractedAgent[]; skills: ExtractedSkill[]; warning?: string };

    if (ext === '.json') {
      result = extractFromJson(file.content, file.path);
    } else if (ext === '.yaml' || ext === '.yml') {
      result = extractFromYaml(file.content, file.path);
    } else {
      result = extractFromMarkdown(file.content, file.path);
    }

    agents.push(...result.agents);
    skills.push(...result.skills);
    if (result.warning) warnings.push(result.warning);
  }

  return { agents, skills, warnings };
}
