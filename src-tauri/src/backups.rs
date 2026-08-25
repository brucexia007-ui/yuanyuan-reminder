use std::{
    ffi::OsStr,
    fs,
    path::{Path, PathBuf},
    time::SystemTime,
};

use chrono::{DateTime, Local, Utc};
use rusqlite::{backup::Progress, Connection, MAIN_DB};
use uuid::Uuid;

use crate::{
    error::{AppError, AppResult},
    models::BackupInfo,
    repository::Repository,
};

const AUTOMATIC_BACKUP_LIMIT: usize = 14;
const BACKUP_EXTENSION: &str = "sqlite3";

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

pub fn create_manual_backup(repository: &Repository, backup_dir: &Path) -> AppResult<BackupInfo> {
    let file_name = format!(
        "manual-{}-{}.sqlite3",
        Local::now().format("%Y-%m-%d-%H%M%S"),
        &Uuid::new_v4().to_string()[..8]
    );
    create_named_backup(repository, backup_dir, &file_name)?;
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

fn resolve_backup_path(backup_dir: &Path, file_name: &str) -> AppResult<PathBuf> {
    let requested = Path::new(file_name);
    if requested.file_name() != Some(OsStr::new(file_name))
        || requested.extension() != Some(OsStr::new(BACKUP_EXTENSION))
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
    Ok(BackupInfo {
        automatic: file_name.starts_with("auto-"),
        file_name,
        created_at,
        size_bytes: metadata.len(),
    })
}

fn is_visible_backup(path: &Path) -> bool {
    path.is_file()
        && path.extension() == Some(OsStr::new(BACKUP_EXTENSION))
        && path
            .file_name()
            .and_then(OsStr::to_str)
            .is_some_and(|name| name.starts_with("auto-") || name.starts_with("manual-"))
}

fn prune_automatic_backups(backup_dir: &Path, keep: usize) -> AppResult<()> {
    let mut automatic = fs::read_dir(backup_dir)?
        .filter_map(Result::ok)
        .map(|entry| entry.path())
        .filter(|path| {
            path.file_name()
                .and_then(OsStr::to_str)
                .is_some_and(|name| name.starts_with("auto-") && name.ends_with(".sqlite3"))
        })
        .collect::<Vec<_>>();
    automatic.sort_by(|left, right| right.file_name().cmp(&left.file_name()));
    for path in automatic.into_iter().skip(keep) {
        fs::remove_file(path)?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::models::CreateReminderInput;

    fn temp_area(label: &str) -> PathBuf {
        std::env::temp_dir().join(format!("yuanyuan-{label}-{}", Uuid::new_v4()))
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
                .filter(|name| name.starts_with("auto-"))
                .count(),
            14
        );
        assert!(!names.contains(&"auto-2026-07-01.sqlite3".into()));
        assert!(!names.contains(&"auto-2026-07-02.sqlite3".into()));
        assert!(names.contains(&"manual-keep.sqlite3".into()));

        let _ = fs::remove_dir_all(root);
    }
}
