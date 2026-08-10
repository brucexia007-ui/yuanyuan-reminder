#![cfg(windows)]

use std::{fs::File, path::Path, sync::Arc};

use serde::Deserialize;

use crate::windows_artifact_trust::{
    artifact_file_identity, file_identity_at, open_locked_release_artifact, verify_authenticode,
    AuthenticodeEvidence, AuthenticodeIdentity,
};

const AI_RELEASE_TRUST_POLICY: &str = include_str!("../resources/ai-release-trust-policy-v1.json");
const AI_RELEASE_TRUST_POLICY_SCHEMA_VERSION: u16 = 1;
const MAX_PUBLISHER_BYTES: usize = 256;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct AiReleaseTrustPolicyWire {
    schema_version: u16,
    enabled: bool,
    publisher: Option<String>,
    certificate_sha256: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct AiReleaseTrustPolicy {
    publisher: String,
    certificate_sha256: [u8; 32],
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum AiReleaseTrustError {
    InvalidPolicy,
    UnsafeArtifact,
    SignatureInvalid,
    PublisherMismatch,
    CertificateMismatch,
    ArtifactChanged,
}

trait AiReleaseSignatureVerifier {
    fn verify(&self, file: &File, path: &Path) -> AuthenticodeEvidence;
}

struct WindowsAiReleaseSignatureVerifier;

impl AiReleaseSignatureVerifier for WindowsAiReleaseSignatureVerifier {
    fn verify(&self, file: &File, path: &Path) -> AuthenticodeEvidence {
        verify_authenticode(file, path)
    }
}

/// Keeps both verified paths locked against writers and replacers for the
/// lifetime of the supervisor configuration. This type intentionally exposes
/// only the already reviewed AI path and no signer material.
pub(crate) struct TrustedAiRelease {
    executable: std::path::PathBuf,
    _stable_core_lock: File,
    _ai_lock: File,
}

impl TrustedAiRelease {
    pub(crate) fn executable(&self) -> &Path {
        &self.executable
    }
}

pub(crate) fn verify_production_ai_release(
    stable_core: &Path,
    ai_executable: &Path,
) -> Option<Arc<TrustedAiRelease>> {
    let policy = parse_release_policy(AI_RELEASE_TRUST_POLICY)
        .ok()
        .flatten()?;
    verify_ai_release_with(
        stable_core,
        ai_executable,
        &policy,
        &WindowsAiReleaseSignatureVerifier,
    )
    .ok()
    .map(Arc::new)
}

fn parse_release_policy(input: &str) -> Result<Option<AiReleaseTrustPolicy>, AiReleaseTrustError> {
    let wire: AiReleaseTrustPolicyWire =
        serde_json::from_str(input).map_err(|_| AiReleaseTrustError::InvalidPolicy)?;
    if wire.schema_version != AI_RELEASE_TRUST_POLICY_SCHEMA_VERSION {
        return Err(AiReleaseTrustError::InvalidPolicy);
    }
    if !wire.enabled {
        return if wire.publisher.is_none() && wire.certificate_sha256.is_none() {
            Ok(None)
        } else {
            Err(AiReleaseTrustError::InvalidPolicy)
        };
    }
    let publisher = wire.publisher.ok_or(AiReleaseTrustError::InvalidPolicy)?;
    if publisher.is_empty()
        || publisher.len() > MAX_PUBLISHER_BYTES
        || publisher.trim() != publisher
        || publisher.chars().any(char::is_control)
    {
        return Err(AiReleaseTrustError::InvalidPolicy);
    }
    let certificate_sha256 = decode_sha256(
        wire.certificate_sha256
            .as_deref()
            .ok_or(AiReleaseTrustError::InvalidPolicy)?,
    )?;
    Ok(Some(AiReleaseTrustPolicy {
        publisher,
        certificate_sha256,
    }))
}

fn decode_sha256(value: &str) -> Result<[u8; 32], AiReleaseTrustError> {
    if value.len() != 64
        || !value
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'A'..=b'F').contains(&byte))
    {
        return Err(AiReleaseTrustError::InvalidPolicy);
    }
    let mut decoded = [0_u8; 32];
    for (index, chunk) in value.as_bytes().chunks_exact(2).enumerate() {
        let pair = std::str::from_utf8(chunk).map_err(|_| AiReleaseTrustError::InvalidPolicy)?;
        decoded[index] =
            u8::from_str_radix(pair, 16).map_err(|_| AiReleaseTrustError::InvalidPolicy)?;
    }
    Ok(decoded)
}

