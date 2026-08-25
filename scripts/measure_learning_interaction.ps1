param(
    [ValidateSet("page", "blackboard")]
    [string]$Scenario = "page",

    [ValidateRange(1, 20)]
    [int]$SampleCount = 5,

    [ValidateRange(30, 120)]
    [int]$ExitAfterSeconds = 30,

    [switch]$BaselineGate
)

$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"
$projectRoot = Split-Path -Parent $PSScriptRoot
$workspaceRoot = Split-Path -Parent $projectRoot
$runtimeTarget = Join-Path $projectRoot "src-tauri\target\runtime-qa-learning\release"
$appPath = Join-Path $runtimeTarget "yuanyuan-reminder.exe"
$fixturePath = Join-Path $runtimeTarget "yuanyuan-runtime-qa-fixture.exe"
$evidenceRoot = Join-Path $runtimeTarget "evidence"
$runId = (Get-Date).ToUniversalTime().ToString("yyyyMMddTHHmmssZ")
$reportPath = Join-Path $evidenceRoot "learning-$Scenario-$runId.json"
$expectedMarker = "YUANYUAN_RUNTIME_QA_V1`n"
$fixtureCardCount = if ($Scenario -eq "page") { 4533 } else { 5 }
$learningPageFragment = -join @([char]0x5B66, [char]0x4E60, [char]0x9875, [char]0x9762)
$blackboardFragment = -join @(
    [char]0x5706, [char]0x5706, [char]0x684C, [char]0x9762,
    [char]0x82F1, [char]0x8BED, [char]0x590D, [char]0x4E60
)
$startRoundFragment = -join @([char]0x5F00, [char]0x59CB, [char]0x4E00, [char]0x8F6E)
$targetFragment = if ($Scenario -eq "page") { $learningPageFragment } else { $blackboardFragment }
$baselineMinimumSamples = 20

foreach ($required in @($appPath, $fixturePath)) {
    if (-not (Test-Path -LiteralPath $required -PathType Leaf)) {
        throw "learning runtime QA binary is missing; run npm.cmd run runtime:qa:learning:build first"
    }
}
New-Item -ItemType Directory -Force -Path $evidenceRoot | Out-Null
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes
Add-Type -AssemblyName System.Windows.Forms

if (-not ("YuanyuanLearningWindowProbe" -as [type])) {
    Add-Type -TypeDefinition @"
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;

public static class YuanyuanLearningWindowProbe {
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
        Start-Sleep -Milliseconds 50
    }
    return $false
}

function Find-AccessibleElement([int]$ProcessId, [string]$Fragment, [bool]$ButtonOnly) {
    $windows = @([YuanyuanLearningWindowProbe]::VisibleWindows($ProcessId))
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
                if ($name -and $name.Length -le 256 -and $script:probeAccessibleNames.Count -lt 96) {
                    [void]$script:probeAccessibleNames.Add($name)
                }
                if (-not $name -or -not $name.Contains($Fragment)) { continue }
                if (
                    $ButtonOnly -and
                    $node.Current.ControlType -ne [System.Windows.Automation.ControlType]::Button
                ) {
                    continue
                }
                if ($node.Current.IsEnabled) { return $node }
            }
        }
        catch {
            # React and WebView accessibility nodes can disappear between snapshots.
        }
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
        if ($Process.HasExited) { throw "application exited before the learning target appeared" }
        $element = Find-AccessibleElement $Process.Id $Fragment $ButtonOnly
        if ($null -ne $element) { return $element }
        Start-Sleep -Milliseconds 50
    }
    throw "learning target was not found in the Windows accessibility tree"
}

