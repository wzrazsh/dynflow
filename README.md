# DynFlow

DynFlow is an open-source multi-agent workflow orchestration system for
designing, running, and monitoring AI agent workflows from a local web UI.

It is built as a TypeScript monorepo with an Express backend, a React/Vite
frontend, SQLite persistence, sandboxed workflow definitions, Docker-based
agent execution, and Server-Sent Events for live runtime updates.

## Why DynFlow Exists

AI agent development often starts as scripts and prompt fragments. DynFlow turns
those scripts into observable workflows with explicit phases, parallel agents,
state transitions, persisted run history, and testable API boundaries.

The project is intended for developers experimenting with agent teams,
maintainer automation, workflow templates, and local-first orchestration.

## Features

- JavaScript workflow scripts with `phase()` and `agent()` declarations.
- Modern QuickJS-based dynamic script engine: `workflow()` / `phase()` /
  `agent()` / `parallel()` / `checkpoint()` / `apply()` / `log()` plus
  native JS loops (`for`, `while`, `for…of`, recursion).
- Sandboxed workflow parsing through `isolated-vm` (legacy) with a
  fallback pattern parser; legacy scripts auto-migrate to the dynamic
  DSL on creation.
- Workflow validation with shared Zod schemas.
- Sequential phase execution with parallel agents inside each phase.
- Pause, resume, stop, fail, and restart-aware workflow states.
- SQLite persistence with WAL mode.
- Cua-sandboxed Pi agent: each workflow run gets a per-workflow shared
  workspace (git-cloned or local path) mounted into a Cua Linux desktop
  container; Pi runs as a CLI process inside the container and exchanges
  JSONL events with the DynFlow server.
- Windows-native sandboxed Pi agent (Restricted Token + Job Object via
  Koffi FFI) and an opt-in Windows AppContainer profile runner.
  Auto-selected on Windows when Docker is unavailable.
- OpenAI-compatible legacy Docker agent runner is still available behind
  `DYNFLOW_RUNNER=docker` for fallback.
- LLM provider support: `opencode` (default), `openai`, `minimax`
  (OpenAI-compatible proxy), `anthropic`. Per-run override via the
  Runtime Environment form.
- Real-time workflow events over SSE.
- React UI for creating workflows, browsing runs, templates, agents, and skills.
- Meta-workflow APIs for scanning GitHub projects and registering discovered
  agents or skills.
## Architecture

```text
packages/
|-- shared/     TypeScript types and validation schemas (including PROVIDER_INFO / RUNNER_INFO)
|-- server/     Express API, QuickJS dynamic script engine, isolated-vm legacy parser,
|               workflow runtime, SQLite repository, SSE, Windows sandbox (Koffi FFI)
|-- web/        React + Vite single-page app
|-- agent/      Legacy: container entrypoint for OpenAI-only Docker agent
`-- cua-agent/  Cua + Pi Docker image (built from trycua/cua-xfce + @earendil-works/pi-coding-agent)
```

Runtime flow:

```text
workflow script (modern DSL or legacy phase/agent form)
  -> legacy: isolated-vm parser -> auto-migrated to dynamic form
  -> dynamic: QuickJS engine validates, then executes
  -> durable step store (every phase/agent/checkpoint/apply/log has a stable key)
  -> runner dispatch (auto-select chain: cua -> cua-pi -> windows-native -> pi-appcontainer -> docker)
     -> CuaAgentRunner      : docker run dynflow-cua-pi:latest + docker exec pi --mode json
     -> CuaPiRunner         : host pi CLI + Cua Computer Server (HTTP :8000)
     -> PiCuaNativeRunner   : in-process runAgentLoop from @earendil-works/pi-agent-core
     -> PiDirectRunner      : host pi CLI, no sandbox (opt-in)
     -> WindowsNativeRunner : Win32 Restricted Token + Job Object via Koffi FFI
     -> PiAppContainerRunner: per-run AppContainer profile (userenv.dll) + same restricted-token sandbox
     -> DockerAgentRunner   : legacy OpenAI-only Docker agent
  -> SSE progress events -> web UI
```

## Requirements

- Node.js 22 or newer
- npm
- Docker (optional - Windows Native Runner available for local execution)

## Quick Start

```bash
npm install
npm run build
npm test
```

Start the development servers:

```bash
npm run dev:server
npm run dev:web
```

The backend defaults to `http://localhost:13001` and the frontend defaults to
`http://localhost:15173`.

## Example Workflow

```js
workflow("release-check", () => {
  phase("review", () => {
    agent("test-engineer", "Find missing regression coverage");
    agent("security-reviewer", "Review trust boundaries and secrets handling");
  });

  phase("fix", () => {
    agent("executor", "Apply the smallest safe fixes from review");
  });
});
```

Copy `.env.example` to `.env` and set credentials for agent execution.
Available provider keys (resolution priority: `OPENCODE` > `OPENAI` > `MINIMAX_CN` > `MINIMAX` > `ANTHROPIC`):

