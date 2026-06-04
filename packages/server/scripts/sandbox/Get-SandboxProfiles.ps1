<#
.SYNOPSIS
    Lists sandbox profiles and indicates which have running processes.

.DESCRIPTION
    Reads the profile store at "%LOCALAPPDATA%\dynflow\sandbox-profiles.json"
    and prints one row per profile, with a "running" column showing how
    many processes appear to be associated with the profile's workspace.

    This script is read-only. It does NOT modify sandbox-profiles.json and
    it does NOT kill any processes. Use Remove-SandboxProfile.ps1 for that.

.PARAMETER ProfileName
    Optional filter. If supplied, only the matching profile is shown.

.PARAMETER Format
    Output format: JSON, Table (default), or CSV.

.OUTPUTS
    Whatever -Format asks for. JSON shape:
        {
          "count":  <int>,
          "profiles": [
            {
              "profileName":   "<name>",
              "workspacePath": "<path>",
              "mode":          "Light|Strict",
              "memoryLimitMB": <int>,
              "createdAt":     "<iso-8601>",
              "runningPids":   [ <int>, <int>, ... ]
            }
          ]
        }

.EXAMPLE
    pwsh -File Get-SandboxProfiles.ps1

    Prints a table of all profiles.

.EXAMPLE
    pwsh -File Get-SandboxProfiles.ps1 -ProfileName dynflow-123 -Format JSON

    Prints a single profile as JSON.

.NOTES
    Author : DynFlow
    Requires: Windows 10/11, PowerShell 5.1+
#>
[CmdletBinding()]
param(
    [Parameter(Mandatory = $false)]
    [string] $ProfileName,

    [Parameter(Mandatory = $false)]
    [ValidateSet('JSON', 'Table', 'CSV')]
    [string] $Format = 'Table'
)

$ErrorActionPreference = 'Stop'

function Get-ProfileStorePath {
    return (Join-Path (Join-Path $env:LOCALAPPDATA 'dynflow') 'sandbox-profiles.json')
}

function Read-ProfileStore {
    param([Parameter(Mandatory = $true)] [string] $Path)
    if (-not (Test-Path -LiteralPath $Path)) {
        return [pscustomobject]@{ version = 1; profiles = @() }
    }
    $raw = [System.IO.File]::ReadAllText($Path, [System.Text.Encoding]::UTF8)
    if ([string]::IsNullOrWhiteSpace($raw)) {
        return [pscustomobject]@{ version = 1; profiles = @() }
    }
    return ($raw | ConvertFrom-Json)
}

function Get-RunningPidsForPath {
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

$profiles = @($store.profiles)
if (-not [string]::IsNullOrEmpty($ProfileName)) {
    $profiles = @($profiles | Where-Object { $_.profileName -eq $ProfileName })
}

# Decorate with running PID lists.
$rows = foreach ($p in $profiles) {
    $running = Get-RunningPidsForPath -WorkspacePath $p.workspacePath
    [pscustomobject]@{
        profileName    = $p.profileName
        workspacePath  = $p.workspacePath
        mode           = $p.mode
        memoryLimitMB  = [int]$p.memoryLimitMB
        createdAt      = $p.createdAt
        runningPids    = $running
        runningCount   = $running.Count
    }
}

switch ($Format) {
    'JSON' {
        $profileArr = @($rows)
        $obj = [ordered]@{
            count    = $profileArr.Count
            profiles = $profileArr
        }
        ($obj | ConvertTo-Json -Depth 8 -Compress)
    }
    'CSV' {
        $rows | Export-Csv -NoTypeInformation
    }
    default {
        # Table
        if ($rows.Count -eq 0) {
            if ([string]::IsNullOrEmpty($ProfileName)) {
                Write-Host "No sandbox profiles found at $storePath."
            } else {
                Write-Host "Profile '$ProfileName' not found."
            }
            return
        }
        $display = $rows | Select-Object profileName, mode, memoryLimitMB, runningCount, createdAt, workspacePath
        $display | Format-Table -AutoSize
    }
}
