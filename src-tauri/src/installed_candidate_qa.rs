use std::{
    fs,
    path::{Path, PathBuf},
};

use chrono::{Duration, Local, Utc};
use rusqlite::{params, Connection, OptionalExtension};
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
const UPGRADE_REMINDER_ID: &str = "00000000-0000-4000-8000-000000001507";
const UPGRADE_OCCURRENCE_ID: &str = "00000000-0000-4000-8000-000000001517";
const UPGRADE_TITLE: &str = "1.5.7升级保留提醒";

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

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UpgradeSeedPlan {
    pub schema_version: u32,
    pub reminder_id: String,
    pub occurrence_id: String,
    pub title: String,
    pub meal_rejected_before_upgrade: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UpgradeInspection {
    pub schema_version: u32,
    pub reminder_preserved: bool,
    pub occurrence_preserved: bool,
    pub foreign_key_violations: i64,
    pub required_indexes_present: bool,
    pub meal_category: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UpgradeRollbackInspection {
    pub schema_version: u32,
    pub reminder_preserved: bool,
    pub occurrence_preserved: bool,
    pub foreign_key_violations: i64,
    pub meal_rejected_after_rollback: bool,
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

/// Read-only evidence for UI-driven pet tests. Never opens or migrates a normal user's database.
pub fn inspect_pet(root: &Path) -> AppResult<serde_json::Value> {
    let root = require_owned_root(root)?;
    let database = root.join("yuanyuan-reminder.sqlite3");
    let metadata = fs::symlink_metadata(&database)?;
    if !metadata.is_file() || is_reparse_point(&metadata) {
        return Err(AppError::Validation("unsafe QA database".into()));
    }
    let connection =
        Connection::open_with_flags(&database, rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY)?;
    connection.busy_timeout(std::time::Duration::from_secs(2))?;
    let settings: String =
        connection.query_row("SELECT data_json FROM settings WHERE id = 1", [], |row| {
            row.get(0)
        })?;
    let settings: serde_json::Value = serde_json::from_str(&settings)?;
    let schema: i64 = connection.query_row("PRAGMA user_version", [], |row| row.get(0))?;
    let integrity: String = connection.query_row("PRAGMA quick_check", [], |row| row.get(0))?;
    let foreign_keys: i64 =
        connection.query_row("SELECT count(*) FROM pragma_foreign_key_check", [], |row| {
            row.get(0)
        })?;
    let mut statement =
        connection.prepare("SELECT id, title, category, enabled FROM reminders ORDER BY id")?;
    let reminders = statement
        .query_map([], |row| {
            Ok(serde_json::json!({
                "id": row.get::<_, String>(0)?, "title": row.get::<_, String>(1)?,
                "category": row.get::<_, String>(2)?, "enabled": row.get::<_, i64>(3)?
            }))
        })?
        .collect::<Result<Vec<_>, _>>()?;
    let mut statement =
        connection.prepare("SELECT id, reminder_id, status FROM occurrences ORDER BY id")?;
    let occurrences = statement
        .query_map([], |row| {
            Ok(serde_json::json!({
                "id": row.get::<_, String>(0)?, "reminderId": row.get::<_, String>(1)?,
                "status": row.get::<_, String>(2)?
            }))
        })?
        .collect::<Result<Vec<_>, _>>()?;
    let care_count: i64 =
        connection.query_row("SELECT count(*) FROM pet_interactions", [], |row| {
            row.get(0)
        })?;
    let mut statement = connection.prepare(
        "SELECT id, phase, status, duration_minutes, started_at, ends_at FROM focus_sessions ORDER BY started_at DESC LIMIT 50"
    )?;
    let focus_sessions = statement
        .query_map([], |row| {
            Ok(serde_json::json!({
                "id": row.get::<_, String>(0)?, "phase": row.get::<_, String>(1)?,
                "status": row.get::<_, String>(2)?, "durationMinutes": row.get::<_, i64>(3)?,
                "startedAt": row.get::<_, String>(4)?, "endsAt": row.get::<_, String>(5)?
            }))
        })?
        .collect::<Result<Vec<_>, _>>()?;
    let mut packs = Vec::new();
    let pack_root = root.join("pet-packs");
    if pack_root.exists() {
        if is_reparse_point(&fs::symlink_metadata(&pack_root)?) {
            return Err(AppError::Validation("unsafe QA pet directory".into()));
        }
        for entry in fs::read_dir(&pack_root)? {
            let entry = entry?;
            let metadata = fs::symlink_metadata(entry.path())?;
            if metadata.is_dir() && !is_reparse_point(&metadata) {
                packs.push(entry.file_name().to_string_lossy().to_string());
            }
        }
        packs.sort();
    }
    let pending = plain_directory_entries(&pack_root.join(".pending"))?;
    let learning = read_pet_learning_evidence(&root)?;
    Ok(serde_json::json!({
        "capturedAt": Utc::now().to_rfc3339(), "schemaVersion": schema,
        "integrity": integrity, "foreignKeyViolations": foreign_keys,
        "petProfile": settings.get("petProfile"), "settings": settings,
        "reminders": reminders, "occurrences": occurrences, "packDirectories": packs,
        "pendingEntries": pending, "careInteractionCount": care_count,
        "focusSessions": focus_sessions, "learning": learning,
        "readOnly": true, "syntheticSandboxDataOnly": true
    }))
}

fn plain_directory_entries(directory: &Path) -> AppResult<Vec<String>> {
    let metadata = match fs::symlink_metadata(directory) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(error) => return Err(error.into()),
    };
    if !metadata.is_dir() || is_reparse_point(&metadata) {
        return Err(AppError::Validation("unsafe QA evidence directory".into()));
    }
    let mut names = Vec::new();
    for entry in fs::read_dir(directory)? {
        let entry = entry?;
        if is_reparse_point(&fs::symlink_metadata(entry.path())?) {
            return Err(AppError::Validation("unsafe QA evidence entry".into()));
        }
        names.push(entry.file_name().to_string_lossy().to_string());
        if names.len() > 1000 {
            return Err(AppError::Validation("too many QA evidence entries".into()));
        }
    }
    names.sort();
    Ok(names)
}

// Called only after the exact Sandbox data root and its ownership marker are checked.
// No LearningRuntime/Repository initialization: absent learning data must remain absent.
fn read_pet_learning_evidence(root: &Path) -> AppResult<serde_json::Value> {
    let directory = root.join("learning-data");
    let metadata = match fs::symlink_metadata(&directory) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            return Ok(serde_json::Value::Null)
        }
        Err(error) => return Err(error.into()),
    };
    if !metadata.is_dir() || is_reparse_point(&metadata) {
        return Err(AppError::Validation("unsafe QA learning directory".into()));
    }
    let path = directory.join("yuanyuan-learning.sqlite3");
    let metadata = match fs::symlink_metadata(&path) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            return Ok(serde_json::Value::Null)
        }
        Err(error) => return Err(error.into()),
    };
    if !metadata.is_file() || is_reparse_point(&metadata) {
        return Err(AppError::Validation("unsafe QA learning database".into()));
    }
    let connection =
        Connection::open_with_flags(&path, rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY)?;
    connection.busy_timeout(std::time::Duration::from_secs(2))?;
    connection.execute_batch("BEGIN")?;
    let cards: i64 =
        connection.query_row("SELECT count(*) FROM learning_cards", [], |row| row.get(0))?;
    let reviews: i64 =
        connection.query_row("SELECT count(*) FROM review_logs", [], |row| row.get(0))?;
    let attempts: i64 = connection.query_row(
        "SELECT count(*) FROM learning_question_attempts",
        [],
        |row| row.get(0),
    )?;
    let mut statement = connection.prepare(
        "SELECT session_id, status, planned_count, completed_count FROM learning_sessions ORDER BY started_at_unix_ms DESC LIMIT 50"
    )?;
    let sessions = statement
        .query_map([], |row| {
            Ok(serde_json::json!({
                "id": row.get::<_, String>(0)?, "status": row.get::<_, String>(1)?,
                "plannedCount": row.get::<_, i64>(2)?, "completedCount": row.get::<_, i64>(3)?
            }))
        })?
        .collect::<Result<Vec<_>, _>>()?;
    Ok(
        serde_json::json!({"cards": cards, "reviews": reviews, "attempts": attempts, "sessions": sessions}),
    )
}

