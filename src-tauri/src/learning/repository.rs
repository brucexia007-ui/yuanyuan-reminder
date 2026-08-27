use std::{fs, path::Path, time::Duration};

use chrono::{Days, Local, NaiveDate, TimeZone, Utc};
use rusqlite::{
    backup::Progress, params, Connection, OpenFlags, OptionalExtension, Transaction,
    TransactionBehavior, MAIN_DB,
};

use crate::error::{AppError, AppResult};

use super::invitation::{LearningSuppressionReason, LearningTriggerSource};
use super::{
    models::{
        ImportCommitResult, ImportProgressHint, LearningAnswerResult, LearningCardDto,
        LearningDashboardDay, LearningDashboardSnapshot, LearningEntrySource, LearningHomeSnapshot,
        LearningInvitationData, LearningMistakeStatus, LearningMode, LearningQuestionDto,
        LearningQuestionKind, LearningRateResult, LearningRating, LearningRecordFilter,
        LearningRecordItem, LearningRecordPage, LearningSessionKind, LearningSessionSnapshot,
        LearningSessionSummary, LearningSettings, LearningSettingsPatch, LearningStage,
        ParsedUserImport, ScheduleInput,
    },
    quiz,
    scheduler_adapter::FsrsScheduler,
};

pub(super) mod portability;

pub(super) const CURRENT_SCHEMA_VERSION: u32 = 7;
const BUSY_TIMEOUT_MILLIS: u64 = 2_000;
const LEARNING_SESSION_TTL_MILLIS: i64 = 24 * 60 * 60 * 1_000;
const INITIAL_MIGRATION: &str = include_str!("migrations/001_initial.sql");
const EXPORT_METADATA_MIGRATION: &str = include_str!("migrations/002_export_metadata.sql");
const QUIZ_LEARNING_MIGRATION: &str = include_str!("migrations/003_quiz_learning.sql");
const LEARNING_INSIGHTS_MIGRATION: &str = include_str!("migrations/004_learning_insights.sql");
const LEARNING_ROUNDS_MIGRATION: &str = include_str!("migrations/005_learning_rounds.sql");
const RESUMABLE_SESSIONS_MIGRATION: &str = include_str!("migrations/006_resumable_sessions.sql");
const LEGACY_MIGRATION_RECEIPTS_MIGRATION: &str =
    include_str!("migrations/007_legacy_migration_receipts.sql");

pub struct LearningRepository {
    conn: Connection,
    #[cfg(feature = "runtime-qa")]
    commit_crash_gate: Option<crate::runtime_qa::LearningCommitCrashGate>,
}

