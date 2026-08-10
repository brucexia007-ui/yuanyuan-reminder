#![cfg(windows)]

use std::{
    path::Path,
    process::{Child, Command, Stdio},
    thread,
    time::{Duration, Instant, SystemTime},
};

use rusqlite::params;
use yuanyuan_ai::{
    negotiate_control_protocol, request_task_service_health_version,
    request_task_service_shutdown_version, CommitOutcome, ControlCompatibility, TaskStore,
};
use yuanyuan_bridge::{
    seal_event, AuthenticationKey, AuthenticationKeyResolver, KeyResolutionError, AUTH_NONCE_BYTES,
};
use yuanyuan_protocol::TaskEventEnvelope;

struct ChildGuard(Child);

impl ChildGuard {
    fn wait_for_exit(&mut self, timeout: Duration) -> bool {
        let deadline = Instant::now() + timeout;
        while Instant::now() < deadline {
            if matches!(self.0.try_wait(), Ok(Some(_))) {
                return true;
            }
            thread::sleep(Duration::from_millis(20));
        }
        false
    }
}

impl Drop for ChildGuard {
    fn drop(&mut self) {
        if matches!(self.0.try_wait(), Ok(None)) {
            let _ = self.0.kill();
            let _ = self.0.wait();
        }
    }
}

fn spawn_ai_fixture(
    executable: &Path,
    local_app_data: &Path,
    pipe_name: &str,
    version: u16,
) -> ChildGuard {
    let database = local_app_data.join(format!("ai-v{version}.sqlite3"));
    let spool = local_app_data.join(format!("spool-v{version}"));
    ChildGuard(
        Command::new(executable)
            .args([
                "--pipe-name",
                pipe_name,
                "--database",
                database.to_str().unwrap(),
                "--spool",
                spool.to_str().unwrap(),
                "--test-control-protocol-version",
                &version.to_string(),
            ])
            .env("LOCALAPPDATA", local_app_data)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .unwrap(),
    )
}

fn spawn_normal_ai_fixture(
    executable: &Path,
    local_app_data: &Path,
    pipe_name: &str,
) -> ChildGuard {
    let database = local_app_data.join("ai-normal.sqlite3");
    let spool = local_app_data.join("spool-normal");
    ChildGuard(
        Command::new(executable)
            .args([
                "--pipe-name",
                pipe_name,
                "--database",
                database.to_str().unwrap(),
                "--spool",
                spool.to_str().unwrap(),
            ])
            .env("LOCALAPPDATA", local_app_data)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .unwrap(),
    )
}

fn wait_for_health(control_pipe: &str, version: u16) {
    let deadline = Instant::now() + Duration::from_secs(3);
    while Instant::now() < deadline {
        if request_task_service_health_version(control_pipe, version).is_ok() {
            return;
        }
        thread::sleep(Duration::from_millis(25));
    }
    panic!("AI fixture v{version} did not become healthy");
}

struct FixtureKeys;

impl AuthenticationKeyResolver for FixtureKeys {
    fn resolve(&self, key_id: &str) -> Result<AuthenticationKey, KeyResolutionError> {
        if key_id == "codex.process-fixture" {
            AuthenticationKey::new(vec![0x64; 32]).map_err(|_| KeyResolutionError::Unavailable)
        } else {
            Err(KeyResolutionError::UnknownOrRevoked)
        }
    }
}

fn signed_fixture_event(now_unix_ms: i64) -> Vec<u8> {
    let envelope: TaskEventEnvelope = serde_json::from_value(serde_json::json!({
        "protocol_version": 1,
        "event": {
            "event_id": "evt-forced-termination",
            "connector_id": "connector-process-fixture",
            "source_instance": "codex-process-fixture",
            "task_id": "task-process-fixture",
            "run_id": "run-process-fixture",
            "source": "openai.codex",
            "external_id": "thread-process-fixture",
            "title": "Verify forced termination recovery",
            "workspace": "yuanyuan-reminder",
            "state": "running",
            "evidence_type": "hook",
            "evidence_level": "authoritative",
            "sequence": 1,
            "occurred_at": "2026-08-04T00:00:00Z",
            "received_at": "2026-08-04T00:00:00Z",
            "updated_at": "2026-08-04T00:00:00Z",
            "finality": "provisional",
            "payload_digest": "sha256:0123456789abcdef"
        }
    }))
    .unwrap();
    let key = AuthenticationKey::new(vec![0x64; 32]).unwrap();
    serde_json::to_vec(
        &seal_event(
            envelope,
            "codex.process-fixture",
            [0x17; AUTH_NONCE_BYTES],
            now_unix_ms,
            &key,
        )
        .unwrap(),
    )
    .unwrap()
}

