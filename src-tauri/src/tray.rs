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

    // Menu events are handled once by the application-level callback in lib.rs.
    // A tray-level callback is also global in Tauri, so registering both would
    // process every toggle twice and leave persisted boolean settings unchanged.
    TrayIconBuilder::with_id("yuanyuan-tray")
        .icon(icon)
        .tooltip("圆圆提醒")
        .menu(&menu)
        .show_menu_on_left_click(false)
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

pub fn refresh_pet_name(app: &AppHandle, name: &str) {
    if let Some(tray) = app.tray_by_id("yuanyuan-tray") {
        let menu = Menu::new(app);
        if let Ok(menu) = menu {
            for (id, text) in [
                ("tray-open", "打开今日任务".to_owned()),
                ("tray-show-pet", format!("显示{name}")),
                ("pet-my-pet", "我的宠物".to_owned()),
                ("tray-water", "记录一次喝水".to_owned()),
                ("tray-pause", "暂停提醒 30 分钟".to_owned()),
                ("tray-restore-click", format!("恢复{name}鼠标交互")),
                ("tray-quit", "完全退出".to_owned()),
            ] {
                if let Ok(item) = MenuItem::with_id(app, id, text, true, None::<&str>) {
                    let _ = menu.append(&item);
                }
            }
            let _ = tray.set_menu(Some(menu));
        }
    }
}

pub fn handle_menu_event(app: &AppHandle, id: &str) {
    if let Some(duration_minutes) = scene_rest_duration_for_menu_id(id) {
        let _ = crate::companion_runtime::start_scene_rest(app, duration_minutes);
        return;
    }
    match id {
        "pet-my-pet" => {
            let _ = windows::show_task_panel(app, "mypet");
        }
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
            let _ = commands::show_pet_window_inner(app);
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
        "pet-rest-stop" => {
            let _ = crate::companion_runtime::stop_scene_rest(app);
        }
        "pet-hide" => {
            let _ = commands::hide_pet_window_inner(app);
        }
        "tray-quit" | "pet-quit" => {
            commands::quit_inner(app);
        }
        _ => {}
    }
}

fn scene_rest_duration_for_menu_id(id: &str) -> Option<u32> {
    match id {
        "pet-rest-5" => Some(5),
        "pet-rest-10" => Some(10),
        "pet-rest-20" => Some(20),
        _ => None,
    }
}

pub fn handle_pet_sleep_menu_event(app: &AppHandle) -> AppResult<()> {
    match commands::pet_sleep_toggle_action(app) {
        commands::PetSleepToggleAction::Sleep => commands::request_sleep_inner(app),
        commands::PetSleepToggleAction::Wake => commands::request_wake_inner(app),
    }
}

#[cfg(test)]
mod tests {
    use super::scene_rest_duration_for_menu_id;

    const MENU_EVENT_REGISTRATION: &str = concat!(".", "on_menu_event(");

    #[test]
    fn menu_events_have_exactly_one_global_registration() {
        assert_eq!(
            include_str!("lib.rs")
                .matches(MENU_EVENT_REGISTRATION)
                .count(),
            1
        );
        assert_eq!(
            include_str!("tray.rs")
                .matches(MENU_EVENT_REGISTRATION)
                .count(),
            0
        );
    }

    #[test]
    fn scene_rest_menu_accepts_only_the_three_fixed_durations() {
        assert_eq!(scene_rest_duration_for_menu_id("pet-rest-5"), Some(5));
        assert_eq!(scene_rest_duration_for_menu_id("pet-rest-10"), Some(10));
        assert_eq!(scene_rest_duration_for_menu_id("pet-rest-20"), Some(20));
        assert_eq!(scene_rest_duration_for_menu_id("pet-rest-stop"), None);
        assert_eq!(scene_rest_duration_for_menu_id("pet-rest-60"), None);
    }
}
