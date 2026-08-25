param(
    [ValidateRange(1, 20)]
    [int]$SmallSampleCount = 2,

    [ValidateRange(1, 10)]
    [int]$LargeSampleCount = 1,

    [switch]$BaselineGate
)

$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"
$projectRoot = Split-Path -Parent $PSScriptRoot
$targetRoot = Join-Path $projectRoot "src-tauri\target\learning-pack-spike\release"
$binaryPath = Join-Path $targetRoot "yuanyuan-learning-pack-spike.exe"
$evidenceRoot = Join-Path $targetRoot "evidence"
$fixtureRoot = Join-Path $evidenceRoot "fixtures"
$runId = (Get-Date).ToUniversalTime().ToString("yyyyMMddTHHmmssZ")
$reportPath = Join-Path $evidenceRoot "learning-pack-parse-spike-$runId.json"
$maximumPackageBytes = 26214400
$minimumNearLimitPackageBytes = 25900000
$maximumCards = 20000
$progressCardInterval = 256
$progressByteInterval = 4194304
$progressValueInterval = 16384
$controlDecodeByteInterval = 16384
$controlItemByteInterval = 16384
$maximumProgressCallbacks = 256
$gateSmallSamples = 10
$gateLargeSamples = 5
$candidateLimits = [ordered]@{
    internalParseP95Milliseconds = 1000.0
    processWallP95Milliseconds = 2000.0
    peakWorkingSetBytes = 536870912
}

if ($BaselineGate) {
    if ($SmallSampleCount -lt $gateSmallSamples) {
        throw "baseline gate requires at least 10 samples for 4,533-card fixtures"
    }
    if ($LargeSampleCount -lt $gateLargeSamples) {
        throw "baseline gate requires at least 5 samples for 20,000-card fixtures"
    }
}
if (-not (Test-Path -LiteralPath $binaryPath -PathType Leaf)) {
    throw "spike binary is missing; build the isolated release target first"
}
New-Item -ItemType Directory -Force -Path $fixtureRoot | Out-Null
Add-Type -AssemblyName System.Windows.Forms

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
    finally { $algorithm.Dispose() }
}

function Get-Percentile([double[]]$Values, [double]$Fraction) {
    if ($Values.Count -eq 0) { return $null }
    $ordered = @($Values | Sort-Object)
    $index = [Math]::Max(0, [Math]::Ceiling($Fraction * $ordered.Count) - 1)
    return [Math]::Round([double]$ordered[$index], 3)
}

function Quote-ProcessArgument([string]$Value) {
    if ($Value.Contains('"')) { throw "spike arguments cannot contain quotes" }
    return '"' + $Value + '"'
}

function Invoke-SpikeProcess([string[]]$Arguments) {
    $startInfo = [System.Diagnostics.ProcessStartInfo]::new()
    $startInfo.FileName = $binaryPath
    $startInfo.UseShellExecute = $false
    $startInfo.CreateNoWindow = $true
    $startInfo.RedirectStandardOutput = $true
    $startInfo.RedirectStandardError = $true
    $startInfo.Arguments = ($Arguments | ForEach-Object { Quote-ProcessArgument $_ }) -join " "
    $process = [System.Diagnostics.Process]::new()
    $process.StartInfo = $startInfo
    $timer = [System.Diagnostics.Stopwatch]::StartNew()
    if (-not $process.Start()) { throw "spike process did not start" }
    $stdout = $process.StandardOutput.ReadToEnd()
    $stderr = $process.StandardError.ReadToEnd()
    $process.WaitForExit()
    $timer.Stop()
    $process.Refresh()
    return [pscustomobject]@{
        ExitCode = $process.ExitCode
        StandardOutput = $stdout.Trim()
        StandardError = $stderr.Trim()
        WallMilliseconds = [Math]::Round($timer.Elapsed.TotalMilliseconds, 3)
        CpuMilliseconds = [Math]::Round($process.TotalProcessorTime.TotalMilliseconds, 3)
        PeakWorkingSetBytes = [long]$process.PeakWorkingSet64
        PeakPagedMemoryBytes = [long]$process.PeakPagedMemorySize64
    }
}

