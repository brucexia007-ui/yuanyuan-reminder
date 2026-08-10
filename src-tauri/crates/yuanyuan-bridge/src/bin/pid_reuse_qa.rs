#![cfg(windows)]

use std::{
    collections::HashMap,
    env,
    ffi::OsString,
    fs::{self, OpenOptions},
    io::{self, Read, Write},
    os::windows::{
        fs::MetadataExt,
        io::{AsRawHandle, RawHandle},
    },
    path::{Path, PathBuf},
    process::{Child, ChildStdin, Command, ExitCode, Stdio},
    sync::mpsc,
    thread,
    time::{Duration, Instant},
};

use serde::Serialize;
use sha2::{Digest, Sha256};
use windows_sys::Win32::Foundation::{FILETIME, HANDLE};
use windows_sys::Win32::System::Threading::GetProcessTimes;
use yuanyuan_bridge::{
    apply_current_user_only_dacl, NamedPipeEventSink, NamedPipeServerError, WindowsNamedPipeServer,
    WindowsProcessIdentity,
};

const REPORT_SCHEMA_VERSION: u16 = 1;
const QA_MODE: &str = "windows_pid_reuse_named_pipe_identity";
const REQUIRED_ATTESTATION: &str = "isolated_windows_pid_reuse_stress_v1";
const PROBE_CHILD_ARGUMENT: &str = "--internal-probe-child";
const MINIMUM_ITERATIONS: usize = 2;
const MAXIMUM_ITERATIONS: usize = 2_000_000;
const DEFAULT_ITERATIONS: usize = 65_536;
const CHILD_DEADLINE: Duration = Duration::from_secs(3);
const MAXIMUM_CHILD_COMMAND_BYTES: u64 = 192;
const FILE_ATTRIBUTE_REPARSE_POINT: u32 = 0x400;
const IDENTITY_IMPLEMENTATION_SOURCE: &[u8] = include_bytes!("../windows_named_pipe_server.rs");

struct Options {
    report: PathBuf,
    iterations: usize,
    attestation: String,
}

enum Mode {
    Run(Options),
    ProbeChild,
}

