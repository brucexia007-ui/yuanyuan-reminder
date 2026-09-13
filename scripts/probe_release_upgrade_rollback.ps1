param(
    [string]$ReleaseRoot = "",
    [string]$HistoricalInstallerPath = "",
    [switch]$UseDefaultInstallRoot,
    [switch]$AcknowledgeCleanTestAccount
)

$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"

$historicalVersion = "1.3.2"
$historicalInstallerBytes = 12071368L
$historicalInstallerSha256 = "FD08FAC044D32995FA7BB153A06E5ED092FCCA827DCAA4154608F579541FF4F1"
$historicalInstalledCoreBytes = 20574720L
$historicalInstalledCoreSha256 = "864209F2D6385205CA15E35677C64BA94388B315DB555EBA08369D57717F3FCF"
if ($UseDefaultInstallRoot -and -not $AcknowledgeCleanTestAccount) {
    throw "default-install-root mode requires -AcknowledgeCleanTestAccount"
}
if ($AcknowledgeCleanTestAccount -and -not $UseDefaultInstallRoot) {
    throw "-AcknowledgeCleanTestAccount is valid only with -UseDefaultInstallRoot"
}
$limitations = if ($UseDefaultInstallRoot) {
    @(
        "This probe uses official v1.3.2 installer bytes and the current candidate in the default per-user install directory of an explicitly acknowledged clean Windows test account.",
        "It verifies default-path installer file transitions and data-directory preservation with a synthetic sentinel; it records but does not claim control-panel registration or an authentic historical business database.",
        "Control-panel registration, power loss, mid-file replacement interruption, signed-candidate identity, SmartScreen, and security-software remain separate gates."
    )
}
else {
    @(
        "This probe uses official v1.3.2 installer bytes and the current candidate in an owned per-user temporary installation.",
        "It verifies installer file transitions and default data-directory preservation with a synthetic sentinel; it does not use or claim an authentic historical business database.",
        "Power loss, mid-file replacement interruption, signed-candidate identity, SmartScreen, security-software, and default-install-path behavior remain separate gates."
    )
}

$projectRoot = Split-Path -Parent $PSScriptRoot
if ([string]::IsNullOrWhiteSpace($ReleaseRoot)) {
    $ReleaseRoot = Join-Path $projectRoot "src-tauri\target\release"
}
$releaseRoot = [IO.Path]::GetFullPath($ReleaseRoot)
$package = Get-Content -Raw -Encoding UTF8 -LiteralPath (Join-Path $projectRoot "package.json") |
    ConvertFrom-Json
$tauriConfig = Get-Content -Raw -Encoding UTF8 -LiteralPath (
    Join-Path $projectRoot "src-tauri\tauri.conf.json"
) | ConvertFrom-Json
$candidateVersion = [string]$package.version
$productName = [string]$tauriConfig.productName
$bundleIdentifier = [string]$tauriConfig.identifier
$identifierSegments = @($bundleIdentifier.Split('.'))
$installerManufacturer = if ($identifierSegments.Count -ge 2) {
    [string]$identifierSegments[1]
}
else {
    ""
}
if ([string]::IsNullOrWhiteSpace($installerManufacturer)) {
    throw "Tauri identifier cannot determine the NSIS manufacturer registry key"
}
$brandConfig = Get-Content -Raw -Encoding UTF8 -LiteralPath (Join-Path $projectRoot "product-brand.json") | ConvertFrom-Json
$installerBaseName = [string]$brandConfig.artifacts.installerBaseName
if ([string]::IsNullOrWhiteSpace($installerBaseName) -or $installerBaseName -ne $productName) {
    throw "product brand installer base name must match the Tauri product name"
}
$scriptPath = $MyInvocation.MyCommand.Path
$candidatePayloadPath = Join-Path $releaseRoot "nsis-payload\yuanyuan-reminder.exe"
$candidateInstallerCandidates = @(
    Get-ChildItem -LiteralPath (Join-Path $releaseRoot "bundle\nsis") -File -ErrorAction SilentlyContinue |
        Where-Object { $_.Name -like ("*_{0}_x64-setup.exe" -f $candidateVersion) }
)
if ($candidateInstallerCandidates.Count -ne 1) {
    throw "release bundle must contain exactly one version-matched x64 NSIS installer"
}
$expectedInstallerName = "{0}_{1}_x64-setup.exe" -f $installerBaseName, $candidateVersion
if ($candidateInstallerCandidates[0].Name -cne $expectedInstallerName) {
    throw "release installer name does not match the product brand"
}
$candidateInstallerPath = $candidateInstallerCandidates[0].FullName
$reportPath = Join-Path $releaseRoot $(if ($UseDefaultInstallRoot) {
    "release-default-upgrade-rollback-probe.json"
} else {
    "release-upgrade-rollback-probe.json"
})

function Get-Sha256([string]$Path) {
    (Get-FileHash -Algorithm SHA256 -LiteralPath $Path).Hash
}

