param(
    [Parameter(Mandatory = $true)]
    [string]$LegacyCandidatePath,

    [Parameter(Mandatory = $true)]
    [string]$TagArchivePath,

    [Parameter(Mandatory = $true)]
    [string]$ReleaseChecksumPath,

    [Parameter(Mandatory = $true)]
    [string]$CaptureExecutablePath,

    [Parameter(Mandatory = $true)]
    [string]$FixturePath,

    [Parameter(Mandatory = $true)]
    [string]$CaptureReportPath,

    [Parameter(Mandatory = $true)]
    [string]$ProvenancePath,

    [ValidatePattern("^[0-9a-fA-F]{40}$")]
    [string]$ExpectedTagCommit = "11841b88cf7b3e6d10502fd0158401e2c02167ae",

    [ValidatePattern("^[0-9a-fA-F]{64}$")]
    [string]$ExpectedLegacyCandidateSha256 = "D142095E41EA4A1D6BB89D7A20D8F44CBA3519C085E4EC5E674E4FB25CFF89AD",

    [ValidatePattern("^[0-9a-fA-F]{64}$")]
    [string]$ExpectedReleaseChecksumSha256 = "A3553273D4EE693FED5B9DB50C83A675EB0C1650B022A75067C6A1A83CDB160D",

    [ValidateRange(5, 60)]
    [int]$WindowTimeoutSeconds = 30,

    [switch]$CaptureChildStreams,

    [switch]$StageInTestProfileTemp,

    [switch]$DisableWebViewJavascriptForLegacyInitialization,

    [switch]$AcknowledgeFreshTestAccount
)

$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"

$projectRoot = Split-Path -Parent $PSScriptRoot
$runId = "{0}-{1}" -f
    (Get-Date).ToUniversalTime().ToString("yyyyMMddTHHmmssZ"),
    [Guid]::NewGuid().ToString("N")
$process = $null
$dataRootClaimed = $false
$stageRoot = $null
$stageRemoved = $false
$dataRootRemoved = $false
$formalDataRoot = $null
$registeredLocalData = $null
$dataMarker = $null
$ownershipValue = $null
$outputParent = $null
$stageLeaf = $null
$stageMarker = $null
$stageParent = $null
$legacyStdout = $null
$legacyStderr = $null

if (-not ("YuanyuanV132CaptureProcessSnapshot" -as [type])) {
    Add-Type -TypeDefinition @"
using System;
using System.Collections.Generic;
using System.ComponentModel;
using System.Runtime.InteropServices;

public sealed class YuanyuanV132CaptureProcessRelation {
    public uint ProcessId { get; set; }
    public uint ParentProcessId { get; set; }
}

public static class YuanyuanV132CaptureProcessSnapshot {
    private const uint SnapshotProcesses = 0x00000002;

    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    private struct ProcessEntry {
        public uint Size;
        public uint Usage;
        public uint ProcessId;
        public IntPtr DefaultHeapId;
        public uint ModuleId;
        public uint ThreadCount;
        public uint ParentProcessId;
        public int BasePriority;
        public uint Flags;
        [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 260)]
        public string ExecutableFile;
    }

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern IntPtr CreateToolhelp32Snapshot(uint flags, uint processId);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern bool Process32First(IntPtr snapshot, ref ProcessEntry entry);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern bool Process32Next(IntPtr snapshot, ref ProcessEntry entry);
    [DllImport("kernel32.dll")]
    private static extern bool CloseHandle(IntPtr handle);

    public static YuanyuanV132CaptureProcessRelation[] Capture() {
        var snapshot = CreateToolhelp32Snapshot(SnapshotProcesses, 0);
        if (snapshot == new IntPtr(-1)) {
            throw new Win32Exception(Marshal.GetLastWin32Error());
        }
        try {
            var rows = new List<YuanyuanV132CaptureProcessRelation>();
            var entry = new ProcessEntry { Size = (uint)Marshal.SizeOf(typeof(ProcessEntry)) };
            if (Process32First(snapshot, ref entry)) {
                do {
                    rows.Add(new YuanyuanV132CaptureProcessRelation {
                        ProcessId = entry.ProcessId,
                        ParentProcessId = entry.ParentProcessId
                    });
                    entry.Size = (uint)Marshal.SizeOf(typeof(ProcessEntry));
                } while (Process32Next(snapshot, ref entry));
            }
            return rows.ToArray();
        }
        finally {
            CloseHandle(snapshot);
        }
    }
}
"@
}

