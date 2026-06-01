import { describe, it, expect } from 'vitest';
import { executeScript } from './isolated-runtime.js';
import type { SandboxOptions } from './types.js';

// ---------------------------------------------------------------------------
// Default options used throughout the tests
// ---------------------------------------------------------------------------

const defaultOptions: SandboxOptions = {
  timeoutMs: 30_000,
  memoryLimitMb: 64,
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function stripIndent(code: string): string {
  const lines = code.split('\n');
  // Remove leading/trailing empty lines
  while (lines.length > 0 && lines[0].trim() === '') lines.shift();
  while (lines.length > 0 && lines[lines.length - 1].trim() === '') lines.pop();
  // Determine common indent
  const indents = lines
    .filter((l) => l.trim().length > 0)
    .map((l) => l.match(/^ */)?.[0].length ?? 0);
  const minIndent = Math.min(...indents);
  return lines.map((l) => l.slice(minIndent)).join('\n');
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('executeScript (fallback parser)', () => {
  // -----------------------------------------------------------------------
  // 1. Valid script → extracts correct WorkflowDefinition
  // -----------------------------------------------------------------------
  it('extracts a valid WorkflowDefinition from a well-formed script', async () => {
    const script = stripIndent(`
      phase("Research", () => {
        agent("researcher-1", "Research quantum computing");
        agent("researcher-2", "Research cryptography");
      });

      phase("Analysis", () => {
        agent("analyzer-1", "Synthesize findings");
      });
    `);

    const result = await executeScript(script, defaultOptions);

    expect(result.success).toBe(true);
    expect(result.definition).toBeDefined();
    expect(result.definition!.name).toBe('User Script');
    expect(result.definition!.phases).toHaveLength(2);

    const [p1, p2] = result.definition!.phases;
    expect(p1.name).toBe('Research');
    expect(p1.agents).toHaveLength(2);
    expect(p1.agents[0].name).toBe('researcher-1');
    expect(p1.agents[0].prompt).toBe('Research quantum computing');
    expect(p1.agents[1].name).toBe('researcher-2');
    expect(p1.agents[1].prompt).toBe('Research cryptography');

    expect(p2.name).toBe('Analysis');
    expect(p2.agents).toHaveLength(1);
    expect(p2.agents[0].name).toBe('analyzer-1');
    expect(p2.agents[0].prompt).toBe('Synthesize findings');
  });

  // -----------------------------------------------------------------------
  // 2. Simple script with 1 phase, 1 agent
  // -----------------------------------------------------------------------
  it('handles a minimal script with 1 phase and 1 agent', async () => {
    const script = `phase("Hello", () => { agent("greeter", "Say hello"); });`;
    const result = await executeScript(script, defaultOptions);

    expect(result.success).toBe(true);
    expect(result.definition!.phases).toHaveLength(1);
    expect(result.definition!.phases[0].name).toBe('Hello');
    expect(result.definition!.phases[0].agents).toHaveLength(1);
    expect(result.definition!.phases[0].agents[0].name).toBe('greeter');
  });

  // -----------------------------------------------------------------------
  // 3. Script with 2 phases, 3 agents each
  // -----------------------------------------------------------------------
  it('handles 2 phases with 3 agents each', async () => {
    const script = stripIndent(`
      phase("Alpha", () => {
        agent("a1", "Task A1");
        agent("a2", "Task A2");
        agent("a3", "Task A3");
      });
      phase("Beta", () => {
        agent("b1", "Task B1");
        agent("b2", "Task B2");
        agent("b3", "Task B3");
      });
    `);

    const result = await executeScript(script, defaultOptions);
    expect(result.success).toBe(true);
    expect(result.definition!.phases).toHaveLength(2);
    for (const phase of result.definition!.phases) {
      expect(phase.agents).toHaveLength(3);
    }
  });

  // -----------------------------------------------------------------------
  // 4. Script with syntax error → rejected with line number
  // -----------------------------------------------------------------------
  it('rejects a script with unmatched opening brace', async () => {
    const script = stripIndent(`
      phase("Bad", () => {
        agent("x", "hello");
      // missing closing brace
    `);

    const result = await executeScript(script, defaultOptions);
    expect(result.success).toBe(false);
    expect(result.error).toBeDefined();
    expect(typeof result.line).toBe('number');
  });

  // -----------------------------------------------------------------------
  // 5. Script calling agent() outside phase() → rejected
  // -----------------------------------------------------------------------
  it('rejects agent() called outside a phase() block', async () => {
    const script = stripIndent(`
      agent("lonely", "I have no phase");
      phase("P", () => {
        agent("ok", "I am fine");
      });
    `);

    const result = await executeScript(script, defaultOptions);
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/agent.*outside.*phase/i);
    // Line number depends on isolated-vm vs. fallback path; just check it exists
    expect(result.line).toBeDefined();
  });

  // -----------------------------------------------------------------------
  // 6. Script with nested phase() calls → rejected
  // -----------------------------------------------------------------------
  it('rejects nested phase() calls', async () => {
    const script = stripIndent(`
      phase("Outer", () => {
        agent("a", "first");
        phase("Inner", () => {
          agent("b", "nested");
        });
      });
    `);

    const result = await executeScript(script, defaultOptions);
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/nested.*phase/i);
  });

  // -----------------------------------------------------------------------
  // 7. Script with empty phase name → rejected
  // -----------------------------------------------------------------------
  it('rejects a phase with an empty name', async () => {
    const script = `phase("", () => { agent("a", "work"); });`;
    const result = await executeScript(script, defaultOptions);

    expect(result.success).toBe(false);
    expect(result.error).toMatch(/phase.*name.*required/i);
  });

  // -----------------------------------------------------------------------
  // 8. Script with empty agent prompt → rejected
  // -----------------------------------------------------------------------
  it('rejects an agent with an empty prompt', async () => {
    const script = `phase("P", () => { agent("a", ""); });`;
    const result = await executeScript(script, defaultOptions);

    expect(result.success).toBe(false);
    expect(result.error).toMatch(/agent.*prompt.*required/i);
  });

  // -----------------------------------------------------------------------
  // 9. Script producing >1000 agents → rejected
  // -----------------------------------------------------------------------
  it('rejects a script with more than 1000 agents total', async () => {
    // Build a script with 40 phases × 26 agents = 1040 agents
    // (≤50 phases so phase-limit check doesn't mask the agent-limit check)
    const lines: string[] = [];
    for (let p = 0; p < 40; p++) {
      const agents: string[] = [];
      for (let a = 0; a < 26; a++) {
        agents.push(`agent("a${p}-${a}", "task ${a}");`);
      }
      lines.push(`phase("Phase ${p}", () => {\n${agents.join('\n')}\n});`);
    }
    const script = lines.join('\n');

    const result = await executeScript(script, defaultOptions);
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/maximum is 1000|too many/i);
  });

  // -----------------------------------------------------------------------
  // 10. Script producing >50 phases → rejected
  // -----------------------------------------------------------------------
  it('rejects a script with more than 50 phases', async () => {
    const lines: string[] = [];
    for (let p = 0; p < 51; p++) {
      lines.push(
        `phase("Phase ${p}", () => { agent("a${p}", "work"); });`,
      );
    }
    const script = lines.join('\n');

    const result = await executeScript(script, defaultOptions);
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/maximum is 50|too many/i);
  });

  // -----------------------------------------------------------------------
  // 11. Timeout prevents endless loops  (>30s = reject)
  // -----------------------------------------------------------------------
  it('rejects a script that takes longer than the timeout', async () => {
    // Use a real infinite while-loop — isolated-vm will enforce the timeout.
    // The fallback parser also receives the timeout through Promise.race.
    const script = stripIndent(`
      phase("Loop", () => {
        agent("a", "hello");
      });
      while (true) {}
    `);

    // Very short timeout — must finish before 5s
    const result = await executeScript(script, { timeoutMs: 50, memoryLimitMb: 64 });
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/timeout|timed out/i);
  });

  // -----------------------------------------------------------------------
  // 12. Script cannot access require/process (sandbox isolation)
  //
  // With isolated-vm: require/process are undefined inside the V8 isolate,
  // so the script throws a ReferenceError — sandbox works.
  // With the fallback parser: there is no code execution, so these
  // references are safely ignored and the valid phase is extracted.
  // Either behaviour is acceptable for MVP.
  // -----------------------------------------------------------------------
  it('rejects or safely ignores require() and process references', async () => {
    const script = stripIndent(`
      phase("Safe", () => {
        agent("a", "do work");
      });
      // malicious attempts
      const fs = require('fs');
      process.exit(0);
    `);

    const result = await executeScript(script, defaultOptions);

    // Two acceptable outcomes:
    // 1. Sandbox blocked it → success: false with a ReferenceError
    // 2. Parser ignored it  → success: true (fallback parser)
    if (result.success) {
      // Fallback parser path: malicious code ignored
      expect(result.definition!.phases).toHaveLength(1);
      expect(result.definition!.phases[0].name).toBe('Safe');
    } else {
      // isolated-vm path: require/process are not defined in the isolate
      expect(result.error).toMatch(/require|process|is not defined|is not a/i);
    }
  });

  // -----------------------------------------------------------------------
  // 13. Extra: single-quoted strings work
  // -----------------------------------------------------------------------
  it('supports single-quoted strings', async () => {
    const script = `phase('P1', () => { agent('a1', 'hello world'); });`;
    const result = await executeScript(script, defaultOptions);

    expect(result.success).toBe(true);
    expect(result.definition!.phases[0].agents[0].prompt).toBe('hello world');
  });

  // -----------------------------------------------------------------------
  // 14. Extra: Arrow function with body on multiple lines
  // -----------------------------------------------------------------------
  it('handles multiline arrow functions', async () => {
    const script = stripIndent(`
      phase("Multi",
        () => {
          agent("x", "line 1");
          agent("y", "line 2");
        }
      );
    `);
    const result = await executeScript(script, defaultOptions);
    expect(result.success).toBe(true);
    expect(result.definition!.phases[0].agents).toHaveLength(2);
  });

  // -----------------------------------------------------------------------
  // 15. Extra: Empty script (no phases) → rejected
  // -----------------------------------------------------------------------
  it('rejects a script with no phases', async () => {
    const script = `// just a comment\nconst x = 1;\n`;
    const result = await executeScript(script, defaultOptions);
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/phase/i);
    // The validator from @dynflow/shared should reject it
  });
});
