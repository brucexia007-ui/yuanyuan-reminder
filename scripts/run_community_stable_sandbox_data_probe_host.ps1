param(
    [string]$ReleaseRoot = "",
    [int]$TimeoutSeconds = 900
)

$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"
$systemModuleRoot = Join-Path $env:WINDIR "System32\WindowsPowerShell\v1.0\Modules"
$env:PSModulePath = $systemModuleRoot
[void](Get-Command Get-AuthenticodeSignature -ErrorAction Stop)

if ($TimeoutSeconds -lt 120 -or $TimeoutSeconds -gt 1800) {
    throw "TimeoutSeconds must be between 120 and 1800"
}

$projectRoot = Split-Path -Parent $PSScriptRoot
if ([string]::IsNullOrWhiteSpace($ReleaseRoot)) {
    $ReleaseRoot = Join-Path $projectRoot "src-tauri\target\release"
}
$releaseRoot = [IO.Path]::GetFullPath($ReleaseRoot)
$targetRoot = [IO.Path]::GetFullPath((Join-Path $projectRoot "src-tauri\target"))
$runId = (Get-Date).ToUniversalTime().ToString("yyyyMMddTHHmmssfffZ")
$outputRoot = Join-Path $targetRoot "community-stable-sandbox-data\$runId"
$webView2MetadataPath = Join-Path $outputRoot "webview2-mapped-runtime.json"
$sourceMetadataPath = Join-Path $outputRoot "source-metadata.json"
$configPath = Join-Path $outputRoot "community-stable-data-probe.wsb"
$completePath = Join-Path $outputRoot "sandbox-data-probe.complete"
$statusPath = Join-Path $outputRoot "sandbox-data-probe-status.json"

$sandboxExecutable = (Get-Command WindowsSandbox.exe -ErrorAction Stop).Source
$feature = Get-WindowsOptionalFeature `
    -Online `
    -FeatureName Containers-DisposableClientVM `
    -ErrorAction Stop
if ($feature.State -ne "Enabled") {
    throw "Windows Sandbox feature is not enabled"
}

foreach ($requiredPath in @(
    (Join-Path $projectRoot "package.json"),
    (Join-Path $projectRoot "src-tauri\tauri.conf.json"),
    (Join-Path $projectRoot "scripts\inspect_nsis_payload.ps1"),
    (Join-Path $projectRoot "scripts\probe_release_uninstall_data_choice.ps1"),
    (Join-Path $projectRoot "scripts\run_community_stable_sandbox_data_probe.ps1"),
    (Join-Path $projectRoot "src-tauri\target\release\yuanyuan-installed-candidate-qa.exe"),
    (Join-Path $releaseRoot "yuanyuan-reminder.exe"),
    (Join-Path $releaseRoot "bundle\nsis")
)) {
    if (-not (Test-Path -LiteralPath $requiredPath)) {
        throw "required Sandbox input is missing: $requiredPath"
    }
}

$sandbox = $null
try {
New-Item -ItemType Directory -Path $outputRoot | Out-Null
$gitExecutable = (Get-Command git.exe -ErrorAction Stop).Source
function Read-GitValue([string[]]$Arguments) {
    $value = & $gitExecutable -C $projectRoot @Arguments 2>$null
    if ($LASTEXITCODE -ne 0) { throw "git source metadata query failed: $($Arguments -join ' ')" }
    ([string]($value -join "`n")).Trim()
}
$sourceMetadata = [ordered]@{
    schemaVersion = 1
    capturedAt = (Get-Date).ToUniversalTime().ToString("o")
    branch = Read-GitValue @("branch", "--show-current")
    commit = Read-GitValue @("rev-parse", "HEAD")
    dirty = -not [string]::IsNullOrWhiteSpace((
        Read-GitValue @("status", "--porcelain=v1", "--untracked-files=all")
    ))
}
if (
    [string]::IsNullOrWhiteSpace($sourceMetadata.branch) -or
    $sourceMetadata.commit -notmatch "^[0-9a-f]{40}$"
) {
    throw "git source metadata is incomplete"
}
$sourceMetadata | ConvertTo-Json -Depth 4 |
    Set-Content -Encoding UTF8 -LiteralPath $sourceMetadataPath
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
$webView2Signer = $webView2Signature.SignerCertificate
if (
    $webView2Signature.Status -ne "Valid" -or
    $null -eq $webView2Signer -or
    $webView2Signer.Subject -notlike "*O=Microsoft Corporation*"
) {
    throw "installed WebView2 runtime is not validly signed by Microsoft"
}
$webView2Metadata = [ordered]@{
    schemaVersion = 1
    source = "installed-host-microsoft-webview2-runtime"
    bytes = [long](Get-Item -LiteralPath $webView2Executable).Length
    sha256 = (Get-FileHash -Algorithm SHA256 -LiteralPath $webView2Executable).Hash
    signatureStatus = [string]$webView2Signature.Status
    signerSubject = [string]$webView2Signer.Subject
    productVersion = [string](Get-Item -LiteralPath $webView2Executable).VersionInfo.ProductVersion
}
$webView2Metadata | ConvertTo-Json -Depth 4 |
    Set-Content -Encoding UTF8 -LiteralPath $webView2MetadataPath

