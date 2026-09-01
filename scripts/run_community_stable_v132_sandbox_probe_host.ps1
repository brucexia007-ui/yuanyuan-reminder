param(
    [int]$TimeoutSeconds = 300
)

$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"
. (Join-Path $PSScriptRoot "assert_runtime_qa_exclusive.ps1")
Assert-YuanyuanRuntimeQaExclusive -Activity "Authentic v1.3.2 Windows Sandbox compatibility E2E"
$systemModuleRoot = Join-Path $env:WINDIR "System32\WindowsPowerShell\v1.0\Modules"
$env:PSModulePath = $systemModuleRoot
[void](Get-Command Get-AuthenticodeSignature -ErrorAction Stop)

if ($TimeoutSeconds -lt 120 -or $TimeoutSeconds -gt 900) {
    throw "TimeoutSeconds must be between 120 and 900"
}

$projectRoot = Split-Path -Parent $PSScriptRoot
$targetRoot = [IO.Path]::GetFullPath((Join-Path $projectRoot "src-tauri\target"))
$assetRoot = Join-Path $targetRoot "v132-runtime-qa-11841b88"
$legacyCandidatePath = Join-Path $assetRoot "published\Yuanyuan-Reminder-1.3.2-x64-Portable.exe"
$releaseChecksumPath = Join-Path $assetRoot "published\SHA256SUMS.txt"
$tagArchivePath = Join-Path $assetRoot "yuanyuan-reminder-v1.3.2.zip"
$captureHelperPath = Join-Path $targetRoot "release\yuanyuan-database-migration-qa-capture.exe"
$migrationHelperPath = Join-Path $targetRoot "release\yuanyuan-database-migration-qa.exe"
$captureScriptPath = Join-Path $PSScriptRoot "capture_v132_runtime_database.ps1"
$runId = (Get-Date).ToUniversalTime().ToString("yyyyMMddTHHmmssfffZ")
$outputRoot = Join-Path $targetRoot "community-stable-v132-sandbox\$runId"
$metadataPath = Join-Path $outputRoot "source-metadata.json"
$webView2MetadataPath = Join-Path $outputRoot "webview2-mapped-runtime.json"
$statusPath = Join-Path $outputRoot "v132-sandbox-status.json"
$completePath = Join-Path $outputRoot "v132-sandbox.complete"
$configPath = Join-Path $outputRoot "community-stable-v132.wsb"

$expected = [ordered]@{
    tagCommit = "11841b88cf7b3e6d10502fd0158401e2c02167ae"
    legacyCandidateSha256 = "D142095E41EA4A1D6BB89D7A20D8F44CBA3519C085E4EC5E674E4FB25CFF89AD"
    releaseChecksumSha256 = "A3553273D4EE693FED5B9DB50C83A675EB0C1650B022A75067C6A1A83CDB160D"
    tagArchiveSha256 = "ED91C071372B08BECAC0D7DA258B1B80154C2C25834FCCA87F338A33A592024E"
}

foreach ($requiredPath in @(
    $legacyCandidatePath,
    $releaseChecksumPath,
    $tagArchivePath,
    $captureHelperPath,
    $migrationHelperPath,
    $captureScriptPath,
    $PSCommandPath
)) {
    if (-not (Test-Path -LiteralPath $requiredPath -PathType Leaf)) {
        throw "required v1.3.2 Sandbox input is missing: $requiredPath"
    }
}

function Get-Sha256([string]$Path) {
    (Get-FileHash -Algorithm SHA256 -LiteralPath $Path).Hash
}

function Read-GitValue([string[]]$Arguments) {
    $value = & $script:gitExecutable -C $projectRoot @Arguments 2>$null
    if ($LASTEXITCODE -ne 0) {
        throw "git source metadata query failed: $($Arguments -join ' ')"
    }
    ([string]($value -join "`n")).Trim()
}

function Escape-Xml([string]$Value) {
    [Security.SecurityElement]::Escape($Value)
}

