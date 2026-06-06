# DynFlow Windows Sandbox — PowerShell Ops Scripts

Operator-side scripts for managing Windows-native sandbox profiles used by
the `WindowsNativeRunner`. These scripts wrap the same Win32 APIs the
runner uses internally (Koffi → Restricted Token + Job Object) so you
can inspect, launch, and tear down profiles from an interactive
PowerShell session.

If you are using DynFlow to run workflows, you do not need to call these
scripts directly — the `WindowsNativeRunner` does the equivalent work
inline. These scripts exist for two reasons:

1. **Manual recovery** when the runner crashes mid-run and leaves
   strict-mode DACLs or job objects behind.
2. **Debugging and inspection** of running profiles and processes.

## Prerequisites

| Requirement | Notes |
|---|---|
| Windows 11 | Win32 Restricted Tokens and Job Objects are available on Windows 10+ but the runner is tested on Windows 11. |
| PowerShell 5.1+ | The scripts use `[CmdletBinding()]` and `Add-Type`; both are present in Windows PowerShell 5.1 (default on Windows 11) and PowerShell 7+. |
| Elevated PowerShell | **Required for strict mode.** Light mode runs in a non-elevated session; strict mode applies a custom DACL to the workspace which requires admin. |
| .NET Framework / .NET 5+ | Used for `System.IO.File`, `System.Security.AccessControl`, and the Win32 P/Invoke layer. Already present on all supported hosts. |

## Installation

No installation is required. The scripts live at
`packages/server/scripts/sandbox/` and are runnable directly.

If your execution policy blocks the scripts, run once per user:

```powershell
Set-ExecutionPolicy -Scope CurrentUser -ExecutionPolicy RemoteSigned
```

This allows locally-written scripts (unsigned `.ps1` files in this
folder) to execute while still requiring downloaded scripts to be
signed.

## Scripts

| Script | Purpose |
|---|---|
| `New-SandboxProfile.ps1` | Allocate a profile, store metadata, optionally apply strict-mode DACL. |
| `Start-SandboxedProcess.ps1` | Launch an executable under an existing profile's restricted token + job. |
| `Remove-SandboxProfile.ps1` | Tear down a profile, restore original DACL (strict mode only, no-op in light mode), optionally kill live processes. |
| `Get-SandboxProfiles.ps1` | List profiles and show which have running processes. |

Profile metadata is persisted to:

```
%LOCALAPPDATA%\dynflow\sandbox-profiles.json
```

DACL backups for strict mode are stored under:

```
%LOCALAPPDATA%\dynflow\dacl-backups\
```

## Usage Examples

### Create a light-mode profile (non-elevated)

```powershell
$ws = New-Item -ItemType Directory -Path C:\work\demo -Force
pwsh -File packages/server/scripts/sandbox/New-SandboxProfile.ps1 `
    -WorkspacePath $ws.FullName `
    -ProfileName demo-light `
    -Mode Light `
    -MemoryLimitMB 2048
```

Output (JSON):

```json
{
  "profileName": "demo-light",
  "workspacePath": "C:\\work\\demo",
  "mode": "Light",
  "sid": null,
  "memoryLimitMB": 2048,
  "createdAt": "2026-06-04T05:20:57Z",
  "originalDaclPath": null
}
```

### Create a strict-mode profile (elevated)

Open an **Administrator** PowerShell window and run:

```powershell
$ws = New-Item -ItemType Directory -Path C:\work\demo -Force
pwsh -File packages/server/scripts/sandbox/New-SandboxProfile.ps1 `
    -WorkspacePath $ws.FullName `
    -ProfileName demo-strict `
    -Mode Strict `
    -MemoryLimitMB 4096
```

In strict mode the script allocates a synthetic SID, applies a custom
DACL to the workspace granting the SID `Modify` access, and backs up the
original DACL. Without elevation the script fails with:

```
Strict mode requires an elevated PowerShell session.
```

### Launch a process under a profile

```powershell
$exe = (Get-Command node.exe).Source
pwsh -File packages/server/scripts/sandbox/Start-SandboxedProcess.ps1 `
    -ProfileName demo-light `
    -Executable $exe `
    -Arguments @('--version') `
    -TimeoutSeconds 30
```

Output (JSON):

```json
{"exitCode":0,"durationMs":312,"killed":false}
```

A long-running process killed by the timeout returns:

```json
{"exitCode":1,"durationMs":2003,"killed":true}
```

The script **does not** use `Start-Process`. It calls `CreateProcessAsUserW`
directly so the child runs under the restricted token and is bound to a
job object with `KILL_ON_JOB_CLOSE`.

### List profiles

Table format (default):

```powershell
pwsh -File packages/server/scripts/sandbox/Get-SandboxProfiles.ps1
```

```
profileName  mode  memoryLimitMB  runningCount  createdAt                 workspacePath
-----------  ----  -------------  ------------  ---------                 -------------
demo-light   Light          2048             0  2026-06-04T05:20:57Z      C:\work\demo
demo-strict  Strict         4096             1  2026-06-04T05:21:13Z      C:\work\demo
```