function Escape-Xml([string]$Value) {
    [Security.SecurityElement]::Escape($Value)
}

$projectXml = Escape-Xml $projectRoot
$releaseXml = Escape-Xml $releaseRoot
$outputXml = Escape-Xml $outputRoot
$webView2RuntimeXml = Escape-Xml $webView2RuntimeRoot
$logonBootstrap = @'
$ErrorActionPreference = "Stop"
$outputRoot = "C:\YuanyuanOutput"
$statusPath = Join-Path $outputRoot "sandbox-data-probe-status.json"
$completePath = Join-Path $outputRoot "sandbox-data-probe.complete"
try {
    [IO.File]::WriteAllText(
        (Join-Path $outputRoot "sandbox-logon-command.started"),
        "YUANYUAN_WINDOWS_SANDBOX_LOGON_STARTED_V1`n",
        [Text.UTF8Encoding]::new($false)
    )
    & "C:\YuanyuanRepo\scripts\run_community_stable_sandbox_data_probe.ps1" `
        -ReleaseRoot "C:\YuanyuanRelease" `
        -OutputRoot $outputRoot `
        -WebView2RuntimeRoot "C:\YuanyuanWebView2"
    exit $LASTEXITCODE
}
catch {
    $failure = [ordered]@{
        schemaVersion = 1
        generatedAt = (Get-Date).ToUniversalTime().ToString("o")
        profile = "community-stable-installed-e2e"
        sandboxUser = [Environment]::UserName
        ready = $false
        failure = "logon bootstrap: $([string]$_.Exception.Message)"
    }
    $failure | ConvertTo-Json -Depth 4 |
        Set-Content -Encoding UTF8 -LiteralPath $statusPath
    [IO.File]::WriteAllText(
        $completePath,
        "YUANYUAN_WINDOWS_SANDBOX_DATA_PROBE_COMPLETE_V1`n",
        [Text.UTF8Encoding]::new($false)
    )
    Start-Process -FilePath shutdown.exe `
        -ArgumentList @("/s", "/f", "/t", "0") `
        -WindowStyle Hidden
    exit 2
}
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
      <HostFolder>$releaseXml</HostFolder>
      <SandboxFolder>C:\YuanyuanRelease</SandboxFolder>
      <ReadOnly>false</ReadOnly>
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
        throw "Windows Sandbox data probe timed out"
    }
    $status = Get-Content -Raw -Encoding UTF8 -LiteralPath $statusPath |
        ConvertFrom-Json
    if (-not $status.ready) {
        throw "Windows Sandbox data probe failed: $($status.failure)"
    }
    Write-Output "Windows Sandbox installed-candidate E2E passed: $statusPath"
}
finally {
    if ($null -ne $sandbox -and -not $sandbox.HasExited) {
        $sandbox.WaitForExit(60000) | Out-Null
        $sandbox.Refresh()
    }
    if ($null -ne $sandbox -and -not $sandbox.HasExited) {
        Stop-Process -Id $sandbox.Id -Force -ErrorAction SilentlyContinue
    }
    if (Test-Path -LiteralPath $configPath -PathType Leaf) {
        Remove-Item -LiteralPath $configPath -Force
    }
}
