# Dynamic Workflow Engine - 任务拆解

## 当前状态

**项目阶段：成型期。** 核心功能、构建产物、基础测试和示例已经具备。下一阶段重点不是扩展大功能，而是修正发布/工程化问题，并把 README 已声明的缓存、恢复、上下文和统计能力接到 runtime 实际行为上。

## 当前验证基线

- [x] `npm run typecheck` 通过。
- [x] `npm test` 通过：14 个测试文件，69 个测试。
- [x] `npm run lint` 通过：已迁移到 `eslint.config.js`（ESLint 9 flat config）。
- [x] `npm pack --dry-run` 可生成发布包预览，包内容为 README、dist 和 package.json。

## 高优先级任务

### 1. 修复发布和工程化配置 ✅

**完成时间：** 2026-05-30

**问题依据：**
- `package.json` 当前把项目自身 `dynamic-workflow-engine` tarball 放进了 `dependencies`。
- `package-lock.json` 也记录了该自依赖。
- `npm run lint` 因 ESLint 9 配置格式不匹配失败。

**验收标准：**
- [x] 移除项目对自身 tarball 的依赖。
- [x] 同步更新 `package-lock.json`。
- [x] 将 ESLint 配置迁移到 `eslint.config.js`（ESLint 9 flat config）。
- [x] `npm run lint` 通过。
- [x] `npm run typecheck` 通过。
- [x] `npm test` 通过。
- [x] `npm pack --dry-run` 输出不包含异常依赖或临时产物。

**变更文件：**
- `package.json` — 移除 self tarball 依赖
- `eslint.config.js` — 新建 ESLint 9 flat config
- `.eslintrc.cjs` — 已删除

### 2. 将缓存和恢复能力接入 WorkflowRuntime ✅

**完成时间：** 2026-05-30

**问题依据：**
- `WorkflowRuntime` 创建了 `WorkflowCache`，但没有调用 `load()` / `save()`。
- `SessionManager` 已实现保存/加载能力，但 runtime 当前没有使用。
- 现有缓存集成测试主要直接测试 `WorkflowCache`，没有覆盖 runtime 级缓存命中行为。

**验收标准：**
- [x] 当传入 `cacheDir` 和固定 `sessionId` 时，第二次运行可复用已持久化的成功结果。
- [x] runtime 在合适时机加载和保存 cache/session state。
- [x] 恢复逻辑与文档一致：已完成 phase 跳过，中断中的 phase 重新执行。
- [x] 添加 runtime 级集成测试，验证 `cachedAgents`、事件和 LLM 调用次数。
- [x] 明确失败结果不缓存；只缓存成功结果。

**变更文件：**
- `src/runtime/WorkflowRuntime.ts` — 集成 Cache.load/save + SessionManager
- `src/runtime/PhaseExecutor.ts` — 只缓存成功结果，cached 标记修复
- `tests/integration/cache-persistence.test.ts` — 新增
- `tests/integration/resume.test.ts` — 新增 resume e2e 测试

### 3. 修正 WorkflowContext.variables 生命周期 ✅

**完成时间：** 2026-05-30

**问题依据：**
- README 描述 `ctx.variables` 是跨 phase 的 mutable bag。
- 当前每个 phase 都重新创建 `variables: {}`，跨 phase 写入不会保留。

**验收标准：**
- [x] 同一次 workflow run 内，`ctx.variables` 在所有 phase 间共享。
- [x] 添加测试：phase 1 写入变量，phase 2 能读取。
- [x] 文档明确说明：不持久化 variables 到 session，每次 run 重置。

**变更文件：**
- `src/agent/AgentExecutor.ts` — `createContext()` 接受可选 `variables` 参数
- `src/runtime/WorkflowRuntime.ts` — 创建共享 `sessionVariables` 传入所有 phase
- `tests/integration/multi-phase.test.ts` — 新增 variables 跨 phase 测试

### 4. 增强配置校验，避免不可恢复的运行状态 ✅

**完成时间：** 2026-05-30

**问题依据：**
- `WorkflowBuilder.concurrency(n)` 和 phase concurrency 未校验。
- `ConcurrencyLimiter(0)` 会导致任务永久排队。
- phase/task 名称、重复 task id、空 task 列表等配置错误目前没有统一校验。

**验收标准：**
- [x] workflow name、phase name、task id、systemPrompt、task 内容都有明确校验。
- [x] concurrency 必须是正整数。
- [x] 同一 phase 内重复 task id 抛出 `ConfigurationError`。
- [x] 空 phase 或空 tasks 拒绝并抛出 `ConfigurationError`。
- [x] 添加边界测试：`0`、负数、非整数、重复 id、空字符串。

**变更文件：**
- `src/builder/WorkflowBuilder.ts` — PhaseBuilder + WorkflowBuilder 完整校验
- `src/runtime/ConcurrencyLimiter.ts` — 构造函数校验 max > 0
- `src/workflow.ts` — `Workflow.from()` 扩展校验
- `tests/unit/config-validation.test.ts` — 新增 25 个测试

### 5. 修正统计、事件和缓存标记的一致性 ✅

**完成时间：** 2026-05-30

**问题依据：**
- workflow summary 中 phase `durationMs` 当前固定为 `0`。
- cached result 发出的事件带 cached 标记，但返回结果可能仍保留原始 cached 值。
- `TokenTracker` 只记录实际执行的 agent，不一定与 cached summary 口径一致。

