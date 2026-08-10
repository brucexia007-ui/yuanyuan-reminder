use std::{io::ErrorKind, path::Path, time::Duration};

use rusqlite::{params, Connection, OpenFlags, OptionalExtension, TransactionBehavior};
use thiserror::Error;

use crate::{AuthenticationKey, AuthenticationKeyResolver, KeyResolutionError};

pub const KEY_ROTATION_GRACE: Duration = Duration::from_secs(5 * 60);
pub const MAX_CONNECTOR_TRUST_IDENTITIES: u16 = 16;
const MAX_FINALIZE_BATCH: u16 = 256;

const SCHEMA: &str = r#"
CREATE TABLE IF NOT EXISTS connector_trust (
  connector_id TEXT NOT NULL,
  source_instance TEXT NOT NULL,
  generation INTEGER NOT NULL CHECK(generation > 0),
  status TEXT NOT NULL CHECK(status IN ('active', 'revoked')),
  active_key_id TEXT,
  previous_key_id TEXT,
  switched_at_unix_ms INTEGER,
  grace_expires_at_unix_ms INTEGER,
  updated_at_unix_ms INTEGER NOT NULL CHECK(updated_at_unix_ms >= 0),
  PRIMARY KEY(connector_id, source_instance),
  CHECK(
    (status = 'active' AND active_key_id IS NOT NULL) OR
    (status = 'revoked' AND active_key_id IS NULL AND previous_key_id IS NULL)
  ),
  CHECK(
    (previous_key_id IS NULL AND switched_at_unix_ms IS NULL AND grace_expires_at_unix_ms IS NULL) OR
    (previous_key_id IS NOT NULL AND switched_at_unix_ms IS NOT NULL AND grace_expires_at_unix_ms IS NOT NULL)
  )
) WITHOUT ROWID;

CREATE TABLE IF NOT EXISTS connector_trust_keys (
  key_id TEXT PRIMARY KEY NOT NULL,
  connector_id TEXT NOT NULL,
  source_instance TEXT NOT NULL,
  generation INTEGER NOT NULL CHECK(generation > 0),
  created_at_unix_ms INTEGER NOT NULL CHECK(created_at_unix_ms >= 0),
  retired_at_unix_ms INTEGER,
  revoked_at_unix_ms INTEGER,
  credential_deleted_at_unix_ms INTEGER
) WITHOUT ROWID;

CREATE TABLE IF NOT EXISTS connector_trust_audit (
  sequence INTEGER PRIMARY KEY AUTOINCREMENT,
  connector_id TEXT NOT NULL,
  source_instance TEXT NOT NULL,
  key_id TEXT,
  action TEXT NOT NULL CHECK(action IN ('registered', 'rotation_started', 'rotation_finalized', 'trust_reset', 'reconnected')),
  reason TEXT NOT NULL CHECK(reason IN ('initial_connection', 'user_requested', 'connector_reconfigured', 'connector_reinstalled', 'source_instance_changed', 'suspected_compromise', 'credential_missing', 'grace_expired', 'legacy_migration')),
  occurred_at_unix_ms INTEGER NOT NULL CHECK(occurred_at_unix_ms >= 0)
);
"#;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TrustChangeReason {
    InitialConnection,
    UserRequested,
    ConnectorReconfigured,
    ConnectorReinstalled,
    SourceInstanceChanged,
    SuspectedCompromise,
    CredentialMissing,
    GraceExpired,
}

