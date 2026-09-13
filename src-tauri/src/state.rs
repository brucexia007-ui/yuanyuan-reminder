use std::{
    collections::{HashMap, HashSet},
    sync::atomic::{AtomicBool, AtomicU64, Ordering},
    time::Instant,
};

#[derive(Debug, Default)]
pub struct WorkTimingState {
    pub task_started_at_unix_ms: HashMap<[u8; 16], i64>,
    pub recovered_at_unix_ms: i64,
}

impl WorkTimingState {
    pub fn mark_recovered(&mut self, now_unix_ms: i64) {
        self.recovered_at_unix_ms = now_unix_ms.max(self.recovered_at_unix_ms);
        for started_at in self.task_started_at_unix_ms.values_mut() {
            *started_at = (*started_at).max(self.recovered_at_unix_ms);
        }
    }
}

use parking_lot::Mutex;
use tracing_appender::non_blocking::WorkerGuard;

use crate::models::{BasicSupportSession, SceneRestSession};
use crate::presentation_arbiter::PresentationArbiter;
use crate::repository::Repository;

#[cfg(feature = "learning")]
use crate::learning::LearningRuntime;

#[cfg(windows)]
use crate::companion_core::CompanionExpressionDirector;

pub const ACTIVITY_IDLE_PAUSE_SECONDS: u64 = 5 * 60;
pub const ACTIVITY_BREAK_RESET_SECONDS: u64 = 10 * 60;

#[cfg(feature = "learning")]
pub struct LearningImportCancellation {
    next_operation_id: AtomicU64,
    active_operation_id: AtomicU64,
    cancelled_operation_id: AtomicU64,
}

#[cfg(feature = "learning")]
impl Default for LearningImportCancellation {
    fn default() -> Self {
        Self {
            next_operation_id: AtomicU64::new(1),
            active_operation_id: AtomicU64::new(0),
            cancelled_operation_id: AtomicU64::new(0),
        }
    }
}

#[cfg(feature = "learning")]
impl LearningImportCancellation {
    pub fn begin(&self) -> crate::error::AppResult<u64> {
        let operation_id = self.next_operation_id.fetch_add(1, Ordering::SeqCst);
        if operation_id == 0 {
            return Err(crate::error::AppError::Validation(
                "learning import operation identifier is unavailable".into(),
            ));
        }
        self.active_operation_id
            .compare_exchange(0, operation_id, Ordering::SeqCst, Ordering::SeqCst)
            .map_err(|_| {
                crate::error::AppError::Validation(
                    "another learning import is already in progress".into(),
                )
            })?;
        Ok(operation_id)
    }

    pub fn cancel_active(&self) -> bool {
        let operation_id = self.active_operation_id.load(Ordering::SeqCst);
        if operation_id == 0 {
            return false;
        }
        self.cancelled_operation_id
            .store(operation_id, Ordering::SeqCst);
        true
    }

    pub fn is_cancelled(&self, operation_id: u64) -> bool {
        operation_id != 0
            && self.active_operation_id.load(Ordering::SeqCst) == operation_id
            && self.cancelled_operation_id.load(Ordering::SeqCst) == operation_id
    }

    pub fn finish(&self, operation_id: u64) {
        let _ = self.active_operation_id.compare_exchange(
            operation_id,
            0,
            Ordering::SeqCst,
            Ordering::SeqCst,
        );
        let _ = self.cancelled_operation_id.compare_exchange(
            operation_id,
            0,
            Ordering::SeqCst,
            Ordering::SeqCst,
        );
    }
}

pub struct ActivityTracker {
    active_seconds: u64,
    last_persisted_seconds: u64,
    last_tick: Instant,
}

impl Default for ActivityTracker {
    fn default() -> Self {
        Self::with_active_seconds(0)
    }
}

impl ActivityTracker {
    pub fn with_active_seconds(active_seconds: u64) -> Self {
        Self {
            active_seconds,
            last_persisted_seconds: active_seconds,
            last_tick: Instant::now(),
        }
    }

    pub fn tick(
        &mut self,
        idle_seconds: Option<u64>,
        enabled: bool,
        in_active_window: bool,
        interval_minutes: u32,
    ) -> bool {
        let now = Instant::now();
        let elapsed_seconds = now.duration_since(self.last_tick).as_secs().min(30);
        self.last_tick = now;
        self.advance(
            elapsed_seconds,
            idle_seconds,
            enabled,
            in_active_window,
            interval_minutes,
        )
    }

