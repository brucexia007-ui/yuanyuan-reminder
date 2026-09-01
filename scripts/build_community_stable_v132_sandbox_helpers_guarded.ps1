$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"
. (Join-Path $PSScriptRoot "assert_runtime_qa_exclusive.ps1")
Assert-YuanyuanRuntimeQaExclusive -Activity "Authentic v1.3.2 Windows Sandbox compatibility helper build"

$projectRoot = Split-Path -Parent $PSScriptRoot
$tauriRoot = Join-Path $projectRoot "src-tauri"
$originalRustFlags = [Environment]::GetEnvironmentVariable("RUSTFLAGS", "Process")

Push-Location $tauriRoot
try {
    $env:RUSTFLAGS = "-C target-feature=+crt-static"
    & cargo build `
        --release `
        --locked `
        --features migration-qa `
        --bin yuanyuan-database-migration-qa `
        --bin yuanyuan-database-migration-qa-capture
    if ($LASTEXITCODE -ne 0) {
        throw "authentic v1.3.2 compatibility helper build failed with exit code $LASTEXITCODE"
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
