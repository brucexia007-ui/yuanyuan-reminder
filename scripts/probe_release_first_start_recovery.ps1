param(
    [string]$ReleaseRoot = "",
    [ValidateRange(5, 60)]
    [int]$WindowTimeoutSeconds = 30,
    [switch]$AcknowledgeFreshTestAccount
)

$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"

$projectRoot = Split-Path -Parent $PSScriptRoot
if ([string]::IsNullOrWhiteSpace($ReleaseRoot)) {
    $ReleaseRoot = Join-Path $projectRoot "src-tauri\target\release"
}
$releaseRoot = [IO.Path]::GetFullPath($ReleaseRoot)
$manifestPath = Join-Path $releaseRoot "release-manifest.json"
$candidatePath = Join-Path $releaseRoot "nsis-payload\yuanyuan-reminder.exe"
$captureHelperPath = Join-Path $PSScriptRoot "capture_first_start_recovery_database.mjs"
$reportPath = Join-Path $releaseRoot "release-first-start-recovery-probe.json"
$fixturePath = Join-Path $releaseRoot "release-first-start-recovery.sqlite3"
$captureReportPath = Join-Path $releaseRoot "release-first-start-recovery-database.json"
$scriptSha256 = (Get-FileHash -LiteralPath $MyInvocation.MyCommand.Path -Algorithm SHA256).Hash
$captureHelperSha256 = (Get-FileHash -LiteralPath $captureHelperPath -Algorithm SHA256).Hash
$brandConfig = Get-Content -Raw -Encoding UTF8 -LiteralPath (
    Join-Path $projectRoot "product-brand.json"
) | ConvertFrom-Json
if ([string]::IsNullOrWhiteSpace([string]$brandConfig.storage.directoryName) -or
    [string]::IsNullOrWhiteSpace([string]$brandConfig.storage.mainDatabaseFile)) {
    throw "product brand storage directory and main database file are required"
}
$formalDataLeaf = [string]$brandConfig.storage.directoryName
$mainDatabaseFile = [string]$brandConfig.storage.mainDatabaseFile
$localDataRoot = [Environment]::GetFolderPath(
    [Environment+SpecialFolder]::LocalApplicationData
)
$formalDataRoot = Join-Path $localDataRoot $formalDataLeaf
$databasePath = Join-Path $formalDataRoot $mainDatabaseFile
$walPath = "$databasePath-wal"
$shmPath = "$databasePath-shm"
$runId = "{0}-{1}" -f
    (Get-Date).ToUniversalTime().ToString("yyyyMMddTHHmmssZ"),
    [Guid]::NewGuid().ToString("N")
$ownershipValue = "YUANYUAN_RELEASE_FIRST_START_RECOVERY_V1:$runId`n"
$dataMarkerName = ".yuanyuan-release-first-start-recovery-data-v1"
$stageMarkerName = ".yuanyuan-release-first-start-recovery-stage-v1"
$evidenceMarkerName = ".yuanyuan-release-first-start-recovery-evidence-v1"
$dataMarker = Join-Path $formalDataRoot $dataMarkerName
$stageRoot = Join-Path $releaseRoot "first-start-stage-$runId"
$stageMarker = Join-Path $stageRoot $stageMarkerName
$stagedCandidate = Join-Path $stageRoot "yuanyuan-reminder.exe"
$evidenceTempRoot = Join-Path $releaseRoot "first-start-evidence-$runId"
$evidenceMarker = Join-Path $evidenceTempRoot $evidenceMarkerName
$temporaryFixture = Join-Path $evidenceTempRoot (Split-Path -Leaf $fixturePath)
$temporaryCaptureReport = Join-Path $evidenceTempRoot (Split-Path -Leaf $captureReportPath)
$limitations = @(
    "This uses a byte-identical staged copy of the current NSIS-installed core and an empty synthetic formal data directory in an explicitly acknowledged disposable Windows account.",
    "It terminates a 1%-CPU-capped Windows Job immediately after observing a non-empty SQLite WAL, then verifies recovery by relaunching the same unmodified candidate and inspecting a canonical sidecar-free database fixture.",
    "It proves controlled process-termination recovery, not physical power loss or system restart, and uses no authentic historical or user-authored database.",
    "Signed-candidate identity, SmartScreen, security-software, default installer registration, and manual release signoff remain separate gates."
)

