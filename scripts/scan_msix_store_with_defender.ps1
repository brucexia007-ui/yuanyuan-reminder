[CmdletBinding()]
param()

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"

$projectRoot = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot ".."))
$targetRoot = [System.IO.Path]::GetFullPath((Join-Path $projectRoot "src-tauri\target\msix-store"))
$releaseManifestPath = Join-Path $targetRoot "msix-store-release-manifest.json"
$releaseManifestVerifierPath = Join-Path $projectRoot "scripts\generate_msix_store_release_manifest.mjs"
$reportPath = Join-Path $targetRoot "msix-store-defender-scan.json"

function Get-Sha256 {
    param([Parameter(Mandatory = $true)][string]$Path)
    return (Get-FileHash -Algorithm SHA256 -LiteralPath $Path).Hash
}

& node $releaseManifestVerifierPath --check
if ($LASTEXITCODE -ne 0) {
    throw "Store release-manifest verification failed before Defender scanning"
}
$releaseManifest = Get-Content -Raw -Encoding UTF8 -LiteralPath $releaseManifestPath | ConvertFrom-Json
$candidatePath = [System.IO.Path]::GetFullPath((Join-Path $projectRoot $releaseManifest.candidate.path))
$unpackRoot = Join-Path $targetRoot "unpacked"
if (-not (Test-Path -LiteralPath $candidatePath -PathType Leaf)) {
    throw "The Store candidate is missing"
}
if (-not (Test-Path -LiteralPath $unpackRoot -PathType Container)) {
    throw "The verified unpacked Store payload is missing"
}

$status = Get-MpComputerStatus
if (
    -not $status.AntivirusEnabled -or
    -not $status.AMServiceEnabled -or
    -not $status.RealTimeProtectionEnabled
) {
    throw "Microsoft Defender Antivirus and real-time protection must be enabled"
}
$signatureUpdatedAt = $status.AntivirusSignatureLastUpdated.ToUniversalTime()
$scanStartedAt = (Get-Date).ToUniversalTime()
if ($signatureUpdatedAt -gt $scanStartedAt.AddMinutes(5) -or $signatureUpdatedAt -lt $scanStartedAt.AddHours(-48)) {
    throw "Microsoft Defender security intelligence must be no more than 48 hours old"
}

Start-MpScan -ScanType CustomScan -ScanPath $candidatePath
Start-MpScan -ScanType CustomScan -ScanPath $unpackRoot
$scanFinishedAt = (Get-Date).ToUniversalTime()

$candidatePrefix = $candidatePath
$unpackPrefix = $unpackRoot.TrimEnd([System.IO.Path]::DirectorySeparatorChar) + [System.IO.Path]::DirectorySeparatorChar
$matchedDetections = @()
foreach ($detection in @(Get-MpThreatDetection)) {
    $resources = @($detection.Resources | ForEach-Object { [string]$_ })
    $matched = @($resources | Where-Object {
        $_.IndexOf($candidatePrefix, [System.StringComparison]::OrdinalIgnoreCase) -ge 0 -or
        $_.IndexOf($unpackPrefix, [System.StringComparison]::OrdinalIgnoreCase) -ge 0
    })
    if ($matched.Count -ne 0) {
        $matchedDetections += [ordered]@{
            threatId = [string]$detection.ThreatID
            actionSuccess = [bool]$detection.ActionSuccess
        }
    }
}

$targets = @(
    [ordered]@{
        id = "unsigned_store_candidate"
        path = [string]$releaseManifest.candidate.path
        bytes = [long]$releaseManifest.candidate.bytes
        sha256 = [string]$releaseManifest.candidate.sha256
    }
)
foreach ($payload in $releaseManifest.payload.files) {
    $targets += [ordered]@{
        id = "payload:$($payload.path)"
        path = "src-tauri/target/msix-store/unpacked/$($payload.path)"
        bytes = [long]$payload.bytes
        sha256 = [string]$payload.sha256
    }
}

$report = [ordered]@{
    schemaVersion = 1
    mode = "msix_store_defender_scan"
    scannedAt = $scanFinishedAt.ToString("o")
    environment = [ordered]@{
        antivirusEnabled = [bool]$status.AntivirusEnabled
        serviceEnabled = [bool]$status.AMServiceEnabled
        realTimeProtectionEnabled = [bool]$status.RealTimeProtectionEnabled
        engineVersion = [string]$status.AMEngineVersion
        productVersion = [string]$status.AMProductVersion
        signatureVersion = [string]$status.AntivirusSignatureVersion
        signatureLastUpdated = $signatureUpdatedAt.ToString("o")
        securityIntelligenceMaximumAgeHours = 48
    }
    bindings = [ordered]@{
        storeReleaseManifestSha256 = Get-Sha256 -Path $releaseManifestPath
        unsignedStoreCandidateSha256 = [string]$releaseManifest.candidate.sha256
        scannerSha256 = Get-Sha256 -Path $PSCommandPath
    }
    targets = $targets
    detections = @($matchedDetections)
    outcome = [ordered]@{
        candidateScanCompleted = $true
        unpackedPayloadScanCompleted = $true
        zeroDetections = $matchedDetections.Count -eq 0
        passed = $matchedDetections.Count -eq 0
    }
}
$report | ConvertTo-Json -Depth 10 | Set-Content -Encoding UTF8 -LiteralPath $reportPath
Write-Output "MSIX Store Defender report written: $reportPath"
if (-not $report.outcome.passed) {
    exit 2
}
