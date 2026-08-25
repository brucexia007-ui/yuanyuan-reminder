use std::{collections::HashSet, path::Path};

use rusqlite::{params, Connection, TransactionBehavior};
use serde::{Deserialize, Serialize};

use crate::error::{AppError, AppResult};

use super::{
    learning_mode_as_str, learning_rating_as_str, learning_session_kind_as_str,
    learning_stage_as_str, read_learning_settings, validate_learning_settings, validate_now,
    LearningEntrySource, LearningRating, LearningRepository, LearningSessionKind, LearningSettings,
    LearningStage,
};

pub const MAX_NATIVE_IMPORT_BYTES: usize = 256 * 1024 * 1024;
const MAX_CARDS: usize = 10_000;
const MAX_REVIEW_LOGS: usize = 1_000_000;
const MAX_QUESTION_ATTEMPTS: usize = 1_000_000;
const NATIVE_EXPORT_KIND: &str = "yuanyuan.learning.export";

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum LearningExportFormat {
    NativeJson,
    CardsCsv,
    ReviewLogsCsv,
}

impl LearningExportFormat {
    pub fn extension(self) -> &'static str {
        match self {
            Self::NativeJson => "json",
            Self::CardsCsv | Self::ReviewLogsCsv => "csv",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum LearningDeleteScope {
    ProgressOnly,
    AllLearningData,
}

impl LearningDeleteScope {
    pub fn confirmation(self) -> &'static str {
        match self {
            Self::ProgressOnly => "CLEAR LEARNING PROGRESS",
            Self::AllLearningData => "DELETE ALL LEARNING DATA",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LearningExportResult {
    pub schema_version: u32,
    pub status: &'static str,
    pub format: LearningExportFormat,
    pub record_count: u32,
    pub bytes: u64,
    pub exported_at_unix_ms: Option<i64>,
    pub selected_path_returned: bool,
}

impl LearningExportResult {
    pub fn cancelled(format: LearningExportFormat) -> Self {
        Self {
            schema_version: 1,
            status: "cancelled",
            format,
            record_count: 0,
            bytes: 0,
            exported_at_unix_ms: None,
            selected_path_returned: false,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LearningDeleteResult {
    pub schema_version: u32,
    pub scope: LearningDeleteScope,
    pub kept_card_count: u32,
    pub deleted_review_count: u32,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LearningDataSummary {
    pub schema_version: u32,
    pub card_count: u32,
    pub review_count: u32,
    pub last_successful_export_at_unix_ms: Option<i64>,
    pub sources: Vec<LearningSourceSummary>,
    pub packs: Vec<LearningPackSummary>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LearningSourceSummary {
    pub source_id: String,
    pub source_kind: String,
    pub version: String,
    pub source_url: Option<String>,
    pub license_expression: Option<String>,
    pub notice_text: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LearningPackSummary {
    pub pack_id: String,
    pub title: String,
    pub exam_scope: String,
    pub status: String,
}

#[derive(Debug, Clone)]
pub struct LearningExportPayload {
    pub bytes: Vec<u8>,
    pub record_count: u32,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct NativeLearningExport {
    schema_version: u32,
    kind: String,
    exported_at_unix_ms: i64,
    settings: LearningSettings,
    sources: Vec<NativeSource>,
    packs: Vec<NativePack>,
    cards: Vec<NativeCard>,
    schedules: Vec<NativeSchedule>,
    sessions: Vec<NativeSession>,
    review_logs: Vec<NativeReviewLog>,
    #[serde(default)]
    question_attempts: Vec<NativeQuestionAttempt>,
    #[serde(default)]
    remediation_queue: Vec<NativeRemediationItem>,
    #[serde(default)]
    session_targets: Vec<NativeSessionTarget>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct NativeSource {
    source_id: String,
    source_kind: String,
    version: String,
    source_url: Option<String>,
    license_expression: Option<String>,
    notice_text: Option<String>,
    content_sha256: String,
    created_at_unix_ms: i64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct NativePack {
    pack_id: String,
    stable_namespace: String,
    version: String,
    title: String,
    exam_scope: String,
    status: String,
    manifest_sha256: String,
    created_at_unix_ms: i64,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct NativeCard {
    card_id: String,
    pack_id: String,
    headword: String,
    normalized_headword: String,
    phonetic: Option<String>,
    part_of_speech: Vec<String>,
    meanings_zh: Vec<String>,
    word_family: Vec<String>,
    frequency_band: String,
    sense_basis: serde_json::Value,
    source_ids: Vec<String>,
    content_sha256: String,
    created_at_unix_ms: i64,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct NativeSchedule {
    card_id: String,
    stage: LearningStage,
    due_at_unix_ms: i64,
    stability: Option<f64>,
    difficulty: Option<f64>,
    reps: u32,
    lapses: u32,
    last_review_at_unix_ms: Option<i64>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct NativeSession {
    session_id: String,
    entry_source: LearningEntrySource,
    #[serde(default)]
    session_kind: LearningSessionKind,
    status: String,
    planned_count: u8,
    completed_count: u8,
    started_at_unix_ms: i64,
    ended_at_unix_ms: Option<i64>,
    exit_reason: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct NativeReviewLog {
    review_id: String,
    card_id: String,
    session_id: String,
    rating: LearningRating,
    reviewed_at_unix_ms: i64,
    elapsed_days: u32,
    scheduled_days: u32,
    stability: f64,
    difficulty: f64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct NativeQuestionAttempt {
    attempt_id: String,
    client_answer_id: String,
    question_id: String,
    session_id: String,
    card_id: String,
    selected_option_id: String,
    correct_option_id: String,
    outcome: String,
    is_remediation: bool,
    scheduled_rating: Option<LearningRating>,
    response_ms: Option<u32>,
    answered_at_unix_ms: i64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct NativeRemediationItem {
    session_id: String,
    card_id: String,
    position: u8,
    created_at_unix_ms: i64,
    completed_at_unix_ms: Option<i64>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct NativeSessionTarget {
    session_id: String,
    card_id: String,
    position: u8,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct NativeImportPreviewData {
    pub card_count: u32,
    pub new_count: u32,
    pub learning_count: u32,
    pub review_known_count: u32,
    pub sample_headwords: Vec<String>,
}

impl NativeLearningExport {
    pub fn preview(&self) -> NativeImportPreviewData {
        let mut new_count = 0;
        let mut learning_count = 0;
        let mut review_known_count = 0;
        for schedule in &self.schedules {
            match schedule.stage {
                LearningStage::New => new_count += 1,
                LearningStage::Learning => learning_count += 1,
                LearningStage::Stable => review_known_count += 1,
            }
        }
        NativeImportPreviewData {
            card_count: self.cards.len() as u32,
            new_count,
            learning_count,
            review_known_count,
            sample_headwords: self
                .cards
                .iter()
                .take(3)
                .map(|card| card.headword.clone())
                .collect(),
        }
    }
}

pub fn parse_native_learning_export(bytes: &[u8]) -> AppResult<NativeLearningExport> {
    if bytes.is_empty() || bytes.len() > MAX_NATIVE_IMPORT_BYTES {
        return Err(AppError::Validation(
            "native learning import size is outside the allowed range".into(),
        ));
    }
    std::str::from_utf8(bytes)
        .map_err(|_| AppError::Validation("native learning import must be UTF-8".into()))?;
    let value: NativeLearningExport = serde_json::from_slice(bytes)
        .map_err(|_| AppError::Validation("native learning JSON is invalid".into()))?;
    validate_native_export(&value)?;
    Ok(value)
}

impl LearningRepository {
    pub fn export_payload(
        &mut self,
        format: LearningExportFormat,
        now_unix_ms: i64,
    ) -> AppResult<LearningExportPayload> {
        validate_now(now_unix_ms)?;
        let transaction = self
            .conn
            .transaction_with_behavior(TransactionBehavior::Deferred)?;
        let bundle = read_native_export(&transaction, now_unix_ms)?;
        transaction.commit()?;
        match format {
            LearningExportFormat::NativeJson => {
                let mut bytes = serde_json::to_vec_pretty(&bundle)?;
                bytes.push(b'\n');
                if bytes.len() > MAX_NATIVE_IMPORT_BYTES {
                    return Err(AppError::Validation(
                        "native learning export exceeds the supported size".into(),
                    ));
                }
                Ok(LearningExportPayload {
                    record_count: bundle
                        .cards
                        .len()
                        .saturating_add(bundle.review_logs.len())
                        .saturating_add(bundle.question_attempts.len())
                        as u32,
                    bytes,
                })
            }
            LearningExportFormat::CardsCsv => export_cards_csv(&bundle),
            LearningExportFormat::ReviewLogsCsv => export_reviews_csv(&bundle),
        }
    }

    pub fn mark_export_succeeded(&mut self, now_unix_ms: i64) -> AppResult<()> {
        validate_now(now_unix_ms)?;
        self.conn.execute(
            "UPDATE learning_schema_meta
             SET last_successful_export_at_unix_ms = ?1 WHERE id = 1",
            [now_unix_ms],
        )?;
        Ok(())
    }

    pub fn data_summary(&self) -> AppResult<LearningDataSummary> {
        let card_count = self
            .conn
            .query_row("SELECT COUNT(*) FROM learning_cards", [], |row| row.get(0))?;
        let review_count = self
            .conn
            .query_row("SELECT COUNT(*) FROM review_logs", [], |row| row.get(0))?;
        let last_successful_export_at_unix_ms = self.conn.query_row(
            "SELECT last_successful_export_at_unix_ms FROM learning_schema_meta WHERE id = 1",
            [],
            |row| row.get(0),
        )?;
        let sources = self
            .conn
            .prepare(
                "SELECT source_id, source_kind, version, source_url, license_expression, notice_text
                 FROM content_sources ORDER BY created_at_unix_ms, source_id",
            )?
            .query_map([], |row| {
                Ok(LearningSourceSummary {
                    source_id: row.get(0)?,
                    source_kind: row.get(1)?,
                    version: row.get(2)?,
                    source_url: row.get(3)?,
                    license_expression: row.get(4)?,
                    notice_text: row.get(5)?,
                })
            })?
            .collect::<Result<Vec<_>, _>>()?;
        let packs = self
            .conn
            .prepare(
                "SELECT pack_id, title, exam_scope, status
                 FROM content_packs ORDER BY created_at_unix_ms, pack_id",
            )?
            .query_map([], |row| {
                Ok(LearningPackSummary {
                    pack_id: row.get(0)?,
                    title: row.get(1)?,
                    exam_scope: row.get(2)?,
                    status: row.get(3)?,
                })
            })?
            .collect::<Result<Vec<_>, _>>()?;
        Ok(LearningDataSummary {
            schema_version: 1,
            card_count,
            review_count,
            last_successful_export_at_unix_ms,
            sources,
            packs,
        })
    }

    pub fn restore_native_export(
        &mut self,
        value: &NativeLearningExport,
        now_unix_ms: i64,
    ) -> AppResult<super::ImportCommitResult> {
        validate_now(now_unix_ms)?;
        validate_native_export(value)?;
        let transaction = self
            .conn
            .transaction_with_behavior(TransactionBehavior::Immediate)?;
        transaction.execute_batch(
            "DELETE FROM learning_question_attempts;
             DELETE FROM learning_remediation_queue;
             DELETE FROM review_logs;
             DELETE FROM learning_sessions;
             DELETE FROM card_schedule;
             DELETE FROM learning_cards;
             DELETE FROM content_packs;
             DELETE FROM content_sources;
             DELETE FROM learning_invitation_events;",
        )?;
        insert_native_export(&transaction, value)?;
        transaction.execute(
            "UPDATE learning_schema_meta SET last_successful_export_at_unix_ms = NULL WHERE id = 1",
            [],
        )?;
        transaction.commit()?;
        Ok(super::ImportCommitResult {
            schema_version: 1,
            pack_id: "native-restore".into(),
            imported_count: value.cards.len() as u32,
            preserved_schedule_count: value.schedules.len() as u32,
        })
    }

    pub fn clear_learning_progress(&mut self, now_unix_ms: i64) -> AppResult<LearningDeleteResult> {
        validate_now(now_unix_ms)?;
        let transaction = self
            .conn
            .transaction_with_behavior(TransactionBehavior::Immediate)?;
        let deleted_review_count: u32 =
            transaction.query_row("SELECT COUNT(*) FROM review_logs", [], |row| row.get(0))?;
        transaction.execute_batch(
            "DELETE FROM learning_question_attempts;
             DELETE FROM learning_remediation_queue;
             DELETE FROM review_logs;
             DELETE FROM learning_sessions;
             DELETE FROM learning_invitation_events;",
        )?;
        transaction.execute(
            "UPDATE card_schedule SET stage = 'new', due_at_unix_ms = ?1,
                stability = NULL, difficulty = NULL, reps = 0, lapses = 0,
                last_review_at_unix_ms = NULL",
            [now_unix_ms],
        )?;
        transaction.execute(
            "UPDATE learning_settings SET paused_for_local_day = NULL, updated_at_unix_ms = ?1
             WHERE id = 1",
            [now_unix_ms],
        )?;
        let kept_card_count =
            transaction.query_row("SELECT COUNT(*) FROM learning_cards", [], |row| row.get(0))?;
        transaction.commit()?;
        Ok(LearningDeleteResult {
            schema_version: 1,
            scope: LearningDeleteScope::ProgressOnly,
            kept_card_count,
            deleted_review_count,
        })
    }
}

fn read_native_export(conn: &Connection, now_unix_ms: i64) -> AppResult<NativeLearningExport> {
    let settings = read_learning_settings(conn)?;
    let sources = conn
        .prepare(
            "SELECT source_id, source_kind, version, source_url, license_expression,
                notice_text, content_sha256, created_at_unix_ms
             FROM content_sources ORDER BY source_id",
        )?
        .query_map([], |row| {
            Ok(NativeSource {
                source_id: row.get(0)?,
                source_kind: row.get(1)?,
                version: row.get(2)?,
                source_url: row.get(3)?,
                license_expression: row.get(4)?,
                notice_text: row.get(5)?,
                content_sha256: row.get(6)?,
                created_at_unix_ms: row.get(7)?,
            })
        })?
        .collect::<Result<Vec<_>, _>>()?;
    let packs = conn
        .prepare(
            "SELECT pack_id, stable_namespace, version, title, exam_scope, status,
                manifest_sha256, created_at_unix_ms FROM content_packs ORDER BY pack_id",
        )?
        .query_map([], |row| {
            Ok(NativePack {
                pack_id: row.get(0)?,
                stable_namespace: row.get(1)?,
                version: row.get(2)?,
                title: row.get(3)?,
                exam_scope: row.get(4)?,
                status: row.get(5)?,
                manifest_sha256: row.get(6)?,
                created_at_unix_ms: row.get(7)?,
            })
        })?
        .collect::<Result<Vec<_>, _>>()?;
    let cards = conn
        .prepare(
            "SELECT card_id, pack_id, headword, normalized_headword, phonetic,
                part_of_speech_json, meanings_zh_json, word_family_json, frequency_band,
                sense_basis_json, source_ids_json, content_sha256, created_at_unix_ms
             FROM learning_cards ORDER BY card_id",
        )?
        .query_map([], |row| {
            let part_of_speech_json: String = row.get(5)?;
            let meanings_zh_json: String = row.get(6)?;
            let word_family_json: String = row.get(7)?;
            let sense_basis_json: String = row.get(9)?;
            let source_ids_json: String = row.get(10)?;
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, String>(2)?,
                row.get::<_, String>(3)?,
                row.get::<_, Option<String>>(4)?,
                part_of_speech_json,
                meanings_zh_json,
                word_family_json,
                row.get::<_, String>(8)?,
                sense_basis_json,
                source_ids_json,
                row.get::<_, String>(11)?,
                row.get::<_, i64>(12)?,
            ))
        })?
        .map(|raw| {
            let raw = raw?;
            Ok(NativeCard {
                card_id: raw.0,
                pack_id: raw.1,
                headword: raw.2,
                normalized_headword: raw.3,
                phonetic: raw.4,
                part_of_speech: serde_json::from_str(&raw.5)?,
                meanings_zh: serde_json::from_str(&raw.6)?,
                word_family: serde_json::from_str(&raw.7)?,
                frequency_band: raw.8,
                sense_basis: serde_json::from_str(&raw.9)?,
                source_ids: serde_json::from_str(&raw.10)?,
                content_sha256: raw.11,
                created_at_unix_ms: raw.12,
            })
        })
        .collect::<AppResult<Vec<_>>>()?;
    let schedules = conn
        .prepare(
            "SELECT card_id, stage, due_at_unix_ms, stability, difficulty, reps, lapses,
                last_review_at_unix_ms FROM card_schedule ORDER BY card_id",
        )?
        .query_map([], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, i64>(2)?,
                row.get::<_, Option<f64>>(3)?,
                row.get::<_, Option<f64>>(4)?,
                row.get::<_, u32>(5)?,
                row.get::<_, u32>(6)?,
                row.get::<_, Option<i64>>(7)?,
            ))
        })?
        .map(|raw| {
            let raw = raw?;
            Ok(NativeSchedule {
                card_id: raw.0,
                stage: super::parse_stage(&raw.1)?,
                due_at_unix_ms: raw.2,
                stability: raw.3,
                difficulty: raw.4,
                reps: raw.5,
                lapses: raw.6,
                last_review_at_unix_ms: raw.7,
            })
        })
        .collect::<AppResult<Vec<_>>>()?;
    let sessions = conn
        .prepare(
            "SELECT session_id, entry_source, session_kind, status, planned_count,
                completed_count, started_at_unix_ms, ended_at_unix_ms, exit_reason
             FROM learning_sessions ORDER BY started_at_unix_ms, session_id",
        )?
        .query_map([], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, String>(2)?,
                row.get::<_, String>(3)?,
                row.get::<_, u8>(4)?,
                row.get::<_, u8>(5)?,
                row.get::<_, i64>(6)?,
                row.get::<_, Option<i64>>(7)?,
                row.get::<_, Option<String>>(8)?,
            ))
        })?
        .map(|raw| {
            let raw = raw?;
            Ok(NativeSession {
                session_id: raw.0,
                entry_source: super::parse_entry_source(&raw.1)?,
                session_kind: super::parse_session_kind(&raw.2)?,
                status: raw.3,
                planned_count: raw.4,
                completed_count: raw.5,
                started_at_unix_ms: raw.6,
                ended_at_unix_ms: raw.7,
                exit_reason: raw.8,
            })
        })
        .collect::<AppResult<Vec<_>>>()?;
    let review_logs = conn
        .prepare(
            "SELECT review_id, card_id, session_id, rating, reviewed_at_unix_ms,
                elapsed_days, scheduled_days, stability, difficulty
             FROM review_logs ORDER BY reviewed_at_unix_ms, review_id",
        )?
        .query_map([], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, String>(2)?,
                row.get::<_, String>(3)?,
                row.get::<_, i64>(4)?,
                row.get::<_, u32>(5)?,
                row.get::<_, u32>(6)?,
                row.get::<_, f64>(7)?,
                row.get::<_, f64>(8)?,
            ))
        })?
        .map(|raw| {
            let raw = raw?;
            let rating = match raw.3.as_str() {
                "again" => LearningRating::Again,
                "hard" => LearningRating::Hard,
                "good" => LearningRating::Good,
                _ => {
                    return Err(AppError::Validation(
                        "learning review rating is invalid".into(),
                    ))
                }
            };
            Ok(NativeReviewLog {
                review_id: raw.0,
                card_id: raw.1,
                session_id: raw.2,
                rating,
                reviewed_at_unix_ms: raw.4,
                elapsed_days: raw.5,
                scheduled_days: raw.6,
                stability: raw.7,
                difficulty: raw.8,
            })
        })
        .collect::<AppResult<Vec<_>>>()?;
    let question_attempts = conn
        .prepare(
            "SELECT attempt_id, client_answer_id, question_id, session_id, card_id,
                selected_option_id, correct_option_id, outcome, is_remediation,
                scheduled_rating, response_ms, answered_at_unix_ms
             FROM learning_question_attempts
             ORDER BY answered_at_unix_ms, attempt_id",
        )?
        .query_map([], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, String>(2)?,
                row.get::<_, String>(3)?,
                row.get::<_, String>(4)?,
                row.get::<_, String>(5)?,
                row.get::<_, String>(6)?,
                row.get::<_, String>(7)?,
                row.get::<_, bool>(8)?,
                row.get::<_, Option<String>>(9)?,
                row.get::<_, Option<u32>>(10)?,
                row.get::<_, i64>(11)?,
            ))
        })?
        .map(|raw| {
            let raw = raw?;
            let scheduled_rating = raw.9.as_deref().map(parse_native_rating).transpose()?;
            Ok(NativeQuestionAttempt {
                attempt_id: raw.0,
                client_answer_id: raw.1,
                question_id: raw.2,
                session_id: raw.3,
                card_id: raw.4,
                selected_option_id: raw.5,
                correct_option_id: raw.6,
                outcome: raw.7,
                is_remediation: raw.8,
                scheduled_rating,
                response_ms: raw.10,
                answered_at_unix_ms: raw.11,
            })
        })
        .collect::<AppResult<Vec<_>>>()?;
    let remediation_queue = conn
        .prepare(
            "SELECT session_id, card_id, position, created_at_unix_ms, completed_at_unix_ms
             FROM learning_remediation_queue ORDER BY session_id, position",
        )?
        .query_map([], |row| {
            Ok(NativeRemediationItem {
                session_id: row.get(0)?,
                card_id: row.get(1)?,
                position: row.get(2)?,
                created_at_unix_ms: row.get(3)?,
                completed_at_unix_ms: row.get(4)?,
            })
        })?
        .collect::<Result<Vec<_>, _>>()?;
    let session_targets = conn
        .prepare(
            "SELECT session_id, card_id, position
             FROM learning_session_targets ORDER BY session_id, position",
        )?
        .query_map([], |row| {
            Ok(NativeSessionTarget {
                session_id: row.get(0)?,
                card_id: row.get(1)?,
                position: row.get(2)?,
            })
        })?
        .collect::<Result<Vec<_>, _>>()?;
    Ok(NativeLearningExport {
        schema_version: 1,
        kind: NATIVE_EXPORT_KIND.into(),
        exported_at_unix_ms: now_unix_ms,
        settings,
        sources,
        packs,
        cards,
        schedules,
        sessions,
        review_logs,
        question_attempts,
        remediation_queue,
        session_targets,
    })
}

fn parse_native_rating(value: &str) -> AppResult<LearningRating> {
    match value {
        "again" => Ok(LearningRating::Again),
        "hard" => Ok(LearningRating::Hard),
        "good" => Ok(LearningRating::Good),
        _ => Err(AppError::Validation(
            "learning review rating is invalid".into(),
        )),
    }
}

fn validate_native_export(value: &NativeLearningExport) -> AppResult<()> {
    if value.schema_version != 1
        || value.kind != NATIVE_EXPORT_KIND
        || value.exported_at_unix_ms < 0
        || value.cards.len() > MAX_CARDS
        || value.schedules.len() != value.cards.len()
        || value.review_logs.len() > MAX_REVIEW_LOGS
        || value.question_attempts.len() > MAX_QUESTION_ATTEMPTS
        || value.remediation_queue.len() > value.sessions.len().saturating_mul(10)
        || value.session_targets.len() > value.sessions.len().saturating_mul(10)
    {
        return Err(AppError::Validation(
            "native learning export contract is unsupported".into(),
        ));
    }
    let mut normalized_settings = value.settings.clone();
    if normalized_settings.cards_per_session == 1 {
        normalized_settings.cards_per_session = 3;
    }
    validate_learning_settings(&normalized_settings)?;
    if value.settings.updated_at_unix_ms < 0
        || value
            .settings
            .paused_for_local_day
            .as_deref()
            .is_some_and(|day| chrono::NaiveDate::parse_from_str(day, "%Y-%m-%d").is_err())
    {
        return Err(AppError::Validation(
            "native learning settings timestamp is invalid".into(),
        ));
    }
    let unique =
        |items: Vec<&str>| items.len() == items.iter().copied().collect::<HashSet<_>>().len();
    if !unique(
        value
            .sources
            .iter()
            .map(|item| item.source_id.as_str())
            .collect(),
    ) || !unique(
        value
            .packs
            .iter()
            .map(|item| item.pack_id.as_str())
            .collect(),
    ) || !unique(
        value
            .cards
            .iter()
            .map(|item| item.card_id.as_str())
            .collect(),
    ) || !unique(
        value
            .schedules
            .iter()
            .map(|item| item.card_id.as_str())
            .collect(),
    ) || !unique(
        value
            .sessions
            .iter()
            .map(|item| item.session_id.as_str())
            .collect(),
    ) || !unique(
        value
            .review_logs
            .iter()
            .map(|item| item.review_id.as_str())
            .collect(),
    ) || !unique(
        value
            .question_attempts
            .iter()
            .map(|item| item.attempt_id.as_str())
            .collect(),
    ) || !unique(
        value
            .question_attempts
            .iter()
            .map(|item| item.client_answer_id.as_str())
            .collect(),
    ) || !unique(
        value
            .question_attempts
            .iter()
            .map(|item| item.question_id.as_str())
            .collect(),
    ) {
        return Err(AppError::Validation(
            "native learning export contains duplicate identifiers".into(),
        ));
    }
    let source_ids = value
        .sources
        .iter()
        .map(|item| item.source_id.as_str())
        .collect::<HashSet<_>>();
    let pack_ids = value
        .packs
        .iter()
        .map(|item| item.pack_id.as_str())
        .collect::<HashSet<_>>();
    let card_ids = value
        .cards
        .iter()
        .map(|item| item.card_id.as_str())
        .collect::<HashSet<_>>();
    let session_ids = value
        .sessions
        .iter()
        .map(|item| item.session_id.as_str())
        .collect::<HashSet<_>>();
    if value
        .sessions
        .iter()
        .filter(|item| matches!(item.status.as_str(), "created" | "active" | "paused"))
        .count()
        > 1
    {
        return Err(AppError::Validation(
            "native learning export contains multiple active sessions".into(),
        ));
    }
    for source in &value.sources {
        validate_hash(&source.content_sha256)?;
        if !valid_text(&source.source_id, 1, 96)
            || !matches!(
                source.source_kind.as_str(),
                "user_import" | "authorized" | "open_data"
            )
            || !valid_text(&source.version, 1, 128)
            || source
                .source_url
                .as_deref()
                .is_some_and(|item| !valid_text(item, 1, 2048))
            || source
                .license_expression
                .as_deref()
                .is_some_and(|item| !valid_text(item, 1, 128))
            || source
                .notice_text
                .as_deref()
                .is_some_and(|item| !valid_text(item, 1, 4096))
            || source.created_at_unix_ms < 0
        {
            return Err(AppError::Validation(
                "native learning source is invalid".into(),
            ));
        }
    }
    let mut namespace_versions = HashSet::new();
    for pack in &value.packs {
        validate_hash(&pack.manifest_sha256)?;
        if !valid_text(&pack.pack_id, 1, 128)
            || !valid_text(&pack.stable_namespace, 1, 128)
            || !valid_text(&pack.version, 1, 128)
            || !valid_text(&pack.title, 1, 160)
            || !valid_text(&pack.exam_scope, 1, 160)
            || !matches!(pack.status.as_str(), "preview" | "ready" | "disabled")
            || pack.created_at_unix_ms < 0
            || !namespace_versions.insert((pack.stable_namespace.as_str(), pack.version.as_str()))
        {
            return Err(AppError::Validation(
                "native learning pack is invalid".into(),
            ));
        }
    }
    let mut normalized_per_pack = HashSet::new();
    for card in &value.cards {
        validate_hash(&card.card_id)?;
        validate_hash(&card.content_sha256)?;
        if !pack_ids.contains(card.pack_id.as_str())
            || card.source_ids.is_empty()
            || card.source_ids.len() > 8
            || card
                .source_ids
                .iter()
                .any(|id| !source_ids.contains(id.as_str()))
            || !valid_text(&card.headword, 1, 128)
            || !valid_text(&card.normalized_headword, 1, 128)
            || !(1..=8).contains(&card.part_of_speech.len())
            || !(1..=2).contains(&card.meanings_zh.len())
            || card.word_family.len() > 3
            || card
                .phonetic
                .as_deref()
                .is_some_and(|item| !valid_text(item, 1, 160))
            || card
                .part_of_speech
                .iter()
                .any(|item| !valid_text(item, 1, 32))
            || card
                .meanings_zh
                .iter()
                .any(|item| !valid_text(item, 1, 160))
            || card
                .word_family
                .iter()
                .any(|item| !valid_text(item, 1, 128))
            || !matches!(
                card.frequency_band.as_str(),
                "user_import" | "exam_mid" | "exam_other" | "general" | "unknown"
            )
            || serde_json::to_vec(&card.sense_basis).is_ok_and(|bytes| bytes.len() > 16 * 1024)
            || card.created_at_unix_ms < 0
            || !normalized_per_pack
                .insert((card.pack_id.as_str(), card.normalized_headword.as_str()))
        {
            return Err(AppError::Validation(
                "native learning card is invalid".into(),
            ));
        }
    }
    for schedule in &value.schedules {
        let schedule_shape_valid = if schedule.reps == 0 {
            schedule.stability.is_none()
                && schedule.difficulty.is_none()
                && schedule.last_review_at_unix_ms.is_none()
        } else {
            schedule
                .stability
                .is_some_and(|item| item.is_finite() && item > 0.0)
                && schedule
                    .difficulty
                    .is_some_and(|item| item.is_finite() && (1.0..=10.0).contains(&item))
                && schedule
                    .last_review_at_unix_ms
                    .is_some_and(|item| item >= 0)
        };
        if !card_ids.contains(schedule.card_id.as_str())
            || schedule.due_at_unix_ms < 0
            || schedule.lapses > schedule.reps
            || !schedule_shape_valid
        {
            return Err(AppError::Validation(
                "native learning schedule is invalid".into(),
            ));
        }
    }
    for session in &value.sessions {
        let unfinished_shape = matches!(session.status.as_str(), "created" | "active" | "paused")
            && session.ended_at_unix_ms.is_none()
            && session.exit_reason.is_none();
        let finished_shape = matches!(
            session.status.as_str(),
            "completed" | "abandoned" | "expired"
        ) && session.ended_at_unix_ms.is_some()
            && session
                .exit_reason
                .as_deref()
                .is_none_or(|item| valid_text(item, 1, 64));
        let legacy_finished_shape = matches!(session.status.as_str(), "interrupted" | "exited")
            && session.ended_at_unix_ms.is_some()
            && session
                .exit_reason
                .as_deref()
                .is_none_or(|item| valid_text(item, 1, 64));
        if !valid_text(&session.session_id, 1, 64)
            || !matches!(
                session.status.as_str(),
                "created"
                    | "active"
                    | "paused"
                    | "completed"
                    | "abandoned"
                    | "expired"
                    | "interrupted"
                    | "exited"
            )
            || !(1..=10).contains(&session.planned_count)
            || session.completed_count > session.planned_count
            || session.started_at_unix_ms < 0
            || session
                .ended_at_unix_ms
                .is_some_and(|end| end < session.started_at_unix_ms)
            || !(unfinished_shape || finished_shape || legacy_finished_shape)
        {
            return Err(AppError::Validation(
                "native learning session is invalid".into(),
            ));
        }
    }
    for review in &value.review_logs {
        let session = value
            .sessions
            .iter()
            .find(|item| item.session_id == review.session_id);
        if !valid_text(&review.review_id, 1, 64)
            || !card_ids.contains(review.card_id.as_str())
            || !session_ids.contains(review.session_id.as_str())
            || review.reviewed_at_unix_ms < 0
            || review.scheduled_days == 0
            || !review.stability.is_finite()
            || review.stability <= 0.0
            || !review.difficulty.is_finite()
            || !(1.0..=10.0).contains(&review.difficulty)
            || session.is_some_and(|item| {
                review.reviewed_at_unix_ms < item.started_at_unix_ms
                    || item
                        .ended_at_unix_ms
                        .is_some_and(|end| review.reviewed_at_unix_ms > end)
            })
        {
            return Err(AppError::Validation(
                "native learning review log is invalid".into(),
            ));
        }
    }
    for attempt in &value.question_attempts {
        validate_hash(&attempt.question_id)?;
        validate_hash(&attempt.selected_option_id)?;
        validate_hash(&attempt.correct_option_id)?;
        let session = value
            .sessions
            .iter()
            .find(|item| item.session_id == attempt.session_id);
        let expected_rating = match attempt.outcome.as_str() {
            "correct" => Some(LearningRating::Good),
            "incorrect" => Some(LearningRating::Again),
            _ => None,
        };
        if !valid_text(&attempt.attempt_id, 1, 64)
            || uuid::Uuid::parse_str(&attempt.client_answer_id).is_err()
            || !session_ids.contains(attempt.session_id.as_str())
            || !card_ids.contains(attempt.card_id.as_str())
            || expected_rating.is_none()
            || attempt.response_ms.is_some_and(|value| value > 3_600_000)
            || attempt.answered_at_unix_ms < 0
            || if attempt.is_remediation {
                attempt.scheduled_rating.is_some()
            } else {
                attempt.scheduled_rating != expected_rating
            }
            || session.is_some_and(|item| {
                attempt.answered_at_unix_ms < item.started_at_unix_ms
                    || item
                        .ended_at_unix_ms
                        .is_some_and(|end| attempt.answered_at_unix_ms > end)
            })
        {
            return Err(AppError::Validation(
                "native learning question attempt is invalid".into(),
            ));
        }
    }
    let mut remediation_keys = HashSet::new();
    let mut remediation_positions = HashSet::new();
    for item in &value.remediation_queue {
        if !session_ids.contains(item.session_id.as_str())
            || !card_ids.contains(item.card_id.as_str())
            || !(1..=10).contains(&item.position)
            || item.created_at_unix_ms < 0
            || item
                .completed_at_unix_ms
                .is_some_and(|completed| completed < item.created_at_unix_ms)
            || !remediation_keys.insert((item.session_id.as_str(), item.card_id.as_str()))
            || !remediation_positions.insert((item.session_id.as_str(), item.position))
        {
            return Err(AppError::Validation(
                "native learning remediation queue is invalid".into(),
            ));
        }
    }
    let mut target_keys = HashSet::new();
    let mut target_positions = HashSet::new();
    for item in &value.session_targets {
        if !session_ids.contains(item.session_id.as_str())
            || !card_ids.contains(item.card_id.as_str())
            || !(1..=10).contains(&item.position)
            || !target_keys.insert((item.session_id.as_str(), item.card_id.as_str()))
            || !target_positions.insert((item.session_id.as_str(), item.position))
        {
            return Err(AppError::Validation(
                "native learning session target is invalid".into(),
            ));
        }
    }
    for session in &value.sessions {
        let logged = value
            .review_logs
            .iter()
            .filter(|item| item.session_id == session.session_id)
            .count();
        if logged != usize::from(session.completed_count) {
            return Err(AppError::Validation(
                "native learning session review count is inconsistent".into(),
            ));
        }
    }
    Ok(())
}

fn insert_native_export(conn: &Connection, value: &NativeLearningExport) -> AppResult<()> {
    conn.execute(
        "UPDATE learning_settings SET mode = ?1, cards_per_session = ?2,
            daily_new_limit = ?3, daily_goal = ?4, focus_finished_enabled = ?5,
            scheduled_windows_enabled = ?6, work_gap_experimental_enabled = ?7,
            daily_invitation_limit = ?8, invitation_cooldown_minutes = ?9,
            invitation_ttl_seconds = ?10, paused_for_local_day = ?11,
            updated_at_unix_ms = ?12 WHERE id = 1",
        params![
            learning_mode_as_str(value.settings.mode),
            if value.settings.cards_per_session == 1 {
                3
            } else {
                value.settings.cards_per_session
            },
            value.settings.daily_new_limit,
            value.settings.daily_goal,
            value.settings.focus_finished_enabled,
            value.settings.scheduled_windows_enabled,
            value.settings.work_gap_experimental_enabled,
            value.settings.daily_invitation_limit,
            value.settings.invitation_cooldown_minutes,
            value.settings.invitation_ttl_seconds,
            value.settings.paused_for_local_day,
            value.settings.updated_at_unix_ms,
        ],
    )?;
    for item in &value.sources {
        conn.execute(
            "INSERT INTO content_sources(source_id, source_kind, version, source_url,
                license_expression, notice_text, content_sha256, created_at_unix_ms)
             VALUES(?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
            params![
                item.source_id,
                item.source_kind,
                item.version,
                item.source_url,
                item.license_expression,
                item.notice_text,
                item.content_sha256,
                item.created_at_unix_ms
            ],
        )?;
    }
    for item in &value.packs {
        conn.execute(
            "INSERT INTO content_packs(pack_id, stable_namespace, version, title, exam_scope,
                status, manifest_sha256, created_at_unix_ms)
             VALUES(?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
            params![
                item.pack_id,
                item.stable_namespace,
                item.version,
                item.title,
                item.exam_scope,
                item.status,
                item.manifest_sha256,
                item.created_at_unix_ms
            ],
        )?;
    }
    for item in &value.cards {
        conn.execute(
            "INSERT INTO learning_cards(card_id, pack_id, headword, normalized_headword,
                phonetic, part_of_speech_json, meanings_zh_json, word_family_json,
                frequency_band, sense_basis_json, source_ids_json, content_sha256,
                created_at_unix_ms)
             VALUES(?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13)",
            params![
                item.card_id,
                item.pack_id,
                item.headword,
                item.normalized_headword,
                item.phonetic,
                serde_json::to_string(&item.part_of_speech)?,
                serde_json::to_string(&item.meanings_zh)?,
                serde_json::to_string(&item.word_family)?,
                item.frequency_band,
                serde_json::to_string(&item.sense_basis)?,
                serde_json::to_string(&item.source_ids)?,
                item.content_sha256,
                item.created_at_unix_ms
            ],
        )?;
    }
    for item in &value.schedules {
        conn.execute(
            "INSERT INTO card_schedule(card_id, stage, due_at_unix_ms, stability, difficulty,
                reps, lapses, last_review_at_unix_ms) VALUES(?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
            params![
                item.card_id,
                learning_stage_as_str(item.stage),
                item.due_at_unix_ms,
                item.stability,
                item.difficulty,
                item.reps,
                item.lapses,
                item.last_review_at_unix_ms
            ],
        )?;
    }
    for item in &value.sessions {
        let stored_status = match item.status.as_str() {
            "active" | "interrupted" => "paused",
            "exited" => "abandoned",
            status => status,
        };
        let last_activity_at_unix_ms = item.ended_at_unix_ms.unwrap_or(item.started_at_unix_ms);
        let terminal = matches!(stored_status, "completed" | "abandoned" | "expired");
        let expires_at_unix_ms = if terminal {
            last_activity_at_unix_ms
        } else {
            last_activity_at_unix_ms
                .checked_add(24 * 60 * 60 * 1_000)
                .ok_or_else(|| {
                    AppError::Validation("native learning session expiry overflowed".into())
                })?
        };
        let paused_at_unix_ms = (stored_status == "paused").then_some(last_activity_at_unix_ms);
        let pause_reason = (stored_status == "paused").then_some(match item.status.as_str() {
            "active" => "restore_recovery",
            "interrupted" => item
                .exit_reason
                .as_deref()
                .unwrap_or("restored_interruption"),
            _ => "restored_session",
        });
        let ended_at_unix_ms = terminal.then_some(last_activity_at_unix_ms);
        let exit_reason = if terminal {
            item.exit_reason.as_deref()
        } else {
            None
        };
        conn.execute(
            "INSERT INTO learning_sessions(session_id, entry_source, session_kind, status,
                state_revision, current_item_id, planned_count, completed_count,
                started_at_unix_ms, paused_at_unix_ms, pause_reason,
                last_activity_at_unix_ms, expires_at_unix_ms,
                ended_at_unix_ms, exit_reason)
             VALUES(?1, ?2, ?3, ?4, 1, NULL, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13)",
            params![
                item.session_id,
                entry_source_as_str(item.entry_source),
                learning_session_kind_as_str(item.session_kind),
                stored_status,
                item.planned_count,
                item.completed_count,
                item.started_at_unix_ms,
                paused_at_unix_ms,
                pause_reason,
                last_activity_at_unix_ms,
                expires_at_unix_ms,
                ended_at_unix_ms,
                exit_reason,
            ],
        )?;
        conn.execute(
            "INSERT INTO learning_session_events(
                event_id, session_id, event_kind, from_state, to_state,
                item_id, reason, occurred_at_unix_ms, state_revision
             ) VALUES(?1, ?2, 'migrated', NULL, ?3, NULL, 'native_restore', ?4, 1)",
            params![
                uuid::Uuid::new_v4().to_string(),
                item.session_id,
                stored_status,
                last_activity_at_unix_ms,
            ],
        )?;
    }
    for item in &value.review_logs {
        conn.execute(
            "INSERT INTO review_logs(review_id, card_id, session_id, rating,
                reviewed_at_unix_ms, elapsed_days, scheduled_days, stability, difficulty)
             VALUES(?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)",
            params![
                item.review_id,
                item.card_id,
                item.session_id,
                learning_rating_as_str(item.rating),
                item.reviewed_at_unix_ms,
                item.elapsed_days,
                item.scheduled_days,
                item.stability,
                item.difficulty
            ],
        )?;
    }
    for item in &value.remediation_queue {
        conn.execute(
            "INSERT INTO learning_remediation_queue(
                session_id, card_id, position, created_at_unix_ms, completed_at_unix_ms
             ) VALUES(?1, ?2, ?3, ?4, ?5)",
            params![
                item.session_id,
                item.card_id,
                item.position,
                item.created_at_unix_ms,
                item.completed_at_unix_ms,
            ],
        )?;
    }
    for item in &value.session_targets {
        conn.execute(
            "INSERT INTO learning_session_targets(session_id, card_id, position)
             VALUES(?1, ?2, ?3)",
            params![item.session_id, item.card_id, item.position],
        )?;
    }
    for item in &value.question_attempts {
        conn.execute(
            "INSERT INTO learning_question_attempts(
                attempt_id, client_answer_id, question_id, session_id, card_id,
                selected_option_id, correct_option_id, outcome, is_remediation,
                scheduled_rating, response_ms, answered_at_unix_ms
             ) VALUES(?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12)",
            params![
                item.attempt_id,
                item.client_answer_id,
                item.question_id,
                item.session_id,
                item.card_id,
                item.selected_option_id,
                item.correct_option_id,
                item.outcome,
                item.is_remediation,
                item.scheduled_rating.map(learning_rating_as_str),
                item.response_ms,
                item.answered_at_unix_ms,
            ],
        )?;
    }
    Ok(())
}

fn export_cards_csv(bundle: &NativeLearningExport) -> AppResult<LearningExportPayload> {
    let schedules = bundle
        .schedules
        .iter()
        .map(|item| (item.card_id.as_str(), item))
        .collect::<std::collections::HashMap<_, _>>();
    let mut writer = csv::WriterBuilder::new().from_writer(Vec::new());
    writer
        .write_record([
            "card_id",
            "headword",
            "meanings_zh",
            "phonetic",
            "part_of_speech",
            "word_family",
            "stage",
            "due_at_unix_ms",
            "reps",
            "lapses",
            "pack_id",
        ])
        .map_err(|_| AppError::Validation("learning CSV export failed".into()))?;
    for card in &bundle.cards {
        let schedule = schedules
            .get(card.card_id.as_str())
            .ok_or_else(|| AppError::Validation("learning card schedule is missing".into()))?;
        writer
            .write_record([
                csv_safe(&card.card_id),
                csv_safe(&card.headword),
                csv_safe(&card.meanings_zh.join(" | ")),
                csv_safe(card.phonetic.as_deref().unwrap_or("")),
                csv_safe(&card.part_of_speech.join(" | ")),
                csv_safe(&card.word_family.join(" | ")),
                learning_stage_as_str(schedule.stage).into(),
                schedule.due_at_unix_ms.to_string(),
                schedule.reps.to_string(),
                schedule.lapses.to_string(),
                csv_safe(&card.pack_id),
            ])
            .map_err(|_| AppError::Validation("learning CSV export failed".into()))?;
    }
    let bytes = writer
        .into_inner()
        .map_err(|_| AppError::Validation("learning CSV export failed".into()))?;
    Ok(LearningExportPayload {
        bytes,
        record_count: bundle.cards.len() as u32,
    })
}

fn export_reviews_csv(bundle: &NativeLearningExport) -> AppResult<LearningExportPayload> {
    let headwords = bundle
        .cards
        .iter()
        .map(|item| (item.card_id.as_str(), item.headword.as_str()))
        .collect::<std::collections::HashMap<_, _>>();
    let mut writer = csv::WriterBuilder::new().from_writer(Vec::new());
    writer
        .write_record([
            "review_id",
            "card_id",
            "headword",
            "session_id",
            "rating",
            "reviewed_at_unix_ms",
            "elapsed_days",
            "scheduled_days",
            "stability",
            "difficulty",
        ])
        .map_err(|_| AppError::Validation("learning CSV export failed".into()))?;
    for item in &bundle.review_logs {
        writer
            .write_record([
                csv_safe(&item.review_id),
                csv_safe(&item.card_id),
                csv_safe(headwords.get(item.card_id.as_str()).copied().unwrap_or("")),
                csv_safe(&item.session_id),
                learning_rating_as_str(item.rating).into(),
                item.reviewed_at_unix_ms.to_string(),
                item.elapsed_days.to_string(),
                item.scheduled_days.to_string(),
                item.stability.to_string(),
                item.difficulty.to_string(),
            ])
            .map_err(|_| AppError::Validation("learning CSV export failed".into()))?;
    }
    let bytes = writer
        .into_inner()
        .map_err(|_| AppError::Validation("learning CSV export failed".into()))?;
    Ok(LearningExportPayload {
        bytes,
        record_count: bundle.review_logs.len() as u32,
    })
}

fn csv_safe(value: &str) -> String {
    if value
        .trim_start()
        .chars()
        .next()
        .is_some_and(|character| matches!(character, '=' | '+' | '-' | '@'))
    {
        format!("'{value}")
    } else {
        value.to_owned()
    }
}

fn validate_hash(value: &str) -> AppResult<()> {
    if value.len() != 64
        || !value
            .bytes()
            .all(|byte| byte.is_ascii_hexdigit() && !byte.is_ascii_uppercase())
    {
        return Err(AppError::Validation(
            "native learning hash is invalid".into(),
        ));
    }
    Ok(())
}

fn valid_text(value: &str, min: usize, max: usize) -> bool {
    let trimmed = value.trim();
    let length = trimmed.chars().count();
    (min..=max).contains(&length)
        && !value.chars().any(|character| {
            character == '\0'
                || character.is_control()
                || matches!(
                    character,
                    '\u{061c}'
                        | '\u{200e}'
                        | '\u{200f}'
                        | '\u{202a}'..='\u{202e}'
                        | '\u{2066}'..='\u{2069}'
                )
        })
}

fn entry_source_as_str(value: LearningEntrySource) -> &'static str {
    match value {
        LearningEntrySource::Manual => "manual",
        LearningEntrySource::FocusFinished => "focus_finished",
        LearningEntrySource::ScheduledWindow => "scheduled_window",
        LearningEntrySource::WorkGapExperimental => "work_gap_experimental",
    }
}