$sandboxExecutable = (Get-Command WindowsSandbox.exe -ErrorAction Stop).Source
$feature = Get-WindowsOptionalFeature `
    -Online `
    -FeatureName Containers-DisposableClientVM `
    -ErrorAction Stop
if ($feature.State -ne "Enabled") {
    throw "Windows Sandbox feature is not enabled"
}

$preexistingSandboxProcesses = @(
    Get-Process -ErrorAction SilentlyContinue |
        Where-Object {
            $_.ProcessName -like "*WindowsSandbox*" -or
            $_.ProcessName -eq "vmmemWindowsSandbox"
        }
)
if ($preexistingSandboxProcesses.Count -ne 0) {
    throw "a Windows Sandbox session is already running"
}

$gitExecutable = (Get-Command git.exe -ErrorAction Stop).Source
$gitRoot = Split-Path -Parent (Split-Path -Parent $gitExecutable)
$mappedGitExecutable = Join-Path $gitRoot "cmd\git.exe"
if (-not (Test-Path -LiteralPath $mappedGitExecutable -PathType Leaf)) {
    throw "Git installation root could not be mapped into Windows Sandbox"
}

$resolvedTagCommit = Read-GitValue @("rev-parse", "v1.3.2^{commit}")
if ($resolvedTagCommit -ne $expected.tagCommit) {
    throw "v1.3.2 tag commit does not match the frozen release source"
}
if ((Get-Sha256 $legacyCandidatePath) -ne $expected.legacyCandidateSha256) {
    throw "v1.3.2 portable release asset hash mismatch"
}
if ((Get-Sha256 $releaseChecksumPath) -ne $expected.releaseChecksumSha256) {
    throw "v1.3.2 checksum asset hash mismatch"
}
if ((Get-Sha256 $tagArchivePath) -ne $expected.tagArchiveSha256) {
    throw "v1.3.2 source archive hash mismatch"
}
$legacyItem = Get-Item -LiteralPath $legacyCandidatePath
if (
    $legacyItem.VersionInfo.ProductVersion -ne "1.3.2" -or
    $legacyItem.VersionInfo.FileVersion -ne "1.3.2"
) {
    throw "v1.3.2 portable release asset version mismatch"
}

$webView2ClientKey = "Registry::HKEY_LOCAL_MACHINE\SOFTWARE\WOW6432Node\Microsoft\EdgeUpdate\Clients\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}"
$webView2Version = [string](Get-ItemPropertyValue `
    -LiteralPath $webView2ClientKey `
    -Name "pv" `
    -ErrorAction Stop)
$webView2RuntimeRoot = Join-Path `
    ${env:ProgramFiles(x86)} `
    "Microsoft\EdgeWebView\Application\$webView2Version"
$webView2Executable = Join-Path $webView2RuntimeRoot "msedgewebview2.exe"
$webView2Signature = Get-AuthenticodeSignature -LiteralPath $webView2Executable
if (
    $webView2Signature.Status -ne "Valid" -or
    $null -eq $webView2Signature.SignerCertificate -or
    $webView2Signature.SignerCertificate.Subject -notlike "*O=Microsoft Corporation*"
) {
    throw "installed WebView2 runtime is not validly signed by Microsoft"
}

