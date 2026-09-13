#![cfg(windows)]

use std::{
    collections::BTreeSet,
    fs::File,
    io::{Read, Seek, SeekFrom},
    path::{Path, PathBuf},
};

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use windows_sys::Win32::{
    Foundation::{ERROR_INSUFFICIENT_BUFFER, ERROR_SUCCESS},
    Storage::{
        FileSystem::FILE_ATTRIBUTE_REPARSE_POINT, Packaging::Appx::GetStagedPackagePathByFullName,
    },
};

use crate::connector_discovery::{
    is_codex_windows_app_package_path, ConnectorInstallationChannel, ConnectorKind,
};
use crate::windows_artifact_trust::{
    file_identity_at, open_ordinary_artifact, verify_authenticode, AuthenticodeEvidence,
};

const OPENAI_WINDOWS_PUBLISHER: &str = "OpenAI OpCo, LLC";
const ANTHROPIC_WINDOWS_PUBLISHER: &str = "Anthropic, PBC";
const OPENAI_CODEX_PACKAGE_NAME: &str = "OpenAI.Codex";
const OPENAI_CODEX_PACKAGE_PUBLISHER_ID: &str = "2p2nqsd0c76g0";
const ANTHROPIC_RELEASE_KEY_FINGERPRINT: &str = "31DDDE24DDFAB679F42D7BD2BAA929FF1A7ECACE";
const ANTHROPIC_RELEASE_KEY_POLICIES: [ReleaseKeyPolicy; 1] = [ReleaseKeyPolicy {
    fingerprint: ANTHROPIC_RELEASE_KEY_FINGERPRINT,
    valid_from: (2, 1, 89),
    valid_through: None,
}];
const CLAUDE_RELEASE_EVIDENCE: &str =
    include_str!("../resources/connector-trust/claude-code-release-attestations-v2.json");
const MAX_TOOL_ARTIFACT_BYTES: u64 = 512 * 1024 * 1024;

#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub(crate) enum ConnectorToolTrustStatus {
    NotDetected,
    Verified,
    ReviewRequired,
    Unavailable,
}

#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub(crate) enum ConnectorToolTrustReason {
    NotDetected,
    OfficialDistributionVerified,
    ArtifactEvidenceMissing,
    ConflictingInstallations,
    UnsupportedWrapper,
    UnsafeArtifact,
    SignatureInvalid,
    PublisherMismatch,
    DistributionNotAttested,
    PackageIdentityMissing,
    PackageIdentityMismatch,
    ManifestEvidenceMissing,
    ManifestMismatch,
    DistributionVerifierUnavailable,
    ArtifactChanged,
    VerifierUnavailable,
}

/// Redacted trust evidence. It intentionally contains no artifact path,
/// publisher string, certificate, thumbprint, version, or command output.
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ConnectorToolTrustReview {
    pub(crate) status: ConnectorToolTrustStatus,
    pub(crate) reason: ConnectorToolTrustReason,
    pub(crate) artifacts_checked: usize,
    pub(crate) authenticode_checked: bool,
    pub(crate) authenticode_valid: bool,
    pub(crate) publisher_matched: bool,
    pub(crate) package_identity_attested: bool,
    pub(crate) manifest_attested: bool,
    pub(crate) source_processes_executed: bool,
    pub(crate) network_accessed: bool,
    pub(crate) artifact_path_returned: bool,
    pub(crate) certificate_material_returned: bool,
}

