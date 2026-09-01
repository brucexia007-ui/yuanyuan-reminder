use std::{
    ffi::OsStr,
    fs,
    path::{Path, PathBuf},
    time::Duration,
};

#[cfg(feature = "learning")]
use std::{
    fs::OpenOptions,
    io::Write,
    sync::{
        atomic::{AtomicBool, AtomicU64, Ordering},
        Arc,
    },
    thread,
};

use chrono::{Duration as ChronoDuration, Local, Utc};
use serde::Serialize;
use tauri::{AppHandle, Manager, Runtime};

#[cfg(feature = "learning")]
use sha2::{Digest, Sha256};

use crate::{
    error::{AppError, AppResult},
    models::CreateReminderInput,
    repository::Repository,
};

const ROOT_ENV: &str = "YUANYUAN_RUNTIME_QA_ROOT";
const EXIT_AFTER_ENV: &str = "YUANYUAN_RUNTIME_QA_EXIT_AFTER_SECONDS";
const PROFILE_ENV: &str = "YUANYUAN_RUNTIME_QA_PROFILE";
const WEBVIEW_MODE_ENV: &str = "YUANYUAN_RUNTIME_QA_WEBVIEW_MODE";
const PANEL_PLACEMENT_ENV: &str = "YUANYUAN_RUNTIME_QA_PANEL_PLACEMENT";
const ROOT_PREFIX: &str = "yuanyuan-runtime-qa-";
const MARKER_NAME: &str = ".yuanyuan-runtime-qa-v1";
const MARKER_CONTENT: &[u8] = b"YUANYUAN_RUNTIME_QA_V1\n";
const QA_IDENTIFIER: &str = "com.yuanyuan.reminder.runtime-qa";
const SHOW_PET_CONTEXT_MENU_TRIGGER: &str = "show-pet-context-menu";
const INVOKE_PET_SLEEP_MENU_TRIGGER: &str = "invoke-pet-sleep-menu";
const SET_PANEL_360X560_TRIGGER: &str = "set-panel-size-360x560";
const SET_PANEL_390X620_TRIGGER: &str = "set-panel-size-390x620";
const SET_PANEL_480X760_TRIGGER: &str = "set-panel-size-480x760";
#[cfg(feature = "learning")]
const LEARNING_COMMIT_CRASH_ARM_TRIGGER: &str = "arm-learning-answer-commit-crash";
#[cfg(feature = "learning")]
const LEARNING_COMMIT_CRASH_RELEASE_TRIGGER: &str = "release-learning-answer-commit-crash";
#[cfg(feature = "learning")]
const LEARNING_COMMIT_CRASH_ENTERED_STAGE: &str = "learning-answer-commit-hook-entered";
#[cfg(feature = "learning")]
const LEARNING_COMMIT_CRASH_ERROR_STAGE: &str = "learning-answer-commit-hook-error";
#[cfg(feature = "learning")]
const LEARNING_COMMIT_CRASH_WAIT_STEPS: usize = 2_400;
#[cfg(feature = "learning")]
const RUN_LEARNING_SCALE_TRIGGER: &str = "run-learning-scale-acceptance";
#[cfg(feature = "learning")]
const LEARNING_SCALE_STARTED_STAGE: &str = "learning-scale-acceptance-started";
#[cfg(feature = "learning")]
const LEARNING_SCALE_REPORT_NAME: &str = "learning-scale-acceptance-report.json";
#[cfg(feature = "learning")]
const LEARNING_SCALE_ERROR_NAME: &str = "learning-scale-acceptance-error.txt";
#[cfg(feature = "learning")]
const LEARNING_SCALE_CARD_COUNT: u32 = 20_000;
#[cfg(feature = "learning")]
const LEARNING_SCALE_ANSWER_COUNT: u32 = 1_000;
#[cfg(feature = "learning")]
const LEARNING_SCALE_MAX_DATABASE_BYTES: u64 = 128 * 1024 * 1024;
#[cfg(feature = "learning")]
const LEARNING_SCALE_MAX_ANSWER_GROWTH_BYTES: u64 = 32 * 1024 * 1024;
const PANEL_SIZE_TRIGGERS: [&str; 3] = [
    SET_PANEL_360X560_TRIGGER,
    SET_PANEL_390X620_TRIGGER,
    SET_PANEL_480X760_TRIGGER,
];

pub fn create_root(path: &Path) -> AppResult<PathBuf> {
    validate_root_shape(path)?;
    if path.exists() {
        return validate_root(path);
    }
    fs::create_dir(path)?;
    #[cfg(windows)]
    yuanyuan_bridge::apply_current_user_only_dacl(path)
        .map_err(|_| AppError::Validation("runtime QA root could not be secured".into()))?;

    let marker = path.join(MARKER_NAME);
    fs::write(&marker, MARKER_CONTENT)?;
    #[cfg(windows)]
    yuanyuan_bridge::apply_current_user_only_dacl(&marker)
        .map_err(|_| AppError::Validation("runtime QA marker could not be secured".into()))?;
    validate_root(path)
}

pub fn root_from_env() -> AppResult<PathBuf> {
    let value = std::env::var_os(ROOT_ENV)
        .ok_or_else(|| AppError::Validation("runtime QA root is required".into()))?;
    validate_root(Path::new(&value))
}

pub fn app_data_directory(identifier: &str) -> AppResult<PathBuf> {
    if identifier != QA_IDENTIFIER {
        return Err(AppError::Validation(
            "runtime QA identifier is invalid".into(),
        ));
    }
    Ok(root_from_env()?.join("app-data").join(identifier))
}

pub fn task_database() -> AppResult<PathBuf> {
    Ok(root_from_env()?.join("ai-data").join("yuanyuan-ai.sqlite3"))
}

pub fn configure_context<R: Runtime>(context: &mut tauri::Context<R>) -> AppResult<()> {
    let _ = root_from_env()?;
    let profile = parse_profile(std::env::var_os(PROFILE_ENV).as_deref())?;
    context.config_mut().identifier = QA_IDENTIFIER.into();
    for window in &mut context.config_mut().app.windows {
        window.create = false;
        if profile == RuntimeQaProfile::Diagnostics && window.label == "pet" {
            window.visible = false;
        }
        if window.label == "panel" {
            match profile {
                RuntimeQaProfile::TaskWatch => {
                    window.visible = true;
                    window.url =
                        tauri::utils::config::WebviewUrl::App("index.html?tab=taskwatch".into());
                }
                RuntimeQaProfile::TaskFailureMotion => window.visible = false,
                RuntimeQaProfile::BaselineAiOff => window.visible = false,
                RuntimeQaProfile::ReminderLatency => window.visible = false,
                RuntimeQaProfile::Diagnostics => {
                    window.visible = true;
                    window.url =
                        tauri::utils::config::WebviewUrl::App("index.html?tab=settings".into());
                }
                #[cfg(feature = "learning")]
                RuntimeQaProfile::LearningPerformance => {
                    window.visible = true;
                    window.url =
                        tauri::utils::config::WebviewUrl::App("index.html?tab=learning".into());
                }
            }
        }
    }
    Ok(())
}

pub fn create_windows(app: &mut tauri::App) -> Result<(), Box<dyn std::error::Error>> {
    let root = root_from_env()?;
    let browser_arguments =
        runtime_qa_webview_arguments(std::env::var_os(WEBVIEW_MODE_ENV).as_deref())?;
    let place_panel_top_left =
        runtime_qa_panel_top_left(std::env::var_os(PANEL_PLACEMENT_ENV).as_deref())?;
    for mut config in app.config().app.windows.clone() {
        if place_panel_top_left && config.label == "panel" {
            config.center = false;
            config.x = Some(64.0);
            config.y = Some(64.0);
        }
        let builder = tauri::WebviewWindowBuilder::from_config(app.handle(), &config)?
            .data_directory(root.join("webview"));
        #[cfg(windows)]
        let builder = if let Some(arguments) = browser_arguments {
            builder.additional_browser_args(arguments)
        } else {
            builder
        };
        builder.build()?;
    }
    Ok(())
}

fn runtime_qa_panel_top_left(value: Option<&OsStr>) -> AppResult<bool> {
    match value.and_then(OsStr::to_str) {
        None | Some("default") => Ok(false),
        Some("work-area-top-left") => Ok(true),
        Some(_) => Err(AppError::Validation(
            "runtime QA panel placement is invalid".into(),
        )),
    }
}

fn runtime_qa_webview_arguments(value: Option<&OsStr>) -> AppResult<Option<&'static str>> {
    match value.and_then(OsStr::to_str) {
        None | Some("standard") => Ok(None),
        Some("reduced-motion") => Ok(Some("--force-prefers-reduced-motion")),
        Some("forced-colors") => Ok(Some(
            "--force-high-contrast --enable-blink-features=ForcedColors",
        )),
        Some(_) => Err(AppError::Validation(
            "runtime QA WebView mode is invalid".into(),
        )),
    }
}

pub fn record_stage(stage: &'static str) -> AppResult<()> {
    if !matches!(
        stage,
        "setup-entered" | "windows-created" | "core-setup-complete" | "exit-scheduled"
    ) {
        return Err(AppError::Validation("runtime QA stage is invalid".into()));
    }
    let status_directory = root_from_env()?.join("status");
    fs::create_dir_all(&status_directory)?;
    fs::write(
        status_directory.join(stage),
        Utc::now().to_rfc3339().as_bytes(),
    )?;
    Ok(())
}

fn consume_empty_control_trigger(root: &Path, name: &str) -> AppResult<bool> {
    let allowed = matches!(
        name,
        SHOW_PET_CONTEXT_MENU_TRIGGER
            | INVOKE_PET_SLEEP_MENU_TRIGGER
            | SET_PANEL_360X560_TRIGGER
            | SET_PANEL_390X620_TRIGGER
            | SET_PANEL_480X760_TRIGGER
    );
    #[cfg(feature = "learning")]
    let allowed = allowed || name == RUN_LEARNING_SCALE_TRIGGER;
    if !allowed {
        return Err(AppError::Validation(
            "runtime QA control trigger is invalid".into(),
        ));
    }
    let path = root.join("control").join(name);
    let metadata = match fs::symlink_metadata(&path) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(false),
        Err(error) => return Err(error.into()),
    };
    if !metadata.file_type().is_file() || metadata.len() != 0 {
        return Err(AppError::Validation(
            "runtime QA control trigger must be an empty regular file".into(),
        ));
    }
    fs::remove_file(path)?;
    Ok(true)
}

