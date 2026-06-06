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
- Sandboxed workflow parsing through `isolated-vm` with a fallback parser.
- Workflow validation with shared Zod schemas.
- Sequential phase execution with parallel agents inside each phase.
- Pause, resume, stop, fail, and restart-aware workflow states.
- SQLite persistence with WAL mode.
- Cua-sandboxed Pi agent: each workflow run gets a per-workflow shared
  workspace (git-cloned or local path) mounted into a Cua Linux desktop
  container; Pi runs as a CLI process inside the container and exchanges
  JSONL events with the DynFlow server.
- OpenAI-compatible legacy Docker agent runner is still available behind
  `DYNFLOW_RUNNER=docker` for fallback.
- Real-time workflow events over SSE.
- React UI for creating workflows, browsing runs, templates, agents, and skills.
- Meta-workflow APIs for scanning GitHub projects and registering discovered
  agents or skills.

## Architecture

```text
packages/
|-- shared/     TypeScript types and validation schemas
|-- server/     Express API, workflow runtime, SQLite repository, SSE, sandbox
|-- web/        React + Vite single-page app
|-- agent/      Legacy: container entrypoint for OpenAI-only Docker agent
`-- cua-agent/  Cua + Pi Docker image (built from trycua/cua-xfce + @earendil-works/pi-coding-agent)
```

Runtime flow:

```text
workflow script -> sandbox parser -> validated definition -> SQLite run
  -> runtime phases
    -> CuaAgentRunner (default)
       -> docker run dynflow-cua-pi:latest
       -> mount per-workflow workspace into /home/cua/workspace
       -> docker exec pi --mode json --no-session
       -> parse JSONL, scan workspace for files
  -> SSE progress events -> web UI
```

## Requirements

- Node.js 22 or newer
- npm
- Docker for agent execution

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

The backend defaults to `http://localhost:3001` and the frontend defaults to
`http://localhost:5173`.

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

## Environment

Copy `.env.example` to `.env` and set credentials for agent execution:

```env
# Provider API keys (priority: OPENCODE_API_KEY > OPENAI_API_KEY > ANTHROPIC_API_KEY)
OPENCODE_API_KEY=your_opencode_api_key_here
OPENAI_API_KEY=your_openai_api_key_here
ANTHROPIC_API_KEY=your_anthropic_api_key_here

# Provider base URL override (used by OpenCode / OpenAI compatible proxies)
OPENAI_BASE_URL=https://opencode.ai/zen/v1

# Runner selection (default: cua)
DYNFLOW_RUNNER=cua

# Cua image (when DYNFLOW_RUNNER=cua)
DYNFLOW_CUA_IMAGE=dynflow-cua-pi:latest

# Pi binary / provider / model overrides (cua-pi, pi-cua-native, pi-direct runners)
DYNFLOW_PI_BINARY=pi
DYNFLOW_PI_PROVIDER=opencode
DYNFLOW_PI_MODEL=mimo-v2.5-free

# Cua Computer Server (cua-pi and pi-cua-native runners)
DYNFLOW_CUA_SERVER_URL=http://localhost:8000
DYNFLOW_CUA_AUTOSTART=true
DYNFLOW_PYTHON=python

# Server
PORT=3001
DB_PATH=./data/workflows.db
```

`OPENAI_API_KEY` is the legacy fallback used by the OpenAI-only Docker agent
(set `DYNFLOW_RUNNER=docker`). The `cua`, `cua-pi`, `pi-cua-native`, and
`pi-direct` runners additionally consume `OPENCODE_API_KEY` and
`ANTHROPIC_API_KEY` and are configured through `DYNFLOW_PI_*` / `DYNFLOW_CUA_*`
variables above.

## Building the Cua image

```bash
cd packages/cua-agent
npm run build:image   # → tagged as dynflow-cua-pi:latest
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
