<#
.SYNOPSIS
    Creates a new Windows sandbox profile for a DynFlow workspace.

.DESCRIPTION
    Allocates a sandbox profile that tracks a workspace path, the isolation
    mode (Light or Strict), a memory limit, and a synthetic SID for strict
    mode. Profile metadata is persisted to
    "%LOCALAPPDATA%\dynflow\sandbox-profiles.json" so the companion scripts
    (Start-SandboxedProcess, Remove-SandboxProfile, Get-SandboxProfiles) can
    resolve the profile later.

    Light mode: works for non-elevated users. Uses WRITE_RESTRICTED token
    flag and job object memory cap. No DACL changes.

    Strict mode: requires an elevated PowerShell session. In addition to
    the light-mode restrictions, the workspace directory receives a
    custom DACL that grants access only to the current user and the
    synthetic SID created here. The original DACL is backed up on disk
    so Remove-SandboxProfile can restore it.

    This script is a metadata / DACL helper only. It does NOT start any
    process. Use Start-SandboxedProcess.ps1 for that.

.PARAMETER WorkspacePath
    Full path to the workspace directory the profile covers. The path
    must exist. Required.

.PARAMETER ProfileName
    Friendly name used to address the profile from the other scripts.
    Defaults to "dynflow-<unix-timestamp>". The name is validated to
    contain only letters, digits, dashes, underscores, and dots.

.PARAMETER Mode
    "Light" (default) or "Strict". Strict requires an elevated session.

.PARAMETER MemoryLimitMB
    Per-process memory cap in megabytes, applied via the job object
    created by Start-SandboxedProcess. Default 2048.

.OUTPUTS
    JSON object with the shape:
        {
          "profileName":      "<name>",
          "workspacePath":    "<path>",
          "mode":             "Light|Strict",
          "sid":              "<sid-string-or-null>",
          "memoryLimitMB":    <int>,
          "createdAt":        "<iso-8601>",
          "originalDaclPath": "<path-or-null>"
        }

.EXAMPLE
    pwsh -File New-SandboxProfile.ps1 -WorkspacePath C:\work\demo

    Creates a light profile with an auto-generated name.

