param(
    [ValidateRange(1, 20)]
    [int]$SampleCount = 3,

    [ValidateRange(5, 60)]
    [int]$WindowTimeoutSeconds = 30,

    [switch]$AcknowledgeFreshTestAccount
)

$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"

$projectRoot = Split-Path -Parent $PSScriptRoot
$releaseRoot = Join-Path $projectRoot "src-tauri\target\release"
$manifestPath = Join-Path $releaseRoot "release-manifest.json"
$reportPath = Join-Path $releaseRoot "release-cold-start.json"
$candidatePath = Join-Path $releaseRoot "nsis-payload\yuanyuan-reminder.exe"
$measureScriptSha256 = (Get-FileHash -LiteralPath $MyInvocation.MyCommand.Path -Algorithm SHA256).Hash
$localDataRoot = [Environment]::GetFolderPath(
    [Environment+SpecialFolder]::LocalApplicationData
)
$formalDataRoot = Join-Path $localDataRoot "com.yuanyuan.reminder"
$profileRegistryQueryAvailable = $false
$tokenProfilePathMatchesEnvironment = $false
try {
    $currentSid = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value
    $profileKey = "Registry::HKEY_LOCAL_MACHINE\SOFTWARE\Microsoft\Windows NT\CurrentVersion\ProfileList\$currentSid"
    $registeredProfile = [Environment]::ExpandEnvironmentVariables(
        (Get-ItemProperty -LiteralPath $profileKey -Name ProfileImagePath -ErrorAction Stop).ProfileImagePath
    )
    $environmentProfile = [Environment]::GetFolderPath(
        [Environment+SpecialFolder]::UserProfile
    )
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
            $localDataRoot,
            [StringComparison]::OrdinalIgnoreCase
        )
}
catch {
    $profileRegistryQueryAvailable = $false
    $tokenProfilePathMatchesEnvironment = $false
}
$runId = "{0}-{1}" -f
    (Get-Date).ToUniversalTime().ToString("yyyyMMddTHHmmssZ"),
    [Guid]::NewGuid().ToString("N")
$stageRoot = Join-Path $releaseRoot "cold-start-stage-$runId"
$stageMarker = Join-Path $stageRoot ".yuanyuan-release-cold-start-stage-v1"
$dataMarker = Join-Path $formalDataRoot ".yuanyuan-release-cold-start-data-v1"
$ownershipValue = "YUANYUAN_RELEASE_COLD_START_V1:$runId`n"
$stagedCandidate = Join-Path $stageRoot "yuanyuan-reminder.exe"
$process = $null
$stageRemoved = $false
$dataRootClaimed = $false
$samples = [System.Collections.Generic.List[object]]::new()
$failureCode = $null

