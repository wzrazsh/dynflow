# Dynamic Workflow Engine - 系统设计文档

## 概述

Dynamic Workflow Engine 是一个轻量级 TypeScript SDK，用于编排多代理 LLM 工作流。核心设计理念是提供简单、可靠的 API，让开发者能够定义、执行和监控复杂的 AI 工作流。

## 架构概览

### 核心组件

```
┌─────────────────────────────────────────────────────────────┐
│                      用户 API 层                            │
├─────────────────────────────────────────────────────────────┤
│  Workflow.from(config)  │  Workflow.define(name).build()    │
└─────────────────────────────────────────────────────────────┘
                              ↓
┌─────────────────────────────────────────────────────────────┐
│                      运行时层                               │
├─────────────────────────────────────────────────────────────┤
│  WorkflowRuntime → PhaseExecutor → ConcurrencyLimiter       │
└─────────────────────────────────────────────────────────────┘
                              ↓
┌─────────────────────────────────────────────────────────────┐
│                      执行层                                 │
├─────────────────────────────────────────────────────────────┤
│  AgentExecutor → LLMProvider.complete()                     │
└─────────────────────────────────────────────────────────────┘
```

### 依赖方向（单向）

```
types/ → llm/ → agent/ → runtime/ → builder/ → index.ts
                    ↑           ↑
              events/ ┘   token/ ┘
```

## 核心概念

### 1. 工作流 (Workflow)

工作流是顶层抽象，包含多个阶段，按顺序执行。

```typescript
interface WorkflowDefinition {
  name: string;                    // 工作流名称，用于标识和缓存
  phases: PhaseDefinition[];       // 阶段列表，顺序执行
  defaultConcurrency?: number;     // 全局并发限制
  sessionId?: string;              // 会话ID，用于恢复
}
```

### 2. 阶段 (Phase)

阶段包含多个任务，在阶段内并行执行，阶段间顺序执行。

```typescript
interface PhaseDefinition {
  name: string;                    // 阶段名称，用于缓存键
  tasks: TaskDefinition[];         // 任务列表
  concurrency?: number;            // 阶段内并发限制
}
```

### 3. 任务 (Task)

任务是单个 LLM 调用单元，由代理执行。

```typescript
interface TaskDefinition {
  id: string;                      // 任务ID，用于缓存键
  systemPrompt: string;            // 系统提示词
  task: string | TaskResolver;     // 任务内容或动态解析函数
  model?: string;                  // 使用的模型
  temperature?: number;            // 温度参数
  maxTokens?: number;              // 最大token数
  skillName?: string;              // gstack 技能名，运行时自动加载并注入 systemPrompt
  fallbackPrompt?: string;         // 技能未找到时的备用提示词
}
```

### 4. 任务解析器 (TaskResolver)

动态任务解析器，允许根据前序任务结果构建任务内容。

```typescript
type TaskResolver = (ctx: WorkflowContext) => string | Promise<string>;
```

`ctx.variables` 是一个可变键值对，在同一 `run()` 调用内的所有阶段间共享。阶段1写入的值可在阶段2读取。每次 `run()` 调用创建一个新的空对象，不会跨运行持久化。

`ctx.get(phaseName, agentId)` 可访问任意前置代理的执行结果。返回 `AgentResult | undefined`。

## 执行模型

### 阶段执行

- 阶段按顺序执行：阶段1完成后开始阶段2
- 每个阶段独立执行，失败不传播到后续阶段

### 任务执行

- 阶段内任务并行执行
- 受 `ConcurrencyLimiter` 限制（默认最大16个并发）
- 使用 `Promise.allSettled` 确保单个任务失败不影响其他任务

### 错误处理

- 代理错误不抛出异常，返回 `AgentResult { status: 'error', error: string }`
- 错误信息存储在 `AgentResult.error` 字段中
- 其他任务继续执行，不中断工作流
- 使用 `Promise.allSettled` 确保单个任务失败不影响其他任务
- 错误计数同时覆盖 try/catch 块和 `Promise.allSettled` rejected 分支

## 缓存机制

### 缓存策略

- 缓存键格式：`phaseName:agentId`（不基于内容）
- 内存缓存（默认）
- 可选磁盘持久化（通过 `cacheDir` 配置）
- 仅缓存成功执行的结果（`result.status === 'success'`）
- 缓存命中时，跳过执行，直接返回缓存结果
- 缓存命中时，`agent:complete` 事件包含 `cached: true`
- `cache.load()` 在运行时启动时从磁盘加载，`cache.save()` 在所有阶段完成后持久化

### 会话恢复

- 需要同时提供 `sessionId` 和 `cacheDir`
- 使用 `SessionManager` 管理状态持久化
- 已完成的阶段完全跳过（不执行任何代理）
- 中断阶段重新执行所有任务
- 执行状态在每阶段完成后保存

## 事件系统

### 事件类型

7种类型事件：

1. `workflow:start` - 工作流开始
2. `workflow:complete` - 工作流完成
3. `workflow:error` - 工作流错误
4. `phase:start` - 阶段开始
5. `phase:complete` - 阶段完成
6. `agent:start` - 代理开始执行
7. `agent:complete` - 代理执行完成

