#![cfg(windows)]

use std::{
    collections::HashMap,
    path::{Path, PathBuf},
    time::{Duration, Instant},
};

use parking_lot::Mutex;
use serde::Serialize;
use uuid::Uuid;
use yuanyuan_connectors::config_preview::{
    preview_hook_config_sources, ConnectorHookTool, HookConfigFormat, HookConfigSource,
    HookConfigSourceInput, HookConfigSourcesPreview, HookSetPreviewAction, OwnedCommandHookSpec,
};

use crate::{
    connector_config_preview::{
        official_user_config_root, resolve_authorized_hook_context, AuthorizedHookContext,
    },
    connector_config_write::{
        ordinary_directory, read_snapshot, FileIdentity, FileSnapshot, HookConfigEditAction,
        HookConfigWriteCoordinator, HookConfigWriteError, HookConfigWriteResult,
    },
    connector_trust_control::ConnectorImplementation,
};

const CONFIRMATION_LIFETIME: Duration = Duration::from_secs(2 * 60);
const MAX_PENDING_OFFICIAL_WRITES: usize = 16;

struct OfficialWriteContext {
    implementation: ConnectorImplementation,
    root: PathBuf,
    expected: Vec<OwnedCommandHookSpec>,
}

#[derive(Clone, PartialEq, Eq)]
struct SourceFingerprint {
    source: HookConfigSource,
    path: PathBuf,
    exists: bool,
    digest: [u8; 32],
    identity: Option<FileIdentity>,
}

struct ScannedSource {
    fingerprint: SourceFingerprint,
    snapshot: FileSnapshot,
}

struct PendingOfficialWrite {
    connector_id: String,
    source_instance: String,
    implementation: ConnectorImplementation,
    root: PathBuf,
    expected: Vec<OwnedCommandHookSpec>,
    action: HookConfigEditAction,
    sources: Vec<SourceFingerprint>,
    source_preview: HookConfigSourcesPreview,
    inner_confirmation_token: String,
    expires_at: Instant,
}

#[derive(Default)]
pub(crate) struct OfficialHookConfigWriteCoordinator {
    writer: HookConfigWriteCoordinator,
    pending: Mutex<HashMap<String, PendingOfficialWrite>>,
}

#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub(crate) enum OfficialHookConfigWriteStatus {
    ReadyForConfirmation,
    NoChange,
    ManualReview,
}

