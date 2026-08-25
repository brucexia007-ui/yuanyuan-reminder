param(
    [ValidateRange(120, 259020)]
    [int]$DurationSeconds = 7200,

    [ValidateRange(1, 60)]
    [int]$SampleIntervalSeconds = 60,

    [ValidateRange(5, 300)]
    [int]$WarmupSeconds = 30,

    [switch]$EvidenceGate
)

$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"

$minimumEvidenceDurationSeconds = 7200
$maximumEvidenceSampleIntervalSeconds = 60
$fixtureCardCount = 4533
$exitGraceSeconds = if ($EvidenceGate) { 180 } else { 30 }
$investigationLimits = [ordered]@{
    workingSetSlopeBytesPerHour = 4194304.0
    workingSetSegmentGrowthBytes = 67108864
    privateMemorySlopeBytesPerHour = 2097152.0
    privateMemorySegmentGrowthBytes = 33554432
    handleSlopePerHour = 2.0
    handleSegmentGrowth = 32
    threadSlopePerHour = 0.5
    threadSegmentGrowth = 8
}
if ($WarmupSeconds -ge $DurationSeconds) {
    throw "warmup must be shorter than the requested observation"
}
if ($EvidenceGate) {
    if ($DurationSeconds -lt $minimumEvidenceDurationSeconds) {
        throw "the learning memory evidence gate requires at least 7200 seconds"
    }
    if ($SampleIntervalSeconds -gt $maximumEvidenceSampleIntervalSeconds) {
        throw "the learning memory evidence gate requires samples at least every 60 seconds"
    }
}

$projectRoot = Split-Path -Parent $PSScriptRoot
$workspaceRoot = Split-Path -Parent $projectRoot
$runtimeTarget = Join-Path $projectRoot "src-tauri\target\runtime-qa-learning-memory\release"
$appPath = Join-Path $runtimeTarget "yuanyuan-reminder.exe"
$fixturePath = Join-Path $runtimeTarget "yuanyuan-runtime-qa-fixture.exe"
$evidenceRoot = Join-Path $runtimeTarget "evidence"
$runId = (Get-Date).ToUniversalTime().ToString("yyyyMMddTHHmmssZ")
$leaf = "yuanyuan-runtime-qa-learning-memory-$runId"
$qaRoot = Join-Path $workspaceRoot $leaf
$markerPath = Join-Path $qaRoot ".yuanyuan-runtime-qa-v1"
$expectedMarker = "YUANYUAN_RUNTIME_QA_V1`n"
$reportPath = Join-Path $evidenceRoot "learning-memory-$runId.json"
$formalDataRoot = Join-Path $env:LOCALAPPDATA "com.yuanyuan.reminder"

$learningPageFragment = -join @([char]0x5B66, [char]0x4E60, [char]0x9875, [char]0x9762)
$blackboardFragment = -join @(
    [char]0x5706, [char]0x5706, [char]0x684C, [char]0x9762,
    [char]0x82F1, [char]0x8BED, [char]0x590D, [char]0x4E60
)
$startRoundFragment = -join @([char]0x5F00, [char]0x59CB, [char]0x4E00, [char]0x8F6E)
$syntheticChoiceFragment = -join @(
    [char]0x5408, [char]0x6210, [char]0x91CA, [char]0x4E49
)
$correctFragment = -join @([char]0x56DE, [char]0x7B54, [char]0x6B63, [char]0x786E)
$wrongFragment = -join @(
    [char]0x8FD9, [char]0x6B21, [char]0x9700, [char]0x8981,
    [char]0x518D, [char]0x770B
)
$continueFragment = -join @(
    [char]0x6211, [char]0x770B, [char]0x61C2, [char]0x4E86,
    [char]0xFF0C, [char]0x4E0B, [char]0x4E00, [char]0x9898
)
$resultsFragment = -join @([char]0x67E5, [char]0x770B, [char]0x7ED3, [char]0x679C)
$completeFragment = -join @(
    [char]0x82F1, [char]0x8BED, [char]0x590D, [char]0x4E60,
    [char]0x5B8C, [char]0x6210
)

foreach ($required in @($appPath, $fixturePath)) {
    if (-not (Test-Path -LiteralPath $required -PathType Leaf)) {
        throw "learning runtime QA binary is missing; run npm.cmd run runtime:qa:learning:build first"
    }
}
New-Item -ItemType Directory -Force -Path $evidenceRoot | Out-Null
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes
Add-Type -AssemblyName System.Windows.Forms

