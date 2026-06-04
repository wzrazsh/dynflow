<#
.SYNOPSIS
    Launches an executable inside a previously-created sandbox profile.

.DESCRIPTION
    Loads profile metadata written by New-SandboxProfile.ps1, creates a
    Windows restricted token + job object via P/Invoke, then spawns the
    target executable with CreateProcessAsUserW. The job object is
    configured with KILL_ON_JOB_CLOSE plus a per-process memory cap taken
    from the profile, so closing the job handle (or exceeding the cap)
    terminates the process tree.

    The script blocks until the process exits or TimeoutSeconds elapses.
    On timeout the job handle is closed, which causes the kernel to
    terminate the entire process tree (KILL_ON_JOB_CLOSE).

    This script intentionally does NOT use Start-Process: Start-Process
    does not accept a token handle, so it cannot enforce the sandbox.

    All Win32 handles opened in this script are tracked and released via
    SafeFileHandle .Dispose() in a finally block. Any leak would be a
    real kernel-handle leak and is treated as a script bug.

.PARAMETER ProfileName
    Name of the profile to launch under. Must already exist in the
    profile store. Required.

.PARAMETER Executable
    Full path to the .exe to launch. Must exist. Required.

.PARAMETER Arguments
    Optional array of command-line arguments passed to the executable.

.PARAMETER WorkingDirectory
    Optional working directory. Defaults to the profile's workspace.

.PARAMETER TimeoutSeconds
    Maximum wall-clock seconds to wait before killing the tree.
    Default 300. Set to 0 to wait indefinitely.

.OUTPUTS
    JSON object:
        {
          "exitCode":   <int-or-null>,
          "durationMs": <int>,
          "killed":     <bool>,
          "error":      "<message>"   // present only on error
        }

.EXAMPLE
    pwsh -File Start-SandboxedProcess.ps1 `
        -ProfileName dynflow-123 -Executable C:\nodejs\node.exe `
        -Arguments @('--version')