#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub(crate) enum OfficialHookConfigAction {
    Connect,
    Disconnect,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct OfficialHookConfigWritePreview {
    pub action: OfficialHookConfigAction,
    pub status: OfficialHookConfigWriteStatus,
    pub confirmation_token: Option<String>,
    pub expires_in_seconds: u64,
    pub source_preview: HookConfigSourcesPreview,
    pub target_existed: bool,
    pub added_handlers: usize,
    pub removed_handlers: usize,
    pub backup_required: bool,
    pub lossless_edit_prepared: bool,
    pub official_target_resolved: bool,
    pub caller_path_accepted: bool,
    pub config_write_performed: bool,
    pub hook_configuration_changed: bool,
    pub source_task_behavior_changed: bool,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct OfficialHookConfigWriteResult {
    pub action: OfficialHookConfigAction,
    pub added_handlers: usize,
    pub removed_handlers: usize,
    pub backup_created: bool,
    pub official_target_revalidated: bool,
    pub all_user_sources_revalidated: bool,
    pub caller_path_accepted: bool,
    pub config_write_performed: bool,
    pub hook_configuration_changed: bool,
    pub source_task_behavior_changed: bool,
}

#[derive(Debug, thiserror::Error, Clone, Copy, PartialEq, Eq)]
pub(crate) enum OfficialHookConfigWriteError {
    #[error("authorized connector context is unavailable")]
    AuthorizationUnavailable,
    #[error("official hook configuration target is unavailable or unsafe")]
    UnsafeOfficialTarget,
    #[error("hook configuration requires manual review")]
    ManualReviewRequired,
    #[error("too many official hook changes are awaiting confirmation")]
    ConfirmationCapacityReached,
    #[error("official hook confirmation is invalid or expired")]
    InvalidConfirmation,
    #[error("authorized connector context or hook configuration changed after preview")]
    ConfigurationChanged,
    #[error("official hook configuration transaction failed safely")]
    WriteFailed,
}

impl OfficialHookConfigWriteCoordinator {
    /// Production entry: the caller supplies only a persisted connector
    /// identity. The target path is resolved entirely inside the stable core.
    pub(crate) fn preview(
        &self,
        connector_id: String,
        source_instance: String,
    ) -> Result<OfficialHookConfigWritePreview, OfficialHookConfigWriteError> {
        let context = resolve_official_context(&connector_id, &source_instance)?;
        self.preview_with_context(
            HookConfigEditAction::Add,
            connector_id,
            source_instance,
            context,
            Instant::now(),
        )
    }

    /// Production disconnect preview: like connect, the caller supplies only
    /// an active persisted identity and never a configuration path.
    pub(crate) fn preview_disconnect(
        &self,
        connector_id: String,
        source_instance: String,
    ) -> Result<OfficialHookConfigWritePreview, OfficialHookConfigWriteError> {
        let context = resolve_official_context(&connector_id, &source_instance)?;
        self.preview_with_context(
            HookConfigEditAction::Remove,
            connector_id,
            source_instance,
            context,
            Instant::now(),
        )
    }

    /// Production entry: the token already binds the connector identity and
    /// official target. No identity or path is accepted at apply time.
    pub(crate) fn apply(
        &self,
        confirmation_token: &str,
    ) -> Result<OfficialHookConfigWriteResult, OfficialHookConfigWriteError> {
        let now = Instant::now();
        let pending = self.take_pending(confirmation_token, now)?;
        let context =
            match resolve_official_context(&pending.connector_id, &pending.source_instance) {
                Ok(context) => context,
                Err(error) => {
                    self.writer
                        .discard_confirmation(&pending.inner_confirmation_token);
                    return Err(error);
                }
            };
        self.apply_pending(pending, context)
    }

    pub(crate) fn discard_confirmation(&self, confirmation_token: &str) {
        if let Some(pending) = self.pending.lock().remove(confirmation_token) {
            self.writer
                .discard_confirmation(&pending.inner_confirmation_token);
        }
    }

    fn preview_with_context(
        &self,
        action: HookConfigEditAction,
        connector_id: String,
        source_instance: String,
        context: OfficialWriteContext,
        now: Instant,
    ) -> Result<OfficialHookConfigWritePreview, OfficialHookConfigWriteError> {
        let scanned = scan_official_sources(&context)?;
        let source_preview = preview_scanned_sources(&context, &scanned)?;
        let preferred = preferred_source(&context, &scanned)?;

        if !source_preview.lossless_edit_supported
            || source_preview.proposed_action == HookSetPreviewAction::ManualReview
        {
            return Ok(manual_review_preview(action, source_preview, preferred));
        }

        let mut pending = self.pending.lock();
        let expired_inner_tokens = pending
            .values()
            .filter(|item| item.expires_at <= now)
            .map(|item| item.inner_confirmation_token.clone())
            .collect::<Vec<_>>();
        pending.retain(|_, item| item.expires_at > now);
        for token in expired_inner_tokens {
            self.writer.discard_confirmation(&token);
        }
        if pending.len() >= MAX_PENDING_OFFICIAL_WRITES {
            return Err(OfficialHookConfigWriteError::ConfirmationCapacityReached);
        }

        let write_preview = match action {
            HookConfigEditAction::Add => self.writer.preview_addition(
                preferred_format(context.implementation),
                preferred.fingerprint.path.clone(),
                context.expected.clone(),
            ),
            HookConfigEditAction::Remove => self.writer.preview_removal(
                preferred_format(context.implementation),
                preferred.fingerprint.path.clone(),
                context.expected.clone(),
            ),
        }
        .map_err(map_write_preview_error)?;

        let Some(inner_confirmation_token) = write_preview.confirmation_token else {
            return Ok(OfficialHookConfigWritePreview {
                action: action.into(),
                status: OfficialHookConfigWriteStatus::NoChange,
                confirmation_token: None,
                expires_in_seconds: 0,
                source_preview,
                target_existed: write_preview.target_existed,
                added_handlers: 0,
                removed_handlers: 0,
                backup_required: false,
                lossless_edit_prepared: true,
                official_target_resolved: true,
                caller_path_accepted: false,
                config_write_performed: false,
                hook_configuration_changed: false,
                source_task_behavior_changed: false,
            });
        };

        let token = Uuid::new_v4().to_string();
        pending.insert(
            token.clone(),
            PendingOfficialWrite {
                connector_id,
                source_instance,
                implementation: context.implementation,
                root: context.root,
                expected: context.expected,
                action,
                sources: scanned
                    .into_iter()
                    .map(|source| source.fingerprint)
                    .collect(),
                source_preview: source_preview.clone(),
                inner_confirmation_token,
                expires_at: now + CONFIRMATION_LIFETIME,
            },
        );
        Ok(OfficialHookConfigWritePreview {
            action: action.into(),
            status: OfficialHookConfigWriteStatus::ReadyForConfirmation,
            confirmation_token: Some(token),
            expires_in_seconds: CONFIRMATION_LIFETIME.as_secs(),
            source_preview,
            target_existed: write_preview.target_existed,
            added_handlers: write_preview.added_handlers,
            removed_handlers: write_preview.removed_handlers,
            backup_required: write_preview.backup_required,
            lossless_edit_prepared: write_preview.lossless_edit_prepared,
            official_target_resolved: true,
            caller_path_accepted: false,
            config_write_performed: false,
            hook_configuration_changed: false,
            source_task_behavior_changed: false,
        })
    }

    fn take_pending(
        &self,
        confirmation_token: &str,
        now: Instant,
    ) -> Result<PendingOfficialWrite, OfficialHookConfigWriteError> {
        if Uuid::parse_str(confirmation_token).is_err() {
            return Err(OfficialHookConfigWriteError::InvalidConfirmation);
        }
        let pending = self
            .pending
            .lock()
            .remove(confirmation_token)
            .ok_or(OfficialHookConfigWriteError::InvalidConfirmation)?;
        if pending.expires_at <= now {
            self.writer
                .discard_confirmation(&pending.inner_confirmation_token);
            return Err(OfficialHookConfigWriteError::InvalidConfirmation);
        }
        Ok(pending)
    }

    fn apply_pending(
        &self,
        pending: PendingOfficialWrite,
        context: OfficialWriteContext,
    ) -> Result<OfficialHookConfigWriteResult, OfficialHookConfigWriteError> {
        let result = self.apply_pending_inner(&pending, &context);
        if result.is_err() {
            self.writer
                .discard_confirmation(&pending.inner_confirmation_token);
        }
        result
    }

    fn apply_pending_inner(
        &self,
        pending: &PendingOfficialWrite,
        context: &OfficialWriteContext,
    ) -> Result<OfficialHookConfigWriteResult, OfficialHookConfigWriteError> {
        if context.implementation != pending.implementation
            || context.root != pending.root
            || context.expected != pending.expected
        {
            return Err(OfficialHookConfigWriteError::ConfigurationChanged);
        }

        let scanned = scan_official_sources(context)?;
        let fingerprints = scanned
            .iter()
            .map(|source| source.fingerprint.clone())
            .collect::<Vec<_>>();
        if fingerprints != pending.sources {
            return Err(OfficialHookConfigWriteError::ConfigurationChanged);
        }
        let source_preview = preview_scanned_sources(context, &scanned)?;
        if source_preview != pending.source_preview
            || !source_preview.lossless_edit_supported
            || source_preview.proposed_action == HookSetPreviewAction::ManualReview
        {
            return Err(OfficialHookConfigWriteError::ConfigurationChanged);
        }

        let result = self
            .writer
            .apply(&pending.inner_confirmation_token)
            .map_err(map_write_apply_error)?;
        Ok(OfficialHookConfigWriteResult::from_write(
            pending.action,
            result,
        ))
    }

    #[cfg(test)]
    fn apply_with_context(
        &self,
        confirmation_token: &str,
        context: OfficialWriteContext,
    ) -> Result<OfficialHookConfigWriteResult, OfficialHookConfigWriteError> {
        let pending = self.take_pending(confirmation_token, Instant::now())?;
        self.apply_pending(pending, context)
    }
}

impl OfficialHookConfigWriteResult {
    fn from_write(action: HookConfigEditAction, value: HookConfigWriteResult) -> Self {
        Self {
            action: action.into(),
            added_handlers: value.added_handlers,
            removed_handlers: value.removed_handlers,
            backup_created: value.backup_created,
            official_target_revalidated: true,
            all_user_sources_revalidated: true,
            caller_path_accepted: false,
            config_write_performed: value.config_write_performed,
            hook_configuration_changed: value.hook_configuration_changed,
            source_task_behavior_changed: value.source_task_behavior_changed,
        }
    }
}

impl From<HookConfigEditAction> for OfficialHookConfigAction {
    fn from(value: HookConfigEditAction) -> Self {
        match value {
            HookConfigEditAction::Add => Self::Connect,
            HookConfigEditAction::Remove => Self::Disconnect,
        }
    }
}

fn resolve_official_context(
    connector_id: &str,
    source_instance: &str,
) -> Result<OfficialWriteContext, OfficialHookConfigWriteError> {
    let AuthorizedHookContext {
        implementation,
        expected,
    } = resolve_authorized_hook_context(connector_id, source_instance)
        .map_err(|_| OfficialHookConfigWriteError::AuthorizationUnavailable)?;
    let root = official_user_config_root(implementation)
        .map_err(|_| OfficialHookConfigWriteError::UnsafeOfficialTarget)?
        .ok_or(OfficialHookConfigWriteError::UnsafeOfficialTarget)?;
    if !ordinary_directory(&root) {
        return Err(OfficialHookConfigWriteError::UnsafeOfficialTarget);
    }
    Ok(OfficialWriteContext {
        implementation,
        root,
        expected,
    })
}

fn scan_official_sources(
    context: &OfficialWriteContext,
) -> Result<Vec<ScannedSource>, OfficialHookConfigWriteError> {
    if !ordinary_directory(&context.root) {
        return Err(OfficialHookConfigWriteError::UnsafeOfficialTarget);
    }
    official_source_paths(context.implementation, &context.root)
        .into_iter()
        .map(|(source, path)| {
            let snapshot = read_snapshot(&path)
                .map_err(|_| OfficialHookConfigWriteError::UnsafeOfficialTarget)?;
            let fingerprint = SourceFingerprint {
                source,
                path,
                exists: snapshot.exists(),
                digest: snapshot.digest(),
                identity: snapshot.identity(),
            };
            Ok(ScannedSource {
                fingerprint,
                snapshot,
            })
        })
        .collect()
}

fn preview_scanned_sources(
    context: &OfficialWriteContext,
    sources: &[ScannedSource],
) -> Result<HookConfigSourcesPreview, OfficialHookConfigWriteError> {
    let inputs = sources
        .iter()
        .filter(|source| source.snapshot.exists())
        .map(|source| HookConfigSourceInput {
            source: source.fingerprint.source,
            input: source.snapshot.bytes(),
        })
        .collect::<Vec<_>>();
    preview_hook_config_sources(
        connector_tool(context.implementation),
        &inputs,
        &context.expected,
    )
    .map_err(|_| OfficialHookConfigWriteError::ManualReviewRequired)
}

fn preferred_source<'a>(
    context: &OfficialWriteContext,
    sources: &'a [ScannedSource],
) -> Result<&'a ScannedSource, OfficialHookConfigWriteError> {
    let preferred = match context.implementation {
        ConnectorImplementation::Codex => HookConfigSource::CodexUserHooksJson,
        ConnectorImplementation::ClaudeCode => HookConfigSource::ClaudeUserSettingsJson,
    };
    sources
        .iter()
        .find(|source| source.fingerprint.source == preferred)
        .ok_or(OfficialHookConfigWriteError::UnsafeOfficialTarget)
}

