# CUA + Pi Agent Runner 设计文档

**状态**: Implemented (2026-06-01) — Phases A–G done; Phases D/F (image build, integration test) require Docker at runtime
**日期**: 2026-06-01
**作者**: Sisyphus (via opencode brainstorming)

## 摘要

将 DynFlow 的 agent 执行器从"自定义 Node.js + OpenAI API"容器，替换为"Cua 沙箱 + Pi 智能体"的组合。

- **Cua** 提供容器化、带桌面（XFCE）的运行环境
- **Pi** 是住在容器里、负责推理和工具调用的智能体
- **DynFlow** 通过 `@trycua/computer` Node SDK 统一管理沙箱生命周期

> **SDK 选型说明**：Cua 生态有多个 SDK（`@trycua/computer` TypeScript、`cua-sandbox` Python、`cua-computer` Python 已废弃）。我们选 `@trycua/computer` 是因为：① DynFlow 是 TypeScript 后端 ② 这是 Cua 官方维护的 Node.js 入口 ③ Python 端的 `cua-sandbox` 是新统一 SDK 但 DynFlow 不需要 Python。

目标是让 DynFlow **只关心工作流编排**，把 agent 执行、LLM 调用、桌面环境、IDE/浏览器使用全部委托给 Cua + Pi。

---

## 1. 架构总览

### 1.1 核心组件

```
┌─────────────────────────────────────────────────────────────────┐
│  DynFlow Server (host)                                           │
│                                                                   │
│  ┌──────────────────────────────────────────────────────┐       │
│  │  Workflow Runtime                                     │       │
│  │   - 创建 workspace 目录 (git clone)                    │       │
│  │   - 调度 phases → agents                              │       │
│  └────────────────┬─────────────────────────────────────┘       │
│                   │                                              │
│                   ▼                                              │
│  ┌──────────────────────────────────────────────────────┐       │
│  │  CuaAgentRunner                                       │       │
│  │   - import { Computer } from '@trycua/computer'       │       │
│  │   - computer.run() 启动沙箱                            │       │
│  │   - computer.shell.run() 跑 Pi                         │       │
│  │   - computer.screenshot() 拿截图（可选）               │       │
│  │   - computer.stop() 清理                              │       │
│  └────────────────┬─────────────────────────────────────┘       │
│                   │                                              │
│                   ▼                                              │
│  ┌──────────────────────────────────────────────────────┐       │
│  │  data/workspaces/{runId}/                             │       │
│  │   - 共享工作区（git 仓库）                             │       │
│  │   - 挂载到容器 /home/cua/workspace                    │       │
│  │   - run 结束后保留                                    │       │
│  └──────────────────────────────────────────────────────┘       │
│                                                                   │
│  Frontend (React) - 可选 noVNC 嵌入:                              │
│   ┌────────────────────────────────────────────┐                │
│   │  <iframe src="{noVncUrl}">                  │  实时显示     │
│   │   {noVncUrl 由 Cua SDK 动态返回}            │  agent 屏幕   │
│   │  <Pi 事件流 (SSE)>                          │              │
│   └────────────────────────────────────────────┘                │
└─────────────────────────────────────────────────────────────────┘
                                │
                                │ @trycua/computer SDK
                                ▼
┌─────────────────────────────────────────────────────────────────┐
│  Cua + Pi Container (基于 trycua/cua-xfce)                        │
│                                                                   │
│  ┌──────────────────────────────────────────────────────┐       │
│  │  Linux 桌面 (XFCE)                                     │       │
│  │   - IDE (VSCode/Codium)                                │       │
│  │   - Browser (Firefox)                                  │       │
│  │   - Terminal (Pi 在这里运行)                            │       │
│  │   - Files Manager                                      │       │
│  └──────────────────────────────────────────────────────┘       │
│                                                                   │
│  ┌──────────────────────────────────────────────────────┐       │
│  │  Pi (CLI 进程, 通过 Cua SDK 触发)                      │       │
│  │   - 工作目录: /home/cua/workspace                      │       │
│  │   - 工具: bash / read / write / edit / git / grep      │       │
│  │   - 输出: JSONL → computer.shell.run() 返回值         │       │
│  └──────────────────────────────────────────────────────┘       │
│                                                                   │
│  ┌──────────────────────────────────────────────────────┐       │
│  │  Cua computer-server (HTTP API, 端口由 SDK 分配)       │       │
│  │  noVNC (Web VNC, 端口由 SDK 分配)                      │       │
│  └──────────────────────────────────────────────────────┘       │
└─────────────────────────────────────────────────────────────────┘
```

