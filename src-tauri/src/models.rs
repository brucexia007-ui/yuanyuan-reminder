use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Reminder {
    pub id: String,
    pub title: String,
    pub category: String,
    pub schedule_kind: String,
    pub schedule_json: String,
    pub timezone: String,
    pub enabled: bool,
    pub next_due_at: Option<String>,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Occurrence {
    pub id: String,
    pub reminder_id: String,
    pub reminder_title: String,
    pub category: String,
    pub scheduled_at: String,
    pub status: String,
    pub acted_at: Option<String>,
    pub snoozed_until: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TodaySnapshot {
    pub reminders: Vec<Reminder>,
    pub occurrences: Vec<Occurrence>,
    pub water_completed: u32,
    pub water_goal: u32,
    pub notification_available: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FocusSession {
    pub id: String,
    pub phase: String,
    pub status: String,
    pub duration_minutes: u32,
    pub started_at: String,
    pub ends_at: String,
    pub completed_at: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FocusState {
    pub session: Option<FocusSession>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PetCareSnapshot {
    pub total: u32,
    pub food: u32,
    pub water: u32,
    pub treat: u32,
    pub wand: u32,
    pub pet: u32,
    pub ball: u32,
    pub last_interaction_at: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PetInteractionStarted {
    pub id: String,
    pub kind: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateReminderInput {
    pub title: String,
    pub category: String,
    pub schedule_kind: String,
    pub at_local: Option<String>,
    pub every_minutes: Option<u32>,
    pub active_start_local: Option<String>,
    pub active_end_local: Option<String>,
    pub weekdays: Option<Vec<u32>>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
#[serde(default)]
pub struct AppSettings {
    pub animation_mode: String,
    pub animation_speed: f64,
    pub cursor_follow: bool,
    pub always_on_top: bool,
    pub click_through: bool,
    pub pet_width: u32,
    pub pet_x: Option<i32>,
    pub pet_y: Option<i32>,
    pub quiet_start: String,
    pub quiet_end: String,
    pub idle_sleep_minutes: u32,
    pub autostart: bool,
    pub pause_until: Option<String>,
    pub water_start: String,
    pub water_end: String,
    pub water_interval_minutes: u32,
    pub activity_enabled: bool,
    pub activity_start: String,
    pub activity_end: String,
    pub activity_interval_minutes: u32,
}

impl Default for AppSettings {
    fn default() -> Self {
        Self {
            animation_mode: "always".into(),
            animation_speed: 1.0,
            cursor_follow: true,
            always_on_top: true,
            click_through: false,
            pet_width: 192,
            pet_x: None,
            pet_y: None,
            quiet_start: "23:00".into(),
            quiet_end: "07:30".into(),
            idle_sleep_minutes: 20,
            autostart: false,
            pause_until: None,
            water_start: "09:00".into(),
            water_end: "18:00".into(),
            water_interval_minutes: 60,
            activity_enabled: true,
            activity_start: "09:00".into(),
            activity_end: "18:00".into(),
            activity_interval_minutes: 60,
        }
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PetIntent {
    pub id: String,
    pub kind: String,
    pub priority: u8,
    pub animation: String,
    pub route: String,
    pub title: String,
    pub message: String,
    pub occurrence_id: Option<String>,
    pub persistent: bool,
    pub expires_at: Option<String>,
}

impl PetIntent {
    pub fn transient(
        kind: &str,
        priority: u8,
        animation: &str,
        route: &str,
        title: impl Into<String>,
        message: impl Into<String>,
        occurrence_id: Option<String>,
        seconds: i64,
    ) -> Self {
        Self {
            id: uuid::Uuid::new_v4().to_string(),
            kind: kind.into(),
            priority,
            animation: animation.into(),
            route: route.into(),
            title: title.into(),
            message: message.into(),
            occurrence_id,
            persistent: false,
            expires_at: Some(
                (chrono::Utc::now() + chrono::Duration::seconds(seconds)).to_rfc3339(),
            ),
        }
    }

    pub fn persistent(
        kind: &str,
        priority: u8,
        animation: &str,
        route: &str,
        title: impl Into<String>,
        message: impl Into<String>,
    ) -> Self {
        Self {
            id: uuid::Uuid::new_v4().to_string(),
            kind: kind.into(),
            priority,
            animation: animation.into(),
            route: route.into(),
            title: title.into(),
            message: message.into(),
            occurrence_id: None,
            persistent: true,
            expires_at: None,
        }
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CursorDirectionEvent {
    pub frame: Option<i32>,
}

#[derive(Debug, Clone)]
pub struct DueOccurrence {
    pub occurrence: Occurrence,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn legacy_settings_receive_activity_defaults() {
        let settings: AppSettings =
            serde_json::from_value(serde_json::json!({ "animationMode": "off" }))
                .unwrap();
        assert_eq!(settings.animation_mode, "off");
        assert!(settings.activity_enabled);
        assert_eq!(settings.activity_start, "09:00");
        assert_eq!(settings.activity_end, "18:00");
        assert_eq!(settings.activity_interval_minutes, 60);
    }
}
