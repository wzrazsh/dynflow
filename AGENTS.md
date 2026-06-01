# AGENTS.md - DynFlow Development Guide

## Agent Identity

I am "Sisyphus" - a powerful AI agent with orchestration capabilities. When working on this codebase, I follow disciplined engineering practices and delegate to specialized subagents when appropriate.

## Codebase Overview

DynFlow is a web-based multi-agent workflow orchestration system with:

- **Backend**: Express + TypeScript server (port 3001)
- **Frontend**: React + Vite SPA (port 5173)
- **Database**: SQLite with WAL mode
- **Agent Execution**: Docker containers with OpenAI GPT integration
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

- Uses `fetch()` directly (no `openai` npm package)
- Supports configurable `OPENAI_BASE_URL` for proxies
- Timeout via AbortController
- Results captured from stdout JSON

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
│       ├── types.ts          # All shared TypeScript types
│       ├── schema.ts         # Zod validation schema
│       └── index.ts          # Barrel exports
├── server/
│   └── src/
│       ├── index.ts          # Server entry point
│       ├── app.ts            # Express app factory
│       ├── api/
│       │   ├── workflows.ts      # CRUD endpoints
│       │   ├── workflows-control.ts  # Start/pause/resume/stop
│       │   └── sse.ts           # SSE streaming endpoint
│       ├── sandbox/
│       │   ├── isolated-runtime.ts  # JS script execution
│       │   └── types.ts        # Sandbox types
│       ├── workflow/
│       │   ├── state-machine.ts    # Workflow FSM
│       │   ├── phase-executor.ts   # Parallel agent orchestration
│       │   └── runtime.ts         # Full workflow runtime
│       ├── runner/
│       │   ├── types.ts           # AgentRunner interface
│       │   └── docker-runner.ts   # OpenAI API implementation
│       ├── db/
│       │   ├── connection.ts      # SQLite connection + retry
│       │   ├── schema.ts          # Table creation
│       │   └── repository.ts      # CRUD operations
│       └── sse/
│           ├── stream-manager.ts  # SSE connection management
│           └── event-factory.ts   # Typed event creation
├── web/
│   └── src/
│       ├── App.tsx              # Main app with view routing
│       ├── main.tsx             # React entry point
│       ├── api/
│       │   ├── client.ts        # Fetch wrapper
│       │   └── workflows.ts     # Workflow API functions
│       ├── components/
│       │   ├── WorkflowList.tsx      # Workflow list view
│       │   ├── CreateWorkflowForm.tsx # Script editor
│       │   ├── WorkflowDetail.tsx    # Detail with drill-down
│       │   ├── StatusBadge.tsx       # Status indicator
│       │   └── ErrorBoundary.tsx     # Error handler
│       └── hooks/
│           └── useSSE.ts        # SSE custom hook
└── agent/
    └── src/
        ├── run.ts               # Agent execution script
        └── Dockerfile           # Docker image (node:22-alpine)
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

- Max 16 concurrent agents (configurable)
- Agent timeout: 5 minutes default
- Script timeout: 30 seconds
- Memory limit: 128MB per sandbox
- SQLite WAL mode for write performance
- SSE heartbeat every 15 seconds
