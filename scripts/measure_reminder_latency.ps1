param(
    [ValidateRange(1, 20)]
    [int]$SampleCount = 5,

    [ValidateRange(30, 120)]
    [int]$ExitAfterSeconds = 30,

    [ValidateSet("learning-off", "learning-on")]
    [string]$BuildVariant = "learning-off",

    [switch]$BaselineGate
)

$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"
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
$reportPath = Join-Path $evidenceRoot "reminder-latency-$runId.json"
$expectedMarker = "YUANYUAN_RUNTIME_QA_V1`n"
$dueOffsets = @(2, 5, 8, 11, 14)
$baselineMinimumSamples = 20
$baselineLimits = [ordered]@{
    backendLatencyP95Ms = 16000.0
    handoffLatencyP95Ms = 1000.0
    presentationLatencyP95Ms = 17000.0
}

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
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes

if (-not ("YuanyuanReminderWindowProbe" -as [type])) {
    Add-Type -TypeDefinition @"
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;

public static class YuanyuanReminderWindowProbe {
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
            if (owner == (uint)processId && IsWindowVisible(hWnd)) {
                windows.Add(hWnd);
            }
            return true;
        }, IntPtr.Zero);
        return windows.ToArray();
    }
}
"@
}

function Restore-EnvironmentValue([string]$Name, [string]$Value, [bool]$Existed) {
    if ($Existed) {
        Set-Item -LiteralPath "Env:$Name" -Value $Value
    }
    else {
        Remove-Item -LiteralPath "Env:$Name" -ErrorAction SilentlyContinue
    }
}

function Wait-RuntimeStage([string]$Root, [string]$Stage, [int]$TimeoutSeconds) {
    $path = Join-Path (Join-Path $Root "status") $Stage
    $deadline = [DateTime]::UtcNow.AddSeconds($TimeoutSeconds)
    while ([DateTime]::UtcNow -lt $deadline) {
        if (Test-Path -LiteralPath $path -PathType Leaf) { return $true }
        Start-Sleep -Milliseconds 100
    }
    return $false
}

function Find-AccessibleFragment([int]$ProcessId, [string]$Fragment) {
    $windows = @([YuanyuanReminderWindowProbe]::VisibleWindows($ProcessId))
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
                if ($name -and $name.Length -le 256 -and $script:probeAccessibleNames.Count -lt 64) {
                    [void]$script:probeAccessibleNames.Add($name)
                }
                if ($name -and $name.Contains($Fragment)) { return $true }
            }
        }
        catch {
            # Accessibility nodes can disappear while React updates the alert stage.
        }
    }
    return $false
}

function Remove-OwnedQaRoot([string]$Root, [string]$ExpectedLeaf) {
    if (-not (Test-Path -LiteralPath $Root -PathType Container)) { return }
    $canonicalRoot = (Resolve-Path -LiteralPath $Root).Path
    $canonicalParent = (Resolve-Path -LiteralPath $workspaceRoot).Path
    $markerPath = Join-Path $canonicalRoot ".yuanyuan-runtime-qa-v1"
    if (
        (Split-Path -Parent $canonicalRoot) -ne $canonicalParent -or
        (Split-Path -Leaf $canonicalRoot) -ne $ExpectedLeaf -or
        -not (Test-Path -LiteralPath $markerPath -PathType Leaf) -or
        (Get-Content -Raw -Encoding UTF8 -LiteralPath $markerPath) -ne $expectedMarker
    ) {
        throw "refusing to remove an unowned runtime QA root"
    }
    Remove-Item -LiteralPath $canonicalRoot -Recurse -Force
}

function Get-Percentile([double[]]$Values, [double]$Percentile) {
    if ($Values.Count -eq 0) { return $null }
    $ordered = @($Values | Sort-Object)
    $index = [Math]::Max(0, [Math]::Ceiling($Percentile * $ordered.Count) - 1)
    return [Math]::Round([double]$ordered[$index], 1)
}

$lockPath = Join-Path $evidenceRoot "reminder-latency.lock"
try {
    $lockStream = [System.IO.File]::Open(
        $lockPath,
        [System.IO.FileMode]::OpenOrCreate,
        [System.IO.FileAccess]::ReadWrite,
        [System.IO.FileShare]::None
    )
}
catch {
    throw "another reminder latency acceptance run is already active"
}