```env
# Provider API keys
OPENCODE_API_KEY=your_opencode_api_key_here
OPENAI_API_KEY=your_openai_api_key_here
MINIMAX_CN_API_KEY=your_minimax_cn_api_key_here     # MiniMax China (used when UI provider = "minimax")
MINIMAX_API_KEY=your_minimax_api_key_here            # MiniMax International (fallback)
ANTHROPIC_API_KEY=your_anthropic_api_key_here

# MiniMax Anthropic-compatible endpoint (used by pi's minimax-cn provider)
MINIMAX_API_HOST=https://api.minimaxi.com

# Provider base URL override (used by opencode / openai / minimax proxies)
OPENAI_BASE_URL=https://opencode.ai/zen/v1

# Runner selection (default: cua, auto-selected on Windows)
DYNFLOW_RUNNER=cua

# Cua image (when DYNFLOW_RUNNER=cua)
DYNFLOW_CUA_IMAGE=dynflow-cua-pi:latest

# Pi binary / provider / model overrides
DYNFLOW_PI_BINARY=pi
DYNFLOW_PI_PROVIDER=opencode
DYNFLOW_PI_MODEL=mimo-v2.5-free

# Cua Computer Server (cua-pi and pi-cua-native runners)
DYNFLOW_CUA_SERVER_URL=http://localhost:8000
DYNFLOW_CUA_AUTOSTART=true
DYNFLOW_PYTHON=python

# Windows Native Sandbox
DYNFLOW_WIN_SANDBOX_STRICT=0

# Server
HOST=127.0.0.1
PORT=13001
DYNFLOW_CORS_ORIGINS=
DB_PATH=./data/workflows.db
```

### Provider notes

- `opencode` uses `OPENCODE_API_KEY` + `OPENAI_BASE_URL`.
- `openai` uses `OPENAI_API_KEY` + `OPENAI_BASE_URL`.
- `minimax` (UI) maps to pi's `minimax-cn` internally. Runner passes `--provider minimax-cn` to pi, which sends anthropic-format requests to `MINIMAX_API_HOST/anthropic/v1/messages`. Requires `MINIMAX_CN_API_KEY`.
- `anthropic` uses `ANTHROPIC_API_KEY`.

### Windows Native Runner

When Docker is not available, Windows hosts can use the built-in
Windows Native Runner (auto-selected or opt-in via `DYNFLOW_RUNNER=windows-native`).
It provides two isolation modes:

- **Light mode** (default, no admin required): duplicates the server's
  primary token, applies Job Object memory limits (`PROCESS_MEMORY`),
  and enables `KILL_ON_JOB_CLOSE` for process tree cleanup. No
  filesystem isolation.
- **Strict mode** (`DYNFLOW_WIN_SANDBOX_STRICT=1`, requires admin):
  uses `CreateRestrictedToken` to drop privileges and applies a DACL
  on the workspace directory for filesystem sandboxing.

>The Windows Native Runner (and the `pi-appcontainer` runner) both launch
>the local `pi` CLI. On Windows hosts where neither is on `PATH`, install
>it once with:
>
>```powershell
>npm install -g @earendil-works/pi-coding-agent
>```
>
>Then verify with `where pi` — `WindowsNativeRunner.isAvailable()` reports
>`true` and the runner will find the binary at process launch time.
>
>An opt-in **Pi AppContainer runner** is also available
>(`DYNFLOW_RUNNER=pi-appcontainer`). It allocates a per-run Windows
>AppContainer profile (per-run SID + per-run folder) and disposes it on
>cleanup. The actual process boundary is the same restricted-token
>sandbox; the AppContainer profile is a tracking + discoverability
>surface. See
>[`docs/sandbox/windows-native.md`](docs/sandbox/windows-native.md#pi-appcontainer-runner)
>for the full contract.

## Building the Cua image

```bash
cd packages/cua-agent
npm run build:image   # �?tagged as dynflow-cua-pi:latest
```

## Workspace support

A workflow can declare a `workspace` (host directory or git URL) that is
mounted into the Cua container at `/home/cua/workspace`. All agents in a
run share the same workspace; changes persist after the run completes.

```json
{
  "name": "release-check",
  "workspace": { "git": "https://github.com/foo/bar", "branch": "main" },
  "script": "workflow(...)"
}
```

## Development Commands

```bash
npm run build          # TypeScript build for all packages
npm test               # Run the full Vitest suite
npm run lint           # Run ESLint
```

## Project Status

DynFlow is early-stage open source software. The core runtime, API, sandbox,
agent registry, skill registry, project scanner, template system, and web UI are
covered by unit and integration tests, but APIs may still evolve before a stable
1.0 release.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md). Security issues should follow
[SECURITY.md](SECURITY.md).

## License

MIT. See [LICENSE](LICENSE).
