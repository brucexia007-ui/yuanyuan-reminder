use std::{
    ffi::OsStr,
    fs,
    path::{Path, PathBuf},
    time::SystemTime,
};

use chrono::{DateTime, Local, Utc};
#[cfg(any(not(feature = "learning"), test))]
use rusqlite::{backup::Progress, Connection, MAIN_DB};
use uuid::Uuid;

use crate::{
    error::{AppError, AppResult},
    models::BackupInfo,
    repository::Repository,
};

#[cfg(feature = "learning")]
use crate::learning::LearningRuntime;

const AUTOMATIC_BACKUP_LIMIT: usize = 14;
const BACKUP_EXTENSION: &str = "sqlite3";
const LEARNING_BACKUP_SUFFIX: &str = ".learning.sqlite3";

#[cfg(any(not(feature = "learning"), test))]
pub fn create_startup_backup(database_path: &Path, backup_dir: &Path) -> AppResult<()> {
    if !database_path.is_file() {
        return Ok(());
    }
    fs::create_dir_all(backup_dir)?;
    let file_name = format!("auto-{}.sqlite3", Local::now().format("%Y-%m-%d"));
    let destination = backup_dir.join(file_name);
    if !destination.exists() {
        let source = Connection::open(database_path)?;
        if let Err(error) = source.backup(MAIN_DB, &destination, None::<fn(Progress)>) {
            let _ = fs::remove_file(&destination);
            return Err(error.into());
        }
    }
    prune_automatic_backups(backup_dir, AUTOMATIC_BACKUP_LIMIT)
}

#[cfg(any(not(feature = "learning"), test))]
pub fn create_manual_backup(repository: &Repository, backup_dir: &Path) -> AppResult<BackupInfo> {
    let file_name = format!(
        "manual-{}-{}.sqlite3",
        Local::now().format("%Y-%m-%d-%H%M%S"),
        &Uuid::new_v4().to_string()[..8]
    );
    create_named_backup(repository, backup_dir, &file_name)?;
    backup_info(&backup_dir.join(file_name))
}

#[cfg(feature = "learning")]
pub fn create_unified_startup_backup(
    repository: &Repository,
    learning: &LearningRuntime,
    backup_dir: &Path,
) -> AppResult<()> {
    fs::create_dir_all(backup_dir)?;
    let file_name = format!("auto-{}.sqlite3", Local::now().format("%Y-%m-%d"));
    let destination = backup_dir.join(&file_name);
    if !destination.exists() {
        create_named_backup(repository, backup_dir, &file_name)?;
        let learning_path = learning_backup_path(&destination)?;
        if let Err(error) = learning.backup_to_if_present(&learning_path) {
            let _ = fs::remove_file(&learning_path);
            prune_automatic_backups(backup_dir, AUTOMATIC_BACKUP_LIMIT)?;
            return Err(error);
        }
    }
    prune_automatic_backups(backup_dir, AUTOMATIC_BACKUP_LIMIT)
}

#[cfg(feature = "learning")]
pub fn create_unified_manual_backup(
    repository: &Repository,
    learning: &LearningRuntime,
    backup_dir: &Path,
) -> AppResult<BackupInfo> {
    let file_name = format!(
        "manual-{}-{}.sqlite3",
        Local::now().format("%Y-%m-%d-%H%M%S"),
        &Uuid::new_v4().to_string()[..8]
    );
    create_named_unified_backup(repository, learning, backup_dir, &file_name)?;
    backup_info(&backup_dir.join(file_name))
}

pub fn list_backups(backup_dir: &Path) -> AppResult<Vec<BackupInfo>> {
    if !backup_dir.exists() {
        return Ok(Vec::new());
    }
    let mut backups = fs::read_dir(backup_dir)?
        .filter_map(Result::ok)
        .map(|entry| entry.path())
        .filter(|path| is_visible_backup(path))
        .map(|path| backup_info(&path))
        .collect::<AppResult<Vec<_>>>()?;
    backups.sort_by(|left, right| right.created_at.cmp(&left.created_at));
    Ok(backups)
}

