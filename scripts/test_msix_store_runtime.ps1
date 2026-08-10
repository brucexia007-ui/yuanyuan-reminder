[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)][string]$PackagePath,
    [ValidateSet("disposable_test_certificate", "microsoft_store")][string]$SignatureOrigin = "microsoft_store",
    [switch]$ConfirmDisposableWindows11Environment
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$projectRoot = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot ".."))
$targetRoot = [System.IO.Path]::GetFullPath((Join-Path $projectRoot "src-tauri\target\msix-store-runtime"))
$unpackRoot = [System.IO.Path]::GetFullPath((Join-Path $targetRoot "unpacked"))
$reportFileName = if ($SignatureOrigin -eq "microsoft_store") { "msix-store-certified-runtime-report.json" } else { "msix-store-runtime-report.json" }
$errorLogFileName = if ($SignatureOrigin -eq "microsoft_store") { "msix-store-certified-runtime-error.log" } else { "msix-store-runtime-error.log" }
$reportPath = Join-Path $targetRoot $reportFileName
$errorLogPath = Join-Path $targetRoot $errorLogFileName
$identityPath = Join-Path $projectRoot "docs\release\MSIX_STORE_IDENTITY_V1.json"
$identityVerifierPath = Join-Path $projectRoot "scripts\verify_msix_store_identity.mjs"
$storeReleaseManifestPath = Join-Path $projectRoot "src-tauri\target\msix-store\msix-store-release-manifest.json"
$storeReleaseManifestVerifierPath = Join-Path $projectRoot "scripts\generate_msix_store_release_manifest.mjs"
$applicationId = "YuanyuanReminder"
$processName = "yuanyuan-reminder"

