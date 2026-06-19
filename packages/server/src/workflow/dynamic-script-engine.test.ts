import { describe, expect, it, vi } from 'vitest';
import {
  executeDynamicScript,
  validateDynamicScript,
  type DynamicHostCall,
} from './dynamic-script-engine.js';

describe('dynamic script engine', () => {
  it('validates dynamic workflow syntax without running the callback', async () => {
    const result = await validateDynamicScript(`
      workflow("example", async () => {
        await agent("never-run", { prompt: "test" });
      });
    `);
    expect(result).toEqual({ valid: true });
  });

  it('rejects scripts without workflow()', async () => {
    const result = await validateDynamicScript('const answer = 42;');
    expect(result.valid).toBe(false);
  });

  it('executes loops, phases, parallel agents and checkpoints', async () => {
    const calls: DynamicHostCall[] = [];
    const host = {
      call: vi.fn(async (request: DynamicHostCall) => {
        calls.push(request);
        if (request.kind === 'agent') {
          return { id: request.key, output: `done:${request.key}` };
        }
        if (request.kind === 'checkpoint') return request.input.value;
        return { ok: true };
      }),
    };

    await executeDynamicScript(
      `
        workflow("example", async () => {
          const values = await phase("research", async () =>
            parallel(["a", "b"], item =>
              agent("agent:" + item, { prompt: "Review " + item })
            )
          );
          await checkpoint("summary", values.map(value => value.output));
        });
      `,
      host,
      { timeoutMs: 10_000 },
    );

    expect(calls.map((call) => `${call.kind}:${call.key}`)).toEqual([
      'phase_start:research',
      'agent:agent:a',
      'agent:agent:b',
      'phase_complete:research',
      'checkpoint:summary',
    ]);
  });

  it('does not expose Node globals', async () => {
    await expect(
      executeDynamicScript(
        `
          workflow("sandbox", async () => {
            if (typeof process !== "undefined" || typeof require !== "undefined") {
              throw new Error("node globals exposed");
            }
          });
        `,
        { call: async () => null },
      ),
    ).resolves.toBeUndefined();
  });
});