impl Mode {
    fn parse(arguments: impl IntoIterator<Item = OsString>) -> Result<Self, String> {
        let arguments = arguments.into_iter().collect::<Vec<_>>();
        if arguments.as_slice() == [OsString::from(PROBE_CHILD_ARGUMENT)] {
            return Ok(Self::ProbeChild);
        }

        let mut report = None;
        let mut iterations = None;
        let mut attestation = None;
        let mut arguments = arguments.into_iter();
        while let Some(argument) = arguments.next() {
            match argument.to_string_lossy().as_ref() {
                "--report" if report.is_none() => {
                    report = Some(PathBuf::from(
                        arguments.next().ok_or("--report requires a path")?,
                    ));
                }
                "--iterations" if iterations.is_none() => {
                    let value = arguments
                        .next()
                        .ok_or("--iterations requires a value")?
                        .to_string_lossy()
                        .parse::<usize>()
                        .map_err(|_| "--iterations must be an integer")?;
                    if !(MINIMUM_ITERATIONS..=MAXIMUM_ITERATIONS).contains(&value) {
                        return Err(format!(
                            "--iterations must be between {MINIMUM_ITERATIONS} and {MAXIMUM_ITERATIONS}"
                        ));
                    }
                    iterations = Some(value);
                }
                "--attest-isolated-test-host" if attestation.is_none() => {
                    attestation = Some(
                        arguments
                            .next()
                            .ok_or("--attest-isolated-test-host requires the frozen value")?
                            .to_string_lossy()
                            .into_owned(),
                    );
                }
                _ => return Err("unknown, duplicate, or incomplete argument".into()),
            }
        }

        let attestation = attestation
            .filter(|value| value == REQUIRED_ATTESTATION)
            .ok_or("the exact isolated-host attestation is required")?;
        Ok(Self::Run(Options {
            report: report.ok_or("--report is required")?,
            iterations: iterations.unwrap_or(DEFAULT_ITERATIONS),
            attestation,
        }))
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct PidReuseQaReport {
    schema_version: u16,
    mode: &'static str,
    generated_at_utc: String,
    attestation: String,
    identity_implementation_sha256: String,
    requested_iterations: usize,
    completed_iterations: usize,
    distinct_process_ids: usize,
    same_pid_different_creation_time_observed: bool,
    stale_identity_rejected_before_payload_read: bool,
    outcome: &'static str,
    ready: bool,
    elapsed_milliseconds: u128,
}

impl PidReuseQaReport {
    fn validate(&self) -> Result<(), String> {
        if self.schema_version != REPORT_SCHEMA_VERSION
            || self.mode != QA_MODE
            || self.attestation != REQUIRED_ATTESTATION
            || self.identity_implementation_sha256 != sha256_hex(IDENTITY_IMPLEMENTATION_SOURCE)
            || self.requested_iterations < MINIMUM_ITERATIONS
            || self.requested_iterations > MAXIMUM_ITERATIONS
            || self.completed_iterations == 0
            || self.completed_iterations > self.requested_iterations
            || self.distinct_process_ids == 0
            || self.distinct_process_ids > self.completed_iterations
            || self.ready
                != (self.same_pid_different_creation_time_observed
                    && self.stale_identity_rejected_before_payload_read)
        {
            return Err("PID reuse report invariants failed".into());
        }
        let expected_outcome = if self.ready {
            "passed"
        } else if self.same_pid_different_creation_time_observed {
            "failed_reused_pid_not_rejected"
        } else {
            "pending_no_pid_reuse_observed"
        };
        if self.outcome != expected_outcome {
            return Err("PID reuse report outcome is inconsistent".into());
        }
        Ok(())
    }
}

fn main() -> ExitCode {
    match Mode::parse(env::args_os().skip(1)) {
        Ok(Mode::ProbeChild) => run_probe_child(),
        Ok(Mode::Run(options)) => match run_qa(&options) {
            Ok(report) => {
                let ready = report.ready;
                if let Err(error) = write_report(&options.report, &report) {
                    eprintln!("PID reuse QA could not write its report: {error}");
                    return ExitCode::from(2);
                }
                if ready {
                    println!(
                        "PID reuse QA passed after {} process creations",
                        report.completed_iterations
                    );
                    ExitCode::SUCCESS
                } else {
                    eprintln!(
                        "PID reuse QA remains pending after {} process creations; no pass was recorded",
                        report.completed_iterations
                    );
                    ExitCode::from(2)
                }
            }
            Err(error) => {
                eprintln!("PID reuse QA failed before a report could be completed: {error}");
                ExitCode::from(2)
            }
        },
        Err(error) => {
            eprintln!(
                "PID reuse QA arguments are invalid: {error}. usage: yuanyuan-pid-reuse-qa \
                 --report <absolute-new-json> [--iterations {DEFAULT_ITERATIONS}] \
                 --attest-isolated-test-host {REQUIRED_ATTESTATION}"
            );
            ExitCode::from(2)
        }
    }
}

fn run_qa(options: &Options) -> Result<PidReuseQaReport, String> {
    validate_report_destination(&options.report)?;
    let started = Instant::now();
    let mut seen = HashMap::<u32, u64>::new();
    let mut completed_iterations = 0;
    let mut reuse_observed = false;
    let mut stale_identity_rejected = false;

    for iteration in 1..=options.iterations {
        let (mut child, stdin) = spawn_probe_child()?;
        let mut cleanup = ChildCleanup(&mut child);
        let actual = child_identity(cleanup.child())?;
        completed_iterations = iteration;
        if let Some(stale) = observe_identity(&mut seen, actual) {
            reuse_observed = true;
            stale_identity_rejected =
                exercise_reused_pid_rejection(iteration, stale, cleanup.child(), stdin)?;
            break;
        }
        send_child_command(stdin, "exit")?;
        wait_for_child(cleanup.child())?;
    }

    let ready = reuse_observed && stale_identity_rejected;
    let outcome = if ready {
        "passed"
    } else if reuse_observed {
        "failed_reused_pid_not_rejected"
    } else {
        "pending_no_pid_reuse_observed"
    };
    let report = PidReuseQaReport {
        schema_version: REPORT_SCHEMA_VERSION,
        mode: QA_MODE,
        generated_at_utc: chrono::Utc::now().to_rfc3339(),
        attestation: options.attestation.clone(),
        identity_implementation_sha256: sha256_hex(IDENTITY_IMPLEMENTATION_SOURCE),
        requested_iterations: options.iterations,
        completed_iterations,
        distinct_process_ids: seen.len(),
        same_pid_different_creation_time_observed: reuse_observed,
        stale_identity_rejected_before_payload_read: stale_identity_rejected,
        outcome,
        ready,
        elapsed_milliseconds: started.elapsed().as_millis(),
    };
    report.validate()?;
    Ok(report)
}

fn observe_identity(
    seen: &mut HashMap<u32, u64>,
    actual: WindowsProcessIdentity,
) -> Option<WindowsProcessIdentity> {
    let previous = seen.insert(actual.process_id, actual.creation_time_100ns)?;
    (previous != actual.creation_time_100ns).then_some(WindowsProcessIdentity {
        process_id: actual.process_id,
        creation_time_100ns: previous,
    })
}

fn sha256_hex(bytes: &[u8]) -> String {
    Sha256::digest(bytes)
        .iter()
        .map(|byte| format!("{byte:02X}"))
        .collect()
}

fn spawn_probe_child() -> Result<(Child, ChildStdin), String> {
    let mut child = Command::new(env::current_exe().map_err(|_| "QA executable is unavailable")?)
        .arg(PROBE_CHILD_ARGUMENT)
        .stdin(Stdio::piped())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .map_err(|_| "probe child could not be created")?;
    let Some(stdin) = child.stdin.take() else {
        let _ = child.kill();
        let _ = child.wait();
        return Err("probe child stdin was not inherited".into());
    };
    Ok((child, stdin))
}

struct ChildCleanup<'a>(&'a mut Child);

impl ChildCleanup<'_> {
    fn child(&mut self) -> &mut Child {
        self.0
    }
}