#[cfg(feature = "learning")]
fn consume_commit_crash_control(path: &Path) -> AppResult<bool> {
    let metadata = match fs::symlink_metadata(path) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(false),
        Err(error) => return Err(error.into()),
    };
    if !metadata.file_type().is_file()
        || metadata_is_reparse_point(&metadata)
        || metadata.len() != 0
    {
        return Err(AppError::Validation(
            "runtime QA commit crash control must be an empty regular file".into(),
        ));
    }
    fs::remove_file(path)?;
    Ok(true)
}

#[cfg(feature = "learning")]
fn write_commit_crash_stage(path: &Path, content: &[u8]) -> AppResult<()> {
    let mut file = OpenOptions::new().write(true).create_new(true).open(path)?;
    file.write_all(content)?;
    file.sync_all()?;
    Ok(())
}

#[cfg(feature = "learning")]
#[derive(Clone)]
pub(crate) struct LearningCommitCrashGate {
    answer_commit_pending: Arc<AtomicBool>,
}

#[cfg(feature = "learning")]
impl LearningCommitCrashGate {
    pub(crate) fn mark_answer_commit_pending(&self) {
        self.answer_commit_pending.store(true, Ordering::Release);
    }

    pub(crate) fn clear_answer_commit_pending(&self) {
        self.answer_commit_pending.store(false, Ordering::Release);
    }
}

#[cfg(feature = "learning")]
fn install_learning_commit_crash_gate_for_root(
    connection: &rusqlite::Connection,
    root: &Path,
) -> AppResult<LearningCommitCrashGate> {
    let control_directory = root.join("control");
    let status_directory = root.join("status");
    fs::create_dir_all(&control_directory)?;
    fs::create_dir_all(&status_directory)?;
    let arm = control_directory.join(LEARNING_COMMIT_CRASH_ARM_TRIGGER);
    let release = control_directory.join(LEARNING_COMMIT_CRASH_RELEASE_TRIGGER);
    let entered = status_directory.join(LEARNING_COMMIT_CRASH_ENTERED_STAGE);
    let error = status_directory.join(LEARNING_COMMIT_CRASH_ERROR_STAGE);
    let answer_commit_pending = Arc::new(AtomicBool::new(false));
    let hook_pending = answer_commit_pending.clone();
    connection.commit_hook(Some(move || {
        if !hook_pending.swap(false, Ordering::AcqRel) {
            return false;
        }
        match consume_commit_crash_control(&arm) {
            Ok(false) => return false,
            Ok(true) => {}
            Err(_) => {
                let _ = write_commit_crash_stage(&error, b"invalid arm control\n");
                return true;
            }
        }
        if write_commit_crash_stage(&entered, b"entered\n").is_err() {
            let _ = write_commit_crash_stage(&error, b"entered stage unavailable\n");
            return true;
        }
        for _ in 0..LEARNING_COMMIT_CRASH_WAIT_STEPS {
            match consume_commit_crash_control(&release) {
                Ok(true) => return true,
                Ok(false) => thread::sleep(Duration::from_millis(50)),
                Err(_) => return true,
            }
        }
        true
    }));
    Ok(LearningCommitCrashGate {
        answer_commit_pending,
    })
}

#[cfg(feature = "learning")]
pub(crate) fn install_learning_commit_crash_gate(
    connection: &rusqlite::Connection,
) -> AppResult<Option<LearningCommitCrashGate>> {
    let Some(root) = std::env::var_os(ROOT_ENV) else {
        return Ok(None);
    };
    let root = validate_root(Path::new(&root))?;
    install_learning_commit_crash_gate_for_root(connection, &root).map(Some)
}

fn panel_size_for_trigger(name: &str) -> Option<(f64, f64)> {
    match name {
        SET_PANEL_360X560_TRIGGER => Some((360.0, 560.0)),
        SET_PANEL_390X620_TRIGGER => Some((390.0, 620.0)),
        SET_PANEL_480X760_TRIGGER => Some((480.0, 760.0)),
        _ => None,
    }
}

pub fn schedule_control_channel(app: &AppHandle) -> AppResult<()> {
    let root = root_from_env()?;
    fs::create_dir_all(root.join("control"))?;
    fs::create_dir_all(root.join("status"))?;
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        let mut request_number = 0_u32;
        let mut sleep_request_number = 0_u32;
        #[cfg(feature = "learning")]
        let mut learning_scale_started = false;
        loop {
            tokio::time::sleep(Duration::from_millis(50)).await;
            match consume_empty_control_trigger(&root, SHOW_PET_CONTEXT_MENU_TRIGGER) {
                Ok(false) => {}
                Ok(true) => {
                    request_number = request_number.saturating_add(1);
                    let consumed = root
                        .join("status")
                        .join(format!("context-menu-{request_number}-consumed"));
                    if let Err(error) = fs::write(&consumed, b"ok\n") {
                        tracing::warn!(error = %error, "runtime QA context menu status could not be written");
                    }
                    let app_for_menu = app.clone();
                    let root_for_menu = root.clone();
                    if let Err(error) = app.run_on_main_thread(move || {
                        let entered = root_for_menu
                            .join("status")
                            .join(format!("context-menu-{request_number}-main-thread-entered"));
                        let _ = fs::write(entered, b"ok\n");
                        match crate::windows::show_pet_context_menu(&app_for_menu) {
                            Ok(()) => {
                                let returned = root_for_menu.join("status").join(format!(
                                    "context-menu-{request_number}-popup-returned"
                                ));
                                let _ = fs::write(returned, b"ok\n");
                            }
                            Err(error) => {
                                let failed = root_for_menu
                                    .join("status")
                                    .join(format!("context-menu-{request_number}-popup-error"));
                                let _ = fs::write(failed, error.to_string());
                                tracing::warn!(error = %error, "runtime QA pet context menu could not be shown");
                            }
                        }
                    }) {
                        tracing::warn!(error = %error, "runtime QA context menu dispatch failed");
                    }
                }
                Err(error) => {
                    tracing::warn!(error = %error, "runtime QA control trigger was rejected");
                    tokio::time::sleep(Duration::from_millis(250)).await;
                }
            }
            match consume_empty_control_trigger(&root, INVOKE_PET_SLEEP_MENU_TRIGGER) {
                Ok(false) => {}
                Ok(true) => {
                    sleep_request_number = sleep_request_number.saturating_add(1);
                    let consumed = root
                        .join("status")
                        .join(format!("pet-sleep-menu-{sleep_request_number}-consumed"));
                    if let Err(error) = fs::write(&consumed, b"ok\n") {
                        tracing::warn!(error = %error, "runtime QA pet sleep status could not be written");
                    }
                    let app_for_action = app.clone();
                    let root_for_action = root.clone();
                    if let Err(error) = app.run_on_main_thread(move || {
                        let entered = root_for_action.join("status").join(format!(
                            "pet-sleep-menu-{sleep_request_number}-main-thread-entered"
                        ));
                        let _ = fs::write(entered, b"ok\n");
                        let selected_action = match crate::commands::pet_sleep_toggle_action(
                            &app_for_action,
                        ) {
                            crate::commands::PetSleepToggleAction::Sleep => "sleep\n",
                            crate::commands::PetSleepToggleAction::Wake => "wake\n",
                        };
                        let action_status = root_for_action.join("status").join(format!(
                            "pet-sleep-menu-{sleep_request_number}-selected-action"
                        ));
                        let _ = fs::write(action_status, selected_action.as_bytes());
                        match crate::tray::handle_pet_sleep_menu_event(&app_for_action) {
                            Ok(()) => {
                                let snapshot_status = root_for_action.join("status").join(format!(
                                    "pet-sleep-menu-{sleep_request_number}-snapshot"
                                ));
                                if let Ok(snapshot) = serde_json::to_vec(
                                    &crate::presentation_runtime::snapshot(&app_for_action),
                                ) {
                                    let _ = fs::write(snapshot_status, snapshot);
                                }
                                let returned = root_for_action.join("status").join(format!(
                                    "pet-sleep-menu-{sleep_request_number}-handler-returned"
                                ));
                                let _ = fs::write(returned, b"ok\n");
                            }
                            Err(error) => {
                                let failed = root_for_action.join("status").join(format!(
                                    "pet-sleep-menu-{sleep_request_number}-handler-error"
                                ));
                                let _ = fs::write(failed, error.to_string());
                                tracing::warn!(error = %error, "runtime QA pet sleep handler failed");
                            }
                        }
                    }) {
                        tracing::warn!(error = %error, "runtime QA pet sleep dispatch failed");
                    }
                }
                Err(error) => {
                    tracing::warn!(error = %error, "runtime QA pet sleep trigger was rejected");
                    tokio::time::sleep(Duration::from_millis(250)).await;
                }
            }
            for trigger in PANEL_SIZE_TRIGGERS {
                match consume_empty_control_trigger(&root, trigger) {
                    Ok(false) => {}
                    Ok(true) => {
                        let (width, height) = panel_size_for_trigger(trigger)
                            .expect("allowlisted panel size trigger must have dimensions");
                        let app_for_size = app.clone();
                        let root_for_size = root.clone();
                        let root_for_dispatch_failure = root.clone();
                        if let Err(error) = app.run_on_main_thread(move || {
                            let result = app_for_size
                                .get_webview_window("panel")
                                .ok_or_else(|| "panel window is unavailable".to_owned())
                                .and_then(|panel| {
                                    panel
                                        .set_size(tauri::LogicalSize::new(width, height))
                                        .map_err(|error| error.to_string())
                                });
                            let suffix = if result.is_ok() { "applied" } else { "failed" };
                            let status = root_for_size
                                .join("status")
                                .join(format!("{trigger}-{suffix}"));
                            let _ = fs::write(status, b"ok\n");
                        }) {
                            let status = root_for_dispatch_failure
                                .join("status")
                                .join(format!("{trigger}-failed"));
                            let _ = fs::write(status, b"dispatch failed\n");
                            tracing::warn!(error = %error, "runtime QA panel resize dispatch failed");
                        }
                    }
                    Err(error) => {
                        tracing::warn!(error = %error, "runtime QA panel resize trigger was rejected");
                        tokio::time::sleep(Duration::from_millis(250)).await;
                    }
                }
            }
            #[cfg(feature = "learning")]
            match consume_empty_control_trigger(&root, RUN_LEARNING_SCALE_TRIGGER) {
                Ok(false) => {}
                Ok(true) if learning_scale_started => {
                    tracing::warn!("runtime QA learning scale acceptance was already started");
                }
                Ok(true) => {
                    learning_scale_started = true;
                    let status_directory = root.join("status");
                    if let Err(error) = write_runtime_qa_status_file(
                        &status_directory.join(LEARNING_SCALE_STARTED_STAGE),
                        b"started\n",
                    ) {
                        tracing::warn!(error = %error, "runtime QA learning scale start status failed");
                    }
                    let app_for_scale = app.clone();
                    let result = tauri::async_runtime::spawn_blocking(move || {
                        run_learning_scale_acceptance(&app_for_scale)
                    })
                    .await;
                    let (exit_code, write_result) = match result {
                        Ok(Ok(report)) => (
                            0,
                            serde_json::to_vec_pretty(&report)
                                .map_err(AppError::from)
                                .and_then(|bytes| {
                                    write_runtime_qa_status_file(
                                        &status_directory.join(LEARNING_SCALE_REPORT_NAME),
                                        &bytes,
                                    )
                                }),
                        ),
                        Ok(Err(error)) => (
                            1,
                            write_runtime_qa_status_file(
                                &status_directory.join(LEARNING_SCALE_ERROR_NAME),
                                error.to_string().as_bytes(),
                            ),
                        ),
                        Err(error) => (
                            1,
                            write_runtime_qa_status_file(
                                &status_directory.join(LEARNING_SCALE_ERROR_NAME),
                                format!("learning scale worker stopped unexpectedly: {error}")
                                    .as_bytes(),
                            ),
                        ),
                    };
                    if let Err(error) = write_result {
                        tracing::warn!(error = %error, "runtime QA learning scale result could not be written");
                    }
                    if exit_code == 0 {
                        crate::commands::quit_inner(&app);
                    } else {
                        app.state::<crate::state::AppState>().set_quitting();
                        app.exit(exit_code);
                    }
                }
                Err(error) => {
                    tracing::warn!(error = %error, "runtime QA learning scale trigger was rejected");
                    tokio::time::sleep(Duration::from_millis(250)).await;
                }
            }
            #[cfg(feature = "learning")]
            if learning_scale_started {
                break;
            }
        }
    });
    Ok(())
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum RuntimeQaProfile {
    TaskWatch,
    TaskFailureMotion,
    BaselineAiOff,
    ReminderLatency,
    Diagnostics,
    #[cfg(feature = "learning")]
    LearningPerformance,
}

