use std::{fs, path::Path};

use chrono::{
    DateTime, Datelike, Duration, Local, LocalResult, NaiveDate, NaiveDateTime, NaiveTime,
    TimeZone, Utc,
};
use rusqlite::{
    backup::Progress, params, Connection, OpenFlags, OptionalExtension, Row, TransactionBehavior,
    MAIN_DB,
};
use serde_json::Value;
use uuid::Uuid;

use crate::{
    error::{AppError, AppResult},
    models::{
        AppSettings, CreateReminderInput, DueOccurrence, FocusSession, FocusState, Occurrence,
        PetCareSnapshot, Reminder, TodaySnapshot,
    },
};

pub const SYSTEM_ACTIVITY_REMINDER_ID: &str = "system-activity-reminder";

#[cfg(windows)]
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct TaskWatchAttentionDeferral {
    pub source: crate::companion_core::TaskSource,
    pub state: yuanyuan_protocol::TaskState,
    pub deferred_until_unix_ms: i64,
}

pub struct Repository {
    conn: Connection,
}

#[cfg(feature = "learning")]
#[derive(Debug, PartialEq, Eq)]
pub(crate) struct LearningAttentionClaim {
    row_id: i64,
    claim_id: Uuid,
}

#[cfg(feature = "learning")]
impl LearningAttentionClaim {
    #[cfg(test)]
    pub(crate) fn id(&self) -> String {
        self.claim_id.to_string()
    }
}

