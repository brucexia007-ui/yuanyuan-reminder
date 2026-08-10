use serde::{Deserialize, Serialize};
use thiserror::Error;

mod content;
mod support;
mod support_sort_ipc;

pub use content::*;
pub use support::*;
pub use support_sort_ipc::*;

pub const TASK_EVENT_PROTOCOL_VERSION: u16 = 1;

const MAX_IDENTIFIER_LENGTH: usize = 128;
const MAX_TITLE_LENGTH: usize = 256;
const MAX_WORKSPACE_LENGTH: usize = 1_024;
const MAX_SUMMARY_LENGTH: usize = 4_096;
const MAX_ATTENTION_REASON_LENGTH: usize = 2_048;
const MAX_RETURN_TARGET_LENGTH: usize = 2_048;
const MAX_PAYLOAD_REFERENCE_LENGTH: usize = 1_024;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct TaskEventEnvelope {
    pub protocol_version: u16,
    pub event: TaskEventV1,
}

impl TaskEventEnvelope {
    pub fn validate(&self) -> Result<(), ProtocolValidationError> {
        if self.protocol_version != TASK_EVENT_PROTOCOL_VERSION {
            return Err(ProtocolValidationError::UnsupportedProtocolVersion(
                self.protocol_version,
            ));
        }
        self.event.validate()
    }

    /// Produces the protocol-v1 canonical binary message used by Bridge HMAC.
    ///
    /// The encoding is deliberately independent of JSON property order and
    /// whitespace. Any change to the field order or representation is a signed
    /// protocol change and requires a new authentication version.
    pub fn authentication_message(&self) -> Result<Vec<u8>, ProtocolValidationError> {
        self.validate()?;
        let event = &self.event;
        let mut output = Vec::with_capacity(512);
        output.extend_from_slice(b"yuanyuan.task-event.protocol.v1\0");
        output.extend_from_slice(&self.protocol_version.to_be_bytes());
        push_string(&mut output, &event.event_id);
        push_string(&mut output, &event.connector_id);
        push_string(&mut output, &event.source_instance);
        push_string(&mut output, &event.task_id);
        push_string(&mut output, &event.run_id);
        push_optional_string(&mut output, event.parent_task_id.as_deref());
        push_string(&mut output, &event.source);
        push_string(&mut output, &event.external_id);
        push_string(&mut output, &event.title);
        push_optional_string(&mut output, event.workspace.as_deref());
        output.push(task_state_code(event.state));
        push_optional_progress(&mut output, event.progress);
        push_optional_string(&mut output, event.summary.as_deref());
        push_optional_string(&mut output, event.attention_reason.as_deref());
        output.push(evidence_type_code(event.evidence_type));
        output.push(evidence_level_code(event.evidence_level));
        output.extend_from_slice(&event.sequence.to_be_bytes());
        push_string(&mut output, &event.occurred_at);
        push_string(&mut output, &event.received_at);
        push_optional_string(&mut output, event.started_at.as_deref());
        push_string(&mut output, &event.updated_at);
        push_optional_string(&mut output, event.completed_at.as_deref());
        output.push(finality_code(event.finality));
        push_return_action(&mut output, event.return_action.as_ref());
        push_string(&mut output, &event.payload_digest);
        push_optional_string(&mut output, event.raw_payload_ref.as_deref());
        Ok(output)
    }
}

fn push_string(output: &mut Vec<u8>, value: &str) {
    output.extend_from_slice(&(value.len() as u32).to_be_bytes());
    output.extend_from_slice(value.as_bytes());
}

fn push_optional_string(output: &mut Vec<u8>, value: Option<&str>) {
    match value {
        Some(value) => {
            output.push(1);
            push_string(output, value);
        }
        None => output.push(0),
    }
}

fn push_optional_progress(output: &mut Vec<u8>, value: Option<f32>) {
    match value {
        Some(value) => {
            output.push(1);
            output.extend_from_slice(&value.to_bits().to_be_bytes());
        }
        None => output.push(0),
    }
}

fn push_return_action(output: &mut Vec<u8>, value: Option<&ReturnAction>) {
    match value {
        Some(action) => {
            output.push(1);
            push_string(output, &action.action_id);
            push_optional_string(output, action.target.as_deref());
        }
        None => output.push(0),
    }
}

