# AGENTS.md - DynFlow Development Guide

## Agent Identity

I am "Sisyphus" - a powerful AI agent with orchestration capabilities. When working on this codebase, I follow disciplined engineering practices and delegate to specialized subagents when appropriate.

## Codebase Overview

DynFlow is a web-based multi-agent workflow orchestration system with:

- **Backend**: Express + TypeScript server (port 13001)
- **Frontend**: React + Vite SPA (port 15173)
- **Database**: SQLite with WAL mode
- **Agent Execution**: Pluggable runners — `cua` (default, Pi in Cua XFCE container),
  `cua-pi` / `pi-cua-native` (Pi + Cua Computer Server, no Pi-in-container),
  `pi-direct` (host Pi CLI, opt-in), `windows-native` (Win32 Restricted Token +
  Job Object via Koffi), `pi-appcontainer` (Win32 AppContainer profile, opt-in),
  and `docker` (legacy OpenAI-only).
  Providers: `opencode` (default), `openai`, `minimax` (OpenAI-compatible),
  `anthropic`.
- **Sandbox**: isolated-vm V8 isolates (legacy) + QuickJS-based dynamic
  script engine (modern DSL with `workflow()` / `phase()` / `agent()` /
  `parallel()` / `checkpoint()` / `apply()` / `log()` and native JS loops).

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
pending �� running �� paused �� running �� completed
                  �� stopped
                  �� failed
                  �� interrupted (server restart)
