[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [ValidateSet("Initialize", "Capture", "ObserveDelete")]
    [string]$Mode,

    [Parameter(Mandatory = $true)]
    [string]$SessionId,

    [ValidateSet(
        "nsis_before",
        "msix_after",
        "backup_baseline",
        "backup_mutated",
        "backup_restored",
        "update_before",
        "update_after",
        "uninstall_keep_before",
        "uninstall_keep_reinstalled",
        "delete_before"
    )]
    [string]$Checkpoint,

    [switch]$ConfirmDisposableWindows11Environment,
    [switch]$AcknowledgeFreshTestAccount,
    [switch]$ConfirmSyntheticDataOnly,
    [switch]$ConfirmExplicitInAppDeleteCompleted
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$projectRoot = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot ".."))
$tauriRoot = Join-Path $projectRoot "src-tauri"
$evidenceRoot = Join-Path $tauriRoot "target\msix-store-data-lifecycle"
$storeReleaseManifestPath = Join-Path $tauriRoot "target\msix-store\msix-store-release-manifest.json"
$runtimeReportPath = Join-Path $tauriRoot "target\msix-store-runtime\msix-store-runtime-report.json"
$identityVerifierPath = Join-Path $projectRoot "scripts\verify_msix_store_identity.mjs"
$releaseManifestVerifierPath = Join-Path $projectRoot "scripts\generate_msix_store_release_manifest.mjs"
$runtimeVerifierPath = Join-Path $projectRoot "scripts\verify_msix_store_runtime.mjs"
$dataRoot = Join-Path ([Environment]::GetFolderPath("LocalApplicationData")) "com.yuanyuan.reminder"
$processName = "yuanyuan-reminder"

function Get-Sha256 {
    param([Parameter(Mandatory = $true)][string]$Path)
    return (Get-FileHash -Algorithm SHA256 -LiteralPath $Path).Hash
}

function Invoke-CheckedNode {
    param(
        [Parameter(Mandatory = $true)][string]$Script,
        [string[]]$Arguments = @()
    )
    & node $Script @Arguments
    if ($LASTEXITCODE -ne 0) {
        throw "Required Store verifier failed: $Script"
    }
}

if ($env:OS -ne "Windows_NT" -or [System.Environment]::OSVersion.Version.Build -lt 22000) {
    throw "Store data-lifecycle capture requires Windows 11"
}
if (-not [Environment]::UserInteractive) {
    throw "Store data-lifecycle capture requires an interactive Windows user session"
}
if (-not $ConfirmDisposableWindows11Environment) {
    throw "Pass -ConfirmDisposableWindows11Environment only inside a disposable Windows 11 VM or dedicated test machine"
}
if (-not $AcknowledgeFreshTestAccount) {
    throw "Pass -AcknowledgeFreshTestAccount only when this Windows account has never held real Yuanyuan data"
}
if (-not $ConfirmSyntheticDataOnly) {
    throw "Pass -ConfirmSyntheticDataOnly only after confirming every reminder, focus record, setting, and backup is synthetic"
}

$parsedSessionId = [Guid]::Empty
if (-not [Guid]::TryParse($SessionId, [ref]$parsedSessionId) -or $parsedSessionId -eq [Guid]::Empty) {
    throw "SessionId must be a non-empty UUID"
}
$normalizedSessionId = $parsedSessionId.ToString("D").ToLowerInvariant()

if ($Mode -eq "Capture" -and [string]::IsNullOrWhiteSpace($Checkpoint)) {
    throw "Capture mode requires one fixed -Checkpoint"
}
if ($Mode -ne "Capture" -and -not [string]::IsNullOrWhiteSpace($Checkpoint)) {
    throw "$Mode mode does not accept -Checkpoint"
}
if ($Mode -eq "ObserveDelete" -and -not $ConfirmExplicitInAppDeleteCompleted) {
    throw "ObserveDelete requires -ConfirmExplicitInAppDeleteCompleted after using the in-app delete-all flow"
}
if ($Mode -ne "ObserveDelete" -and $ConfirmExplicitInAppDeleteCompleted) {
    throw "-ConfirmExplicitInAppDeleteCompleted is valid only in ObserveDelete mode"
}