### 1.2 通信拓扑

| 通道 | 方向 | 协议 | 用途 |
|---|---|---|---|
| Pi stdout | 容器 → Host | JSONL via `shell.run` 返回值 | Pi 事件流 |
| Cua API | Host → 容器 | HTTP (port 8000) | 截图、状态查询 |
| noVNC | 浏览器 → 容器 | WebSocket (port 6901) | 用户实时观看 |
| Workspace | Host ↔ 容器 | bind mount via Cua storage | 双向文件读写 |
| Pi 内部 | 进程内 | CLI | Pi 自己的工具调用 |

### 1.3 关键不变量

- **DynFlow 不调用 LLM、不实现工具**：所有 LLM/工具逻辑都在 Pi 里
- **DynFlow 不直接管 Docker 容器**：通过 Cua SDK 抽象，可换 Docker/QEMU/Cloud
- **Workspace 是真实工作目录**：可以是 git 仓库，Pi 用 git 做版本控制
- **Pi 是容器里的一个进程**，不是主进程 — Cua 的 computer-server 才是宿主进程

---

## 2. 数据模型

### 2.1 工作流脚本扩展

```ts
// 当前 DynFlow 的 script API
workflow("name", () => {
  phase("review", () => {
    agent("reviewer", "Review this PR");
  });
});

// 扩展后（向后兼容）
workflow("name", {
  workspace: {                  // ← 新增
    git: "https://github.com/foo/bar",
    branch: "main",
  },
}, () => {
  phase("review", () => {
    agent("reviewer", "Review this PR");
  });
});
```

### 2.2 TypeScript 类型更新

```ts
// packages/shared/src/types.ts

export interface WorkspaceConfig {
  git?: string;        // git URL to clone
  branch?: string;     // branch (default: main)
  path?: string;       // OR local path on host
  commit?: string;     // optional: pin to specific commit
}

export interface WorkflowDefinition {
  name: string;
  description?: string;
  workspace?: WorkspaceConfig;  // ← NEW
  phases: PhaseDefinition[];
}

// packages/server/src/runner/types.ts
export interface AgentRunConfig {
  agentId: string;
  prompt: string;
  model?: string;                 // 覆盖默认
  timeoutMs: number;
  openaiApiKey?: string;          // 兼容性保留
  // === Cua + Pi 字段 ===
  workspacePath: string;          // host 上的工作区绝对路径
  workspaceMount: string;         // 容器内挂载点（默认 /home/cua/workspace）
  workspaceConfig?: WorkspaceConfig; // 用于初始化（git clone）
  noVncPort?: number;             // 分配给容器的 noVNC 端口
  cuaApiPort?: number;            // 分配给容器的 Cua API 端口
  cuaApiUrl?: string;             // 容器启动后 DynFlow 拿到: http://localhost:{port}
}

export interface AgentResult {
  success: boolean;
  output?: string;                // Pi 最终文本
  error?: string;
  containerId: string;
  files?: string[];               // 工作区里被改/创建的文件列表
  fileCount?: number;
  totalSize?: number;
  outputDir?: string;             // = workspacePath
  // === Cua 字段 ===
  noVncUrl?: string;              // http://localhost:6901 — 可嵌入前端
  cuaApiUrl?: string;             // 用于 DynFlow 后续拿截图
  screenshotPaths?: string[];     // agent 过程中关键节点截图
}
```

### 2.3 SQLite schema 增量

```sql
-- workflow_runs 表加字段
ALTER TABLE workflow_runs ADD COLUMN workspace_path TEXT;
ALTER TABLE workflow_runs ADD COLUMN workspace_git_url TEXT;
ALTER TABLE workflow_runs ADD COLUMN workspace_branch TEXT;

-- agent_runs 表加字段
ALTER TABLE agent_runs ADD COLUMN no_vnc_url TEXT;
ALTER TABLE agent_runs ADD COLUMN cua_api_url TEXT;
```

