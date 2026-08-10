use rusqlite::{params, OptionalExtension, TransactionBehavior};
use sha2::{Digest, Sha256};
use thiserror::Error;

use crate::{CompleteDeletionOutcome, MemoryStore};

const MAX_ID_BYTES: usize = 96;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ApproachDistance {
    Near,
    Comfortable,
    Far,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum FailureFirstResponse {
    QuietPresence,
    OfferChoices,
    ShowEvidence,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AvoidSupportMethod {
    Breathing,
    Listening,
    Movement,
    CheckIn,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum FollowUpPreference {
    None,
    Once,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ConfirmedSupportPreference {
    ApproachDistance(ApproachDistance),
    FailureFirstResponse(FailureFirstResponse),
    AvoidMethod(AvoidSupportMethod),
    FollowUp(FollowUpPreference),
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum SupportPreferenceScope {
    Global,
    Project { workspace_key: String },
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SupportPreferenceRecord {
    pub preference_id: String,
    pub preference: ConfirmedSupportPreference,
    pub scope: SupportPreferenceScope,
    pub created_at_unix_ms: i64,
    pub updated_at_unix_ms: i64,
    pub confirmed_at_unix_ms: i64,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SupportPreferenceTombstone {
    pub preference_id: String,
    pub content_digest: [u8; 32],
    pub deleted_at_unix_ms: i64,
    pub retain_until_unix_ms: i64,
}

#[derive(Debug, Error)]
pub enum SupportPreferenceError {
    #[error("support preference database operation failed")]
    Database(#[from] rusqlite::Error),
    #[error("support preference input is invalid")]
    InvalidInput,
    #[error("support preference was not found")]
    NotFound,
    #[error("support preference identity was completely deleted")]
    Tombstoned,
}

impl MemoryStore {
    /// Saves only a typed preference that the caller has already presented to
    /// and confirmed with the user. There is intentionally no free-text field
    /// through which the original support conversation could be persisted.
    pub fn save_confirmed_support_preference(
        &mut self,
        preference_id: &str,
        preference: ConfirmedSupportPreference,
        scope: SupportPreferenceScope,
        now_unix_ms: i64,
    ) -> Result<(), SupportPreferenceError> {
        validate_id(preference_id)?;
        validate_timestamp(now_unix_ms)?;
        let (scope_text, workspace_key) = scope_parts(&scope)?;
        let (kind, value) = preference.as_db();
        let transaction = self
            .connection
            .transaction_with_behavior(TransactionBehavior::Immediate)?;
        let tombstoned: bool = transaction.query_row(
            "SELECT EXISTS(
               SELECT 1 FROM deletion_tombstones
               WHERE entity_type = 'support_preference' AND entity_id = ?1
             )",
            [preference_id],
            |row| row.get(0),
        )?;
        if tombstoned {
            return Err(SupportPreferenceError::Tombstoned);
        }
        let created_at: Option<i64> = transaction
            .query_row(
                "SELECT created_at_unix_ms FROM support_preferences
                 WHERE preference_id = ?1",
                [preference_id],
                |row| row.get(0),
            )
            .optional()?;
        transaction.execute(
            "INSERT INTO support_preferences(
                preference_id, preference_kind, preference_value,
                scope, workspace_key, created_at_unix_ms,
                updated_at_unix_ms, confirmed_at_unix_ms
             ) VALUES(?1, ?2, ?3, ?4, ?5, ?6, ?7, ?7)
             ON CONFLICT(preference_id) DO UPDATE SET
                preference_kind = excluded.preference_kind,
                preference_value = excluded.preference_value,
                scope = excluded.scope,
                workspace_key = excluded.workspace_key,
                updated_at_unix_ms = excluded.updated_at_unix_ms,
                confirmed_at_unix_ms = excluded.confirmed_at_unix_ms",
            params![
                preference_id,
                kind,
                value,
                scope_text,
                workspace_key,
                created_at.unwrap_or(now_unix_ms),
                now_unix_ms,
            ],
        )?;
        transaction.commit()?;
        Ok(())
    }

    pub fn support_preferences(
        &self,
        workspace_key: Option<&str>,
    ) -> Result<Vec<SupportPreferenceRecord>, SupportPreferenceError> {
        if let Some(workspace_key) = workspace_key {
            validate_id(workspace_key)?;
        }
        let mut statement = self.connection.prepare(
            "SELECT preference_id, preference_kind, preference_value,
                    scope, workspace_key, created_at_unix_ms,
                    updated_at_unix_ms, confirmed_at_unix_ms
             FROM support_preferences
             WHERE scope = 'global'
                OR (scope = 'project' AND workspace_key = ?1)
             ORDER BY scope, preference_kind, preference_id",
        )?;
        let rows = statement.query_map([workspace_key], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, String>(2)?,
                row.get::<_, String>(3)?,
                row.get::<_, Option<String>>(4)?,
                row.get::<_, i64>(5)?,
                row.get::<_, i64>(6)?,
                row.get::<_, i64>(7)?,
            ))
        })?;
        rows.map(|row| {
            let (id, kind, value, scope, workspace, created, updated, confirmed) = row?;
            Ok(SupportPreferenceRecord {
                preference_id: id,
                preference: ConfirmedSupportPreference::from_db(&kind, &value)?,
                scope: match (scope.as_str(), workspace) {
                    ("global", None) => SupportPreferenceScope::Global,
                    ("project", Some(workspace_key)) => {
                        SupportPreferenceScope::Project { workspace_key }
                    }
                    _ => return Err(SupportPreferenceError::InvalidInput),
                },
                created_at_unix_ms: created,
                updated_at_unix_ms: updated,
                confirmed_at_unix_ms: confirmed,
            })
        })
        .collect()
    }

    pub fn delete_support_preference(
        &mut self,
        preference_id: &str,
        deleted_at_unix_ms: i64,
        retain_until_unix_ms: i64,
    ) -> Result<CompleteDeletionOutcome, SupportPreferenceError> {
        validate_id(preference_id)?;
        validate_timestamp(deleted_at_unix_ms)?;
        if retain_until_unix_ms <= deleted_at_unix_ms {
            return Err(SupportPreferenceError::InvalidInput);
        }
        let transaction = self
            .connection
            .transaction_with_behavior(TransactionBehavior::Immediate)?;
        let stored: Option<(String, String, String, Option<String>)> = transaction
            .query_row(
                "SELECT preference_kind, preference_value, scope, workspace_key
                 FROM support_preferences WHERE preference_id = ?1",
                [preference_id],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
            )
            .optional()?;
        let Some((kind, value, scope, workspace)) = stored else {
            let tombstoned: bool = transaction.query_row(
                "SELECT EXISTS(
                   SELECT 1 FROM deletion_tombstones
                   WHERE entity_type = 'support_preference' AND entity_id = ?1
                 )",
                [preference_id],
                |row| row.get(0),
            )?;
            return if tombstoned {
                Ok(CompleteDeletionOutcome::AlreadyDeleted)
            } else {
                Err(SupportPreferenceError::NotFound)
            };
        };
        let digest = preference_digest(&kind, &value, &scope, workspace.as_deref());
        transaction.execute(
            "DELETE FROM support_preferences WHERE preference_id = ?1",
            [preference_id],
        )?;
        upsert_tombstone(
            &transaction,
            preference_id,
            &digest,
            deleted_at_unix_ms,
            retain_until_unix_ms,
        )?;
        transaction.commit()?;
        Ok(CompleteDeletionOutcome::Deleted)
    }

    pub fn support_preference_tombstones(
        &self,
    ) -> Result<Vec<SupportPreferenceTombstone>, SupportPreferenceError> {
        let mut statement = self.connection.prepare(
            "SELECT entity_id, content_digest, deleted_at_unix_ms, retain_until_unix_ms
             FROM deletion_tombstones
             WHERE entity_type = 'support_preference'
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
            let (preference_id, digest, deleted, retain) = row?;
            Ok(SupportPreferenceTombstone {
                preference_id,
                content_digest: digest
                    .try_into()
                    .map_err(|_| rusqlite::Error::InvalidQuery)?,
                deleted_at_unix_ms: deleted,
                retain_until_unix_ms: retain,
            })
        })
        .collect::<Result<Vec<_>, rusqlite::Error>>()
        .map_err(SupportPreferenceError::from)
    }

    pub fn apply_support_preference_tombstones(
        &mut self,
        tombstones: &[SupportPreferenceTombstone],
    ) -> Result<usize, SupportPreferenceError> {
        for tombstone in tombstones {
            validate_id(&tombstone.preference_id)?;
            validate_timestamp(tombstone.deleted_at_unix_ms)?;
            if tombstone.retain_until_unix_ms <= tombstone.deleted_at_unix_ms {
                return Err(SupportPreferenceError::InvalidInput);
            }
        }
        let transaction = self
            .connection
            .transaction_with_behavior(TransactionBehavior::Immediate)?;
        let mut deleted = 0;
        for tombstone in tombstones {
            deleted += transaction.execute(
                "DELETE FROM support_preferences WHERE preference_id = ?1",
                [&tombstone.preference_id],
            )?;
            upsert_tombstone(
                &transaction,
                &tombstone.preference_id,
                &tombstone.content_digest,
                tombstone.deleted_at_unix_ms,
                tombstone.retain_until_unix_ms,
            )?;
        }
        transaction.commit()?;
        Ok(deleted)
    }
}

impl ConfirmedSupportPreference {
    fn as_db(self) -> (&'static str, &'static str) {
        match self {
            Self::ApproachDistance(ApproachDistance::Near) => ("approach_distance", "near"),
            Self::ApproachDistance(ApproachDistance::Comfortable) => {
                ("approach_distance", "comfortable")
            }
            Self::ApproachDistance(ApproachDistance::Far) => ("approach_distance", "far"),
            Self::FailureFirstResponse(FailureFirstResponse::QuietPresence) => {
                ("failure_first_response", "quiet_presence")
            }
            Self::FailureFirstResponse(FailureFirstResponse::OfferChoices) => {
                ("failure_first_response", "offer_choices")
            }
            Self::FailureFirstResponse(FailureFirstResponse::ShowEvidence) => {
                ("failure_first_response", "show_evidence")
            }
            Self::AvoidMethod(AvoidSupportMethod::Breathing) => ("avoid_method", "breathing"),
            Self::AvoidMethod(AvoidSupportMethod::Listening) => ("avoid_method", "listening"),
            Self::AvoidMethod(AvoidSupportMethod::Movement) => ("avoid_method", "movement"),
            Self::AvoidMethod(AvoidSupportMethod::CheckIn) => ("avoid_method", "check_in"),
            Self::FollowUp(FollowUpPreference::None) => ("follow_up", "none"),
            Self::FollowUp(FollowUpPreference::Once) => ("follow_up", "once"),
        }
    }

    fn from_db(kind: &str, value: &str) -> Result<Self, SupportPreferenceError> {
        match (kind, value) {
            ("approach_distance", "near") => Ok(Self::ApproachDistance(ApproachDistance::Near)),
            ("approach_distance", "comfortable") => {
                Ok(Self::ApproachDistance(ApproachDistance::Comfortable))
            }
            ("approach_distance", "far") => Ok(Self::ApproachDistance(ApproachDistance::Far)),
            ("failure_first_response", "quiet_presence") => Ok(Self::FailureFirstResponse(
                FailureFirstResponse::QuietPresence,
            )),
            ("failure_first_response", "offer_choices") => Ok(Self::FailureFirstResponse(
                FailureFirstResponse::OfferChoices,
            )),
            ("failure_first_response", "show_evidence") => Ok(Self::FailureFirstResponse(
                FailureFirstResponse::ShowEvidence,
            )),
            ("avoid_method", "breathing") => Ok(Self::AvoidMethod(AvoidSupportMethod::Breathing)),
            ("avoid_method", "listening") => Ok(Self::AvoidMethod(AvoidSupportMethod::Listening)),
            ("avoid_method", "movement") => Ok(Self::AvoidMethod(AvoidSupportMethod::Movement)),
            ("avoid_method", "check_in") => Ok(Self::AvoidMethod(AvoidSupportMethod::CheckIn)),
            ("follow_up", "none") => Ok(Self::FollowUp(FollowUpPreference::None)),
            ("follow_up", "once") => Ok(Self::FollowUp(FollowUpPreference::Once)),
            _ => Err(SupportPreferenceError::InvalidInput),
        }
    }
}

fn scope_parts(
    scope: &SupportPreferenceScope,
) -> Result<(&'static str, Option<&str>), SupportPreferenceError> {
    match scope {
        SupportPreferenceScope::Global => Ok(("global", None)),
        SupportPreferenceScope::Project { workspace_key } => {
            validate_id(workspace_key)?;
            Ok(("project", Some(workspace_key)))
        }
    }
}

fn preference_digest(kind: &str, value: &str, scope: &str, workspace: Option<&str>) -> Vec<u8> {
    let mut hash = Sha256::new();
    for item in [kind, value, scope, workspace.unwrap_or("")] {
        hash.update((item.len() as u32).to_be_bytes());
        hash.update(item.as_bytes());
    }
    hash.finalize().to_vec()
}

fn upsert_tombstone(
    transaction: &rusqlite::Transaction<'_>,
    preference_id: &str,
    digest: &[u8],
    deleted_at_unix_ms: i64,
    retain_until_unix_ms: i64,
) -> Result<(), rusqlite::Error> {
    transaction.execute(
        "INSERT INTO deletion_tombstones(
            entity_type, entity_id, content_digest,
            deleted_at_unix_ms, retain_until_unix_ms
         ) VALUES('support_preference', ?1, ?2, ?3, ?4)
         ON CONFLICT(entity_type, entity_id) DO UPDATE SET
            content_digest = excluded.content_digest,
            deleted_at_unix_ms = MAX(deletion_tombstones.deleted_at_unix_ms,
                                     excluded.deleted_at_unix_ms),
            retain_until_unix_ms = MAX(deletion_tombstones.retain_until_unix_ms,
                                        excluded.retain_until_unix_ms)",
        params![
            preference_id,
            digest,
            deleted_at_unix_ms,
            retain_until_unix_ms
        ],
    )?;
    Ok(())
}

