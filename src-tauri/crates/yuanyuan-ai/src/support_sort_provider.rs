use std::{
    ops::{Deref, DerefMut},
    time::Duration,
};

use serde_json::json;
use thiserror::Error;
use uuid::Uuid;
use zeroize::Zeroize;

use crate::support_sort_semantic_gate::validate_support_sort_semantics;
use crate::{
    start_provider_run, ProviderAdapter, ProviderOperation, ProviderRequest, ProviderRunError,
    ProviderRunHandle, ProviderUsage, SupportSortAuthorizationGate, SupportSortConsumeRejection,
    SupportSortProviderDescriptor,
};
use yuanyuan_protocol::{
    DisplayBlock, DisplayDocumentV1, DocumentConfidence, DocumentProvenance, DocumentSensitivity,
    IntentCompatibility, ResponseIntentKind, ResponsePriority,
};

const SUPPORT_SORT_INPUT_SCHEMA_VERSION: u16 = 1;
const MAX_USER_ENTERED_TEXT_BYTES: usize = 16 * 1024;
const SUPPORT_SORT_TIMEOUT: Duration = Duration::from_secs(30);

/// A one-shot adapter registration paired with a host-validated identity.
/// Production code must build this from trusted Rust configuration, never
/// from provider identity fields supplied by the frontend.
pub struct SupportSortProviderRegistration {
    descriptor: SupportSortProviderDescriptor,
    adapter: Box<dyn ProviderAdapter>,
}

impl SupportSortProviderRegistration {
    pub fn new(
        descriptor: SupportSortProviderDescriptor,
        adapter: Box<dyn ProviderAdapter>,
    ) -> Self {
        Self {
            descriptor,
            adapter,
        }
    }

    pub fn descriptor(&self) -> &SupportSortProviderDescriptor {
        &self.descriptor
    }
}