function Test-SamePath([AllowNull()][string]$Left, [string]$Right) {
    if ([string]::IsNullOrWhiteSpace($Left)) { return $false }
    $normalizedLeft = [IO.Path]::GetFullPath($Left.Trim('"')).TrimEnd('\')
    $normalizedRight = [IO.Path]::GetFullPath($Right.Trim('"')).TrimEnd('\')
    $normalizedLeft.Equals($normalizedRight, [StringComparison]::OrdinalIgnoreCase)
}

function Test-CurrentUserRegistry64WriteAccess {
    $relativePath = "Software\yuanyuan-release-qa-{0}" -f [Guid]::NewGuid().ToString("N")
    $probeValue = [Guid]::NewGuid().ToString("N")
    $baseKey = $null
    $created = $false
    $writeKey = $null
    try {
        $baseKey = [Microsoft.Win32.RegistryKey]::OpenBaseKey(
            [Microsoft.Win32.RegistryHive]::CurrentUser,
            [Microsoft.Win32.RegistryView]::Registry64
        )
        $writeKey = $baseKey.CreateSubKey($relativePath, $true)
        if ($null -eq $writeKey) { return $false }
        $created = $true
        $writeKey.SetValue("Probe", $probeValue, [Microsoft.Win32.RegistryValueKind]::String)
        $writeKey.Dispose()
        $writeKey = $null

        $readKey = $baseKey.OpenSubKey($relativePath, $false)
        if ($null -eq $readKey) { return $false }
        try {
            return [string]$readKey.GetValue("Probe") -eq $probeValue
        }
        finally {
            $readKey.Dispose()
        }
    }
    catch {
        return $false
    }
    finally {
        if ($null -ne $writeKey) { $writeKey.Dispose() }
        if ($null -ne $baseKey) {
            if ($created) {
                try {
                    $baseKey.DeleteSubKeyTree($relativePath, $false)
                }
                catch {
                    throw "current-user registry writability probe cleanup failed"
                }
            }
            $baseKey.Dispose()
        }
    }
}

function Get-SignatureRecord([string]$Path) {
    $signature = Get-AuthenticodeSignature -LiteralPath $Path
    $signer = $signature.SignerCertificate
    $timestamp = $signature.TimeStamperCertificate
    [ordered]@{
        status = [string]$signature.Status
        signerSubject = if ($null -eq $signer) { $null } else { [string]$signer.Subject }
        signerThumbprint = if ($null -eq $signer) { $null } else { [string]$signer.Thumbprint }
        timestampPresent = $null -ne $timestamp
        timestampSubject = if ($null -eq $timestamp) { $null } else { [string]$timestamp.Subject }
    }
}

function Find-HistoricalInstaller {
    if (-not [string]::IsNullOrWhiteSpace($HistoricalInstallerPath)) {
        $explicitPath = if ([IO.Path]::IsPathRooted($HistoricalInstallerPath)) {
            [IO.Path]::GetFullPath($HistoricalInstallerPath)
        }
        else {
            [IO.Path]::GetFullPath((Join-Path $projectRoot $HistoricalInstallerPath))
        }
        return $explicitPath
    }

    $searchRoots = @(
        (Join-Path $projectRoot "release"),
        (Join-Path $projectRoot "src-tauri\target")
    )
    $matches = New-Object System.Collections.Generic.List[string]
    foreach ($searchRoot in $searchRoots) {
        if (-not (Test-Path -LiteralPath $searchRoot -PathType Container)) { continue }
        foreach ($candidate in @(
            Get-ChildItem -LiteralPath $searchRoot -Recurse -File -ErrorAction SilentlyContinue |
                Where-Object {
                    $_.Name -like "*1.3.2*setup.exe" -and
                    $_.Length -eq $historicalInstallerBytes
                }
        )) {
            if ((Get-Sha256 $candidate.FullName) -eq $historicalInstallerSha256) {
                $matches.Add($candidate.FullName)
            }
        }
    }
    if ($matches.Count -eq 0) {
        throw "official v1.3.2 installer bytes were not found; pass -HistoricalInstallerPath explicitly"
    }
    @($matches | Sort-Object)[0]
}

function Get-InstalledCoreState(
    [string]$InstallRoot,
    [string]$ExpectedVersion,
    [long]$ExpectedBytes,
    [string]$ExpectedSha256
) {
    $applicationPath = Join-Path $InstallRoot "yuanyuan-reminder.exe"
    $uninstallerPath = Join-Path $InstallRoot "uninstall.exe"
    $applicationPresent = Test-Path -LiteralPath $applicationPath -PathType Leaf
    $uninstallerPresent = Test-Path -LiteralPath $uninstallerPath -PathType Leaf
    $actualVersion = if ($applicationPresent) {
        [string](Get-Item -LiteralPath $applicationPath).VersionInfo.ProductVersion
    } else { $null }
    $actualBytes = if ($applicationPresent) {
        [long](Get-Item -LiteralPath $applicationPath).Length
    } else { 0L }
    $actualSha256 = if ($applicationPresent) { Get-Sha256 $applicationPath } else { $null }
    [ordered]@{
        applicationPresent = $applicationPresent
        uninstallerPresent = $uninstallerPresent
        installedProductVersion = $actualVersion
        installedCoreBytes = $actualBytes
        installedCoreSha256 = $actualSha256
        installedCoreMatches = $applicationPresent -and
            $uninstallerPresent -and
            $actualVersion -eq $ExpectedVersion -and
            $actualBytes -eq $ExpectedBytes -and
            $actualSha256 -eq $ExpectedSha256
    }
}

function Get-RegistrationState(
    [string]$UninstallKey,
    [string]$ProductKey,
    [string]$ExpectedInstallRoot,
    [AllowNull()][string]$ExpectedVersion
) {
    $uninstallExists = Test-Path -LiteralPath $UninstallKey
    $productExists = Test-Path -LiteralPath $ProductKey
    $uninstallRoot = $null
    $displayVersion = $null
    if ($uninstallExists) {
        $values = Get-ItemProperty -LiteralPath $UninstallKey
        $uninstallRoot = [string]$values.InstallLocation
        $displayVersion = [string]$values.DisplayVersion
    }
    $productRoot = if ($productExists) {
        [string](Get-Item -LiteralPath $ProductKey).GetValue("")
    } else { $null }
    [ordered]@{
        uninstallRegistrationPresent = $uninstallExists
        productRegistrationPresent = $productExists
        uninstallRootMatches = $uninstallExists -and
            (Test-SamePath $uninstallRoot $ExpectedInstallRoot)
        productRootMatches = $productExists -and
            (Test-SamePath $productRoot $ExpectedInstallRoot)
        displayVersionMatches = $uninstallExists -and
            (($null -eq $ExpectedVersion) -or $displayVersion -eq $ExpectedVersion)
    }
}

function Assert-InstalledState([System.Collections.IDictionary]$State, [string]$Step) {
    if (-not $State.installedCoreMatches) {
        throw "$Step did not produce the exact expected installed application"
    }
}

function Get-RegistrationDisposition([System.Collections.IDictionary]$State) {
    if (
        $State.uninstallRegistrationPresent -and
        $State.productRegistrationPresent -and
        $State.uninstallRootMatches -and
        $State.productRootMatches -and
        $State.displayVersionMatches
    ) {
        return "owned"
    }
    if (
        -not $State.uninstallRegistrationPresent -and
        -not $State.productRegistrationPresent
    ) {
        return "absent"
    }
    "inconsistent"
}

function Test-PostUninstallRegistration(
    [string]$InstallDisposition,
    [System.Collections.IDictionary]$State
) {
    if ($State.uninstallRegistrationPresent) { return $false }
    if ($InstallDisposition -eq "owned") {
        return $State.productRegistrationPresent -and $State.productRootMatches
    }
    if ($InstallDisposition -eq "absent") {
        return -not $State.productRegistrationPresent
    }
    $false
}

function Assert-RegistrationOwned(
    [string]$ProductKey,
    [string]$ExpectedInstallRoot
) {
    if (-not (Test-Path -LiteralPath $ProductKey)) { return }
    $actualRoot = [string](Get-Item -LiteralPath $ProductKey).GetValue("")
    if (-not (Test-SamePath $actualRoot $ExpectedInstallRoot)) {
        throw "refusing to remove product registration outside the owned QA installation"
    }
}

function Test-Sentinel([string]$Path, [string]$ExpectedSha256) {
    (Test-Path -LiteralPath $Path -PathType Leaf) -and
        (Get-Sha256 $Path) -eq $ExpectedSha256
}

function Test-CurrentLicenseBundle(
    [string]$InstallRoot,
    [System.Collections.IDictionary]$ExpectedFiles
) {
    $licenseRoot = Join-Path $InstallRoot "licenses"
    $actualNames = @(
        Get-ChildItem -LiteralPath $licenseRoot -File -ErrorAction SilentlyContinue |
            Select-Object -ExpandProperty Name |
            Sort-Object
    )
    $expectedNames = @($ExpectedFiles.Keys | Sort-Object)
    $filesExact = (ConvertTo-Json @($actualNames) -Compress) -eq
        (ConvertTo-Json @($expectedNames) -Compress)
    $hashesMatch = $filesExact
    foreach ($name in $expectedNames) {
        $installedPath = Join-Path $licenseRoot $name
        if (
            -not (Test-Path -LiteralPath $installedPath -PathType Leaf) -or
            (Get-Sha256 $installedPath) -ne (Get-Sha256 $ExpectedFiles[$name])
        ) {
            $hashesMatch = $false
        }
    }
    [ordered]@{
        licenseFiles = @($actualNames)
        licenseFilesExact = $filesExact
        licenseHashesMatch = $hashesMatch
    }
}

function Test-CurrentLicenseFilesAbsent(
    [string]$InstallRoot,
    [System.Collections.IDictionary]$ExpectedFiles
) {
    foreach ($name in $ExpectedFiles.Keys) {
        if (Test-Path -LiteralPath (Join-Path (Join-Path $InstallRoot "licenses") $name)) {
            return $false
        }
    }
    $true
}

function Invoke-SilentInstall(
    [string]$InstallerPath,
    [string]$InstallRoot,
    [bool]$DefaultPath
) {
    $arguments = @("/S")
    if (-not $DefaultPath) {
        $arguments += "/D=$InstallRoot"
    }
    $process = Start-Process -FilePath $InstallerPath -ArgumentList $arguments -Wait -PassThru
    Start-Sleep -Milliseconds 750
    $process.ExitCode
}

function Invoke-SilentUninstall([string]$InstallRoot) {
    $uninstallerPath = Join-Path $InstallRoot "uninstall.exe"
    if (-not (Test-Path -LiteralPath $uninstallerPath -PathType Leaf)) {
        throw "owned QA uninstaller is missing"
    }
    $process = Start-Process -FilePath $uninstallerPath -ArgumentList "/S" -Wait -PassThru
    Start-Sleep -Milliseconds 750
    $process.ExitCode
}

function Restore-NewShortcut(
    [string]$Path,
    [bool]$Existed,
    [AllowNull()][string]$Sha256,
    [string]$ExpectedTarget
) {
    if ($Existed) {
        return (Test-Path -LiteralPath $Path -PathType Leaf) -and
            (Get-Sha256 $Path) -eq $Sha256
    }
    if (-not (Test-Path -LiteralPath $Path)) { return $true }
    $shell = New-Object -ComObject WScript.Shell
    $actualTarget = [string]$shell.CreateShortcut($Path).TargetPath
    if (-not (Test-SamePath $actualTarget $ExpectedTarget)) {
        throw "refusing to remove a shortcut that does not target the owned QA installation"
    }
    Remove-Item -LiteralPath $Path -Force -ErrorAction Stop
    -not (Test-Path -LiteralPath $Path)
}

function Remove-OwnedDirectory(
    [string]$Path,
    [string]$MarkerName,
    [string]$ExpectedMarker,
    [AllowNull()][string]$RequiredParent
) {
    if (-not (Test-Path -LiteralPath $Path -PathType Container)) { return $true }
    $resolved = [IO.Path]::GetFullPath($Path)
    if (-not [string]::IsNullOrWhiteSpace($RequiredParent)) {
        $parent = [IO.Path]::GetFullPath($RequiredParent).TrimEnd('\') + '\'
        if (-not $resolved.StartsWith($parent, [StringComparison]::OrdinalIgnoreCase)) {
            throw "owned cleanup target escaped its required parent"
        }
    }
    $markerPath = Join-Path $resolved $MarkerName
    if (
        -not (Test-Path -LiteralPath $markerPath -PathType Leaf) -or
        (Get-Content -Raw -Encoding UTF8 -LiteralPath $markerPath) -ne $ExpectedMarker
    ) {
        throw "owned cleanup marker is missing or invalid"
    }
    Remove-Item -LiteralPath $resolved -Recurse -Force -ErrorAction Stop
    -not (Test-Path -LiteralPath $resolved)
}

$historicalInstallerPath = Find-HistoricalInstaller
$requiredFiles = @($historicalInstallerPath, $candidateInstallerPath, $candidatePayloadPath, $scriptPath)
if ([string]::IsNullOrWhiteSpace([string]$brandConfig.assets.licenseFile)) {
    throw "product brand assets.licenseFile is required"
}
$expectedLicenseFiles = [ordered]@{
    "ASSETS_LICENSE.md" = Join-Path $projectRoot ([string]$brandConfig.assets.licenseFile)
    "LICENSE.txt" = Join-Path $projectRoot "LICENSE"
    "THIRD_PARTY_LICENSES.txt" = Join-Path $projectRoot "THIRD_PARTY_LICENSES.txt"
    "THIRD_PARTY_NOTICES.md" = Join-Path $projectRoot "THIRD_PARTY_NOTICES.md"
}
$requiredFiles += @($expectedLicenseFiles.Values)
foreach ($requiredPath in $requiredFiles) {
    if (-not (Test-Path -LiteralPath $requiredPath -PathType Leaf)) {
        throw "required upgrade/rollback probe input is missing: $requiredPath"
    }
    $metadata = Get-Item -LiteralPath $requiredPath -Force
    if (($metadata.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
        throw "upgrade/rollback probe input must not be a reparse point: $requiredPath"
    }
}
if (
    (Get-Item -LiteralPath $historicalInstallerPath).Length -ne $historicalInstallerBytes -or
    (Get-Sha256 $historicalInstallerPath) -ne $historicalInstallerSha256 -or
    [string](Get-Item -LiteralPath $historicalInstallerPath).VersionInfo.ProductVersion -ne
        $historicalVersion
) {
    throw "historical installer does not match the frozen official v1.3.2 release identity"
}
$candidatePayloadBytes = [long](Get-Item -LiteralPath $candidatePayloadPath).Length
$candidatePayloadSha256 = Get-Sha256 $candidatePayloadPath
$candidateInstallerSha256 = Get-Sha256 $candidateInstallerPath

$identity = [Security.Principal.WindowsIdentity]::GetCurrent()
$sid = $identity.User.Value
$profileRegistryQueryAvailable = $true
$profilePath = $null
try {
    $profilePath = [Environment]::ExpandEnvironmentVariables([string](
        Get-ItemProperty -LiteralPath (
            "Registry::HKEY_LOCAL_MACHINE\SOFTWARE\Microsoft\Windows NT\CurrentVersion\ProfileList\{0}" -f $sid
        ) -ErrorAction Stop
    ).ProfileImagePath)
}
catch {
    $profileRegistryQueryAvailable = $false
}
$tokenProfilePathMatchesEnvironment = $profileRegistryQueryAvailable -and
    (Test-SamePath $profilePath $env:USERPROFILE)
$localAppData = [Environment]::GetFolderPath("LocalApplicationData")
$localAppDataMatchesTokenProfile = $profileRegistryQueryAvailable -and
    $localAppData.StartsWith(
        ([IO.Path]::GetFullPath($profilePath).TrimEnd('\') + '\'),
        [StringComparison]::OrdinalIgnoreCase
    )
$currentUserRegistry64Writable = Test-CurrentUserRegistry64WriteAccess

$uninstallKey = "Registry::HKEY_CURRENT_USER\Software\Microsoft\Windows\CurrentVersion\Uninstall\$productName"
$productKey = "Registry::HKEY_CURRENT_USER\Software\$installerManufacturer\$productName"
$runKey = "Registry::HKEY_CURRENT_USER\Software\Microsoft\Windows\CurrentVersion\Run"
$preexistingRunValue = $null
$preexistingRunValuePresent = $false
try {
    $preexistingRunValue = [string](Get-ItemPropertyValue -LiteralPath $runKey -Name $productName -ErrorAction Stop)
    $preexistingRunValuePresent = $true
}
catch {}
$desktopShortcut = Join-Path ([Environment]::GetFolderPath("Desktop")) "$productName.lnk"
$programsShortcut = Join-Path ([Environment]::GetFolderPath("Programs")) "$productName.lnk"
$desktopShortcutExisted = Test-Path -LiteralPath $desktopShortcut
$programsShortcutExisted = Test-Path -LiteralPath $programsShortcut
$preexistingShortcut = $desktopShortcutExisted -or $programsShortcutExisted
$desktopShortcutSha256 = if ($desktopShortcutExisted) { Get-Sha256 $desktopShortcut } else { $null }
$programsShortcutSha256 = if ($programsShortcutExisted) { Get-Sha256 $programsShortcut } else { $null }
$preexistingProcesses = @(Get-Process -Name "yuanyuan-reminder" -ErrorAction SilentlyContinue)
$preexistingRegistration = (Test-Path -LiteralPath $uninstallKey) -or
    (Test-Path -LiteralPath $productKey)
$dataRoot = Join-Path $localAppData $bundleIdentifier
$preexistingDataRoot = Test-Path -LiteralPath $dataRoot
$defaultInstallRoot = Join-Path $localAppData $productName
$preexistingDefaultInstallRoot = Test-Path -LiteralPath $defaultInstallRoot
if (
    -not $identity.IsAuthenticated -or
    -not $profileRegistryQueryAvailable -or
    -not $tokenProfilePathMatchesEnvironment -or
    -not $localAppDataMatchesTokenProfile -or
    $preexistingProcesses.Count -ne 0 -or
    $preexistingRegistration -or
    $preexistingDataRoot -or
    $preexistingDefaultInstallRoot -or
    $preexistingShortcut -or
    $preexistingRunValuePresent
) {
    throw "upgrade/rollback probe requires a clean current-user product and data boundary with a matching token profile"
}

$runId = (Get-Date).ToUniversalTime().ToString("yyyyMMddTHHmmssfffZ")
$qaBase = Join-Path $localAppData "Temp"
$qaRoot = Join-Path $qaBase "yuanyuan-upgrade-rollback-$runId"
$installRoot = if ($UseDefaultInstallRoot) {
    $defaultInstallRoot
} else {
    Join-Path $qaRoot "installed"
}
$qaMarkerName = ".yuanyuan-upgrade-rollback-v1"
$qaMarkerValue = "YUANYUAN_UPGRADE_ROLLBACK_QA_V1`n"
$dataMarkerName = ".yuanyuan-upgrade-rollback-data-v1"
$dataMarkerValue = "YUANYUAN_UPGRADE_ROLLBACK_DATA_V1`n"
$sentinelPath = Join-Path $dataRoot "upgrade-rollback-sentinel.txt"
$sentinelValue = "YUANYUAN_UPGRADE_ROLLBACK_SENTINEL_V1:$runId`n"
$report = $null
$qaRootRemoved = $false
$dataRootRemoved = $false

if ((Test-Path -LiteralPath $qaRoot) -or (Test-Path -LiteralPath $dataRoot)) {
    throw "refusing to reuse an existing upgrade/rollback probe boundary"
}
New-Item -ItemType Directory -Path $qaRoot | Out-Null
[IO.File]::WriteAllText(
    (Join-Path $qaRoot $qaMarkerName),
    $qaMarkerValue,
    [Text.UTF8Encoding]::new($false)
)
New-Item -ItemType Directory -Path $dataRoot | Out-Null
[IO.File]::WriteAllText(
    (Join-Path $dataRoot $dataMarkerName),
    $dataMarkerValue,
    [Text.UTF8Encoding]::new($false)
)
[IO.File]::WriteAllText($sentinelPath, $sentinelValue, [Text.UTF8Encoding]::new($false))
$sentinelSha256 = Get-Sha256 $sentinelPath

try {
    $historicalInstallExitCode = Invoke-SilentInstall `
        $historicalInstallerPath `
        $installRoot `
        $UseDefaultInstallRoot.IsPresent
    $historicalInstallState = Get-InstalledCoreState `
        $installRoot `
        $historicalVersion `
        $historicalInstalledCoreBytes `
        $historicalInstalledCoreSha256
    Assert-InstalledState $historicalInstallState "historical install"
    $historicalRegistration = Get-RegistrationState `
        $uninstallKey `
        $productKey `
        $installRoot `
        $historicalVersion
    $historicalRegistrationDisposition = Get-RegistrationDisposition $historicalRegistration
    $historicalLicenseFilesAbsent = Test-CurrentLicenseFilesAbsent `
        $installRoot `
        $expectedLicenseFiles
    $sentinelAfterHistoricalInstall = Test-Sentinel $sentinelPath $sentinelSha256

    $candidateUpgradeExitCode = Invoke-SilentInstall `
        $candidateInstallerPath `
        $installRoot `
        $UseDefaultInstallRoot.IsPresent
    $candidateUpgradeState = Get-InstalledCoreState `
        $installRoot `
        $candidateVersion `
        $candidatePayloadBytes `
        $candidatePayloadSha256
    Assert-InstalledState $candidateUpgradeState "candidate upgrade"
    $candidateRegistration = Get-RegistrationState `
        $uninstallKey `
        $productKey `
        $installRoot `
        $candidateVersion
    $candidateRegistrationDisposition = Get-RegistrationDisposition $candidateRegistration
    $candidateLicenses = Test-CurrentLicenseBundle $installRoot $expectedLicenseFiles
    $sentinelAfterCandidateUpgrade = Test-Sentinel $sentinelPath $sentinelSha256

    $candidateUninstallExitCode = Invoke-SilentUninstall $installRoot
    $registrationAfterCandidateUninstall = Get-RegistrationState `
        $uninstallKey `
        $productKey `
        $installRoot `
        $null
    $candidatePostUninstallRegistrationConsistent = Test-PostUninstallRegistration `
        $candidateRegistrationDisposition `
        $registrationAfterCandidateUninstall
    $candidateInstallRootRemoved = -not (Test-Path -LiteralPath $installRoot)
    $sentinelAfterCandidateUninstall = Test-Sentinel $sentinelPath $sentinelSha256

    $historicalRollbackExitCode = Invoke-SilentInstall `
        $historicalInstallerPath `
        $installRoot `
        $UseDefaultInstallRoot.IsPresent
    $historicalRollbackState = Get-InstalledCoreState `
        $installRoot `
        $historicalVersion `
        $historicalInstalledCoreBytes `
        $historicalInstalledCoreSha256
    Assert-InstalledState $historicalRollbackState "historical rollback install"
    $historicalRollbackRegistration = Get-RegistrationState `
        $uninstallKey `
        $productKey `
        $installRoot `
        $historicalVersion
    $historicalRollbackRegistrationDisposition = Get-RegistrationDisposition `
        $historicalRollbackRegistration
    $currentLicenseFilesAbsentAfterRollback = Test-CurrentLicenseFilesAbsent `
        $installRoot `
        $expectedLicenseFiles
    $sentinelAfterHistoricalRollback = Test-Sentinel $sentinelPath $sentinelSha256

    $historicalUninstallExitCode = Invoke-SilentUninstall $installRoot
    $registrationAfterHistoricalUninstall = Get-RegistrationState `
        $uninstallKey `
        $productKey `
        $installRoot `
        $null
    $historicalPostUninstallRegistrationConsistent = Test-PostUninstallRegistration `
        $historicalRollbackRegistrationDisposition `
        $registrationAfterHistoricalUninstall
    $historicalInstallRootRemoved = -not (Test-Path -LiteralPath $installRoot)
    $sentinelAfterHistoricalUninstall = Test-Sentinel $sentinelPath $sentinelSha256

    Assert-RegistrationOwned $productKey $installRoot
    if (Test-Path -LiteralPath $productKey) {
        Remove-Item -LiteralPath $productKey -Recurse -Force -ErrorAction Stop
    }
    $desktopShortcutStatePreserved = Restore-NewShortcut `
        $desktopShortcut `
        $desktopShortcutExisted `
        $desktopShortcutSha256 `
        (Join-Path $installRoot "yuanyuan-reminder.exe")
    $startMenuShortcutStatePreserved = Restore-NewShortcut `
        $programsShortcut `
        $programsShortcutExisted `
        $programsShortcutSha256 `
        (Join-Path $installRoot "yuanyuan-reminder.exe")
    $dataRootRemoved = Remove-OwnedDirectory `
        $dataRoot `
        $dataMarkerName `
        $dataMarkerValue `
        $localAppData

    $report = [ordered]@{
        schemaVersion = 2
        generatedAt = (Get-Date).ToUniversalTime().ToString("o")
        mode = if ($UseDefaultInstallRoot) {
            "release_default_upgrade_rollback_probe"
        } else {
            "release_upgrade_rollback_probe"
        }
        ready = $false
        bindings = [ordered]@{
            probeScriptSha256 = Get-Sha256 $scriptPath
            historicalInstallerSha256 = Get-Sha256 $historicalInstallerPath
            historicalInstalledCoreSha256 = $historicalInstalledCoreSha256
            candidateInstallerSha256 = $candidateInstallerSha256
            candidateInstalledCoreSha256 = $candidatePayloadSha256
        }
        versions = [ordered]@{
            historical = $historicalVersion
            candidate = $candidateVersion
        }
        installBoundary = [ordered]@{
            mode = if ($UseDefaultInstallRoot) { "default_per_user" } else { "custom_temporary" }
            cleanTestAccountAcknowledged = $AcknowledgeCleanTestAccount.IsPresent
            defaultInstallRootUsed = $UseDefaultInstallRoot.IsPresent
            customTemporaryInstallRootUsed = -not $UseDefaultInstallRoot.IsPresent
            registrationGatePassed = $historicalRegistrationDisposition -eq "owned" -and
                $candidateRegistrationDisposition -eq "owned" -and
                $historicalRollbackRegistrationDisposition -eq "owned" -and
                $candidatePostUninstallRegistrationConsistent -and
                $historicalPostUninstallRegistrationConsistent -and
                $currentUserRegistry64Writable
        }
        environment = [ordered]@{
            currentUserAuthenticated = [bool]$identity.IsAuthenticated
            profileRegistryQueryAvailable = $profileRegistryQueryAvailable
            tokenProfilePathMatchesEnvironment = $tokenProfilePathMatchesEnvironment
            localAppDataMatchesTokenProfile = $localAppDataMatchesTokenProfile
            currentUserRegistry64Writable = $currentUserRegistry64Writable
            preexistingApplicationProcessCount = $preexistingProcesses.Count
            preexistingProductRegistration = $preexistingRegistration
            preexistingDataRoot = $preexistingDataRoot
            preexistingDefaultInstallRoot = $preexistingDefaultInstallRoot
            preexistingShortcut = $preexistingShortcut
            preexistingRunValue = $preexistingRunValuePresent
        }
        steps = [ordered]@{
            historicalInstall = [ordered]@{
                installExitCode = $historicalInstallExitCode
                installedProductVersion = $historicalInstallState.installedProductVersion
                installedCoreBytes = $historicalInstallState.installedCoreBytes
                installedCoreSha256 = $historicalInstallState.installedCoreSha256
                installedCoreMatches = $historicalInstallState.installedCoreMatches
                uninstallRootMatches = $historicalRegistration.uninstallRootMatches
                productRootMatches = $historicalRegistration.productRootMatches
                displayVersionMatches = $historicalRegistration.displayVersionMatches
                registrationDisposition = $historicalRegistrationDisposition
                currentLicenseFilesAbsent = $historicalLicenseFilesAbsent
                sentinelPreserved = $sentinelAfterHistoricalInstall
            }
            candidateUpgrade = [ordered]@{
                installExitCode = $candidateUpgradeExitCode
                installedProductVersion = $candidateUpgradeState.installedProductVersion
                installedCoreBytes = $candidateUpgradeState.installedCoreBytes
                installedCoreSha256 = $candidateUpgradeState.installedCoreSha256
                installedCoreMatches = $candidateUpgradeState.installedCoreMatches
                uninstallRootMatches = $candidateRegistration.uninstallRootMatches
                productRootMatches = $candidateRegistration.productRootMatches
                displayVersionMatches = $candidateRegistration.displayVersionMatches
                registrationDisposition = $candidateRegistrationDisposition
                licenseFiles = @($candidateLicenses.licenseFiles)
                licenseFilesExact = $candidateLicenses.licenseFilesExact
                licenseHashesMatch = $candidateLicenses.licenseHashesMatch
                sentinelPreserved = $sentinelAfterCandidateUpgrade
            }
            candidateUninstallBeforeRollback = [ordered]@{
                uninstallExitCode = $candidateUninstallExitCode
                installRootRemoved = $candidateInstallRootRemoved
                uninstallRegistrationRemoved = -not $registrationAfterCandidateUninstall.uninstallRegistrationPresent
                productRegistrationPresent = $registrationAfterCandidateUninstall.productRegistrationPresent
                productRootMatches = $registrationAfterCandidateUninstall.productRootMatches
                productRegistrationPreserved = $registrationAfterCandidateUninstall.productRegistrationPresent -and
                    $registrationAfterCandidateUninstall.productRootMatches
                registrationBoundaryConsistent = $candidatePostUninstallRegistrationConsistent
                sentinelPreserved = $sentinelAfterCandidateUninstall
            }
            historicalRollback = [ordered]@{
                installExitCode = $historicalRollbackExitCode
                installedProductVersion = $historicalRollbackState.installedProductVersion
                installedCoreBytes = $historicalRollbackState.installedCoreBytes
                installedCoreSha256 = $historicalRollbackState.installedCoreSha256
                installedCoreMatches = $historicalRollbackState.installedCoreMatches
                uninstallRootMatches = $historicalRollbackRegistration.uninstallRootMatches
                productRootMatches = $historicalRollbackRegistration.productRootMatches
                displayVersionMatches = $historicalRollbackRegistration.displayVersionMatches
                registrationDisposition = $historicalRollbackRegistrationDisposition
                currentLicenseFilesAbsent = $currentLicenseFilesAbsentAfterRollback
                sentinelPreserved = $sentinelAfterHistoricalRollback
            }
            historicalUninstall = [ordered]@{
                uninstallExitCode = $historicalUninstallExitCode
                installRootRemoved = $historicalInstallRootRemoved
                uninstallRegistrationRemoved = -not $registrationAfterHistoricalUninstall.uninstallRegistrationPresent
                productRegistrationPresent = $registrationAfterHistoricalUninstall.productRegistrationPresent
                productRootMatches = $registrationAfterHistoricalUninstall.productRootMatches
                productRegistrationPreserved = $registrationAfterHistoricalUninstall.productRegistrationPresent -and
                    $registrationAfterHistoricalUninstall.productRootMatches
                registrationBoundaryConsistent = $historicalPostUninstallRegistrationConsistent
                sentinelPreserved = $sentinelAfterHistoricalUninstall
            }
        }
        dataBoundary = [ordered]@{
            defaultLocalDataDirectoryUsed = $true
            syntheticSentinelOnly = $true
            authenticHistoricalDatabaseUsed = $false
            sentinelSha256 = $sentinelSha256
            sentinelPreservedAtEveryStep = $sentinelAfterHistoricalInstall -and
                $sentinelAfterCandidateUpgrade -and
                $sentinelAfterCandidateUninstall -and
                $sentinelAfterHistoricalRollback -and
                $sentinelAfterHistoricalUninstall
        }
        signatures = [ordered]@{
            historicalInstaller = Get-SignatureRecord $historicalInstallerPath
            candidateInstaller = Get-SignatureRecord $candidateInstallerPath
        }
        cleanup = [ordered]@{
            ownedProductRegistrationRemoved = -not (Test-Path -LiteralPath $productKey)
            desktopShortcutStatePreserved = $desktopShortcutStatePreserved
            startMenuShortcutStatePreserved = $startMenuShortcutStatePreserved
            dataRootRemoved = $dataRootRemoved
            qaRootRemoved = $false
            applicationProcessCount = @(Get-Process -Name "yuanyuan-reminder" -ErrorAction SilentlyContinue).Count
        }
        limitations = $limitations
    }
}
finally {
    if (Test-Path -LiteralPath (Join-Path $installRoot "uninstall.exe") -PathType Leaf) {
        try { Invoke-SilentUninstall $installRoot | Out-Null } catch {}
    }
    if (Test-Path -LiteralPath $uninstallKey) {
        $registration = Get-RegistrationState $uninstallKey $productKey $installRoot $null
        if ($registration.uninstallRootMatches) {
            Remove-Item -LiteralPath $uninstallKey -Recurse -Force -ErrorAction SilentlyContinue
        }
    }
    if (Test-Path -LiteralPath $productKey) {
        Assert-RegistrationOwned $productKey $installRoot
        Remove-Item -LiteralPath $productKey -Recurse -Force -ErrorAction SilentlyContinue
    }
    Restore-NewShortcut `
        $desktopShortcut `
        $desktopShortcutExisted `
        $desktopShortcutSha256 `
        (Join-Path $installRoot "yuanyuan-reminder.exe") | Out-Null
    Restore-NewShortcut `
        $programsShortcut `
        $programsShortcutExisted `
        $programsShortcutSha256 `
        (Join-Path $installRoot "yuanyuan-reminder.exe") | Out-Null
    if (Test-Path -LiteralPath $dataRoot -PathType Container) {
        $dataRootRemoved = Remove-OwnedDirectory `
            $dataRoot `
            $dataMarkerName `
            $dataMarkerValue `
            $localAppData
    }
    $qaRootRemoved = Remove-OwnedDirectory `
        $qaRoot `
        $qaMarkerName `
        $qaMarkerValue `
        $qaBase
}

if ($null -eq $report) {
    throw "upgrade/rollback probe did not produce a report"
}
$report.cleanup.dataRootRemoved = $dataRootRemoved
$report.cleanup.qaRootRemoved = $qaRootRemoved
$report.ready =
    $report.environment.currentUserAuthenticated -and
    $report.environment.profileRegistryQueryAvailable -and
    $report.environment.tokenProfilePathMatchesEnvironment -and
    $report.environment.localAppDataMatchesTokenProfile -and
    $report.environment.preexistingApplicationProcessCount -eq 0 -and
    -not $report.environment.preexistingProductRegistration -and
    -not $report.environment.preexistingDataRoot -and
    -not $report.environment.preexistingDefaultInstallRoot -and
    -not $report.environment.preexistingShortcut -and
    -not $report.environment.preexistingRunValue -and
    (($report.installBoundary.mode -eq "default_per_user" -and
        $report.installBoundary.cleanTestAccountAcknowledged -and
        $report.installBoundary.defaultInstallRootUsed -and
        -not $report.installBoundary.customTemporaryInstallRootUsed) -or
      ($report.installBoundary.mode -eq "custom_temporary" -and
        -not $report.installBoundary.cleanTestAccountAcknowledged -and
        -not $report.installBoundary.defaultInstallRootUsed -and
        $report.installBoundary.customTemporaryInstallRootUsed)) -and
    $report.steps.historicalInstall.installExitCode -eq 0 -and
    $report.steps.historicalInstall.installedCoreMatches -and
    $report.steps.historicalInstall.registrationDisposition -ne "inconsistent" -and
    $report.steps.historicalInstall.currentLicenseFilesAbsent -and
    $report.steps.historicalInstall.sentinelPreserved -and
    $report.steps.candidateUpgrade.installExitCode -eq 0 -and
    $report.steps.candidateUpgrade.installedCoreMatches -and
    $report.steps.candidateUpgrade.registrationDisposition -eq
        $report.steps.historicalInstall.registrationDisposition -and
    $report.steps.candidateUpgrade.licenseFilesExact -and
    $report.steps.candidateUpgrade.licenseHashesMatch -and
    $report.steps.candidateUpgrade.sentinelPreserved -and
    $report.steps.candidateUninstallBeforeRollback.uninstallExitCode -eq 0 -and
    $report.steps.candidateUninstallBeforeRollback.installRootRemoved -and
    $report.steps.candidateUninstallBeforeRollback.uninstallRegistrationRemoved -and
    $report.steps.candidateUninstallBeforeRollback.registrationBoundaryConsistent -and
    $report.steps.candidateUninstallBeforeRollback.sentinelPreserved -and
    $report.steps.historicalRollback.installExitCode -eq 0 -and
    $report.steps.historicalRollback.installedCoreMatches -and
    $report.steps.historicalRollback.registrationDisposition -eq
        $report.steps.historicalInstall.registrationDisposition -and
    $report.steps.historicalRollback.currentLicenseFilesAbsent -and
    $report.steps.historicalRollback.sentinelPreserved -and
    $report.steps.historicalUninstall.uninstallExitCode -eq 0 -and
    $report.steps.historicalUninstall.installRootRemoved -and
    $report.steps.historicalUninstall.uninstallRegistrationRemoved -and
    $report.steps.historicalUninstall.registrationBoundaryConsistent -and
    $report.steps.historicalUninstall.sentinelPreserved -and
    $report.dataBoundary.defaultLocalDataDirectoryUsed -and
    $report.dataBoundary.syntheticSentinelOnly -and
    -not $report.dataBoundary.authenticHistoricalDatabaseUsed -and
    $report.dataBoundary.sentinelPreservedAtEveryStep -and
    $report.cleanup.ownedProductRegistrationRemoved -and
    $report.cleanup.desktopShortcutStatePreserved -and
    $report.cleanup.startMenuShortcutStatePreserved -and
    $report.cleanup.dataRootRemoved -and
    $report.cleanup.qaRootRemoved -and
    $report.cleanup.applicationProcessCount -eq 0

$report | ConvertTo-Json -Depth 10 | Set-Content -Encoding UTF8 -LiteralPath $reportPath
Write-Output "Release upgrade/rollback probe report written: $reportPath"
if (-not $report.ready) { exit 2 }
