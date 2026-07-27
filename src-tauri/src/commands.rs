use chrono::{Duration, Utc};
use serde_json::Value;
use tauri::{AppHandle, Emitter, Manager, State};
use tauri_plugin_autostart::ManagerExt;

use crate::{
    error::{AppError, AppResult},
    models::{
        AppSettings, CreateReminderInput, FocusState, PetCareSnapshot, PetInteractionStarted,
        PetIntent, TodaySnapshot,
    },
    notifications,
    state::AppState,
    windows,
};

#[tauri::command]
pub fn list_today(app: AppHandle, state: State<'_, AppState>) -> AppResult<TodaySnapshot> {
    state
        .repository
        .lock()
        .list_today(notifications::available(&app))
}

#[tauri::command]
pub fn list_history(
    days: Option<u32>,
    status: Option<String>,
    category: Option<String>,
    query: Option<String>,
    limit: Option<u32>,
    state: State<'_, AppState>,
) -> AppResult<Vec<crate::models::Occurrence>> {
    state.repository.lock().list_history(
        days,
        status.as_deref(),
        category.as_deref(),
        query.as_deref(),
        limit.unwrap_or(200),
    )
}

#[tauri::command]
pub fn create_reminder(input: CreateReminderInput, state: State<'_, AppState>) -> AppResult<()> {
    state.repository.lock().create_reminder(input)?;
    Ok(())
}

#[tauri::command]
pub fn complete_occurrence(
    app: AppHandle,
    id: String,
    state: State<'_, AppState>,
) -> AppResult<()> {
    let is_water = {
        let mut repository = state.repository.lock();
        repository.complete_occurrence(&id)?
    };
    app.emit("occurrence-updated", ())
        .map_err(|error| AppError::Window(error.to_string()))?;
    app.emit(
        "pet-intent-resolved",
        serde_json::json!({ "occurrenceId": id }),
    )
    .map_err(|error| AppError::Window(error.to_string()))?;
    if is_water {
        emit_waiting_activity(&app);
    }
    Ok(())
}

#[tauri::command]
pub fn snooze_occurrence(
    app: AppHandle,
    id: String,
    minutes: Option<u32>,
    state: State<'_, AppState>,
) -> AppResult<()> {
    state.repository.lock().update_occurrence(
        &id,
        "snoozed",
        Some(minutes.unwrap_or(10).clamp(1, 240)),
    )?;
    app.emit("occurrence-updated", ())
        .map_err(|error| AppError::Window(error.to_string()))?;
    app.emit(
        "pet-intent",
        PetIntent::transient(
            "snoozed",
            110,
            "waiting",
            "today",
            "稍后再提醒",
            format!(
                "圆圆会在 {} 分钟后再来找你。",
                minutes.unwrap_or(10).clamp(1, 240)
            ),
            Some(id),
            7,
        ),
    )
    .map_err(|error| AppError::Window(error.to_string()))
}

#[tauri::command]
pub fn skip_occurrence(app: AppHandle, id: String, state: State<'_, AppState>) -> AppResult<()> {
    let is_water = {
        let repository = state.repository.lock();
        let is_water = repository.occurrence_is_water(&id)?;
        repository.update_occurrence(&id, "skipped", None)?;
        is_water
    };
    app.emit("occurrence-updated", ())
        .map_err(|error| AppError::Window(error.to_string()))?;
    app.emit(
        "pet-intent",
        PetIntent::transient(
            "skipped",
            110,
            "review",
            "today",
            "这次先跳过",
            "圆圆已经把它从待处理里移开了。",
            Some(id),
            7,
        ),
    )
    .map_err(|error| AppError::Window(error.to_string()))?;
    if is_water {
        emit_waiting_activity(&app);
    }
    Ok(())
}

#[tauri::command]
pub fn record_water(app: AppHandle) -> AppResult<()> {
    record_water_inner(&app)
}

pub fn record_water_inner(app: &AppHandle) -> AppResult<()> {
    app.state::<AppState>().repository.lock().record_water()?;
    app.emit("occurrence-updated", ())
        .map_err(|error| AppError::Window(error.to_string()))?;
    app.emit(
        "pet-intent",
        PetIntent::transient(
            "success",
            110,
            "jumping",
            "today",
            "喝水 +1",
            "做得好，圆圆陪你继续保持。",
            None,
            7,
        ),
    )
    .map_err(|error| AppError::Window(error.to_string()))?;
    emit_waiting_activity(app);
    Ok(())
}

fn emit_waiting_activity(app: &AppHandle) {
    if let Err(error) = crate::scheduler::emit_ready_activity(app) {
        tracing::warn!(error = %error, "queued activity reminder could not be emitted");
    }
}

#[tauri::command]
pub fn get_focus_state(state: State<'_, AppState>) -> AppResult<FocusState> {
    state.repository.lock().get_focus_state()
}

