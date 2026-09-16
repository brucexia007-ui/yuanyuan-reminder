#![cfg(windows)]

use std::{
    collections::HashMap,
    fs::{File, OpenOptions},
    os::windows::{fs::OpenOptionsExt, io::AsRawHandle},
    path::{Component, Path, PathBuf},
    time::{Duration, Instant},
};

use parking_lot::Mutex;
use serde::Serialize;
use tauri::{AppHandle, Manager};
use tauri_plugin_dialog::DialogExt;
use uuid::Uuid;
use windows_sys::Win32::{
    Foundation::HANDLE,
    Storage::FileSystem::{
        GetFileInformationByHandle, BY_HANDLE_FILE_INFORMATION, FILE_ATTRIBUTE_DIRECTORY,
        FILE_ATTRIBUTE_REPARSE_POINT, FILE_FLAG_BACKUP_SEMANTICS, FILE_FLAG_OPEN_REPARSE_POINT,
        FILE_SHARE_DELETE, FILE_SHARE_READ, FILE_SHARE_WRITE,
    },
};
use yuanyuan_connectors::config_preview::{
    preview_hook_config_sources, ConnectorHookTool, HookConfigSource, HookConfigSourceInput,
    HookConfigSourcesPreview,
};

use crate::{
    connector_config_preview::{
        resolve_authorized_hook_context, scan_user_config_sources, AuthorizedHookContext,
        CandidateSource,
    },
    connector_config_write::read_snapshot,
    connector_trust_control::ConnectorImplementation,
};

const CONFIRMATION_LIFETIME: Duration = Duration::from_secs(2 * 60);
const MAX_PENDING_INSPECTIONS: usize = 16;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct DirectoryIdentity {
    volume_serial: u32,
    file_index: u64,
}

/// A sealed directory capability. Only a future trusted native picker adapter
/// in this module may construct it; command arguments can never supply a path.
struct ProjectDirectorySelection {
    path: PathBuf,
    identity: DirectoryIdentity,
}

struct PendingInspection {
    connector_id: String,
    source_instance: String,
    implementation: ConnectorImplementation,
    selection: ProjectDirectorySelection,
    expires_at: Instant,
}

#[derive(Default)]
pub(crate) struct ProjectInspectionCoordinator {
    pending: Mutex<HashMap<String, PendingInspection>>,
}