#[derive(Debug, Error)]
pub enum SupportSortProviderStartError {
    #[error("support sort user-entered text is invalid")]
    InvalidUserEnteredText,
    #[error("support sort authorization was rejected: {0}")]
    Authorization(#[from] SupportSortConsumeRejection),
    #[error("support sort provider could not start: {0}")]
    Provider(#[from] ProviderRunError),
}

#[derive(PartialEq, Eq)]
pub struct SupportSortOutcome {
    pub fact: String,
    pub feeling: String,
    pub controllable: String,
    pub next_step: String,
    pub usage: Option<ProviderUsage>,
}

impl SupportSortOutcome {
    fn zeroize_sensitive(&mut self) {
        self.fact.zeroize();
        self.feeling.zeroize();
        self.controllable.zeroize();
        self.next_step.zeroize();
    }
}

impl Drop for SupportSortOutcome {
    fn drop(&mut self) {
        self.zeroize_sensitive();
    }
}

/// Owns a parsed model document until its four validated cells are moved into
/// `SupportSortOutcome`. Every rejected structure or semantic result is
/// actively cleared instead of relying on ordinary allocator release.
struct SensitiveSupportSortDocument(DisplayDocumentV1);

impl Deref for SensitiveSupportSortDocument {
    type Target = DisplayDocumentV1;

    fn deref(&self) -> &Self::Target {
        &self.0
    }
}

impl DerefMut for SensitiveSupportSortDocument {
    fn deref_mut(&mut self) -> &mut Self::Target {
        &mut self.0
    }
}

impl Drop for SensitiveSupportSortDocument {
    fn drop(&mut self) {
        zeroize_display_document(&mut self.0);
    }
}

fn zeroize_display_document(document: &mut DisplayDocumentV1) {
    document.document_id.zeroize();
    if let Some(title) = &mut document.title {
        title.zeroize();
    }
    document.source_label.zeroize();
    for block in &mut document.blocks {
        match block {
            DisplayBlock::Heading { block_id, text, .. }
            | DisplayBlock::Paragraph { block_id, text } => {
                block_id.zeroize();
                text.zeroize();
            }
            DisplayBlock::List {
                block_id, items, ..
            } => {
                block_id.zeroize();
                items.iter_mut().for_each(Zeroize::zeroize);
            }
            DisplayBlock::Table {
                block_id,
                columns,
                rows,
            } => {
                block_id.zeroize();
                columns.iter_mut().for_each(Zeroize::zeroize);
                rows.iter_mut()
                    .flat_map(|row| row.iter_mut())
                    .for_each(Zeroize::zeroize);
            }
            DisplayBlock::Code {
                block_id,
                language,
                code,
            } => {
                block_id.zeroize();
                if let Some(language) = language {
                    language.zeroize();
                }
                code.zeroize();
            }
        }
    }
    for reference in &mut document.references {
        reference.reference_id.zeroize();
        reference.label.zeroize();
        reference.target_text.zeroize();
    }
    for action in &mut document.actions {
        action.action_id.zeroize();
        if let Some(target_id) = &mut action.target_id {
            target_id.zeroize();
        }
    }
}

#[derive(Debug, Error)]
pub enum SupportSortRunError {
    #[error("support sort provider run failed: {0}")]
    Provider(#[from] ProviderRunError),
    #[error("support sort provider returned an invalid four-part tool result")]
    InvalidOutput,
}

/// Dedicated result handle that strips the generic response intent and safe
/// display document after validating them. Callers receive only the four tool
/// fields and optional usage; model output cannot become cat dialogue through
/// this API.
pub struct SupportSortRunHandle {
    inner: ProviderRunHandle,
}

impl SupportSortRunHandle {
    pub fn cancel(&self) {
        self.inner.cancel();
    }

    pub fn wait(self) -> Result<SupportSortOutcome, SupportSortRunError> {
        self.wait_with_external_cancellation(|| false)
    }

    pub fn wait_with_external_cancellation<F>(
        self,
        should_cancel: F,
    ) -> Result<SupportSortOutcome, SupportSortRunError>
    where
        F: Fn() -> bool,
    {
        let outcome = self.inner.wait_with_external_cancellation(should_cancel)?;
        if outcome.response_intent.compatibility != IntentCompatibility::Exact
            || outcome.response_intent.intent != ResponseIntentKind::PresentInformation
            || outcome.response_intent.priority != ResponsePriority::Normal
        {
            return Err(SupportSortRunError::InvalidOutput);
        }
        let mut document = SensitiveSupportSortDocument(
            outcome
                .display_document
                .ok_or(SupportSortRunError::InvalidOutput)?,
        );
        if document.title.as_deref() != Some("理一理")
            || document.source_label != "整理结果（请核对）"
            || document.provenance != DocumentProvenance::ModelInferred
            || document.confidence != DocumentConfidence::Unknown
            || document.sensitivity != DocumentSensitivity::Sensitive
            || !document.references.is_empty()
            || !document.actions.is_empty()
            || document.blocks.len() != 1
        {
            return Err(SupportSortRunError::InvalidOutput);
        }
        let DisplayBlock::Table {
            block_id,
            columns,
            rows,
        } = &mut document.blocks[0]
        else {
            return Err(SupportSortRunError::InvalidOutput);
        };
        if block_id != "support-sort-grid"
            || columns != &["事实", "感受", "可控", "下一步"]
            || rows.len() != 1
            || rows[0].len() != 4
        {
            return Err(SupportSortRunError::InvalidOutput);
        }
        validate_support_sort_semantics(&rows[0][0], &rows[0][1], &rows[0][2], &rows[0][3])
            .map_err(|_| SupportSortRunError::InvalidOutput)?;
        let mut row = std::mem::take(&mut rows[0]);
        Ok(SupportSortOutcome {
            fact: std::mem::take(&mut row[0]),
            feeling: std::mem::take(&mut row[1]),
            controllable: std::mem::take(&mut row[2]),
            next_step: std::mem::take(&mut row[3]),
            usage: outcome.usage,
        })
    }
}

/// Starts the fixed-purpose "sort things out" operation after consuming an
/// exact, one-use provider authorization. The authorization token and provider
/// identity are host-side controls and are never included in provider input.
/// The provider receives only the fixed schema plus the text typed for this
/// invocation; task, memory, history, file and workspace context have no input
/// parameters here.
pub fn start_authorized_support_sort_run(
    gate: &mut SupportSortAuthorizationGate,
    registration: SupportSortProviderRegistration,
    authorization_token: &str,
    user_entered_text: &str,
    now_unix_ms: i64,
) -> Result<SupportSortRunHandle, SupportSortProviderStartError> {
    let SupportSortProviderRegistration {
        descriptor,
        adapter,
    } = registration;
    start_authorized_support_sort_run_with_factory(
        gate,
        &descriptor,
        authorization_token,
        user_entered_text,
        now_unix_ms,
        || adapter,
    )
}

/// Factory form used by a trusted registry. Local text validation and one-use
/// authorization consumption both happen before the adapter is constructed,
/// so replay, expiry and provider mismatch cannot initialize a transport or
/// credential-bearing client.
pub fn start_authorized_support_sort_run_with_factory<F>(
    gate: &mut SupportSortAuthorizationGate,
    descriptor: &SupportSortProviderDescriptor,
    authorization_token: &str,
    user_entered_text: &str,
    now_unix_ms: i64,
    factory: F,
) -> Result<SupportSortRunHandle, SupportSortProviderStartError>
where
    F: FnOnce() -> Box<dyn ProviderAdapter>,
{
    validate_user_entered_text(user_entered_text)?;
    gate.consume(
        authorization_token,
        descriptor.authorization_context(),
        now_unix_ms,
    )?;
    let adapter = factory();

    let request = ProviderRequest {
        request_id: format!("support-sort-{}", Uuid::new_v4()),
        operation: ProviderOperation::SupportSort,
        input: json!({
            "schema_version": SUPPORT_SORT_INPUT_SCHEMA_VERSION,
            "content_class": "user_entered_text",
            "user_entered_text": user_entered_text,
        }),
        timeout: SUPPORT_SORT_TIMEOUT,
    };
    Ok(SupportSortRunHandle {
        inner: start_provider_run(adapter, request)?,
    })
}

fn validate_user_entered_text(text: &str) -> Result<(), SupportSortProviderStartError> {
    if text.trim().is_empty()
        || text.len() > MAX_USER_ENTERED_TEXT_BYTES
        || text.chars().any(is_forbidden_control)
    {
        return Err(SupportSortProviderStartError::InvalidUserEnteredText);
    }
    Ok(())
}

fn is_forbidden_control(character: char) -> bool {
    matches!(
        character,
        '\0' | '\u{061c}'
            | '\u{200e}'
            | '\u{200f}'
            | '\u{202a}'..='\u{202e}'
            | '\u{2066}'..='\u{2069}'
    )
}

#[cfg(test)]
mod tests {
    use std::sync::{Arc, Mutex};

    use super::*;
    use crate::{
        CancellationToken, ProviderAdapterError, ProviderCapabilities, ProviderEvent,
        ProviderEventSink, ProviderFinal, SupportSortDestination, SupportSortProviderContext,
        SUPPORT_SORT_DISCLOSURE_VERSION,
    };

    const NOW: i64 = 1_775_212_800_000;
    const LOCAL_FINGERPRINT: &str =
        "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";

    struct CapturingAdapter {
        captured: Arc<Mutex<Option<ProviderRequest>>>,
        capabilities: ProviderCapabilities,
        final_output: ProviderFinal,
    }

    impl ProviderAdapter for CapturingAdapter {
        fn capabilities(&self) -> ProviderCapabilities {
            self.capabilities
        }

        fn run(
            self: Box<Self>,
            request: ProviderRequest,
            _cancellation: CancellationToken,
            events: ProviderEventSink,
        ) -> Result<(), ProviderAdapterError> {
            *self.captured.lock().unwrap() = Some(request);
            events.emit(ProviderEvent::Final(self.final_output))
        }
    }

    fn valid_document() -> serde_json::Value {
        json!({
            "schema_version": 1,
            "document_id": "support-sort-document",
            "title": "理一理",
            "source_label": "整理结果（请核对）",
            "provenance": "model_inferred",
            "confidence": "unknown",
            "sensitivity": "sensitive",
            "blocks": [{
                "type": "table",
                "block_id": "support-sort-grid",
                "columns": ["事实", "感受", "可控", "下一步"],
                "rows": [["需求发生了变化", "有些烦", "可以先确认范围", "列出三个待确认问题"]]
            }],
            "references": [],
            "actions": []
        })
    }

    fn final_with_document(document: serde_json::Value) -> ProviderFinal {
        ProviderFinal {
            response_intent_json:
                br#"{"schema_version":1,"intent":"present_information","priority":"normal"}"#
                    .to_vec(),
            display_document_json: Some(serde_json::to_vec(&document).unwrap()),
        }
    }

    fn valid_final() -> ProviderFinal {
        final_with_document(valid_document())
    }

    fn capabilities() -> ProviderCapabilities {
        ProviderCapabilities {
            structured_output: true,
            streaming_events: false,
            cancellation: true,
            usage_reporting: false,
        }
    }

    fn descriptor() -> SupportSortProviderDescriptor {
        SupportSortProviderDescriptor::try_new(SupportSortProviderContext {
            destination: SupportSortDestination::LocalProvider,
            provider_key: "local-test-provider",
            provider_fingerprint: LOCAL_FINGERPRINT,
            disclosure_version: SUPPORT_SORT_DISCLOSURE_VERSION,
        })
        .unwrap()
    }

    fn registration(
        captured: Arc<Mutex<Option<ProviderRequest>>>,
    ) -> SupportSortProviderRegistration {
        SupportSortProviderRegistration::new(
            descriptor(),
            Box::new(CapturingAdapter {
                captured,
                capabilities: capabilities(),
                final_output: valid_final(),
            }),
        )
    }

    fn registration_with_final(
        captured: Arc<Mutex<Option<ProviderRequest>>>,
        final_output: ProviderFinal,
    ) -> SupportSortProviderRegistration {
        SupportSortProviderRegistration::new(
            descriptor(),
            Box::new(CapturingAdapter {
                captured,
                capabilities: capabilities(),
                final_output,
            }),
        )
    }

    fn issued_token(gate: &mut SupportSortAuthorizationGate) -> String {
        let mut capability = gate
            .issue(descriptor().authorization_context(), NOW)
            .unwrap();
        std::mem::take(&mut capability.token)
    }

    #[test]
    fn sends_only_the_fixed_schema_and_exact_user_entered_text() {
        let captured = Arc::new(Mutex::new(None));
        let mut gate = SupportSortAuthorizationGate::default();
        let token = issued_token(&mut gate);
        let text = "事实：需求变了。\n感受：有些烦。";

        let outcome = start_authorized_support_sort_run(
            &mut gate,
            registration(captured.clone()),
            &token,
            text,
            NOW + 1,
        )
        .unwrap()
        .wait()
        .unwrap();
        assert_eq!(outcome.fact, "需求发生了变化");
        assert_eq!(outcome.feeling, "有些烦");
        assert_eq!(outcome.controllable, "可以先确认范围");
        assert_eq!(outcome.next_step, "列出三个待确认问题");
        assert_eq!(outcome.usage, None);

        let request = captured.lock().unwrap().take().unwrap();
        assert_eq!(request.operation, ProviderOperation::SupportSort);
        assert_eq!(request.timeout, SUPPORT_SORT_TIMEOUT);
        assert_eq!(
            request.input,
            json!({
                "schema_version": 1,
                "content_class": "user_entered_text",
                "user_entered_text": text,
            })
        );
        let serialized = serde_json::to_string(&request.input).unwrap();
        assert!(!request.request_id.contains(&token));
        assert!(!request.request_id.contains("local-test-provider"));
        for forbidden in [
            &token,
            "local-test-provider",
            LOCAL_FINGERPRINT,
            "task",
            "history",
            "memory",
            "workspace",
            "file",
        ] {
            assert!(!serialized.contains(forbidden));
        }
    }

    #[test]
    fn missing_expired_and_replayed_authorizations_never_reach_the_adapter() {
        let mut gate = SupportSortAuthorizationGate::default();
        let token = issued_token(&mut gate);
        let expired_capture = Arc::new(Mutex::new(None));
        let expired_at = NOW + 5 * 60 * 1_000;
        assert!(matches!(
            start_authorized_support_sort_run(
                &mut gate,
                registration(expired_capture.clone()),
                &token,
                "只发送这段文字",
                expired_at,
            ),
            Err(SupportSortProviderStartError::Authorization(
                SupportSortConsumeRejection::Expired
            ))
        ));
        assert!(expired_capture.lock().unwrap().is_none());

        let replay_capture = Arc::new(Mutex::new(None));
        assert!(matches!(
            start_authorized_support_sort_run(
                &mut gate,
                registration(replay_capture.clone()),
                &token,
                "只发送这段文字",
                NOW + 1,
            ),
            Err(SupportSortProviderStartError::Authorization(
                SupportSortConsumeRejection::MissingOrUsed
            ))
        ));
        assert!(replay_capture.lock().unwrap().is_none());

        let missing_capture = Arc::new(Mutex::new(None));
        assert!(matches!(
            start_authorized_support_sort_run(
                &mut gate,
                registration(missing_capture.clone()),
                "not-issued",
                "只发送这段文字",
                NOW + 1,
            ),
            Err(SupportSortProviderStartError::Authorization(
                SupportSortConsumeRejection::MissingOrUsed
            ))
        ));
        assert!(missing_capture.lock().unwrap().is_none());
    }

    #[test]
    fn provider_change_consumes_authorization_and_never_reaches_adapter() {
        let mut gate = SupportSortAuthorizationGate::default();
        let token = issued_token(&mut gate);
        let changed = SupportSortProviderDescriptor::try_new(SupportSortProviderContext {
            provider_key: "changed-provider",
            ..descriptor().authorization_context()
        })
        .unwrap();
        let captured = Arc::new(Mutex::new(None));
        let changed_registration = SupportSortProviderRegistration::new(
            changed,
            Box::new(CapturingAdapter {
                captured: captured.clone(),
                capabilities: capabilities(),
                final_output: valid_final(),
            }),
        );

        assert!(matches!(
            start_authorized_support_sort_run(
                &mut gate,
                changed_registration,
                &token,
                "只发送这段文字",
                NOW + 1,
            ),
            Err(SupportSortProviderStartError::Authorization(
                SupportSortConsumeRejection::ProviderChanged
            ))
        ));
        assert!(captured.lock().unwrap().is_none());
    }

    #[test]
    fn invalid_text_is_rejected_locally_without_consuming_authorization() {
        let invalid = ["", "   \n\t", "contains\0nul", "contains\u{202e}bidi"];
        for text in invalid {
            let mut gate = SupportSortAuthorizationGate::default();
            let token = issued_token(&mut gate);
            let captured = Arc::new(Mutex::new(None));
            assert!(matches!(
                start_authorized_support_sort_run(
                    &mut gate,
                    registration(captured.clone()),
                    &token,
                    text,
                    NOW + 1,
                ),
                Err(SupportSortProviderStartError::InvalidUserEnteredText)
            ));
            assert!(captured.lock().unwrap().is_none());

            start_authorized_support_sort_run(
                &mut gate,
                registration(captured.clone()),
                &token,
                "校验后仍可使用原授权",
                NOW + 2,
            )
            .unwrap()
            .wait()
            .unwrap();
            assert!(captured.lock().unwrap().is_some());
        }
    }

    #[test]
    fn oversized_utf8_text_is_rejected_before_authorization_is_consumed() {
        let mut gate = SupportSortAuthorizationGate::default();
        let token = issued_token(&mut gate);
        let oversized = "猫".repeat(MAX_USER_ENTERED_TEXT_BYTES / 3 + 1);
        let captured = Arc::new(Mutex::new(None));
        assert!(matches!(
            start_authorized_support_sort_run(
                &mut gate,
                registration(captured.clone()),
                &token,
                &oversized,
                NOW + 1,
            ),
            Err(SupportSortProviderStartError::InvalidUserEnteredText)
        ));
        assert!(captured.lock().unwrap().is_none());
    }

    #[test]
    fn provider_start_failure_consumes_authorization() {
        let mut gate = SupportSortAuthorizationGate::default();
        let token = issued_token(&mut gate);
        let captured = Arc::new(Mutex::new(None));
        let weak_capabilities = ProviderCapabilities {
            cancellation: false,
            ..capabilities()
        };
        let failed_registration = SupportSortProviderRegistration::new(
            descriptor(),
            Box::new(CapturingAdapter {
                captured: captured.clone(),
                capabilities: weak_capabilities,
                final_output: valid_final(),
            }),
        );
        assert!(matches!(
            start_authorized_support_sort_run(
                &mut gate,
                failed_registration,
                &token,
                "只发送这段文字",
                NOW + 1,
            ),
            Err(SupportSortProviderStartError::Provider(
                ProviderRunError::MissingRequiredCapability
            ))
        ));
        assert!(captured.lock().unwrap().is_none());

        let replay_capture = Arc::new(Mutex::new(None));
        assert!(matches!(
            start_authorized_support_sort_run(
                &mut gate,
                registration(replay_capture.clone()),
                &token,
                "只发送这段文字",
                NOW + 2,
            ),
            Err(SupportSortProviderStartError::Authorization(
                SupportSortConsumeRejection::MissingOrUsed
            ))
        ));
        assert!(replay_capture.lock().unwrap().is_none());
    }

    #[test]
    fn generic_or_speaking_response_intents_cannot_escape_the_tool_result_api() {
        let invalid_intents = [
            br#"{"schema_version":1,"intent":"stay_close","priority":"normal"}"#.as_slice(),
            br#"{"schema_version":1,"intent":"present_information","priority":"formal"}"#
                .as_slice(),
            br#"{"schema_version":2,"intent":"present_information","priority":"normal"}"#
                .as_slice(),
        ];
        for response_intent_json in invalid_intents {
            let mut gate = SupportSortAuthorizationGate::default();
            let token = issued_token(&mut gate);
            let captured = Arc::new(Mutex::new(None));
            let mut final_output = valid_final();
            final_output.response_intent_json = response_intent_json.to_vec();
            let handle = start_authorized_support_sort_run(
                &mut gate,
                registration_with_final(captured, final_output),
                &token,
                "帮我分清现在能做什么",
                NOW + 1,
            )
            .unwrap();
            assert!(matches!(
                handle.wait(),
                Err(SupportSortRunError::InvalidOutput)
            ));
        }
    }

    #[test]
    fn only_the_exact_four_part_sensitive_model_inference_is_exposed() {
        let mut invalid_documents = Vec::new();

        let mut wrong_title = valid_document();
        wrong_title["title"] = json!("圆圆说");
        invalid_documents.push(wrong_title);

        let mut wrong_sensitivity = valid_document();
        wrong_sensitivity["sensitivity"] = json!("personal");
        invalid_documents.push(wrong_sensitivity);

        let mut extra_reference = valid_document();
        extra_reference["references"] = json!([{
            "reference_id": "external-1",
            "label": "外部内容",
            "target_text": "https://example.invalid"
        }]);
        invalid_documents.push(extra_reference);

        let mut wrong_columns = valid_document();
        wrong_columns["blocks"][0]["columns"] = json!(["事实", "判断", "可控", "下一步"]);
        invalid_documents.push(wrong_columns);

        let mut extra_row = valid_document();
        extra_row["blocks"][0]["rows"] = json!([
            ["需求发生了变化", "有些烦", "可以先确认范围", "列出三个问题"],
            ["额外事实", "额外感受", "额外建议", "额外行动"]
        ]);
        invalid_documents.push(extra_row);

        for document in invalid_documents {
            let mut gate = SupportSortAuthorizationGate::default();
            let token = issued_token(&mut gate);
            let captured = Arc::new(Mutex::new(None));
            let handle = start_authorized_support_sort_run(
                &mut gate,
                registration_with_final(captured, final_with_document(document)),
                &token,
                "帮我理一理",
                NOW + 1,
            )
            .unwrap();
            assert!(matches!(
                handle.wait(),
                Err(SupportSortRunError::InvalidOutput)
            ));
        }
    }

    #[test]
    fn structurally_valid_but_semantically_harmful_results_are_rejected() {
        let harmful_cells = [
            (0, "对方就是故意打压你"),
            (1, "你这是焦虑症"),
            (2, "你必须马上继续工作"),
            (3, "圆圆说一定会没事"),
        ];

        for (column, harmful_text) in harmful_cells {
            let mut document = valid_document();
            document["blocks"][0]["rows"][0][column] = json!(harmful_text);
            let mut gate = SupportSortAuthorizationGate::default();
            let token = issued_token(&mut gate);
            let captured = Arc::new(Mutex::new(None));
            let handle = start_authorized_support_sort_run(
                &mut gate,
                registration_with_final(captured, final_with_document(document)),
                &token,
                "帮我理一理",
                NOW + 1,
            )
            .unwrap();
            assert!(matches!(
                handle.wait(),
                Err(SupportSortRunError::InvalidOutput)
            ));
        }
    }

    #[test]
    fn a_missing_tool_document_is_rejected_instead_of_becoming_cat_feedback() {
        let mut gate = SupportSortAuthorizationGate::default();
        let token = issued_token(&mut gate);
        let captured = Arc::new(Mutex::new(None));
        let final_output = ProviderFinal {
            response_intent_json:
                br#"{"schema_version":1,"intent":"present_information","priority":"normal"}"#
                    .to_vec(),
            display_document_json: None,
        };
        let handle = start_authorized_support_sort_run(
            &mut gate,
            registration_with_final(captured, final_output),
            &token,
            "帮我理一理",
            NOW + 1,
        )
        .unwrap();
        assert!(matches!(
            handle.wait(),
            Err(SupportSortRunError::InvalidOutput)
        ));
    }

    #[test]
    fn four_part_result_has_explicit_sensitive_cleanup() {
        let mut outcome = SupportSortOutcome {
            fact: "正文事实".into(),
            feeling: "正文感受".into(),
            controllable: "正文可控项".into(),
            next_step: "正文下一步".into(),
            usage: None,
        };
        outcome.zeroize_sensitive();
        assert!(outcome.fact.is_empty());
        assert!(outcome.feeling.is_empty());
        assert!(outcome.controllable.is_empty());
        assert!(outcome.next_step.is_empty());
    }

    #[test]
    fn rejected_parsed_document_cleanup_clears_every_text_owner() {
        let bytes = serde_json::to_vec(&json!({
            "schema_version": 1,
            "document_id": "document-sensitive",
            "title": "敏感标题",
            "source_label": "敏感来源",
            "provenance": "model_inferred",
            "confidence": "unknown",
            "sensitivity": "sensitive",
            "blocks": [
                {"type": "heading", "block_id": "heading-1", "level": 2, "text": "敏感标题块"},
                {"type": "paragraph", "block_id": "paragraph-1", "text": "敏感段落"},
                {"type": "list", "block_id": "list-1", "style": "unordered", "items": ["敏感列表一", "敏感列表二"]},
                {"type": "table", "block_id": "table-1", "columns": ["敏感列一", "敏感列二"], "rows": [["敏感单元一", "敏感单元二"]]},
                {"type": "code", "block_id": "code-1", "language": "text", "code": "sensitive command"}
            ],
            "references": [
                {"reference_id": "reference-1", "label": "敏感引用", "target_text": "https://example.invalid/sensitive"}
            ],
            "actions": [
                {"action_id": "action-copy", "kind": "copy_code", "target_id": "code-1"},
                {"action_id": "action-open", "kind": "open_reference", "target_id": "reference-1"},
                {"action_id": "action-dismiss", "kind": "dismiss"}
            ]
        }))
        .unwrap();
        let mut document = DisplayDocumentV1::parse_and_validate(&bytes).unwrap();

        zeroize_display_document(&mut document);

        assert!(document.document_id.is_empty());
        assert_eq!(document.title.as_deref(), Some(""));
        assert!(document.source_label.is_empty());
        for block in &document.blocks {
            match block {
                DisplayBlock::Heading { block_id, text, .. }
                | DisplayBlock::Paragraph { block_id, text } => {
                    assert!(block_id.is_empty());
                    assert!(text.is_empty());
                }
                DisplayBlock::List {
                    block_id, items, ..
                } => {
                    assert!(block_id.is_empty());
                    assert!(items.iter().all(String::is_empty));
                }
                DisplayBlock::Table {
                    block_id,
                    columns,
                    rows,
                } => {
                    assert!(block_id.is_empty());
                    assert!(columns.iter().all(String::is_empty));
                    assert!(rows.iter().flatten().all(String::is_empty));
                }
                DisplayBlock::Code {
                    block_id,
                    language,
                    code,
                } => {
                    assert!(block_id.is_empty());
                    assert_eq!(language.as_deref(), Some(""));
                    assert!(code.is_empty());
                }
            }
        }
        assert!(document.references.iter().all(|reference| {
            reference.reference_id.is_empty()
                && reference.label.is_empty()
                && reference.target_text.is_empty()
        }));
        assert!(document.actions.iter().all(|action| {
            action.action_id.is_empty()
                && action
                    .target_id
                    .as_ref()
                    .is_none_or(|target_id| target_id.is_empty())
        }));
    }
}
