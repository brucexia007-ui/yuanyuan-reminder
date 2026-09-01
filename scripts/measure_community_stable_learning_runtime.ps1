param(
    [ValidateRange(120, 1800)]
    [int]$TimeoutSeconds = 900,

    [switch]$AllowDirty,

    [string]$SourceBindingPath
)

$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"
. (Join-Path $PSScriptRoot "assert_runtime_qa_exclusive.ps1")
Assert-YuanyuanRuntimeQaExclusive -Activity "Community stable 20,000-card learning runtime E2E"
$utilityModulePath = Join-Path $PSHOME "Modules\Microsoft.PowerShell.Utility\Microsoft.PowerShell.Utility.psd1"
Import-Module -Name $utilityModulePath -ErrorAction Stop

$projectRoot = Split-Path -Parent $PSScriptRoot
$workspaceRoot = Split-Path -Parent $projectRoot
$runtimeTarget = Join-Path $projectRoot "src-tauri\target\runtime-qa-learning\release"
$appPath = Join-Path $runtimeTarget "yuanyuan-reminder.exe"
$fixturePath = Join-Path $runtimeTarget "yuanyuan-runtime-qa-fixture.exe"
$evidenceRoot = Join-Path $runtimeTarget "evidence"
$runId = (Get-Date).ToUniversalTime().ToString("yyyyMMddTHHmmssfffZ")
$leaf = "yuanyuan-runtime-qa-community-learning-$runId"
$qaRoot = Join-Path $workspaceRoot $leaf
$markerPath = Join-Path $qaRoot ".yuanyuan-runtime-qa-v1"
$brandConfigPath = Join-Path $projectRoot "product-brand.json"
$brandConfig = Get-Content -Raw -Encoding UTF8 -LiteralPath $brandConfigPath | ConvertFrom-Json
if ([string]::IsNullOrWhiteSpace([string]$brandConfig.storage.directoryName) -or
    [string]::IsNullOrWhiteSpace([string]$brandConfig.storage.mainDatabaseFile) -or
    [string]::IsNullOrWhiteSpace([string]$brandConfig.storage.learningDatabaseFile)) {
    throw "product brand storage directory and database file names are required"
}
$mainDatabaseFile = [string]$brandConfig.storage.mainDatabaseFile
$learningDatabaseFile = [string]$brandConfig.storage.learningDatabaseFile
$formalDataRoot = Join-Path $env:LOCALAPPDATA ([string]$brandConfig.storage.directoryName)
$runtimeReportName = "learning-scale-runtime-$runId.json"
$runtimeReportPath = Join-Path $evidenceRoot $runtimeReportName
$evidenceName = "community-stable-learning-$runId.json"
$evidencePath = Join-Path $evidenceRoot $evidenceName
$triggerName = "run-learning-scale-acceptance"

