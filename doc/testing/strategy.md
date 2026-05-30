# Dynamic Workflow Engine - 测试策略

## 概述

本文档定义了 Dynamic Workflow Engine 的测试策略，包括测试分层、覆盖率要求、测试工具使用和 AI 协作测试方式。

## 测试原则

1. **测试是 AI 迭代的度量衡**：为 AI 提供明确的"通过/失败"信号
2. **快速反馈**：测试执行快速，支持频繁运行
3. **可重现性**：所有测试结果可重现，不依赖外部服务
4. **自动验证**：支持自动化测试和持续集成

## 测试分层

### 1. 单元测试

**目标：** 验证单个函数、类、模块的正确性。

**覆盖范围：**
- 核心类型定义（`src/types/`）
- 工具函数（如 `TokenTracker`）
- 单个类的方法（如 `WorkflowBuilder`）
- 错误处理逻辑

**执行频率：** 每次代码修改后

**执行命令：**
```bash
npm run test:unit
```

**测试工具：**
- Vitest 测试框架
- Mock 工具（见 `tests/helpers/mock-llm.ts`）

### 2. 集成测试

**目标：** 验证模块间交互的正确性。

**覆盖范围：**
- 工作流执行流程（`WorkflowRuntime` → `PhaseExecutor` → `AgentExecutor`）
- 缓存机制（`Cache` 与执行流程的集成）
- 会话恢复机制（`SessionManager` 与执行流程的集成）
- 事件系统（`EventEmitter` 与执行流程的集成）

**执行频率：** 每次重要修改后

**执行命令：**
```bash
npm run test:integration
```

**测试工具：**
- Vitest 测试框架
- Mock LLM（`createMockLLM`）
- 真实工作流定义

### 3. 端到端测试

**目标：** 验证完整工作流的正确性。

**覆盖范围：**
- 基础工作流执行
- 多阶段工作流执行
- 并发控制工作流
- 错误恢复工作流

**执行频率：** 每个版本发布前

**执行命令：**
```bash
npm run test:e2e
```

**测试工具：**
- Vitest 测试框架
- Mock LLM（`createMockLLM`）
- 完整工作流定义

## 覆盖率要求

### 整体覆盖率
- **行覆盖率：** ≥ 80%
- **分支覆盖率：** ≥ 70%
- **函数覆盖率：** ≥ 90%

### 模块覆盖率

#### 核心模块（必须达到 90%）
- `src/types/` - 类型定义
- `src/errors.ts` - 错误处理
- `src/llm/` - LLM 客户端

#### 运行时模块（必须达到 85%）
- `src/runtime/WorkflowRuntime.ts`
- `src/runtime/PhaseExecutor.ts`
- `src/runtime/ConcurrencyLimiter.ts`
- `src/runtime/Cache.ts`
- `src/runtime/SessionManager.ts`

#### API 模块（必须达到 80%）
- `src/builder/WorkflowBuilder.ts`
- `src/workflow.ts`

#### 工具模块（必须达到 75%）
- `src/events/EventEmitter.ts`
- `src/token/TokenTracker.ts`

## 测试工具

### Mock LLM

**位置：** `tests/helpers/mock-llm.ts`

**功能：**
- `createMockLLM(responseMap?)` - 创建 Mock LLM
  - 默认返回 `Echo: {user-message}`
  - 可选映射系统提示到固定响应
- `createFailingMockLLM(failPrompts[], errorMessage?)` - 创建失败 Mock LLM
  - 指定失败的提示
  - 自定义错误信息

**使用示例：**
```typescript
import { createMockLLM } from './helpers/mock-llm';

// 基础使用
const mockLLM = createMockLLM();

// 带响应映射
const mockLLM = createMockLLM({
  'Researcher': 'Research result',
  'Writer': 'Written content'
});

// 失败 Mock
const failingMock = createFailingMockLLM(
  ['error prompt'],
  'Simulated API error'
);
```

### 测试数据

**原则：**
- 使用内联数据，不依赖外部文件
- 数据结构清晰，易于理解
- 包含边界条件和边缘情况

**示例：**
```typescript
const testWorkflow = {
  name: 'test-workflow',
  phases: [
    {
      name: 'phase-1',
      tasks: [
        {
          id: 'task-1',
          systemPrompt: 'Test prompt',
          task: 'Test task'
        }
      ]
    }
  ]
};
```

## AI 参与测试方式

### 1. 代码生成时同步生成测试

**要求：**
- 每次提供代码修改后，必须同时提供对应的单元测试代码
- 测试必须覆盖正常流程和错误流程
- 测试必须覆盖边界条件

