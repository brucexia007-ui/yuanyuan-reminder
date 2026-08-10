param(
    [ValidateRange(30, 120)]
    [int]$ExitAfterSeconds = 30,

    [ValidateRange(2, 10)]
    [double]$CaptureSeconds = 4,

    [string]$PythonPath = "",

    [ValidateSet("failed-only", "waiting-user-only", "stalled-only")]
    [string]$Scenario = "failed-only",

    [ValidateRange(5, 60)]
    [int]$StartupTimeoutSeconds = 30
)

$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"
$projectRoot = Split-Path -Parent $PSScriptRoot
$workspaceRoot = Split-Path -Parent $projectRoot
$runtimeTarget = Join-Path $projectRoot "src-tauri\target\runtime-qa\release"
$appPath = Join-Path $runtimeTarget "yuanyuan-reminder.exe"
$fixturePath = Join-Path $runtimeTarget "yuanyuan-task-watch-fixture.exe"
$captureScript = Join-Path $PSScriptRoot "capture_installed_pet.py"
$backdropScript = Join-Path $PSScriptRoot "run_neutral_capture_backdrop.py"
$evidenceRoot = Join-Path $runtimeTarget "evidence"
$runId = (Get-Date).ToUniversalTime().ToString("yyyyMMddTHHmmssZ")
$reportPath = Join-Path $evidenceRoot "task-expression-motion-$runId-$Scenario.json"
$expectedMarker = "YUANYUAN_RUNTIME_QA_V1`n"
$accessibleBase64 = switch ($Scenario) {
    "failed-only" {
        "5ZyG5ZyG5Y+R546w5Lu75Yqh5rKh5pyJ5oiQ5Yqf77yM5q2j5Zyo5L2g6Lqr6L656Zmq552A"
    }
    "waiting-user-only" {
        "5ZyG5ZyG5Y+R546w5Lu75Yqh5q2j5Zyo562J5b6F5L2g55qE56Gu6K6k"
    }
    "stalled-only" {
        "5ZyG5ZyG5Y+R546w5Lu75Yqh5Y+v6IO95YGc5L2P5LqG"
    }
}
$accessibleFragment = [Text.Encoding]::UTF8.GetString(
    [Convert]::FromBase64String($accessibleBase64)
)

foreach ($required in @($appPath, $fixturePath, $captureScript, $backdropScript)) {
    if (-not (Test-Path -LiteralPath $required -PathType Leaf)) {
        throw "task failure motion QA dependency is missing"
    }
}
if ([string]::IsNullOrWhiteSpace($PythonPath)) {
    $PythonPath = (Get-Command python -ErrorAction Stop).Source
}
if (-not (Test-Path -LiteralPath $PythonPath -PathType Leaf)) {
    throw "Python runtime is unavailable"
}
New-Item -ItemType Directory -Force -Path $evidenceRoot | Out-Null
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes

