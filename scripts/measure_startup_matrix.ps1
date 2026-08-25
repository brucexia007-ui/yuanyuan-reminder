param(
    [ValidateSet("learning-off", "learning-on")]
    [string]$BuildVariant = "learning-off",

    [ValidateSet("cold", "warm")]
    [string]$StartupMode = "cold",

    [ValidateRange(1, 20)]
    [int]$SampleCount = 5,

    [switch]$BaselineGate
)

$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"
$projectRoot = Split-Path -Parent $PSScriptRoot
$workspaceRoot = Split-Path -Parent $projectRoot
$targetName = if ($BuildVariant -eq "learning-on") { "runtime-qa-learning" } else { "runtime-qa" }
$runtimeTarget = Join-Path $projectRoot "src-tauri\target\$targetName\release"
$appPath = Join-Path $runtimeTarget "yuanyuan-reminder.exe"
$fixturePath = Join-Path $runtimeTarget "yuanyuan-runtime-qa-fixture.exe"
$evidenceRoot = Join-Path $runtimeTarget "evidence"
$runId = (Get-Date).ToUniversalTime().ToString("yyyyMMddTHHmmssZ")
$reportPath = Join-Path $evidenceRoot "startup-$StartupMode-$runId.json"
$expectedMarker = "YUANYUAN_RUNTIME_QA_V1`n"
$minimumSamples = 20

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
Add-Type -AssemblyName System.Windows.Forms

