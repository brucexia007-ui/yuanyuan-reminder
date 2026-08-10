param(
    [string]$ReleaseRoot = "",
    [string]$HistoricalInstallerPath = "",
    [int]$FailureTimeoutSeconds = 10
)

$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"

$historicalVersion = "1.3.2"
$historicalInstallerBytes = 12071368L
$historicalInstallerSha256 = "FD08FAC044D32995FA7BB153A06E5ED092FCCA827DCAA4154608F579541FF4F1"
$historicalInstalledCoreBytes = 20574720L
$historicalInstalledCoreSha256 = "864209F2D6385205CA15E35677C64BA94388B315DB555EBA08369D57717F3FCF"
$limitations = @(
    "This probe uses an owned temporary installation, a deterministic half-length copy of the current candidate, an exclusive lock on the historical main executable, and forced termination only after observing a changed main-executable write boundary.",
    "It verifies pre-install corruption containment, file-replacement obstruction containment, an incomplete file set after installer-process termination, synthetic data-sentinel preservation, and recovery by the unmodified current candidate.",
    "It does not simulate power loss or system restart, use an authentic historical business database, prove default-path registration, or replace signed-candidate, SmartScreen, and security-software matrices."
)

if ($FailureTimeoutSeconds -lt 3 -or $FailureTimeoutSeconds -gt 60) {
    throw "FailureTimeoutSeconds must be between 3 and 60"
}

$projectRoot = Split-Path -Parent $PSScriptRoot
if ([string]::IsNullOrWhiteSpace($ReleaseRoot)) {
    $ReleaseRoot = Join-Path $projectRoot "src-tauri\target\release"
}
$releaseRoot = [IO.Path]::GetFullPath($ReleaseRoot)
$package = Get-Content -Raw -Encoding UTF8 -LiteralPath (Join-Path $projectRoot "package.json") |
    ConvertFrom-Json
$tauriConfig = Get-Content -Raw -Encoding UTF8 -LiteralPath (
    Join-Path $projectRoot "src-tauri\tauri.conf.json"
) | ConvertFrom-Json
$candidateVersion = [string]$package.version
$productName = [string]$tauriConfig.productName
$bundleIdentifier = [string]$tauriConfig.identifier
$scriptPath = $MyInvocation.MyCommand.Path
$candidatePayloadPath = Join-Path $releaseRoot "nsis-payload\yuanyuan-reminder.exe"
$candidateInstallerCandidates = @(
    Get-ChildItem -LiteralPath (Join-Path $releaseRoot "bundle\nsis") -File -ErrorAction SilentlyContinue |
        Where-Object { $_.Name -like ("*_{0}_x64-setup.exe" -f $candidateVersion) }
)
if ($candidateInstallerCandidates.Count -ne 1) {
    throw "release bundle must contain exactly one version-matched x64 NSIS installer"
}
$candidateInstallerPath = $candidateInstallerCandidates[0].FullName
$reportPath = Join-Path $releaseRoot "release-install-failure-recovery-probe.json"

if (-not ("YuanyuanInstallFailureProcessSnapshot" -as [type])) {
    Add-Type -TypeDefinition @"
using System;
using System.Collections.Generic;
using System.ComponentModel;
using System.Runtime.InteropServices;

public sealed class YuanyuanInstallFailureProcessRelation {
    public uint ProcessId { get; set; }
    public uint ParentProcessId { get; set; }
}

public static class YuanyuanInstallFailureProcessSnapshot {
    private const uint SnapshotProcesses = 0x00000002;

    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    private struct ProcessEntry {
        public uint Size;
        public uint Usage;
        public uint ProcessId;
        public IntPtr DefaultHeapId;
        public uint ModuleId;
        public uint ThreadCount;
        public uint ParentProcessId;
        public int BasePriority;
        public uint Flags;
        [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 260)]
        public string ExecutableFile;
    }

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern IntPtr CreateToolhelp32Snapshot(uint flags, uint processId);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern bool Process32First(IntPtr snapshot, ref ProcessEntry entry);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern bool Process32Next(IntPtr snapshot, ref ProcessEntry entry);
    [DllImport("kernel32.dll")]
    private static extern bool CloseHandle(IntPtr handle);

    public static YuanyuanInstallFailureProcessRelation[] Capture() {
        var snapshot = CreateToolhelp32Snapshot(SnapshotProcesses, 0);
        if (snapshot == new IntPtr(-1)) {
            throw new Win32Exception(Marshal.GetLastWin32Error());
        }
        try {
            var rows = new List<YuanyuanInstallFailureProcessRelation>();
            var entry = new ProcessEntry { Size = (uint)Marshal.SizeOf(typeof(ProcessEntry)) };
            if (Process32First(snapshot, ref entry)) {
                do {
                    rows.Add(new YuanyuanInstallFailureProcessRelation {
                        ProcessId = entry.ProcessId,
                        ParentProcessId = entry.ParentProcessId
                    });
                    entry.Size = (uint)Marshal.SizeOf(typeof(ProcessEntry));
                } while (Process32Next(snapshot, ref entry));
            }
            return rows.ToArray();
        }
        finally {
            CloseHandle(snapshot);
        }
    }
}