#[derive(Debug, Clone)]
pub(crate) struct ToolArtifactCandidate {
    pub(crate) channel: ConnectorInstallationChannel,
    pub(crate) path: PathBuf,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum DistributionEvidence {
    Attested,
    Missing,
    Mismatch,
    Unavailable,
}

trait AuthenticodeVerifier {
    fn verify(&self, file: &File, path: &Path) -> AuthenticodeEvidence;
}

trait DistributionAttestor {
    fn attest(
        &self,
        kind: ConnectorKind,
        candidate: &ToolArtifactCandidate,
        file: &File,
    ) -> DistributionEvidence;
}

struct WindowsAuthenticodeVerifier;
struct WindowsDistributionAttestor;

pub(crate) fn review_detected_artifacts(
    kind: ConnectorKind,
    installation_detected: bool,
    candidates: Vec<ToolArtifactCandidate>,
) -> ConnectorToolTrustReview {
    review_detected_artifacts_with(
        kind,
        installation_detected,
        candidates,
        &WindowsAuthenticodeVerifier,
        &WindowsDistributionAttestor,
    )
}

fn review_detected_artifacts_with(
    kind: ConnectorKind,
    installation_detected: bool,
    candidates: Vec<ToolArtifactCandidate>,
    verifier: &dyn AuthenticodeVerifier,
    distribution_attestor: &dyn DistributionAttestor,
) -> ConnectorToolTrustReview {
    let mut deduplicated = BTreeSet::new();
    let candidates = candidates
        .into_iter()
        .filter(|candidate| {
            deduplicated.insert(
                candidate
                    .path
                    .to_string_lossy()
                    .replace('/', "\\")
                    .to_ascii_lowercase(),
            )
        })
        .collect::<Vec<_>>();

    if !installation_detected && candidates.is_empty() {
        return fixed_review(
            ConnectorToolTrustStatus::NotDetected,
            ConnectorToolTrustReason::NotDetected,
            0,
            false,
            false,
            false,
            false,
            false,
        );
    }
    if candidates.is_empty() {
        return fixed_review(
            ConnectorToolTrustStatus::ReviewRequired,
            ConnectorToolTrustReason::ArtifactEvidenceMissing,
            0,
            false,
            false,
            false,
            false,
            false,
        );
    }

    let conflicting = candidates.len() > 1;
    let mut checked = 0usize;
    let mut authenticode_checked = false;
    let mut authenticode_valid = true;
    let mut publisher_matched = true;
    let mut package_identity_attested = false;
    let mut manifest_attested = false;
    let mut first_failure = None;

    for candidate in &candidates {
        checked += 1;
        if !candidate
            .path
            .extension()
            .is_some_and(|extension| extension.eq_ignore_ascii_case("exe"))
        {
            authenticode_valid = false;
            publisher_matched = false;
            first_failure.get_or_insert(ConnectorToolTrustReason::UnsupportedWrapper);
            continue;
        }
        let Ok((file, identity)) = open_ordinary_artifact(&candidate.path) else {
            authenticode_valid = false;
            publisher_matched = false;
            first_failure.get_or_insert(ConnectorToolTrustReason::UnsafeArtifact);
            continue;
        };
        authenticode_checked = true;
        match verifier.verify(&file, &candidate.path) {
            AuthenticodeEvidence::Verified(identity) => {
                let publisher = identity.publisher;
                let publisher_is_expected = expected_publisher(kind)
                    .is_some_and(|expected| publisher.trim().eq_ignore_ascii_case(expected));
                publisher_matched &= publisher_is_expected;
                if !publisher_is_expected {
                    first_failure.get_or_insert(ConnectorToolTrustReason::PublisherMismatch);
                } else if !distribution_attested(kind, candidate) {
                    first_failure.get_or_insert(ConnectorToolTrustReason::DistributionNotAttested);
                } else {
                    match distribution_attestor.attest(kind, candidate, &file) {
                        DistributionEvidence::Attested => match kind {
                            ConnectorKind::Codex => package_identity_attested = true,
                            ConnectorKind::ClaudeCode => manifest_attested = true,
                        },
                        DistributionEvidence::Missing => {
                            first_failure.get_or_insert(match kind {
                                ConnectorKind::Codex => {
                                    ConnectorToolTrustReason::PackageIdentityMissing
                                }
                                ConnectorKind::ClaudeCode => {
                                    ConnectorToolTrustReason::ManifestEvidenceMissing
                                }
                            });
                        }
                        DistributionEvidence::Mismatch => {
                            first_failure.get_or_insert(match kind {
                                ConnectorKind::Codex => {
                                    ConnectorToolTrustReason::PackageIdentityMismatch
                                }
                                ConnectorKind::ClaudeCode => {
                                    ConnectorToolTrustReason::ManifestMismatch
                                }
                            });
                        }
                        DistributionEvidence::Unavailable => {
                            first_failure.get_or_insert(
                                ConnectorToolTrustReason::DistributionVerifierUnavailable,
                            );
                        }
                    }
                }
            }
            AuthenticodeEvidence::Invalid => {
                authenticode_valid = false;
                publisher_matched = false;
                first_failure.get_or_insert(ConnectorToolTrustReason::SignatureInvalid);
            }
            AuthenticodeEvidence::Unavailable => {
                authenticode_valid = false;
                publisher_matched = false;
                first_failure.get_or_insert(ConnectorToolTrustReason::VerifierUnavailable);
            }
        }
        if file_identity_at(&candidate.path).ok() != Some(identity) {
            authenticode_valid = false;
            publisher_matched = false;
            first_failure = Some(ConnectorToolTrustReason::ArtifactChanged);
        }
    }

    let (status, reason) = if conflicting {
        (
            ConnectorToolTrustStatus::ReviewRequired,
            ConnectorToolTrustReason::ConflictingInstallations,
        )
    } else if let Some(reason) = first_failure {
        (
            if reason == ConnectorToolTrustReason::VerifierUnavailable {
                ConnectorToolTrustStatus::Unavailable
            } else {
                ConnectorToolTrustStatus::ReviewRequired
            },
            reason,
        )
    } else {
        (
            ConnectorToolTrustStatus::Verified,
            ConnectorToolTrustReason::OfficialDistributionVerified,
        )
    };
    fixed_review(
        status,
        reason,
        checked,
        authenticode_checked,
        authenticode_valid,
        publisher_matched,
        package_identity_attested,
        manifest_attested,
    )
}

fn expected_publisher(kind: ConnectorKind) -> Option<&'static str> {
    match kind {
        ConnectorKind::Codex => Some(OPENAI_WINDOWS_PUBLISHER),
        ConnectorKind::ClaudeCode => Some(ANTHROPIC_WINDOWS_PUBLISHER),
    }
}

fn distribution_attested(kind: ConnectorKind, candidate: &ToolArtifactCandidate) -> bool {
    match kind {
        ConnectorKind::Codex => {
            candidate.channel == ConnectorInstallationChannel::WindowsDesktopApp
                && is_codex_windows_app_package_path(&candidate.path)
        }
        ConnectorKind::ClaudeCode => matches!(
            candidate.channel,
            ConnectorInstallationChannel::NativeUserInstall
                | ConnectorInstallationChannel::CliOnPath
        ),
    }
}