JSON format, filtered:

```powershell
pwsh -File packages/server/scripts/sandbox/Get-SandboxProfiles.ps1 `
    -ProfileName demo-strict -Format JSON
```

CSV format (for piping into other tools):

```powershell
pwsh -File packages/server/scripts/sandbox/Get-SandboxProfiles.ps1 -Format CSV
```

### Remove a profile

Without `-Force`, the script prompts via `ShouldProcess` if any
processes are still running. With `-Force`, it terminates the
processes and removes the profile without prompting.

```powershell
pwsh -File packages/server/scripts/sandbox/Remove-SandboxProfile.ps1 `
    -ProfileName demo-light
```

Strict-mode removal restores the original DACL from
`%LOCALAPPDATA%\dynflow\dacl-backups\`. If the backup is missing, the
script **refuses to remove the profile** and surfaces a clear error.
This is intentional: silently leaving a custom DACL in place would
lock the user out of their workspace.

## Common Workflows

### Inspect and clean up after a crashed run

```powershell
# See what's still around
pwsh -File packages/server/scripts/sandbox/Get-SandboxProfiles.ps1

# Kill any running child processes and remove (strict DACLs are restored)
pwsh -File packages/server/scripts/sandbox/Remove-SandboxProfile.ps1 `
    -ProfileName demo-strict -Force
```

### Migrate a workspace to strict mode

```powershell
# 1. Remove any existing profile
pwsh -File packages/server/scripts/sandbox/Remove-SandboxProfile.ps1 `
    -ProfileName demo -Force

# 2. Recreate in strict mode (elevated)
pwsh -File packages/server/scripts/sandbox/New-SandboxProfile.ps1 `
    -WorkspacePath C:\work\demo `
    -ProfileName demo `
    -Mode Strict
```

### Emergency: restore a locked workspace

If `Remove-SandboxProfile.ps1` cannot find its DACL backup, you can
recover manually by re-applying the system default DACL:

```powershell
$ws = "C:\work\demo"
$acl = Get-Acl $ws
# Reset to inherited defaults: remove all explicit rules
$acl.SetAccessRuleProtection($false, $true)
Set-Acl -Path $ws -AclObject $acl
```

## Troubleshooting

### "Strict mode requires an elevated PowerShell session"

The current window is not elevated. Right-click the PowerShell icon and
select **Run as administrator**, or run:

```powershell
Start-Process powershell -Verb RunAs
```

### "Win32 1314 (ERROR_PRIVILEGE_NOT_HELD)" from Start-SandboxedProcess

`CreateProcessAsUserW` requires `SeAssignPrimaryTokenPrivilege` and
`SeIncreaseQuotaPrivilege`. Standard users do not have these. For
operator use, run the script from an elevated session. The TypeScript
`WindowsNativeRunner` uses the same APIs and inherits the same
constraint.

### "Win32 203 (ERROR_ENVVAR_NOT_FOUND)" from Start-SandboxedProcess

The script builds the env block manually. A `203` here means the block
is malformed. File a bug; include the script invocation and the
contents of `%LOCALAPPDATA%\dynflow\sandbox-profiles.json`.

### "Win32 87 (ERROR_INVALID_PARAMETER)" from Start-SandboxedProcess

The job object could not accept the requested memory limit. The script
currently applies `KILL_ON_JOB_CLOSE` only and skips the per-process
memory cap due to a known struct-layout issue; see
`Start-SandboxedProcess.ps1` line 4 (script header NOTES) for details.

### Profile appears in the store but the workspace is gone

`New-SandboxProfile.ps1` does not create the workspace, only records
it. If the workspace is deleted out of band, `Get-SandboxProfiles.ps1`
will still list the profile. Use `Remove-SandboxProfile.ps1 -Force` to
clean up the metadata; it will skip the DACL restore if the path does
not exist.

### Running the scripts from Cygwin/Git Bash

Always invoke via `powershell.exe -File ...` or `pwsh -File ...`. The
forward-slash paths in the examples above assume you are in bash; the
script itself accepts Windows-style paths.

## Security Notes

- The profile store is JSON in the user's `%LOCALAPPDATA%`. It is
  readable only by the user. Do not share `sandbox-profiles.json`
  between users.
- DACL backups (strict mode only) contain the original SDDL of the
  workspace. They are world-readable only if the parent directory is.
  Default Windows permissions apply; no hardening is performed.
- The script's `Start-SandboxedProcess.ps1` rejects `bInheritHandles=true`
  in `STARTUPINFO`, so the child cannot access unrelated host handles.
  This is asserted in the code (the C# binding takes a `bool` for
  `bInheritHandles` which is always passed `$false`).
- The synthetic SID allocated for strict mode is in the local
  authority (SECURITY_LOCAL_SID_AUTHORITY) with 4 random sub-authorities
  derived from `Guid.NewGuid()`. Collisions within a single user store
  are astronomically unlikely.
- These scripts do not implement any network restrictions. The
  spawned process has full network access, consistent with the plan's
  "MUST NOT implement network restrictions" guardrail.
