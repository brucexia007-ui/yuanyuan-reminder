use std::{env, ffi::OsString, path::PathBuf, process::ExitCode};

use yuanyuan_reminder_lib::migration_qa::capture_v132_runtime_fixture;

fn main() -> ExitCode {
    match parse_args().and_then(|(source, fixture, report)| {
        capture_v132_runtime_fixture(&source, &fixture, &report)
    }) {
        Ok(report) => {
            println!(
                "v1.3.2 runtime database capture passed; report: {}",
                report.display()
            );
            ExitCode::SUCCESS
        }
        Err(error) => {
            eprintln!("v1.3.2 runtime database capture failed: {error}");
            ExitCode::from(2)
        }
    }
}

fn parse_args() -> Result<(PathBuf, PathBuf, PathBuf), String> {
    parse_args_from(env::args_os().skip(1))
}

fn parse_args_from(
    arguments: impl IntoIterator<Item = OsString>,
) -> Result<(PathBuf, PathBuf, PathBuf), String> {
    let mut source = None;
    let mut fixture = None;
    let mut report = None;
    let mut source_release_attested = false;
    let mut args = arguments.into_iter();
    while let Some(argument) = args.next() {
        match argument.to_string_lossy().as_ref() {
            "--source" => {
                source = Some(PathBuf::from(
                    args.next().ok_or("--source requires a path")?,
                ));
            }
            "--fixture" => {
                fixture = Some(PathBuf::from(
                    args.next().ok_or("--fixture requires a path")?,
                ));
            }
            "--report" => {
                report = Some(PathBuf::from(
                    args.next().ok_or("--report requires a path")?,
                ));
            }
            "--attest-source-release" => {
                let release = args
                    .next()
                    .ok_or("--attest-source-release requires the exact value 1.3.2")?;
                if release != "1.3.2" {
                    return Err(
                        "--attest-source-release must be exactly 1.3.2 for this capture".into(),
                    );
                }
                source_release_attested = true;
            }
            "--help" | "-h" => {
                return Err(
                    "usage: yuanyuan-database-migration-qa-capture --source <closed-v1.3.2-runtime.sqlite3> --fixture <new-copy.sqlite3> --report <new-capture-report.json> --attest-source-release 1.3.2"
                        .into(),
                );
            }
            unknown => return Err(format!("unknown argument: {unknown}")),
        }
    }

    if !source_release_attested {
        return Err(
            "--attest-source-release 1.3.2 is required; schema version alone cannot prove release provenance"
                .into(),
        );
    }

    Ok((
        source.ok_or("--source is required")?,
        fixture.ok_or("--fixture is required")?,
        report.ok_or("--report is required")?,
    ))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn args(values: &[&str]) -> Vec<OsString> {
        values.iter().map(OsString::from).collect()
    }

    #[test]
    fn requires_an_explicit_v132_source_attestation() {
        let error = parse_args_from(args(&[
            "--source",
            "F:\\runtime.sqlite3",
            "--fixture",
            "F:\\fixture.sqlite3",
            "--report",
            "F:\\capture.json",
        ]))
        .unwrap_err();
        assert!(error.contains("schema version alone cannot prove"));
    }

    #[test]
    fn accepts_only_the_complete_explicit_contract() {
        let (source, fixture, report) = parse_args_from(args(&[
            "--source",
            "F:\\runtime.sqlite3",
            "--fixture",
            "F:\\fixture.sqlite3",
            "--report",
            "F:\\capture.json",
            "--attest-source-release",
            "1.3.2",
        ]))
        .unwrap();
        assert_eq!(source, PathBuf::from("F:\\runtime.sqlite3"));
        assert_eq!(fixture, PathBuf::from("F:\\fixture.sqlite3"));
        assert_eq!(report, PathBuf::from("F:\\capture.json"));
    }
}
