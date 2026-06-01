# Security Policy

DynFlow executes user-authored workflow definitions and agent workloads. Please
report security issues privately so they can be triaged before public disclosure.

## Supported Versions

Security fixes target the current `main` branch until the project starts
publishing versioned releases.

## Reporting a Vulnerability

Email the maintainer or open a private security advisory on GitHub when
available. Include:

- Affected commit or version.
- Reproduction steps or proof of concept.
- Expected impact.
- Any relevant logs, payloads, or environment details.

Please do not publish exploit details until a fix or mitigation is available.

## Security Boundaries

- Workflow scripts must not receive direct access to `fs`, `process`, imports,
  or network primitives.
- Agent execution should remain isolated from the host through Docker or an
  equivalent sandbox.
- Credentials must be provided through environment variables and must never be
  committed.