if (-not ("YuanyuanStartupWindowProbe" -as [type])) {
    Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;

public static class YuanyuanStartupWindowProbe {
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

function Restore-EnvironmentValue([string]$Name, [string]$Value, [bool]$Existed) {
    if ($Existed) {
        Set-Item -LiteralPath "Env:$Name" -Value $Value
    }
    else {
        Remove-Item -LiteralPath "Env:$Name" -ErrorAction SilentlyContinue
    }
}

function Get-StringSha256([string]$Value) {
    $algorithm = [Security.Cryptography.SHA256]::Create()
    try {
        return ([BitConverter]::ToString(
            $algorithm.ComputeHash([Text.Encoding]::UTF8.GetBytes($Value))
        )).Replace("-", "")
    }
    finally {
        $algorithm.Dispose()
    }
}

function Get-DatabaseSnapshot([string]$Root) {
    $rows = @()
    if (Test-Path -LiteralPath $Root -PathType Container) {
        $rows = @(Get-ChildItem -LiteralPath $Root -Recurse -File -ErrorAction Stop |
            Where-Object { $_.Name -match '\.sqlite3($|-wal$|-shm$)' } |
            Sort-Object FullName |
            ForEach-Object {
                [ordered]@{
                    relativePath = $_.FullName.Substring($Root.Length).TrimStart('\')
                    bytes = [long]$_.Length
                    sha256 = (Get-FileHash -Algorithm SHA256 -LiteralPath $_.FullName).Hash
                }
            })
    }
    $totalBytes = ($rows | ForEach-Object { $_.bytes } | Measure-Object -Sum).Sum
    if ($null -eq $totalBytes) { $totalBytes = 0 }
    $manifest = $rows | ConvertTo-Json -Compress
    if ($null -eq $manifest) { $manifest = "[]" }
    [ordered]@{
        sha256 = Get-StringSha256 $manifest
        fileCount = $rows.Count
        bytes = [long]$totalBytes
    }
}

function Get-Percentile([double[]]$Values, [double]$Percentile) {
    if ($Values.Count -eq 0) { return $null }
    $ordered = @($Values | Sort-Object)
    $index = [Math]::Max(0, [Math]::Ceiling($Percentile * $ordered.Count) - 1)
    return [Math]::Round([double]$ordered[$index], 1)
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
    for ($attempt = 0; $attempt -lt 20; $attempt += 1) {
        try {
            Remove-Item -LiteralPath $canonicalRoot -Recurse -Force
            return
        }
        catch {
            if ($attempt -eq 19) { throw }
            Start-Sleep -Milliseconds 250
        }
    }
}

function Start-IsolatedRuntime([string]$QaRoot) {
    $rootExisted = Test-Path Env:YUANYUAN_RUNTIME_QA_ROOT
    $profileExisted = Test-Path Env:YUANYUAN_RUNTIME_QA_PROFILE
    $exitExisted = Test-Path Env:YUANYUAN_RUNTIME_QA_EXIT_AFTER_SECONDS
    $oldRoot = $env:YUANYUAN_RUNTIME_QA_ROOT
    $oldProfile = $env:YUANYUAN_RUNTIME_QA_PROFILE
    $oldExit = $env:YUANYUAN_RUNTIME_QA_EXIT_AFTER_SECONDS
    try {
        $env:YUANYUAN_RUNTIME_QA_ROOT = $QaRoot
        $env:YUANYUAN_RUNTIME_QA_PROFILE = "baseline-ai-off"
        $env:YUANYUAN_RUNTIME_QA_EXIT_AFTER_SECONDS = "30"
        return Start-Process -FilePath $appPath -PassThru
    }
    finally {
        Restore-EnvironmentValue "YUANYUAN_RUNTIME_QA_ROOT" $oldRoot $rootExisted
        Restore-EnvironmentValue "YUANYUAN_RUNTIME_QA_PROFILE" $oldProfile $profileExisted
        Restore-EnvironmentValue "YUANYUAN_RUNTIME_QA_EXIT_AFTER_SECONDS" $oldExit $exitExisted
    }
}

function Stop-ExactQaProcess([Diagnostics.Process]$Process) {
    if ($null -eq $Process) { return $true }
    $Process.Refresh()
    if ($Process.HasExited) { return $true }
    $owned = Get-Process -Id $Process.Id -ErrorAction Stop
    if ($owned.Path -ne $appPath) {
        throw "refusing to stop a process outside the runtime QA executable"
    }
    Stop-Process -Id $Process.Id -Force
    Wait-Process -Id $Process.Id -Timeout 10 -ErrorAction SilentlyContinue
    $Process.Refresh()
    return $Process.HasExited
}

function Measure-OneStartup([string]$QaRoot, [int]$SampleNumber) {
    $process = $null
    try {
        $timer = [Diagnostics.Stopwatch]::StartNew()
        $process = Start-IsolatedRuntime $QaRoot
        $deadline = [DateTime]::UtcNow.AddSeconds(30)
        $startupMilliseconds = $null
        while ([DateTime]::UtcNow -lt $deadline) {
            $process.Refresh()
            if ($process.HasExited) { throw "runtime QA process exited before creating a window" }
            if ([YuanyuanStartupWindowProbe]::HasVisibleWindow($process.Id)) {
                $startupMilliseconds = [Math]::Round($timer.Elapsed.TotalMilliseconds, 1)
                break
            }
            Start-Sleep -Milliseconds 25
        }
        if ($null -eq $startupMilliseconds) {
            throw "runtime QA window was not visible within 30 seconds"
        }
        if (-not (Stop-ExactQaProcess $process)) {
            throw "runtime QA process did not stop after the measurement target"
        }
        return [ordered]@{
            sample = $SampleNumber
            startupToVisibleWindowMilliseconds = $startupMilliseconds
            terminatedAfterTarget = $true
            passed = $true
            failure = $null
        }
    }
    catch {
        return [ordered]@{
            sample = $SampleNumber
            startupToVisibleWindowMilliseconds = $null
            terminatedAfterTarget = $false
            passed = $false
            failure = $_.Exception.Message
        }
    }
    finally {
        try { $null = Stop-ExactQaProcess $process } catch {}
        Start-Sleep -Milliseconds 400
    }
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

$lockPath = Join-Path $evidenceRoot "startup-$StartupMode.lock"
try {
    $lockStream = [IO.File]::Open(
        $lockPath,
        [IO.FileMode]::OpenOrCreate,
        [IO.FileAccess]::ReadWrite,
        [IO.FileShare]::None
    )
}
catch {
    throw "another startup measurement for this mode is already active"
}

$scriptExitCode = 0
$warmLeaf = "yuanyuan-runtime-qa-startup-$runId-$BuildVariant-warm"
$warmRoot = Join-Path $workspaceRoot $warmLeaf
$finalRootRemoved = $false
try {
    if ($StartupMode -eq "warm") {
        & $fixturePath --root $warmRoot --prepare-only
        if ($LASTEXITCODE -ne 0) { throw "warm runtime QA root preparation failed" }
        $warmup = Measure-OneStartup $warmRoot 0
        if (-not $warmup.passed) { throw "warm initialization launch failed: $($warmup.failure)" }
    }

    $samples = @()
    for ($index = 0; $index -lt $SampleCount; $index += 1) {
        $sampleNumber = $index + 1
        $leaf = if ($StartupMode -eq "warm") {
            $warmLeaf
        }
        else {
            "yuanyuan-runtime-qa-startup-$runId-$BuildVariant-cold-$sampleNumber"
        }
        $qaRoot = if ($StartupMode -eq "warm") { $warmRoot } else { Join-Path $workspaceRoot $leaf }
        if ($StartupMode -eq "cold") {
            & $fixturePath --root $qaRoot --prepare-only
            if ($LASTEXITCODE -ne 0) { throw "cold runtime QA root preparation failed" }
        }
        $inputDatabase = Get-DatabaseSnapshot $qaRoot
        $sample = Measure-OneStartup $qaRoot $sampleNumber
        $sample["inputDatabase"] = $inputDatabase
        $sample["outputDatabase"] = Get-DatabaseSnapshot $qaRoot
        if ($StartupMode -eq "cold") {
            Remove-OwnedQaRoot $qaRoot $leaf
            $sample["rootRemoved"] = -not (Test-Path -LiteralPath $qaRoot)
            if (-not $sample.rootRemoved) {
                $sample["passed"] = $false
                $sample["failure"] = "cold isolation root was not removed"
            }
        }
        else {
            $sample["rootRemoved"] = $null
        }
        $samples += [pscustomobject]$sample
    }

    if ($StartupMode -eq "warm") {
        Remove-OwnedQaRoot $warmRoot $warmLeaf
        $finalRootRemoved = -not (Test-Path -LiteralPath $warmRoot)
    }
    else {
        $finalRootRemoved = @($samples | Where-Object { $_.rootRemoved -ne $true }).Count -eq 0
    }
    $passed = @($samples | Where-Object passed)
    $latencies = [double[]]@($passed | ForEach-Object startupToVisibleWindowMilliseconds)
    $summary = [ordered]@{
        startupP50Ms = Get-Percentile $latencies 0.50
        startupP95Ms = Get-Percentile $latencies 0.95
    }
    $gateFailures = @()
    if ($BaselineGate) {
        if ($SampleCount -lt $minimumSamples) { $gateFailures += "baseline gate requires 20 samples" }
        if ($passed.Count -ne $SampleCount) { $gateFailures += "not all requested samples passed" }
        if (-not $finalRootRemoved) { $gateFailures += "isolation root cleanup failed" }
    }
    $gatePassed = $BaselineGate -and $gateFailures.Count -eq 0
    $sampleSetPassed = $passed.Count -eq $SampleCount
    $windowsVersion = Get-ItemProperty -LiteralPath "HKLM:\SOFTWARE\Microsoft\Windows NT\CurrentVersion"
    $report = [ordered]@{
        schemaVersion = 1
        generatedAt = [DateTimeOffset]::UtcNow.ToString("o")
        profile = "startup-matrix"
        buildVariant = $BuildVariant
        startupMode = $StartupMode
        requestedSamples = $SampleCount
        passedSamples = $passed.Count
        ready = $sampleSetPassed -and $finalRootRemoved -and ((-not $BaselineGate) -or $gatePassed)
        bindings = [ordered]@{
            applicationSha256 = (Get-FileHash -Algorithm SHA256 -LiteralPath $appPath).Hash
            fixtureSha256 = (Get-FileHash -Algorithm SHA256 -LiteralPath $fixturePath).Hash
            scriptSha256 = (Get-FileHash -Algorithm SHA256 -LiteralPath $PSCommandPath).Hash
        }
        device = [ordered]@{
            windowsProductName = $windowsVersion.ProductName
            windowsDisplayVersion = $windowsVersion.DisplayVersion
            windowsBuild = "$($windowsVersion.CurrentBuildNumber).$($windowsVersion.UBR)"
            processorArchitecture = [Environment]::GetEnvironmentVariable("PROCESSOR_ARCHITECTURE")
            logicalProcessors = [Environment]::ProcessorCount
            powerLineStatus = [string]([Windows.Forms.SystemInformation]::PowerStatus).PowerLineStatus
            webView2RuntimeVersion = Get-WebView2Version
        }
        baselineGate = [ordered]@{
            requested = [bool]$BaselineGate
            minimumSamples = $minimumSamples
            passed = if ($BaselineGate) { $gatePassed } else { $null }
            failures = $gateFailures
        }
        summary = $summary
        cleanup = [ordered]@{
            rootRemoved = $finalRootRemoved
        }
        samples = $samples
        limitations = @(
            "The application and fixture are isolated runtime-QA builds, not signed production candidates."
            "Cold mode uses a new application and WebView data root for every sample."
            "Warm mode performs one uncounted initialization launch and reuses its isolated data root."
            "Startup ends at the first visible application-owned top-level window."
            "The exact QA root process is terminated after the timing target; controlled-exit behavior is covered by separate runtime evidence."
            "This does not replace clean-machine, signed-candidate, security-software, or multi-DPI evidence."
        )
    }
    $report | ConvertTo-Json -Depth 8 | Set-Content -Encoding UTF8 -LiteralPath $reportPath
    Write-Output "Startup matrix report written: $reportPath"
    Write-Output (
        "Variant={0} Mode={1} Samples={2}/{3} P95={4}ms Ready={5}" -f
        $BuildVariant,
        $StartupMode,
        $passed.Count,
        $SampleCount,
        $summary.startupP95Ms,
        $report.ready
    )
    if (-not $report.ready) { $scriptExitCode = 2 }
}
finally {
    if (-not $finalRootRemoved -and (Test-Path -LiteralPath $warmRoot -PathType Container)) {
        Remove-OwnedQaRoot $warmRoot $warmLeaf
    }
    if ($null -ne $lockStream) { $lockStream.Dispose() }
    Remove-Item -LiteralPath $lockPath -Force -ErrorAction SilentlyContinue
}
exit $scriptExitCode
