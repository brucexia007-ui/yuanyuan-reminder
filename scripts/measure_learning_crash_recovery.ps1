param(
    [ValidateRange(1, 10)]
    [int]$SampleCount = 1,

    [ValidateRange(30, 120)]
    [int]$SecondExitAfterSeconds = 30,

    [ValidateSet("committed", "in-flight-commit")]
    [string]$Scenario = "committed",

    [switch]$EvidenceGate
)

$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"
$projectRoot = Split-Path -Parent $PSScriptRoot
$workspaceRoot = Split-Path -Parent $projectRoot
$runtimeTarget = Join-Path $projectRoot "src-tauri\target\runtime-qa-learning-recovery\release"
$appPath = Join-Path $runtimeTarget "yuanyuan-reminder.exe"
$fixturePath = Join-Path $runtimeTarget "yuanyuan-runtime-qa-fixture.exe"
$evidenceRoot = Join-Path $runtimeTarget "evidence"
$runId = (Get-Date).ToUniversalTime().ToString("yyyyMMddTHHmmssZ")
$reportPrefix = if ($Scenario -eq "committed") {
    "learning-crash-recovery"
}
else { "learning-in-flight-commit-recovery" }
$reportPath = Join-Path $evidenceRoot "$reportPrefix-$runId.json"
$expectedMarker = "YUANYUAN_RUNTIME_QA_V1`n"
$fixtureCardCount = 5
$minimumEvidenceSamples = 5
$firstExitAfterSeconds = 120
$learningPageFragment = -join @([char]0x5B66, [char]0x4E60, [char]0x9875, [char]0x9762)
$blackboardFragment = -join @(
    [char]0x5706, [char]0x5706, [char]0x684C, [char]0x9762,
    [char]0x82F1, [char]0x8BED, [char]0x590D, [char]0x4E60
)
$startRoundFragment = -join @([char]0x5F00, [char]0x59CB, [char]0x4E00, [char]0x8F6E)
$resumeRoundFragment = -join @(
    [char]0x7EE7, [char]0x7EED, [char]0x4E0A,
    [char]0x4E00, [char]0x8F6E
)
$syntheticMeaningFragment = -join @(
    [char]0x5408, [char]0x6210, [char]0x91CA, [char]0x4E49
)
$nextQuestionFragment = -join @([char]0x4E0B, [char]0x4E00, [char]0x9898)
$commitCrashArmTrigger = "arm-learning-answer-commit-crash"
$commitCrashReleaseTrigger = "release-learning-answer-commit-crash"
$commitCrashEnteredStage = "learning-answer-commit-hook-entered"
$commitCrashErrorStage = "learning-answer-commit-hook-error"

if ($EvidenceGate -and $SampleCount -lt $minimumEvidenceSamples) {
    throw "the learning crash recovery evidence gate requires at least $minimumEvidenceSamples samples"
}
foreach ($required in @($appPath, $fixturePath)) {
    if (-not (Test-Path -LiteralPath $required -PathType Leaf)) {
        throw "learning recovery runtime QA binary is missing; run npm.cmd run runtime:qa:learning-recovery:build first"
    }
}
New-Item -ItemType Directory -Force -Path $evidenceRoot | Out-Null
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes
Add-Type -AssemblyName System.Windows.Forms

