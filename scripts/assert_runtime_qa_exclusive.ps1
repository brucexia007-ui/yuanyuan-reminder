function Assert-YuanyuanRuntimeQaExclusive {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory = $true)]
        [ValidateNotNullOrEmpty()]
        [string]$Activity
    )

    $projectRoot = Split-Path -Parent $PSScriptRoot
    $cargoManifestPath = Join-Path $projectRoot "src-tauri\Cargo.toml"
    $cargoManifest = Get-Content -Raw -Encoding UTF8 -LiteralPath $cargoManifestPath
    $packageBlock = [regex]::Match(
        $cargoManifest,
        '(?ms)^\[package\]\s*(.*?)(?=^\[|\z)'
    )
    $packageName = if ($packageBlock.Success) {
        [regex]::Match($packageBlock.Groups[1].Value, '(?m)^name\s*=\s*"([A-Za-z0-9_-]+)"\s*$')
    }
    else {
        $null
    }
    if ($null -eq $packageName -or -not $packageName.Success) {
        throw "$Activity cannot determine the main process name from src-tauri/Cargo.toml."
    }
    $mainProcessName = $packageName.Groups[1].Value

    $runningProduct = @(
        Get-Process -Name $mainProcessName -ErrorAction SilentlyContinue |
            Select-Object -ExpandProperty Id
    )
    if ($runningProduct.Count -gt 0) {
        $processIds = ($runningProduct | Sort-Object) -join ", "
        throw "$Activity is blocked while the product process '$mainProcessName' is running (PID: $processIds)."
    }

    $runningSandbox = @(
        Get-Process -Name "WindowsSandbox", "WindowsSandboxClient" -ErrorAction SilentlyContinue |
            Select-Object -ExpandProperty Id
    )
    if ($runningSandbox.Count -gt 0) {
        $processIds = ($runningSandbox | Sort-Object) -join ", "
        throw "$Activity is blocked while Windows Sandbox is running (PID: $processIds)."
    }
}
