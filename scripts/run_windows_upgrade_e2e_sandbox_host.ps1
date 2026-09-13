param(
    [string]$ReleaseRoot = "",
    [string]$BaselineRoot = "",
    [ValidateRange(120, 1800)]
    [int]$TimeoutSeconds = 900
)

$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"
$systemModuleRoot = Join-Path $env:WINDIR "System32\WindowsPowerShell\v1.0\Modules"
$env:PSModulePath = $systemModuleRoot
[void](Get-Command Get-AuthenticodeSignature -ErrorAction Stop)
$projectRoot = Split-Path -Parent $PSScriptRoot
if ([string]::IsNullOrWhiteSpace($ReleaseRoot)) {
    $ReleaseRoot = Join-Path $projectRoot "src-tauri\target\release"
}
$releaseRoot = [IO.Path]::GetFullPath($ReleaseRoot)
$defaultBaselineRoot = Join-Path $projectRoot "src-tauri\target\windows-upgrade-baseline\pre013-aaffe998e3bf-v1.5.7"
if ([string]::IsNullOrWhiteSpace($BaselineRoot)) {
    $BaselineRoot = $defaultBaselineRoot
}
$baselineRoot = [IO.Path]::GetFullPath($BaselineRoot)
$targetRoot = [IO.Path]::GetFullPath((Join-Path $projectRoot "src-tauri\target"))
$runId = (Get-Date).ToUniversalTime().ToString("yyyyMMddTHHmmssfffZ")
$outputRoot = Join-Path $targetRoot "windows-upgrade-e2e\$runId"
$configPath = Join-Path $outputRoot "windows-upgrade-e2e.wsb"
$completePath = Join-Path $outputRoot "windows-upgrade-e2e.complete"
$statusPath = Join-Path $outputRoot "windows-upgrade-e2e-status.json"

$sandboxExecutable = (Get-Command WindowsSandbox.exe -ErrorAction Stop).Source
$feature = Get-WindowsOptionalFeature -Online -FeatureName Containers-DisposableClientVM -ErrorAction Stop
if ($feature.State -ne "Enabled") { throw "Windows Sandbox feature is not enabled" }

foreach ($requiredPath in @(
    (Join-Path $projectRoot "scripts\run_windows_upgrade_e2e_sandbox.ps1"),
    (Join-Path $projectRoot "src-tauri\target\release\yuanyuan-installed-candidate-qa.exe"),
    (Join-Path $baselineRoot "artifacts\baseline-metadata.json"),
    (Join-Path $releaseRoot "bundle\nsis")
)) {
    if (-not (Test-Path -LiteralPath $requiredPath)) {
        throw "required upgrade E2E input is missing: $requiredPath"
    }
}

$webView2ClientKey = "Registry::HKEY_LOCAL_MACHINE\SOFTWARE\WOW6432Node\Microsoft\EdgeUpdate\Clients\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}"
$webView2Version = [string](Get-ItemPropertyValue -LiteralPath $webView2ClientKey -Name "pv" -ErrorAction Stop)
$webView2RuntimeRoot = Join-Path ${env:ProgramFiles(x86)} "Microsoft\EdgeWebView\Application\$webView2Version"
$webView2Executable = Join-Path $webView2RuntimeRoot "msedgewebview2.exe"
$webView2Signature = Get-AuthenticodeSignature -LiteralPath $webView2Executable
if (
    $webView2Signature.Status -ne "Valid" -or
    $null -eq $webView2Signature.SignerCertificate -or
    $webView2Signature.SignerCertificate.Subject -notlike "*O=Microsoft Corporation*"
) {
    throw "installed WebView2 runtime is not validly signed by Microsoft"
}

function Escape-Xml([string]$Value) { [Security.SecurityElement]::Escape($Value) }