### 2.4 向后兼容策略

- 老的工作流脚本（无 `workspace` 配置）→ 自动使用空目录或本地 fallback
- 老的 `AgentRunConfig.outputDir` → 重命名为 `workspacePath`，旧代码做 alias

---

## 3. 容器镜像

### 3.1 Dockerfile

```dockerfile
# packages/cua-agent/Dockerfile

# 基于 CUA 官方镜像 (已有完整 Linux 桌面 + computer-server + noVNC)
FROM trycua/cua-xfce:latest

USER root

# 安装 Pi 智能体
RUN npm install -g @earendil-works/pi-coding-agent

# 配置 Pi 的工作目录 = workspace 挂载点
ENV PI_CWD=/home/cua/workspace
ENV HOME=/home/cua

# Cua 镜像自带 ENTRYPOINT 启动 desktop + computer-server + noVNC
# 我们不在这里启动 Pi — 由 Cua SDK 通过 shell.run 触发

# 元数据
LABEL org.dynflow.component="cua-agent"
LABEL org.dynflow.version="0.1.0"
```

### 3.2 镜像构建

```bash
# 当前 DynFlow 模式（手动本地构建）
cd packages/cua-agent
docker build -t dynflow-cua-pi:latest .

# 未来: 推到 registry
# docker tag dynflow-cua-pi:latest registry.example.com/dynflow/cua-pi:0.1.0
# docker push registry.example.com/dynflow/cua-pi:0.1.0
```

### 3.3 Pi prompt 注入

**问题**：Pi 怎么知道在容器里用哪个目录、读哪些上下文？

**方案**：容器启动时把 `prompt` 注入到工作区一个文件，Pi 启动时读这个文件。

DynFlow 在调用 `computer.shell.run` 之前：
1. 把 prompt 写入 `/host/workspace/.dynflow-prompt.md`
2. 构造 shell 命令：`cd /home/cua/workspace && pi --mode json --no-session "$(cat .dynflow-prompt.md)"`

可选：自动注入上下文模板（用户在 workflow 里能配）：

```markdown
你的工作目录是 /home/cua/workspace。这是一个 git 仓库。

## 当前任务
{用户原始 prompt}

## 工作流程建议
1. 用 bash 探索当前目录结构（`ls -la`）
2. 根据需要修改文件（用 read/write/edit 工具）
3. 完成后用 `git add -A && git commit -m "..."` 记录改动
4. 在最后的回复中总结做了什么、改了哪些文件
```

### 3.4 资源占用预估

| 资源 | 消耗 |
|---|---|
| 镜像大小 | ~2-3 GB（XFCE 桌面） |
| 内存 | 1.5-2 GB（base） + Pi ~200MB |
| CPU | 1-2 核 |
| 启动时间 | 15-30 秒（容器） |
| 端口占用 | 2 个（noVNC + API） |

---

## 4. 结果提取与错误处理

### 4.1 Pi JSONL 输出解析

`pi --mode json` 的输出是一行一行的 JSON 事件。DynFlow 需要：
1. 解析所有 JSON 行
2. 找 `agent_end` 事件（含完整消息历史）
3. 提取最后一条 assistant 文本消息作为 `output`
4. 检查 `stopReason` 决定 success/failed

伪代码：

```ts
function parsePiJsonLines(rawOutput: string): ParsedPiOutput {
  const events = rawOutput
    .split('\n').filter(Boolean)
    .map(line => {
      try { return JSON.parse(line); } 
      catch { return null; }
    })
    .filter(Boolean);

  const agentEnd = events.find(e => e.type === 'agent_end');
  if (!agentEnd) {
    return { success: false, error: 'Pi 容器退出但未产生 agent_end 事件', ... };
  }

  const messages = agentEnd.messages || [];
  const lastText = extractLastAssistantText(messages);
  const lastAssistant = [...messages].reverse().find(m => m.role === 'assistant');
  const success = lastAssistant?.stopReason !== 'error' 
               && lastAssistant?.stopReason !== 'aborted';

  return { success, lastText, allMessages: messages, ... };
}
```

