[CmdletBinding()]
param()

$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

. (Join-Path $PSScriptRoot "assert_runtime_qa_exclusive.ps1")
Assert-YuanyuanRuntimeQaExclusive -Activity "Formal learning-on runtime baseline candidate preparation"

$projectRoot = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot "..")).Path
$targetRoot = Join-Path $projectRoot "src-tauri\target\runtime-qa-learning"
$expectedTargetRoot = [IO.Path]::GetFullPath((Join-Path $projectRoot "src-tauri\target\runtime-qa-learning"))
if ([IO.Path]::GetFullPath($targetRoot) -ne $expectedTargetRoot -or -not $expectedTargetRoot.StartsWith([IO.Path]::GetFullPath($projectRoot) + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase)) {
    throw "Runtime baseline target root is outside the project."
}

$sourceStatus = (& git -C $projectRoot status --porcelain=v1 --untracked-files=all | Out-String).Trim()
if ($LASTEXITCODE -ne 0) { throw "Unable to inspect the source checkout." }
if ($sourceStatus.Length -ne 0) { throw "Formal runtime baseline preparation requires a clean checkout." }

$buildStartedAt = [DateTimeOffset]::UtcNow
Push-Location (Join-Path $projectRoot "src-tauri")
try {
    & cargo clean -p yuanyuan-reminder --target-dir "target/runtime-qa-learning"
    if ($LASTEXITCODE -ne 0) { throw "Unable to clean the exact generated runtime package outputs." }
}
finally {
    Pop-Location
}

Push-Location $projectRoot
try {
    & npm.cmd run unified:ui:build
    if ($LASTEXITCODE -ne 0) { throw "The unified learning-on UI build failed." }
}
finally {
    Pop-Location
}

Push-Location (Join-Path $projectRoot "src-tauri")
try {
    & cargo build --locked --release --features "runtime-qa,learning,tauri/custom-protocol" --bin yuanyuan-reminder --bin yuanyuan-runtime-qa-fixture --bin yuanyuan-task-watch-fixture --target-dir "target/runtime-qa-learning"
    if ($LASTEXITCODE -ne 0) { throw "The locked learning-on runtime candidate build failed." }
}
finally {
    Pop-Location
}

$runId = [DateTimeOffset]::UtcNow.ToString("yyyyMMdd'T'HHmmss'Z'")
$outputPath = Join-Path $targetRoot "release\evidence\runtime-baseline-candidate-$runId.json"
& node (Join-Path $projectRoot "scripts\prepare_community_stable_runtime_baseline_candidate.mjs") --output $outputPath --build-started-at $buildStartedAt.ToString("o")
if ($LASTEXITCODE -ne 0) { throw "The learning-on runtime candidate binding failed." }

Write-Output "Run the formal 24-hour command without rebuilding or changing the bound files:"
Write-Output ('npm.cmd run runtime:baseline:acceptance -- -SourceBindingPath "{0}"' -f $outputPath)
Write-Output "Candidate binding: $outputPath"