fn task_state_code(value: TaskState) -> u8 {
    match value {
        TaskState::Queued => 0,
        TaskState::Running => 1,
        TaskState::WaitingUser => 2,
        TaskState::Succeeded => 3,
        TaskState::Failed => 4,
        TaskState::Cancelled => 5,
        TaskState::Stalled => 6,
        TaskState::Unknown => 7,
    }
}

fn evidence_type_code(value: EvidenceType) -> u8 {
    match value {
        EvidenceType::Hook => 0,
        EvidenceType::Api => 1,
        EvidenceType::ExitCode => 2,
        EvidenceType::Process => 3,
        EvidenceType::User => 4,
        EvidenceType::Inferred => 5,
    }
}

fn evidence_level_code(value: EvidenceLevel) -> u8 {
    match value {
        EvidenceLevel::Authoritative => 0,
        EvidenceLevel::Partial => 1,
        EvidenceLevel::PresenceOnly => 2,
        EvidenceLevel::Unknown => 3,
    }
}

fn finality_code(value: EventFinality) -> u8 {
    match value {
        EventFinality::Provisional => 0,
        EventFinality::Terminal => 1,
        EventFinality::Corrected => 2,
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct TaskEventV1 {
    pub event_id: String,
    pub connector_id: String,
    pub source_instance: String,
    pub task_id: String,
    pub run_id: String,
    #[serde(default)]
    pub parent_task_id: Option<String>,
    pub source: String,
    pub external_id: String,
    pub title: String,
    #[serde(default)]
    pub workspace: Option<String>,
    pub state: TaskState,
    #[serde(default)]
    pub progress: Option<f32>,
    #[serde(default)]
    pub summary: Option<String>,
    #[serde(default)]
    pub attention_reason: Option<String>,
    pub evidence_type: EvidenceType,
    pub evidence_level: EvidenceLevel,
    pub sequence: u64,
    pub occurred_at: String,
    pub received_at: String,
    #[serde(default)]
    pub started_at: Option<String>,
    pub updated_at: String,
    #[serde(default)]
    pub completed_at: Option<String>,
    pub finality: EventFinality,
    #[serde(default)]
    pub return_action: Option<ReturnAction>,
    pub payload_digest: String,
    #[serde(default)]
    pub raw_payload_ref: Option<String>,
}

impl TaskEventV1 {
    pub fn validate(&self) -> Result<(), ProtocolValidationError> {
        validate_required("event_id", &self.event_id, MAX_IDENTIFIER_LENGTH)?;
        validate_required("connector_id", &self.connector_id, MAX_IDENTIFIER_LENGTH)?;
        validate_required(
            "source_instance",
            &self.source_instance,
            MAX_IDENTIFIER_LENGTH,
        )?;
        validate_required("task_id", &self.task_id, MAX_IDENTIFIER_LENGTH)?;
        validate_required("run_id", &self.run_id, MAX_IDENTIFIER_LENGTH)?;
        validate_optional(
            "parent_task_id",
            self.parent_task_id.as_deref(),
            MAX_IDENTIFIER_LENGTH,
        )?;
        if self.parent_task_id.as_deref() == Some(self.task_id.as_str()) {
            return Err(ProtocolValidationError::SelfParentTask);
        }
        validate_source(&self.source)?;
        validate_required("external_id", &self.external_id, MAX_IDENTIFIER_LENGTH)?;
        validate_required("title", &self.title, MAX_TITLE_LENGTH)?;
        validate_optional("workspace", self.workspace.as_deref(), MAX_WORKSPACE_LENGTH)?;
        validate_optional("summary", self.summary.as_deref(), MAX_SUMMARY_LENGTH)?;
        validate_optional(
            "attention_reason",
            self.attention_reason.as_deref(),
            MAX_ATTENTION_REASON_LENGTH,
        )?;
        validate_required("occurred_at", &self.occurred_at, MAX_IDENTIFIER_LENGTH)?;
        validate_required("received_at", &self.received_at, MAX_IDENTIFIER_LENGTH)?;
        validate_optional(
            "started_at",
            self.started_at.as_deref(),
            MAX_IDENTIFIER_LENGTH,
        )?;
        validate_required("updated_at", &self.updated_at, MAX_IDENTIFIER_LENGTH)?;
        validate_optional(
            "completed_at",
            self.completed_at.as_deref(),
            MAX_IDENTIFIER_LENGTH,
        )?;
        validate_required(
            "payload_digest",
            &self.payload_digest,
            MAX_IDENTIFIER_LENGTH,
        )?;
        validate_optional(
            "raw_payload_ref",
            self.raw_payload_ref.as_deref(),
            MAX_PAYLOAD_REFERENCE_LENGTH,
        )?;

        if let Some(progress) = self.progress {
            if !progress.is_finite() || !(0.0..=1.0).contains(&progress) {
                return Err(ProtocolValidationError::InvalidProgress(progress));
            }
        }

        match (self.state.is_terminal(), self.finality) {
            (true, EventFinality::Provisional) => {
                return Err(ProtocolValidationError::TerminalStateIsProvisional)
            }
            (false, EventFinality::Terminal | EventFinality::Corrected) => {
                return Err(ProtocolValidationError::NonTerminalStateIsFinal)
            }
            _ => {}
        }

        if self.state == TaskState::WaitingUser
            && self
                .attention_reason
                .as_deref()
                .is_none_or(|reason| reason.trim().is_empty())
        {
            return Err(ProtocolValidationError::WaitingUserWithoutReason);
        }

        if let Some(action) = &self.return_action {
            action.validate()?;
        }

        Ok(())
    }
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum TaskState {
    Queued,
    Running,
    WaitingUser,
    Succeeded,
    Failed,
    Cancelled,
    Stalled,
    Unknown,
}

impl TaskState {
    pub fn is_terminal(self) -> bool {
        matches!(self, Self::Succeeded | Self::Failed | Self::Cancelled)
    }

    fn can_transition_to(self, next: Self) -> bool {
        match self {
            Self::Queued => true,
            Self::Running => !matches!(next, Self::Queued),
            Self::WaitingUser => !matches!(next, Self::Queued),
            Self::Stalled => !matches!(next, Self::Queued),
            Self::Unknown => true,
            Self::Succeeded | Self::Failed | Self::Cancelled => false,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TransitionDecision {
    Apply,
    StartNewRun,
    CorrectTerminal,
    IgnoreDuplicate,
    IgnoreStale,
    IgnoreRepeatedTerminal,
}

pub fn decide_transition(
    previous: &TaskEventV1,
    next: &TaskEventV1,
) -> Result<TransitionDecision, TransitionError> {
    previous.validate()?;
    next.validate()?;
    validate_same_task(previous, next)?;

    if previous.event_id == next.event_id {
        return Ok(TransitionDecision::IgnoreDuplicate);
    }

    if next.sequence < previous.sequence {
        return Ok(TransitionDecision::IgnoreStale);
    }
    if next.sequence == previous.sequence {
        return Err(TransitionError::SequenceCollision(next.sequence));
    }

    if previous.run_id != next.run_id {
        if previous.state.is_terminal() {
            return Ok(TransitionDecision::StartNewRun);
        }
        return Err(TransitionError::ActiveRunReplacement {
            current_run_id: previous.run_id.clone(),
            next_run_id: next.run_id.clone(),
        });
    }

    if previous.state.is_terminal() {
        if previous.evidence_level != EvidenceLevel::Authoritative {
            if previous.state == next.state
                && evidence_strength(next.evidence_level)
                    >= evidence_strength(previous.evidence_level)
            {
                return Ok(TransitionDecision::IgnoreRepeatedTerminal);
            }
            if next.state == TaskState::Queued {
                return Err(TransitionError::IllegalTransition {
                    previous: previous.state,
                    next: next.state,
                });
            }
            return Ok(TransitionDecision::Apply);
        }
        if next.finality == EventFinality::Corrected {
            return Ok(TransitionDecision::CorrectTerminal);
        }
        if previous.state == next.state {
            return Ok(TransitionDecision::IgnoreRepeatedTerminal);
        }
        return Err(TransitionError::TerminalCorrectionRequired {
            previous: previous.state,
            next: next.state,
        });
    }

    if previous.state.can_transition_to(next.state) {
        Ok(TransitionDecision::Apply)
    } else {
        Err(TransitionError::IllegalTransition {
            previous: previous.state,
            next: next.state,
        })
    }
}

fn evidence_strength(level: EvidenceLevel) -> u8 {
    match level {
        EvidenceLevel::Authoritative => 0,
        EvidenceLevel::Partial => 1,
        EvidenceLevel::PresenceOnly => 2,
        EvidenceLevel::Unknown => 3,
    }
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum EvidenceType {
    Hook,
    Api,
    ExitCode,
    Process,
    User,
    Inferred,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum EvidenceLevel {
    Authoritative,
    Partial,
    PresenceOnly,
    Unknown,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum EventFinality {
    Provisional,
    Terminal,
    Corrected,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct ReturnAction {
    pub action_id: String,
    #[serde(default)]
    pub target: Option<String>,
}

impl ReturnAction {
    fn validate(&self) -> Result<(), ProtocolValidationError> {
        validate_action_id(&self.action_id)?;
        validate_optional(
            "return_action.target",
            self.target.as_deref(),
            MAX_RETURN_TARGET_LENGTH,
        )
    }
}

#[derive(Debug, Error, PartialEq)]
pub enum ProtocolValidationError {
    #[error("unsupported task event protocol version {0}")]
    UnsupportedProtocolVersion(u16),
    #[error("{0} must not be blank")]
    BlankField(&'static str),
    #[error("{field} exceeds its maximum length of {maximum}")]
    FieldTooLong { field: &'static str, maximum: usize },
    #[error("source must be a lowercase namespace such as openai.codex")]
    InvalidSource,
    #[error("return action id must contain only lowercase ASCII letters, digits, dots, underscores or hyphens")]
    InvalidReturnAction,
    #[error("progress must be finite and between 0 and 1, got {0}")]
    InvalidProgress(f32),
    #[error("terminal task states cannot be provisional")]
    TerminalStateIsProvisional,
    #[error("non-terminal task states cannot be terminal or corrected")]
    NonTerminalStateIsFinal,
    #[error("waiting_user requires a non-empty attention_reason")]
    WaitingUserWithoutReason,
    #[error("a task cannot name itself as its parent")]
    SelfParentTask,
}

#[derive(Debug, Error, PartialEq)]
pub enum TransitionError {
    #[error(transparent)]
    InvalidEvent(#[from] ProtocolValidationError),
    #[error("task identity field {0} differs between events")]
    TaskIdentityMismatch(&'static str),
    #[error("sequence {0} was reused by a different event")]
    SequenceCollision(u64),
    #[error("active run {current_run_id} cannot be replaced by {next_run_id}")]
    ActiveRunReplacement {
        current_run_id: String,
        next_run_id: String,
    },
    #[error("terminal transition from {previous:?} to {next:?} requires corrected finality")]
    TerminalCorrectionRequired {
        previous: TaskState,
        next: TaskState,
    },
    #[error("illegal task state transition from {previous:?} to {next:?}")]
    IllegalTransition {
        previous: TaskState,
        next: TaskState,
    },
}

fn validate_required(
    field: &'static str,
    value: &str,
    maximum: usize,
) -> Result<(), ProtocolValidationError> {
    if value.trim().is_empty() {
        return Err(ProtocolValidationError::BlankField(field));
    }
    if value.len() > maximum {
        return Err(ProtocolValidationError::FieldTooLong { field, maximum });
    }
    Ok(())
}

fn validate_optional(
    field: &'static str,
    value: Option<&str>,
    maximum: usize,
) -> Result<(), ProtocolValidationError> {
    if let Some(value) = value {
        validate_required(field, value, maximum)?;
    }
    Ok(())
}

fn validate_source(source: &str) -> Result<(), ProtocolValidationError> {
    validate_required("source", source, MAX_IDENTIFIER_LENGTH)?;
    let valid = source.contains('.')
        && source.bytes().all(|byte| {
            byte.is_ascii_lowercase() || byte.is_ascii_digit() || b".-_".contains(&byte)
        })
        && !source.starts_with('.')
        && !source.ends_with('.')
        && !source.contains("..");
    if valid {
        Ok(())
    } else {
        Err(ProtocolValidationError::InvalidSource)
    }
}

fn validate_action_id(action_id: &str) -> Result<(), ProtocolValidationError> {
    let valid = !action_id.is_empty()
        && action_id.len() <= MAX_IDENTIFIER_LENGTH
        && action_id.bytes().all(|byte| {
            byte.is_ascii_lowercase() || byte.is_ascii_digit() || b".-_".contains(&byte)
        });
    if valid {
        Ok(())
    } else {
        Err(ProtocolValidationError::InvalidReturnAction)
    }
}

fn validate_same_task(previous: &TaskEventV1, next: &TaskEventV1) -> Result<(), TransitionError> {
    let fields = [
        ("connector_id", &previous.connector_id, &next.connector_id),
        (
            "source_instance",
            &previous.source_instance,
            &next.source_instance,
        ),
        ("source", &previous.source, &next.source),
        ("task_id", &previous.task_id, &next.task_id),
        ("external_id", &previous.external_id, &next.external_id),
    ];
    for (field, previous, next) in fields {
        if previous != next {
            return Err(TransitionError::TaskIdentityMismatch(field));
        }
    }
    if previous.workspace != next.workspace {
        return Err(TransitionError::TaskIdentityMismatch("workspace"));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn event(state: TaskState, finality: EventFinality) -> TaskEventV1 {
        TaskEventV1 {
            event_id: "evt-1".into(),
            connector_id: "connector-1".into(),
            source_instance: "codex-install-1".into(),
            task_id: "task-1".into(),
            run_id: "run-1".into(),
            parent_task_id: None,
            source: "openai.codex".into(),
            external_id: "thread-1".into(),
            title: "Build Yuanyuan".into(),
            workspace: Some("yuanyuan-reminder".into()),
            state,
            progress: None,
            summary: None,
            attention_reason: (state == TaskState::WaitingUser)
                .then(|| "permission required".into()),
            evidence_type: EvidenceType::Hook,
            evidence_level: EvidenceLevel::Authoritative,
            sequence: 1,
            occurred_at: "2026-08-03T12:00:00Z".into(),
            received_at: "2026-08-03T12:00:00Z".into(),
            started_at: Some("2026-08-03T11:59:00Z".into()),
            updated_at: "2026-08-03T12:00:00Z".into(),
            completed_at: state.is_terminal().then(|| "2026-08-03T12:00:00Z".into()),
            finality,
            return_action: Some(ReturnAction {
                action_id: "open.codex.task".into(),
                target: Some("thread-1".into()),
            }),
            payload_digest: "sha256:0123456789abcdef".into(),
            raw_payload_ref: None,
        }
    }

    #[test]
    fn accepts_a_valid_authoritative_running_event() {
        let envelope = TaskEventEnvelope {
            protocol_version: TASK_EVENT_PROTOCOL_VERSION,
            event: event(TaskState::Running, EventFinality::Provisional),
        };

        assert_eq!(envelope.validate(), Ok(()));
    }

    #[test]
    fn accepts_unknown_json_fields_for_forward_compatibility() {
        let json = serde_json::to_value(TaskEventEnvelope {
            protocol_version: TASK_EVENT_PROTOCOL_VERSION,
            event: event(TaskState::Succeeded, EventFinality::Terminal),
        })
        .unwrap();
        let mut json = json.as_object().unwrap().clone();
        json.insert("future_envelope_field".into(), serde_json::json!(true));
        json.get_mut("event")
            .unwrap()
            .as_object_mut()
            .unwrap()
            .insert("future_event_field".into(), serde_json::json!("ignored"));

        let parsed: TaskEventEnvelope = serde_json::from_value(json.into()).unwrap();
        assert_eq!(parsed.validate(), Ok(()));
    }

    #[test]
    fn rejects_an_unsupported_protocol_version() {
        let envelope = TaskEventEnvelope {
            protocol_version: TASK_EVENT_PROTOCOL_VERSION + 1,
            event: event(TaskState::Running, EventFinality::Provisional),
        };

        assert_eq!(
            envelope.validate(),
            Err(ProtocolValidationError::UnsupportedProtocolVersion(2))
        );
    }

    #[test]
    fn rejects_invalid_progress() {
        let mut event = event(TaskState::Running, EventFinality::Provisional);
        event.progress = Some(1.01);

        assert_eq!(
            event.validate(),
            Err(ProtocolValidationError::InvalidProgress(1.01))
        );
    }

    #[test]
    fn terminal_states_require_terminal_or_corrected_finality() {
        let event = event(TaskState::Succeeded, EventFinality::Provisional);
        assert_eq!(
            event.validate(),
            Err(ProtocolValidationError::TerminalStateIsProvisional)
        );
    }

    #[test]
    fn non_terminal_states_cannot_claim_finality() {
        let event = event(TaskState::Running, EventFinality::Terminal);
        assert_eq!(
            event.validate(),
            Err(ProtocolValidationError::NonTerminalStateIsFinal)
        );
    }

    #[test]
    fn waiting_user_requires_a_reason() {
        let mut event = event(TaskState::WaitingUser, EventFinality::Provisional);
        event.attention_reason = None;
        assert_eq!(
            event.validate(),
            Err(ProtocolValidationError::WaitingUserWithoutReason)
        );
    }

    #[test]
    fn task_cannot_be_its_own_parent() {
        let mut event = event(TaskState::Running, EventFinality::Provisional);
        event.parent_task_id = Some(event.task_id.clone());

        assert_eq!(
            event.validate(),
            Err(ProtocolValidationError::SelfParentTask)
        );
    }

    #[test]
    fn source_must_be_namespaced() {
        let mut event = event(TaskState::Running, EventFinality::Provisional);
        event.source = "codex".into();
        assert_eq!(
            event.validate(),
            Err(ProtocolValidationError::InvalidSource)
        );
    }

    #[test]
    fn return_action_rejects_uri_like_action_ids() {
        let mut event = event(TaskState::Running, EventFinality::Provisional);
        event.return_action = Some(ReturnAction {
            action_id: "file://secret".into(),
            target: None,
        });
        assert_eq!(
            event.validate(),
            Err(ProtocolValidationError::InvalidReturnAction)
        );
    }

    #[test]
    fn oversized_summaries_are_rejected() {
        let mut event = event(TaskState::Running, EventFinality::Provisional);
        event.summary = Some("x".repeat(MAX_SUMMARY_LENGTH + 1));
        assert_eq!(
            event.validate(),
            Err(ProtocolValidationError::FieldTooLong {
                field: "summary",
                maximum: MAX_SUMMARY_LENGTH,
            })
        );
    }

    #[test]
    fn duplicate_event_ids_are_ignored() {
        let previous = event(TaskState::Running, EventFinality::Provisional);
        let mut next = previous.clone();
        next.sequence += 1;

        assert_eq!(
            decide_transition(&previous, &next),
            Ok(TransitionDecision::IgnoreDuplicate)
        );
    }

    #[test]
    fn lower_sequences_are_ignored_as_stale() {
        let mut previous = event(TaskState::Running, EventFinality::Provisional);
        previous.sequence = 5;
        let mut next = event(TaskState::WaitingUser, EventFinality::Provisional);
        next.event_id = "evt-2".into();
        next.sequence = 4;

        assert_eq!(
            decide_transition(&previous, &next),
            Ok(TransitionDecision::IgnoreStale)
        );
    }

    #[test]
    fn reused_sequences_with_different_ids_are_rejected() {
        let previous = event(TaskState::Running, EventFinality::Provisional);
        let mut next = event(TaskState::WaitingUser, EventFinality::Provisional);
        next.event_id = "evt-2".into();

        assert_eq!(
            decide_transition(&previous, &next),
            Err(TransitionError::SequenceCollision(1))
        );
    }

    #[test]
    fn a_new_run_is_kept_separate() {
        let previous = event(TaskState::Failed, EventFinality::Terminal);
        let mut next = event(TaskState::Running, EventFinality::Provisional);
        next.event_id = "evt-2".into();
        next.run_id = "run-2".into();
        next.sequence = 2;

        assert_eq!(
            decide_transition(&previous, &next),
            Ok(TransitionDecision::StartNewRun)
        );
    }

    #[test]
    fn an_active_run_cannot_be_silently_replaced() {
        let previous = event(TaskState::Running, EventFinality::Provisional);
        let mut next = event(TaskState::Running, EventFinality::Provisional);
        next.event_id = "evt-2".into();
        next.run_id = "run-2".into();
        next.sequence = 2;

        assert_eq!(
            decide_transition(&previous, &next),
            Err(TransitionError::ActiveRunReplacement {
                current_run_id: "run-1".into(),
                next_run_id: "run-2".into(),
            })
        );
    }

    #[test]
    fn terminal_states_require_an_explicit_correction() {
        let previous = event(TaskState::Failed, EventFinality::Terminal);
        let mut next = event(TaskState::Succeeded, EventFinality::Terminal);
        next.event_id = "evt-2".into();
        next.sequence = 2;

        assert_eq!(
            decide_transition(&previous, &next),
            Err(TransitionError::TerminalCorrectionRequired {
                previous: TaskState::Failed,
                next: TaskState::Succeeded,
            })
        );

        next.finality = EventFinality::Corrected;
        assert_eq!(
            decide_transition(&previous, &next),
            Ok(TransitionDecision::CorrectTerminal)
        );
    }

    #[test]
    fn partial_terminal_claim_does_not_lock_out_continued_running() {
        let mut previous = event(TaskState::Succeeded, EventFinality::Terminal);
        previous.evidence_level = EvidenceLevel::Partial;
        let mut next = event(TaskState::Running, EventFinality::Provisional);
        next.event_id = "evt-2".into();
        next.sequence = 2;
        next.completed_at = None;

        assert_eq!(
            decide_transition(&previous, &next),
            Ok(TransitionDecision::Apply)
        );
    }

    #[test]
    fn stronger_evidence_can_resolve_an_unconfirmed_terminal_claim() {
        let mut previous = event(TaskState::Failed, EventFinality::Terminal);
        previous.evidence_level = EvidenceLevel::Partial;
        let mut next = event(TaskState::Succeeded, EventFinality::Terminal);
        next.event_id = "evt-2".into();
        next.sequence = 2;

        assert_eq!(
            decide_transition(&previous, &next),
            Ok(TransitionDecision::Apply)
        );

        next.state = TaskState::Failed;
        assert_eq!(
            decide_transition(&previous, &next),
            Ok(TransitionDecision::Apply)
        );
    }

    #[test]
    fn repeated_unconfirmed_terminal_without_stronger_evidence_is_ignored() {
        let mut previous = event(TaskState::Succeeded, EventFinality::Terminal);
        previous.evidence_level = EvidenceLevel::Partial;
        let mut next = previous.clone();
        next.event_id = "evt-2".into();
        next.sequence = 2;

        assert_eq!(
            decide_transition(&previous, &next),
            Ok(TransitionDecision::IgnoreRepeatedTerminal)
        );
        next.evidence_level = EvidenceLevel::Unknown;
        assert_eq!(
            decide_transition(&previous, &next),
            Ok(TransitionDecision::IgnoreRepeatedTerminal)
        );
    }

    #[test]
    fn queued_cannot_reappear_mid_run() {
        let previous = event(TaskState::Running, EventFinality::Provisional);
        let mut next = event(TaskState::Queued, EventFinality::Provisional);
        next.event_id = "evt-2".into();
        next.sequence = 2;

        assert_eq!(
            decide_transition(&previous, &next),
            Err(TransitionError::IllegalTransition {
                previous: TaskState::Running,
                next: TaskState::Queued,
            })
        );
    }

    #[test]
    fn task_identity_cannot_change_within_a_transition() {
        let previous = event(TaskState::Running, EventFinality::Provisional);
        let mut next = event(TaskState::Succeeded, EventFinality::Terminal);
        next.event_id = "evt-2".into();
        next.sequence = 2;
        next.workspace = Some("another-workspace".into());

        assert_eq!(
            decide_transition(&previous, &next),
            Err(TransitionError::TaskIdentityMismatch("workspace"))
        );
    }

    #[test]
    fn authentication_message_is_deterministic_and_covers_known_fields() {
        let envelope = TaskEventEnvelope {
            protocol_version: TASK_EVENT_PROTOCOL_VERSION,
            event: event(TaskState::Running, EventFinality::Provisional),
        };
        let first = envelope.authentication_message().unwrap();
        let second = envelope.authentication_message().unwrap();
        assert_eq!(first, second);

        let mut changed = envelope.clone();
        changed.event.summary = Some("different summary".into());
        assert_ne!(first, changed.authentication_message().unwrap());
    }

    #[test]
    fn authentication_message_uses_length_prefixes_for_unambiguous_fields() {
        let mut left = TaskEventEnvelope {
            protocol_version: TASK_EVENT_PROTOCOL_VERSION,
            event: event(TaskState::Running, EventFinality::Provisional),
        };
        left.event.event_id = "ab".into();
        left.event.connector_id = "c".into();

        let mut right = left.clone();
        right.event.event_id = "a".into();
        right.event.connector_id = "bc".into();

        assert_ne!(
            left.authentication_message().unwrap(),
            right.authentication_message().unwrap()
        );
    }
}
