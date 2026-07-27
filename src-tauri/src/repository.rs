use std::{fs, path::Path};

use chrono::{
    DateTime, Datelike, Duration, Local, LocalResult, NaiveDateTime, NaiveTime, TimeZone, Utc,
};
use rusqlite::{params, Connection, OptionalExtension, Row};
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

pub struct Repository {
    conn: Connection,
}

impl Repository {
    pub fn open(path: &Path) -> AppResult<Self> {
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent)?;
        }
        let conn = Connection::open(path)?;
        conn.pragma_update(None, "foreign_keys", "ON")?;
        conn.pragma_update(None, "journal_mode", "WAL")?;
        let schema_version: u32 =
            conn.query_row("PRAGMA user_version", [], |row| row.get(0))?;
        if schema_version < 1 {
            conn.execute_batch(include_str!("../migrations/001_initial.sql"))?;
        }
        if schema_version < 2 {
            conn.execute_batch(include_str!("../migrations/002_focus_sessions.sql"))?;
        }
        if schema_version < 3 {
            conn.execute_batch(include_str!("../migrations/003_pet_interactions.sql"))?;
        }
        if schema_version < 4 {
            conn.execute_batch(include_str!("../migrations/004_ball_interaction.sql"))?;
        }
        if schema_version < 5 {
            conn.execute_batch(include_str!("../migrations/005_occurrence_history.sql"))?;
        }
        if schema_version < 6 {
            conn.execute_batch(include_str!("../migrations/006_activity_tracking.sql"))?;
        }
        let repo = Self { conn };
        repo.ensure_settings()?;
        repo.ensure_default_water_reminder()?;
        repo.ensure_activity_reminder()?;
        Ok(repo)
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
            "SELECT COUNT(*) FROM reminders WHERE category = 'water'",
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
                enabled, next_due_at, created_at, updated_at
             ) VALUES(?1, '起来活动一下', 'personal', 'interval', ?2, ?3, 0, NULL, ?4, ?4)",
            params![
                SYSTEM_ACTIVITY_REMINDER_ID,
                serde_json::to_string(&input)?,
                iana_time_zone::get_timezone().unwrap_or_else(|_| "local".into()),
                now.to_rfc3339(),
            ],
        )?;
        self.conn.execute(
            "UPDATE reminders
             SET title = '起来活动一下', enabled = 0, next_due_at = NULL
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
                    enabled, next_due_at, created_at, updated_at
             FROM reminders
             ORDER BY enabled DESC, next_due_at ASC",
        )?;
        let reminders = reminder_statement
            .query_map([], reminder_from_row)?
            .collect::<Result<Vec<_>, _>>()?;

        let mut occurrence_statement = self.conn.prepare(
            "SELECT o.id, o.reminder_id, r.title, r.category, o.scheduled_at,
                    o.status, o.acted_at, o.snoozed_until
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
                return Err(AppError::Validation(
                    "unsupported history status".into(),
                ));
            }
        }
        if let Some(category) = category {
            if !["water", "work", "personal"].contains(&category) {
                return Err(AppError::Validation(
                    "unsupported history category".into(),
                ));
            }
        }
        let cutoff = days
            .map(|days| days.clamp(1, 3650))
            .map(|days| (Utc::now() - Duration::days(i64::from(days))).to_rfc3339());
        let query = query.map(str::trim).filter(|value| !value.is_empty());
        let mut statement = self.conn.prepare(
            "SELECT o.id, o.reminder_id, r.title, r.category, o.scheduled_at,
                    o.status, o.acted_at, o.snoozed_until
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

    pub fn get_reminder(&self, id: &str) -> AppResult<Option<Reminder>> {
        Ok(self
            .conn
            .query_row(
                "SELECT id, title, category, schedule_kind, schedule_json, timezone,
                        enabled, next_due_at, created_at, updated_at
                 FROM reminders WHERE id = ?1",
                [id],
                reminder_from_row,
            )
            .optional()?)
    }

    pub fn create_activity_occurrence(
        &self,
        now: DateTime<Utc>,
    ) -> AppResult<Option<Occurrence>> {
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
        }))
    }

    pub fn take_ready_activity_alert(&self) -> AppResult<Option<Occurrence>> {
        let occurrence = self
            .conn
            .query_row(
                "SELECT o.id, o.reminder_id, r.title, r.category, o.scheduled_at,
                        o.status, o.acted_at, o.snoozed_until
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
             SET status = 'completed', acted_at = ?1, snoozed_until = NULL
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
        let pause_until = self
            .get_settings()?
            .pause_until
            .and_then(|value| DateTime::parse_from_rfc3339(&value).ok())
            .map(|value| value.with_timezone(&Utc));
        if pause_until.is_some_and(|until| until > now) {
            return Ok(Vec::new());
        }

        let due_reminders = {
            let mut statement = self.conn.prepare(
                "SELECT id, title, category, schedule_kind, schedule_json, timezone,
                        enabled, next_due_at, created_at, updated_at
                 FROM reminders
                 WHERE enabled = 1 AND next_due_at IS NOT NULL AND next_due_at <= ?1
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
                        status: "pending".into(),
                        acted_at: None,
                        snoozed_until: None,
                    },
                });
            }
        }

        let snoozed_due = {
            let mut statement = transaction.prepare(
                "SELECT o.id, o.reminder_id, r.title, r.category, o.scheduled_at,
                        o.status, o.acted_at, o.snoozed_until
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
                     notification_id = NULL
                 WHERE id = ?1 AND status = 'snoozed'",
                [&occurrence.id],
            )?;
            occurrence.status = "pending".into();
            occurrence.acted_at = None;
            occurrence.snoozed_until = None;
            claimed.push(DueOccurrence { occurrence });
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
             SET status = ?1, acted_at = ?2, snoozed_until = ?3
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
             SET status = 'completed', acted_at = ?1, snoozed_until = NULL
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
            return Err(AppError::Validation(
                "unsupported pet interaction".into(),
            ));
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
                 WHERE category = 'water'
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

    pub fn mark_overdue(&self) -> AppResult<()> {
        self.conn.execute(
            "UPDATE occurrences SET status = 'overdue'
             WHERE status = 'pending' AND scheduled_at < ?1",
            [Utc::now().to_rfc3339()],
        )?;
        Ok(())
    }
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
    Ok(())
}

