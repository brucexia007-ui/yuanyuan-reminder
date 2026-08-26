use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeCapabilities {
    pub schema_version: u8,
    pub learning: LearningCapabilities,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LearningCapabilities {
    pub compiled: bool,
    pub available: bool,
    pub content_pack_ready: bool,
    pub auto_invitation_available: bool,
    pub failure_reason: Option<String>,
}

impl RuntimeCapabilities {
    pub fn current() -> Self {
        let learning_compiled = cfg!(feature = "learning");
        Self {
            schema_version: 1,
            learning: LearningCapabilities {
                compiled: learning_compiled,
                available: false,
                content_pack_ready: false,
                auto_invitation_available: false,
                failure_reason: Some(if learning_compiled {
                    "not_implemented".into()
                } else {
                    "disabled".into()
                }),
            },
        }
    }
}

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
    pub archived_at: Option<String>,
    pub system_kind: Option<String>,
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
    pub resolution_reason: Option<String>,
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
pub struct BasicSupportSession {
    pub id: String,
    pub path: String,
    pub duration_minutes: u32,
    pub started_at: String,
    pub ends_at: String,
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
    pub companion_intensity: String,
    pub companion_label_mode: String,
    pub animation_speed: f64,
    pub cursor_follow: bool,
    pub always_on_top: bool,
    pub click_through: bool,
    pub learning_quick_start_visible: bool,
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
    pub missed_reminder_policy: String,
    pub missed_reminder_grace_minutes: u32,
}

impl Default for AppSettings {
    fn default() -> Self {
        Self {
            animation_mode: "always".into(),
            companion_intensity: "everyday".into(),
            companion_label_mode: "adaptive".into(),
            animation_speed: 1.0,
            cursor_follow: true,
            always_on_top: true,
            click_through: false,
            learning_quick_start_visible: true,
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
            missed_reminder_policy: "notify".into(),
            missed_reminder_grace_minutes: 120,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BackupInfo {
    pub file_name: String,
    pub created_at: String,
    pub size_bytes: u64,
    pub automatic: bool,
    pub learning_included: bool,
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
    pub fn motion_only(
        kind: &str,
        priority: u8,
        animation: &str,
        route: &str,
        occurrence_id: Option<String>,
        seconds: i64,
    ) -> Self {
        Self {
            id: uuid::Uuid::new_v4().to_string(),
            kind: kind.into(),
            priority,
            animation: animation.into(),
            route: route.into(),
            title: String::new(),
            message: String::new(),
            occurrence_id,
            persistent: false,
            expires_at: Some(
                (chrono::Utc::now() + chrono::Duration::seconds(seconds)).to_rfc3339(),
            ),
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
    pub notify: bool,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn runtime_capabilities_keep_learning_unavailable_during_foundation_stage() {
        let capabilities = RuntimeCapabilities::current();
        assert_eq!(capabilities.schema_version, 1);
        assert!(!capabilities.learning.available);
        assert!(!capabilities.learning.content_pack_ready);
        assert!(!capabilities.learning.auto_invitation_available);
        assert_eq!(capabilities.learning.compiled, cfg!(feature = "learning"));
        assert_eq!(
            capabilities.learning.failure_reason.as_deref(),
            Some(if cfg!(feature = "learning") {
                "not_implemented"
            } else {
                "disabled"
            })
        );
    }

    #[test]
    fn legacy_settings_receive_activity_defaults() {
        let settings: AppSettings =
            serde_json::from_value(serde_json::json!({ "animationMode": "off" })).unwrap();
        assert_eq!(settings.animation_mode, "off");
        assert_eq!(settings.companion_intensity, "everyday");
        assert_eq!(settings.companion_label_mode, "adaptive");
        assert!(settings.learning_quick_start_visible);
        assert!(settings.activity_enabled);
        assert_eq!(settings.activity_start, "09:00");
        assert_eq!(settings.activity_end, "18:00");
        assert_eq!(settings.activity_interval_minutes, 60);
        assert_eq!(settings.missed_reminder_policy, "notify");
        assert_eq!(settings.missed_reminder_grace_minutes, 120);
    }

    #[test]
    fn motion_only_intents_carry_no_dialogue_text() {
        let intent = PetIntent::motion_only("success", 110, "jumping", "today", None, 7);
        assert!(intent.title.is_empty());
        assert!(intent.message.is_empty());
        let serialized = serde_json::to_value(intent).unwrap();
        assert_eq!(serialized["title"], "");
        assert_eq!(serialized["message"], "");
    }

    #[test]
    fn basic_support_session_serializes_only_ephemeral_control_fields() {
        let session = BasicSupportSession {
            id: "support-1".into(),
            path: "stay_close".into(),
            duration_minutes: 5,
            started_at: "2026-08-05T09:00:00Z".into(),
            ends_at: "2026-08-05T09:05:00Z".into(),
        };
        let serialized = serde_json::to_value(session).unwrap();
        assert_eq!(
            serialized
                .as_object()
                .unwrap()
                .keys()
                .cloned()
                .collect::<Vec<_>>(),
            ["durationMinutes", "endsAt", "id", "path", "startedAt"]
        );
        assert!(serialized.get("reason").is_none());
        assert!(serialized.get("emotion").is_none());
        assert!(serialized.get("text").is_none());
    }
}
