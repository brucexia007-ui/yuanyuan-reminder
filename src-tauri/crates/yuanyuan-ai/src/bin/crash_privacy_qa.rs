#![cfg(windows)]

use std::{
    env,
    ffi::OsString,
    fs::{self, File, OpenOptions},
    io::{self, Read, Write},
    os::windows::fs::MetadataExt,
    path::{Path, PathBuf},
    process::{Child, Command, ExitStatus, Stdio},
    thread,
    time::{Duration, Instant, SystemTime},
};

use serde::Serialize;
use sha2::{Digest, Sha256};
use yuanyuan_ai::{
    request_task_service_health, send_one_support_sort_request, SupportSortSessionBootstrap,
};
use yuanyuan_bridge::{apply_current_user_only_dacl, current_process_identity};
use yuanyuan_protocol::{
    SupportSortIpcCommandV1, SupportSortIpcDestination, SupportSortIpcRequestV1,
    SupportSortIpcResultV1, SUPPORT_SORT_IPC_PROTOCOL_VERSION,
};
use zeroize::{Zeroize, Zeroizing};

const REPORT_SCHEMA_VERSION: u16 = 1;
const QA_MODE: &str = "actual_ai_support_sort_abnormal_termination_capture";
const REQUIRED_ATTESTATION: &str = "isolated_windows_crash_privacy_capture_v1";
const CANARY_DERIVATION: &str = "sha256_nonce_context_v1";
const CANARY_PREFIX: &str = "YUANYUAN_CRASH_PRIVACY_CANARY_V1_";
const CRASH_FLAG: &str = "--test-support-sort-crash-after-submit";
const FILE_ATTRIBUTE_REPARSE_POINT: u32 = 0x400;
const CHILD_DEADLINE: Duration = Duration::from_secs(8);
const ROOT_SETTLE_DEADLINE: Duration = Duration::from_secs(15);
const ROOT_SETTLE_MINIMUM: Duration = Duration::from_secs(5);
const ROOT_SETTLE_INTERVAL: Duration = Duration::from_millis(250);
const MAX_SCAN_FILES: u64 = 100_000;
const MAX_SCAN_BYTES: u64 = 64 * 1024 * 1024 * 1024;
const QA_SOURCE: &[u8] = include_bytes!("crash_privacy_qa.rs");
const AI_MAIN_SOURCE: &[u8] = include_bytes!("../main.rs");
const CRASH_POLICY_SOURCE: &[u8] = include_bytes!("../crash_privacy.rs");

struct Options {
    report: PathBuf,
    workspace: PathBuf,
    dump_roots: Vec<PathBuf>,
    attestation: String,
}

