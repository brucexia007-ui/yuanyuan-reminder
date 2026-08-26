use chrono::{Duration, Utc};
use serde_json::Value;
use tauri::{AppHandle, Emitter, Manager, State};
use tauri_plugin_autostart::ManagerExt;
#[cfg(windows)]
use tauri_plugin_dialog::DialogExt;
#[cfg(all(feature = "learning", windows))]
use tauri_plugin_dialog::FilePath;

use crate::{
    backups,
    error::{AppError, AppResult},
    models::{
        AppSettings, BackupInfo, CreateReminderInput, FocusState, PetCareSnapshot, PetIntent,
        PetInteractionStarted, Reminder, TodaySnapshot,
    },
    notifications,
    state::AppState,
    windows,
};

#[cfg(feature = "learning")]
async fn run_learning_background<T, F>(operation: &'static str, work: F) -> AppResult<T>
where
    T: Send + 'static,
    F: FnOnce() -> AppResult<T> + Send + 'static,
{
    let result = tauri::async_runtime::spawn_blocking(work)
        .await
        .map_err(|error| {
            AppError::Window(format!(
                "learning {operation} worker stopped unexpectedly: {error}"
            ))
        })?;
    result
}

#[cfg(all(feature = "learning", windows))]
async fn receive_learning_file_selection(
    receiver: tokio::sync::oneshot::Receiver<Option<FilePath>>,
    operation: &'static str,
) -> AppResult<Option<FilePath>> {
    receiver.await.map_err(|_| {
        AppError::Window(format!(
            "learning {operation} file dialog closed unexpectedly"
        ))
    })
}

#[cfg(all(feature = "learning", windows))]
fn learning_file_path(
    selected: FilePath,
    operation: &'static str,
) -> AppResult<std::path::PathBuf> {
    selected.into_path().map_err(|_| {
        AppError::Validation(format!(
            "learning {operation} selection is not a local file"
        ))
    })
}

#[cfg(all(test, feature = "learning", windows))]
mod learning_command_concurrency_tests {
    use super::*;

    #[test]
    fn cancelled_file_dialog_resolves_without_an_error() {
        let (sender, receiver) = tokio::sync::oneshot::channel();
        sender.send(None).unwrap();

        let selected =
            tauri::async_runtime::block_on(receive_learning_file_selection(receiver, "test"))
                .unwrap();

        assert!(selected.is_none());
    }

    #[test]
    fn learning_storage_work_runs_off_the_calling_thread() {
        let caller = std::thread::current().id();
        let worker = tauri::async_runtime::block_on(run_learning_background("test", || {
            Ok(std::thread::current().id())
        }))
        .unwrap();

        assert_ne!(worker, caller);
    }

    #[test]
    fn local_dialog_selection_is_preserved_as_a_path() {
        let expected = std::path::PathBuf::from(r"C:\Users\test\learning.csv");
        let actual = learning_file_path(FilePath::Path(expected.clone()), "test").unwrap();

        assert_eq!(actual, expected);
    }
}

#[tauri::command]
pub fn get_runtime_capabilities(state: State<'_, AppState>) -> crate::models::RuntimeCapabilities {
    state.runtime_capabilities()
}

#[cfg(all(feature = "learning", windows))]
#[tauri::command]
pub async fn preview_learning_import(
    app: AppHandle,
) -> AppResult<crate::learning::LearningImportPreview> {
    let mut picker = app
        .dialog()
        .file()
        .set_title("选择交给圆圆复习的词表或原生学习数据")
        .add_filter("圆圆学习数据", &["csv", "json"]);
    if let Some(panel) = app.get_webview_window("panel").as_ref() {
        picker = picker.set_parent(panel);
    }
    let (selection_tx, selection_rx) = tokio::sync::oneshot::channel();
    picker.pick_file(move |selected| {
        let _ = selection_tx.send(selected);
    });
    let Some(selected) = receive_learning_file_selection(selection_rx, "import").await? else {
        return Ok(crate::learning::LearningImportPreview::cancelled());
    };
    let path = learning_file_path(selected, "import")?;
    let worker_app = app.clone();
    run_learning_background("import preview", move || {
        let state = worker_app.state::<AppState>();
        let result = state
            .learning
            .lock()
            .preview_import_file(&path, Utc::now().timestamp_millis());
        result
    })
    .await
}

#[cfg(all(feature = "learning", not(windows)))]
#[tauri::command]
pub fn preview_learning_import(
    _app: AppHandle,
    _state: State<'_, AppState>,
) -> AppResult<crate::learning::LearningImportPreview> {
    Err(AppError::Validation(
        "native learning import is unavailable".into(),
    ))
}

#[cfg(feature = "learning")]
#[tauri::command]
pub async fn confirm_learning_import(
    preview_token: String,
    app: AppHandle,
) -> AppResult<crate::learning::ImportCommitResult> {
    run_learning_background("import confirmation", move || {
        let state = app.state::<AppState>();
        let result = state
            .learning
            .lock()
            .confirm_import(&preview_token, Utc::now().timestamp_millis());
        result
    })
    .await
}

#[cfg(feature = "learning")]
#[tauri::command]
pub async fn list_legacy_learning_sources(
    app: AppHandle,
) -> AppResult<Vec<crate::learning::LegacyLearningSourceSummary>> {
    run_learning_background("legacy learning discovery", move || {
        let state = app.state::<AppState>();
        let result = state.learning.lock().list_legacy_learning_sources();
        result
    })
    .await
}

#[cfg(feature = "learning")]
#[tauri::command]
pub async fn preview_legacy_learning_migration(
    edition: crate::learning::LegacyLearningEdition,
    app: AppHandle,
) -> AppResult<crate::learning::LegacyLearningMigrationPreview> {
    run_learning_background("legacy learning migration preview", move || {
        let state = app.state::<AppState>();
        let result = state
            .learning
            .lock()
            .preview_legacy_learning_migration(edition, Utc::now().timestamp_millis());
        result
    })
    .await
}

#[cfg(feature = "learning")]
#[tauri::command]
pub async fn confirm_legacy_learning_migration(
    preview_token: String,
    app: AppHandle,
) -> AppResult<crate::learning::LegacyLearningMigrationResult> {
    run_learning_background("legacy learning migration confirmation", move || {
        let state = app.state::<AppState>();
        let result = state
            .learning
            .lock()
            .confirm_legacy_learning_migration(&preview_token, Utc::now().timestamp_millis());
        result
    })
    .await
}

#[cfg(feature = "learning")]
#[tauri::command]
pub fn get_learning_home(
    state: State<'_, AppState>,
) -> AppResult<crate::learning::LearningHomeSnapshot> {
    state.learning.lock().home(Utc::now().timestamp_millis())
}

#[cfg(feature = "learning")]
#[tauri::command]
pub fn get_learning_dashboard(
    state: State<'_, AppState>,
) -> AppResult<crate::learning::LearningDashboardSnapshot> {
    state
        .learning
        .lock()
        .dashboard(Utc::now().timestamp_millis())
}

#[cfg(feature = "learning")]
#[tauri::command]
pub fn update_learning_settings(
    patch: crate::learning::LearningSettingsPatch,
    state: State<'_, AppState>,
) -> AppResult<crate::learning::LearningSettings> {
    state
        .learning
        .lock()
        .update_settings(patch, Utc::now().timestamp_millis())
}

#[cfg(feature = "learning")]
#[tauri::command]
pub fn start_manual_learning_session(
    app: AppHandle,
    card_count: u8,
    session_kind: crate::learning::LearningSessionKind,
    source_session_id: Option<String>,
    state: State<'_, AppState>,
) -> AppResult<crate::learning::LearningSessionSnapshot> {
    let now_unix_ms = Utc::now().timestamp_millis();
    let session = state.learning.lock().start_manual_session(
        card_count,
        session_kind,
        source_session_id.as_deref(),
        now_unix_ms,
    )?;
    #[cfg(windows)]
    if let Err(error) =
        crate::companion_runtime::set_learning_session_active(&app, true, Some(&session.session_id))
    {
        return Err(error);
    }
    let session = state.learning.lock().present_session(
        &session.session_id,
        session.state_revision,
        Utc::now().timestamp_millis(),
    )?;
    let _ = app.emit("learning-session-updated", &session);
    Ok(session)
}

#[cfg(feature = "learning")]
#[tauri::command]
pub fn get_learning_session_summary(
    session_id: String,
    state: State<'_, AppState>,
) -> AppResult<crate::learning::LearningSessionSummary> {
    state
        .learning
        .lock()
        .session_summary(&session_id, Utc::now().timestamp_millis())
}

#[cfg(feature = "learning")]
#[tauri::command]
pub fn get_current_learning_card(
    session_id: String,
    state: State<'_, AppState>,
) -> AppResult<crate::learning::LearningCardDto> {
    state.learning.lock().current_card(&session_id)
}

#[cfg(feature = "learning")]
#[tauri::command]
pub fn get_current_learning_question(
    session_id: String,
    state: State<'_, AppState>,
) -> AppResult<crate::learning::LearningQuestionDto> {
    state.learning.lock().current_question(&session_id)
}

#[cfg(feature = "learning")]
#[tauri::command]
pub fn answer_learning_question(
    _app: AppHandle,
    session_id: String,
    question_id: String,
    selected_option_id: String,
    client_answer_id: String,
    response_ms: Option<u32>,
    state: State<'_, AppState>,
) -> AppResult<crate::learning::LearningAnswerResult> {
    let result = state.learning.lock().answer_question(
        &session_id,
        &question_id,
        &selected_option_id,
        &client_answer_id,
        response_ms,
        Utc::now().timestamp_millis(),
    )?;
    Ok(result)
}

#[cfg(feature = "learning")]
#[tauri::command]
pub fn rate_learning_card(
    _app: AppHandle,
    session_id: String,
    card_id: String,
    rating: crate::learning::LearningRating,
    expected_revision: u64,
    state: State<'_, AppState>,
) -> AppResult<crate::learning::LearningRateResult> {
    let result = state.learning.lock().rate_card(
        &session_id,
        &card_id,
        rating,
        expected_revision,
        Utc::now().timestamp_millis(),
    )?;
    Ok(result)
}

#[cfg(feature = "learning")]
#[tauri::command]
pub fn finish_learning_session(
    app: AppHandle,
    session_id: String,
    exit_reason: String,
    expected_revision: u64,
    state: State<'_, AppState>,
) -> AppResult<crate::learning::LearningSessionSnapshot> {
    let session = if exit_reason == "completed" {
        state
            .learning
            .lock()
            .completed_session(&session_id, expected_revision)?
    } else {
        state.learning.lock().abandon_session(
            &session_id,
            expected_revision,
            &exit_reason,
            Utc::now().timestamp_millis(),
        )?
    };
    #[cfg(windows)]
    if let Err(error) =
        crate::companion_runtime::set_learning_session_active(&app, false, Some(&session_id))
    {
        tracing::warn!(error = %error, "learning session pet expression could not be cleared");
    }
    Ok(session)
}

#[cfg(feature = "learning")]
#[tauri::command]
pub fn get_resumable_learning_session(
    state: State<'_, AppState>,
) -> AppResult<Option<crate::learning::LearningSessionSnapshot>> {
    state
        .learning
        .lock()
        .resumable_session(Utc::now().timestamp_millis())
}

#[cfg(feature = "learning")]
#[tauri::command]
pub fn pause_learning_session(
    app: AppHandle,
    session_id: String,
    expected_revision: u64,
    reason: String,
    state: State<'_, AppState>,
) -> AppResult<crate::learning::LearningSessionSnapshot> {
    let session = state.learning.lock().pause_session(
        &session_id,
        expected_revision,
        &reason,
        Utc::now().timestamp_millis(),
    )?;
    #[cfg(windows)]
    if let Err(error) =
        crate::companion_runtime::set_learning_session_active(&app, false, Some(&session_id))
    {
        tracing::warn!(error = %error, "paused learning presentation could not be released");
    }
    let _ = app.emit("learning-session-paused", &session);
    Ok(session)
}

#[cfg(feature = "learning")]
#[tauri::command]
pub fn resume_learning_session(
    app: AppHandle,
    session_id: String,
    expected_revision: u64,
    state: State<'_, AppState>,
) -> AppResult<crate::learning::LearningSessionSnapshot> {
    #[cfg(windows)]
    crate::companion_runtime::set_learning_session_active(&app, true, Some(&session_id))?;
    let result = state.learning.lock().resume_session(
        &session_id,
        expected_revision,
        Utc::now().timestamp_millis(),
    );
    if result.is_err() {
        #[cfg(windows)]
        let _ =
            crate::companion_runtime::set_learning_session_active(&app, false, Some(&session_id));
    }
    let session = result?;
    let _ = app.emit("learning-session-updated", &session);
    Ok(session)
}

#[cfg(feature = "learning")]
#[tauri::command]
pub fn abandon_learning_session(
    app: AppHandle,
    session_id: String,
    expected_revision: u64,
    state: State<'_, AppState>,
) -> AppResult<crate::learning::LearningSessionSnapshot> {
    let session = state.learning.lock().abandon_session(
        &session_id,
        expected_revision,
        "user_exit",
        Utc::now().timestamp_millis(),
    )?;
    #[cfg(windows)]
    if let Err(error) =
        crate::companion_runtime::set_learning_session_active(&app, false, Some(&session_id))
    {
        tracing::warn!(error = %error, "abandoned learning presentation could not be released");
    }
    let _ = app.emit("learning-session-abandoned", &session);
    Ok(session)
}

#[cfg(feature = "learning")]
#[tauri::command]
pub fn get_pending_learning_invitation(
    state: State<'_, AppState>,
) -> Option<crate::learning::LearningInvitationDto> {
    state.learning.lock().pending_invitation()
}

#[cfg(feature = "learning")]
#[tauri::command]
pub fn accept_learning_invitation(
    app: AppHandle,
    invitation_id: String,
    state: State<'_, AppState>,
) -> AppResult<crate::learning::LearningSessionSnapshot> {
    let _gate = state.learning_invitation_gate.lock();
    let now_unix_ms = Utc::now().timestamp_millis();
    let session = state
        .learning
        .lock()
        .accept_invitation(&invitation_id, now_unix_ms)?;
    #[cfg(windows)]
    if let Err(error) = crate::companion_runtime::transition_learning_invitation_to_session(
        &app,
        &session.session_id,
    ) {
        return Err(error);
    }
    let session = state.learning.lock().present_session(
        &session.session_id,
        session.state_revision,
        Utc::now().timestamp_millis(),
    )?;
    let _ = app.emit("learning-session-updated", &session);
    Ok(session)
}

#[cfg(feature = "learning")]
#[tauri::command]
pub fn dismiss_learning_invitation(app: AppHandle, invitation_id: String) -> AppResult<bool> {
    #[cfg(windows)]
    {
        crate::companion_runtime::withdraw_learning_invitation(
            &app,
            &invitation_id,
            "dismissed",
            Utc::now().timestamp_millis(),
        )
    }
    #[cfg(not(windows))]
    {
        let _ = (app, invitation_id);
        Ok(false)
    }
}

#[cfg(feature = "learning")]
#[tauri::command]
pub fn pause_learning_invites_today(
    app: AppHandle,
    state: State<'_, AppState>,
) -> AppResult<crate::learning::LearningSettings> {
    let now = Utc::now();
    let local_day = now
        .with_timezone(&chrono::Local)
        .format("%Y-%m-%d")
        .to_string();
    let pending = state.learning.lock().pending_invitation();
    let settings = state
        .learning
        .lock()
        .pause_invitations_today(&local_day, now.timestamp_millis())?;
    #[cfg(windows)]
    if let Some(pending) = pending {
        let _ = crate::companion_runtime::withdraw_learning_invitation(
            &app,
            &pending.invitation_id,
            "dismissed",
            now.timestamp_millis(),
        );
    }
    Ok(settings)
}

#[cfg(feature = "learning")]
#[tauri::command]
pub fn get_learning_data_summary(
    state: State<'_, AppState>,
) -> AppResult<crate::learning::LearningDataSummary> {
    state.learning.lock().data_summary()
}

#[cfg(feature = "learning")]
#[tauri::command]
pub fn list_learning_records(
    filter: crate::learning::LearningRecordFilter,
    query: String,
    page: u32,
    page_size: u8,
    state: State<'_, AppState>,
) -> AppResult<crate::learning::LearningRecordPage> {
    state
        .learning
        .lock()
        .list_records(filter, &query, page, page_size)
}

#[cfg(all(feature = "learning", windows))]
#[tauri::command]
pub async fn export_learning_data(
    app: AppHandle,
    format: crate::learning::LearningExportFormat,
) -> AppResult<crate::learning::LearningExportResult> {
    let date = Utc::now().with_timezone(&chrono::Local).format("%Y-%m-%d");
    let default_name = match format {
        crate::learning::LearningExportFormat::NativeJson => {
            format!("yuanyuan-learning-{date}.json")
        }
        crate::learning::LearningExportFormat::CardsCsv => {
            format!("yuanyuan-learning-cards-{date}.csv")
        }
        crate::learning::LearningExportFormat::ReviewLogsCsv => {
            format!("yuanyuan-learning-reviews-{date}.csv")
        }
    };
    let filter_name = match format {
        crate::learning::LearningExportFormat::NativeJson => "圆圆原生学习数据",
        crate::learning::LearningExportFormat::CardsCsv => "学习卡片表格",
        crate::learning::LearningExportFormat::ReviewLogsCsv => "复习记录表格",
    };
    let mut picker = app
        .dialog()
        .file()
        .set_title("选择本机导出位置（不会覆盖已有文件）")
        .set_file_name(default_name)
        .add_filter(filter_name, &[format.extension()]);
    if let Some(panel) = app.get_webview_window("panel").as_ref() {
        picker = picker.set_parent(panel);
    }
    let (selection_tx, selection_rx) = tokio::sync::oneshot::channel();
    picker.save_file(move |selected| {
        let _ = selection_tx.send(selected);
    });
    let Some(selected) = receive_learning_file_selection(selection_rx, "export").await? else {
        return Ok(crate::learning::LearningExportResult::cancelled(format));
    };
    let path = learning_file_path(selected, "export")?;
    if !path
        .extension()
        .and_then(|value| value.to_str())
        .is_some_and(|value| value.eq_ignore_ascii_case(format.extension()))
    {
        return Err(AppError::Validation(
            "learning export file extension does not match the selected format".into(),
        ));
    }
    let worker_app = app.clone();
    let result = run_learning_background("data export", move || {
        let now = Utc::now();
        let state = worker_app.state::<AppState>();
        let payload = state
            .learning
            .lock()
            .export_payload(format, now.timestamp_millis())?;
        crate::learning::write_new_file_atomically(&path, &payload.bytes)?;
        if let Err(error) = state
            .learning
            .lock()
            .mark_export_succeeded(now.timestamp_millis())
        {
            tracing::warn!(error = %error, "learning export metadata could not be updated");
        }
        Ok(crate::learning::LearningExportResult {
            schema_version: 1,
            status: "saved",
            format,
            record_count: payload.record_count,
            bytes: payload.bytes.len() as u64,
            exported_at_unix_ms: Some(now.timestamp_millis()),
            selected_path_returned: false,
        })
    })
    .await?;
    let _ = app.emit("learning-data-updated", ());
    Ok(result)
}

#[cfg(all(feature = "learning", not(windows)))]
#[tauri::command]
pub fn export_learning_data(
    app: AppHandle,
    format: crate::learning::LearningExportFormat,
    state: State<'_, AppState>,
) -> AppResult<crate::learning::LearningExportResult> {
    let _ = (app, format, state);
    Err(AppError::Validation(
        "native learning export is unavailable".into(),
    ))
}

#[cfg(feature = "learning")]
#[tauri::command]
pub async fn delete_learning_data(
    app: AppHandle,
    scope: crate::learning::LearningDeleteScope,
    confirmation: String,
) -> AppResult<crate::learning::LearningDeleteResult> {
    let worker_app = app.clone();
    let result = run_learning_background("data deletion", move || {
        #[cfg(windows)]
        crate::companion_runtime::preempt_learning_for_high_priority(
            &worker_app,
            "learning_data_deleted",
            Utc::now().timestamp_millis(),
        )?;
        let state = worker_app.state::<AppState>();
        let result =
            state
                .learning
                .lock()
                .delete_data(scope, &confirmation, Utc::now().timestamp_millis());
        result
    })
    .await?;
    let _ = app.emit("learning-data-updated", ());
    Ok(result)
}

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
pub fn create_reminder(
    app: AppHandle,
    input: CreateReminderInput,
    state: State<'_, AppState>,
) -> AppResult<Reminder> {
    let reminder = state.repository.lock().create_reminder(input)?;
    app.emit("reminders-updated", ())
        .map_err(|error| AppError::Window(error.to_string()))?;
    Ok(reminder)
}

#[tauri::command]
pub fn update_reminder(
    app: AppHandle,
    id: String,
    input: CreateReminderInput,
    state: State<'_, AppState>,
) -> AppResult<Reminder> {
    let reminder = state.repository.lock().update_reminder(&id, input)?;
    emit_reminder_management_update(&app)?;
    Ok(reminder)
}

#[tauri::command]
pub fn set_reminder_enabled(
    app: AppHandle,
    id: String,
    enabled: bool,
    state: State<'_, AppState>,
) -> AppResult<Reminder> {
    let reminder = state.repository.lock().set_reminder_enabled(&id, enabled)?;
    emit_reminder_management_update(&app)?;
    Ok(reminder)
}

#[tauri::command]
pub fn delete_reminder(app: AppHandle, id: String, state: State<'_, AppState>) -> AppResult<()> {
    state.repository.lock().archive_reminder(&id)?;
    emit_reminder_management_update(&app)
}

#[tauri::command]
pub fn list_backups(app: AppHandle) -> AppResult<Vec<BackupInfo>> {
    backups::list_backups(&backup_directory(&app)?)
}

#[tauri::command]
pub fn create_backup(app: AppHandle, state: State<'_, AppState>) -> AppResult<BackupInfo> {
    let backup_dir = backup_directory(&app)?;
    #[cfg(feature = "learning")]
    let backup = {
        let repository = state.repository.lock();
        let learning = state.learning.lock();
        backups::create_unified_manual_backup(&repository, &learning, &backup_dir)?
    };
    #[cfg(not(feature = "learning"))]
    let backup = backups::create_manual_backup(&state.repository.lock(), &backup_dir)?;
    app.emit("backups-updated", &backup)
        .map_err(|error| AppError::Window(error.to_string()))?;
    Ok(backup)
}

#[tauri::command]
pub fn restore_backup(
    app: AppHandle,
    file_name: String,
    state: State<'_, AppState>,
) -> AppResult<()> {
    let (mut settings, activity_active_seconds, focus_state, pet_care) = {
        let mut repository = state.repository.lock();
        let backup_dir = backup_directory(&app)?;
        #[cfg(feature = "learning")]
        {
            let mut learning = state.learning.lock();
            backups::restore_unified_backup(
                &mut repository,
                &mut learning,
                &backup_dir,
                &file_name,
            )?;
        }
        #[cfg(not(feature = "learning"))]
        backups::restore_backup(&mut repository, &backup_dir, &file_name)?;
        (
            repository.get_settings()?,
            repository.activity_active_seconds()?,
            repository.get_focus_state()?,
            repository.get_pet_care()?,
        )
    };
    sync_autostart(&app, settings.autostart)?;
    windows::apply_settings(&app, &mut settings)?;
    state.repository.lock().save_settings(&settings)?;
    state
        .activity_tracker
        .lock()
        .replace_active_seconds(activity_active_seconds);
    app.emit("settings-updated", &settings)
        .map_err(|error| AppError::Window(error.to_string()))?;
    app.emit("focus-updated", &focus_state)
        .map_err(|error| AppError::Window(error.to_string()))?;
    #[cfg(windows)]
    crate::companion_runtime::set_focus_active(
        &app,
        focus_state
            .session
            .as_ref()
            .is_some_and(|session| session.phase == "focus"),
    )?;
    #[cfg(windows)]
    crate::companion_runtime::sync_local_occurrences(&app)?;
    app.emit("pet-care-updated", &pet_care)
        .map_err(|error| AppError::Window(error.to_string()))?;
    for event in ["reminders-updated", "occurrence-updated", "backups-updated"] {
        app.emit(event, ())
            .map_err(|error| AppError::Window(error.to_string()))?;
    }
    Ok(())
}

fn backup_directory(app: &AppHandle) -> AppResult<std::path::PathBuf> {
    Ok(app
        .path()
        .app_local_data_dir()
        .map_err(|error| AppError::Window(error.to_string()))?
        .join("backups"))
}

fn emit_reminder_management_update(app: &AppHandle) -> AppResult<()> {
    app.emit("reminders-updated", ())
        .map_err(|error| AppError::Window(error.to_string()))?;
    app.emit("occurrence-updated", ())
        .map_err(|error| AppError::Window(error.to_string()))
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
    #[cfg(windows)]
    crate::companion_runtime::sync_local_occurrences(&app)?;
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
    #[cfg(windows)]
    crate::companion_runtime::sync_local_occurrences(&app)?;
    app.emit("occurrence-updated", ())
        .map_err(|error| AppError::Window(error.to_string()))?;
    app.emit(
        "pet-intent",
        PetIntent::motion_only("snoozed", 110, "waiting", "today", Some(id), 7),
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
    #[cfg(windows)]
    crate::companion_runtime::sync_local_occurrences(&app)?;
    app.emit("occurrence-updated", ())
        .map_err(|error| AppError::Window(error.to_string()))?;
    app.emit(
        "pet-intent",
        PetIntent::motion_only("skipped", 110, "review", "today", Some(id), 7),
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
    #[cfg(windows)]
    crate::companion_runtime::sync_local_occurrences(app)?;
    app.emit("occurrence-updated", ())
        .map_err(|error| AppError::Window(error.to_string()))?;
    app.emit(
        "pet-intent",
        PetIntent::motion_only("success", 110, "jumping", "today", None, 7),
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
pub fn get_basic_support_state(
    state: State<'_, AppState>,
) -> Option<crate::models::BasicSupportSession> {
    state.basic_support.lock().clone()
}

#[tauri::command]
pub fn start_basic_support(
    app: AppHandle,
    path: String,
    duration_minutes: u32,
) -> AppResult<crate::models::BasicSupportSession> {
    #[cfg(windows)]
    {
        crate::companion_runtime::start_basic_support(&app, &path, duration_minutes)
    }
    #[cfg(not(windows))]
    {
        let _ = (app, path, duration_minutes);
        Err(AppError::Validation(
            "basic companion support is unavailable".into(),
        ))
    }
}

#[tauri::command]
pub fn stop_basic_support(app: AppHandle) -> AppResult<bool> {
    #[cfg(windows)]
    {
        crate::companion_runtime::stop_basic_support(&app)
    }
    #[cfg(not(windows))]
    {
        let _ = app;
        Ok(false)
    }
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
    #[cfg(windows)]
    crate::companion_runtime::stop_basic_support(&app)?;
    let snapshot = state.repository.lock().record_pet_interaction(&kind)?;
    let (animation, seconds, interactive) = match kind.as_str() {
        "food" => ("eating-food", 8, false),
        "water" => ("drinking-water", 8, false),
        "treat" => ("treat-follow", 14, true),
        "wand" => ("wand-reach", 14, true),
        "pet" => ("pet-nuzzle", 14, true),
        "ball" => ("idle", 18, true),
        _ => return Err(AppError::Validation("unsupported pet interaction".into())),
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
            PetIntent::motion_only("care", 45, animation, "care", None, seconds),
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
    #[cfg(windows)]
    crate::companion_runtime::stop_basic_support(&app)?;
    let focus_state = state
        .repository
        .lock()
        .start_focus(&phase, duration_minutes)?;
    app.emit("focus-updated", &focus_state)
        .map_err(|error| AppError::Window(error.to_string()))?;
    #[cfg(windows)]
    crate::companion_runtime::set_focus_active(&app, phase == "focus")?;
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
    #[cfg(windows)]
    crate::companion_runtime::set_focus_active(&app, false)?;
    Ok(focus_state)
}

#[tauri::command]
pub fn get_settings(state: State<'_, AppState>) -> AppResult<AppSettings> {
    state.repository.lock().get_settings()
}

#[tauri::command]
pub fn get_pet_activity_snapshot(
    app: AppHandle,
) -> crate::presentation_arbiter::PetActivitySnapshot {
    crate::presentation_runtime::snapshot(&app)
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
    #[cfg(windows)]
    crate::companion_runtime::set_reduce_motion(&app, settings.animation_mode == "off")?;
    Ok(settings)
}

#[tauri::command]
pub fn show_task_panel(app: AppHandle, route: Option<String>) -> AppResult<()> {
    windows::show_task_panel(&app, route.as_deref().unwrap_or("today"))
}

#[tauri::command]
pub fn show_pet_window(app: AppHandle) -> AppResult<()> {
    show_pet_window_inner(&app)
}

pub fn show_pet_window_inner(app: &AppHandle) -> AppResult<()> {
    let pet = app
        .get_webview_window("pet")
        .ok_or_else(|| AppError::Window("pet window is unavailable".into()))?;
    pet.show()
        .map_err(|error| AppError::Window(error.to_string()))
}

#[tauri::command]
pub fn hide_pet_window(app: AppHandle) -> AppResult<()> {
    hide_pet_window_inner(&app)
}

pub fn hide_pet_window_inner(app: &AppHandle) -> AppResult<()> {
    let pet = app
        .get_webview_window("pet")
        .ok_or_else(|| AppError::Window("pet window is unavailable".into()))?;
    windows::show_task_panel(app, "settings")?;
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

pub fn set_learning_quick_start_visible_inner(app: &AppHandle, visible: bool) -> AppResult<()> {
    let state = app.state::<AppState>();
    let mut settings = state.repository.lock().get_settings()?;
    settings.learning_quick_start_visible = visible;
    state.repository.lock().save_settings(&settings)?;
    app.emit("settings-updated", &settings)
        .map_err(|error| AppError::Window(error.to_string()))
}

#[tauri::command]
pub fn request_sleep(app: AppHandle) -> AppResult<()> {
    request_sleep_inner(&app)
}

pub fn request_sleep_inner(app: &AppHandle) -> AppResult<()> {
    let state = app.state::<AppState>();
    state.clear_automatic_sleep_reunion();
    #[cfg(windows)]
    crate::companion_runtime::set_sleeping(
        &app,
        true,
        crate::presentation_arbiter::PetActivitySource::Manual,
    )?;
    #[cfg(not(windows))]
    crate::presentation_runtime::set_sleeping(
        app,
        true,
        crate::presentation_arbiter::PetActivitySource::Manual,
    )?;
    state
        .manual_sleep_active
        .store(true, std::sync::atomic::Ordering::SeqCst);
    app.emit(
        "pet-request-sleep",
        serde_json::json!({ "source": "manual" }),
    )
    .map_err(|error| AppError::Window(error.to_string()))
}

#[tauri::command]
pub fn request_wake(app: AppHandle) -> AppResult<()> {
    request_wake_inner(&app)
}

pub fn request_wake_inner(app: &AppHandle) -> AppResult<()> {
    let state = app.state::<AppState>();
    state.clear_automatic_sleep_reunion();
    #[cfg(windows)]
    crate::companion_runtime::set_sleeping(
        &app,
        false,
        crate::presentation_arbiter::PetActivitySource::Manual,
    )?;
    #[cfg(not(windows))]
    crate::presentation_runtime::set_sleeping(
        app,
        false,
        crate::presentation_arbiter::PetActivitySource::Manual,
    )?;
    state
        .manual_sleep_active
        .store(false, std::sync::atomic::Ordering::SeqCst);
    app.emit("pet-request-wake", ())
        .map_err(|error| AppError::Window(error.to_string()))
}

pub fn pet_is_sleeping(app: &AppHandle) -> bool {
    let snapshot = crate::presentation_runtime::snapshot(app);
    snapshot.activity == crate::presentation_arbiter::PetActivity::Sleeping
        || snapshot.restore_target == Some(crate::presentation_arbiter::PetRestoreTarget::Sleeping)
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PetSleepToggleAction {
    Sleep,
    Wake,
}

pub fn pet_sleep_toggle_action(app: &AppHandle) -> PetSleepToggleAction {
    sleep_toggle_action(pet_is_sleeping(app))
}

fn sleep_toggle_action(sleeping: bool) -> PetSleepToggleAction {
    if sleeping {
        PetSleepToggleAction::Wake
    } else {
        PetSleepToggleAction::Sleep
    }
}

#[cfg(test)]
mod sleep_state_tests {
    use super::{sleep_toggle_action, PetSleepToggleAction};

    #[test]
    fn repeated_context_menu_action_wakes_an_already_sleeping_pet() {
        assert_eq!(sleep_toggle_action(false), PetSleepToggleAction::Sleep);
        assert_eq!(sleep_toggle_action(true), PetSleepToggleAction::Wake);
    }
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
    #[cfg(windows)]
    crate::companion_runtime::set_quiet_active(app, true)?;
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

#[cfg(windows)]
#[tauri::command]
pub fn delete_all_local_data_and_exit(
    app: AppHandle,
    confirmation: String,
    understands_no_recovery: bool,
) -> AppResult<()> {
    crate::local_data_cleanup::validate_delete_request(&confirmation, understands_no_recovery)?;
    sync_autostart(&app, false)?;
    crate::local_data_cleanup::schedule_after_exit(&app.config().identifier)?;
    quit_inner(&app);
    Ok(())
}

#[cfg(not(windows))]
#[tauri::command]
pub fn delete_all_local_data_and_exit(
    _app: AppHandle,
    _confirmation: String,
    _understands_no_recovery: bool,
) -> AppResult<()> {
    Err(AppError::Validation(
        "local data deletion is available only on Windows".into(),
    ))
}

#[cfg(windows)]
#[tauri::command]
pub fn get_ai_supervisor_status(app: AppHandle) -> String {
    app.state::<crate::ai_supervisor::AiSupervisor>()
        .status()
        .as_str()
        .to_owned()
}

#[cfg(not(windows))]
#[tauri::command]
pub fn get_ai_supervisor_status(_app: AppHandle) -> String {
    "unavailable".to_owned()
}

#[cfg(windows)]
#[tauri::command]
pub fn get_companion_expression_snapshot(
    app: AppHandle,
) -> crate::companion_core::CompanionExpressionSnapshot {
    crate::companion_runtime::snapshot(&app)
}

#[cfg(windows)]
#[tauri::command]
pub fn get_task_watch_snapshot(
    state: State<'_, AppState>,
) -> AppResult<crate::companion_runtime::TaskWatchSnapshot> {
    let now_unix_ms = chrono::Utc::now().timestamp_millis();
    let deferrals = state
        .repository
        .lock()
        .list_task_watch_attention_deferrals(now_unix_ms)?;
    crate::companion_runtime::read_task_watch_snapshot(now_unix_ms, &deferrals)
}

#[cfg(windows)]
#[tauri::command]
pub fn defer_task_watch_attention(
    app: AppHandle,
    source: String,
    state: String,
    minutes: u32,
) -> AppResult<crate::companion_runtime::TaskWatchSnapshot> {
    crate::companion_runtime::defer_task_watch_attention(
        &app,
        &source,
        &state,
        minutes,
        chrono::Utc::now().timestamp_millis(),
    )
}

#[cfg(windows)]
#[tauri::command]
pub fn resume_task_watch_attention(
    app: AppHandle,
    source: String,
    state: String,
) -> AppResult<crate::companion_runtime::TaskWatchSnapshot> {
    crate::companion_runtime::resume_task_watch_attention(
        &app,
        &source,
        &state,
        chrono::Utc::now().timestamp_millis(),
    )
}

#[cfg(not(windows))]
#[tauri::command]
pub fn get_companion_expression_snapshot(_app: AppHandle) -> serde_json::Value {
    serde_json::json!({
        "schemaVersion": 1,
        "revision": 0,
        "tier": "n0",
        "intent": "quiet_presence",
        "pose": "idle",
        "props": [],
        "label": null,
        "attention": "silent",
        "motion": "full",
        "movePropForward": false,
        "queueInBasket": false,
        "taskSource": null,
        "groupedCount": 1,
        "focusDeferredCount": 0,
        "accessibleState": "quiet_presence"
    })
}

#[cfg(not(windows))]
#[tauri::command]
pub fn get_task_watch_snapshot() -> serde_json::Value {
    serde_json::json!({
        "schemaVersion": 2,
        "available": false,
        "observedCount": 0,
        "needsUserCount": 0,
        "states": []
    })
}

#[cfg(not(windows))]
#[tauri::command]
pub fn defer_task_watch_attention(
    _source: String,
    _state: String,
    _minutes: u32,
) -> AppResult<serde_json::Value> {
    Err(AppError::Validation(
        "task watch attention is unavailable".into(),
    ))
}

#[cfg(not(windows))]
#[tauri::command]
pub fn resume_task_watch_attention(
    _source: String,
    _state: String,
) -> AppResult<serde_json::Value> {
    Err(AppError::Validation(
        "task watch attention is unavailable".into(),
    ))
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AiSupervisorDiagnostics {
    status: String,
    binary_present: bool,
    local_diagnostics_present: bool,
    can_retry: bool,
    control_protocol_version: u16,
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DiagnosticExportResult {
    status: String,
    file_name: Option<String>,
    bytes: u64,
    schema_version: u16,
    sensitive_fields_included: bool,
    sensitive_scan_status: String,
    sensitive_scan_version: u16,
    sensitive_scan_checks: u8,
    selected_path_returned: bool,
    internal_copy_created: bool,
    automatic_upload: bool,
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DiagnosticPreviewResult {
    schema_version: u16,
    estimated_bytes: u64,
    export_file_count: u8,
    pending_files: u32,
    pending_bytes: u64,
    quarantined_files: u32,
    diagnostic_code_categories: u8,
    diagnostic_occurrences: u64,
    sensitive_fields_included: bool,
    sensitive_scan_status: String,
    sensitive_scan_version: u16,
    sensitive_scan_checks: u8,
    selected_location_required: bool,
    internal_copy_created: bool,
    automatic_upload: bool,
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DiagnosticClearResult {
    removed_snapshot_files: u8,
    removed_counter_files: u8,
}

#[cfg(windows)]
#[tauri::command]
pub fn get_ai_supervisor_diagnostics(app: AppHandle) -> AiSupervisorDiagnostics {
    #[cfg(feature = "runtime-qa")]
    if crate::runtime_qa::diagnostics_profile_active() {
        return AiSupervisorDiagnostics {
            status: "circuit_open".to_owned(),
            binary_present: true,
            local_diagnostics_present: false,
            can_retry: true,
            control_protocol_version: yuanyuan_ai::AI_CONTROL_PROTOCOL_VERSION,
        };
    }
    let supervisor = app.state::<crate::ai_supervisor::AiSupervisor>();
    let status = supervisor.status();
    AiSupervisorDiagnostics {
        status: status.as_str().to_owned(),
        binary_present: supervisor.binary_present(),
        local_diagnostics_present: local_diagnostics_present(),
        can_retry: status == crate::ai_supervisor::AiSupervisorStatus::CircuitOpen,
        control_protocol_version: yuanyuan_ai::AI_CONTROL_PROTOCOL_VERSION,
    }
}

#[cfg(not(windows))]
#[tauri::command]
pub fn get_ai_supervisor_diagnostics(_app: AppHandle) -> AiSupervisorDiagnostics {
    AiSupervisorDiagnostics {
        status: "unavailable".to_owned(),
        binary_present: false,
        local_diagnostics_present: false,
        can_retry: false,
        control_protocol_version: 1,
    }
}

#[cfg(windows)]
fn build_ai_diagnostic_snapshot(
    status: crate::ai_supervisor::AiSupervisorStatus,
    binary_present: bool,
    usage: yuanyuan_bridge::SpoolUsage,
    bridge_diagnostics: Vec<yuanyuan_bridge::DiagnosticCount>,
    generated_at_unix_ms: i64,
) -> yuanyuan_bridge::DiagnosticSnapshotV1 {
    use crate::ai_supervisor::AiSupervisorStatus;
    use yuanyuan_bridge::{
        DiagnosticAiStatus, DiagnosticQueueSummary, DiagnosticSnapshotV1,
        DIAGNOSTIC_SNAPSHOT_SCHEMA_VERSION,
    };

    let ai_status = if !binary_present {
        DiagnosticAiStatus::NotInstalled
    } else {
        match status {
            AiSupervisorStatus::Unavailable => DiagnosticAiStatus::Unavailable,
            AiSupervisorStatus::Starting => DiagnosticAiStatus::Starting,
            AiSupervisorStatus::Running => DiagnosticAiStatus::Running,
            AiSupervisorStatus::BackingOff => DiagnosticAiStatus::BackingOff,
            AiSupervisorStatus::CircuitOpen => DiagnosticAiStatus::CircuitOpen,
            AiSupervisorStatus::Stopped => DiagnosticAiStatus::Stopped,
        }
    };
    DiagnosticSnapshotV1 {
        schema_version: DIAGNOSTIC_SNAPSHOT_SCHEMA_VERSION,
        generated_at_unix_ms,
        core_version: env!("CARGO_PKG_VERSION").to_owned(),
        task_event_protocol_version: yuanyuan_protocol::TASK_EVENT_PROTOCOL_VERSION,
        control_protocol_version: yuanyuan_ai::AI_CONTROL_PROTOCOL_VERSION,
        ai_status,
        bridge_diagnostics,
        queue: DiagnosticQueueSummary {
            pending_files: usage.pending_files,
            pending_bytes: usage.pending_bytes,
            quarantined_files: usage.quarantined_files,
        },
    }
}

#[cfg(all(windows, feature = "runtime-qa"))]
fn build_runtime_qa_diagnostic_snapshot() -> Result<yuanyuan_bridge::DiagnosticSnapshotV1, AppError>
{
    use std::time::{SystemTime, UNIX_EPOCH};

    let generated_at_unix_ms = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .ok()
        .and_then(|duration| i64::try_from(duration.as_millis()).ok())
        .ok_or_else(generic_diagnostic_error)?;
    Ok(build_ai_diagnostic_snapshot(
        crate::ai_supervisor::AiSupervisorStatus::CircuitOpen,
        true,
        yuanyuan_bridge::SpoolUsage {
            pending_files: 3,
            pending_bytes: 12_480,
            quarantined_files: 1,
            quarantined_bytes: 0,
        },
        vec![
            yuanyuan_bridge::DiagnosticCount {
                code: yuanyuan_bridge::BridgeDiagnosticCode::QueueFull,
                count: 1,
            },
            yuanyuan_bridge::DiagnosticCount {
                code: yuanyuan_bridge::BridgeDiagnosticCode::Timeout,
                count: 3,
            },
        ],
        generated_at_unix_ms,
    ))
}

#[cfg(windows)]
fn generic_diagnostic_error() -> AppError {
    AppError::Validation("诊断快照生成失败".to_owned())
}

#[cfg(windows)]
fn generic_diagnostic_clear_error() -> AppError {
    AppError::Validation("诊断数据清理失败".to_owned())
}

#[cfg(windows)]
fn diagnostics_root() -> Result<std::path::PathBuf, AppError> {
    let local_app_data = std::env::var_os("LOCALAPPDATA").ok_or_else(generic_diagnostic_error)?;
    Ok(std::path::PathBuf::from(local_app_data)
        .join("Yuanyuan")
        .join("diagnostics"))
}

#[cfg(windows)]
fn local_diagnostics_present() -> bool {
    diagnostics_root()
        .and_then(|root| {
            yuanyuan_bridge::inspect_diagnostic_store(&root).map_err(|_| generic_diagnostic_error())
        })
        .map(|usage| usage.snapshot_files > 0 || usage.counter_files > 0)
        .unwrap_or(true)
}

#[cfg(windows)]
fn collect_ai_diagnostic_snapshot(
    supervisor: &crate::ai_supervisor::AiSupervisor,
) -> Result<(std::path::PathBuf, yuanyuan_bridge::DiagnosticSnapshotV1), AppError> {
    use std::time::{SystemTime, UNIX_EPOCH};

    if !supervisor.binary_present() {
        return Err(generic_diagnostic_error());
    }
    let diagnostics_root = diagnostics_root()?;
    let root = diagnostics_root
        .parent()
        .ok_or_else(generic_diagnostic_error)?;
    let spool_root = root.join("bridge-spool");
    let usage = if spool_root.exists() {
        yuanyuan_bridge::inspect_spool_usage(&spool_root).map_err(|_| generic_diagnostic_error())?
    } else {
        yuanyuan_bridge::SpoolUsage::default()
    };
    let generated_at_unix_ms = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .ok()
        .and_then(|duration| i64::try_from(duration.as_millis()).ok())
        .ok_or_else(generic_diagnostic_error)?;
    let bridge_diagnostics = yuanyuan_bridge::read_bridge_diagnostics(&diagnostics_root)
        .map_err(|_| generic_diagnostic_error())?;
    let snapshot = build_ai_diagnostic_snapshot(
        supervisor.status(),
        supervisor.binary_present(),
        usage,
        bridge_diagnostics,
        generated_at_unix_ms,
    );
    Ok((diagnostics_root, snapshot))
}

#[cfg(windows)]
fn build_diagnostic_preview(
    snapshot: &yuanyuan_bridge::DiagnosticSnapshotV1,
) -> Result<DiagnosticPreviewResult, AppError> {
    let mut serialized = yuanyuan_bridge::serialize_diagnostic_snapshot(snapshot)
        .map_err(|_| generic_diagnostic_error())?;
    serialized.push(b'\n');
    let sensitive_scan = yuanyuan_bridge::scan_serialized_diagnostic_snapshot(&serialized)
        .map_err(|_| generic_diagnostic_error())?;
    let estimated_bytes = serialized.len() as u64;
    Ok(DiagnosticPreviewResult {
        schema_version: snapshot.schema_version,
        estimated_bytes,
        export_file_count: 1,
        pending_files: snapshot.queue.pending_files,
        pending_bytes: snapshot.queue.pending_bytes,
        quarantined_files: snapshot.queue.quarantined_files,
        diagnostic_code_categories: snapshot.bridge_diagnostics.len() as u8,
        diagnostic_occurrences: snapshot
            .bridge_diagnostics
            .iter()
            .fold(0_u64, |total, item| total.saturating_add(item.count)),
        sensitive_fields_included: false,
        sensitive_scan_status: "clean".to_owned(),
        sensitive_scan_version: sensitive_scan.scan_version,
        sensitive_scan_checks: sensitive_scan.checks_performed,
        selected_location_required: true,
        internal_copy_created: false,
        automatic_upload: false,
    })
}

#[cfg(windows)]
#[tauri::command]
pub fn preview_ai_diagnostics(app: AppHandle) -> AppResult<DiagnosticPreviewResult> {
    #[cfg(feature = "runtime-qa")]
    if crate::runtime_qa::diagnostics_profile_active() {
        return build_diagnostic_preview(&build_runtime_qa_diagnostic_snapshot()?);
    }
    let supervisor = app.state::<crate::ai_supervisor::AiSupervisor>();
    let (_, snapshot) = collect_ai_diagnostic_snapshot(&supervisor)?;
    build_diagnostic_preview(&snapshot)
}

#[cfg(not(windows))]
#[tauri::command]
pub fn preview_ai_diagnostics(_app: AppHandle) -> AppResult<DiagnosticPreviewResult> {
    Err(AppError::Validation("诊断快照生成失败".to_owned()))
}

#[cfg(windows)]
#[tauri::command]
pub async fn export_ai_diagnostics(app: AppHandle) -> AppResult<DiagnosticExportResult> {
    #[cfg(feature = "runtime-qa")]
    let snapshot = if crate::runtime_qa::diagnostics_profile_active() {
        build_runtime_qa_diagnostic_snapshot()?
    } else {
        let supervisor = app.state::<crate::ai_supervisor::AiSupervisor>();
        collect_ai_diagnostic_snapshot(&supervisor)?.1
    };
    #[cfg(not(feature = "runtime-qa"))]
    let snapshot = {
        let supervisor = app.state::<crate::ai_supervisor::AiSupervisor>();
        collect_ai_diagnostic_snapshot(&supervisor)?.1
    };
    let mut serialized = yuanyuan_bridge::serialize_diagnostic_snapshot(&snapshot)
        .map_err(|_| generic_diagnostic_error())?;
    serialized.push(b'\n');
    let preview_scan = yuanyuan_bridge::scan_serialized_diagnostic_snapshot(&serialized)
        .map_err(|_| generic_diagnostic_error())?;
    let default_name = yuanyuan_bridge::diagnostic_export_file_name(&snapshot);
    let mut picker = app
        .dialog()
        .file()
        .set_title("选择诊断快照的本机保存位置")
        .set_file_name(default_name)
        .add_filter("JSON 诊断快照", &["json"]);
    #[cfg(feature = "runtime-qa")]
    if crate::runtime_qa::diagnostics_profile_active() {
        let export_root = crate::runtime_qa::root_from_env()?.join("selected-export");
        match std::fs::symlink_metadata(&export_root) {
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                std::fs::create_dir(&export_root).map_err(|_| generic_diagnostic_error())?;
            }
            Ok(metadata) if metadata.is_dir() && !metadata.file_type().is_symlink() => {}
            Ok(_) | Err(_) => return Err(generic_diagnostic_error()),
        }
        yuanyuan_bridge::apply_current_user_only_dacl(&export_root)
            .map_err(|_| generic_diagnostic_error())?;
        picker = picker.set_directory(export_root);
    }
    if let Some(panel) = app.get_webview_window("panel").as_ref() {
        picker = picker.set_parent(panel);
    }
    let Some(selected) = picker.blocking_save_file() else {
        return Ok(DiagnosticExportResult {
            status: "cancelled".to_owned(),
            file_name: None,
            bytes: 0,
            schema_version: snapshot.schema_version,
            sensitive_fields_included: false,
            sensitive_scan_status: "clean".to_owned(),
            sensitive_scan_version: preview_scan.scan_version,
            sensitive_scan_checks: preview_scan.checks_performed,
            selected_path_returned: false,
            internal_copy_created: false,
            automatic_upload: false,
        });
    };
    let path = selected
        .into_path()
        .map_err(|_| generic_diagnostic_error())?;
    let write_report = yuanyuan_bridge::write_selected_diagnostic_export(&path, &snapshot)
        .map_err(|_| generic_diagnostic_error())?;
    let file_name = path
        .file_name()
        .and_then(|value| value.to_str())
        .ok_or_else(generic_diagnostic_error)?
        .to_owned();
    Ok(DiagnosticExportResult {
        status: "saved".to_owned(),
        file_name: Some(file_name),
        bytes: write_report.bytes,
        schema_version: snapshot.schema_version,
        sensitive_fields_included: false,
        sensitive_scan_status: "clean".to_owned(),
        sensitive_scan_version: write_report.sensitive_scan.scan_version,
        sensitive_scan_checks: write_report.sensitive_scan.checks_performed,
        selected_path_returned: false,
        internal_copy_created: false,
        automatic_upload: false,
    })
}

#[cfg(windows)]
#[tauri::command]
pub fn clear_ai_diagnostics(_app: AppHandle) -> AppResult<DiagnosticClearResult> {
    let root = diagnostics_root().map_err(|_| generic_diagnostic_clear_error())?;
    let report = yuanyuan_bridge::clear_diagnostic_store(&root)
        .map_err(|_| generic_diagnostic_clear_error())?;
    Ok(DiagnosticClearResult {
        removed_snapshot_files: report.removed_snapshot_files,
        removed_counter_files: report.removed_counter_files,
    })
}

#[cfg(not(windows))]
#[tauri::command]
pub fn clear_ai_diagnostics(_app: AppHandle) -> AppResult<DiagnosticClearResult> {
    Err(AppError::Validation("诊断数据清理失败".to_owned()))
}

#[cfg(not(windows))]
#[tauri::command]
pub fn export_ai_diagnostics(_app: AppHandle) -> AppResult<DiagnosticExportResult> {
    Err(AppError::Validation("诊断快照生成失败".to_owned()))
}

#[cfg(windows)]
#[tauri::command]
pub fn retry_ai_after_failure(app: AppHandle) -> bool {
    app.state::<crate::ai_supervisor::AiSupervisor>()
        .restart_after_circuit()
}

#[cfg(not(windows))]
#[tauri::command]
pub fn retry_ai_after_failure(_app: AppHandle) -> bool {
    false
}

#[cfg(windows)]
#[tauri::command]
pub fn discover_builtin_connectors() -> crate::connector_discovery::ConnectorDiscoverySnapshot {
    crate::connector_discovery::discover_builtin_connectors()
}

#[cfg(windows)]
#[tauri::command]
pub fn inspect_connector_hook_config(
    connector_id: String,
    source_instance: String,
) -> AppResult<crate::connector_config_preview::ConnectorHookConfigInspection> {
    crate::connector_config_preview::inspect_connector_hook_config(connector_id, source_instance)
}

#[cfg(windows)]
fn project_inspection_error(
    error: crate::connector_project_inspection::ProjectInspectionError,
) -> AppError {
    use crate::connector_project_inspection::ProjectInspectionError;

    let message = match error {
        ProjectInspectionError::UnsafeSelection => "所选项目文件夹无法安全检查",
        ProjectInspectionError::ConfirmationCapacityReached => "等待确认的项目检查过多，请稍后重试",
        ProjectInspectionError::InvalidConfirmation => "项目检查确认已失效，请重新选择",
        ProjectInspectionError::AuthorizationChanged => "连接器授权已变化，请重新检查",
        ProjectInspectionError::SourceToolUnverified => "来源工具尚未通过完整校验，不能检查项目",
        ProjectInspectionError::DirectoryChanged => "所选项目文件夹已变化，请重新选择",
    };
    AppError::Validation(message.to_owned())
}

#[cfg(windows)]
fn require_project_inspection_panel(window: &tauri::WebviewWindow) -> AppResult<()> {
    if window.label() == "panel" {
        Ok(())
    } else {
        Err(AppError::Validation(
            "项目检查只能从任务面板发起".to_owned(),
        ))
    }
}

#[cfg(windows)]
#[tauri::command]
pub async fn select_project_for_hook_inspection(
    window: tauri::WebviewWindow,
    connector_id: String,
    source_instance: String,
    coordinator: State<'_, crate::connector_project_inspection::ProjectInspectionCoordinator>,
) -> AppResult<crate::connector_project_inspection::ProjectPickerResult> {
    require_project_inspection_panel(&window)?;
    crate::connector_project_inspection::select_project_with_native_picker(
        window.app_handle(),
        connector_id,
        source_instance,
        &coordinator,
    )
    .map_err(project_inspection_error)
}

#[cfg(windows)]
#[tauri::command]
pub async fn apply_project_hook_inspection(
    window: tauri::WebviewWindow,
    confirmation_token: String,
    coordinator: State<'_, crate::connector_project_inspection::ProjectInspectionCoordinator>,
) -> AppResult<crate::connector_project_inspection::ProjectInspectionResult> {
    require_project_inspection_panel(&window)?;
    crate::connector_project_inspection::apply_project_inspection(&coordinator, &confirmation_token)
        .map_err(project_inspection_error)
}

#[cfg(windows)]
#[tauri::command]
pub fn cancel_project_hook_inspection(
    window: tauri::WebviewWindow,
    confirmation_token: String,
    coordinator: State<'_, crate::connector_project_inspection::ProjectInspectionCoordinator>,
) {
    if require_project_inspection_panel(&window).is_err() {
        return;
    }
    crate::connector_project_inspection::cancel_project_inspection(
        &coordinator,
        &confirmation_token,
    );
}

#[cfg(windows)]
#[tauri::command]
pub fn get_connector_trust_status(
    connector_id: String,
    source_instance: String,
) -> AppResult<crate::connector_trust_control::ConnectorTrustStatusView> {
    crate::connector_trust_control::get_connector_trust_status(connector_id, source_instance)
}

#[cfg(windows)]
#[tauri::command]
pub fn preview_connector_trust_change(
    app: AppHandle,
    action: crate::connector_trust_control::ConnectorTrustAction,
    connector_id: String,
    source_instance: Option<String>,
) -> AppResult<crate::connector_trust_control::ConnectorTrustPreview> {
    crate::connector_trust_control::preview_connector_trust_change(
        app,
        action,
        connector_id,
        source_instance,
    )
}

#[cfg(windows)]
#[tauri::command]
pub fn apply_connector_trust_change(
    app: AppHandle,
    confirmation_token: String,
) -> AppResult<crate::connector_trust_control::ConnectorTrustStatusView> {
    crate::connector_trust_control::apply_connector_trust_change(app, confirmation_token)
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

#[cfg(all(test, windows))]
mod ai_diagnostics_tests {
    use super::*;
    use crate::ai_supervisor::AiSupervisorStatus;
    use yuanyuan_bridge::{
        serialize_diagnostic_snapshot, DiagnosticAiStatus, SpoolUsage,
        DIAGNOSTIC_SNAPSHOT_SCHEMA_VERSION,
    };

    #[test]
    fn diagnostic_snapshot_uses_real_status_and_bounded_queue_counts() {
        let snapshot = build_ai_diagnostic_snapshot(
            AiSupervisorStatus::Running,
            true,
            SpoolUsage {
                pending_files: 7,
                pending_bytes: 12_345,
                quarantined_files: 2,
                quarantined_bytes: 999,
            },
            vec![yuanyuan_bridge::DiagnosticCount {
                code: yuanyuan_bridge::BridgeDiagnosticCode::Timeout,
                count: 3,
            }],
            1_755_000_000_000,
        );

        assert_eq!(snapshot.ai_status, DiagnosticAiStatus::Running);
        assert_eq!(snapshot.schema_version, DIAGNOSTIC_SNAPSHOT_SCHEMA_VERSION);
        assert_eq!(snapshot.queue.pending_files, 7);
        assert_eq!(snapshot.queue.pending_bytes, 12_345);
        assert_eq!(snapshot.queue.quarantined_files, 2);
        assert_eq!(snapshot.bridge_diagnostics[0].count, 3);
        assert!(snapshot.validate().is_ok());
    }

    #[test]
    fn absent_binary_is_reported_as_not_installed_regardless_of_worker_status() {
        let snapshot = build_ai_diagnostic_snapshot(
            AiSupervisorStatus::CircuitOpen,
            false,
            SpoolUsage::default(),
            Vec::new(),
            1_755_000_000_001,
        );
        assert_eq!(snapshot.ai_status, DiagnosticAiStatus::NotInstalled);
    }

    #[test]
    fn serialized_snapshot_has_only_the_reviewed_non_sensitive_schema() {
        let snapshot = build_ai_diagnostic_snapshot(
            AiSupervisorStatus::BackingOff,
            true,
            SpoolUsage::default(),
            Vec::new(),
            1_755_000_000_002,
        );
        let bytes = serialize_diagnostic_snapshot(&snapshot).unwrap();
        let object = serde_json::from_slice::<serde_json::Value>(&bytes)
            .unwrap()
            .as_object()
            .unwrap()
            .keys()
            .cloned()
            .collect::<std::collections::BTreeSet<_>>();
        let expected = [
            "ai_status",
            "bridge_diagnostics",
            "control_protocol_version",
            "core_version",
            "generated_at_unix_ms",
            "queue",
            "schema_version",
            "task_event_protocol_version",
        ]
        .into_iter()
        .map(str::to_owned)
        .collect();
        assert_eq!(object, expected);
    }

    #[test]
    fn diagnostic_failures_return_one_generic_message_without_a_path() {
        let message = generic_diagnostic_error().to_string();
        assert_eq!(message, "validation error: 诊断快照生成失败");
        assert!(!message.contains("LOCALAPPDATA"));
        assert!(!message.contains("Yuanyuan"));
        assert!(!message.contains(":\\"));
        assert!(!message.contains('\\'));
    }

    #[test]
    fn preview_reports_actual_bounded_metadata_without_upload_or_sensitive_fields() {
        let snapshot = build_ai_diagnostic_snapshot(
            AiSupervisorStatus::Running,
            true,
            SpoolUsage {
                pending_files: 2,
                pending_bytes: 2_048,
                quarantined_files: 1,
                quarantined_bytes: 99,
            },
            vec![
                yuanyuan_bridge::DiagnosticCount {
                    code: yuanyuan_bridge::BridgeDiagnosticCode::Timeout,
                    count: u64::MAX,
                },
                yuanyuan_bridge::DiagnosticCount {
                    code: yuanyuan_bridge::BridgeDiagnosticCode::QueueFull,
                    count: 5,
                },
            ],
            1_755_000_000_003,
        );
        let preview = build_diagnostic_preview(&snapshot).unwrap();
        assert_eq!(preview.schema_version, 1);
        assert!(preview.estimated_bytes > 0);
        assert_eq!(preview.export_file_count, 1);
        assert_eq!(preview.pending_files, 2);
        assert_eq!(preview.diagnostic_code_categories, 2);
        assert_eq!(preview.diagnostic_occurrences, u64::MAX);
        assert!(!preview.sensitive_fields_included);
        assert_eq!(preview.sensitive_scan_status, "clean");
        assert_eq!(
            preview.sensitive_scan_version,
            yuanyuan_bridge::DIAGNOSTIC_SENSITIVE_SCAN_VERSION
        );
        assert_eq!(
            preview.sensitive_scan_checks,
            yuanyuan_bridge::DIAGNOSTIC_SENSITIVE_SCAN_CHECKS
        );
        assert!(preview.selected_location_required);
        assert!(!preview.internal_copy_created);
        assert!(!preview.automatic_upload);
    }
}