```

### Agent Runner

DynFlow ships seven agent runners. Selection happens in `packages/server/src/runner/index.ts`:

- **`CuaAgentRunner`** �� default �� starts the `dynflow-cua-pi` Docker image
  (trycua/cua-xfce + `@earendil-works/pi-coding-agent`), mounts the
  per-workflow workspace at `/home/cua/workspace`, then `docker exec`s
  `pi --mode json --no-session` and parses JSONL events. Container stays
  alive after the run for noVNC access.
- **`CuaPiRunner`** �� runs the local `pi` CLI on the host against a Cua
  Computer Server (Python HTTP service) for sandboxed computer use.
  No Docker required for the agent itself.
- **`PiCuaNativeRunner`** �� in-process Pi agent that calls
  `runAgentLoop` from `@earendil-works/pi-agent-core` with custom
  Cua-backed `AgentTool[]` definitions. No CLI fork, no JSONL parsing.
- **`PiDirectRunner`** �� runs the local `pi` CLI directly, with no
  sandbox. **Opt-in only**, host-privileged, requires
  `DYNFLOW_RUNNER=pi-direct`.
- **`WindowsNativeRunner`** �� Win32 Restricted Token + Job Object
  isolation (Chrome/Edge/Firefox-style process sandbox) via Koffi FFI.
  Auto-selected on Windows when Docker is unavailable; opt-in via
  `DYNFLOW_RUNNER=windows-native`.
- **`PiAppContainerRunner`** �� Windows AppContainer profile isolation
  (per-run SID + folder) layered on top of the same Restricted Token
  + Job Object sandbox. **Opt-in only**, requires
  `DYNFLOW_RUNNER=pi-appcontainer`. Caveat: the process-attribute
  path (`SECURITY_CAPABILITIES` + `STARTUPINFOEXW`) is a follow-on;
  today the profile is a tracking + discoverability surface and the
  actual process boundary is the existing restricted-token sandbox.
  See "AppContainer runner (new)" below for the full contract.
- **`DockerAgentRunner` / `WslDockerAgentRunner`** �� legacy
  OpenAI-only Docker agent. WSL variant is auto-selected on Windows.
  Uses `fetch()` directly (no `openai` npm package), supports
  `OPENAI_BASE_URL` for proxies, aborts via `AbortController`, captures
  results from stdout JSON.

## Runtime Environment Configuration

Users can specify which agent runner, LLM provider, and model to use per workflow.

### Resolution Order

Runtime configuration is resolved with the following priority (highest first):

1. **Run override** �� provided in the Start Run dialog when starting/resuming a workflow
2. **Definition default** �� set in the Create Workflow form when the workflow is created
3. **Environment variable** �� server-wide defaults when no runtime config is set

### Three Dimensions

- **Runner**: Which agent runner executes the workflow agents
  - Options: `cua`, `cua-pi`, `pi-cua-native`, `pi-direct`, `pi-appcontainer`, `docker`, `windows-native`
  - Fetched from `GET /api/system/info` �� only available runners are shown
- **Provider**: The LLM provider for agent prompts
  - Options: `opencode`, `openai`, `minimax`, `anthropic`
  - `minimax` is an OpenAI-compatible provider (id `minimax`) that
    reuses `OPENAI_API_KEY` + `OPENAI_BASE_URL`. Hardcoded model
    list: `MiniMax-M3`, `minimax-m2`.
  - Filtered by available API keys (`OPENCODE_API_KEY`, `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`)
- **Model**: Free-text model identifier
  - Suggestions come from provider-specific hardcoded lists in `PROVIDER_MODELS`
  - Any string accepted (no validation against known lists)

### API Endpoints

- `GET /api/system/info` �� Returns available runners, providers, models, and defaults
- `POST /api/workflows` �� Accepts optional `runtimeConfig` in request body
- `POST /:id/start` �� Accepts optional `runtimeConfig` override with server-side validation
- `POST /:id/resume` �� Accepts optional `runtimeConfig` override

### UI Components

- **RuntimeConfigForm** �� Reusable form with runner/provider dropdowns and model text input
- **StartRunDialog** �� Modal dialog with pre-populated defaults for starting workflows
- **RuntimeConfigChips** �� Read-only display showing resolved runner/provider/model

### Runner Fixes

Three Pi-based runners were fixed to respect `config.model` and `config.llmProvider`:

- **CuaAgentRunner**: Added `--model` and `--provider` flags to the `docker exec pi` command
- **CuaPiRunner**: Fixed sentinel bug where `'gpt-4o'` was ignored; now uses `config.llmProvider`
- **PiDirectRunner**: Same sentinel fix; `buildChildEnv` uses `config.llmProvider`
- **PiCuaNativeRunner**: `resolveModel` checks `config.model` before falling back to default

### Windows Native Runner

- **`WindowsNativeRunner`** �� Win32 Restricted Token + Job Object
  isolation (Chrome/Edge/Firefox-style process sandbox) via Koffi FFI.
  Auto-selected on Windows when Docker is unavailable; opt-in via
  `DYNFLOW_RUNNER=windows-native`. Configurable light/strict
  filesystem isolation via `DYNFLOW_WIN_SANDBOX_STRICT=1`.

#### How to enable

```bash
# Force the runner regardless of Docker availability
DYNFLOW_RUNNER=windows-native npm run dev

# Add strict-mode DACL isolation (requires elevated server)
DYNFLOW_WIN_SANDBOX_STRICT=1 DYNFLOW_RUNNER=windows-native npm run dev
```

In the web UI's **Start Run** dialog, the runner dropdown lists
`windows-native` only on hosts where `WindowsNativeRunner.isAvailable()`
returns `true` (i.e., `process.platform === 'win32'` and Koffi loads
without error). The `/api/system/info` endpoint reports availability
in the same way.

#### Strict mode

Strict mode requires the DynFlow server to be running as Administrator
because applying a DACL to the workspace is a privileged operation.
When strict mode is requested from a non-elevated server, the runner
falls back to light mode and logs a clear warning. Light mode runs
the child under a duplicated copy of the server's own primary token
(no `CreateRestrictedToken` call) and applies the memory-cap Job
Object. It does not touch the workspace DACL, and it works fully
non-elevated. Note: light mode gives weaker filesystem isolation
than strict mode �� the child sees the parent's filesystem under
the server's normal user permissions, but is still capped by the
Job Object's `KILL_ON_JOB_CLOSE` and `PROCESS_MEMORY` limits.

#### Debugging

`isAvailable()` returns `false` for any of the following reasons. The
error message printed at runner init identifies which one applies:

1. **Not on Windows.** The runner is a no-op on Linux/macOS. The
   auto-select chain skips it entirely.
2. **Koffi not installed.** Verify with
   `node -e "require('koffi'); console.log('ok')"` from
   `packages/server/`. Re-run `npm install` if it fails.
3. **Koffi struct size mismatch.** `verifyStructSizes()` throws if
   `sizeof(STARTUPINFOW) !== 104`,
   `sizeof(JOBOBJECT_EXTENDED_LIMIT_INFORMATION) !== 144`, or
   `sizeof(SECURITY_ATTRIBUTES) !== 24`. This usually means a
   non-standard toolchain. The error message includes the actual
   sizes for debugging.

#### Test commands

```bash
# Unit tests (run on any platform, most mock the sandbox module)
npx vitest run packages/server/src/runner/windows-native-runner.test.ts

