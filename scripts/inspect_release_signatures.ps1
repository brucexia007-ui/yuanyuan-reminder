param(
    [Parameter(Mandatory = $true)]
    [string]$ManifestPath
)

$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"

$resolvedManifest = (Resolve-Path -LiteralPath $ManifestPath).Path
$releaseRoot = Split-Path -Parent $resolvedManifest
$manifest = Get-Content -Raw -Encoding UTF8 -LiteralPath $resolvedManifest | ConvertFrom-Json

$records = foreach ($artifact in $manifest.artifacts) {
    $artifactPath = Join-Path -Path $releaseRoot -ChildPath $artifact.path
    $signature = Get-AuthenticodeSignature -LiteralPath $artifactPath
    $signer = $signature.SignerCertificate
    $timestamp = $signature.TimeStamperCertificate

    [ordered]@{
        id = [string]$artifact.id
        status = [string]$signature.Status
        signerSubject = if ($null -eq $signer) { $null } else { [string]$signer.Subject }
        signerThumbprint = if ($null -eq $signer) { $null } else { [string]$signer.Thumbprint }
        signerNotBefore = if ($null -eq $signer) { $null } else { $signer.NotBefore.ToUniversalTime().ToString("o") }
        signerNotAfter = if ($null -eq $signer) { $null } else { $signer.NotAfter.ToUniversalTime().ToString("o") }
        timestampPresent = $null -ne $timestamp
        timestampSubject = if ($null -eq $timestamp) { $null } else { [string]$timestamp.Subject }
        timestampNotBefore = if ($null -eq $timestamp) { $null } else { $timestamp.NotBefore.ToUniversalTime().ToString("o") }
        timestampNotAfter = if ($null -eq $timestamp) { $null } else { $timestamp.NotAfter.ToUniversalTime().ToString("o") }
    }
}

@($records) | ConvertTo-Json -Depth 5 -Compress
