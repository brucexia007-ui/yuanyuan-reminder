param(
    [string]$ReleaseRoot = ""
)

$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"

$projectRoot = Split-Path -Parent $PSScriptRoot
if ([string]::IsNullOrWhiteSpace($ReleaseRoot)) {
    $ReleaseRoot = Join-Path $projectRoot "src-tauri\target\release"
}
$releaseRoot = [IO.Path]::GetFullPath($ReleaseRoot)
$packagePath = Join-Path $projectRoot "package.json"
$package = Get-Content -Raw -Encoding UTF8 -LiteralPath $packagePath | ConvertFrom-Json
$tauriConfigPath = Join-Path $projectRoot "src-tauri\tauri.conf.json"
$tauriConfig = Get-Content -Raw -Encoding UTF8 -LiteralPath $tauriConfigPath | ConvertFrom-Json
$productName = [string]$tauriConfig.productName
$sourcePath = Join-Path $releaseRoot "yuanyuan-reminder.exe"
$installerCandidates = @(
    Get-ChildItem -LiteralPath (Join-Path $releaseRoot "bundle\nsis") -File -ErrorAction SilentlyContinue |
        Where-Object { $_.Name -like ("*_{0}_x64-setup.exe" -f [string]$package.version) }
)
if ($installerCandidates.Count -ne 1) {
    throw "release bundle must contain exactly one version-matched x64 NSIS installer"
}
$installerPath = $installerCandidates[0].FullName
$payloadRoot = Join-Path $releaseRoot "nsis-payload"
$payloadPath = Join-Path $payloadRoot "yuanyuan-reminder.exe"
$reportPath = Join-Path $releaseRoot "nsis-installed-payload.json"
$scriptPath = $MyInvocation.MyCommand.Path
$runId = (Get-Date).ToUniversalTime().ToString("yyyyMMddTHHmmssZ")
$qaRoot = Join-Path ([IO.Path]::GetTempPath()) "yuanyuan-nsis-payload-$runId"
$installRoot = Join-Path $qaRoot "installed"
$markerPath = Join-Path $qaRoot ".yuanyuan-nsis-payload-v1"
$pendingPayloadPath = Join-Path $qaRoot "yuanyuan-reminder.exe"
$expectedMarker = "YUANYUAN_NSIS_PAYLOAD_QA_V1`n"
$sourceMarker = "__TAURI_BUNDLE_TYPE_VAR_UNK"
$installedMarker = "__TAURI_BUNDLE_TYPE_VAR_NSS"
$expectedLicenseFiles = [ordered]@{
    "ASSETS_LICENSE.md" = Join-Path $projectRoot "ASSETS_LICENSE.md"
    "LICENSE.txt" = Join-Path $projectRoot "LICENSE"
    "THIRD_PARTY_LICENSES.txt" = Join-Path $projectRoot "THIRD_PARTY_LICENSES.txt"
    "THIRD_PARTY_NOTICES.md" = Join-Path $projectRoot "THIRD_PARTY_NOTICES.md"
}
$uninstallKey = "Registry::HKEY_CURRENT_USER\Software\Microsoft\Windows\CurrentVersion\Uninstall\$productName"
$productKey = "Registry::HKEY_CURRENT_USER\Software\yuanyuan\$productName"
$desktopShortcut = Join-Path ([Environment]::GetFolderPath("Desktop")) "$productName.lnk"
$programsShortcut = Join-Path ([Environment]::GetFolderPath("Programs")) "$productName.lnk"

