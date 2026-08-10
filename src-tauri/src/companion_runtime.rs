use std::collections::{HashMap, HashSet};
use std::time::Duration;

use chrono::{Local, TimeZone, Utc};
use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager};

use crate::{
    companion_attention::{TerminalObservation, TERMINAL_AGGREGATION_WINDOW_MS},
    companion_core::{
        BasicSupportPath, CompanionExpressionSnapshot, ExpressionKey, ExpressionSignal,
    },
    error::{AppError, AppResult},
    models::{BasicSupportSession, TodaySnapshot},
    repository::{TaskWatchAttentionDeferral, SYSTEM_ACTIVITY_REMINDER_ID},
    state::AppState,
};
use yuanyuan_ai::{read_task_expression_candidates, TaskExpressionCandidate, TaskExpressionSource};

const COMPANION_EXPRESSION_EVENT: &str = "companion-expression";
const BASIC_SUPPORT_EVENT: &str = "basic-support-updated";
const SLEEP_SIGNAL_KEY: ExpressionKey = ExpressionKey::system(1);
const TERMINAL_SUMMARY_SIGNAL_KEY: ExpressionKey = ExpressionKey::system(2);
const FOCUS_FINISHED_SIGNAL_KEY: ExpressionKey = ExpressionKey::system(3);
const BASIC_SUPPORT_SIGNAL_KEY: ExpressionKey = ExpressionKey::system(4);
const REUNION_SIGNAL_KEY: ExpressionKey = ExpressionKey::system(5);
const FOCUS_FINISHED_VISIBLE_SECONDS: u64 = 12;
const REUNION_VISIBLE_SECONDS: u64 = 10;
const LONG_RUNNING_AFTER_MS: i64 = 10 * 60 * 1_000;
const MAX_ACTIVE_TASK_AGE_MS: i64 = 24 * 60 * 60 * 1_000;
const MAX_EXTERNAL_TASK_SIGNALS: usize = 56;
const TASK_WATCH_SNAPSHOT_SCHEMA_VERSION: u16 = 2;

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct TaskWatchStateCount {
    pub source: crate::companion_core::TaskSource,
    pub state: yuanyuan_protocol::TaskState,
    pub count: u16,
    pub deferred_until_unix_ms: Option<i64>,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct TaskWatchSnapshot {
    pub schema_version: u16,
    pub available: bool,
    pub observed_count: u16,
    pub needs_user_count: u16,
    pub states: Vec<TaskWatchStateCount>,
}

pub fn snapshot(app: &AppHandle) -> CompanionExpressionSnapshot {
    app.state::<AppState>()
        .companion_expression
        .lock()
        .snapshot()
}

pub fn initialize(
    app: &AppHandle,
    focus_active: bool,
    reduce_motion: bool,
    quiet_active: bool,
) -> AppResult<CompanionExpressionSnapshot> {
    let state = app.state::<AppState>();
    let mut director = state.companion_expression.lock();
    director.set_focus_active(focus_active);
    director.set_reduce_motion(reduce_motion);
    director.set_quiet_active(quiet_active);
    drop(director);
    sync_local_occurrences(app)
}

pub fn sync_local_occurrences(app: &AppHandle) -> AppResult<CompanionExpressionSnapshot> {
    let state = app.state::<AppState>();
    let today = state.repository.lock().list_today(false)?;
    let desired = desired_local_signals(&today);

    let desired_keys: HashSet<_> = desired.keys().copied().collect();
    let mut known_keys = state.companion_occurrence_keys.lock();
    let mut director = state.companion_expression.lock();
    let previous_revision = director.snapshot().revision;
    for removed in known_keys
        .difference(&desired_keys)
        .copied()
        .collect::<Vec<_>>()
    {
        director.remove(removed);
    }
    for (key, signal) in desired {
        director
            .upsert(key, signal)
            .map_err(|_| AppError::Validation("companion expression capacity reached".into()))?;
    }
    *known_keys = desired_keys;
    let snapshot = director.snapshot();
    drop(director);
    drop(known_keys);
    if snapshot.revision != previous_revision {
        emit(app, &snapshot)?;
    }
    Ok(snapshot)
}

pub fn sync_external_tasks(
    app: &AppHandle,
    now_unix_ms: i64,
) -> AppResult<CompanionExpressionSnapshot> {
    let database = external_task_database()?;
    let candidates = match read_task_expression_candidates(&database) {
        Ok(candidates) => candidates,
        Err(_) => {
            clear_external_tasks(app)?;
            return Err(AppError::Validation(
                "external task expression state is unavailable".into(),
            ));
        }
    };
    let state = app.state::<AppState>();
    let (active_deferrals, due_deferrals) = {
        let repository = state.repository.lock();
        let due = repository.list_due_task_watch_attention_deferrals(now_unix_ms)?;
        let active = repository.list_task_watch_attention_deferrals(now_unix_ms)?;
        (active, due)
    };
    let (mut desired, terminal_observations, due_terminal_summary, mut due_to_acknowledge) =
        external_task_signals(&candidates, &active_deferrals, &due_deferrals, now_unix_ms);
    let support_active = state.basic_support.lock().is_some();
    let (suppress_terminal, terminal_summary) = {
        let mut repository = state.repository.lock();
        let settings = repository.get_settings()?;
        let focus_active = repository
            .get_focus_state()?
            .session
            .is_some_and(|session| session.phase == "focus");
        let local_transaction_active =
            !desired_local_signals(&repository.list_today(false)?).is_empty();
        let waiting_user_active = desired
            .iter()
            .any(|(_, signal)| matches!(signal, ExpressionSignal::TaskWaitingUser { .. }));
        let suppress_terminal = focus_active
            || pause_active(&settings, now_unix_ms)
            || support_active
            || local_transaction_active
            || waiting_user_active;
        let summary = repository.observe_terminal_attention_budget(
            &terminal_observations,
            now_unix_ms,
            suppress_terminal || due_terminal_summary.is_some(),
        )?;
        (suppress_terminal, summary)
    };
    if suppress_terminal && due_terminal_summary.is_some() {
        due_to_acknowledge
            .retain(|deferral| deferral.state != yuanyuan_protocol::TaskState::Failed);
    }
    if let Some(summary) = due_terminal_summary
        .filter(|_| !suppress_terminal)
        .or(terminal_summary)
    {
        desired.push((
            TERMINAL_SUMMARY_SIGNAL_KEY,
            ExpressionSignal::TaskOutcomeSummary {
                source: summary.source,
                outcome: summary.outcome,
                count: summary.count,
            },
        ));
    }
    let desired_keys: HashSet<_> = desired.iter().map(|(key, _)| *key).collect();
    let mut known_keys = state.companion_task_keys.lock();
    let mut director = state.companion_expression.lock();
    let previous_revision = director.snapshot().revision;
    for removed in known_keys
        .difference(&desired_keys)
        .copied()
        .collect::<Vec<_>>()
    {
        director.remove(removed);
    }
    for (key, signal) in desired {
        director
            .upsert(key, signal)
            .map_err(|_| AppError::Validation("companion expression capacity reached".into()))?;
    }
    *known_keys = desired_keys;
    let snapshot = director.snapshot();
    drop(director);
    drop(known_keys);
    if snapshot.revision != previous_revision {
        emit(app, &snapshot)?;
    }
    if !due_to_acknowledge.is_empty() {
        state
            .repository
            .lock()
            .acknowledge_due_task_watch_attention_deferrals(&due_to_acknowledge)?;
    }
    debug_assert!(suppress_terminal || terminal_summary.is_none() || snapshot.grouped_count > 0);
    Ok(snapshot)
}

pub fn read_task_watch_snapshot(
    now_unix_ms: i64,
    deferrals: &[TaskWatchAttentionDeferral],
) -> AppResult<TaskWatchSnapshot> {
    let database = external_task_database()?;
    if !database.exists() {
        return Ok(empty_task_watch_snapshot(false));
    }
    let candidates = read_task_expression_candidates(&database)
        .map_err(|_| AppError::Validation("external task watch state is unavailable".into()))?;
    Ok(task_watch_snapshot_from_candidates(
        &candidates,
        deferrals,
        now_unix_ms,
        true,
    ))
}

fn empty_task_watch_snapshot(available: bool) -> TaskWatchSnapshot {
    TaskWatchSnapshot {
        schema_version: TASK_WATCH_SNAPSHOT_SCHEMA_VERSION,
        available,
        observed_count: 0,
        needs_user_count: 0,
        states: Vec::new(),
    }
}

fn task_watch_snapshot_from_candidates(
    candidates: &[TaskExpressionCandidate],
    deferrals: &[TaskWatchAttentionDeferral],
    now_unix_ms: i64,
    available: bool,
) -> TaskWatchSnapshot {
    let sources = [
        (
            TaskExpressionSource::Codex,
            crate::companion_core::TaskSource::Codex,
        ),
        (
            TaskExpressionSource::ClaudeCode,
            crate::companion_core::TaskSource::ClaudeCode,
        ),
    ];
    let states = [
        yuanyuan_protocol::TaskState::WaitingUser,
        yuanyuan_protocol::TaskState::Stalled,
        yuanyuan_protocol::TaskState::Unknown,
        yuanyuan_protocol::TaskState::Running,
        yuanyuan_protocol::TaskState::Queued,
        yuanyuan_protocol::TaskState::Failed,
        yuanyuan_protocol::TaskState::Succeeded,
        yuanyuan_protocol::TaskState::Cancelled,
    ];
    let visible = candidates
        .iter()
        .filter(|candidate| {
            candidate.updated_at_unix_ms <= now_unix_ms
                && now_unix_ms.saturating_sub(candidate.updated_at_unix_ms)
                    <= MAX_ACTIVE_TASK_AGE_MS
        })
        .collect::<Vec<_>>();
    let mut snapshot = empty_task_watch_snapshot(available);
    snapshot.observed_count = visible.len().min(u16::MAX as usize) as u16;
    snapshot.needs_user_count = visible
        .iter()
        .filter(|candidate| candidate.state == yuanyuan_protocol::TaskState::WaitingUser)
        .count()
        .min(u16::MAX as usize) as u16;
    for (candidate_source, public_source) in sources {
        for state in states {
            let count = visible
                .iter()
                .filter(|candidate| {
                    candidate.source == candidate_source && candidate.state == state
                })
                .count()
                .min(u16::MAX as usize) as u16;
            if count > 0 {
                snapshot.states.push(TaskWatchStateCount {
                    source: public_source,
                    state,
                    count,
                    deferred_until_unix_ms: deferrals
                        .iter()
                        .find(|deferral| {
                            deferral.source == public_source
                                && deferral.state == state
                                && deferral.deferred_until_unix_ms > now_unix_ms
                        })
                        .map(|deferral| deferral.deferred_until_unix_ms),
                });
            }
        }
    }
    snapshot
}

fn clear_external_tasks(app: &AppHandle) -> AppResult<CompanionExpressionSnapshot> {
    let state = app.state::<AppState>();
    let mut known_keys = state.companion_task_keys.lock();
    let mut director = state.companion_expression.lock();
    let previous_revision = director.snapshot().revision;
    for key in known_keys.drain() {
        director.remove(key);
    }
    let snapshot = director.snapshot();
    drop(director);
    drop(known_keys);
    if snapshot.revision != previous_revision {
        emit(app, &snapshot)?;
    }
    Ok(snapshot)
}

#[cfg(feature = "runtime-qa")]
fn external_task_database() -> AppResult<std::path::PathBuf> {
    crate::runtime_qa::task_database()
}

#[cfg(not(feature = "runtime-qa"))]
fn external_task_database() -> AppResult<std::path::PathBuf> {
    let local_app_data = std::env::var_os("LOCALAPPDATA")
        .ok_or_else(|| AppError::Validation("external task storage is unavailable".into()))?;
    Ok(std::path::PathBuf::from(local_app_data)
        .join("Yuanyuan")
        .join("yuanyuan-ai.sqlite3"))
}

type ExternalTaskSignalSelection = (
    Vec<(ExpressionKey, ExpressionSignal)>,
    Vec<TerminalObservation>,
    Option<crate::companion_attention::TerminalSummary>,
    Vec<TaskWatchAttentionDeferral>,
);

fn external_task_signals(
    candidates: &[TaskExpressionCandidate],
    active_deferrals: &[TaskWatchAttentionDeferral],
    due_deferrals: &[TaskWatchAttentionDeferral],
    now_unix_ms: i64,
) -> ExternalTaskSignalSelection {
    let mut signals = Vec::new();
    let mut terminals = Vec::new();
    for candidate in candidates {
        if candidate.updated_at_unix_ms > now_unix_ms {
            continue;
        }
        let age = now_unix_ms.saturating_sub(candidate.updated_at_unix_ms);
        if age > MAX_ACTIVE_TASK_AGE_MS {
            continue;
        }
        let source = match candidate.source {
            TaskExpressionSource::Codex => crate::companion_core::TaskSource::Codex,
            TaskExpressionSource::ClaudeCode => crate::companion_core::TaskSource::ClaudeCode,
        };
        if active_deferrals
            .iter()
            .any(|deferral| deferral.source == source && deferral.state == candidate.state)
        {
            continue;
        }
        let due_after_user_deferral = due_deferrals
            .iter()
            .any(|deferral| deferral.source == source && deferral.state == candidate.state);
        let signal = match candidate.state {
            yuanyuan_protocol::TaskState::WaitingUser => {
                ExpressionSignal::TaskWaitingUser { source }
            }
            yuanyuan_protocol::TaskState::Succeeded
            | yuanyuan_protocol::TaskState::Failed
            | yuanyuan_protocol::TaskState::Cancelled => {
                if candidate.state == yuanyuan_protocol::TaskState::Failed
                    && due_after_user_deferral
                {
                    continue;
                }
                if age <= TERMINAL_AGGREGATION_WINDOW_MS {
                    let outcome = match candidate.state {
                        yuanyuan_protocol::TaskState::Succeeded => {
                            crate::companion_core::TaskOutcome::Succeeded
                        }
                        yuanyuan_protocol::TaskState::Failed => {
                            crate::companion_core::TaskOutcome::Failed
                        }
                        yuanyuan_protocol::TaskState::Cancelled => {
                            crate::companion_core::TaskOutcome::Cancelled
                        }
                        _ => unreachable!(),
                    };
                    terminals.push(TerminalObservation {
                        source,
                        outcome,
                        updated_at_unix_ms: candidate.updated_at_unix_ms,
                    });
                }
                continue;
            }
            yuanyuan_protocol::TaskState::Running if age >= LONG_RUNNING_AFTER_MS => {
                ExpressionSignal::TaskWatchLongRunning { source }
            }
            state => ExpressionSignal::TaskWatch { source, state },
        };
        if signals.len() < MAX_EXTERNAL_TASK_SIGNALS {
            signals.push((ExpressionKey::from_digest(candidate.task_digest), signal));
        }
    }
    let mut due_terminal_summary = None;
    let mut due_to_acknowledge = Vec::new();
    for deferral in due_deferrals {
        if deferral.state != yuanyuan_protocol::TaskState::Failed {
            due_to_acknowledge.push(*deferral);
            continue;
        }
        let count = candidates
            .iter()
            .filter(|candidate| {
                candidate.updated_at_unix_ms <= now_unix_ms
                    && now_unix_ms.saturating_sub(candidate.updated_at_unix_ms)
                        <= MAX_ACTIVE_TASK_AGE_MS
                    && candidate.state == yuanyuan_protocol::TaskState::Failed
                    && match candidate.source {
                        TaskExpressionSource::Codex => {
                            deferral.source == crate::companion_core::TaskSource::Codex
                        }
                        TaskExpressionSource::ClaudeCode => {
                            deferral.source == crate::companion_core::TaskSource::ClaudeCode
                        }
                    }
            })
            .count()
            .min(u16::MAX as usize) as u16;
        if count == 0 {
            due_to_acknowledge.push(*deferral);
        } else if due_terminal_summary.is_none() {
            due_terminal_summary = Some(crate::companion_attention::TerminalSummary {
                source: deferral.source,
                outcome: crate::companion_core::TaskOutcome::Failed,
                count,
            });
            due_to_acknowledge.push(*deferral);
        }
    }
    (signals, terminals, due_terminal_summary, due_to_acknowledge)
}

pub fn defer_task_watch_attention(
    app: &AppHandle,
    source: &str,
    state: &str,
    minutes: u32,
    now_unix_ms: i64,
) -> AppResult<TaskWatchSnapshot> {
    let source = parse_public_task_source(source)?;
    let state_value = parse_public_task_state(state)?;
    app.state::<AppState>()
        .repository
        .lock()
        .defer_task_watch_attention(source, state_value, minutes, now_unix_ms)?;
    sync_external_tasks(app, now_unix_ms)?;
    let deferrals = app
        .state::<AppState>()
        .repository
        .lock()
        .list_task_watch_attention_deferrals(now_unix_ms)?;
    read_task_watch_snapshot(now_unix_ms, &deferrals)
}

pub fn resume_task_watch_attention(
    app: &AppHandle,
    source: &str,
    state: &str,
    now_unix_ms: i64,
) -> AppResult<TaskWatchSnapshot> {
    let source = parse_public_task_source(source)?;
    let state_value = parse_public_task_state(state)?;
    app.state::<AppState>()
        .repository
        .lock()
        .clear_task_watch_attention_deferral(source, state_value)?;
    sync_external_tasks(app, now_unix_ms)?;
    let deferrals = app
        .state::<AppState>()
        .repository
        .lock()
        .list_task_watch_attention_deferrals(now_unix_ms)?;
    read_task_watch_snapshot(now_unix_ms, &deferrals)
}

fn parse_public_task_source(value: &str) -> AppResult<crate::companion_core::TaskSource> {
    match value {
        "codex" => Ok(crate::companion_core::TaskSource::Codex),
        "claude_code" => Ok(crate::companion_core::TaskSource::ClaudeCode),
        _ => Err(AppError::Validation("invalid task watch source".into())),
    }
}

fn parse_public_task_state(value: &str) -> AppResult<yuanyuan_protocol::TaskState> {
    match value {
        "running" => Ok(yuanyuan_protocol::TaskState::Running),
        "waiting_user" => Ok(yuanyuan_protocol::TaskState::WaitingUser),
        "failed" => Ok(yuanyuan_protocol::TaskState::Failed),
        "stalled" => Ok(yuanyuan_protocol::TaskState::Stalled),
        "unknown" => Ok(yuanyuan_protocol::TaskState::Unknown),
        _ => Err(AppError::Validation(
            "task watch state cannot be deferred".into(),
        )),
    }
}

pub fn pause_active(settings: &crate::models::AppSettings, now_unix_ms: i64) -> bool {
    settings
        .pause_until
        .as_deref()
        .and_then(|value| chrono::DateTime::parse_from_rfc3339(value).ok())
        .is_some_and(|until| until.timestamp_millis() > now_unix_ms)
}

fn desired_local_signals(today: &TodaySnapshot) -> HashMap<ExpressionKey, ExpressionSignal> {
    let active = |status: &str| matches!(status, "pending" | "overdue");
    let mut desired = HashMap::new();

    let water = today
        .occurrences
        .iter()
        .find(|item| active(&item.status) && item.category == "water");
    let work = today.occurrences.iter().find(|item| {
        active(&item.status)
            && item.category != "water"
            && item.reminder_id != SYSTEM_ACTIVITY_REMINDER_ID
    });
    let activity = today
        .occurrences
        .iter()
        .find(|item| active(&item.status) && item.reminder_id == SYSTEM_ACTIVITY_REMINDER_ID);

    for (occurrence, signal) in [
        water.map(|item| (item, ExpressionSignal::StrongWaterReminder)),
        work.map(|item| (item, ExpressionSignal::DueWorkReminder)),
        activity.map(|item| (item, ExpressionSignal::ActivityReminder)),
    ]
    .into_iter()
    .flatten()
    {
        if let Some(key) = ExpressionKey::parse(&occurrence.id) {
            desired.insert(key, signal);
        }
    }
    desired
}

pub fn set_focus_active(app: &AppHandle, active: bool) -> AppResult<CompanionExpressionSnapshot> {
    let snapshot = app
        .state::<AppState>()
        .companion_expression
        .lock()
        .set_focus_active(active);
    emit(app, &snapshot)?;
    Ok(snapshot)
}

pub fn try_present_focus_finished_ritual(app: &AppHandle, now_unix_ms: i64) -> AppResult<bool> {
    try_present_proactive_ritual(
        app,
        now_unix_ms,
        "focus_finished",
        FOCUS_FINISHED_SIGNAL_KEY,
        ExpressionSignal::FocusFinishedRitual,
        FOCUS_FINISHED_VISIBLE_SECONDS,
    )
}

pub fn try_present_reunion_ritual(app: &AppHandle, now_unix_ms: i64) -> AppResult<bool> {
    try_present_proactive_ritual(
        app,
        now_unix_ms,
        "reunion",
        REUNION_SIGNAL_KEY,
        ExpressionSignal::ReunionRitual,
        REUNION_VISIBLE_SECONDS,
    )
}

fn try_present_proactive_ritual(
    app: &AppHandle,
    now_unix_ms: i64,
    kind: &str,
    signal_key: ExpressionKey,
    signal: ExpressionSignal,
    visible_seconds: u64,
) -> AppResult<bool> {
    let state = app.state::<AppState>();
    let local_now = Utc
        .timestamp_millis_opt(now_unix_ms)
        .single()
        .ok_or_else(|| AppError::Validation("proactive companion clock is invalid".into()))?
        .with_timezone(&Local);
    let (intensity, blocked_by_local_state) = {
        let repository = state.repository.lock();
        let settings = repository.get_settings()?;
        let blocked = pause_active(&settings, now_unix_ms)
            || quiet_time_active(&settings, local_now.time())
            || !desired_local_signals(&repository.list_today(false)?).is_empty();
        (settings.companion_intensity, blocked)
    };
    if blocked_by_local_state || !state.companion_expression.lock().can_present_proactive() {
        return Ok(false);
    }
    let local_day = local_now.format("%Y-%m-%d").to_string();
    let granted = state.repository.lock().try_consume_proactive_attention(
        kind,
        &intensity,
        now_unix_ms,
        &local_day,
    )?;
    if !granted {
        return Ok(false);
    }

    let mut director = state.companion_expression.lock();
    let previous_revision = director.snapshot().revision;
    let snapshot = director
        .upsert(signal_key, signal)
        .map_err(|_| AppError::Validation("companion expression capacity reached".into()))?;
    drop(director);
    if snapshot.revision != previous_revision {
        emit(app, &snapshot)?;
    }

    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(Duration::from_secs(visible_seconds)).await;
        let state = app.state::<AppState>();
        let mut director = state.companion_expression.lock();
        let previous_revision = director.snapshot().revision;
        let snapshot = director.remove(signal_key);
        drop(director);
        if snapshot.revision != previous_revision {
            let _ = emit(&app, &snapshot);
        }
    });
    Ok(true)
}

