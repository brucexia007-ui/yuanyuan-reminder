use std::{collections::VecDeque, io::ErrorKind, path::Path, time::Duration};

use rusqlite::{
    params, Connection, OpenFlags, OptionalExtension, Transaction, TransactionBehavior,
};
use sha2::{Digest, Sha256};
use thiserror::Error;
use yuanyuan_bridge::{
    verify_authenticated_signature_with_metadata, AuthenticationError, AuthenticationKeyResolver,
    ReplayDisposition, ReplayReport, Spool, SpoolError, VerifiedAuthenticatedEvent,
};
use yuanyuan_protocol::{decide_transition, TaskEventEnvelope, TransitionDecision};

mod provider;
pub use provider::*;
#[cfg(windows)]
mod crash_privacy;
#[cfg(windows)]
pub use crash_privacy::{enforce_sensitive_process_crash_policy, SensitiveProcessCrashPolicyError};
mod retention;
pub use retention::*;
#[cfg(feature = "retention-qa")]
mod retention_qa;
#[cfg(feature = "retention-qa")]
pub use retention_qa::*;
mod memory_search;
pub use memory_search::*;
mod memory_store;
pub use memory_store::*;
mod support_preferences;
pub use support_preferences::*;
mod support_sort_authorization;
pub use support_sort_authorization::*;
mod support_sort_provider;
pub use support_sort_provider::*;
mod support_sort_host;
mod support_sort_semantic_gate;
pub use support_sort_host::*;
#[cfg(windows)]
mod support_sort_bootstrap;
#[cfg(test)]
mod support_sort_privacy_boundary;
#[cfg(windows)]
pub use support_sort_bootstrap::*;

