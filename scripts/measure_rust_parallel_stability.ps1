param(
    [ValidateRange(1, 100)]
    [int]$DefaultRounds = 3,

    [ValidateRange(1, 100)]
    [int]$LearningRounds = 2,

    [ValidateRange(1, 64)]
    [int]$TestThreads = 24,

    [switch]$BaselineGate
)

$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"
$projectRoot = Split-Path -Parent $PSScriptRoot
$tauriRoot = Join-Path $projectRoot "src-tauri"
$evidenceRoot = Join-Path $tauriRoot "target\rust-parallel-stability\evidence"
$runId = (Get-Date).ToUniversalTime().ToString("yyyyMMddTHHmmssZ")
$reportPath = Join-Path $evidenceRoot "rust-parallel-stability-$runId.json"
$requiredDefaultRounds = 20
$requiredLearningRounds = 10
$requiredTestThreads = 24
$maximumP95Milliseconds = 10000.0
$limitations = @(
    "The scan exercises one Windows test process per round with 24 Rust test threads.",
    "The process-wide lock serializes WinVerifyTrust provider-state lifecycles and bounded MZ/e_lfanew/PE-signature preflight rejects non-PE files before WinVerifyTrust; the exact native fault instruction and module remain unknown because no crash dump or WER record was captured.",
    "Passing rounds demonstrate repeatability on this device and source state, not a proof that Windows native APIs can never fail.",
    "The supervisor unhealthy-child fixture uses a single PowerShell process so test cleanup does not leave a 30-second descendant."
)

if ($BaselineGate) {
    if ($DefaultRounds -lt $requiredDefaultRounds) {
        throw "baseline gate requires at least $requiredDefaultRounds default rounds"
    }
    if ($LearningRounds -lt $requiredLearningRounds) {
        throw "baseline gate requires at least $requiredLearningRounds learning rounds"
    }
    if ($TestThreads -ne $requiredTestThreads) {
        throw "baseline gate requires exactly $requiredTestThreads Rust test threads"
    }
}

New-Item -ItemType Directory -Force -Path $evidenceRoot | Out-Null

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

function Get-StringSha256([string]$Value) {
    $algorithm = [System.Security.Cryptography.SHA256]::Create()
    try {
        $bytes = [System.Text.Encoding]::UTF8.GetBytes($Value)
        return ([BitConverter]::ToString($algorithm.ComputeHash($bytes))).Replace("-", "")
    }
    finally {
        $algorithm.Dispose()
    }
}

function Get-Percentile([double[]]$Values, [double]$Fraction) {
    if ($Values.Count -eq 0) { return $null }
    $ordered = @($Values | Sort-Object)
    $index = [Math]::Max(0, [Math]::Ceiling($Fraction * $ordered.Count) - 1)
    return [Math]::Round([double]$ordered[$index], 3)
}

