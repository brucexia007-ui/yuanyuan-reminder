[CmdletBinding()]
param()

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$projectRoot = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot ".."))
$targetRoot = [System.IO.Path]::GetFullPath((Join-Path $projectRoot "src-tauri\target\msix-store"))
$cargoTargetRoot = [System.IO.Path]::GetFullPath((Join-Path $targetRoot "cargo-target"))
$stagingRoot = [System.IO.Path]::GetFullPath((Join-Path $targetRoot "staging"))
$unpackRoot = [System.IO.Path]::GetFullPath((Join-Path $targetRoot "unpacked"))
$identityPath = [System.IO.Path]::GetFullPath((Join-Path $projectRoot "docs\release\MSIX_STORE_IDENTITY_V1.json"))
$identityVerifierPath = Join-Path $projectRoot "scripts\verify_msix_store_identity.mjs"
$manifestTemplatePath = Join-Path $projectRoot "src-tauri\msix\AppxManifest.store.xml"
$sourceIconPath = Join-Path $projectRoot "src-tauri\icons\128x128@2x.png"
$sourceExecutablePath = Join-Path $cargoTargetRoot "release\yuanyuan-reminder.exe"
$releasePolicyPath = Join-Path $projectRoot "docs\release\RELEASE_POLICY_V1.json"
$reportPath = Join-Path $targetRoot "msix-store-candidate-report.json"

