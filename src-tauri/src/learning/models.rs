use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum LearningRating {
    Again,
    Hard,
    Good,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum LearningStage {
    New,
    Learning,
    Stable,
}

#[derive(Debug, Clone, PartialEq)]
pub struct ScheduleInput {
    pub reps: u32,
    pub lapses: u32,
    pub stability: Option<f32>,
    pub difficulty: Option<f32>,
    pub last_review_at_unix_ms: Option<i64>,
}

impl Default for ScheduleInput {
    fn default() -> Self {
        Self {
            reps: 0,
            lapses: 0,
            stability: None,
            difficulty: None,
            last_review_at_unix_ms: None,
        }
    }
}

#[derive(Debug, Clone, PartialEq)]
pub struct ScheduleOutcome {
    pub stage: LearningStage,
    pub due_at_unix_ms: i64,
    pub stability: f32,
    pub difficulty: f32,
    pub reps: u32,
    pub lapses: u32,
    pub elapsed_days: u32,
    pub scheduled_days: u32,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ImportProgressHint {
    New,
    Learning,
    ReviewKnown,
}

impl ImportProgressHint {
    pub fn initial_due_offset_days(self) -> i64 {
        match self {
            Self::New | Self::Learning => 0,
            Self::ReviewKnown => 7,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportedCard {
    pub card_id: String,
    pub headword: String,
    pub normalized_headword: String,
    pub phonetic: Option<String>,
    pub part_of_speech: Vec<String>,
    pub meanings_zh: Vec<String>,
    pub word_family: Vec<String>,
    pub progress_hint: ImportProgressHint,
    pub content_sha256: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ParsedUserImport {
    pub file_sha256: String,
    pub pack_id: String,
    pub source_id: String,
    pub source_label: String,
    pub cards: Vec<ImportedCard>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportCommitResult {
    pub schema_version: u32,
    pub pack_id: String,
    pub imported_count: u32,
    pub preserved_schedule_count: u32,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum LearningMode {
    ManualOnly,
    AutomaticOptIn,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum LearningEntrySource {
    Manual,
    FocusFinished,
    ScheduledWindow,
    WorkGapExperimental,
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum LearningSessionKind {
    #[default]
    Daily,
    Mistakes,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct LearningSettings {
    pub mode: LearningMode,
    pub cards_per_session: u8,
    #[serde(default)]
    pub daily_new_limit: u8,
    #[serde(default)]
    pub daily_goal: u8,
    pub focus_finished_enabled: bool,
    pub scheduled_windows_enabled: bool,
    pub work_gap_experimental_enabled: bool,
    pub daily_invitation_limit: u8,
    pub invitation_cooldown_minutes: u16,
    pub invitation_ttl_seconds: u8,
    pub paused_for_local_day: Option<String>,
    pub updated_at_unix_ms: i64,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct LearningSettingsPatch {
    pub mode: Option<LearningMode>,
    pub cards_per_session: Option<u8>,
    pub daily_new_limit: Option<u8>,
    pub daily_goal: Option<u8>,
    pub focus_finished_enabled: Option<bool>,
    pub scheduled_windows_enabled: Option<bool>,
    pub work_gap_experimental_enabled: Option<bool>,
    pub daily_invitation_limit: Option<u8>,
    pub invitation_cooldown_minutes: Option<u16>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LearningSessionSnapshot {
    pub schema_version: u32,
    pub session_id: String,
    pub entry_source: LearningEntrySource,
    pub session_kind: LearningSessionKind,
    pub status: String,
    pub state_revision: u64,
    pub current_item_id: Option<String>,
    pub planned_count: u8,
    pub completed_count: u8,
    pub started_at_unix_ms: i64,
    pub paused_at_unix_ms: Option<i64>,
    pub pause_reason: Option<String>,
    pub last_activity_at_unix_ms: i64,
    pub expires_at_unix_ms: i64,
    pub ended_at_unix_ms: Option<i64>,
    pub exit_reason: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LearningCardDto {
    pub schema_version: u32,
    pub card_id: String,
    pub headword: String,
    pub phonetic: Option<String>,
    pub part_of_speech: Vec<String>,
    pub meanings_zh: Vec<String>,
    pub word_family: Vec<String>,
    pub stage: LearningStage,
    pub source_ids: Vec<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum LearningQuestionKind {
    MultipleChoice,
    RecallFallback,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LearningQuestionOptionDto {
    pub option_id: String,
    pub meaning_zh: String,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LearningQuestionDto {
    pub schema_version: u32,
    pub question_id: String,
    pub kind: LearningQuestionKind,
    pub card_id: String,
    pub headword: String,
    pub phonetic: Option<String>,
    pub part_of_speech: Vec<String>,
    pub stage: LearningStage,
    pub is_remediation: bool,
    pub options: Vec<LearningQuestionOptionDto>,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LearningAnswerResult {
    pub schema_version: u32,
    pub question_id: String,
    pub selected_option_id: String,
    pub correct_option_id: String,
    pub correct_meaning_zh: String,
    pub correct: bool,
    pub is_remediation: bool,
    pub replayed: bool,
    pub session: LearningSessionSnapshot,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum LearningRecordFilter {
    Mistakes,
    Studied,
    New,
    Learning,
    Stable,
    All,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum LearningMistakeStatus {
    NeedsCorrection,
    PendingRecheck,
    Consolidated,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LearningRecordItem {
    pub card_id: String,
    pub headword: String,
    pub phonetic: Option<String>,
    pub part_of_speech: Vec<String>,
    pub meanings_zh: Vec<String>,
    pub stage: LearningStage,
    pub due_at_unix_ms: i64,
    pub review_count: u32,
    pub correct_count: u32,
    pub wrong_count: u32,
    pub last_studied_at_unix_ms: Option<i64>,
    pub last_wrong_at_unix_ms: Option<i64>,
    pub latest_outcome: Option<String>,
    pub mistake_status: Option<LearningMistakeStatus>,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LearningRecordPage {
    pub schema_version: u32,
    pub filter: LearningRecordFilter,
    pub query: String,
    pub page: u32,
    pub page_size: u8,
    pub total: u32,
    pub items: Vec<LearningRecordItem>,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LearningHomeSnapshot {
    pub schema_version: u32,
    pub capabilities: crate::models::LearningCapabilities,
    pub due_count: u32,
    pub new_available_count: u32,
    pub new_remaining_count: u32,
    pub new_studied_today_count: u32,
    pub mistake_count: u32,
    pub pending_recheck_count: u32,
    pub stable_count: u32,
    pub tomorrow_due_count: u32,
    pub average_response_ms: Option<u32>,
    pub reviews_last_7_days: u32,
    pub completed_sessions_last_7_days: u32,
    pub settings: LearningSettings,
    pub active_session: Option<LearningSessionSnapshot>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LearningDashboardDay {
    pub local_day: String,
    pub new_count: u32,
    pub review_count: u32,
    pub first_answer_correct_count: u32,
    pub first_answer_count: u32,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LearningDashboardSnapshot {
    pub schema_version: u32,
    pub total_count: u32,
    pub studied_count: u32,
    pub new_count: u32,
    pub learning_count: u32,
    pub mistake_count: u32,
    pub pending_recheck_count: u32,
    pub stable_count: u32,
    pub corrected_mistake_count: u32,
    pub first_answer_correct_count_7_days: u32,
    pub first_answer_count_7_days: u32,
    pub days: Vec<LearningDashboardDay>,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LearningSessionSummary {
    pub schema_version: u32,
    pub session: LearningSessionSnapshot,
    pub correct_count: u32,
    pub wrong_count: u32,
    pub new_count: u32,
    pub review_count: u32,
    pub duration_seconds: u32,
    pub average_response_ms: Option<u32>,
    pub targetable_wrong_count: u32,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LearningRateResult {
    pub schema_version: u32,
    pub session: LearningSessionSnapshot,
    pub next_card: Option<LearningCardDto>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LearningInvitationData {
    pub learning_mode: LearningMode,
    pub due_review_count: u32,
    pub focus_finished_enabled: bool,
    pub scheduled_windows_enabled: bool,
    pub work_gap_experimental_enabled: bool,
    pub invitations_presented_today: u8,
    pub daily_invitation_limit: u8,
    pub last_invitation_at_unix_ms: Option<i64>,
    pub invitation_cooldown_minutes: u16,
    pub paused_today: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LearningImportPreview {
    pub schema_version: u32,
    pub status: &'static str,
    pub preview_token: Option<String>,
    pub expires_at_unix_ms: Option<i64>,
    pub format: Option<&'static str>,
    pub source_label: Option<String>,
    pub card_count: u32,
    pub new_count: u32,
    pub learning_count: u32,
    pub review_known_count: u32,
    pub sample_headwords: Vec<String>,
    pub added_count: u32,
    pub changed_count: u32,
    pub disabled_count: u32,
    pub reset_count: u32,
    pub rights_basis: Option<String>,
    pub selected_path_returned: bool,
}

impl LearningImportPreview {
    pub fn cancelled() -> Self {
        Self {
            schema_version: 1,
            status: "cancelled",
            preview_token: None,
            expires_at_unix_ms: None,
            format: None,
            source_label: None,
            card_count: 0,
            new_count: 0,
            learning_count: 0,
            review_known_count: 0,
            sample_headwords: Vec::new(),
            added_count: 0,
            changed_count: 0,
            disabled_count: 0,
            reset_count: 0,
            rights_basis: None,
            selected_path_returned: false,
        }
    }
}