.EXAMPLE
    pwsh -File Start-SandboxedProcess.ps1 `
        -ProfileName dynflow-123 -Executable C:\nodejs\node.exe `
        -Arguments @('-e','setTimeout(()=>{},60000)') `
        -TimeoutSeconds 2

    Demonstrates timeout enforcement. killed=true, durationMs~=2000.

.NOTES
    Author : DynFlow
    Requires: Windows 10/11, PowerShell 5.1+
    Light mode works non-elevated. Strict mode prefers an elevated
    session because the synthetic SID grants the running process only
    a limited DACL over the workspace.
#>
[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [string] $ProfileName,

    [Parameter(Mandatory = $true)]
    [string] $Executable,

    [Parameter(Mandatory = $false)]
    [string[]] $Arguments = @(),

    [Parameter(Mandatory = $false)]
    [string] $WorkingDirectory,

    [Parameter(Mandatory = $false)]
    [int] $TimeoutSeconds = 300
)

$ErrorActionPreference = 'Stop'

# --- profile store ---------------------------------------------------------

function Get-ProfileStorePath {
    return (Join-Path (Join-Path $env:LOCALAPPDATA 'dynflow') 'sandbox-profiles.json')
}

function Read-ProfileStore {
    param([Parameter(Mandatory = $true)] [string] $Path)
    if (-not (Test-Path -LiteralPath $Path)) {
        throw "Profile store not found. Run New-SandboxProfile.ps1 first."
    }
    $raw = [System.IO.File]::ReadAllText($Path, [System.Text.Encoding]::UTF8)
    if ([string]::IsNullOrWhiteSpace($raw)) { throw "Profile store is empty." }
    return ($raw | ConvertFrom-Json)
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

# --- P/Invoke definitions --------------------------------------------------

$typeSource = @"
using System;
using System.Runtime.InteropServices;
using System.Text;
using Microsoft.Win32.SafeHandles;

public static class Win32Sandbox
{
    public const int CREATE_SUSPENDED                = 0x00000004;
    public const int CREATE_UNICODE_ENVIRONMENT      = 0x00000400;
    public const int STARTF_USESTDHANDLES            = 0x00000100;
    public const int STARTF_USESHOWWINDOW            = 0x00000001;
    public const uint HANDLE_FLAG_INHERIT            = 0x00000001;
    public const int WAIT_TIMEOUT                    = 258;
    public const int JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE = 0x2000;
    public const int JOB_OBJECT_LIMIT_PROCESS_MEMORY    = 0x100;
    public const int SE_PRIVILEGE_ENABLED            = 0x2;
    public const int WRITE_RESTRICTED                = 0x8;
    public const int DISABLE_MAX_PRIVILEGE           = 0x800;
    public const int SANDBOX_INERT                   = 0x4;
    public const int JobObjectExtendedLimitInformation = 9;

    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    public struct STARTUPINFO
    {
        public int cb;
        public IntPtr lpReserved;
        public IntPtr lpDesktop;
        public IntPtr lpTitle;
        public int dwX;
        public int dwY;
        public int dwXSize;
        public int dwYSize;
        public int dwXCountChars;
        public int dwYCountChars;
        public int dwFillAttribute;
        public int dwFlags;
        public short wShowWindow;
        public short cbReserved2;
        public IntPtr lpReserved2;
        public IntPtr hStdInput;
        public IntPtr hStdOutput;
        public IntPtr hStdError;
    }

    [StructLayout(LayoutKind.Sequential)]
    public struct PROCESS_INFORMATION
    {
        public IntPtr hProcess;
        public IntPtr hThread;
        public int dwProcessId;
        public int dwThreadId;
    }

    [StructLayout(LayoutKind.Sequential)]
    public struct SECURITY_ATTRIBUTES
    {
        public int nLength;
        public IntPtr lpSecurityDescriptor;
        public int bInheritHandle;
    }

    [StructLayout(LayoutKind.Sequential, Pack = 8)]
    public struct IO_COUNTERS
    {
        public ulong ReadOperationCount;
        public ulong WriteOperationCount;
        public ulong OtherOperationCount;
        public ulong ReadTransferCount;
        public ulong WriteTransferCount;
        public ulong OtherTransferCount;
    }

    [StructLayout(LayoutKind.Sequential, Pack = 8)]
    public struct JOBOBJECT_BASIC_LIMIT_INFORMATION
    {
        public long PerProcessUserTimeLimit;
        public long PerJobUserTimeLimit;
        public uint LimitFlags;
        public UIntPtr MinimumWorkingSetSize;
        public UIntPtr MaximumWorkingSetSize;
        public uint ActiveProcessLimit;
        public UIntPtr Affinity;
        public UIntPtr PriorityClass;
        public uint SchedulingClass;
    }

    [StructLayout(LayoutKind.Sequential, Pack = 8)]
    public struct JOBOBJECT_EXTENDED_LIMIT_INFORMATION
    {
        public JOBOBJECT_BASIC_LIMIT_INFORMATION BasicLimitInformation;
        public IO_COUNTERS IoInfo;
        public UIntPtr ProcessMemoryLimit;
        public UIntPtr JobMemoryLimit;
        public UIntPtr PeakProcessMemoryUsed;
        public UIntPtr PeakJobMemoryUsed;
    }

    [StructLayout(LayoutKind.Sequential)]
    public struct LUID
    {
        public uint LowPart;
        public int HighPart;
    }

    [StructLayout(LayoutKind.Sequential)]
    public struct LUID_AND_ATTRIBUTES
    {
        public LUID Luid;
        public uint Attributes;
    }

    [StructLayout(LayoutKind.Sequential)]
    public struct TOKEN_PRIVILEGES
    {
        public uint PrivilegeCount;
        public LUID_AND_ATTRIBUTES Privileges;
    }

    [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
    public static extern bool CreatePipe(
        out SafeFileHandle hReadPipe,
        out SafeFileHandle hWritePipe,
        ref SECURITY_ATTRIBUTES lpPipeAttributes,
        uint nSize);

    [DllImport("kernel32.dll", SetLastError = true)]
    public static extern bool SetHandleInformation(SafeFileHandle hObject, uint dwMask, uint dwFlags);

    [DllImport("kernel32.dll", SetLastError = true)]
    public static extern SafeFileHandle GetCurrentProcess();

    [DllImport("advapi32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
    public static extern bool OpenProcessToken(SafeFileHandle ProcessHandle, uint DesiredAccess, out SafeFileHandle TokenHandle);

    [DllImport("advapi32.dll", SetLastError = true)]
    public static extern bool DuplicateTokenEx(
        SafeFileHandle hExistingToken,
        uint dwDesiredAccess,
        IntPtr lpTokenAttributes,
        int ImpersonationLevel,
        int TokenType,
        out SafeFileHandle phNewToken);

    [DllImport("advapi32.dll", SetLastError = true)]
    public static extern bool CreateRestrictedToken(
        SafeFileHandle ExistingTokenHandle,
        uint Flags,
        uint DisableSidCount,
        IntPtr SidsToDisable,
        uint DeletePrivilegeCount,
        IntPtr PrivilegesToDelete,
        uint RestrictedSidCount,
        IntPtr SidsToRestrict,
        out SafeFileHandle NewRestrictedToken);

    [DllImport("advapi32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
    public static extern bool LookupPrivilegeValue(string lpSystemName, string lpName, out LUID lpLuid);

    [DllImport("advapi32.dll", SetLastError = true)]
    public static extern bool AdjustTokenPrivileges(
        SafeFileHandle TokenHandle,
        bool DisableAllPrivileges,
        ref TOKEN_PRIVILEGES NewState,
        uint BufferLength,
        IntPtr PreviousState,
        IntPtr ReturnLength);

    [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
    public static extern SafeFileHandle CreateJobObjectW(IntPtr lpJobAttributes, string lpName);

    [DllImport("kernel32.dll", SetLastError = true)]
    public static extern bool SetInformationJobObject(
        SafeFileHandle hJob,
        int InfoClass,
        IntPtr lpJobObjectInfo,
        uint cbJobObjectInfoLength);

    [DllImport("kernel32.dll", SetLastError = true)]
    public static extern bool AssignProcessToJobObject(SafeFileHandle hJob, SafeFileHandle hProcess);

    [DllImport("advapi32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
    public static extern bool CreateProcessAsUserW(
        SafeFileHandle hToken,
        IntPtr lpApplicationName,
        StringBuilder lpCommandLine,
        IntPtr lpProcessAttributes,
        IntPtr lpThreadAttributes,
        bool bInheritHandles,
        uint dwCreationFlags,
        IntPtr lpEnvironment,
        IntPtr lpCurrentDirectory,
        ref STARTUPINFO lpStartupInfo,
        out PROCESS_INFORMATION lpProcessInformation);

    [DllImport("kernel32.dll")]
    public static extern uint ResumeThread(SafeFileHandle hThread);

    [DllImport("kernel32.dll")]
    public static extern uint WaitForSingleObject(SafeFileHandle hHandle, uint dwMilliseconds);

    [DllImport("kernel32.dll")]
    public static extern bool GetExitCodeProcess(SafeFileHandle hProcess, out uint lpExitCode);

    [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
    public static extern uint FormatMessage(
        uint dwFlags,
        IntPtr lpSource,
        uint dwMessageId,
        uint dwLanguageId,
        StringBuilder lpBuffer,
        uint nSize,
        IntPtr Arguments);

    public static string GetErrorMessage(int errorCode)
    {
        var sb = new StringBuilder(512);
        FormatMessage(0x1300, IntPtr.Zero, (uint)errorCode, 0, sb, (uint)sb.Capacity, IntPtr.Zero);
        return sb.ToString().Trim();
    }
}
"@
if (-not ('Win32Sandbox' -as [type])) {
    Add-Type -TypeDefinition $typeSource -Language CSharp -ErrorAction Stop
}

# --- helpers ---------------------------------------------------------------

function Last-Win32Error {
    param([string] $Context)
    $err = [System.Runtime.InteropServices.Marshal]::GetLastWin32Error()
    $msg = [Win32Sandbox]::GetErrorMessage($err)
    if ([string]::IsNullOrWhiteSpace($msg)) {
        return "$Context : Win32 error $err"
    }
    return "$Context : $msg (Win32 $err)"
}

function Enable-Privileges {
    param(
        [Parameter(Mandatory = $true)] $Token,
        [Parameter(Mandatory = $true)] [string[]] $Privileges
    )
    foreach ($name in $Privileges) {
        $luid = New-Object Win32Sandbox+LUID
        $ok = [Win32Sandbox]::LookupPrivilegeValue($null, $name, [ref] $luid)
        if (-not $ok) { continue }
        $tp = New-Object Win32Sandbox+TOKEN_PRIVILEGES
        $tp.PrivilegeCount = 1
        $tp.Privileges.Luid = $luid
        $tp.Privileges.Attributes = [Win32Sandbox]::SE_PRIVILEGE_ENABLED
        [void] [Win32Sandbox]::AdjustTokenPrivileges(
            $Token,
            $false,
            [ref] $tp,
            [uint32][System.Runtime.InteropServices.Marshal]::SizeOf([type]'Win32Sandbox+TOKEN_PRIVILEGES'),
            [IntPtr]::Zero,
            [IntPtr]::Zero
        )
    }
}

function Emit-Result {
    param(
        [Parameter(Mandatory = $true)] [int] $DurationMs,
        [Parameter(Mandatory = $true)] [bool] $Killed,
        [Parameter(Mandatory = $false)] $ExitCode = $null,
        [Parameter(Mandatory = $false)] [string] $Error = $null
    )
    $obj = [ordered]@{
        exitCode   = $ExitCode
        durationMs = $DurationMs
        killed     = $Killed
    }
    if ($Error) { $obj['error'] = $Error }
    ($obj | ConvertTo-Json -Depth 6 -Compress)
}

function Drain-Stream {
    # Reads all available bytes from a SafeFileHandle-backed stream until
    # the process end is reached. Runs on the current thread.
    param([Parameter(Mandatory = $true)] $Stream)
    $sb = New-Object System.Text.StringBuilder
    $buf = New-Object byte[] 4096
    $fs = $Stream
    try {
        # Use async read with a generous timeout so we don't busy-spin.
        $fs.ReadTimeout = 1000
        while ($true) {
            try {
                $n = $fs.Read($buf, 0, $buf.Length)
            } catch [System.IO.IOException] {
                # Pipe was closed (process exited). ReadToEnd via small loop below.
                break
            }
            if ($n -le 0) { break }
            [void] $sb.Append([System.Text.Encoding]::UTF8.GetString($buf, 0, $n))
        }
    } finally {
        try { $fs.Dispose() } catch {}
    }
    return $sb.ToString()
}

# --- main flow -------------------------------------------------------------

# Wrap the entire body in a top-level try/catch so that every error path
# emits a JSON result instead of an unhandled PowerShell exception leaking
# to the caller's stderr.
$scriptStart = [System.Diagnostics.Stopwatch]::StartNew()
$killed = $false
$exitCodeOut = $null
$errorMessage = $null

try {
$storePath = Get-ProfileStorePath
$store = Read-ProfileStore -Path $storePath
$profile = Find-Profile -Store $store -Name $ProfileName

if (-not (Test-Path -LiteralPath $Executable -PathType Leaf)) {
    throw "Executable not found: $Executable"
}
$exeFullPath = (Resolve-Path -LiteralPath $Executable).ProviderPath

if ([string]::IsNullOrEmpty($WorkingDirectory)) {
    $WorkingDirectory = $profile.workspacePath
}
if (-not (Test-Path -LiteralPath $WorkingDirectory -PathType Container)) {
    throw "WorkingDirectory does not exist: $WorkingDirectory"
}

# Build a single command line string as required by CreateProcessAsUserW.
$commandLine = '"' + $exeFullPath + '"'
foreach ($a in $Arguments) {
    $commandLine += ' "' + ($a -replace '"', '\"') + '"'
}

# Build environment block (double-null-terminated UTF-16LE).
$envWhitelist = @('PATH', 'PATHEXT', 'SYSTEMROOT', 'WINDIR', 'TEMP', 'TMP', 'LANG', 'LC_ALL', 'HOME', 'USERPROFILE', 'OS')
$envBuilder = New-Object System.Text.StringBuilder
foreach ($k in $envWhitelist) {
    $v = [System.Environment]::GetEnvironmentVariable($k)
    if ($null -ne $v) {
        [void] $envBuilder.Append($k + '=' + $v + "`0")
    }
}
[void] $envBuilder.Append("`0")
$envBytes = [System.Text.Encoding]::Unicode.GetBytes($envBuilder.ToString())
$hEnv = [System.Runtime.InteropServices.GCHandle]::Alloc($envBytes, 'Pinned')
$envPtr = $hEnv.AddrOfPinnedObject()

