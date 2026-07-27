use std::{
    sync::atomic::{AtomicBool, Ordering},
    time::Instant,
};

use parking_lot::Mutex;
use tracing_appender::non_blocking::WorkerGuard;

use crate::repository::Repository;

pub const ACTIVITY_IDLE_PAUSE_SECONDS: u64 = 5 * 60;
pub const ACTIVITY_BREAK_RESET_SECONDS: u64 = 10 * 60;

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
        self.active_seconds = self
            .active_seconds
            .saturating_add(elapsed_seconds);
        let threshold = u64::from(interval_minutes.clamp(15, 240)) * 60;
        if self.active_seconds < threshold {
            return false;
        }
        self.active_seconds = 0;
        true
    }

    pub fn take_persistence_update(&mut self) -> Option<u64> {
        let changed_by = self.active_seconds.abs_diff(self.last_persisted_seconds);
        if changed_by < 60
            && !(self.active_seconds == 0 && self.last_persisted_seconds != 0)
        {
            return None;
        }
        self.last_persisted_seconds = self.active_seconds;
        Some(self.active_seconds)
    }
}

pub struct AppState {
    pub repository: Mutex<Repository>,
    pub activity_tracker: Mutex<ActivityTracker>,
    pub automatic_sleep_commanded: AtomicBool,
    pub quitting: AtomicBool,
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
            quitting: AtomicBool::new(false),
            _log_guard: log_guard,
        }
    }

    pub fn set_quitting(&self) {
        self.quitting.store(true, Ordering::SeqCst);
    }

    pub fn is_quitting(&self) -> bool {
        self.quitting.load(Ordering::SeqCst)
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
        assert!(!tracker.advance(
            15,
            Some(ACTIVITY_IDLE_PAUSE_SECONDS),
            true,
            true,
            60,
        ));
        assert!(tracker.advance(10 * 60, Some(1), true, true, 60));
    }

    #[test]
    fn activity_tracker_resets_after_a_real_break() {
        let mut tracker = ActivityTracker::default();
        assert!(!tracker.advance(50 * 60, Some(1), true, true, 60));
        assert!(!tracker.advance(
            15,
            Some(ACTIVITY_BREAK_RESET_SECONDS),
            true,
            true,
            60,
        ));
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
        assert!(!tracker.advance(
            1,
            Some(ACTIVITY_BREAK_RESET_SECONDS),
            true,
            true,
            60,
        ));
        assert_eq!(tracker.take_persistence_update(), Some(0));
    }
}
