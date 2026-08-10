use std::{collections::HashSet, path::Path, time::Duration};

use rusqlite::{params, Connection, OptionalExtension, Transaction, TransactionBehavior};
use sha2::{Digest, Sha256};
use thiserror::Error;

use super::{initialize_ai_database, MemorySearchResult};

const MAX_ID_BYTES: usize = 96;
const MAX_CONTENT_BYTES: usize = 16 * 1024;
const MAX_SOURCE_REFERENCE_BYTES: usize = 512;
const MAX_QUERY_BYTES: usize = 128;
const MAX_SEARCH_RESULTS: usize = 20;
const MAX_RESTORE_TOMBSTONES: usize = 100_000;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum MemoryKind {
    UserPreference,
    HabitRule,
    Event,
    WorkContext,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum MemorySource {
    UserAsserted,
    UserConfirmed,
    SystemObserved,
    ModelInferred,
    UntrustedExternal,
}

impl MemorySource {
    pub fn is_low_trust(self) -> bool {
        matches!(
            self,
            Self::SystemObserved | Self::ModelInferred | Self::UntrustedExternal
        )
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum MemoryConfidence {
    High,
    Medium,
    Low,
    Unknown,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum MemorySensitivity {
    Public,
    Personal,
    Sensitive,
    Restricted,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum MemoryState {
    Draft,
    Active,
    Superseded,
    Expired,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum MemoryReviewState {
    Pending,
    Confirmed,
    Rejected,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum MemoryUsePurpose {
    CompanionResponse,
    DisplayDocument,
    UserReview,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MemoryDraft {
    pub memory_id: String,
    pub kind: MemoryKind,
    pub content: String,
    pub source: MemorySource,
    pub source_reference: Option<String>,
    pub confidence: MemoryConfidence,
    pub sensitivity: MemorySensitivity,
    pub valid_until_unix_ms: Option<i64>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct UserAssertedMemory {
    pub memory_id: String,
    pub kind: MemoryKind,
    pub content: String,
    pub sensitivity: MemorySensitivity,
    pub cloud_allowed: bool,
    pub valid_until_unix_ms: Option<i64>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MemoryRecord {
    pub memory_id: String,
    pub kind: MemoryKind,
    pub content: String,
    pub source: MemorySource,
    pub source_reference: Option<String>,
    pub confidence: MemoryConfidence,
    pub sensitivity: MemorySensitivity,
    pub state: MemoryState,
    pub review_state: MemoryReviewState,
    pub cloud_allowed: bool,
    pub valid_until_unix_ms: Option<i64>,
    pub created_at_unix_ms: i64,
    pub updated_at_unix_ms: i64,
    pub confirmed_at_unix_ms: Option<i64>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CompleteDeletionOutcome {
    Deleted,
    AlreadyDeleted,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MemoryTombstone {
    pub memory_id: String,
    pub content_digest: [u8; 32],
    pub deleted_at_unix_ms: i64,
    pub retain_until_unix_ms: i64,
}

#[derive(Debug, Error)]
pub enum MemoryStoreError {
    #[error("memory database operation failed")]
    Database(#[from] rusqlite::Error),
    #[error("memory input is invalid")]
    InvalidInput,
    #[error("memory was not found")]
    NotFound,
    #[error("memory is not a pending draft")]
    NotPendingDraft,
    #[error("memory identity was completely deleted")]
    Tombstoned,
    #[error("low-trust memory cannot claim high confidence")]
    LowTrustHighConfidence,
    #[error("sensitive model inference cannot be persisted")]
    SensitiveInferenceForbidden,
    #[error("untrusted external memory requires a source reference")]
    MissingSourceReference,
    #[error("memory is not eligible for this operation")]
    NotEligible,
    #[error("the selected memories do not have an unresolved conflict")]
    ConflictNotFound,
}

pub struct MemoryStore {
    pub(crate) connection: Connection,
}

type StoredMemory = (
    String,
    String,
    String,
    String,
    Option<String>,
    String,
    String,
    String,
    String,
    bool,
    Option<i64>,
    i64,
    i64,
    Option<i64>,
);

impl MemoryStore {
    pub fn open(path: impl AsRef<Path>) -> Result<Self, MemoryStoreError> {
        if let Some(parent) = path.as_ref().parent() {
            std::fs::create_dir_all(parent)
                .map_err(|_| rusqlite::Error::InvalidPath(parent.to_path_buf()))?;
        }
        Self::from_connection(Connection::open(path)?)
    }

    pub fn open_in_memory() -> Result<Self, MemoryStoreError> {
        Self::from_connection(Connection::open_in_memory()?)
    }

    fn from_connection(connection: Connection) -> Result<Self, MemoryStoreError> {
        connection.busy_timeout(Duration::from_secs(1))?;
        connection.pragma_update(None, "foreign_keys", "ON")?;
        connection.pragma_update(None, "journal_mode", "WAL")?;
        initialize_ai_database(&connection)?;
        Ok(Self { connection })
    }

    pub fn propose_draft(
        &mut self,
        draft: MemoryDraft,
        now_unix_ms: i64,
    ) -> Result<(), MemoryStoreError> {
        validate_timestamp(now_unix_ms)?;
        validate_id(&draft.memory_id)?;
        validate_text(&draft.content, MAX_CONTENT_BYTES)?;
        validate_expiry(draft.valid_until_unix_ms, now_unix_ms)?;
        validate_optional_text(
            draft.source_reference.as_deref(),
            MAX_SOURCE_REFERENCE_BYTES,
        )?;
        if draft.source == MemorySource::UntrustedExternal && draft.source_reference.is_none() {
            return Err(MemoryStoreError::MissingSourceReference);
        }
        if draft.source.is_low_trust() && draft.confidence == MemoryConfidence::High {
            return Err(MemoryStoreError::LowTrustHighConfidence);
        }
        if draft.source == MemorySource::ModelInferred
            && matches!(
                draft.sensitivity,
                MemorySensitivity::Sensitive | MemorySensitivity::Restricted
            )
        {
            return Err(MemoryStoreError::SensitiveInferenceForbidden);
        }

        let transaction = self
            .connection
            .transaction_with_behavior(TransactionBehavior::Immediate)?;
        reject_tombstoned(&transaction, &draft.memory_id)?;
        insert_memory(
            &transaction,
            &MemoryRecord {
                memory_id: draft.memory_id,
                kind: draft.kind,
                content: draft.content,
                source: draft.source,
                source_reference: draft.source_reference,
                confidence: draft.confidence,
                sensitivity: draft.sensitivity,
                state: MemoryState::Draft,
                review_state: MemoryReviewState::Pending,
                cloud_allowed: false,
                valid_until_unix_ms: draft.valid_until_unix_ms,
                created_at_unix_ms: now_unix_ms,
                updated_at_unix_ms: now_unix_ms,
                confirmed_at_unix_ms: None,
            },
        )?;
        transaction.commit()?;
        Ok(())
    }

    pub fn save_user_asserted(
        &mut self,
        memory: UserAssertedMemory,
        now_unix_ms: i64,
    ) -> Result<(), MemoryStoreError> {
        validate_timestamp(now_unix_ms)?;
        validate_id(&memory.memory_id)?;
        validate_text(&memory.content, MAX_CONTENT_BYTES)?;
        validate_expiry(memory.valid_until_unix_ms, now_unix_ms)?;
        if memory.sensitivity == MemorySensitivity::Restricted && memory.cloud_allowed {
            return Err(MemoryStoreError::InvalidInput);
        }
        let transaction = self
            .connection
            .transaction_with_behavior(TransactionBehavior::Immediate)?;
        reject_tombstoned(&transaction, &memory.memory_id)?;
        let record = MemoryRecord {
            memory_id: memory.memory_id,
            kind: memory.kind,
            content: memory.content,
            source: MemorySource::UserAsserted,
            source_reference: None,
            confidence: MemoryConfidence::High,
            sensitivity: memory.sensitivity,
            state: MemoryState::Active,
            review_state: MemoryReviewState::Confirmed,
            cloud_allowed: memory.cloud_allowed,
            valid_until_unix_ms: memory.valid_until_unix_ms,
            created_at_unix_ms: now_unix_ms,
            updated_at_unix_ms: now_unix_ms,
            confirmed_at_unix_ms: Some(now_unix_ms),
        };
        insert_memory(&transaction, &record)?;
        index_memory(&transaction, &record)?;
        transaction.commit()?;
        Ok(())
    }

    pub fn confirm_draft(
        &mut self,
        draft_id: &str,
        confirmed_id: &str,
        edited_content: Option<&str>,
        cloud_allowed: bool,
        now_unix_ms: i64,
    ) -> Result<MemoryRecord, MemoryStoreError> {
        validate_timestamp(now_unix_ms)?;
        validate_id(draft_id)?;
        validate_id(confirmed_id)?;
        if draft_id == confirmed_id {
            return Err(MemoryStoreError::InvalidInput);
        }
        let transaction = self
            .connection
            .transaction_with_behavior(TransactionBehavior::Immediate)?;
        reject_tombstoned(&transaction, confirmed_id)?;
        let draft = load_memory(&transaction, draft_id)?.ok_or(MemoryStoreError::NotFound)?;
        if draft.state != MemoryState::Draft || draft.review_state != MemoryReviewState::Pending {
            return Err(MemoryStoreError::NotPendingDraft);
        }
        let content = edited_content.unwrap_or(&draft.content);
        validate_text(content, MAX_CONTENT_BYTES)?;
        validate_expiry(draft.valid_until_unix_ms, now_unix_ms)?;
        if draft.sensitivity == MemorySensitivity::Restricted && cloud_allowed {
            return Err(MemoryStoreError::InvalidInput);
        }
        let confirmed = MemoryRecord {
            memory_id: confirmed_id.to_owned(),
            kind: draft.kind,
            content: content.to_owned(),
            source: MemorySource::UserConfirmed,
            source_reference: Some(draft_id.to_owned()),
            confidence: MemoryConfidence::High,
            sensitivity: draft.sensitivity,
            state: MemoryState::Active,
            review_state: MemoryReviewState::Confirmed,
            cloud_allowed,
            valid_until_unix_ms: draft.valid_until_unix_ms,
            created_at_unix_ms: now_unix_ms,
            updated_at_unix_ms: now_unix_ms,
            confirmed_at_unix_ms: Some(now_unix_ms),
        };
        insert_memory(&transaction, &confirmed)?;
        transaction.execute(
            "UPDATE memories
             SET state = 'superseded', review_state = 'confirmed', updated_at_unix_ms = ?2
             WHERE memory_id = ?1",
            params![draft_id, now_unix_ms],
        )?;
        insert_link(
            &transaction,
            "derived",
            confirmed_id,
            draft_id,
            "derived_from",
            now_unix_ms,
        )?;
        index_memory(&transaction, &confirmed)?;
        transaction.commit()?;
        Ok(confirmed)
    }

    pub fn memory(&self, memory_id: &str) -> Result<Option<MemoryRecord>, MemoryStoreError> {
        validate_id(memory_id)?;
        load_memory(&self.connection, memory_id)
    }

    pub fn record_conflict(
        &mut self,
        first_id: &str,
        second_id: &str,
        now_unix_ms: i64,
    ) -> Result<(), MemoryStoreError> {
        validate_timestamp(now_unix_ms)?;
        validate_id(first_id)?;
        validate_id(second_id)?;
        if first_id == second_id {
            return Err(MemoryStoreError::InvalidInput);
        }
        let (first_id, second_id) = if first_id < second_id {
            (first_id, second_id)
        } else {
            (second_id, first_id)
        };
        let transaction = self
            .connection
            .transaction_with_behavior(TransactionBehavior::Immediate)?;
        require_active(&transaction, first_id, now_unix_ms)?;
        require_active(&transaction, second_id, now_unix_ms)?;
        insert_link(
            &transaction,
            "conflict",
            first_id,
            second_id,
            "conflicts_with",
            now_unix_ms,
        )?;
        transaction.execute(
            "DELETE FROM memory_search WHERE memory_id IN (?1, ?2)",
            params![first_id, second_id],
        )?;
        transaction.commit()?;
        Ok(())
    }

    pub fn resolve_conflict(
        &mut self,
        winner_id: &str,
        loser_id: &str,
        now_unix_ms: i64,
    ) -> Result<(), MemoryStoreError> {
        validate_timestamp(now_unix_ms)?;
        validate_id(winner_id)?;
        validate_id(loser_id)?;
        let transaction = self
            .connection
            .transaction_with_behavior(TransactionBehavior::Immediate)?;
        let conflicts: u64 = transaction.query_row(
            "SELECT COUNT(*) FROM memory_links
             WHERE kind = 'conflicts_with'
               AND ((from_memory_id = ?1 AND to_memory_id = ?2)
                 OR (from_memory_id = ?2 AND to_memory_id = ?1))",
            params![winner_id, loser_id],
            |row| row.get(0),
        )?;
        if conflicts == 0 {
            return Err(MemoryStoreError::ConflictNotFound);
        }
        let winner = require_active(&transaction, winner_id, now_unix_ms)?;
        require_active(&transaction, loser_id, now_unix_ms)?;
        transaction.execute(
            "DELETE FROM memory_links
             WHERE kind = 'conflicts_with'
               AND ((from_memory_id = ?1 AND to_memory_id = ?2)
                 OR (from_memory_id = ?2 AND to_memory_id = ?1))",
            params![winner_id, loser_id],
        )?;
        transaction.execute(
            "UPDATE memories
             SET state = 'superseded', updated_at_unix_ms = ?2
             WHERE memory_id = ?1",
            params![loser_id, now_unix_ms],
        )?;
        transaction.execute("DELETE FROM memory_search WHERE memory_id = ?1", [loser_id])?;
        insert_link(
            &transaction,
            "supersedes",
            winner_id,
            loser_id,
            "supersedes",
            now_unix_ms,
        )?;
        index_memory(&transaction, &winner)?;
        transaction.commit()?;
        Ok(())
    }

    pub fn expire_due(&mut self, now_unix_ms: i64) -> Result<usize, MemoryStoreError> {
        validate_timestamp(now_unix_ms)?;
        let transaction = self
            .connection
            .transaction_with_behavior(TransactionBehavior::Immediate)?;
        let mut statement = transaction.prepare(
            "SELECT memory_id FROM memories
             WHERE state = 'active' AND valid_until_unix_ms <= ?1",
        )?;
        let ids = statement
            .query_map([now_unix_ms], |row| row.get::<_, String>(0))?
            .collect::<Result<Vec<_>, _>>()?;
        drop(statement);
        for id in &ids {
            transaction.execute("DELETE FROM memory_search WHERE memory_id = ?1", [id])?;
        }
        transaction.execute(
            "UPDATE memories
             SET state = 'expired', updated_at_unix_ms = ?1
             WHERE state = 'active' AND valid_until_unix_ms <= ?1",
            [now_unix_ms],
        )?;
        transaction.commit()?;
        Ok(ids.len())
    }

    pub fn eligible_for_high_confidence_fact(
        &self,
        memory_id: &str,
        now_unix_ms: i64,
    ) -> Result<bool, MemoryStoreError> {
        validate_id(memory_id)?;
        validate_timestamp(now_unix_ms)?;
        fact_eligible(&self.connection, memory_id, now_unix_ms)
    }

    pub fn search(
        &self,
        query: &str,
        limit: usize,
        now_unix_ms: i64,
    ) -> Result<Vec<MemorySearchResult>, MemoryStoreError> {
        validate_text(query, MAX_QUERY_BYTES)?;
        validate_timestamp(now_unix_ms)?;
        if limit == 0 || limit > MAX_SEARCH_RESULTS {
            return Err(MemoryStoreError::InvalidInput);
        }
        if query.chars().count() < 3 {
            let pattern = format!("%{}%", escape_like(query));
            collect_search(
                &self.connection,
                "SELECT m.memory_id, m.content, 0.0
                 FROM memory_search AS f
                 JOIN memories AS m ON m.memory_id = f.memory_id
                 WHERE f.content LIKE ?1 ESCAPE '\\'
                   AND m.state = 'active' AND m.review_state = 'confirmed'
                   AND m.source_class IN ('user_asserted', 'user_confirmed')
                   AND (m.valid_until_unix_ms IS NULL OR m.valid_until_unix_ms > ?2)
                   AND NOT EXISTS (
                     SELECT 1 FROM memory_links AS l
                     WHERE l.kind = 'conflicts_with'
                       AND (l.from_memory_id = m.memory_id OR l.to_memory_id = m.memory_id)
                   )
                 ORDER BY m.memory_id LIMIT ?3",
                &pattern,
                now_unix_ms,
                limit,
            )
        } else {
            let phrase = format!("\"{}\"", query.replace('"', "\"\""));
            collect_search(
                &self.connection,
                "SELECT m.memory_id, m.content, bm25(memory_search)
                 FROM memory_search
                 JOIN memories AS m ON m.memory_id = memory_search.memory_id
                 WHERE memory_search MATCH ?1
                   AND m.state = 'active' AND m.review_state = 'confirmed'
                   AND m.source_class IN ('user_asserted', 'user_confirmed')
                   AND (m.valid_until_unix_ms IS NULL OR m.valid_until_unix_ms > ?2)
                   AND NOT EXISTS (
                     SELECT 1 FROM memory_links AS l
                     WHERE l.kind = 'conflicts_with'
                       AND (l.from_memory_id = m.memory_id OR l.to_memory_id = m.memory_id)
                   )
                 ORDER BY bm25(memory_search), m.memory_id LIMIT ?3",
                &phrase,
                now_unix_ms,
                limit,
            )
        }
    }

    pub fn record_retrieval(
        &mut self,
        retrieval_id: &str,
        memory_ids: &[String],
        purpose: MemoryUsePurpose,
        now_unix_ms: i64,
    ) -> Result<(), MemoryStoreError> {
        validate_id(retrieval_id)?;
        validate_timestamp(now_unix_ms)?;
        if memory_ids.is_empty() || memory_ids.len() > MAX_SEARCH_RESULTS {
            return Err(MemoryStoreError::InvalidInput);
        }
        let transaction = self
            .connection
            .transaction_with_behavior(TransactionBehavior::Immediate)?;
        let mut unique = HashSet::new();
        for memory_id in memory_ids {
            validate_id(memory_id)?;
            if !unique.insert(memory_id.as_str())
                || !search_eligible(&transaction, memory_id, now_unix_ms)?
            {
                return Err(MemoryStoreError::NotEligible);
            }
            transaction.execute(
                "INSERT INTO memory_retrievals(
                    retrieval_id, memory_id, purpose, used_at_unix_ms
                 ) VALUES(?1, ?2, ?3, ?4)",
                params![retrieval_id, memory_id, purpose.as_db(), now_unix_ms],
            )?;
        }
        transaction.commit()?;
        Ok(())
    }

    pub fn delete_completely(
        &mut self,
        memory_id: &str,
        deleted_at_unix_ms: i64,
        retain_until_unix_ms: i64,
    ) -> Result<CompleteDeletionOutcome, MemoryStoreError> {
        validate_id(memory_id)?;
        validate_timestamp(deleted_at_unix_ms)?;
        if retain_until_unix_ms <= deleted_at_unix_ms {
            return Err(MemoryStoreError::InvalidInput);
        }
        let transaction = self
            .connection
            .transaction_with_behavior(TransactionBehavior::Immediate)?;
        let Some(_record) = load_memory(&transaction, memory_id)? else {
            let tombstoned: bool = transaction.query_row(
                "SELECT EXISTS(
                   SELECT 1 FROM deletion_tombstones
                   WHERE entity_type = 'memory' AND entity_id = ?1
                 )",
                [memory_id],
                |row| row.get(0),
            )?;
            return if tombstoned {
                Ok(CompleteDeletionOutcome::AlreadyDeleted)
            } else {
                Err(MemoryStoreError::NotFound)
            };
        };
        let related = related_memories(&transaction, memory_id)?;
        for (related_id, content) in related {
            let digest = Sha256::digest(content.as_bytes()).to_vec();
            transaction.execute(
                "DELETE FROM memory_search WHERE memory_id = ?1",
                [&related_id],
            )?;
            transaction.execute("DELETE FROM memories WHERE memory_id = ?1", [&related_id])?;
            upsert_memory_tombstone(
                &transaction,
                &related_id,
                &digest,
                deleted_at_unix_ms,
                retain_until_unix_ms,
            )?;
        }
        transaction.commit()?;
        Ok(CompleteDeletionOutcome::Deleted)
    }

    pub fn memory_tombstones(&self) -> Result<Vec<MemoryTombstone>, MemoryStoreError> {
        let mut statement = self.connection.prepare(
            "SELECT entity_id, content_digest, deleted_at_unix_ms, retain_until_unix_ms
             FROM deletion_tombstones
             WHERE entity_type = 'memory'
             ORDER BY entity_id",
        )?;
        let rows = statement.query_map([], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, Vec<u8>>(1)?,
                row.get::<_, i64>(2)?,
                row.get::<_, i64>(3)?,
            ))
        })?;
        rows.map(|row| {
            let (memory_id, digest, deleted_at_unix_ms, retain_until_unix_ms) = row?;
            let content_digest = digest
                .try_into()
                .map_err(|_| rusqlite::Error::InvalidQuery)?;
            Ok(MemoryTombstone {
                memory_id,
                content_digest,
                deleted_at_unix_ms,
                retain_until_unix_ms,
            })
        })
        .collect::<Result<Vec<_>, rusqlite::Error>>()
        .map_err(MemoryStoreError::from)
    }

    /// Applies the current device's deletion history to a staged, already
    /// authenticated restore candidate before that candidate may be swapped
    /// into service. Identity tombstones win over older backup contents.
    pub fn apply_restore_tombstones(
        &mut self,
        tombstones: &[MemoryTombstone],
    ) -> Result<usize, MemoryStoreError> {
        if tombstones.len() > MAX_RESTORE_TOMBSTONES {
            return Err(MemoryStoreError::InvalidInput);
        }
        for tombstone in tombstones {
            validate_id(&tombstone.memory_id)?;
            validate_timestamp(tombstone.deleted_at_unix_ms)?;
            if tombstone.retain_until_unix_ms <= tombstone.deleted_at_unix_ms {
                return Err(MemoryStoreError::InvalidInput);
            }
        }
        let transaction = self
            .connection
            .transaction_with_behavior(TransactionBehavior::Immediate)?;
        let mut deleted = 0;
        for tombstone in tombstones {
            let related = related_memories(&transaction, &tombstone.memory_id)?;
            if related.is_empty() {
                upsert_memory_tombstone(
                    &transaction,
                    &tombstone.memory_id,
                    &tombstone.content_digest,
                    tombstone.deleted_at_unix_ms,
                    tombstone.retain_until_unix_ms,
                )?;
                continue;
            }
            for (related_id, content) in related {
                let digest = if related_id == tombstone.memory_id {
                    tombstone.content_digest.to_vec()
                } else {
                    Sha256::digest(content.as_bytes()).to_vec()
                };
                transaction.execute(
                    "DELETE FROM memory_search WHERE memory_id = ?1",
                    [&related_id],
                )?;
                transaction.execute("DELETE FROM memories WHERE memory_id = ?1", [&related_id])?;
                upsert_memory_tombstone(
                    &transaction,
                    &related_id,
                    &digest,
                    tombstone.deleted_at_unix_ms,
                    tombstone.retain_until_unix_ms,
                )?;
                deleted += 1;
            }
        }
        transaction.commit()?;
        Ok(deleted)
    }

    #[cfg(test)]
    fn scalar_count(&self, table: &str) -> u64 {
        let sql = format!("SELECT COUNT(*) FROM {table}");
        self.connection
            .query_row(&sql, [], |row| row.get(0))
            .unwrap()
    }
}

fn related_memories(
    transaction: &Transaction<'_>,
    memory_id: &str,
) -> Result<Vec<(String, String)>, rusqlite::Error> {
    let mut statement = transaction.prepare(
        "WITH RECURSIVE related(memory_id) AS (
           VALUES(?1)
           UNION
           SELECT CASE
                    WHEN l.from_memory_id = related.memory_id THEN l.to_memory_id
                    ELSE l.from_memory_id
                  END
           FROM memory_links AS l
           JOIN related
             ON l.from_memory_id = related.memory_id
             OR l.to_memory_id = related.memory_id
           WHERE l.kind IN ('derived_from', 'duplicates', 'supersedes')
         )
         SELECT m.memory_id, m.content
         FROM memories AS m JOIN related USING(memory_id)",
    )?;
    let related = statement
        .query_map([memory_id], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
        })?
        .collect::<Result<Vec<_>, _>>()?;
    Ok(related)
}

fn upsert_memory_tombstone(
    transaction: &Transaction<'_>,
    memory_id: &str,
    content_digest: &[u8],
    deleted_at_unix_ms: i64,
    retain_until_unix_ms: i64,
) -> Result<(), rusqlite::Error> {
    transaction.execute(
        "INSERT INTO deletion_tombstones(
            entity_type, entity_id, content_digest,
            deleted_at_unix_ms, retain_until_unix_ms
         ) VALUES('memory', ?1, ?2, ?3, ?4)
         ON CONFLICT(entity_type, entity_id) DO UPDATE SET
            content_digest = excluded.content_digest,
            deleted_at_unix_ms = MAX(deletion_tombstones.deleted_at_unix_ms,
                                     excluded.deleted_at_unix_ms),
            retain_until_unix_ms = MAX(deletion_tombstones.retain_until_unix_ms,
                                        excluded.retain_until_unix_ms)",
        params![
            memory_id,
            content_digest,
            deleted_at_unix_ms,
            retain_until_unix_ms
        ],
    )?;
    Ok(())
}

fn insert_memory(
    transaction: &Transaction<'_>,
    record: &MemoryRecord,
) -> Result<(), rusqlite::Error> {
    transaction.execute(
        "INSERT INTO memories(
            memory_id, kind, content, source_class, source_reference,
            confidence, sensitivity, state, review_state, cloud_allowed,
            valid_until_unix_ms, created_at_unix_ms, updated_at_unix_ms,
            confirmed_at_unix_ms
         ) VALUES(?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14)",
        params![
            record.memory_id,
            record.kind.as_db(),
            record.content,
            record.source.as_db(),
            record.source_reference,
            record.confidence.as_db(),
            record.sensitivity.as_db(),
            record.state.as_db(),
            record.review_state.as_db(),
            record.cloud_allowed,
            record.valid_until_unix_ms,
            record.created_at_unix_ms,
            record.updated_at_unix_ms,
            record.confirmed_at_unix_ms,
        ],
    )?;
    Ok(())
}

fn index_memory(
    transaction: &Transaction<'_>,
    record: &MemoryRecord,
) -> Result<(), rusqlite::Error> {
    transaction.execute(
        "DELETE FROM memory_search WHERE memory_id = ?1",
        [&record.memory_id],
    )?;
    transaction.execute(
        "INSERT INTO memory_search(memory_id, content) VALUES(?1, ?2)",
        params![record.memory_id, record.content],
    )?;
    Ok(())
}

fn load_memory(
    connection: &Connection,
    memory_id: &str,
) -> Result<Option<MemoryRecord>, MemoryStoreError> {
    let stored: Option<StoredMemory> = connection
        .query_row(
            "SELECT memory_id, kind, content, source_class, source_reference,
                    confidence, sensitivity, state, review_state, cloud_allowed,
                    valid_until_unix_ms, created_at_unix_ms, updated_at_unix_ms,
                    confirmed_at_unix_ms
             FROM memories WHERE memory_id = ?1",
            [memory_id],
            |row| {
                Ok((
                    row.get(0)?,
                    row.get(1)?,
                    row.get(2)?,
                    row.get(3)?,
                    row.get(4)?,
                    row.get(5)?,
                    row.get(6)?,
                    row.get(7)?,
                    row.get(8)?,
                    row.get(9)?,
                    row.get(10)?,
                    row.get(11)?,
                    row.get(12)?,
                    row.get(13)?,
                ))
            },
        )
        .optional()?;
    stored.map(parse_stored_memory).transpose()
}

fn parse_stored_memory(stored: StoredMemory) -> Result<MemoryRecord, MemoryStoreError> {
    Ok(MemoryRecord {
        memory_id: stored.0,
        kind: MemoryKind::from_db(&stored.1)?,
        content: stored.2,
        source: MemorySource::from_db(&stored.3)?,
        source_reference: stored.4,
        confidence: MemoryConfidence::from_db(&stored.5)?,
        sensitivity: MemorySensitivity::from_db(&stored.6)?,
        state: MemoryState::from_db(&stored.7)?,
        review_state: MemoryReviewState::from_db(&stored.8)?,
        cloud_allowed: stored.9,
        valid_until_unix_ms: stored.10,
        created_at_unix_ms: stored.11,
        updated_at_unix_ms: stored.12,
        confirmed_at_unix_ms: stored.13,
    })
}

fn require_active(
    connection: &Connection,
    memory_id: &str,
    now_unix_ms: i64,
) -> Result<MemoryRecord, MemoryStoreError> {
    let memory = load_memory(connection, memory_id)?.ok_or(MemoryStoreError::NotFound)?;
    if memory.state != MemoryState::Active
        || memory.review_state != MemoryReviewState::Confirmed
        || memory
            .valid_until_unix_ms
            .is_some_and(|expiry| expiry <= now_unix_ms)
    {
        return Err(MemoryStoreError::NotEligible);
    }
    Ok(memory)
}

fn fact_eligible(
    connection: &Connection,
    memory_id: &str,
    now_unix_ms: i64,
) -> Result<bool, MemoryStoreError> {
    Ok(connection.query_row(
        "SELECT EXISTS(
           SELECT 1 FROM memories AS m
           WHERE m.memory_id = ?1
             AND m.state = 'active' AND m.review_state = 'confirmed'
             AND m.source_class IN ('user_asserted', 'user_confirmed')
             AND m.confidence = 'high'
             AND (m.valid_until_unix_ms IS NULL OR m.valid_until_unix_ms > ?2)
             AND NOT EXISTS (
               SELECT 1 FROM memory_links AS l
               WHERE l.kind = 'conflicts_with'
                 AND (l.from_memory_id = m.memory_id OR l.to_memory_id = m.memory_id)
             )
         )",
        params![memory_id, now_unix_ms],
        |row| row.get(0),
    )?)
}

fn search_eligible(
    connection: &Connection,
    memory_id: &str,
    now_unix_ms: i64,
) -> Result<bool, MemoryStoreError> {
    Ok(connection.query_row(
        "SELECT EXISTS(
           SELECT 1 FROM memories AS m
           WHERE m.memory_id = ?1
             AND m.state = 'active' AND m.review_state = 'confirmed'
             AND m.source_class IN ('user_asserted', 'user_confirmed')
             AND (m.valid_until_unix_ms IS NULL OR m.valid_until_unix_ms > ?2)
             AND NOT EXISTS (
               SELECT 1 FROM memory_links AS l
               WHERE l.kind = 'conflicts_with'
                 AND (l.from_memory_id = m.memory_id OR l.to_memory_id = m.memory_id)
             )
         )",
        params![memory_id, now_unix_ms],
        |row| row.get(0),
    )?)
}

fn reject_tombstoned(connection: &Connection, memory_id: &str) -> Result<(), MemoryStoreError> {
    let tombstoned: bool = connection.query_row(
        "SELECT EXISTS(
           SELECT 1 FROM deletion_tombstones
           WHERE entity_type = 'memory' AND entity_id = ?1
         )",
        [memory_id],
        |row| row.get(0),
    )?;
    if tombstoned {
        Err(MemoryStoreError::Tombstoned)
    } else {
        Ok(())
    }
}

fn insert_link(
    transaction: &Transaction<'_>,
    namespace: &str,
    from_memory_id: &str,
    to_memory_id: &str,
    kind: &str,
    now_unix_ms: i64,
) -> Result<(), rusqlite::Error> {
    let mut hash = Sha256::new();
    for value in [namespace, from_memory_id, to_memory_id, kind] {
        hash.update((value.len() as u32).to_be_bytes());
        hash.update(value.as_bytes());
    }
    let link_id = format!("link-{:x}", hash.finalize());
    transaction.execute(
        "INSERT OR IGNORE INTO memory_links(
            link_id, from_memory_id, to_memory_id, kind, created_at_unix_ms
         ) VALUES(?1, ?2, ?3, ?4, ?5)",
        params![link_id, from_memory_id, to_memory_id, kind, now_unix_ms],
    )?;
    Ok(())
}