impl LearningRepository {
    pub fn open(path: &Path) -> AppResult<Self> {
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent)?;
        }
        let mut conn = Connection::open(path)?;
        configure_connection(&conn)?;
        apply_migrations(&conn)?;
        validate_connection(&conn)?;
        initialize_schema_timestamps(&conn)?;
        recover_orphaned_learning_sessions(&mut conn, Utc::now().timestamp_millis())?;
        #[cfg(feature = "runtime-qa")]
        let commit_crash_gate = crate::runtime_qa::install_learning_commit_crash_gate(&conn)?;
        Ok(Self {
            conn,
            #[cfg(feature = "runtime-qa")]
            commit_crash_gate,
        })
    }

    pub fn has_ready_content(&self) -> AppResult<bool> {
        self.conn
            .query_row(
                "SELECT EXISTS(SELECT 1 FROM content_packs WHERE status = 'ready')",
                [],
                |row| row.get(0),
            )
            .map_err(Into::into)
    }

    pub fn backup_to(&self, path: &Path) -> AppResult<()> {
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent)?;
        }
        if let Err(error) = self.conn.backup(MAIN_DB, path, None::<fn(Progress)>) {
            let _ = fs::remove_file(path);
            return Err(error.into());
        }
        Ok(())
    }

    pub fn restore_from(&mut self, path: &Path) -> AppResult<()> {
        validate_backup_database(path)?;
        self.conn.restore(MAIN_DB, path, None::<fn(Progress)>)?;
        apply_migrations(&self.conn)?;
        validate_connection(&self.conn)?;
        initialize_schema_timestamps(&self.conn)?;
        recover_orphaned_learning_sessions(&mut self.conn, Utc::now().timestamp_millis())?;
        Ok(())
    }

    pub fn validate_database_file(path: &Path) -> AppResult<()> {
        validate_backup_database(path)
    }

    pub fn legacy_migration_matches(&self, edition: &str, fingerprint: &str) -> AppResult<bool> {
        let matched = self.conn.query_row(
            "SELECT EXISTS(
                SELECT 1 FROM legacy_learning_migrations
                WHERE source_edition = ?1 AND source_fingerprint = ?2
             )",
            params![edition, fingerprint],
            |row| row.get(0),
        )?;
        Ok(matched)
    }

    #[allow(dead_code)]
    pub fn commit_user_import(
        &mut self,
        import: &ParsedUserImport,
        now_unix_ms: i64,
    ) -> AppResult<ImportCommitResult> {
        self.commit_user_import_with_cancellation(import, now_unix_ms, &|| false)
    }

    pub fn commit_user_import_with_cancellation<F>(
        &mut self,
        import: &ParsedUserImport,
        now_unix_ms: i64,
        is_cancelled: &F,
    ) -> AppResult<ImportCommitResult>
    where
        F: Fn() -> bool,
    {
        super::import::ensure_import_not_cancelled(is_cancelled)?;
        if now_unix_ms < 0 || import.cards.is_empty() {
            return Err(AppError::Validation(
                "learning import commit input is invalid".into(),
            ));
        }
        let transaction = self
            .conn
            .transaction_with_behavior(TransactionBehavior::Immediate)?;
        transaction.execute(
            "INSERT INTO content_sources(
                source_id, source_kind, version, source_url, license_expression,
                notice_text, content_sha256, created_at_unix_ms
             ) VALUES(?1, 'user_import', ?2, NULL, NULL, NULL, ?3, ?4)
             ON CONFLICT(source_id) DO UPDATE SET
                version = excluded.version,
                content_sha256 = excluded.content_sha256",
            params![
                import.source_id,
                &import.file_sha256[..16],
                import.file_sha256,
                now_unix_ms
            ],
        )?;
        transaction.execute(
            "UPDATE content_packs
             SET status = 'disabled'
             WHERE stable_namespace = 'user.local' AND status <> 'disabled'",
            [],
        )?;
        transaction.execute(
            "INSERT INTO content_packs(
                pack_id, stable_namespace, version, title, exam_scope, status,
                manifest_sha256, created_at_unix_ms
             ) VALUES(?1, 'user.local', ?2, ?3, '考研英语·用户导入', 'ready', ?4, ?5)
             ON CONFLICT(pack_id) DO UPDATE SET
                title = excluded.title,
                status = 'ready',
                manifest_sha256 = excluded.manifest_sha256",
            params![
                import.pack_id,
                &import.file_sha256[..16],
                import.source_label,
                import.file_sha256,
                now_unix_ms
            ],
        )?;

        let source_ids_json = serde_json::to_string(&[&import.source_id])?;
        let sense_basis_json = serde_json::json!({
            "kind": "user_provided",
            "sourceId": import.source_id,
        })
        .to_string();
        let mut preserved_schedule_count = 0_u32;
        for card in &import.cards {
            super::import::ensure_import_not_cancelled(is_cancelled)?;
            let existing_schedule = transaction
                .query_row(
                    "SELECT 1 FROM card_schedule WHERE card_id = ?1",
                    [&card.card_id],
                    |row| row.get::<_, i64>(0),
                )
                .optional()?
                .is_some();
            transaction.execute(
                "INSERT INTO learning_cards(
                    card_id, pack_id, headword, normalized_headword, phonetic,
                    part_of_speech_json, meanings_zh_json, word_family_json,
                    frequency_band, sense_basis_json, source_ids_json,
                    content_sha256, created_at_unix_ms
                 ) VALUES(?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, 'user_import', ?9, ?10, ?11, ?12)
                 ON CONFLICT(card_id) DO UPDATE SET
                    pack_id = excluded.pack_id,
                    headword = excluded.headword,
                    normalized_headword = excluded.normalized_headword,
                    phonetic = excluded.phonetic,
                    part_of_speech_json = excluded.part_of_speech_json,
                    meanings_zh_json = excluded.meanings_zh_json,
                    word_family_json = excluded.word_family_json,
                    frequency_band = excluded.frequency_band,
                    sense_basis_json = excluded.sense_basis_json,
                    source_ids_json = excluded.source_ids_json,
                    content_sha256 = excluded.content_sha256",
                params![
                    card.card_id,
                    import.pack_id,
                    card.headword,
                    card.normalized_headword,
                    card.phonetic,
                    serde_json::to_string(&card.part_of_speech)?,
                    serde_json::to_string(&card.meanings_zh)?,
                    serde_json::to_string(&card.word_family)?,
                    sense_basis_json,
                    source_ids_json,
                    card.content_sha256,
                    now_unix_ms,
                ],
            )?;
            if existing_schedule {
                preserved_schedule_count += 1;
            } else {
                let due_at_unix_ms = now_unix_ms
                    .checked_add(
                        card.progress_hint
                            .initial_due_offset_days()
                            .saturating_mul(86_400_000),
                    )
                    .ok_or_else(|| {
                        AppError::Validation("learning import due time overflowed".into())
                    })?;
                transaction.execute(
                    "INSERT INTO card_schedule(
                        card_id, stage, due_at_unix_ms, stability, difficulty,
                        reps, lapses, last_review_at_unix_ms
                     ) VALUES(?1, ?2, ?3, NULL, NULL, 0, 0, NULL)",
                    params![
                        card.card_id,
                        initial_stage(card.progress_hint),
                        due_at_unix_ms
                    ],
                )?;
            }
        }
        super::import::ensure_import_not_cancelled(is_cancelled)?;
        transaction.commit()?;
        Ok(ImportCommitResult {
            schema_version: 1,
            pack_id: import.pack_id.clone(),
            imported_count: import.cards.len() as u32,
            preserved_schedule_count,
        })
    }

    pub fn learning_home(&mut self, now_unix_ms: i64) -> AppResult<LearningHomeSnapshot> {
        validate_now(now_unix_ms)?;
        {
            let transaction = self
                .conn
                .transaction_with_behavior(TransactionBehavior::Immediate)?;
            expire_learning_sessions(&transaction, now_unix_ms)?;
            transaction.commit()?;
        }
        let settings = read_learning_settings(&self.conn)?;
        let availability = learning_card_availability(&self.conn, now_unix_ms)?;
        let stable_count: u32 = self.conn.query_row(
            "SELECT COUNT(*)
             FROM card_schedule s
             JOIN learning_cards c USING(card_id)
             JOIN content_packs p ON p.pack_id = c.pack_id
             WHERE p.status = 'ready' AND s.stage = 'stable'",
            [],
            |row| row.get(0),
        )?;
        let seven_days_ago = now_unix_ms.saturating_sub(7 * 86_400_000);
        let reviews_last_7_days: u32 = self.conn.query_row(
            "SELECT COUNT(*) FROM review_logs WHERE reviewed_at_unix_ms >= ?1",
            [seven_days_ago],
            |row| row.get(0),
        )?;
        let completed_sessions_last_7_days: u32 = self.conn.query_row(
            "SELECT COUNT(*) FROM learning_sessions
             WHERE status = 'completed' AND ended_at_unix_ms >= ?1",
            [seven_days_ago],
            |row| row.get(0),
        )?;
        let active_session = unfinished_session(&self.conn)?;
        let pending_recheck_count = count_pending_rechecks(&self.conn)?;
        let tomorrow_due_count = count_tomorrow_due_cards(&self.conn, now_unix_ms)?;
        let average_response_ms = average_recent_response_ms(&self.conn)?;
        Ok(LearningHomeSnapshot {
            schema_version: 1,
            capabilities: crate::models::LearningCapabilities {
                compiled: true,
                available: true,
                content_pack_ready: self.has_ready_content()?,
                auto_invitation_available: false,
                failure_reason: None,
            },
            due_count: availability.due_review_count,
            new_available_count: availability.available_new_count,
            new_remaining_count: availability.new_remaining_count,
            new_studied_today_count: availability.new_studied_today_count,
            mistake_count: count_unresolved_mistakes(&self.conn)?,
            pending_recheck_count,
            stable_count,
            tomorrow_due_count,
            average_response_ms,
            reviews_last_7_days,
            completed_sessions_last_7_days,
            settings,
            active_session,
        })
    }

    pub fn learning_dashboard(&self, now_unix_ms: i64) -> AppResult<LearningDashboardSnapshot> {
        validate_now(now_unix_ms)?;
        let raw = self.conn.query_row(
            "WITH mistake_events AS (
                SELECT a.card_id,
                  CASE
                    WHEN a.outcome = 'incorrect' AND a.is_remediation = 0 THEN 'needs_correction'
                    WHEN a.outcome = 'correct' AND a.is_remediation = 0 AND se.session_kind = 'daily' THEN 'consolidated'
                    WHEN a.outcome = 'correct' AND (a.is_remediation = 1 OR se.session_kind = 'mistakes') THEN 'pending_recheck'
                    ELSE NULL
                  END AS state,
                  ROW_NUMBER() OVER (
                    PARTITION BY a.card_id
                    ORDER BY a.answered_at_unix_ms DESC, a.attempt_id DESC
                  ) AS position
                FROM learning_question_attempts a
                JOIN learning_sessions se USING(session_id)
                WHERE (a.outcome = 'incorrect' AND a.is_remediation = 0)
                   OR (a.outcome = 'correct' AND (a.is_remediation = 1 OR se.session_kind IN ('daily', 'mistakes')))
             ), mistake_state AS (
                SELECT card_id, state FROM mistake_events WHERE position = 1
             )
             SELECT COUNT(*),
                COALESCE(SUM(CASE WHEN s.stage = 'new' THEN 1 ELSE 0 END), 0),
                COALESCE(SUM(CASE WHEN s.stage = 'learning' AND COALESCE(ms.state, '') NOT IN ('needs_correction', 'pending_recheck') THEN 1 ELSE 0 END), 0),
                COALESCE(SUM(CASE WHEN ms.state = 'needs_correction' THEN 1 ELSE 0 END), 0),
                COALESCE(SUM(CASE WHEN ms.state = 'pending_recheck' THEN 1 ELSE 0 END), 0),
                COALESCE(SUM(CASE WHEN s.stage = 'stable' AND COALESCE(ms.state, '') NOT IN ('needs_correction', 'pending_recheck') THEN 1 ELSE 0 END), 0),
                COALESCE(SUM(CASE WHEN ms.state = 'consolidated' THEN 1 ELSE 0 END), 0)
             FROM card_schedule s
             JOIN learning_cards c USING(card_id)
             JOIN content_packs p ON p.pack_id = c.pack_id AND p.status = 'ready'
             LEFT JOIN mistake_state ms USING(card_id)",
            [],
            |row| {
                Ok((
                    row.get::<_, u32>(0)?,
                    row.get::<_, u32>(1)?,
                    row.get::<_, u32>(2)?,
                    row.get::<_, u32>(3)?,
                    row.get::<_, u32>(4)?,
                    row.get::<_, u32>(5)?,
                    row.get::<_, u32>(6)?,
                ))
            },
        )?;
        let local_today = Local
            .timestamp_millis_opt(now_unix_ms)
            .single()
            .ok_or_else(|| AppError::Time("learning dashboard local day is invalid".into()))?
            .date_naive();
        let mut days = Vec::with_capacity(7);
        let mut correct_7_days = 0_u32;
        let mut answers_7_days = 0_u32;
        for offset in (0_u64..7).rev() {
            let date = local_today
                .checked_sub_days(Days::new(offset))
                .ok_or_else(|| AppError::Time("learning dashboard day overflowed".into()))?;
            let local_day = date.format("%Y-%m-%d").to_string();
            let (start, end) = local_day_bounds_from_text(&local_day)?;
            let new_count = count_first_reviews_between(&self.conn, start, end)?;
            let review_count = self.conn.query_row(
                "SELECT COUNT(*) FROM review_logs
                 WHERE reviewed_at_unix_ms >= ?1 AND reviewed_at_unix_ms < ?2",
                params![start, end],
                |row| row.get(0),
            )?;
            let (first_answer_count, first_answer_correct_count) = self.conn.query_row(
                "SELECT COUNT(*),
                    COALESCE(SUM(CASE WHEN outcome = 'correct' THEN 1 ELSE 0 END), 0)
                 FROM learning_question_attempts
                 WHERE is_remediation = 0
                   AND answered_at_unix_ms >= ?1 AND answered_at_unix_ms < ?2",
                params![start, end],
                |row| Ok((row.get::<_, u32>(0)?, row.get::<_, u32>(1)?)),
            )?;
            correct_7_days = correct_7_days.saturating_add(first_answer_correct_count);
            answers_7_days = answers_7_days.saturating_add(first_answer_count);
            days.push(LearningDashboardDay {
                local_day,
                new_count,
                review_count,
                first_answer_correct_count,
                first_answer_count,
            });
        }
        Ok(LearningDashboardSnapshot {
            schema_version: 1,
            total_count: raw.0,
            studied_count: raw.0.saturating_sub(raw.1),
            new_count: raw.1,
            learning_count: raw.2,
            mistake_count: raw.3,
            pending_recheck_count: raw.4,
            stable_count: raw.5,
            corrected_mistake_count: raw.6,
            first_answer_correct_count_7_days: correct_7_days,
            first_answer_count_7_days: answers_7_days,
            days,
        })
    }

    pub fn update_learning_settings(
        &mut self,
        patch: LearningSettingsPatch,
        now_unix_ms: i64,
    ) -> AppResult<LearningSettings> {
        validate_now(now_unix_ms)?;
        let mut settings = read_learning_settings(&self.conn)?;
        if let Some(value) = patch.mode {
            settings.mode = value;
        }
        if let Some(value) = patch.cards_per_session {
            settings.cards_per_session = value;
        }
        if let Some(value) = patch.daily_new_limit {
            settings.daily_new_limit = value;
        }
        if let Some(value) = patch.daily_goal {
            settings.daily_goal = value;
        }
        if let Some(value) = patch.focus_finished_enabled {
            settings.focus_finished_enabled = value;
        }
        if patch.scheduled_windows_enabled == Some(true)
            || patch.work_gap_experimental_enabled == Some(true)
        {
            return Err(AppError::Validation(
                "this automatic learning source is not available in the current preview".into(),
            ));
        }
        if let Some(value) = patch.scheduled_windows_enabled {
            settings.scheduled_windows_enabled = value;
        }
        if let Some(value) = patch.work_gap_experimental_enabled {
            settings.work_gap_experimental_enabled = value;
        }
        if let Some(value) = patch.daily_invitation_limit {
            settings.daily_invitation_limit = value;
        }
        if let Some(value) = patch.invitation_cooldown_minutes {
            settings.invitation_cooldown_minutes = value;
        }
        validate_learning_settings(&settings)?;
        settings.updated_at_unix_ms = now_unix_ms;
        self.conn.execute(
            "UPDATE learning_settings SET
                mode = ?1, cards_per_session = ?2, daily_new_limit = ?3,
                daily_goal = ?4, focus_finished_enabled = ?5,
                scheduled_windows_enabled = ?6, work_gap_experimental_enabled = ?7,
                daily_invitation_limit = ?8, invitation_cooldown_minutes = ?9,
                updated_at_unix_ms = ?10
             WHERE id = 1",
            params![
                learning_mode_as_str(settings.mode),
                settings.cards_per_session,
                settings.daily_new_limit,
                settings.daily_goal,
                settings.focus_finished_enabled,
                settings.scheduled_windows_enabled,
                settings.work_gap_experimental_enabled,
                settings.daily_invitation_limit,
                settings.invitation_cooldown_minutes,
                settings.updated_at_unix_ms,
            ],
        )?;
        Ok(settings)
    }

    #[cfg(test)]
    pub fn start_manual_session(
        &mut self,
        requested_count: u8,
        session_kind: LearningSessionKind,
        now_unix_ms: i64,
    ) -> AppResult<LearningSessionSnapshot> {
        self.start_manual_session_scoped(requested_count, session_kind, None, now_unix_ms)
    }

    #[cfg(test)]
    pub fn start_manual_session_scoped(
        &mut self,
        requested_count: u8,
        session_kind: LearningSessionKind,
        source_session_id: Option<&str>,
        now_unix_ms: i64,
    ) -> AppResult<LearningSessionSnapshot> {
        let created = self.create_manual_session_scoped(
            requested_count,
            session_kind,
            source_session_id,
            now_unix_ms,
        )?;
        self.present_learning_session(&created.session_id, created.state_revision, now_unix_ms)
    }

    pub fn create_manual_session_scoped(
        &mut self,
        requested_count: u8,
        session_kind: LearningSessionKind,
        source_session_id: Option<&str>,
        now_unix_ms: i64,
    ) -> AppResult<LearningSessionSnapshot> {
        validate_now(now_unix_ms)?;
        if !matches!(requested_count, 1 | 3 | 5 | 10) {
            return Err(AppError::Validation(
                "learning session card count must be 1, 3, 5, or 10".into(),
            ));
        }
        if source_session_id.is_some() && session_kind != LearningSessionKind::Mistakes {
            return Err(AppError::Validation(
                "a source session is only supported for mistake practice".into(),
            ));
        }
        let transaction = self
            .conn
            .transaction_with_behavior(TransactionBehavior::Immediate)?;
        expire_learning_sessions(&transaction, now_unix_ms)?;
        if unfinished_session(&transaction)?.is_some() {
            return Err(AppError::Validation(
                "a learning session is already active or resumable".into(),
            ));
        }
        let available = match session_kind {
            LearningSessionKind::Daily => {
                let availability = learning_card_availability(&transaction, now_unix_ms)?;
                availability
                    .due_review_count
                    .saturating_add(availability.available_new_count)
            }
            LearningSessionKind::Mistakes => match source_session_id {
                Some(source_session_id) => {
                    validate_session_identifier(source_session_id)?;
                    targetable_session_mistake_ids(
                        &transaction,
                        source_session_id,
                        requested_count,
                    )?
                    .len() as u32
                }
                None => count_unresolved_mistakes(&transaction)?,
            },
        };
        let planned_count = u32::from(requested_count).min(available) as u8;
        if planned_count == 0 {
            return Err(AppError::Validation(
                match session_kind {
                    LearningSessionKind::Daily => "no learning cards are currently available",
                    LearningSessionKind::Mistakes => {
                        "no unresolved learning mistakes are currently available"
                    }
                }
                .into(),
            ));
        }
        let session_id = uuid::Uuid::new_v4().to_string();
        let expires_at_unix_ms = learning_session_expiry(now_unix_ms)?;
        transaction.execute(
            "INSERT INTO learning_sessions(
                session_id, entry_source, session_kind, status, state_revision,
                current_item_id, planned_count, completed_count, started_at_unix_ms,
                paused_at_unix_ms, pause_reason, last_activity_at_unix_ms,
                expires_at_unix_ms, ended_at_unix_ms, exit_reason
             ) VALUES(?1, 'manual', ?2, 'created', 1, NULL, ?3, 0, ?4,
                NULL, NULL, ?4, ?5, NULL, NULL)",
            params![
                session_id,
                learning_session_kind_as_str(session_kind),
                planned_count,
                now_unix_ms,
                expires_at_unix_ms,
            ],
        )?;
        insert_learning_session_event(
            &transaction,
            &session_id,
            "created",
            None,
            "created",
            None,
            None,
            now_unix_ms,
            1,
        )?;
        if let Some(source_session_id) = source_session_id {
            for (index, card_id) in
                targetable_session_mistake_ids(&transaction, source_session_id, planned_count)?
                    .into_iter()
                    .enumerate()
            {
                transaction.execute(
                    "INSERT INTO learning_session_targets(session_id, card_id, position)
                     VALUES(?1, ?2, ?3)",
                    params![session_id, card_id, index as u8 + 1],
                )?;
            }
        }
        let snapshot = session_by_id(&transaction, &session_id)?;
        transaction.commit()?;
        Ok(snapshot)
    }

    pub fn present_learning_session(
        &mut self,
        session_id: &str,
        expected_revision: u64,
        now_unix_ms: i64,
    ) -> AppResult<LearningSessionSnapshot> {
        validate_now(now_unix_ms)?;
        validate_session_identifier(session_id)?;
        let transaction = self
            .conn
            .transaction_with_behavior(TransactionBehavior::Immediate)?;
        expire_learning_sessions(&transaction, now_unix_ms)?;
        let session = session_by_id(&transaction, session_id)?;
        if session.state_revision != expected_revision {
            return Err(AppError::Validation(
                "learning session revision is stale".into(),
            ));
        }
        let (event_kind, from_state) = match session.status.as_str() {
            "created" => ("board_presented", "created"),
            "paused" => ("resumed", "paused"),
            _ => {
                return Err(AppError::Validation(
                    "learning session cannot be presented from its current state".into(),
                ))
            }
        };
        let item_id = current_question_target(&transaction, &session)?
            .map(|(card, _)| card.card_id)
            .ok_or_else(|| AppError::Validation("learning session has no current card".into()))?;
        let next_revision = expected_revision.saturating_add(1);
        let expires_at_unix_ms = learning_session_expiry(now_unix_ms)?;
        let changed = transaction.execute(
            "UPDATE learning_sessions SET status = 'active', state_revision = ?3,
                current_item_id = ?4, paused_at_unix_ms = NULL, pause_reason = NULL,
                last_activity_at_unix_ms = ?5, expires_at_unix_ms = ?6,
                ended_at_unix_ms = NULL, exit_reason = NULL
             WHERE session_id = ?1 AND state_revision = ?2 AND status = ?7",
            params![
                session_id,
                expected_revision,
                next_revision,
                item_id,
                now_unix_ms,
                expires_at_unix_ms,
                from_state,
            ],
        )?;
        if changed != 1 {
            return Err(AppError::Validation(
                "learning session revision changed concurrently".into(),
            ));
        }
        insert_learning_session_event(
            &transaction,
            session_id,
            event_kind,
            Some(from_state),
            "active",
            Some(&item_id),
            None,
            now_unix_ms,
            next_revision,
        )?;
        let result = session_by_id(&transaction, session_id)?;
        transaction.commit()?;
        Ok(result)
    }

    pub fn pause_learning_session(
        &mut self,
        session_id: &str,
        expected_revision: u64,
        reason: &str,
        now_unix_ms: i64,
    ) -> AppResult<LearningSessionSnapshot> {
        validate_now(now_unix_ms)?;
        validate_session_identifier(session_id)?;
        validate_pause_reason(reason)?;
        let transaction = self
            .conn
            .transaction_with_behavior(TransactionBehavior::Immediate)?;
        let session = session_by_id(&transaction, session_id)?;
        if session.status != "active" || session.state_revision != expected_revision {
            return Err(AppError::Validation(
                "learning session is not active or its revision is stale".into(),
            ));
        }
        let next_revision = expected_revision.saturating_add(1);
        let expires_at_unix_ms = learning_session_expiry(now_unix_ms)?;
        transaction.execute(
            "UPDATE learning_sessions SET status = 'paused', state_revision = ?3,
                paused_at_unix_ms = ?4, pause_reason = ?5,
                last_activity_at_unix_ms = ?4, expires_at_unix_ms = ?6
             WHERE session_id = ?1 AND state_revision = ?2 AND status = 'active'",
            params![
                session_id,
                expected_revision,
                next_revision,
                now_unix_ms,
                reason,
                expires_at_unix_ms,
            ],
        )?;
        insert_learning_session_event(
            &transaction,
            session_id,
            if reason == "user_pause" {
                "user_paused"
            } else {
                "interrupted"
            },
            Some("active"),
            "paused",
            session.current_item_id.as_deref(),
            Some(reason),
            now_unix_ms,
            next_revision,
        )?;
        let result = session_by_id(&transaction, session_id)?;
        transaction.commit()?;
        Ok(result)
    }

    pub fn abandon_learning_session(
        &mut self,
        session_id: &str,
        expected_revision: u64,
        reason: &str,
        now_unix_ms: i64,
    ) -> AppResult<LearningSessionSnapshot> {
        validate_now(now_unix_ms)?;
        validate_session_identifier(session_id)?;
        if !matches!(
            reason,
            "user_exit" | "content_unavailable" | "presentation_denied"
        ) {
            return Err(AppError::Validation(
                "learning session abandon reason is unsupported".into(),
            ));
        }
        let transaction = self
            .conn
            .transaction_with_behavior(TransactionBehavior::Immediate)?;
        let session = session_by_id(&transaction, session_id)?;
        if !matches!(session.status.as_str(), "created" | "active" | "paused")
            || session.state_revision != expected_revision
        {
            return Err(AppError::Validation(
                "learning session cannot be abandoned or its revision is stale".into(),
            ));
        }
        let from_state = session.status.clone();
        let next_revision = expected_revision.saturating_add(1);
        transaction.execute(
            "UPDATE learning_sessions SET status = 'abandoned', state_revision = ?3,
                paused_at_unix_ms = NULL, pause_reason = NULL,
                last_activity_at_unix_ms = ?4, expires_at_unix_ms = ?4,
                ended_at_unix_ms = ?4, exit_reason = ?5
             WHERE session_id = ?1 AND state_revision = ?2
               AND status IN ('created', 'active', 'paused')",
            params![
                session_id,
                expected_revision,
                next_revision,
                now_unix_ms,
                reason
            ],
        )?;
        insert_learning_session_event(
            &transaction,
            session_id,
            "abandoned",
            Some(&from_state),
            "abandoned",
            session.current_item_id.as_deref(),
            Some(reason),
            now_unix_ms,
            next_revision,
        )?;
        let result = session_by_id(&transaction, session_id)?;
        transaction.commit()?;
        Ok(result)
    }

    pub fn get_resumable_learning_session(
        &mut self,
        now_unix_ms: i64,
    ) -> AppResult<Option<LearningSessionSnapshot>> {
        validate_now(now_unix_ms)?;
        let transaction = self
            .conn
            .transaction_with_behavior(TransactionBehavior::Immediate)?;
        expire_learning_sessions(&transaction, now_unix_ms)?;
        let result = unfinished_session(&transaction)?;
        transaction.commit()?;
        Ok(result)
    }

    pub fn current_learning_card(&self, session_id: &str) -> AppResult<LearningCardDto> {
        let session = session_by_id(&self.conn, session_id)?;
        if session.status != "active" {
            return Err(AppError::Validation(
                "learning session is not active".into(),
            ));
        }
        current_card_for_session(&self.conn, &session)?
            .ok_or_else(|| AppError::Validation("learning session has no current card".into()))
    }

    pub fn current_learning_question(&self, session_id: &str) -> AppResult<LearningQuestionDto> {
        let session = session_by_id(&self.conn, session_id)?;
        if session.status != "active" {
            return Err(AppError::Validation(
                "learning session is not active".into(),
            ));
        }
        let (card, is_remediation) =
            current_question_target(&self.conn, &session)?.ok_or_else(|| {
                AppError::Validation("learning session has no current question".into())
            })?;
        quiz::build_question(&self.conn, session_id, &card, is_remediation)
    }

    pub fn learning_session_summary(
        &self,
        session_id: &str,
        now_unix_ms: i64,
    ) -> AppResult<LearningSessionSummary> {
        validate_now(now_unix_ms)?;
        validate_session_identifier(session_id)?;
        let session = session_by_id(&self.conn, session_id)?;
        let (correct_count, wrong_count, average_response_ms): (u32, u32, Option<u32>) =
            self.conn.query_row(
                "SELECT
                   COALESCE(SUM(CASE WHEN outcome = 'correct' THEN 1 ELSE 0 END), 0),
                   COALESCE(SUM(CASE WHEN outcome = 'incorrect' THEN 1 ELSE 0 END), 0),
                   CAST(ROUND(AVG(response_ms)) AS INTEGER)
                 FROM learning_question_attempts
                 WHERE session_id = ?1 AND is_remediation = 0",
                [session_id],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
            )?;
        let new_count: u32 = self.conn.query_row(
            "SELECT COUNT(DISTINCT current.card_id)
             FROM review_logs current
             WHERE current.session_id = ?1
               AND NOT EXISTS(
                 SELECT 1 FROM review_logs earlier
                 WHERE earlier.card_id = current.card_id
                   AND (earlier.reviewed_at_unix_ms < current.reviewed_at_unix_ms
                     OR (earlier.reviewed_at_unix_ms = current.reviewed_at_unix_ms
                       AND earlier.review_id < current.review_id))
               )",
            [session_id],
            |row| row.get(0),
        )?;
        let answered_count = correct_count.saturating_add(wrong_count);
        let review_count = answered_count.saturating_sub(new_count);
        let ended_at = session.ended_at_unix_ms.unwrap_or(now_unix_ms);
        let duration_seconds = ended_at
            .saturating_sub(session.started_at_unix_ms)
            .max(0)
            .div_euclid(1_000)
            .min(i64::from(u32::MAX)) as u32;
        let targetable_wrong_count =
            targetable_session_mistake_ids(&self.conn, session_id, 10)?.len() as u32;
        Ok(LearningSessionSummary {
            schema_version: 1,
            session,
            correct_count,
            wrong_count,
            new_count,
            review_count,
            duration_seconds,
            average_response_ms,
            targetable_wrong_count,
        })
    }

    pub fn completed_learning_session(
        &self,
        session_id: &str,
        expected_revision: u64,
    ) -> AppResult<LearningSessionSnapshot> {
        validate_session_identifier(session_id)?;
        let session = session_by_id(&self.conn, session_id)?;
        if session.status != "completed" || session.state_revision != expected_revision {
            return Err(AppError::Validation(
                "learning completion presentation is stale or unfinished".into(),
            ));
        }
        Ok(session)
    }

    pub fn answer_learning_question(
        &mut self,
        session_id: &str,
        question_id: &str,
        selected_option_id: &str,
        client_answer_id: &str,
        response_ms: Option<u32>,
        now_unix_ms: i64,
    ) -> AppResult<LearningAnswerResult> {
        validate_now(now_unix_ms)?;
        #[cfg(feature = "runtime-qa")]
        let commit_crash_gate = self.commit_crash_gate.clone();
        quiz::validate_answer_identity(client_answer_id, "answer")?;
        if response_ms.is_some_and(|value| value > 3_600_000) {
            return Err(AppError::Validation(
                "learning answer duration is invalid".into(),
            ));
        }
        let transaction = self
            .conn
            .transaction_with_behavior(TransactionBehavior::Immediate)?;

        if let Some(replay) = replayed_answer(
            &transaction,
            session_id,
            question_id,
            selected_option_id,
            client_answer_id,
        )? {
            transaction.commit()?;
            return Ok(replay);
        }

        let session = session_by_id(&transaction, session_id)?;
        if session.status != "active" || now_unix_ms < session.started_at_unix_ms {
            return Err(AppError::Validation(
                "learning session is not active or its clock is invalid".into(),
            ));
        }
        let (card, is_remediation) =
            current_question_target(&transaction, &session)?.ok_or_else(|| {
                AppError::Validation("learning session has no current question".into())
            })?;
        let question = quiz::build_question(&transaction, session_id, &card, is_remediation)?;
        if question.kind != LearningQuestionKind::MultipleChoice
            || question.question_id != question_id
            || !question
                .options
                .iter()
                .any(|option| option.option_id == selected_option_id)
        {
            return Err(AppError::Validation(
                "learning answer does not match the current question".into(),
            ));
        }
        let correct_option_id = quiz::correct_option_id(question_id, &card.card_id);
        let correct = selected_option_id == correct_option_id;
        let rating = if correct {
            LearningRating::Good
        } else {
            LearningRating::Again
        };

        if is_remediation {
            transaction.execute(
                "UPDATE learning_remediation_queue
                 SET completed_at_unix_ms = ?3
                 WHERE session_id = ?1 AND card_id = ?2 AND completed_at_unix_ms IS NULL",
                params![session_id, card.card_id, now_unix_ms],
            )?;
        } else {
            apply_scheduled_answer(&transaction, &session, &card.card_id, rating, now_unix_ms)?;
        }

        transaction.execute(
            "INSERT INTO learning_question_attempts(
                attempt_id, client_answer_id, question_id, session_id, card_id,
                selected_option_id, correct_option_id, outcome, is_remediation,
                scheduled_rating, response_ms, answered_at_unix_ms
             ) VALUES(?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12)",
            params![
                uuid::Uuid::new_v4().to_string(),
                client_answer_id,
                question_id,
                session_id,
                card.card_id,
                selected_option_id,
                correct_option_id,
                if correct { "correct" } else { "incorrect" },
                is_remediation,
                if is_remediation {
                    None
                } else {
                    Some(learning_rating_as_str(rating))
                },
                response_ms,
                now_unix_ms,
            ],
        )?;

        let progressed = session_by_id(&transaction, session_id)?;
        let originals_complete = progressed.completed_count >= progressed.planned_count;
        let pending_remediation = pending_remediation_count(&transaction, session_id)?;
        if originals_complete && pending_remediation == 0 {
            transaction.execute(
                "UPDATE learning_sessions SET status = 'completed', ended_at_unix_ms = ?2
                 WHERE session_id = ?1 AND status = 'active'",
                params![session_id, now_unix_ms],
            )?;
        }
        let progressed = session_by_id(&transaction, session_id)?;
        let next_item_id = if progressed.status == "active" {
            current_question_target(&transaction, &progressed)?.map(|(card, _)| card.card_id)
        } else {
            None
        };
        let next_revision = session.state_revision.saturating_add(1);
        let expires_at_unix_ms = if progressed.status == "completed" {
            now_unix_ms
        } else {
            learning_session_expiry(now_unix_ms)?
        };
        transaction.execute(
            "UPDATE learning_sessions SET state_revision = ?3, current_item_id = ?4,
                last_activity_at_unix_ms = ?5, expires_at_unix_ms = ?6
             WHERE session_id = ?1 AND state_revision = ?2 AND status IN ('active', 'completed')",
            params![
                session_id,
                session.state_revision,
                next_revision,
                next_item_id,
                now_unix_ms,
                expires_at_unix_ms,
            ],
        )?;
        insert_learning_session_event(
            &transaction,
            session_id,
            "answer_committed",
            Some("active"),
            &progressed.status,
            Some(&card.card_id),
            Some(if correct { "correct" } else { "incorrect" }),
            now_unix_ms,
            next_revision,
        )?;
        if progressed.status == "completed" {
            insert_learning_session_event(
                &transaction,
                session_id,
                "completed",
                Some("active"),
                "completed",
                Some(&card.card_id),
                None,
                now_unix_ms,
                next_revision,
            )?;
        }
        let updated_session = session_by_id(&transaction, session_id)?;
        let result = LearningAnswerResult {
            schema_version: 1,
            question_id: question_id.to_owned(),
            selected_option_id: selected_option_id.to_owned(),
            correct_option_id,
            correct_meaning_zh: quiz::correct_meaning(&card),
            correct,
            is_remediation,
            replayed: false,
            session: updated_session,
        };
        #[cfg(feature = "runtime-qa")]
        if let Some(gate) = &commit_crash_gate {
            gate.mark_answer_commit_pending();
        }
        let commit_result = transaction.commit();
        #[cfg(feature = "runtime-qa")]
        if let Some(gate) = &commit_crash_gate {
            gate.clear_answer_commit_pending();
        }
        commit_result?;
        Ok(result)
    }

    pub fn list_learning_records(
        &self,
        filter: LearningRecordFilter,
        query: &str,
        page: u32,
        page_size: u8,
    ) -> AppResult<LearningRecordPage> {
        if !(1..=50).contains(&page_size) || query.chars().count() > 100 {
            return Err(AppError::Validation(
                "learning record query is outside the supported range".into(),
            ));
        }
        let query = query.trim();
        let pattern = format!("%{}%", escape_like(query));
        let filter_sql = match filter {
            LearningRecordFilter::Mistakes => {
                "ms.state IN ('needs_correction', 'pending_recheck')"
            }
            LearningRecordFilter::Studied => "COALESCE(r.review_count, 0) > 0",
            LearningRecordFilter::New => "s.stage = 'new'",
            LearningRecordFilter::Learning => {
                "s.stage = 'learning' AND COALESCE(ms.state, '') NOT IN ('needs_correction', 'pending_recheck')"
            }
            LearningRecordFilter::Stable => {
                "s.stage = 'stable' AND COALESCE(ms.state, '') NOT IN ('needs_correction', 'pending_recheck')"
            }
            LearningRecordFilter::All => "1 = 1",
        };
        let cte = "WITH mistake_events AS (
                SELECT qa.card_id,
                  CASE
                    WHEN qa.outcome = 'incorrect' AND qa.is_remediation = 0 THEN 'needs_correction'
                    WHEN qa.outcome = 'correct' AND qa.is_remediation = 0 AND se.session_kind = 'daily' THEN 'consolidated'
                    WHEN qa.outcome = 'correct' AND (qa.is_remediation = 1 OR se.session_kind = 'mistakes') THEN 'pending_recheck'
                    ELSE NULL
                  END AS state,
                  ROW_NUMBER() OVER (
                    PARTITION BY qa.card_id
                    ORDER BY qa.answered_at_unix_ms DESC, qa.attempt_id DESC
                  ) AS position
                FROM learning_question_attempts qa
                JOIN learning_sessions se USING(session_id)
                WHERE (qa.outcome = 'incorrect' AND qa.is_remediation = 0)
                   OR (qa.outcome = 'correct' AND (qa.is_remediation = 1 OR se.session_kind IN ('daily', 'mistakes')))
              ), mistake_state AS (
                SELECT card_id, state FROM mistake_events WHERE position = 1
              )";
        let base = format!(
            " FROM learning_cards c
              JOIN card_schedule s USING(card_id)
              JOIN content_packs p ON p.pack_id = c.pack_id AND p.status = 'ready'
              LEFT JOIN (
                SELECT card_id, COUNT(*) AS review_count,
                  MAX(reviewed_at_unix_ms) AS last_studied_at_unix_ms
                FROM review_logs GROUP BY card_id
              ) r USING(card_id)
              LEFT JOIN (
                SELECT card_id,
                  SUM(CASE WHEN outcome = 'correct' THEN 1 ELSE 0 END) AS correct_count,
                  SUM(CASE WHEN outcome = 'incorrect' THEN 1 ELSE 0 END) AS wrong_count,
                  MAX(CASE WHEN outcome = 'incorrect' THEN answered_at_unix_ms END) AS last_wrong_at_unix_ms,
                  MAX(answered_at_unix_ms) AS last_answered_at_unix_ms
                FROM learning_question_attempts GROUP BY card_id
              ) a USING(card_id)
              LEFT JOIN mistake_state ms USING(card_id)
              WHERE {filter_sql}
                AND (?1 = '' OR c.headword LIKE ?2 ESCAPE '\\'
                  OR c.meanings_zh_json LIKE ?2 ESCAPE '\\')"
        );
        let total: u32 = self.conn.query_row(
            &format!("{cte} SELECT COUNT(*){base}"),
            params![query, pattern],
            |row| row.get(0),
        )?;
        let offset = page
            .checked_mul(u32::from(page_size))
            .ok_or_else(|| AppError::Validation("learning record page overflowed".into()))?;
        let sql = format!(
            "{cte} SELECT c.card_id, c.headword, c.phonetic, c.part_of_speech_json,
                c.meanings_zh_json, s.stage, s.due_at_unix_ms,
                COALESCE(r.review_count, 0), COALESCE(a.correct_count, 0),
                COALESCE(a.wrong_count, 0), r.last_studied_at_unix_ms,
                a.last_wrong_at_unix_ms,
                (SELECT outcome FROM learning_question_attempts latest
                 WHERE latest.card_id = c.card_id
                 ORDER BY answered_at_unix_ms DESC, attempt_id DESC LIMIT 1),
                ms.state
             {base}
             ORDER BY
               CASE WHEN ?3 = 'mistakes' THEN COALESCE(a.last_wrong_at_unix_ms, 0) ELSE 0 END DESC,
               COALESCE(r.last_studied_at_unix_ms, 0) DESC,
               c.headword COLLATE NOCASE, c.card_id
             LIMIT ?4 OFFSET ?5"
        );
        let filter_name = match filter {
            LearningRecordFilter::Mistakes => "mistakes",
            LearningRecordFilter::Studied => "studied",
            LearningRecordFilter::New => "new",
            LearningRecordFilter::Learning => "learning",
            LearningRecordFilter::Stable => "stable",
            LearningRecordFilter::All => "all",
        };
        let items = self
            .conn
            .prepare(&sql)?
            .query_map(
                params![query, pattern, filter_name, page_size, offset],
                |row| {
                    Ok((
                        row.get::<_, String>(0)?,
                        row.get::<_, String>(1)?,
                        row.get::<_, Option<String>>(2)?,
                        row.get::<_, String>(3)?,
                        row.get::<_, String>(4)?,
                        row.get::<_, String>(5)?,
                        row.get::<_, i64>(6)?,
                        row.get::<_, u32>(7)?,
                        row.get::<_, u32>(8)?,
                        row.get::<_, u32>(9)?,
                        row.get::<_, Option<i64>>(10)?,
                        row.get::<_, Option<i64>>(11)?,
                        row.get::<_, Option<String>>(12)?,
                        row.get::<_, Option<String>>(13)?,
                    ))
                },
            )?
            .map(|raw| {
                let raw = raw?;
                Ok(LearningRecordItem {
                    card_id: raw.0,
                    headword: raw.1,
                    phonetic: raw.2,
                    part_of_speech: serde_json::from_str(&raw.3)?,
                    meanings_zh: serde_json::from_str(&raw.4)?,
                    stage: parse_stage(&raw.5)?,
                    due_at_unix_ms: raw.6,
                    review_count: raw.7,
                    correct_count: raw.8,
                    wrong_count: raw.9,
                    last_studied_at_unix_ms: raw.10,
                    last_wrong_at_unix_ms: raw.11,
                    latest_outcome: raw.12,
                    mistake_status: match raw.13.as_deref() {
                        Some("needs_correction") => Some(LearningMistakeStatus::NeedsCorrection),
                        Some("pending_recheck") => Some(LearningMistakeStatus::PendingRecheck),
                        Some("consolidated") => Some(LearningMistakeStatus::Consolidated),
                        _ => None,
                    },
                })
            })
            .collect::<AppResult<Vec<_>>>()?;
        Ok(LearningRecordPage {
            schema_version: 1,
            filter,
            query: query.to_owned(),
            page,
            page_size,
            total,
            items,
        })
    }

    pub fn rate_learning_card_with_revision(
        &mut self,
        session_id: &str,
        card_id: &str,
        rating: LearningRating,
        expected_revision: u64,
        now_unix_ms: i64,
    ) -> AppResult<LearningRateResult> {
        validate_now(now_unix_ms)?;
        #[cfg(feature = "runtime-qa")]
        let commit_crash_gate = self.commit_crash_gate.clone();
        let transaction = self
            .conn
            .transaction_with_behavior(TransactionBehavior::Immediate)?;
        let session = session_by_id(&transaction, session_id)?;
        if session.status != "active"
            || session.state_revision != expected_revision
            || now_unix_ms < session.started_at_unix_ms
        {
            return Err(AppError::Validation(
                "learning session is not active, its revision is stale, or its clock is invalid"
                    .into(),
            ));
        }
        let current = current_card_for_session(&transaction, &session)?
            .ok_or_else(|| AppError::Validation("learning session has no current card".into()))?;
        if current.card_id != card_id {
            return Err(AppError::Validation(
                "learning rating does not match the current card".into(),
            ));
        }
        let schedule = transaction.query_row(
            "SELECT reps, lapses, stability, difficulty, last_review_at_unix_ms
             FROM card_schedule WHERE card_id = ?1",
            [card_id],
            |row| {
                Ok(ScheduleInput {
                    reps: row.get(0)?,
                    lapses: row.get(1)?,
                    stability: row.get(2)?,
                    difficulty: row.get(3)?,
                    last_review_at_unix_ms: row.get(4)?,
                })
            },
        )?;
        let outcome = FsrsScheduler::default().schedule(&schedule, rating, now_unix_ms)?;
        let review_id = uuid::Uuid::new_v4().to_string();
        transaction.execute(
            "INSERT INTO review_logs(
                review_id, card_id, session_id, rating, reviewed_at_unix_ms,
                elapsed_days, scheduled_days, stability, difficulty
             ) VALUES(?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)",
            params![
                review_id,
                card_id,
                session_id,
                learning_rating_as_str(rating),
                now_unix_ms,
                outcome.elapsed_days,
                outcome.scheduled_days,
                outcome.stability,
                outcome.difficulty,
            ],
        )?;
        transaction.execute(
            "UPDATE card_schedule SET
                stage = ?2, due_at_unix_ms = ?3, stability = ?4, difficulty = ?5,
                reps = ?6, lapses = ?7, last_review_at_unix_ms = ?8
             WHERE card_id = ?1",
            params![
                card_id,
                learning_stage_as_str(outcome.stage),
                outcome.due_at_unix_ms,
                outcome.stability,
                outcome.difficulty,
                outcome.reps,
                outcome.lapses,
                now_unix_ms,
            ],
        )?;
        let completed_count = session.completed_count.saturating_add(1);
        let completed = completed_count >= session.planned_count
            && pending_remediation_count(&transaction, session_id)? == 0;
        transaction.execute(
            "UPDATE learning_sessions SET
                completed_count = ?2,
                status = CASE WHEN ?3 THEN 'completed' ELSE status END,
                ended_at_unix_ms = CASE WHEN ?3 THEN ?4 ELSE ended_at_unix_ms END,
                state_revision = ?5, last_activity_at_unix_ms = ?4,
                expires_at_unix_ms = ?6
             WHERE session_id = ?1 AND status = 'active' AND state_revision = ?7",
            params![
                session_id,
                completed_count,
                completed,
                now_unix_ms,
                expected_revision.saturating_add(1),
                if completed {
                    now_unix_ms
                } else {
                    learning_session_expiry(now_unix_ms)?
                },
                expected_revision,
            ],
        )?;
        let progressed = session_by_id(&transaction, session_id)?;
        let next_card = if completed {
            None
        } else {
            Some(
                current_question_target(&transaction, &progressed)?
                    .map(|(card, _)| card)
                    .ok_or_else(|| {
                        AppError::Validation("learning session queue became unavailable".into())
                    })?,
            )
        };
        let next_item_id = next_card.as_ref().map(|card| card.card_id.as_str());
        transaction.execute(
            "UPDATE learning_sessions SET current_item_id = ?2 WHERE session_id = ?1",
            params![session_id, next_item_id],
        )?;
        insert_learning_session_event(
            &transaction,
            session_id,
            "answer_committed",
            Some("active"),
            if completed { "completed" } else { "active" },
            Some(card_id),
            Some(learning_rating_as_str(rating)),
            now_unix_ms,
            expected_revision.saturating_add(1),
        )?;
        if completed {
            insert_learning_session_event(
                &transaction,
                session_id,
                "completed",
                Some("active"),
                "completed",
                Some(card_id),
                None,
                now_unix_ms,
                expected_revision.saturating_add(1),
            )?;
        }
        let updated_session = session_by_id(&transaction, session_id)?;
        #[cfg(feature = "runtime-qa")]
        if let Some(gate) = &commit_crash_gate {
            gate.mark_answer_commit_pending();
        }
        let commit_result = transaction.commit();
        #[cfg(feature = "runtime-qa")]
        if let Some(gate) = &commit_crash_gate {
            gate.clear_answer_commit_pending();
        }
        commit_result?;
        Ok(LearningRateResult {
            schema_version: 1,
            session: updated_session,
            next_card,
        })
    }

    #[cfg(test)]
    pub fn rate_learning_card(
        &mut self,
        session_id: &str,
        card_id: &str,
        rating: LearningRating,
        now_unix_ms: i64,
    ) -> AppResult<LearningRateResult> {
        let expected_revision = session_by_id(&self.conn, session_id)?.state_revision;
        self.rate_learning_card_with_revision(
            session_id,
            card_id,
            rating,
            expected_revision,
            now_unix_ms,
        )
    }

    #[cfg(test)]
    pub fn finish_learning_session(
        &mut self,
        session_id: &str,
        exit_reason: &str,
        now_unix_ms: i64,
    ) -> AppResult<LearningSessionSnapshot> {
        let session = session_by_id(&self.conn, session_id)?;
        if exit_reason == "preempted_high_priority" {
            return self.pause_learning_session(
                session_id,
                session.state_revision,
                exit_reason,
                now_unix_ms,
            );
        }
        self.abandon_learning_session(session_id, session.state_revision, exit_reason, now_unix_ms)
    }

    pub fn invitation_data(
        &self,
        now_unix_ms: i64,
        local_day: &str,
    ) -> AppResult<LearningInvitationData> {
        validate_now(now_unix_ms)?;
        if NaiveDate::parse_from_str(local_day, "%Y-%m-%d").is_err() {
            return Err(AppError::Validation(
                "learning invitation local day is invalid".into(),
            ));
        }
        let settings = read_learning_settings(&self.conn)?;
        let due_review_count = count_cards(&self.conn, "stage <> 'new'", now_unix_ms)?;
        let invitations_presented_today: u8 = self.conn.query_row(
            "SELECT COUNT(DISTINCT invitation_id)
             FROM learning_invitation_events e
             WHERE stage = 'presented' AND occurred_at_unix_ms >= ?1 AND occurred_at_unix_ms < ?2
               AND NOT EXISTS(
                 SELECT 1 FROM learning_invitation_events failure
                 WHERE failure.invitation_id = e.invitation_id
                   AND failure.stage = 'delivery_failed'
               )",
            params![
                local_day_bounds_from_text(local_day)?.0,
                local_day_bounds_from_text(local_day)?.1
            ],
            |row| row.get(0),
        )?;
        let last_invitation_at_unix_ms = self.conn.query_row(
            "SELECT MAX(e.occurred_at_unix_ms) FROM learning_invitation_events e
             WHERE stage = 'presented'
               AND NOT EXISTS(
                 SELECT 1 FROM learning_invitation_events failure
                 WHERE failure.invitation_id = e.invitation_id
                   AND failure.stage = 'delivery_failed'
               )",
            [],
            |row| row.get::<_, Option<i64>>(0),
        )?;
        Ok(LearningInvitationData {
            learning_mode: settings.mode,
            due_review_count,
            focus_finished_enabled: settings.focus_finished_enabled,
            scheduled_windows_enabled: settings.scheduled_windows_enabled,
            work_gap_experimental_enabled: settings.work_gap_experimental_enabled,
            invitations_presented_today,
            daily_invitation_limit: settings.daily_invitation_limit,
            last_invitation_at_unix_ms,
            invitation_cooldown_minutes: settings.invitation_cooldown_minutes,
            paused_today: settings.paused_for_local_day.as_deref() == Some(local_day),
        })
    }

    pub fn record_invitation_event(
        &mut self,
        invitation_id: &str,
        trigger_source: LearningTriggerSource,
        stage: &str,
        reason: Option<LearningSuppressionReason>,
        now_unix_ms: i64,
    ) -> AppResult<()> {
        validate_now(now_unix_ms)?;
        validate_invitation_event(invitation_id, stage)?;
        let transaction = self
            .conn
            .transaction_with_behavior(TransactionBehavior::Immediate)?;
        insert_invitation_event(
            &transaction,
            invitation_id,
            trigger_source,
            stage,
            reason,
            now_unix_ms,
        )?;
        transaction.commit()?;
        Ok(())
    }

    pub fn pause_invitations_for_day(
        &mut self,
        local_day: &str,
        now_unix_ms: i64,
    ) -> AppResult<LearningSettings> {
        if NaiveDate::parse_from_str(local_day, "%Y-%m-%d").is_err() {
            return Err(AppError::Validation(
                "learning invitation local day is invalid".into(),
            ));
        }
        self.conn.execute(
            "UPDATE learning_settings SET paused_for_local_day = ?1, updated_at_unix_ms = ?2
             WHERE id = 1",
            params![local_day, now_unix_ms],
        )?;
        read_learning_settings(&self.conn)
    }

    pub fn start_invitation_session(
        &mut self,
        invitation_id: &str,
        trigger_source: LearningTriggerSource,
        now_unix_ms: i64,
    ) -> AppResult<LearningSessionSnapshot> {
        validate_now(now_unix_ms)?;
        validate_invitation_event(invitation_id, "engaged")?;
        let transaction = self
            .conn
            .transaction_with_behavior(TransactionBehavior::Immediate)?;
        expire_learning_sessions(&transaction, now_unix_ms)?;
        if unfinished_session(&transaction)?.is_some() {
            return Err(AppError::Validation(
                "a learning session is already active or resumable".into(),
            ));
        }
        let settings = read_learning_settings(&transaction)?;
        let due_count = count_cards(&transaction, "stage <> 'new'", now_unix_ms)?;
        let planned_count = u32::from(settings.cards_per_session).min(due_count) as u8;
        if planned_count == 0 {
            return Err(AppError::Validation(
                "no due review card is available for this invitation".into(),
            ));
        }
        let session_id = uuid::Uuid::new_v4().to_string();
        let expires_at_unix_ms = learning_session_expiry(now_unix_ms)?;
        transaction.execute(
            "INSERT INTO learning_sessions(
                session_id, entry_source, session_kind, status, state_revision,
                current_item_id, planned_count, completed_count, started_at_unix_ms,
                paused_at_unix_ms, pause_reason, last_activity_at_unix_ms,
                expires_at_unix_ms, ended_at_unix_ms, exit_reason
             ) VALUES(?1, ?2, 'daily', 'created', 1, NULL, ?3, 0, ?4,
                NULL, NULL, ?4, ?5, NULL, NULL)",
            params![
                session_id,
                trigger_source.as_str(),
                planned_count,
                now_unix_ms,
                expires_at_unix_ms,
            ],
        )?;
        insert_learning_session_event(
            &transaction,
            &session_id,
            "created",
            None,
            "created",
            None,
            Some("invitation_engaged"),
            now_unix_ms,
            1,
        )?;
        let result = session_by_id(&transaction, &session_id)?;
        insert_invitation_event(
            &transaction,
            invitation_id,
            trigger_source,
            "engaged",
            None,
            now_unix_ms,
        )?;
        transaction.commit()?;
        Ok(result)
    }

    pub fn interrupt_active_session(
        &mut self,
        now_unix_ms: i64,
    ) -> AppResult<Option<LearningSessionSnapshot>> {
        validate_now(now_unix_ms)?;
        let Some(session) = active_session(&self.conn)? else {
            return Ok(None);
        };
        self.pause_learning_session(
            &session.session_id,
            session.state_revision,
            "preempted_high_priority",
            now_unix_ms,
        )
        .map(Some)
    }

    #[cfg(test)]
    fn connection(&self) -> &Connection {
        &self.conn
    }
}