impl Drop for ChildCleanup<'_> {
    fn drop(&mut self) {
        if self.0.try_wait().is_ok_and(|status| status.is_none()) {
            let _ = self.0.kill();
            let _ = self.0.wait();
        }
    }
}

fn child_identity(child: &Child) -> Result<WindowsProcessIdentity, String> {
    process_identity_from_handle(child.id(), child.as_raw_handle())
}

fn process_identity_from_handle(
    process_id: u32,
    raw_handle: RawHandle,
) -> Result<WindowsProcessIdentity, String> {
    let mut creation = FILETIME::default();
    let mut exit = FILETIME::default();
    let mut kernel = FILETIME::default();
    let mut user = FILETIME::default();
    // SAFETY: Child owns a live process handle with query access for the
    // duration of this synchronous metadata call, and every FILETIME pointer
    // references initialized writable storage.
    if unsafe {
        GetProcessTimes(
            raw_handle as HANDLE,
            &mut creation,
            &mut exit,
            &mut kernel,
            &mut user,
        )
    } == 0
    {
        return Err("probe child identity could not be queried".into());
    }
    let creation_time_100ns =
        (u64::from(creation.dwHighDateTime) << 32) | u64::from(creation.dwLowDateTime);
    let exit_time_100ns = (u64::from(exit.dwHighDateTime) << 32) | u64::from(exit.dwLowDateTime);
    if process_id == 0 || creation_time_100ns == 0 || exit_time_100ns != 0 {
        return Err("probe child was not live while its identity was captured".into());
    }
    Ok(WindowsProcessIdentity {
        process_id,
        creation_time_100ns,
    })
}