**示例：**
```typescript
// 生成的代码
export function validateWorkflow(config: WorkflowConfig): boolean {
  if (!config.name) return false;
  if (!config.phases || config.phases.length === 0) return false;
  return true;
}

// 同时生成的测试
describe('validateWorkflow', () => {
  it('should return true for valid config', () => {
    const config = { name: 'test', phases: [{ name: 'phase', tasks: [] }] };
    expect(validateWorkflow(config)).toBe(true);
  });

  it('should return false for missing name', () => {
    const config = { name: '', phases: [{ name: 'phase', tasks: [] }] };
    expect(validateWorkflow(config)).toBe(false);
  });

  it('should return false for empty phases', () => {
    const config = { name: 'test', phases: [] };
    expect(validateWorkflow(config)).toBe(false);
  });
});
```

### 2. Bug 修复时先生成复现测试

**要求：**
- 修复 Bug 时，先生成能复现 Bug 的测试用例
- 确保修复后该测试用例通过
- 测试用例应包含 Bug 的重现步骤

**示例：**
```typescript
// Bug 描述：工作流名称为空时，validateWorkflow 返回 true 而不是 false

// 复现测试
it('should return false for empty workflow name', () => {
  const config = { name: '', phases: [{ name: 'phase', tasks: [] }] };
  expect(validateWorkflow(config)).toBe(false);
});

// 修复后，此测试应该通过
```

### 3. 主动建议测试命令

**要求：**
- 在你认为改动可能影响其他模块时，主动列出需要重新运行的测试命令
- 提供具体的测试命令和解释

**示例：**
```
我修改了 WorkflowRuntime 的并发控制逻辑，这可能影响以下测试：

1. 运行单元测试：`npm run test:unit`
   - 特别关注 `concurrency.test.ts`

2. 运行集成测试：`npm run test:integration`
   - 特别关注 `runtime.test.ts`

3. 运行完整测试：`npm test`

建议在提交前运行所有测试，确保没有回归问题。
```

### 4. 测试命名规范

**要求：**
- 使用清晰的业务语义命名测试
- 测试名称应描述被测试的行为
- 避免使用无意义的名称

**示例：**
```typescript
// ✅ 正确
describe('WorkflowRuntime', () => {
  it('should execute phases sequentially', () => {...});
  it('should execute tasks in parallel within a phase', () => {...});
  it('should capture agent errors without throwing', () => {...});
  it('should skip cached agent results', () => {...});
});

// ❌ 错误
describe('WorkflowRuntime', () => {
  it('test1', () => {...});
  it('should work', () => {...});
  it('test concurrent', () => {...});
});
```

## 测试执行流程

### 开发阶段

1. **编写代码**
2. **编写单元测试**
3. **运行单元测试**
4. **运行 ESLint 和 TypeScript 检查**
5. **提交代码**

### 集成阶段

1. **运行所有单元测试**
2. **运行集成测试**
3. **验证覆盖率**
4. **运行 ESLint 和 TypeScript 检查**
5. **提交代码**

### 发布阶段

1. **运行所有测试**
2. **验证覆盖率达标**
3. **运行完整构建**
4. **更新版本号**
5. **创建发布**

## 测试配置

### Vitest 配置

**文件：** `vitest.config.ts`

**配置项：**
- 测试文件匹配：`tests/**/*.test.ts`
- 全局设置：启用 globals
- 超时时间：30 秒
- 覆盖率配置：`v8` 覆盖率

### TypeScript 配置

**文件：** `tsconfig.json`

**配置项：**
- 启用严格模式
- 启用 `noImplicitAny`
- 启用 `strictNullChecks`

## 常见测试场景

### 1. 工作流执行测试

```typescript
it('should execute multi-phase workflow', async () => {
  const mockLLM = createMockLLM();
  const workflow = Workflow.from({
    name: 'test',
    llm: mockLLM,
    phases: [
      { name: 'phase1', tasks: [{ id: 'task1', systemPrompt: 'P', task: 'T' }] },
      { name: 'phase2', tasks: [{ id: 'task2', systemPrompt: 'P', task: 'T' }] }
    ]
  });
  
  const result = await workflow.run();
  
  expect(result.phases).toHaveLength(2);
  expect(result.phases[0].agents).toHaveLength(1);
  expect(result.phases[1].agents).toHaveLength(1);
});
```

### 2. 并发控制测试

```typescript
it('should respect concurrency limits', async () => {
  const mockLLM = createMockLLM();
  const workflow = Workflow.from({
    name: 'test',
    llm: mockLLM,
    maxConcurrency: 2,
    phases: [{
      name: 'phase1',
      concurrency: 1,
      tasks: [
        { id: 'task1', systemPrompt: 'P', task: 'T' },
        { id: 'task2', systemPrompt: 'P', task: 'T' },
        { id: 'task3', systemPrompt: 'P', task: 'T' }
      ]
    }]
  });
  
  const result = await workflow.run();
  
  // 验证并发限制
  expect(result.phases[0].agents).toHaveLength(3);
});
```