fn collect_search(
    connection: &Connection,
    sql: &str,
    query: &str,
    now_unix_ms: i64,
    limit: usize,
) -> Result<Vec<MemorySearchResult>, MemoryStoreError> {
    let mut statement = connection.prepare(sql)?;
    let rows = statement.query_map(params![query, now_unix_ms, limit as i64], |row| {
        Ok(MemorySearchResult {
            memory_id: row.get(0)?,
            content: row.get(1)?,
            rank: row.get(2)?,
        })
    })?;
    Ok(rows.collect::<Result<Vec<_>, _>>()?)
}

fn escape_like(value: &str) -> String {
    value
        .replace('\\', "\\\\")
        .replace('%', "\\%")
        .replace('_', "\\_")
}

fn validate_id(value: &str) -> Result<(), MemoryStoreError> {
    validate_text(value, MAX_ID_BYTES)?;
    if !value
        .bytes()
        .all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit() || b"._-".contains(&byte))
    {
        return Err(MemoryStoreError::InvalidInput);
    }
    Ok(())
}

fn validate_text(value: &str, maximum: usize) -> Result<(), MemoryStoreError> {
    if value.trim().is_empty()
        || value.len() > maximum
        || value
            .chars()
            .any(|character| matches!(character, '\0' | '\u{202a}'..='\u{202e}' | '\u{2066}'..='\u{2069}'))
    {
        return Err(MemoryStoreError::InvalidInput);
    }
    Ok(())
}