function New-SyntheticFixture([string]$Format, [int]$CardCount, [string]$Path) {
    $command = if ($CardCount -eq $maximumCards) {
        if ($Format -eq "json") { "generate-json-near-limit" } else { "generate-csv-near-limit" }
    }
    else {
        if ($Format -eq "json") { "generate-json" } else { "generate-csv" }
    }
    $result = Invoke-SpikeProcess @($command, $Path, [string]$CardCount)
    if ($result.ExitCode -ne 0) {
        throw "synthetic $Format fixture generation failed: $($result.StandardError)"
    }
    if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) {
        throw "synthetic fixture was not created"
    }
}

function Invoke-ParseSample(
    [string]$Format,
    [int]$CardCount,
    [string]$FixturePath,
    [int]$SampleNumber
) {
    $arguments = if ($Format -eq "json") {
        @("parse-json", $FixturePath)
    }
    else {
        @("parse-csv", $FixturePath, "synthetic.performance.csv", "Synthetic-CSV")
    }
    $processResult = Invoke-SpikeProcess $arguments
    $sample = [ordered]@{
        format = $Format
        cardCount = $CardCount
        sample = $SampleNumber
        exitCode = $processResult.ExitCode
        wallMilliseconds = $processResult.WallMilliseconds
        cpuMilliseconds = $processResult.CpuMilliseconds
        workingSetBytes = $null
        peakWorkingSetBytes = $null
        privateMemoryBytes = $null
        peakPrivateMemoryBytes = $null
        internalParseMilliseconds = $null
        progressCallbacks = $null
        progressCardInterval = $null
        progressByteInterval = $null
        progressValueInterval = $null
        controlDecodeByteInterval = $null
        controlItemByteInterval = $null
        progressPhaseCounts = $null
        finalProgressPhase = $null
        finalProgressUnit = $null
        finalProgressCompletedUnits = $null
        finalProgressTotalUnits = $null
        reportedFileBytes = $null
        reportedFileSha256 = $null
        contentSha256 = $null
        databaseWrites = $null
        passed = $false
        failure = $null
    }
    try {
        if ($processResult.ExitCode -ne 0) {
            throw "parser exited with code $($processResult.ExitCode): $($processResult.StandardError)"
        }
        $payload = $processResult.StandardOutput | ConvertFrom-Json
        if (
            $payload.schemaVersion -ne 6 -or
            $payload.mode -ne $Format -or
            $payload.parserVersion -ne "pre-gen-spike-7" -or
            $payload.cardCount -ne $CardCount -or
            $payload.databaseWrites -ne 0
        ) {
            throw "parser result identity is invalid"
        }
        $sample.internalParseMilliseconds = [Math]::Round(
            [double]$payload.elapsedMicroseconds / 1000.0,
            3
        )
        $sample.progressCallbacks = [int]$payload.progressCallbacks
        $sample.progressCardInterval = [int]$payload.progressCardInterval
        $sample.progressByteInterval = [int]$payload.progressByteInterval
        $sample.progressValueInterval = [int]$payload.progressValueInterval
        $sample.controlDecodeByteInterval = [int]$payload.controlDecodeByteInterval
        $sample.controlItemByteInterval = [int]$payload.controlItemByteInterval
        $sample.progressPhaseCounts = [ordered]@{
            readingInput = [int]$payload.progressPhaseCounts.readingInput
            validatingInput = [int]$payload.progressPhaseCounts.validatingInput
            validatingText = [int]$payload.progressPhaseCounts.validatingText
            scanningSyntax = [int]$payload.progressPhaseCounts.scanningSyntax
            decoding = [int]$payload.progressPhaseCounts.decoding
            validatingStructure = [int]$payload.progressPhaseCounts.validatingStructure
            validatingCards = [int]$payload.progressPhaseCounts.validatingCards
            finalizing = [int]$payload.progressPhaseCounts.finalizing
            complete = [int]$payload.progressPhaseCounts.complete
        }
        $sample.finalProgressPhase = [string]$payload.finalProgress.phase
        $sample.finalProgressUnit = [string]$payload.finalProgress.unit
        $sample.finalProgressCompletedUnits = [int]$payload.finalProgress.completedUnits
        $sample.finalProgressTotalUnits = [int]$payload.finalProgress.totalUnits
        $phaseCallbackTotal = [int](
            $sample.progressPhaseCounts.readingInput +
            $sample.progressPhaseCounts.validatingInput +
            $sample.progressPhaseCounts.validatingText +
            $sample.progressPhaseCounts.scanningSyntax +
            $sample.progressPhaseCounts.decoding +
            $sample.progressPhaseCounts.validatingStructure +
            $sample.progressPhaseCounts.validatingCards +
            $sample.progressPhaseCounts.finalizing +
            $sample.progressPhaseCounts.complete
        )
        if (
            $sample.progressCallbacks -le 0 -or
            $sample.progressCallbacks -gt $maximumProgressCallbacks -or
            $sample.progressCallbacks -ne $phaseCallbackTotal -or
            $sample.progressCardInterval -ne $progressCardInterval -or
            $sample.progressByteInterval -ne $progressByteInterval -or
            $sample.progressValueInterval -ne $progressValueInterval -or
            $sample.controlDecodeByteInterval -ne $controlDecodeByteInterval -or
            $sample.controlItemByteInterval -ne $controlItemByteInterval -or
            $sample.progressPhaseCounts.readingInput -lt 2 -or
            $sample.progressPhaseCounts.validatingInput -lt 2 -or
            $sample.progressPhaseCounts.validatingText -lt 2 -or
            $sample.progressPhaseCounts.decoding -lt 2 -or
            $sample.progressPhaseCounts.validatingStructure -lt 1 -or
            $sample.progressPhaseCounts.validatingCards -lt 1 -or
            $sample.progressPhaseCounts.finalizing -lt 2 -or
            $sample.progressPhaseCounts.complete -ne 1 -or
            ($Format -eq "json" -and $sample.progressPhaseCounts.scanningSyntax -lt 2) -or
            ($Format -eq "csv" -and $sample.progressPhaseCounts.scanningSyntax -ne 0) -or
            $sample.finalProgressPhase -ne "complete" -or
            $sample.finalProgressUnit -ne "cards" -or
            $sample.finalProgressCompletedUnits -ne $CardCount -or
            $sample.finalProgressTotalUnits -ne $CardCount
        ) {
            throw "parser cooperative progress result is invalid"
        }
        $sample.reportedFileBytes = [long]$payload.fileBytes
        $sample.reportedFileSha256 = ([string]$payload.fileSha256).ToUpperInvariant()
        $sample.contentSha256 = ([string]$payload.contentSha256).ToUpperInvariant()
        $sample.databaseWrites = [int]$payload.databaseWrites
        $sample.workingSetBytes = [long]$payload.workingSetBytes
        $sample.peakWorkingSetBytes = [long]$payload.peakWorkingSetBytes
        $sample.privateMemoryBytes = [long]$payload.privateMemoryBytes
        $sample.peakPrivateMemoryBytes = [long]$payload.peakPrivateMemoryBytes
        if (
            $sample.workingSetBytes -le 0 -or
            $sample.peakWorkingSetBytes -lt $sample.workingSetBytes -or
            $sample.privateMemoryBytes -le 0 -or
            $sample.peakPrivateMemoryBytes -lt $sample.privateMemoryBytes
        ) {
            throw "parser process memory counters are invalid"
        }
        $sample.passed = $true
    }
    catch {
        $sample.failure = $_.Exception.Message
    }
    return [pscustomobject]$sample
}