if (-not ("YuanyuanLearningRecoveryWindowProbe" -as [type])) {
    Add-Type -TypeDefinition @"
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;

public static class YuanyuanLearningRecoveryWindowProbe {
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

function Get-LearningJournalState([string]$Root) {
    $databasePath = Join-Path $Root (
        "app-data\com.yuanyuan.reminder.runtime-qa\learning-data\yuanyuan-learning.sqlite3"
    )
    $walPath = "$databasePath-wal"
    $shmPath = "$databasePath-shm"
    $database = Get-Item -LiteralPath $databasePath -ErrorAction SilentlyContinue
    $wal = Get-Item -LiteralPath $walPath -ErrorAction SilentlyContinue
    $shm = Get-Item -LiteralPath $shmPath -ErrorAction SilentlyContinue
    return [ordered]@{
        databaseExists = $null -ne $database
        databaseBytes = if ($null -ne $database) { [long]$database.Length } else { 0 }
        databaseSha256 = if ($null -ne $database) { Get-FileSha256 $databasePath } else { $null }
        walExists = $null -ne $wal
        walBytes = if ($null -ne $wal) { [long]$wal.Length } else { 0 }
        walSha256 = if ($null -ne $wal) { Get-FileSha256 $walPath } else { $null }
        shmExists = $null -ne $shm
        shmBytes = if ($null -ne $shm) { [long]$shm.Length } else { 0 }
        shmSha256 = if ($null -ne $shm) { Get-FileSha256 $shmPath } else { $null }
    }
}

function Get-WebView2Version {
    try {
        $process = Get-Process -Name "msedgewebview2" -ErrorAction Stop | Select-Object -First 1
        return $process.MainModule.FileVersionInfo.FileVersion
    }
    catch { return $null }
}

function Clear-RuntimeStages([string]$Root) {
    $statusRoot = Join-Path $Root "status"
    foreach ($stage in @("setup-entered", "windows-created", "core-setup-complete", "exit-scheduled")) {
        Remove-Item -LiteralPath (Join-Path $statusRoot $stage) -Force -ErrorAction SilentlyContinue
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

function Arm-LearningAnswerCommitCrash([string]$Root) {
    $controlRoot = Join-Path $Root "control"
    $statusRoot = Join-Path $Root "status"
    $armPath = Join-Path $controlRoot $commitCrashArmTrigger
    $releasePath = Join-Path $controlRoot $commitCrashReleaseTrigger
    $enteredPath = Join-Path $statusRoot $commitCrashEnteredStage
    $errorPath = Join-Path $statusRoot $commitCrashErrorStage
    foreach ($path in @($armPath, $releasePath, $enteredPath, $errorPath)) {
        if (Test-Path -LiteralPath $path) {
            throw "learning answer commit crash control state is not clean"
        }
    }
    $stream = [System.IO.File]::Open(
        $armPath,
        [System.IO.FileMode]::CreateNew,
        [System.IO.FileAccess]::Write,
        [System.IO.FileShare]::None
    )
    $stream.Dispose()
}

function Wait-LearningAnswerCommitHook(
    [System.Diagnostics.Process]$Process,
    [string]$Root,
    [int]$TimeoutSeconds
) {
    $enteredPath = Join-Path (Join-Path $Root "status") $commitCrashEnteredStage
    $errorPath = Join-Path (Join-Path $Root "status") $commitCrashErrorStage
    $deadline = [DateTime]::UtcNow.AddSeconds($TimeoutSeconds)
    while ([DateTime]::UtcNow -lt $deadline) {
        $Process.Refresh()
        if ($Process.HasExited) { throw "application exited before the SQLite commit hook was entered" }
        if (Test-Path -LiteralPath $errorPath -PathType Leaf) {
            throw "runtime QA SQLite commit hook rejected its control state"
        }
        if (Test-Path -LiteralPath $enteredPath -PathType Leaf) {
            $content = Get-Content -Raw -Encoding UTF8 -LiteralPath $enteredPath
            if ($content -ne "entered`n") {
                throw "runtime QA SQLite commit hook entered stage is invalid"
            }
            return
        }
        Start-Sleep -Milliseconds 25
    }
    throw "SQLite answer commit hook was not entered before the deadline"
}

function Get-AccessibleNodes([int]$ProcessId) {
    $result = [System.Collections.Generic.List[object]]::new()
    $windows = @([YuanyuanLearningRecoveryWindowProbe]::VisibleWindows($ProcessId))
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
            # WebView accessibility nodes can disappear between snapshots.
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
        if ($Process.HasExited) { throw "application exited before the recovery target appeared" }
        $element = Find-AccessibleElement $Process.Id $Fragment $ButtonOnly
        if ($null -ne $element) { return $element }
        Start-Sleep -Milliseconds 50
    }
    throw "learning recovery target was not found in the Windows accessibility tree"
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
                if (
                    $name -and
                    $name -match '^qa[a-z]+$' -and
                    ([string]::IsNullOrEmpty($Expected) -or $name -eq $Expected)
                ) { return $name }
            }
            catch {}
        }
        Start-Sleep -Milliseconds 50
    }
    throw "synthetic learning headword was not found in the Windows accessibility tree"
}

