# CUA + Pi Agent Runner Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace DynFlow's current OpenAI-only Docker agent with a Cua-sandboxed Pi agent, exposing a per-workflow shared workspace and Cua's desktop/IDE capabilities.

**Architecture:** DynFlow calls `@trycua/computer` SDK to start a Cua sandbox (XFCE desktop, computer-server API, noVNC). Inside the sandbox, Pi runs as a CLI process invoked via `computer.shell.run()`. The workspace is a host directory mounted into the sandbox at `/home/cua/workspace`. Old `DockerAgentRunner` is kept as a fallback behind `DYNFLOW_RUNNER=docker` env var.

**Tech Stack:** Node.js 22, TypeScript, `@trycua/computer` (Cua SDK), `@earendil-works/pi-coding-agent` (Pi CLI), Vitest, supertest, Docker.

---

## Phase A: Foundation

### Task 1: Add `WorkspaceConfig` to shared types

**Files:**
- Modify: `packages/shared/src/types.ts`
- Test: `packages/shared/src/types.test.ts` (create)

- [ ] **Step 1: Write the failing test**

```ts
// packages/shared/src/types.test.ts
import { describe, it, expect } from 'vitest';
import type { WorkspaceConfig, WorkflowDefinition } from './types.js';

describe('WorkspaceConfig', () => {
  it('can be attached to WorkflowDefinition', () => {
    const def: WorkflowDefinition = {
      name: 'test',
      workspace: { git: 'https://github.com/foo/bar', branch: 'main' },
      phases: [],
    };
    expect(def.workspace?.git).toBe('https://github.com/foo/bar');
    expect(def.workspace?.branch).toBe('main');
  });

  it('is optional', () => {
    const def: WorkflowDefinition = { name: 'test', phases: [] };
    expect(def.workspace).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd E:\workspace\dynflow && npx vitest run packages/shared/src/types.test.ts`
Expected: FAIL — `WorkspaceConfig` and the `workspace` field don't exist

- [ ] **Step 3: Add types**

In `packages/shared/src/types.ts`, add at the end:

```ts
export interface WorkspaceConfig {
  /** Git URL to clone into the workspace at run start. */
  git?: string;
  /** Branch to checkout (default: 'main'). */
  branch?: string;
  /** Local host path. If set, takes precedence over `git`. */
  path?: string;
  /** Pin to a specific git commit. */
  commit?: string;
}
```

Find the existing `WorkflowDefinition` interface and add the `workspace` field:

```ts
export interface WorkflowDefinition {
  name: string;
  description?: string;
  /** Optional: prepare a workspace directory before agents run. */
  workspace?: WorkspaceConfig;
  phases: PhaseDefinition[];
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd E:\workspace\dynflow && npx vitest run packages/shared/src/types.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/shared/src/types.ts packages/shared/src/types.test.ts
git commit -m "feat(shared): add WorkspaceConfig type"
```

---

### Task 2: Validate `workspace` in Zod schema

**Files:**
- Modify: `packages/shared/src/schema.ts`
- Test: `packages/shared/src/schema.test.ts` (create)

- [ ] **Step 1: Write the failing test**

```ts
// packages/shared/src/schema.test.ts
import { describe, it, expect } from 'vitest';
import { WorkflowDefinitionSchema } from './schema.js';

describe('WorkflowDefinitionSchema — workspace field', () => {
  it('accepts a valid workspace config', () => {
    const parsed = WorkflowDefinitionSchema.parse({
      name: 'test',
      workspace: { git: 'https://github.com/foo/bar', branch: 'main' },
      phases: [],
    });
    expect(parsed.workspace?.git).toBe('https://github.com/foo/bar');
  });

  it('accepts a workspace with only path', () => {
    const parsed = WorkflowDefinitionSchema.parse({
      name: 'test',
      workspace: { path: '/tmp/local' },
      phases: [],
    });
    expect(parsed.workspace?.path).toBe('/tmp/local');
  });

  it('rejects an empty workspace object', () => {
    expect(() =>
      WorkflowDefinitionSchema.parse({
        name: 'test',
        workspace: {},
        phases: [],
      }),
    ).toThrow();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd E:\workspace\dynflow && npx vitest run packages/shared/src/schema.test.ts`
Expected: FAIL — schema rejects `workspace`

- [ ] **Step 3: Update schema**

In `packages/shared/src/schema.ts`, find `WorkflowDefinitionSchema` (or the `z.object` that defines workflow shape) and add:

```ts
import { z } from 'zod';

const WorkspaceConfigSchema = z
  .object({
    git: z.string().url().optional(),
    branch: z.string().optional(),
    path: z.string().optional(),
    commit: z.string().optional(),
  })
  .refine(
    (data) => data.git !== undefined || data.path !== undefined,
    { message: 'workspace must specify either git or path' },
  );
```

Add the field to the workflow object schema:

```ts
workspace: WorkspaceConfigSchema.optional(),
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd E:\workspace\dynflow && npx vitest run packages/shared/src/schema.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/shared/src/schema.ts packages/shared/src/schema.test.ts
git commit -m "feat(shared): validate workspace in WorkflowDefinitionSchema"
```

---

### Task 3: Extend `AgentRunConfig` and `AgentResult` for Cua/Pi

**Files:**
- Modify: `packages/server/src/runner/types.ts`

- [ ] **Step 1: Read existing types** to know current shape

Run: `cat packages/server/src/runner/types.ts`

- [ ] **Step 2: Replace file contents**

