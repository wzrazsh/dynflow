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
- Docker-isolated agent execution.
- OpenAI-compatible agent runner with configurable base URL and model.
- Real-time workflow events over SSE.
- React UI for creating workflows, browsing runs, templates, agents, and skills.
- Meta-workflow APIs for scanning GitHub projects and registering discovered
  agents or skills.

## Architecture

```text
packages/
|-- shared/   TypeScript types and validation schemas
|-- server/   Express API, workflow runtime, SQLite repository, SSE, sandbox
|-- web/      React + Vite single-page app
`-- agent/    Container entrypoint for executing one agent task
```

Runtime flow:

```text
workflow script -> sandbox parser -> validated definition -> SQLite run
  -> runtime phases -> Docker agent runner -> SSE progress events -> web UI
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
OPENCODE_API_KEY=your_opencode_api_key_here
OPENAI_BASE_URL=https://opencode.ai/zen/v1
OPENCODE_MODEL=mimo-v2.5-free
PORT=3001
DB_PATH=./data/workflows.db
```

`OPENAI_API_KEY` is also supported for compatibility, but `OPENCODE_API_KEY`
takes precedence.

## Development Commands

```bash
npm run build          # TypeScript build for all packages
npm test               # Run the full Vitest suite
npm run test:coverage  # Generate coverage
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
