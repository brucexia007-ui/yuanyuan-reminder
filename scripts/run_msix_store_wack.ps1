[CmdletBinding()]
param(
    [switch]$ConfirmDisposableWindows11Environment
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$projectRoot = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot ".."))
$targetRoot = [System.IO.Path]::GetFullPath((Join-Path $projectRoot "src-tauri\target\msix-store"))
$rawReportPath = Join-Path $targetRoot "wack-report.xml"
$executionReportPath = Join-Path $targetRoot "wack-execution-report.json"
$candidateReportPath = Join-Path $targetRoot "msix-store-candidate-report.json"
$testSignedPackagePath = Join-Path $targetRoot "wack-test-signed.msix"
$temporaryCertificatePath = Join-Path $targetRoot "wack-temporary-certificate.cer"
$candidateVerifierPath = Join-Path $projectRoot "scripts\verify_msix_store_candidate.mjs"
$identityPath = Join-Path $projectRoot "docs\release\MSIX_STORE_IDENTITY_V1.json"
$runtimeTestScriptPath = Join-Path $projectRoot "scripts\test_msix_store_runtime.ps1"
$runtimeReportPath = Join-Path $projectRoot "src-tauri\target\msix-store-runtime\msix-store-runtime-report.json"
$appCertPath = "C:\Program Files (x86)\Windows Kits\10\App Certification Kit\appcert.exe"

function Assert-OwnedGeneratedPath {
    param([Parameter(Mandatory = $true)][string]$Path)
    $resolved = [System.IO.Path]::GetFullPath($Path)
    $ownedPrefix = $targetRoot.TrimEnd([System.IO.Path]::DirectorySeparatorChar) + [System.IO.Path]::DirectorySeparatorChar
    if (-not $resolved.StartsWith($ownedPrefix, [System.StringComparison]::OrdinalIgnoreCase)) {
        throw "Refusing to modify a path outside the owned MSIX Store target: $resolved"
    }
}

function Get-Sha256 {
    param([Parameter(Mandatory = $true)][string]$Path)
    return (Get-FileHash -Algorithm SHA256 -LiteralPath $Path).Hash
}