impl TrustChangeReason {
    const fn as_str(self) -> &'static str {
        match self {
            Self::InitialConnection => "initial_connection",
            Self::UserRequested => "user_requested",
            Self::ConnectorReconfigured => "connector_reconfigured",
            Self::ConnectorReinstalled => "connector_reinstalled",
            Self::SourceInstanceChanged => "source_instance_changed",
            Self::SuspectedCompromise => "suspected_compromise",
            Self::CredentialMissing => "credential_missing",
            Self::GraceExpired => "grace_expired",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TrustDecision {
    Active,
    PreviousWithinGrace,
    Rejected,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TrustStatus {
    pub generation: u64,
    pub active: bool,
    pub active_key_id: Option<String>,
    pub previous_key_id: Option<String>,
    pub grace_expires_at_unix_ms: Option<i64>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TrustIdentitySummary {
    pub connector_id: String,
    pub source_instance: String,
    pub generation: u64,
    pub active: bool,
    pub grace_expires_at_unix_ms: Option<i64>,
}

#[derive(Debug, Error)]
pub enum TrustStoreError {
    #[error("connector trust input is invalid")]
    InvalidInput,
    #[error("connector trust state does not allow this transition")]
    InvalidTransition,
    #[error("connector trust key id has already been used")]
    KeyIdAlreadyUsed,
    #[error("connector trust identity capacity has been reached")]
    CapacityReached,
    #[error("connector trust database path is unsafe")]
    UnsafePath,
    #[error("connector trust filesystem is unavailable")]
    Filesystem(#[from] std::io::Error),
    #[error("connector trust storage is unavailable")]
    Database(#[from] rusqlite::Error),
}

pub struct ConnectorTrustStore {
    connection: Connection,
}

impl ConnectorTrustStore {
    pub fn open(path: impl AsRef<Path>) -> Result<Self, TrustStoreError> {
        let path = path.as_ref();
        validate_database_path(path, true)?;
        let connection = Connection::open(path)?;
        validate_database_path(path, false)?;
        Self::from_connection(connection)
    }

    pub fn open_in_memory() -> Result<Self, TrustStoreError> {
        Self::from_connection(Connection::open_in_memory()?)
    }

    pub fn open_existing_read_only(path: impl AsRef<Path>) -> Result<Self, TrustStoreError> {
        let path = path.as_ref();
        validate_database_path(path, false)?;
        let connection = Connection::open_with_flags(
            path,
            OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX,
        )?;
        validate_database_path(path, false)?;
        connection.busy_timeout(Duration::ZERO)?;
        Ok(Self { connection })
    }

    fn from_connection(connection: Connection) -> Result<Self, TrustStoreError> {
        connection.busy_timeout(Duration::ZERO)?;
        connection.execute_batch(SCHEMA)?;
        ensure_audit_reason_column(&connection)?;
        ensure_credential_cleanup_column(&connection)?;
        Ok(Self { connection })
    }

    pub fn register(
        &mut self,
        connector_id: &str,
        source_instance: &str,
        key_id: &str,
        now_unix_ms: i64,
    ) -> Result<(), TrustStoreError> {
        validate_inputs(connector_id, source_instance, key_id, now_unix_ms)?;
        let transaction = self
            .connection
            .transaction_with_behavior(TransactionBehavior::Immediate)?;
        if trust_row(&transaction, connector_id, source_instance)?.is_some() {
            return Err(TrustStoreError::InvalidTransition);
        }
        let identity_count: u16 =
            transaction.query_row("SELECT COUNT(*) FROM connector_trust", [], |row| row.get(0))?;
        if identity_count >= MAX_CONNECTOR_TRUST_IDENTITIES {
            return Err(TrustStoreError::CapacityReached);
        }
        insert_key(
            &transaction,
            connector_id,
            source_instance,
            key_id,
            1,
            now_unix_ms,
        )?;
        transaction.execute(
            "INSERT INTO connector_trust(
               connector_id, source_instance, generation, status, active_key_id,
               previous_key_id, switched_at_unix_ms, grace_expires_at_unix_ms, updated_at_unix_ms
             ) VALUES (?1, ?2, 1, 'active', ?3, NULL, NULL, NULL, ?4)",
            params![connector_id, source_instance, key_id, now_unix_ms],
        )?;
        insert_audit(
            &transaction,
            connector_id,
            source_instance,
            Some(key_id),
            "registered",
            TrustChangeReason::InitialConnection,
            now_unix_ms,
        )?;
        transaction.commit()?;
        Ok(())
    }

    pub fn begin_rotation(
        &mut self,
        connector_id: &str,
        source_instance: &str,
        new_key_id: &str,
        now_unix_ms: i64,
    ) -> Result<String, TrustStoreError> {
        self.begin_rotation_with_reason(
            connector_id,
            source_instance,
            new_key_id,
            TrustChangeReason::UserRequested,
            now_unix_ms,
        )
    }

    pub fn begin_rotation_with_reason(
        &mut self,
        connector_id: &str,
        source_instance: &str,
        new_key_id: &str,
        reason: TrustChangeReason,
        now_unix_ms: i64,
    ) -> Result<String, TrustStoreError> {
        validate_inputs(connector_id, source_instance, new_key_id, now_unix_ms)?;
        let transaction = self
            .connection
            .transaction_with_behavior(TransactionBehavior::Immediate)?;
        let row = trust_row(&transaction, connector_id, source_instance)?
            .ok_or(TrustStoreError::InvalidTransition)?;
        if !row.active || row.previous_key_id.is_some() {
            return Err(TrustStoreError::InvalidTransition);
        }
        let old_key_id = row
            .active_key_id
            .ok_or(TrustStoreError::InvalidTransition)?;
        let next_generation = row.generation.saturating_add(1);
        insert_key(
            &transaction,
            connector_id,
            source_instance,
            new_key_id,
            next_generation,
            now_unix_ms,
        )?;
        let grace_expires = now_unix_ms.saturating_add(KEY_ROTATION_GRACE.as_millis() as i64);
        transaction.execute(
            "UPDATE connector_trust SET
               generation=?3, active_key_id=?4, previous_key_id=?5,
               switched_at_unix_ms=?6, grace_expires_at_unix_ms=?7, updated_at_unix_ms=?6
             WHERE connector_id=?1 AND source_instance=?2",
            params![
                connector_id,
                source_instance,
                next_generation,
                new_key_id,
                old_key_id,
                now_unix_ms,
                grace_expires
            ],
        )?;
        transaction.execute(
            "UPDATE connector_trust_keys SET retired_at_unix_ms=?2 WHERE key_id=?1",
            params![old_key_id, now_unix_ms],
        )?;
        insert_audit(
            &transaction,
            connector_id,
            source_instance,
            Some(new_key_id),
            "rotation_started",
            reason,
            now_unix_ms,
        )?;
        transaction.commit()?;
        Ok(old_key_id)
    }

    #[cfg(test)]
    pub fn authorize(
        &self,
        key_id: &str,
        signed_at_unix_ms: i64,
        now_unix_ms: i64,
    ) -> Result<TrustDecision, TrustStoreError> {
        if !valid_key_id(key_id) || signed_at_unix_ms < 0 || now_unix_ms < 0 {
            return Err(TrustStoreError::InvalidInput);
        }
        let row = self
            .connection
            .query_row(
                "SELECT status, active_key_id, previous_key_id, switched_at_unix_ms, grace_expires_at_unix_ms
                 FROM connector_trust WHERE active_key_id=?1 OR previous_key_id=?1 LIMIT 1",
                [key_id],
                |row| {
                    Ok((
                        row.get::<_, String>(0)?,
                        row.get::<_, Option<String>>(1)?,
                        row.get::<_, Option<String>>(2)?,
                        row.get::<_, Option<i64>>(3)?,
                        row.get::<_, Option<i64>>(4)?,
                    ))
                },
            )
            .optional()?;
        let Some((status, active, previous, switched_at, grace_expires)) = row else {
            return Ok(TrustDecision::Rejected);
        };
        if status != "active" {
            return Ok(TrustDecision::Rejected);
        }
        if active.as_deref() == Some(key_id) {
            return Ok(TrustDecision::Active);
        }
        if previous.as_deref() == Some(key_id)
            && switched_at.is_some_and(|switch| signed_at_unix_ms <= switch)
            && grace_expires.is_some_and(|expires| now_unix_ms <= expires)
        {
            return Ok(TrustDecision::PreviousWithinGrace);
        }
        Ok(TrustDecision::Rejected)
    }

    pub fn authorize_for_identity(
        &self,
        connector_id: &str,
        source_instance: &str,
        key_id: &str,
        signed_at_unix_ms: i64,
        now_unix_ms: i64,
    ) -> Result<TrustDecision, TrustStoreError> {
        if !valid_identifier(connector_id)
            || !valid_identifier(source_instance)
            || !valid_key_id(key_id)
            || signed_at_unix_ms < 0
            || now_unix_ms < 0
        {
            return Err(TrustStoreError::InvalidInput);
        }
        let row = self
            .connection
            .query_row(
                "SELECT status, active_key_id, previous_key_id, switched_at_unix_ms, grace_expires_at_unix_ms
                 FROM connector_trust WHERE connector_id=?1 AND source_instance=?2",
                params![connector_id, source_instance],
                |row| {
                    Ok((
                        row.get::<_, String>(0)?,
                        row.get::<_, Option<String>>(1)?,
                        row.get::<_, Option<String>>(2)?,
                        row.get::<_, Option<i64>>(3)?,
                        row.get::<_, Option<i64>>(4)?,
                    ))
                },
            )
            .optional()?;
        let Some((status, active, previous, switched_at, grace_expires)) = row else {
            return Ok(TrustDecision::Rejected);
        };
        if status != "active" {
            return Ok(TrustDecision::Rejected);
        }
        if active.as_deref() == Some(key_id) {
            return Ok(TrustDecision::Active);
        }
        if previous.as_deref() == Some(key_id)
            && switched_at.is_some_and(|switch| signed_at_unix_ms <= switch)
            && grace_expires.is_some_and(|expires| now_unix_ms <= expires)
        {
            return Ok(TrustDecision::PreviousWithinGrace);
        }
        Ok(TrustDecision::Rejected)
    }

    pub fn reset_trust(
        &mut self,
        connector_id: &str,
        source_instance: &str,
        now_unix_ms: i64,
    ) -> Result<Vec<String>, TrustStoreError> {
        self.reset_trust_with_reason(
            connector_id,
            source_instance,
            TrustChangeReason::UserRequested,
            now_unix_ms,
        )
    }

    pub fn reset_trust_with_reason(
        &mut self,
        connector_id: &str,
        source_instance: &str,
        reason: TrustChangeReason,
        now_unix_ms: i64,
    ) -> Result<Vec<String>, TrustStoreError> {
        validate_identity(connector_id, source_instance, now_unix_ms)?;
        let transaction = self
            .connection
            .transaction_with_behavior(TransactionBehavior::Immediate)?;
        let row = trust_row(&transaction, connector_id, source_instance)?
            .ok_or(TrustStoreError::InvalidTransition)?;
        if !row.active {
            return Err(TrustStoreError::InvalidTransition);
        }
        let mut revoked = Vec::new();
        if let Some(key) = row.active_key_id {
            revoked.push(key);
        }
        if let Some(key) = row.previous_key_id {
            revoked.push(key);
        }
        transaction.execute(
            "UPDATE connector_trust SET status='revoked', active_key_id=NULL, previous_key_id=NULL,
               switched_at_unix_ms=NULL, grace_expires_at_unix_ms=NULL, updated_at_unix_ms=?3
             WHERE connector_id=?1 AND source_instance=?2",
            params![connector_id, source_instance, now_unix_ms],
        )?;
        for key_id in &revoked {
            transaction.execute(
                "UPDATE connector_trust_keys SET revoked_at_unix_ms=?2 WHERE key_id=?1",
                params![key_id, now_unix_ms],
            )?;
        }
        insert_audit(
            &transaction,
            connector_id,
            source_instance,
            None,
            "trust_reset",
            reason,
            now_unix_ms,
        )?;
        transaction.commit()?;
        Ok(revoked)
    }

    pub fn reconnect(
        &mut self,
        connector_id: &str,
        source_instance: &str,
        new_key_id: &str,
        now_unix_ms: i64,
    ) -> Result<(), TrustStoreError> {
        self.reconnect_with_reason(
            connector_id,
            source_instance,
            new_key_id,
            TrustChangeReason::UserRequested,
            now_unix_ms,
        )
    }

    pub fn reconnect_with_reason(
        &mut self,
        connector_id: &str,
        source_instance: &str,
        new_key_id: &str,
        reason: TrustChangeReason,
        now_unix_ms: i64,
    ) -> Result<(), TrustStoreError> {
        validate_inputs(connector_id, source_instance, new_key_id, now_unix_ms)?;
        let transaction = self
            .connection
            .transaction_with_behavior(TransactionBehavior::Immediate)?;
        let row = trust_row(&transaction, connector_id, source_instance)?
            .ok_or(TrustStoreError::InvalidTransition)?;
        if row.active {
            return Err(TrustStoreError::InvalidTransition);
        }
        let generation = row.generation.saturating_add(1);
        insert_key(
            &transaction,
            connector_id,
            source_instance,
            new_key_id,
            generation,
            now_unix_ms,
        )?;
        transaction.execute(
            "UPDATE connector_trust SET generation=?3, status='active', active_key_id=?4,
               updated_at_unix_ms=?5 WHERE connector_id=?1 AND source_instance=?2",
            params![
                connector_id,
                source_instance,
                generation,
                new_key_id,
                now_unix_ms
            ],
        )?;
        insert_audit(
            &transaction,
            connector_id,
            source_instance,
            Some(new_key_id),
            "reconnected",
            reason,
            now_unix_ms,
        )?;
        transaction.commit()?;
        Ok(())
    }

    pub fn finalize_expired_rotations(
        &mut self,
        now_unix_ms: i64,
        limit: u16,
    ) -> Result<Vec<String>, TrustStoreError> {
        if now_unix_ms < 0 || limit == 0 || limit > MAX_FINALIZE_BATCH {
            return Err(TrustStoreError::InvalidInput);
        }
        let transaction = self
            .connection
            .transaction_with_behavior(TransactionBehavior::Immediate)?;
        let mut statement = transaction.prepare(
            "SELECT connector_id, source_instance, previous_key_id
             FROM connector_trust
             WHERE previous_key_id IS NOT NULL AND grace_expires_at_unix_ms < ?1
             ORDER BY grace_expires_at_unix_ms, connector_id, source_instance LIMIT ?2",
        )?;
        let rows = statement.query_map(params![now_unix_ms, limit], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, String>(2)?,
            ))
        })?;
        let expired = rows.collect::<Result<Vec<_>, _>>()?;
        drop(statement);
        for (connector_id, source_instance, key_id) in &expired {
            transaction.execute(
                "UPDATE connector_trust SET previous_key_id=NULL, switched_at_unix_ms=NULL,
                   grace_expires_at_unix_ms=NULL, updated_at_unix_ms=?3
                 WHERE connector_id=?1 AND source_instance=?2 AND previous_key_id=?4",
                params![connector_id, source_instance, now_unix_ms, key_id],
            )?;
            insert_audit(
                &transaction,
                connector_id,
                source_instance,
                Some(key_id),
                "rotation_finalized",
                TrustChangeReason::GraceExpired,
                now_unix_ms,
            )?;
        }
        transaction.commit()?;
        Ok(expired.into_iter().map(|(_, _, key_id)| key_id).collect())
    }

    pub fn status(
        &self,
        connector_id: &str,
        source_instance: &str,
    ) -> Result<Option<TrustStatus>, TrustStoreError> {
        if !valid_identifier(connector_id) || !valid_identifier(source_instance) {
            return Err(TrustStoreError::InvalidInput);
        }
        Ok(
            trust_row(&self.connection, connector_id, source_instance)?.map(|row| TrustStatus {
                generation: row.generation,
                active: row.active,
                active_key_id: row.active_key_id,
                previous_key_id: row.previous_key_id,
                grace_expires_at_unix_ms: row.grace_expires_at_unix_ms,
            }),
        )
    }

    /// Returns a bounded batch of exact credential ids whose authentication
    /// authority has already been revoked but whose secret deletion has not
    /// yet been durably recorded. Active and grace-period keys never match.
    pub fn pending_revoked_credential_keys(
        &self,
        connector_id: &str,
        source_instance: &str,
        limit: u16,
    ) -> Result<(Vec<String>, bool), TrustStoreError> {
        validate_identity(connector_id, source_instance, 0)?;
        if limit == 0 || limit > MAX_FINALIZE_BATCH {
            return Err(TrustStoreError::InvalidInput);
        }
        let query_limit = i64::from(limit) + 1;
        let mut statement = self.connection.prepare(
            "SELECT key_id FROM connector_trust_keys
             WHERE connector_id=?1 AND source_instance=?2
               AND revoked_at_unix_ms IS NOT NULL
               AND credential_deleted_at_unix_ms IS NULL
             ORDER BY generation, key_id LIMIT ?3",
        )?;
        let mut keys = statement
            .query_map(params![connector_id, source_instance, query_limit], |row| {
                row.get::<_, String>(0)
            })?
            .collect::<Result<Vec<_>, _>>()?;
        let has_more = keys.len() > usize::from(limit);
        keys.truncate(usize::from(limit));
        Ok((keys, has_more))
    }

    /// Records cleanup only after the exact credential target has been
    /// deleted (or was already absent). It cannot mark an active key clean.
    pub fn mark_revoked_credential_deleted(
        &mut self,
        key_id: &str,
        now_unix_ms: i64,
    ) -> Result<(), TrustStoreError> {
        if !valid_key_id(key_id) || now_unix_ms < 0 {
            return Err(TrustStoreError::InvalidInput);
        }
        let changed = self.connection.execute(
            "UPDATE connector_trust_keys SET credential_deleted_at_unix_ms=?2
             WHERE key_id=?1 AND revoked_at_unix_ms IS NOT NULL
               AND credential_deleted_at_unix_ms IS NULL",
            params![key_id, now_unix_ms],
        )?;
        if changed == 1 {
            Ok(())
        } else {
            Err(TrustStoreError::InvalidTransition)
        }
    }

    pub fn list_identity_summaries(
        &self,
        connector_id: &str,
    ) -> Result<Vec<TrustIdentitySummary>, TrustStoreError> {
        if !valid_identifier(connector_id) {
            return Err(TrustStoreError::InvalidInput);
        }
        let mut statement = self.connection.prepare(
            "SELECT connector_id, source_instance, generation, status, grace_expires_at_unix_ms
             FROM connector_trust WHERE connector_id=?1
             ORDER BY source_instance LIMIT ?2",
        )?;
        let rows = statement.query_map(
            params![connector_id, MAX_CONNECTOR_TRUST_IDENTITIES],
            |row| {
                Ok(TrustIdentitySummary {
                    connector_id: row.get(0)?,
                    source_instance: row.get(1)?,
                    generation: row.get(2)?,
                    active: row.get::<_, String>(3)? == "active",
                    grace_expires_at_unix_ms: row.get(4)?,
                })
            },
        )?;
        Ok(rows.collect::<Result<Vec<_>, _>>()?)
    }

    /// Returns the bounded set of connector identities without credential IDs.
    ///
    /// The trust store has a global identity capacity, so this query cannot be
    /// used to turn the local database into an unbounded discovery surface.
    pub fn list_all_identity_summaries(
        &self,
    ) -> Result<Vec<TrustIdentitySummary>, TrustStoreError> {
        let mut statement = self.connection.prepare(
            "SELECT connector_id, source_instance, generation, status, grace_expires_at_unix_ms
             FROM connector_trust
             ORDER BY connector_id, source_instance LIMIT ?1",
        )?;
        let rows = statement.query_map(params![MAX_CONNECTOR_TRUST_IDENTITIES], |row| {
            Ok(TrustIdentitySummary {
                connector_id: row.get(0)?,
                source_instance: row.get(1)?,
                generation: row.get(2)?,
                active: row.get::<_, String>(3)? == "active",
                grace_expires_at_unix_ms: row.get(4)?,
            })
        })?;
        Ok(rows.collect::<Result<Vec<_>, _>>()?)
    }
}

fn validate_database_path(path: &Path, allow_missing_file: bool) -> Result<(), TrustStoreError> {
    if path.file_name().is_none() {
        return Err(TrustStoreError::UnsafePath);
    }
    let parent = path.parent().ok_or(TrustStoreError::UnsafePath)?;
    let parent_metadata = std::fs::symlink_metadata(parent).map_err(|error| {
        if error.kind() == ErrorKind::NotFound {
            TrustStoreError::UnsafePath
        } else {
            TrustStoreError::Filesystem(error)
        }
    })?;
    if parent_metadata.file_type().is_symlink() || !parent_metadata.is_dir() {
        return Err(TrustStoreError::UnsafePath);
    }
    match std::fs::symlink_metadata(path) {
        Ok(metadata) if !metadata.file_type().is_symlink() && metadata.is_file() => Ok(()),
        Ok(_) => Err(TrustStoreError::UnsafePath),
        Err(error) if error.kind() == ErrorKind::NotFound && allow_missing_file => Ok(()),
        Err(error) if error.kind() == ErrorKind::NotFound => Err(TrustStoreError::UnsafePath),
        Err(error) => Err(TrustStoreError::Filesystem(error)),
    }
}

pub struct TrustEnforcingKeyResolver<K> {
    inner: K,
    trust_database: std::path::PathBuf,
}

impl<K> TrustEnforcingKeyResolver<K> {
    pub fn new(inner: K, trust_database: impl Into<std::path::PathBuf>) -> Self {
        Self {
            inner,
            trust_database: trust_database.into(),
        }
    }
}

impl<K: AuthenticationKeyResolver> AuthenticationKeyResolver for TrustEnforcingKeyResolver<K> {
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
        let trust = ConnectorTrustStore::open_existing_read_only(&self.trust_database)
            .map_err(|_| KeyResolutionError::Unavailable)?;
        match trust
            .authorize_for_identity(
                connector_id,
                source_instance,
                key_id,
                signed_at_unix_ms,
                now_unix_ms,
            )
            .map_err(|_| KeyResolutionError::Unavailable)?
        {
            TrustDecision::Active | TrustDecision::PreviousWithinGrace => {
                self.inner.resolve(key_id)
            }
            TrustDecision::Rejected => Err(KeyResolutionError::UnknownOrRevoked),
        }
    }
}

struct TrustRow {
    generation: u64,
    active: bool,
    active_key_id: Option<String>,
    previous_key_id: Option<String>,
    grace_expires_at_unix_ms: Option<i64>,
}

fn trust_row(
    connection: &Connection,
    connector_id: &str,
    source_instance: &str,
) -> Result<Option<TrustRow>, rusqlite::Error> {
    connection
        .query_row(
            "SELECT generation, status, active_key_id, previous_key_id, grace_expires_at_unix_ms
             FROM connector_trust WHERE connector_id=?1 AND source_instance=?2",
            params![connector_id, source_instance],
            |row| {
                Ok(TrustRow {
                    generation: row.get(0)?,
                    active: row.get::<_, String>(1)? == "active",
                    active_key_id: row.get(2)?,
                    previous_key_id: row.get(3)?,
                    grace_expires_at_unix_ms: row.get(4)?,
                })
            },
        )
        .optional()
}

fn insert_key(
    connection: &Connection,
    connector_id: &str,
    source_instance: &str,
    key_id: &str,
    generation: u64,
    now_unix_ms: i64,
) -> Result<(), TrustStoreError> {
    match connection.execute(
        "INSERT INTO connector_trust_keys(key_id, connector_id, source_instance, generation, created_at_unix_ms)
         VALUES (?1, ?2, ?3, ?4, ?5)",
        params![key_id, connector_id, source_instance, generation, now_unix_ms],
    ) {
        Ok(_) => Ok(()),
        Err(error) if matches!(error.sqlite_error_code(), Some(rusqlite::ErrorCode::ConstraintViolation)) => {
            Err(TrustStoreError::KeyIdAlreadyUsed)
        }
        Err(error) => Err(error.into()),
    }
}

fn insert_audit(
    connection: &Connection,
    connector_id: &str,
    source_instance: &str,
    key_id: Option<&str>,
    action: &str,
    reason: TrustChangeReason,
    now_unix_ms: i64,
) -> Result<(), rusqlite::Error> {
    connection.execute(
        "INSERT INTO connector_trust_audit(connector_id, source_instance, key_id, action, reason, occurred_at_unix_ms)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
        params![
            connector_id,
            source_instance,
            key_id,
            action,
            reason.as_str(),
            now_unix_ms
        ],
    )?;
    Ok(())
}

fn ensure_audit_reason_column(connection: &Connection) -> Result<(), rusqlite::Error> {
    let mut statement = connection.prepare("PRAGMA table_info(connector_trust_audit)")?;
    let columns = statement
        .query_map([], |row| row.get::<_, String>(1))?
        .collect::<Result<Vec<_>, _>>()?;
    drop(statement);
    if !columns.iter().any(|column| column == "reason") {
        connection.execute_batch(
            "ALTER TABLE connector_trust_audit ADD COLUMN reason TEXT NOT NULL
             DEFAULT 'legacy_migration'
             CHECK(reason IN ('initial_connection', 'user_requested', 'connector_reconfigured', 'connector_reinstalled', 'source_instance_changed', 'suspected_compromise', 'credential_missing', 'grace_expired', 'legacy_migration'));",
        )?;
    }
    Ok(())
}

fn ensure_credential_cleanup_column(connection: &Connection) -> Result<(), rusqlite::Error> {
    let mut statement = connection.prepare("PRAGMA table_info(connector_trust_keys)")?;
    let columns = statement
        .query_map([], |row| row.get::<_, String>(1))?
        .collect::<Result<Vec<_>, _>>()?;
    drop(statement);
    if !columns
        .iter()
        .any(|column| column == "credential_deleted_at_unix_ms")
    {
        connection.execute_batch(
            "ALTER TABLE connector_trust_keys ADD COLUMN credential_deleted_at_unix_ms INTEGER;",
        )?;
    }
    Ok(())
}

fn validate_inputs(
    connector_id: &str,
    source_instance: &str,
    key_id: &str,
    now_unix_ms: i64,
) -> Result<(), TrustStoreError> {
    validate_identity(connector_id, source_instance, now_unix_ms)?;
    if !valid_key_id(key_id) {
        return Err(TrustStoreError::InvalidInput);
    }
    Ok(())
}

fn validate_identity(
    connector_id: &str,
    source_instance: &str,
    now_unix_ms: i64,
) -> Result<(), TrustStoreError> {
    if !valid_identifier(connector_id) || !valid_identifier(source_instance) || now_unix_ms < 0 {
        return Err(TrustStoreError::InvalidInput);
    }
    Ok(())
}

fn valid_identifier(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 128
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'_' | b'-'))
}