### 3. 错误处理测试

```typescript
it('should capture agent errors without throwing', async () => {
  const mockLLM = createFailingMockLLM(['error'], 'API Error');
  const workflow = Workflow.from({
    name: 'test',
    llm: mockLLM,
    phases: [{
      name: 'phase1',
      tasks: [{ id: 'task1', systemPrompt: 'P', task: 'error' }]
    }]
  });
  
  const result = await workflow.run();
  
  expect(result.phases[0].agents[0].status).toBe('error');
  expect(result.phases[0].agents[0].error).toBe('API Error');
});
```

### 4. 缓存测试

```typescript
it('should cache and reuse agent results', async () => {
  const mockLLM = createMockLLM();
  const workflow = Workflow.from({
    name: 'test',
    llm: mockLLM,
    sessionId: 'session-123',
    phases: [{
      name: 'phase1',
      tasks: [{ id: 'task1', systemPrompt: 'P', task: 'T' }]
    }]
  });
  
  // 第一次执行
  const result1 = await workflow.run();
  expect(result1.phases[0].agents[0].cached).toBe(false);
  
  // 第二次执行（应该使用缓存）
  const result2 = await workflow.run();
  expect(result2.phases[0].agents[0].cached).toBe(true);
});
```

## 测试最佳实践

### 1. 测试独立性
- 每个测试应该独立运行
- 避免测试间依赖
- 使用 `beforeEach` 清理状态

### 2. 测试可读性
- 使用清晰的测试名称
- 包含必要的注释
- 避免复杂的测试逻辑

### 3. 测试可维护性
- 避免重复测试代码
- 使用测试帮助器
- 定期重构测试

### 4. 测试性能
- 避免不必要的异步操作
- 使用 Mock 减少 I/O
- 并行执行独立测试

## 测试报告

### 覆盖率报告

**命令：**
```bash
npm run test:coverage
```

**输出：**
- 终端报告
- HTML 报告（`coverage/` 目录）
- LCOV 报告（用于 CI/CD）

### 测试结果报告

**命令：**
```bash
npm test -- --reporter=verbose
```

**输出：**
- 详细的测试结果
- 失败测试的堆栈信息
- 执行时间统计

## 持续集成

### CI 流程

1. **代码检查**
   - ESLint 检查
   - TypeScript 类型检查

2. **单元测试**
   - 运行所有单元测试
   - 验证覆盖率

3. **集成测试**
   - 运行所有集成测试
   - 验证覆盖率

4. **构建验证**
   - 运行完整构建
   - 验证构建产物

### CI 配置

**推荐工具：**
- GitHub Actions
- GitLab CI
- CircleCI

**配置示例：**
```yaml
name: CI
on: [push, pull_request]
jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v3
      - uses: actions/setup-node@v3
        with:
          node-version: '18'
      - run: npm install
      - run: npm run lint
      - run: npm run typecheck
      - run: npm test
      - run: npm run build
```

## 测试挑战与解决方案

### 挑战 1: LLM 调用的不确定性

**问题：** LLM 响应可能不确定，导致测试不可重现。

**解决方案：** 使用 Mock LLM，确保响应可预测。

### 挑战 2: 异步操作测试

**问题：** 异步操作难以测试，可能产生竞态条件。

**解决方案：**
- 使用 `async/await` 确保执行顺序
- 使用 `Promise.allSettled` 测试并发
- 使用超时机制避免无限等待

### 挑战 3: 错误场景测试

**问题：** 错误场景难以模拟和测试。

**解决方案：**
- 使用失败 Mock LLM
- 模拟网络错误
- 模拟超时错误

### 挑战 4: 性能测试

**问题：** 性能测试难以设计和执行。

**解决方案：**
- 使用基准测试
- 监控关键指标
- 定期性能回归测试

## 测试清单

### 代码修改后
- [ ] 编写单元测试
- [ ] 运行单元测试
- [ ] 验证覆盖率
- [ ] 运行 ESLint
- [ ] 运行 TypeScript 检查

### 集成修改后
- [ ] 运行集成测试
- [ ] 验证覆盖率
- [ ] 运行完整测试套件

### 发布前
- [ ] 运行所有测试
- [ ] 验证覆盖率达标
- [ ] 运行完整构建
- [ ] 更新版本号
- [ ] 创建发布

---

*最后更新：2026年5月30日*