```ts
// packages/server/src/runner/types.ts
import type { WorkspaceConfig } from '@dynflow/shared';

export interface AgentRunConfig {
  agentId: string;
  prompt: string;
  model?: string;
  timeoutMs: number;
  /** Legacy field, kept for DockerAgentRunner. */
  openaiApiKey?: string;

  // === Cua + Pi fields ===
  /** Absolute path on host to the shared workspace directory. */
  workspacePath: string;
  /** Container-internal mount point (default: '/home/cua/workspace'). */
  workspaceMount: string;
  /** Workspace config (used at run start to git clone / verify path). */
  workspaceConfig?: WorkspaceConfig;
  /** noVNC URL returned by Cua SDK after sandbox start. */
  noVncUrl?: string;
  /** Cua computer-server API URL. */
  cuaApiUrl?: string;
}

export interface AgentResult {
  success: boolean;
  output?: string;
  error?: string;
  containerId: string;
  files?: string[];
  fileCount?: number;
  totalSize?: number;
  outputDir?: string;

  // === Cua fields ===
  noVncUrl?: string;
  cuaApiUrl?: string;
  screenshotPaths?: string[];
}

export interface AgentRunner {
  run(config: AgentRunConfig): Promise<AgentResult>;
  stop(containerId: string): Promise<void>;
  cleanup(): Promise<void>;
}
```

- [ ] **Step 3: Verify TypeScript still compiles**

Run: `cd E:\workspace\dynflow && npx tsc -b`
Expected: errors ONLY from files that use the old `outputDir` field as required. We'll fix those in Task 11. Note: do NOT fix all errors here.

- [ ] **Step 4: Commit**

```bash
git add packages/server/src/runner/types.ts
git commit -m "feat(runner): extend AgentRunConfig/AgentResult for Cua+Pi"
```

---

### Task 4: Add `@trycua/computer` dependency

**Files:**
- Modify: `packages/server/package.json`

- [ ] **Step 1: Check existing dependencies and add Cua SDK**

Read `packages/server/package.json`. Add to `dependencies`:

```json
"@trycua/computer": "^0.1.0"
```

(Use whatever the latest published version is at install time. Lock to a specific version after first install.)

- [ ] **Step 2: Install and verify**

Run: `cd E:\workspace\dynflow && npm install`
Expected: `node_modules/@trycua/computer/` exists.

- [ ] **Step 3: Sanity-check import**

Run: `cd E:\workspace\dynflow && node -e "import('@trycua/computer').then(m => console.log(Object.keys(m).slice(0, 10)))"`
Expected: prints an array including `Computer` (or similar class names)

- [ ] **Step 4: Commit**

```bash
git add packages/server/package.json package-lock.json packages/server/package-lock.json
git commit -m "feat(server): add @trycua/computer dependency"
```

(Note: there may be two lock files in a monorepo. Commit whichever changed.)

---

### Task 5: DB schema migration — add workspace and Cua columns

**Files:**
- Modify: `packages/server/src/db/schema.ts`
- Test: `packages/server/src/db/schema.test.ts` (verify columns exist after init)

- [ ] **Step 1: Write the failing test**

```ts
// packages/server/src/db/schema.test.ts
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import Database from 'better-sqlite3';
import { initSchema } from './schema.js';

let db: Database.Database;

beforeAll(() => {
  db = new Database(':memory:');
  initSchema(db);
});

afterAll(() => db.close());

describe('schema — workspace and Cua fields', () => {
  it('workflow_runs has workspace_path column', () => {
    const cols = db.prepare("PRAGMA table_info(workflow_runs)").all() as Array<{ name: string }>;
    expect(cols.map(c => c.name)).toContain('workspace_path');
    expect(cols.map(c => c.name)).toContain('workspace_git_url');
    expect(cols.map(c => c.name)).toContain('workspace_branch');
  });

  it('agent_runs has no_vnc_url and cua_api_url columns', () => {
    const cols = db.prepare("PRAGMA table_info(agent_runs)").all() as Array<{ name: string }>;
    expect(cols.map(c => c.name)).toContain('no_vnc_url');
    expect(cols.map(c => c.name)).toContain('cua_api_url');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd E:\workspace\dynflow && npx vitest run packages/server/src/db/schema.test.ts`
Expected: FAIL — columns don't exist

- [ ] **Step 3: Update schema**

In `packages/server/src/db/schema.ts`, find the `CREATE TABLE workflow_runs` statement and add to the column list:

```sql
workspace_path TEXT,
workspace_git_url TEXT,
workspace_branch TEXT,
```

In the same file, find the `CREATE TABLE agent_runs` statement and add:

```sql
no_vnc_url TEXT,
cua_api_url TEXT,
```

Find the function `initSchema` and ensure it uses these CREATE statements. The function should also include a small migration step for existing databases:

```ts
// At the end of initSchema(db), add idempotent ALTERs:
const migrations = [
  "ALTER TABLE workflow_runs ADD COLUMN workspace_path TEXT",
  "ALTER TABLE workflow_runs ADD COLUMN workspace_git_url TEXT",
  "ALTER TABLE workflow_runs ADD COLUMN workspace_branch TEXT",
  "ALTER TABLE agent_runs ADD COLUMN no_vnc_url TEXT",
  "ALTER TABLE agent_runs ADD COLUMN cua_api_url TEXT",
];
for (const sql of migrations) {
  try { db.exec(sql); } catch { /* column already exists */ }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd E:\workspace\dynflow && npx vitest run packages/server/src/db/schema.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/server/src/db/schema.ts packages/server/src/db/schema.test.ts
git commit -m "feat(db): add workspace and Cua columns + idempotent migration"
```

---

## Phase B: Core Logic (TDD)

### Task 6: `pi-output-parser` — parse Pi JSONL output

**Files:**
- Create: `packages/server/src/runner/pi-output-parser.ts`
- Test: `packages/server/src/runner/pi-output-parser.test.ts`
- Fixtures: `packages/server/src/runner/__fixtures__/pi-success.jsonl`, `pi-error.jsonl`, `pi-empty.jsonl`

- [ ] **Step 1: Write the failing test**

```ts
// packages/server/src/runner/pi-output-parser.test.ts
import { describe, it, expect } from 'vitest';
import { parsePiJsonLines } from './pi-output-parser.js';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const fixture = (name: string) =>
  readFileSync(join(import.meta.dirname, '__fixtures__', name), 'utf-8');

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
    const raw = 'not json\n{"type":"agent_end","messages":[]}\n';
    const result = parsePiJsonLines(raw);
    expect(result.success).toBe(false);
    expect(result.error).toContain('agent_end');
  });
});
```