pub fn start_basic_support(
    app: &AppHandle,
    path: &str,
    duration_minutes: u32,
) -> AppResult<BasicSupportSession> {
    let support_path = parse_basic_support(path, duration_minutes)?;
    let state = app.state::<AppState>();
    if state
        .repository
        .lock()
        .get_focus_state()?
        .session
        .is_some_and(|session| session.phase == "focus")
    {
        return Err(AppError::Validation(
            "finish the active focus timer before starting companion support".into(),
        ));
    }

    let now = Utc::now();
    let session = BasicSupportSession {
        id: uuid::Uuid::new_v4().to_string(),
        path: path.into(),
        duration_minutes,
        started_at: now.to_rfc3339(),
        ends_at: (now + chrono::Duration::minutes(i64::from(duration_minutes))).to_rfc3339(),
    };
    let mut director = state.companion_expression.lock();
    let previous_revision = director.snapshot().revision;
    let snapshot = director
        .upsert(
            BASIC_SUPPORT_SIGNAL_KEY,
            ExpressionSignal::BasicSupport { path: support_path },
        )
        .map_err(|_| AppError::Validation("companion expression capacity reached".into()))?;
    drop(director);
    *state.basic_support.lock() = Some(session.clone());
    if snapshot.revision != previous_revision {
        emit(app, &snapshot)?;
    }
    app.emit(BASIC_SUPPORT_EVENT, Some(session.clone()))
        .map_err(|error| AppError::Window(error.to_string()))?;

    let app = app.clone();
    let expected_id = session.id.clone();
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(Duration::from_secs(u64::from(duration_minutes) * 60)).await;
        let _ = finish_basic_support_if_current(&app, Some(&expected_id));
    });
    Ok(session)
}

