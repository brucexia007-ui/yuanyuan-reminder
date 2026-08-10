#![cfg(windows)]

use std::path::PathBuf;

use serde::Serialize;
use yuanyuan_connectors::config_preview::{
    preview_hook_config_sources, ConnectorHookTool, HookConfigSource, HookConfigSourceInput,
    HookConfigSourcesPreview, OwnedCommandHookSpec,
};

use crate::{
    connector_config_write::read_snapshot,
    connector_trust_control::{
        connector_implementation, trust_database_path, ConnectorImplementation,
    },
    error::{AppError, AppResult},
};

const OWNER_ID: &str = "yuanyuan-reminder";

pub(crate) struct AuthorizedHookContext {
    pub(crate) implementation: ConnectorImplementation,
    pub(crate) expected: Vec<OwnedCommandHookSpec>,
}

#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum HookConfigInspectionStatus {
    Checked,
    ManualReview,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ConnectorHookConfigInspection {
    status: HookConfigInspectionStatus,
    preview: Option<HookConfigSourcesPreview>,
    private_configuration_read: bool,
    project_configuration_read: bool,
    task_data_read: bool,
    source_processes_executed: bool,
    config_write_performed: bool,
    source_task_behavior_changed: bool,
}

#[derive(Debug)]
pub(crate) struct CandidateSource {
    pub(crate) source: HookConfigSource,
    pub(crate) input: Vec<u8>,
}

#[derive(Debug, Clone, Copy)]
pub(crate) struct CandidateSourceScanError {
    pub(crate) sources_read: usize,
}

pub fn inspect_connector_hook_config(
    connector_id: String,
    source_instance: String,
) -> AppResult<ConnectorHookConfigInspection> {
    let context = resolve_authorized_hook_context(&connector_id, &source_instance)?;
    inspect_user_config_sources(context.implementation, &context.expected)
}

pub(crate) fn resolve_authorized_hook_context(
    connector_id: &str,
    source_instance: &str,
) -> AppResult<AuthorizedHookContext> {
    let (implementation, legacy) =
        connector_implementation(connector_id).ok_or_else(generic_inspection_error)?;
    if legacy || uuid::Uuid::parse_str(source_instance).is_err() {
        return Err(generic_inspection_error());
    }

    let trust =
        yuanyuan_bridge::ConnectorTrustStore::open_existing_read_only(trust_database_path()?)
            .map_err(|_| generic_inspection_error())?;
    let trust = trust
        .status(connector_id, source_instance)
        .map_err(|_| generic_inspection_error())?
        .filter(|status| status.active)
        .ok_or_else(generic_inspection_error)?;
    let key_id = trust.active_key_id.ok_or_else(generic_inspection_error)?;

    let bridge_path = std::env::current_exe()
        .ok()
        .and_then(|path| {
            path.parent()
                .map(|parent| parent.join("yuanyuan-bridge.exe"))
        })
        .ok_or_else(generic_inspection_error)?;
    let expected = expected_specs(
        implementation,
        &bridge_path.to_string_lossy(),
        connector_id,
        source_instance,
        &key_id,
    );
    Ok(AuthorizedHookContext {
        implementation,
        expected,
    })
}

fn inspect_user_config_sources(
    implementation: ConnectorImplementation,
    expected: &[OwnedCommandHookSpec],
) -> AppResult<ConnectorHookConfigInspection> {
    let sources = match scan_user_config_sources(implementation) {
        Ok(sources) => sources,
        Err(_) => return Ok(manual_review()),
    };
    preview_sources(implementation, sources, expected)
}

pub(crate) fn scan_user_config_sources(
    implementation: ConnectorImplementation,
) -> Result<Vec<CandidateSource>, CandidateSourceScanError> {
    let root = match official_user_config_root(implementation) {
        Ok(root) => root,
        Err(()) => return Err(CandidateSourceScanError { sources_read: 0 }),
    };
    let Some(root) = root else {
        return Ok(Vec::new());
    };
    if !ordinary_directory(&root) {
        return Err(CandidateSourceScanError { sources_read: 0 });
    }

    let candidates = match implementation {
        ConnectorImplementation::Codex => [
            (HookConfigSource::CodexUserHooksJson, "hooks.json"),
            (HookConfigSource::CodexUserConfigToml, "config.toml"),
        ]
        .as_slice(),
        ConnectorImplementation::ClaudeCode => {
            [(HookConfigSource::ClaudeUserSettingsJson, "settings.json")].as_slice()
        }
    };
    let mut sources = Vec::with_capacity(candidates.len());
    for (source, name) in candidates {
        match read_bounded_ordinary_file(root.join(name)) {
            Ok(Some(input)) => sources.push(CandidateSource {
                source: *source,
                input,
            }),
            Ok(None) => {}
            Err(()) => {
                return Err(CandidateSourceScanError {
                    sources_read: sources.len(),
                })
            }
        }
    }
    Ok(sources)
}