#[cfg(test)]
mod pet_evidence_tests {
    use super::*;

    #[test]
    fn absent_learning_and_pending_directories_are_not_created() {
        let root = tempfile::tempdir().unwrap();
        assert_eq!(
            read_pet_learning_evidence(root.path()).unwrap(),
            serde_json::Value::Null
        );
        assert!(plain_directory_entries(&root.path().join(".pending"))
            .unwrap()
            .is_empty());
        assert_eq!(fs::read_dir(root.path()).unwrap().count(), 0);
    }

    #[test]
    fn learning_counts_are_read_without_initializing_or_migrating_the_database() {
        let root = tempfile::tempdir().unwrap();
        let directory = root.path().join("learning-data");
        fs::create_dir(&directory).unwrap();
        let path = directory.join("yuanyuan-learning.sqlite3");
        let connection = Connection::open(&path).unwrap();
        connection.execute_batch(
            "CREATE TABLE learning_cards(id); INSERT INTO learning_cards VALUES(1),(2),(3);
             CREATE TABLE review_logs(id); INSERT INTO review_logs VALUES(1);
             CREATE TABLE learning_question_attempts(id); INSERT INTO learning_question_attempts VALUES(1);
             CREATE TABLE learning_sessions(session_id, status, planned_count, completed_count, started_at_unix_ms);
             INSERT INTO learning_sessions VALUES('synthetic', 'active', 3, 1, 0);
             PRAGMA user_version=99;"
        ).unwrap();
        drop(connection);
        let before = fs::read(&path).unwrap();
        let result = read_pet_learning_evidence(root.path()).unwrap();
        assert_eq!(result["cards"], 3);
        assert_eq!(result["attempts"], 1);
        assert_eq!(result["sessions"][0]["completedCount"], 1);
        assert_eq!(fs::read(&path).unwrap(), before);
    }
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

pub fn seed_upgrade_v12(root: &Path) -> AppResult<UpgradeSeedPlan> {
    let root = validate_exact_root(root)?;
    if root.exists() {
        return Err(AppError::Validation(
            "installed-candidate upgrade QA seed requires a new product data root".into(),
        ));
    }
    fs::create_dir(&root)?;
    fs::write(root.join(MARKER_NAME), MARKER_CONTENT)?;
    let connection = Connection::open(root.join("yuanyuan-reminder.sqlite3"))?;
    for migration in [
        include_str!("../migrations/001_initial.sql"),
        include_str!("../migrations/002_focus_sessions.sql"),
        include_str!("../migrations/003_pet_interactions.sql"),
        include_str!("../migrations/004_ball_interaction.sql"),
        include_str!("../migrations/005_occurrence_history.sql"),
        include_str!("../migrations/006_activity_tracking.sql"),
        include_str!("../migrations/007_reminder_management.sql"),
        include_str!("../migrations/008_companion_attention_budget.sql"),
        include_str!("../migrations/009_companion_proactive_attention.sql"),
        include_str!("../migrations/010_companion_reunion_attention.sql"),
        include_str!("../migrations/011_task_watch_attention_deferrals.sql"),
        include_str!("../migrations/012_learning_invitation_attention.sql"),
    ] {
        connection.execute_batch(migration)?;
    }
    connection.execute(
        "INSERT INTO reminders(
            id, title, category, schedule_kind, schedule_json, timezone,
            enabled, next_due_at, last_fired_at, created_at, updated_at,
            archived_at, system_kind
         ) VALUES(?1, ?2, 'personal', 'once', ?3, 'Asia/Shanghai', 0,
            '2035-02-01T01:00:00Z', '2026-09-04T01:00:00Z',
            '2026-09-04T00:00:00Z', '2026-09-04T00:30:00Z', NULL, NULL)",
        params![
            UPGRADE_REMINDER_ID,
            UPGRADE_TITLE,
            r#"{"title":"1.5.7升级保留提醒","category":"personal","scheduleKind":"once","atLocal":"2035-02-01T09:00"}"#,
        ],
    )?;
    connection.execute(
        "INSERT INTO occurrences(
            id, reminder_id, scheduled_at, status, acted_at, snoozed_until,
            notification_id, created_at, resolution_reason
         ) VALUES(?1, ?2, '2035-02-01T01:00:00Z', 'completed',
            '2035-02-01T01:01:00Z', NULL, 157,
            '2035-02-01T01:00:00Z', 'user_completed')",
        params![UPGRADE_OCCURRENCE_ID, UPGRADE_REMINDER_ID],
    )?;
    let meal_rejected_before_upgrade = connection
        .execute(
            "INSERT INTO reminders(
                id, title, category, schedule_kind, schedule_json, timezone,
                enabled, next_due_at, last_fired_at, created_at, updated_at,
                archived_at, system_kind
             ) VALUES('pre-upgrade-meal', '不应写入', 'meal', 'once', '{}',
                'Asia/Shanghai', 0, NULL, NULL,
                '2026-09-04T00:00:00Z', '2026-09-04T00:00:00Z', NULL, NULL)",
            [],
        )
        .is_err();
    let schema_version = connection.query_row("PRAGMA user_version", [], |row| row.get(0))?;
    if schema_version != 12 || !meal_rejected_before_upgrade {
        return Err(AppError::Validation(
            "installed-candidate upgrade QA did not create an exact schema-12 fixture".into(),
        ));
    }
    Ok(UpgradeSeedPlan {
        schema_version,
        reminder_id: UPGRADE_REMINDER_ID.into(),
        occurrence_id: UPGRADE_OCCURRENCE_ID.into(),
        title: UPGRADE_TITLE.into(),
        meal_rejected_before_upgrade,
    })
}