fn official_source_paths(
    implementation: ConnectorImplementation,
    root: &Path,
) -> Vec<(HookConfigSource, PathBuf)> {
    match implementation {
        ConnectorImplementation::Codex => vec![
            (
                HookConfigSource::CodexUserHooksJson,
                root.join("hooks.json"),
            ),
            (
                HookConfigSource::CodexUserConfigToml,
                root.join("config.toml"),
            ),
        ],
        ConnectorImplementation::ClaudeCode => vec![(
            HookConfigSource::ClaudeUserSettingsJson,
            root.join("settings.json"),
        )],
    }
}

fn connector_tool(implementation: ConnectorImplementation) -> ConnectorHookTool {
    match implementation {
        ConnectorImplementation::Codex => ConnectorHookTool::Codex,
        ConnectorImplementation::ClaudeCode => ConnectorHookTool::ClaudeCode,
    }
}

fn preferred_format(implementation: ConnectorImplementation) -> HookConfigFormat {
    match implementation {
        ConnectorImplementation::Codex => HookConfigFormat::CodexHooksJson,
        ConnectorImplementation::ClaudeCode => HookConfigFormat::ClaudeSettingsJson,
    }
}

fn manual_review_preview(
    action: HookConfigEditAction,
    source_preview: HookConfigSourcesPreview,
    preferred: &ScannedSource,
) -> OfficialHookConfigWritePreview {
    OfficialHookConfigWritePreview {
        action: action.into(),
        status: OfficialHookConfigWriteStatus::ManualReview,
        confirmation_token: None,
        expires_in_seconds: 0,
        target_existed: preferred.snapshot.exists(),
        added_handlers: 0,
        removed_handlers: 0,
        backup_required: false,
        lossless_edit_prepared: false,
        official_target_resolved: true,
        caller_path_accepted: false,
        config_write_performed: false,
        hook_configuration_changed: false,
        source_task_behavior_changed: false,
        source_preview,
    }
}