if (-not ("YuanyuanLearningMemoryWindowProbe" -as [type])) {
    Add-Type -TypeDefinition @"
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;

public static class YuanyuanLearningMemoryWindowProbe {
    private delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);

    [DllImport("user32.dll")]
    private static extern bool EnumWindows(EnumWindowsProc callback, IntPtr lParam);

    [DllImport("user32.dll")]
    private static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint processId);

    [DllImport("user32.dll")]
    private static extern bool IsWindowVisible(IntPtr hWnd);

    public static IntPtr[] VisibleWindows(int processId) {
        var windows = new List<IntPtr>();
        EnumWindows((hWnd, lParam) => {
            uint owner;
            GetWindowThreadProcessId(hWnd, out owner);
            if (owner == (uint)processId && IsWindowVisible(hWnd)) windows.Add(hWnd);
            return true;
        }, IntPtr.Zero);
        return windows.ToArray();
    }
}
"@
}

function Restore-EnvironmentValue([string]$Name, [string]$Value, [bool]$Existed) {
    if ($Existed) { Set-Item -LiteralPath "Env:$Name" -Value $Value }
    else { Remove-Item -LiteralPath "Env:$Name" -ErrorAction SilentlyContinue }
}

function Get-StringSha256([string]$Value) {
    $algorithm = [System.Security.Cryptography.SHA256]::Create()
    try {
        $bytes = [System.Text.Encoding]::UTF8.GetBytes($Value)
        return ([BitConverter]::ToString($algorithm.ComputeHash($bytes))).Replace("-", "")
    }
    finally { $algorithm.Dispose() }
}

function Get-FileSha256([string]$Path) {
    $algorithm = [System.Security.Cryptography.SHA256]::Create()
    $stream = $null
    try {
        $stream = [System.IO.File]::OpenRead($Path)
        return ([BitConverter]::ToString($algorithm.ComputeHash($stream))).Replace("-", "")
    }
    finally {
        if ($null -ne $stream) { $stream.Dispose() }
        $algorithm.Dispose()
    }
}

function Get-WebView2Version {
    try {
        $webView = Get-Process -Name "msedgewebview2" -ErrorAction Stop | Select-Object -First 1
        return $webView.MainModule.FileVersionInfo.FileVersion
    }
    catch { return $null }
}

function Wait-RuntimeStage([string]$Root, [string]$Stage, [int]$TimeoutSeconds) {
    $path = Join-Path (Join-Path $Root "status") $Stage
    $deadline = [DateTime]::UtcNow.AddSeconds($TimeoutSeconds)
    while ([DateTime]::UtcNow -lt $deadline) {
        if (Test-Path -LiteralPath $path -PathType Leaf) { return $true }
        Start-Sleep -Milliseconds 50
    }
    return $false
}

function Get-AccessibleNodes([int]$ProcessId) {
    $result = [System.Collections.Generic.List[object]]::new()
    foreach ($handle in @([YuanyuanLearningMemoryWindowProbe]::VisibleWindows($ProcessId))) {
        try {
            $root = [System.Windows.Automation.AutomationElement]::FromHandle($handle)
            $result.Add($root)
            $nodes = $root.FindAll(
                [System.Windows.Automation.TreeScope]::Descendants,
                [System.Windows.Automation.Condition]::TrueCondition
            )
            foreach ($node in $nodes) { $result.Add($node) }
        }
        catch {
            # WebView accessibility nodes may disappear between snapshots.
        }
    }
    return @($result)
}

function Get-AccessibleNameSnapshot([int]$ProcessId) {
    $names = [System.Collections.Generic.List[string]]::new()
    $seen = [System.Collections.Generic.HashSet[string]]::new()
    foreach ($node in @(Get-AccessibleNodes $ProcessId)) {
        try {
            $name = ([string]$node.Current.Name).Replace("`r", " ").Replace("`n", " ").Trim()
            if (-not $name) { continue }
            if ($name.Length -gt 120) { $name = $name.Substring(0, 120) }
            if ($seen.Add($name)) { $names.Add($name) }
            if ($names.Count -ge 40) { break }
        }
        catch {}
    }
    return [string]::Join(" | ", $names)
}

function Find-AccessibleElement([int]$ProcessId, [string]$Fragment, [bool]$ButtonOnly) {
    foreach ($node in @(Get-AccessibleNodes $ProcessId)) {
        try {
            $name = $node.Current.Name
            if (-not $name -or -not $name.Contains($Fragment)) { continue }
            if (
                $ButtonOnly -and
                $node.Current.ControlType -ne [System.Windows.Automation.ControlType]::Button
            ) { continue }
            if ($node.Current.IsEnabled) { return $node }
        }
        catch {}
    }
    return $null
}

function Find-FirstChoice([int]$ProcessId) {
    return Find-AccessibleElement $ProcessId $syntheticChoiceFragment $true
}

