use std::{env, ffi::OsString, path::PathBuf, process::ExitCode};

use uuid::Uuid;
use yuanyuan_reminder_lib::store_data_lifecycle_qa::{
    capture_checkpoint, default_data_root, default_evidence_root, initialize_session,
    observe_explicit_deletion, Checkpoint, InitializeRequest,
};

#[derive(Debug)]
enum Command {
    Initialize(InitializeRequest),
    Capture {
        session_id: Uuid,
        checkpoint: Checkpoint,
    },
    ObserveDelete {
        session_id: Uuid,
    },
}

fn main() -> ExitCode {
    let result = parse_args().and_then(|command| run(command).map_err(|error| error.to_string()));
    match result {
        Ok(report) => {
            println!(
                "Store data-lifecycle QA evidence written: {}",
                report.display()
            );
            ExitCode::SUCCESS
        }
        Err(error) => {
            eprintln!("Store data-lifecycle QA stopped: {error}");
            ExitCode::from(2)
        }
    }
}

fn run(command: Command) -> Result<PathBuf, String> {
    let data_root = default_data_root().map_err(|error| error.to_string())?;
    let evidence_root = default_evidence_root().map_err(|error| error.to_string())?;
    match command {
        Command::Initialize(request) => initialize_session(&data_root, &evidence_root, &request)
            .map_err(|error| error.to_string()),
        Command::Capture {
            session_id,
            checkpoint,
        } => capture_checkpoint(&data_root, &evidence_root, session_id, checkpoint)
            .map_err(|error| error.to_string()),
        Command::ObserveDelete { session_id } => {
            observe_explicit_deletion(&data_root, &evidence_root, session_id)
                .map_err(|error| error.to_string())
        }
    }
}

fn parse_args() -> Result<Command, String> {
    parse_args_from(env::args_os().skip(1))
}

fn parse_args_from(arguments: impl IntoIterator<Item = OsString>) -> Result<Command, String> {
    let mut args = arguments.into_iter();
    let mode = args
        .next()
        .ok_or_else(usage)?
        .to_string_lossy()
        .into_owned();
    let mut session_id = None;
    let mut checkpoint = None;
    let mut candidate_sha256 = None;
    let mut manifest_sha256 = None;
    let mut runtime_sha256 = None;
    let mut disposable_attested = false;
    let mut synthetic_attested = false;
    let mut application_exited_attested = false;
    let mut explicit_delete_attested = false;
    while let Some(argument) = args.next() {
        match argument.to_string_lossy().as_ref() {
            "--session-id" => {
                session_id = Some(parse_uuid(
                    args.next().ok_or("--session-id requires a UUID")?,
                )?);
            }
            "--checkpoint" => {
                let value = args.next().ok_or("--checkpoint requires a fixed name")?;
                checkpoint = Some(
                    Checkpoint::parse(&value.to_string_lossy())
                        .map_err(|error| error.to_string())?,
                );
            }
            "--candidate-sha256" => {
                candidate_sha256 = Some(next_string(&mut args, "--candidate-sha256")?);
            }
            "--store-release-manifest-sha256" => {
                manifest_sha256 = Some(next_string(&mut args, "--store-release-manifest-sha256")?);
            }
            "--runtime-report-sha256" => {
                runtime_sha256 = Some(next_string(&mut args, "--runtime-report-sha256")?);
            }
            "--attest-disposable-windows11" => disposable_attested = true,
            "--attest-synthetic-data-only" => synthetic_attested = true,
            "--attest-application-fully-exited" => application_exited_attested = true,
            "--attest-explicit-in-app-delete" => explicit_delete_attested = true,
            "--help" | "-h" => return Err(usage()),
            unknown => return Err(format!("unknown argument: {unknown}")),
        }
    }
    let session_id = session_id.ok_or("--session-id is required")?;
    match mode.as_str() {
        "initialize" => {
            if !disposable_attested || !synthetic_attested {
                return Err(
                    "initialize requires --attest-disposable-windows11 and --attest-synthetic-data-only"
                        .into(),
                );
            }
            if checkpoint.is_some() || application_exited_attested || explicit_delete_attested {
                return Err(
                    "initialize rejects capture-only attestations and checkpoint arguments".into(),
                );
            }
            Ok(Command::Initialize(InitializeRequest {
                session_id,
                candidate_sha256: candidate_sha256.ok_or("--candidate-sha256 is required")?,
                store_release_manifest_sha256: manifest_sha256
                    .ok_or("--store-release-manifest-sha256 is required")?,
                runtime_report_sha256: runtime_sha256
                    .ok_or("--runtime-report-sha256 is required")?,
            }))
        }
        "capture" => {
            if !disposable_attested || !synthetic_attested || !application_exited_attested {
                return Err(
                    "capture requires --attest-disposable-windows11, --attest-synthetic-data-only, and --attest-application-fully-exited"
                        .into(),
                );
            }
            if candidate_sha256.is_some()
                || manifest_sha256.is_some()
                || runtime_sha256.is_some()
                || explicit_delete_attested
            {
                return Err("capture rejects initialization-only hash arguments".into());
            }
            Ok(Command::Capture {
                session_id,
                checkpoint: checkpoint.ok_or("--checkpoint is required")?,
            })
        }
        "observe-delete" => {
            if !disposable_attested
                || !synthetic_attested
                || !application_exited_attested
                || !explicit_delete_attested
            {
                return Err(
                    "observe-delete requires the disposable-Windows-11, synthetic-data-only, application-exited, and explicit-in-app-delete attestations"
                        .into(),
                );
            }
            if checkpoint.is_some()
                || candidate_sha256.is_some()
                || manifest_sha256.is_some()
                || runtime_sha256.is_some()
            {
                return Err("observe-delete rejects checkpoint and hash arguments".into());
            }
            Ok(Command::ObserveDelete { session_id })
        }
        _ => Err(usage()),
    }
}

