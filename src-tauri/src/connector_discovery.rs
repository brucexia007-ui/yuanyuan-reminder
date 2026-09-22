#![cfg(windows)]

use std::{collections::BTreeSet, path::PathBuf};

use serde::Serialize;
use uuid::Uuid;
use windows_sys::Win32::{
    Foundation::{ERROR_NO_MORE_ITEMS, ERROR_SUCCESS},
    System::Registry::{RegCloseKey, RegEnumKeyExW, RegOpenKeyExW, HKEY_CURRENT_USER, KEY_READ},
};

const APP_PACKAGE_REGISTRY_PATH: &str = concat!(
    "Software\\Classes\\Local Settings\\Software\\Microsoft\\Windows\\",
    "CurrentVersion\\AppModel\\Repository\\Packages"
);
const MAX_PACKAGE_KEY_CHARS: usize = 512;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ConnectorKind {
    Codex,
    ClaudeCode,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ConnectorInstallationChannel {
    WindowsDesktopApp,
    CliOnPath,
    NativeUserInstall,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ConnectorInstallationState {
    NotDetected,
    Detected,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ConnectorCompatibility {
    Limited,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ConnectorHookConfigurationState {
    Unknown,
}

#[derive(Debug, Default, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ConnectorEventHealth {
    #[default]
    NotObserved,
    PausedAuthenticationFailure,
    Unavailable,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ConnectorAuthorizationProbe {
    Unconfigured,
    Available,
    Unavailable,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ConnectorAuthorizationState {
    Active,
    ReconnectRequired,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ConnectorTrustedInstance {
    connector_id: String,
    source_instance: String,
    authorization_state: ConnectorAuthorizationState,
    rotation_grace_active: bool,
    generation: u64,
    legacy_identity: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ConnectorDiscoveryStatus {
    kind: ConnectorKind,
    installation_state: ConnectorInstallationState,
    installation_channels: Vec<ConnectorInstallationChannel>,
    tool_trust: crate::connector_tool_trust::ConnectorToolTrustReview,
    compatibility: ConnectorCompatibility,
    hook_configuration: ConnectorHookConfigurationState,
    event_health: ConnectorEventHealth,
    authorization_probe: ConnectorAuthorizationProbe,
    trusted_instances: Vec<ConnectorTrustedInstance>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ConnectorDiscoveryPrivacy {
    source_processes_executed: bool,
    private_configuration_read: bool,
    task_data_read: bool,
    hook_configuration_changed: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ConnectorDiscoverySnapshot {
    connectors: Vec<ConnectorDiscoveryStatus>,
    privacy: ConnectorDiscoveryPrivacy,
}

#[derive(Debug, Default, Clone)]
struct DiscoveryEnvironment {
    path_entries: Vec<PathBuf>,
    user_profile: Option<PathBuf>,
    package_names: Vec<String>,
    codex_trust: TrustProbe,
    claude_trust: TrustProbe,
    codex_event_health: ConnectorEventHealth,
    claude_event_health: ConnectorEventHealth,
    now_unix_ms: i64,
}

#[derive(Debug, Default, Clone)]
enum TrustProbe {
    #[default]
    Unconfigured,
    Available(Vec<yuanyuan_bridge::TrustIdentitySummary>),
    Unavailable,
}

pub fn discover_builtin_connectors() -> ConnectorDiscoverySnapshot {
    let codex_trust = trust_probe(crate::connector_trust_control::ConnectorImplementation::Codex);
    let claude_trust =
        trust_probe(crate::connector_trust_control::ConnectorImplementation::ClaudeCode);
    discover_with_environment(DiscoveryEnvironment {
        path_entries: std::env::split_paths(&std::env::var_os("PATH").unwrap_or_default())
            .collect(),
        user_profile: std::env::var_os("USERPROFILE").map(PathBuf::from),
        package_names: installed_package_names(),
        codex_event_health: event_health_probe(&codex_trust),
        claude_event_health: event_health_probe(&claude_trust),
        codex_trust,
        claude_trust,
        now_unix_ms: unix_time_ms().unwrap_or(i64::MAX),
    })
}

pub(crate) fn builtin_tool_trust_verified(
    implementation: crate::connector_trust_control::ConnectorImplementation,
) -> bool {
    let expected_kind = match implementation {
        crate::connector_trust_control::ConnectorImplementation::Codex => ConnectorKind::Codex,
        crate::connector_trust_control::ConnectorImplementation::ClaudeCode => {
            ConnectorKind::ClaudeCode
        }
    };
    discover_builtin_connectors()
        .connectors
        .into_iter()
        .find(|connector| connector.kind == expected_kind)
        .is_some_and(|connector| {
            tool_review_allows_project_inspection(expected_kind, &connector.tool_trust)
        })
}

fn tool_review_allows_project_inspection(
    kind: ConnectorKind,
    review: &crate::connector_tool_trust::ConnectorToolTrustReview,
) -> bool {
    review.status == crate::connector_tool_trust::ConnectorToolTrustStatus::Verified
        && review.authenticode_checked
        && review.authenticode_valid
        && review.publisher_matched
        && match kind {
            ConnectorKind::Codex => review.package_identity_attested,
            ConnectorKind::ClaudeCode => review.manifest_attested,
        }
        && !review.source_processes_executed
        && !review.network_accessed
        && !review.artifact_path_returned
        && !review.certificate_material_returned
}

fn discover_with_environment(environment: DiscoveryEnvironment) -> ConnectorDiscoverySnapshot {
    let mut codex_channels = BTreeSet::new();
    if environment.package_names.iter().any(|name| {
        let name = name.to_ascii_lowercase();
        name.starts_with("openai.codex_") || name.starts_with("openai.chatgpt_")
    }) {
        codex_channels.insert(ConnectorInstallationChannel::WindowsDesktopApp);
    }
    let mut codex_candidates = Vec::new();
    for executable in executables_on_path(&environment.path_entries, "codex") {
        let channel = if is_codex_desktop_managed_path(&executable) {
            ConnectorInstallationChannel::WindowsDesktopApp
        } else {
            ConnectorInstallationChannel::CliOnPath
        };
        codex_channels.insert(channel);
        codex_candidates.push(crate::connector_tool_trust::ToolArtifactCandidate {
            channel,
            path: executable,
        });
    }
    let codex_tool_trust = crate::connector_tool_trust::review_detected_artifacts(
        ConnectorKind::Codex,
        !codex_channels.is_empty(),
        codex_candidates,
    );

    let mut claude_channels = BTreeSet::new();
    let native_claude = environment
        .user_profile
        .as_ref()
        .map(|profile| profile.join(".local").join("bin").join("claude.exe"));
    if native_claude
        .as_ref()
        .is_some_and(|path| ordinary_file(path))
    {
        claude_channels.insert(ConnectorInstallationChannel::NativeUserInstall);
    }
    let mut claude_candidates = native_claude
        .as_ref()
        .filter(|path| ordinary_file(path))
        .map(|path| crate::connector_tool_trust::ToolArtifactCandidate {
            channel: ConnectorInstallationChannel::NativeUserInstall,
            path: path.clone(),
        })
        .into_iter()
        .collect::<Vec<_>>();
    for executable in executables_on_path(&environment.path_entries, "claude") {
        if !native_claude
            .as_ref()
            .is_some_and(|native| same_windows_path(native, &executable))
        {
            claude_channels.insert(ConnectorInstallationChannel::CliOnPath);
            claude_candidates.push(crate::connector_tool_trust::ToolArtifactCandidate {
                channel: ConnectorInstallationChannel::CliOnPath,
                path: executable,
            });
        }
    }
    let claude_tool_trust = crate::connector_tool_trust::review_detected_artifacts(
        ConnectorKind::ClaudeCode,
        !claude_channels.is_empty(),
        claude_candidates,
    );

    ConnectorDiscoverySnapshot {
        connectors: vec![
            status(
                ConnectorKind::Codex,
                codex_channels,
                codex_tool_trust,
                environment.codex_trust,
                environment.codex_event_health,
                environment.now_unix_ms,
            ),
            status(
                ConnectorKind::ClaudeCode,
                claude_channels,
                claude_tool_trust,
                environment.claude_trust,
                environment.claude_event_health,
                environment.now_unix_ms,
            ),
        ],
        privacy: ConnectorDiscoveryPrivacy {
            source_processes_executed: false,
            private_configuration_read: false,
            task_data_read: false,
            hook_configuration_changed: false,
        },
    }
}

fn status(
    kind: ConnectorKind,
    channels: BTreeSet<ConnectorInstallationChannel>,
    tool_trust: crate::connector_tool_trust::ConnectorToolTrustReview,
    trust: TrustProbe,
    event_health: ConnectorEventHealth,
    now_unix_ms: i64,
) -> ConnectorDiscoveryStatus {
    let installation_channels = channels.into_iter().collect::<Vec<_>>();
    let (authorization_probe, trusted_instances) = match trust {
        TrustProbe::Unconfigured => (ConnectorAuthorizationProbe::Unconfigured, Vec::new()),
        TrustProbe::Unavailable => (ConnectorAuthorizationProbe::Unavailable, Vec::new()),
        TrustProbe::Available(summaries) => (
            ConnectorAuthorizationProbe::Available,
            summaries
                .into_iter()
                .map(|summary| {
                    let legacy_identity = crate::connector_trust_control::connector_implementation(
                        &summary.connector_id,
                    )
                    .is_some_and(|(_, legacy)| legacy);
                    ConnectorTrustedInstance {
                        connector_id: summary.connector_id,
                        source_instance: summary.source_instance,
                        authorization_state: if summary.active && !legacy_identity {
                            ConnectorAuthorizationState::Active
                        } else {
                            ConnectorAuthorizationState::ReconnectRequired
                        },
                        rotation_grace_active: summary
                            .grace_expires_at_unix_ms
                            .is_some_and(|expires| expires >= now_unix_ms),
                        generation: summary.generation,
                        legacy_identity,
                    }
                })
                .collect(),
        ),
    };
    ConnectorDiscoveryStatus {
        kind,
        installation_state: if installation_channels.is_empty() {
            ConnectorInstallationState::NotDetected
        } else {
            ConnectorInstallationState::Detected
        },
        installation_channels,
        tool_trust,
        compatibility: ConnectorCompatibility::Limited,
        hook_configuration: ConnectorHookConfigurationState::Unknown,
        event_health,
        authorization_probe,
        trusted_instances,
    }
}

fn event_health_probe(trust: &TrustProbe) -> ConnectorEventHealth {
    let TrustProbe::Available(summaries) = trust else {
        return ConnectorEventHealth::NotObserved;
    };
    let Ok(path) = crate::connector_trust_control::authentication_health_database_path() else {
        return ConnectorEventHealth::Unavailable;
    };
    match std::fs::symlink_metadata(&path) {
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            return ConnectorEventHealth::NotObserved;
        }
        Ok(metadata) if metadata.is_file() && !metadata.file_type().is_symlink() => {}
        _ => return ConnectorEventHealth::Unavailable,
    }
    let Ok(store) =
        yuanyuan_bridge::ConnectorAuthenticationHealthStore::open_existing_read_only(path)
    else {
        return ConnectorEventHealth::Unavailable;
    };
    for summary in summaries {
        match store.status(&summary.connector_id, &summary.source_instance) {
            Ok(Some(status)) if status.paused => {
                return ConnectorEventHealth::PausedAuthenticationFailure;
            }
            Ok(_) => {}
            Err(_) => return ConnectorEventHealth::Unavailable,
        }
    }
    ConnectorEventHealth::NotObserved
}

fn trust_probe(
    implementation: crate::connector_trust_control::ConnectorImplementation,
) -> TrustProbe {
    let Ok(path) = crate::connector_trust_control::trust_database_path() else {
        return TrustProbe::Unavailable;
    };
    match std::fs::symlink_metadata(&path) {
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            return TrustProbe::Unconfigured;
        }
        Ok(metadata) if metadata.is_file() && !metadata.file_type().is_symlink() => {}
        _ => return TrustProbe::Unavailable,
    }
    let Ok(store) = yuanyuan_bridge::ConnectorTrustStore::open_existing_read_only(path) else {
        return TrustProbe::Unavailable;
    };
    let Ok(summaries) = store.list_all_identity_summaries() else {
        return TrustProbe::Unavailable;
    };
    let summaries = summaries
        .into_iter()
        .filter(|summary| {
            crate::connector_trust_control::connector_implementation(&summary.connector_id)
                .is_some_and(|(candidate, _)| candidate == implementation)
        })
        .collect::<Vec<_>>();
    if summaries
        .iter()
        .any(|summary| Uuid::parse_str(&summary.source_instance).is_err())
    {
        return TrustProbe::Unavailable;
    }
    if summaries.is_empty() {
        TrustProbe::Unconfigured
    } else {
        TrustProbe::Available(summaries)
    }
}

fn unix_time_ms() -> Option<i64> {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .ok()
        .and_then(|duration| i64::try_from(duration.as_millis()).ok())
}

fn executables_on_path(entries: &[PathBuf], stem: &str) -> Vec<PathBuf> {
    const EXTENSIONS: [&str; 3] = ["exe", "cmd", "bat"];
    entries
        .iter()
        .flat_map(|directory| {
            EXTENSIONS
                .iter()
                .map(move |extension| directory.join(format!("{stem}.{extension}")))
        })
        .filter(|candidate| ordinary_file(candidate))
        .collect()
}

pub(crate) fn is_codex_desktop_managed_path(path: &std::path::Path) -> bool {
    is_codex_windows_app_package_path(path)
        || path
            .to_string_lossy()
            .replace('/', "\\")
            .to_ascii_lowercase()
            .contains("\\appdata\\local\\openai\\codex\\bin\\")
}

pub(crate) fn is_codex_windows_app_package_path(path: &std::path::Path) -> bool {
    let normalized = path
        .to_string_lossy()
        .replace('/', "\\")
        .to_ascii_lowercase();
    normalized.contains("\\program files\\windowsapps\\openai.codex_")
}

fn same_windows_path(left: &std::path::Path, right: &std::path::Path) -> bool {
    left.to_string_lossy()
        .eq_ignore_ascii_case(&right.to_string_lossy())
}

fn ordinary_file(path: &std::path::Path) -> bool {
    use std::os::windows::fs::MetadataExt;

    const FILE_ATTRIBUTE_REPARSE_POINT: u32 = 0x0000_0400;
    std::fs::symlink_metadata(path).is_ok_and(|metadata| {
        metadata.is_file()
            && metadata.len() > 0
            && metadata.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT == 0
    })
}

fn installed_package_names() -> Vec<String> {
    let path = wide_null(APP_PACKAGE_REGISTRY_PATH);
    let mut key = std::ptr::null_mut();
    // SAFETY: `path` is NUL terminated, `key` is a valid out pointer, and the
    // returned handle is closed on every successful open path below.
    let opened = unsafe { RegOpenKeyExW(HKEY_CURRENT_USER, path.as_ptr(), 0, KEY_READ, &mut key) };
    if opened != ERROR_SUCCESS {
        return Vec::new();
    }

    let mut names = Vec::new();
    let mut index = 0;
    loop {
        let mut buffer = [0_u16; MAX_PACKAGE_KEY_CHARS];
        let mut length = buffer.len() as u32;
        // SAFETY: the buffer and length pointers remain valid for the call;
        // optional output pointers are null because their values are unused.
        let result = unsafe {
            RegEnumKeyExW(
                key,
                index,
                buffer.as_mut_ptr(),
                &mut length,
                std::ptr::null_mut(),
                std::ptr::null_mut(),
                std::ptr::null_mut(),
                std::ptr::null_mut(),
            )
        };
        if result == ERROR_NO_MORE_ITEMS {
            break;
        }
        if result != ERROR_SUCCESS {
            names.clear();
            break;
        }
        names.push(String::from_utf16_lossy(&buffer[..length as usize]));
        index += 1;
    }
    // SAFETY: `key` is a handle returned by a successful `RegOpenKeyExW`.
    unsafe { RegCloseKey(key) };
    names
}

fn wide_null(value: &str) -> Vec<u16> {
    value.encode_utf16().chain(std::iter::once(0)).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn verified_tool_review() -> crate::connector_tool_trust::ConnectorToolTrustReview {
        crate::connector_tool_trust::ConnectorToolTrustReview {
            status: crate::connector_tool_trust::ConnectorToolTrustStatus::Verified,
            reason:
                crate::connector_tool_trust::ConnectorToolTrustReason::OfficialDistributionVerified,
            artifacts_checked: 1,
            authenticode_checked: true,
            authenticode_valid: true,
            publisher_matched: true,
            package_identity_attested: false,
            manifest_attested: false,
            source_processes_executed: false,
            network_accessed: false,
            artifact_path_returned: false,
            certificate_material_returned: false,
        }
    }

    fn create_file(path: &std::path::Path) {
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(path, b"test executable marker").unwrap();
    }

    #[test]
    fn discovery_separates_installation_from_hook_and_event_health() {
        let root =
            std::env::temp_dir().join(format!("yuanyuan-discovery-{}", uuid::Uuid::new_v4()));
        let bin = root.join("bin");
        let profile = root.join("profile");
        create_file(&bin.join("codex.cmd"));
        create_file(&profile.join(".local").join("bin").join("claude.exe"));

        let snapshot = discover_with_environment(DiscoveryEnvironment {
            path_entries: vec![bin],
            user_profile: Some(profile),
            package_names: vec!["OpenAI.Codex_1.2.3.4_x64__publisher".to_owned()],
            codex_trust: TrustProbe::Available(vec![yuanyuan_bridge::TrustIdentitySummary {
                connector_id: "builtin.codex.00000000-0000-4000-8000-000000000010".to_owned(),
                source_instance: "00000000-0000-4000-8000-000000000001".to_owned(),
                generation: 2,
                active: true,
                grace_expires_at_unix_ms: Some(2_000),
            }]),
            claude_trust: TrustProbe::Unconfigured,
            codex_event_health: ConnectorEventHealth::NotObserved,
            claude_event_health: ConnectorEventHealth::NotObserved,
            now_unix_ms: 1_000,
        });

        assert_eq!(
            snapshot.connectors[0].installation_channels,
            vec![
                ConnectorInstallationChannel::WindowsDesktopApp,
                ConnectorInstallationChannel::CliOnPath,
            ]
        );
        assert_eq!(
            snapshot.connectors[1].installation_channels,
            vec![ConnectorInstallationChannel::NativeUserInstall]
        );
        assert_eq!(
            snapshot.connectors[0].tool_trust.status,
            crate::connector_tool_trust::ConnectorToolTrustStatus::ReviewRequired
        );
        assert_eq!(
            snapshot.connectors[0].tool_trust.reason,
            crate::connector_tool_trust::ConnectorToolTrustReason::UnsupportedWrapper
        );
        assert_eq!(
            snapshot.connectors[1].tool_trust.reason,
            crate::connector_tool_trust::ConnectorToolTrustReason::SignatureInvalid
        );
        for connector in &snapshot.connectors {
            assert_eq!(connector.compatibility, ConnectorCompatibility::Limited);
            assert_eq!(
                connector.hook_configuration,
                ConnectorHookConfigurationState::Unknown
            );
            assert_eq!(connector.event_health, ConnectorEventHealth::NotObserved);
        }
        assert_eq!(
            snapshot.connectors[0].authorization_probe,
            ConnectorAuthorizationProbe::Available
        );
        assert_eq!(snapshot.connectors[0].trusted_instances.len(), 1);
        assert!(snapshot.connectors[0].trusted_instances[0].rotation_grace_active);
        assert!(!snapshot.connectors[0].trusted_instances[0].legacy_identity);
        assert_eq!(
            snapshot.connectors[1].authorization_probe,
            ConnectorAuthorizationProbe::Unconfigured
        );
        assert!(!snapshot.privacy.source_processes_executed);
        assert!(!snapshot.privacy.private_configuration_read);
        assert!(!snapshot.privacy.task_data_read);
        assert!(!snapshot.privacy.hook_configuration_changed);

        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn absent_tools_are_not_reported_as_connected() {
        let snapshot = discover_with_environment(DiscoveryEnvironment::default());
        assert!(snapshot.connectors.iter().all(|connector| {
            connector.installation_state == ConnectorInstallationState::NotDetected
                && connector.installation_channels.is_empty()
                && connector.authorization_probe == ConnectorAuthorizationProbe::Unconfigured
                && connector.trusted_instances.is_empty()
                && connector.tool_trust.status
                    == crate::connector_tool_trust::ConnectorToolTrustStatus::NotDetected
        }));
    }

    #[test]
    fn project_inspection_gate_requires_the_tool_specific_second_factor_and_privacy_contract() {
        let mut review = verified_tool_review();
        assert!(!tool_review_allows_project_inspection(
            ConnectorKind::Codex,
            &review
        ));
        review.package_identity_attested = true;
        assert!(tool_review_allows_project_inspection(
            ConnectorKind::Codex,
            &review
        ));
        assert!(!tool_review_allows_project_inspection(
            ConnectorKind::ClaudeCode,
            &review
        ));
        review.manifest_attested = true;
        assert!(tool_review_allows_project_inspection(
            ConnectorKind::ClaudeCode,
            &review
        ));
        review.network_accessed = true;
        assert!(!tool_review_allows_project_inspection(
            ConnectorKind::ClaudeCode,
            &review
        ));
    }

    #[test]
    fn unavailable_trust_storage_is_not_downgraded_to_unconfigured() {
        let snapshot = discover_with_environment(DiscoveryEnvironment {
            codex_trust: TrustProbe::Unavailable,
            ..DiscoveryEnvironment::default()
        });
        assert_eq!(
            snapshot.connectors[0].authorization_probe,
            ConnectorAuthorizationProbe::Unavailable
        );
        assert!(snapshot.connectors[0].trusted_instances.is_empty());
    }

    #[test]
    fn legacy_fixed_identity_is_visible_but_requires_reconnection() {
        let snapshot = discover_with_environment(DiscoveryEnvironment {
            codex_trust: TrustProbe::Available(vec![yuanyuan_bridge::TrustIdentitySummary {
                connector_id: "builtin.codex".to_owned(),
                source_instance: "00000000-0000-4000-8000-000000000001".to_owned(),
                generation: 1,
                active: true,
                grace_expires_at_unix_ms: None,
            }]),
            ..DiscoveryEnvironment::default()
        });
        let instance = &snapshot.connectors[0].trusted_instances[0];
        assert!(instance.legacy_identity);
        assert_eq!(
            instance.authorization_state,
            ConnectorAuthorizationState::ReconnectRequired
        );
    }

    #[test]
    fn codex_executable_managed_by_the_desktop_app_is_not_reported_as_a_second_cli() {
        let store_path = std::path::Path::new(
            r"C:\Program Files\WindowsApps\OpenAI.Codex_26.727.1.0_x64__publisher\app\resources\codex.exe",
        );
        assert!(is_codex_desktop_managed_path(store_path));
        assert!(is_codex_windows_app_package_path(store_path));
        assert!(is_codex_desktop_managed_path(std::path::Path::new(
            r"C:\Users\Example\AppData\Local\OpenAI\Codex\bin\version\codex.exe"
        )));
        assert!(!is_codex_windows_app_package_path(std::path::Path::new(
            r"C:\Users\Example\AppData\Local\OpenAI\Codex\bin\version\codex.exe"
        )));
        assert!(!is_codex_desktop_managed_path(std::path::Path::new(
            r"C:\Users\Example\AppData\Roaming\npm\codex.cmd"
        )));
    }

    #[test]
    fn concurrent_discovery_is_deterministic_and_does_not_create_identity_state() {
        let root =
            std::env::temp_dir().join(format!("yuanyuan-discovery-{}", uuid::Uuid::new_v4()));
        let bin = root.join("bin");
        create_file(&bin.join("codex.exe"));
        let environment = DiscoveryEnvironment {
            path_entries: vec![bin],
            now_unix_ms: 1_000,
            ..DiscoveryEnvironment::default()
        };
        let handles = (0..8)
            .map(|_| {
                let environment = environment.clone();
                std::thread::spawn(move || discover_with_environment(environment))
            })
            .collect::<Vec<_>>();
        let snapshots = handles
            .into_iter()
            .map(|handle| handle.join().unwrap())
            .collect::<Vec<_>>();
        assert!(snapshots.windows(2).all(|pair| pair[0] == pair[1]));
        assert!(snapshots.iter().all(|snapshot| {
            snapshot
                .connectors
                .iter()
                .all(|connector| connector.trusted_instances.is_empty())
        }));
        assert_eq!(std::fs::read_dir(&root).unwrap().count(), 1);
        std::fs::remove_dir_all(root).unwrap();
    }
}