function Get-Sha256([string]$Path) {
    (Get-FileHash -Algorithm SHA256 -LiteralPath $Path).Hash
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

function Count-Marker([byte[]]$Bytes, [string]$Marker) {
    $text = [Text.Encoding]::ASCII.GetString($Bytes)
    $count = 0
    $offset = 0
    while ($true) {
        $offset = $text.IndexOf($Marker, $offset, [StringComparison]::Ordinal)
        if ($offset -lt 0) { break }
        $count += 1
        $offset += $Marker.Length
    }
    $count
}

function Restore-ShortcutState(
    [string]$Path,
    [bool]$Existed,
    [AllowNull()][string]$Sha256,
    [string]$ExpectedQaTarget
) {
    if ($Existed) {
        return (Test-Path -LiteralPath $Path -PathType Leaf) -and
            (Get-Sha256 $Path) -eq $Sha256
    }
    if (-not (Test-Path -LiteralPath $Path)) { return $true }
    $shell = New-Object -ComObject WScript.Shell
    $shortcut = $shell.CreateShortcut($Path)
    $actualTarget = [IO.Path]::GetFullPath([string]$shortcut.TargetPath)
    $expectedTarget = [IO.Path]::GetFullPath($ExpectedQaTarget)
    if (-not $actualTarget.Equals($expectedTarget, [StringComparison]::OrdinalIgnoreCase)) {
        throw "refusing to remove a shortcut that does not target the owned QA installation: actual=$actualTarget expected=$expectedTarget"
    }
    Remove-Item -LiteralPath $Path -Force -ErrorAction Stop
    -not (Test-Path -LiteralPath $Path)
}

function Remove-OwnedQaRoot([string]$Path) {
    if (-not (Test-Path -LiteralPath $Path -PathType Container)) { return $true }
    $resolved = [IO.Path]::GetFullPath($Path)
    $tempRoot = [IO.Path]::GetFullPath([IO.Path]::GetTempPath()).TrimEnd('\') + '\'
    if (-not $resolved.StartsWith($tempRoot, [StringComparison]::OrdinalIgnoreCase)) {
        throw "QA cleanup target escaped the system temporary directory"
    }
    $ownedMarker = Join-Path $resolved ".yuanyuan-nsis-payload-v1"
    if (
        -not (Test-Path -LiteralPath $ownedMarker -PathType Leaf) -or
        (Get-Content -Raw -Encoding UTF8 -LiteralPath $ownedMarker) -ne $expectedMarker
    ) {
        throw "QA cleanup marker is missing or invalid"
    }
    Remove-Item -LiteralPath $resolved -Recurse -Force -ErrorAction Stop
    -not (Test-Path -LiteralPath $resolved)
}

foreach ($required in @($sourcePath, $installerPath, $scriptPath)) {
    if (-not (Test-Path -LiteralPath $required -PathType Leaf)) {
        throw "required NSIS payload input is missing: $required"
    }
    $metadata = Get-Item -LiteralPath $required -Force
    if (($metadata.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
        throw "required NSIS payload input must not be a reparse point: $required"
    }
}
foreach ($licensePath in $expectedLicenseFiles.Values) {
    if (-not (Test-Path -LiteralPath $licensePath -PathType Leaf)) {
        throw "required license material is missing: $licensePath"
    }
}

$identity = [Security.Principal.WindowsIdentity]::GetCurrent()
$sid = $identity.User.Value
$profileRegistryQueryAvailable = $true
$profilePath = $null
try {
    $profilePath = (Get-ItemProperty -LiteralPath (
        "Registry::HKEY_LOCAL_MACHINE\SOFTWARE\Microsoft\Windows NT\CurrentVersion\ProfileList\{0}" -f $sid
    ) -ErrorAction Stop).ProfileImagePath
}
catch {
    $profileRegistryQueryAvailable = $false
}
$tokenProfilePathMatchesEnvironment = $profileRegistryQueryAvailable -and
    [IO.Path]::GetFullPath($profilePath).TrimEnd('\').Equals(
        [IO.Path]::GetFullPath($env:USERPROFILE).TrimEnd('\'),
        [StringComparison]::OrdinalIgnoreCase
    )
$preexistingProcesses = @(Get-Process -Name "yuanyuan-reminder" -ErrorAction SilentlyContinue)
$preexistingRegistration = (Test-Path -LiteralPath $uninstallKey) -or
    (Test-Path -LiteralPath $productKey)
$preexistingShortcut = (Test-Path -LiteralPath $desktopShortcut) -or
    (Test-Path -LiteralPath $programsShortcut)
$desktopShortcutExisted = Test-Path -LiteralPath $desktopShortcut
$programsShortcutExisted = Test-Path -LiteralPath $programsShortcut
$desktopShortcutSha256 = if ($desktopShortcutExisted) { Get-Sha256 $desktopShortcut } else { $null }
$programsShortcutSha256 = if ($programsShortcutExisted) { Get-Sha256 $programsShortcut } else { $null }
if (
    -not $identity.IsAuthenticated -or
    -not $profileRegistryQueryAvailable -or
    -not $tokenProfilePathMatchesEnvironment -or
    $preexistingProcesses.Count -ne 0 -or
    $preexistingRegistration
) {
    throw "NSIS payload inspection requires a clean current-user installation boundary and matching token profile"
}

if (Test-Path -LiteralPath $qaRoot) {
    throw "refusing to reuse an existing NSIS payload QA root"
}
New-Item -ItemType Directory -Path $qaRoot | Out-Null
[IO.File]::WriteAllText(
    $markerPath,
    $expectedMarker,
    [Text.UTF8Encoding]::new($false)
)

$installProcess = $null
$uninstallProcess = $null
$qaRootRemoved = $false
$report = $null
try {
    $installProcess = Start-Process -FilePath $installerPath -ArgumentList @(
        "/S",
        "/D=$installRoot"
    ) -Wait -PassThru
    if ($installProcess.ExitCode -ne 0) {
        throw "NSIS payload installation failed with exit code $($installProcess.ExitCode)"
    }

    $installedApplication = Join-Path $installRoot "yuanyuan-reminder.exe"
    $uninstaller = Join-Path $installRoot "uninstall.exe"
    if (
        -not (Test-Path -LiteralPath $installedApplication -PathType Leaf) -or
        -not (Test-Path -LiteralPath $uninstaller -PathType Leaf)
    ) {
        throw "NSIS installation did not produce the application and uninstaller"
    }
    $shortcutShell = New-Object -ComObject WScript.Shell
    $desktopExpectedQaTarget = if (
        -not $desktopShortcutExisted -and
        (Test-Path -LiteralPath $desktopShortcut -PathType Leaf)
    ) {
        [string]$shortcutShell.CreateShortcut($desktopShortcut).TargetPath
    } else {
        $installedApplication
    }
    $startMenuExpectedQaTarget = if (
        -not $programsShortcutExisted -and
        (Test-Path -LiteralPath $programsShortcut -PathType Leaf)
    ) {
        [string]$shortcutShell.CreateShortcut($programsShortcut).TargetPath
    } else {
        $installedApplication
    }

    $sourceBytes = [IO.File]::ReadAllBytes($sourcePath)
    $installedBytes = [IO.File]::ReadAllBytes($installedApplication)
    $sourceUnkCount = Count-Marker $sourceBytes $sourceMarker
    $sourceNssCount = Count-Marker $sourceBytes $installedMarker
    $installedUnkCount = Count-Marker $installedBytes $sourceMarker
    $installedNssCount = Count-Marker $installedBytes $installedMarker
    $sourceSignature = Get-SignatureRecord $sourcePath
    $installedSignature = Get-SignatureRecord $installedApplication

    $expectedUnsignedBytes = [byte[]]$sourceBytes.Clone()
    $sourceText = [Text.Encoding]::ASCII.GetString($sourceBytes)
    $markerOffset = $sourceText.IndexOf($sourceMarker, [StringComparison]::Ordinal)
    if ($markerOffset -ge 0) {
        $replacement = [Text.Encoding]::ASCII.GetBytes($installedMarker)
        [Array]::Copy($replacement, 0, $expectedUnsignedBytes, $markerOffset, $replacement.Length)
    }
    $expectedUnsignedPath = Join-Path $qaRoot "expected-unsigned-nsis-payload.exe"
    [IO.File]::WriteAllBytes($expectedUnsignedPath, $expectedUnsignedBytes)
    $installedSha256 = Get-Sha256 $installedApplication
    $expectedUnsignedSha256 = Get-Sha256 $expectedUnsignedPath
    $bothUnsigned = $sourceSignature.status -eq "NotSigned" -and
        $installedSignature.status -eq "NotSigned"
    $exactUnsignedMarkerPatch = $installedSha256 -eq $expectedUnsignedSha256

    $installedVersion = (Get-Item -LiteralPath $installedApplication).VersionInfo.ProductVersion
    $installedLicenses = @(
        Get-ChildItem -LiteralPath (Join-Path $installRoot "licenses") -File -ErrorAction SilentlyContinue |
            Select-Object -ExpandProperty Name |
            Sort-Object
    )
    $expectedLicenseNames = @($expectedLicenseFiles.Keys | Sort-Object)
    $licenseFilesExact = (ConvertTo-Json @($installedLicenses) -Compress) -eq
        (ConvertTo-Json @($expectedLicenseNames) -Compress)
    $licenseHashesMatch = $licenseFilesExact
    foreach ($licenseName in $expectedLicenseNames) {
        $installedLicense = Join-Path (Join-Path $installRoot "licenses") $licenseName
        if (
            -not (Test-Path -LiteralPath $installedLicense -PathType Leaf) -or
            (Get-Sha256 $installedLicense) -ne (Get-Sha256 $expectedLicenseFiles[$licenseName])
        ) {
            $licenseHashesMatch = $false
        }
    }

    $payloadChecksPassed = $sourceUnkCount -eq 1 -and
        $sourceNssCount -eq 0 -and
        $installedUnkCount -eq 0 -and
        $installedNssCount -eq 1 -and
        [string]$installedVersion -eq [string]$package.version -and
        $licenseFilesExact -and
        $licenseHashesMatch -and
        ((-not $bothUnsigned) -or $exactUnsignedMarkerPatch)

    Copy-Item -LiteralPath $installedApplication -Destination $pendingPayloadPath
    $uninstallProcess = Start-Process -FilePath $uninstaller -ArgumentList "/S" -Wait -PassThru
    Start-Sleep -Seconds 2
    $productRegistrationPersistedAfterUninstall = Test-Path -LiteralPath $productKey
    if ($productRegistrationPersistedAfterUninstall) {
        Remove-Item -LiteralPath $productKey -Recurse -Force -ErrorAction Stop
    }
    $desktopShortcutStatePreserved = Restore-ShortcutState `
        $desktopShortcut `
        $desktopShortcutExisted `
        $desktopShortcutSha256 `
        $desktopExpectedQaTarget
    $startMenuShortcutStatePreserved = Restore-ShortcutState `
        $programsShortcut `
        $programsShortcutExisted `
        $programsShortcutSha256 `
        $startMenuExpectedQaTarget
    $cleanup = [ordered]@{
        uninstallExitCode = $uninstallProcess.ExitCode
        installRootRemoved = -not (Test-Path -LiteralPath $installRoot)
        uninstallRegistrationRemoved = -not (Test-Path -LiteralPath $uninstallKey)
        productRegistrationPersistedAfterUninstall = $productRegistrationPersistedAfterUninstall
        ownedProductRegistrationRemoved = -not (Test-Path -LiteralPath $productKey)
        desktopShortcutStatePreserved = $desktopShortcutStatePreserved
        startMenuShortcutStatePreserved = $startMenuShortcutStatePreserved
        applicationProcessCount = @(Get-Process -Name "yuanyuan-reminder" -ErrorAction SilentlyContinue).Count
    }
    $cleanupPassed = $cleanup.uninstallExitCode -eq 0 -and
        $cleanup.installRootRemoved -and
        $cleanup.uninstallRegistrationRemoved -and
        $cleanup.ownedProductRegistrationRemoved -and
        $cleanup.desktopShortcutStatePreserved -and
        $cleanup.startMenuShortcutStatePreserved -and
        $cleanup.applicationProcessCount -eq 0
    $ready = $payloadChecksPassed -and $cleanupPassed

    New-Item -ItemType Directory -Force -Path $payloadRoot | Out-Null
    Move-Item -LiteralPath $pendingPayloadPath -Destination $payloadPath -Force
    $report = [ordered]@{
        schemaVersion = 1
        generatedAt = (Get-Date).ToUniversalTime().ToString("o")
        mode = "nsis_installed_payload"
        ready = $ready
        bindings = [ordered]@{
            inspectionScriptSha256 = Get-Sha256 $scriptPath
            sourceStableCoreSha256 = Get-Sha256 $sourcePath
            installerSha256 = Get-Sha256 $installerPath
            installedCoreSha256 = Get-Sha256 $payloadPath
        }
        candidate = [ordered]@{
            productVersion = [string]$package.version
            installedProductVersion = [string]$installedVersion
            sourceBytes = [long]$sourceBytes.Length
            installedBytes = [long]$installedBytes.Length
            sourceUnkMarkerCount = $sourceUnkCount
            sourceNssMarkerCount = $sourceNssCount
            installedUnkMarkerCount = $installedUnkCount
            installedNssMarkerCount = $installedNssCount
            bothUnsigned = $bothUnsigned
            expectedUnsignedInstalledCoreSha256 = $expectedUnsignedSha256
            exactUnsignedMarkerPatch = $exactUnsignedMarkerPatch
        }
        installation = [ordered]@{
            installExitCode = $installProcess.ExitCode
            customTemporaryInstallRoot = $true
            preexistingApplicationProcessCount = $preexistingProcesses.Count
            preexistingProductRegistration = $preexistingRegistration
            preexistingShortcut = $preexistingShortcut
            licenseFiles = @($installedLicenses)
            licenseFilesExact = $licenseFilesExact
            licenseHashesMatch = $licenseHashesMatch
        }
        environment = [ordered]@{
            currentUserAuthenticated = [bool]$identity.IsAuthenticated
            profileRegistryQueryAvailable = $profileRegistryQueryAvailable
            tokenProfilePathMatchesEnvironment = $tokenProfilePathMatchesEnvironment
        }
        signatures = [ordered]@{
            sourceStableCore = $sourceSignature
            installedCore = $installedSignature
        }
        cleanup = $cleanup
        limitations = @(
            "This extracts the exact NSIS-installed main executable through a disposable current-user installation; it does not approve an unsigned candidate.",
            "SmartScreen, security-software, upgrade interruption, authentic historical database migration, and default-path behavior remain separate gates."
        )
    }
    $report | ConvertTo-Json -Depth 8 | Set-Content -Encoding UTF8 -LiteralPath $reportPath
    if (-not $ready) { exit 2 }
}
finally {
    if (
        $null -eq $uninstallProcess -and
        (Test-Path -LiteralPath (Join-Path $installRoot "uninstall.exe") -PathType Leaf)
    ) {
        Start-Process -FilePath (Join-Path $installRoot "uninstall.exe") -ArgumentList "/S" -Wait |
            Out-Null
        Start-Sleep -Seconds 2
    }
    if (-not $preexistingRegistration) {
        if (Test-Path -LiteralPath $uninstallKey) {
            Remove-Item -LiteralPath $uninstallKey -Recurse -Force -ErrorAction SilentlyContinue
        }
        if (Test-Path -LiteralPath $productKey) {
            Remove-Item -LiteralPath $productKey -Recurse -Force -ErrorAction SilentlyContinue
        }
    }
    $qaRootRemoved = Remove-OwnedQaRoot $qaRoot
}

if (-not $qaRootRemoved) { throw "NSIS payload QA root cleanup failed" }
Write-Output "NSIS installed payload written: $payloadPath"
Write-Output "NSIS installed payload report written: $reportPath"