fn verify_ai_release_with(
    stable_core: &Path,
    ai_executable: &Path,
    policy: &AiReleaseTrustPolicy,
    verifier: &dyn AiReleaseSignatureVerifier,
) -> Result<TrustedAiRelease, AiReleaseTrustError> {
    if stable_core.file_name().and_then(|name| name.to_str()) != Some("yuanyuan-reminder.exe")
        || ai_executable.file_name().and_then(|name| name.to_str()) != Some("yuanyuan-ai.exe")
        || stable_core.parent() != ai_executable.parent()
    {
        return Err(AiReleaseTrustError::UnsafeArtifact);
    }
    let (stable_core_file, stable_core_identity) = open_locked_release_artifact(stable_core)
        .map_err(|_| AiReleaseTrustError::UnsafeArtifact)?;
    let (ai_file, ai_identity) = open_locked_release_artifact(ai_executable)
        .map_err(|_| AiReleaseTrustError::UnsafeArtifact)?;

    validate_signature(verifier.verify(&stable_core_file, stable_core), policy)?;
    validate_signature(verifier.verify(&ai_file, ai_executable), policy)?;
    if artifact_file_identity(&stable_core_file).ok() != Some(stable_core_identity)
        || artifact_file_identity(&ai_file).ok() != Some(ai_identity)
        || file_identity_at(stable_core).ok() != Some(stable_core_identity)
        || file_identity_at(ai_executable).ok() != Some(ai_identity)
    {
        return Err(AiReleaseTrustError::ArtifactChanged);
    }

    Ok(TrustedAiRelease {
        executable: ai_executable.to_path_buf(),
        _stable_core_lock: stable_core_file,
        _ai_lock: ai_file,
    })
}

