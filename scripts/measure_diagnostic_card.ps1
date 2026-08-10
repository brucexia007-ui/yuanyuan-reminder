param(
    [ValidateRange(30, 120)]
    [int]$ExitAfterSeconds = 45,

    [ValidateRange(5, 180)]
    [int]$StartupTimeoutSeconds = 30,

    [string]$PythonPath = ""
)

$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"
$projectRoot = Split-Path -Parent $PSScriptRoot
$workspaceRoot = Split-Path -Parent $projectRoot
$runtimeTarget = Join-Path $projectRoot "src-tauri\target\runtime-qa\release"
$appPath = Join-Path $runtimeTarget "yuanyuan-reminder.exe"
$fixturePath = Join-Path $runtimeTarget "yuanyuan-runtime-qa-fixture.exe"
$backdropScript = Join-Path $PSScriptRoot "run_neutral_capture_backdrop.py"
$evidenceRoot = Join-Path $runtimeTarget "evidence"
$runId = (Get-Date).ToUniversalTime().ToString("yyyyMMddTHHmmssZ")
$leaf = "yuanyuan-runtime-qa-diagnostics-$runId"
$qaRoot = Join-Path $workspaceRoot $leaf
$markerPath = Join-Path $qaRoot ".yuanyuan-runtime-qa-v1"
$expectedMarker = "YUANYUAN_RUNTIME_QA_V1`n"
$reportPath = Join-Path $evidenceRoot "diagnostic-card-$runId.json"
$initialScreenshotPath = Join-Path $evidenceRoot "diagnostic-card-$runId-initial.png"
$previewScreenshotPath = Join-Path $evidenceRoot "diagnostic-card-$runId-preview.png"
$exportEvidencePath = Join-Path $evidenceRoot "diagnostic-card-$runId-export.json"
$selectedExportRoot = Join-Path $qaRoot "selected-export"
$backdropReady = Join-Path $qaRoot ".neutral-capture-backdrop-ready"
$backdropStop = Join-Path $qaRoot ".neutral-capture-backdrop-stop"
$formalDataRoot = Join-Path $env:LOCALAPPDATA "com.yuanyuan.reminder"
$panelTitle = [Text.Encoding]::UTF8.GetString(
    [Convert]::FromBase64String("5ZyG5ZyG5o+Q6YaS")
)
$diagnosticTitle = [Text.Encoding]::UTF8.GetString(
    [Convert]::FromBase64String("5pm66IO96Zmq5Ly05a6e6aqM57uE5Lu2")
)
$pausedStatus = [Text.Encoding]::UTF8.GetString(
    [Convert]::FromBase64String("5bey5pqC5YGc6YeN6K+V")
)
$previewTriggerName = [Text.Encoding]::UTF8.GetString(
    [Convert]::FromBase64String("5p+l55yL6K+K5pat5b+r54Wn5YaF5a65")
)
$previewRegionName = [Text.Encoding]::UTF8.GetString(
    [Convert]::FromBase64String("6K+K5pat5b+r54Wn6aKE6KeI")
)
$confirmName = [Text.Encoding]::UTF8.GetString(
    [Convert]::FromBase64String("6YCJ5oup5L+d5a2Y5L2N572u")
)
$cancelName = [Text.Encoding]::UTF8.GetString(
    [Convert]::FromBase64String("5Y+W5raI")
)
$saveDialogTitle = [Text.Encoding]::UTF8.GetString(
    [Convert]::FromBase64String("6YCJ5oup6K+K5pat5b+r54Wn55qE5pys5py65L+d5a2Y5L2N572u")
)
$savingName = [Text.Encoding]::UTF8.GetString(
    [Convert]::FromBase64String("5q2j5Zyo5L+d5a2Y4oCm")
)
$saveFailureNotice = [Text.Encoding]::UTF8.GetString(
    [Convert]::FromBase64String(
        "6K+K5pat5b+r54Wn5pyq5L+d5a2Y77yM6K+36YCJ5oup5paw55qE5pys5py6IEpTT04g5paH5Lu25L2N572u5ZCO6YeN6K+V44CC"
    )
)

foreach ($required in @($appPath, $fixturePath, $backdropScript)) {
    if (-not (Test-Path -LiteralPath $required -PathType Leaf)) {
        throw "diagnostic card runtime QA dependency is missing"
    }
}
if ([string]::IsNullOrWhiteSpace($PythonPath)) {
    $PythonPath = (Get-Command python -ErrorAction Stop).Source
}
if (-not (Test-Path -LiteralPath $PythonPath -PathType Leaf)) {
    throw "Python runtime is unavailable"
}
New-Item -ItemType Directory -Force -Path $evidenceRoot | Out-Null

$bindings = [ordered]@{
    applicationSha256 = (Get-FileHash -Algorithm SHA256 -LiteralPath $appPath).Hash
    fixtureSha256 = (Get-FileHash -Algorithm SHA256 -LiteralPath $fixturePath).Hash
    scriptSha256 = (Get-FileHash -Algorithm SHA256 -LiteralPath $MyInvocation.MyCommand.Path).Hash
    backdropScriptSha256 = (Get-FileHash -Algorithm SHA256 -LiteralPath $backdropScript).Hash
}

