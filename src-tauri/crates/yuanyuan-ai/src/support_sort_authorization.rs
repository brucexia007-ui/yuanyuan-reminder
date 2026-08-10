use std::{collections::HashMap, fmt};

use serde::Serialize;
use thiserror::Error;
use uuid::Uuid;
use zeroize::Zeroize;

pub const SUPPORT_SORT_DISCLOSURE_VERSION: u16 = 1;
const AUTHORIZATION_SCHEMA_VERSION: u16 = 1;
const AUTHORIZATION_TTL_MS: i64 = 5 * 60 * 1_000;
const MAX_PENDING_AUTHORIZATIONS: usize = 64;
const MAX_PROVIDER_KEY_BYTES: usize = 64;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum SupportSortDestination {
    LocalProvider,
    CloudProvider,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum SupportSortPurpose {
    StructureFactFeelingControlNextStep,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum SupportSortContentClass {
    UserEnteredText,
}

#[derive(Clone, Copy)]
pub struct SupportSortProviderContext<'a> {
    pub destination: SupportSortDestination,
    pub provider_key: &'a str,
    pub provider_fingerprint: &'a str,
    pub disclosure_version: u16,
}

/// Host-owned provider identity used to bind authorization to the adapter
/// selected by trusted Rust configuration. Its fields are intentionally
/// private so an IPC caller cannot assemble a partially validated identity.
#[derive(Clone, PartialEq, Eq)]
pub struct SupportSortProviderDescriptor {
    destination: SupportSortDestination,
    provider_key: String,
    provider_fingerprint: String,
    disclosure_version: u16,
}

impl SupportSortProviderDescriptor {
    pub fn try_new(
        provider: SupportSortProviderContext<'_>,
    ) -> Result<Self, SupportSortAuthorizationRejection> {
        let binding = validate_provider(provider)?;
        Ok(Self {
            destination: binding.destination,
            provider_key: binding.provider_key,
            provider_fingerprint: binding.provider_fingerprint,
            disclosure_version: binding.disclosure_version,
        })
    }

    pub fn authorization_context(&self) -> SupportSortProviderContext<'_> {
        SupportSortProviderContext {
            destination: self.destination,
            provider_key: &self.provider_key,
            provider_fingerprint: &self.provider_fingerprint,
            disclosure_version: self.disclosure_version,
        }
    }

    pub fn destination(&self) -> SupportSortDestination {
        self.destination
    }

    pub fn provider_key(&self) -> &str {
        &self.provider_key
    }

    pub fn provider_fingerprint(&self) -> &str {
        &self.provider_fingerprint
    }
}

#[derive(Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SupportSortAuthorizationCapability {
    pub schema_version: u16,
    pub token: String,
    pub purpose: SupportSortPurpose,
    pub content_classes: [SupportSortContentClass; 1],
    pub destination: SupportSortDestination,
    pub provider_key: String,
    pub provider_fingerprint: String,
    pub disclosure_version: u16,
    pub issued_at_unix_ms: i64,
    pub expires_at_unix_ms: i64,
    pub one_use: bool,
}

impl SupportSortAuthorizationCapability {
    fn zeroize_sensitive(&mut self) {
        self.token.zeroize();
        self.provider_key.zeroize();
        self.provider_fingerprint.zeroize();
    }
}

impl Drop for SupportSortAuthorizationCapability {
    fn drop(&mut self) {
        self.zeroize_sensitive();
    }
}

impl fmt::Debug for SupportSortAuthorizationCapability {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("SupportSortAuthorizationCapability([REDACTED])")
    }
}

#[derive(Clone, PartialEq, Eq)]
pub struct AuthorizedSupportSortCall {
    pub destination: SupportSortDestination,
    pub provider_key: String,
    pub provider_fingerprint: String,
}

impl Drop for AuthorizedSupportSortCall {
    fn drop(&mut self) {
        self.provider_key.zeroize();
        self.provider_fingerprint.zeroize();
    }
}