pub fn inspect_upgrade_v12(root: &Path) -> AppResult<UpgradeRollbackInspection> {
    let root = require_owned_root(root)?;
    let connection = Connection::open(root.join("yuanyuan-reminder.sqlite3"))?;
    let schema_version: u32 = connection.query_row("PRAGMA user_version", [], |row| row.get(0))?;
    let reminder_preserved = connection.query_row(
        "SELECT COUNT(*) FROM reminders
         WHERE id = ?1 AND title = ?2 AND category = 'personal'
           AND schedule_kind = 'once' AND schedule_json = ?3
           AND timezone = 'Asia/Shanghai' AND enabled = 0
           AND next_due_at = '2035-02-01T01:00:00Z'
           AND last_fired_at = '2026-09-04T01:00:00Z'
           AND created_at = '2026-09-04T00:00:00Z'
           AND updated_at = '2026-09-04T00:30:00Z'
           AND archived_at IS NULL AND system_kind IS NULL",
        params![
            UPGRADE_REMINDER_ID,
            UPGRADE_TITLE,
            r#"{"title":"1.5.7升级保留提醒","category":"personal","scheduleKind":"once","atLocal":"2035-02-01T09:00"}"#,
        ],
        |row| row.get::<_, i64>(0),
    )? == 1;
    let occurrence_preserved = connection.query_row(
        "SELECT COUNT(*) FROM occurrences
         WHERE id = ?1 AND reminder_id = ?2
           AND scheduled_at = '2035-02-01T01:00:00Z'
           AND status = 'completed' AND acted_at = '2035-02-01T01:01:00Z'
           AND snoozed_until IS NULL AND notification_id = 157
           AND created_at = '2035-02-01T01:00:00Z'
           AND resolution_reason = 'user_completed'",
        params![UPGRADE_OCCURRENCE_ID, UPGRADE_REMINDER_ID],
        |row| row.get::<_, i64>(0),
    )? == 1;
    let foreign_key_violations: i64 =
        connection.query_row("SELECT COUNT(*) FROM pragma_foreign_key_check", [], |row| {
            row.get(0)
        })?;
    let meal_rejected_after_rollback = connection
        .execute(
            "INSERT INTO reminders(
                id, title, category, schedule_kind, schedule_json, timezone,
                enabled, next_due_at, last_fired_at, created_at, updated_at,
                archived_at, system_kind
             ) VALUES('post-rollback-meal', 'must-not-persist', 'meal', 'once', '{}',
                'Asia/Shanghai', 0, NULL, NULL,
                '2026-09-04T00:00:00Z', '2026-09-04T00:00:00Z', NULL, NULL)",
            [],
        )
        .is_err();
    connection.execute_batch("PRAGMA wal_checkpoint(TRUNCATE)")?;
    Ok(UpgradeRollbackInspection {
        schema_version,
        reminder_preserved,
        occurrence_preserved,
        foreign_key_violations,
        meal_rejected_after_rollback,
    })
}

