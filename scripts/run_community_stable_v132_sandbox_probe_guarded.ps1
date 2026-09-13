param(
    [int]$TimeoutSeconds = 300,
    [switch]$AllowDirty
)

$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"
. (Join-Path $PSScriptRoot "assert_runtime_qa_exclusive.ps1")
Assert-YuanyuanRuntimeQaExclusive -Activity "Authentic v1.3.2 Windows Sandbox compatibility build and run"

if ($TimeoutSeconds -lt 120 -or $TimeoutSeconds -gt 900) {
    throw "TimeoutSeconds must be between 120 and 900"
}

$projectRoot = Split-Path -Parent $PSScriptRoot
$hostScript = Join-Path $PSScriptRoot "run_community_stable_v132_sandbox_probe_host.ps1"

Push-Location $projectRoot
try {
    & npm.cmd run release:community:v132-sandbox:helper
    if ($LASTEXITCODE -ne 0) {
        throw "authentic v1.3.2 compatibility helper build failed with exit code $LASTEXITCODE"
    }

    $hostOutput = @(
        & powershell.exe `
            -NoProfile `
            -ExecutionPolicy Bypass `
            -File $hostScript `
            -TimeoutSeconds $TimeoutSeconds 2>&1
    )
    $hostExitCode = $LASTEXITCODE
    $hostOutput | ForEach-Object { Write-Output $_ }
    if ($hostExitCode -ne 0) {
        throw "authentic v1.3.2 Windows Sandbox compatibility E2E failed with exit code $hostExitCode"
    }

    $evidenceMarkerPrefix = "YUANYUAN_V132_EVIDENCE_ROOT="
    $evidenceMarkers = @(
        $hostOutput |
            ForEach-Object { [string]$_ } |
            Where-Object { $_.StartsWith($evidenceMarkerPrefix, [StringComparison]::Ordinal) }
    )
    if ($evidenceMarkers.Count -ne 1) {
        throw "authentic v1.3.2 Windows Sandbox compatibility E2E must emit exactly one evidence-root marker"
    }
    $evidenceRoot = $evidenceMarkers[0].Substring($evidenceMarkerPrefix.Length)
    if ([string]::IsNullOrWhiteSpace($evidenceRoot) -or -not [IO.Path]::IsPathRooted($evidenceRoot)) {
        throw "authentic v1.3.2 Windows Sandbox compatibility E2E emitted an invalid evidence-root marker"
    }

    $verificationArguments = @(
        "scripts/verify_community_stable_v132_evidence.mjs",
        "--evidence-root",
        $evidenceRoot
    )
    if ($AllowDirty) {
        $verificationArguments += "--allow-dirty"
    }
    & node @verificationArguments
    if ($LASTEXITCODE -ne 0) {
        throw "authentic v1.3.2 independent verification failed with exit code $LASTEXITCODE"
    }
}
finally {
    Pop-Location
}
