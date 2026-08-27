use std::{
    fs,
    path::{Path, PathBuf},
};

use chrono::{Duration, Local, Utc};
use serde::Serialize;

use crate::{
    error::{AppError, AppResult},
    models::CreateReminderInput,
    repository::Repository,
};

const PRODUCT_IDENTIFIER: &str = "com.yuanyuan.reminder";
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
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Inspection {
    pub database_healthy: bool,
    pub records: Vec<ReminderInspection>,
}

fn expected_data_root() -> AppResult<PathBuf> {
    let local = dirs::data_local_dir()
        .ok_or_else(|| AppError::Validation("local app data directory is unavailable".into()))?;
    Ok(local.join(PRODUCT_IDENTIFIER))
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
    let repository = Repository::open(&root.join("yuanyuan-reminder.sqlite3"))?;
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
    let repository = Repository::open(&root.join("yuanyuan-reminder.sqlite3"))?;
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

pub fn inspect(root: &Path, reminder_ids: &[String]) -> AppResult<Inspection> {
    let root = require_owned_root(root)?;
    let repository = Repository::open(&root.join("yuanyuan-reminder.sqlite3"))?;
    let snapshot = repository.list_today(false)?;
    let mut records = Vec::with_capacity(reminder_ids.len());
    for reminder_id in reminder_ids {
        let present = snapshot
            .reminders
            .iter()
            .any(|reminder| reminder.id == *reminder_id);
        let occurrence_status = repository
            .runtime_qa_reminder_claim(reminder_id)?
            .map(|(_, _, status)| status);
        records.push(ReminderInspection {
            reminder_id: reminder_id.clone(),
            present,
            occurrence_status,
        });
    }
    Ok(Inspection {
        database_healthy: true,
        records,
    })
}