# Windows-only integration test (real Win32 calls)
npx vitest run packages/server/src/runner/integration/windows-sandbox.integration.test.ts

# Convenience target added by the package.json script
npm run test:sandbox:windows --prefix packages/server
```

#### When this runner is auto-selected

After `CuaAgentRunner` and `CuaPiRunner` fail their availability
checks (typically: Docker not running, no `dynflow-cua-pi` image
present, no Cua Computer Server detected), the auto-select chain
checks `WindowsNativeRunner.isAvailable()` only on Windows hosts.
The Docker path is still preferred when available, so on a Windows
host with Docker Desktop running the chain never reaches the
Windows Native runner.

#### Companion PowerShell scripts

Four operator-side scripts at
`packages/server/scripts/sandbox/` cover manual recovery and
inspection:

- `New-SandboxProfile.ps1` �� allocate a profile, apply DACL
  (strict only).
- `Start-SandboxedProcess.ps1` �� launch a process under an
  existing profile from PowerShell.
- `Remove-SandboxProfile.ps1` �� tear down, restore DACL.
- `Get-SandboxProfiles.ps1` �� list profiles and running PIDs.

Full documentation:
[`packages/server/scripts/sandbox/README.md`](packages/server/scripts/sandbox/README.md).

#### Plan guardrails (do NOT change)

- No GUI/tray icon for profile management. No antivirus / Defender
  exclusion management. No Windows Event Log integration. No
  profile persistence across runs (the TypeScript runner recreates
  state per run; the PowerShell scripts persist to
  `%LOCALAPPDATA%\dynflow\sandbox-profiles.json` for operator
  convenience only).
- Light mode must work non-elevated. Strict mode requires admin.
  No changes that would force light mode to need admin.

#### AppContainer runner (new)

A `PiAppContainerRunner` has been added as a sibling of
`WindowsNativeRunner`. It creates a real Windows AppContainer
profile per run (`userenv.dll` `CreateAppContainerProfile` +
`DeriveAppContainerSidFromAppContainerName` +
`GetAppContainerFolderPath`), gives the child a discoverable SID
and per-profile folder, and disposes the profile on cleanup.

Caveats — the user has explicitly accepted these in exchange for
shipping the runner:

- **Process-attribute path is a follow-on.** Real AppContainer
  enforcement requires
  `STARTUPINFOEXW.lpAttributeList` carrying
  `PROC_THREAD_ATTRIBUTE_SECURITY_CAPABILITIES` whose
  `AppContainerSid` points at the profile SID and whose
  `Capabilities` enumerates the granted capability SIDs (e.g.
  `internetClient`). That needs `process.ts` extended to
  `STARTUPINFOEXW` and a managed attribute-list arena. Today the
  runner uses the existing Restricted-Token + Job-Object sandbox
  for the actual process boundary; the AppContainer profile is a
  tracking + discoverability surface, not yet an enforcement
  boundary. Do NOT claim AppContainer enforcement in user-facing
  copy without finishing the SECURITY_CAPABILITIES wiring.
- **Opt-in only.** `pi-appcontainer` is NOT auto-selected ahead of
  `windows-native`; it falls in after `windows-native` in the
  auto-select chain. Users force it via
  `DYNFLOW_RUNNER=pi-appcontainer`.
- No GUI/tray icon, no Defender exclusion, no Event Log integration
  for AppContainer profiles (same constraints as the Restricted
  Token profile).

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
npm run dev:server  # Backend on :13001
npm run dev:web     # Frontend on :15173

# Lint
npm run lint

# Type check
npx tsc -b
```

