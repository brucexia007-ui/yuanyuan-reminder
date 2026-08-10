#![cfg(windows)]

use std::{
    collections::HashMap,
    time::{Duration, Instant},
};

use parking_lot::Mutex;
use serde::Serialize;
use uuid::Uuid;

use crate::{
    connector_config_official_write::{
        OfficialHookConfigAction, OfficialHookConfigWriteCoordinator, OfficialHookConfigWriteError,
        OfficialHookConfigWriteStatus,
    },
    connector_trust_control::{
        connector_trust_authority_state, reset_connector_trust_internal,
        retry_connector_trust_cleanup_internal, ConnectorTrustAuthorityState,
        ConnectorTrustResetOutcome,
    },
};

const CONFIRMATION_LIFETIME: Duration = Duration::from_secs(2 * 60);
const MAX_PENDING_DISCONNECTS: usize = 16;

#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub(crate) enum ConnectorDisconnectMode {
    RemoveConfigurationAndRevokeTrust,
    RevokeTrustOnly,
}

#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub(crate) enum ConnectorDisconnectPreviewStatus {
    ReadyForConfirmation,
    ConfigurationManualReview,
    NoChange,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ConnectorDisconnectPreview {
    pub status: ConnectorDisconnectPreviewStatus,
    pub mode: ConnectorDisconnectMode,
    pub confirmation_token: Option<String>,
    pub expires_in_seconds: u64,
    pub configuration_removal_planned: bool,
    pub expected_removed_handlers: usize,
    pub trust_revocation_planned: bool,
    pub trust_only_available: bool,
    pub trust_already_revoked: bool,
    pub caller_path_accepted: bool,
    pub configuration_write_performed: bool,
    pub trust_authority_changed: bool,
    pub source_task_behavior_changed: bool,
}

#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub(crate) enum ConnectorDisconnectResultStatus {
    Disconnected,
    DisconnectedCredentialCleanupPending,
    DisconnectedLocalMaintenancePending,
    DisconnectedCredentialCleanupAndLocalMaintenancePending,
    ConfigurationRemovalFailedTrustNotAttempted,
    TrustRevocationFailedStillActive,
    TrustRevocationUnverified,
    NoChange,
}

