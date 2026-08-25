use std::cmp::Reverse;

use serde::Serialize;
use thiserror::Error;
use uuid::Uuid;
use yuanyuan_protocol::{
    IntentCompatibility, ResolvedResponseIntent, ResponseIntentKind, ResponsePriority, TaskState,
};

pub const COMPANION_EXPRESSION_SCHEMA_VERSION: u16 = 1;
const MAX_ACTIVE_SIGNALS: usize = 64;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub struct ExpressionKey(Uuid);

impl ExpressionKey {
    pub fn new() -> Self {
        Self(Uuid::new_v4())
    }

    pub(crate) const fn system(value: u128) -> Self {
        Self(Uuid::from_u128(value))
    }

    pub(crate) fn parse(value: &str) -> Option<Self> {
        Uuid::parse_str(value).ok().map(Self)
    }

    pub(crate) const fn from_digest(value: [u8; 16]) -> Self {
        Self(Uuid::from_bytes(value))
    }
}

impl Default for ExpressionKey {
    fn default() -> Self {
        Self::new()
    }
}

#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum ExpressionTier {
    N0,
    N1,
    N2,
    N3,
    N4,
}

#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum ExpressionIntent {
    QuietPresence,
    Acknowledge,
    Approach,
    StayClose,
    Watch,
    NeedsAttention,
    Celebrate,
    Inspect,
    PutAway,
    PresentInformation,
    RequestFormalDecision,
}

#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum CompanionPose {
    Idle,
    FocusCalm,
    Stretch,
    Sleeping,
    Acknowledge,
    Approach,
    Reunion,
    StayClose,
    WatchComputer,
    Alert,
    Celebrate,
    Review,
    PutAway,
    ObserveInformation,
    StepAside,
    GiveSpace,
}

#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum CompanionProp {
    Computer,
    Bell,
    TaskCard,
    Basket,
    Prompter,
    SystemCard,
    LearningCard,
}

#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum ExpressionLabel {
    WaterDue,
    ReminderDue,
    NeedsUser,
    TimeToMove,
    Running,
    StillRunning,
    Completed,
    Failed,
    Cancelled,
    PossiblyStalled,
    StatusUnknown,
    Information,
    DecisionRequired,
    ReviewReady,
}

#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum AccessibleExpressionState {
    QuietPresence,
    FocusedQuietly,
    FocusFinished,
    WelcomingReturn,
    MovingTogether,
    GivingSpace,
    Sleeping,
    HeardUser,
    Approaching,
    StayingClose,
    WaterReminderDue,
    WorkReminderDue,
    TaskNeedsUser,
    ActivityReminderDue,
    TaskRunning,
    TaskStillRunning,
    TaskCompleted,
    TaskFailed,
    TaskCancelled,
    TaskPossiblyStalled,
    TaskStatusUnknown,
    InformationAvailable,
    FormalDecisionRequired,
    LearningInvitation,
    LearningSession,
}

#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum AttentionMode {
    Silent,
    PresentOnce,
    RingOnce,
}

#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum MotionMode {
    Full,
    Reduced,
}

