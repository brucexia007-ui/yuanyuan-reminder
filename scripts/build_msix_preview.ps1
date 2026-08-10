[CmdletBinding()]
param(
    [switch]$SkipTauriBuild
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$projectRoot = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot ".."))
$targetRoot = [System.IO.Path]::GetFullPath((Join-Path $projectRoot "src-tauri\target\msix-preview"))
$msixCargoTargetRoot = [System.IO.Path]::GetFullPath((Join-Path $targetRoot "cargo-target"))
$stagingRoot = [System.IO.Path]::GetFullPath((Join-Path $targetRoot "staging"))
$unpackRoot = [System.IO.Path]::GetFullPath((Join-Path $targetRoot "unpacked"))
$packagePath = [System.IO.Path]::GetFullPath((Join-Path $targetRoot "YuanyuanReminder_1.4.0_x64-preview.msix"))
$reportPath = [System.IO.Path]::GetFullPath((Join-Path $targetRoot "msix-preview-report.json"))
$sourceManifestPath = Join-Path $projectRoot "src-tauri\msix\AppxManifest.preview.xml"
$sourceExecutablePath = Join-Path $msixCargoTargetRoot "release\yuanyuan-reminder.exe"
$sourceIconPath = Join-Path $projectRoot "src-tauri\icons\128x128@2x.png"
$releasePolicyPath = Join-Path $projectRoot "docs\release\RELEASE_POLICY_V1.json"

function Assert-OwnedGeneratedPath {
    param([Parameter(Mandatory = $true)][string]$Path)
    $resolved = [System.IO.Path]::GetFullPath($Path)
    $ownedPrefix = $targetRoot.TrimEnd([System.IO.Path]::DirectorySeparatorChar) + [System.IO.Path]::DirectorySeparatorChar
    if (-not $resolved.StartsWith($ownedPrefix, [System.StringComparison]::OrdinalIgnoreCase)) {
        throw "Refusing to modify a path outside the owned MSIX target: $resolved"
    }
}

function Reset-OwnedDirectory {
    param([Parameter(Mandatory = $true)][string]$Path)
    Assert-OwnedGeneratedPath -Path $Path
    if (Test-Path -LiteralPath $Path) {
        Remove-Item -LiteralPath $Path -Recurse -Force
    }
    New-Item -ItemType Directory -Path $Path -Force | Out-Null
}

function Get-Sha256 {
    param([Parameter(Mandatory = $true)][string]$Path)
    return (Get-FileHash -Algorithm SHA256 -LiteralPath $Path).Hash
}

function Copy-RequiredFile {
    param(
        [Parameter(Mandatory = $true)][string]$Source,
        [Parameter(Mandatory = $true)][string]$Destination
    )
    if (-not (Test-Path -LiteralPath $Source -PathType Leaf)) {
        throw "Required MSIX source file is missing: $Source"
    }
    $destinationDirectory = Split-Path -Parent $Destination
    New-Item -ItemType Directory -Path $destinationDirectory -Force | Out-Null
    Copy-Item -LiteralPath $Source -Destination $Destination -Force
}