fn validate_now(now_unix_ms: i64) -> AppResult<()> {
    if now_unix_ms < 0 {
        return Err(AppError::Validation(
            "learning clock is outside the supported range".into(),
        ));
    }
    Ok(())
}

fn learning_session_expiry(now_unix_ms: i64) -> AppResult<i64> {
    now_unix_ms
        .checked_add(LEARNING_SESSION_TTL_MILLIS)
        .ok_or_else(|| AppError::Validation("learning session expiry overflowed".into()))
}

fn validate_pause_reason(reason: &str) -> AppResult<()> {
    if matches!(
        reason,
        "user_pause"
            | "preempted_high_priority"
            | "presentation_denied"
            | "crash_recovery"
            | "migration_recovery"
            | "content_unavailable"
    ) {
        Ok(())
    } else {
        Err(AppError::Validation(
            "learning session pause reason is unsupported".into(),
        ))
    }
}

#[allow(clippy::too_many_arguments)]
fn insert_learning_session_event(
    transaction: &Transaction<'_>,
    session_id: &str,
    event_kind: &str,
    from_state: Option<&str>,
    to_state: &str,
    item_id: Option<&str>,
    reason: Option<&str>,
    occurred_at_unix_ms: i64,
    state_revision: u64,
) -> AppResult<()> {
    transaction.execute(
        "INSERT INTO learning_session_events(
            event_id, session_id, event_kind, from_state, to_state,
            item_id, reason, occurred_at_unix_ms, state_revision
         ) VALUES(?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)",
        params![
            uuid::Uuid::new_v4().to_string(),
            session_id,
            event_kind,
            from_state,
            to_state,
            item_id,
            reason,
            occurred_at_unix_ms,
            state_revision,
        ],
    )?;
    Ok(())
}

fn expire_learning_sessions(transaction: &Transaction<'_>, now_unix_ms: i64) -> AppResult<u32> {
    let candidates = transaction
        .prepare(
            "SELECT session_id, status, state_revision, current_item_id
             FROM learning_sessions
             WHERE status IN ('created', 'active', 'paused')
               AND expires_at_unix_ms <= ?1
             ORDER BY started_at_unix_ms, session_id",
        )?
        .query_map([now_unix_ms], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, u64>(2)?,
                row.get::<_, Option<String>>(3)?,
            ))
        })?
        .collect::<Result<Vec<_>, _>>()?;
    for (session_id, from_state, revision, current_item_id) in &candidates {
        let next_revision = revision.saturating_add(1);
        let changed = transaction.execute(
            "UPDATE learning_sessions SET status = 'expired', state_revision = ?3,
                paused_at_unix_ms = NULL, pause_reason = NULL,
                last_activity_at_unix_ms = ?4, expires_at_unix_ms = ?4,
                ended_at_unix_ms = ?4, exit_reason = 'ttl_elapsed'
             WHERE session_id = ?1 AND state_revision = ?2
               AND status IN ('created', 'active', 'paused')",
            params![session_id, revision, next_revision, now_unix_ms],
        )?;
        if changed == 1 {
            insert_learning_session_event(
                transaction,
                session_id,
                "expired",
                Some(from_state),
                "expired",
                current_item_id.as_deref(),
                Some("ttl_elapsed"),
                now_unix_ms,
                next_revision,
            )?;
        }
    }
    Ok(candidates.len() as u32)
}

fn recover_orphaned_learning_sessions(conn: &mut Connection, now_unix_ms: i64) -> AppResult<()> {
    validate_now(now_unix_ms)?;
    let transaction = conn.transaction_with_behavior(TransactionBehavior::Immediate)?;
    expire_learning_sessions(&transaction, now_unix_ms)?;
    if let Some(session) = active_session(&transaction)? {
        let next_revision = session.state_revision.saturating_add(1);
        let expires_at_unix_ms = learning_session_expiry(now_unix_ms)?;
        transaction.execute(
            "UPDATE learning_sessions SET status = 'paused', state_revision = ?3,
                paused_at_unix_ms = ?4, pause_reason = 'crash_recovery',
                last_activity_at_unix_ms = ?4, expires_at_unix_ms = ?5
             WHERE session_id = ?1 AND state_revision = ?2 AND status = 'active'",
            params![
                session.session_id,
                session.state_revision,
                next_revision,
                now_unix_ms,
                expires_at_unix_ms,
            ],
        )?;
        insert_learning_session_event(
            &transaction,
            &session.session_id,
            "crash_recovered",
            Some("active"),
            "paused",
            session.current_item_id.as_deref(),
            Some("crash_recovery"),
            now_unix_ms,
            next_revision,
        )?;
    }
    transaction.commit()?;
    Ok(())
}

fn validate_invitation_event(invitation_id: &str, stage: &str) -> AppResult<()> {
    if uuid::Uuid::parse_str(invitation_id).is_err()
        || !matches!(
            stage,
            "candidate"
                | "eligible"
                | "claimed"
                | "presented"
                | "engaged"
                | "dismissed"
                | "ignored"
                | "withdrawn"
                | "suppressed"
                | "delivery_failed"
        )
    {
        return Err(AppError::Validation(
            "learning invitation event is invalid".into(),
        ));
    }
    Ok(())
}

fn insert_invitation_event(
    conn: &Connection,
    invitation_id: &str,
    trigger_source: LearningTriggerSource,
    stage: &str,
    reason: Option<LearningSuppressionReason>,
    now_unix_ms: i64,
) -> AppResult<()> {
    conn.execute(
        "DELETE FROM learning_invitation_events WHERE occurred_at_unix_ms < ?1",
        [now_unix_ms.saturating_sub(30 * 86_400_000)],
    )?;
    conn.execute(
        "INSERT INTO learning_invitation_events(
            event_id, invitation_id, trigger_source, stage, reason_code, occurred_at_unix_ms
         ) VALUES(?1, ?2, ?3, ?4, ?5, ?6)",
        params![
            uuid::Uuid::new_v4().to_string(),
            invitation_id,
            trigger_source.as_str(),
            stage,
            reason.map(LearningSuppressionReason::as_str),
            now_unix_ms,
        ],
    )?;
    Ok(())
}