if (-not ("YuanyuanFirstStartProcessSnapshot" -as [type])) {
    Add-Type -TypeDefinition @"
using System;
using System.Collections.Generic;
using System.ComponentModel;
using System.Runtime.InteropServices;

public sealed class YuanyuanFirstStartProcessRelation {
    public uint ProcessId { get; set; }
    public uint ParentProcessId { get; set; }
}

public static class YuanyuanFirstStartProcessSnapshot {
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

    public static YuanyuanFirstStartProcessRelation[] Capture() {
        var snapshot = CreateToolhelp32Snapshot(SnapshotProcesses, 0);
        if (snapshot == new IntPtr(-1)) {
            throw new Win32Exception(Marshal.GetLastWin32Error());
        }
        try {
            var rows = new List<YuanyuanFirstStartProcessRelation>();
            var entry = new ProcessEntry { Size = (uint)Marshal.SizeOf(typeof(ProcessEntry)) };
            if (Process32First(snapshot, ref entry)) {
                do {
                    rows.Add(new YuanyuanFirstStartProcessRelation {
                        ProcessId = entry.ProcessId,
                        ParentProcessId = entry.ParentProcessId
                    });
                    entry.Size = (uint)Marshal.SizeOf(typeof(ProcessEntry));
                } while (Process32Next(snapshot, ref entry));
            }
            return rows.ToArray();
        }
        finally { CloseHandle(snapshot); }
    }
}

public sealed class YuanyuanFirstStartJobProcess : IDisposable {
    private const uint CreateSuspended = 0x00000004;
    private const uint CreateUnicodeEnvironment = 0x00000400;
    private const uint JobObjectLimitKillOnJobClose = 0x00002000;
    private const uint CpuRateControlEnable = 0x00000001;
    private const uint CpuRateControlHardCap = 0x00000004;
    private const int JobObjectExtendedLimitInformation = 9;
    private const int JobObjectCpuRateControlInformation = 15;

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
        IntPtr job, int informationClass, ref ExtendedLimitInformation information,
        uint informationLength);
    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool SetInformationJobObject(
        IntPtr job, int informationClass, ref CpuRateControlInformation information,
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

    private YuanyuanFirstStartJobProcess() { }

    public static YuanyuanFirstStartJobProcess Start(string executable, uint cpuRate) {
        var owned = new YuanyuanFirstStartJobProcess();
        try {
            owned.job = CreateJobObjectW(IntPtr.Zero, null);
            if (owned.job == IntPtr.Zero) {
                throw new Win32Exception(Marshal.GetLastWin32Error());
            }
            var limits = new ExtendedLimitInformation();
            limits.BasicLimitInformation.LimitFlags = JobObjectLimitKillOnJobClose;
            if (!SetInformationJobObject(
                    owned.job, JobObjectExtendedLimitInformation, ref limits,
                    (uint)Marshal.SizeOf(typeof(ExtendedLimitInformation)))) {
                throw new Win32Exception(Marshal.GetLastWin32Error());
            }
            var cpu = new CpuRateControlInformation {
                ControlFlags = CpuRateControlEnable | CpuRateControlHardCap,
                CpuRate = cpuRate
            };
            if (!SetInformationJobObject(
                    owned.job, JobObjectCpuRateControlInformation, ref cpu,
                    (uint)Marshal.SizeOf(typeof(CpuRateControlInformation)))) {
                throw new Win32Exception(Marshal.GetLastWin32Error());
            }
            var startup = new StartupInfo { Size = (uint)Marshal.SizeOf(typeof(StartupInfo)) };
            var commandLine = new System.Text.StringBuilder("\"" + executable + "\"");
            ProcessInformation created;
            if (!CreateProcessW(
                    executable, commandLine, IntPtr.Zero, IntPtr.Zero, false,
                    CreateSuspended | CreateUnicodeEnvironment, IntPtr.Zero,
                    System.IO.Path.GetDirectoryName(executable), ref startup, out created)) {
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
        catch { owned.Dispose(); throw; }
    }

    public void Terminate(uint exitCode) {
        if (job == IntPtr.Zero) { return; }
        if (!TerminateJobObject(job, exitCode)) {
            throw new Win32Exception(Marshal.GetLastWin32Error());
        }
        WaitForSingleObject(process, 10000);
    }

    public int? ExitCode {
        get {
            uint code;
            if (process == IntPtr.Zero || !GetExitCodeProcess(process, out code) || code == 259) {
                return null;
            }
            return unchecked((int)code);
        }
    }

    public void Dispose() {
        if (job != IntPtr.Zero) { TerminateJobObject(job, 1); }
        if (thread != IntPtr.Zero) { CloseHandle(thread); thread = IntPtr.Zero; }
        if (process != IntPtr.Zero) { CloseHandle(process); process = IntPtr.Zero; }
        if (job != IntPtr.Zero) { CloseHandle(job); job = IntPtr.Zero; }
    }
}

public static class YuanyuanFirstStartWindowProbe {
    private delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);
    [DllImport("user32.dll")]
    private static extern bool EnumWindows(EnumWindowsProc callback, IntPtr lParam);
    [DllImport("user32.dll")]
    private static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint processId);
    [DllImport("user32.dll")]
    private static extern bool IsWindowVisible(IntPtr hWnd);

    public static bool HasVisibleWindow(int processId) {
        bool found = false;
        EnumWindows((hWnd, lParam) => {
            uint owner;
            GetWindowThreadProcessId(hWnd, out owner);
            if (owner == (uint)processId && IsWindowVisible(hWnd)) {
                found = true;
                return false;
            }
            return true;
        }, IntPtr.Zero);
        return found;
    }
}
"@
}