if (-not ("YuanyuanReleaseColdStartProcessSnapshot" -as [type])) {
    Add-Type -TypeDefinition @"
using System;
using System.Collections.Generic;
using System.ComponentModel;
using System.Runtime.InteropServices;

public sealed class YuanyuanReleaseColdStartProcessRelation {
    public uint ProcessId { get; set; }
    public uint ParentProcessId { get; set; }
}

public static class YuanyuanReleaseColdStartProcessSnapshot {
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

    public static YuanyuanReleaseColdStartProcessRelation[] Capture() {
        var snapshot = CreateToolhelp32Snapshot(SnapshotProcesses, 0);
        if (snapshot == new IntPtr(-1)) {
            throw new Win32Exception(Marshal.GetLastWin32Error());
        }
        try {
            var rows = new List<YuanyuanReleaseColdStartProcessRelation>();
            var entry = new ProcessEntry { Size = (uint)Marshal.SizeOf(typeof(ProcessEntry)) };
            if (Process32First(snapshot, ref entry)) {
                do {
                    rows.Add(new YuanyuanReleaseColdStartProcessRelation {
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
"@
}

function Get-Sha256([string]$Path) {
    (Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash
}

function Get-Percentile([double[]]$Values, [double]$Percentile) {
    $sorted = @($Values | Sort-Object)
    $index = [math]::Max(0, [math]::Ceiling($Percentile * $sorted.Count) - 1)
    [double]$sorted[$index]
}

function Get-OwnedProcessIds([int]$RootProcessId) {
    $rows = @([YuanyuanReleaseColdStartProcessSnapshot]::Capture())
    $owned = [System.Collections.Generic.HashSet[uint32]]::new()
    $owned.Add([uint32]$RootProcessId) | Out-Null
    do {
        $added = $false
        foreach ($row in $rows) {
            if ($owned.Contains([uint32]$row.ParentProcessId) -and
                -not $owned.Contains([uint32]$row.ProcessId)) {
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
    $remaining = @($observed | Where-Object {
        Get-Process -Id $_ -ErrorAction SilentlyContinue
    })
    if ($remaining.Count -gt 0) {
        throw "candidate_process_tree_not_stopped"
    }
}

function Assert-OrdinaryExactDirectory([string]$Path, [string]$ExpectedParent, [string]$ExpectedLeaf) {
    $item = Get-Item -LiteralPath $Path -Force
    if (-not $item.PSIsContainer -or
        (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0)) {
        throw "owned_directory_is_not_ordinary"
    }
    $canonicalPath = (Resolve-Path -LiteralPath $Path).Path
    $canonicalParent = (Resolve-Path -LiteralPath $ExpectedParent).Path
    $canonicalItem = Get-Item -LiteralPath $canonicalPath -Force
    if ($canonicalItem.Parent.FullName -ne $canonicalParent -or
        $canonicalItem.Name -ne $ExpectedLeaf) {
        throw "owned_directory_escaped_expected_parent"
    }
    $canonicalPath
}

function Claim-FreshDataRoot {
    $deadline = [DateTime]::UtcNow.AddSeconds(10)
    while ([DateTime]::UtcNow -lt $deadline) {
        if (Test-Path -LiteralPath $formalDataRoot -PathType Container) {
            Assert-OrdinaryExactDirectory `
                $formalDataRoot `
                $localDataRoot `
                "com.yuanyuan.reminder" | Out-Null
            if (Test-Path -LiteralPath $dataMarker) {
                throw "fresh_data_root_already_contains_ownership_marker"
            }
            [IO.File]::WriteAllText($dataMarker, $ownershipValue, [Text.UTF8Encoding]::new($false))
            return $true
        }
        if ($null -ne $process) {
            $process.Refresh()
            if ($process.HasExited) { break }
        }
        Start-Sleep -Milliseconds 50
    }
    throw "candidate_did_not_create_data_root"
}

function Remove-OwnedDataRoot {
    if (-not (Test-Path -LiteralPath $formalDataRoot -PathType Container)) { return $true }
    Assert-OrdinaryExactDirectory `
        $formalDataRoot `
        $localDataRoot `
        "com.yuanyuan.reminder" | Out-Null
    if (-not (Test-Path -LiteralPath $dataMarker -PathType Leaf) -or
        (Get-Content -Raw -Encoding UTF8 -LiteralPath $dataMarker) -ne $ownershipValue) {
        throw "refusing_to_remove_unowned_formal_data_root"
    }
    $deadline = [DateTime]::UtcNow.AddSeconds(10)
    do {
        try {
            Remove-Item -LiteralPath $formalDataRoot -Recurse -Force -ErrorAction Stop
        }
        catch {
            if ([DateTime]::UtcNow -ge $deadline) { throw "owned_data_root_cleanup_failed" }
        }
        if (-not (Test-Path -LiteralPath $formalDataRoot)) { return $true }
        Start-Sleep -Milliseconds 200
    } while ([DateTime]::UtcNow -lt $deadline)
    throw "owned_data_root_cleanup_failed"
}

function Remove-OwnedStageRoot {
    if (-not (Test-Path -LiteralPath $stageRoot -PathType Container)) { return $true }
    Assert-OrdinaryExactDirectory $stageRoot $releaseRoot "cold-start-stage-$runId" | Out-Null
    if (-not (Test-Path -LiteralPath $stageMarker -PathType Leaf) -or
        (Get-Content -Raw -Encoding UTF8 -LiteralPath $stageMarker) -ne $ownershipValue) {
        throw "refusing_to_remove_unowned_stage_root"
    }
    Remove-Item -LiteralPath $stageRoot -Recurse -Force
    -not (Test-Path -LiteralPath $stageRoot)
}

function Get-ApplicationErrors([datetime]$StartUtc) {
    $eventErrors = @()
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

function Write-ColdStartReport([bool]$Ready, [object]$Candidate, [object]$Environment) {
    $timings = @($samples | ForEach-Object { [double]$_.startupToVisibleWindowMilliseconds })
    $summary = if ($timings.Count -gt 0) {
        [ordered]@{
            sampleCount = $timings.Count
            minimumMilliseconds = [math]::Round(($timings | Measure-Object -Minimum).Minimum, 1)
            p50Milliseconds = [math]::Round((Get-Percentile $timings 0.50), 1)
            p95Milliseconds = [math]::Round((Get-Percentile $timings 0.95), 1)
            maximumMilliseconds = [math]::Round(($timings | Measure-Object -Maximum).Maximum, 1)
        }
    } else {
        [ordered]@{
            sampleCount = 0
            minimumMilliseconds = $null
            p50Milliseconds = $null
            p95Milliseconds = $null
            maximumMilliseconds = $null
        }
    }
    $report = [ordered]@{
        schemaVersion = 2
        generatedAt = (Get-Date).ToUniversalTime().ToString("o")
        mode = "default_release_fresh_profile_cold_start"
        ready = $Ready
        failureCode = $failureCode
        bindings = [ordered]@{
            measureScriptSha256 = $measureScriptSha256
        }
        candidate = $Candidate
        environment = $Environment
        summary = $summary
        samples = @($samples)
        limitations = @(
            "Measures a byte-identical staged copy of the default release executable, not NSIS installation time.",
            "Each sample uses a freshly created application data root but may benefit from operating-system and WebView2 file cache.",
            "The process tree is force-stopped after the visible-window observation; graceful shutdown is evaluated separately."
        )
    }
    $temporaryReport = "$reportPath.$runId.tmp"
    $report | ConvertTo-Json -Depth 8 | Set-Content -Encoding UTF8 -LiteralPath $temporaryReport
    Move-Item -LiteralPath $temporaryReport -Destination $reportPath -Force
}

if (-not ("YuanyuanReleaseColdStartWindowProbe" -as [type])) {
    Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;

public static class YuanyuanReleaseColdStartWindowProbe {
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

if (-not $AcknowledgeFreshTestAccount) {
    throw "pass -AcknowledgeFreshTestAccount only in a disposable Windows test account"
}
if (-not (Test-Path -LiteralPath $manifestPath -PathType Leaf) -or
    -not (Test-Path -LiteralPath $candidatePath -PathType Leaf)) {
    throw "release candidate or manifest is missing; build and generate the manifest first"
}

$manifest = Get-Content -Raw -Encoding UTF8 -LiteralPath $manifestPath | ConvertFrom-Json
$stableArtifact = @($manifest.artifacts | Where-Object { $_.id -eq "nsis_installed_core" })
if ($stableArtifact.Count -ne 1) { throw "release manifest must contain one nsis_installed_core artifact" }
$candidateSha256 = Get-Sha256 $candidatePath
$manifestSha256 = Get-Sha256 $manifestPath
if ($candidateSha256 -ne $stableArtifact[0].sha256) {
    throw "release candidate hash does not match the manifest"
}

$candidateEvidence = [ordered]@{
    manifestSha256 = $manifestSha256
    stableCoreSha256 = $candidateSha256
    stagedCopySha256 = $null
    byteIdenticalStagedCopy = $false
}
$environmentEvidence = [ordered]@{
    interactiveSession = [Environment]::UserInteractive
    freshTestAccountAcknowledged = [bool]$AcknowledgeFreshTestAccount
    preexistingDataRoot = Test-Path -LiteralPath $formalDataRoot
    preexistingApplicationProcessCount = @(Get-Process -Name "yuanyuan-reminder" -ErrorAction SilentlyContinue).Count
    applicationErrorQueryAvailable = $false
    profileRegistryQueryAvailable = $profileRegistryQueryAvailable
    tokenProfilePathMatchesEnvironment = $tokenProfilePathMatchesEnvironment
}

try {
    if (-not $environmentEvidence.interactiveSession) { throw "interactive_session_unavailable" }
    if (-not $environmentEvidence.profileRegistryQueryAvailable) {
        throw "profile_registry_query_unavailable"
    }
    if (-not $environmentEvidence.tokenProfilePathMatchesEnvironment) {
        throw "test_account_profile_mismatch"
    }
    if ($environmentEvidence.preexistingDataRoot) { throw "preexisting_formal_data_root" }
    if ($environmentEvidence.preexistingApplicationProcessCount -ne 0) {
        throw "preexisting_application_process"
    }

    New-Item -ItemType Directory -Path $stageRoot | Out-Null
    [IO.File]::WriteAllText($stageMarker, $ownershipValue, [Text.UTF8Encoding]::new($false))
    Copy-Item -LiteralPath $candidatePath -Destination $stagedCandidate
    $candidateEvidence.stagedCopySha256 = Get-Sha256 $stagedCandidate
    $candidateEvidence.byteIdenticalStagedCopy =
        $candidateEvidence.stagedCopySha256 -eq $candidateSha256
    if (-not $candidateEvidence.byteIdenticalStagedCopy) { throw "staged_candidate_hash_mismatch" }

    for ($sampleNumber = 1; $sampleNumber -le $SampleCount; $sampleNumber += 1) {
        if (Test-Path -LiteralPath $formalDataRoot) { throw "data_root_not_clean_before_sample" }
        if (@(Get-Process -Name "yuanyuan-reminder" -ErrorAction SilentlyContinue).Count -ne 0) {
            throw "application_process_not_clean_before_sample"
        }

        $launchUtc = (Get-Date).ToUniversalTime()
        $stopwatch = [Diagnostics.Stopwatch]::StartNew()
        # The visible pet window is the timing target, so this process must not use a hidden window style.
        $process = Start-Process -FilePath $stagedCandidate -PassThru -WindowStyle Normal
        $dataRootClaimed = Claim-FreshDataRoot
        $windowVisible = $false
        $deadline = [DateTime]::UtcNow.AddSeconds($WindowTimeoutSeconds)
        while ([DateTime]::UtcNow -lt $deadline) {
            $process.Refresh()
            if ($process.HasExited) { break }
            if ([YuanyuanReleaseColdStartWindowProbe]::HasVisibleWindow($process.Id)) {
                $windowVisible = $true
                break
            }
            Start-Sleep -Milliseconds 50
        }
        $startupMilliseconds = if ($windowVisible) {
            [math]::Round($stopwatch.Elapsed.TotalMilliseconds, 1)
        } else { $null }
        $ownedIds = @(Get-OwnedProcessIds $process.Id)
        $aiChildCount = @($ownedIds | Where-Object {
            (Get-Process -Id $_ -ErrorAction SilentlyContinue).ProcessName -eq "yuanyuan-ai"
        }).Count
        Stop-OwnedProcessTree $process.Id
        $process = $null
        $errors = Get-ApplicationErrors $launchUtc
        $environmentEvidence.applicationErrorQueryAvailable = $errors.queryAvailable
        $dataRootRemoved = Remove-OwnedDataRoot
        $dataRootClaimed = $false

        $samples.Add([ordered]@{
            sequence = $sampleNumber
            visibleWindowObserved = $windowVisible
            startupToVisibleWindowMilliseconds = $startupMilliseconds
            terminationMode = "forced_after_window_probe"
            ownedProcessCount = $ownedIds.Count
            aiChildProcessCount = $aiChildCount
            applicationErrorCount = $errors.count
            applicationErrorQueryAvailable = $errors.queryAvailable
            dataRootRemoved = $dataRootRemoved
        })
        if (-not $windowVisible) { throw "visible_window_timeout" }
        if ($aiChildCount -ne 0) { throw "unexpected_ai_child_process" }
        if (-not $errors.queryAvailable) { throw "application_error_query_unavailable" }
        if ($errors.count -ne 0) { throw "application_error_observed" }
        if (-not $dataRootRemoved) { throw "data_root_cleanup_failed" }
    }

    $stageRemoved = Remove-OwnedStageRoot
    $ready = $stageRemoved -and
        $samples.Count -eq $SampleCount -and
        @($samples | Where-Object {
            -not $_.visibleWindowObserved -or
            -not $_.dataRootRemoved -or
            $_.aiChildProcessCount -ne 0 -or
            -not $_.applicationErrorQueryAvailable -or
            $_.applicationErrorCount -ne 0
        }).Count -eq 0
    Write-ColdStartReport $ready $candidateEvidence $environmentEvidence
    Write-Output "Release cold-start report written: $reportPath"
    if ($ready) {
        $timings = @($samples | ForEach-Object { [double]$_.startupToVisibleWindowMilliseconds })
        Write-Output (
            "Fresh-profile startup P50={0}ms P95={1}ms Samples={2}" -f
            [math]::Round((Get-Percentile $timings 0.50), 1),
            [math]::Round((Get-Percentile $timings 0.95), 1),
            $samples.Count
        )
    } else {
        exit 2
    }
}
catch {
    $failureCode = if ($_.Exception.Message -match '^[a-z0-9_]+$') {
        $_.Exception.Message
    } else {
        "cold_start_harness_failed"
    }
    Write-ColdStartReport $false $candidateEvidence $environmentEvidence
    [Console]::Error.WriteLine("release cold-start QA did not pass: $failureCode")
    exit 2
}
finally {
    if ($null -ne $process) {
        try { Stop-OwnedProcessTree $process.Id } catch { }
    }
    if ($dataRootClaimed -and (Test-Path -LiteralPath $formalDataRoot -PathType Container)) {
        Remove-OwnedDataRoot | Out-Null
    }
    if (-not $stageRemoved -and (Test-Path -LiteralPath $stageRoot -PathType Container)) {
        Remove-OwnedStageRoot | Out-Null
    }
}
