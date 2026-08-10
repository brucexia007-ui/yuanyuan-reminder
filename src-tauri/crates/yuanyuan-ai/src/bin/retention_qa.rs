use std::path::PathBuf;

use yuanyuan_ai::{run_annual_retention_qa, ANNUAL_RETENTION_QA_ATTESTATION};

struct Options {
    report: PathBuf,
    attestation: String,
}

impl Options {
    fn parse(mut arguments: impl Iterator<Item = String>) -> Option<Self> {
        let mut report = None;
        let mut attestation = None;
        while let Some(argument) = arguments.next() {
            match argument.as_str() {
                "--report" if report.is_none() => report = Some(arguments.next()?.into()),
                "--attest-synthetic-profile" if attestation.is_none() => {
                    attestation = Some(arguments.next()?)
                }
                _ => return None,
            }
        }
        Some(Self {
            report: report?,
            attestation: attestation?,
        })
    }
}

fn main() {
    let Some(options) = Options::parse(std::env::args().skip(1)) else {
        eprintln!(
            "usage: yuanyuan-retention-qa --report <absolute-new-json> \
             --attest-synthetic-profile {ANNUAL_RETENTION_QA_ATTESTATION}"
        );
        std::process::exit(2);
    };
    match run_annual_retention_qa(&options.report, &options.attestation) {
        Ok(report) if report.ready => println!(
            "retention QA passed: {} tasks, {} events, {} cleanup cycles",
            report.profile.task_rows,
            report.profile.event_rows,
            report.cleanup.cycles_with_deletions
        ),
        Ok(_) => {
            eprintln!("retention QA did not pass its correctness invariants");
            std::process::exit(2);
        }
        Err(error) => {
            eprintln!("retention QA failed: {error}");
            std::process::exit(2);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn accepts_only_the_complete_explicit_contract() {
        let options = Options::parse(
            [
                "--report",
                "C:\\qa\\report.json",
                "--attest-synthetic-profile",
                ANNUAL_RETENTION_QA_ATTESTATION,
            ]
            .into_iter()
            .map(str::to_owned),
        )
        .unwrap();
        assert_eq!(options.report, PathBuf::from("C:\\qa\\report.json"));
        assert_eq!(options.attestation, ANNUAL_RETENTION_QA_ATTESTATION);
    }

    #[test]
    fn rejects_duplicates_unknowns_and_missing_values() {
        for arguments in [
            vec!["--report", "C:\\qa\\report.json"],
            vec![
                "--attest-synthetic-profile",
                ANNUAL_RETENTION_QA_ATTESTATION,
            ],
            vec!["--report"],
            vec!["--unknown", "value"],
            vec![
                "--report",
                "C:\\qa\\one.json",
                "--report",
                "C:\\qa\\two.json",
                "--attest-synthetic-profile",
                ANNUAL_RETENTION_QA_ATTESTATION,
            ],
        ] {
            assert!(Options::parse(arguments.into_iter().map(str::to_owned)).is_none());
        }
    }
}