impl Repository {
    pub fn open(path: &Path) -> AppResult<Self> {
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent)?;
        }
        let conn = Connection::open(path)?;
        conn.pragma_update(None, "foreign_keys", "ON")?;
        conn.pragma_update(None, "journal_mode", "WAL")?;
        apply_migrations(&conn)?;
        let repo = Self { conn };
        repo.ensure_runtime_defaults()?;
        Ok(repo)
    }

    fn ensure_runtime_defaults(&self) -> AppResult<()> {
        self.ensure_settings()?;
        self.ensure_default_water_reminder()?;
        self.ensure_activity_reminder()?;
        Ok(())
    }

    pub fn backup_to(&self, path: &Path) -> AppResult<()> {
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent)?;
        }
        self.conn.backup(MAIN_DB, path, None::<fn(Progress)>)?;
        Ok(())
    }

    pub fn restore_from(&mut self, path: &Path) -> AppResult<()> {
        validate_backup_database(path)?;
        self.conn.restore(MAIN_DB, path, None::<fn(Progress)>)?;
        apply_migrations(&self.conn)?;
        self.ensure_runtime_defaults()?;
        validate_connection(&self.conn)?;
        Ok(())
    }

    pub fn validate_database_file(path: &Path) -> AppResult<()> {
        validate_backup_database(path)
    }

    fn ensure_settings(&self) -> AppResult<()> {
        let exists: bool = self.conn.query_row(
            "SELECT EXISTS(SELECT 1 FROM settings WHERE id = 1)",
            [],
            |row| row.get(0),
        )?;
        if !exists {
            let now = Utc::now().to_rfc3339();
            let data = serde_json::to_string(&AppSettings::default())?;
            self.conn.execute(
                "INSERT INTO settings(id, schema_version, data_json, updated_at)
                 VALUES(1, 1, ?1, ?2)",
                params![data, now],
            )?;
        }
        Ok(())
    }

    fn ensure_default_water_reminder(&self) -> AppResult<()> {
        let count: i64 = self.conn.query_row(
            "SELECT COUNT(*) FROM reminders
             WHERE category = 'water' AND archived_at IS NULL",
            [],
            |row| row.get(0),
        )?;
        if count == 0 {
            self.create_reminder(CreateReminderInput {
                title: "喝水时间".into(),
                category: "water".into(),
                schedule_kind: "interval".into(),
                at_local: None,
                every_minutes: Some(60),
                active_start_local: Some("09:00".into()),
                active_end_local: Some("18:00".into()),
                weekdays: Some(vec![1, 2, 3, 4, 5, 6, 0]),
            })?;
        }
        self.conn.execute(
            "UPDATE reminders
             SET system_kind = 'water'
             WHERE id = (
                 SELECT id FROM reminders
                 WHERE category = 'water' AND archived_at IS NULL
                 ORDER BY created_at ASC LIMIT 1
             )",
            [],
        )?;
        Ok(())
    }

    fn ensure_activity_reminder(&self) -> AppResult<()> {
        let now = Utc::now();
        let settings = AppSettings::default();
        let input = CreateReminderInput {
            title: "起来活动一下".into(),
            category: "personal".into(),
            schedule_kind: "interval".into(),
            at_local: None,
            every_minutes: Some(settings.activity_interval_minutes),
            active_start_local: Some(settings.activity_start),
            active_end_local: Some(settings.activity_end),
            weekdays: Some(vec![0, 1, 2, 3, 4, 5, 6]),
        };
        self.conn.execute(
            "INSERT OR IGNORE INTO reminders(
                id, title, category, schedule_kind, schedule_json, timezone,
                enabled, next_due_at, created_at, updated_at, system_kind
             ) VALUES(?1, '起来活动一下', 'personal', 'interval', ?2, ?3, 0, NULL, ?4, ?4, 'activity')",
            params![
                SYSTEM_ACTIVITY_REMINDER_ID,
                serde_json::to_string(&input)?,
                iana_time_zone::get_timezone().unwrap_or_else(|_| "local".into()),
                now.to_rfc3339(),
            ],
        )?;
        self.conn.execute(
            "UPDATE reminders
             SET title = '起来活动一下', enabled = 0, next_due_at = NULL,
                 archived_at = NULL, system_kind = 'activity'
             WHERE id = ?1",
            [SYSTEM_ACTIVITY_REMINDER_ID],
        )?;
        Ok(())
    }

    pub fn list_today(&self, notification_available: bool) -> AppResult<TodaySnapshot> {
        self.mark_overdue()?;
        let (day_start, next_day_start) = local_day_utc_bounds(Local::now())?;
        let mut reminder_statement = self.conn.prepare(
            "SELECT id, title, category, schedule_kind, schedule_json, timezone,
                    enabled, next_due_at, created_at, updated_at, archived_at, system_kind
             FROM reminders
             WHERE archived_at IS NULL
             ORDER BY enabled DESC, next_due_at ASC",
        )?;
        let reminders = reminder_statement
            .query_map([], reminder_from_row)?
            .collect::<Result<Vec<_>, _>>()?;

        let mut occurrence_statement = self.conn.prepare(
            "SELECT o.id, o.reminder_id, r.title, r.category, o.scheduled_at,
                    o.status, o.acted_at, o.snoozed_until, o.resolution_reason
             FROM occurrences o
             JOIN reminders r ON r.id = o.reminder_id
             WHERE o.status IN ('pending', 'overdue', 'snoozed')
                OR (o.acted_at >= ?1 AND o.acted_at < ?2)
             ORDER BY
                CASE
                    WHEN r.category = 'water' THEN 0
                    WHEN r.id = 'system-activity-reminder' THEN 1
                    ELSE 2
                END,
                COALESCE(o.snoozed_until, o.scheduled_at) ASC",
        )?;
        let occurrences = occurrence_statement
            .query_map(params![day_start, next_day_start], occurrence_from_row)?
            .collect::<Result<Vec<_>, _>>()?;

        let water_completed: u32 = self.conn.query_row(
            "SELECT COUNT(*) FROM water_log
             WHERE completed_at >= ?1 AND completed_at < ?2",
            params![day_start, next_day_start],
            |row| row.get(0),
        )?;
        let settings = self.get_settings()?;
        let start = parse_time(&settings.water_start)?;
        let end = parse_time(&settings.water_end)?;
        let minutes = if end >= start {
            (end - start).num_minutes()
        } else {
            (end - start).num_minutes() + 24 * 60
        };
        let water_goal =
            (minutes / i64::from(settings.water_interval_minutes.max(15))).max(1) as u32;

        Ok(TodaySnapshot {
            reminders,
            occurrences,
            water_completed,
            water_goal,
            notification_available,
        })
    }

    pub fn list_history(
        &self,
        days: Option<u32>,
        status: Option<&str>,
        category: Option<&str>,
        query: Option<&str>,
        limit: u32,
    ) -> AppResult<Vec<Occurrence>> {
        if let Some(status) = status {
            if !["completed", "skipped"].contains(&status) {
                return Err(AppError::Validation("unsupported history status".into()));
            }
        }
        if let Some(category) = category {
            if !["water", "work", "personal"].contains(&category) {
                return Err(AppError::Validation("unsupported history category".into()));
            }
        }
        let cutoff = days
            .map(|days| days.clamp(1, 3650))
            .map(|days| (Utc::now() - Duration::days(i64::from(days))).to_rfc3339());
        let query = query.map(str::trim).filter(|value| !value.is_empty());
        let mut statement = self.conn.prepare(
            "SELECT o.id, o.reminder_id, r.title, r.category, o.scheduled_at,
                    o.status, o.acted_at, o.snoozed_until, o.resolution_reason
             FROM occurrences o
             JOIN reminders r ON r.id = o.reminder_id
             WHERE o.status IN ('completed', 'skipped')
               AND (?1 IS NULL OR o.acted_at >= ?1)
               AND (?2 IS NULL OR o.status = ?2)
               AND (?3 IS NULL OR r.category = ?3)
               AND (?4 IS NULL OR instr(r.title, ?4) > 0)
             ORDER BY o.acted_at DESC, o.scheduled_at DESC
             LIMIT ?5",
        )?;
        let history = statement
            .query_map(
                params![
                    cutoff,
                    status,
                    category,
                    query,
                    i64::from(limit.clamp(1, 500))
                ],
                occurrence_from_row,
            )?
            .collect::<Result<Vec<_>, _>>()?;
        Ok(history)
    }

    pub fn create_reminder(&self, input: CreateReminderInput) -> AppResult<Reminder> {
        validate_input(&input)?;
        let id = Uuid::new_v4().to_string();
        let now = Utc::now();
        let timezone = iana_time_zone::get_timezone().unwrap_or_else(|_| "local".into());
        let next_due = compute_next_due(&input, now, true)?;
        let schedule_json = serde_json::to_string(&input)?;
        self.conn.execute(
            "INSERT INTO reminders(
                id, title, category, schedule_kind, schedule_json, timezone,
                enabled, next_due_at, created_at, updated_at
             ) VALUES(?1, ?2, ?3, ?4, ?5, ?6, 1, ?7, ?8, ?8)",
            params![
                id,
                input.title.trim(),
                input.category,
                input.schedule_kind,
                schedule_json,
                timezone,
                next_due.as_ref().map(|value| value.to_rfc3339()),
                now.to_rfc3339(),
            ],
        )?;
        self.get_reminder(&id)?
            .ok_or_else(|| AppError::Database(rusqlite::Error::QueryReturnedNoRows))
    }

    #[cfg(feature = "runtime-qa")]
    pub(crate) fn set_runtime_qa_reminder_due(
        &self,
        reminder_id: &str,
        scheduled_at: DateTime<Utc>,
    ) -> AppResult<()> {
        let changed = self.conn.execute(
            "UPDATE reminders SET next_due_at = ?1, updated_at = ?2 WHERE id = ?3",
            params![
                scheduled_at.to_rfc3339(),
                Utc::now().to_rfc3339(),
                reminder_id
            ],
        )?;
        if changed != 1 {
            return Err(AppError::Validation(
                "runtime QA reminder does not exist".into(),
            ));
        }
        Ok(())
    }

    #[cfg(feature = "runtime-qa")]
    pub(crate) fn runtime_qa_reminder_claim(
        &self,
        reminder_id: &str,
    ) -> AppResult<Option<(String, String, String)>> {
        self.conn
            .query_row(
                "SELECT scheduled_at, created_at, status
                 FROM occurrences
                 WHERE reminder_id = ?1
                 ORDER BY created_at ASC
                 LIMIT 1",
                [reminder_id],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
            )
            .optional()
            .map_err(AppError::from)
    }

    #[cfg(feature = "runtime-qa")]
    pub(crate) fn runtime_qa_reminder_occurrence_state(
        &self,
        reminder_id: &str,
    ) -> AppResult<Option<(String, Option<String>, Option<String>)>> {
        self.conn
            .query_row(
                "SELECT status, snoozed_until, resolution_reason
                 FROM occurrences
                 WHERE reminder_id = ?1
                 ORDER BY created_at ASC
                 LIMIT 1",
                [reminder_id],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
            )
            .optional()
            .map_err(AppError::from)
    }

    #[cfg(feature = "runtime-qa")]
    pub(crate) fn runtime_qa_backup_contains_reminder(
        path: &Path,
        reminder_id: &str,
    ) -> AppResult<bool> {
        validate_backup_database(path)?;
        let connection = Connection::open_with_flags(path, OpenFlags::SQLITE_OPEN_READ_ONLY)?;
        connection
            .query_row(
                "SELECT EXISTS(SELECT 1 FROM reminders WHERE id = ?1)",
                [reminder_id],
                |row| row.get(0),
            )
            .map_err(AppError::from)
    }

    pub fn update_reminder(&mut self, id: &str, input: CreateReminderInput) -> AppResult<Reminder> {
        validate_input(&input)?;
        let now = Utc::now();
        let transaction = self.conn.transaction()?;
        let state = transaction
            .query_row(
                "SELECT enabled, archived_at, system_kind
                 FROM reminders WHERE id = ?1",
                [id],
                |row| {
                    Ok((
                        row.get::<_, bool>(0)?,
                        row.get::<_, Option<String>>(1)?,
                        row.get::<_, Option<String>>(2)?,
                    ))
                },
            )
            .optional()?;
        let Some((enabled, archived_at, system_kind)) = state else {
            return Err(AppError::Validation("reminder does not exist".into()));
        };
        if archived_at.is_some() {
            return Err(AppError::Validation("reminder is archived".into()));
        }
        if system_kind.is_some() {
            return Err(AppError::Validation(
                "system reminders must be changed in settings".into(),
            ));
        }
        let next_due = if enabled {
            compute_next_due(&input, now, true)?
        } else {
            None
        };
        let schedule_json = serde_json::to_string(&input)?;
        let now_text = now.to_rfc3339();
        transaction.execute(
            "UPDATE reminders
             SET title = ?1, category = ?2, schedule_kind = ?3,
                 schedule_json = ?4, timezone = ?5, next_due_at = ?6,
                 updated_at = ?7
             WHERE id = ?8",
            params![
                input.title.trim(),
                input.category,
                input.schedule_kind,
                schedule_json,
                iana_time_zone::get_timezone().unwrap_or_else(|_| "local".into()),
                next_due.as_ref().map(|value| value.to_rfc3339()),
                now_text,
                id,
            ],
        )?;
        resolve_active_occurrences(&transaction, id, &now_text, "reminder-edited")?;
        transaction.commit()?;
        self.get_reminder(id)?
            .ok_or_else(|| AppError::Validation("reminder does not exist".into()))
    }

    pub fn set_reminder_enabled(&mut self, id: &str, enabled: bool) -> AppResult<Reminder> {
        let now = Utc::now();
        let transaction = self.conn.transaction()?;
        let state = transaction
            .query_row(
                "SELECT schedule_json, archived_at, system_kind
                 FROM reminders WHERE id = ?1",
                [id],
                |row| {
                    Ok((
                        row.get::<_, String>(0)?,
                        row.get::<_, Option<String>>(1)?,
                        row.get::<_, Option<String>>(2)?,
                    ))
                },
            )
            .optional()?;
        let Some((schedule_json, archived_at, system_kind)) = state else {
            return Err(AppError::Validation("reminder does not exist".into()));
        };
        if archived_at.is_some() {
            return Err(AppError::Validation("reminder is archived".into()));
        }
        if system_kind.is_some() {
            return Err(AppError::Validation(
                "system reminders must be changed in settings".into(),
            ));
        }
        let next_due = if enabled {
            let input: CreateReminderInput = serde_json::from_str(&schedule_json)?;
            compute_next_due(&input, now, true)?
        } else {
            None
        };
        let now_text = now.to_rfc3339();
        transaction.execute(
            "UPDATE reminders
             SET enabled = ?1, next_due_at = ?2, updated_at = ?3
             WHERE id = ?4",
            params![
                enabled,
                next_due.as_ref().map(|value| value.to_rfc3339()),
                now_text,
                id,
            ],
        )?;
        if !enabled {
            resolve_active_occurrences(&transaction, id, &now_text, "reminder-disabled")?;
        }
        transaction.commit()?;
        self.get_reminder(id)?
            .ok_or_else(|| AppError::Validation("reminder does not exist".into()))
    }

    pub fn archive_reminder(&mut self, id: &str) -> AppResult<()> {
        let now = Utc::now().to_rfc3339();
        let transaction = self.conn.transaction()?;
        let state = transaction
            .query_row(
                "SELECT archived_at, system_kind FROM reminders WHERE id = ?1",
                [id],
                |row| {
                    Ok((
                        row.get::<_, Option<String>>(0)?,
                        row.get::<_, Option<String>>(1)?,
                    ))
                },
            )
            .optional()?;
        let Some((archived_at, system_kind)) = state else {
            return Err(AppError::Validation("reminder does not exist".into()));
        };
        if archived_at.is_some() {
            return Ok(());
        }
        if system_kind.is_some() {
            return Err(AppError::Validation(
                "system reminders cannot be deleted".into(),
            ));
        }
        transaction.execute(
            "UPDATE reminders
             SET enabled = 0, next_due_at = NULL, archived_at = ?1, updated_at = ?1
             WHERE id = ?2",
            params![now, id],
        )?;
        resolve_active_occurrences(&transaction, id, &now, "reminder-deleted")?;
        transaction.commit()?;
        Ok(())
    }

    pub fn get_reminder(&self, id: &str) -> AppResult<Option<Reminder>> {
        Ok(self
            .conn
            .query_row(
                "SELECT id, title, category, schedule_kind, schedule_json, timezone,
                        enabled, next_due_at, created_at, updated_at, archived_at, system_kind
                 FROM reminders WHERE id = ?1",
                [id],
                reminder_from_row,
            )
            .optional()?)
    }

    pub fn create_activity_occurrence(&self, now: DateTime<Utc>) -> AppResult<Option<Occurrence>> {
        let exists: bool = self.conn.query_row(
            "SELECT EXISTS(
                SELECT 1 FROM occurrences
                WHERE reminder_id = ?1
                  AND status IN ('pending', 'overdue', 'snoozed')
             )",
            [SYSTEM_ACTIVITY_REMINDER_ID],
            |row| row.get(0),
        )?;
        if exists {
            return Ok(None);
        }
        let id = Uuid::new_v4().to_string();
        let timestamp = now.to_rfc3339();
        self.conn.execute(
            "INSERT INTO occurrences(
                id, reminder_id, scheduled_at, status, created_at
             ) VALUES(?1, ?2, ?3, 'pending', ?3)",
            params![id, SYSTEM_ACTIVITY_REMINDER_ID, timestamp],
        )?;
        Ok(Some(Occurrence {
            id,
            reminder_id: SYSTEM_ACTIVITY_REMINDER_ID.into(),
            reminder_title: "起来活动一下".into(),
            category: "personal".into(),
            scheduled_at: timestamp,
            status: "pending".into(),
            acted_at: None,
            snoozed_until: None,
            resolution_reason: None,
        }))
    }

    pub fn take_ready_activity_alert(&self) -> AppResult<Option<Occurrence>> {
        let occurrence = self
            .conn
            .query_row(
                "SELECT o.id, o.reminder_id, r.title, r.category, o.scheduled_at,
                        o.status, o.acted_at, o.snoozed_until, o.resolution_reason
                 FROM occurrences o
                 JOIN reminders r ON r.id = o.reminder_id
                 WHERE o.reminder_id = ?1
                   AND o.status IN ('pending', 'overdue')
                   AND o.notification_id IS NULL
                   AND NOT EXISTS(
                       SELECT 1
                       FROM occurrences water_occurrence
                       JOIN reminders water_reminder
                         ON water_reminder.id = water_occurrence.reminder_id
                       WHERE water_reminder.category = 'water'
                         AND water_occurrence.status IN ('pending', 'overdue', 'snoozed')
                   )
                 ORDER BY o.scheduled_at ASC
                 LIMIT 1",
                [SYSTEM_ACTIVITY_REMINDER_ID],
                occurrence_from_row,
            )
            .optional()?;
        let Some(occurrence) = occurrence else {
            return Ok(None);
        };
        self.conn.execute(
            "UPDATE occurrences SET notification_id = 1 WHERE id = ?1",
            [&occurrence.id],
        )?;
        Ok(Some(occurrence))
    }

    pub fn occurrence_is_water(&self, id: &str) -> AppResult<bool> {
        Ok(self.conn.query_row(
            "SELECT EXISTS(
                SELECT 1
                FROM occurrences o
                JOIN reminders r ON r.id = o.reminder_id
                WHERE o.id = ?1 AND r.category = 'water'
             )",
            [id],
            |row| row.get(0),
        )?)
    }

    pub fn activity_active_seconds(&self) -> AppResult<u64> {
        let value: i64 = self.conn.query_row(
            "SELECT active_seconds FROM activity_tracking_state WHERE id = 1",
            [],
            |row| row.get(0),
        )?;
        Ok(value.max(0) as u64)
    }

    pub fn save_activity_active_seconds(&self, active_seconds: u64) -> AppResult<()> {
        self.conn.execute(
            "UPDATE activity_tracking_state
             SET active_seconds = ?1, updated_at = ?2
             WHERE id = 1",
            params![
                i64::try_from(active_seconds).unwrap_or(i64::MAX),
                Utc::now().to_rfc3339()
            ],
        )?;
        Ok(())
    }

    pub fn complete_occurrence(&mut self, id: &str) -> AppResult<bool> {
        let now = Utc::now().to_rfc3339();
        let transaction = self.conn.transaction()?;
        let category = transaction
            .query_row(
                "SELECT r.category
                 FROM occurrences o
                 JOIN reminders r ON r.id = o.reminder_id
                 WHERE o.id = ?1",
                [id],
                |row| row.get::<_, String>(0),
            )
            .optional()?;
        let Some(category) = category else {
            return Err(AppError::Validation("occurrence does not exist".into()));
        };
        let changed = transaction.execute(
            "UPDATE occurrences
             SET status = 'completed', acted_at = ?1, snoozed_until = NULL,
                 resolution_reason = 'manual'
             WHERE id = ?2 AND status IN ('pending', 'overdue', 'snoozed')",
            params![now, id],
        )?;
        let completed_water = changed > 0 && category == "water";
        if completed_water {
            transaction.execute(
                "INSERT INTO water_log(id, completed_at) VALUES(?1, ?2)",
                params![Uuid::new_v4().to_string(), now],
            )?;
        }
        transaction.commit()?;
        Ok(completed_water)
    }

    pub fn claim_due(&mut self, now: DateTime<Utc>) -> AppResult<Vec<DueOccurrence>> {
        let settings = self.get_settings()?;
        let pause_until = settings
            .pause_until
            .as_deref()
            .and_then(|value| DateTime::parse_from_rfc3339(value).ok())
            .map(|value| value.with_timezone(&Utc));
        if pause_until.is_some_and(|until| until > now) {
            return Ok(Vec::new());
        }

        let due_reminders = {
            let mut statement = self.conn.prepare(
                "SELECT id, title, category, schedule_kind, schedule_json, timezone,
                        enabled, next_due_at, created_at, updated_at, archived_at, system_kind
                 FROM reminders
                 WHERE enabled = 1 AND archived_at IS NULL
                   AND next_due_at IS NOT NULL AND next_due_at <= ?1
                 ORDER BY next_due_at ASC",
            )?;
            let rows = statement.query_map([now.to_rfc3339()], reminder_from_row)?;
            rows.collect::<Result<Vec<_>, _>>()?
        };

        let transaction = self.conn.transaction()?;
        let mut claimed = Vec::new();
        for reminder in due_reminders {
            let scheduled_at = reminder
                .next_due_at
                .as_ref()
                .ok_or_else(|| AppError::Time("due reminder has no due time".into()))?;
            let occurrence_id = Uuid::new_v4().to_string();
            let scheduled = DateTime::parse_from_rfc3339(scheduled_at)
                .map_err(|error| AppError::Time(error.to_string()))?
                .with_timezone(&Utc);
            let missed = settings.missed_reminder_policy == "skipOld"
                && now.signed_duration_since(scheduled)
                    > Duration::minutes(i64::from(
                        settings.missed_reminder_grace_minutes.clamp(15, 240),
                    ));
            let has_active_water = reminder.category == "water"
                && transaction.query_row(
                    "SELECT EXISTS(
                        SELECT 1 FROM occurrences
                        WHERE reminder_id = ?1
                          AND status IN ('pending', 'overdue', 'snoozed')
                    )",
                    [&reminder.id],
                    |row| row.get(0),
                )?;
            let inserted = if has_active_water {
                0
            } else if missed {
                transaction.execute(
                    "INSERT OR IGNORE INTO occurrences(
                        id, reminder_id, scheduled_at, status, acted_at,
                        resolution_reason, created_at
                     ) VALUES(?1, ?2, ?3, 'skipped', ?4, 'missed', ?4)",
                    params![occurrence_id, reminder.id, scheduled_at, now.to_rfc3339()],
                )?
            } else {
                transaction.execute(
                    "INSERT OR IGNORE INTO occurrences(
                        id, reminder_id, scheduled_at, status, created_at
                     ) VALUES(?1, ?2, ?3, 'pending', ?4)",
                    params![occurrence_id, reminder.id, scheduled_at, now.to_rfc3339()],
                )?
            };

            let input: CreateReminderInput = serde_json::from_str(&reminder.schedule_json)?;
            let next_due = compute_next_due(&input, now, false)?;
            let enabled = next_due.is_some();
            transaction.execute(
                "UPDATE reminders
                 SET next_due_at = ?1, last_fired_at = ?2, enabled = ?3, updated_at = ?2
                 WHERE id = ?4",
                params![
                    next_due.as_ref().map(|value| value.to_rfc3339()),
                    now.to_rfc3339(),
                    enabled,
                    reminder.id
                ],
            )?;

            if inserted > 0 {
                claimed.push(DueOccurrence {
                    occurrence: Occurrence {
                        id: occurrence_id,
                        reminder_id: reminder.id,
                        reminder_title: reminder.title,
                        category: reminder.category,
                        scheduled_at: scheduled_at.clone(),
                        status: if missed { "skipped" } else { "pending" }.into(),
                        acted_at: missed.then(|| now.to_rfc3339()),
                        snoozed_until: None,
                        resolution_reason: missed.then(|| "missed".into()),
                    },
                    notify: !missed,
                });
            }
        }

        let snoozed_due = {
            let mut statement = transaction.prepare(
                "SELECT o.id, o.reminder_id, r.title, r.category, o.scheduled_at,
                        o.status, o.acted_at, o.snoozed_until, o.resolution_reason
                 FROM occurrences o
                 JOIN reminders r ON r.id = o.reminder_id
                 WHERE o.status = 'snoozed'
                   AND o.snoozed_until IS NOT NULL
                   AND o.snoozed_until <= ?1
                 ORDER BY o.snoozed_until ASC",
            )?;
            let occurrences = statement
                .query_map([now.to_rfc3339()], occurrence_from_row)?
                .collect::<Result<Vec<_>, _>>()?;
            occurrences
        };
        for mut occurrence in snoozed_due {
            transaction.execute(
                "UPDATE occurrences
                 SET status = 'pending', snoozed_until = NULL, acted_at = NULL,
                     notification_id = NULL, resolution_reason = NULL
                 WHERE id = ?1 AND status = 'snoozed'",
                [&occurrence.id],
            )?;
            occurrence.status = "pending".into();
            occurrence.acted_at = None;
            occurrence.snoozed_until = None;
            occurrence.resolution_reason = None;
            claimed.push(DueOccurrence {
                occurrence,
                notify: true,
            });
        }
        transaction.commit()?;
        Ok(claimed)
    }

    pub fn update_occurrence(
        &self,
        id: &str,
        status: &str,
        snooze_minutes: Option<u32>,
    ) -> AppResult<()> {
        let allowed = ["completed", "snoozed", "skipped"];
        if !allowed.contains(&status) {
            return Err(AppError::Validation("unsupported occurrence status".into()));
        }
        let now = Utc::now();
        let snoozed_until = snooze_minutes
            .map(|minutes| now + Duration::minutes(i64::from(minutes)))
            .map(|value| value.to_rfc3339());
        let changed = self.conn.execute(
            "UPDATE occurrences
             SET status = ?1, acted_at = ?2, snoozed_until = ?3,
                 resolution_reason = CASE WHEN ?1 = 'snoozed' THEN NULL ELSE 'manual' END
             WHERE id = ?4 AND status IN ('pending', 'overdue', 'snoozed')",
            params![status, now.to_rfc3339(), snoozed_until, id],
        )?;
        if changed == 0 {
            let exists: bool = self.conn.query_row(
                "SELECT EXISTS(SELECT 1 FROM occurrences WHERE id = ?1)",
                [id],
                |row| row.get(0),
            )?;
            if !exists {
                return Err(AppError::Validation("occurrence does not exist".into()));
            }
        }
        Ok(())
    }

    pub fn record_water(&mut self) -> AppResult<()> {
        let now = Utc::now().to_rfc3339();
        let transaction = self.conn.transaction()?;
        transaction.execute(
            "INSERT INTO water_log(id, completed_at) VALUES(?1, ?2)",
            params![Uuid::new_v4().to_string(), now],
        )?;
        transaction.execute(
            "UPDATE occurrences
             SET status = 'completed', acted_at = ?1, snoozed_until = NULL,
                 resolution_reason = 'manual'
             WHERE id = (
                 SELECT o.id
                 FROM occurrences o
                 JOIN reminders r ON r.id = o.reminder_id
                 WHERE r.category = 'water'
                   AND o.status IN ('pending', 'overdue', 'snoozed')
                 ORDER BY COALESCE(o.snoozed_until, o.scheduled_at) ASC
                 LIMIT 1
             )",
            [&now],
        )?;
        transaction.commit()?;
        Ok(())
    }

    pub fn record_pet_interaction(&self, kind: &str) -> AppResult<PetCareSnapshot> {
        if !["food", "water", "treat", "wand", "pet", "ball"].contains(&kind) {
            return Err(AppError::Validation("unsupported pet interaction".into()));
        }
        self.conn.execute(
            "INSERT INTO pet_interactions(id, kind, created_at) VALUES(?1, ?2, ?3)",
            params![Uuid::new_v4().to_string(), kind, Utc::now().to_rfc3339()],
        )?;
        self.get_pet_care()
    }

    pub fn get_pet_care(&self) -> AppResult<PetCareSnapshot> {
        let (day_start, next_day_start) = local_day_utc_bounds(Local::now())?;
        self.conn
            .query_row(
                "SELECT
                    COUNT(*),
                    COALESCE(SUM(CASE WHEN kind = 'food' THEN 1 ELSE 0 END), 0),
                    COALESCE(SUM(CASE WHEN kind = 'water' THEN 1 ELSE 0 END), 0),
                    COALESCE(SUM(CASE WHEN kind = 'treat' THEN 1 ELSE 0 END), 0),
                    COALESCE(SUM(CASE WHEN kind = 'wand' THEN 1 ELSE 0 END), 0),
                    COALESCE(SUM(CASE WHEN kind = 'pet' THEN 1 ELSE 0 END), 0),
                    COALESCE(SUM(CASE WHEN kind = 'ball' THEN 1 ELSE 0 END), 0),
                    MAX(created_at)
                 FROM pet_interactions
                 WHERE created_at >= ?1 AND created_at < ?2",
                params![day_start, next_day_start],
                |row| {
                    Ok(PetCareSnapshot {
                        total: row.get(0)?,
                        food: row.get(1)?,
                        water: row.get(2)?,
                        treat: row.get(3)?,
                        wand: row.get(4)?,
                        pet: row.get(5)?,
                        ball: row.get(6)?,
                        last_interaction_at: row.get(7)?,
                    })
                },
            )
            .map_err(Into::into)
    }

    pub fn get_focus_state(&self) -> AppResult<FocusState> {
        let session = self
            .conn
            .query_row(
                "SELECT id, phase, status, duration_minutes, started_at, ends_at, completed_at
                 FROM focus_sessions
                 WHERE status = 'active'
                 ORDER BY started_at DESC
                 LIMIT 1",
                [],
                focus_session_from_row,
            )
            .optional()?;
        Ok(FocusState { session })
    }

    pub fn start_focus(&self, phase: &str, duration_minutes: u32) -> AppResult<FocusState> {
        if !["focus", "break"].contains(&phase) {
            return Err(AppError::Validation("unsupported focus phase".into()));
        }
        if !(1..=240).contains(&duration_minutes) {
            return Err(AppError::Validation(
                "focus duration must be between 1 and 240 minutes".into(),
            ));
        }
        let now = Utc::now();
        self.conn.execute(
            "UPDATE focus_sessions
             SET status = 'cancelled', completed_at = ?1
             WHERE status = 'active'",
            [now.to_rfc3339()],
        )?;
        let session = FocusSession {
            id: Uuid::new_v4().to_string(),
            phase: phase.into(),
            status: "active".into(),
            duration_minutes,
            started_at: now.to_rfc3339(),
            ends_at: (now + Duration::minutes(i64::from(duration_minutes))).to_rfc3339(),
            completed_at: None,
        };
        self.conn.execute(
            "INSERT INTO focus_sessions(
                id, phase, status, duration_minutes, started_at, ends_at, completed_at
             ) VALUES(?1, ?2, ?3, ?4, ?5, ?6, NULL)",
            params![
                session.id,
                session.phase,
                session.status,
                session.duration_minutes,
                session.started_at,
                session.ends_at,
            ],
        )?;
        Ok(FocusState {
            session: Some(session),
        })
    }

    pub fn cancel_focus(&self) -> AppResult<FocusState> {
        self.conn.execute(
            "UPDATE focus_sessions
             SET status = 'cancelled', completed_at = ?1
             WHERE status = 'active'",
            [Utc::now().to_rfc3339()],
        )?;
        Ok(FocusState { session: None })
    }

    pub fn complete_due_focus(&self, now: DateTime<Utc>) -> AppResult<Option<FocusSession>> {
        let session = self
            .conn
            .query_row(
                "SELECT id, phase, status, duration_minutes, started_at, ends_at, completed_at
                 FROM focus_sessions
                 WHERE status = 'active' AND ends_at <= ?1
                 ORDER BY ends_at ASC
                 LIMIT 1",
                [now.to_rfc3339()],
                focus_session_from_row,
            )
            .optional()?;
        let Some(mut session) = session else {
            return Ok(None);
        };
        let completed_at = now.to_rfc3339();
        self.conn.execute(
            "UPDATE focus_sessions
             SET status = 'completed', completed_at = ?1
             WHERE id = ?2 AND status = 'active'",
            params![completed_at, session.id],
        )?;
        session.status = "completed".into();
        session.completed_at = Some(completed_at);
        Ok(Some(session))
    }

    pub fn get_settings(&self) -> AppResult<AppSettings> {
        let data: String =
            self.conn
                .query_row("SELECT data_json FROM settings WHERE id = 1", [], |row| {
                    row.get(0)
                })?;
        Ok(serde_json::from_str(&data)?)
    }

    pub fn update_settings(&self, patch: Value) -> AppResult<AppSettings> {
        let current = self.get_settings()?;
        let mut value = serde_json::to_value(&current)?;
        let target = value.as_object_mut().ok_or_else(|| {
            AppError::Serialization(serde_json::Error::io(std::io::Error::other(
                "settings object",
            )))
        })?;
        let patch = patch
            .as_object()
            .ok_or_else(|| AppError::Validation("settings patch must be an object".into()))?;
        for (key, item) in patch {
            target.insert(key.clone(), item.clone());
        }
        let settings: AppSettings = serde_json::from_value(value)?;
        validate_settings(&settings)?;
        self.save_settings(&settings)?;
        if current.water_start != settings.water_start
            || current.water_end != settings.water_end
            || current.water_interval_minutes != settings.water_interval_minutes
        {
            self.sync_default_water_reminder(&settings)?;
        }
        Ok(settings)
    }

    fn sync_default_water_reminder(&self, settings: &AppSettings) -> AppResult<()> {
        let reminder = self
            .conn
            .query_row(
                "SELECT id, title
                 FROM reminders
                 WHERE system_kind = 'water' AND archived_at IS NULL
                 ORDER BY created_at ASC
                 LIMIT 1",
                [],
                |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?)),
            )
            .optional()?;
        let Some((id, title)) = reminder else {
            return Ok(());
        };
        let input = CreateReminderInput {
            title,
            category: "water".into(),
            schedule_kind: "interval".into(),
            at_local: None,
            every_minutes: Some(settings.water_interval_minutes),
            active_start_local: Some(settings.water_start.clone()),
            active_end_local: Some(settings.water_end.clone()),
            weekdays: Some(vec![0, 1, 2, 3, 4, 5, 6]),
        };
        let now = Utc::now();
        let next_due = compute_next_due(&input, now, true)?;
        self.conn.execute(
            "UPDATE reminders
             SET schedule_kind = 'interval', schedule_json = ?1, next_due_at = ?2,
                 enabled = 1, updated_at = ?3
             WHERE id = ?4",
            params![
                serde_json::to_string(&input)?,
                next_due.as_ref().map(|value| value.to_rfc3339()),
                now.to_rfc3339(),
                id,
            ],
        )?;
        Ok(())
    }

    pub fn save_settings(&self, settings: &AppSettings) -> AppResult<()> {
        self.conn.execute(
            "UPDATE settings SET data_json = ?1, updated_at = ?2 WHERE id = 1",
            params![serde_json::to_string(settings)?, Utc::now().to_rfc3339()],
        )?;
        Ok(())
    }

    #[cfg(windows)]
    pub fn list_task_watch_attention_deferrals(
        &self,
        now_unix_ms: i64,
    ) -> AppResult<Vec<TaskWatchAttentionDeferral>> {
        if now_unix_ms < 0 {
            return Err(AppError::Validation(
                "task watch deferral clock is invalid".into(),
            ));
        }
        let mut statement = self.conn.prepare(
            "SELECT source, state, deferred_until_unix_ms
             FROM task_watch_attention_deferrals
             WHERE deferred_until_unix_ms > ?1
             ORDER BY source, state",
        )?;
        let rows = statement.query_map([now_unix_ms], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, i64>(2)?,
            ))
        })?;
        let mut deferrals = Vec::new();
        for row in rows {
            let (source, state, deferred_until_unix_ms) = row?;
            deferrals.push(TaskWatchAttentionDeferral {
                source: parse_task_watch_source(&source).ok_or_else(|| {
                    AppError::Validation("task watch deferral source is invalid".into())
                })?,
                state: parse_task_watch_state(&state).ok_or_else(|| {
                    AppError::Validation("task watch deferral state is invalid".into())
                })?,
                deferred_until_unix_ms,
            });
        }
        Ok(deferrals)
    }

    #[cfg(windows)]
    pub fn list_due_task_watch_attention_deferrals(
        &self,
        now_unix_ms: i64,
    ) -> AppResult<Vec<TaskWatchAttentionDeferral>> {
        if now_unix_ms < 0 {
            return Err(AppError::Validation(
                "task watch deferral clock is invalid".into(),
            ));
        }
        let raw = {
            let mut statement = self.conn.prepare(
                "SELECT source, state, deferred_until_unix_ms
                 FROM task_watch_attention_deferrals
                 WHERE deferred_until_unix_ms <= ?1
                 ORDER BY deferred_until_unix_ms, source, state",
            )?;
            let rows = statement
                .query_map([now_unix_ms], |row| {
                    Ok((
                        row.get::<_, String>(0)?,
                        row.get::<_, String>(1)?,
                        row.get::<_, i64>(2)?,
                    ))
                })?
                .collect::<Result<Vec<_>, _>>()?;
            rows
        };
        let mut due = Vec::new();
        for (source, state, deferred_until_unix_ms) in raw {
            due.push(TaskWatchAttentionDeferral {
                source: parse_task_watch_source(&source).ok_or_else(|| {
                    AppError::Validation("task watch deferral source is invalid".into())
                })?,
                state: parse_task_watch_state(&state).ok_or_else(|| {
                    AppError::Validation("task watch deferral state is invalid".into())
                })?,
                deferred_until_unix_ms,
            });
        }
        Ok(due)
    }

    #[cfg(windows)]
    pub fn acknowledge_due_task_watch_attention_deferrals(
        &mut self,
        due: &[TaskWatchAttentionDeferral],
    ) -> AppResult<usize> {
        let transaction = self
            .conn
            .transaction_with_behavior(TransactionBehavior::Immediate)?;
        let mut removed = 0;
        for deferral in due {
            removed += transaction.execute(
                "DELETE FROM task_watch_attention_deferrals
                 WHERE source = ?1 AND state = ?2 AND deferred_until_unix_ms = ?3",
                params![
                    task_watch_source_name(deferral.source),
                    task_watch_state_name(deferral.state).ok_or_else(|| {
                        AppError::Validation("task watch state cannot be deferred".into())
                    })?,
                    deferral.deferred_until_unix_ms,
                ],
            )?;
        }
        transaction.commit()?;
        Ok(removed)
    }

    #[cfg(windows)]
    pub fn defer_task_watch_attention(
        &mut self,
        source: crate::companion_core::TaskSource,
        state: yuanyuan_protocol::TaskState,
        minutes: u32,
        now_unix_ms: i64,
    ) -> AppResult<i64> {
        if now_unix_ms < 0 || !matches!(minutes, 10 | 30 | 60) {
            return Err(AppError::Validation(
                "task watch deferral request is invalid".into(),
            ));
        }
        let state_name = task_watch_state_name(state)
            .ok_or_else(|| AppError::Validation("task watch state cannot be deferred".into()))?;
        let deferred_until_unix_ms = now_unix_ms
            .checked_add(i64::from(minutes) * 60 * 1_000)
            .ok_or_else(|| AppError::Validation("task watch deferral is too long".into()))?;
        let transaction = self
            .conn
            .transaction_with_behavior(TransactionBehavior::Immediate)?;
        transaction.execute(
            "DELETE FROM task_watch_attention_deferrals
             WHERE deferred_until_unix_ms <= ?1",
            [now_unix_ms],
        )?;
        transaction.execute(
            "INSERT INTO task_watch_attention_deferrals(
                source, state, deferred_until_unix_ms, updated_at_unix_ms
             ) VALUES(?1, ?2, ?3, ?4)
             ON CONFLICT(source, state) DO UPDATE SET
                deferred_until_unix_ms = excluded.deferred_until_unix_ms,
                updated_at_unix_ms = excluded.updated_at_unix_ms",
            params![
                task_watch_source_name(source),
                state_name,
                deferred_until_unix_ms,
                now_unix_ms,
            ],
        )?;
        transaction.commit()?;
        Ok(deferred_until_unix_ms)
    }

    #[cfg(windows)]
    pub fn clear_task_watch_attention_deferral(
        &mut self,
        source: crate::companion_core::TaskSource,
        state: yuanyuan_protocol::TaskState,
    ) -> AppResult<bool> {
        let state_name = task_watch_state_name(state)
            .ok_or_else(|| AppError::Validation("task watch state cannot be deferred".into()))?;
        Ok(self.conn.execute(
            "DELETE FROM task_watch_attention_deferrals
             WHERE source = ?1 AND state = ?2",
            params![task_watch_source_name(source), state_name],
        )? > 0)
    }

    #[cfg(windows)]
    pub fn observe_terminal_attention_budget(
        &mut self,
        observations: &[crate::companion_attention::TerminalObservation],
        now_unix_ms: i64,
        suppress_presentation: bool,
    ) -> AppResult<Option<crate::companion_attention::TerminalSummary>> {
        use crate::companion_attention::{
            parse_task_outcome, parse_task_source, task_outcome_name, task_source_name,
            AttentionBudgetRecord,
        };

        if now_unix_ms < 0 {
            return Err(AppError::Validation(
                "companion attention clock is invalid".into(),
            ));
        }
        let transaction = self
            .conn
            .transaction_with_behavior(TransactionBehavior::Deferred)?;
        let raw = transaction.query_row(
            "SELECT
                last_observed_terminal_at_unix_ms,
                deferred_count, deferred_source, deferred_outcome,
                deferred_latest_at_unix_ms,
                visible_count, visible_source, visible_outcome,
                visible_until_unix_ms, last_summary_shown_at_unix_ms
             FROM companion_attention_budget WHERE id = 1",
            [],
            |row| {
                Ok((
                    row.get::<_, i64>(0)?,
                    row.get::<_, i64>(1)?,
                    row.get::<_, Option<String>>(2)?,
                    row.get::<_, Option<String>>(3)?,
                    row.get::<_, Option<i64>>(4)?,
                    row.get::<_, i64>(5)?,
                    row.get::<_, Option<String>>(6)?,
                    row.get::<_, Option<String>>(7)?,
                    row.get::<_, Option<i64>>(8)?,
                    row.get::<_, Option<i64>>(9)?,
                ))
            },
        )?;
        let mut record = AttentionBudgetRecord {
            last_observed_terminal_at_unix_ms: raw.0,
            deferred_count: u16::try_from(raw.1)
                .map_err(|_| AppError::Validation("companion attention state is invalid".into()))?,
            deferred_source: raw.2.as_deref().and_then(parse_task_source),
            deferred_outcome: raw.3.as_deref().and_then(parse_task_outcome),
            deferred_latest_at_unix_ms: raw.4,
            visible_count: u16::try_from(raw.5)
                .map_err(|_| AppError::Validation("companion attention state is invalid".into()))?,
            visible_source: raw.6.as_deref().and_then(parse_task_source),
            visible_outcome: raw.7.as_deref().and_then(parse_task_outcome),
            visible_until_unix_ms: raw.8,
            last_summary_shown_at_unix_ms: raw.9,
        };
        if !record.is_valid()
            || (raw.2.is_some() != record.deferred_source.is_some())
            || (raw.3.is_some() != record.deferred_outcome.is_some())
            || (raw.6.is_some() != record.visible_source.is_some())
            || (raw.7.is_some() != record.visible_outcome.is_some())
        {
            return Err(AppError::Validation(
                "companion attention state is invalid".into(),
            ));
        }

        let original = record.clone();
        let summary =
            record.observe_terminal_summaries(observations, now_unix_ms, suppress_presentation);
        if !record.is_valid() {
            return Err(AppError::Validation(
                "companion attention state is invalid".into(),
            ));
        }
        if record == original {
            return Ok(summary);
        }
        let updated = transaction.execute(
            "UPDATE companion_attention_budget SET
                last_observed_terminal_at_unix_ms = ?1,
                deferred_count = ?2,
                deferred_source = ?3,
                deferred_outcome = ?4,
                deferred_latest_at_unix_ms = ?5,
                visible_count = ?6,
                visible_source = ?7,
                visible_outcome = ?8,
                visible_until_unix_ms = ?9,
                last_summary_shown_at_unix_ms = ?10,
                updated_at_unix_ms = ?11
             WHERE id = 1 AND schema_version = 1",
            params![
                record.last_observed_terminal_at_unix_ms,
                i64::from(record.deferred_count),
                record.deferred_source.map(task_source_name),
                record.deferred_outcome.map(task_outcome_name),
                record.deferred_latest_at_unix_ms,
                i64::from(record.visible_count),
                record.visible_source.map(task_source_name),
                record.visible_outcome.map(task_outcome_name),
                record.visible_until_unix_ms,
                record.last_summary_shown_at_unix_ms,
                now_unix_ms,
            ],
        )?;
        if updated != 1 {
            return Err(AppError::Validation(
                "companion attention state is unavailable".into(),
            ));
        }
        transaction.commit()?;
        Ok(summary)
    }

    #[cfg(windows)]
    pub fn try_consume_proactive_attention(
        &mut self,
        kind: &str,
        intensity: &str,
        now_unix_ms: i64,
        local_day: &str,
    ) -> AppResult<bool> {
        if !matches!(kind, "focus_finished" | "reunion") {
            return Err(AppError::Validation(
                "unsupported proactive companion event".into(),
            ));
        }
        let (daily_limit, hourly_limit) = match intensity {
            "quiet" => return Ok(false),
            "everyday" => (3_i64, 1_i64),
            "close" => (6_i64, 2_i64),
            _ => {
                return Err(AppError::Validation("invalid companion intensity".into()));
            }
        };
        if now_unix_ms < 0 || NaiveDate::parse_from_str(local_day, "%Y-%m-%d").is_err() {
            return Err(AppError::Validation(
                "proactive companion clock is invalid".into(),
            ));
        }

        let transaction = self
            .conn
            .transaction_with_behavior(TransactionBehavior::Immediate)?;
        let shown_today: i64 = transaction.query_row(
            "SELECT COUNT(*) FROM companion_proactive_attention
             WHERE local_day = ?1 AND shown_at_unix_ms <= ?2",
            params![local_day, now_unix_ms],
            |row| row.get(0),
        )?;
        let rolling_hour_start = now_unix_ms.saturating_sub(60 * 60 * 1_000);
        let shown_last_hour: i64 = transaction.query_row(
            "SELECT COUNT(*) FROM companion_proactive_attention
             WHERE shown_at_unix_ms > ?1 AND shown_at_unix_ms <= ?2",
            params![rolling_hour_start, now_unix_ms],
            |row| row.get(0),
        )?;
        if shown_today >= daily_limit || shown_last_hour >= hourly_limit {
            return Ok(false);
        }

        transaction.execute(
            "DELETE FROM companion_proactive_attention WHERE shown_at_unix_ms < ?1",
            [now_unix_ms.saturating_sub(8 * 24 * 60 * 60 * 1_000)],
        )?;
        let inserted = transaction.execute(
            "INSERT INTO companion_proactive_attention(kind, shown_at_unix_ms, local_day)
             VALUES(?1, ?2, ?3)",
            params![kind, now_unix_ms, local_day],
        )?;
        if inserted != 1 {
            return Err(AppError::Validation(
                "proactive companion budget is unavailable".into(),
            ));
        }
        transaction.commit()?;
        Ok(true)
    }

    #[cfg(feature = "learning")]
    pub(crate) fn try_claim_learning_attention(
        &mut self,
        intensity: &str,
        now_unix_ms: i64,
        local_day: &str,
    ) -> AppResult<Option<LearningAttentionClaim>> {
        let (daily_limit, hourly_limit) = match intensity {
            "quiet" => return Ok(None),
            "everyday" => (3_i64, 1_i64),
            "close" => (6_i64, 2_i64),
            _ => {
                return Err(AppError::Validation("invalid companion intensity".into()));
            }
        };
        if now_unix_ms < 0 || NaiveDate::parse_from_str(local_day, "%Y-%m-%d").is_err() {
            return Err(AppError::Validation(
                "learning attention clock is invalid".into(),
            ));
        }
        let transaction = self
            .conn
            .transaction_with_behavior(TransactionBehavior::Immediate)?;
        let shown_today: i64 = transaction.query_row(
            "SELECT COUNT(*) FROM companion_proactive_attention
             WHERE local_day = ?1 AND shown_at_unix_ms <= ?2",
            params![local_day, now_unix_ms],
            |row| row.get(0),
        )?;
        let rolling_hour_start = now_unix_ms.saturating_sub(60 * 60 * 1_000);
        let shown_last_hour: i64 = transaction.query_row(
            "SELECT COUNT(*) FROM companion_proactive_attention
             WHERE shown_at_unix_ms > ?1 AND shown_at_unix_ms <= ?2",
            params![rolling_hour_start, now_unix_ms],
            |row| row.get(0),
        )?;
        if shown_today >= daily_limit || shown_last_hour >= hourly_limit {
            return Ok(None);
        }
        transaction.execute(
            "DELETE FROM companion_proactive_attention WHERE shown_at_unix_ms < ?1",
            [now_unix_ms.saturating_sub(8 * 24 * 60 * 60 * 1_000)],
        )?;
        transaction.execute(
            "INSERT INTO companion_proactive_attention(kind, shown_at_unix_ms, local_day)
             VALUES('learning_invitation', ?1, ?2)",
            params![now_unix_ms, local_day],
        )?;
        let row_id = transaction.last_insert_rowid();
        transaction.commit()?;
        Ok(Some(LearningAttentionClaim {
            row_id,
            claim_id: Uuid::new_v4(),
        }))
    }

    #[cfg(feature = "learning")]
    pub(crate) fn release_unpresented_learning_attention(
        &mut self,
        claim: &LearningAttentionClaim,
    ) -> AppResult<bool> {
        let deleted = self.conn.execute(
            "DELETE FROM companion_proactive_attention
             WHERE id = ?1 AND kind = 'learning_invitation'",
            [claim.row_id],
        )?;
        Ok(deleted == 1)
    }

    pub fn mark_overdue(&self) -> AppResult<()> {
        self.conn.execute(
            "UPDATE occurrences SET status = 'overdue'
             WHERE status = 'pending' AND scheduled_at < ?1",
            [Utc::now().to_rfc3339()],
        )?;
        Ok(())
    }
}

