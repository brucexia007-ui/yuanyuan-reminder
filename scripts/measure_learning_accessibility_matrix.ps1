param(
    [ValidateRange(30, 120)]
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
$reportPath = Join-Path $evidenceRoot "learning-accessibility-matrix-$runId.json"
$captureRoot = Join-Path $evidenceRoot "learning-accessibility-matrix-$runId"
$expectedMarker = "YUANYUAN_RUNTIME_QA_V1`n"
$fixtureCardCount = 5

$learningPageName = -join @([char]0x5B66, [char]0x4E60, [char]0x9875, [char]0x9762)
$blackboardName = -join @(
    [char]0x5706, [char]0x5706, [char]0x684C, [char]0x9762,
    [char]0x82F1, [char]0x8BED, [char]0x590D, [char]0x4E60
)
$startRoundName = -join @([char]0x5F00, [char]0x59CB, [char]0x4E00, [char]0x8F6E)
$optionsName = -join @(
    [char]0x8BF7, [char]0x9009, [char]0x62E9, [char]0x4E2D,
    [char]0x6587, [char]0x91CA, [char]0x4E49
)
$endRoundName = -join @([char]0x7ED3, [char]0x675F, [char]0x672C, [char]0x8F6E)
$syntheticMeaningName = -join @(
    [char]0x5408, [char]0x6210, [char]0x91CA, [char]0x4E49
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

$modes = @(
    [ordered]@{ name = "standard"; browserArguments = "" },
    [ordered]@{ name = "reduced-motion"; browserArguments = "--force-prefers-reduced-motion" },
    [ordered]@{
        name = "forced-colors"
        browserArguments = "--force-high-contrast --enable-blink-features=ForcedColors"
    }
)
$standardPanelSizes = @(
    [ordered]@{ width = 360; height = 560 },
    [ordered]@{ width = 390; height = 620 },
    [ordered]@{ width = 480; height = 760 }
)

foreach ($required in @($appPath, $fixturePath)) {
    if (-not (Test-Path -LiteralPath $required -PathType Leaf)) {
        throw "learning accessibility runtime QA binary is missing; run npm.cmd run runtime:qa:learning-accessibility:build first"
    }
}
New-Item -ItemType Directory -Force -Path $evidenceRoot, $captureRoot | Out-Null
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes
Add-Type -AssemblyName System.Drawing

if (-not ("YuanyuanLearningAccessibilityWindowProbe" -as [type])) {
    Add-Type -TypeDefinition @"
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;

public static class YuanyuanLearningAccessibilityWindowProbe {
    private delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);

    [StructLayout(LayoutKind.Sequential)]
    public struct Rect {
        public int Left;
        public int Top;
        public int Right;
        public int Bottom;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct MonitorInfo {
        public uint Size;
        public Rect Monitor;
        public Rect Work;
        public uint Flags;
    }

    [DllImport("user32.dll")]
    private static extern bool EnumWindows(EnumWindowsProc callback, IntPtr lParam);

    [DllImport("user32.dll")]
    private static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint processId);

    [DllImport("user32.dll")]
    private static extern bool IsWindowVisible(IntPtr hWnd);

    [DllImport("user32.dll")]
    public static extern bool GetWindowRect(IntPtr hWnd, out Rect rect);

    [DllImport("user32.dll")]
    public static extern bool GetClientRect(IntPtr hWnd, out Rect rect);

    [DllImport("user32.dll")]
    public static extern uint GetDpiForWindow(IntPtr hWnd);

    [DllImport("user32.dll")]
    private static extern IntPtr MonitorFromWindow(IntPtr hWnd, uint flags);

    [DllImport("user32.dll", CharSet = CharSet.Auto)]
    private static extern bool GetMonitorInfo(IntPtr monitor, ref MonitorInfo info);

    [DllImport("user32.dll")]
    public static extern bool SetForegroundWindow(IntPtr hWnd);

    [DllImport("user32.dll")]
    public static extern bool PrintWindow(IntPtr hWnd, IntPtr hdc, uint flags);

    public static Rect WorkAreaForWindow(IntPtr hWnd) {
        var monitor = MonitorFromWindow(hWnd, 2);
        var info = new MonitorInfo();
        info.Size = (uint)Marshal.SizeOf<MonitorInfo>();
        if (monitor == IntPtr.Zero || !GetMonitorInfo(monitor, ref info)) {
            throw new InvalidOperationException("monitor work area is unavailable");
        }
        return info.Work;
    }

    public static IntPtr[] VisibleWindows(int processId) {
        var windows = new List<IntPtr>();
        EnumWindows((hWnd, lParam) => {
            uint owner;
            GetWindowThreadProcessId(hWnd, out owner);
            if (owner == (uint)processId && IsWindowVisible(hWnd)) windows.Add(hWnd);
            return true;
        }, IntPtr.Zero);
        return windows.ToArray();
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

function Wait-RuntimeStage([string]$Root, [string]$Stage, [int]$TimeoutSeconds) {
    $path = Join-Path (Join-Path $Root "status") $Stage
    $deadline = [DateTime]::UtcNow.AddSeconds($TimeoutSeconds)
    while ([DateTime]::UtcNow -lt $deadline) {
        if (Test-Path -LiteralPath $path -PathType Leaf) { return $true }
        Start-Sleep -Milliseconds 50
    }
    return $false
}

function Get-WindowAccessibleNodes([IntPtr]$Handle) {
    $result = [System.Collections.Generic.List[object]]::new()
    try {
        $root = [System.Windows.Automation.AutomationElement]::FromHandle($Handle)
        [void]$result.Add($root)
        $nodes = $root.FindAll(
            [System.Windows.Automation.TreeScope]::Descendants,
            [System.Windows.Automation.Condition]::TrueCondition
        )
        foreach ($node in $nodes) { [void]$result.Add($node) }
    }
    catch {
        # WebView accessibility nodes may be replaced while React changes surfaces.
    }
    return $result
}

function Get-AppAccessibleNodes([int]$ProcessId) {
    $result = [System.Collections.Generic.List[object]]::new()
    foreach ($handle in @([YuanyuanLearningAccessibilityWindowProbe]::VisibleWindows($ProcessId))) {
        foreach ($node in @(Get-WindowAccessibleNodes $handle)) { [void]$result.Add($node) }
    }
    return $result
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

function Get-NativeWindowHandle([System.Windows.Automation.AutomationElement]$Element) {
    $walker = [System.Windows.Automation.TreeWalker]::RawViewWalker
    $current = $Element
    while ($null -ne $current) {
        try {
            $handle = [int]$current.Current.NativeWindowHandle
            if ($handle -ne 0) { return [IntPtr]$handle }
            $current = $walker.GetParent($current)
        }
        catch { break }
    }
    return [IntPtr]::Zero
}

function Get-WindowMetrics([IntPtr]$Handle) {
    if ($Handle -eq [IntPtr]::Zero) { throw "native window handle is unavailable" }
    $client = New-Object YuanyuanLearningAccessibilityWindowProbe+Rect
    $window = New-Object YuanyuanLearningAccessibilityWindowProbe+Rect
    if (
        -not [YuanyuanLearningAccessibilityWindowProbe]::GetClientRect($Handle, [ref]$client) -or
        -not [YuanyuanLearningAccessibilityWindowProbe]::GetWindowRect($Handle, [ref]$window)
    ) { throw "native window metrics are unavailable" }
    $dpi = [int][YuanyuanLearningAccessibilityWindowProbe]::GetDpiForWindow($Handle)
    if ($dpi -lt 96 -or $dpi -gt 768) { throw "native window DPI is outside the accepted range" }
    $clientWidth = $client.Right - $client.Left
    $clientHeight = $client.Bottom - $client.Top
    $workArea = [YuanyuanLearningAccessibilityWindowProbe]::WorkAreaForWindow($Handle)
    $fullyWithinWorkArea =
        $window.Left -ge $workArea.Left -and
        $window.Top -ge $workArea.Top -and
        $window.Right -le $workArea.Right -and
        $window.Bottom -le $workArea.Bottom
    return [ordered]@{
        dpi = $dpi
        scalePercent = [Math]::Round(($dpi / 96.0) * 100.0, 1)
        clientPhysicalWidth = $clientWidth
        clientPhysicalHeight = $clientHeight
        clientLogicalWidth = [Math]::Round(($clientWidth * 96.0) / $dpi, 1)
        clientLogicalHeight = [Math]::Round(($clientHeight * 96.0) / $dpi, 1)
        windowPhysicalWidth = $window.Right - $window.Left
        windowPhysicalHeight = $window.Bottom - $window.Top
        left = $window.Left
        top = $window.Top
        right = $window.Right
        bottom = $window.Bottom
        workAreaLeft = $workArea.Left
        workAreaTop = $workArea.Top
        workAreaRight = $workArea.Right
        workAreaBottom = $workArea.Bottom
        fullyWithinWorkArea = $fullyWithinWorkArea
    }
}

function Request-LogicalPanelSize([string]$Root, [IntPtr]$Handle, [int]$Width, [int]$Height) {
    $size = "$($Width)x$($Height)"
    if ($size -notin @("360x560", "390x620", "480x760")) {
        throw "runtime QA panel size is outside the fixed allowlist"
    }
    $trigger = "set-panel-size-$size"
    $controlPath = Join-Path (Join-Path $Root "control") $trigger
    $appliedPath = Join-Path (Join-Path $Root "status") "$trigger-applied"
    $failedPath = Join-Path (Join-Path $Root "status") "$trigger-failed"
    Remove-Item -LiteralPath $appliedPath, $failedPath -Force -ErrorAction SilentlyContinue
    $stream = [System.IO.File]::Open(
        $controlPath,
        [System.IO.FileMode]::CreateNew,
        [System.IO.FileAccess]::Write,
        [System.IO.FileShare]::None
    )
    $stream.Dispose()
    $deadline = [DateTime]::UtcNow.AddSeconds(5)
    do {
        if (Test-Path -LiteralPath $failedPath -PathType Leaf) {
            throw "runtime QA panel resize failed inside the Tauri main thread"
        }
        Start-Sleep -Milliseconds 50
        $metrics = Get-WindowMetrics $Handle
        if (
            (Test-Path -LiteralPath $appliedPath -PathType Leaf) -and
            [Math]::Abs($metrics.clientLogicalWidth - $Width) -le 1 -and
            [Math]::Abs($metrics.clientLogicalHeight - $Height) -le 1 -and
            $metrics.fullyWithinWorkArea
        ) { return $metrics }
    } while ([DateTime]::UtcNow -lt $deadline)
    throw (
        "native panel did not reach the requested logical size and work area; requested={0}x{1}, actual={2}x{3}, window={4},{5},{6},{7}, workArea={8},{9},{10},{11}, fullyWithin={12}" -f
        $Width,
        $Height,
        $metrics.clientLogicalWidth,
        $metrics.clientLogicalHeight,
        $metrics.left,
        $metrics.top,
        $metrics.right,
        $metrics.bottom,
        $metrics.workAreaLeft,
        $metrics.workAreaTop,
        $metrics.workAreaRight,
        $metrics.workAreaBottom,
        $metrics.fullyWithinWorkArea
    )
}

function Save-NativeWindowCapture([IntPtr]$Handle, [string]$Path) {
    $metrics = Get-WindowMetrics $Handle
    $width = $metrics.windowPhysicalWidth
    $height = $metrics.windowPhysicalHeight
    if ($width -lt 1 -or $height -lt 1 -or $width -gt 2000 -or $height -gt 2000) {
        throw "native evidence window is outside the safe capture budget"
    }
    $captured = $false
    for ($attempt = 0; $attempt -lt 5 -and -not $captured; $attempt += 1) {
        $bitmap = New-Object System.Drawing.Bitmap($width, $height)
        $graphics = [System.Drawing.Graphics]::FromImage($bitmap)
        $hdc = [IntPtr]::Zero
        try {
            [void][YuanyuanLearningAccessibilityWindowProbe]::SetForegroundWindow($Handle)
            Start-Sleep -Milliseconds (100 + (100 * $attempt))
            $hdc = $graphics.GetHdc()
            $captured = [YuanyuanLearningAccessibilityWindowProbe]::PrintWindow($Handle, $hdc, 2)
            $graphics.ReleaseHdc($hdc)
            $hdc = [IntPtr]::Zero
            if ($captured) {
                $bitmap.Save($Path, [System.Drawing.Imaging.ImageFormat]::Png)
            }
        }
        finally {
            if ($hdc -ne [IntPtr]::Zero) { $graphics.ReleaseHdc($hdc) }
            $graphics.Dispose()
            $bitmap.Dispose()
        }
    }
    if (-not $captured) { throw "PrintWindow could not capture the isolated application window after 5 attempts" }
    return [ordered]@{
        physicalWidth = $width
        physicalHeight = $height
        bytes = (Get-Item -LiteralPath $Path).Length
        sha256 = Get-FileSha256 $Path
    }
}

function Invoke-AccessibleElement([System.Windows.Automation.AutomationElement]$Element) {
    $pattern = $null
    if (-not $Element.TryGetCurrentPattern(
        [System.Windows.Automation.InvokePattern]::Pattern,
        [ref]$pattern
    )) { throw "learning start control does not expose the invoke pattern" }
    ([System.Windows.Automation.InvokePattern]$pattern).Invoke()
}

function Get-FirstOptionFocusEvidence([int]$ProcessId, [IntPtr]$BlackboardHandle) {
    $answerOption = Find-AppElement $ProcessId $syntheticMeaningName $false $true
    if ($null -eq $answerOption) {
        throw "the first answer option is absent from Windows UI Automation"
    }
    $rect = $answerOption.Current.BoundingRectangle
    $blackboard = Get-WindowMetrics $BlackboardHandle
    $inside =
        $rect.Width -gt 0 -and
        $rect.Height -gt 0 -and
        $rect.Left -ge ($blackboard.left - 1) -and
        $rect.Top -ge ($blackboard.top - 1) -and
        $rect.Right -le ($blackboard.right + 1) -and
        $rect.Bottom -le ($blackboard.bottom + 1)
    $setFocusRequested = $false
    [void][YuanyuanLearningAccessibilityWindowProbe]::SetForegroundWindow($BlackboardHandle)
    $answerOption.SetFocus()
    $setFocusRequested = $true
    Start-Sleep -Milliseconds 100
    $globallyFocused = [System.Windows.Automation.AutomationElement]::FocusedElement
    $globalFocusObserved =
        $null -ne $globallyFocused -and
        $globallyFocused.Current.ProcessId -eq $answerOption.Current.ProcessId -and
        $globallyFocused.Current.Name -eq $answerOption.Current.Name
    return [ordered]@{
        hostProcessId = $ProcessId
        elementProcessId = $answerOption.Current.ProcessId
        name = $answerOption.Current.Name
        controlType = $answerOption.Current.ControlType.ProgrammaticName.Replace("ControlType.", "").ToLowerInvariant()
        left = [Math]::Round($rect.Left, 1)
        top = [Math]::Round($rect.Top, 1)
        width = [Math]::Round($rect.Width, 1)
        height = [Math]::Round($rect.Height, 1)
        insideBlackboard = $inside
        belongsToBlackboardWindow = $inside
        keyboardFocusable = $answerOption.Current.IsKeyboardFocusable
        setFocusRequested = $setFocusRequested
        globalFocusObserved = $globalFocusObserved
        method = "uia-set-focus-request"
    }
}

function Remove-OwnedQaRoot([string]$Root, [string]$ExpectedLeaf) {
    if (-not (Test-Path -LiteralPath $Root -PathType Container)) { return }
    $canonicalRoot = (Resolve-Path -LiteralPath $Root).Path
    $canonicalParent = (Resolve-Path -LiteralPath $workspaceRoot).Path
    $markerPath = Join-Path $canonicalRoot ".yuanyuan-runtime-qa-v1"
    if (
        (Split-Path -Parent $canonicalRoot) -ne $canonicalParent -or
        (Split-Path -Leaf $canonicalRoot) -ne $ExpectedLeaf -or
        -not (Test-Path -LiteralPath $markerPath -PathType Leaf) -or
        (Get-Content -Raw -Encoding UTF8 -LiteralPath $markerPath) -ne $expectedMarker
    ) { throw "refusing to remove an unowned runtime QA root" }
    Remove-Item -LiteralPath $canonicalRoot -Recurse -Force
}

$lockPath = Join-Path $evidenceRoot "learning-accessibility-matrix.lock"
try {
    $lockStream = [System.IO.File]::Open(
        $lockPath,
        [System.IO.FileMode]::OpenOrCreate,
        [System.IO.FileAccess]::ReadWrite,
        [System.IO.FileShare]::None
    )
}
catch { throw "another learning accessibility measurement is already active" }

$scriptExitCode = 0
try {
    $samples = @()
    $captures = @()
    $fixtureContentSha256 = $null
    $fixtureExecutableSha256 = Get-FileSha256 $fixturePath
    $applicationSha256 = Get-FileSha256 $appPath
    $webView2Version = $null

    foreach ($mode in $modes) {
        $leaf = "yuanyuan-runtime-qa-learning-accessibility-$runId-$($mode.name)"
        $qaRoot = Join-Path $workspaceRoot $leaf
        $process = $null
        $sample = [ordered]@{
            mode = $mode.name
            browserArguments = $mode.browserArguments
            fixtureDatabaseSha256 = $null
            panelMeasurements = @()
            blackboard = $null
            focusedElement = $null
            accessibilityNames = @()
            controlledExit = $false
            exitCode = $null
            rootRemoved = $false
            passed = $false
            failure = $null
        }
        try {
            $planText = & $fixturePath --root $qaRoot --learning-performance $fixtureCardCount
            if ($LASTEXITCODE -ne 0) { throw "learning fixture seeding failed" }
            $plan = $planText | ConvertFrom-Json
            if ($plan.cardCount -ne $fixtureCardCount) { throw "learning fixture count is incorrect" }
            if ($null -eq $fixtureContentSha256) { $fixtureContentSha256 = $plan.contentSha256 }
            elseif ($fixtureContentSha256 -ne $plan.contentSha256) {
                throw "learning fixture content changed between modes"
            }
            $sample.fixtureDatabaseSha256 = $plan.databaseSha256
            if ($mode.name -eq "reduced-motion") {
                $animationUpdate = & $fixturePath --root $qaRoot --animation-mode system
                if ($LASTEXITCODE -ne 0) { throw "runtime QA system animation mode seeding failed" }
                $animationResult = $animationUpdate | ConvertFrom-Json
                if ($animationResult.updated -ne $true) {
                    throw "runtime QA system animation mode was not confirmed"
                }
            }

            $variables = @(
                [ordered]@{ name = "YUANYUAN_RUNTIME_QA_ROOT"; value = $qaRoot },
                [ordered]@{ name = "YUANYUAN_RUNTIME_QA_PROFILE"; value = "learning-performance" },
                [ordered]@{ name = "YUANYUAN_RUNTIME_QA_EXIT_AFTER_SECONDS"; value = [string]$ExitAfterSeconds },
                [ordered]@{ name = "YUANYUAN_RUNTIME_QA_WEBVIEW_MODE"; value = $mode.name },
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
                if ($variable.value) { Set-Item "Env:$($variable.name)" $variable.value }
                else { Remove-Item "Env:$($variable.name)" -ErrorAction SilentlyContinue }
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
            $learningPage = Wait-AppElement $process $learningPageName $true $false 30
            $panelHandle = Get-NativeWindowHandle $learningPage
            if ($panelHandle -eq [IntPtr]::Zero) { throw "learning panel window is unavailable" }

            $sizes = if ($mode.name -eq "standard") {
                $standardPanelSizes
            }
            else {
                @([ordered]@{ width = 390; height = 620 })
            }
            foreach ($size in $sizes) {
                $metrics = Request-LogicalPanelSize $qaRoot $panelHandle $size.width $size.height
                $pageStillPresent = $null -ne (Find-AppElement $process.Id $learningPageName $true $false)
                $captureName = $null
                if ($mode.name -eq "standard") {
                    $captureName = "standard-panel-$($size.width)x$($size.height).png"
                    $capturePath = Join-Path $captureRoot $captureName
                    $capture = Save-NativeWindowCapture $panelHandle $capturePath
                    $captures += [ordered]@{
                        name = $captureName
                        mode = $mode.name
                        scene = "panel"
                        physicalWidth = $capture.physicalWidth
                        physicalHeight = $capture.physicalHeight
                        bytes = $capture.bytes
                        sha256 = $capture.sha256
                    }
                }
                $sample.panelMeasurements += [ordered]@{
                    requestedLogicalWidth = $size.width
                    requestedLogicalHeight = $size.height
                    actual = $metrics
                    learningPageAccessible = $pageStillPresent
                    captureName = $captureName
                }
            }

            $startButton = Wait-AppElement $process $startRoundName $false $true 10
            Invoke-AccessibleElement $startButton
            $blackboard = Wait-AppElement $process $blackboardName $true $false 20
            $null = Wait-AppElement $process $optionsName $true $false 10
            $null = Wait-AppElement $process $endRoundName $true $true 10
            $blackboardHandle = Get-NativeWindowHandle $blackboard
            if ($blackboardHandle -eq [IntPtr]::Zero) { throw "learning blackboard window is unavailable" }

            $deadline = [DateTime]::UtcNow.AddSeconds(5)
            do {
                $blackboardMetrics = Get-WindowMetrics $blackboardHandle
                if (
                    [Math]::Abs($blackboardMetrics.clientLogicalWidth - 520) -le 1 -and
                    [Math]::Abs($blackboardMetrics.clientLogicalHeight - 420) -le 1
                ) { break }
                Start-Sleep -Milliseconds 50
            } while ([DateTime]::UtcNow -lt $deadline)
            if (
                [Math]::Abs($blackboardMetrics.clientLogicalWidth - 520) -gt 1 -or
                [Math]::Abs($blackboardMetrics.clientLogicalHeight - 420) -gt 1
            ) { throw "learning blackboard did not reach 520 by 420 logical pixels" }

            Start-Sleep -Milliseconds 200
            $sample.focusedElement = Get-FirstOptionFocusEvidence $process.Id $blackboardHandle

            $names = [System.Collections.Generic.HashSet[string]]::new()
            foreach ($node in @(Get-WindowAccessibleNodes $blackboardHandle)) {
                try {
                    $name = $node.Current.Name
                    if ($name -and $name.Length -le 256) { [void]$names.Add($name) }
                }
                catch {}
            }
            $sample.accessibilityNames = @($names | Sort-Object)
            if (
                -not $sample.accessibilityNames.Contains($blackboardName) -or
                -not $sample.accessibilityNames.Contains($optionsName) -or
                -not $sample.accessibilityNames.Contains($endRoundName)
            ) { throw "blackboard accessibility names are incomplete" }
            $reducedStatusFound = $sample.accessibilityNames.Contains($reducedMotionStatusName)
            $forcedColorsStatusFound = $sample.accessibilityNames.Contains($forcedColorsStatusName)
            if (
                ($mode.name -eq "standard" -and ($reducedStatusFound -or $forcedColorsStatusFound)) -or
                ($mode.name -eq "reduced-motion" -and (-not $reducedStatusFound -or $forcedColorsStatusFound)) -or
                ($mode.name -eq "forced-colors" -and ($reducedStatusFound -or -not $forcedColorsStatusFound))
            ) { throw "WebView display mode status does not match the requested mode" }

            $captureName = "$($mode.name)-blackboard-520x420.png"
            $capturePath = Join-Path $captureRoot $captureName
            $capture = Save-NativeWindowCapture $blackboardHandle $capturePath
            $captures += [ordered]@{
                name = $captureName
                mode = $mode.name
                scene = "blackboard"
                physicalWidth = $capture.physicalWidth
                physicalHeight = $capture.physicalHeight
                bytes = $capture.bytes
                sha256 = $capture.sha256
            }
            $sample.blackboard = [ordered]@{
                expectedLogicalWidth = 520
                expectedLogicalHeight = 420
                actual = $blackboardMetrics
                captureName = $captureName
            }

            if ($null -eq $webView2Version) {
                try {
                    $webView2 = Get-Process -Name "msedgewebview2" -ErrorAction Stop | Select-Object -First 1
                    $webView2Version = $webView2.MainModule.FileVersionInfo.FileVersion
                }
                catch { $webView2Version = $null }
            }

            $process.WaitForExit(($ExitAfterSeconds + 15) * 1000) | Out-Null
            $process.Refresh()
            if (-not $process.HasExited) { throw "application did not use the controlled exit path" }
            $sample.exitCode = $process.ExitCode
            $sample.controlledExit = $process.ExitCode -eq 0
            if (-not $sample.controlledExit) { throw "controlled exit returned a non-zero code" }
            $sample.passed = $true
        }
        catch { $sample.failure = $_.Exception.Message }
        finally {
            if ($null -ne $process) {
                try {
                    $process.Refresh()
                    if (-not $process.HasExited) {
                        $ownedProcess = Get-Process -Id $process.Id -ErrorAction Stop
                        if ($ownedProcess.Path -ne $appPath) {
                            throw "refusing to stop a process outside the runtime QA executable"
                        }
                        Stop-Process -Id $process.Id -Force
                    }
                }
                catch {}
            }
            Start-Sleep -Milliseconds 500
            try {
                Remove-OwnedQaRoot $qaRoot $leaf
                $sample.rootRemoved = -not (Test-Path -LiteralPath $qaRoot)
            }
            catch {
                $sample.failure = if ($sample.failure) {
                    "$($sample.failure); cleanup failed: $($_.Exception.Message)"
                }
                else { "cleanup failed: $($_.Exception.Message)" }
                $sample.passed = $false
            }
        }
        $samples += [pscustomobject]$sample
    }

    $sourceBranch = (& git -C $projectRoot branch --show-current).Trim()
    $sourceCommit = (& git -C $projectRoot rev-parse HEAD).Trim()
    $sourceDirty = @(& git -C $projectRoot status --porcelain).Count -gt 0
    $windowsVersion = Get-ItemProperty -LiteralPath "HKLM:\SOFTWARE\Microsoft\Windows NT\CurrentVersion"
    $ready =
        @($samples | Where-Object passed).Count -eq $modes.Count -and
        @($samples | Where-Object rootRemoved).Count -eq $modes.Count -and
        $captures.Count -eq 6
    $report = [ordered]@{
        schemaVersion = 1
        generatedAt = [DateTimeOffset]::UtcNow.ToString("o")
        profile = "learning-accessibility-matrix"
        source = [ordered]@{
            branch = $sourceBranch
            commit = $sourceCommit
            dirty = $sourceDirty
        }
        bindings = [ordered]@{
            applicationSha256 = $applicationSha256
            fixtureExecutableSha256 = $fixtureExecutableSha256
            fixtureContentSha256 = $fixtureContentSha256
            stylesheetSha256 = Get-FileSha256 (Join-Path $projectRoot "src\learning\learningDesktop.css")
            scriptSha256 = Get-FileSha256 $PSCommandPath
        }
        device = [ordered]@{
            windowsProductName = $windowsVersion.ProductName
            windowsDisplayVersion = $windowsVersion.DisplayVersion
            windowsBuild = "$($windowsVersion.CurrentBuildNumber).$($windowsVersion.UBR)"
            processorArchitecture = [Environment]::GetEnvironmentVariable("PROCESSOR_ARCHITECTURE")
            logicalProcessors = [Environment]::ProcessorCount
            webView2RuntimeVersion = $webView2Version
        }
        request = [ordered]@{
            exitAfterSeconds = $ExitAfterSeconds
            cardCount = $fixtureCardCount
            modes = @($modes | ForEach-Object { $_.name })
            standardPanelSizes = $standardPanelSizes
            blackboardSize = [ordered]@{ width = 520; height = 420 }
            panelPlacement = "work-area-top-left"
        }
        samples = $samples
        captures = $captures
        ready = $ready
        limitations = @(
            "The application and fixture are an isolated learning runtime-QA build, not a signed production candidate.",
            "The five cards are deterministic synthetic content and contain no personal learning material.",
            "The window sizes are measured in Tauri logical pixels at the current real Windows DPI; other physical DPI settings, multiple displays, and negative coordinates remain manual checks.",
            "The runtime-QA panel starts at an allowlisted in-work-area logical position, and every measured native window must remain fully inside its current Windows work area.",
            "Reduced motion and forced colors use allowlisted arguments injected programmatically by the runtime-QA Tauri WebView builder, and each matching media state is confirmed in the accessibility tree; a human Windows setting and Narrator review remain manual checks.",
            "Windows UI Automation proves that the first answer can receive focus and exposes the required names; DOM auto-focus is covered separately, and a complete physical keyboard session remains manual.",
            "PrintWindow captures are restricted to isolated application-owned windows and do not capture the desktop."
        )
        failure = if ($ready) { $null } else { "one or more accessibility matrix modes failed" }
    }
    $report | ConvertTo-Json -Depth 10 | Set-Content -Encoding UTF8 -LiteralPath $reportPath
    Write-Output "Learning accessibility matrix report written: $reportPath"
    Write-Output "Modes=$(@($samples | Where-Object passed).Count)/$($modes.Count) Captures=$($captures.Count)/6 Ready=$ready"
    if (-not $ready) { $scriptExitCode = 2 }
}
finally {
    if ($null -ne $lockStream) { $lockStream.Dispose() }
    Remove-Item -LiteralPath $lockPath -Force -ErrorAction SilentlyContinue
}
exit $scriptExitCode
