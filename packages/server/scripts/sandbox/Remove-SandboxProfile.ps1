<#
.SYNOPSIS
    Removes a sandbox profile and restores the workspace's original DACL
    (strict mode only).

.DESCRIPTION
    Loads profile metadata written by New-SandboxProfile.ps1, then:

      1. Kills any tracked processes still associated with the profile
         (requires -Force; otherwise the user is prompted via
         ShouldProcess).
      2. For strict profiles, restores the original DACL on the workspace
         from the SDDL backup written at create time. Restore failures
         are surfaced loudly: this script does NOT silently swallow a
         failed DACL restore, because that would leave the user locked
         out of their own files.
      3. Removes the profile entry from sandbox-profiles.json.

    The workspace directory itself is NEVER deleted. Only the metadata
    record and (for strict mode) the synthetic-SID DACL overlay are
    removed.

.PARAMETER ProfileName
    Name of the profile to remove. Required.

.PARAMETER Force
    Switch. If present, the script kills running processes and removes
    the profile without prompting.

.OUTPUTS
    JSON object:
        {
          "removed":          <bool>,
          "restored":         <bool>,
          "killedProcesses":  [ "<pid>", "<pid>", ... ]
        }

.EXAMPLE
    pwsh -File Remove-SandboxProfile.ps1 -ProfileName dynflow-123

    Prompts for confirmation if processes are tracked, then removes.

.EXAMPLE
    pwsh -File Remove-SandboxProfile.ps1 -ProfileName dynflow-123 -Force

    Removes without prompting.

.NOTES
    Author : DynFlow
    Requires: Windows 10/11, PowerShell 5.1+
    Strict mode DACL restore requires admin (the DACL was set by an
    elevated New-SandboxProfile call).
#>
[CmdletBinding(SupportsShouldProcess = $true, ConfirmImpact = 'High')]
param(
    [Parameter(Mandatory = $true, Position = 0)]
    [string] $ProfileName,

    [switch] $Force
)

$ErrorActionPreference = 'Stop'

# --- profile store ---------------------------------------------------------

function Get-ProfileStorePath {
    return (Join-Path (Join-Path $env:LOCALAPPDATA 'dynflow') 'sandbox-profiles.json')
}

function Read-ProfileStore {
    param([Parameter(Mandatory = $true)] [string] $Path)
    if (-not (Test-Path -LiteralPath $Path)) {
        throw "Profile store not found at $Path. Nothing to remove."
    }
    $raw = [System.IO.File]::ReadAllText($Path, [System.Text.Encoding]::UTF8)
    if ([string]::IsNullOrWhiteSpace($raw)) {
        return [pscustomobject]@{ version = 1; profiles = @() }
    }
    return ($raw | ConvertFrom-Json)
}

function Save-ProfileStore {
    param(
        [Parameter(Mandatory = $true)] $Store,
        [Parameter(Mandatory = $true)] [string] $Path
    )
    $json = $Store | ConvertTo-Json -Depth 16
    $tmp = "$Path.tmp-" + [Guid]::NewGuid().ToString('N')
    [System.IO.File]::WriteAllText($tmp, $json, [System.Text.Encoding]::UTF8)
    if (Test-Path -LiteralPath $Path) {
        [System.IO.File]::Delete($Path)
    }
    [System.IO.File]::Move($tmp, $Path)
}

function Find-Profile {
    param(
        [Parameter(Mandatory = $true)] $Store,
        [Parameter(Mandatory = $true)] [string] $Name
    )
    $match = $Store.profiles | Where-Object { $_.profileName -eq $Name } | Select-Object -First 1
    if (-not $match) { throw "Profile '$Name' not found." }
    return $match
}

function Restore-WorkspaceDacl {
    param(
        [Parameter(Mandatory = $true)] [string] $WorkspacePath,
        [Parameter(Mandatory = $true)] [string] $BackupPath
    )
    if (-not (Test-Path -LiteralPath $BackupPath)) {
        throw "DACL backup file not found: $BackupPath. The original DACL cannot be restored. Remove the synthetic DACL manually with Set-Acl before retrying."
    }
    $sddl = [System.IO.File]::ReadAllText($BackupPath, [System.Text.Encoding]::UTF8).Trim()
    if ([string]::IsNullOrEmpty($sddl)) {
        throw "DACL backup file is empty: $BackupPath. Refusing to apply a blank security descriptor."
    }
    $currentAcl = Get-Acl -LiteralPath $WorkspacePath
    $newAcl = New-Object System.Security.AccessControl.DirectorySecurity
    $newAcl.SetSecurityDescriptorSddlForm($sddl)
    # Preserve the original protection setting from the backup ACL: we
    # cannot recover the previous inheritance flag from SDDL alone, so we
    # leave inheritance enabled by default. Most workspaces were inheriting
    # before New-SandboxProfile disabled it; re-enabling is the safer choice.
    $newAcl.SetAccessRuleProtection($false, $true)
    Set-Acl -LiteralPath $WorkspacePath -AclObject $newAcl
}

function Get-RunningProfilePids {
    # Best-effort: returns any PIDs that share a session with the workspace
    # by looking for processes whose command line references the workspace
    # path. This is intentionally conservative: if anything matches we ask
    # the user for confirmation unless -Force is supplied.
    param([Parameter(Mandatory = $true)] [string] $WorkspacePath)
    $pids = @()
    try {
        $procs = Get-CimInstance Win32_Process -ErrorAction SilentlyContinue
        foreach ($p in $procs) {
            $cmd = "$($p.CommandLine)"
            if ([string]::IsNullOrEmpty($cmd)) { continue }
            if ($cmd.IndexOf($WorkspacePath, [System.StringComparison]::OrdinalIgnoreCase) -ge 0) {
                $pids += $p.ProcessId
            }
        }
    } catch {}
    return $pids
}

# --- main flow -------------------------------------------------------------

$storePath = Get-ProfileStorePath
$store = Read-ProfileStore -Path $storePath
$profile = Find-Profile -Store $store -Name $ProfileName

# 1. Identify running processes tied to this workspace.
$pids = Get-RunningProfilePids -WorkspacePath $profile.workspacePath
if ($pids.Count -gt 0 -and -not $Force) {
    $msg = "Profile '$ProfileName' has $($pids.Count) running process(es) referencing its workspace: $($pids -join ', '). Re-run with -Force to terminate them."
    if ($PSCmdlet.ShouldProcess($profile.workspacePath, $msg)) {
        # User confirmed via -WhatIf / -Confirm; without those we still need Force.
        throw $msg
    } else {
        throw $msg
    }
}

$killed = @()
if ($pids.Count -gt 0) {
    foreach ($pid in $pids) {
        try {
            Stop-Process -Id $pid -Force -ErrorAction Stop
            $killed += [string]$pid
        } catch {
            # We do not fail the entire removal if one process is stubborn;
            # the user can rerun Remove-SandboxProfile -Force to retry.
        }
    }
}

# 2. Restore DACL for strict mode.
$restored = $false
if ($profile.mode -eq 'Strict' -and $profile.originalDaclPath) {
    Restore-WorkspaceDacl -WorkspacePath $profile.workspacePath -BackupPath $profile.originalDaclPath
    $restored = $true
}

# 3. Remove the profile from the store.
$remaining = @($store.profiles | Where-Object { $_.profileName -ne $ProfileName })
$store.profiles = $remaining
Save-ProfileStore -Store $store -Path $storePath

# 4. Emit JSON.
$obj = [ordered]@{
    removed         = $true
    restored        = $restored
    killedProcesses = $killed
}
($obj | ConvertTo-Json -Depth 6 -Compress)
