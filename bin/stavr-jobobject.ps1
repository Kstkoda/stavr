# stavR Windows hard-cap helper (host-resource-ceiling Phase 4)
#
# Wraps `stavr daemon start` in a Windows Job Object that enforces a memory
# ceiling on the daemon AND every process it spawns. The Job Object is what
# Phase 4 cannot install from inside Node without a native addon — this
# PowerShell trampoline is the cross-platform alternative.
#
# Usage:
#   .\bin\stavr-jobobject.ps1 -MemoryMaxGb 24 [-CpuPct 85] [-DaemonArgs "--port 7777"]
#
# Notes:
#   - Run from an elevated PowerShell session (Job Objects don't strictly
#     require admin, but assigning the running process to one does in some
#     account modes).
#   - Replaces PM2's max_memory_restart for the wrapped process — PM2 still
#     restarts on breach but the Job Object KILLS first.
#   - The wrapped daemon process becomes a child of this script; closing
#     this window terminates the daemon (and the Job Object releases).
#   - This is the v1 hard-cap path. If we adopt a native node-windows job
#     binding in v2 the wrapper becomes obsolete.

param(
    [Parameter(Mandatory=$true)]
    [int]$MemoryMaxGb,
    [int]$CpuPct = 85,
    [string]$DaemonArgs = ''
)

if ($MemoryMaxGb -lt 1) {
    Write-Error 'MemoryMaxGb must be >= 1'
    exit 1
}

$jobName = 'stavR-host-ceiling'
$memBytes = [uint64]$MemoryMaxGb * 1024 * 1024 * 1024

# Win32 types we need. Add-Type compiles a tiny C# shim because PowerShell
# can't call CreateJobObject directly.
Add-Type -Namespace StavR.JobObject -Name Native -MemberDefinition @'
[DllImport("kernel32.dll", CharSet = CharSet.Auto, SetLastError = true)]
public static extern System.IntPtr CreateJobObject(System.IntPtr lpJobAttributes, string lpName);
[DllImport("kernel32.dll", SetLastError = true)]
public static extern bool AssignProcessToJobObject(System.IntPtr hJob, System.IntPtr hProcess);
[DllImport("kernel32.dll", SetLastError = true)]
[return: System.Runtime.InteropServices.MarshalAs(System.Runtime.InteropServices.UnmanagedType.Bool)]
public static extern bool SetInformationJobObject(System.IntPtr hJob, int infoClass, System.IntPtr lpJobObjectInfo, uint cbJobObjectInfoLength);

[System.Runtime.InteropServices.StructLayout(System.Runtime.InteropServices.LayoutKind.Sequential)]
public struct IO_COUNTERS { public ulong ReadOps, WriteOps, OtherOps, ReadBytes, WriteBytes, OtherBytes; }

[System.Runtime.InteropServices.StructLayout(System.Runtime.InteropServices.LayoutKind.Sequential)]
public struct JOBOBJECT_BASIC_LIMIT_INFORMATION {
    public long PerProcessUserTimeLimit;
    public long PerJobUserTimeLimit;
    public uint LimitFlags;
    public System.UIntPtr MinimumWorkingSetSize;
    public System.UIntPtr MaximumWorkingSetSize;
    public uint ActiveProcessLimit;
    public System.UIntPtr Affinity;
    public uint PriorityClass;
    public uint SchedulingClass;
}

[System.Runtime.InteropServices.StructLayout(System.Runtime.InteropServices.LayoutKind.Sequential)]
public struct JOBOBJECT_EXTENDED_LIMIT_INFORMATION {
    public JOBOBJECT_BASIC_LIMIT_INFORMATION BasicLimitInformation;
    public IO_COUNTERS IoInfo;
    public System.UIntPtr ProcessMemoryLimit;
    public System.UIntPtr JobMemoryLimit;
    public System.UIntPtr PeakProcessMemoryUsed;
    public System.UIntPtr PeakJobMemoryUsed;
}
'@

$JOB_OBJECT_LIMIT_JOB_MEMORY = 0x00000200
$JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE = 0x00002000
$ExtendedLimitInformation = 9

$hJob = [StavR.JobObject.Native]::CreateJobObject([IntPtr]::Zero, $jobName)
if ($hJob -eq [IntPtr]::Zero) {
    Write-Error "CreateJobObject failed: $([System.Runtime.InteropServices.Marshal]::GetLastWin32Error())"
    exit 2
}

$info = New-Object StavR.JobObject.Native+JOBOBJECT_EXTENDED_LIMIT_INFORMATION
$info.BasicLimitInformation.LimitFlags = $JOB_OBJECT_LIMIT_JOB_MEMORY -bor $JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE
$info.JobMemoryLimit = [System.UIntPtr]::new($memBytes)

$size = [System.Runtime.InteropServices.Marshal]::SizeOf($info)
$buf = [System.Runtime.InteropServices.Marshal]::AllocHGlobal($size)
[System.Runtime.InteropServices.Marshal]::StructureToPtr($info, $buf, $false)
$ok = [StavR.JobObject.Native]::SetInformationJobObject($hJob, $ExtendedLimitInformation, $buf, $size)
[System.Runtime.InteropServices.Marshal]::FreeHGlobal($buf)
if (-not $ok) {
    Write-Error "SetInformationJobObject failed: $([System.Runtime.InteropServices.Marshal]::GetLastWin32Error())"
    exit 3
}

# Spawn stavr daemon start with the supplied args, then assign it to the job.
$daemonExe = 'node'
$cliEntry = Join-Path (Split-Path -Parent $PSCommandPath) '..\dist\cli.js'
$cliEntry = (Resolve-Path $cliEntry).Path
$argv = @($cliEntry, 'daemon', 'start')
if ($DaemonArgs) { $argv += $DaemonArgs.Split(' ') }

$proc = Start-Process -FilePath $daemonExe -ArgumentList $argv -PassThru -NoNewWindow
$assigned = [StavR.JobObject.Native]::AssignProcessToJobObject($hJob, $proc.Handle)
if (-not $assigned) {
    Write-Error "AssignProcessToJobObject failed: $([System.Runtime.InteropServices.Marshal]::GetLastWin32Error())"
    Stop-Process -Id $proc.Id
    exit 4
}

Write-Host "stavR daemon (pid $($proc.Id)) running under Job Object '$jobName' with memory cap ${MemoryMaxGb}GB"
$proc.WaitForExit()
exit $proc.ExitCode
