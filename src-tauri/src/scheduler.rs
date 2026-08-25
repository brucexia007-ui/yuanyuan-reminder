use std::{sync::atomic::Ordering, time::Duration};

use chrono::{DateTime, Local, NaiveTime, Utc};
use tauri::{AppHandle, Emitter, Manager};

use crate::{
    error::AppResult,
    models::AppSettings,
    models::{FocusState, PetIntent},
    notifications,
    repository::SYSTEM_ACTIVITY_REMINDER_ID,
    state::AppState,
};

const REUNION_MIN_IDLE_SECONDS: u64 = 10 * 60;

pub fn spawn(app: AppHandle) {
    tauri::async_runtime::spawn(async move {
        loop {
            run_tick(&app);
            tokio::time::sleep(Duration::from_secs(15)).await;
        }
    });
}

fn run_tick(app: &AppHandle) {
    let state = app.state::<AppState>();
    if state.is_quitting() {
        return;
    }

    let now = Utc::now();
    let (due, mut settings, completed_focus, focus_state) = {
        let mut repository = state.repository.lock();
        let due = repository.claim_due(now);
        let settings = repository.get_settings();
        let completed_focus = repository.complete_due_focus(now);
        let focus_state = repository.get_focus_state();
        (due, settings, completed_focus, focus_state)
    };

    if let Ok(settings) = &mut settings {
        if settings.pause_until.is_some() && !pause_active(settings, now.timestamp_millis()) {
            settings.pause_until = None;
            match state.repository.lock().save_settings(settings) {
                Ok(()) => {
                    if let Err(error) = app.emit("settings-updated", &*settings) {
                        tracing::warn!(error = %error, "expired pause state could not be emitted");
                    }
                }
                Err(error) => {
                    tracing::warn!(error = %error, "expired pause state could not be cleared");
                }
            }
        }
        #[cfg(windows)]
        if let Err(error) = crate::companion_runtime::set_quiet_active(
            app,
            pause_active(settings, now.timestamp_millis()),
        ) {
            tracing::warn!(error = %error, "companion quiet state could not be updated");
        }
        #[cfg(feature = "runtime-qa")]
        let automatic_sleep_isolated = crate::runtime_qa::isolates_automatic_sleep();
        #[cfg(not(feature = "runtime-qa"))]
        let automatic_sleep_isolated = false;
        if !automatic_sleep_isolated {
            update_automatic_sleep(
                app,
                &state,
                &settings.quiet_start,
                &settings.quiet_end,
                settings.idle_sleep_minutes,
            );
        }
        update_activity_tracking(
            &state,
            settings,
            focus_state
                .as_ref()
                .ok()
                .and_then(|focus| focus.session.as_ref())
                .is_some_and(|session| session.phase == "break"),
            now,
        );
    }

    let Ok(due) = due else {
        tracing::error!("scheduler tick failed");
        return;
    };
    #[cfg(windows)]
    if let Err(error) = crate::companion_runtime::sync_local_occurrences(app) {
        tracing::warn!(error = %error, "local reminder expression state could not be synchronized");
    }
    #[cfg(windows)]
    if let Err(error) = crate::companion_runtime::sync_external_tasks(app, now.timestamp_millis()) {
        tracing::warn!(error = %error, "external task expression state could not be synchronized");
    }
    if let Ok(Some(session)) = completed_focus {
        if session.phase == "break" {
            crate::windows::wake_display();
            if let Err(error) = notifications::send_break_complete(app) {
                tracing::warn!(error = %error, "break completion notification unavailable");
            }
        }
        let focus_state = FocusState { session: None };
        let _ = app.emit("focus-updated", &focus_state);
        #[cfg(windows)]
        if let Err(error) = crate::companion_runtime::set_focus_active(app, false) {
            tracing::warn!(error = %error, "companion focus state could not be updated");
        }
        #[cfg(windows)]
        if session.phase == "focus" {
            #[cfg(feature = "learning")]
            let learning_presented = crate::companion_runtime::try_present_focus_finished_learning_invitation(
                app,
                now.timestamp_millis(),
            )
            .unwrap_or_else(|error| {
                tracing::warn!(error = %error, "focus completion learning invitation was suppressed");
                false
            });
            #[cfg(not(feature = "learning"))]
            let learning_presented = false;
            if !learning_presented {
                if let Err(error) = crate::companion_runtime::try_present_focus_finished_ritual(
                    app,
                    now.timestamp_millis(),
                ) {
                    tracing::warn!(error = %error, "focus completion ritual could not be presented");
                }
            }
        }
    } else if completed_focus.is_err() {
        tracing::error!("focus timer tick failed");
    }
    for item in due {
        if !item.notify {
            let _ = app.emit("occurrence-updated", ());
            continue;
        }
        if item.occurrence.reminder_id == SYSTEM_ACTIVITY_REMINDER_ID {
            continue;
        }
        if let Err(error) = notifications::send_due(app, &item.occurrence) {
            tracing::warn!(error = %error, "OS notification unavailable; in-app reminder remains active");
        }
        let _ = app.emit("reminder-due", &item.occurrence);
        let is_water = item.occurrence.category == "water";
        let _ = app.emit(
            "pet-intent",
            PetIntent {
                id: uuid::Uuid::new_v4().to_string(),
                kind: "reminder".into(),
                priority: 100,
                animation: "alert-glass-paws".into(),
                route: "today".into(),
                title: if is_water {
                    "喝水提醒".into()
                } else {
                    "事项提醒".into()
                },
                message: item.occurrence.reminder_title,
                occurrence_id: Some(item.occurrence.id),
                persistent: true,
                expires_at: None,
            },
        );
    }
    if let Err(error) = emit_ready_activity(app) {
        tracing::warn!(error = %error, "activity reminder could not be emitted");
    }
}