fn validate_optional_text(value: Option<&str>, maximum: usize) -> Result<(), MemoryStoreError> {
    if let Some(value) = value {
        validate_text(value, maximum)?;
    }
    Ok(())
}

fn validate_timestamp(value: i64) -> Result<(), MemoryStoreError> {
    if value < 0 {
        Err(MemoryStoreError::InvalidInput)
    } else {
        Ok(())
    }
}

fn validate_expiry(value: Option<i64>, now_unix_ms: i64) -> Result<(), MemoryStoreError> {
    if value.is_some_and(|expiry| expiry <= now_unix_ms) {
        Err(MemoryStoreError::InvalidInput)
    } else {
        Ok(())
    }
}

macro_rules! database_enum {
    ($type:ty, {$($variant:path => $value:literal),+ $(,)?}) => {
        impl $type {
            fn as_db(self) -> &'static str {
                match self { $($variant => $value),+ }
            }

            fn from_db(value: &str) -> Result<Self, MemoryStoreError> {
                match value {
                    $($value => Ok($variant)),+,
                    _ => Err(MemoryStoreError::Database(rusqlite::Error::InvalidQuery)),
                }
            }
        }
    };
}

database_enum!(MemoryKind, {
    MemoryKind::UserPreference => "user_preference",
    MemoryKind::HabitRule => "habit_rule",
    MemoryKind::Event => "event",
    MemoryKind::WorkContext => "work_context",
});
database_enum!(MemorySource, {
    MemorySource::UserAsserted => "user_asserted",
    MemorySource::UserConfirmed => "user_confirmed",
    MemorySource::SystemObserved => "system_observed",
    MemorySource::ModelInferred => "model_inferred",
    MemorySource::UntrustedExternal => "untrusted_external",
});
database_enum!(MemoryConfidence, {
    MemoryConfidence::High => "high",
    MemoryConfidence::Medium => "medium",
    MemoryConfidence::Low => "low",
    MemoryConfidence::Unknown => "unknown",
});
database_enum!(MemorySensitivity, {
    MemorySensitivity::Public => "public",
    MemorySensitivity::Personal => "personal",
    MemorySensitivity::Sensitive => "sensitive",
    MemorySensitivity::Restricted => "restricted",
});
database_enum!(MemoryState, {
    MemoryState::Draft => "draft",
    MemoryState::Active => "active",
    MemoryState::Superseded => "superseded",
    MemoryState::Expired => "expired",
});
database_enum!(MemoryReviewState, {
    MemoryReviewState::Pending => "pending",
    MemoryReviewState::Confirmed => "confirmed",
    MemoryReviewState::Rejected => "rejected",
});