fn apply_migrations(connection: &Connection) -> AppResult<()> {
    let schema_version: u32 = connection.query_row("PRAGMA user_version", [], |row| row.get(0))?;
    let maximum_schema_version = if cfg!(feature = "learning") { 12 } else { 11 };
    if schema_version > maximum_schema_version {
        return Err(AppError::Validation(format!(
            "database schema version {schema_version} is newer than supported version {maximum_schema_version}"
        )));
    }
    if schema_version < 1 {
        execute_migration(connection, include_str!("../migrations/001_initial.sql"))?;
    }
    if schema_version < 2 {
        execute_migration(
            connection,
            include_str!("../migrations/002_focus_sessions.sql"),
        )?;
    }
    if schema_version < 3 {
        execute_migration(
            connection,
            include_str!("../migrations/003_pet_interactions.sql"),
        )?;
    }
    if schema_version < 4 {
        execute_migration(
            connection,
            include_str!("../migrations/004_ball_interaction.sql"),
        )?;
    }
    if schema_version < 5 {
        execute_migration(
            connection,
            include_str!("../migrations/005_occurrence_history.sql"),
        )?;
    }
    if schema_version < 6 {
        execute_migration(
            connection,
            include_str!("../migrations/006_activity_tracking.sql"),
        )?;
    }
    if schema_version < 7 {
        execute_migration(
            connection,
            include_str!("../migrations/007_reminder_management.sql"),
        )?;
    }
    if schema_version < 8 {
        execute_migration(
            connection,
            include_str!("../migrations/008_companion_attention_budget.sql"),
        )?;
    }
    if schema_version < 9 {
        execute_migration(
            connection,
            include_str!("../migrations/009_companion_proactive_attention.sql"),
        )?;
    }
    if schema_version < 10 {
        execute_migration(
            connection,
            include_str!("../migrations/010_companion_reunion_attention.sql"),
        )?;
    }
    if schema_version < 11 {
        execute_migration(
            connection,
            include_str!("../migrations/011_task_watch_attention_deferrals.sql"),
        )?;
    }
    #[cfg(feature = "learning")]
    if schema_version < 12 {
        execute_migration(
            connection,
            include_str!("../migrations/012_learning_invitation_attention.sql"),
        )?;
    }
    Ok(())
}

