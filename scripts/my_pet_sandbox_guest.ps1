# Installation/environment preparation only. GUI input belongs to the Computer Use driver.
$ErrorActionPreference = 'Stop'
$taskInput = 'C:\YuanyuanPetInput'
$taskOutput = 'C:\YuanyuanPetOutput'
$taskStatus = [ordered]@{ schemaVersion = 1; stage = 'starting'; syntheticDataOnly = $true; networkEnabled = $false }
function Save-TaskStatus {
    $taskStatus.updatedAt = [DateTime]::UtcNow.ToString('o')
    $taskStatus | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath "$taskOutput\status.json" -Encoding UTF8
}
try {
    if ([Environment]::UserName -ne 'WDAGUtilityAccount') { throw 'This script only runs inside Windows Sandbox.' }
    $taskStatus.sandboxUser = [Environment]::UserName
    $taskOs = Get-CimInstance -ClassName Win32_OperatingSystem
    $taskStatus.windows = [ordered]@{ caption = $taskOs.Caption; version = $taskOs.Version; build = $taskOs.BuildNumber }
    Save-TaskStatus
    $taskBindings = Get-Content -LiteralPath "$taskInput\bindings.json" -Raw -Encoding UTF8 | ConvertFrom-Json
    $taskStatus.buildVariant = $taskBindings.buildVariant
    if ((Get-FileHash -LiteralPath "$taskInput\e2e-words.csv" -Algorithm SHA256).Hash -ne $taskBindings.vocabularySha256) { throw 'Synthetic vocabulary hash mismatch.' }
    if ((Get-FileHash -LiteralPath "$taskInput\invalid\fixtures.json" -Algorithm SHA256).Hash -ne $taskBindings.invalidFixturesManifestSha256) { throw 'Negative fixture manifest hash mismatch.' }
    $taskInvalidFixtures = Get-Content -LiteralPath "$taskInput\invalid\fixtures.json" -Raw -Encoding UTF8 | ConvertFrom-Json
    foreach ($taskFixture in $taskInvalidFixtures.cases) {
        if ($taskFixture.filename -notmatch '^[a-z-]+\.yuanyuan-pet$') { throw 'Unexpected negative fixture filename.' }
        if ((Get-FileHash -LiteralPath (Join-Path "$taskInput\invalid" $taskFixture.filename) -Algorithm SHA256).Hash -ne $taskFixture.sha256) { throw 'Negative fixture hash mismatch.' }
    }
    $taskInstaller = "$taskInput\candidate.exe"
    if ((Get-FileHash -LiteralPath $taskInstaller -Algorithm SHA256).Hash -ne $taskBindings.installerSha256) { throw 'Candidate hash mismatch.' }
    $taskRuntime = 'C:\YuanyuanPetWebView2'
    $taskRuntimeExe = Join-Path $taskRuntime 'msedgewebview2.exe'
    if ((Get-FileHash -LiteralPath $taskRuntimeExe -Algorithm SHA256).Hash -ne $taskBindings.webviewSha256) { throw 'WebView runtime hash mismatch.' }
    # Advertise the real, host-verified Microsoft runtime only in the disposable guest.
    $taskWebviewKey = 'HKCU:\Software\Microsoft\EdgeUpdate\Clients\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}'
    New-Item -Path $taskWebviewKey -Force | Out-Null
    New-ItemProperty -Path $taskWebviewKey -Name pv -Value $taskBindings.webviewVersion -PropertyType String -Force | Out-Null
    $env:WEBVIEW2_BROWSER_EXECUTABLE_FOLDER = $taskRuntime
    $taskStatus.stage = 'installing'
    Save-TaskStatus
    $taskInstall = Start-Process -FilePath $taskInstaller -ArgumentList '/S' -PassThru -WindowStyle Hidden
    if (-not $taskInstall.WaitForExit(120000)) { throw 'Installer did not finish within 120 seconds.' }
    $taskStatus.installExitCode = $taskInstall.ExitCode
    if ($taskInstall.ExitCode -ne 0) { throw "Installer failed: $($taskInstall.ExitCode)" }
    $taskInstalledExe = Join-Path ([Environment]::GetFolderPath('LocalApplicationData')) "$($taskBindings.productName)\yuanyuan-reminder.exe"
    $taskStatus.installerSha256 = $taskBindings.installerSha256
    $taskStatus.installedExeSha256 = (Get-FileHash -LiteralPath $taskInstalledExe -Algorithm SHA256).Hash
    if ($taskStatus.installedExeSha256 -ne $taskBindings.coreSha256) { throw 'Installed executable differs from candidate core.' }
    $taskDataRoot = Join-Path ([Environment]::GetFolderPath('LocalApplicationData')) 'com.yuanyuan.reminder'
    $taskHelper = "$taskInput\inspect.exe"
    if ((Get-FileHash -LiteralPath $taskHelper -Algorithm SHA256).Hash -ne $taskBindings.helperSha256) { throw 'QA helper hash mismatch.' }
    if ((Get-FileHash -LiteralPath "$taskInput\vcruntime140.dll" -Algorithm SHA256).Hash -ne $taskBindings.helperCrtSha256) { throw 'QA runtime hash mismatch.' }
    $taskStatus.stage = 'seeding'
    $taskStatus.dataRootExistsBeforeSeed = Test-Path -LiteralPath $taskDataRoot
    Save-TaskStatus
    $taskSeed = & $taskHelper seed --data-root $taskDataRoot --due-after-seconds 120 --attest-windows-sandbox 2>&1
    $taskSeedExit = $LASTEXITCODE
    $taskSeed | Set-Content -LiteralPath "$taskOutput\seed.log" -Encoding UTF8
    $taskStatus.seedExitCode = $taskSeedExit
    if ($taskSeedExit -ne 0) { throw "Unable to create isolated synthetic database: exit $taskSeedExit." }
    $taskSeed | Set-Content -LiteralPath "$taskOutput\seed.json" -Encoding UTF8
    # Arrange copies of previously captured synthetic backups, without restoring them.
    # Restore itself must use the installed app UI. No pet-pack assets are copied here.
    $taskRestoreBackups = [ordered]@{}
    if ($taskBindings.restoreBackupSha256) {
        $taskBackupDestination = Join-Path $taskDataRoot 'backups'
        New-Item -ItemType Directory -Path $taskBackupDestination -Force | Out-Null
        foreach ($taskBackup in $taskBindings.restoreBackupSha256.PSObject.Properties) {
            if ($taskBackup.Name -notmatch '^(auto|manual)-[a-zA-Z0-9.-]+\.sqlite3$') { throw 'Unexpected restore fixture name.' }
            $taskBackupSource = Join-Path "$taskInput\restore-backups" $taskBackup.Name
            if ((Get-FileHash -LiteralPath $taskBackupSource -Algorithm SHA256).Hash -ne $taskBackup.Value) { throw 'Restore fixture hash mismatch.' }
            $taskBackupTarget = Join-Path $taskBackupDestination $taskBackup.Name
            if (Test-Path -LiteralPath $taskBackupTarget) { throw 'Restore fixture would overwrite existing data.' }
            Copy-Item -LiteralPath $taskBackupSource -Destination $taskBackupTarget
            $taskRestoreBackups[$taskBackup.Name] = (Get-FileHash -LiteralPath $taskBackupTarget -Algorithm SHA256).Hash
        }
    }
    $taskStatus.stagedRestoreBackups = $taskRestoreBackups
    # Real OS sharing violation, not a mocked persistence error. No UI automation here.
    $taskStatus.stage = 'testing-occupied-install'
    Save-TaskStatus
    $taskInstallRoot = Split-Path -Parent $taskInstalledExe
    function Get-InstalledHashes {
        $taskHashes = [ordered]@{}
        foreach ($taskFile in (Get-ChildItem -LiteralPath $taskInstallRoot -File -Recurse | Sort-Object FullName)) {
            if (($taskFile.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { throw 'Unexpected reparse point in isolated installation.' }
            $taskHashes[$taskFile.FullName.Substring($taskInstallRoot.Length + 1)] = (Get-FileHash -LiteralPath $taskFile.FullName -Algorithm SHA256).Hash
        }
        return $taskHashes
    }
    $taskBeforeFiles = Get-InstalledHashes
    $taskDatabasePath = Join-Path $taskDataRoot 'yuanyuan-reminder.sqlite3'
    $taskBeforeDatabase = (Get-FileHash -LiteralPath $taskDatabasePath -Algorithm SHA256).Hash
    $taskFileLock = [IO.File]::Open($taskInstalledExe, [IO.FileMode]::Open, [IO.FileAccess]::Read, [IO.FileShare]::Read)
    try {
        $taskBlockedInstall = Start-Process -FilePath $taskInstaller -ArgumentList '/S' -PassThru -WindowStyle Hidden
        if (-not $taskBlockedInstall.WaitForExit(30000)) { throw 'Occupied installer did not exit within 30 seconds.' }
        $taskBlockedExit = $taskBlockedInstall.ExitCode
    } finally { $taskFileLock.Dispose() }
    $taskAfterFiles = Get-InstalledHashes
    $taskAfterDatabase = (Get-FileHash -LiteralPath $taskDatabasePath -Algorithm SHA256).Hash
    $taskOccupiedResult = [ordered]@{
        installerSha256 = $taskBindings.installerSha256; capturedAt = [DateTime]::UtcNow.ToString('o')
        mechanism = 'real Windows file sharing violation'; exitCode = $taskBlockedExit
        beforeFiles = $taskBeforeFiles; afterFiles = $taskAfterFiles
        beforeDatabaseSha256 = $taskBeforeDatabase; afterDatabaseSha256 = $taskAfterDatabase
        filesUnchanged = (($taskBeforeFiles | ConvertTo-Json -Compress) -ceq ($taskAfterFiles | ConvertTo-Json -Compress))
        databaseUnchanged = ($taskBeforeDatabase -eq $taskAfterDatabase)
    }
    $taskOccupiedResult | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath "$taskOutput\occupied-install.json" -Encoding UTF8
    if ($taskBlockedExit -ne 32 -or -not $taskOccupiedResult.filesUnchanged -or -not $taskOccupiedResult.databaseUnchanged) { throw 'Occupied installation did not fail safely; see occupied-install.json.' }
    $taskRetryInstall = Start-Process -FilePath $taskInstaller -ArgumentList '/S' -PassThru -WindowStyle Hidden
    if (-not $taskRetryInstall.WaitForExit(120000) -or $taskRetryInstall.ExitCode -ne 0) { throw 'Installation retry after releasing file lock failed.' }
    if ((Get-FileHash -LiteralPath $taskInstalledExe -Algorithm SHA256).Hash -ne $taskBindings.coreSha256 -or (Get-FileHash -LiteralPath $taskDatabasePath -Algorithm SHA256).Hash -ne $taskBeforeDatabase) { throw 'Installation retry changed data or installed wrong bytes.' }
    $taskStatus.occupiedInstallExitCode = $taskBlockedExit
    $taskStatus.occupiedInstallFilesPreserved = $taskOccupiedResult.filesUnchanged
    $taskStatus.occupiedInstallDataPreserved = $taskOccupiedResult.databaseUnchanged
    $taskStatus.retryInstallExitCode = $taskRetryInstall.ExitCode
    $taskApp = Start-Process -FilePath $taskInstalledExe -PassThru -WindowStyle Hidden
    $taskStatus.stage = 'ready-for-ui'
    $taskStatus.applicationPid = $taskApp.Id
    $taskStatus.dataRoot = $taskDataRoot
    Save-TaskStatus
    $taskDeadline = [DateTime]::UtcNow.AddHours(2)
    $taskSequence = 0
    $taskRestartSeen = ''
    while ([DateTime]::UtcNow -lt $taskDeadline) {
        # A fixed restart action; never accepts shell commands or user-specified executable paths.
        $taskRestartPath = "$taskOutput\restart.request"
        if (Test-Path -LiteralPath $taskRestartPath -PathType Leaf) {
            $taskRestart = (Get-Content -LiteralPath $taskRestartPath -Raw).Trim()
            if ($taskRestart -match '^restart-[0-9]{1,6}$' -and $taskRestart -ne $taskRestartSeen) {
                $taskRestartSeen = $taskRestart
                $taskApp.Refresh()
                if (-not $taskApp.HasExited -and $taskApp.Path -eq $taskInstalledExe) { Stop-Process -Id $taskApp.Id -Force }
                Start-Sleep -Seconds 2
                $taskApp = Start-Process -FilePath $taskInstalledExe -PassThru -WindowStyle Hidden
                $taskStatus.applicationPid = $taskApp.Id
                $taskStatus.restart = $taskRestart
                Save-TaskStatus
            }
        }
        $taskSnapshot = & $taskHelper inspect-pet --data-root $taskDataRoot --attest-windows-sandbox
        if ($LASTEXITCODE -eq 0) {
            $taskSnapshot | Set-Content -LiteralPath (Join-Path $taskOutput ('snapshot-{0:D5}.json' -f $taskSequence)) -Encoding UTF8
            $taskSequence++
        }
        Start-Sleep -Seconds 5
    }
} catch {
    $taskStatus.stage = 'failed'
    $taskStatus.error = $_.Exception.Message
    Save-TaskStatus
    exit 2
}
