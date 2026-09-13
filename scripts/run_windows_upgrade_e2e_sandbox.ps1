param(
    [Parameter(Mandatory = $true)]
    [string]$ReleaseRoot,
    [Parameter(Mandatory = $true)]
    [string]$BaselineRoot,
    [Parameter(Mandatory = $true)]
    [string]$OutputRoot,
    [Parameter(Mandatory = $true)]
    [string]$WebView2RuntimeRoot
)

$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"

$projectRoot = Split-Path -Parent $PSScriptRoot
$releaseRoot = [IO.Path]::GetFullPath($ReleaseRoot)
$baselineRoot = [IO.Path]::GetFullPath($BaselineRoot)
$outputRoot = [IO.Path]::GetFullPath($OutputRoot)
$webView2RuntimeRoot = [IO.Path]::GetFullPath($WebView2RuntimeRoot)
$progressPath = Join-Path $outputRoot "windows-upgrade-e2e-progress.log"
$statusPath = Join-Path $outputRoot "windows-upgrade-e2e-status.json"
$completePath = Join-Path $outputRoot "windows-upgrade-e2e.complete"
$petWindowTitle = -join [char[]]@(0x5706, 0x5706)
$installFolderName = -join [char[]]@(0x5706, 0x5706, 0x63D0, 0x9192)

function Write-Progress([string]$Stage) {
    $line = "{0} {1}`n" -f (Get-Date).ToUniversalTime().ToString("o"), $Stage
    [IO.File]::AppendAllText($progressPath, $line, [Text.UTF8Encoding]::new($false))
}

function Get-Sha256([string]$Path) {
    (Get-FileHash -Algorithm SHA256 -LiteralPath $Path).Hash
}

function Find-OneInstaller([string]$Root, [string]$Version) {
    $matches = @(
        Get-ChildItem -LiteralPath $Root -File |
            Where-Object { $_.Name -like ("*_{0}_x64-setup.exe" -f $Version) }
    )
    if ($matches.Count -ne 1) {
        throw "upgrade E2E requires exactly one $Version x64 installer"
    }
    $matches[0].FullName
}

function Invoke-SilentInstall([string]$InstallerPath) {
    $process = Start-Process -FilePath $InstallerPath -ArgumentList "/S" -Wait -PassThru
    if ($process.ExitCode -ne 0) {
        throw "installer failed with exit code $($process.ExitCode)"
    }
}

if (-not ("YuanyuanUpgradeE2EWindowProbe" -as [type])) {
    Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
using System.Text;

public static class YuanyuanUpgradeE2EWindowProbe {
    private delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);
    [DllImport("user32.dll")]
    private static extern bool EnumWindows(EnumWindowsProc callback, IntPtr lParam);
    [DllImport("user32.dll")]
    private static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint processId);
    [DllImport("user32.dll")]
    private static extern bool IsWindowVisible(IntPtr hWnd);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)]
    private static extern int GetWindowText(IntPtr hWnd, StringBuilder value, int maxCount);

    public static bool HasVisibleWindow(int processId, string expectedTitle) {
        var found = false;
        EnumWindows((hWnd, lParam) => {
            uint owner;
            GetWindowThreadProcessId(hWnd, out owner);
            if (owner != (uint)processId || !IsWindowVisible(hWnd)) return true;
            var title = new StringBuilder(512);
            GetWindowText(hWnd, title, title.Capacity);
            if (String.Equals(title.ToString(), expectedTitle, StringComparison.Ordinal)) {
                found = true;
                return false;
            }
            return true;
        }, IntPtr.Zero);
        return found;
    }
}
"@
}