#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub(crate) enum ProjectPickerStatus {
    Cancelled,
    ConfirmationRequired,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ProjectPickerResult {
    status: ProjectPickerStatus,
    preview: Option<ProjectInspectionAuthorizationPreview>,
    selected_path_returned: bool,
    selection_persisted: bool,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ProjectInspectionAuthorizationPreview {
    confirmation_token: String,
    expires_in_seconds: u64,
    tool: ConnectorHookTool,
    project_directory_verified: bool,
    user_hook_configuration_may_be_read: bool,
    project_hook_configuration_may_be_read: bool,
    task_data_read: bool,
    source_processes_executed: bool,
    config_write_performed: bool,
    source_task_behavior_changed: bool,
    selected_path_returned: bool,
    selection_persisted: bool,
}

#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub(crate) enum ProjectInspectionStatus {
    Checked,
    ManualReview,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ProjectInspectionResult {
    status: ProjectInspectionStatus,
    preview: Option<HookConfigSourcesPreview>,
    project_directory_checked: bool,
    user_configuration_files_read: usize,
    project_configuration_files_read: usize,
    private_configuration_read: bool,
    project_configuration_read: bool,
    task_data_read: bool,
    source_processes_executed: bool,
    config_write_performed: bool,
    source_task_behavior_changed: bool,
    selected_path_returned: bool,
    selection_persisted: bool,
}

#[derive(Debug, thiserror::Error, Clone, Copy, PartialEq, Eq)]
pub(crate) enum ProjectInspectionError {
    #[error("the selected project directory is unsafe")]
    UnsafeSelection,
    #[error("too many project inspections are awaiting confirmation")]
    ConfirmationCapacityReached,
    #[error("the project inspection confirmation is invalid or expired")]
    InvalidConfirmation,
    #[error("connector authorization changed after confirmation")]
    AuthorizationChanged,
    #[error("the source tool did not pass the required trust review")]
    SourceToolUnverified,
    #[error("the selected project directory changed after confirmation")]
    DirectoryChanged,
}

impl ProjectDirectorySelection {
    fn from_trusted_picker_path(path: PathBuf) -> Result<Self, ProjectInspectionError> {
        use std::os::windows::fs::MetadataExt;

        if !path.is_absolute()
            || path.file_name().is_none()
            || path
                .components()
                .any(|component| matches!(component, Component::CurDir | Component::ParentDir))
        {
            return Err(ProjectInspectionError::UnsafeSelection);
        }
        let metadata = std::fs::symlink_metadata(&path)
            .map_err(|_| ProjectInspectionError::UnsafeSelection)?;
        if !metadata.is_dir() || metadata.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT != 0 {
            return Err(ProjectInspectionError::UnsafeSelection);
        }
        let canonical =
            std::fs::canonicalize(path).map_err(|_| ProjectInspectionError::UnsafeSelection)?;
        let guard = DirectoryGuard::open(&canonical)?;
        Ok(Self {
            path: canonical,
            identity: guard.identity,
        })
    }
}

impl ProjectInspectionCoordinator {
    fn authorized_context(
        connector_id: &str,
        source_instance: &str,
    ) -> Result<AuthorizedHookContext, ProjectInspectionError> {
        let context = resolve_authorized_hook_context(connector_id, source_instance)
            .map_err(|_| ProjectInspectionError::AuthorizationChanged)?;
        if !crate::connector_discovery::builtin_tool_trust_verified(context.implementation) {
            return Err(ProjectInspectionError::SourceToolUnverified);
        }
        Ok(context)
    }

    fn preview(
        &self,
        connector_id: String,
        source_instance: String,
        selection: ProjectDirectorySelection,
    ) -> Result<ProjectInspectionAuthorizationPreview, ProjectInspectionError> {
        let context = Self::authorized_context(&connector_id, &source_instance)?;
        self.preview_authorized_at(
            connector_id,
            source_instance,
            context.implementation,
            selection,
            Instant::now(),
        )
    }

    fn preview_authorized_at(
        &self,
        connector_id: String,
        source_instance: String,
        implementation: ConnectorImplementation,
        selection: ProjectDirectorySelection,
        now: Instant,
    ) -> Result<ProjectInspectionAuthorizationPreview, ProjectInspectionError> {
        if directory_identity_at(&selection.path)
            .map_err(|_| ProjectInspectionError::DirectoryChanged)?
            != selection.identity
        {
            return Err(ProjectInspectionError::DirectoryChanged);
        }
        let mut pending = self.pending.lock();
        pending.retain(|_, value| value.expires_at > now);
        if pending.len() >= MAX_PENDING_INSPECTIONS {
            return Err(ProjectInspectionError::ConfirmationCapacityReached);
        }
        let token = Uuid::new_v4().to_string();
        pending.insert(
            token.clone(),
            PendingInspection {
                connector_id,
                source_instance,
                implementation,
                selection,
                expires_at: now + CONFIRMATION_LIFETIME,
            },
        );
        Ok(ProjectInspectionAuthorizationPreview {
            confirmation_token: token,
            expires_in_seconds: CONFIRMATION_LIFETIME.as_secs(),
            tool: connector_tool(implementation),
            project_directory_verified: true,
            user_hook_configuration_may_be_read: true,
            project_hook_configuration_may_be_read: true,
            task_data_read: false,
            source_processes_executed: false,
            config_write_performed: false,
            source_task_behavior_changed: false,
            selected_path_returned: false,
            selection_persisted: false,
        })
    }

    fn apply(&self, token: &str) -> Result<ProjectInspectionResult, ProjectInspectionError> {
        let pending = self.take_at(token, Instant::now())?;
        let context = Self::authorized_context(&pending.connector_id, &pending.source_instance)?;
        if context.implementation != pending.implementation {
            return Err(ProjectInspectionError::AuthorizationChanged);
        }
        inspect_selection(pending.selection, context, || {})
    }

    fn take_at(
        &self,
        token: &str,
        now: Instant,
    ) -> Result<PendingInspection, ProjectInspectionError> {
        if Uuid::parse_str(token).is_err() {
            return Err(ProjectInspectionError::InvalidConfirmation);
        }
        let mut pending = self.pending.lock();
        pending.retain(|_, value| value.expires_at > now);
        pending
            .remove(token)
            .ok_or(ProjectInspectionError::InvalidConfirmation)
    }

    fn cancel(&self, token: &str) {
        if Uuid::parse_str(token).is_ok() {
            self.pending.lock().remove(token);
        }
    }
}

pub(crate) fn select_project_with_native_picker(
    app: &AppHandle,
    connector_id: String,
    source_instance: String,
    coordinator: &ProjectInspectionCoordinator,
) -> Result<ProjectPickerResult, ProjectInspectionError> {
    // Reject stale authorization or an untrusted source before asking the
    // user to choose anything. `preview` repeats this after the dialog.
    ProjectInspectionCoordinator::authorized_context(&connector_id, &source_instance)?;
    let panel = app.get_webview_window("panel");
    let mut picker = app.dialog().file().set_title(format!(
        "选择允许{}只读检查 Hook 的项目文件夹",
        crate::brand::pet_display_name()
    ));
    if let Some(panel) = panel.as_ref() {
        picker = picker.set_parent(panel);
    }
    let selected = picker.blocking_pick_folder();
    let Some(selected) = selected else {
        return Ok(ProjectPickerResult {
            status: ProjectPickerStatus::Cancelled,
            preview: None,
            selected_path_returned: false,
            selection_persisted: false,
        });
    };
    let path = selected
        .into_path()
        .map_err(|_| ProjectInspectionError::UnsafeSelection)?;
    let selection = ProjectDirectorySelection::from_trusted_picker_path(path)?;
    let preview = coordinator.preview(connector_id, source_instance, selection)?;
    Ok(ProjectPickerResult {
        status: ProjectPickerStatus::ConfirmationRequired,
        preview: Some(preview),
        selected_path_returned: false,
        selection_persisted: false,
    })
}

pub(crate) fn apply_project_inspection(
    coordinator: &ProjectInspectionCoordinator,
    confirmation_token: &str,
) -> Result<ProjectInspectionResult, ProjectInspectionError> {
    coordinator.apply(confirmation_token)
}

pub(crate) fn cancel_project_inspection(
    coordinator: &ProjectInspectionCoordinator,
    confirmation_token: &str,
) {
    coordinator.cancel(confirmation_token);
}

fn inspect_selection<F>(
    selection: ProjectDirectorySelection,
    context: AuthorizedHookContext,
    before_final_identity_check: F,
) -> Result<ProjectInspectionResult, ProjectInspectionError>
where
    F: FnOnce(),
{
    let root_guard = DirectoryGuard::open(&selection.path)
        .map_err(|_| ProjectInspectionError::DirectoryChanged)?;
    if root_guard.identity != selection.identity {
        return Err(ProjectInspectionError::DirectoryChanged);
    }

    let user_sources = match scan_user_config_sources(context.implementation) {
        Ok(sources) => sources,
        Err(error) => {
            ensure_directory_identity(&selection.path, selection.identity)?;
            return Ok(manual_review(error.sources_read, 0));
        }
    };
    let user_count = user_sources.len();
    let (project_sources, project_guard) =
        match scan_project_sources(&selection.path, context.implementation) {
            Ok(value) => value,
            Err(read_count) => {
                ensure_directory_identity(&selection.path, selection.identity)?;
                return Ok(manual_review(user_count, read_count));
            }
        };
    let project_count = project_sources.len();
    before_final_identity_check();
    ensure_directory_identity(&selection.path, selection.identity)?;
    project_guard.ensure_unchanged()?;

    let mut sources = user_sources;
    sources.extend(project_sources);
    let inputs = sources
        .iter()
        .map(|candidate| HookConfigSourceInput {
            source: candidate.source,
            input: &candidate.input,
        })
        .collect::<Vec<_>>();
    let preview = preview_combined_sources(context.implementation, &inputs, &context.expected)?;

    drop(root_guard);
    Ok(ProjectInspectionResult {
        status: ProjectInspectionStatus::Checked,
        preview: Some(preview),
        project_directory_checked: true,
        user_configuration_files_read: user_count,
        project_configuration_files_read: project_count,
        private_configuration_read: user_count > 0,
        project_configuration_read: project_count > 0,
        task_data_read: false,
        source_processes_executed: false,
        config_write_performed: false,
        source_task_behavior_changed: false,
        selected_path_returned: false,
        selection_persisted: false,
    })
}

fn scan_project_sources(
    root: &Path,
    implementation: ConnectorImplementation,
) -> Result<(Vec<CandidateSource>, OptionalDirectoryGuard), usize> {
    let (directory_name, candidates): (&str, &[(HookConfigSource, &str)]) = match implementation {
        ConnectorImplementation::Codex => (
            ".codex",
            &[
                (HookConfigSource::CodexProjectHooksJson, "hooks.json"),
                (HookConfigSource::CodexProjectConfigToml, "config.toml"),
            ],
        ),
        ConnectorImplementation::ClaudeCode => (
            ".claude",
            &[
                (HookConfigSource::ClaudeProjectSettingsJson, "settings.json"),
                (
                    HookConfigSource::ClaudeProjectLocalSettingsJson,
                    "settings.local.json",
                ),
            ],
        ),
    };
    let directory = root.join(directory_name);
    let guard = OptionalDirectoryGuard::open(&directory).map_err(|_| 0usize)?;
    if matches!(guard, OptionalDirectoryGuard::Missing { .. }) {
        return Ok((Vec::new(), guard));
    }

    let mut sources = Vec::with_capacity(candidates.len());
    for (source, name) in candidates {
        match read_snapshot(&directory.join(name)) {
            Ok(snapshot) if snapshot.exists() => sources.push(CandidateSource {
                source: *source,
                input: snapshot.bytes().to_vec(),
            }),
            Ok(_) => {}
            Err(_) => return Err(sources.len()),
        }
    }
    Ok((sources, guard))
}

fn manual_review(user_count: usize, project_count: usize) -> ProjectInspectionResult {
    ProjectInspectionResult {
        status: ProjectInspectionStatus::ManualReview,
        preview: None,
        project_directory_checked: true,
        user_configuration_files_read: user_count,
        project_configuration_files_read: project_count,
        private_configuration_read: user_count > 0,
        project_configuration_read: project_count > 0,
        task_data_read: false,
        source_processes_executed: false,
        config_write_performed: false,
        source_task_behavior_changed: false,
        selected_path_returned: false,
        selection_persisted: false,
    }
}

fn connector_tool(implementation: ConnectorImplementation) -> ConnectorHookTool {
    match implementation {
        ConnectorImplementation::Codex => ConnectorHookTool::Codex,
        ConnectorImplementation::ClaudeCode => ConnectorHookTool::ClaudeCode,
    }
}

fn preview_combined_sources(
    implementation: ConnectorImplementation,
    inputs: &[HookConfigSourceInput<'_>],
    expected: &[yuanyuan_connectors::config_preview::OwnedCommandHookSpec],
) -> Result<HookConfigSourcesPreview, ProjectInspectionError> {
    preview_hook_config_sources(connector_tool(implementation), inputs, expected)
        .map_err(|_| ProjectInspectionError::AuthorizationChanged)
}

struct DirectoryGuard {
    _handle: File,
    identity: DirectoryIdentity,
}

impl DirectoryGuard {
    fn open(path: &Path) -> Result<Self, ProjectInspectionError> {
        let handle = OpenOptions::new()
            .access_mode(0)
            .share_mode(FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE)
            .custom_flags(FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT)
            .open(path)
            .map_err(|_| ProjectInspectionError::UnsafeSelection)?;
        let identity = directory_identity(&handle)?;
        Ok(Self {
            _handle: handle,
            identity,
        })
    }
}

enum OptionalDirectoryGuard {
    Missing {
        path: PathBuf,
    },
    Existing {
        path: PathBuf,
        _handle: File,
        identity: DirectoryIdentity,
    },
}

impl OptionalDirectoryGuard {
    fn open(path: &Path) -> Result<Self, ProjectInspectionError> {
        match std::fs::symlink_metadata(path) {
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(Self::Missing {
                path: path.to_owned(),
            }),
            Err(_) => Err(ProjectInspectionError::UnsafeSelection),
            Ok(_) => {
                let guard = DirectoryGuard::open(path)?;
                Ok(Self::Existing {
                    path: path.to_owned(),
                    _handle: guard._handle,
                    identity: guard.identity,
                })
            }
        }
    }

    fn ensure_unchanged(&self) -> Result<(), ProjectInspectionError> {
        match self {
            Self::Missing { path } => match std::fs::symlink_metadata(path) {
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
                _ => Err(ProjectInspectionError::DirectoryChanged),
            },
            Self::Existing { path, identity, .. } => ensure_directory_identity(path, *identity),
        }
    }
}

fn directory_identity_at(path: &Path) -> Result<DirectoryIdentity, ProjectInspectionError> {
    DirectoryGuard::open(path).map(|guard| guard.identity)
}

fn ensure_directory_identity(
    path: &Path,
    expected: DirectoryIdentity,
) -> Result<(), ProjectInspectionError> {
    (directory_identity_at(path).map_err(|_| ProjectInspectionError::DirectoryChanged)? == expected)
        .then_some(())
        .ok_or(ProjectInspectionError::DirectoryChanged)
}

fn directory_identity(handle: &File) -> Result<DirectoryIdentity, ProjectInspectionError> {
    let mut information = BY_HANDLE_FILE_INFORMATION {
        dwFileAttributes: 0,
        ftCreationTime: Default::default(),
        ftLastAccessTime: Default::default(),
        ftLastWriteTime: Default::default(),
        dwVolumeSerialNumber: 0,
        nFileSizeHigh: 0,
        nFileSizeLow: 0,
        nNumberOfLinks: 0,
        nFileIndexHigh: 0,
        nFileIndexLow: 0,
    };
    // SAFETY: the handle is owned by the live File and the output pointer is
    // valid for the duration of the call.
    let ok = unsafe {
        GetFileInformationByHandle(
            handle.as_raw_handle() as HANDLE,
            std::ptr::addr_of_mut!(information),
        )
    };
    if ok == 0
        || information.dwFileAttributes & FILE_ATTRIBUTE_DIRECTORY == 0
        || information.dwFileAttributes & FILE_ATTRIBUTE_REPARSE_POINT != 0
    {
        return Err(ProjectInspectionError::UnsafeSelection);
    }
    Ok(DirectoryIdentity {
        volume_serial: information.dwVolumeSerialNumber,
        file_index: (u64::from(information.nFileIndexHigh) << 32)
            | u64::from(information.nFileIndexLow),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::connector_config_preview::expected_specs;
    use yuanyuan_connectors::config_preview::HookSourcesConflict;

    fn temp_project() -> PathBuf {
        let root =
            std::env::temp_dir().join(format!("yuanyuan-project-inspection-{}", Uuid::new_v4()));
        std::fs::create_dir_all(&root).unwrap();
        root
    }

    fn selection(path: &Path) -> ProjectDirectorySelection {
        ProjectDirectorySelection::from_trusted_picker_path(path.to_owned()).unwrap()
    }

    fn context(implementation: ConnectorImplementation) -> AuthorizedHookContext {
        let connector = match implementation {
            ConnectorImplementation::Codex => "builtin.codex.test",
            ConnectorImplementation::ClaudeCode => "builtin.claude-code.test",
        };
        AuthorizedHookContext {
            implementation,
            expected: expected_specs(
                implementation,
                r"C:\Program Files\Yuanyuan\yuanyuan-bridge.exe",
                connector,
                "00000000-0000-4000-8000-000000000001",
                "credential-reference-1",
            ),
        }
    }

    fn inspect_without_user_sources(
        selection: ProjectDirectorySelection,
        context: AuthorizedHookContext,
    ) -> Result<ProjectInspectionResult, ProjectInspectionError> {
        let root_guard = DirectoryGuard::open(&selection.path)?;
        if root_guard.identity != selection.identity {
            return Err(ProjectInspectionError::DirectoryChanged);
        }
        let (project_sources, guard) =
            scan_project_sources(&selection.path, context.implementation)
                .map_err(|_| ProjectInspectionError::UnsafeSelection)?;
        ensure_directory_identity(&selection.path, selection.identity)?;
        guard.ensure_unchanged()?;
        let project_count = project_sources.len();
        let inputs = project_sources
            .iter()
            .map(|source| HookConfigSourceInput {
                source: source.source,
                input: &source.input,
            })
            .collect::<Vec<_>>();
        let preview = preview_hook_config_sources(
            connector_tool(context.implementation),
            &inputs,
            &context.expected,
        )
        .unwrap();
        Ok(ProjectInspectionResult {
            status: ProjectInspectionStatus::Checked,
            preview: Some(preview),
            project_directory_checked: true,
            user_configuration_files_read: 0,
            project_configuration_files_read: project_count,
            private_configuration_read: false,
            project_configuration_read: project_count > 0,
            task_data_read: false,
            source_processes_executed: false,
            config_write_performed: false,
            source_task_behavior_changed: false,
            selected_path_returned: false,
            selection_persisted: false,
        })
    }

    #[test]
    fn authorization_preview_is_fixed_redacted_and_non_mutating() {
        let root = temp_project();
        let coordinator = ProjectInspectionCoordinator::default();
        let preview = coordinator
            .preview_authorized_at(
                "connector-secret".to_owned(),
                "instance-secret".to_owned(),
                ConnectorImplementation::Codex,
                selection(&root),
                Instant::now(),
            )
            .unwrap();
        let encoded = serde_json::to_string(&preview).unwrap();
        assert!(!encoded.contains(root.to_string_lossy().as_ref()));
        assert!(!encoded.contains("connector-secret"));
        assert!(!encoded.contains("instance-secret"));
        assert!(preview.project_directory_verified);
        assert!(!preview.task_data_read);
        assert!(!preview.config_write_performed);
        assert!(!preview.selected_path_returned);
        assert!(!preview.selection_persisted);
        let picker_result = ProjectPickerResult {
            status: ProjectPickerStatus::ConfirmationRequired,
            preview: Some(preview),
            selected_path_returned: false,
            selection_persisted: false,
        };
        let encoded = serde_json::to_string(&picker_result).unwrap();
        assert!(!encoded.contains(root.to_string_lossy().as_ref()));
        assert!(!encoded.contains("connector-secret"));
        assert!(!encoded.contains("instance-secret"));
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn tokens_expire_are_single_use_and_have_bounded_capacity() {
        let root = temp_project();
        let coordinator = ProjectInspectionCoordinator::default();
        let now = Instant::now();
        let first = coordinator
            .preview_authorized_at(
                "connector".to_owned(),
                "instance".to_owned(),
                ConnectorImplementation::Codex,
                selection(&root),
                now,
            )
            .unwrap();
        assert!(coordinator.take_at(&first.confirmation_token, now).is_ok());
        assert!(matches!(
            coordinator.take_at(&first.confirmation_token, now),
            Err(ProjectInspectionError::InvalidConfirmation)
        ));

        let cancelled = coordinator
            .preview_authorized_at(
                "cancelled".to_owned(),
                "instance".to_owned(),
                ConnectorImplementation::Codex,
                selection(&root),
                now,
            )
            .unwrap();
        coordinator.cancel(&cancelled.confirmation_token);
        assert!(matches!(
            coordinator.take_at(&cancelled.confirmation_token, now),
            Err(ProjectInspectionError::InvalidConfirmation)
        ));

        for index in 0..MAX_PENDING_INSPECTIONS {
            coordinator
                .preview_authorized_at(
                    format!("connector-{index}"),
                    "instance".to_owned(),
                    ConnectorImplementation::Codex,
                    selection(&root),
                    now,
                )
                .unwrap();
        }
        assert!(matches!(
            coordinator.preview_authorized_at(
                "overflow".to_owned(),
                "instance".to_owned(),
                ConnectorImplementation::Codex,
                selection(&root),
                now,
            ),
            Err(ProjectInspectionError::ConfirmationCapacityReached)
        ));
        let replacement = coordinator
            .preview_authorized_at(
                "after-expiry".to_owned(),
                "instance".to_owned(),
                ConnectorImplementation::Codex,
                selection(&root),
                now + CONFIRMATION_LIFETIME,
            )
            .unwrap();
        assert!(matches!(
            coordinator.take_at(
                &replacement.confirmation_token,
                now + CONFIRMATION_LIFETIME * 2
            ),
            Err(ProjectInspectionError::InvalidConfirmation)
        ));
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn only_fixed_codex_and_claude_project_sources_are_read() {
        for (implementation, directory, expected_files) in [
            (ConnectorImplementation::Codex, ".codex", 2usize),
            (ConnectorImplementation::ClaudeCode, ".claude", 2usize),
        ] {
            let root = temp_project();
            let config = root.join(directory);
            std::fs::create_dir_all(&config).unwrap();
            match implementation {
                ConnectorImplementation::Codex => {
                    std::fs::write(config.join("hooks.json"), b"{\"hooks\":{}}").unwrap();
                    std::fs::write(config.join("config.toml"), b"").unwrap();
                }
                ConnectorImplementation::ClaudeCode => {
                    std::fs::write(config.join("settings.json"), b"{\"hooks\":{}}").unwrap();
                    std::fs::write(config.join("settings.local.json"), b"{\"hooks\":{}}").unwrap();
                }
            }
            std::fs::write(root.join("private-task.txt"), b"must-not-be-read").unwrap();
            let result =
                inspect_without_user_sources(selection(&root), context(implementation)).unwrap();
            assert_eq!(result.project_configuration_files_read, expected_files);
            assert!(result.project_configuration_read);
            assert!(!result.task_data_read);
            assert_eq!(result.preview.unwrap().source_files, expected_files);
            std::fs::remove_dir_all(root).unwrap();
        }
    }

    #[test]
    fn missing_project_config_is_still_a_completed_directory_check() {
        let root = temp_project();
        let result =
            inspect_without_user_sources(selection(&root), context(ConnectorImplementation::Codex))
                .unwrap();
        assert!(result.project_directory_checked);
        assert_eq!(result.project_configuration_files_read, 0);
        assert!(!result.project_configuration_read);
        assert_eq!(result.preview.unwrap().source_files, 0);
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn user_and_project_hook_layers_coexist_without_a_false_conflict() {
        let context = context(ConnectorImplementation::Codex);
        let user = br#"{"hooks":{}}"#;
        let project = br#"{"hooks":{"SessionStart":[{"hooks":[{"type":"command","command":"echo user-owned-project-hook"}]}]}}"#;
        let inputs = [
            HookConfigSourceInput {
                source: HookConfigSource::CodexUserHooksJson,
                input: user,
            },
            HookConfigSourceInput {
                source: HookConfigSource::CodexProjectHooksJson,
                input: project,
            },
        ];
        let preview =
            preview_combined_sources(ConnectorImplementation::Codex, &inputs, &context.expected)
                .unwrap();
        assert_eq!(preview.source_files, 2);
        assert_eq!(preview.conflict, HookSourcesConflict::None);
    }

    #[test]
    fn an_owned_handler_in_project_scope_requires_manual_ownership_review() {
        let context = context(ConnectorImplementation::Codex);
        let command = serde_json::to_string(&context.expected[0].command).unwrap();
        let project = format!(
            r#"{{"hooks":{{"SessionStart":[{{"hooks":[{{"type":"command","command":{command},"timeout":1}}]}}]}}}}"#
        );
        let inputs = [HookConfigSourceInput {
            source: HookConfigSource::CodexProjectHooksJson,
            input: project.as_bytes(),
        }];
        let preview =
            preview_combined_sources(ConnectorImplementation::Codex, &inputs, &context.expected)
                .unwrap();
        assert_eq!(
            preview.conflict,
            HookSourcesConflict::OwnedOutsidePreferredSource
        );
    }

    #[test]
    fn selected_directory_replacement_invalidates_the_capability() {
        let root = temp_project();
        let selected = selection(&root);
        let moved = root.with_extension("moved");
        std::fs::rename(&root, &moved).unwrap();
        std::fs::create_dir_all(&root).unwrap();
        assert!(matches!(
            inspect_without_user_sources(selected, context(ConnectorImplementation::Codex)),
            Err(ProjectInspectionError::DirectoryChanged)
        ));
        std::fs::remove_dir_all(root).unwrap();
        std::fs::remove_dir_all(moved).unwrap();
    }

    #[test]
    fn config_subdirectory_replacement_during_read_is_detected() {
        let root = temp_project();
        let config = root.join(".codex");
        std::fs::create_dir_all(&config).unwrap();
        std::fs::write(config.join("hooks.json"), b"{\"hooks\":{}}").unwrap();
        let moved = root.join(".codex-old");
        let selected = selection(&root);
        let root_guard = DirectoryGuard::open(&selected.path).unwrap();
        let (_, project_guard) =
            scan_project_sources(&selected.path, ConnectorImplementation::Codex).unwrap();
        std::fs::rename(&config, &moved).unwrap();
        std::fs::create_dir_all(&config).unwrap();
        let result = project_guard.ensure_unchanged();
        assert!(matches!(
            result,
            Err(ProjectInspectionError::DirectoryChanged)
        ));
        drop(root_guard);
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn selected_reparse_directory_is_never_sealed_as_a_capability() {
        use std::os::windows::fs::symlink_dir;

        let root = temp_project();
        let target = root.join("target");
        let link = root.join("link");
        std::fs::create_dir_all(&target).unwrap();
        if symlink_dir(&target, &link).is_ok() {
            assert!(matches!(
                ProjectDirectorySelection::from_trusted_picker_path(link),
                Err(ProjectInspectionError::UnsafeSelection)
            ));
        }
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn roots_files_and_relative_paths_are_not_directory_capabilities() {
        assert!(matches!(
            ProjectDirectorySelection::from_trusted_picker_path(PathBuf::from("relative")),
            Err(ProjectInspectionError::UnsafeSelection)
        ));
        assert!(matches!(
            ProjectDirectorySelection::from_trusted_picker_path(PathBuf::from(r"C:\")),
            Err(ProjectInspectionError::UnsafeSelection)
        ));
        let root = temp_project();
        let file = root.join("file.txt");
        std::fs::write(&file, b"not a directory").unwrap();
        assert!(matches!(
            ProjectDirectorySelection::from_trusted_picker_path(file),
            Err(ProjectInspectionError::UnsafeSelection)
        ));
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn oversized_or_directory_config_requires_manual_review_without_reading_tasks() {
        use yuanyuan_connectors::config_preview::MAX_HOOK_CONFIG_BYTES;

        for make_directory in [false, true] {
            let root = temp_project();
            let config = root.join(".codex");
            std::fs::create_dir_all(&config).unwrap();
            let target = config.join("hooks.json");
            if make_directory {
                std::fs::create_dir_all(&target).unwrap();
            } else {
                std::fs::write(&target, vec![b' '; MAX_HOOK_CONFIG_BYTES + 1]).unwrap();
            }
            let read_count = match scan_project_sources(&root, ConnectorImplementation::Codex) {
                Err(read_count) => read_count,
                Ok(_) => panic!("unsafe config must stop the bounded scan"),
            };
            assert_eq!(read_count, 0);
            std::fs::remove_dir_all(root).unwrap();
        }
    }

    #[test]
    fn serialized_result_never_contains_paths_commands_or_identity_material() {
        let root = temp_project();
        std::fs::create_dir_all(root.join(".codex")).unwrap();
        std::fs::write(root.join(".codex/hooks.json"), b"{\"hooks\":{}}").unwrap();
        let result =
            inspect_without_user_sources(selection(&root), context(ConnectorImplementation::Codex))
                .unwrap();
        let encoded = serde_json::to_string(&result).unwrap();
        for sensitive in [
            root.to_string_lossy().as_ref(),
            "Program Files",
            "yuanyuan-bridge.exe",
            "credential-reference-1",
            "00000000-0000-4000-8000-000000000001",
        ] {
            assert!(!encoded.contains(sensitive));
        }
        std::fs::remove_dir_all(root).unwrap();
    }
}