fn validate_signature(
    evidence: AuthenticodeEvidence,
    policy: &AiReleaseTrustPolicy,
) -> Result<(), AiReleaseTrustError> {
    let AuthenticodeEvidence::Verified(AuthenticodeIdentity {
        publisher,
        certificate_sha256,
    }) = evidence
    else {
        return Err(AiReleaseTrustError::SignatureInvalid);
    };
    if !publisher.eq_ignore_ascii_case(&policy.publisher) {
        return Err(AiReleaseTrustError::PublisherMismatch);
    }
    if certificate_sha256 != policy.certificate_sha256 {
        return Err(AiReleaseTrustError::CertificateMismatch);
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    const CERTIFICATE: [u8; 32] = [0xAB; 32];
    const PUBLISHER: &str = "Yuanyuan Release Test";

    struct FixedVerifier;

    impl AiReleaseSignatureVerifier for FixedVerifier {
        fn verify(&self, _file: &File, path: &Path) -> AuthenticodeEvidence {
            let stem = path.file_stem().and_then(|value| value.to_str());
            let (publisher, certificate_sha256) = match stem {
                Some("bad-publisher") => ("Other Publisher", CERTIFICATE),
                Some("bad-certificate") => (PUBLISHER, [0xCD; 32]),
                Some("invalid-signature") => return AuthenticodeEvidence::Invalid,
                _ => (PUBLISHER, CERTIFICATE),
            };
            AuthenticodeEvidence::Verified(AuthenticodeIdentity {
                publisher: publisher.to_owned(),
                certificate_sha256,
            })
        }
    }

    fn policy() -> AiReleaseTrustPolicy {
        AiReleaseTrustPolicy {
            publisher: PUBLISHER.to_owned(),
            certificate_sha256: CERTIFICATE,
        }
    }

    fn release_files() -> (tempfile::TempDir, std::path::PathBuf, std::path::PathBuf) {
        let directory = tempfile::tempdir().unwrap();
        let stable_core = directory.path().join("yuanyuan-reminder.exe");
        let ai = directory.path().join("yuanyuan-ai.exe");
        std::fs::write(&stable_core, b"stable core fixture").unwrap();
        std::fs::write(&ai, b"AI fixture").unwrap();
        (directory, stable_core, ai)
    }

    #[test]
    fn compiled_release_policy_is_explicitly_closed() {
        assert!(parse_release_policy(AI_RELEASE_TRUST_POLICY)
            .unwrap()
            .is_none());
        let (_directory, stable_core, ai) = release_files();
        assert!(verify_production_ai_release(&stable_core, &ai).is_none());
    }

    #[test]
    fn policy_schema_requires_a_complete_canonical_identity_or_explicit_off() {
        let certificate_hex = "AB".repeat(32);
        let enabled = format!(
            r#"{{"schemaVersion":1,"enabled":true,"publisher":"{PUBLISHER}","certificateSha256":"{certificate_hex}"}}"#
        );
        assert_eq!(parse_release_policy(&enabled).unwrap(), Some(policy()));
        for invalid in [
            r#"{"schemaVersion":1,"enabled":false,"publisher":"x","certificateSha256":null}"#,
            r#"{"schemaVersion":2,"enabled":false,"publisher":null,"certificateSha256":null}"#,
            r#"{"schemaVersion":1,"enabled":true,"publisher":" padded ","certificateSha256":"AB"}"#,
            r#"{"schemaVersion":1,"enabled":true,"publisher":"x","certificateSha256":"abababababababababababababababababababababababababababababababab"}"#,
            r#"{"schemaVersion":1,"enabled":false,"publisher":null,"certificateSha256":null,"extra":true}"#,
        ] {
            assert_eq!(
                parse_release_policy(invalid),
                Err(AiReleaseTrustError::InvalidPolicy)
            );
        }
    }

    #[test]
    fn exact_locked_sibling_signatures_are_required() {
        let (_directory, stable_core, ai) = release_files();
        let trusted = verify_ai_release_with(&stable_core, &ai, &policy(), &FixedVerifier).unwrap();
        assert_eq!(trusted.executable(), ai);

        let moved = ai.with_extension("previous");
        assert!(std::fs::rename(&ai, &moved).is_err());
        drop(trusted);
        std::fs::rename(&ai, &moved).unwrap();
    }

    #[test]
    fn wrong_name_publisher_certificate_or_signature_fails_closed() {
        let (_directory, stable_core, ai) = release_files();
        for name in [
            "bad-publisher.exe",
            "bad-certificate.exe",
            "invalid-signature.exe",
        ] {
            let candidate = ai.with_file_name(name);
            std::fs::write(&candidate, b"untrusted AI fixture").unwrap();
            assert!(matches!(
                verify_ai_release_with(&stable_core, &candidate, &policy(), &FixedVerifier),
                Err(AiReleaseTrustError::UnsafeArtifact)
            ));
        }
        let wrong_core = stable_core.with_file_name("other-core.exe");
        std::fs::write(&wrong_core, b"untrusted core fixture").unwrap();
        assert!(matches!(
            verify_ai_release_with(&wrong_core, &ai, &policy(), &FixedVerifier),
            Err(AiReleaseTrustError::UnsafeArtifact)
        ));
    }

    #[test]
    fn signature_identity_mismatches_are_rejected_independently_of_path_checks() {
        struct MismatchVerifier {
            publisher: &'static str,
            certificate_sha256: [u8; 32],
            valid: bool,
        }
        impl AiReleaseSignatureVerifier for MismatchVerifier {
            fn verify(&self, _file: &File, _path: &Path) -> AuthenticodeEvidence {
                if !self.valid {
                    return AuthenticodeEvidence::Unavailable;
                }
                AuthenticodeEvidence::Verified(AuthenticodeIdentity {
                    publisher: self.publisher.to_owned(),
                    certificate_sha256: self.certificate_sha256,
                })
            }
        }
        let (_directory, stable_core, ai) = release_files();
        let cases = [
            (
                MismatchVerifier {
                    publisher: "Other Publisher",
                    certificate_sha256: CERTIFICATE,
                    valid: true,
                },
                AiReleaseTrustError::PublisherMismatch,
            ),
            (
                MismatchVerifier {
                    publisher: PUBLISHER,
                    certificate_sha256: [0xCD; 32],
                    valid: true,
                },
                AiReleaseTrustError::CertificateMismatch,
            ),
            (
                MismatchVerifier {
                    publisher: PUBLISHER,
                    certificate_sha256: CERTIFICATE,
                    valid: false,
                },
                AiReleaseTrustError::SignatureInvalid,
            ),
        ];
        for (verifier, expected) in cases {
            assert!(matches!(
                verify_ai_release_with(&stable_core, &ai, &policy(), &verifier),
                Err(error) if error == expected
            ));
        }
    }
}
