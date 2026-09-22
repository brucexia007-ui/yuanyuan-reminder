param(
    [ValidateRange(45, 120)]
    [int]$ExitAfterSeconds = 60
)

$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"
$projectRoot = Split-Path -Parent $PSScriptRoot
$workspaceRoot = Split-Path -Parent $projectRoot
$runtimeTarget = Join-Path $projectRoot "src-tauri\target\runtime-qa-learning-sleep\release"
$appPath = Join-Path $runtimeTarget "yuanyuan-reminder.exe"
$fixturePath = Join-Path $runtimeTarget "yuanyuan-runtime-qa-fixture.exe"
$evidenceRoot = Join-Path $runtimeTarget "evidence"
$runId = (Get-Date).ToUniversalTime().ToString("yyyyMMddTHHmmssZ")
$reportPath = Join-Path $evidenceRoot "learning-sleep-wake-$runId.json"
$captureRoot = Join-Path $evidenceRoot "learning-sleep-wake-$runId"
$leaf = "yuanyuan-runtime-qa-learning-sleep-$runId"
$qaRoot = Join-Path $workspaceRoot $leaf
$expectedMarker = "YUANYUAN_RUNTIME_QA_V1`n"
$fixtureCardCount = 5

$learningPageName = -join @([char]0x5B66, [char]0x4E60, [char]0x9875, [char]0x9762)
$blackboardName = -join @(
    [char]0x5706, [char]0x5706, [char]0x684C, [char]0x9762,
    [char]0x82F1, [char]0x8BED, [char]0x590D, [char]0x4E60
)
$startRoundName = -join @([char]0x5F00, [char]0x59CB, [char]0x4E00, [char]0x8F6E)
$petWindowName = -join @(
    [char]0x5706, [char]0x5706, [char]0x684C, [char]0x9762,
    [char]0x5BA0, [char]0x7269
)
$sleepMenuName = -join @(
    [char]0x7ACB, [char]0x5373, [char]0x7761, [char]0x89C9,
    [char]0x2F,
    [char]0x53EB, [char]0x9192, [char]0x5706, [char]0x5706
)
$learningQuickStartMenuName = -join @(
    [char]0x5173, [char]0x95ED,
    [char]0x5FEB, [char]0x6377, [char]0x6309, [char]0x952E
)
$sleepStatusName = -join @(
    [char]0x5706, [char]0x5706, [char]0x6B63, [char]0x5728,
    [char]0x7761, [char]0x89C9
)
$wakeStatusName = -join @(
    [char]0x5706, [char]0x5706, [char]0x5DF2, [char]0x9192,
    [char]0xFF0C,
    [char]0x4E0A, [char]0x4E00, [char]0x8F6E, [char]0x5B66,
    [char]0x4E60, [char]0x53EF, [char]0x4EE5, [char]0x7EE7,
    [char]0x7EED
)
foreach ($required in @($appPath, $fixturePath)) {
    if (-not (Test-Path -LiteralPath $required -PathType Leaf)) {
        throw "learning sleep/wake runtime QA binary is missing; run npm.cmd run runtime:qa:learning-sleep:build first"
    }
}
New-Item -ItemType Directory -Force -Path $evidenceRoot, $captureRoot | Out-Null
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes
Add-Type -AssemblyName System.Drawing