function Wait-AccessibleElement(
    [System.Diagnostics.Process]$Process,
    [string]$Fragment,
    [bool]$ButtonOnly,
    [int]$TimeoutSeconds
) {
    $deadline = [DateTime]::UtcNow.AddSeconds($TimeoutSeconds)
    while ([DateTime]::UtcNow -lt $deadline) {
        $Process.Refresh()
        if ($Process.HasExited) { throw "application exited before an accessibility target appeared" }
        $element = Find-AccessibleElement $Process.Id $Fragment $ButtonOnly
        if ($null -ne $element) { return $element }
        Start-Sleep -Milliseconds 50
    }
    throw "learning accessibility target was not found"
}

function Invoke-AccessibleElement([System.Windows.Automation.AutomationElement]$Element) {
    $pattern = $null
    if (-not $Element.TryGetCurrentPattern(
        [System.Windows.Automation.InvokePattern]::Pattern,
        [ref]$pattern
    )) { throw "learning control does not expose the invoke pattern" }
    ([System.Windows.Automation.InvokePattern]$pattern).Invoke()
}

function Wait-QuestionOutcome([System.Diagnostics.Process]$Process, [int]$TimeoutSeconds) {
    $deadline = [DateTime]::UtcNow.AddSeconds($TimeoutSeconds)
    while ([DateTime]::UtcNow -lt $deadline) {
        $Process.Refresh()
        if ($Process.HasExited) { throw "application exited while waiting for an answer result" }
        if ($null -ne (Find-AccessibleElement $Process.Id $completeFragment $false)) {
            return [ordered]@{ kind = "complete"; element = $null }
        }
        if ($null -ne (Find-AccessibleElement $Process.Id $correctFragment $false)) {
            return [ordered]@{ kind = "correct"; element = $null }
        }
        if ($null -ne (Find-AccessibleElement $Process.Id $wrongFragment $false)) {
            $next = Find-AccessibleElement $Process.Id $continueFragment $true
            if ($null -eq $next) {
                $next = Find-AccessibleElement $Process.Id $resultsFragment $true
            }
            if ($null -ne $next) { return [ordered]@{ kind = "wrong"; element = $next } }
        }
        Start-Sleep -Milliseconds 100
    }
    $snapshot = Get-AccessibleNameSnapshot $Process.Id
    throw "learning answer outcome did not become ready; accessible nodes: $snapshot"
}

function Complete-FixedRound([System.Diagnostics.Process]$Process) {
    $started = [Diagnostics.Stopwatch]::StartNew()
    $answersSubmitted = 0
    $wrongContinuations = 0
    while ($answersSubmitted -lt 12) {
        if ($null -ne (Find-AccessibleElement $Process.Id $completeFragment $false)) {
            return [ordered]@{
                answersSubmitted = $answersSubmitted
                wrongContinuations = $wrongContinuations
                completionMilliseconds = [math]::Round($started.Elapsed.TotalMilliseconds, 1)
            }
        }
        $choiceDeadline = [DateTime]::UtcNow.AddSeconds(15)
        $choice = $null
        while ([DateTime]::UtcNow -lt $choiceDeadline -and $null -eq $choice) {
            $choice = Find-FirstChoice $Process.Id
            if ($null -eq $choice) { Start-Sleep -Milliseconds 100 }
        }
        if ($null -eq $choice) { throw "first fixed answer choice did not become ready" }
        $choiceName = $choice.Current.Name
        $preAnswerSnapshot = Get-AccessibleNameSnapshot $Process.Id
        Invoke-AccessibleElement $choice
        $answersSubmitted += 1
        try { $outcome = Wait-QuestionOutcome $Process 15 }
        catch {
            throw "answer choice '$choiceName' did not reach an outcome: $($_.Exception.Message); before answer: $preAnswerSnapshot"
        }
        if ($outcome.kind -eq "complete") {
            return [ordered]@{
                answersSubmitted = $answersSubmitted
                wrongContinuations = $wrongContinuations
                completionMilliseconds = [math]::Round($started.Elapsed.TotalMilliseconds, 1)
            }
        }
        if ($outcome.kind -eq "wrong") {
            Invoke-AccessibleElement $outcome.element
            $wrongContinuations += 1
        }
        Start-Sleep -Milliseconds 1500
    }
    throw "fixed learning round did not complete within 12 deterministic answers"
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
    return [ordered]@{ fileCount = $files.Count; bytes = [long]$totalBytes }
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
        }
        catch {}
    }
    return [ordered]@{
        cpuSeconds = $cpuSeconds
        cpuByProcess = $cpuByProcess
        workingSetBytes = $workingSetBytes
        privateMemoryBytes = $privateMemoryBytes
        handleCount = $handleCount
        threadCount = $threadCount
        processCount = $processCount
    }
}