pub fn read_native_import_file(path: &Path) -> AppResult<Vec<u8>> {
    if !path
        .extension()
        .and_then(|value| value.to_str())
        .is_some_and(|value| value.eq_ignore_ascii_case("json"))
    {
        return Err(AppError::Validation(
            "native learning import file type is unsupported".into(),
        ));
    }
    let metadata = std::fs::metadata(path)?;
    if !metadata.is_file() || metadata.len() == 0 || metadata.len() > MAX_NATIVE_IMPORT_BYTES as u64
    {
        return Err(AppError::Validation(
            "native learning import size is outside the allowed range".into(),
        ));
    }
    let bytes = std::fs::read(path)?;
    if bytes.len() > MAX_NATIVE_IMPORT_BYTES {
        return Err(AppError::Validation(
            "native learning import size is outside the allowed range".into(),
        ));
    }
    Ok(bytes)
}

pub fn write_new_file_atomically(path: &Path, bytes: &[u8]) -> AppResult<()> {
    use std::io::Write;
    if path.exists() {
        return Err(AppError::Validation(
            "learning export never overwrites an existing file".into(),
        ));
    }
    let parent = path
        .parent()
        .ok_or_else(|| AppError::Validation("learning export path is invalid".into()))?;
    let file_name = path
        .file_name()
        .and_then(|value| value.to_str())
        .ok_or_else(|| AppError::Validation("learning export file name is invalid".into()))?;
    let temporary = parent.join(format!(".{file_name}.{}.tmp", uuid::Uuid::new_v4()));
    let result = (|| -> AppResult<()> {
        let mut file = std::fs::OpenOptions::new()
            .create_new(true)
            .write(true)
            .open(&temporary)?;
        file.write_all(bytes)?;
        file.sync_all()?;
        std::fs::hard_link(&temporary, path).map_err(|_| {
            AppError::Validation(
                "learning export target already exists or cannot be created".into(),
            )
        })?;
        let _ = std::fs::remove_file(&temporary);
        Ok(())
    })();
    if result.is_err() {
        let _ = std::fs::remove_file(&temporary);
    }
    result
}

