# Codex for Open Source Application Notes

Official form: https://openai.com/form/codex-for-oss/

## Repository URL

https://github.com/wzrazsh/dynflow

## Maintainer Role

Primary maintainer.

## Why This Repository Qualifies

DynFlow is an open-source multi-agent workflow orchestration system for
building, running, and monitoring AI agent workflows. It provides a
TypeScript/Express backend, React UI, SQLite persistence, a QuickJS-based
dynamic script engine (with auto-migration for legacy isolated-vm
scripts), seven agent runners (Cua, Cua-Pi, Pi-Cua-Native, Pi-Direct,
Windows Native, Pi AppContainer, legacy Docker) covering Windows /
Linux / macOS hosts with and without Docker, SSE streaming, and
tested APIs. I am the primary maintainer responsible for
development, releases, review, issue triage, and keeping security
and test quality high.

## API Credit Usage

I would use API credits to dogfood Codex inside DynFlow: automate workflow
generation, review pull requests, test multi-agent orchestration flows, improve
release automation, and validate agent execution against real coding and
maintenance workloads. The credits would directly support open-source
maintenance and help make DynFlow a stronger reference project for AI agent
DynFlow is early-stage, actively maintained open source infrastructure for
agentic development workflows. The project already includes a monorepo
architecture, dynamic workflow runtime with durable step replay, Win32
sandboxing (Restricted Token + Job Object via Koffi FFI) on Windows
hosts, a Windows AppContainer-profile runner, Docker agent runners
(Cua + legacy OpenAI-only), an LLM-agnostic provider model with
OpenCode / OpenAI / minimax / Anthropic adapters, an orchestrator for
LLM-powered workflow design, registries for reusable agents and skills,
a project scanner that auto-discovers agent and skill definitions, and
hundreds of unit and integration tests across the monorepo.
