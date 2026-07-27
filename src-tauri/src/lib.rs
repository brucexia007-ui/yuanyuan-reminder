mod commands;
mod cursor_direction;
mod error;
mod logging;
mod models;
mod notifications;
mod repository;
mod scheduler;
mod state;
mod tray;
mod windows;

use std::fs;

use tauri::{Manager, RunEvent, WindowEvent};
use tauri_plugin_autostart::MacosLauncher;

use crate::{error::AppResult, repository::Repository, state::AppState};

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, _, _| {
            let _ = windows::show_task_panel(app, "today");
        }))
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_autostart::init(
            MacosLauncher::LaunchAgent,
            None,
        ))
        .setup(|app| {
            setup(app).map_err(|error| {
                Box::<dyn std::error::Error>::from(std::io::Error::other(error.to_string()))
            })
        })
        .on_menu_event(|app, event| tray::handle_menu_event(app, event.id().as_ref()))
        .invoke_handler(tauri::generate_handler![
            commands::list_today,
            commands::list_history,
            commands::create_reminder,
            commands::complete_occurrence,
            commands::snooze_occurrence,
            commands::skip_occurrence,
            commands::record_water,
            commands::get_focus_state,
            commands::get_pet_care,
            commands::start_pet_interaction,
            commands::start_focus,
            commands::cancel_focus,
            commands::get_settings,
            commands::update_settings,
            commands::show_task_panel,
            commands::hide_pet_window,
            commands::save_pet_position,
            commands::set_pet_size,
            commands::set_always_on_top,
            commands::set_click_through,
            commands::request_sleep,
            commands::request_wake,
            commands::pause_reminders,
            commands::show_pet_context_menu,
            commands::quit_application,
        ])
        .build(tauri::generate_context!())
        .expect("failed to build Yuanyuan Reminder")
        .run(|app, event| match event {
            RunEvent::ExitRequested { api, .. } if !app.state::<AppState>().is_quitting() => {
                api.prevent_exit();
                if let Some(panel) = app.get_webview_window("panel") {
                    let _ = panel.hide();
                }
            }
            _ => {}
        });
}

fn setup(app: &mut tauri::App) -> AppResult<()> {
    let app_data = app
        .path()
        .app_local_data_dir()
        .map_err(|error| error::AppError::Window(error.to_string()))?;
    let log_dir = app_data.join("logs");
    let guard = logging::init(&log_dir)?;
    fs::create_dir_all(&app_data)?;
    let repository = Repository::open(&app_data.join("yuanyuan-reminder.sqlite3"))?;
    let mut settings = repository.get_settings()?;
    let activity_active_seconds = repository.activity_active_seconds()?;
    windows::apply_settings(app.handle(), &mut settings)?;
    repository.save_settings(&settings)?;
    app.manage(AppState::new(
        repository,
        guard,
        activity_active_seconds,
    ));

    tray::create(app)?;
    scheduler::spawn(app.handle().clone());
    cursor_direction::spawn(app.handle().clone());

    if let Some(panel) = app.get_webview_window("panel") {
        let panel_for_event = panel.clone();
        panel.on_window_event(move |event| {
            if let WindowEvent::CloseRequested { api, .. } = event {
                api.prevent_close();
                let _ = panel_for_event.hide();
            }
        });
    }
    tracing::info!("Yuanyuan Reminder started without Codex runtime dependencies");
    Ok(())
}