if (-not ("YuanyuanTaskFailureWindowProbe" -as [type])) {
    Add-Type -TypeDefinition @"
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;

public static class YuanyuanTaskFailureWindowProbe {
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

function Find-AccessibleFragment([int]$ProcessId, [string]$Fragment) {
    foreach ($handle in [YuanyuanTaskFailureWindowProbe]::VisibleWindows($ProcessId)) {
        try {
            $root = [System.Windows.Automation.AutomationElement]::FromHandle($handle)
            $nodes = $root.FindAll(
                [System.Windows.Automation.TreeScope]::Descendants,
                [System.Windows.Automation.Condition]::TrueCondition
            )
            foreach ($node in $nodes) {
                $name = $node.Current.Name
                if ($name -and $name.Contains($Fragment)) { return $true }
            }
        }
        catch {
            # WebView accessibility nodes can be replaced during React updates.
        }
    }
    return $false
}

function Wait-RuntimeStage([string]$Root, [string]$Stage, [int]$TimeoutSeconds) {
    $deadline = [DateTime]::UtcNow.AddSeconds($TimeoutSeconds)
    $stagePath = Join-Path (Join-Path $Root "status") $Stage
    while ([DateTime]::UtcNow -lt $deadline) {
        if (Test-Path -LiteralPath $stagePath -PathType Leaf) { return $true }
        Start-Sleep -Milliseconds 100
    }
    return $false
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
    ) {
        throw "refusing to remove an unowned task failure motion QA root"
    }
    Remove-Item -LiteralPath $canonicalRoot -Recurse -Force
    return -not (Test-Path -LiteralPath $canonicalRoot)
}

$lockPath = Join-Path $evidenceRoot "task-expression-motion.lock"
try {
    $lockStream = [System.IO.File]::Open(
        $lockPath,
        [System.IO.FileMode]::OpenOrCreate,
        [System.IO.FileAccess]::ReadWrite,
        [System.IO.FileShare]::None
    )
}
catch {
    throw "another task expression motion acceptance run is already active"
}

$scriptExitCode = 0
try {
$samples = @()
foreach ($mode in @("always", "off")) {
    $leaf = "yuanyuan-runtime-qa-task-expression-$runId-$Scenario-$mode"
    $qaRoot = Join-Path $workspaceRoot $leaf
    $captureRoot = Join-Path $evidenceRoot "task-expression-motion-$runId-$Scenario-$mode"
    $process = $null
    $backdropProcess = $null
    $backdropReady = Join-Path $qaRoot ".neutral-capture-backdrop-ready"
    $backdropStop = Join-Path $qaRoot ".neutral-capture-backdrop-stop"
    $sample = [ordered]@{
        animationMode = $mode
        scenario = $Scenario
        runtimeStageReady = $false
        accessibleStateObserved = $false
        captureStartedAtUtc = $null
        sampleCount = 0
        distinctFrameCount = 0
        prelaunchBackdropUsed = $false
        backdropControlledExit = $false
        controlledExit = $false
        exitCode = $null
        qaRootRemoved = $false
        contactSheet = $null
        animationGif = $null
        failure = $null
    }
    try {
        & $fixturePath --root $qaRoot --scenario $Scenario --animation-mode $mode
        if ($LASTEXITCODE -ne 0) {
            throw "task failure fixture failed with exit code $LASTEXITCODE"
        }

        $backdropProcess = Start-Process `
            -FilePath $PythonPath `
            -ArgumentList @(
                "`"$backdropScript`"",
                "--ready-file",
                "`"$backdropReady`"",
                "--stop-file",
                "`"$backdropStop`""
            ) `
            -WindowStyle Hidden `
            -PassThru
        $backdropDeadline = [DateTime]::UtcNow.AddSeconds(5)
        while ([DateTime]::UtcNow -lt $backdropDeadline) {
            $backdropProcess.Refresh()
            if ($backdropProcess.HasExited) {
                throw "neutral capture backdrop exited before becoming ready"
            }
            if (Test-Path -LiteralPath $backdropReady -PathType Leaf) { break }
            Start-Sleep -Milliseconds 50
        }
        if (
            -not (Test-Path -LiteralPath $backdropReady -PathType Leaf) -or
            (Get-Content -Raw -Encoding UTF8 -LiteralPath $backdropReady) -ne `
                "YUANYUAN_NEUTRAL_CAPTURE_BACKDROP_V1`n"
        ) {
            throw "neutral capture backdrop did not provide its exact ready marker"
        }

        $previousRoot = [Environment]::GetEnvironmentVariable(
            "YUANYUAN_RUNTIME_QA_ROOT",
            "Process"
        )
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
                [string]$ExitAfterSeconds,
                "Process"
            )
            [Environment]::SetEnvironmentVariable(
                "YUANYUAN_RUNTIME_QA_PROFILE",
                "task-failure-motion",
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

        $sample.runtimeStageReady = Wait-RuntimeStage $qaRoot "exit-scheduled" $StartupTimeoutSeconds
        if (-not $sample.runtimeStageReady) {
            throw "runtime QA window setup did not complete"
        }

        $deadline = [DateTime]::UtcNow.AddSeconds(20)
        while ([DateTime]::UtcNow -lt $deadline) {
            $process.Refresh()
            if ($process.HasExited) { throw "runtime QA process exited before failure appeared" }
            if (Find-AccessibleFragment $process.Id $accessibleFragment) {
                $sample.accessibleStateObserved = $true
                break
            }
            Start-Sleep -Milliseconds 40
        }
        if (-not $sample.accessibleStateObserved) {
            throw "task failure accessible state was not observed"
        }

        $sample.captureStartedAtUtc = (Get-Date).ToUniversalTime().ToString("o")
        $backdropProcess.Refresh()
        if ($backdropProcess.HasExited) {
            throw "neutral capture backdrop exited before frame capture"
        }
        & $PythonPath $captureScript --pid $process.Id --duration $CaptureSeconds --interval 0.08 --output-dir $captureRoot --prelaunch-backdrop-attested
        if ($LASTEXITCODE -ne 0) { throw "task failure motion capture failed" }
        $capture = Get-Content -Raw -Encoding UTF8 -LiteralPath (
            Join-Path $captureRoot "installed-capture.json"
        ) | ConvertFrom-Json
        $sample.sampleCount = [int]$capture.sampleCount
        $sample.distinctFrameCount = [int]$capture.distinctFrameCount
        $backdropProcess.Refresh()
        $sample.prelaunchBackdropUsed = (
            -not $backdropProcess.HasExited -and
            $capture.prelaunchBackdropAttested -eq $true -and
            $capture.captureScope -eq "pet_window_over_prelaunch_virtual_desktop_backdrop"
        )
        $sample.contactSheet = (Join-Path $captureRoot "installed-contact-sheet.png")
        $sample.animationGif = (Join-Path $captureRoot "installed-animation.gif")

        if (-not $process.WaitForExit(($ExitAfterSeconds + 10) * 1000)) {
            throw "runtime QA process did not follow its controlled exit"
        }
        $sample.exitCode = $process.ExitCode
        $sample.controlledExit = $process.ExitCode -eq 0
        if (-not $sample.controlledExit) {
            throw "runtime QA process exited with code $($process.ExitCode)"
        }
    }
    catch {
        $sample.failure = $_.Exception.Message
    }
    finally {
        if ($null -ne $process) {
            $process.Refresh()
            if (-not $process.HasExited) {
                Stop-Process -Id $process.Id -Force -ErrorAction SilentlyContinue
                $process.WaitForExit(5000) | Out-Null
            }
        }
        if ($null -ne $backdropProcess) {
            $backdropProcess.Refresh()
            if (-not $backdropProcess.HasExited) {
                Set-Content -Encoding ASCII -LiteralPath $backdropStop -Value "stop"
                if (-not $backdropProcess.WaitForExit(5000)) {
                    Stop-Process -Id $backdropProcess.Id -Force -ErrorAction SilentlyContinue
                    $backdropProcess.WaitForExit(5000) | Out-Null
                }
                else {
                    $sample.backdropControlledExit = $backdropProcess.ExitCode -eq 0
                }
            }
        }
        for ($attempt = 0; $attempt -lt 10; $attempt += 1) {
            try {
                $sample.qaRootRemoved = Remove-OwnedQaRoot $qaRoot $leaf
                break
            }
            catch {
                if ($attempt -eq 9) { throw }
                Start-Sleep -Milliseconds 250
            }
        }
        $samples += $sample
    }
}

$full = $samples | Where-Object { $_.animationMode -eq "always" } | Select-Object -First 1
$reduced = $samples | Where-Object { $_.animationMode -eq "off" } | Select-Object -First 1
$passed = (
    $samples.Count -eq 2 -and
    $samples.runtimeStageReady -notcontains $false -and
    $samples.accessibleStateObserved -notcontains $false -and
    $samples.prelaunchBackdropUsed -notcontains $false -and
    $samples.backdropControlledExit -notcontains $false -and
    $samples.controlledExit -notcontains $false -and
    $samples.qaRootRemoved -notcontains $false -and
    $full.distinctFrameCount -ge 4 -and
    $reduced.distinctFrameCount -le 2
)
$report = [ordered]@{
    schemaVersion = 6
    generatedAt = (Get-Date).ToUniversalTime().ToString("o")
    candidate = $appPath
    candidateSha256 = (Get-FileHash -Algorithm SHA256 -LiteralPath $appPath).Hash
    scenario = $Scenario
    startupTimeoutSeconds = $StartupTimeoutSeconds
    accessibleFragment = $accessibleFragment
    samples = $samples
    passed = $passed
}
$report | ConvertTo-Json -Depth 8 | Set-Content -Encoding UTF8 -LiteralPath $reportPath
Write-Output "Task expression motion QA report: $reportPath"
if (-not $passed) { $scriptExitCode = 2 }
}
finally {
    $lockStream.Dispose()
    Remove-Item -LiteralPath $lockPath -Force -ErrorAction SilentlyContinue
}
if ($scriptExitCode -ne 0) { exit $scriptExitCode }