fn parse_profile(value: Option<&OsStr>) -> AppResult<RuntimeQaProfile> {
    match value.and_then(OsStr::to_str) {
        None | Some("task-watch") => Ok(RuntimeQaProfile::TaskWatch),
        Some("task-failure-motion") => Ok(RuntimeQaProfile::TaskFailureMotion),
        Some("baseline-ai-off") => Ok(RuntimeQaProfile::BaselineAiOff),
        Some("reminder-latency") => Ok(RuntimeQaProfile::ReminderLatency),
        Some("diagnostics") => Ok(RuntimeQaProfile::Diagnostics),
        #[cfg(feature = "learning")]
        Some("learning-performance") => Ok(RuntimeQaProfile::LearningPerformance),
        Some(_) => Err(AppError::Validation("runtime QA profile is invalid".into())),
    }
}

pub fn diagnostics_profile_active() -> bool {
    matches!(
        parse_profile(std::env::var_os(PROFILE_ENV).as_deref()),
        Ok(RuntimeQaProfile::Diagnostics)
    )
}

pub fn isolates_automatic_sleep() -> bool {
    parse_profile(std::env::var_os(PROFILE_ENV).as_deref())
        .is_ok_and(profile_isolates_time_of_day_automation)
}

pub fn isolates_activity_tracking() -> bool {
    parse_profile(std::env::var_os(PROFILE_ENV).as_deref())
        .is_ok_and(profile_isolates_time_of_day_automation)
}

fn profile_isolates_time_of_day_automation(profile: RuntimeQaProfile) -> bool {
    match profile {
        RuntimeQaProfile::BaselineAiOff => true,
        #[cfg(feature = "learning")]
        RuntimeQaProfile::LearningPerformance => true,
        _ => false,
    }
}

pub fn seed_animation_mode(animation_mode: &str) -> AppResult<()> {
    if !matches!(animation_mode, "always" | "system" | "off") {
        return Err(AppError::Validation(
            "runtime QA animation mode is invalid".into(),
        ));
    }
    let database = app_data_directory(QA_IDENTIFIER)?.join(crate::brand::main_database_file());
    Repository::open(&database)?
        .update_settings(serde_json::json!({ "animationMode": animation_mode }))?;
    Ok(())
}

#[cfg(feature = "learning")]
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LearningPerformancePlan {
    pub card_count: u32,
    pub pack_id: String,
    pub content_sha256: String,
    pub database_sha256: String,
    pub database_bytes: u64,
    pub reminder_pause_until_utc: String,
}

#[cfg(feature = "learning")]
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LearningScaleAcceptanceReport {
    pub schema_version: u32,
    pub status: &'static str,
    pub product_version: &'static str,
    pub runtime_identifier: &'static str,
    pub tauri_process_id: u32,
    pub synthetic_data_only: bool,
    pub tauri_import_passed: bool,
    pub cancellation_passed: bool,
    pub imported_cards: u32,
    pub pagination_passed: bool,
    pub answers_applied: u32,
    pub database_growth_within_limit: bool,
    pub backup_restore_passed: bool,
    pub source_csv_sha256: String,
    pub cancellation_check_count: u64,
    pub database_bytes_after_import: u64,
    pub database_bytes_after_answers: u64,
    pub answer_growth_bytes: u64,
    pub maximum_database_bytes: u64,
    pub maximum_answer_growth_bytes: u64,
    pub restored_card_count: u32,
    pub restored_review_count: u32,
    pub integrity_check: String,
    pub foreign_key_violation_count: u32,
    pub elapsed_milliseconds: u64,
    pub privacy: &'static str,
}

#[cfg(feature = "learning")]
fn write_runtime_qa_status_file(path: &Path, content: &[u8]) -> AppResult<()> {
    let status_directory = root_from_env()?.join("status");
    if path.parent() != Some(status_directory.as_path())
        || !path
            .file_name()
            .and_then(OsStr::to_str)
            .is_some_and(|name| {
                matches!(
                    name,
                    LEARNING_SCALE_STARTED_STAGE
                        | LEARNING_SCALE_REPORT_NAME
                        | LEARNING_SCALE_ERROR_NAME
                )
            })
    {
        return Err(AppError::Validation(
            "runtime QA learning status path is invalid".into(),
        ));
    }
    fs::create_dir_all(&status_directory)?;
    let mut file = OpenOptions::new().write(true).create_new(true).open(path)?;
    file.write_all(content)?;
    file.sync_all()?;
    Ok(())
}