function Assert-OwnedGeneratedPath {
    param([Parameter(Mandatory = $true)][string]$Path)
    $resolved = [System.IO.Path]::GetFullPath($Path)
    $ownedPrefix = $targetRoot.TrimEnd([System.IO.Path]::DirectorySeparatorChar) + [System.IO.Path]::DirectorySeparatorChar
    if (-not $resolved.StartsWith($ownedPrefix, [System.StringComparison]::OrdinalIgnoreCase)) {
        throw "Refusing to modify a path outside the owned MSIX Store target: $resolved"
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
        throw "Required MSIX Store source file is missing: $Source"
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

function Find-WindowsSdkTool {
    param([Parameter(Mandatory = $true)][string]$RelativeToolPath)
    $sdkBinRoot = "C:\Program Files (x86)\Windows Kits\10\bin"
    if (-not (Test-Path -LiteralPath $sdkBinRoot -PathType Container)) {
        throw "Windows SDK bin directory is missing: $sdkBinRoot"
    }
    $candidates = Get-ChildItem -LiteralPath $sdkBinRoot -Directory | ForEach-Object {
        $parsed = $null
        if ([System.Version]::TryParse($_.Name, [ref]$parsed)) {
            $tool = Join-Path $_.FullName $RelativeToolPath
            if (Test-Path -LiteralPath $tool -PathType Leaf) {
                [PSCustomObject]@{ Version = $parsed; Path = $tool }
            }
        }
    } | Sort-Object Version -Descending
    $selected = $candidates | Select-Object -First 1
    if ($null -eq $selected) {
        throw "Windows SDK tool is missing: $RelativeToolPath"
    }
    return $selected.Path
}

function Get-GitStatusLines {
    Push-Location $projectRoot
    try {
        $lines = @(& git status --porcelain=v1 --untracked-files=all)
        if ($LASTEXITCODE -ne 0) {
            throw "Unable to inspect the Git worktree"
        }
        return @($lines | Where-Object { $_ -ne "" })
    }
    finally {
        Pop-Location
    }
}

function Save-XmlUtf8NoBom {
    param(
        [Parameter(Mandatory = $true)][xml]$Document,
        [Parameter(Mandatory = $true)][string]$Path
    )
    $settings = New-Object System.Xml.XmlWriterSettings
    $settings.Encoding = New-Object System.Text.UTF8Encoding($false)
    $settings.Indent = $true
    $settings.NewLineChars = "`r`n"
    $settings.NewLineHandling = [System.Xml.NewLineHandling]::Replace
    $writer = [System.Xml.XmlWriter]::Create($Path, $settings)
    try {
        $Document.Save($writer)
    }
    finally {
        $writer.Dispose()
    }
}

if ($env:OS -ne "Windows_NT") {
    throw "The MSIX Store candidate builder requires Windows"
}

foreach ($requiredSource in @(
    $identityVerifierPath,
    $manifestTemplatePath,
    $sourceIconPath,
    $releasePolicyPath
)) {
    if (-not (Test-Path -LiteralPath $requiredSource -PathType Leaf)) {
        throw "Required MSIX Store source file is missing: $requiredSource"
    }
}

& node $identityVerifierPath $identityPath
if ($LASTEXITCODE -ne 0) {
    throw "Partner Center identity verification failed; no Store candidate was built"
}
$storeIdentity = Get-Content -Raw -Encoding UTF8 -LiteralPath $identityPath | ConvertFrom-Json

$releasePolicy = Get-Content -Raw -Encoding UTF8 -LiteralPath $releasePolicyPath | ConvertFrom-Json
if (
    $releasePolicy.distribution.strategy -ne "low_cost_staged" -or
    $releasePolicy.distribution.selectedChannel -ne "pending" -or
    $releasePolicy.distribution.plannedStableChannel -ne "microsoft_store"
) {
    throw "Release policy does not authorize the staged Microsoft Store workflow"
}

$preBuildStatus = @(Get-GitStatusLines)
if ($preBuildStatus.Count -ne 0) {
    throw "MSIX Store candidates require a clean, committed worktree; found $($preBuildStatus.Count) changed path(s)"
}

Push-Location $projectRoot
try {
    $trackedIdentityPath = (& git ls-files --error-unmatch -- "docs/release/MSIX_STORE_IDENTITY_V1.json" 2>$null)
    if ($LASTEXITCODE -ne 0 -or [string]::IsNullOrWhiteSpace($trackedIdentityPath)) {
        throw "The confirmed Partner Center identity file must be committed before building a Store candidate"
    }
    $gitHead = (& git rev-parse HEAD).Trim()
    if ($LASTEXITCODE -ne 0 -or $gitHead -notmatch "^[0-9a-f]{40}$") {
        throw "Unable to bind the Store candidate to a Git commit"
    }
}
finally {
    Pop-Location
}

$identityName = $storeIdentity.package.identityName
$packageVersion = $storeIdentity.platform.version
$packageFileName = "$($identityName)_$($packageVersion)_x64-store.msix"
$packagePath = [System.IO.Path]::GetFullPath((Join-Path $targetRoot $packageFileName))

Push-Location $projectRoot
$previousCargoTargetDir = $env:CARGO_TARGET_DIR
try {
    $env:CARGO_TARGET_DIR = $cargoTargetRoot
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

$postBuildStatus = @(Get-GitStatusLines)
if ($postBuildStatus.Count -ne 0) {
    throw "The Store build changed the source worktree; commit or revert the generated source changes before retrying"
}
if (-not (Test-Path -LiteralPath $sourceExecutablePath -PathType Leaf)) {
    throw "The isolated Tauri Store executable was not produced: $sourceExecutablePath"
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
if (Test-Path -LiteralPath $reportPath) {
    Remove-Item -LiteralPath $reportPath -Force
}

[xml]$generatedManifest = Get-Content -Raw -Encoding UTF8 -LiteralPath $manifestTemplatePath
$namespaceManager = New-Object System.Xml.XmlNamespaceManager($generatedManifest.NameTable)
$namespaceManager.AddNamespace("f", "http://schemas.microsoft.com/appx/manifest/foundation/windows10")
$namespaceManager.AddNamespace("uap", "http://schemas.microsoft.com/appx/manifest/uap/windows10")
$namespaceManager.AddNamespace("uap10", "http://schemas.microsoft.com/appx/manifest/uap/windows10/10")
$namespaceManager.AddNamespace("rescap", "http://schemas.microsoft.com/appx/manifest/foundation/windows10/restrictedcapabilities")
$identityNode = $generatedManifest.SelectSingleNode("/f:Package/f:Identity", $namespaceManager)
$displayNameNode = $generatedManifest.SelectSingleNode("/f:Package/f:Properties/f:DisplayName", $namespaceManager)
$publisherDisplayNameNode = $generatedManifest.SelectSingleNode("/f:Package/f:Properties/f:PublisherDisplayName", $namespaceManager)
$applicationNode = $generatedManifest.SelectSingleNode("/f:Package/f:Applications/f:Application", $namespaceManager)
$visualElementsNode = $generatedManifest.SelectSingleNode("/f:Package/f:Applications/f:Application/uap:VisualElements", $namespaceManager)
$targetFamilyNode = $generatedManifest.SelectSingleNode("/f:Package/f:Dependencies/f:TargetDeviceFamily", $namespaceManager)
$runFullTrustNode = $generatedManifest.SelectSingleNode("/f:Package/f:Capabilities/rescap:Capability[@Name='runFullTrust']", $namespaceManager)
if (
    $null -eq $identityNode -or
    $null -eq $displayNameNode -or
    $null -eq $publisherDisplayNameNode -or
    $null -eq $applicationNode -or
    $null -eq $visualElementsNode -or
    $null -eq $targetFamilyNode -or
    $null -eq $runFullTrustNode
) {
    throw "The Store manifest template is missing a required desktop package element"
}
$identityNode.SetAttribute("Name", $storeIdentity.package.identityName)
$identityNode.SetAttribute("Version", $storeIdentity.platform.version)
$identityNode.SetAttribute("Publisher", $storeIdentity.package.publisher)
$identityNode.SetAttribute("ProcessorArchitecture", $storeIdentity.platform.architecture)
$displayNameNode.InnerText = $storeIdentity.product.reservedProductName
$publisherDisplayNameNode.InnerText = $storeIdentity.package.publisherDisplayName
$visualElementsNode.SetAttribute("DisplayName", $storeIdentity.product.reservedProductName)
$targetFamilyNode.SetAttribute("Name", $storeIdentity.platform.targetDeviceFamily)
$targetFamilyNode.SetAttribute("MinVersion", $storeIdentity.platform.minVersion)
$targetFamilyNode.SetAttribute("MaxVersionTested", $storeIdentity.platform.maxVersionTested)
$generatedManifestPath = Join-Path $stagingRoot "AppxManifest.xml"
New-Item -ItemType Directory -Path $stagingRoot -Force | Out-Null
Save-XmlUtf8NoBom -Document $generatedManifest -Path $generatedManifestPath

Copy-RequiredFile -Source $sourceExecutablePath -Destination (Join-Path $stagingRoot "yuanyuan-reminder.exe")
$brandConfig = Get-Content -Raw -Encoding UTF8 -LiteralPath (Join-Path $projectRoot "product-brand.json") | ConvertFrom-Json
if ([string]::IsNullOrWhiteSpace([string]$brandConfig.assets.licenseFile)) {
    throw "product brand assets.licenseFile is required"
}
$licenseFiles = [ordered]@{
    "LICENSE.txt" = Join-Path $projectRoot "LICENSE"
    "THIRD_PARTY_NOTICES.md" = Join-Path $projectRoot "THIRD_PARTY_NOTICES.md"
    "THIRD_PARTY_LICENSES.txt" = Join-Path $projectRoot "THIRD_PARTY_LICENSES.txt"
    "ASSETS_LICENSE.md" = Join-Path $projectRoot ([string]$brandConfig.assets.licenseFile)
}
foreach ($entry in $licenseFiles.GetEnumerator()) {
    Copy-RequiredFile -Source $entry.Value -Destination (Join-Path $stagingRoot "licenses\$($entry.Key)")
}

$assetsRoot = Join-Path $stagingRoot "Assets"
New-Item -ItemType Directory -Path $assetsRoot -Force | Out-Null
Resize-Png -Source $sourceIconPath -Destination (Join-Path $assetsRoot "StoreLogo.png") -Width 50 -Height 50
Resize-Png -Source $sourceIconPath -Destination (Join-Path $assetsRoot "Square44x44Logo.png") -Width 44 -Height 44
Resize-Png -Source $sourceIconPath -Destination (Join-Path $assetsRoot "Square150x150Logo.png") -Width 150 -Height 150

$makeAppxPath = Find-WindowsSdkTool -RelativeToolPath "x64\makeappx.exe"
& $makeAppxPath pack /d $stagingRoot /p $packagePath /o /v
if ($LASTEXITCODE -ne 0 -or -not (Test-Path -LiteralPath $packagePath -PathType Leaf)) {
    throw "MakeAppx failed to create the MSIX Store candidate"
}
& $makeAppxPath unpack /p $packagePath /d $unpackRoot /o /v
if ($LASTEXITCODE -ne 0) {
    throw "MakeAppx failed to unpack the MSIX Store candidate"
}

$unpackPrefix = $unpackRoot.TrimEnd([System.IO.Path]::DirectorySeparatorChar) + [System.IO.Path]::DirectorySeparatorChar
$payloadFiles = Get-ChildItem -LiteralPath $unpackRoot -Recurse -File | ForEach-Object {
    $fullName = [System.IO.Path]::GetFullPath($_.FullName)
    if (-not $fullName.StartsWith($unpackPrefix, [System.StringComparison]::OrdinalIgnoreCase)) {
        throw "Unpacked Store payload escaped the owned validation directory: $fullName"
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
    throw "Generated MSIX Store payload does not match the exact release boundary"
}
if ($payloadFiles -contains "AppxSignature.p7x") {
    throw "The Store intake package unexpectedly contains a signature"
}
if (($payloadFiles -join "`n") -match "(?i)(yuanyuan-ai|yuanyuan-bridge|runtime-qa|setup\.exe)") {
    throw "The Store package contains a forbidden prototype, QA harness, or nested installer"
}

[xml]$packedManifest = Get-Content -Raw -Encoding UTF8 -LiteralPath (Join-Path $unpackRoot "AppxManifest.xml")
$packedNamespaces = New-Object System.Xml.XmlNamespaceManager($packedManifest.NameTable)
$packedNamespaces.AddNamespace("f", "http://schemas.microsoft.com/appx/manifest/foundation/windows10")
$packedNamespaces.AddNamespace("uap", "http://schemas.microsoft.com/appx/manifest/uap/windows10")
$packedNamespaces.AddNamespace("uap10", "http://schemas.microsoft.com/appx/manifest/uap/windows10/10")
$packedNamespaces.AddNamespace("rescap", "http://schemas.microsoft.com/appx/manifest/foundation/windows10/restrictedcapabilities")
$packedIdentity = $packedManifest.SelectSingleNode("/f:Package/f:Identity", $packedNamespaces)
$packedPublisherDisplayName = $packedManifest.SelectSingleNode("/f:Package/f:Properties/f:PublisherDisplayName", $packedNamespaces)
$packedApplication = $packedManifest.SelectSingleNode("/f:Package/f:Applications/f:Application", $packedNamespaces)
$packedTargetFamily = $packedManifest.SelectSingleNode("/f:Package/f:Dependencies/f:TargetDeviceFamily", $packedNamespaces)
$packedRunFullTrust = $packedManifest.SelectSingleNode("/f:Package/f:Capabilities/rescap:Capability[@Name='runFullTrust']", $packedNamespaces)
if (
    $packedIdentity.Name -cne $storeIdentity.package.identityName -or
    $packedIdentity.Publisher -cne $storeIdentity.package.publisher -or
    $packedIdentity.Version -ne $storeIdentity.platform.version -or
    $packedIdentity.ProcessorArchitecture -ne $storeIdentity.platform.architecture -or
    $packedPublisherDisplayName.InnerText -cne $storeIdentity.package.publisherDisplayName -or
    $packedApplication.Id -ne "YuanyuanReminder" -or
    $packedApplication.Executable -ne "yuanyuan-reminder.exe" -or
    $packedApplication.GetAttribute("RuntimeBehavior", "http://schemas.microsoft.com/appx/manifest/uap/windows10/10") -ne "packagedClassicApp" -or
    $packedApplication.GetAttribute("TrustLevel", "http://schemas.microsoft.com/appx/manifest/uap/windows10/10") -ne "mediumIL" -or
    $packedTargetFamily.Name -ne $storeIdentity.platform.targetDeviceFamily -or
    $packedTargetFamily.MinVersion -ne $storeIdentity.platform.minVersion -or
    $packedTargetFamily.MaxVersionTested -ne $storeIdentity.platform.maxVersionTested -or
    $null -eq $packedRunFullTrust
) {
    throw "Generated manifest drifted from the exact Partner Center identity or desktop contract"
}

$packageSignature = Get-AuthenticodeSignature -LiteralPath $packagePath
$executableSignature = Get-AuthenticodeSignature -LiteralPath $sourceExecutablePath
if ($packageSignature.Status -ne "NotSigned") {
    throw "The Store intake package must remain unsigned for Microsoft Store re-signing"
}

$report = [ordered]@{
    schemaVersion = 1
    mode = "msix_store_candidate"
    generatedAt = (Get-Date).ToUniversalTime().ToString("o")
    candidate = [ordered]@{
        version = $storeIdentity.platform.version
        architecture = $storeIdentity.platform.architecture
        path = "src-tauri/target/msix-store/$packageFileName"
        bytes = (Get-Item -LiteralPath $packagePath).Length
        sha256 = Get-Sha256 -Path $packagePath
        signatureStatus = $packageSignature.Status.ToString()
        structureReady = $true
        partnerCenterIdentityReady = $true
        storeSubmissionReady = $false
    }
    sourceControl = [ordered]@{
        gitHead = $gitHead
        worktreeCleanBeforeBuild = $true
        worktreeCleanAfterBuild = $true
    }
    policy = [ordered]@{
        strategy = $releasePolicy.distribution.strategy
        selectedChannel = $releasePolicy.distribution.selectedChannel
        plannedStableChannel = $releasePolicy.distribution.plannedStableChannel
    }
    sources = [ordered]@{
        executableBytes = (Get-Item -LiteralPath $sourceExecutablePath).Length
        executableSha256 = Get-Sha256 -Path $sourceExecutablePath
        executableSignatureStatus = $executableSignature.Status.ToString()
        identitySha256 = Get-Sha256 -Path $identityPath
        identityVerifierSha256 = Get-Sha256 -Path $identityVerifierPath
        manifestTemplateSha256 = Get-Sha256 -Path $manifestTemplatePath
        generatedManifestSha256 = Get-Sha256 -Path $generatedManifestPath
        buildScriptSha256 = Get-Sha256 -Path $PSCommandPath
        iconSha256 = Get-Sha256 -Path $sourceIconPath
        makeAppxVersion = (Get-Item -LiteralPath $makeAppxPath).VersionInfo.FileVersion
        makeAppxSha256 = Get-Sha256 -Path $makeAppxPath
    }
    manifest = [ordered]@{
        identityName = $packedIdentity.Name
        identityPublisher = $packedIdentity.Publisher
        publisherDisplayName = $packedPublisherDisplayName.InnerText
        packageFamilyName = $storeIdentity.package.packageFamilyName
        storeId = $storeIdentity.product.storeId
        reservedProductName = $storeIdentity.product.reservedProductName
        applicationId = $packedApplication.Id
        executable = $packedApplication.Executable
        runtimeBehavior = $packedApplication.GetAttribute("RuntimeBehavior", "http://schemas.microsoft.com/appx/manifest/uap/windows10/10")
        trustLevel = $packedApplication.GetAttribute("TrustLevel", "http://schemas.microsoft.com/appx/manifest/uap/windows10/10")
        targetDeviceFamily = $packedTargetFamily.Name
        minimumWindowsVersion = $packedTargetFamily.MinVersion
        maximumWindowsVersionTested = $packedTargetFamily.MaxVersionTested
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
        partnerCenterIdentityConfirmedByHuman = $true
        identityVerifierPassed = $true
        sourceWorktreeClean = $true
        makeAppxPackPassed = $true
        makeAppxUnpackPassed = $true
        packageUnsignedForStoreResigning = $true
        cleanWindowsInstall = "not_performed"
        applicationLaunch = "not_performed"
        windowsAppCertificationKit = "not_performed"
        storeCertification = "not_performed"
    }
    limitations = @(
        "Partner Center identity and package structure are ready, but Store submission remains blocked until clean-machine runtime testing and Windows App Certification Kit evidence pass.",
        "The package is deliberately unsigned because Microsoft Store re-signs MSIX packages after certification; it must not be distributed outside the Store.",
        "Tray, autostart, notifications, single instance, WebView2, NSIS migration, updates, user data, uninstall behavior, accessibility, and Store certification remain separate gates."
    )
}

$report | ConvertTo-Json -Depth 10 | Set-Content -LiteralPath $reportPath -Encoding UTF8
Write-Output "MSIX Store candidate: $packagePath"
Write-Output "MSIX Store candidate SHA-256: $($report.candidate.sha256)"
Write-Output "MSIX Store candidate report: $reportPath"
Write-Output "Store submission remains pending runtime and WACK evidence."