fn update_activity_tracking(
    state: &AppState,
    settings: &AppSettings,
    break_active: bool,
    now: DateTime<Utc>,
) {
    let (Ok(start), Ok(end)) = (
        NaiveTime::parse_from_str(&settings.activity_start, "%H:%M"),
        NaiveTime::parse_from_str(&settings.activity_end, "%H:%M"),
    ) else {
        return;
    };
    let paused = settings
        .pause_until
        .as_deref()
        .and_then(|value| DateTime::parse_from_rfc3339(value).ok())
        .is_some_and(|until| until.with_timezone(&Utc) > now);
    let support_active = state.basic_support.lock().is_some();
    let in_active_window = is_time_in_window(start, end, Local::now().time());
    let (should_trigger, persistence_update) = {
        let mut tracker = state.activity_tracker.lock();
        let should_trigger = tracker.tick(
            system_idle_seconds(),
            settings.activity_enabled && !paused && !break_active && !support_active,
            in_active_window,
            settings.activity_interval_minutes,
        );
        (should_trigger, tracker.take_persistence_update())
    };
    if let Some(active_seconds) = persistence_update {
        if let Err(error) = state
            .repository
            .lock()
            .save_activity_active_seconds(active_seconds)
        {
            tracing::warn!(error = %error, "activity tracking progress could not be saved");
        }
    }
    if should_trigger {
        match state.repository.lock().create_activity_occurrence(now) {
            Ok(Some(occurrence)) => {
                tracing::info!(
                    occurrence_id = %occurrence.id,
                    interval_minutes = settings.activity_interval_minutes,
                    "activity reminder created"
                );
            }
            Ok(None) => {}
            Err(error) => {
                tracing::warn!(error = %error, "activity occurrence could not be created");
            }
        }
    }
}

pub(crate) fn emit_ready_activity(app: &AppHandle) -> AppResult<()> {
    let occurrence = app
        .state::<AppState>()
        .repository
        .lock()
        .take_ready_activity_alert()?;
    let Some(occurrence) = occurrence else {
        return Ok(());
    };
    if let Err(error) = notifications::send_activity_due(app, &occurrence) {
        tracing::warn!(error = %error, "activity OS notification unavailable");
    }
    let _ = app.emit("reminder-due", &occurrence);
    #[cfg(windows)]
    crate::companion_runtime::sync_local_occurrences(app)?;
    app.emit(
        "pet-intent",
        PetIntent {
            id: uuid::Uuid::new_v4().to_string(),
            kind: "activity".into(),
            priority: 90,
            animation: "activity-jumping".into(),
            route: "today".into(),
            title: "起来活动一下".into(),
            message: "你已经连续使用电脑一段时间，可以起来活动一下。".into(),
            occurrence_id: Some(occurrence.id),
            persistent: true,
            expires_at: None,
        },
    )
    .map_err(|error| crate::error::AppError::Window(error.to_string()))
}

