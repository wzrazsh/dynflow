/**
 * Sandbox runtime for executing user workflow scripts.
 *
 * Implements a two-tier strategy:
 * 1. Try to use `isolated-vm` (V8 Isolate) — the preferred approach.
 * 2. Fall back to a pattern-based string parser when native compilation
 *    is unavailable (common on Windows without Build Tools).
 *
 * The user script API looks like:
 * ```js
 * phase("Research", () => {
 *   agent("researcher-1", "Research quantum computing");
 *   agent("researcher-2", "Research cryptography");
 * });
 * ```
 */

import type { WorkflowDefinition, PhaseDefinition, AgentDefinition } from '@dynflow/shared';
import { validateWorkflowDefinition } from '@dynflow/shared';
import type { SandboxResult, SandboxOptions } from './types.js';

// ---------------------------------------------------------------------------
// Internal parsed representation
// ---------------------------------------------------------------------------

interface ParsedAgent {
  name: string;
  prompt?: string;
  agentId?: string;
  line: number;
}

interface ParsedPhase {
  name: string;
  agents: ParsedAgent[];
  line: number;
}

// ---------------------------------------------------------------------------
// Lazy isolated-vm loader
// ---------------------------------------------------------------------------

let ivmModule: any = undefined;
let ivmLoadAttempted = false;

async function getIsolatedVm(): Promise<any> {
  if (!ivmLoadAttempted) {
    ivmLoadAttempted = true;
    try {
      const mod = await import('isolated-vm');
      // ESM wraps in default; handle both: mod.Isolate or mod.default.Isolate
      let candidate: any = null;
      if (mod.Isolate) {
        candidate = mod;
      } else if (mod.default && mod.default.Isolate) {
        candidate = mod.default;
      }
      // Verify it actually works
      if (candidate && typeof candidate.Isolate === 'function') {
        ivmModule = candidate;
      } else {
        ivmModule = null;
      }
    } catch {
      ivmModule = null;
    }
  }
  return ivmModule;
}

// ---------------------------------------------------------------------------
// Public entry point
// ---------------------------------------------------------------------------

/**
 * Parse / execute a user workflow script and return the extracted definition.
 */
export async function executeScript(
  script: string,
  options: SandboxOptions,
): Promise<SandboxResult> {
  const ivm = await getIsolatedVm();

  if (ivm) {
    return executeWithIsolate(script, options, ivm);
  }
  return executeWithParser(script, options);
}

// ---------------------------------------------------------------------------
// Fallback: pattern-based parser
// ---------------------------------------------------------------------------

/**
 * Execute the user script inside a V8 Isolate via isolated-vm.
 * The injected API (phase/agent) is prepended as source code so it runs
 * entirely within the isolate — no cross-context Reference gymnastics.
 */