#[cfg(any(not(feature = "learning"), test))]
pub fn restore_backup(
    repository: &mut Repository,
    backup_dir: &Path,
    file_name: &str,
) -> AppResult<()> {
    let source = resolve_backup_path(backup_dir, file_name)?;
    Repository::validate_database_file(&source)?;

    let safety_name = format!(
        "manual-before-restore-{}-{}.sqlite3",
        Local::now().format("%Y-%m-%d-%H%M%S"),
        &Uuid::new_v4().to_string()[..8]
    );
    let safety_path = backup_dir.join(&safety_name);
    create_named_backup(repository, backup_dir, &safety_name)?;

    if let Err(error) = repository.restore_from(&source) {
        if let Err(rollback_error) = repository.restore_from(&safety_path) {
            return Err(AppError::Validation(format!(
                "restore failed ({error}); safety rollback also failed ({rollback_error})"
            )));
        }
        return Err(error);
    }
    Ok(())
}

#[cfg(feature = "learning")]
pub fn restore_unified_backup(
    repository: &mut Repository,
    learning: &mut LearningRuntime,
    backup_dir: &Path,
    file_name: &str,
) -> AppResult<()> {
    let source = resolve_backup_path(backup_dir, file_name)?;
    Repository::validate_database_file(&source)?;
    let learning_source = learning_backup_path(&source)?;
    let restores_learning = learning_source.is_file();
    if restores_learning {
        LearningRuntime::validate_backup_file(&learning_source)?;
    }

    let safety_name = format!(
        "manual-before-restore-{}-{}.sqlite3",
        Local::now().format("%Y-%m-%d-%H%M%S"),
        &Uuid::new_v4().to_string()[..8]
    );
    let safety_path = backup_dir.join(&safety_name);
    if restores_learning {
        create_named_unified_backup(repository, learning, backup_dir, &safety_name)?;
    } else {
        create_named_backup(repository, backup_dir, &safety_name)?;
    }
    let learning_safety_path = learning_backup_path(&safety_path)?;
    let learning_existed_before_restore = learning_safety_path.is_file();

    if let Err(error) = repository.restore_from(&source) {
        if let Err(rollback_error) = repository.restore_from(&safety_path) {
            return Err(AppError::Validation(format!(
                "restore failed ({error}); reminder safety rollback also failed ({rollback_error})"
            )));
        }
        return Err(error);
    }

    if restores_learning {
        if let Err(error) = learning.restore_from_backup(&learning_source) {
            let reminder_rollback = repository.restore_from(&safety_path);
            let learning_rollback = if learning_existed_before_restore {
                learning.restore_from_backup(&learning_safety_path)
            } else {
                learning.rollback_restore_to_absent_database()
            };
            if let Err(rollback_error) = reminder_rollback {
                return Err(AppError::Validation(format!(
                    "learning restore failed ({error}); reminder safety rollback also failed ({rollback_error})"
                )));
            }
            if let Err(rollback_error) = learning_rollback {
                return Err(AppError::Validation(format!(
                    "learning restore failed ({error}); learning safety rollback also failed ({rollback_error})"
                )));
            }
            return Err(error);
        }
    }
    Ok(())
}

fn create_named_backup(
    repository: &Repository,
    backup_dir: &Path,
    file_name: &str,
) -> AppResult<()> {
    fs::create_dir_all(backup_dir)?;
    let destination = backup_dir.join(file_name);
    if let Err(error) = repository.backup_to(&destination) {
        let _ = fs::remove_file(&destination);
        return Err(error);
    }
    Repository::validate_database_file(&destination)
}

#[cfg(feature = "learning")]
fn create_named_unified_backup(
    repository: &Repository,
    learning: &LearningRuntime,
    backup_dir: &Path,
    file_name: &str,
) -> AppResult<()> {
    create_named_backup(repository, backup_dir, file_name)?;
    let reminder_path = backup_dir.join(file_name);
    let learning_path = learning_backup_path(&reminder_path)?;
    match learning.backup_to_if_present(&learning_path) {
        Ok(_) => Ok(()),
        Err(error) => {
            let _ = fs::remove_file(&reminder_path);
            let _ = fs::remove_file(&learning_path);
            Err(error)
        }
    }
}

