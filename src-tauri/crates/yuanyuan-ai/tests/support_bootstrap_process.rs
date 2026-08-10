#![cfg(windows)]

use std::{
    io::{Read, Write},
    path::{Path, PathBuf},
    process::{Child, Command, Stdio},
    thread,
    time::{Duration, Instant},
};

use yuanyuan_ai::{
    request_task_service_health, request_task_service_shutdown, send_one_support_sort_request,
    SupportSortSessionBootstrap,
};
use yuanyuan_bridge::current_process_identity;
use yuanyuan_protocol::{
    SupportSortIpcCommandV1, SupportSortIpcDestination, SupportSortIpcRejectionCode,
    SupportSortIpcRequestV1, SupportSortIpcResultV1, SUPPORT_SORT_IPC_PROTOCOL_VERSION,
};

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

    fn captured_output(&mut self) -> (Vec<u8>, Vec<u8>) {
        let mut stdout = Vec::new();
        if let Some(mut pipe) = self.0.stdout.take() {
            pipe.read_to_end(&mut stdout).unwrap();
        }
        let mut stderr = Vec::new();
        if let Some(mut pipe) = self.0.stderr.take() {
            pipe.read_to_end(&mut stderr).unwrap();
        }
        (stdout, stderr)
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

fn spawn_with_bootstrap_stdin(
    executable: &Path,
    local_app_data: &Path,
    pipe_name: &str,
) -> ChildGuard {
    let database = local_app_data.join("ai-bootstrap.sqlite3");
    let spool = local_app_data.join("bootstrap-spool");
    ChildGuard(
        Command::new(executable)
            .args([
                "--pipe-name",
                pipe_name,
                "--database",
                database.to_str().unwrap(),
                "--spool",
                spool.to_str().unwrap(),
                "--support-bootstrap-stdin",
            ])
            .env("LOCALAPPDATA", local_app_data)
            .stdin(Stdio::piped())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .unwrap(),
    )
}

fn spawn_with_canary_provider(
    executable: &Path,
    local_app_data: &Path,
    pipe_name: &str,
) -> ChildGuard {
    let database = local_app_data.join("ai-privacy-canary.sqlite3");
    let spool = local_app_data.join("privacy-canary-spool");
    ChildGuard(
        Command::new(executable)
            .args([
                "--pipe-name",
                pipe_name,
                "--database",
                database.to_str().unwrap(),
                "--spool",
                spool.to_str().unwrap(),
                "--support-bootstrap-stdin",
                "--test-support-sort-canary-provider",
            ])
            .env("LOCALAPPDATA", local_app_data)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .unwrap(),
    )
}

fn regular_files_below(root: &Path) -> Vec<PathBuf> {
    fn visit(directory: &Path, files: &mut Vec<PathBuf>) {
        for entry in std::fs::read_dir(directory).unwrap() {
            let entry = entry.unwrap();
            let metadata = std::fs::symlink_metadata(entry.path()).unwrap();
            assert!(!metadata.file_type().is_symlink());
            if metadata.is_dir() {
                visit(&entry.path(), files);
            } else if metadata.is_file() {
                files.push(entry.path());
            }
        }
    }

    let mut files = Vec::new();
    visit(root, &mut files);
    files
}

fn contains_bytes(haystack: &[u8], needle: &[u8]) -> bool {
    !needle.is_empty()
        && haystack
            .windows(needle.len())
            .any(|window| window == needle)
}

fn wait_for_health(control_pipe: &str) {
    let deadline = Instant::now() + Duration::from_secs(3);
    while Instant::now() < deadline {
        if request_task_service_health(control_pipe).is_ok() {
            return;
        }
        thread::sleep(Duration::from_millis(25));
    }
    panic!("AI process with private bootstrap did not become healthy");
}

fn request_shutdown(control_pipe: &str) {
    let deadline = Instant::now() + Duration::from_secs(2);
    while Instant::now() < deadline {
        if request_task_service_shutdown(control_pipe).is_ok() {
            return;
        }
        thread::sleep(Duration::from_millis(25));
    }
    panic!("AI process with private bootstrap did not accept shutdown");
}

#[test]
fn valid_private_stdin_bootstrap_starts_and_shuts_down_the_ai_process() {
    let executable = Path::new(env!("CARGO_BIN_EXE_yuanyuan-ai"));
    let directory = tempfile::tempdir().unwrap();
    let pipe = format!("yuanyuan.ai.bootstrap.valid.{}", std::process::id());
    let control_pipe = format!("{pipe}.shutdown");
    let bootstrap =
        SupportSortSessionBootstrap::generate(current_process_identity().unwrap()).unwrap();
    let mut child = spawn_with_bootstrap_stdin(executable, directory.path(), &pipe);

    let mut stdin = child.0.stdin.take().unwrap();
    bootstrap.write_to(&mut stdin).unwrap();
    stdin.flush().unwrap();
    drop(stdin);

    wait_for_health(&control_pipe);
    let response = send_one_support_sort_request(
        bootstrap.support_pipe_name(),
        &SupportSortIpcRequestV1 {
            protocol_version: SUPPORT_SORT_IPC_PROTOCOL_VERSION,
            request_id: "real-process-describe-1".to_owned(),
            session_binding: bootstrap.session_binding().to_owned(),
            command: SupportSortIpcCommandV1::DescribeProvider {
                destination: SupportSortIpcDestination::LocalProvider,
            },
        },
    )
    .unwrap();
    assert!(matches!(
        response.result,
        SupportSortIpcResultV1::Rejected {
            code: SupportSortIpcRejectionCode::ProviderUnavailable
        }
    ));
    request_shutdown(&control_pipe);
    assert!(child.wait_for_exit(Duration::from_secs(2)));
}

#[test]
fn malformed_private_stdin_bootstrap_fails_before_service_startup() {
    let executable = Path::new(env!("CARGO_BIN_EXE_yuanyuan-ai"));
    let directory = tempfile::tempdir().unwrap();
    let pipe = format!("yuanyuan.ai.bootstrap.invalid.{}", std::process::id());
    let control_pipe = format!("{pipe}.shutdown");
    let mut child = spawn_with_bootstrap_stdin(executable, directory.path(), &pipe);

    let mut stdin = child.0.stdin.take().unwrap();
    stdin.write_all(br#"{}"#).unwrap();
    stdin.flush().unwrap();
    drop(stdin);

    assert!(child.wait_for_exit(Duration::from_secs(2)));
    assert!(request_task_service_health(&control_pipe).is_err());
    assert!(!directory.path().join("ai-bootstrap.sqlite3").exists());
}

#[test]
fn bootstrap_bound_to_a_non_parent_identity_fails_before_service_startup() {
    let executable = Path::new(env!("CARGO_BIN_EXE_yuanyuan-ai"));
    let directory = tempfile::tempdir().unwrap();
    let pipe = format!("yuanyuan.ai.bootstrap.wrong-parent.{}", std::process::id());
    let control_pipe = format!("{pipe}.shutdown");
    let mut wrong_parent = current_process_identity().unwrap();
    wrong_parent.creation_time_100ns = wrong_parent.creation_time_100ns.saturating_add(1);
    let bootstrap = SupportSortSessionBootstrap::generate(wrong_parent).unwrap();
    let mut child = spawn_with_bootstrap_stdin(executable, directory.path(), &pipe);

    let mut stdin = child.0.stdin.take().unwrap();
    bootstrap.write_to(&mut stdin).unwrap();
    stdin.flush().unwrap();
    drop(stdin);

    assert!(child.wait_for_exit(Duration::from_secs(2)));
    assert!(request_task_service_health(&control_pipe).is_err());
    assert!(!directory.path().join("ai-bootstrap.sqlite3").exists());
}

#[test]
fn forced_termination_requires_a_fresh_private_bootstrap_before_restart() {
    let executable = Path::new(env!("CARGO_BIN_EXE_yuanyuan-ai"));
    let directory = tempfile::tempdir().unwrap();
    let pipe = format!("yuanyuan.ai.bootstrap.restart.{}", std::process::id());
    let control_pipe = format!("{pipe}.shutdown");
    let identity = current_process_identity().unwrap();
    let first_bootstrap = SupportSortSessionBootstrap::generate(identity).unwrap();
    let mut first = spawn_with_bootstrap_stdin(executable, directory.path(), &pipe);
    let mut first_stdin = first.0.stdin.take().unwrap();
    first_bootstrap.write_to(&mut first_stdin).unwrap();
    drop(first_stdin);
    wait_for_health(&control_pipe);

    first.0.kill().unwrap();
    assert!(first.wait_for_exit(Duration::from_secs(2)));

    let mut missing = spawn_with_bootstrap_stdin(executable, directory.path(), &pipe);
    drop(missing.0.stdin.take());
    assert!(missing.wait_for_exit(Duration::from_secs(2)));
    assert!(request_task_service_health(&control_pipe).is_err());

    let fresh_bootstrap = SupportSortSessionBootstrap::generate(identity).unwrap();
    assert_ne!(
        first_bootstrap.session_binding(),
        fresh_bootstrap.session_binding()
    );
    let mut restarted = spawn_with_bootstrap_stdin(executable, directory.path(), &pipe);
    let mut restarted_stdin = restarted.0.stdin.take().unwrap();
    fresh_bootstrap.write_to(&mut restarted_stdin).unwrap();
    drop(restarted_stdin);
    wait_for_health(&control_pipe);
    request_shutdown(&control_pipe);
    assert!(restarted.wait_for_exit(Duration::from_secs(2)));
}

#[test]
fn real_support_sort_canary_reaches_the_provider_without_entering_output_or_local_files() {
    const CANARY: &str = "YUANYUAN_SUPPORT_SORT_PRIVATE_TEXT_CANARY_7F2C19A4";

    let executable = Path::new(env!("CARGO_BIN_EXE_yuanyuan-ai"));
    let directory = tempfile::tempdir().unwrap();
    let pipe = format!("yuanyuan.ai.bootstrap.privacy.{}", std::process::id());
    let control_pipe = format!("{pipe}.shutdown");
    let bootstrap =
        SupportSortSessionBootstrap::generate(current_process_identity().unwrap()).unwrap();
    let mut child = spawn_with_canary_provider(executable, directory.path(), &pipe);

    let mut stdin = child.0.stdin.take().unwrap();
    bootstrap.write_to(&mut stdin).unwrap();
    stdin.flush().unwrap();
    drop(stdin);
    wait_for_health(&control_pipe);

    let description = send_one_support_sort_request(
        bootstrap.support_pipe_name(),
        &SupportSortIpcRequestV1 {
            protocol_version: SUPPORT_SORT_IPC_PROTOCOL_VERSION,
            request_id: "privacy-describe-1".to_owned(),
            session_binding: bootstrap.session_binding().to_owned(),
            command: SupportSortIpcCommandV1::DescribeProvider {
                destination: SupportSortIpcDestination::LocalProvider,
            },
        },
    )
    .unwrap();
    let (provider_key, provider_fingerprint, disclosure_version, disclosure_digest) =
        match &description.result {
            SupportSortIpcResultV1::ProviderDescription {
                provider_key,
                provider_fingerprint,
                disclosure_version,
                disclosure_digest,
                ..
            } => (
                provider_key.clone(),
                provider_fingerprint.clone(),
                *disclosure_version,
                disclosure_digest.clone(),
            ),
            _ => panic!("debug-only canary provider was not described"),
        };

    let authorization = send_one_support_sort_request(
        bootstrap.support_pipe_name(),
        &SupportSortIpcRequestV1 {
            protocol_version: SUPPORT_SORT_IPC_PROTOCOL_VERSION,
            request_id: "privacy-authorize-1".to_owned(),
            session_binding: bootstrap.session_binding().to_owned(),
            command: SupportSortIpcCommandV1::IssueAuthorization {
                destination: SupportSortIpcDestination::LocalProvider,
                provider_key: provider_key.clone(),
                provider_fingerprint: provider_fingerprint.clone(),
                disclosure_version,
                disclosure_digest,
                user_confirmed: true,
            },
        },
    )
    .unwrap();
    let authorization_token = match &authorization.result {
        SupportSortIpcResultV1::AuthorizationIssued {
            authorization_token,
            one_use: true,
            ..
        } => authorization_token.clone(),
        _ => panic!("debug-only canary authorization was not issued"),
    };

    let completed = send_one_support_sort_request(
        bootstrap.support_pipe_name(),
        &SupportSortIpcRequestV1 {
            protocol_version: SUPPORT_SORT_IPC_PROTOCOL_VERSION,
            request_id: "privacy-submit-1".to_owned(),
            session_binding: bootstrap.session_binding().to_owned(),
            command: SupportSortIpcCommandV1::Submit {
                authorization_token,
                destination: SupportSortIpcDestination::LocalProvider,
                provider_key,
                provider_fingerprint,
                disclosure_version,
                user_entered_text: CANARY.to_owned(),
            },
        },
    )
    .unwrap();
    assert!(matches!(
        &completed.result,
        SupportSortIpcResultV1::SortCompleted { .. }
    ));

    request_shutdown(&control_pipe);
    assert!(child.wait_for_exit(Duration::from_secs(2)));
    let (stdout, stderr) = child.captured_output();
    assert!(stdout.is_empty());
    assert!(stderr.is_empty());

    let canary = CANARY.as_bytes();
    let files = regular_files_below(directory.path());
    assert!(!files.is_empty());
    for file in files {
        let bytes = std::fs::read(&file).unwrap();
        assert!(
            !contains_bytes(&bytes, canary),
            "privacy canary escaped into {}",
            file.display()
        );
    }
    let product_root = directory.path().join("Yuanyuan");
    assert!(!product_root.join("logs").exists());
    assert!(!product_root.join("diagnostics").exists());
    assert!(!product_root.join("backups").exists());
}