async function executeWithIsolate(
  script: string,
  options: SandboxOptions,
  ivm: any,
): Promise<SandboxResult> {
  // Build the injected API that records phase/agent calls inside the isolate.
  // Uses globalThis so the array is accessible from the host after execution.
  const injectCode = `
var __currentPhase__ = null;
globalThis.__phases__ = [];

function phase(name, fn) {
  if (__currentPhase__ !== null) {
    throw new Error("Nested phase() calls are not allowed");
  }
  if (typeof name !== 'string' || name.trim().length === 0) {
    throw new Error("Phase name is required");
  }
  __currentPhase__ = { name: name, agents: [] };
  fn();
  globalThis.__phases__.push(__currentPhase__);
  __currentPhase__ = null;
}

function agent(name, promptOrConfig) {
  if (__currentPhase__ === null) {
    throw new Error("agent() called outside phase()");
  }
  if (typeof name !== 'string' || name.trim().length === 0) {
    throw new Error("Agent name is required");
  }
  if (typeof promptOrConfig === 'string') {
    if (promptOrConfig.trim().length === 0) {
      throw new Error("Agent prompt is required");
    }
    __currentPhase__.agents.push({ name: name, prompt: promptOrConfig });
  } else if (typeof promptOrConfig === 'object' && promptOrConfig !== null) {
    var entry = { name: name };
    if (promptOrConfig.prompt) {
      entry.prompt = promptOrConfig.prompt;
    }
    if (promptOrConfig.agentId) {
      entry.agentId = promptOrConfig.agentId;
    }
    if (!entry.prompt && !entry.agentId) {
      throw new Error("Agent must have either a prompt or an agentId");
    }
    __currentPhase__.agents.push(entry);
  } else {
    throw new Error("agent() second argument must be a string or an object with agentId/prompt");
  }
}
`;

  const fullScript = `${injectCode}\n${script}`;

  let isolate: any = undefined;

  try {
    isolate = new ivm.Isolate({ memoryLimit: options.memoryLimitMb });
    const context = await isolate.createContext();

    // Compile (async in v6) then run (also async in v6)
    const scriptInstance = await isolate.compileScript(fullScript);
    await scriptInstance.run(context, { timeout: options.timeoutMs });

    // Extract the recorded phases
    const phasesRef = await context.global.get('__phases__');
    const raw: Array<{ name: string; agents: Array<{ name: string; prompt?: string; agentId?: string }> }> =
      await phasesRef.copy();

    // Validate limits
    if (raw.length > 50) {
      return {
        success: false,
        error: `Script defines ${raw.length} phases (maximum is 50)`,
      };
    }
    const totalAgents = raw.reduce((s, p) => s + p.agents.length, 0);
    if (totalAgents > 1000) {
      return {
        success: false,
        error: `Script defines ${totalAgents} agents (maximum is 1000)`,
      };
    }

    // Build WorkflowDefinition
    const definition: WorkflowDefinition = {
      name: 'User Script',
      phases: raw.map(
        (p): PhaseDefinition => ({
          name: p.name,
          agents: p.agents.map(
          (a): AgentDefinition => ({ name: a.name, prompt: a.prompt ?? '', ...(a.agentId ? { agentId: a.agentId } : {}) }),
          ),
        }),
      ),
    };

    // Validate with shared schema
    const validation = validateWorkflowDefinition(definition);
    if (!validation.valid) {
      return {
        success: false,
        error: validation.errors?.[0]?.message ?? 'Invalid workflow definition',
      };
    }

    return { success: true, definition };
  } catch (err: any) {
    const msg = err?.message ?? String(err);
    const stack = err?.stack ?? '';

    if (
      msg.includes('Script execution timed out') ||
      msg.includes('timed out')
    ) {
      return { success: false, error: 'Script execution timed out' };
    }

    // Try to extract a line number from the V8 stack trace
    // Stack format: "at agent (<isolated-vm>:LINE:COL)" or "at <isolated-vm>:LINE:COL"
    let line: number | undefined;
    const v8LineInStack = stack.match(/<isolated-vm>:(\d+):\d+/);
    if (v8LineInStack) {
      line = parseInt(v8LineInStack[1], 10);
    }
    // Fallback: look for ":line:col" in the message
    if (line === undefined) {
      const v8LineMatch = msg.match(/:(\d+):\d+/);
      if (v8LineMatch) {
        line = parseInt(v8LineMatch[1], 10);
      }
    }
    // Last resort: "line N" in message
    if (line === undefined) {
      const lineMatch = msg.match(/line\s+(\d+)/i);
      line = lineMatch ? parseInt(lineMatch[1], 10) : undefined;
    }

    // If isolated-vm is active, subtract the inject-code preamble lines
    // so the reported line aligns with the user's script.
    if (line !== undefined) {
      const injectLineCount = injectCode.split('\n').length;
      line = Math.max(1, line - injectLineCount);
    }

    return { success: false, error: msg, line };
  } finally {
    // Always dispose the isolate to free memory
    if (isolate) {
      try {
        isolate.dispose();
      } catch {
        // safe to ignore
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Fallback: pattern-based parser
// ---------------------------------------------------------------------------

/**
 * Fallback: parse the script using string pattern matching.
 * Works without native compilation. Extracts phase/agent definitions
 * by scanning for the known function-call patterns.
 */
async function executeWithParser(
  script: string,
  options: SandboxOptions,
): Promise<SandboxResult> {
  // Wrap in a timeout for safety
  return Promise.race([
    parseScript(script),
    new Promise<SandboxResult>((_, reject) =>
      setTimeout(() => reject(new Error('TIMEOUT')), options.timeoutMs),
    ),
  ]);
}

async function parseScript(script: string): Promise<SandboxResult> {
  // 1. Basic syntax check — balanced braces
  const braceCheck = checkBalancedBraces(script);
  if (braceCheck !== null) {
    return { success: false, error: 'Unmatched opening brace', line: braceCheck };
  }

  // 2. Check for nested phase() calls (phase() inside another phase callback)
  const nestedLine = findNestedPhase(script);
  if (nestedLine !== null) {
    return {
      success: false,
      error: 'Nested phase() calls are not allowed',
      line: nestedLine,
    };
  }

  // 3. Check for agent() outside of any phase() block
  const agentOutsideLine = findAgentOutsidePhase(script);
  if (agentOutsideLine !== null) {
    return {
      success: false,
      error: 'agent() called outside phase() block',
      line: agentOutsideLine,
    };
  }

  // 4. Extract phase blocks
  const phases = extractPhases(script);

  // 5. Validate phase and agent entries
  for (const phase of phases) {
    if (!phase.name || phase.name.trim().length === 0) {
      return { success: false, error: 'Phase name is required', line: phase.line };
    }
    for (const agent of phase.agents) {
      if (!agent.name || agent.name.trim().length === 0) {
        return {
          success: false,
          error: 'Agent name is required',
          line: agent.line,
        };
      }
      if (!agent.prompt && !agent.agentId) {
        return {
          success: false,
          error: 'Agent must have either a prompt (for dynamic agents) or an agentId (for predefined agents)',
          line: agent.line,
        };
      }
    }
  }

  // 6. Check limits
  if (phases.length > 50) {
    return {
      success: false,
      error: `Script defines ${phases.length} phases (maximum is 50)`,
    };
  }
  const totalAgents = phases.reduce((s, p) => s + p.agents.length, 0);
  if (totalAgents > 1000) {
    return {
      success: false,
      error: `Script defines ${totalAgents} agents (maximum is 1000)`,
    };
  }

  // 7. Build WorkflowDefinition
  const definition: WorkflowDefinition = {
    name: 'User Script',
    phases: phases.map(
      (p): PhaseDefinition => ({
        name: p.name,
        agents: p.agents.map(
          (a): AgentDefinition => ({ name: a.name, prompt: a.prompt ?? '', ...(a.agentId ? { agentId: a.agentId } : {}) }),
        ),
      }),
    ),
  };

  // 8. Validate with shared schema
  const validation = validateWorkflowDefinition(definition);
  if (!validation.valid) {
    return {
      success: false,
      error: validation.errors?.[0]?.message ?? 'Invalid workflow definition',
    };
  }

  return { success: true, definition };
}

// ---------------------------------------------------------------------------
// Brace-balancing
// ---------------------------------------------------------------------------

/**
 * Returns the line number of the first unmatched opening `{`, or `null` if
 * braces are balanced.
 */
function checkBalancedBraces(code: string): number | null {
  const stack: Array<{ char: string; line: number }> = [];
  let line = 1;

  for (let i = 0; i < code.length; i++) {
    const ch = code[i];

    if (ch === '\n') {
      line++;
      continue;
    }

    // Skip string literals
    if (ch === '"' || ch === "'") {
      i = skipStringLiteral(code, i);
      continue;
    }

    if (ch === '{') {
      stack.push({ char: '{', line });
    } else if (ch === '}') {
      if (stack.length === 0) {
        // Closing brace without opening — syntax error we can still handle,
        // but we report the position.
        return line;
      }
      stack.pop();
    }
  }

  if (stack.length > 0) {
    const last = stack.pop()!;
    // Find the actual line of the unmatched opening
    return findBraceLine(code, last.char, last.line);
  }

  return null; // balanced
}

/** Skip past a string literal starting at `pos` (the opening quote). */
function skipStringLiteral(code: string, pos: number): number {
  const quote = code[pos];
  pos++;
  while (pos < code.length) {
    if (code[pos] === '\\') {
      pos++; // skip escaped char
    } else if (code[pos] === quote) {
      return pos; // end of string
    }
    pos++;
  }
  return pos;
}

/** Approximate the line where an unmatched brace occurs. */
function findBraceLine(code: string, _char: string, approxLine: number): number {
  // Walk backwards a bit from approxLine to find the nearest '{'
  // This is a best-effort approximation.
  let line = 1;
  for (let i = 0; i < code.length; i++) {
    if (code[i] === '\n') {
      line++;
    }
    if (line >= approxLine - 2) {
      // Scan forward for '{'
      for (let j = i; j < code.length; j++) {
        if (code[j] === '{') return line;
        if (code[j] === '\n') line++;
      }
      break;
    }
  }
  return approxLine;
}

// ---------------------------------------------------------------------------
// Nested-phase detection
// ---------------------------------------------------------------------------

/**
 * Returns the line of a nested `phase()` call (one inside another phase's
 * callback body), or `null` if none found.
 */
function findNestedPhase(code: string): number | null {
  const phaseRegex = /phase\s*\(/g;
  const phaseMatches: Array<{ start: number; end: number; line: number }> = [];
  let m: RegExpExecArray | null;

  // First, locate all phase(...) blocks
  while ((m = phaseRegex.exec(code)) !== null) {
    const start = m.index;
    const line = getLineNumber(code, start);

    const { bodyStart, bodyEnd } = findPhaseBody(code, start);
    if (bodyStart === -1 || bodyEnd === -1) continue;

    phaseMatches.push({ start, end: bodyEnd, line });
  }

  // Then check if any phase body contains another `phase(` call
  for (const outer of phaseMatches) {
    const body = code.slice(outer.start, outer.end);
    const innerPhaseRegex = /phase\s*\(/g;
    let inner: RegExpExecArray | null;
    while ((inner = innerPhaseRegex.exec(body)) !== null) {
      // The inner match is within the outer phase's source range.
      // Since we sliced from outer.start, adjust line accordingly.
      const innerGlobalPos = outer.start + inner.index;
      const innerLine = getLineNumber(code, innerGlobalPos);
      if (innerLine !== outer.line) {
        return innerLine;
      }
    }
  }

  return null;
}

// ---------------------------------------------------------------------------
// Agent-outside-phase detection
// ---------------------------------------------------------------------------

/**
 * Returns the line of the first `agent()` call that appears outside any
 * phase callback body, or `null` if all are inside.
 */
function findAgentOutsidePhase(code: string): number | null {
  // Collect all phase body ranges
  const phaseBodies: Array<{ start: number; end: number }> = [];
  const phaseRegex = /phase\s*\(/g;
  let m: RegExpExecArray | null;

  while ((m = phaseRegex.exec(code)) !== null) {
    const { bodyStart, bodyEnd } = findPhaseBody(code, m.index);
    if (bodyStart !== -1 && bodyEnd !== -1) {
      phaseBodies.push({ start: bodyStart, end: bodyEnd });
    }
  }

  // Find all agent() calls
  const agentRegex = /\bagent\s*\(/g;
  while ((m = agentRegex.exec(code)) !== null) {
    const pos = m.index;
    const inside = phaseBodies.some((pb) => pos >= pb.start && pos <= pb.end);
    if (!inside) {
      return getLineNumber(code, pos);
    }
  }

  return null;
}

// ---------------------------------------------------------------------------
// Phase extraction
// ---------------------------------------------------------------------------

function extractPhases(code: string): ParsedPhase[] {
  const phases: ParsedPhase[] = [];
  const phaseRegex = /phase\s*\(/g;
  let m: RegExpExecArray | null;

  while ((m = phaseRegex.exec(code)) !== null) {
    const phaseStart = m.index;
    const line = getLineNumber(code, phaseStart);

    // Parse the phase name (first string argument)
    let pos = m.index + m[0].length;
    pos = skipWhitespace(code, pos);

    const nameResult = parseStringLiteral(code, pos);
    if (!nameResult) continue; // malformed — skip

    const phaseName = nameResult.value;
    pos = nameResult.nextPos;

    // Expect comma after name
    pos = skipWhitespace(code, pos);
    if (code[pos] !== ',') continue;
    pos++;

    // Skip the callback: `() => {` or `function() {` or `() =>`
    pos = skipWhitespace(code, pos);
    if (code[pos] === '(') pos = skipParenthesized(code, pos);
    pos = skipWhitespace(code, pos);

    // Skip arrow if present
    if (code[pos] === '=' && code[pos + 1] === '>') {
      pos += 2;
      pos = skipWhitespace(code, pos);
    }

    // Skip `function` keyword
    if (code.slice(pos, pos + 8) === 'function ') {
      pos += 8;
      pos = skipWhitespace(code, pos);
    }

    // Skip second param list (for function() {} style)
    if (code[pos] === '(') pos = skipParenthesized(code, pos);
    pos = skipWhitespace(code, pos);

    // Expect opening brace of callback body
    if (code[pos] !== '{') continue;
    const bodyStart = pos + 1;

    // Find matching closing brace
    const bodyEnd = findMatchingBrace(code, pos);
    if (bodyEnd === -1) continue;

    const body = code.slice(bodyStart, bodyEnd);

    // Extract agent() calls from the body
    const agents = extractAgents(body, phaseStart);

    phases.push({ name: phaseName, agents, line });
  }

  return phases;
}

// ---------------------------------------------------------------------------
// Agent extraction
// ---------------------------------------------------------------------------

function extractAgents(body: string, offset: number): ParsedAgent[] {
  const agents: ParsedAgent[] = [];
  const agentRegex = /\bagent\s*\(/g;
  let m: RegExpExecArray | null;

  while ((m = agentRegex.exec(body)) !== null) {
    const localLine = getLineNumber(body, m.index);
    const globalLine = getLineNumber(body, m.index) > 0
      ? getLineNumber(body, m.index)
      : 1;

    let pos = m.index + m[0].length;
    pos = skipWhitespace(body, pos);

    // Parse agent name
    const nameResult = parseStringLiteral(body, pos);
    if (!nameResult) continue;
    const agentName = nameResult.value;
    pos = nameResult.nextPos;

    // Expect comma
    pos = skipWhitespace(body, pos);
    if (body[pos] !== ',') continue;
    pos++;

    // Parse agent prompt or config object ({ agentId, prompt? })
    pos = skipWhitespace(body, pos);
    let agentPrompt = '';
    let agentId: string | undefined;
    if (body[pos] === '{') {
      const objResult = parseSimpleObjectLiteral(body, pos);
      if (!objResult) continue;
      const obj = objResult.value;
      agentPrompt = obj.prompt || '';
      agentId = obj.agentId;
      pos = objResult.nextPos;
    } else {
      const promptResult = parseStringLiteral(body, pos);
      if (!promptResult) continue;
      agentPrompt = promptResult.value;
      pos = promptResult.nextPos;
    }

    // Calculate approximate global line
    const agentLine = getLineNumber(body, m.index);

    const agentEntry: ParsedAgent = { name: agentName, prompt: agentPrompt, line: agentLine };
    if (agentId) agentEntry.agentId = agentId;
    agents.push(agentEntry);
  }

  return agents;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function getLineNumber(code: string, pos: number): number {
  let line = 1;
  for (let i = 0; i < pos && i < code.length; i++) {
    if (code[i] === '\n') line++;
  }
  return line;
}

function skipWhitespace(code: string, pos: number): number {
  while (pos < code.length && /\s/.test(code[pos])) pos++;
  return pos;
}

function skipParenthesized(code: string, pos: number): number {
  if (code[pos] !== '(') return pos;
  let depth = 1;
  pos++;
  while (pos < code.length && depth > 0) {
    if (code[pos] === '(') depth++;
    else if (code[pos] === ')') depth--;
    else if (code[pos] === '"' || code[pos] === "'") {
      pos = skipStringLiteral(code, pos);
    }
    pos++;
  }
  return pos;
}

/**
 * Parse a double-quoted or single-quoted string literal starting at `pos`.
 * Returns the value and the position after the closing quote.
 */
function parseStringLiteral(
  code: string,
  pos: number,
): { value: string; nextPos: number } | null {
  if (pos >= code.length) return null;
  const quote = code[pos];
  if (quote !== '"' && quote !== "'") return null;

  pos++; // skip opening quote
  let value = '';
  while (pos < code.length) {
    const ch = code[pos];
    if (ch === '\\') {
      pos++;
      if (pos < code.length) {
        value += code[pos];
        pos++;
      }
    } else if (ch === quote) {
      return { value, nextPos: pos + 1 };
    } else {
      value += ch;
      pos++;
    }
  }

  return null; // unterminated string
}

/**
 * Parse a simple JS object literal with string-valued keys.
 * Supports: `{ agentId: "id", prompt: "text" }`
 * Returns the parsed key-value map and position after the closing `}`.
 */
function parseSimpleObjectLiteral(
  code: string,
  pos: number,
): { value: Record<string, string>; nextPos: number } | null {
  if (code[pos] !== '{') return null;
  pos++; // skip {
  const result: Record<string, string> = {};

  pos = skipWhitespace(code, pos);
  while (pos < code.length && code[pos] !== '}') {
    // Parse key
    pos = skipWhitespace(code, pos);
    const keyResult = parseStringLiteral(code, pos);
    if (!keyResult) return null;
    const key = keyResult.value;
    pos = keyResult.nextPos;

    // Expect colon
    pos = skipWhitespace(code, pos);
    if (code[pos] !== ':') return null;
    pos++;

    // Parse value (string literal)
    pos = skipWhitespace(code, pos);
    const valResult = parseStringLiteral(code, pos);
    if (!valResult) return null;
    result[key] = valResult.value;
    pos = valResult.nextPos;

    // Skip comma if present
    pos = skipWhitespace(code, pos);
    if (code[pos] === ',') {
      pos++;
      pos = skipWhitespace(code, pos);
    }
  }

  if (code[pos] !== '}') return null;
  pos++; // skip }
  return { value: result, nextPos: pos };
}

/**
 * Find the matching closing brace for an opening brace at `openPos`.
 * Returns the index of the matching `}` or -1.
 */
function findMatchingBrace(code: string, openPos: number): number {
  if (code[openPos] !== '{') return -1;
  let depth = 1;
  let pos = openPos + 1;

  while (pos < code.length && depth > 0) {
    const ch = code[pos];
    if (ch === '"' || ch === "'") {
      pos = skipStringLiteral(code, pos);
    } else if (ch === '{') {
      depth++;
    } else if (ch === '}') {
      depth--;
    }
    pos++;
  }

  return depth === 0 ? pos - 1 : -1;
}

/**
 * Find the body range of a phase() call starting at `phaseCallPos`.
 * Returns { bodyStart, bodyEnd } indexes of the callback body (between braces),
 * or -1 values if not found.
 */
function findPhaseBody(
  code: string,
  phaseCallPos: number,
): { bodyStart: number; bodyEnd: number } {
  let pos = phaseCallPos;

  // Skip past `phase(` name and param list
  // Find the opening `(` of the phase call
  const parenIdx = code.indexOf('(', phaseCallPos);
  if (parenIdx === -1) return { bodyStart: -1, bodyEnd: -1 };
  pos = parenIdx + 1;

  // Skip the first string argument (phase name)
  pos = skipWhitespace(code, pos);
  const nameResult = parseStringLiteral(code, pos);
  if (!nameResult) return { bodyStart: -1, bodyEnd: -1 };
  pos = nameResult.nextPos;

  // Expect comma
  pos = skipWhitespace(code, pos);
  if (code[pos] !== ',') return { bodyStart: -1, bodyEnd: -1 };
  pos++;

  // Skip callback params and arrow
  pos = skipWhitespace(code, pos);
  if (code[pos] === '(') pos = skipParenthesized(code, pos);
  pos = skipWhitespace(code, pos);
  if (code[pos] === '=' && code[pos + 1] === '>') {
    pos += 2;
    pos = skipWhitespace(code, pos);
  }
  if (code.slice(pos, pos + 8) === 'function ') {
    pos += 8;
    pos = skipWhitespace(code, pos);
  }
  if (code[pos] === '(') pos = skipParenthesized(code, pos);
  pos = skipWhitespace(code, pos);

  // Find opening brace of callback body
  if (code[pos] !== '{') return { bodyStart: -1, bodyEnd: -1 };
  const bodyStart = pos + 1;

  const bodyEnd = findMatchingBrace(code, pos);
  if (bodyEnd === -1) return { bodyStart: -1, bodyEnd: -1 };

  return { bodyStart, bodyEnd };
}