New-Item -ItemType Directory -Path $outputRoot | Out-Null
$bootstrap = @'
$ErrorActionPreference = "Stop"
$outputRoot = "C:\YuanyuanOutput"
$statusPath = Join-Path $outputRoot "windows-upgrade-e2e-status.json"
$completePath = Join-Path $outputRoot "windows-upgrade-e2e.complete"
try {
    & "C:\YuanyuanRepo\scripts\run_windows_upgrade_e2e_sandbox.ps1" `
        -ReleaseRoot "C:\YuanyuanRelease" `
        -BaselineRoot "C:\YuanyuanBaseline" `
        -OutputRoot $outputRoot `
        -WebView2RuntimeRoot "C:\YuanyuanWebView2"
    exit $LASTEXITCODE
}
catch {
    [ordered]@{
        schemaVersion = 1
        generatedAt = (Get-Date).ToUniversalTime().ToString("o")
        profile = "windows-sandbox-v1.5.7-to-v1.5.8-upgrade-e2e"
        ready = $false
        failure = "bootstrap: $([string]$_.Exception.Message)"
    } | ConvertTo-Json -Depth 4 | Set-Content -Encoding UTF8 -LiteralPath $statusPath
    [IO.File]::WriteAllText($completePath, "YUANYUAN_WINDOWS_UPGRADE_E2E_COMPLETE_V1`n", [Text.UTF8Encoding]::new($false))
    Start-Process shutdown.exe -ArgumentList @("/s", "/f", "/t", "0") -WindowStyle Hidden
    exit 2
}
'@
$encodedBootstrap = [Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes($bootstrap))
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
    <MappedFolder><HostFolder>$(Escape-Xml $projectRoot)</HostFolder><SandboxFolder>C:\YuanyuanRepo</SandboxFolder><ReadOnly>true</ReadOnly></MappedFolder>
    <MappedFolder><HostFolder>$(Escape-Xml $releaseRoot)</HostFolder><SandboxFolder>C:\YuanyuanRelease</SandboxFolder><ReadOnly>true</ReadOnly></MappedFolder>
    <MappedFolder><HostFolder>$(Escape-Xml $baselineRoot)</HostFolder><SandboxFolder>C:\YuanyuanBaseline</SandboxFolder><ReadOnly>true</ReadOnly></MappedFolder>
    <MappedFolder><HostFolder>$(Escape-Xml $outputRoot)</HostFolder><SandboxFolder>C:\YuanyuanOutput</SandboxFolder><ReadOnly>false</ReadOnly></MappedFolder>
    <MappedFolder><HostFolder>$(Escape-Xml $webView2RuntimeRoot)</HostFolder><SandboxFolder>C:\YuanyuanWebView2</SandboxFolder><ReadOnly>true</ReadOnly></MappedFolder>
  </MappedFolders>
  <LogonCommand><Command>powershell.exe -NoProfile -ExecutionPolicy Bypass -EncodedCommand $encodedBootstrap</Command></LogonCommand>
</Configuration>
"@
[IO.File]::WriteAllText($configPath, $configuration, [Text.UTF8Encoding]::new($false))

$sandbox = $null
try {
    $sandbox = Start-Process -FilePath $sandboxExecutable -ArgumentList @("`"$configPath`"") -PassThru -WindowStyle Normal
    $deadline = [DateTime]::UtcNow.AddSeconds($TimeoutSeconds)
    while ([DateTime]::UtcNow -lt $deadline) {
        if (Test-Path -LiteralPath $completePath -PathType Leaf) { break }
        Start-Sleep -Seconds 1
    }
    if (-not (Test-Path -LiteralPath $completePath -PathType Leaf)) {
        throw "Windows Sandbox upgrade E2E timed out"
    }
    $status = Get-Content -Raw -Encoding UTF8 -LiteralPath $statusPath | ConvertFrom-Json
    if (-not $status.ready) {
        $failure = if ([string]::IsNullOrWhiteSpace([string]$status.failure)) {
            "guest report did not satisfy its readiness assertions"
        }
        else {
            [string]$status.failure
        }
        throw "Windows Sandbox upgrade E2E failed: $failure"
    }
    Write-Output "Windows Sandbox 1.5.7 -> 1.5.8 upgrade E2E passed: $statusPath"
}
finally {
    if ($null -ne $sandbox -and -not $sandbox.HasExited) { $sandbox.WaitForExit(60000) | Out-Null }
    if ($null -ne $sandbox -and -not $sandbox.HasExited) { Stop-Process -Id $sandbox.Id -Force -ErrorAction SilentlyContinue }
    if (Test-Path -LiteralPath $configPath -PathType Leaf) { Remove-Item -LiteralPath $configPath -Force }
}
