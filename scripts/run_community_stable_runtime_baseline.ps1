[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [string]$SourceBindingPath
)

$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"

. (Join-Path $PSScriptRoot "assert_runtime_qa_exclusive.ps1")
Assert-YuanyuanRuntimeQaExclusive -Activity "Formal learning-on 24-hour runtime baseline"

$projectRoot = Split-Path -Parent $PSScriptRoot
$sourceBindingPath = [IO.Path]::GetFullPath($SourceBindingPath)
$sourceCommit = (& git -C $projectRoot rev-parse HEAD).Trim()
if ($LASTEXITCODE -ne 0 -or $sourceCommit -notmatch "^[0-9a-f]{40}$") {
    throw "Formal learning-on runtime source commit could not be resolved."
}

& node `
    (Join-Path $PSScriptRoot "verify_community_stable_runtime_source_binding.mjs") `
    --binding $sourceBindingPath `
    --tested-commit $sourceCommit `
    --observed-at ([DateTimeOffset]::UtcNow.ToString("o"))
if ($LASTEXITCODE -ne 0) {
    throw "Formal learning-on runtime source binding verification failed before launch."
}

$measureOutput = @(
    & powershell.exe `
        -NoProfile `
        -NonInteractive `
        -ExecutionPolicy Bypass `
        -File (Join-Path $PSScriptRoot "measure_runtime_baseline.ps1") `
        -BuildVariant learning-on `
        -DurationSeconds 86400 `
        -SampleIntervalSeconds 60 `
        -WarmupSeconds 300 `
        -AcceptanceGate 2>&1
)
$measureExitCode = $LASTEXITCODE
$measureOutput | ForEach-Object { Write-Output $_ }
if ($measureExitCode -ne 0) {
    throw "Formal learning-on 24-hour runtime baseline failed with exit code $measureExitCode."
}

$reportMarkerPrefix = "Runtime baseline report written: "
$reportMarkers = @(
    $measureOutput |
        ForEach-Object { [string]$_ } |
        Where-Object { $_.StartsWith($reportMarkerPrefix, [StringComparison]::Ordinal) }
)
if ($reportMarkers.Count -ne 1) {
    throw "Formal learning-on runtime baseline must emit exactly one report path."
}
$reportPath = $reportMarkers[0].Substring($reportMarkerPrefix.Length)
if ([string]::IsNullOrWhiteSpace($reportPath) -or -not [IO.Path]::IsPathRooted($reportPath)) {
    throw "Formal learning-on runtime baseline emitted an invalid report path."
}

& node `
    (Join-Path $PSScriptRoot "verify_community_stable_runtime_baseline_candidate.mjs") `
    --binding $sourceBindingPath `
    --report $reportPath `
    --tested-commit $sourceCommit
if ($LASTEXITCODE -ne 0) {
    throw "Formal learning-on runtime baseline independent verification failed."
}
