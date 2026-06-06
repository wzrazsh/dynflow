import { describe, it, expect } from 'vitest';
import { parsePiJsonLines } from './pi-output-parser.js';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const fixture = (name: string): string => {
  const here = fileURLToPath(new URL('.', import.meta.url));
  return readFileSync(join(here, '__fixtures__', name), 'utf-8');
};

describe('parsePiJsonLines', () => {
  it('extracts last assistant text from a successful run', () => {
    const result = parsePiJsonLines(fixture('pi-success.jsonl'));
    expect(result.success).toBe(true);
    expect(result.lastText).toBe('I created hello.txt with the requested content.');
    expect(result.toolCalls).toBe(1);
  });

  it('marks as failed when stopReason is error', () => {
    const result = parsePiJsonLines(fixture('pi-error.jsonl'));
    expect(result.success).toBe(false);
    expect(result.error).toContain('rate limit');
  });

  it('marks as failed when no agent_end event', () => {
    const result = parsePiJsonLines(fixture('pi-empty.jsonl'));
    expect(result.success).toBe(false);
    expect(result.error).toContain('agent_end');
  });

  it('skips non-JSON lines gracefully', () => {
    const raw =
      'not json\n' +
      '# some warning\n' +
      '{"type":"session","version":3,"id":"abc"}\n' +
      'another non-json line\n' +
      '{"type":"agent_end","messages":[{"role":"assistant","content":[{"type":"text","text":"ok"}],"stopReason":"stop"}]}\n';
    const result = parsePiJsonLines(raw);
    expect(result.success).toBe(true);
    expect(result.lastText).toBe('ok');
  });
});