**验收标准：**
- [x] `WorkflowSummary.phases[].durationMs` 使用真实 phase 耗时。
- [x] cached result 在事件和最终 results 中都标记为 `cached: true`。
- [x] Token tracker 在 resume 时恢复，`getTokenUsage()` 与 summary 一致。
- [x] phase error count 覆盖所有失败来源，包括 limiter 外层 rejected 分支。

**变更文件：**
- `src/runtime/WorkflowRuntime.ts` — phase timing tracking + token tracker restore
- `src/runtime/PhaseExecutor.ts` — cached 标记修复 + error count 覆盖
- `tests/integration/event-consistency.test.ts` — 新增事件顺序与统计一致性测试

### 6. 补强 OpenAICompatibleClient 的取消和 usage 兼容性 ✅

**完成时间：** 2026-05-30

**问题依据：**
- `LLMCompletionRequest.signal` 已定义，但 OpenAI client 的 retry 逻辑使用内部 signal，未合并外部取消信号。
- 当 provider 不返回 `usage.total_tokens` 时，当前 fallback 可能给出 `totalTokens: 0`。
- JSON 解析失败、非 chat-completions 兼容响应等错误上下文还可以更清晰。

**验收标准：**
- [x] 外部 `AbortSignal` 可取消请求和 retry 等待。
- [x] usage 缺失时，`totalTokens = promptTokens + completionTokens`。
- [x] 增加 LLM client 单元测试：429/5xx retry、4xx 不 retry、timeout、外部取消、usage fallback。
- [x] 错误信息包含 provider 状态码和可诊断上下文，不泄露 API key。

**变更文件：**
- `src/llm/LLMClient.ts` — withRetry 接受 externalSignal + delay helper
- `src/llm/OpenAICompatibleClient.ts` — total_tokens fallback + 错误改进
- `tests/unit/llm-client.test.ts` — 新增 10 个测试

## 中优先级任务

### 7. 完善测试覆盖的针对性 ✅

**完成时间：** 2026-05-30

**验收标准：**
- [x] 新增 runtime 级缓存持久化测试。
- [x] 新增 session resume 端到端测试，而不只是 `SessionManager` 类测试。
- [x] 新增 `ctx.variables` 跨 phase 测试。
- [x] 新增配置校验失败测试。
- [x] 新增事件顺序与 summary 统计一致性测试。

**测试增长：** 29 → 69 个测试（+40 个）

### 8. 梳理文档与实际行为的一致性 ✅

**完成时间：** 2026-05-30

**验收标准：**
- [x] README 中 cache/resume/variables 的描述与实现一致。
- [x] 文档说明缓存键策略：当前是 `phaseName:agentId`，不是内容 hash。
- [x] 文档说明错误 agent 不会抛出，而是返回 `AgentResult.status = 'error'`。
- [x] 文档说明缓存结果是否计入 token usage（summary 包含，getTokenUsage 排除）。
- [x] 示例命令可直接运行，环境变量说明清晰。

**变更文件：**
- `README.md` — cache/resume/variables/token 说明更新
- `doc/design-doc.md` — 缓存生命周期、session resume、variables 文档更新
- `doc/ai-collaboration.md` — 测试命令修正

### 9. 完善错误处理和诊断能力

**验收标准：**
- [ ] 所有公共 API 抛出的配置错误使用 `ConfigurationError`。
- [ ] LLM 错误保留 status code、可读 message 和 retry 决策。
- [ ] 事件系统可暴露 handler 异常诊断方式，或明确 fire-and-forget 且吞错。
- [ ] 提供错误处理示例。

## 低优先级任务

### 10. 缓存策略扩展

**验收标准：**
- [ ] 支持自定义缓存键生成。
- [ ] 支持缓存过期策略。
- [ ] 支持禁用缓存或按 phase/task 控制缓存。
- [ ] 增加缓存文件损坏时的诊断信息。

### 11. 事件系统扩展

**验收标准：**
- [ ] 事件历史缓冲区大小可配置。
- [ ] 增加事件处理示例。
- [ ] 明确 async event handler 的失败处理策略。

### 12. 后续能力探索

**候选项：**
- [ ] 插件系统接口设计。
- [ ] 可视化导出格式。
- [ ] DAG / 并行 phase 执行。
- [ ] 多 provider 官方适配器。
- [ ] Streaming response 支持。

## 建议执行顺序

1. ~~先做任务 1，恢复 lint 和发布配置的可信度。~~ ✅ 已完成
2. ~~再做任务 2、3、5，因为它们直接关系 README 承诺和 runtime 行为。~~ ✅ 已完成
3. ~~同步补任务 7 的回归测试，避免后续改动把缓存/恢复语义打散。~~ ✅ 已完成
4. ~~最后做任务 6 和文档一致性清理。~~ ✅ 已完成
5. 下一步：任务 9（错误处理和诊断能力）

## 里程碑

### v0.1.x 稳定化
- [x] 发布配置可信。
- [x] lint/typecheck/test 全部通过。
- [x] 缓存、恢复、variables、summary 与 README 一致。
- [x] 核心行为有 runtime 级回归测试。

### v0.2.0
- [ ] 缓存策略可配置。
- [ ] 事件系统可配置。
- [ ] 错误处理和 LLM client 兼容性完善。

### v1.0.0
- [ ] API 稳定。
- [ ] 文档、示例、测试覆盖达到可发布 SDK 标准。
- [ ] 再评估插件、可视化和分布式支持。

---

*最后更新：2026年5月30日*