#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq, Hash)]
#[serde(rename_all = "snake_case")]
pub enum TaskSource {
    Codex,
    ClaudeCode,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TaskOutcome {
    Succeeded,
    Failed,
    Cancelled,
}

#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum BasicSupportPath {
    StayClose,
    MoveTogether,
    GiveSpace,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ExpressionSignal {
    BasicSupport {
        path: BasicSupportPath,
    },
    FocusFinishedRitual,
    ReunionRitual,
    LearningInvitation,
    LearningSession,
    StrongWaterReminder,
    DueWorkReminder,
    TaskWaitingUser {
        source: TaskSource,
    },
    ActivityReminder,
    TaskOutcome {
        source: TaskSource,
        outcome: TaskOutcome,
    },
    TaskOutcomeSummary {
        source: TaskSource,
        outcome: TaskOutcome,
        count: u16,
    },
    UserResponse {
        response: ResolvedResponseIntent,
        information_ready: bool,
        formal_decision_ready: bool,
    },
    TaskWatch {
        source: TaskSource,
        state: TaskState,
    },
    TaskWatchLongRunning {
        source: TaskSource,
    },
    Sleep,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct CompanionExpressionSnapshot {
    pub schema_version: u16,
    pub revision: u64,
    pub tier: ExpressionTier,
    pub intent: ExpressionIntent,
    pub pose: CompanionPose,
    pub props: Vec<CompanionProp>,
    pub label: Option<ExpressionLabel>,
    pub attention: AttentionMode,
    pub motion: MotionMode,
    pub move_prop_forward: bool,
    pub queue_in_basket: bool,
    pub task_source: Option<TaskSource>,
    pub grouped_count: u16,
    pub focus_deferred_count: u16,
    pub accessible_state: AccessibleExpressionState,
}

#[derive(Debug, Error, PartialEq, Eq)]
pub enum ExpressionDirectorError {
    #[error("companion expression signal capacity reached")]
    CapacityReached,
}

#[derive(Debug, Clone, Copy)]
struct ActiveSignal {
    key: ExpressionKey,
    signal: ExpressionSignal,
    sequence: u64,
}

#[derive(Debug, Default)]
pub struct CompanionExpressionDirector {
    active: Vec<ActiveSignal>,
    revision: u64,
    sequence: u64,
    focus_active: bool,
    quiet_active: bool,
    reduce_motion: bool,
}

impl CompanionExpressionDirector {
    pub fn upsert(
        &mut self,
        key: ExpressionKey,
        signal: ExpressionSignal,
    ) -> Result<CompanionExpressionSnapshot, ExpressionDirectorError> {
        if self
            .active
            .iter()
            .find(|entry| entry.key == key)
            .is_some_and(|entry| entry.signal == signal)
        {
            return Ok(self.snapshot());
        }
        self.sequence = self.sequence.saturating_add(1);
        if let Some(existing) = self.active.iter_mut().find(|entry| entry.key == key) {
            existing.signal = signal;
            existing.sequence = self.sequence;
        } else {
            if self.active.len() >= MAX_ACTIVE_SIGNALS {
                return Err(ExpressionDirectorError::CapacityReached);
            }
            self.active.push(ActiveSignal {
                key,
                signal,
                sequence: self.sequence,
            });
        }
        self.bump_revision();
        Ok(self.snapshot())
    }

    pub fn remove(&mut self, key: ExpressionKey) -> CompanionExpressionSnapshot {
        let previous_len = self.active.len();
        self.active.retain(|entry| entry.key != key);
        if self.active.len() != previous_len {
            self.bump_revision();
        }
        self.snapshot()
    }

    pub fn set_focus_active(&mut self, active: bool) -> CompanionExpressionSnapshot {
        if self.focus_active != active {
            self.focus_active = active;
            self.bump_revision();
        }
        self.snapshot()
    }

    pub fn set_reduce_motion(&mut self, reduce_motion: bool) -> CompanionExpressionSnapshot {
        if self.reduce_motion != reduce_motion {
            self.reduce_motion = reduce_motion;
            self.bump_revision();
        }
        self.snapshot()
    }

    pub fn set_quiet_active(&mut self, active: bool) -> CompanionExpressionSnapshot {
        if self.quiet_active != active {
            self.quiet_active = active;
            self.bump_revision();
        }
        self.snapshot()
    }

    pub fn snapshot(&self) -> CompanionExpressionSnapshot {
        let deferred_count = self
            .active
            .iter()
            .filter(|entry| self.focus_active && is_suppressed_during_focus(entry.signal))
            .count();
        let selected = self
            .active
            .iter()
            .filter(|entry| {
                !(self.focus_active && is_suppressed_during_focus(entry.signal))
                    && !(self.quiet_active && is_suppressed_during_quiet(entry.signal))
            })
            .max_by_key(|entry| (signal_rank(entry.signal), Reverse(entry.sequence)));

        let mut snapshot = selected.map_or_else(
            || self.baseline_snapshot(),
            |entry| self.plan_for(entry.signal),
        );
        snapshot.focus_deferred_count = count_to_u16(deferred_count);
        snapshot
    }

    pub(crate) fn can_present_proactive(&self) -> bool {
        !self.focus_active
            && !self.quiet_active
            && !self.active.iter().any(|entry| {
                matches!(
                    entry.signal,
                    ExpressionSignal::Sleep
                        | ExpressionSignal::FocusFinishedRitual
                        | ExpressionSignal::ReunionRitual
                        | ExpressionSignal::LearningInvitation
                ) || signal_rank(entry.signal) > signal_rank(ExpressionSignal::FocusFinishedRitual)
            })
    }

    #[cfg(feature = "learning")]
    pub(crate) fn can_present_learning_invitation(&self) -> bool {
        !self.focus_active
            && !self.quiet_active
            && !self.active.iter().any(|entry| {
                matches!(
                    entry.signal,
                    ExpressionSignal::Sleep
                        | ExpressionSignal::FocusFinishedRitual
                        | ExpressionSignal::ReunionRitual
                        | ExpressionSignal::LearningInvitation
                        | ExpressionSignal::LearningSession
                ) || signal_rank(entry.signal) > signal_rank(ExpressionSignal::LearningInvitation)
            })
    }

    fn plan_for(&self, signal: ExpressionSignal) -> CompanionExpressionSnapshot {
        let mut plan = match signal {
            ExpressionSignal::BasicSupport { path } => basic_support_plan(path),
            ExpressionSignal::FocusFinishedRitual => expression_plan(
                ExpressionTier::N1,
                ExpressionIntent::StayClose,
                CompanionPose::Stretch,
                &[],
                None,
                AttentionMode::PresentOnce,
                false,
                false,
                None,
                AccessibleExpressionState::FocusFinished,
            ),
            ExpressionSignal::ReunionRitual => expression_plan(
                ExpressionTier::N1,
                ExpressionIntent::Approach,
                CompanionPose::Reunion,
                &[],
                None,
                AttentionMode::PresentOnce,
                false,
                false,
                None,
                AccessibleExpressionState::WelcomingReturn,
            ),
            ExpressionSignal::LearningInvitation => expression_plan(
                ExpressionTier::N1,
                ExpressionIntent::PresentInformation,
                CompanionPose::Review,
                &[CompanionProp::LearningCard],
                Some(ExpressionLabel::ReviewReady),
                AttentionMode::PresentOnce,
                true,
                false,
                None,
                AccessibleExpressionState::LearningInvitation,
            ),
            ExpressionSignal::LearningSession => expression_plan(
                ExpressionTier::N1,
                ExpressionIntent::StayClose,
                CompanionPose::Review,
                &[CompanionProp::LearningCard],
                None,
                AttentionMode::Silent,
                false,
                false,
                None,
                AccessibleExpressionState::LearningSession,
            ),
            ExpressionSignal::StrongWaterReminder => expression_plan(
                ExpressionTier::N2,
                ExpressionIntent::NeedsAttention,
                CompanionPose::Alert,
                &[CompanionProp::Bell, CompanionProp::TaskCard],
                Some(ExpressionLabel::WaterDue),
                AttentionMode::RingOnce,
                true,
                false,
                None,
                AccessibleExpressionState::WaterReminderDue,
            ),
            ExpressionSignal::DueWorkReminder => expression_plan(
                ExpressionTier::N2,
                ExpressionIntent::NeedsAttention,
                CompanionPose::Alert,
                &[CompanionProp::TaskCard],
                Some(ExpressionLabel::ReminderDue),
                AttentionMode::PresentOnce,
                true,
                false,
                None,
                AccessibleExpressionState::WorkReminderDue,
            ),
            ExpressionSignal::TaskWaitingUser { source } => expression_plan(
                ExpressionTier::N2,
                ExpressionIntent::NeedsAttention,
                CompanionPose::Alert,
                &[CompanionProp::Bell, CompanionProp::TaskCard],
                Some(ExpressionLabel::NeedsUser),
                AttentionMode::RingOnce,
                true,
                false,
                Some(source),
                AccessibleExpressionState::TaskNeedsUser,
            ),
            ExpressionSignal::ActivityReminder => expression_plan(
                ExpressionTier::N2,
                ExpressionIntent::NeedsAttention,
                CompanionPose::Approach,
                &[CompanionProp::TaskCard],
                Some(ExpressionLabel::TimeToMove),
                AttentionMode::PresentOnce,
                true,
                false,
                None,
                AccessibleExpressionState::ActivityReminderDue,
            ),
            ExpressionSignal::TaskOutcome { source, outcome }
            | ExpressionSignal::TaskOutcomeSummary {
                source, outcome, ..
            } => task_outcome_plan(source, outcome),
            ExpressionSignal::UserResponse {
                response,
                information_ready,
                formal_decision_ready,
            } => user_response_plan(response, information_ready, formal_decision_ready),
            ExpressionSignal::TaskWatch { source, state } => task_watch_plan(source, state),
            ExpressionSignal::TaskWatchLongRunning { source } => expression_plan(
                ExpressionTier::N2,
                ExpressionIntent::Watch,
                CompanionPose::StayClose,
                &[CompanionProp::Computer],
                Some(ExpressionLabel::StillRunning),
                AttentionMode::Silent,
                false,
                false,
                Some(source),
                AccessibleExpressionState::TaskStillRunning,
            ),
            ExpressionSignal::Sleep => expression_plan(
                ExpressionTier::N0,
                ExpressionIntent::QuietPresence,
                CompanionPose::Sleeping,
                &[],
                None,
                AttentionMode::Silent,
                false,
                false,
                None,
                AccessibleExpressionState::Sleeping,
            ),
        };

        plan.schema_version = COMPANION_EXPRESSION_SCHEMA_VERSION;
        plan.revision = self.revision;
        plan.motion = self.motion_mode();
        plan.grouped_count = self.grouped_count(signal);
        plan
    }

    fn baseline_snapshot(&self) -> CompanionExpressionSnapshot {
        let (pose, accessible_state) = if self.focus_active {
            (
                CompanionPose::FocusCalm,
                AccessibleExpressionState::FocusedQuietly,
            )
        } else {
            (
                CompanionPose::Idle,
                AccessibleExpressionState::QuietPresence,
            )
        };
        let mut plan = expression_plan(
            ExpressionTier::N0,
            ExpressionIntent::QuietPresence,
            pose,
            &[],
            None,
            AttentionMode::Silent,
            false,
            false,
            None,
            accessible_state,
        );
        plan.schema_version = COMPANION_EXPRESSION_SCHEMA_VERSION;
        plan.revision = self.revision;
        plan.motion = self.motion_mode();
        plan
    }

    fn grouped_count(&self, selected: ExpressionSignal) -> u16 {
        let count = match selected {
            ExpressionSignal::TaskWaitingUser { .. } => self
                .active
                .iter()
                .filter(|entry| matches!(entry.signal, ExpressionSignal::TaskWaitingUser { .. }))
                .count(),
            ExpressionSignal::TaskOutcome { .. } => self
                .active
                .iter()
                .filter(|entry| matches!(entry.signal, ExpressionSignal::TaskOutcome { .. }))
                .count(),
            ExpressionSignal::TaskOutcomeSummary { count, .. } => usize::from(count.max(1)),
            _ => 1,
        };
        count_to_u16(count)
    }

    fn motion_mode(&self) -> MotionMode {
        if self.reduce_motion {
            MotionMode::Reduced
        } else {
            MotionMode::Full
        }
    }

    fn bump_revision(&mut self) {
        self.revision = self.revision.saturating_add(1);
    }
}

fn signal_rank(signal: ExpressionSignal) -> u16 {
    match signal {
        ExpressionSignal::StrongWaterReminder => 800,
        ExpressionSignal::DueWorkReminder => 700,
        ExpressionSignal::TaskWaitingUser { .. } => 600,
        ExpressionSignal::ActivityReminder => 500,
        ExpressionSignal::BasicSupport { .. } => 550,
        ExpressionSignal::TaskOutcome { outcome, .. }
        | ExpressionSignal::TaskOutcomeSummary { outcome, .. } => match outcome {
            TaskOutcome::Failed => 420,
            TaskOutcome::Succeeded => 410,
            TaskOutcome::Cancelled => 400,
        },
        ExpressionSignal::UserResponse { response, .. } => match response.priority {
            ResponsePriority::Background => 300,
            ResponsePriority::Normal => 320,
            ResponsePriority::Important => 340,
            ResponsePriority::Formal => 360,
        },
        ExpressionSignal::FocusFinishedRitual => 250,
        ExpressionSignal::ReunionRitual => 240,
        ExpressionSignal::LearningInvitation => 230,
        ExpressionSignal::LearningSession => 330,
        ExpressionSignal::TaskWatch { .. } | ExpressionSignal::TaskWatchLongRunning { .. } => 200,
        ExpressionSignal::Sleep => 100,
    }
}

fn is_suppressed_during_focus(signal: ExpressionSignal) -> bool {
    matches!(
        signal,
        ExpressionSignal::BasicSupport { .. }
            | ExpressionSignal::FocusFinishedRitual
            | ExpressionSignal::ReunionRitual
            | ExpressionSignal::LearningInvitation
            | ExpressionSignal::LearningSession
            | ExpressionSignal::ActivityReminder
            | ExpressionSignal::TaskOutcome { .. }
            | ExpressionSignal::TaskOutcomeSummary { .. }
            | ExpressionSignal::TaskWatch { .. }
            | ExpressionSignal::TaskWatchLongRunning { .. }
            | ExpressionSignal::Sleep
    )
}

fn is_suppressed_during_quiet(signal: ExpressionSignal) -> bool {
    !matches!(
        signal,
        ExpressionSignal::BasicSupport { .. } | ExpressionSignal::Sleep
    )
}

fn basic_support_plan(path: BasicSupportPath) -> CompanionExpressionSnapshot {
    match path {
        BasicSupportPath::StayClose => expression_plan(
            ExpressionTier::N1,
            ExpressionIntent::StayClose,
            CompanionPose::StayClose,
            &[],
            None,
            AttentionMode::Silent,
            false,
            false,
            None,
            AccessibleExpressionState::StayingClose,
        ),
        BasicSupportPath::MoveTogether => expression_plan(
            ExpressionTier::N1,
            ExpressionIntent::Approach,
            CompanionPose::Stretch,
            &[],
            None,
            AttentionMode::PresentOnce,
            false,
            false,
            None,
            AccessibleExpressionState::MovingTogether,
        ),
        BasicSupportPath::GiveSpace => expression_plan(
            ExpressionTier::N1,
            ExpressionIntent::QuietPresence,
            CompanionPose::GiveSpace,
            &[],
            None,
            AttentionMode::Silent,
            false,
            false,
            None,
            AccessibleExpressionState::GivingSpace,
        ),
    }
}

fn task_outcome_plan(source: TaskSource, outcome: TaskOutcome) -> CompanionExpressionSnapshot {
    match outcome {
        TaskOutcome::Succeeded => expression_plan(
            ExpressionTier::N2,
            ExpressionIntent::Celebrate,
            CompanionPose::Celebrate,
            &[CompanionProp::TaskCard, CompanionProp::Basket],
            Some(ExpressionLabel::Completed),
            AttentionMode::PresentOnce,
            true,
            true,
            Some(source),
            AccessibleExpressionState::TaskCompleted,
        ),
        TaskOutcome::Failed => expression_plan(
            ExpressionTier::N2,
            ExpressionIntent::StayClose,
            CompanionPose::StayClose,
            &[CompanionProp::TaskCard],
            Some(ExpressionLabel::Failed),
            AttentionMode::PresentOnce,
            true,
            false,
            Some(source),
            AccessibleExpressionState::TaskFailed,
        ),
        TaskOutcome::Cancelled => expression_plan(
            ExpressionTier::N2,
            ExpressionIntent::PutAway,
            CompanionPose::PutAway,
            &[CompanionProp::TaskCard, CompanionProp::Basket],
            Some(ExpressionLabel::Cancelled),
            AttentionMode::Silent,
            false,
            true,
            Some(source),
            AccessibleExpressionState::TaskCancelled,
        ),
    }
}

fn task_watch_plan(source: TaskSource, state: TaskState) -> CompanionExpressionSnapshot {
    match state {
        TaskState::Queued | TaskState::Running => expression_plan(
            ExpressionTier::N2,
            ExpressionIntent::Watch,
            CompanionPose::WatchComputer,
            &[CompanionProp::Computer],
            Some(ExpressionLabel::Running),
            AttentionMode::Silent,
            false,
            false,
            Some(source),
            AccessibleExpressionState::TaskRunning,
        ),
        TaskState::WaitingUser => expression_plan(
            ExpressionTier::N2,
            ExpressionIntent::NeedsAttention,
            CompanionPose::Alert,
            &[CompanionProp::Bell, CompanionProp::TaskCard],
            Some(ExpressionLabel::NeedsUser),
            AttentionMode::RingOnce,
            true,
            false,
            Some(source),
            AccessibleExpressionState::TaskNeedsUser,
        ),
        TaskState::Succeeded => task_outcome_plan(source, TaskOutcome::Succeeded),
        TaskState::Failed => task_outcome_plan(source, TaskOutcome::Failed),
        TaskState::Cancelled => task_outcome_plan(source, TaskOutcome::Cancelled),
        TaskState::Stalled => expression_plan(
            ExpressionTier::N2,
            ExpressionIntent::Inspect,
            CompanionPose::Review,
            &[CompanionProp::Computer, CompanionProp::TaskCard],
            Some(ExpressionLabel::PossiblyStalled),
            AttentionMode::PresentOnce,
            true,
            false,
            Some(source),
            AccessibleExpressionState::TaskPossiblyStalled,
        ),
        TaskState::Unknown => expression_plan(
            ExpressionTier::N2,
            ExpressionIntent::Inspect,
            CompanionPose::Review,
            &[CompanionProp::Computer, CompanionProp::TaskCard],
            Some(ExpressionLabel::StatusUnknown),
            AttentionMode::Silent,
            false,
            false,
            Some(source),
            AccessibleExpressionState::TaskStatusUnknown,
        ),
    }
}

fn user_response_plan(
    response: ResolvedResponseIntent,
    information_ready: bool,
    formal_decision_ready: bool,
) -> CompanionExpressionSnapshot {
    if response.compatibility != IntentCompatibility::Exact {
        return quiet_user_plan();
    }
    match response.intent {
        ResponseIntentKind::QuietPresence => quiet_user_plan(),
        ResponseIntentKind::Acknowledge => simple_user_plan(
            ExpressionIntent::Acknowledge,
            CompanionPose::Acknowledge,
            AccessibleExpressionState::HeardUser,
        ),
        ResponseIntentKind::Approach => simple_user_plan(
            ExpressionIntent::Approach,
            CompanionPose::Approach,
            AccessibleExpressionState::Approaching,
        ),
        ResponseIntentKind::StayClose => simple_user_plan(
            ExpressionIntent::StayClose,
            CompanionPose::StayClose,
            AccessibleExpressionState::StayingClose,
        ),
        ResponseIntentKind::Celebrate => simple_user_plan(
            ExpressionIntent::Celebrate,
            CompanionPose::Celebrate,
            AccessibleExpressionState::HeardUser,
        ),
        ResponseIntentKind::NeedsAttention => simple_user_plan(
            ExpressionIntent::Approach,
            CompanionPose::Approach,
            AccessibleExpressionState::Approaching,
        ),
        ResponseIntentKind::PresentInformation if information_ready => expression_plan(
            ExpressionTier::N3,
            ExpressionIntent::PresentInformation,
            CompanionPose::ObserveInformation,
            &[CompanionProp::Prompter],
            Some(ExpressionLabel::Information),
            AttentionMode::PresentOnce,
            true,
            false,
            None,
            AccessibleExpressionState::InformationAvailable,
        ),
        ResponseIntentKind::RequestFormalDecision if formal_decision_ready => expression_plan(
            ExpressionTier::N4,
            ExpressionIntent::RequestFormalDecision,
            CompanionPose::StepAside,
            &[CompanionProp::SystemCard],
            Some(ExpressionLabel::DecisionRequired),
            AttentionMode::PresentOnce,
            false,
            false,
            None,
            AccessibleExpressionState::FormalDecisionRequired,
        ),
        ResponseIntentKind::PresentInformation | ResponseIntentKind::RequestFormalDecision => {
            simple_user_plan(
                ExpressionIntent::Acknowledge,
                CompanionPose::Acknowledge,
                AccessibleExpressionState::HeardUser,
            )
        }
    }
}

fn quiet_user_plan() -> CompanionExpressionSnapshot {
    expression_plan(
        ExpressionTier::N0,
        ExpressionIntent::QuietPresence,
        CompanionPose::Idle,
        &[],
        None,
        AttentionMode::Silent,
        false,
        false,
        None,
        AccessibleExpressionState::QuietPresence,
    )
}

fn simple_user_plan(
    intent: ExpressionIntent,
    pose: CompanionPose,
    accessible_state: AccessibleExpressionState,
) -> CompanionExpressionSnapshot {
    expression_plan(
        ExpressionTier::N1,
        intent,
        pose,
        &[],
        None,
        AttentionMode::Silent,
        false,
        false,
        None,
        accessible_state,
    )
}

#[allow(clippy::too_many_arguments)]
fn expression_plan(
    tier: ExpressionTier,
    intent: ExpressionIntent,
    pose: CompanionPose,
    props: &[CompanionProp],
    label: Option<ExpressionLabel>,
    attention: AttentionMode,
    move_prop_forward: bool,
    queue_in_basket: bool,
    task_source: Option<TaskSource>,
    accessible_state: AccessibleExpressionState,
) -> CompanionExpressionSnapshot {
    CompanionExpressionSnapshot {
        schema_version: COMPANION_EXPRESSION_SCHEMA_VERSION,
        revision: 0,
        tier,
        intent,
        pose,
        props: props.to_vec(),
        label,
        attention,
        motion: MotionMode::Full,
        move_prop_forward,
        queue_in_basket,
        task_source,
        grouped_count: 1,
        focus_deferred_count: 0,
        accessible_state,
    }
}

fn count_to_u16(value: usize) -> u16 {
    u16::try_from(value).unwrap_or(u16::MAX)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn exact_response(
        intent: ResponseIntentKind,
        priority: ResponsePriority,
    ) -> ResolvedResponseIntent {
        ResolvedResponseIntent {
            intent,
            priority,
            compatibility: IntentCompatibility::Exact,
        }
    }

    fn unknown_response() -> ResolvedResponseIntent {
        ResolvedResponseIntent {
            intent: ResponseIntentKind::QuietPresence,
            priority: ResponsePriority::Background,
            compatibility: IntentCompatibility::UnknownIntent,
        }
    }

    #[test]
    fn fixed_priority_order_cannot_be_overridden_by_a_model_priority() {
        let mut director = CompanionExpressionDirector::default();
        director
            .upsert(
                ExpressionKey::new(),
                ExpressionSignal::UserResponse {
                    response: exact_response(
                        ResponseIntentKind::RequestFormalDecision,
                        ResponsePriority::Formal,
                    ),
                    information_ready: true,
                    formal_decision_ready: true,
                },
            )
            .unwrap();
        director
            .upsert(
                ExpressionKey::new(),
                ExpressionSignal::TaskOutcome {
                    source: TaskSource::Codex,
                    outcome: TaskOutcome::Failed,
                },
            )
            .unwrap();
        director
            .upsert(ExpressionKey::new(), ExpressionSignal::ActivityReminder)
            .unwrap();
        director
            .upsert(
                ExpressionKey::new(),
                ExpressionSignal::TaskWaitingUser {
                    source: TaskSource::ClaudeCode,
                },
            )
            .unwrap();
        director
            .upsert(ExpressionKey::new(), ExpressionSignal::DueWorkReminder)
            .unwrap();
        let plan = director
            .upsert(ExpressionKey::new(), ExpressionSignal::StrongWaterReminder)
            .unwrap();

        assert_eq!(plan.label, Some(ExpressionLabel::WaterDue));
        assert_eq!(plan.tier, ExpressionTier::N2);
    }

    #[test]
    fn failed_outcome_deterministically_leads_other_terminal_outcomes() {
        let mut director = CompanionExpressionDirector::default();
        director
            .upsert(
                ExpressionKey::new(),
                ExpressionSignal::TaskOutcome {
                    source: TaskSource::ClaudeCode,
                    outcome: TaskOutcome::Succeeded,
                },
            )
            .unwrap();
        director
            .upsert(
                ExpressionKey::new(),
                ExpressionSignal::TaskOutcome {
                    source: TaskSource::ClaudeCode,
                    outcome: TaskOutcome::Cancelled,
                },
            )
            .unwrap();
        let failed = director
            .upsert(
                ExpressionKey::new(),
                ExpressionSignal::TaskOutcome {
                    source: TaskSource::Codex,
                    outcome: TaskOutcome::Failed,
                },
            )
            .unwrap();

        assert_eq!(failed.label, Some(ExpressionLabel::Failed));
        assert_eq!(failed.task_source, Some(TaskSource::Codex));
        assert_eq!(failed.grouped_count, 3);
    }

    #[test]
    fn persisted_terminal_summary_preserves_its_bounded_group_count() {
        let mut director = CompanionExpressionDirector::default();
        let summary = director
            .upsert(
                ExpressionKey::system(20),
                ExpressionSignal::TaskOutcomeSummary {
                    source: TaskSource::ClaudeCode,
                    outcome: TaskOutcome::Succeeded,
                    count: 7,
                },
            )
            .unwrap();
        assert_eq!(summary.label, Some(ExpressionLabel::Completed));
        assert_eq!(summary.grouped_count, 7);
        assert!(summary.queue_in_basket);
    }

    #[test]
    fn focus_completion_is_a_nonverbal_stretch_without_props_or_labels() {
        let mut director = CompanionExpressionDirector::default();
        assert!(director.can_present_proactive());
        let ritual_key = ExpressionKey::system(30);
        let ritual = director
            .upsert(ritual_key, ExpressionSignal::FocusFinishedRitual)
            .unwrap();
        assert_eq!(ritual.tier, ExpressionTier::N1);
        assert_eq!(ritual.pose, CompanionPose::Stretch);
        assert_eq!(
            ritual.accessible_state,
            AccessibleExpressionState::FocusFinished
        );
        assert_eq!(ritual.attention, AttentionMode::PresentOnce);
        assert!(ritual.props.is_empty());
        assert!(ritual.label.is_none());
        assert!(!director.can_present_proactive());
        director.remove(ritual_key);

        director
            .upsert(
                ExpressionKey::new(),
                ExpressionSignal::TaskWatch {
                    source: TaskSource::Codex,
                    state: TaskState::Running,
                },
            )
            .unwrap();
        assert!(director.can_present_proactive());
        director
            .upsert(ExpressionKey::new(), ExpressionSignal::DueWorkReminder)
            .unwrap();
        assert!(!director.can_present_proactive());
    }

    #[test]
    fn user_started_basic_support_is_nonverbal_and_only_transactions_can_preempt_it() {
        let mut director = CompanionExpressionDirector::default();
        let support_key = ExpressionKey::system(40);
        let support = director
            .upsert(
                support_key,
                ExpressionSignal::BasicSupport {
                    path: BasicSupportPath::MoveTogether,
                },
            )
            .unwrap();
        assert_eq!(support.tier, ExpressionTier::N1);
        assert_eq!(support.pose, CompanionPose::Stretch);
        assert_eq!(
            support.accessible_state,
            AccessibleExpressionState::MovingTogether
        );
        assert!(support.props.is_empty());
        assert!(support.label.is_none());

        director
            .upsert(ExpressionKey::new(), ExpressionSignal::ActivityReminder)
            .unwrap();
        assert_eq!(director.snapshot().pose, CompanionPose::Stretch);
        director
            .upsert(
                ExpressionKey::new(),
                ExpressionSignal::TaskOutcome {
                    source: TaskSource::Codex,
                    outcome: TaskOutcome::Failed,
                },
            )
            .unwrap();
        assert_eq!(director.snapshot().pose, CompanionPose::Stretch);

        let waiting = director
            .upsert(
                ExpressionKey::new(),
                ExpressionSignal::TaskWaitingUser {
                    source: TaskSource::ClaudeCode,
                },
            )
            .unwrap();
        assert_eq!(waiting.label, Some(ExpressionLabel::NeedsUser));
    }

    #[test]
    fn reunion_is_a_nonverbal_approach_without_props_or_labels() {
        let mut director = CompanionExpressionDirector::default();
        let ritual = director
            .upsert(ExpressionKey::system(32), ExpressionSignal::ReunionRitual)
            .unwrap();
        assert_eq!(ritual.tier, ExpressionTier::N1);
        assert_eq!(ritual.intent, ExpressionIntent::Approach);
        assert_eq!(ritual.pose, CompanionPose::Reunion);
        assert_eq!(
            ritual.accessible_state,
            AccessibleExpressionState::WelcomingReturn
        );
        assert_eq!(ritual.attention, AttentionMode::PresentOnce);
        assert!(ritual.props.is_empty());
        assert!(ritual.label.is_none());
        assert!(!director.can_present_proactive());
    }

    #[test]
    fn explicit_give_space_survives_one_click_quiet_but_not_focus() {
        let mut director = CompanionExpressionDirector::default();
        director.set_quiet_active(true);
        let away = director
            .upsert(
                ExpressionKey::system(41),
                ExpressionSignal::BasicSupport {
                    path: BasicSupportPath::GiveSpace,
                },
            )
            .unwrap();
        assert_eq!(away.pose, CompanionPose::GiveSpace);
        assert_eq!(
            away.accessible_state,
            AccessibleExpressionState::GivingSpace
        );

        let focused = director.set_focus_active(true);
        assert_eq!(focused.pose, CompanionPose::FocusCalm);
    }

    #[test]
    fn focus_and_one_click_quiet_block_proactive_rituals_before_budget_is_used() {
        let mut director = CompanionExpressionDirector::default();
        director.set_focus_active(true);
        assert!(!director.can_present_proactive());
        director.set_focus_active(false);
        director.set_quiet_active(true);
        assert!(!director.can_present_proactive());
        director.set_quiet_active(false);
        director
            .upsert(ExpressionKey::system(31), ExpressionSignal::Sleep)
            .unwrap();
        assert!(!director.can_present_proactive());
    }

    #[test]
    fn one_click_quiet_hides_transactional_and_background_signals_without_deleting_them() {
        let mut director = CompanionExpressionDirector::default();
        director
            .upsert(
                ExpressionKey::new(),
                ExpressionSignal::TaskWaitingUser {
                    source: TaskSource::Codex,
                },
            )
            .unwrap();
        director
            .upsert(ExpressionKey::new(), ExpressionSignal::StrongWaterReminder)
            .unwrap();
        let quiet = director.set_quiet_active(true);
        assert_eq!(quiet.tier, ExpressionTier::N0);
        assert_eq!(
            quiet.accessible_state,
            AccessibleExpressionState::QuietPresence
        );

        let restored = director.set_quiet_active(false);
        assert_eq!(restored.label, Some(ExpressionLabel::WaterDue));
    }

    #[test]
    fn completing_a_high_priority_signal_restores_the_previous_state_without_prop_residue() {
        let mut director = CompanionExpressionDirector::default();
        let watch = ExpressionKey::new();
        let activity = ExpressionKey::new();
        let water = ExpressionKey::new();
        director
            .upsert(
                watch,
                ExpressionSignal::TaskWatch {
                    source: TaskSource::Codex,
                    state: TaskState::Running,
                },
            )
            .unwrap();
        director
            .upsert(activity, ExpressionSignal::ActivityReminder)
            .unwrap();
        let water_plan = director
            .upsert(water, ExpressionSignal::StrongWaterReminder)
            .unwrap();
        assert_eq!(
            water_plan.props,
            [CompanionProp::Bell, CompanionProp::TaskCard]
        );

        let activity_plan = director.remove(water);
        assert_eq!(activity_plan.label, Some(ExpressionLabel::TimeToMove));
        assert_eq!(activity_plan.props, [CompanionProp::TaskCard]);

        let restored = director.remove(activity);
        assert_eq!(restored.label, Some(ExpressionLabel::Running));
        assert_eq!(restored.props, [CompanionProp::Computer]);
        assert!(!restored.props.contains(&CompanionProp::Bell));
    }

    #[cfg(feature = "learning")]
    #[test]
    fn learning_invitation_is_a_bounded_nonverbal_card_and_respects_safety_gates() {
        let mut director = CompanionExpressionDirector::default();
        assert!(director.can_present_learning_invitation());
        let invitation_key = ExpressionKey::system(61);
        let invitation = director
            .upsert(invitation_key, ExpressionSignal::LearningInvitation)
            .unwrap();
        assert_eq!(invitation.tier, ExpressionTier::N1);
        assert_eq!(invitation.intent, ExpressionIntent::PresentInformation);
        assert_eq!(invitation.pose, CompanionPose::Review);
        assert_eq!(invitation.props, [CompanionProp::LearningCard]);
        assert_eq!(invitation.label, Some(ExpressionLabel::ReviewReady));
        assert_eq!(invitation.attention, AttentionMode::PresentOnce);
        assert_eq!(
            invitation.accessible_state,
            AccessibleExpressionState::LearningInvitation
        );
        assert!(!director.can_present_learning_invitation());

        director.remove(invitation_key);
        director.set_focus_active(true);
        assert!(!director.can_present_learning_invitation());
        director.set_focus_active(false);
        director.set_quiet_active(true);
        assert!(!director.can_present_learning_invitation());
    }

    #[cfg(feature = "learning")]
    #[test]
    fn high_priority_attention_preempts_learning_and_removal_restores_it_cleanly() {
        let mut director = CompanionExpressionDirector::default();
        let session_key = ExpressionKey::system(62);
        let task_key = ExpressionKey::new();
        let water_key = ExpressionKey::new();
        let session = director
            .upsert(session_key, ExpressionSignal::LearningSession)
            .unwrap();
        assert_eq!(session.props, [CompanionProp::LearningCard]);
        assert_eq!(session.attention, AttentionMode::Silent);

        director
            .upsert(
                task_key,
                ExpressionSignal::TaskWatch {
                    source: TaskSource::Codex,
                    state: TaskState::Running,
                },
            )
            .unwrap();
        assert_eq!(director.snapshot().props, [CompanionProp::LearningCard]);

        let water = director
            .upsert(water_key, ExpressionSignal::StrongWaterReminder)
            .unwrap();
        assert_eq!(water.props, [CompanionProp::Bell, CompanionProp::TaskCard]);
        let restored = director.remove(water_key);
        assert_eq!(restored.props, [CompanionProp::LearningCard]);
        assert!(!restored.props.contains(&CompanionProp::Bell));

        let focused = director.set_focus_active(true);
        assert_eq!(focused.tier, ExpressionTier::N0);
        assert!(focused.focus_deferred_count >= 1);
        let resumed = director.set_focus_active(false);
        assert_eq!(resumed.props, [CompanionProp::LearningCard]);
    }

    #[test]
    fn focus_defers_non_urgent_props_but_never_hides_waiting_user() {
        let mut director = CompanionExpressionDirector::default();
        director
            .upsert(
                ExpressionKey::new(),
                ExpressionSignal::TaskOutcome {
                    source: TaskSource::Codex,
                    outcome: TaskOutcome::Succeeded,
                },
            )
            .unwrap();
        director
            .upsert(ExpressionKey::new(), ExpressionSignal::ActivityReminder)
            .unwrap();
        let focused = director.set_focus_active(true);
        assert_eq!(focused.tier, ExpressionTier::N0);
        assert_eq!(focused.pose, CompanionPose::FocusCalm);
        assert_eq!(focused.focus_deferred_count, 2);

        let waiting_key = ExpressionKey::new();
        let waiting = director
            .upsert(
                waiting_key,
                ExpressionSignal::TaskWaitingUser {
                    source: TaskSource::ClaudeCode,
                },
            )
            .unwrap();
        assert_eq!(waiting.label, Some(ExpressionLabel::NeedsUser));
        assert_eq!(waiting.attention, AttentionMode::RingOnce);

        director.remove(waiting_key);
        let resumed = director.set_focus_active(false);
        assert_eq!(resumed.label, Some(ExpressionLabel::TimeToMove));
    }

    #[test]
    fn waiting_and_terminal_tasks_aggregate_into_one_bounded_prop_presentation() {
        let mut director = CompanionExpressionDirector::default();
        for source in [TaskSource::Codex, TaskSource::ClaudeCode] {
            director
                .upsert(
                    ExpressionKey::new(),
                    ExpressionSignal::TaskWaitingUser { source },
                )
                .unwrap();
        }
        let waiting = director.snapshot();
        assert_eq!(waiting.grouped_count, 2);
        assert_eq!(
            waiting.props,
            [CompanionProp::Bell, CompanionProp::TaskCard]
        );

        let mut terminal = CompanionExpressionDirector::default();
        for outcome in [
            TaskOutcome::Succeeded,
            TaskOutcome::Failed,
            TaskOutcome::Cancelled,
        ] {
            terminal
                .upsert(
                    ExpressionKey::new(),
                    ExpressionSignal::TaskOutcome {
                        source: TaskSource::Codex,
                        outcome,
                    },
                )
                .unwrap();
        }
        assert_eq!(terminal.snapshot().grouped_count, 3);
    }

    #[test]
    fn unknown_intents_are_quiet_and_information_or_decisions_require_a_separate_tool() {
        let mut director = CompanionExpressionDirector::default();
        let unknown = director
            .upsert(
                ExpressionKey::new(),
                ExpressionSignal::UserResponse {
                    response: unknown_response(),
                    information_ready: true,
                    formal_decision_ready: true,
                },
            )
            .unwrap();
        assert_eq!(unknown.tier, ExpressionTier::N0);
        assert!(unknown.props.is_empty());

        let mut information = CompanionExpressionDirector::default();
        let missing_tool = information
            .upsert(
                ExpressionKey::new(),
                ExpressionSignal::UserResponse {
                    response: exact_response(
                        ResponseIntentKind::PresentInformation,
                        ResponsePriority::Important,
                    ),
                    information_ready: false,
                    formal_decision_ready: false,
                },
            )
            .unwrap();
        assert_eq!(missing_tool.tier, ExpressionTier::N1);
        assert!(missing_tool.props.is_empty());

        let mut formal = CompanionExpressionDirector::default();
        let formal_plan = formal
            .upsert(
                ExpressionKey::new(),
                ExpressionSignal::UserResponse {
                    response: exact_response(
                        ResponseIntentKind::RequestFormalDecision,
                        ResponsePriority::Formal,
                    ),
                    information_ready: false,
                    formal_decision_ready: true,
                },
            )
            .unwrap();
        assert_eq!(formal_plan.tier, ExpressionTier::N4);
        assert_eq!(formal_plan.props, [CompanionProp::SystemCard]);
        assert!(!formal_plan.move_prop_forward);
    }

    #[test]
    fn serialized_output_has_only_fixed_non_dialogue_fields() {
        let mut director = CompanionExpressionDirector::default();
        let plan = director
            .upsert(
                ExpressionKey::new(),
                ExpressionSignal::TaskWaitingUser {
                    source: TaskSource::Codex,
                },
            )
            .unwrap();
        let serialized = serde_json::to_string(&plan).unwrap();
        for forbidden in [
            "title",
            "message",
            "dialogue",
            "speech",
            "animation",
            "resource",
            "css",
            "path",
            "prompt",
            "圆圆说",
        ] {
            assert!(!serialized.contains(forbidden), "leaked field: {forbidden}");
        }
    }

    #[test]
    fn reduced_motion_changes_only_the_motion_channel() {
        let mut director = CompanionExpressionDirector::default();
        director
            .upsert(
                ExpressionKey::new(),
                ExpressionSignal::TaskOutcome {
                    source: TaskSource::Codex,
                    outcome: TaskOutcome::Failed,
                },
            )
            .unwrap();
        let full = director.snapshot();
        let reduced = director.set_reduce_motion(true);
        assert_eq!(reduced.motion, MotionMode::Reduced);
        assert_eq!(reduced.tier, full.tier);
        assert_eq!(reduced.intent, full.intent);
        assert_eq!(reduced.pose, full.pose);
        assert_eq!(reduced.props, full.props);
        assert_eq!(reduced.label, full.label);
        assert_eq!(reduced.accessible_state, full.accessible_state);
    }

    #[test]
    fn active_signal_capacity_is_bounded_and_updates_do_not_consume_capacity() {
        let mut director = CompanionExpressionDirector::default();
        let first = ExpressionKey::new();
        director.upsert(first, ExpressionSignal::Sleep).unwrap();
        for _ in 1..MAX_ACTIVE_SIGNALS {
            director
                .upsert(ExpressionKey::new(), ExpressionSignal::Sleep)
                .unwrap();
        }
        director
            .upsert(
                first,
                ExpressionSignal::TaskWatch {
                    source: TaskSource::Codex,
                    state: TaskState::Running,
                },
            )
            .unwrap();
        assert_eq!(
            director.upsert(ExpressionKey::new(), ExpressionSignal::Sleep),
            Err(ExpressionDirectorError::CapacityReached)
        );
    }

    #[test]
    fn identical_updates_do_not_restart_an_expression_or_advance_revision() {
        let mut director = CompanionExpressionDirector::default();
        let key = ExpressionKey::new();
        let first = director
            .upsert(key, ExpressionSignal::StrongWaterReminder)
            .unwrap();
        let repeated = director
            .upsert(key, ExpressionSignal::StrongWaterReminder)
            .unwrap();
        assert_eq!(repeated, first);
    }
}