fn map_write_preview_error(error: HookConfigWriteError) -> OfficialHookConfigWriteError {
    match error {
        HookConfigWriteError::InvalidTarget | HookConfigWriteError::UnsafePath => {
            OfficialHookConfigWriteError::UnsafeOfficialTarget
        }
        HookConfigWriteError::ManualReviewRequired => {
            OfficialHookConfigWriteError::ManualReviewRequired
        }
        HookConfigWriteError::ConfirmationCapacityReached => {
            OfficialHookConfigWriteError::ConfirmationCapacityReached
        }
        _ => OfficialHookConfigWriteError::WriteFailed,
    }
}

fn map_write_apply_error(error: HookConfigWriteError) -> OfficialHookConfigWriteError {
    match error {
        HookConfigWriteError::InvalidConfirmation => {
            OfficialHookConfigWriteError::InvalidConfirmation
        }
        HookConfigWriteError::ConfigurationChanged => {
            OfficialHookConfigWriteError::ConfigurationChanged
        }
        _ => OfficialHookConfigWriteError::WriteFailed,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn test_root(label: &str) -> PathBuf {
        std::env::temp_dir().join(format!("yuanyuan-official-hook-{label}-{}", Uuid::new_v4()))
    }

    fn identity(implementation: ConnectorImplementation) -> (String, String) {
        let connector_id = match implementation {
            ConnectorImplementation::Codex => "builtin.codex.00000000-0000-4000-8000-000000000010",
            ConnectorImplementation::ClaudeCode => {
                "builtin.claude-code.00000000-0000-4000-8000-000000000010"
            }
        };
        (
            connector_id.to_owned(),
            "00000000-0000-4000-8000-000000000001".to_owned(),
        )
    }

    fn context(
        implementation: ConnectorImplementation,
        root: PathBuf,
        key_id: &str,
    ) -> OfficialWriteContext {
        let (connector_id, source_instance) = identity(implementation);
        OfficialWriteContext {
            implementation,
            root,
            expected: crate::connector_config_preview::expected_specs(
                implementation,
                r"C:\Program Files\Yuanyuan\yuanyuan-bridge.exe",
                &connector_id,
                &source_instance,
                key_id,
            ),
        }
    }

    fn preview_fixture(
        coordinator: &OfficialHookConfigWriteCoordinator,
        context: OfficialWriteContext,
    ) -> OfficialHookConfigWritePreview {
        let (connector_id, source_instance) = identity(context.implementation);
        coordinator
            .preview_with_context(
                HookConfigEditAction::Add,
                connector_id,
                source_instance,
                context,
                Instant::now(),
            )
            .unwrap()
    }

    fn preview_disconnect_fixture(
        coordinator: &OfficialHookConfigWriteCoordinator,
        context: OfficialWriteContext,
    ) -> Result<OfficialHookConfigWritePreview, OfficialHookConfigWriteError> {
        let (connector_id, source_instance) = identity(context.implementation);
        coordinator.preview_with_context(
            HookConfigEditAction::Remove,
            connector_id,
            source_instance,
            context,
            Instant::now(),
        )
    }

    #[test]
    fn official_codex_flow_binds_all_sources_and_writes_only_the_preferred_target() {
        let root = test_root("codex-success");
        std::fs::create_dir_all(&root).unwrap();
        std::fs::write(root.join("hooks.json"), b"{/*keep*/\"hooks\":{}}\n").unwrap();
        let coordinator = OfficialHookConfigWriteCoordinator::default();
        let preview = preview_fixture(
            &coordinator,
            context(ConnectorImplementation::Codex, root.clone(), "key-a"),
        );
        assert_eq!(
            preview.status,
            OfficialHookConfigWriteStatus::ReadyForConfirmation
        );
        assert!(!preview.caller_path_accepted);
        let serialized = serde_json::to_string(&preview).unwrap();
        assert!(!serialized.contains(&root.to_string_lossy().to_string()));
        assert!(!serialized.contains("key-a"));

        let result = coordinator
            .apply_with_context(
                preview.confirmation_token.as_deref().unwrap(),
                context(ConnectorImplementation::Codex, root.clone(), "key-a"),
            )
            .unwrap();
        assert!(result.config_write_performed);
        assert!(result.all_user_sources_revalidated);
        assert!(!result.caller_path_accepted);
        let written = std::fs::read_to_string(root.join("hooks.json")).unwrap();
        assert!(written.starts_with("{/*keep*/\"hooks\":"));
        assert!(!root.join("config.toml").exists());
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn a_nonpreferred_codex_source_appearing_after_preview_invalidates_the_token() {
        let root = test_root("codex-secondary-change");
        std::fs::create_dir_all(&root).unwrap();
        let coordinator = OfficialHookConfigWriteCoordinator::default();
        let preview = preview_fixture(
            &coordinator,
            context(ConnectorImplementation::Codex, root.clone(), "key-a"),
        );
        std::fs::write(
            root.join("config.toml"),
            b"[[hooks.SessionStart]]\nmatcher = \"\"\n",
        )
        .unwrap();
        let token = preview.confirmation_token.unwrap();
        assert_eq!(
            coordinator.apply_with_context(
                &token,
                context(ConnectorImplementation::Codex, root.clone(), "key-a")
            ),
            Err(OfficialHookConfigWriteError::ConfigurationChanged)
        );
        assert_eq!(
            coordinator.apply_with_context(
                &token,
                context(ConnectorImplementation::Codex, root.clone(), "key-a")
            ),
            Err(OfficialHookConfigWriteError::InvalidConfirmation)
        );
        assert!(!root.join("hooks.json").exists());
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn a_same_content_nonpreferred_file_replacement_is_detected_by_identity() {
        let root = test_root("secondary-identity-change");
        std::fs::create_dir_all(&root).unwrap();
        let secondary = root.join("config.toml");
        let bytes = b"# user configuration\n";
        std::fs::write(&secondary, bytes).unwrap();
        let coordinator = OfficialHookConfigWriteCoordinator::default();
        let preview = preview_fixture(
            &coordinator,
            context(ConnectorImplementation::Codex, root.clone(), "key-a"),
        );
        let held_old_file = std::fs::File::open(&secondary).unwrap();
        std::fs::remove_file(&secondary).unwrap();
        std::fs::write(&secondary, bytes).unwrap();
        assert_eq!(
            coordinator.apply_with_context(
                preview.confirmation_token.as_deref().unwrap(),
                context(ConnectorImplementation::Codex, root.clone(), "key-a")
            ),
            Err(OfficialHookConfigWriteError::ConfigurationChanged)
        );
        drop(held_old_file);
        assert!(!root.join("hooks.json").exists());
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn authorization_material_or_official_root_change_invalidates_confirmation() {
        let root = test_root("context-change");
        let other = test_root("other-root");
        std::fs::create_dir_all(&root).unwrap();
        std::fs::create_dir_all(&other).unwrap();
        let coordinator = OfficialHookConfigWriteCoordinator::default();
        let preview = preview_fixture(
            &coordinator,
            context(ConnectorImplementation::ClaudeCode, root.clone(), "key-a"),
        );
        assert_eq!(
            coordinator.apply_with_context(
                preview.confirmation_token.as_deref().unwrap(),
                context(ConnectorImplementation::ClaudeCode, root.clone(), "key-b")
            ),
            Err(OfficialHookConfigWriteError::ConfigurationChanged)
        );

        let preview = preview_fixture(
            &coordinator,
            context(ConnectorImplementation::ClaudeCode, root.clone(), "key-a"),
        );
        assert_eq!(
            coordinator.apply_with_context(
                preview.confirmation_token.as_deref().unwrap(),
                context(ConnectorImplementation::ClaudeCode, other.clone(), "key-a")
            ),
            Err(OfficialHookConfigWriteError::ConfigurationChanged)
        );
        assert!(!root.join("settings.json").exists());
        assert!(!other.join("settings.json").exists());
        std::fs::remove_dir_all(root).unwrap();
        std::fs::remove_dir_all(other).unwrap();
    }

    #[test]
    fn codex_inline_hooks_require_manual_review_without_issuing_a_token() {
        let root = test_root("inline-conflict");
        std::fs::create_dir_all(&root).unwrap();
        std::fs::write(
            root.join("config.toml"),
            b"[[hooks.SessionStart]]\nmatcher = \"\"\n",
        )
        .unwrap();
        let coordinator = OfficialHookConfigWriteCoordinator::default();
        let preview = preview_fixture(
            &coordinator,
            context(ConnectorImplementation::Codex, root.clone(), "key-a"),
        );
        assert_eq!(preview.status, OfficialHookConfigWriteStatus::ManualReview);
        assert!(preview.confirmation_token.is_none());
        assert!(!preview.config_write_performed);
        assert!(!root.join("hooks.json").exists());
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn already_complete_official_config_is_idempotent_and_has_no_confirmation() {
        let root = test_root("no-change");
        std::fs::create_dir_all(&root).unwrap();
        let coordinator = OfficialHookConfigWriteCoordinator::default();
        let first = preview_fixture(
            &coordinator,
            context(ConnectorImplementation::ClaudeCode, root.clone(), "key-a"),
        );
        coordinator
            .apply_with_context(
                first.confirmation_token.as_deref().unwrap(),
                context(ConnectorImplementation::ClaudeCode, root.clone(), "key-a"),
            )
            .unwrap();
        let before = std::fs::read(root.join("settings.json")).unwrap();
        let second = preview_fixture(
            &coordinator,
            context(ConnectorImplementation::ClaudeCode, root.clone(), "key-a"),
        );
        assert_eq!(second.status, OfficialHookConfigWriteStatus::NoChange);
        assert!(second.confirmation_token.is_none());
        assert_eq!(std::fs::read(root.join("settings.json")).unwrap(), before);
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn unsafe_roots_and_errors_never_echo_path_or_identity_material() {
        let missing = test_root("missing-root");
        let context = context(
            ConnectorImplementation::Codex,
            missing.clone(),
            "secret-reference",
        );
        assert!(matches!(
            scan_official_sources(&context),
            Err(OfficialHookConfigWriteError::UnsafeOfficialTarget)
        ));
        let debug = format!("{:?}", OfficialHookConfigWriteError::UnsafeOfficialTarget);
        assert!(!debug.contains(&missing.to_string_lossy().to_string()));
        assert!(!debug.contains("secret-reference"));
    }

    #[test]
    fn official_disconnect_removes_only_owned_handlers_and_is_idempotent() {
        let root = test_root("disconnect-success");
        std::fs::create_dir_all(&root).unwrap();
        std::fs::write(root.join("settings.json"), b"{\"userSetting\":true}").unwrap();
        let coordinator = OfficialHookConfigWriteCoordinator::default();
        let connected = preview_fixture(
            &coordinator,
            context(ConnectorImplementation::ClaudeCode, root.clone(), "key-a"),
        );
        coordinator
            .apply_with_context(
                connected.confirmation_token.as_deref().unwrap(),
                context(ConnectorImplementation::ClaudeCode, root.clone(), "key-a"),
            )
            .unwrap();

        let disconnect = preview_disconnect_fixture(
            &coordinator,
            context(ConnectorImplementation::ClaudeCode, root.clone(), "key-a"),
        )
        .unwrap();
        assert_eq!(disconnect.action, OfficialHookConfigAction::Disconnect);
        assert_eq!(disconnect.added_handlers, 0);
        assert_eq!(disconnect.removed_handlers, 11);
        assert!(disconnect.confirmation_token.is_some());
        let result = coordinator
            .apply_with_context(
                disconnect.confirmation_token.as_deref().unwrap(),
                context(ConnectorImplementation::ClaudeCode, root.clone(), "key-a"),
            )
            .unwrap();
        assert_eq!(result.action, OfficialHookConfigAction::Disconnect);
        assert_eq!(result.removed_handlers, 11);
        let output = std::fs::read_to_string(root.join("settings.json")).unwrap();
        assert!(output.contains("\"userSetting\":true"));
        assert!(!output.contains("yuanyuan-bridge"));

        let again = preview_disconnect_fixture(
            &coordinator,
            context(ConnectorImplementation::ClaudeCode, root.clone(), "key-a"),
        )
        .unwrap();
        assert_eq!(again.status, OfficialHookConfigWriteStatus::NoChange);
        assert_eq!(again.removed_handlers, 0);
        assert!(again.confirmation_token.is_none());
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn disconnect_confirmation_binds_nonpreferred_sources_and_refuses_touched_owned_bytes() {
        let root = test_root("disconnect-guards");
        std::fs::create_dir_all(&root).unwrap();
        let coordinator = OfficialHookConfigWriteCoordinator::default();
        let connected = preview_fixture(
            &coordinator,
            context(ConnectorImplementation::Codex, root.clone(), "key-a"),
        );
        coordinator
            .apply_with_context(
                connected.confirmation_token.as_deref().unwrap(),
                context(ConnectorImplementation::Codex, root.clone(), "key-a"),
            )
            .unwrap();
        let installed = std::fs::read(root.join("hooks.json")).unwrap();

        let disconnect = preview_disconnect_fixture(
            &coordinator,
            context(ConnectorImplementation::Codex, root.clone(), "key-a"),
        )
        .unwrap();
        std::fs::write(root.join("config.toml"), b"# appeared after preview\n").unwrap();
        assert_eq!(
            coordinator.apply_with_context(
                disconnect.confirmation_token.as_deref().unwrap(),
                context(ConnectorImplementation::Codex, root.clone(), "key-a")
            ),
            Err(OfficialHookConfigWriteError::ConfigurationChanged)
        );
        assert_eq!(std::fs::read(root.join("hooks.json")).unwrap(), installed);

        std::fs::remove_file(root.join("config.toml")).unwrap();
        let touched =
            String::from_utf8(installed)
                .unwrap()
                .replacen("\"timeout\":1", "\"timeout\": 1", 1);
        std::fs::write(root.join("hooks.json"), touched).unwrap();
        assert_eq!(
            preview_disconnect_fixture(
                &coordinator,
                context(ConnectorImplementation::Codex, root.clone(), "key-a")
            ),
            Err(OfficialHookConfigWriteError::ManualReviewRequired)
        );
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn production_entries_accept_only_identity_or_token_never_a_path() {
        let _preview: fn(
            &OfficialHookConfigWriteCoordinator,
            String,
            String,
        )
            -> Result<OfficialHookConfigWritePreview, OfficialHookConfigWriteError> =
            OfficialHookConfigWriteCoordinator::preview;
        let _apply: fn(
            &OfficialHookConfigWriteCoordinator,
            &str,
        )
            -> Result<OfficialHookConfigWriteResult, OfficialHookConfigWriteError> =
            OfficialHookConfigWriteCoordinator::apply;
        let _disconnect: fn(
            &OfficialHookConfigWriteCoordinator,
            String,
            String,
        ) -> Result<
            OfficialHookConfigWritePreview,
            OfficialHookConfigWriteError,
        > = OfficialHookConfigWriteCoordinator::preview_disconnect;
    }

    #[test]
    fn pending_official_confirmations_are_bounded_without_creating_files() {
        let root = test_root("capacity");
        std::fs::create_dir_all(&root).unwrap();
        let coordinator = OfficialHookConfigWriteCoordinator::default();
        for _ in 0..MAX_PENDING_OFFICIAL_WRITES {
            let preview = preview_fixture(
                &coordinator,
                context(ConnectorImplementation::Codex, root.clone(), "key-a"),
            );
            assert!(preview.confirmation_token.is_some());
        }
        let (connector_id, source_instance) = identity(ConnectorImplementation::Codex);
        assert_eq!(
            coordinator.preview_with_context(
                HookConfigEditAction::Add,
                connector_id,
                source_instance,
                context(ConnectorImplementation::Codex, root.clone(), "key-a"),
                Instant::now()
            ),
            Err(OfficialHookConfigWriteError::ConfirmationCapacityReached)
        );
        assert!(!root.join("hooks.json").exists());
        assert!(!root.join("config.toml").exists());
        std::fs::remove_dir_all(root).unwrap();
    }
}
