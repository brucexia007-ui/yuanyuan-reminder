param(
    [string]$OutputRoot = ""
)

$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"

$sourceCommit = "aaffe998e3bfe37e7c2dcd5a83a9bc69e9002b23"
$sourceVersion = "1.5.5"
$baselineVersion = "1.5.7"
$markerName = ".yuanyuan-windows-upgrade-baseline-v1"
$markerValue = "YUANYUAN_WINDOWS_UPGRADE_BASELINE_V1`n"
$productName = -join [char[]]@(0x5706, 0x5706, 0x63D0, 0x9192)
$projectRoot = Split-Path -Parent $PSScriptRoot
if ([string]::IsNullOrWhiteSpace($OutputRoot)) {
    $OutputRoot = Join-Path $projectRoot "src-tauri\target\windows-upgrade-baseline"
}
$outputRoot = [IO.Path]::GetFullPath($OutputRoot)
$baselineRoot = Join-Path $outputRoot "pre013-aaffe998e3bf-v1.5.7"
$sourceRoot = Join-Path $baselineRoot "source"
$cargoTargetRoot = Join-Path $baselineRoot "cargo-target"
$artifactRoot = Join-Path $baselineRoot "artifacts"
$reportPath = Join-Path $artifactRoot "baseline-metadata.json"
$markerPath = Join-Path $baselineRoot $markerName
$scriptPath = $MyInvocation.MyCommand.Path

function Get-Sha256([string]$Path) {
    $stream = [IO.File]::OpenRead($Path)
    $algorithm = [Security.Cryptography.SHA256]::Create()
    try {
        ([BitConverter]::ToString($algorithm.ComputeHash($stream))).Replace("-", "")
    }
    finally {
        $algorithm.Dispose()
        $stream.Dispose()
    }
}

function Get-BytesSha256([byte[]]$Bytes) {
    $algorithm = [Security.Cryptography.SHA256]::Create()
    try {
        ([BitConverter]::ToString($algorithm.ComputeHash($Bytes))).Replace("-", "")
    }
    finally {
        $algorithm.Dispose()
    }
}

function Test-BaselineCache {
    if (-not (Test-Path -LiteralPath $reportPath -PathType Leaf)) { return $false }
    try {
        $report = Get-Content -Raw -Encoding UTF8 -LiteralPath $reportPath | ConvertFrom-Json
        $installerPath = Join-Path $artifactRoot ([string]$report.installer.fileName)
        return $report.ready -eq $true -and
            $report.source.commit -eq $sourceCommit -and
            $report.source.originalVersion -eq $sourceVersion -and
            $report.source.effectiveVersion -eq $baselineVersion -and
            $report.builderScriptSha256 -eq (Get-Sha256 $scriptPath) -and
            (Test-Path -LiteralPath $installerPath -PathType Leaf) -and
            (Get-Sha256 $installerPath) -eq $report.installer.sha256
    }
    catch {
        return $false
    }
}

if (Test-BaselineCache) {
    Write-Output "Windows upgrade baseline is ready: $reportPath"
    exit 0
}

