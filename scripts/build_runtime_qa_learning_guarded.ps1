$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"
. (Join-Path $PSScriptRoot "assert_runtime_qa_exclusive.ps1")
Assert-YuanyuanRuntimeQaExclusive -Activity "Learning-on runtime-QA development candidate build"

$projectRoot = Split-Path -Parent $PSScriptRoot
Push-Location $projectRoot
try {
    & npm.cmd run unified:ui:build
    if ($LASTEXITCODE -ne 0) {
        throw "the unified learning-on UI build failed with exit code $LASTEXITCODE"
    }
}
finally {
    Pop-Location
}

Push-Location (Join-Path $projectRoot "src-tauri")
try {
    & cargo build `
        --locked `
        --release `
        --features "runtime-qa,learning,tauri/custom-protocol" `
        --bin yuanyuan-reminder `
        --bin yuanyuan-runtime-qa-fixture `
        --bin yuanyuan-task-watch-fixture `
        --target-dir "target/runtime-qa-learning"
    if ($LASTEXITCODE -ne 0) {
        throw "the learning-on runtime-QA development candidate build failed with exit code $LASTEXITCODE"
    }
}
finally {
    Pop-Location
}