#[cfg(feature = "learning")]
fn learning_database_storage_bytes(path: &Path) -> AppResult<u64> {
    let mut total = 0_u64;
    for suffix in ["", "-wal", "-shm"] {
        let candidate = if suffix.is_empty() {
            path.to_path_buf()
        } else {
            let mut value = path.as_os_str().to_os_string();
            value.push(suffix);
            PathBuf::from(value)
        };
        match fs::symlink_metadata(&candidate) {
            Ok(metadata) => {
                if !metadata.file_type().is_file() || metadata_is_reparse_point(&metadata) {
                    return Err(AppError::Validation(
                        "runtime QA learning database storage is invalid".into(),
                    ));
                }
                total = total.checked_add(metadata.len()).ok_or_else(|| {
                    AppError::Validation(
                        "runtime QA learning database storage size overflowed".into(),
                    )
                })?;
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(error) => return Err(error.into()),
        }
    }
    Ok(total)
}

#[cfg(feature = "learning")]
fn apply_correct_learning_answers(
    state: &crate::state::AppState,
    target: u32,
    now_unix_ms: &mut i64,
) -> AppResult<u32> {
    let mut applied = 0_u32;
    while applied < target {
        let remaining = target.saturating_sub(applied);
        let requested_count = if remaining >= 10 {
            10
        } else if remaining >= 5 {
            5
        } else if remaining >= 3 {
            3
        } else {
            1
        };
        *now_unix_ms = now_unix_ms.saturating_add(1);
        let created = state.learning.lock().start_manual_session(
            requested_count,
            crate::learning::LearningSessionKind::Daily,
            None,
            *now_unix_ms,
        )?;
        *now_unix_ms = now_unix_ms.saturating_add(1);
        let active = state.learning.lock().present_session(
            &created.session_id,
            created.state_revision,
            *now_unix_ms,
        )?;
        if active.status != "active" {
            return Err(AppError::Validation(
                "runtime QA learning session did not become active".into(),
            ));
        }
        loop {
            let card = state.learning.lock().current_card(&active.session_id)?;
            let question = state.learning.lock().current_question(&active.session_id)?;
            let selected_option_id = question
                .options
                .iter()
                .find(|option| {
                    card.meanings_zh
                        .iter()
                        .any(|meaning| meaning == &option.meaning_zh)
                })
                .map(|option| option.option_id.clone())
                .ok_or_else(|| {
                    AppError::Validation(
                        "runtime QA learning question has no deterministic correct option".into(),
                    )
                })?;
            *now_unix_ms = now_unix_ms.saturating_add(1);
            let answer = state.learning.lock().answer_question(
                &active.session_id,
                &question.question_id,
                &selected_option_id,
                &uuid::Uuid::new_v4().to_string(),
                Some(250),
                *now_unix_ms,
            )?;
            if !answer.correct || answer.replayed || answer.is_remediation {
                return Err(AppError::Validation(
                    "runtime QA learning answer was not applied as a fresh correct answer".into(),
                ));
            }
            applied = applied.saturating_add(1);
            if answer.session.status == "completed" {
                break;
            }
            if answer.session.status != "active" || applied >= target {
                return Err(AppError::Validation(
                    "runtime QA learning answer session state is inconsistent".into(),
                ));
            }
        }
    }
    Ok(applied)
}

#[cfg(feature = "learning")]
fn learning_database_health(path: &Path) -> AppResult<(String, u32)> {
    let connection = rusqlite::Connection::open(path)?;
    connection.busy_timeout(Duration::from_secs(10))?;
    let integrity_check = connection.query_row("PRAGMA quick_check", [], |row| row.get(0))?;
    let foreign_key_violation_count =
        connection.query_row("SELECT COUNT(*) FROM pragma_foreign_key_check", [], |row| {
            row.get(0)
        })?;
    Ok((integrity_check, foreign_key_violation_count))
}

#[cfg(feature = "learning")]
fn run_learning_scale_acceptance(app: &AppHandle) -> AppResult<LearningScaleAcceptanceReport> {
    let started = std::time::Instant::now();
    let root = root_from_env()?;
    let database = app_data_directory(QA_IDENTIFIER)?
        .join("learning-data")
        .join(crate::brand::learning_database_file());
    let state = app.state::<crate::state::AppState>();
    let initial = state.learning.lock().data_summary()?;
    if initial.card_count != 0 || initial.review_count != 0 {
        return Err(AppError::Validation(
            "runtime QA learning scale root is not empty".into(),
        ));
    }

    let csv = build_synthetic_learning_csv(LEARNING_SCALE_CARD_COUNT);
    let source_csv_sha256 = sha256_hex(csv.as_bytes());
    let preview_operation = state.learning_import_cancellation.begin()?;
    let preview_result = state.learning.lock().preview_csv_import_with_cancellation(
        csv.as_bytes(),
        Utc::now().timestamp_millis(),
        &|| {
            state
                .learning_import_cancellation
                .is_cancelled(preview_operation)
        },
    );
    state.learning_import_cancellation.finish(preview_operation);
    let preview = preview_result?;
    if preview.card_count != LEARNING_SCALE_CARD_COUNT {
        return Err(AppError::Validation(
            "runtime QA learning cancellation preview count changed".into(),
        ));
    }

    let cancellation_checks = AtomicU64::new(0);
    let cancellation_requested = AtomicBool::new(false);
    let cancel_operation = state.learning_import_cancellation.begin()?;
    let cancel_result = state.learning.lock().confirm_import_with_cancellation(
        preview.preview_token.as_deref().ok_or_else(|| {
            AppError::Validation("runtime QA learning cancellation token is missing".into())
        })?,
        Utc::now().timestamp_millis(),
        &|| {
            let check = cancellation_checks.fetch_add(1, Ordering::SeqCst) + 1;
            if check == 1_024 {
                cancellation_requested.store(
                    state.learning_import_cancellation.cancel_active(),
                    Ordering::SeqCst,
                );
            }
            state
                .learning_import_cancellation
                .is_cancelled(cancel_operation)
        },
    );
    state.learning_import_cancellation.finish(cancel_operation);
    let cancellation_passed = cancellation_requested.load(Ordering::SeqCst)
        && cancel_result
            .as_ref()
            .is_err_and(|error| error.to_string().contains("learning import was cancelled"));
    let after_cancel = state.learning.lock().data_summary()?;
    if !cancellation_passed
        || after_cancel.card_count != 0
        || after_cancel.review_count != 0
        || !after_cancel.sources.is_empty()
        || !after_cancel.packs.is_empty()
    {
        return Err(AppError::Validation(
            "runtime QA learning import cancellation did not roll back cleanly".into(),
        ));
    }

    let import_started = std::time::Instant::now();
    let full_preview_operation = state.learning_import_cancellation.begin()?;
    let full_preview_result = state.learning.lock().preview_csv_import_with_cancellation(
        csv.as_bytes(),
        Utc::now().timestamp_millis(),
        &|| {
            state
                .learning_import_cancellation
                .is_cancelled(full_preview_operation)
        },
    );
    state
        .learning_import_cancellation
        .finish(full_preview_operation);
    let full_preview = full_preview_result?;
    let full_commit_operation = state.learning_import_cancellation.begin()?;
    let full_commit_result = state.learning.lock().confirm_import_with_cancellation(
        full_preview.preview_token.as_deref().ok_or_else(|| {
            AppError::Validation("runtime QA learning import token is missing".into())
        })?,
        Utc::now().timestamp_millis(),
        &|| {
            state
                .learning_import_cancellation
                .is_cancelled(full_commit_operation)
        },
    );
    state
        .learning_import_cancellation
        .finish(full_commit_operation);
    let imported = full_commit_result?;
    let imported_summary = state.learning.lock().data_summary()?;
    let tauri_import_passed = imported.imported_count == LEARNING_SCALE_CARD_COUNT
        && imported_summary.card_count == LEARNING_SCALE_CARD_COUNT
        && import_started.elapsed() < Duration::from_secs(120);
    if !tauri_import_passed {
        return Err(AppError::Validation(
            "runtime QA learning 20000-card import did not pass".into(),
        ));
    }
    let database_bytes_after_import = learning_database_storage_bytes(&database)?;

    let pagination_passed = {
        let mut learning = state.learning.lock();
        let first = learning.list_records(crate::learning::LearningRecordFilter::All, "", 0, 50)?;
        let middle =
            learning.list_records(crate::learning::LearningRecordFilter::All, "", 200, 50)?;
        let last =
            learning.list_records(crate::learning::LearningRecordFilter::All, "", 399, 50)?;
        let beyond =
            learning.list_records(crate::learning::LearningRecordFilter::All, "", 400, 50)?;
        [first.total, middle.total, last.total, beyond.total]
            .into_iter()
            .all(|total| total == LEARNING_SCALE_CARD_COUNT)
            && first.items.len() == 50
            && middle.items.len() == 50
            && last.items.len() == 50
            && beyond.items.is_empty()
            && first.items[0].card_id != middle.items[0].card_id
            && middle.items[0].card_id != last.items[0].card_id
    };
    if !pagination_passed {
        return Err(AppError::Validation(
            "runtime QA learning pagination did not pass".into(),
        ));
    }

    let mut now_unix_ms = Utc::now().timestamp_millis();
    let answers_applied =
        apply_correct_learning_answers(&state, LEARNING_SCALE_ANSWER_COUNT, &mut now_unix_ms)?;
    let answered_summary = state.learning.lock().data_summary()?;
    if answers_applied != LEARNING_SCALE_ANSWER_COUNT
        || answered_summary.review_count != LEARNING_SCALE_ANSWER_COUNT
    {
        return Err(AppError::Validation(
            "runtime QA learning answer count did not pass".into(),
        ));
    }
    let database_bytes_after_answers = learning_database_storage_bytes(&database)?;
    let answer_growth_bytes =
        database_bytes_after_answers.saturating_sub(database_bytes_after_import);
    let database_growth_within_limit = database_bytes_after_answers
        <= LEARNING_SCALE_MAX_DATABASE_BYTES
        && answer_growth_bytes <= LEARNING_SCALE_MAX_ANSWER_GROWTH_BYTES;
    if !database_growth_within_limit {
        return Err(AppError::Validation(
            "runtime QA learning database growth exceeded its stable limit".into(),
        ));
    }

    let backup_directory = root.join("app-data").join(QA_IDENTIFIER).join("backups");
    let backup = {
        let repository = state.repository.lock();
        let learning = state.learning.lock();
        crate::backups::create_unified_manual_backup(&repository, &learning, &backup_directory)?
    };
    let extra_answers = apply_correct_learning_answers(&state, 1, &mut now_unix_ms)?;
    let mutated_summary = state.learning.lock().data_summary()?;
    if extra_answers != 1 || mutated_summary.review_count != LEARNING_SCALE_ANSWER_COUNT + 1 {
        return Err(AppError::Validation(
            "runtime QA learning backup mutation did not apply".into(),
        ));
    }
    {
        let mut repository = state.repository.lock();
        let mut learning = state.learning.lock();
        crate::backups::restore_unified_backup(
            &mut repository,
            &mut learning,
            &backup_directory,
            &backup.file_name,
        )?;
    }
    let restored = state.learning.lock().data_summary()?;
    let backup_restore_passed = backup.learning_included
        && restored.card_count == LEARNING_SCALE_CARD_COUNT
        && restored.review_count == LEARNING_SCALE_ANSWER_COUNT;
    if !backup_restore_passed {
        return Err(AppError::Validation(
            "runtime QA learning unified backup restore did not pass".into(),
        ));
    }
    let (integrity_check, foreign_key_violation_count) = learning_database_health(&database)?;
    if integrity_check != "ok" || foreign_key_violation_count != 0 {
        return Err(AppError::Validation(
            "runtime QA learning database health did not pass".into(),
        ));
    }

    Ok(LearningScaleAcceptanceReport {
        schema_version: 1,
        status: "passed",
        product_version: env!("CARGO_PKG_VERSION"),
        runtime_identifier: QA_IDENTIFIER,
        tauri_process_id: std::process::id(),
        synthetic_data_only: true,
        tauri_import_passed,
        cancellation_passed,
        imported_cards: imported.imported_count,
        pagination_passed,
        answers_applied,
        database_growth_within_limit,
        backup_restore_passed,
        source_csv_sha256,
        cancellation_check_count: cancellation_checks.load(Ordering::SeqCst),
        database_bytes_after_import,
        database_bytes_after_answers,
        answer_growth_bytes,
        maximum_database_bytes: LEARNING_SCALE_MAX_DATABASE_BYTES,
        maximum_answer_growth_bytes: LEARNING_SCALE_MAX_ANSWER_GROWTH_BYTES,
        restored_card_count: restored.card_count,
        restored_review_count: restored.review_count,
        integrity_check,
        foreign_key_violation_count,
        elapsed_milliseconds: u64::try_from(started.elapsed().as_millis()).unwrap_or(u64::MAX),
        privacy: "Contains only deterministic synthetic counts, timing, sizes, hashes and fixed health results; no user content or user paths.",
    })
}

#[cfg(feature = "learning")]
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LearningRecoveryState {
    pub session_id: String,
    pub status: String,
    pub state_revision: u64,
    pub current_item_id: String,
    pub headword: String,
    pub planned_count: u8,
    pub completed_count: u8,
    pub pause_reason: Option<String>,
    pub event_count: u32,
    pub crash_recovered_event_count: u32,
    pub resumed_event_count: u32,
    pub answer_committed_event_count: u32,
    pub question_attempt_count: u32,
    pub review_log_count: u32,
    pub last_answered_item_id: Option<String>,
    pub last_answered_headword: Option<String>,
    pub last_answer_outcome: Option<String>,
    pub integrity_check: String,
    pub foreign_key_violation_count: u32,
}

#[cfg(feature = "learning")]
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LearningPreemptionPlan {
    pub card_count: u32,
    pub pack_id: String,
    pub content_sha256: String,
    pub database_sha256: String,
    pub database_bytes: u64,
    pub reminder_id: String,
    pub scheduled_at: String,
    pub accessible_name_fragment: String,
}

#[cfg(feature = "learning")]
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LearningPreemptionState {
    pub session_id: String,
    pub status: String,
    pub state_revision: u64,
    pub current_item_id: String,
    pub headword: String,
    pub pause_reason: Option<String>,
    pub interrupted_event_count: u32,
    pub interrupted_at_unix_ms: Option<i64>,
    pub answer_committed_event_count: u32,
    pub question_attempt_count: u32,
    pub review_log_count: u32,
    pub integrity_check: String,
    pub foreign_key_violation_count: u32,
}

#[cfg(feature = "learning")]
pub fn seed_learning_performance(card_count: u32) -> AppResult<LearningPerformancePlan> {
    if !(1..=10_000).contains(&card_count) {
        return Err(AppError::Validation(
            "runtime QA learning card count must be 1 to 10000".into(),
        ));
    }
    let csv = build_synthetic_learning_csv(card_count);
    let content_sha256 = sha256_hex(csv.as_bytes());
    let reminder_pause_until = Utc::now() + ChronoDuration::hours(4);
    let reminder_database =
        app_data_directory(QA_IDENTIFIER)?.join(crate::brand::main_database_file());
    Repository::open(&reminder_database)?.update_settings(serde_json::json!({
        "pauseUntil": reminder_pause_until.to_rfc3339(),
    }))?;
    let database = app_data_directory(QA_IDENTIFIER)?
        .join("learning-data")
        .join(crate::brand::learning_database_file());
    let now_unix_ms = Utc::now().timestamp_millis();
    let result = {
        let mut runtime = crate::learning::LearningRuntime::initialize(&database);
        if !runtime.capabilities().available {
            return Err(AppError::Validation(
                "runtime QA learning database is unavailable".into(),
            ));
        }
        let preview = runtime.preview_csv_import(csv.as_bytes(), now_unix_ms)?;
        if preview.card_count != card_count {
            return Err(AppError::Validation(
                "runtime QA learning fixture count changed during preview".into(),
            ));
        }
        let token = preview.preview_token.ok_or_else(|| {
            AppError::Validation("runtime QA learning preview token is unavailable".into())
        })?;
        runtime.confirm_import(&token, now_unix_ms.saturating_add(1))?
    };
    let database_bytes = fs::metadata(&database)?.len();
    let database_sha256 = sha256_hex(&fs::read(&database)?);
    Ok(LearningPerformancePlan {
        card_count: result.imported_count,
        pack_id: result.pack_id,
        content_sha256,
        database_sha256,
        database_bytes,
        reminder_pause_until_utc: reminder_pause_until.to_rfc3339(),
    })
}

#[cfg(feature = "learning")]
pub fn seed_learning_preemption(due_after_seconds: u64) -> AppResult<LearningPreemptionPlan> {
    let learning = seed_learning_performance(5)?;
    let reminder_database =
        app_data_directory(QA_IDENTIFIER)?.join(crate::brand::main_database_file());
    Repository::open(&reminder_database)?.update_settings(serde_json::json!({
        "pauseUntil": null,
    }))?;
    let reminder = seed_reminder_latency(due_after_seconds)?;
    Ok(LearningPreemptionPlan {
        card_count: learning.card_count,
        pack_id: learning.pack_id,
        content_sha256: learning.content_sha256,
        database_sha256: learning.database_sha256,
        database_bytes: learning.database_bytes,
        reminder_id: reminder.reminder_id,
        scheduled_at: reminder.scheduled_at,
        accessible_name_fragment: reminder.accessible_name_fragment,
    })
}

#[cfg(feature = "learning")]
pub fn read_learning_recovery_state() -> AppResult<LearningRecoveryState> {
    let database = app_data_directory(QA_IDENTIFIER)?
        .join("learning-data")
        .join(crate::brand::learning_database_file());
    read_learning_recovery_state_from_database(&database)
}

#[cfg(feature = "learning")]
pub fn read_learning_preemption_state() -> AppResult<LearningPreemptionState> {
    let database = app_data_directory(QA_IDENTIFIER)?
        .join("learning-data")
        .join(crate::brand::learning_database_file());
    read_learning_preemption_state_from_database(&database)
}

#[cfg(feature = "learning")]
fn read_learning_recovery_state_from_database(database: &Path) -> AppResult<LearningRecoveryState> {
    use rusqlite::{Connection, OpenFlags};

    let connection = Connection::open_with_flags(
        database,
        OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX,
    )?;
    connection.busy_timeout(Duration::from_secs(5))?;
    let raw = connection.query_row(
        "SELECT s.session_id, s.status, s.state_revision, s.current_item_id,
                c.headword, s.planned_count, s.completed_count, s.pause_reason,
                (SELECT COUNT(*) FROM learning_session_events e
                 WHERE e.session_id = s.session_id),
                (SELECT COUNT(*) FROM learning_session_events e
                 WHERE e.session_id = s.session_id AND e.event_kind = 'crash_recovered'),
                (SELECT COUNT(*) FROM learning_session_events e
                 WHERE e.session_id = s.session_id AND e.event_kind = 'resumed'),
                (SELECT COUNT(*) FROM learning_session_events e
                 WHERE e.session_id = s.session_id AND e.event_kind = 'answer_committed'),
                (SELECT COUNT(*) FROM learning_question_attempts a
                 WHERE a.session_id = s.session_id),
                (SELECT COUNT(*) FROM review_logs r WHERE r.session_id = s.session_id),
                (SELECT a.card_id FROM learning_question_attempts a
                 WHERE a.session_id = s.session_id
                 ORDER BY a.answered_at_unix_ms DESC, a.attempt_id DESC LIMIT 1),
                (SELECT answered.headword
                 FROM learning_question_attempts a
                 JOIN learning_cards answered ON answered.card_id = a.card_id
                 WHERE a.session_id = s.session_id
                 ORDER BY a.answered_at_unix_ms DESC, a.attempt_id DESC LIMIT 1),
                (SELECT a.outcome FROM learning_question_attempts a
                 WHERE a.session_id = s.session_id
                 ORDER BY a.answered_at_unix_ms DESC, a.attempt_id DESC LIMIT 1)
         FROM learning_sessions s
         LEFT JOIN learning_cards c ON c.card_id = s.current_item_id
         ORDER BY s.started_at_unix_ms DESC, s.session_id DESC
         LIMIT 1",
        [],
        |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, i64>(2)?,
                row.get::<_, Option<String>>(3)?,
                row.get::<_, Option<String>>(4)?,
                row.get::<_, i64>(5)?,
                row.get::<_, i64>(6)?,
                row.get::<_, Option<String>>(7)?,
                row.get::<_, i64>(8)?,
                row.get::<_, i64>(9)?,
                row.get::<_, i64>(10)?,
                row.get::<_, i64>(11)?,
                row.get::<_, i64>(12)?,
                row.get::<_, i64>(13)?,
                row.get::<_, Option<String>>(14)?,
                row.get::<_, Option<String>>(15)?,
                row.get::<_, Option<String>>(16)?,
            ))
        },
    )?;
    let current_item_id = raw.3.ok_or_else(|| {
        AppError::Validation("runtime QA learning session has no current item".into())
    })?;
    let headword = raw.4.ok_or_else(|| {
        AppError::Validation("runtime QA learning current item is unavailable".into())
    })?;
    if !matches!(raw.1.as_str(), "active" | "paused") {
        return Err(AppError::Validation(
            "runtime QA learning session is not recoverable".into(),
        ));
    }
    let integrity_check: String =
        connection.query_row("PRAGMA integrity_check(1)", [], |row| row.get(0))?;
    let mut foreign_key_statement = connection.prepare("PRAGMA foreign_key_check")?;
    let mut foreign_key_rows = foreign_key_statement.query([])?;
    let mut foreign_key_violation_count = 0_u32;
    while foreign_key_rows.next()?.is_some() {
        foreign_key_violation_count = foreign_key_violation_count.saturating_add(1);
    }
    Ok(LearningRecoveryState {
        session_id: raw.0,
        status: raw.1,
        state_revision: checked_u64(raw.2, "state revision")?,
        current_item_id,
        headword,
        planned_count: checked_u8(raw.5, "planned count")?,
        completed_count: checked_u8(raw.6, "completed count")?,
        pause_reason: raw.7,
        event_count: checked_u32(raw.8, "event count")?,
        crash_recovered_event_count: checked_u32(raw.9, "crash recovery event count")?,
        resumed_event_count: checked_u32(raw.10, "resumed event count")?,
        answer_committed_event_count: checked_u32(raw.11, "answer event count")?,
        question_attempt_count: checked_u32(raw.12, "question attempt count")?,
        review_log_count: checked_u32(raw.13, "review log count")?,
        last_answered_item_id: raw.14,
        last_answered_headword: raw.15,
        last_answer_outcome: raw.16,
        integrity_check,
        foreign_key_violation_count,
    })
}