$compiledBaselineReady = $false
if (Test-Path -LiteralPath $baselineRoot) {
    $requiredPrefix = $outputRoot.TrimEnd('\') + '\'
    if (
        -not $baselineRoot.StartsWith($requiredPrefix, [StringComparison]::OrdinalIgnoreCase) -or
        -not (Test-Path -LiteralPath $markerPath -PathType Leaf) -or
        (Get-Content -Raw -Encoding UTF8 -LiteralPath $markerPath) -ne $markerValue
    ) {
        throw "refusing to replace an unowned Windows upgrade baseline directory"
    }
    $existingManifestPath = Join-Path $sourceRoot "product-version.json"
    $existingCorePath = Join-Path $cargoTargetRoot "release\yuanyuan-reminder.exe"
    $existingInstallers = @(
        Get-ChildItem -LiteralPath (Join-Path $cargoTargetRoot "release\bundle\nsis") -File -ErrorAction SilentlyContinue |
            Where-Object { $_.Name -like "*_1.5.7_x64-setup.exe" }
    )
    $compiledBaselineReady =
        (Test-Path -LiteralPath $existingManifestPath -PathType Leaf) -and
        ((Get-Content -Raw -Encoding UTF8 -LiteralPath $existingManifestPath | ConvertFrom-Json).version -eq $baselineVersion) -and
        (Test-Path -LiteralPath $existingCorePath -PathType Leaf) -and
        ([string](Get-Item -LiteralPath $existingCorePath).VersionInfo.ProductVersion -eq $baselineVersion) -and
        $existingInstallers.Count -eq 1 -and
        -not (Test-Path -LiteralPath (Join-Path $sourceRoot "node_modules"))
    if (-not $compiledBaselineReady) {
        Remove-Item -LiteralPath $baselineRoot -Recurse -Force
    }
}

if (-not $compiledBaselineReady) {
    New-Item -ItemType Directory -Path $baselineRoot | Out-Null
    [IO.File]::WriteAllText($markerPath, $markerValue, [Text.UTF8Encoding]::new($false))
    New-Item -ItemType Directory -Path $artifactRoot | Out-Null
    $archivePath = Join-Path $baselineRoot "source.zip"
    $gitExecutable = (Get-Command git.exe -ErrorAction Stop).Source
    & $gitExecutable `
        -c "safe.directory=$($projectRoot.Replace('\', '/'))" `
        -C $projectRoot `
        archive `
        --format=zip `
        --output=$archivePath `
        $sourceCommit
    if ($LASTEXITCODE -ne 0) { throw "failed to export the pre-013 source commit" }
    Expand-Archive -LiteralPath $archivePath -DestinationPath $sourceRoot
    Remove-Item -LiteralPath $archivePath -Force

    $manifestPath = Join-Path $sourceRoot "product-version.json"
    $manifest = Get-Content -Raw -Encoding UTF8 -LiteralPath $manifestPath | ConvertFrom-Json
    if (
        $manifest.productName -ne $productName -or
        $manifest.identifier -ne "com.yuanyuan.reminder" -or
        $manifest.version -ne $sourceVersion
    ) {
        throw "pre-013 source identity no longer matches the frozen baseline contract"
    }
    $manifest.version = $baselineVersion
    [IO.File]::WriteAllText(
        $manifestPath,
        (($manifest | ConvertTo-Json -Depth 12) + "`n"),
        [Text.UTF8Encoding]::new($false)
    )

    $repositorySource = Get-Content -Raw -Encoding UTF8 -LiteralPath (
        Join-Path $sourceRoot "src-tauri\src\repository.rs"
    )
    if (
        $repositorySource -notmatch 'maximum_schema_version = if cfg!\(feature = "learning"\) \{ 12 \} else \{ 11 \}' -or
        $repositorySource -notmatch '012_learning_invitation_attention\.sql' -or
        $repositorySource -match '013_meal_reminder_category\.sql'
    ) {
        throw "pre-013 source does not expose the required schema-12 boundary"
    }

    $nodeModulesSource = Join-Path $projectRoot "node_modules"
    $nodeModulesLink = Join-Path $sourceRoot "node_modules"
    if (-not (Test-Path -LiteralPath $nodeModulesSource -PathType Container)) {
        throw "workspace node_modules is required to build the isolated baseline offline"
    }
    New-Item -ItemType Junction -Path $nodeModulesLink -Target $nodeModulesSource | Out-Null
    $previousCargoTarget = $env:CARGO_TARGET_DIR
    $hadCargoTarget = Test-Path Env:CARGO_TARGET_DIR
    try {
        Push-Location $sourceRoot
        try {
            & node.exe "scripts\sync_unified_product_version.mjs" --write
            if ($LASTEXITCODE -ne 0) { throw "failed to synchronize the isolated baseline version" }
            $env:CARGO_TARGET_DIR = $cargoTargetRoot
            & npm.cmd run tauri build
            if ($LASTEXITCODE -ne 0) { throw "isolated pre-013 Windows baseline build failed" }
        }
        finally {
            Pop-Location
        }
    }
    finally {
        if ($hadCargoTarget) { $env:CARGO_TARGET_DIR = $previousCargoTarget }
        else { Remove-Item Env:CARGO_TARGET_DIR -ErrorAction SilentlyContinue }
        if (Test-Path -LiteralPath $nodeModulesLink) {
            [IO.Directory]::Delete($nodeModulesLink)
        }
    }
}

New-Item -ItemType Directory -Force -Path $artifactRoot | Out-Null

$installerCandidates = @(
    Get-ChildItem -LiteralPath (Join-Path $cargoTargetRoot "release\bundle\nsis") -File |
        Where-Object { $_.Name -like "*_1.5.7_x64-setup.exe" }
)
if ($installerCandidates.Count -ne 1) {
    throw "isolated baseline build did not produce exactly one 1.5.7 NSIS installer"
}
$builtCorePath = Join-Path $cargoTargetRoot "release\yuanyuan-reminder.exe"
if (
    -not (Test-Path -LiteralPath $builtCorePath -PathType Leaf) -or
    [string](Get-Item -LiteralPath $builtCorePath).VersionInfo.ProductVersion -ne $baselineVersion
) {
    throw "isolated baseline core does not expose ProductVersion 1.5.7"
}
$artifactInstallerPath = Join-Path $artifactRoot $installerCandidates[0].Name
Copy-Item -LiteralPath $installerCandidates[0].FullName -Destination $artifactInstallerPath
$buildCoreBytes = [IO.File]::ReadAllBytes($builtCorePath)
$buildCoreText = [Text.Encoding]::ASCII.GetString($buildCoreBytes)
$buildMarker = "__TAURI_BUNDLE_TYPE_VAR_UNK"
$installedMarker = "__TAURI_BUNDLE_TYPE_VAR_NSS"
$markerOffset = $buildCoreText.IndexOf($buildMarker, [StringComparison]::Ordinal)
if (
    $markerOffset -lt 0 -or
    $buildCoreText.IndexOf($buildMarker, $markerOffset + $buildMarker.Length, [StringComparison]::Ordinal) -ge 0
) {
    throw "isolated baseline core does not contain exactly one Tauri bundle marker"
}
$expectedInstalledCoreBytes = [byte[]]$buildCoreBytes.Clone()
$installedMarkerBytes = [Text.Encoding]::ASCII.GetBytes($installedMarker)
[Array]::Copy(
    $installedMarkerBytes,
    0,
    $expectedInstalledCoreBytes,
    $markerOffset,
    $installedMarkerBytes.Length
)
$expectedInstalledCoreSha256 = Get-BytesSha256 $expectedInstalledCoreBytes
$report = [ordered]@{
    schemaVersion = 1
    generatedAt = (Get-Date).ToUniversalTime().ToString("o")
    profile = "reconstructed-current-product-pre013-v1.5.7-baseline"
    source = [ordered]@{
        commit = $sourceCommit
        originalVersion = $sourceVersion
        effectiveVersion = $baselineVersion
        versionOverrideOnly = $true
        maximumReminderSchema = 12
        productName = $productName
        identifier = "com.yuanyuan.reminder"
    }
    installer = [ordered]@{
        fileName = [IO.Path]::GetFileName($artifactInstallerPath)
        bytes = [long](Get-Item -LiteralPath $artifactInstallerPath).Length
        sha256 = Get-Sha256 $artifactInstallerPath
        productVersion = [string](Get-Item -LiteralPath $artifactInstallerPath).VersionInfo.ProductVersion
    }
    installedCore = [ordered]@{
        bytes = [long](Get-Item -LiteralPath $builtCorePath).Length
        sha256 = $expectedInstalledCoreSha256
        buildCoreSha256 = Get-Sha256 $builtCorePath
        bundleType = "NSS"
        productVersion = [string](Get-Item -LiteralPath $builtCorePath).VersionInfo.ProductVersion
    }
    builderScriptSha256 = Get-Sha256 $scriptPath
    ready = $true
}
$report | ConvertTo-Json -Depth 12 | Set-Content -Encoding UTF8 -LiteralPath $reportPath
Write-Output "Windows upgrade baseline is ready: $reportPath"