#[cfg(test)]
mod tests {
    use tempfile::tempdir;

    use super::*;
    use crate::learning::import::parse_user_csv;

    const NOW: i64 = 1_800_000_000_000;

    fn populated_repository(path: &Path) -> LearningRepository {
        let mut repository = LearningRepository::open(path).unwrap();
        let import = parse_user_csv(
            "headword,meanings_zh,progress_hint,source_label\nalpha,first,learning,My list\nbeta,second,new,My list\n"
                .as_bytes(),
        )
        .unwrap();
        repository.commit_user_import(&import, NOW).unwrap();
        let session = repository
            .start_manual_session(1, LearningSessionKind::Daily, NOW + 1)
            .unwrap();
        let card = repository
            .current_learning_card(&session.session_id)
            .unwrap();
        repository
            .rate_learning_card(
                &session.session_id,
                &card.card_id,
                LearningRating::Good,
                NOW + 2,
            )
            .unwrap();
        repository
    }

    #[test]
    fn native_json_round_trip_preserves_cards_schedules_sessions_and_reviews() {
        let directory = tempdir().unwrap();
        let mut source = populated_repository(&directory.path().join("source.sqlite3"));
        let exported = source
            .export_payload(LearningExportFormat::NativeJson, NOW + 100)
            .unwrap();
        let parsed = parse_native_learning_export(&exported.bytes).unwrap();
        assert_eq!(parsed.preview().card_count, 2);
        assert_eq!(parsed.review_logs.len(), 1);

        let mut restored =
            LearningRepository::open(&directory.path().join("restored.sqlite3")).unwrap();
        restored.restore_native_export(&parsed, NOW + 101).unwrap();
        let reexported = restored
            .export_payload(LearningExportFormat::NativeJson, NOW + 100)
            .unwrap();
        assert_eq!(exported.bytes, reexported.bytes);
    }

