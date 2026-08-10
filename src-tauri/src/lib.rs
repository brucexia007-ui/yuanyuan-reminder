#[cfg(windows)]
mod ai_sidecar_trust;
#[cfg(windows)]
mod ai_supervisor;
mod backups;
mod commands;
#[cfg(windows)]
mod companion_attention;
#[cfg(windows)]
pub mod companion_core;
#[cfg(windows)]
mod companion_runtime;
#[cfg(windows)]
// Official-target integration is intentionally compiled without a Tauri
// command until the signed-Bridge and user-confirmation release gates close.
#[allow(dead_code)]
mod connector_config_official_write;
#[cfg(windows)]
mod connector_config_preview;
#[cfg(windows)]
// Disconnect orchestration is compiled for audit and tests but has no command
// surface until the signed-Bridge and user-confirmation gates close.
#[allow(dead_code)]
mod connector_disconnect;
#[cfg(windows)]
mod connector_project_inspection;
#[cfg(windows)]
mod connector_tool_trust;
// Deliberately compiled but unreachable from the production command surface
// until the official-path and signed-Bridge release gates are complete.
#[allow(dead_code)]
#[cfg(windows)]
mod connector_config_write;
#[cfg(windows)]
mod connector_discovery;
#[cfg(windows)]
mod connector_trust_control;
mod cursor_direction;
mod error;
mod logging;
#[cfg(feature = "migration-qa")]
pub mod migration_qa;
mod models;
mod notifications;
mod repository;
#[cfg(windows)]
// The return-action gate is intentionally compiled without a Tauri command
// until a source-specific window handler has passed its release gate.
#[allow(dead_code)]
mod return_action_registry;
#[cfg(feature = "runtime-qa")]
pub mod runtime_qa;
mod scheduler;
mod state;
#[cfg(windows)]
// The panel gate is compiled and tested without a Tauri command registration
// until signed-package, real-Provider, and dynamic privacy gates are complete.
#[allow(dead_code)]
mod support_sort_panel_gate;
mod tray;
mod windows;
#[cfg(windows)]
mod windows_artifact_trust;

use std::fs;

use tauri::{Manager, RunEvent, WindowEvent};
use tauri_plugin_autostart::MacosLauncher;

use crate::{error::AppResult, repository::Repository, state::AppState};

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let context = tauri::generate_context!();
    #[cfg(feature = "runtime-qa")]
    let context = {
        let mut context = context;
        runtime_qa::configure_context(&mut context)
            .expect("failed to configure the isolated runtime QA context");
        context
    };
    let app_state = prepare_app_state(&context.config().identifier)
        .expect("failed to initialize Yuanyuan Reminder state");

    tauri::Builder::default()
        // Commands from packaged WebViews can arrive while Tauri is still creating
        // the configured windows. Manage the complete core state before that work
        // begins so command extraction never races the setup callback.
        .manage(app_state)
        .plugin(tauri_plugin_single_instance::init(|app, _, _| {
            let _ = windows::show_task_panel(app, "today");
        }))
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_autostart::init(
            MacosLauncher::LaunchAgent,
            None,
        ))
        .setup(|app| {
            #[cfg(feature = "runtime-qa")]
            {
                runtime_qa::record_stage("setup-entered")?;
                runtime_qa::create_windows(app)?;
                runtime_qa::record_stage("windows-created")?;
            }
            setup(app).map_err(|error| {
                Box::<dyn std::error::Error>::from(std::io::Error::other(error.to_string()))
            })?;
            #[cfg(feature = "runtime-qa")]
            {
                runtime_qa::record_stage("core-setup-complete")?;
                runtime_qa::schedule_controlled_exit(app.handle())?;
                runtime_qa::record_stage("exit-scheduled")?;
            }
            Ok(())
        })
        .on_menu_event(|app, event| tray::handle_menu_event(app, event.id().as_ref()))
        .invoke_handler(tauri::generate_handler![
            commands::list_today,
            commands::list_history,
            commands::create_reminder,
            commands::update_reminder,
            commands::set_reminder_enabled,
            commands::delete_reminder,
            commands::list_backups,
            commands::create_backup,
            commands::restore_backup,
            commands::complete_occurrence,
            commands::snooze_occurrence,
            commands::skip_occurrence,
            commands::record_water,
            commands::get_focus_state,
            commands::get_pet_care,
            commands::get_basic_support_state,
            commands::start_basic_support,
            commands::stop_basic_support,
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
            commands::get_ai_supervisor_status,
            commands::get_ai_supervisor_diagnostics,
            commands::preview_ai_diagnostics,
            commands::export_ai_diagnostics,
            commands::clear_ai_diagnostics,
            commands::retry_ai_after_failure,
            commands::get_companion_expression_snapshot,
            commands::get_task_watch_snapshot,
            commands::defer_task_watch_attention,
            commands::resume_task_watch_attention,
            commands::get_connector_trust_status,
            commands::discover_builtin_connectors,
            commands::inspect_connector_hook_config,
            commands::select_project_for_hook_inspection,
            commands::apply_project_hook_inspection,
            commands::cancel_project_hook_inspection,
            commands::preview_connector_trust_change,
            commands::apply_connector_trust_change,
        ])
        .build(context)
        .expect("failed to build Yuanyuan Reminder")
        .run(|app, event| {
            if let RunEvent::ExitRequested { api, .. } = event {
                // WebView2 can request an early exit while Tauri is still creating the
                // configured windows. Keep this callback non-panicking even though the
                // core state is now managed before window creation.
                let Some(state) = app.try_state::<AppState>() else {
                    return;
                };

                if !state.is_quitting() {
                    api.prevent_exit();
                    if let Some(panel) = app.get_webview_window("panel") {
                        let _ = panel.hide();
                    }
                } else {
                    #[cfg(windows)]
                    if let Some(supervisor) = app.try_state::<ai_supervisor::AiSupervisor>() {
                        supervisor.shutdown();
                    }
                }
            }
        });
}