if (-not ("YuanyuanRestartManagerProbe" -as [type])) {
    Add-Type -TypeDefinition @"
using System;
using System.Collections.Generic;
using System.ComponentModel;
using System.Runtime.InteropServices;
using System.Text;

public static class YuanyuanRestartManagerProbe {
    private const int ERROR_MORE_DATA = 234;
    private const int CCH_RM_SESSION_KEY = 32;

    [StructLayout(LayoutKind.Sequential)]
    private struct RM_UNIQUE_PROCESS {
        public int dwProcessId;
        public System.Runtime.InteropServices.ComTypes.FILETIME ProcessStartTime;
    }

    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    private struct RM_PROCESS_INFO {
        public RM_UNIQUE_PROCESS Process;
        [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 256)]
        public string strAppName;
        [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 64)]
        public string strServiceShortName;
        public uint ApplicationType;
        public uint AppStatus;
        public uint TSSessionId;
        [MarshalAs(UnmanagedType.Bool)]
        public bool bRestartable;
    }

    [DllImport("rstrtmgr.dll", CharSet = CharSet.Unicode)]
    private static extern int RmStartSession(out uint handle, int flags, StringBuilder key);

    [DllImport("rstrtmgr.dll", CharSet = CharSet.Unicode)]
    private static extern int RmRegisterResources(
        uint handle,
        uint fileCount,
        string[] fileNames,
        uint applicationCount,
        IntPtr applications,
        uint serviceCount,
        IntPtr services
    );

    [DllImport("rstrtmgr.dll")]
    private static extern int RmGetList(
        uint handle,
        out uint processInfoNeeded,
        ref uint processInfoCount,
        [In, Out] RM_PROCESS_INFO[] processInfo,
        ref uint rebootReasons
    );

    [DllImport("rstrtmgr.dll")]
    private static extern int RmEndSession(uint handle);

    public static int[] LockingProcessIds(string[] fileNames) {
        if (fileNames == null || fileNames.Length == 0) return new int[0];
        uint handle;
        var key = new StringBuilder(CCH_RM_SESSION_KEY + 1);
        var result = RmStartSession(out handle, 0, key);
        if (result != 0) throw new Win32Exception(result);
        try {
            result = RmRegisterResources(
                handle,
                (uint)fileNames.Length,
                fileNames,
                0,
                IntPtr.Zero,
                0,
                IntPtr.Zero
            );
            if (result != 0) throw new Win32Exception(result);
            uint needed = 0;
            uint count = 0;
            uint reasons = 0;
            result = RmGetList(handle, out needed, ref count, null, ref reasons);
            if (result == 0) return new int[0];
            if (result != ERROR_MORE_DATA) throw new Win32Exception(result);
            var records = new RM_PROCESS_INFO[needed];
            count = needed;
            result = RmGetList(handle, out needed, ref count, records, ref reasons);
            if (result != 0) throw new Win32Exception(result);
            var unique = new HashSet<int>();
            for (var index = 0; index < count; index++) {
                unique.Add(records[index].Process.dwProcessId);
            }
            var output = new int[unique.Count];
            unique.CopyTo(output);
            Array.Sort(output);
            return output;
        }
        finally { RmEndSession(handle); }
    }
}
"@
}

function Restore-EnvironmentValue([string]$Name, [string]$Value, [bool]$Existed) {
    if ($Existed) { Set-Item -LiteralPath "Env:$Name" -Value $Value }
    else { Remove-Item -LiteralPath "Env:$Name" -ErrorAction SilentlyContinue }
}

function Get-FileSha256([string]$Path) {
    $algorithm = [System.Security.Cryptography.SHA256]::Create()
    $stream = $null
    try {
        $stream = [System.IO.File]::OpenRead($Path)
        return ([BitConverter]::ToString($algorithm.ComputeHash($stream))).Replace("-", "")
    }
    finally {
        if ($null -ne $stream) { $stream.Dispose() }
        $algorithm.Dispose()
    }
}