public sealed class YuanyuanInstallFailureJobProcess : IDisposable {
    private const uint CreateSuspended = 0x00000004;
    private const uint CreateUnicodeEnvironment = 0x00000400;
    private const uint JobObjectLimitKillOnJobClose = 0x00002000;
    private const uint CpuRateControlEnable = 0x00000001;
    private const uint CpuRateControlHardCap = 0x00000004;
    private const int JobObjectExtendedLimitInformation = 9;
    private const int JobObjectCpuRateControlInformation = 15;
    private const uint Infinite = 0xffffffff;

    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    private struct StartupInfo {
        public uint Size;
        public string Reserved;
        public string Desktop;
        public string Title;
        public uint X;
        public uint Y;
        public uint XSize;
        public uint YSize;
        public uint XCountChars;
        public uint YCountChars;
        public uint FillAttribute;
        public uint Flags;
        public ushort ShowWindow;
        public ushort Reserved2Size;
        public IntPtr Reserved2;
        public IntPtr StandardInput;
        public IntPtr StandardOutput;
        public IntPtr StandardError;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct ProcessInformation {
        public IntPtr Process;
        public IntPtr Thread;
        public uint ProcessId;
        public uint ThreadId;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct IoCounters {
        public ulong ReadOperationCount;
        public ulong WriteOperationCount;
        public ulong OtherOperationCount;
        public ulong ReadTransferCount;
        public ulong WriteTransferCount;
        public ulong OtherTransferCount;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct BasicLimitInformation {
        public long PerProcessUserTimeLimit;
        public long PerJobUserTimeLimit;
        public uint LimitFlags;
        public UIntPtr MinimumWorkingSetSize;
        public UIntPtr MaximumWorkingSetSize;
        public uint ActiveProcessLimit;
        public IntPtr Affinity;
        public uint PriorityClass;
        public uint SchedulingClass;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct ExtendedLimitInformation {
        public BasicLimitInformation BasicLimitInformation;
        public IoCounters IoInfo;
        public UIntPtr ProcessMemoryLimit;
        public UIntPtr JobMemoryLimit;
        public UIntPtr PeakProcessMemoryUsed;
        public UIntPtr PeakJobMemoryUsed;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct CpuRateControlInformation {
        public uint ControlFlags;
        public uint CpuRate;
    }

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern bool CreateProcessW(
        string applicationName,
        System.Text.StringBuilder commandLine,
        IntPtr processAttributes,
        IntPtr threadAttributes,
        bool inheritHandles,
        uint creationFlags,
        IntPtr environment,
        string currentDirectory,
        ref StartupInfo startupInfo,
        out ProcessInformation processInformation);
    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern IntPtr CreateJobObjectW(IntPtr attributes, string name);
    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool SetInformationJobObject(
        IntPtr job,
        int informationClass,
        ref ExtendedLimitInformation information,
        uint informationLength);
    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool SetInformationJobObject(
        IntPtr job,
        int informationClass,
        ref CpuRateControlInformation information,
        uint informationLength);
    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool AssignProcessToJobObject(IntPtr job, IntPtr process);
    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern uint ResumeThread(IntPtr thread);
    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool TerminateJobObject(IntPtr job, uint exitCode);
    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern uint WaitForSingleObject(IntPtr handle, uint milliseconds);
    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool GetExitCodeProcess(IntPtr process, out uint exitCode);
    [DllImport("kernel32.dll")]
    private static extern bool CloseHandle(IntPtr handle);

    private IntPtr job;
    private IntPtr process;
    private IntPtr thread;
    public int ProcessId { get; private set; }

    private YuanyuanInstallFailureJobProcess() { }

    public static YuanyuanInstallFailureJobProcess Start(
        string executable,
        string arguments,
        uint cpuRate) {
        var owned = new YuanyuanInstallFailureJobProcess();
        try {
            owned.job = CreateJobObjectW(IntPtr.Zero, null);
            if (owned.job == IntPtr.Zero) {
                throw new Win32Exception(Marshal.GetLastWin32Error());
            }
            var limits = new ExtendedLimitInformation();
            limits.BasicLimitInformation.LimitFlags = JobObjectLimitKillOnJobClose;
            if (!SetInformationJobObject(
                    owned.job,
                    JobObjectExtendedLimitInformation,
                    ref limits,
                    (uint)Marshal.SizeOf(typeof(ExtendedLimitInformation)))) {
                throw new Win32Exception(Marshal.GetLastWin32Error());
            }
            var cpu = new CpuRateControlInformation {
                ControlFlags = CpuRateControlEnable | CpuRateControlHardCap,
                CpuRate = cpuRate
            };
            if (!SetInformationJobObject(
                    owned.job,
                    JobObjectCpuRateControlInformation,
                    ref cpu,
                    (uint)Marshal.SizeOf(typeof(CpuRateControlInformation)))) {
                throw new Win32Exception(Marshal.GetLastWin32Error());
            }
            var startup = new StartupInfo {
                Size = (uint)Marshal.SizeOf(typeof(StartupInfo))
            };
            var commandLine = new System.Text.StringBuilder(
                "\"" + executable + "\" " + arguments);
            ProcessInformation created;
            if (!CreateProcessW(
                    executable,
                    commandLine,
                    IntPtr.Zero,
                    IntPtr.Zero,
                    false,
                    CreateSuspended | CreateUnicodeEnvironment,
                    IntPtr.Zero,
                    System.IO.Path.GetDirectoryName(executable),
                    ref startup,
                    out created)) {
                throw new Win32Exception(Marshal.GetLastWin32Error());
            }
            owned.process = created.Process;
            owned.thread = created.Thread;
            owned.ProcessId = checked((int)created.ProcessId);
            if (!AssignProcessToJobObject(owned.job, owned.process)) {
                throw new Win32Exception(Marshal.GetLastWin32Error());
            }
            if (ResumeThread(owned.thread) == uint.MaxValue) {
                throw new Win32Exception(Marshal.GetLastWin32Error());
            }
            return owned;
        }
        catch {
            owned.Dispose();
            throw;
        }
    }

    public bool Terminate(uint exitCode) {
        if (job == IntPtr.Zero) { return false; }
        if (!TerminateJobObject(job, exitCode)) {
            throw new Win32Exception(Marshal.GetLastWin32Error());
        }
        WaitForSingleObject(process, 10000);
        return true;
    }

    public int? ExitCode {
        get {
            uint code;
            if (process == IntPtr.Zero || !GetExitCodeProcess(process, out code) ||
                code == 259) {
                return null;
            }
            return unchecked((int)code);
        }
    }

    public void Dispose() {
        if (job != IntPtr.Zero) {
            TerminateJobObject(job, 1);
        }
        if (thread != IntPtr.Zero) { CloseHandle(thread); thread = IntPtr.Zero; }
        if (process != IntPtr.Zero) { CloseHandle(process); process = IntPtr.Zero; }
        if (job != IntPtr.Zero) { CloseHandle(job); job = IntPtr.Zero; }
    }
}
"@
}

function Get-Sha256([string]$Path) {
    (Get-FileHash -Algorithm SHA256 -LiteralPath $Path).Hash
}

function Test-SamePath([AllowNull()][string]$Left, [string]$Right) {
    if ([string]::IsNullOrWhiteSpace($Left)) { return $false }
    $normalizedLeft = [IO.Path]::GetFullPath($Left.Trim('"')).TrimEnd('\')
    $normalizedRight = [IO.Path]::GetFullPath($Right.Trim('"')).TrimEnd('\')
    $normalizedLeft.Equals($normalizedRight, [StringComparison]::OrdinalIgnoreCase)
}

function Find-HistoricalInstaller {
    if (-not [string]::IsNullOrWhiteSpace($HistoricalInstallerPath)) {
        if ([IO.Path]::IsPathRooted($HistoricalInstallerPath)) {
            return [IO.Path]::GetFullPath($HistoricalInstallerPath)
        }
        return [IO.Path]::GetFullPath((Join-Path $projectRoot $HistoricalInstallerPath))
    }
    $matches = New-Object System.Collections.Generic.List[string]
    foreach ($searchRoot in @(
        (Join-Path $projectRoot "release"),
        (Join-Path $projectRoot "src-tauri\target")
    )) {
        if (-not (Test-Path -LiteralPath $searchRoot -PathType Container)) { continue }
        foreach ($candidate in @(
            Get-ChildItem -LiteralPath $searchRoot -Recurse -File -ErrorAction SilentlyContinue |
                Where-Object {
                    $_.Name -like "*1.3.2*setup.exe" -and
                    $_.Length -eq $historicalInstallerBytes
                }
        )) {
            if ((Get-Sha256 $candidate.FullName) -eq $historicalInstallerSha256) {
                $matches.Add($candidate.FullName)
            }
        }
    }
    if ($matches.Count -eq 0) {
        throw "official v1.3.2 installer bytes were not found; pass -HistoricalInstallerPath explicitly"
    }
    @($matches | Sort-Object)[0]
}

function Get-InstalledCoreState(
    [string]$InstallRoot,
    [string]$ExpectedVersion,
    [long]$ExpectedBytes,
    [string]$ExpectedSha256
) {
    $applicationPath = Join-Path $InstallRoot "yuanyuan-reminder.exe"
    $uninstallerPath = Join-Path $InstallRoot "uninstall.exe"
    $applicationPresent = Test-Path -LiteralPath $applicationPath -PathType Leaf
    $uninstallerPresent = Test-Path -LiteralPath $uninstallerPath -PathType Leaf
    $actualVersion = if ($applicationPresent) {
        [string](Get-Item -LiteralPath $applicationPath).VersionInfo.ProductVersion
    } else { $null }
    $actualBytes = if ($applicationPresent) {
        [long](Get-Item -LiteralPath $applicationPath).Length
    } else { 0L }
    $actualSha256 = if ($applicationPresent) { Get-Sha256 $applicationPath } else { $null }
    [ordered]@{
        applicationPresent = $applicationPresent
        uninstallerPresent = $uninstallerPresent
        installedProductVersion = $actualVersion
        installedCoreBytes = $actualBytes
        installedCoreSha256 = $actualSha256
        installedCoreMatches = $applicationPresent -and
            $uninstallerPresent -and
            $actualVersion -eq $ExpectedVersion -and
            $actualBytes -eq $ExpectedBytes -and
            $actualSha256 -eq $ExpectedSha256
    }
}

function Test-CurrentLicenseFilesAbsent(
    [string]$InstallRoot,
    [System.Collections.IDictionary]$ExpectedFiles
) {
    foreach ($name in $ExpectedFiles.Keys) {
        if (Test-Path -LiteralPath (Join-Path (Join-Path $InstallRoot "licenses") $name)) {
            return $false
        }
    }
    $true
}

function Test-CurrentLicenseBundle(
    [string]$InstallRoot,
    [System.Collections.IDictionary]$ExpectedFiles
) {
    $licenseRoot = Join-Path $InstallRoot "licenses"
    $actualNames = @(
        Get-ChildItem -LiteralPath $licenseRoot -File -ErrorAction SilentlyContinue |
            Select-Object -ExpandProperty Name |
            Sort-Object
    )
    $expectedNames = @($ExpectedFiles.Keys | Sort-Object)
    $filesExact = (ConvertTo-Json @($actualNames) -Compress) -eq
        (ConvertTo-Json @($expectedNames) -Compress)
    $hashesMatch = $filesExact
    foreach ($name in $expectedNames) {
        $installedPath = Join-Path $licenseRoot $name
        if (
            -not (Test-Path -LiteralPath $installedPath -PathType Leaf) -or
            (Get-Sha256 $installedPath) -ne (Get-Sha256 $ExpectedFiles[$name])
        ) {
            $hashesMatch = $false
        }
    }
    [ordered]@{
        licenseFiles = @($actualNames)
        licenseFilesExact = $filesExact
        licenseHashesMatch = $hashesMatch
    }
}

function Test-Sentinel([string]$Path, [string]$ExpectedSha256) {
    (Test-Path -LiteralPath $Path -PathType Leaf) -and
        (Get-Sha256 $Path) -eq $ExpectedSha256
}

function Invoke-SilentInstall([string]$InstallerPath, [string]$InstallRoot) {
    $process = Start-Process -FilePath $InstallerPath `
        -ArgumentList @("/S", "/D=$InstallRoot") `
        -Wait `
        -PassThru
    Start-Sleep -Milliseconds 750
    $process.ExitCode
}

function Invoke-SilentUninstall([string]$InstallRoot) {
    $uninstallerPath = Join-Path $InstallRoot "uninstall.exe"
    if (-not (Test-Path -LiteralPath $uninstallerPath -PathType Leaf)) {
        throw "owned QA uninstaller is missing"
    }
    $process = Start-Process -FilePath $uninstallerPath -ArgumentList "/S" -Wait -PassThru
    Start-Sleep -Milliseconds 750
    $process.ExitCode
}

function Expand-OwnedProcessIds([System.Collections.Generic.HashSet[int]]$Owned) {
    $rows = @([YuanyuanInstallFailureProcessSnapshot]::Capture())
    do {
        $added = $false
        foreach ($row in $rows) {
            if ($Owned.Contains([int]$row.ParentProcessId) -and
                -not $Owned.Contains([int]$row.ProcessId)) {
                $Owned.Add([int]$row.ProcessId) | Out-Null
                $added = $true
            }
        }
    } while ($added)
}

function Get-LiveOwnedProcessIds([System.Collections.Generic.HashSet[int]]$Owned) {
    Expand-OwnedProcessIds $Owned
    @($Owned | Where-Object { Get-Process -Id $_ -ErrorAction SilentlyContinue })
}

function Stop-OwnedProcessTree([System.Collections.Generic.HashSet[int]]$Owned) {
    for ($attempt = 0; $attempt -lt 4; $attempt += 1) {
        $live = @(Get-LiveOwnedProcessIds $Owned)
        if ($live.Count -eq 0) { return }
        foreach ($processId in @($live | Sort-Object -Descending)) {
            Stop-Process -Id $processId -Force -ErrorAction SilentlyContinue
        }
        Start-Sleep -Milliseconds 250
    }
    $remaining = @(Get-LiveOwnedProcessIds $Owned)
    if ($remaining.Count -gt 0) {
        throw "owned installer process tree did not stop"
    }
}

function Invoke-BoundedFailureInstall(
    [string]$InstallerPath,
    [string]$InstallRoot,
    [int]$TimeoutSeconds
) {
    $owned = [System.Collections.Generic.HashSet[int]]::new()
    $process = $null
    $startRejected = $false
    $startErrorType = $null
    try {
        $process = Start-Process -FilePath $InstallerPath `
            -ArgumentList @("/S", "/D=$InstallRoot") `
            -PassThru
    }
    catch {
        $startRejected = $true
        $startErrorType = $_.Exception.GetType().FullName
    }
    if ($startRejected) {
        return [ordered]@{
            launchDisposition = "start_rejected"
            rootExitCode = $null
            processTreeTimedOut = $false
            processTreeTerminatedByProbe = $false
            ownedProcessCountAfter = 0
            maximumOwnedProcessCount = 0
            startErrorType = $startErrorType
        }
    }

    $owned.Add([int]$process.Id) | Out-Null
    $maximumOwnedProcessCount = 1
    $deadline = [DateTime]::UtcNow.AddSeconds($TimeoutSeconds)
    $live = @(Get-LiveOwnedProcessIds $owned)
    while ($live.Count -gt 0 -and [DateTime]::UtcNow -lt $deadline) {
        $maximumOwnedProcessCount = [math]::Max($maximumOwnedProcessCount, $owned.Count)
        Start-Sleep -Milliseconds 50
        $live = @(Get-LiveOwnedProcessIds $owned)
    }
    $timedOut = $live.Count -gt 0
    if ($timedOut) {
        Stop-OwnedProcessTree $owned
    }
    try { $process.Refresh() } catch {}
    $rootExitCode = if ($process.HasExited) { [int]$process.ExitCode } else { $null }
    $remainingCount = @(Get-LiveOwnedProcessIds $owned).Count
    $disposition = if ($timedOut) {
        "terminated_after_timeout"
    }
    elseif ($null -ne $rootExitCode -and $rootExitCode -ne 0) {
        "exited_nonzero"
    }
    else {
        "exited_zero"
    }
    [ordered]@{
        launchDisposition = $disposition
        rootExitCode = $rootExitCode
        processTreeTimedOut = $timedOut
        processTreeTerminatedByProbe = $timedOut -and $remainingCount -eq 0
        ownedProcessCountAfter = $remainingCount
        maximumOwnedProcessCount = $maximumOwnedProcessCount
        startErrorType = $null
    }
}

function Get-MainExecutableWriteObservation(
    [string]$ApplicationPath,
    [long]$BaselineBytes,
    [long]$BaselineLastWriteTicks
) {
    try {
        $item = Get-Item -LiteralPath $ApplicationPath -Force -ErrorAction Stop
        $changed = [long]$item.Length -ne $BaselineBytes -or
            [long]$item.LastWriteTimeUtc.Ticks -ne $BaselineLastWriteTicks
        [ordered]@{
            present = $true
            bytes = [long]$item.Length
            lastWriteTicks = [long]$item.LastWriteTimeUtc.Ticks
            changed = $changed
            readErrorType = $null
        }
    }
    catch [System.Management.Automation.ItemNotFoundException] {
        [ordered]@{
            present = $false
            bytes = 0L
            lastWriteTicks = 0L
            changed = $false
            readErrorType = $null
        }
    }
    catch {
        [ordered]@{
            present = Test-Path -LiteralPath $ApplicationPath -PathType Leaf
            bytes = 0L
            lastWriteTicks = 0L
            changed = $false
            readErrorType = $_.Exception.GetType().FullName
        }
    }
}

function Invoke-WriteBoundaryTerminationInstall(
    [string]$InstallerPath,
    [string]$InstallRoot,
    [long]$BaselineBytes,
    [long]$BaselineLastWriteTicks,
    [int]$TimeoutSeconds
) {
    $applicationPath = Join-Path $InstallRoot "yuanyuan-reminder.exe"
    $owned = [System.Collections.Generic.HashSet[int]]::new()
    # NSIS requires /D to be the final argument and consumes the remainder of
    # the raw command line as the path; wrapping that argument in quotes makes
    # it silently fall back to the default install directory.
    $arguments = '/S /D={0}' -f $InstallRoot
    $jobProcess = [YuanyuanInstallFailureJobProcess]::Start(
        $InstallerPath,
        $arguments,
        [uint32]100
    )
    $owned.Add([int]$jobProcess.ProcessId) | Out-Null
    $maximumOwnedProcessCount = 1
    $deadline = [DateTime]::UtcNow.AddSeconds($TimeoutSeconds)
    $writeBoundaryObserved = $false
    $triggerObservation = $null
    $liveBeforeTermination = @()
    $jobTerminationSucceeded = $false

    try {
        while ([DateTime]::UtcNow -lt $deadline) {
            $live = @(Get-LiveOwnedProcessIds $owned)
            $maximumOwnedProcessCount = [math]::Max($maximumOwnedProcessCount, $owned.Count)
            if ($live.Count -eq 0) { break }
            $observation = Get-MainExecutableWriteObservation `
                $applicationPath `
                $BaselineBytes `
                $BaselineLastWriteTicks
            if ($observation.changed -and $observation.present -and $observation.bytes -gt 0) {
                $writeBoundaryObserved = $true
                $triggerObservation = $observation
                $liveBeforeTermination = @($live)
                $jobTerminationSucceeded = $jobProcess.Terminate([uint32]1)
                Stop-OwnedProcessTree $owned
                break
            }
            [Threading.Thread]::Yield() | Out-Null
        }

        if (-not $writeBoundaryObserved) {
            $jobTerminationSucceeded = $jobProcess.Terminate([uint32]1)
            $live = @(Get-LiveOwnedProcessIds $owned)
            if ($live.Count -gt 0) { Stop-OwnedProcessTree $owned }
        }
        Start-Sleep -Milliseconds 750
        $rootExitCode = $jobProcess.ExitCode
    }
    finally {
        $jobProcess.Dispose()
    }
    $remainingCount = @(Get-LiveOwnedProcessIds $owned).Count
    [ordered]@{
        cpuHardCapPercent = 1
        jobKillOnClose = $true
        writeBoundaryObserved = $writeBoundaryObserved
        triggerMainExecutablePresent = if ($null -ne $triggerObservation) {
            [bool]$triggerObservation.present
        } else { $false }
        triggerMainExecutableBytes = if ($null -ne $triggerObservation) {
            [long]$triggerObservation.bytes
        } else { 0L }
        triggerReadErrorType = if ($null -ne $triggerObservation) {
            $triggerObservation.readErrorType
        } else { $null }
        rootExitCode = $rootExitCode
        processTreeTerminatedByProbe = $jobTerminationSucceeded -and
            $writeBoundaryObserved -and
            $liveBeforeTermination.Count -gt 0 -and
            $remainingCount -eq 0
        ownedProcessCountBeforeTermination = $liveBeforeTermination.Count
        ownedProcessCountAfter = $remainingCount
        maximumOwnedProcessCount = $maximumOwnedProcessCount
    }
}

function Remove-OwnedShortcut([string]$Path, [string]$ExpectedTarget) {
    if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) { return $true }
    $shell = New-Object -ComObject WScript.Shell
    $actualTarget = [string]$shell.CreateShortcut($Path).TargetPath
    if (-not (Test-SamePath $actualTarget $ExpectedTarget)) {
        throw "refusing to remove a shortcut outside the owned QA installation"
    }
    Remove-Item -LiteralPath $Path -Force -ErrorAction Stop
    -not (Test-Path -LiteralPath $Path)
}

function Remove-OwnedDirectory(
    [string]$Path,
    [string]$MarkerName,
    [string]$ExpectedMarker,
    [string]$RequiredParent
) {
    if (-not (Test-Path -LiteralPath $Path -PathType Container)) { return $true }
    $resolved = [IO.Path]::GetFullPath($Path)
    $parent = [IO.Path]::GetFullPath($RequiredParent).TrimEnd('\') + '\'
    if (-not $resolved.StartsWith($parent, [StringComparison]::OrdinalIgnoreCase)) {
        throw "owned cleanup target escaped its required parent"
    }
    $markerPath = Join-Path $resolved $MarkerName
    if (
        -not (Test-Path -LiteralPath $markerPath -PathType Leaf) -or
        (Get-Content -Raw -Encoding UTF8 -LiteralPath $markerPath) -ne $ExpectedMarker
    ) {
        throw "owned cleanup marker is missing or invalid"
    }
    Remove-Item -LiteralPath $resolved -Recurse -Force -ErrorAction Stop
    -not (Test-Path -LiteralPath $resolved)
}

$historicalInstallerPath = Find-HistoricalInstaller
$expectedLicenseFiles = [ordered]@{
    "ASSETS_LICENSE.md" = Join-Path $projectRoot "ASSETS_LICENSE.md"
    "LICENSE.txt" = Join-Path $projectRoot "LICENSE"
    "THIRD_PARTY_LICENSES.txt" = Join-Path $projectRoot "THIRD_PARTY_LICENSES.txt"
    "THIRD_PARTY_NOTICES.md" = Join-Path $projectRoot "THIRD_PARTY_NOTICES.md"
}
$requiredFiles = @(
    $historicalInstallerPath,
    $candidateInstallerPath,
    $candidatePayloadPath,
    $scriptPath
) + @($expectedLicenseFiles.Values)
foreach ($requiredPath in $requiredFiles) {
    if (-not (Test-Path -LiteralPath $requiredPath -PathType Leaf)) {
        throw "required install-failure probe input is missing: $requiredPath"
    }
    $metadata = Get-Item -LiteralPath $requiredPath -Force
    if (($metadata.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
        throw "install-failure probe input must not be a reparse point: $requiredPath"
    }
}
if (
    (Get-Item -LiteralPath $historicalInstallerPath).Length -ne $historicalInstallerBytes -or
    (Get-Sha256 $historicalInstallerPath) -ne $historicalInstallerSha256 -or
    [string](Get-Item -LiteralPath $historicalInstallerPath).VersionInfo.ProductVersion -ne
        $historicalVersion
) {
    throw "historical installer does not match the frozen official v1.3.2 release identity"
}

$candidateInstallerBytes = [long](Get-Item -LiteralPath $candidateInstallerPath).Length
$candidateInstallerSha256 = Get-Sha256 $candidateInstallerPath
$candidatePayloadBytes = [long](Get-Item -LiteralPath $candidatePayloadPath).Length
$candidatePayloadSha256 = Get-Sha256 $candidatePayloadPath
$identity = [Security.Principal.WindowsIdentity]::GetCurrent()
$sid = $identity.User.Value
$profileRegistryQueryAvailable = $true
$profilePath = $null
try {
    $profilePath = [Environment]::ExpandEnvironmentVariables([string](
        Get-ItemProperty -LiteralPath (
            "Registry::HKEY_LOCAL_MACHINE\SOFTWARE\Microsoft\Windows NT\CurrentVersion\ProfileList\{0}" -f $sid
        ) -ErrorAction Stop
    ).ProfileImagePath)
}
catch {
    $profileRegistryQueryAvailable = $false
}
$tokenProfilePathMatchesEnvironment = $profileRegistryQueryAvailable -and
    (Test-SamePath $profilePath $env:USERPROFILE)
$localAppData = [Environment]::GetFolderPath("LocalApplicationData")
$localAppDataMatchesTokenProfile = $profileRegistryQueryAvailable -and
    $localAppData.StartsWith(
        ([IO.Path]::GetFullPath($profilePath).TrimEnd('\') + '\'),
        [StringComparison]::OrdinalIgnoreCase
    )
$uninstallKey = "Registry::HKEY_CURRENT_USER\Software\Microsoft\Windows\CurrentVersion\Uninstall\$productName"
$productKey = "Registry::HKEY_CURRENT_USER\Software\yuanyuan\$productName"
$runKey = "Registry::HKEY_CURRENT_USER\Software\Microsoft\Windows\CurrentVersion\Run"
$preexistingRunValue = $false
try {
    Get-ItemPropertyValue -LiteralPath $runKey -Name $productName -ErrorAction Stop | Out-Null
    $preexistingRunValue = $true
}
catch {}
$desktopShortcut = Join-Path ([Environment]::GetFolderPath("Desktop")) "$productName.lnk"
$programsShortcut = Join-Path ([Environment]::GetFolderPath("Programs")) "$productName.lnk"
$preexistingShortcut = (Test-Path -LiteralPath $desktopShortcut) -or
    (Test-Path -LiteralPath $programsShortcut)
$preexistingProcesses = @(Get-Process -Name "yuanyuan-reminder" -ErrorAction SilentlyContinue)
$preexistingRegistration = (Test-Path -LiteralPath $uninstallKey) -or
    (Test-Path -LiteralPath $productKey)
$dataRoot = Join-Path $localAppData $bundleIdentifier
$defaultInstallRoot = Join-Path $localAppData $productName
$preexistingDataRoot = Test-Path -LiteralPath $dataRoot
$preexistingDefaultInstallRoot = Test-Path -LiteralPath $defaultInstallRoot
if (
    -not $identity.IsAuthenticated -or
    -not $profileRegistryQueryAvailable -or
    -not $tokenProfilePathMatchesEnvironment -or
    -not $localAppDataMatchesTokenProfile -or
    $preexistingProcesses.Count -ne 0 -or
    $preexistingRegistration -or
    $preexistingDataRoot -or
    $preexistingDefaultInstallRoot -or
    $preexistingShortcut -or
    $preexistingRunValue
) {
    throw "install-failure probe requires a clean current-user product and data boundary with a matching token profile"
}

$runId = (Get-Date).ToUniversalTime().ToString("yyyyMMddTHHmmssfffZ")
$qaBase = Join-Path $localAppData "Temp"
$qaRoot = Join-Path $qaBase "yuanyuan-install-failure-$runId"
$installRoot = Join-Path $qaRoot "installed"
$qaMarkerName = ".yuanyuan-install-failure-v1"
$qaMarkerValue = "YUANYUAN_INSTALL_FAILURE_QA_V1`n"
$dataMarkerName = ".yuanyuan-install-failure-data-v1"
$dataMarkerValue = "YUANYUAN_INSTALL_FAILURE_DATA_V1`n"
$sentinelPath = Join-Path $dataRoot "install-failure-sentinel.txt"
$sentinelValue = "YUANYUAN_INSTALL_FAILURE_SENTINEL_V1:$runId`n"
$corruptedCandidatePath = Join-Path $qaRoot "candidate-half-truncated.exe"
$report = $null
$qaRootRemoved = $false
$dataRootRemoved = $false
$desktopShortcutRemoved = $false
$startMenuShortcutRemoved = $false

if ((Test-Path -LiteralPath $qaRoot) -or (Test-Path -LiteralPath $dataRoot)) {
    throw "refusing to reuse an existing install-failure probe boundary"
}
New-Item -ItemType Directory -Path $qaRoot | Out-Null
[IO.File]::WriteAllText(
    (Join-Path $qaRoot $qaMarkerName),
    $qaMarkerValue,
    [Text.UTF8Encoding]::new($false)
)
New-Item -ItemType Directory -Path $dataRoot | Out-Null
[IO.File]::WriteAllText(
    (Join-Path $dataRoot $dataMarkerName),
    $dataMarkerValue,
    [Text.UTF8Encoding]::new($false)
)
[IO.File]::WriteAllText($sentinelPath, $sentinelValue, [Text.UTF8Encoding]::new($false))
$sentinelSha256 = Get-Sha256 $sentinelPath
[IO.File]::Copy($candidateInstallerPath, $corruptedCandidatePath, $false)
$corruptedCandidateBytes = [long][math]::Floor($candidateInstallerBytes / 2)
$corruptedStream = [IO.File]::Open(
    $corruptedCandidatePath,
    [IO.FileMode]::Open,
    [IO.FileAccess]::Write,
    [IO.FileShare]::None
)
try { $corruptedStream.SetLength($corruptedCandidateBytes) }
finally { $corruptedStream.Dispose() }
$corruptedCandidateSha256 = Get-Sha256 $corruptedCandidatePath

try {
    $historicalInstallExitCode = Invoke-SilentInstall $historicalInstallerPath $installRoot
    $historicalState = Get-InstalledCoreState `
        $installRoot `
        $historicalVersion `
        $historicalInstalledCoreBytes `
        $historicalInstalledCoreSha256
    if ($historicalInstallExitCode -ne 0 -or -not $historicalState.installedCoreMatches) {
        throw "historical baseline installation did not produce the frozen old core"
    }
    $applicationPath = Join-Path $installRoot "yuanyuan-reminder.exe"
    $historicalCoreLastWriteTicks = [long](
        Get-Item -LiteralPath $applicationPath -Force
    ).LastWriteTimeUtc.Ticks
    $historicalUninstallerPath = Join-Path $installRoot "uninstall.exe"
    $historicalUninstallerSha256 = Get-Sha256 $historicalUninstallerPath
    $historicalLicenseFilesAbsent = Test-CurrentLicenseFilesAbsent $installRoot $expectedLicenseFiles
    $sentinelAfterHistoricalInstall = Test-Sentinel $sentinelPath $sentinelSha256

    $corruptedLaunch = Invoke-BoundedFailureInstall `
        $corruptedCandidatePath `
        $installRoot `
        $FailureTimeoutSeconds
    Start-Sleep -Milliseconds 750
    $stateAfterCorrupted = Get-InstalledCoreState `
        $installRoot `
        $historicalVersion `
        $historicalInstalledCoreBytes `
        $historicalInstalledCoreSha256
    $uninstallerPreservedAfterCorrupted =
        (Test-Path -LiteralPath $historicalUninstallerPath -PathType Leaf) -and
        (Get-Sha256 $historicalUninstallerPath) -eq $historicalUninstallerSha256
    $licensesAbsentAfterCorrupted = Test-CurrentLicenseFilesAbsent $installRoot $expectedLicenseFiles
    $sentinelAfterCorrupted = Test-Sentinel $sentinelPath $sentinelSha256

    $exclusiveLock = [IO.File]::Open(
        $applicationPath,
        [IO.FileMode]::Open,
        [IO.FileAccess]::Read,
        [IO.FileShare]::None
    )
    try {
        $obstructedLaunch = Invoke-BoundedFailureInstall `
            $candidateInstallerPath `
            $installRoot `
            $FailureTimeoutSeconds
    }
    finally {
        $exclusiveLock.Dispose()
    }
    Start-Sleep -Milliseconds 750
    $stateAfterObstruction = Get-InstalledCoreState `
        $installRoot `
        $historicalVersion `
        $historicalInstalledCoreBytes `
        $historicalInstalledCoreSha256
    $uninstallerPreservedAfterObstruction =
        (Test-Path -LiteralPath $historicalUninstallerPath -PathType Leaf) -and
        (Get-Sha256 $historicalUninstallerPath) -eq $historicalUninstallerSha256
    $licensesAbsentAfterObstruction = Test-CurrentLicenseFilesAbsent $installRoot $expectedLicenseFiles
    $sentinelAfterObstruction = Test-Sentinel $sentinelPath $sentinelSha256

    $writeTermination = Invoke-WriteBoundaryTerminationInstall `
        $candidateInstallerPath `
        $installRoot `
        $historicalInstalledCoreBytes `
        $historicalCoreLastWriteTicks `
        $FailureTimeoutSeconds
    $interruptionHistoricalState = Get-InstalledCoreState `
        $installRoot `
        $historicalVersion `
        $historicalInstalledCoreBytes `
        $historicalInstalledCoreSha256
    $interruptionCandidateState = Get-InstalledCoreState `
        $installRoot `
        $candidateVersion `
        $candidatePayloadBytes `
        $candidatePayloadSha256
    $interruptionCandidateCoreMatches =
        $interruptionCandidateState.applicationPresent -and
        $interruptionCandidateState.installedProductVersion -eq $candidateVersion -and
        $interruptionCandidateState.installedCoreBytes -eq $candidatePayloadBytes -and
        $interruptionCandidateState.installedCoreSha256 -eq $candidatePayloadSha256
    $interruptedUninstallerPresent = Test-Path `
        -LiteralPath $historicalUninstallerPath `
        -PathType Leaf
    $interruptedUninstallerSha256 = if ($interruptedUninstallerPresent) {
        Get-Sha256 $historicalUninstallerPath
    } else { $null }
    $interruptedLicenses = Test-CurrentLicenseBundle $installRoot $expectedLicenseFiles
    $interruptedFileSetChanged =
        -not $interruptionHistoricalState.installedCoreMatches -or
        $interruptedUninstallerSha256 -ne $historicalUninstallerSha256 -or
        -not (Test-CurrentLicenseFilesAbsent $installRoot $expectedLicenseFiles)
    $sentinelAfterWriteTermination = Test-Sentinel $sentinelPath $sentinelSha256

    $candidateRecoveryExitCode = Invoke-SilentInstall $candidateInstallerPath $installRoot
    $candidateRecoveryState = Get-InstalledCoreState `
        $installRoot `
        $candidateVersion `
        $candidatePayloadBytes `
        $candidatePayloadSha256
    $candidateRecoveryLicenses = Test-CurrentLicenseBundle $installRoot $expectedLicenseFiles
    $candidateRecoveryUninstallerSha256 = Get-Sha256 (Join-Path $installRoot "uninstall.exe")
    $interruptedFileSetIncomplete = -not (
        $interruptionCandidateCoreMatches -and
        $interruptedLicenses.licenseFilesExact -and
        $interruptedLicenses.licenseHashesMatch -and
        $interruptedUninstallerSha256 -eq $candidateRecoveryUninstallerSha256
    )
    $sentinelAfterRecovery = Test-Sentinel $sentinelPath $sentinelSha256

    $candidateUninstallExitCode = Invoke-SilentUninstall $installRoot
    $installRootRemovedAfterUninstall = -not (Test-Path -LiteralPath $installRoot)
    $sentinelAfterUninstall = Test-Sentinel $sentinelPath $sentinelSha256

    if (Test-Path -LiteralPath $uninstallKey) {
        $uninstallRoot = [string](Get-ItemProperty -LiteralPath $uninstallKey).InstallLocation
        if (-not (Test-SamePath $uninstallRoot $installRoot)) {
            throw "refusing to remove uninstall registration outside the owned QA installation"
        }
        Remove-Item -LiteralPath $uninstallKey -Recurse -Force -ErrorAction Stop
    }
    if (Test-Path -LiteralPath $productKey) {
        $productRoot = [string](Get-Item -LiteralPath $productKey).GetValue("")
        if (-not (Test-SamePath $productRoot $installRoot)) {
            throw "refusing to remove product registration outside the owned QA installation"
        }
        Remove-Item -LiteralPath $productKey -Recurse -Force -ErrorAction Stop
    }
    $desktopShortcutRemoved = Remove-OwnedShortcut `
        $desktopShortcut `
        (Join-Path $installRoot "yuanyuan-reminder.exe")
    $startMenuShortcutRemoved = Remove-OwnedShortcut `
        $programsShortcut `
        (Join-Path $installRoot "yuanyuan-reminder.exe")
    $dataRootRemoved = Remove-OwnedDirectory `
        $dataRoot `
        $dataMarkerName `
        $dataMarkerValue `
        $localAppData

    $report = [ordered]@{
        schemaVersion = 2
        generatedAt = (Get-Date).ToUniversalTime().ToString("o")
        mode = "release_install_failure_recovery_probe"
        ready = $false
        bindings = [ordered]@{
            probeScriptSha256 = Get-Sha256 $scriptPath
            historicalInstallerSha256 = Get-Sha256 $historicalInstallerPath
            historicalInstalledCoreSha256 = $historicalInstalledCoreSha256
            candidateInstallerSha256 = $candidateInstallerSha256
            candidateInstalledCoreSha256 = $candidatePayloadSha256
            candidateInstallerBytes = $candidateInstallerBytes
            corruptedCandidateSha256 = $corruptedCandidateSha256
            corruptedCandidateBytes = $corruptedCandidateBytes
        }
        versions = [ordered]@{
            historical = $historicalVersion
            candidate = $candidateVersion
        }
        environment = [ordered]@{
            currentUserAuthenticated = [bool]$identity.IsAuthenticated
            profileRegistryQueryAvailable = $profileRegistryQueryAvailable
            tokenProfilePathMatchesEnvironment = $tokenProfilePathMatchesEnvironment
            localAppDataMatchesTokenProfile = $localAppDataMatchesTokenProfile
            preexistingApplicationProcessCount = $preexistingProcesses.Count
            preexistingProductRegistration = $preexistingRegistration
            preexistingDataRoot = $preexistingDataRoot
            preexistingDefaultInstallRoot = $preexistingDefaultInstallRoot
            preexistingShortcut = $preexistingShortcut
            preexistingRunValue = $preexistingRunValue
            customTemporaryInstallRootUsed = $true
        }
        scenarios = [ordered]@{
            historicalBaseline = [ordered]@{
                installExitCode = $historicalInstallExitCode
                installedProductVersion = $historicalState.installedProductVersion
                installedCoreBytes = $historicalState.installedCoreBytes
                installedCoreSha256 = $historicalState.installedCoreSha256
                installedCoreMatches = $historicalState.installedCoreMatches
                uninstallerSha256 = $historicalUninstallerSha256
                currentLicenseFilesAbsent = $historicalLicenseFilesAbsent
                sentinelPreserved = $sentinelAfterHistoricalInstall
            }
            corruptedCandidate = [ordered]@{
                launchDisposition = $corruptedLaunch.launchDisposition
                rootExitCode = $corruptedLaunch.rootExitCode
                processTreeTimedOut = $corruptedLaunch.processTreeTimedOut
                processTreeTerminatedByProbe = $corruptedLaunch.processTreeTerminatedByProbe
                ownedProcessCountAfter = $corruptedLaunch.ownedProcessCountAfter
                maximumOwnedProcessCount = $corruptedLaunch.maximumOwnedProcessCount
                startErrorType = $corruptedLaunch.startErrorType
                installedProductVersion = $stateAfterCorrupted.installedProductVersion
                installedCoreBytes = $stateAfterCorrupted.installedCoreBytes
                installedCoreSha256 = $stateAfterCorrupted.installedCoreSha256
                oldCorePreserved = $stateAfterCorrupted.installedCoreMatches
                uninstallerPreserved = $uninstallerPreservedAfterCorrupted
                currentLicenseFilesAbsent = $licensesAbsentAfterCorrupted
                sentinelPreserved = $sentinelAfterCorrupted
            }
            fileReplacementObstruction = [ordered]@{
                exclusiveLockAcquired = $true
                launchDisposition = $obstructedLaunch.launchDisposition
                rootExitCode = $obstructedLaunch.rootExitCode
                processTreeTimedOut = $obstructedLaunch.processTreeTimedOut
                processTreeTerminatedByProbe = $obstructedLaunch.processTreeTerminatedByProbe
                ownedProcessCountAfter = $obstructedLaunch.ownedProcessCountAfter
                maximumOwnedProcessCount = $obstructedLaunch.maximumOwnedProcessCount
                startErrorType = $obstructedLaunch.startErrorType
                installedProductVersion = $stateAfterObstruction.installedProductVersion
                installedCoreBytes = $stateAfterObstruction.installedCoreBytes
                installedCoreSha256 = $stateAfterObstruction.installedCoreSha256
                oldCorePreserved = $stateAfterObstruction.installedCoreMatches
                uninstallerPreserved = $uninstallerPreservedAfterObstruction
                currentLicenseFilesAbsent = $licensesAbsentAfterObstruction
                sentinelPreserved = $sentinelAfterObstruction
            }
            successfulWriteTermination = [ordered]@{
                cpuHardCapPercent = $writeTermination.cpuHardCapPercent
                jobKillOnClose = $writeTermination.jobKillOnClose
                writeBoundaryObserved = $writeTermination.writeBoundaryObserved
                triggerMainExecutablePresent = $writeTermination.triggerMainExecutablePresent
                triggerMainExecutableBytes = $writeTermination.triggerMainExecutableBytes
                triggerReadErrorType = $writeTermination.triggerReadErrorType
                rootExitCode = $writeTermination.rootExitCode
                processTreeTerminatedByProbe = $writeTermination.processTreeTerminatedByProbe
                ownedProcessCountBeforeTermination =
                    $writeTermination.ownedProcessCountBeforeTermination
                ownedProcessCountAfter = $writeTermination.ownedProcessCountAfter
                maximumOwnedProcessCount = $writeTermination.maximumOwnedProcessCount
                installedProductVersion = $interruptionCandidateState.installedProductVersion
                installedCoreBytes = $interruptionCandidateState.installedCoreBytes
                installedCoreSha256 = $interruptionCandidateState.installedCoreSha256
                candidateCoreMatches = $interruptionCandidateCoreMatches
                oldCorePreserved = $interruptionHistoricalState.installedCoreMatches
                uninstallerPresent = $interruptedUninstallerPresent
                uninstallerSha256 = $interruptedUninstallerSha256
                historicalUninstallerPreserved =
                    $interruptedUninstallerSha256 -eq $historicalUninstallerSha256
                licenseFiles = @($interruptedLicenses.licenseFiles)
                licenseFilesExact = $interruptedLicenses.licenseFilesExact
                licenseHashesMatch = $interruptedLicenses.licenseHashesMatch
                interruptedFileSetChanged = $interruptedFileSetChanged
                interruptedFileSetIncomplete = $interruptedFileSetIncomplete
                sentinelPreserved = $sentinelAfterWriteTermination
            }
            candidateRecovery = [ordered]@{
                installExitCode = $candidateRecoveryExitCode
                installedProductVersion = $candidateRecoveryState.installedProductVersion
                installedCoreBytes = $candidateRecoveryState.installedCoreBytes
                installedCoreSha256 = $candidateRecoveryState.installedCoreSha256
                installedCoreMatches = $candidateRecoveryState.installedCoreMatches
                licenseFiles = @($candidateRecoveryLicenses.licenseFiles)
                licenseFilesExact = $candidateRecoveryLicenses.licenseFilesExact
                licenseHashesMatch = $candidateRecoveryLicenses.licenseHashesMatch
                uninstallerSha256 = $candidateRecoveryUninstallerSha256
                sentinelPreserved = $sentinelAfterRecovery
            }
            candidateUninstall = [ordered]@{
                uninstallExitCode = $candidateUninstallExitCode
                installRootRemoved = $installRootRemovedAfterUninstall
                sentinelPreserved = $sentinelAfterUninstall
            }
        }
        dataBoundary = [ordered]@{
            defaultLocalDataDirectoryUsed = $true
            syntheticSentinelOnly = $true
            authenticHistoricalDatabaseUsed = $false
            sentinelSha256 = $sentinelSha256
            sentinelPreservedAtEveryStep = $sentinelAfterHistoricalInstall -and
                $sentinelAfterCorrupted -and
                $sentinelAfterObstruction -and
                $sentinelAfterWriteTermination -and
                $sentinelAfterRecovery -and
                $sentinelAfterUninstall
        }
        cleanup = [ordered]@{
            ownedRegistrationRemoved = -not (Test-Path -LiteralPath $uninstallKey) -and
                -not (Test-Path -LiteralPath $productKey)
            unexpectedDefaultInstallRootAbsent = -not (
                Test-Path -LiteralPath $defaultInstallRoot
            )
            desktopShortcutRemoved = $desktopShortcutRemoved
            startMenuShortcutRemoved = $startMenuShortcutRemoved
            dataRootRemoved = $dataRootRemoved
            qaRootRemoved = $false
            applicationProcessCount = @(Get-Process -Name "yuanyuan-reminder" -ErrorAction SilentlyContinue).Count
            installerProcessCount = $corruptedLaunch.ownedProcessCountAfter +
                $obstructedLaunch.ownedProcessCountAfter +
                $writeTermination.ownedProcessCountAfter
        }
        limitations = $limitations
    }
}
finally {
    if (Test-Path -LiteralPath (Join-Path $installRoot "uninstall.exe") -PathType Leaf) {
        try { Invoke-SilentUninstall $installRoot | Out-Null } catch {}
    }
    if (Test-Path -LiteralPath $uninstallKey) {
        try {
            $uninstallRoot = [string](Get-ItemProperty -LiteralPath $uninstallKey).InstallLocation
            if (Test-SamePath $uninstallRoot $installRoot) {
                Remove-Item -LiteralPath $uninstallKey -Recurse -Force -ErrorAction SilentlyContinue
            }
        }
        catch {}
    }
    if (Test-Path -LiteralPath $productKey) {
        try {
            $productRoot = [string](Get-Item -LiteralPath $productKey).GetValue("")
            if (Test-SamePath $productRoot $installRoot) {
                Remove-Item -LiteralPath $productKey -Recurse -Force -ErrorAction SilentlyContinue
            }
        }
        catch {}
    }
    try {
        $desktopShortcutRemoved = Remove-OwnedShortcut `
            $desktopShortcut `
            (Join-Path $installRoot "yuanyuan-reminder.exe")
    } catch {}
    try {
        $startMenuShortcutRemoved = Remove-OwnedShortcut `
            $programsShortcut `
            (Join-Path $installRoot "yuanyuan-reminder.exe")
    } catch {}
    if (Test-Path -LiteralPath $dataRoot -PathType Container) {
        $dataRootRemoved = Remove-OwnedDirectory `
            $dataRoot `
            $dataMarkerName `
            $dataMarkerValue `
            $localAppData
    }
    $qaRootRemoved = Remove-OwnedDirectory `
        $qaRoot `
        $qaMarkerName `
        $qaMarkerValue `
        $qaBase
}

if ($null -eq $report) {
    throw "install-failure probe did not produce a report"
}
$report.cleanup.desktopShortcutRemoved = $desktopShortcutRemoved
$report.cleanup.startMenuShortcutRemoved = $startMenuShortcutRemoved
$report.cleanup.dataRootRemoved = $dataRootRemoved
$report.cleanup.qaRootRemoved = $qaRootRemoved
$report.cleanup.unexpectedDefaultInstallRootAbsent = -not (
    Test-Path -LiteralPath $defaultInstallRoot
)
$failedDisposition = @("start_rejected", "exited_nonzero", "terminated_after_timeout")
$report.ready =
    $report.environment.currentUserAuthenticated -and
    $report.environment.profileRegistryQueryAvailable -and
    $report.environment.tokenProfilePathMatchesEnvironment -and
    $report.environment.localAppDataMatchesTokenProfile -and
    $report.environment.preexistingApplicationProcessCount -eq 0 -and
    -not $report.environment.preexistingProductRegistration -and
    -not $report.environment.preexistingDataRoot -and
    -not $report.environment.preexistingDefaultInstallRoot -and
    -not $report.environment.preexistingShortcut -and
    -not $report.environment.preexistingRunValue -and
    $report.environment.customTemporaryInstallRootUsed -and
    $report.scenarios.historicalBaseline.installExitCode -eq 0 -and
    $report.scenarios.historicalBaseline.installedCoreMatches -and
    $report.scenarios.historicalBaseline.currentLicenseFilesAbsent -and
    $report.scenarios.historicalBaseline.sentinelPreserved -and
    $failedDisposition -contains $report.scenarios.corruptedCandidate.launchDisposition -and
    $report.scenarios.corruptedCandidate.ownedProcessCountAfter -eq 0 -and
    $report.scenarios.corruptedCandidate.oldCorePreserved -and
    $report.scenarios.corruptedCandidate.uninstallerPreserved -and
    $report.scenarios.corruptedCandidate.currentLicenseFilesAbsent -and
    $report.scenarios.corruptedCandidate.sentinelPreserved -and
    $report.scenarios.fileReplacementObstruction.exclusiveLockAcquired -and
    $failedDisposition -contains $report.scenarios.fileReplacementObstruction.launchDisposition -and
    $report.scenarios.fileReplacementObstruction.ownedProcessCountAfter -eq 0 -and
    $report.scenarios.fileReplacementObstruction.oldCorePreserved -and
    $report.scenarios.fileReplacementObstruction.uninstallerPreserved -and
    $report.scenarios.fileReplacementObstruction.currentLicenseFilesAbsent -and
    $report.scenarios.fileReplacementObstruction.sentinelPreserved -and
    $report.scenarios.successfulWriteTermination.cpuHardCapPercent -eq 1 -and
    $report.scenarios.successfulWriteTermination.jobKillOnClose -and
    $report.scenarios.successfulWriteTermination.writeBoundaryObserved -and
    $report.scenarios.successfulWriteTermination.triggerMainExecutablePresent -and
    $report.scenarios.successfulWriteTermination.triggerMainExecutableBytes -gt 0 -and
    $report.scenarios.successfulWriteTermination.triggerMainExecutableBytes -lt
        $candidatePayloadBytes -and
    $null -eq $report.scenarios.successfulWriteTermination.triggerReadErrorType -and
    $report.scenarios.successfulWriteTermination.rootExitCode -eq 1 -and
    $report.scenarios.successfulWriteTermination.processTreeTerminatedByProbe -and
    $report.scenarios.successfulWriteTermination.ownedProcessCountBeforeTermination -ge 1 -and
    $report.scenarios.successfulWriteTermination.ownedProcessCountAfter -eq 0 -and
    $report.scenarios.successfulWriteTermination.maximumOwnedProcessCount -ge 1 -and
    $report.scenarios.successfulWriteTermination.installedCoreBytes -gt 0 -and
    $report.scenarios.successfulWriteTermination.installedCoreBytes -lt
        $candidatePayloadBytes -and
    -not $report.scenarios.successfulWriteTermination.candidateCoreMatches -and
    -not $report.scenarios.successfulWriteTermination.oldCorePreserved -and
    $report.scenarios.successfulWriteTermination.uninstallerPresent -and
    $report.scenarios.successfulWriteTermination.historicalUninstallerPreserved -and
    $report.scenarios.successfulWriteTermination.licenseFiles.Count -eq 0 -and
    -not $report.scenarios.successfulWriteTermination.licenseFilesExact -and
    -not $report.scenarios.successfulWriteTermination.licenseHashesMatch -and
    $report.scenarios.successfulWriteTermination.interruptedFileSetChanged -and
    $report.scenarios.successfulWriteTermination.interruptedFileSetIncomplete -and
    $report.scenarios.successfulWriteTermination.sentinelPreserved -and
    $report.scenarios.candidateRecovery.installExitCode -eq 0 -and
    $report.scenarios.candidateRecovery.installedCoreMatches -and
    $report.scenarios.candidateRecovery.licenseFilesExact -and
    $report.scenarios.candidateRecovery.licenseHashesMatch -and
    $report.scenarios.candidateRecovery.sentinelPreserved -and
    $report.scenarios.candidateUninstall.uninstallExitCode -eq 0 -and
    $report.scenarios.candidateUninstall.installRootRemoved -and
    $report.scenarios.candidateUninstall.sentinelPreserved -and
    $report.dataBoundary.defaultLocalDataDirectoryUsed -and
    $report.dataBoundary.syntheticSentinelOnly -and
    -not $report.dataBoundary.authenticHistoricalDatabaseUsed -and
    $report.dataBoundary.sentinelPreservedAtEveryStep -and
    $report.cleanup.ownedRegistrationRemoved -and
    $report.cleanup.unexpectedDefaultInstallRootAbsent -and
    $report.cleanup.desktopShortcutRemoved -and
    $report.cleanup.startMenuShortcutRemoved -and
    $report.cleanup.dataRootRemoved -and
    $report.cleanup.qaRootRemoved -and
    $report.cleanup.applicationProcessCount -eq 0 -and
    $report.cleanup.installerProcessCount -eq 0

$report | ConvertTo-Json -Depth 10 | Set-Content -Encoding UTF8 -LiteralPath $reportPath
Write-Output "Release install-failure recovery probe report written: $reportPath"
if (-not $report.ready) { exit 2 }