fn count_cards(conn: &Connection, stage_predicate: &str, now_unix_ms: i64) -> AppResult<u32> {
    let sql = format!(
        "SELECT COUNT(*)
         FROM card_schedule s
         JOIN learning_cards c USING(card_id)
         JOIN content_packs p ON p.pack_id = c.pack_id
         WHERE p.status = 'ready' AND s.due_at_unix_ms <= ?1 AND {stage_predicate}"
    );
    conn.query_row(&sql, [now_unix_ms], |row| row.get(0))
        .map_err(Into::into)
}

fn count_remaining_new_cards(conn: &Connection) -> AppResult<u32> {
    conn.query_row(
        "SELECT COUNT(*)
         FROM card_schedule s
         JOIN learning_cards c USING(card_id)
         JOIN content_packs p ON p.pack_id = c.pack_id
         WHERE p.status = 'ready' AND s.stage = 'new'",
        [],
        |row| row.get(0),
    )
    .map_err(Into::into)
}

fn count_unresolved_mistakes(conn: &Connection) -> AppResult<u32> {
    conn.query_row(
        "WITH mistake_events AS (
            SELECT a.card_id,
              CASE
                WHEN a.outcome = 'incorrect' AND a.is_remediation = 0 THEN 'needs_correction'
                WHEN a.outcome = 'correct' AND a.is_remediation = 0 AND s.session_kind = 'daily' THEN 'consolidated'
                WHEN a.outcome = 'correct' AND (a.is_remediation = 1 OR s.session_kind = 'mistakes') THEN 'pending_recheck'
                ELSE NULL
              END AS state,
              ROW_NUMBER() OVER (
                PARTITION BY a.card_id
                ORDER BY a.answered_at_unix_ms DESC, a.attempt_id DESC
              ) AS position
            FROM learning_question_attempts a
            JOIN learning_sessions s USING(session_id)
            WHERE (a.outcome = 'incorrect' AND a.is_remediation = 0)
               OR (a.outcome = 'correct' AND (a.is_remediation = 1 OR s.session_kind IN ('daily', 'mistakes')))
         )
         SELECT COUNT(*)
         FROM mistake_events e
         JOIN learning_cards c USING(card_id)
         JOIN content_packs p ON p.pack_id = c.pack_id AND p.status = 'ready'
         WHERE e.position = 1 AND e.state = 'needs_correction'",
        [],
        |row| row.get(0),
    )
    .map_err(Into::into)
}

fn count_pending_rechecks(conn: &Connection) -> AppResult<u32> {
    conn.query_row(
        "WITH mistake_events AS (
            SELECT a.card_id,
              CASE
                WHEN a.outcome = 'incorrect' AND a.is_remediation = 0 THEN 'needs_correction'
                WHEN a.outcome = 'correct' AND a.is_remediation = 0 AND s.session_kind = 'daily' THEN 'consolidated'
                WHEN a.outcome = 'correct' AND (a.is_remediation = 1 OR s.session_kind = 'mistakes') THEN 'pending_recheck'
                ELSE NULL
              END AS state,
              ROW_NUMBER() OVER (
                PARTITION BY a.card_id
                ORDER BY a.answered_at_unix_ms DESC, a.attempt_id DESC
              ) AS position
            FROM learning_question_attempts a
            JOIN learning_sessions s USING(session_id)
            WHERE (a.outcome = 'incorrect' AND a.is_remediation = 0)
               OR (a.outcome = 'correct' AND (a.is_remediation = 1 OR s.session_kind IN ('daily', 'mistakes')))
         )
         SELECT COUNT(*)
         FROM mistake_events e
         JOIN learning_cards c USING(card_id)
         JOIN content_packs p ON p.pack_id = c.pack_id AND p.status = 'ready'
         WHERE e.position = 1 AND e.state = 'pending_recheck'",
        [],
        |row| row.get(0),
    )
    .map_err(Into::into)
}

fn targetable_session_mistake_ids(
    conn: &Connection,
    source_session_id: &str,
    limit: u8,
) -> AppResult<Vec<String>> {
    let mut statement = conn.prepare(
        "SELECT a.card_id
         FROM learning_question_attempts a
         JOIN learning_cards c USING(card_id)
         JOIN content_packs p ON p.pack_id = c.pack_id AND p.status = 'ready'
         WHERE a.session_id = ?1
           AND a.outcome = 'incorrect' AND a.is_remediation = 0
           AND (
             SELECT CASE
               WHEN latest.outcome = 'incorrect' AND latest.is_remediation = 0 THEN 'needs_correction'
               WHEN latest.outcome = 'correct' AND latest.is_remediation = 0 AND latest_session.session_kind = 'daily' THEN 'consolidated'
               WHEN latest.outcome = 'correct' AND (latest.is_remediation = 1 OR latest_session.session_kind = 'mistakes') THEN 'pending_recheck'
               ELSE NULL
             END
             FROM learning_question_attempts latest
             JOIN learning_sessions latest_session USING(session_id)
             WHERE latest.card_id = a.card_id
               AND ((latest.outcome = 'incorrect' AND latest.is_remediation = 0)
                 OR (latest.outcome = 'correct' AND (latest.is_remediation = 1 OR latest_session.session_kind IN ('daily', 'mistakes'))))
             ORDER BY latest.answered_at_unix_ms DESC, latest.attempt_id DESC
             LIMIT 1
           ) = 'needs_correction'
         GROUP BY a.card_id
         ORDER BY MAX(a.answered_at_unix_ms), a.card_id
         LIMIT ?2",
    )?;
    let result = statement
        .query_map(params![source_session_id, limit], |row| row.get(0))?
        .collect::<Result<Vec<_>, _>>()
        .map_err(Into::into);
    result
}

fn count_tomorrow_due_cards(conn: &Connection, now_unix_ms: i64) -> AppResult<u32> {
    let (_, tomorrow_start) = local_day_bounds(now_unix_ms)?;
    let (_, tomorrow_end) = local_day_bounds(tomorrow_start)?;
    conn.query_row(
        "SELECT COUNT(*)
         FROM card_schedule s
         JOIN learning_cards c USING(card_id)
         JOIN content_packs p ON p.pack_id = c.pack_id AND p.status = 'ready'
         WHERE s.stage <> 'new'
           AND s.due_at_unix_ms >= ?1 AND s.due_at_unix_ms < ?2",
        params![tomorrow_start, tomorrow_end],
        |row| row.get(0),
    )
    .map_err(Into::into)
}

fn average_recent_response_ms(conn: &Connection) -> AppResult<Option<u32>> {
    conn.query_row(
        "SELECT CAST(ROUND(AVG(response_ms)) AS INTEGER)
         FROM (
           SELECT response_ms
           FROM learning_question_attempts
           WHERE is_remediation = 0 AND response_ms BETWEEN 250 AND 180000
           ORDER BY answered_at_unix_ms DESC, attempt_id DESC
           LIMIT 50
         )",
        [],
        |row| row.get(0),
    )
    .map_err(Into::into)
}

fn validate_session_identifier(value: &str) -> AppResult<()> {
    if uuid::Uuid::parse_str(value).is_err() {
        return Err(AppError::Validation(
            "learning session identifier is invalid".into(),
        ));
    }
    Ok(())
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct LearningCardAvailability {
    due_review_count: u32,
    available_new_count: u32,
    new_remaining_count: u32,
    new_studied_today_count: u32,
}

fn learning_card_availability(
    conn: &Connection,
    now_unix_ms: i64,
) -> AppResult<LearningCardAvailability> {
    let (day_start, day_end) = local_day_bounds(now_unix_ms)?;
    let new_used = count_first_reviews_between(conn, day_start, day_end)?;
    let due_review_count = count_cards(conn, "stage <> 'new'", now_unix_ms)?;
    let due_new_count = count_cards(conn, "stage = 'new'", now_unix_ms)?;
    let new_remaining_count = count_remaining_new_cards(conn)?;
    Ok(LearningCardAvailability {
        due_review_count,
        available_new_count: due_new_count,
        new_remaining_count,
        new_studied_today_count: new_used,
    })
}

fn read_learning_settings(conn: &Connection) -> AppResult<LearningSettings> {
    let raw = conn.query_row(
        "SELECT mode, cards_per_session, daily_new_limit, daily_goal, focus_finished_enabled,
            scheduled_windows_enabled, work_gap_experimental_enabled,
            daily_invitation_limit, invitation_cooldown_minutes,
            invitation_ttl_seconds, paused_for_local_day, updated_at_unix_ms
         FROM learning_settings WHERE id = 1",
        [],
        |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, u8>(1)?,
                row.get::<_, u8>(2)?,
                row.get::<_, u8>(3)?,
                row.get::<_, bool>(4)?,
                row.get::<_, bool>(5)?,
                row.get::<_, bool>(6)?,
                row.get::<_, u8>(7)?,
                row.get::<_, u16>(8)?,
                row.get::<_, u8>(9)?,
                row.get::<_, Option<String>>(10)?,
                row.get::<_, i64>(11)?,
            ))
        },
    )?;
    let mode = match raw.0.as_str() {
        "manual_only" => LearningMode::ManualOnly,
        "automatic_opt_in" => LearningMode::AutomaticOptIn,
        _ => {
            return Err(AppError::Validation(
                "learning settings contain an unknown mode".into(),
            ));
        }
    };
    Ok(LearningSettings {
        mode,
        cards_per_session: raw.1,
        daily_new_limit: raw.2,
        daily_goal: raw.3,
        focus_finished_enabled: raw.4,
        scheduled_windows_enabled: raw.5,
        work_gap_experimental_enabled: raw.6,
        daily_invitation_limit: raw.7,
        invitation_cooldown_minutes: raw.8,
        invitation_ttl_seconds: raw.9,
        paused_for_local_day: raw.10,
        updated_at_unix_ms: raw.11,
    })
}

fn validate_learning_settings(settings: &LearningSettings) -> AppResult<()> {
    if !matches!(settings.cards_per_session, 3 | 5 | 10)
        || !matches!(settings.daily_new_limit, 0 | 5 | 10 | 20 | 30)
        || !matches!(settings.daily_goal, 0 | 5 | 10 | 20 | 30 | 50)
        || !(1..=3).contains(&settings.daily_invitation_limit)
        || !matches!(settings.invitation_cooldown_minutes, 60 | 120 | 240)
        || settings.invitation_ttl_seconds != 20
    {
        return Err(AppError::Validation(
            "learning settings are outside the supported range".into(),
        ));
    }
    Ok(())
}

fn learning_mode_as_str(mode: LearningMode) -> &'static str {
    match mode {
        LearningMode::ManualOnly => "manual_only",
        LearningMode::AutomaticOptIn => "automatic_opt_in",
    }
}

fn learning_session_kind_as_str(kind: LearningSessionKind) -> &'static str {
    match kind {
        LearningSessionKind::Daily => "daily",
        LearningSessionKind::Mistakes => "mistakes",
    }
}

fn learning_rating_as_str(rating: LearningRating) -> &'static str {
    match rating {
        LearningRating::Again => "again",
        LearningRating::Hard => "hard",
        LearningRating::Good => "good",
    }
}

fn learning_stage_as_str(stage: LearningStage) -> &'static str {
    match stage {
        LearningStage::New => "new",
        LearningStage::Learning => "learning",
        LearningStage::Stable => "stable",
    }
}

fn parse_entry_source(value: &str) -> AppResult<LearningEntrySource> {
    match value {
        "manual" => Ok(LearningEntrySource::Manual),
        "focus_finished" => Ok(LearningEntrySource::FocusFinished),
        "scheduled_window" => Ok(LearningEntrySource::ScheduledWindow),
        "work_gap_experimental" => Ok(LearningEntrySource::WorkGapExperimental),
        _ => Err(AppError::Validation(
            "learning session contains an unknown entry source".into(),
        )),
    }
}

fn parse_session_kind(value: &str) -> AppResult<LearningSessionKind> {
    match value {
        "daily" => Ok(LearningSessionKind::Daily),
        "mistakes" => Ok(LearningSessionKind::Mistakes),
        _ => Err(AppError::Validation(
            "learning session contains an unknown kind".into(),
        )),
    }
}

fn parse_stage(value: &str) -> AppResult<LearningStage> {
    match value {
        "new" => Ok(LearningStage::New),
        "learning" => Ok(LearningStage::Learning),
        "stable" => Ok(LearningStage::Stable),
        _ => Err(AppError::Validation(
            "learning card contains an unknown stage".into(),
        )),
    }
}

fn active_session(conn: &Connection) -> AppResult<Option<LearningSessionSnapshot>> {
    let id = conn
        .query_row(
            "SELECT session_id FROM learning_sessions
             WHERE status = 'active' ORDER BY started_at_unix_ms DESC LIMIT 1",
            [],
            |row| row.get::<_, String>(0),
        )
        .optional()?;
    id.map(|value| session_by_id(conn, &value)).transpose()
}

fn unfinished_session(conn: &Connection) -> AppResult<Option<LearningSessionSnapshot>> {
    let id = conn
        .query_row(
            "SELECT session_id FROM learning_sessions
             WHERE status IN ('created', 'active', 'paused')
             ORDER BY last_activity_at_unix_ms DESC, started_at_unix_ms DESC LIMIT 1",
            [],
            |row| row.get::<_, String>(0),
        )
        .optional()?;
    id.map(|value| session_by_id(conn, &value)).transpose()
}

fn session_by_id(conn: &Connection, session_id: &str) -> AppResult<LearningSessionSnapshot> {
    let raw = conn
        .query_row(
            "SELECT session_id, entry_source, session_kind, status, state_revision,
                current_item_id, planned_count, completed_count, started_at_unix_ms,
                paused_at_unix_ms, pause_reason, last_activity_at_unix_ms,
                expires_at_unix_ms, ended_at_unix_ms, exit_reason
             FROM learning_sessions WHERE session_id = ?1",
            [session_id],
            |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, String>(2)?,
                    row.get::<_, String>(3)?,
                    row.get::<_, u64>(4)?,
                    row.get::<_, Option<String>>(5)?,
                    row.get::<_, u8>(6)?,
                    row.get::<_, u8>(7)?,
                    row.get::<_, i64>(8)?,
                    row.get::<_, Option<i64>>(9)?,
                    row.get::<_, Option<String>>(10)?,
                    row.get::<_, i64>(11)?,
                    row.get::<_, i64>(12)?,
                    row.get::<_, Option<i64>>(13)?,
                    row.get::<_, Option<String>>(14)?,
                ))
            },
        )
        .optional()?
        .ok_or_else(|| AppError::Validation("learning session does not exist".into()))?;
    Ok(LearningSessionSnapshot {
        schema_version: 1,
        session_id: raw.0,
        entry_source: parse_entry_source(&raw.1)?,
        session_kind: parse_session_kind(&raw.2)?,
        status: raw.3,
        state_revision: raw.4,
        current_item_id: raw.5,
        planned_count: raw.6,
        completed_count: raw.7,
        started_at_unix_ms: raw.8,
        paused_at_unix_ms: raw.9,
        pause_reason: raw.10,
        last_activity_at_unix_ms: raw.11,
        expires_at_unix_ms: raw.12,
        ended_at_unix_ms: raw.13,
        exit_reason: raw.14,
    })
}

fn replayed_answer(
    conn: &Connection,
    requested_session_id: &str,
    requested_question_id: &str,
    requested_option_id: &str,
    client_answer_id: &str,
) -> AppResult<Option<LearningAnswerResult>> {
    let raw = conn
        .query_row(
            "SELECT a.session_id, a.question_id, a.selected_option_id,
                a.correct_option_id, a.outcome, a.is_remediation, c.meanings_zh_json
             FROM learning_question_attempts a
             JOIN learning_cards c ON c.card_id = a.card_id
             WHERE a.client_answer_id = ?1",
            [client_answer_id],
            |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, String>(2)?,
                    row.get::<_, String>(3)?,
                    row.get::<_, String>(4)?,
                    row.get::<_, bool>(5)?,
                    row.get::<_, String>(6)?,
                ))
            },
        )
        .optional()?;
    let Some(raw) = raw else {
        return Ok(None);
    };
    if raw.0 != requested_session_id
        || raw.1 != requested_question_id
        || raw.2 != requested_option_id
    {
        return Err(AppError::Validation(
            "learning answer identifier was reused for different input".into(),
        ));
    }
    let meanings: Vec<String> = serde_json::from_str(&raw.6)?;
    Ok(Some(LearningAnswerResult {
        schema_version: 1,
        question_id: raw.1,
        selected_option_id: raw.2,
        correct_option_id: raw.3,
        correct_meaning_zh: meanings.join("；"),
        correct: raw.4 == "correct",
        is_remediation: raw.5,
        replayed: true,
        session: session_by_id(conn, requested_session_id)?,
    }))
}

fn apply_scheduled_answer(
    conn: &Connection,
    session: &LearningSessionSnapshot,
    card_id: &str,
    rating: LearningRating,
    now_unix_ms: i64,
) -> AppResult<()> {
    let schedule = conn.query_row(
        "SELECT reps, lapses, stability, difficulty, last_review_at_unix_ms
         FROM card_schedule WHERE card_id = ?1",
        [card_id],
        |row| {
            Ok(ScheduleInput {
                reps: row.get(0)?,
                lapses: row.get(1)?,
                stability: row.get(2)?,
                difficulty: row.get(3)?,
                last_review_at_unix_ms: row.get(4)?,
            })
        },
    )?;
    let outcome = FsrsScheduler::default().schedule(&schedule, rating, now_unix_ms)?;
    conn.execute(
        "INSERT INTO review_logs(
            review_id, card_id, session_id, rating, reviewed_at_unix_ms,
            elapsed_days, scheduled_days, stability, difficulty
         ) VALUES(?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)",
        params![
            uuid::Uuid::new_v4().to_string(),
            card_id,
            session.session_id,
            learning_rating_as_str(rating),
            now_unix_ms,
            outcome.elapsed_days,
            outcome.scheduled_days,
            outcome.stability,
            outcome.difficulty,
        ],
    )?;
    conn.execute(
        "UPDATE card_schedule SET
            stage = ?2, due_at_unix_ms = ?3, stability = ?4, difficulty = ?5,
            reps = ?6, lapses = ?7, last_review_at_unix_ms = ?8
         WHERE card_id = ?1",
        params![
            card_id,
            learning_stage_as_str(outcome.stage),
            outcome.due_at_unix_ms,
            outcome.stability,
            outcome.difficulty,
            outcome.reps,
            outcome.lapses,
            now_unix_ms,
        ],
    )?;
    conn.execute(
        "UPDATE learning_sessions SET completed_count = ?2
         WHERE session_id = ?1 AND status = 'active'",
        params![
            session.session_id,
            session.completed_count.saturating_add(1)
        ],
    )?;
    Ok(())
}

fn pending_remediation_count(conn: &Connection, session_id: &str) -> AppResult<u32> {
    conn.query_row(
        "SELECT COUNT(*) FROM learning_remediation_queue
         WHERE session_id = ?1 AND completed_at_unix_ms IS NULL",
        [session_id],
        |row| row.get(0),
    )
    .map_err(Into::into)
}

fn current_question_target(
    conn: &Connection,
    session: &LearningSessionSnapshot,
) -> AppResult<Option<(LearningCardDto, bool)>> {
    if session.completed_count < session.planned_count {
        return Ok(current_card_for_session(conn, session)?.map(|card| (card, false)));
    }
    let raw = conn
        .query_row(
            "SELECT c.card_id, c.headword, c.phonetic, c.part_of_speech_json,
                c.meanings_zh_json, c.word_family_json, s.stage, c.source_ids_json
             FROM learning_remediation_queue q
             JOIN learning_cards c ON c.card_id = q.card_id
             JOIN card_schedule s ON s.card_id = q.card_id
             WHERE q.session_id = ?1 AND q.completed_at_unix_ms IS NULL
             ORDER BY q.position LIMIT 1",
            [&session.session_id],
            |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, Option<String>>(2)?,
                    row.get::<_, String>(3)?,
                    row.get::<_, String>(4)?,
                    row.get::<_, String>(5)?,
                    row.get::<_, String>(6)?,
                    row.get::<_, String>(7)?,
                ))
            },
        )
        .optional()?;
    let Some(raw) = raw else {
        return Ok(None);
    };
    Ok(Some((
        LearningCardDto {
            schema_version: 1,
            card_id: raw.0,
            headword: raw.1,
            phonetic: raw.2,
            part_of_speech: serde_json::from_str(&raw.3)?,
            meanings_zh: serde_json::from_str(&raw.4)?,
            word_family: serde_json::from_str(&raw.5)?,
            stage: parse_stage(&raw.6)?,
            source_ids: serde_json::from_str(&raw.7)?,
        },
        true,
    )))
}

fn escape_like(value: &str) -> String {
    value
        .replace('\\', "\\\\")
        .replace('%', "\\%")
        .replace('_', "\\_")
}