function Get-Median([double[]]$Values) {
    $ordered = @($Values | Sort-Object)
    $middle = [math]::Floor($ordered.Count / 2)
    if (($ordered.Count % 2) -eq 1) { return [double]$ordered[$middle] }
    return ([double]$ordered[$middle - 1] + [double]$ordered[$middle]) / 2.0
}

function Get-SegmentedTrend([object[]]$InputSamples, [string]$Metric) {
    $segmentTotal = 6
    if ($InputSamples.Count -lt $segmentTotal) { throw "six samples are required for trends" }
    $firstElapsed = [double]$InputSamples[0].elapsedSeconds
    $span = [double]$InputSamples[-1].elapsedSeconds - $firstElapsed
    if ($span -le 0) { throw "sample span must be positive" }
    $buckets = @()
    for ($index = 0; $index -lt $segmentTotal; $index += 1) {
        $buckets += ,([System.Collections.Generic.List[object]]::new())
    }
    foreach ($sample in $InputSamples) {
        $position = ([double]$sample.elapsedSeconds - $firstElapsed) / $span
        $bucketIndex = [math]::Min($segmentTotal - 1, [math]::Floor($position * $segmentTotal))
        $buckets[$bucketIndex].Add($sample)
    }
    $segments = @()
    foreach ($index in 0..($segmentTotal - 1)) {
        $bucket = @($buckets[$index])
        if ($bucket.Count -eq 0) { throw "all six trend segments need samples" }
        $elapsed = [double[]]@($bucket | ForEach-Object { [double]$_.elapsedSeconds })
        $values = [double[]]@($bucket | ForEach-Object { [double]($_.$Metric) })
        $segments += [ordered]@{
            index = $index + 1
            medianElapsedSeconds = [math]::Round((Get-Median $elapsed), 3)
            medianValue = [math]::Round((Get-Median $values), 4)
            sampleCount = $bucket.Count
        }
    }
    $meanElapsed = [double](($segments.medianElapsedSeconds | Measure-Object -Average).Average)
    $meanValue = [double](($segments.medianValue | Measure-Object -Average).Average)
    [double]$numerator = 0
    [double]$denominator = 0
    foreach ($segment in $segments) {
        $elapsedDelta = [double]$segment.medianElapsedSeconds - $meanElapsed
        $numerator += $elapsedDelta * ([double]$segment.medianValue - $meanValue)
        $denominator += $elapsedDelta * $elapsedDelta
    }
    return [ordered]@{
        metric = $Metric
        segmentCount = $segmentTotal
        slopePerHour = [math]::Round(($numerator / $denominator) * 3600.0, 4)
        firstMedian = [double]$segments[0].medianValue
        lastMedian = [double]$segments[-1].medianValue
        segmentGrowth = [math]::Round(
            [double]$segments[-1].medianValue - [double]$segments[0].medianValue,
            4
        )
        segments = $segments
    }
}

function Remove-OwnedQaRoot([string]$Root, [string]$ExpectedLeaf) {
    if (-not (Test-Path -LiteralPath $Root -PathType Container)) { return $true }
    $canonicalRoot = (Resolve-Path -LiteralPath $Root).Path
    $canonicalParent = (Resolve-Path -LiteralPath $workspaceRoot).Path
    if (
        (Split-Path -Parent $canonicalRoot) -ne $canonicalParent -or
        (Split-Path -Leaf $canonicalRoot) -ne $ExpectedLeaf -or
        -not (Test-Path -LiteralPath $markerPath -PathType Leaf) -or
        (Get-Content -Raw -Encoding UTF8 -LiteralPath $markerPath) -ne $expectedMarker
    ) { throw "refusing to remove an unowned runtime QA root" }
    Remove-Item -LiteralPath $canonicalRoot -Recurse -Force
    return -not (Test-Path -LiteralPath $canonicalRoot)
}

$lockPath = Join-Path $evidenceRoot "learning-memory.lock"
try {
    $lockStream = [System.IO.File]::Open(
        $lockPath,
        [System.IO.FileMode]::OpenOrCreate,
        [System.IO.FileAccess]::ReadWrite,
        [System.IO.FileShare]::None
    )
}
catch { throw "another learning memory measurement is already active" }