fn prepare_app_state(identifier: &str) -> AppResult<AppState> {
    #[cfg(feature = "runtime-qa")]
    let app_data = runtime_qa::app_data_directory(identifier)?;
    #[cfg(not(feature = "runtime-qa"))]
    let app_data = dirs::data_local_dir()
        .ok_or_else(|| error::AppError::Window("local app data directory is unavailable".into()))?
        .join(identifier);
    let log_dir = app_data.join("logs");
    let guard = logging::init(&log_dir);
    fs::create_dir_all(&app_data)?;
    let database_path = app_data.join("yuanyuan-reminder.sqlite3");
    if let Err(error) = backups::create_startup_backup(&database_path, &app_data.join("backups")) {
        tracing::warn!(error = %error, "startup backup could not be created");
    }
    let repository = Repository::open(&database_path)?;
    let activity_active_seconds = repository.activity_active_seconds()?;
    Ok(AppState::new(repository, guard, activity_active_seconds))
}

fn setup(app: &mut tauri::App) -> AppResult<()> {
    let state = app.state::<AppState>();
    let repository = state.repository.lock();
    let mut settings = repository.get_settings()?;
    let focus_active = repository
        .get_focus_state()?
        .session
        .is_some_and(|session| session.phase == "focus");
    drop(repository);
    windows::apply_settings(app.handle(), &mut settings)?;
    state.repository.lock().save_settings(&settings)?;
    #[cfg(windows)]
    {
        companion_runtime::initialize(
            app.handle(),
            focus_active,
            settings.animation_mode == "off",
            companion_runtime::pause_active(&settings, chrono::Utc::now().timestamp_millis()),
        )?;
        if let Err(error) = companion_runtime::sync_external_tasks(
            app.handle(),
            chrono::Utc::now().timestamp_millis(),
        ) {
            tracing::warn!(error = %error, "external task expression state is unavailable");
        }
        let supervisor = ai_supervisor::AiSupervisor::start_if_available();
        tracing::info!(status = ?supervisor.status(), "AI sidecar supervisor initialized");
        app.manage(supervisor);
        app.manage(connector_trust_control::ConnectorTrustConfirmationState::default());
        app.manage(connector_project_inspection::ProjectInspectionCoordinator::default());
    }

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
