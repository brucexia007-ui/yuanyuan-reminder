param(
    [ValidateRange(30, 259200)]
    [int]$DurationSeconds = 60,

    [ValidateRange(1, 60)]
    [int]$SampleIntervalSeconds = 2,

    [ValidateRange(5, 300)]
    [int]$WarmupSeconds = 10,

    [ValidateSet("learning-off", "learning-on")]
    [string]$BuildVariant = "learning-off",

    [switch]$AcceptanceGate
)

$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"
if ($WarmupSeconds -ge ($DurationSeconds - $SampleIntervalSeconds)) {
    throw "warmup must leave room for at least one measurement interval"
}

$acceptanceMinimumDurationSeconds = 86400
$acceptanceMinimumActiveCoverageSeconds = 72000
$acceptanceMaximumSampleIntervalSeconds = 60
$acceptanceLimits = [ordered]@{
    averageNormalizedCpuPercent = 2.0
    p95NormalizedCpuPercent = 5.0
    workingSetSlopeBytesPerHour = 4194304.0
    workingSetSegmentGrowthBytes = 67108864
    privateMemorySlopeBytesPerHour = 2097152.0
    privateMemorySegmentGrowthBytes = 33554432
    handleSlopePerHour = 2.0
    handleSegmentGrowth = 32
    threadSlopePerHour = 0.5
    threadSegmentGrowth = 8
    databaseGrowthBytes = 1048576
}
if ($AcceptanceGate) {
    if ($DurationSeconds -lt $acceptanceMinimumDurationSeconds) {
        throw "acceptance gate requires at least 86400 requested seconds"
    }
    if ($SampleIntervalSeconds -gt $acceptanceMaximumSampleIntervalSeconds) {
        throw "acceptance gate requires a sample interval no greater than 60 seconds"
    }
}

$projectRoot = Split-Path -Parent $PSScriptRoot
$workspaceRoot = Split-Path -Parent $projectRoot
$runtimeTargetName = if ($BuildVariant -eq "learning-on") {
    "runtime-qa-learning"
}
else {
    "runtime-qa"
}
$runtimeTarget = Join-Path $projectRoot "src-tauri\target\$runtimeTargetName\release"
$appPath = Join-Path $runtimeTarget "yuanyuan-reminder.exe"
$fixturePath = Join-Path $runtimeTarget "yuanyuan-runtime-qa-fixture.exe"
$evidenceRoot = Join-Path $runtimeTarget "evidence"
$runId = (Get-Date).ToUniversalTime().ToString("yyyyMMddTHHmmssZ")
$qaRoot = Join-Path $workspaceRoot "yuanyuan-runtime-qa-baseline-$runId"
$markerPath = Join-Path $qaRoot ".yuanyuan-runtime-qa-v1"
$expectedMarker = "YUANYUAN_RUNTIME_QA_V1`n"
$formalDataRoot = Join-Path $env:LOCALAPPDATA "com.yuanyuan.reminder"
$scriptPath = $MyInvocation.MyCommand.Path

foreach ($required in @($appPath, $fixturePath)) {
    if (-not (Test-Path -LiteralPath $required -PathType Leaf)) {
        $buildCommand = if ($BuildVariant -eq "learning-on") {
            "npm.cmd run runtime:qa:learning:build"
        }
        else {
            "npm.cmd run runtime:qa:build"
        }
        throw "runtime QA binary is missing; run $buildCommand first"
    }
}
New-Item -ItemType Directory -Force -Path $evidenceRoot | Out-Null
$bindings = [ordered]@{
    applicationSha256 = (Get-FileHash -Algorithm SHA256 -LiteralPath $appPath).Hash
    fixtureSha256 = (Get-FileHash -Algorithm SHA256 -LiteralPath $fixturePath).Hash
    scriptSha256 = (Get-FileHash -Algorithm SHA256 -LiteralPath $scriptPath).Hash
}