$process = $null
$qaRootRemoved = $false
$scriptExitCode = 0
try {
    $fixturePlanText = & $fixturePath --root $qaRoot --learning-performance $fixtureCardCount
    if ($LASTEXITCODE -ne 0) { throw "learning fixture seeding failed" }
    $fixturePlan = $fixturePlanText | ConvertFrom-Json
    if ($fixturePlan.cardCount -ne $fixtureCardCount) { throw "learning fixture count changed" }
    $reminderPauseUntilUtc = [DateTimeOffset]::Parse($fixturePlan.reminderPauseUntilUtc).ToUniversalTime()
    $minimumReminderPauseUntilUtc = [DateTimeOffset]::UtcNow.AddSeconds(
        $DurationSeconds + $exitGraceSeconds + 60
    )
    if ($reminderPauseUntilUtc -lt $minimumReminderPauseUntilUtc) {
        throw "learning fixture reminder pause does not cover the observation"
    }
    $databasePath = Join-Path $qaRoot "learning-data\yuanyuan-learning.sqlite3"
    $databaseStart = Get-DatabaseSnapshot $qaRoot
    $launchUtc = (Get-Date).ToUniversalTime()
    $launchTimer = [Diagnostics.Stopwatch]::StartNew()
    $rootExisted = Test-Path Env:YUANYUAN_RUNTIME_QA_ROOT
    $profileExisted = Test-Path Env:YUANYUAN_RUNTIME_QA_PROFILE
    $exitExisted = Test-Path Env:YUANYUAN_RUNTIME_QA_EXIT_AFTER_SECONDS
    $oldRoot = $env:YUANYUAN_RUNTIME_QA_ROOT
    $oldProfile = $env:YUANYUAN_RUNTIME_QA_PROFILE
    $oldExit = $env:YUANYUAN_RUNTIME_QA_EXIT_AFTER_SECONDS
    try {
        $env:YUANYUAN_RUNTIME_QA_ROOT = $qaRoot
        $env:YUANYUAN_RUNTIME_QA_PROFILE = "learning-performance"
        $env:YUANYUAN_RUNTIME_QA_EXIT_AFTER_SECONDS = [string]($DurationSeconds + $exitGraceSeconds)
        $process = Start-Process -FilePath $appPath -PassThru
    }
    finally {
        Restore-EnvironmentValue "YUANYUAN_RUNTIME_QA_ROOT" $oldRoot $rootExisted
        Restore-EnvironmentValue "YUANYUAN_RUNTIME_QA_PROFILE" $oldProfile $profileExisted
        Restore-EnvironmentValue "YUANYUAN_RUNTIME_QA_EXIT_AFTER_SECONDS" $oldExit $exitExisted
    }

    if (-not (Wait-RuntimeStage $qaRoot "exit-scheduled" 30)) {
        throw "runtime QA setup did not complete"
    }
    $null = Wait-AccessibleElement $process $learningPageFragment $false 30
    $pageReadyMilliseconds = [math]::Round($launchTimer.Elapsed.TotalMilliseconds, 1)
    $startButton = Wait-AccessibleElement $process $startRoundFragment $true 10
    $roundStartTimer = [Diagnostics.Stopwatch]::StartNew()
    Invoke-AccessibleElement $startButton
    $null = Wait-AccessibleElement $process $blackboardFragment $false 20
    $blackboardReadyMilliseconds = [math]::Round($roundStartTimer.Elapsed.TotalMilliseconds, 1)
    $fixedRound = Complete-FixedRound $process
    $null = Wait-AccessibleElement $process $completeFragment $false 10
    $webView2Version = Get-WebView2Version

    Start-Sleep -Seconds $WarmupSeconds
    $process.Refresh()
    if ($process.HasExited) { throw "application exited before memory sampling" }
    $samplingStartUtc = (Get-Date).ToUniversalTime()
    $samplingTimer = [Diagnostics.Stopwatch]::StartNew()
    $samples = [System.Collections.Generic.List[object]]::new()
    $initialTree = Get-ProcessTreeSample $process.Id
    $previousCpuByProcess = $initialTree.cpuByProcess
    $lastSampleSeconds = 0.0
    while ($true) {
        $process.Refresh()
        if ($process.HasExited) { break }
        $elapsedSeconds = $samplingTimer.Elapsed.TotalSeconds
        if ($elapsedSeconds -gt ($DurationSeconds + 1)) { break }
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
        $previousCpuByProcess = $tree.cpuByProcess
        $lastSampleSeconds = $elapsedSeconds
        if ($elapsedSeconds -ge $DurationSeconds) { break }
        $remaining = $DurationSeconds - $elapsedSeconds
        Start-Sleep -Seconds ([math]::Min($SampleIntervalSeconds, [math]::Ceiling($remaining)))
    }
    $observedSeconds = [math]::Round($samplingTimer.Elapsed.TotalSeconds, 3)
    if ($samples.Count -lt 6) { throw "learning memory observation produced too few samples" }
    $steadyStateValidatedAtEnd = $null -ne (
        Find-AccessibleElement $process.Id $completeFragment $false
    )

    $process.WaitForExit(($exitGraceSeconds + 30) * 1000) | Out-Null
    $process.Refresh()
    $controlledExit = $process.HasExited -and $process.ExitCode -eq 0
    $finishUtc = (Get-Date).ToUniversalTime()
    $databaseEnd = Get-DatabaseSnapshot $qaRoot
    $workingSets = @($samples | ForEach-Object { [long]$_.workingSetBytes })
    $privateBytes = @($samples | ForEach-Object { [long]$_.privateMemoryBytes })
    $cpuValues = @($samples | ForEach-Object { [double]$_.cpuPercent })
    $handleCounts = @($samples | ForEach-Object { [int]$_.handleCount })
    $threadCounts = @($samples | ForEach-Object { [int]$_.threadCount })
    $workingSetTrend = Get-SegmentedTrend @($samples) "workingSetBytes"
    $privateMemoryTrend = Get-SegmentedTrend @($samples) "privateMemoryBytes"
    $handleTrend = Get-SegmentedTrend @($samples) "handleCount"
    $threadTrend = Get-SegmentedTrend @($samples) "threadCount"
    [double]$maxSampleGapSeconds = 0
    for ($index = 1; $index -lt $samples.Count; $index += 1) {
        $gap = [double]$samples[$index].elapsedSeconds - [double]$samples[$index - 1].elapsedSeconds
        $maxSampleGapSeconds = [math]::Max($maxSampleGapSeconds, $gap)
    }
    $applicationErrorQueryAvailable = $true
    $applicationErrors = @()
    $eventReadErrors = @()
    $applicationErrors = @(Get-WinEvent -FilterHashtable @{
        LogName = "Application"
        StartTime = $launchUtc.ToLocalTime()
        Level = 2
    } -ErrorAction SilentlyContinue -ErrorVariable eventReadErrors |
        Where-Object { $_.Message -like "*yuanyuan-reminder*" })
    if (@($eventReadErrors | Where-Object {
        $_.FullyQualifiedErrorId -notlike "NoMatchingEventsFound*"
    }).Count -gt 0) { $applicationErrorQueryAvailable = $false }
    $formalWrites = @()
    if (Test-Path -LiteralPath $formalDataRoot -PathType Container) {
        $formalWrites = @(Get-ChildItem -LiteralPath $formalDataRoot -Recurse -File -ErrorAction Stop |
            Where-Object { $_.LastWriteTimeUtc -ge $launchUtc })
    }
    $qaRootRemoved = Remove-OwnedQaRoot $qaRoot $leaf

    $gateFailures = [System.Collections.Generic.List[string]]::new()
    if ($EvidenceGate) {
        if (-not $controlledExit) { $gateFailures.Add("controlled_exit_failed") }
        if ($DurationSeconds -lt $minimumEvidenceDurationSeconds) {
            $gateFailures.Add("requested_duration_below_two_hours")
        }
        if ($observedSeconds -lt $DurationSeconds) {
            $gateFailures.Add("observed_duration_shorter_than_requested")
        }
        if ($SampleIntervalSeconds -gt $maximumEvidenceSampleIntervalSeconds) {
            $gateFailures.Add("sample_interval_above_60_seconds")
        }
        if ($maxSampleGapSeconds -gt ($SampleIntervalSeconds + 10)) {
            $gateFailures.Add("sample_gap_exceeded_tolerance")
        }
        if (-not $fixedRound -or $fixedRound.answersSubmitted -lt 3) {
            $gateFailures.Add("fixed_round_not_completed")
        }
        if (-not $steadyStateValidatedAtEnd) {
            $gateFailures.Add("steady_state_not_completed_blackboard")
        }
        if (-not $qaRootRemoved) { $gateFailures.Add("qa_root_cleanup_failed") }
        if ($formalWrites.Count -ne 0) { $gateFailures.Add("formal_user_data_was_modified") }
        if (-not $applicationErrorQueryAvailable -or $applicationErrors.Count -ne 0) {
            $gateFailures.Add("application_error_evidence_failed")
        }
        if ($workingSetTrend.slopePerHour -gt $investigationLimits.workingSetSlopeBytesPerHour) {
            $gateFailures.Add("working_set_slope_limit_exceeded")
        }
        if ($workingSetTrend.segmentGrowth -gt $investigationLimits.workingSetSegmentGrowthBytes) {
            $gateFailures.Add("working_set_segment_growth_limit_exceeded")
        }
        if ($privateMemoryTrend.slopePerHour -gt $investigationLimits.privateMemorySlopeBytesPerHour) {
            $gateFailures.Add("private_memory_slope_limit_exceeded")
        }
        if ($privateMemoryTrend.segmentGrowth -gt $investigationLimits.privateMemorySegmentGrowthBytes) {
            $gateFailures.Add("private_memory_segment_growth_limit_exceeded")
        }
        if ($handleTrend.slopePerHour -gt $investigationLimits.handleSlopePerHour) {
            $gateFailures.Add("handle_slope_limit_exceeded")
        }
        if ($handleTrend.segmentGrowth -gt $investigationLimits.handleSegmentGrowth) {
            $gateFailures.Add("handle_segment_growth_limit_exceeded")
        }
        if ($threadTrend.slopePerHour -gt $investigationLimits.threadSlopePerHour) {
            $gateFailures.Add("thread_slope_limit_exceeded")
        }
        if ($threadTrend.segmentGrowth -gt $investigationLimits.threadSegmentGrowth) {
            $gateFailures.Add("thread_segment_growth_limit_exceeded")
        }
    }
    $gatePassed = $EvidenceGate -and $gateFailures.Count -eq 0
    $ready = $controlledExit -and $qaRootRemoved -and
        $applicationErrorQueryAvailable -and $applicationErrors.Count -eq 0 -and
        $formalWrites.Count -eq 0 -and $steadyStateValidatedAtEnd -and
        ((-not $EvidenceGate) -or $gatePassed)
    $windowsVersion = Get-ItemProperty -LiteralPath "HKLM:\SOFTWARE\Microsoft\Windows NT\CurrentVersion"
    $gitCommit = (& git -C $projectRoot rev-parse HEAD).Trim()
    $gitStatus = (& git -C $projectRoot status --porcelain=v1 --untracked-files=all) -join "`n"
    $sortedCpu = @($cpuValues | Sort-Object)
    $sortedWorkingSets = @($workingSets | Sort-Object)
    $sortedPrivateBytes = @($privateBytes | Sort-Object)
    $p95Index = [math]::Floor(($samples.Count - 1) * 0.95)
    $report = [ordered]@{
        schemaVersion = 1
        generatedAt = $finishUtc.ToString("o")
        profile = "learning-memory"
        source = [ordered]@{
            gitCommit = $gitCommit
            gitDirty = $gitStatus.Length -gt 0
            gitStatusSha256 = Get-StringSha256 $gitStatus
        }
        bindings = [ordered]@{
            applicationSha256 = Get-FileSha256 $appPath
            fixtureExecutableSha256 = Get-FileSha256 $fixturePath
            fixtureContentSha256 = $fixturePlan.contentSha256
            fixtureDatabaseSha256 = $fixturePlan.databaseSha256
            scriptSha256 = Get-FileSha256 $PSCommandPath
        }
        device = [ordered]@{
            windowsProductName = $windowsVersion.ProductName
            windowsDisplayVersion = $windowsVersion.DisplayVersion
            windowsBuild = "$($windowsVersion.CurrentBuildNumber).$($windowsVersion.UBR)"
            processorArchitecture = [Environment]::GetEnvironmentVariable("PROCESSOR_ARCHITECTURE")
            logicalProcessors = [Environment]::ProcessorCount
            powerLineStatus = [string]([System.Windows.Forms.SystemInformation]::PowerStatus).PowerLineStatus
            webView2RuntimeVersion = $webView2Version
        }
        request = [ordered]@{
            durationSeconds = $DurationSeconds
            sampleIntervalSeconds = $SampleIntervalSeconds
            warmupSeconds = $WarmupSeconds
            evidenceGateRequested = [bool]$EvidenceGate
        }
        fixture = [ordered]@{
            cardCount = $fixtureCardCount
            contentKind = "deterministic-synthetic-english-csv"
            initialDatabaseBytes = [long]$fixturePlan.databaseBytes
            reminderPauseUntilUtc = $reminderPauseUntilUtc.ToString("o")
        }
        operations = [ordered]@{
            pageReady = $true
            pageReadyMilliseconds = $pageReadyMilliseconds
            roundStarted = $true
            blackboardReadyMilliseconds = $blackboardReadyMilliseconds
            answerStrategy = "first-enabled-choice"
            answersSubmitted = [int]$fixedRound.answersSubmitted
            wrongContinuations = [int]$fixedRound.wrongContinuations
            roundCompleted = $true
            roundCompletionMilliseconds = [double]$fixedRound.completionMilliseconds
            steadyState = "completed-blackboard"
            steadyStateValidatedAtEnd = $steadyStateValidatedAtEnd
        }
        clock = [ordered]@{
            launchUtc = $launchUtc.ToString("o")
            samplingStartUtc = $samplingStartUtc.ToString("o")
            finishUtc = $finishUtc.ToString("o")
            observedSeconds = $observedSeconds
            maxSampleGapSeconds = [math]::Round($maxSampleGapSeconds, 3)
        }
        process = [ordered]@{
            controlledExit = $controlledExit
            exitCode = if ($process.HasExited) { [int]$process.ExitCode } else { $null }
            sampleCount = $samples.Count
            averageNormalizedCpuPercent = [math]::Round(
                [double](($cpuValues | Measure-Object -Average).Average), 4
            )
            p95NormalizedCpuPercent = [math]::Round([double]$sortedCpu[$p95Index], 4)
            peakWorkingSetBytes = [long](($workingSets | Measure-Object -Maximum).Maximum)
            p95WorkingSetBytes = [long]$sortedWorkingSets[$p95Index]
            firstWorkingSetBytes = [long]$workingSets[0]
            lastWorkingSetBytes = [long]$workingSets[-1]
            peakPrivateMemoryBytes = [long](($privateBytes | Measure-Object -Maximum).Maximum)
            p95PrivateMemoryBytes = [long]$sortedPrivateBytes[$p95Index]
            firstPrivateMemoryBytes = [long]$privateBytes[0]
            lastPrivateMemoryBytes = [long]$privateBytes[-1]
            peakHandleCount = [int](($handleCounts | Measure-Object -Maximum).Maximum)
            firstHandleCount = [int]$handleCounts[0]
            lastHandleCount = [int]$handleCounts[-1]
            peakThreadCount = [int](($threadCounts | Measure-Object -Maximum).Maximum)
            firstThreadCount = [int]$threadCounts[0]
            lastThreadCount = [int]$threadCounts[-1]
            peakProcessCount = [int](($samples.processCount | Measure-Object -Maximum).Maximum)
        }
        storage = [ordered]@{
            start = $databaseStart
            end = $databaseEnd
            growthBytes = [long]($databaseEnd.bytes - $databaseStart.bytes)
            formalUserFilesWritten = $formalWrites.Count
            qaRootRemoved = $qaRootRemoved
        }
        isolation = [ordered]@{
            applicationErrorQueryAvailable = $applicationErrorQueryAvailable
            applicationErrorCount = $applicationErrors.Count
        }
        trends = [ordered]@{
            workingSetBytes = $workingSetTrend
            privateMemoryBytes = $privateMemoryTrend
            handleCount = $handleTrend
            threadCount = $threadTrend
        }
        evidenceGate = [ordered]@{
            requested = [bool]$EvidenceGate
            minimumDurationSeconds = $minimumEvidenceDurationSeconds
            maximumSampleIntervalSeconds = $maximumEvidenceSampleIntervalSeconds
            investigationLimits = $investigationLimits
            passed = if ($EvidenceGate) { $gatePassed } else { $null }
            failures = @($gateFailures)
        }
        ready = $ready
        limitations = @(
            "The application and fixture are an isolated learning runtime-QA build, not a signed production candidate."
            "The 4,533 cards are deterministic synthetic data and contain no personal learning material."
            "The fixed operation visits the learning page, completes one round by choosing the first enabled option, then samples the completed blackboard steady state."
            "The isolated fixture pauses reminder claims beyond the observation window; reminder latency and preemption are measured by separate gates."
            "The investigation limits reuse the registered stable-runtime trend limits; this two-hour result does not replace the independent 24-hour runtime gate."
            "This report does not cover generic 20,000-card import, search pagination, multi-DPI, Narrator, reduced motion, or signed-candidate behavior."
        )
        samples = @($samples)
    }
    $report | ConvertTo-Json -Depth 9 | Set-Content -Encoding UTF8 -LiteralPath $reportPath
    Write-Output "Learning memory report written: $reportPath"
    Write-Output (
        "Observed={0}s Samples={1} Answers={2} WorkingSetSlope={3} Ready={4}" -f
        $observedSeconds,
        $samples.Count,
        $fixedRound.answersSubmitted,
        $workingSetTrend.slopePerHour,
        $ready
    )
    if (-not $ready) { $scriptExitCode = 2 }
}
finally {
    if ($null -ne $process) {
        try {
            $process.Refresh()
            if (-not $process.HasExited) {
                $ownedProcess = Get-Process -Id $process.Id -ErrorAction Stop
                if ($ownedProcess.Path -ne $appPath) {
                    throw "refusing to stop a process outside the runtime QA executable"
                }
                Stop-Process -Id $process.Id -Force
            }
        }
        catch {}
    }
    if (-not $qaRootRemoved -and (Test-Path -LiteralPath $qaRoot -PathType Container)) {
        try { $qaRootRemoved = Remove-OwnedQaRoot $qaRoot $leaf }
        catch {}
    }
    if ($null -ne $lockStream) { $lockStream.Dispose() }
    Remove-Item -LiteralPath $lockPath -Force -ErrorAction SilentlyContinue
}
exit $scriptExitCode