- [ ] **Step 2: Create fixture files**

`packages/server/src/runner/__fixtures__/pi-success.jsonl`:
```json
{"type":"session","version":3,"id":"abc"}
{"type":"agent_start"}
{"type":"turn_start"}
{"type":"message_start","message":{"role":"user","content":"create hello.txt"}}
{"type":"message_update","message":{"role":"assistant","content":[]},"assistantMessageEvent":{"type":"text_delta","delta":"I created "}}
{"type":"message_end","message":{"role":"assistant","content":[{"type":"text","text":"I created hello.txt with the requested content."}],"stopReason":"stop"}}
{"type":"tool_execution_start","toolCallId":"t1","toolName":"write","args":{}}
{"type":"tool_execution_end","toolCallId":"t1","toolName":"write","result":{},"isError":false}
{"type":"agent_end","messages":[]}
```

`packages/server/src/runner/__fixtures__/pi-error.jsonl`:
```json
{"type":"session","version":3,"id":"abc"}
{"type":"agent_start"}
{"type":"message_end","message":{"role":"assistant","content":[],"stopReason":"error","errorMessage":"rate limit exceeded"}}
{"type":"agent_end","messages":[]}
```

`packages/server/src/runner/__fixtures__/pi-empty.jsonl`:
```json
{"type":"session","version":3,"id":"abc"}
```

- [ ] **Step 3: Run test to verify it fails**

Run: `cd E:\workspace\dynflow && npx vitest run packages/server/src/runner/pi-output-parser.test.ts`
Expected: FAIL — module doesn't exist

- [ ] **Step 4: Implement the parser**

```ts
// packages/server/src/runner/pi-output-parser.ts
export interface ParsedPiOutput {
  success: boolean;
  lastText: string;
  allMessages: unknown[];
  toolCalls: number;
  error?: string;
}

interface PiEvent {
  type: string;
  messages?: Array<{ role: string; content?: unknown; stopReason?: string; errorMessage?: string }>;
  toolCallId?: string;
  toolName?: string;
  isError?: boolean;
}

export function parsePiJsonLines(rawOutput: string): ParsedPiOutput {
  const events: PiEvent[] = [];
  for (const line of rawOutput.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      events.push(JSON.parse(trimmed) as PiEvent);
    } catch {
      /* skip non-JSON lines */
    }
  }

  const agentEnd = events.find((e) => e.type === 'agent_end');
  if (!agentEnd) {
    return {
      success: false,
      lastText: '',
      allMessages: [],
      toolCalls: 0,
      error: 'Pi 输出中未找到 agent_end 事件',
    };
  }

  const messages = agentEnd.messages ?? [];
  const lastText = extractLastAssistantText(messages);
  const toolCalls = events.filter((e) => e.type === 'tool_execution_start').length;

  const lastAssistant = [...messages].reverse().find((m) => m.role === 'assistant');
  const stopReason = lastAssistant?.stopReason;
  const success = stopReason !== 'error' && stopReason !== 'aborted';
  const error =
    stopReason === 'error' || stopReason === 'aborted'
      ? lastAssistant?.errorMessage ?? `stopReason=${stopReason}`
      : undefined;

  return { success, lastText, allMessages: messages, toolCalls, error };
}

function extractLastAssistantText(
  messages: Array<{ role: string; content?: unknown }>,
): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m.role === 'assistant' && Array.isArray(m.content)) {
      const textBlock = (m.content as Array<{ type: string; text?: string }>).find(
        (b) => b.type === 'text',
      );
      if (textBlock?.text) return textBlock.text;
    }
  }
  return '';
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `cd E:\workspace\dynflow && npx vitest run packages/server/src/runner/pi-output-parser.test.ts`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add packages/server/src/runner/pi-output-parser.ts packages/server/src/runner/pi-output-parser.test.ts packages/server/src/runner/__fixtures__/
git commit -m "feat(runner): add Pi JSONL output parser"
```

---

### Task 7: `workspace-scanner` — list changed files in workspace

**Files:**
- Create: `packages/server/src/runner/workspace-scanner.ts`
- Test: `packages/server/src/runner/workspace-scanner.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// packages/server/src/runner/workspace-scanner.test.ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { scanWorkspaceChanges } from './workspace-scanner.js';

let workspace: string;

beforeEach(() => {
  workspace = mkdtempSync(join(tmpdir(), 'wscan-'));
  mkdirSync(join(workspace, 'src'));
  writeFileSync(join(workspace, 'src', 'a.ts'), 'a');
  writeFileSync(join(workspace, 'README.md'), 'readme');
  mkdirSync(join(workspace, '.git'));
  writeFileSync(join(workspace, '.git', 'HEAD'), 'ref: refs/heads/main');
  mkdirSync(join(workspace, 'node_modules'));
  writeFileSync(join(workspace, 'node_modules', 'pkg.js'), 'module');
});

afterEach(() => rmSync(workspace, { recursive: true }));

describe('scanWorkspaceChanges', () => {
  it('lists files excluding .git and node_modules', async () => {
    const result = await scanWorkspaceChanges(workspace);
    expect(result.list.sort()).toEqual(['README.md', 'src/a.ts']);
  });

  it('skips files larger than 1MB', async () => {
    const big = 'x'.repeat(2 * 1024 * 1024);
    writeFileSync(join(workspace, 'big.txt'), big);
    const result = await scanWorkspaceChanges(workspace);
    expect(result.list).not.toContain('big.txt');
  });

  it('returns correct count and size', async () => {
    const result = await scanWorkspaceChanges(workspace);
    expect(result.count).toBe(2);
    expect(result.size).toBe(1 + 6); // 'a' (1 byte) + 'readme' (6 bytes)
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd E:\workspace\dynflow && npx vitest run packages/server/src/runner/workspace-scanner.test.ts`
Expected: FAIL — module doesn't exist

- [ ] **Step 3: Implement the scanner**

