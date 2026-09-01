use tauri::AppHandle;
use tauri_plugin_notification::NotificationExt;

use crate::{
    brand,
    error::{AppError, AppResult},
    models::Occurrence,
};

pub fn available(app: &AppHandle) -> bool {
    app.notification().permission_state().is_ok()
}

pub fn send_due(app: &AppHandle, occurrence: &Occurrence) -> AppResult<()> {
    app.notification()
        .builder()
        .title(brand::notification_sender())
        .body(&occurrence.reminder_title)
        .auto_cancel()
        .show()
        .map_err(|error| AppError::Notification(error.to_string()))
}

pub fn send_break_complete(app: &AppHandle) -> AppResult<()> {
    app.notification()
        .builder()
        .title(format!("{}叫你回来啦", brand::pet_display_name()))
        .body("休息时间结束，屏幕已经点亮。解锁后继续下一轮吧。")
        .auto_cancel()
        .show()
        .map_err(|error| AppError::Notification(error.to_string()))
}

pub fn send_activity_due(app: &AppHandle, _occurrence: &Occurrence) -> AppResult<()> {
    app.notification()
        .builder()
        .title(format!("{}叫你起来活动啦", brand::pet_display_name()))
        .body("已经连续使用电脑一段时间，站起来走一走、伸伸肩颈吧。")
        .auto_cancel()
        .show()
        .map_err(|error| AppError::Notification(error.to_string()))
}