$sandbox = $null
$sandboxStartedAt = $null
try {
    New-Item -ItemType Directory -Path $outputRoot | Out-Null
    $webView2Metadata = [ordered]@{
        schemaVersion = 1
        source = "installed-host-microsoft-webview2-runtime"
        bytes = [long](Get-Item -LiteralPath $webView2Executable).Length
        sha256 = Get-Sha256 $webView2Executable
        signatureStatus = [string]$webView2Signature.Status
        signerSubject = [string]$webView2Signature.SignerCertificate.Subject
        productVersion = [string]$webView2Version
    }
    $webView2Metadata | ConvertTo-Json -Depth 4 |
        Set-Content -Encoding UTF8 -LiteralPath $webView2MetadataPath
    $sourceMetadata = [ordered]@{
        schemaVersion = 1
        capturedAt = (Get-Date).ToUniversalTime().ToString("o")
        branch = Read-GitValue @("branch", "--show-current")
        commit = Read-GitValue @("rev-parse", "HEAD")
        dirty = -not [string]::IsNullOrWhiteSpace((
            Read-GitValue @("status", "--porcelain=v1", "--untracked-files=all")
        ))
        v132TagCommit = $resolvedTagCommit
        v132PortableSha256 = Get-Sha256 $legacyCandidatePath
        v132ChecksumSha256 = Get-Sha256 $releaseChecksumPath
        v132TagArchiveSha256 = Get-Sha256 $tagArchivePath
        captureHelperSha256 = Get-Sha256 $captureHelperPath
        migrationHelperSha256 = Get-Sha256 $migrationHelperPath
        captureScriptSha256 = Get-Sha256 $captureScriptPath
        hostScriptSha256 = Get-Sha256 $PSCommandPath
        webView2Sha256 = Get-Sha256 $webView2Executable
        webView2Version = $webView2Version
    }
    if (
        [string]::IsNullOrWhiteSpace($sourceMetadata.branch) -or
        $sourceMetadata.commit -notmatch "^[0-9a-f]{40}$"
    ) {
        throw "git source metadata is incomplete"
    }
    $sourceMetadata | ConvertTo-Json -Depth 5 |
        Set-Content -Encoding UTF8 -LiteralPath $metadataPath

    $projectXml = Escape-Xml $projectRoot
    $outputXml = Escape-Xml $outputRoot
    $webView2RuntimeXml = Escape-Xml $webView2RuntimeRoot
    $gitRootXml = Escape-Xml $gitRoot
    $logonBootstrap = @'
$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"
$outputRoot = "C:\YuanyuanOutput"
$statusPath = Join-Path $outputRoot "v132-sandbox-status.json"
$completePath = Join-Path $outputRoot "v132-sandbox.complete"
$systemModuleRoot = Join-Path $env:WINDIR "System32\WindowsPowerShell\v1.0\Modules"
$env:PSModulePath = $systemModuleRoot
$env:Path = "C:\YuanyuanGit\cmd;$env:WINDIR\System32;$env:WINDIR\System32\WindowsPowerShell\v1.0"
$status = [ordered]@{
    schemaVersion = 1
    generatedAt = $null
    profile = "community-stable-authentic-v132"
    sandboxUser = [Environment]::UserName
    interactiveSession = [Environment]::UserInteractive
    source = $null
    sourceMetadataSha256 = $null
    webView2MetadataSha256 = $null
    mappedMicrosoftWebView2RuntimeVerified = $false
    temporaryWebView2DetectionRegistration = $false
    authenticRuntimeDatabaseCreated = $false
    authenticCapturePassed = $false
    migrationBackupRollbackPassed = $false
    formalUserDataUsed = $false
    sandboxDataCleaned = $false
    fixtureSha256 = $null
    captureReportSha256 = $null
    provenanceReportSha256 = $null
    migrationReportSha256 = $null
    ready = $false
    failure = $null
}
try {
    if ($status.sandboxUser -ne "WDAGUtilityAccount" -or -not $status.interactiveSession) {
        throw "probe must run in an interactive Windows Sandbox account"
    }
    $metadataPath = Join-Path $outputRoot "source-metadata.json"
    $metadata = Get-Content -Raw -Encoding UTF8 -LiteralPath $metadataPath |
        ConvertFrom-Json
    if (
        $metadata.schemaVersion -ne 1 -or
        $metadata.commit -notmatch "^[0-9a-f]{40}$" -or
        $metadata.v132TagCommit -ne "11841b88cf7b3e6d10502fd0158401e2c02167ae"
    ) {
        throw "host source metadata is invalid"
    }
    $status.source = $metadata
    $status.sourceMetadataSha256 = (
        Get-FileHash -Algorithm SHA256 -LiteralPath $metadataPath
    ).Hash
    $webView2MetadataPath = Join-Path $outputRoot "webview2-mapped-runtime.json"
    $webView2Metadata = Get-Content -Raw -Encoding UTF8 -LiteralPath $webView2MetadataPath |
        ConvertFrom-Json
    $status.webView2MetadataSha256 = (
        Get-FileHash -Algorithm SHA256 -LiteralPath $webView2MetadataPath
    ).Hash

    $webView2Executable = "C:\YuanyuanWebView2\msedgewebview2.exe"
    $signature = Get-AuthenticodeSignature -LiteralPath $webView2Executable
    if (
        $signature.Status -ne "Valid" -or
        $null -eq $signature.SignerCertificate -or
        $signature.SignerCertificate.Subject -notlike "*O=Microsoft Corporation*" -or
        (Get-FileHash -Algorithm SHA256 -LiteralPath $webView2Executable).Hash -ne
            $metadata.webView2Sha256 -or
        $webView2Metadata.sha256 -ne $metadata.webView2Sha256 -or
        $webView2Metadata.signatureStatus -ne "Valid" -or
        $webView2Metadata.signerSubject -notlike "*O=Microsoft Corporation*"
    ) {
        throw "mapped WebView2 runtime did not retain its Microsoft signature and hash"
    }
    $webView2Version = [string](Get-Item -LiteralPath $webView2Executable).VersionInfo.ProductVersion
    if ($webView2Version -ne [string]$metadata.webView2Version) {
        throw "mapped WebView2 runtime version mismatch"
    }
    $env:WEBVIEW2_BROWSER_EXECUTABLE_FOLDER = "C:\YuanyuanWebView2"
    foreach ($webView2Key in @(
        "Registry::HKEY_LOCAL_MACHINE\SOFTWARE\WOW6432Node\Microsoft\EdgeUpdate\Clients\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}",
        "Registry::HKEY_CURRENT_USER\Software\Microsoft\EdgeUpdate\Clients\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}"
    )) {
        New-Item -Path $webView2Key -Force | Out-Null
        New-ItemProperty -LiteralPath $webView2Key -Name "name" `
            -Value "Microsoft Edge WebView2 Runtime" -PropertyType String -Force |
            Out-Null
        New-ItemProperty -LiteralPath $webView2Key -Name "pv" `
            -Value $webView2Version -PropertyType String -Force |
            Out-Null
    }
    $status.mappedMicrosoftWebView2RuntimeVerified = $true
    $status.temporaryWebView2DetectionRegistration = $true

    & "C:\YuanyuanGit\cmd\git.exe" config --global --add safe.directory C:/YuanyuanRepo
    if ($LASTEXITCODE -ne 0) { throw "Sandbox Git safe-directory setup failed" }

    $fixturePath = Join-Path $outputRoot "authentic-v1.3.2.sqlite3"
    $captureReportPath = Join-Path $outputRoot "v132-capture-report.json"
    $provenancePath = Join-Path $outputRoot "v132-provenance-report.json"
    $migrationReportPath = Join-Path $outputRoot "current-migration-report.json"
    $captureLogPath = Join-Path $outputRoot "v132-capture.log"
    & powershell.exe -NoProfile -ExecutionPolicy Bypass `
        -File "C:\YuanyuanRepo\scripts\capture_v132_runtime_database.ps1" `
        -LegacyCandidatePath "C:\YuanyuanRepo\src-tauri\target\v132-runtime-qa-11841b88\published\Yuanyuan-Reminder-1.3.2-x64-Portable.exe" `
        -TagArchivePath "C:\YuanyuanRepo\src-tauri\target\v132-runtime-qa-11841b88\yuanyuan-reminder-v1.3.2.zip" `
        -ReleaseChecksumPath "C:\YuanyuanRepo\src-tauri\target\v132-runtime-qa-11841b88\published\SHA256SUMS.txt" `
        -CaptureExecutablePath "C:\YuanyuanRepo\src-tauri\target\release\yuanyuan-database-migration-qa-capture.exe" `
        -FixturePath $fixturePath `
        -CaptureReportPath $captureReportPath `
        -ProvenancePath $provenancePath `
        -StageInTestProfileTemp `
        -DisableWebViewJavascriptForLegacyInitialization `
        -AcknowledgeFreshTestAccount *>&1 |
        Set-Content -Encoding UTF8 -LiteralPath $captureLogPath
    $captureExitCode = $LASTEXITCODE
    if ($captureExitCode -ne 0) {
        $captureFailure = [string]((
            Get-Content -Encoding UTF8 -LiteralPath $captureLogPath |
                Select-Object -Last 20
        ) -join " | ")
        throw "authentic v1.3.2 runtime database capture failed: $captureFailure"
    }
    $capture = Get-Content -Raw -Encoding UTF8 -LiteralPath $captureReportPath |
        ConvertFrom-Json
    $provenance = Get-Content -Raw -Encoding UTF8 -LiteralPath $provenancePath |
        ConvertFrom-Json
    if (
        $capture.status -ne "passed" -or
        $capture.sourceDatabaseVersion -ne 6 -or
        $provenance.status -ne "passed" -or
        -not $provenance.execution.runtimeDatabaseCreated -or
        -not $provenance.execution.dataRootRemoved -or
        -not $provenance.execution.stageRemoved
    ) {
        throw "authentic v1.3.2 capture reports are incomplete"
    }
    $status.authenticRuntimeDatabaseCreated = $true
    $status.authenticCapturePassed = $true
    $status.sandboxDataCleaned = $true
    $status.fixtureSha256 = (
        Get-FileHash -Algorithm SHA256 -LiteralPath $fixturePath
    ).Hash
    $status.captureReportSha256 = (
        Get-FileHash -Algorithm SHA256 -LiteralPath $captureReportPath
    ).Hash
    $status.provenanceReportSha256 = (
        Get-FileHash -Algorithm SHA256 -LiteralPath $provenancePath
    ).Hash

    & "C:\YuanyuanRepo\src-tauri\target\release\yuanyuan-database-migration-qa.exe" `
        --fixture $fixturePath `
        --report $migrationReportPath `
        --attest-source-release 1.3.2
    if ($LASTEXITCODE -ne 0) { throw "current migration, backup or rollback QA failed" }
    $migration = Get-Content -Raw -Encoding UTF8 -LiteralPath $migrationReportPath |
        ConvertFrom-Json
    $migrationChecks = @{}
    foreach ($check in @($migration.checks)) {
        $migrationChecks[[string]$check.id] = [bool]$check.passed
    }
    $requiredMigrationChecks = @(
        "source_read_only",
        "source_integrity",
        "v132_schema_identity",
        "production_migration",
        "row_preservation",
        "backup_restore",
        "failed_restore_rollback",
        "post_restore_health"
    )
    if (
        $migration.status -ne "passed" -or
        $migration.sourceDatabaseVersion -ne 6 -or
        $migration.migratedDatabaseVersion -ne 12 -or
        $migration.sourceSha256 -ne $status.fixtureSha256 -or
        $migration.sourceLogicalSha256 -ne $migration.migratedMatchedSourceRowsSha256 -or
        @($requiredMigrationChecks | Where-Object {
            -not $migrationChecks.ContainsKey($_) -or -not $migrationChecks[$_]
        }).Count -ne 0
    ) {
        throw "current migration report is incomplete"
    }
    $status.migrationBackupRollbackPassed = $true
    $status.migrationReportSha256 = (
        Get-FileHash -Algorithm SHA256 -LiteralPath $migrationReportPath
    ).Hash
    $status.ready = $true
}
catch {
    $status.failure = [string]$_.Exception.Message
}
finally {
    $status.generatedAt = (Get-Date).ToUniversalTime().ToString("o")
    $status | ConvertTo-Json -Depth 10 |
        Set-Content -Encoding UTF8 -LiteralPath $statusPath
    [IO.File]::WriteAllText(
        $completePath,
        "YUANYUAN_WINDOWS_SANDBOX_V132_COMPLETE_V1`n",
        [Text.UTF8Encoding]::new($false)
    )
    Start-Process -FilePath shutdown.exe `
        -ArgumentList @("/s", "/f", "/t", "0") `
        -WindowStyle Hidden
}
if (-not $status.ready) { exit 2 }
'@
    $encodedLogonBootstrap = [Convert]::ToBase64String(
        [Text.Encoding]::Unicode.GetBytes($logonBootstrap)
    )
    $configuration = @"
<Configuration>
  <VGpu>Disable</VGpu>
  <Networking>Disable</Networking>
  <AudioInput>Disable</AudioInput>
  <VideoInput>Disable</VideoInput>
  <PrinterRedirection>Disable</PrinterRedirection>
  <ClipboardRedirection>Disable</ClipboardRedirection>
  <ProtectedClient>Disable</ProtectedClient>
  <MappedFolders>
    <MappedFolder>
      <HostFolder>$projectXml</HostFolder>
      <SandboxFolder>C:\YuanyuanRepo</SandboxFolder>
      <ReadOnly>true</ReadOnly>
    </MappedFolder>
    <MappedFolder>
      <HostFolder>$outputXml</HostFolder>
      <SandboxFolder>C:\YuanyuanOutput</SandboxFolder>
      <ReadOnly>false</ReadOnly>
    </MappedFolder>
    <MappedFolder>
      <HostFolder>$webView2RuntimeXml</HostFolder>
      <SandboxFolder>C:\YuanyuanWebView2</SandboxFolder>
      <ReadOnly>true</ReadOnly>
    </MappedFolder>
    <MappedFolder>
      <HostFolder>$gitRootXml</HostFolder>
      <SandboxFolder>C:\YuanyuanGit</SandboxFolder>
      <ReadOnly>true</ReadOnly>
    </MappedFolder>
  </MappedFolders>
  <LogonCommand>
    <Command>powershell.exe -NoProfile -ExecutionPolicy Bypass -EncodedCommand $encodedLogonBootstrap</Command>
  </LogonCommand>
</Configuration>
"@
    [IO.File]::WriteAllText(
        $configPath,
        $configuration,
        [Text.UTF8Encoding]::new($false)
    )

    $sandboxStartedAt = Get-Date
    $sandbox = Start-Process `
        -FilePath $sandboxExecutable `
        -ArgumentList @("`"$configPath`"") `
        -PassThru `
        -WindowStyle Normal
    $deadline = [DateTime]::UtcNow.AddSeconds($TimeoutSeconds)
    while ([DateTime]::UtcNow -lt $deadline) {
        if (Test-Path -LiteralPath $completePath -PathType Leaf) { break }
        Start-Sleep -Seconds 1
    }
    if (-not (Test-Path -LiteralPath $completePath -PathType Leaf)) {
        throw "Windows Sandbox v1.3.2 probe timed out"
    }
    $status = Get-Content -Raw -Encoding UTF8 -LiteralPath $statusPath |
        ConvertFrom-Json
    if (-not $status.ready) {
        throw "Windows Sandbox v1.3.2 probe failed: $($status.failure)"
    }
    Write-Output "Windows Sandbox authentic v1.3.2 compatibility probe passed: $statusPath"
    Write-Output "YUANYUAN_V132_EVIDENCE_ROOT=$outputRoot"
}
finally {
    if ($null -ne $sandbox -and -not $sandbox.HasExited) {
        $sandbox.WaitForExit(60000) | Out-Null
        $sandbox.Refresh()
    }
    if ($null -ne $sandbox -and -not $sandbox.HasExited) {
        Stop-Process -Id $sandbox.Id -Force -ErrorAction SilentlyContinue
    }
    if ($null -ne $sandboxStartedAt) {
        Get-Process -ErrorAction SilentlyContinue |
            Where-Object {
                ($_.ProcessName -like "*WindowsSandbox*" -or
                    $_.ProcessName -eq "vmmemWindowsSandbox") -and
                $_.StartTime -ge $sandboxStartedAt
            } |
            Stop-Process -Force -ErrorAction SilentlyContinue
    }
    if (Test-Path -LiteralPath $configPath -PathType Leaf) {
        Remove-Item -LiteralPath $configPath -Force
    }
}
