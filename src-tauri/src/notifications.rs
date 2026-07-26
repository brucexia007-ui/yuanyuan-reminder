use tauri::AppHandle;
use tauri_plugin_notification::NotificationExt;

use crate::{
    error::{AppError, AppResult},
    models::Occurrence,
};

pub fn available(app: &AppHandle) -> bool {
    app.notification().permission_state().is_ok()
}

pub fn send_due(app: &AppHandle, occurrence: &Occurrence) -> AppResult<()> {
    app.notification()
        .builder()
        .title("圆圆提醒你")
        .body(&occurrence.reminder_title)
        .action_type_id("reminder-actions")
        .extra("occurrenceId", &occurrence.id)
        .auto_cancel()
        .show()
        .map_err(|error| AppError::Notification(error.to_string()))
}

pub fn send_break_complete(app: &AppHandle) -> AppResult<()> {
    app.notification()
        .builder()
        .title("圆圆叫你回来啦")
        .body("休息时间结束，屏幕已经点亮。解锁后继续下一轮吧。")
        .auto_cancel()
        .show()
        .map_err(|error| AppError::Notification(error.to_string()))
}

pub fn send_activity_due(app: &AppHandle, occurrence: &Occurrence) -> AppResult<()> {
    app.notification()
        .builder()
        .title("圆圆叫你起来活动啦")
        .body("已经连续使用电脑一段时间，站起来走一走、伸伸肩颈吧。")
        .action_type_id("reminder-actions")
        .extra("occurrenceId", &occurrence.id)
        .auto_cancel()
        .show()
        .map_err(|error| AppError::Notification(error.to_string()))
}
