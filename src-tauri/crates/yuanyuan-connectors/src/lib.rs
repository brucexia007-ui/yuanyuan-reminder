use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};
use thiserror::Error;
use yuanyuan_protocol::{
    EventFinality, EvidenceLevel, EvidenceType, ProtocolValidationError, TaskEventEnvelope,
    TaskEventV1, TaskState, TASK_EVENT_PROTOCOL_VERSION,
};

pub mod config_edit;
pub mod config_preview;

pub const MAX_CONNECTOR_PAYLOAD_BYTES: usize = 64 * 1024;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ConnectorKind {
    CodexNotify,
    CodexHooks,
    ClaudeCodeHooks,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ConnectorContext {
    pub connector_id: String,
    pub source_instance: String,
    pub received_at: String,
    pub ingress_sequence: u64,
    /// A user-approved alias such as "yuanyuan". Raw `cwd` values are never copied.
    pub workspace_alias: Option<String>,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum Compatibility {
    /// The event shape is grounded in the current official documentation, but
    /// this particular payload is still synthetic rather than a real capture.
    OfficialSchemaSyntheticPayload,
    /// The source declared a schema version outside the verified range.
    UnknownSourceVersion,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum DiagnosticCode {
    MissingSourceTimestamp,
    MissingSourceSequence,
    UnknownSourceVersion,
    AmbiguousTerminalMeaning,
    ToolFailureIsNotTaskFailure,
    SensitiveFieldsDiscarded,
}

#[derive(Debug, Clone, PartialEq)]
pub struct ParsedConnectorEvent {
    pub envelope: TaskEventEnvelope,
    pub source_event_name: String,
    pub compatibility: Compatibility,
    pub diagnostics: Vec<DiagnosticCode>,
    pub discarded_sensitive_fields: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum IgnoreReason {
    UnsupportedEvent(String),
    MissingEventName,
    MissingStableIdentity,
}

#[derive(Debug, Clone, PartialEq)]
pub enum ConnectorDisposition {
    Event(Box<ParsedConnectorEvent>),
    Ignored(IgnoreReason),
}

#[derive(Debug, Error, PartialEq)]
pub enum ConnectorError {
    #[error("connector payload exceeds the 64 KiB limit")]
    PayloadTooLarge,
    #[error("connector payload is not valid JSON")]
    InvalidJson,
    #[error("connector payload must be a JSON object")]
    PayloadMustBeObject,
    #[error("connector context field {0} must not be blank")]
    InvalidContext(&'static str),
    #[error(transparent)]
    InvalidProtocolEvent(#[from] ProtocolValidationError),
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct HookExitContract {
    pub exit_code: i32,
    pub stdout: &'static [u8],
}

/// Hook-facing adapters must never make a source tool wait for a decision.
/// This contract is intentionally independent from parse/delivery success.
pub fn fail_open_hook_exit() -> HookExitContract {
    HookExitContract {
        exit_code: 0,
        stdout: b"",
    }
}

pub fn parse_connector_payload(
    kind: ConnectorKind,
    payload: &[u8],
    context: &ConnectorContext,
) -> Result<ConnectorDisposition, ConnectorError> {
    validate_context(context)?;
    if payload.len() > MAX_CONNECTOR_PAYLOAD_BYTES {
        return Err(ConnectorError::PayloadTooLarge);
    }

    let value: Value = serde_json::from_slice(payload).map_err(|_| ConnectorError::InvalidJson)?;
    let object = value
        .as_object()
        .ok_or(ConnectorError::PayloadMustBeObject)?;
    let event_name = event_name(kind, &value).ok_or(ConnectorDisposition::Ignored(
        IgnoreReason::MissingEventName,
    ));
    let event_name = match event_name {
        Ok(name) => name,
        Err(disposition) => return Ok(disposition),
    };

    let identity = first_string(
        &value,
        &[
            "task_id",
            "thread_id",
            "thread-id",
            "conversation_id",
            "session_id",
        ],
    );
    let Some(identity) = identity else {
        return Ok(ConnectorDisposition::Ignored(
            IgnoreReason::MissingStableIdentity,
        ));
    };

    let canonical_payload = serde_json::to_vec(&value).map_err(|_| ConnectorError::InvalidJson)?;
    let payload_digest = hex_digest(&canonical_payload);
    let declared_version = first_string(
        &value,
        &["schema_version", "hook_schema_version", "protocol_version"],
    );
    let compatibility = if declared_version.is_some() {
        Compatibility::UnknownSourceVersion
    } else {
        Compatibility::OfficialSchemaSyntheticPayload
    };

    let Some(mut meaning) = map_meaning(kind, &event_name, &value) else {
        return Ok(ConnectorDisposition::Ignored(
            IgnoreReason::UnsupportedEvent(event_name),
        ));
    };

    let mut diagnostics = meaning.diagnostics;
    if compatibility == Compatibility::UnknownSourceVersion {
        meaning.state = TaskState::Unknown;
        meaning.evidence_level = EvidenceLevel::Unknown;
        meaning.finality = EventFinality::Provisional;
        meaning.completed = false;
        diagnostics.push(DiagnosticCode::UnknownSourceVersion);
    }

    let occurred_at = first_string(&value, &["occurred_at", "timestamp"])
        .map(str::to_owned)
        .unwrap_or_else(|| {
            diagnostics.push(DiagnosticCode::MissingSourceTimestamp);
            context.received_at.clone()
        });
    let sequence = first_u64(&value, &["sequence", "event_sequence"]).unwrap_or_else(|| {
        diagnostics.push(DiagnosticCode::MissingSourceSequence);
        context.ingress_sequence
    });
    let discarded_sensitive_fields = sensitive_fields_present(object);
    if !discarded_sensitive_fields.is_empty() {
        diagnostics.push(DiagnosticCode::SensitiveFieldsDiscarded);
    }

    let source = match kind {
        ConnectorKind::CodexNotify | ConnectorKind::CodexHooks => "openai.codex",
        ConnectorKind::ClaudeCodeHooks => "anthropic.claude-code",
    };
    let source_label = match kind {
        ConnectorKind::CodexNotify | ConnectorKind::CodexHooks => "Codex 任务",
        ConnectorKind::ClaudeCodeHooks => "Claude Code 任务",
    };
    let external_id = opaque_id("external", &format!("{source}\0{identity}"));
    let task_id = opaque_id(
        "task",
        &format!(
            "{}\0{}\0{}\0{}",
            source,
            context.source_instance,
            context.workspace_alias.as_deref().unwrap_or(""),
            identity
        ),
    );
    let run_identity = first_string(&value, &["run_id", "session_id"]).unwrap_or(identity);
    let run_id = opaque_id("run", &format!("{source}\0{run_identity}"));
    let event_id = opaque_id(
        "event",
        &format!("{source}\0{}\0{payload_digest}", context.source_instance),
    );

    let event = TaskEventV1 {
        event_id,
        connector_id: context.connector_id.clone(),
        source_instance: context.source_instance.clone(),
        task_id,
        run_id,
        parent_task_id: None,
        source: source.to_owned(),
        external_id,
        title: source_label.to_owned(),
        workspace: context.workspace_alias.clone(),
        state: meaning.state,
        progress: None,
        summary: Some(meaning.summary.to_owned()),
        attention_reason: meaning.attention_reason.map(str::to_owned),
        evidence_type: EvidenceType::Hook,
        evidence_level: meaning.evidence_level,
        sequence,
        occurred_at: occurred_at.clone(),
        received_at: context.received_at.clone(),
        started_at: (meaning.state == TaskState::Running).then_some(occurred_at.clone()),
        updated_at: occurred_at.clone(),
        completed_at: meaning.completed.then_some(occurred_at),
        finality: meaning.finality,
        return_action: None,
        payload_digest,
        raw_payload_ref: None,
    };
    let envelope = TaskEventEnvelope {
        protocol_version: TASK_EVENT_PROTOCOL_VERSION,
        event,
    };
    envelope.validate()?;

    Ok(ConnectorDisposition::Event(Box::new(
        ParsedConnectorEvent {
            envelope,
            source_event_name: event_name,
            compatibility,
            diagnostics,
            discarded_sensitive_fields,
        },
    )))
}

#[derive(Debug)]
struct EventMeaning {
    state: TaskState,
    evidence_level: EvidenceLevel,
    finality: EventFinality,
    completed: bool,
    summary: &'static str,
    attention_reason: Option<&'static str>,
    diagnostics: Vec<DiagnosticCode>,
}

fn map_meaning(kind: ConnectorKind, event_name: &str, value: &Value) -> Option<EventMeaning> {
    let name = normalized_event_name(event_name);
    match kind {
        ConnectorKind::CodexNotify => match name.as_str() {
            "agentturncomplete" => Some(terminal(
                TaskState::Succeeded,
                EvidenceLevel::Partial,
                "Codex 已结束本轮处理",
            )),
            _ => None,
        },
        ConnectorKind::CodexHooks => match name.as_str() {
            "sessionstart" | "userpromptsubmit" | "pretooluse" | "posttooluse" | "precompact"
            | "subagentstart" | "subagentstop" => Some(running("Codex 正在处理任务")),
            "permissionrequest" => Some(waiting(
                EvidenceLevel::Authoritative,
                "Codex 正在等待用户处理权限请求",
            )),
            "stop" | "sessionend" => Some(ambiguous("Codex 发出停止事件，无法据此确认任务结果")),
            _ => None,
        },
        ConnectorKind::ClaudeCodeHooks => match name.as_str() {
            "taskcreated" | "subagentstart" | "subagentstop" | "posttooluse" => {
                Some(running("Claude Code 正在处理任务"))
            }
            "permissionrequest" => Some(waiting(
                EvidenceLevel::Partial,
                "Claude Code 有一项内容需要用户查看",
            )),
            "notification" => claude_notification(value),
            "taskcompleted" => Some(terminal(
                TaskState::Succeeded,
                EvidenceLevel::Authoritative,
                "Claude Code 任务已完成",
            )),
            "posttoolusefailure" => Some(EventMeaning {
                diagnostics: vec![DiagnosticCode::ToolFailureIsNotTaskFailure],
                summary: "Claude Code 的一次工具调用失败，任务结果尚未确定",
                ..running("Claude Code 正在处理任务")
            }),
            "stopfailure" => Some(terminal(
                TaskState::Failed,
                EvidenceLevel::Partial,
                "Claude Code 本轮因接口错误结束",
            )),
            "stop" => Some(ambiguous("Claude Code 发出停止事件，无法据此确认任务结果")),
            _ => None,
        },
    }
}

fn claude_notification(value: &Value) -> Option<EventMeaning> {
    let notification_type = first_string(value, &["notification_type", "notificationType"])?;
    match normalized_event_name(notification_type).as_str() {
        "permissionprompt" | "idleprompt" | "elicitationdialog" | "agentneedsinput" => Some(
            waiting(EvidenceLevel::Partial, "Claude Code 有一项内容需要用户查看"),
        ),
        _ => None,
    }
}

fn running(summary: &'static str) -> EventMeaning {
    EventMeaning {
        state: TaskState::Running,
        evidence_level: EvidenceLevel::Partial,
        finality: EventFinality::Provisional,
        completed: false,
        summary,
        attention_reason: None,
        diagnostics: Vec::new(),
    }
}

fn waiting(level: EvidenceLevel, reason: &'static str) -> EventMeaning {
    EventMeaning {
        state: TaskState::WaitingUser,
        evidence_level: level,
        finality: EventFinality::Provisional,
        completed: false,
        summary: "外部任务正在等待用户",
        attention_reason: Some(reason),
        diagnostics: Vec::new(),
    }
}

fn terminal(state: TaskState, level: EvidenceLevel, summary: &'static str) -> EventMeaning {
    EventMeaning {
        state,
        evidence_level: level,
        finality: EventFinality::Terminal,
        completed: true,
        summary,
        attention_reason: None,
        diagnostics: Vec::new(),
    }
}

fn ambiguous(summary: &'static str) -> EventMeaning {
    EventMeaning {
        state: TaskState::Unknown,
        evidence_level: EvidenceLevel::Partial,
        finality: EventFinality::Provisional,
        completed: false,
        summary,
        attention_reason: None,
        diagnostics: vec![DiagnosticCode::AmbiguousTerminalMeaning],
    }
}

fn validate_context(context: &ConnectorContext) -> Result<(), ConnectorError> {
    for (field, value) in [
        ("connector_id", context.connector_id.as_str()),
        ("source_instance", context.source_instance.as_str()),
        ("received_at", context.received_at.as_str()),
    ] {
        if value.trim().is_empty() {
            return Err(ConnectorError::InvalidContext(field));
        }
    }
    Ok(())
}

fn event_name(kind: ConnectorKind, value: &Value) -> Option<String> {
    let keys: &[&str] = match kind {
        ConnectorKind::CodexNotify => &["type"],
        ConnectorKind::CodexHooks | ConnectorKind::ClaudeCodeHooks => {
            &["hook_event_name", "event_name", "type"]
        }
    };
    first_string(value, keys).map(str::to_owned)
}

fn first_string<'a>(value: &'a Value, keys: &[&str]) -> Option<&'a str> {
    keys.iter()
        .filter_map(|key| value.get(*key).and_then(Value::as_str))
        .find(|value| !value.trim().is_empty())
}

fn first_u64(value: &Value, keys: &[&str]) -> Option<u64> {
    keys.iter()
        .find_map(|key| value.get(*key).and_then(Value::as_u64))
}

fn normalized_event_name(value: &str) -> String {
    value
        .chars()
        .filter(|character| character.is_ascii_alphanumeric())
        .flat_map(char::to_lowercase)
        .collect()
}

fn sensitive_fields_present(object: &serde_json::Map<String, Value>) -> Vec<String> {
    const SENSITIVE: &[&str] = &[
        "cwd",
        "error",
        "error_details",
        "input_messages",
        "last_assistant_message",
        "message",
        "prompt",
        "task_description",
        "task_subject",
        "tool_input",
        "tool_response",
        "transcript_path",
    ];
    SENSITIVE
        .iter()
        .filter(|field| object.contains_key(**field))
        .map(|field| (*field).to_owned())
        .collect()
}

fn opaque_id(prefix: &str, value: &str) -> String {
    format!("{prefix}-{}", hex_digest(value.as_bytes()))
}

fn hex_digest(value: &[u8]) -> String {
    format!("{:x}", Sha256::digest(value))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn context(sequence: u64) -> ConnectorContext {
        ConnectorContext {
            connector_id: "connector-test".to_owned(),
            source_instance: "instance-test".to_owned(),
            received_at: "2026-08-04T10:00:00Z".to_owned(),
            ingress_sequence: sequence,
            workspace_alias: Some("yuanyuan".to_owned()),
        }
    }

    fn parsed(kind: ConnectorKind, fixture: &[u8], sequence: u64) -> ParsedConnectorEvent {
        match parse_connector_payload(kind, fixture, &context(sequence)).unwrap() {
            ConnectorDisposition::Event(event) => *event,
            other => panic!("expected event, got {other:?}"),
        }
    }

    #[test]
    fn codex_notify_completion_is_partial_terminal_and_discards_content() {
        let event = parsed(
            ConnectorKind::CodexNotify,
            include_bytes!("../tests/fixtures/codex/notify_succeeded.json"),
            10,
        );
        assert_eq!(event.envelope.event.state, TaskState::Succeeded);
        assert_eq!(event.envelope.event.evidence_level, EvidenceLevel::Partial);
        assert_eq!(event.envelope.event.finality, EventFinality::Terminal);
        assert_eq!(
            event.discarded_sensitive_fields,
            ["cwd", "input_messages", "last_assistant_message"]
        );
        let serialized = serde_json::to_string(&event.envelope).unwrap();
        assert!(!serialized.contains("secret prompt"));
        assert!(!serialized.contains("private source"));
    }

    #[test]
    fn codex_permission_request_waits_without_returning_a_decision() {
        let event = parsed(
            ConnectorKind::CodexHooks,
            include_bytes!("../tests/fixtures/codex/hook_waiting_user.json"),
            11,
        );
        assert_eq!(event.envelope.event.state, TaskState::WaitingUser);
        assert_eq!(fail_open_hook_exit().exit_code, 0);
        assert!(fail_open_hook_exit().stdout.is_empty());
    }

    #[test]
    fn codex_session_start_maps_to_running_without_copying_paths() {
        let event = parsed(
            ConnectorKind::CodexHooks,
            include_bytes!("../tests/fixtures/codex/hook_running.json"),
            10,
        );
        assert_eq!(event.envelope.event.state, TaskState::Running);
        assert_eq!(event.envelope.event.evidence_level, EvidenceLevel::Partial);
        assert_eq!(event.discarded_sensitive_fields, ["cwd", "transcript_path"]);
        let serialized = serde_json::to_string(&event.envelope).unwrap();
        assert!(!serialized.contains("private-project"));
        assert!(!serialized.contains("transcript"));
    }

    #[test]
    fn codex_stop_never_claims_success() {
        let event = parsed(
            ConnectorKind::CodexHooks,
            include_bytes!("../tests/fixtures/codex/hook_stop_ambiguous.json"),
            12,
        );
        assert_eq!(event.envelope.event.state, TaskState::Unknown);
        assert_eq!(event.envelope.event.finality, EventFinality::Provisional);
        assert!(event
            .diagnostics
            .contains(&DiagnosticCode::AmbiguousTerminalMeaning));
    }

    #[test]
    fn claude_core_states_map_conservatively() {
        let cases = [
            (
                include_bytes!("../tests/fixtures/claude/task_created.json").as_slice(),
                TaskState::Running,
            ),
            (
                include_bytes!("../tests/fixtures/claude/permission_request.json").as_slice(),
                TaskState::WaitingUser,
            ),
            (
                include_bytes!("../tests/fixtures/claude/task_completed_succeeded.json").as_slice(),
                TaskState::Succeeded,
            ),
        ];
        for (index, (fixture, expected)) in cases.into_iter().enumerate() {
            let event = parsed(ConnectorKind::ClaudeCodeHooks, fixture, index as u64 + 1);
            assert_eq!(event.envelope.event.state, expected);
        }
    }

    #[test]
    fn undocumented_task_completed_status_cannot_invent_failure_or_cancellation() {
        for fixture in [
            include_bytes!("../tests/fixtures/claude/task_completed_failed.json").as_slice(),
            include_bytes!("../tests/fixtures/claude/task_completed_cancelled.json").as_slice(),
        ] {
            let event = parsed(ConnectorKind::ClaudeCodeHooks, fixture, 4);
            assert_eq!(event.envelope.event.state, TaskState::Succeeded);
            assert_eq!(event.envelope.event.finality, EventFinality::Terminal);
        }
    }

    #[test]
    fn official_claude_stop_failure_is_a_partial_failure_without_error_content() {
        let event = parsed(
            ConnectorKind::ClaudeCodeHooks,
            br#"{
                "hook_event_name":"StopFailure",
                "session_id":"session-a",
                "error":"rate_limit",
                "error_details":"private provider response",
                "last_assistant_message":"private rendered error"
            }"#,
            5,
        );
        assert_eq!(event.envelope.event.state, TaskState::Failed);
        assert_eq!(event.envelope.event.evidence_level, EvidenceLevel::Partial);
        assert_eq!(
            event.discarded_sensitive_fields,
            ["error", "error_details", "last_assistant_message"]
        );
        let serialized = serde_json::to_string(&event.envelope).unwrap();
        assert!(!serialized.contains("private provider response"));
        assert!(!serialized.contains("private rendered error"));
    }

    #[test]
    fn tool_failure_does_not_become_task_failure() {
        let event = parsed(
            ConnectorKind::ClaudeCodeHooks,
            include_bytes!("../tests/fixtures/claude/post_tool_failure.json"),
            9,
        );
        assert_eq!(event.envelope.event.state, TaskState::Running);
        assert!(event
            .diagnostics
            .contains(&DiagnosticCode::ToolFailureIsNotTaskFailure));
    }

    #[test]
    fn duplicate_payload_has_a_stable_event_id_even_with_json_key_reordering() {
        let first = parsed(
            ConnectorKind::ClaudeCodeHooks,
            br#"{"hook_event_name":"TaskCreated","session_id":"session-a","task_id":"task-a"}"#,
            4,
        );
        let second = parsed(
            ConnectorKind::ClaudeCodeHooks,
            br#"{"task_id":"task-a","session_id":"session-a","hook_event_name":"TaskCreated"}"#,
            4,
        );
        assert_eq!(
            first.envelope.event.event_id,
            second.envelope.event.event_id
        );
        assert_eq!(
            first.envelope.event.payload_digest,
            second.envelope.event.payload_digest
        );
    }

    #[test]
    fn source_sequence_is_preserved_for_out_of_order_detection_downstream() {
        let newer = parsed(
            ConnectorKind::ClaudeCodeHooks,
            include_bytes!("../tests/fixtures/claude/out_of_order_newer.json"),
            1,
        );
        let older = parsed(
            ConnectorKind::ClaudeCodeHooks,
            include_bytes!("../tests/fixtures/claude/out_of_order_older.json"),
            2,
        );
        assert_eq!(newer.envelope.event.sequence, 8);
        assert_eq!(older.envelope.event.sequence, 7);
    }

    #[test]
    fn declared_unknown_version_cannot_emit_a_terminal_claim() {
        let event = parsed(
            ConnectorKind::ClaudeCodeHooks,
            include_bytes!("../tests/fixtures/claude/unknown_version_extra_fields.json"),
            3,
        );
        assert_eq!(event.compatibility, Compatibility::UnknownSourceVersion);
        assert_eq!(event.envelope.event.state, TaskState::Unknown);
        assert_eq!(event.envelope.event.finality, EventFinality::Provisional);
        assert_eq!(event.envelope.event.evidence_level, EvidenceLevel::Unknown);
    }

    #[test]
    fn missing_identity_and_unknown_events_are_ignored() {
        let missing = parse_connector_payload(
            ConnectorKind::CodexHooks,
            include_bytes!("../tests/fixtures/codex/missing_identity.json"),
            &context(1),
        )
        .unwrap();
        assert_eq!(
            missing,
            ConnectorDisposition::Ignored(IgnoreReason::MissingStableIdentity)
        );

        let unknown = parse_connector_payload(
            ConnectorKind::ClaudeCodeHooks,
            br#"{"hook_event_name":"FutureEvent","session_id":"session-a"}"#,
            &context(2),
        )
        .unwrap();
        assert_eq!(
            unknown,
            ConnectorDisposition::Ignored(IgnoreReason::UnsupportedEvent("FutureEvent".to_owned()))
        );
    }

    #[test]
    fn oversized_and_invalid_payloads_fail_open_at_the_hook_boundary() {
        assert_eq!(
            parse_connector_payload(
                ConnectorKind::CodexHooks,
                &vec![b'x'; MAX_CONNECTOR_PAYLOAD_BYTES + 1],
                &context(1)
            ),
            Err(ConnectorError::PayloadTooLarge)
        );
        assert_eq!(
            parse_connector_payload(ConnectorKind::CodexHooks, b"not-json", &context(1)),
            Err(ConnectorError::InvalidJson)
        );
        assert_eq!(
            fail_open_hook_exit(),
            HookExitContract {
                exit_code: 0,
                stdout: b""
            }
        );
    }

    #[test]
    fn fixture_manifest_marks_every_sample_as_non_authentic() {
        let manifest_path = format!(
            "{}/tests/fixtures/manifest.json",
            env!("CARGO_MANIFEST_DIR")
        );
        let manifest: Value =
            serde_json::from_slice(&std::fs::read(manifest_path).unwrap()).unwrap();
        let fixtures = manifest["fixtures"].as_array().unwrap();
        assert_eq!(fixtures.len(), 14);
        for fixture in fixtures {
            assert_eq!(fixture["authenticity"], "synthetic_contract");
            let relative_path = fixture["path"].as_str().unwrap();
            assert!(std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
                .join("tests/fixtures")
                .join(relative_path)
                .is_file());
        }
    }
}
