use std::{
    ffi::OsStr,
    fs,
    path::{Path, PathBuf},
    time::Duration,
};

use chrono::{Duration as ChronoDuration, Local, Utc};
use serde::Serialize;
use tauri::{AppHandle, Runtime};

use crate::{
    error::{AppError, AppResult},
    models::CreateReminderInput,
    repository::Repository,
};

const ROOT_ENV: &str = "YUANYUAN_RUNTIME_QA_ROOT";
const EXIT_AFTER_ENV: &str = "YUANYUAN_RUNTIME_QA_EXIT_AFTER_SECONDS";
const PROFILE_ENV: &str = "YUANYUAN_RUNTIME_QA_PROFILE";
const ROOT_PREFIX: &str = "yuanyuan-runtime-qa-";
const MARKER_NAME: &str = ".yuanyuan-runtime-qa-v1";
const MARKER_CONTENT: &[u8] = b"YUANYUAN_RUNTIME_QA_V1\n";
const QA_IDENTIFIER: &str = "com.yuanyuan.reminder.runtime-qa";

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
            }
        }
    }
    Ok(())
}

pub fn create_windows(app: &mut tauri::App) -> Result<(), Box<dyn std::error::Error>> {
    let root = root_from_env()?;
    for config in app.config().app.windows.clone() {
        tauri::WebviewWindowBuilder::from_config(app.handle(), &config)?
            .data_directory(root.join("webview"))
            .build()?;
    }
    Ok(())
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

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum RuntimeQaProfile {
    TaskWatch,
    TaskFailureMotion,
    BaselineAiOff,
    ReminderLatency,
    Diagnostics,
}

fn parse_profile(value: Option<&OsStr>) -> AppResult<RuntimeQaProfile> {
    match value.and_then(OsStr::to_str) {
        None | Some("task-watch") => Ok(RuntimeQaProfile::TaskWatch),
        Some("task-failure-motion") => Ok(RuntimeQaProfile::TaskFailureMotion),
        Some("baseline-ai-off") => Ok(RuntimeQaProfile::BaselineAiOff),
        Some("reminder-latency") => Ok(RuntimeQaProfile::ReminderLatency),
        Some("diagnostics") => Ok(RuntimeQaProfile::Diagnostics),
        Some(_) => Err(AppError::Validation("runtime QA profile is invalid".into())),
    }
}

pub fn diagnostics_profile_active() -> bool {
    matches!(
        parse_profile(std::env::var_os(PROFILE_ENV).as_deref()),
        Ok(RuntimeQaProfile::Diagnostics)
    )
}

pub fn seed_animation_mode(animation_mode: &str) -> AppResult<()> {
    if !matches!(animation_mode, "always" | "off") {
        return Err(AppError::Validation(
            "runtime QA animation mode is invalid".into(),
        ));
    }
    let database = app_data_directory(QA_IDENTIFIER)?.join("yuanyuan-reminder.sqlite3");
    Repository::open(&database)?
        .update_settings(serde_json::json!({ "animationMode": animation_mode }))?;
    Ok(())
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
    let database = app_data_directory(QA_IDENTIFIER)?.join("yuanyuan-reminder.sqlite3");
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
    let database = app_data_directory(QA_IDENTIFIER)?.join("yuanyuan-reminder.sqlite3");
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
        assert!(parse_profile(Some(OsStr::new("production"))).is_err());
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
    fn task_failure_motion_accepts_only_reviewed_animation_modes() {
        for invalid in ["", "system", "reduced", "future"] {
            assert!(seed_animation_mode(invalid).is_err());
        }
    }
}