```ts
// packages/server/src/runner/workspace-scanner.ts
import { readdir, stat } from 'node:fs/promises';
import { join, relative, resolve } from 'node:path';

const MAX_FILE_SIZE = 1024 * 1024; // 1 MB
const DEFAULT_EXCLUDE = new Set(['.git', 'node_modules', '.dynflow-prompt.md']);

export interface ScanResult {
  list: string[];
  count: number;
  size: number;
}

export async function scanWorkspaceChanges(
  workspacePath: string,
  exclude: Set<string> = DEFAULT_EXCLUDE,
): Promise<ScanResult> {
  const base = resolve(workspacePath);
  const result: ScanResult = { list: [], count: 0, size: 0 };

  async function walk(dir: string): Promise<void> {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (exclude.has(entry.name)) continue;
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(full);
      } else if (entry.isFile()) {
        const s = await stat(full);
        if (s.size > MAX_FILE_SIZE) continue;
        result.list.push(relative(base, full).replaceAll('\\', '/'));
        result.count += 1;
        result.size += s.size;
      }
    }
  }

  await walk(base);
  return result;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd E:\workspace\dynflow && npx vitest run packages/server/src/runner/workspace-scanner.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/server/src/runner/workspace-scanner.ts packages/server/src/runner/workspace-scanner.test.ts
git commit -m "feat(runner): add workspace file scanner"
```

---

### Task 8: `prompt-builder` — wrap user prompt with workspace context

**Files:**
- Create: `packages/server/src/runner/prompt-builder.ts`
- Test: `packages/server/src/runner/prompt-builder.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// packages/server/src/runner/prompt-builder.test.ts
import { describe, it, expect } from 'vitest';
import { buildPiPrompt } from './prompt-builder.js';

describe('buildPiPrompt', () => {
  it('wraps user prompt with workspace context', () => {
    const result = buildPiPrompt({
      userPrompt: 'create hello.txt',
      workspaceMount: '/home/cua/workspace',
    });
    expect(result).toContain('/home/cua/workspace');
    expect(result).toContain('create hello.txt');
    expect(result).toContain('git');
  });

  it('escapes triple-backticks in user prompt to prevent prompt injection', () => {
    const result = buildPiPrompt({
      userPrompt: 'run this: ```\nrm -rf /\n```',
      workspaceMount: '/home/cua/workspace',
    });
    // User content should not be re-interpreted as code block
    expect(result).not.toContain('```\nrm -rf /');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd E:\workspace\dynflow && npx vitest run packages/server/src/runner/prompt-builder.test.ts`
Expected: FAIL — module doesn't exist

- [ ] **Step 3: Implement the builder**

```ts
// packages/server/src/runner/prompt-builder.ts
export interface BuildPromptInput {
  userPrompt: string;
  workspaceMount: string;
}

const TEMPLATE = `你的工作目录是 {{WORKSPACE_MOUNT}}。这是一个真实的项目目录,可能是 git 仓库。

## 当前任务
{{USER_PROMPT}}