fn valid_key_id(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 64
        && value.bytes().all(|byte| {
            byte.is_ascii_lowercase() || byte.is_ascii_digit() || matches!(byte, b'.' | b'_' | b'-')
        })
}

#[cfg(test)]
mod tests {
    use std::sync::{Arc, Barrier};

    use super::*;

    const CONNECTOR: &str = "connector.codex";
    const INSTANCE: &str = "instance-1";
    const OLD_KEY: &str = "codex.instance-1.g1";
    const NEW_KEY: &str = "codex.instance-1.g2";
    const NOW: i64 = 1_775_212_800_000;

    #[test]
    fn legacy_key_table_adds_cleanup_marker_without_losing_rows() {
        let connection = Connection::open_in_memory().unwrap();
        connection
            .execute_batch(
                "CREATE TABLE connector_trust_keys (
                   key_id TEXT PRIMARY KEY NOT NULL,
                   connector_id TEXT NOT NULL,
                   source_instance TEXT NOT NULL,
                   generation INTEGER NOT NULL CHECK(generation > 0),
                   created_at_unix_ms INTEGER NOT NULL CHECK(created_at_unix_ms >= 0),
                   retired_at_unix_ms INTEGER,
                   revoked_at_unix_ms INTEGER
                 ) WITHOUT ROWID;
                 INSERT INTO connector_trust_keys(
                   key_id, connector_id, source_instance, generation,
                   created_at_unix_ms, revoked_at_unix_ms
                 ) VALUES ('codex.instance-1.g1', 'connector.codex', 'instance-1', 1, 1, 2);",
            )
            .unwrap();