$scriptExitCode = 0
try {
$samples = @()
for ($index = 0; $index -lt $SampleCount; $index += 1) {
    $sampleNumber = $index + 1
    $leaf = "yuanyuan-runtime-qa-reminder-latency-$runId-$sampleNumber"
    $qaRoot = Join-Path $workspaceRoot $leaf
    $process = $null
    $script:probeMaxVisibleWindows = 0
    $script:probeMaxAccessibleNodes = 0
    $script:probeAccessibleNames = [System.Collections.Generic.HashSet[string]]::new()
    $sample = [ordered]@{
        sample = $sampleNumber
        dueAfterSeconds = $dueOffsets[$index % $dueOffsets.Count]
        reminderId = $null
        scheduledAt = $null
        claimedAt = $null
        presentedAt = $null
        backendLatencyMs = $null
        presentationLatencyMs = $null
        handoffLatencyMs = $null
        maxVisibleWindows = 0
        maxAccessibleNodes = 0
        observedAccessibleNames = @()
        backendClaimObservedOnFailure = $false
        controlledExit = $false
        exitCode = $null
        rootRemoved = $false
        passed = $false
        failure = $null
    }
    try {
        & $fixturePath --root $qaRoot --prepare-only
        if ($LASTEXITCODE -ne 0) { throw "runtime QA root preparation failed" }

        $rootExisted = Test-Path Env:YUANYUAN_RUNTIME_QA_ROOT
        $profileExisted = Test-Path Env:YUANYUAN_RUNTIME_QA_PROFILE
        $exitExisted = Test-Path Env:YUANYUAN_RUNTIME_QA_EXIT_AFTER_SECONDS
        $oldRoot = $env:YUANYUAN_RUNTIME_QA_ROOT
        $oldProfile = $env:YUANYUAN_RUNTIME_QA_PROFILE
        $oldExit = $env:YUANYUAN_RUNTIME_QA_EXIT_AFTER_SECONDS
        try {
            $env:YUANYUAN_RUNTIME_QA_ROOT = $qaRoot
            $env:YUANYUAN_RUNTIME_QA_PROFILE = "reminder-latency"
            $env:YUANYUAN_RUNTIME_QA_EXIT_AFTER_SECONDS = [string]$ExitAfterSeconds
            # This acceptance test measures the first reminder exposed by the real
            # visible pet window. Starting the process with SW_HIDE makes every
            # top-level window fail the IsWindowVisible probe below, so the test
            # would report a presentation timeout even after WebView setup and
            # reminder seeding succeeded.
            $process = Start-Process -FilePath $appPath -PassThru
        }
        finally {
            Restore-EnvironmentValue "YUANYUAN_RUNTIME_QA_ROOT" $oldRoot $rootExisted
            Restore-EnvironmentValue "YUANYUAN_RUNTIME_QA_PROFILE" $oldProfile $profileExisted
            Restore-EnvironmentValue "YUANYUAN_RUNTIME_QA_EXIT_AFTER_SECONDS" $oldExit $exitExisted
        }

        if (-not (Wait-RuntimeStage $qaRoot "exit-scheduled" 30)) {
            throw "runtime QA window setup did not complete"
        }
        $planText = & $fixturePath --root $qaRoot --reminder-latency $sample.dueAfterSeconds
        if ($LASTEXITCODE -ne 0) { throw "reminder fixture seeding failed" }
        $plan = $planText | ConvertFrom-Json
        $sample.reminderId = $plan.reminderId
        $sample.scheduledAt = $plan.scheduledAt

        $scheduled = [DateTimeOffset]::Parse($plan.scheduledAt)
        $presentationDeadline = $scheduled.AddSeconds(20)
        while ([DateTimeOffset]::UtcNow -lt $presentationDeadline) {
            $process.Refresh()
            if ($process.HasExited) { throw "application exited before reminder presentation" }
            if (Find-AccessibleFragment $process.Id $plan.accessibleNameFragment) {
                $presented = [DateTimeOffset]::UtcNow
                $sample.presentedAt = $presented.ToString("o")
                break
            }
            Start-Sleep -Milliseconds 50
        }
        if ($null -eq $sample.presentedAt) {
            throw "reminder was not found in the real Windows accessibility tree"
        }

        $process.WaitForExit(($ExitAfterSeconds + 15) * 1000) | Out-Null
        $process.Refresh()
        if (-not $process.HasExited) { throw "application did not use the controlled exit path" }
        $sample.exitCode = $process.ExitCode
        $sample.controlledExit = $process.ExitCode -eq 0
        if (-not $sample.controlledExit) { throw "controlled exit returned a non-zero code" }

        $claimText = & $fixturePath --root $qaRoot --read-reminder-latency $plan.reminderId
        if ($LASTEXITCODE -ne 0) { throw "backend claim evidence is unavailable" }
        $claim = $claimText | ConvertFrom-Json
        $claimed = [DateTimeOffset]::Parse($claim.claimedAt)
        $presented = [DateTimeOffset]::Parse($sample.presentedAt)
        $sample.claimedAt = $claim.claimedAt
        if ($presented -lt $claimed) {
            throw "reminder presentation was observed before the backend claim"
        }
        $sample.backendLatencyMs = [Math]::Round(($claimed - $scheduled).TotalMilliseconds, 1)
        $sample.presentationLatencyMs = [Math]::Round(($presented - $scheduled).TotalMilliseconds, 1)
        $sample.handoffLatencyMs = [Math]::Round(($presented - $claimed).TotalMilliseconds, 1)
        $sample.passed = $true
    }
    catch {
        $sample.failure = $_.Exception.Message
        if ($sample.reminderId) {
            try {
                $claimText = & $fixturePath --root $qaRoot --read-reminder-latency $sample.reminderId
                if ($LASTEXITCODE -eq 0) {
                    $claim = $claimText | ConvertFrom-Json
                    $sample.claimedAt = $claim.claimedAt
                    $sample.backendClaimObservedOnFailure = $true
                }
            }
            catch {
                # The original failure remains authoritative; claim state is diagnostic only.
            }
        }
    }
    finally {
        $sample.maxVisibleWindows = $script:probeMaxVisibleWindows
        $sample.maxAccessibleNodes = $script:probeMaxAccessibleNodes
        $sample.observedAccessibleNames = @($script:probeAccessibleNames | Sort-Object)
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
        Start-Sleep -Milliseconds 500
        try {
            Remove-OwnedQaRoot $qaRoot $leaf
            $sample.rootRemoved = -not (Test-Path -LiteralPath $qaRoot)
        }
        catch {
            $sample.failure = if ($sample.failure) {
                "$($sample.failure); cleanup failed: $($_.Exception.Message)"
            }
            else {
                "cleanup failed: $($_.Exception.Message)"
            }
            $sample.passed = $false
        }
    }
    $samples += [pscustomobject]$sample
}

$passedSamples = @($samples | Where-Object passed)
$backend = [double[]]@($passedSamples | ForEach-Object backendLatencyMs)
$presentation = [double[]]@($passedSamples | ForEach-Object presentationLatencyMs)
$handoff = [double[]]@($passedSamples | ForEach-Object handoffLatencyMs)
$summary = [ordered]@{
    backendLatencyP50Ms = Get-Percentile $backend 0.50
    backendLatencyP95Ms = Get-Percentile $backend 0.95
    presentationLatencyP50Ms = Get-Percentile $presentation 0.50
    presentationLatencyP95Ms = Get-Percentile $presentation 0.95
    handoffLatencyP50Ms = Get-Percentile $handoff 0.50
    handoffLatencyP95Ms = Get-Percentile $handoff 0.95
}
$baselineFailures = @()
if ($BaselineGate) {
    if ($SampleCount -lt $baselineMinimumSamples) {
        $baselineFailures += "baseline gate requires at least $baselineMinimumSamples samples"
    }
    if ($passedSamples.Count -ne $SampleCount) {
        $baselineFailures += "not all requested samples passed"
    }
    if (
        $null -eq $summary.backendLatencyP95Ms -or
        $summary.backendLatencyP95Ms -gt $baselineLimits.backendLatencyP95Ms
    ) {
        $baselineFailures += "backend latency P95 exceeds the frozen limit"
    }
    if (
        $null -eq $summary.handoffLatencyP95Ms -or
        $summary.handoffLatencyP95Ms -gt $baselineLimits.handoffLatencyP95Ms
    ) {
        $baselineFailures += "handoff latency P95 exceeds the frozen limit"
    }
    if (
        $null -eq $summary.presentationLatencyP95Ms -or
        $summary.presentationLatencyP95Ms -gt $baselineLimits.presentationLatencyP95Ms
    ) {
        $baselineFailures += "presentation latency P95 exceeds the frozen limit"
    }
}
$baselinePassed = $baselineFailures.Count -eq 0
$sampleSetPassed = $passedSamples.Count -eq $SampleCount
$report = [ordered]@{
    schemaVersion = 2
    generatedAt = [DateTimeOffset]::UtcNow.ToString("o")
    profile = "reminder-latency"
    schedulerIntervalSeconds = 15
    requestedSamples = $SampleCount
    passedSamples = $passedSamples.Count
    ready = $sampleSetPassed -and $baselinePassed
    bindings = [ordered]@{
        applicationSha256 = (Get-FileHash -Algorithm SHA256 -LiteralPath $appPath).Hash
        fixtureSha256 = (Get-FileHash -Algorithm SHA256 -LiteralPath $fixturePath).Hash
        scriptSha256 = (Get-FileHash -Algorithm SHA256 -LiteralPath $PSCommandPath).Hash
    }
    baselineGate = [ordered]@{
        requested = [bool]$BaselineGate
        minimumSamples = $baselineMinimumSamples
        phaseOffsetsSeconds = $dueOffsets
        limits = $baselineLimits
        passed = $baselinePassed
        failures = $baselineFailures
    }
    summary = $summary
    samples = $samples
    limitations = @(
        "Synthetic reminders and an isolated runtime-QA build are used.",
        "Presentation time is the first matching node observed through Windows UI Automation at 50 ms polling.",
        "This does not replace sleep-resume, lock-screen, cold-boot, or signed production-candidate evidence."
    )
}
$report | ConvertTo-Json -Depth 8 | Set-Content -Encoding UTF8 -LiteralPath $reportPath
Write-Output "Reminder latency evidence: $($passedSamples.Count)/$SampleCount samples passed."
Write-Output "Report written: $reportPath"
if (-not $report.ready) { $scriptExitCode = 2 }
}
finally {
    $lockStream.Dispose()
    Remove-Item -LiteralPath $lockPath -Force -ErrorAction SilentlyContinue
}
if ($scriptExitCode -ne 0) { exit $scriptExitCode }
