[CmdletBinding()]
param()

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$projectRoot = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot ".."))
$targetRoot = [System.IO.Path]::GetFullPath((Join-Path $projectRoot "src-tauri\target\msix-preview"))
$packagePath = Join-Path $targetRoot "YuanyuanReminder_1.4.0_x64-preview.msix"
$reportPath = Join-Path $targetRoot "msix-preview-install-report.json"
$errorLogPath = Join-Path $targetRoot "msix-preview-install-error.log"
$previewVerifierPath = Join-Path $projectRoot "scripts\verify_msix_preview.mjs"
$packageName = "Yuanyuan.Reminder.Preview"

trap {
    $errorText = ($_ | Format-List * -Force | Out-String)
    $errorText | Set-Content -LiteralPath $errorLogPath -Encoding UTF8
    exit 1
}

function Get-Sha256 {
    param([Parameter(Mandatory = $true)][string]$Path)
    return (Get-FileHash -Algorithm SHA256 -LiteralPath $Path).Hash
}

function Assert-OwnedGeneratedFile {
    param([Parameter(Mandatory = $true)][string]$Path)
    $resolved = [System.IO.Path]::GetFullPath($Path)
    $ownedPrefix = $targetRoot.TrimEnd([System.IO.Path]::DirectorySeparatorChar) + [System.IO.Path]::DirectorySeparatorChar
    if (-not $resolved.StartsWith($ownedPrefix, [System.StringComparison]::OrdinalIgnoreCase)) {
        throw "Refusing to modify a file outside the owned MSIX target: $resolved"
    }
}

if ($env:OS -ne "Windows_NT") {
    throw "The MSIX preview install test requires Windows 11"
}
$currentIdentity = [System.Security.Principal.WindowsIdentity]::GetCurrent()
$currentPrincipal = New-Object System.Security.Principal.WindowsPrincipal($currentIdentity)
if (-not $currentPrincipal.IsInRole([System.Security.Principal.WindowsBuiltInRole]::Administrator)) {
    throw "Unsigned MSIX packages with executable content require an elevated Administrator PowerShell session"
}
Assert-OwnedGeneratedFile -Path $reportPath
Assert-OwnedGeneratedFile -Path $errorLogPath
if (Test-Path -LiteralPath $reportPath) {
    Remove-Item -LiteralPath $reportPath -Force
}
if (Test-Path -LiteralPath $errorLogPath) {
    Remove-Item -LiteralPath $errorLogPath -Force
}
if (-not (Test-Path -LiteralPath $packagePath -PathType Leaf)) {
    throw "Build and verify the unsigned MSIX preview before running the install test"
}

Push-Location $projectRoot
try {
    & node $previewVerifierPath
    if ($LASTEXITCODE -ne 0) {
        throw "Unsigned MSIX preview verification failed before install testing"
    }
}
finally {
    Pop-Location
}

$preexistingPackages = @(Get-AppxPackage -Name $packageName -ErrorAction SilentlyContinue)
if ($preexistingPackages.Count -ne 0) {
    throw "A pre-existing $packageName package is registered; refusing to alter it"
}

$packageHashBefore = Get-Sha256 -Path $packagePath
$registeredPackage = $null
$packageFullName = $null
$packageFamilyName = $null
$installPassed = $false

try {
    Add-AppxPackage -Path $packagePath -AllowUnsigned -ErrorAction Stop
    $matches = @(Get-AppxPackage -Name $packageName -ErrorAction Stop)
    if ($matches.Count -ne 1) {
        throw "Expected one installed MSIX preview package, found $($matches.Count)"
    }
    $registeredPackage = $matches[0]
    if (
        $registeredPackage.Name -ne $packageName -or
        $registeredPackage.Publisher -ne "CN=YuanyuanReminderPreview, OID.2.25.311729368913984317654407730594956997722=1" -or
        $registeredPackage.Architecture.ToString() -ne "X64" -or
        $registeredPackage.Version.ToString() -ne "1.4.0.0"
    ) {
        throw "Installed MSIX preview identity does not match the unsigned manifest contract"
    }
    $packageFullName = $registeredPackage.PackageFullName
    $packageFamilyName = $registeredPackage.PackageFamilyName
    $installPassed = $true
}
finally {
    if ($null -ne $registeredPackage) {
        Remove-AppxPackage -Package $registeredPackage.PackageFullName -ErrorAction Stop
    }
}

$remainingPackages = @(Get-AppxPackage -Name $packageName -ErrorAction SilentlyContinue)
$packageHashAfter = Get-Sha256 -Path $packagePath
$cleanupPassed =
    $remainingPackages.Count -eq 0 -and
    $packageHashAfter -eq $packageHashBefore
if (-not $installPassed -or -not $cleanupPassed) {
    throw "MSIX preview install test or cleanup did not complete"
}

$report = [ordered]@{
    schemaVersion = 1
    mode = "msix_preview_install_test"
    testedAt = (Get-Date).ToUniversalTime().ToString("o")
    candidate = [ordered]@{
        path = "src-tauri/target/msix-preview/YuanyuanReminder_1.4.0_x64-preview.msix"
        sha256Before = $packageHashBefore
        sha256After = $packageHashAfter
        unsignedNamespace = "OID.2.25.311729368913984317654407730594956997722"
        allowUnsignedUsed = $true
        remainedUnsignedAndUnmodified = $true
    }
    registration = [ordered]@{
        packageName = $packageName
        packageFullName = $packageFullName
        packageFamilyName = $packageFamilyName
        architecture = "X64"
        version = "1.4.0.0"
        installed = $true
        applicationLaunched = $false
    }
    cleanup = [ordered]@{
        packageRemoved = $remainingPackages.Count -eq 0
        candidatePreserved = $packageHashAfter -eq $packageHashBefore
        certificateStoreModified = $false
        developerModeModified = $false
        passed = $cleanupPassed
    }
    sources = [ordered]@{
        installTestScriptSha256 = Get-Sha256 -Path $PSCommandPath
        previewVerifierSha256 = Get-Sha256 -Path $previewVerifierPath
    }
    limitations = @(
        "The application was deliberately not launched, so no runtime, notification, autostart, WebView2, single-instance, or user-data behavior was tested.",
        "AllowUnsigned and the dedicated OID namespace are for local Windows 11 development testing only, not public distribution.",
        "Store-assigned identity, Store-managed signing, certification, updates, migration, and uninstall data behavior remain pending."
    )
}
$report | ConvertTo-Json -Depth 10 | Set-Content -LiteralPath $reportPath -Encoding UTF8
Write-Output "Unsigned MSIX preview install and cleanup test passed: $reportPath"