fn request_shutdown(control_pipe: &str, version: u16) {
    let deadline = Instant::now() + Duration::from_secs(2);
    while Instant::now() < deadline {
        if request_task_service_shutdown_version(control_pipe, version).is_ok() {
            return;
        }
        thread::sleep(Duration::from_millis(25));
    }
    panic!("AI fixture v{version} did not accept shutdown");
}

fn unix_time_ms() -> i64 {
    SystemTime::now()
        .duration_since(SystemTime::UNIX_EPOCH)
        .ok()
        .and_then(|duration| i64::try_from(duration.as_millis()).ok())
        .unwrap_or(0)
}

fn seed_retention_fixture(database: &Path, now_unix_ms: i64) {
    const DAY_MS: i64 = 24 * 60 * 60 * 1_000;
    drop(TaskStore::open(database).unwrap());
    let connection = rusqlite::Connection::open(database).unwrap();
    connection
        .pragma_update(None, "foreign_keys", "ON")
        .unwrap();
    connection
        .execute(
            "INSERT INTO watched_tasks(
                task_key, connector_id, source_instance, source, workspace,
                external_id, task_id, current_run_id, parent_task_id, title,
                state, sequence, finality, latest_event_id, latest_envelope_json,
                created_at_unix_ms, updated_at_unix_ms
             ) VALUES('retention-task', 'connector', 'instance', 'test.source', NULL,
                      'external', 'task', 'run', NULL, 'redacted',
                      'running', 2, 'provisional', 'fresh-event', '{}', ?1, ?1)",
            [now_unix_ms],
        )
        .unwrap();
    for (event_id, sequence, persisted_at) in [
        ("expired-progress", 1_i64, now_unix_ms - 8 * DAY_MS),
        ("fresh-event", 2_i64, now_unix_ms),
    ] {
        connection
            .execute(
                "INSERT INTO task_events(
                    event_id, task_key, run_id, sequence, state, finality,
                    key_id, nonce, envelope_json, disposition, persisted_at_unix_ms
                 ) VALUES(?1, 'retention-task', 'run', ?2, 'running', 'provisional',
                          'key', ?3, '{}', 'applied', ?4)",
                params![event_id, sequence, vec![sequence as u8; 16], persisted_at],
            )
            .unwrap();
    }
}

#[test]
fn real_ai_processes_fail_closed_across_v1_v2_matrix() {
    let executable = Path::new(env!("CARGO_BIN_EXE_yuanyuan-ai"));
    let directory = tempfile::tempdir().unwrap();

    let v1_pipe = format!("yuanyuan.ai.compat.v1.{}", std::process::id());
    let v1_control = format!("{v1_pipe}.shutdown");
    let mut v1 = spawn_ai_fixture(executable, directory.path(), &v1_pipe, 1);
    wait_for_health(&v1_control, 1);
    assert!(request_task_service_health_version(&v1_control, 2).is_err());
    wait_for_health(&v1_control, 1);
    assert_eq!(
        negotiate_control_protocol(2, 2, 1),
        ControlCompatibility::AiTooOld
    );
    request_shutdown(&v1_control, 1);
    assert!(v1.wait_for_exit(Duration::from_secs(2)));

    let v2_pipe = format!("yuanyuan.ai.compat.v2.{}", std::process::id());
    let v2_control = format!("{v2_pipe}.shutdown");
    let mut v2 = spawn_ai_fixture(executable, directory.path(), &v2_pipe, 2);
    wait_for_health(&v2_control, 2);
    assert!(request_task_service_health_version(&v2_control, 1).is_err());
    wait_for_health(&v2_control, 2);
    assert_eq!(
        negotiate_control_protocol(1, 1, 2),
        ControlCompatibility::AiTooNew
    );
    request_shutdown(&v2_control, 2);
    assert!(v2.wait_for_exit(Duration::from_secs(2)));
}