if (-not ("YuanyuanLearningSleepWindowProbe" -as [type])) {
    Add-Type -TypeDefinition @"
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Text;

public static class YuanyuanLearningSleepWindowProbe {
    private delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);

    [StructLayout(LayoutKind.Sequential)]
    public struct Rect {
        public int Left;
        public int Top;
        public int Right;
        public int Bottom;
    }

    [DllImport("user32.dll")]
    private static extern bool EnumWindows(EnumWindowsProc callback, IntPtr lParam);

    [DllImport("user32.dll")]
    private static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint processId);

    [DllImport("user32.dll")]
    private static extern IntPtr GetAncestor(IntPtr hWnd, uint flags);

    [DllImport("user32.dll")]
    private static extern bool IsWindowVisible(IntPtr hWnd);

    [DllImport("user32.dll")]
    public static extern bool SetForegroundWindow(IntPtr hWnd);

    [DllImport("user32.dll")]
    private static extern bool SetCursorPos(int x, int y);

    [DllImport("user32.dll")]
    private static extern void mouse_event(uint flags, uint dx, uint dy, uint data, UIntPtr extraInfo);

    [DllImport("user32.dll")]
    public static extern bool GetWindowRect(IntPtr hWnd, out Rect rect);

    [DllImport("user32.dll")]
    public static extern bool PrintWindow(IntPtr hWnd, IntPtr hdc, uint flags);

    [DllImport("user32.dll", CharSet = CharSet.Unicode)]
    private static extern int GetClassName(IntPtr hWnd, StringBuilder value, int maxCount);

    [DllImport("user32.dll", CharSet = CharSet.Unicode)]
    private static extern int GetMenuString(IntPtr menu, uint item, StringBuilder value, int maxCount, uint flags);

    [DllImport("user32.dll")]
    private static extern int GetMenuItemCount(IntPtr menu);

    [DllImport("user32.dll")]
    private static extern uint GetMenuItemID(IntPtr menu, int position);

    [DllImport("user32.dll")]
    private static extern IntPtr GetWindow(IntPtr hWnd, uint command);

    [DllImport("user32.dll")]
    private static extern IntPtr SendMessage(IntPtr hWnd, uint message, IntPtr wParam, IntPtr lParam);

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

    public static int OwnerProcessId(IntPtr hWnd) {
        uint owner;
        GetWindowThreadProcessId(hWnd, out owner);
        return (int)owner;
    }

    public static IntPtr RootWindow(IntPtr hWnd) { return GetAncestor(hWnd, 2); }

    public static string WindowClass(IntPtr hWnd) {
        var value = new StringBuilder(256);
        GetClassName(hWnd, value, value.Capacity);
        return value.ToString();
    }

    public static IntPtr PopupMenuWindow(int processId) {
        foreach (var hWnd in VisibleWindows(processId)) {
            if (WindowClass(hWnd) == "#32768") return hWnd;
        }
        return IntPtr.Zero;
    }

    public static string[] MenuItems(IntPtr hWnd) {
        var menu = SendMessage(hWnd, 0x01E1, IntPtr.Zero, IntPtr.Zero);
        if (menu == IntPtr.Zero) return new string[0];
        var count = GetMenuItemCount(menu);
        if (count < 0 || count > 64) return new string[0];
        var items = new List<string>();
        for (uint index = 0; index < count; index++) {
            var value = new StringBuilder(512);
            GetMenuString(menu, index, value, value.Capacity, 0x00000400);
            items.Add(value.ToString());
        }
        return items.ToArray();
    }

    public static long[] InvokeMenuPosition(IntPtr hWnd, int position, IntPtr fallbackOwner) {
        var menu = SendMessage(hWnd, 0x01E1, IntPtr.Zero, IntPtr.Zero);
        if (menu == IntPtr.Zero) throw new InvalidOperationException("native popup menu handle is unavailable");
        var commandId = GetMenuItemID(menu, position);
        if (commandId == 0xFFFFFFFF) throw new InvalidOperationException("native popup menu item has no command id");
        var owner = GetWindow(hWnd, 4);
        if (owner == IntPtr.Zero) owner = fallbackOwner;
        if (owner == IntPtr.Zero) throw new InvalidOperationException("native popup menu owner is unavailable");
        SendMessage(owner, 0x001F, IntPtr.Zero, IntPtr.Zero);
        return new long[] { commandId, owner.ToInt64() };
    }

    private static void Click(int x, int y, uint down, uint up) {
        SetCursorPos(x, y);
        mouse_event(down, 0, 0, 0, UIntPtr.Zero);
        mouse_event(up, 0, 0, 0, UIntPtr.Zero);
    }

    public static void RightClick(int x, int y) { Click(x, y, 0x0008, 0x0010); }
    public static void LeftClick(int x, int y) { Click(x, y, 0x0002, 0x0004); }
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

function Get-AppAccessibleNodes([int]$ProcessId) {
    $result = [System.Collections.Generic.List[object]]::new()
    foreach ($handle in @([YuanyuanLearningSleepWindowProbe]::VisibleWindows($ProcessId))) {
        try {
            $root = [System.Windows.Automation.AutomationElement]::FromHandle($handle)
            [void]$result.Add($root)
            $nodes = $root.FindAll(
                [System.Windows.Automation.TreeScope]::Descendants,
                [System.Windows.Automation.Condition]::TrueCondition
            )
            foreach ($node in $nodes) { [void]$result.Add($node) }
        }
        catch {
            # React and WebView accessibility nodes can disappear between snapshots.
        }
    }
    return $result
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

function Get-AppWindowDetails([int]$ProcessId) {
    $details = @()
    foreach ($handle in @([YuanyuanLearningSleepWindowProbe]::VisibleWindows($ProcessId))) {
        $rect = New-Object YuanyuanLearningSleepWindowProbe+Rect
        [void][YuanyuanLearningSleepWindowProbe]::GetWindowRect($handle, [ref]$rect)
        $details += [ordered]@{
            handle = $handle.ToInt64()
            className = [YuanyuanLearningSleepWindowProbe]::WindowClass($handle)
            left = $rect.Left
            top = $rect.Top
            right = $rect.Right
            bottom = $rect.Bottom
        }
    }
    return $details
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
        if ($Process.HasExited) { throw "application exited before the expected accessible element appeared" }
        $element = Find-AppElement $Process.Id $Name $Exact $ButtonOnly
        if ($null -ne $element) { return $element }
        Start-Sleep -Milliseconds 50
    }
    throw "expected application accessibility element did not appear: $Name"
}

