use std::{
    fs,
    io::Read,
    path::{Path, PathBuf},
};

use chrono::{Duration, Local, Utc};
use serde::Serialize;
use sha2::{Digest, Sha256};

use crate::{
    backups,
    error::{AppError, AppResult},
    models::CreateReminderInput,
    repository::Repository,
};

const SANDBOX_USER: &str = "WDAGUtilityAccount";
const MARKER_NAME: &str = ".yuanyuan-installed-candidate-qa-v1";
const MARKER_CONTENT: &[u8] = b"YUANYUAN_INSTALLED_CANDIDATE_QA_V1\n";

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SeedPlan {
    pub reminder_id: String,
    pub title: String,
    pub scheduled_at: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MutationPlan {
    pub reminder_id: String,
    pub title: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ReminderInspection {
    pub reminder_id: String,
    pub present: bool,
    pub occurrence_status: Option<String>,
    pub snoozed_until: Option<String>,
    pub resolution_reason: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Inspection {
    pub database_healthy: bool,
    pub records: Vec<ReminderInspection>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AutomaticBackupInspection {
    pub file_name: String,
    pub created_at: String,
    pub size_bytes: u64,
    pub sha256: String,
    pub automatic: bool,
    pub learning_included: bool,
    pub database_healthy: bool,
    pub reminder_id: String,
    pub reminder_present: bool,
}

fn expected_data_root() -> AppResult<PathBuf> {
    let local = dirs::data_local_dir()
        .ok_or_else(|| AppError::Validation("local app data directory is unavailable".into()))?;
    Ok(local.join(crate::brand::storage_directory_name()))
}

fn validate_sandbox() -> AppResult<()> {
    if std::env::var("USERNAME").ok().as_deref() != Some(SANDBOX_USER) {
        return Err(AppError::Validation(
            "installed-candidate QA requires Windows Sandbox".into(),
        ));
    }
    Ok(())
}

fn validate_exact_root(root: &Path) -> AppResult<PathBuf> {
    validate_sandbox()?;
    if !root.is_absolute() || root != expected_data_root()? {
        return Err(AppError::Validation(
            "installed-candidate QA data root is not the exact Sandbox product root".into(),
        ));
    }
    Ok(root.to_path_buf())
}

#[cfg(windows)]
fn is_reparse_point(metadata: &fs::Metadata) -> bool {
    use std::os::windows::fs::MetadataExt;
    metadata.file_attributes() & 0x0000_0400 != 0
}

#[cfg(not(windows))]
fn is_reparse_point(metadata: &fs::Metadata) -> bool {
    metadata.file_type().is_symlink()
}

fn require_owned_root(root: &Path) -> AppResult<PathBuf> {
    let root = validate_exact_root(root)?;
    let metadata = fs::symlink_metadata(&root)
        .map_err(|_| AppError::Validation("installed-candidate QA data root is missing".into()))?;
    if !metadata.is_dir() || is_reparse_point(&metadata) {
        return Err(AppError::Validation(
            "installed-candidate QA data root is unsafe".into(),
        ));
    }
    let marker = root.join(MARKER_NAME);
    let marker_metadata = fs::symlink_metadata(&marker)
        .map_err(|_| AppError::Validation("installed-candidate QA marker is missing".into()))?;
    if !marker_metadata.is_file()
        || is_reparse_point(&marker_metadata)
        || fs::read(&marker)? != MARKER_CONTENT
    {
        return Err(AppError::Validation(
            "installed-candidate QA marker is invalid".into(),
        ));
    }
    Ok(root)
}

pub fn seed(root: &Path, due_after_seconds: u64) -> AppResult<SeedPlan> {
    if !(5..=120).contains(&due_after_seconds) {
        return Err(AppError::Validation(
            "installed-candidate reminder delay must be 5 to 120 seconds".into(),
        ));
    }
    let root = validate_exact_root(root)?;
    if root.exists() {
        return Err(AppError::Validation(
            "installed-candidate QA seed requires a new product data root".into(),
        ));
    }
    fs::create_dir(&root)?;
    fs::write(root.join(MARKER_NAME), MARKER_CONTENT)?;
    let repository = Repository::open(&root.join(crate::brand::main_database_file()))?;
    let now = Utc::now();
    let scheduled = now + Duration::seconds(due_after_seconds as i64);
    let placeholder = (now + Duration::hours(1))
        .with_timezone(&Local)
        .format("%Y-%m-%dT%H:%M")
        .to_string();
    let token = uuid::Uuid::new_v4().simple().to_string();
    let title = format!("E2E提醒-{}", &token[..8]);
    let reminder = repository.create_reminder(CreateReminderInput {
        title: title.clone(),
        category: "work".into(),
        schedule_kind: "once".into(),
        at_local: Some(placeholder),
        every_minutes: None,
        active_start_local: None,
        active_end_local: None,
        weekdays: None,
    })?;
    repository.set_runtime_qa_reminder_due(&reminder.id, scheduled)?;
    Ok(SeedPlan {
        reminder_id: reminder.id,
        title,
        scheduled_at: scheduled.to_rfc3339(),
    })
}

pub fn add_mutation(root: &Path) -> AppResult<MutationPlan> {
    let root = require_owned_root(root)?;
    let repository = Repository::open(&root.join(crate::brand::main_database_file()))?;
    let token = uuid::Uuid::new_v4().simple().to_string();
    let title = format!("E2E变更-{}", &token[..8]);
    let at_local = (Local::now() + Duration::hours(2))
        .format("%Y-%m-%dT%H:%M")
        .to_string();
    let reminder = repository.create_reminder(CreateReminderInput {
        title: title.clone(),
        category: "personal".into(),
        schedule_kind: "once".into(),
        at_local: Some(at_local),
        every_minutes: None,
        active_start_local: None,
        active_end_local: None,
        weekdays: None,
    })?;
    Ok(MutationPlan {
        reminder_id: reminder.id,
        title,
    })
}

pub fn add_overdue_notify(root: &Path, overdue_minutes: u64) -> AppResult<SeedPlan> {
    if !(16..=240).contains(&overdue_minutes) {
        return Err(AppError::Validation(
            "installed-candidate overdue reminder age must be 16 to 240 minutes".into(),
        ));
    }
    let root = require_owned_root(root)?;
    let repository = Repository::open(&root.join(crate::brand::main_database_file()))?;
    let now = Utc::now();
    let scheduled = now - Duration::minutes(overdue_minutes as i64);
    let placeholder = (now + Duration::hours(1))
        .with_timezone(&Local)
        .format("%Y-%m-%dT%H:%M")
        .to_string();
    let token = uuid::Uuid::new_v4().simple().to_string();
    let title = format!("E2E错过仍提醒-{}", &token[..8]);
    let reminder = repository.create_reminder(CreateReminderInput {
        title: title.clone(),
        category: "work".into(),
        schedule_kind: "once".into(),
        at_local: Some(placeholder),
        every_minutes: None,
        active_start_local: None,
        active_end_local: None,
        weekdays: None,
    })?;
    repository.set_runtime_qa_reminder_due(&reminder.id, scheduled)?;
    Ok(SeedPlan {
        reminder_id: reminder.id,
        title,
        scheduled_at: scheduled.to_rfc3339(),
    })
}

pub fn add_missed(root: &Path, overdue_minutes: u64) -> AppResult<SeedPlan> {
    if !(16..=240).contains(&overdue_minutes) {
        return Err(AppError::Validation(
            "installed-candidate missed reminder age must be 16 to 240 minutes".into(),
        ));
    }
    let root = require_owned_root(root)?;
    let repository = Repository::open(&root.join(crate::brand::main_database_file()))?;
    let now = Utc::now();
    let scheduled = now - Duration::minutes(overdue_minutes as i64);
    let placeholder = (now + Duration::hours(1))
        .with_timezone(&Local)
        .format("%Y-%m-%dT%H:%M")
        .to_string();
    let token = uuid::Uuid::new_v4().simple().to_string();
    let title = format!("E2E错过自动跳过-{}", &token[..8]);
    let reminder = repository.create_reminder(CreateReminderInput {
        title: title.clone(),
        category: "work".into(),
        schedule_kind: "once".into(),
        at_local: Some(placeholder),
        every_minutes: None,
        active_start_local: None,
        active_end_local: None,
        weekdays: None,
    })?;
    repository.set_runtime_qa_reminder_due(&reminder.id, scheduled)?;
    Ok(SeedPlan {
        reminder_id: reminder.id,
        title,
        scheduled_at: scheduled.to_rfc3339(),
    })
}

pub fn inspect(root: &Path, reminder_ids: &[String]) -> AppResult<Inspection> {
    let root = require_owned_root(root)?;
    let repository = Repository::open(&root.join(crate::brand::main_database_file()))?;
    let snapshot = repository.list_today(false)?;
    let mut records = Vec::with_capacity(reminder_ids.len());
    for reminder_id in reminder_ids {
        let present = snapshot
            .reminders
            .iter()
            .any(|reminder| reminder.id == *reminder_id);
        let occurrence_state = repository.runtime_qa_reminder_occurrence_state(reminder_id)?;
        let (occurrence_status, snoozed_until, resolution_reason) = occurrence_state
            .map(|(status, snoozed_until, resolution_reason)| {
                (Some(status), snoozed_until, resolution_reason)
            })
            .unwrap_or((None, None, None));
        records.push(ReminderInspection {
            reminder_id: reminder_id.clone(),
            present,
            occurrence_status,
            snoozed_until,
            resolution_reason,
        });
    }
    Ok(Inspection {
        database_healthy: true,
        records,
    })
}

pub fn inspect_automatic_backup(
    root: &Path,
    reminder_id: &str,
) -> AppResult<AutomaticBackupInspection> {
    uuid::Uuid::parse_str(reminder_id)
        .map_err(|_| AppError::Validation("automatic-backup reminder id is invalid".into()))?;
    let root = require_owned_root(root)?;
    let backup_dir = root.join("backups");
    let expected_file_name = format!("auto-{}.sqlite3", Local::now().format("%Y-%m-%d"));
    let backup = backups::list_backups(&backup_dir)?
        .into_iter()
        .find(|item| item.automatic && item.file_name == expected_file_name)
        .ok_or_else(|| {
            AppError::Validation("today's installed automatic backup is missing".into())
        })?;
    let backup_path = backup_dir.join(&backup.file_name);
    Repository::validate_database_file(&backup_path)?;
    let reminder_present =
        Repository::runtime_qa_backup_contains_reminder(&backup_path, reminder_id)?;
    let mut file = fs::File::open(&backup_path)?;
    let mut hasher = Sha256::new();
    let mut buffer = [0_u8; 64 * 1024];
    loop {
        let bytes = file.read(&mut buffer)?;
        if bytes == 0 {
            break;
        }
        hasher.update(&buffer[..bytes]);
    }
    let sha256 = hasher
        .finalize()
        .iter()
        .map(|byte| format!("{byte:02X}"))
        .collect();
    Ok(AutomaticBackupInspection {
        file_name: backup.file_name,
        created_at: backup.created_at,
        size_bytes: backup.size_bytes,
        sha256,
        automatic: backup.automatic,
        learning_included: backup.learning_included,
        database_healthy: true,
        reminder_id: reminder_id.to_string(),
        reminder_present,
    })
}