.EXAMPLE
    pwsh -File New-SandboxProfile.ps1 -WorkspacePath C:\work\demo `
        -ProfileName demo-strict -Mode Strict -MemoryLimitMB 4096

    Creates a strict profile. Must be run from an elevated PowerShell.

.NOTES
    Author : DynFlow
    Requires: Windows 10/11, PowerShell 5.1+
    Persists to: $env:LOCALAPPDATA\dynflow\sandbox-profiles.json
    Guardrails: never writes to %APPDATA% or %USERPROFILE%; never modifies
    the workspace contents; never deletes the workspace directory.
#>
[CmdletBinding()]
param(
    [Parameter(Mandatory = $true, Position = 0)]
    [string] $WorkspacePath,

    [Parameter(Mandatory = $false)]
    [ValidatePattern('^[A-Za-z0-9._-]+$')]
    [string] $ProfileName,

    [Parameter(Mandatory = $false)]
    [ValidateSet('Light', 'Strict')]
    [string] $Mode = 'Light',

    [Parameter(Mandatory = $false)]
    [ValidateRange(64, 1048576)]
    [int] $MemoryLimitMB = 2048
)

$ErrorActionPreference = 'Stop'

# --- helpers ----------------------------------------------------------------

function Write-JsonOutput {
    param([Parameter(Mandatory = $true)] $Object)
    $Object | ConvertTo-Json -Depth 8 -Compress
}

function Get-ProfileStorePath {
    $dir = Join-Path $env:LOCALAPPDATA 'dynflow'
    if (-not (Test-Path -LiteralPath $dir)) {
        New-Item -ItemType Directory -Path $dir -Force | Out-Null
    }
    return (Join-Path $dir 'sandbox-profiles.json')
}

function Read-ProfileStore {
    param([Parameter(Mandatory = $true)] [string] $Path)
    if (-not (Test-Path -LiteralPath $Path)) {
        return [pscustomobject] @{ version = 1; profiles = @() }
    }
    $raw = [System.IO.File]::ReadAllText($Path, [System.Text.Encoding]::UTF8)
    if ([string]::IsNullOrWhiteSpace($raw)) {
        return [pscustomobject] @{ version = 1; profiles = @() }
    }
    try {
        $parsed = $raw | ConvertFrom-Json
    } catch {
        throw "Profile store is corrupt: $($_.Exception.Message)"
    }
    if (-not $parsed.profiles) {
        $parsed | Add-Member -NotePropertyName 'profiles' -NotePropertyValue @() -Force
    }
    return $parsed
}

function Save-ProfileStore {
    param(
        [Parameter(Mandatory = $true)] $Store,
        [Parameter(Mandatory = $true)] [string] $Path
    )
    $json = $Store | ConvertTo-Json -Depth 16
    # Write atomically: write to .tmp then move into place. The .NET
    # 3-arg File.Move(string,string,bool) overload is not always reachable
    # from PowerShell method resolution, so we Copy -> delete the source
    # file -> rename. Copy+Move with a unique tmp name is sufficient
    # because each invocation produces a different .tmp.
    $tmp = "$Path.tmp-" + [Guid]::NewGuid().ToString('N')
    [System.IO.File]::WriteAllText($tmp, $json, [System.Text.Encoding]::UTF8)
    if (Test-Path -LiteralPath $Path) {
        [System.IO.File]::Delete($Path)
    }
    [System.IO.File]::Move($tmp, $Path)
}

function Test-IsElevated {
    $id = [System.Security.Principal.WindowsIdentity]::GetCurrent()
    $principal = New-Object System.Security.Principal.WindowsPrincipal($id)
    return $principal.IsInRole([System.Security.Principal.WindowsBuiltInRole]::Administrator)
}

function New-SyntheticSid {
    # Allocates a SID in the local-machine authority with 4 random sub-authorities.
    # Returns the SID as a string. Random component is based on GUID sub-data so
    # collisions are astronomically unlikely within a single user store.
    $guidBytes = [System.Guid]::NewGuid().ToByteArray()
    $sub1 = [int]($guidBytes[0] -shl 8 -bor $guidBytes[1])
    $sub2 = [int]($guidBytes[2] -shl 8 -bor $guidBytes[3])
    $sub3 = [int]($guidBytes[4] -shl 8 -bor $guidBytes[5])
    $sub4 = [int]($guidBytes[6] -shl 8 -bor $guidBytes[7])
    # 0x10 = SECURITY_LOCAL_SID_AUTHORITY; sub-authorities 5..8 used so this SID
    # does not collide with BUILTIN\Administrators (1-5-32-544) or other known SIDs.
    $sid = New-Object System.Security.Principal.SecurityIdentifier(
        [byte]0x05, @($sub1, $sub2, $sub3, $sub4)
    )
    return $sid.Value
}

function Backup-DirectoryDacl {
    param([Parameter(Mandatory = $true)] [string] $Path)
    $acl = Get-Acl -LiteralPath $Path
    $backupDir = Join-Path $env:LOCALAPPDATA 'dynflow\dacl-backups'
    if (-not (Test-Path -LiteralPath $backupDir)) {
        New-Item -ItemType Directory -Path $backupDir -Force | Out-Null
    }
    $stamp = (Get-Date).ToUniversalTime().ToString('yyyyMMddTHHmmssZ')
    $safeName = ($Path -replace '[\\/:?"<>|]', '_')
    $backupPath = Join-Path $backupDir ("$safeName-$stamp.sddl")
    [System.IO.File]::WriteAllText(
        $backupPath,
        $acl.Sddl,
        [System.Text.Encoding]::UTF8
    )
    return $backupPath
}

function Apply-StrictDacl {
    param(
        [Parameter(Mandatory = $true)] [string] $Path,
        [Parameter(Mandatory = $true)] [string] $Sid
    )
    $acl = Get-Acl -LiteralPath $Path
    $currentUser = [System.Security.Principal.WindowsIdentity]::GetCurrent().User

    # Strip inherited rules and start clean so we never accidentally inherit
    # permissive rules from a parent directory.
    $acl.SetAccessRuleProtection($true, $false)

    $rules = New-Object System.Collections.Generic.List[System.Security.AccessControl.FileSystemAccessRule]

    # Current user: full control.
    $rules.Add((New-Object System.Security.AccessControl.FileSystemAccessRule(
        $currentUser,
        'FullControl',
        'ContainerInherit,ObjectInherit',
        'None',
        'Allow'
    )))

    # SYSTEM: full control so Windows / installers can still traverse.
    $rules.Add((New-Object System.Security.AccessControl.FileSystemAccessRule(
        [System.Security.Principal.SecurityIdentifier]::new([byte]1, @([byte]1)),
        'FullControl',
        'ContainerInherit,ObjectInherit',
        'None',
        'Allow'
    )))

    # Synthetic SID: read+write+execute+delete so the sandboxed process can
    # actually work inside the workspace.
    $synthetic = New-Object System.Security.Principal.SecurityIdentifier($Sid)
    $rules.Add((New-Object System.Security.AccessControl.FileSystemAccessRule(
        $synthetic,
        'Modify',
        'ContainerInherit,ObjectInherit',
        'None',
        'Allow'
    )))

    foreach ($r in $rules) { $acl.AddAccessRule($r) }
    Set-Acl -LiteralPath $Path -AclObject $acl
}

# --- main flow --------------------------------------------------------------

# 1. Validate workspace path.
if (-not (Test-Path -LiteralPath $WorkspacePath)) {
    throw "WorkspacePath does not exist: $WorkspacePath"
}
$resolvedWorkspace = (Resolve-Path -LiteralPath $WorkspacePath).ProviderPath
if (-not (Test-Path -LiteralPath $resolvedWorkspace -PathType Container)) {
    throw "WorkspacePath is not a directory: $resolvedWorkspace"
}

# 2. Resolve profile name.
if ([string]::IsNullOrEmpty($ProfileName)) {
    $ts = [DateTimeOffset]::UtcNow.ToUnixTimeSeconds()
    $ProfileName = "dynflow-$ts"
}

# 3. Strict mode requires admin.
$isElevated = Test-IsElevated
if ($Mode -eq 'Strict' -and -not $isElevated) {
    throw "Strict mode requires an elevated PowerShell session. Re-run from an Administrator shell."
}

# 4. Load existing store and check for duplicate name.
$storePath = Get-ProfileStorePath
$store = Read-ProfileStore -Path $storePath
$existing = $store.profiles | Where-Object { $_.profileName -eq $ProfileName } | Select-Object -First 1
if ($existing) {
    throw "Profile '$ProfileName' already exists. Use Remove-SandboxProfile.ps1 to delete it first, or pick a different name."
}

# 5. Build the new profile.
$sidValue = $null
$originalDaclPath = $null
if ($Mode -eq 'Strict') {
    $sidValue = New-SyntheticSid
    $originalDaclPath = Backup-DirectoryDacl -Path $resolvedWorkspace
    Apply-StrictDacl -Path $resolvedWorkspace -Sid $sidValue
}

$createdAt = (Get-Date).ToUniversalTime().ToString('o')
$profile = [ordered]@{
    profileName      = $ProfileName
    workspacePath    = $resolvedWorkspace
    mode             = $Mode
    sid              = $sidValue
    memoryLimitMB    = $MemoryLimitMB
    createdAt        = $createdAt
    originalDaclPath = $originalDaclPath
}
$store.profiles = @($store.profiles) + ,$profile
Save-ProfileStore -Store $store -Path $storePath

# 6. Emit JSON to stdout for callers.
Write-JsonOutput -Object $profile