const SCHEMA_V1: &str = include_str!("../migrations/001_task_watcher.sql");
const SCHEMA_V2: &str = include_str!("../migrations/002_memory_lifecycle.sql");
const SCHEMA_V3: &str = include_str!("../migrations/003_support_preferences.sql");
const SCHEMA_V4: &str = include_str!("../migrations/004_task_evidence_projection.sql");

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CommitOutcome {
    Applied,
    IgnoredStale,
    IgnoredRepeatedTerminal,
    RejectedTransition,
    AlreadyCommitted,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RestartDecision {
    RestartAfter(Duration),
    OpenCircuit,
}

pub const AI_CONTROL_PROTOCOL_VERSION: u16 = 1;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ControlCompatibility {
    Compatible(u16),
    AiTooOld,
    AiTooNew,
    InvalidRange,
}

pub fn negotiate_control_protocol(
    core_minimum: u16,
    core_maximum: u16,
    ai_version: u16,
) -> ControlCompatibility {
    if core_minimum == 0 || core_minimum > core_maximum || ai_version == 0 {
        return ControlCompatibility::InvalidRange;
    }
    if ai_version < core_minimum {
        ControlCompatibility::AiTooOld
    } else if ai_version > core_maximum {
        ControlCompatibility::AiTooNew
    } else {
        ControlCompatibility::Compatible(ai_version)
    }
}

#[derive(Clone)]
pub struct RestartCircuitBreaker {
    failures: VecDeque<std::time::Instant>,
    maximum_failures: usize,
    failure_window: Duration,
    initial_backoff: Duration,
    maximum_backoff: Duration,
}

impl Default for RestartCircuitBreaker {
    fn default() -> Self {
        Self {
            failures: VecDeque::new(),
            maximum_failures: 3,
            failure_window: Duration::from_secs(5 * 60),
            initial_backoff: Duration::from_secs(1),
            maximum_backoff: Duration::from_secs(30),
        }
    }
}

impl RestartCircuitBreaker {
    pub fn with_policy(
        maximum_failures: usize,
        failure_window: Duration,
        initial_backoff: Duration,
        maximum_backoff: Duration,
    ) -> Self {
        Self {
            failures: VecDeque::new(),
            maximum_failures: maximum_failures.max(1),
            failure_window,
            initial_backoff,
            maximum_backoff: maximum_backoff.max(initial_backoff),
        }
    }

    pub fn record_failure(&mut self, now: std::time::Instant) -> RestartDecision {
        while self
            .failures
            .front()
            .is_some_and(|failure| now.duration_since(*failure) > self.failure_window)
        {
            self.failures.pop_front();
        }
        self.failures.push_back(now);
        if self.failures.len() >= self.maximum_failures {
            return RestartDecision::OpenCircuit;
        }
        let exponent = self.failures.len().saturating_sub(1).min(31) as u32;
        let multiplier = 1_u32.checked_shl(exponent).unwrap_or(u32::MAX);
        RestartDecision::RestartAfter(
            self.initial_backoff
                .saturating_mul(multiplier)
                .min(self.maximum_backoff),
        )
    }

    pub fn record_healthy_run(&mut self, uptime: Duration) {
        if uptime >= self.failure_window {
            self.failures.clear();
        }
    }
}

#[derive(Debug, Error)]
pub enum TaskStoreError {
    #[error("task event authentication failed")]
    Authentication(#[from] AuthenticationError),
    #[error("task event was replayed with a different identity")]
    Replay,
    #[error("task database operation failed")]
    Database(#[from] rusqlite::Error),
    #[error("task event serialization failed")]
    Serialization(#[from] serde_json::Error),
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TaskExpressionSource {
    Codex,
    ClaudeCode,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct TaskExpressionCandidate {
    pub task_digest: [u8; 16],
    pub source: TaskExpressionSource,
    pub state: yuanyuan_protocol::TaskState,
    pub updated_at_unix_ms: i64,
}

#[derive(Debug, Error)]
pub enum TaskExpressionReadError {
    #[error("task expression database could not be read")]
    Database(#[from] rusqlite::Error),
    #[error("task expression database has an unsupported schema")]
    UnsupportedSchema,
    #[error("task expression database contains an invalid fixed field")]
    InvalidFixedField,
    #[error("task expression database path is unsafe")]
    UnsafePath,
}

pub fn read_task_expression_candidates(
    path: impl AsRef<Path>,
) -> Result<Vec<TaskExpressionCandidate>, TaskExpressionReadError> {
    let path = path.as_ref();
    if !validate_task_expression_database_path(path)? {
        return Ok(Vec::new());
    }
    let connection = Connection::open_with_flags(
        path,
        OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX,
    )?;
    connection.busy_timeout(Duration::from_millis(100))?;
    let version: u32 = connection.query_row("PRAGMA user_version", [], |row| row.get(0))?;
    if version != 4 {
        return Err(TaskExpressionReadError::UnsupportedSchema);
    }

    let mut statement = connection.prepare(
        "SELECT task_key, source, state, evidence_level, updated_at_unix_ms
         FROM watched_tasks
         ORDER BY CASE
             WHEN state IN ('waiting_user', 'succeeded', 'failed', 'cancelled')
                  AND evidence_level != 'authoritative' THEN 2
             WHEN state = 'waiting_user' THEN 0
             WHEN state = 'stalled' THEN 1
             WHEN state = 'unknown' THEN 2
             WHEN state = 'running' THEN 3
             WHEN state = 'queued' THEN 4
             ELSE 5
         END, updated_at_unix_ms DESC, task_key ASC
         LIMIT 64",
    )?;
    let rows = statement.query_map([], |row| {
        Ok((
            row.get::<_, String>(0)?,
            row.get::<_, String>(1)?,
            row.get::<_, String>(2)?,
            row.get::<_, String>(3)?,
            row.get::<_, i64>(4)?,
        ))
    })?;
    let mut candidates = Vec::new();
    for row in rows {
        let (task_key, source, state, evidence_level, updated_at_unix_ms) = row?;
        if updated_at_unix_ms < 0 {
            return Err(TaskExpressionReadError::InvalidFixedField);
        }
        let state = parse_task_state(&state).ok_or(TaskExpressionReadError::InvalidFixedField)?;
        let state = project_task_expression_state(state, &evidence_level)
            .ok_or(TaskExpressionReadError::InvalidFixedField)?;
        candidates.push(TaskExpressionCandidate {
            task_digest: parse_task_digest(&task_key)
                .ok_or(TaskExpressionReadError::InvalidFixedField)?,
            source: match source.as_str() {
                "openai.codex" => TaskExpressionSource::Codex,
                "anthropic.claude-code" => TaskExpressionSource::ClaudeCode,
                _ => return Err(TaskExpressionReadError::InvalidFixedField),
            },
            state,
            updated_at_unix_ms,
        });
    }
    Ok(candidates)
}

fn validate_task_expression_database_path(path: &Path) -> Result<bool, TaskExpressionReadError> {
    let metadata = match std::fs::symlink_metadata(path) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == ErrorKind::NotFound => return Ok(false),
        Err(_) => return Err(TaskExpressionReadError::UnsafePath),
    };
    if !metadata.is_file() || metadata_is_reparse_point(&metadata) {
        return Err(TaskExpressionReadError::UnsafePath);
    }

    let parent = path.parent().ok_or(TaskExpressionReadError::UnsafePath)?;
    let parent_metadata =
        std::fs::symlink_metadata(parent).map_err(|_| TaskExpressionReadError::UnsafePath)?;
    if !parent_metadata.is_dir() || metadata_is_reparse_point(&parent_metadata) {
        return Err(TaskExpressionReadError::UnsafePath);
    }
    Ok(true)
}

#[cfg(windows)]
fn metadata_is_reparse_point(metadata: &std::fs::Metadata) -> bool {
    use std::os::windows::fs::MetadataExt;

    const FILE_ATTRIBUTE_REPARSE_POINT: u32 = 0x0400;
    metadata.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT != 0
}

#[cfg(not(windows))]
fn metadata_is_reparse_point(metadata: &std::fs::Metadata) -> bool {
    metadata.file_type().is_symlink()
}

fn parse_task_digest(value: &str) -> Option<[u8; 16]> {
    if value.len() != 64 || !value.bytes().all(|byte| byte.is_ascii_hexdigit()) {
        return None;
    }
    let mut digest = [0_u8; 16];
    for (index, byte) in digest.iter_mut().enumerate() {
        *byte = u8::from_str_radix(&value[index * 2..index * 2 + 2], 16).ok()?;
    }
    Some(digest)
}

fn parse_task_state(value: &str) -> Option<yuanyuan_protocol::TaskState> {
    use yuanyuan_protocol::TaskState;
    match value {
        "queued" => Some(TaskState::Queued),
        "running" => Some(TaskState::Running),
        "waiting_user" => Some(TaskState::WaitingUser),
        "succeeded" => Some(TaskState::Succeeded),
        "failed" => Some(TaskState::Failed),
        "cancelled" => Some(TaskState::Cancelled),
        "stalled" => Some(TaskState::Stalled),
        "unknown" => Some(TaskState::Unknown),
        _ => None,
    }
}

fn project_task_expression_state(
    state: yuanyuan_protocol::TaskState,
    evidence_level: &str,
) -> Option<yuanyuan_protocol::TaskState> {
    use yuanyuan_protocol::TaskState;

    let authoritative = match evidence_level {
        "authoritative" => true,
        "partial" | "presence_only" | "unknown" => false,
        _ => return None,
    };
    if !authoritative
        && matches!(
            state,
            TaskState::WaitingUser
                | TaskState::Succeeded
                | TaskState::Failed
                | TaskState::Cancelled
        )
    {
        Some(TaskState::Unknown)
    } else {
        Some(state)
    }
}

pub struct TaskStore {
    connection: Connection,
}

pub fn replay_authenticated_spool<K: AuthenticationKeyResolver>(
    spool: &Spool,
    store: &mut TaskStore,
    keys: &K,
    now_unix_ms: i64,
) -> Result<ReplayReport, SpoolError> {
    spool.replay(
        |payload| match store.accept_authenticated(payload, keys, now_unix_ms) {
            Ok(_) => ReplayDisposition::Acknowledge,
            Err(TaskStoreError::Authentication(_)) | Err(TaskStoreError::Replay) => {
                ReplayDisposition::Quarantine
            }
            Err(_) => ReplayDisposition::RetryLater,
        },
    )
}

#[cfg(windows)]
#[derive(Debug, Error)]
pub enum ReceiveCommitError {
    #[error("task event could not be received")]
    Receive(#[from] yuanyuan_bridge::NamedPipeServerError),
    #[error("task event could not be committed")]
    Commit(#[from] TaskStoreError),
}

#[cfg(windows)]
#[derive(Debug, Error)]
pub enum TaskServiceError {
    #[error("task service pipe could not be created")]
    Bind(#[from] yuanyuan_bridge::NamedPipeServerError),
    #[error("task service shutdown pipe could not be created")]
    ShutdownUnavailable,
}

/// Receives one pipe message, atomically commits it, and only then emits ACK.
/// Any authentication or persistence error drops the connection without ACK,
/// causing the Bridge client to retain the event in its bounded spool.
#[cfg(windows)]
pub fn receive_commit_and_ack_one<K: AuthenticationKeyResolver>(
    server: yuanyuan_bridge::WindowsNamedPipeServer,
    store: &mut TaskStore,
    keys: &K,
    now_unix_ms: i64,
) -> Result<CommitOutcome, ReceiveCommitError> {
    let received = server.accept_one()?;
    let outcome = store.accept_authenticated(received.payload(), keys, now_unix_ms)?;
    received.acknowledge()?;
    Ok(outcome)
}

#[cfg(windows)]
pub fn run_task_service<K, F>(
    task_pipe_name: &str,
    shutdown_pipe_name: &str,
    store: &mut TaskStore,
    keys: &K,
    now_unix_ms: F,
) -> Result<(), TaskServiceError>
where
    K: AuthenticationKeyResolver,
    F: Fn() -> i64,
{
    run_task_service_with_control_version_and_ready(
        task_pipe_name,
        shutdown_pipe_name,
        store,
        keys,
        now_unix_ms,
        AI_CONTROL_PROTOCOL_VERSION,
        || {},
    )
}

#[cfg(windows)]
pub fn run_task_service_with_ready<K, F, R>(
    task_pipe_name: &str,
    shutdown_pipe_name: &str,
    store: &mut TaskStore,
    keys: &K,
    now_unix_ms: F,
    ready: R,
) -> Result<(), TaskServiceError>
where
    K: AuthenticationKeyResolver,
    F: Fn() -> i64,
    R: FnOnce(),
{
    run_task_service_with_control_version_and_ready(
        task_pipe_name,
        shutdown_pipe_name,
        store,
        keys,
        now_unix_ms,
        AI_CONTROL_PROTOCOL_VERSION,
        ready,
    )
}

#[cfg(windows)]
pub fn run_task_service_with_control_version<K, F>(
    task_pipe_name: &str,
    shutdown_pipe_name: &str,
    store: &mut TaskStore,
    keys: &K,
    now_unix_ms: F,
    control_protocol_version: u16,
) -> Result<(), TaskServiceError>
where
    K: AuthenticationKeyResolver,
    F: Fn() -> i64,
{
    run_task_service_with_control_version_and_ready(
        task_pipe_name,
        shutdown_pipe_name,
        store,
        keys,
        now_unix_ms,
        control_protocol_version,
        || {},
    )
}

#[cfg(windows)]
fn run_task_service_with_control_version_and_ready<K, F, R>(
    task_pipe_name: &str,
    shutdown_pipe_name: &str,
    store: &mut TaskStore,
    keys: &K,
    now_unix_ms: F,
    control_protocol_version: u16,
    ready: R,
) -> Result<(), TaskServiceError>
where
    K: AuthenticationKeyResolver,
    F: Fn() -> i64,
    R: FnOnce(),
{
    use std::sync::{
        atomic::{AtomicBool, Ordering},
        Arc,
    };

    let mut task_server = yuanyuan_bridge::WindowsNamedPipeServer::bind(task_pipe_name)?;
    let stopping = Arc::new(AtomicBool::new(false));
    let stop_for_thread = stopping.clone();
    let task_pipe_for_thread = task_pipe_name.to_owned();
    let shutdown_pipe_for_thread = shutdown_pipe_name.to_owned();
    let shutdown_message = control_message("SHUTDOWN", control_protocol_version);
    let health_message = control_message("HEALTH", control_protocol_version);
    let (ready_sender, ready_receiver) = std::sync::mpsc::sync_channel(1);
    let shutdown_thread = std::thread::spawn(move || {
        let Ok(mut server) =
            yuanyuan_bridge::WindowsNamedPipeServer::bind(&shutdown_pipe_for_thread)
        else {
            let _ = ready_sender.send(false);
            return;
        };
        let _ = ready_sender.send(true);
        loop {
            if let Ok(received) = server.accept_one() {
                if received.payload() == shutdown_message {
                    let _ = received.acknowledge();
                    stop_for_thread.store(true, Ordering::SeqCst);
                    if let Ok(waker) =
                        yuanyuan_bridge::NamedPipeEventSink::new(&task_pipe_for_thread)
                    {
                        let _ = waker.send_validated_payload(b"shutdown-wakeup");
                    }
                    return;
                }
                if received.payload() == health_message {
                    let _ = received.acknowledge();
                }
            }
            match yuanyuan_bridge::WindowsNamedPipeServer::bind(&shutdown_pipe_for_thread) {
                Ok(next) => server = next,
                Err(_) => return,
            }
        }
    });
    if ready_receiver.recv().ok() != Some(true) {
        return Err(TaskServiceError::ShutdownUnavailable);
    }
    ready();

    loop {
        match task_server.accept_one() {
            Ok(received) if stopping.load(Ordering::SeqCst) => {
                // The shutdown thread wakes this blocking accept through the task
                // pipe. Acknowledge that internal wake-up before joining it so the
                // sender does not have to sit through its client timeout.
                let _ = received.acknowledge();
                break;
            }
            Ok(received) => {
                if store
                    .accept_authenticated(received.payload(), keys, now_unix_ms())
                    .is_ok()
                {
                    let _ = received.acknowledge();
                }
            }
            Err(_) => {}
        }
        if stopping.load(Ordering::SeqCst) {
            break;
        }
        task_server = yuanyuan_bridge::WindowsNamedPipeServer::bind(task_pipe_name)?;
    }
    let _ = shutdown_thread.join();
    Ok(())
}

#[cfg(windows)]
pub fn request_task_service_shutdown(
    shutdown_pipe_name: &str,
) -> Result<(), yuanyuan_bridge::SinkError> {
    request_task_service_shutdown_version(shutdown_pipe_name, AI_CONTROL_PROTOCOL_VERSION)
}

#[cfg(windows)]
pub fn request_task_service_shutdown_with_timeout(
    shutdown_pipe_name: &str,
    timeout: Duration,
) -> Result<(), yuanyuan_bridge::SinkError> {
    request_task_service_shutdown_version_with_timeout(
        shutdown_pipe_name,
        AI_CONTROL_PROTOCOL_VERSION,
        timeout,
    )
}

#[cfg(windows)]
pub fn request_task_service_shutdown_version(
    shutdown_pipe_name: &str,
    version: u16,
) -> Result<(), yuanyuan_bridge::SinkError> {
    let message = control_message("SHUTDOWN", version);
    yuanyuan_bridge::NamedPipeEventSink::new(shutdown_pipe_name)
        .map_err(|_| yuanyuan_bridge::SinkError::Rejected)?
        .send_validated_payload(&message)
}

#[cfg(windows)]
pub fn request_task_service_shutdown_version_with_timeout(
    shutdown_pipe_name: &str,
    version: u16,
    timeout: Duration,
) -> Result<(), yuanyuan_bridge::SinkError> {
    request_task_service_control_version_with_timeout(
        shutdown_pipe_name,
        "SHUTDOWN",
        version,
        timeout,
    )
}

#[cfg(windows)]
pub fn request_task_service_health(
    control_pipe_name: &str,
) -> Result<(), yuanyuan_bridge::SinkError> {
    request_task_service_health_version(control_pipe_name, AI_CONTROL_PROTOCOL_VERSION)
}

#[cfg(windows)]
pub fn request_task_service_health_with_timeout(
    control_pipe_name: &str,
    timeout: Duration,
) -> Result<(), yuanyuan_bridge::SinkError> {
    request_task_service_health_version_with_timeout(
        control_pipe_name,
        AI_CONTROL_PROTOCOL_VERSION,
        timeout,
    )
}

#[cfg(windows)]
pub fn request_task_service_health_version(
    control_pipe_name: &str,
    version: u16,
) -> Result<(), yuanyuan_bridge::SinkError> {
    let message = control_message("HEALTH", version);
    yuanyuan_bridge::NamedPipeEventSink::new(control_pipe_name)
        .map_err(|_| yuanyuan_bridge::SinkError::Rejected)?
        .send_validated_payload(&message)
}

#[cfg(windows)]
pub fn request_task_service_health_version_with_timeout(
    control_pipe_name: &str,
    version: u16,
    timeout: Duration,
) -> Result<(), yuanyuan_bridge::SinkError> {
    request_task_service_control_version_with_timeout(control_pipe_name, "HEALTH", version, timeout)
}

#[cfg(windows)]
fn request_task_service_control_version_with_timeout(
    control_pipe_name: &str,
    kind: &str,
    version: u16,
    timeout: Duration,
) -> Result<(), yuanyuan_bridge::SinkError> {
    if timeout.is_zero() {
        return Err(yuanyuan_bridge::SinkError::Rejected);
    }
    let message = control_message(kind, version);
    let acknowledgement =
        yuanyuan_bridge::NamedPipeEventSink::with_connect_timeout(control_pipe_name, timeout)
            .map_err(|_| yuanyuan_bridge::SinkError::Rejected)?
            .send_validated_payload_and_receive_response_with_timeout(
                &message,
                yuanyuan_bridge::DELIVERY_ACK_V1.len(),
                timeout,
            )?;
    if acknowledgement.as_slice() != yuanyuan_bridge::DELIVERY_ACK_V1 {
        return Err(yuanyuan_bridge::SinkError::Rejected);
    }
    Ok(())
}

#[cfg(windows)]
fn control_message(kind: &str, version: u16) -> Vec<u8> {
    format!("YUANYUAN_AI_{kind}_V{version}").into_bytes()
}

impl TaskStore {
    pub fn open(path: impl AsRef<Path>) -> Result<Self, TaskStoreError> {
        if let Some(parent) = path.as_ref().parent() {
            std::fs::create_dir_all(parent)
                .map_err(|_| rusqlite::Error::InvalidPath(parent.to_path_buf()))?;
        }
        let connection = Connection::open(path)?;
        Self::from_connection(connection)
    }

    pub fn open_in_memory() -> Result<Self, TaskStoreError> {
        Self::from_connection(Connection::open_in_memory()?)
    }

    fn from_connection(connection: Connection) -> Result<Self, TaskStoreError> {
        connection.busy_timeout(Duration::from_secs(1))?;
        connection.pragma_update(None, "foreign_keys", "ON")?;
        prepare_fresh_database_storage_policy(&connection)?;
        connection.pragma_update(None, "journal_mode", "WAL")?;
        initialize_ai_database(&connection)?;
        Ok(Self { connection })
    }

    /// Authenticates and durably commits a task event and its replay nonce in
    /// one immediate SQLite transaction. A caller may send the pipe ACK only
    /// after this method returns `Ok`.
    pub fn accept_authenticated<K: AuthenticationKeyResolver>(
        &mut self,
        input: &[u8],
        keys: &K,
        now_unix_ms: i64,
    ) -> Result<CommitOutcome, TaskStoreError> {
        let verified = verify_authenticated_signature_with_metadata(input, keys, now_unix_ms)?;
        let transaction = self
            .connection
            .transaction_with_behavior(TransactionBehavior::Immediate)?;
        let outcome = commit_verified(&transaction, &verified, now_unix_ms)?;
        transaction.commit()?;
        Ok(outcome)
    }

    pub fn task_count(&self) -> Result<u64, TaskStoreError> {
        Ok(self
            .connection
            .query_row("SELECT COUNT(*) FROM watched_tasks", [], |row| row.get(0))?)
    }

    pub fn event_count(&self) -> Result<u64, TaskStoreError> {
        Ok(self
            .connection
            .query_row("SELECT COUNT(*) FROM task_events", [], |row| row.get(0))?)
    }
}

fn prepare_fresh_database_storage_policy(connection: &Connection) -> Result<(), rusqlite::Error> {
    let version: u32 = connection.query_row("PRAGMA user_version", [], |row| row.get(0))?;
    if version != 0 {
        return Ok(());
    }
    let existing_user_tables: u64 = connection.query_row(
        "SELECT COUNT(*) FROM sqlite_master
         WHERE type = 'table' AND name NOT LIKE 'sqlite_%'",
        [],
        |row| row.get(0),
    )?;
    if existing_user_tables == 0 {
        connection.pragma_update(None, "auto_vacuum", "INCREMENTAL")?;
    }
    Ok(())
}

fn initialize_ai_database(connection: &Connection) -> Result<(), rusqlite::Error> {
    let mut version: u32 = connection.query_row("PRAGMA user_version", [], |row| row.get(0))?;
    if version == 0 {
        if let Err(error) = connection.execute_batch(SCHEMA_V1) {
            let _ = connection.execute_batch("ROLLBACK;");
            return Err(error);
        }
        version = 1;
    }
    if version == 1 {
        if let Err(error) = connection.execute_batch(SCHEMA_V2) {
            let _ = connection.execute_batch("ROLLBACK;");
            return Err(error);
        }
        version = 2;
    }
    if version == 2 {
        if let Err(error) = connection.execute_batch(SCHEMA_V3) {
            let _ = connection.execute_batch("ROLLBACK;");
            return Err(error);
        }
        version = 3;
    }
    if version == 3 {
        if let Err(error) = connection.execute_batch(SCHEMA_V4) {
            let _ = connection.execute_batch("ROLLBACK;");
            return Err(error);
        }
        version = 4;
    }
    if version != 4 {
        return Err(rusqlite::Error::InvalidQuery);
    }
    Ok(())
}

fn commit_verified(
    transaction: &Transaction<'_>,
    verified: &VerifiedAuthenticatedEvent,
    now_unix_ms: i64,
) -> Result<CommitOutcome, TaskStoreError> {
    let event = &verified.envelope.event;
    let existing: Option<(String, Vec<u8>)> = transaction
        .query_row(
            "SELECT key_id, nonce FROM task_events WHERE event_id = ?1",
            [&event.event_id],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .optional()?;
    if let Some((key_id, nonce)) = existing {
        return if key_id == verified.key_id && nonce == verified.nonce {
            Ok(CommitOutcome::AlreadyCommitted)
        } else {
            Err(TaskStoreError::Replay)
        };
    }

    transaction.execute(
        "DELETE FROM task_event_nonces WHERE expires_at_unix_ms < ?1",
        [now_unix_ms],
    )?;
    let nonce_inserted = transaction.execute(
        "INSERT OR IGNORE INTO task_event_nonces
         (key_id, nonce, expires_at_unix_ms) VALUES (?1, ?2, ?3)",
        params![verified.key_id, verified.nonce, verified.expires_at_unix_ms],
    )?;
    if nonce_inserted != 1 {
        return Err(TaskStoreError::Replay);
    }

    let task_key = task_key(&verified.envelope);
    let previous_task: Option<(String, Option<String>, String)> = transaction
        .query_row(
            "SELECT current_run_id, parent_task_id, latest_envelope_json
             FROM watched_tasks WHERE task_key = ?1",
            [&task_key],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
        )
        .optional()?;
    let (outcome, disposition, update_task, effective_parent_task_id) = match previous_task {
        None => (
            CommitOutcome::Applied,
            "applied",
            true,
            event.parent_task_id.clone(),
        ),
        Some((current_run_id, stored_parent_task_id, previous_json)) => {
            let previous: TaskEventEnvelope = serde_json::from_str(&previous_json)?;
            let old_run_reappeared = current_run_id != event.run_id
                && transaction.query_row(
                    "SELECT EXISTS(
                         SELECT 1 FROM task_events
                         WHERE task_key = ?1 AND run_id = ?2
                           AND disposition = 'applied'
                     )",
                    params![task_key, event.run_id],
                    |row| row.get::<_, bool>(0),
                )?;
            let parent_changed_within_run = current_run_id == event.run_id
                && stored_parent_task_id
                    .as_ref()
                    .zip(event.parent_task_id.as_ref())
                    .is_some_and(|(stored, next)| stored != next);
            let transition = if old_run_reappeared {
                Ok(TransitionDecision::IgnoreStale)
            } else if parent_changed_within_run {
                Err(yuanyuan_protocol::TransitionError::TaskIdentityMismatch(
                    "parent_task_id",
                ))
            } else {
                decide_transition(&previous.event, event)
            };
            let effective_parent_task_id = if current_run_id == event.run_id {
                event
                    .parent_task_id
                    .clone()
                    .or(stored_parent_task_id.clone())
            } else {
                event.parent_task_id.clone()
            };
            match transition {
                Ok(TransitionDecision::Apply)
                | Ok(TransitionDecision::StartNewRun)
                | Ok(TransitionDecision::CorrectTerminal) => (
                    CommitOutcome::Applied,
                    "applied",
                    true,
                    effective_parent_task_id,
                ),
                Ok(TransitionDecision::IgnoreStale) => (
                    CommitOutcome::IgnoredStale,
                    "ignored_stale",
                    false,
                    stored_parent_task_id,
                ),
                Ok(TransitionDecision::IgnoreRepeatedTerminal) => (
                    CommitOutcome::IgnoredRepeatedTerminal,
                    "ignored_repeated_terminal",
                    false,
                    stored_parent_task_id,
                ),
                Ok(TransitionDecision::IgnoreDuplicate) => (
                    CommitOutcome::AlreadyCommitted,
                    "duplicate",
                    false,
                    stored_parent_task_id,
                ),
                Err(_) => (
                    CommitOutcome::RejectedTransition,
                    "rejected_transition",
                    false,
                    stored_parent_task_id,
                ),
            }
        }
    };
    let envelope_json = serde_json::to_string(&verified.envelope)?;
    if update_task {
        transaction.execute(
            "INSERT INTO watched_tasks(
                task_key, connector_id, source_instance, source, workspace,
                external_id, task_id, current_run_id, parent_task_id, title,
                state, sequence, finality, evidence_level, latest_event_id,
                latest_envelope_json,
                created_at_unix_ms, updated_at_unix_ms
             ) VALUES(?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10,
                      ?11, ?12, ?13, ?14, ?15, ?16, ?17, ?17)
             ON CONFLICT(task_key) DO UPDATE SET
                current_run_id = excluded.current_run_id,
                parent_task_id = excluded.parent_task_id,
                title = excluded.title,
                state = excluded.state,
                sequence = excluded.sequence,
                finality = excluded.finality,
                evidence_level = excluded.evidence_level,
                latest_event_id = excluded.latest_event_id,
                latest_envelope_json = excluded.latest_envelope_json,
                updated_at_unix_ms = excluded.updated_at_unix_ms",
            params![
                task_key,
                event.connector_id,
                event.source_instance,
                event.source,
                event.workspace,
                event.external_id,
                event.task_id,
                event.run_id,
                effective_parent_task_id,
                event.title,
                enum_text(&event.state)?,
                i64::try_from(event.sequence).unwrap_or(i64::MAX),
                enum_text(&event.finality)?,
                enum_text(&event.evidence_level)?,
                event.event_id,
                envelope_json,
                now_unix_ms,
            ],
        )?;
    }
    transaction.execute(
        "INSERT INTO task_events(
            event_id, task_key, run_id, sequence, state, finality, key_id,
            nonce, envelope_json, disposition, persisted_at_unix_ms
         ) VALUES(?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)",
        params![
            event.event_id,
            task_key,
            event.run_id,
            i64::try_from(event.sequence).unwrap_or(i64::MAX),
            enum_text(&event.state)?,
            enum_text(&event.finality)?,
            verified.key_id,
            verified.nonce,
            envelope_json,
            disposition,
            now_unix_ms,
        ],
    )?;
    Ok(outcome)
}

fn task_key(envelope: &TaskEventEnvelope) -> String {
    let event = &envelope.event;
    let mut hash = Sha256::new();
    for value in [
        event.connector_id.as_str(),
        event.source_instance.as_str(),
        event.source.as_str(),
        event.workspace.as_deref().unwrap_or(""),
        event.external_id.as_str(),
        event.task_id.as_str(),
    ] {
        hash.update((value.len() as u32).to_be_bytes());
        hash.update(value.as_bytes());
    }
    hash.finalize()
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect()
}

fn enum_text<T: serde::Serialize>(value: &T) -> Result<String, serde_json::Error> {
    let encoded = serde_json::to_string(value)?;
    Ok(encoded.trim_matches('"').to_owned())
}

#[cfg(test)]
mod tests {
    use super::*;
    use yuanyuan_bridge::{seal_event, AuthenticationKey, KeyResolutionError, AUTH_NONCE_BYTES};
    use yuanyuan_protocol::{
        EventFinality, EvidenceLevel, EvidenceType, TaskEventV1, TaskState,
        TASK_EVENT_PROTOCOL_VERSION,
    };

    const NOW: i64 = 1_775_212_800_000;

    #[test]
    fn control_protocol_matrix_fails_closed_outside_the_shared_version() {
        assert_eq!(
            negotiate_control_protocol(1, 1, 1),
            ControlCompatibility::Compatible(1)
        );
        assert_eq!(
            negotiate_control_protocol(2, 3, 1),
            ControlCompatibility::AiTooOld
        );
        assert_eq!(
            negotiate_control_protocol(1, 1, 2),
            ControlCompatibility::AiTooNew
        );
        assert_eq!(
            negotiate_control_protocol(2, 1, 1),
            ControlCompatibility::InvalidRange
        );
    }

    #[test]
    fn crash_loop_opens_the_circuit_after_three_failures() {
        let started = std::time::Instant::now();
        let mut breaker = RestartCircuitBreaker::default();
        assert_eq!(
            breaker.record_failure(started),
            RestartDecision::RestartAfter(Duration::from_secs(1))
        );
        assert_eq!(
            breaker.record_failure(started + Duration::from_secs(1)),
            RestartDecision::RestartAfter(Duration::from_secs(2))
        );
        assert_eq!(
            breaker.record_failure(started + Duration::from_secs(2)),
            RestartDecision::OpenCircuit
        );
    }

    #[test]
    fn failures_expire_and_a_healthy_run_resets_backoff() {
        let started = std::time::Instant::now();
        let mut breaker = RestartCircuitBreaker::default();
        let _ = breaker.record_failure(started);
        assert_eq!(
            breaker.record_failure(started + Duration::from_secs(301)),
            RestartDecision::RestartAfter(Duration::from_secs(1))
        );
        breaker.record_healthy_run(Duration::from_secs(300));
        assert_eq!(
            breaker.record_failure(started + Duration::from_secs(302)),
            RestartDecision::RestartAfter(Duration::from_secs(1))
        );
    }

    struct Keys;
    impl AuthenticationKeyResolver for Keys {
        fn resolve(&self, key_id: &str) -> Result<AuthenticationKey, KeyResolutionError> {
            if key_id == "codex.test" {
                AuthenticationKey::new(vec![0x55; 32]).map_err(|_| KeyResolutionError::Unavailable)
            } else {
                Err(KeyResolutionError::UnknownOrRevoked)
            }
        }
    }

    fn signed(id: &str, sequence: u64, state: TaskState, nonce: u8) -> Vec<u8> {
        signed_with(id, sequence, state, nonce, |_| {})
    }

    fn signed_with(
        id: &str,
        sequence: u64,
        state: TaskState,
        nonce: u8,
        customize: impl FnOnce(&mut TaskEventV1),
    ) -> Vec<u8> {
        let finality = if state.is_terminal() {
            EventFinality::Terminal
        } else {
            EventFinality::Provisional
        };
        let mut envelope = TaskEventEnvelope {
            protocol_version: TASK_EVENT_PROTOCOL_VERSION,
            event: TaskEventV1 {
                event_id: id.into(),
                connector_id: "connector-1".into(),
                source_instance: "install-1".into(),
                task_id: "task-1".into(),
                run_id: "run-1".into(),
                parent_task_id: None,
                source: "openai.codex".into(),
                external_id: "thread-1".into(),
                title: "Build Yuanyuan".into(),
                workspace: Some("repo".into()),
                state,
                progress: None,
                summary: None,
                attention_reason: None,
                evidence_type: EvidenceType::Hook,
                evidence_level: EvidenceLevel::Authoritative,
                sequence,
                occurred_at: "2026-04-02T00:00:00Z".into(),
                received_at: "2026-04-02T00:00:00Z".into(),
                started_at: None,
                updated_at: "2026-04-02T00:00:00Z".into(),
                completed_at: state.is_terminal().then(|| "2026-04-02T00:00:00Z".into()),
                finality,
                return_action: None,
                payload_digest: "sha256:test".into(),
                raw_payload_ref: None,
            },
        };
        customize(&mut envelope.event);
        let key = AuthenticationKey::new(vec![0x55; 32]).unwrap();
        serde_json::to_vec(
            &seal_event(envelope, "codex.test", [nonce; AUTH_NONCE_BYTES], NOW, &key).unwrap(),
        )
        .unwrap()
    }

    #[test]
    fn fresh_ai_database_applies_every_migration_and_records_schema_metadata() {
        let store = TaskStore::open_in_memory().unwrap();
        let version: u32 = store
            .connection
            .query_row("PRAGMA user_version", [], |row| row.get(0))
            .unwrap();
        let migrations: u64 = store
            .connection
            .query_row("SELECT COUNT(*) FROM ai_schema_meta", [], |row| row.get(0))
            .unwrap();
        assert_eq!(version, 4);
        assert_eq!(migrations, 4);
        assert_eq!(
            store
                .connection
                .query_row("PRAGMA auto_vacuum", [], |row| row.get::<_, u32>(0))
                .unwrap(),
            2
        );
    }

    #[test]
    fn unknown_version_zero_database_is_not_silently_rewritten_for_auto_vacuum() {
        let connection = Connection::open_in_memory().unwrap();
        connection
            .execute("CREATE TABLE foreign_owner(value TEXT NOT NULL)", [])
            .unwrap();
        prepare_fresh_database_storage_policy(&connection).unwrap();
        assert_eq!(
            connection
                .query_row("PRAGMA auto_vacuum", [], |row| row.get::<_, u32>(0))
                .unwrap(),
            0
        );
    }

    #[test]
    fn read_only_expression_candidates_expose_no_task_text_or_workspace() {
        let directory = tempfile::tempdir().unwrap();
        let database = directory.path().join("expression.sqlite3");
        let mut store = TaskStore::open(&database).unwrap();
        store
            .accept_authenticated(
                &signed("evt-expression", 1, TaskState::Running, 41),
                &Keys,
                NOW,
            )
            .unwrap();
        store
            .connection
            .execute(
                "UPDATE watched_tasks SET
                    title = 'SENSITIVE-TITLE',
                    workspace = 'SENSITIVE-WORKSPACE',
                    latest_envelope_json = 'SENSITIVE-ENVELOPE'",
                [],
            )
            .unwrap();
        drop(store);

        let candidates = read_task_expression_candidates(&database).unwrap();
        assert_eq!(candidates.len(), 1);
        assert_eq!(candidates[0].source, TaskExpressionSource::Codex);
        assert_eq!(candidates[0].state, TaskState::Running);
        assert_eq!(candidates[0].updated_at_unix_ms, NOW);
        let debug = format!("{candidates:?}");
        assert!(!debug.contains("SENSITIVE"));
        assert!(!debug.contains("task-1"));
        assert!(!debug.contains("thread-1"));
    }

    #[test]
    fn non_authoritative_terminal_evidence_projects_to_unknown_expression() {
        let directory = tempfile::tempdir().unwrap();
        let database = directory.path().join("partial-terminal.sqlite3");
        let mut store = TaskStore::open(&database).unwrap();
        let partial_success = signed_with(
            "evt-partial-success",
            1,
            TaskState::Succeeded,
            70,
            |event| event.evidence_level = EvidenceLevel::Partial,
        );
        store
            .accept_authenticated(&partial_success, &Keys, NOW)
            .unwrap();
        let persisted: (String, String) = store
            .connection
            .query_row(
                "SELECT state, evidence_level FROM watched_tasks",
                [],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .unwrap();
        assert_eq!(persisted, ("succeeded".into(), "partial".into()));
        drop(store);

        let candidates = read_task_expression_candidates(&database).unwrap();
        assert_eq!(candidates.len(), 1);
        assert_eq!(candidates[0].state, TaskState::Unknown);

        let mut store = TaskStore::open(&database).unwrap();
        assert_eq!(
            store
                .accept_authenticated(
                    &signed("evt-authoritative-success", 2, TaskState::Succeeded, 71),
                    &Keys,
                    NOW + 1,
                )
                .unwrap(),
            CommitOutcome::Applied
        );
        drop(store);
        let candidates = read_task_expression_candidates(&database).unwrap();
        assert_eq!(candidates[0].state, TaskState::Succeeded);
    }

    #[test]
    fn codex_partial_completion_cannot_cross_the_database_as_certain_success() {
        use yuanyuan_connectors::{
            parse_connector_payload, ConnectorContext, ConnectorDisposition, ConnectorKind,
        };

        let payload = br#"{
            "type":"agent-turn-complete",
            "thread-id":"codex-thread-fixture-001",
            "timestamp":"2026-08-04T09:00:00Z",
            "sequence":10,
            "last_assistant_message":"must-not-cross"
        }"#;
        let context = ConnectorContext {
            connector_id: "connector-1".into(),
            source_instance: "install-1".into(),
            received_at: "2026-08-04T09:00:01Z".into(),
            ingress_sequence: 10,
            workspace_alias: Some("repo".into()),
        };
        let ConnectorDisposition::Event(parsed) =
            parse_connector_payload(ConnectorKind::CodexNotify, payload, &context).unwrap()
        else {
            panic!("Codex completion fixture should produce an event");
        };
        assert_eq!(parsed.envelope.event.state, TaskState::Succeeded);
        assert_eq!(parsed.envelope.event.evidence_level, EvidenceLevel::Partial);
        let key = AuthenticationKey::new(vec![0x55; 32]).unwrap();
        let signed = serde_json::to_vec(
            &seal_event(
                parsed.envelope,
                "codex.test",
                [72; AUTH_NONCE_BYTES],
                NOW,
                &key,
            )
            .unwrap(),
        )
        .unwrap();
        let directory = tempfile::tempdir().unwrap();
        let database = directory.path().join("codex-partial.sqlite3");
        let mut store = TaskStore::open(&database).unwrap();
        store.accept_authenticated(&signed, &Keys, NOW).unwrap();
        drop(store);

        let candidates = read_task_expression_candidates(&database).unwrap();
        assert_eq!(candidates.len(), 1);
        assert_eq!(candidates[0].state, TaskState::Unknown);
        assert!(!format!("{candidates:?}").contains("must-not-cross"));
    }

    #[test]
    fn decisive_expression_states_require_authoritative_evidence() {
        for state in [
            TaskState::WaitingUser,
            TaskState::Succeeded,
            TaskState::Failed,
            TaskState::Cancelled,
        ] {
            for level in ["partial", "presence_only", "unknown"] {
                assert_eq!(
                    project_task_expression_state(state, level),
                    Some(TaskState::Unknown)
                );
            }
            assert_eq!(
                project_task_expression_state(state, "authoritative"),
                Some(state)
            );
        }
        assert_eq!(
            project_task_expression_state(TaskState::Running, "partial"),
            Some(TaskState::Running)
        );
        assert_eq!(
            project_task_expression_state(TaskState::Stalled, "unknown"),
            Some(TaskState::Stalled)
        );
        assert_eq!(
            project_task_expression_state(TaskState::Running, "invented"),
            None
        );
    }

    #[test]
    fn expression_candidate_reader_never_creates_or_migrates_a_database() {
        let directory = tempfile::tempdir().unwrap();
        let missing = directory.path().join("missing.sqlite3");
        assert!(read_task_expression_candidates(&missing)
            .unwrap()
            .is_empty());
        assert!(!missing.exists());

        let missing_parent = directory.path().join("not-created").join("missing.sqlite3");
        assert!(read_task_expression_candidates(&missing_parent)
            .unwrap()
            .is_empty());
        assert!(!missing_parent.parent().unwrap().exists());

        assert!(matches!(
            read_task_expression_candidates(directory.path()),
            Err(TaskExpressionReadError::UnsafePath)
        ));

        let legacy = directory.path().join("legacy.sqlite3");
        let connection = Connection::open(&legacy).unwrap();
        connection.execute_batch(SCHEMA_V1).unwrap();
        drop(connection);
        assert!(matches!(
            read_task_expression_candidates(&legacy),
            Err(TaskExpressionReadError::UnsupportedSchema)
        ));
        let version: u32 = Connection::open(&legacy)
            .unwrap()
            .query_row("PRAGMA user_version", [], |row| row.get(0))
            .unwrap();
        assert_eq!(version, 1);
    }

    #[test]
    fn corrupted_expression_identity_fields_fail_closed() {
        let directory = tempfile::tempdir().unwrap();
        let database = directory.path().join("corrupt.sqlite3");
        let mut store = TaskStore::open(&database).unwrap();
        store
            .accept_authenticated(
                &signed("evt-corrupt", 1, TaskState::Running, 42),
                &Keys,
                NOW,
            )
            .unwrap();
        store
            .connection
            .execute("UPDATE watched_tasks SET source = 'unknown.source'", [])
            .unwrap();
        drop(store);
        assert!(matches!(
            read_task_expression_candidates(&database),
            Err(TaskExpressionReadError::InvalidFixedField)
        ));

        let connection = Connection::open(&database).unwrap();
        connection
            .execute(
                "UPDATE watched_tasks
                 SET source = 'openai.codex', updated_at_unix_ms = -1",
                [],
            )
            .unwrap();
        drop(connection);
        assert!(matches!(
            read_task_expression_candidates(&database),
            Err(TaskExpressionReadError::InvalidFixedField)
        ));
    }

    #[test]
    fn version_one_task_data_survives_the_memory_migration() {
        let connection = Connection::open_in_memory().unwrap();
        connection.execute_batch(SCHEMA_V1).unwrap();
        connection
            .execute(
                "INSERT INTO watched_tasks(
                    task_key, connector_id, source_instance, source, workspace,
                    external_id, task_id, current_run_id, parent_task_id, title,
                    state, sequence, finality, latest_event_id, latest_envelope_json,
                    created_at_unix_ms, updated_at_unix_ms
                 ) VALUES(
                    'task-key', 'connector-1', 'install-1', 'openai.codex', NULL,
                    'external-1', 'task-1', 'run-1', NULL, 'Existing task',
                    'running', 1, 'provisional', 'event-1', '{}', ?1, ?1
                 )",
                [NOW],
            )
            .unwrap();

        let store = TaskStore::from_connection(connection).unwrap();
        assert_eq!(store.task_count().unwrap(), 1);
        assert_eq!(
            store
                .connection
                .query_row("PRAGMA auto_vacuum", [], |row| row.get::<_, u32>(0))
                .unwrap(),
            0
        );
        assert_eq!(
            store
                .connection
                .query_row("PRAGMA user_version", [], |row| row.get::<_, u32>(0))
                .unwrap(),
            4
        );
        assert_eq!(
            store
                .connection
                .query_row("SELECT COUNT(*) FROM memories", [], |row| row
                    .get::<_, u64>(0))
                .unwrap(),
            0
        );
    }

    #[test]
    fn version_two_tombstones_survive_the_support_preference_migration() {
        let connection = Connection::open_in_memory().unwrap();
        connection.execute_batch(SCHEMA_V1).unwrap();
        connection.execute_batch(SCHEMA_V2).unwrap();
        connection
            .execute(
                "INSERT INTO deletion_tombstones(
                    entity_type, entity_id, content_digest,
                    deleted_at_unix_ms, retain_until_unix_ms
                 ) VALUES('memory', 'deleted-memory', ?1, ?2, ?3)",
                params![vec![7_u8; 32], NOW, NOW + 10_000],
            )
            .unwrap();

        let store = TaskStore::from_connection(connection).unwrap();
        assert_eq!(
            store
                .connection
                .query_row("PRAGMA user_version", [], |row| row.get::<_, u32>(0))
                .unwrap(),
            4
        );
        assert_eq!(
            store
                .connection
                .query_row(
                    "SELECT COUNT(*) FROM deletion_tombstones
                     WHERE entity_type = 'memory' AND entity_id = 'deleted-memory'",
                    [],
                    |row| row.get::<_, u64>(0),
                )
                .unwrap(),
            1
        );
        assert_eq!(
            store
                .connection
                .query_row("SELECT COUNT(*) FROM support_preferences", [], |row| {
                    row.get::<_, u64>(0)
                })
                .unwrap(),
            0
        );
    }

    #[test]
    fn version_three_tasks_migrate_with_unknown_evidence_until_refreshed() {
        let connection = Connection::open_in_memory().unwrap();
        connection.execute_batch(SCHEMA_V1).unwrap();
        connection.execute_batch(SCHEMA_V2).unwrap();
        connection.execute_batch(SCHEMA_V3).unwrap();
        connection
            .execute(
                "INSERT INTO watched_tasks(
                    task_key, connector_id, source_instance, source, workspace,
                    external_id, task_id, current_run_id, parent_task_id, title,
                    state, sequence, finality, latest_event_id, latest_envelope_json,
                    created_at_unix_ms, updated_at_unix_ms
                 ) VALUES(
                    'legacy-task', 'connector-1', 'install-1', 'openai.codex', NULL,
                    'external-1', 'task-1', 'run-1', NULL, 'Legacy task',
                    'succeeded', 1, 'terminal', 'event-1', '{}', ?1, ?1
                 )",
                [NOW],
            )
            .unwrap();

        let store = TaskStore::from_connection(connection).unwrap();
        let migrated: (u32, String, u64) = store
            .connection
            .query_row(
                "SELECT
                    (SELECT user_version FROM pragma_user_version),
                    evidence_level,
                    (SELECT COUNT(*) FROM ai_schema_meta WHERE schema_version = 4)
                 FROM watched_tasks WHERE task_key = 'legacy-task'",
                [],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
            )
            .unwrap();
        assert_eq!(migrated, (4, "unknown".into(), 1));
    }

    #[test]
    fn failed_evidence_projection_migration_preserves_version_three() {
        let directory = tempfile::tempdir().unwrap();
        let database = directory.path().join("evidence-migration-failure.sqlite3");
        let connection = Connection::open(&database).unwrap();
        connection.execute_batch(SCHEMA_V1).unwrap();
        connection.execute_batch(SCHEMA_V2).unwrap();
        connection.execute_batch(SCHEMA_V3).unwrap();
        connection
            .execute(
                "ALTER TABLE watched_tasks ADD COLUMN evidence_level TEXT NOT NULL DEFAULT 'blocker'",
                [],
            )
            .unwrap();
        drop(connection);

        assert!(TaskStore::open(&database).is_err());
        let connection = Connection::open(&database).unwrap();
        assert_eq!(
            connection
                .query_row("PRAGMA user_version", [], |row| row.get::<_, u32>(0))
                .unwrap(),
            3
        );
        assert_eq!(
            connection
                .query_row(
                    "SELECT MAX(schema_version) FROM ai_schema_meta",
                    [],
                    |row| row.get::<_, u32>(0),
                )
                .unwrap(),
            3
        );
        assert_eq!(
            connection
                .query_row(
                    "SELECT dflt_value FROM pragma_table_info('watched_tasks')
                     WHERE name = 'evidence_level'",
                    [],
                    |row| row.get::<_, String>(0),
                )
                .unwrap(),
            "'blocker'"
        );
    }

    #[test]
    fn failed_support_preference_migration_preserves_the_version_two_database() {
        let directory = tempfile::tempdir().unwrap();
        let database = directory
            .path()
            .join("support-preference-migration-failure.sqlite3");
        let connection = Connection::open(&database).unwrap();
        connection.execute_batch(SCHEMA_V1).unwrap();
        connection.execute_batch(SCHEMA_V2).unwrap();
        connection
            .execute(
                "INSERT INTO deletion_tombstones(
                    entity_type, entity_id, content_digest,
                    deleted_at_unix_ms, retain_until_unix_ms
                 ) VALUES('memory', 'keep-this-tombstone', ?1, ?2, ?3)",
                params![vec![9_u8; 32], NOW, NOW + 10_000],
            )
            .unwrap();
        connection
            .execute_batch("CREATE TABLE support_preferences(blocker INTEGER NOT NULL);")
            .unwrap();
        drop(connection);

        assert!(TaskStore::open(&database).is_err());
        let connection = Connection::open(&database).unwrap();
        assert_eq!(
            connection
                .query_row("PRAGMA user_version", [], |row| row.get::<_, u32>(0))
                .unwrap(),
            2
        );
        assert_eq!(
            connection
                .query_row(
                    "SELECT MAX(schema_version) FROM ai_schema_meta",
                    [],
                    |row| { row.get::<_, u32>(0) },
                )
                .unwrap(),
            2
        );
        assert_eq!(
            connection
                .query_row(
                    "SELECT COUNT(*) FROM deletion_tombstones
                     WHERE entity_type = 'memory' AND entity_id = 'keep-this-tombstone'",
                    [],
                    |row| row.get::<_, u64>(0),
                )
                .unwrap(),
            1
        );
        assert_eq!(
            connection
                .query_row(
                    "SELECT COUNT(*) FROM pragma_table_info('support_preferences')",
                    [],
                    |row| row.get::<_, u64>(0),
                )
                .unwrap(),
            1
        );
    }

    #[test]
    fn failed_memory_migration_rolls_back_all_version_two_objects() {
        let directory = tempfile::tempdir().unwrap();
        let database = directory.path().join("migration-failure.sqlite3");
        let connection = Connection::open(&database).unwrap();
        connection.execute_batch(SCHEMA_V1).unwrap();
        connection
            .execute_batch("CREATE TABLE memories(blocker INTEGER NOT NULL);")
            .unwrap();
        drop(connection);

        assert!(TaskStore::open(&database).is_err());
        let connection = Connection::open(&database).unwrap();
        assert_eq!(
            connection
                .query_row("PRAGMA user_version", [], |row| row.get::<_, u32>(0))
                .unwrap(),
            1
        );
        let schema_meta_exists: bool = connection
            .query_row(
                "SELECT EXISTS(
                   SELECT 1 FROM sqlite_master
                   WHERE type = 'table' AND name = 'ai_schema_meta'
                 )",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert!(!schema_meta_exists);
        assert_eq!(
            connection
                .query_row(
                    "SELECT COUNT(*) FROM pragma_table_info('memories')",
                    [],
                    |row| row.get::<_, u64>(0),
                )
                .unwrap(),
            1
        );
    }

    #[test]
    fn commits_nonce_event_and_task_atomically() {
        let mut store = TaskStore::open_in_memory().unwrap();
        let input = signed("evt-1", 1, TaskState::Running, 1);
        assert_eq!(
            store.accept_authenticated(&input, &Keys, NOW).unwrap(),
            CommitOutcome::Applied
        );
        assert_eq!(store.task_count().unwrap(), 1);
        assert_eq!(store.event_count().unwrap(), 1);
        assert_eq!(
            store.accept_authenticated(&input, &Keys, NOW).unwrap(),
            CommitOutcome::AlreadyCommitted
        );
        assert_eq!(store.event_count().unwrap(), 1);
    }

    #[test]
    fn applies_newer_state_and_persists_stale_events_without_regression() {
        let mut store = TaskStore::open_in_memory().unwrap();
        store
            .accept_authenticated(&signed("evt-2", 2, TaskState::Running, 2), &Keys, NOW)
            .unwrap();
        assert_eq!(
            store
                .accept_authenticated(&signed("evt-1", 1, TaskState::Queued, 3), &Keys, NOW)
                .unwrap(),
            CommitOutcome::IgnoredStale
        );
        let state: String = store
            .connection
            .query_row("SELECT state FROM watched_tasks", [], |row| row.get(0))
            .unwrap();
        assert_eq!(state, "running");
        assert_eq!(store.event_count().unwrap(), 2);
    }

    #[test]
    fn active_run_replacement_is_audited_without_regressing_the_current_run() {
        let mut store = TaskStore::open_in_memory().unwrap();
        store
            .accept_authenticated(&signed("evt-run-1", 1, TaskState::Running, 50), &Keys, NOW)
            .unwrap();
        let replacement = signed_with("evt-run-2", 2, TaskState::Running, 51, |event| {
            event.run_id = "run-2".into()
        });

        assert_eq!(
            store
                .accept_authenticated(&replacement, &Keys, NOW)
                .unwrap(),
            CommitOutcome::RejectedTransition
        );
        let current: (String, String, String) = store
            .connection
            .query_row(
                "SELECT current_run_id, state, latest_event_id FROM watched_tasks",
                [],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
            )
            .unwrap();
        assert_eq!(
            current,
            ("run-1".into(), "running".into(), "evt-run-1".into())
        );
        let disposition: String = store
            .connection
            .query_row(
                "SELECT disposition FROM task_events WHERE event_id = 'evt-run-2'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(disposition, "rejected_transition");
    }

    #[test]
    fn a_previously_rejected_run_may_start_after_the_current_run_finishes() {
        let mut store = TaskStore::open_in_memory().unwrap();
        store
            .accept_authenticated(
                &signed("evt-current-1", 1, TaskState::Running, 66),
                &Keys,
                NOW,
            )
            .unwrap();
        let premature = signed_with("evt-next-premature", 2, TaskState::Running, 67, |event| {
            event.run_id = "run-2".into()
        });
        assert_eq!(
            store.accept_authenticated(&premature, &Keys, NOW).unwrap(),
            CommitOutcome::RejectedTransition
        );
        store
            .accept_authenticated(
                &signed("evt-current-done", 3, TaskState::Succeeded, 68),
                &Keys,
                NOW,
            )
            .unwrap();
        let next_run = signed_with("evt-next-started", 4, TaskState::Running, 69, |event| {
            event.run_id = "run-2".into()
        });

        assert_eq!(
            store.accept_authenticated(&next_run, &Keys, NOW).unwrap(),
            CommitOutcome::Applied
        );
        let current_run: String = store
            .connection
            .query_row("SELECT current_run_id FROM watched_tasks", [], |row| {
                row.get(0)
            })
            .unwrap();
        assert_eq!(current_run, "run-2");
    }

    #[test]
    fn completed_task_can_start_a_new_run_but_an_old_run_cannot_reappear() {
        let mut store = TaskStore::open_in_memory().unwrap();
        store
            .accept_authenticated(
                &signed("evt-old-terminal", 1, TaskState::Failed, 52),
                &Keys,
                NOW,
            )
            .unwrap();
        let new_run = signed_with("evt-new-running", 2, TaskState::Running, 53, |event| {
            event.run_id = "run-2".into()
        });
        assert_eq!(
            store.accept_authenticated(&new_run, &Keys, NOW).unwrap(),
            CommitOutcome::Applied
        );

        let old_run_reappears = signed("evt-old-late", 3, TaskState::Running, 54);
        assert_eq!(
            store
                .accept_authenticated(&old_run_reappears, &Keys, NOW)
                .unwrap(),
            CommitOutcome::IgnoredStale
        );
        let current: (String, String, String) = store
            .connection
            .query_row(
                "SELECT current_run_id, state, latest_event_id FROM watched_tasks",
                [],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
            )
            .unwrap();
        assert_eq!(
            current,
            ("run-2".into(), "running".into(), "evt-new-running".into())
        );
    }

    #[test]
    fn parent_relationship_is_late_bound_preserved_and_not_silently_rewritten() {
        let mut store = TaskStore::open_in_memory().unwrap();
        let child_started = signed_with("evt-child-1", 1, TaskState::Running, 55, |event| {
            event.task_id = "task-child".into();
            event.external_id = "thread-child".into();
        });
        store
            .accept_authenticated(&child_started, &Keys, NOW)
            .unwrap();
        let parent_discovered = signed_with("evt-child-2", 2, TaskState::Stalled, 56, |event| {
            event.task_id = "task-child".into();
            event.external_id = "thread-child".into();
            event.parent_task_id = Some("task-parent".into());
        });
        assert_eq!(
            store
                .accept_authenticated(&parent_discovered, &Keys, NOW)
                .unwrap(),
            CommitOutcome::Applied
        );
        let parent_omitted = signed_with("evt-child-3", 3, TaskState::Running, 57, |event| {
            event.task_id = "task-child".into();
            event.external_id = "thread-child".into();
        });
        assert_eq!(
            store
                .accept_authenticated(&parent_omitted, &Keys, NOW)
                .unwrap(),
            CommitOutcome::Applied
        );
        let reparented = signed_with("evt-child-4", 4, TaskState::Stalled, 58, |event| {
            event.task_id = "task-child".into();
            event.external_id = "thread-child".into();
            event.parent_task_id = Some("task-other-parent".into());
        });
        assert_eq!(
            store.accept_authenticated(&reparented, &Keys, NOW).unwrap(),
            CommitOutcome::RejectedTransition
        );

        let current: (Option<String>, String, String) = store
            .connection
            .query_row(
                "SELECT parent_task_id, state, latest_event_id FROM watched_tasks",
                [],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
            )
            .unwrap();
        assert_eq!(
            current,
            (
                Some("task-parent".into()),
                "running".into(),
                "evt-child-3".into()
            )
        );
        assert_eq!(store.event_count().unwrap(), 4);
    }

    #[test]
    fn parent_and_child_may_arrive_in_either_order_and_remain_distinct_tasks() {
        let mut store = TaskStore::open_in_memory().unwrap();
        let child = signed_with("evt-child", 1, TaskState::Running, 59, |event| {
            event.task_id = "task-child".into();
            event.external_id = "thread-child".into();
            event.parent_task_id = Some("task-parent".into());
        });
        let parent = signed_with("evt-parent", 1, TaskState::Running, 60, |event| {
            event.task_id = "task-parent".into();
            event.external_id = "thread-parent".into();
        });

        store.accept_authenticated(&child, &Keys, NOW).unwrap();
        store.accept_authenticated(&parent, &Keys, NOW).unwrap();
        assert_eq!(store.task_count().unwrap(), 2);
        let relationship: Option<String> = store
            .connection
            .query_row(
                "SELECT parent_task_id FROM watched_tasks WHERE task_id = 'task-child'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(relationship.as_deref(), Some("task-parent"));
    }

    #[test]
    fn identical_task_identity_is_isolated_by_workspace() {
        let mut store = TaskStore::open_in_memory().unwrap();
        let workspace_a = signed_with("evt-a-1", 1, TaskState::Running, 61, |event| {
            event.workspace = Some("workspace-a".into());
        });
        let workspace_b = signed_with("evt-b-1", 1, TaskState::Running, 62, |event| {
            event.workspace = Some("workspace-b".into());
        });
        store
            .accept_authenticated(&workspace_a, &Keys, NOW)
            .unwrap();
        store
            .accept_authenticated(&workspace_b, &Keys, NOW)
            .unwrap();
        let workspace_a_stalled = signed_with("evt-a-2", 2, TaskState::Stalled, 63, |event| {
            event.workspace = Some("workspace-a".into());
        });
        store
            .accept_authenticated(&workspace_a_stalled, &Keys, NOW)
            .unwrap();

        let states: Vec<(String, String)> = store
            .connection
            .prepare("SELECT workspace, state FROM watched_tasks ORDER BY workspace")
            .unwrap()
            .query_map([], |row| Ok((row.get(0)?, row.get(1)?)))
            .unwrap()
            .collect::<Result<_, _>>()
            .unwrap();
        assert_eq!(
            states,
            vec![
                ("workspace-a".into(), "stalled".into()),
                ("workspace-b".into(), "running".into())
            ]
        );
    }

    #[test]
    fn corrected_terminal_updates_the_summary_without_erasing_original_evidence() {
        let mut store = TaskStore::open_in_memory().unwrap();
        store
            .accept_authenticated(&signed("evt-failed", 1, TaskState::Failed, 64), &Keys, NOW)
            .unwrap();
        let corrected = signed_with("evt-corrected", 2, TaskState::Succeeded, 65, |event| {
            event.finality = EventFinality::Corrected
        });
        assert_eq!(
            store.accept_authenticated(&corrected, &Keys, NOW).unwrap(),
            CommitOutcome::Applied
        );

        let summary: (String, String, String) = store
            .connection
            .query_row(
                "SELECT state, finality, latest_event_id FROM watched_tasks",
                [],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
            )
            .unwrap();
        assert_eq!(
            summary,
            (
                "succeeded".into(),
                "corrected".into(),
                "evt-corrected".into()
            )
        );
        let evidence: Vec<(String, String)> = store
            .connection
            .prepare("SELECT event_id, finality FROM task_events ORDER BY sequence")
            .unwrap()
            .query_map([], |row| Ok((row.get(0)?, row.get(1)?)))
            .unwrap()
            .collect::<Result<_, _>>()
            .unwrap();
        assert_eq!(
            evidence,
            vec![
                ("evt-failed".into(), "terminal".into()),
                ("evt-corrected".into(), "corrected".into())
            ]
        );
    }

    #[test]
    fn failed_event_insert_rolls_back_the_nonce_and_task() {
        let mut store = TaskStore::open_in_memory().unwrap();
        store.connection.execute_batch("CREATE TRIGGER reject_event BEFORE INSERT ON task_events BEGIN SELECT RAISE(ABORT, 'test'); END;").unwrap();
        let input = signed("evt-1", 1, TaskState::Running, 4);
        assert!(store.accept_authenticated(&input, &Keys, NOW).is_err());
        assert_eq!(store.task_count().unwrap(), 0);
        store
            .connection
            .execute_batch("DROP TRIGGER reject_event;")
            .unwrap();
        assert_eq!(
            store.accept_authenticated(&input, &Keys, NOW).unwrap(),
            CommitOutcome::Applied
        );
    }

    #[test]
    fn sqlite_full_rolls_back_the_failed_nonce_event_and_task_update() {
        let directory = tempfile::tempdir().unwrap();
        let database = directory.path().join("disk-full.sqlite3");
        let mut store = TaskStore::open(&database).unwrap();
        let page_count: i64 = store
            .connection
            .query_row("PRAGMA page_count", [], |row| row.get(0))
            .unwrap();
        store
            .connection
            .pragma_update(None, "max_page_count", page_count + 1)
            .unwrap();

        let mut failed = None;
        for sequence in 1_u64..=200 {
            let input = signed(
                &format!("evt-disk-full-{sequence}"),
                sequence,
                TaskState::Running,
                sequence as u8,
            );
            let events_before = store.event_count().unwrap();
            match store.accept_authenticated(&input, &Keys, NOW) {
                Ok(_) => {}
                Err(TaskStoreError::Database(rusqlite::Error::SqliteFailure(code, _)))
                    if code.code == rusqlite::ffi::ErrorCode::DiskFull =>
                {
                    assert_eq!(store.event_count().unwrap(), events_before);
                    let nonce_count: u64 = store
                        .connection
                        .query_row(
                            "SELECT COUNT(*) FROM task_event_nonces WHERE nonce = ?1",
                            [vec![sequence as u8; AUTH_NONCE_BYTES]],
                            |row| row.get(0),
                        )
                        .unwrap();
                    assert_eq!(nonce_count, 0);
                    failed = Some(input);
                    break;
                }
                Err(error) => panic!("unexpected disk-full result: {error:?}"),
            }
        }
        let failed = failed.expect("page limit should inject SQLITE_FULL");

        store
            .connection
            .pragma_update(None, "max_page_count", 1_073_741_823_i64)
            .unwrap();
        assert_eq!(
            store.accept_authenticated(&failed, &Keys, NOW).unwrap(),
            CommitOutcome::Applied
        );
    }

    #[test]
    fn sqlite_writer_contention_writes_nothing_and_recovers_after_release() {
        let directory = tempfile::tempdir().unwrap();
        let database = directory.path().join("writer-contention.sqlite3");
        let mut store = TaskStore::open(&database).unwrap();
        let blocker = Connection::open(&database).unwrap();
        blocker.execute_batch("BEGIN IMMEDIATE;").unwrap();
        let input = signed("evt-writer-contention", 1, TaskState::Running, 42);

        let error = store.accept_authenticated(&input, &Keys, NOW).unwrap_err();
        assert!(matches!(
            error,
            TaskStoreError::Database(rusqlite::Error::SqliteFailure(code, _))
                if matches!(
                    code.code,
                    rusqlite::ffi::ErrorCode::DatabaseBusy
                        | rusqlite::ffi::ErrorCode::DatabaseLocked
                )
        ));
        assert_eq!(store.task_count().unwrap(), 0);
        assert_eq!(store.event_count().unwrap(), 0);

        blocker.execute_batch("ROLLBACK;").unwrap();
        assert_eq!(
            store.accept_authenticated(&input, &Keys, NOW).unwrap(),
            CommitOutcome::Applied
        );
    }

    #[test]
    fn readonly_database_handle_rejects_without_consuming_the_event() {
        let directory = tempfile::tempdir().unwrap();
        let database = directory.path().join("readonly.sqlite3");
        drop(TaskStore::open(&database).unwrap());
        let connection =
            Connection::open_with_flags(&database, rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY)
                .unwrap();
        let mut readonly = TaskStore::from_connection(connection).unwrap();
        let input = signed("evt-readonly", 1, TaskState::Running, 43);

        let error = readonly
            .accept_authenticated(&input, &Keys, NOW)
            .unwrap_err();
        assert!(matches!(
            error,
            TaskStoreError::Database(rusqlite::Error::SqliteFailure(code, _))
                if code.code == rusqlite::ffi::ErrorCode::ReadOnly
        ));
        assert_eq!(readonly.task_count().unwrap(), 0);
        assert_eq!(readonly.event_count().unwrap(), 0);
        drop(readonly);

        let mut writable = TaskStore::open(&database).unwrap();
        assert_eq!(
            writable.accept_authenticated(&input, &Keys, NOW).unwrap(),
            CommitOutcome::Applied
        );
    }

    #[cfg(windows)]
    #[test]
    fn exclusive_file_occupancy_fails_cleanly_and_reopens_after_release() {
        use std::os::windows::fs::OpenOptionsExt;

        let directory = tempfile::tempdir().unwrap();
        let database = directory.path().join("exclusive.sqlite3");
        drop(TaskStore::open(&database).unwrap());
        let exclusive = std::fs::OpenOptions::new()
            .read(true)
            .write(true)
            .share_mode(0)
            .open(&database)
            .unwrap();

        assert!(TaskStore::open(&database).is_err());
        drop(exclusive);
        assert!(TaskStore::open(&database).is_ok());
    }

    #[test]
    fn authentication_failure_writes_nothing() {
        let mut store = TaskStore::open_in_memory().unwrap();
        let mut input = signed("evt-1", 1, TaskState::Running, 5);
        *input.last_mut().unwrap() ^= 1;
        assert!(matches!(
            store.accept_authenticated(&input, &Keys, NOW),
            Err(TaskStoreError::Authentication(_))
        ));
        assert_eq!(store.task_count().unwrap(), 0);
        assert_eq!(store.event_count().unwrap(), 0);
    }

    #[test]
    fn startup_replay_commits_then_removes_a_staged_event() {
        let directory = tempfile::tempdir().unwrap();
        let spool = Spool::open(directory.path(), yuanyuan_bridge::SpoolLimits::default()).unwrap();
        let input = signed("evt-spool", 1, TaskState::Running, 7);
        assert_eq!(
            spool.enqueue(&input, NOW).unwrap(),
            yuanyuan_bridge::SpoolEnqueueOutcome::Stored
        );
        let mut store = TaskStore::open_in_memory().unwrap();
        let report = replay_authenticated_spool(&spool, &mut store, &Keys, NOW).unwrap();
        assert_eq!(report.acknowledged, 1);
        assert_eq!(store.event_count().unwrap(), 1);
        assert_eq!(
            replay_authenticated_spool(&spool, &mut store, &Keys, NOW).unwrap(),
            ReplayReport::default()
        );
    }

    #[cfg(windows)]
    #[test]
    fn pipe_ack_is_emitted_only_after_the_ai_transaction_commits() {
        use std::{sync::mpsc, thread, time::Duration};
        use yuanyuan_bridge::{NamedPipeEventSink, WindowsNamedPipeServer};

        let logical_name = format!("yuanyuan.ai.commit-test.{}", std::process::id());
        let server_name = logical_name.clone();
        let (ready_sender, ready_receiver) = mpsc::sync_channel(1);
        let worker = thread::spawn(move || {
            let server = WindowsNamedPipeServer::bind(&server_name).unwrap();
            ready_sender.send(()).unwrap();
            let mut store = TaskStore::open_in_memory().unwrap();
            let outcome = receive_commit_and_ack_one(server, &mut store, &Keys, NOW).unwrap();
            (
                outcome,
                store.task_count().unwrap(),
                store.event_count().unwrap(),
            )
        });
        ready_receiver.recv_timeout(Duration::from_secs(1)).unwrap();

        let client = NamedPipeEventSink::new(&logical_name).unwrap();
        assert_eq!(
            client.send_validated_payload(&signed("evt-pipe", 1, TaskState::Running, 6)),
            Ok(())
        );
        assert_eq!(worker.join().unwrap(), (CommitOutcome::Applied, 1, 1));
    }

    #[cfg(windows)]
    #[test]
    fn invalid_pipe_event_receives_no_ack_and_writes_nothing() {
        use std::{sync::mpsc, thread, time::Duration};
        use yuanyuan_bridge::{NamedPipeEventSink, SinkError, WindowsNamedPipeServer};

        let logical_name = format!("yuanyuan.ai.reject-test.{}", std::process::id());
        let server_name = logical_name.clone();
        let (ready_sender, ready_receiver) = mpsc::sync_channel(1);
        let worker = thread::spawn(move || {
            let server = WindowsNamedPipeServer::bind(&server_name).unwrap();
            ready_sender.send(()).unwrap();
            let mut store = TaskStore::open_in_memory().unwrap();
            assert!(receive_commit_and_ack_one(server, &mut store, &Keys, NOW).is_err());
            (store.task_count().unwrap(), store.event_count().unwrap())
        });
        ready_receiver.recv_timeout(Duration::from_secs(1)).unwrap();

        let client = NamedPipeEventSink::new(&logical_name).unwrap();
        assert_eq!(
            client.send_validated_payload(b"not-an-authenticated-event"),
            Err(SinkError::Unavailable)
        );
        assert_eq!(worker.join().unwrap(), (0, 0));
    }

    #[cfg(windows)]
    #[test]
    fn continuous_service_commits_events_and_exits_through_shutdown_pipe() {
        use std::{sync::mpsc, thread, time::Duration};
        use yuanyuan_bridge::NamedPipeEventSink;

        let suffix = format!("{}", std::process::id());
        let task_pipe = format!("yuanyuan.ai.service-test.{suffix}");
        let shutdown_pipe = format!("yuanyuan.ai.service-test.{suffix}.shutdown");
        let task_for_worker = task_pipe.clone();
        let shutdown_for_worker = shutdown_pipe.clone();
        let directory = tempfile::tempdir().unwrap();
        let database = directory.path().join("ai.sqlite3");
        let database_for_worker = database.clone();
        let (ready_sender, ready_receiver) = mpsc::sync_channel(1);
        let (done_sender, done_receiver) = mpsc::sync_channel(1);
        let worker = thread::spawn(move || {
            let mut store = TaskStore::open(&database_for_worker).unwrap();
            let result = run_task_service_with_ready(
                &task_for_worker,
                &shutdown_for_worker,
                &mut store,
                &Keys,
                || NOW,
                move || ready_sender.send(()).unwrap(),
            );
            done_sender.send(result).unwrap();
        });

        // Parallel workspace load can delay the worker after both pipe servers
        // are bound; use the existing hard transport budget for test liveness.
        ready_receiver
            .recv_timeout(yuanyuan_bridge::HARD_DELIVERY_TIMEOUT)
            .unwrap();
        let client = NamedPipeEventSink::new(&task_pipe).unwrap();
        let input = signed("evt-service", 1, TaskState::Running, 8);
        let mut delivered = false;
        for _ in 0..20 {
            if client.send_validated_payload(&input).is_ok() {
                delivered = true;
                break;
            }
            thread::sleep(Duration::from_millis(10));
        }
        assert!(delivered);
        assert_eq!(request_task_service_health(&shutdown_pipe), Ok(()));
        assert!(request_task_service_health_version(&shutdown_pipe, 2).is_err());
        assert_eq!(
            client.send_validated_payload(&signed("evt-service-2", 2, TaskState::Succeeded, 9,)),
            Ok(())
        );
        assert_eq!(request_task_service_shutdown(&shutdown_pipe), Ok(()));
        // The shutdown ACK is written before the task-pipe wake-up and worker
        // join complete, so a 1-second receiver deadline races the permitted
        // transport budget even though production behavior is still bounded.
        assert!(done_receiver
            .recv_timeout(yuanyuan_bridge::HARD_DELIVERY_TIMEOUT)
            .unwrap()
            .is_ok());
        worker.join().unwrap();

        let store = TaskStore::open(database).unwrap();
        assert_eq!(store.task_count().unwrap(), 1);
        assert_eq!(store.event_count().unwrap(), 2);
    }
}