impl Options {
    fn parse(arguments: impl IntoIterator<Item = OsString>) -> Result<Self, String> {
        let mut report = None;
        let mut workspace = None;
        let mut dump_roots = Vec::new();
        let mut attestation = None;
        let mut arguments = arguments.into_iter();
        while let Some(argument) = arguments.next() {
            match argument.to_string_lossy().as_ref() {
                "--report" if report.is_none() => {
                    report = Some(PathBuf::from(
                        arguments.next().ok_or("--report requires a path")?,
                    ));
                }
                "--workspace" if workspace.is_none() => {
                    workspace = Some(PathBuf::from(
                        arguments.next().ok_or("--workspace requires a path")?,
                    ));
                }
                "--dump-root" => dump_roots.push(PathBuf::from(
                    arguments.next().ok_or("--dump-root requires a path")?,
                )),
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
        if dump_roots.is_empty() {
            return Err("at least one dedicated dump root is required".into());
        }
        Ok(Self {
            report: report.ok_or("--report is required")?,
            workspace: workspace.ok_or("--workspace is required")?,
            dump_roots,
            attestation,
        })
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ScanSummary {
    roots_scanned: usize,
    files_scanned: u64,
    bytes_scanned: u64,
    unreadable_files: u64,
    reparse_points_rejected: u64,
    utf8_matches: u64,
    utf16_le_matches: u64,
}

impl ScanSummary {
    fn passed(&self) -> bool {
        self.roots_scanned > 0
            && self.unreadable_files == 0
            && self.reparse_points_rejected == 0
            && self.utf8_matches == 0
            && self.utf16_le_matches == 0
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct CrashPrivacyCaptureReport {
    schema_version: u16,
    mode: &'static str,
    generated_at_unix_milliseconds: u128,
    attestation: String,
    binary_profile: &'static str,
    qa_source_sha256: String,
    ai_main_source_sha256: String,
    crash_policy_source_sha256: String,
    qa_executable_sha256: String,
    ai_executable_sha256: String,
    canary_derivation: &'static str,
    canary_nonce_hex: String,
    canary_sha256: String,
    provider_described: bool,
    one_use_authorization_issued: bool,
    canary_submit_transport_interrupted: bool,
    abnormal_exit_observed: bool,
    abnormal_exit_code: String,
    standard_output_utf8_matches: u64,
    standard_output_utf16_le_matches: u64,
    application_data_scan: ScanSummary,
    dump_root_scan: ScanSummary,
    ready_for_offline_memory_scan: bool,
    outcome: &'static str,
}

impl CrashPrivacyCaptureReport {
    fn validate(&self) -> Result<(), String> {
        let nonce = decode_upper_hex_32(&self.canary_nonce_hex)?;
        let canary = derive_canary(&nonce);
        let expected_ready = self.binary_profile == "release_with_crash_privacy_qa_feature"
            && self.qa_source_sha256 == sha256_hex(QA_SOURCE)
            && self.ai_main_source_sha256 == sha256_hex(AI_MAIN_SOURCE)
            && self.crash_policy_source_sha256 == sha256_hex(CRASH_POLICY_SOURCE)
            && self.canary_derivation == CANARY_DERIVATION
            && self.canary_sha256 == sha256_hex(canary.as_bytes())
            && self.provider_described
            && self.one_use_authorization_issued
            && self.canary_submit_transport_interrupted
            && self.abnormal_exit_observed
            && self.abnormal_exit_code != "success"
            && self.standard_output_utf8_matches == 0
            && self.standard_output_utf16_le_matches == 0
            && self.application_data_scan.passed()
            && self.dump_root_scan.passed();
        if self.schema_version != REPORT_SCHEMA_VERSION
            || self.mode != QA_MODE
            || self.attestation != REQUIRED_ATTESTATION
            || self.qa_executable_sha256.len() != 64
            || self.ai_executable_sha256.len() != 64
            || self.ready_for_offline_memory_scan != expected_ready
            || self.outcome
                != if expected_ready {
                    "capture_passed"
                } else {
                    "capture_failed"
                }
        {
            return Err("crash privacy capture report invariants failed".into());
        }
        Ok(())
    }
}

struct ChildCleanup(Child);

impl ChildCleanup {
    fn wait_for_exit(&mut self, timeout: Duration) -> Result<ExitStatus, String> {
        let deadline = Instant::now() + timeout;
        loop {
            if let Some(status) = self
                .0
                .try_wait()
                .map_err(|_| "AI process status could not be queried")?
            {
                return Ok(status);
            }
            if Instant::now() >= deadline {
                return Err("AI process did not terminate within the crash deadline".into());
            }
            thread::sleep(Duration::from_millis(20));
        }
    }
}

impl Drop for ChildCleanup {
    fn drop(&mut self) {
        if self.0.try_wait().is_ok_and(|status| status.is_none()) {
            let _ = self.0.kill();
            let _ = self.0.wait();
        }
    }
}

fn main() -> std::process::ExitCode {
    let options = match Options::parse(env::args_os().skip(1)) {
        Ok(options) => options,
        Err(error) => {
            eprintln!(
                "Crash privacy capture arguments are invalid: {error}. usage: \
                 yuanyuan-crash-privacy-qa --report <absolute-new-json> \
                 --workspace <absolute-empty-directory> --dump-root <absolute-empty-directory> \
                 [--dump-root <absolute-empty-directory> ...] \
                 --attest-isolated-test-host {REQUIRED_ATTESTATION}"
            );
            return std::process::ExitCode::from(2);
        }
    };
    match run_capture(&options) {
        Ok(report) => {
            let ready = report.ready_for_offline_memory_scan;
            if let Err(error) = write_report(&options.report, &report) {
                eprintln!("Crash privacy capture report could not be written: {error}");
                return std::process::ExitCode::from(2);
            }
            if ready {
                println!("Crash privacy capture passed; offline memory backing scan is required");
                std::process::ExitCode::SUCCESS
            } else {
                eprintln!("Crash privacy capture failed; no offline evidence may be finalized");
                std::process::ExitCode::from(2)
            }
        }
        Err(error) => {
            eprintln!("Crash privacy capture could not be completed: {error}");
            std::process::ExitCode::from(2)
        }
    }
}

fn run_capture(options: &Options) -> Result<CrashPrivacyCaptureReport, String> {
    validate_report_destination(&options.report)?;
    validate_empty_ordinary_directory(&options.workspace, "workspace")?;
    for dump_root in &options.dump_roots {
        validate_empty_ordinary_directory(dump_root, "dump root")?;
    }
    reject_overlapping_roots(&options.workspace, &options.dump_roots)?;
    apply_current_user_only_dacl(&options.workspace)
        .map_err(|_| "workspace current-user permissions could not be applied")?;

    let qa_executable = env::current_exe().map_err(|_| "QA executable is unavailable")?;
    let executable_name = if cfg!(windows) {
        "yuanyuan-ai.exe"
    } else {
        "yuanyuan-ai"
    };
    let ai_executable = qa_executable
        .parent()
        .ok_or("QA executable parent is unavailable")?
        .join(executable_name);
    validate_ordinary_file(&ai_executable, "QA-instrumented AI executable")?;

    let mut nonce = Zeroizing::new([0_u8; 32]);
    getrandom::fill(&mut nonce[..]).map_err(|_| "canary random generation failed")?;
    let mut canary = Zeroizing::new(derive_canary(&nonce));
    let canary_nonce_hex = upper_hex(&nonce[..]);
    let canary_sha256 = sha256_hex(canary.as_bytes());
    let local_app_data = options.workspace.join("local-app-data");
    fs::create_dir(&local_app_data)
        .map_err(|_| "isolated local application data directory could not be created")?;
    apply_current_user_only_dacl(&local_app_data)
        .map_err(|_| "isolated local application data permissions could not be applied")?;

    let pipe_name = format!("yuanyuan.crash-privacy-qa.{}", std::process::id());
    let control_pipe = format!("{pipe_name}.shutdown");
    let database = local_app_data.join("crash-privacy.sqlite3");
    let spool = local_app_data.join("crash-privacy-spool");
    let bootstrap = SupportSortSessionBootstrap::generate(
        current_process_identity().map_err(|_| "QA parent identity is unavailable")?,
    )
    .map_err(|_| "private AI bootstrap could not be generated")?;
    let mut child = ChildCleanup(
        Command::new(&ai_executable)
            .args([
                "--pipe-name",
                &pipe_name,
                "--database",
                database.to_str().ok_or("database path is not Unicode")?,
                "--spool",
                spool.to_str().ok_or("spool path is not Unicode")?,
                "--support-bootstrap-stdin",
                "--test-support-sort-canary-provider",
                CRASH_FLAG,
            ])
            .env("LOCALAPPDATA", &local_app_data)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .map_err(|_| "QA-instrumented AI process could not be created")?,
    );
    let mut stdin = child
        .0
        .stdin
        .take()
        .ok_or("private AI bootstrap pipe was not inherited")?;
    bootstrap
        .write_to(&mut stdin)
        .and_then(|_| {
            stdin
                .flush()
                .map_err(|_| yuanyuan_ai::SupportSortBootstrapError::Io)
        })
        .map_err(|_| "private AI bootstrap could not be delivered")?;
    drop(stdin);
    wait_for_health(&control_pipe)?;

    let description = send_one_support_sort_request(
        bootstrap.support_pipe_name(),
        &SupportSortIpcRequestV1 {
            protocol_version: SUPPORT_SORT_IPC_PROTOCOL_VERSION,
            request_id: "crash-privacy-describe-1".to_owned(),
            session_binding: bootstrap.session_binding().to_owned(),
            command: SupportSortIpcCommandV1::DescribeProvider {
                destination: SupportSortIpcDestination::LocalProvider,
            },
        },
    )
    .map_err(|_| "QA crash provider could not be described")?;
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
            _ => return Err("QA crash provider description was rejected".into()),
        };
    let provider_described = true;

    let authorization = send_one_support_sort_request(
        bootstrap.support_pipe_name(),
        &SupportSortIpcRequestV1 {
            protocol_version: SUPPORT_SORT_IPC_PROTOCOL_VERSION,
            request_id: "crash-privacy-authorize-1".to_owned(),
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
    .map_err(|_| "QA crash provider authorization could not be issued")?;
    let authorization_token = match &authorization.result {
        SupportSortIpcResultV1::AuthorizationIssued {
            authorization_token,
            one_use: true,
            ..
        } => authorization_token.clone(),
        _ => return Err("QA crash provider authorization was rejected".into()),
    };
    let one_use_authorization_issued = true;

    let submit_result = send_one_support_sort_request(
        bootstrap.support_pipe_name(),
        &SupportSortIpcRequestV1 {
            protocol_version: SUPPORT_SORT_IPC_PROTOCOL_VERSION,
            request_id: "crash-privacy-submit-1".to_owned(),
            session_binding: bootstrap.session_binding().to_owned(),
            command: SupportSortIpcCommandV1::Submit {
                authorization_token,
                destination: SupportSortIpcDestination::LocalProvider,
                provider_key,
                provider_fingerprint,
                disclosure_version,
                user_entered_text: canary.to_string(),
            },
        },
    );
    let canary_submit_transport_interrupted = submit_result.is_err();
    canary.zeroize();
    let status = child.wait_for_exit(CHILD_DEADLINE)?;
    let abnormal_exit_observed = !status.success();
    let abnormal_exit_code = format_exit_status(status);
    let (mut stdout, mut stderr) = take_child_output(&mut child.0)?;
    wait_for_roots_to_settle(&options.dump_roots)?;

    let canary = Zeroizing::new(derive_canary(&nonce));
    let utf16_canary = Zeroizing::new(utf16_le(canary.as_str()));
    let standard_output_utf8_matches =
        count_matches(&stdout, canary.as_bytes()) + count_matches(&stderr, canary.as_bytes());
    let standard_output_utf16_le_matches =
        count_matches(&stdout, &utf16_canary) + count_matches(&stderr, &utf16_canary);
    stdout.zeroize();
    stderr.zeroize();
    let application_data_scan = scan_roots(&[local_app_data], canary.as_bytes(), &utf16_canary)?;
    let dump_root_scan = scan_roots(&options.dump_roots, canary.as_bytes(), &utf16_canary)?;
    let ready_for_offline_memory_scan = !cfg!(debug_assertions)
        && provider_described
        && one_use_authorization_issued
        && canary_submit_transport_interrupted
        && abnormal_exit_observed
        && standard_output_utf8_matches == 0
        && standard_output_utf16_le_matches == 0
        && application_data_scan.passed()
        && dump_root_scan.passed();
    let report = CrashPrivacyCaptureReport {
        schema_version: REPORT_SCHEMA_VERSION,
        mode: QA_MODE,
        generated_at_unix_milliseconds: SystemTime::now()
            .duration_since(SystemTime::UNIX_EPOCH)
            .map_err(|_| "system clock is before the Unix epoch")?
            .as_millis(),
        attestation: options.attestation.clone(),
        binary_profile: if cfg!(debug_assertions) {
            "debug_with_crash_privacy_qa_feature"
        } else {
            "release_with_crash_privacy_qa_feature"
        },
        qa_source_sha256: sha256_hex(QA_SOURCE),
        ai_main_source_sha256: sha256_hex(AI_MAIN_SOURCE),
        crash_policy_source_sha256: sha256_hex(CRASH_POLICY_SOURCE),
        qa_executable_sha256: hash_file(&qa_executable)?,
        ai_executable_sha256: hash_file(&ai_executable)?,
        canary_derivation: CANARY_DERIVATION,
        canary_nonce_hex,
        canary_sha256,
        provider_described,
        one_use_authorization_issued,
        canary_submit_transport_interrupted,
        abnormal_exit_observed,
        abnormal_exit_code,
        standard_output_utf8_matches,
        standard_output_utf16_le_matches,
        application_data_scan,
        dump_root_scan,
        ready_for_offline_memory_scan,
        outcome: if ready_for_offline_memory_scan {
            "capture_passed"
        } else {
            "capture_failed"
        },
    };
    report.validate()?;
    Ok(report)
}

fn wait_for_health(control_pipe: &str) -> Result<(), String> {
    let deadline = Instant::now() + CHILD_DEADLINE;
    while Instant::now() < deadline {
        if request_task_service_health(control_pipe).is_ok() {
            return Ok(());
        }
        thread::sleep(Duration::from_millis(25));
    }
    Err("QA-instrumented AI process did not become healthy".into())
}

fn take_child_output(child: &mut Child) -> Result<(Vec<u8>, Vec<u8>), String> {
    let mut stdout = Vec::new();
    if let Some(mut pipe) = child.stdout.take() {
        pipe.read_to_end(&mut stdout)
            .map_err(|_| "AI standard output could not be collected")?;
    }
    let mut stderr = Vec::new();
    if let Some(mut pipe) = child.stderr.take() {
        pipe.read_to_end(&mut stderr)
            .map_err(|_| "AI standard error could not be collected")?;
    }
    Ok((stdout, stderr))
}

fn wait_for_roots_to_settle(roots: &[PathBuf]) -> Result<(), String> {
    let started = Instant::now();
    let deadline = started + ROOT_SETTLE_DEADLINE;
    let mut previous = directory_fingerprint(roots)?;
    let mut stable_samples = 0_u8;
    loop {
        thread::sleep(ROOT_SETTLE_INTERVAL);
        let current = directory_fingerprint(roots)?;
        stable_samples = if current == previous {
            stable_samples.saturating_add(1)
        } else {
            0
        };
        previous = current;
        if started.elapsed() >= ROOT_SETTLE_MINIMUM && stable_samples >= 4 {
            return Ok(());
        }
        if Instant::now() >= deadline {
            return Err("dump roots did not settle within the evidence deadline".into());
        }
    }
}

fn directory_fingerprint(roots: &[PathBuf]) -> Result<(u64, u64, u128), String> {
    fn visit(path: &Path, totals: &mut (u64, u64, u128)) -> Result<(), String> {
        for entry in fs::read_dir(path).map_err(|_| "scan root could not be enumerated")? {
            let entry = entry.map_err(|_| "scan root entry could not be enumerated")?;
            let metadata = fs::symlink_metadata(entry.path())
                .map_err(|_| "scan root entry metadata could not be read")?;
            if metadata.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT != 0 {
                return Err("scan roots must not contain reparse points".into());
            }
            if metadata.is_dir() {
                visit(&entry.path(), totals)?;
            } else if metadata.is_file() {
                totals.0 = totals.0.saturating_add(1);
                totals.1 = totals.1.saturating_add(metadata.len());
                totals.2 = totals.2.saturating_add(
                    metadata
                        .modified()
                        .ok()
                        .and_then(|time| time.duration_since(SystemTime::UNIX_EPOCH).ok())
                        .map(|duration| duration.as_nanos())
                        .unwrap_or(0),
                );
            }
        }
        Ok(())
    }
    let mut totals = (0, 0, 0);
    for root in roots {
        visit(root, &mut totals)?;
    }
    Ok(totals)
}

fn scan_roots(
    roots: &[PathBuf],
    utf8_canary: &[u8],
    utf16_canary: &[u8],
) -> Result<ScanSummary, String> {
    fn visit(
        path: &Path,
        utf8_canary: &[u8],
        utf16_canary: &[u8],
        summary: &mut ScanSummary,
    ) -> Result<(), String> {
        for entry in fs::read_dir(path).map_err(|_| "scan root could not be enumerated")? {
            let entry = entry.map_err(|_| "scan root entry could not be enumerated")?;
            let metadata = match fs::symlink_metadata(entry.path()) {
                Ok(metadata) => metadata,
                Err(_) => {
                    summary.unreadable_files = summary.unreadable_files.saturating_add(1);
                    continue;
                }
            };
            if metadata.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT != 0 {
                summary.reparse_points_rejected = summary.reparse_points_rejected.saturating_add(1);
                continue;
            }
            if metadata.is_dir() {
                visit(&entry.path(), utf8_canary, utf16_canary, summary)?;
            } else if metadata.is_file() {
                summary.files_scanned = summary.files_scanned.saturating_add(1);
                summary.bytes_scanned = summary.bytes_scanned.saturating_add(metadata.len());
                if summary.files_scanned > MAX_SCAN_FILES || summary.bytes_scanned > MAX_SCAN_BYTES
                {
                    return Err("scan roots exceed the frozen evidence limits".into());
                }
                let (utf8_matches, utf16_matches) =
                    scan_file(&entry.path(), utf8_canary, utf16_canary)?;
                summary.utf8_matches = summary.utf8_matches.saturating_add(utf8_matches);
                summary.utf16_le_matches = summary.utf16_le_matches.saturating_add(utf16_matches);
            }
        }
        Ok(())
    }
    let mut summary = ScanSummary {
        roots_scanned: roots.len(),
        files_scanned: 0,
        bytes_scanned: 0,
        unreadable_files: 0,
        reparse_points_rejected: 0,
        utf8_matches: 0,
        utf16_le_matches: 0,
    };
    for root in roots {
        visit(root, utf8_canary, utf16_canary, &mut summary)?;
    }
    Ok(summary)
}

fn scan_file(path: &Path, utf8_canary: &[u8], utf16_canary: &[u8]) -> Result<(u64, u64), String> {
    let mut file = File::open(path).map_err(|_| "scan file could not be opened")?;
    let overlap = utf8_canary.len().max(utf16_canary.len()).saturating_sub(1);
    let mut carry = Vec::with_capacity(overlap);
    let mut buffer = Zeroizing::new(vec![0_u8; 1024 * 1024]);
    let mut utf8_matches = 0_u64;
    let mut utf16_matches = 0_u64;
    loop {
        let read = file
            .read(&mut buffer[..])
            .map_err(|_| "scan file could not be read")?;
        if read == 0 {
            break;
        }
        let mut window = Zeroizing::new(Vec::with_capacity(carry.len() + read));
        window.extend_from_slice(&carry);
        window.extend_from_slice(&buffer[..read]);
        utf8_matches = utf8_matches.saturating_add(count_matches(&window, utf8_canary));
        utf16_matches = utf16_matches.saturating_add(count_matches(&window, utf16_canary));
        carry.clear();
        let keep = overlap.min(window.len());
        carry.extend_from_slice(&window[window.len() - keep..]);
    }
    carry.zeroize();
    Ok((utf8_matches, utf16_matches))
}

fn count_matches(haystack: &[u8], needle: &[u8]) -> u64 {
    if needle.is_empty() || haystack.len() < needle.len() {
        return 0;
    }
    haystack
        .windows(needle.len())
        .filter(|window| *window == needle)
        .count() as u64
}

fn derive_canary(nonce: &[u8; 32]) -> String {
    let mut digest = Sha256::new();
    digest.update(b"yuanyuan-crash-privacy-canary-v1\0");
    digest.update(nonce);
    format!("{CANARY_PREFIX}{}", upper_hex(&digest.finalize()))
}

fn utf16_le(value: &str) -> Vec<u8> {
    value
        .encode_utf16()
        .flat_map(u16::to_le_bytes)
        .collect::<Vec<_>>()
}

fn upper_hex(bytes: &[u8]) -> String {
    bytes.iter().map(|byte| format!("{byte:02X}")).collect()
}

fn decode_upper_hex_32(value: &str) -> Result<[u8; 32], String> {
    if value.len() != 64
        || !value
            .bytes()
            .all(|byte| byte.is_ascii_digit() || matches!(byte, b'A'..=b'F'))
    {
        return Err("canary nonce is invalid".into());
    }
    let mut decoded = [0_u8; 32];
    for (index, output) in decoded.iter_mut().enumerate() {
        *output = u8::from_str_radix(&value[index * 2..index * 2 + 2], 16)
            .map_err(|_| "canary nonce is invalid")?;
    }
    Ok(decoded)
}

fn sha256_hex(bytes: &[u8]) -> String {
    upper_hex(&Sha256::digest(bytes))
}

fn hash_file(path: &Path) -> Result<String, String> {
    let mut file = File::open(path).map_err(|_| "evidence executable could not be opened")?;
    let mut digest = Sha256::new();
    let mut buffer = vec![0_u8; 1024 * 1024];
    loop {
        let read = file
            .read(&mut buffer)
            .map_err(|_| "evidence executable could not be read")?;
        if read == 0 {
            break;
        }
        digest.update(&buffer[..read]);
    }
    buffer.zeroize();
    Ok(upper_hex(&digest.finalize()))
}

fn format_exit_status(status: ExitStatus) -> String {
    if status.success() {
        return "success".into();
    }
    status
        .code()
        .map(|code| format!("0x{:08X}", code as u32))
        .unwrap_or_else(|| "abnormal_without_code".into())
}

fn validate_ordinary_file(path: &Path, label: &str) -> Result<(), String> {
    let metadata = fs::symlink_metadata(path).map_err(|_| format!("{label} is unavailable"))?;
    if !path.is_absolute()
        || !metadata.is_file()
        || metadata.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT != 0
    {
        return Err(format!("{label} must be an absolute ordinary file"));
    }
    Ok(())
}

fn validate_empty_ordinary_directory(path: &Path, label: &str) -> Result<(), String> {
    let metadata = fs::symlink_metadata(path).map_err(|_| format!("{label} is unavailable"))?;
    if !path.is_absolute()
        || !metadata.is_dir()
        || metadata.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT != 0
    {
        return Err(format!("{label} must be an absolute ordinary directory"));
    }
    if fs::read_dir(path)
        .map_err(|_| format!("{label} could not be enumerated"))?
        .next()
        .is_some()
    {
        return Err(format!("{label} must be empty before capture"));
    }
    Ok(())
}

fn reject_overlapping_roots(workspace: &Path, dump_roots: &[PathBuf]) -> Result<(), String> {
    let mut roots =
        vec![fs::canonicalize(workspace).map_err(|_| "workspace could not be canonicalized")?];
    for root in dump_roots {
        roots.push(fs::canonicalize(root).map_err(|_| "dump root could not be canonicalized")?);
    }
    for (index, left) in roots.iter().enumerate() {
        for right in roots.iter().skip(index + 1) {
            if left == right || left.starts_with(right) || right.starts_with(left) {
                return Err("workspace and dump roots must not overlap".into());
            }
        }
    }
    Ok(())
}

fn validate_report_destination(path: &Path) -> Result<(), String> {
    if !path.is_absolute() || path.extension().and_then(|value| value.to_str()) != Some("json") {
        return Err("report must be a new absolute .json path".into());
    }
    let parent = path.parent().ok_or("report parent is unavailable")?;
    let metadata = fs::symlink_metadata(parent).map_err(|_| "report parent is unavailable")?;
    if !metadata.is_dir() || metadata.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT != 0 {
        return Err("report parent must be an existing ordinary directory".into());
    }
    match fs::symlink_metadata(path) {
        Ok(_) => Err("report already exists".into()),
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(()),
        Err(_) => Err("report destination could not be inspected".into()),
    }
}

fn write_report(path: &Path, report: &CrashPrivacyCaptureReport) -> Result<(), String> {
    validate_report_destination(path)?;
    report.validate()?;
    let nonce = decode_upper_hex_32(&report.canary_nonce_hex)?;
    let mut canary = Zeroizing::new(derive_canary(&nonce));
    let mut encoded =
        serde_json::to_vec_pretty(report).map_err(|_| "capture report could not be serialized")?;
    if encoded
        .windows(canary.len())
        .any(|window| window == canary.as_bytes())
    {
        encoded.zeroize();
        canary.zeroize();
        return Err("capture report must not contain the derived canary".into());
    }
    encoded.push(b'\n');
    let result = (|| {
        let mut file = OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(path)
            .map_err(|_| "capture report could not be created".to_owned())?;
        file.write_all(&encoded)
            .and_then(|_| file.sync_all())
            .map_err(|_| "capture report could not be committed".to_owned())?;
        apply_current_user_only_dacl(path)
            .map_err(|_| "capture report current-user permissions could not be applied".to_owned())
    })();
    encoded.zeroize();
    canary.zeroize();
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

    fn passing_scan() -> ScanSummary {
        ScanSummary {
            roots_scanned: 1,
            files_scanned: 1,
            bytes_scanned: 10,
            unreadable_files: 0,
            reparse_points_rejected: 0,
            utf8_matches: 0,
            utf16_le_matches: 0,
        }
    }

    fn report() -> CrashPrivacyCaptureReport {
        let nonce = [7_u8; 32];
        let canary = derive_canary(&nonce);
        CrashPrivacyCaptureReport {
            schema_version: REPORT_SCHEMA_VERSION,
            mode: QA_MODE,
            generated_at_unix_milliseconds: 1,
            attestation: REQUIRED_ATTESTATION.into(),
            binary_profile: "release_with_crash_privacy_qa_feature",
            qa_source_sha256: sha256_hex(QA_SOURCE),
            ai_main_source_sha256: sha256_hex(AI_MAIN_SOURCE),
            crash_policy_source_sha256: sha256_hex(CRASH_POLICY_SOURCE),
            qa_executable_sha256: "A".repeat(64),
            ai_executable_sha256: "B".repeat(64),
            canary_derivation: CANARY_DERIVATION,
            canary_nonce_hex: upper_hex(&nonce),
            canary_sha256: sha256_hex(canary.as_bytes()),
            provider_described: true,
            one_use_authorization_issued: true,
            canary_submit_transport_interrupted: true,
            abnormal_exit_observed: true,
            abnormal_exit_code: "0xC0000409".into(),
            standard_output_utf8_matches: 0,
            standard_output_utf16_le_matches: 0,
            application_data_scan: passing_scan(),
            dump_root_scan: passing_scan(),
            ready_for_offline_memory_scan: true,
            outcome: "capture_passed",
        }
    }

    #[test]
    fn accepts_only_the_complete_explicit_operator_contract() {
        let parsed = Options::parse(args(&[
            "--report",
            "F:\\qa\\capture.json",
            "--workspace",
            "F:\\qa\\workspace",
            "--dump-root",
            "F:\\qa\\dumps",
            "--attest-isolated-test-host",
            REQUIRED_ATTESTATION,
        ]))
        .unwrap();
        assert_eq!(parsed.dump_roots.len(), 1);
        for invalid in [
            args(&[
                "--report",
                "F:\\qa\\capture.json",
                "--workspace",
                "F:\\qa\\workspace",
                "--attest-isolated-test-host",
                REQUIRED_ATTESTATION,
            ]),
            args(&[
                "--report",
                "F:\\qa\\capture.json",
                "--workspace",
                "F:\\qa\\workspace",
                "--dump-root",
                "F:\\qa\\dumps",
                "--attest-isolated-test-host",
                "not-isolated",
            ]),
        ] {
            assert!(Options::parse(invalid).is_err());
        }
    }

    #[test]
    fn report_readiness_requires_every_capture_invariant() {
        report().validate().unwrap();
        let mut failed = report();
        failed.dump_root_scan.utf8_matches = 1;
        assert!(failed.validate().is_err());
        failed.ready_for_offline_memory_scan = false;
        failed.outcome = "capture_failed";
        failed.validate().unwrap();
    }

    #[test]
    fn canary_is_dynamic_content_free_and_covers_utf16() {
        let first = derive_canary(&[1_u8; 32]);
        let second = derive_canary(&[2_u8; 32]);
        assert_ne!(first, second);
        assert!(first.starts_with(CANARY_PREFIX));
        assert_eq!(first.len(), CANARY_PREFIX.len() + 64);
        assert_eq!(count_matches(first.as_bytes(), first.as_bytes()), 1);
        let utf16 = utf16_le(&first);
        assert_eq!(count_matches(&utf16, &utf16), 1);
    }

    #[test]
    fn streaming_scan_detects_canaries_crossing_buffer_boundaries() {
        let directory = tempfile::tempdir().unwrap();
        let canary = derive_canary(&[3_u8; 32]);
        let utf16 = utf16_le(&canary);
        let path = directory.path().join("artifact.bin");
        let mut bytes = vec![b'x'; 1024 * 1024 - 5];
        bytes.extend_from_slice(canary.as_bytes());
        bytes.extend_from_slice(&utf16);
        fs::write(&path, bytes).unwrap();
        assert_eq!(scan_file(&path, canary.as_bytes(), &utf16).unwrap(), (1, 1));
    }
}
