param(
    [string]$ManifestPath = ""
)

$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"

if ([string]::IsNullOrWhiteSpace($ManifestPath)) {
    $projectRoot = Split-Path -Parent $PSScriptRoot
    $ManifestPath = Join-Path $projectRoot "src-tauri\target\release\release-manifest.json"
}
$resolvedManifest = (Resolve-Path -LiteralPath $ManifestPath).Path
$releaseRoot = Split-Path -Parent $resolvedManifest
$outputPath = Join-Path $releaseRoot "defender-scan.json"
$manifest = Get-Content -Raw -Encoding UTF8 -LiteralPath $resolvedManifest | ConvertFrom-Json
$requiredIds = @("stable_core", "nsis_installed_core", "nsis_installer")
$artifacts = @($manifest.artifacts | Where-Object { $requiredIds -contains $_.id })
if ($artifacts.Count -ne $requiredIds.Count) {
    throw "release manifest does not contain the exact Defender scan targets"
}

$status = Get-MpComputerStatus
if (-not $status.AntivirusEnabled -or -not $status.AMServiceEnabled) {
    throw "Microsoft Defender Antivirus is not enabled"
}

$targets = foreach ($artifact in $artifacts) {
    $resolved = (Resolve-Path -LiteralPath (Join-Path $releaseRoot $artifact.path)).Path
    [ordered]@{
        id = [string]$artifact.id
        sha256 = [string]$artifact.sha256
        path = $resolved
    }
}

foreach ($target in $targets) {
    Start-MpScan -ScanType CustomScan -ScanPath $target.path
}

$detections = @(Get-MpThreatDetection)
$matches = foreach ($detection in $detections) {
    $resources = @($detection.Resources | ForEach-Object { [string]$_ })
    $matchedTarget = $targets | Where-Object {
        $candidate = $_.path
        $resources | Where-Object { $_.IndexOf($candidate, [StringComparison]::OrdinalIgnoreCase) -ge 0 }
    } | Select-Object -First 1
    if ($null -ne $matchedTarget) {
        [ordered]@{
            targetId = [string]$matchedTarget.id
            threatId = [string]$detection.ThreatID
            actionSuccess = [bool]$detection.ActionSuccess
        }
    }
}

$report = [ordered]@{
    schemaVersion = 1
    scannedAt = (Get-Date).ToUniversalTime().ToString("o")
    candidateSha256 = [string]($artifacts | Where-Object { $_.id -eq "nsis_installer" }).sha256
    defender = [ordered]@{
        antivirusEnabled = [bool]$status.AntivirusEnabled
        realTimeProtectionEnabled = [bool]$status.RealTimeProtectionEnabled
        engineVersion = [string]$status.AMEngineVersion
        productVersion = [string]$status.AMProductVersion
        signatureVersion = [string]$status.AntivirusSignatureVersion
        signatureLastUpdated = $status.AntivirusSignatureLastUpdated.ToUniversalTime().ToString("o")
    }
    artifacts = @($targets | ForEach-Object {
        [ordered]@{ id = $_.id; sha256 = $_.sha256 }
    })
    detections = @($matches)
    verified = @($matches).Count -eq 0
}

$report | ConvertTo-Json -Depth 6 | Set-Content -Encoding UTF8 -LiteralPath $outputPath
Write-Output "Defender report written: $outputPath"
if (-not $report.verified) { exit 2 }
