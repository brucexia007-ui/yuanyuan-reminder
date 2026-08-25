param(
    [Parameter(Mandatory = $true)]
    [ValidateSet("standard", "reduced-motion", "forced-colors")]
    [string]$ExpectedMode,

    [ValidateRange(20, 120)]
    [int]$ExitAfterSeconds = 30
)

$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"
$projectRoot = Split-Path -Parent $PSScriptRoot
$workspaceRoot = Split-Path -Parent $projectRoot
$runtimeTarget = Join-Path $projectRoot "src-tauri\target\runtime-qa-learning-accessibility\release"
$appPath = Join-Path $runtimeTarget "yuanyuan-reminder.exe"
$fixturePath = Join-Path $runtimeTarget "yuanyuan-runtime-qa-fixture.exe"
$evidenceRoot = Join-Path $runtimeTarget "evidence"
$runId = (Get-Date).ToUniversalTime().ToString("yyyyMMddTHHmmssZ")
$reportPath = Join-Path $evidenceRoot "learning-windows-system-mode-$ExpectedMode-$runId.json"
$leaf = "yuanyuan-runtime-qa-learning-system-mode-$runId-$ExpectedMode"
$qaRoot = Join-Path $workspaceRoot $leaf
$fixtureCardCount = 5

$learningPageName = -join @([char]0x5B66, [char]0x4E60, [char]0x9875, [char]0x9762)
$blackboardName = -join @(
    [char]0x5706, [char]0x5706, [char]0x684C, [char]0x9762,
    [char]0x82F1, [char]0x8BED, [char]0x590D, [char]0x4E60
)
$startRoundFragment = -join @(
    [char]0x5F00, [char]0x59CB, [char]0x4E00, [char]0x8F6E
)
$reducedMotionStatusName = -join @(
    [char]0x5DF2, [char]0x51CF, [char]0x5C11, [char]0x52A8,
    [char]0x6001, [char]0x6548, [char]0x679C
)
$forcedColorsStatusName = -join @(
    [char]0x5DF2, [char]0x542F, [char]0x7528, [char]0x20,
    [char]0x57, [char]0x69, [char]0x6E, [char]0x64, [char]0x6F,
    [char]0x77, [char]0x73, [char]0x20,
    [char]0x5F3A, [char]0x5236, [char]0x989C, [char]0x8272
)

foreach ($required in @($appPath, $fixturePath)) {
    if (-not (Test-Path -LiteralPath $required -PathType Leaf)) {
        throw "learning accessibility runtime QA binary is missing; run npm.cmd run runtime:qa:learning-accessibility:build first"
    }
}

New-Item -ItemType Directory -Force -Path $evidenceRoot | Out-Null
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes

