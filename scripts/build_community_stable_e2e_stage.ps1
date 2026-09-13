param(
    [string]$ReleaseRoot = "",
    [string]$StageRoot = ""
)

$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"
. (Join-Path $PSScriptRoot "assert_runtime_qa_exclusive.ps1")
Assert-YuanyuanRuntimeQaExclusive -Activity "Exact installed-candidate E2E staging"
$projectRoot = Split-Path -Parent $PSScriptRoot
$prepareScript = Join-Path $PSScriptRoot "prepare_community_stable_e2e_stage.mjs"
$buildStartedAt = (Get-Date).ToUniversalTime()

Push-Location $projectRoot
try {
    & npm.cmd run tauri build
    if ($LASTEXITCODE -ne 0) {
        throw "controlled Tauri build failed with exit code $LASTEXITCODE"
    }
    $arguments = @(
        $prepareScript,
        "--build-started-at",
        $buildStartedAt.ToString("o")
    )
    if (-not [string]::IsNullOrWhiteSpace($ReleaseRoot)) {
        $arguments += @("--release-root", $ReleaseRoot)
    }
    if (-not [string]::IsNullOrWhiteSpace($StageRoot)) {
        $arguments += @("--stage-root", $StageRoot)
    }
    $stageOutput = @(& node @arguments 2>&1)
    $stageExitCode = $LASTEXITCODE
    $stageOutput | ForEach-Object { Write-Output $_ }
    if ($stageExitCode -ne 0) {
        throw "exact candidate staging failed with exit code $stageExitCode"
    }

    $stageMarkerPrefix = "Community stable E2E stage created: "
    $stageMarkers = @(
        $stageOutput |
            ForEach-Object { [string]$_ } |
            Where-Object { $_.StartsWith($stageMarkerPrefix, [StringComparison]::Ordinal) }
    )
    if ($stageMarkers.Count -ne 1) {
        throw "exact candidate staging must emit exactly one stage path"
    }
    $stagedRoot = $stageMarkers[0].Substring($stageMarkerPrefix.Length)
    if ([string]::IsNullOrWhiteSpace($stagedRoot) -or -not [IO.Path]::IsPathRooted($stagedRoot)) {
        throw "exact candidate staging emitted an invalid stage path"
    }

    & node `
        (Join-Path $PSScriptRoot "verify_community_stable_e2e_stage.mjs") `
        --stage-root $stagedRoot
    if ($LASTEXITCODE -ne 0) {
        throw "exact candidate independent stage verification failed"
    }
}
finally {
    Pop-Location
}