fn update_automatic_sleep(
    app: &AppHandle,
    state: &AppState,
    start: &str,
    end: &str,
    idle_sleep_minutes: u32,
) {
    let (Ok(start), Ok(end)) = (
        NaiveTime::parse_from_str(start, "%H:%M"),
        NaiveTime::parse_from_str(end, "%H:%M"),
    ) else {
        return;
    };
    let now = Local::now().time();
    let in_quiet = is_quiet_time(start, end, now);
    let idle_seconds = system_idle_seconds();
    let is_idle = idle_sleep_minutes > 0
        && idle_seconds.is_some_and(|seconds| seconds >= u64::from(idle_sleep_minutes) * 60);
    let should_sleep = in_quiet || is_idle;
    let was_sleeping = state
        .automatic_sleep_commanded
        .swap(should_sleep, Ordering::SeqCst);
    if should_sleep && !was_sleeping {
        let manual_sleep_active = state.manual_sleep_active.load(Ordering::SeqCst);
        let reunion_eligible =
            sleep_start_can_lead_to_reunion(in_quiet, is_idle, manual_sleep_active);
        state
            .automatic_sleep_reunion_eligible
            .store(reunion_eligible, Ordering::SeqCst);
        state.automatic_sleep_peak_idle_seconds.store(
            if reunion_eligible {
                idle_seconds.unwrap_or_default()
            } else {
                0
            },
            Ordering::SeqCst,
        );
        #[cfg(windows)]
        if let Err(error) = crate::companion_runtime::set_sleeping(
            app,
            true,
            crate::presentation_arbiter::PetActivitySource::Schedule,
        ) {
            tracing::warn!(error = %error, "companion sleep state could not be updated");
        }
        let _ = app.emit(
            "pet-request-sleep",
            serde_json::json!({ "source": "automatic" }),
        );
    } else if should_sleep
        && state
            .automatic_sleep_reunion_eligible
            .load(Ordering::SeqCst)
    {
        if in_quiet {
            state.clear_automatic_sleep_reunion();
        } else if let Some(idle_seconds) = idle_seconds {
            state
                .automatic_sleep_peak_idle_seconds
                .fetch_max(idle_seconds, Ordering::SeqCst);
        }
    } else if !should_sleep && was_sleeping {
        let reunion_eligible = state
            .automatic_sleep_reunion_eligible
            .swap(false, Ordering::SeqCst);
        let peak_idle_seconds = state
            .automatic_sleep_peak_idle_seconds
            .swap(0, Ordering::SeqCst);
        if !state.manual_sleep_active.load(Ordering::SeqCst) {
            #[cfg(windows)]
            if let Err(error) = crate::companion_runtime::set_sleeping(
                app,
                false,
                crate::presentation_arbiter::PetActivitySource::Schedule,
            ) {
                tracing::warn!(error = %error, "companion wake state could not be updated");
            }
            let _ = app.emit("pet-request-wake", ());
            #[cfg(windows)]
            if reunion_eligible && reunion_idle_is_long_enough(peak_idle_seconds) {
                if let Err(error) = crate::companion_runtime::try_present_reunion_ritual(
                    app,
                    Utc::now().timestamp_millis(),
                ) {
                    tracing::warn!(error = %error, "reunion ritual could not be presented");
                }
            }
        }
    }
}

fn sleep_start_can_lead_to_reunion(
    in_quiet: bool,
    is_idle: bool,
    manual_sleep_active: bool,
) -> bool {
    is_idle && !in_quiet && !manual_sleep_active
}

fn reunion_idle_is_long_enough(peak_idle_seconds: u64) -> bool {
    peak_idle_seconds >= REUNION_MIN_IDLE_SECONDS
}