function Wait-DifferentHeadword(
    [System.Diagnostics.Process]$Process,
    [string]$AnsweredHeadword,
    [int]$TimeoutSeconds
) {
    $deadline = [DateTime]::UtcNow.AddSeconds($TimeoutSeconds)
    $nextInvoked = $false
    while ([DateTime]::UtcNow -lt $deadline) {
        $Process.Refresh()
        if ($Process.HasExited) { throw "application exited before the next question appeared" }
        foreach ($node in @(Get-AccessibleNodes $Process.Id)) {
            try {
                $name = $node.Current.Name
                if ($name -and $name -match '^qa[a-z]+$' -and $name -ne $AnsweredHeadword) {
                    return $name
                }
            }
            catch {}
        }
        if (-not $nextInvoked) {
            $nextButton = Find-AccessibleElement $Process.Id $nextQuestionFragment $true
            if ($null -ne $nextButton) {
                Invoke-AccessibleElement $nextButton
                $nextInvoked = $true
            }
        }
        Start-Sleep -Milliseconds 50
    }
    throw "the next unanswered synthetic learning headword did not appear"
}

function Invoke-AccessibleElement([System.Windows.Automation.AutomationElement]$Element) {
    $pattern = $null
    if (-not $Element.TryGetCurrentPattern(
        [System.Windows.Automation.InvokePattern]::Pattern,
        [ref]$pattern
    )) { throw "learning recovery control does not expose the invoke pattern" }
    ([System.Windows.Automation.InvokePattern]$pattern).Invoke()
}