function Wait-AppElementAbsent(
    [System.Diagnostics.Process]$Process,
    [string]$Name,
    [bool]$Exact,
    [int]$TimeoutSeconds
) {
    $deadline = [DateTime]::UtcNow.AddSeconds($TimeoutSeconds)
    while ([DateTime]::UtcNow -lt $deadline) {
        $Process.Refresh()
        if ($Process.HasExited) { throw "application exited while waiting for an accessible element to disappear" }
        if ($null -eq (Find-AppElement $Process.Id $Name $Exact $false)) { return $true }
        Start-Sleep -Milliseconds 50
    }
    return $false
}

function Wait-NativeMenuWindow(
    [System.Diagnostics.Process]$Process,
    [int]$TimeoutSeconds
) {
    $deadline = [DateTime]::UtcNow.AddSeconds($TimeoutSeconds)
    while ([DateTime]::UtcNow -lt $deadline) {
        $Process.Refresh()
        if ($Process.HasExited) { throw "application exited before the native menu appeared" }
        $handle = [YuanyuanLearningSleepWindowProbe]::PopupMenuWindow($Process.Id)
        if ($handle -ne [IntPtr]::Zero) { return $handle }
        Start-Sleep -Milliseconds 50
    }
    throw "native sleep/wake menu window was not found"
}

function Open-PetContextMenu(
    [System.Diagnostics.Process]$Process,
    [System.Windows.Automation.AutomationElement]$Pet
) {
    $controlDirectory = Join-Path $qaRoot "control"
    $controlDeadline = [DateTime]::UtcNow.AddSeconds(5)
    while (-not (Test-Path -LiteralPath $controlDirectory -PathType Container)) {
        if ([DateTime]::UtcNow -ge $controlDeadline) {
            throw "runtime QA context menu control directory did not appear"
        }
        Start-Sleep -Milliseconds 50
    }
    $trigger = Join-Path $controlDirectory "show-pet-context-menu"
    [System.IO.File]::WriteAllBytes($trigger, [byte[]]@())
    $menu = Wait-NativeMenuWindow $Process 5
    $items = @([YuanyuanLearningSleepWindowProbe]::MenuItems($menu))
    if (
        $items.Count -lt 9 -or
        $items[4] -ne $sleepMenuName -or
        $items[8] -ne $learningQuickStartMenuName
    ) {
        throw "native context menu does not expose the expected sleep/wake and course shortcut items at their frozen positions"
    }
    return [pscustomobject]@{
        handle = $menu
        items = $items
        mode = "runtime-qa-control"
    }
}

function Invoke-PetSleepMenuHandler([int]$RequestNumber) {
    if (-not (Wait-RuntimeStage $qaRoot "context-menu-$RequestNumber-popup-returned" 5)) {
        throw "native context menu did not return after evidence inspection"
    }
    $trigger = Join-Path (Join-Path $qaRoot "control") "invoke-pet-sleep-menu"
    [System.IO.File]::WriteAllBytes($trigger, [byte[]]@())
    if (-not (Wait-RuntimeStage $qaRoot "pet-sleep-menu-$RequestNumber-handler-returned" 5)) {
        throw "runtime QA shared pet sleep menu handler did not return"
    }
}

