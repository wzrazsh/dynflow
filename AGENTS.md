# AGENTS.md - DynFlow Development Guide

## Agent Identity

I am "Sisyphus" - a powerful AI agent with orchestration capabilities. When working on this codebase, I follow disciplined engineering practices and delegate to specialized subagents when appropriate.

## Codebase Overview

DynFlow is a web-based multi-agent workflow orchestration system with:

- **Backend**: Express + TypeScript server (port 3001)
- **Frontend**: React + Vite SPA (port 5173)
- **Database**: SQLite with WAL mode
- **Agent Execution**: Pluggable runners — `cua` (default, Pi in Cua XFCE container),
  `cua-pi` / `pi-cua-native` (Pi + Cua Computer Server, no Pi-in-container),
  `pi-direct` (host Pi CLI, opt-in), and `docker` (legacy OpenAI-only).
  Providers: `opencode` (default), `openai`, `anthropic`.
- **Sandbox**: isolated-vm V8 isolates + fallback pattern parser

## Architecture Decisions

### Workflow Execution Flow

1. User writes JS script with `phase()` and `agent()` calls
2. Script runs in sandbox (isolated-vm or fallback parser)
3. `WorkflowDefinition` extracted from script
4. Validation via zod schema (max 50 phases, 1000 agents)
5. Persisted to SQLite as WorkflowRun
6. Runtime executes phases sequentially, agents in parallel
7. SSE events stream progress to frontend

### State Machine

```
pending → running → paused → running → completed
                  → stopped
                  → failed
                  → interrupted (server restart)
```

### Agent Runner

DynFlow ships five agent runners. Selection happens in `packages/server/src/runner/index.ts`:

- **`CuaAgentRunner`** (default) — starts the `dynflow-cua-pi` Docker image
  (trycua/cua-xfce + `@earendil-works/pi-coding-agent`), mounts the
  per-workflow workspace at `/home/cua/workspace`, then `docker exec`s
  `pi --mode json --no-session` and parses JSONL events. Container stays
  alive after the run for noVNC access.
- **`CuaPiRunner`** — runs the local `pi` CLI on the host against a Cua
  Computer Server (Python HTTP service) for sandboxed computer use.
  No Docker required for the agent itself.
- **`PiCuaNativeRunner`** — in-process Pi agent that calls
  `runAgentLoop` from `@earendil-works/pi-agent-core` with custom
  Cua-backed `AgentTool[]` definitions. No CLI fork, no JSONL parsing.
- **`PiDirectRunner`** — runs the local `pi` CLI directly, with no
  sandbox. **Opt-in only**, host-privileged, requires
  `DYNFLOW_RUNNER=pi-direct`.
- **`DockerAgentRunner` / `WslDockerAgentRunner`** — legacy
  OpenAI-only Docker agent. WSL variant is auto-selected on Windows.
  Uses `fetch()` directly (no `openai` npm package), supports
  `OPENAI_BASE_URL` for proxies, aborts via `AbortController`, captures
  results from stdout JSON.

The Pi-based runners (`CuaAgentRunner`, `CuaPiRunner`,
`PiCuaNativeRunner`, `PiDirectRunner`) honor `config.model` and
`config.llmProvider` from the per-run `RuntimeConfig` and can be
overridden with `DYNFLOW_PI_MODEL` / `DYNFLOW_PI_PROVIDER` env vars.
`PiCuaNativeRunner` and `PiDirectRunner` are **explicit-only** — they
are not auto-selected even when their dependencies are available.

## Runtime Environment Configuration

Users can specify which agent runner, LLM provider, and model to use per workflow.

### Resolution Order

Runtime configuration is resolved with the following priority (highest first):

1. **Run override** — provided in the Start Run dialog when starting/resuming a workflow
2. **Definition default** — set in the Create Workflow form when the workflow is created
3. **Environment variable** — server-wide defaults when no runtime config is set

### Three Dimensions

- **Runner**: Which agent runner executes the workflow agents
  - Options: `cua`, `cua-pi`, `pi-cua-native`, `pi-direct`, `docker`
  - Fetched from `GET /api/system/info` — only available runners are shown
- **Provider**: The LLM provider for agent prompts
  - Options: `opencode`, `openai`, `anthropic`
  - Filtered by available API keys (`OPENCODE_API_KEY`, `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`)