fn validate_id(value: &str) -> Result<(), SupportPreferenceError> {
    if value.is_empty()
        || value.len() > MAX_ID_BYTES
        || !value.bytes().all(|byte| {
            byte.is_ascii_lowercase() || byte.is_ascii_digit() || b"._-".contains(&byte)
        })
    {
        return Err(SupportPreferenceError::InvalidInput);
    }
    Ok(())
}

fn validate_timestamp(value: i64) -> Result<(), SupportPreferenceError> {
    if value < 0 {
        Err(SupportPreferenceError::InvalidInput)
    } else {
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const NOW: i64 = 1_775_212_800_000;

    #[test]
    fn only_typed_user_confirmed_preferences_can_be_persisted() {
        let mut store = MemoryStore::open_in_memory().unwrap();
        store
            .save_confirmed_support_preference(
                "preference-distance",
                ConfirmedSupportPreference::ApproachDistance(ApproachDistance::Far),
                SupportPreferenceScope::Global,
                NOW,
            )
            .unwrap();
        let records = store.support_preferences(None).unwrap();
        assert_eq!(records.len(), 1);
        assert_eq!(
            records[0].preference,
            ConfirmedSupportPreference::ApproachDistance(ApproachDistance::Far)
        );

        let columns: Vec<String> = store
            .connection
            .prepare("SELECT name FROM pragma_table_info('support_preferences')")
            .unwrap()
            .query_map([], |row| row.get(0))
            .unwrap()
            .collect::<Result<_, _>>()
            .unwrap();
        assert!(!columns.iter().any(|column| {
            matches!(
                column.as_str(),
                "text" | "content" | "reason" | "transcript"
            )
        }));
    }

    #[test]
    fn project_preferences_do_not_leak_into_other_workspaces() {
        let mut store = MemoryStore::open_in_memory().unwrap();
        store
            .save_confirmed_support_preference(
                "global-follow-up",
                ConfirmedSupportPreference::FollowUp(FollowUpPreference::None),
                SupportPreferenceScope::Global,
                NOW,
            )
            .unwrap();
        store
            .save_confirmed_support_preference(
                "project-distance",
                ConfirmedSupportPreference::ApproachDistance(ApproachDistance::Near),
                SupportPreferenceScope::Project {
                    workspace_key: "project-a".into(),
                },
                NOW,
            )
            .unwrap();
        assert_eq!(
            store.support_preferences(Some("project-a")).unwrap().len(),
            2
        );
        assert_eq!(
            store.support_preferences(Some("project-b")).unwrap().len(),
            1
        );
        assert_eq!(store.support_preferences(None).unwrap().len(), 1);
    }

    #[test]
    fn deletion_and_restore_tombstones_prevent_preference_resurrection() {
        let mut current = MemoryStore::open_in_memory().unwrap();
        current
            .save_confirmed_support_preference(
                "avoid-breathing",
                ConfirmedSupportPreference::AvoidMethod(AvoidSupportMethod::Breathing),
                SupportPreferenceScope::Global,
                NOW,
            )
            .unwrap();
        assert_eq!(
            current
                .delete_support_preference("avoid-breathing", NOW + 1, NOW + 10_000)
                .unwrap(),
            CompleteDeletionOutcome::Deleted
        );
        let tombstones = current.support_preference_tombstones().unwrap();
        assert_eq!(tombstones.len(), 1);
        assert!(matches!(
            current.save_confirmed_support_preference(
                "avoid-breathing",
                ConfirmedSupportPreference::AvoidMethod(AvoidSupportMethod::Breathing),
                SupportPreferenceScope::Global,
                NOW + 2,
            ),
            Err(SupportPreferenceError::Tombstoned)
        ));

        let mut staged_restore = MemoryStore::open_in_memory().unwrap();
        staged_restore
            .save_confirmed_support_preference(
                "avoid-breathing",
                ConfirmedSupportPreference::AvoidMethod(AvoidSupportMethod::Breathing),
                SupportPreferenceScope::Global,
                NOW,
            )
            .unwrap();
        assert_eq!(
            staged_restore
                .apply_support_preference_tombstones(&tombstones)
                .unwrap(),
            1
        );
        assert!(staged_restore.support_preferences(None).unwrap().is_empty());
    }

    #[test]
    fn database_constraints_reject_untyped_values_even_if_an_import_bypasses_the_api() {
        let store = MemoryStore::open_in_memory().unwrap();
        assert!(store
            .connection
            .execute(
                "INSERT INTO support_preferences(
                    preference_id, preference_kind, preference_value,
                    scope, workspace_key, created_at_unix_ms,
                    updated_at_unix_ms, confirmed_at_unix_ms
                 ) VALUES('bad', 'avoid_method', 'store_everything',
                          'global', NULL, ?1, ?1, ?1)",
                [NOW],
            )
            .is_err());
    }
}