#[tauri::command]
pub fn get_pet_care(state: State<'_, AppState>) -> AppResult<PetCareSnapshot> {
    state.repository.lock().get_pet_care()
}

#[tauri::command]
pub fn start_pet_interaction(
    app: AppHandle,
    kind: String,
    state: State<'_, AppState>,
) -> AppResult<PetCareSnapshot> {
    if state
        .repository
        .lock()
        .get_focus_state()?
        .session
        .is_some_and(|session| session.phase == "focus")
    {
        return Err(AppError::Validation(
            "专注期间圆圆会乖乖陪伴，结束后再一起玩吧。".into(),
        ));
    }
    let snapshot = state.repository.lock().record_pet_interaction(&kind)?;
    let (animation, title, message, seconds, interactive) = match kind.as_str() {
        "food" => (
            "eating-food",
            "开饭啦",
            "圆圆正在认真吃猫粮。",
            8,
            false,
        ),
        "water" => (
            "drinking-water",
            "补充水分",
            "圆圆咕噜咕噜喝水中。",
            8,
            false,
        ),
        "treat" => (
            "treat-follow",
            "猫条时间",
            "拖动猫条，圆圆会追着它吃。",
            14,
            true,
        ),
        "wand" => (
            "wand-reach",
            "一起玩吧",
            "按住逗猫棒移向不同方位，圆圆会用对应的爪子抓。",
            14,
            true,
        ),
        "pet" => (
            "pet-nuzzle",
            "摸摸圆圆",
            "把鼠标移到圆圆头上轻轻移动，它会朝你的方向蹭一蹭。",
            14,
            true,
        ),
        "ball" => (
            "idle",
            "扔球游戏",
            "按住球蓄力，松手后圆圆会把球捡回来。",
            18,
            true,
        ),
        _ => {
            return Err(AppError::Validation(
                "unsupported pet interaction".into(),
            ))
        }
    };
    if interactive {
        app.emit(
            "pet-interaction-started",
            PetInteractionStarted {
                id: uuid::Uuid::new_v4().to_string(),
                kind: kind.clone(),
            },
        )
        .map_err(|error| AppError::Window(error.to_string()))?;
    } else {
        app.emit(
            "pet-intent",
            PetIntent::transient(
                "care",
                45,
                animation,
                "care",
                title,
                message,
                None,
                seconds,
            ),
        )
        .map_err(|error| AppError::Window(error.to_string()))?;
    }
    app.emit("pet-care-updated", &snapshot)
        .map_err(|error| AppError::Window(error.to_string()))?;
    Ok(snapshot)
}

#[tauri::command]
pub fn start_focus(
    app: AppHandle,
    phase: String,
    duration_minutes: u32,
    state: State<'_, AppState>,
) -> AppResult<FocusState> {
    let focus_state = state
        .repository
        .lock()
        .start_focus(&phase, duration_minutes)?;
    let (animation, title, message) = if phase == "focus" {
        (
            "focus-calm",
            "专注进行中",
            format!("圆圆陪你专注 {duration_minutes} 分钟。"),
        )
    } else {
        (
            "waiting",
            "休息一下",
            format!("圆圆陪你休息 {duration_minutes} 分钟。"),
        )
    };
    app.emit("focus-updated", &focus_state)
        .map_err(|error| AppError::Window(error.to_string()))?;
    app.emit(
        "pet-intent",
        PetIntent::persistent(&phase, 50, animation, "focus", title, message),
    )
    .map_err(|error| AppError::Window(error.to_string()))?;
    if phase == "break" {
        if let Err(error) = windows::lock_workstation() {
            tracing::warn!(error = %error, "could not lock Windows for the break timer");
        }
    }
    Ok(focus_state)
}

#[tauri::command]
pub fn cancel_focus(app: AppHandle, state: State<'_, AppState>) -> AppResult<FocusState> {
    let focus_state = state.repository.lock().cancel_focus()?;
    app.emit("focus-updated", &focus_state)
        .map_err(|error| AppError::Window(error.to_string()))?;
    app.emit(
        "pet-intent",
        PetIntent::transient(
            "idle",
            40,
            "idle",
            "focus",
            "计时已停止",
            "圆圆在这里，随时可以重新开始。",
            None,
            5,
        ),
    )
    .map_err(|error| AppError::Window(error.to_string()))?;
    Ok(focus_state)
}

#[tauri::command]
pub fn get_settings(state: State<'_, AppState>) -> AppResult<AppSettings> {
    state.repository.lock().get_settings()
}

#[tauri::command]
pub fn update_settings(
    app: AppHandle,
    patch: Value,
    state: State<'_, AppState>,
) -> AppResult<AppSettings> {
    let mut settings = state.repository.lock().update_settings(patch)?;
    sync_autostart(&app, settings.autostart)?;
    windows::apply_settings(&app, &mut settings)?;
    state.repository.lock().save_settings(&settings)?;
    app.emit("settings-updated", &settings)
        .map_err(|error| AppError::Window(error.to_string()))?;
    Ok(settings)
}

