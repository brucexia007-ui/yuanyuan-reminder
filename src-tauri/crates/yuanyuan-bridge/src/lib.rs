use std::{sync::Arc, time::Duration};

use serde::{Deserialize, Serialize};
use thiserror::Error;
use yuanyuan_protocol::{ProtocolValidationError, TaskEventEnvelope};

mod authentication;
mod authentication_health;
mod credential_trust;
mod diagnostics;
mod spool;
mod sqlite_nonce_store;
mod trust_store;

pub use authentication::{
    inspect_authentication_claims, seal_event, verify_authenticated_input,
    verify_authenticated_signature, verify_authenticated_signature_with_metadata,
    AuthenticatedTaskEvent, AuthenticationClaims, AuthenticationError, AuthenticationKey,
    AuthenticationKeyResolver, EventAuthenticationV1, KeyResolutionError, NonceStore,
    NonceStoreError, VerifiedAuthenticatedEvent, AUTHENTICATION_VERSION, AUTH_NONCE_BYTES,
    MAX_CLOCK_SKEW,
};
pub use authentication_health::*;
pub use credential_trust::{
    CredentialSecretStore, CredentialTrustError, CredentialTrustManager, SecretStoreError,
};
pub use diagnostics::*;
pub use spool::{
    inspect_spool_usage, ReplayDisposition, ReplayReport, Spool, SpoolEnqueueOutcome, SpoolError,
    SpoolLimits, SpoolUsage,
};
pub use sqlite_nonce_store::SqliteNonceStore;
pub use trust_store::*;

pub const MAX_BRIDGE_INPUT_BYTES: usize = 64 * 1024;
pub const FAIL_OPEN_EXIT_CODE: i32 = 0;
pub const TARGET_DELIVERY_BUDGET: Duration = Duration::from_secs(1);
pub const HARD_DELIVERY_TIMEOUT: Duration = Duration::from_secs(3);
pub const DELIVERY_ACK_V1: [u8; 8] = *b"YYACK001";