fn resolve_backup_path(backup_dir: &Path, file_name: &str) -> AppResult<PathBuf> {
    let requested = Path::new(file_name);
    if requested.file_name() != Some(OsStr::new(file_name))
        || requested.extension() != Some(OsStr::new(BACKUP_EXTENSION))
        || file_name.ends_with(LEARNING_BACKUP_SUFFIX)
        || !(file_name.starts_with("auto-") || file_name.starts_with("manual-"))
    {
        return Err(AppError::Validation("invalid backup file name".into()));
    }
    let path = backup_dir.join(requested);
    if !path.is_file() {
        return Err(AppError::Validation("backup file does not exist".into()));
    }
    Ok(path)
}

fn backup_info(path: &Path) -> AppResult<BackupInfo> {
    let metadata = fs::metadata(path)?;
    let modified = metadata.modified().unwrap_or(SystemTime::UNIX_EPOCH);
    let created_at = DateTime::<Utc>::from(modified).to_rfc3339();
    let file_name = path
        .file_name()
        .and_then(OsStr::to_str)
        .ok_or_else(|| AppError::Validation("backup file name is not valid UTF-8".into()))?
        .to_string();
    let learning_path = learning_backup_path(path)?;
    let learning_size = if learning_path.is_file() {
        fs::metadata(&learning_path)?.len()
    } else {
        0
    };
    Ok(BackupInfo {
        automatic: file_name.starts_with("auto-"),
        file_name,
        created_at,
        size_bytes: metadata.len().saturating_add(learning_size),
        learning_included: learning_size > 0,
    })
}

fn learning_backup_path(reminder_path: &Path) -> AppResult<PathBuf> {
    let file_name = reminder_path
        .file_name()
        .and_then(OsStr::to_str)
        .ok_or_else(|| AppError::Validation("backup file name is not valid UTF-8".into()))?;
    let stem = file_name
        .strip_suffix(".sqlite3")
        .ok_or_else(|| AppError::Validation("backup file extension is invalid".into()))?;
    Ok(reminder_path.with_file_name(format!("{stem}{LEARNING_BACKUP_SUFFIX}")))
}

fn is_visible_backup(path: &Path) -> bool {
    path.is_file()
        && path.extension() == Some(OsStr::new(BACKUP_EXTENSION))
        && path
            .file_name()
            .and_then(OsStr::to_str)
            .is_some_and(|name| {
                !name.ends_with(LEARNING_BACKUP_SUFFIX)
                    && (name.starts_with("auto-") || name.starts_with("manual-"))
            })
}