function Get-Sha256([string]$Path) {
    (Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash
}

function Assert-OrdinaryFile([string]$Path, [string]$Label) {
    $absolutePath = [IO.Path]::GetFullPath($Path)
    if (-not [IO.Path]::IsPathRooted($Path) -or
        -not $absolutePath.Equals($Path, [StringComparison]::OrdinalIgnoreCase)) {
        throw "${Label}_path_must_be_absolute"
    }
    $item = Get-Item -LiteralPath $Path -Force
    if ($item.PSIsContainer -or
        (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0)) {
        throw "${Label}_must_be_an_ordinary_file"
    }
    $item.FullName
}

function Resolve-NewOutput([string]$Path, [string]$ExpectedExtension, [string]$Label) {
    $absolutePath = [IO.Path]::GetFullPath($Path)
    if (-not [IO.Path]::IsPathRooted($Path) -or
        -not $absolutePath.Equals($Path, [StringComparison]::OrdinalIgnoreCase)) {
        throw "${Label}_path_must_be_absolute"
    }
    if ([IO.Path]::GetExtension($Path) -ne $ExpectedExtension) {
        throw "${Label}_extension_is_invalid"
    }
    if (Test-Path -LiteralPath $Path) {
        throw "${Label}_already_exists"
    }
    $parent = Split-Path -Parent $Path
    $parentItem = Get-Item -LiteralPath $parent -Force
    if (-not $parentItem.PSIsContainer -or
        (($parentItem.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0)) {
        throw "${Label}_parent_must_be_an_ordinary_directory"
    }
    Join-Path $parentItem.FullName (Split-Path -Leaf $Path)
}

function Assert-OrdinaryExactDirectory(
    [string]$Path,
    [string]$ExpectedParent,
    [string]$ExpectedLeaf
) {
    $item = Get-Item -LiteralPath $Path -Force
    if (-not $item.PSIsContainer -or
        (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0)) {
        throw "owned_directory_is_not_ordinary"
    }
    $canonicalPath = (Resolve-Path -LiteralPath $Path).Path
    $canonicalParent = (Resolve-Path -LiteralPath $ExpectedParent).Path
    $canonicalItem = Get-Item -LiteralPath $canonicalPath -Force
    if (-not $canonicalItem.Parent.FullName.Equals(
            $canonicalParent,
            [StringComparison]::OrdinalIgnoreCase
        ) -or $canonicalItem.Name -ne $ExpectedLeaf) {
        throw "owned_directory_escaped_expected_parent"
    }
    $canonicalPath
}

function Get-OwnedProcessIds([int]$RootProcessId) {
    $rows = @([YuanyuanV132CaptureProcessSnapshot]::Capture())
    $owned = [System.Collections.Generic.HashSet[uint32]]::new()
    $owned.Add([uint32]$RootProcessId) | Out-Null
    do {
        $added = $false
        foreach ($row in $rows) {
            if ($owned.Contains([uint32]$row.ParentProcessId) -and
                -not $owned.Contains([uint32]$row.ProcessId)) {
                $owned.Add([uint32]$row.ProcessId) | Out-Null
                $added = $true
            }
        }
    } while ($added)
    @($owned | ForEach-Object { [int]$_ })
}

function Stop-OwnedProcessTree([int]$RootProcessId) {
    $observed = [System.Collections.Generic.HashSet[int]]::new()
    for ($attempt = 0; $attempt -lt 3; $attempt += 1) {
        $owned = @(Get-OwnedProcessIds $RootProcessId)
        foreach ($processId in $owned) { $observed.Add([int]$processId) | Out-Null }
        foreach ($processId in @($owned | Sort-Object -Descending)) {
            Stop-Process -Id $processId -Force -ErrorAction SilentlyContinue
        }
        foreach ($processId in $owned) {
            Wait-Process -Id $processId -Timeout 5 -ErrorAction SilentlyContinue
        }
        if (-not (Get-Process -Id $RootProcessId -ErrorAction SilentlyContinue)) { break }
    }
    $remaining = @($observed | Where-Object {
        Get-Process -Id $_ -ErrorAction SilentlyContinue
    })
    if ($remaining.Count -gt 0) {
        throw "legacy_candidate_process_tree_not_stopped"
    }
}

function Remove-OwnedDirectory(
    [string]$Path,
    [string]$ExpectedParent,
    [string]$ExpectedLeaf,
    [string]$MarkerPath,
    [string]$OwnershipValue
) {
    if (-not (Test-Path -LiteralPath $Path -PathType Container)) { return $true }
    Assert-OrdinaryExactDirectory $Path $ExpectedParent $ExpectedLeaf | Out-Null
    if (-not (Test-Path -LiteralPath $MarkerPath -PathType Leaf) -or
        (Get-Content -Raw -Encoding UTF8 -LiteralPath $MarkerPath) -ne $OwnershipValue) {
        throw "refusing_to_remove_unowned_directory"
    }
    $deadline = [DateTime]::UtcNow.AddSeconds(10)
    do {
        try {
            Remove-Item -LiteralPath $Path -Recurse -Force -ErrorAction Stop
        }
        catch {
            if ([DateTime]::UtcNow -ge $deadline) { throw "owned_directory_cleanup_failed" }
        }
        if (-not (Test-Path -LiteralPath $Path)) { return $true }
        Start-Sleep -Milliseconds 200
    } while ([DateTime]::UtcNow -lt $deadline)
    throw "owned_directory_cleanup_failed"
}

function Write-NewUtf8Json([string]$Path, [object]$Value) {
    $stream = [IO.File]::Open(
        $Path,
        [IO.FileMode]::CreateNew,
        [IO.FileAccess]::Write,
        [IO.FileShare]::None
    )
    try {
        $writer = [IO.StreamWriter]::new($stream, [Text.UTF8Encoding]::new($false))
        try {
            $writer.Write(($Value | ConvertTo-Json -Depth 8))
            $writer.Flush()
            $stream.Flush($true)
        }
        finally {
            $writer.Dispose()
        }
    }
    finally {
        $stream.Dispose()
    }
}

try {
    if (-not $AcknowledgeFreshTestAccount) {
        throw "fresh_test_account_acknowledgement_required"
    }
    if (-not [Environment]::UserInteractive) {
        throw "interactive_windows_session_required"
    }

    $legacyCandidatePath = Assert-OrdinaryFile $LegacyCandidatePath "legacy_candidate"
    $tagArchivePath = Assert-OrdinaryFile $TagArchivePath "tag_archive"
    $releaseChecksumPath = Assert-OrdinaryFile $ReleaseChecksumPath "release_checksum"
    $captureExecutablePath = Assert-OrdinaryFile $CaptureExecutablePath "capture_executable"
    $fixturePath = Resolve-NewOutput $FixturePath ".sqlite3" "fixture"
    $captureReportPath = Resolve-NewOutput $CaptureReportPath ".json" "capture_report"
    $provenancePath = Resolve-NewOutput $ProvenancePath ".json" "provenance"
    if (@(@($fixturePath, $captureReportPath, $provenancePath) |
            Select-Object -Unique).Count -ne 3) {
        throw "output_paths_must_be_distinct"
    }

    $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
    $profileKey = "Registry::HKEY_LOCAL_MACHINE\SOFTWARE\Microsoft\Windows NT\CurrentVersion\ProfileList\$($identity.User.Value)"
    $registeredProfile = [Environment]::ExpandEnvironmentVariables(
        (Get-ItemProperty -LiteralPath $profileKey -Name ProfileImagePath).ProfileImagePath
    )
    $registeredProfile = (Resolve-Path -LiteralPath $registeredProfile).Path
    $registeredLocalData = (Resolve-Path -LiteralPath (
        Join-Path $registeredProfile "AppData\Local"
    )).Path
    $registeredRoamingData = (Resolve-Path -LiteralPath (
        Join-Path $registeredProfile "AppData\Roaming"
    )).Path
    $formalDataRoot = Join-Path $registeredLocalData "com.yuanyuan.reminder"
    $runtimeDatabasePath = Join-Path $formalDataRoot "yuanyuan-reminder.sqlite3"
    if (Test-Path -LiteralPath $formalDataRoot) {
        throw "preexisting_formal_data_root"
    }
    if (@(Get-Process -Name "yuanyuan-reminder" -ErrorAction SilentlyContinue).Count -ne 0) {
        throw "preexisting_application_process"
    }

    $resolvedCommit = (& git.exe -C $projectRoot rev-parse "v1.3.2^{commit}").Trim()
    if ($LASTEXITCODE -ne 0 -or $resolvedCommit -ne $ExpectedTagCommit.ToLowerInvariant()) {
        throw "v132_tag_commit_mismatch"
    }
    $legacyItem = Get-Item -LiteralPath $legacyCandidatePath
    if ($legacyItem.VersionInfo.ProductVersion -ne "1.3.2" -or
        $legacyItem.VersionInfo.FileVersion -ne "1.3.2") {
        throw "legacy_candidate_version_mismatch"
    }
    $legacySha256 = Get-Sha256 $legacyCandidatePath
    if ($legacySha256 -ne $ExpectedLegacyCandidateSha256.ToUpperInvariant()) {
        throw "legacy_candidate_release_hash_mismatch"
    }
    $releaseChecksumSha256 = Get-Sha256 $releaseChecksumPath
    if ($releaseChecksumSha256 -ne $ExpectedReleaseChecksumSha256.ToUpperInvariant()) {
        throw "release_checksum_file_hash_mismatch"
    }
    $expectedChecksumLine = "{0}  {1}" -f
        $legacySha256.ToLowerInvariant(),
        (Split-Path -Leaf $legacyCandidatePath)
    $releaseChecksumLines = @([IO.File]::ReadAllLines($releaseChecksumPath))
    if ($releaseChecksumLines -notcontains $expectedChecksumLine) {
        throw "release_checksum_does_not_name_legacy_candidate"
    }

    $outputParent = Split-Path -Parent $fixturePath
    $stageParent = if ($StageInTestProfileTemp) {
        (Resolve-Path -LiteralPath (Join-Path $registeredLocalData "Temp")).Path
    }
    else {
        $outputParent
    }
    $stageLeaf = "v132-runtime-capture-stage-$runId"
    $stageRoot = Join-Path $stageParent $stageLeaf
    if (Test-Path -LiteralPath $stageRoot) { throw "stage_root_already_exists" }
    New-Item -ItemType Directory -Path $stageRoot | Out-Null
    $ownershipValue = "YUANYUAN_V132_RUNTIME_CAPTURE_V1:$runId`n"
    $stageMarker = Join-Path $stageRoot ".yuanyuan-v132-runtime-capture-stage-v1"
    [IO.File]::WriteAllText($stageMarker, $ownershipValue, [Text.UTF8Encoding]::new($false))
    $verificationArchive = Join-Path $stageRoot "verified-v1.3.2.zip"
    & git.exe -C $projectRoot archive --format=zip "--output=$verificationArchive" v1.3.2
    if ($LASTEXITCODE -ne 0) { throw "v132_tag_archive_generation_failed" }
    $tagArchiveSha256 = Get-Sha256 $tagArchivePath
    if ((Get-Sha256 $verificationArchive) -ne $tagArchiveSha256) {
        throw "provided_tag_archive_does_not_match_repository_tag"
    }
    $stagedCandidate = Join-Path $stageRoot "yuanyuan-reminder.exe"
    Copy-Item -LiteralPath $legacyCandidatePath -Destination $stagedCandidate
    if ((Get-Sha256 $stagedCandidate) -ne $legacySha256) {
        throw "staged_legacy_candidate_hash_mismatch"
    }

    $env:USERPROFILE = $registeredProfile
    $env:LOCALAPPDATA = $registeredLocalData
    $env:APPDATA = $registeredRoamingData
    # The desktop harness may expose both Path and PATH. Windows PowerShell 5.1
    # cannot build a redirected child environment until that duplicate is normalized.
    $effectivePath = $env:Path
    [Environment]::SetEnvironmentVariable(
        "PATH",
        $null,
        [EnvironmentVariableTarget]::Process
    )
    [Environment]::SetEnvironmentVariable(
        "Path",
        $effectivePath,
        [EnvironmentVariableTarget]::Process
    )
    if ($DisableWebViewJavascriptForLegacyInitialization) {
        $env:WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS =
            "--disable-javascript --blink-settings=scriptEnabled=false"
    }
    $launchUtc = (Get-Date).ToUniversalTime()
    if ($CaptureChildStreams) {
        $legacyStdout = Join-Path $stageRoot "legacy-stdout.txt"
        $legacyStderr = Join-Path $stageRoot "legacy-stderr.txt"
        $process = Start-Process `
            -FilePath $stagedCandidate `
            -PassThru `
            -WindowStyle Normal `
            -RedirectStandardOutput $legacyStdout `
            -RedirectStandardError $legacyStderr
    }
    else {
        $process = Start-Process `
            -FilePath $stagedCandidate `
            -PassThru `
            -WindowStyle Normal
    }
    $deadline = [DateTime]::UtcNow.AddSeconds($WindowTimeoutSeconds)
    $windowVisible = $false
    while ([DateTime]::UtcNow -lt $deadline) {
        $process.Refresh()
        if ($process.HasExited) { break }
        if (-not $dataRootClaimed -and
            (Test-Path -LiteralPath $formalDataRoot -PathType Container)) {
            Assert-OrdinaryExactDirectory `
                $formalDataRoot `
                $registeredLocalData `
                "com.yuanyuan.reminder" | Out-Null
            $dataMarker = Join-Path $formalDataRoot ".yuanyuan-v132-runtime-capture-data-v1"
            if (Test-Path -LiteralPath $dataMarker) {
                throw "fresh_data_root_already_contains_ownership_marker"
            }
            [IO.File]::WriteAllText(
                $dataMarker,
                $ownershipValue,
                [Text.UTF8Encoding]::new($false)
            )
            $dataRootClaimed = $true
        }
        if ($process.MainWindowHandle -ne [IntPtr]::Zero) {
            $windowVisible = $true
        }
        if ((Test-Path -LiteralPath $runtimeDatabasePath -PathType Leaf) -and $windowVisible) {
            break
        }
        Start-Sleep -Milliseconds 50
    }
    if (-not $windowVisible) { throw "legacy_candidate_visible_window_timeout" }
    if (-not (Test-Path -LiteralPath $runtimeDatabasePath -PathType Leaf)) {
        throw "legacy_candidate_database_creation_timeout"
    }
    Start-Sleep -Seconds 2
    Stop-OwnedProcessTree $process.Id
    $process = $null

    & $captureExecutablePath `
        --source $runtimeDatabasePath `
        --fixture $fixturePath `
        --report $captureReportPath `
        --attest-source-release 1.3.2
    if ($LASTEXITCODE -ne 0) { throw "runtime_database_capture_failed" }
    $captureReport = Get-Content -Raw -Encoding UTF8 -LiteralPath $captureReportPath |
        ConvertFrom-Json
    if ($captureReport.status -ne "passed" -or
        $captureReport.sourceDatabaseVersion -ne 6 -or
        $captureReport.fixtureSha256 -ne (Get-Sha256 $fixturePath)) {
        throw "runtime_database_capture_report_invalid"
    }

    $dataRootRemoved = Remove-OwnedDirectory `
        $formalDataRoot `
        $registeredLocalData `
        "com.yuanyuan.reminder" `
        $dataMarker `
        $ownershipValue
    $dataRootClaimed = $false
    $stageRemoved = Remove-OwnedDirectory `
        $stageRoot `
        $stageParent `
        $stageLeaf `
        $stageMarker `
        $ownershipValue

    $provenance = [ordered]@{
        schemaVersion = 1
        status = "passed"
        generatedAt = (Get-Date).ToUniversalTime().ToString("o")
        sourceRelease = [ordered]@{
            version = "1.3.2"
            gitTag = "v1.3.2"
            gitCommit = $resolvedCommit
            distributionChannel = "github_release_asset"
            releasePage = "https://github.com/brucexia007-ui/yuanyuan-reminder/releases/tag/v1.3.2"
            releaseAssetFileName = Split-Path -Leaf $legacyCandidatePath
            tagArchiveSha256 = $tagArchiveSha256
            tagArchiveMatchesRepository = $true
            executableSha256 = $legacySha256
            executableSizeBytes = $legacyItem.Length
            productVersion = $legacyItem.VersionInfo.ProductVersion
            fileVersion = $legacyItem.VersionInfo.FileVersion
            releaseChecksumFileName = Split-Path -Leaf $releaseChecksumPath
            releaseChecksumFileSha256 = $releaseChecksumSha256
            releaseChecksumMatched = $true
            stagedCopyHashMatched = $true
        }
        execution = [ordered]@{
            interactiveSession = $true
            freshTestAccountAcknowledged = $true
            tokenProfileResolvedThroughRegistry = $true
            preexistingDataRoot = $false
            preexistingApplicationProcessCount = 0
            launchUtc = $launchUtc.ToString("o")
            visibleWindowObserved = $windowVisible
            runtimeDatabaseCreated = $true
            childStreamsRedirected = [bool]$CaptureChildStreams
            stagedInTestProfileTemp = [bool]$StageInTestProfileTemp
            webViewJavascriptDisabledForInitialization =
                [bool]$DisableWebViewJavascriptForLegacyInitialization
            terminationMode = "owned_process_tree_forced_after_initialization"
            processTreeStopped = $true
            dataRootRemoved = $dataRootRemoved
            stageRemoved = $stageRemoved
        }
        capture = [ordered]@{
            executableSha256 = Get-Sha256 $captureExecutablePath
            reportFileName = Split-Path -Leaf $captureReportPath
            reportSha256 = Get-Sha256 $captureReportPath
            fixtureFileName = Split-Path -Leaf $fixturePath
            fixtureSha256 = Get-Sha256 $fixturePath
            fixtureSizeBytes = (Get-Item -LiteralPath $fixturePath).Length
            databaseVersion = 6
        }
        limitations = @(
            "The published legacy executable is unsigned; its GitHub release digest, release checksum file, local hash and Windows version are all cross-checked instead of relying on a publisher signature.",
            "The legacy process is force-stopped only after its visible window and database are observed; SQLite backup then captures the closed runtime database and verifies source stability.",
            "WebView JavaScript may be disabled for this initialization-only run to prevent the published v1.3.2 frontend from winning its known pre-setup IPC race; the executable and Rust database initialization code remain unchanged."
        )
        privacy = "Contains hashes, versions, sizes, fixed outcomes and timing only; no account name, profile path, database path or user content."
    }
    Write-NewUtf8Json $provenancePath $provenance
    Write-Output $provenancePath
}
catch {
    if ($dataRootClaimed -and
        $null -ne $formalDataRoot -and
        (Test-Path -LiteralPath $formalDataRoot -PathType Container)) {
        $topLevelEvidence = @(Get-ChildItem -LiteralPath $formalDataRoot -Force |
            Select-Object Name, PSIsContainer, Length)
        Write-Warning (
            "failed runtime data-root top-level evidence: " +
            ($topLevelEvidence | ConvertTo-Json -Compress)
        )
    }
    if ($null -ne $legacyStdout -and (Test-Path -LiteralPath $legacyStdout -PathType Leaf)) {
        $stdoutText = Get-Content -Raw -LiteralPath $legacyStdout
        if (-not [string]::IsNullOrWhiteSpace($stdoutText)) {
            Write-Warning "legacy candidate stdout: $stdoutText"
        }
    }
    if ($null -ne $legacyStderr -and (Test-Path -LiteralPath $legacyStderr -PathType Leaf)) {
        $stderrText = Get-Content -Raw -LiteralPath $legacyStderr
        if (-not [string]::IsNullOrWhiteSpace($stderrText)) {
            Write-Warning "legacy candidate stderr: $stderrText"
        }
    }
    throw
}
finally {
    if ($null -ne $process) {
        try { Stop-OwnedProcessTree $process.Id } catch { }
    }
    if ($dataRootClaimed -and
        $null -ne $formalDataRoot -and
        $null -ne $registeredLocalData -and
        $null -ne $dataMarker -and
        $null -ne $ownershipValue -and
        (Test-Path -LiteralPath $formalDataRoot -PathType Container)) {
        Remove-OwnedDirectory `
            $formalDataRoot `
            $registeredLocalData `
            "com.yuanyuan.reminder" `
            $dataMarker `
            $ownershipValue | Out-Null
    }
    if (-not $stageRemoved -and
        $null -ne $stageRoot -and
        $null -ne $stageParent -and
        $null -ne $stageLeaf -and
        $null -ne $stageMarker -and
        $null -ne $ownershipValue -and
        (Test-Path -LiteralPath $stageMarker -PathType Leaf) -and
        (Test-Path -LiteralPath $stageRoot -PathType Container)) {
        Remove-OwnedDirectory `
            $stageRoot `
            $stageParent `
            $stageLeaf `
            $stageMarker `
            $ownershipValue | Out-Null
    }
}