impl MemoryUsePurpose {
    fn as_db(self) -> &'static str {
        match self {
            Self::CompanionResponse => "companion_response",
            Self::DisplayDocument => "display_document",
            Self::UserReview => "user_review",
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const NOW: i64 = 1_775_212_800_000;

    fn user_memory(id: &str, content: &str) -> UserAssertedMemory {
        UserAssertedMemory {
            memory_id: id.into(),
            kind: MemoryKind::UserPreference,
            content: content.into(),
            sensitivity: MemorySensitivity::Personal,
            cloud_allowed: false,
            valid_until_unix_ms: None,
        }
    }

    fn inferred_draft(id: &str, content: &str) -> MemoryDraft {
        MemoryDraft {
            memory_id: id.into(),
            kind: MemoryKind::UserPreference,
            content: content.into(),
            source: MemorySource::ModelInferred,
            source_reference: Some("run-local-1".into()),
            confidence: MemoryConfidence::Low,
            sensitivity: MemorySensitivity::Personal,
            valid_until_unix_ms: None,
        }
    }

    #[test]
    fn low_trust_draft_is_not_searchable_or_fact_eligible_until_user_confirmation() {
        let mut store = MemoryStore::open_in_memory().unwrap();
        store
            .propose_draft(inferred_draft("draft-1", "用户可能更喜欢安静陪伴"), NOW)
            .unwrap();
        assert!(store.search("安静陪伴", 3, NOW).unwrap().is_empty());
        assert!(!store
            .eligible_for_high_confidence_fact("draft-1", NOW)
            .unwrap());

        let confirmed = store
            .confirm_draft(
                "draft-1",
                "memory-1",
                Some("我加班后更喜欢安静陪伴"),
                false,
                NOW + 1,
            )
            .unwrap();
        assert_eq!(confirmed.source, MemorySource::UserConfirmed);
        assert_eq!(
            store.memory("draft-1").unwrap().unwrap().source,
            MemorySource::ModelInferred
        );
        assert_eq!(store.search("安静陪伴", 3, NOW + 1).unwrap().len(), 1);
        assert!(store
            .eligible_for_high_confidence_fact("memory-1", NOW + 1)
            .unwrap());
        assert_eq!(store.scalar_count("memory_links"), 1);
    }

    #[test]
    fn low_trust_high_confidence_and_sensitive_inference_are_rejected() {
        let mut store = MemoryStore::open_in_memory().unwrap();
        let mut high = inferred_draft("draft-high", "用户可能喜欢晚间工作");
        high.confidence = MemoryConfidence::High;
        assert!(matches!(
            store.propose_draft(high, NOW),
            Err(MemoryStoreError::LowTrustHighConfidence)
        ));

        let mut sensitive = inferred_draft("draft-sensitive", "用户可能有健康问题");
        sensitive.sensitivity = MemorySensitivity::Sensitive;
        assert!(matches!(
            store.propose_draft(sensitive, NOW),
            Err(MemoryStoreError::SensitiveInferenceForbidden)
        ));
        assert_eq!(store.scalar_count("memories"), 0);
    }

    #[test]
    fn restored_low_trust_rows_cannot_bypass_fact_or_search_policy() {
        let store = MemoryStore::open_in_memory().unwrap();
        for (id, source) in [
            ("restored-model", "model_inferred"),
            ("restored-system", "system_observed"),
        ] {
            store
                .connection
                .execute(
                    "INSERT INTO memories(
                        memory_id, kind, content, source_class, source_reference,
                        confidence, sensitivity, state, review_state, cloud_allowed,
                        valid_until_unix_ms, created_at_unix_ms, updated_at_unix_ms,
                        confirmed_at_unix_ms
                     ) VALUES(?1, 'user_preference', '可能喜欢安静陪伴', ?2, 'restore-test',
                              'high', 'personal', 'active', 'confirmed', 0,
                              NULL, ?3, ?3, ?3)",
                    params![id, source, NOW],
                )
                .unwrap();
            store
                .connection
                .execute(
                    "INSERT INTO memory_search(memory_id, content)
                     VALUES(?1, '可能喜欢安静陪伴')",
                    [id],
                )
                .unwrap();
            assert!(!store.eligible_for_high_confidence_fact(id, NOW).unwrap());
        }
        assert!(store.search("安静陪伴", 3, NOW).unwrap().is_empty());
    }