fn prune_automatic_backups(backup_dir: &Path, keep: usize) -> AppResult<()> {
    let mut automatic = fs::read_dir(backup_dir)?
        .filter_map(Result::ok)
        .map(|entry| entry.path())
        .filter(|path| {
            path.file_name()
                .and_then(OsStr::to_str)
                .is_some_and(|name| {
                    name.starts_with("auto-")
                        && name.ends_with(".sqlite3")
                        && !name.ends_with(LEARNING_BACKUP_SUFFIX)
                })
        })
        .collect::<Vec<_>>();
    automatic.sort_by(|left, right| right.file_name().cmp(&left.file_name()));
    for path in automatic.into_iter().skip(keep) {
        let learning_path = learning_backup_path(&path)?;
        fs::remove_file(path)?;
        if learning_path.is_file() {
            fs::remove_file(learning_path)?;
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[cfg(feature = "learning")]
    use crate::learning::LearningRuntime;
    use crate::models::CreateReminderInput;

    fn temp_area(label: &str) -> PathBuf {
        std::env::temp_dir().join(format!("yuanyuan-{label}-{}", Uuid::new_v4()))
    }

    #[cfg(feature = "learning")]
    fn seed_learning(runtime: &mut LearningRuntime, headword: &str, now_unix_ms: i64) {
        let preview = runtime
            .preview_csv_import(
                format!("headword,meanings_zh\n{headword},含义\n").as_bytes(),
                now_unix_ms,
            )
            .unwrap();
        runtime
            .confirm_import(preview.preview_token.as_deref().unwrap(), now_unix_ms + 1)
            .unwrap();
    }

    #[cfg(feature = "learning")]
    fn create_test_reminder(repository: &Repository, title: &str) -> String {
        repository
            .create_reminder(CreateReminderInput {
                title: title.into(),
                category: "work".into(),
                schedule_kind: "once".into(),
                at_local: Some("2035-01-01T09:00".into()),
                every_minutes: None,
                active_start_local: None,
                active_end_local: None,
                weekdays: None,
            })
            .unwrap()
            .id
    }

    #[cfg(feature = "learning")]
    #[test]
    fn unified_backup_restores_both_databases_as_one_visible_item() {
        let root = temp_area("unified-backup-restore");
        let backup_dir = root.join("backups");
        let mut repository = Repository::open(&root.join("current.sqlite3")).unwrap();
        let reminder_id = create_test_reminder(&repository, "backup sentinel");
        let learning_path = root.join("learning-data").join("current.sqlite3");
        let mut learning = LearningRuntime::configured(&learning_path);
        seed_learning(&mut learning, "first-card", 1_000);

        let backup = create_unified_manual_backup(&repository, &learning, &backup_dir).unwrap();
        assert!(backup.learning_included);
        assert_eq!(list_backups(&backup_dir).unwrap().len(), 1);
        assert!(learning_backup_path(&backup_dir.join(&backup.file_name))
            .unwrap()
            .is_file());

        repository.archive_reminder(&reminder_id).unwrap();
        seed_learning(&mut learning, "second-card", 2_000);
        restore_unified_backup(
            &mut repository,
            &mut learning,
            &backup_dir,
            &backup.file_name,
        )
        .unwrap();

        assert!(repository
            .get_reminder(&reminder_id)
            .unwrap()
            .is_some_and(|reminder| reminder.archived_at.is_none()));
        assert_eq!(learning.data_summary().unwrap().card_count, 1);

        drop(learning);
        drop(repository);
        let _ = fs::remove_dir_all(root);
    }

    #[cfg(feature = "learning")]
    #[test]
    fn legacy_reminder_only_backup_preserves_current_learning_data() {
        let root = temp_area("legacy-backup-restore");
        let backup_dir = root.join("backups");
        let mut repository = Repository::open(&root.join("current.sqlite3")).unwrap();
        let reminder_id = create_test_reminder(&repository, "legacy backup sentinel");
        let backup = create_manual_backup(&repository, &backup_dir).unwrap();
        assert!(!backup.learning_included);
        let learning_path = root.join("learning-data").join("current.sqlite3");
        let mut learning = LearningRuntime::configured(&learning_path);
        seed_learning(&mut learning, "preserved-card", 1_000);
        repository.archive_reminder(&reminder_id).unwrap();

        restore_unified_backup(
            &mut repository,
            &mut learning,
            &backup_dir,
            &backup.file_name,
        )
        .unwrap();

        assert!(repository
            .get_reminder(&reminder_id)
            .unwrap()
            .is_some_and(|reminder| reminder.archived_at.is_none()));
        assert_eq!(learning.data_summary().unwrap().card_count, 1);

        drop(learning);
        drop(repository);
        let _ = fs::remove_dir_all(root);
    }

    #[cfg(feature = "learning")]
    #[test]
    fn unavailable_learning_does_not_block_reminder_only_restore() {
        let root = temp_area("isolated-reminder-restore");
        let backup_dir = root.join("backups");
        let mut repository = Repository::open(&root.join("current.sqlite3")).unwrap();
        let reminder_id = create_test_reminder(&repository, "isolated restore sentinel");
        let backup = create_manual_backup(&repository, &backup_dir).unwrap();
        repository.archive_reminder(&reminder_id).unwrap();
        let learning_path = root.join("learning-data").join("current.sqlite3");
        fs::create_dir_all(learning_path.parent().unwrap()).unwrap();
        fs::write(&learning_path, b"unavailable learning database").unwrap();
        let learning_before = fs::read(&learning_path).unwrap();
        let mut learning = LearningRuntime::configured(&learning_path);

        restore_unified_backup(
            &mut repository,
            &mut learning,
            &backup_dir,
            &backup.file_name,
        )
        .unwrap();

        assert!(repository
            .get_reminder(&reminder_id)
            .unwrap()
            .is_some_and(|reminder| reminder.archived_at.is_none()));
        assert_eq!(fs::read(&learning_path).unwrap(), learning_before);

        drop(learning);
        drop(repository);
        let _ = fs::remove_dir_all(root);
    }

    #[cfg(feature = "learning")]
    #[test]
    fn unavailable_learning_keeps_the_independent_startup_reminder_backup() {
        let root = temp_area("isolated-startup-backup");
        let backup_dir = root.join("backups");
        let repository = Repository::open(&root.join("current.sqlite3")).unwrap();
        let learning_path = root.join("learning-data").join("current.sqlite3");
        fs::create_dir_all(learning_path.parent().unwrap()).unwrap();
        fs::write(&learning_path, b"unavailable learning database").unwrap();
        let learning = LearningRuntime::configured(&learning_path);

        assert!(create_unified_startup_backup(&repository, &learning, &backup_dir).is_err());
        let backups = list_backups(&backup_dir).unwrap();
        assert_eq!(backups.len(), 1);
        assert!(backups[0].automatic);
        assert!(!backups[0].learning_included);

        drop(learning);
        drop(repository);
        let _ = fs::remove_dir_all(root);
    }

    #[cfg(feature = "learning")]
    #[test]
    fn unified_backup_does_not_create_an_unused_learning_database() {
        let root = temp_area("lazy-unified-backup");
        let backup_dir = root.join("backups");
        let repository = Repository::open(&root.join("current.sqlite3")).unwrap();
        let learning_path = root.join("learning-data").join("current.sqlite3");
        let learning = LearningRuntime::configured(&learning_path);

        let backup = create_unified_manual_backup(&repository, &learning, &backup_dir).unwrap();

        assert!(!backup.learning_included);
        assert!(!learning_path.exists());
        drop(learning);
        drop(repository);
        let _ = fs::remove_dir_all(root);
    }

    #[cfg(feature = "learning")]
    #[test]
    fn corrupt_learning_companion_is_rejected_before_reminders_change() {
        let root = temp_area("corrupt-learning-backup");
        let backup_dir = root.join("backups");
        let mut repository = Repository::open(&root.join("current.sqlite3")).unwrap();
        let reminder_id = create_test_reminder(&repository, "stay archived");
        let learning_path = root.join("learning-data").join("current.sqlite3");
        let mut learning = LearningRuntime::configured(&learning_path);
        seed_learning(&mut learning, "card", 1_000);
        let backup = create_unified_manual_backup(&repository, &learning, &backup_dir).unwrap();
        repository.archive_reminder(&reminder_id).unwrap();
        let companion = learning_backup_path(&backup_dir.join(&backup.file_name)).unwrap();
        fs::write(companion, b"not sqlite").unwrap();

        assert!(restore_unified_backup(
            &mut repository,
            &mut learning,
            &backup_dir,
            &backup.file_name,
        )
        .is_err());
        assert!(repository
            .get_reminder(&reminder_id)
            .unwrap()
            .is_some_and(|reminder| reminder.archived_at.is_some()));

        drop(learning);
        drop(repository);
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn manual_backup_can_restore_data_and_rejects_traversal() {
        let root = temp_area("backup-restore");
        let database = root.join("current.sqlite3");
        let backup_dir = root.join("backups");
        let mut repository = Repository::open(&database).unwrap();
        let original = repository
            .create_reminder(CreateReminderInput {
                title: "Original".into(),
                category: "work".into(),
                schedule_kind: "daily".into(),
                at_local: Some("2030-01-01T10:00".into()),
                every_minutes: None,
                active_start_local: None,
                active_end_local: None,
                weekdays: Some(vec![1, 2, 3, 4, 5]),
            })
            .unwrap();
        let backup = create_manual_backup(&repository, &backup_dir).unwrap();
        repository.archive_reminder(&original.id).unwrap();

        restore_backup(&mut repository, &backup_dir, &backup.file_name).unwrap();
        assert!(repository
            .get_reminder(&original.id)
            .unwrap()
            .is_some_and(|reminder| reminder.archived_at.is_none()));
        assert!(restore_backup(&mut repository, &backup_dir, "../current.sqlite3").is_err());

        drop(repository);
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn startup_backup_is_created_only_once_per_day() {
        let root = temp_area("startup-backup");
        let database = root.join("current.sqlite3");
        let backup_dir = root.join("backups");
        let repository = Repository::open(&database).unwrap();
        drop(repository);

        create_startup_backup(&database, &backup_dir).unwrap();
        create_startup_backup(&database, &backup_dir).unwrap();
        let backups = list_backups(&backup_dir).unwrap();
        assert_eq!(backups.iter().filter(|item| item.automatic).count(), 1);

        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn corrupted_backup_is_rejected_without_changing_current_data() {
        let root = temp_area("corrupt-backup");
        let database = root.join("current.sqlite3");
        let backup_dir = root.join("backups");
        fs::create_dir_all(&backup_dir).unwrap();
        let mut repository = Repository::open(&database).unwrap();
        let before = repository.list_today(false).unwrap().reminders.len();
        let corrupt = backup_dir.join("manual-corrupt.sqlite3");
        fs::write(&corrupt, b"not a sqlite database").unwrap();

        assert!(restore_backup(&mut repository, &backup_dir, "manual-corrupt.sqlite3").is_err());
        assert_eq!(
            repository.list_today(false).unwrap().reminders.len(),
            before
        );

        drop(repository);
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn migration_failure_restores_the_safety_snapshot_on_the_same_connection() {
        let root = temp_area("migration-failure-rollback");
        let database = root.join("current.sqlite3");
        let backup_dir = root.join("backups");
        fs::create_dir_all(&backup_dir).unwrap();
        let mut repository = Repository::open(&database).unwrap();
        let sentinel = repository
            .create_reminder(CreateReminderInput {
                title: "survives failed restore".into(),
                category: "work".into(),
                schedule_kind: "once".into(),
                at_local: Some("2035-01-01T09:00".into()),
                every_minutes: None,
                active_start_local: None,
                active_end_local: None,
                weekdays: None,
            })
            .unwrap();

        let failing_name = "manual-valid-but-unmigratable.sqlite3";
        let failing_path = backup_dir.join(failing_name);
        let connection = Connection::open(&failing_path).unwrap();
        for migration in [
            include_str!("../migrations/001_initial.sql"),
            include_str!("../migrations/002_focus_sessions.sql"),
            include_str!("../migrations/003_pet_interactions.sql"),
            include_str!("../migrations/004_ball_interaction.sql"),
            include_str!("../migrations/005_occurrence_history.sql"),
            include_str!("../migrations/006_activity_tracking.sql"),
        ] {
            connection.execute_batch(migration).unwrap();
        }
        connection
            .execute_batch("ALTER TABLE reminders ADD COLUMN archived_at TEXT;")
            .unwrap();
        drop(connection);
        Repository::validate_database_file(&failing_path).unwrap();

        assert!(restore_backup(&mut repository, &backup_dir, failing_name).is_err());
        assert!(repository
            .get_reminder(&sentinel.id)
            .unwrap()
            .is_some_and(|reminder| reminder.title == "survives failed restore"));
        repository.get_settings().unwrap();
        let version: u32 = Connection::open(&database)
            .unwrap()
            .query_row("PRAGMA user_version", [], |row| row.get(0))
            .unwrap();
        assert_eq!(version, if cfg!(feature = "learning") { 12 } else { 11 });

        drop(repository);
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn automatic_backup_retention_keeps_the_latest_fourteen_files() {
        let root = temp_area("backup-retention");
        fs::create_dir_all(&root).unwrap();
        for day in 1..=16 {
            fs::write(root.join(format!("auto-2026-07-{day:02}.sqlite3")), b"test").unwrap();
        }
        fs::write(root.join("auto-2026-07-01.learning.sqlite3"), b"test").unwrap();
        fs::write(root.join("auto-2026-07-16.learning.sqlite3"), b"test").unwrap();
        fs::write(root.join("manual-keep.sqlite3"), b"test").unwrap();

        prune_automatic_backups(&root, AUTOMATIC_BACKUP_LIMIT).unwrap();
        let names = fs::read_dir(&root)
            .unwrap()
            .filter_map(Result::ok)
            .filter_map(|entry| entry.file_name().into_string().ok())
            .collect::<Vec<_>>();
        assert_eq!(
            names
                .iter()
                .filter(|name| {
                    name.starts_with("auto-") && !name.ends_with(LEARNING_BACKUP_SUFFIX)
                })
                .count(),
            14
        );
        assert!(!names.contains(&"auto-2026-07-01.sqlite3".into()));
        assert!(!names.contains(&"auto-2026-07-01.learning.sqlite3".into()));
        assert!(!names.contains(&"auto-2026-07-02.sqlite3".into()));
        assert!(names.contains(&"auto-2026-07-16.learning.sqlite3".into()));
        assert!(names.contains(&"manual-keep.sqlite3".into()));

        let _ = fs::remove_dir_all(root);
    }
}