function Read-PetSleepControlSnapshot([int]$RequestNumber) {
    $stage = "pet-sleep-menu-$RequestNumber-snapshot"
    if (-not (Wait-RuntimeStage $qaRoot $stage 5)) {
        throw "runtime QA pet activity snapshot was not recorded"
    }
    $path = Join-Path (Join-Path $qaRoot "status") $stage
    return [System.IO.File]::ReadAllText($path) | ConvertFrom-Json
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

function Save-NativeWindowCapture(
    [IntPtr]$Handle,
    [string]$Path
) {
    if ($Handle -eq [IntPtr]::Zero) { throw "native evidence window is unavailable" }
    $rect = New-Object YuanyuanLearningSleepWindowProbe+Rect
    if (-not [YuanyuanLearningSleepWindowProbe]::GetWindowRect($Handle, [ref]$rect)) {
        throw "native evidence window bounds are unavailable"
    }
    $width = $rect.Right - $rect.Left
    $height = $rect.Bottom - $rect.Top
    if ($width -lt 1 -or $height -lt 1 -or $width -gt 1200 -or $height -gt 1200) {
        throw "native evidence window bounds are outside the safe capture budget"
    }
    $bitmap = New-Object System.Drawing.Bitmap($width, $height)
    $graphics = [System.Drawing.Graphics]::FromImage($bitmap)
    $hdc = [IntPtr]::Zero
    try {
        $hdc = $graphics.GetHdc()
        if (-not [YuanyuanLearningSleepWindowProbe]::PrintWindow($Handle, $hdc, 2)) {
            throw "PrintWindow could not capture the isolated application window"
        }
    }
    finally {
        if ($hdc -ne [IntPtr]::Zero) { $graphics.ReleaseHdc($hdc) }
        $graphics.Dispose()
    }
    try {
        $bitmap.Save($Path, [System.Drawing.Imaging.ImageFormat]::Png)
    }
    finally { $bitmap.Dispose() }
}

function Save-ElementWindowCapture(
    [System.Windows.Automation.AutomationElement]$Element,
    [string]$Path
) {
    $handle = Get-NativeWindowHandle $Element
    if ($handle -eq [IntPtr]::Zero) { throw "accessible element has no native window for capture" }
    Save-NativeWindowCapture $handle $Path
}

function Click-Element(
    [System.Windows.Automation.AutomationElement]$Element,
    [bool]$Right,
    [double]$YFraction = 0.5
) {
    $bounds = $Element.Current.BoundingRectangle
    if ($bounds.Width -le 0 -or $bounds.Height -le 0) { throw "accessible element has no clickable bounds" }
    $x = [int][Math]::Round($bounds.X + ($bounds.Width / 2))
    $y = [int][Math]::Round($bounds.Y + ($bounds.Height * $YFraction))
    $handle = Get-NativeWindowHandle $Element
    if ($handle -ne [IntPtr]::Zero) {
        $rootHandle = [YuanyuanLearningSleepWindowProbe]::RootWindow($handle)
        if ($rootHandle -eq [IntPtr]::Zero) { $rootHandle = $handle }
        [void][YuanyuanLearningSleepWindowProbe]::SetForegroundWindow($rootHandle)
        Start-Sleep -Milliseconds 250
    }
    if ($Right) { [YuanyuanLearningSleepWindowProbe]::RightClick($x, $y) }
    else { [YuanyuanLearningSleepWindowProbe]::LeftClick($x, $y) }
}

function Invoke-AccessibleElement([System.Windows.Automation.AutomationElement]$Element) {
    $pattern = $null
    if ($Element.TryGetCurrentPattern(
        [System.Windows.Automation.InvokePattern]::Pattern,
        [ref]$pattern
    )) {
        ([System.Windows.Automation.InvokePattern]$pattern).Invoke()
        return
    }
    Click-Element $Element $false
}

function Start-QaApplication([string]$Root) {
    $rootExisted = Test-Path Env:YUANYUAN_RUNTIME_QA_ROOT
    $profileExisted = Test-Path Env:YUANYUAN_RUNTIME_QA_PROFILE
    $exitExisted = Test-Path Env:YUANYUAN_RUNTIME_QA_EXIT_AFTER_SECONDS
    $oldRoot = $env:YUANYUAN_RUNTIME_QA_ROOT
    $oldProfile = $env:YUANYUAN_RUNTIME_QA_PROFILE
    $oldExit = $env:YUANYUAN_RUNTIME_QA_EXIT_AFTER_SECONDS
    try {
        $env:YUANYUAN_RUNTIME_QA_ROOT = $Root
        $env:YUANYUAN_RUNTIME_QA_PROFILE = "learning-performance"
        $env:YUANYUAN_RUNTIME_QA_EXIT_AFTER_SECONDS = [string]$ExitAfterSeconds
        return Start-Process -FilePath $appPath -PassThru
    }
    finally {
        Restore-EnvironmentValue "YUANYUAN_RUNTIME_QA_ROOT" $oldRoot $rootExisted
        Restore-EnvironmentValue "YUANYUAN_RUNTIME_QA_PROFILE" $oldProfile $profileExisted
        Restore-EnvironmentValue "YUANYUAN_RUNTIME_QA_EXIT_AFTER_SECONDS" $oldExit $exitExisted
    }
}

function Stop-QaApplicationIfRunning([System.Diagnostics.Process]$Process) {
    if ($null -eq $Process) { return }
    try {
        $Process.Refresh()
        if ($Process.HasExited) { return }
        $ownedProcess = Get-Process -Id $Process.Id -ErrorAction Stop
        if ($ownedProcess.Path -ne $appPath) {
            throw "refusing to stop a process outside the sleep/wake QA executable"
        }
        Stop-Process -Id $Process.Id -Force
        $Process.WaitForExit(10000) | Out-Null
    }
    catch {}
}

function Read-LearningState([string]$Root) {
    $text = & $fixturePath --root $Root --learning-preemption-state
    if ($LASTEXITCODE -ne 0) { throw "learning sleep/wake state inspection failed" }
    return $text | ConvertFrom-Json
}

function Wait-LearningState(
    [string]$Root,
    [string]$Status,
    $PauseReason,
    [int]$TimeoutSeconds
) {
    $deadline = [DateTime]::UtcNow.AddSeconds($TimeoutSeconds)
    while ([DateTime]::UtcNow -lt $deadline) {
        try {
            $state = Read-LearningState $Root
            $reasonMatches = (
                ($null -eq $PauseReason -and $null -eq $state.pauseReason) -or
                $state.pauseReason -eq $PauseReason
            )
            if ($state.status -eq $Status -and $reasonMatches) { return $state }
        }
        catch {}
        Start-Sleep -Milliseconds 50
    }
    throw "learning session did not reach the expected sleep/wake state"
}

function Assert-CleanLearningState([object]$State, [string]$Phase) {
    if (
        $State.questionAttemptCount -ne 0 -or
        $State.reviewLogCount -ne 0 -or
        $State.answerCommittedEventCount -ne 0
    ) { throw "$Phase unexpectedly persisted an unanswered choice" }
    if ($State.integrityCheck -ne "ok" -or $State.foreignKeyViolationCount -ne 0) {
        throw "$Phase learning database integrity check failed"
    }
}

function Convert-LearningStateForReport([object]$State) {
    if ($null -eq $State) { return $null }
    return [ordered]@{
        sessionId = $State.sessionId
        status = $State.status
        stateRevision = $State.stateRevision
        currentItemId = $State.currentItemId
        headword = $State.headword
        pauseReason = $State.pauseReason
        interruptedEventCount = $State.interruptedEventCount
        interruptedAtUnixMs = $State.interruptedAtUnixMs
        answerCommittedEventCount = $State.answerCommittedEventCount
        questionAttemptCount = $State.questionAttemptCount
        reviewLogCount = $State.reviewLogCount
        integrityCheck = $State.integrityCheck
        foreignKeyViolationCount = $State.foreignKeyViolationCount
    }
}

function Remove-OwnedQaRoot([string]$Root, [string]$ExpectedLeaf) {
    if (-not (Test-Path -LiteralPath $Root -PathType Container)) { return $true }
    $canonicalRoot = (Resolve-Path -LiteralPath $Root).Path
    $canonicalParent = (Resolve-Path -LiteralPath $workspaceRoot).Path
    $markerPath = Join-Path $canonicalRoot ".yuanyuan-runtime-qa-v1"
    if (
        (Split-Path -Parent $canonicalRoot) -ne $canonicalParent -or
        (Split-Path -Leaf $canonicalRoot) -ne $ExpectedLeaf -or
        -not (Test-Path -LiteralPath $markerPath -PathType Leaf) -or
        (Get-Content -Raw -Encoding UTF8 -LiteralPath $markerPath) -ne $expectedMarker
    ) { throw "refusing to remove an unowned runtime QA root" }
    for ($attempt = 0; $attempt -lt 5; $attempt += 1) {
        try {
            Remove-Item -LiteralPath $canonicalRoot -Recurse -Force
            return -not (Test-Path -LiteralPath $canonicalRoot)
        }
        catch {
            if ($attempt -eq 4) { throw }
            Start-Sleep -Milliseconds 500
        }
    }
    return $false
}

function Get-WebView2Version {
    try {
        $process = Get-Process -Name "msedgewebview2" -ErrorAction Stop | Select-Object -First 1
        return $process.MainModule.FileVersionInfo.FileVersion
    }
    catch { return $null }
}

$lockPath = Join-Path $evidenceRoot "learning-sleep-wake.lock"
$lockStream = $null
try {
    $lockStream = [System.IO.File]::Open(
        $lockPath,
        [System.IO.FileMode]::OpenOrCreate,
        [System.IO.FileAccess]::ReadWrite,
        [System.IO.FileShare]::None
    )
}
catch { throw "another learning sleep/wake measurement is already active" }

$process = $null
$failure = $null
$rootRemoved = $false
$controlledExit = $false
$exitCode = $null
$plan = $null
$before = $null
$afterSleep = $null
$afterWake = $null
$sleepMenuFound = $false
$wakeMenuFound = $false
$sleepStatusFound = $false
$wakeStatusFound = $false
$blackboardYielded = $false
$blackboardStayedClosed = $false
$webView2Version = $null
$sleepMenuAccessibleNames = @()
$wakeMenuAccessibleNames = @()
$sleepMenuWindowDetails = @()
$sleepMenuOpenMode = $null
$wakeMenuOpenMode = $null
$sleepMenuCommand = $null
$wakeMenuCommand = $null
$afterSleepPetActivity = $null
$afterWakePetActivity = $null
$controlStatus = @()
$startedAt = [DateTimeOffset]::UtcNow
$sleepInvokedAt = $null
$wakeInvokedAt = $null

try {
    $planText = & $fixturePath --root $qaRoot --learning-performance $fixtureCardCount
    if ($LASTEXITCODE -ne 0) { throw "learning sleep/wake fixture seeding failed" }
    $plan = $planText | ConvertFrom-Json
    if ($plan.cardCount -ne $fixtureCardCount) { throw "learning fixture count is incorrect" }

    $process = Start-QaApplication $qaRoot
    if (-not (Wait-RuntimeStage $qaRoot "exit-scheduled" 30)) {
        throw "runtime QA window setup did not complete"
    }
    $null = Wait-AppElement $process $learningPageName $false $false 30
    $startButton = Wait-AppElement $process $startRoundName $false $true 10
    Invoke-AccessibleElement $startButton
    $null = Wait-AppElement $process $blackboardName $false $false 20
    $before = Wait-LearningState $qaRoot "active" $null 10
    Assert-CleanLearningState $before "pre-sleep"
    $pet = Wait-AppElement $process $petWindowName $true $false 10
    Save-ElementWindowCapture $pet (Join-Path $captureRoot "active-learning.png")
    $webView2Version = Get-WebView2Version

    $sleepMenuResult = Open-PetContextMenu $process $pet
    $sleepMenuAccessibleNames = @($sleepMenuResult.items)
    $sleepMenuWindowDetails = @(Get-AppWindowDetails $process.Id)
    $sleepMenu = $sleepMenuResult.handle
    $sleepMenuOpenMode = $sleepMenuResult.mode
    $sleepMenuFound = $true
    Save-NativeWindowCapture $sleepMenu (Join-Path $captureRoot "sleep-menu.png")
    $sleepInvokedAt = [DateTimeOffset]::UtcNow
    $petOwner = [YuanyuanLearningSleepWindowProbe]::RootWindow((Get-NativeWindowHandle $pet))
    $sleepMenuCommandResult = [YuanyuanLearningSleepWindowProbe]::InvokeMenuPosition(
        $sleepMenu,
        4,
        $petOwner
    )
    $sleepMenuCommand = [ordered]@{
        itemPosition = 4
        commandId = [long]$sleepMenuCommandResult[0]
        ownerHandle = [long]$sleepMenuCommandResult[1]
        dispatch = "runtime-qa-shared-menu-handler"
    }
    Invoke-PetSleepMenuHandler 1
    $afterSleepPetActivity = Read-PetSleepControlSnapshot 1

    $afterSleep = Wait-LearningState $qaRoot "paused" "preempted_high_priority" 10
    Assert-CleanLearningState $afterSleep "sleep"
    if (
        $afterSleep.sessionId -ne $before.sessionId -or
        $afterSleep.currentItemId -ne $before.currentItemId -or
        $afterSleep.headword -ne $before.headword -or
        $afterSleep.stateRevision -ne ($before.stateRevision + 1) -or
        $afterSleep.interruptedEventCount -ne ($before.interruptedEventCount + 1)
    ) { throw "manual sleep did not preserve the unanswered learning session" }
    if (
        $afterSleepPetActivity.activity -ne "sleeping" -or
        $afterSleepPetActivity.source -ne "manual" -or
        $null -ne $afterSleepPetActivity.leaseId -or
        $afterSleepPetActivity.resumableLearningSessionId -ne $before.sessionId -or
        $afterSleepPetActivity.restoreTarget -ne "learning"
    ) { throw "manual sleep did not publish the expected resumable pet snapshot" }
    $blackboardYielded = Wait-AppElementAbsent $process $blackboardName $false 10
    if (-not $blackboardYielded) { throw "learning blackboard stayed visible after manual sleep" }
    $null = Wait-AppElement $process $sleepStatusName $true $false 10
    $sleepStatusFound = $true
    Start-Sleep -Milliseconds 1300
    $pet = Wait-AppElement $process $petWindowName $true $false 5
    Save-ElementWindowCapture $pet (Join-Path $captureRoot "sleeping.png")

    $wakeMenuResult = Open-PetContextMenu $process $pet
    $wakeMenu = $wakeMenuResult.handle
    $wakeMenuAccessibleNames = @($wakeMenuResult.items)
    $wakeMenuOpenMode = $wakeMenuResult.mode
    $wakeMenuFound = $true
    Save-NativeWindowCapture $wakeMenu (Join-Path $captureRoot "wake-menu.png")
    $wakeInvokedAt = [DateTimeOffset]::UtcNow
    $petOwner = [YuanyuanLearningSleepWindowProbe]::RootWindow((Get-NativeWindowHandle $pet))
    $wakeMenuCommandResult = [YuanyuanLearningSleepWindowProbe]::InvokeMenuPosition(
        $wakeMenu,
        4,
        $petOwner
    )
    $wakeMenuCommand = [ordered]@{
        itemPosition = 4
        commandId = [long]$wakeMenuCommandResult[0]
        ownerHandle = [long]$wakeMenuCommandResult[1]
        dispatch = "runtime-qa-shared-menu-handler"
    }
    Invoke-PetSleepMenuHandler 2
    $afterWakePetActivity = Read-PetSleepControlSnapshot 2

    $afterWake = Read-LearningState $qaRoot
    Assert-CleanLearningState $afterWake "wake"
    if (
        $afterWake.sessionId -ne $afterSleep.sessionId -or
        $afterWake.currentItemId -ne $afterSleep.currentItemId -or
        $afterWake.headword -ne $afterSleep.headword -or
        $afterWake.status -ne "paused" -or
        $afterWake.pauseReason -ne "preempted_high_priority" -or
        $afterWake.stateRevision -ne $afterSleep.stateRevision -or
        $afterWake.interruptedEventCount -ne $afterSleep.interruptedEventCount
    ) { throw "wake changed or resumed the paused learning session" }
    if (
        $afterWakePetActivity.activity -ne "interrupted" -or
        $afterWakePetActivity.source -ne "learning" -or
        $null -ne $afterWakePetActivity.leaseId -or
        $afterWakePetActivity.resumableLearningSessionId -ne $before.sessionId -or
        $afterWakePetActivity.restoreTarget -ne "learning"
    ) { throw "manual wake did not publish the expected resumable pet snapshot" }
    $blackboardStayedClosed = Wait-AppElementAbsent $process $blackboardName $false 5
    if (-not $blackboardStayedClosed) { throw "wake unexpectedly reopened the learning blackboard" }
    $null = Wait-AppElement $process $wakeStatusName $true $false 10
    $wakeStatusFound = $true
    $pet = Wait-AppElement $process $petWindowName $true $false 5
    Save-ElementWindowCapture $pet (Join-Path $captureRoot "wake-up.png")

    $process.WaitForExit(($ExitAfterSeconds + 15) * 1000) | Out-Null
    $process.Refresh()
    if (-not $process.HasExited) { throw "application did not use the controlled exit path" }
    $exitCode = [int]$process.ExitCode
    $controlledExit = $exitCode -eq 0
    if (-not $controlledExit) { throw "controlled exit returned a non-zero code" }
}
catch {
    $failure = $_.Exception.Message
}
finally {
    Stop-QaApplicationIfRunning $process
    Start-Sleep -Milliseconds 750
    $statusDirectory = Join-Path $qaRoot "status"
    if (Test-Path -LiteralPath $statusDirectory -PathType Container) {
        foreach ($statusFile in @(Get-ChildItem -LiteralPath $statusDirectory -File)) {
            if (
                $statusFile.Name.StartsWith("context-menu-") -or
                $statusFile.Name.StartsWith("pet-sleep-menu-")
            ) {
                $controlStatus += [ordered]@{
                    name = $statusFile.Name
                    value = [System.IO.File]::ReadAllText($statusFile.FullName)
                }
            }
        }
    }
    try { $rootRemoved = Remove-OwnedQaRoot $qaRoot $leaf }
    catch {
        $rootRemoved = $false
        $failure = if ($failure) { "$failure; $($_.Exception.Message)" } else { $_.Exception.Message }
    }
    if ($null -ne $lockStream) { $lockStream.Dispose() }
}
Write-Output "Learning sleep/wake cleanup complete: rootRemoved=$rootRemoved"

$captureFiles = @()
foreach ($path in @(Get-ChildItem -LiteralPath $captureRoot -File -Filter "*.png" -ErrorAction SilentlyContinue)) {
    $captureFiles += [ordered]@{
        name = $path.Name
        bytes = [long]$path.Length
        sha256 = Get-FileSha256 $path.FullName
    }
}
Write-Output "Learning sleep/wake captures indexed: $($captureFiles.Count)"
$captureNames = @($captureFiles | ForEach-Object { $_.name })
$expectedCaptures = @("active-learning.png", "sleep-menu.png", "sleeping.png", "wake-menu.png", "wake-up.png")
$capturesComplete = @($expectedCaptures | Where-Object { $_ -notin $captureNames }).Count -eq 0
$distinctCaptureHashes = @($captureFiles | ForEach-Object { $_.sha256 } | Sort-Object -Unique).Count
$stateContractPassed = (
    $null -ne $before -and
    $null -ne $afterSleep -and
    $null -ne $afterWake -and
    $afterSleep.sessionId -eq $before.sessionId -and
    $afterSleep.currentItemId -eq $before.currentItemId -and
    $afterWake.sessionId -eq $before.sessionId -and
    $afterWake.currentItemId -eq $before.currentItemId -and
    $afterSleep.status -eq "paused" -and
    $afterWake.status -eq "paused" -and
    $afterSleep.pauseReason -eq "preempted_high_priority" -and
    $afterWake.pauseReason -eq "preempted_high_priority" -and
    $afterSleep.stateRevision -eq ($before.stateRevision + 1) -and
    $afterWake.stateRevision -eq $afterSleep.stateRevision -and
    $afterSleep.questionAttemptCount -eq 0 -and
    $afterWake.questionAttemptCount -eq 0 -and
    $afterSleep.reviewLogCount -eq 0 -and
    $afterWake.reviewLogCount -eq 0
)
$ready = (
    $null -eq $failure -and
    $sleepMenuFound -and
    $wakeMenuFound -and
    $sleepStatusFound -and
    $wakeStatusFound -and
    $blackboardYielded -and
    $blackboardStayedClosed -and
    $stateContractPassed -and
    $capturesComplete -and
    $distinctCaptureHashes -ge 3 -and
    $controlledExit -and
    $rootRemoved
)
Write-Output "Learning sleep/wake state evaluated: contract=$stateContractPassed ready=$ready"

$report = [ordered]@{
    schemaVersion = 1
    generatedAt = [DateTimeOffset]::UtcNow.ToString("o")
    profile = "learning-sleep-wake"
    source = [ordered]@{
        branch = (& git -C $projectRoot branch --show-current).Trim()
        commit = (& git -C $projectRoot rev-parse HEAD).Trim()
        dirty = $null -ne (& git -C $projectRoot status --porcelain)
    }
    bindings = [ordered]@{
        applicationSha256 = Get-FileSha256 $appPath
        fixtureExecutableSha256 = Get-FileSha256 $fixturePath
        fixtureContentSha256 = $plan.contentSha256
        fixtureDatabaseSha256 = $plan.databaseSha256
        scriptSha256 = Get-FileSha256 $PSCommandPath
    }
    device = [ordered]@{
        windowsProductName = (Get-ItemProperty "HKLM:\SOFTWARE\Microsoft\Windows NT\CurrentVersion").ProductName
        windowsDisplayVersion = (Get-ItemProperty "HKLM:\SOFTWARE\Microsoft\Windows NT\CurrentVersion").DisplayVersion
        windowsBuild = (Get-ItemProperty "HKLM:\SOFTWARE\Microsoft\Windows NT\CurrentVersion").CurrentBuildNumber
        processorArchitecture = $env:PROCESSOR_ARCHITECTURE
        logicalProcessors = [int]$env:NUMBER_OF_PROCESSORS
        webView2RuntimeVersion = $webView2Version
    }
    request = [ordered]@{
        exitAfterSeconds = $ExitAfterSeconds
        cardCount = $fixtureCardCount
    }
    timestamps = [ordered]@{
        startedAt = $startedAt.ToString("o")
        sleepInvokedAt = if ($null -ne $sleepInvokedAt) { $sleepInvokedAt.ToString("o") } else { $null }
        wakeInvokedAt = if ($null -ne $wakeInvokedAt) { $wakeInvokedAt.ToString("o") } else { $null }
    }
    observations = [ordered]@{
        sleepMenuFound = $sleepMenuFound
        wakeMenuFound = $wakeMenuFound
        sleepStatusFound = $sleepStatusFound
        wakeStatusFound = $wakeStatusFound
        blackboardYielded = $blackboardYielded
        blackboardStayedClosedAfterWake = $blackboardStayedClosed
        stateContractPassed = $stateContractPassed
        controlledExit = $controlledExit
        exitCode = $exitCode
        rootRemoved = $rootRemoved
        sleepMenuOpenMode = $sleepMenuOpenMode
        wakeMenuOpenMode = $wakeMenuOpenMode
        sleepMenuAccessibleNames = $sleepMenuAccessibleNames
        wakeMenuAccessibleNames = $wakeMenuAccessibleNames
        sleepMenuWindowDetails = $sleepMenuWindowDetails
        sleepMenuCommand = $sleepMenuCommand
        wakeMenuCommand = $wakeMenuCommand
        controlStatus = $controlStatus
    }
    state = [ordered]@{
        before = Convert-LearningStateForReport $before
        afterSleep = Convert-LearningStateForReport $afterSleep
        afterWake = Convert-LearningStateForReport $afterWake
        petAfterSleep = $afterSleepPetActivity
        petAfterWake = $afterWakePetActivity
    }
    captures = $captureFiles
    ready = $ready
    limitations = @(
        "The application and fixture are an isolated learning runtime-QA build, not a signed production candidate.",
        "The five cards are synthetic and contain no personal learning material.",
        "The real pet context menu, Tauri command path, presentation arbiter, SQLite pause transition, React replacement, and Windows accessibility tree are included.",
        "The native menu is opened and inspected, then its shared pet-sleep handler is invoked through an exact runtime-QA control trigger because this environment blocks physical pointer and system-input injection; physical right-click and OS-level menu selection remain manual checks.",
        "PrintWindow captures are restricted to isolated application-owned windows and do not capture the desktop.",
        "This report does not replace a human Narrator, reduced-motion, multi-DPI, locked-break authentication, or signed-candidate review."
    )
    failure = $failure
}
Write-Output "Learning sleep/wake report object created"
$serializedFields = @()
foreach ($reportKey in $report.Keys) {
    $serializedValue = if ($null -eq $report[$reportKey]) {
        "null"
    } else {
        ConvertTo-Json -InputObject $report[$reportKey] -Depth 6 -Compress
    }
    $serializedFields += ('  "' + $reportKey + '": ' + $serializedValue)
}
$reportJson = "{`r`n" + ($serializedFields -join ",`r`n") + "`r`n}"

[System.IO.File]::WriteAllText(
    $reportPath,
    $reportJson,
    [System.Text.UTF8Encoding]::new($true)
)
Write-Output "Learning sleep/wake report written: $reportPath"
Write-Output "Ready=$ready Menu=$sleepMenuFound/$wakeMenuFound Status=$sleepStatusFound/$wakeStatusFound RootRemoved=$rootRemoved"
if (-not $ready) { exit 1 }