fn execute_migration(connection: &Connection, sql: &str) -> AppResult<()> {
    if let Err(error) = connection.execute_batch(sql) {
        // Several historical migration files own their BEGIN/COMMIT boundary. SQLite
        // leaves that transaction open when a statement in execute_batch fails. A
        // subsequent safety restore on the same connection would otherwise appear to
        // succeed while still exposing the half-migrated schema.
        if !connection.is_autocommit() {
            let _ = connection.execute_batch("ROLLBACK");
        }
        return Err(error.into());
    }
    Ok(())
}

fn validate_backup_database(path: &Path) -> AppResult<()> {
    if !path.is_file() {
        return Err(AppError::Validation("backup file does not exist".into()));
    }
    let connection = Connection::open_with_flags(path, OpenFlags::SQLITE_OPEN_READ_ONLY)?;
    validate_connection(&connection)
}

fn validate_connection(connection: &Connection) -> AppResult<()> {
    let integrity: String = connection.query_row("PRAGMA quick_check", [], |row| row.get(0))?;
    if integrity != "ok" {
        return Err(AppError::Validation(format!(
            "backup integrity check failed: {integrity}"
        )));
    }
    let schema_version: u32 = connection.query_row("PRAGMA user_version", [], |row| row.get(0))?;
    let maximum_schema_version = if cfg!(feature = "learning") { 12 } else { 11 };
    if !(1..=maximum_schema_version).contains(&schema_version) {
        return Err(AppError::Validation(format!(
            "unsupported backup schema version {schema_version}"
        )));
    }
    for table in ["settings", "reminders", "occurrences"] {
        let exists: bool = connection.query_row(
            "SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?1)",
            [table],
            |row| row.get(0),
        )?;
        if !exists {
            return Err(AppError::Validation(format!(
                "backup is missing required table {table}"
            )));
        }
    }
    Ok(())
}

#[cfg(windows)]
fn task_watch_source_name(source: crate::companion_core::TaskSource) -> &'static str {
    match source {
        crate::companion_core::TaskSource::Codex => "codex",
        crate::companion_core::TaskSource::ClaudeCode => "claude_code",
    }
}

#[cfg(windows)]
fn parse_task_watch_source(value: &str) -> Option<crate::companion_core::TaskSource> {
    match value {
        "codex" => Some(crate::companion_core::TaskSource::Codex),
        "claude_code" => Some(crate::companion_core::TaskSource::ClaudeCode),
        _ => None,
    }
}

#[cfg(windows)]
fn task_watch_state_name(state: yuanyuan_protocol::TaskState) -> Option<&'static str> {
    match state {
        yuanyuan_protocol::TaskState::Running => Some("running"),
        yuanyuan_protocol::TaskState::WaitingUser => Some("waiting_user"),
        yuanyuan_protocol::TaskState::Failed => Some("failed"),
        yuanyuan_protocol::TaskState::Stalled => Some("stalled"),
        yuanyuan_protocol::TaskState::Unknown => Some("unknown"),
        _ => None,
    }
}

#[cfg(windows)]
fn parse_task_watch_state(value: &str) -> Option<yuanyuan_protocol::TaskState> {
    match value {
        "running" => Some(yuanyuan_protocol::TaskState::Running),
        "waiting_user" => Some(yuanyuan_protocol::TaskState::WaitingUser),
        "failed" => Some(yuanyuan_protocol::TaskState::Failed),
        "stalled" => Some(yuanyuan_protocol::TaskState::Stalled),
        "unknown" => Some(yuanyuan_protocol::TaskState::Unknown),
        _ => None,
    }
}

fn resolve_active_occurrences(
    connection: &Connection,
    reminder_id: &str,
    acted_at: &str,
    reason: &str,
) -> AppResult<()> {
    connection.execute(
        "UPDATE occurrences
         SET status = 'skipped', acted_at = ?1, snoozed_until = NULL,
             notification_id = NULL, resolution_reason = ?2
         WHERE reminder_id = ?3
           AND status IN ('pending', 'overdue', 'snoozed')",
        params![acted_at, reason, reminder_id],
    )?;
    Ok(())
}

fn reminder_from_row(row: &Row<'_>) -> rusqlite::Result<Reminder> {
    Ok(Reminder {
        id: row.get(0)?,
        title: row.get(1)?,
        category: row.get(2)?,
        schedule_kind: row.get(3)?,
        schedule_json: row.get(4)?,
        timezone: row.get(5)?,
        enabled: row.get(6)?,
        next_due_at: row.get(7)?,
        created_at: row.get(8)?,
        updated_at: row.get(9)?,
        archived_at: row.get(10)?,
        system_kind: row.get(11)?,
    })
}

fn occurrence_from_row(row: &Row<'_>) -> rusqlite::Result<Occurrence> {
    Ok(Occurrence {
        id: row.get(0)?,
        reminder_id: row.get(1)?,
        reminder_title: row.get(2)?,
        category: row.get(3)?,
        scheduled_at: row.get(4)?,
        status: row.get(5)?,
        acted_at: row.get(6)?,
        snoozed_until: row.get(7)?,
        resolution_reason: row.get(8)?,
    })
}

fn focus_session_from_row(row: &Row<'_>) -> rusqlite::Result<FocusSession> {
    Ok(FocusSession {
        id: row.get(0)?,
        phase: row.get(1)?,
        status: row.get(2)?,
        duration_minutes: row.get(3)?,
        started_at: row.get(4)?,
        ends_at: row.get(5)?,
        completed_at: row.get(6)?,
    })
}

fn validate_input(input: &CreateReminderInput) -> AppResult<()> {
    if input.title.trim().is_empty() || input.title.chars().count() > 120 {
        return Err(AppError::Validation(
            "title must contain between 1 and 120 characters".into(),
        ));
    }
    if !["water", "work", "personal"].contains(&input.category.as_str()) {
        return Err(AppError::Validation("unsupported reminder category".into()));
    }
    if !["once", "interval", "daily", "weekly"].contains(&input.schedule_kind.as_str()) {
        return Err(AppError::Validation("unsupported schedule kind".into()));
    }
    if input.schedule_kind == "interval"
        && !(15..=240).contains(&input.every_minutes.unwrap_or_default())
    {
        return Err(AppError::Validation(
            "interval must be between 15 and 240 minutes".into(),
        ));
    }
    match input.schedule_kind.as_str() {
        "once" | "daily" | "weekly" => {
            parse_local_datetime(input.at_local.as_deref().ok_or_else(|| {
                AppError::Validation("scheduled reminders require atLocal".into())
            })?)?;
        }
        "interval" => {
            parse_time(input.active_start_local.as_deref().unwrap_or("09:00"))?;
            parse_time(input.active_end_local.as_deref().unwrap_or("18:00"))?;
        }
        _ => {}
    }
    if input.schedule_kind != "once" {
        let weekdays = input.weekdays.as_deref().unwrap_or(&[]);
        if weekdays.is_empty() || weekdays.iter().any(|day| *day > 6) {
            return Err(AppError::Validation(
                "recurring reminders require valid weekdays".into(),
            ));
        }
    }
    Ok(())
}

fn validate_settings(settings: &AppSettings) -> AppResult<()> {
    if !["always", "system", "off"].contains(&settings.animation_mode.as_str()) {
        return Err(AppError::Validation("invalid animation mode".into()));
    }
    if !["quiet", "everyday", "close"].contains(&settings.companion_intensity.as_str()) {
        return Err(AppError::Validation("invalid companion intensity".into()));
    }
    if !["motion_only", "adaptive", "always"].contains(&settings.companion_label_mode.as_str()) {
        return Err(AppError::Validation("invalid companion label mode".into()));
    }
    if !(0.4..=2.0).contains(&settings.animation_speed) {
        return Err(AppError::Validation(
            "animation speed is outside range".into(),
        ));
    }
    if !(120..=320).contains(&settings.pet_width) {
        return Err(AppError::Validation("pet width is outside range".into()));
    }
    parse_time(&settings.quiet_start)?;
    parse_time(&settings.quiet_end)?;
    parse_time(&settings.water_start)?;
    parse_time(&settings.water_end)?;
    parse_time(&settings.activity_start)?;
    parse_time(&settings.activity_end)?;
    if !(1..=240).contains(&settings.idle_sleep_minutes) {
        return Err(AppError::Validation(
            "idle sleep minutes are outside range".into(),
        ));
    }
    if !(15..=240).contains(&settings.water_interval_minutes) {
        return Err(AppError::Validation(
            "water interval is outside range".into(),
        ));
    }
    if !(15..=240).contains(&settings.activity_interval_minutes) {
        return Err(AppError::Validation(
            "activity interval is outside range".into(),
        ));
    }
    if !["notify", "skipOld"].contains(&settings.missed_reminder_policy.as_str()) {
        return Err(AppError::Validation(
            "invalid missed reminder policy".into(),
        ));
    }
    if !(15..=240).contains(&settings.missed_reminder_grace_minutes) {
        return Err(AppError::Validation(
            "missed reminder grace period is outside range".into(),
        ));
    }
    Ok(())
}

