#![cfg(windows)]

use std::{
    io::Write,
    process::{Command, Output, Stdio},
    time::{Duration, Instant, SystemTime},
};

use serde_json::json;

fn run_bridge(arguments: &[&str], input: &[u8]) -> (Output, Duration) {
    let local_app_data = tempfile::tempdir().unwrap();
    run_bridge_at(arguments, input, local_app_data.path())
}

fn run_bridge_at(
    arguments: &[&str],
    input: &[u8],
    local_app_data: &std::path::Path,
) -> (Output, Duration) {
    let mut child = Command::new(env!("CARGO_BIN_EXE_yuanyuan-bridge"))
        .args(arguments)
        .env("LOCALAPPDATA", local_app_data)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .unwrap();
    child.stdin.take().unwrap().write_all(input).unwrap();
    let started = Instant::now();
    let output = child.wait_with_output().unwrap();
    (output, started.elapsed())
}

fn valid_event() -> Vec<u8> {
    serde_json::to_vec(&json!({
        "protocol_version": 1,
        "event": {
            "event_id": "evt-cli-1",
            "connector_id": "connector-cli-1",
            "source_instance": "codex-install-cli-1",
            "task_id": "task-cli-1",
            "run_id": "run-cli-1",
            "source": "openai.codex",
            "external_id": "thread-cli-1",
            "title": "Verify fail-open CLI",
            "workspace": "yuanyuan-reminder",
            "state": "running",
            "evidence_type": "hook",
            "evidence_level": "authoritative",
            "sequence": 1,
            "occurred_at": "2026-08-03T12:00:00Z",
            "received_at": "2026-08-03T12:00:00Z",
            "updated_at": "2026-08-03T12:00:00Z",
            "finality": "provisional",
            "payload_digest": "sha256:0123456789abcdef"
        }
    }))
    .unwrap()
}

fn assert_silent_success(output: &Output) {
    assert!(output.status.success());
    assert!(output.stdout.is_empty());
    assert!(output.stderr.is_empty());
}

#[test]
fn invalid_input_is_silent_and_fail_open() {
    let (output, _) = run_bridge(&[], b"not-json");
    assert_silent_success(&output);
}

#[test]
fn invalid_arguments_are_silent_and_fail_open() {
    let (output, _) = run_bridge(&["--unknown"], b"not-json");
    assert_silent_success(&output);
}

#[test]
fn a_missing_server_is_silent_and_returns_well_inside_the_target_budget() {
    let (output, elapsed) = run_bridge(
        &["--pipe-name", "yuanyuan.test.cli-definitely-missing"],
        &valid_event(),
    );
    assert_silent_success(&output);
    assert!(elapsed < Duration::from_secs(1));
}

#[test]
fn real_cli_persists_only_a_fixed_failure_code() {
    let local_app_data = tempfile::tempdir().unwrap();
    let (output, elapsed) = run_bridge_at(
        &["--pipe-name", "yuanyuan.test.cli-diagnostic"],
        &valid_event(),
        local_app_data.path(),
    );
    assert_silent_success(&output);
    assert!(elapsed < Duration::from_secs(1));
    assert_eq!(
        yuanyuan_bridge::read_bridge_diagnostics(
            &local_app_data.path().join("Yuanyuan").join("diagnostics")
        )
        .unwrap(),
        vec![yuanyuan_bridge::DiagnosticCount {
            code: yuanyuan_bridge::BridgeDiagnosticCode::InvalidJson,
            count: 1,
        }]
    );
}

#[test]
fn raw_connector_with_a_missing_credential_is_silent_and_fail_open() {
    let local_app_data = tempfile::tempdir().unwrap();
    let missing_key = format!("test.missing.raw.{}", std::process::id());
    let root = local_app_data.path().join("Yuanyuan");
    std::fs::create_dir_all(&root).unwrap();
    let now = SystemTime::now()
        .duration_since(SystemTime::UNIX_EPOCH)
        .unwrap()
        .as_millis() as i64;
    let mut trust =
        yuanyuan_bridge::ConnectorTrustStore::open(root.join("connector-trust.sqlite3")).unwrap();
    trust
        .register(
            "connector-cli-raw",
            "instance-cli-raw",
            &missing_key,
            now.saturating_sub(1_000),
        )
        .unwrap();
    let arguments = [
        "--source".to_owned(),
        "codex-notify".to_owned(),
        "--connector-id".to_owned(),
        "connector-cli-raw".to_owned(),
        "--source-instance".to_owned(),
        "instance-cli-raw".to_owned(),
        "--key-id".to_owned(),
        missing_key,
    ];
    let argument_refs: Vec<&str> = arguments.iter().map(String::as_str).collect();
    let raw = br#"{"type":"agent-turn-complete","thread-id":"thread-cli-raw"}"#;
    for _ in 0..4 {
        let (output, elapsed) = run_bridge_at(&argument_refs, raw, local_app_data.path());
        assert_silent_success(&output);
        assert!(elapsed < Duration::from_secs(1));
    }

    let health = yuanyuan_bridge::ConnectorAuthenticationHealthStore::open_existing_read_only(
        root.join("connector-authentication-health.sqlite3"),
    )
    .unwrap();
    assert!(
        health
            .status("connector-cli-raw", "instance-cli-raw")
            .unwrap()
            .unwrap()
            .paused
    );
    assert_eq!(
        yuanyuan_bridge::read_bridge_diagnostics(&root.join("diagnostics")).unwrap(),
        vec![
            yuanyuan_bridge::DiagnosticCount {
                code: yuanyuan_bridge::BridgeDiagnosticCode::AuthenticationFailed,
                count: 3,
            },
            yuanyuan_bridge::DiagnosticCount {
                code: yuanyuan_bridge::BridgeDiagnosticCode::AuthenticationPaused,
                count: 1,
            },
        ]
    );
}