pub(crate) fn official_user_config_root(
    implementation: ConnectorImplementation,
) -> Result<Option<PathBuf>, ()> {
    let profile = std::env::var_os("USERPROFILE").map(PathBuf::from);
    let root = match implementation {
        ConnectorImplementation::Codex => std::env::var_os("CODEX_HOME")
            .map(PathBuf::from)
            .or_else(|| profile.map(|path| path.join(".codex"))),
        ConnectorImplementation::ClaudeCode => profile.map(|path| path.join(".claude")),
    };
    match root {
        Some(root) if root.is_absolute() => Ok(Some(root)),
        Some(_) => Err(()),
        None => Ok(None),
    }
}

fn preview_sources(
    implementation: ConnectorImplementation,
    sources: Vec<CandidateSource>,
    expected: &[OwnedCommandHookSpec],
) -> AppResult<ConnectorHookConfigInspection> {
    let private_configuration_read = !sources.is_empty();
    let inputs = sources
        .iter()
        .map(|source| HookConfigSourceInput {
            source: source.source,
            input: &source.input,
        })
        .collect::<Vec<_>>();
    let tool = match implementation {
        ConnectorImplementation::Codex => ConnectorHookTool::Codex,
        ConnectorImplementation::ClaudeCode => ConnectorHookTool::ClaudeCode,
    };
    let preview = preview_hook_config_sources(tool, &inputs, expected)
        .map_err(|_| generic_inspection_error())?;
    Ok(ConnectorHookConfigInspection {
        status: HookConfigInspectionStatus::Checked,
        preview: Some(preview),
        private_configuration_read,
        project_configuration_read: false,
        task_data_read: false,
        source_processes_executed: false,
        config_write_performed: false,
        source_task_behavior_changed: false,
    })
}

fn manual_review() -> ConnectorHookConfigInspection {
    ConnectorHookConfigInspection {
        status: HookConfigInspectionStatus::ManualReview,
        preview: None,
        private_configuration_read: false,
        project_configuration_read: false,
        task_data_read: false,
        source_processes_executed: false,
        config_write_performed: false,
        source_task_behavior_changed: false,
    }
}

fn read_bounded_ordinary_file(path: PathBuf) -> Result<Option<Vec<u8>>, ()> {
    let snapshot = read_snapshot(&path).map_err(|_| ())?;
    Ok(snapshot.exists().then(|| snapshot.bytes().to_vec()))
}

