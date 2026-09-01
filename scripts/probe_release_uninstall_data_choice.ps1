param(
    [string]$ReleaseRoot = "",
    [int]$UiTimeoutSeconds = 30
)

$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"

if ($UiTimeoutSeconds -lt 10 -or $UiTimeoutSeconds -gt 120) {
    throw "UiTimeoutSeconds must be between 10 and 120"
}

$limitations = @(
    "This probe uses only synthetic sentinels in owned LocalAppData and RoamingAppData roots of a clean interactive Windows test account.",
    "It verifies that silent/default uninstall preserves both data roots and that explicitly toggling the real NSIS delete-data checkbox removes both roots.",
    "It does not use authentic user data, prove control-panel registration, exercise per-machine installation, or replace signed-candidate and accessibility review."
)

$projectRoot = Split-Path -Parent $PSScriptRoot
if ([string]::IsNullOrWhiteSpace($ReleaseRoot)) {
    $ReleaseRoot = Join-Path $projectRoot "src-tauri\target\release"
}
$releaseRoot = [IO.Path]::GetFullPath($ReleaseRoot)
$package = Get-Content -Raw -Encoding UTF8 -LiteralPath (Join-Path $projectRoot "package.json") |
    ConvertFrom-Json
$tauriConfig = Get-Content -Raw -Encoding UTF8 -LiteralPath (
    Join-Path $projectRoot "src-tauri\tauri.conf.json"
) | ConvertFrom-Json
$candidateVersion = [string]$package.version
$productName = [string]$tauriConfig.productName
$bundleIdentifier = [string]$tauriConfig.identifier
$brandConfig = Get-Content -Raw -Encoding UTF8 -LiteralPath (Join-Path $projectRoot "product-brand.json") | ConvertFrom-Json
$installerBaseName = [string]$brandConfig.artifacts.installerBaseName
if ([string]::IsNullOrWhiteSpace($installerBaseName) -or $installerBaseName -ne $productName) {
    throw "product brand installer base name must match the Tauri product name"
}
$identifierSegments = @($bundleIdentifier.Split('.'))
$installerManufacturer = if ($identifierSegments.Count -ge 2) {
    [string]$identifierSegments[1]
} else {
    ""
}
if ([string]::IsNullOrWhiteSpace($installerManufacturer)) {
    throw "Tauri identifier cannot determine the NSIS manufacturer registry key"
}
$scriptPath = $MyInvocation.MyCommand.Path
$candidatePayloadPath = Join-Path $releaseRoot "nsis-payload\yuanyuan-reminder.exe"
$candidateInstallerCandidates = @(
    Get-ChildItem -LiteralPath (Join-Path $releaseRoot "bundle\nsis") -File -ErrorAction SilentlyContinue |
        Where-Object { $_.Name -like ("*_{0}_x64-setup.exe" -f $candidateVersion) }
)
if ($candidateInstallerCandidates.Count -ne 1) {
    throw "release bundle must contain exactly one version-matched x64 NSIS installer"
}
$expectedInstallerName = "{0}_{1}_x64-setup.exe" -f $installerBaseName, $candidateVersion
if ($candidateInstallerCandidates[0].Name -cne $expectedInstallerName) {
    throw "release installer name does not match the product brand"
}
$candidateInstallerPath = $candidateInstallerCandidates[0].FullName
$reportPath = Join-Path $releaseRoot "release-uninstall-data-choice-probe.json"

Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes

