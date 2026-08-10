use std::{
    fs::{File, OpenOptions},
    io::{BufWriter, Read, Write},
    path::{Path, PathBuf},
    time::{Instant, SystemTime},
};

use rusqlite::{params, Connection, TransactionBehavior};
use serde::Serialize;
use thiserror::Error;

use crate::{
    TaskRetentionOutcome, TaskRetentionPolicy, TaskStore, TaskStoreError,
    RETENTION_INCREMENTAL_VACUUM_PAGES_PER_CYCLE,
};

pub const ANNUAL_RETENTION_QA_ATTESTATION: &str = "annual-175200-v1";
const QA_MODE: &str = "annual_task_retention_load_v1";
const QA_DIRECTORY_PREFIX: &str = "yuanyuan-retention-qa-";
const QA_MARKER_NAME: &str = ".yuanyuan-retention-qa-owned";
const QA_MARKER_CONTENT: &[u8] = b"yuanyuan-retention-qa-v1\n";
const DAY_MS: i64 = 24 * 60 * 60 * 1_000;
const FORMAL_NOW_UNIX_MS: i64 = 1_800_000_000_000;
const MAX_CLEANUP_CYCLES: usize = 2_000;

#[derive(Debug, Clone, Copy)]
struct FixtureProfile {
    task_count: u32,
    events_per_task: u32,
    age_span_days: u32,
}

impl FixtureProfile {
    const FORMAL: Self = Self {
        task_count: 3_650,
        events_per_task: 48,
        age_span_days: 400,
    };

    fn event_count(self) -> u64 {
        u64::from(self.task_count) * u64::from(self.events_per_task)
    }
}