function Find-WindowsSdkTool {
    param([Parameter(Mandatory = $true)][string]$RelativeToolPath)
    $sdkBinRoot = "C:\Program Files (x86)\Windows Kits\10\bin"
    $candidates = Get-ChildItem -LiteralPath $sdkBinRoot -Directory -ErrorAction Stop | ForEach-Object {
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

function Remove-ExactTemporaryCertificate {
    param([Parameter(Mandatory = $true)][string]$Thumbprint)
    foreach ($storePath in @("Cert:\CurrentUser\My", "Cert:\CurrentUser\TrustedPeople")) {
        Get-ChildItem -Path $storePath -ErrorAction SilentlyContinue |
            Where-Object { $_.Thumbprint -ceq $Thumbprint } |
            ForEach-Object { Remove-Item -LiteralPath $_.PSPath -Force }
    }
}

if ($env:OS -ne "Windows_NT" -or [System.Environment]::OSVersion.Version.Build -lt 22000) {
    throw "Windows App Certification Kit testing requires Windows 11"
}
if (-not $ConfirmDisposableWindows11Environment) {
    throw "Pass -ConfirmDisposableWindows11Environment only inside a clean disposable Windows 11 VM or dedicated test machine"
}
if (-not [Environment]::UserInteractive) {
    throw "Windows App Certification Kit must run in an active interactive user session"
}
$currentIdentity = [System.Security.Principal.WindowsIdentity]::GetCurrent()
$currentPrincipal = New-Object System.Security.Principal.WindowsPrincipal($currentIdentity)
if (-not $currentPrincipal.IsInRole([System.Security.Principal.WindowsBuiltInRole]::Administrator)) {
    throw "Windows App Certification Kit must run from an elevated Administrator session"
}
if (-not (Test-Path -LiteralPath $appCertPath -PathType Leaf)) {
    throw "Windows App Certification Kit is not installed: $appCertPath"
}

& node $candidateVerifierPath
if ($LASTEXITCODE -ne 0) {
    throw "The MSIX Store candidate evidence must verify before WACK"
}
$candidateReport = Get-Content -Raw -Encoding UTF8 -LiteralPath $candidateReportPath | ConvertFrom-Json
$storeIdentity = Get-Content -Raw -Encoding UTF8 -LiteralPath $identityPath | ConvertFrom-Json
$packagePath = [System.IO.Path]::GetFullPath((Join-Path $projectRoot $candidateReport.candidate.path))
if (-not (Test-Path -LiteralPath $packagePath -PathType Leaf)) {
    throw "The MSIX Store candidate package is missing: $packagePath"
}
$unsignedPackageHashBefore = Get-Sha256 -Path $packagePath
if ($unsignedPackageHashBefore -ne $candidateReport.candidate.sha256) {
    throw "The unsigned Store candidate drifted before WACK"
}
$preexistingPackages = @(Get-AppxPackage -Name $storeIdentity.package.identityName -ErrorAction SilentlyContinue)
if ($preexistingPackages.Count -ne 0) {
    throw "A package with the Store identity is already registered; refusing to include it in WACK cleanup"
}
$preexistingProcesses = @(Get-Process -Name "yuanyuan-reminder" -ErrorAction SilentlyContinue)
if ($preexistingProcesses.Count -ne 0) {
    throw "A yuanyuan-reminder process is already running; refusing to include it in WACK cleanup"
}

foreach ($path in @(
    $rawReportPath,
    $executionReportPath,
    $testSignedPackagePath,
    $temporaryCertificatePath
)) {
    Assert-OwnedGeneratedPath -Path $path
    if (Test-Path -LiteralPath $path) {
        Remove-Item -LiteralPath $path -Force
    }
}

$signToolPath = Find-WindowsSdkTool -RelativeToolPath "x64\signtool.exe"
$certificate = $null
$certificateThumbprint = $null
$trustedCertificate = $null
$testSignature = $null
$resetExitCode = $null
$testExitCode = $null
$wackProcessesStopped = $false
$wackPackageRemoved = $false
try {
    Copy-Item -LiteralPath $packagePath -Destination $testSignedPackagePath -Force
    $friendlyName = "Yuanyuan MSIX WACK Disposable Test $([guid]::NewGuid().ToString('N'))"
    $certificate = New-SelfSignedCertificate `
        -Type CodeSigningCert `
        -Subject $storeIdentity.package.publisher `
        -FriendlyName $friendlyName `
        -CertStoreLocation "Cert:\CurrentUser\My" `
        -KeyAlgorithm RSA `
        -KeyLength 3072 `
        -HashAlgorithm SHA256 `
        -KeyExportPolicy NonExportable `
        -NotAfter (Get-Date).AddDays(2)
    $certificateThumbprint = $certificate.Thumbprint
    Export-Certificate -Cert $certificate -FilePath $temporaryCertificatePath -Force | Out-Null
    $trustedCertificate = Import-Certificate `
        -FilePath $temporaryCertificatePath `
        -CertStoreLocation "Cert:\CurrentUser\TrustedPeople"
    if ($trustedCertificate.Thumbprint -cne $certificateThumbprint) {
        throw "The temporary WACK trust certificate thumbprint changed during import"
    }

    & $signToolPath sign /fd SHA256 /sha1 $certificateThumbprint /s My $testSignedPackagePath
    if ($LASTEXITCODE -ne 0) {
        throw "SignTool failed to create the disposable WACK test package"
    }
    $testSignature = Get-AuthenticodeSignature -LiteralPath $testSignedPackagePath
    if (
        $testSignature.Status -ne "Valid" -or
        $null -eq $testSignature.SignerCertificate -or
        $testSignature.SignerCertificate.Thumbprint -cne $certificateThumbprint -or
        $testSignature.SignerCertificate.Subject -cne $storeIdentity.package.publisher
    ) {
        throw "The disposable WACK test package signature did not match the confirmed Store Publisher"
    }

    $runtimeProcess = Start-Process `
        -FilePath "powershell.exe" `
        -ArgumentList @(
            "-NoProfile",
            "-NonInteractive",
            "-ExecutionPolicy",
            "Bypass",
            "-File",
            $runtimeTestScriptPath,
            "-PackagePath",
            $testSignedPackagePath,
            "-SignatureOrigin",
            "disposable_test_certificate",
            "-ConfirmDisposableWindows11Environment"
        ) `
        -WindowStyle Hidden `
        -Wait `
        -PassThru
    if ($runtimeProcess.ExitCode -ne 0 -or -not (Test-Path -LiteralPath $runtimeReportPath -PathType Leaf)) {
        throw "The disposable trusted package failed install, launch, uninstall, or cleanup testing"
    }

    & $appCertPath reset
    $resetExitCode = $LASTEXITCODE
    if ($resetExitCode -ne 0) {
        throw "Windows App Certification Kit reset failed with exit code $resetExitCode"
    }
    & $appCertPath test -appxpackagepath $testSignedPackagePath -reportoutputpath $rawReportPath
    $testExitCode = $LASTEXITCODE
    if ($testExitCode -ne 0 -or -not (Test-Path -LiteralPath $rawReportPath -PathType Leaf)) {
        throw "Windows App Certification Kit test failed with exit code $testExitCode"
    }
}
finally {
    $wackProcesses = @(Get-Process -Name "yuanyuan-reminder" -ErrorAction SilentlyContinue)
    foreach ($wackProcess in $wackProcesses) {
        Stop-Process -Id $wackProcess.Id -Force -ErrorAction SilentlyContinue
    }
    if ($wackProcesses.Count -ne 0) {
        Wait-Process -Id @($wackProcesses.Id) -Timeout 10 -ErrorAction SilentlyContinue
    }
    $remainingProcesses = @(Get-Process -Name "yuanyuan-reminder" -ErrorAction SilentlyContinue)
    $wackProcessesStopped = $remainingProcesses.Count -eq 0
    $wackPackages = @(Get-AppxPackage -Name $storeIdentity.package.identityName -ErrorAction SilentlyContinue)
    foreach ($wackPackage in $wackPackages) {
        Remove-AppxPackage -Package $wackPackage.PackageFullName -ErrorAction Stop
    }
    $wackPackageRemoved = @(Get-AppxPackage -Name $storeIdentity.package.identityName -ErrorAction SilentlyContinue).Count -eq 0
    if (-not [string]::IsNullOrWhiteSpace($certificateThumbprint)) {
        Remove-ExactTemporaryCertificate -Thumbprint $certificateThumbprint
    }
    if (Test-Path -LiteralPath $temporaryCertificatePath) {
        Remove-Item -LiteralPath $temporaryCertificatePath -Force
    }
}

$remainingCertificates = @()
foreach ($storePath in @("Cert:\CurrentUser\My", "Cert:\CurrentUser\TrustedPeople")) {
    $remainingCertificates += @(
        Get-ChildItem -Path $storePath -ErrorAction SilentlyContinue |
            Where-Object { $_.Thumbprint -ceq $certificateThumbprint }
    )
}
if ($remainingCertificates.Count -ne 0) {
    throw "The disposable WACK certificate was not fully removed"
}
if (-not $wackProcessesStopped -or -not $wackPackageRemoved) {
    throw "WACK left an application process or package registration behind"
}
$unsignedPackageHashAfter = Get-Sha256 -Path $packagePath
if ($unsignedPackageHashAfter -ne $unsignedPackageHashBefore) {
    throw "WACK testing modified the Store upload candidate"
}

$executionReport = [ordered]@{
    schemaVersion = 1
    mode = "msix_store_wack_execution"
    testedAt = (Get-Date).ToUniversalTime().ToString("o")
    environment = [ordered]@{
        osVersion = [System.Environment]::OSVersion.Version.ToString()
        activeUserSession = $true
        administrator = $true
        operatorConfirmedDisposableWindows11 = $true
    }
    uploadCandidate = [ordered]@{
        path = $candidateReport.candidate.path
        sha256Before = $unsignedPackageHashBefore
        sha256After = $unsignedPackageHashAfter
        remainedUnsignedAndUnmodified = $true
    }
    disposableTestPackage = [ordered]@{
        path = "src-tauri/target/msix-store/wack-test-signed.msix"
        sha256 = Get-Sha256 -Path $testSignedPackagePath
        signatureStatusDuringTest = $testSignature.Status.ToString()
        signerSubject = $testSignature.SignerCertificate.Subject
        signerThumbprint = $certificateThumbprint
        certificatePrivateKeyExportable = $false
        runtimeReportPath = "src-tauri/target/msix-store-runtime/msix-store-runtime-report.json"
        runtimeReportSha256 = Get-Sha256 -Path $runtimeReportPath
    }
    temporaryTrust = [ordered]@{
        certificateStores = @("CurrentUser/My", "CurrentUser/TrustedPeople")
        developerModeModified = $false
        certificateRemovedFromAllStores = $true
        certificateFileRemoved = -not (Test-Path -LiteralPath $temporaryCertificatePath)
    }
    testEnvironmentCleanup = [ordered]@{
        applicationProcessesStopped = $wackProcessesStopped
        packageRegistrationRemoved = $wackPackageRemoved
        passed = $wackProcessesStopped -and $wackPackageRemoved
    }
    tool = [ordered]@{
        appCertPath = $appCertPath
        appCertVersion = (Get-Item -LiteralPath $appCertPath).VersionInfo.FileVersion
        appCertSha256 = Get-Sha256 -Path $appCertPath
        signToolPath = $signToolPath
        signToolVersion = (Get-Item -LiteralPath $signToolPath).VersionInfo.FileVersion
        signToolSha256 = Get-Sha256 -Path $signToolPath
    }
    execution = [ordered]@{
        resetExitCode = $resetExitCode
        testExitCode = $testExitCode
        rawReportPath = "src-tauri/target/msix-store/wack-report.xml"
        rawReportSha256 = Get-Sha256 -Path $rawReportPath
        humanReview = "pending"
        certificationGatePassed = $false
    }
}
$executionReport | ConvertTo-Json -Depth 10 | Set-Content -LiteralPath $executionReportPath -Encoding UTF8
Write-Output "WACK completed with a disposable test-signed clone; the Store upload candidate remained unsigned and unchanged."
Write-Output "Review the XML report before attesting the certification gate: $rawReportPath"