pub trait EventSink {
    fn enqueue(&self, event: &TaskEventEnvelope) -> Result<(), SinkError>;
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SinkError {
    Unavailable,
    QueueFull,
    Timeout,
    Rejected,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum BridgeOutcome {
    Accepted,
    Dropped(BridgeDiagnosticCode),
}

impl BridgeOutcome {
    pub fn hook_exit_code(self) -> i32 {
        FAIL_OPEN_EXIT_CODE
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum BridgeDiagnosticCode {
    InputTooLarge,
    InvalidJson,
    InvalidProtocol,
    SinkUnavailable,
    QueueFull,
    Timeout,
    SinkRejected,
    AuthenticationFailed,
    AuthenticationUnavailable,
    AuthenticationPaused,
    ReplayRejected,
}

impl BridgeDiagnosticCode {
    pub const ALL: [Self; 11] = [
        Self::InputTooLarge,
        Self::InvalidJson,
        Self::InvalidProtocol,
        Self::SinkUnavailable,
        Self::QueueFull,
        Self::Timeout,
        Self::SinkRejected,
        Self::AuthenticationFailed,
        Self::AuthenticationUnavailable,
        Self::AuthenticationPaused,
        Self::ReplayRejected,
    ];

    pub const fn as_str(self) -> &'static str {
        match self {
            Self::InputTooLarge => "input_too_large",
            Self::InvalidJson => "invalid_json",
            Self::InvalidProtocol => "invalid_protocol",
            Self::SinkUnavailable => "sink_unavailable",
            Self::QueueFull => "queue_full",
            Self::Timeout => "timeout",
            Self::SinkRejected => "sink_rejected",
            Self::AuthenticationFailed => "authentication_failed",
            Self::AuthenticationUnavailable => "authentication_unavailable",
            Self::AuthenticationPaused => "authentication_paused",
            Self::ReplayRejected => "replay_rejected",
        }
    }

    pub fn parse_code(value: &str) -> Option<Self> {
        Self::ALL.into_iter().find(|code| code.as_str() == value)
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum BufferedDeliveryOutcome {
    Delivered,
    Stored,
    Duplicate,
    Dropped(BridgeDiagnosticCode),
}

impl BufferedDeliveryOutcome {
    pub fn hook_exit_code(self) -> i32 {
        FAIL_OPEN_EXIT_CODE
    }
}

pub fn process_event<S: EventSink>(input: &[u8], sink: &S) -> BridgeOutcome {
    match try_process_event(input, sink) {
        Ok(()) => BridgeOutcome::Accepted,
        Err(error) => BridgeOutcome::Dropped(error.diagnostic_code()),
    }
}

pub fn process_authenticated_event<K: AuthenticationKeyResolver, N: NonceStore, S: EventSink>(
    input: &[u8],
    keys: &K,
    nonces: &N,
    now_unix_ms: i64,
    sink: &S,
) -> BridgeOutcome {
    let event = match verify_authenticated_input(input, keys, nonces, now_unix_ms) {
        Ok(event) => event,
        Err(error) => return BridgeOutcome::Dropped(authentication_diagnostic(&error)),
    };

    match sink.enqueue(&event) {
        Ok(()) => BridgeOutcome::Accepted,
        Err(SinkError::Unavailable) => {
            BridgeOutcome::Dropped(BridgeDiagnosticCode::SinkUnavailable)
        }
        Err(SinkError::QueueFull) => BridgeOutcome::Dropped(BridgeDiagnosticCode::QueueFull),
        Err(SinkError::Timeout) => BridgeOutcome::Dropped(BridgeDiagnosticCode::Timeout),
        Err(SinkError::Rejected) => BridgeOutcome::Dropped(BridgeDiagnosticCode::SinkRejected),
    }
}

pub fn deliver_authenticated_or_spool<K, F, G>(
    input: &[u8],
    keys: &K,
    now_unix_ms: i64,
    deliver: F,
    open_spool: G,
) -> BufferedDeliveryOutcome
where
    K: AuthenticationKeyResolver,
    F: FnOnce(&[u8]) -> Result<(), SinkError>,
    G: FnOnce() -> Result<Spool, SpoolError>,
{
    deliver_authenticated_or_spool_observed(input, keys, now_unix_ms, deliver, open_spool, |_| {})
}

pub enum AuthenticationObservation<'a> {
    Verified(&'a VerifiedAuthenticatedEvent),
    Rejected(&'a AuthenticationError),
}

pub fn deliver_authenticated_or_spool_observed<K, F, G, H>(
    input: &[u8],
    keys: &K,
    now_unix_ms: i64,
    deliver: F,
    open_spool: G,
    observe: H,
) -> BufferedDeliveryOutcome
where
    K: AuthenticationKeyResolver,
    F: FnOnce(&[u8]) -> Result<(), SinkError>,
    G: FnOnce() -> Result<Spool, SpoolError>,
    H: FnOnce(AuthenticationObservation<'_>),
{
    let verified = match verify_authenticated_signature_with_metadata(input, keys, now_unix_ms) {
        Ok(verified) => verified,
        Err(error) => {
            observe(AuthenticationObservation::Rejected(&error));
            return BufferedDeliveryOutcome::Dropped(authentication_diagnostic(&error));
        }
    };
    observe(AuthenticationObservation::Verified(&verified));
    if deliver(input).is_ok() {
        return BufferedDeliveryOutcome::Delivered;
    }
    let spool = match open_spool() {
        Ok(spool) => spool,
        Err(SpoolError::Full) => {
            return BufferedDeliveryOutcome::Dropped(BridgeDiagnosticCode::QueueFull)
        }
        Err(_) => return BufferedDeliveryOutcome::Dropped(BridgeDiagnosticCode::SinkUnavailable),
    };
    match spool.enqueue(input, now_unix_ms) {
        Ok(SpoolEnqueueOutcome::Stored) => BufferedDeliveryOutcome::Stored,
        Ok(SpoolEnqueueOutcome::Duplicate) => BufferedDeliveryOutcome::Duplicate,
        Err(SpoolError::InputTooLarge) => {
            BufferedDeliveryOutcome::Dropped(BridgeDiagnosticCode::InputTooLarge)
        }
        Err(SpoolError::Full) => BufferedDeliveryOutcome::Dropped(BridgeDiagnosticCode::QueueFull),
        Err(_) => BufferedDeliveryOutcome::Dropped(BridgeDiagnosticCode::SinkUnavailable),
    }
}

fn authentication_diagnostic(error: &AuthenticationError) -> BridgeDiagnosticCode {
    match error {
        AuthenticationError::InputTooLarge => BridgeDiagnosticCode::InputTooLarge,
        AuthenticationError::InvalidJson(_) => BridgeDiagnosticCode::InvalidJson,
        AuthenticationError::KeyStoreUnavailable | AuthenticationError::NonceStoreUnavailable => {
            BridgeDiagnosticCode::AuthenticationUnavailable
        }
        AuthenticationError::Replay => BridgeDiagnosticCode::ReplayRejected,
        _ => BridgeDiagnosticCode::AuthenticationFailed,
    }
}

/// Runs the complete bridge path behind a process-level watchdog.
///
/// The worker may still be running when a timeout is returned. This function is
/// intended for the short-lived Bridge executable, which exits immediately
/// after returning the fail-open result and therefore terminates that worker.
pub fn process_event_with_hard_timeout<S>(
    input: Vec<u8>,
    sink: Arc<S>,
    hard_timeout: Duration,
) -> BridgeOutcome
where
    S: EventSink + Send + Sync + 'static,
{
    let (sender, receiver) = std::sync::mpsc::sync_channel(1);
    std::thread::spawn(move || {
        let _ = sender.send(process_event(&input, sink.as_ref()));
    });

    match receiver.recv_timeout(hard_timeout) {
        Ok(outcome) => outcome,
        Err(std::sync::mpsc::RecvTimeoutError::Timeout) => {
            BridgeOutcome::Dropped(BridgeDiagnosticCode::Timeout)
        }
        Err(std::sync::mpsc::RecvTimeoutError::Disconnected) => {
            BridgeOutcome::Dropped(BridgeDiagnosticCode::SinkRejected)
        }
    }
}

#[cfg(windows)]
mod windows_named_pipe;

#[cfg(windows)]
mod windows_credentials;

#[cfg(windows)]
mod windows_named_pipe_server;

#[cfg(windows)]
pub use windows_named_pipe::{NamedPipeEventSink, NamedPipeNameError};

#[cfg(windows)]
pub use windows_named_pipe_server::{
    apply_current_user_only_dacl, current_parent_process_identity, current_process_identity,
    NamedPipeServerError, ReceivedPipeEvent, WindowsNamedPipeServer, WindowsProcessIdentity,
};

#[cfg(windows)]
pub use windows_credentials::{
    CredentialPersistence, WindowsCredentialError, WindowsCredentialKeyResolver,
    WindowsCredentialSecretStore, CREDENTIAL_TARGET_PREFIX,
};

fn try_process_event<S: EventSink>(input: &[u8], sink: &S) -> Result<(), BridgeError> {
    if input.len() > MAX_BRIDGE_INPUT_BYTES {
        return Err(BridgeError::InputTooLarge(input.len()));
    }

    let event: TaskEventEnvelope = serde_json::from_slice(input)?;
    event.validate()?;
    sink.enqueue(&event).map_err(BridgeError::Sink)
}

#[derive(Debug, Error)]
enum BridgeError {
    #[error("bridge input exceeds the byte limit: {0}")]
    InputTooLarge(usize),
    #[error("bridge input is not valid JSON")]
    InvalidJson(#[from] serde_json::Error),
    #[error("bridge input does not satisfy the task event protocol")]
    InvalidProtocol(#[from] ProtocolValidationError),
    #[error("bridge sink rejected the event")]
    Sink(SinkError),
}

impl BridgeError {
    fn diagnostic_code(&self) -> BridgeDiagnosticCode {
        match self {
            Self::InputTooLarge(_) => BridgeDiagnosticCode::InputTooLarge,
            Self::InvalidJson(_) => BridgeDiagnosticCode::InvalidJson,
            Self::InvalidProtocol(_) => BridgeDiagnosticCode::InvalidProtocol,
            Self::Sink(SinkError::Unavailable) => BridgeDiagnosticCode::SinkUnavailable,
            Self::Sink(SinkError::QueueFull) => BridgeDiagnosticCode::QueueFull,
            Self::Sink(SinkError::Timeout) => BridgeDiagnosticCode::Timeout,
            Self::Sink(SinkError::Rejected) => BridgeDiagnosticCode::SinkRejected,
        }
    }
}

#[cfg(test)]
mod tests {
    use std::{
        cell::Cell,
        rc::Rc,
        sync::{
            atomic::{AtomicUsize, Ordering},
            Arc,
        },
        time::{Duration, Instant},
    };

    use serde_json::json;

    use super::*;

    struct RecordingSink {
        calls: Rc<Cell<usize>>,
        result: Result<(), SinkError>,
    }

    impl EventSink for RecordingSink {
        fn enqueue(&self, _event: &TaskEventEnvelope) -> Result<(), SinkError> {
            self.calls.set(self.calls.get() + 1);
            self.result
        }
    }

    fn valid_event() -> Vec<u8> {
        serde_json::to_vec(&json!({
            "protocol_version": 1,
            "event": {
                "event_id": "evt-1",
                "connector_id": "connector-1",
                "source_instance": "codex-install-1",
                "task_id": "task-1",
                "run_id": "run-1",
                "source": "openai.codex",
                "external_id": "thread-1",
                "title": "Build Yuanyuan",
                "workspace": "yuanyuan-reminder",
                "state": "running",
                "evidence_type": "hook",
                "evidence_level": "authoritative",
                "sequence": 1,
                "occurred_at": "2026-08-03T12:00:00Z",
                "received_at": "2026-08-03T12:00:00Z",
                "updated_at": "2026-08-03T12:00:00Z",
                "finality": "provisional",
                "payload_digest": "sha256:0123456789abcdef"
            }
        }))
        .unwrap()
    }

    fn sink(result: Result<(), SinkError>) -> (RecordingSink, Rc<Cell<usize>>) {
        let calls = Rc::new(Cell::new(0));
        (
            RecordingSink {
                calls: calls.clone(),
                result,
            },
            calls,
        )
    }

    #[test]
    fn valid_events_are_enqueued_once() {
        let (sink, calls) = sink(Ok(()));
        assert_eq!(
            process_event(&valid_event(), &sink),
            BridgeOutcome::Accepted
        );
        assert_eq!(calls.get(), 1);
    }

    #[test]
    fn oversized_input_is_rejected_before_the_sink() {
        let (sink, calls) = sink(Ok(()));
        let input = vec![b'x'; MAX_BRIDGE_INPUT_BYTES + 1];
        assert_eq!(
            process_event(&input, &sink),
            BridgeOutcome::Dropped(BridgeDiagnosticCode::InputTooLarge)
        );
        assert_eq!(calls.get(), 0);
    }

    #[test]
    fn invalid_json_is_rejected_before_the_sink() {
        let (sink, calls) = sink(Ok(()));
        assert_eq!(
            process_event(b"not-json", &sink),
            BridgeOutcome::Dropped(BridgeDiagnosticCode::InvalidJson)
        );
        assert_eq!(calls.get(), 0);
    }

    #[test]
    fn invalid_protocol_is_rejected_before_the_sink() {
        let (sink, calls) = sink(Ok(()));
        let input = valid_event();
        let mut json: serde_json::Value = serde_json::from_slice(&input).unwrap();
        json["protocol_version"] = json!(2);
        let input = serde_json::to_vec(&json).unwrap();

        assert_eq!(
            process_event(&input, &sink),
            BridgeOutcome::Dropped(BridgeDiagnosticCode::InvalidProtocol)
        );
        assert_eq!(calls.get(), 0);
    }

    #[test]
    fn every_sink_failure_still_uses_the_fail_open_exit_code() {
        let cases = [
            (
                SinkError::Unavailable,
                BridgeDiagnosticCode::SinkUnavailable,
            ),
            (SinkError::QueueFull, BridgeDiagnosticCode::QueueFull),
            (SinkError::Timeout, BridgeDiagnosticCode::Timeout),
            (SinkError::Rejected, BridgeDiagnosticCode::SinkRejected),
        ];

        for (sink_error, diagnostic) in cases {
            let (sink, calls) = sink(Err(sink_error));
            let outcome = process_event(&valid_event(), &sink);
            assert_eq!(outcome, BridgeOutcome::Dropped(diagnostic));
            assert_eq!(outcome.hook_exit_code(), FAIL_OPEN_EXIT_CODE);
            assert_eq!(calls.get(), 1);
        }
    }

    #[test]
    fn parse_failures_also_use_the_fail_open_exit_code() {
        let (sink, _) = sink(Ok(()));
        let outcome = process_event(b"not-json", &sink);
        assert_eq!(outcome.hook_exit_code(), FAIL_OPEN_EXIT_CODE);
    }

    struct BlockingSink {
        calls: AtomicUsize,
        delay: Duration,
    }

    impl EventSink for BlockingSink {
        fn enqueue(&self, _event: &TaskEventEnvelope) -> Result<(), SinkError> {
            self.calls.fetch_add(1, Ordering::SeqCst);
            std::thread::sleep(self.delay);
            Ok(())
        }
    }

    #[test]
    fn process_watchdog_returns_fail_open_before_a_blocked_sink_finishes() {
        let sink = Arc::new(BlockingSink {
            calls: AtomicUsize::new(0),
            delay: Duration::from_millis(250),
        });
        let started = Instant::now();

        let outcome =
            process_event_with_hard_timeout(valid_event(), sink.clone(), Duration::from_millis(25));

        assert_eq!(
            outcome,
            BridgeOutcome::Dropped(BridgeDiagnosticCode::Timeout)
        );
        assert_eq!(outcome.hook_exit_code(), FAIL_OPEN_EXIT_CODE);
        assert!(started.elapsed() < Duration::from_millis(150));
        assert_eq!(sink.calls.load(Ordering::SeqCst), 1);
    }

    #[test]
    fn process_watchdog_preserves_fast_results() {
        struct FastSink;

        impl EventSink for FastSink {
            fn enqueue(&self, _event: &TaskEventEnvelope) -> Result<(), SinkError> {
                Err(SinkError::QueueFull)
            }
        }

        assert_eq!(
            process_event_with_hard_timeout(
                valid_event(),
                Arc::new(FastSink),
                HARD_DELIVERY_TIMEOUT,
            ),
            BridgeOutcome::Dropped(BridgeDiagnosticCode::QueueFull)
        );
    }

    struct TestAuthenticationKeys;

    impl AuthenticationKeyResolver for TestAuthenticationKeys {
        fn resolve(&self, key_id: &str) -> Result<AuthenticationKey, KeyResolutionError> {
            if key_id == "codex.test" {
                AuthenticationKey::new(vec![0x33; 32]).map_err(|_| KeyResolutionError::Unavailable)
            } else {
                Err(KeyResolutionError::UnknownOrRevoked)
            }
        }
    }

    struct FixedNonceStore(Result<bool, NonceStoreError>);

    impl NonceStore for FixedNonceStore {
        fn record_if_new(
            &self,
            _key_id: &str,
            _nonce: &[u8],
            _expires_at_unix_ms: i64,
            _now_unix_ms: i64,
        ) -> Result<bool, NonceStoreError> {
            self.0
        }
    }

    fn authenticated_event(now: i64) -> Vec<u8> {
        let event: TaskEventEnvelope = serde_json::from_slice(&valid_event()).unwrap();
        let key = AuthenticationKey::new(vec![0x33; 32]).unwrap();
        serde_json::to_vec(
            &seal_event(event, "codex.test", [0x44; AUTH_NONCE_BYTES], now, &key).unwrap(),
        )
        .unwrap()
    }

    #[test]
    fn authenticated_events_reach_the_sink_only_after_verification() {
        let now = 1_775_212_800_000;
        let (sink, calls) = sink(Ok(()));
        assert_eq!(
            process_authenticated_event(
                &authenticated_event(now),
                &TestAuthenticationKeys,
                &FixedNonceStore(Ok(true)),
                now,
                &sink,
            ),
            BridgeOutcome::Accepted
        );
        assert_eq!(calls.get(), 1);
    }

    #[test]
    fn authentication_failures_never_reach_the_sink_and_still_fail_open() {
        let now = 1_775_212_800_000;
        let mut input: serde_json::Value =
            serde_json::from_slice(&authenticated_event(now)).unwrap();
        input["event"]["title"] = serde_json::json!("tampered");
        let (sink, calls) = sink(Ok(()));
        let outcome = process_authenticated_event(
            &serde_json::to_vec(&input).unwrap(),
            &TestAuthenticationKeys,
            &FixedNonceStore(Ok(true)),
            now,
            &sink,
        );
        assert_eq!(
            outcome,
            BridgeOutcome::Dropped(BridgeDiagnosticCode::AuthenticationFailed)
        );
        assert_eq!(outcome.hook_exit_code(), FAIL_OPEN_EXIT_CODE);
        assert_eq!(calls.get(), 0);
    }

    #[test]
    fn replay_and_authentication_storage_failures_have_stable_diagnostics() {
        let now = 1_775_212_800_000;
        let input = authenticated_event(now);
        let (sink, calls) = sink(Ok(()));
        assert_eq!(
            process_authenticated_event(
                &input,
                &TestAuthenticationKeys,
                &FixedNonceStore(Ok(false)),
                now,
                &sink,
            ),
            BridgeOutcome::Dropped(BridgeDiagnosticCode::ReplayRejected)
        );
        assert_eq!(calls.get(), 0);

        assert_eq!(
            process_authenticated_event(
                &input,
                &TestAuthenticationKeys,
                &FixedNonceStore(Err(NonceStoreError::Unavailable)),
                now,
                &sink,
            ),
            BridgeOutcome::Dropped(BridgeDiagnosticCode::AuthenticationUnavailable)
        );
        assert_eq!(calls.get(), 0);
    }

    #[test]
    fn authenticated_delivery_falls_back_to_spool_without_consuming_the_nonce() {
        let now = 1_775_212_800_000;
        let directory = tempfile::tempdir().unwrap();
        let spool = Spool::open(directory.path(), SpoolLimits::default()).unwrap();
        let input = authenticated_event(now);
        let outcome = deliver_authenticated_or_spool(
            &input,
            &TestAuthenticationKeys,
            now,
            |_| Err(SinkError::Unavailable),
            || Spool::open(directory.path(), SpoolLimits::default()),
        );
        assert_eq!(outcome, BufferedDeliveryOutcome::Stored);
        assert_eq!(outcome.hook_exit_code(), FAIL_OPEN_EXIT_CODE);
        assert_eq!(
            deliver_authenticated_or_spool(
                &input,
                &TestAuthenticationKeys,
                now,
                |_| Err(SinkError::Unavailable),
                || Spool::open(directory.path(), SpoolLimits::default()),
            ),
            BufferedDeliveryOutcome::Duplicate
        );

        let (sink, calls) = sink(Ok(()));
        let report = spool
            .replay(|payload| {
                match process_authenticated_event(
                    payload,
                    &TestAuthenticationKeys,
                    &FixedNonceStore(Ok(true)),
                    now,
                    &sink,
                ) {
                    BridgeOutcome::Accepted => ReplayDisposition::Acknowledge,
                    BridgeOutcome::Dropped(_) => ReplayDisposition::Quarantine,
                }
            })
            .unwrap();
        assert_eq!(report.acknowledged, 1);
        assert_eq!(calls.get(), 1);
    }

    #[test]
    fn successful_authenticated_delivery_preserves_raw_bytes_and_never_opens_spool() {
        let now = 1_775_212_800_000;
        let input = authenticated_event(now);
        let outcome = deliver_authenticated_or_spool(
            &input,
            &TestAuthenticationKeys,
            now,
            |delivered| {
                assert_eq!(delivered, input);
                Ok(())
            },
            || panic!("successful transport must not open spool"),
        );
        assert_eq!(outcome, BufferedDeliveryOutcome::Delivered);
    }

    #[test]
    fn unauthenticated_or_tampered_events_never_reach_disk_staging() {
        let now = 1_775_212_800_000;
        let directory = tempfile::tempdir().unwrap();
        let mut input: serde_json::Value =
            serde_json::from_slice(&authenticated_event(now)).unwrap();
        input["event"]["title"] = serde_json::json!("tampered before spool");
        let outcome = deliver_authenticated_or_spool(
            &serde_json::to_vec(&input).unwrap(),
            &TestAuthenticationKeys,
            now,
            |_| panic!("invalid authentication must not reach transport"),
            || panic!("invalid authentication must not create disk staging"),
        );
        assert_eq!(
            outcome,
            BufferedDeliveryOutcome::Dropped(BridgeDiagnosticCode::AuthenticationFailed)
        );
        assert!(!directory.path().join("pending").exists());
        let spool = Spool::open(directory.path(), SpoolLimits::default()).unwrap();
        let mut replay_calls = 0;
        let report = spool
            .replay(|_| {
                replay_calls += 1;
                ReplayDisposition::Acknowledge
            })
            .unwrap();
        assert_eq!(replay_calls, 0);
        assert_eq!(report, ReplayReport::default());
    }
}