    fn advance(
        &mut self,
        elapsed_seconds: u64,
        idle_seconds: Option<u64>,
        enabled: bool,
        in_active_window: bool,
        interval_minutes: u32,
    ) -> bool {
        if !enabled || !in_active_window {
            self.active_seconds = 0;
            return false;
        }
        let Some(idle_seconds) = idle_seconds else {
            return false;
        };
        if idle_seconds >= ACTIVITY_BREAK_RESET_SECONDS {
            self.active_seconds = 0;
            return false;
        }
        if idle_seconds >= ACTIVITY_IDLE_PAUSE_SECONDS {
            return false;
        }
        self.active_seconds = self.active_seconds.saturating_add(elapsed_seconds);
        let threshold = u64::from(interval_minutes.clamp(15, 240)) * 60;
        if self.active_seconds < threshold {
            return false;
        }
        self.active_seconds = 0;
        true
    }

    pub fn take_persistence_update(&mut self) -> Option<u64> {
        let changed_by = self.active_seconds.abs_diff(self.last_persisted_seconds);
        if changed_by < 60 && !(self.active_seconds == 0 && self.last_persisted_seconds != 0) {
            return None;
        }
        self.last_persisted_seconds = self.active_seconds;
        Some(self.active_seconds)
    }

    pub fn replace_active_seconds(&mut self, active_seconds: u64) {
        self.active_seconds = active_seconds;
        self.last_persisted_seconds = active_seconds;
        self.last_tick = Instant::now();
    }
}

pub struct AppState {
    pub repository: Mutex<Repository>,
    pub activity_tracker: Mutex<ActivityTracker>,
    pub automatic_sleep_commanded: AtomicBool,
    pub automatic_sleep_reunion_eligible: AtomicBool,
    pub automatic_sleep_peak_idle_seconds: AtomicU64,
    pub manual_sleep_active: AtomicBool,
    pub quitting: AtomicBool,
    pub basic_support: Mutex<Option<BasicSupportSession>>,
    pub scene_rest: Mutex<Option<SceneRestSession>>,
    pub work_timing: Mutex<WorkTimingState>,
    pub presentation_arbiter: Mutex<PresentationArbiter>,
    #[cfg(feature = "learning")]
    pub learning: Mutex<LearningRuntime>,
    #[cfg(feature = "learning")]
    pub learning_import_cancellation: LearningImportCancellation,
    #[cfg(feature = "learning")]
    pub learning_invitation_gate: Mutex<()>,
    #[cfg(windows)]
    pub companion_expression: Mutex<CompanionExpressionDirector>,
    #[cfg(windows)]
    pub companion_occurrence_keys: Mutex<HashSet<crate::companion_core::ExpressionKey>>,
    #[cfg(windows)]
    pub companion_task_keys: Mutex<HashSet<crate::companion_core::ExpressionKey>>,
    pub _log_guard: WorkerGuard,
}

impl AppState {
    pub fn new(
        repository: Repository,
        log_guard: WorkerGuard,
        activity_active_seconds: u64,
    ) -> Self {
        Self {
            repository: Mutex::new(repository),
            activity_tracker: Mutex::new(ActivityTracker::with_active_seconds(
                activity_active_seconds,
            )),
            automatic_sleep_commanded: AtomicBool::new(false),
            automatic_sleep_reunion_eligible: AtomicBool::new(false),
            automatic_sleep_peak_idle_seconds: AtomicU64::new(0),
            manual_sleep_active: AtomicBool::new(false),
            quitting: AtomicBool::new(false),
            basic_support: Mutex::new(None),
            scene_rest: Mutex::new(None),
            work_timing: Mutex::new(WorkTimingState::default()),
            presentation_arbiter: Mutex::new(PresentationArbiter::default()),
            #[cfg(feature = "learning")]
            learning: Mutex::new(LearningRuntime::default()),
            #[cfg(feature = "learning")]
            learning_import_cancellation: LearningImportCancellation::default(),
            #[cfg(feature = "learning")]
            learning_invitation_gate: Mutex::new(()),
            #[cfg(windows)]
            companion_expression: Mutex::new(CompanionExpressionDirector::default()),
            #[cfg(windows)]
            companion_occurrence_keys: Mutex::new(HashSet::new()),
            #[cfg(windows)]
            companion_task_keys: Mutex::new(HashSet::new()),
            _log_guard: log_guard,
        }
    }

    pub fn set_quitting(&self) {
        self.quitting.store(true, Ordering::SeqCst);
    }

    pub fn is_quitting(&self) -> bool {
        self.quitting.load(Ordering::SeqCst)
    }

    pub fn clear_automatic_sleep_reunion(&self) {
        self.automatic_sleep_reunion_eligible
            .store(false, Ordering::SeqCst);
        self.automatic_sleep_peak_idle_seconds
            .store(0, Ordering::SeqCst);
    }