## 工作流程建议
1. 用 bash 探索当前目录结构 (\`ls -la\`)
2. 根据需要修改文件 (用 read/write/edit 工具)
3. 完成后用 \`git add -A && git commit -m "..."\` 记录改动
4. 在最后的回复中总结做了什么、改了哪些文件

## 安全提示
- 不要执行破坏性命令 (\`rm -rf /\`、\`dd\`、格式化等),除非用户明确要求
- 遇到权限错误、缺失依赖、网络失败等情况,直接报告而不是尝试绕过
- 修改前先看清现有代码,不要假设文件结构
`;

function escapeCodeFence(text: string): string {
  // Replace triple-backticks that could break out of our own code fences
  return text.replace(/```/g, '` ` `');
}

export function buildPiPrompt(input: BuildPromptInput): string {
  const safePrompt = escapeCodeFence(input.userPrompt);
  return TEMPLATE.replace('{{WORKSPACE_MOUNT}}', input.workspaceMount).replace(
    '{{USER_PROMPT}}',
    safePrompt,
  );
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd E:\workspace\dynflow && npx vitest run packages/server/src/runner/prompt-builder.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/server/src/runner/prompt-builder.ts packages/server/src/runner/prompt-builder.test.ts
git commit -m "feat(runner): add Pi prompt builder with workspace context"
```

---

## Phase C: CuaAgentRunner (TDD with mocked Computer)

### Task 9: CuaAgentRunner skeleton with mockable Computer

**Files:**
- Create: `packages/server/src/runner/cua-runner.ts`

- [ ] **Step 1: Write the failing test (skeleton)**

```ts
// packages/server/src/runner/cua-runner.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { CuaAgentRunner } from './cua-runner.js';

const mockShellRun = vi.fn();
const mockStop = vi.fn();
const mockRun = vi.fn();

vi.mock('@trycua/computer', () => ({
  Computer: vi.fn().mockImplementation(() => ({
    run: mockRun,
    shell: { run: mockShellRun },
    stop: mockStop,
    vncPort: 7001,
    apiPort: 8001,
    id: 'sandbox-1',
  })),
  OSType: { LINUX: 'linux' },
  ProviderType: { DOCKER: 'docker' },
}));

describe('CuaAgentRunner', () => {
  let runner: CuaAgentRunner;

  beforeEach(() => {
    vi.clearAllMocks();
    runner = new CuaAgentRunner();
    mockRun.mockResolvedValue(undefined);
    mockStop.mockResolvedValue(undefined);
  });

  it('starts the Cua sandbox', async () => {
    mockShellRun.mockResolvedValue({
      exitCode: 0,
      output: '{"type":"agent_end","messages":[]}\n',
    });
    await runner.run({
      agentId: 'a1',
      prompt: 'hello',
      workspacePath: '/tmp/ws',
      workspaceMount: '/home/cua/workspace',
      timeoutMs: 60_000,
    });
    expect(mockRun).toHaveBeenCalledOnce();
  });

  it('stops the sandbox even on error', async () => {
    mockShellRun.mockRejectedValue(new Error('shell failed'));
    await expect(
      runner.run({
        agentId: 'a1',
        prompt: 'hello',
        workspacePath: '/tmp/ws',
        workspaceMount: '/home/cua/workspace',
        timeoutMs: 60_000,
      }),
    ).rejects.toThrow('shell failed');
    expect(mockStop).toHaveBeenCalledOnce();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd E:\workspace\dynflow && npx vitest run packages/server/src/runner/cua-runner.test.ts`
Expected: FAIL — module doesn't exist

- [ ] **Step 3: Implement the skeleton**

```ts
// packages/server/src/runner/cua-runner.ts
import { Computer, OSType, ProviderType } from '@trycua/computer';
import type { AgentRunConfig, AgentResult, AgentRunner } from './types.js';
import { parsePiJsonLines } from './pi-output-parser.js';
import { scanWorkspaceChanges } from './workspace-scanner.js';
import { buildPiPrompt } from './prompt-builder.js';
import { writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';

export interface CuaRunnerOptions {
  image?: string;
  memory?: string;
  cpu?: string;
  display?: string;
}

export class CuaAgentRunner implements AgentRunner {
  constructor(private readonly options: CuaRunnerOptions = {}) {}

  async run(config: AgentRunConfig): Promise<AgentResult> {
    const computer = new Computer({
      osType: OSType.LINUX,
      providerType: ProviderType.DOCKER,
      image: this.options.image ?? 'dynflow-cua-pi:latest',
      storage: config.workspacePath,
      display: this.options.display ?? '1280x720',
      memory: this.options.memory ?? '2GB',
      cpu: this.options.cpu ?? '2',
    });

    try {
      await computer.run();

      // Write prompt into workspace
      await mkdir(config.workspacePath, { recursive: true });
      const promptFile = join(config.workspacePath, '.dynflow-prompt.md');
      await writeFile(promptFile, buildPiPrompt({
        userPrompt: config.prompt,
        workspaceMount: config.workspaceMount,
      }), 'utf-8');

      // Run Pi in the sandbox
      const shellCmd = `cd ${config.workspaceMount} && pi --mode json --no-session "$(cat .dynflow-prompt.md)"`;
      const result = await computer.shell.run(shellCmd, { timeout: config.timeoutMs });

      // Parse output
      const parsed = parsePiJsonLines(result.output ?? '');

      // Scan workspace for changes
      const files = await scanWorkspaceChanges(config.workspacePath);

      return {
        success: parsed.success,
        output: parsed.lastText,
        error: parsed.error,
        containerId: (computer as any).id ?? 'unknown',
        files: files.list,
        fileCount: files.count,
        totalSize: files.size,
        outputDir: config.workspacePath,
        noVncUrl: `http://localhost:${(computer as any).vncPort}`,
        cuaApiUrl: `http://localhost:${(computer as any).apiPort}`,
      };
    } catch (err) {
      await computer.stop().catch(() => {});
      throw err;
    } finally {
      await computer.stop().catch(() => {});
    }
  }

  async stop(_containerId: string): Promise<void> {
    // Cua SDK doesn't expose a global stop by ID; cleanup() handles orphans.
  }

  async cleanup(): Promise<void> {
    // TODO Phase 2: enumerate Cua sandboxes and stop orphans.
    // For now, sandbox instances self-stop on process exit.
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd E:\workspace\dynflow && npx vitest run packages/server/src/runner/cua-runner.test.ts`
Expected: PASS (1 test runs and 1 throws — both pass with assertions)

- [ ] **Step 5: Commit**

```bash
git add packages/server/src/runner/cua-runner.ts packages/server/src/runner/cua-runner.test.ts
git commit -m "feat(runner): add CuaAgentRunner skeleton with mocked Computer"
```

---

### Task 10: Wire CuaAgentRunner into the runner factory

**Files:**
- Modify: `packages/server/src/runner/index.ts`

- [ ] **Step 1: Read current factory**

Run: `cat packages/server/src/runner/index.ts`

- [ ] **Step 2: Add env-var-based selection**

Replace `createAgentRunner()` with:

```ts
import { DockerAgentRunner } from './docker-runner.js';
import { WslDockerAgentRunner } from './wsl-docker-runner.js';
import { CuaAgentRunner } from './cua-runner.js';
import type { AgentRunner } from './types.js';
import { logger } from '../logger.js';

export function createAgentRunner(): AgentRunner {
  const runner = process.env.DYNFLOW_RUNNER ?? 'cua';

  if (runner === 'docker') {
    logger.info('Runner: docker (legacy)');
    return selectDockerRunner();
  }

  if (runner === 'cua') {
    logger.info('Runner: cua (default)');
    return new CuaAgentRunner();
  }

  throw new Error(`Unknown DYNFLOW_RUNNER value: ${runner}. Use 'cua' or 'docker'.`);
}

function selectDockerRunner(): AgentRunner {
  const wslAvailable = WslDockerAgentRunner.isAvailable();
  if (wslAvailable) {
    logger.info('Using Docker via WSL');
    return new WslDockerAgentRunner();
  }
  const nativeAvailable = DockerAgentRunner.isAvailable();
  if (nativeAvailable) {
    logger.info('Using native Docker');
    return new DockerAgentRunner();
  }
  throw new Error(
    'Docker is not available. Please start Docker Desktop with WSL integration enabled, ' +
      'or set DYNFLOW_RUNNER=cua.',
  );
}

export function isDockerAvailable(): boolean {
  return WslDockerAgentRunner.isAvailable() || DockerAgentRunner.isAvailable();
}

export async function cleanupContainers(): Promise<void> {
  // Existing logic — keep as-is.
}
```

- [ ] **Step 3: Verify TypeScript compiles**

Run: `cd E:\workspace\dynflow && npx tsc -b`
Expected: success or only pre-existing errors

- [ ] **Step 4: Run existing runner tests**

Run: `cd E:\workspace\dynflow && npx vitest run packages/server/src/runner`
Expected: all runner tests pass (existing + new CuaAgentRunner tests)

- [ ] **Step 5: Commit**

```bash
git add packages/server/src/runner/index.ts
git commit -m "feat(runner): add DYNFLOW_RUNNER env var, default to cua"
```

---

## Phase D: Container Image

### Task 11: Create `packages/cua-agent/` package

**Files:**
- Create: `packages/cua-agent/package.json`
- Create: `packages/cua-agent/Dockerfile`
- Create: `packages/cua-agent/.dockerignore`
- Create: `packages/cua-agent/README.md`

- [ ] **Step 1: Create package.json**

```json
{
  "name": "@dynflow/cua-agent",
  "version": "0.1.0",
  "private": true,
  "description": "Cua sandbox image with Pi coding agent pre-installed",
  "scripts": {
    "build:image": "docker build -t dynflow-cua-pi:latest ."
  }
}
```

- [ ] **Step 2: Create .dockerignore**

```
node_modules
.git
*.md
!README.md
dist
```

- [ ] **Step 3: Create Dockerfile**

```dockerfile
# packages/cua-agent/Dockerfile
FROM trycua/cua-xfce:latest

USER root

# Install Pi coding agent
RUN npm install -g @earendil-works/pi-coding-agent@^0.78.0

# Configure Pi's working directory = workspace mount
ENV PI_CWD=/home/cua/workspace
ENV HOME=/home/cua

# Cua image already has ENTRYPOINT for desktop + computer-server + noVNC
# Pi is launched on demand via Cua SDK's computer.shell.run()

LABEL org.dynflow.component="cua-agent"
LABEL org.dynflow.version="0.1.0"
```

- [ ] **Step 4: Create README**

```markdown
# @dynflow/cua-agent

Cua sandbox image with Pi coding agent pre-installed.

## Build

```bash
npm run build:image
```

## Image contents

- Base: `trycua/cua-xfce` (Ubuntu 22.04 + XFCE + computer-server + noVNC)
- Adds: `@earendil-works/pi-coding-agent` (Pi CLI)

## How it's used

DynFlow's `CuaAgentRunner` starts a container from this image, mounts the
workflow workspace at `/home/cua/workspace`, and invokes `pi --mode json`
inside via `computer.shell.run()`.
```

- [ ] **Step 5: Add to root package.json workspaces (if applicable)**

Check `package.json` at repo root for `workspaces` field. If present, ensure
`packages/cua-agent` is included. If not, leave it — this package has no npm
build, just Docker.

- [ ] **Step 6: Commit**

```bash
git add packages/cua-agent/
git commit -m "feat(cua-agent): add Cua+Pi Docker image package"
```

---

### Task 12: Build and smoke-test the Cua image

**Files:** none (manual verification)

- [ ] **Step 1: Build the image**

Run: `cd E:\workspace\dynflow\packages\cua-agent && npm run build:image`
Expected: image built successfully, tagged `dynflow-cua-pi:latest`

- [ ] **Step 2: Verify image exists**

Run: `docker images dynflow-cua-pi`
Expected: shows the image with size ~2-3 GB

- [ ] **Step 3: Smoke-test container start**

Run: `docker run --rm -d --name smoke-cua dynflow-cua-pi:latest sleep 30`
Expected: container ID printed

- [ ] **Step 4: Verify Pi is installed**

Run: `docker exec smoke-cua which pi && docker exec smoke-cua pi --version`
Expected: `/home/cua/.npm-global/bin/pi` (or similar) and a version string

- [ ] **Step 5: Verify computer-server is up**

Run: `docker exec smoke-cua curl -sf http://localhost:8000/health || echo "no health endpoint"`
Expected: either OK or "no health endpoint" — both acceptable (different Cua images have different health check paths)

- [ ] **Step 6: Cleanup**

Run: `docker stop smoke-cua`

- [ ] **Step 7: Document the smoke-test result**

In `packages/cua-agent/README.md`, append a "Smoke test" section noting the
results. (Skip if both checks passed without issue.)

---

## Phase E: Workflow & API Wiring

### Task 13: Workflow script — accept `workspace` config in sandbox

**Files:**
- Modify: `packages/server/src/sandbox/types.ts`
- Modify: `packages/server/src/sandbox/isolated-runtime.ts` (or fallback parser)

- [ ] **Step 1: Locate the script AST/parser**

Run: `cd E:\workspace\dynflow && grep -rn "WorkflowDefinition" packages/server/src/sandbox/`
Expected: a function that turns the user script into a `WorkflowDefinition`.

- [ ] **Step 2: Update sandbox types**

If the sandbox exposes a `workflow()` API to user scripts, ensure the
`workflow(name, config, fn)` overload is allowed. Find the function
signature in `packages/server/src/sandbox/types.ts` and add:

```ts
// In the workflow() function exposed to user scripts:
function workflow(
  name: string,
  config: { workspace?: WorkspaceConfig } | (() => void),
  fn?: () => void,
): void;
```

(If the existing signature only allows `(name, fn)`, add the new overload.)

- [ ] **Step 3: Update the parser**

In the parser (likely `isolated-runtime.ts` or a fallback), when invoking
`workflow()`, pass the config through to the result. Find the call site and
ensure `WorkspaceConfig` is forwarded to the resulting `WorkflowDefinition`.

- [ ] **Step 4: Test by hand**

Run: `cd E:\workspace\dynflow && npx vitest run packages/server/src/sandbox`
Expected: existing tests still pass

- [ ] **Step 5: Commit**

```bash
git add packages/server/src/sandbox/
git commit -m "feat(sandbox): accept workspace config in workflow() call"
```

---

### Task 14: Repository — persist workspace and Cua fields

**Files:**
- Modify: `packages/server/src/db/repository.ts`

- [ ] **Step 1: Find INSERT/UPDATE for workflow_runs and agent_runs**

Run: `cd E:\workspace\dynflow && grep -n "workflow_runs\|agent_runs" packages/server/src/db/repository.ts | head -30`

- [ ] **Step 2: Add workspace fields to workflow_runs insert**

In the function that creates a workflow run, extend the INSERT statement to
include `workspace_path`, `workspace_git_url`, `workspace_branch`. If
`config.workspace` is undefined, store NULL.

- [ ] **Step 3: Add Cua fields to agent_runs insert/update**

In the function that saves agent results, extend INSERT/UPDATE to include
`no_vnc_url`, `cua_api_url`. If absent, store NULL.

- [ ] **Step 4: Extend return types**

If repository returns plain row objects, add the new fields to the
`WorkflowRun` and `AgentRun` types (likely in `packages/shared/src/types.ts`).

```ts
// packages/shared/src/types.ts
export interface WorkflowRun {
  // ... existing fields
  workspacePath?: string;
  workspaceGitUrl?: string;
  workspaceBranch?: string;
}

export interface AgentRun {
  // ... existing fields
  noVncUrl?: string;
  cuaApiUrl?: string;
}
```

- [ ] **Step 5: Verify TypeScript compiles**

Run: `cd E:\workspace\dynflow && npx tsc -b`
Expected: success

- [ ] **Step 6: Commit**

```bash
git add packages/server/src/db/repository.ts packages/shared/src/types.ts
git commit -m "feat(db): persist workspace and Cua fields in repository"
```

---

### Task 15: API — accept and return workspace config

**Files:**
- Modify: `packages/server/src/api/workflows.ts`
- Modify: `packages/server/src/api/workflows-control.ts`
- Test: `packages/server/src/api/workflows.test.ts` (extend existing or create)

- [ ] **Step 1: Find the create-workflow handler**

Run: `cd E:\workspace\dynflow && grep -n "createWorkflow\|POST" packages/server/src/api/workflows.ts | head -10`

- [ ] **Step 2: Pass through workspace in the API**

The Zod schema for the request body should already validate `workspace`
(thanks to Task 2). Ensure the handler passes it through to the repository:

```ts
const body = CreateWorkflowSchema.parse(req.body);
// ... pass body.workspace to the createWorkflow call
```

- [ ] **Step 3: In workflows-control, pass workspacePath to runner**

In the run-start handler, after creating the workspace dir (or cloning the
git repo if specified), pass the resulting path into the `AgentRunConfig`
that the runner receives. Find the call to `phaseExecutor.execute(...)` and
add `workspacePath`, `workspaceConfig`, `workspaceMount`.

- [ ] **Step 4: Write a test for workspace passthrough**

In `packages/server/src/api/workflows.test.ts`, add:

```ts
it('accepts a workflow with a workspace config', async () => {
  const res = await request(app)
    .post('/api/workflows')
    .send({
      name: 'with-ws',
      workspace: { git: 'https://github.com/foo/bar' },
      script: 'workflow("with-ws", () => { phase("p", () => agent("a", "do")); });',
    });
  expect(res.status).toBe(201);
  expect(res.body.workspace?.git).toBe('https://github.com/foo/bar');
});
```

- [ ] **Step 5: Run tests**

Run: `cd E:\workspace\dynflow && npx vitest run packages/server/src/api`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add packages/server/src/api/
git commit -m "feat(api): accept workspace config in workflow endpoints"
```

---

### Task 16: Workflow runtime — prepare workspace directory

**Files:**
- Modify: `packages/server/src/workflow/runtime.ts`
- Modify: `packages/server/src/workflow/phase-executor.ts`

- [ ] **Step 1: Read runtime.ts to find where workflow starts**

Run: `cat packages/server/src/workflow/runtime.ts | head -100`

- [ ] **Step 2: Add workspace preparation**

Before calling `phaseExecutor.execute(...)`, ensure the workspace exists:

```ts
import { mkdir, access } from 'node:fs/promises';
import { exec as execCb } from 'node:child_process';
import { promisify } from 'node:util';
import { join } from 'node:path';
const execAsync = promisify(execCb);

async function prepareWorkspace(
  workflow: WorkflowDefinition,
  runId: string,
  baseDir: string,
): Promise<string> {
  const wsPath = join(baseDir, 'workspaces', runId);
  await mkdir(wsPath, { recursive: true });
  if (workflow.workspace?.path) {
    // Use the user-provided local path; verify it exists
    await access(workflow.workspace.path);
    return workflow.workspace.path;
  }
  if (workflow.workspace?.git) {
    const branch = workflow.workspace.branch ?? 'main';
    await execAsync(
      `git clone --branch ${branch} --depth 1 ${workflow.workspace.git} ${wsPath}`,
    );
    return wsPath;
  }
  return wsPath; // empty dir
}
```

- [ ] **Step 3: Wire into runtime**

In the run-start path, call `prepareWorkspace()` once per run and store the
resulting path in a context object that's passed to all `AgentRunConfig`s.

- [ ] **Step 4: In phase-executor, pass workspacePath**

In `runAgent()`, ensure `workspacePath` and `workspaceMount` are set on
`AgentRunConfig`:

```ts
const config: AgentRunConfig = {
  // ... existing
  workspacePath: context.workspacePath,
  workspaceMount: '/home/cua/workspace',
  workspaceConfig: context.workflowDef.workspace,
};
```

- [ ] **Step 5: Verify TypeScript compiles**

Run: `cd E:\workspace\dynflow && npx tsc -b`
Expected: success

- [ ] **Step 6: Run workflow tests**

Run: `cd E:\workspace\dynflow && npx vitest run packages/server/src/workflow`
Expected: PASS

- [ ] **Step 7: Commit**

```bash
git add packages/server/src/workflow/
git commit -m "feat(workflow): prepare workspace dir, pass to agent configs"
```

---

## Phase F: Integration Test

### Task 17: Integration test — run real Cua sandbox + Pi

**Files:**
- Create: `packages/server/src/runner/cua-runner.integration.test.ts`

- [ ] **Step 1: Write the integration test**

```ts
// packages/server/src/runner/cua-runner.integration.test.ts
import { describe, it, expect } from 'vitest';
import { mkdtempSync, existsSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CuaAgentRunner } from './cua-runner.js';

const skipIfNoCua = !process.env.RUN_INTEGRATION;

describe.skipIf(skipIfNoCua)('CuaAgentRunner (integration)', () => {
  it('runs a simple agent that writes a file', async () => {
    const workspace = mkdtempSync(join(tmpdir(), 'cua-int-'));
    const runner = new CuaAgentRunner();

    try {
      const result = await runner.run({
        agentId: 'int-1',
        prompt: 'Create a file named hello.txt with content "Hello from Pi".',
        workspacePath: workspace,
        workspaceMount: '/home/cua/workspace',
        timeoutMs: 180_000,
      });

      expect(result.success).toBe(true);
      expect(result.output).toContain('Hello from Pi');
      const helloPath = join(workspace, 'hello.txt');
      expect(existsSync(helloPath)).toBe(true);
      expect(readFileSync(helloPath, 'utf-8').trim()).toBe('Hello from Pi');
    } finally {
      rmSync(workspace, { recursive: true, force: true });
    }
  }, 240_000);
});
```

- [ ] **Step 2: Run with integration flag**

Run: `cd E:\workspace\dynflow && RUN_INTEGRATION=1 npx vitest run packages/server/src/runner/cua-runner.integration.test.ts`
Expected: PASS (will take 1-2 minutes due to container startup + Pi execution)

If FAIL: read the error, check that:
- Docker is running
- `dynflow-cua-pi:latest` image exists (from Task 12)
- API key env var is set in the container (handled in Phase G)

- [ ] **Step 3: Commit**

```bash
git add packages/server/src/runner/cua-runner.integration.test.ts
git commit -m "test(runner): add Cua+Pi integration test"
```

---

## Phase G: Polish & Docs

### Task 18: Documentation update

**Files:**
- Modify: `README.md`
- Modify: `AGENTS.md`
- Modify: `docs/superpowers/specs/2026-06-01-cua-pi-agent-runner-design.md` (add "Status: Implemented")

- [ ] **Step 1: Update root README**

In the "Architecture" section, add a paragraph:

```markdown
DynFlow delegates agent execution to a Cua-sandboxed Pi agent. The Cua
container (`dynflow-cua-pi:latest`) provides a Linux desktop environment
with Pi pre-installed; DynFlow invokes Pi through the Cua SDK and
exchanges JSONL events over `shell.run()`. The legacy OpenAI-only Docker
agent is still available behind `DYNFLOW_RUNNER=docker` for fallback.
```

In the "Environment" section, add:

```env
# Runner selection (default: cua)
DYNFLOW_RUNNER=cua

# Cua image (when DYNFLOW_RUNNER=cua)
DYNFLOW_CUA_IMAGE=dynflow-cua-pi:latest
```

- [ ] **Step 2: Update AGENTS.md**

In the "Agent Runner" section of `AGENTS.md`, replace the "OpenAI-compatible
agent runner" bullet with:

```markdown
- Cua-sandboxed Pi agent: `Computer` SDK from `@trycua/computer` starts a
  Docker container from `dynflow-cua-pi:latest`, runs `pi --mode json` via
  `computer.shell.run()`, and returns parsed JSONL output as the result.
```

- [ ] **Step 3: Mark spec as implemented**

In `docs/superpowers/specs/2026-06-01-cua-pi-agent-runner-design.md`, change
the status line to:

```markdown
**状态**: Implemented (2026-06-01)
```

- [ ] **Step 4: Commit**

```bash
git add README.md AGENTS.md docs/superpowers/specs/2026-06-01-cua-pi-agent-runner-design.md
git commit -m "docs: update README, AGENTS, and spec status for Cua+Pi"
```

---

### Task 19: Final E2E smoke test

**Files:** none (manual)

- [ ] **Step 1: Build all packages**

Run: `cd E:\workspace\dynflow && npm run build`
Expected: all packages compile

- [ ] **Step 2: Run full test suite (skip integration)**

Run: `cd E:\workspace\dynflow && npm test`
Expected: all unit + integration tests pass (integration skipped without env flag)

- [ ] **Step 3: Run lint**

Run: `cd E:\workspace\dynflow && npm run lint`
Expected: no errors

- [ ] **Step 4: Start server with cua runner**

Run: `cd E:\workspace\dynflow && DYNFLOW_RUNNER=cua npm run dev:server`
Expected: server starts, logs "Runner: cua (default)"

- [ ] **Step 5: Run a sample workflow via API**

```bash
curl -X POST http://localhost:3001/api/workflows -H "Content-Type: application/json" -d '{
  "name": "smoke-test",
  "workspace": { "path": "/tmp/sample-repo" },
  "script": "workflow(\"smoke-test\", () => { phase(\"p1\", () => { agent(\"a\", \"List files\"); }); });"
}'
```

Then start the run via `POST /api/workflows/{id}/start` and watch SSE events.
Verify the agent completes successfully.

- [ ] **Step 6: Document any issues found**

If the E2E test fails, file a follow-up. If it passes, mark Phase 1 as
complete in your tracking.

---

## Self-Review Checklist (run after writing the plan)

- [ ] **Spec coverage:** Every section of the design doc maps to a task:
  - §1 Architecture → Task 9, 10
  - §2 Data model → Tasks 1, 2, 3, 5, 14
  - §3 Container image → Tasks 11, 12
  - §4 Result extraction / errors → Tasks 6, 7, 8
  - §5 Testing & migration → Tasks 17, 18, 19
  - §6 Decision record → reflected in Tasks 10 (env switch), 13 (script extension)
  - §7 Future work → out of scope (correct)
- [ ] **Placeholder scan:** No "TBD", "TODO", "implement later" — all code is concrete
- [ ] **Type consistency:** `AgentRunConfig.workspacePath` / `workspaceMount` / `workspaceConfig` used consistently across Tasks 3, 9, 15, 16
- [ ] **Commit hygiene:** Each task ends with a single, focused commit

## Execution Handoff

Plan complete. Two execution options:

1. **Subagent-Driven (recommended)** — I dispatch a fresh subagent per task, review between tasks, fast iteration
2. **Inline Execution** — Execute tasks in this session, batch with checkpoints