impl fmt::Debug for AuthorizedSupportSortCall {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("AuthorizedSupportSortCall([REDACTED])")
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Error)]
pub enum SupportSortAuthorizationRejection {
    #[error("support sort provider identity is invalid")]
    InvalidProvider,
    #[error("support sort disclosure version is unsupported")]
    UnsupportedDisclosure,
    #[error("support sort authorization time is invalid")]
    InvalidTime,
    #[error("support sort authorization capacity is reached")]
    CapacityReached,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Error)]
pub enum SupportSortConsumeRejection {
    #[error("support sort authorization is missing or already used")]
    MissingOrUsed,
    #[error("support sort authorization expired")]
    Expired,
    #[error("support sort authorization time is invalid")]
    InvalidTime,
    #[error("support sort provider changed after authorization")]
    ProviderChanged,
}

#[derive(Clone, PartialEq, Eq)]
struct ProviderBinding {
    destination: SupportSortDestination,
    provider_key: String,
    provider_fingerprint: String,
    disclosure_version: u16,
}

impl ProviderBinding {
    fn zeroize_sensitive(&mut self) {
        self.provider_key.zeroize();
        self.provider_fingerprint.zeroize();
    }
}

#[derive(Clone)]
struct PendingAuthorization {
    binding: ProviderBinding,
    issued_at_unix_ms: i64,
    expires_at_unix_ms: i64,
}

impl PendingAuthorization {
    fn zeroize_sensitive(&mut self) {
        self.binding.zeroize_sensitive();
    }
}

/// In-memory one-use authorization gate for the future "sort things out"
/// Provider call. The gate never accepts or stores user text. Process exit
/// revokes every pending token; no database, log, backup or diagnostic sink is
/// involved.
#[derive(Default)]
pub struct SupportSortAuthorizationGate {
    pending: HashMap<String, PendingAuthorization>,
}

impl SupportSortAuthorizationGate {
    pub fn issue(
        &mut self,
        provider: SupportSortProviderContext<'_>,
        now_unix_ms: i64,
    ) -> Result<SupportSortAuthorizationCapability, SupportSortAuthorizationRejection> {
        let expires_at_unix_ms = valid_issue_time(now_unix_ms)?;
        self.discard_expired(now_unix_ms);
        if self.pending.len() >= MAX_PENDING_AUTHORIZATIONS {
            return Err(SupportSortAuthorizationRejection::CapacityReached);
        }
        let binding = validate_provider(provider)?;
        let token = Uuid::new_v4().to_string();
        self.pending.insert(
            token.clone(),
            PendingAuthorization {
                binding: binding.clone(),
                issued_at_unix_ms: now_unix_ms,
                expires_at_unix_ms,
            },
        );
        Ok(SupportSortAuthorizationCapability {
            schema_version: AUTHORIZATION_SCHEMA_VERSION,
            token,
            purpose: SupportSortPurpose::StructureFactFeelingControlNextStep,
            content_classes: [SupportSortContentClass::UserEnteredText],
            destination: binding.destination,
            provider_key: binding.provider_key,
            provider_fingerprint: binding.provider_fingerprint,
            disclosure_version: binding.disclosure_version,
            issued_at_unix_ms: now_unix_ms,
            expires_at_unix_ms,
            one_use: true,
        })
    }

    pub fn consume(
        &mut self,
        token: &str,
        current_provider: SupportSortProviderContext<'_>,
        now_unix_ms: i64,
    ) -> Result<AuthorizedSupportSortCall, SupportSortConsumeRejection> {
        let Some((mut stored_token, mut pending)) = self.pending.remove_entry(token) else {
            return Err(SupportSortConsumeRejection::MissingOrUsed);
        };
        stored_token.zeroize();
        if now_unix_ms < pending.issued_at_unix_ms {
            pending.zeroize_sensitive();
            return Err(SupportSortConsumeRejection::InvalidTime);
        }
        if now_unix_ms >= pending.expires_at_unix_ms {
            pending.zeroize_sensitive();
            return Err(SupportSortConsumeRejection::Expired);
        }
        let Ok(mut current_binding) = validate_provider(current_provider) else {
            pending.zeroize_sensitive();
            return Err(SupportSortConsumeRejection::ProviderChanged);
        };
        if current_binding != pending.binding {
            current_binding.zeroize_sensitive();
            pending.zeroize_sensitive();
            return Err(SupportSortConsumeRejection::ProviderChanged);
        }
        current_binding.zeroize_sensitive();
        Ok(AuthorizedSupportSortCall {
            destination: pending.binding.destination,
            provider_key: std::mem::take(&mut pending.binding.provider_key),
            provider_fingerprint: std::mem::take(&mut pending.binding.provider_fingerprint),
        })
    }

