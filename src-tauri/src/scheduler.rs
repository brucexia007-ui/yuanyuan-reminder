use std::time::Duration;

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
    let (due, settings, completed_focus, focus_state) = {
        let mut repository = state.repository.lock();
        let due = repository.claim_due(now);
        let settings = repository.get_settings();
        let completed_focus = repository.complete_due_focus(now);
        let focus_state = repository.get_focus_state();
        (due, settings, completed_focus, focus_state)
    };

    if let Ok(settings) = &settings {
        update_automatic_sleep(
            app,
            &state,
            &settings.quiet_start,
            &settings.quiet_end,
            settings.idle_sleep_minutes,
        );
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
    if let Ok(Some(session)) = completed_focus {
        if session.phase == "break" {
            crate::windows::wake_display();
            if let Err(error) = notifications::send_break_complete(app) {
                tracing::warn!(error = %error, "break completion notification unavailable");
            }
        }
        let focus_state = FocusState { session: None };
        let _ = app.emit("focus-updated", &focus_state);
        let intent = if session.phase == "focus" {
            PetIntent::transient(
                "break",
                90,
                "stretching",
                "focus",
                "专注完成",
                "辛苦啦，和圆圆一起伸个懒腰吧。",
                None,
                12,
            )
        } else {
            PetIntent::transient(
                "success",
                90,
                "jumping",
                "focus",
                "休息结束",
                "圆圆准备好陪你开始下一轮了。",
                None,
                9,
            )
        };
        let _ = app.emit("pet-intent", intent);
    } else if completed_focus.is_err() {
        tracing::error!("focus timer tick failed");
    }
    for item in due {
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
                    "该喝水啦".into()
                } else {
                    "圆圆提醒你".into()
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
    let in_active_window = is_time_in_window(start, end, Local::now().time());
    let should_trigger = state.activity_tracker.lock().tick(
        system_idle_seconds(),
        settings.activity_enabled && !paused && !break_active,
        in_active_window,
        settings.activity_interval_minutes,
    );
    if should_trigger {
        match state.repository.lock().create_activity_occurrence(now) {
            Ok(Some(_)) => {}
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
    app.emit(
        "pet-intent",
        PetIntent {
            id: uuid::Uuid::new_v4().to_string(),
            kind: "activity".into(),
            priority: 90,
            animation: "activity-jumping".into(),
            route: "today".into(),
            title: "起来活动一下".into(),
            message: "你已经连续使用电脑一段时间啦，和圆圆一起动一动吧。".into(),
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
    let is_idle = idle_sleep_minutes > 0
        && system_idle_seconds().is_some_and(|seconds| {
            seconds >= u64::from(idle_sleep_minutes) * 60
        });
    let should_sleep = in_quiet || is_idle;
    let was_sleeping = state
        .automatic_sleep_commanded
        .swap(should_sleep, std::sync::atomic::Ordering::SeqCst);
    if should_sleep && !was_sleeping {
        let _ = app.emit("pet-request-sleep", ());
    } else if !should_sleep && was_sleeping {
        let _ = app.emit("pet-request-wake", ());
    }
}

fn is_quiet_time(start: NaiveTime, end: NaiveTime, now: NaiveTime) -> bool {
    if end >= start {
        now >= start && now < end
    } else {
        now >= start || now < end
    }
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
}