function Resize-Png {
    param(
        [Parameter(Mandatory = $true)][string]$Source,
        [Parameter(Mandatory = $true)][string]$Destination,
        [Parameter(Mandatory = $true)][int]$Width,
        [Parameter(Mandatory = $true)][int]$Height
    )
    Add-Type -AssemblyName System.Drawing
    $sourceImage = [System.Drawing.Image]::FromFile($Source)
    try {
        $bitmap = New-Object System.Drawing.Bitmap($Width, $Height, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
        try {
            $graphics = [System.Drawing.Graphics]::FromImage($bitmap)
            try {
                $graphics.CompositingMode = [System.Drawing.Drawing2D.CompositingMode]::SourceCopy
                $graphics.CompositingQuality = [System.Drawing.Drawing2D.CompositingQuality]::HighQuality
                $graphics.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
                $graphics.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
                $graphics.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::HighQuality
                $graphics.DrawImage($sourceImage, 0, 0, $Width, $Height)
            }
            finally {
                $graphics.Dispose()
            }
            $bitmap.Save($Destination, [System.Drawing.Imaging.ImageFormat]::Png)
        }
        finally {
            $bitmap.Dispose()
        }
    }
    finally {
        $sourceImage.Dispose()
    }
}

function Find-MakeAppx {
    $sdkBinRoot = "C:\Program Files (x86)\Windows Kits\10\bin"
    if (-not (Test-Path -LiteralPath $sdkBinRoot -PathType Container)) {
        throw "Windows SDK bin directory is missing: $sdkBinRoot"
    }
    $candidates = Get-ChildItem -LiteralPath $sdkBinRoot -Directory | ForEach-Object {
        $parsed = $null
        if ([System.Version]::TryParse($_.Name, [ref]$parsed)) {
            $tool = Join-Path $_.FullName "x64\makeappx.exe"
            if (Test-Path -LiteralPath $tool -PathType Leaf) {
                [PSCustomObject]@{ Version = $parsed; Path = $tool }
            }
        }
    } | Sort-Object Version -Descending
    $selected = $candidates | Select-Object -First 1
    if ($null -eq $selected) {
        throw "No x64 MakeAppx.exe was found in the Windows SDK"
    }
    return $selected.Path
}

if ($env:OS -ne "Windows_NT") {
    throw "The MSIX preview builder requires Windows"
}

$releasePolicy = Get-Content -Raw -Encoding UTF8 -LiteralPath $releasePolicyPath | ConvertFrom-Json
if (
    $releasePolicy.distribution.strategy -ne "low_cost_staged" -or
    $releasePolicy.distribution.selectedChannel -ne "pending" -or
    $releasePolicy.distribution.previewArtifactPolicy -ne "unsigned_beta_with_sha256" -or
    $releasePolicy.distribution.plannedStableChannel -ne "microsoft_store"
) {
    throw "Release policy does not authorize the low-cost MSIX preview workflow"
}

if (-not $SkipTauriBuild) {
    Push-Location $projectRoot
    $previousCargoTargetDir = $env:CARGO_TARGET_DIR
    try {
        $env:CARGO_TARGET_DIR = $msixCargoTargetRoot
        & npm.cmd run tauri build -- --no-bundle
        if ($LASTEXITCODE -ne 0) {
            throw "Tauri release build failed with exit code $LASTEXITCODE"
        }
    }
    finally {
        if ($null -eq $previousCargoTargetDir) {
            Remove-Item Env:\CARGO_TARGET_DIR -ErrorAction SilentlyContinue
        }
        else {
            $env:CARGO_TARGET_DIR = $previousCargoTargetDir
        }
        Pop-Location
    }
}

foreach ($requiredSource in @($sourceManifestPath, $sourceExecutablePath, $sourceIconPath)) {
    if (-not (Test-Path -LiteralPath $requiredSource -PathType Leaf)) {
        throw "Required MSIX source file is missing: $requiredSource"
    }
}

New-Item -ItemType Directory -Path $targetRoot -Force | Out-Null
Reset-OwnedDirectory -Path $stagingRoot
Reset-OwnedDirectory -Path $unpackRoot
Assert-OwnedGeneratedPath -Path $packagePath
Assert-OwnedGeneratedPath -Path $reportPath
Get-ChildItem -LiteralPath $targetRoot -File -Filter "*.msix" | ForEach-Object {
    Assert-OwnedGeneratedPath -Path $_.FullName
    Remove-Item -LiteralPath $_.FullName -Force
}
if (Test-Path -LiteralPath $reportPath) { Remove-Item -LiteralPath $reportPath -Force }

Copy-RequiredFile -Source $sourceManifestPath -Destination (Join-Path $stagingRoot "AppxManifest.xml")
Copy-RequiredFile -Source $sourceExecutablePath -Destination (Join-Path $stagingRoot "yuanyuan-reminder.exe")

$licenseFiles = [ordered]@{
    "LICENSE.txt" = Join-Path $projectRoot "LICENSE"
    "THIRD_PARTY_NOTICES.md" = Join-Path $projectRoot "THIRD_PARTY_NOTICES.md"
    "THIRD_PARTY_LICENSES.txt" = Join-Path $projectRoot "THIRD_PARTY_LICENSES.txt"
    "ASSETS_LICENSE.md" = Join-Path $projectRoot "ASSETS_LICENSE.md"
}
foreach ($entry in $licenseFiles.GetEnumerator()) {
    Copy-RequiredFile -Source $entry.Value -Destination (Join-Path $stagingRoot "licenses\$($entry.Key)")
}

$assetsRoot = Join-Path $stagingRoot "Assets"
New-Item -ItemType Directory -Path $assetsRoot -Force | Out-Null
Resize-Png -Source $sourceIconPath -Destination (Join-Path $assetsRoot "StoreLogo.png") -Width 50 -Height 50
Resize-Png -Source $sourceIconPath -Destination (Join-Path $assetsRoot "Square44x44Logo.png") -Width 44 -Height 44
Resize-Png -Source $sourceIconPath -Destination (Join-Path $assetsRoot "Square150x150Logo.png") -Width 150 -Height 150

$makeAppxPath = Find-MakeAppx
& $makeAppxPath pack /d $stagingRoot /p $packagePath /o /v
if ($LASTEXITCODE -ne 0 -or -not (Test-Path -LiteralPath $packagePath -PathType Leaf)) {
    throw "MakeAppx failed to create the MSIX preview candidate"
}

& $makeAppxPath unpack /p $packagePath /d $unpackRoot /o /v
if ($LASTEXITCODE -ne 0) {
    throw "MakeAppx failed to unpack the generated MSIX candidate"
}

$unpackPrefix = $unpackRoot.TrimEnd([System.IO.Path]::DirectorySeparatorChar) + [System.IO.Path]::DirectorySeparatorChar
$payloadFiles = Get-ChildItem -LiteralPath $unpackRoot -Recurse -File | ForEach-Object {
    $fullName = [System.IO.Path]::GetFullPath($_.FullName)
    if (-not $fullName.StartsWith($unpackPrefix, [System.StringComparison]::OrdinalIgnoreCase)) {
        throw "Unpacked payload escaped the owned validation directory: $fullName"
    }
    $fullName.Substring($unpackPrefix.Length).Replace("\", "/")
} | Sort-Object
$requiredPayloadFiles = @(
    "AppxBlockMap.xml",
    "AppxManifest.xml",
    "Assets/Square150x150Logo.png",
    "Assets/Square44x44Logo.png",
    "Assets/StoreLogo.png",
    "licenses/ASSETS_LICENSE.md",
    "licenses/LICENSE.txt",
    "licenses/THIRD_PARTY_LICENSES.txt",
    "licenses/THIRD_PARTY_NOTICES.md",
    "yuanyuan-reminder.exe"
) | Sort-Object
if (Compare-Object -ReferenceObject $requiredPayloadFiles -DifferenceObject $payloadFiles) {
    throw "Generated MSIX payload does not match the exact preview boundary"
}
if ($payloadFiles -contains "AppxSignature.p7x") {
    throw "The preview package unexpectedly contains a signature"
}
if (($payloadFiles -join "`n") -match "(?i)(yuanyuan-ai|yuanyuan-bridge|runtime-qa|setup\.exe)") {
    throw "The preview package contains a forbidden prototype, QA harness, or nested installer"
}

[xml]$manifest = Get-Content -Raw -Encoding UTF8 -LiteralPath (Join-Path $unpackRoot "AppxManifest.xml")
$namespaceManager = New-Object System.Xml.XmlNamespaceManager($manifest.NameTable)
$namespaceManager.AddNamespace("f", "http://schemas.microsoft.com/appx/manifest/foundation/windows10")
$namespaceManager.AddNamespace("uap", "http://schemas.microsoft.com/appx/manifest/uap/windows10")
$namespaceManager.AddNamespace("uap10", "http://schemas.microsoft.com/appx/manifest/uap/windows10/10")
$namespaceManager.AddNamespace("rescap", "http://schemas.microsoft.com/appx/manifest/foundation/windows10/restrictedcapabilities")
$identity = $manifest.SelectSingleNode("/f:Package/f:Identity", $namespaceManager)
$application = $manifest.SelectSingleNode("/f:Package/f:Applications/f:Application", $namespaceManager)
$targetFamily = $manifest.SelectSingleNode("/f:Package/f:Dependencies/f:TargetDeviceFamily", $namespaceManager)
$runFullTrust = $manifest.SelectSingleNode("/f:Package/f:Capabilities/rescap:Capability[@Name='runFullTrust']", $namespaceManager)
if (
    $identity.Name -ne "Yuanyuan.Reminder.Preview" -or
    $identity.Version -ne "1.4.0.0" -or
    $identity.Publisher -ne "CN=YuanyuanReminderPreview, OID.2.25.311729368913984317654407730594956997722=1" -or
    $identity.ProcessorArchitecture -ne "x64" -or
    $application.Id -ne "YuanyuanReminder" -or
    $application.Executable -ne "yuanyuan-reminder.exe" -or
    $application.GetAttribute("RuntimeBehavior", "http://schemas.microsoft.com/appx/manifest/uap/windows10/10") -ne "packagedClassicApp" -or
    $application.GetAttribute("TrustLevel", "http://schemas.microsoft.com/appx/manifest/uap/windows10/10") -ne "mediumIL" -or
    $targetFamily.Name -ne "Windows.Desktop" -or
    $targetFamily.MinVersion -ne "10.0.19041.0" -or
    $null -eq $runFullTrust
) {
    throw "Generated MSIX manifest does not match the preview identity and full-trust desktop contract"
}

$packageSignature = Get-AuthenticodeSignature -LiteralPath $packagePath
$executableSignature = Get-AuthenticodeSignature -LiteralPath $sourceExecutablePath
if ($packageSignature.Status -ne "NotSigned" -or $executableSignature.Status -ne "NotSigned") {
    throw "The preview workflow expects an explicitly unsigned package and source executable"
}

$report = [ordered]@{
    schemaVersion = 1
    mode = "msix_preview_candidate"
    generatedAt = (Get-Date).ToUniversalTime().ToString("o")
    candidate = [ordered]@{
        version = "1.4.0.0"
        architecture = "x64"
        path = "src-tauri/target/msix-preview/YuanyuanReminder_1.4.0_x64-preview.msix"
        bytes = (Get-Item -LiteralPath $packagePath).Length
        sha256 = Get-Sha256 -Path $packagePath
        signatureStatus = $packageSignature.Status.ToString()
        structureReady = $true
        storeSubmissionReady = $false
    }
    policy = [ordered]@{
        strategy = $releasePolicy.distribution.strategy
        selectedChannel = $releasePolicy.distribution.selectedChannel
        previewArtifactPolicy = $releasePolicy.distribution.previewArtifactPolicy
        plannedStableChannel = $releasePolicy.distribution.plannedStableChannel
    }
    sources = [ordered]@{
        executableBytes = (Get-Item -LiteralPath $sourceExecutablePath).Length
        executableSha256 = Get-Sha256 -Path $sourceExecutablePath
        executableSignatureStatus = $executableSignature.Status.ToString()
        manifestSha256 = Get-Sha256 -Path $sourceManifestPath
        buildScriptSha256 = Get-Sha256 -Path $PSCommandPath
        iconSha256 = Get-Sha256 -Path $sourceIconPath
        makeAppxVersion = (Get-Item -LiteralPath $makeAppxPath).VersionInfo.FileVersion
        makeAppxSha256 = Get-Sha256 -Path $makeAppxPath
    }
    manifest = [ordered]@{
        identityName = $identity.Name
        identityPublisher = $identity.Publisher
        identityIsPreviewPlaceholder = $true
        applicationId = $application.Id
        executable = $application.Executable
        runtimeBehavior = $application.GetAttribute("RuntimeBehavior", "http://schemas.microsoft.com/appx/manifest/uap/windows10/10")
        trustLevel = $application.GetAttribute("TrustLevel", "http://schemas.microsoft.com/appx/manifest/uap/windows10/10")
        targetDeviceFamily = $targetFamily.Name
        minimumWindowsVersion = $targetFamily.MinVersion
        runFullTrust = $true
    }
    payload = [ordered]@{
        fileCount = $payloadFiles.Count
        files = @($payloadFiles)
        exactBoundaryVerified = $true
        prototypeSidecarsExcluded = $true
        nestedInstallerExcluded = $true
        licenseFiles = @($licenseFiles.Keys | Sort-Object)
    }
    validation = [ordered]@{
        makeAppxPackPassed = $true
        makeAppxUnpackPassed = $true
        packageUnsignedByDesign = $true
        looseRegistration = "not_performed"
        applicationLaunch = "not_performed"
        storeIdentityReserved = $false
        storeCertification = "not_performed"
    }
    limitations = @(
        "This is an unsigned local MSIX technical preview and cannot be submitted to the Store with its placeholder identity.",
        "Partner Center must provide the final package Name, Publisher, and PublisherDisplayName.",
        "Loose registration, packaged launch, autostart, notifications, single instance, WebView2, data migration, upgrade, uninstall, and Store certification remain separate tests."
    )
}

$report | ConvertTo-Json -Depth 10 | Set-Content -LiteralPath $reportPath -Encoding UTF8
Write-Output "MSIX preview candidate: $packagePath"
Write-Output "MSIX preview SHA-256: $($report.candidate.sha256)"
Write-Output "MSIX preview report: $reportPath"