fn exercise_reused_pid_rejection(
    iteration: usize,
    stale: WindowsProcessIdentity,
    child: &mut Child,
    stdin: ChildStdin,
) -> Result<bool, String> {
    let pipe_name = format!("yuanyuan.pid-reuse-qa.{}.{}", std::process::id(), iteration);
    let server = WindowsNamedPipeServer::bind_for_client(&pipe_name, stale)
        .map_err(|_| "stale-identity test pipe could not be bound")?;
    let (sender, receiver) = mpsc::sync_channel(1);
    thread::spawn(move || {
        let result = server.accept_one().map(|_| ());
        let _ = sender.send(result);
    });
    send_child_command(stdin, &format!("connect {pipe_name}"))?;
    let result = receiver
        .recv_timeout(CHILD_DEADLINE)
        .map_err(|_| "stale-identity server did not finish within its deadline")?;
    let status = wait_for_child(child)?;
    Ok(status && result == Err(NamedPipeServerError::ClientIdentity))
}

fn send_child_command(mut stdin: ChildStdin, command: &str) -> Result<(), String> {
    if command.len() as u64 > MAXIMUM_CHILD_COMMAND_BYTES {
        return Err("internal child command exceeds its byte limit".into());
    }
    stdin
        .write_all(command.as_bytes())
        .and_then(|_| stdin.write_all(b"\n"))
        .and_then(|_| stdin.flush())
        .map_err(|_| "probe child command could not be written".to_owned())
}

fn wait_for_child(child: &mut Child) -> Result<bool, String> {
    let deadline = Instant::now() + CHILD_DEADLINE;
    loop {
        if let Some(status) = child
            .try_wait()
            .map_err(|_| "probe child status could not be queried")?
        {
            return Ok(status.success());
        }
        if Instant::now() >= deadline {
            let _ = child.kill();
            let _ = child.wait();
            return Err("probe child exceeded its deadline".into());
        }
        thread::sleep(Duration::from_millis(1));
    }
}

fn run_probe_child() -> ExitCode {
    let mut bytes = Vec::new();
    if io::stdin()
        .take(MAXIMUM_CHILD_COMMAND_BYTES + 1)
        .read_to_end(&mut bytes)
        .is_err()
        || bytes.len() as u64 > MAXIMUM_CHILD_COMMAND_BYTES
    {
        return ExitCode::from(3);
    }
    let Ok(command) = std::str::from_utf8(&bytes).map(str::trim) else {
        return ExitCode::from(3);
    };
    if command == "exit" {
        return ExitCode::SUCCESS;
    }
    let Some(pipe_name) = command.strip_prefix("connect ") else {
        return ExitCode::from(3);
    };
    let Ok(sink) = NamedPipeEventSink::new(pipe_name) else {
        return ExitCode::from(3);
    };
    let rejected = sink
        .send_validated_payload_and_receive_response_with_timeout(
            b"must-not-be-read",
            64,
            CHILD_DEADLINE,
        )
        .is_err();
    if rejected {
        ExitCode::SUCCESS
    } else {
        ExitCode::from(3)
    }
}

fn validate_report_destination(path: &Path) -> Result<(), String> {
    if !path.is_absolute() || path.extension().and_then(|value| value.to_str()) != Some("json") {
        return Err("report must be a new absolute .json path".into());
    }
    let parent = path.parent().ok_or("report parent is unavailable")?;
    let metadata = fs::metadata(parent).map_err(|_| "report parent is unavailable")?;
    if !metadata.is_dir() || metadata.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT != 0 {
        return Err("report parent must be an existing ordinary directory".into());
    }
    match fs::symlink_metadata(path) {
        Ok(_) => Err("report already exists".into()),
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(()),
        Err(_) => Err("report destination could not be inspected".into()),
    }
}

fn write_report(path: &Path, report: &PidReuseQaReport) -> Result<(), String> {
    validate_report_destination(path)?;
    report.validate()?;
    let mut encoded =
        serde_json::to_vec_pretty(report).map_err(|_| "report could not be serialized")?;
    encoded.push(b'\n');
    let result: Result<(), String> = (|| {
        let mut file = OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(path)
            .map_err(|_| "report could not be created".to_owned())?;
        file.write_all(&encoded)
            .and_then(|_| file.sync_all())
            .map_err(|_| "report could not be committed".to_owned())?;
        apply_current_user_only_dacl(path)
            .map_err(|_| "report current-user permissions could not be applied".to_owned())
    })();
    encoded.fill(0);
    if result.is_err() {
        let _ = fs::remove_file(path);
    }
    result
}