fn current_card_for_session(
    conn: &Connection,
    session: &LearningSessionSnapshot,
) -> AppResult<Option<LearningCardDto>> {
    if session.completed_count >= session.planned_count {
        return Ok(None);
    }
    if session.session_kind == LearningSessionKind::Mistakes {
        return current_mistake_card_for_session(conn, session);
    }
    let raw = conn
        .query_row(
            "SELECT c.card_id, c.headword, c.phonetic, c.part_of_speech_json,
                c.meanings_zh_json, c.word_family_json, s.stage, c.source_ids_json
             FROM card_schedule s
             JOIN learning_cards c USING(card_id)
             JOIN content_packs p ON p.pack_id = c.pack_id
             WHERE p.status = 'ready'
               AND c.created_at_unix_ms <= ?2
               AND s.due_at_unix_ms <= ?2
               AND NOT EXISTS(
                 SELECT 1 FROM review_logs r
                 WHERE r.session_id = ?1 AND r.card_id = c.card_id
               )
             ORDER BY CASE s.stage WHEN 'stable' THEN 0 WHEN 'learning' THEN 1 ELSE 2 END,
                s.due_at_unix_ms, c.card_id
             LIMIT 1",
            params![session.session_id, session.started_at_unix_ms],
            |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, Option<String>>(2)?,
                    row.get::<_, String>(3)?,
                    row.get::<_, String>(4)?,
                    row.get::<_, String>(5)?,
                    row.get::<_, String>(6)?,
                    row.get::<_, String>(7)?,
                ))
            },
        )
        .optional()?;
    let Some(raw) = raw else {
        return Ok(None);
    };
    Ok(Some(LearningCardDto {
        schema_version: 1,
        card_id: raw.0,
        headword: raw.1,
        phonetic: raw.2,
        part_of_speech: serde_json::from_str(&raw.3)?,
        meanings_zh: serde_json::from_str(&raw.4)?,
        word_family: serde_json::from_str(&raw.5)?,
        stage: parse_stage(&raw.6)?,
        source_ids: serde_json::from_str(&raw.7)?,
    }))
}

fn current_mistake_card_for_session(
    conn: &Connection,
    session: &LearningSessionSnapshot,
) -> AppResult<Option<LearningCardDto>> {
    let raw = conn
        .query_row(
            "SELECT c.card_id, c.headword, c.phonetic, c.part_of_speech_json,
                c.meanings_zh_json, c.word_family_json, s.stage, c.source_ids_json
             FROM card_schedule s
             JOIN learning_cards c USING(card_id)
             JOIN content_packs p ON p.pack_id = c.pack_id
             WHERE p.status = 'ready'
               AND c.created_at_unix_ms <= ?2
               AND (
                 SELECT CASE
                   WHEN latest.outcome = 'incorrect' AND latest.is_remediation = 0 THEN 'needs_correction'
                   WHEN latest.outcome = 'correct' AND latest.is_remediation = 0 AND latest_session.session_kind = 'daily' THEN 'consolidated'
                   WHEN latest.outcome = 'correct' AND (latest.is_remediation = 1 OR latest_session.session_kind = 'mistakes') THEN 'pending_recheck'
                   ELSE NULL
                 END
                 FROM learning_question_attempts latest
                 JOIN learning_sessions latest_session USING(session_id)
                 WHERE latest.card_id = c.card_id
                   AND ((latest.outcome = 'incorrect' AND latest.is_remediation = 0)
                     OR (latest.outcome = 'correct' AND (latest.is_remediation = 1 OR latest_session.session_kind IN ('daily', 'mistakes'))))
                 ORDER BY latest.answered_at_unix_ms DESC, latest.attempt_id DESC
                 LIMIT 1
               ) = 'needs_correction'
               AND (
                 NOT EXISTS(SELECT 1 FROM learning_session_targets any_target WHERE any_target.session_id = ?1)
                 OR EXISTS(
                   SELECT 1 FROM learning_session_targets target
                   WHERE target.session_id = ?1 AND target.card_id = c.card_id
                 )
               )
               AND NOT EXISTS(
                 SELECT 1 FROM review_logs r
                 WHERE r.session_id = ?1 AND r.card_id = c.card_id
               )
             ORDER BY
               CASE WHEN s.due_at_unix_ms <= ?2 THEN 0 ELSE 1 END,
               s.lapses DESC,
               (SELECT COUNT(*) FROM learning_question_attempts wrong
                WHERE wrong.card_id = c.card_id AND wrong.outcome = 'incorrect'
                  AND wrong.is_remediation = 0) DESC,
               (SELECT MAX(answered_at_unix_ms) FROM learning_question_attempts wrong
                WHERE wrong.card_id = c.card_id AND wrong.outcome = 'incorrect'
                  AND wrong.is_remediation = 0),
               s.due_at_unix_ms, c.card_id
             LIMIT 1",
            params![session.session_id, session.started_at_unix_ms],
            |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, Option<String>>(2)?,
                    row.get::<_, String>(3)?,
                    row.get::<_, String>(4)?,
                    row.get::<_, String>(5)?,
                    row.get::<_, String>(6)?,
                    row.get::<_, String>(7)?,
                ))
            },
        )
        .optional()?;
    let Some(raw) = raw else {
        return Ok(None);
    };
    Ok(Some(LearningCardDto {
        schema_version: 1,
        card_id: raw.0,
        headword: raw.1,
        phonetic: raw.2,
        part_of_speech: serde_json::from_str(&raw.3)?,
        meanings_zh: serde_json::from_str(&raw.4)?,
        word_family: serde_json::from_str(&raw.5)?,
        stage: parse_stage(&raw.6)?,
        source_ids: serde_json::from_str(&raw.7)?,
    }))
}

fn local_day_bounds(now_unix_ms: i64) -> AppResult<(i64, i64)> {
    let local = Local
        .timestamp_millis_opt(now_unix_ms)
        .single()
        .ok_or_else(|| AppError::Time("learning local day is invalid".into()))?;
    let date = local.date_naive();
    let next_date = date
        .succ_opt()
        .ok_or_else(|| AppError::Time("learning local day overflowed".into()))?;
    let start = Local
        .from_local_datetime(&date.and_hms_opt(0, 0, 0).unwrap())
        .earliest()
        .ok_or_else(|| AppError::Time("learning local midnight is unavailable".into()))?;
    let end = Local
        .from_local_datetime(&next_date.and_hms_opt(0, 0, 0).unwrap())
        .earliest()
        .ok_or_else(|| AppError::Time("learning next local midnight is unavailable".into()))?;
    Ok((start.timestamp_millis(), end.timestamp_millis()))
}

fn local_day_bounds_from_text(local_day: &str) -> AppResult<(i64, i64)> {
    let date = NaiveDate::parse_from_str(local_day, "%Y-%m-%d")
        .map_err(|_| AppError::Validation("learning local day is invalid".into()))?;
    let next_date = date
        .succ_opt()
        .ok_or_else(|| AppError::Time("learning local day overflowed".into()))?;
    let start = Local
        .from_local_datetime(&date.and_hms_opt(0, 0, 0).unwrap())
        .earliest()
        .ok_or_else(|| AppError::Time("learning local midnight is unavailable".into()))?;
    let end = Local
        .from_local_datetime(&next_date.and_hms_opt(0, 0, 0).unwrap())
        .earliest()
        .ok_or_else(|| AppError::Time("learning next local midnight is unavailable".into()))?;
    Ok((start.timestamp_millis(), end.timestamp_millis()))
}

fn count_first_reviews_between(conn: &Connection, start: i64, end: i64) -> AppResult<u32> {
    conn.query_row(
        "SELECT COUNT(*) FROM (
            SELECT card_id FROM review_logs GROUP BY card_id
            HAVING MIN(reviewed_at_unix_ms) >= ?1 AND MIN(reviewed_at_unix_ms) < ?2
         )",
        params![start, end],
        |row| row.get(0),
    )
    .map_err(Into::into)
}

fn initial_stage(progress_hint: ImportProgressHint) -> &'static str {
    match progress_hint {
        ImportProgressHint::New => "new",
        ImportProgressHint::Learning => "learning",
        ImportProgressHint::ReviewKnown => "stable",
    }
}

fn configure_connection(conn: &Connection) -> AppResult<()> {
    conn.pragma_update(None, "foreign_keys", "ON")?;
    conn.busy_timeout(Duration::from_millis(BUSY_TIMEOUT_MILLIS))?;
    conn.pragma_update(None, "journal_mode", "WAL")?;
    conn.pragma_update(None, "synchronous", "NORMAL")?;
    let journal_mode: String = conn.query_row("PRAGMA journal_mode", [], |row| row.get(0))?;
    if !journal_mode.eq_ignore_ascii_case("wal") {
        return Err(AppError::Validation(
            "learning database WAL mode is unavailable".into(),
        ));
    }
    Ok(())
}

fn apply_migrations(conn: &Connection) -> AppResult<()> {
    let schema_version: u32 = conn.query_row("PRAGMA user_version", [], |row| row.get(0))?;
    if schema_version > CURRENT_SCHEMA_VERSION {
        return Err(AppError::Validation(
            "learning database schema is newer than this application".into(),
        ));
    }
    if schema_version == 0 {
        if let Err(error) = conn.execute_batch(INITIAL_MIGRATION) {
            let _ = conn.execute_batch("ROLLBACK");
            return Err(error.into());
        }
    }
    let schema_version: u32 = conn.query_row("PRAGMA user_version", [], |row| row.get(0))?;
    if schema_version == 1 {
        if let Err(error) = conn.execute_batch(EXPORT_METADATA_MIGRATION) {
            let _ = conn.execute_batch("ROLLBACK");
            return Err(error.into());
        }
    }
    let schema_version: u32 = conn.query_row("PRAGMA user_version", [], |row| row.get(0))?;
    if schema_version == 2 {
        if let Err(error) = conn.execute_batch(QUIZ_LEARNING_MIGRATION) {
            let _ = conn.execute_batch("ROLLBACK");
            return Err(error.into());
        }
    }
    let schema_version: u32 = conn.query_row("PRAGMA user_version", [], |row| row.get(0))?;
    if schema_version == 3 {
        if let Err(error) = conn.execute_batch(LEARNING_INSIGHTS_MIGRATION) {
            let _ = conn.execute_batch("ROLLBACK");
            return Err(error.into());
        }
    }
    let schema_version: u32 = conn.query_row("PRAGMA user_version", [], |row| row.get(0))?;
    if schema_version == 4 {
        conn.pragma_update(None, "foreign_keys", "OFF")?;
        let migration_result = conn.execute_batch(LEARNING_ROUNDS_MIGRATION);
        conn.pragma_update(None, "foreign_keys", "ON")?;
        if let Err(error) = migration_result {
            let _ = conn.execute_batch("ROLLBACK");
            return Err(error.into());
        }
    }
    let schema_version: u32 = conn.query_row("PRAGMA user_version", [], |row| row.get(0))?;
    if schema_version == 5 {
        conn.pragma_update(None, "foreign_keys", "OFF")?;
        let migration_result = conn.execute_batch(RESUMABLE_SESSIONS_MIGRATION);
        conn.pragma_update(None, "foreign_keys", "ON")?;
        if let Err(error) = migration_result {
            let _ = conn.execute_batch("ROLLBACK");
            return Err(error.into());
        }
    }
    let schema_version: u32 = conn.query_row("PRAGMA user_version", [], |row| row.get(0))?;
    if schema_version == 6 {
        if let Err(error) = conn.execute_batch(LEGACY_MIGRATION_RECEIPTS_MIGRATION) {
            let _ = conn.execute_batch("ROLLBACK");
            return Err(error.into());
        }
    }
    Ok(())
}

fn validate_connection(conn: &Connection) -> AppResult<()> {
    let schema_version: u32 = conn.query_row("PRAGMA user_version", [], |row| row.get(0))?;
    if schema_version != CURRENT_SCHEMA_VERSION {
        return Err(AppError::Validation(
            "learning database schema is incomplete".into(),
        ));
    }
    let integrity: String = conn.query_row("PRAGMA quick_check", [], |row| row.get(0))?;
    if integrity != "ok" {
        return Err(AppError::Validation(
            "learning database integrity check failed".into(),
        ));
    }
    let foreign_key_error: Option<String> = conn
        .query_row(
            "SELECT 'invalid' FROM pragma_foreign_key_check LIMIT 1",
            [],
            |row| row.get(0),
        )
        .optional()?;
    if foreign_key_error.is_some() {
        return Err(AppError::Validation(
            "learning database foreign key check failed".into(),
        ));
    }
    Ok(())
}

fn validate_backup_database(path: &Path) -> AppResult<()> {
    if !path.is_file() {
        return Err(AppError::Validation(
            "learning backup file does not exist".into(),
        ));
    }
    let connection = Connection::open_with_flags(path, OpenFlags::SQLITE_OPEN_READ_ONLY)?;
    let integrity: String = connection.query_row("PRAGMA quick_check", [], |row| row.get(0))?;
    if integrity != "ok" {
        return Err(AppError::Validation(
            "learning backup integrity check failed".into(),
        ));
    }
    let schema_version: u32 = connection.query_row("PRAGMA user_version", [], |row| row.get(0))?;
    if !(1..=CURRENT_SCHEMA_VERSION).contains(&schema_version) {
        return Err(AppError::Validation(format!(
            "unsupported learning backup schema version {schema_version}"
        )));
    }
    for table in ["learning_settings", "learning_cards", "review_logs"] {
        let exists: bool = connection.query_row(
            "SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?1)",
            [table],
            |row| row.get(0),
        )?;
        if !exists {
            return Err(AppError::Validation(format!(
                "learning backup is missing required table {table}"
            )));
        }
    }
    Ok(())
}