fn validate_settings(settings: &AppSettings) -> AppResult<()> {
    if !["always", "system", "off"].contains(&settings.animation_mode.as_str()) {
        return Err(AppError::Validation("invalid animation mode".into()));
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
        for (id, scheduled_at) in [
            (&oldest_id, now - Duration::minutes(10)),
            (&newest_id, now),
        ] {
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
        assert_eq!(version, 6);
        drop(repository);
        let _ = std::fs::remove_file(&path);
        let _ = std::fs::remove_file(path.with_extension("sqlite3-wal"));
        let _ = std::fs::remove_file(path.with_extension("sqlite3-shm"));
    }

    #[test]
    fn pet_interactions_are_validated_and_counted() {
        let path = std::env::temp_dir().join(format!(
            "yuanyuan-reminder-care-{}.sqlite3",
            Uuid::new_v4()
        ));
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
                    params![
                        Uuid::new_v4().to_string(),
                        kind,
                        created_at.to_rfc3339()
                    ],
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
                params![
                    water_occurrence_id,
                    water_reminder_id,
                    now.to_rfc3339()
                ],
            )
            .unwrap();
        let activity = repository
            .create_activity_occurrence(now)
            .unwrap()
            .unwrap();

        assert!(repository.take_ready_activity_alert().unwrap().is_none());
        repository
            .update_occurrence(&water_occurrence_id, "completed", None)
            .unwrap();
        let released = repository
            .take_ready_activity_alert()
            .unwrap()
            .unwrap();
        assert_eq!(released.id, activity.id);
        assert!(repository.take_ready_activity_alert().unwrap().is_none());

        drop(repository);
        let _ = std::fs::remove_file(&path);
        let _ = std::fs::remove_file(path.with_extension("sqlite3-wal"));
        let _ = std::fs::remove_file(path.with_extension("sqlite3-shm"));
    }
}