fn next_string(args: &mut impl Iterator<Item = OsString>, option: &str) -> Result<String, String> {
    Ok(args
        .next()
        .ok_or_else(|| format!("{option} requires a value"))?
        .to_string_lossy()
        .into_owned())
}

fn parse_uuid(value: OsString) -> Result<Uuid, String> {
    Uuid::parse_str(&value.to_string_lossy()).map_err(|_| "--session-id must be a UUID".into())
}

fn usage() -> String {
    "usage: yuanyuan-store-data-lifecycle-qa <initialize|capture|observe-delete> --session-id <uuid> [fixed mode arguments]"
        .into()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn args(values: &[&str]) -> Vec<OsString> {
        values.iter().map(OsString::from).collect()
    }

    fn session() -> String {
        Uuid::new_v4().to_string()
    }

    #[test]
    fn initialize_requires_both_safety_attestations() {
        let id = session();
        let candidate = "A".repeat(64);
        let manifest = "B".repeat(64);
        let runtime = "C".repeat(64);
        let values = [
            "initialize",
            "--session-id",
            &id,
            "--candidate-sha256",
            &candidate,
            "--store-release-manifest-sha256",
            &manifest,
            "--runtime-report-sha256",
            &runtime,
        ];
        assert!(parse_args_from(args(&values))
            .unwrap_err()
            .contains("requires"));
    }

    #[test]
    fn capture_accepts_only_a_fixed_checkpoint_and_exit_attestation() {
        let id = session();
        assert!(matches!(
            parse_args_from(args(&[
                "capture",
                "--session-id",
                &id,
                "--checkpoint",
                "backup_restored",
                "--attest-disposable-windows11",
                "--attest-synthetic-data-only",
                "--attest-application-fully-exited",
            ]))
            .unwrap(),
            Command::Capture {
                checkpoint: Checkpoint::BackupRestored,
                ..
            }
        ));
        assert!(parse_args_from(args(&[
            "capture",
            "--session-id",
            &id,
            "--checkpoint",
            "arbitrary_dump",
            "--attest-disposable-windows11",
            "--attest-synthetic-data-only",
            "--attest-application-fully-exited",
        ]))
        .is_err());
    }

    #[test]
    fn deletion_observation_requires_explicit_delete_and_exit_attestations() {
        let id = session();
        assert!(parse_args_from(args(&[
            "observe-delete",
            "--session-id",
            &id,
            "--attest-disposable-windows11",
            "--attest-synthetic-data-only",
            "--attest-application-fully-exited",
        ]))
        .is_err());
        assert!(matches!(
            parse_args_from(args(&[
                "observe-delete",
                "--session-id",
                &id,
                "--attest-disposable-windows11",
                "--attest-synthetic-data-only",
                "--attest-application-fully-exited",
                "--attest-explicit-in-app-delete",
            ]))
            .unwrap(),
            Command::ObserveDelete { .. }
        ));
    }
}
