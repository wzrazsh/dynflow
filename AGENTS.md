# AGENTS.md

## Quick Reference

```bash
npm run build       # tsup → dist/ (ESM + CJS + .d.ts)
npm test            # vitest run (30s timeout, globals enabled)
npm run typecheck   # tsc --noEmit
npm run lint        # eslint src/
```

**Build order:** `typecheck → build → test` (tests import from src, not dist)

## Architecture

**Zero runtime dependencies.** Uses only Node 18+ built-ins (`fetch`, `fs/promises`, `crypto.randomUUID()`).

```
User API: Workflow.from(config) | Workflow.define(name).phase().task().build()
    ↓
Runtime:  WorkflowRuntime → PhaseExecutor → ConcurrencyLimiter (FIFO semaphore)
    ↓
Agent:    AgentExecutor → LLMProvider.complete()
```

**Dependency direction (one-way only):**
```
types/ → llm/ → agent/ → runtime/ → builder/ → index.ts
                    ↑           ↑
              events/ ┘   token/ ┘
```

## Key Patterns

### Execution Model
- **Phases execute sequentially** (phase 1 finishes before phase 2 starts)
- **Agents within a phase execute in parallel**, bounded by `ConcurrencyLimiter` (default max 16)
- **`Promise.allSettled`** — one agent failure doesn't kill the phase; errors captured as `AgentResult.status = 'error'`
- **Phase-level resume only** — if interrupted mid-phase, all agents in that phase re-run

### LLM Provider Plugin
```typescript
// Implement this 1-method interface:
interface LLMProvider {
  complete(request: LLMCompletionRequest): Promise<LLMCompletionResponse>;
}

// Or extend LLMClient for free retry/timeout:
abstract class LLMClient implements LLMProvider {
  protected async withRetry<T>(fn: (signal: AbortSignal) => Promise<T>): Promise<T>;
}
```

- `OpenAICompatibleClient` handles any OpenAI-format API (including `opencode.ai/zen/go/v1`)
- Retry: exponential backoff + jitter, only on 429/5xx, max 3 retries
- Timeout: 120s default via `AbortController`

### TaskResolver (Dynamic Tasks)
```typescript
task: (ctx: WorkflowContext) => {
  const prev = ctx.get('phase-1', 'agent-1');
  return `Analyze: ${prev?.content}`;
}
```
- `ctx.get(phaseName, agentId)` — typed access to any prior agent result
- `ctx.variables` — mutable bag for cross-phase state

### Events
7 typed events: `workflow:start|complete|error`, `phase:start|complete`, `agent:start|complete`

```typescript
runtime.onEvent((event) => {
  if (event.type === 'agent:complete') {
    console.log(`${event.agentId}: ${event.result.status} (${event.result.tokenUsage.totalTokens} tokens)`);
  }
});
```

**Fire-and-forget:** async handlers don't block the runtime. History buffer available via `getHistory()`.

### Caching
- Key: `phaseName:agentId` (not content-based)
- In-memory by default, optional disk persistence via `storageDir` option
- Cached agents emit `agent:complete` with `cached: true`

## Test Conventions

- **Globals:** `describe`, `it`, `expect`, `vi` available without import (vitest config)
- **Mock LLM:** `createMockLLM(responseMap?)` in `tests/helpers/mock-llm.ts`
  - Returns `Echo: {user-message}` for any request
  - Optionally maps system prompts to fixed responses
- **Failing mock:** `createFailingMockLLM(failPrompts[], errorMessage?)`
- **Integration tests** require no external services — all mocked

## Source Conventions

- **ESM only in src/** — all imports use `.js` extension: `import { foo } from './bar.js'`
- **Barrel exports** — each directory has `index.ts` re-exporting public items
- **Abstract classes** for extension points (`LLMClient`)
- **No `any`** — ESLint warns on `@typescript-eslint/no-explicit-any`
- **`_` prefix** for unused parameters (ESLint rule: `argsIgnorePattern: '^_'`)

## File Structure

| Directory | Purpose | Key Files |
|---|---|---|
| `src/types/` | All TypeScript interfaces | `workflow.ts`, `llm.ts`, `agent.ts`, `events.ts` |
| `src/llm/` | LLM abstraction | `LLMClient.ts` (abstract), `OpenAICompatibleClient.ts` |
| `src/agent/` | Single agent execution | `AgentExecutor.ts` (stateless) |
| `src/runtime/` | Orchestration core | `WorkflowRuntime.ts`, `PhaseExecutor.ts`, `ConcurrencyLimiter.ts`, `Cache.ts`, `SessionManager.ts` |
| `src/builder/` | Fluent DSL | `WorkflowBuilder.ts` (chain: `phase()→task()→phase()→build()`) |
| `src/events/` | Event system | `EventEmitter.ts` (history buffer, `waitFor()`) |
| `src/token/` | Token tracking | `TokenTracker.ts` (3-level aggregation) |

## Common Pitfalls

1. **`.js` extensions required** in all `src/` imports (Node16 module resolution)
2. **`PhaseBuilder.task()` returns `this`** for chaining, but `.build()` on any PhaseBuilder delegates to parent WorkflowBuilder
3. **`WorkflowRuntime` doesn't persist automatically** — use `SessionManager` explicitly for resume
4. **Agent errors don't throw** — check `AgentResult.status === 'error'` and `result.error`
5. **ConcurrencyLimiter is FIFO** — tasks queue fairly, no starvation