- **Model**: Free-text model identifier
  - Suggestions come from provider-specific hardcoded lists in `PROVIDER_MODELS`
  - Any string accepted (no validation against known lists)

### API Endpoints

- `GET /api/system/info` — Returns available runners, providers, models, and defaults
- `POST /api/workflows` — Accepts optional `runtimeConfig` in request body
- `POST /:id/start` — Accepts optional `runtimeConfig` override with server-side validation
- `POST /:id/resume` — Accepts optional `runtimeConfig` override

### UI Components

- **RuntimeConfigForm** — Reusable form with runner/provider dropdowns and model text input
- **StartRunDialog** — Modal dialog with pre-populated defaults for starting workflows
- **RuntimeConfigChips** — Read-only display showing resolved runner/provider/model

### Runner Fixes

Three Pi-based runners were fixed to respect `config.model` and `config.llmProvider`:

- **CuaAgentRunner**: Added `--model` and `--provider` flags to the `docker exec pi` command
- **CuaPiRunner**: Fixed sentinel bug where `'gpt-4o'` was ignored; now uses `config.llmProvider`
- **PiDirectRunner**: Same sentinel fix; `buildChildEnv` uses `config.llmProvider`
- **PiCuaNativeRunner**: `resolveModel` checks `config.model` before falling back to default

### Planned / Unimplemented Runners

- **`WindowsNativeRunner`** (planned, not yet implemented) — Win32 Restricted
  Token + Job Object isolation (Chrome/Edge/Firefox-style process sandbox)
  via Koffi FFI. Intended to auto-select on Windows when Docker is
  unavailable, opt-in via `DYNFLOW_RUNNER=windows-native`. Configurable
  light/strict filesystem isolation (`DYNFLOW_WIN_SANDBOX_STRICT=1`).
  Four companion PowerShell scripts will live at
  `packages/server/scripts/sandbox/`. See
  `.sisyphus/plans/windows-native-sandbox-runner.md` for the full
  22-task implementation plan and the OpenAI Codex / Chromium references.

  **AppContainer was explicitly rejected** during planning — the chosen
  approach is Restricted Token + Job Object instead. The plan MUST NOT
  add AppContainer as a fallback.

### Storage

- `runtime_config_json TEXT` column on `workflow_runs` table (migration v6)
- Stored as JSON string, validated with zod `RuntimeConfigSchema` on read
- Definition default stored as part of `definition_json`
- Run override stored in `runtime_config_json`

## Development Commands

```bash
# Build all packages
npm run build

# Run tests
npm run test

# Start dev servers
npm run dev:server  # Backend on :3001
npm run dev:web     # Frontend on :5173

# Lint
npm run lint

# Type check
npx tsc -b
```

## File Structure

