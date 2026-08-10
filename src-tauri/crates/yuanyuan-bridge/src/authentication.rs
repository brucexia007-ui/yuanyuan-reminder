use std::{fmt, time::Duration};

use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine as _};
use hmac::{Hmac, Mac};
use serde::{Deserialize, Serialize};
use sha2::Sha256;
use thiserror::Error;
use yuanyuan_protocol::{ProtocolValidationError, TaskEventEnvelope};
use zeroize::Zeroizing;

use crate::MAX_BRIDGE_INPUT_BYTES;

pub const AUTHENTICATION_VERSION: u16 = 1;
pub const AUTH_NONCE_BYTES: usize = 16;
pub const MAX_CLOCK_SKEW: Duration = Duration::from_secs(5 * 60);

const MIN_AUTHENTICATION_KEY_BYTES: usize = 32;
const MAX_KEY_ID_BYTES: usize = 64;
const ENCODED_NONCE_BYTES: usize = 22;
const ENCODED_MAC_BYTES: usize = 43;

type HmacSha256 = Hmac<Sha256>;

#[derive(Clone, Serialize, Deserialize, PartialEq)]
pub struct AuthenticatedTaskEvent {
    pub auth: EventAuthenticationV1,
    #[serde(flatten)]
    pub envelope: TaskEventEnvelope,
}

impl fmt::Debug for AuthenticatedTaskEvent {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("AuthenticatedTaskEvent")
            .field("auth_version", &self.auth.auth_version)
            .field("key_id", &self.auth.key_id)
            .field("signed_at_unix_ms", &self.auth.signed_at_unix_ms)
            .field("event_id", &self.envelope.event.event_id)
            .finish_non_exhaustive()
    }
}

#[derive(Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct EventAuthenticationV1 {
    pub auth_version: u16,
    pub key_id: String,
    pub nonce: String,
    pub signed_at_unix_ms: i64,
    pub mac: String,
}

impl fmt::Debug for EventAuthenticationV1 {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("EventAuthenticationV1")
            .field("auth_version", &self.auth_version)
            .field("key_id", &self.key_id)
            .field("signed_at_unix_ms", &self.signed_at_unix_ms)
            .field("nonce", &"[redacted]")
            .field("mac", &"[redacted]")
            .finish()
    }
}

pub struct AuthenticationKey(Zeroizing<Vec<u8>>);

impl AuthenticationKey {
    pub fn new(bytes: impl Into<Vec<u8>>) -> Result<Self, AuthenticationError> {
        let bytes = Zeroizing::new(bytes.into());
        if bytes.len() < MIN_AUTHENTICATION_KEY_BYTES {
            return Err(AuthenticationError::WeakKey);
        }
        Ok(Self(bytes))
    }

    fn expose(&self) -> &[u8] {
        self.0.as_slice()
    }
}

impl fmt::Debug for AuthenticationKey {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("AuthenticationKey([redacted])")
    }
}

pub trait AuthenticationKeyResolver {
    fn resolve(&self, key_id: &str) -> Result<AuthenticationKey, KeyResolutionError>;

    fn resolve_for(
        &self,
        key_id: &str,
        _connector_id: &str,
        _source_instance: &str,
        _signed_at_unix_ms: i64,
        _now_unix_ms: i64,
    ) -> Result<AuthenticationKey, KeyResolutionError> {
        self.resolve(key_id)
    }
}

#[derive(Debug, Clone, Copy, Error, PartialEq, Eq)]
pub enum KeyResolutionError {
    #[error("authentication key is unknown or revoked")]
    UnknownOrRevoked,
    #[error("authentication key storage is unavailable")]
    Unavailable,
}

pub trait NonceStore {
    fn record_if_new(
        &self,
        key_id: &str,
        nonce: &[u8],
        expires_at_unix_ms: i64,
        now_unix_ms: i64,
    ) -> Result<bool, NonceStoreError>;
}

#[derive(Debug, Clone, Copy, Error, PartialEq, Eq)]
pub enum NonceStoreError {
    #[error("nonce storage is unavailable")]
    Unavailable,
}

