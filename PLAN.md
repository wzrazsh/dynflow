# Dynamic Workflow Engine — Implementation Plan

> **Goal:** Build a pure TypeScript SDK for orchestrating multi-agent LLM workflows, inspired by Claude Code's Dynamic Workflows feature.
>
> **LLM Provider:** `opencode.ai/zen/go/v1` (OpenAI-compatible API)
>
> **Scale:** Personal tool, fast iteration
>
> **From scratch:** No existing codebase

---

## 1. Architecture Overview

```
┌──────────────────────────────────────────┐
│           src/index.ts (Public API)       │
├──────────────────────────────────────────┤
│  builder/     dsl/fluent layer           │
├──────────────────────────────────────────┤
│  runtime/     orchestration + cache +     │
│               session/resume             │
├──────────────────────────────────────────┤
│  agent/       single agent executor      │
├──────────────────────────────────────────┤
│  llm/         LLM provider abstraction   │
├──────────────────────────────────────────┤
│  events/      event emission             │
│  token/       usage aggregation          │
├──────────────────────────────────────────┤
│  types/       all TS interfaces & types   │
│  errors.ts    error hierarchy            │
└──────────────────────────────────────────┘
```

**Dependency direction:** One-way only (types → llm → agent → runtime → builder → public index).

**Zero runtime dependencies** — Node 18+ built-in `fetch`, `fs/promises`, `crypto.randomUUID()`.

---

## 2. Directory Structure

```
dynamic-workflow-engine/
├── package.json
├── tsconfig.json
├── tsconfig.build.json
├── tsup.config.ts
├── vitest.config.ts
├── .gitignore
├── .eslintrc.cjs
├── src/
│   ├── index.ts
│   ├── types/
│   │   ├── workflow.ts
│   │   ├── agent.ts
│   │   ├── llm.ts
│   │   ├── events.ts
│   │   └── index.ts
│   ├── errors.ts
│   ├── llm/
│   │   ├── LLMClient.ts
│   │   ├── OpenAICompatibleClient.ts
│   │   └── index.ts
│   ├── agent/
│   │   ├── AgentExecutor.ts
│   │   └── index.ts
│   ├── runtime/
│   │   ├── WorkflowRuntime.ts
│   │   ├── PhaseExecutor.ts
│   │   ├── ConcurrencyLimiter.ts
│   │   ├── Cache.ts
│   │   ├── SessionManager.ts
│   │   └── index.ts
│   ├── builder/
│   │   ├── WorkflowBuilder.ts
│   │   └── index.ts
│   ├── events/
│   │   ├── EventEmitter.ts
│   │   └── index.ts
│   └── token/
│       ├── TokenTracker.ts
│       └── index.ts
├── tests/
│   ├── helpers/mock-llm.ts
│   ├── unit/
│   └── integration/
└── examples/
    ├── basic.ts
    ├── recursive-research.ts
    └── branching.ts
```

---

## 3. Phased Implementation Plan

### Wave 0: Project Scaffolding

**Files:** `package.json`, `tsconfig.json`, `tsconfig.build.json`, `tsup.config.ts`, `vitest.config.ts`, `.gitignore`, `.eslintrc.cjs`, `src/index.ts` (stub)

**Verification:** `npm run build` produces `dist/`, `npm test` passes, `npm run typecheck` passes.

---

### Wave 1: Core Types & Interfaces

**Files:** `src/types/llm.ts`, `src/types/agent.ts`, `src/types/workflow.ts`, `src/types/events.ts`, `src/errors.ts`

**Key types:** `LLMProvider`, `WorkflowDefinition`, `PhaseDefinition`, `TaskDefinition`, `AgentResult`, `TokenUsage`, `WorkflowEvent`, `WorkflowContext`

**Design decisions:**
- `TaskResolver = (ctx: WorkflowContext) => string | Promise<string>` — dynamic task interpolation
- `get(phaseName, agentId)` — typed result access between phases
- `ctx.variables` — user-defined state across phases

---

### Wave 2: LLM Client Abstraction

**Files:** `src/llm/LLMClient.ts`, `src/llm/OpenAICompatibleClient.ts`

**Features:** OpenAI-compatible HTTP calls, retry with exponential backoff, timeout via AbortSignal, token counting from `response.usage`.

**Design:** Abstract `LLMClient` base class, concrete `OpenAICompatibleClient` for `opencode.ai/zen/go/v1`.

---

### Wave 3: Agent Executor

**Files:** `src/agent/AgentExecutor.ts`

**Features:** Resolve static/dynamic task strings, call LLM, measure duration, return `AgentResult`.

**Stateless** — all state management is the runtime's job.

---

### Wave 4: Workflow Runtime

**Files:** `src/runtime/ConcurrencyLimiter.ts`, `src/runtime/Cache.ts`, `src/runtime/PhaseExecutor.ts`, `src/runtime/WorkflowRuntime.ts`

**Key design:**
- Phases execute **sequentially**
- Agents within a phase execute **in parallel** (concurrency-limited)
- `Promise.allSettled` — one agent failure doesn't kill the phase
- Cache check before queuing — skip cached results immediately
- Errors captured as `AgentResult { status: 'error' }` not thrown

---

### Wave 5: Workflow DSL / Builder API

**Files:** `src/builder/WorkflowBuilder.ts`, `src/workflow.ts` (top-level `Workflow` class)

**Two creation modes:**
1. **Config object:** `Workflow.from({ name, phases, llm })` — simple, 80% of use cases
2. **Builder:** `Workflow.define('x').phase('research').task(...)` — fluent, complex workflows

---

### Wave 6: Progress Events & Token Tracking

**Files:** `src/events/EventEmitter.ts`, `src/token/TokenTracker.ts`

**Events:** `workflow:start/complete/error`, `phase:start/complete`, `agent:start/complete`

**EventEmitter features:** Fire-and-forget for async handlers, history buffer, `waitFor()` utility.

**TokenTracker:** Per-agent, per-phase, and total aggregation.

---

### Wave 7: Resume Capability

**Files:** `src/runtime/SessionManager.ts`

**How it works:** Save state after each phase completes. On resume, skip completed phases, re-run interrupted phase.

**Granularity:** Phase-level (not agent-level). If a phase was partially complete, all agents in that phase re-run.

---

### Wave 8: Integration Tests & Examples

**Test helpers:** `tests/helpers/mock-llm.ts`

**Integration tests:** Multi-phase context flow, resume after failure, caching verification.

**Examples:** `basic.ts` (research + synthesize), `recursive-research.ts`, `branching.ts`

---

## 4. Wave Dependency Summary

```
Wave 0 (scaffolding)
  └── Wave 1 (types)
       ├── Wave 2 (LLM client)
       │    └── Wave 3 (agent executor)
       │         └── Wave 4 (runtime) ──┐
       ├── Wave 6 (events + token) ─────┘
       │         └── Wave 7 (resume)
       └── Wave 5 (builder)
            └── Wave 8 (integration)
```

**Parallel-friendly:** Waves 2, 5, 6 can start in parallel once Wave 1 types are done.

---

## 5. Future Considerations (Out of Scope)

| Feature | Why deferred |
|---|---|
| Agent-level resume | Phase-level sufficient for MVP |
| Content-based cache dedup | `phaseName:agentId` covers session resume |
| Streaming responses | Adds complexity to AgentResult |
| Parallel phase execution (DAG) | Significant complexity increase |
| Anthropic/Google adapters | Abstract LLMClient makes this easy later |
| Plugin system | Not needed yet |

---

*Estimated effort: ~4–6 focused days for a solo TypeScript developer.*