function Start-And-VerifyCandidate([string]$ApplicationPath, [string]$ExpectedVersion) {
    $oldWebViewRoot = $env:WEBVIEW2_BROWSER_EXECUTABLE_FOLDER
    $hadWebViewRoot = Test-Path Env:WEBVIEW2_BROWSER_EXECUTABLE_FOLDER
    try {
        $env:WEBVIEW2_BROWSER_EXECUTABLE_FOLDER = $webView2RuntimeRoot
        $process = Start-Process -FilePath $ApplicationPath -PassThru -WindowStyle Normal
    }
    finally {
        if ($hadWebViewRoot) { $env:WEBVIEW2_BROWSER_EXECUTABLE_FOLDER = $oldWebViewRoot }
        else { Remove-Item Env:WEBVIEW2_BROWSER_EXECUTABLE_FOLDER -ErrorAction SilentlyContinue }
    }
    try {
        $deadline = [DateTime]::UtcNow.AddSeconds(45)
        while ([DateTime]::UtcNow -lt $deadline) {
            $process.Refresh()
            if ($process.HasExited) { throw "$ExpectedVersion candidate exited before its window appeared" }
            if ([YuanyuanUpgradeE2EWindowProbe]::HasVisibleWindow($process.Id, $petWindowTitle)) {
                Start-Sleep -Seconds 2
                return $process
            }
            Start-Sleep -Milliseconds 100
        }
        throw "$ExpectedVersion candidate window did not appear"
    }
    catch {
        if (-not $process.HasExited) { Stop-Process -Id $process.Id -Force -ErrorAction SilentlyContinue }
        throw
    }
}

function Stop-OwnedCandidate([AllowNull()][System.Diagnostics.Process]$Process) {
    if ($null -eq $Process) { return }
    $Process.Refresh()
    if (-not $Process.HasExited) {
        Stop-Process -Id $Process.Id -Force
        $Process.WaitForExit(10000) | Out-Null
    }
}