#[cfg(feature = "learning")]
fn read_learning_preemption_state_from_database(
    database: &Path,
) -> AppResult<LearningPreemptionState> {
    use rusqlite::{Connection, OpenFlags};

    let connection = Connection::open_with_flags(
        database,
        OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX,
    )?;
    connection.busy_timeout(Duration::from_secs(5))?;
    let raw = connection.query_row(
        "SELECT s.session_id, s.status, s.state_revision, s.current_item_id,
                c.headword, s.pause_reason,
                (SELECT COUNT(*) FROM learning_session_events e
                 WHERE e.session_id = s.session_id AND e.event_kind = 'interrupted'),
                (SELECT MAX(e.occurred_at_unix_ms) FROM learning_session_events e
                 WHERE e.session_id = s.session_id AND e.event_kind = 'interrupted'),
                (SELECT COUNT(*) FROM learning_session_events e
                 WHERE e.session_id = s.session_id AND e.event_kind = 'answer_committed'),
                (SELECT COUNT(*) FROM learning_question_attempts a
                 WHERE a.session_id = s.session_id),
                (SELECT COUNT(*) FROM review_logs r WHERE r.session_id = s.session_id)
         FROM learning_sessions s
         LEFT JOIN learning_cards c ON c.card_id = s.current_item_id
         ORDER BY s.started_at_unix_ms DESC, s.session_id DESC
         LIMIT 1",
        [],
        |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, i64>(2)?,
                row.get::<_, Option<String>>(3)?,
                row.get::<_, Option<String>>(4)?,
                row.get::<_, Option<String>>(5)?,
                row.get::<_, i64>(6)?,
                row.get::<_, Option<i64>>(7)?,
                row.get::<_, i64>(8)?,
                row.get::<_, i64>(9)?,
                row.get::<_, i64>(10)?,
            ))
        },
    )?;
    let current_item_id = raw.3.ok_or_else(|| {
        AppError::Validation("runtime QA learning session has no current item".into())
    })?;
    let headword = raw.4.ok_or_else(|| {
        AppError::Validation("runtime QA learning current item is unavailable".into())
    })?;
    if !matches!(raw.1.as_str(), "active" | "paused") {
        return Err(AppError::Validation(
            "runtime QA learning session is not preemptible".into(),
        ));
    }
    let integrity_check: String =
        connection.query_row("PRAGMA integrity_check(1)", [], |row| row.get(0))?;
    let mut foreign_key_statement = connection.prepare("PRAGMA foreign_key_check")?;
    let mut foreign_key_rows = foreign_key_statement.query([])?;
    let mut foreign_key_violation_count = 0_u32;
    while foreign_key_rows.next()?.is_some() {
        foreign_key_violation_count = foreign_key_violation_count.saturating_add(1);
    }
    Ok(LearningPreemptionState {
        session_id: raw.0,
        status: raw.1,
        state_revision: checked_u64(raw.2, "state revision")?,
        current_item_id,
        headword,
        pause_reason: raw.5,
        interrupted_event_count: checked_u32(raw.6, "interrupted event count")?,
        interrupted_at_unix_ms: raw.7,
        answer_committed_event_count: checked_u32(raw.8, "answer event count")?,
        question_attempt_count: checked_u32(raw.9, "question attempt count")?,
        review_log_count: checked_u32(raw.10, "review log count")?,
        integrity_check,
        foreign_key_violation_count,
    })
}