    #[test]
    fn external_draft_keeps_its_untrusted_reference_after_adoption() {
        let mut store = MemoryStore::open_in_memory().unwrap();
        store
            .propose_draft(
                MemoryDraft {
                    memory_id: "external-draft".into(),
                    kind: MemoryKind::WorkContext,
                    content: "外部任务声称项目已经完成".into(),
                    source: MemorySource::UntrustedExternal,
                    source_reference: Some("task-event:sha256-abc".into()),
                    confidence: MemoryConfidence::Unknown,
                    sensitivity: MemorySensitivity::Personal,
                    valid_until_unix_ms: Some(NOW + 10_000),
                },
                NOW,
            )
            .unwrap();
        store
            .confirm_draft(
                "external-draft",
                "confirmed-context",
                Some("我确认这个阶段已经完成"),
                false,
                NOW + 1,
            )
            .unwrap();
        let draft = store.memory("external-draft").unwrap().unwrap();
        assert_eq!(draft.source, MemorySource::UntrustedExternal);
        assert_eq!(
            draft.source_reference.as_deref(),
            Some("task-event:sha256-abc")
        );
        assert_eq!(
            store
                .memory("confirmed-context")
                .unwrap()
                .unwrap()
                .source_reference
                .as_deref(),
            Some("external-draft")
        );
    }