    #[cfg(feature = "learning")]
    pub fn configure_learning(&self, path: &std::path::Path) {
        *self.learning.lock() = LearningRuntime::configured(path);
    }

    pub fn runtime_capabilities(&self) -> crate::models::RuntimeCapabilities {
        #[cfg(feature = "learning")]
        {
            let mut capabilities = crate::models::RuntimeCapabilities::current();
            capabilities.learning = self.learning.lock().capabilities();
            capabilities
        }
        #[cfg(not(feature = "learning"))]
        {
            crate::models::RuntimeCapabilities::current()
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn activity_tracker_fires_after_continuous_active_use() {
        let mut tracker = ActivityTracker::default();
        assert!(!tracker.advance(59 * 60, Some(2), true, true, 60));
        assert!(tracker.advance(60, Some(3), true, true, 60));
    }

    #[test]
    fn activity_tracker_pauses_during_a_short_idle_period() {
        let mut tracker = ActivityTracker::default();
        assert!(!tracker.advance(50 * 60, Some(1), true, true, 60));
        assert!(!tracker.advance(15, Some(ACTIVITY_IDLE_PAUSE_SECONDS), true, true, 60,));
        assert!(tracker.advance(10 * 60, Some(1), true, true, 60));
    }

    #[test]
    fn activity_tracker_resets_after_a_real_break() {
        let mut tracker = ActivityTracker::default();
        assert!(!tracker.advance(50 * 60, Some(1), true, true, 60));
        assert!(!tracker.advance(15, Some(ACTIVITY_BREAK_RESET_SECONDS), true, true, 60,));
        assert!(!tracker.advance(10 * 60, Some(1), true, true, 60));
    }

    #[test]
    fn activity_tracker_pauses_outside_the_configured_window() {
        let mut tracker = ActivityTracker::default();
        assert!(!tracker.advance(59 * 60, Some(1), true, true, 60));
        assert!(!tracker.advance(60, Some(1), true, false, 60));
        assert!(!tracker.advance(60, Some(1), false, true, 60));
    }

    #[test]
    fn activity_tracker_persists_each_minute_and_on_reset() {
        let mut tracker = ActivityTracker::with_active_seconds(120);
        assert!(tracker.take_persistence_update().is_none());
        assert!(!tracker.advance(59, Some(1), true, true, 60));
        assert!(tracker.take_persistence_update().is_none());
        assert!(!tracker.advance(1, Some(1), true, true, 60));
        assert_eq!(tracker.take_persistence_update(), Some(180));
        assert!(!tracker.advance(1, Some(ACTIVITY_BREAK_RESET_SECONDS), true, true, 60,));
        assert_eq!(tracker.take_persistence_update(), Some(0));
    }

    #[test]
    fn real_rest_rebases_every_in_memory_task_timer_and_restart_clears_it() {
        let first_task = [1; 16];
        let second_task = [2; 16];
        let mut timing = WorkTimingState::default();
        timing.task_started_at_unix_ms.insert(first_task, 1_000);
        timing.task_started_at_unix_ms.insert(second_task, 1_500);

        timing.mark_recovered(5_000);
        assert_eq!(timing.recovered_at_unix_ms, 5_000);
        assert_eq!(timing.task_started_at_unix_ms[&first_task], 5_000);
        assert_eq!(timing.task_started_at_unix_ms[&second_task], 5_000);

        // A stale recovery observation must not move the baseline backwards.
        timing.mark_recovered(4_000);
        assert_eq!(timing.recovered_at_unix_ms, 5_000);
        assert!(timing
            .task_started_at_unix_ms
            .values()
            .all(|started_at| *started_at == 5_000));

        // This state is intentionally process-only; constructing the next
        // application state starts with no task history or recovery timestamp.
        let restarted = WorkTimingState::default();
        assert!(restarted.task_started_at_unix_ms.is_empty());
        assert_eq!(restarted.recovered_at_unix_ms, 0);
    }

    #[cfg(feature = "learning")]
    #[test]
    fn learning_import_cancellation_is_scoped_to_one_active_operation() {
        let cancellation = LearningImportCancellation::default();
        let first = cancellation.begin().unwrap();
        assert!(cancellation.begin().is_err());
        assert!(!cancellation.is_cancelled(first));
        assert!(cancellation.cancel_active());
        assert!(cancellation.is_cancelled(first));

        cancellation.finish(first);
        assert!(!cancellation.cancel_active());
        let second = cancellation.begin().unwrap();
        assert_ne!(first, second);
        assert!(!cancellation.is_cancelled(second));
        cancellation.finish(second);
    }
}