function Get-CaseSummary([object[]]$Samples) {
    $passed = @($Samples | Where-Object passed)
    $internal = [double[]]@($passed | ForEach-Object internalParseMilliseconds)
    $wall = [double[]]@($passed | ForEach-Object wallMilliseconds)
    $working = [double[]]@($passed | ForEach-Object peakWorkingSetBytes)
    $private = [double[]]@($passed | ForEach-Object peakPrivateMemoryBytes)
    return [ordered]@{
        format = $Samples[0].format
        cardCount = $Samples[0].cardCount
        requestedSamples = $Samples.Count
        passedSamples = $passed.Count
        internalParseP50Milliseconds = Get-Percentile $internal 0.50
        internalParseP95Milliseconds = Get-Percentile $internal 0.95
        processWallP50Milliseconds = Get-Percentile $wall 0.50
        processWallP95Milliseconds = Get-Percentile $wall 0.95
        peakWorkingSetBytes = if ($working.Count) { [long](($working | Measure-Object -Maximum).Maximum) } else { $null }
        peakPrivateMemoryBytes = if ($private.Count) { [long](($private | Measure-Object -Maximum).Maximum) } else { $null }
    }
}

$lockPath = Join-Path $evidenceRoot "learning-pack-parse-spike.lock"
try {
    $lockStream = [System.IO.File]::Open(
        $lockPath,
        [System.IO.FileMode]::OpenOrCreate,
        [System.IO.FileAccess]::ReadWrite,
        [System.IO.FileShare]::None
    )
}
catch { throw "another learning pack parse measurement is active" }

