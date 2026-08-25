param(
    [ValidateRange(1, 20)]
    [int]$SampleCount = 1,

    [ValidateRange(30, 120)]
    [int]$ExitAfterSeconds = 30,

    [switch]$EvidenceGate
)

$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"
$projectRoot = Split-Path -Parent $PSScriptRoot
$workspaceRoot = Split-Path -Parent $projectRoot
$runtimeTarget = Join-Path $projectRoot "src-tauri\target\runtime-qa-learning-preemption\release"
$appPath = Join-Path $runtimeTarget "yuanyuan-reminder.exe"
$fixturePath = Join-Path $runtimeTarget "yuanyuan-runtime-qa-fixture.exe"
$evidenceRoot = Join-Path $runtimeTarget "evidence"
$runId = (Get-Date).ToUniversalTime().ToString("yyyyMMddTHHmmssZ")
$reportPath = Join-Path $evidenceRoot "learning-reminder-preemption-$runId.json"
$expectedMarker = "YUANYUAN_RUNTIME_QA_V1`n"
$fixtureCardCount = 5
$minimumEvidenceSamples = 20
$dueOffsets = @(2, 5, 8, 11, 14)
$limits = [ordered]@{
    backendLatencyP95Milliseconds = 16000.0
    persistedPreemptionP95Milliseconds = 1000.0
    uiHandoffP95Milliseconds = 1000.0
    presentationLatencyP95Milliseconds = 17000.0
    perSamplePreemptionMilliseconds = 1000.0
}
$learningPageFragment = -join @([char]0x5B66, [char]0x4E60, [char]0x9875, [char]0x9762)
$blackboardFragment = -join @(
    [char]0x5706, [char]0x5706, [char]0x684C, [char]0x9762,
    [char]0x82F1, [char]0x8BED, [char]0x590D, [char]0x4E60
)
$startRoundFragment = -join @([char]0x5F00, [char]0x59CB, [char]0x4E00, [char]0x8F6E)

if ($EvidenceGate -and $SampleCount -lt $minimumEvidenceSamples) {
    throw "the learning reminder preemption evidence gate requires at least $minimumEvidenceSamples samples"
}
foreach ($required in @($appPath, $fixturePath)) {
    if (-not (Test-Path -LiteralPath $required -PathType Leaf)) {
        throw "learning preemption runtime QA binary is missing; run npm.cmd run runtime:qa:learning-preemption:build first"
    }
}
New-Item -ItemType Directory -Force -Path $evidenceRoot | Out-Null
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes
Add-Type -AssemblyName System.Windows.Forms