function Get-MetadataSnapshot([string]$Root) {
    if (-not (Test-Path -LiteralPath $Root -PathType Container)) {
        return [ordered]@{ exists = $false; fileCount = 0; digest = $null }
    }
    $canonical = (Resolve-Path -LiteralPath $Root).Path.TrimEnd("\")
    $rows = [System.Collections.Generic.List[string]]::new()
    foreach ($file in @(Get-ChildItem -LiteralPath $canonical -Recurse -File -Force -ErrorAction Stop | Sort-Object FullName)) {
        $relative = $file.FullName.Substring($canonical.Length).TrimStart("\")
        $rows.Add("$relative`0$($file.Length)`0$($file.LastWriteTimeUtc.Ticks)")
    }
    $algorithm = [System.Security.Cryptography.SHA256]::Create()
    try {
        $bytes = [System.Text.Encoding]::UTF8.GetBytes([string]::Join("`n", $rows))
        $digest = ([BitConverter]::ToString($algorithm.ComputeHash($bytes))).Replace("-", "")
    }
    finally { $algorithm.Dispose() }
    return [ordered]@{ exists = $true; fileCount = $rows.Count; digest = $digest }
}

function Test-SnapshotEqual($Left, $Right) {
    return (
        $Left.exists -eq $Right.exists -and
        $Left.fileCount -eq $Right.fileCount -and
        $Left.digest -eq $Right.digest
    )
}

function Get-ProcessTreeIds([int]$RootProcessId) {
    $rows = @(Get-CimInstance Win32_Process | Select-Object ProcessId, ParentProcessId)
    $owned = [System.Collections.Generic.HashSet[int]]::new()
    $owned.Add($RootProcessId) | Out-Null
    do {
        $added = $false
        foreach ($row in $rows) {
            if (
                $owned.Contains([int]$row.ParentProcessId) -and
                -not $owned.Contains([int]$row.ProcessId)
            ) {
                $owned.Add([int]$row.ProcessId) | Out-Null
                $added = $true
            }
        }
    } while ($added)
    return @($owned)
}

function Get-FormalLockingProcessIds([string]$Root) {
    if (-not (Test-Path -LiteralPath $Root -PathType Container)) { return @() }
    $files = [string[]]@(
        @(
            $mainDatabaseFile,
            "$mainDatabaseFile-wal",
            "$mainDatabaseFile-shm",
            "learning-data\$learningDatabaseFile",
            "learning-data\$learningDatabaseFile-wal",
            "learning-data\$learningDatabaseFile-shm",
            "EBWebView\lockfile"
        ) |
            ForEach-Object { Join-Path $Root $_ } |
            Where-Object { Test-Path -LiteralPath $_ -PathType Leaf }
    )
    return @([YuanyuanRestartManagerProbe]::LockingProcessIds($files))
}

function Wait-File([string]$Path, [System.Diagnostics.Process]$Process, [int]$Seconds) {
    $deadline = [DateTime]::UtcNow.AddSeconds($Seconds)
    while ([DateTime]::UtcNow -lt $deadline) {
        if (Test-Path -LiteralPath $Path -PathType Leaf) { return $true }
        $Process.Refresh()
        if ($Process.HasExited) { return (Test-Path -LiteralPath $Path -PathType Leaf) }
        Start-Sleep -Milliseconds 100
    }
    return $false
}

function Remove-OwnedQaRoot([string]$Root, [string]$ExpectedLeaf) {
    if (-not (Test-Path -LiteralPath $Root -PathType Container)) { return $true }
    $canonicalRoot = (Resolve-Path -LiteralPath $Root).Path
    $canonicalParent = (Resolve-Path -LiteralPath $workspaceRoot).Path
    $marker = Join-Path $canonicalRoot ".yuanyuan-runtime-qa-v1"
    $expectedMarker = [Convert]::ToBase64String([Text.Encoding]::ASCII.GetBytes("YUANYUAN_RUNTIME_QA_V1`n"))
    $actualMarker = if (Test-Path -LiteralPath $marker -PathType Leaf) {
        [Convert]::ToBase64String([IO.File]::ReadAllBytes($marker))
    } else { "" }
    if (
        (Split-Path -Parent $canonicalRoot) -ne $canonicalParent -or
        (Split-Path -Leaf $canonicalRoot) -ne $ExpectedLeaf -or
        -not $ExpectedLeaf.StartsWith("yuanyuan-runtime-qa-community-learning-") -or
        $actualMarker -ne $expectedMarker
    ) {
        throw "refusing to remove an unowned learning runtime QA root"
    }
    Remove-Item -LiteralPath $canonicalRoot -Recurse -Force
    return -not (Test-Path -LiteralPath $canonicalRoot)
}

foreach ($required in @($appPath, $fixturePath)) {
    if (-not (Test-Path -LiteralPath $required -PathType Leaf)) {
        throw "learning runtime QA binary is missing; run npm.cmd run runtime:qa:learning:build first"
    }
}

$sourceCommit = (& git -C $projectRoot rev-parse HEAD).Trim()
if ($LASTEXITCODE -ne 0 -or $sourceCommit -notmatch '^[0-9a-f]{40}$') {
    throw "source commit could not be resolved"
}
$dirtyLines = @(& git -C $projectRoot status --porcelain=v1 --untracked-files=all)
if ($LASTEXITCODE -ne 0) { throw "source worktree state could not be resolved" }
$sourceDirty = $dirtyLines.Count -gt 0
if ($sourceDirty -and -not $AllowDirty) {
    throw "community stable learning evidence requires a clean worktree"
}
if ($AllowDirty -and -not [string]::IsNullOrWhiteSpace($SourceBindingPath)) {
    throw "development learning evidence cannot claim a formal source binding"
}
if (-not $AllowDirty -and [string]::IsNullOrWhiteSpace($SourceBindingPath)) {
    throw "formal learning evidence requires -SourceBindingPath from the controlled learning-on candidate build"
}
$sourceBindingSha256 = $null
if (-not $AllowDirty) {
    $sourceBindingPath = [IO.Path]::GetFullPath($SourceBindingPath)
    $bindingObservedAt = [DateTimeOffset]::UtcNow.ToString("o")
    & node `
        (Join-Path $projectRoot "scripts\verify_community_stable_runtime_source_binding.mjs") `
        --binding $sourceBindingPath `
        --tested-commit $sourceCommit `
        --observed-at $bindingObservedAt
    if ($LASTEXITCODE -ne 0) {
        throw "formal learning candidate source binding verification failed"
    }
    $sourceBindingSha256 = Get-FileSha256 $sourceBindingPath
}
$authority = Get-Content -Raw -Encoding UTF8 -LiteralPath (Join-Path $projectRoot "product-version.json") | ConvertFrom-Json
$formalBefore = Get-MetadataSnapshot $formalDataRoot
New-Item -ItemType Directory -Force -Path $evidenceRoot | Out-Null

$process = $null
$cleanupVerified = $false
$controlledExit = $false
$formalHandleAuditPassed = $false
$externalFormalProcessObserved = $false
try {
    & $fixturePath --root $qaRoot --prepare-only
    if ($LASTEXITCODE -ne 0 -or -not (Test-Path -LiteralPath $markerPath -PathType Leaf)) {
        throw "learning runtime QA root preparation failed"
    }

    $rootExisted = Test-Path Env:YUANYUAN_RUNTIME_QA_ROOT
    $profileExisted = Test-Path Env:YUANYUAN_RUNTIME_QA_PROFILE
    $exitExisted = Test-Path Env:YUANYUAN_RUNTIME_QA_EXIT_AFTER_SECONDS
    $oldRoot = $env:YUANYUAN_RUNTIME_QA_ROOT
    $oldProfile = $env:YUANYUAN_RUNTIME_QA_PROFILE
    $oldExit = $env:YUANYUAN_RUNTIME_QA_EXIT_AFTER_SECONDS
    try {
        $env:YUANYUAN_RUNTIME_QA_ROOT = $qaRoot
        $env:YUANYUAN_RUNTIME_QA_PROFILE = "learning-performance"
        $env:YUANYUAN_RUNTIME_QA_EXIT_AFTER_SECONDS = [string]($TimeoutSeconds + 30)
        $process = Start-Process -FilePath $appPath -PassThru -WindowStyle Hidden
    }
    finally {
        Restore-EnvironmentValue "YUANYUAN_RUNTIME_QA_ROOT" $oldRoot $rootExisted
        Restore-EnvironmentValue "YUANYUAN_RUNTIME_QA_PROFILE" $oldProfile $profileExisted
        Restore-EnvironmentValue "YUANYUAN_RUNTIME_QA_EXIT_AFTER_SECONDS" $oldExit $exitExisted
    }

    $setupStage = Join-Path (Join-Path $qaRoot "status") "exit-scheduled"
    if (-not (Wait-File $setupStage $process 30)) {
        throw "learning runtime QA Tauri setup did not complete"
    }
    $qaProcessIds = @(Get-ProcessTreeIds $process.Id)
    $formalLockingProcessIds = @(Get-FormalLockingProcessIds $formalDataRoot)
    $qaFormalMatches = @($formalLockingProcessIds | Where-Object { $qaProcessIds -contains $_ })
    $externalFormalMatches = @($formalLockingProcessIds | Where-Object { $qaProcessIds -notcontains $_ })
    $formalHandleAuditPassed = $qaFormalMatches.Count -eq 0
    $externalFormalProcessObserved = $externalFormalMatches.Count -gt 0
    if (-not $formalHandleAuditPassed) {
        throw "the isolated QA process tree opened a formal user-data file"
    }
    $controlDirectory = Join-Path $qaRoot "control"
    New-Item -ItemType Directory -Force -Path $controlDirectory | Out-Null
    [IO.File]::WriteAllBytes((Join-Path $controlDirectory $triggerName), [byte[]]@())

    $internalReport = Join-Path (Join-Path $qaRoot "status") "learning-scale-acceptance-report.json"
    $internalError = Join-Path (Join-Path $qaRoot "status") "learning-scale-acceptance-error.txt"
    $deadline = [DateTime]::UtcNow.AddSeconds($TimeoutSeconds)
    while ([DateTime]::UtcNow -lt $deadline) {
        if (Test-Path -LiteralPath $internalReport -PathType Leaf) { break }
        if (Test-Path -LiteralPath $internalError -PathType Leaf) {
            throw "learning runtime QA failed: $([IO.File]::ReadAllText($internalError))"
        }
        $process.Refresh()
        if ($process.HasExited) { break }
        Start-Sleep -Milliseconds 200
    }
    if (-not (Test-Path -LiteralPath $internalReport -PathType Leaf)) {
        throw "learning runtime QA report was not produced before timeout or process exit"
    }
    Copy-Item -LiteralPath $internalReport -Destination $runtimeReportPath
    $runtimeReport = Get-Content -Raw -Encoding UTF8 -LiteralPath $runtimeReportPath | ConvertFrom-Json
    if (
        $runtimeReport.status -ne "passed" -or
        $runtimeReport.productVersion -ne $authority.version -or
        $runtimeReport.tauriProcessId -ne $process.Id
    ) { throw "learning runtime QA report identity is invalid" }

    if (-not $process.WaitForExit(30000)) {
        throw "learning runtime QA process did not exit after producing its report"
    }
    $controlledExit = $process.ExitCode -eq 0
    if (-not $controlledExit) { throw "learning runtime QA process exited with an error" }

    $formalAfter = Get-MetadataSnapshot $formalDataRoot
    $formalUserDataChanged = -not (Test-SnapshotEqual $formalBefore $formalAfter)
    if ($formalUserDataChanged -and -not $externalFormalProcessObserved) {
        throw "formal user data changed without an independently observed owner process"
    }
    $cleanupVerified = Remove-OwnedQaRoot $qaRoot $leaf
    if (-not $cleanupVerified) { throw "learning runtime QA root cleanup failed" }

    $evidence = [ordered]@{
        schemaVersion = 1
        status = "passed"
        generatedAtUtc = (Get-Date).ToUniversalTime().ToString("o")
        productVersion = [string]$authority.version
        buildVariant = "runtime-qa-learning"
        sourceCommit = $sourceCommit
        sourceDirty = $sourceDirty
        sourceBindingSha256 = $sourceBindingSha256
        applicationSha256 = Get-FileSha256 $appPath
        runtimeReportFile = $runtimeReportName
        runtimeReportSha256 = Get-FileSha256 $runtimeReportPath
        formalUserDataUsed = $false
        formalUserDataChanged = $formalUserDataChanged
        formalHandleAuditPassed = $formalHandleAuditPassed
        externalFormalProcessObserved = $externalFormalProcessObserved
        controlledExit = $controlledExit
        cleanupVerified = $cleanupVerified
        privacy = "Contains only source/build identity, deterministic synthetic aggregate results and cleanup flags; no user content or user paths."
    }
    $json = $evidence | ConvertTo-Json -Depth 8
    [IO.File]::WriteAllText($evidencePath, $json, [Text.UTF8Encoding]::new($false))

    $verifyArguments = @(
        (Join-Path $projectRoot "scripts\verify_community_stable_learning_runtime_evidence.mjs"),
        "--report",
        $evidencePath
    )
    if ($AllowDirty) { $verifyArguments += "--allow-dirty" }
    else { $verifyArguments += @("--binding", $sourceBindingPath) }
    & node @verifyArguments
    if ($LASTEXITCODE -ne 0) { throw "learning runtime QA evidence verification failed" }
    Write-Output $evidencePath
}
finally {
    if ($null -ne $process) {
        try {
            $process.Refresh()
            if (-not $process.HasExited) {
                Stop-Process -Id $process.Id -Force -ErrorAction SilentlyContinue
                $process.WaitForExit(10000) | Out-Null
            }
        }
        catch {}
    }
    if (-not $cleanupVerified -and (Test-Path -LiteralPath $qaRoot -PathType Container)) {
        try { $cleanupVerified = Remove-OwnedQaRoot $qaRoot $leaf }
        catch {}
    }
}