function Start-QaApplication([string]$Root, [int]$ExitAfterSeconds) {
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

function Stop-QaApplicationForCrash([System.Diagnostics.Process]$Process) {
    $Process.Refresh()
    if ($Process.HasExited) { throw "application exited before the crash injection" }
    $ownedProcess = Get-Process -Id $Process.Id -ErrorAction Stop
    if ($ownedProcess.Path -ne $appPath) {
        throw "refusing to terminate a process outside the recovery QA executable"
    }
    Stop-Process -Id $Process.Id -Force
    if (-not $Process.WaitForExit(10000)) {
        throw "application did not exit after the crash injection"
    }
    $Process.Refresh()
    return [int]$Process.ExitCode
}

function Stop-QaApplicationIfRunning([System.Diagnostics.Process]$Process) {
    if ($null -eq $Process) { return }
    try {
        $Process.Refresh()
        if ($Process.HasExited) { return }
        $ownedProcess = Get-Process -Id $Process.Id -ErrorAction Stop
        if ($ownedProcess.Path -ne $appPath) {
            throw "refusing to stop a process outside the recovery QA executable"
        }
        Stop-Process -Id $Process.Id -Force
        $Process.WaitForExit(10000) | Out-Null
    }
    catch {}
}

function Read-RecoveryState([string]$Root) {
    $text = & $fixturePath --root $Root --learning-recovery-state
    if ($LASTEXITCODE -ne 0) { throw "learning recovery state inspection failed" }
    return $text | ConvertFrom-Json
}

function Assert-LearningStateAnswerCount(
    [object]$State,
    [string]$Phase,
    [int]$ExpectedAnswerCount
) {
    if (
        $State.completedCount -ne $ExpectedAnswerCount -or
        $State.questionAttemptCount -ne $ExpectedAnswerCount -or
        $State.reviewLogCount -ne $ExpectedAnswerCount -or
        $State.answerCommittedEventCount -ne $ExpectedAnswerCount
    ) { throw "$Phase answer counters do not equal $ExpectedAnswerCount" }
    if ($ExpectedAnswerCount -eq 0) {
        if (
            $null -ne $State.lastAnsweredItemId -or
            $null -ne $State.lastAnsweredHeadword -or
            $null -ne $State.lastAnswerOutcome
        ) { throw "$Phase unexpectedly reports a committed answer" }
    }
    elseif (
        [string]::IsNullOrEmpty($State.lastAnsweredItemId) -or
        [string]::IsNullOrEmpty($State.lastAnsweredHeadword) -or
        $State.lastAnswerOutcome -notin @("correct", "incorrect")
    ) { throw "$Phase does not identify the committed answer" }
    if ($State.integrityCheck -ne "ok" -or $State.foreignKeyViolationCount -ne 0) {
        throw "$Phase learning database integrity check failed"
    }
}

function Wait-CommittedAnswerState(
    [System.Diagnostics.Process]$Process,
    [string]$Root,
    [string]$AnsweredHeadword,
    [int]$TimeoutSeconds
) {
    $deadline = [DateTime]::UtcNow.AddSeconds($TimeoutSeconds)
    while ([DateTime]::UtcNow -lt $deadline) {
        $Process.Refresh()
        if ($Process.HasExited) { throw "application exited before the answer commit was visible" }
        try {
            $state = Read-RecoveryState $Root
            Assert-LearningStateAnswerCount $state "post-answer" 1
            if (
                $state.lastAnsweredHeadword -eq $AnsweredHeadword -and
                $state.currentItemId -ne $state.lastAnsweredItemId -and
                $state.headword -ne $AnsweredHeadword
            ) { return $state }
        }
        catch {}
        Start-Sleep -Milliseconds 50
    }
    throw "the committed answer did not produce exactly one persisted review"
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

$lockPath = Join-Path $evidenceRoot "learning-crash-recovery.lock"
$lockStream = $null
try {
    $lockStream = [System.IO.File]::Open(
        $lockPath,
        [System.IO.FileMode]::OpenOrCreate,
        [System.IO.FileAccess]::ReadWrite,
        [System.IO.FileShare]::None
    )
}
catch { throw "another learning crash recovery measurement is already active" }

$scriptExitCode = 0
try {
    $samples = @()
    $fixtureContentSha256 = $null
    $webView2Version = $null
    for ($index = 0; $index -lt $SampleCount; $index += 1) {
        $sampleNumber = $index + 1
        $leaf = "yuanyuan-runtime-qa-learning-recovery-$runId-$sampleNumber"
        $qaRoot = Join-Path $workspaceRoot $leaf
        $firstProcess = $null
        $secondProcess = $null
        $script:probeMaxVisibleWindows = 0
        $script:probeMaxAccessibleNodes = 0
        $script:probeAccessibleNames = [System.Collections.Generic.HashSet[string]]::new()
        $sample = [ordered]@{
            sample = $sampleNumber
            scenario = $Scenario
            fixtureDatabaseSha256 = $null
            fixtureDatabaseBytes = $null
            firstPageReadyMilliseconds = $null
            initialBlackboardMilliseconds = $null
            answeredHeadword = $null
            preAnswerState = $null
            originalHeadword = $null
            preCrashState = $null
            commitHookArmed = $false
            commitHookEntered = $false
            commitHookEnteredMilliseconds = $null
            crashInjected = $false
            crashExitCode = $null
            postCrashJournal = $null
            restartPageReadyMilliseconds = $null
            resumeAvailableMilliseconds = $null
            postRestartState = $null
            residualJournalRecovered = $false
            resumedBlackboardMilliseconds = $null
            resumedHeadword = $null
            postResumeState = $null
            sameSession = $false
            sameItem = $false
            sameHeadword = $false
            committedAnswerPreserved = $false
            uncommittedAnswerAbsent = $false
            secondControlledExit = $false
            secondExitCode = $null
            postControlledExitJournal = $null
            maxVisibleWindows = 0
            maxAccessibleNodes = 0
            observedAccessibleNames = @()
            rootRemoved = $false
            passed = $false
            failure = $null
        }
        try {
            $planText = & $fixturePath --root $qaRoot --learning-performance $fixtureCardCount
            if ($LASTEXITCODE -ne 0) { throw "learning fixture seeding failed" }
            $plan = $planText | ConvertFrom-Json
            if ($plan.cardCount -ne $fixtureCardCount) { throw "learning fixture count is incorrect" }
            if ($null -eq $fixtureContentSha256) { $fixtureContentSha256 = $plan.contentSha256 }
            elseif ($fixtureContentSha256 -ne $plan.contentSha256) {
                throw "learning fixture content changed between samples"
            }
            $sample.fixtureDatabaseSha256 = $plan.databaseSha256
            $sample.fixtureDatabaseBytes = [long]$plan.databaseBytes

            Clear-RuntimeStages $qaRoot
            $firstLaunchTimer = [Diagnostics.Stopwatch]::StartNew()
            $firstProcess = Start-QaApplication $qaRoot $firstExitAfterSeconds
            if (-not (Wait-RuntimeStage $qaRoot "exit-scheduled" 30)) {
                throw "first runtime QA window setup did not complete"
            }
            $null = Wait-AccessibleElement $firstProcess $learningPageFragment $false 30
            $sample.firstPageReadyMilliseconds = [Math]::Round(
                $firstLaunchTimer.Elapsed.TotalMilliseconds,
                1
            )
            $startButton = Wait-AccessibleElement $firstProcess $startRoundFragment $true 10
            $blackboardTimer = [Diagnostics.Stopwatch]::StartNew()
            Invoke-AccessibleElement $startButton
            $null = Wait-AccessibleElement $firstProcess $blackboardFragment $false 20
            $preAnswerState = Read-RecoveryState $qaRoot
            Assert-LearningStateAnswerCount $preAnswerState "pre-answer" 0
            if ($preAnswerState.status -ne "active" -or $null -ne $preAnswerState.pauseReason) {
                throw "pre-answer session is not active"
            }
            if (
                $preAnswerState.crashRecoveredEventCount -ne 0 -or
                $preAnswerState.resumedEventCount -ne 0
            ) { throw "pre-answer session already contains recovery events" }
            $answeredHeadword = Wait-Headword $firstProcess $preAnswerState.headword 10
            $sample.initialBlackboardMilliseconds = [Math]::Round(
                $blackboardTimer.Elapsed.TotalMilliseconds,
                1
            )
            $sample.answeredHeadword = $answeredHeadword
            $sample.preAnswerState = $preAnswerState

            $answerButton = Wait-AccessibleElement $firstProcess $syntheticMeaningFragment $true 10
            if ($Scenario -eq "committed") {
                Invoke-AccessibleElement $answerButton
                $postAnswerState = Wait-CommittedAnswerState $firstProcess $qaRoot $answeredHeadword 10
                $originalHeadword = Wait-DifferentHeadword $firstProcess $answeredHeadword 20
                $preCrashState = Read-RecoveryState $qaRoot
                Assert-LearningStateAnswerCount $preCrashState "pre-crash" 1
                if (
                    $preCrashState.sessionId -ne $preAnswerState.sessionId -or
                    $preCrashState.status -ne "active" -or
                    $null -ne $preCrashState.pauseReason -or
                    $preCrashState.stateRevision -ne ($preAnswerState.stateRevision + 1) -or
                    $preCrashState.eventCount -ne ($preAnswerState.eventCount + 1) -or
                    $preCrashState.currentItemId -ne $postAnswerState.currentItemId -or
                    $preCrashState.headword -ne $postAnswerState.headword -or
                    $preCrashState.headword -ne $originalHeadword -or
                    $preCrashState.lastAnsweredHeadword -ne $answeredHeadword -or
                    $preCrashState.currentItemId -eq $preCrashState.lastAnsweredItemId -or
                    $preCrashState.crashRecoveredEventCount -ne 0 -or
                    $preCrashState.resumedEventCount -ne 0
                ) { throw "pre-crash session does not prove one committed answer and a new unanswered question" }
            }
            else {
                Arm-LearningAnswerCommitCrash $qaRoot
                $sample.commitHookArmed = $true
                $commitHookTimer = [Diagnostics.Stopwatch]::StartNew()
                Invoke-AccessibleElement $answerButton
                Wait-LearningAnswerCommitHook $firstProcess $qaRoot 10
                $sample.commitHookEnteredMilliseconds = [Math]::Round(
                    $commitHookTimer.Elapsed.TotalMilliseconds,
                    1
                )
                $sample.commitHookEntered = $true
                $originalHeadword = $answeredHeadword
                $preCrashState = $preAnswerState
            }
            $sample.originalHeadword = $originalHeadword
            $sample.preCrashState = $preCrashState
            if ($null -eq $webView2Version) { $webView2Version = Get-WebView2Version }

            $sample.crashExitCode = Stop-QaApplicationForCrash $firstProcess
            $sample.crashInjected = $firstProcess.HasExited -and $sample.crashExitCode -ne 0
            if (-not $sample.crashInjected) { throw "forced crash did not produce an abnormal exit" }
            Start-Sleep -Milliseconds 750
            $postCrashJournal = Get-LearningJournalState $qaRoot
            $sample.postCrashJournal = $postCrashJournal
            if (
                -not $postCrashJournal.databaseExists -or
                $postCrashJournal.databaseBytes -le 0 -or
                [string]::IsNullOrEmpty($postCrashJournal.databaseSha256) -or
                -not $postCrashJournal.walExists -or
                $postCrashJournal.walBytes -le 0 -or
                [string]::IsNullOrEmpty($postCrashJournal.walSha256) -or
                -not $postCrashJournal.shmExists -or
                $postCrashJournal.shmBytes -le 0 -or
                [string]::IsNullOrEmpty($postCrashJournal.shmSha256)
            ) { throw "forced termination did not leave a non-empty WAL/SHM recovery fixture" }

            Clear-RuntimeStages $qaRoot
            $restartTimer = [Diagnostics.Stopwatch]::StartNew()
            $secondProcess = Start-QaApplication $qaRoot $SecondExitAfterSeconds
            if (-not (Wait-RuntimeStage $qaRoot "exit-scheduled" 30)) {
                throw "restarted runtime QA window setup did not complete"
            }
            $null = Wait-AccessibleElement $secondProcess $learningPageFragment $false 30
            $sample.restartPageReadyMilliseconds = [Math]::Round(
                $restartTimer.Elapsed.TotalMilliseconds,
                1
            )
            $resumeButton = Wait-AccessibleElement $secondProcess $resumeRoundFragment $true 10
            $sample.resumeAvailableMilliseconds = [Math]::Round(
                $restartTimer.Elapsed.TotalMilliseconds,
                1
            )
            $postRestartState = Read-RecoveryState $qaRoot
            $expectedAnswerCount = if ($Scenario -eq "committed") { 1 } else { 0 }
            Assert-LearningStateAnswerCount $postRestartState "post-restart" $expectedAnswerCount
            if (
                $postRestartState.sessionId -ne $preCrashState.sessionId -or
                $postRestartState.currentItemId -ne $preCrashState.currentItemId -or
                $postRestartState.headword -ne $preCrashState.headword -or
                $postRestartState.status -ne "paused" -or
                $postRestartState.pauseReason -ne "crash_recovery" -or
                $postRestartState.stateRevision -ne ($preCrashState.stateRevision + 1) -or
                $postRestartState.eventCount -ne ($preCrashState.eventCount + 1) -or
                $postRestartState.crashRecoveredEventCount -ne 1 -or
                $postRestartState.resumedEventCount -ne 0 -or
                $postRestartState.lastAnsweredItemId -ne $preCrashState.lastAnsweredItemId -or
                $postRestartState.lastAnsweredHeadword -ne $preCrashState.lastAnsweredHeadword -or
                $postRestartState.lastAnswerOutcome -ne $preCrashState.lastAnswerOutcome
            ) { throw "post-restart session state does not prove crash recovery" }
            $sample.postRestartState = $postRestartState
            $sample.residualJournalRecovered = $true

            $resumeTimer = [Diagnostics.Stopwatch]::StartNew()
            Invoke-AccessibleElement $resumeButton
            $null = Wait-AccessibleElement $secondProcess $blackboardFragment $false 20
            $resumedHeadword = Wait-Headword $secondProcess $preCrashState.headword 10
            $sample.resumedBlackboardMilliseconds = [Math]::Round(
                $resumeTimer.Elapsed.TotalMilliseconds,
                1
            )
            $postResumeState = Read-RecoveryState $qaRoot
            Assert-LearningStateAnswerCount $postResumeState "post-resume" $expectedAnswerCount
            if (
                $postResumeState.sessionId -ne $preCrashState.sessionId -or
                $postResumeState.currentItemId -ne $preCrashState.currentItemId -or
                $postResumeState.headword -ne $preCrashState.headword -or
                $postResumeState.status -ne "active" -or
                $null -ne $postResumeState.pauseReason -or
                $postResumeState.stateRevision -ne ($postRestartState.stateRevision + 1) -or
                $postResumeState.eventCount -ne ($postRestartState.eventCount + 1) -or
                $postResumeState.crashRecoveredEventCount -ne 1 -or
                $postResumeState.resumedEventCount -ne 1 -or
                $postResumeState.lastAnsweredItemId -ne $preCrashState.lastAnsweredItemId -or
                $postResumeState.lastAnsweredHeadword -ne $preCrashState.lastAnsweredHeadword -or
                $postResumeState.lastAnswerOutcome -ne $preCrashState.lastAnswerOutcome
            ) { throw "resumed session state does not preserve the original question" }
            $sample.resumedHeadword = $resumedHeadword
            $sample.postResumeState = $postResumeState
            $sample.sameSession = $postResumeState.sessionId -eq $preCrashState.sessionId
            $sample.sameItem = $postResumeState.currentItemId -eq $preCrashState.currentItemId
            $sample.sameHeadword = (
                $originalHeadword -eq $resumedHeadword -and
                $resumedHeadword -eq $postResumeState.headword
            )
            $sample.committedAnswerPreserved = (
                $Scenario -eq "committed" -and
                $postResumeState.completedCount -eq 1 -and
                $postResumeState.questionAttemptCount -eq 1 -and
                $postResumeState.reviewLogCount -eq 1 -and
                $postResumeState.answerCommittedEventCount -eq 1 -and
                $postResumeState.lastAnsweredItemId -eq $preCrashState.lastAnsweredItemId -and
                $postResumeState.lastAnsweredHeadword -eq $answeredHeadword -and
                $postResumeState.lastAnswerOutcome -eq $preCrashState.lastAnswerOutcome -and
                $postResumeState.currentItemId -ne $postResumeState.lastAnsweredItemId
            )
            $sample.uncommittedAnswerAbsent = (
                $Scenario -eq "in-flight-commit" -and
                $postResumeState.completedCount -eq 0 -and
                $postResumeState.questionAttemptCount -eq 0 -and
                $postResumeState.reviewLogCount -eq 0 -and
                $postResumeState.answerCommittedEventCount -eq 0 -and
                $null -eq $postResumeState.lastAnsweredItemId -and
                $null -eq $postResumeState.lastAnsweredHeadword -and
                $null -eq $postResumeState.lastAnswerOutcome -and
                $postResumeState.currentItemId -eq $preAnswerState.currentItemId
            )
            if (
                -not $sample.sameSession -or
                -not $sample.sameItem -or
                -not $sample.sameHeadword -or
                ($Scenario -eq "committed" -and -not $sample.committedAnswerPreserved) -or
                ($Scenario -eq "in-flight-commit" -and -not $sample.uncommittedAnswerAbsent)
            ) { throw "crash recovery invariants are incomplete" }

            $secondProcess.WaitForExit(($SecondExitAfterSeconds + 15) * 1000) | Out-Null
            $secondProcess.Refresh()
            if (-not $secondProcess.HasExited) {
                throw "restarted application did not use the controlled exit path"
            }
            $sample.secondExitCode = [int]$secondProcess.ExitCode
            $sample.secondControlledExit = $sample.secondExitCode -eq 0
            if (-not $sample.secondControlledExit) {
                throw "restarted application controlled exit returned a non-zero code"
            }
            $postControlledExitJournal = Get-LearningJournalState $qaRoot
            $sample.postControlledExitJournal = $postControlledExitJournal
            if (
                -not $postControlledExitJournal.databaseExists -or
                $postControlledExitJournal.databaseBytes -le 0 -or
                [string]::IsNullOrEmpty($postControlledExitJournal.databaseSha256)
            ) { throw "controlled exit did not leave a readable learning database" }
            $sample.passed = $true
        }
        catch {
            $sample.failure = $_.Exception.Message
        }
        finally {
            Stop-QaApplicationIfRunning $firstProcess
            Stop-QaApplicationIfRunning $secondProcess
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
    $resumeAvailable = [double[]]@($passedSamples | ForEach-Object resumeAvailableMilliseconds)
    $resumedBlackboard = [double[]]@($passedSamples | ForEach-Object resumedBlackboardMilliseconds)
    $commitHookEntered = [double[]]@(
        $passedSamples |
            Where-Object { $null -ne $_.commitHookEnteredMilliseconds } |
            ForEach-Object commitHookEnteredMilliseconds
    )
    $samplesWithResidualWal = @(
        $passedSamples | Where-Object { $_.postCrashJournal.walExists -and $_.postCrashJournal.walBytes -gt 0 }
    ).Count
    $samplesWithResidualShm = @(
        $passedSamples | Where-Object { $_.postCrashJournal.shmExists -and $_.postCrashJournal.shmBytes -gt 0 }
    ).Count
    $samplesWithHealthyRestart = @(
        $passedSamples | Where-Object residualJournalRecovered
    ).Count
    $samplesWithUncommittedAnswerAbsent = @(
        $passedSamples | Where-Object uncommittedAnswerAbsent
    ).Count
    $gateFailures = @()
    if ($EvidenceGate) {
        if ($SampleCount -lt $minimumEvidenceSamples) {
            $gateFailures += "evidence gate requires at least $minimumEvidenceSamples samples"
        }
        if ($passedSamples.Count -ne $SampleCount) {
            $gateFailures += "not all requested crash recovery samples passed"
        }
    }
    $gatePassed = $EvidenceGate -and $gateFailures.Count -eq 0
    $sampleSetPassed = $passedSamples.Count -eq $SampleCount
    $windowsVersion = Get-ItemProperty -LiteralPath "HKLM:\SOFTWARE\Microsoft\Windows NT\CurrentVersion"
    $gitCommit = (& git -C $projectRoot rev-parse HEAD).Trim()
    $gitStatus = (& git -C $projectRoot status --porcelain=v1 --untracked-files=all) -join "`n"
    $report = [ordered]@{
        schemaVersion = 4
        generatedAt = [DateTimeOffset]::UtcNow.ToString("o")
        profile = $reportPrefix
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
            firstExitAfterSeconds = $firstExitAfterSeconds
            secondExitAfterSeconds = $SecondExitAfterSeconds
            committedAnswersBeforeCrash = if ($Scenario -eq "committed") { 1 } else { 0 }
            scenario = $Scenario
            evidenceGateRequested = [bool]$EvidenceGate
        }
        fixture = [ordered]@{
            cardCount = $fixtureCardCount
            contentKind = "deterministic-synthetic-english-csv"
        }
        summary = [ordered]@{
            passedSamples = $passedSamples.Count
            resumeAvailableP50Milliseconds = Get-Percentile $resumeAvailable 0.50
            resumeAvailableP95Milliseconds = Get-Percentile $resumeAvailable 0.95
            resumedBlackboardP50Milliseconds = Get-Percentile $resumedBlackboard 0.50
            resumedBlackboardP95Milliseconds = Get-Percentile $resumedBlackboard 0.95
            samplesWithResidualWal = $samplesWithResidualWal
            samplesWithResidualShm = $samplesWithResidualShm
            samplesWithHealthyRestart = $samplesWithHealthyRestart
            commitHookEnteredP50Milliseconds = Get-Percentile $commitHookEntered 0.50
            commitHookEnteredP95Milliseconds = Get-Percentile $commitHookEntered 0.95
            samplesWithUncommittedAnswerAbsent = $samplesWithUncommittedAnswerAbsent
        }
        evidenceGate = [ordered]@{
            requested = [bool]$EvidenceGate
            minimumSamples = $minimumEvidenceSamples
            passed = if ($EvidenceGate) { $gatePassed } else { $null }
            failures = $gateFailures
        }
        ready = $sampleSetPassed -and ((-not $EvidenceGate) -or $gatePassed)
        limitations = if ($Scenario -eq "committed") {
            @(
                "The application and fixture are an isolated learning runtime-QA build, not a signed production candidate."
                "The five cards are deterministic synthetic data and contain no personal learning material."
                "The crash is an exact forced termination of the owned QA application process; Windows UI Automation validates the recovery and resume surfaces."
                "Exactly one answer is committed before the crash; its attempt, review, event, item, and outcome remain single while the next unanswered question is restored."
                "Each passing sample observes non-empty SQLite WAL and SHM files after forced termination, then proves a healthy restart, one-time recovery, controlled exit, and owned-root cleanup."
                "This committed-answer scenario does not cover termination inside SQLite commit, physical disk exhaustion, or hardware I/O failure."
                "This report does not replace strong-reminder preemption, multi-DPI, Narrator, reduced-motion, signed-candidate, or migration recovery evidence."
            )
        }
        else {
            @(
                "The application and fixture are an isolated learning runtime-QA build, not a signed production candidate."
                "The five cards are deterministic synthetic data and contain no personal learning material."
                "A runtime-QA-only answer gate is armed immediately before transaction.commit; SQLite's commit hook writes the entered stage after all answer SQL and blocks inside the commit callback until the owned process is terminated."
                "Each passing sample proves that the in-flight selection leaves no answer attempt, review, schedule advancement, answer event, or completed count after restart, and the original question remains resumable."
                "Each passing sample observes non-empty SQLite WAL and SHM files after forced termination, then proves a healthy restart, one-time crash recovery, controlled exit, and owned-root cleanup."
                "This controlled callback window does not model every later durable-write or hardware power-loss point, physical disk exhaustion, corrupted journals, or hardware I/O failure."
                "This report does not replace strong-reminder preemption, multi-DPI, Narrator, reduced-motion, signed-candidate, or migration recovery evidence."
            )
        }
        samples = @($samples)
    }
    $report | ConvertTo-Json -Depth 9 | Set-Content -Encoding UTF8 -LiteralPath $reportPath
    Write-Output "Learning crash recovery report written: $reportPath"
    Write-Output (
        "Scenario={0} Samples={1}/{2} ResumeAvailableP95={3}ms ResumedBlackboardP95={4}ms Ready={5}" -f
        $Scenario,
        $passedSamples.Count,
        $SampleCount,
        $report.summary.resumeAvailableP95Milliseconds,
        $report.summary.resumedBlackboardP95Milliseconds,
        $report.ready
    )
    if (-not $report.ready) { $scriptExitCode = 2 }
}
finally {
    if ($null -ne $lockStream) { $lockStream.Dispose() }
    Remove-Item -LiteralPath $lockPath -Force -ErrorAction SilentlyContinue
}
exit $scriptExitCode