if (-not ("YuanyuanLearningPreemptionWindowProbe" -as [type])) {
    Add-Type -TypeDefinition @"
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;

public static class YuanyuanLearningPreemptionWindowProbe {
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
        $process = Get-Process -Name "msedgewebview2" -ErrorAction Stop | Select-Object -First 1
        return $process.MainModule.FileVersionInfo.FileVersion
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
    $windows = @([YuanyuanLearningPreemptionWindowProbe]::VisibleWindows($ProcessId))
    $script:probeMaxVisibleWindows = [Math]::Max($script:probeMaxVisibleWindows, $windows.Count)
    foreach ($handle in $windows) {
        try {
            $root = [System.Windows.Automation.AutomationElement]::FromHandle($handle)
            $nodes = $root.FindAll(
                [System.Windows.Automation.TreeScope]::Descendants,
                [System.Windows.Automation.Condition]::TrueCondition
            )
            $script:probeMaxAccessibleNodes = [Math]::Max(
                $script:probeMaxAccessibleNodes,
                $nodes.Count
            )
            foreach ($node in $nodes) {
                $name = $node.Current.Name
                if ($name -and $name.Length -le 256 -and $script:probeAccessibleNames.Count -lt 128) {
                    [void]$script:probeAccessibleNames.Add($name)
                }
                [void]$result.Add($node)
            }
        }
        catch {
            # React and WebView accessibility nodes can disappear between snapshots.
        }
    }
    return $result
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

function Wait-AccessibleElement(
    [System.Diagnostics.Process]$Process,
    [string]$Fragment,
    [bool]$ButtonOnly,
    [int]$TimeoutSeconds
) {
    $deadline = [DateTime]::UtcNow.AddSeconds($TimeoutSeconds)
    while ([DateTime]::UtcNow -lt $deadline) {
        $Process.Refresh()
        if ($Process.HasExited) { throw "application exited before the preemption target appeared" }
        $element = Find-AccessibleElement $Process.Id $Fragment $ButtonOnly
        if ($null -ne $element) { return $element }
        Start-Sleep -Milliseconds 50
    }
    throw "learning preemption target was not found in the Windows accessibility tree"
}

function Wait-Headword(
    [System.Diagnostics.Process]$Process,
    [string]$Expected,
    [int]$TimeoutSeconds
) {
    $deadline = [DateTime]::UtcNow.AddSeconds($TimeoutSeconds)
    while ([DateTime]::UtcNow -lt $deadline) {
        $Process.Refresh()
        if ($Process.HasExited) { throw "application exited before the learning question appeared" }
        foreach ($node in @(Get-AccessibleNodes $Process.Id)) {
            try {
                $name = $node.Current.Name
                if ($name -and $name -eq $Expected) { return $name }
            }
            catch {}
        }
        Start-Sleep -Milliseconds 50
    }
    throw "the active synthetic learning headword was not found"
}

function Invoke-AccessibleElement([System.Windows.Automation.AutomationElement]$Element) {
    $pattern = $null
    if (-not $Element.TryGetCurrentPattern(
        [System.Windows.Automation.InvokePattern]::Pattern,
        [ref]$pattern
    )) { throw "learning preemption control does not expose the invoke pattern" }
    ([System.Windows.Automation.InvokePattern]$pattern).Invoke()
}

function Start-QaApplication([string]$Root) {
    $rootExisted = Test-Path Env:YUANYUAN_RUNTIME_QA_ROOT
    $profileExisted = Test-Path Env:YUANYUAN_RUNTIME_QA_PROFILE
    $exitExisted = Test-Path Env:YUANYUAN_RUNTIME_QA_EXIT_AFTER_SECONDS
    $oldRoot = $env:YUANYUAN_RUNTIME_QA_ROOT
    $oldProfile = $env:YUANYUAN_RUNTIME_QA_PROFILE
    $oldExit = $env:YUANYUAN_RUNTIME_QA_EXIT_AFTER_SECONDS
    try {
        $env:YUANYUAN_RUNTIME_QA_ROOT = $Root
        $env:YUANYUAN_RUNTIME_QA_PROFILE = "learning-performance"
        $env:YUANYUAN_RUNTIME_QA_EXIT_AFTER_SECONDS = [string]$ExitAfterSeconds
        return Start-Process -FilePath $appPath -PassThru
    }
    finally {
        Restore-EnvironmentValue "YUANYUAN_RUNTIME_QA_ROOT" $oldRoot $rootExisted
        Restore-EnvironmentValue "YUANYUAN_RUNTIME_QA_PROFILE" $oldProfile $profileExisted
        Restore-EnvironmentValue "YUANYUAN_RUNTIME_QA_EXIT_AFTER_SECONDS" $oldExit $exitExisted
    }
}

function Stop-QaApplicationIfRunning([System.Diagnostics.Process]$Process) {
    if ($null -eq $Process) { return }
    try {
        $Process.Refresh()
        if ($Process.HasExited) { return }
        $ownedProcess = Get-Process -Id $Process.Id -ErrorAction Stop
        if ($ownedProcess.Path -ne $appPath) {
            throw "refusing to stop a process outside the preemption QA executable"
        }
        Stop-Process -Id $Process.Id -Force
        $Process.WaitForExit(10000) | Out-Null
    }
    catch {}
}

function Read-PreemptionState([string]$Root) {
    $text = & $fixturePath --root $Root --learning-preemption-state
    if ($LASTEXITCODE -ne 0) { throw "learning preemption state inspection failed" }
    return $text | ConvertFrom-Json
}

function Read-ReminderClaim([string]$Root, [string]$ReminderId) {
    $text = & $fixturePath --root $Root --read-reminder-latency $ReminderId
    if ($LASTEXITCODE -ne 0) { throw "reminder claim inspection failed" }
    return $text | ConvertFrom-Json
}

function Assert-CleanLearningState([object]$State, [string]$Phase) {
    if (
        $State.questionAttemptCount -ne 0 -or
        $State.reviewLogCount -ne 0 -or
        $State.answerCommittedEventCount -ne 0
    ) { throw "$Phase unexpectedly persisted an unanswered choice" }
    if ($State.integrityCheck -ne "ok" -or $State.foreignKeyViolationCount -ne 0) {
        throw "$Phase learning database integrity check failed"
    }
}

function Remove-OwnedQaRoot([string]$Root, [string]$ExpectedLeaf) {
    if (-not (Test-Path -LiteralPath $Root -PathType Container)) { return $true }
    $canonicalRoot = (Resolve-Path -LiteralPath $Root).Path
    $canonicalParent = (Resolve-Path -LiteralPath $workspaceRoot).Path
    $markerPath = Join-Path $canonicalRoot ".yuanyuan-runtime-qa-v1"
    if (
        (Split-Path -Parent $canonicalRoot) -ne $canonicalParent -or
        (Split-Path -Leaf $canonicalRoot) -ne $ExpectedLeaf -or
        -not (Test-Path -LiteralPath $markerPath -PathType Leaf) -or
        (Get-Content -Raw -Encoding UTF8 -LiteralPath $markerPath) -ne $expectedMarker
    ) { throw "refusing to remove an unowned runtime QA root" }
    for ($attempt = 0; $attempt -lt 5; $attempt += 1) {
        try {
            Remove-Item -LiteralPath $canonicalRoot -Recurse -Force
            return -not (Test-Path -LiteralPath $canonicalRoot)
        }
        catch {
            if ($attempt -eq 4) { throw }
            Start-Sleep -Milliseconds 500
        }
    }
    return $false
}

function Get-Percentile([double[]]$Values, [double]$Fraction) {
    if ($Values.Count -eq 0) { return $null }
    $ordered = @($Values | Sort-Object)
    $index = [Math]::Max(0, [Math]::Ceiling($Fraction * $ordered.Count) - 1)
    return [Math]::Round([double]$ordered[$index], 1)
}

$lockPath = Join-Path $evidenceRoot "learning-reminder-preemption.lock"
$lockStream = $null
try {
    $lockStream = [System.IO.File]::Open(
        $lockPath,
        [System.IO.FileMode]::OpenOrCreate,
        [System.IO.FileAccess]::ReadWrite,
        [System.IO.FileShare]::None
    )
}
catch { throw "another learning reminder preemption measurement is already active" }

$scriptExitCode = 0
try {
    $samples = @()
    $fixtureContentSha256 = $null
    $webView2Version = $null
    for ($index = 0; $index -lt $SampleCount; $index += 1) {
        $sampleNumber = $index + 1
        $leaf = "yuanyuan-runtime-qa-learning-preemption-$runId-$sampleNumber"
        $qaRoot = Join-Path $workspaceRoot $leaf
        $process = $null
        $script:probeMaxVisibleWindows = 0
        $script:probeMaxAccessibleNodes = 0
        $script:probeAccessibleNames = [System.Collections.Generic.HashSet[string]]::new()
        $sample = [ordered]@{
            sample = $sampleNumber
            dueAfterSeconds = $dueOffsets[$index % $dueOffsets.Count]
            fixtureDatabaseSha256 = $null
            fixtureDatabaseBytes = $null
            reminderId = $null
            claimStatus = $null
            scheduledAt = $null
            claimedAt = $null
            interruptedAt = $null
            presentedAt = $null
            originalHeadword = $null
            preemptionStateBefore = $null
            preemptionStateAfter = $null
            backendLatencyMilliseconds = $null
            persistedPreemptionMilliseconds = $null
            uiHandoffMilliseconds = $null
            presentationLatencyMilliseconds = $null
            uiAfterPersistenceMilliseconds = $null
            alertAccessible = $false
            blackboardYielded = $false
            sameSession = $false
            sameItem = $false
            sameHeadword = $false
            zeroAnswerWrites = $false
            controlledExit = $false
            exitCode = $null
            maxVisibleWindows = 0
            maxAccessibleNodes = 0
            observedAccessibleNames = @()
            rootRemoved = $false
            passed = $false
            failure = $null
        }
        try {
            $planText = & $fixturePath --root $qaRoot --learning-preemption $sample.dueAfterSeconds
            if ($LASTEXITCODE -ne 0) { throw "learning preemption fixture seeding failed" }
            $plan = $planText | ConvertFrom-Json
            if ($plan.cardCount -ne $fixtureCardCount) { throw "learning fixture count is incorrect" }
            if ($null -eq $fixtureContentSha256) { $fixtureContentSha256 = $plan.contentSha256 }
            elseif ($fixtureContentSha256 -ne $plan.contentSha256) {
                throw "learning fixture content changed between samples"
            }
            $sample.fixtureDatabaseSha256 = $plan.databaseSha256
            $sample.fixtureDatabaseBytes = [long]$plan.databaseBytes
            $sample.reminderId = $plan.reminderId
            $sample.scheduledAt = $plan.scheduledAt

            $process = Start-QaApplication $qaRoot
            if (-not (Wait-RuntimeStage $qaRoot "exit-scheduled" 30)) {
                throw "runtime QA window setup did not complete"
            }
            $null = Wait-AccessibleElement $process $learningPageFragment $false 30
            $startButton = Wait-AccessibleElement $process $startRoundFragment $true 10
            Invoke-AccessibleElement $startButton
            $null = Wait-AccessibleElement $process $blackboardFragment $false 20
            $before = Read-PreemptionState $qaRoot
            Assert-CleanLearningState $before "pre-preemption"
            if (
                $before.status -ne "active" -or
                $null -ne $before.pauseReason -or
                $before.interruptedEventCount -ne 0 -or
                $null -ne $before.interruptedAtUnixMs
            ) { throw "learning session is not active before the reminder" }
            $sample.originalHeadword = Wait-Headword $process $before.headword 10
            $sample.preemptionStateBefore = $before
            if ($null -eq $webView2Version) { $webView2Version = Get-WebView2Version }

            $scheduled = [DateTimeOffset]::Parse($plan.scheduledAt).ToUniversalTime()
            $presentationDeadline = $scheduled.AddSeconds(20)
            while ([DateTimeOffset]::UtcNow -lt $presentationDeadline) {
                $process.Refresh()
                if ($process.HasExited) { throw "application exited before reminder preemption" }
                if ($null -ne (Find-AccessibleElement $process.Id $plan.accessibleNameFragment $false)) {
                    $presented = [DateTimeOffset]::UtcNow
                    $sample.presentedAt = $presented.ToString("o")
                    $sample.alertAccessible = $true
                    break
                }
                Start-Sleep -Milliseconds 50
            }
            if (-not $sample.alertAccessible) {
                throw "strong reminder was not found in the Windows accessibility tree"
            }
            $claim = Read-ReminderClaim $qaRoot $plan.reminderId
            $sample.claimStatus = $claim.status
            $after = Read-PreemptionState $qaRoot
            Assert-CleanLearningState $after "post-preemption"
            if (
                $after.sessionId -ne $before.sessionId -or
                $after.currentItemId -ne $before.currentItemId -or
                $after.headword -ne $before.headword -or
                $after.status -ne "paused" -or
                $after.pauseReason -ne "preempted_high_priority" -or
                $after.stateRevision -ne ($before.stateRevision + 1) -or
                $after.interruptedEventCount -ne 1 -or
                $null -eq $after.interruptedAtUnixMs
            ) { throw "learning session did not persist the high-priority preemption" }
            $claimed = [DateTimeOffset]::Parse($claim.claimedAt).ToUniversalTime()
            $interrupted = [DateTimeOffset]::FromUnixTimeMilliseconds(
                [long]$after.interruptedAtUnixMs
            )
            $sample.claimedAt = $claimed.ToString("o")
            $sample.interruptedAt = $interrupted.ToString("o")
            $sample.preemptionStateAfter = $after
            $sample.backendLatencyMilliseconds = [Math]::Round(
                ($claimed - $scheduled).TotalMilliseconds,
                1
            )
            $sample.persistedPreemptionMilliseconds = [Math]::Round(
                ($interrupted - $claimed).TotalMilliseconds,
                1
            )
            $sample.uiHandoffMilliseconds = [Math]::Round(
                ($presented - $claimed).TotalMilliseconds,
                1
            )
            $sample.presentationLatencyMilliseconds = [Math]::Round(
                ($presented - $scheduled).TotalMilliseconds,
                1
            )
            $sample.uiAfterPersistenceMilliseconds = [Math]::Round(
                ($presented - $interrupted).TotalMilliseconds,
                1
            )
            if (
                $sample.backendLatencyMilliseconds -lt 0 -or
                $sample.persistedPreemptionMilliseconds -lt 0 -or
                $sample.uiHandoffMilliseconds -lt 0 -or
                $sample.presentationLatencyMilliseconds -lt 0 -or
                $sample.uiAfterPersistenceMilliseconds -lt 0
            ) { throw "preemption timestamps are not monotonic" }
            $sample.blackboardYielded = $null -eq (
                Find-AccessibleElement $process.Id $blackboardFragment $false
            )
            $sample.sameSession = $after.sessionId -eq $before.sessionId
            $sample.sameItem = $after.currentItemId -eq $before.currentItemId
            $sample.sameHeadword = $after.headword -eq $before.headword
            $sample.zeroAnswerWrites = (
                $after.questionAttemptCount -eq 0 -and
                $after.reviewLogCount -eq 0 -and
                $after.answerCommittedEventCount -eq 0
            )
            if (
                -not $sample.blackboardYielded -or
                -not $sample.sameSession -or
                -not $sample.sameItem -or
                -not $sample.sameHeadword -or
                -not $sample.zeroAnswerWrites
            ) { throw "strong reminder did not cleanly displace the unanswered learning surface" }

            $process.WaitForExit(($ExitAfterSeconds + 15) * 1000) | Out-Null
            $process.Refresh()
            if (-not $process.HasExited) { throw "application did not use the controlled exit path" }
            $sample.exitCode = [int]$process.ExitCode
            $sample.controlledExit = $sample.exitCode -eq 0
            if (-not $sample.controlledExit) { throw "controlled exit returned a non-zero code" }
            $sample.passed = $true
        }
        catch {
            $sample.failure = $_.Exception.Message
        }
        finally {
            Stop-QaApplicationIfRunning $process
            Start-Sleep -Milliseconds 750
            $sample.maxVisibleWindows = $script:probeMaxVisibleWindows
            $sample.maxAccessibleNodes = $script:probeMaxAccessibleNodes
            $sample.observedAccessibleNames = @($script:probeAccessibleNames | Sort-Object)
            try {
                $sample.rootRemoved = Remove-OwnedQaRoot $qaRoot $leaf
                if (-not $sample.rootRemoved) {
                    $sample.passed = $false
                    $sample.failure = if ($sample.failure) {
                        "$($sample.failure); cleanup did not remove the QA root"
                    }
                    else { "cleanup did not remove the QA root" }
                }
            }
            catch {
                $sample.passed = $false
                $sample.failure = if ($sample.failure) {
                    "$($sample.failure); cleanup failed: $($_.Exception.Message)"
                }
                else { "cleanup failed: $($_.Exception.Message)" }
            }
        }
        $samples += [pscustomobject]$sample
    }

    $passedSamples = @($samples | Where-Object passed)
    $backend = [double[]]@($passedSamples | ForEach-Object backendLatencyMilliseconds)
    $persisted = [double[]]@($passedSamples | ForEach-Object persistedPreemptionMilliseconds)
    $handoff = [double[]]@($passedSamples | ForEach-Object uiHandoffMilliseconds)
    $presentation = [double[]]@($passedSamples | ForEach-Object presentationLatencyMilliseconds)
    $summary = [ordered]@{
        passedSamples = $passedSamples.Count
        backendLatencyP50Milliseconds = Get-Percentile $backend 0.50
        backendLatencyP95Milliseconds = Get-Percentile $backend 0.95
        persistedPreemptionP50Milliseconds = Get-Percentile $persisted 0.50
        persistedPreemptionP95Milliseconds = Get-Percentile $persisted 0.95
        uiHandoffP50Milliseconds = Get-Percentile $handoff 0.50
        uiHandoffP95Milliseconds = Get-Percentile $handoff 0.95
        presentationLatencyP50Milliseconds = Get-Percentile $presentation 0.50
        presentationLatencyP95Milliseconds = Get-Percentile $presentation 0.95
    }
    $gateFailures = [System.Collections.Generic.List[string]]::new()
    if ($EvidenceGate) {
        if ($SampleCount -lt $minimumEvidenceSamples) {
            $gateFailures.Add("evidence gate requires at least $minimumEvidenceSamples samples")
        }
        if ($passedSamples.Count -ne $SampleCount) {
            $gateFailures.Add("not all requested preemption samples passed")
        }
        if ($summary.backendLatencyP95Milliseconds -gt $limits.backendLatencyP95Milliseconds) {
            $gateFailures.Add("backend_latency_p95_exceeded")
        }
        if (
            $summary.persistedPreemptionP95Milliseconds -gt
            $limits.persistedPreemptionP95Milliseconds
        ) { $gateFailures.Add("persisted_preemption_p95_exceeded") }
        if ($summary.uiHandoffP95Milliseconds -gt $limits.uiHandoffP95Milliseconds) {
            $gateFailures.Add("ui_handoff_p95_exceeded")
        }
        if (
            $summary.presentationLatencyP95Milliseconds -gt
            $limits.presentationLatencyP95Milliseconds
        ) { $gateFailures.Add("presentation_latency_p95_exceeded") }
        if (@($passedSamples | Where-Object {
            $_.persistedPreemptionMilliseconds -gt $limits.perSamplePreemptionMilliseconds -or
            $_.uiHandoffMilliseconds -gt $limits.perSamplePreemptionMilliseconds
        }).Count -gt 0) { $gateFailures.Add("a_sample_exceeded_one_second_preemption") }
    }
    $gatePassed = $EvidenceGate -and $gateFailures.Count -eq 0
    $sampleSetPassed = $passedSamples.Count -eq $SampleCount
    $windowsVersion = Get-ItemProperty -LiteralPath "HKLM:\SOFTWARE\Microsoft\Windows NT\CurrentVersion"
    $gitCommit = (& git -C $projectRoot rev-parse HEAD).Trim()
    $gitStatus = (& git -C $projectRoot status --porcelain=v1 --untracked-files=all) -join "`n"
    $report = [ordered]@{
        schemaVersion = 1
        generatedAt = [DateTimeOffset]::UtcNow.ToString("o")
        profile = "learning-reminder-preemption"
        source = [ordered]@{
            gitCommit = $gitCommit
            gitDirty = $gitStatus.Length -gt 0
            gitStatusSha256 = Get-StringSha256 $gitStatus
        }
        bindings = [ordered]@{
            applicationSha256 = Get-FileSha256 $appPath
            fixtureExecutableSha256 = Get-FileSha256 $fixturePath
            fixtureContentSha256 = $fixtureContentSha256
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
            sampleCount = $SampleCount
            exitAfterSeconds = $ExitAfterSeconds
            evidenceGateRequested = [bool]$EvidenceGate
        }
        fixture = [ordered]@{
            cardCount = $fixtureCardCount
            contentKind = "deterministic-synthetic-english-csv"
            reminderKind = "strong-once-work-reminder"
            dueOffsetsSeconds = $dueOffsets
        }
        summary = $summary
        evidenceGate = [ordered]@{
            requested = [bool]$EvidenceGate
            minimumSamples = $minimumEvidenceSamples
            limits = $limits
            passed = if ($EvidenceGate) { $gatePassed } else { $null }
            failures = @($gateFailures)
        }
        ready = $sampleSetPassed -and ((-not $EvidenceGate) -or $gatePassed)
        limitations = @(
            "The application and fixture are an isolated learning runtime-QA build, not a signed production candidate."
            "The five cards and reminder title are synthetic and contain no personal learning material."
            "The real 15-second scheduler, presentation arbiter, SQLite session transition, Tauri events, React replacement, and Windows accessibility tree are included."
            "The one-second gate applies from persisted reminder claim to both paused learning state and visible reminder surface; scheduler claim latency keeps the existing independent limits."
            "This report does not replace Narrator, reduced-motion, multi-DPI, locked-break authentication, or signed-candidate testing."
        )
        samples = @($samples)
    }
    $report | ConvertTo-Json -Depth 9 | Set-Content -Encoding UTF8 -LiteralPath $reportPath
    Write-Output "Learning reminder preemption report written: $reportPath"
    Write-Output (
        "Samples={0}/{1} PersistedP95={2}ms UiHandoffP95={3}ms Ready={4}" -f
        $passedSamples.Count,
        $SampleCount,
        $summary.persistedPreemptionP95Milliseconds,
        $summary.uiHandoffP95Milliseconds,
        $report.ready
    )
    if (-not $report.ready) { $scriptExitCode = 2 }
}
finally {
    if ($null -ne $lockStream) { $lockStream.Dispose() }
    Remove-Item -LiteralPath $lockPath -Force -ErrorAction SilentlyContinue
}
exit $scriptExitCode