### 事件处理

- 异步处理，不阻塞执行
- 历史缓冲区，可通过 `getHistory()` 访问
- 支持 `waitFor()` 等待特定事件

## LLM 集成

### LLMProvider 接口

```typescript
interface LLMProvider {
  complete(request: LLMCompletionRequest): Promise<LLMCompletionResponse>;
}
```

### OpenAICompatibleClient

- 支持任何 OpenAI 格式 API
- 内置重试机制（指数退避 + 抖动）
- 只在 429/5xx 状态码重试
- 默认超时：120秒
- 默认重试次数：3次

### 自定义 LLM 提供商

可通过实现 `LLMProvider` 接口或继承 `LLMClient` 抽象类来集成其他 LLM 服务。

## API 设计

### Config API

```typescript
const workflow = Workflow.from({
  name: 'research',
  llm: client,
  phases: [...]
});
await workflow.run();
```

### Builder API

```typescript
const definition = Workflow.define('research')
  .phase('search')
    .task('web', { systemPrompt: '...', task: '...' })
  .build();

const runtime = new WorkflowRuntime({ llm: client });
await runtime.run(definition);
```

### 设计决策

1. **两种 API 风格**：Config API 简单直接，Builder API 灵活可链式调用
2. **显式执行**：需要显式调用 `run()`，避免意外执行
3. **不可变定义**：工作流定义创建后不可修改，确保一致性

## 数据流

### 执行流程

```
用户创建工作流定义
       ↓
WorkflowRuntime 接收定义
       ↓
cache.load() — 从磁盘加载持久化缓存
       ↓
创建 sessionVariables（单个对象，在所有阶段间共享）
       ↓
遍历阶段列表（顺序）
       ↓
对于每个阶段：
  （如果已完成的阶段则跳过，不执行任何代理）
  创建 PhaseExecutor
  收集阶段内所有任务
  使用 ConcurrencyLimiter 控制并发
  对于每个任务：
    先检查缓存（phaseName:agentId）
    缓存命中 → 返回缓存结果（标记 cached: true）
    缓存未命中 → 创建 AgentExecutor → 调用 LLMProvider.complete()
    仅成功结果写入缓存
  等待所有任务完成（Promise.allSettled）
  SessionManager 保存阶段状态（如配置了 cacheDir）
       ↓
cache.save() — 持久化最终缓存
       ↓
返回 WorkflowResult（含 summary、results、sessionId）
```

### 结果结构

```typescript
interface WorkflowResult {
  summary: {
    totalDurationMs: number;
    totalTokenUsage: TokenUsage;
  };
  phases: PhaseResult[];
}

interface PhaseResult {
  phaseName: string;
  durationMs: number;
  agents: AgentResult[];
}
```

## 扩展点

### 1. LLM 提供商

实现 `LLMProvider` 接口即可集成任何 LLM 服务。

### 2. 事件监听

通过 `onEvent()` 订阅事件，可实现监控、日志、调试等功能。

### 3. 缓存策略

可通过 `cacheDir` 配置磁盘持久化，或实现自定义缓存。

### 4. Gstack 技能集成

SDK 集成了 gstack 技能系统——将 AI 代理配置存储为 SKILL.md 文件，运行时按需加载。

- `listSkills(repoDir?)` — 扫描并返回所有可用技能的名称、描述、触发词
- `TaskDefinition.skillName` — 在任务中引用 gstack 技能，运行时自动加载
- `loadSkillForPrompt(config)` — 加载技能并格式化为安全的 system prompt
- 仅提取 frontmatter 元数据（description + triggers），不注入可执行指令

## 性能考虑

### 并发控制

- `ConcurrencyLimiter` 使用 FIFO 信号量
- 确保公平调度，避免饥饿
- 可配置全局和阶段级并发限制

### 缓存优化

- 相同阶段和任务ID的结果会被缓存（仅成功结果）
- 缓存标记：结果对象和事件中均包含 `cached: true`
- 支持跨会话复用缓存（磁盘持久化）
- 缓存命中率直接影响性能

### 内存管理

- 事件历史有缓冲区限制
- 缓存结果可配置过期策略
- 避免不必要的内存占用

## 安全性

### 无外部依赖

- 只使用 Node.js 内置模块
- 减少供应链攻击风险
- 更容易审计和维护

### 输入验证

- 工作流定义验证
- LLM 请求参数验证
- 错误信息清晰，易于调试

## 测试策略

### 测试层次

1. **单元测试**：核心逻辑、工具函数
2. **集成测试**：模块间交互
3. **端到端测试**：完整工作流执行

### Mock 策略

- 所有 LLM 调用使用 Mock
- 不依赖外部服务
- 可重现的测试结果

## 未来规划

### 短期

- 完善错误处理
- 增加更多事件类型
- 优化缓存策略

### 中期

- 支持更复杂的并发控制
- 提供插件系统
- 增加工作流可视化

### 长期

- 分布式执行支持
- 企业级安全特性
- 可视化工作流设计器

---

*最后更新：2026年5月30日*