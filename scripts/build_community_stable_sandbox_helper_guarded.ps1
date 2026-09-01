$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"
. (Join-Path $PSScriptRoot "assert_runtime_qa_exclusive.ps1")
Assert-YuanyuanRuntimeQaExclusive -Activity "Installed-candidate Windows Sandbox E2E helper build"

$projectRoot = Split-Path -Parent $PSScriptRoot
$tauriRoot = Join-Path $projectRoot "src-tauri"
$originalRustFlags = [Environment]::GetEnvironmentVariable("RUSTFLAGS", "Process")

Push-Location $tauriRoot
try {
    $env:RUSTFLAGS = "-C target-feature=+crt-static"
    & cargo build `
        --release `
        --features runtime-qa `
        --bin yuanyuan-installed-candidate-qa
    if ($LASTEXITCODE -ne 0) {
        throw "installed-candidate QA helper build failed with exit code $LASTEXITCODE"
    }
}
finally {
    if ($null -eq $originalRustFlags) {
        Remove-Item Env:RUSTFLAGS -ErrorAction SilentlyContinue
    }
    else {
        $env:RUSTFLAGS = $originalRustFlags
    }
    Pop-Location
}