fn is_quiet_time(start: NaiveTime, end: NaiveTime, now: NaiveTime) -> bool {
    if end >= start {
        now >= start && now < end
    } else {
        now >= start || now < end
    }
}

fn pause_active(settings: &AppSettings, now_unix_ms: i64) -> bool {
    settings
        .pause_until
        .as_deref()
        .and_then(|value| DateTime::parse_from_rfc3339(value).ok())
        .is_some_and(|until| until.timestamp_millis() > now_unix_ms)
}

fn is_time_in_window(start: NaiveTime, end: NaiveTime, now: NaiveTime) -> bool {
    if end >= start {
        now >= start && now <= end
    } else {
        now >= start || now <= end
    }
}

#[cfg(windows)]
fn system_idle_seconds() -> Option<u64> {
    use windows_sys::Win32::{
        System::SystemInformation::GetTickCount,
        UI::Input::KeyboardAndMouse::{GetLastInputInfo, LASTINPUTINFO},
    };

    let mut info = LASTINPUTINFO {
        cbSize: std::mem::size_of::<LASTINPUTINFO>() as u32,
        dwTime: 0,
    };
    // SAFETY: GetLastInputInfo receives a valid, correctly sized output structure.
    let ok = unsafe { GetLastInputInfo(&mut info) };
    if ok == 0 {
        return None;
    }
    let elapsed_ms = unsafe { GetTickCount() }.wrapping_sub(info.dwTime);
    Some(u64::from(elapsed_ms / 1_000))
}

#[cfg(not(windows))]
fn system_idle_seconds() -> Option<u64> {
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn quiet_period_can_cross_midnight() {
        let start = NaiveTime::from_hms_opt(23, 0, 0).unwrap();
        let end = NaiveTime::from_hms_opt(7, 30, 0).unwrap();
        assert!(is_quiet_time(
            start,
            end,
            NaiveTime::from_hms_opt(1, 0, 0).unwrap()
        ));
        assert!(!is_quiet_time(
            start,
            end,
            NaiveTime::from_hms_opt(12, 0, 0).unwrap()
        ));
    }

    #[test]
    fn pause_deadline_is_absolute_and_invalid_values_fail_quiet() {
        let now = DateTime::parse_from_rfc3339("2026-08-05T10:00:00Z")
            .unwrap()
            .timestamp_millis();
        let mut settings = AppSettings {
            pause_until: Some("2026-08-05T10:30:00Z".into()),
            ..AppSettings::default()
        };
        assert!(pause_active(&settings, now));
        settings.pause_until = Some("2026-08-05T09:59:59Z".into());
        assert!(!pause_active(&settings, now));
        settings.pause_until = Some("invalid".into());
        assert!(!pause_active(&settings, now));
    }

    #[test]
    fn activity_window_can_cross_midnight() {
        let start = NaiveTime::from_hms_opt(22, 0, 0).unwrap();
        let end = NaiveTime::from_hms_opt(6, 0, 0).unwrap();
        assert!(is_time_in_window(
            start,
            end,
            NaiveTime::from_hms_opt(23, 30, 0).unwrap(),
        ));
        assert!(is_time_in_window(
            start,
            end,
            NaiveTime::from_hms_opt(5, 30, 0).unwrap(),
        ));
        assert!(!is_time_in_window(
            start,
            end,
            NaiveTime::from_hms_opt(12, 0, 0).unwrap(),
        ));
    }

    #[test]
    fn reunion_requires_idle_started_sleep_outside_quiet_hours() {
        assert!(sleep_start_can_lead_to_reunion(false, true, false));
        assert!(!sleep_start_can_lead_to_reunion(true, true, false));
        assert!(!sleep_start_can_lead_to_reunion(false, false, false));
        assert!(!sleep_start_can_lead_to_reunion(false, true, true));
    }

    #[test]
    fn reunion_requires_a_genuine_long_absence() {
        assert!(!reunion_idle_is_long_enough(REUNION_MIN_IDLE_SECONDS - 1));
        assert!(reunion_idle_is_long_enough(REUNION_MIN_IDLE_SECONDS));
    }
}
