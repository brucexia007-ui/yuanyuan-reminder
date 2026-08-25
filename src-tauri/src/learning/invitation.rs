use serde::Serialize;

use super::models::LearningMode;

// The later-phase sources remain typed now so persisted settings and native exports
// cannot drift, even though only focus-finished constructs them in the first trial.
#[allow(dead_code)]
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum LearningTriggerSource {
    FocusFinished,
    ScheduledWindow,
    WorkGapExperimental,
}

impl LearningTriggerSource {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::FocusFinished => "focus_finished",
            Self::ScheduledWindow => "scheduled_window",
            Self::WorkGapExperimental => "work_gap_experimental",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SystemNotificationSuitability {
    AcceptsNotifications,
    Suppressed,
    Unknown,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct LearningInvitationEnvironment {
    pub focus_or_break_active: bool,
    pub quiet_time: bool,
    pub basic_support_active: bool,
    pub session_interactive: bool,
    pub system_suitability: SystemNotificationSuitability,
    pub pending_local_reminder: bool,
    pub task_attention_pending: bool,
    pub global_budget_available: bool,
    pub content_and_database_healthy: bool,
    pub timing_valid: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LearningInvitationDto {
    pub schema_version: u32,
    pub invitation_id: String,
    pub trigger_source: LearningTriggerSource,
    pub expires_at_unix_ms: i64,
    pub due_review_count: u32,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum LearningSuppressionReason {
    LearningUnavailable,
    ManualOnly,
    NoDueReviews,
    SourceDisabled,
    TimingInvalid,
    FocusActive,
    QuietTime,
    TodayPaused,
    BasicSupportActive,
    SessionUnavailable,
    Fullscreen,
    FullscreenUnknown,
    ReminderPending,
    TaskAttentionPending,
    GlobalBudget,
    DailyBudget,
    Cooldown,
    ContentUnhealthy,
    ClockInvalid,
}

impl LearningSuppressionReason {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::LearningUnavailable => "learning_unavailable",
            Self::ManualOnly => "manual_only",
            Self::NoDueReviews => "no_due_reviews",
            Self::SourceDisabled => "source_disabled",
            Self::TimingInvalid => "timing_invalid",
            Self::FocusActive => "focus_active",
            Self::QuietTime => "quiet_time",
            Self::TodayPaused => "today_paused",
            Self::BasicSupportActive => "basic_support_active",
            Self::SessionUnavailable => "session_unavailable",
            Self::Fullscreen => "fullscreen",
            Self::FullscreenUnknown => "fullscreen_unknown",
            Self::ReminderPending => "reminder_pending",
            Self::TaskAttentionPending => "task_attention_pending",
            Self::GlobalBudget => "global_budget",
            Self::DailyBudget => "daily_budget",
            Self::Cooldown => "cooldown",
            Self::ContentUnhealthy => "content_unhealthy",
            Self::ClockInvalid => "clock_invalid",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LearningInvitationContext {
    pub trigger_source: LearningTriggerSource,
    pub now_unix_ms: i64,
    pub learning_available: bool,
    pub learning_mode: LearningMode,
    pub due_review_count: u32,
    pub source_enabled: bool,
    pub timing_valid: bool,
    pub focus_or_break_active: bool,
    pub quiet_time: bool,
    pub paused_today: bool,
    pub basic_support_active: bool,
    pub session_interactive: bool,
    pub system_suitability: SystemNotificationSuitability,
    pub pending_local_reminder: bool,
    pub task_attention_pending: bool,
    pub global_budget_available: bool,
    pub invitations_presented_today: u8,
    pub daily_invitation_limit: u8,
    pub last_invitation_at_unix_ms: Option<i64>,
    pub invitation_cooldown_minutes: u16,
    pub content_and_database_healthy: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum LearningInvitationDecision {
    Eligible,
    Suppressed(LearningSuppressionReason),
}

pub fn evaluate_learning_invitation(
    context: &LearningInvitationContext,
) -> LearningInvitationDecision {
    use LearningInvitationDecision::Suppressed;
    use LearningSuppressionReason as Reason;

    if context.now_unix_ms < 0 {
        return Suppressed(Reason::ClockInvalid);
    }
    if !context.learning_available {
        return Suppressed(Reason::LearningUnavailable);
    }
    if context.learning_mode != LearningMode::AutomaticOptIn {
        return Suppressed(Reason::ManualOnly);
    }
    if context.due_review_count == 0 {
        return Suppressed(Reason::NoDueReviews);
    }
    if !context.source_enabled {
        return Suppressed(Reason::SourceDisabled);
    }
    if !context.timing_valid {
        return Suppressed(Reason::TimingInvalid);
    }
    if context.focus_or_break_active {
        return Suppressed(Reason::FocusActive);
    }
    if context.quiet_time {
        return Suppressed(Reason::QuietTime);
    }
    if context.paused_today {
        return Suppressed(Reason::TodayPaused);
    }
    if context.basic_support_active {
        return Suppressed(Reason::BasicSupportActive);
    }
    if !context.session_interactive {
        return Suppressed(Reason::SessionUnavailable);
    }
    match context.system_suitability {
        SystemNotificationSuitability::AcceptsNotifications => {}
        SystemNotificationSuitability::Suppressed => return Suppressed(Reason::Fullscreen),
        SystemNotificationSuitability::Unknown => return Suppressed(Reason::FullscreenUnknown),
    }
    if context.pending_local_reminder {
        return Suppressed(Reason::ReminderPending);
    }
    if context.task_attention_pending {
        return Suppressed(Reason::TaskAttentionPending);
    }
    if !context.global_budget_available {
        return Suppressed(Reason::GlobalBudget);
    }
    if context.invitations_presented_today >= context.daily_invitation_limit {
        return Suppressed(Reason::DailyBudget);
    }
    if let Some(last) = context.last_invitation_at_unix_ms {
        if last > context.now_unix_ms {
            return Suppressed(Reason::ClockInvalid);
        }
        let cooldown = i64::from(context.invitation_cooldown_minutes) * 60 * 1_000;
        if context.now_unix_ms - last < cooldown {
            return Suppressed(Reason::Cooldown);
        }
    }
    if !context.content_and_database_healthy {
        return Suppressed(Reason::ContentUnhealthy);
    }
    LearningInvitationDecision::Eligible
}

#[cfg(test)]
mod tests {
    use super::*;

    fn eligible_context() -> LearningInvitationContext {
        LearningInvitationContext {
            trigger_source: LearningTriggerSource::FocusFinished,
            now_unix_ms: 1_800_000_000_000,
            learning_available: true,
            learning_mode: LearningMode::AutomaticOptIn,
            due_review_count: 3,
            source_enabled: true,
            timing_valid: true,
            focus_or_break_active: false,
            quiet_time: false,
            paused_today: false,
            basic_support_active: false,
            session_interactive: true,
            system_suitability: SystemNotificationSuitability::AcceptsNotifications,
            pending_local_reminder: false,
            task_attention_pending: false,
            global_budget_available: true,
            invitations_presented_today: 0,
            daily_invitation_limit: 2,
            last_invitation_at_unix_ms: None,
            invitation_cooldown_minutes: 120,
            content_and_database_healthy: true,
        }
    }

    #[test]
    fn only_a_fully_safe_explicit_opt_in_context_is_eligible() {
        assert_eq!(
            evaluate_learning_invitation(&eligible_context()),
            LearningInvitationDecision::Eligible
        );
        let cases: Vec<(
            LearningSuppressionReason,
            Box<dyn Fn(&mut LearningInvitationContext)>,
        )> = vec![
            (
                LearningSuppressionReason::LearningUnavailable,
                Box::new(|c| c.learning_available = false),
            ),
            (
                LearningSuppressionReason::ManualOnly,
                Box::new(|c| c.learning_mode = LearningMode::ManualOnly),
            ),
            (
                LearningSuppressionReason::NoDueReviews,
                Box::new(|c| c.due_review_count = 0),
            ),
            (
                LearningSuppressionReason::SourceDisabled,
                Box::new(|c| c.source_enabled = false),
            ),
            (
                LearningSuppressionReason::TimingInvalid,
                Box::new(|c| c.timing_valid = false),
            ),
            (
                LearningSuppressionReason::FocusActive,
                Box::new(|c| c.focus_or_break_active = true),
            ),
            (
                LearningSuppressionReason::QuietTime,
                Box::new(|c| c.quiet_time = true),
            ),
            (
                LearningSuppressionReason::TodayPaused,
                Box::new(|c| c.paused_today = true),
            ),
            (
                LearningSuppressionReason::BasicSupportActive,
                Box::new(|c| c.basic_support_active = true),
            ),
            (
                LearningSuppressionReason::SessionUnavailable,
                Box::new(|c| c.session_interactive = false),
            ),
            (
                LearningSuppressionReason::Fullscreen,
                Box::new(|c| c.system_suitability = SystemNotificationSuitability::Suppressed),
            ),
            (
                LearningSuppressionReason::FullscreenUnknown,
                Box::new(|c| c.system_suitability = SystemNotificationSuitability::Unknown),
            ),
            (
                LearningSuppressionReason::ReminderPending,
                Box::new(|c| c.pending_local_reminder = true),
            ),
            (
                LearningSuppressionReason::TaskAttentionPending,
                Box::new(|c| c.task_attention_pending = true),
            ),
            (
                LearningSuppressionReason::GlobalBudget,
                Box::new(|c| c.global_budget_available = false),
            ),
            (
                LearningSuppressionReason::DailyBudget,
                Box::new(|c| c.invitations_presented_today = 2),
            ),
            (
                LearningSuppressionReason::ContentUnhealthy,
                Box::new(|c| c.content_and_database_healthy = false),
            ),
        ];
        for (reason, mutate) in cases {
            let mut context = eligible_context();
            mutate(&mut context);
            assert_eq!(
                evaluate_learning_invitation(&context),
                LearningInvitationDecision::Suppressed(reason)
            );
        }
    }

    #[test]
    fn cooldown_boundary_and_clock_rollback_fail_closed() {
        let mut context = eligible_context();
        let cooldown = i64::from(context.invitation_cooldown_minutes) * 60 * 1_000;
        context.last_invitation_at_unix_ms = Some(context.now_unix_ms - cooldown + 1);
        assert_eq!(
            evaluate_learning_invitation(&context),
            LearningInvitationDecision::Suppressed(LearningSuppressionReason::Cooldown)
        );
        context.last_invitation_at_unix_ms = Some(context.now_unix_ms - cooldown);
        assert_eq!(
            evaluate_learning_invitation(&context),
            LearningInvitationDecision::Eligible
        );
        context.last_invitation_at_unix_ms = Some(context.now_unix_ms + 1);
        assert_eq!(
            evaluate_learning_invitation(&context),
            LearningInvitationDecision::Suppressed(LearningSuppressionReason::ClockInvalid)
        );
    }
}