fn initialize_schema_timestamps(conn: &Connection) -> AppResult<()> {
    let now = Utc::now().timestamp_millis();
    conn.execute(
        "UPDATE learning_schema_meta
         SET created_at_unix_ms = CASE WHEN created_at_unix_ms = 0 THEN ?1 ELSE created_at_unix_ms END,
             migrated_at_unix_ms = CASE WHEN migrated_at_unix_ms = 0 THEN ?1 ELSE migrated_at_unix_ms END
         WHERE id = 1",
        [now],
    )?;
    conn.execute(
        "UPDATE learning_settings
         SET updated_at_unix_ms = ?1
         WHERE id = 1 AND updated_at_unix_ms = 0",
        [now],
    )?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use std::collections::BTreeSet;

    use tempfile::tempdir;

    use super::*;
    use crate::learning::import::parse_user_csv;

    #[derive(Debug, PartialEq)]
    struct AnswerTransactionState {
        session: LearningSessionSnapshot,
        schedule: (String, i64, Option<f64>, Option<f64>, u32, u32, Option<i64>),
        review_count: u32,
        attempt_count: u32,
        remediation_count: u32,
        event_count: u32,
    }

    fn answer_transaction_state(
        conn: &Connection,
        session_id: &str,
        card_id: &str,
    ) -> AnswerTransactionState {
        AnswerTransactionState {
            session: session_by_id(conn, session_id).unwrap(),
            schedule: conn
                .query_row(
                    "SELECT stage, due_at_unix_ms, stability, difficulty, reps, lapses,
                        last_review_at_unix_ms
                     FROM card_schedule WHERE card_id = ?1",
                    [card_id],
                    |row| {
                        Ok((
                            row.get(0)?,
                            row.get(1)?,
                            row.get(2)?,
                            row.get(3)?,
                            row.get(4)?,
                            row.get(5)?,
                            row.get(6)?,
                        ))
                    },
                )
                .unwrap(),
            review_count: conn
                .query_row(
                    "SELECT COUNT(*) FROM review_logs WHERE session_id = ?1",
                    [session_id],
                    |row| row.get(0),
                )
                .unwrap(),
            attempt_count: conn
                .query_row(
                    "SELECT COUNT(*) FROM learning_question_attempts WHERE session_id = ?1",
                    [session_id],
                    |row| row.get(0),
                )
                .unwrap(),
            remediation_count: conn
                .query_row(
                    "SELECT COUNT(*) FROM learning_remediation_queue WHERE session_id = ?1",
                    [session_id],
                    |row| row.get(0),
                )
                .unwrap(),
            event_count: conn
                .query_row(
                    "SELECT COUNT(*) FROM learning_session_events WHERE session_id = ?1",
                    [session_id],
                    |row| row.get(0),
                )
                .unwrap(),
        }
    }

    fn assert_learning_database_healthy(conn: &Connection) {
        let integrity: String = conn
            .query_row("PRAGMA integrity_check", [], |row| row.get(0))
            .unwrap();
        let foreign_key_violations: u32 = conn
            .query_row("SELECT COUNT(*) FROM pragma_foreign_key_check", [], |row| {
                row.get(0)
            })
            .unwrap();
        assert_eq!(integrity, "ok");
        assert_eq!(foreign_key_violations, 0);
    }

    fn inject_deferred_answer_commit_failure(conn: &Connection) {
        conn.execute_batch(
            "CREATE TEMP TRIGGER inject_answer_commit_failure
             AFTER INSERT ON learning_session_events
             WHEN NEW.event_kind = 'answer_committed'
             BEGIN
                INSERT INTO learning_session_events(
                    event_id, session_id, event_kind, from_state, to_state,
                    item_id, reason, occurred_at_unix_ms, state_revision
                ) VALUES(
                    'injected-deferred-fk', 'missing-session', 'created', NULL, 'created',
                    NULL, 'commit_failure', NEW.occurred_at_unix_ms, NEW.state_revision
                );
             END;
             PRAGMA defer_foreign_keys = ON;",
        )
        .unwrap();
    }

    fn assert_deferred_foreign_key_commit_failure(error: AppError) {
        let AppError::Database(error) = error else {
            panic!("expected a database commit failure, got {error:?}");
        };
        assert_eq!(
            error.sqlite_error_code(),
            Some(rusqlite::ErrorCode::ConstraintViolation)
        );
        assert!(error.to_string().contains("FOREIGN KEY constraint failed"));
    }

    fn drop_deferred_answer_commit_failure(conn: &Connection) {
        let deferred: bool = conn
            .query_row("PRAGMA defer_foreign_keys", [], |row| row.get(0))
            .unwrap();
        assert!(!deferred);
        conn.execute_batch("DROP TRIGGER inject_answer_commit_failure;")
            .unwrap();
    }

    fn inject_answer_sqlite_full_failure(conn: &Connection) -> i64 {
        conn.execute_batch(
            "CREATE TABLE injected_storage_pressure(payload BLOB NOT NULL);
             PRAGMA wal_checkpoint(TRUNCATE);",
        )
        .unwrap();
        let page_count: i64 = conn
            .query_row("PRAGMA page_count", [], |row| row.get(0))
            .unwrap();
        conn.pragma_update(None, "max_page_count", page_count)
            .unwrap();
        let max_page_count: i64 = conn
            .query_row("PRAGMA max_page_count", [], |row| row.get(0))
            .unwrap();
        assert_eq!(max_page_count, page_count);
        conn.execute_batch(
            "CREATE TEMP TRIGGER inject_answer_sqlite_full
             AFTER INSERT ON learning_session_events
             WHEN NEW.event_kind = 'answer_committed'
             BEGIN
                INSERT INTO injected_storage_pressure(payload) VALUES(zeroblob(1048576));
             END;",
        )
        .unwrap();
        page_count
    }

    fn assert_sqlite_full_failure(error: AppError) {
        let AppError::Database(error) = error else {
            panic!("expected a database-full failure, got {error:?}");
        };
        assert_eq!(
            error.sqlite_error_code(),
            Some(rusqlite::ErrorCode::DiskFull)
        );
        assert!(error.to_string().contains("database or disk is full"));
    }

    fn drop_answer_sqlite_full_failure(conn: &Connection, page_count: i64) {
        let current_page_count: i64 = conn
            .query_row("PRAGMA page_count", [], |row| row.get(0))
            .unwrap();
        assert_eq!(current_page_count, page_count);
        conn.pragma_update(None, "max_page_count", 1_073_741_823_i64)
            .unwrap();
        conn.execute_batch(
            "DROP TRIGGER inject_answer_sqlite_full;
             DROP TABLE injected_storage_pressure;
             PRAGMA wal_checkpoint(TRUNCATE);",
        )
        .unwrap();
    }

    #[test]
    fn fresh_database_has_all_v1_tables_defaults_and_pragmas() {
        let directory = tempdir().unwrap();
        let path = directory.path().join("yuanyuan-learning.sqlite3");
        let repository = LearningRepository::open(&path).unwrap();
        let conn = repository.connection();

        let version: u32 = conn
            .query_row("PRAGMA user_version", [], |row| row.get(0))
            .unwrap();
        assert_eq!(version, CURRENT_SCHEMA_VERSION);
        let tables = conn
            .prepare(
                "SELECT name FROM sqlite_master
                 WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
            )
            .unwrap()
            .query_map([], |row| row.get::<_, String>(0))
            .unwrap()
            .collect::<Result<BTreeSet<_>, _>>()
            .unwrap();
        assert_eq!(
            tables,
            BTreeSet::from([
                "card_schedule".into(),
                "content_packs".into(),
                "content_sources".into(),
                "learning_cards".into(),
                "learning_invitation_events".into(),
                "legacy_learning_migrations".into(),
                "learning_question_attempts".into(),
                "learning_remediation_queue".into(),
                "learning_session_events".into(),
                "learning_session_targets".into(),
                "learning_schema_meta".into(),
                "learning_sessions".into(),
                "learning_settings".into(),
                "review_logs".into(),
            ])
        );
        let settings: (String, i64, i64, i64, i64) = conn
            .query_row(
                "SELECT mode, cards_per_session, daily_new_limit, daily_goal, scheduled_windows_enabled
                 FROM learning_settings WHERE id = 1",
                [],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?, row.get(4)?)),
            )
            .unwrap();
        assert_eq!(settings, ("manual_only".into(), 3, 5, 0, 0));
        let foreign_keys: i64 = conn
            .query_row("PRAGMA foreign_keys", [], |row| row.get(0))
            .unwrap();
        let journal_mode: String = conn
            .query_row("PRAGMA journal_mode", [], |row| row.get(0))
            .unwrap();
        let busy_timeout: i64 = conn
            .query_row("PRAGMA busy_timeout", [], |row| row.get(0))
            .unwrap();
        assert_eq!(foreign_keys, 1);
        assert_eq!(journal_mode.to_ascii_lowercase(), "wal");
        assert_eq!(busy_timeout, BUSY_TIMEOUT_MILLIS as i64);
        assert!(!repository.has_ready_content().unwrap());
        let dashboard = repository.learning_dashboard(1_800_000_000_000).unwrap();
        assert_eq!(dashboard.total_count, 0);
        assert_eq!(dashboard.studied_count, 0);
        assert_eq!(dashboard.days.len(), 7);
    }

    #[test]
    fn schema_constraints_reject_unsupported_learning_settings() {
        let directory = tempdir().unwrap();
        let repository =
            LearningRepository::open(&directory.path().join("learning.sqlite3")).unwrap();
        assert!(repository
            .connection()
            .execute(
                "UPDATE learning_settings SET daily_new_limit = 7 WHERE id = 1",
                []
            )
            .is_err());
        assert!(repository
            .connection()
            .execute(
                "UPDATE learning_settings SET mode = 'automatic_without_consent' WHERE id = 1",
                [],
            )
            .is_err());
    }

    #[test]
    fn newer_database_is_rejected_without_rewriting_its_version() {
        let directory = tempdir().unwrap();
        let path = directory.path().join("future.sqlite3");
        let conn = Connection::open(&path).unwrap();
        conn.pragma_update(None, "user_version", 8).unwrap();
        drop(conn);

        assert!(matches!(
            LearningRepository::open(&path),
            Err(AppError::Validation(_))
        ));
        let conn = Connection::open(&path).unwrap();
        let version: u32 = conn
            .query_row("PRAGMA user_version", [], |row| row.get(0))
            .unwrap();
        assert_eq!(version, 8);
    }

    #[test]
    fn version_one_database_upgrades_export_metadata_transactionally() {
        let directory = tempdir().unwrap();
        let path = directory.path().join("v1.sqlite3");
        let conn = Connection::open(&path).unwrap();
        conn.execute_batch(INITIAL_MIGRATION).unwrap();
        drop(conn);

        let repository = LearningRepository::open(&path).unwrap();
        let version: u32 = repository
            .connection()
            .query_row("PRAGMA user_version", [], |row| row.get(0))
            .unwrap();
        let export_time: Option<i64> = repository
            .connection()
            .query_row(
                "SELECT last_successful_export_at_unix_ms FROM learning_schema_meta WHERE id = 1",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(version, CURRENT_SCHEMA_VERSION);
        assert_eq!(export_time, None);
    }

    #[test]
    fn version_four_round_migration_preserves_sessions_reviews_and_attempts() {
        let directory = tempdir().unwrap();
        let path = directory.path().join("v4-with-progress.sqlite3");
        let conn = Connection::open(&path).unwrap();
        conn.execute_batch(INITIAL_MIGRATION).unwrap();
        conn.execute_batch(EXPORT_METADATA_MIGRATION).unwrap();
        conn.execute_batch(QUIZ_LEARNING_MIGRATION).unwrap();
        conn.execute_batch(LEARNING_INSIGHTS_MIGRATION).unwrap();
        conn.execute_batch(
            "UPDATE learning_settings SET cards_per_session = 1;
             INSERT INTO content_sources(
               source_id, source_kind, version, source_url, license_expression,
               notice_text, content_sha256, created_at_unix_ms
             ) VALUES('source', 'user_import', 'v1', NULL, NULL, NULL,
               'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', 1);
             INSERT INTO content_packs(
               pack_id, stable_namespace, version, title, exam_scope, status,
               manifest_sha256, created_at_unix_ms
             ) VALUES('pack', 'test', 'v1', 'test', 'test', 'ready',
               'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb', 1);
             INSERT INTO learning_cards(
               card_id, pack_id, headword, normalized_headword, phonetic,
               part_of_speech_json, meanings_zh_json, word_family_json,
               frequency_band, sense_basis_json, source_ids_json,
               content_sha256, created_at_unix_ms
             ) VALUES(
               'cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc',
               'pack', 'word', 'word', NULL, '[\"n.\"]', '[\"释义\"]', '[]',
               'unknown', '{}', '[\"source\"]',
               'dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd', 1);
             INSERT INTO card_schedule VALUES(
               'cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc',
               'learning', 2, 1.0, 5.0, 1, 0, 1);
             INSERT INTO learning_sessions VALUES(
               '11111111-1111-4111-8111-111111111111', 'manual', 'completed',
               1, 1, 1, 2, NULL, 'daily');
             INSERT INTO review_logs VALUES(
               '22222222-2222-4222-8222-222222222222',
               'cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc',
               '11111111-1111-4111-8111-111111111111', 'good', 2, 0, 1, 1.0, 5.0);
             INSERT INTO learning_question_attempts VALUES(
               '33333333-3333-4333-8333-333333333333',
               '44444444-4444-4444-8444-444444444444',
               'eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee',
               '11111111-1111-4111-8111-111111111111',
               'cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc',
               'ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff',
               'ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff',
               'correct', 0, 'good', 500, 2);",
        )
        .unwrap();
        drop(conn);

        let repository = LearningRepository::open(&path).unwrap();
        let conn = repository.connection();
        let version: u32 = conn
            .query_row("PRAGMA user_version", [], |row| row.get(0))
            .unwrap();
        assert_eq!(version, CURRENT_SCHEMA_VERSION);
        for table in [
            "learning_sessions",
            "review_logs",
            "learning_question_attempts",
        ] {
            let count: u32 = conn
                .query_row(&format!("SELECT COUNT(*) FROM {table}"), [], |row| {
                    row.get(0)
                })
                .unwrap();
            assert_eq!(count, 1, "{table} was not preserved");
        }
        let migrated_session = session_by_id(conn, "11111111-1111-4111-8111-111111111111").unwrap();
        assert_eq!(migrated_session.status, "completed");
        assert!(migrated_session.pause_reason.is_none());
        let (round_size, daily_goal): (u8, u8) = conn
            .query_row(
                "SELECT cards_per_session, daily_goal FROM learning_settings WHERE id = 1",
                [],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .unwrap();
        assert_eq!((round_size, daily_goal), (3, 0));
    }

    #[test]
    fn version_five_session_states_map_to_resumable_v6_states() {
        let directory = tempdir().unwrap();
        let path = directory.path().join("v5.sqlite3");
        let conn = Connection::open(&path).unwrap();
        configure_connection(&conn).unwrap();
        conn.execute_batch(INITIAL_MIGRATION).unwrap();
        conn.execute_batch(EXPORT_METADATA_MIGRATION).unwrap();
        conn.execute_batch(QUIZ_LEARNING_MIGRATION).unwrap();
        conn.execute_batch(LEARNING_INSIGHTS_MIGRATION).unwrap();
        conn.pragma_update(None, "foreign_keys", "OFF").unwrap();
        conn.execute_batch(LEARNING_ROUNDS_MIGRATION).unwrap();
        conn.pragma_update(None, "foreign_keys", "ON").unwrap();
        conn.execute_batch(
            "INSERT INTO learning_sessions VALUES
              ('v5-active', 'manual', 'daily', 'active', 3, 0, 1800000000000, NULL, NULL),
              ('v5-interrupted', 'manual', 'daily', 'interrupted', 3, 1, 1800000000000, 1800000002000, 'preempted_high_priority'),
              ('v5-completed', 'manual', 'daily', 'completed', 3, 3, 1800000000000, 1800000003000, NULL),
              ('v5-exited', 'manual', 'daily', 'exited', 3, 1, 1800000000000, 1800000002500, 'user_exit');",
        )
        .unwrap();
        drop(conn);

        let repository = LearningRepository::open(&path).unwrap();
        let active = session_by_id(repository.connection(), "v5-active").unwrap();
        let interrupted = session_by_id(repository.connection(), "v5-interrupted").unwrap();
        let completed = session_by_id(repository.connection(), "v5-completed").unwrap();
        let exited = session_by_id(repository.connection(), "v5-exited").unwrap();
        assert_eq!(active.status, "paused");
        assert_eq!(active.pause_reason.as_deref(), Some("migration_recovery"));
        assert_eq!(interrupted.status, "paused");
        assert_eq!(
            interrupted.pause_reason.as_deref(),
            Some("preempted_high_priority")
        );
        assert_eq!(completed.status, "completed");
        assert_eq!(exited.status, "abandoned");
        assert_eq!(exited.exit_reason.as_deref(), Some("user_exit"));
        let event_count: u32 = repository
            .connection()
            .query_row(
                "SELECT COUNT(*) FROM learning_session_events WHERE event_kind = 'migrated'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(event_count, 4);
    }

    #[test]
    fn failed_initial_migration_rolls_back_every_created_object() {
        let directory = tempdir().unwrap();
        let path = directory.path().join("conflict.sqlite3");
        let conn = Connection::open(&path).unwrap();
        conn.execute_batch("CREATE TABLE learning_settings(id INTEGER PRIMARY KEY);")
            .unwrap();
        drop(conn);

        assert!(LearningRepository::open(&path).is_err());
        let conn = Connection::open(&path).unwrap();
        let version: u32 = conn
            .query_row("PRAGMA user_version", [], |row| row.get(0))
            .unwrap();
        let table_count: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM sqlite_master
                 WHERE type = 'table' AND name NOT LIKE 'sqlite_%'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(version, 0);
        assert_eq!(table_count, 1);
    }

    #[test]
    fn learning_open_failure_does_not_damage_the_reminder_repository() {
        let directory = tempdir().unwrap();
        let reminder_path = directory.path().join("yuanyuan-reminder.sqlite3");
        let reminder = crate::repository::Repository::open(&reminder_path).unwrap();
        let invalid_learning_path = directory.path().join("learning-as-directory");
        fs::create_dir(&invalid_learning_path).unwrap();

        assert!(LearningRepository::open(&invalid_learning_path).is_err());
        assert_eq!(reminder.get_settings().unwrap().animation_mode, "always");
    }

    #[test]
    fn corrupt_learning_file_fails_without_touching_the_reminder_repository() {
        let directory = tempdir().unwrap();
        let reminder_path = directory.path().join("yuanyuan-reminder.sqlite3");
        let reminder = crate::repository::Repository::open(&reminder_path).unwrap();
        let learning_path = directory.path().join("yuanyuan-learning.sqlite3");
        fs::write(&learning_path, b"not a sqlite database").unwrap();

        assert!(LearningRepository::open(&learning_path).is_err());
        assert_eq!(reminder.get_settings().unwrap().animation_mode, "always");
        assert_eq!(fs::read(&learning_path).unwrap(), b"not a sqlite database");
    }

    #[test]
    fn wal_keeps_reads_available_during_an_immediate_write_and_checkpoints_cleanly() {
        let directory = tempdir().unwrap();
        let path = directory.path().join("yuanyuan-learning.sqlite3");
        let mut writer = LearningRepository::open(&path).unwrap();
        let reader = LearningRepository::open(&path).unwrap();

        let transaction = writer
            .conn
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .unwrap();
        transaction
            .execute(
                "UPDATE learning_settings SET updated_at_unix_ms = 1234 WHERE id = 1",
                [],
            )
            .unwrap();

        let reader_value_while_locked: i64 = reader
            .conn
            .query_row(
                "SELECT updated_at_unix_ms FROM learning_settings WHERE id = 1",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_ne!(reader_value_while_locked, 1234);

        transaction.commit().unwrap();
        let reader_value_after_commit: i64 = reader
            .conn
            .query_row(
                "SELECT updated_at_unix_ms FROM learning_settings WHERE id = 1",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(reader_value_after_commit, 1234);
        drop(reader);

        let checkpoint: (i64, i64, i64) = writer
            .conn
            .query_row("PRAGMA wal_checkpoint(TRUNCATE)", [], |row| {
                Ok((row.get(0)?, row.get(1)?, row.get(2)?))
            })
            .unwrap();
        assert_eq!(checkpoint.0, 0);
        assert_eq!(checkpoint.1, checkpoint.2);
        let integrity: String = writer
            .conn
            .query_row("PRAGMA quick_check", [], |row| row.get(0))
            .unwrap();
        assert_eq!(integrity, "ok");
    }

    #[test]
    fn confirmed_import_is_atomic_and_preserves_existing_schedule() {
        let directory = tempdir().unwrap();
        let path = directory.path().join("learning.sqlite3");
        let mut repository = LearningRepository::open(&path).unwrap();
        let first = parse_user_csv(
            "headword,meanings_zh,progress_hint,source_label\naddress,地址,learning,考研词表\nknown,熟悉,review_known,考研词表\n"
                .as_bytes(),
        )
        .unwrap();
        let committed = repository.commit_user_import(&first, 1_000).unwrap();
        assert_eq!(committed.imported_count, 2);
        assert_eq!(committed.preserved_schedule_count, 0);
        assert!(repository.has_ready_content().unwrap());
        let schedules = repository
            .connection()
            .prepare(
                "SELECT c.normalized_headword, s.stage, s.due_at_unix_ms
                 FROM learning_cards c JOIN card_schedule s USING(card_id)
                 ORDER BY c.normalized_headword",
            )
            .unwrap()
            .query_map([], |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, i64>(2)?,
                ))
            })
            .unwrap()
            .collect::<Result<Vec<_>, _>>()
            .unwrap();
        assert_eq!(
            schedules,
            vec![
                ("address".into(), "learning".into(), 1_000),
                ("known".into(), "stable".into(), 604_801_000),
            ]
        );

        let address_id = &first.cards[0].card_id;
        repository
            .connection()
            .execute(
                "UPDATE card_schedule SET
                    stage = 'stable', due_at_unix_ms = 900000, stability = 3.5,
                    difficulty = 5.2, reps = 2, lapses = 0,
                    last_review_at_unix_ms = 500000
                 WHERE card_id = ?1",
                [address_id],
            )
            .unwrap();
        let second = parse_user_csv(
            "headword,meanings_zh,progress_hint,source_label\nAddress,处理|地址,new,考研更新词表\nother,其他,new,考研更新词表\n"
                .as_bytes(),
        )
        .unwrap();
        let committed = repository.commit_user_import(&second, 2_000).unwrap();
        assert_eq!(committed.imported_count, 2);
        assert_eq!(committed.preserved_schedule_count, 1);
        let preserved: (String, i64, f64, f64, i64) = repository
            .connection()
            .query_row(
                "SELECT stage, due_at_unix_ms, stability, difficulty, reps
                 FROM card_schedule WHERE card_id = ?1",
                [address_id],
                |row| {
                    Ok((
                        row.get(0)?,
                        row.get(1)?,
                        row.get(2)?,
                        row.get(3)?,
                        row.get(4)?,
                    ))
                },
            )
            .unwrap();
        assert_eq!(preserved, ("stable".into(), 900_000, 3.5, 5.2, 2));
        let pack_statuses = repository
            .connection()
            .prepare("SELECT pack_id, status FROM content_packs ORDER BY pack_id")
            .unwrap()
            .query_map([], |row| {
                Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
            })
            .unwrap()
            .collect::<Result<Vec<_>, _>>()
            .unwrap();
        assert_eq!(
            pack_statuses
                .iter()
                .filter(|(_, status)| status == "ready")
                .count(),
            1
        );
        assert!(pack_statuses
            .iter()
            .any(|(pack_id, status)| pack_id == &first.pack_id && status == "disabled"));
    }

    #[test]
    fn cancelled_import_rolls_back_source_pack_cards_and_old_pack_status() {
        use std::cell::Cell;

        let directory = tempdir().unwrap();
        let path = directory.path().join("learning.sqlite3");
        let mut repository = LearningRepository::open(&path).unwrap();
        let first =
            parse_user_csv("headword,meanings_zh,source_label\nbase,原内容,原词表\n".as_bytes())
                .unwrap();
        repository.commit_user_import(&first, 1_000).unwrap();
        let second = parse_user_csv(
            "headword,meanings_zh,source_label\nalpha,甲,新词表\nbeta,乙,新词表\ngamma,丙,新词表\n"
                .as_bytes(),
        )
        .unwrap();
        let checks = Cell::new(0_u32);
        let error = repository
            .commit_user_import_with_cancellation(&second, 2_000, &|| {
                checks.set(checks.get() + 1);
                checks.get() >= 4
            })
            .unwrap_err();
        assert!(error.to_string().contains("learning import was cancelled"));

        let old_pack_status: String = repository
            .connection()
            .query_row(
                "SELECT status FROM content_packs WHERE pack_id = ?1",
                [&first.pack_id],
                |row| row.get(0),
            )
            .unwrap();
        let new_pack_count: u32 = repository
            .connection()
            .query_row(
                "SELECT COUNT(*) FROM content_packs WHERE pack_id = ?1",
                [&second.pack_id],
                |row| row.get(0),
            )
            .unwrap();
        let new_source_count: u32 = repository
            .connection()
            .query_row(
                "SELECT COUNT(*) FROM content_sources WHERE source_id = ?1",
                [&second.source_id],
                |row| row.get(0),
            )
            .unwrap();
        let card_count: u32 = repository
            .connection()
            .query_row("SELECT COUNT(*) FROM learning_cards", [], |row| row.get(0))
            .unwrap();
        assert_eq!(old_pack_status, "ready");
        assert_eq!(new_pack_count, 0);
        assert_eq!(new_source_count, 0);
        assert_eq!(card_count, 1);
        assert_learning_database_healthy(repository.connection());
    }

    #[test]
    fn mid_import_failure_rolls_back_source_pack_cards_and_old_pack_status() {
        let directory = tempdir().unwrap();
        let path = directory.path().join("learning.sqlite3");
        let mut repository = LearningRepository::open(&path).unwrap();
        let first =
            parse_user_csv("headword,meanings_zh,source_label\nbreak,打破,原词表\n".as_bytes())
                .unwrap();
        repository.commit_user_import(&first, 1_000).unwrap();
        repository
            .connection()
            .execute_batch(
                "CREATE TRIGGER reject_learning_card_update
                 BEFORE UPDATE ON learning_cards
                 WHEN NEW.headword = 'Break'
                 BEGIN
                    SELECT RAISE(ABORT, 'injected import failure');
                 END;",
            )
            .unwrap();
        let second = parse_user_csv(
            "headword,meanings_zh,source_label\nBreak,中断,新词表\nother,其他,新词表\n".as_bytes(),
        )
        .unwrap();
        assert!(repository.commit_user_import(&second, 2_000).is_err());

        let old_status: String = repository
            .connection()
            .query_row(
                "SELECT status FROM content_packs WHERE pack_id = ?1",
                [&first.pack_id],
                |row| row.get(0),
            )
            .unwrap();
        let new_pack_count: i64 = repository
            .connection()
            .query_row(
                "SELECT COUNT(*) FROM content_packs WHERE pack_id = ?1",
                [&second.pack_id],
                |row| row.get(0),
            )
            .unwrap();
        let new_source_count: i64 = repository
            .connection()
            .query_row(
                "SELECT COUNT(*) FROM content_sources WHERE source_id = ?1",
                [&second.source_id],
                |row| row.get(0),
            )
            .unwrap();
        let headword: String = repository
            .connection()
            .query_row(
                "SELECT headword FROM learning_cards WHERE card_id = ?1",
                [&first.cards[0].card_id],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(old_status, "ready");
        assert_eq!(new_pack_count, 0);
        assert_eq!(new_source_count, 0);
        assert_eq!(headword, "break");
    }

    #[test]
    fn manual_session_rates_each_server_selected_card_once_and_completes() {
        const NOW: i64 = 1_800_000_000_000;
        let directory = tempdir().unwrap();
        let mut repository =
            LearningRepository::open(&directory.path().join("learning.sqlite3")).unwrap();
        let import =
            parse_user_csv("headword,meanings_zh\nalpha,甲\nbeta,乙\ngamma,丙\n".as_bytes())
                .unwrap();
        repository.commit_user_import(&import, NOW).unwrap();

        assert!(repository
            .start_manual_session(2, LearningSessionKind::Daily, NOW)
            .is_err());
        let session = repository
            .start_manual_session(3, LearningSessionKind::Daily, NOW)
            .unwrap();
        assert_eq!(session.planned_count, 3);
        assert!(repository
            .start_manual_session(1, LearningSessionKind::Daily, NOW)
            .is_err());
        let mut seen = BTreeSet::new();
        let first = repository
            .current_learning_card(&session.session_id)
            .unwrap();
        assert!(seen.insert(first.card_id.clone()));
        assert!(repository
            .rate_learning_card(
                &session.session_id,
                "not-the-current-card",
                LearningRating::Good,
                NOW + 1,
            )
            .is_err());
        let first_result = repository
            .rate_learning_card(
                &session.session_id,
                &first.card_id,
                LearningRating::Good,
                NOW + 1,
            )
            .unwrap();
        assert_eq!(first_result.session.completed_count, 1);
        let second = first_result.next_card.unwrap();
        assert!(seen.insert(second.card_id.clone()));
        assert!(repository
            .rate_learning_card(
                &session.session_id,
                &first.card_id,
                LearningRating::Again,
                NOW + 2,
            )
            .is_err());
        let second_result = repository
            .rate_learning_card(
                &session.session_id,
                &second.card_id,
                LearningRating::Hard,
                NOW + 2,
            )
            .unwrap();
        let third = second_result.next_card.unwrap();
        assert!(seen.insert(third.card_id.clone()));
        let final_result = repository
            .rate_learning_card(
                &session.session_id,
                &third.card_id,
                LearningRating::Again,
                NOW + 3,
            )
            .unwrap();
        assert_eq!(final_result.session.status, "completed");
        assert_eq!(final_result.session.completed_count, 3);
        assert!(final_result.next_card.is_none());
        assert!(repository
            .rate_learning_card(
                &session.session_id,
                &third.card_id,
                LearningRating::Good,
                NOW + 4,
            )
            .is_err());
        let log_count: u32 = repository
            .connection()
            .query_row("SELECT COUNT(*) FROM review_logs", [], |row| row.get(0))
            .unwrap();
        assert_eq!(log_count, 3);
        let home = repository.learning_home(NOW + 4).unwrap();
        assert_eq!(home.reviews_last_7_days, 3);
        assert_eq!(home.completed_sessions_last_7_days, 1);
        assert!(home.active_session.is_none());
    }

    #[test]
    fn active_learning_stays_unlimited_after_the_legacy_daily_quota_is_reached() {
        const NOW: i64 = 1_800_000_000_000;
        let directory = tempdir().unwrap();
        let mut repository =
            LearningRepository::open(&directory.path().join("learning.sqlite3")).unwrap();
        let import = parse_user_csv(
            concat!(
                "headword,meanings_zh\n",
                "abacus,meaning a\n",
                "badge,meaning b\n",
                "cabin,meaning c\n",
                "dance,meaning d\n",
                "eager,meaning e\n",
                "fabric,meaning f\n",
                "galaxy,meaning g\n",
                "habit,meaning h\n",
                "ideal,meaning i\n",
                "jacket,meaning j\n",
                "karma,meaning k\n",
            )
            .as_bytes(),
        )
        .unwrap();
        repository.commit_user_import(&import, NOW).unwrap();
        repository
            .update_learning_settings(
                LearningSettingsPatch {
                    daily_new_limit: Some(10),
                    ..LearningSettingsPatch::default()
                },
                NOW + 1,
            )
            .unwrap();

        let first_session = repository
            .start_manual_session(5, LearningSessionKind::Daily, NOW + 2)
            .unwrap();
        for offset in 0..5 {
            let card = repository
                .current_learning_card(&first_session.session_id)
                .unwrap();
            repository
                .rate_learning_card(
                    &first_session.session_id,
                    &card.card_id,
                    LearningRating::Good,
                    NOW + 3 + offset,
                )
                .unwrap();
        }

        let partially_remaining = repository.learning_home(NOW + 8).unwrap();
        assert_eq!(partially_remaining.due_count, 0);
        assert_eq!(partially_remaining.new_available_count, 6);
        assert_eq!(partially_remaining.new_remaining_count, 6);
        assert_eq!(partially_remaining.new_studied_today_count, 5);
        let serialized_home = serde_json::to_value(&partially_remaining).unwrap();
        assert_eq!(serialized_home["newAvailableCount"], 6);
        assert_eq!(serialized_home["newRemainingCount"], 6);
        assert_eq!(serialized_home["newStudiedTodayCount"], 5);
        assert!(serialized_home.get("new_remaining_count").is_none());
        assert!(serialized_home.get("new_studied_today_count").is_none());
        let second_session = repository
            .start_manual_session(5, LearningSessionKind::Daily, NOW + 9)
            .unwrap();
        assert_eq!(second_session.planned_count, 5);
        for offset in 0..5 {
            let card = repository
                .current_learning_card(&second_session.session_id)
                .unwrap();
            repository
                .rate_learning_card(
                    &second_session.session_id,
                    &card.card_id,
                    LearningRating::Good,
                    NOW + 10 + offset,
                )
                .unwrap();
        }

        let still_available = repository.learning_home(NOW + 15).unwrap();
        assert_eq!(still_available.due_count, 0);
        assert_eq!(
            count_cards(repository.connection(), "stage = 'new'", NOW + 15).unwrap(),
            1
        );
        assert_eq!(still_available.new_available_count, 1);
        assert_eq!(still_available.new_remaining_count, 1);
        assert_eq!(still_available.new_studied_today_count, 10);
        let third_session = repository
            .start_manual_session(1, LearningSessionKind::Daily, NOW + 16)
            .unwrap();
        assert_eq!(third_session.planned_count, 1);
    }

    #[test]
    fn objective_answer_event_failure_rolls_back_every_write_and_allows_same_id_retry() {
        const NOW: i64 = 1_800_000_050_000;
        let directory = tempdir().unwrap();
        let mut repository =
            LearningRepository::open(&directory.path().join("learning.sqlite3")).unwrap();
        let import = parse_user_csv(
            concat!(
                "headword,meanings_zh,part_of_speech\n",
                "alpha,开始,n.\n",
                "beta,树木,n.\n",
                "gamma,奔跑,v.\n",
                "delta,安静,adj.\n",
            )
            .as_bytes(),
        )
        .unwrap();
        repository.commit_user_import(&import, NOW).unwrap();
        let session = repository
            .start_manual_session(1, LearningSessionKind::Daily, NOW + 1)
            .unwrap();
        let question = repository
            .current_learning_question(&session.session_id)
            .unwrap();
        assert_eq!(question.kind, LearningQuestionKind::MultipleChoice);
        let correct_option_id = quiz::correct_option_id(&question.question_id, &question.card_id);
        let client_answer_id = uuid::Uuid::new_v4().to_string();
        let before = answer_transaction_state(
            repository.connection(),
            &session.session_id,
            &question.card_id,
        );
        assert_eq!(before.review_count, 0);
        assert_eq!(before.attempt_count, 0);
        repository
            .connection()
            .execute_batch(
                "CREATE TEMP TRIGGER reject_answer_committed_event
                 BEFORE INSERT ON learning_session_events
                 WHEN NEW.event_kind = 'answer_committed'
                 BEGIN
                    SELECT RAISE(ABORT, 'injected answer event failure');
                 END;",
            )
            .unwrap();

        assert!(repository
            .answer_learning_question(
                &session.session_id,
                &question.question_id,
                &correct_option_id,
                &client_answer_id,
                Some(500),
                NOW + 2,
            )
            .is_err());
        let after_failure = answer_transaction_state(
            repository.connection(),
            &session.session_id,
            &question.card_id,
        );
        assert_eq!(after_failure, before);
        let restored_question = repository
            .current_learning_question(&session.session_id)
            .unwrap();
        assert_eq!(restored_question.question_id, question.question_id);
        assert_eq!(restored_question.card_id, question.card_id);
        assert_learning_database_healthy(repository.connection());

        repository
            .connection()
            .execute_batch("DROP TRIGGER reject_answer_committed_event;")
            .unwrap();
        let committed = repository
            .answer_learning_question(
                &session.session_id,
                &question.question_id,
                &correct_option_id,
                &client_answer_id,
                Some(500),
                NOW + 3,
            )
            .unwrap();
        assert!(!committed.replayed);
        assert_eq!(committed.session.status, "completed");
        let after_retry = answer_transaction_state(
            repository.connection(),
            &session.session_id,
            &question.card_id,
        );
        assert_eq!(after_retry.review_count, 1);
        assert_eq!(after_retry.attempt_count, 1);
        assert_eq!(after_retry.remediation_count, 0);
        assert_eq!(after_retry.event_count, before.event_count + 2);
        assert_ne!(after_retry.schedule, before.schedule);
        assert_learning_database_healthy(repository.connection());
    }

    #[test]
    fn recall_answer_event_failure_rolls_back_every_write_and_allows_revision_retry() {
        const NOW: i64 = 1_800_000_075_000;
        let directory = tempdir().unwrap();
        let mut repository =
            LearningRepository::open(&directory.path().join("learning.sqlite3")).unwrap();
        let import = parse_user_csv("headword,meanings_zh\nalpha,开始\n".as_bytes()).unwrap();
        repository.commit_user_import(&import, NOW).unwrap();
        let session = repository
            .start_manual_session(1, LearningSessionKind::Daily, NOW + 1)
            .unwrap();
        let card = repository
            .current_learning_card(&session.session_id)
            .unwrap();
        let before =
            answer_transaction_state(repository.connection(), &session.session_id, &card.card_id);
        repository
            .connection()
            .execute_batch(
                "CREATE TEMP TRIGGER reject_answer_committed_event
                 BEFORE INSERT ON learning_session_events
                 WHEN NEW.event_kind = 'answer_committed'
                 BEGIN
                    SELECT RAISE(ABORT, 'injected answer event failure');
                 END;",
            )
            .unwrap();

        assert!(repository
            .rate_learning_card_with_revision(
                &session.session_id,
                &card.card_id,
                LearningRating::Good,
                session.state_revision,
                NOW + 2,
            )
            .is_err());
        let after_failure =
            answer_transaction_state(repository.connection(), &session.session_id, &card.card_id);
        assert_eq!(after_failure, before);
        assert_eq!(
            repository
                .current_learning_card(&session.session_id)
                .unwrap()
                .card_id,
            card.card_id
        );
        assert_learning_database_healthy(repository.connection());

        repository
            .connection()
            .execute_batch("DROP TRIGGER reject_answer_committed_event;")
            .unwrap();
        let committed = repository
            .rate_learning_card_with_revision(
                &session.session_id,
                &card.card_id,
                LearningRating::Good,
                session.state_revision,
                NOW + 3,
            )
            .unwrap();
        assert_eq!(committed.session.status, "completed");
        let after_retry =
            answer_transaction_state(repository.connection(), &session.session_id, &card.card_id);
        assert_eq!(after_retry.review_count, 1);
        assert_eq!(after_retry.attempt_count, 0);
        assert_eq!(after_retry.remediation_count, 0);
        assert_eq!(after_retry.event_count, before.event_count + 2);
        assert_ne!(after_retry.schedule, before.schedule);
        assert_learning_database_healthy(repository.connection());
    }

    #[test]
    fn objective_answer_commit_failure_rolls_back_every_write_and_allows_same_id_retry() {
        const NOW: i64 = 1_800_000_080_000;
        let directory = tempdir().unwrap();
        let mut repository =
            LearningRepository::open(&directory.path().join("learning.sqlite3")).unwrap();
        let import = parse_user_csv(
            concat!(
                "headword,meanings_zh,part_of_speech\n",
                "alpha,开始,n.\n",
                "beta,树木,n.\n",
                "gamma,奔跑,v.\n",
                "delta,安静,adj.\n",
            )
            .as_bytes(),
        )
        .unwrap();
        repository.commit_user_import(&import, NOW).unwrap();
        let session = repository
            .start_manual_session(1, LearningSessionKind::Daily, NOW + 1)
            .unwrap();
        let question = repository
            .current_learning_question(&session.session_id)
            .unwrap();
        assert_eq!(question.kind, LearningQuestionKind::MultipleChoice);
        let correct_option_id = quiz::correct_option_id(&question.question_id, &question.card_id);
        let client_answer_id = uuid::Uuid::new_v4().to_string();
        let before = answer_transaction_state(
            repository.connection(),
            &session.session_id,
            &question.card_id,
        );
        inject_deferred_answer_commit_failure(repository.connection());

        let error = repository
            .answer_learning_question(
                &session.session_id,
                &question.question_id,
                &correct_option_id,
                &client_answer_id,
                Some(500),
                NOW + 2,
            )
            .unwrap_err();
        assert_deferred_foreign_key_commit_failure(error);
        let after_failure = answer_transaction_state(
            repository.connection(),
            &session.session_id,
            &question.card_id,
        );
        assert_eq!(after_failure, before);
        let restored_question = repository
            .current_learning_question(&session.session_id)
            .unwrap();
        assert_eq!(restored_question.question_id, question.question_id);
        assert_eq!(restored_question.card_id, question.card_id);
        assert_learning_database_healthy(repository.connection());

        drop_deferred_answer_commit_failure(repository.connection());
        let committed = repository
            .answer_learning_question(
                &session.session_id,
                &question.question_id,
                &correct_option_id,
                &client_answer_id,
                Some(500),
                NOW + 3,
            )
            .unwrap();
        assert!(!committed.replayed);
        assert_eq!(committed.session.status, "completed");
        let after_retry = answer_transaction_state(
            repository.connection(),
            &session.session_id,
            &question.card_id,
        );
        assert_eq!(after_retry.review_count, 1);
        assert_eq!(after_retry.attempt_count, 1);
        assert_eq!(after_retry.remediation_count, 0);
        assert_eq!(after_retry.event_count, before.event_count + 2);
        assert_ne!(after_retry.schedule, before.schedule);
        assert_learning_database_healthy(repository.connection());
    }

    #[test]
    fn recall_answer_commit_failure_rolls_back_every_write_and_allows_revision_retry() {
        const NOW: i64 = 1_800_000_085_000;
        let directory = tempdir().unwrap();
        let mut repository =
            LearningRepository::open(&directory.path().join("learning.sqlite3")).unwrap();
        let import = parse_user_csv("headword,meanings_zh\nalpha,开始\n".as_bytes()).unwrap();
        repository.commit_user_import(&import, NOW).unwrap();
        let session = repository
            .start_manual_session(1, LearningSessionKind::Daily, NOW + 1)
            .unwrap();
        let card = repository
            .current_learning_card(&session.session_id)
            .unwrap();
        let before =
            answer_transaction_state(repository.connection(), &session.session_id, &card.card_id);
        inject_deferred_answer_commit_failure(repository.connection());

        let error = repository
            .rate_learning_card_with_revision(
                &session.session_id,
                &card.card_id,
                LearningRating::Good,
                session.state_revision,
                NOW + 2,
            )
            .unwrap_err();
        assert_deferred_foreign_key_commit_failure(error);
        let after_failure =
            answer_transaction_state(repository.connection(), &session.session_id, &card.card_id);
        assert_eq!(after_failure, before);
        assert_eq!(
            repository
                .current_learning_card(&session.session_id)
                .unwrap()
                .card_id,
            card.card_id
        );
        assert_learning_database_healthy(repository.connection());

        drop_deferred_answer_commit_failure(repository.connection());
        let committed = repository
            .rate_learning_card_with_revision(
                &session.session_id,
                &card.card_id,
                LearningRating::Good,
                session.state_revision,
                NOW + 3,
            )
            .unwrap();
        assert_eq!(committed.session.status, "completed");
        let after_retry =
            answer_transaction_state(repository.connection(), &session.session_id, &card.card_id);
        assert_eq!(after_retry.review_count, 1);
        assert_eq!(after_retry.attempt_count, 0);
        assert_eq!(after_retry.remediation_count, 0);
        assert_eq!(after_retry.event_count, before.event_count + 2);
        assert_ne!(after_retry.schedule, before.schedule);
        assert_learning_database_healthy(repository.connection());
    }

    #[test]
    fn objective_answer_sqlite_full_rolls_back_every_write_and_allows_same_id_retry() {
        const NOW: i64 = 1_800_000_090_000;
        let directory = tempdir().unwrap();
        let mut repository =
            LearningRepository::open(&directory.path().join("learning.sqlite3")).unwrap();
        let import = parse_user_csv(
            concat!(
                "headword,meanings_zh,part_of_speech\n",
                "alpha,开始,n.\n",
                "beta,树木,n.\n",
                "gamma,奔跑,v.\n",
                "delta,安静,adj.\n",
            )
            .as_bytes(),
        )
        .unwrap();
        repository.commit_user_import(&import, NOW).unwrap();
        let session = repository
            .start_manual_session(1, LearningSessionKind::Daily, NOW + 1)
            .unwrap();
        let question = repository
            .current_learning_question(&session.session_id)
            .unwrap();
        assert_eq!(question.kind, LearningQuestionKind::MultipleChoice);
        let correct_option_id = quiz::correct_option_id(&question.question_id, &question.card_id);
        let client_answer_id = uuid::Uuid::new_v4().to_string();
        let before = answer_transaction_state(
            repository.connection(),
            &session.session_id,
            &question.card_id,
        );
        let page_count = inject_answer_sqlite_full_failure(repository.connection());

        let error = repository
            .answer_learning_question(
                &session.session_id,
                &question.question_id,
                &correct_option_id,
                &client_answer_id,
                Some(500),
                NOW + 2,
            )
            .unwrap_err();
        assert_sqlite_full_failure(error);
        let after_failure = answer_transaction_state(
            repository.connection(),
            &session.session_id,
            &question.card_id,
        );
        assert_eq!(after_failure, before);
        let restored_question = repository
            .current_learning_question(&session.session_id)
            .unwrap();
        assert_eq!(restored_question.question_id, question.question_id);
        assert_eq!(restored_question.card_id, question.card_id);
        assert_learning_database_healthy(repository.connection());

        drop_answer_sqlite_full_failure(repository.connection(), page_count);
        let committed = repository
            .answer_learning_question(
                &session.session_id,
                &question.question_id,
                &correct_option_id,
                &client_answer_id,
                Some(500),
                NOW + 3,
            )
            .unwrap();
        assert!(!committed.replayed);
        assert_eq!(committed.session.status, "completed");
        let after_retry = answer_transaction_state(
            repository.connection(),
            &session.session_id,
            &question.card_id,
        );
        assert_eq!(after_retry.review_count, 1);
        assert_eq!(after_retry.attempt_count, 1);
        assert_eq!(after_retry.remediation_count, 0);
        assert_eq!(after_retry.event_count, before.event_count + 2);
        assert_ne!(after_retry.schedule, before.schedule);
        assert_learning_database_healthy(repository.connection());
    }

    #[test]
    fn recall_answer_sqlite_full_rolls_back_every_write_and_allows_revision_retry() {
        const NOW: i64 = 1_800_000_095_000;
        let directory = tempdir().unwrap();
        let mut repository =
            LearningRepository::open(&directory.path().join("learning.sqlite3")).unwrap();
        let import = parse_user_csv("headword,meanings_zh\nalpha,开始\n".as_bytes()).unwrap();
        repository.commit_user_import(&import, NOW).unwrap();
        let session = repository
            .start_manual_session(1, LearningSessionKind::Daily, NOW + 1)
            .unwrap();
        let card = repository
            .current_learning_card(&session.session_id)
            .unwrap();
        let before =
            answer_transaction_state(repository.connection(), &session.session_id, &card.card_id);
        let page_count = inject_answer_sqlite_full_failure(repository.connection());

        let error = repository
            .rate_learning_card_with_revision(
                &session.session_id,
                &card.card_id,
                LearningRating::Good,
                session.state_revision,
                NOW + 2,
            )
            .unwrap_err();
        assert_sqlite_full_failure(error);
        let after_failure =
            answer_transaction_state(repository.connection(), &session.session_id, &card.card_id);
        assert_eq!(after_failure, before);
        assert_eq!(
            repository
                .current_learning_card(&session.session_id)
                .unwrap()
                .card_id,
            card.card_id
        );
        assert_learning_database_healthy(repository.connection());

        drop_answer_sqlite_full_failure(repository.connection(), page_count);
        let committed = repository
            .rate_learning_card_with_revision(
                &session.session_id,
                &card.card_id,
                LearningRating::Good,
                session.state_revision,
                NOW + 3,
            )
            .unwrap();
        assert_eq!(committed.session.status, "completed");
        let after_retry =
            answer_transaction_state(repository.connection(), &session.session_id, &card.card_id);
        assert_eq!(after_retry.review_count, 1);
        assert_eq!(after_retry.attempt_count, 0);
        assert_eq!(after_retry.remediation_count, 0);
        assert_eq!(after_retry.event_count, before.event_count + 2);
        assert_ne!(after_retry.schedule, before.schedule);
        assert_learning_database_healthy(repository.connection());
    }

    #[test]
    fn objective_quiz_records_one_fsrs_review_and_rechecks_wrong_card_without_double_scheduling() {
        const NOW: i64 = 1_800_000_100_000;
        let directory = tempdir().unwrap();
        let mut repository =
            LearningRepository::open(&directory.path().join("learning.sqlite3")).unwrap();
        let import = parse_user_csv(
            "headword,meanings_zh,part_of_speech\nalpha,开始,n.\nbeta,树木,n.\ngamma,奔跑,v.\ndelta,安静,adj.\n"
                .as_bytes(),
        )
        .unwrap();
        repository.commit_user_import(&import, NOW).unwrap();
        let session = repository
            .start_manual_session(1, LearningSessionKind::Daily, NOW + 1)
            .unwrap();
        let question = repository
            .current_learning_question(&session.session_id)
            .unwrap();
        assert_eq!(question.kind, LearningQuestionKind::MultipleChoice);
        assert!(question.options.len() >= 2);
        let correct_option_id = quiz::correct_option_id(&question.question_id, &question.card_id);
        let wrong_option_id = question
            .options
            .iter()
            .find(|option| option.option_id != correct_option_id)
            .unwrap()
            .option_id
            .clone();
        let first_answer_id = uuid::Uuid::new_v4().to_string();
        let wrong = repository
            .answer_learning_question(
                &session.session_id,
                &question.question_id,
                &wrong_option_id,
                &first_answer_id,
                Some(750),
                NOW + 2,
            )
            .unwrap();
        assert!(!wrong.correct);
        assert!(!wrong.is_remediation);
        assert_eq!(wrong.session.completed_count, 1);
        assert_eq!(wrong.session.status, "completed");
        assert_eq!(
            repository
                .completed_learning_session(&session.session_id, wrong.session.state_revision,)
                .unwrap(),
            wrong.session
        );
        assert!(repository
            .completed_learning_session(
                &session.session_id,
                wrong.session.state_revision.saturating_sub(1),
            )
            .is_err());
        assert!(repository
            .current_learning_question(&session.session_id)
            .is_err());

        let replay = repository
            .answer_learning_question(
                &session.session_id,
                &question.question_id,
                &wrong_option_id,
                &first_answer_id,
                Some(750),
                NOW + 3,
            )
            .unwrap();
        assert!(replay.replayed);
        let review_count: u32 = repository
            .connection()
            .query_row("SELECT COUNT(*) FROM review_logs", [], |row| row.get(0))
            .unwrap();
        let attempt_count: u32 = repository
            .connection()
            .query_row(
                "SELECT COUNT(*) FROM learning_question_attempts",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(review_count, 1);
        assert_eq!(attempt_count, 1);

        let mistakes = repository
            .list_learning_records(LearningRecordFilter::Mistakes, "", 0, 20)
            .unwrap();
        assert_eq!(mistakes.total, 1);
        assert_eq!(mistakes.items[0].wrong_count, 1);
        assert_eq!(mistakes.items[0].correct_count, 0);

        let payload = repository
            .export_payload(portability::LearningExportFormat::NativeJson, NOW + 4)
            .unwrap();
        let exported = portability::parse_native_learning_export(&payload.bytes).unwrap();
        let mut restored =
            LearningRepository::open(&directory.path().join("restored.sqlite3")).unwrap();
        restored.restore_native_export(&exported, NOW + 5).unwrap();
        let restored_mistakes = restored
            .list_learning_records(LearningRecordFilter::Mistakes, "", 0, 20)
            .unwrap();
        assert_eq!(restored_mistakes.total, 1);
        assert_eq!(restored_mistakes.items[0].wrong_count, 1);
    }

    #[test]
    fn wrong_only_session_moves_through_correction_recheck_and_consolidation() {
        const NOW: i64 = 1_800_001_000_000;
        let directory = tempdir().unwrap();
        let mut repository =
            LearningRepository::open(&directory.path().join("learning.sqlite3")).unwrap();
        let import = parse_user_csv(
            concat!(
                "headword,meanings_zh,part_of_speech\n",
                "alpha,开始,n.\n",
                "beta,树木,n.\n",
                "gamma,奔跑,v.\n",
                "delta,安静,adj.\n",
            )
            .as_bytes(),
        )
        .unwrap();
        repository.commit_user_import(&import, NOW).unwrap();

        let daily = repository
            .start_manual_session(1, LearningSessionKind::Daily, NOW + 1)
            .unwrap();
        let original = repository
            .current_learning_question(&daily.session_id)
            .unwrap();
        let correct_option = quiz::correct_option_id(&original.question_id, &original.card_id);
        let wrong_option = original
            .options
            .iter()
            .find(|option| option.option_id != correct_option)
            .unwrap()
            .option_id
            .clone();
        let wrong = repository
            .answer_learning_question(
                &daily.session_id,
                &original.question_id,
                &wrong_option,
                &uuid::Uuid::new_v4().to_string(),
                Some(800),
                NOW + 2,
            )
            .unwrap();
        assert!(!wrong.correct);
        assert!(!wrong.is_remediation);
        assert_eq!(wrong.session.status, "completed");
        let first_summary = repository
            .learning_session_summary(&daily.session_id, NOW + 3)
            .unwrap();
        assert_eq!(first_summary.wrong_count, 1);
        assert_eq!(first_summary.targetable_wrong_count, 1);

        let after_wrong = repository.learning_home(NOW + 4).unwrap();
        assert_eq!(after_wrong.mistake_count, 1);
        assert_eq!(after_wrong.pending_recheck_count, 0);
        let mistakes = repository
            .list_learning_records(LearningRecordFilter::Mistakes, "", 0, 20)
            .unwrap();
        assert_eq!(mistakes.total, 1);
        assert_eq!(mistakes.items[0].card_id, original.card_id);
        assert_eq!(
            mistakes.items[0].mistake_status,
            Some(LearningMistakeStatus::NeedsCorrection)
        );
        let first_dashboard = repository.learning_dashboard(NOW + 4).unwrap();
        assert_eq!(first_dashboard.total_count, 4);
        assert_eq!(first_dashboard.new_count, 3);
        assert_eq!(first_dashboard.mistake_count, 1);
        assert_eq!(first_dashboard.corrected_mistake_count, 0);
        assert_eq!(first_dashboard.first_answer_count_7_days, 1);
        assert_eq!(first_dashboard.first_answer_correct_count_7_days, 0);
        assert_eq!(first_dashboard.days.last().unwrap().new_count, 1);
        assert_eq!(first_dashboard.days.last().unwrap().review_count, 1);

        let mistake_session = repository
            .start_manual_session_scoped(
                3,
                LearningSessionKind::Mistakes,
                Some(&daily.session_id),
                NOW + 5,
            )
            .unwrap();
        assert_eq!(mistake_session.session_kind, LearningSessionKind::Mistakes);
        assert_eq!(mistake_session.planned_count, 1);
        let retried = repository
            .current_learning_question(&mistake_session.session_id)
            .unwrap();
        assert_eq!(retried.card_id, original.card_id);
        assert!(!retried.is_remediation);
        let retry_correct = quiz::correct_option_id(&retried.question_id, &retried.card_id);
        let completed = repository
            .answer_learning_question(
                &mistake_session.session_id,
                &retried.question_id,
                &retry_correct,
                &uuid::Uuid::new_v4().to_string(),
                Some(450),
                NOW + 6,
            )
            .unwrap();
        assert!(completed.correct);
        assert_eq!(completed.session.status, "completed");

        let corrected_home = repository.learning_home(NOW + 7).unwrap();
        assert_eq!(corrected_home.mistake_count, 0);
        assert_eq!(corrected_home.pending_recheck_count, 1);
        assert_eq!(corrected_home.new_studied_today_count, 1);
        assert_eq!(corrected_home.new_available_count, 3);
        assert_eq!(
            repository
                .list_learning_records(LearningRecordFilter::Mistakes, "", 0, 20)
                .unwrap()
                .total,
            1
        );
        let all = repository
            .list_learning_records(LearningRecordFilter::All, "alpha", 0, 20)
            .unwrap();
        assert_eq!(all.total, 1);
        assert_eq!(
            all.items[0].mistake_status,
            Some(LearningMistakeStatus::PendingRecheck)
        );
        let corrected_dashboard = repository.learning_dashboard(NOW + 7).unwrap();
        assert_eq!(corrected_dashboard.mistake_count, 0);
        assert_eq!(corrected_dashboard.pending_recheck_count, 1);
        assert_eq!(corrected_dashboard.corrected_mistake_count, 0);
        assert_eq!(corrected_dashboard.first_answer_count_7_days, 2);
        assert_eq!(corrected_dashboard.first_answer_correct_count_7_days, 1);
        assert_eq!(corrected_dashboard.days.last().unwrap().new_count, 1);
        assert_eq!(corrected_dashboard.days.last().unwrap().review_count, 2);
        assert!(matches!(
            repository.start_manual_session(1, LearningSessionKind::Mistakes, NOW + 8),
            Err(AppError::Validation(message))
                if message == "no unresolved learning mistakes are currently available"
        ));

        let later = NOW + 86_400_000 + 10;
        let verification_session = repository
            .start_manual_session(1, LearningSessionKind::Daily, later)
            .unwrap();
        let verification = repository
            .current_learning_question(&verification_session.session_id)
            .unwrap();
        assert_eq!(verification.card_id, original.card_id);
        let verification_correct =
            quiz::correct_option_id(&verification.question_id, &verification.card_id);
        repository
            .answer_learning_question(
                &verification_session.session_id,
                &verification.question_id,
                &verification_correct,
                &uuid::Uuid::new_v4().to_string(),
                Some(420),
                later + 1,
            )
            .unwrap();
        let consolidated = repository
            .list_learning_records(LearningRecordFilter::All, "alpha", 0, 20)
            .unwrap();
        assert_eq!(
            consolidated.items[0].mistake_status,
            Some(LearningMistakeStatus::Consolidated)
        );
        let final_dashboard = repository.learning_dashboard(later + 2).unwrap();
        assert_eq!(final_dashboard.pending_recheck_count, 0);
        assert_eq!(final_dashboard.corrected_mistake_count, 1);
    }

    #[test]
    fn dashboard_and_wordbook_keep_stable_cards_in_the_stable_bucket() {
        const NOW: i64 = 1_800_002_000_000;
        let directory = tempdir().unwrap();
        let mut repository =
            LearningRepository::open(&directory.path().join("learning.sqlite3")).unwrap();
        let import = parse_user_csv(
            "headword,meanings_zh,progress_hint\nknown,已掌握,review_known\nnewword,新词,new\n"
                .as_bytes(),
        )
        .unwrap();
        repository.commit_user_import(&import, NOW).unwrap();

        let stable = repository
            .list_learning_records(LearningRecordFilter::Stable, "", 0, 20)
            .unwrap();
        assert_eq!(stable.total, 1);
        assert_eq!(stable.items[0].headword, "known");
        assert_eq!(stable.items[0].mistake_status, None);
        let dashboard = repository.learning_dashboard(NOW + 1).unwrap();
        assert_eq!(dashboard.total_count, 2);
        assert_eq!(dashboard.studied_count, 1);
        assert_eq!(dashboard.new_count, 1);
        assert_eq!(dashboard.learning_count, 0);
        assert_eq!(dashboard.mistake_count, 0);
        assert_eq!(dashboard.stable_count, 1);
        assert_eq!(
            dashboard.new_count
                + dashboard.learning_count
                + dashboard.mistake_count
                + dashboard.pending_recheck_count
                + dashboard.stable_count,
            dashboard.total_count
        );
    }

    #[test]
    fn resumable_session_transitions_are_revision_checked_and_append_only() {
        const NOW: i64 = 1_800_010_000_000;
        let directory = tempdir().unwrap();
        let mut repository =
            LearningRepository::open(&directory.path().join("learning.sqlite3")).unwrap();
        let import = parse_user_csv("headword,meanings_zh\nalpha,开始\n".as_bytes()).unwrap();
        repository.commit_user_import(&import, NOW).unwrap();

        let created = repository
            .create_manual_session_scoped(1, LearningSessionKind::Daily, None, NOW + 1)
            .unwrap();
        assert_eq!(created.status, "created");
        assert_eq!(created.state_revision, 1);
        assert!(created.current_item_id.is_none());
        assert!(repository
            .present_learning_session(&created.session_id, 0, NOW + 2)
            .is_err());

        let active = repository
            .present_learning_session(&created.session_id, 1, NOW + 2)
            .unwrap();
        assert_eq!(active.status, "active");
        assert_eq!(active.state_revision, 2);
        let original_item_id = active.current_item_id.clone().unwrap();
        assert!(repository
            .pause_learning_session(&active.session_id, 1, "user_pause", NOW + 3)
            .is_err());

        let paused = repository
            .pause_learning_session(&active.session_id, 2, "user_pause", NOW + 3)
            .unwrap();
        assert_eq!(paused.status, "paused");
        assert_eq!(paused.state_revision, 3);
        assert_eq!(
            paused.current_item_id.as_deref(),
            Some(original_item_id.as_str())
        );
        assert!(repository
            .current_learning_question(&paused.session_id)
            .is_err());
        assert!(repository
            .pause_learning_session(&paused.session_id, 3, "user_pause", NOW + 4)
            .is_err());

        let resumed = repository
            .present_learning_session(&paused.session_id, 3, NOW + 5)
            .unwrap();
        assert_eq!(resumed.status, "active");
        assert_eq!(resumed.state_revision, 4);
        assert_eq!(
            resumed.current_item_id.as_deref(),
            Some(original_item_id.as_str())
        );

        let abandoned = repository
            .abandon_learning_session(&resumed.session_id, 4, "user_exit", NOW + 6)
            .unwrap();
        assert_eq!(abandoned.status, "abandoned");
        assert_eq!(abandoned.state_revision, 5);
        assert!(repository
            .present_learning_session(&abandoned.session_id, 5, NOW + 7)
            .is_err());

        let events = repository
            .connection()
            .prepare(
                "SELECT event_kind FROM learning_session_events
                 WHERE session_id = ?1 ORDER BY state_revision, occurred_at_unix_ms, event_id",
            )
            .unwrap()
            .query_map([&abandoned.session_id], |row| row.get::<_, String>(0))
            .unwrap()
            .collect::<Result<Vec<_>, _>>()
            .unwrap();
        assert_eq!(
            events,
            vec![
                "created",
                "board_presented",
                "user_paused",
                "resumed",
                "abandoned"
            ]
        );
    }

    #[test]
    fn reopening_an_active_session_pauses_it_and_preserves_the_original_question() {
        let now = Utc::now().timestamp_millis().saturating_sub(5_000);
        let directory = tempdir().unwrap();
        let path = directory.path().join("learning.sqlite3");
        let (session_id, question_id, item_id) = {
            let mut repository = LearningRepository::open(&path).unwrap();
            let import =
                parse_user_csv("headword,meanings_zh\nalpha,开始\nbeta,树木\n".as_bytes()).unwrap();
            repository.commit_user_import(&import, now).unwrap();
            let session = repository
                .start_manual_session(1, LearningSessionKind::Daily, now + 1)
                .unwrap();
            let question = repository
                .current_learning_question(&session.session_id)
                .unwrap();
            (
                session.session_id,
                question.question_id,
                session.current_item_id.unwrap(),
            )
        };

        let mut reopened = LearningRepository::open(&path).unwrap();
        let resumable = reopened
            .get_resumable_learning_session(Utc::now().timestamp_millis())
            .unwrap()
            .unwrap();
        assert_eq!(resumable.session_id, session_id);
        assert_eq!(resumable.status, "paused");
        assert_eq!(resumable.pause_reason.as_deref(), Some("crash_recovery"));
        assert_eq!(resumable.current_item_id.as_deref(), Some(item_id.as_str()));
        let resumed = reopened
            .present_learning_session(
                &resumable.session_id,
                resumable.state_revision,
                Utc::now().timestamp_millis(),
            )
            .unwrap();
        let restored_question = reopened
            .current_learning_question(&resumed.session_id)
            .unwrap();
        assert_eq!(restored_question.question_id, question_id);
        let attempt_count: u32 = reopened
            .connection()
            .query_row(
                "SELECT COUNT(*) FROM learning_question_attempts",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(attempt_count, 0);
    }

    #[test]
    fn elapsed_ttl_expires_unanswered_cards_without_changing_schedule() {
        const NOW: i64 = 1_800_020_000_000;
        let directory = tempdir().unwrap();
        let mut repository =
            LearningRepository::open(&directory.path().join("learning.sqlite3")).unwrap();
        let import = parse_user_csv("headword,meanings_zh\nalpha,开始\n".as_bytes()).unwrap();
        repository.commit_user_import(&import, NOW).unwrap();
        let created = repository
            .create_manual_session_scoped(1, LearningSessionKind::Daily, None, NOW + 1)
            .unwrap();
        assert!(repository
            .get_resumable_learning_session(NOW + 1 + LEARNING_SESSION_TTL_MILLIS + 1)
            .unwrap()
            .is_none());
        let expired = session_by_id(repository.connection(), &created.session_id).unwrap();
        assert_eq!(expired.status, "expired");
        assert_eq!(expired.exit_reason.as_deref(), Some("ttl_elapsed"));
        let schedule: (u32, u32, Option<i64>) = repository
            .connection()
            .query_row(
                "SELECT reps, lapses, last_review_at_unix_ms FROM card_schedule",
                [],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
            )
            .unwrap();
        assert_eq!(schedule, (0, 0, None));
    }

    #[test]
    fn settings_round_sizes_soft_goal_and_session_exit_fail_closed() {
        const NOW: i64 = 1_800_000_000_000;
        let directory = tempdir().unwrap();
        let mut repository =
            LearningRepository::open(&directory.path().join("learning.sqlite3")).unwrap();
        let import = parse_user_csv(
            "headword,meanings_zh,progress_hint\nnewword,新词,new\nreviewword,复习,learning\n"
                .as_bytes(),
        )
        .unwrap();
        repository.commit_user_import(&import, NOW).unwrap();
        let settings = repository
            .update_learning_settings(
                LearningSettingsPatch {
                    daily_new_limit: Some(0),
                    daily_goal: Some(20),
                    cards_per_session: Some(10),
                    ..LearningSettingsPatch::default()
                },
                NOW + 1,
            )
            .unwrap();
        assert_eq!(settings.daily_new_limit, 0);
        assert_eq!(settings.daily_goal, 20);
        assert_eq!(settings.cards_per_session, 10);
        assert!(repository
            .update_learning_settings(
                LearningSettingsPatch {
                    cards_per_session: Some(2),
                    ..LearningSettingsPatch::default()
                },
                NOW + 2,
            )
            .is_err());
        assert!(repository
            .update_learning_settings(
                LearningSettingsPatch {
                    scheduled_windows_enabled: Some(true),
                    ..LearningSettingsPatch::default()
                },
                NOW + 2,
            )
            .is_err());
        let session = repository
            .start_manual_session(3, LearningSessionKind::Daily, NOW + 3)
            .unwrap();
        assert_eq!(session.planned_count, 2);
        let current = repository
            .current_learning_card(&session.session_id)
            .unwrap();
        assert_eq!(current.headword, "reviewword");
        assert!(repository
            .finish_learning_session(&session.session_id, "made_up", NOW + 4)
            .is_err());
        let exited = repository
            .finish_learning_session(&session.session_id, "user_exit", NOW + 4)
            .unwrap();
        assert_eq!(exited.status, "abandoned");
        assert!(repository
            .finish_learning_session(&session.session_id, "user_exit", NOW + 5)
            .is_err());
        assert!(repository
            .rate_learning_card(
                &session.session_id,
                &current.card_id,
                LearningRating::Good,
                NOW + 6,
            )
            .is_err());
    }

    #[test]
    fn accepting_invitation_commits_session_and_engaged_event_atomically() {
        const NOW: i64 = 1_800_000_000_000;
        let directory = tempdir().unwrap();
        let mut repository =
            LearningRepository::open(&directory.path().join("learning.sqlite3")).unwrap();
        let import = parse_user_csv(
            "headword,meanings_zh,progress_hint\nreview,review meaning,learning\n".as_bytes(),
        )
        .unwrap();
        repository.commit_user_import(&import, NOW).unwrap();
        repository
            .connection()
            .execute_batch(
                "CREATE TRIGGER reject_engaged_event
                 BEFORE INSERT ON learning_invitation_events
                 WHEN NEW.stage = 'engaged'
                 BEGIN
                    SELECT RAISE(ABORT, 'injected engaged event failure');
                 END;",
            )
            .unwrap();
        let invitation_id = uuid::Uuid::new_v4().to_string();

        assert!(repository
            .start_invitation_session(
                &invitation_id,
                LearningTriggerSource::FocusFinished,
                NOW + 1,
            )
            .is_err());
        let session_count: u32 = repository
            .connection()
            .query_row("SELECT COUNT(*) FROM learning_sessions", [], |row| {
                row.get(0)
            })
            .unwrap();
        let engaged_count: u32 = repository
            .connection()
            .query_row(
                "SELECT COUNT(*) FROM learning_invitation_events WHERE stage = 'engaged'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(session_count, 0);
        assert_eq!(engaged_count, 0);

        repository
            .connection()
            .execute_batch("DROP TRIGGER reject_engaged_event;")
            .unwrap();
        let session = repository
            .start_invitation_session(
                &invitation_id,
                LearningTriggerSource::FocusFinished,
                NOW + 2,
            )
            .unwrap();
        assert_eq!(session.entry_source, LearningEntrySource::FocusFinished);
        assert_eq!(session.status, "created");
        let engaged_count: u32 = repository
            .connection()
            .query_row(
                "SELECT COUNT(*) FROM learning_invitation_events
                 WHERE invitation_id = ?1 AND stage = 'engaged'",
                [&invitation_id],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(engaged_count, 1);
    }

    #[test]
    fn failed_delivery_does_not_consume_invitation_budget_or_cooldown() {
        const NOW: i64 = 1_800_000_000_000;
        let directory = tempdir().unwrap();
        let mut repository =
            LearningRepository::open(&directory.path().join("learning.sqlite3")).unwrap();
        let failed_id = uuid::Uuid::new_v4().to_string();
        repository
            .record_invitation_event(
                &failed_id,
                LearningTriggerSource::FocusFinished,
                "presented",
                None,
                NOW,
            )
            .unwrap();
        repository
            .record_invitation_event(
                &failed_id,
                LearningTriggerSource::FocusFinished,
                "delivery_failed",
                None,
                NOW + 1,
            )
            .unwrap();
        let local_day = Local
            .timestamp_millis_opt(NOW)
            .single()
            .unwrap()
            .format("%Y-%m-%d")
            .to_string();
        let after_failure = repository.invitation_data(NOW + 2, &local_day).unwrap();
        assert_eq!(after_failure.invitations_presented_today, 0);
        assert_eq!(after_failure.last_invitation_at_unix_ms, None);

        let delivered_id = uuid::Uuid::new_v4().to_string();
        repository
            .record_invitation_event(
                &delivered_id,
                LearningTriggerSource::FocusFinished,
                "presented",
                None,
                NOW + 3,
            )
            .unwrap();
        let after_delivery = repository.invitation_data(NOW + 4, &local_day).unwrap();
        assert_eq!(after_delivery.invitations_presented_today, 1);
        assert_eq!(after_delivery.last_invitation_at_unix_ms, Some(NOW + 3));

        repository
            .pause_invitations_for_day(&local_day, NOW + 5)
            .unwrap();
        assert!(
            repository
                .invitation_data(NOW + 6, &local_day)
                .unwrap()
                .paused_today
        );
    }
}