function Get-RelativeProjectPath([string]$Path) {
    $root = [System.IO.Path]::GetFullPath($projectRoot).TrimEnd("\") + "\"
    $fullPath = [System.IO.Path]::GetFullPath($Path)
    if (-not $fullPath.StartsWith($root, [System.StringComparison]::OrdinalIgnoreCase)) {
        throw "evidence binding path is outside the project root"
    }
    return $fullPath.Substring($root.Length).Replace("\", "/")
}

function Resolve-TestExecutable([bool]$LearningEnabled) {
    $arguments = @("test", "-p", "yuanyuan-reminder", "--lib")
    if ($LearningEnabled) {
        $arguments += @("--features", "learning")
    }
    $arguments += @("--no-run", "--message-format=json")
    $previousErrorActionPreference = $ErrorActionPreference
    Push-Location $tauriRoot
    try {
        $ErrorActionPreference = "Continue"
        $output = & cargo @arguments 2>&1
        $exitCode = $LASTEXITCODE
    }
    finally {
        $ErrorActionPreference = $previousErrorActionPreference
        Pop-Location
    }
    if ($exitCode -ne 0) {
        throw "cargo did not build the Rust library test executable"
    }
    $artifacts = @(
        $output |
            ForEach-Object {
                try { [string]$_ | ConvertFrom-Json } catch { $null }
            } |
            Where-Object {
                $_.reason -eq "compiler-artifact" -and
                $_.target.name -eq "yuanyuan_reminder_lib" -and
                $null -ne $_.executable
            }
    )
    if ($artifacts.Count -ne 1) {
        throw "cargo did not report exactly one Rust library test executable"
    }
    $path = [string]$artifacts[0].executable
    if (-not (Test-Path -LiteralPath $path -PathType Leaf)) {
        throw "Rust library test executable is missing"
    }
    return [System.IO.Path]::GetFullPath($path)
}

function Invoke-TestRound(
    [string]$Profile,
    [string]$Executable,
    [int]$Round
) {
    $startInfo = [System.Diagnostics.ProcessStartInfo]::new()
    $startInfo.FileName = $Executable
    $startInfo.WorkingDirectory = $tauriRoot
    $startInfo.UseShellExecute = $false
    $startInfo.CreateNoWindow = $true
    $startInfo.RedirectStandardOutput = $true
    $startInfo.RedirectStandardError = $true
    $startInfo.Arguments = "--test-threads $TestThreads"
    $process = [System.Diagnostics.Process]::new()
    $process.StartInfo = $startInfo
    $timer = [System.Diagnostics.Stopwatch]::StartNew()
    if (-not $process.Start()) {
        throw "$Profile Rust test process did not start"
    }
    $stdoutTask = $process.StandardOutput.ReadToEndAsync()
    $stderrTask = $process.StandardError.ReadToEndAsync()
    $process.WaitForExit()
    $stdout = $stdoutTask.GetAwaiter().GetResult()
    $stderr = $stderrTask.GetAwaiter().GetResult()
    $timer.Stop()
    $pattern = "(?m)^test result: (?<status>ok|FAILED)\. (?<passed>\d+) passed; (?<failed>\d+) failed; (?<ignored>\d+) ignored; (?<measured>\d+) measured; (?<filtered>\d+) filtered out; finished in (?<seconds>[0-9.]+)s\.?\r?$"
    $matches = [regex]::Matches($stdout, $pattern)
    if ($matches.Count -ne 1) {
        $stdoutBytes = [System.Text.Encoding]::UTF8.GetByteCount($stdout)
        $stderrBytes = [System.Text.Encoding]::UTF8.GetByteCount($stderr)
        $stdoutSha256 = Get-StringSha256 $stdout
        $stderrSha256 = Get-StringSha256 $stderr
        throw "$Profile round $Round did not emit exactly one Rust harness summary: exit=$($process.ExitCode) summaries=$($matches.Count) stdout_bytes=$stdoutBytes stderr_bytes=$stderrBytes stdout_sha256=$stdoutSha256 stderr_sha256=$stderrSha256"
    }
    $match = $matches[0]
    $resultLine = $match.Value.TrimEnd()
    $sample = [ordered]@{
        profile = $Profile
        round = $Round
        exitCode = $process.ExitCode
        wallMilliseconds = [Math]::Round($timer.Elapsed.TotalMilliseconds, 3)
        harnessSeconds = [Math]::Round([double]$match.Groups["seconds"].Value, 3)
        status = $match.Groups["status"].Value
        passed = [int]$match.Groups["passed"].Value
        failed = [int]$match.Groups["failed"].Value
        ignored = [int]$match.Groups["ignored"].Value
        measured = [int]$match.Groups["measured"].Value
        filteredOut = [int]$match.Groups["filtered"].Value
        resultLine = $resultLine
        resultLineSha256 = Get-StringSha256 $resultLine
        stderrSha256 = Get-StringSha256 $stderr
    }
    [Console]::WriteLine(("{0} round={1:D2} exit={2} duration_ms={3}" -f $Profile, $Round, $sample.exitCode, $sample.wallMilliseconds))
    return [pscustomobject]$sample
}

function Get-ProfileSummary([object[]]$Samples) {
    $wall = @($Samples | ForEach-Object { [double]$_.wallMilliseconds })
    $reference = $Samples[0]
    $failures = @(
        $Samples | Where-Object {
            $_.exitCode -ne 0 -or $_.status -ne "ok" -or $_.failed -ne 0
        }
    ).Count
    $consistentCounts = @(
        $Samples | Where-Object {
            $_.passed -ne $reference.passed -or
            $_.ignored -ne $reference.ignored -or
            $_.measured -ne $reference.measured -or
            $_.filteredOut -ne $reference.filteredOut
        }
    ).Count -eq 0
    return [ordered]@{
        rounds = $Samples.Count
        failures = $failures
        consistentCounts = $consistentCounts
        passedPerRound = $reference.passed
        ignoredPerRound = $reference.ignored
        measuredPerRound = $reference.measured
        filteredOutPerRound = $reference.filteredOut
        minimumWallMilliseconds = [Math]::Round(($wall | Measure-Object -Minimum).Minimum, 3)
        p50WallMilliseconds = Get-Percentile $wall 0.50
        p95WallMilliseconds = Get-Percentile $wall 0.95
        maximumWallMilliseconds = [Math]::Round(($wall | Measure-Object -Maximum).Maximum, 3)
    }
}

$defaultExecutable = Resolve-TestExecutable $false
$learningExecutable = Resolve-TestExecutable $true
$samples = @()
for ($round = 1; $round -le $DefaultRounds; $round++) {
    $samples += Invoke-TestRound "default" $defaultExecutable $round
}
for ($round = 1; $round -le $LearningRounds; $round++) {
    $samples += Invoke-TestRound "learning" $learningExecutable $round
}

$defaultSamples = @($samples | Where-Object profile -eq "default")
$learningSamples = @($samples | Where-Object profile -eq "learning")
$defaultSummary = Get-ProfileSummary $defaultSamples
$learningSummary = Get-ProfileSummary $learningSamples
$outcomesPassed =
    $defaultSummary.failures -eq 0 -and
    $learningSummary.failures -eq 0 -and
    $defaultSummary.consistentCounts -and
    $learningSummary.consistentCounts -and
    $defaultSummary.p95WallMilliseconds -le $maximumP95Milliseconds -and
    $learningSummary.p95WallMilliseconds -le $maximumP95Milliseconds
$formalGate =
    $BaselineGate -and
    $DefaultRounds -ge $requiredDefaultRounds -and
    $LearningRounds -ge $requiredLearningRounds -and
    $TestThreads -eq $requiredTestThreads

$report = [ordered]@{
    schemaVersion = 1
    generatedAt = (Get-Date).ToUniversalTime().ToString("o")
    profile = "rust-parallel-stability"
    bindings = [ordered]@{
        measurementScriptSha256 = Get-FileSha256 (Join-Path $projectRoot "scripts\measure_rust_parallel_stability.ps1")
        verifierSha256 = Get-FileSha256 (Join-Path $projectRoot "scripts\verify_rust_parallel_stability_evidence.mjs")
        windowsArtifactTrustSourceSha256 = Get-FileSha256 (Join-Path $projectRoot "src-tauri\src\windows_artifact_trust.rs")
        connectorToolTrustSourceSha256 = Get-FileSha256 (Join-Path $projectRoot "src-tauri\src\connector_tool_trust.rs")
        connectorDiscoverySourceSha256 = Get-FileSha256 (Join-Path $projectRoot "src-tauri\src\connector_discovery.rs")
        aiSupervisorSourceSha256 = Get-FileSha256 (Join-Path $projectRoot "src-tauri\src\ai_supervisor.rs")
        cargoLockSha256 = Get-FileSha256 (Join-Path $tauriRoot "Cargo.lock")
        defaultTestExecutablePath = Get-RelativeProjectPath $defaultExecutable
        defaultTestExecutableSha256 = Get-FileSha256 $defaultExecutable
        learningTestExecutablePath = Get-RelativeProjectPath $learningExecutable
        learningTestExecutableSha256 = Get-FileSha256 $learningExecutable
    }
    device = [ordered]@{
        windowsVersion = [System.Environment]::OSVersion.VersionString
        processArchitecture = [System.Runtime.InteropServices.RuntimeInformation]::ProcessArchitecture.ToString()
        logicalProcessors = [System.Environment]::ProcessorCount
    }
    request = [ordered]@{
        defaultRounds = $DefaultRounds
        learningRounds = $LearningRounds
        testThreads = $TestThreads
        baselineGate = [bool]$BaselineGate
    }
    gate = [ordered]@{
        requiredDefaultRounds = $requiredDefaultRounds
        requiredLearningRounds = $requiredLearningRounds
        requiredTestThreads = $requiredTestThreads
        maximumP95Milliseconds = $maximumP95Milliseconds
        formalGate = $formalGate
        outcomesPassed = $outcomesPassed
    }
    samples = $samples
    summary = [ordered]@{
        default = $defaultSummary
        learning = $learningSummary
    }
    ready = ($formalGate -and $outcomesPassed)
    limitations = $limitations
    failure = if ($outcomesPassed) { $null } else { "one or more Rust stability outcomes failed" }
}

$json = $report | ConvertTo-Json -Depth 10
[System.IO.File]::WriteAllText($reportPath, $json, [System.Text.UTF8Encoding]::new($true))
Write-Output "Rust parallel stability evidence: $reportPath"
Write-Output ("ready={0} default_p95_ms={1} learning_p95_ms={2}" -f $report.ready, $defaultSummary.p95WallMilliseconds, $learningSummary.p95WallMilliseconds)
if (-not $outcomesPassed) { exit 1 }
