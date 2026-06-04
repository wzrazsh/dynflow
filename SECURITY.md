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

## Windows Native Sandbox

On Windows hosts, DynFlow can run the agent under a native Win32 sandbox
(Windows Native runner, opt-in via `DYNFLOW_RUNNER=windows-native`). This
sandbox uses the same Restricted Token + Job Object model that Chromium
and Edge use for renderer isolation. It is the recommended fallback when
Docker Desktop is unavailable on Windows.

### Security model

The Windows Native runner provides:

- **Process isolation** via `CreateRestrictedToken` with
  `WRITE_RESTRICTED` (light mode) or `WRITE_RESTRICTED` +
  `DISABLE_MAX_PRIVILEGE` + `SANDBOX_INERT` (strict mode). The
  sandboxed process cannot escalate privileges, impersonate the user,
  or use `SeDebugPrivilege`.
- **Filesystem isolation** via the `WRITE_RESTRICTED` token flag in
  light mode, and a custom DACL granting a per-workspace synthetic
  SID in strict mode. The original DACL is backed up so it can be
  restored on cleanup.
- **Process-tree termination** via `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE`.
  If the DynFlow server process dies, the kernel terminates the agent
  process and all of its children.
- **Per-process memory cap** (default 2 GB) via
  `JOB_OBJECT_LIMIT_PROCESS_MEMORY`.

### What is NOT protected

- **Network access.** The agent has full network access. The Windows
  Native runner does not implement Windows Filtering Platform (WFP)
  hooks, firewall rules, or proxy-based isolation. If network
  sandboxing is required, run the agent behind a corporate firewall
  or use Docker with `--network=none` plus a sidecar proxy.
- **GUI/desktop isolation.** The agent can create top-level windows
  unless `JOB_OBJECT_UILIMIT_*` flags are explicitly enabled. They are
  not enabled by default.
- **Persistence across runs.** Each workflow run allocates a fresh
  token and job object. There is no shared state between runs beyond
  the strict-mode DACL on the workspace.
- **Antivirus or Defender exclusions.** The runner does not modify
  Windows Defender or any antivirus configuration. The synthetic
  binaries produced by the agent are subject to normal AV scanning.
- **A privileged user.** A user with local admin can read the agent's
  memory and bypass the sandbox. Run the DynFlow server as a
  standard user; do not give the DynFlow service account admin.

### Threat model

| Threat | Mitigated? |
|---|---|
| Agent reads/modifies files outside the workspace | Yes in strict mode; partially in light mode (system paths are blocked, but `%TEMP%` and similar are accessible). |
| Agent spawns long-running processes that outlive the run | Yes, via `KILL_ON_JOB_CLOSE`. |
| Agent exhausts host memory | Yes, via the per-process memory cap. |
| Agent exfiltrates data over the network | No. Use a network policy. |
| Agent escalates to admin | Restricted Token drops most privileges, but a user that is already admin cannot be sandboxed. |
| DynFlow server crashes mid-run | Strict-mode DACLs are restored on the next profile cleanup or on runner startup. |

### Configuration and security implications

- `DYNFLOW_RUNNER=windows-native` — opt in to the Windows Native
  runner. The runner still uses Restricted Tokens and Job Objects
  in light mode; it is no less secure than the auto-select path.
- `DYNFLOW_WIN_SANDBOX_STRICT=1` — enable strict mode. Strict mode
  requires the DynFlow server to run elevated because applying a
  DACL is a privileged operation. Strict mode is more secure but
  less convenient.
- The companion PowerShell scripts at
  `packages/server/scripts/sandbox/` provide manual recovery and
  inspection. They never modify system directories and never delete
  the workspace itself; they only restore the original DACL from
  the backup written at profile-creation time.

For setup, runtime configuration, and troubleshooting, see
[`docs/sandbox/windows-native.md`](docs/sandbox/windows-native.md).

