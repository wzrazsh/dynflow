# dynamic-workflow-engine

TypeScript SDK for orchestrating multi-agent LLM workflows with parallel execution, caching, and resume capability.

## Features

- **Phase-based execution** — phases run sequentially, agents within a phase run in parallel
- **Concurrency control** — configurable max parallel agents (default: 16)
- **Dynamic tasks** — `TaskResolver` functions access previous phase results via context
- **Result caching** — skip re-execution of completed agents; keyed by `phaseName:agentId`, only successful results cached, disk persistence via `cacheDir`
- **Session resume** — persist and restore workflow state across runs; requires `sessionId` + `cacheDir`, phase-level granularity
- **Event system** — 7 typed events for monitoring workflow progress
- **Token tracking** — per-agent, per-phase, and total usage aggregation
- **Zero dependencies** — uses only Node.js 18+ built-ins (`fetch`, `fs/promises`, `crypto`)
- **Dual format** — ESM + CJS output with full TypeScript declarations

## Installation

```bash
npm install dynamic-workflow-engine
```

## Quick Start

### Config Object API

```typescript
import { Workflow, OpenAICompatibleClient } from 'dynamic-workflow-engine';

const client = new OpenAICompatibleClient({
  baseUrl: 'https://opencode.ai/zen/v1',
  apiKey: process.env.OPENCODE_API_KEY!,
  defaultModel: 'mimo-v2.5-free',
});

const workflow = Workflow.from({
  name: 'research-summary',
  llm: client,
  defaultModel: 'mimo-v2.5-free',
  phases: [
    {
      name: 'research',
      tasks: [
        { id: 'web', systemPrompt: 'Researcher', task: 'Search for info' },
        { id: 'docs', systemPrompt: 'Doc reader', task: 'Read docs' },
      ],
    },
    {
      name: 'write',
      concurrency: 1,
      tasks: [
        {
          id: 'summary',
          systemPrompt: 'Writer',
          task: (ctx) => `Summarize: ${ctx.get('research', 'web')?.content}`,
        },
      ],
    },
  ],
});

const result = await workflow.run();
console.log(result.summary.totalTokenUsage);
```

### Builder API

```typescript
import { Workflow, OpenAICompatibleClient } from 'dynamic-workflow-engine';

const client = new OpenAICompatibleClient({
  baseUrl: 'https://opencode.ai/zen/v1',
  apiKey: process.env.OPENCODE_API_KEY!,
  defaultModel: 'mimo-v2.5-free',
});

const definition = Workflow.define('research')
  .concurrency(4)
  .phase('search', { concurrency: 2 })
    .task('web', { systemPrompt: 'Researcher', task: 'Search web' })
    .task('docs', { systemPrompt: 'Reader', task: 'Read docs' })
  .phase('write', { concurrency: 1 })
    .task('report', {
      systemPrompt: 'Writer',
      task: (ctx) => `Write about: ${ctx.get('search', 'web')?.content}`,
    })
  .build();

const { WorkflowRuntime } = await import('dynamic-workflow-engine');
const runtime = new WorkflowRuntime({ llm: client, defaultModel: 'mimo-v2.5-free' });
const result = await runtime.run(definition);
```