    #[test]
    fn conflicts_leave_search_and_fact_generation_until_the_user_resolves_them() {
        let mut store = MemoryStore::open_in_memory().unwrap();
        store
            .save_user_asserted(user_memory("memory-a", "下午喜欢喝咖啡"), NOW)
            .unwrap();
        store
            .save_user_asserted(user_memory("memory-b", "下午不喝咖啡"), NOW)
            .unwrap();
        store
            .record_conflict("memory-a", "memory-b", NOW + 1)
            .unwrap();
        assert!(store.search("下午", 3, NOW + 1).unwrap().is_empty());
        assert!(!store
            .eligible_for_high_confidence_fact("memory-a", NOW + 1)
            .unwrap());

        store
            .resolve_conflict("memory-b", "memory-a", NOW + 2)
            .unwrap();
        assert_eq!(
            store.search("下午", 3, NOW + 2).unwrap()[0].memory_id,
            "memory-b"
        );
        assert_eq!(
            store.memory("memory-a").unwrap().unwrap().state,
            MemoryState::Superseded
        );
    }

    #[test]
    fn expiry_removes_search_visibility_without_erasing_audit_history() {
        let mut store = MemoryStore::open_in_memory().unwrap();
        let mut memory = user_memory("memory-expiring", "当前项目进入收尾阶段");
        memory.valid_until_unix_ms = Some(NOW + 10);
        store.save_user_asserted(memory, NOW).unwrap();
        assert_eq!(store.search("收尾阶段", 3, NOW + 1).unwrap().len(), 1);
        assert_eq!(store.expire_due(NOW + 10).unwrap(), 1);
        assert!(store.search("收尾阶段", 3, NOW + 10).unwrap().is_empty());
        assert_eq!(
            store.memory("memory-expiring").unwrap().unwrap().state,
            MemoryState::Expired
        );
    }