#[test]
fn normal_service_is_healthy_and_can_exit_before_delayed_retention_runs() {
    let executable = Path::new(env!("CARGO_BIN_EXE_yuanyuan-ai"));
    let directory = tempfile::tempdir().unwrap();
    let pipe = format!("yuanyuan.ai.retention-ready.{}", std::process::id());
    let control = format!("{pipe}.shutdown");
    let started = Instant::now();
    let mut child = spawn_normal_ai_fixture(executable, directory.path(), &pipe);

    wait_for_health(&control, 1);
    assert!(started.elapsed() < Duration::from_secs(5));
    request_shutdown(&control, 1);
    assert!(child.wait_for_exit(Duration::from_secs(2)));
}

#[test]
fn normal_service_applies_delayed_retention_without_losing_health() {
    let executable = Path::new(env!("CARGO_BIN_EXE_yuanyuan-ai"));
    let directory = tempfile::tempdir().unwrap();
    let database = directory.path().join("ai-normal.sqlite3");
    seed_retention_fixture(&database, unix_time_ms());
    assert_eq!(
        TaskStore::open(&database).unwrap().event_count().unwrap(),
        2
    );

    let pipe = format!("yuanyuan.ai.retention-cycle.{}", std::process::id());
    let control = format!("{pipe}.shutdown");
    let mut child = spawn_normal_ai_fixture(executable, directory.path(), &pipe);
    wait_for_health(&control, 1);

    let deadline = Instant::now() + Duration::from_secs(8);
    loop {
        let event_count = TaskStore::open(&database).unwrap().event_count().unwrap();
        if event_count == 1 {
            break;
        }
        assert!(
            Instant::now() < deadline,
            "delayed retention did not remove the expired progress event"
        );
        thread::sleep(Duration::from_millis(50));
    }

    wait_for_health(&control, 1);
    request_shutdown(&control, 1);
    assert!(child.wait_for_exit(Duration::from_secs(2)));
}

#[test]
fn forced_termination_preserves_committed_data_and_allows_restart() {
    let executable = Path::new(env!("CARGO_BIN_EXE_yuanyuan-ai"));
    let directory = tempfile::tempdir().unwrap();
    let database = directory.path().join("ai-v1.sqlite3");
    let now_unix_ms = 1_775_212_800_000_i64;
    let mut store = TaskStore::open(&database).unwrap();
    assert_eq!(
        store
            .accept_authenticated(
                &signed_fixture_event(now_unix_ms),
                &FixtureKeys,
                now_unix_ms,
            )
            .unwrap(),
        CommitOutcome::Applied
    );
    drop(store);

    let pipe = format!("yuanyuan.ai.forced-stop.{}", std::process::id());
    let control = format!("{pipe}.shutdown");
    let mut first = spawn_ai_fixture(executable, directory.path(), &pipe, 1);
    wait_for_health(&control, 1);
    first.0.kill().unwrap();
    assert!(first.wait_for_exit(Duration::from_secs(2)));

    let reopened = TaskStore::open(&database).unwrap();
    assert_eq!(reopened.task_count().unwrap(), 1);
    assert_eq!(reopened.event_count().unwrap(), 1);
    drop(reopened);

    let mut restarted = spawn_ai_fixture(executable, directory.path(), &pipe, 1);
    wait_for_health(&control, 1);
    request_shutdown(&control, 1);
    assert!(restarted.wait_for_exit(Duration::from_secs(2)));
    let final_store = TaskStore::open(&database).unwrap();
    assert_eq!(final_store.task_count().unwrap(), 1);
    assert_eq!(final_store.event_count().unwrap(), 1);
}