> **Note**: Set `OPENCODE_API_KEY` (or your LLM provider's key) as an environment variable before running. You can also pass `apiKey` directly to `OpenAICompatibleClient`.

## API Reference

### `Workflow.from(config)`

Create a workflow from a configuration object.

```typescript
interface WorkflowConfig {
  name: string;
  phases: PhaseDefinition[];
  llm: LLMProvider;
  defaultModel?: string;      // default: 'gpt-4o' (override in workflow config)
  maxConcurrency?: number;    // default: 16
  sessionId?: string;         // for resume
  cacheDir?: string;          // for disk persistence
  onEvent?: EventHandler;     // event listener
}
```

### `Workflow.define(name)`

Start building a workflow with the fluent API. Returns a `WorkflowBuilder`.

```typescript
Workflow.define('name')
  .concurrency(4)
  .session('session-id')
  .phase('phase-1')
    .task('task-1', { systemPrompt: '...', task: '...' })
    .task('task-2', { systemPrompt: '...', task: '...' })
  .phase('phase-2')
    .task('task-3', { systemPrompt: '...', task: (ctx) => '...' })
  .build(); // returns WorkflowDefinition
```

### `WorkflowContext`

Available in `TaskResolver` functions:

```typescript
interface WorkflowContext {
  workflowName: string;
  sessionId: string;
  variables: Record<string, unknown>;  // mutable state, shared across all phases
  get(phaseName: string, agentId: string): AgentResult | undefined;
}
```

- **`variables`** — shared mutable bag across ALL phases within one run. Phase 1 writes, phase 2 reads. Reset each time `run()` is called (not persisted across runs).
- **`get(phaseName, agentId)`** — access the result of any prior agent. Returns `AgentResult | undefined` (undefined if the phase or agent hasn't run yet, or if the agent errored).

### Custom LLM Provider

Implement the `LLMProvider` interface:

```typescript
import type { LLMProvider, LLMCompletionRequest, LLMCompletionResponse } from 'dynamic-workflow-engine';

const myProvider: LLMProvider = {
  async complete(request: LLMCompletionRequest): Promise<LLMCompletionResponse> {
    // Your implementation
    return {
      content: '...',
      tokenUsage: { promptTokens: 100, completionTokens: 50, totalTokens: 150 },
      model: 'my-model',
      durationMs: 1000,
    };
  },
};
```

Or extend `LLMClient` for free retry/timeout:

```typescript
import { LLMClient } from 'dynamic-workflow-engine';

class MyClient extends LLMClient {
  async complete(request: LLMCompletionRequest): Promise<LLMCompletionResponse> {
    return this.withRetry(async (signal) => {
      // Your implementation with automatic retry on 429/5xx
    });
  }
}
```

### Events

```typescript
import type { WorkflowEvent } from 'dynamic-workflow-engine';

workflow.onEvent((event: WorkflowEvent) => {
  switch (event.type) {
    case 'workflow:start':
      console.log(`Started ${event.workflowId}`);
      break;
    case 'agent:complete':
      console.log(`${event.agentId}: ${event.result.status}`);
      break;
    case 'workflow:complete':
      console.log(`Completed in ${event.summary.totalDurationMs}ms`);
      break;
  }
});
```

### Token Usage

```typescript
const result = await workflow.run();

// Includes ALL agents (including cached and resumed sessions)
console.log(result.summary.totalTokenUsage);
// → { promptTokens: 500, completionTokens: 300, totalTokens: 800 }

// Counts only freshly executed agents (cache hits in current run excluded)
console.log(runtime.getTokenUsage());
// → { promptTokens: 400, completionTokens: 250, totalTokens: 650 }
```

The `summary.totalTokenUsage` aggregates all agent results in the workflow output, including cached results and resumed session data. The `runtime.getTokenUsage()` method returns usage from only agents that actually executed in the current run.

## Configuration

### `OpenAICompatibleClient`

```typescript
new OpenAICompatibleClient({
  baseUrl: 'https://opencode.ai/zen/v1',  // any OpenAI-compatible API
  apiKey: 'oc-...',
  defaultModel: 'mimo-v2.5-free',
  maxRetries: 3,           // retry on 429/5xx
  retryDelayMs: 1000,      // base delay (exponential backoff)
  timeout: 120000,         // 120s timeout
  defaultTemperature: 0.7,
  defaultMaxTokens: 4096,
});
```

### Phase Concurrency

```typescript
{
  name: 'parallel-phase',
  concurrency: 4,  // max 4 agents at a time
  tasks: [/* ... */],
}
```

### Session Resume

Resume requires both `sessionId` and `cacheDir`. Completed phases are skipped entirely (no agent execution). The interrupted phase re-executes all its tasks. State is persisted via `SessionManager` after each phase.

```typescript
// First run
const result1 = await Workflow.from({
  name: 'my-workflow',
  sessionId: 'session-123',
  cacheDir: './.wf-sessions',  // required for persistence
  // ...
}).run();

// Resume after interruption
const result2 = await Workflow.from({
  name: 'my-workflow',
  sessionId: 'session-123',  // same session ID
  cacheDir: './.wf-sessions',  // same cache directory
  // ...
}).run();
// Completed phases are skipped; interrupted phase re-runs all tasks
```

## Architecture

```
Workflow.from(config)
  ↓
WorkflowRuntime
  ↓
PhaseExecutor (per phase)
  ↓
AgentExecutor (per task, parallel)
  ↓
LLMProvider.complete()
```

- **Phases execute sequentially** — phase 1 finishes before phase 2 starts
- **Agents execute in parallel** — bounded by `ConcurrencyLimiter` (FIFO semaphore)
- **Errors don't propagate** — captured as `AgentResult { status: 'error', error: string }`; agents never throw exceptions
- **Cache keyed by `phaseName:agentId`** — only successful results cached; disk persistence via `cacheDir`
- **Cached results** — emit `agent:complete` with `cached: true`; included in `summary.totalTokenUsage` but not in `runtime.getTokenUsage()`
- **Session resume** — completed phases skipped entirely; interrupted phase re-executes all tasks; state saved after each phase via `SessionManager`
- **Shared variables** — `ctx.variables` is the same mutable object across all phases within one run, reset per `run()` call

## Documentation

项目文档采用 Vibe Coding 文档体系，作为 AI 协作时的上下文控制系统。

### 文档结构

```
doc/
├── vision.md                 # 产品愿景、目标、明确"不做什么"
├── design-doc.md             # 当前系统设计（核心）
├── tasks.md                  # 当前任务拆解（带验收标准）
├── decisions.md              # 架构决策记录（ADR）
├── ai-collaboration.md       # AI 编码协作规则（包含测试指令）
└── testing/                  # 测试验证体系
    └── strategy.md           # 测试分层、策略、原则
```

### 核心文档

- **[vision.md](doc/vision.md)** - 项目本质与边界，回答"我们到底在做什么，绝对不做什么"
- **[design-doc.md](doc/design-doc.md)** - 当前系统架构、模块划分、关键交互
- **[tasks.md](doc/tasks.md)** - 下一步具体任务，带优先级与验收标准
- **[decisions.md](doc/decisions.md)** - 重要架构决策及理由，防止反复推翻
- **[ai-collaboration.md](doc/ai-collaboration.md)** - AI 开发规则、禁区、代码风格、测试命令与规则

### 测试文档

- **[testing/strategy.md](doc/testing/strategy.md)** - 测试分层、覆盖率预期、测试与 AI 的协作方式

### 文档原则

- **简短**：只写当前必要的内容
- **有效**：过时信息立即更新或删除
- **可更新**：结构灵活，支持渐进式细化
- **可被 AI 直接读取**：纯文本/Markdown，路径清晰
- **可被工具解析**：测试命令、验收标准等应结构化，便于集成到脚本中

## Development

```bash
npm run build       # build dist/
npm test            # run tests
npm run typecheck   # type check
npm run lint        # lint src/
```

## License

MIT
