param(
    [Parameter(Mandatory = $true)]
    [string]$ReleaseRoot,
    [Parameter(Mandatory = $true)]
    [string]$OutputRoot,
    [Parameter(Mandatory = $true)]
    [string]$WebView2RuntimeRoot
)

$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"

$projectRoot = Split-Path -Parent $PSScriptRoot
$sourceReleaseRoot = [IO.Path]::GetFullPath($ReleaseRoot)
$releaseRoot = "C:\YuanyuanCandidate"
$outputRoot = [IO.Path]::GetFullPath($OutputRoot)
$webView2RuntimeRoot = [IO.Path]::GetFullPath($WebView2RuntimeRoot)
$statusPath = Join-Path $outputRoot "sandbox-data-probe-status.json"
$completePath = Join-Path $outputRoot "sandbox-data-probe.complete"
$progressPath = Join-Path $outputRoot "sandbox-data-probe-progress.log"
$payloadReport = Join-Path $releaseRoot "nsis-installed-payload.json"
$uninstallReport = Join-Path $releaseRoot "release-uninstall-data-choice-probe.json"

New-Item -ItemType Directory -Force -Path $outputRoot | Out-Null

function Write-ProbeProgress([string]$Stage) {
    $line = "{0} {1}`n" -f (Get-Date).ToUniversalTime().ToString("o"), $Stage
    [IO.File]::AppendAllText($progressPath, $line, [Text.UTF8Encoding]::new($false))
}

Write-ProbeProgress "bootstrap:start"