pub fn stop_basic_support(app: &AppHandle) -> AppResult<bool> {
    finish_basic_support_if_current(app, None)
}

fn finish_basic_support_if_current(app: &AppHandle, expected_id: Option<&str>) -> AppResult<bool> {
    let state = app.state::<AppState>();
    let removed = {
        let mut current = state.basic_support.lock();
        if expected_id.is_some_and(|id| current.as_ref().is_none_or(|session| session.id != id)) {
            return Ok(false);
        }
        current.take().is_some()
    };
    if !removed {
        return Ok(false);
    }
    let mut director = state.companion_expression.lock();
    let previous_revision = director.snapshot().revision;
    let snapshot = director.remove(BASIC_SUPPORT_SIGNAL_KEY);
    drop(director);
    if snapshot.revision != previous_revision {
        emit(app, &snapshot)?;
    }
    app.emit(BASIC_SUPPORT_EVENT, Option::<BasicSupportSession>::None)
        .map_err(|error| AppError::Window(error.to_string()))?;
    Ok(true)
}

fn parse_basic_support(path: &str, duration_minutes: u32) -> AppResult<BasicSupportPath> {
    let valid = match path {
        "stay_close" if [2, 5, 10].contains(&duration_minutes) => BasicSupportPath::StayClose,
        "move_together" if [1, 3, 5, 10].contains(&duration_minutes) => {
            BasicSupportPath::MoveTogether
        }
        "give_space" if [5, 15, 30, 60].contains(&duration_minutes) => BasicSupportPath::GiveSpace,
        _ => {
            return Err(AppError::Validation(
                "invalid basic companion support option".into(),
            ));
        }
    };
    Ok(valid)
}