#[cfg(test)]
mod tests {
    use super::*;

    fn args(values: &[&str]) -> Vec<OsString> {
        values.iter().map(OsString::from).collect()
    }

    fn report(ready: bool) -> PidReuseQaReport {
        PidReuseQaReport {
            schema_version: REPORT_SCHEMA_VERSION,
            mode: QA_MODE,
            generated_at_utc: "2026-08-07T00:00:00Z".into(),
            attestation: REQUIRED_ATTESTATION.into(),
            identity_implementation_sha256: sha256_hex(IDENTITY_IMPLEMENTATION_SOURCE),
            requested_iterations: 10,
            completed_iterations: 10,
            distinct_process_ids: if ready { 9 } else { 10 },
            same_pid_different_creation_time_observed: ready,
            stale_identity_rejected_before_payload_read: ready,
            outcome: if ready {
                "passed"
            } else {
                "pending_no_pid_reuse_observed"
            },
            ready,
            elapsed_milliseconds: 1,
        }
    }

    #[test]
    fn accepts_only_the_complete_explicit_operator_contract() {
        let mode = Mode::parse(args(&[
            "--report",
            "F:\\qa\\pid-reuse.json",
            "--iterations",
            "2000",
            "--attest-isolated-test-host",
            REQUIRED_ATTESTATION,
        ]))
        .unwrap();
        let Mode::Run(options) = mode else {
            panic!("expected operator mode");
        };
        assert_eq!(options.report, PathBuf::from("F:\\qa\\pid-reuse.json"));
        assert_eq!(options.iterations, 2000);
        assert_eq!(options.attestation, REQUIRED_ATTESTATION);

        assert!(matches!(
            Mode::parse(args(&[PROBE_CHILD_ARGUMENT])).unwrap(),
            Mode::ProbeChild
        ));
        for invalid in [
            args(&["--report", "F:\\qa\\pid-reuse.json"]),
            args(&[
                "--report",
                "F:\\qa\\pid-reuse.json",
                "--iterations",
                "1",
                "--attest-isolated-test-host",
                REQUIRED_ATTESTATION,
            ]),
            args(&[
                "--report",
                "F:\\qa\\pid-reuse.json",
                "--attest-isolated-test-host",
                "not-reviewed",
            ]),
        ] {
            assert!(Mode::parse(invalid).is_err());
        }
    }

    #[test]
    fn only_same_pid_with_a_different_creation_time_is_reuse() {
        let mut seen = HashMap::new();
        let first = WindowsProcessIdentity {
            process_id: 42,
            creation_time_100ns: 100,
        };
        assert_eq!(observe_identity(&mut seen, first), None);
        assert_eq!(observe_identity(&mut seen, first), None);
        assert_eq!(
            observe_identity(
                &mut seen,
                WindowsProcessIdentity {
                    creation_time_100ns: 101,
                    ..first
                }
            ),
            Some(first)
        );
    }

    #[test]
    fn readiness_requires_both_real_reuse_and_exact_identity_rejection() {
        report(false).validate().unwrap();
        report(true).validate().unwrap();
        let mut invalid = report(true);
        invalid.stale_identity_rejected_before_payload_read = false;
        assert!(invalid.validate().is_err());
        let mut false_pass = report(false);
        false_pass.ready = true;
        false_pass.outcome = "passed";
        assert!(false_pass.validate().is_err());
        let mut wrong_source = report(false);
        wrong_source.identity_implementation_sha256 = "0".repeat(64);
        assert!(wrong_source.validate().is_err());
    }

    #[test]
    fn report_is_create_new_and_never_overwrites_existing_evidence() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("pid-reuse.json");
        write_report(&path, &report(false)).unwrap();
        let contents = fs::read_to_string(&path).unwrap();
        assert!(contents.contains("pending_no_pid_reuse_observed"));
        assert!(write_report(&path, &report(false)).is_err());
        assert!(validate_report_destination(Path::new("relative.json")).is_err());
    }
}