    #[test]
    fn retrieval_audit_is_atomic_and_never_accepts_a_draft() {
        let mut store = MemoryStore::open_in_memory().unwrap();
        store
            .save_user_asserted(user_memory("memory-1", "喜欢简洁的信息牌"), NOW)
            .unwrap();
        store
            .propose_draft(inferred_draft("draft-1", "可能喜欢蓝色"), NOW)
            .unwrap();
        let result = store.record_retrieval(
            "retrieval-1",
            &["memory-1".into(), "draft-1".into()],
            MemoryUsePurpose::DisplayDocument,
            NOW + 1,
        );
        assert!(matches!(result, Err(MemoryStoreError::NotEligible)));
        assert_eq!(store.scalar_count("memory_retrievals"), 0);
        store
            .record_retrieval(
                "retrieval-2",
                &["memory-1".into()],
                MemoryUsePurpose::CompanionResponse,
                NOW + 1,
            )
            .unwrap();
        assert_eq!(store.scalar_count("memory_retrievals"), 1);
    }

    #[test]
    fn complete_delete_cascades_text_links_retrievals_and_blocks_backup_resurrection() {
        let mut store = MemoryStore::open_in_memory().unwrap();
        store
            .propose_draft(inferred_draft("draft-1", "可能喜欢安静陪伴"), NOW)
            .unwrap();
        store
            .confirm_draft("draft-1", "memory-1", None, false, NOW + 1)
            .unwrap();
        store
            .record_retrieval(
                "retrieval-1",
                &["memory-1".into()],
                MemoryUsePurpose::UserReview,
                NOW + 2,
            )
            .unwrap();
        assert_eq!(store.scalar_count("memory_search"), 1);

        assert_eq!(
            store
                .delete_completely("memory-1", NOW + 3, NOW + 1_000_000)
                .unwrap(),
            CompleteDeletionOutcome::Deleted
        );
        assert!(store.memory("memory-1").unwrap().is_none());
        assert!(store.memory("draft-1").unwrap().is_none());
        assert_eq!(store.scalar_count("memories"), 0);
        assert_eq!(store.scalar_count("memory_search"), 0);
        assert_eq!(store.scalar_count("memory_retrievals"), 0);
        assert_eq!(store.scalar_count("memory_links"), 0);
        assert_eq!(store.scalar_count("deletion_tombstones"), 2);
        assert!(matches!(
            store.save_user_asserted(user_memory("memory-1", "旧备份中的内容"), NOW + 4),
            Err(MemoryStoreError::Tombstoned)
        ));
        assert_eq!(
            store
                .delete_completely("memory-1", NOW + 5, NOW + 2_000_000)
                .unwrap(),
            CompleteDeletionOutcome::AlreadyDeleted
        );
    }

