# DynFlow

Web-based multi-agent workflow orchestration system inspired by Claude Code's Dynamic Workflows.

## Overview

DynFlow lets you define workflow scripts that orchestrate LLM-powered agents across sequential phases with parallel execution. Users write JavaScript workflow scripts declaring phases and agents, which are executed in isolated V8 sandboxes. The runtime extracts the orchestration plan and executes phases sequentially with parallel agents.

## Architecture

```
┌─────────────────┐     HTTP/SSE      ┌──────────────────────────┐
│  React SPA      │◄─────────────────►│  Express API Server      │
│  (Vite :5173)   │                   │  (:3001)                 │
│                 │                   │                          │
│ ┌─────────────┐ │                   │ ┌──────────────────────┐ │
│ │ WorkflowList│ │                   │ │ POST /api/workflows  │ │
│ │ CreateForm  │ │                   │ │ (JS script → sandbox)│ │
│ │ DetailView  │ │                   │ │ GET/POST controls    │ │
│ │ SSE Hook    │ │                   │ │ GET /stream (SSE)    │ │
│ └─────────────┘ │                   │ └──────────┬───────────┘ │
└─────────────────┘                   └────────────┼─────────────┘
                                                   │
                         ┌─────────────────────────┼──────────────┐
                         │                         │              │
                         ▼                         ▼              ▼
                  ┌─────────────┐    ┌──────────────────┐  ┌──────────┐
                  │ isolated-vm │    │ WorkflowRuntime  │  │ SQLite   │
                  │ Sandbox     │    │ (phase→agent)    │  │ (WAL)    │
                  │ (extracts   │    │                  │  │          │
                  │  definition)│    │ PhaseExecutor    │  │ better-  │
                  └─────────────┘    │ (parallel 16max) │  │ sqlite3  │
                                     │        │         │  └──────────┘
                                     │ AgentRunner      │
                                     │ (fetch OpenAI)   │
                                     └────────┬─────────┘
                                              │
                                     ┌────────▼─────────┐
                                     │ OpenAI GPT API   │
                                     │ (text-in/text-out)│
                                     └──────────────────┘
```

## Features

- **JS Workflow Scripts**: Write workflow definitions using `phase()` and `agent()` API
- **Isolated Sandbox**: Scripts execute in isolated-vm V8 isolates (or fallback parser)
- **Sequential Phases**: Phases execute one after another
- **Parallel Agents**: Agents within a phase run concurrently (up to 16)
- **Real-time Progress**: SSE streaming for live dashboard updates
- **Workflow Controls**: Start, pause, resume, stop workflows
- **SQLite Persistence**: All workflow state stored in SQLite with WAL mode
- **Error Handling**: Retry logic, timeout enforcement, graceful degradation

## Quick Start

```bash
# Install dependencies
npm install

# Start backend server (port 3001)
npm run dev:server

# Start frontend (port 5173, proxies to :3001)
npm run dev:web

# Run tests
npm run test        # 236+ tests

# Build
npm run build       # TypeScript compilation
```

## Workflow Script Format

Users write JavaScript workflow scripts using the `phase()` and `agent()` API:

```javascript
phase("Research", () => {
  agent("researcher-1", "Research quantum computing impact on cryptography");
  agent("researcher-2", "Research post-quantum cryptography standards");
});

phase("Synthesis", () => {
  agent("synthesizer", "Synthesize findings from the research phase");
});
```

### API

- `phase(name: string, callback: () => void)` - Define a workflow phase
- `agent(name: string, prompt: string)` - Define an agent within the current phase

### Limits

- Max 50 phases per workflow
- Max 1000 agents per workflow
- Max 100 agents per phase
- Max 16 concurrent agents

## Project Structure

```
packages/
├── shared/          # TypeScript types, zod schema, validation
├── server/          # Express API, sandbox, runner, SQLite, SSE
├── web/             # React SPA dashboard
└── agent/           # Docker agent image (node:22-alpine)
```

### Key Modules

| Module | Description |
|--------|-------------|
| `server/src/sandbox/` | JS script execution with isolated-vm + fallback parser |
| `server/src/workflow/` | State machine, phase executor, runtime orchestrator |
| `server/src/runner/` | Agent runner interface + OpenAI API implementation |
| `server/src/db/` | SQLite connection, schema, repository |
| `server/src/sse/` | Stream manager, event factories |
| `server/src/api/` | Express routers for CRUD, control, SSE |

## API Endpoints

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/api/health` | Health check |
| `POST` | `/api/workflows` | Create workflow from JS script |
| `GET` | `/api/workflows` | List workflows (paginated) |
| `GET` | `/api/workflows/:id` | Get workflow detail |
| `DELETE` | `/api/workflows/:id` | Delete workflow (terminal states only) |
| `POST` | `/api/workflows/:id/start` | Start pending workflow |
| `POST` | `/api/workflows/:id/pause` | Pause running workflow |
| `POST` | `/api/workflows/:id/resume` | Resume paused workflow |
| `POST` | `/api/workflows/:id/stop` | Stop running/paused workflow |
| `GET` | `/api/workflows/:id/stream` | SSE stream for real-time events |

## Configuration

| Environment Variable | Default | Description |
|---------------------|---------|-------------|
| `PORT` | 3001 | Server port |
| `DB_PATH` | `./data/workflows.db` | SQLite database path |
| `OPENCODE_API_KEY` | (required) | OpenCode API key for agent execution (preferred) |
| `OPENAI_API_KEY` | (optional) | Legacy API key, used if OPENCODE_API_KEY is not set |
| `OPENAI_BASE_URL` | `https://opencode.ai/zen/v1` | OpenAI-compatible API base URL |
| `OPENCODE_MODEL` | `mimo-v2.5-free` | Model to use for agent execution |

## Testing

```bash
# Run all tests
npm run test

# Run specific package tests
npx vitest run packages/server
npx vitest run packages/web
npx vitest run packages/shared

# Run with coverage
npm run test:coverage
```

## Tech Stack

- **Runtime**: Node.js 22+, TypeScript 5.9+
- **Frontend**: React 19, Vite 6
- **Backend**: Express 5, better-sqlite3
- **Testing**: Vitest 3.2
- **Build**: TypeScript compiler (tsc)

## License

MIT