pub fn compute_next_due(
    input: &CreateReminderInput,
    after: DateTime<Utc>,
    initial: bool,
) -> AppResult<Option<DateTime<Utc>>> {
    let local_after = after.with_timezone(&Local);
    match input.schedule_kind.as_str() {
        "once" => {
            if !initial {
                return Ok(None);
            }
            let local =
                parse_local_datetime(input.at_local.as_deref().ok_or_else(|| {
                    AppError::Validation("once schedule requires atLocal".into())
                })?)?;
            Ok(Some(local.with_timezone(&Utc)))
        }
        "interval" => {
            let minutes = i64::from(input.every_minutes.unwrap_or(60).clamp(15, 240));
            let start = parse_time(input.active_start_local.as_deref().unwrap_or("09:00"))?;
            let end = parse_time(input.active_end_local.as_deref().unwrap_or("18:00"))?;
            let weekdays = input
                .weekdays
                .clone()
                .unwrap_or_else(|| vec![0, 1, 2, 3, 4, 5, 6]);
            let candidate = local_after + Duration::minutes(minutes);
            Ok(Some(
                normalize_to_active_window(candidate, start, end, &weekdays)?.with_timezone(&Utc),
            ))
        }
        "daily" | "weekly" => {
            let raw = input
                .at_local
                .as_deref()
                .ok_or_else(|| AppError::Validation("daily schedule requires atLocal".into()))?;
            let parsed = NaiveDateTime::parse_from_str(raw, "%Y-%m-%dT%H:%M")
                .map_err(|error| AppError::Time(error.to_string()))?;
            let time = parsed.time();
            let weekdays = if input.schedule_kind == "weekly" {
                input
                    .weekdays
                    .clone()
                    .unwrap_or_else(|| vec![1, 2, 3, 4, 5])
            } else {
                input
                    .weekdays
                    .clone()
                    .unwrap_or_else(|| vec![0, 1, 2, 3, 4, 5, 6])
            };
            for day_offset in 0..=14 {
                let date = local_after.date_naive() + Duration::days(day_offset);
                if !weekdays.contains(&date.weekday().num_days_from_sunday()) {
                    continue;
                }
                let candidate = resolve_local(date.and_time(time))?;
                if candidate > local_after {
                    return Ok(Some(candidate.with_timezone(&Utc)));
                }
            }
            Err(AppError::Time(
                "could not resolve a matching day in the next two weeks".into(),
            ))
        }
        _ => Err(AppError::Validation("unsupported schedule kind".into())),
    }
}

fn normalize_to_active_window(
    mut candidate: DateTime<Local>,
    start: NaiveTime,
    end: NaiveTime,
    weekdays: &[u32],
) -> AppResult<DateTime<Local>> {
    for _ in 0..=14 {
        let date = candidate.date_naive();
        let weekday_ok = weekdays.contains(&date.weekday().num_days_from_sunday());
        let time = candidate.time();
        let active = if end >= start {
            time >= start && time <= end
        } else {
            time >= start || time <= end
        };
        if weekday_ok && active {
            return Ok(candidate);
        }
        let next_date = date + Duration::days(1);
        candidate = resolve_local(next_date.and_time(start))?;
    }
    Err(AppError::Time(
        "could not find the next active interval window".into(),
    ))
}

fn parse_local_datetime(value: &str) -> AppResult<DateTime<Local>> {
    let naive = NaiveDateTime::parse_from_str(value, "%Y-%m-%dT%H:%M")
        .map_err(|error| AppError::Time(error.to_string()))?;
    resolve_local(naive)
}

fn resolve_local(naive: NaiveDateTime) -> AppResult<DateTime<Local>> {
    match Local.from_local_datetime(&naive) {
        LocalResult::Single(value) => Ok(value),
        LocalResult::Ambiguous(first, _) => Ok(first),
        LocalResult::None => Err(AppError::Time(format!(
            "local time does not exist: {naive}"
        ))),
    }
}

fn local_day_utc_bounds(now: DateTime<Local>) -> AppResult<(String, String)> {
    let date = now.date_naive();
    let start = resolve_local(
        date.and_hms_opt(0, 0, 0)
            .ok_or_else(|| AppError::Time("could not resolve local day start".into()))?,
    )?;
    let next = resolve_local(
        (date + Duration::days(1))
            .and_hms_opt(0, 0, 0)
            .ok_or_else(|| AppError::Time("could not resolve next local day start".into()))?,
    )?;
    Ok((
        start.with_timezone(&Utc).to_rfc3339(),
        next.with_timezone(&Utc).to_rfc3339(),
    ))
}

fn parse_time(value: &str) -> AppResult<NaiveTime> {
    NaiveTime::parse_from_str(value, "%H:%M").map_err(|error| AppError::Time(error.to_string()))
}

#[cfg(test)]
mod tests {
    use chrono::TimeZone;

    use super::*;

    fn apply_main_migrations_through_v6(connection: &Connection) {
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
    }