if (-not ("YuanyuanUninstallChoiceProcessSnapshot" -as [type])) {
    Add-Type -TypeDefinition @"
using System;
using System.Collections.Generic;
using System.ComponentModel;
using System.Runtime.InteropServices;

public sealed class YuanyuanUninstallChoiceProcessRelation {
    public uint ProcessId { get; set; }
    public uint ParentProcessId { get; set; }
}

public static class YuanyuanUninstallChoiceProcessSnapshot {
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
    [DllImport("user32.dll", SetLastError = true)]
    public static extern IntPtr SendMessage(IntPtr window, uint message, IntPtr wParam, IntPtr lParam);

    public static YuanyuanUninstallChoiceProcessRelation[] Capture() {
        var snapshot = CreateToolhelp32Snapshot(SnapshotProcesses, 0);
        if (snapshot == new IntPtr(-1)) {
            throw new Win32Exception(Marshal.GetLastWin32Error());
        }
        try {
            var rows = new List<YuanyuanUninstallChoiceProcessRelation>();
            var entry = new ProcessEntry { Size = (uint)Marshal.SizeOf(typeof(ProcessEntry)) };
            if (Process32First(snapshot, ref entry)) {
                do {
                    rows.Add(new YuanyuanUninstallChoiceProcessRelation {
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
    (Get-FileHash -Algorithm SHA256 -LiteralPath $Path).Hash
}

function Test-SamePath([AllowNull()][string]$Left, [string]$Right) {
    if ([string]::IsNullOrWhiteSpace($Left)) { return $false }
    $normalizedLeft = [IO.Path]::GetFullPath($Left.Trim('"')).TrimEnd('\')
    $normalizedRight = [IO.Path]::GetFullPath($Right.Trim('"')).TrimEnd('\')
    $normalizedLeft.Equals($normalizedRight, [StringComparison]::OrdinalIgnoreCase)
}

function Test-Sentinel([string]$Path, [string]$ExpectedSha256) {
    (Test-Path -LiteralPath $Path -PathType Leaf) -and
        (Get-Sha256 $Path) -eq $ExpectedSha256
}

function Get-InstalledCoreState(
    [string]$InstallRoot,
    [string]$ExpectedVersion,
    [long]$ExpectedBytes,
    [string]$ExpectedSha256
) {
    $applicationPath = Join-Path $InstallRoot "yuanyuan-reminder.exe"
    $uninstallerPath = Join-Path $InstallRoot "uninstall.exe"
    $applicationPresent = Test-Path -LiteralPath $applicationPath -PathType Leaf
    $uninstallerPresent = Test-Path -LiteralPath $uninstallerPath -PathType Leaf
    $actualVersion = if ($applicationPresent) {
        [string](Get-Item -LiteralPath $applicationPath).VersionInfo.ProductVersion
    } else { $null }
    $actualBytes = if ($applicationPresent) {
        [long](Get-Item -LiteralPath $applicationPath).Length
    } else { 0L }
    $actualSha256 = if ($applicationPresent) { Get-Sha256 $applicationPath } else { $null }
    [ordered]@{
        installedProductVersion = $actualVersion
        installedCoreBytes = $actualBytes
        installedCoreSha256 = $actualSha256
        installedCoreMatches = $applicationPresent -and
            $uninstallerPresent -and
            $actualVersion -eq $ExpectedVersion -and
            $actualBytes -eq $ExpectedBytes -and
            $actualSha256 -eq $ExpectedSha256
    }
}

function Invoke-SilentInstall([string]$InstallerPath, [string]$InstallRoot) {
    $process = Start-Process -FilePath $InstallerPath `
        -ArgumentList @("/S", "/D=$InstallRoot") `
        -Wait `
        -PassThru
    Start-Sleep -Milliseconds 750
    $process.ExitCode
}

function Invoke-SilentUninstall([string]$InstallRoot) {
    $uninstallerPath = Join-Path $InstallRoot "uninstall.exe"
    if (-not (Test-Path -LiteralPath $uninstallerPath -PathType Leaf)) {
        throw "owned QA uninstaller is missing"
    }
    $process = Start-Process -FilePath $uninstallerPath -ArgumentList "/S" -Wait -PassThru
    Start-Sleep -Milliseconds 750
    $process.ExitCode
}

function Expand-OwnedProcessIds([System.Collections.Generic.HashSet[int]]$Owned) {
    $rows = @([YuanyuanUninstallChoiceProcessSnapshot]::Capture())
    do {
        $added = $false
        foreach ($row in $rows) {
            if ($Owned.Contains([int]$row.ParentProcessId) -and
                -not $Owned.Contains([int]$row.ProcessId)) {
                $Owned.Add([int]$row.ProcessId) | Out-Null
                $added = $true
            }
        }
    } while ($added)
}

function Get-LiveOwnedProcessIds([System.Collections.Generic.HashSet[int]]$Owned) {
    Expand-OwnedProcessIds $Owned
    @($Owned | Where-Object { Get-Process -Id $_ -ErrorAction SilentlyContinue })
}

function Stop-OwnedProcessTree([System.Collections.Generic.HashSet[int]]$Owned) {
    for ($attempt = 0; $attempt -lt 4; $attempt += 1) {
        $live = @(Get-LiveOwnedProcessIds $Owned)
        if ($live.Count -eq 0) { return }
        foreach ($processId in @($live | Sort-Object -Descending)) {
            Stop-Process -Id $processId -Force -ErrorAction SilentlyContinue
        }
        Start-Sleep -Milliseconds 250
    }
    if (@(Get-LiveOwnedProcessIds $Owned).Count -gt 0) {
        throw "owned uninstaller process tree did not stop"
    }
}

function Find-OwnedAutomationElement(
    [System.Collections.Generic.HashSet[int]]$Owned,
    [System.Windows.Automation.ControlType]$ControlType,
    [string]$Name
) {
    foreach ($processId in @(Get-LiveOwnedProcessIds $Owned)) {
        $process = Get-Process -Id $processId -ErrorAction SilentlyContinue
        if ($null -eq $process -or $process.MainWindowHandle -eq [IntPtr]::Zero) { continue }
        try {
            $root = [System.Windows.Automation.AutomationElement]::FromHandle(
                $process.MainWindowHandle
            )
            $condition = New-Object System.Windows.Automation.AndCondition(
                (New-Object System.Windows.Automation.PropertyCondition(
                    [System.Windows.Automation.AutomationElement]::ControlTypeProperty,
                    $ControlType
                )),
                (New-Object System.Windows.Automation.PropertyCondition(
                    [System.Windows.Automation.AutomationElement]::NameProperty,
                    $Name
                ))
            )
            $element = $root.FindFirst(
                [System.Windows.Automation.TreeScope]::Descendants,
                $condition
            )
            if ($null -ne $element) { return $element }
        }
        catch {}
    }
    try {
        $condition = New-Object System.Windows.Automation.AndCondition(
            (New-Object System.Windows.Automation.PropertyCondition(
                [System.Windows.Automation.AutomationElement]::ControlTypeProperty,
                $ControlType
            )),
            (New-Object System.Windows.Automation.PropertyCondition(
                [System.Windows.Automation.AutomationElement]::NameProperty,
                $Name
            ))
        )
        foreach ($element in @([System.Windows.Automation.AutomationElement]::RootElement.FindAll(
            [System.Windows.Automation.TreeScope]::Descendants,
            $condition
        ))) {
            if ($Owned.Contains([int]$element.Current.ProcessId)) { return $element }
        }
    }
    catch {}
    $null
}

function Find-DesktopAutomationElement(
    [System.Windows.Automation.ControlType]$ControlType,
    [string]$Name
) {
    $condition = New-Object System.Windows.Automation.AndCondition(
        (New-Object System.Windows.Automation.PropertyCondition(
            [System.Windows.Automation.AutomationElement]::ControlTypeProperty,
            $ControlType
        )),
        (New-Object System.Windows.Automation.PropertyCondition(
            [System.Windows.Automation.AutomationElement]::NameProperty,
            $Name
        ))
    )
    [System.Windows.Automation.AutomationElement]::RootElement.FindFirst(
        [System.Windows.Automation.TreeScope]::Descendants,
        $condition
    )
}

function Get-OwnedButtonNames([System.Collections.Generic.HashSet[int]]$Owned) {
    $names = [System.Collections.Generic.HashSet[string]]::new([StringComparer]::Ordinal)
    foreach ($processId in @(Get-LiveOwnedProcessIds $Owned)) {
        $process = Get-Process -Id $processId -ErrorAction SilentlyContinue
        if ($null -eq $process -or $process.MainWindowHandle -eq [IntPtr]::Zero) { continue }
        try {
            $root = [System.Windows.Automation.AutomationElement]::FromHandle(
                $process.MainWindowHandle
            )
            $condition = New-Object System.Windows.Automation.PropertyCondition(
                [System.Windows.Automation.AutomationElement]::ControlTypeProperty,
                [System.Windows.Automation.ControlType]::Button
            )
            foreach ($element in @($root.FindAll(
                [System.Windows.Automation.TreeScope]::Descendants,
                $condition
            ))) {
                $name = [string]$element.Current.Name
                if (-not [string]::IsNullOrWhiteSpace($name) -and $name.Length -le 64) {
                    $names.Add($name) | Out-Null
                }
            }
        }
        catch {}
    }
    try {
        $condition = New-Object System.Windows.Automation.PropertyCondition(
            [System.Windows.Automation.AutomationElement]::ControlTypeProperty,
            [System.Windows.Automation.ControlType]::Button
        )
        foreach ($element in @([System.Windows.Automation.AutomationElement]::RootElement.FindAll(
            [System.Windows.Automation.TreeScope]::Descendants,
            $condition
        ))) {
            if (-not $Owned.Contains([int]$element.Current.ProcessId)) { continue }
            $name = [string]$element.Current.Name
            if (-not [string]::IsNullOrWhiteSpace($name) -and $name.Length -le 64) {
                $names.Add($name) | Out-Null
            }
        }
    }
    catch {}
    @($names | Sort-Object)
}

function Invoke-AutomationElement([System.Windows.Automation.AutomationElement]$Element) {
    $pattern = $null
    if ($Element.TryGetCurrentPattern(
        [System.Windows.Automation.InvokePattern]::Pattern,
        [ref]$pattern
    )) {
        try {
            $pattern.Invoke()
            return $true
        }
        catch {}
    }
    $nativeHandle = [IntPtr]$Element.Current.NativeWindowHandle
    if ($nativeHandle -ne [IntPtr]::Zero) {
        try {
            [YuanyuanUninstallChoiceProcessSnapshot]::SendMessage(
                $nativeHandle,
                0x00F5,
                [IntPtr]::Zero,
                [IntPtr]::Zero
            ) | Out-Null
            return $true
        }
        catch {}
    }
    $false
}

function Invoke-ExplicitDeleteUninstall([string]$InstallRoot, [int]$TimeoutSeconds) {
    $uninstallerPath = Join-Path $InstallRoot "uninstall.exe"
    if (-not (Test-Path -LiteralPath $uninstallerPath -PathType Leaf)) {
        throw "owned QA uninstaller is missing"
    }
    $preexistingCheckbox = Find-DesktopAutomationElement `
        ([System.Windows.Automation.ControlType]::CheckBox) `
        "Delete the application data"
    if ($null -ne $preexistingCheckbox) {
        throw "an unrelated delete-application-data checkbox is already present"
    }
    $process = Start-Process -FilePath $uninstallerPath -PassThru
    $rootStartTime = $process.StartTime
    $owned = [System.Collections.Generic.HashSet[int]]::new()
    $owned.Add([int]$process.Id) | Out-Null
    $deadline = [DateTime]::UtcNow.AddSeconds($TimeoutSeconds)
    $checkbox = $null
    $observedButtonNames = @()
    while ($null -eq $checkbox -and [DateTime]::UtcNow -lt $deadline) {
        $checkbox = Find-OwnedAutomationElement `
            $owned `
            ([System.Windows.Automation.ControlType]::CheckBox) `
            "Delete the application data"
        if ($null -eq $checkbox) {
            $desktopCheckbox = Find-DesktopAutomationElement `
                ([System.Windows.Automation.ControlType]::CheckBox) `
                "Delete the application data"
            if ($null -ne $desktopCheckbox) {
                $uiProcessId = [int]$desktopCheckbox.Current.ProcessId
                $uiProcess = Get-Process -Id $uiProcessId -ErrorAction SilentlyContinue
                if (
                    $null -ne $uiProcess -and
                    $uiProcess.StartTime -ge $rootStartTime.AddSeconds(-1)
                ) {
                    $owned.Add($uiProcessId) | Out-Null
                    $checkbox = $desktopCheckbox
                }
            }
        }
        if ($null -eq $checkbox) {
            $observedButtonNames = Get-OwnedButtonNames $owned
            Start-Sleep -Milliseconds 100
        }
    }
    $checkboxFound = $null -ne $checkbox
    $checkboxInitiallyOff = $false
    $checkboxToggledOn = $false
    if ($checkboxFound) {
        while (-not $checkboxToggledOn -and [DateTime]::UtcNow -lt $deadline) {
            $checkbox = Find-OwnedAutomationElement `
                $owned `
                ([System.Windows.Automation.ControlType]::CheckBox) `
                "Delete the application data"
            if ($null -eq $checkbox) {
                Start-Sleep -Milliseconds 100
                continue
            }
            try {
                $togglePattern = $null
                if ($checkbox.TryGetCurrentPattern(
                    [System.Windows.Automation.TogglePattern]::Pattern,
                    [ref]$togglePattern
                )) {
                    $currentState = $togglePattern.Current.ToggleState
                    if ($currentState -eq [System.Windows.Automation.ToggleState]::Off) {
                        $checkboxInitiallyOff = $true
                        if ($checkbox.Current.IsEnabled) {
                            try { $togglePattern.Toggle() } catch {}
                            $nativeHandle = [IntPtr]$checkbox.Current.NativeWindowHandle
                            if ($nativeHandle -ne [IntPtr]::Zero) {
                                [YuanyuanUninstallChoiceProcessSnapshot]::SendMessage(
                                    $nativeHandle,
                                    0x00F1,
                                    [IntPtr]1,
                                    [IntPtr]::Zero
                                ) | Out-Null
                            }
                        }
                    }
                    Start-Sleep -Milliseconds 150
                    $checkboxToggledOn =
                        $togglePattern.Current.ToggleState -eq
                        [System.Windows.Automation.ToggleState]::On
                    if (-not $checkboxToggledOn) {
                        $nativeHandle = [IntPtr]$checkbox.Current.NativeWindowHandle
                        if ($nativeHandle -ne [IntPtr]::Zero) {
                            $nativeState = [YuanyuanUninstallChoiceProcessSnapshot]::SendMessage(
                                $nativeHandle,
                                0x00F0,
                                [IntPtr]::Zero,
                                [IntPtr]::Zero
                            )
                            $checkboxToggledOn = $nativeState.ToInt64() -eq 1
                        }
                    }
                }
            }
            catch {}
            if (-not $checkboxToggledOn) { Start-Sleep -Milliseconds 100 }
        }
    }

    $uninstallButton = Find-OwnedAutomationElement `
        $owned `
        ([System.Windows.Automation.ControlType]::Button) `
        "Uninstall"
    $uninstallButtonInvoked = $null -ne $uninstallButton -and
        (Invoke-AutomationElement $uninstallButton)
    $completionButtonInvoked = $false
    while (@(Get-LiveOwnedProcessIds $owned).Count -gt 0 -and [DateTime]::UtcNow -lt $deadline) {
        $closeButton = Find-OwnedAutomationElement `
            $owned `
            ([System.Windows.Automation.ControlType]::Button) `
            "Close"
        if ($null -ne $closeButton) {
            $completionButtonInvoked = Invoke-AutomationElement $closeButton
        }
        $observedButtonNames = Get-OwnedButtonNames $owned
        Start-Sleep -Milliseconds 100
    }
    $timedOut = @(Get-LiveOwnedProcessIds $owned).Count -gt 0
    if ($timedOut) { Stop-OwnedProcessTree $owned }
    [ordered]@{
        checkboxFound = $checkboxFound
        checkboxInitiallyOff = $checkboxInitiallyOff
        checkboxToggledOn = $checkboxToggledOn
        uninstallButtonInvoked = $uninstallButtonInvoked
        completionButtonInvoked = $completionButtonInvoked
        processTreeTimedOut = $timedOut
        ownedProcessCountAfter = @(Get-LiveOwnedProcessIds $owned).Count
        observedButtonNames = @($observedButtonNames)
    }
}

function Remove-OwnedShortcut([string]$Path, [string]$ExpectedTarget) {
    if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) { return $true }
    $shell = New-Object -ComObject WScript.Shell
    $actualTarget = [string]$shell.CreateShortcut($Path).TargetPath
    if (-not (Test-SamePath $actualTarget $ExpectedTarget)) {
        throw "refusing to remove a shortcut outside the owned QA installation"
    }
    Remove-Item -LiteralPath $Path -Force -ErrorAction Stop
    -not (Test-Path -LiteralPath $Path)
}

function Remove-OwnedDirectory(
    [string]$Path,
    [string]$MarkerName,
    [string]$ExpectedMarker,
    [string]$RequiredParent
) {
    if (-not (Test-Path -LiteralPath $Path -PathType Container)) { return $true }
    $resolved = [IO.Path]::GetFullPath($Path)
    $parent = [IO.Path]::GetFullPath($RequiredParent).TrimEnd('\') + '\'
    if (-not $resolved.StartsWith($parent, [StringComparison]::OrdinalIgnoreCase)) {
        throw "owned cleanup target escaped its required parent"
    }
    $markerPath = Join-Path $resolved $MarkerName
    if (
        -not (Test-Path -LiteralPath $markerPath -PathType Leaf) -or
        (Get-Content -Raw -Encoding UTF8 -LiteralPath $markerPath) -ne $ExpectedMarker
    ) {
        throw "owned cleanup marker is missing or invalid"
    }
    Remove-Item -LiteralPath $resolved -Recurse -Force -ErrorAction Stop
    -not (Test-Path -LiteralPath $resolved)
}

foreach ($requiredPath in @($candidateInstallerPath, $candidatePayloadPath, $scriptPath)) {
    if (-not (Test-Path -LiteralPath $requiredPath -PathType Leaf)) {
        throw "required uninstall-choice probe input is missing: $requiredPath"
    }
    $metadata = Get-Item -LiteralPath $requiredPath -Force
    if (($metadata.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
        throw "uninstall-choice probe input must not be a reparse point: $requiredPath"
    }
}

$candidateInstallerBytes = [long](Get-Item -LiteralPath $candidateInstallerPath).Length
$candidateInstallerSha256 = Get-Sha256 $candidateInstallerPath
$candidatePayloadBytes = [long](Get-Item -LiteralPath $candidatePayloadPath).Length
$candidatePayloadSha256 = Get-Sha256 $candidatePayloadPath
$identity = [Security.Principal.WindowsIdentity]::GetCurrent()
$sid = $identity.User.Value
$profileRegistryQueryAvailable = $true
$profilePath = $null
try {
    $profilePath = [Environment]::ExpandEnvironmentVariables([string](
        Get-ItemProperty -LiteralPath (
            "Registry::HKEY_LOCAL_MACHINE\SOFTWARE\Microsoft\Windows NT\CurrentVersion\ProfileList\{0}" -f $sid
        ) -ErrorAction Stop
    ).ProfileImagePath)
}
catch {
    $profileRegistryQueryAvailable = $false
}
$tokenProfilePathMatchesEnvironment = $profileRegistryQueryAvailable -and
    (Test-SamePath $profilePath $env:USERPROFILE)
$localAppData = [Environment]::GetFolderPath("LocalApplicationData")
$roamingAppData = [Environment]::GetFolderPath("ApplicationData")
$localAppDataMatchesTokenProfile = $profileRegistryQueryAvailable -and
    $localAppData.StartsWith(
        ([IO.Path]::GetFullPath($profilePath).TrimEnd('\') + '\'),
        [StringComparison]::OrdinalIgnoreCase
    )
$roamingAppDataMatchesTokenProfile = $profileRegistryQueryAvailable -and
    $roamingAppData.StartsWith(
        ([IO.Path]::GetFullPath($profilePath).TrimEnd('\') + '\'),
        [StringComparison]::OrdinalIgnoreCase
    )
$uninstallKey = "Registry::HKEY_CURRENT_USER\Software\Microsoft\Windows\CurrentVersion\Uninstall\$productName"
$productKey = "Registry::HKEY_CURRENT_USER\Software\$installerManufacturer\$productName"
$runKey = "Registry::HKEY_CURRENT_USER\Software\Microsoft\Windows\CurrentVersion\Run"
$preexistingRunValue = $false
try {
    Get-ItemPropertyValue -LiteralPath $runKey -Name $productName -ErrorAction Stop | Out-Null
    $preexistingRunValue = $true
}
catch {}
$desktopShortcut = Join-Path ([Environment]::GetFolderPath("Desktop")) "$productName.lnk"
$programsShortcut = Join-Path ([Environment]::GetFolderPath("Programs")) "$productName.lnk"
$preexistingShortcut = (Test-Path -LiteralPath $desktopShortcut) -or
    (Test-Path -LiteralPath $programsShortcut)
$preexistingProcesses = @(Get-Process -Name "yuanyuan-reminder" -ErrorAction SilentlyContinue)
$preexistingRegistration = (Test-Path -LiteralPath $uninstallKey) -or
    (Test-Path -LiteralPath $productKey)
$localDataRoot = Join-Path $localAppData $bundleIdentifier
$roamingDataRoot = Join-Path $roamingAppData $bundleIdentifier
$defaultInstallRoot = Join-Path $localAppData $productName
$preexistingLocalDataRoot = Test-Path -LiteralPath $localDataRoot
$preexistingRoamingDataRoot = Test-Path -LiteralPath $roamingDataRoot
$preexistingDefaultInstallRoot = Test-Path -LiteralPath $defaultInstallRoot
if (
    -not $identity.IsAuthenticated -or
    -not [Environment]::UserInteractive -or
    -not $profileRegistryQueryAvailable -or
    -not $tokenProfilePathMatchesEnvironment -or
    -not $localAppDataMatchesTokenProfile -or
    -not $roamingAppDataMatchesTokenProfile -or
    $preexistingProcesses.Count -ne 0 -or
    $preexistingRegistration -or
    $preexistingLocalDataRoot -or
    $preexistingRoamingDataRoot -or
    $preexistingDefaultInstallRoot -or
    $preexistingShortcut -or
    $preexistingRunValue
) {
    throw "uninstall-choice probe requires a clean interactive current-user boundary with a matching token profile"
}

$runId = (Get-Date).ToUniversalTime().ToString("yyyyMMddTHHmmssfffZ")
$qaBase = Join-Path $localAppData "Temp"
$qaRoot = Join-Path $qaBase "yuanyuan-uninstall-choice-$runId"
$installRoot = Join-Path $qaRoot "installed"
$qaMarkerName = ".yuanyuan-uninstall-choice-v1"
$qaMarkerValue = "YUANYUAN_UNINSTALL_CHOICE_QA_V1`n"
$dataMarkerName = ".yuanyuan-uninstall-choice-data-v1"
$localMarkerValue = "YUANYUAN_UNINSTALL_CHOICE_LOCAL_DATA_V1`n"
$roamingMarkerValue = "YUANYUAN_UNINSTALL_CHOICE_ROAMING_DATA_V1`n"
$localSentinelPath = Join-Path $localDataRoot "uninstall-choice-local-sentinel.txt"
$roamingSentinelPath = Join-Path $roamingDataRoot "uninstall-choice-roaming-sentinel.txt"
$report = $null
$qaRootRemoved = $false
$localDataRootRemoved = $false
$roamingDataRootRemoved = $false
$desktopShortcutRemoved = $false
$startMenuShortcutRemoved = $false

New-Item -ItemType Directory -Path $qaRoot | Out-Null
[IO.File]::WriteAllText(
    (Join-Path $qaRoot $qaMarkerName),
    $qaMarkerValue,
    [Text.UTF8Encoding]::new($false)
)
foreach ($dataSpec in @(
    [ordered]@{ root = $localDataRoot; marker = $localMarkerValue; sentinel = $localSentinelPath; value = "LOCAL:$runId`n" },
    [ordered]@{ root = $roamingDataRoot; marker = $roamingMarkerValue; sentinel = $roamingSentinelPath; value = "ROAMING:$runId`n" }
)) {
    New-Item -ItemType Directory -Path $dataSpec.root | Out-Null
    [IO.File]::WriteAllText(
        (Join-Path $dataSpec.root $dataMarkerName),
        $dataSpec.marker,
        [Text.UTF8Encoding]::new($false)
    )
    [IO.File]::WriteAllText(
        $dataSpec.sentinel,
        $dataSpec.value,
        [Text.UTF8Encoding]::new($false)
    )
}
$localSentinelSha256 = Get-Sha256 $localSentinelPath
$roamingSentinelSha256 = Get-Sha256 $roamingSentinelPath

try {
    $preserveInstallExitCode = Invoke-SilentInstall $candidateInstallerPath $installRoot
    $preserveInstallState = Get-InstalledCoreState `
        $installRoot `
        $candidateVersion `
        $candidatePayloadBytes `
        $candidatePayloadSha256
    $preserveUninstallExitCode = Invoke-SilentUninstall $installRoot
    $preserveInstallRootRemoved = -not (Test-Path -LiteralPath $installRoot)
    $localPreserved = Test-Sentinel $localSentinelPath $localSentinelSha256
    $roamingPreserved = Test-Sentinel $roamingSentinelPath $roamingSentinelSha256

    $deleteInstallExitCode = Invoke-SilentInstall $candidateInstallerPath $installRoot
    $deleteInstallState = Get-InstalledCoreState `
        $installRoot `
        $candidateVersion `
        $candidatePayloadBytes `
        $candidatePayloadSha256
    $explicitDelete = Invoke-ExplicitDeleteUninstall $installRoot $UiTimeoutSeconds
    Start-Sleep -Milliseconds 750
    $deleteInstallRootRemoved = -not (Test-Path -LiteralPath $installRoot)
    $localDeleted = -not (Test-Path -LiteralPath $localDataRoot)
    $roamingDeleted = -not (Test-Path -LiteralPath $roamingDataRoot)

    if (Test-Path -LiteralPath $uninstallKey) {
        $uninstallRoot = [string](Get-ItemProperty -LiteralPath $uninstallKey).InstallLocation
        if (-not (Test-SamePath $uninstallRoot $installRoot)) {
            throw "refusing to remove uninstall registration outside the owned QA installation"
        }
        Remove-Item -LiteralPath $uninstallKey -Recurse -Force -ErrorAction Stop
    }
    if (Test-Path -LiteralPath $productKey) {
        $productRoot = [string](Get-Item -LiteralPath $productKey).GetValue("")
        if (-not (Test-SamePath $productRoot $installRoot)) {
            throw "refusing to remove product registration outside the owned QA installation"
        }
        Remove-Item -LiteralPath $productKey -Recurse -Force -ErrorAction Stop
    }
    $desktopShortcutRemoved = Remove-OwnedShortcut `
        $desktopShortcut `
        (Join-Path $installRoot "yuanyuan-reminder.exe")
    $startMenuShortcutRemoved = Remove-OwnedShortcut `
        $programsShortcut `
        (Join-Path $installRoot "yuanyuan-reminder.exe")

    $report = [ordered]@{
        schemaVersion = 1
        generatedAt = (Get-Date).ToUniversalTime().ToString("o")
        mode = "release_uninstall_data_choice_probe"
        ready = $false
        bindings = [ordered]@{
            probeScriptSha256 = Get-Sha256 $scriptPath
            candidateInstallerSha256 = $candidateInstallerSha256
            candidateInstalledCoreSha256 = $candidatePayloadSha256
            candidateInstallerBytes = $candidateInstallerBytes
        }
        version = $candidateVersion
        environment = [ordered]@{
            currentUserAuthenticated = [bool]$identity.IsAuthenticated
            interactiveSession = [Environment]::UserInteractive
            profileRegistryQueryAvailable = $profileRegistryQueryAvailable
            tokenProfilePathMatchesEnvironment = $tokenProfilePathMatchesEnvironment
            localAppDataMatchesTokenProfile = $localAppDataMatchesTokenProfile
            roamingAppDataMatchesTokenProfile = $roamingAppDataMatchesTokenProfile
            preexistingApplicationProcessCount = $preexistingProcesses.Count
            preexistingProductRegistration = $preexistingRegistration
            preexistingLocalDataRoot = $preexistingLocalDataRoot
            preexistingRoamingDataRoot = $preexistingRoamingDataRoot
            preexistingDefaultInstallRoot = $preexistingDefaultInstallRoot
            preexistingShortcut = $preexistingShortcut
            preexistingRunValue = $preexistingRunValue
            customTemporaryInstallRootUsed = $true
        }
        scenarios = [ordered]@{
            defaultPreserve = [ordered]@{
                installExitCode = $preserveInstallExitCode
                installedProductVersion = $preserveInstallState.installedProductVersion
                installedCoreBytes = $preserveInstallState.installedCoreBytes
                installedCoreSha256 = $preserveInstallState.installedCoreSha256
                installedCoreMatches = $preserveInstallState.installedCoreMatches
                uninstallExitCode = $preserveUninstallExitCode
                installRootRemoved = $preserveInstallRootRemoved
                localDataSentinelPreserved = $localPreserved
                roamingDataSentinelPreserved = $roamingPreserved
            }
            explicitDelete = [ordered]@{
                installExitCode = $deleteInstallExitCode
                installedProductVersion = $deleteInstallState.installedProductVersion
                installedCoreBytes = $deleteInstallState.installedCoreBytes
                installedCoreSha256 = $deleteInstallState.installedCoreSha256
                installedCoreMatches = $deleteInstallState.installedCoreMatches
                checkboxFound = $explicitDelete.checkboxFound
                checkboxInitiallyOff = $explicitDelete.checkboxInitiallyOff
                checkboxToggledOn = $explicitDelete.checkboxToggledOn
                uninstallButtonInvoked = $explicitDelete.uninstallButtonInvoked
                completionButtonInvoked = $explicitDelete.completionButtonInvoked
                processTreeTimedOut = $explicitDelete.processTreeTimedOut
                ownedProcessCountAfter = $explicitDelete.ownedProcessCountAfter
                observedButtonNames = @($explicitDelete.observedButtonNames)
                installRootRemoved = $deleteInstallRootRemoved
                localDataRootRemoved = $localDeleted
                roamingDataRootRemoved = $roamingDeleted
            }
        }
        dataBoundary = [ordered]@{
            syntheticSentinelsOnly = $true
            authenticUserDataUsed = $false
            localSentinelSha256 = $localSentinelSha256
            roamingSentinelSha256 = $roamingSentinelSha256
        }
        cleanup = [ordered]@{
            ownedRegistrationRemoved = -not (Test-Path -LiteralPath $uninstallKey) -and
                -not (Test-Path -LiteralPath $productKey)
            desktopShortcutRemoved = $desktopShortcutRemoved
            startMenuShortcutRemoved = $startMenuShortcutRemoved
            localDataRootRemoved = $localDeleted
            roamingDataRootRemoved = $roamingDeleted
            qaRootRemoved = $false
            applicationProcessCount = @(Get-Process -Name "yuanyuan-reminder" -ErrorAction SilentlyContinue).Count
            uninstallerProcessCount = $explicitDelete.ownedProcessCountAfter
        }
        limitations = $limitations
    }
}
finally {
    if (Test-Path -LiteralPath (Join-Path $installRoot "uninstall.exe") -PathType Leaf) {
        try { Invoke-SilentUninstall $installRoot | Out-Null } catch {}
    }
    if (Test-Path -LiteralPath $uninstallKey) {
        try {
            $uninstallRoot = [string](Get-ItemProperty -LiteralPath $uninstallKey).InstallLocation
            if (Test-SamePath $uninstallRoot $installRoot) {
                Remove-Item -LiteralPath $uninstallKey -Recurse -Force -ErrorAction SilentlyContinue
            }
        } catch {}
    }
    if (Test-Path -LiteralPath $productKey) {
        try {
            $productRoot = [string](Get-Item -LiteralPath $productKey).GetValue("")
            if (Test-SamePath $productRoot $installRoot) {
                Remove-Item -LiteralPath $productKey -Recurse -Force -ErrorAction SilentlyContinue
            }
        } catch {}
    }
    try {
        $desktopShortcutRemoved = Remove-OwnedShortcut `
            $desktopShortcut `
            (Join-Path $installRoot "yuanyuan-reminder.exe")
    } catch {}
    try {
        $startMenuShortcutRemoved = Remove-OwnedShortcut `
            $programsShortcut `
            (Join-Path $installRoot "yuanyuan-reminder.exe")
    } catch {}
    if (Test-Path -LiteralPath $localDataRoot -PathType Container) {
        $localDataRootRemoved = Remove-OwnedDirectory `
            $localDataRoot `
            $dataMarkerName `
            $localMarkerValue `
            $localAppData
    } else { $localDataRootRemoved = $true }
    if (Test-Path -LiteralPath $roamingDataRoot -PathType Container) {
        $roamingDataRootRemoved = Remove-OwnedDirectory `
            $roamingDataRoot `
            $dataMarkerName `
            $roamingMarkerValue `
            $roamingAppData
    } else { $roamingDataRootRemoved = $true }
    $qaRootRemoved = Remove-OwnedDirectory `
        $qaRoot `
        $qaMarkerName `
        $qaMarkerValue `
        $qaBase
}

if ($null -eq $report) {
    throw "uninstall-choice probe did not produce a report"
}
$report.cleanup.desktopShortcutRemoved = $desktopShortcutRemoved
$report.cleanup.startMenuShortcutRemoved = $startMenuShortcutRemoved
$report.cleanup.localDataRootRemoved = $localDataRootRemoved
$report.cleanup.roamingDataRootRemoved = $roamingDataRootRemoved
$report.cleanup.qaRootRemoved = $qaRootRemoved
$report.ready =
    $report.environment.currentUserAuthenticated -and
    $report.environment.interactiveSession -and
    $report.environment.profileRegistryQueryAvailable -and
    $report.environment.tokenProfilePathMatchesEnvironment -and
    $report.environment.localAppDataMatchesTokenProfile -and
    $report.environment.roamingAppDataMatchesTokenProfile -and
    $report.environment.preexistingApplicationProcessCount -eq 0 -and
    -not $report.environment.preexistingProductRegistration -and
    -not $report.environment.preexistingLocalDataRoot -and
    -not $report.environment.preexistingRoamingDataRoot -and
    -not $report.environment.preexistingDefaultInstallRoot -and
    -not $report.environment.preexistingShortcut -and
    -not $report.environment.preexistingRunValue -and
    $report.environment.customTemporaryInstallRootUsed -and
    $report.scenarios.defaultPreserve.installExitCode -eq 0 -and
    $report.scenarios.defaultPreserve.installedCoreMatches -and
    $report.scenarios.defaultPreserve.uninstallExitCode -eq 0 -and
    $report.scenarios.defaultPreserve.installRootRemoved -and
    $report.scenarios.defaultPreserve.localDataSentinelPreserved -and
    $report.scenarios.defaultPreserve.roamingDataSentinelPreserved -and
    $report.scenarios.explicitDelete.installExitCode -eq 0 -and
    $report.scenarios.explicitDelete.installedCoreMatches -and
    $report.scenarios.explicitDelete.checkboxFound -and
    $report.scenarios.explicitDelete.checkboxInitiallyOff -and
    $report.scenarios.explicitDelete.checkboxToggledOn -and
    $report.scenarios.explicitDelete.uninstallButtonInvoked -and
    $report.scenarios.explicitDelete.completionButtonInvoked -and
    -not $report.scenarios.explicitDelete.processTreeTimedOut -and
    $report.scenarios.explicitDelete.ownedProcessCountAfter -eq 0 -and
    $report.scenarios.explicitDelete.installRootRemoved -and
    $report.scenarios.explicitDelete.localDataRootRemoved -and
    $report.scenarios.explicitDelete.roamingDataRootRemoved -and
    $report.dataBoundary.syntheticSentinelsOnly -and
    -not $report.dataBoundary.authenticUserDataUsed -and
    $report.cleanup.ownedRegistrationRemoved -and
    $report.cleanup.desktopShortcutRemoved -and
    $report.cleanup.startMenuShortcutRemoved -and
    $report.cleanup.localDataRootRemoved -and
    $report.cleanup.roamingDataRootRemoved -and
    $report.cleanup.qaRootRemoved -and
    $report.cleanup.applicationProcessCount -eq 0 -and
    $report.cleanup.uninstallerProcessCount -eq 0

$report | ConvertTo-Json -Depth 10 | Set-Content -Encoding UTF8 -LiteralPath $reportPath
Write-Output "Release uninstall data-choice probe report written: $reportPath"
if (-not $report.ready) { exit 2 }
