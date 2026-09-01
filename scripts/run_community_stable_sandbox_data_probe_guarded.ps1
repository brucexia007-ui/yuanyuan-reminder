param(
    [Parameter(Mandatory = $true)]
    [string]$ReleaseRoot,
    [int]$TimeoutSeconds = 900,
    [switch]$AllowDirty
)

$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"
. (Join-Path $PSScriptRoot "assert_runtime_qa_exclusive.ps1")
Assert-YuanyuanRuntimeQaExclusive -Activity "Installed-candidate Windows Sandbox E2E build and run"

if ($TimeoutSeconds -lt 120 -or $TimeoutSeconds -gt 1800) {
    throw "TimeoutSeconds must be between 120 and 1800"
}

$projectRoot = Split-Path -Parent $PSScriptRoot
$hostScript = Join-Path $PSScriptRoot "run_community_stable_sandbox_data_probe_host.ps1"

Push-Location $projectRoot
try {
    & npm.cmd run release:community:sandbox-e2e:helper
    if ($LASTEXITCODE -ne 0) {
        throw "installed-candidate QA helper build failed with exit code $LASTEXITCODE"
    }
    $hostOutput = @(
        & powershell.exe `
            -NoProfile `
            -ExecutionPolicy Bypass `
            -File $hostScript `
            -ReleaseRoot $ReleaseRoot `
            -TimeoutSeconds $TimeoutSeconds 2>&1
    )
    $hostExitCode = $LASTEXITCODE
    $hostOutput | ForEach-Object { Write-Output $_ }
    if ($hostExitCode -ne 0) {
        throw "installed-candidate Windows Sandbox E2E failed with exit code $hostExitCode"
    }

    $evidenceMarkerPrefix = "YUANYUAN_INSTALLED_E2E_EVIDENCE_ROOT="
    $evidenceMarkers = @(
        $hostOutput |
            ForEach-Object { [string]$_ } |
            Where-Object { $_.StartsWith($evidenceMarkerPrefix, [StringComparison]::Ordinal) }
    )
    if ($evidenceMarkers.Count -ne 1) {
        throw "installed-candidate Windows Sandbox E2E must emit exactly one evidence-root marker"
    }
    $evidenceRoot = $evidenceMarkers[0].Substring($evidenceMarkerPrefix.Length)
    if ([string]::IsNullOrWhiteSpace($evidenceRoot) -or -not [IO.Path]::IsPathRooted($evidenceRoot)) {
        throw "installed-candidate Windows Sandbox E2E emitted an invalid evidence-root marker"
    }

    $verificationArguments = @(
        "scripts/verify_community_stable_installed_e2e.mjs",
        "--evidence-root",
        $evidenceRoot
    )
    if ($AllowDirty) {
        $verificationArguments += "--allow-dirty"
    }
    & node @verificationArguments
    if ($LASTEXITCODE -ne 0) {
        throw "installed-candidate independent verification failed with exit code $LASTEXITCODE"
    }
}
finally {
    Pop-Location
}