if (-not ("YuanyuanWindowsSystemModeProbe" -as [type])) {
    Add-Type -TypeDefinition @"
using System;
using System.ComponentModel;
using System.Runtime.InteropServices;

public static class YuanyuanWindowsSystemModeProbe {
    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    private struct HighContrast {
        public uint Size;
        public uint Flags;
        public IntPtr DefaultScheme;
    }

    [DllImport("user32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern bool SystemParametersInfo(
        uint action,
        uint parameter,
        ref int value,
        uint update
    );

    [DllImport("user32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern bool SystemParametersInfo(
        uint action,
        uint parameter,
        ref HighContrast value,
        uint update
    );

    public static bool ClientAreaAnimationsEnabled() {
        int value = 0;
        if (!SystemParametersInfo(0x1042, 0, ref value, 0)) {
            throw new Win32Exception(Marshal.GetLastWin32Error());
        }
        return value != 0;
    }

    public static uint HighContrastFlags() {
        HighContrast value = new HighContrast();
        value.Size = (uint)Marshal.SizeOf<HighContrast>();
        if (!SystemParametersInfo(0x0042, value.Size, ref value, 0)) {
            throw new Win32Exception(Marshal.GetLastWin32Error());
        }
        return value.Flags;
    }
}
"@
}

if (-not ("YuanyuanWindowsSystemModeWindowProbe" -as [type])) {
    Add-Type -TypeDefinition @"
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;

public static class YuanyuanWindowsSystemModeWindowProbe {
    private delegate bool EnumWindowsProc(IntPtr handle, IntPtr parameter);

    [DllImport("user32.dll")]
    private static extern bool EnumWindows(EnumWindowsProc callback, IntPtr parameter);

    [DllImport("user32.dll")]
    private static extern uint GetWindowThreadProcessId(IntPtr handle, out uint processId);

    [DllImport("user32.dll")]
    private static extern bool IsWindowVisible(IntPtr handle);

    public static IntPtr[] VisibleHandlesForProcess(int expectedProcessId) {
        List<IntPtr> handles = new List<IntPtr>();
        EnumWindows(delegate(IntPtr handle, IntPtr parameter) {
            uint processId;
            GetWindowThreadProcessId(handle, out processId);
            if (processId == (uint)expectedProcessId && IsWindowVisible(handle)) {
                handles.Add(handle);
            }
            return true;
        }, IntPtr.Zero);
        return handles.ToArray();
    }
}
"@
}

function Get-FileSha256([string]$Path) {
    return (Get-FileHash -Algorithm SHA256 -LiteralPath $Path).Hash.ToUpperInvariant()
}

function Get-StringSha256([string]$Value) {
    $bytes = [Text.Encoding]::UTF8.GetBytes($Value)
    $algorithm = [Security.Cryptography.SHA256]::Create()
    try { $hash = $algorithm.ComputeHash($bytes) }
    finally { $algorithm.Dispose() }
    return ([BitConverter]::ToString($hash)).Replace("-", "")
}

function Restore-EnvironmentValue([string]$Name, [string]$Value, [bool]$Existed) {
    if ($Existed) { Set-Item "Env:$Name" $Value }
    else { Remove-Item "Env:$Name" -ErrorAction SilentlyContinue }
}

function Wait-RuntimeStage([string]$Root, [string]$Stage, [int]$TimeoutSeconds) {
    $path = Join-Path (Join-Path $Root "status") $Stage
    $deadline = [DateTime]::UtcNow.AddSeconds($TimeoutSeconds)
    while ([DateTime]::UtcNow -lt $deadline) {
        if (Test-Path -LiteralPath $path -PathType Leaf) { return $true }
        Start-Sleep -Milliseconds 50
    }
    return $false
}

function Get-AppAccessibleNodes([int]$ProcessId) {
    $result = [System.Collections.Generic.List[object]]::new()
    foreach ($handle in [YuanyuanWindowsSystemModeWindowProbe]::VisibleHandlesForProcess($ProcessId)) {
        try {
            $root = [System.Windows.Automation.AutomationElement]::FromHandle($handle)
            [void]$result.Add($root)
            $nodes = $root.FindAll(
                [System.Windows.Automation.TreeScope]::Descendants,
                [System.Windows.Automation.Condition]::TrueCondition
            )
            foreach ($node in $nodes) { [void]$result.Add($node) }
        }
        catch {}
    }
    return @($result)
}

function Find-AppElement(
    [int]$ProcessId,
    [string]$Name,
    [bool]$Exact,
    [bool]$ButtonOnly
) {
    foreach ($node in @(Get-AppAccessibleNodes $ProcessId)) {
        try {
            $currentName = $node.Current.Name
            if (-not $currentName) { continue }
            $matches = if ($Exact) { $currentName -eq $Name } else { $currentName.Contains($Name) }
            if (-not $matches) { continue }
            if (
                $ButtonOnly -and
                $node.Current.ControlType -ne [System.Windows.Automation.ControlType]::Button
            ) { continue }
            if ($node.Current.IsEnabled) { return $node }
        }
        catch {}
    }
    return $null
}

function Wait-AppElement(
    [System.Diagnostics.Process]$Process,
    [string]$Name,
    [bool]$Exact,
    [bool]$ButtonOnly,
    [int]$TimeoutSeconds
) {
    $deadline = [DateTime]::UtcNow.AddSeconds($TimeoutSeconds)
    while ([DateTime]::UtcNow -lt $deadline) {
        $Process.Refresh()
        if ($Process.HasExited) { throw "application exited before the expected accessibility node appeared" }
        $element = Find-AppElement $Process.Id $Name $Exact $ButtonOnly
        if ($null -ne $element) { return $element }
        Start-Sleep -Milliseconds 50
    }
    throw "expected accessibility node did not appear: $Name"
}

function Invoke-AppElement([System.Windows.Automation.AutomationElement]$Element) {
    $pattern = $null
    if (-not $Element.TryGetCurrentPattern(
        [System.Windows.Automation.InvokePattern]::Pattern,
        [ref]$pattern
    )) { throw "accessibility control does not expose the invoke pattern" }
    ([System.Windows.Automation.InvokePattern]$pattern).Invoke()
}

function Get-AppAccessibleNames([int]$ProcessId) {
    $names = [System.Collections.Generic.HashSet[string]]::new()
    foreach ($node in @(Get-AppAccessibleNodes $ProcessId)) {
        try {
            $name = $node.Current.Name
            if ($name -and $name.Length -le 256) { [void]$names.Add($name) }
        }
        catch {}
    }
    return @($names | Sort-Object)
}

function Stop-OwnedQaProcess([System.Diagnostics.Process]$Process) {
    if ($null -eq $Process) { return }
    try {
        $Process.Refresh()
        if ($Process.HasExited) { return }
        $owned = Get-Process -Id $Process.Id -ErrorAction Stop
        if ($owned.Path -ne $appPath) {
            throw "refusing to stop a process outside the system-mode QA executable"
        }
        Stop-Process -Id $Process.Id -Force
        $Process.WaitForExit(10000) | Out-Null
    }
    catch {}
}

function Remove-OwnedQaRoot([string]$Root, [string]$ExpectedLeaf) {
    if (-not (Test-Path -LiteralPath $Root -PathType Container)) { return $true }
    $canonicalWorkspace = [IO.Path]::GetFullPath($workspaceRoot).TrimEnd('\')
    $canonicalRoot = [IO.Path]::GetFullPath($Root).TrimEnd('\')
    $parent = [IO.Directory]::GetParent($canonicalRoot)
    if (
        $null -eq $parent -or
        $parent.FullName.TrimEnd('\') -ne $canonicalWorkspace -or
        [IO.Path]::GetFileName($canonicalRoot) -ne $ExpectedLeaf -or
        -not $ExpectedLeaf.StartsWith("yuanyuan-runtime-qa-learning-system-mode-")
    ) { throw "refusing to remove an unexpected system-mode QA root" }
    $lastError = $null
    for ($attempt = 0; $attempt -lt 20; $attempt += 1) {
        try {
            Remove-Item -LiteralPath $canonicalRoot -Recurse -Force -ErrorAction Stop
            $lastError = $null
            break
        }
        catch {
            $lastError = $_.Exception
            Start-Sleep -Milliseconds 250
        }
    }
    if ($null -ne $lastError -and (Test-Path -LiteralPath $canonicalRoot)) {
        throw $lastError
    }
    return -not (Test-Path -LiteralPath $canonicalRoot)
}

$process = $null
$plan = $null
$failure = $null
$observations = [ordered]@{
    learningPageAccessible = $false
    blackboardAccessible = $false
    reducedMotionStatusFound = $false
    forcedColorsStatusFound = $false
    accessibilityNames = @()
    controlledExit = $false
    exitCode = $null
}
$rootRemoved = $false
$animationsEnabled = [YuanyuanWindowsSystemModeProbe]::ClientAreaAnimationsEnabled()
$highContrastFlags = [YuanyuanWindowsSystemModeProbe]::HighContrastFlags()
$highContrastEnabled = ($highContrastFlags -band 1) -ne 0

try {
    if (
        ($ExpectedMode -eq "standard" -and (-not $animationsEnabled -or $highContrastEnabled)) -or
        ($ExpectedMode -eq "reduced-motion" -and ($animationsEnabled -or $highContrastEnabled)) -or
        ($ExpectedMode -eq "forced-colors" -and -not $highContrastEnabled)
    ) { throw "the actual Windows accessibility state does not match the requested probe mode" }

    $planText = & $fixturePath --root $qaRoot --learning-performance $fixtureCardCount
    if ($LASTEXITCODE -ne 0) { throw "learning fixture seeding failed" }
    $plan = $planText | ConvertFrom-Json
    if ($plan.cardCount -ne $fixtureCardCount) { throw "learning fixture count is incorrect" }
    if ($ExpectedMode -eq "reduced-motion") {
        $animationText = & $fixturePath --root $qaRoot --animation-mode system
        if ($LASTEXITCODE -ne 0) { throw "runtime QA system animation mode seeding failed" }
        $animation = $animationText | ConvertFrom-Json
        if ($animation.updated -ne $true) { throw "runtime QA system animation mode was not confirmed" }
    }

    $variables = @(
        [ordered]@{ name = "YUANYUAN_RUNTIME_QA_ROOT"; value = $qaRoot },
        [ordered]@{ name = "YUANYUAN_RUNTIME_QA_PROFILE"; value = "learning-performance" },
        [ordered]@{ name = "YUANYUAN_RUNTIME_QA_EXIT_AFTER_SECONDS"; value = [string]$ExitAfterSeconds },
        [ordered]@{ name = "YUANYUAN_RUNTIME_QA_WEBVIEW_MODE"; value = "standard" },
        [ordered]@{ name = "YUANYUAN_RUNTIME_QA_PANEL_PLACEMENT"; value = "work-area-top-left" }
    )
    $saved = @()
    foreach ($variable in $variables) {
        $existed = Test-Path "Env:$($variable.name)"
        $saved += [ordered]@{
            name = $variable.name
            existed = $existed
            value = if ($existed) { (Get-Item "Env:$($variable.name)").Value } else { $null }
        }
        Set-Item "Env:$($variable.name)" $variable.value
    }
    try { $process = Start-Process -FilePath $appPath -PassThru }
    finally {
        foreach ($item in $saved) {
            Restore-EnvironmentValue $item.name $item.value $item.existed
        }
    }

    if (-not (Wait-RuntimeStage $qaRoot "exit-scheduled" 30)) {
        throw "runtime QA window setup did not complete"
    }
    $null = Wait-AppElement $process $learningPageName $true $false 30
    $observations.learningPageAccessible = $true
    $startButton = Wait-AppElement $process $startRoundFragment $false $true 10
    Invoke-AppElement $startButton
    $null = Wait-AppElement $process $blackboardName $true $false 20
    $observations.blackboardAccessible = $true
    Start-Sleep -Milliseconds 300
    $observations.accessibilityNames = @(Get-AppAccessibleNames $process.Id)
    $observations.reducedMotionStatusFound =
        $observations.accessibilityNames.Contains($reducedMotionStatusName)
    $observations.forcedColorsStatusFound =
        $observations.accessibilityNames.Contains($forcedColorsStatusName)
    if (
        ($ExpectedMode -eq "standard" -and (
            $observations.reducedMotionStatusFound -or
            $observations.forcedColorsStatusFound
        )) -or
        ($ExpectedMode -eq "reduced-motion" -and (
            -not $observations.reducedMotionStatusFound -or
            $observations.forcedColorsStatusFound
        )) -or
        ($ExpectedMode -eq "forced-colors" -and -not $observations.forcedColorsStatusFound)
    ) { throw "the standard WebView did not reflect the actual Windows accessibility state" }

    $process.WaitForExit(($ExitAfterSeconds + 15) * 1000) | Out-Null
    $process.Refresh()
    if (-not $process.HasExited) { throw "application did not use the controlled exit path" }
    $observations.exitCode = [int]$process.ExitCode
    $observations.controlledExit = $observations.exitCode -eq 0
    if (-not $observations.controlledExit) { throw "controlled exit returned a non-zero code" }
}
catch {
    $failure = $_.Exception.Message
}
finally {
    Stop-OwnedQaProcess $process
    try { $rootRemoved = Remove-OwnedQaRoot $qaRoot $leaf }
    catch {
        $rootRemoved = $false
        if ($null -eq $failure) { $failure = $_.Exception.Message }
    }
}

$gitCommit = (& git -C $projectRoot rev-parse HEAD).Trim()
$gitStatus = (& git -C $projectRoot status --porcelain=v1 --untracked-files=all) -join "`n"
$windowsVersion = Get-ItemProperty -LiteralPath "HKLM:\SOFTWARE\Microsoft\Windows NT\CurrentVersion"
$report = [ordered]@{
    schemaVersion = 1
    generatedAt = [DateTimeOffset]::UtcNow.ToString("o")
    profile = "learning-windows-system-mode"
    expectedMode = $ExpectedMode
    source = [ordered]@{
        gitCommit = $gitCommit
        gitDirty = $gitStatus.Length -gt 0
        gitStatusSha256 = Get-StringSha256 $gitStatus
    }
    bindings = [ordered]@{
        applicationSha256 = Get-FileSha256 $appPath
        fixtureExecutableSha256 = Get-FileSha256 $fixturePath
        fixtureContentSha256 = if ($null -ne $plan) { $plan.contentSha256 } else { $null }
        fixtureDatabaseSha256 = if ($null -ne $plan) { $plan.databaseSha256 } else { $null }
        scriptSha256 = Get-FileSha256 $PSCommandPath
    }
    device = [ordered]@{
        windowsProductName = $windowsVersion.ProductName
        windowsDisplayVersion = $windowsVersion.DisplayVersion
        windowsBuild = $windowsVersion.CurrentBuildNumber
        processorArchitecture = [Environment]::GetEnvironmentVariable("PROCESSOR_ARCHITECTURE")
        logicalProcessors = [Environment]::ProcessorCount
        appliedDpi = Get-ItemPropertyValue -LiteralPath "HKCU:\Control Panel\Desktop\WindowMetrics" -Name AppliedDPI
    }
    windowsState = [ordered]@{
        clientAreaAnimationsEnabled = $animationsEnabled
        highContrastEnabled = $highContrastEnabled
        highContrastFlags = $highContrastFlags
    }
    request = [ordered]@{
        exitAfterSeconds = $ExitAfterSeconds
        cardCount = $fixtureCardCount
        webViewMode = "standard"
    }
    observations = $observations
    cleanup = [ordered]@{ rootRemoved = $rootRemoved }
    ready = (
        $null -eq $failure -and
        $observations.learningPageAccessible -and
        $observations.blackboardAccessible -and
        $observations.controlledExit -and
        $rootRemoved
    )
    failure = $failure
    limitations = @(
        "This probe reads the actual Windows client-area-animation and high-contrast states, then launches a standard WebView without forced browser arguments.",
        "The application and fixture are an isolated runtime-QA build, not a signed production candidate.",
        "Windows UI Automation confirms the application-exposed media state and learning controls; this does not replace human visual, motion-sensitivity, or screen-reader review.",
        "The outer operator is responsible for restoring the exact Windows setting after each probe."
    )
}
$report | ConvertTo-Json -Depth 8 | Set-Content -Encoding UTF8 -LiteralPath $reportPath
Write-Output "Learning Windows system-mode report written: $reportPath"
Write-Output (
    "Mode={0} Animations={1} HighContrast={2} Ready={3}" -f
    $ExpectedMode,
    $animationsEnabled,
    $highContrastEnabled,
    $report.ready
)
if (-not $report.ready) { exit 1 }
