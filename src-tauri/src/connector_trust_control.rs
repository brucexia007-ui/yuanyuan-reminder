#![cfg(windows)]

use std::{collections::HashMap, path::PathBuf, time::Duration};

use parking_lot::Mutex;
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager};
use uuid::Uuid;
use yuanyuan_bridge::{
    apply_current_user_only_dacl, ConnectorTrustStore, CredentialTrustError,
    CredentialTrustManager, WindowsCredentialSecretStore,
};

use crate::error::{AppError, AppResult};

const CONFIRMATION_LIFETIME: Duration = Duration::from_secs(2 * 60);
const MAX_PENDING_CONFIRMATIONS: usize = 16;
pub(crate) const BUILTIN_CODEX_CONNECTOR: &str = "builtin.codex";
pub(crate) const BUILTIN_CLAUDE_CODE_CONNECTOR: &str = "builtin.claude-code";

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum ConnectorImplementation {
    Codex,
    ClaudeCode,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum ConnectorTrustAuthorityState {
    Active,
    Revoked,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum ConnectorTrustResetOutcome {
    Revoked,
    RevokedCredentialCleanupPending,
    RevokedLocalMaintenancePending,
    RevokedCredentialCleanupAndLocalMaintenancePending,
    StillActive,
    Unavailable,
}

impl ConnectorImplementation {
    fn selector(self) -> &'static str {
        match self {
            Self::Codex => BUILTIN_CODEX_CONNECTOR,
            Self::ClaudeCode => BUILTIN_CLAUDE_CODE_CONNECTOR,
        }
    }

    pub(crate) fn from_selector(value: &str) -> Option<Self> {
        match value {
            BUILTIN_CODEX_CONNECTOR => Some(Self::Codex),
            BUILTIN_CLAUDE_CODE_CONNECTOR => Some(Self::ClaudeCode),
            _ => None,
        }
    }
}

/// Distinguishes a fixed implementation selector from the random, stable ID
/// of one registered connector instance. Exact selectors are legacy identities
/// when they are found in persisted trust state; they are never issued anew.
pub(crate) fn connector_implementation(
    connector_id: &str,
) -> Option<(ConnectorImplementation, bool)> {
    for implementation in [
        ConnectorImplementation::Codex,
        ConnectorImplementation::ClaudeCode,
    ] {
        let selector = implementation.selector();
        if connector_id == selector {
            return Some((implementation, true));
        }
        if let Some(suffix) = connector_id
            .strip_prefix(selector)
            .and_then(|value| value.strip_prefix('.'))
        {
            if Uuid::parse_str(suffix).is_ok() {
                return Some((implementation, false));
            }
        }
    }
    None
}

fn new_connector_id(implementation: ConnectorImplementation) -> String {
    format!("{}.{}", implementation.selector(), Uuid::new_v4())
}

#[derive(Debug, Clone, Copy, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum ConnectorTrustAction {
    Register,
    Rotate,
    Reset,
    Reconnect,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ConnectorTrustStatusView {
    connector_id: String,
    configured: bool,
    active: bool,
    needs_reconnect: bool,
    rotation_grace_active: bool,
    generation: Option<u64>,
    source_instance: Option<String>,
    legacy_identity: bool,
    hook_configuration_changed: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ConnectorTrustPreview {
    confirmation_token: String,
    expires_in_seconds: u64,
    action: ConnectorTrustActionView,
    immediate_revocation: bool,
    creates_new_credential: bool,
    old_event_grace_seconds: u64,
    revokes_all_live_keys: bool,
    deletes_obsolete_credentials: bool,
    source_task_behavior_changed: bool,
    key_material_exposed: bool,
    hook_configuration_changed: bool,
    source_instance_assigned_after_confirmation: bool,
    connector_id_assigned_after_confirmation: bool,
}

#[derive(Debug, Clone, Copy, Serialize)]
#[serde(rename_all = "snake_case")]
enum ConnectorTrustActionView {
    Register,
    Rotate,
    Reset,
    Reconnect,
}

impl From<ConnectorTrustAction> for ConnectorTrustActionView {
    fn from(value: ConnectorTrustAction) -> Self {
        match value {
            ConnectorTrustAction::Register => Self::Register,
            ConnectorTrustAction::Rotate => Self::Rotate,
            ConnectorTrustAction::Reset => Self::Reset,
            ConnectorTrustAction::Reconnect => Self::Reconnect,
        }
    }
}

struct PendingConfirmation {
    action: ConnectorTrustAction,
    connector_id: String,
    source_instance: String,
    expires_at: std::time::Instant,
}

#[derive(Default)]
pub struct ConnectorTrustConfirmationState {
    pending: Mutex<HashMap<String, PendingConfirmation>>,
}

impl ConnectorTrustConfirmationState {
    fn issue(
        &self,
        action: ConnectorTrustAction,
        connector_id: String,
        source_instance: String,
    ) -> Option<String> {
        let mut pending = self.pending.lock();
        let now = std::time::Instant::now();
        pending.retain(|_, item| item.expires_at > now);
        if pending.len() >= MAX_PENDING_CONFIRMATIONS {
            return None;
        }
        let token = Uuid::new_v4().to_string();
        pending.insert(
            token.clone(),
            PendingConfirmation {
                action,
                connector_id,
                source_instance,
                expires_at: now + CONFIRMATION_LIFETIME,
            },
        );
        Some(token)
    }

    fn consume(&self, token: &str) -> Option<PendingConfirmation> {
        if Uuid::parse_str(token).is_err() {
            return None;
        }
        let pending = self.pending.lock().remove(token)?;
        (pending.expires_at > std::time::Instant::now()).then_some(pending)
    }
}

pub fn get_connector_trust_status(
    connector_id: String,
    source_instance: String,
) -> AppResult<ConnectorTrustStatusView> {
    validate_supported_identity(&connector_id, &source_instance)?;
    let path = trust_database_path()?;
    if !path.is_file() {
        return Ok(unconfigured_status(connector_id, Some(source_instance)));
    }
    let store = ConnectorTrustStore::open_existing_read_only(path).map_err(generic_error)?;
    let status = store
        .status(&connector_id, &source_instance)
        .map_err(generic_error)?;
    Ok(status_view(
        status,
        unix_time_ms()?,
        connector_id,
        source_instance,
    ))
}

pub fn preview_connector_trust_change(
    app: AppHandle,
    action: ConnectorTrustAction,
    connector_id: String,
    source_instance: Option<String>,
) -> AppResult<ConnectorTrustPreview> {
    let (connector_id, source_instance) =
        resolve_connector_identity(action, connector_id, source_instance)?;
    validate_transition(&connector_id, &source_instance, action)?;
    let token = app
        .state::<ConnectorTrustConfirmationState>()
        .issue(action, connector_id, source_instance)
        .ok_or_else(generic_confirmation_capacity_error)?;
    Ok(ConnectorTrustPreview {
        confirmation_token: token,
        expires_in_seconds: CONFIRMATION_LIFETIME.as_secs(),
        action: action.into(),
        immediate_revocation: action == ConnectorTrustAction::Reset,
        creates_new_credential: matches!(
            action,
            ConnectorTrustAction::Register
                | ConnectorTrustAction::Rotate
                | ConnectorTrustAction::Reconnect
        ),
        old_event_grace_seconds: if action == ConnectorTrustAction::Rotate {
            yuanyuan_bridge::KEY_ROTATION_GRACE.as_secs()
        } else {
            0
        },
        revokes_all_live_keys: action == ConnectorTrustAction::Reset,
        deletes_obsolete_credentials: matches!(
            action,
            ConnectorTrustAction::Reset | ConnectorTrustAction::Rotate
        ),
        source_task_behavior_changed: false,
        key_material_exposed: false,
        hook_configuration_changed: false,
        source_instance_assigned_after_confirmation: action == ConnectorTrustAction::Register,
        connector_id_assigned_after_confirmation: action == ConnectorTrustAction::Register,
    })
}

fn resolve_connector_identity(
    action: ConnectorTrustAction,
    connector_id: String,
    source_instance: Option<String>,
) -> AppResult<(String, String)> {
    match (action, source_instance) {
        (ConnectorTrustAction::Register, None) => {
            let implementation = ConnectorImplementation::from_selector(&connector_id)
                .ok_or_else(generic_transition_error)?;
            Ok((new_connector_id(implementation), Uuid::new_v4().to_string()))
        }
        (ConnectorTrustAction::Register, Some(_)) => Err(generic_transition_error()),
        (_, Some(source_instance))
            if connector_implementation(&connector_id).is_some()
                && Uuid::parse_str(&source_instance).is_ok() =>
        {
            Ok((connector_id, source_instance))
        }
        _ => Err(generic_transition_error()),
    }
}

pub fn apply_connector_trust_change(
    app: AppHandle,
    confirmation_token: String,
) -> AppResult<ConnectorTrustStatusView> {
    let pending = app
        .state::<ConnectorTrustConfirmationState>()
        .consume(&confirmation_token)
        .ok_or_else(generic_confirmation_error)?;
    let now = unix_time_ms()?;
    let path = prepare_trust_database_path()?;
    let trust = ConnectorTrustStore::open(&path).map_err(generic_error)?;
    let mut manager = CredentialTrustManager::new(trust, WindowsCredentialSecretStore::default());

    // This maintenance is safe to run before a new mutation: authorization for
    // expired previous keys is already denied by time, and metadata is removed
    // before exact credential deletion.
    manager
        .finalize_expired_rotations(now, 256)
        .map_err(generic_error)?;
    match pending.action {
        ConnectorTrustAction::Register => {
            manager
                .register(&pending.connector_id, &pending.source_instance, now)
                .map_err(generic_error)?;
        }
        ConnectorTrustAction::Rotate => {
            manager
                .begin_rotation(&pending.connector_id, &pending.source_instance, now)
                .map_err(generic_error)?;
        }
        ConnectorTrustAction::Reset => {
            manager
                .reset_trust(&pending.connector_id, &pending.source_instance, now)
                .map_err(generic_error)?;
        }
        ConnectorTrustAction::Reconnect => {
            manager
                .reconnect(&pending.connector_id, &pending.source_instance, now)
                .map_err(generic_error)?;
        }
    }
    clear_authentication_pause_best_effort(&pending.connector_id, &pending.source_instance);
    apply_current_user_only_dacl(&path).map_err(generic_error)?;
    let status = manager
        .status(&pending.connector_id, &pending.source_instance)
        .map_err(generic_error)?;
    Ok(status_view(
        status,
        now,
        pending.connector_id,
        pending.source_instance,
    ))
}

pub(crate) fn connector_trust_authority_state(
    connector_id: &str,
    source_instance: &str,
) -> Result<ConnectorTrustAuthorityState, ()> {
    validate_supported_identity(connector_id, source_instance).map_err(|_| ())?;
    let path = trust_database_path().map_err(|_| ())?;
    if !path.is_file() {
        return Ok(ConnectorTrustAuthorityState::Revoked);
    }
    let status = ConnectorTrustStore::open_existing_read_only(path)
        .map_err(|_| ())?
        .status(connector_id, source_instance)
        .map_err(|_| ())?;
    Ok(if status.is_some_and(|status| status.active) {
        ConnectorTrustAuthorityState::Active
    } else {
        ConnectorTrustAuthorityState::Revoked
    })
}

/// Idempotently removes authentication authority for the exact connector
/// identity. Credential deletion is deliberately classified separately:
/// `reset_trust` revokes SQLite authority before attempting cleanup, so a
/// cleanup error must never be reported as live authority.
pub(crate) fn reset_connector_trust_internal(
    connector_id: &str,
    source_instance: &str,
) -> ConnectorTrustResetOutcome {
    match connector_trust_authority_state(connector_id, source_instance) {
        Ok(ConnectorTrustAuthorityState::Revoked) => return ConnectorTrustResetOutcome::Revoked,
        Ok(ConnectorTrustAuthorityState::Active) => {}
        Err(()) => return ConnectorTrustResetOutcome::Unavailable,
    }
    let Ok(now) = unix_time_ms() else {
        return ConnectorTrustResetOutcome::Unavailable;
    };
    let Ok(path) = prepare_trust_database_path() else {
        return ConnectorTrustResetOutcome::Unavailable;
    };
    let Ok(trust) = ConnectorTrustStore::open(&path) else {
        return ConnectorTrustResetOutcome::Unavailable;
    };
    let mut manager = CredentialTrustManager::new(trust, WindowsCredentialSecretStore::default());
    let reset = manager.reset_trust(connector_id, source_instance, now);
    let status = manager.status(connector_id, source_instance);
    let authority_revoked =
        matches!(status, Ok(None)) || matches!(status, Ok(Some(ref status)) if !status.active);
    if authority_revoked {
        clear_authentication_pause_best_effort(connector_id, source_instance);
        let dacl_applied = apply_current_user_only_dacl(&path).is_ok();
        return match (reset, dacl_applied) {
            (Ok(()), true) => ConnectorTrustResetOutcome::Revoked,
            (Err(CredentialTrustError::ObsoleteCredentialCleanupIncomplete { .. }), true) => {
                ConnectorTrustResetOutcome::RevokedCredentialCleanupPending
            }
            (Ok(()), false) => ConnectorTrustResetOutcome::RevokedLocalMaintenancePending,
            (Err(CredentialTrustError::ObsoleteCredentialCleanupIncomplete { .. }), false) => {
                ConnectorTrustResetOutcome::RevokedCredentialCleanupAndLocalMaintenancePending
            }
            _ => ConnectorTrustResetOutcome::RevokedLocalMaintenancePending,
        };
    }
    match reset {
        Err(CredentialTrustError::ObsoleteCredentialCleanupIncomplete { .. }) => {
            // Defensive: the manager contract says this error follows
            // revocation. If status contradicts that contract, fail closed.
            ConnectorTrustResetOutcome::Unavailable
        }
        _ if matches!(status, Ok(Some(ref status)) if status.active) => {
            ConnectorTrustResetOutcome::StillActive
        }
        _ => ConnectorTrustResetOutcome::Unavailable,
    }
}

/// Retries post-revocation cleanup without recreating authority or scanning
/// Credential Manager. Only exact key ids already marked revoked for this
/// identity are eligible, and each call is bounded.
pub(crate) fn retry_connector_trust_cleanup_internal(
    connector_id: &str,
    source_instance: &str,
) -> ConnectorTrustResetOutcome {
    match connector_trust_authority_state(connector_id, source_instance) {
        Ok(ConnectorTrustAuthorityState::Active) => return ConnectorTrustResetOutcome::StillActive,
        Ok(ConnectorTrustAuthorityState::Revoked) => {}
        Err(()) => return ConnectorTrustResetOutcome::Unavailable,
    }
    let Ok(path) = trust_database_path() else {
        return ConnectorTrustResetOutcome::Unavailable;
    };
    if !path.is_file() {
        return ConnectorTrustResetOutcome::Revoked;
    }
    let Ok(now) = unix_time_ms() else {
        return ConnectorTrustResetOutcome::Unavailable;
    };
    let Ok(trust) = ConnectorTrustStore::open(&path) else {
        return ConnectorTrustResetOutcome::Unavailable;
    };
    let mut manager = CredentialTrustManager::new(trust, WindowsCredentialSecretStore::default());
    let cleanup = manager.retry_revoked_credential_cleanup(connector_id, source_instance, now, 256);
    let status = manager.status(connector_id, source_instance);
    let authority_revoked =
        matches!(status, Ok(None)) || matches!(status, Ok(Some(ref status)) if !status.active);
    if !authority_revoked {
        return if matches!(status, Ok(Some(ref status)) if status.active) {
            ConnectorTrustResetOutcome::StillActive
        } else {
            ConnectorTrustResetOutcome::Unavailable
        };
    }
    clear_authentication_pause_best_effort(connector_id, source_instance);
    let dacl_applied = apply_current_user_only_dacl(&path).is_ok();
    match (cleanup, dacl_applied) {
        (Ok(_), true) => ConnectorTrustResetOutcome::Revoked,
        (Err(CredentialTrustError::ObsoleteCredentialCleanupIncomplete { .. }), true) => {
            ConnectorTrustResetOutcome::RevokedCredentialCleanupPending
        }
        (Ok(_), false) => ConnectorTrustResetOutcome::RevokedLocalMaintenancePending,
        (Err(CredentialTrustError::ObsoleteCredentialCleanupIncomplete { .. }), false) => {
            ConnectorTrustResetOutcome::RevokedCredentialCleanupAndLocalMaintenancePending
        }
        _ => ConnectorTrustResetOutcome::RevokedLocalMaintenancePending,
    }
}

fn validate_transition(
    connector_id: &str,
    source_instance: &str,
    action: ConnectorTrustAction,
) -> AppResult<()> {
    validate_supported_identity(connector_id, source_instance)?;
    let path = trust_database_path()?;
    let status = if path.is_file() {
        ConnectorTrustStore::open_existing_read_only(path)
            .map_err(generic_error)?
            .status(connector_id, source_instance)
            .map_err(generic_error)?
    } else {
        None
    };
    let legacy_identity = connector_implementation(connector_id).is_some_and(|(_, legacy)| legacy);
    let allowed = match (action, status.as_ref()) {
        (ConnectorTrustAction::Register, None) => true,
        (ConnectorTrustAction::Rotate, Some(status)) if !legacy_identity => {
            status.active && status.previous_key_id.is_none()
        }
        (ConnectorTrustAction::Reset, Some(status)) => status.active,
        (ConnectorTrustAction::Reconnect, Some(status)) if !legacy_identity => !status.active,
        _ => false,
    };
    allowed.then_some(()).ok_or_else(generic_transition_error)
}

fn validate_supported_identity(connector_id: &str, source_instance: &str) -> AppResult<()> {
    if connector_implementation(connector_id).is_some() && Uuid::parse_str(source_instance).is_ok()
    {
        Ok(())
    } else {
        Err(generic_transition_error())
    }
}

fn status_view(
    status: Option<yuanyuan_bridge::TrustStatus>,
    now_unix_ms: i64,
    connector_id: String,
    source_instance: String,
) -> ConnectorTrustStatusView {
    let legacy_identity = connector_implementation(&connector_id).is_some_and(|(_, legacy)| legacy);
    let Some(status) = status else {
        return unconfigured_status(connector_id, Some(source_instance));
    };
    ConnectorTrustStatusView {
        connector_id,
        configured: true,
        active: status.active,
        needs_reconnect: !status.active || legacy_identity,
        rotation_grace_active: status
            .grace_expires_at_unix_ms
            .is_some_and(|expires| expires >= now_unix_ms),
        generation: Some(status.generation),
        source_instance: Some(source_instance),
        legacy_identity,
        hook_configuration_changed: false,
    }
}

fn unconfigured_status(
    connector_id: String,
    source_instance: Option<String>,
) -> ConnectorTrustStatusView {
    ConnectorTrustStatusView {
        connector_id,
        configured: false,
        active: false,
        needs_reconnect: false,
        rotation_grace_active: false,
        generation: None,
        source_instance,
        legacy_identity: false,
        hook_configuration_changed: false,
    }
}

pub(crate) fn trust_database_path() -> AppResult<PathBuf> {
    let local_app_data = std::env::var_os("LOCALAPPDATA").ok_or_else(generic_error_value)?;
    Ok(PathBuf::from(local_app_data)
        .join("Yuanyuan")
        .join("connector-trust.sqlite3"))
}

pub(crate) fn authentication_health_database_path() -> AppResult<PathBuf> {
    let local_app_data = std::env::var_os("LOCALAPPDATA").ok_or_else(generic_error_value)?;
    Ok(PathBuf::from(local_app_data)
        .join("Yuanyuan")
        .join("connector-authentication-health.sqlite3"))
}

fn clear_authentication_pause_best_effort(connector_id: &str, source_instance: &str) {
    let Ok(path) = authentication_health_database_path() else {
        return;
    };
    if !path.is_file() {
        return;
    }
    if let Ok(mut health) = yuanyuan_bridge::ConnectorAuthenticationHealthStore::open(path) {
        let _ = health.clear_after_reauthorization(connector_id, source_instance);
    }
}

fn prepare_trust_database_path() -> AppResult<PathBuf> {
    let path = trust_database_path()?;
    let root = path.parent().ok_or_else(generic_error_value)?;
    std::fs::create_dir_all(root).map_err(generic_error)?;
    apply_current_user_only_dacl(root).map_err(generic_error)?;
    Ok(path)
}

fn unix_time_ms() -> AppResult<i64> {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .ok()
        .and_then(|duration| i64::try_from(duration.as_millis()).ok())
        .ok_or_else(generic_error_value)
}

fn generic_error<T>(_error: T) -> AppError {
    generic_error_value()
}

fn generic_error_value() -> AppError {
    AppError::Validation("连接器信任操作失败，请稍后重试。".to_owned())
}

fn generic_confirmation_error() -> AppError {
    AppError::Validation("确认已失效，请重新查看变更说明。".to_owned())
}

fn generic_transition_error() -> AppError {
    AppError::Validation("连接器当前状态不允许此操作，请刷新后重试。".to_owned())
}

fn generic_confirmation_capacity_error() -> AppError {
    AppError::Validation("待确认的连接器操作过多，请稍后重试。".to_owned())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn confirmation_tokens_are_single_use_and_bound_to_the_requested_identity() {
        let state = ConnectorTrustConfirmationState::default();
        let token = state
            .issue(
                ConnectorTrustAction::Reset,
                "connector.codex".to_owned(),
                "instance-1".to_owned(),
            )
            .unwrap();
        let pending = state.consume(&token).unwrap();
        assert_eq!(pending.action, ConnectorTrustAction::Reset);
        assert_eq!(pending.connector_id, "connector.codex");
        assert_eq!(pending.source_instance, "instance-1");
        assert!(state.consume(&token).is_none());
        assert!(state.consume("not-a-token").is_none());
    }

    #[test]
    fn status_view_never_exposes_key_ids() {
        let status = status_view(
            Some(yuanyuan_bridge::TrustStatus {
                generation: 2,
                active: true,
                active_key_id: Some("secret-adjacent-key-id".to_owned()),
                previous_key_id: Some("old-key-id".to_owned()),
                grace_expires_at_unix_ms: Some(2_000),
            }),
            1_000,
            format!("builtin.codex.{}", Uuid::new_v4()),
            "00000000-0000-4000-8000-000000000001".to_owned(),
        );
        let encoded = serde_json::to_string(&status).unwrap();
        assert!(!encoded.contains("key"));
        assert!(!encoded.contains("secret-adjacent"));
        assert!(encoded.contains("rotationGraceActive"));
    }

    #[test]
    fn pending_confirmation_capacity_is_bounded() {
        let state = ConnectorTrustConfirmationState::default();
        for index in 0..MAX_PENDING_CONFIRMATIONS {
            assert!(state
                .issue(
                    ConnectorTrustAction::Register,
                    "builtin.codex".to_owned(),
                    format!("instance-{index}"),
                )
                .is_some());
        }
        assert!(state
            .issue(
                ConnectorTrustAction::Register,
                "builtin.codex".to_owned(),
                "instance-overflow".to_owned(),
            )
            .is_none());
    }

    #[test]
    fn registration_assigns_an_opaque_uuid_only_when_explicitly_previewed() {
        let (connector_id, source_instance) = resolve_connector_identity(
            ConnectorTrustAction::Register,
            BUILTIN_CODEX_CONNECTOR.to_owned(),
            None,
        )
        .unwrap();
        let suffix = connector_id.strip_prefix("builtin.codex.").unwrap();
        assert!(Uuid::parse_str(suffix).is_ok());
        assert!(Uuid::parse_str(&source_instance).is_ok());
        assert!(resolve_connector_identity(
            ConnectorTrustAction::Register,
            BUILTIN_CODEX_CONNECTOR.to_owned(),
            Some(Uuid::new_v4().to_string())
        )
        .is_err());
        assert!(
            resolve_connector_identity(ConnectorTrustAction::Rotate, connector_id, None,).is_err()
        );
    }

    #[test]
    fn implementation_selectors_and_random_instance_ids_are_distinct_for_both_tools() {
        assert_eq!(
            connector_implementation(BUILTIN_CODEX_CONNECTOR),
            Some((ConnectorImplementation::Codex, true))
        );
        assert_eq!(
            connector_implementation(BUILTIN_CLAUDE_CODE_CONNECTOR),
            Some((ConnectorImplementation::ClaudeCode, true))
        );
        let claude = format!("{BUILTIN_CLAUDE_CODE_CONNECTOR}.{}", Uuid::new_v4());
        assert_eq!(
            connector_implementation(&claude),
            Some((ConnectorImplementation::ClaudeCode, false))
        );
        assert!(connector_implementation("builtin.codex.not-a-uuid").is_none());
    }

    #[test]
    fn preview_schema_can_describe_security_effects_without_key_material() {
        let preview = ConnectorTrustPreview {
            confirmation_token: Uuid::new_v4().to_string(),
            expires_in_seconds: CONFIRMATION_LIFETIME.as_secs(),
            action: ConnectorTrustActionView::Rotate,
            immediate_revocation: false,
            creates_new_credential: true,
            old_event_grace_seconds: 300,
            revokes_all_live_keys: false,
            deletes_obsolete_credentials: true,
            source_task_behavior_changed: false,
            key_material_exposed: false,
            hook_configuration_changed: false,
            source_instance_assigned_after_confirmation: false,
            connector_id_assigned_after_confirmation: false,
        };
        let encoded = serde_json::to_string(&preview).unwrap();
        assert!(!encoded.contains("keyId"));
        assert!(!encoded.contains("secret"));
        assert!(encoded.contains("oldEventGraceSeconds"));
        assert!(encoded.contains("sourceTaskBehaviorChanged"));
    }
}