    #[test]
    fn failed_native_restore_rolls_back_existing_learning_data() {
        let directory = tempdir().unwrap();
        let mut source = populated_repository(&directory.path().join("source.sqlite3"));
        let exported = source
            .export_payload(LearningExportFormat::NativeJson, NOW + 100)
            .unwrap();
        let parsed = parse_native_learning_export(&exported.bytes).unwrap();

        let mut target =
            LearningRepository::open(&directory.path().join("target.sqlite3")).unwrap();
        let original = parse_user_csv("headword,meanings_zh\nkeep,original\n".as_bytes()).unwrap();
        target.commit_user_import(&original, NOW).unwrap();
        target
            .conn
            .execute_batch(
                "CREATE TRIGGER reject_restored_card BEFORE INSERT ON learning_cards
                 WHEN NEW.headword = 'alpha'
                 BEGIN SELECT RAISE(ABORT, 'injected restore failure'); END;",
            )
            .unwrap();
        assert!(target.restore_native_export(&parsed, NOW + 101).is_err());
        let remaining: String = target
            .conn
            .query_row("SELECT headword FROM learning_cards", [], |row| row.get(0))
            .unwrap();
        assert_eq!(remaining, "keep");
    }

    #[test]
    fn clear_progress_keeps_content_and_resets_all_scheduler_state() {
        let directory = tempdir().unwrap();
        let mut repository = populated_repository(&directory.path().join("learning.sqlite3"));
        let result = repository.clear_learning_progress(NOW + 200).unwrap();
        assert_eq!(result.kept_card_count, 2);
        assert_eq!(result.deleted_review_count, 1);
        let review_count: u32 = repository
            .conn
            .query_row("SELECT COUNT(*) FROM review_logs", [], |row| row.get(0))
            .unwrap();
        let non_new_count: u32 = repository
            .conn
            .query_row(
                "SELECT COUNT(*) FROM card_schedule
                 WHERE stage <> 'new' OR reps <> 0 OR stability IS NOT NULL",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(review_count, 0);
        assert_eq!(non_new_count, 0);
    }

    #[test]
    fn csv_export_escapes_formula_prefixes_and_atomic_writer_never_overwrites() {
        assert_eq!(csv_safe("=2+2"), "'=2+2");
        assert_eq!(csv_safe("  @cmd"), "'  @cmd");
        assert_eq!(csv_safe("ordinary"), "ordinary");

        let directory = tempdir().unwrap();
        let target = directory.path().join("learning.json");
        write_new_file_atomically(&target, b"first").unwrap();
        assert_eq!(std::fs::read(&target).unwrap(), b"first");
        assert!(write_new_file_atomically(&target, b"second").is_err());
        assert_eq!(std::fs::read(&target).unwrap(), b"first");
    }

    #[test]
    fn native_parser_rejects_unknown_fields_and_future_contract_versions() {
        let directory = tempdir().unwrap();
        let mut repository = populated_repository(&directory.path().join("learning.sqlite3"));
        let payload = repository
            .export_payload(LearningExportFormat::NativeJson, NOW + 100)
            .unwrap();
        let mut value: serde_json::Value = serde_json::from_slice(&payload.bytes).unwrap();
        value["unexpected"] = serde_json::json!(true);
        assert!(parse_native_learning_export(&serde_json::to_vec(&value).unwrap()).is_err());
        value.as_object_mut().unwrap().remove("unexpected");
        value["schemaVersion"] = serde_json::json!(2);
        assert!(parse_native_learning_export(&serde_json::to_vec(&value).unwrap()).is_err());
    }
}