function Assert-OwnedGeneratedPath {
    param([Parameter(Mandatory = $true)][string]$Path)
    $resolved = [System.IO.Path]::GetFullPath($Path)
    $ownedPrefix = $targetRoot.TrimEnd([System.IO.Path]::DirectorySeparatorChar) + [System.IO.Path]::DirectorySeparatorChar
    if (-not $resolved.StartsWith($ownedPrefix, [System.StringComparison]::OrdinalIgnoreCase)) {
        throw "Refusing to modify a path outside the owned MSIX runtime target: $resolved"
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

function Find-MakeAppx {
    $sdkBinRoot = "C:\Program Files (x86)\Windows Kits\10\bin"
    $candidates = Get-ChildItem -LiteralPath $sdkBinRoot -Directory -ErrorAction Stop | ForEach-Object {
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

trap {
    New-Item -ItemType Directory -Path $targetRoot -Force | Out-Null
    ($_ | Format-List * -Force | Out-String) | Set-Content -LiteralPath $errorLogPath -Encoding UTF8
    exit 1
}

if ($env:OS -ne "Windows_NT" -or [System.Environment]::OSVersion.Version.Build -lt 22000) {
    throw "The Store runtime test requires Windows 11"
}
if (-not $ConfirmDisposableWindows11Environment) {
    throw "Pass -ConfirmDisposableWindows11Environment only inside a clean disposable Windows 11 VM or dedicated test machine"
}
if (-not [Environment]::UserInteractive) {
    throw "The Store runtime test requires an interactive user session"
}

$resolvedPackagePath = [System.IO.Path]::GetFullPath($PackagePath)
if (-not (Test-Path -LiteralPath $resolvedPackagePath -PathType Leaf)) {
    throw "The trusted Store-identity MSIX package is missing: $resolvedPackagePath"
}
if ([System.IO.Path]::GetExtension($resolvedPackagePath) -ne ".msix") {
    throw "The Store runtime test accepts one .msix package"
}

& node $identityVerifierPath $identityPath
if ($LASTEXITCODE -ne 0) {
    throw "Partner Center identity verification failed before runtime testing"
}
$storeIdentity = Get-Content -Raw -Encoding UTF8 -LiteralPath $identityPath | ConvertFrom-Json
& node $storeReleaseManifestVerifierPath --check
if ($LASTEXITCODE -ne 0) {
    throw "Store release-manifest verification failed before runtime testing"
}
$storeReleaseManifest = Get-Content -Raw -Encoding UTF8 -LiteralPath $storeReleaseManifestPath | ConvertFrom-Json
$signature = Get-AuthenticodeSignature -LiteralPath $resolvedPackagePath
if (
    $signature.Status -ne "Valid" -or
    $null -eq $signature.SignerCertificate -or
    $signature.SignerCertificate.Subject -cne $storeIdentity.package.publisher
) {
    throw "Runtime testing requires a trusted Store-identity package whose signer exactly matches the Partner Center Publisher"
}

New-Item -ItemType Directory -Path $targetRoot -Force | Out-Null
Assert-OwnedGeneratedPath -Path $reportPath
Assert-OwnedGeneratedPath -Path $errorLogPath
Reset-OwnedDirectory -Path $unpackRoot
foreach ($ownedFile in @($reportPath, $errorLogPath)) {
    if (Test-Path -LiteralPath $ownedFile) {
        Remove-Item -LiteralPath $ownedFile -Force
    }
}

$makeAppxPath = Find-MakeAppx
& $makeAppxPath unpack /p $resolvedPackagePath /d $unpackRoot /o /v
if ($LASTEXITCODE -ne 0) {
    throw "MakeAppx failed to inspect the trusted Store-identity package"
}
$unpackPrefix = $unpackRoot.TrimEnd([System.IO.Path]::DirectorySeparatorChar) + [System.IO.Path]::DirectorySeparatorChar
$trustedPayloadFiles = @(Get-ChildItem -LiteralPath $unpackRoot -Recurse -File | ForEach-Object {
    $fullName = [System.IO.Path]::GetFullPath($_.FullName)
    if (-not $fullName.StartsWith($unpackPrefix, [System.StringComparison]::OrdinalIgnoreCase)) {
        throw "Trusted Store package payload escaped the owned runtime directory"
    }
    $fullName.Substring($unpackPrefix.Length).Replace("\", "/")
} | Sort-Object)
$expectedPayloadFiles = @($storeReleaseManifest.payload.files | ForEach-Object { $_.path })
$missingPayloadFiles = @(Compare-Object -ReferenceObject $expectedPayloadFiles -DifferenceObject $trustedPayloadFiles -PassThru | Where-Object { $_ -in $expectedPayloadFiles })
if ($missingPayloadFiles.Count -ne 0) {
    throw "Trusted Store package is missing release-manifest payload files: $($missingPayloadFiles -join ', ')"
}
$signatureMetadataFiles = @($trustedPayloadFiles | Where-Object { $_ -notin $expectedPayloadFiles })
$allowedSignatureMetadataFiles = @(
    "AppxMetadata/CodeIntegrity.cat",
    "AppxMetadata/ContentGroupMap.xml",
    "AppxSignature.p7x"
)
if (
    "AppxSignature.p7x" -notin $signatureMetadataFiles -or
    @($signatureMetadataFiles | Where-Object { $_ -notin $allowedSignatureMetadataFiles }).Count -ne 0
) {
    throw "Trusted Store package contains missing or unexpected signature metadata"
}
$stablePayloadSha256 = [ordered]@{}
foreach ($payloadRecord in $storeReleaseManifest.payload.files) {
    if ($payloadRecord.path -eq "AppxBlockMap.xml") {
        continue
    }
    $trustedPayloadPath = Join-Path $unpackRoot ($payloadRecord.path.Replace("/", "\"))
    $trustedPayloadItem = Get-Item -LiteralPath $trustedPayloadPath
    $trustedPayloadHash = Get-Sha256 -Path $trustedPayloadPath
    if ($trustedPayloadItem.Length -ne $payloadRecord.bytes -or $trustedPayloadHash -cne $payloadRecord.sha256) {
        throw "Microsoft/test signing payload lineage drifted at $($payloadRecord.path)"
    }
    $stablePayloadSha256[$payloadRecord.path] = $trustedPayloadHash
}
[xml]$manifest = Get-Content -Raw -Encoding UTF8 -LiteralPath (Join-Path $unpackRoot "AppxManifest.xml")
$namespaces = New-Object System.Xml.XmlNamespaceManager($manifest.NameTable)
$namespaces.AddNamespace("f", "http://schemas.microsoft.com/appx/manifest/foundation/windows10")
$identity = $manifest.SelectSingleNode("/f:Package/f:Identity", $namespaces)
$application = $manifest.SelectSingleNode("/f:Package/f:Applications/f:Application", $namespaces)
if (
    $identity.Name -cne $storeIdentity.package.identityName -or
    $identity.Publisher -cne $storeIdentity.package.publisher -or
    $identity.Version -ne $storeIdentity.platform.version -or
    $identity.ProcessorArchitecture -ne $storeIdentity.platform.architecture -or
    $application.Id -ne $applicationId -or
    $application.Executable -ne "yuanyuan-reminder.exe"
) {
    throw "The trusted package manifest does not match the confirmed Partner Center identity"
}

$preexistingPackages = @(Get-AppxPackage -Name $storeIdentity.package.identityName -ErrorAction SilentlyContinue)
if ($preexistingPackages.Count -ne 0) {
    throw "A package with the Store identity is already registered; refusing to alter it"
}
$preexistingProcesses = @(Get-Process -Name $processName -ErrorAction SilentlyContinue)
if ($preexistingProcesses.Count -ne 0) {
    throw "A yuanyuan-reminder process is already running; refusing to include it in runtime evidence"
}

$packageHashBefore = Get-Sha256 -Path $resolvedPackagePath
$registeredPackage = $null
$launchedProcesses = @()
$launchedProcessIds = @()
$launchedProcessPaths = @()
$launchPassed = $false
try {
    Add-AppxPackage -Path $resolvedPackagePath -ErrorAction Stop
    $matches = @(Get-AppxPackage -Name $storeIdentity.package.identityName -ErrorAction Stop)
    if ($matches.Count -ne 1) {
        throw "Expected one registered Store package, found $($matches.Count)"
    }
    $registeredPackage = $matches[0]
    if (
        $registeredPackage.Publisher -cne $storeIdentity.package.publisher -or
        $registeredPackage.PackageFamilyName -cne $storeIdentity.package.packageFamilyName -or
        $registeredPackage.Version.ToString() -ne $storeIdentity.platform.version -or
        $registeredPackage.Architecture.ToString() -ne "X64"
    ) {
        throw "The registered package identity drifted from Partner Center"
    }

    $aumid = "$($registeredPackage.PackageFamilyName)!$applicationId"
    Start-Process -FilePath "explorer.exe" -ArgumentList "shell:AppsFolder\$aumid"
    $deadline = (Get-Date).AddSeconds(30)
    do {
        Start-Sleep -Milliseconds 500
        $launchedProcesses = @(Get-Process -Name $processName -ErrorAction SilentlyContinue)
    } while ($launchedProcesses.Count -eq 0 -and (Get-Date) -lt $deadline)
    if ($launchedProcesses.Count -eq 0) {
        throw "The packaged application did not start within 30 seconds"
    }
    $installPrefix = $registeredPackage.InstallLocation.TrimEnd([System.IO.Path]::DirectorySeparatorChar) + [System.IO.Path]::DirectorySeparatorChar
    foreach ($process in $launchedProcesses) {
        $processPath = $process.Path
        if (
            [string]::IsNullOrWhiteSpace($processPath) -or
            -not $processPath.StartsWith($installPrefix, [System.StringComparison]::OrdinalIgnoreCase)
        ) {
            throw "A launched process did not originate from the installed Store package"
        }
        $launchedProcessIds += $process.Id
        $launchedProcessPaths += $processPath
    }
    $launchPassed = $true
}
finally {
    foreach ($process in $launchedProcesses) {
        Stop-Process -Id $process.Id -Force -ErrorAction SilentlyContinue
    }
    if ($launchedProcessIds.Count -ne 0) {
        Wait-Process -Id $launchedProcessIds -Timeout 10 -ErrorAction SilentlyContinue
    }
    if ($null -ne $registeredPackage) {
        Remove-AppxPackage -Package $registeredPackage.PackageFullName -ErrorAction Stop
    }
}

$remainingPackages = @(Get-AppxPackage -Name $storeIdentity.package.identityName -ErrorAction SilentlyContinue)
$remainingProcesses = @(Get-Process -Name $processName -ErrorAction SilentlyContinue)
$packageHashAfter = Get-Sha256 -Path $resolvedPackagePath
$cleanupPassed =
    $remainingPackages.Count -eq 0 -and
    $remainingProcesses.Count -eq 0 -and
    $packageHashAfter -eq $packageHashBefore
if (-not $launchPassed -or -not $cleanupPassed) {
    throw "Store runtime launch or cleanup did not complete"
}

$report = [ordered]@{
    schemaVersion = 1
    mode = "msix_store_runtime_test"
    testedAt = (Get-Date).ToUniversalTime().ToString("o")
    environment = [ordered]@{
        osVersion = [System.Environment]::OSVersion.Version.ToString()
        userInteractive = [Environment]::UserInteractive
        operatorConfirmedDisposableWindows11 = $true
    }
    candidate = [ordered]@{
        sourcePath = $resolvedPackagePath
        sha256Before = $packageHashBefore
        sha256After = $packageHashAfter
        signatureStatus = $signature.Status.ToString()
        signatureOrigin = $SignatureOrigin
        signerSubject = $signature.SignerCertificate.Subject
        remainedUnmodified = $packageHashAfter -eq $packageHashBefore
    }
    registration = [ordered]@{
        packageName = $storeIdentity.package.identityName
        packageFullName = $registeredPackage.PackageFullName
        packageFamilyName = $registeredPackage.PackageFamilyName
        version = $registeredPackage.Version.ToString()
        architecture = $registeredPackage.Architecture.ToString()
        installed = $true
    }
    lineage = [ordered]@{
        storeReleaseManifestSha256 = Get-Sha256 -Path $storeReleaseManifestPath
        unsignedStoreCandidateSha256 = $storeReleaseManifest.candidate.sha256
        stablePayloadFileCount = $stablePayloadSha256.Count
        stablePayloadSha256 = $stablePayloadSha256
        signatureMetadataFiles = @($signatureMetadataFiles | Sort-Object)
        allStablePayloadFilesMatched = $true
    }
    launch = [ordered]@{
        applicationId = $applicationId
        aumid = "$($registeredPackage.PackageFamilyName)!$applicationId"
        processName = $processName
        processCount = $launchedProcessIds.Count
        processPaths = @($launchedProcessPaths)
        startedFromInstalledPackage = $true
        passed = $launchPassed
    }
    cleanup = [ordered]@{
        processesStopped = $remainingProcesses.Count -eq 0
        packageRemoved = $remainingPackages.Count -eq 0
        candidatePreserved = $packageHashAfter -eq $packageHashBefore
        certificateStoreModified = $false
        developerModeModified = $false
        passed = $cleanupPassed
    }
    limitations = @(
        "This automated test proves trusted package installation, identity registration, process launch origin, stop, uninstall, and cleanup only.",
        "Tray visibility, autostart, notifications, single instance, WebView2 UX, data migration, updates, accessibility, and uninstall data choices require the separate human acceptance matrix."
    )
}
$report | ConvertTo-Json -Depth 10 | Set-Content -LiteralPath $reportPath -Encoding UTF8
Write-Output "Trusted Store-identity MSIX install, launch, uninstall, and cleanup passed: $reportPath"
