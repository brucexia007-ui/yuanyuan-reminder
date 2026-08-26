use tauri::{
    menu::{Menu, MenuItem, PredefinedMenuItem},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    App, AppHandle, Manager,
};

use crate::{
    commands,
    error::{AppError, AppResult},
    windows,
};

pub fn create(app: &App) -> AppResult<()> {
    let open = MenuItem::with_id(app, "tray-open", "打开今日任务", true, None::<&str>)
        .map_err(|error| AppError::Window(error.to_string()))?;
    let show = MenuItem::with_id(app, "tray-show-pet", "显示圆圆", true, None::<&str>)
        .map_err(|error| AppError::Window(error.to_string()))?;
    let water = MenuItem::with_id(app, "tray-water", "记录一次喝水", true, None::<&str>)
        .map_err(|error| AppError::Window(error.to_string()))?;
    let pause = MenuItem::with_id(app, "tray-pause", "暂停提醒 30 分钟", true, None::<&str>)
        .map_err(|error| AppError::Window(error.to_string()))?;
    let restore = MenuItem::with_id(
        app,
        "tray-restore-click",
        "恢复圆圆鼠标交互",
        true,
        None::<&str>,
    )
    .map_err(|error| AppError::Window(error.to_string()))?;
    let quit = MenuItem::with_id(app, "tray-quit", "完全退出", true, None::<&str>)
        .map_err(|error| AppError::Window(error.to_string()))?;
    let separator =
        PredefinedMenuItem::separator(app).map_err(|error| AppError::Window(error.to_string()))?;
    let menu = Menu::with_items(
        app,
        &[&open, &show, &water, &pause, &restore, &separator, &quit],
    )
    .map_err(|error| AppError::Window(error.to_string()))?;

    let icon = app
        .default_window_icon()
        .cloned()
        .ok_or_else(|| AppError::Window("application icon is unavailable".into()))?;

    TrayIconBuilder::with_id("yuanyuan-tray")
        .icon(icon)
        .tooltip("圆圆提醒")
        .menu(&menu)
        .show_menu_on_left_click(false)
        .on_menu_event(|app, event| handle_menu_event(app, event.id().as_ref()))
        .on_tray_icon_event(|tray, event| {
            if matches!(
                event,
                TrayIconEvent::Click {
                    button: MouseButton::Left,
                    button_state: MouseButtonState::Up,
                    ..
                }
            ) {
                let _ = windows::show_task_panel(tray.app_handle(), "today");
            }
        })
        .build(app)
        .map_err(|error| AppError::Window(error.to_string()))?;
    Ok(())
}

pub fn handle_menu_event(app: &AppHandle, id: &str) {
    match id {
        "tray-open" | "pet-open-today" => {
            let _ = windows::show_task_panel(app, "today");
        }
        "pet-add-task" => {
            let _ = windows::show_task_panel(app, "add");
        }
        "pet-settings" => {
            let _ = windows::show_task_panel(app, "settings");
        }
        "tray-show-pet" => {
            if let Some(window) = app.get_webview_window("pet") {
                let _ = window.show();
            }
        }
        "tray-water" | "pet-record-water" => {
            let _ = commands::record_water_inner(app);
        }
        "tray-pause" | "pet-pause" => {
            let _ = commands::pause_reminders_inner(app, 30);
        }
        "tray-restore-click" => {
            let _ = commands::set_click_through_inner(app, false);
        }
        "pet-always-on-top" => {
            let current = app
                .state::<crate::state::AppState>()
                .repository
                .lock()
                .get_settings()
                .map(|settings| settings.always_on_top)
                .unwrap_or(true);
            let _ = commands::set_always_on_top_inner(app, !current);
        }
        "pet-click-through" => {
            let current = app
                .state::<crate::state::AppState>()
                .repository
                .lock()
                .get_settings()
                .map(|settings| settings.click_through)
                .unwrap_or(false);
            let _ = commands::set_click_through_inner(app, !current);
        }
        "pet-learning-quick-start-visible" => {
            let current = app
                .state::<crate::state::AppState>()
                .repository
                .lock()
                .get_settings()
                .map(|settings| settings.learning_quick_start_visible)
                .unwrap_or(true);
            let _ = commands::set_learning_quick_start_visible_inner(app, !current);
        }
        "pet-sleep" => {
            let _ = handle_pet_sleep_menu_event(app);
        }
        "pet-hide" => {
            if let Some(window) = app.get_webview_window("pet") {
                let _ = window.hide();
            }
        }
        "tray-quit" | "pet-quit" => {
            commands::quit_inner(app);
        }
        _ => {}
    }
}

pub fn handle_pet_sleep_menu_event(app: &AppHandle) -> AppResult<()> {
    match commands::pet_sleep_toggle_action(app) {
        commands::PetSleepToggleAction::Sleep => commands::request_sleep_inner(app),
        commands::PetSleepToggleAction::Wake => commands::request_wake_inner(app),
    }
}