pub fn inspect_upgrade_v13(root: &Path) -> AppResult<UpgradeInspection> {
    let root = require_owned_root(root)?;
    let database_path = root.join("yuanyuan-reminder.sqlite3");
    let connection = Connection::open(&database_path)?;
    let schema_version: u32 = connection.query_row("PRAGMA user_version", [], |row| row.get(0))?;
    let reminder: Option<(
        String,
        String,
        String,
        String,
        String,
        i64,
        Option<String>,
        Option<String>,
        String,
        String,
        Option<String>,
        Option<String>,
    )> = connection
        .query_row(
            "SELECT title, category, schedule_kind, schedule_json, timezone,
                    enabled, next_due_at, last_fired_at, created_at, updated_at,
                    archived_at, system_kind
             FROM reminders WHERE id = ?1",
            [UPGRADE_REMINDER_ID],
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
                ))
            },
        )
        .optional()?;
    let reminder_preserved = reminder == Some((
        UPGRADE_TITLE.into(),
        "personal".into(),
        "once".into(),
        r#"{"title":"1.5.7升级保留提醒","category":"personal","scheduleKind":"once","atLocal":"2035-02-01T09:00"}"#.into(),
        "Asia/Shanghai".into(),
        0,
        Some("2035-02-01T01:00:00Z".into()),
        Some("2026-09-04T01:00:00Z".into()),
        "2026-09-04T00:00:00Z".into(),
        "2026-09-04T00:30:00Z".into(),
        None,
        None,
    ));
    let occurrence: Option<(
        String,
        String,
        String,
        Option<String>,
        Option<String>,
        Option<i64>,
        String,
        Option<String>,
    )> = connection
        .query_row(
            "SELECT reminder_id, scheduled_at, status, acted_at, snoozed_until,
                    notification_id, created_at, resolution_reason
             FROM occurrences WHERE id = ?1",
            [UPGRADE_OCCURRENCE_ID],
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
                ))
            },
        )
        .optional()?;
    let occurrence_preserved = occurrence
        == Some((
            UPGRADE_REMINDER_ID.into(),
            "2035-02-01T01:00:00Z".into(),
            "completed".into(),
            Some("2035-02-01T01:01:00Z".into()),
            None,
            Some(157),
            "2035-02-01T01:00:00Z".into(),
            Some("user_completed".into()),
        ));
    let foreign_key_violations: i64 =
        connection.query_row("SELECT COUNT(*) FROM pragma_foreign_key_check", [], |row| {
            row.get(0)
        })?;
    let required_indexes_present: i64 = connection.query_row(
        "SELECT COUNT(*) FROM sqlite_master
         WHERE type = 'index' AND name IN(
            'idx_reminders_next_due', 'idx_reminders_management',
            'idx_occurrences_status', 'idx_occurrences_history'
         )",
        [],
        |row| row.get(0),
    )?;
    drop(connection);
    if schema_version != 13
        || !reminder_preserved
        || !occurrence_preserved
        || foreign_key_violations != 0
        || required_indexes_present != 4
    {
        return Err(AppError::Validation(
            "installed-candidate schema-13 upgrade inspection failed".into(),
        ));
    }
    let repository = Repository::open(&database_path)?;
    let meal = repository.create_reminder(CreateReminderInput {
        title: "升级后用餐提醒".into(),
        category: "meal".into(),
        schedule_kind: "weekly".into(),
        at_local: Some("2035-02-02T12:30".into()),
        every_minutes: None,
        active_start_local: None,
        active_end_local: None,
        weekdays: Some(vec![1, 3, 5]),
    })?;
    Ok(UpgradeInspection {
        schema_version,
        reminder_preserved,
        occurrence_preserved,
        foreign_key_violations,
        required_indexes_present: true,
        meal_category: meal.category,
    })
}
