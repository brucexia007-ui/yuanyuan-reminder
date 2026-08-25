use std::{
    fs::{self, File},
    io::Read,
    path::{Path, PathBuf},
    time::Duration,
};

use rusqlite::{backup::Progress, Connection, OpenFlags, MAIN_DB};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use crate::error::{AppError, AppResult};

use super::{
    repository::{portability, LearningRepository, CURRENT_SCHEMA_VERSION},
    LearningRuntime,
};

const LEGACY_MIGRATION_PREVIEW_TTL_MILLIS: i64 = 10 * 60 * 1_000;
const MAX_PENDING_LEGACY_MIGRATIONS: usize = 4;
const LEARNING_DATABASE_FILE_NAME: &str = "yuanyuan-learning.sqlite3";

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum LegacyLearningEdition {
    Preview,
    Personal,
}

impl LegacyLearningEdition {
    fn key(self) -> &'static str {
        match self {
            Self::Preview => "preview",
            Self::Personal => "personal",
        }
    }

    fn identifier(self) -> &'static str {
        match self {
            Self::Preview => "com.yuanyuan.reminder.learning-preview",
            Self::Personal => "com.yuanyuan.reminder.learning-personal",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LegacyLearningSourceSummary {
    pub schema_version: u32,
    pub edition: LegacyLearningEdition,
    pub status: &'static str,
    pub source_schema_version: Option<u32>,
    pub card_count: u32,
    pub review_count: u32,
    pub failure_reason: Option<&'static str>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LegacyLearningMigrationPreview {
    pub schema_version: u32,
    pub status: &'static str,
    pub edition: LegacyLearningEdition,
    pub preview_token: Option<String>,
    pub expires_at_unix_ms: Option<i64>,
    pub source_card_count: u32,
    pub source_review_count: u32,
    pub destination_card_count: u32,
    pub destination_review_count: u32,
    pub replaces_destination: bool,
    pub backup_required: bool,
    pub source_directory_preserved: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LegacyLearningMigrationResult {
    pub schema_version: u32,
    pub status: &'static str,
    pub edition: LegacyLearningEdition,
    pub imported_card_count: u32,
    pub imported_review_count: u32,
    pub backup_file_name: Option<String>,
    pub source_directory_preserved: bool,
    pub destination_verified: bool,
}

#[derive(Debug, Clone)]
pub(super) struct PendingLegacyMigration {
    edition: LegacyLearningEdition,
    source_path: PathBuf,
    source_fingerprint: String,
    target_fingerprint: String,
    source_card_count: u32,
    source_review_count: u32,
    expires_at_unix_ms: i64,
}

struct SourceInspection {
    summary: LegacyLearningSourceSummary,
    path: PathBuf,
    fingerprint: Option<String>,
}

impl LearningRuntime {
    pub fn list_legacy_learning_sources(&mut self) -> AppResult<Vec<LegacyLearningSourceSummary>> {
        let target_path = self.target_database_path()?;
        let mut inspections = [
            LegacyLearningEdition::Preview,
            LegacyLearningEdition::Personal,
        ]
        .into_iter()
        .map(|edition| inspect_source(&legacy_database_path(&target_path, edition)?, edition))
        .collect::<AppResult<Vec<_>>>()?;
        let repository = self.ensure_repository()?;
        for inspection in &mut inspections {
            if let Some(fingerprint) = inspection.fingerprint.as_deref() {
                if repository
                    .legacy_migration_matches(inspection.summary.edition.key(), fingerprint)?
                {
                    inspection.summary.status = "already_migrated";
                }
            }
        }
        Ok(inspections
            .into_iter()
            .map(|inspection| inspection.summary)
            .collect())
    }

    pub fn preview_legacy_learning_migration(
        &mut self,
        edition: LegacyLearningEdition,
        now_unix_ms: i64,
    ) -> AppResult<LegacyLearningMigrationPreview> {
        if now_unix_ms < 0 {
            return Err(AppError::Validation(
                "legacy learning migration preview is unavailable".into(),
            ));
        }
        self.pending_legacy_migrations
            .retain(|_, pending| pending.expires_at_unix_ms > now_unix_ms);
        if self.pending_legacy_migrations.len() >= MAX_PENDING_LEGACY_MIGRATIONS {
            return Err(AppError::Validation(
                "too many legacy learning migration previews are pending".into(),
            ));
        }
        let target_path = self.target_database_path()?;
        let inspection = inspect_source(&legacy_database_path(&target_path, edition)?, edition)?;
        if inspection.summary.status != "available" {
            return Err(AppError::Validation(
                "legacy learning source is unavailable".into(),
            ));
        }
        let source_fingerprint = inspection.fingerprint.clone().ok_or_else(|| {
            AppError::Validation("legacy learning source fingerprint is unavailable".into())
        })?;
        let destination = self.ensure_repository()?.data_summary()?;
        if self
            .ensure_repository()?
            .legacy_migration_matches(edition.key(), &source_fingerprint)?
        {
            return Ok(LegacyLearningMigrationPreview {
                schema_version: 1,
                status: "already_migrated",
                edition,
                preview_token: None,
                expires_at_unix_ms: None,
                source_card_count: inspection.summary.card_count,
                source_review_count: inspection.summary.review_count,
                destination_card_count: destination.card_count,
                destination_review_count: destination.review_count,
                replaces_destination: false,
                backup_required: false,
                source_directory_preserved: true,
            });
        }
        let target_fingerprint = database_fingerprint(&target_path)?;
        let expires_at_unix_ms = now_unix_ms
            .checked_add(LEGACY_MIGRATION_PREVIEW_TTL_MILLIS)
            .ok_or_else(|| AppError::Time("legacy migration preview time overflowed".into()))?;
        let token = uuid::Uuid::new_v4().to_string();
        self.pending_legacy_migrations.insert(
            token.clone(),
            PendingLegacyMigration {
                edition,
                source_path: inspection.path,
                source_fingerprint,
                target_fingerprint,
                source_card_count: inspection.summary.card_count,
                source_review_count: inspection.summary.review_count,
                expires_at_unix_ms,
            },
        );
        Ok(LegacyLearningMigrationPreview {
            schema_version: 1,
            status: "confirmation_required",
            edition,
            preview_token: Some(token),
            expires_at_unix_ms: Some(expires_at_unix_ms),
            source_card_count: inspection.summary.card_count,
            source_review_count: inspection.summary.review_count,
            destination_card_count: destination.card_count,
            destination_review_count: destination.review_count,
            replaces_destination: destination.card_count > 0 || destination.review_count > 0,
            backup_required: true,
            source_directory_preserved: true,
        })
    }

    pub fn confirm_legacy_learning_migration(
        &mut self,
        preview_token: &str,
        now_unix_ms: i64,
    ) -> AppResult<LegacyLearningMigrationResult> {
        if uuid::Uuid::parse_str(preview_token).is_err() || now_unix_ms < 0 {
            return Err(AppError::Validation(
                "legacy learning migration preview is invalid or expired".into(),
            ));
        }
        self.pending_legacy_migrations
            .retain(|_, pending| pending.expires_at_unix_ms > now_unix_ms);
        let pending = self
            .pending_legacy_migrations
            .remove(preview_token)
            .ok_or_else(|| {
                AppError::Validation(
                    "legacy learning migration preview is invalid or expired".into(),
                )
            })?;
        let inspection = inspect_source(&pending.source_path, pending.edition)?;
        if inspection.summary.status != "available"
            || inspection.fingerprint.as_deref() != Some(&pending.source_fingerprint)
            || inspection.summary.card_count != pending.source_card_count
            || inspection.summary.review_count != pending.source_review_count
        {
            return Err(AppError::Validation(
                "legacy learning source changed after preview".into(),
            ));
        }
        let target_path = self.target_database_path()?;
        if self
            .ensure_repository()?
            .legacy_migration_matches(pending.edition.key(), &pending.source_fingerprint)?
        {
            return Ok(LegacyLearningMigrationResult {
                schema_version: 1,
                status: "already_migrated",
                edition: pending.edition,
                imported_card_count: pending.source_card_count,
                imported_review_count: pending.source_review_count,
                backup_file_name: None,
                source_directory_preserved: true,
                destination_verified: true,
            });
        }
        if database_fingerprint(&target_path)? != pending.target_fingerprint {
            return Err(AppError::Validation(
                "current learning data changed after migration preview".into(),
            ));
        }

        let staging_path = target_path.with_file_name(format!(
            ".legacy-learning-staging-{}.sqlite3",
            uuid::Uuid::new_v4()
        ));
        let source_export = snapshot_source_export(
            &pending.source_path,
            &staging_path,
            &pending.source_fingerprint,
            now_unix_ms,
        );
        let source_export = match source_export {
            Ok(value) => value,
            Err(error) => {
                remove_database_files(&staging_path);
                return Err(error);
            }
        };
        let export_preview = source_export.preview();
        if export_preview.card_count != pending.source_card_count {
            remove_database_files(&staging_path);
            return Err(AppError::Validation(
                "legacy learning snapshot did not match its preview".into(),
            ));
        }

        let backup_directory = target_path
            .parent()
            .ok_or_else(|| AppError::Validation("learning database path is invalid".into()))?
            .join("backups");
        let backup_file_name = format!(
            "legacy-before-{}-{}-{}.sqlite3",
            pending.edition.key(),
            now_unix_ms,
            &uuid::Uuid::new_v4().to_string()[..8]
        );
        let backup_path = backup_directory.join(&backup_file_name);
        self.ensure_repository()?.backup_to(&backup_path)?;
        self.pending_imports.clear();
        self.pending_invitation = None;
        let restore_result = self
            .ensure_repository()?
            .restore_native_export_with_legacy_receipt(
                &source_export,
                now_unix_ms,
                pending.edition.key(),
                &pending.source_fingerprint,
                pending.source_review_count,
            );
        remove_database_files(&staging_path);
        restore_result?;

        self.repository.take();
        let reopened = LearningRepository::open(&target_path).and_then(|repository| {
            let summary = repository.data_summary()?;
            if summary.card_count != pending.source_card_count
                || summary.review_count != pending.source_review_count
                || !repository
                    .legacy_migration_matches(pending.edition.key(), &pending.source_fingerprint)?
            {
                return Err(AppError::Validation(
                    "legacy learning migration verification failed".into(),
                ));
            }
            Ok(repository)
        });
        match reopened {
            Ok(repository) => {
                self.repository = Some(repository);
                self.initialization_failed = false;
            }
            Err(error) => {
                let rollback = restore_backup(&target_path, &backup_path)
                    .and_then(|_| LearningRepository::open(&target_path));
                match rollback {
                    Ok(repository) => {
                        self.repository = Some(repository);
                        self.initialization_failed = false;
                        return Err(error);
                    }
                    Err(rollback_error) => {
                        self.initialization_failed = true;
                        return Err(AppError::Validation(format!(
                            "legacy learning migration failed ({error}); rollback failed ({rollback_error})"
                        )));
                    }
                }
            }
        }

        Ok(LegacyLearningMigrationResult {
            schema_version: 1,
            status: "migrated",
            edition: pending.edition,
            imported_card_count: pending.source_card_count,
            imported_review_count: pending.source_review_count,
            backup_file_name: Some(backup_file_name),
            source_directory_preserved: true,
            destination_verified: true,
        })
    }

    fn target_database_path(&self) -> AppResult<PathBuf> {
        self.database_path
            .clone()
            .ok_or_else(|| AppError::Validation("learning database path is unavailable".into()))
    }
}

fn legacy_database_path(
    target_database_path: &Path,
    edition: LegacyLearningEdition,
) -> AppResult<PathBuf> {
    let application_root = target_database_path
        .parent()
        .and_then(Path::parent)
        .ok_or_else(|| AppError::Validation("learning database path is invalid".into()))?;
    let local_data_root = application_root
        .parent()
        .ok_or_else(|| AppError::Validation("application data root is invalid".into()))?;
    Ok(local_data_root
        .join(edition.identifier())
        .join("learning-data")
        .join(LEARNING_DATABASE_FILE_NAME))
}

fn inspect_source(path: &Path, edition: LegacyLearningEdition) -> AppResult<SourceInspection> {
    if !path.is_file() {
        return Ok(SourceInspection {
            summary: LegacyLearningSourceSummary {
                schema_version: 1,
                edition,
                status: "missing",
                source_schema_version: None,
                card_count: 0,
                review_count: 0,
                failure_reason: None,
            },
            path: path.to_path_buf(),
            fingerprint: None,
        });
    }
    let inspected = (|| -> AppResult<(u32, u32, u32, String)> {
        let connection = Connection::open_with_flags(
            path,
            OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX,
        )?;
        connection.busy_timeout(Duration::from_secs(2))?;
        let integrity: String = connection.query_row("PRAGMA quick_check", [], |row| row.get(0))?;
        if integrity != "ok" {
            return Err(AppError::Validation(
                "legacy learning database integrity check failed".into(),
            ));
        }
        let schema_version: u32 =
            connection.query_row("PRAGMA user_version", [], |row| row.get(0))?;
        if !(1..=CURRENT_SCHEMA_VERSION).contains(&schema_version) {
            return Err(AppError::Validation(
                "legacy learning database schema is unsupported".into(),
            ));
        }
        for table in ["learning_cards", "review_logs", "content_packs"] {
            let exists: bool = connection.query_row(
                "SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?1)",
                [table],
                |row| row.get(0),
            )?;
            if !exists {
                return Err(AppError::Validation(
                    "legacy learning database is incomplete".into(),
                ));
            }
        }
        let card_count =
            connection.query_row("SELECT COUNT(*) FROM learning_cards", [], |row| row.get(0))?;
        let review_count =
            connection.query_row("SELECT COUNT(*) FROM review_logs", [], |row| row.get(0))?;
        let fingerprint = database_fingerprint(path)?;
        Ok((schema_version, card_count, review_count, fingerprint))
    })();
    match inspected {
        Ok((schema_version, card_count, review_count, fingerprint)) => Ok(SourceInspection {
            summary: LegacyLearningSourceSummary {
                schema_version: 1,
                edition,
                status: "available",
                source_schema_version: Some(schema_version),
                card_count,
                review_count,
                failure_reason: None,
            },
            path: path.to_path_buf(),
            fingerprint: Some(fingerprint),
        }),
        Err(_) => Ok(SourceInspection {
            summary: LegacyLearningSourceSummary {
                schema_version: 1,
                edition,
                status: "invalid",
                source_schema_version: None,
                card_count: 0,
                review_count: 0,
                failure_reason: Some("database"),
            },
            path: path.to_path_buf(),
            fingerprint: None,
        }),
    }
}

fn database_fingerprint(path: &Path) -> AppResult<String> {
    let mut hasher = Sha256::new();
    for suffix in ["", "-wal"] {
        let candidate = if suffix.is_empty() {
            path.to_path_buf()
        } else {
            let mut value = path.as_os_str().to_os_string();
            value.push(suffix);
            PathBuf::from(value)
        };
        hasher.update(suffix.as_bytes());
        if candidate.is_file() {
            let metadata = fs::metadata(&candidate)?;
            hasher.update(metadata.len().to_le_bytes());
            let mut file = File::open(&candidate)?;
            let mut buffer = [0_u8; 64 * 1024];
            loop {
                let read = file.read(&mut buffer)?;
                if read == 0 {
                    break;
                }
                hasher.update(&buffer[..read]);
            }
        } else {
            hasher.update(0_u64.to_le_bytes());
        }
    }
    Ok(format!("{:x}", hasher.finalize()))
}

fn snapshot_source_export(
    source_path: &Path,
    staging_path: &Path,
    expected_fingerprint: &str,
    now_unix_ms: i64,
) -> AppResult<portability::NativeLearningExport> {
    remove_database_files(staging_path);
    let source = Connection::open_with_flags(
        source_path,
        OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX,
    )?;
    source.busy_timeout(Duration::from_secs(2))?;
    source.backup(MAIN_DB, staging_path, None::<fn(Progress)>)?;
    drop(source);
    if database_fingerprint(source_path)? != expected_fingerprint {
        return Err(AppError::Validation(
            "legacy learning source changed during snapshot".into(),
        ));
    }
    let mut snapshot = LearningRepository::open(staging_path)?;
    let payload =
        snapshot.export_payload(portability::LearningExportFormat::NativeJson, now_unix_ms)?;
    portability::parse_native_learning_export(&payload.bytes)
}

fn restore_backup(target_path: &Path, backup_path: &Path) -> AppResult<()> {
    let mut destination = Connection::open(target_path)?;
    destination.restore(MAIN_DB, backup_path, None::<fn(Progress)>)?;
    Ok(())
}

fn remove_database_files(path: &Path) {
    for suffix in ["", "-wal", "-shm"] {
        let candidate = if suffix.is_empty() {
            path.to_path_buf()
        } else {
            let mut value = path.as_os_str().to_os_string();
            value.push(suffix);
            PathBuf::from(value)
        };
        let _ = fs::remove_file(candidate);
    }
}

#[cfg(test)]
mod tests {
    use tempfile::tempdir;

    use super::*;

    fn database_path(root: &Path, identifier: &str) -> PathBuf {
        root.join(identifier)
            .join("learning-data")
            .join(LEARNING_DATABASE_FILE_NAME)
    }

    fn seed_card(path: &Path, headword: &str) {
        let mut runtime = LearningRuntime::initialize(path);
        let preview = runtime
            .preview_csv_import(
                format!("headword,meanings_zh\n{headword},含义\n").as_bytes(),
                1_000,
            )
            .unwrap();
        runtime
            .confirm_import(preview.preview_token.as_deref().unwrap(), 2_000)
            .unwrap();
    }

    #[test]
    fn discovery_is_read_only_and_returns_no_local_path() {
        let root = tempdir().unwrap();
        let source_path = database_path(root.path(), LegacyLearningEdition::Preview.identifier());
        seed_card(&source_path, "legacy");
        let before = database_fingerprint(&source_path).unwrap();
        let target_path = database_path(root.path(), "com.yuanyuan.reminder");
        let mut runtime = LearningRuntime::configured(&target_path);

        let sources = runtime.list_legacy_learning_sources().unwrap();

        assert_eq!(sources[0].status, "available");
        assert_eq!(sources[0].card_count, 1);
        assert_eq!(sources[1].status, "missing");
        assert_eq!(database_fingerprint(&source_path).unwrap(), before);
        let serialized = serde_json::to_string(&sources).unwrap();
        assert!(!serialized.to_ascii_lowercase().contains("appdata"));
        assert!(!serialized.contains("sqlite3"));
    }

    fn assert_confirmed_migration(edition: LegacyLearningEdition) {
        let root = tempdir().unwrap();
        let source_path = database_path(root.path(), edition.identifier());
        seed_card(&source_path, "source-card");
        let source_before = database_fingerprint(&source_path).unwrap();
        let target_path = database_path(root.path(), "com.yuanyuan.reminder");
        seed_card(&target_path, "destination-card");
        let mut runtime = LearningRuntime::configured(&target_path);
        let preview = runtime
            .preview_legacy_learning_migration(edition, 10_000)
            .unwrap();
        assert!(preview.replaces_destination);
        assert!(preview.backup_required);
        assert!(preview.source_directory_preserved);

        let result = runtime
            .confirm_legacy_learning_migration(preview.preview_token.as_deref().unwrap(), 11_000)
            .unwrap();

        assert_eq!(result.status, "migrated");
        assert_eq!(result.imported_card_count, 1);
        assert!(result.destination_verified);
        assert!(result.source_directory_preserved);
        assert!(target_path
            .parent()
            .unwrap()
            .join("backups")
            .join(result.backup_file_name.as_deref().unwrap())
            .is_file());
        assert_eq!(database_fingerprint(&source_path).unwrap(), source_before);
        assert_eq!(runtime.data_summary().unwrap().card_count, 1);
        let repeated = runtime
            .preview_legacy_learning_migration(edition, 12_000)
            .unwrap();
        assert_eq!(repeated.status, "already_migrated");
        assert!(repeated.preview_token.is_none());
    }

    #[test]
    fn unified_migration_matrix_preview_is_explicit_verified_and_source_preserving() {
        assert_confirmed_migration(LegacyLearningEdition::Preview);
    }

    #[test]
    fn unified_migration_matrix_personal_is_explicit_verified_and_source_preserving() {
        assert_confirmed_migration(LegacyLearningEdition::Personal);
    }

    #[test]
    fn source_change_after_preview_fails_without_replacing_destination() {
        let root = tempdir().unwrap();
        let source_path = database_path(root.path(), LegacyLearningEdition::Preview.identifier());
        seed_card(&source_path, "source-card");
        let target_path = database_path(root.path(), "com.yuanyuan.reminder");
        seed_card(&target_path, "destination-card");
        let mut runtime = LearningRuntime::configured(&target_path);
        let preview = runtime
            .preview_legacy_learning_migration(LegacyLearningEdition::Preview, 10_000)
            .unwrap();
        seed_card(&source_path, "changed-source");

        assert!(runtime
            .confirm_legacy_learning_migration(preview.preview_token.as_deref().unwrap(), 11_000,)
            .is_err());
        assert_eq!(runtime.data_summary().unwrap().card_count, 1);
    }

    #[test]
    fn invalid_source_is_reported_without_blocking_the_target_learning_database() {
        let root = tempdir().unwrap();
        let source_path = database_path(root.path(), LegacyLearningEdition::Preview.identifier());
        fs::create_dir_all(source_path.parent().unwrap()).unwrap();
        fs::write(&source_path, b"not sqlite").unwrap();
        let target_path = database_path(root.path(), "com.yuanyuan.reminder");
        let mut runtime = LearningRuntime::configured(&target_path);

        let sources = runtime.list_legacy_learning_sources().unwrap();

        assert_eq!(sources[0].status, "invalid");
        assert!(runtime.home(1_000).unwrap().capabilities.available);
    }
}