if (-not ("YuanyuanDiagnosticWindowProbe" -as [type])) {
    Add-Type -TypeDefinition @"
using System;
using System.Collections.Generic;
using System.ComponentModel;
using System.Runtime.InteropServices;

public sealed class YuanyuanDiagnosticWindowInfo {
    public IntPtr Handle { get; set; }
    public string Title { get; set; }
    public int Left { get; set; }
    public int Top { get; set; }
    public int Right { get; set; }
    public int Bottom { get; set; }
    public uint Dpi { get; set; }
}

public sealed class YuanyuanDiagnosticProcessRelation {
    public uint ProcessId { get; set; }
    public uint ParentProcessId { get; set; }
}

public static class YuanyuanDiagnosticProcessSnapshot {
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

    public static YuanyuanDiagnosticProcessRelation[] Capture() {
        var snapshot = CreateToolhelp32Snapshot(SnapshotProcesses, 0);
        if (snapshot == new IntPtr(-1)) {
            throw new Win32Exception(Marshal.GetLastWin32Error());
        }
        try {
            var rows = new List<YuanyuanDiagnosticProcessRelation>();
            var entry = new ProcessEntry { Size = (uint)Marshal.SizeOf(typeof(ProcessEntry)) };
            if (Process32First(snapshot, ref entry)) {
                do {
                    rows.Add(new YuanyuanDiagnosticProcessRelation {
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

public static class YuanyuanDiagnosticWindowProbe {
    private delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);

    [StructLayout(LayoutKind.Sequential)]
    private struct Rect {
        public int Left;
        public int Top;
        public int Right;
        public int Bottom;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct Input {
        public uint Type;
        public InputUnion Union;
    }

    [StructLayout(LayoutKind.Explicit, Size = 32)]
    private struct InputUnion {
        [FieldOffset(0)] public KeyboardInput Keyboard;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct KeyboardInput {
        public ushort VirtualKey;
        public ushort ScanCode;
        public uint Flags;
        public uint Time;
        public UIntPtr ExtraInfo;
    }

    [DllImport("user32.dll")]
    private static extern bool EnumWindows(EnumWindowsProc callback, IntPtr lParam);
    [DllImport("user32.dll")]
    private static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint processId);
    [DllImport("user32.dll")]
    private static extern bool IsWindowVisible(IntPtr hWnd);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)]
    private static extern int GetWindowText(IntPtr hWnd, System.Text.StringBuilder text, int count);
    [DllImport("user32.dll")]
    private static extern bool GetWindowRect(IntPtr hWnd, out Rect rect);
    [DllImport("user32.dll")]
    private static extern uint GetDpiForWindow(IntPtr hWnd);
    [DllImport("user32.dll")]
    private static extern bool SetForegroundWindow(IntPtr hWnd);
    [DllImport("user32.dll")]
    private static extern bool SetWindowPos(
        IntPtr hWnd,
        IntPtr insertAfter,
        int x,
        int y,
        int width,
        int height,
        uint flags
    );
    [DllImport("user32.dll")]
    private static extern uint SendInput(uint count, Input[] inputs, int size);
    [DllImport("user32.dll")]
    private static extern bool SetProcessDpiAwarenessContext(IntPtr value);
    [DllImport("user32.dll")]
    private static extern bool SetProcessDPIAware();

    public static bool EnablePerMonitorDpi() {
        if (SetProcessDpiAwarenessContext(new IntPtr(-4))) {
            return true;
        }
        return SetProcessDPIAware();
    }

    public static YuanyuanDiagnosticWindowInfo[] VisibleWindows(int processId) {
        var windows = new List<YuanyuanDiagnosticWindowInfo>();
        EnumWindows((hWnd, lParam) => {
            uint owner;
            GetWindowThreadProcessId(hWnd, out owner);
            Rect rect;
            if (owner != (uint)processId || !IsWindowVisible(hWnd) || !GetWindowRect(hWnd, out rect)) {
                return true;
            }
            var title = new System.Text.StringBuilder(256);
            GetWindowText(hWnd, title, title.Capacity);
            windows.Add(new YuanyuanDiagnosticWindowInfo {
                Handle = hWnd,
                Title = title.ToString(),
                Left = rect.Left,
                Top = rect.Top,
                Right = rect.Right,
                Bottom = rect.Bottom,
                Dpi = GetDpiForWindow(hWnd)
            });
            return true;
        }, IntPtr.Zero);
        return windows.ToArray();
    }

    public static bool Activate(IntPtr handle) {
        return SetForegroundWindow(handle);
    }

    public static bool PlaceAbovePrivacyBackdrop(IntPtr handle) {
        var hwndTopmost = new IntPtr(-1);
        const uint noSize = 0x0001;
        const uint noMove = 0x0002;
        const uint noActivate = 0x0010;
        const uint showWindow = 0x0040;
        return SetWindowPos(
            handle,
            hwndTopmost,
            0,
            0,
            0,
            0,
            noSize | noMove | noActivate | showWindow
        );
    }

    public static bool SendVirtualKey(ushort virtualKey) {
        var inputs = new [] {
            new Input {
                Type = 1,
                Union = new InputUnion {
                    Keyboard = new KeyboardInput { VirtualKey = virtualKey, Flags = 0 }
                }
            },
            new Input {
                Type = 1,
                Union = new InputUnion {
                    Keyboard = new KeyboardInput { VirtualKey = virtualKey, Flags = 2 }
                }
            }
        };
        return SendInput((uint)inputs.Length, inputs, Marshal.SizeOf(typeof(Input))) == inputs.Length;
    }
}
"@
}

if (-not [YuanyuanDiagnosticWindowProbe]::EnablePerMonitorDpi()) {
    throw "Unable to enable per-monitor DPI awareness for diagnostic capture"
}

Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes
Add-Type -AssemblyName System.Drawing

function Wait-RuntimeStage([string]$Root, [string]$Stage, [int]$TimeoutSeconds) {
    $deadline = [DateTime]::UtcNow.AddSeconds($TimeoutSeconds)
    $stagePath = Join-Path (Join-Path $Root "status") $Stage
    while ([DateTime]::UtcNow -lt $deadline) {
        if (Test-Path -LiteralPath $stagePath -PathType Leaf) { return $true }
        Start-Sleep -Milliseconds 100
    }
    return $false
}

function Find-AccessibleElement([IntPtr]$Handle, [string]$Name) {
    try {
        $root = [System.Windows.Automation.AutomationElement]::FromHandle($Handle)
        $condition = New-Object System.Windows.Automation.PropertyCondition(
            [System.Windows.Automation.AutomationElement]::NameProperty,
            $Name
        )
        return $root.FindFirst(
            [System.Windows.Automation.TreeScope]::Descendants,
            $condition
        )
    }
    catch {
        return $null
    }
}

function Wait-AccessibleElement(
    [IntPtr]$Handle,
    [string]$Name,
    [int]$TimeoutSeconds
) {
    $deadline = [DateTime]::UtcNow.AddSeconds($TimeoutSeconds)
    while ([DateTime]::UtcNow -lt $deadline) {
        $element = Find-AccessibleElement $Handle $Name
        if ($null -ne $element) { return $element }
        Start-Sleep -Milliseconds 100
    }
    return $null
}

function Wait-AccessibleElementMissing(
    [IntPtr]$Handle,
    [string]$Name,
    [int]$TimeoutSeconds
) {
    $deadline = [DateTime]::UtcNow.AddSeconds($TimeoutSeconds)
    while ([DateTime]::UtcNow -lt $deadline) {
        if ($null -eq (Find-AccessibleElement $Handle $Name)) { return $true }
        Start-Sleep -Milliseconds 100
    }
    return $false
}

function Get-FocusedAccessibleName() {
    try {
        return [System.Windows.Automation.AutomationElement]::FocusedElement.Current.Name
    }
    catch {
        return ""
    }
}

function Get-ElementBounds([System.Windows.Automation.AutomationElement]$Element) {
    $rect = $Element.Current.BoundingRectangle
    [ordered]@{
        left = [math]::Round($rect.Left, 1)
        top = [math]::Round($rect.Top, 1)
        width = [math]::Round($rect.Width, 1)
        height = [math]::Round($rect.Height, 1)
    }
}

function Save-WindowScreenshot([object]$Window, [string]$Path) {
    $width = [int]($Window.Right - $Window.Left)
    $height = [int]($Window.Bottom - $Window.Top)
    if ($width -le 0 -or $height -le 0) { throw "diagnostic window bounds are invalid" }
    $bitmap = New-Object System.Drawing.Bitmap($width, $height)
    $graphics = [System.Drawing.Graphics]::FromImage($bitmap)
    try {
        $graphics.CopyFromScreen(
            [int]$Window.Left,
            [int]$Window.Top,
            0,
            0,
            (New-Object System.Drawing.Size($width, $height))
        )
        $bitmap.Save($Path, [System.Drawing.Imaging.ImageFormat]::Png)
    }
    finally {
        $graphics.Dispose()
        $bitmap.Dispose()
    }
}

function Test-BoundsInsideWindow([object]$Bounds, [object]$Window) {
    return $Bounds.width -gt 0 -and
        $Bounds.height -gt 0 -and
        $Bounds.left -ge $Window.Left -and
        $Bounds.top -ge $Window.Top -and
        ($Bounds.left + $Bounds.width) -le $Window.Right -and
        ($Bounds.top + $Bounds.height) -le $Window.Bottom
}

function Get-OwnedProcessIds([int]$RootProcessId) {
    $rows = @([YuanyuanDiagnosticProcessSnapshot]::Capture())
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
    if ($remaining.Count -gt 0) { throw "diagnostic process tree did not stop" }
}

function Remove-OwnedQaRoot([string]$Root) {
    if (-not (Test-Path -LiteralPath $Root -PathType Container)) { return $true }
    $canonicalRoot = (Resolve-Path -LiteralPath $Root).Path
    $canonicalParent = (Resolve-Path -LiteralPath $workspaceRoot).Path
    if (
        (Split-Path -Parent $canonicalRoot) -ne $canonicalParent -or
        (Split-Path -Leaf $canonicalRoot) -ne $leaf -or
        -not (Test-Path -LiteralPath $markerPath -PathType Leaf) -or
        (Get-Content -Raw -Encoding UTF8 -LiteralPath $markerPath) -ne $expectedMarker
    ) {
        throw "refusing to remove an unowned diagnostic card runtime QA root"
    }
    Remove-Item -LiteralPath $canonicalRoot -Recurse -Force
    return -not (Test-Path -LiteralPath $canonicalRoot)
}

$lockPath = Join-Path $evidenceRoot "diagnostic-card.lock"
try {
    $lockStream = [System.IO.File]::Open(
        $lockPath,
        [System.IO.FileMode]::OpenOrCreate,
        [System.IO.FileAccess]::ReadWrite,
        [System.IO.FileShare]::None
    )
}
catch {
    throw "another diagnostic card runtime QA run is already active"
}

$process = $null
$backdropProcess = $null
$qaRootRemoved = $false
$backdropControlledExit = $false
$launchUtc = (Get-Date).ToUniversalTime()
$failure = $null
$reportReady = $false
$nativeSaveDialogObserved = $false
$nativeSaveDialogClosed = $false
$selectedExportCreated = $false
$exportSchemaValid = $false
$exportSensitiveMatches = -1
$exportBytes = 0
$exportSha256 = $null

try {
    & $fixturePath --root $qaRoot --prepare-only
    if ($LASTEXITCODE -ne 0) { throw "runtime QA root preparation failed" }

    $backdropProcess = Start-Process `
        -FilePath $PythonPath `
        -ArgumentList @(
            "`"$backdropScript`"",
            "--ready-file",
            "`"$backdropReady`"",
            "--stop-file",
            "`"$backdropStop`""
        ) `
        -WindowStyle Hidden `
        -PassThru
    $backdropDeadline = [DateTime]::UtcNow.AddSeconds(5)
    while ([DateTime]::UtcNow -lt $backdropDeadline) {
        $backdropProcess.Refresh()
        if ($backdropProcess.HasExited) { throw "privacy backdrop exited before ready" }
        if (Test-Path -LiteralPath $backdropReady -PathType Leaf) { break }
        Start-Sleep -Milliseconds 50
    }
    if (
        -not (Test-Path -LiteralPath $backdropReady -PathType Leaf) -or
        (Get-Content -Raw -Encoding UTF8 -LiteralPath $backdropReady) -ne
            "YUANYUAN_NEUTRAL_CAPTURE_BACKDROP_V1`n"
    ) {
        throw "privacy backdrop did not provide its exact ready marker"
    }

    $previousRoot = [Environment]::GetEnvironmentVariable(
        "YUANYUAN_RUNTIME_QA_ROOT",
        "Process"
    )
    $previousExit = [Environment]::GetEnvironmentVariable(
        "YUANYUAN_RUNTIME_QA_EXIT_AFTER_SECONDS",
        "Process"
    )
    $previousProfile = [Environment]::GetEnvironmentVariable(
        "YUANYUAN_RUNTIME_QA_PROFILE",
        "Process"
    )
    try {
        [Environment]::SetEnvironmentVariable("YUANYUAN_RUNTIME_QA_ROOT", $qaRoot, "Process")
        [Environment]::SetEnvironmentVariable(
            "YUANYUAN_RUNTIME_QA_EXIT_AFTER_SECONDS",
            [string]$ExitAfterSeconds,
            "Process"
        )
        [Environment]::SetEnvironmentVariable(
            "YUANYUAN_RUNTIME_QA_PROFILE",
            "diagnostics",
            "Process"
        )
        $process = Start-Process -FilePath $appPath -PassThru
    }
    finally {
        [Environment]::SetEnvironmentVariable("YUANYUAN_RUNTIME_QA_ROOT", $previousRoot, "Process")
        [Environment]::SetEnvironmentVariable(
            "YUANYUAN_RUNTIME_QA_EXIT_AFTER_SECONDS",
            $previousExit,
            "Process"
        )
        [Environment]::SetEnvironmentVariable(
            "YUANYUAN_RUNTIME_QA_PROFILE",
            $previousProfile,
            "Process"
        )
    }

    if (-not (Wait-RuntimeStage $qaRoot "core-setup-complete" $StartupTimeoutSeconds)) {
        throw "runtime QA core did not become ready"
    }

    $window = $null
    $lastVisibleSummary = "none"
    $windowDeadline = [DateTime]::UtcNow.AddSeconds($StartupTimeoutSeconds)
    while ([DateTime]::UtcNow -lt $windowDeadline) {
        $process.Refresh()
        if ($process.HasExited) { throw "runtime QA process exited before the panel was ready" }
        $visible = @([YuanyuanDiagnosticWindowProbe]::VisibleWindows($process.Id))
        $lastVisibleSummary = @($visible | ForEach-Object {
            "title64={0},size={1}x{2}" -f
                [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($_.Title)),
                ($_.Right - $_.Left),
                ($_.Bottom - $_.Top)
        }) -join ";"
        $primaryWindows = @($visible | Where-Object {
            ($_.Right - $_.Left) -ge 360 -and ($_.Bottom - $_.Top) -ge 560
        })
        if ($primaryWindows.Count -eq 1 -and $primaryWindows[0].Title -eq $panelTitle) {
            $window = $primaryWindows[0]
            break
        }
        Start-Sleep -Milliseconds 100
    }
    if ($null -eq $window) {
        throw "exactly one primary diagnostic panel window was not observed: $lastVisibleSummary"
    }
    if (-not [YuanyuanDiagnosticWindowProbe]::PlaceAbovePrivacyBackdrop($window.Handle)) {
        throw "diagnostic panel could not be placed above the privacy backdrop"
    }

    $statusTitle = Wait-AccessibleElement $window.Handle $diagnosticTitle $StartupTimeoutSeconds
    $statusBadge = Wait-AccessibleElement $window.Handle $pausedStatus $StartupTimeoutSeconds
    $previewTrigger = Wait-AccessibleElement `
        $window.Handle $previewTriggerName $StartupTimeoutSeconds
    if ($null -eq $statusTitle -or $null -eq $statusBadge -or $null -eq $previewTrigger) {
        throw "diagnostic card accessible controls were not observed"
    }

    [YuanyuanDiagnosticWindowProbe]::Activate($window.Handle) | Out-Null
    $previewTrigger.SetFocus()
    Start-Sleep -Milliseconds 250
    $initialFocus = Get-FocusedAccessibleName
    $triggerBounds = Get-ElementBounds $previewTrigger
    Save-WindowScreenshot $window $initialScreenshotPath

    if (-not [YuanyuanDiagnosticWindowProbe]::SendVirtualKey(0x0D)) {
        throw "Enter key injection failed"
    }
    $previewRegion = Wait-AccessibleElement $window.Handle $previewRegionName 5
    $confirmButton = Wait-AccessibleElement $window.Handle $confirmName 5
    $cancelButton = Wait-AccessibleElement $window.Handle $cancelName 5
    if ($null -eq $previewRegion -or $null -eq $confirmButton -or $null -eq $cancelButton) {
        throw "diagnostic preview did not open from the keyboard"
    }
    Start-Sleep -Milliseconds 250
    $focusAfterOpen = Get-FocusedAccessibleName
    $previewBounds = Get-ElementBounds $previewRegion
    $confirmBounds = Get-ElementBounds $confirmButton
    $cancelBounds = Get-ElementBounds $cancelButton
    Save-WindowScreenshot $window $previewScreenshotPath

    if (-not [YuanyuanDiagnosticWindowProbe]::SendVirtualKey(0x09)) {
        throw "Tab key injection failed"
    }
    Start-Sleep -Milliseconds 200
    $focusAfterTab = Get-FocusedAccessibleName
    if (-not [YuanyuanDiagnosticWindowProbe]::SendVirtualKey(0x0D)) {
        throw "cancel Enter key injection failed"
    }
    if (-not (Wait-AccessibleElementMissing $window.Handle $previewRegionName 5)) {
        throw "diagnostic preview did not close from the keyboard"
    }
    Start-Sleep -Milliseconds 250
    $focusAfterCancel = Get-FocusedAccessibleName

    $previewRegion = $null
    $confirmButton = $null
    for ($previewAttempt = 0; $previewAttempt -lt 3; $previewAttempt += 1) {
        $previewTrigger = Wait-AccessibleElement `
            $window.Handle $previewTriggerName $StartupTimeoutSeconds
        if ($null -eq $previewTrigger) { throw "diagnostic preview trigger did not return" }
        [YuanyuanDiagnosticWindowProbe]::Activate($window.Handle) | Out-Null
        $previewTrigger.SetFocus()
        Start-Sleep -Milliseconds 250
        if (-not [YuanyuanDiagnosticWindowProbe]::SendVirtualKey(0x0D)) {
            throw "second preview Enter key injection failed"
        }
        $previewRegion = Wait-AccessibleElement $window.Handle $previewRegionName 5
        $confirmButton = Wait-AccessibleElement $window.Handle $confirmName 5
        if ($null -ne $previewRegion -and $null -ne $confirmButton) { break }
        Start-Sleep -Milliseconds 250
    }
    if ($null -eq $previewRegion -or $null -eq $confirmButton) {
        throw "diagnostic preview did not reopen for native save verification"
    }
    $confirmButton.SetFocus()
    if (-not [YuanyuanDiagnosticWindowProbe]::SendVirtualKey(0x0D)) {
        throw "native save picker Enter key injection failed"
    }

    $saveDialog = $null
    $saveDialogDeadline = [DateTime]::UtcNow.AddSeconds(10)
    while ([DateTime]::UtcNow -lt $saveDialogDeadline) {
        $saveDialog = @([YuanyuanDiagnosticWindowProbe]::VisibleWindows($process.Id) |
            Where-Object { $_.Title -eq $saveDialogTitle }) | Select-Object -First 1
        if ($null -ne $saveDialog) { break }
        Start-Sleep -Milliseconds 100
    }
    if ($null -eq $saveDialog) {
        $savingObserved = $null -ne (Find-AccessibleElement $window.Handle $savingName)
        $failureObserved = $null -ne (Find-AccessibleElement $window.Handle $saveFailureNotice)
        $visibleSummary = @([YuanyuanDiagnosticWindowProbe]::VisibleWindows($process.Id) |
            ForEach-Object {
                [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($_.Title))
            }) -join ","
        throw (
            "native diagnostic save picker was not observed; saving={0}; failure={1}; windows={2}" -f
            $savingObserved,
            $failureObserved,
            $visibleSummary
        )
    }
    $nativeSaveDialogObserved = $true
    [YuanyuanDiagnosticWindowProbe]::Activate($saveDialog.Handle) | Out-Null
    Start-Sleep -Milliseconds 200
    if (-not [YuanyuanDiagnosticWindowProbe]::SendVirtualKey(0x0D)) {
        throw "native save confirmation Enter key injection failed"
    }

    $exportDeadline = [DateTime]::UtcNow.AddSeconds(10)
    $selectedExport = $null
    while ([DateTime]::UtcNow -lt $exportDeadline) {
        $remainingDialogs = @([YuanyuanDiagnosticWindowProbe]::VisibleWindows($process.Id) |
            Where-Object { $_.Title -eq $saveDialogTitle })
        if ($remainingDialogs.Count -eq 0) { $nativeSaveDialogClosed = $true }
        if (Test-Path -LiteralPath $selectedExportRoot -PathType Container) {
            $exports = @(Get-ChildItem -LiteralPath $selectedExportRoot -File -Filter "*.json")
            if ($exports.Count -eq 1) {
                $selectedExport = $exports[0]
                break
            }
            if ($exports.Count -gt 1) { throw "native save produced multiple diagnostic files" }
        }
        Start-Sleep -Milliseconds 100
    }
    if ($null -eq $selectedExport) { throw "native save did not create one diagnostic file" }
    if (($selectedExport.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
        throw "native save output is a reparse point"
    }
    if (-not $nativeSaveDialogClosed) {
        $remainingDialogs = @([YuanyuanDiagnosticWindowProbe]::VisibleWindows($process.Id) |
            Where-Object { $_.Title -eq $saveDialogTitle })
        $nativeSaveDialogClosed = $remainingDialogs.Count -eq 0
    }
    if (-not $nativeSaveDialogClosed) { throw "native save picker did not close" }

    $exportRaw = [IO.File]::ReadAllBytes($selectedExport.FullName)
    $exportBytes = $exportRaw.Length
    if ($exportBytes -le 1 -or $exportBytes -gt 65537 -or $exportRaw[-1] -ne 10) {
        throw "diagnostic export byte boundary is invalid"
    }
    $exportText = [Text.Encoding]::UTF8.GetString($exportRaw)
    $exportJson = $exportText | ConvertFrom-Json
    $expectedTopLevel = @(
        "ai_status",
        "bridge_diagnostics",
        "control_protocol_version",
        "core_version",
        "generated_at_unix_ms",
        "queue",
        "schema_version",
        "task_event_protocol_version"
    ) | Sort-Object
    $actualTopLevel = @($exportJson.PSObject.Properties.Name | Sort-Object)
    $expectedQueue = @("pending_bytes", "pending_files", "quarantined_files") | Sort-Object
    $actualQueue = @($exportJson.queue.PSObject.Properties.Name | Sort-Object)
    $diagnosticEntriesValid = @($exportJson.bridge_diagnostics).Count -eq 2 -and
        @($exportJson.bridge_diagnostics | Where-Object {
            @($_.PSObject.Properties.Name | Sort-Object) -join "," -ne "code,count" -or
            $_.code -notin @("queue_full", "timeout") -or
            [int64]$_.count -le 0
        }).Count -eq 0
    $exportSchemaValid = ($actualTopLevel -join ",") -eq ($expectedTopLevel -join ",") -and
        ($actualQueue -join ",") -eq ($expectedQueue -join ",") -and
        [int]$exportJson.schema_version -eq 1 -and
        [int64]$exportJson.generated_at_unix_ms -gt 0 -and
        [string]$exportJson.core_version -eq "1.4.0" -and
        [int]$exportJson.task_event_protocol_version -gt 0 -and
        [int]$exportJson.control_protocol_version -gt 0 -and
        [string]$exportJson.ai_status -eq "circuit_open" -and
        [int]$exportJson.queue.pending_files -eq 3 -and
        [int64]$exportJson.queue.pending_bytes -eq 12480 -and
        [int]$exportJson.queue.quarantined_files -eq 1 -and
        $diagnosticEntriesValid
    $forbiddenExportMarkers = @(
        "password", "passwd", "secret", "credential", "access_token",
        "refresh_token", "authorization", "workspace", "prompt", "task_title",
        "task_id", "user_name", "username", "private_key", "sk-", "ghp_",
        "github_pat_", "akia", "bearer ", "-----begin ", ":\", "\\",
        "file://", "/home/", "/users/", "%userprofile%", "@"
    )
    $lowerExport = $exportText.ToLowerInvariant()
    $exportSensitiveMatches = @($forbiddenExportMarkers | Where-Object {
        $lowerExport.Contains($_)
    }).Count
    if (-not $exportSchemaValid -or $exportSensitiveMatches -ne 0) {
        throw "diagnostic export independent content verification failed"
    }
    if (Test-Path -LiteralPath $exportEvidencePath) {
        throw "diagnostic export evidence already exists"
    }
    Copy-Item -LiteralPath $selectedExport.FullName -Destination $exportEvidencePath
    $exportSha256 = (Get-FileHash -Algorithm SHA256 -LiteralPath $exportEvidencePath).Hash
    $selectedExportCreated = $true

    if (-not (Wait-AccessibleElementMissing $window.Handle $previewRegionName 5)) {
        throw "diagnostic preview did not close after saving"
    }

    $process.WaitForExit(($ExitAfterSeconds + 10) * 1000) | Out-Null
    $process.Refresh()
    $controlledExit = $process.HasExited -and $process.ExitCode -eq 0
    Stop-OwnedProcessTree $process.Id
    Start-Sleep -Milliseconds 500

    Set-Content -Encoding UTF8 -LiteralPath $backdropStop -Value "stop"
    $backdropProcess.WaitForExit(5000) | Out-Null
    $backdropProcess.Refresh()
    $backdropControlledExit = $backdropProcess.HasExited -and $backdropProcess.ExitCode -eq 0
    if (-not $backdropProcess.HasExited) {
        Stop-Process -Id $backdropProcess.Id -ErrorAction SilentlyContinue
        Wait-Process -Id $backdropProcess.Id -Timeout 5 -ErrorAction SilentlyContinue
    }

    $applicationErrorQueryAvailable = $true
    $applicationErrors = @()
    $eventReadErrors = @()
    $applicationErrors = @(Get-WinEvent -FilterHashtable @{
        LogName = "Application"
        StartTime = $launchUtc.ToLocalTime()
        Level = 2
    } -ErrorAction SilentlyContinue -ErrorVariable eventReadErrors |
        Where-Object { $_.Message -like "*yuanyuan-reminder*" })
    $unexpectedEventReadErrors = @($eventReadErrors | Where-Object {
        $_.FullyQualifiedErrorId -notlike "NoMatchingEventsFound*"
    })
    if ($unexpectedEventReadErrors.Count -gt 0) { $applicationErrorQueryAvailable = $false }

    $formalWrites = @()
    if (Test-Path -LiteralPath $formalDataRoot -PathType Container) {
        $formalWrites = @(Get-ChildItem -LiteralPath $formalDataRoot -Recurse -File -ErrorAction Stop |
            Where-Object { $_.LastWriteTimeUtc -ge $launchUtc })
    }

    $qaRootRemoved = Remove-OwnedQaRoot $qaRoot
    $windowWidth = [int]($window.Right - $window.Left)
    $windowHeight = [int]($window.Bottom - $window.Top)
    $logicalWidth = [math]::Round($windowWidth * 96.0 / $window.Dpi, 1)
    $logicalHeight = [math]::Round($windowHeight * 96.0 / $window.Dpi, 1)
    $boundsInside = (Test-BoundsInsideWindow $triggerBounds $window) -and
        (Test-BoundsInsideWindow $previewBounds $window) -and
        (Test-BoundsInsideWindow $confirmBounds $window) -and
        (Test-BoundsInsideWindow $cancelBounds $window)
    $reportReady = $controlledExit -and
        $backdropControlledExit -and
        $qaRootRemoved -and
        $formalWrites.Count -eq 0 -and
        $applicationErrorQueryAvailable -and
        $applicationErrors.Count -eq 0 -and
        $initialFocus -eq $previewTriggerName -and
        $focusAfterOpen -eq $confirmName -and
        $focusAfterTab -eq $cancelName -and
        $focusAfterCancel -eq $previewTriggerName -and
        $nativeSaveDialogObserved -and
        $nativeSaveDialogClosed -and
        $selectedExportCreated -and
        $exportSchemaValid -and
        $exportSensitiveMatches -eq 0 -and
        $exportBytes -gt 1 -and $exportBytes -le 65537 -and
        $boundsInside -and
        $logicalWidth -ge 390 -and $logicalWidth -le 420 -and
        $logicalHeight -ge 610 -and $logicalHeight -le 650

    $report = [ordered]@{
        schemaVersion = 2
        generatedAt = (Get-Date).ToUniversalTime().ToString("o")
        profile = "diagnostic-card"
        bindings = $bindings
        display = [ordered]@{
            dpi = [int]$window.Dpi
            scalePercent = [math]::Round($window.Dpi * 100.0 / 96.0, 1)
            left = [int]$window.Left
            top = [int]$window.Top
            right = [int]$window.Right
            bottom = [int]$window.Bottom
            physicalWidth = $windowWidth
            physicalHeight = $windowHeight
            logicalWidth = $logicalWidth
            logicalHeight = $logicalHeight
        }
        accessibility = [ordered]@{
            titleObserved = $null -ne $statusTitle
            statusObserved = $null -ne $statusBadge
            previewRegionObserved = $null -ne $previewRegion
            criticalBoundsInsideWindow = $boundsInside
            triggerBounds = $triggerBounds
            previewBounds = $previewBounds
            confirmBounds = $confirmBounds
            cancelBounds = $cancelBounds
        }
        keyboard = [ordered]@{
            initialFocus = $initialFocus
            focusAfterOpen = $focusAfterOpen
            focusAfterTab = $focusAfterTab
            focusAfterCancel = $focusAfterCancel
        }
        privacy = [ordered]@{
            prelaunchNeutralBackdropUsed = $true
            panelTemporarilyTopmostForCapture = $true
            backdropControlledExit = $backdropControlledExit
            captureScope = "single_panel_window_over_prelaunch_neutral_backdrop"
        }
        isolation = [ordered]@{
            formalUserFilesWritten = $formalWrites.Count
            applicationErrorQueryAvailable = $applicationErrorQueryAvailable
            applicationErrorCount = $applicationErrors.Count
            qaRootRemoved = $qaRootRemoved
        }
        process = [ordered]@{
            controlledExit = $controlledExit
            exitCode = if ($process.HasExited) { [int]$process.ExitCode } else { $null }
        }
        screenshots = [ordered]@{
            initial = [ordered]@{
                file = [IO.Path]::GetFileName($initialScreenshotPath)
                sha256 = (Get-FileHash -Algorithm SHA256 -LiteralPath $initialScreenshotPath).Hash
            }
            preview = [ordered]@{
                file = [IO.Path]::GetFileName($previewScreenshotPath)
                sha256 = (Get-FileHash -Algorithm SHA256 -LiteralPath $previewScreenshotPath).Hash
            }
        }
        export = [ordered]@{
            nativeSaveDialogObserved = $nativeSaveDialogObserved
            nativeSaveDialogClosed = $nativeSaveDialogClosed
            selectedLocationUsed = $selectedExportCreated
            file = [IO.Path]::GetFileName($exportEvidencePath)
            sha256 = $exportSha256
            bytes = $exportBytes
            schemaVersion = 1
            sensitiveScanStatus = "clean"
            sensitiveScanVersion = 1
            sensitiveScanChecks = 4
            sensitiveMatches = $exportSensitiveMatches
            selectedPathReturned = $false
            internalCopyCreated = $false
            automaticUpload = $false
        }
        ready = $reportReady
        limitations = @(
            "This run covers one Windows desktop and its active DPI configuration."
            "UI Automation and injected Enter/Tab keys do not replace Narrator human listening."
            "The exported diagnostic contains fixed synthetic runtime-QA metadata and no authentic user data."
            "This does not replace 100%, 125%, 150%, and 200% DPI matrix review."
        )
    }
    $report | ConvertTo-Json -Depth 8 | Set-Content -Encoding UTF8 -LiteralPath $reportPath
    Write-Output "Diagnostic card report written: $reportPath"
    Write-Output (
        "DPI={0} Scale={1}% Logical={2}x{3} Keyboard={4} Ready={5}" -f
        $report.display.dpi,
        $report.display.scalePercent,
        $report.display.logicalWidth,
        $report.display.logicalHeight,
        ($report.keyboard.Values -join " -> "),
        $report.ready
    )
    if (-not $report.ready) { exit 2 }
}
catch {
    $failure = $_.Exception.Message
    throw
}
finally {
    if ($null -ne $process) {
        $process.Refresh()
        try { Stop-OwnedProcessTree $process.Id } catch { }
    }
    if ($null -ne $backdropProcess) {
        $backdropProcess.Refresh()
        if (-not $backdropProcess.HasExited) {
            if (Test-Path -LiteralPath $qaRoot -PathType Container) {
                Set-Content -Encoding UTF8 -LiteralPath $backdropStop -Value "stop"
                $backdropProcess.WaitForExit(3000) | Out-Null
                $backdropProcess.Refresh()
            }
            if (-not $backdropProcess.HasExited) {
                Stop-Process -Id $backdropProcess.Id -ErrorAction SilentlyContinue
                Wait-Process -Id $backdropProcess.Id -Timeout 5 -ErrorAction SilentlyContinue
            }
        }
    }
    if (-not $qaRootRemoved -and (Test-Path -LiteralPath $qaRoot -PathType Container)) {
        Remove-OwnedQaRoot $qaRoot | Out-Null
    }
    if (-not $reportReady) {
        foreach ($incompleteEvidence in @(
            $initialScreenshotPath,
            $previewScreenshotPath,
            $exportEvidencePath
        )) {
            if (Test-Path -LiteralPath $incompleteEvidence -PathType Leaf) {
                Remove-Item -LiteralPath $incompleteEvidence -Force -ErrorAction SilentlyContinue
            }
        }
    }
    if ($null -ne $lockStream) { $lockStream.Dispose() }
    Remove-Item -LiteralPath $lockPath -Force -ErrorAction SilentlyContinue
}