## File Structure

```
packages/
������ shared/
��   ������ src/
��       ������ types.ts              # All shared TypeScript types
��       ������ schema.ts             # Zod validation schema
��       ������ system.ts             # RuntimeConfig / PROVIDER_MODELS / RUNNER_INFO
��       ������ agent-registry.ts     # Agent registry types
��       ������ domain-registry.ts    # Domain registry types
��       ������ skill-registry.ts     # Skill registry types
��       ������ index.ts              # Barrel exports
������ server/
��   ������ src/
��       ������ index.ts              # Server entry point
��       ������ app.ts                # Express app factory
��       ������ logger.ts             # Pino-style logger
��       ������ agent/                # Agent registry (CRUD + predefined)
��       ������ api/                  # HTTP routers
��       ��   ������ workflows.ts           # CRUD endpoints
��       ��   ������ workflows-control.ts   # Start / pause / resume / stop / fail / restart
��       ��   ������ sse.ts                 # SSE streaming endpoint
��       ��   ������ system.ts              # GET /api/system/info
��       ��   ������ domains.ts             # Domain registry
��       ��   ������ agent-sources.ts       # Agent source registry
��       ��   ������ predefined-agents.ts   # Predefined agent definitions
��       ��   ������ skills.ts              # Skill registry
��       ��   ������ templates.ts           # Workflow templates
��       ��   ������ projects.ts            # Project CRUD + workspace
��       ��   ������ orchestrate.ts         # LLM-powered workflow design
��       ��   ������ meta.ts                # scan / extract / register GitHub projects
��       ������ db/                   # SQLite: connection, schema, migrations, repository, template-repository
��       ������ hook/                 # Lifecycle hook manager
��       ������ integration/          # API-level integration tests (multi-agent-flow, runtime-config)
��       ������ meta/                 # Project scanner / extractor / registrar modules
��       ������ orchestrator/         # CandidateSelector + prompt builder for /api/orchestrate
��       ������ project/              # Project service (workspace management, path validation)
��       ������ runner/               # 6 agent runners + helpers
��       ��   ������ types.ts              # AgentRunner interface
��       ��   ������ cua-runner.ts         # CuaAgentRunner (default: dynflow-cua-pi container + Pi JSONL)
��       ��   ������ cua-pi-runner.ts       # CuaPiRunner (host Pi + Cua Computer Server)
��       ��   ������ cua-http-client.ts    # HTTP client for Cua Computer Server
��       ��   ������ pi-cua-native-runner.ts # PiCuaNativeRunner (in-process Pi + Cua tools)
��       ��   ������ pi-direct-runner.ts   # PiDirectRunner (host `pi` CLI, opt-in)
��       ��   ������ windows-native-runner.ts # WindowsNativeRunner (Windows Restricted Token + Job Object)
��       ��   ������ sandbox/              # Koffi FFI wrappers for Win32 token/job/process/DACL
��       ��   ������ docker-runner.ts      # DockerAgentRunner (legacy OpenAI-only)
��       ��   ������ wsl-docker-runner.ts  # WslDockerAgentRunner (Windows WSL variant)
��       ��   ������ pi-output-parser.ts   # Parse Pi JSONL output
��       ��   ������ workspace-scanner.ts  # List changed files in workspace
��       ��   ������ prompt-builder.ts     # Wrap user prompt w/ workspace context
��       ��   ������ index.ts              # createAgentRunner() + isDockerAvailable()
��       ������ scripts/              # Operator-side scripts
��       ��   ������ sandbox/             # Windows native sandbox PowerShell tools (4 scripts)
��       ������ sandbox/              # isolated-vm + fallback parser
��       ������ skill/                # Skill registry + executor
��       ������ sse/                  # stream-manager + event-factory
��       ������ workflow/             # state-machine, phase-executor, runtime, generator
������ web/
��   ������ src/
��       ������ App.tsx               # Main app with view routing
��       ������ main.tsx              # React entry point
��       ������ api/                  # Fetch wrappers per backend resource
��       ��   ������ client.ts             # Fetch wrapper
��       ��   ������ workflows.ts          # Workflow API functions
��       ��   ������ templates.ts          # Template API
��       ��   ������ projects.ts           # Project API
��       ��   ������ registry.ts           # Domain / agent / skill registry API
��       ��   ������ skills.ts             # Skills API
��       ��   ������ meta.ts               # Meta-workflow API
��       ��   ������ system.ts             # fetchSystemInfo()
��       ������ components/
��       ��   ������ Layout.tsx              # App shell
��       ��   ������ Sidebar.tsx             # Navigation
��       ��   ������ WorkflowList.tsx        # Workflow list view
��       ��   ������ WorkflowDrawer.tsx      # Workflow detail drawer
��       ��   ������ WorkflowDetail.tsx      # Detail with drill-down
��       ��   ������ WorkflowHistory.tsx     # Run history view
��       ��   ������ CreateWorkflowForm.tsx  # Script editor (with RuntimeConfigForm)
��       ��   ������ StartRunDialog.tsx      # Start workflow modal (with RuntimeConfigForm)
��       ��   ������ RuntimeConfigForm.tsx   # Reusable runner / provider / model form
��       ��   ������ RuntimeConfigChips.tsx  # Read-only resolved config display
��       ��   ������ StatusBadge.tsx         # Status indicator
��       ��   ������ ErrorBoundary.tsx       # React error boundary
��       ��   ������ Toast.tsx               # Toast notifications
��       ��   ������ TagPicker.tsx           # Tag selector
��       ��   ������ ViewCodeModal.tsx       # Code viewer modal
��       ��   ������ ImportExport.tsx        # Workflow import / export
��       ��   ������ MetaWorkflow.tsx        # Meta-workflow (scan / extract / register)
��       ��   ������ ProjectList.tsx         # Project list view
��       ��   ������ ProjectDetail.tsx       # Project detail view
��       ��   ������ AgentPicker.tsx         # Hierarchical agent picker
��       ��   ������ SkillPicker.tsx         # Skill picker with search / filters
��       ��   ������ TemplateList.tsx        # Template list
��       ��   ������ TemplateDetail.tsx      # Template detail
��       ��   ������ TemplateForm.tsx        # Template create / edit
��       ��   ������ TemplateVersionHistory.tsx  # Template version history
��       ������ hooks/
��           ������ useSSE.ts            # SSE custom hook
��           ������ useDebouncedValue.ts # Debounced value hook
������ agent/                       # Legacy OpenAI-only Docker agent
��   ������ run.ts
��   ������ Dockerfile (node:22-alpine)
������ cua-agent/                   # Cua sandbox + Pi image (default)
    ������ Dockerfile               # trycua/cua-xfce + @earendil-works/pi-coding-agent
    ������ package.json
    ������ README.md
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

# Optional providers
OPENAI_API_KEY=your_openai_api_key_here
MINIMAX_CN_API_KEY=your_minimax_cn_api_key_here   # MiniMax China (used when UI = "minimax")
MINIMAX_API_KEY=your_minimax_api_key_here          # MiniMax International (fallback)

# MiniMax endpoint (pi maps minimax-cn to MINIMAX_API_HOST/anthropic/v1/messages)
MINIMAX_API_HOST=https://api.minimaxi.com

# Optional - defaults to OpenCode API
OPENAI_BASE_URL=https://opencode.ai/zen/v1
OPENCODE_MODEL=mimo-v2.5-free

# Optional
PORT=13001
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
# ? CORRECT: Use cmd.exe /c with file redirection
Start-Process -FilePath "cmd.exe" `
  -ArgumentList "/c", "cd /d <project-dir> && python -m http.server 8000 > server.log 2>&1" `
  -WindowStyle Hidden

# ? WRONG: Python http.server outputs access logs to stdout continuously.
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


<claude-mem-context>
# Memory Context

# [dynflow] recent context, 2026-06-07 11:06pm GMT+8

Legend: 🎯session 🔴bugfix 🟣feature 🔄refactor ✅change 🔵discovery ⚖️decision 🚨security_alert 🔐security_note
Format: ID TIME TYPE TITLE
Fetch details: get_observations([IDs]) | Search: mem-search skill

Stats: 50 obs (23,295t read) | 0t work

### Jun 7, 2026
S172 Add project-level Playwright MCP server configuration to the dynflow project at E:\workspace\dynflow (Jun 7, 8:55 PM)
S173 Configure Playwright MCP server in dynflow project to use E:\workspace\dynflow\.browser-profile-qa as the persistent Chrome user data directory for QA testing (Jun 7, 9:01 PM)
642 9:15p ✅ Browser profile directory configured for QA testing
643 " 🔵 Playwright MCP server configuration discovered in dynflow
644 9:16p ✅ Playwright MCP configured to use QA browser profile directory
S174 User greeted in Chinese with "你好" (Hello) - initial session opening (Jun 7, 9:16 PM)
S175 User clarified identity - they are Codex, a GPT-5 based coding agent running in Codex desktop app, working on the `dynflow` project (Jun 7, 9:41 PM)
S176 User reaffirmed identity as Codex (GPT-5 based coding agent in Codex desktop app) - second identity confirmation (Jun 7, 9:41 PM)
S177 Codex provided instructions for starting the dev server - backend (packages/server on port 3001) and frontend (packages/web on port 5173) (Jun 7, 9:42 PM)
S180 Codex completed port migration in dynflow (server 3001→13001, web 5173→15173) and asked whether to update remaining documentation references (Jun 7, 9:44 PM)
647 9:45p 🔵 dynflow monorepo structure mapped via package.json search
648 9:46p 🔵 dynflow root config inspected: monorepo with workspaces, aggregate dev script, and .env port config
650 9:47p 🔵 dynflow server entrypoint and Vite proxy config traced: server on 3001, web on 5173 with /api proxy
652 9:48p 🔵 Port references in dynflow: 3001 in server/app and tests, 5173 in vite config, documented in AGENTS.md and README
653 9:49p 🔵 Port 3001 is only hardcoded in index.ts fallback; app.test.ts/app.ts references are from earlier Select-String output (likely false positives from rg scope)
654 " 🔵 dynflow CORS allowlist: app.ts:21 hardcodes localhost:5173 and 127.0.0.1:5173, env var DYNFLOW_CORS_ORIGINS for overrides
655 9:50p 🔵 dynflow server app.ts API surface: 11 routers mounted under /api, CORS allowlist configurable via DYNFLOW_CORS_ORIGINS
656 " 🔵 .env.example finally readable via `type` command: 8 lines documenting OpenCode/OpenAI config, PORT=3001, HOST=127.0.0.1, DB_PATH
657 9:51p ✅ dynflow port changed from 3001 to 13001 in both .env and .env.example
658 9:52p ✅ dynflow ports migrated 3001→13001 (server) and 5173→15173 (web) across all 5 files
660 9:53p ✅ dynflow server app.test.ts passes 9/9 tests after port migration to 13001/15173
661 " ✅ dynflow TypeScript build passes (npx tsc -b) after port migration
S184 User said "都改了" (change all) in response to Codex's question about whether to also update remaining documentation port references (3001/5173) in dynflow after the initial 5-file migration. (Jun 7, 9:55 PM)
664 10:01p 🔵 dynflow port migration follow-up: remaining 3001/5173 references located
665 10:02p 🔵 PowerShell gbk encoding OSError blocks Get-Content with Select-Object -Index on dynflow docs
666 10:03p 🔵 AGENTS.md line 438 PORT=3001 is in active env example block
667 10:04p 🔵 README.md and CONTRIBUTING.md port-reference lines confirmed (with intermittent ripgrep timeouts)
668 " 🔵 Get-Content -Raw | Set-Content in-place edits blocked by gbk OSError in dynflow port migration
669 10:05p ✅ packages/server/src/index.ts fallback port 3001→13001 confirmed migrated
672 10:06p ✅ CONTRIBUTING.md 3001→13001 edit landed; verification ripgrep times out on gbk
673 " ✅ CONTRIBUTING.md port references fully migrated to 13001/15173
674 10:07p ✅ README.md URL port references 3001/5173 swapped to 13001/15173
677 " ✅ README.md CORS allowlist doc migrated; PORT=3001 edit blocked by gbk regex-Escape timeout
679 10:10p 🔵 README.md state confirmed: 3/4 port refs migrated, PORT=3001 line 132 still pending
682 " ✅ README.md CORS allowlist comment migrated; PORT=3001 on line 132 last remaining
684 10:11p 🔵 Plain-string PORT=3001 substitution in README.md times out on gbk; edit did not land
686 10:12p ✅ README.md fully port-migrated; AGENTS.md backend port 3001→13001 edit landed
688 10:13p ✅ AGENTS.md line 11 Backend port description migrated to 13001
690 10:14p ✅ AGENTS.md line 554 historical log entry restored to original 'Port 3001' wording
691 " ✅ AGENTS.md three more active port refs migrated: Frontend port, dev:server and dev:web comments
692 10:15p ✅ AGENTS.md port migration complete: all 6 active doc lines now show 13001/15173
693 10:16p ✅ dynflow port migration 3001→13001/5173→15173 fully complete and verified
694 10:17p 🔵 Historical log lines 540-569 in AGENTS.md preserved at original port wording
S188 Start frontend and backend dev services for the dynflow monorepo at E:\workspace\dynflow, then verify both are healthy. (Jun 7, 10:19 PM)
720 10:44p ✅ User requested starting frontend and backend services
721 10:45p ✅ Backend and frontend dev servers launched in background for dynflow monorepo
722 " 🔴 Backend listening on 13001, frontend failed: vite module missing in packages/web/node_modules
723 10:46p 🔵 Monorepo uses hoisted node_modules; web has only .bin stubs (vite.cmd/ps1) but no real vite package
725 " ✅ Frontend relaunched via hoisted root vite binary; subsequent shell calls hitting GBK encoding timeout
727 10:47p 🔴 Frontend dev server still failing: npm intercepted hoisted vite and re-resolved through packages/web/node_modules/vite
729 10:48p 🔴 Frontend dev server is up on [::1]:15173 (PID 30704) via direct node invocation of hoisted vite
730 10:49p 🔵 Backend healthy (HTTP 200), frontend serves on IPv6-only [::1]:15173 so IPv4 curl returns 000
733 11:00p 🔵 ultraqa skill loaded from Windows Codex skills directory
734 11:01p ⚖️ ULTRAQA cycle 1 plan created for dynflow project
735 11:02p 🔵 dynflow backend health and system info endpoints validated
736 " 🔵 ULTRAQA cycle 1 passed - all dynflow smoke tests green
S189 用户问候("你好")后,primary session 主动启动 ULTRAQA 模式对 dynflow 项目在端口 13001(后端)和 15173(前端)上的健康状态执行 QA 循环验证 (Jun 7, 11:03 PM)
737 11:04p ⚖️ ULTRAQA cycle 2 plan: deeper validation with tests, lint, typecheck, logs, E2E, SSE
738 11:05p 🔵 dynflow full test suite: 1191/1191 passed across 81 files
739 11:06p 🔵 ULTRAQA cycle 2 lint step clean across all .ts/.tsx files
</claude-mem-context>