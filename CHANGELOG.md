# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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