function Get-Sha256([string]$Path) {
    (Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash
}

function Get-OwnedProcessIds([int]$RootProcessId) {
    $rootProcess = Get-Process -Id $RootProcessId -ErrorAction SilentlyContinue
    if ($null -eq $rootProcess) { return @() }
    try { $rootStartUtc = $rootProcess.StartTime.ToUniversalTime() }
    catch { throw "root_process_identity_unavailable" }
    $rows = @([YuanyuanFirstStartProcessSnapshot]::Capture())
    $owned = [System.Collections.Generic.HashSet[uint32]]::new()
    $owned.Add([uint32]$RootProcessId) | Out-Null
    do {
        $added = $false
        foreach ($row in $rows) {
            if ($owned.Contains([uint32]$row.ParentProcessId) -and
                -not $owned.Contains([uint32]$row.ProcessId)) {
                $candidateProcess = Get-Process -Id ([int]$row.ProcessId) -ErrorAction SilentlyContinue
                if ($null -eq $candidateProcess) { continue }
                try { $candidateStartUtc = $candidateProcess.StartTime.ToUniversalTime() }
                catch { continue }
                # A live process whose recorded parent PID was later reused by this launch is not owned.
                if ($candidateStartUtc -lt $rootStartUtc) { continue }
                $owned.Add([uint32]$row.ProcessId) | Out-Null
                $added = $true
            }
        }
    } while ($added)
    @($owned | ForEach-Object { [int]$_ })
}

function Stop-OwnedProcessTree([int]$RootProcessId) {
    $observed = [System.Collections.Generic.HashSet[int]]::new()
    for ($attempt = 0; $attempt -lt 3; $attempt += 1) {
        $owned = @(Get-OwnedProcessIds $RootProcessId)
        foreach ($processId in $owned) { $observed.Add([int]$processId) | Out-Null }
        foreach ($processId in @($owned | Sort-Object -Descending)) {
            Stop-Process -Id $processId -Force -ErrorAction SilentlyContinue
        }
        foreach ($processId in $owned) {
            Wait-Process -Id $processId -Timeout 5 -ErrorAction SilentlyContinue
        }
        if (-not (Get-Process -Id $RootProcessId -ErrorAction SilentlyContinue)) { break }
    }
    if (@($observed | Where-Object { Get-Process -Id $_ -ErrorAction SilentlyContinue }).Count -gt 0) {
        throw "candidate_process_tree_not_stopped"
    }
}

function Assert-OrdinaryExactDirectory(
    [string]$Path,
    [string]$ExpectedParent,
    [string]$ExpectedLeaf
) {
    $item = Get-Item -LiteralPath $Path -Force
    if (-not $item.PSIsContainer -or
        (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0)) {
        throw "owned_directory_is_not_ordinary"
    }
    $canonicalPath = (Resolve-Path -LiteralPath $Path).Path
    $canonicalParent = (Resolve-Path -LiteralPath $ExpectedParent).Path
    $canonicalItem = Get-Item -LiteralPath $canonicalPath -Force
    if (-not $canonicalItem.Parent.FullName.Equals(
            $canonicalParent,
            [StringComparison]::OrdinalIgnoreCase
        ) -or $canonicalItem.Name -ne $ExpectedLeaf) {
        throw "owned_directory_escaped_expected_parent"
    }
}

function New-OwnedDirectory(
    [string]$Path,
    [string]$Parent,
    [string]$Leaf,
    [string]$Marker
) {
    if (Test-Path -LiteralPath $Path) { throw "owned_directory_preexists" }
    New-Item -ItemType Directory -Path $Path | Out-Null
    Assert-OrdinaryExactDirectory $Path $Parent $Leaf
    [IO.File]::WriteAllText($Marker, $ownershipValue, [Text.UTF8Encoding]::new($false))
}

function Remove-OwnedDirectory(
    [string]$Path,
    [string]$Parent,
    [string]$Leaf,
    [string]$Marker
) {
    if (-not (Test-Path -LiteralPath $Path -PathType Container)) { return $true }
    Assert-OrdinaryExactDirectory $Path $Parent $Leaf
    if (-not (Test-Path -LiteralPath $Marker -PathType Leaf) -or
        (Get-Content -Raw -Encoding UTF8 -LiteralPath $Marker) -ne $ownershipValue) {
        throw "refusing_to_remove_unowned_directory"
    }
    $deadline = [DateTime]::UtcNow.AddSeconds(10)
    do {
        try { Remove-Item -LiteralPath $Path -Recurse -Force -ErrorAction Stop }
        catch {
            if ([DateTime]::UtcNow -ge $deadline) { throw "owned_directory_cleanup_failed" }
        }
        if (-not (Test-Path -LiteralPath $Path)) { return $true }
        Start-Sleep -Milliseconds 200
    } while ([DateTime]::UtcNow -lt $deadline)
    throw "owned_directory_cleanup_failed"
}

function Get-ApplicationErrors([datetime]$StartUtc) {
    $readErrors = @()
    $eventErrors = @(Get-WinEvent -FilterHashtable @{
        LogName = "Application"
        StartTime = $StartUtc.ToLocalTime()
        Level = 2
    } -ErrorAction SilentlyContinue -ErrorVariable readErrors |
        Where-Object { $_.Message -like "*yuanyuan-reminder*" })
    $unexpected = @($readErrors | Where-Object {
        $_.FullyQualifiedErrorId -notlike "NoMatchingEventsFound*"
    })
    [ordered]@{
        queryAvailable = $unexpected.Count -eq 0
        count = $eventErrors.Count
    }
}

function Get-FileEvidence([string]$Path) {
    $present = Test-Path -LiteralPath $Path -PathType Leaf
    [ordered]@{
        present = $present
        bytes = if ($present) { [long](Get-Item -LiteralPath $Path).Length } else { 0L }
        sha256 = if ($present) { Get-Sha256 $Path } else { $null }
    }
}

if (-not $AcknowledgeFreshTestAccount) {
    throw "pass -AcknowledgeFreshTestAccount only in a disposable Windows test account"
}
foreach ($requiredPath in @($manifestPath, $candidatePath, $captureHelperPath)) {
    if (-not (Test-Path -LiteralPath $requiredPath -PathType Leaf)) {
        throw "release candidate, manifest, or capture helper is missing"
    }
}

$profileRegistryQueryAvailable = $false
$tokenProfilePathMatchesEnvironment = $false
try {
    $currentSid = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value
    $profileKey = "Registry::HKEY_LOCAL_MACHINE\SOFTWARE\Microsoft\Windows NT\CurrentVersion\ProfileList\$currentSid"
    $registeredProfile = [Environment]::ExpandEnvironmentVariables(
        (Get-ItemProperty -LiteralPath $profileKey -Name ProfileImagePath -ErrorAction Stop).ProfileImagePath
    )
    $environmentProfile = [Environment]::GetFolderPath([Environment+SpecialFolder]::UserProfile)
    $registeredProfilePath = (Resolve-Path -LiteralPath $registeredProfile).Path
    $environmentProfilePath = (Resolve-Path -LiteralPath $environmentProfile).Path
    $expectedLocalDataPath = (Resolve-Path -LiteralPath (
        Join-Path $registeredProfilePath "AppData\Local"
    )).Path
    $profileRegistryQueryAvailable = $true
    $tokenProfilePathMatchesEnvironment =
        $registeredProfilePath.Equals(
            $environmentProfilePath,
            [StringComparison]::OrdinalIgnoreCase
        ) -and
        $expectedLocalDataPath.Equals(
            (Resolve-Path -LiteralPath $localDataRoot).Path,
            [StringComparison]::OrdinalIgnoreCase
        )
}
catch {
    $profileRegistryQueryAvailable = $false
    $tokenProfilePathMatchesEnvironment = $false
}

$manifest = Get-Content -Raw -Encoding UTF8 -LiteralPath $manifestPath | ConvertFrom-Json
$candidateArtifact = @($manifest.artifacts | Where-Object { $_.id -eq "nsis_installed_core" })
if ($candidateArtifact.Count -ne 1) {
    throw "release manifest must contain exactly one nsis_installed_core artifact"
}
$manifestSha256 = Get-Sha256 $manifestPath
$candidateSha256 = Get-Sha256 $candidatePath
$candidateBytes = [long](Get-Item -LiteralPath $candidatePath).Length
if ($candidateSha256 -ne $candidateArtifact[0].sha256 -or
    $candidateBytes -ne [long]$candidateArtifact[0].bytes) {
    throw "release candidate does not match the manifest"
}

$bindings = [ordered]@{
    probeScriptSha256 = $scriptSha256
    captureHelperSha256 = $captureHelperSha256
    manifestSha256 = $manifestSha256
    candidateArtifactId = "nsis_installed_core"
    candidateBytes = $candidateBytes
    candidateSha256 = $candidateSha256
    stagedCandidateSha256 = $null
    databaseCaptureReportSha256 = $null
    databaseFixtureSha256 = $null
}
$environment = [ordered]@{
    interactiveSession = [Environment]::UserInteractive
    freshTestAccountAcknowledged = [bool]$AcknowledgeFreshTestAccount
    profileRegistryQueryAvailable = $profileRegistryQueryAvailable
    tokenProfilePathMatchesEnvironment = $tokenProfilePathMatchesEnvironment
    localAppDataMatchesTokenProfile = $tokenProfilePathMatchesEnvironment
    preexistingDataRoot = Test-Path -LiteralPath $formalDataRoot
    preexistingApplicationProcessCount = @(
        Get-Process -Name "yuanyuan-reminder" -ErrorAction SilentlyContinue
    ).Count
    emptyFormalDataRootProvisionedByProbe = $false
}
$interruption = [ordered]@{
    method = "windows_job_cpu_hard_cap_then_terminate_after_nonzero_wal"
    cpuHardCapPercent = 1
    jobKillOnClose = $true
    walWatcherArmed = $false
    walChangeObserved = $false
    walNonzeroObserved = $false
    triggerMainDatabaseBytes = 0L
    triggerWalBytes = 0L
    ownedProcessCountBeforeTermination = 0
    jobTerminationRequested = $false
    rootExitCode = $null
    processCountAfterTermination = $null
    mainDatabaseAfterTermination = $null
    walAfterTermination = $null
    shmAfterTermination = $null
}
$recovery = [ordered]@{
    sameCandidateRelaunched = $false
    visibleWindowObserved = $false
    ownedProcessCount = 0
    aiChildProcessCount = 0
    applicationErrorQueryAvailable = $false
    applicationErrorCount = $null
    processCountAfterProbeStop = $null
    databaseCapture = $null
}
$cleanup = [ordered]@{
    formalDataRootRemoved = $false
    stageRootRemoved = $false
    evidenceTempRootRemoved = $false
    applicationProcessCount = $null
}

$failureCode = $null
$jobProcess = $null
$recoveryProcess = $null
$watcher = $null
$capture = $null
$dataOwned = $false
$stageOwned = $false
$evidenceOwned = $false
$outputsFinalized = $false

try {
    if (-not $environment.interactiveSession) { throw "interactive_session_unavailable" }
    if (-not $environment.profileRegistryQueryAvailable) {
        throw "profile_registry_query_unavailable"
    }
    if (-not $environment.tokenProfilePathMatchesEnvironment) {
        throw "test_account_profile_mismatch"
    }
    if ($environment.preexistingDataRoot) { throw "preexisting_formal_data_root" }
    if ($environment.preexistingApplicationProcessCount -ne 0) {
        throw "preexisting_application_process"
    }

    New-OwnedDirectory `
        $stageRoot `
        $releaseRoot `
        "first-start-stage-$runId" `
        $stageMarker
    $stageOwned = $true
    Copy-Item -LiteralPath $candidatePath -Destination $stagedCandidate
    $bindings.stagedCandidateSha256 = Get-Sha256 $stagedCandidate
    if ($bindings.stagedCandidateSha256 -ne $candidateSha256) {
        throw "staged_candidate_hash_mismatch"
    }

    New-OwnedDirectory `
        $evidenceTempRoot `
        $releaseRoot `
        "first-start-evidence-$runId" `
        $evidenceMarker
    $evidenceOwned = $true
    New-OwnedDirectory `
        $formalDataRoot `
        $localDataRoot `
        $formalDataLeaf `
        $dataMarker
    $dataOwned = $true
    $environment.emptyFormalDataRootProvisionedByProbe = $true

    $watcher = [IO.FileSystemWatcher]::new($formalDataRoot, "$mainDatabaseFile-wal")
    $watcher.NotifyFilter = [IO.NotifyFilters]::FileName -bor
        [IO.NotifyFilters]::Size -bor [IO.NotifyFilters]::LastWrite
    $watcher.EnableRaisingEvents = $true
    $interruption.walWatcherArmed = $true

    $launchUtc = (Get-Date).ToUniversalTime()
    $jobProcess = [YuanyuanFirstStartJobProcess]::Start($stagedCandidate, 100)
    $deadline = [DateTime]::UtcNow.AddSeconds($WindowTimeoutSeconds)
    $changeKinds = [IO.WatcherChangeTypes]::Created -bor [IO.WatcherChangeTypes]::Changed
    while ([DateTime]::UtcNow -lt $deadline) {
        $change = $watcher.WaitForChanged($changeKinds, 20)
        if (-not $change.TimedOut) { $interruption.walChangeObserved = $true }
        if ((Test-Path -LiteralPath $databasePath -PathType Leaf) -and
            (Test-Path -LiteralPath $walPath -PathType Leaf)) {
            $mainBytes = [long](Get-Item -LiteralPath $databasePath).Length
            $walBytes = [long](Get-Item -LiteralPath $walPath).Length
            if ($mainBytes -gt 0 -and $walBytes -gt 0) {
                $interruption.walNonzeroObserved = $true
                $interruption.triggerMainDatabaseBytes = $mainBytes
                $interruption.triggerWalBytes = $walBytes
                break
            }
        }
    }
    if (-not $interruption.walNonzeroObserved) { throw "nonzero_wal_not_observed" }

    $interruption.ownedProcessCountBeforeTermination = @(
        Get-OwnedProcessIds $jobProcess.ProcessId
    ).Count
    $jobProcess.Terminate(1)
    $interruption.jobTerminationRequested = $true
    $interruption.rootExitCode = $jobProcess.ExitCode
    $jobProcess.Dispose()
    $jobProcess = $null
    Start-Sleep -Milliseconds 500
    $interruption.processCountAfterTermination = @(
        Get-Process -Name "yuanyuan-reminder" -ErrorAction SilentlyContinue
    ).Count
    $interruption.mainDatabaseAfterTermination = Get-FileEvidence $databasePath
    $interruption.walAfterTermination = Get-FileEvidence $walPath
    $interruption.shmAfterTermination = Get-FileEvidence $shmPath

    $recovery.sameCandidateRelaunched = (Get-Sha256 $stagedCandidate) -eq $candidateSha256
    $recoveryProcess = Start-Process -FilePath $stagedCandidate -PassThru -WindowStyle Normal
    $deadline = [DateTime]::UtcNow.AddSeconds($WindowTimeoutSeconds)
    while ([DateTime]::UtcNow -lt $deadline) {
        $recoveryProcess.Refresh()
        if ($recoveryProcess.HasExited) { break }
        if ([YuanyuanFirstStartWindowProbe]::HasVisibleWindow($recoveryProcess.Id)) {
            $recovery.visibleWindowObserved = $true
            break
        }
        Start-Sleep -Milliseconds 50
    }
    if (-not $recovery.visibleWindowObserved) { throw "recovery_visible_window_timeout" }
    $recoveryIds = @(Get-OwnedProcessIds $recoveryProcess.Id)
    $recovery.ownedProcessCount = $recoveryIds.Count
    $recovery.aiChildProcessCount = @($recoveryIds | Where-Object {
        (Get-Process -Id $_ -ErrorAction SilentlyContinue).ProcessName -eq "yuanyuan-ai"
    }).Count
    Stop-OwnedProcessTree $recoveryProcess.Id
    $recoveryProcess = $null
    $recovery.processCountAfterProbeStop = @(
        Get-Process -Name "yuanyuan-reminder" -ErrorAction SilentlyContinue
    ).Count
    $applicationErrors = Get-ApplicationErrors $launchUtc
    $recovery.applicationErrorQueryAvailable = $applicationErrors.queryAvailable
    $recovery.applicationErrorCount = $applicationErrors.count

    $captureOutput = @(& node $captureHelperPath `
        --source $databasePath `
        --fixture $temporaryFixture `
        --report $temporaryCaptureReport `
        --attest-source synthetic_fresh_first_start 2>&1)
    if ($LASTEXITCODE -ne 0) { throw "database_capture_failed" }
    $capture = Get-Content -Raw -Encoding UTF8 -LiteralPath $temporaryCaptureReport |
        ConvertFrom-Json
    $captureReportBytes = [long](Get-Item -LiteralPath $temporaryCaptureReport).Length
    $bindings.databaseCaptureReportSha256 = Get-Sha256 $temporaryCaptureReport
    $bindings.databaseFixtureSha256 = Get-Sha256 $temporaryFixture
    $recovery.databaseCapture = [ordered]@{
        reportFileName = Split-Path -Leaf $captureReportPath
        reportBytes = $captureReportBytes
        reportSha256 = $bindings.databaseCaptureReportSha256
        fixtureFileName = Split-Path -Leaf $fixturePath
        fixtureBytes = [long](Get-Item -LiteralPath $temporaryFixture).Length
        fixtureSha256 = $bindings.databaseFixtureSha256
        ready = $capture.ready
        attestation = $capture.attestation
        sourceHealth = $capture.source.healthBeforeCheckpoint
        fixtureHealth = $capture.fixture.health
        fixtureSidecarCount = $capture.fixture.sidecarCount
    }
}
catch {
    $failureCode = if ($_.Exception.Message -match '^[a-z0-9_]+$') {
        $_.Exception.Message
    } else {
        "first_start_recovery_harness_failed"
    }
}
finally {
    if ($null -ne $watcher) {
        $watcher.EnableRaisingEvents = $false
        $watcher.Dispose()
    }
    if ($null -ne $jobProcess) {
        try { $jobProcess.Dispose() } catch { }
    }
    if ($null -ne $recoveryProcess) {
        try { Stop-OwnedProcessTree $recoveryProcess.Id } catch { }
    }
    if ($dataOwned) {
        try {
            $cleanup.formalDataRootRemoved = Remove-OwnedDirectory `
                $formalDataRoot `
                $localDataRoot `
                $formalDataLeaf `
                $dataMarker
        }
        catch {
            if ($null -eq $failureCode) { $failureCode = "formal_data_cleanup_failed" }
        }
    }
    if ($stageOwned) {
        try {
            $cleanup.stageRootRemoved = Remove-OwnedDirectory `
                $stageRoot `
                $releaseRoot `
                "first-start-stage-$runId" `
                $stageMarker
        }
        catch {
            if ($null -eq $failureCode) { $failureCode = "stage_cleanup_failed" }
        }
    }
    $cleanup.applicationProcessCount = @(
        Get-Process -Name "yuanyuan-reminder" -ErrorAction SilentlyContinue
    ).Count
}

$readyBeforeFinalization =
    $null -eq $failureCode -and
    $environment.interactiveSession -and
    $environment.freshTestAccountAcknowledged -and
    $environment.profileRegistryQueryAvailable -and
    $environment.tokenProfilePathMatchesEnvironment -and
    $environment.localAppDataMatchesTokenProfile -and
    -not $environment.preexistingDataRoot -and
    $environment.preexistingApplicationProcessCount -eq 0 -and
    $environment.emptyFormalDataRootProvisionedByProbe -and
    $bindings.stagedCandidateSha256 -eq $bindings.candidateSha256 -and
    $interruption.cpuHardCapPercent -eq 1 -and
    $interruption.jobKillOnClose -and
    $interruption.walWatcherArmed -and
    $interruption.walNonzeroObserved -and
    $interruption.triggerMainDatabaseBytes -gt 0 -and
    $interruption.triggerWalBytes -gt 0 -and
    $interruption.ownedProcessCountBeforeTermination -ge 1 -and
    $interruption.jobTerminationRequested -and
    $interruption.rootExitCode -eq 1 -and
    $interruption.processCountAfterTermination -eq 0 -and
    $interruption.mainDatabaseAfterTermination.present -and
    $interruption.mainDatabaseAfterTermination.bytes -gt 0 -and
    $interruption.walAfterTermination.present -and
    $interruption.walAfterTermination.bytes -gt 0 -and
    $recovery.sameCandidateRelaunched -and
    $recovery.visibleWindowObserved -and
    $recovery.ownedProcessCount -ge 1 -and
    $recovery.aiChildProcessCount -eq 0 -and
    $recovery.applicationErrorQueryAvailable -and
    $recovery.applicationErrorCount -eq 0 -and
    $recovery.processCountAfterProbeStop -eq 0 -and
    $capture.ready -eq $true -and
    $capture.attestation -eq "synthetic_fresh_first_start" -and
    $capture.fixture.health.schemaVersion -eq 11 -and
    $capture.fixture.health.quickCheck.Count -eq 1 -and
    $capture.fixture.health.quickCheck[0] -eq "ok" -and
    $capture.fixture.health.journalMode -eq "delete" -and
    $capture.fixture.sidecarCount -eq 0 -and
    $cleanup.formalDataRootRemoved -and
    $cleanup.stageRootRemoved -and
    $cleanup.applicationProcessCount -eq 0

if ($readyBeforeFinalization) {
    try {
        Move-Item -LiteralPath $temporaryFixture -Destination $fixturePath -Force
        Move-Item -LiteralPath $temporaryCaptureReport -Destination $captureReportPath -Force
        $cleanup.evidenceTempRootRemoved = Remove-OwnedDirectory `
            $evidenceTempRoot `
            $releaseRoot `
            "first-start-evidence-$runId" `
            $evidenceMarker
        $evidenceOwned = $false
        $outputsFinalized = $true
    }
    catch {
        $failureCode = "evidence_finalization_failed"
    }
}
if ($evidenceOwned -and (Test-Path -LiteralPath $evidenceTempRoot -PathType Container)) {
    try {
        $cleanup.evidenceTempRootRemoved = Remove-OwnedDirectory `
            $evidenceTempRoot `
            $releaseRoot `
            "first-start-evidence-$runId" `
            $evidenceMarker
        $evidenceOwned = $false
    }
    catch {
        if ($null -eq $failureCode) { $failureCode = "evidence_temp_cleanup_failed" }
    }
}

$ready = $readyBeforeFinalization -and
    $outputsFinalized -and
    $cleanup.evidenceTempRootRemoved -and
    $null -eq $failureCode
$report = [ordered]@{
    schemaVersion = 1
    generatedAt = (Get-Date).ToUniversalTime().ToString("o")
    mode = "release_first_start_database_recovery_probe"
    ready = $ready
    failureCode = $failureCode
    bindings = $bindings
    environment = $environment
    interruption = $interruption
    recovery = $recovery
    cleanup = $cleanup
    limitations = $limitations
}
$temporaryProbeReport = "$reportPath.$runId.tmp"
$report | ConvertTo-Json -Depth 12 | Set-Content -Encoding UTF8 -LiteralPath $temporaryProbeReport
Move-Item -LiteralPath $temporaryProbeReport -Destination $reportPath -Force
Write-Output "Release first-start recovery probe report written: $reportPath"
if (-not $ready) {
    [Console]::Error.WriteLine("release first-start recovery QA did not pass: $failureCode")
    exit 2
}