$scriptExitCode = 0
try {
    $cases = @(
        [pscustomobject]@{ Format = "json"; CardCount = 4533; Samples = $SmallSampleCount },
        [pscustomobject]@{ Format = "csv"; CardCount = 4533; Samples = $SmallSampleCount },
        [pscustomobject]@{ Format = "json"; CardCount = 20000; Samples = $LargeSampleCount },
        [pscustomobject]@{ Format = "csv"; CardCount = 20000; Samples = $LargeSampleCount }
    )
    $fixtures = @()
    foreach ($case in $cases) {
        $fixturePath = Join-Path $fixtureRoot (
            "synthetic-{0}-{1}.{0}" -f $case.Format, $case.CardCount
        )
        New-SyntheticFixture $case.Format $case.CardCount $fixturePath
        $fixture = Get-Item -LiteralPath $fixturePath
        if ($fixture.Length -gt $maximumPackageBytes) {
            throw "generated fixture exceeds the frozen byte budget"
        }
        if ($case.CardCount -eq $maximumCards -and $fixture.Length -lt $minimumNearLimitPackageBytes) {
            throw "generated 20,000-card fixture is not close enough to the frozen byte budget"
        }
        $fixtures += [pscustomobject][ordered]@{
            format = $case.Format
            cardCount = $case.CardCount
            path = $fixture.Name
            bytes = [long]$fixture.Length
            sha256 = Get-FileSha256 $fixture.FullName
        }
    }

    $samples = @()
    foreach ($case in $cases) {
        $fixture = $fixtures | Where-Object {
            $_.format -eq $case.Format -and $_.cardCount -eq $case.CardCount
        }
        $fixturePath = Join-Path $fixtureRoot $fixture.path
        $null = Invoke-ParseSample $case.Format $case.CardCount $fixturePath 0
        for ($index = 1; $index -le $case.Samples; $index += 1) {
            $samples += Invoke-ParseSample $case.Format $case.CardCount $fixturePath $index
        }
    }
    $summaries = @()
    foreach ($case in $cases) {
        $caseSamples = @($samples | Where-Object {
            $_.format -eq $case.Format -and $_.cardCount -eq $case.CardCount
        })
        $summaries += [pscustomobject](Get-CaseSummary $caseSamples)
    }

    $databaseFiles = @(Get-ChildItem -LiteralPath $evidenceRoot -Recurse -File | Where-Object {
        $_.Name -match '\.sqlite3($|-wal$|-shm$)'
    })
    $gateFailures = [System.Collections.Generic.List[string]]::new()
    if ($BaselineGate) {
        if (@($samples | Where-Object { -not $_.passed }).Count -ne 0) {
            $gateFailures.Add("one_or_more_parser_samples_failed")
        }
        if ($databaseFiles.Count -ne 0 -or @($samples | Where-Object databaseWrites -ne 0).Count -ne 0) {
            $gateFailures.Add("pure_parser_database_write_boundary_failed")
        }
        foreach ($summary in $summaries) {
            if ($summary.passedSamples -ne $summary.requestedSamples) {
                $gateFailures.Add("sample_count_incomplete_$($summary.format)_$($summary.cardCount)")
            }
            if ($summary.internalParseP95Milliseconds -gt $candidateLimits.internalParseP95Milliseconds) {
                $gateFailures.Add("internal_parse_p95_limit_$($summary.format)_$($summary.cardCount)")
            }
            if ($summary.processWallP95Milliseconds -gt $candidateLimits.processWallP95Milliseconds) {
                $gateFailures.Add("process_wall_p95_limit_$($summary.format)_$($summary.cardCount)")
            }
            if ($summary.peakWorkingSetBytes -gt $candidateLimits.peakWorkingSetBytes) {
                $gateFailures.Add("peak_working_set_limit_$($summary.format)_$($summary.cardCount)")
            }
        }
    }
    $gatePassed = $BaselineGate -and $gateFailures.Count -eq 0
    $sampleSetPassed = @($samples | Where-Object passed).Count -eq $samples.Count
    $ready = $sampleSetPassed -and $databaseFiles.Count -eq 0 -and (
        (-not $BaselineGate) -or $gatePassed
    )
    $windowsVersion = Get-ItemProperty -LiteralPath "HKLM:\SOFTWARE\Microsoft\Windows NT\CurrentVersion"
    $gitCommit = (& git -C $projectRoot rev-parse HEAD).Trim()
    $gitStatus = (& git -C $projectRoot status --porcelain=v1 --untracked-files=all) -join "`n"
    $report = [ordered]@{
        schemaVersion = 7
        generatedAt = [DateTimeOffset]::UtcNow.ToString("o")
        profile = "pre-gen-pure-parser-spike"
        scope = [ordered]@{
            databaseWritesAllowed = $false
            installAllowed = $false
            previewTokensAllowed = $false
            tauriCommandsRegistered = 0
            pack001Implementation = $false
        }
        source = [ordered]@{
            gitCommit = $gitCommit
            gitDirty = $gitStatus.Length -gt 0
            gitStatusSha256 = Get-StringSha256 $gitStatus
        }
        bindings = [ordered]@{
            binarySha256 = Get-FileSha256 $binaryPath
            librarySourceSha256 = Get-FileSha256 (Join-Path $projectRoot "src-tauri\crates\learning-pack-spike\src\lib.rs")
            binarySourceSha256 = Get-FileSha256 (Join-Path $projectRoot "src-tauri\crates\learning-pack-spike\src\main.rs")
            crateManifestSha256 = Get-FileSha256 (Join-Path $projectRoot "src-tauri\crates\learning-pack-spike\Cargo.toml")
            measurementScriptSha256 = Get-FileSha256 $PSCommandPath
        }
        device = [ordered]@{
            windowsProductName = $windowsVersion.ProductName
            windowsDisplayVersion = $windowsVersion.DisplayVersion
            windowsBuild = "$($windowsVersion.CurrentBuildNumber).$($windowsVersion.UBR)"
            processorArchitecture = [Environment]::GetEnvironmentVariable("PROCESSOR_ARCHITECTURE")
            processorIdentifier = [Environment]::GetEnvironmentVariable("PROCESSOR_IDENTIFIER")
            logicalProcessors = [Environment]::ProcessorCount
            powerLineStatus = [string]([System.Windows.Forms.SystemInformation]::PowerStatus).PowerLineStatus
        }
        request = [ordered]@{
            smallCardCount = 4533
            largeCardCount = $maximumCards
            smallSampleCount = $SmallSampleCount
            largeSampleCount = $LargeSampleCount
            baselineGateRequested = [bool]$BaselineGate
        }
        budgets = [ordered]@{
            maximumPackageBytes = $maximumPackageBytes
            minimumNearLimitPackageBytes = $minimumNearLimitPackageBytes
            maximumCards = $maximumCards
            maximumJsonDepth = 8
            progressCardInterval = $progressCardInterval
            progressByteInterval = $progressByteInterval
            progressValueInterval = $progressValueInterval
            controlDecodeByteInterval = $controlDecodeByteInterval
            controlItemByteInterval = $controlItemByteInterval
            maximumProgressCallbacks = $maximumProgressCallbacks
        }
        fixtures = $fixtures
        summaries = $summaries
        samples = $samples
        isolation = [ordered]@{
            databaseFileCount = $databaseFiles.Count
            allChildReportsDeclaredZeroDatabaseWrites = @(
                $samples | Where-Object databaseWrites -ne 0
            ).Count -eq 0
        }
        baselineGate = [ordered]@{
            requested = [bool]$BaselineGate
            minimumSmallSamples = $gateSmallSamples
            minimumLargeSamples = $gateLargeSamples
            candidateLimits = $candidateLimits
            passed = if ($BaselineGate) { $gatePassed } else { $null }
            failures = @($gateFailures)
        }
        ready = $ready
        limitations = @(
            "This is an authorized pre-GEN pure parser spike, not PACK-001 and not a public schema freeze."
            "The standalone release binary performs no database, preview-token, staging, install, Tauri command, WebView, or user-data operation."
            "Synthetic fixtures contain no personal learning content; 20,000-card cases are valid near-limit inputs between 25,900,000 bytes and the frozen 25 MiB ceiling."
            "Process-wall timing includes standalone process startup; internal timing covers bounded standalone file reading plus all pure-parser phases."
            "This evidence covers cooperative UI progress checkpoints between at most 4 MiB file reads and across preflight, chunk-safe UTF-8 validation, syntax scan, decoding, structure validation, card validation, and streaming finalization; separate lightweight cancel probes bound serde_json/csv decoder input consumption and cumulative per-item string security, Unicode normalization input, delimiter and optional-field scanning, bounded cloning, hashing, or canonical serialization work to at most 16 KiB between polls without adding UI progress events. It does not bound cancellation while the operating system is blocked inside one file read, and does not replace file-replacement/token semantics, Tauri background scheduling, IPC progress delivery, WebView responsiveness, database commit/growth, search pagination, token replay, half-install, or signed-candidate QA."
        )
    }
    $report | ConvertTo-Json -Depth 9 | Set-Content -LiteralPath $reportPath -Encoding UTF8
    Write-Output "Learning pack parser spike report written: $reportPath"
    foreach ($summary in $summaries) {
        Write-Output (
            "{0} {1} cards: {2}/{3}, parse P95={4}ms, wall P95={5}ms, peak WS={6}" -f
            $summary.format,
            $summary.cardCount,
            $summary.passedSamples,
            $summary.requestedSamples,
            $summary.internalParseP95Milliseconds,
            $summary.processWallP95Milliseconds,
            $summary.peakWorkingSetBytes
        )
    }
    Write-Output ("Ready={0} BaselineGatePassed={1}" -f $ready, $gatePassed)
    if (-not $ready) { $scriptExitCode = 2 }
}
finally {
    if ($null -ne $lockStream) { $lockStream.Dispose() }
    Remove-Item -LiteralPath $lockPath -Force -ErrorAction SilentlyContinue
}
exit $scriptExitCode