#[cfg(feature = "learning")]
fn checked_u64(value: i64, label: &str) -> AppResult<u64> {
    u64::try_from(value).map_err(|_| AppError::Validation(format!("runtime QA {label} is invalid")))
}

#[cfg(feature = "learning")]
fn checked_u32(value: i64, label: &str) -> AppResult<u32> {
    u32::try_from(value).map_err(|_| AppError::Validation(format!("runtime QA {label} is invalid")))
}

#[cfg(feature = "learning")]
fn checked_u8(value: i64, label: &str) -> AppResult<u8> {
    u8::try_from(value).map_err(|_| AppError::Validation(format!("runtime QA {label} is invalid")))
}

#[cfg(feature = "learning")]
fn build_synthetic_learning_csv(card_count: u32) -> String {
    use std::fmt::Write as _;

    let mut csv = String::from("headword,meanings_zh\n");
    for index in 0..card_count {
        let _ = writeln!(
            csv,
            "qa{},合成释义 {}",
            alphabetic_index(index),
            index.saturating_add(1)
        );
    }
    csv
}

#[cfg(feature = "learning")]
fn alphabetic_index(mut index: u32) -> String {
    let mut characters = Vec::new();
    loop {
        characters.push((b'a' + (index % 26) as u8) as char);
        index /= 26;
        if index == 0 {
            break;
        }
        index -= 1;
    }
    characters.iter().rev().collect()
}

#[cfg(feature = "learning")]
fn sha256_hex(bytes: &[u8]) -> String {
    format!("{:X}", Sha256::digest(bytes))
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ReminderLatencyPlan {
    pub reminder_id: String,
    pub scheduled_at: String,
    pub accessible_name_fragment: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ReminderLatencyClaim {
    pub reminder_id: String,
    pub scheduled_at: String,
    pub claimed_at: String,
    pub status: String,
}

fn reminder_latency_fixture_labels() -> (String, String) {
    let sample_token = uuid::Uuid::new_v4().simple().to_string();
    let title = format!("运行验收事项-{}", &sample_token[..8]);
    let accessible_name = format!("事项提醒：{title}，打开今日任务");
    (title, accessible_name)
}

pub fn seed_reminder_latency(due_after_seconds: u64) -> AppResult<ReminderLatencyPlan> {
    if !(1..=120).contains(&due_after_seconds) {
        return Err(AppError::Validation(
            "runtime QA reminder delay must be 1 to 120 seconds".into(),
        ));
    }
    let database = app_data_directory(QA_IDENTIFIER)?.join(crate::brand::main_database_file());
    let repository = Repository::open(&database)?;
    let now = Utc::now();
    let scheduled = now + ChronoDuration::seconds(due_after_seconds as i64);
    let placeholder = (now + ChronoDuration::hours(1))
        .with_timezone(&Local)
        .format("%Y-%m-%dT%H:%M")
        .to_string();
    let (title, accessible_name_fragment) = reminder_latency_fixture_labels();
    let reminder = repository.create_reminder(CreateReminderInput {
        title: title.clone(),
        category: "work".into(),
        schedule_kind: "once".into(),
        at_local: Some(placeholder),
        every_minutes: None,
        active_start_local: None,
        active_end_local: None,
        weekdays: None,
    })?;
    repository.set_runtime_qa_reminder_due(&reminder.id, scheduled)?;
    Ok(ReminderLatencyPlan {
        reminder_id: reminder.id,
        scheduled_at: scheduled.to_rfc3339(),
        accessible_name_fragment,
    })
}

pub fn read_reminder_latency_claim(reminder_id: &str) -> AppResult<ReminderLatencyClaim> {
    let database = app_data_directory(QA_IDENTIFIER)?.join(crate::brand::main_database_file());
    let repository = Repository::open(&database)?;
    let (scheduled_at, claimed_at, status) = repository
        .runtime_qa_reminder_claim(reminder_id)?
        .ok_or_else(|| AppError::Validation("runtime QA reminder was not claimed".into()))?;
    Ok(ReminderLatencyClaim {
        reminder_id: reminder_id.into(),
        scheduled_at,
        claimed_at,
        status,
    })
}

pub fn schedule_controlled_exit(app: &AppHandle) -> AppResult<()> {
    let Some(seconds) = parse_exit_after_seconds(std::env::var_os(EXIT_AFTER_ENV).as_deref())?
    else {
        return Ok(());
    };
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(Duration::from_secs(seconds)).await;
        crate::commands::quit_inner(&app);
    });
    Ok(())
}

fn parse_exit_after_seconds(value: Option<&OsStr>) -> AppResult<Option<u64>> {
    let Some(value) = value else {
        return Ok(None);
    };
    let value = value
        .to_str()
        .and_then(|value| value.parse::<u64>().ok())
        .filter(|seconds| (30..=259_200).contains(seconds))
        .ok_or_else(|| {
            AppError::Validation("runtime QA exit duration must be 30 to 259200 seconds".into())
        })?;
    Ok(Some(value))
}

fn validate_root(path: &Path) -> AppResult<PathBuf> {
    validate_root_shape(path)?;
    let metadata = fs::symlink_metadata(path)
        .map_err(|_| AppError::Validation("runtime QA root is unavailable".into()))?;
    if !metadata.is_dir() || metadata_is_reparse_point(&metadata) {
        return Err(AppError::Validation("runtime QA root is unsafe".into()));
    }
    let marker = path.join(MARKER_NAME);
    let marker_metadata = fs::symlink_metadata(&marker)
        .map_err(|_| AppError::Validation("runtime QA marker is missing".into()))?;
    if !marker_metadata.is_file() || metadata_is_reparse_point(&marker_metadata) {
        return Err(AppError::Validation("runtime QA marker is unsafe".into()));
    }
    let content = fs::read(&marker)?;
    if content != MARKER_CONTENT {
        return Err(AppError::Validation("runtime QA marker is invalid".into()));
    }
    fs::canonicalize(path).map_err(AppError::from)
}

fn validate_root_shape(path: &Path) -> AppResult<()> {
    if !path.is_absolute()
        || !path
            .file_name()
            .and_then(|name| name.to_str())
            .is_some_and(|name| name.starts_with(ROOT_PREFIX) && name.len() > ROOT_PREFIX.len())
    {
        return Err(AppError::Validation("runtime QA root is invalid".into()));
    }
    let parent = path
        .parent()
        .ok_or_else(|| AppError::Validation("runtime QA parent is invalid".into()))?;
    let metadata = fs::symlink_metadata(parent)
        .map_err(|_| AppError::Validation("runtime QA parent is unavailable".into()))?;
    if !metadata.is_dir() || metadata_is_reparse_point(&metadata) {
        return Err(AppError::Validation("runtime QA parent is unsafe".into()));
    }
    Ok(())
}