fn quiet_time_active(settings: &crate::models::AppSettings, now: chrono::NaiveTime) -> bool {
    let (Ok(start), Ok(end)) = (
        chrono::NaiveTime::parse_from_str(&settings.quiet_start, "%H:%M"),
        chrono::NaiveTime::parse_from_str(&settings.quiet_end, "%H:%M"),
    ) else {
        return true;
    };
    if end >= start {
        now >= start && now < end
    } else {
        now >= start || now < end
    }
}

pub fn set_reduce_motion(
    app: &AppHandle,
    reduce_motion: bool,
) -> AppResult<CompanionExpressionSnapshot> {
    let snapshot = app
        .state::<AppState>()
        .companion_expression
        .lock()
        .set_reduce_motion(reduce_motion);
    emit(app, &snapshot)?;
    Ok(snapshot)
}

pub fn set_quiet_active(
    app: &AppHandle,
    quiet_active: bool,
) -> AppResult<CompanionExpressionSnapshot> {
    let state = app.state::<AppState>();
    let mut director = state.companion_expression.lock();
    let previous_revision = director.snapshot().revision;
    let snapshot = director.set_quiet_active(quiet_active);
    drop(director);
    if snapshot.revision != previous_revision {
        emit(app, &snapshot)?;
    }
    Ok(snapshot)
}