fn ordinary_directory(path: &std::path::Path) -> bool {
    use std::os::windows::fs::MetadataExt;

    const FILE_ATTRIBUTE_REPARSE_POINT: u32 = 0x0000_0400;
    match std::fs::symlink_metadata(path) {
        Ok(metadata) => {
            metadata.is_dir() && metadata.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT == 0
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => true,
        Err(_) => false,
    }
}

pub(crate) fn expected_specs(
    implementation: ConnectorImplementation,
    bridge_path: &str,
    connector_id: &str,
    source_instance: &str,
    key_id: &str,
) -> Vec<OwnedCommandHookSpec> {
    let (source, events): (&str, &[&str]) = match implementation {
        ConnectorImplementation::Codex => (
            "codex-hooks",
            &[
                "SessionStart",
                "UserPromptSubmit",
                "PermissionRequest",
                "PostToolUse",
                "Stop",
                "SessionEnd",
            ],
        ),
        ConnectorImplementation::ClaudeCode => (
            "claude-code-hooks",
            &[
                "SessionStart",
                "UserPromptSubmit",
                "PermissionRequest",
                "Notification",
                "PostToolUse",
                "PostToolUseFailure",
                "TaskCreated",
                "TaskCompleted",
                "Stop",
                "StopFailure",
                "SessionEnd",
            ],
        ),
    };
    let args = vec![
        "--owner-id".to_owned(),
        OWNER_ID.to_owned(),
        "--source".to_owned(),
        source.to_owned(),
        "--connector-id".to_owned(),
        connector_id.to_owned(),
        "--source-instance".to_owned(),
        source_instance.to_owned(),
        "--key-id".to_owned(),
        key_id.to_owned(),
    ];
    events
        .iter()
        .map(|event| {
            let (command, handler_args) = match implementation {
                ConnectorImplementation::Codex => (
                    format!(
                        "\"{bridge_path}\" {}",
                        args.iter()
                            .map(String::as_str)
                            .collect::<Vec<_>>()
                            .join(" ")
                    ),
                    Vec::new(),
                ),
                ConnectorImplementation::ClaudeCode => (bridge_path.to_owned(), args.clone()),
            };
            OwnedCommandHookSpec {
                event: (*event).to_owned(),
                matcher: None,
                command,
                args: handler_args,
                timeout_seconds: Some(1),
                owner_id: OWNER_ID.to_owned(),
                connector_id: connector_id.to_owned(),
                source_instance: source_instance.to_owned(),
            }
        })
        .collect()
}

fn generic_inspection_error() -> AppError {
    AppError::Validation("连接器配置检查失败，请刷新状态后重试。".to_owned())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn specs(implementation: ConnectorImplementation) -> Vec<OwnedCommandHookSpec> {
        expected_specs(
            implementation,
            r"C:\Program Files\Yuanyuan\yuanyuan-bridge.exe",
            "builtin.codex.00000000-0000-4000-8000-000000000010",
            "00000000-0000-4000-8000-000000000001",
            "credential-reference-1",
        )
    }

    #[test]
    fn expected_hook_sets_use_stable_instance_identity_and_never_fixed_selector() {
        let specs = specs(ConnectorImplementation::Codex);
        assert_eq!(specs.len(), 6);
        assert!(specs.iter().all(|spec| {
            spec.connector_id.starts_with("builtin.codex.")
                && spec.connector_id != "builtin.codex"
                && spec.timeout_seconds == Some(1)
        }));
    }

    #[test]
    fn missing_config_sources_are_a_checked_read_only_add_preview() {
        let preview = preview_sources(
            ConnectorImplementation::Codex,
            Vec::new(),
            &specs(ConnectorImplementation::Codex),
        )
        .unwrap();
        assert_eq!(preview.status, HookConfigInspectionStatus::Checked);
        assert!(!preview.private_configuration_read);
        assert!(!preview.config_write_performed);
        let preview = preview.preview.unwrap();
        assert_eq!(preview.source_files, 0);
        assert_eq!(preview.expected_handlers, 6);
    }

    #[test]
    fn bounded_reader_never_modifies_existing_config() {
        let root = std::env::temp_dir().join(format!(
            "yuanyuan-config-inspection-{}",
            uuid::Uuid::new_v4()
        ));
        std::fs::create_dir_all(&root).unwrap();
        let path = root.join("hooks.json");
        let original = br#"{"hooks":{},"userSetting":true}"#;
        std::fs::write(&path, original).unwrap();
        assert_eq!(
            read_bounded_ordinary_file(path.clone()).unwrap(),
            Some(original.to_vec())
        );
        assert_eq!(std::fs::read(&path).unwrap(), original);
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn oversized_config_is_refused_before_parsing() {
        use yuanyuan_connectors::config_preview::MAX_HOOK_CONFIG_BYTES;

        let root = std::env::temp_dir().join(format!(
            "yuanyuan-config-inspection-{}",
            uuid::Uuid::new_v4()
        ));
        std::fs::create_dir_all(&root).unwrap();
        let path = root.join("settings.json");
        std::fs::write(&path, vec![b' '; MAX_HOOK_CONFIG_BYTES + 1]).unwrap();
        assert!(read_bounded_ordinary_file(path).is_err());
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn directories_are_never_accepted_as_config_files_or_config_roots_by_mistake() {
        let root = std::env::temp_dir().join(format!(
            "yuanyuan-config-inspection-{}",
            uuid::Uuid::new_v4()
        ));
        std::fs::create_dir_all(root.join("hooks.json")).unwrap();
        assert!(ordinary_directory(&root));
        assert!(read_bounded_ordinary_file(root.join("hooks.json")).is_err());
        let ordinary_file = root.join("not-a-root");
        std::fs::write(&ordinary_file, b"{}").unwrap();
        assert!(!ordinary_directory(&ordinary_file));
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn serialized_preview_never_returns_config_values_or_identity_material() {
        let expected = specs(ConnectorImplementation::Codex);
        let input = format!(
            r#"{{"hooks":{{"SessionStart":[{{"hooks":[{{"type":"command","command":{:?},"timeout":1}}]}}]}}}}"#,
            expected[0].command
        );
        let preview = preview_sources(
            ConnectorImplementation::Codex,
            vec![CandidateSource {
                source: HookConfigSource::CodexUserHooksJson,
                input: input.into_bytes(),
            }],
            &expected,
        )
        .unwrap();
        let encoded = serde_json::to_string(&preview).unwrap();
        for sensitive in [
            "Program Files",
            "yuanyuan-bridge.exe",
            "credential-reference-1",
            "00000000-0000-4000-8000-000000000001",
            "builtin.codex.00000000-0000-4000-8000-000000000010",
        ] {
            assert!(!encoded.contains(sensitive));
        }
        assert!(encoded.contains("configWritePerformed"));
    }
}