$runningProcesses = @(Get-Process -Name $processName -ErrorAction SilentlyContinue)
if ($runningProcesses.Count -ne 0) {
    throw "Yuanyuan is still running; exit the application before lifecycle evidence capture"
}
if ($Mode -eq "Initialize" -and (Test-Path -LiteralPath $dataRoot)) {
    throw "The fixed Yuanyuan data root already exists. Do not inspect or delete it here; switch to a fresh disposable Windows account"
}
if ($Mode -eq "Capture" -and -not (Test-Path -LiteralPath $dataRoot -PathType Container)) {
    throw "The initialized fixed Yuanyuan data root is missing"
}
if ($Mode -eq "ObserveDelete" -and (Test-Path -LiteralPath $dataRoot)) {
    throw "The fixed Yuanyuan data root still exists after the explicit in-app delete flow"
}

$identityPath = Join-Path $projectRoot "docs\release\MSIX_STORE_IDENTITY_V1.json"
Invoke-CheckedNode -Script $identityVerifierPath -Arguments @($identityPath)
$storeIdentity = Get-Content -Raw -Encoding UTF8 -LiteralPath $identityPath | ConvertFrom-Json
Invoke-CheckedNode -Script $releaseManifestVerifierPath -Arguments @("--check")
Invoke-CheckedNode -Script $runtimeVerifierPath

foreach ($requiredPath in @($storeReleaseManifestPath, $runtimeReportPath)) {
    if (-not (Test-Path -LiteralPath $requiredPath -PathType Leaf)) {
        throw "Required frozen Store evidence is missing: $requiredPath"
    }
}
$releaseManifest = Get-Content -Raw -Encoding UTF8 -LiteralPath $storeReleaseManifestPath | ConvertFrom-Json
$candidateSha256 = [string]$releaseManifest.candidate.sha256
$releaseManifestSha256 = Get-Sha256 -Path $storeReleaseManifestPath
$runtimeReportSha256 = Get-Sha256 -Path $runtimeReportPath

if ($Mode -ne "Initialize") {
    $sessionManifestPath = Join-Path (Join-Path $evidenceRoot $normalizedSessionId) "session.json"
    if (-not (Test-Path -LiteralPath $sessionManifestPath -PathType Leaf)) {
        throw "The immutable lifecycle session manifest is missing"
    }
    $sessionManifest = Get-Content -Raw -Encoding UTF8 -LiteralPath $sessionManifestPath | ConvertFrom-Json
    if (
        $sessionManifest.candidateSha256 -cne $candidateSha256 -or
        $sessionManifest.storeReleaseManifestSha256 -cne $releaseManifestSha256 -or
        $sessionManifest.runtimeReportSha256 -cne $runtimeReportSha256
    ) {
        throw "The Store candidate, release manifest, or runtime report drifted after session initialization"
    }
}
if ($Mode -eq "ObserveDelete") {
    $remainingPackages = @(Get-AppxPackage -Name $storeIdentity.package.identityName -ErrorAction SilentlyContinue)
    if ($remainingPackages.Count -ne 0) {
        throw "The Store package is still registered; uninstall it before the final delete-after observation"
    }
}

$qaArguments = @(
    "run",
    "--release",
    "--target-dir", "target/store-data-lifecycle-qa",
    "--features", "store-data-lifecycle-qa",
    "--bin", "yuanyuan-store-data-lifecycle-qa",
    "--"
)

switch ($Mode) {
    "Initialize" {
        $qaArguments += @(
            "initialize",
            "--session-id", $normalizedSessionId,
            "--candidate-sha256", $candidateSha256,
            "--store-release-manifest-sha256", $releaseManifestSha256,
            "--runtime-report-sha256", $runtimeReportSha256,
            "--attest-disposable-windows11",
            "--attest-synthetic-data-only"
        )
    }
    "Capture" {
        $qaArguments += @(
            "capture",
            "--session-id", $normalizedSessionId,
            "--checkpoint", $Checkpoint,
            "--attest-disposable-windows11",
            "--attest-synthetic-data-only",
            "--attest-application-fully-exited"
        )
    }
    "ObserveDelete" {
        $qaArguments += @(
            "observe-delete",
            "--session-id", $normalizedSessionId,
            "--attest-disposable-windows11",
            "--attest-synthetic-data-only",
            "--attest-application-fully-exited",
            "--attest-explicit-in-app-delete"
        )
    }
}

Push-Location $tauriRoot
try {
    & cargo @qaArguments
    if ($LASTEXITCODE -ne 0) {
        throw "Store data-lifecycle QA capture stopped without producing accepted evidence"
    }
}
finally {
    Pop-Location
}

Write-Output "Store data-lifecycle checkpoint completed for session $normalizedSessionId"