    pub fn cancel(&mut self, token: &str) -> bool {
        let Some((mut stored_token, mut pending)) = self.pending.remove_entry(token) else {
            return false;
        };
        stored_token.zeroize();
        pending.zeroize_sensitive();
        true
    }

    pub fn revoke_all(&mut self) {
        for (mut token, mut pending) in std::mem::take(&mut self.pending) {
            token.zeroize();
            pending.zeroize_sensitive();
        }
    }

    fn discard_expired(&mut self, now_unix_ms: i64) {
        let pending = std::mem::take(&mut self.pending);
        for (mut token, mut authorization) in pending {
            if authorization.expires_at_unix_ms > now_unix_ms {
                self.pending.insert(token, authorization);
            } else {
                token.zeroize();
                authorization.zeroize_sensitive();
            }
        }
    }

    #[cfg(test)]
    fn pending_count(&self) -> usize {
        self.pending.len()
    }
}

impl Drop for SupportSortAuthorizationGate {
    fn drop(&mut self) {
        self.revoke_all();
    }
}

fn valid_issue_time(now_unix_ms: i64) -> Result<i64, SupportSortAuthorizationRejection> {
    if now_unix_ms < 0 {
        return Err(SupportSortAuthorizationRejection::InvalidTime);
    }
    now_unix_ms
        .checked_add(AUTHORIZATION_TTL_MS)
        .ok_or(SupportSortAuthorizationRejection::InvalidTime)
}