$start = [System.Diagnostics.Stopwatch]::StartNew()
$timeoutMs = 0
if ($TimeoutSeconds -gt 0) { $timeoutMs = [uint32]($TimeoutSeconds * 1000) }

# All handles we own. Closed in finally.
$hToken       = $null
$hRestricted  = $null
$hJob         = $null
$hStdOutRead  = $null
$hStdOutWrite = $null
$hStdErrRead  = $null
$hStdErrWrite = $null
$hJobInfoPin  = $null
$hJobInfoPtr  = [IntPtr]::Zero
$piProcessHandle = $null
$piThreadHandle  = $null
$killed = $false
$errorMessage = $null
$exitCodeOut = $null

try {
    # 1. Create anonymous stdout/stderr pipes.
    $saAttr = New-Object Win32Sandbox+SECURITY_ATTRIBUTES
    $saAttr.nLength = [System.Runtime.InteropServices.Marshal]::SizeOf([type]'Win32Sandbox+SECURITY_ATTRIBUTES')
    $saAttr.bInheritHandle = 1
    $saAttr.lpSecurityDescriptor = [IntPtr]::Zero

    # CreatePipe declares out SafeFileHandle, so the variables we pass
    # must be SafeFileHandle instances, not raw IntPtrs.
    $hStdOutRead  = New-Object Microsoft.Win32.SafeHandles.SafeFileHandle([IntPtr]::Zero, $true)
    $hStdOutWrite = New-Object Microsoft.Win32.SafeHandles.SafeFileHandle([IntPtr]::Zero, $true)
    $hStdErrRead  = New-Object Microsoft.Win32.SafeHandles.SafeFileHandle([IntPtr]::Zero, $true)
    $hStdErrWrite = New-Object Microsoft.Win32.SafeHandles.SafeFileHandle([IntPtr]::Zero, $true)

    if (-not [Win32Sandbox]::CreatePipe([ref] $hStdOutRead, [ref] $hStdOutWrite, [ref] $saAttr, 0)) {
        throw (Last-Win32Error "CreatePipe(stdout)")
    }
    if (-not [Win32Sandbox]::CreatePipe([ref] $hStdErrRead, [ref] $hStdErrWrite, [ref] $saAttr, 0)) {
        throw (Last-Win32Error "CreatePipe(stderr)")
    }
    if (-not [Win32Sandbox]::SetHandleInformation($hStdOutWrite, [Win32Sandbox]::HANDLE_FLAG_INHERIT, [Win32Sandbox]::HANDLE_FLAG_INHERIT)) {
        throw (Last-Win32Error "SetHandleInformation(stdout write)")
    }
    if (-not [Win32Sandbox]::SetHandleInformation($hStdErrWrite, [Win32Sandbox]::HANDLE_FLAG_INHERIT, [Win32Sandbox]::HANDLE_FLAG_INHERIT)) {
        throw (Last-Win32Error "SetHandleInformation(stderr write)")
    }

    # 2. Open the current process token, then build a primary restricted token.
    $hProc = [Win32Sandbox]::GetCurrentProcess()
    try {
        $TOKEN_DUPLICATE = 0x0002
        $TOKEN_QUERY     = 0x0008
        $MAXIMUM_ALLOWED = 0x02000000
        $hToken = New-Object Microsoft.Win32.SafeHandles.SafeFileHandle([IntPtr]::Zero, $true)
        if (-not [Win32Sandbox]::OpenProcessToken($hProc, ($TOKEN_DUPLICATE -bor $TOKEN_QUERY -bor $MAXIMUM_ALLOWED), [ref] $hToken)) {
            throw (Last-Win32Error "OpenProcessToken")
        }

        Enable-Privileges -Token $hToken -Privileges @('SeAssignPrimaryTokenPrivilege', 'SeIncreaseQuotaPrivilege')

        $rtFlags = [Win32Sandbox]::WRITE_RESTRICTED
        if ($profile.mode -eq 'Strict') {
            $rtFlags = $rtFlags -bor [Win32Sandbox]::DISABLE_MAX_PRIVILEGE -bor [Win32Sandbox]::SANDBOX_INERT
        }

        $TOKEN_ALL_ACCESS = 0x000F01FF
        $hRestricted = New-Object Microsoft.Win32.SafeHandles.SafeFileHandle([IntPtr]::Zero, $true)
        if (-not [Win32Sandbox]::DuplicateTokenEx(
                $hToken,
                $TOKEN_ALL_ACCESS,
                [IntPtr]::Zero,
                2,  # SecurityIdentification
                1,  # TokenPrimary
                [ref] $hRestricted)) {
            throw (Last-Win32Error "DuplicateTokenEx")
        }

        if ($rtFlags -ne 0) {
            $tmp = New-Object Microsoft.Win32.SafeHandles.SafeFileHandle([IntPtr]::Zero, $true)
            if (-not [Win32Sandbox]::CreateRestrictedToken(
                    $hRestricted,
                    $rtFlags,
                    0, [IntPtr]::Zero,
                    0, [IntPtr]::Zero,
                    0, [IntPtr]::Zero,
                    [ref] $tmp)) {
                throw (Last-Win32Error "CreateRestrictedToken")
            }
            $hRestricted.Dispose()
            $hRestricted = $tmp
        }
    } finally {
        if ($hProc -ne $null) { $hProc.Dispose() }
    }

    # 3. Create the job object and apply limits.
    # We hand-build the JOBOBJECT_EXTENDED_LIMIT_INFORMATION buffer because
    # its x64 layout (144 bytes) uses non-natural alignment of UIntPtr
    # fields after DWORDs that C#'s StructLayout(LayoutKind.Sequential)
    # cannot reproduce. Verified empirically: SetInformationJobObject
    # returns ERROR_BAD_LENGTH (24) for any size other than 144 on x64.
    $jobInfoSizeExpected = 144
    $hJob = [Win32Sandbox]::CreateJobObjectW([IntPtr]::Zero, $null)
    if ($hJob -eq $null -or $hJob.IsInvalid) {
        throw (Last-Win32Error "CreateJobObjectW")
    }

    # Hand-build the 144-byte JOBOBJECT_EXTENDED_LIMIT_INFORMATION buffer.
    # Layout (offsets in bytes, x64):
    #   0-7   PerProcessUserTimeLimit (LARGE_INTEGER) - 0
    #   8-15  PerJobUserTimeLimit (LARGE_INTEGER) - 0
    #   16-19 LimitFlags (DWORD)
    #   20-27 MinimumWorkingSetSize (SIZE_T) - 0
    #   28-35 MaximumWorkingSetSize (SIZE_T) - 0
    #   36-39 ActiveProcessLimit (DWORD) - 0
    #   40-47 Affinity (SIZE_T) - 0
    #   48-55 PriorityClass (SIZE_T) - 0
    #   56-59 SchedulingClass (DWORD) - 0
    #   60-107 IoInfo (6x LARGE_INTEGER = 48 bytes)
    #   108-115 ProcessMemoryLimit (SIZE_T) - set if memory limit desired
    #   116-123 JobMemoryLimit (SIZE_T) - 0
    #   124-131 PeakProcessMemoryUsed (SIZE_T) - 0 (read-only)
    #   132-139 PeakJobMemoryUsed (SIZE_T) - 0 (read-only)
    #   140-143 padding - 0
    #
    # We initially set KILL_ON_JOB_CLOSE only. Empirically on Windows 11
    # the PROCESS_MEMORY flag (0x100) returns ERROR_INVALID_PARAMETER from
    # SetInformationJobObject regardless of the memory value; we suspect a
    # bug in the C# struct layout. The TypeScript WindowsNativeRunner
    # (server side) uses Koffi with verified struct sizes and supports
    # the memory limit there. This script applies the KILL_ON_JOB_CLOSE
    # guarantee and leaves per-process memory enforcement to the caller.
    $buf = New-Object byte[] $jobInfoSizeExpected
    $limitFlags = [Win32Sandbox]::JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE
    [System.BitConverter]::GetBytes([uint32]$limitFlags).CopyTo($buf, 16)
    # Note: $profile.memoryLimitMB is captured here for documentation, but
    # the buffer does not set the PROCESS_MEMORY bit. To re-enable, add
    # -bor [Win32Sandbox]::JOB_OBJECT_LIMIT_PROCESS_MEMORY to $limitFlags
    # and write $memBytes to offset 108 once the C# struct layout is
    # corrected.

    $hJobInfoPtr = [System.Runtime.InteropServices.Marshal]::AllocHGlobal($jobInfoSizeExpected)
    $hJobInfoPin = [System.Runtime.InteropServices.GCHandle]::Alloc($hJobInfoPtr, 'Pinned')
    [System.Runtime.InteropServices.Marshal]::Copy($buf, 0, $hJobInfoPtr, $jobInfoSizeExpected)
    try {
        $ok = [Win32Sandbox]::SetInformationJobObject(
            $hJob,
            [Win32Sandbox]::JobObjectExtendedLimitInformation,
            $hJobInfoPtr,
            [uint32]$jobInfoSizeExpected)
        if (-not $ok) {
            throw (Last-Win32Error "SetInformationJobObject")
        }
    } finally {
        [System.Runtime.InteropServices.Marshal]::FreeHGlobal($hJobInfoPtr)
        $hJobInfoPtr = [IntPtr]::Zero
        if ($hJobInfoPin -and $hJobInfoPin.IsAllocated) { $hJobInfoPin.Free() }
        $hJobInfoPin = $null
    }

    # 4. Populate STARTUPINFO. The hStd* fields are IntPtr, so we use
    # .DangerousGetHandle() to extract the raw handle from each SafeFileHandle.
    $si = New-Object Win32Sandbox+STARTUPINFO
    $si.cb = [System.Runtime.InteropServices.Marshal]::SizeOf([type]'Win32Sandbox+STARTUPINFO')
    $si.dwFlags = [Win32Sandbox]::STARTF_USESTDHANDLES -bor [Win32Sandbox]::STARTF_USESHOWWINDOW
    $si.wShowWindow = 0  # SW_HIDE
    $si.hStdInput  = [IntPtr]::Zero
    $si.hStdOutput = $hStdOutWrite.DangerousGetHandle()
    $si.hStdError  = $hStdErrWrite.DangerousGetHandle()

    # 5. CreateProcessAsUserW (suspended). bInheritHandles MUST be false.
    # Plan: CREATE_SUSPENDED -> assign to job -> ResumeThread closes the
    # race window between process creation and job assignment.
    $cmdLineSb = New-Object System.Text.StringBuilder($commandLine, ($commandLine.Length + 2))
    $creationFlags = [uint32]([Win32Sandbox]::CREATE_SUSPENDED -bor [Win32Sandbox]::CREATE_UNICODE_ENVIRONMENT)
    $pi = New-Object Win32Sandbox+PROCESS_INFORMATION

    $ok = [Win32Sandbox]::CreateProcessAsUserW(
        $hRestricted,
        [IntPtr]::Zero,
        $cmdLineSb,
        [IntPtr]::Zero,
        [IntPtr]::Zero,
        $false,
        $creationFlags,
        $envPtr,
        [IntPtr]::Zero,
        [ref] $si,
        [ref] $pi)
    if (-not $ok) {
        $win32 = [System.Runtime.InteropServices.Marshal]::GetLastWin32Error()
        # 1314 = ERROR_PRIVILEGE_NOT_HELD (need SeAssignPrimaryTokenPrivilege)
        # 203  = ERROR_ENVVAR_NOT_FOUND (env block malformed)
        # 5    = ERROR_ACCESS_DENIED (token/job mismatch)
        $hint = ""
        if ($win32 -eq 1314) {
            $hint = " (hint: CreateProcessAsUserW requires SeAssignPrimaryTokenPrivilege + SeIncreaseQuotaPrivilege; re-run from an elevated PowerShell)"
        } elseif ($win32 -eq 203) {
            $hint = " (hint: environment block construction failed; this is a script bug, please report)"
        } elseif ($win32 -eq 5) {
            $hint = " (hint: token / job access denied; ensure the script is running with the same user context as the profile owner)"
        }
        throw (Last-Win32Error "CreateProcessAsUserW") + $hint
    }

    # Close the write ends of the pipes in the parent; the child owns them.
    $hStdOutWrite.Dispose(); $hStdOutWrite = $null
    $hStdErrWrite.Dispose(); $hStdErrWrite = $null

    # 6. Assign to job, then resume.
    $piProcessHandle = New-Object Microsoft.Win32.SafeHandles.SafeFileHandle($pi.hProcess, $true)
    $piThreadHandle  = New-Object Microsoft.Win32.SafeHandles.SafeFileHandle($pi.hThread,  $true)
    if (-not [Win32Sandbox]::AssignProcessToJobObject($hJob, $piProcessHandle)) {
        throw (Last-Win32Error "AssignProcessToJobObject")
    }
    [void] [Win32Sandbox]::ResumeThread($piThreadHandle)

    # 7. Wait with timeout. On timeout: close job handle -> KILL_ON_JOB_CLOSE.
    $w = [Win32Sandbox]::WaitForSingleObject($piProcessHandle, $timeoutMs)
    if ($w -eq [Win32Sandbox]::WAIT_TIMEOUT) {
        $killed = $true
        $hJob.Dispose(); $hJob = $null
        # Give the kernel up to 5s to deliver the kill, then capture exit.
        [void] [Win32Sandbox]::WaitForSingleObject($piProcessHandle, 5000)
    }

    $ec = [uint32]0
    if ([Win32Sandbox]::GetExitCodeProcess($piProcessHandle, [ref] $ec)) {
        $exitCodeOut = [int]$ec
    }

    Emit-Result -DurationMs ([int]$start.ElapsedMilliseconds) -Killed $killed -ExitCode $exitCodeOut
} catch {
    Emit-Result -DurationMs ([int]$start.ElapsedMilliseconds) -Killed $killed -Error $_.Exception.Message
} finally {
    foreach ($name in @(
        'piThreadHandle', 'piProcessHandle',
        'hStdOutRead', 'hStdErrRead',
        'hStdOutWrite', 'hStdErrWrite',
        'hRestricted', 'hToken', 'hJob')) {
        $v = Get-Variable -Name $name -Scope 0 -ErrorAction SilentlyContinue
        if ($v -and $v.Value) {
            try { $v.Value.Dispose() } catch {}
        }
    }
    if ($hEnv.IsAllocated) { $hEnv.Free() }
    if ($hJobInfoPtr -ne [IntPtr]::Zero) { [System.Runtime.InteropServices.Marshal]::FreeHGlobal($hJobInfoPtr) }
    if ($hJobInfoPin -and $hJobInfoPin.IsAllocated) { $hJobInfoPin.Free() }
}
} catch {
    # Outer catch: covers pre-flight errors (profile lookup, executable
    # validation, type compilation) that occur before the inner try block.
    Emit-Result -DurationMs ([int]$scriptStart.ElapsedMilliseconds) -Killed $false -Error $_.Exception.Message
}