if (-not ("YuanyuanRuntimeWindowProbe" -as [type])) {
    Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;

public static class YuanyuanRuntimeWindowProbe {
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

if (-not ("YuanyuanRuntimeSystemProbe" -as [type])) {
    Add-Type -ReferencedAssemblies System.dll -TypeDefinition @"
using System;
using System.Collections.Generic;
using Microsoft.Win32;

public sealed class YuanyuanRuntimeSystemTransition {
    public string ObservedAtUtc { get; set; }
    public string Kind { get; set; }
    public string Reason { get; set; }
}

public static class YuanyuanRuntimeSystemProbe {
    private static readonly object Sync = new object();
    private static readonly List<YuanyuanRuntimeSystemTransition> Events =
        new List<YuanyuanRuntimeSystemTransition>();
    private static bool started;

    public static void Start() {
        lock (Sync) {
            if (started) return;
            Events.Clear();
            SystemEvents.PowerModeChanged += OnPowerModeChanged;
            SystemEvents.SessionSwitch += OnSessionSwitch;
            started = true;
        }
    }

    public static YuanyuanRuntimeSystemTransition[] StopAndSnapshot() {
        lock (Sync) {
            if (started) {
                SystemEvents.PowerModeChanged -= OnPowerModeChanged;
                SystemEvents.SessionSwitch -= OnSessionSwitch;
                started = false;
            }
            return Events.ToArray();
        }
    }

    private static void Add(string kind, string reason) {
        lock (Sync) {
            Events.Add(new YuanyuanRuntimeSystemTransition {
                ObservedAtUtc = DateTime.UtcNow.ToString("o"),
                Kind = kind,
                Reason = reason
            });
        }
    }

    private static void OnPowerModeChanged(object sender, PowerModeChangedEventArgs args) {
        if (args.Mode == PowerModes.Suspend) Add("power", "suspend");
        else if (args.Mode == PowerModes.Resume) Add("power", "resume");
    }

    private static void OnSessionSwitch(object sender, SessionSwitchEventArgs args) {
        if (args.Reason == SessionSwitchReason.SessionLock) Add("session", "lock");
        else if (args.Reason == SessionSwitchReason.SessionUnlock) Add("session", "unlock");
    }
}
"@
}

function Get-DatabaseSnapshot([string]$Root) {
    $files = @()
    if (Test-Path -LiteralPath $Root -PathType Container) {
        $files = @(Get-ChildItem -LiteralPath $Root -Recurse -File -ErrorAction Stop | Where-Object {
            $_.Name -match '\.sqlite3($|-wal$|-shm$)'
        })
    }
    $totalBytes = ($files | Measure-Object -Property Length -Sum).Sum
    if ($null -eq $totalBytes) { $totalBytes = 0 }
    [ordered]@{
        fileCount = $files.Count
        bytes = [long]$totalBytes
    }
}

function Get-ProcessTreeSample([int]$RootProcessId) {
    $rows = @(Get-CimInstance Win32_Process | Select-Object ProcessId, ParentProcessId, Name)
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

    [double]$cpuSeconds = 0
    $cpuByProcess = @{}
    [long]$workingSetBytes = 0
    [long]$privateMemoryBytes = 0
    [int]$handleCount = 0
    [int]$threadCount = 0
    [int]$processCount = 0
    [int]$aiProcessCount = 0
    foreach ($processId in $owned) {
        try {
            $ownedProcess = Get-Process -Id $processId -ErrorAction Stop
            $currentCpuSeconds = $ownedProcess.TotalProcessorTime.TotalSeconds
            $cpuSeconds += $currentCpuSeconds
            $cpuByProcess[[string]$processId] = $currentCpuSeconds
            $workingSetBytes += $ownedProcess.WorkingSet64
            $privateMemoryBytes += $ownedProcess.PrivateMemorySize64
            $handleCount += $ownedProcess.HandleCount
            $threadCount += $ownedProcess.Threads.Count
            $processCount += 1
            if ($ownedProcess.ProcessName -eq "yuanyuan-ai") { $aiProcessCount += 1 }
        }
        catch {
            # A WebView helper can exit between the process-tree snapshot and sampling.
        }
    }
    [ordered]@{
        cpuSeconds = $cpuSeconds
        cpuByProcess = $cpuByProcess
        workingSetBytes = $workingSetBytes
        privateMemoryBytes = $privateMemoryBytes
        handleCount = $handleCount
        threadCount = $threadCount
        processCount = $processCount
        aiProcessCount = $aiProcessCount
    }
}

function Remove-OwnedQaRoot([string]$Root) {
    if (-not (Test-Path -LiteralPath $Root -PathType Container)) { return $true }
    $canonicalRoot = (Resolve-Path -LiteralPath $Root).Path
    $canonicalParent = (Resolve-Path -LiteralPath $workspaceRoot).Path
    $rootInfo = Get-Item -LiteralPath $canonicalRoot -Force
    $leaf = $rootInfo.Name
    if (
        $rootInfo.Parent.FullName -ne $canonicalParent -or
        -not $leaf.StartsWith("yuanyuan-runtime-qa-baseline-", [StringComparison]::Ordinal) -or
        -not (Test-Path -LiteralPath $markerPath -PathType Leaf) -or
        (Get-Content -Raw -Encoding UTF8 -LiteralPath $markerPath) -ne $expectedMarker
    ) {
        throw "refusing to remove an unowned runtime QA root"
    }
    Remove-Item -LiteralPath $canonicalRoot -Recurse -Force
    return -not (Test-Path -LiteralPath $canonicalRoot)
}

function Get-Median([double[]]$Values) {
    if ($Values.Count -eq 0) { throw "cannot calculate a median without values" }
    $ordered = @($Values | Sort-Object)
    $middle = [math]::Floor($ordered.Count / 2)
    if (($ordered.Count % 2) -eq 1) { return [double]$ordered[$middle] }
    return ([double]$ordered[$middle - 1] + [double]$ordered[$middle]) / 2.0
}

function Get-SegmentedTrend([object[]]$InputSamples, [string]$Metric) {
    $segmentTotal = 6
    if ($InputSamples.Count -lt $segmentTotal) {
        throw "at least six samples are required for segmented trend analysis"
    }
    $firstElapsed = [double]$InputSamples[0].elapsedSeconds
    $lastElapsed = [double]$InputSamples[-1].elapsedSeconds
    $span = $lastElapsed - $firstElapsed
    if ($span -le 0) { throw "sample time span must be positive" }

    $buckets = @()
    for ($index = 0; $index -lt $segmentTotal; $index += 1) {
        $buckets += ,([System.Collections.Generic.List[object]]::new())
    }
    foreach ($sample in $InputSamples) {
        $position = ([double]$sample.elapsedSeconds - $firstElapsed) / $span
        $bucketIndex = [math]::Min(
            $segmentTotal - 1,
            [math]::Floor($position * $segmentTotal)
        )
        $buckets[$bucketIndex].Add($sample)
    }

    $segments = @()
    foreach ($index in 0..($segmentTotal - 1)) {
        $bucket = @($buckets[$index])
        if ($bucket.Count -eq 0) {
            throw "all six time segments must contain samples"
        }
        $elapsedValues = @($bucket | ForEach-Object { [double]$_.elapsedSeconds })
        $metricValues = @($bucket | ForEach-Object { [double]($_.$Metric) })
        $segments += [ordered]@{
            index = $index + 1
            medianElapsedSeconds = [math]::Round((Get-Median $elapsedValues), 3)
            medianValue = [math]::Round((Get-Median $metricValues), 4)
            sampleCount = $bucket.Count
        }
    }

    $meanElapsed = [double](($segments.medianElapsedSeconds | Measure-Object -Average).Average)
    $meanValue = [double](($segments.medianValue | Measure-Object -Average).Average)
    [double]$numerator = 0
    [double]$denominator = 0
    foreach ($segment in $segments) {
        $elapsedDelta = [double]$segment.medianElapsedSeconds - $meanElapsed
        $valueDelta = [double]$segment.medianValue - $meanValue
        $numerator += $elapsedDelta * $valueDelta
        $denominator += $elapsedDelta * $elapsedDelta
    }
    if ($denominator -le 0) { throw "trend regression requires distinct segment times" }
    $slopePerHour = ($numerator / $denominator) * 3600.0
    [ordered]@{
        metric = $Metric
        segmentCount = $segmentTotal
        slopePerHour = [math]::Round($slopePerHour, 4)
        firstMedian = [double]$segments[0].medianValue
        lastMedian = [double]$segments[-1].medianValue
        segmentGrowth = [math]::Round(
            [double]$segments[-1].medianValue - [double]$segments[0].medianValue,
            4
        )
        segments = $segments
    }
}

function Get-ActiveSampleCoverageSeconds([object[]]$InputSamples, [int]$ExpectedIntervalSeconds) {
    if ($InputSamples.Count -lt 2) { return 0.0 }
    [double]$coverage = 0
    $maximumCreditedInterval = [double]$ExpectedIntervalSeconds * 2.0
    for ($index = 1; $index -lt $InputSamples.Count; $index += 1) {
        $delta = [double]$InputSamples[$index].elapsedSeconds -
            [double]$InputSamples[$index - 1].elapsedSeconds
        $coverage += [math]::Min([math]::Max($delta, 0.0), $maximumCreditedInterval)
    }
    return [math]::Round($coverage, 3)
}

function Test-TransitionPair(
    [object[]]$Transitions,
    [string]$Kind,
    [string]$StartReason,
    [string]$EndReason
) {
    $waitingForEnd = $false
    foreach ($transition in $Transitions) {
        if ($transition.kind -ne $Kind) { continue }
        if (-not $waitingForEnd -and $transition.reason -eq $StartReason) {
            $waitingForEnd = $true
            continue
        }
        if ($waitingForEnd -and $transition.reason -eq $EndReason) { return $true }
    }
    return $false
}

$process = $null
$qaRootRemoved = $false
$systemProbeStopped = $false
$systemTransitions = @()
$samples = [System.Collections.Generic.List[object]]::new()
$launchUtc = (Get-Date).ToUniversalTime()
$stopwatch = [Diagnostics.Stopwatch]::StartNew()

try {
    [YuanyuanRuntimeSystemProbe]::Start()
    & $fixturePath --root $qaRoot --prepare-only
    if ($LASTEXITCODE -ne 0) { throw "runtime QA root preparation failed with exit code $LASTEXITCODE" }

    $previousRoot = [Environment]::GetEnvironmentVariable("YUANYUAN_RUNTIME_QA_ROOT", "Process")
    $previousExit = [Environment]::GetEnvironmentVariable(
        "YUANYUAN_RUNTIME_QA_EXIT_AFTER_SECONDS",
        "Process"
    )
    $previousProfile = [Environment]::GetEnvironmentVariable(
        "YUANYUAN_RUNTIME_QA_PROFILE",
        "Process"
    )
    try {
        [Environment]::SetEnvironmentVariable("YUANYUAN_RUNTIME_QA_ROOT", $qaRoot, "Process")
        [Environment]::SetEnvironmentVariable(
            "YUANYUAN_RUNTIME_QA_EXIT_AFTER_SECONDS",
            [string]$DurationSeconds,
            "Process"
        )
        [Environment]::SetEnvironmentVariable(
            "YUANYUAN_RUNTIME_QA_PROFILE",
            "baseline-ai-off",
            "Process"
        )
        $process = Start-Process -FilePath $appPath -PassThru
    }
    finally {
        [Environment]::SetEnvironmentVariable("YUANYUAN_RUNTIME_QA_ROOT", $previousRoot, "Process")
        [Environment]::SetEnvironmentVariable(
            "YUANYUAN_RUNTIME_QA_EXIT_AFTER_SECONDS",
            $previousExit,
            "Process"
        )
        [Environment]::SetEnvironmentVariable(
            "YUANYUAN_RUNTIME_QA_PROFILE",
            $previousProfile,
            "Process"
        )
    }

    $windowDeadline = [DateTime]::UtcNow.AddSeconds(30)
    $startupMilliseconds = $null
    while ([DateTime]::UtcNow -lt $windowDeadline) {
        $process.Refresh()
        if ($process.HasExited) { throw "runtime QA process exited before creating a window" }
        if ([YuanyuanRuntimeWindowProbe]::HasVisibleWindow($process.Id)) {
            $startupMilliseconds = [math]::Round($stopwatch.Elapsed.TotalMilliseconds, 1)
            break
        }
        Start-Sleep -Milliseconds 100
    }
    if ($null -eq $startupMilliseconds) { throw "runtime QA window was not visible within 30 seconds" }

    $databaseStart = Get-DatabaseSnapshot $qaRoot
    Start-Sleep -Seconds $WarmupSeconds
    $process.Refresh()
    if ($process.HasExited) { throw "runtime QA process exited during warmup" }
    $initialTree = Get-ProcessTreeSample $process.Id
    $previousCpuByProcess = $initialTree.cpuByProcess
    $lastSampleSeconds = $stopwatch.Elapsed.TotalSeconds
    $deadline = [DateTime]::UtcNow.AddSeconds($DurationSeconds + 30)
    $peakAiChildCount = 0

    while ([DateTime]::UtcNow -lt $deadline) {
        $process.Refresh()
        if ($process.HasExited) { break }
        $elapsedSeconds = $stopwatch.Elapsed.TotalSeconds
        $tree = Get-ProcessTreeSample $process.Id
        $interval = [math]::Max(0.001, $elapsedSeconds - $lastSampleSeconds)
        [double]$cpuDeltaSeconds = 0
        foreach ($processKey in $tree.cpuByProcess.Keys) {
            if ($previousCpuByProcess.ContainsKey($processKey)) {
                $cpuDeltaSeconds += [math]::Max(
                    0.0,
                    [double]$tree.cpuByProcess[$processKey] -
                        [double]$previousCpuByProcess[$processKey]
                )
            }
        }
        $cpuPercent = [math]::Max(
            0.0,
            ($cpuDeltaSeconds / ($interval * [Environment]::ProcessorCount)) * 100
        )
        $samples.Add([ordered]@{
            observedAtUtc = (Get-Date).ToUniversalTime().ToString("o")
            elapsedSeconds = [math]::Round($elapsedSeconds, 3)
            cpuPercent = [math]::Round($cpuPercent, 4)
            workingSetBytes = [long]$tree.workingSetBytes
            privateMemoryBytes = [long]$tree.privateMemoryBytes
            handleCount = [int]$tree.handleCount
            threadCount = [int]$tree.threadCount
            processCount = [int]$tree.processCount
        })
        $peakAiChildCount = [math]::Max($peakAiChildCount, [int]$tree.aiProcessCount)
        $previousCpuByProcess = $tree.cpuByProcess
        $lastSampleSeconds = $elapsedSeconds
        Start-Sleep -Seconds $SampleIntervalSeconds
    }

    if (-not $process.HasExited) {
        $process.WaitForExit(10000) | Out-Null
        $process.Refresh()
    }
    $controlledExit = $process.HasExited -and $process.ExitCode -eq 0
    if (-not $process.HasExited) {
        Stop-Process -Id $process.Id
        Wait-Process -Id $process.Id -Timeout 10 -ErrorAction SilentlyContinue
    }

    $transitionSnapshot = @([YuanyuanRuntimeSystemProbe]::StopAndSnapshot())
    $systemProbeStopped = $true
    $systemTransitions = @($transitionSnapshot | Sort-Object ObservedAtUtc | ForEach-Object {
        [ordered]@{
            observedAtUtc = $_.ObservedAtUtc
            kind = $_.Kind
            reason = $_.Reason
        }
    })

    $databaseEnd = Get-DatabaseSnapshot $qaRoot
    $workingSets = @($samples | ForEach-Object { [long]$_.workingSetBytes })
    $privateBytes = @($samples | ForEach-Object { [long]$_.privateMemoryBytes })
    $cpuValues = @($samples | ForEach-Object { [double]$_.cpuPercent })
    $handleCounts = @($samples | ForEach-Object { [int]$_.handleCount })
    $threadCounts = @($samples | ForEach-Object { [int]$_.threadCount })
    if ($samples.Count -eq 0) { throw "runtime QA process produced no samples" }

    $applicationErrorQueryAvailable = $true
    $applicationErrors = @()
    $eventReadErrors = @()
    $applicationErrors = @(Get-WinEvent -FilterHashtable @{
        LogName = "Application"
        StartTime = $launchUtc.ToLocalTime()
        Level = 2
    } -ErrorAction SilentlyContinue -ErrorVariable eventReadErrors |
        Where-Object { $_.Message -like "*yuanyuan-reminder*" })
    $unexpectedEventReadErrors = @($eventReadErrors | Where-Object {
        $_.FullyQualifiedErrorId -notlike "NoMatchingEventsFound*"
    })
    if ($unexpectedEventReadErrors.Count -gt 0) {
        $applicationErrorQueryAvailable = $false
    }

    $formalWrites = @()
    if (Test-Path -LiteralPath $formalDataRoot -PathType Container) {
        $formalWrites = @(Get-ChildItem -LiteralPath $formalDataRoot -Recurse -File -ErrorAction Stop |
            Where-Object { $_.LastWriteTimeUtc -ge $launchUtc })
    }

    $finishUtc = (Get-Date).ToUniversalTime()
    $monotonicObservedSeconds = [math]::Round($stopwatch.Elapsed.TotalSeconds, 3)
    $wallClockObservedSeconds = [math]::Round(($finishUtc - $launchUtc).TotalSeconds, 3)
    $activeSampleCoverageSeconds = Get-ActiveSampleCoverageSeconds @($samples) $SampleIntervalSeconds
    [double]$maxSampleGapSeconds = 0
    for ($index = 1; $index -lt $samples.Count; $index += 1) {
        $gap = [double]$samples[$index].elapsedSeconds - [double]$samples[$index - 1].elapsedSeconds
        $maxSampleGapSeconds = [math]::Max($maxSampleGapSeconds, $gap)
    }
    $sortedWorkingSets = @($workingSets | Sort-Object)
    $p95WorkingSetIndex = [math]::Floor(($sortedWorkingSets.Count - 1) * 0.95)
    $sortedPrivateBytes = @($privateBytes | Sort-Object)
    $p95PrivateIndex = [math]::Floor(($sortedPrivateBytes.Count - 1) * 0.95)
    $sortedCpuValues = @($cpuValues | Sort-Object)
    $p95CpuIndex = [math]::Floor(($sortedCpuValues.Count - 1) * 0.95)
    $workingSetTrend = Get-SegmentedTrend @($samples) "workingSetBytes"
    $privateMemoryTrend = Get-SegmentedTrend @($samples) "privateMemoryBytes"
    $handleTrend = Get-SegmentedTrend @($samples) "handleCount"
    $threadTrend = Get-SegmentedTrend @($samples) "threadCount"
    $averageCpu = [math]::Round(
        [double](($cpuValues | Measure-Object -Average).Average),
        4
    )
    $p95Cpu = [math]::Round([double]$sortedCpuValues[$p95CpuIndex], 4)
    $databaseGrowthBytes = [long]($databaseEnd.bytes - $databaseStart.bytes)
    $powerSuspendResumeObserved = Test-TransitionPair `
        $systemTransitions "power" "suspend" "resume"
    $sessionLockUnlockObserved = Test-TransitionPair `
        $systemTransitions "session" "lock" "unlock"
    $qaRootRemoved = Remove-OwnedQaRoot $qaRoot
    $smokePassed = $controlledExit -and
        $qaRootRemoved -and
        $formalWrites.Count -eq 0 -and
        $peakAiChildCount -eq 0 -and
        $applicationErrorQueryAvailable -and
        $applicationErrors.Count -eq 0

    $acceptanceFailures = [System.Collections.Generic.List[string]]::new()
    if ($AcceptanceGate) {
        if (-not $smokePassed) { $acceptanceFailures.Add("smoke_boundary_failed") }
        if ($DurationSeconds -lt $acceptanceMinimumDurationSeconds) {
            $acceptanceFailures.Add("requested_duration_below_24_hours")
        }
        if ($wallClockObservedSeconds -lt $DurationSeconds) {
            $acceptanceFailures.Add("wall_clock_observation_shorter_than_requested")
        }
        if ($activeSampleCoverageSeconds -lt $acceptanceMinimumActiveCoverageSeconds) {
            $acceptanceFailures.Add("active_sample_coverage_below_20_hours")
        }
        if ($SampleIntervalSeconds -gt $acceptanceMaximumSampleIntervalSeconds) {
            $acceptanceFailures.Add("sample_interval_above_60_seconds")
        }
        if (-not $powerSuspendResumeObserved) {
            $acceptanceFailures.Add("power_suspend_resume_pair_missing")
        }
        if (-not $sessionLockUnlockObserved) {
            $acceptanceFailures.Add("session_lock_unlock_pair_missing")
        }
        if ($averageCpu -gt $acceptanceLimits.averageNormalizedCpuPercent) {
            $acceptanceFailures.Add("average_cpu_limit_exceeded")
        }
        if ($p95Cpu -gt $acceptanceLimits.p95NormalizedCpuPercent) {
            $acceptanceFailures.Add("p95_cpu_limit_exceeded")
        }
        if ($workingSetTrend.slopePerHour -gt $acceptanceLimits.workingSetSlopeBytesPerHour) {
            $acceptanceFailures.Add("working_set_slope_limit_exceeded")
        }
        if ($workingSetTrend.segmentGrowth -gt $acceptanceLimits.workingSetSegmentGrowthBytes) {
            $acceptanceFailures.Add("working_set_segment_growth_limit_exceeded")
        }
        if ($privateMemoryTrend.slopePerHour -gt $acceptanceLimits.privateMemorySlopeBytesPerHour) {
            $acceptanceFailures.Add("private_memory_slope_limit_exceeded")
        }
        if ($privateMemoryTrend.segmentGrowth -gt $acceptanceLimits.privateMemorySegmentGrowthBytes) {
            $acceptanceFailures.Add("private_memory_segment_growth_limit_exceeded")
        }
        if ($handleTrend.slopePerHour -gt $acceptanceLimits.handleSlopePerHour) {
            $acceptanceFailures.Add("handle_slope_limit_exceeded")
        }
        if ($handleTrend.segmentGrowth -gt $acceptanceLimits.handleSegmentGrowth) {
            $acceptanceFailures.Add("handle_segment_growth_limit_exceeded")
        }
        if ($threadTrend.slopePerHour -gt $acceptanceLimits.threadSlopePerHour) {
            $acceptanceFailures.Add("thread_slope_limit_exceeded")
        }
        if ($threadTrend.segmentGrowth -gt $acceptanceLimits.threadSegmentGrowth) {
            $acceptanceFailures.Add("thread_segment_growth_limit_exceeded")
        }
        if ($databaseGrowthBytes -gt $acceptanceLimits.databaseGrowthBytes) {
            $acceptanceFailures.Add("database_growth_limit_exceeded")
        }
    }
    $acceptancePassed = $AcceptanceGate -and $acceptanceFailures.Count -eq 0
    $ready = $smokePassed -and ((-not $AcceptanceGate) -or $acceptancePassed)
    $report = [ordered]@{
        schemaVersion = 2
        generatedAt = $finishUtc.ToString("o")
        profile = "ai-off-isolated-runtime-qa"
        bindings = $bindings
        request = [ordered]@{
            durationSeconds = $DurationSeconds
            sampleIntervalSeconds = $SampleIntervalSeconds
            warmupSeconds = $WarmupSeconds
            acceptanceGateRequested = [bool]$AcceptanceGate
        }
        clock = [ordered]@{
            launchUtc = $launchUtc.ToString("o")
            finishUtc = $finishUtc.ToString("o")
            wallClockObservedSeconds = $wallClockObservedSeconds
            monotonicObservedSeconds = $monotonicObservedSeconds
            wallClockMinusMonotonicSeconds = [math]::Round(
                $wallClockObservedSeconds - $monotonicObservedSeconds,
                3
            )
            activeSampleCoverageSeconds = $activeSampleCoverageSeconds
            maxSampleGapSeconds = [math]::Round($maxSampleGapSeconds, 3)
        }
        startupToVisibleWindowMilliseconds = $startupMilliseconds
        process = [ordered]@{
            controlledExit = $controlledExit
            exitCode = if ($process.HasExited) { [int]$process.ExitCode } else { $null }
            sampleCount = $samples.Count
            logicalProcessors = [Environment]::ProcessorCount
            averageNormalizedCpuPercent = $averageCpu
            p95NormalizedCpuPercent = $p95Cpu
            peakWorkingSetBytes = [long](($workingSets | Measure-Object -Maximum).Maximum)
            averageWorkingSetBytes = [long](($workingSets | Measure-Object -Average).Average)
            p95WorkingSetBytes = [long]$sortedWorkingSets[$p95WorkingSetIndex]
            firstWorkingSetBytes = [long]$workingSets[0]
            lastWorkingSetBytes = [long]$workingSets[-1]
            workingSetGrowthBytes = [long]($workingSets[-1] - $workingSets[0])
            peakPrivateMemoryBytes = [long](($privateBytes | Measure-Object -Maximum).Maximum)
            averagePrivateMemoryBytes = [long](($privateBytes | Measure-Object -Average).Average)
            p95PrivateMemoryBytes = [long]$sortedPrivateBytes[$p95PrivateIndex]
            firstPrivateMemoryBytes = [long]$privateBytes[0]
            lastPrivateMemoryBytes = [long]$privateBytes[-1]
            privateMemoryGrowthBytes = [long]($privateBytes[-1] - $privateBytes[0])
            peakHandleCount = [int](($handleCounts | Measure-Object -Maximum).Maximum)
            firstHandleCount = [int]$handleCounts[0]
            lastHandleCount = [int]$handleCounts[-1]
            handleGrowth = [int]($handleCounts[-1] - $handleCounts[0])
            peakThreadCount = [int](($threadCounts | Measure-Object -Maximum).Maximum)
            firstThreadCount = [int]$threadCounts[0]
            lastThreadCount = [int]$threadCounts[-1]
            threadGrowth = [int]($threadCounts[-1] - $threadCounts[0])
            peakProcessCount = [int](($samples.processCount | Measure-Object -Maximum).Maximum)
        }
        storage = [ordered]@{
            start = $databaseStart
            end = $databaseEnd
            growthBytes = $databaseGrowthBytes
            formalUserFilesWritten = $formalWrites.Count
            qaRootRemoved = $qaRootRemoved
        }
        isolation = [ordered]@{
            aiChildQueryAvailable = $true
            aiChildProcessCount = $peakAiChildCount
            applicationErrorQueryAvailable = $applicationErrorQueryAvailable
            applicationErrorCount = $applicationErrors.Count
        }
        transitions = [ordered]@{
            powerSuspendResumeObserved = $powerSuspendResumeObserved
            sessionLockUnlockObserved = $sessionLockUnlockObserved
            events = $systemTransitions
        }
        trends = [ordered]@{
            workingSetBytes = $workingSetTrend
            privateMemoryBytes = $privateMemoryTrend
            handleCount = $handleTrend
            threadCount = $threadTrend
        }
        acceptanceGate = [ordered]@{
            requested = [bool]$AcceptanceGate
            minimumDurationSeconds = $acceptanceMinimumDurationSeconds
            minimumActiveCoverageSeconds = $acceptanceMinimumActiveCoverageSeconds
            maximumSampleIntervalSeconds = $acceptanceMaximumSampleIntervalSeconds
            limits = $acceptanceLimits
            passed = if ($AcceptanceGate) { $acceptancePassed } else { $null }
            failures = @($acceptanceFailures)
        }
        smokePassed = $smokePassed
        ready = $ready
        limitations = @(
            "The application and fixture are an isolated runtime-QA build, not the signed production candidate."
            "Segmented trends are release evidence only when the 24-hour acceptance gate is requested."
            "Sleep-resume and lock-unlock pass only after matching Windows system events are observed during this run."
            "This does not replace clean-machine, security-software, multi-DPI, or signed-candidate evidence."
        )
        samples = @($samples)
    }

    $reportPath = Join-Path $evidenceRoot "runtime-baseline-$runId.json"
    $report | ConvertTo-Json -Depth 8 | Set-Content -Encoding UTF8 -LiteralPath $reportPath
    Write-Output "Runtime baseline report written: $reportPath"
    Write-Output (
        "Startup={0}ms AverageCPU={1}% PeakWorkingSet={2} bytes Ready={3}" -f
        $startupMilliseconds,
        $report.process.averageNormalizedCpuPercent,
        $report.process.peakWorkingSetBytes,
        $report.ready
    )
    if (-not $report.ready) { exit 2 }
}
finally {
    if (-not $systemProbeStopped) {
        [YuanyuanRuntimeSystemProbe]::StopAndSnapshot() | Out-Null
    }
    if ($null -ne $process) {
        $process.Refresh()
        if (-not $process.HasExited) {
            Stop-Process -Id $process.Id -ErrorAction SilentlyContinue
            Wait-Process -Id $process.Id -Timeout 10 -ErrorAction SilentlyContinue
        }
    }
    if (-not $qaRootRemoved -and (Test-Path -LiteralPath $qaRoot -PathType Container)) {
        Remove-OwnedQaRoot $qaRoot | Out-Null
    }
}