```
packages/
├── shared/
│   └── src/
│       ├── types.ts              # All shared TypeScript types
│       ├── schema.ts             # Zod validation schema
│       ├── system.ts             # RuntimeConfig / PROVIDER_MODELS / RUNNER_INFO
│       ├── agent-registry.ts     # Agent registry types
│       ├── domain-registry.ts    # Domain registry types
│       ├── skill-registry.ts     # Skill registry types
│       └── index.ts              # Barrel exports
├── server/
│   └── src/
│       ├── index.ts              # Server entry point
│       ├── app.ts                # Express app factory
│       ├── logger.ts             # Pino-style logger
│       ├── agent/                # Agent registry (CRUD + predefined)
│       ├── api/                  # HTTP routers
│       │   ├── workflows.ts           # CRUD endpoints
│       │   ├── workflows-control.ts   # Start / pause / resume / stop / fail / restart
│       │   ├── sse.ts                 # SSE streaming endpoint
│       │   ├── system.ts              # GET /api/system/info
│       │   ├── domains.ts             # Domain registry
│       │   ├── agent-sources.ts       # Agent source registry
│       │   ├── predefined-agents.ts   # Predefined agent definitions
│       │   ├── skills.ts              # Skill registry
│       │   ├── templates.ts           # Workflow templates
│       │   ├── projects.ts            # Project CRUD + workspace
│       │   ├── orchestrate.ts         # LLM-powered workflow design
│       │   └── meta.ts                # scan / extract / register GitHub projects
│       ├── db/                   # SQLite: connection, schema, migrations, repository, template-repository
│       ├── hook/                 # Lifecycle hook manager
│       ├── integration/          # API-level integration tests (multi-agent-flow, runtime-config)
│       ├── meta/                 # Project scanner / extractor / registrar modules
│       ├── orchestrator/         # CandidateSelector + prompt builder for /api/orchestrate
│       ├── project/              # Project service (workspace management, path validation)
│       ├── runner/               # 5 agent runners + helpers
│       │   ├── types.ts              # AgentRunner interface
│       │   ├── cua-runner.ts         # CuaAgentRunner (default: dynflow-cua-pi container + Pi JSONL)
│       │   ├── cua-pi-runner.ts       # CuaPiRunner (host Pi + Cua Computer Server)
│       │   ├── cua-http-client.ts    # HTTP client for Cua Computer Server
│       │   ├── pi-cua-native-runner.ts # PiCuaNativeRunner (in-process Pi + Cua tools)
│       │   ├── pi-direct-runner.ts   # PiDirectRunner (host `pi` CLI, opt-in)
│       │   ├── docker-runner.ts      # DockerAgentRunner (legacy OpenAI-only)
│       │   ├── wsl-docker-runner.ts  # WslDockerAgentRunner (Windows WSL variant)
│       │   ├── pi-output-parser.ts   # Parse Pi JSONL output
│       │   ├── workspace-scanner.ts  # List changed files in workspace
│       │   ├── prompt-builder.ts     # Wrap user prompt w/ workspace context
│       │   └── index.ts              # createAgentRunner() + isDockerAvailable()
│       ├── sandbox/              # isolated-vm + fallback parser
│       ├── skill/                # Skill registry + executor
│       ├── sse/                  # stream-manager + event-factory
│       └── workflow/             # state-machine, phase-executor, runtime, generator
├── web/
│   └── src/
│       ├── App.tsx               # Main app with view routing
│       ├── main.tsx              # React entry point
│       ├── api/                  # Fetch wrappers per backend resource
│       │   ├── client.ts             # Fetch wrapper
│       │   ├── workflows.ts          # Workflow API functions
│       │   ├── templates.ts          # Template API
│       │   ├── projects.ts           # Project API
│       │   ├── registry.ts           # Domain / agent / skill registry API
│       │   ├── skills.ts             # Skills API
│       │   ├── meta.ts               # Meta-workflow API
│       │   └── system.ts             # fetchSystemInfo()
│       ├── components/
│       │   ├── Layout.tsx              # App shell
│       │   ├── Sidebar.tsx             # Navigation
│       │   ├── WorkflowList.tsx        # Workflow list view
│       │   ├── WorkflowDrawer.tsx      # Workflow detail drawer
│       │   ├── WorkflowDetail.tsx      # Detail with drill-down
│       │   ├── WorkflowHistory.tsx     # Run history view
│       │   ├── CreateWorkflowForm.tsx  # Script editor (with RuntimeConfigForm)
│       │   ├── StartRunDialog.tsx      # Start workflow modal (with RuntimeConfigForm)
│       │   ├── RuntimeConfigForm.tsx   # Reusable runner / provider / model form
│       │   ├── RuntimeConfigChips.tsx  # Read-only resolved config display
│       │   ├── StatusBadge.tsx         # Status indicator
│       │   ├── ErrorBoundary.tsx       # React error boundary
│       │   ├── Toast.tsx               # Toast notifications
│       │   ├── TagPicker.tsx           # Tag selector
│       │   ├── ViewCodeModal.tsx       # Code viewer modal
│       │   ├── ImportExport.tsx        # Workflow import / export
│       │   ├── MetaWorkflow.tsx        # Meta-workflow (scan / extract / register)
│       │   ├── ProjectList.tsx         # Project list view
│       │   ├── ProjectDetail.tsx       # Project detail view
│       │   ├── AgentPicker.tsx         # Hierarchical agent picker
│       │   ├── SkillPicker.tsx         # Skill picker with search / filters
│       │   ├── TemplateList.tsx        # Template list
│       │   ├── TemplateDetail.tsx      # Template detail
│       │   ├── TemplateForm.tsx        # Template create / edit
│       │   └── TemplateVersionHistory.tsx  # Template version history
│       └── hooks/
│           ├── useSSE.ts            # SSE custom hook
│           └── useDebouncedValue.ts # Debounced value hook
├── agent/                       # Legacy OpenAI-only Docker agent
│   ├── run.ts
│   └── Dockerfile (node:22-alpine)
└── cua-agent/                   # Cua sandbox + Pi image (default)
    ├── Dockerfile               # trycua/cua-xfce + @earendil-works/pi-coding-agent
    ├── package.json
    └── README.md
```