New-Item -ItemType Directory -Force -Path $outputRoot | Out-Null
$status = [ordered]@{
    schemaVersion = 1
    generatedAt = $null
    profile = "windows-sandbox-v1.5.7-to-v1.5.8-upgrade-e2e"
    sandboxUser = [Environment]::UserName
    interactiveSession = [Environment]::UserInteractive
    syntheticDataOnly = $true
    baseline = $null
    candidate = $null
    rollback = $null
    database = $null
    evidence = $null
    cleanup = $null
    ready = $false
    failure = $null
}
$candidateProcess = $null
try {
    Write-Progress "preflight:start"
    if ($status.sandboxUser -ne "WDAGUtilityAccount" -or -not $status.interactiveSession) {
        throw "upgrade E2E must run in an interactive Windows Sandbox account"
    }
    $webView2Executable = Join-Path $webView2RuntimeRoot "msedgewebview2.exe"
    $webView2Signature = Get-AuthenticodeSignature -LiteralPath $webView2Executable
    if (
        $webView2Signature.Status -ne "Valid" -or
        $null -eq $webView2Signature.SignerCertificate -or
        $webView2Signature.SignerCertificate.Subject -notlike "*O=Microsoft Corporation*"
    ) {
        throw "mapped WebView2 runtime is not validly signed by Microsoft"
    }
    $webView2Version = [string](Get-Item -LiteralPath $webView2Executable).VersionInfo.ProductVersion
    foreach ($webView2Key in @(
        "Registry::HKEY_LOCAL_MACHINE\SOFTWARE\WOW6432Node\Microsoft\EdgeUpdate\Clients\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}",
        "Registry::HKEY_CURRENT_USER\Software\Microsoft\EdgeUpdate\Clients\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}"
    )) {
        New-Item -Path $webView2Key -Force | Out-Null
        New-ItemProperty -LiteralPath $webView2Key -Name "name" -Value "Microsoft Edge WebView2 Runtime" -PropertyType String -Force | Out-Null
        New-ItemProperty -LiteralPath $webView2Key -Name "pv" -Value $webView2Version -PropertyType String -Force | Out-Null
    }

    $baselineMetadataPath = Join-Path $baselineRoot "artifacts\baseline-metadata.json"
    $baselineMetadata = Get-Content -Raw -Encoding UTF8 -LiteralPath $baselineMetadataPath |
        ConvertFrom-Json
    $baselineInstaller = Find-OneInstaller (Join-Path $baselineRoot "artifacts") "1.5.7"
    $candidateInstaller = Find-OneInstaller (Join-Path $releaseRoot "bundle\nsis") "1.5.8"
    if (
        -not $baselineMetadata.ready -or
        $baselineMetadata.profile -ne "reconstructed-current-product-pre013-v1.5.7-baseline" -or
        $baselineMetadata.source.commit -ne "aaffe998e3bfe37e7c2dcd5a83a9bc69e9002b23" -or
        $baselineMetadata.source.originalVersion -ne "1.5.5" -or
        $baselineMetadata.source.effectiveVersion -ne "1.5.7" -or
        -not $baselineMetadata.source.versionOverrideOnly -or
        $baselineMetadata.source.maximumReminderSchema -ne 12 -or
        (Get-Sha256 $baselineInstaller) -ne $baselineMetadata.installer.sha256 -or
        (Get-Sha256 (Join-Path $projectRoot "scripts\build_windows_upgrade_baseline.ps1")) -ne
            $baselineMetadata.builderScriptSha256
    ) {
        throw "reconstructed pre-013 baseline metadata is invalid"
    }
    $helperPath = Join-Path $projectRoot "src-tauri\target\release\yuanyuan-installed-candidate-qa.exe"
    if (-not (Test-Path -LiteralPath $helperPath -PathType Leaf)) {
        throw "installed-candidate QA helper is missing"
    }
    $status.evidence = [ordered]@{
        helperSha256 = Get-Sha256 $helperPath
        guestScriptSha256 = Get-Sha256 $MyInvocation.MyCommand.Path
        hostScriptSha256 = Get-Sha256 (Join-Path $projectRoot "scripts\run_windows_upgrade_e2e_sandbox_host.ps1")
    }
    $installRoot = Join-Path ([Environment]::GetFolderPath("LocalApplicationData")) $installFolderName
    $dataRoot = Join-Path ([Environment]::GetFolderPath("LocalApplicationData")) "com.yuanyuan.reminder"
    $applicationPath = Join-Path $installRoot "yuanyuan-reminder.exe"
    $uninstallerPath = Join-Path $installRoot "uninstall.exe"
    foreach ($path in @($installRoot, $dataRoot)) {
        if (Test-Path -LiteralPath $path) { throw "upgrade E2E boundary is not clean: $path" }
    }
    Write-Progress "baseline:install:start"
    Invoke-SilentInstall $baselineInstaller
    $baselineVersion = [string](Get-Item -LiteralPath $applicationPath).VersionInfo.ProductVersion
    $baselineInstalledCoreSha256 = Get-Sha256 $applicationPath
    if (
        $baselineVersion -ne "1.5.7" -or
        $baselineInstalledCoreSha256 -ne $baselineMetadata.installedCore.sha256 -or
        -not (Test-Path -LiteralPath $uninstallerPath)
    ) {
        throw "baseline installer did not produce the exact 1.5.7 installation"
    }
    $status.baseline = [ordered]@{
        version = $baselineVersion
        installerSha256 = Get-Sha256 $baselineInstaller
        installedCoreSha256 = $baselineInstalledCoreSha256
        metadataSha256 = Get-Sha256 $baselineMetadataPath
        source = $baselineMetadata.source
        launched = $false
    }
    Write-Progress "baseline:fixture:start"
    $seed = & $helperPath seed-upgrade-v12 --data-root $dataRoot --attest-windows-sandbox |
        ConvertFrom-Json
    if ($LASTEXITCODE -ne 0 -or $seed.schemaVersion -ne 12 -or -not $seed.mealRejectedBeforeUpgrade) {
        throw "schema-12 upgrade fixture creation failed"
    }
    $databasePath = Join-Path $dataRoot "yuanyuan-reminder.sqlite3"
    $seedInspection = & $helperPath inspect-upgrade-v12 --data-root $dataRoot --attest-windows-sandbox |
        ConvertFrom-Json
    if ($LASTEXITCODE -ne 0 -or $seedInspection.schemaVersion -ne 12) {
        throw "schema-12 fixture failed inspection before the baseline launch"
    }
    $candidateProcess = Start-And-VerifyCandidate $applicationPath "1.5.7"
    $status.baseline.launched = $true
    Stop-OwnedCandidate $candidateProcess
    $candidateProcess = $null
    $baselineInspection = & $helperPath inspect-upgrade-v12 --data-root $dataRoot --attest-windows-sandbox |
        ConvertFrom-Json
    if (
        $LASTEXITCODE -ne 0 -or
        $baselineInspection.schemaVersion -ne 12 -or
        -not $baselineInspection.reminderPreserved -or
        -not $baselineInspection.occurrencePreserved -or
        $baselineInspection.foreignKeyViolations -ne 0 -or
        -not $baselineInspection.mealRejectedAfterRollback
    ) {
        throw "pre-013 baseline launch did not preserve the schema-12 fixture"
    }
    $status.baseline.seedInspection = $seedInspection
    $status.baseline.postLaunchInspection = $baselineInspection
    $rollbackSnapshotPath = Join-Path $outputRoot "pre-upgrade-v12.sqlite3"
    Copy-Item -LiteralPath $databasePath -Destination $rollbackSnapshotPath
    $rollbackSnapshotSha256 = Get-Sha256 $rollbackSnapshotPath
    if ($rollbackSnapshotSha256 -ne (Get-Sha256 $databasePath)) {
        throw "pre-upgrade rollback snapshot does not match the schema-12 database"
    }
    $databaseBeforeUpgradeSha256 = Get-Sha256 $databasePath
    Write-Progress "baseline:launch:passed"

    Write-Progress "candidate:install:start"
    Invoke-SilentInstall $candidateInstaller
    $candidateVersion = [string](Get-Item -LiteralPath $applicationPath).VersionInfo.ProductVersion
    $databaseAfterInstallerSha256 = Get-Sha256 $databasePath
    if ($candidateVersion -ne "1.5.8") {
        throw "candidate installer did not replace the baseline with 1.5.8"
    }
    if ($databaseAfterInstallerSha256 -ne $databaseBeforeUpgradeSha256) {
        throw "candidate installer changed the database before first launch"
    }
    $status.candidate = [ordered]@{
        version = $candidateVersion
        installerSha256 = Get-Sha256 $candidateInstaller
        installedCoreSha256 = Get-Sha256 $applicationPath
        launched = $false
    }
    $candidateProcess = Start-And-VerifyCandidate $applicationPath "1.5.8"
    $status.candidate.launched = $true
    Stop-OwnedCandidate $candidateProcess
    $candidateProcess = $null
    Write-Progress "candidate:first-launch:passed"

    $inspection = & $helperPath inspect-upgrade-v13 --data-root $dataRoot --attest-windows-sandbox |
        ConvertFrom-Json
    if ($LASTEXITCODE -ne 0) { throw "schema-13 upgrade inspection failed" }
    $status.database = [ordered]@{
        beforeUpgradeSha256 = $databaseBeforeUpgradeSha256
        afterInstallerBeforeLaunchSha256 = $databaseAfterInstallerSha256
        afterUpgradeSha256 = Get-Sha256 $databasePath
        seed = $seed
        inspection = $inspection
    }
    if (
        $inspection.schemaVersion -ne 13 -or
        -not $inspection.reminderPreserved -or
        -not $inspection.occurrencePreserved -or
        $inspection.foreignKeyViolations -ne 0 -or
        -not $inspection.requiredIndexesPresent -or
        $inspection.mealCategory -ne "meal"
    ) {
        throw "schema-13 migration did not preserve data and enable meal reminders"
    }
    Write-Progress "database:migration:passed"

    $databaseBeforeUninstallSha256 = Get-Sha256 $databasePath
    $candidateUninstall = Start-Process -FilePath $uninstallerPath -ArgumentList "/S" -Wait -PassThru
    Start-Sleep -Seconds 2
    $dataPreserved = (Test-Path -LiteralPath $databasePath -PathType Leaf) -and
        (Get-Sha256 $databasePath) -eq $databaseBeforeUninstallSha256
    if ($candidateUninstall.ExitCode -ne 0 -or (Test-Path -LiteralPath $installRoot) -or -not $dataPreserved) {
        throw "candidate uninstall did not remove the app while preserving upgraded data"
    }

    Write-Progress "rollback:install:start"
    Invoke-SilentInstall $baselineInstaller
    $rollbackVersion = [string](Get-Item -LiteralPath $applicationPath).VersionInfo.ProductVersion
    $rollbackCoreSha256 = Get-Sha256 $applicationPath
    if (
        $rollbackVersion -ne "1.5.7" -or
        $rollbackCoreSha256 -ne $status.baseline.installedCoreSha256 -or
        -not (Test-Path -LiteralPath $uninstallerPath -PathType Leaf)
    ) {
        throw "rollback installer did not restore the exact 1.5.7 application"
    }
    foreach ($databaseArtifact in @($databasePath, "$databasePath-wal", "$databasePath-shm")) {
        if (Test-Path -LiteralPath $databaseArtifact) {
            Remove-Item -LiteralPath $databaseArtifact -Force
        }
    }
    Copy-Item -LiteralPath $rollbackSnapshotPath -Destination $databasePath
    $restoredDatabaseSha256 = Get-Sha256 $databasePath
    if ($restoredDatabaseSha256 -ne $rollbackSnapshotSha256) {
        throw "rollback did not restore the exact pre-upgrade schema-12 database"
    }
    $preLaunchRollbackInspection = & $helperPath inspect-upgrade-v12 --data-root $dataRoot --attest-windows-sandbox |
        ConvertFrom-Json
    if ($LASTEXITCODE -ne 0) {
        throw "schema-12 rollback inspection failed before launching 1.5.7"
    }
    $candidateProcess = Start-And-VerifyCandidate $applicationPath "1.5.7 rollback"
    Stop-OwnedCandidate $candidateProcess
    $candidateProcess = $null
    $postRollbackLaunchDatabasePath = Join-Path $outputRoot "post-rollback-launch-v12.sqlite3"
    Copy-Item -LiteralPath $databasePath -Destination $postRollbackLaunchDatabasePath
    foreach ($sidecarSuffix in @("-wal", "-shm")) {
        $sidecarPath = "$databasePath$sidecarSuffix"
        if (Test-Path -LiteralPath $sidecarPath -PathType Leaf) {
            Copy-Item -LiteralPath $sidecarPath -Destination (
                Join-Path $outputRoot "post-rollback-launch-v12.sqlite3$sidecarSuffix"
            )
        }
    }
    $postRollbackLaunchDatabaseSha256 = Get-Sha256 $postRollbackLaunchDatabasePath
    $rollbackInspectionOutput = @(
        & $helperPath inspect-upgrade-v12 --data-root $dataRoot --attest-windows-sandbox 2>&1
    )
    $rollbackInspectionExitCode = $LASTEXITCODE
    $rollbackInspection = if ($rollbackInspectionExitCode -eq 0) {
        ($rollbackInspectionOutput -join "`n") | ConvertFrom-Json
    }
    else {
        $null
    }
    $markerPath = Join-Path $dataRoot ".yuanyuan-installed-candidate-qa-v1"
    $status.rollback = [ordered]@{
        version = $rollbackVersion
        installedCoreSha256 = $rollbackCoreSha256
        snapshotSha256 = $rollbackSnapshotSha256
        restoredDatabaseSha256 = $restoredDatabaseSha256
        postLaunchDatabaseSha256 = $postRollbackLaunchDatabaseSha256
        launched = $true
        preLaunchInspection = $preLaunchRollbackInspection
        postLaunchInspection = $rollbackInspection
        inspectionExitCode = $rollbackInspectionExitCode
        inspectionError = if ($rollbackInspectionExitCode -eq 0) {
            $null
        }
        else {
            [string]($rollbackInspectionOutput -join "`n")
        }
        markerPresentAfterLaunch = Test-Path -LiteralPath $markerPath -PathType Leaf
        markerSha256AfterLaunch = if (Test-Path -LiteralPath $markerPath -PathType Leaf) {
            Get-Sha256 $markerPath
        }
        else {
            $null
        }
    }
    if (
        $rollbackInspectionExitCode -ne 0 -or
        $rollbackInspection.schemaVersion -ne 12 -or
        -not $rollbackInspection.reminderPreserved -or
        -not $rollbackInspection.occurrencePreserved -or
        $rollbackInspection.foreignKeyViolations -ne 0 -or
        -not $rollbackInspection.mealRejectedAfterRollback
    ) {
        throw "restored 1.5.7 application and schema-12 database failed rollback inspection"
    }
    $databaseBeforeRollbackUninstallSha256 = Get-Sha256 $databasePath
    $rollbackUninstall = Start-Process -FilePath $uninstallerPath -ArgumentList "/S" -Wait -PassThru
    Start-Sleep -Seconds 2
    $rollbackDataPreserved = (Test-Path -LiteralPath $databasePath -PathType Leaf) -and
        (Get-Sha256 $databasePath) -eq $databaseBeforeRollbackUninstallSha256
    if ($rollbackUninstall.ExitCode -ne 0 -or (Test-Path -LiteralPath $installRoot) -or -not $rollbackDataPreserved) {
        throw "rollback uninstall did not remove 1.5.7 while preserving restored data"
    }
    Write-Progress "rollback:passed"

    if ((Get-Content -Raw -Encoding UTF8 -LiteralPath $markerPath) -ne "YUANYUAN_INSTALLED_CANDIDATE_QA_V1`n") {
        throw "upgrade E2E cleanup marker is invalid"
    }
    Remove-Item -LiteralPath $dataRoot -Recurse -Force
    $status.cleanup = [ordered]@{
        candidateUninstallExitCode = $candidateUninstall.ExitCode
        rollbackUninstallExitCode = $rollbackUninstall.ExitCode
        installRootRemoved = -not (Test-Path -LiteralPath $installRoot)
        upgradedDataPreservedByDefaultUninstall = $dataPreserved
        restoredDataPreservedByRollbackUninstall = $rollbackDataPreserved
        ownedSyntheticDataRemoved = -not (Test-Path -LiteralPath $dataRoot)
    }
    $status.ready =
        $status.cleanup.candidateUninstallExitCode -eq 0 -and
        $status.cleanup.rollbackUninstallExitCode -eq 0 -and
        $status.cleanup.installRootRemoved -and
        $status.cleanup.upgradedDataPreservedByDefaultUninstall -and
        $status.cleanup.restoredDataPreservedByRollbackUninstall -and
        $status.cleanup.ownedSyntheticDataRemoved
    Write-Progress "result:passed"
}
catch {
    $status.failure = [string]$_.Exception.Message
    Write-Progress "result:failed"
}
finally {
    Stop-OwnedCandidate $candidateProcess
    $status.generatedAt = (Get-Date).ToUniversalTime().ToString("o")
    $status | ConvertTo-Json -Depth 12 | Set-Content -Encoding UTF8 -LiteralPath $statusPath
    [IO.File]::WriteAllText(
        $completePath,
        "YUANYUAN_WINDOWS_UPGRADE_E2E_COMPLETE_V1`n",
        [Text.UTF8Encoding]::new($false)
    )
    Start-Process -FilePath shutdown.exe -ArgumentList @("/s", "/f", "/t", "0") -WindowStyle Hidden
}

if (-not $status.ready) { exit 2 }
Write-Output "Windows Sandbox 1.5.7 -> 1.5.8 upgrade E2E passed: $statusPath"