pub fn set_sleeping(app: &AppHandle, sleeping: bool) -> AppResult<CompanionExpressionSnapshot> {
    let state = app.state::<AppState>();
    let mut director = state.companion_expression.lock();
    let snapshot = if sleeping {
        director
            .upsert(SLEEP_SIGNAL_KEY, ExpressionSignal::Sleep)
            .map_err(|_| AppError::Validation("companion expression capacity reached".into()))?
    } else {
        director.remove(SLEEP_SIGNAL_KEY)
    };
    drop(director);
    emit(app, &snapshot)?;
    Ok(snapshot)
}

fn emit(app: &AppHandle, snapshot: &CompanionExpressionSnapshot) -> AppResult<()> {
    app.emit(COMPANION_EXPRESSION_EVENT, snapshot)
        .map_err(|error| AppError::Window(error.to_string()))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{
        companion_attention::AttentionBudgetRecord,
        companion_core::{
            CompanionExpressionDirector, CompanionPose, ExpressionLabel, TaskOutcome, TaskSource,
        },
        models::Occurrence,
    };

    fn occurrence(id: u128, reminder_id: &str, category: &str, status: &str) -> Occurrence {
        Occurrence {
            id: uuid::Uuid::from_u128(id).to_string(),
            reminder_id: reminder_id.into(),
            reminder_title: "not copied to expression output".into(),
            category: category.into(),
            scheduled_at: "2026-08-05T00:00:00Z".into(),
            status: status.into(),
            acted_at: None,
            snoozed_until: None,
            resolution_reason: None,
        }
    }

    fn today(occurrences: Vec<Occurrence>) -> TodaySnapshot {
        TodaySnapshot {
            reminders: Vec::new(),
            occurrences,
            water_completed: 0,
            water_goal: 8,
            notification_available: false,
        }
    }

    #[test]
    fn proactive_ritual_respects_overnight_quiet_window_and_invalid_settings_fail_closed() {
        let mut settings = crate::models::AppSettings::default();
        assert!(quiet_time_active(
            &settings,
            chrono::NaiveTime::from_hms_opt(1, 0, 0).unwrap()
        ));
        assert!(!quiet_time_active(
            &settings,
            chrono::NaiveTime::from_hms_opt(12, 0, 0).unwrap()
        ));
        settings.quiet_start = "invalid".into();
        assert!(quiet_time_active(
            &settings,
            chrono::NaiveTime::from_hms_opt(12, 0, 0).unwrap()
        ));
    }

    #[test]
    fn basic_support_accepts_only_the_fixed_user_visible_paths_and_durations() {
        for (path, durations) in [
            ("stay_close", &[2, 5, 10][..]),
            ("move_together", &[1, 3, 5, 10][..]),
            ("give_space", &[5, 15, 30, 60][..]),
        ] {
            for duration in durations {
                assert!(parse_basic_support(path, *duration).is_ok());
            }
        }
        for (path, duration) in [
            ("stay_close", 1),
            ("move_together", 2),
            ("give_space", 10),
            ("listen_and_remember", 5),
            ("", 5),
        ] {
            assert!(parse_basic_support(path, duration).is_err());
        }
    }

    #[test]
    fn local_selection_preserves_water_work_activity_order_and_skips_snoozed_items() {
        let selected = desired_local_signals(&today(vec![
            occurrence(1, "water", "water", "pending"),
            occurrence(2, "work", "work", "overdue"),
            occurrence(3, SYSTEM_ACTIVITY_REMINDER_ID, "personal", "pending"),
            occurrence(4, "snoozed", "water", "snoozed"),
        ]));
        assert_eq!(selected.len(), 3);

        let mut director = CompanionExpressionDirector::default();
        let water_key = ExpressionKey::parse(&uuid::Uuid::from_u128(1).to_string()).unwrap();
        for (key, signal) in selected {
            director.upsert(key, signal).unwrap();
        }
        assert_eq!(director.snapshot().label, Some(ExpressionLabel::WaterDue));
        assert_eq!(
            director.remove(water_key).label,
            Some(ExpressionLabel::ReminderDue)
        );
    }

    #[test]
    fn malformed_internal_occurrence_ids_never_create_unremovable_signals() {
        let mut item = occurrence(1, "work", "work", "pending");
        item.id = "not-a-uuid".into();
        assert!(desired_local_signals(&today(vec![item])).is_empty());
    }

    fn candidate(
        id: u8,
        source: TaskExpressionSource,
        state: yuanyuan_protocol::TaskState,
        updated_at_unix_ms: i64,
    ) -> TaskExpressionCandidate {
        TaskExpressionCandidate {
            task_digest: [id; 16],
            source,
            state,
            updated_at_unix_ms,
        }
    }

    #[test]
    fn task_watch_snapshot_is_aggregated_bounded_and_contains_no_task_identity() {
        let now = 3_000_000_000_i64;
        let snapshot = task_watch_snapshot_from_candidates(
            &[
                candidate(
                    1,
                    TaskExpressionSource::Codex,
                    yuanyuan_protocol::TaskState::Running,
                    now - 1_000,
                ),
                candidate(
                    2,
                    TaskExpressionSource::Codex,
                    yuanyuan_protocol::TaskState::Running,
                    now - 2_000,
                ),
                candidate(
                    3,
                    TaskExpressionSource::Codex,
                    yuanyuan_protocol::TaskState::Failed,
                    now - 3_000,
                ),
                candidate(
                    4,
                    TaskExpressionSource::ClaudeCode,
                    yuanyuan_protocol::TaskState::WaitingUser,
                    now - 4_000,
                ),
                candidate(
                    5,
                    TaskExpressionSource::ClaudeCode,
                    yuanyuan_protocol::TaskState::Running,
                    now - MAX_ACTIVE_TASK_AGE_MS - 1,
                ),
                candidate(
                    6,
                    TaskExpressionSource::ClaudeCode,
                    yuanyuan_protocol::TaskState::Unknown,
                    now + 1,
                ),
            ],
            &[],
            now,
            true,
        );

        assert_eq!(
            serde_json::to_value(snapshot).unwrap(),
            serde_json::json!({
                "schemaVersion": 2,
                "available": true,
                "observedCount": 4,
                "needsUserCount": 1,
                "states": [
                    { "source": "codex", "state": "running", "count": 2, "deferredUntilUnixMs": null },
                    { "source": "codex", "state": "failed", "count": 1, "deferredUntilUnixMs": null },
                    { "source": "claude_code", "state": "waiting_user", "count": 1, "deferredUntilUnixMs": null }
                ]
            })
        );
    }

    #[test]
    fn external_task_mapping_uses_freshness_windows_without_task_text() {
        let now = 1_000_000_000_i64;
        let (mapped, terminals, due_summary, due_to_acknowledge) = external_task_signals(
            &[
                candidate(
                    1,
                    TaskExpressionSource::Codex,
                    yuanyuan_protocol::TaskState::Running,
                    now - LONG_RUNNING_AFTER_MS,
                ),
                candidate(
                    2,
                    TaskExpressionSource::ClaudeCode,
                    yuanyuan_protocol::TaskState::WaitingUser,
                    now - 1_000,
                ),
                candidate(
                    3,
                    TaskExpressionSource::Codex,
                    yuanyuan_protocol::TaskState::Succeeded,
                    now - TERMINAL_AGGREGATION_WINDOW_MS,
                ),
                candidate(
                    4,
                    TaskExpressionSource::Codex,
                    yuanyuan_protocol::TaskState::Failed,
                    now - TERMINAL_AGGREGATION_WINDOW_MS - 1,
                ),
                candidate(
                    5,
                    TaskExpressionSource::Codex,
                    yuanyuan_protocol::TaskState::Running,
                    now - MAX_ACTIVE_TASK_AGE_MS - 1,
                ),
                candidate(
                    6,
                    TaskExpressionSource::Codex,
                    yuanyuan_protocol::TaskState::Running,
                    now + 1,
                ),
            ],
            &[],
            &[],
            now,
        );
        assert_eq!(mapped.len(), 2);
        assert_eq!(terminals.len(), 1);
        assert_eq!(terminals[0].outcome, TaskOutcome::Succeeded);
        assert!(due_summary.is_none());
        assert!(due_to_acknowledge.is_empty());
        assert!(mapped.iter().any(|(_, signal)| matches!(
            signal,
            ExpressionSignal::TaskWatchLongRunning {
                source: TaskSource::Codex
            }
        )));
        assert!(mapped.iter().any(|(_, signal)| matches!(
            signal,
            ExpressionSignal::TaskWaitingUser {
                source: TaskSource::ClaudeCode
            }
        )));
    }

    #[test]
    fn waiting_user_defers_one_aggregated_terminal_summary() {
        let now = 2_000_000_000_i64;
        let (mapped, terminals, due_summary, due_to_acknowledge) = external_task_signals(
            &[
                candidate(
                    1,
                    TaskExpressionSource::Codex,
                    yuanyuan_protocol::TaskState::Running,
                    now - LONG_RUNNING_AFTER_MS,
                ),
                candidate(
                    2,
                    TaskExpressionSource::ClaudeCode,
                    yuanyuan_protocol::TaskState::Succeeded,
                    now,
                ),
                candidate(
                    3,
                    TaskExpressionSource::Codex,
                    yuanyuan_protocol::TaskState::Failed,
                    now,
                ),
                candidate(
                    4,
                    TaskExpressionSource::ClaudeCode,
                    yuanyuan_protocol::TaskState::WaitingUser,
                    now,
                ),
            ],
            &[],
            &[],
            now,
        );
        assert!(due_summary.is_none());
        assert!(due_to_acknowledge.is_empty());
        let mut director = CompanionExpressionDirector::default();
        for (key, signal) in mapped {
            director.upsert(key, signal).unwrap();
        }
        let waiting = director.snapshot();
        assert_eq!(waiting.label, Some(ExpressionLabel::NeedsUser));
        assert_eq!(waiting.pose, CompanionPose::Alert);

        let mut budget = AttentionBudgetRecord::default();
        assert!(budget
            .observe_terminal_summaries(&terminals, now, true)
            .is_none());
        let summary = budget
            .observe_terminal_summaries(&terminals, now + 1, false)
            .unwrap();
        assert_eq!(summary.count, 2);
        assert_eq!(summary.outcome, TaskOutcome::Failed);
    }

    #[test]
    fn active_task_watch_deferral_hides_only_pet_expression_not_the_sanitized_watch_state() {
        let now = 2_500_000_000_i64;
        let deferral = TaskWatchAttentionDeferral {
            source: TaskSource::Codex,
            state: yuanyuan_protocol::TaskState::WaitingUser,
            deferred_until_unix_ms: now + 600_000,
        };
        let candidates = [
            candidate(
                1,
                TaskExpressionSource::Codex,
                yuanyuan_protocol::TaskState::WaitingUser,
                now,
            ),
            candidate(
                2,
                TaskExpressionSource::ClaudeCode,
                yuanyuan_protocol::TaskState::WaitingUser,
                now,
            ),
        ];

        let (signals, terminals, summary, due_to_acknowledge) =
            external_task_signals(&candidates, std::slice::from_ref(&deferral), &[], now);
        assert_eq!(signals.len(), 1);
        assert!(signals.iter().any(|(_, signal)| matches!(
            signal,
            ExpressionSignal::TaskWaitingUser {
                source: TaskSource::ClaudeCode
            }
        )));
        assert!(terminals.is_empty());
        assert!(summary.is_none());
        assert!(due_to_acknowledge.is_empty());

        let snapshot = task_watch_snapshot_from_candidates(
            &candidates,
            std::slice::from_ref(&deferral),
            now,
            true,
        );
        assert_eq!(snapshot.observed_count, 2);
        let codex = snapshot
            .states
            .iter()
            .find(|item| item.source == TaskSource::Codex)
            .unwrap();
        assert_eq!(codex.count, 1);
        assert_eq!(
            codex.deferred_until_unix_ms,
            Some(deferral.deferred_until_unix_ms)
        );
    }

    #[test]
    fn due_nonterminal_reappears_and_due_failures_are_presented_one_source_at_a_time() {
        let now = 2_600_000_000_i64;
        let waiting_due = TaskWatchAttentionDeferral {
            source: TaskSource::Codex,
            state: yuanyuan_protocol::TaskState::WaitingUser,
            deferred_until_unix_ms: now,
        };
        let codex_failed_due = TaskWatchAttentionDeferral {
            source: TaskSource::Codex,
            state: yuanyuan_protocol::TaskState::Failed,
            deferred_until_unix_ms: now,
        };
        let claude_failed_due = TaskWatchAttentionDeferral {
            source: TaskSource::ClaudeCode,
            state: yuanyuan_protocol::TaskState::Failed,
            deferred_until_unix_ms: now,
        };
        let candidates = [
            candidate(
                1,
                TaskExpressionSource::Codex,
                yuanyuan_protocol::TaskState::WaitingUser,
                now - 1_000,
            ),
            candidate(
                2,
                TaskExpressionSource::Codex,
                yuanyuan_protocol::TaskState::Failed,
                now - TERMINAL_AGGREGATION_WINDOW_MS - 1,
            ),
            candidate(
                3,
                TaskExpressionSource::Codex,
                yuanyuan_protocol::TaskState::Failed,
                now - TERMINAL_AGGREGATION_WINDOW_MS - 2,
            ),
            candidate(
                4,
                TaskExpressionSource::ClaudeCode,
                yuanyuan_protocol::TaskState::Failed,
                now - TERMINAL_AGGREGATION_WINDOW_MS - 3,
            ),
        ];
        let due = [waiting_due, codex_failed_due, claude_failed_due];

        let (signals, terminals, summary, due_to_acknowledge) =
            external_task_signals(&candidates, &[], &due, now);
        assert!(signals.iter().any(|(_, signal)| matches!(
            signal,
            ExpressionSignal::TaskWaitingUser {
                source: TaskSource::Codex
            }
        )));
        assert!(terminals.is_empty());
        assert_eq!(
            summary,
            Some(crate::companion_attention::TerminalSummary {
                source: TaskSource::Codex,
                outcome: TaskOutcome::Failed,
                count: 2,
            })
        );
        assert_eq!(due_to_acknowledge, [waiting_due, codex_failed_due]);
        assert!(!due_to_acknowledge.contains(&claude_failed_due));
    }

    #[test]
    fn external_task_signals_leave_capacity_for_local_and_system_states() {
        let now = 3_000_000_000_i64;
        let candidates = (0_u8..64)
            .map(|id| {
                candidate(
                    id,
                    TaskExpressionSource::Codex,
                    yuanyuan_protocol::TaskState::Running,
                    now,
                )
            })
            .collect::<Vec<_>>();
        let (signals, terminals, due_summary, due_to_acknowledge) =
            external_task_signals(&candidates, &[], &[], now);
        assert_eq!(signals.len(), MAX_EXTERNAL_TASK_SIGNALS);
        assert!(terminals.is_empty());
        assert!(due_summary.is_none());
        assert!(due_to_acknowledge.is_empty());
    }
}