## Key Patterns

### Adding a New API Endpoint

1. Create router in `packages/server/src/api/`
2. Add types in `packages/shared/src/types.ts`
3. Implement repository function in `packages/server/src/db/repository.ts`
4. Mount router in `packages/server/src/app.ts`
5. Add tests in same directory

### Adding a New SSE Event

1. Add event type to `SSEEventType` in `packages/shared/src/types.ts`
2. Create factory function in `packages/server/src/sse/event-factory.ts`
3. Emit in runtime when appropriate
4. Handle in `packages/web/src/hooks/useSSE.ts`

### Adding a New Component

1. Create in `packages/web/src/components/`
2. Add tests in same file (`.test.tsx`)
3. Import and use in parent component
4. Follow existing patterns for styling (inline styles, no UI library)

## Testing Strategy

- **TDD**: Write tests first, then implementation
- **Unit tests**: Vitest for all packages
- **Integration tests**: API endpoints with supertest
- **E2E tests**: Manual (no Playwright setup yet)

### Test Commands

```bash
npm run test                    # All tests
npx vitest run packages/server  # Server tests only
npx vitest run packages/web     # Web tests only
```

## Common Issues

### "no such table: workflow_runs"

SQLite tables not initialized. Server must call `initSchema()` on startup. Check `packages/server/src/index.ts`.

### "ivm.Isolate is not a constructor"

isolated-vm import issue on Windows. Fallback parser should be used automatically. Check `packages/server/src/sandbox/isolated-runtime.ts`.

### Rollup native binding error

Run `npm install` to reinstall dependencies, especially `@rollup/rollup-win32-x64-msvc`.

## Git Conventions

- **Commit messages**: `type(scope): description`
- **Types**: feat, fix, docs, test, refactor, chore
- **Scope**: shared, server, web, agent, api, sandbox, workflow, db, sse

Example: `feat(api): add workflow control endpoints`

## Environment Variables

```env
# Required for agent execution
OPENCODE_API_KEY=your_opencode_api_key_here

# Optional - for backward compatibility (OPENCODE_API_KEY takes precedence)
OPENAI_API_KEY=your_openai_api_key_here

# Optional - defaults to OpenCode API
OPENAI_BASE_URL=https://opencode.ai/zen/v1
OPENCODE_MODEL=mimo-v2.5-free

# Optional
PORT=3001
DB_PATH=./data/workflows.db
```

## Security Notes

- Workflow scripts execute in sandboxed V8 isolates
- No `require()`, `import`, `fs`, `process`, or network access in scripts
- Agent execution uses Docker containers with memory limits
- SQLite has WAL mode for concurrent access
- No authentication (single-user MVP)

## Windows Background Process Management

When starting long-running servers that should not block the terminal:

```powershell
# ✅ CORRECT: Use cmd.exe /c with file redirection
Start-Process -FilePath "cmd.exe" `
  -ArgumentList "/c", "cd /d <project-dir> && python -m http.server 8000 > server.log 2>&1" `
  -WindowStyle Hidden

# ❌ WRONG: Python http.server outputs access logs to stdout continuously.
# Even with -WindowStyle Hidden, if UseShellExecute=$false or the process
# inherits the console pipe, stdout output will BLOCK the PowerShell session.
# This affects any process that continuously writes to stdout (python http.server,
# node servers without log file, etc.)
```

**Key rule**: Always redirect stdout/stderr to a file with `> file.log 2>&1` when starting background processes that produce continuous output. Do NOT rely on `-WindowStyle Hidden` alone.

### Docker daemon startup (Linux/WSL)

When running in WSL or Linux, Docker daemon may not be running by default. Start it in background:

```bash
sudo nohup dockerd >/tmp/dockerd.log 2>&1 < /dev/null &
```

Verify with: `docker info` or `docker ps`

## Performance Considerations

- Max 16 concurrent agents (configurable, per-phase `maxConcurrency`)
- Agent timeout: 5 minutes default (per-agent `timeoutMs`, schema max 10 min)
- Script timeout: 30 seconds (`executeScript` `timeoutMs` default)
- Memory limit: 512MB per legacy Docker agent container (`--memory=512m`),
  2GB default per Cua agent container (configurable via `memory` option)
- SQLite WAL mode for write performance
- SSE heartbeat every 15 seconds
