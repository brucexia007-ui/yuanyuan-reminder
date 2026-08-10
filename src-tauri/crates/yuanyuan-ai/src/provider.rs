use std::{
    sync::{
        atomic::{AtomicBool, Ordering},
        mpsc::{self, Receiver, RecvTimeoutError, SyncSender},
        Arc,
    },
    time::{Duration, Instant},
};

use serde_json::Value;
use thiserror::Error;
use yuanyuan_protocol::{
    resolve_response_intent_json, ContentProtocolError, DisplayDocumentV1, ResolvedResponseIntent,
};
use zeroize::Zeroize;

const PROVIDER_CHANNEL_CAPACITY: usize = 16;
const MAX_PROVIDER_INPUT_BYTES: usize = 128 * 1024;
const MIN_TIMEOUT: Duration = Duration::from_millis(100);
const MAX_TIMEOUT: Duration = Duration::from_secs(120);
const CANCELLATION_POLL: Duration = Duration::from_millis(10);

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ProviderCapabilities {
    pub structured_output: bool,
    pub streaming_events: bool,
    pub cancellation: bool,
    pub usage_reporting: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ProviderOperation {
    CompanionResponse,
    SummarizeMemoryCandidate,
    SupportSort,
}

pub struct ProviderRequest {
    pub request_id: String,
    pub operation: ProviderOperation,
    /// Structured, policy-filtered input. Provider adapters must not receive
    /// credentials, raw Hook payloads, or unrestricted filesystem content.
    pub input: Value,
    pub timeout: Duration,
}

impl ProviderRequest {
    fn zeroize_sensitive(&mut self) {
        self.request_id.zeroize();
        zeroize_json_value(&mut self.input);
    }
}

impl Drop for ProviderRequest {
    fn drop(&mut self) {
        self.zeroize_sensitive();
    }
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct ProviderUsage {
    pub input_tokens: u64,
    pub output_tokens: u64,
}

#[derive(PartialEq, Eq)]
pub struct ProviderFinal {
    pub response_intent_json: Vec<u8>,
    pub display_document_json: Option<Vec<u8>>,
}

impl ProviderFinal {
    fn zeroize_sensitive(&mut self) {
        self.response_intent_json.zeroize();
        if let Some(document) = &mut self.display_document_json {
            document.zeroize();
        }
    }
}

impl Drop for ProviderFinal {
    fn drop(&mut self) {
        self.zeroize_sensitive();
    }
}

#[derive(PartialEq, Eq)]
pub enum ProviderEvent {
    Phase(&'static str),
    Usage(ProviderUsage),
    Final(ProviderFinal),
}

#[derive(Debug, Clone, Error, PartialEq, Eq)]
pub enum ProviderAdapterError {
    #[error("provider request was rejected")]
    Rejected,
    #[error("provider transport was unavailable")]
    Unavailable,
    #[error("provider response was malformed")]
    Malformed,
}

#[derive(Debug, Clone)]
pub struct CancellationToken {
    cancelled: Arc<AtomicBool>,
}

impl CancellationToken {
    fn new() -> Self {
        Self {
            cancelled: Arc::new(AtomicBool::new(false)),
        }
    }

    pub fn is_cancelled(&self) -> bool {
        self.cancelled.load(Ordering::Acquire)
    }

    pub fn cancel(&self) {
        self.cancelled.store(true, Ordering::Release);
    }
}

pub struct ProviderEventSink {
    sender: SyncSender<WorkerMessage>,
}

impl ProviderEventSink {
    pub fn emit(&self, event: ProviderEvent) -> Result<(), ProviderAdapterError> {
        self.sender
            .send(WorkerMessage::Event(event))
            .map_err(|_| ProviderAdapterError::Unavailable)
    }
}

/// Vendor adapters implement only transport translation. Policy, timeout,
/// cancellation and final structured-output validation remain host-owned.
pub trait ProviderAdapter: Send + 'static {
    fn capabilities(&self) -> ProviderCapabilities;

    fn run(
        self: Box<Self>,
        request: ProviderRequest,
        cancellation: CancellationToken,
        events: ProviderEventSink,
    ) -> Result<(), ProviderAdapterError>;
}

#[derive(Debug, Error)]
pub enum ProviderRunError {
    #[error("provider contract requires structured output and cancellation")]
    MissingRequiredCapability,
    #[error("provider request is invalid")]
    InvalidRequest,
    #[error("provider request was cancelled")]
    Cancelled,
    #[error("provider request timed out")]
    TimedOut,
    #[error("provider violated its event contract: {0}")]
    ContractViolation(&'static str),
    #[error("provider adapter failed: {0}")]
    Adapter(#[from] ProviderAdapterError),
    #[error("provider final output is invalid: {0}")]
    InvalidFinal(#[from] ContentProtocolError),
}

#[derive(PartialEq, Eq)]
pub struct ProviderOutcome {
    pub response_intent: ResolvedResponseIntent,
    pub display_document: Option<DisplayDocumentV1>,
    pub usage: Option<ProviderUsage>,
}

fn zeroize_json_value(value: &mut Value) {
    match value {
        Value::String(text) => text.zeroize(),
        Value::Array(values) => values.iter_mut().for_each(zeroize_json_value),
        Value::Object(values) => values.values_mut().for_each(zeroize_json_value),
        Value::Null | Value::Bool(_) | Value::Number(_) => {}
    }
}

enum WorkerMessage {
    Event(ProviderEvent),
    Finished(Result<(), ProviderAdapterError>),
}

pub struct ProviderRunHandle {
    cancellation: CancellationToken,
    receiver: Receiver<WorkerMessage>,
    deadline: Instant,
    streaming_events: bool,
    usage_reporting: bool,
}

impl ProviderRunHandle {
    pub fn cancel(&self) {
        self.cancellation.cancel();
    }

    pub fn wait(self) -> Result<ProviderOutcome, ProviderRunError> {
        self.wait_with_external_cancellation(|| false)
    }

    pub fn wait_with_external_cancellation<F>(
        self,
        should_cancel: F,
    ) -> Result<ProviderOutcome, ProviderRunError>
    where
        F: Fn() -> bool,
    {
        let mut final_output = None;
        let mut usage = None;
        loop {
            if should_cancel() {
                self.cancellation.cancel();
            }
            if self.cancellation.is_cancelled() {
                return Err(ProviderRunError::Cancelled);
            }
            let now = Instant::now();
            if now >= self.deadline {
                self.cancellation.cancel();
                return Err(ProviderRunError::TimedOut);
            }
            let wait = self
                .deadline
                .saturating_duration_since(now)
                .min(CANCELLATION_POLL);
            match self.receiver.recv_timeout(wait) {
                Ok(WorkerMessage::Event(event)) => match event {
                    ProviderEvent::Phase(phase) => {
                        if !self.streaming_events
                            || phase.is_empty()
                            || phase.len() > 64
                            || final_output.is_some()
                        {
                            return Err(ProviderRunError::ContractViolation("invalid phase event"));
                        }
                    }
                    ProviderEvent::Usage(next) => {
                        if !self.usage_reporting || final_output.is_some() {
                            return Err(ProviderRunError::ContractViolation("invalid usage event"));
                        }
                        usage = Some(next);
                    }
                    ProviderEvent::Final(output) => {
                        if final_output.replace(output).is_some() {
                            return Err(ProviderRunError::ContractViolation(
                                "multiple final events",
                            ));
                        }
                    }
                },
                Ok(WorkerMessage::Finished(result)) => {
                    result?;
                    let output = final_output
                        .ok_or(ProviderRunError::ContractViolation("missing final event"))?;
                    let response_intent =
                        resolve_response_intent_json(&output.response_intent_json)?;
                    let display_document = output
                        .display_document_json
                        .as_deref()
                        .map(DisplayDocumentV1::parse_and_validate)
                        .transpose()?;
                    return Ok(ProviderOutcome {
                        response_intent,
                        display_document,
                        usage,
                    });
                }
                Err(RecvTimeoutError::Timeout) => {}
                Err(RecvTimeoutError::Disconnected) => {
                    return Err(ProviderRunError::ContractViolation(
                        "provider channel closed without completion",
                    ));
                }
            }
        }
    }
}

pub fn start_provider_run(
    adapter: Box<dyn ProviderAdapter>,
    request: ProviderRequest,
) -> Result<ProviderRunHandle, ProviderRunError> {
    let capabilities = adapter.capabilities();
    if !capabilities.structured_output || !capabilities.cancellation {
        return Err(ProviderRunError::MissingRequiredCapability);
    }
    if request.request_id.is_empty()
        || request.request_id.len() > 96
        || !request.request_id.bytes().all(|byte| {
            byte.is_ascii_lowercase() || byte.is_ascii_digit() || b"._-".contains(&byte)
        })
        || request.timeout < MIN_TIMEOUT
        || request.timeout > MAX_TIMEOUT
        || serde_json::to_vec(&request.input)
            .map_err(|_| ProviderRunError::InvalidRequest)?
            .len()
            > MAX_PROVIDER_INPUT_BYTES
    {
        return Err(ProviderRunError::InvalidRequest);
    }

    let cancellation = CancellationToken::new();
    let worker_cancellation = cancellation.clone();
    let (sender, receiver) = mpsc::sync_channel(PROVIDER_CHANNEL_CAPACITY);
    let finish_sender = sender.clone();
    let timeout = request.timeout;
    std::thread::spawn(move || {
        let result = adapter.run(request, worker_cancellation, ProviderEventSink { sender });
        let _ = finish_sender.send(WorkerMessage::Finished(result));
    });
    Ok(ProviderRunHandle {
        cancellation,
        receiver,
        deadline: Instant::now() + timeout,
        streaming_events: capabilities.streaming_events,
        usage_reporting: capabilities.usage_reporting,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    struct FakeAdapter {
        capabilities: ProviderCapabilities,
        run: Box<
            dyn FnOnce(CancellationToken, ProviderEventSink) -> Result<(), ProviderAdapterError>
                + Send,
        >,
    }

    impl ProviderAdapter for FakeAdapter {
        fn capabilities(&self) -> ProviderCapabilities {
            self.capabilities
        }

        fn run(
            self: Box<Self>,
            _request: ProviderRequest,
            cancellation: CancellationToken,
            events: ProviderEventSink,
        ) -> Result<(), ProviderAdapterError> {
            (self.run)(cancellation, events)
        }
    }

    fn capabilities() -> ProviderCapabilities {
        ProviderCapabilities {
            structured_output: true,
            streaming_events: true,
            cancellation: true,
            usage_reporting: true,
        }
    }

    fn request(timeout: Duration) -> ProviderRequest {
        ProviderRequest {
            request_id: "request-1".into(),
            operation: ProviderOperation::CompanionResponse,
            input: serde_json::json!({"message": "陪我安静待一会"}),
            timeout,
        }
    }

    fn valid_final() -> ProviderFinal {
        ProviderFinal {
            response_intent_json:
                br#"{"schema_version":1,"intent":"stay_close","priority":"normal"}"#.to_vec(),
            display_document_json: Some(
                serde_json::to_vec(&serde_json::json!({
                    "schema_version": 1,
                    "document_id": "document-1",
                    "title": "给你留在这里",
                    "source_label": "圆圆本地陪伴",
                    "provenance": "model_inferred",
                    "confidence": "unknown",
                    "sensitivity": "personal",
                    "blocks": [{
                        "type": "paragraph",
                        "block_id": "paragraph-1",
                        "text": "先不用解决什么，可以慢一点。"
                    }],
                    "references": [],
                    "actions": [{"action_id": "dismiss-1", "kind": "dismiss"}]
                }))
                .unwrap(),
            ),
        }
    }

    #[test]
    fn accepts_bounded_events_usage_and_a_valid_structured_final() {
        let adapter = FakeAdapter {
            capabilities: capabilities(),
            run: Box::new(|_, events| {
                events.emit(ProviderEvent::Phase("thinking"))?;
                events.emit(ProviderEvent::Usage(ProviderUsage {
                    input_tokens: 12,
                    output_tokens: 8,
                }))?;
                events.emit(ProviderEvent::Final(valid_final()))
            }),
        };
        let outcome = start_provider_run(Box::new(adapter), request(Duration::from_secs(1)))
            .unwrap()
            .wait()
            .unwrap();
        assert_eq!(outcome.usage.unwrap().output_tokens, 8);
        assert_eq!(outcome.display_document.unwrap().document_id, "document-1");
    }

    #[test]
    fn caller_cancellation_returns_without_waiting_for_provider_completion() {
        let adapter = FakeAdapter {
            capabilities: capabilities(),
            run: Box::new(|cancellation, _| {
                while !cancellation.is_cancelled() {
                    std::thread::yield_now();
                }
                Ok(())
            }),
        };
        let handle =
            start_provider_run(Box::new(adapter), request(Duration::from_secs(1))).unwrap();
        handle.cancel();
        assert!(matches!(handle.wait(), Err(ProviderRunError::Cancelled)));
    }

    #[test]
    fn watchdog_times_out_a_blocked_provider() {
        let adapter = FakeAdapter {
            capabilities: capabilities(),
            run: Box::new(|cancellation, _| {
                while !cancellation.is_cancelled() {
                    std::thread::yield_now();
                }
                Ok(())
            }),
        };
        let started = Instant::now();
        let result = start_provider_run(Box::new(adapter), request(Duration::from_millis(100)))
            .unwrap()
            .wait();
        assert!(matches!(result, Err(ProviderRunError::TimedOut)));
        assert!(started.elapsed() < Duration::from_millis(500));
    }

    #[test]
    fn malformed_final_and_duplicate_final_fail_closed() {
        let malformed = FakeAdapter {
            capabilities: capabilities(),
            run: Box::new(|_, events| {
                events.emit(ProviderEvent::Final(ProviderFinal {
                    response_intent_json: b"not json".to_vec(),
                    display_document_json: None,
                }))
            }),
        };
        assert!(matches!(
            start_provider_run(Box::new(malformed), request(Duration::from_secs(1)))
                .unwrap()
                .wait(),
            Err(ProviderRunError::InvalidFinal(_))
        ));

        let duplicate = FakeAdapter {
            capabilities: capabilities(),
            run: Box::new(|_, events| {
                events.emit(ProviderEvent::Final(valid_final()))?;
                events.emit(ProviderEvent::Final(valid_final()))
            }),
        };
        assert!(matches!(
            start_provider_run(Box::new(duplicate), request(Duration::from_secs(1)))
                .unwrap()
                .wait(),
            Err(ProviderRunError::ContractViolation("multiple final events"))
        ));
    }

    #[test]
    fn capability_and_usage_claims_are_enforced() {
        let missing = FakeAdapter {
            capabilities: ProviderCapabilities {
                cancellation: false,
                ..capabilities()
            },
            run: Box::new(|_, _| Ok(())),
        };
        assert!(matches!(
            start_provider_run(Box::new(missing), request(Duration::from_secs(1))),
            Err(ProviderRunError::MissingRequiredCapability)
        ));

        let false_usage_claim = FakeAdapter {
            capabilities: ProviderCapabilities {
                usage_reporting: false,
                ..capabilities()
            },
            run: Box::new(|_, events| {
                events.emit(ProviderEvent::Usage(ProviderUsage::default()))?;
                events.emit(ProviderEvent::Final(valid_final()))
            }),
        };
        assert!(matches!(
            start_provider_run(Box::new(false_usage_claim), request(Duration::from_secs(1)))
                .unwrap()
                .wait(),
            Err(ProviderRunError::ContractViolation("invalid usage event"))
        ));

        let false_streaming_claim = FakeAdapter {
            capabilities: ProviderCapabilities {
                streaming_events: false,
                ..capabilities()
            },
            run: Box::new(|_, events| {
                events.emit(ProviderEvent::Phase("thinking"))?;
                events.emit(ProviderEvent::Final(valid_final()))
            }),
        };
        assert!(matches!(
            start_provider_run(
                Box::new(false_streaming_claim),
                request(Duration::from_secs(1))
            )
            .unwrap()
            .wait(),
            Err(ProviderRunError::ContractViolation("invalid phase event"))
        ));
    }

    #[test]
    fn provider_request_and_raw_final_have_explicit_sensitive_cleanup() {
        let mut request = request(Duration::from_secs(1));
        request.zeroize_sensitive();
        assert!(request.request_id.is_empty());
        assert_eq!(request.input["message"], "");

        let mut final_output = valid_final();
        final_output.zeroize_sensitive();
        assert!(
            final_output.response_intent_json.is_empty()
                || final_output
                    .response_intent_json
                    .iter()
                    .all(|byte| *byte == 0)
        );
        assert!(final_output
            .display_document_json
            .as_ref()
            .is_none_or(|document| {
                document.is_empty() || document.iter().all(|byte| *byte == 0)
            }));
    }
}