#[derive(Debug, Error)]
pub enum AuthenticationError {
    #[error("authenticated bridge input exceeds the byte limit")]
    InputTooLarge,
    #[error("authenticated bridge input is not valid JSON")]
    InvalidJson(#[source] serde_json::Error),
    #[error("unsupported authentication version")]
    UnsupportedVersion,
    #[error("authentication key id is invalid")]
    InvalidKeyId,
    #[error("authentication nonce is invalid")]
    InvalidNonce,
    #[error("authentication timestamp is outside the accepted window")]
    ClockSkew,
    #[error("authentication key is unknown or revoked")]
    UnknownOrRevokedKey,
    #[error("authentication key storage is unavailable")]
    KeyStoreUnavailable,
    #[error("authentication key does not meet the minimum strength")]
    WeakKey,
    #[error("message authentication code is invalid")]
    InvalidMac,
    #[error("authenticated task event is invalid")]
    InvalidProtocol(#[from] ProtocolValidationError),
    #[error("authenticated event nonce was already used")]
    Replay,
    #[error("nonce storage is unavailable")]
    NonceStoreUnavailable,
    #[error("authenticated bridge input could not be encoded")]
    Encoding,
}

pub fn seal_event(
    envelope: TaskEventEnvelope,
    key_id: &str,
    nonce: [u8; AUTH_NONCE_BYTES],
    signed_at_unix_ms: i64,
    key: &AuthenticationKey,
) -> Result<AuthenticatedTaskEvent, AuthenticationError> {
    validate_key_id(key_id)?;
    let event_message = envelope.authentication_message()?;
    let mac = calculate_mac(key, key_id, &nonce, signed_at_unix_ms, &event_message)?;

    Ok(AuthenticatedTaskEvent {
        auth: EventAuthenticationV1 {
            auth_version: AUTHENTICATION_VERSION,
            key_id: key_id.to_owned(),
            nonce: URL_SAFE_NO_PAD.encode(nonce),
            signed_at_unix_ms,
            mac: URL_SAFE_NO_PAD.encode(mac),
        },
        envelope,
    })
}

pub fn verify_authenticated_input<K: AuthenticationKeyResolver, N: NonceStore>(
    input: &[u8],
    keys: &K,
    nonces: &N,
    now_unix_ms: i64,
) -> Result<TaskEventEnvelope, AuthenticationError> {
    let verified = verify_signature(input, keys, now_unix_ms)?;
    match nonces.record_if_new(
        &verified.key_id,
        &verified.nonce,
        verified.expires_at_unix_ms,
        now_unix_ms,
    ) {
        Ok(true) => Ok(verified.envelope),
        Ok(false) => Err(AuthenticationError::Replay),
        Err(NonceStoreError::Unavailable) => Err(AuthenticationError::NonceStoreUnavailable),
    }
}

/// Verifies structure, protocol, timestamp and HMAC without consuming the
/// replay nonce. This is only for authenticated disk staging before the final
/// receiver atomically records the nonce.
pub fn verify_authenticated_signature<K: AuthenticationKeyResolver>(
    input: &[u8],
    keys: &K,
    now_unix_ms: i64,
) -> Result<TaskEventEnvelope, AuthenticationError> {
    Ok(verify_authenticated_signature_with_metadata(input, keys, now_unix_ms)?.envelope)
}

#[derive(Debug, Clone, PartialEq)]
pub struct VerifiedAuthenticatedEvent {
    pub envelope: TaskEventEnvelope,
    pub key_id: String,
    pub nonce: Vec<u8>,
    pub expires_at_unix_ms: i64,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AuthenticationClaims {
    pub connector_id: String,
    pub source_instance: String,
    pub key_id: String,
    pub signed_at_unix_ms: i64,
}

/// Extracts only bounded identity metadata after validating the complete
/// envelope shape, timestamp and authentication field encodings. It does not
/// establish authenticity and must never authorize an action by itself.
pub fn inspect_authentication_claims(
    input: &[u8],
    now_unix_ms: i64,
) -> Result<AuthenticationClaims, AuthenticationError> {
    if input.len() > MAX_BRIDGE_INPUT_BYTES {
        return Err(AuthenticationError::InputTooLarge);
    }
    let authenticated: AuthenticatedTaskEvent =
        serde_json::from_slice(input).map_err(AuthenticationError::InvalidJson)?;
    if authenticated.auth.auth_version != AUTHENTICATION_VERSION {
        return Err(AuthenticationError::UnsupportedVersion);
    }
    validate_key_id(&authenticated.auth.key_id)?;
    validate_timestamp(authenticated.auth.signed_at_unix_ms, now_unix_ms)?;
    let nonce = URL_SAFE_NO_PAD
        .decode(&authenticated.auth.nonce)
        .map_err(|_| AuthenticationError::InvalidNonce)?;
    if authenticated.auth.nonce.len() != ENCODED_NONCE_BYTES || nonce.len() != AUTH_NONCE_BYTES {
        return Err(AuthenticationError::InvalidNonce);
    }
    if authenticated.auth.mac.len() != ENCODED_MAC_BYTES
        || URL_SAFE_NO_PAD.decode(&authenticated.auth.mac).is_err()
    {
        return Err(AuthenticationError::InvalidMac);
    }
    authenticated.envelope.authentication_message()?;
    Ok(AuthenticationClaims {
        connector_id: authenticated.envelope.event.connector_id,
        source_instance: authenticated.envelope.event.source_instance,
        key_id: authenticated.auth.key_id,
        signed_at_unix_ms: authenticated.auth.signed_at_unix_ms,
    })
}

/// Verifies the signed envelope without mutating replay state and returns the
/// metadata needed by the final receiver's single SQLite transaction.
pub fn verify_authenticated_signature_with_metadata<K: AuthenticationKeyResolver>(
    input: &[u8],
    keys: &K,
    now_unix_ms: i64,
) -> Result<VerifiedAuthenticatedEvent, AuthenticationError> {
    verify_signature(input, keys, now_unix_ms)
}

fn verify_signature<K: AuthenticationKeyResolver>(
    input: &[u8],
    keys: &K,
    now_unix_ms: i64,
) -> Result<VerifiedAuthenticatedEvent, AuthenticationError> {
    if input.len() > MAX_BRIDGE_INPUT_BYTES {
        return Err(AuthenticationError::InputTooLarge);
    }
    let authenticated: AuthenticatedTaskEvent =
        serde_json::from_slice(input).map_err(AuthenticationError::InvalidJson)?;
    if authenticated.auth.auth_version != AUTHENTICATION_VERSION {
        return Err(AuthenticationError::UnsupportedVersion);
    }
    validate_key_id(&authenticated.auth.key_id)?;
    validate_timestamp(authenticated.auth.signed_at_unix_ms, now_unix_ms)?;

    if authenticated.auth.nonce.len() != ENCODED_NONCE_BYTES {
        return Err(AuthenticationError::InvalidNonce);
    }
    let nonce = URL_SAFE_NO_PAD
        .decode(&authenticated.auth.nonce)
        .map_err(|_| AuthenticationError::InvalidNonce)?;
    if nonce.len() != AUTH_NONCE_BYTES {
        return Err(AuthenticationError::InvalidNonce);
    }
    if authenticated.auth.mac.len() != ENCODED_MAC_BYTES {
        return Err(AuthenticationError::InvalidMac);
    }
    let supplied_mac = URL_SAFE_NO_PAD
        .decode(&authenticated.auth.mac)
        .map_err(|_| AuthenticationError::InvalidMac)?;

    let event_message = authenticated.envelope.authentication_message()?;
    let key = keys
        .resolve_for(
            &authenticated.auth.key_id,
            &authenticated.envelope.event.connector_id,
            &authenticated.envelope.event.source_instance,
            authenticated.auth.signed_at_unix_ms,
            now_unix_ms,
        )
        .map_err(|error| match error {
            KeyResolutionError::UnknownOrRevoked => AuthenticationError::UnknownOrRevokedKey,
            KeyResolutionError::Unavailable => AuthenticationError::KeyStoreUnavailable,
        })?;
    verify_mac(
        &key,
        &authenticated.auth.key_id,
        &nonce,
        authenticated.auth.signed_at_unix_ms,
        &event_message,
        &supplied_mac,
    )?;

    let expires_at_unix_ms = authenticated
        .auth
        .signed_at_unix_ms
        .saturating_add(MAX_CLOCK_SKEW.as_millis() as i64);
    Ok(VerifiedAuthenticatedEvent {
        envelope: authenticated.envelope,
        key_id: authenticated.auth.key_id,
        nonce,
        expires_at_unix_ms,
    })
}

fn validate_key_id(key_id: &str) -> Result<(), AuthenticationError> {
    let valid = !key_id.is_empty()
        && key_id.len() <= MAX_KEY_ID_BYTES
        && key_id.bytes().all(|byte| {
            byte.is_ascii_lowercase() || byte.is_ascii_digit() || b"._-".contains(&byte)
        });
    if valid {
        Ok(())
    } else {
        Err(AuthenticationError::InvalidKeyId)
    }
}

fn validate_timestamp(signed_at: i64, now: i64) -> Result<(), AuthenticationError> {
    let skew = MAX_CLOCK_SKEW.as_millis() as i64;
    if signed_at < now.saturating_sub(skew) || signed_at > now.saturating_add(skew) {
        Err(AuthenticationError::ClockSkew)
    } else {
        Ok(())
    }
}

fn calculate_mac(
    key: &AuthenticationKey,
    key_id: &str,
    nonce: &[u8],
    signed_at: i64,
    event_message: &[u8],
) -> Result<[u8; 32], AuthenticationError> {
    let mut mac =
        HmacSha256::new_from_slice(key.expose()).map_err(|_| AuthenticationError::WeakKey)?;
    update_mac(&mut mac, key_id, nonce, signed_at, event_message);
    Ok(mac.finalize().into_bytes().into())
}

fn verify_mac(
    key: &AuthenticationKey,
    key_id: &str,
    nonce: &[u8],
    signed_at: i64,
    event_message: &[u8],
    supplied_mac: &[u8],
) -> Result<(), AuthenticationError> {
    let mut mac =
        HmacSha256::new_from_slice(key.expose()).map_err(|_| AuthenticationError::WeakKey)?;
    update_mac(&mut mac, key_id, nonce, signed_at, event_message);
    mac.verify_slice(supplied_mac)
        .map_err(|_| AuthenticationError::InvalidMac)
}

fn update_mac(
    mac: &mut HmacSha256,
    key_id: &str,
    nonce: &[u8],
    signed_at: i64,
    event_message: &[u8],
) {
    mac.update(b"yuanyuan.bridge.authentication.v1\0");
    mac.update(&AUTHENTICATION_VERSION.to_be_bytes());
    mac.update(&(key_id.len() as u16).to_be_bytes());
    mac.update(key_id.as_bytes());
    mac.update(&(nonce.len() as u16).to_be_bytes());
    mac.update(nonce);
    mac.update(&signed_at.to_be_bytes());
    mac.update(&(event_message.len() as u32).to_be_bytes());
    mac.update(event_message);
}

#[cfg(test)]
mod tests {
    use std::{collections::HashSet, sync::Mutex};

    use yuanyuan_protocol::{
        EventFinality, EvidenceLevel, EvidenceType, TaskEventV1, TaskState,
        TASK_EVENT_PROTOCOL_VERSION,
    };

    use super::*;

    const NOW: i64 = 1_775_212_800_000;
    const KEY_ID: &str = "codex.installation-1";
    const KEY_BYTES: [u8; 32] = [0x42; 32];

    struct TestKeys;

    impl AuthenticationKeyResolver for TestKeys {
        fn resolve(&self, key_id: &str) -> Result<AuthenticationKey, KeyResolutionError> {
            if key_id == KEY_ID {
                AuthenticationKey::new(KEY_BYTES).map_err(|_| KeyResolutionError::Unavailable)
            } else {
                Err(KeyResolutionError::UnknownOrRevoked)
            }
        }
    }

    struct TimestampPolicyKeys;

    impl AuthenticationKeyResolver for TimestampPolicyKeys {
        fn resolve(&self, _key_id: &str) -> Result<AuthenticationKey, KeyResolutionError> {
            Err(KeyResolutionError::UnknownOrRevoked)
        }

        fn resolve_for(
            &self,
            key_id: &str,
            connector_id: &str,
            source_instance: &str,
            signed_at_unix_ms: i64,
            now_unix_ms: i64,
        ) -> Result<AuthenticationKey, KeyResolutionError> {
            if key_id == KEY_ID
                && connector_id == "connector-auth-1"
                && source_instance == "codex-install-1"
                && signed_at_unix_ms == NOW
                && now_unix_ms == NOW
            {
                AuthenticationKey::new(KEY_BYTES).map_err(|_| KeyResolutionError::Unavailable)
            } else {
                Err(KeyResolutionError::UnknownOrRevoked)
            }
        }
    }

    #[derive(Default)]
    struct TestNonces(Mutex<HashSet<(String, Vec<u8>)>>);

    impl NonceStore for TestNonces {
        fn record_if_new(
            &self,
            key_id: &str,
            nonce: &[u8],
            _expires_at_unix_ms: i64,
            _now_unix_ms: i64,
        ) -> Result<bool, NonceStoreError> {
            Ok(self
                .0
                .lock()
                .unwrap()
                .insert((key_id.to_owned(), nonce.to_vec())))
        }
    }

    fn event() -> TaskEventEnvelope {
        TaskEventEnvelope {
            protocol_version: TASK_EVENT_PROTOCOL_VERSION,
            event: TaskEventV1 {
                event_id: "evt-auth-1".into(),
                connector_id: "connector-auth-1".into(),
                source_instance: "codex-install-1".into(),
                task_id: "task-auth-1".into(),
                run_id: "run-auth-1".into(),
                parent_task_id: None,
                source: "openai.codex".into(),
                external_id: "thread-auth-1".into(),
                title: "Authenticate event".into(),
                workspace: Some("yuanyuan-reminder".into()),
                state: TaskState::Running,
                progress: Some(0.25),
                summary: None,
                attention_reason: None,
                evidence_type: EvidenceType::Hook,
                evidence_level: EvidenceLevel::Authoritative,
                sequence: 1,
                occurred_at: "2026-04-03T12:00:00Z".into(),
                received_at: "2026-04-03T12:00:00Z".into(),
                started_at: None,
                updated_at: "2026-04-03T12:00:00Z".into(),
                completed_at: None,
                finality: EventFinality::Provisional,
                return_action: None,
                payload_digest: "sha256:0123456789abcdef".into(),
                raw_payload_ref: None,
            },
        }
    }

    fn authenticated_input(nonce: [u8; AUTH_NONCE_BYTES]) -> Vec<u8> {
        let key = AuthenticationKey::new(KEY_BYTES).unwrap();
        serde_json::to_vec(&seal_event(event(), KEY_ID, nonce, NOW, &key).unwrap()).unwrap()
    }

    #[test]
    fn verifies_a_valid_authenticated_event() {
        let verified = verify_authenticated_input(
            &authenticated_input([1; AUTH_NONCE_BYTES]),
            &TestKeys,
            &TestNonces::default(),
            NOW,
        )
        .unwrap();
        assert_eq!(verified, event());
    }

    #[test]
    fn signature_verification_uses_timestamp_aware_key_authority() {
        let verified = verify_authenticated_signature(
            &authenticated_input([10; AUTH_NONCE_BYTES]),
            &TimestampPolicyKeys,
            NOW,
        )
        .unwrap();

        assert_eq!(verified, event());
    }

    #[test]
    fn rejects_event_tampering_without_recording_the_nonce() {
        let mut json: serde_json::Value =
            serde_json::from_slice(&authenticated_input([2; AUTH_NONCE_BYTES])).unwrap();
        json["event"]["title"] = serde_json::json!("Tampered");
        let input = serde_json::to_vec(&json).unwrap();
        let nonces = TestNonces::default();

        assert!(matches!(
            verify_authenticated_input(&input, &TestKeys, &nonces, NOW),
            Err(AuthenticationError::InvalidMac)
        ));
        assert!(nonces.0.lock().unwrap().is_empty());
    }

    #[test]
    fn rejects_mac_tampering() {
        let mut json: serde_json::Value =
            serde_json::from_slice(&authenticated_input([3; AUTH_NONCE_BYTES])).unwrap();
        json["auth"]["mac"] = serde_json::json!("AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA");

        assert!(matches!(
            verify_authenticated_input(
                &serde_json::to_vec(&json).unwrap(),
                &TestKeys,
                &TestNonces::default(),
                NOW
            ),
            Err(AuthenticationError::InvalidMac)
        ));
    }

    #[test]
    fn claim_inspection_returns_only_validated_identity_metadata_without_authenticating() {
        let mut json: serde_json::Value =
            serde_json::from_slice(&authenticated_input([11; AUTH_NONCE_BYTES])).unwrap();
        json["auth"]["mac"] = serde_json::json!("AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA");
        let input = serde_json::to_vec(&json).unwrap();
        let claims = inspect_authentication_claims(&input, NOW).unwrap();
        assert_eq!(claims.connector_id, "connector-auth-1");
        assert_eq!(claims.source_instance, "codex-install-1");
        assert_eq!(claims.key_id, KEY_ID);
        assert!(matches!(
            verify_authenticated_signature(&input, &TestKeys, NOW),
            Err(AuthenticationError::InvalidMac)
        ));
    }

    #[test]
    fn rejects_replayed_nonces_after_successful_authentication() {
        let input = authenticated_input([4; AUTH_NONCE_BYTES]);
        let nonces = TestNonces::default();
        assert!(verify_authenticated_input(&input, &TestKeys, &nonces, NOW).is_ok());
        assert!(matches!(
            verify_authenticated_input(&input, &TestKeys, &nonces, NOW),
            Err(AuthenticationError::Replay)
        ));
    }

    #[test]
    fn rejects_stale_and_future_timestamps() {
        let key = AuthenticationKey::new(KEY_BYTES).unwrap();
        let skew = MAX_CLOCK_SKEW.as_millis() as i64;
        for signed_at in [NOW - skew - 1, NOW + skew + 1] {
            let sealed = seal_event(
                event(),
                KEY_ID,
                [signed_at as u8; AUTH_NONCE_BYTES],
                signed_at,
                &key,
            )
            .unwrap();
            assert!(matches!(
                verify_authenticated_input(
                    &serde_json::to_vec(&sealed).unwrap(),
                    &TestKeys,
                    &TestNonces::default(),
                    NOW
                ),
                Err(AuthenticationError::ClockSkew)
            ));
        }
    }

    #[test]
    fn rejects_unknown_or_revoked_keys() {
        let key = AuthenticationKey::new(KEY_BYTES).unwrap();
        let sealed =
            seal_event(event(), "codex.revoked", [5; AUTH_NONCE_BYTES], NOW, &key).unwrap();
        assert!(matches!(
            verify_authenticated_input(
                &serde_json::to_vec(&sealed).unwrap(),
                &TestKeys,
                &TestNonces::default(),
                NOW
            ),
            Err(AuthenticationError::UnknownOrRevokedKey)
        ));
    }

    #[test]
    fn rejects_weak_keys_and_redacts_secret_debug_output() {
        assert!(matches!(
            AuthenticationKey::new(vec![7; 16]),
            Err(AuthenticationError::WeakKey)
        ));
        let key = AuthenticationKey::new(KEY_BYTES).unwrap();
        assert_eq!(format!("{key:?}"), "AuthenticationKey([redacted])");
    }

    #[test]
    fn authentication_v1_has_a_frozen_cross_connector_test_vector() {
        let key = AuthenticationKey::new(KEY_BYTES).unwrap();
        let sealed = seal_event(event(), KEY_ID, [9; AUTH_NONCE_BYTES], NOW, &key).unwrap();
        assert_eq!(sealed.auth.nonce, "CQkJCQkJCQkJCQkJCQkJCQ");
        assert_eq!(
            sealed.auth.mac,
            "3y03HYFlVZeqmQ6lhk0ekmYGpIpZOUxu_I4LxCmVWFQ"
        );
    }
}