fn validate_provider(
    provider: SupportSortProviderContext<'_>,
) -> Result<ProviderBinding, SupportSortAuthorizationRejection> {
    if provider.disclosure_version != SUPPORT_SORT_DISCLOSURE_VERSION {
        return Err(SupportSortAuthorizationRejection::UnsupportedDisclosure);
    }
    if provider.provider_key.is_empty()
        || provider.provider_key.len() > MAX_PROVIDER_KEY_BYTES
        || !provider.provider_key.bytes().all(|byte| {
            byte.is_ascii_lowercase() || byte.is_ascii_digit() || matches!(byte, b'.' | b'_' | b'-')
        })
        || provider.provider_key.starts_with(['.', '_', '-'])
    {
        return Err(SupportSortAuthorizationRejection::InvalidProvider);
    }
    if provider.provider_fingerprint.len() != 64
        || !provider
            .provider_fingerprint
            .bytes()
            .all(|byte| byte.is_ascii_digit() || matches!(byte, b'A'..=b'F'))
    {
        return Err(SupportSortAuthorizationRejection::InvalidProvider);
    }
    Ok(ProviderBinding {
        destination: provider.destination,
        provider_key: provider.provider_key.to_owned(),
        provider_fingerprint: provider.provider_fingerprint.to_owned(),
        disclosure_version: provider.disclosure_version,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    const NOW: i64 = 1_775_212_800_000;
    const LOCAL_FINGERPRINT: &str =
        "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
    const CLOUD_FINGERPRINT: &str =
        "BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB";

    fn local_provider() -> SupportSortProviderContext<'static> {
        SupportSortProviderContext {
            destination: SupportSortDestination::LocalProvider,
            provider_key: "local-provider",
            provider_fingerprint: LOCAL_FINGERPRINT,
            disclosure_version: SUPPORT_SORT_DISCLOSURE_VERSION,
        }
    }

    fn cloud_provider() -> SupportSortProviderContext<'static> {
        SupportSortProviderContext {
            destination: SupportSortDestination::CloudProvider,
            provider_key: "cloud-provider",
            provider_fingerprint: CLOUD_FINGERPRINT,
            disclosure_version: SUPPORT_SORT_DISCLOSURE_VERSION,
        }
    }

    #[test]
    fn capability_is_short_lived_opaque_and_contains_only_fixed_data_classes() {
        let mut gate = SupportSortAuthorizationGate::default();
        let capability = gate.issue(local_provider(), NOW).unwrap();

        assert_eq!(capability.schema_version, 1);
        assert_eq!(
            capability.purpose,
            SupportSortPurpose::StructureFactFeelingControlNextStep
        );
        assert_eq!(
            capability.content_classes,
            [SupportSortContentClass::UserEnteredText]
        );
        assert_eq!(capability.expires_at_unix_ms, NOW + AUTHORIZATION_TTL_MS);
        assert!(capability.one_use);
        assert!(!capability.token.contains("local-provider"));
        assert_eq!(gate.pending_count(), 1);
    }

    #[test]
    fn successful_consume_is_one_use_and_bound_to_the_current_provider() {
        let mut gate = SupportSortAuthorizationGate::default();
        let capability = gate.issue(local_provider(), NOW).unwrap();

        let call = gate
            .consume(&capability.token, local_provider(), NOW + 1)
            .unwrap();
        assert_eq!(call.destination, SupportSortDestination::LocalProvider);
        assert_eq!(call.provider_key, "local-provider");
        assert_eq!(
            gate.consume(&capability.token, local_provider(), NOW + 2),
            Err(SupportSortConsumeRejection::MissingOrUsed)
        );
    }

    #[test]
    fn expiry_consumes_the_token_without_authorizing_a_call() {
        let mut gate = SupportSortAuthorizationGate::default();
        let capability = gate.issue(cloud_provider(), NOW).unwrap();
        assert_eq!(
            gate.consume(
                &capability.token,
                cloud_provider(),
                NOW + AUTHORIZATION_TTL_MS
            ),
            Err(SupportSortConsumeRejection::Expired)
        );
        assert_eq!(
            gate.consume(&capability.token, cloud_provider(), NOW + 1),
            Err(SupportSortConsumeRejection::MissingOrUsed)
        );
    }

    #[test]
    fn clock_rollback_consumes_the_token_without_authorizing_a_call() {
        let mut gate = SupportSortAuthorizationGate::default();
        let capability = gate.issue(local_provider(), NOW).unwrap();
        assert_eq!(
            gate.consume(&capability.token, local_provider(), NOW - 1),
            Err(SupportSortConsumeRejection::InvalidTime)
        );
        assert_eq!(
            gate.consume(&capability.token, local_provider(), NOW + 1),
            Err(SupportSortConsumeRejection::MissingOrUsed)
        );
    }

    #[test]
    fn destination_identity_fingerprint_and_disclosure_changes_fail_closed() {
        let changed = [
            cloud_provider(),
            SupportSortProviderContext {
                provider_key: "other-provider",
                ..local_provider()
            },
            SupportSortProviderContext {
                provider_fingerprint: CLOUD_FINGERPRINT,
                ..local_provider()
            },
            SupportSortProviderContext {
                disclosure_version: SUPPORT_SORT_DISCLOSURE_VERSION + 1,
                ..local_provider()
            },
        ];
        for current in changed {
            let mut gate = SupportSortAuthorizationGate::default();
            let capability = gate.issue(local_provider(), NOW).unwrap();
            assert_eq!(
                gate.consume(&capability.token, current, NOW + 1),
                Err(SupportSortConsumeRejection::ProviderChanged)
            );
            assert_eq!(gate.pending_count(), 0);
        }
    }

    #[test]
    fn cancel_and_process_wide_revoke_remove_authority_without_a_call() {
        let mut gate = SupportSortAuthorizationGate::default();
        let first = gate.issue(local_provider(), NOW).unwrap();
        let second = gate.issue(cloud_provider(), NOW).unwrap();
        assert!(gate.cancel(&first.token));
        assert!(!gate.cancel(&first.token));
        assert_eq!(gate.pending_count(), 1);
        gate.revoke_all();
        assert_eq!(gate.pending_count(), 0);
        assert_eq!(
            gate.consume(&second.token, cloud_provider(), NOW + 1),
            Err(SupportSortConsumeRejection::MissingOrUsed)
        );
    }

    #[test]
    fn invalid_provider_disclosure_and_time_are_rejected_before_issuing() {
        let invalid = [
            SupportSortProviderContext {
                provider_key: "../provider",
                ..local_provider()
            },
            SupportSortProviderContext {
                provider_key: "UPPERCASE",
                ..local_provider()
            },
            SupportSortProviderContext {
                provider_fingerprint: "unknown",
                ..local_provider()
            },
        ];
        for provider in invalid {
            let mut gate = SupportSortAuthorizationGate::default();
            assert_eq!(
                gate.issue(provider, NOW),
                Err(SupportSortAuthorizationRejection::InvalidProvider)
            );
            assert_eq!(gate.pending_count(), 0);
        }

        let mut disclosure = SupportSortAuthorizationGate::default();
        assert_eq!(
            disclosure.issue(
                SupportSortProviderContext {
                    disclosure_version: 2,
                    ..local_provider()
                },
                NOW
            ),
            Err(SupportSortAuthorizationRejection::UnsupportedDisclosure)
        );
        assert_eq!(
            disclosure.issue(local_provider(), -1),
            Err(SupportSortAuthorizationRejection::InvalidTime)
        );
        assert_eq!(
            disclosure.issue(local_provider(), i64::MAX),
            Err(SupportSortAuthorizationRejection::InvalidTime)
        );
    }

    #[test]
    fn gate_is_bounded_and_prunes_expired_authorizations_before_issuing() {
        let mut gate = SupportSortAuthorizationGate::default();
        for _ in 0..MAX_PENDING_AUTHORIZATIONS {
            gate.issue(local_provider(), NOW).unwrap();
        }
        assert_eq!(
            gate.issue(local_provider(), NOW),
            Err(SupportSortAuthorizationRejection::CapacityReached)
        );
        gate.issue(local_provider(), NOW + AUTHORIZATION_TTL_MS)
            .unwrap();
        assert_eq!(gate.pending_count(), 1);
    }

    #[test]
    fn serialized_capability_has_no_user_content_or_workspace_field() {
        let mut gate = SupportSortAuthorizationGate::default();
        let capability = gate.issue(cloud_provider(), NOW).unwrap();
        let serialized = serde_json::to_value(capability).unwrap();
        let object = serialized.as_object().unwrap();
        assert_eq!(
            object.keys().map(String::as_str).collect::<Vec<_>>(),
            vec![
                "contentClasses",
                "destination",
                "disclosureVersion",
                "expiresAtUnixMs",
                "issuedAtUnixMs",
                "oneUse",
                "providerFingerprint",
                "providerKey",
                "purpose",
                "schemaVersion",
                "token",
            ]
        );
        let text = serde_json::to_string(object).unwrap();
        for forbidden in [
            "userText",
            "result",
            "emotion",
            "taskId",
            "workspace",
            "history",
        ] {
            assert!(!text.contains(forbidden));
        }
    }

    #[test]
    fn authorization_debug_is_redacted_and_sensitive_fields_are_clearable() {
        let mut gate = SupportSortAuthorizationGate::default();
        let mut capability = gate.issue(local_provider(), NOW).unwrap();
        let debug = format!("{capability:?}");
        assert_eq!(debug, "SupportSortAuthorizationCapability([REDACTED])");
        assert!(!debug.contains(&capability.token));
        assert!(!debug.contains(&capability.provider_key));
        assert!(!debug.contains(&capability.provider_fingerprint));

        capability.zeroize_sensitive();
        assert!(capability.token.is_empty());
        assert!(capability.provider_key.is_empty());
        assert!(capability.provider_fingerprint.is_empty());
        gate.revoke_all();
        assert_eq!(gate.pending_count(), 0);
    }
}
