# Windows Native Runner

The `WindowsNativeRunner` is a Windows-only DynFlow agent runner that
sandboxes the `pi` agent process using native Win32 isolation
primitives — the same Restricted Token + Job Object model that
Chromium and Edge use for their renderer sandboxes. It is the
recommended fallback when Docker Desktop is unavailable on a Windows
host.

This page covers the user-facing configuration. For the operator-side
PowerShell scripts and recovery tools, see
[`packages/server/scripts/sandbox/README.md`](../../packages/server/scripts/sandbox/README.md).

## Quick Start

```bash
DYNFLOW_RUNNER=windows-native npm run dev
```

The runner is auto-selected on Windows when:

1. Docker is not running (or not installed), and
2. Koffi loads successfully (it ships preinstalled in
   `packages/server`).

To force the runner regardless of Docker availability, set:

```bash
DYNFLOW_RUNNER=windows-native
```

## Configuration

| Variable | Default | Effect |
|---|---|---|
| `DYNFLOW_RUNNER` | _(unset — auto)_ | Set to `windows-native` to force this runner. |
| `DYNFLOW_WIN_SANDBOX_STRICT` | `0` | Set to `1` to enable strict-mode DACL isolation. Requires an elevated server. |

### Light vs. Strict Mode

**Light mode** (default) is non-elevated. It applies:

- A restricted token with the `WRITE_RESTRICTED` flag, which limits
  write access to the user's profile and the workspace.
- A Job Object with `KILL_ON_JOB_CLOSE` so the entire process tree
  terminates if the runner's job handle closes.
- A per-process memory cap (default 2 GB, see
  `cua-pi-runner.ts` and `windows-native-runner.ts` for the value).

**Strict mode** adds:

- A synthetic SID generated per workspace, granted `Modify` access to
  the workspace only via a custom DACL.
- Inheritance disabled on the workspace, so the parent directory's
  permissive rules do not apply.
- The original DACL is backed up so it can be restored on cleanup.
- The sandboxed process runs with `DISABLE_MAX_PRIVILEGE` and
  `SANDBOX_INERT` token flags in addition to `WRITE_RESTRICTED`.

Strict mode requires the DynFlow server process to be running elevated
because applying a DACL is a privileged operation. If you start the
server from a non-elevated shell with `DYNFLOW_WIN_SANDBOX_STRICT=1`,
the runner reports `isAvailable: false` and falls back to light mode
or Docker (whichever is next in the auto-select chain).

## Security Model

The Windows Native sandbox is **process-level**, not container-level.
It provides:

- **Process isolation** via Restricted Token. The sandboxed process
  cannot escalate privileges, cannot impersonate the user, and has
  no `SeDebugPrivilege`.
- **Filesystem isolation** (light: `WRITE_RESTRICTED` only; strict:
  custom DACL on the workspace). The sandboxed process can read the
  Windows directory but cannot modify system files.
- **Process tree termination** via `KILL_ON_JOB_CLOSE`. If the
  DynFlow server dies, the agent process and all its children are
  killed by the kernel — no orphaned `node.exe` processes.
- **Memory cap** (default 2 GB per process). Configurable per-run via
  the `AgentRunConfig` and the PowerShell profile store.

It does **not** provide:

- **Network isolation.** The agent has full network access. Pi needs
  this for the LLM API call. If you need network sandboxing, run the
  agent behind a corporate firewall or use Docker with `--network=none`
  + a separate proxy sidecar.
- **GUI/desktop isolation.** The agent can create windows (e.g.,
  spawn a browser) unless you also enable
  `JOB_OBJECT_UILIMIT_*` flags. This is intentional for the Cua XFCE
  path but is not enabled by default in Windows Native mode.
- **Persistence across runs.** Each workflow run gets a fresh token
  and job object. There is no state shared between runs beyond the
  DACL on the workspace (strict mode).
- **Protection against a privileged user.** Anyone with admin can
  read the agent's memory. This is no worse than running any
  other user-space process.

### Threat Model

| Threat | Mitigated? |
|---|---|
| Agent code reads/modifies arbitrary files outside the workspace | **Yes** in strict mode (DACL); **partially** in light mode (`WRITE_RESTRICTED` blocks most system paths but not `%TEMP%` and similar). |
| Agent spawns a long-running process that outlives the run | **Yes** via `KILL_ON_JOB_CLOSE`. |
| Agent exhausts host memory | **Yes** via the per-process memory cap. |
| Agent exfiltrates data over the network | **No.** Use a network policy at the host or corporate firewall. |
| Agent escalates to admin | **No** (Restricted Token drops `SeDebugPrivilege` etc.), but if the user account is already admin the sandbox is moot. |
| DynFlow server crashes mid-run | DACL cleanup happens via `Remove-SandboxProfile.ps1` or on next strict-mode profile creation. The TypeScript `cleanup()` method also restores DACLs. |

## When to Use