#[allow(clippy::too_many_arguments)]
fn fixed_review(
    status: ConnectorToolTrustStatus,
    reason: ConnectorToolTrustReason,
    artifacts_checked: usize,
    authenticode_checked: bool,
    authenticode_valid: bool,
    publisher_matched: bool,
    package_identity_attested: bool,
    manifest_attested: bool,
) -> ConnectorToolTrustReview {
    ConnectorToolTrustReview {
        status,
        reason,
        artifacts_checked,
        authenticode_checked,
        authenticode_valid,
        publisher_matched,
        package_identity_attested,
        manifest_attested,
        source_processes_executed: false,
        network_accessed: false,
        artifact_path_returned: false,
        certificate_material_returned: false,
    }
}

impl DistributionAttestor for WindowsDistributionAttestor {
    fn attest(
        &self,
        kind: ConnectorKind,
        candidate: &ToolArtifactCandidate,
        file: &File,
    ) -> DistributionEvidence {
        match kind {
            ConnectorKind::Codex => attest_codex_package_identity(&candidate.path),
            ConnectorKind::ClaudeCode => {
                attest_claude_release_manifest(file, CLAUDE_RELEASE_EVIDENCE)
            }
        }
    }
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ClaudeReleaseEvidencePack {
    schema_version: u32,
    entries: Vec<ClaudeReleaseEvidenceEntry>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ClaudeReleaseEvidenceEntry {
    version: String,
    platform: String,
    sha256: String,
    manifest_sha256: String,
    signing_key_fingerprint: String,
}

#[derive(Debug, Clone, Copy)]
struct ReleaseKeyPolicy {
    fingerprint: &'static str,
    valid_from: (u64, u64, u64),
    valid_through: Option<(u64, u64, u64)>,
}

fn attest_claude_release_manifest(file: &File, evidence_json: &str) -> DistributionEvidence {
    let pack: ClaudeReleaseEvidencePack = match serde_json::from_str(evidence_json) {
        Ok(pack) => pack,
        Err(_) => return DistributionEvidence::Unavailable,
    };
    let mut release_platforms = BTreeSet::new();
    if pack.schema_version != 2
        || pack.entries.len() > 1_024
        || pack.entries.iter().any(|entry| {
            !release_platforms.insert((entry.version.as_str(), entry.platform.as_str()))
                || !valid_claude_release_evidence_entry(entry)
        })
    {
        return DistributionEvidence::Unavailable;
    }
    let platform = if cfg!(target_arch = "x86_64") {
        "win32-x64"
    } else if cfg!(target_arch = "aarch64") {
        "win32-arm64"
    } else {
        return DistributionEvidence::Unavailable;
    };
    let eligible = pack
        .entries
        .iter()
        .filter(|entry| entry.platform == platform)
        .collect::<Vec<_>>();
    if eligible.is_empty() {
        return DistributionEvidence::Missing;
    }
    let Some(digest) = sha256_of_open_artifact(file) else {
        return DistributionEvidence::Unavailable;
    };
    if eligible
        .iter()
        .any(|entry| entry.sha256.eq_ignore_ascii_case(&digest))
    {
        DistributionEvidence::Attested
    } else {
        DistributionEvidence::Mismatch
    }
}

fn valid_claude_release_evidence_entry(entry: &ClaudeReleaseEvidenceEntry) -> bool {
    matches!(entry.platform.as_str(), "win32-x64" | "win32-arm64")
        && valid_sha256(&entry.sha256)
        && valid_sha256(&entry.manifest_sha256)
        && entry.signing_key_fingerprint == normalize_fingerprint(&entry.signing_key_fingerprint)
        && release_key_trusted(&entry.version, &entry.signing_key_fingerprint)
}

fn release_key_trusted(version: &str, fingerprint: &str) -> bool {
    release_key_trusted_with(&ANTHROPIC_RELEASE_KEY_POLICIES, version, fingerprint)
}

fn release_key_trusted_with(
    policies: &[ReleaseKeyPolicy],
    version: &str,
    fingerprint: &str,
) -> bool {
    if !signed_manifest_version(version) {
        return false;
    }
    let Some(version) = parse_release_version(version) else {
        return false;
    };
    let fingerprint = normalize_fingerprint(fingerprint);
    let mut applicable = policies.iter().filter(|policy| {
        version >= policy.valid_from
            && policy
                .valid_through
                .is_none_or(|valid_through| version <= valid_through)
    });
    let Some(policy) = applicable.next() else {
        return false;
    };
    applicable.next().is_none() && fingerprint == policy.fingerprint
}

fn normalize_fingerprint(value: &str) -> String {
    value
        .chars()
        .filter(|character| !character.is_ascii_whitespace())
        .collect::<String>()
        .to_ascii_uppercase()
}

fn signed_manifest_version(version: &str) -> bool {
    parse_release_version(version).is_some_and(|version| version >= (2, 1, 89))
}

fn parse_release_version(version: &str) -> Option<(u64, u64, u64)> {
    let mut parts = version.split('.');
    let mut parse_part = || {
        let part = parts.next()?;
        if part.is_empty() || (part.len() > 1 && part.starts_with('0')) {
            return None;
        }
        part.parse::<u64>().ok()
    };
    let parsed = (parse_part()?, parse_part()?, parse_part()?);
    if parts.next().is_some() {
        return None;
    }
    Some(parsed)
}

fn valid_sha256(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}

fn sha256_of_open_artifact(file: &File) -> Option<String> {
    if file.metadata().ok()?.len() > MAX_TOOL_ARTIFACT_BYTES {
        return None;
    }
    let mut reader = file.try_clone().ok()?;
    reader.seek(SeekFrom::Start(0)).ok()?;
    let mut hasher = Sha256::new();
    let mut buffer = [0u8; 64 * 1024];
    loop {
        let read = reader.read(&mut buffer).ok()?;
        if read == 0 {
            break;
        }
        hasher.update(&buffer[..read]);
    }
    Some(format!("{:x}", hasher.finalize()))
}

fn attest_codex_package_identity(path: &Path) -> DistributionEvidence {
    use std::os::windows::fs::MetadataExt;

    let Some(package_root) = path.ancestors().find(|ancestor| {
        ancestor
            .parent()
            .and_then(Path::file_name)
            .is_some_and(|name| name.eq_ignore_ascii_case("WindowsApps"))
    }) else {
        return DistributionEvidence::Missing;
    };
    let Some(package_full_name) = package_root.file_name().and_then(|name| name.to_str()) else {
        return DistributionEvidence::Mismatch;
    };
    if !valid_codex_package_full_name(package_full_name) {
        return DistributionEvidence::Mismatch;
    }
    let Ok(relative) = path.strip_prefix(package_root) else {
        return DistributionEvidence::Mismatch;
    };
    if !same_windows_path(relative, Path::new(r"app\resources\codex.exe")) {
        return DistributionEvidence::Mismatch;
    }
    let metadata = match std::fs::symlink_metadata(package_root) {
        Ok(metadata)
            if metadata.is_dir()
                && metadata.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT == 0 =>
        {
            metadata
        }
        Ok(_) => return DistributionEvidence::Mismatch,
        Err(_) => return DistributionEvidence::Unavailable,
    };
    let _ = metadata;
    match staged_package_path(package_full_name) {
        Ok(staged_root) if same_windows_path(&staged_root, package_root) => {
            DistributionEvidence::Attested
        }
        Ok(_) => DistributionEvidence::Mismatch,
        Err(PackagePathError::NotRegistered) => DistributionEvidence::Missing,
        Err(PackagePathError::Unavailable) => DistributionEvidence::Unavailable,
    }
}

fn valid_codex_package_full_name(package_full_name: &str) -> bool {
    let parts = package_full_name.split('_').collect::<Vec<_>>();
    parts.len() == 5
        && parts[0] == OPENAI_CODEX_PACKAGE_NAME
        && valid_four_part_version(parts[1])
        && matches!(parts[2].to_ascii_lowercase().as_str(), "x64" | "arm64")
        && parts[3].is_empty()
        && parts[4].eq_ignore_ascii_case(OPENAI_CODEX_PACKAGE_PUBLISHER_ID)
}

fn valid_four_part_version(version: &str) -> bool {
    let parts = version.split('.').collect::<Vec<_>>();
    parts.len() == 4
        && parts
            .iter()
            .all(|part| !part.is_empty() && part.parse::<u16>().is_ok())
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum PackagePathError {
    NotRegistered,
    Unavailable,
}

fn staged_package_path(package_full_name: &str) -> Result<PathBuf, PackagePathError> {
    let package_full_name = package_full_name
        .encode_utf16()
        .chain(std::iter::once(0))
        .collect::<Vec<_>>();
    let mut length = 0u32;
    // SAFETY: the package full name is NUL terminated and the null output is
    // permitted for the sizing call.
    let sized = unsafe {
        GetStagedPackagePathByFullName(
            package_full_name.as_ptr(),
            std::ptr::addr_of_mut!(length),
            std::ptr::null_mut(),
        )
    };
    if sized != ERROR_INSUFFICIENT_BUFFER || length == 0 || length > 32_768 {
        return if sized == ERROR_SUCCESS {
            Err(PackagePathError::Unavailable)
        } else {
            Err(PackagePathError::NotRegistered)
        };
    }
    let mut buffer = vec![0u16; length as usize];
    // SAFETY: the buffer matches the size returned by the preceding call.
    let result = unsafe {
        GetStagedPackagePathByFullName(
            package_full_name.as_ptr(),
            std::ptr::addr_of_mut!(length),
            buffer.as_mut_ptr(),
        )
    };
    if result != ERROR_SUCCESS || length == 0 || length as usize > buffer.len() {
        return if result == ERROR_SUCCESS {
            Err(PackagePathError::Unavailable)
        } else {
            Err(PackagePathError::NotRegistered)
        };
    }
    if buffer.get(length.saturating_sub(1) as usize) == Some(&0) {
        buffer.truncate(length.saturating_sub(1) as usize);
    } else {
        buffer.truncate(length as usize);
    }
    String::from_utf16(&buffer)
        .map(PathBuf::from)
        .map_err(|_| PackagePathError::Unavailable)
}

fn same_windows_path(left: &Path, right: &Path) -> bool {
    fn normalized(path: &Path) -> String {
        path.to_string_lossy()
            .trim_start_matches(r"\\?\")
            .replace('/', "\\")
            .trim_end_matches('\\')
            .to_ascii_lowercase()
    }
    normalized(left) == normalized(right)
}

impl AuthenticodeVerifier for WindowsAuthenticodeVerifier {
    fn verify(&self, file: &File, path: &Path) -> AuthenticodeEvidence {
        verify_authenticode(file, path)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    struct FixedVerifier;

    struct ReplacingVerifier;

    struct FixedDistributionAttestor;

    struct MissingDistributionAttestor;

    fn verified(publisher: &str) -> AuthenticodeEvidence {
        AuthenticodeEvidence::Verified(crate::windows_artifact_trust::AuthenticodeIdentity {
            publisher: publisher.to_owned(),
            certificate_sha256: [7; 32],
        })
    }

    impl AuthenticodeVerifier for FixedVerifier {
        fn verify(&self, _file: &File, path: &Path) -> AuthenticodeEvidence {
            match path.file_stem().and_then(|stem| stem.to_str()) {
                Some("openai" | "codex") => verified(OPENAI_WINDOWS_PUBLISHER),
                Some("anthropic") => verified(ANTHROPIC_WINDOWS_PUBLISHER),
                Some("other") => verified("Other Publisher"),
                Some("unavailable") => AuthenticodeEvidence::Unavailable,
                _ => AuthenticodeEvidence::Invalid,
            }
        }
    }

    impl AuthenticodeVerifier for ReplacingVerifier {
        fn verify(&self, _file: &File, path: &Path) -> AuthenticodeEvidence {
            let moved = path.with_extension("previous");
            std::fs::rename(path, moved).unwrap();
            std::fs::write(path, b"replacement artifact").unwrap();
            verified(ANTHROPIC_WINDOWS_PUBLISHER)
        }
    }

    impl DistributionAttestor for FixedDistributionAttestor {
        fn attest(
            &self,
            _kind: ConnectorKind,
            _candidate: &ToolArtifactCandidate,
            _file: &File,
        ) -> DistributionEvidence {
            DistributionEvidence::Attested
        }
    }

    impl DistributionAttestor for MissingDistributionAttestor {
        fn attest(
            &self,
            _kind: ConnectorKind,
            _candidate: &ToolArtifactCandidate,
            _file: &File,
        ) -> DistributionEvidence {
            DistributionEvidence::Missing
        }
    }

    fn temp_root() -> PathBuf {
        let root =
            std::env::temp_dir().join(format!("yuanyuan-tool-trust-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&root).unwrap();
        root
    }

    fn artifact(root: &Path, relative: &str) -> PathBuf {
        let path = root.join(relative);
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(&path, b"signed artifact fixture").unwrap();
        path
    }

    #[test]
    fn exact_publishers_and_distribution_are_required() {
        let root = temp_root();
        let codex = artifact(
            &root,
            r"Program Files\WindowsApps\OpenAI.Codex_26.727.6591.0_x64__2p2nqsd0c76g0\app\resources\codex.exe",
        );
        let review = review_detected_artifacts_with(
            ConnectorKind::Codex,
            true,
            vec![ToolArtifactCandidate {
                channel: ConnectorInstallationChannel::WindowsDesktopApp,
                path: codex,
            }],
            &FixedVerifier,
            &FixedDistributionAttestor,
        );
        assert_eq!(review.status, ConnectorToolTrustStatus::Verified);
        assert_eq!(
            review.reason,
            ConnectorToolTrustReason::OfficialDistributionVerified
        );

        let claude = artifact(&root, r"profile\.local\bin\anthropic.exe");
        let review = review_detected_artifacts_with(
            ConnectorKind::ClaudeCode,
            true,
            vec![ToolArtifactCandidate {
                channel: ConnectorInstallationChannel::NativeUserInstall,
                path: claude,
            }],
            &FixedVerifier,
            &FixedDistributionAttestor,
        );
        assert_eq!(review.status, ConnectorToolTrustStatus::Verified);
        assert!(review.authenticode_valid);
        assert!(review.publisher_matched);
        assert!(review.manifest_attested);
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn codex_cli_with_a_valid_signature_is_not_mistaken_for_desktop_distribution() {
        let root = temp_root();
        let path = artifact(&root, "openai.exe");
        let review = review_detected_artifacts_with(
            ConnectorKind::Codex,
            true,
            vec![ToolArtifactCandidate {
                channel: ConnectorInstallationChannel::CliOnPath,
                path,
            }],
            &FixedVerifier,
            &FixedDistributionAttestor,
        );
        assert_eq!(review.status, ConnectorToolTrustStatus::ReviewRequired);
        assert_eq!(
            review.reason,
            ConnectorToolTrustReason::DistributionNotAttested
        );
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn wrappers_wrong_publishers_invalid_signatures_and_missing_evidence_fail_closed() {
        let root = temp_root();
        for (name, expected) in [
            ("shim.cmd", ConnectorToolTrustReason::UnsupportedWrapper),
            ("other.exe", ConnectorToolTrustReason::PublisherMismatch),
            ("invalid.exe", ConnectorToolTrustReason::SignatureInvalid),
        ] {
            let path = artifact(&root, name);
            let review = review_detected_artifacts_with(
                ConnectorKind::ClaudeCode,
                true,
                vec![ToolArtifactCandidate {
                    channel: ConnectorInstallationChannel::CliOnPath,
                    path,
                }],
                &FixedVerifier,
                &FixedDistributionAttestor,
            );
            assert_eq!(review.status, ConnectorToolTrustStatus::ReviewRequired);
            assert_eq!(review.reason, expected);
        }
        let review = review_detected_artifacts_with(
            ConnectorKind::Codex,
            true,
            Vec::new(),
            &FixedVerifier,
            &FixedDistributionAttestor,
        );
        assert_eq!(
            review.reason,
            ConnectorToolTrustReason::ArtifactEvidenceMissing
        );
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn multiple_candidates_require_review_even_when_each_is_officially_signed() {
        let root = temp_root();
        let first = artifact(&root, r"one\anthropic.exe");
        let second = artifact(&root, r"two\anthropic.exe");
        let review = review_detected_artifacts_with(
            ConnectorKind::ClaudeCode,
            true,
            vec![
                ToolArtifactCandidate {
                    channel: ConnectorInstallationChannel::CliOnPath,
                    path: first,
                },
                ToolArtifactCandidate {
                    channel: ConnectorInstallationChannel::CliOnPath,
                    path: second,
                },
            ],
            &FixedVerifier,
            &FixedDistributionAttestor,
        );
        assert_eq!(review.status, ConnectorToolTrustStatus::ReviewRequired);
        assert_eq!(
            review.reason,
            ConnectorToolTrustReason::ConflictingInstallations
        );
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn artifact_replacement_during_signature_verification_is_detected() {
        let root = temp_root();
        let path = artifact(&root, "anthropic.exe");
        let review = review_detected_artifacts_with(
            ConnectorKind::ClaudeCode,
            true,
            vec![ToolArtifactCandidate {
                channel: ConnectorInstallationChannel::NativeUserInstall,
                path,
            }],
            &ReplacingVerifier,
            &FixedDistributionAttestor,
        );
        assert_eq!(review.status, ConnectorToolTrustStatus::ReviewRequired);
        assert_eq!(review.reason, ConnectorToolTrustReason::ArtifactChanged);
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn verifier_failure_is_unavailable_and_never_falls_back_to_name_or_path() {
        let root = temp_root();
        let path = artifact(&root, "unavailable.exe");
        let review = review_detected_artifacts_with(
            ConnectorKind::ClaudeCode,
            true,
            vec![ToolArtifactCandidate {
                channel: ConnectorInstallationChannel::CliOnPath,
                path,
            }],
            &FixedVerifier,
            &FixedDistributionAttestor,
        );
        assert_eq!(review.status, ConnectorToolTrustStatus::Unavailable);
        assert_eq!(review.reason, ConnectorToolTrustReason::VerifierUnavailable);
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn serialized_review_contains_no_path_publisher_or_certificate_material() {
        let root = temp_root();
        let path = artifact(&root, r"profile\.local\bin\anthropic.exe");
        let review = review_detected_artifacts_with(
            ConnectorKind::ClaudeCode,
            true,
            vec![ToolArtifactCandidate {
                channel: ConnectorInstallationChannel::NativeUserInstall,
                path,
            }],
            &FixedVerifier,
            &FixedDistributionAttestor,
        );
        let encoded = serde_json::to_string(&review).unwrap();
        for sensitive in [
            root.to_string_lossy().as_ref(),
            ANTHROPIC_WINDOWS_PUBLISHER,
            OPENAI_WINDOWS_PUBLISHER,
            "thumbprint",
        ] {
            assert!(!encoded.contains(sensitive));
        }
        assert!(encoded.contains("sourceProcessesExecuted"));
        assert!(encoded.contains("networkAccessed"));
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn valid_signature_without_the_required_second_factor_still_requires_review() {
        let root = temp_root();
        let codex = artifact(
            &root,
            r"Program Files\WindowsApps\OpenAI.Codex_26.727.6591.0_x64__2p2nqsd0c76g0\app\resources\codex.exe",
        );
        let review = review_detected_artifacts_with(
            ConnectorKind::Codex,
            true,
            vec![ToolArtifactCandidate {
                channel: ConnectorInstallationChannel::WindowsDesktopApp,
                path: codex,
            }],
            &FixedVerifier,
            &MissingDistributionAttestor,
        );
        assert_eq!(review.status, ConnectorToolTrustStatus::ReviewRequired);
        assert_eq!(
            review.reason,
            ConnectorToolTrustReason::PackageIdentityMissing
        );
        assert!(review.authenticode_valid);
        assert!(review.publisher_matched);
        assert!(!review.package_identity_attested);

        let claude = artifact(&root, r"profile\.local\bin\anthropic.exe");
        let review = review_detected_artifacts_with(
            ConnectorKind::ClaudeCode,
            true,
            vec![ToolArtifactCandidate {
                channel: ConnectorInstallationChannel::NativeUserInstall,
                path: claude,
            }],
            &FixedVerifier,
            &MissingDistributionAttestor,
        );
        assert_eq!(review.status, ConnectorToolTrustStatus::ReviewRequired);
        assert_eq!(
            review.reason,
            ConnectorToolTrustReason::ManifestEvidenceMissing
        );
        assert!(!review.manifest_attested);
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn codex_package_name_parser_rejects_spoofed_family_version_and_architecture() {
        assert!(valid_codex_package_full_name(
            "OpenAI.Codex_26.727.6591.0_x64__2p2nqsd0c76g0"
        ));
        for spoofed in [
            "OpenAI.Codex_26.727.6591.0_x64__attacker",
            "OpenAI.Codex.Evil_26.727.6591.0_x64__2p2nqsd0c76g0",
            "OpenAI.Codex_26.727.6591_x64__2p2nqsd0c76g0",
            "OpenAI.Codex_26.727.6591.0_x86__2p2nqsd0c76g0",
            "OpenAI.Codex_26.727.70000.0_x64__2p2nqsd0c76g0",
        ] {
            assert!(!valid_codex_package_full_name(spoofed), "{spoofed}");
        }
    }

    #[test]
    fn claude_release_key_rotation_requires_exactly_one_applicable_root() {
        const NEXT_FINGERPRINT: &str = "FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF";
        let overlapping = [
            ReleaseKeyPolicy {
                fingerprint: ANTHROPIC_RELEASE_KEY_FINGERPRINT,
                valid_from: (2, 1, 89),
                valid_through: None,
            },
            ReleaseKeyPolicy {
                fingerprint: NEXT_FINGERPRINT,
                valid_from: (2, 1, 100),
                valid_through: None,
            },
        ];
        assert!(!release_key_trusted_with(
            &overlapping,
            "2.1.100",
            ANTHROPIC_RELEASE_KEY_FINGERPRINT
        ));
        assert!(!release_key_trusted_with(
            &overlapping,
            "2.1.100",
            NEXT_FINGERPRINT
        ));

        let rotated = [
            ReleaseKeyPolicy {
                fingerprint: ANTHROPIC_RELEASE_KEY_FINGERPRINT,
                valid_from: (2, 1, 89),
                valid_through: Some((2, 1, 99)),
            },
            ReleaseKeyPolicy {
                fingerprint: NEXT_FINGERPRINT,
                valid_from: (2, 1, 100),
                valid_through: None,
            },
        ];
        assert!(release_key_trusted_with(
            &rotated,
            "2.1.99",
            ANTHROPIC_RELEASE_KEY_FINGERPRINT
        ));
        assert!(release_key_trusted_with(
            &rotated,
            "2.1.100",
            NEXT_FINGERPRINT
        ));
        assert!(!release_key_trusted_with(
            &rotated,
            "2.1.100",
            ANTHROPIC_RELEASE_KEY_FINGERPRINT
        ));
    }

    #[test]
    fn claude_manifest_evidence_requires_pinned_key_verified_signature_and_exact_hash() {
        let root = temp_root();
        let path = artifact(&root, "anthropic.exe");
        let (file, _) = open_ordinary_artifact(&path).unwrap();
        let digest = sha256_of_open_artifact(&file).unwrap();
        let platform = if cfg!(target_arch = "x86_64") {
            "win32-x64"
        } else {
            "win32-arm64"
        };
        let evidence = serde_json::json!({
            "schemaVersion": 2,
            "entries": [{
                "version": "2.1.89",
                "platform": platform,
                "sha256": digest,
                "manifestSha256": "11".repeat(32),
                "signingKeyFingerprint": ANTHROPIC_RELEASE_KEY_FINGERPRINT
            }]
        });
        assert_eq!(
            attest_claude_release_manifest(&file, &evidence.to_string()),
            DistributionEvidence::Attested
        );

        let stale = serde_json::json!({
            "schemaVersion": 2,
            "entries": [{
                "version": "2.1.89",
                "platform": platform,
                "sha256": "00".repeat(32),
                "manifestSha256": "11".repeat(32),
                "signingKeyFingerprint": ANTHROPIC_RELEASE_KEY_FINGERPRINT
            }]
        });
        assert_eq!(
            attest_claude_release_manifest(&file, &stale.to_string()),
            DistributionEvidence::Mismatch
        );
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn compiled_claude_evidence_contains_the_reviewed_2_1_211_windows_release() {
        let pack: ClaudeReleaseEvidencePack =
            serde_json::from_str(CLAUDE_RELEASE_EVIDENCE).unwrap();
        assert_eq!(pack.schema_version, 2);
        assert_eq!(pack.entries.len(), 2);
        let expected = [
            (
                "win32-arm64",
                "a0f9bab0dbdda9b43a8765d54e329e44484d9dd7d4f40cf31db6eee27a2da41c",
            ),
            (
                "win32-x64",
                "3d8509ae7de11d77dbdc711aa320fc6d5064ce795464a8670696611b57093caf",
            ),
        ];
        for (entry, (platform, digest)) in pack.entries.iter().zip(expected) {
            assert_eq!(entry.version, "2.1.211");
            assert_eq!(entry.platform, platform);
            assert_eq!(entry.sha256, digest);
            assert_eq!(
                entry.manifest_sha256,
                "750cb326e4b6662c5a086acc970017d6f2da9279a1fa02d9f8a25eb053a43032"
            );
            assert_eq!(
                entry.signing_key_fingerprint,
                ANTHROPIC_RELEASE_KEY_FINGERPRINT
            );
        }
    }

    #[test]
    fn malformed_or_self_asserted_claude_evidence_is_unavailable_not_trusted() {
        let root = temp_root();
        let path = artifact(&root, "anthropic.exe");
        let (file, _) = open_ordinary_artifact(&path).unwrap();
        for evidence in [
            serde_json::json!({
                "schemaVersion": 1,
                "entries": []
            }),
            serde_json::json!({
                "schemaVersion": 2,
                "entries": [{
                    "version": "2.1.88",
                    "platform": "win32-x64",
                    "sha256": "00".repeat(32),
                    "manifestSha256": "11".repeat(32),
                    "signingKeyFingerprint": ANTHROPIC_RELEASE_KEY_FINGERPRINT
                }]
            }),
            serde_json::json!({
                "schemaVersion": 2,
                "entries": [{
                    "version": "2.1.89",
                    "platform": "win32-x64",
                    "sha256": "00".repeat(32),
                    "manifestSha256": "11".repeat(32),
                    "signingKeyFingerprint": "FF".repeat(20)
                }]
            }),
            serde_json::json!({
                "schemaVersion": 2,
                "entries": [{
                    "version": "02.1.89",
                    "platform": "win32-x64",
                    "sha256": "00".repeat(32),
                    "manifestSha256": "11".repeat(32),
                    "signingKeyFingerprint": ANTHROPIC_RELEASE_KEY_FINGERPRINT
                }]
            }),
            serde_json::json!({
                "schemaVersion": 2,
                "entries": [{
                    "version": "2.1.89",
                    "platform": "win32-x64",
                    "sha256": "AA".repeat(32),
                    "manifestSha256": "11".repeat(32),
                    "signingKeyFingerprint": ANTHROPIC_RELEASE_KEY_FINGERPRINT
                }]
            }),
            serde_json::json!({
                "schemaVersion": 2,
                "entries": [
                    {
                        "version": "2.1.89",
                        "platform": "win32-x64",
                        "sha256": "00".repeat(32),
                        "manifestSha256": "11".repeat(32),
                        "signingKeyFingerprint": ANTHROPIC_RELEASE_KEY_FINGERPRINT
                    },
                    {
                        "version": "2.1.89",
                        "platform": "win32-x64",
                        "sha256": "22".repeat(32),
                        "manifestSha256": "11".repeat(32),
                        "signingKeyFingerprint": ANTHROPIC_RELEASE_KEY_FINGERPRINT
                    }
                ]
            }),
        ] {
            assert_eq!(
                attest_claude_release_manifest(&file, &evidence.to_string()),
                DistributionEvidence::Unavailable
            );
        }
        assert_eq!(
            attest_claude_release_manifest(&file, CLAUDE_RELEASE_EVIDENCE),
            DistributionEvidence::Mismatch
        );
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn real_signed_claude_release_passes_both_offline_factors_when_provided() {
        let Some(path) = std::env::var_os("YUANYUAN_CLAUDE_TRUST_FIXTURE").map(PathBuf::from)
        else {
            return;
        };
        let review = review_detected_artifacts(
            ConnectorKind::ClaudeCode,
            true,
            vec![ToolArtifactCandidate {
                channel: ConnectorInstallationChannel::NativeUserInstall,
                path,
            }],
        );
        assert_eq!(review.status, ConnectorToolTrustStatus::Verified);
        assert_eq!(
            review.reason,
            ConnectorToolTrustReason::OfficialDistributionVerified
        );
        assert!(review.authenticode_valid);
        assert!(review.publisher_matched);
        assert!(review.manifest_attested);
        assert!(!review.package_identity_attested);
    }

    #[test]
    fn installed_store_codex_passes_the_real_offline_windows_signature_adapter_when_present() {
        let candidate = std::env::split_paths(&std::env::var_os("PATH").unwrap_or_default())
            .map(|directory| directory.join("codex.exe"))
            .find(|path| {
                is_codex_windows_app_package_path(path) && open_ordinary_artifact(path).is_ok()
            });
        let Some(path) = candidate else {
            return;
        };
        let review = review_detected_artifacts(
            ConnectorKind::Codex,
            true,
            vec![ToolArtifactCandidate {
                channel: ConnectorInstallationChannel::WindowsDesktopApp,
                path,
            }],
        );
        assert_eq!(review.status, ConnectorToolTrustStatus::Verified);
        assert_eq!(
            review.reason,
            ConnectorToolTrustReason::OfficialDistributionVerified
        );
        assert!(review.package_identity_attested);
        assert!(!review.manifest_attested);
    }

    #[test]
    fn installed_store_codex_trust_adapter_tolerates_parallel_verification_when_present() {
        let candidate = std::env::split_paths(&std::env::var_os("PATH").unwrap_or_default())
            .map(|directory| directory.join("codex.exe"))
            .find(|path| {
                is_codex_windows_app_package_path(path) && open_ordinary_artifact(path).is_ok()
            });
        let Some(path) = candidate else {
            return;
        };
        let barrier = std::sync::Arc::new(std::sync::Barrier::new(8));
        let reviews = std::thread::scope(|scope| {
            let workers = (0..8)
                .map(|_| {
                    let path = path.clone();
                    let barrier = barrier.clone();
                    scope.spawn(move || {
                        barrier.wait();
                        review_detected_artifacts(
                            ConnectorKind::Codex,
                            true,
                            vec![ToolArtifactCandidate {
                                channel: ConnectorInstallationChannel::WindowsDesktopApp,
                                path,
                            }],
                        )
                    })
                })
                .collect::<Vec<_>>();
            workers
                .into_iter()
                .map(|worker| worker.join().expect("trust worker must not panic"))
                .collect::<Vec<_>>()
        });
        assert!(reviews.iter().all(|review| {
            review.status == ConnectorToolTrustStatus::Verified
                && review.reason == ConnectorToolTrustReason::OfficialDistributionVerified
                && review.package_identity_attested
                && !review.manifest_attested
        }));
    }
}