### 4.2 工作区文件收集

容器退出后，DynFlow 扫描 `workspacePath`，收集：
- 改动/创建的文件列表
- 文件数
- 总大小
- 排除 `.git`、`node_modules`、`.dynflow-prompt.md` 等

伪代码：

```ts
async function scanWorkspaceChanges(workspacePath: string) {
  // walk(workspacePath), 过滤大文件 (>1MB) 和 exclude 列表
  // 返回 { list: string[], count: number, size: number }
}
```

### 4.3 错误处理矩阵

| 失败类型 | 检测方式 | 处理 |
|---|---|---|
| 沙箱启动失败 | `computer.run()` throws | 标记 agent failed, error = 启动错误 |
| Pi 超时 | `shell.run` timeout | `computer.stop()` + 标记 timeout |
| Pi 内部错误 | `stopReason === 'error'` | 解析 errorMessage, 标记 failed |
| 网络/认证错误 | 容器 stderr 含 401/429 | 标记 failed, 不重试（auth）/DynFlow 重试（rate） |
| 工作区 git 失败 | `shell.run("git clone ...")` 退出非 0 | 启动前 fail, 不消耗 sandbox 资源 |
| 沙箱失联 | `computer.shell.run()` throws | `computer.stop()` 清理, 标记 failed |
| Pi 工具错误 | `tool_execution_end` isError=true | 解析 message, 附加到 error 字段 |

### 4.4 重试策略

复用现有 `phase-executor.ts` 的重试逻辑：
- 429 / rate-limit: 指数退避重试（2s, 4s, 8s + jitter）
- 401 / auth: 不重试
- 超时: 重试
- 其他: 不重试

### 4.5 资源清理保证

```ts
export class CuaAgentRunner implements AgentRunner {
  async run(config: AgentRunConfig): Promise<AgentResult> {
    let computer: Computer | null = null;
    try {
      computer = await this.createComputer(config);
      // ... 执行 Pi
    } catch (err) {
      if (computer) await computer.stop().catch(() => {});
      throw err;
    }
  }

  async cleanup(): Promise<void> {
    // DynFlow server 启动时调用, 清理上次崩溃的残留沙箱
    const orphans = await this.listOrphans();
    for (const c of orphans) {
      await c.stop().catch(() => {});
    }
  }
}
```

---

## 5. 测试策略与迁移路径

### 5.1 测试金字塔

```
       E2E (1-2 个)
        /        \
   集成测试 (5-8 个)    ← 启动真实 Cua 沙箱, 跑 Pi
      /            \
  单元测试 (15-25 个)   ← 纯逻辑, mock Computer
```

### 5.2 单元测试（vitest）

| 模块 | 测试用例 | Mock |
|---|---|---|
| `pi-output-parser.ts` | 正常流、错误流、空输出、混合非 JSON 行 | 无 |
| `workspace-scanner.ts` | 空目录、大文件过滤、嵌套目录、`.git` 排除 | fs mock |
| `cua-runner.ts` 的 `run()` | 成功、超时、沙箱启动失败、Pi 内部错误 | `Computer` mock |
| `prompt-builder.ts` | prompt 模板渲染、转义 | 无 |

### 5.3 集成测试

```ts
// packages/server/src/runner/cua-runner.integration.test.ts
describe.skipIf(!process.env.RUN_INTEGRATION)('CuaAgentRunner', () => {
  it('runs a simple agent to completion', async () => {
    const runner = new CuaAgentRunner();
    const result = await runner.run({
      agentId: 'test-1',
      prompt: 'Create a file hello.txt with content "Hello from Pi"',
      workspacePath: '/tmp/test-workspace-1',
      timeoutMs: 120_000,
    });
    expect(result.success).toBe(true);
    expect(result.output).toContain('Hello from Pi');
    expect(result.files).toContain('hello.txt');
  }, 180_000);
});
```

运行方式：
```bash
RUN_INTEGRATION=1 npm test -- cua-runner.integration
```

### 5.4 E2E 测试