#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub(crate) enum ConnectorDisconnectRecoveryAction {
    None,
    RetryDisconnectPreview,
    RetryTrustRevocation,
    RetryCredentialCleanup,
    RetryLocalMaintenance,
    RetryCredentialCleanupAndLocalMaintenance,
    RecheckAuthority,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ConnectorDisconnectResult {
    pub status: ConnectorDisconnectResultStatus,
    pub mode: ConnectorDisconnectMode,
    pub removed_handlers: usize,
    pub configuration_write_performed: bool,
    pub configuration_backup_created: bool,
    pub trust_revocation_attempted: bool,
    pub trust_authority_revoked: bool,
    pub trust_authority_verified: bool,
    pub credential_cleanup_pending: bool,
    pub local_maintenance_pending: bool,
    pub retry_required: bool,
    pub recovery_action: ConnectorDisconnectRecoveryAction,
    pub caller_path_accepted: bool,
    pub source_task_behavior_changed: bool,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ConnectorDisconnectMaintenancePreview {
    pub confirmation_token: String,
    pub expires_in_seconds: u64,
    pub recovery_action: ConnectorDisconnectRecoveryAction,
    pub trust_authority_verified_revoked: bool,
    pub credential_cleanup_may_be_retried: bool,
    pub local_maintenance_may_be_retried: bool,
    pub caller_path_accepted: bool,
    pub source_task_behavior_changed: bool,
}

#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub(crate) enum ConnectorDisconnectMaintenanceStatus {
    Complete,
    CredentialCleanupPending,
    LocalMaintenancePending,
    CredentialCleanupAndLocalMaintenancePending,
    AuthorityStillActive,
    AuthorityUnverified,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ConnectorDisconnectMaintenanceResult {
    pub status: ConnectorDisconnectMaintenanceStatus,
    pub recovery_action: ConnectorDisconnectRecoveryAction,
    pub trust_authority_revoked: bool,
    pub trust_authority_verified: bool,
    pub credential_cleanup_pending: bool,
    pub local_maintenance_pending: bool,
    pub retry_required: bool,
    pub caller_path_accepted: bool,
    pub source_task_behavior_changed: bool,
}

#[derive(Debug, thiserror::Error, Clone, Copy, PartialEq, Eq)]
pub(crate) enum ConnectorDisconnectError {
    #[error("connector authority is unavailable")]
    AuthorizationUnavailable,
    #[error("too many connector disconnects are awaiting confirmation")]
    ConfirmationCapacityReached,
    #[error("connector disconnect confirmation is invalid or expired")]
    InvalidConfirmation,
    #[error("connector recovery action is not available for the current authority state")]
    RecoveryUnavailable,
}

#[derive(Debug, Clone, PartialEq, Eq)]
enum ConfigurationRemovalPreview {
    Ready {
        confirmation_token: String,
        removed_handlers: usize,
    },
    NoChange,
    ManualReview,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct ConfigurationRemovalResult {
    removed_handlers: usize,
    backup_created: bool,
    write_performed: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum ConfigurationPortError {
    AuthorizationUnavailable,
    CapacityReached,
    Failed,
}

trait ConfigurationDisconnectPort {
    fn preview_disconnect(
        &self,
        connector_id: &str,
        source_instance: &str,
    ) -> Result<ConfigurationRemovalPreview, ConfigurationPortError>;

    fn apply_disconnect(
        &self,
        confirmation_token: &str,
    ) -> Result<ConfigurationRemovalResult, ConfigurationPortError>;

    fn discard_disconnect(&self, confirmation_token: &str);
}

trait TrustDisconnectPort {
    fn authority_state(
        &self,
        connector_id: &str,
        source_instance: &str,
    ) -> Result<ConnectorTrustAuthorityState, ()>;

    fn revoke(&self, connector_id: &str, source_instance: &str) -> ConnectorTrustResetOutcome;

    fn recover_cleanup(
        &self,
        connector_id: &str,
        source_instance: &str,
    ) -> ConnectorTrustResetOutcome;
}

#[derive(Default)]
struct SystemTrustDisconnectPort;

impl ConfigurationDisconnectPort for OfficialHookConfigWriteCoordinator {
    fn preview_disconnect(
        &self,
        connector_id: &str,
        source_instance: &str,
    ) -> Result<ConfigurationRemovalPreview, ConfigurationPortError> {
        match OfficialHookConfigWriteCoordinator::preview_disconnect(
            self,
            connector_id.to_owned(),
            source_instance.to_owned(),
        ) {
            Ok(preview) if preview.action != OfficialHookConfigAction::Disconnect => {
                Err(ConfigurationPortError::Failed)
            }
            Ok(preview) => match preview.status {
                OfficialHookConfigWriteStatus::ReadyForConfirmation => {
                    let token = preview
                        .confirmation_token
                        .ok_or(ConfigurationPortError::Failed)?;
                    Ok(ConfigurationRemovalPreview::Ready {
                        confirmation_token: token,
                        removed_handlers: preview.removed_handlers,
                    })
                }
                OfficialHookConfigWriteStatus::NoChange => {
                    Ok(ConfigurationRemovalPreview::NoChange)
                }
                OfficialHookConfigWriteStatus::ManualReview => {
                    Ok(ConfigurationRemovalPreview::ManualReview)
                }
            },
            Err(OfficialHookConfigWriteError::AuthorizationUnavailable) => {
                Err(ConfigurationPortError::AuthorizationUnavailable)
            }
            Err(OfficialHookConfigWriteError::ConfirmationCapacityReached) => {
                Err(ConfigurationPortError::CapacityReached)
            }
            Err(
                OfficialHookConfigWriteError::ManualReviewRequired
                | OfficialHookConfigWriteError::UnsafeOfficialTarget
                | OfficialHookConfigWriteError::WriteFailed
                | OfficialHookConfigWriteError::ConfigurationChanged,
            ) => Ok(ConfigurationRemovalPreview::ManualReview),
            Err(OfficialHookConfigWriteError::InvalidConfirmation) => {
                Err(ConfigurationPortError::Failed)
            }
        }
    }

    fn apply_disconnect(
        &self,
        confirmation_token: &str,
    ) -> Result<ConfigurationRemovalResult, ConfigurationPortError> {
        let result = self
            .apply(confirmation_token)
            .map_err(|_| ConfigurationPortError::Failed)?;
        if result.action != OfficialHookConfigAction::Disconnect {
            return Err(ConfigurationPortError::Failed);
        }
        Ok(ConfigurationRemovalResult {
            removed_handlers: result.removed_handlers,
            backup_created: result.backup_created,
            write_performed: result.config_write_performed,
        })
    }

    fn discard_disconnect(&self, confirmation_token: &str) {
        self.discard_confirmation(confirmation_token);
    }
}

impl TrustDisconnectPort for SystemTrustDisconnectPort {
    fn authority_state(
        &self,
        connector_id: &str,
        source_instance: &str,
    ) -> Result<ConnectorTrustAuthorityState, ()> {
        connector_trust_authority_state(connector_id, source_instance)
    }

    fn revoke(&self, connector_id: &str, source_instance: &str) -> ConnectorTrustResetOutcome {
        reset_connector_trust_internal(connector_id, source_instance)
    }

    fn recover_cleanup(
        &self,
        connector_id: &str,
        source_instance: &str,
    ) -> ConnectorTrustResetOutcome {
        retry_connector_trust_cleanup_internal(connector_id, source_instance)
    }
}

struct PendingDisconnect {
    mode: ConnectorDisconnectMode,
    connector_id: String,
    source_instance: String,
    configuration_confirmation_token: Option<String>,
    expected_removed_handlers: usize,
    expires_at: Instant,
}

struct PendingMaintenance {
    recovery_action: ConnectorDisconnectRecoveryAction,
    connector_id: String,
    source_instance: String,
    expires_at: Instant,
}

enum PendingOperation {
    Disconnect(PendingDisconnect),
    Maintenance(PendingMaintenance),
}

impl PendingOperation {
    fn expires_at(&self) -> Instant {
        match self {
            Self::Disconnect(item) => item.expires_at,
            Self::Maintenance(item) => item.expires_at,
        }
    }

    fn configuration_confirmation_token(&self) -> Option<&str> {
        match self {
            Self::Disconnect(item) => item.configuration_confirmation_token.as_deref(),
            Self::Maintenance(_) => None,
        }
    }
}

struct ConnectorDisconnectCoordinator<
    C = OfficialHookConfigWriteCoordinator,
    T = SystemTrustDisconnectPort,
> {
    configuration: C,
    trust: T,
    pending: Mutex<HashMap<String, PendingOperation>>,
}

impl<C: Default, T: Default> Default for ConnectorDisconnectCoordinator<C, T> {
    fn default() -> Self {
        Self {
            configuration: C::default(),
            trust: T::default(),
            pending: Mutex::new(HashMap::new()),
        }
    }
}

impl<C: ConfigurationDisconnectPort, T: TrustDisconnectPort> ConnectorDisconnectCoordinator<C, T> {
    /// Product-facing shape remains identity-only; no configuration path is
    /// accepted. The module itself is not registered as a Tauri command.
    fn preview(
        &self,
        mode: ConnectorDisconnectMode,
        connector_id: String,
        source_instance: String,
    ) -> Result<ConnectorDisconnectPreview, ConnectorDisconnectError> {
        self.preview_at(mode, connector_id, source_instance, Instant::now())
    }

    fn preview_at(
        &self,
        mode: ConnectorDisconnectMode,
        connector_id: String,
        source_instance: String,
        now: Instant,
    ) -> Result<ConnectorDisconnectPreview, ConnectorDisconnectError> {
        let authority = self
            .trust
            .authority_state(&connector_id, &source_instance)
            .map_err(|_| ConnectorDisconnectError::AuthorizationUnavailable)?;
        if authority == ConnectorTrustAuthorityState::Revoked {
            return Ok(if mode == ConnectorDisconnectMode::RevokeTrustOnly {
                no_change_preview(mode)
            } else {
                manual_review_preview(mode, true)
            });
        }

        let mut pending = self.pending.lock();
        let expired = pending
            .values()
            .filter(|item| item.expires_at() <= now)
            .filter_map(|item| item.configuration_confirmation_token().map(str::to_owned))
            .collect::<Vec<_>>();
        pending.retain(|_, item| item.expires_at() > now);
        for token in expired {
            self.configuration.discard_disconnect(&token);
        }
        if pending.len() >= MAX_PENDING_DISCONNECTS {
            return Err(ConnectorDisconnectError::ConfirmationCapacityReached);
        }

        let configuration = if mode == ConnectorDisconnectMode::RemoveConfigurationAndRevokeTrust {
            match self
                .configuration
                .preview_disconnect(&connector_id, &source_instance)
            {
                Ok(preview) => preview,
                Err(ConfigurationPortError::AuthorizationUnavailable) => {
                    return Err(ConnectorDisconnectError::AuthorizationUnavailable)
                }
                Err(ConfigurationPortError::CapacityReached) => {
                    return Err(ConnectorDisconnectError::ConfirmationCapacityReached)
                }
                Err(ConfigurationPortError::Failed) => {
                    return Ok(manual_review_preview(mode, false))
                }
            }
        } else {
            ConfigurationRemovalPreview::NoChange
        };
        if configuration == ConfigurationRemovalPreview::ManualReview {
            return Ok(manual_review_preview(mode, false));
        }
        let (configuration_confirmation_token, expected_removed_handlers) = match configuration {
            ConfigurationRemovalPreview::Ready {
                confirmation_token,
                removed_handlers,
            } => (Some(confirmation_token), removed_handlers),
            ConfigurationRemovalPreview::NoChange => (None, 0),
            ConfigurationRemovalPreview::ManualReview => unreachable!("handled above"),
        };
        let token = Uuid::new_v4().to_string();
        pending.insert(
            token.clone(),
            PendingOperation::Disconnect(PendingDisconnect {
                mode,
                connector_id,
                source_instance,
                configuration_confirmation_token,
                expected_removed_handlers,
                expires_at: now + CONFIRMATION_LIFETIME,
            }),
        );
        Ok(ConnectorDisconnectPreview {
            status: ConnectorDisconnectPreviewStatus::ReadyForConfirmation,
            mode,
            confirmation_token: Some(token),
            expires_in_seconds: CONFIRMATION_LIFETIME.as_secs(),
            configuration_removal_planned: expected_removed_handlers > 0,
            expected_removed_handlers,
            trust_revocation_planned: true,
            trust_only_available: mode
                == ConnectorDisconnectMode::RemoveConfigurationAndRevokeTrust,
            trust_already_revoked: false,
            caller_path_accepted: false,
            configuration_write_performed: false,
            trust_authority_changed: false,
            source_task_behavior_changed: false,
        })
    }

    fn apply(
        &self,
        confirmation_token: &str,
    ) -> Result<ConnectorDisconnectResult, ConnectorDisconnectError> {
        self.apply_at(confirmation_token, Instant::now())
    }

    fn apply_at(
        &self,
        confirmation_token: &str,
        now: Instant,
    ) -> Result<ConnectorDisconnectResult, ConnectorDisconnectError> {
        if Uuid::parse_str(confirmation_token).is_err() {
            return Err(ConnectorDisconnectError::InvalidConfirmation);
        }
        let pending = self
            .pending
            .lock()
            .remove(confirmation_token)
            .ok_or(ConnectorDisconnectError::InvalidConfirmation)?;
        let PendingOperation::Disconnect(pending) = pending else {
            return Err(ConnectorDisconnectError::InvalidConfirmation);
        };
        if pending.expires_at <= now {
            if let Some(token) = &pending.configuration_confirmation_token {
                self.configuration.discard_disconnect(token);
            }
            return Err(ConnectorDisconnectError::InvalidConfirmation);
        }

        let configuration_result = if let Some(token) = &pending.configuration_confirmation_token {
            match self.configuration.apply_disconnect(token) {
                Ok(result)
                    if result.removed_handlers == pending.expected_removed_handlers
                        && result.write_performed =>
                {
                    result
                }
                _ => {
                    return Ok(configuration_failed_result(pending.mode));
                }
            }
        } else {
            ConfigurationRemovalResult {
                removed_handlers: 0,
                backup_created: false,
                write_performed: false,
            }
        };

        let trust = self
            .trust
            .revoke(&pending.connector_id, &pending.source_instance);
        Ok(disconnect_result(pending.mode, configuration_result, trust))
    }

    /// Issues a separate confirmation for maintenance after authority has
    /// already been revoked. This never retries configuration removal or
    /// recreates trust, and it accepts no path.
    fn preview_maintenance(
        &self,
        recovery_action: ConnectorDisconnectRecoveryAction,
        connector_id: String,
        source_instance: String,
    ) -> Result<ConnectorDisconnectMaintenancePreview, ConnectorDisconnectError> {
        self.preview_maintenance_at(
            recovery_action,
            connector_id,
            source_instance,
            Instant::now(),
        )
    }

    fn preview_maintenance_at(
        &self,
        recovery_action: ConnectorDisconnectRecoveryAction,
        connector_id: String,
        source_instance: String,
        now: Instant,
    ) -> Result<ConnectorDisconnectMaintenancePreview, ConnectorDisconnectError> {
        if !is_post_revocation_maintenance(recovery_action) {
            return Err(ConnectorDisconnectError::RecoveryUnavailable);
        }
        match self
            .trust
            .authority_state(&connector_id, &source_instance)
            .map_err(|_| ConnectorDisconnectError::AuthorizationUnavailable)?
        {
            ConnectorTrustAuthorityState::Active => {
                return Err(ConnectorDisconnectError::RecoveryUnavailable)
            }
            ConnectorTrustAuthorityState::Revoked => {}
        }

        let mut pending = self.pending.lock();
        let expired = pending
            .values()
            .filter(|item| item.expires_at() <= now)
            .filter_map(|item| item.configuration_confirmation_token().map(str::to_owned))
            .collect::<Vec<_>>();
        pending.retain(|_, item| item.expires_at() > now);
        for token in expired {
            self.configuration.discard_disconnect(&token);
        }
        if pending.len() >= MAX_PENDING_DISCONNECTS {
            return Err(ConnectorDisconnectError::ConfirmationCapacityReached);
        }
        let token = Uuid::new_v4().to_string();
        pending.insert(
            token.clone(),
            PendingOperation::Maintenance(PendingMaintenance {
                recovery_action,
                connector_id,
                source_instance,
                expires_at: now + CONFIRMATION_LIFETIME,
            }),
        );
        Ok(ConnectorDisconnectMaintenancePreview {
            confirmation_token: token,
            expires_in_seconds: CONFIRMATION_LIFETIME.as_secs(),
            recovery_action,
            trust_authority_verified_revoked: true,
            credential_cleanup_may_be_retried: matches!(
                recovery_action,
                ConnectorDisconnectRecoveryAction::RetryCredentialCleanup
                    | ConnectorDisconnectRecoveryAction::RetryCredentialCleanupAndLocalMaintenance
            ),
            local_maintenance_may_be_retried: matches!(
                recovery_action,
                ConnectorDisconnectRecoveryAction::RetryLocalMaintenance
                    | ConnectorDisconnectRecoveryAction::RetryCredentialCleanupAndLocalMaintenance
            ),
            caller_path_accepted: false,
            source_task_behavior_changed: false,
        })
    }

    fn apply_maintenance(
        &self,
        confirmation_token: &str,
    ) -> Result<ConnectorDisconnectMaintenanceResult, ConnectorDisconnectError> {
        self.apply_maintenance_at(confirmation_token, Instant::now())
    }

    fn apply_maintenance_at(
        &self,
        confirmation_token: &str,
        now: Instant,
    ) -> Result<ConnectorDisconnectMaintenanceResult, ConnectorDisconnectError> {
        if Uuid::parse_str(confirmation_token).is_err() {
            return Err(ConnectorDisconnectError::InvalidConfirmation);
        }
        let pending = self
            .pending
            .lock()
            .remove(confirmation_token)
            .ok_or(ConnectorDisconnectError::InvalidConfirmation)?;
        let PendingOperation::Maintenance(pending) = pending else {
            return Err(ConnectorDisconnectError::InvalidConfirmation);
        };
        if pending.expires_at <= now {
            return Err(ConnectorDisconnectError::InvalidConfirmation);
        }
        let outcome = self
            .trust
            .recover_cleanup(&pending.connector_id, &pending.source_instance);
        Ok(maintenance_result(pending.recovery_action, outcome))
    }
}

fn is_post_revocation_maintenance(action: ConnectorDisconnectRecoveryAction) -> bool {
    matches!(
        action,
        ConnectorDisconnectRecoveryAction::RetryCredentialCleanup
            | ConnectorDisconnectRecoveryAction::RetryLocalMaintenance
            | ConnectorDisconnectRecoveryAction::RetryCredentialCleanupAndLocalMaintenance
    )
}

fn no_change_preview(mode: ConnectorDisconnectMode) -> ConnectorDisconnectPreview {
    ConnectorDisconnectPreview {
        status: ConnectorDisconnectPreviewStatus::NoChange,
        mode,
        confirmation_token: None,
        expires_in_seconds: 0,
        configuration_removal_planned: false,
        expected_removed_handlers: 0,
        trust_revocation_planned: false,
        trust_only_available: false,
        trust_already_revoked: true,
        caller_path_accepted: false,
        configuration_write_performed: false,
        trust_authority_changed: false,
        source_task_behavior_changed: false,
    }
}

fn manual_review_preview(
    mode: ConnectorDisconnectMode,
    trust_already_revoked: bool,
) -> ConnectorDisconnectPreview {
    ConnectorDisconnectPreview {
        status: ConnectorDisconnectPreviewStatus::ConfigurationManualReview,
        mode,
        confirmation_token: None,
        expires_in_seconds: 0,
        configuration_removal_planned: false,
        expected_removed_handlers: 0,
        trust_revocation_planned: false,
        trust_only_available: !trust_already_revoked,
        trust_already_revoked,
        caller_path_accepted: false,
        configuration_write_performed: false,
        trust_authority_changed: false,
        source_task_behavior_changed: false,
    }
}

fn configuration_failed_result(mode: ConnectorDisconnectMode) -> ConnectorDisconnectResult {
    ConnectorDisconnectResult {
        status: ConnectorDisconnectResultStatus::ConfigurationRemovalFailedTrustNotAttempted,
        mode,
        removed_handlers: 0,
        configuration_write_performed: false,
        configuration_backup_created: false,
        trust_revocation_attempted: false,
        trust_authority_revoked: false,
        trust_authority_verified: false,
        credential_cleanup_pending: false,
        local_maintenance_pending: false,
        retry_required: true,
        recovery_action: ConnectorDisconnectRecoveryAction::RetryDisconnectPreview,
        caller_path_accepted: false,
        source_task_behavior_changed: false,
    }
}

fn disconnect_result(
    mode: ConnectorDisconnectMode,
    configuration: ConfigurationRemovalResult,
    trust: ConnectorTrustResetOutcome,
) -> ConnectorDisconnectResult {
    let (
        status,
        trust_authority_revoked,
        trust_authority_verified,
        credential_cleanup_pending,
        local_maintenance_pending,
        retry_required,
        recovery_action,
    ) = match trust {
        ConnectorTrustResetOutcome::Revoked => (
            ConnectorDisconnectResultStatus::Disconnected,
            true,
            true,
            false,
            false,
            false,
            ConnectorDisconnectRecoveryAction::None,
        ),
        ConnectorTrustResetOutcome::RevokedCredentialCleanupPending => (
            ConnectorDisconnectResultStatus::DisconnectedCredentialCleanupPending,
            true,
            true,
            true,
            false,
            true,
            ConnectorDisconnectRecoveryAction::RetryCredentialCleanup,
        ),
        ConnectorTrustResetOutcome::RevokedLocalMaintenancePending => (
            ConnectorDisconnectResultStatus::DisconnectedLocalMaintenancePending,
            true,
            true,
            false,
            true,
            true,
            ConnectorDisconnectRecoveryAction::RetryLocalMaintenance,
        ),
        ConnectorTrustResetOutcome::RevokedCredentialCleanupAndLocalMaintenancePending => (
            ConnectorDisconnectResultStatus::DisconnectedCredentialCleanupAndLocalMaintenancePending,
            true,
            true,
            true,
            true,
            true,
            ConnectorDisconnectRecoveryAction::RetryCredentialCleanupAndLocalMaintenance,
        ),
        ConnectorTrustResetOutcome::StillActive => (
            ConnectorDisconnectResultStatus::TrustRevocationFailedStillActive,
            false,
            true,
            false,
            false,
            true,
            ConnectorDisconnectRecoveryAction::RetryTrustRevocation,
        ),
        ConnectorTrustResetOutcome::Unavailable => (
            ConnectorDisconnectResultStatus::TrustRevocationUnverified,
            false,
            false,
            false,
            false,
            true,
            ConnectorDisconnectRecoveryAction::RecheckAuthority,
        ),
    };
    ConnectorDisconnectResult {
        status,
        mode,
        removed_handlers: configuration.removed_handlers,
        configuration_write_performed: configuration.write_performed,
        configuration_backup_created: configuration.backup_created,
        trust_revocation_attempted: true,
        trust_authority_revoked,
        trust_authority_verified,
        credential_cleanup_pending,
        local_maintenance_pending,
        retry_required,
        recovery_action,
        caller_path_accepted: false,
        source_task_behavior_changed: false,
    }
}

fn maintenance_result(
    recovery_action: ConnectorDisconnectRecoveryAction,
    outcome: ConnectorTrustResetOutcome,
) -> ConnectorDisconnectMaintenanceResult {
    let (
        status,
        trust_authority_revoked,
        trust_authority_verified,
        credential_cleanup_pending,
        local_maintenance_pending,
        retry_required,
    ) = match outcome {
        ConnectorTrustResetOutcome::Revoked => (
            ConnectorDisconnectMaintenanceStatus::Complete,
            true,
            true,
            false,
            false,
            false,
        ),
        ConnectorTrustResetOutcome::RevokedCredentialCleanupPending => (
            ConnectorDisconnectMaintenanceStatus::CredentialCleanupPending,
            true,
            true,
            true,
            false,
            true,
        ),
        ConnectorTrustResetOutcome::RevokedLocalMaintenancePending => (
            ConnectorDisconnectMaintenanceStatus::LocalMaintenancePending,
            true,
            true,
            false,
            true,
            true,
        ),
        ConnectorTrustResetOutcome::RevokedCredentialCleanupAndLocalMaintenancePending => (
            ConnectorDisconnectMaintenanceStatus::CredentialCleanupAndLocalMaintenancePending,
            true,
            true,
            true,
            true,
            true,
        ),
        ConnectorTrustResetOutcome::StillActive => (
            ConnectorDisconnectMaintenanceStatus::AuthorityStillActive,
            false,
            true,
            false,
            false,
            true,
        ),
        ConnectorTrustResetOutcome::Unavailable => (
            ConnectorDisconnectMaintenanceStatus::AuthorityUnverified,
            false,
            false,
            false,
            false,
            true,
        ),
    };
    ConnectorDisconnectMaintenanceResult {
        status,
        recovery_action,
        trust_authority_revoked,
        trust_authority_verified,
        credential_cleanup_pending,
        local_maintenance_pending,
        retry_required,
        caller_path_accepted: false,
        source_task_behavior_changed: false,
    }
}

#[cfg(test)]
mod tests {
    use std::{collections::VecDeque, sync::Arc};

    use super::*;

    #[derive(Clone)]
    struct FakeConfiguration {
        preview: Arc<Mutex<Result<ConfigurationRemovalPreview, ConfigurationPortError>>>,
        apply: Arc<Mutex<Result<ConfigurationRemovalResult, ConfigurationPortError>>>,
        events: Arc<Mutex<Vec<&'static str>>>,
        discarded: Arc<Mutex<usize>>,
    }

    impl Default for FakeConfiguration {
        fn default() -> Self {
            Self {
                preview: Arc::new(Mutex::new(Ok(ConfigurationRemovalPreview::Ready {
                    confirmation_token: Uuid::new_v4().to_string(),
                    removed_handlers: 6,
                }))),
                apply: Arc::new(Mutex::new(Ok(ConfigurationRemovalResult {
                    removed_handlers: 6,
                    backup_created: true,
                    write_performed: true,
                }))),
                events: Arc::new(Mutex::new(Vec::new())),
                discarded: Arc::new(Mutex::new(0)),
            }
        }
    }

    impl ConfigurationDisconnectPort for FakeConfiguration {
        fn preview_disconnect(
            &self,
            _connector_id: &str,
            _source_instance: &str,
        ) -> Result<ConfigurationRemovalPreview, ConfigurationPortError> {
            self.preview.lock().clone()
        }

        fn apply_disconnect(
            &self,
            _confirmation_token: &str,
        ) -> Result<ConfigurationRemovalResult, ConfigurationPortError> {
            self.events.lock().push("configuration");
            *self.apply.lock()
        }

        fn discard_disconnect(&self, _confirmation_token: &str) {
            *self.discarded.lock() += 1;
        }
    }

    #[derive(Clone)]
    struct FakeTrust {
        authority: Arc<Mutex<Result<ConnectorTrustAuthorityState, ()>>>,
        resets: Arc<Mutex<VecDeque<ConnectorTrustResetOutcome>>>,
        recoveries: Arc<Mutex<VecDeque<ConnectorTrustResetOutcome>>>,
        events: Arc<Mutex<Vec<&'static str>>>,
    }

    impl Default for FakeTrust {
        fn default() -> Self {
            Self {
                authority: Arc::new(Mutex::new(Ok(ConnectorTrustAuthorityState::Active))),
                resets: Arc::new(Mutex::new(VecDeque::from([
                    ConnectorTrustResetOutcome::Revoked,
                ]))),
                recoveries: Arc::new(Mutex::new(VecDeque::from([
                    ConnectorTrustResetOutcome::Revoked,
                ]))),
                events: Arc::new(Mutex::new(Vec::new())),
            }
        }
    }

    impl TrustDisconnectPort for FakeTrust {
        fn authority_state(
            &self,
            _connector_id: &str,
            _source_instance: &str,
        ) -> Result<ConnectorTrustAuthorityState, ()> {
            *self.authority.lock()
        }

        fn revoke(
            &self,
            _connector_id: &str,
            _source_instance: &str,
        ) -> ConnectorTrustResetOutcome {
            self.events.lock().push("trust");
            self.resets
                .lock()
                .pop_front()
                .unwrap_or(ConnectorTrustResetOutcome::Unavailable)
        }

        fn recover_cleanup(
            &self,
            _connector_id: &str,
            _source_instance: &str,
        ) -> ConnectorTrustResetOutcome {
            self.events.lock().push("maintenance");
            self.recoveries
                .lock()
                .pop_front()
                .unwrap_or(ConnectorTrustResetOutcome::Unavailable)
        }
    }

    type TestCoordinator = ConnectorDisconnectCoordinator<FakeConfiguration, FakeTrust>;

    fn identity() -> (String, String) {
        (
            "builtin.codex.00000000-0000-4000-8000-000000000010".to_owned(),
            "00000000-0000-4000-8000-000000000001".to_owned(),
        )
    }

    fn preview(
        coordinator: &TestCoordinator,
        mode: ConnectorDisconnectMode,
    ) -> ConnectorDisconnectPreview {
        let (connector_id, source_instance) = identity();
        coordinator
            .preview(mode, connector_id, source_instance)
            .unwrap()
    }

    #[test]
    fn successful_disconnect_removes_configuration_before_revoking_trust() {
        let mut coordinator = TestCoordinator::default();
        // Share one event list so ordering, not merely occurrence, is proven.
        coordinator.trust.events = coordinator.configuration.events.clone();
        let preview = preview(
            &coordinator,
            ConnectorDisconnectMode::RemoveConfigurationAndRevokeTrust,
        );
        assert_eq!(
            preview.status,
            ConnectorDisconnectPreviewStatus::ReadyForConfirmation
        );
        assert_eq!(preview.expected_removed_handlers, 6);
        assert!(!preview.caller_path_accepted);
        let result = coordinator
            .apply(preview.confirmation_token.as_deref().unwrap())
            .unwrap();
        assert_eq!(result.status, ConnectorDisconnectResultStatus::Disconnected);
        assert_eq!(result.removed_handlers, 6);
        assert!(result.trust_authority_revoked);
        assert_eq!(
            coordinator.configuration.events.lock().as_slice(),
            ["configuration", "trust"]
        );
    }

    #[test]
    fn configuration_conflict_issues_no_combined_token_but_offers_explicit_trust_only() {
        let coordinator = TestCoordinator::default();
        *coordinator.configuration.preview.lock() = Ok(ConfigurationRemovalPreview::ManualReview);
        let blocked = preview(
            &coordinator,
            ConnectorDisconnectMode::RemoveConfigurationAndRevokeTrust,
        );
        assert_eq!(
            blocked.status,
            ConnectorDisconnectPreviewStatus::ConfigurationManualReview
        );
        assert!(blocked.confirmation_token.is_none());
        assert!(blocked.trust_only_available);

        let trust_only = preview(&coordinator, ConnectorDisconnectMode::RevokeTrustOnly);
        assert!(trust_only.confirmation_token.is_some());
        let result = coordinator
            .apply(trust_only.confirmation_token.as_deref().unwrap())
            .unwrap();
        assert!(result.trust_authority_revoked);
        assert!(!result.configuration_write_performed);
        assert!(coordinator.configuration.events.lock().is_empty());
    }

    #[test]
    fn configuration_apply_failure_never_attempts_trust_revocation() {
        let coordinator = TestCoordinator::default();
        *coordinator.configuration.apply.lock() = Err(ConfigurationPortError::Failed);
        let preview = preview(
            &coordinator,
            ConnectorDisconnectMode::RemoveConfigurationAndRevokeTrust,
        );
        let token = preview.confirmation_token.unwrap();
        let result = coordinator.apply(&token).unwrap();
        assert_eq!(
            result.status,
            ConnectorDisconnectResultStatus::ConfigurationRemovalFailedTrustNotAttempted
        );
        assert!(!result.trust_revocation_attempted);
        assert!(coordinator.trust.events.lock().is_empty());
        assert_eq!(
            coordinator.apply(&token),
            Err(ConnectorDisconnectError::InvalidConfirmation)
        );
    }

    #[test]
    fn post_configuration_trust_failure_is_precise_and_trust_only_can_retry() {
        let coordinator = TestCoordinator::default();
        *coordinator.trust.resets.lock() = VecDeque::from([
            ConnectorTrustResetOutcome::StillActive,
            ConnectorTrustResetOutcome::Revoked,
        ]);
        let combined_preview = preview(
            &coordinator,
            ConnectorDisconnectMode::RemoveConfigurationAndRevokeTrust,
        );
        let first = coordinator
            .apply(combined_preview.confirmation_token.as_deref().unwrap())
            .unwrap();
        assert_eq!(
            first.status,
            ConnectorDisconnectResultStatus::TrustRevocationFailedStillActive
        );
        assert!(first.configuration_write_performed);
        assert!(first.retry_required);

        let trust_only = preview(&coordinator, ConnectorDisconnectMode::RevokeTrustOnly);
        let retried = coordinator
            .apply(trust_only.confirmation_token.as_deref().unwrap())
            .unwrap();
        assert_eq!(
            retried.status,
            ConnectorDisconnectResultStatus::Disconnected
        );
        assert!(retried.trust_authority_revoked);
    }

    #[test]
    fn revoked_authority_with_cleanup_failure_is_not_misreported_as_live() {
        let coordinator = TestCoordinator::default();
        *coordinator.trust.resets.lock() =
            VecDeque::from([ConnectorTrustResetOutcome::RevokedCredentialCleanupPending]);
        let preview = preview(&coordinator, ConnectorDisconnectMode::RevokeTrustOnly);
        let result = coordinator
            .apply(preview.confirmation_token.as_deref().unwrap())
            .unwrap();
        assert_eq!(
            result.status,
            ConnectorDisconnectResultStatus::DisconnectedCredentialCleanupPending
        );
        assert!(result.trust_authority_revoked);
        assert!(result.trust_authority_verified);
        assert!(result.credential_cleanup_pending);
        assert_eq!(
            result.recovery_action,
            ConnectorDisconnectRecoveryAction::RetryCredentialCleanup
        );
    }

    #[test]
    fn revoked_local_maintenance_and_unverified_authority_have_distinct_results() {
        let coordinator = TestCoordinator::default();
        *coordinator.trust.resets.lock() = VecDeque::from([
            ConnectorTrustResetOutcome::RevokedLocalMaintenancePending,
            ConnectorTrustResetOutcome::Unavailable,
        ]);
        let maintenance = preview(&coordinator, ConnectorDisconnectMode::RevokeTrustOnly);
        let maintenance = coordinator
            .apply(maintenance.confirmation_token.as_deref().unwrap())
            .unwrap();
        assert_eq!(
            maintenance.status,
            ConnectorDisconnectResultStatus::DisconnectedLocalMaintenancePending
        );
        assert!(maintenance.trust_authority_revoked);
        assert!(maintenance.local_maintenance_pending);
        assert!(!maintenance.credential_cleanup_pending);

        let unverified = preview(&coordinator, ConnectorDisconnectMode::RevokeTrustOnly);
        let unverified = coordinator
            .apply(unverified.confirmation_token.as_deref().unwrap())
            .unwrap();
        assert_eq!(
            unverified.status,
            ConnectorDisconnectResultStatus::TrustRevocationUnverified
        );
        assert!(!unverified.trust_authority_verified);
        assert!(unverified.retry_required);
        assert_eq!(
            unverified.recovery_action,
            ConnectorDisconnectRecoveryAction::RecheckAuthority
        );
    }

    #[test]
    fn post_revocation_maintenance_has_its_own_confirmation_and_precise_results() {
        let coordinator = TestCoordinator::default();
        *coordinator.trust.authority.lock() = Ok(ConnectorTrustAuthorityState::Revoked);
        *coordinator.trust.recoveries.lock() = VecDeque::from([
            ConnectorTrustResetOutcome::RevokedCredentialCleanupPending,
            ConnectorTrustResetOutcome::RevokedCredentialCleanupAndLocalMaintenancePending,
            ConnectorTrustResetOutcome::Revoked,
        ]);
        let (connector_id, source_instance) = identity();
        let cleanup = coordinator
            .preview_maintenance(
                ConnectorDisconnectRecoveryAction::RetryCredentialCleanup,
                connector_id.clone(),
                source_instance.clone(),
            )
            .unwrap();
        assert!(cleanup.trust_authority_verified_revoked);
        assert!(cleanup.credential_cleanup_may_be_retried);
        assert!(!cleanup.local_maintenance_may_be_retried);
        let encoded = serde_json::to_string(&cleanup).unwrap();
        assert!(!encoded.contains("builtin.codex"));
        assert!(!encoded.contains("00000000-0000"));
        let token = cleanup.confirmation_token;
        let pending = coordinator.apply_maintenance(&token).unwrap();
        assert_eq!(
            pending.status,
            ConnectorDisconnectMaintenanceStatus::CredentialCleanupPending
        );
        assert!(pending.trust_authority_revoked);
        assert_eq!(
            coordinator.apply_maintenance(&token),
            Err(ConnectorDisconnectError::InvalidConfirmation)
        );

        let both = coordinator
            .preview_maintenance(
                ConnectorDisconnectRecoveryAction::RetryCredentialCleanupAndLocalMaintenance,
                connector_id.clone(),
                source_instance.clone(),
            )
            .unwrap();
        let both = coordinator
            .apply_maintenance(&both.confirmation_token)
            .unwrap();
        assert_eq!(
            both.status,
            ConnectorDisconnectMaintenanceStatus::CredentialCleanupAndLocalMaintenancePending
        );
        assert!(both.credential_cleanup_pending);
        assert!(both.local_maintenance_pending);

        let complete = coordinator
            .preview_maintenance(
                ConnectorDisconnectRecoveryAction::RetryLocalMaintenance,
                connector_id,
                source_instance,
            )
            .unwrap();
        let complete = coordinator
            .apply_maintenance(&complete.confirmation_token)
            .unwrap();
        assert_eq!(
            complete.status,
            ConnectorDisconnectMaintenanceStatus::Complete
        );
        assert!(!complete.retry_required);
    }

    #[test]
    fn maintenance_refuses_live_authority_wrong_actions_and_cross_endpoint_tokens() {
        let coordinator = TestCoordinator::default();
        let (connector_id, source_instance) = identity();
        assert_eq!(
            coordinator.preview_maintenance(
                ConnectorDisconnectRecoveryAction::RetryCredentialCleanup,
                connector_id.clone(),
                source_instance.clone(),
            ),
            Err(ConnectorDisconnectError::RecoveryUnavailable)
        );
        *coordinator.trust.authority.lock() = Ok(ConnectorTrustAuthorityState::Revoked);
        assert_eq!(
            coordinator.preview_maintenance(
                ConnectorDisconnectRecoveryAction::RetryTrustRevocation,
                connector_id.clone(),
                source_instance.clone(),
            ),
            Err(ConnectorDisconnectError::RecoveryUnavailable)
        );
        let maintenance = coordinator
            .preview_maintenance(
                ConnectorDisconnectRecoveryAction::RetryLocalMaintenance,
                connector_id,
                source_instance,
            )
            .unwrap();
        assert_eq!(
            coordinator.apply(&maintenance.confirmation_token),
            Err(ConnectorDisconnectError::InvalidConfirmation)
        );
        assert_eq!(
            coordinator.apply_maintenance(&maintenance.confirmation_token),
            Err(ConnectorDisconnectError::InvalidConfirmation)
        );
    }

    #[test]
    fn already_revoked_and_expired_confirmations_are_idempotent_and_clean_inner_tokens() {
        let coordinator = TestCoordinator::default();
        *coordinator.trust.authority.lock() = Ok(ConnectorTrustAuthorityState::Revoked);
        let no_change = preview(&coordinator, ConnectorDisconnectMode::RevokeTrustOnly);
        assert_eq!(no_change.status, ConnectorDisconnectPreviewStatus::NoChange);
        assert!(no_change.confirmation_token.is_none());

        *coordinator.trust.authority.lock() = Ok(ConnectorTrustAuthorityState::Active);
        let now = Instant::now();
        let (connector_id, source_instance) = identity();
        let pending = coordinator
            .preview_at(
                ConnectorDisconnectMode::RemoveConfigurationAndRevokeTrust,
                connector_id,
                source_instance,
                now,
            )
            .unwrap();
        assert_eq!(
            coordinator.apply_at(
                pending.confirmation_token.as_deref().unwrap(),
                now + CONFIRMATION_LIFETIME + Duration::from_millis(1)
            ),
            Err(ConnectorDisconnectError::InvalidConfirmation)
        );
        assert_eq!(*coordinator.configuration.discarded.lock(), 1);
    }

    #[test]
    fn contracts_are_bounded_pathless_and_redacted() {
        let coordinator = TestCoordinator::default();
        let first = preview(
            &coordinator,
            ConnectorDisconnectMode::RemoveConfigurationAndRevokeTrust,
        );
        let encoded = serde_json::to_string(&first).unwrap();
        assert!(!encoded.contains("builtin.codex"));
        assert!(!encoded.contains("00000000-0000"));
        assert!(!encoded.contains("C:\\"));
        assert!(!encoded.contains("USERPROFILE"));

        for _ in 1..MAX_PENDING_DISCONNECTS {
            assert_eq!(
                preview(
                    &coordinator,
                    ConnectorDisconnectMode::RemoveConfigurationAndRevokeTrust
                )
                .status,
                ConnectorDisconnectPreviewStatus::ReadyForConfirmation
            );
        }
        let (connector_id, source_instance) = identity();
        assert_eq!(
            coordinator.preview(
                ConnectorDisconnectMode::RemoveConfigurationAndRevokeTrust,
                connector_id,
                source_instance
            ),
            Err(ConnectorDisconnectError::ConfirmationCapacityReached)
        );
        *coordinator.trust.authority.lock() = Ok(ConnectorTrustAuthorityState::Revoked);
        let (connector_id, source_instance) = identity();
        assert_eq!(
            coordinator.preview_maintenance(
                ConnectorDisconnectRecoveryAction::RetryCredentialCleanup,
                connector_id,
                source_instance,
            ),
            Err(ConnectorDisconnectError::ConfirmationCapacityReached)
        );

        let _preview_entry: fn(
            &ConnectorDisconnectCoordinator,
            ConnectorDisconnectMode,
            String,
            String,
        )
            -> Result<ConnectorDisconnectPreview, ConnectorDisconnectError> =
            ConnectorDisconnectCoordinator::preview;
        let _apply_entry: fn(
            &ConnectorDisconnectCoordinator,
            &str,
        )
            -> Result<ConnectorDisconnectResult, ConnectorDisconnectError> =
            ConnectorDisconnectCoordinator::apply;
        let _maintenance_preview_entry: fn(
            &ConnectorDisconnectCoordinator,
            ConnectorDisconnectRecoveryAction,
            String,
            String,
        ) -> Result<
            ConnectorDisconnectMaintenancePreview,
            ConnectorDisconnectError,
        > = ConnectorDisconnectCoordinator::preview_maintenance;
        let _maintenance_apply_entry: fn(
            &ConnectorDisconnectCoordinator,
            &str,
        ) -> Result<
            ConnectorDisconnectMaintenanceResult,
            ConnectorDisconnectError,
        > = ConnectorDisconnectCoordinator::apply_maintenance;
    }
}