#[derive(Debug, Error)]
pub enum RetentionQaError {
    #[error("the synthetic profile attestation is missing or invalid")]
    InvalidAttestation,
    #[error("the report path must be an absolute new JSON file in an existing ordinary directory")]
    UnsafeReportPath,
    #[error("the retention QA temporary directory could not be created safely")]
    TemporaryDirectoryUnavailable,
    #[error("the retention QA database operation failed")]
    Database(#[from] rusqlite::Error),
    #[error("the production retention operation failed")]
    Retention(#[from] TaskStoreError),
    #[error("the retention QA report could not be written")]
    ReportIo(#[from] std::io::Error),
    #[error("the retention QA report could not be serialized")]
    ReportSerialization(#[from] serde_json::Error),
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RetentionQaReport {
    pub schema_version: u16,
    pub generated_at_unix_ms: i64,
    pub mode: &'static str,
    pub profile: RetentionQaProfile,
    pub policy: RetentionQaPolicy,
    pub before: RetentionQaSnapshot,
    pub cleanup: RetentionQaCleanup,
    pub after_cleanup: RetentionQaSnapshot,
    pub after_checkpoint: RetentionQaSnapshot,
    pub invariants: RetentionQaInvariants,
    pub compression: RetentionQaCompression,
    pub temporary_workspace_removed: bool,
    pub ready: bool,
    pub failure_code: Option<&'static str>,
    pub limitations: [&'static str; 4],
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RetentionQaProfile {
    pub id: &'static str,
    pub task_rows: u64,
    pub event_rows: u64,
    pub nonce_rows: u64,
    pub equivalent_days: u32,
    pub modeled_tasks_per_day: u32,
    pub modeled_events_per_task: u32,
    pub age_span_days: u32,
    pub contains_user_content: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RetentionQaPolicy {
    pub progress_event_days: i64,
    pub priority_event_days: i64,
    pub terminal_task_days: i64,
    pub stale_task_days: i64,
    pub maximum_event_deletes_per_cycle: u32,
    pub maximum_task_deletes_per_cycle: u32,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RetentionQaSnapshot {
    pub task_rows: u64,
    pub event_rows: u64,
    pub nonce_rows: u64,
    pub database_bytes: u64,
    pub wal_bytes: u64,
    pub shm_bytes: u64,
    pub total_database_family_bytes: u64,
    pub page_size_bytes: u64,
    pub page_count: u64,
    pub freelist_pages: u64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RetentionQaCleanup {
    pub cycles_with_deletions: u64,
    pub fixed_point_probe_included: bool,
    pub total_elapsed_microseconds: u64,
    pub minimum_cycle_microseconds: u64,
    pub p50_cycle_microseconds: u64,
    pub p95_cycle_microseconds: u64,
    pub maximum_cycle_microseconds: u64,
    pub event_rows_deleted: u64,
    pub task_rows_deleted: u64,
    pub expired_nonces_deleted: u64,
    pub incremental_vacuum_pages_reclaimed: u64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RetentionQaInvariants {
    pub reached_fixed_point: bool,
    pub no_deletable_events_remain: bool,
    pub no_deletable_tasks_remain: bool,
    pub every_surviving_latest_event_exists: bool,
    pub current_nonces_preserved: bool,
    pub expired_nonces_removed: bool,
    pub row_deltas_match_outcomes: bool,
    pub fixture_contains_only_fixed_synthetic_content: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RetentionQaCompression {
    pub sqlite_auto_vacuum_mode: &'static str,
    pub incremental_vacuum_available: bool,
    pub reclaimable_pages_after_checkpoint: u64,
    pub reclaimable_bytes_after_checkpoint: u64,
    pub reclaimable_page_ratio_basis_points: u64,
    pub engineering_observation: &'static str,
    pub production_decision: &'static str,
}

pub fn run_annual_retention_qa(
    report_path: impl AsRef<Path>,
    attestation: &str,
) -> Result<RetentionQaReport, RetentionQaError> {
    run_retention_qa_with_profile(report_path.as_ref(), attestation, FixtureProfile::FORMAL)
}

fn run_retention_qa_with_profile(
    report_path: &Path,
    attestation: &str,
    profile: FixtureProfile,
) -> Result<RetentionQaReport, RetentionQaError> {
    if attestation != ANNUAL_RETENTION_QA_ATTESTATION {
        return Err(RetentionQaError::InvalidAttestation);
    }
    validate_new_report_path(report_path)?;

    let mut workspace = OwnedQaDirectory::create()?;
    let database_path = workspace.path().join("annual-retention.sqlite3");
    let anchor = create_fixture(&database_path, profile, FORMAL_NOW_UNIX_MS)?;
    let before = snapshot(&anchor, &database_path)?;

    let policy = TaskRetentionPolicy::default();
    let (cleanup, reached_fixed_point) = run_cleanup(&database_path, policy)?;
    let after_cleanup = snapshot(&anchor, &database_path)?;
    let invariants = inspect_invariants(
        &anchor,
        profile,
        policy,
        FORMAL_NOW_UNIX_MS,
        &before,
        &after_cleanup,
        &cleanup,
        reached_fixed_point,
    )?;
    let checkpoint: (u64, u64, u64) =
        anchor.query_row("PRAGMA wal_checkpoint(TRUNCATE)", [], |row| {
            Ok((row.get(0)?, row.get(1)?, row.get(2)?))
        })?;
    if checkpoint.0 != 0 {
        return Err(RetentionQaError::Database(rusqlite::Error::InvalidQuery));
    }
    let after_checkpoint = snapshot(&anchor, &database_path)?;
    let compression = compression_observation(&anchor, &after_checkpoint)?;
    drop(anchor);

    workspace.cleanup()?;
    let ready = invariants.all_passed();
    let report = RetentionQaReport {
        schema_version: 1,
        generated_at_unix_ms: unix_time_ms(),
        mode: QA_MODE,
        profile: RetentionQaProfile {
            id: ANNUAL_RETENTION_QA_ATTESTATION,
            task_rows: u64::from(profile.task_count),
            event_rows: profile.event_count(),
            nonce_rows: u64::from(profile.task_count) * 2,
            equivalent_days: 365,
            modeled_tasks_per_day: 10,
            modeled_events_per_task: profile.events_per_task,
            age_span_days: profile.age_span_days,
            contains_user_content: false,
        },
        policy: RetentionQaPolicy::from(policy),
        before,
        cleanup,
        after_cleanup,
        after_checkpoint,
        invariants,
        compression,
        temporary_workspace_removed: true,
        ready,
        failure_code: (!ready).then_some("retention_invariant_failed"),
        limitations: [
            "Uses fixed synthetic rows without connector, WebView, antivirus, or user workload contention.",
            "Measures one local filesystem and does not represent slow, full, encrypted, or failing disks.",
            "The profile is annual-equivalent volume with a 400-day aging tail to exercise every cutoff.",
            "Performance is observational; no release threshold or production vacuum policy is inferred.",
        ],
    };
    write_new_report(report_path, &report)?;
    Ok(report)
}

impl RetentionQaInvariants {
    fn all_passed(&self) -> bool {
        self.reached_fixed_point
            && self.no_deletable_events_remain
            && self.no_deletable_tasks_remain
            && self.every_surviving_latest_event_exists
            && self.current_nonces_preserved
            && self.expired_nonces_removed
            && self.row_deltas_match_outcomes
            && self.fixture_contains_only_fixed_synthetic_content
    }
}

impl From<TaskRetentionPolicy> for RetentionQaPolicy {
    fn from(policy: TaskRetentionPolicy) -> Self {
        Self {
            progress_event_days: policy.progress_event_retention_ms / DAY_MS,
            priority_event_days: policy.priority_event_retention_ms / DAY_MS,
            terminal_task_days: policy.terminal_task_retention_ms / DAY_MS,
            stale_task_days: policy.stale_task_retention_ms / DAY_MS,
            maximum_event_deletes_per_cycle: policy.maximum_event_deletes_per_run,
            maximum_task_deletes_per_cycle: policy.maximum_task_deletes_per_run,
        }
    }
}

fn create_fixture(
    database_path: &Path,
    profile: FixtureProfile,
    now_unix_ms: i64,
) -> Result<Connection, RetentionQaError> {
    if profile.task_count < 4 || profile.events_per_task < 2 || profile.age_span_days < 366 {
        return Err(RetentionQaError::Database(rusqlite::Error::InvalidQuery));
    }
    drop(TaskStore::open(database_path)?);
    let mut connection = Connection::open(database_path)?;
    connection.pragma_update(None, "foreign_keys", "ON")?;
    connection.pragma_update(None, "journal_mode", "WAL")?;
    connection.pragma_update(None, "wal_autocheckpoint", 0)?;
    let transaction = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
    {
        let mut insert_task = transaction.prepare_cached(
            "INSERT INTO watched_tasks(
                task_key, connector_id, source_instance, source, workspace,
                external_id, task_id, current_run_id, parent_task_id, title,
                state, sequence, finality, latest_event_id, latest_envelope_json,
                created_at_unix_ms, updated_at_unix_ms
             ) VALUES(?1, 'qa-connector', 'qa-instance', 'qa.synthetic', NULL,
                      ?1, ?1, 'qa-run', NULL, 'synthetic', ?2, ?3, ?4, ?5, '{}', ?6, ?6)",
        )?;
        let mut insert_event = transaction.prepare_cached(
            "INSERT INTO task_events(
                event_id, task_key, run_id, sequence, state, finality, key_id,
                nonce, envelope_json, disposition, persisted_at_unix_ms
             ) VALUES(?1, ?2, 'qa-run', ?3, ?4, ?5, 'qa-key', ?6, '{}', 'applied', ?7)",
        )?;
        let mut insert_nonce = transaction.prepare_cached(
            "INSERT INTO task_event_nonces(key_id, nonce, expires_at_unix_ms)
             VALUES(?1, ?2, ?3)",
        )?;

        for task_index in 0..profile.task_count {
            let age_days = distributed_age_days(task_index, profile);
            let updated_at = now_unix_ms - i64::from(age_days) * DAY_MS;
            let task_key = format!("qa-task-{task_index:05}");
            let latest_event_id = format!(
                "qa-event-{task_index:05}-{:02}",
                profile.events_per_task - 1
            );
            let (task_state, task_finality) = match task_index % 4 {
                0 => ("succeeded", "terminal"),
                1 => ("failed", "terminal"),
                2 => ("running", "provisional"),
                _ => ("waiting_user", "provisional"),
            };
            insert_task.execute(params![
                task_key,
                task_state,
                profile.events_per_task,
                task_finality,
                latest_event_id,
                updated_at,
            ])?;

            for event_index in 0..profile.events_per_task {
                let event_id = format!("qa-event-{task_index:05}-{event_index:02}");
                let latest = event_index + 1 == profile.events_per_task;
                let distance = profile.events_per_task - event_index - 1;
                let persisted_at = updated_at - i64::from(distance) * 3 * DAY_MS;
                let (state, finality) = if latest {
                    (task_state, task_finality)
                } else if event_index % 11 == 0 {
                    ("waiting_user", "provisional")
                } else {
                    ("running", "provisional")
                };
                insert_event.execute(params![
                    event_id,
                    task_key,
                    event_index + 1,
                    state,
                    finality,
                    nonce_bytes(task_index, event_index),
                    persisted_at,
                ])?;
            }

            insert_nonce.execute(params![
                "qa-expired",
                nonce_bytes(task_index, u32::MAX - 1),
                now_unix_ms - 1,
            ])?;
            insert_nonce.execute(params![
                "qa-current",
                nonce_bytes(task_index, u32::MAX),
                now_unix_ms + DAY_MS,
            ])?;
        }
    }
    transaction.commit()?;
    Ok(connection)
}

fn distributed_age_days(task_index: u32, profile: FixtureProfile) -> u32 {
    let denominator = profile.task_count.saturating_sub(1).max(1);
    task_index.saturating_mul(profile.age_span_days - 1) / denominator
}

fn nonce_bytes(task_index: u32, discriminator: u32) -> Vec<u8> {
    let mut nonce = [0_u8; 16];
    nonce[..4].copy_from_slice(&task_index.to_le_bytes());
    nonce[4..8].copy_from_slice(&discriminator.to_le_bytes());
    nonce[8..12].copy_from_slice(&task_index.rotate_left(13).to_le_bytes());
    nonce[12..].copy_from_slice(&discriminator.rotate_right(7).to_le_bytes());
    nonce.to_vec()
}

fn run_cleanup(
    database_path: &Path,
    policy: TaskRetentionPolicy,
) -> Result<(RetentionQaCleanup, bool), RetentionQaError> {
    let mut store = TaskStore::open(database_path)?;
    let total_started = Instant::now();
    let mut durations = Vec::new();
    let mut total = TaskRetentionOutcome {
        event_rows_deleted: 0,
        task_rows_deleted: 0,
        expired_nonces_deleted: 0,
    };
    let mut cycles_with_deletions = 0_u64;
    let mut incremental_vacuum_pages_reclaimed = 0_u64;
    let mut reached_fixed_point = false;
    for _ in 0..MAX_CLEANUP_CYCLES {
        let started = Instant::now();
        let outcome = store.apply_retention(policy, FORMAL_NOW_UNIX_MS)?;
        total.event_rows_deleted = total
            .event_rows_deleted
            .saturating_add(outcome.event_rows_deleted);
        total.task_rows_deleted = total
            .task_rows_deleted
            .saturating_add(outcome.task_rows_deleted);
        total.expired_nonces_deleted = total
            .expired_nonces_deleted
            .saturating_add(outcome.expired_nonces_deleted);
        let changed = outcome.event_rows_deleted > 0
            || outcome.task_rows_deleted > 0
            || outcome.expired_nonces_deleted > 0;
        if changed {
            incremental_vacuum_pages_reclaimed = incremental_vacuum_pages_reclaimed.saturating_add(
                store.apply_incremental_vacuum(RETENTION_INCREMENTAL_VACUUM_PAGES_PER_CYCLE)?,
            );
            cycles_with_deletions += 1;
        }
        durations.push(elapsed_microseconds(started));
        if outcome.event_rows_deleted == 0
            && outcome.task_rows_deleted == 0
            && outcome.expired_nonces_deleted == 0
        {
            reached_fixed_point = true;
            break;
        }
    }
    let (minimum, p50, p95, maximum) = distribution(&durations);
    Ok((
        RetentionQaCleanup {
            cycles_with_deletions,
            fixed_point_probe_included: reached_fixed_point,
            total_elapsed_microseconds: elapsed_microseconds(total_started),
            minimum_cycle_microseconds: minimum,
            p50_cycle_microseconds: p50,
            p95_cycle_microseconds: p95,
            maximum_cycle_microseconds: maximum,
            event_rows_deleted: total.event_rows_deleted,
            task_rows_deleted: total.task_rows_deleted,
            expired_nonces_deleted: total.expired_nonces_deleted,
            incremental_vacuum_pages_reclaimed,
        },
        reached_fixed_point,
    ))
}

#[allow(clippy::too_many_arguments)]
fn inspect_invariants(
    connection: &Connection,
    profile: FixtureProfile,
    policy: TaskRetentionPolicy,
    now_unix_ms: i64,
    before: &RetentionQaSnapshot,
    after: &RetentionQaSnapshot,
    cleanup: &RetentionQaCleanup,
    reached_fixed_point: bool,
) -> Result<RetentionQaInvariants, RetentionQaError> {
    let progress_cutoff = now_unix_ms - policy.progress_event_retention_ms;
    let priority_cutoff = now_unix_ms - policy.priority_event_retention_ms;
    let terminal_cutoff = now_unix_ms - policy.terminal_task_retention_ms;
    let stale_cutoff = now_unix_ms - policy.stale_task_retention_ms;
    let deletable_events: u64 = connection.query_row(
        "SELECT COUNT(*)
         FROM task_events AS event
         JOIN watched_tasks AS task ON task.task_key = event.task_key
         WHERE event.event_id <> task.latest_event_id
           AND (((event.state IN ('waiting_user', 'succeeded', 'failed', 'cancelled')
                  OR event.finality IN ('terminal', 'corrected'))
                 AND event.persisted_at_unix_ms < ?1)
                OR ((event.state NOT IN ('waiting_user', 'succeeded', 'failed', 'cancelled')
                     AND event.finality NOT IN ('terminal', 'corrected'))
                    AND event.persisted_at_unix_ms < ?2))",
        params![priority_cutoff, progress_cutoff],
        |row| row.get(0),
    )?;
    let deletable_tasks: u64 = connection.query_row(
        "SELECT COUNT(*) FROM watched_tasks
         WHERE (state IN ('succeeded', 'failed', 'cancelled') AND updated_at_unix_ms < ?1)
            OR (state NOT IN ('succeeded', 'failed', 'cancelled') AND updated_at_unix_ms < ?2)",
        params![terminal_cutoff, stale_cutoff],
        |row| row.get(0),
    )?;
    let missing_latest: u64 = connection.query_row(
        "SELECT COUNT(*)
         FROM watched_tasks AS task
         LEFT JOIN task_events AS event ON event.event_id = task.latest_event_id
         WHERE event.event_id IS NULL OR event.task_key <> task.task_key",
        [],
        |row| row.get(0),
    )?;
    let current_nonces: u64 = connection.query_row(
        "SELECT COUNT(*) FROM task_event_nonces WHERE key_id = 'qa-current'",
        [],
        |row| row.get(0),
    )?;
    let expired_nonces: u64 = connection.query_row(
        "SELECT COUNT(*) FROM task_event_nonces WHERE key_id = 'qa-expired'",
        [],
        |row| row.get(0),
    )?;
    let unexpected_content: u64 = connection.query_row(
        "SELECT
           (SELECT COUNT(*) FROM watched_tasks
            WHERE title <> 'synthetic' OR workspace IS NOT NULL OR latest_envelope_json <> '{}')
           +
           (SELECT COUNT(*) FROM task_events WHERE envelope_json <> '{}')",
        [],
        |row| row.get(0),
    )?;
    let row_deltas_match = before.event_rows.saturating_sub(after.event_rows)
        == cleanup.event_rows_deleted
        && before.task_rows.saturating_sub(after.task_rows) == cleanup.task_rows_deleted
        && before.nonce_rows.saturating_sub(after.nonce_rows) == cleanup.expired_nonces_deleted;

    Ok(RetentionQaInvariants {
        reached_fixed_point,
        no_deletable_events_remain: deletable_events == 0,
        no_deletable_tasks_remain: deletable_tasks == 0,
        every_surviving_latest_event_exists: missing_latest == 0,
        current_nonces_preserved: current_nonces == u64::from(profile.task_count),
        expired_nonces_removed: expired_nonces == 0,
        row_deltas_match_outcomes: row_deltas_match,
        fixture_contains_only_fixed_synthetic_content: unexpected_content == 0,
    })
}

fn snapshot(
    connection: &Connection,
    database_path: &Path,
) -> Result<RetentionQaSnapshot, RetentionQaError> {
    let task_rows =
        connection.query_row("SELECT COUNT(*) FROM watched_tasks", [], |row| row.get(0))?;
    let event_rows =
        connection.query_row("SELECT COUNT(*) FROM task_events", [], |row| row.get(0))?;
    let nonce_rows = connection.query_row("SELECT COUNT(*) FROM task_event_nonces", [], |row| {
        row.get(0)
    })?;
    let page_size_bytes = pragma_u64(connection, "page_size")?;
    let page_count = pragma_u64(connection, "page_count")?;
    let freelist_pages = pragma_u64(connection, "freelist_count")?;
    let database_bytes = file_size(database_path)?;
    let wal_bytes = file_size(&sqlite_sidecar(database_path, "-wal"))?;
    let shm_bytes = file_size(&sqlite_sidecar(database_path, "-shm"))?;
    Ok(RetentionQaSnapshot {
        task_rows,
        event_rows,
        nonce_rows,
        database_bytes,
        wal_bytes,
        shm_bytes,
        total_database_family_bytes: database_bytes
            .saturating_add(wal_bytes)
            .saturating_add(shm_bytes),
        page_size_bytes,
        page_count,
        freelist_pages,
    })
}

fn compression_observation(
    connection: &Connection,
    snapshot: &RetentionQaSnapshot,
) -> Result<RetentionQaCompression, RetentionQaError> {
    let auto_vacuum = pragma_u64(connection, "auto_vacuum")?;
    let (mode, incremental) = match auto_vacuum {
        0 => ("none", false),
        1 => ("full", false),
        2 => ("incremental", true),
        _ => ("unknown", false),
    };
    let reclaimable_bytes = snapshot
        .freelist_pages
        .saturating_mul(snapshot.page_size_bytes);
    let ratio_basis_points = if snapshot.page_count == 0 {
        0
    } else {
        snapshot
            .freelist_pages
            .saturating_mul(10_000)
            .checked_div(snapshot.page_count)
            .unwrap_or(0)
    };
    let observation = if reclaimable_bytes >= 16 * 1024 * 1024 && ratio_basis_points >= 2_500 {
        if incremental {
            "synthetic cleanup leaves material free pages and supports an incremental-vacuum trial"
        } else {
            "synthetic cleanup leaves material free pages but the current schema cannot incrementally vacuum"
        }
    } else {
        "synthetic cleanup does not leave enough free pages to justify an automatic compression change"
    };
    Ok(RetentionQaCompression {
        sqlite_auto_vacuum_mode: mode,
        incremental_vacuum_available: incremental,
        reclaimable_pages_after_checkpoint: snapshot.freelist_pages,
        reclaimable_bytes_after_checkpoint: reclaimable_bytes,
        reclaimable_page_ratio_basis_points: ratio_basis_points,
        engineering_observation: observation,
        production_decision: "defer_until_real_24h_72h_and_sleep_resume_evidence",
    })
}

fn validate_new_report_path(path: &Path) -> Result<(), RetentionQaError> {
    if !path.is_absolute()
        || path.extension().and_then(|value| value.to_str()) != Some("json")
        || path.exists()
    {
        return Err(RetentionQaError::UnsafeReportPath);
    }
    let Some(parent) = path.parent() else {
        return Err(RetentionQaError::UnsafeReportPath);
    };
    let metadata =
        std::fs::symlink_metadata(parent).map_err(|_| RetentionQaError::UnsafeReportPath)?;
    if !metadata.is_dir() || metadata.file_type().is_symlink() {
        return Err(RetentionQaError::UnsafeReportPath);
    }
    Ok(())
}

fn write_new_report(path: &Path, report: &RetentionQaReport) -> Result<(), RetentionQaError> {
    let file = OpenOptions::new().write(true).create_new(true).open(path)?;
    let mut writer = BufWriter::new(file);
    let result = (|| -> Result<(), RetentionQaError> {
        serde_json::to_writer_pretty(&mut writer, report)?;
        writer.write_all(b"\n")?;
        writer.flush()?;
        writer.get_ref().sync_all()?;
        Ok(())
    })();
    if result.is_err() {
        drop(writer);
        let _ = std::fs::remove_file(path);
    }
    result
}

fn distribution(values: &[u64]) -> (u64, u64, u64, u64) {
    if values.is_empty() {
        return (0, 0, 0, 0);
    }
    let mut sorted = values.to_vec();
    sorted.sort_unstable();
    let percentile = |numerator: usize| {
        let rank = sorted.len().saturating_mul(numerator).div_ceil(100);
        sorted[rank.saturating_sub(1).min(sorted.len() - 1)]
    };
    (
        sorted[0],
        percentile(50),
        percentile(95),
        sorted[sorted.len() - 1],
    )
}

fn elapsed_microseconds(started: Instant) -> u64 {
    u64::try_from(started.elapsed().as_micros()).unwrap_or(u64::MAX)
}

fn unix_time_ms() -> i64 {
    SystemTime::now()
        .duration_since(SystemTime::UNIX_EPOCH)
        .ok()
        .and_then(|duration| i64::try_from(duration.as_millis()).ok())
        .unwrap_or(0)
}

fn pragma_u64(connection: &Connection, name: &str) -> Result<u64, rusqlite::Error> {
    connection.query_row(&format!("PRAGMA {name}"), [], |row| row.get(0))
}

fn file_size(path: &Path) -> Result<u64, std::io::Error> {
    match std::fs::metadata(path) {
        Ok(metadata) if metadata.is_file() => Ok(metadata.len()),
        Ok(_) => Err(std::io::Error::new(
            std::io::ErrorKind::InvalidData,
            "database family member is not a file",
        )),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(0),
        Err(error) => Err(error),
    }
}

fn sqlite_sidecar(database_path: &Path, suffix: &str) -> PathBuf {
    let mut value = database_path.as_os_str().to_os_string();
    value.push(suffix);
    PathBuf::from(value)
}

struct OwnedQaDirectory {
    base: PathBuf,
    path: Option<PathBuf>,
}

impl OwnedQaDirectory {
    fn create() -> Result<Self, RetentionQaError> {
        let base = std::env::temp_dir();
        let base = base
            .canonicalize()
            .map_err(|_| RetentionQaError::TemporaryDirectoryUnavailable)?;
        for attempt in 0..64_u32 {
            let name = format!(
                "{QA_DIRECTORY_PREFIX}{}-{}-{attempt}",
                std::process::id(),
                unix_time_ms()
            );
            let path = base.join(name);
            match std::fs::create_dir(&path) {
                Ok(()) => {
                    let marker = path.join(QA_MARKER_NAME);
                    let mut file = OpenOptions::new()
                        .write(true)
                        .create_new(true)
                        .open(marker)
                        .map_err(|_| RetentionQaError::TemporaryDirectoryUnavailable)?;
                    file.write_all(QA_MARKER_CONTENT)
                        .and_then(|_| file.sync_all())
                        .map_err(|_| RetentionQaError::TemporaryDirectoryUnavailable)?;
                    return Ok(Self {
                        base,
                        path: Some(path),
                    });
                }
                Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => continue,
                Err(_) => return Err(RetentionQaError::TemporaryDirectoryUnavailable),
            }
        }
        Err(RetentionQaError::TemporaryDirectoryUnavailable)
    }

    fn path(&self) -> &Path {
        self.path.as_deref().expect("owned QA path is available")
    }

    fn cleanup(&mut self) -> Result<(), RetentionQaError> {
        let Some(path) = self.path.take() else {
            return Ok(());
        };
        safe_remove_owned_directory(&self.base, &path)
    }
}

impl Drop for OwnedQaDirectory {
    fn drop(&mut self) {
        let _ = self.cleanup();
    }
}

fn safe_remove_owned_directory(base: &Path, path: &Path) -> Result<(), RetentionQaError> {
    let parent = path
        .parent()
        .and_then(|value| value.canonicalize().ok())
        .ok_or(RetentionQaError::TemporaryDirectoryUnavailable)?;
    let name = path
        .file_name()
        .and_then(|value| value.to_str())
        .ok_or(RetentionQaError::TemporaryDirectoryUnavailable)?;
    let metadata = std::fs::symlink_metadata(path)
        .map_err(|_| RetentionQaError::TemporaryDirectoryUnavailable)?;
    if parent != base
        || !name.starts_with(QA_DIRECTORY_PREFIX)
        || !metadata.is_dir()
        || metadata.file_type().is_symlink()
    {
        return Err(RetentionQaError::TemporaryDirectoryUnavailable);
    }
    let marker_path = path.join(QA_MARKER_NAME);
    let marker_metadata = std::fs::symlink_metadata(&marker_path)
        .map_err(|_| RetentionQaError::TemporaryDirectoryUnavailable)?;
    if !marker_metadata.is_file() || marker_metadata.file_type().is_symlink() {
        return Err(RetentionQaError::TemporaryDirectoryUnavailable);
    }
    let mut marker = Vec::new();
    File::open(marker_path)?
        .take(128)
        .read_to_end(&mut marker)?;
    if marker != QA_MARKER_CONTENT {
        return Err(RetentionQaError::TemporaryDirectoryUnavailable);
    }
    std::fs::remove_dir_all(path)?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn test_output() -> (OwnedQaDirectory, PathBuf) {
        let directory = OwnedQaDirectory::create().unwrap();
        let report = directory.path().join("retention-report.json");
        (directory, report)
    }

    #[test]
    fn bounded_fixture_reaches_a_clean_fixed_point_without_leaking_paths() {
        let (mut output, report_path) = test_output();
        let report = run_retention_qa_with_profile(
            &report_path,
            ANNUAL_RETENTION_QA_ATTESTATION,
            FixtureProfile {
                task_count: 48,
                events_per_task: 12,
                age_span_days: 400,
            },
        )
        .unwrap();
        assert!(report.ready);
        assert!(report.invariants.all_passed());
        assert!(report.cleanup.event_rows_deleted > 0);
        assert!(report.cleanup.task_rows_deleted > 0);
        assert_eq!(report.cleanup.expired_nonces_deleted, 48);
        assert!(report.temporary_workspace_removed);

        let encoded = std::fs::read_to_string(&report_path).unwrap();
        assert!(!encoded.contains(&std::env::temp_dir().to_string_lossy().to_string()));
        assert!(!encoded.contains("retention.sqlite3"));
        let decoded: serde_json::Value = serde_json::from_str(&encoded).unwrap();
        assert_eq!(decoded["ready"], true);
        assert_eq!(decoded["profile"]["containsUserContent"], false);
        output.cleanup().unwrap();
    }

    #[test]
    fn wrong_attestation_and_existing_or_relative_reports_fail_before_writing() {
        let (mut output, report_path) = test_output();
        assert!(matches!(
            run_retention_qa_with_profile(
                &report_path,
                "wrong",
                FixtureProfile {
                    task_count: 4,
                    events_per_task: 2,
                    age_span_days: 400,
                }
            ),
            Err(RetentionQaError::InvalidAttestation)
        ));
        assert!(!report_path.exists());
        std::fs::write(&report_path, b"owned existing report").unwrap();
        assert!(matches!(
            run_retention_qa_with_profile(
                &report_path,
                ANNUAL_RETENTION_QA_ATTESTATION,
                FixtureProfile {
                    task_count: 4,
                    events_per_task: 2,
                    age_span_days: 400,
                }
            ),
            Err(RetentionQaError::UnsafeReportPath)
        ));
        assert!(matches!(
            run_retention_qa_with_profile(
                Path::new("relative.json"),
                ANNUAL_RETENTION_QA_ATTESTATION,
                FixtureProfile {
                    task_count: 4,
                    events_per_task: 2,
                    age_span_days: 400,
                }
            ),
            Err(RetentionQaError::UnsafeReportPath)
        ));
        output.cleanup().unwrap();
    }

    #[test]
    fn percentile_and_age_distribution_are_deterministic() {
        assert_eq!(distribution(&[9, 1, 5, 3]), (1, 3, 9, 9));
        let profile = FixtureProfile {
            task_count: 5,
            events_per_task: 2,
            age_span_days: 401,
        };
        assert_eq!(
            (0..5)
                .map(|index| distributed_age_days(index, profile))
                .collect::<Vec<_>>(),
            vec![0, 100, 200, 300, 400]
        );
    }
}