function Invoke-AccessibleElement([System.Windows.Automation.AutomationElement]$Element) {
    $pattern = $null
    if (-not $Element.TryGetCurrentPattern(
        [System.Windows.Automation.InvokePattern]::Pattern,
        [ref]$pattern
    )) {
        throw "learning start control does not expose the invoke pattern"
    }
    ([System.Windows.Automation.InvokePattern]$pattern).Invoke()
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

function Get-WebView2Version {
    try {
        $process = Get-Process -Name "msedgewebview2" -ErrorAction Stop | Select-Object -First 1
        return $process.MainModule.FileVersionInfo.FileVersion
    }
    catch {
        return $null
    }
}

$lockPath = Join-Path $evidenceRoot "learning-interaction.lock"
try {
    $lockStream = [System.IO.File]::Open(
        $lockPath,
        [System.IO.FileMode]::OpenOrCreate,
        [System.IO.FileAccess]::ReadWrite,
        [System.IO.FileShare]::None
    )
}
catch {
    throw "another learning interaction measurement is already active"
}

$scriptExitCode = 0
try {
    $samples = @()
    $fixtureContentSha256 = $null
    $webView2Version = $null
    for ($index = 0; $index -lt $SampleCount; $index += 1) {
        $sampleNumber = $index + 1
        $leaf = "yuanyuan-runtime-qa-learning-interaction-$runId-$Scenario-$sampleNumber"
        $qaRoot = Join-Path $workspaceRoot $leaf
        $process = $null
        $script:probeMaxVisibleWindows = 0
        $script:probeMaxAccessibleNodes = 0
        $script:probeAccessibleNames = [System.Collections.Generic.HashSet[string]]::new()
        $sample = [ordered]@{
            sample = $sampleNumber
            fixtureCardCount = $fixtureCardCount
            fixtureDatabaseSha256 = $null
            fixtureDatabaseBytes = $null
            pageReadyMilliseconds = $null
            targetLatencyMilliseconds = $null
            maxVisibleWindows = 0
            maxAccessibleNodes = 0
            observedAccessibleNames = @()
            controlledExit = $false
            exitCode = $null
            rootRemoved = $false
            passed = $false
            failure = $null
        }
        try {
            $planText = & $fixturePath --root $qaRoot --learning-performance $fixtureCardCount
            if ($LASTEXITCODE -ne 0) { throw "learning fixture seeding failed" }
            $plan = $planText | ConvertFrom-Json
            if ($plan.cardCount -ne $fixtureCardCount) { throw "learning fixture count is incorrect" }
            if ($null -eq $fixtureContentSha256) {
                $fixtureContentSha256 = $plan.contentSha256
            }
            elseif ($fixtureContentSha256 -ne $plan.contentSha256) {
                throw "learning fixture content changed between samples"
            }
            $sample.fixtureDatabaseSha256 = $plan.databaseSha256
            $sample.fixtureDatabaseBytes = $plan.databaseBytes

            $rootExisted = Test-Path Env:YUANYUAN_RUNTIME_QA_ROOT
            $profileExisted = Test-Path Env:YUANYUAN_RUNTIME_QA_PROFILE
            $exitExisted = Test-Path Env:YUANYUAN_RUNTIME_QA_EXIT_AFTER_SECONDS
            $oldRoot = $env:YUANYUAN_RUNTIME_QA_ROOT
            $oldProfile = $env:YUANYUAN_RUNTIME_QA_PROFILE
            $oldExit = $env:YUANYUAN_RUNTIME_QA_EXIT_AFTER_SECONDS
            $launchTimer = [Diagnostics.Stopwatch]::StartNew()
            try {
                $env:YUANYUAN_RUNTIME_QA_ROOT = $qaRoot
                $env:YUANYUAN_RUNTIME_QA_PROFILE = "learning-performance"
                $env:YUANYUAN_RUNTIME_QA_EXIT_AFTER_SECONDS = [string]$ExitAfterSeconds
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
            $page = Wait-AccessibleElement $process $learningPageFragment $false 30
            $sample.pageReadyMilliseconds = [Math]::Round($launchTimer.Elapsed.TotalMilliseconds, 1)
            if ($Scenario -eq "page") {
                $sample.targetLatencyMilliseconds = $sample.pageReadyMilliseconds
            }
            else {
                $startButton = Wait-AccessibleElement $process $startRoundFragment $true 10
                $interactionTimer = [Diagnostics.Stopwatch]::StartNew()
                Invoke-AccessibleElement $startButton
                $null = Wait-AccessibleElement $process $targetFragment $false 20
                $sample.targetLatencyMilliseconds = [Math]::Round(
                    $interactionTimer.Elapsed.TotalMilliseconds,
                    1
                )
            }
            if ($null -eq $webView2Version) { $webView2Version = Get-WebView2Version }

            $process.WaitForExit(($ExitAfterSeconds + 15) * 1000) | Out-Null
            $process.Refresh()
            if (-not $process.HasExited) { throw "application did not use the controlled exit path" }
            $sample.exitCode = $process.ExitCode
            $sample.controlledExit = $process.ExitCode -eq 0
            if (-not $sample.controlledExit) { throw "controlled exit returned a non-zero code" }
            $sample.passed = $true
        }
        catch {
            $sample.failure = $_.Exception.Message
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
    $latencies = [double[]]@($passedSamples | ForEach-Object targetLatencyMilliseconds)
    $pageLatencies = [double[]]@($passedSamples | ForEach-Object pageReadyMilliseconds)
    $summary = [ordered]@{
        targetLatencyP50Ms = Get-Percentile $latencies 0.50
        targetLatencyP95Ms = Get-Percentile $latencies 0.95
        pageReadyP50Ms = Get-Percentile $pageLatencies 0.50
        pageReadyP95Ms = Get-Percentile $pageLatencies 0.95
    }
    $gateFailures = @()
    if ($BaselineGate) {
        if ($SampleCount -lt $baselineMinimumSamples) {
            $gateFailures += "baseline gate requires at least $baselineMinimumSamples samples"
        }
        if ($passedSamples.Count -ne $SampleCount) {
            $gateFailures += "not all requested samples passed"
        }
    }
    $gatePassed = $BaselineGate -and $gateFailures.Count -eq 0
    $sampleSetPassed = $passedSamples.Count -eq $SampleCount
    $windowsVersion = Get-ItemProperty -LiteralPath "HKLM:\SOFTWARE\Microsoft\Windows NT\CurrentVersion"
    $report = [ordered]@{
        schemaVersion = 1
        generatedAt = [DateTimeOffset]::UtcNow.ToString("o")
        profile = "learning-interaction"
        scenario = $Scenario
        targetAccessibleName = $targetFragment
        requestedSamples = $SampleCount
        passedSamples = $passedSamples.Count
        ready = $sampleSetPassed -and ((-not $BaselineGate) -or $gatePassed)
        bindings = [ordered]@{
            applicationSha256 = (Get-FileHash -Algorithm SHA256 -LiteralPath $appPath).Hash
            fixtureExecutableSha256 = (Get-FileHash -Algorithm SHA256 -LiteralPath $fixturePath).Hash
            fixtureContentSha256 = $fixtureContentSha256
            scriptSha256 = (Get-FileHash -Algorithm SHA256 -LiteralPath $PSCommandPath).Hash
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
        fixture = [ordered]@{
            cardCount = $fixtureCardCount
            contentKind = "deterministic-synthetic-english-csv"
        }
        baselineGate = [ordered]@{
            requested = [bool]$BaselineGate
            minimumSamples = $baselineMinimumSamples
            passed = if ($BaselineGate) { $gatePassed } else { $null }
            failures = $gateFailures
        }
        summary = $summary
        samples = $samples
        limitations = @(
            "The application and fixture are an isolated learning runtime-QA build, not the signed production candidate."
            "The content is deterministic synthetic data and contains no personal learning material."
            "UI timing uses Windows UI Automation at 50 ms polling resolution."
            "This report does not replace multi-DPI, keyboard, reduced-motion, import, pagination, or two-hour memory evidence."
        )
    }
    $report | ConvertTo-Json -Depth 8 | Set-Content -Encoding UTF8 -LiteralPath $reportPath
    Write-Output "Learning interaction report written: $reportPath"
    Write-Output (
        "Scenario={0} Samples={1}/{2} TargetP95={3}ms Ready={4}" -f
        $Scenario,
        $passedSamples.Count,
        $SampleCount,
        $summary.targetLatencyP95Ms,
        $report.ready
    )
    if (-not $report.ready) { $scriptExitCode = 2 }
}
finally {
    if ($null -ne $lockStream) { $lockStream.Dispose() }
    Remove-Item -LiteralPath $lockPath -Force -ErrorAction SilentlyContinue
}
exit $scriptExitCode