    #[test]
    fn failed_tombstone_write_rolls_back_every_delete_side_effect() {
        let mut store = MemoryStore::open_in_memory().unwrap();
        store
            .save_user_asserted(user_memory("memory-rollback", "喜欢安静的信息牌"), NOW)
            .unwrap();
        store
            .connection
            .execute_batch(
                "CREATE TRIGGER reject_memory_tombstone
                 BEFORE INSERT ON deletion_tombstones
                 BEGIN SELECT RAISE(ABORT, 'test tombstone failure'); END;",
            )
            .unwrap();

        assert!(matches!(
            store.delete_completely("memory-rollback", NOW + 1, NOW + 10_000),
            Err(MemoryStoreError::Database(_))
        ));
        assert!(store.memory("memory-rollback").unwrap().is_some());
        assert_eq!(store.scalar_count("memory_search"), 1);
        assert_eq!(store.scalar_count("deletion_tombstones"), 0);

        store
            .connection
            .execute_batch("DROP TRIGGER reject_memory_tombstone;")
            .unwrap();
        assert_eq!(
            store
                .delete_completely("memory-rollback", NOW + 2, NOW + 10_000)
                .unwrap(),
            CompleteDeletionOutcome::Deleted
        );
    }

    #[test]
    fn current_tombstones_remove_resurrected_lineage_from_a_staged_old_backup() {
        let mut current = MemoryStore::open_in_memory().unwrap();
        current
            .propose_draft(inferred_draft("draft-old", "可能喜欢安静陪伴"), NOW)
            .unwrap();
        current
            .confirm_draft("draft-old", "memory-old", None, false, NOW + 1)
            .unwrap();
        current
            .delete_completely("memory-old", NOW + 2, NOW + 1_000_000)
            .unwrap();
        let tombstones = current.memory_tombstones().unwrap();
        assert_eq!(tombstones.len(), 2);

        let mut staged_restore = MemoryStore::open_in_memory().unwrap();
        staged_restore
            .propose_draft(inferred_draft("draft-old", "可能喜欢安静陪伴"), NOW)
            .unwrap();
        staged_restore
            .confirm_draft("draft-old", "memory-old", None, false, NOW + 1)
            .unwrap();
        assert_eq!(staged_restore.scalar_count("memories"), 2);

        assert_eq!(
            staged_restore
                .apply_restore_tombstones(&tombstones)
                .unwrap(),
            2
        );
        assert_eq!(staged_restore.scalar_count("memories"), 0);
        assert_eq!(staged_restore.scalar_count("memory_search"), 0);
        assert_eq!(staged_restore.scalar_count("memory_links"), 0);
        assert_eq!(staged_restore.scalar_count("deletion_tombstones"), 2);
    }

    #[test]
    fn wildcard_and_fts_operators_remain_literal_in_formal_memory_search() {
        let mut store = MemoryStore::open_in_memory().unwrap();
        store
            .save_user_asserted(user_memory("memory-percent", "进度 100%_完成"), NOW)
            .unwrap();
        store
            .save_user_asserted(user_memory("memory-calm", "开会前容易焦虑"), NOW)
            .unwrap();
        assert_eq!(
            store.search("%_", 3, NOW).unwrap()[0].memory_id,
            "memory-percent"
        );
        assert!(store.search("焦虑 OR 完成", 3, NOW).unwrap().is_empty());
    }
}
