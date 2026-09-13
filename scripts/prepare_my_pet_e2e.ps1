param(
    [switch]$Launch,
    [ValidateSet('learning-on', 'learning-off')]
    [string]$BuildVariant = 'learning-on',
    [string]$BackupEvidenceDirectory
)
$ErrorActionPreference = 'Stop'
$taskProject = Split-Path -Parent $PSScriptRoot
$taskVersion = (Get-Content -LiteralPath (Join-Path $taskProject 'package.json') -Raw -Encoding UTF8 | ConvertFrom-Json).version
$taskProduct = (Get-Content -LiteralPath (Join-Path $taskProject 'src-tauri\tauri.conf.json') -Raw -Encoding UTF8 | ConvertFrom-Json).productName
$taskRun = Join-Path $taskProject ('work\my-pet-e2e\' + [DateTime]::UtcNow.ToString('yyyyMMddTHHmmssfffZ'))
$taskInput = Join-Path $taskRun 'input'
$taskOutput = Join-Path $taskRun 'evidence'
$taskCandidateTarget = if ($BuildVariant -eq 'learning-off') { 'src-tauri\target\my-pet-no-learning' } else { 'src-tauri\target' }
$taskCandidateRoot = Join-Path $taskProject $taskCandidateTarget
$taskInstaller = Join-Path $taskCandidateRoot "release\bundle\nsis\$($taskProduct)_$($taskVersion)_x64-setup.exe"
$taskCore = Join-Path $taskCandidateRoot 'release\yuanyuan-reminder.exe'
$taskHelper = Join-Path $taskProject 'src-tauri\target\release\yuanyuan-installed-candidate-qa.exe'
$taskRuntimeVersion = (Get-ItemProperty -LiteralPath 'Registry::HKEY_LOCAL_MACHINE\SOFTWARE\WOW6432Node\Microsoft\EdgeUpdate\Clients\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}').pv
$taskRuntime = Join-Path ${env:ProgramFiles(x86)} "Microsoft\EdgeWebView\Application\$taskRuntimeVersion"
$taskSignature = Get-AuthenticodeSignature -LiteralPath (Join-Path $taskRuntime 'msedgewebview2.exe')
if ($taskSignature.Status -ne 'Valid' -or $taskSignature.SignerCertificate.Subject -notmatch 'Microsoft Corporation') { throw 'Host WebView2 must have a valid Microsoft signature.' }
foreach ($taskRequired in @($taskInstaller, $taskCore, $taskHelper)) {
    if (-not (Test-Path -LiteralPath $taskRequired -PathType Leaf)) { throw "Missing required input: $taskRequired" }
}
New-Item -ItemType Directory -Path $taskInput, $taskOutput | Out-Null
Copy-Item -LiteralPath $taskInstaller -Destination (Join-Path $taskInput 'candidate.exe')
Copy-Item -LiteralPath $taskHelper -Destination (Join-Path $taskInput 'inspect.exe')
# The QA CLI is built by Cargo, unlike Tauri's statically linked production binary.
# Bundle its real Microsoft runtime locally in test inputs; never install it on the host.
$taskCrt = Join-Path $env:WINDIR 'System32\vcruntime140.dll'
$taskCrtSignature = Get-AuthenticodeSignature -LiteralPath $taskCrt
if ($taskCrtSignature.Status -ne 'Valid' -or $taskCrtSignature.SignerCertificate.Subject -notmatch 'Microsoft Corporation') { throw 'QA runtime must have a valid Microsoft signature.' }
Copy-Item -LiteralPath $taskCrt -Destination (Join-Path $taskInput 'vcruntime140.dll')
Copy-Item -LiteralPath (Join-Path $PSScriptRoot 'my_pet_sandbox_guest.ps1') -Destination (Join-Path $taskInput 'guest.ps1')
Copy-Item -LiteralPath (Join-Path $PSScriptRoot 'fixtures\my-pet-e2e-words.csv') -Destination (Join-Path $taskInput 'e2e-words.csv')
$taskCases = @(
    @{ file = 'full'; name = 'E2E Full'; omit = @() },
    @{ file = 'basic'; name = 'E2E Basic'; omit = @('--without-learning', '--without-scene') },
    @{ file = 'no-learning'; name = 'E2E No Learning'; omit = @('--without-learning') },
    @{ file = 'no-scene'; name = 'E2E No Scene'; omit = @('--without-scene') }
)
foreach ($taskCase in $taskCases) {
    $taskPackArgs = @((Join-Path $PSScriptRoot 'package_pet.mjs'), '--source', (Join-Path $taskProject 'public\assets\pet'), '--license', (Join-Path $taskProject 'ASSETS_LICENSE.md'), '--output', (Join-Path $taskInput ($taskCase.file + '.yuanyuan-pet')), '--name', $taskCase.name) + $taskCase.omit
    & node @taskPackArgs
    if ($LASTEXITCODE -ne 0) { throw 'Unable to build test package.' }
}
& node (Join-Path $PSScriptRoot 'prepare_my_pet_invalid_fixtures.mjs') --base (Join-Path $taskInput 'full.yuanyuan-pet') --output (Join-Path $taskInput 'invalid')
if ($LASTEXITCODE -ne 0) { throw 'Unable to prepare inert invalid-import fixtures.' }
$taskBackupHashes = [ordered]@{}
if ($BackupEvidenceDirectory) {
    $taskBackupSource = (Resolve-Path -LiteralPath $BackupEvidenceDirectory).Path
    $taskEvidenceRoot = [IO.Path]::GetFullPath((Join-Path $taskProject 'work\my-pet-e2e')) + [IO.Path]::DirectorySeparatorChar
    if (-not $taskBackupSource.StartsWith($taskEvidenceRoot, [StringComparison]::OrdinalIgnoreCase)) { throw 'Backup inputs must come from this project synthetic E2E evidence.' }
    if (((Get-Item -LiteralPath $taskBackupSource).Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { throw 'Backup evidence must be a plain directory.' }
    $taskBackupDestination = Join-Path $taskInput 'restore-backups'
    New-Item -ItemType Directory -Path $taskBackupDestination | Out-Null
    foreach ($taskBackupFile in (Get-ChildItem -LiteralPath $taskBackupSource -Filter '*.sqlite3' -File | Sort-Object Name)) {
        if ($taskBackupFile.Name -notmatch '^(auto|manual)-[a-zA-Z0-9.-]+\.sqlite3$' -or ($taskBackupFile.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { throw 'Unexpected backup fixture.' }
        $taskBackupWal = $taskBackupFile.FullName + '-wal'
        if ((Test-Path -LiteralPath $taskBackupWal) -and (Get-Item -LiteralPath $taskBackupWal).Length -ne 0) { throw 'Backup fixture has nonempty WAL; capture a consistent backup first.' }
        Copy-Item -LiteralPath $taskBackupFile.FullName -Destination (Join-Path $taskBackupDestination $taskBackupFile.Name)
        $taskBackupHashes[$taskBackupFile.Name] = (Get-FileHash -LiteralPath $taskBackupFile.FullName -Algorithm SHA256).Hash
    }
    if ($taskBackupHashes.Count -eq 0) { throw 'No synthetic backup fixtures found.' }
}
# Tauri changes one fixed bundle-type marker UNK -> NSS inside the unsigned NSIS payload.
# Account for that documented packaging transform, but do not allow any other byte differences.
$taskCoreBytes = [IO.File]::ReadAllBytes($taskCore)
$taskCoreText = [Text.Encoding]::ASCII.GetString($taskCoreBytes)
$taskSourceMarker = '__TAURI_BUNDLE_TYPE_VAR_UNK'
$taskInstalledMarker = '__TAURI_BUNDLE_TYPE_VAR_NSS'
$taskMarkerOffset = $taskCoreText.IndexOf($taskSourceMarker, [StringComparison]::Ordinal)
if ($taskMarkerOffset -lt 0 -or $taskCoreText.IndexOf($taskSourceMarker, $taskMarkerOffset + 1, [StringComparison]::Ordinal) -ge 0) { throw 'Expected exactly one Tauri source bundle marker.' }
if ((Get-AuthenticodeSignature -LiteralPath $taskCore).Status -ne 'NotSigned') { throw 'This unsigned payload comparator requires adaptation for signed candidates.' }
[Array]::Copy([Text.Encoding]::ASCII.GetBytes($taskInstalledMarker), 0, $taskCoreBytes, $taskMarkerOffset, $taskInstalledMarker.Length)
$taskHasher = [Security.Cryptography.SHA256]::Create()
try { $taskBundledHash = [BitConverter]::ToString($taskHasher.ComputeHash($taskCoreBytes)).Replace('-', '') } finally { $taskHasher.Dispose() }
$taskBindings = [ordered]@{
    version = $taskVersion; productName = $taskProduct; buildVariant = $BuildVariant
    installerSha256 = (Get-FileHash -LiteralPath $taskInstaller -Algorithm SHA256).Hash
    sourceCoreSha256 = (Get-FileHash -LiteralPath $taskCore -Algorithm SHA256).Hash
    coreSha256 = $taskBundledHash
    payloadTransform = 'one __TAURI_BUNDLE_TYPE_VAR_UNK marker replaced by __TAURI_BUNDLE_TYPE_VAR_NSS'
    helperSha256 = (Get-FileHash -LiteralPath $taskHelper -Algorithm SHA256).Hash
    vocabularySha256 = (Get-FileHash -LiteralPath (Join-Path $taskInput 'e2e-words.csv') -Algorithm SHA256).Hash
    invalidFixturesManifestSha256 = (Get-FileHash -LiteralPath (Join-Path $taskInput 'invalid\fixtures.json') -Algorithm SHA256).Hash
    restoreBackupSha256 = $taskBackupHashes
    helperCrtSha256 = (Get-FileHash -LiteralPath $taskCrt -Algorithm SHA256).Hash
    webviewVersion = $taskRuntimeVersion
    webviewSha256 = (Get-FileHash -LiteralPath (Join-Path $taskRuntime 'msedgewebview2.exe') -Algorithm SHA256).Hash
    createdAt = [DateTime]::UtcNow.ToString('o'); networkEnabled = $false; syntheticDataOnly = $true
    packageSha256 = [ordered]@{}
}
foreach ($taskCase in $taskCases) {
    $taskFilename = $taskCase.file + '.yuanyuan-pet'
    $taskBindings.packageSha256[$taskFilename] = (Get-FileHash -LiteralPath (Join-Path $taskInput $taskFilename) -Algorithm SHA256).Hash
}
$taskBindings | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $taskInput 'bindings.json') -Encoding UTF8
$taskInputXml = [Security.SecurityElement]::Escape($taskInput)
$taskOutputXml = [Security.SecurityElement]::Escape($taskOutput)
$taskRuntimeXml = [Security.SecurityElement]::Escape($taskRuntime)
$taskConfiguration = @"
<Configuration>
  <VGpu>Disable</VGpu><Networking>Disable</Networking>
  <AudioInput>Disable</AudioInput><VideoInput>Disable</VideoInput>
  <PrinterRedirection>Disable</PrinterRedirection><ClipboardRedirection>Disable</ClipboardRedirection>
  <MappedFolders>
    <MappedFolder><HostFolder>$taskInputXml</HostFolder><SandboxFolder>C:\YuanyuanPetInput</SandboxFolder><ReadOnly>true</ReadOnly></MappedFolder>
    <MappedFolder><HostFolder>$taskOutputXml</HostFolder><SandboxFolder>C:\YuanyuanPetOutput</SandboxFolder><ReadOnly>false</ReadOnly></MappedFolder>
    <MappedFolder><HostFolder>$taskRuntimeXml</HostFolder><SandboxFolder>C:\YuanyuanPetWebView2</SandboxFolder><ReadOnly>true</ReadOnly></MappedFolder>
  </MappedFolders>
  <LogonCommand><Command>powershell.exe -NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File C:\YuanyuanPetInput\guest.ps1</Command></LogonCommand>
</Configuration>
"@
$taskConfigPath = Join-Path $taskRun 'my-pet.wsb'
$taskConfiguration | Set-Content -LiteralPath $taskConfigPath -Encoding UTF8
Write-Output "E2E run prepared: $taskRun"
if ($Launch) {
    $taskSandbox = Start-Process -FilePath (Join-Path $env:WINDIR 'System32\WindowsSandbox.exe') -ArgumentList ('"' + $taskConfigPath + '"') -PassThru -WindowStyle Hidden
    Write-Output "Sandbox process: $($taskSandbox.Id)"
}