    #[cfg(feature = "learning")]
    fn apply_main_migrations_through_v11(connection: &Connection) {
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
        ] {
            connection.execute_batch(migration).unwrap();
        }
    }

    #[test]
    fn stable_database_has_no_basic_support_or_emotion_history_table() {
        let path = std::env::temp_dir().join(format!(
            "yuanyuan-reminder-no-support-history-{}.sqlite3",
            Uuid::new_v4()
        ));
        let repository = Repository::open(&path).unwrap();
        let table_count: i64 = repository
            .conn
            .query_row(
                "SELECT COUNT(*) FROM sqlite_master WHERE type = 'table' AND (name LIKE '%support%' OR name LIKE '%emotion%' OR name LIKE '%mood%')",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(table_count, 0);
        drop(repository);
        let _ = std::fs::remove_file(&path);
        let _ = std::fs::remove_file(path.with_extension("sqlite3-wal"));
        let _ = std::fs::remove_file(path.with_extension("sqlite3-shm"));
    }

    #[test]
    fn unified_migration_matrix_stable_v1_3_2_schema_six_upgrades_in_place() {
        let path = std::env::temp_dir().join(format!(
            "yuanyuan-reminder-v1-3-2-upgrade-{}.sqlite3",
            Uuid::new_v4()
        ));
        let connection = Connection::open(&path).unwrap();
        apply_main_migrations_through_v6(&connection);
        connection
            .execute(
                "INSERT INTO reminders(
                    id, title, category, schedule_kind, schedule_json, timezone,
                    enabled, next_due_at, last_fired_at, created_at, updated_at
                 ) VALUES(
                    'v1-3-2-sentinel', '保留的旧提醒', 'work', 'once',
                    '{\"title\":\"保留的旧提醒\",\"category\":\"work\",\"scheduleKind\":\"once\",\"atLocal\":\"2035-01-01T09:00\"}',
                    'Asia/Shanghai', 1, '2035-01-01T01:00:00Z', NULL,
                    '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z'
                 )",
                [],
            )
            .unwrap();
        drop(connection);

        let repository = Repository::open(&path).unwrap();
        let version: u32 = repository
            .conn
            .query_row("PRAGMA user_version", [], |row| row.get(0))
            .unwrap();
        assert_eq!(version, if cfg!(feature = "learning") { 12 } else { 11 });
        let reminder = repository.get_reminder("v1-3-2-sentinel").unwrap().unwrap();
        assert_eq!(reminder.title, "保留的旧提醒");
        assert!(reminder.archived_at.is_none());
        assert!(reminder.system_kind.is_none());
        repository.get_settings().unwrap();
        repository.list_today(false).unwrap();

        drop(repository);
        let _ = std::fs::remove_file(&path);
        let _ = std::fs::remove_file(path.with_extension("sqlite3-wal"));
        let _ = std::fs::remove_file(path.with_extension("sqlite3-shm"));
    }

    #[test]
    fn unified_migration_matrix_local_v1_4_schema_eleven_upgrades_in_place() {
        let path = std::env::temp_dir().join(format!(
            "yuanyuan-reminder-v1-4-upgrade-{}.sqlite3",
            Uuid::new_v4()
        ));
        let connection = Connection::open(&path).unwrap();
        #[cfg(feature = "learning")]
        apply_main_migrations_through_v11(&connection);
        #[cfg(not(feature = "learning"))]
        {
            apply_main_migrations_through_v6(&connection);
            for migration in [
                include_str!("../migrations/007_reminder_management.sql"),
                include_str!("../migrations/008_companion_attention_budget.sql"),
                include_str!("../migrations/009_companion_proactive_attention.sql"),
                include_str!("../migrations/010_companion_reunion_attention.sql"),
                include_str!("../migrations/011_task_watch_attention_deferrals.sql"),
            ] {
                connection.execute_batch(migration).unwrap();
            }
        }
        connection
            .execute(
                "INSERT INTO reminders(
                    id, title, category, schedule_kind, schedule_json, timezone,
                    enabled, next_due_at, last_fired_at, created_at, updated_at,
                    archived_at, system_kind
                 ) VALUES(
                    'v1-4-sentinel', '本地 1.4 提醒', 'personal', 'once',
                    '{\"title\":\"本地 1.4 提醒\",\"category\":\"personal\",\"scheduleKind\":\"once\",\"atLocal\":\"2035-02-01T09:00\"}',
                    'Asia/Shanghai', 1, '2035-02-01T01:00:00Z', NULL,
                    '2026-02-01T00:00:00Z', '2026-02-01T00:00:00Z', NULL, NULL
                 )",
                [],
            )
            .unwrap();
        drop(connection);

        let repository = Repository::open(&path).unwrap();
        let version: u32 = repository
            .conn
            .query_row("PRAGMA user_version", [], |row| row.get(0))
            .unwrap();
        assert_eq!(version, if cfg!(feature = "learning") { 12 } else { 11 });
        assert_eq!(
            repository
                .get_reminder("v1-4-sentinel")
                .unwrap()
                .unwrap()
                .title,
            "本地 1.4 提醒"
        );
        repository.get_settings().unwrap();
        repository.list_today(false).unwrap();

        drop(repository);
        let _ = std::fs::remove_file(&path);
        let _ = std::fs::remove_file(path.with_extension("sqlite3-wal"));
        let _ = std::fs::remove_file(path.with_extension("sqlite3-shm"));
    }

    #[test]
    fn once_schedule_stops_after_firing() {
        let input = CreateReminderInput {
            title: "test".into(),
            category: "work".into(),
            schedule_kind: "once".into(),
            at_local: Some("2030-01-01T09:30".into()),
            every_minutes: None,
            active_start_local: None,
            active_end_local: None,
            weekdays: None,
        };
        let after = Utc.with_ymd_and_hms(2029, 1, 1, 0, 0, 0).unwrap();
        assert!(compute_next_due(&input, after, true).unwrap().is_some());
        assert!(compute_next_due(&input, after, false).unwrap().is_none());
    }

    #[test]
    fn rejects_too_short_interval() {
        let input = CreateReminderInput {
            title: "test".into(),
            category: "water".into(),
            schedule_kind: "interval".into(),
            at_local: None,
            every_minutes: Some(5),
            active_start_local: None,
            active_end_local: None,
            weekdays: None,
        };
        assert!(validate_input(&input).is_err());
    }

    #[test]
    fn interval_schedule_waits_for_the_configured_interval() {
        let input = CreateReminderInput {
            title: "water".into(),
            category: "water".into(),
            schedule_kind: "interval".into(),
            at_local: None,
            every_minutes: Some(60),
            active_start_local: Some("00:00".into()),
            active_end_local: Some("23:59".into()),
            weekdays: Some(vec![0, 1, 2, 3, 4, 5, 6]),
        };
        let after = Utc.with_ymd_and_hms(2030, 1, 1, 1, 0, 0).unwrap();
        let next = compute_next_due(&input, after, true).unwrap().unwrap();
        assert_eq!(next - after, Duration::minutes(60));
    }

    #[test]
    fn today_uses_local_midnight_boundaries() {
        let path = std::env::temp_dir().join(format!(
            "yuanyuan-reminder-local-day-{}.sqlite3",
            Uuid::new_v4()
        ));
        let repository = Repository::open(&path).unwrap();
        let (start, next) = local_day_utc_bounds(Local::now()).unwrap();
        let start = DateTime::parse_from_rfc3339(&start)
            .unwrap()
            .with_timezone(&Utc);
        let next = DateTime::parse_from_rfc3339(&next)
            .unwrap()
            .with_timezone(&Utc);
        for timestamp in [
            start - Duration::seconds(1),
            start + Duration::seconds(1),
            next - Duration::seconds(1),
        ] {
            repository
                .conn
                .execute(
                    "INSERT INTO water_log(id, completed_at) VALUES(?1, ?2)",
                    params![Uuid::new_v4().to_string(), timestamp.to_rfc3339()],
                )
                .unwrap();
        }
        assert_eq!(repository.list_today(false).unwrap().water_completed, 2);
        drop(repository);
        let _ = std::fs::remove_file(&path);
        let _ = std::fs::remove_file(path.with_extension("sqlite3-wal"));
        let _ = std::fs::remove_file(path.with_extension("sqlite3-shm"));
    }

    #[test]
    fn water_settings_update_the_default_water_schedule() {
        let path = std::env::temp_dir().join(format!(
            "yuanyuan-reminder-settings-{}.sqlite3",
            Uuid::new_v4()
        ));
        let repository = Repository::open(&path).unwrap();
        repository
            .update_settings(serde_json::json!({
                "waterStart": "08:15",
                "waterEnd": "17:45",
                "waterIntervalMinutes": 45
            }))
            .unwrap();
        let schedule_json: String = repository
            .conn
            .query_row(
                "SELECT schedule_json FROM reminders WHERE category = 'water' ORDER BY created_at LIMIT 1",
                [],
                |row| row.get(0),
            )
            .unwrap();
        let input: CreateReminderInput = serde_json::from_str(&schedule_json).unwrap();
        assert_eq!(input.every_minutes, Some(45));
        assert_eq!(input.active_start_local.as_deref(), Some("08:15"));
        assert_eq!(input.active_end_local.as_deref(), Some("17:45"));
        drop(repository);
        let _ = std::fs::remove_file(&path);
        let _ = std::fs::remove_file(path.with_extension("sqlite3-wal"));
        let _ = std::fs::remove_file(path.with_extension("sqlite3-shm"));
    }

    #[test]
    fn companion_label_mode_is_validated_and_persisted() {
        let path = std::env::temp_dir().join(format!(
            "yuanyuan-reminder-label-mode-{}.sqlite3",
            Uuid::new_v4()
        ));
        let repository = Repository::open(&path).unwrap();

        let error = repository
            .update_settings(serde_json::json!({
                "companionLabelMode": "future-mode"
            }))
            .unwrap_err();
        assert!(error.to_string().contains("invalid companion label mode"));
        assert_eq!(
            repository.get_settings().unwrap().companion_label_mode,
            "adaptive"
        );

        let updated = repository
            .update_settings(serde_json::json!({
                "companionLabelMode": "always"
            }))
            .unwrap();
        assert_eq!(updated.companion_label_mode, "always");
        assert_eq!(
            repository.get_settings().unwrap().companion_label_mode,
            "always"
        );

        drop(repository);
        let _ = std::fs::remove_file(&path);
        let _ = std::fs::remove_file(path.with_extension("sqlite3-wal"));
        let _ = std::fs::remove_file(path.with_extension("sqlite3-shm"));
    }

    #[test]
    fn learning_quick_start_visibility_is_persisted() {
        let path = std::env::temp_dir().join(format!(
            "yuanyuan-reminder-learning-quick-start-{}.sqlite3",
            Uuid::new_v4()
        ));
        let repository = Repository::open(&path).unwrap();

        assert!(
            repository
                .get_settings()
                .unwrap()
                .learning_quick_start_visible
        );
        let updated = repository
            .update_settings(serde_json::json!({
                "learningQuickStartVisible": false
            }))
            .unwrap();
        assert!(!updated.learning_quick_start_visible);

        drop(repository);
        let reopened = Repository::open(&path).unwrap();
        assert!(
            !reopened
                .get_settings()
                .unwrap()
                .learning_quick_start_visible
        );

        drop(reopened);
        let _ = std::fs::remove_file(&path);
        let _ = std::fs::remove_file(path.with_extension("sqlite3-wal"));
        let _ = std::fs::remove_file(path.with_extension("sqlite3-shm"));
    }

    #[test]
    fn focus_session_replaces_and_cancels_the_active_timer() {
        let path = std::env::temp_dir().join(format!(
            "yuanyuan-reminder-focus-{}.sqlite3",
            Uuid::new_v4()
        ));
        let repository = Repository::open(&path).unwrap();
        let first = repository.start_focus("focus", 25).unwrap();
        assert_eq!(first.session.as_ref().unwrap().phase, "focus");
        let second = repository.start_focus("break", 5).unwrap();
        assert_eq!(second.session.as_ref().unwrap().phase, "break");
        assert_eq!(
            repository.get_focus_state().unwrap().session.unwrap().id,
            second.session.unwrap().id
        );
        assert!(repository.cancel_focus().unwrap().session.is_none());
        drop(repository);
        let _ = std::fs::remove_file(&path);
        let _ = std::fs::remove_file(path.with_extension("sqlite3-wal"));
        let _ = std::fs::remove_file(path.with_extension("sqlite3-shm"));
    }

    #[test]
    fn snoozed_occurrence_is_claimed_again_when_due() {
        let path = std::env::temp_dir().join(format!(
            "yuanyuan-reminder-snooze-{}.sqlite3",
            Uuid::new_v4()
        ));
        let mut repository = Repository::open(&path).unwrap();
        let reminder_id: String = repository
            .conn
            .query_row(
                "SELECT id FROM reminders WHERE category = 'water' LIMIT 1",
                [],
                |row| row.get(0),
            )
            .unwrap();
        let now = Utc::now();
        let occurrence_id = Uuid::new_v4().to_string();
        repository
            .conn
            .execute(
                "INSERT INTO occurrences(
                    id, reminder_id, scheduled_at, status, acted_at, snoozed_until, created_at
                 ) VALUES(?1, ?2, ?3, 'snoozed', ?4, ?5, ?4)",
                params![
                    occurrence_id,
                    reminder_id,
                    (now - Duration::minutes(11)).to_rfc3339(),
                    (now - Duration::minutes(10)).to_rfc3339(),
                    (now - Duration::seconds(1)).to_rfc3339(),
                ],
            )
            .unwrap();
        let claimed = repository.claim_due(now).unwrap();
        assert!(claimed
            .iter()
            .any(|item| item.occurrence.id == occurrence_id));
        assert_eq!(
            claimed
                .iter()
                .find(|item| item.occurrence.id == occurrence_id)
                .unwrap()
                .occurrence
                .status,
            "pending"
        );
        drop(repository);
        let _ = std::fs::remove_file(&path);
        let _ = std::fs::remove_file(path.with_extension("sqlite3-wal"));
        let _ = std::fs::remove_file(path.with_extension("sqlite3-shm"));
    }

    #[cfg(feature = "runtime-qa")]
    #[test]
    fn runtime_qa_due_override_records_the_actual_claim_time() {
        let path = std::env::temp_dir().join(format!(
            "yuanyuan-reminder-runtime-qa-latency-{}.sqlite3",
            Uuid::new_v4()
        ));
        let mut repository = Repository::open(&path).unwrap();
        let reminder = repository
            .create_reminder(CreateReminderInput {
                title: "运行验收事项".into(),
                category: "work".into(),
                schedule_kind: "once".into(),
                at_local: Some(
                    (Local::now() + Duration::hours(1))
                        .format("%Y-%m-%dT%H:%M")
                        .to_string(),
                ),
                every_minutes: None,
                active_start_local: None,
                active_end_local: None,
                weekdays: None,
            })
            .unwrap();
        let scheduled = Utc::now() - Duration::seconds(1);
        repository
            .set_runtime_qa_reminder_due(&reminder.id, scheduled)
            .unwrap();
        let claimed_at = Utc::now();
        let due = repository.claim_due(claimed_at).unwrap();
        assert_eq!(due.len(), 1);
        let (stored_scheduled, stored_claimed, status) = repository
            .runtime_qa_reminder_claim(&reminder.id)
            .unwrap()
            .unwrap();
        assert_eq!(status, "pending");
        assert_eq!(
            DateTime::parse_from_rfc3339(&stored_scheduled)
                .unwrap()
                .with_timezone(&Utc),
            scheduled
        );
        assert!(
            DateTime::parse_from_rfc3339(&stored_claimed)
                .unwrap()
                .with_timezone(&Utc)
                >= claimed_at
        );
        drop(repository);
        for candidate in [
            path.clone(),
            path.with_extension("sqlite3-wal"),
            path.with_extension("sqlite3-shm"),
        ] {
            let _ = fs::remove_file(candidate);
        }
    }

    #[test]
    fn due_water_reminder_does_not_stack_while_one_is_active() {
        let path = std::env::temp_dir().join(format!(
            "yuanyuan-reminder-no-water-stack-{}.sqlite3",
            Uuid::new_v4()
        ));
        let mut repository = Repository::open(&path).unwrap();
        let reminder_id: String = repository
            .conn
            .query_row(
                "SELECT id FROM reminders WHERE category = 'water' LIMIT 1",
                [],
                |row| row.get(0),
            )
            .unwrap();
        let now = Utc::now();
        repository
            .conn
            .execute(
                "UPDATE reminders SET enabled = 1, next_due_at = ?1 WHERE id = ?2",
                params![(now - Duration::minutes(1)).to_rfc3339(), reminder_id],
            )
            .unwrap();
        repository
            .conn
            .execute(
                "INSERT INTO occurrences(
                    id, reminder_id, scheduled_at, status, created_at
                 ) VALUES(?1, ?2, ?3, 'pending', ?3)",
                params![
                    Uuid::new_v4().to_string(),
                    reminder_id,
                    (now - Duration::minutes(20)).to_rfc3339()
                ],
            )
            .unwrap();

        let claimed = repository.claim_due(now).unwrap();
        assert!(claimed
            .iter()
            .all(|item| item.occurrence.category != "water"));
        let active_count: u32 = repository
            .conn
            .query_row(
                "SELECT COUNT(*) FROM occurrences
                 WHERE reminder_id = ?1
                   AND status IN ('pending', 'overdue', 'snoozed')",
                [&reminder_id],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(active_count, 1);

        drop(repository);
        let _ = std::fs::remove_file(&path);
        let _ = std::fs::remove_file(path.with_extension("sqlite3-wal"));
        let _ = std::fs::remove_file(path.with_extension("sqlite3-shm"));
    }

    #[test]
    fn recording_water_resolves_only_the_oldest_active_water_occurrence() {
        let path = std::env::temp_dir().join(format!(
            "yuanyuan-reminder-water-{}.sqlite3",
            Uuid::new_v4()
        ));
        let mut repository = Repository::open(&path).unwrap();
        let reminder_id: String = repository
            .conn
            .query_row(
                "SELECT id FROM reminders WHERE category = 'water' LIMIT 1",
                [],
                |row| row.get(0),
            )
            .unwrap();
        let oldest_id = Uuid::new_v4().to_string();
        let newest_id = Uuid::new_v4().to_string();
        let now = Utc::now();
        for (id, scheduled_at) in [(&oldest_id, now - Duration::minutes(10)), (&newest_id, now)] {
            repository
                .conn
                .execute(
                    "INSERT INTO occurrences(
                        id, reminder_id, scheduled_at, status, created_at
                     ) VALUES(?1, ?2, ?3, 'pending', ?3)",
                    params![id, reminder_id, scheduled_at.to_rfc3339()],
                )
                .unwrap();
        }
        repository.record_water().unwrap();
        let statuses: Vec<(String, String)> = repository
            .conn
            .prepare(
                "SELECT id, status FROM occurrences
                 WHERE id IN (?1, ?2) ORDER BY scheduled_at",
            )
            .unwrap()
            .query_map(params![oldest_id, newest_id], |row| {
                Ok((row.get(0)?, row.get(1)?))
            })
            .unwrap()
            .collect::<Result<Vec<_>, _>>()
            .unwrap();
        assert_eq!(statuses[0].1, "completed");
        assert_eq!(statuses[1].1, "pending");
        drop(repository);
        let _ = std::fs::remove_file(&path);
        let _ = std::fs::remove_file(path.with_extension("sqlite3-wal"));
        let _ = std::fs::remove_file(path.with_extension("sqlite3-shm"));
    }

    #[test]
    fn completing_a_water_occurrence_records_exactly_one_cup() {
        let path = std::env::temp_dir().join(format!(
            "yuanyuan-reminder-complete-water-{}.sqlite3",
            Uuid::new_v4()
        ));
        let mut repository = Repository::open(&path).unwrap();
        let reminder_id: String = repository
            .conn
            .query_row(
                "SELECT id FROM reminders WHERE category = 'water' LIMIT 1",
                [],
                |row| row.get(0),
            )
            .unwrap();
        let occurrence_id = Uuid::new_v4().to_string();
        let now = Utc::now().to_rfc3339();
        repository
            .conn
            .execute(
                "INSERT INTO occurrences(
                    id, reminder_id, scheduled_at, status, created_at
                 ) VALUES(?1, ?2, ?3, 'pending', ?3)",
                params![occurrence_id, reminder_id, now],
            )
            .unwrap();

        assert!(repository.complete_occurrence(&occurrence_id).unwrap());
        assert_eq!(repository.list_today(false).unwrap().water_completed, 1);
        assert!(!repository.complete_occurrence(&occurrence_id).unwrap());
        assert_eq!(repository.list_today(false).unwrap().water_completed, 1);

        drop(repository);
        let _ = std::fs::remove_file(&path);
        let _ = std::fs::remove_file(path.with_extension("sqlite3-wal"));
        let _ = std::fs::remove_file(path.with_extension("sqlite3-shm"));
    }

    #[test]
    fn migrates_legacy_brush_interactions_to_ball() {
        let path = std::env::temp_dir().join(format!(
            "yuanyuan-reminder-ball-migration-{}.sqlite3",
            Uuid::new_v4()
        ));
        let connection = Connection::open(&path).unwrap();
        connection
            .execute_batch(include_str!("../migrations/001_initial.sql"))
            .unwrap();
        connection
            .execute_batch(include_str!("../migrations/002_focus_sessions.sql"))
            .unwrap();
        connection
            .execute_batch(include_str!("../migrations/003_pet_interactions.sql"))
            .unwrap();
        connection
            .execute(
                "INSERT INTO pet_interactions(id, kind, created_at)
                 VALUES(?1, 'brush', ?2)",
                params![Uuid::new_v4().to_string(), Utc::now().to_rfc3339()],
            )
            .unwrap();
        drop(connection);

        let repository = Repository::open(&path).unwrap();
        assert_eq!(repository.get_pet_care().unwrap().ball, 1);
        let version: u32 = repository
            .conn
            .query_row("PRAGMA user_version", [], |row| row.get(0))
            .unwrap();
        assert_eq!(version, if cfg!(feature = "learning") { 12 } else { 11 });
        drop(repository);
        let _ = std::fs::remove_file(&path);
        let _ = std::fs::remove_file(path.with_extension("sqlite3-wal"));
        let _ = std::fs::remove_file(path.with_extension("sqlite3-shm"));
    }

    #[test]
    fn pet_interactions_are_validated_and_counted() {
        let path =
            std::env::temp_dir().join(format!("yuanyuan-reminder-care-{}.sqlite3", Uuid::new_v4()));
        let repository = Repository::open(&path).unwrap();
        repository.record_pet_interaction("food").unwrap();
        repository.record_pet_interaction("treat").unwrap();
        repository.record_pet_interaction("ball").unwrap();
        let care = repository.get_pet_care().unwrap();
        assert_eq!(care.total, 3);
        assert_eq!(care.food, 1);
        assert_eq!(care.treat, 1);
        assert_eq!(care.ball, 1);
        assert!(repository.record_pet_interaction("unknown").is_err());
        drop(repository);
        let _ = std::fs::remove_file(&path);
        let _ = std::fs::remove_file(path.with_extension("sqlite3-wal"));
        let _ = std::fs::remove_file(path.with_extension("sqlite3-shm"));
    }

    #[test]
    fn empty_pet_care_returns_zero_counts() {
        let path = std::env::temp_dir().join(format!(
            "yuanyuan-reminder-empty-care-{}.sqlite3",
            Uuid::new_v4()
        ));
        let repository = Repository::open(&path).unwrap();
        let care = repository.get_pet_care().unwrap();
        assert_eq!(care.total, 0);
        assert_eq!(care.food, 0);
        assert_eq!(care.water, 0);
        assert_eq!(care.treat, 0);
        assert_eq!(care.wand, 0);
        assert_eq!(care.pet, 0);
        assert_eq!(care.ball, 0);
        assert!(care.last_interaction_at.is_none());
        drop(repository);
        let _ = std::fs::remove_file(&path);
        let _ = std::fs::remove_file(path.with_extension("sqlite3-wal"));
        let _ = std::fs::remove_file(path.with_extension("sqlite3-shm"));
    }

    #[test]
    fn pet_care_uses_local_day_boundaries() {
        let path = std::env::temp_dir().join(format!(
            "yuanyuan-reminder-local-care-{}.sqlite3",
            Uuid::new_v4()
        ));
        let repository = Repository::open(&path).unwrap();
        let (start, _) = local_day_utc_bounds(Local::now()).unwrap();
        let start = DateTime::parse_from_rfc3339(&start)
            .unwrap()
            .with_timezone(&Utc);
        for (kind, created_at) in [
            ("food", start - Duration::seconds(1)),
            ("treat", start + Duration::seconds(1)),
        ] {
            repository
                .conn
                .execute(
                    "INSERT INTO pet_interactions(id, kind, created_at)
                     VALUES(?1, ?2, ?3)",
                    params![Uuid::new_v4().to_string(), kind, created_at.to_rfc3339()],
                )
                .unwrap();
        }
        let care = repository.get_pet_care().unwrap();
        assert_eq!(care.total, 1);
        assert_eq!(care.food, 0);
        assert_eq!(care.treat, 1);
        drop(repository);
        let _ = std::fs::remove_file(&path);
        let _ = std::fs::remove_file(path.with_extension("sqlite3-wal"));
        let _ = std::fs::remove_file(path.with_extension("sqlite3-shm"));
    }

    #[test]
    fn activity_progress_survives_repository_reopen() {
        let path = std::env::temp_dir().join(format!(
            "yuanyuan-reminder-activity-progress-{}.sqlite3",
            Uuid::new_v4()
        ));
        let repository = Repository::open(&path).unwrap();
        repository.save_activity_active_seconds(3_245).unwrap();
        drop(repository);

        let repository = Repository::open(&path).unwrap();
        assert_eq!(repository.activity_active_seconds().unwrap(), 3_245);

        drop(repository);
        let _ = std::fs::remove_file(&path);
        let _ = std::fs::remove_file(path.with_extension("sqlite3-wal"));
        let _ = std::fs::remove_file(path.with_extension("sqlite3-shm"));
    }

    #[test]
    fn history_records_can_be_filtered_without_losing_existing_actions() {
        let path = std::env::temp_dir().join(format!(
            "yuanyuan-reminder-history-{}.sqlite3",
            Uuid::new_v4()
        ));
        let repository = Repository::open(&path).unwrap();
        let reminder = repository
            .create_reminder(CreateReminderInput {
                title: "整理历史记录".into(),
                category: "work".into(),
                schedule_kind: "once".into(),
                at_local: Some("2030-01-01T09:30".into()),
                every_minutes: None,
                active_start_local: None,
                active_end_local: None,
                weekdays: None,
            })
            .unwrap();
        let now = Utc::now();
        let completed_id = Uuid::new_v4().to_string();
        let skipped_id = Uuid::new_v4().to_string();
        let old_id = Uuid::new_v4().to_string();
        repository
            .conn
            .execute(
                "INSERT INTO occurrences(
                    id, reminder_id, scheduled_at, status, acted_at, created_at
                 ) VALUES
                    (?1, ?4, ?5, 'completed', ?5, ?5),
                    (?2, ?4, ?6, 'skipped', ?6, ?6),
                    (?3, ?4, ?7, 'completed', ?7, ?7)",
                params![
                    completed_id,
                    skipped_id,
                    old_id,
                    reminder.id,
                    now.to_rfc3339(),
                    (now - Duration::days(1)).to_rfc3339(),
                    (now - Duration::days(120)).to_rfc3339(),
                ],
            )
            .unwrap();

        let recent = repository
            .list_history(Some(30), None, None, None, 200)
            .unwrap();
        assert_eq!(recent.len(), 2);
        assert_eq!(recent[0].id, completed_id);

        let completed = repository
            .list_history(None, Some("completed"), Some("work"), Some("历史"), 200)
            .unwrap();
        assert_eq!(completed.len(), 2);
        assert!(completed.iter().all(|item| item.status == "completed"));

        let skipped = repository
            .list_history(None, Some("skipped"), None, None, 200)
            .unwrap();
        assert_eq!(skipped.len(), 1);
        assert_eq!(skipped[0].id, skipped_id);

        drop(repository);
        let _ = std::fs::remove_file(&path);
        let _ = std::fs::remove_file(path.with_extension("sqlite3-wal"));
        let _ = std::fs::remove_file(path.with_extension("sqlite3-shm"));
    }

    #[test]
    fn activity_alert_waits_until_the_water_occurrence_is_resolved() {
        let path = std::env::temp_dir().join(format!(
            "yuanyuan-reminder-activity-priority-{}.sqlite3",
            Uuid::new_v4()
        ));
        let repository = Repository::open(&path).unwrap();
        let water_reminder_id: String = repository
            .conn
            .query_row(
                "SELECT id FROM reminders WHERE category = 'water' LIMIT 1",
                [],
                |row| row.get(0),
            )
            .unwrap();
        let now = Utc::now();
        let water_occurrence_id = Uuid::new_v4().to_string();
        repository
            .conn
            .execute(
                "INSERT INTO occurrences(
                    id, reminder_id, scheduled_at, status, created_at
                 ) VALUES(?1, ?2, ?3, 'pending', ?3)",
                params![water_occurrence_id, water_reminder_id, now.to_rfc3339()],
            )
            .unwrap();
        let activity = repository.create_activity_occurrence(now).unwrap().unwrap();

        assert!(repository.take_ready_activity_alert().unwrap().is_none());
        repository
            .update_occurrence(&water_occurrence_id, "completed", None)
            .unwrap();
        let released = repository.take_ready_activity_alert().unwrap().unwrap();
        assert_eq!(released.id, activity.id);
        assert!(repository.take_ready_activity_alert().unwrap().is_none());

        drop(repository);
        let _ = std::fs::remove_file(&path);
        let _ = std::fs::remove_file(path.with_extension("sqlite3-wal"));
        let _ = std::fs::remove_file(path.with_extension("sqlite3-shm"));
    }

    #[test]
    fn reminder_management_resolves_active_items_and_protects_system_reminders() {
        let path = std::env::temp_dir().join(format!(
            "yuanyuan-reminder-management-{}.sqlite3",
            Uuid::new_v4()
        ));
        let mut repository = Repository::open(&path).unwrap();
        let input = CreateReminderInput {
            title: "Original title".into(),
            category: "work".into(),
            schedule_kind: "daily".into(),
            at_local: Some("2030-01-01T10:00".into()),
            every_minutes: None,
            active_start_local: None,
            active_end_local: None,
            weekdays: Some(vec![1, 2, 3, 4, 5]),
        };
        let reminder = repository.create_reminder(input.clone()).unwrap();
        let occurrence_id = Uuid::new_v4().to_string();
        repository
            .conn
            .execute(
                "INSERT INTO occurrences(id, reminder_id, scheduled_at, status, created_at)
                 VALUES(?1, ?2, ?3, 'pending', ?3)",
                params![occurrence_id, reminder.id, Utc::now().to_rfc3339()],
            )
            .unwrap();

        let mut edited = input;
        edited.title = "Edited title".into();
        let updated = repository.update_reminder(&reminder.id, edited).unwrap();
        assert_eq!(updated.title, "Edited title");
        let resolution: (String, Option<String>) = repository
            .conn
            .query_row(
                "SELECT status, resolution_reason FROM occurrences WHERE id = ?1",
                [&occurrence_id],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .unwrap();
        assert_eq!(
            resolution,
            ("skipped".into(), Some("reminder-edited".into()))
        );

        assert!(
            !repository
                .set_reminder_enabled(&reminder.id, false)
                .unwrap()
                .enabled
        );
        assert!(
            repository
                .set_reminder_enabled(&reminder.id, true)
                .unwrap()
                .enabled
        );
        repository.archive_reminder(&reminder.id).unwrap();
        assert!(repository
            .get_reminder(&reminder.id)
            .unwrap()
            .unwrap()
            .archived_at
            .is_some());
        assert!(repository
            .list_today(false)
            .unwrap()
            .reminders
            .iter()
            .all(|item| item.id != reminder.id));

        let system_water_id: String = repository
            .conn
            .query_row(
                "SELECT id FROM reminders WHERE system_kind = 'water'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert!(repository
            .set_reminder_enabled(&system_water_id, false)
            .is_err());
        assert!(repository
            .archive_reminder(SYSTEM_ACTIVITY_REMINDER_ID)
            .is_err());

        drop(repository);
        let _ = std::fs::remove_file(&path);
        let _ = std::fs::remove_file(path.with_extension("sqlite3-wal"));
        let _ = std::fs::remove_file(path.with_extension("sqlite3-shm"));
    }

    #[test]
    fn missed_policy_skips_old_occurrences_without_notifying() {
        let path = std::env::temp_dir().join(format!(
            "yuanyuan-reminder-missed-{}.sqlite3",
            Uuid::new_v4()
        ));
        let mut repository = Repository::open(&path).unwrap();
        repository
            .update_settings(serde_json::json!({
                "missedReminderPolicy": "skipOld",
                "missedReminderGraceMinutes": 30
            }))
            .unwrap();
        let reminder = repository
            .create_reminder(CreateReminderInput {
                title: "Old work reminder".into(),
                category: "work".into(),
                schedule_kind: "interval".into(),
                at_local: None,
                every_minutes: Some(60),
                active_start_local: Some("00:00".into()),
                active_end_local: Some("23:59".into()),
                weekdays: Some(vec![0, 1, 2, 3, 4, 5, 6]),
            })
            .unwrap();
        let now = Utc::now();
        repository
            .conn
            .execute(
                "UPDATE reminders SET next_due_at = ?1 WHERE id = ?2",
                params![(now - Duration::minutes(31)).to_rfc3339(), reminder.id],
            )
            .unwrap();

        let claimed = repository.claim_due(now).unwrap();
        let missed = claimed
            .iter()
            .find(|item| item.occurrence.reminder_id == reminder.id)
            .unwrap();
        assert!(!missed.notify);
        assert_eq!(missed.occurrence.status, "skipped");
        assert_eq!(
            missed.occurrence.resolution_reason.as_deref(),
            Some("missed")
        );

        drop(repository);
        let _ = std::fs::remove_file(&path);
        let _ = std::fs::remove_file(path.with_extension("sqlite3-wal"));
        let _ = std::fs::remove_file(path.with_extension("sqlite3-shm"));
    }

    #[test]
    fn reminder_full_flow_supports_thirty_minute_snooze_and_history() {
        let path = std::env::temp_dir().join(format!(
            "yuanyuan-reminder-full-flow-{}.sqlite3",
            Uuid::new_v4()
        ));
        let mut repository = Repository::open(&path).unwrap();
        let reminder = repository
            .create_reminder(CreateReminderInput {
                title: "Full flow".into(),
                category: "work".into(),
                schedule_kind: "interval".into(),
                at_local: None,
                every_minutes: Some(60),
                active_start_local: Some("00:00".into()),
                active_end_local: Some("23:59".into()),
                weekdays: Some(vec![0, 1, 2, 3, 4, 5, 6]),
            })
            .unwrap();
        let now = Utc::now();
        repository
            .conn
            .execute(
                "UPDATE reminders SET next_due_at = ?1 WHERE id = ?2",
                params![(now - Duration::seconds(1)).to_rfc3339(), reminder.id],
            )
            .unwrap();
        let first = repository
            .claim_due(now)
            .unwrap()
            .into_iter()
            .find(|item| item.occurrence.reminder_id == reminder.id)
            .unwrap();
        assert!(first.notify);
        repository
            .update_occurrence(&first.occurrence.id, "snoozed", Some(30))
            .unwrap();
        let second = repository.claim_due(now + Duration::minutes(31)).unwrap();
        assert!(second
            .iter()
            .any(|item| item.occurrence.id == first.occurrence.id && item.notify));
        assert!(!repository
            .complete_occurrence(&first.occurrence.id)
            .unwrap());
        let history = repository
            .list_history(None, Some("completed"), Some("work"), Some("Full"), 20)
            .unwrap();
        assert_eq!(history.len(), 1);
        assert_eq!(history[0].resolution_reason.as_deref(), Some("manual"));

        drop(repository);
        let _ = std::fs::remove_file(&path);
        let _ = std::fs::remove_file(path.with_extension("sqlite3-wal"));
        let _ = std::fs::remove_file(path.with_extension("sqlite3-shm"));
    }

    #[test]
    fn migration_eleven_upgrades_an_existing_v9_budget_without_losing_data() {
        let path = std::env::temp_dir().join(format!(
            "yuanyuan-reminder-v7-migration-{}.sqlite3",
            Uuid::new_v4()
        ));
        let connection = Connection::open(&path).unwrap();
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
        let input = CreateReminderInput {
            title: "Existing water".into(),
            category: "water".into(),
            schedule_kind: "interval".into(),
            at_local: None,
            every_minutes: Some(60),
            active_start_local: Some("09:00".into()),
            active_end_local: Some("18:00".into()),
            weekdays: Some(vec![0, 1, 2, 3, 4, 5, 6]),
        };
        let water_id = Uuid::new_v4().to_string();
        let now = Utc::now().to_rfc3339();
        connection
            .execute(
                "INSERT INTO reminders(
                    id, title, category, schedule_kind, schedule_json, timezone,
                    enabled, next_due_at, created_at, updated_at
                 ) VALUES(?1, ?2, 'water', 'interval', ?3, 'local', 1, ?4, ?4, ?4)",
                params![
                    water_id,
                    input.title,
                    serde_json::to_string(&input).unwrap(),
                    now
                ],
            )
            .unwrap();
        connection
            .execute_batch(include_str!("../migrations/007_reminder_management.sql"))
            .unwrap();
        connection
            .execute_batch(include_str!(
                "../migrations/008_companion_attention_budget.sql"
            ))
            .unwrap();
        connection
            .execute_batch(include_str!(
                "../migrations/009_companion_proactive_attention.sql"
            ))
            .unwrap();
        connection
            .execute(
                "INSERT INTO companion_proactive_attention(kind, shown_at_unix_ms, local_day)
                 VALUES('focus_finished', 1000, '2026-08-05')",
                [],
            )
            .unwrap();
        let before_upgrade: u32 = connection
            .query_row("PRAGMA user_version", [], |row| row.get(0))
            .unwrap();
        assert_eq!(before_upgrade, 9);
        drop(connection);

        let repository = Repository::open(&path).unwrap();
        let version: u32 = repository
            .conn
            .query_row("PRAGMA user_version", [], |row| row.get(0))
            .unwrap();
        assert_eq!(version, if cfg!(feature = "learning") { 12 } else { 11 });
        let water = repository.get_reminder(&water_id).unwrap().unwrap();
        assert_eq!(water.system_kind.as_deref(), Some("water"));
        assert!(water.archived_at.is_none());
        assert_eq!(
            repository
                .get_reminder(SYSTEM_ACTIVITY_REMINDER_ID)
                .unwrap()
                .unwrap()
                .system_kind
                .as_deref(),
            Some("activity")
        );
        let attention_rows: i64 = repository
            .conn
            .query_row(
                "SELECT COUNT(*) FROM companion_attention_budget",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(attention_rows, 1);
        let proactive_rows: i64 = repository
            .conn
            .query_row(
                "SELECT COUNT(*) FROM companion_proactive_attention",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(proactive_rows, 1);
        repository
            .conn
            .execute(
                "INSERT INTO companion_proactive_attention(kind, shown_at_unix_ms, local_day)
                 VALUES('reunion', 2000, '2026-08-05')",
                [],
            )
            .unwrap();

        drop(repository);
        let _ = std::fs::remove_file(&path);
        let _ = std::fs::remove_file(path.with_extension("sqlite3-wal"));
        let _ = std::fs::remove_file(path.with_extension("sqlite3-shm"));
    }

    #[cfg(windows)]
    #[test]
    fn migration_eleven_upgrades_v10_and_adds_only_the_sanitized_deferral_table() {
        let path = std::env::temp_dir().join(format!(
            "yuanyuan-reminder-v10-deferral-migration-{}.sqlite3",
            Uuid::new_v4()
        ));
        let connection = Connection::open(&path).unwrap();
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
        ] {
            connection.execute_batch(migration).unwrap();
        }
        let before: u32 = connection
            .query_row("PRAGMA user_version", [], |row| row.get(0))
            .unwrap();
        assert_eq!(before, 10);
        drop(connection);

        let repository = Repository::open(&path).unwrap();
        let after: u32 = repository
            .conn
            .query_row("PRAGMA user_version", [], |row| row.get(0))
            .unwrap();
        assert_eq!(after, if cfg!(feature = "learning") { 12 } else { 11 });
        let columns = repository
            .conn
            .prepare("PRAGMA table_info(task_watch_attention_deferrals)")
            .unwrap()
            .query_map([], |row| row.get::<_, String>(1))
            .unwrap()
            .collect::<Result<Vec<_>, _>>()
            .unwrap();
        assert_eq!(
            columns,
            [
                "source",
                "state",
                "deferred_until_unix_ms",
                "updated_at_unix_ms"
            ]
        );

        drop(repository);
        let _ = std::fs::remove_file(&path);
        let _ = std::fs::remove_file(path.with_extension("sqlite3-wal"));
        let _ = std::fs::remove_file(path.with_extension("sqlite3-shm"));
    }

    #[cfg(windows)]
    #[test]
    fn task_watch_deferral_is_bounded_persistent_one_shot_and_renewal_safe() {
        use crate::companion_core::TaskSource;
        use yuanyuan_protocol::TaskState;

        let path = std::env::temp_dir().join(format!(
            "yuanyuan-reminder-task-watch-deferral-{}.sqlite3",
            Uuid::new_v4()
        ));
        let mut repository = Repository::open(&path).unwrap();
        assert!(repository
            .defer_task_watch_attention(TaskSource::Codex, TaskState::Succeeded, 10, 1_000)
            .is_err());
        assert!(repository
            .defer_task_watch_attention(TaskSource::Codex, TaskState::Running, 11, 1_000)
            .is_err());
        assert!(repository
            .defer_task_watch_attention(TaskSource::Codex, TaskState::Running, 10, -1)
            .is_err());

        assert_eq!(
            repository
                .defer_task_watch_attention(TaskSource::Codex, TaskState::Running, 10, 1_000)
                .unwrap(),
            601_000
        );
        drop(repository);

        let mut repository = Repository::open(&path).unwrap();
        let active = repository
            .list_task_watch_attention_deferrals(2_000)
            .unwrap();
        assert_eq!(active.len(), 1);
        assert_eq!(active[0].source, TaskSource::Codex);
        assert_eq!(active[0].state, TaskState::Running);
        assert_eq!(active[0].deferred_until_unix_ms, 601_000);

        repository
            .defer_task_watch_attention(TaskSource::ClaudeCode, TaskState::Failed, 10, 2_000)
            .unwrap();
        let due = repository
            .list_due_task_watch_attention_deferrals(601_500)
            .unwrap();
        assert_eq!(due.len(), 1);
        assert_eq!(due[0].source, TaskSource::Codex);

        repository
            .defer_task_watch_attention(TaskSource::Codex, TaskState::Running, 30, 601_500)
            .unwrap();
        assert_eq!(
            repository
                .acknowledge_due_task_watch_attention_deferrals(&due)
                .unwrap(),
            0
        );
        assert_eq!(
            repository
                .list_task_watch_attention_deferrals(601_500)
                .unwrap()
                .len(),
            2
        );

        let due = repository
            .list_due_task_watch_attention_deferrals(602_000)
            .unwrap();
        assert_eq!(due.len(), 1);
        assert_eq!(due[0].source, TaskSource::ClaudeCode);
        assert_eq!(
            repository
                .acknowledge_due_task_watch_attention_deferrals(&due)
                .unwrap(),
            1
        );
        assert!(repository
            .list_due_task_watch_attention_deferrals(602_000)
            .unwrap()
            .is_empty());
        assert!(repository
            .clear_task_watch_attention_deferral(TaskSource::Codex, TaskState::Running)
            .unwrap());
        assert!(!repository
            .clear_task_watch_attention_deferral(TaskSource::Codex, TaskState::Running)
            .unwrap());

        drop(repository);
        let _ = std::fs::remove_file(&path);
        let _ = std::fs::remove_file(path.with_extension("sqlite3-wal"));
        let _ = std::fs::remove_file(path.with_extension("sqlite3-shm"));
    }

    #[cfg(windows)]
    #[test]
    fn terminal_attention_budget_survives_restart_without_task_identity_or_duplicate_summary() {
        use crate::{
            companion_attention::TerminalObservation,
            companion_core::{TaskOutcome, TaskSource},
        };

        let path = std::env::temp_dir().join(format!(
            "yuanyuan-reminder-attention-budget-{}.sqlite3",
            Uuid::new_v4()
        ));
        let mut repository = Repository::open(&path).unwrap();
        let first = TerminalObservation {
            source: TaskSource::ClaudeCode,
            outcome: TaskOutcome::Succeeded,
            updated_at_unix_ms: 1_000,
        };
        assert!(repository
            .observe_terminal_attention_budget(&[first], 1_000, true)
            .unwrap()
            .is_none());
        drop(repository);

        let mut repository = Repository::open(&path).unwrap();
        let restored = repository
            .observe_terminal_attention_budget(&[first], 2_000, false)
            .unwrap()
            .unwrap();
        assert_eq!(restored.count, 1);
        assert_eq!(restored.outcome, TaskOutcome::Succeeded);
        let updated_before_repeat: i64 = repository
            .conn
            .query_row(
                "SELECT updated_at_unix_ms FROM companion_attention_budget WHERE id = 1",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert!(repository
            .observe_terminal_attention_budget(&[first], 3_000, false)
            .unwrap()
            .is_some());
        let updated_after_repeat: i64 = repository
            .conn
            .query_row(
                "SELECT updated_at_unix_ms FROM companion_attention_budget WHERE id = 1",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(updated_after_repeat, updated_before_repeat);
        let schema: String = repository
            .conn
            .query_row(
                "SELECT sql FROM sqlite_master
                 WHERE type = 'table' AND name = 'companion_attention_budget'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        for forbidden in ["task_key", "title", "workspace", "body", "prompt"] {
            assert!(!schema.contains(forbidden));
        }

        let second = TerminalObservation {
            source: TaskSource::Codex,
            outcome: TaskOutcome::Failed,
            updated_at_unix_ms: 40_000,
        };
        assert!(repository
            .observe_terminal_attention_budget(&[second], 40_000, false)
            .unwrap()
            .is_none());
        drop(repository);

        let mut repository = Repository::open(&path).unwrap();
        let after_cooldown = repository
            .observe_terminal_attention_budget(&[], 602_000, false)
            .unwrap()
            .unwrap();
        assert_eq!(after_cooldown.count, 1);
        assert_eq!(after_cooldown.outcome, TaskOutcome::Failed);

        drop(repository);
        let _ = std::fs::remove_file(&path);
        let _ = std::fs::remove_file(path.with_extension("sqlite3-wal"));
        let _ = std::fs::remove_file(path.with_extension("sqlite3-shm"));
    }

    #[cfg(windows)]
    #[test]
    fn terminal_attention_budget_write_failure_rolls_back_and_can_retry() {
        use crate::{
            companion_attention::TerminalObservation,
            companion_core::{TaskOutcome, TaskSource},
        };

        let path = std::env::temp_dir().join(format!(
            "yuanyuan-reminder-attention-rollback-{}.sqlite3",
            Uuid::new_v4()
        ));
        let mut repository = Repository::open(&path).unwrap();
        repository
            .conn
            .execute_batch(
                "CREATE TRIGGER fail_attention_update
                 BEFORE UPDATE ON companion_attention_budget
                 BEGIN
                    SELECT RAISE(ABORT, 'injected attention failure');
                 END;",
            )
            .unwrap();
        let observation = TerminalObservation {
            source: TaskSource::Codex,
            outcome: TaskOutcome::Failed,
            updated_at_unix_ms: 10_000,
        };
        assert!(repository
            .observe_terminal_attention_budget(&[observation], 10_000, false)
            .is_err());
        let unchanged: (i64, i64, Option<i64>) = repository
            .conn
            .query_row(
                "SELECT last_observed_terminal_at_unix_ms, visible_count,
                        last_summary_shown_at_unix_ms
                 FROM companion_attention_budget WHERE id = 1",
                [],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
            )
            .unwrap();
        assert_eq!(unchanged, (0, 0, None));

        repository
            .conn
            .execute_batch("DROP TRIGGER fail_attention_update")
            .unwrap();
        let retried = repository
            .observe_terminal_attention_budget(&[observation], 10_001, false)
            .unwrap()
            .unwrap();
        assert_eq!(retried.count, 1);
        assert_eq!(retried.outcome, TaskOutcome::Failed);

        drop(repository);
        let _ = std::fs::remove_file(&path);
        let _ = std::fs::remove_file(path.with_extension("sqlite3-wal"));
        let _ = std::fs::remove_file(path.with_extension("sqlite3-shm"));
    }

    #[cfg(windows)]
    #[test]
    fn proactive_attention_enforces_intensity_hour_and_day_limits_without_content() {
        let path = std::env::temp_dir().join(format!(
            "yuanyuan-reminder-proactive-budget-{}.sqlite3",
            Uuid::new_v4()
        ));
        let mut repository = Repository::open(&path).unwrap();
        let hour = 60 * 60 * 1_000;

        assert!(!repository
            .try_consume_proactive_attention("focus_finished", "quiet", 1_000, "2026-08-05")
            .unwrap());
        assert!(repository
            .try_consume_proactive_attention("focus_finished", "everyday", 10_000, "2026-08-05")
            .unwrap());
        assert!(!repository
            .try_consume_proactive_attention(
                "focus_finished",
                "everyday",
                9_999 + hour,
                "2026-08-05"
            )
            .unwrap());
        assert!(repository
            .try_consume_proactive_attention("reunion", "everyday", 10_000 + hour, "2026-08-05")
            .unwrap());
        assert!(repository
            .try_consume_proactive_attention(
                "focus_finished",
                "everyday",
                10_000 + 2 * hour,
                "2026-08-05"
            )
            .unwrap());
        assert!(!repository
            .try_consume_proactive_attention(
                "focus_finished",
                "everyday",
                10_000 + 3 * hour,
                "2026-08-05"
            )
            .unwrap());
        assert!(repository
            .try_consume_proactive_attention(
                "focus_finished",
                "close",
                10_000 + 24 * hour,
                "2026-08-06"
            )
            .unwrap());
        assert!(repository
            .try_consume_proactive_attention(
                "focus_finished",
                "close",
                10_001 + 24 * hour,
                "2026-08-06"
            )
            .unwrap());
        assert!(!repository
            .try_consume_proactive_attention(
                "focus_finished",
                "close",
                10_002 + 24 * hour,
                "2026-08-06"
            )
            .unwrap());

        let schema: String = repository
            .conn
            .query_row(
                "SELECT sql FROM sqlite_master
                 WHERE type = 'table' AND name = 'companion_proactive_attention'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        for forbidden in [
            "task_key",
            "title",
            "workspace",
            "body",
            "prompt",
            "message",
        ] {
            assert!(!schema.contains(forbidden));
        }

        drop(repository);
        let _ = std::fs::remove_file(&path);
        let _ = std::fs::remove_file(path.with_extension("sqlite3-wal"));
        let _ = std::fs::remove_file(path.with_extension("sqlite3-shm"));
    }

    #[cfg(windows)]
    #[test]
    fn proactive_attention_insert_failure_rolls_back_and_can_retry() {
        let path = std::env::temp_dir().join(format!(
            "yuanyuan-reminder-proactive-rollback-{}.sqlite3",
            Uuid::new_v4()
        ));
        let mut repository = Repository::open(&path).unwrap();
        repository
            .conn
            .execute_batch(
                "CREATE TRIGGER fail_proactive_insert
                 BEFORE INSERT ON companion_proactive_attention
                 BEGIN
                    SELECT RAISE(ABORT, 'injected proactive failure');
                 END;",
            )
            .unwrap();
        assert!(repository
            .try_consume_proactive_attention("focus_finished", "everyday", 10_000, "2026-08-05")
            .is_err());
        let unchanged: i64 = repository
            .conn
            .query_row(
                "SELECT COUNT(*) FROM companion_proactive_attention",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(unchanged, 0);
        repository
            .conn
            .execute_batch("DROP TRIGGER fail_proactive_insert")
            .unwrap();
        assert!(repository
            .try_consume_proactive_attention("focus_finished", "everyday", 10_001, "2026-08-05")
            .unwrap());

        drop(repository);
        let _ = std::fs::remove_file(&path);
        let _ = std::fs::remove_file(path.with_extension("sqlite3-wal"));
        let _ = std::fs::remove_file(path.with_extension("sqlite3-shm"));
    }

    #[cfg(feature = "learning")]
    #[test]
    fn migration_twelve_preserves_v11_ids_sequence_indexes_and_constraints() {
        let path = std::env::temp_dir().join(format!(
            "yuanyuan-reminder-v12-learning-attention-{}.sqlite3",
            Uuid::new_v4()
        ));
        let connection = Connection::open(&path).unwrap();
        apply_main_migrations_through_v11(&connection);
        connection
            .execute(
                "INSERT INTO companion_proactive_attention(id, kind, shown_at_unix_ms, local_day)
                 VALUES(5, 'focus_finished', 1000, '2026-08-05')",
                [],
            )
            .unwrap();
        connection
            .execute(
                "INSERT INTO companion_proactive_attention(id, kind, shown_at_unix_ms, local_day)
                 VALUES(8, 'reunion', 2000, '2026-08-05')",
                [],
            )
            .unwrap();
        drop(connection);

        let mut repository = Repository::open(&path).unwrap();
        let version: u32 = repository
            .conn
            .query_row("PRAGMA user_version", [], |row| row.get(0))
            .unwrap();
        assert_eq!(version, 12);
        let ids = repository
            .conn
            .prepare("SELECT id FROM companion_proactive_attention ORDER BY id")
            .unwrap()
            .query_map([], |row| row.get::<_, i64>(0))
            .unwrap()
            .collect::<Result<Vec<_>, _>>()
            .unwrap();
        assert_eq!(ids, [5, 8]);
        for index in [
            "idx_companion_proactive_attention_time",
            "idx_companion_proactive_attention_day",
        ] {
            let sql: String = repository
                .conn
                .query_row(
                    "SELECT sql FROM sqlite_master WHERE type = 'index' AND name = ?1",
                    [index],
                    |row| row.get(0),
                )
                .unwrap();
            assert!(sql.contains("companion_proactive_attention"));
        }
        assert!(repository
            .conn
            .execute(
                "INSERT INTO companion_proactive_attention(kind, shown_at_unix_ms, local_day)
                 VALUES('unknown', 3000, '2026-08-05')",
                [],
            )
            .is_err());

        let claim = repository
            .try_claim_learning_attention("everyday", 3_602_001, "2026-08-05")
            .unwrap()
            .unwrap();
        assert!(Uuid::parse_str(&claim.id()).is_ok());
        let inserted_id: i64 = repository
            .conn
            .query_row(
                "SELECT id FROM companion_proactive_attention
                 WHERE kind = 'learning_invitation'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert!(inserted_id > 8);
        assert!(repository
            .release_unpresented_learning_attention(&claim)
            .unwrap());
        assert!(!repository
            .release_unpresented_learning_attention(&claim)
            .unwrap());

        drop(repository);
        let _ = std::fs::remove_file(&path);
        let _ = std::fs::remove_file(path.with_extension("sqlite3-wal"));
        let _ = std::fs::remove_file(path.with_extension("sqlite3-shm"));
    }

    #[cfg(feature = "learning")]
    #[test]
    fn failed_v12_table_rebuild_rolls_back_to_intact_v11() {
        let connection = Connection::open_in_memory().unwrap();
        apply_main_migrations_through_v11(&connection);
        connection
            .execute(
                "INSERT INTO companion_proactive_attention(kind, shown_at_unix_ms, local_day)
                 VALUES('focus_finished', 1000, '2026-08-05')",
                [],
            )
            .unwrap();
        let broken = include_str!("../migrations/012_learning_invitation_attention.sql").replace(
            "DROP TABLE companion_proactive_attention_v11;",
            "SELECT definitely_missing_sql_function();\nDROP TABLE companion_proactive_attention_v11;",
        );
        assert!(execute_migration(&connection, &broken).is_err());
        let version: u32 = connection
            .query_row("PRAGMA user_version", [], |row| row.get(0))
            .unwrap();
        let row: (String, i64) = connection
            .query_row(
                "SELECT kind, id FROM companion_proactive_attention",
                [],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .unwrap();
        let renamed_table_exists: bool = connection
            .query_row(
                "SELECT EXISTS(SELECT 1 FROM sqlite_master
                 WHERE type = 'table' AND name = 'companion_proactive_attention_v11')",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(version, 11);
        assert_eq!(row, ("focus_finished".into(), 1));
        assert!(!renamed_table_exists);
    }

    #[test]
    fn real_upgrade_fixture_is_healthy_when_provided() {
        let Ok(source_path) = std::env::var("YUANYUAN_UPGRADE_FIXTURE") else {
            return;
        };
        let source = Connection::open_with_flags(&source_path, OpenFlags::SQLITE_OPEN_READ_ONLY)
            .expect("real upgrade fixture should open read-only");
        let integrity: String = source
            .query_row("PRAGMA quick_check", [], |row| row.get(0))
            .unwrap();
        assert_eq!(integrity, "ok");

        let copy_path = std::env::temp_dir().join(format!(
            "yuanyuan-reminder-real-upgrade-{}.sqlite3",
            Uuid::new_v4()
        ));
        source
            .backup(MAIN_DB, &copy_path, None::<fn(Progress)>)
            .unwrap();
        drop(source);

        let repository = Repository::open(&copy_path).unwrap();
        let version: u32 = repository
            .conn
            .query_row("PRAGMA user_version", [], |row| row.get(0))
            .unwrap();
        assert_eq!(version, if cfg!(feature = "learning") { 12 } else { 11 });
        repository.get_settings().unwrap();
        repository.list_today(false).unwrap();
        repository.get_pet_care().unwrap();
        repository
            .list_history(Some(30), None, None, None, 20)
            .unwrap();

        drop(repository);
        let _ = std::fs::remove_file(&copy_path);
        let _ = std::fs::remove_file(copy_path.with_extension("sqlite3-wal"));
        let _ = std::fs::remove_file(copy_path.with_extension("sqlite3-shm"));
    }
}