| Use case | Recommended runner |
|---|---|
| Production multi-agent workflows on a Linux or macOS host | `cua` (default) — Docker container with full Linux userland. |
| Windows host with Docker Desktop installed and working | `cua` or `cua-pi` — same as Linux, runs in container. |
| Windows host without Docker (Hyper-V off, WSL2 off, containers feature off) | **`windows-native`** — native process sandbox. |
| Windows host with Cua Computer Server already running | `cua-pi` or `pi-cua-native` — uses the host `pi` against a Cua server. |
| Quick local development with maximum isolation guarantees | Docker, if available. Windows Native is a fallback. |

`windows-native` is a **fallback** for environments where the Docker
path is not viable. It is not a replacement for the full
container-based isolation. Choose it when:

- Docker is unavailable for licensing or technical reasons.
- You need a process to start in well under 2 seconds (Windows Native
  cold-start is ~300 ms vs. ~3-5 s for `docker exec`).
- The workflow does not require a full Linux userland.

## Performance

| Metric | Windows Native | Docker (`cua-pi`) |
|---|---|---|
| Cold-start latency | ~300 ms (process spawn + token copy) | 3-5 s (`docker exec` overhead) |
| Per-run overhead | ~50 ms (job assignment + DACL check) | ~200 ms (network IPC) |
| Memory overhead | 0 MB (no daemon) | ~150 MB (Docker engine) |
| Disk overhead | 0 MB | 1-2 GB (image cache) |

Windows Native is faster but only available on Windows. The
`WindowsNativeRunner.isAvailable()` check returns `false` on Linux
and macOS regardless of configuration.

## Limitations

- **`.cmd` shim resolution.** The `pi` CLI on Windows is a `.cmd` shim
  that ultimately runs `node dist/cli.js`. The runner detects this and
  invokes `node` directly with the underlying JavaScript path, so
  `CreateProcessAsUserW` can launch it.
- **No parent-job detection.** If the DynFlow server itself is
  running inside a Job Object (e.g., under `psexec`, a CI runner, or
  Windows Container mode), `AssignProcessToJobObject` will fail with
  `ERROR_ACCESS_DENIED`. The runner reports this as a clear
  `JobObjectError`. The fix is to run the server outside any
  job, or accept the failure and fall back to the next runner.
- **No streaming stdout.** Like the other DynFlow runners, output is
  buffered until the process exits. The TypeScript runner uses the
  existing `AgentRunConfig.streaming: false` path; per the plan
  guardrail, real-time streaming is out of scope.
- **Profile persistence.** The PowerShell script
  `New-SandboxProfile.ps1` records profiles to
  `%LOCALAPPDATA%\dynflow\sandbox-profiles.json` so operators can
  inspect them. The TypeScript runner does not read this file; it
  creates and destroys sandbox state inline per run.

## Troubleshooting

### `isAvailable()` returns `false`

The runner checks `process.platform === 'win32' && WindowsNativeRunner.isAvailable()`.
Common reasons for failure:

- **Koffi not installed.** Run `npm install` in `packages/server`.
  Koffi ships as a native module; verify it loads:
  ```powershell
  node -e "require('koffi'); console.log('koffi OK')"
  ```
- **Non-Windows platform.** The runner is a no-op on Linux/macOS.
- **Koffi struct size mismatch.** If your build environment has
  unusual struct alignment, `verifyStructSizes()` throws at runner
  init. The error message includes the expected and actual sizes.

### "ERROR_PRIVILEGE_NOT_HELD" (1314)

`CreateProcessAsUserW` requires `SeAssignPrimaryTokenPrivilege` and
`SeIncreaseQuotaPrivilege`. Standard users do not have these. The
TypeScript runner handles the error gracefully: in light mode it
attempts the call anyway, and the OS either grants or denies
depending on group policy. If you see this error in the server logs,
your user account or group policy is preventing the privilege
acquisition. Workarounds:

- Run the DynFlow server elevated.
- Or use `DYNFLOW_RUNNER=cua-pi` (which runs `pi` on the host, no
  token manipulation needed).

### "ERROR_ACCESS_DENIED" (5) on `AssignProcessToJobObject`

The server is already inside a Job Object. See "No parent-job
detection" above.

### The process completes but the workspace is empty

The runner writes the prompt to a file in the workspace before
launching, and parses the agent's output. If the workspace is empty
after a run, check:

1. The agent exited with a non-zero status. Look for `success: false`
   in the run record.
2. Strict mode is denying the agent write access. Re-run with
   `DYNFLOW_WIN_SANDBOX_STRICT=0` or run the server elevated.
3. The `pi` agent is failing during `resolvePiBinary` because `pi` is
   not on `PATH`. Install `@earendil-works/pi-coding-agent` via
   `npm install -g`.

## See Also

- [`packages/server/scripts/sandbox/README.md`](../../packages/server/scripts/sandbox/README.md) — Operator-side PowerShell tools for manual recovery.
- [`AGENTS.md`](../../AGENTS.md#agent-runners) — How the runners fit into the auto-select chain.
- [`SECURITY.md`](../../SECURITY.md) — Project security policy.