```ts
// tests/e2e/workflow-with-cua.test.ts
it('runs a full workflow with Cua agent', async () => {
  const workflow = `
    workflow("e2e-test", {
      workspace: { git: "https://github.com/foo/small-repo" }
    }, () => {
      phase("analyze", () => {
        agent("analyzer", "List the top 3 files in this repo by line count");
      });
    });
  `;
  // POST /api/workflows, run, wait for completion
  // 验证 agent_results[0].output 包含文件列表
}, 300_000);
```

### 5.5 迁移路径（渐进式）

**Phase 1：并行存在** (1 周)
- 新增 `CuaAgentRunner`，注册到 `createAgentRunner()`
- 通过环境变量 `DYNFLOW_RUNNER=cua|pid` 切换
- 老的 `DockerAgentRunner` 保留，作为 fallback
- 新工作流用 cua runner，老的继续用 docker

**Phase 2：默认切换** (1 周)
- 修改 `createAgentRunner()` 默认走 CuaAgentRunner
- DockerAgentRunner 仅当 `CUA_DISABLED=1` 时使用
- 所有内部测试改用 CuaAgentRunner

**Phase 3：清理** (可选)
- 移除 DockerAgentRunner（或移到 `@deprecated`）
- 删除 `packages/agent/`（旧 Node agent 镜像）
- 文档更新

### 5.6 风险与回退

| 风险 | 缓解 | 回退 |
|---|---|---|
| Cua 沙箱启动慢（30s+） | 加 startup timeout 60s, 提示用户 | 临时切回 DockerAgentRunner |
| 资源消耗大（2GB/agent） | 限制 maxConcurrency=4 | 减少并发 |
| `@trycua/computer` 是新 SDK, 可能不稳定 | 用 0.x 版本, 锁版本号, 跑集成测试 | 切 DockerAgentRunner |
| noVNC 端口冲突 | DynFlow 分配端口池 (7000-7100) | 只用 Cua API, 不暴露 noVNC |

### 5.7 实施里程碑

```
M1 (1-2 天)  调研 + 实验: docker run trycua/cua-xfce, 跑通 hello
M2 (2-3 天)  写 CuaAgentRunner + pi-output-parser + 单测
M3 (2-3 天)  写 Dockerfile + 构建脚本 + 集成测试
M4 (1-2 天)  workflow script 扩展 (workspace config) + DB schema
M5 (1-2 天)  E2E + 文档 + Phase 1 切换
M6 (按需)    Phase 2/3 清理
```

---

## 6. 决策记录

| 决策 | 选项 | 选择 | 理由 |
|---|---|---|---|
| 容器内 agent | 编码 agent (Pi) | ✅ Pi | 用户已选 CUA 作环境, Pi 作 agent |
| 环境形态 | GUI desktop / Headless | ✅ GUI desktop (XFCE) | 用户要"操作 IDE", 需要 GUI |
| 容器管理 | 直接 Docker / Cua SDK | ✅ Cua SDK | 可换 Docker/QEMU/Cloud, 不耦合 |
| Pi 模式 | RPC / JSON / Print | ✅ JSON mode | 工作流预定义, 一次性执行足够 |
| Workspace 共享 | 每 agent / 每 phase / 每 workflow | ✅ 每 workflow | 模型自主迭代, 跨 phase 累积 |
| 模型/API key | 每 agent / 统一默认 | ✅ 统一默认 | 简单, 镜像里固定 |
| 前端 noVNC | 嵌入 / 不嵌入 | ⏸ Phase 2+ | 先不实现, 留接口 |
| 老的 DockerAgentRunner | 立即删 / 保留 | ✅ 保留（Phase 1） | 渐进式迁移, 留回退 |

---

## 7. 未来扩展（不在本次实现范围）

- **Web UI noVNC 嵌入**：让用户在浏览器里实时看 agent 操作
- **多 agent 协作**：同 phase 的 agents 通过 git 共享工作区
- **MCP 工具集成**：通过 Cua 的 MCP server 接入外部工具
- **Cua 云端 backend**：从本地 Docker 切到 Cua Cloud, 减少资源压力
- **会话恢复**：Pi 的 session 文件持久化, 暂停后能续跑
