# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added
- `minimax` LLM provider (id `minimax`, OpenAI-compatible). Reuses
  `OPENAI_API_KEY` and `OPENAI_BASE_URL`; model list:
  `MiniMax-M3`, `minimax-m2`. Surfaced in `/api/system/info` and the
  Start Run dialog whenever `OPENAI_API_KEY` is set.
- `pi-appcontainer` runner: Windows AppContainer profile isolation
  (`userenv.dll` `CreateAppContainerProfile` + per-run SID + per-run
  folder) layered on top of the existing Restricted-Token + Job-Object
  sandbox. Opt-in via `DYNFLOW_RUNNER=pi-appcontainer`. Caveat: the
  process-attribute path (`SECURITY_CAPABILITIES` + `STARTUPINFOEXW`)
  is a follow-on — today the profile is a tracking surface, the
  actual process boundary remains the restricted-token sandbox.
- Dynamic script engine: a QuickJS-based runner that accepts modern
  DSL scripts (`workflow("…", async () => { … })`) with `phase()`,
  `agent()`, `parallel(items, callback, { concurrency })`,
  `checkpoint()`, `apply()`, and `log()`. The user's callback is
  wrapped in `(async () => { … })()`, so native JavaScript loops
  (`for`, `while`, `for…of`, recursion) and array helpers are all
  available inside a phase. Legacy isolated-vm scripts
  (`phase('p1', () => { agent('a1', '…') })`) are auto-migrated to
  the dynamic form on workflow creation.
- Durable step store: every script step (phase, agent, checkpoint,
  apply, log) is recorded with a stable `stepKey` so the runtime can
  resume and re-execute a partially-completed workflow without
  re-running completed work.

### Changed
- Three Docker probes (`CuaAgentRunner.isAvailable`,
  `DockerAgentRunner.isAvailable`, `WslDockerAgentRunner.isAvailable`)
  now share a 3-second bounded `probeDockerAvailability` helper. A
  hung `docker info` no longer wedges `/api/system/info`.

## [0.3.0] - 2026-06-06

### Added
- Anthropic provider support via provider-aware API key resolver
- Startup recovery: orphan `running` workflows converted to `interrupted`
- `HOST` and `DYNFLOW_CORS_ORIGINS` environment variables
- `workflow_failed` SSE event with preserved phase/agent results

### Changed
- **BREAKING**: `openaiApiKey` renamed to `apiKey` across all runners
- Server defaults to binding on `127.0.0.1` (was all interfaces)
- CORS defaults to local Vite addresses only
- Workflows with phase errors now correctly marked as `failed` (was `completed`)

### Fixed
- Atomic state transitions prevent duplicate workflow starts
- Runtime lifecycle cleanup ensures `activeRuntimes` is always cleared
- Windows light mode documentation accurately reflects no filesystem isolation
- Docker is correctly documented as optional

### Removed
- `test:coverage` script (coverage tooling not yet configured)

## [0.2.0] - 2026-05-31

### Added
- Agent Picker component with hierarchical domain/source/role/agent selection
- Skill Picker component with search, source filter, and category filter
- Browse Agents and Browse Skills views in main UI
- POST /api/orchestrate endpoint for LLM-powered workflow design
- POST /api/meta/scan endpoint to clone and scan GitHub projects
- POST /api/meta/extract endpoint to extract agents/skills from scanned files
- POST /api/meta/register endpoint to register extracted agents/skills
- Orchestrator module with CandidateSelector and prompt builder
- Meta-workflow modules: scanner, extractor, registrar
- Agent and skill registries with hierarchical APIs
- Domain, source, agent, skill type definitions
- Workflow generator from orchestrator output
- Hook manager for lifecycle events
- SSE streaming for real-time workflow updates
- Workflow control endpoints (start, pause, resume, stop)
- Integration tests for multi-agent flows
- Comprehensive test suites for all packages

### Changed
- Agent executor now supports predefined agents with system prompts
- App.tsx updated with agent/skill picker views and navigation

### Fixed
- Agent runner tests updated to mock fetch instead of OpenAI SDK
- Predefined agent prompts resolved for workflow runs

## [0.1.0] - 2026-05-31

### Added
- Initial project setup with monorepo structure
- Express + TypeScript backend server
- React + Vite frontend SPA
- SQLite database with WAL mode
- Docker-based agent execution
- Sandbox execution with isolated-vm and fallback parser
- Basic workflow CRUD operations
- Workflow state machine (pending, running, paused, completed, failed)
- Phase executor with parallel agent orchestration