        let store = ConnectorTrustStore::from_connection(connection).unwrap();
        let (keys, has_more) = store
            .pending_revoked_credential_keys(CONNECTOR, INSTANCE, 1)
            .unwrap();
        assert_eq!(keys, vec![OLD_KEY.to_owned()]);
        assert!(!has_more);
        let columns = store
            .connection
            .prepare("PRAGMA table_info(connector_trust_keys)")
            .unwrap()
            .query_map([], |row| row.get::<_, String>(1))
            .unwrap()
            .collect::<Result<Vec<_>, _>>()
            .unwrap();
        assert!(columns
            .iter()
            .any(|column| column == "credential_deleted_at_unix_ms"));
    }

    #[test]
    fn rotation_accepts_only_old_events_signed_before_switch_during_grace() {
        let mut store = ConnectorTrustStore::open_in_memory().unwrap();
        store.register(CONNECTOR, INSTANCE, OLD_KEY, NOW).unwrap();
        assert_eq!(
            store.authorize(OLD_KEY, NOW, NOW).unwrap(),
            TrustDecision::Active
        );
        store
            .begin_rotation(CONNECTOR, INSTANCE, NEW_KEY, NOW + 1_000)
            .unwrap();
        assert_eq!(
            store.authorize(NEW_KEY, NOW + 2_000, NOW + 2_000).unwrap(),
            TrustDecision::Active
        );
        assert_eq!(
            store.authorize(OLD_KEY, NOW + 999, NOW + 2_000).unwrap(),
            TrustDecision::PreviousWithinGrace
        );
        assert_eq!(
            store.authorize(OLD_KEY, NOW + 1_001, NOW + 2_000).unwrap(),
            TrustDecision::Rejected
        );
        assert_eq!(
            store.authorize(OLD_KEY, NOW + 999, NOW + 301_001).unwrap(),
            TrustDecision::Rejected
        );
    }

    #[test]
    fn reset_revokes_every_live_key_immediately_and_reconnect_never_reuses_ids() {
        let mut store = ConnectorTrustStore::open_in_memory().unwrap();
        store.register(CONNECTOR, INSTANCE, OLD_KEY, NOW).unwrap();
        store
            .begin_rotation(CONNECTOR, INSTANCE, NEW_KEY, NOW + 1)
            .unwrap();
        assert_eq!(
            store.reset_trust(CONNECTOR, INSTANCE, NOW + 2).unwrap(),
            vec![NEW_KEY.to_owned(), OLD_KEY.to_owned()]
        );
        assert_eq!(
            store.authorize(NEW_KEY, NOW + 1, NOW + 2).unwrap(),
            TrustDecision::Rejected
        );
        assert_eq!(
            store.authorize(OLD_KEY, NOW, NOW + 2).unwrap(),
            TrustDecision::Rejected
        );
        assert!(matches!(
            store.reconnect(CONNECTOR, INSTANCE, OLD_KEY, NOW + 3),
            Err(TrustStoreError::KeyIdAlreadyUsed)
        ));
        store
            .reconnect(CONNECTOR, INSTANCE, "codex.instance-1.g3", NOW + 3)
            .unwrap();
        assert_eq!(
            store
                .status(CONNECTOR, INSTANCE)
                .unwrap()
                .unwrap()
                .generation,
            3
        );
    }

    #[test]
    fn identity_summaries_are_bounded_and_never_contain_key_ids() {
        let mut store = ConnectorTrustStore::open_in_memory().unwrap();
        store.register(CONNECTOR, INSTANCE, OLD_KEY, NOW).unwrap();
        let summaries = store.list_identity_summaries(CONNECTOR).unwrap();
        assert_eq!(
            summaries,
            vec![TrustIdentitySummary {
                connector_id: CONNECTOR.to_owned(),
                source_instance: INSTANCE.to_owned(),
                generation: 1,
                active: true,
                grace_expires_at_unix_ms: None,
            }]
        );
        let debug = format!("{summaries:?}");
        assert!(!debug.contains(OLD_KEY));
        assert_eq!(store.list_all_identity_summaries().unwrap(), summaries);
    }

    #[test]
    fn expired_rotation_finalization_is_bounded_and_removes_previous_authority() {
        let mut store = ConnectorTrustStore::open_in_memory().unwrap();
        store.register(CONNECTOR, INSTANCE, OLD_KEY, NOW).unwrap();
        store
            .begin_rotation(CONNECTOR, INSTANCE, NEW_KEY, NOW + 1)
            .unwrap();
        assert!(store
            .finalize_expired_rotations(NOW + 300_001, 1)
            .unwrap()
            .is_empty());
        assert_eq!(
            store.finalize_expired_rotations(NOW + 300_002, 1).unwrap(),
            vec![OLD_KEY.to_owned()]
        );
        assert_eq!(
            store.authorize(OLD_KEY, NOW, NOW + 300_002).unwrap(),
            TrustDecision::Rejected
        );
        assert!(store
            .status(CONNECTOR, INSTANCE)
            .unwrap()
            .unwrap()
            .previous_key_id
            .is_none());
    }

    #[test]
    fn invalid_identifiers_transitions_and_key_reuse_fail_closed() {
        let mut store = ConnectorTrustStore::open_in_memory().unwrap();
        assert!(store.register("../bad", INSTANCE, OLD_KEY, NOW).is_err());
        store.register(CONNECTOR, INSTANCE, OLD_KEY, NOW).unwrap();
        assert!(store.register(CONNECTOR, INSTANCE, NEW_KEY, NOW).is_err());
        assert!(store
            .begin_rotation(CONNECTOR, INSTANCE, OLD_KEY, NOW + 1)
            .is_err());
        store
            .begin_rotation(CONNECTOR, INSTANCE, NEW_KEY, NOW + 1)
            .unwrap();
        assert!(store
            .begin_rotation(CONNECTOR, INSTANCE, "codex.instance-1.g3", NOW + 2)
            .is_err());
        assert!(store.finalize_expired_rotations(NOW, 0).is_err());
    }

    #[test]
    fn failed_rotation_audit_rolls_back_key_and_state_changes() {
        let mut store = ConnectorTrustStore::open_in_memory().unwrap();
        store.register(CONNECTOR, INSTANCE, OLD_KEY, NOW).unwrap();
        store
            .connection
            .execute_batch(
                "CREATE TRIGGER fail_rotation_audit BEFORE INSERT ON connector_trust_audit
                 WHEN NEW.action='rotation_started' BEGIN SELECT RAISE(FAIL, 'injected'); END;",
            )
            .unwrap();
        assert!(store
            .begin_rotation(CONNECTOR, INSTANCE, NEW_KEY, NOW + 1)
            .is_err());
        let status = store.status(CONNECTOR, INSTANCE).unwrap().unwrap();
        assert_eq!(status.active_key_id.as_deref(), Some(OLD_KEY));
        assert!(status.previous_key_id.is_none());
        store
            .connection
            .execute_batch("DROP TRIGGER fail_rotation_audit")
            .unwrap();
        store
            .begin_rotation(CONNECTOR, INSTANCE, NEW_KEY, NOW + 2)
            .unwrap();
    }

    struct FixtureKeys;

    impl AuthenticationKeyResolver for FixtureKeys {
        fn resolve(&self, key_id: &str) -> Result<AuthenticationKey, KeyResolutionError> {
            match key_id {
                OLD_KEY => AuthenticationKey::new(vec![0x41; 32])
                    .map_err(|_| KeyResolutionError::Unavailable),
                NEW_KEY => AuthenticationKey::new(vec![0x42; 32])
                    .map_err(|_| KeyResolutionError::Unavailable),
                _ => Err(KeyResolutionError::UnknownOrRevoked),
            }
        }
    }

    #[test]
    fn enforcing_resolver_requires_signed_time_authority_before_reading_secret() {
        let directory = tempfile::tempdir().unwrap();
        let database = directory.path().join("trust.sqlite3");
        let mut store = ConnectorTrustStore::open(&database).unwrap();
        store.register(CONNECTOR, INSTANCE, OLD_KEY, NOW).unwrap();
        store
            .begin_rotation(CONNECTOR, INSTANCE, NEW_KEY, NOW + 1_000)
            .unwrap();
        drop(store);
        let resolver = TrustEnforcingKeyResolver::new(FixtureKeys, &database);

        assert!(resolver.resolve(NEW_KEY).is_err());
        assert!(resolver
            .resolve_for(NEW_KEY, CONNECTOR, INSTANCE, NOW + 2_000, NOW + 2_000)
            .is_ok());
        assert!(resolver
            .resolve_for(OLD_KEY, CONNECTOR, INSTANCE, NOW + 999, NOW + 2_000)
            .is_ok());
        assert!(matches!(
            resolver.resolve_for(OLD_KEY, CONNECTOR, INSTANCE, NOW + 1_001, NOW + 2_000),
            Err(KeyResolutionError::UnknownOrRevoked)
        ));
        assert!(matches!(
            resolver.resolve_for(
                NEW_KEY,
                "connector.claude",
                INSTANCE,
                NOW + 2_000,
                NOW + 2_000
            ),
            Err(KeyResolutionError::UnknownOrRevoked)
        ));
    }

    #[test]
    fn legacy_audit_rows_migrate_to_a_fixed_reason_without_free_text_fields() {
        let directory = tempfile::tempdir().unwrap();
        let database = directory.path().join("legacy-trust.sqlite3");
        let connection = Connection::open(&database).unwrap();
        connection
            .execute_batch(
                "CREATE TABLE connector_trust_audit (
                   sequence INTEGER PRIMARY KEY AUTOINCREMENT,
                   connector_id TEXT NOT NULL,
                   source_instance TEXT NOT NULL,
                   key_id TEXT,
                   action TEXT NOT NULL,
                   occurred_at_unix_ms INTEGER NOT NULL
                 );
                 INSERT INTO connector_trust_audit(
                   connector_id, source_instance, key_id, action, occurred_at_unix_ms
                 ) VALUES ('connector.legacy', 'instance-legacy', NULL, 'trust_reset', 1);",
            )
            .unwrap();
        drop(connection);

        let mut store = ConnectorTrustStore::open(&database).unwrap();
        store.register(CONNECTOR, INSTANCE, OLD_KEY, NOW).unwrap();
        let reasons = store
            .connection
            .prepare("SELECT reason FROM connector_trust_audit ORDER BY sequence")
            .unwrap()
            .query_map([], |row| row.get::<_, String>(0))
            .unwrap()
            .collect::<Result<Vec<_>, _>>()
            .unwrap();
        assert_eq!(reasons, vec!["legacy_migration", "initial_connection"]);

        let columns = store
            .connection
            .prepare("PRAGMA table_info(connector_trust_audit)")
            .unwrap()
            .query_map([], |row| row.get::<_, String>(1))
            .unwrap()
            .collect::<Result<Vec<_>, _>>()
            .unwrap();
        assert!(!columns.iter().any(|name| {
            let name = name.to_ascii_lowercase();
            name.contains("secret") || name.contains("blob") || name.contains("message")
        }));
    }

    #[test]
    fn rotation_and_reset_reasons_are_typed_and_persisted() {
        let mut store = ConnectorTrustStore::open_in_memory().unwrap();
        store.register(CONNECTOR, INSTANCE, OLD_KEY, NOW).unwrap();
        store
            .begin_rotation_with_reason(
                CONNECTOR,
                INSTANCE,
                NEW_KEY,
                TrustChangeReason::ConnectorReconfigured,
                NOW + 1,
            )
            .unwrap();
        store
            .reset_trust_with_reason(
                CONNECTOR,
                INSTANCE,
                TrustChangeReason::SuspectedCompromise,
                NOW + 2,
            )
            .unwrap();

        let reasons = store
            .connection
            .prepare("SELECT reason FROM connector_trust_audit ORDER BY sequence")
            .unwrap()
            .query_map([], |row| row.get::<_, String>(0))
            .unwrap()
            .collect::<Result<Vec<_>, _>>()
            .unwrap();
        assert_eq!(
            reasons,
            vec![
                "initial_connection",
                "connector_reconfigured",
                "suspected_compromise"
            ]
        );
    }

    #[test]
    fn connector_identity_capacity_is_bounded_in_the_write_transaction() {
        let mut store = ConnectorTrustStore::open_in_memory().unwrap();
        for index in 0..MAX_CONNECTOR_TRUST_IDENTITIES {
            store
                .register(
                    &format!("connector-{index}"),
                    &format!("instance-{index}"),
                    &format!("key.g{index}"),
                    NOW + i64::from(index),
                )
                .unwrap();
        }
        assert!(matches!(
            store.register(
                "connector-overflow",
                "instance-overflow",
                "key.overflow",
                NOW + 100
            ),
            Err(TrustStoreError::CapacityReached)
        ));
    }

    #[test]
    fn concurrent_rotations_commit_at_most_one_complete_transition() {
        let directory = tempfile::tempdir().unwrap();
        let database = directory.path().join("concurrent-trust.sqlite3");
        let mut initial = ConnectorTrustStore::open(&database).unwrap();
        initial.register(CONNECTOR, INSTANCE, OLD_KEY, NOW).unwrap();
        drop(initial);

        let barrier = Arc::new(Barrier::new(3));
        let mut workers = Vec::new();
        let stores = [
            ConnectorTrustStore::open(&database).unwrap(),
            ConnectorTrustStore::open(&database).unwrap(),
        ];
        for (mut store, (key_id, offset)) in stores
            .into_iter()
            .zip([(NEW_KEY, 1_i64), ("codex.instance-1.g3", 2_i64)])
        {
            let barrier = Arc::clone(&barrier);
            workers.push(std::thread::spawn(move || {
                barrier.wait();
                store.begin_rotation(CONNECTOR, INSTANCE, key_id, NOW + offset)
            }));
        }
        barrier.wait();
        let results = workers
            .into_iter()
            .map(|worker| worker.join().unwrap())
            .collect::<Vec<_>>();
        assert_eq!(results.iter().filter(|result| result.is_ok()).count(), 1);

        let store = ConnectorTrustStore::open(&database).unwrap();
        let status = store.status(CONNECTOR, INSTANCE).unwrap().unwrap();
        assert_eq!(status.generation, 2);
        assert_eq!(status.previous_key_id.as_deref(), Some(OLD_KEY));
        let key_rows: u16 = store
            .connection
            .query_row("SELECT COUNT(*) FROM connector_trust_keys", [], |row| {
                row.get(0)
            })
            .unwrap();
        let audit_rows: u16 = store
            .connection
            .query_row("SELECT COUNT(*) FROM connector_trust_audit", [], |row| {
                row.get(0)
            })
            .unwrap();
        assert_eq!(key_rows, 2);
        assert_eq!(audit_rows, 2);
    }

    #[test]
    fn a_directory_is_rejected_before_sqlite_opens() {
        let directory = tempfile::tempdir().unwrap();
        let occupied_directory = directory.path().join("occupied.sqlite3");
        std::fs::create_dir(&occupied_directory).unwrap();
        assert!(matches!(
            ConnectorTrustStore::open(&occupied_directory),
            Err(TrustStoreError::UnsafePath)
        ));
    }

    #[cfg(windows)]
    #[test]
    #[ignore = "requires Windows symbolic-link creation privilege"]
    fn database_and_parent_symbolic_links_are_rejected_before_sqlite_opens() {
        use std::os::windows::fs::{symlink_dir, symlink_file};

        let directory = tempfile::tempdir().unwrap();
        let target = directory.path().join("target.sqlite3");
        drop(ConnectorTrustStore::open(&target).unwrap());
        let file_link = directory.path().join("file-link.sqlite3");
        symlink_file(&target, &file_link).unwrap();
        assert!(matches!(
            ConnectorTrustStore::open(&file_link),
            Err(TrustStoreError::UnsafePath)
        ));
        assert!(matches!(
            ConnectorTrustStore::open_existing_read_only(&file_link),
            Err(TrustStoreError::UnsafePath)
        ));

        let real_parent = directory.path().join("real-parent");
        std::fs::create_dir(&real_parent).unwrap();
        let parent_link = directory.path().join("parent-link");
        symlink_dir(&real_parent, &parent_link).unwrap();
        assert!(matches!(
            ConnectorTrustStore::open(parent_link.join("trust.sqlite3")),
            Err(TrustStoreError::UnsafePath)
        ));
    }
}