#[cfg(windows)]
fn metadata_is_reparse_point(metadata: &fs::Metadata) -> bool {
    use std::os::windows::fs::MetadataExt;

    const FILE_ATTRIBUTE_REPARSE_POINT: u32 = 0x0400;
    metadata.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT != 0
}

#[cfg(not(windows))]
fn metadata_is_reparse_point(metadata: &fs::Metadata) -> bool {
    metadata.file_type().is_symlink()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn unique_root(suffix: &str) -> PathBuf {
        std::env::temp_dir().join(format!("{ROOT_PREFIX}{suffix}-{}", uuid::Uuid::new_v4()))
    }

    #[test]
    fn root_requires_an_absolute_prefixed_path_and_exact_marker() {
        assert!(create_root(Path::new("relative-runtime-qa")).is_err());
        let wrong_name = std::env::temp_dir().join(format!("wrong-{}", uuid::Uuid::new_v4()));
        assert!(create_root(&wrong_name).is_err());

        let unmarked = unique_root("unmarked");
        fs::create_dir(&unmarked).unwrap();
        assert!(create_root(&unmarked).is_err());
        fs::remove_dir(&unmarked).unwrap();
    }

    #[test]
    fn dedicated_root_round_trips_without_adopting_other_directories() {
        let root = unique_root("round-trip");
        let canonical = create_root(&root).unwrap();
        assert_eq!(validate_root(&canonical).unwrap(), canonical);
        assert_eq!(fs::read(root.join(MARKER_NAME)).unwrap(), MARKER_CONTENT);
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn controlled_exit_duration_is_bounded_and_optional() {
        assert_eq!(parse_exit_after_seconds(None).unwrap(), None);
        assert_eq!(
            parse_exit_after_seconds(Some(OsStr::new("30"))).unwrap(),
            Some(30)
        );
        assert_eq!(
            parse_exit_after_seconds(Some(OsStr::new("259200"))).unwrap(),
            Some(259_200)
        );
        for invalid in ["", "29", "259201", "1.5", "forever"] {
            assert!(parse_exit_after_seconds(Some(OsStr::new(invalid))).is_err());
        }
    }

    #[test]
    fn context_menu_control_only_consumes_the_exact_empty_regular_file() {
        let root = create_root(&unique_root("control")).unwrap();
        fs::create_dir(root.join("control")).unwrap();
        let trigger = root.join("control").join(SHOW_PET_CONTEXT_MENU_TRIGGER);

        fs::write(&trigger, []).unwrap();
        assert!(consume_empty_control_trigger(&root, SHOW_PET_CONTEXT_MENU_TRIGGER).unwrap());
        assert!(!consume_empty_control_trigger(&root, SHOW_PET_CONTEXT_MENU_TRIGGER).unwrap());
        let sleep_trigger = root.join("control").join(INVOKE_PET_SLEEP_MENU_TRIGGER);
        fs::write(&sleep_trigger, []).unwrap();
        assert!(consume_empty_control_trigger(&root, INVOKE_PET_SLEEP_MENU_TRIGGER).unwrap());
        assert!(!consume_empty_control_trigger(&root, INVOKE_PET_SLEEP_MENU_TRIGGER).unwrap());
        for trigger_name in PANEL_SIZE_TRIGGERS {
            let panel_trigger = root.join("control").join(trigger_name);
            fs::write(&panel_trigger, []).unwrap();
            assert!(consume_empty_control_trigger(&root, trigger_name).unwrap());
            assert!(!consume_empty_control_trigger(&root, trigger_name).unwrap());
        }
        assert!(consume_empty_control_trigger(&root, "unknown-control").is_err());

        fs::write(&trigger, b"payload").unwrap();
        assert!(consume_empty_control_trigger(&root, SHOW_PET_CONTEXT_MENU_TRIGGER).is_err());
        assert_eq!(
            panel_size_for_trigger(SET_PANEL_360X560_TRIGGER),
            Some((360.0, 560.0))
        );
        assert_eq!(
            panel_size_for_trigger(SET_PANEL_390X620_TRIGGER),
            Some((390.0, 620.0))
        );
        assert_eq!(
            panel_size_for_trigger(SET_PANEL_480X760_TRIGGER),
            Some((480.0, 760.0))
        );
        assert_eq!(panel_size_for_trigger("set-panel-size-1x1"), None);
        fs::remove_file(trigger).unwrap();
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn runtime_profile_is_explicit_and_unknown_values_fail_closed() {
        assert_eq!(parse_profile(None).unwrap(), RuntimeQaProfile::TaskWatch);
        assert_eq!(
            parse_profile(Some(OsStr::new("task-watch"))).unwrap(),
            RuntimeQaProfile::TaskWatch
        );
        assert_eq!(
            parse_profile(Some(OsStr::new("task-failure-motion"))).unwrap(),
            RuntimeQaProfile::TaskFailureMotion
        );
        assert_eq!(
            parse_profile(Some(OsStr::new("baseline-ai-off"))).unwrap(),
            RuntimeQaProfile::BaselineAiOff
        );
        assert_eq!(
            parse_profile(Some(OsStr::new("reminder-latency"))).unwrap(),
            RuntimeQaProfile::ReminderLatency
        );
        assert_eq!(
            parse_profile(Some(OsStr::new("diagnostics"))).unwrap(),
            RuntimeQaProfile::Diagnostics
        );
        #[cfg(feature = "learning")]
        assert_eq!(
            parse_profile(Some(OsStr::new("learning-performance"))).unwrap(),
            RuntimeQaProfile::LearningPerformance
        );
        assert!(parse_profile(Some(OsStr::new("production"))).is_err());
    }

    #[test]
    fn endurance_profile_isolates_time_of_day_sleep_transitions() {
        assert!(profile_isolates_time_of_day_automation(
            RuntimeQaProfile::BaselineAiOff
        ));
        assert!(!profile_isolates_time_of_day_automation(
            RuntimeQaProfile::TaskWatch
        ));
        assert!(!profile_isolates_time_of_day_automation(
            RuntimeQaProfile::ReminderLatency
        ));
        #[cfg(feature = "learning")]
        assert!(profile_isolates_time_of_day_automation(
            RuntimeQaProfile::LearningPerformance
        ));
    }

    #[cfg(feature = "learning")]
    #[test]
    fn synthetic_learning_fixture_is_deterministic_and_unique() {
        let first = build_synthetic_learning_csv(4_533);
        let second = build_synthetic_learning_csv(4_533);
        assert_eq!(first, second);
        assert_eq!(sha256_hex(first.as_bytes()), sha256_hex(second.as_bytes()));
        assert!(first.len() < 2 * 1024 * 1024);
        let rows = first
            .lines()
            .skip(1)
            .collect::<std::collections::BTreeSet<_>>();
        assert_eq!(rows.len(), 4_533);
    }

    #[cfg(feature = "learning")]
    #[test]
    fn recovery_state_reader_reports_persisted_session_invariants() {
        let directory = tempfile::tempdir().unwrap();
        let database = directory.path().join("learning.sqlite3");
        let connection = rusqlite::Connection::open(&database).unwrap();
        connection
            .execute_batch(
                "PRAGMA foreign_keys = ON;
                 CREATE TABLE learning_cards(card_id TEXT PRIMARY KEY, headword TEXT NOT NULL);
                 CREATE TABLE learning_sessions(
                     session_id TEXT PRIMARY KEY,
                     status TEXT NOT NULL,
                     state_revision INTEGER NOT NULL,
                     current_item_id TEXT REFERENCES learning_cards(card_id),
                     planned_count INTEGER NOT NULL,
                     completed_count INTEGER NOT NULL,
                     pause_reason TEXT,
                     started_at_unix_ms INTEGER NOT NULL
                 );
                 CREATE TABLE learning_session_events(
                     event_id TEXT PRIMARY KEY,
                     session_id TEXT NOT NULL REFERENCES learning_sessions(session_id),
                     event_kind TEXT NOT NULL
                 );
                 CREATE TABLE learning_question_attempts(
                     attempt_id TEXT PRIMARY KEY,
                     session_id TEXT NOT NULL REFERENCES learning_sessions(session_id),
                     card_id TEXT NOT NULL REFERENCES learning_cards(card_id),
                     outcome TEXT NOT NULL,
                     answered_at_unix_ms INTEGER NOT NULL
                 );
                 CREATE TABLE review_logs(
                     review_id TEXT PRIMARY KEY,
                     session_id TEXT NOT NULL REFERENCES learning_sessions(session_id)
                 );
                 INSERT INTO learning_cards VALUES('card-answered', 'qaone');
                 INSERT INTO learning_cards VALUES('card-current', 'qatwo');
                 INSERT INTO learning_sessions VALUES(
                     'session-1', 'paused', 4, 'card-current', 3, 1, 'crash_recovery', 1000
                 );
                 INSERT INTO learning_session_events VALUES(
                     'event-1', 'session-1', 'answer_committed'
                 );
                 INSERT INTO learning_session_events VALUES(
                     'event-2', 'session-1', 'crash_recovered'
                 );
                 INSERT INTO learning_question_attempts VALUES(
                     'attempt-1', 'session-1', 'card-answered', 'correct', 1100
                 );
                 INSERT INTO review_logs VALUES('review-1', 'session-1');",
            )
            .unwrap();
        drop(connection);

        let state = read_learning_recovery_state_from_database(&database).unwrap();
        assert_eq!(state.session_id, "session-1");
        assert_eq!(state.status, "paused");
        assert_eq!(state.state_revision, 4);
        assert_eq!(state.current_item_id, "card-current");
        assert_eq!(state.headword, "qatwo");
        assert_eq!(state.completed_count, 1);
        assert_eq!(state.pause_reason.as_deref(), Some("crash_recovery"));
        assert_eq!(state.event_count, 2);
        assert_eq!(state.crash_recovered_event_count, 1);
        assert_eq!(state.answer_committed_event_count, 1);
        assert_eq!(state.question_attempt_count, 1);
        assert_eq!(state.review_log_count, 1);
        assert_eq!(
            state.last_answered_item_id.as_deref(),
            Some("card-answered")
        );
        assert_eq!(state.last_answered_headword.as_deref(), Some("qaone"));
        assert_eq!(state.last_answer_outcome.as_deref(), Some("correct"));
        assert_eq!(state.integrity_check, "ok");
        assert_eq!(state.foreign_key_violation_count, 0);
    }

    #[cfg(feature = "learning")]
    #[test]
    fn answer_commit_crash_hook_enters_inside_commit_and_rolls_back_on_release() {
        use std::sync::mpsc;

        let root = create_root(&unique_root("answer-commit-hook")).unwrap();
        fs::create_dir(root.join("control")).unwrap();
        fs::create_dir(root.join("status")).unwrap();
        let mut connection = rusqlite::Connection::open_in_memory().unwrap();
        connection
            .execute_batch("CREATE TABLE committed_values(value INTEGER NOT NULL);")
            .unwrap();
        let gate = install_learning_commit_crash_gate_for_root(&connection, &root).unwrap();
        fs::write(
            root.join("control").join(LEARNING_COMMIT_CRASH_ARM_TRIGGER),
            [],
        )
        .unwrap();
        let (finished_tx, finished_rx) = mpsc::channel();
        let worker = thread::spawn(move || {
            let transaction = connection.transaction().unwrap();
            transaction
                .execute("INSERT INTO committed_values VALUES(1)", [])
                .unwrap();
            gate.mark_answer_commit_pending();
            let rejected = transaction.commit().is_err();
            gate.clear_answer_commit_pending();
            finished_tx.send(rejected).unwrap();
            connection
        });
        let entered = root
            .join("status")
            .join(LEARNING_COMMIT_CRASH_ENTERED_STAGE);
        for _ in 0..200 {
            if entered.is_file() {
                break;
            }
            thread::sleep(Duration::from_millis(10));
        }
        assert!(entered.is_file());
        assert!(finished_rx.try_recv().is_err());
        fs::write(
            root.join("control")
                .join(LEARNING_COMMIT_CRASH_RELEASE_TRIGGER),
            [],
        )
        .unwrap();
        assert!(finished_rx.recv_timeout(Duration::from_secs(5)).unwrap());
        let connection = worker.join().unwrap();
        let count: i64 = connection
            .query_row("SELECT COUNT(*) FROM committed_values", [], |row| {
                row.get(0)
            })
            .unwrap();
        assert_eq!(count, 0);
        fs::remove_dir_all(root).unwrap();
    }

    #[cfg(feature = "learning")]
    #[test]
    fn answer_commit_crash_hook_is_inert_without_an_exact_empty_arm_control() {
        let root = create_root(&unique_root("answer-commit-inert")).unwrap();
        fs::create_dir(root.join("control")).unwrap();
        fs::create_dir(root.join("status")).unwrap();
        let mut connection = rusqlite::Connection::open_in_memory().unwrap();
        connection
            .execute_batch("CREATE TABLE committed_values(value INTEGER NOT NULL);")
            .unwrap();
        let gate = install_learning_commit_crash_gate_for_root(&connection, &root).unwrap();
        let transaction = connection.transaction().unwrap();
        transaction
            .execute("INSERT INTO committed_values VALUES(1)", [])
            .unwrap();
        gate.mark_answer_commit_pending();
        transaction.commit().unwrap();
        gate.clear_answer_commit_pending();
        let count: i64 = connection
            .query_row("SELECT COUNT(*) FROM committed_values", [], |row| {
                row.get(0)
            })
            .unwrap();
        assert_eq!(count, 1);
        assert!(!root
            .join("status")
            .join(LEARNING_COMMIT_CRASH_ENTERED_STAGE)
            .exists());
        fs::remove_dir_all(root).unwrap();
    }

    #[cfg(feature = "learning")]
    #[test]
    fn answer_commit_crash_hook_rejects_a_nonempty_arm_control_without_committing() {
        let root = create_root(&unique_root("answer-commit-invalid")).unwrap();
        fs::create_dir(root.join("control")).unwrap();
        fs::create_dir(root.join("status")).unwrap();
        let mut connection = rusqlite::Connection::open_in_memory().unwrap();
        connection
            .execute_batch("CREATE TABLE committed_values(value INTEGER NOT NULL);")
            .unwrap();
        let gate = install_learning_commit_crash_gate_for_root(&connection, &root).unwrap();
        fs::write(
            root.join("control").join(LEARNING_COMMIT_CRASH_ARM_TRIGGER),
            b"payload",
        )
        .unwrap();
        let transaction = connection.transaction().unwrap();
        transaction
            .execute("INSERT INTO committed_values VALUES(1)", [])
            .unwrap();
        gate.mark_answer_commit_pending();
        assert!(transaction.commit().is_err());
        gate.clear_answer_commit_pending();
        let count: i64 = connection
            .query_row("SELECT COUNT(*) FROM committed_values", [], |row| {
                row.get(0)
            })
            .unwrap();
        assert_eq!(count, 0);
        assert!(root
            .join("status")
            .join(LEARNING_COMMIT_CRASH_ERROR_STAGE)
            .is_file());
        assert!(!root
            .join("status")
            .join(LEARNING_COMMIT_CRASH_ENTERED_STAGE)
            .exists());
        fs::remove_dir_all(root).unwrap();
    }

    #[cfg(feature = "learning")]
    #[test]
    fn preemption_state_reader_reports_interruption_time_and_zero_answer_writes() {
        let directory = tempfile::tempdir().unwrap();
        let database = directory.path().join("learning.sqlite3");
        let connection = rusqlite::Connection::open(&database).unwrap();
        connection
            .execute_batch(
                "PRAGMA foreign_keys = ON;
                 CREATE TABLE learning_cards(card_id TEXT PRIMARY KEY, headword TEXT NOT NULL);
                 CREATE TABLE learning_sessions(
                     session_id TEXT PRIMARY KEY,
                     status TEXT NOT NULL,
                     state_revision INTEGER NOT NULL,
                     current_item_id TEXT REFERENCES learning_cards(card_id),
                     pause_reason TEXT,
                     started_at_unix_ms INTEGER NOT NULL
                 );
                 CREATE TABLE learning_session_events(
                     event_id TEXT PRIMARY KEY,
                     session_id TEXT NOT NULL REFERENCES learning_sessions(session_id),
                     event_kind TEXT NOT NULL,
                     occurred_at_unix_ms INTEGER NOT NULL
                 );
                 CREATE TABLE learning_question_attempts(
                     attempt_id TEXT PRIMARY KEY,
                     session_id TEXT NOT NULL REFERENCES learning_sessions(session_id)
                 );
                 CREATE TABLE review_logs(
                     review_id TEXT PRIMARY KEY,
                     session_id TEXT NOT NULL REFERENCES learning_sessions(session_id)
                 );
                 INSERT INTO learning_cards VALUES('card-1', 'qaone');
                 INSERT INTO learning_sessions VALUES(
                     'session-1', 'paused', 3, 'card-1', 'preempted_high_priority', 1000
                 );
                 INSERT INTO learning_session_events VALUES(
                     'event-1', 'session-1', 'interrupted', 1200
                 );",
            )
            .unwrap();
        drop(connection);

        let state = read_learning_preemption_state_from_database(&database).unwrap();
        assert_eq!(state.session_id, "session-1");
        assert_eq!(state.status, "paused");
        assert_eq!(state.state_revision, 3);
        assert_eq!(state.current_item_id, "card-1");
        assert_eq!(state.headword, "qaone");
        assert_eq!(
            state.pause_reason.as_deref(),
            Some("preempted_high_priority")
        );
        assert_eq!(state.interrupted_event_count, 1);
        assert_eq!(state.interrupted_at_unix_ms, Some(1200));
        assert_eq!(state.question_attempt_count, 0);
        assert_eq!(state.review_log_count, 0);
        assert_eq!(state.integrity_check, "ok");
        assert_eq!(state.foreign_key_violation_count, 0);
    }

    #[test]
    fn reminder_latency_labels_are_unique_and_match_only_the_strong_alert_control() {
        let (first_title, first_accessible_name) = reminder_latency_fixture_labels();
        let (second_title, second_accessible_name) = reminder_latency_fixture_labels();

        assert_ne!(first_title, second_title);
        assert_ne!(first_accessible_name, second_accessible_name);
        assert_eq!(
            first_accessible_name,
            format!("事项提醒：{first_title}，打开今日任务")
        );
        assert!(first_title.starts_with("运行验收事项-"));
    }

    #[test]
    fn runtime_qa_accepts_only_reviewed_animation_and_webview_modes() {
        for invalid in ["", "reduced", "future"] {
            assert!(seed_animation_mode(invalid).is_err());
        }
        assert_eq!(runtime_qa_webview_arguments(None).unwrap(), None);
        assert_eq!(
            runtime_qa_webview_arguments(Some(OsStr::new("reduced-motion"))).unwrap(),
            Some("--force-prefers-reduced-motion")
        );
        assert_eq!(
            runtime_qa_webview_arguments(Some(OsStr::new("forced-colors"))).unwrap(),
            Some("--force-high-contrast --enable-blink-features=ForcedColors")
        );
        for invalid in ["", "high-contrast", "--force-high-contrast"] {
            assert!(runtime_qa_webview_arguments(Some(OsStr::new(invalid))).is_err());
        }
        assert!(!runtime_qa_panel_top_left(None).unwrap());
        assert!(!runtime_qa_panel_top_left(Some(OsStr::new("default"))).unwrap());
        assert!(runtime_qa_panel_top_left(Some(OsStr::new("work-area-top-left"))).unwrap());
        for invalid in ["", "top-left", "64,64"] {
            assert!(runtime_qa_panel_top_left(Some(OsStr::new(invalid))).is_err());
        }
    }
}