try {
    Write-ProbeProgress "bootstrap:uia-client:start"
    Add-Type -AssemblyName UIAutomationClient
    Write-ProbeProgress "bootstrap:uia-client:done"
    Add-Type -AssemblyName UIAutomationTypes
    Write-ProbeProgress "bootstrap:uia-types:done"
    Add-Type -AssemblyName System.Windows.Forms
    Write-ProbeProgress "bootstrap:windows-forms:done"

    if (-not ("YuanyuanInstalledE2EWindowProbe" -as [type])) {
        Write-ProbeProgress "bootstrap:window-probe:start"
        Add-Type -TypeDefinition @"
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;

public static class YuanyuanInstalledE2EWindowProbe {
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
    private static extern IntPtr GetAncestor(IntPtr hWnd, uint flags);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)]
    private static extern int GetClassName(IntPtr hWnd, StringBuilder value, int maxCount);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)]
    private static extern int GetWindowText(IntPtr hWnd, StringBuilder value, int maxCount);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)]
    private static extern int GetMenuString(IntPtr hMenu, uint item, StringBuilder value, int maxCount, uint flags);
    [DllImport("user32.dll")]
    private static extern int GetMenuItemCount(IntPtr hMenu);
    [DllImport("user32.dll")]
    private static extern bool GetMenuItemRect(IntPtr hWnd, IntPtr hMenu, uint item, out Rect rect);
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

    public static string WindowClass(IntPtr hWnd) {
        var value = new StringBuilder(256);
        GetClassName(hWnd, value, value.Capacity);
        return value.ToString();
    }

    public static string WindowTitle(IntPtr hWnd) {
        var value = new StringBuilder(512);
        GetWindowText(hWnd, value, value.Capacity);
        return value.ToString();
    }

    public static IntPtr RootWindow(IntPtr hWnd) {
        var root = GetAncestor(hWnd, 2);
        return root == IntPtr.Zero ? hWnd : root;
    }

    private static IntPtr PopupMenuHandle(IntPtr menuWindow) {
        return SendMessage(menuWindow, 0x01E1, IntPtr.Zero, IntPtr.Zero);
    }

    public static string[] PopupMenuItems(IntPtr menuWindow) {
        var menu = PopupMenuHandle(menuWindow);
        var items = new List<string>();
        if (menu == IntPtr.Zero) return items.ToArray();
        var count = GetMenuItemCount(menu);
        for (uint index = 0; index < count; index++) {
            var value = new StringBuilder(512);
            GetMenuString(menu, index, value, value.Capacity, 0x00000400);
            items.Add(value.ToString());
        }
        return items.ToArray();
    }

    public static bool ClickPopupMenuItem(IntPtr menuWindow, string expected) {
        var menu = PopupMenuHandle(menuWindow);
        if (menu == IntPtr.Zero) return false;
        var count = GetMenuItemCount(menu);
        for (uint index = 0; index < count; index++) {
            var value = new StringBuilder(512);
            GetMenuString(menu, index, value, value.Capacity, 0x00000400);
            if (!String.Equals(value.ToString().Replace("&", ""), expected, StringComparison.Ordinal)) {
                continue;
            }
            Rect rect;
            if (!GetMenuItemRect(IntPtr.Zero, menu, index, out rect)) return false;
            LeftClick((rect.Left + rect.Right) / 2, (rect.Top + rect.Bottom) / 2);
            return true;
        }
        return false;
    }

    private static void Click(int x, int y, uint down, uint up) {
        SetCursorPos(x, y);
        mouse_event(down, 0, 0, 0, UIntPtr.Zero);
        mouse_event(up, 0, 0, 0, UIntPtr.Zero);
    }

    public static void RightClick(int x, int y) { Click(x, y, 0x0008, 0x0010); }
    public static void LeftClick(int x, int y) { Click(x, y, 0x0002, 0x0004); }

    public static void ScrollDown(int x, int y, int notches) {
        SetCursorPos(x, y);
        for (var index = 0; index < notches; index++) {
            mouse_event(0x0800, 0, 0, unchecked((uint)-120), UIntPtr.Zero);
            Thread.Sleep(15);
        }
    }

    public static void Drag(int startX, int startY, int endX, int endY) {
        SetCursorPos(startX, startY);
        mouse_event(0x0002, 0, 0, 0, UIntPtr.Zero);
        for (int step = 1; step <= 12; step++) {
            var x = startX + ((endX - startX) * step / 12);
            var y = startY + ((endY - startY) * step / 12);
            SetCursorPos(x, y);
            Thread.Sleep(25);
        }
        mouse_event(0x0004, 0, 0, 0, UIntPtr.Zero);
    }
}
"@
        Write-ProbeProgress "bootstrap:window-probe:done"
    }
}
catch {
    $bootstrapStatus = [ordered]@{
        schemaVersion = 1
        generatedAt = (Get-Date).ToUniversalTime().ToString("o")
        profile = "community-stable-installed-e2e"
        sandboxUser = [Environment]::UserName
        ready = $false
        failure = "bootstrap: $([string]$_.Exception.Message)"
    }
    $bootstrapStatus | ConvertTo-Json -Depth 4 |
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

function Get-AppAccessibleNodes([int]$ProcessId) {
    $nodes = [System.Collections.Generic.List[object]]::new()
    foreach ($handle in @([YuanyuanInstalledE2EWindowProbe]::VisibleWindows($ProcessId))) {
        try {
            $root = [System.Windows.Automation.AutomationElement]::FromHandle($handle)
            [void]$nodes.Add($root)
            foreach ($node in @($root.FindAll(
                [System.Windows.Automation.TreeScope]::Descendants,
                [System.Windows.Automation.Condition]::TrueCondition
            ))) {
                [void]$nodes.Add($node)
            }
        }
        catch {}
    }
    @($nodes)
}

function Find-AppElement(
    [int]$ProcessId,
    [string]$Name,
    [bool]$Exact = $true,
    [bool]$ButtonOnly = $false
) {
    foreach ($node in @(Get-AppAccessibleNodes $ProcessId)) {
        try {
            $currentName = [string]$node.Current.Name
            $matches = if ($Exact) { $currentName -eq $Name } else { $currentName.Contains($Name) }
            if (-not $matches -or -not $node.Current.IsEnabled) { continue }
            if (
                $ButtonOnly -and
                $node.Current.ControlType -ne [System.Windows.Automation.ControlType]::Button
            ) { continue }
            return $node
        }
        catch {}
    }
    $null
}

function Find-PetElement([int]$ProcessId) {
    $matches = [System.Collections.Generic.List[object]]::new()
    foreach ($handle in @([YuanyuanInstalledE2EWindowProbe]::VisibleWindows($ProcessId))) {
        try {
            if ([YuanyuanInstalledE2EWindowProbe]::WindowClass($handle) -eq "#32768") {
                continue
            }
            $node = [System.Windows.Automation.AutomationElement]::FromHandle($handle)
            $bounds = $node.Current.BoundingRectangle
            # The pet is the only compact top-level Tauri surface. Panel and
            # learning windows are deliberately larger; native popup menus are
            # excluded above. This locator stays stable while the pet's
            # accessible name changes with its semantic scene.
            if ($bounds.Width -lt 20 -or $bounds.Height -lt 20) { continue }
            [void]$matches.Add([pscustomobject]@{
                element = $node
                titlePriority = if (
                    [YuanyuanInstalledE2EWindowProbe]::WindowTitle($handle) -eq "圆圆"
                ) { 0 } else { 1 }
                area = [double]$bounds.Width * [double]$bounds.Height
            })
        }
        catch {}
    }
    $candidate = $matches | Sort-Object titlePriority, area | Select-Object -First 1
    if ($null -eq $candidate) { return $null }
    $candidate.element
}

function Wait-PetElement(
    [System.Diagnostics.Process]$Process,
    [int]$TimeoutSeconds = 20
) {
    $deadline = [DateTime]::UtcNow.AddSeconds($TimeoutSeconds)
    while ([DateTime]::UtcNow -lt $deadline) {
        $Process.Refresh()
        if ($Process.HasExited) { throw "candidate exited before pet UI appeared" }
        $element = Find-PetElement $Process.Id
        if ($null -ne $element) { return $element }
        Start-Sleep -Milliseconds 100
    }
    throw "candidate pet UI element did not appear"
}

function Find-PetSemanticElement([int]$ProcessId) {
    foreach ($node in @(Get-AppAccessibleNodes $ProcessId)) {
        try {
            $currentName = [string]$node.Current.Name
            $isPetAccessibleName =
                $currentName -eq "圆圆桌面宠物" -or
                $currentName -match "^(圆圆(?:起身|正在|伸了|退到|听见|把|穿好|发现|暂时|叼来|在一旁|精神|工作|显得)|专注结束，圆圆|任务运行较久，圆圆)"
            if ($isPetAccessibleName -and $node.Current.IsEnabled) { return $node }
        }
        catch {}
    }
    $null
}

function Wait-PetFrontendReady(
    [System.Diagnostics.Process]$Process,
    [int]$TimeoutSeconds = 20
) {
    $deadline = [DateTime]::UtcNow.AddSeconds($TimeoutSeconds)
    while ([DateTime]::UtcNow -lt $deadline) {
        $Process.Refresh()
        if ($Process.HasExited) { throw "candidate exited before pet frontend became ready" }
        $element = Find-PetSemanticElement $Process.Id
        if ($null -ne $element) { return $element }
        Start-Sleep -Milliseconds 100
    }
    throw "candidate pet frontend did not become ready"
}

function Wait-AppElement(
    [System.Diagnostics.Process]$Process,
    [string]$Name,
    [bool]$Exact = $true,
    [bool]$ButtonOnly = $false,
    [int]$TimeoutSeconds = 20
) {
    $deadline = [DateTime]::UtcNow.AddSeconds($TimeoutSeconds)
    while ([DateTime]::UtcNow -lt $deadline) {
        $Process.Refresh()
        if ($Process.HasExited) { throw "candidate exited before UI element appeared: $Name" }
        $element = Find-AppElement $Process.Id $Name $Exact $ButtonOnly
        if ($null -ne $element) { return $element }
        Start-Sleep -Milliseconds 100
    }
    throw "candidate UI element did not appear: $Name"
}

function Wait-VisibleAppElement(
    [System.Diagnostics.Process]$Process,
    [string]$Name,
    [int]$TimeoutSeconds = 20
) {
    $deadline = [DateTime]::UtcNow.AddSeconds($TimeoutSeconds)
    while ([DateTime]::UtcNow -lt $deadline) {
        $Process.Refresh()
        if ($Process.HasExited) { throw "candidate exited before visible UI element appeared: $Name" }
        $element = Find-AppElement $Process.Id $Name $true $true
        if ($null -ne $element) {
            try {
                $bounds = $element.Current.BoundingRectangle
                if (-not $element.Current.IsOffscreen -and $bounds.Width -gt 0 -and $bounds.Height -gt 0) {
                    return $element
                }
            }
            catch {}
        }
        Start-Sleep -Milliseconds 100
    }
    throw "candidate visible UI element did not appear: $Name"
}

function Get-ElementWindowHandle([System.Windows.Automation.AutomationElement]$Element) {
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
    [IntPtr]::Zero
}

function Click-AccessibleElement([System.Windows.Automation.AutomationElement]$Element) {
    $scrollPattern = $null
    if ($Element.TryGetCurrentPattern(
        [System.Windows.Automation.ScrollItemPattern]::Pattern,
        [ref]$scrollPattern
    )) {
        ([System.Windows.Automation.ScrollItemPattern]$scrollPattern).ScrollIntoView()
    }
    try { $Element.SetFocus() } catch {}
    Start-Sleep -Milliseconds 300
    $bounds = $Element.Current.BoundingRectangle
    if ($bounds.Width -le 0 -or $bounds.Height -le 0) { throw "UI element has no clickable bounds" }
    if ($Element.Current.IsOffscreen) { throw "UI element remained offscreen after scrolling" }
    $handle = Get-ElementWindowHandle $Element
    if ($handle -ne [IntPtr]::Zero) {
        [void][YuanyuanInstalledE2EWindowProbe]::SetForegroundWindow(
            [YuanyuanInstalledE2EWindowProbe]::RootWindow($handle)
        )
    }
    [YuanyuanInstalledE2EWindowProbe]::LeftClick(
        [int]($bounds.X + ($bounds.Width / 2)),
        [int]($bounds.Y + ($bounds.Height / 2))
    )
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
    Click-AccessibleElement $Element
}

function Wait-NativeMenu([System.Diagnostics.Process]$Process, [int]$TimeoutSeconds = 8) {
    $deadline = [DateTime]::UtcNow.AddSeconds($TimeoutSeconds)
    while ([DateTime]::UtcNow -lt $deadline) {
        foreach ($handle in @([YuanyuanInstalledE2EWindowProbe]::VisibleWindows($Process.Id))) {
            if ([YuanyuanInstalledE2EWindowProbe]::WindowClass($handle) -eq "#32768") {
                return $handle
            }
        }
        Start-Sleep -Milliseconds 50
    }
    throw "candidate native pet menu did not appear"
}

function Invoke-PetMenuItem(
    [System.Diagnostics.Process]$Process,
    [string]$Name,
    [IntPtr]$PetWindowHandle = [IntPtr]::Zero
) {
    [void](Wait-PetFrontendReady $Process 20)
    $pet = if ($PetWindowHandle -eq [IntPtr]::Zero) {
        Wait-PetElement $Process 20
    }
    else {
        [System.Windows.Automation.AutomationElement]::FromHandle($PetWindowHandle)
    }
    $bounds = $pet.Current.BoundingRectangle
    $handle = Get-ElementWindowHandle $pet
    $windowDiagnostics = @(
        foreach ($visibleHandle in @([YuanyuanInstalledE2EWindowProbe]::VisibleWindows($Process.Id))) {
            $visibleRect = New-Object YuanyuanInstalledE2EWindowProbe+Rect
            [void][YuanyuanInstalledE2EWindowProbe]::GetWindowRect(
                $visibleHandle,
                [ref]$visibleRect
            )
            [ordered]@{
                handle = [long]$visibleHandle
                title = [YuanyuanInstalledE2EWindowProbe]::WindowTitle($visibleHandle)
                class = [YuanyuanInstalledE2EWindowProbe]::WindowClass($visibleHandle)
                width = $visibleRect.Right - $visibleRect.Left
                height = $visibleRect.Bottom - $visibleRect.Top
            }
        }
    )
    Write-ProbeProgress ("pet-menu:target={0}:windows={1}" -f
        [long]$handle,
        (ConvertTo-Json @($windowDiagnostics) -Compress))
    if ($handle -eq [IntPtr]::Zero) { throw "pet element has no native window" }
    [void][YuanyuanInstalledE2EWindowProbe]::SetForegroundWindow(
        [YuanyuanInstalledE2EWindowProbe]::RootWindow($handle)
    )
    Start-Sleep -Milliseconds 250
    $menuHandle = [IntPtr]::Zero
    $targets = @(
        @(0.50, 0.50),
        @(0.50, 0.65),
        @(0.50, 0.35)
    )
    for ($attempt = 0; $attempt -lt $targets.Count; $attempt += 1) {
        $target = $targets[$attempt]
        [YuanyuanInstalledE2EWindowProbe]::RightClick(
            [int]($bounds.X + ($bounds.Width * $target[0])),
            [int]($bounds.Y + ($bounds.Height * $target[1]))
        )
        try {
            $menuHandle = Wait-NativeMenu $Process 3
            break
        }
        catch {
            if ($attempt -eq $targets.Count - 1) { throw }
            Start-Sleep -Milliseconds 300
        }
    }
    if (-not [YuanyuanInstalledE2EWindowProbe]::ClickPopupMenuItem($menuHandle, $Name)) {
        $available = [YuanyuanInstalledE2EWindowProbe]::PopupMenuItems($menuHandle) -join " | "
        throw "candidate native pet menu item is missing: $Name; available: $available"
    }
    $handle
}

function Get-WindowRectRecord([IntPtr]$Handle) {
    $rect = New-Object YuanyuanInstalledE2EWindowProbe+Rect
    if (-not [YuanyuanInstalledE2EWindowProbe]::GetWindowRect($Handle, [ref]$rect)) {
        throw "candidate window rectangle is unavailable"
    }
    [ordered]@{
        left = $rect.Left
        top = $rect.Top
        right = $rect.Right
        bottom = $rect.Bottom
    }
}

function Invoke-PanelDrag([System.Diagnostics.Process]$Process) {
    $header = Wait-AppElement $Process "拖动功能框" $true $false 15
    $handle = Get-ElementWindowHandle $header
    if ($handle -eq [IntPtr]::Zero) { throw "panel drag handle has no native window" }
    $before = Get-WindowRectRecord $handle
    $bounds = $header.Current.BoundingRectangle
    [void][YuanyuanInstalledE2EWindowProbe]::SetForegroundWindow(
        [YuanyuanInstalledE2EWindowProbe]::RootWindow($handle)
    )
    [YuanyuanInstalledE2EWindowProbe]::Drag(
        [int]($bounds.X + 70),
        [int]($bounds.Y + 24),
        [int]($bounds.X + 150),
        [int]($bounds.Y + 84)
    )
    Start-Sleep -Milliseconds 500
    $after = Get-WindowRectRecord $handle
    $moved = [Math]::Abs($after.left - $before.left) -ge 40 -and
        [Math]::Abs($after.top - $before.top) -ge 30
    if (-not $moved) { throw "installed panel did not move after a real header drag" }
    [ordered]@{ before = $before; after = $after; moved = $moved }
}

function Wait-PetHidden(
    [System.Diagnostics.Process]$Process,
    [IntPtr]$PetWindowHandle,
    [int]$TimeoutSeconds = 10
) {
    $deadline = [DateTime]::UtcNow.AddSeconds($TimeoutSeconds)
    while ([DateTime]::UtcNow -lt $deadline) {
        $visibleHandles = @([YuanyuanInstalledE2EWindowProbe]::VisibleWindows($Process.Id))
        if ($PetWindowHandle -notin $visibleHandles) {
            return $true
        }
        Start-Sleep -Milliseconds 100
    }
    $false
}

function Wait-PetVisible(
    [System.Diagnostics.Process]$Process,
    [IntPtr]$PetWindowHandle,
    [int]$TimeoutSeconds = 10
) {
    $deadline = [DateTime]::UtcNow.AddSeconds($TimeoutSeconds)
    while ([DateTime]::UtcNow -lt $deadline) {
        $visibleHandles = @([YuanyuanInstalledE2EWindowProbe]::VisibleWindows($Process.Id))
        if ($PetWindowHandle -in $visibleHandles) {
            return [System.Windows.Automation.AutomationElement]::FromHandle($PetWindowHandle)
        }
        Start-Sleep -Milliseconds 100
    }
    throw "candidate pet window did not become visible"
}

function Find-ManualBackupRestoreButton([System.Diagnostics.Process]$Process) {
    $manual = Wait-AppElement $Process "手动备份" $true $false 20
    $walker = [System.Windows.Automation.TreeWalker]::RawViewWalker
    $ancestor = $manual
    for ($level = 0; $level -lt 5 -and $null -ne $ancestor; $level += 1) {
        $condition = New-Object System.Windows.Automation.PropertyCondition(
            [System.Windows.Automation.AutomationElement]::NameProperty,
            "恢复"
        )
        $button = $ancestor.FindFirst(
            [System.Windows.Automation.TreeScope]::Descendants,
            $condition
        )
        if (
            $null -ne $button -and
            $button.Current.ControlType -eq [System.Windows.Automation.ControlType]::Button
        ) { return $button }
        $ancestor = $walker.GetParent($ancestor)
    }
    throw "manual backup restore button was not found"
}

function Confirm-CandidateDialog([System.Diagnostics.Process]$Process) {
    $deadline = [DateTime]::UtcNow.AddSeconds(8)
    while ([DateTime]::UtcNow -lt $deadline) {
        foreach ($name in @("确定", "是", "OK")) {
            $condition = New-Object System.Windows.Automation.PropertyCondition(
                [System.Windows.Automation.AutomationElement]::NameProperty,
                $name
            )
            $matches = [System.Windows.Automation.AutomationElement]::RootElement.FindAll(
                [System.Windows.Automation.TreeScope]::Descendants,
                $condition
            )
            foreach ($match in @($matches)) {
                try {
                    if (
                        $match.Current.IsEnabled -and
                        $match.Current.ControlType -eq [System.Windows.Automation.ControlType]::Button
                    ) {
                        Invoke-AccessibleElement $match
                        return $true
                    }
                }
                catch {}
            }
        }
        Start-Sleep -Milliseconds 100
    }
    [System.Windows.Forms.SendKeys]::SendWait("{ENTER}")
    Start-Sleep -Milliseconds 250
    return $true
}

function Start-InstalledCandidate([string]$ApplicationPath, [string]$WebViewRoot) {
    $existed = Test-Path Env:WEBVIEW2_BROWSER_EXECUTABLE_FOLDER
    $oldValue = $env:WEBVIEW2_BROWSER_EXECUTABLE_FOLDER
    try {
        $env:WEBVIEW2_BROWSER_EXECUTABLE_FOLDER = $WebViewRoot
        Start-Process -FilePath $ApplicationPath -PassThru -WindowStyle Normal
    }
    finally {
        if ($existed) { $env:WEBVIEW2_BROWSER_EXECUTABLE_FOLDER = $oldValue }
        else { Remove-Item Env:WEBVIEW2_BROWSER_EXECUTABLE_FOLDER -ErrorAction SilentlyContinue }
    }
}

function Stop-CandidateFromSettings([System.Diagnostics.Process]$Process) {
    $quit = Find-AppElement $Process.Id "完全退出" $true $true
    if ($null -eq $quit) {
        Invoke-PetMenuItem $Process "设置"
        [void](Wait-AppElement $Process "设置" $true $false 20)
        $quit = Wait-AppElement $Process "完全退出" $true $true 20
    }
    $settingsHandle = Get-ElementWindowHandle $quit
    if ($settingsHandle -eq [IntPtr]::Zero) { throw "settings quit control has no native window" }
    $settingsRect = Get-WindowRectRecord $settingsHandle
    [void][YuanyuanInstalledE2EWindowProbe]::SetForegroundWindow(
        [YuanyuanInstalledE2EWindowProbe]::RootWindow($settingsHandle)
    )
    [YuanyuanInstalledE2EWindowProbe]::ScrollDown(
        [int](($settingsRect.left + $settingsRect.right) / 2),
        [int]($settingsRect.top + (($settingsRect.bottom - $settingsRect.top) * 0.65)),
        48
    )
    $quit = Wait-VisibleAppElement $Process "完全退出" 20
    Click-AccessibleElement $quit
    if (-not $Process.WaitForExit(15000)) {
        throw "candidate did not exit through the settings command"
    }
}

$status = [ordered]@{
    schemaVersion = 1
    generatedAt = $null
    profile = "community-stable-installed-e2e"
    sandboxUser = [Environment]::UserName
    interactiveSession = [Environment]::UserInteractive
    syntheticDataOnly = $true
    candidateUsesEmbeddedOnlineWebView2Bootstrapper = $true
    mappedMicrosoftWebView2RuntimeVerified = $false
    mappedMicrosoftWebView2RuntimeSha256 = $null
    temporaryWebView2DetectionRegistration = $false
    candidateCopiedToSandboxDisk = $false
    payloadInspectionPassed = $false
    uninstallDataChoicePassed = $false
    functional = $null
    reportsCopied = $false
    failureDiagnostics = $null
    source = $null
    sourceMetadataSha256 = $null
    probeScriptSha256 = $null
    hostScriptSha256 = $null
    ready = $false
    failure = $null
}
Write-ProbeProgress "status:initialized"

try {
    Write-ProbeProgress "preflight:start"
    if ($status.sandboxUser -ne "WDAGUtilityAccount") {
        throw "probe must run inside Windows Sandbox"
    }
    if (-not $status.interactiveSession) {
        throw "Windows Sandbox session is not interactive"
    }
    $sourceMetadataPath = Join-Path $outputRoot "source-metadata.json"
    $sourceMetadata = Get-Content -Raw -Encoding UTF8 -LiteralPath $sourceMetadataPath |
        ConvertFrom-Json
    if (
        $sourceMetadata.schemaVersion -ne 1 -or
        [string]::IsNullOrWhiteSpace([string]$sourceMetadata.branch) -or
        [string]$sourceMetadata.commit -notmatch "^[0-9a-f]{40}$" -or
        $sourceMetadata.dirty -isnot [bool]
    ) {
        throw "host source metadata is invalid"
    }
    $status.source = $sourceMetadata
    $status.sourceMetadataSha256 = (
        Get-FileHash -Algorithm SHA256 -LiteralPath $sourceMetadataPath
    ).Hash
    $status.probeScriptSha256 = (
        Get-FileHash -Algorithm SHA256 -LiteralPath (
            Join-Path $projectRoot "scripts\run_community_stable_sandbox_data_probe.ps1"
        )
    ).Hash
    $status.hostScriptSha256 = (
        Get-FileHash -Algorithm SHA256 -LiteralPath (
            Join-Path $projectRoot "scripts\run_community_stable_sandbox_data_probe_host.ps1"
        )
    ).Hash
    $webView2Executable = Join-Path $webView2RuntimeRoot "msedgewebview2.exe"
    if (-not (Test-Path -LiteralPath $webView2Executable -PathType Leaf)) {
        throw "mapped WebView2 runtime executable is missing"
    }
    $webView2Signature = Get-AuthenticodeSignature -LiteralPath $webView2Executable
    if (
        $webView2Signature.Status -ne "Valid" -or
        $null -eq $webView2Signature.SignerCertificate -or
        $webView2Signature.SignerCertificate.Subject -notlike "*O=Microsoft Corporation*"
    ) {
        throw "mapped WebView2 runtime is not validly signed by Microsoft"
    }
    $webView2Version = [string](Get-Item -LiteralPath $webView2Executable).VersionInfo.ProductVersion
    if ([string]::IsNullOrWhiteSpace($webView2Version)) {
        throw "mapped WebView2 runtime version is unavailable"
    }
    $status.mappedMicrosoftWebView2RuntimeVerified = $true
    $status.mappedMicrosoftWebView2RuntimeSha256 = (
        Get-FileHash -Algorithm SHA256 -LiteralPath $webView2Executable
    ).Hash
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
    $status.temporaryWebView2DetectionRegistration = $true
    Write-ProbeProgress "preflight:webview2-ready"

    if (Test-Path -LiteralPath $releaseRoot) {
        throw "Sandbox candidate staging directory already exists"
    }
    New-Item -ItemType Directory -Path (Join-Path $releaseRoot "bundle\nsis") -Force |
        Out-Null
    Copy-Item -LiteralPath (Join-Path $sourceReleaseRoot "yuanyuan-reminder.exe") `
        -Destination (Join-Path $releaseRoot "yuanyuan-reminder.exe")
    Copy-Item -Path (Join-Path $sourceReleaseRoot "bundle\nsis\*.exe") `
        -Destination (Join-Path $releaseRoot "bundle\nsis")
    $status.candidateCopiedToSandboxDisk = $true
    Write-ProbeProgress "candidate:copied"

    Write-ProbeProgress "payload-inspection:start"
    $payloadLog = Join-Path $outputRoot "nsis-payload.log"
    & powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass `
        -File (Join-Path $projectRoot "scripts\inspect_nsis_payload.ps1") `
        -ReleaseRoot $releaseRoot *>&1 |
        Set-Content -Encoding UTF8 -LiteralPath $payloadLog
    if ($LASTEXITCODE -ne 0) {
        throw "NSIS installed-payload inspection failed"
    }
    $payload = Get-Content -Raw -Encoding UTF8 -LiteralPath $payloadReport |
        ConvertFrom-Json
    if (-not $payload.ready) {
        throw "NSIS installed-payload report is not ready"
    }
    $status.payloadInspectionPassed = $true
    Write-ProbeProgress "payload-inspection:passed"

    Write-ProbeProgress "uninstall-choice:start"
    $uninstallLog = Join-Path $outputRoot "uninstall-data-choice.log"
    & powershell.exe -NoProfile -ExecutionPolicy Bypass `
        -File (Join-Path $projectRoot "scripts\probe_release_uninstall_data_choice.ps1") `
        -ReleaseRoot $releaseRoot *>&1 |
        Set-Content -Encoding UTF8 -LiteralPath $uninstallLog
    if ($LASTEXITCODE -ne 0) {
        throw "NSIS uninstall data-choice probe failed"
    }
    $uninstall = Get-Content -Raw -Encoding UTF8 -LiteralPath $uninstallReport |
        ConvertFrom-Json
    if (-not $uninstall.ready) {
        throw "NSIS uninstall data-choice report is not ready"
    }
    $status.uninstallDataChoicePassed = $true
    Write-ProbeProgress "uninstall-choice:passed"

    $package = Get-Content -Raw -Encoding UTF8 -LiteralPath (
        Join-Path $projectRoot "package.json"
    ) | ConvertFrom-Json
    $tauriConfig = Get-Content -Raw -Encoding UTF8 -LiteralPath (
        Join-Path $projectRoot "src-tauri\tauri.conf.json"
    ) | ConvertFrom-Json
    $candidateInstaller = @(
        Get-ChildItem -LiteralPath (Join-Path $releaseRoot "bundle\nsis") -File |
            Where-Object Name -Like ("*_{0}_x64-setup.exe" -f [string]$package.version)
    )
    if ($candidateInstaller.Count -ne 1) {
        throw "functional E2E requires exactly one version-matched installer"
    }
    $sourceHelperPath = Join-Path `
        $projectRoot `
        "src-tauri\target\release\yuanyuan-installed-candidate-qa.exe"
    if (-not (Test-Path -LiteralPath $sourceHelperPath -PathType Leaf)) {
        throw "installed-candidate QA helper is missing"
    }
    $helperRoot = Join-Path $releaseRoot "qa"
    New-Item -ItemType Directory -Path $helperRoot -Force | Out-Null
    $helperPath = Join-Path $helperRoot "yuanyuan-installed-candidate-qa.exe"
    Copy-Item -LiteralPath $sourceHelperPath -Destination $helperPath
    $localAppData = [Environment]::GetFolderPath("LocalApplicationData")
    $roamingAppData = [Environment]::GetFolderPath("ApplicationData")
    $installRoot = Join-Path $localAppData ([string]$tauriConfig.productName)
    $dataRoot = Join-Path $localAppData ([string]$tauriConfig.identifier)
    $roamingDataRoot = Join-Path $roamingAppData ([string]$tauriConfig.identifier)
    $applicationPath = Join-Path $installRoot "yuanyuan-reminder.exe"
    $uninstallerPath = Join-Path $installRoot "uninstall.exe"
    $uninstallKey = "Registry::HKEY_CURRENT_USER\Software\Microsoft\Windows\CurrentVersion\Uninstall\$($tauriConfig.productName)"
    $productKey = "Registry::HKEY_CURRENT_USER\Software\yuanyuan\$($tauriConfig.productName)"
    $desktopShortcut = Join-Path ([Environment]::GetFolderPath("Desktop")) "$($tauriConfig.productName).lnk"
    $programsShortcut = Join-Path ([Environment]::GetFolderPath("Programs")) "$($tauriConfig.productName).lnk"
    foreach ($path in @($installRoot, $dataRoot, $roamingDataRoot)) {
        if (Test-Path -LiteralPath $path) {
            throw "functional E2E boundary was not clean after uninstall-choice probe"
        }
    }

    $functional = [ordered]@{
        installerSha256 = (
            Get-FileHash -Algorithm SHA256 -LiteralPath $candidateInstaller[0].FullName
        ).Hash
        installedCoreSha256 = $null
        helperSha256 = (Get-FileHash -Algorithm SHA256 -LiteralPath $helperPath).Hash
        helperSeedExitCode = $null
        installExitCode = $null
        scenarios = [ordered]@{
            installAndLaunch = $false
            reminderDelivery = $false
            hideAndRestorePet = $false
            panelDrag = $false
            backupAndRestore = $false
            restartPersistence = $false
            uninstallKeepsDataByDefault = $false
        }
        reminder = $null
        mutation = $null
        panelDragEvidence = $null
        formalUserDataUsed = $false
        cleanup = [ordered]@{
            applicationExited = $false
            installRootRemoved = $false
            dataRootRemoved = $false
            roamingDataRootAbsent = $false
            uninstallRegistrationRemoved = $false
            productRegistrationPersistedAfterUninstall = $false
            ownedProductRegistrationRemoved = $false
            shortcutsRemoved = $false
            sandboxShutdownRequested = $false
        }
    }
    $status.functional = $functional

    $candidateProcess = $null
    try {
        Write-ProbeProgress "functional:install:start"
        $installProcess = Start-Process `
            -FilePath $candidateInstaller[0].FullName `
            -ArgumentList "/S" `
            -Wait `
            -PassThru `
            -WindowStyle Hidden
        $functional.installExitCode = $installProcess.ExitCode
        if (
            $installProcess.ExitCode -ne 0 -or
            -not (Test-Path -LiteralPath $applicationPath -PathType Leaf) -or
            -not (Test-Path -LiteralPath $uninstallerPath -PathType Leaf)
        ) {
            throw "functional E2E default installation failed"
        }
        $functional.installedCoreSha256 = (
            Get-FileHash -Algorithm SHA256 -LiteralPath $applicationPath
        ).Hash
        if ($functional.installedCoreSha256 -ne $payload.bindings.installedCoreSha256) {
            throw "functional E2E installed core does not match inspected NSIS payload"
        }
        Write-ProbeProgress "functional:install:passed"

        Write-ProbeProgress "functional:seed:start"
        $seedOutput = @(& $helperPath seed `
            --data-root $dataRoot `
            --due-after-seconds 12 `
            --attest-windows-sandbox 2>&1)
        $seedExitCode = $LASTEXITCODE
        $functional.helperSeedExitCode = $seedExitCode
        $seedOutput | Set-Content -Encoding UTF8 -LiteralPath (
            Join-Path $outputRoot "installed-candidate-seed.log"
        )
        if ($seedExitCode -ne 0) {
            throw "installed-candidate reminder seed failed: $($seedOutput -join ' | ')"
        }
        $seed = $seedOutput | ConvertFrom-Json
        $functional.reminder = $seed
        Write-ProbeProgress "functional:seed:passed"

        Write-ProbeProgress "functional:first-launch:start"
        $candidateProcess = Start-InstalledCandidate $applicationPath $webView2RuntimeRoot
        [void](Wait-PetElement $candidateProcess 30)
        $functional.scenarios.installAndLaunch = $true
        [void](Wait-AppElement $candidateProcess ([string]$seed.title) $false $false 45)
        $functional.scenarios.reminderDelivery = $true
        Write-ProbeProgress "functional:reminder-delivery:passed"

        Write-ProbeProgress "functional:panel-drag:start"
        $petWindowHandle = Invoke-PetMenuItem $candidateProcess "打开今日任务"
        [void](Wait-AppElement $candidateProcess "今天" $true $false 20)
        $functional.panelDragEvidence = Invoke-PanelDrag $candidateProcess
        $functional.scenarios.panelDrag = $true
        Write-ProbeProgress "functional:panel-drag:passed"

        Write-ProbeProgress "functional:pet-hide-restore:start"
        [void](Invoke-PetMenuItem $candidateProcess "隐藏圆圆" $petWindowHandle)
        if (-not (Wait-PetHidden $candidateProcess $petWindowHandle 10)) {
            throw "pet remained visible after the installed hide command"
        }
        $restorePet = Wait-AppElement $candidateProcess "显示并叫醒圆圆" $true $true 20
        $settingsHandle = Get-ElementWindowHandle $restorePet
        if ($settingsHandle -eq [IntPtr]::Zero) {
            throw "settings restore control has no native window"
        }
        $settingsRect = Get-WindowRectRecord $settingsHandle
        [void][YuanyuanInstalledE2EWindowProbe]::SetForegroundWindow(
            [YuanyuanInstalledE2EWindowProbe]::RootWindow($settingsHandle)
        )
        [YuanyuanInstalledE2EWindowProbe]::ScrollDown(
            [int](($settingsRect.left + $settingsRect.right) / 2),
            [int]($settingsRect.top + (($settingsRect.bottom - $settingsRect.top) * 0.65)),
            48
        )
        $restorePet = Wait-VisibleAppElement $candidateProcess "显示并叫醒圆圆" 20
        Click-AccessibleElement $restorePet
        [void](Wait-AppElement $candidateProcess "圆圆已经显示并醒来了。" $false $false 20)
        [void](Wait-PetVisible $candidateProcess $petWindowHandle 20)
        $functional.scenarios.hideAndRestorePet = $true
        Write-ProbeProgress "functional:pet-hide-restore:passed"

        Write-ProbeProgress "functional:backup-create:start"
        $createBackup = Wait-AppElement $candidateProcess "立即备份" $true $true 20
        Invoke-AccessibleElement $createBackup
        [void](Wait-AppElement $candidateProcess "手动备份已创建。" $false $false 30)
        [void](Wait-AppElement $candidateProcess "手动备份" $true $false 20)
        Stop-CandidateFromSettings $candidateProcess
        $candidateProcess = $null
        Write-ProbeProgress "functional:backup-create:passed"

        $initialInspectOutput = & $helperPath inspect `
            --data-root $dataRoot `
            --reminder-ids ([string]$seed.reminderId) `
            --attest-windows-sandbox
        if ($LASTEXITCODE -ne 0) { throw "installed-candidate initial inspection failed" }
        $initialInspect = $initialInspectOutput | ConvertFrom-Json
        if (
            -not $initialInspect.databaseHealthy -or
            -not $initialInspect.records[0].present -or
            $initialInspect.records[0].occurrenceStatus -notin @("pending", "overdue")
        ) {
            throw "installed reminder was not durably claimed"
        }

        $mutationOutput = & $helperPath mutate `
            --data-root $dataRoot `
            --attest-windows-sandbox
        if ($LASTEXITCODE -ne 0) { throw "installed-candidate mutation setup failed" }
        $mutation = $mutationOutput | ConvertFrom-Json
        $functional.mutation = $mutation
        Write-ProbeProgress "functional:mutation:created"

        Write-ProbeProgress "functional:restart-persistence:start"
        $candidateProcess = Start-InstalledCandidate $applicationPath $webView2RuntimeRoot
        $petElement = Wait-PetElement $candidateProcess 30
        $petWindowHandle = Get-ElementWindowHandle $petElement
        if ($petWindowHandle -eq [IntPtr]::Zero) {
            throw "restarted pet has no native window"
        }
        [void](Invoke-PetMenuItem $candidateProcess "打开今日任务" $petWindowHandle)
        [void](Wait-AppElement $candidateProcess ([string]$mutation.title) $false $false 20)
        $functional.scenarios.restartPersistence = $true
        Write-ProbeProgress "functional:restart-persistence:passed"
        Write-ProbeProgress "functional:backup-restore:start"
        [void](Invoke-PetMenuItem $candidateProcess "设置" $petWindowHandle)
        [void](Wait-AppElement $candidateProcess "设置" $true $false 20)
        $restoreBackup = Find-ManualBackupRestoreButton $candidateProcess
        Invoke-AccessibleElement $restoreBackup
        [void](Confirm-CandidateDialog $candidateProcess)
        Start-Sleep -Seconds 3
        Stop-CandidateFromSettings $candidateProcess
        $candidateProcess = $null

        $restoredInspectOutput = & $helperPath inspect `
            --data-root $dataRoot `
            --reminder-ids ("{0},{1}" -f $seed.reminderId, $mutation.reminderId) `
            --attest-windows-sandbox
        if ($LASTEXITCODE -ne 0) { throw "installed-candidate restored inspection failed" }
        $restoredInspect = $restoredInspectOutput | ConvertFrom-Json
        if (
            -not $restoredInspect.databaseHealthy -or
            -not $restoredInspect.records[0].present -or
            $restoredInspect.records[1].present
        ) {
            throw "installed backup restore did not recover the pre-mutation state"
        }

        $candidateProcess = Start-InstalledCandidate $applicationPath $webView2RuntimeRoot
        [void](Wait-PetElement $candidateProcess 30)
        Invoke-PetMenuItem $candidateProcess "打开今日任务"
        [void](Wait-AppElement $candidateProcess ([string]$seed.title) $false $false 20)
        if ($null -ne (Find-AppElement $candidateProcess.Id ([string]$mutation.title) $false $false)) {
            throw "restored-away mutation reappeared after restart"
        }
        Invoke-PetMenuItem $candidateProcess "设置"
        [void](Wait-AppElement $candidateProcess "设置" $true $false 20)
        Stop-CandidateFromSettings $candidateProcess
        $candidateProcess = $null
        $functional.scenarios.backupAndRestore = $true
        Write-ProbeProgress "functional:backup-restore:passed"

        Write-ProbeProgress "functional:uninstall-preserve:start"
        $databaseBeforeUninstallSha256 = (
            Get-FileHash `
                -Algorithm SHA256 `
                -LiteralPath (Join-Path $dataRoot "yuanyuan-reminder.sqlite3")
        ).Hash
        $uninstallProcess = Start-Process `
            -FilePath $uninstallerPath `
            -ArgumentList "/S" `
            -Wait `
            -PassThru `
            -WindowStyle Hidden
        if ($uninstallProcess.ExitCode -ne 0 -or (Test-Path -LiteralPath $installRoot)) {
            throw "functional E2E default uninstall failed"
        }
        $databaseAfterUninstall = Join-Path $dataRoot "yuanyuan-reminder.sqlite3"
        if (
            -not (Test-Path -LiteralPath $databaseAfterUninstall -PathType Leaf) -or
            (Get-FileHash -Algorithm SHA256 -LiteralPath $databaseAfterUninstall).Hash -ne
                $databaseBeforeUninstallSha256
        ) {
            throw "default uninstall did not preserve the functional E2E database"
        }
        $functional.scenarios.uninstallKeepsDataByDefault = $true
        Write-ProbeProgress "functional:uninstall-preserve:passed"

        $markerPath = Join-Path $dataRoot ".yuanyuan-installed-candidate-qa-v1"
        if (
            [IO.Path]::GetFullPath($dataRoot) -ne
                [IO.Path]::GetFullPath((Join-Path $localAppData ([string]$tauriConfig.identifier))) -or
            -not (Test-Path -LiteralPath $markerPath -PathType Leaf) -or
            [IO.File]::ReadAllText($markerPath) -ne "YUANYUAN_INSTALLED_CANDIDATE_QA_V1`n"
        ) {
            throw "refusing to clean an unowned functional E2E data root"
        }
        Remove-Item -LiteralPath $dataRoot -Recurse -Force
        $functional.cleanup.applicationExited = $true
        $functional.cleanup.installRootRemoved = -not (Test-Path -LiteralPath $installRoot)
        $functional.cleanup.dataRootRemoved = -not (Test-Path -LiteralPath $dataRoot)
        $functional.cleanup.roamingDataRootAbsent = -not (Test-Path -LiteralPath $roamingDataRoot)
        $functional.cleanup.uninstallRegistrationRemoved = -not (Test-Path -LiteralPath $uninstallKey)
        if (Test-Path -LiteralPath $productKey) {
            $registeredRoot = [string](Get-Item -LiteralPath $productKey).GetValue("")
            if ([IO.Path]::GetFullPath($registeredRoot) -ne [IO.Path]::GetFullPath($installRoot)) {
                throw "post-uninstall product registration does not belong to the functional E2E install"
            }
            $functional.cleanup.productRegistrationPersistedAfterUninstall = $true
            Remove-Item -LiteralPath $productKey -Recurse -Force
        }
        $functional.cleanup.ownedProductRegistrationRemoved = -not (Test-Path -LiteralPath $productKey)
        $functional.cleanup.shortcutsRemoved =
            -not (Test-Path -LiteralPath $desktopShortcut) -and
            -not (Test-Path -LiteralPath $programsShortcut)
        $functional.cleanup.sandboxShutdownRequested = $true
        Write-ProbeProgress "functional:cleanup:passed"
    }
    finally {
        if ($null -ne $candidateProcess) {
            try {
                $candidateProcess.Refresh()
                if (-not $candidateProcess.HasExited) {
                    Stop-Process -Id $candidateProcess.Id -Force -ErrorAction SilentlyContinue
                    $candidateProcess.WaitForExit(5000) | Out-Null
                }
            }
            catch {}
        }
        if (Test-Path -LiteralPath $uninstallerPath -PathType Leaf) {
            try {
                Start-Process -FilePath $uninstallerPath -ArgumentList "/S" `
                    -Wait -WindowStyle Hidden | Out-Null
            }
            catch {}
        }
    }

    if (
        @($functional.scenarios.Values | Where-Object { $_ -ne $true }).Count -ne 0 -or
        -not $functional.cleanup.applicationExited -or
        -not $functional.cleanup.installRootRemoved -or
        -not $functional.cleanup.dataRootRemoved -or
        -not $functional.cleanup.roamingDataRootAbsent -or
        -not $functional.cleanup.uninstallRegistrationRemoved -or
        -not $functional.cleanup.productRegistrationPersistedAfterUninstall -or
        -not $functional.cleanup.ownedProductRegistrationRemoved -or
        -not $functional.cleanup.shortcutsRemoved -or
        -not $functional.cleanup.sandboxShutdownRequested
    ) {
        throw "functional installed-candidate E2E did not close every scenario and cleanup gate"
    }

    Copy-Item -LiteralPath $payloadReport `
        -Destination (Join-Path $outputRoot "nsis-installed-payload.json")
    Copy-Item -LiteralPath $uninstallReport `
        -Destination (Join-Path $outputRoot "release-uninstall-data-choice-probe.json")
    $status.reportsCopied = $true
    $status.ready = $status.payloadInspectionPassed -and
        $status.uninstallDataChoicePassed -and
        @($functional.scenarios.Values | Where-Object { $_ -ne $true }).Count -eq 0
    Write-ProbeProgress "result:ready"
}
catch {
    Write-ProbeProgress "result:failed"
    $status.failure = [string]$_.Exception.Message
    $edgeUpdateLogRoot = Join-Path $env:ProgramData "Microsoft\EdgeUpdate\Log"
    $logRoots = @($env:TEMP, $edgeUpdateLogRoot) |
        Where-Object { Test-Path -LiteralPath $_ -PathType Container }
    $recentLogs = @(
        foreach ($logRoot in $logRoots) {
            Get-ChildItem -LiteralPath $logRoot -File -Filter "*.log" -Recurse `
                -ErrorAction SilentlyContinue |
                Where-Object LastWriteTimeUtc -Ge ([DateTime]::UtcNow.AddMinutes(-10))
        }
    ) | Sort-Object FullName -Unique | Select-Object -First 12
    $copiedLogs = @()
    $logIndex = 0
    foreach ($log in $recentLogs) {
        $logIndex += 1
        $destinationName = "sandbox-installer-{0:D2}-{1}" -f $logIndex, $log.Name
        $destination = Join-Path $outputRoot $destinationName
        Copy-Item -LiteralPath $log.FullName -Destination $destination -ErrorAction SilentlyContinue
        if (Test-Path -LiteralPath $destination -PathType Leaf) {
            $copiedLogs += [ordered]@{
                name = $destinationName
                bytes = [long](Get-Item -LiteralPath $destination).Length
                sha256 = (Get-FileHash -Algorithm SHA256 -LiteralPath $destination).Hash
            }
        }
    }
    $webViewVersions = @(
        foreach ($keyPath in @(
            "Registry::HKEY_LOCAL_MACHINE\SOFTWARE\Microsoft\EdgeUpdate\Clients",
            "Registry::HKEY_LOCAL_MACHINE\SOFTWARE\WOW6432Node\Microsoft\EdgeUpdate\Clients",
            "Registry::HKEY_CURRENT_USER\Software\Microsoft\EdgeUpdate\Clients"
        )) {
            if (-not (Test-Path -LiteralPath $keyPath)) { continue }
            Get-ChildItem -LiteralPath $keyPath -ErrorAction SilentlyContinue |
                ForEach-Object {
                    $values = Get-ItemProperty -LiteralPath $_.PSPath -ErrorAction SilentlyContinue
                    if ($values.name -like "*WebView*") {
                        [ordered]@{ name = [string]$values.name; version = [string]$values.pv }
                    }
                }
        }
    )
    $status.failureDiagnostics = [ordered]@{
        webView2Registrations = @($webViewVersions)
        copiedInstallerLogs = @($copiedLogs)
    }
}
finally {
    Write-ProbeProgress "result:writing-status"
    $status.generatedAt = (Get-Date).ToUniversalTime().ToString("o")
    $status | ConvertTo-Json -Depth 6 |
        Set-Content -Encoding UTF8 -LiteralPath $statusPath
    [IO.File]::WriteAllText(
        $completePath,
        "YUANYUAN_WINDOWS_SANDBOX_DATA_PROBE_COMPLETE_V1`n",
        [Text.UTF8Encoding]::new($false)
    )
    Start-Process -FilePath shutdown.exe `
        -ArgumentList @("/s", "/f", "/t", "0") `
        -WindowStyle Hidden
}

if (-not $status.ready) { exit 2 }
