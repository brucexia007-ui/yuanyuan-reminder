use std::collections::HashMap;

use serde::Serialize;
use sha2::{Digest, Sha256};
use uuid::Uuid;
use yuanyuan_protocol::ReturnAction;

const ACTION_OPEN_TASK: &str = "open.task";
const MAX_OPAQUE_TARGET_BYTES: usize = 128;
const CAPABILITY_TTL_MS: i64 = 2 * 60 * 1_000;
const MAX_PENDING_CAPABILITIES: usize = 64;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ReturnSource {
    Codex,
    ClaudeCode,
}

impl ReturnSource {
    fn expected_protocol_source(self) -> &'static str {
        match self {
            Self::Codex => "openai.codex",
            Self::ClaudeCode => "anthropic.claude-code",
        }
    }

    fn connector_prefix(self) -> &'static str {
        match self {
            Self::Codex => "builtin.codex.",
            Self::ClaudeCode => "builtin.claude-code.",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Handler {
    SourceTaskUnavailable,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct RegistryEntry {
    source: ReturnSource,
    action_id: &'static str,
    handler: Handler,
}

const CURRENT_ENTRIES: [RegistryEntry; 2] = [
    RegistryEntry {
        source: ReturnSource::Codex,
        action_id: ACTION_OPEN_TASK,
        handler: Handler::SourceTaskUnavailable,
    },
    RegistryEntry {
        source: ReturnSource::ClaudeCode,
        action_id: ACTION_OPEN_TASK,
        handler: Handler::SourceTaskUnavailable,
    },
];

#[derive(Debug, Clone, Copy)]
pub struct ReturnActionRegistry {
    entries: &'static [RegistryEntry],
}

impl Default for ReturnActionRegistry {
    fn default() -> Self {
        Self {
            entries: &CURRENT_ENTRIES,
        }
    }
}

#[derive(Debug, Clone, Copy)]
pub struct ReturnActionContext<'a> {
    pub connector_id: &'a str,
    pub source_instance: &'a str,
    pub protocol_source: &'a str,
    pub task_digest: [u8; 16],
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ReturnActionCapability {
    pub token: String,
    pub source: ReturnSource,
    pub expires_at_unix_ms: i64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ReturnActionFallbackReason {
    SourceHandlerUnavailable,
    CapabilityExpired,
    RegistryChanged,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ReturnActionClick {
    OpenTaskWatchFallback {
        source: ReturnSource,
        task_digest: [u8; 16],
        target_digest: String,
        reason: ReturnActionFallbackReason,
    },
    NoAction,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ReturnActionRejection {
    UnsupportedConnector,
    ConnectorSourceMismatch,
    UnregisteredAction,
    MissingTarget,
    InvalidTarget,
    CapacityReached,
}

#[derive(Debug, Clone)]
struct PendingCapability {
    connector_id: String,
    source_instance: String,
    protocol_source: String,
    task_digest: [u8; 16],
    action: ReturnAction,
    source: ReturnSource,
    target_digest: String,
    expires_at_unix_ms: i64,
}

#[derive(Debug, Default)]
pub struct ReturnActionGate {
    pending: HashMap<String, PendingCapability>,
}

impl ReturnActionRegistry {
    fn validate(
        &self,
        context: ReturnActionContext<'_>,
        action: &ReturnAction,
    ) -> Result<(RegistryEntry, String), ReturnActionRejection> {
        let source = resolve_connector(context.connector_id, context.source_instance)?;
        if context.protocol_source != source.expected_protocol_source() {
            return Err(ReturnActionRejection::ConnectorSourceMismatch);
        }
        let entry = self
            .entries
            .iter()
            .copied()
            .find(|entry| entry.source == source && entry.action_id == action.action_id)
            .ok_or(ReturnActionRejection::UnregisteredAction)?;
        let target = action
            .target
            .as_deref()
            .ok_or(ReturnActionRejection::MissingTarget)?;
        let normalized = normalize_opaque_task_target(target)?;
        Ok((entry, normalized))
    }

    #[cfg(test)]
    fn empty() -> Self {
        Self { entries: &[] }
    }
}

impl ReturnActionGate {
    pub fn prepare(
        &mut self,
        registry: &ReturnActionRegistry,
        context: ReturnActionContext<'_>,
        action: &ReturnAction,
        now_unix_ms: i64,
    ) -> Result<ReturnActionCapability, ReturnActionRejection> {
        self.pending
            .retain(|_, pending| pending.expires_at_unix_ms > now_unix_ms);
        if self.pending.len() >= MAX_PENDING_CAPABILITIES {
            return Err(ReturnActionRejection::CapacityReached);
        }
        let (entry, normalized_target) = registry.validate(context, action)?;
        let token = Uuid::new_v4().to_string();
        let expires_at_unix_ms = now_unix_ms.saturating_add(CAPABILITY_TTL_MS);
        let target_digest = audit_target_digest(
            context.connector_id,
            entry.action_id,
            normalized_target.as_bytes(),
        );
        self.pending.insert(
            token.clone(),
            PendingCapability {
                connector_id: context.connector_id.to_owned(),
                source_instance: context.source_instance.to_owned(),
                protocol_source: context.protocol_source.to_owned(),
                task_digest: context.task_digest,
                action: ReturnAction {
                    action_id: action.action_id.clone(),
                    target: Some(normalized_target),
                },
                source: entry.source,
                target_digest,
                expires_at_unix_ms,
            },
        );
        Ok(ReturnActionCapability {
            token,
            source: entry.source,
            expires_at_unix_ms,
        })
    }

    pub fn consume(
        &mut self,
        registry: &ReturnActionRegistry,
        token: &str,
        now_unix_ms: i64,
    ) -> ReturnActionClick {
        let Some(pending) = self.pending.remove(token) else {
            return ReturnActionClick::NoAction;
        };
        if pending.expires_at_unix_ms <= now_unix_ms {
            return fallback(pending, ReturnActionFallbackReason::CapabilityExpired);
        }
        let context = ReturnActionContext {
            connector_id: &pending.connector_id,
            source_instance: &pending.source_instance,
            protocol_source: &pending.protocol_source,
            task_digest: pending.task_digest,
        };
        let Ok((entry, normalized_target)) = registry.validate(context, &pending.action) else {
            return fallback(pending, ReturnActionFallbackReason::RegistryChanged);
        };
        let revalidated_digest = audit_target_digest(
            context.connector_id,
            entry.action_id,
            normalized_target.as_bytes(),
        );
        if revalidated_digest != pending.target_digest {
            return fallback(pending, ReturnActionFallbackReason::RegistryChanged);
        }
        match entry.handler {
            Handler::SourceTaskUnavailable => fallback(
                pending,
                ReturnActionFallbackReason::SourceHandlerUnavailable,
            ),
        }
    }
}

fn resolve_connector(
    connector_id: &str,
    source_instance: &str,
) -> Result<ReturnSource, ReturnActionRejection> {
    if Uuid::parse_str(source_instance).is_err() {
        return Err(ReturnActionRejection::UnsupportedConnector);
    }
    for source in [ReturnSource::Codex, ReturnSource::ClaudeCode] {
        let Some(instance_suffix) = connector_id.strip_prefix(source.connector_prefix()) else {
            continue;
        };
        if Uuid::parse_str(instance_suffix).is_ok() {
            return Ok(source);
        }
    }
    Err(ReturnActionRejection::UnsupportedConnector)
}

fn normalize_opaque_task_target(target: &str) -> Result<String, ReturnActionRejection> {
    if target.is_empty()
        || target.len() > MAX_OPAQUE_TARGET_BYTES
        || target.trim() != target
        || !target
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_'))
    {
        return Err(ReturnActionRejection::InvalidTarget);
    }
    Ok(target.to_owned())
}

fn audit_target_digest(connector_id: &str, action_id: &str, target: &[u8]) -> String {
    let mut hasher = Sha256::new();
    hasher.update(b"yuanyuan-return-action-v1\0");
    for value in [connector_id.as_bytes(), action_id.as_bytes(), target] {
        hasher.update((value.len() as u32).to_be_bytes());
        hasher.update(value);
    }
    hasher.finalize()[..8]
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect()
}

fn fallback(pending: PendingCapability, reason: ReturnActionFallbackReason) -> ReturnActionClick {
    ReturnActionClick::OpenTaskWatchFallback {
        source: pending.source,
        task_digest: pending.task_digest,
        target_digest: pending.target_digest,
        reason,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const NOW: i64 = 1_775_212_800_000;
    const INSTANCE: &str = "00000000-0000-4000-8000-000000000010";
    const TASK_DIGEST: [u8; 16] = [7; 16];

    fn context(source: ReturnSource) -> ReturnActionContext<'static> {
        match source {
            ReturnSource::Codex => ReturnActionContext {
                connector_id: "builtin.codex.00000000-0000-4000-8000-000000000010",
                source_instance: INSTANCE,
                protocol_source: "openai.codex",
                task_digest: TASK_DIGEST,
            },
            ReturnSource::ClaudeCode => ReturnActionContext {
                connector_id: "builtin.claude-code.00000000-0000-4000-8000-000000000010",
                source_instance: INSTANCE,
                protocol_source: "anthropic.claude-code",
                task_digest: TASK_DIGEST,
            },
        }
    }

    fn action(target: &str) -> ReturnAction {
        ReturnAction {
            action_id: ACTION_OPEN_TASK.to_owned(),
            target: Some(target.to_owned()),
        }
    }

    #[test]
    fn registered_connectors_receive_only_an_opaque_short_lived_capability() {
        for source in [ReturnSource::Codex, ReturnSource::ClaudeCode] {
            let mut gate = ReturnActionGate::default();
            let capability = gate
                .prepare(
                    &ReturnActionRegistry::default(),
                    context(source),
                    &action("task_01HX9ZQ2"),
                    NOW,
                )
                .unwrap();

            assert_eq!(capability.source, source);
            assert_eq!(capability.expires_at_unix_ms, NOW + CAPABILITY_TTL_MS);
            assert!(!capability.token.contains("task_01HX9ZQ2"));
            assert_eq!(gate.pending.len(), 1);
        }
    }

    #[test]
    fn files_uris_commands_scripts_and_noncanonical_targets_are_rejected() {
        let invalid = [
            "file://secret",
            "shell:AppsFolder\\tool",
            "cmd.exe /c calc",
            "powershell.exe",
            "../task",
            "C:\\secret.txt",
            "\\\\server\\share",
            "task/id",
            " task",
            "task ",
            "task\0id",
            "任务一",
        ];
        for target in invalid {
            let rejection = ReturnActionRegistry::default()
                .validate(context(ReturnSource::Codex), &action(target))
                .unwrap_err();
            assert_eq!(
                rejection,
                ReturnActionRejection::InvalidTarget,
                "{target:?}"
            );
        }
    }

    #[test]
    fn connector_identity_source_and_action_must_all_match_the_registry() {
        let registry = ReturnActionRegistry::default();
        let legacy = ReturnActionContext {
            connector_id: "builtin.codex",
            ..context(ReturnSource::Codex)
        };
        assert_eq!(
            registry.validate(legacy, &action("task_1")).unwrap_err(),
            ReturnActionRejection::UnsupportedConnector
        );

        let mismatch = ReturnActionContext {
            protocol_source: "anthropic.claude-code",
            ..context(ReturnSource::Codex)
        };
        assert_eq!(
            registry.validate(mismatch, &action("task_1")).unwrap_err(),
            ReturnActionRejection::ConnectorSourceMismatch
        );

        let unknown = ReturnAction {
            action_id: "open.uri".to_owned(),
            target: Some("task_1".to_owned()),
        };
        assert_eq!(
            registry
                .validate(context(ReturnSource::Codex), &unknown)
                .unwrap_err(),
            ReturnActionRejection::UnregisteredAction
        );
    }

    #[test]
    fn click_consumes_the_token_and_uses_the_safe_internal_fallback() {
        let mut gate = ReturnActionGate::default();
        let registry = ReturnActionRegistry::default();
        let capability = gate
            .prepare(
                &registry,
                context(ReturnSource::Codex),
                &action("task_1"),
                NOW,
            )
            .unwrap();

        assert!(matches!(
            gate.consume(&registry, &capability.token, NOW + 1),
            ReturnActionClick::OpenTaskWatchFallback {
                reason: ReturnActionFallbackReason::SourceHandlerUnavailable,
                ..
            }
        ));
        assert_eq!(
            gate.consume(&registry, &capability.token, NOW + 2),
            ReturnActionClick::NoAction
        );
    }

    #[test]
    fn expired_or_revoked_capabilities_fail_closed_to_the_task_watch() {
        let registry = ReturnActionRegistry::default();
        let mut expired_gate = ReturnActionGate::default();
        let expired = expired_gate
            .prepare(
                &registry,
                context(ReturnSource::ClaudeCode),
                &action("session_1"),
                NOW,
            )
            .unwrap();
        assert!(matches!(
            expired_gate.consume(&registry, &expired.token, NOW + CAPABILITY_TTL_MS),
            ReturnActionClick::OpenTaskWatchFallback {
                reason: ReturnActionFallbackReason::CapabilityExpired,
                ..
            }
        ));

        let mut revoked_gate = ReturnActionGate::default();
        let revoked = revoked_gate
            .prepare(
                &registry,
                context(ReturnSource::Codex),
                &action("task_1"),
                NOW,
            )
            .unwrap();
        assert!(matches!(
            revoked_gate.consume(&ReturnActionRegistry::empty(), &revoked.token, NOW + 1),
            ReturnActionClick::OpenTaskWatchFallback {
                reason: ReturnActionFallbackReason::RegistryChanged,
                ..
            }
        ));
    }

    #[test]
    fn a_tampered_pending_target_is_caught_by_click_time_validation() {
        let registry = ReturnActionRegistry::default();
        let mut gate = ReturnActionGate::default();
        let capability = gate
            .prepare(
                &registry,
                context(ReturnSource::Codex),
                &action("task_1"),
                NOW,
            )
            .unwrap();
        gate.pending
            .get_mut(&capability.token)
            .unwrap()
            .action
            .target = Some("file://secret".to_owned());

        assert!(matches!(
            gate.consume(&registry, &capability.token, NOW + 1),
            ReturnActionClick::OpenTaskWatchFallback {
                reason: ReturnActionFallbackReason::RegistryChanged,
                ..
            }
        ));
    }

    #[test]
    fn the_gate_is_bounded_and_drops_expired_entries_before_issuing_more() {
        let registry = ReturnActionRegistry::default();
        let mut gate = ReturnActionGate::default();
        for index in 0..MAX_PENDING_CAPABILITIES {
            gate.prepare(
                &registry,
                context(ReturnSource::Codex),
                &action(&format!("task_{index}")),
                NOW,
            )
            .unwrap();
        }
        assert_eq!(
            gate.prepare(
                &registry,
                context(ReturnSource::Codex),
                &action("one_too_many"),
                NOW,
            )
            .unwrap_err(),
            ReturnActionRejection::CapacityReached
        );
        gate.prepare(
            &registry,
            context(ReturnSource::Codex),
            &action("after_expiry"),
            NOW + CAPABILITY_TTL_MS,
        )
        .unwrap();
        assert_eq!(gate.pending.len(), 1);
    }
}