#[tauri::command]
pub fn show_task_panel(app: AppHandle, route: Option<String>) -> AppResult<()> {
    windows::show_task_panel(&app, route.as_deref().unwrap_or("today"))
}

#[tauri::command]
pub fn hide_pet_window(app: AppHandle) -> AppResult<()> {
    let pet = app
        .get_webview_window("pet")
        .ok_or_else(|| AppError::Window("pet window is unavailable".into()))?;
    pet.hide()
        .map_err(|error| AppError::Window(error.to_string()))
}

#[tauri::command]
pub fn save_pet_position(app: AppHandle, x: i32, y: i32) -> AppResult<()> {
    let state = app.state::<AppState>();
    let mut settings = state.repository.lock().get_settings()?;
    settings.pet_x = Some(x);
    settings.pet_y = Some(y);
    state.repository.lock().save_settings(&settings)?;
    Ok(())
}

#[tauri::command]
pub fn set_pet_size(app: AppHandle, width: u32) -> AppResult<()> {
    let state = app.state::<AppState>();
    let mut settings = state.repository.lock().get_settings()?;
    settings.pet_width = width.clamp(120, 320);
    windows::apply_settings(&app, &mut settings)?;
    state.repository.lock().save_settings(&settings)?;
    app.emit("settings-updated", &settings)
        .map_err(|error| AppError::Window(error.to_string()))
}

#[tauri::command]
pub fn set_always_on_top(app: AppHandle, enabled: bool) -> AppResult<()> {
    set_always_on_top_inner(&app, enabled)
}

pub fn set_always_on_top_inner(app: &AppHandle, enabled: bool) -> AppResult<()> {
    let state = app.state::<AppState>();
    let mut settings = state.repository.lock().get_settings()?;
    settings.always_on_top = enabled;
    windows::apply_settings(app, &mut settings)?;
    state.repository.lock().save_settings(&settings)?;
    app.emit("settings-updated", &settings)
        .map_err(|error| AppError::Window(error.to_string()))
}

#[tauri::command]
pub fn set_click_through(app: AppHandle, enabled: bool) -> AppResult<()> {
    set_click_through_inner(&app, enabled)
}

pub fn set_click_through_inner(app: &AppHandle, enabled: bool) -> AppResult<()> {
    let state = app.state::<AppState>();
    let mut settings = state.repository.lock().get_settings()?;
    settings.click_through = enabled;
    windows::apply_settings(app, &mut settings)?;
    state.repository.lock().save_settings(&settings)?;
    app.emit("settings-updated", &settings)
        .map_err(|error| AppError::Window(error.to_string()))
}

#[tauri::command]
pub fn request_sleep(app: AppHandle) -> AppResult<()> {
    app.emit("pet-request-sleep", ())
        .map_err(|error| AppError::Window(error.to_string()))
}

#[tauri::command]
pub fn request_wake(app: AppHandle) -> AppResult<()> {
    app.emit("pet-request-wake", ())
        .map_err(|error| AppError::Window(error.to_string()))
}

#[tauri::command]
pub fn pause_reminders(app: AppHandle, minutes: u32) -> AppResult<()> {
    pause_reminders_inner(&app, minutes)
}

pub fn pause_reminders_inner(app: &AppHandle, minutes: u32) -> AppResult<()> {
    let state = app.state::<AppState>();
    let mut settings = state.repository.lock().get_settings()?;
    settings.pause_until =
        Some((Utc::now() + Duration::minutes(i64::from(minutes.clamp(1, 1440)))).to_rfc3339());
    state.repository.lock().save_settings(&settings)?;
    app.emit("settings-updated", &settings)
        .map_err(|error| AppError::Window(error.to_string()))
}

#[tauri::command]
pub fn show_pet_context_menu(app: AppHandle) -> AppResult<()> {
    windows::show_pet_context_menu(&app)
}

#[tauri::command]
pub fn quit_application(app: AppHandle) {
    quit_inner(&app);
}

pub fn quit_inner(app: &AppHandle) {
    app.state::<AppState>().set_quitting();
    app.exit(0);
}

fn sync_autostart(app: &AppHandle, enabled: bool) -> AppResult<()> {
    let manager = app.autolaunch();
    let currently_enabled = manager
        .is_enabled()
        .map_err(|error| AppError::Window(error.to_string()))?;
    if enabled && !currently_enabled {
        manager
            .enable()
            .map_err(|error| AppError::Window(error.to_string()))?;
    } else if !enabled && currently_enabled {
        manager
            .disable()
            .map_err(|error| AppError::Window(error.to_string()))?;
    }
    Ok(())
}
