use sha2::{Digest, Sha256};
use yuanyuan_protocol::{
    SupportSortIpcCommandV1, SupportSortIpcDestination, SupportSortIpcProtocolError,
    SupportSortIpcRejectionCode, SupportSortIpcRequestV1, SupportSortIpcResponseV1,
    SupportSortIpcResultV1, SUPPORT_SORT_IPC_PROTOCOL_VERSION,
};
use zeroize::{Zeroize, Zeroizing};

use crate::{
    start_authorized_support_sort_run_with_factory, ProviderAdapter, SupportSortAuthorizationGate,
    SupportSortConsumeRejection, SupportSortDestination, SupportSortProviderDescriptor,
    SupportSortProviderStartError, SupportSortRunError,
};

#[cfg(windows)]
use std::{
    os::windows::io::AsRawHandle,
    sync::{
        atomic::{AtomicBool, Ordering},
        mpsc, Arc,
    },
    thread::{self, JoinHandle},
    time::Duration,
};
#[cfg(windows)]
use thiserror::Error;
#[cfg(windows)]
use windows_sys::Win32::System::IO::CancelSynchronousIo;
#[cfg(windows)]
use yuanyuan_bridge::{
    NamedPipeEventSink, NamedPipeNameError, NamedPipeServerError, SinkError,
    WindowsNamedPipeServer, WindowsProcessIdentity,
};
#[cfg(windows)]
use yuanyuan_protocol::MAX_SUPPORT_SORT_IPC_RESPONSE_BYTES;

#[cfg(windows)]
const SUPPORT_SORT_RESPONSE_TIMEOUT: Duration = Duration::from_secs(3);

/// One-client, one-request-at-a-time listener owned by the isolated AI
/// process. The named pipe itself permits only one server instance, providing
/// bounded backpressure without allocating a request queue.
///
/// The initial pipe instance is bound before construction succeeds, so the AI
/// control health endpoint cannot become available while this listener failed
/// to initialize. Dropping the service cancels a blocking pipe operation and
/// waits for the listener thread to clear its bootstrap and host state.
#[cfg(windows)]
pub struct SupportSortService {
    stopping: Arc<AtomicBool>,
    listener: Option<JoinHandle<()>>,
}

#[cfg(windows)]
impl SupportSortService {
    pub fn start<F>(
        bootstrap: crate::SupportSortSessionBootstrap,
        registry: SupportSortProviderRegistry,
        now_unix_ms: F,
    ) -> Result<Self, SupportSortTransportError>
    where
        F: Fn() -> i64 + Send + 'static,
    {
        let pipe_name = Zeroizing::new(bootstrap.support_pipe_name().to_owned());
        let expected_client = bootstrap.expected_client();
        let mut host =
            SupportSortCommandHost::try_new(bootstrap.session_binding().to_owned(), registry)?;
        let stopping = Arc::new(AtomicBool::new(false));
        let listener_stopping = stopping.clone();
        let (ready_sender, ready_receiver) = mpsc::sync_channel(1);
        let listener = thread::spawn(move || {
            let _bootstrap = bootstrap;
            let mut server =
                match WindowsNamedPipeServer::bind_for_client(&pipe_name, expected_client) {
                    Ok(server) => server,
                    Err(error) => {
                        let _ = ready_sender.send(Err(error));
                        return;
                    }
                };
            let _ = ready_sender.send(Ok(()));
            loop {
                let received = server.accept_one_with_pre_read_guard(|| {
                    crate::enforce_sensitive_process_crash_policy().is_ok()
                });
                if listener_stopping.load(Ordering::Acquire) {
                    break;
                }
                if matches!(&received, Err(NamedPipeServerError::PreReadRejected)) {
                    listener_stopping.store(true, Ordering::Release);
                    break;
                }
                if let Ok(received) = received {
                    if let Ok(response) = host.handle_json_with_external_cancellation(
                        received.payload(),
                        now_unix_ms(),
                        || {
                            listener_stopping.load(Ordering::Acquire)
                                || received.client_disconnected()
                        },
                    ) {
                        let _ = received
                            .respond_bounded(&response, MAX_SUPPORT_SORT_IPC_RESPONSE_BYTES);
                    }
                }
                if listener_stopping.load(Ordering::Acquire) {
                    break;
                }
                let Ok(next_server) =
                    WindowsNamedPipeServer::bind_for_client(&pipe_name, expected_client)
                else {
                    break;
                };
                server = next_server;
            }
        });
        match ready_receiver.recv() {
            Ok(Ok(())) => {}
            Ok(Err(error)) => {
                let _ = listener.join();
                return Err(error.into());
            }
            Err(_) => {
                let _ = listener.join();
                return Err(NamedPipeServerError::Create.into());
            }
        }
        Ok(Self {
            stopping,
            listener: Some(listener),
        })
    }

    pub fn shutdown(mut self) {
        self.stop_and_join();
    }

    fn stop_and_join(&mut self) {
        self.stopping.store(true, Ordering::Release);
        if let Some(listener) = self.listener.take() {
            // SAFETY: Rust owns the thread handle until `join`; cancelling its
            // synchronous named-pipe call does not terminate the thread and the
            // listener checks `stopping` before touching another pipe instance.
            let _ = unsafe { CancelSynchronousIo(listener.as_raw_handle() as _) };
            let _ = listener.join();
        }
    }
}

#[cfg(windows)]
impl Drop for SupportSortService {
    fn drop(&mut self) {
        self.stop_and_join();
    }
}

pub trait SupportSortProviderFactory: Send + Sync + 'static {
    fn create(&self) -> Box<dyn ProviderAdapter>;
}

impl<F> SupportSortProviderFactory for F
where
    F: Fn() -> Box<dyn ProviderAdapter> + Send + Sync + 'static,
{
    fn create(&self) -> Box<dyn ProviderAdapter> {
        self()
    }
}

pub struct SupportSortProviderEntry {
    descriptor: SupportSortProviderDescriptor,
    provider_label: String,
    retention_summary: String,
    policy_url: Option<String>,
    disclosure_digest: String,
    factory: Box<dyn SupportSortProviderFactory>,
}

impl SupportSortProviderEntry {
    pub fn try_new(
        descriptor: SupportSortProviderDescriptor,
        provider_label: String,
        retention_summary: String,
        policy_url: Option<String>,
        factory: Box<dyn SupportSortProviderFactory>,
    ) -> Result<Self, SupportSortIpcProtocolError> {
        let disclosure_digest = disclosure_digest(
            &descriptor,
            &provider_label,
            &retention_summary,
            policy_url.as_deref(),
        );
        let entry = Self {
            descriptor,
            provider_label,
            retention_summary,
            policy_url,
            disclosure_digest,
            factory,
        };
        entry.description_result().validate_for_registry()?;
        Ok(entry)
    }

    pub fn disclosure_digest(&self) -> &str {
        &self.disclosure_digest
    }

    fn description_result(&self) -> SupportSortIpcResultV1 {
        SupportSortIpcResultV1::ProviderDescription {
            destination: ipc_destination(self.descriptor.destination()),
            provider_key: self.descriptor.provider_key().to_owned(),
            provider_fingerprint: self.descriptor.provider_fingerprint().to_owned(),
            provider_label: self.provider_label.clone(),
            disclosure_version: self.descriptor.authorization_context().disclosure_version,
            disclosure_digest: self.disclosure_digest.clone(),
            retention_summary: self.retention_summary.clone(),
            policy_url: self.policy_url.clone(),
        }
    }

    fn matches_expected(
        &self,
        destination: SupportSortIpcDestination,
        provider_key: &str,
        provider_fingerprint: &str,
        disclosure_version: u16,
    ) -> bool {
        ipc_destination(self.descriptor.destination()) == destination
            && self.descriptor.provider_key() == provider_key
            && self.descriptor.provider_fingerprint() == provider_fingerprint
            && self.descriptor.authorization_context().disclosure_version == disclosure_version
    }
}

trait RegistryResultValidation {
    fn validate_for_registry(&self) -> Result<(), SupportSortIpcProtocolError>;
}

impl RegistryResultValidation for SupportSortIpcResultV1 {
    fn validate_for_registry(&self) -> Result<(), SupportSortIpcProtocolError> {
        self.validate()
    }
}

#[derive(Default)]
pub struct SupportSortProviderRegistry {
    local: Option<SupportSortProviderEntry>,
    cloud: Option<SupportSortProviderEntry>,
}

impl SupportSortProviderRegistry {
    pub fn set(&mut self, entry: SupportSortProviderEntry) {
        match entry.descriptor.destination() {
            SupportSortDestination::LocalProvider => self.local = Some(entry),
            SupportSortDestination::CloudProvider => self.cloud = Some(entry),
        }
    }

    fn get(&self, destination: SupportSortIpcDestination) -> Option<&SupportSortProviderEntry> {
        match destination {
            SupportSortIpcDestination::LocalProvider => self.local.as_ref(),
            SupportSortIpcDestination::CloudProvider => self.cloud.as_ref(),
        }
    }
}

pub struct SupportSortCommandHost {
    session_binding: String,
    registry: SupportSortProviderRegistry,
    authorizations: SupportSortAuthorizationGate,
}

impl Drop for SupportSortCommandHost {
    fn drop(&mut self) {
        self.session_binding.zeroize();
        self.authorizations.revoke_all();
    }
}

impl SupportSortCommandHost {
    pub fn try_new(
        session_binding: String,
        registry: SupportSortProviderRegistry,
    ) -> Result<Self, SupportSortIpcProtocolError> {
        SupportSortIpcRequestV1 {
            protocol_version: SUPPORT_SORT_IPC_PROTOCOL_VERSION,
            request_id: "session-validation".to_owned(),
            session_binding: session_binding.clone(),
            command: SupportSortIpcCommandV1::RevokeAll,
        }
        .validate()?;
        Ok(Self {
            session_binding,
            registry,
            authorizations: SupportSortAuthorizationGate::default(),
        })
    }

    /// Trusted configuration changes revoke every outstanding authorization.
    /// A future UI must describe and confirm the new provider again.
    pub fn replace_provider(&mut self, entry: SupportSortProviderEntry) {
        self.registry.set(entry);
        self.authorizations.revoke_all();
    }

    pub fn handle(
        &mut self,
        request: SupportSortIpcRequestV1,
        now_unix_ms: i64,
    ) -> Result<SupportSortIpcResponseV1, SupportSortIpcProtocolError> {
        self.handle_with_external_cancellation(request, now_unix_ms, || false)
    }

    pub fn handle_with_external_cancellation<F>(
        &mut self,
        request: SupportSortIpcRequestV1,
        now_unix_ms: i64,
        should_cancel: F,
    ) -> Result<SupportSortIpcResponseV1, SupportSortIpcProtocolError>
    where
        F: Fn() -> bool,
    {
        request.validate()?;
        if !constant_time_equal(
            request.session_binding.as_bytes(),
            self.session_binding.as_bytes(),
        ) {
            let request_id = request.request_id.clone();
            return validated_response(
                request_id,
                SupportSortIpcResultV1::Rejected {
                    code: SupportSortIpcRejectionCode::InvalidSession,
                },
            );
        }

        let result = match &request.command {
            SupportSortIpcCommandV1::DescribeProvider { destination } => self
                .registry
                .get(*destination)
                .map(SupportSortProviderEntry::description_result)
                .unwrap_or_else(|| rejected(SupportSortIpcRejectionCode::ProviderUnavailable)),
            SupportSortIpcCommandV1::IssueAuthorization {
                destination,
                provider_key,
                provider_fingerprint,
                disclosure_version,
                disclosure_digest,
                ..
            } => self.issue_authorization(
                *destination,
                provider_key,
                provider_fingerprint,
                *disclosure_version,
                disclosure_digest,
                now_unix_ms,
            ),
            SupportSortIpcCommandV1::Submit {
                authorization_token,
                destination,
                provider_key,
                provider_fingerprint,
                disclosure_version,
                user_entered_text,
            } => self.submit(
                authorization_token,
                *destination,
                provider_key,
                provider_fingerprint,
                *disclosure_version,
                user_entered_text,
                now_unix_ms,
                should_cancel,
            ),
            SupportSortIpcCommandV1::Cancel {
                authorization_token,
            } => {
                if self.authorizations.cancel(authorization_token) {
                    SupportSortIpcResultV1::Cancelled
                } else {
                    rejected(SupportSortIpcRejectionCode::AuthorizationMissingOrUsed)
                }
            }
            SupportSortIpcCommandV1::RevokeAll => {
                self.authorizations.revoke_all();
                SupportSortIpcResultV1::RevokedAll
            }
        };
        validated_response(request.request_id.clone(), result)
    }

    /// Bounded transport-facing entry point. Invalid or unknown JSON never
    /// reaches the registry or authorization gate; valid responses are encoded
    /// only after their own protocol validation succeeds.
    pub fn handle_json(
        &mut self,
        input: &[u8],
        now_unix_ms: i64,
    ) -> Result<Zeroizing<Vec<u8>>, SupportSortIpcProtocolError> {
        self.handle_json_with_external_cancellation(input, now_unix_ms, || false)
    }

    pub fn handle_json_with_external_cancellation<F>(
        &mut self,
        input: &[u8],
        now_unix_ms: i64,
        should_cancel: F,
    ) -> Result<Zeroizing<Vec<u8>>, SupportSortIpcProtocolError>
    where
        F: Fn() -> bool,
    {
        let request = SupportSortIpcRequestV1::parse_and_validate(input)?;
        Ok(Zeroizing::new(
            self.handle_with_external_cancellation(request, now_unix_ms, should_cancel)?
                .to_json()?,
        ))
    }

    fn issue_authorization(
        &mut self,
        destination: SupportSortIpcDestination,
        provider_key: &str,
        provider_fingerprint: &str,
        disclosure_version: u16,
        expected_disclosure_digest: &str,
        now_unix_ms: i64,
    ) -> SupportSortIpcResultV1 {
        let Some(entry) = self.registry.get(destination) else {
            return rejected(SupportSortIpcRejectionCode::ProviderUnavailable);
        };
        if !entry.matches_expected(
            destination,
            provider_key,
            provider_fingerprint,
            disclosure_version,
        ) || !constant_time_equal(
            expected_disclosure_digest.as_bytes(),
            entry.disclosure_digest.as_bytes(),
        ) {
            return rejected(SupportSortIpcRejectionCode::ProviderChanged);
        }
        match self
            .authorizations
            .issue(entry.descriptor.authorization_context(), now_unix_ms)
        {
            Ok(mut capability) => SupportSortIpcResultV1::AuthorizationIssued {
                authorization_token: std::mem::take(&mut capability.token),
                destination,
                provider_key: std::mem::take(&mut capability.provider_key),
                provider_fingerprint: std::mem::take(&mut capability.provider_fingerprint),
                disclosure_version: capability.disclosure_version,
                expires_at_unix_ms: capability.expires_at_unix_ms,
                one_use: capability.one_use,
            },
            Err(_) => rejected(SupportSortIpcRejectionCode::InvalidRequest),
        }
    }

    #[allow(clippy::too_many_arguments)]
    fn submit<F>(
        &mut self,
        authorization_token: &str,
        destination: SupportSortIpcDestination,
        provider_key: &str,
        provider_fingerprint: &str,
        disclosure_version: u16,
        user_entered_text: &str,
        now_unix_ms: i64,
        should_cancel: F,
    ) -> SupportSortIpcResultV1
    where
        F: Fn() -> bool,
    {
        let Some(entry) = self.registry.get(destination) else {
            self.authorizations.cancel(authorization_token);
            return rejected(SupportSortIpcRejectionCode::ProviderUnavailable);
        };
        if !entry.matches_expected(
            destination,
            provider_key,
            provider_fingerprint,
            disclosure_version,
        ) {
            let _ = self.authorizations.consume(
                authorization_token,
                entry.descriptor.authorization_context(),
                now_unix_ms,
            );
            return rejected(SupportSortIpcRejectionCode::ProviderChanged);
        }

        match start_authorized_support_sort_run_with_factory(
            &mut self.authorizations,
            &entry.descriptor,
            authorization_token,
            user_entered_text,
            now_unix_ms,
            || entry.factory.create(),
        ) {
            Ok(handle) => match handle.wait_with_external_cancellation(should_cancel) {
                Ok(mut outcome) => SupportSortIpcResultV1::SortCompleted {
                    fact: std::mem::take(&mut outcome.fact),
                    feeling: std::mem::take(&mut outcome.feeling),
                    controllable: std::mem::take(&mut outcome.controllable),
                    next_step: std::mem::take(&mut outcome.next_step),
                },
                Err(SupportSortRunError::InvalidOutput) => {
                    rejected(SupportSortIpcRejectionCode::InvalidProviderOutput)
                }
                Err(SupportSortRunError::Provider(_)) => {
                    rejected(SupportSortIpcRejectionCode::ProviderFailed)
                }
            },
            Err(error) => rejected(start_error_code(error)),
        }
    }
}

#[cfg(windows)]
#[derive(Debug, Error)]
pub enum SupportSortTransportError {
    #[error("support sort pipe name is invalid")]
    PipeName(#[from] NamedPipeNameError),
    #[error("support sort pipe failed: {0}")]
    Pipe(#[from] NamedPipeServerError),
    #[error("support sort request delivery failed")]
    Delivery,
    #[error("support sort protocol failed: {0}")]
    Protocol(#[from] SupportSortIpcProtocolError),
}

#[cfg(windows)]
impl From<SinkError> for SupportSortTransportError {
    fn from(_: SinkError) -> Self {
        Self::Delivery
    }
}

/// Serves exactly one authenticated-client request. Invalid input is dropped
/// without a response; callers must create a new identity-bound server for the
/// next request. No logging, persistence or retry occurs in this layer.
#[cfg(windows)]
pub fn serve_one_support_sort_request(
    pipe_name: &str,
    expected_client: WindowsProcessIdentity,
    host: &mut SupportSortCommandHost,
    now_unix_ms: i64,
) -> Result<(), SupportSortTransportError> {
    serve_one_support_sort_request_with_ready(pipe_name, expected_client, host, now_unix_ms, || {})
}

#[cfg(windows)]
fn serve_one_support_sort_request_with_ready<F>(
    pipe_name: &str,
    expected_client: WindowsProcessIdentity,
    host: &mut SupportSortCommandHost,
    now_unix_ms: i64,
    on_ready: F,
) -> Result<(), SupportSortTransportError>
where
    F: FnOnce(),
{
    let server = WindowsNamedPipeServer::bind_for_client(pipe_name, expected_client)?;
    on_ready();
    let received = server.accept_one_with_pre_read_guard(|| {
        crate::enforce_sensitive_process_crash_policy().is_ok()
    })?;
    let response = host.handle_json(received.payload(), now_unix_ms)?;
    received.respond_bounded(&response, MAX_SUPPORT_SORT_IPC_RESPONSE_BYTES)?;
    Ok(())
}

/// Client half of the one-request transport. Both request and response pass
/// their protocol validators; the session binding remains inside Rust.
#[cfg(windows)]
pub fn send_one_support_sort_request(
    pipe_name: &str,
    request: &SupportSortIpcRequestV1,
) -> Result<SupportSortIpcResponseV1, SupportSortTransportError> {
    let payload = Zeroizing::new(request.to_json()?);
    let response = NamedPipeEventSink::new(pipe_name)?
        .send_validated_payload_and_receive_response_with_timeout(
            &payload,
            MAX_SUPPORT_SORT_IPC_RESPONSE_BYTES,
            SUPPORT_SORT_RESPONSE_TIMEOUT,
        )?;
    Ok(SupportSortIpcResponseV1::parse_and_validate(&response)?)
}

fn start_error_code(error: SupportSortProviderStartError) -> SupportSortIpcRejectionCode {
    match error {
        SupportSortProviderStartError::InvalidUserEnteredText => {
            SupportSortIpcRejectionCode::InvalidUserEnteredText
        }
        SupportSortProviderStartError::Authorization(rejection) => match rejection {
            SupportSortConsumeRejection::MissingOrUsed => {
                SupportSortIpcRejectionCode::AuthorizationMissingOrUsed
            }
            SupportSortConsumeRejection::Expired | SupportSortConsumeRejection::InvalidTime => {
                SupportSortIpcRejectionCode::AuthorizationExpired
            }
            SupportSortConsumeRejection::ProviderChanged => {
                SupportSortIpcRejectionCode::ProviderChanged
            }
        },
        SupportSortProviderStartError::Provider(_) => SupportSortIpcRejectionCode::ProviderFailed,
    }
}

fn rejected(code: SupportSortIpcRejectionCode) -> SupportSortIpcResultV1 {
    SupportSortIpcResultV1::Rejected { code }
}

fn validated_response(
    request_id: String,
    result: SupportSortIpcResultV1,
) -> Result<SupportSortIpcResponseV1, SupportSortIpcProtocolError> {
    let response = SupportSortIpcResponseV1 {
        protocol_version: SUPPORT_SORT_IPC_PROTOCOL_VERSION,
        request_id,
        result,
    };
    response.validate()?;
    Ok(response)
}

fn ipc_destination(destination: SupportSortDestination) -> SupportSortIpcDestination {
    match destination {
        SupportSortDestination::LocalProvider => SupportSortIpcDestination::LocalProvider,
        SupportSortDestination::CloudProvider => SupportSortIpcDestination::CloudProvider,
    }
}

fn disclosure_digest(
    descriptor: &SupportSortProviderDescriptor,
    provider_label: &str,
    retention_summary: &str,
    policy_url: Option<&str>,
) -> String {
    let mut digest = Sha256::new();
    digest.update(b"yuanyuan.support-sort.disclosure.v1\0");
    push_digest_field(
        &mut digest,
        match descriptor.destination() {
            SupportSortDestination::LocalProvider => b"local_provider",
            SupportSortDestination::CloudProvider => b"cloud_provider",
        },
    );
    push_digest_field(&mut digest, descriptor.provider_key().as_bytes());
    push_digest_field(&mut digest, descriptor.provider_fingerprint().as_bytes());
    push_digest_field(
        &mut digest,
        &descriptor
            .authorization_context()
            .disclosure_version
            .to_be_bytes(),
    );
    push_digest_field(&mut digest, provider_label.as_bytes());
    push_digest_field(&mut digest, retention_summary.as_bytes());
    push_digest_field(&mut digest, policy_url.unwrap_or_default().as_bytes());
    digest
        .finalize()
        .iter()
        .map(|byte| format!("{byte:02X}"))
        .collect()
}

fn push_digest_field(digest: &mut Sha256, field: &[u8]) {
    digest.update((field.len() as u64).to_be_bytes());
    digest.update(field);
}

fn constant_time_equal(left: &[u8], right: &[u8]) -> bool {
    if left.len() != right.len() {
        return false;
    }
    left.iter()
        .zip(right)
        .fold(0_u8, |difference, (left, right)| {
            difference | (left ^ right)
        })
        == 0
}

#[cfg(test)]
mod tests {
    use std::sync::{
        atomic::{AtomicUsize, Ordering},
        Arc,
    };

    use super::*;
    use crate::{
        CancellationToken, ProviderAdapterError, ProviderCapabilities, ProviderEvent,
        ProviderEventSink, ProviderFinal, ProviderRequest, SupportSortProviderContext,
        SUPPORT_SORT_DISCLOSURE_VERSION,
    };

    const NOW: i64 = 1_775_212_800_000;
    const SESSION: &str = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
    const FINGERPRINT_A: &str = "BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB";
    const FINGERPRINT_B: &str = "CCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC";

    #[cfg(windows)]
    fn write_pipe_message_and_disconnect(pipe_name: &str, payload: &[u8]) {
        use std::{ffi::OsStr, os::windows::ffi::OsStrExt, ptr, time::Instant};

        use windows_sys::Win32::{
            Foundation::{
                CloseHandle, GetLastError, ERROR_FILE_NOT_FOUND, ERROR_PIPE_BUSY, GENERIC_READ,
                GENERIC_WRITE, INVALID_HANDLE_VALUE,
            },
            Storage::FileSystem::{CreateFileW, WriteFile, FILE_ATTRIBUTE_NORMAL, OPEN_EXISTING},
            System::Pipes::WaitNamedPipeW,
        };

        struct HandleGuard(windows_sys::Win32::Foundation::HANDLE);
        impl Drop for HandleGuard {
            fn drop(&mut self) {
                unsafe {
                    CloseHandle(self.0);
                }
            }
        }

        let mut path: Vec<u16> = OsStr::new(&format!(r"\\.\pipe\{pipe_name}"))
            .encode_wide()
            .collect();
        path.push(0);
        let deadline = Instant::now() + Duration::from_secs(1);
        let handle = loop {
            let handle = unsafe {
                CreateFileW(
                    path.as_ptr(),
                    GENERIC_READ | GENERIC_WRITE,
                    0,
                    ptr::null(),
                    OPEN_EXISTING,
                    FILE_ATTRIBUTE_NORMAL,
                    ptr::null_mut(),
                )
            };
            if handle != INVALID_HANDLE_VALUE {
                break HandleGuard(handle);
            }
            let error = unsafe { GetLastError() };
            assert!(
                matches!(error, ERROR_FILE_NOT_FOUND | ERROR_PIPE_BUSY)
                    && Instant::now() < deadline,
                "raw pipe client could not connect: {error}"
            );
            if error == ERROR_PIPE_BUSY {
                unsafe {
                    WaitNamedPipeW(path.as_ptr(), 25);
                }
            } else {
                std::thread::sleep(Duration::from_millis(2));
            }
        };
        let mut written = 0_u32;
        let succeeded = unsafe {
            WriteFile(
                handle.0,
                payload.as_ptr(),
                payload.len() as u32,
                &mut written,
                ptr::null_mut(),
            )
        };
        assert_ne!(succeeded, 0);
        assert_eq!(written as usize, payload.len());
    }

    struct FinalAdapter {
        final_output: ProviderFinal,
    }

    struct WaitForCancellationAdapter {
        started: Arc<AtomicUsize>,
        cancelled: Arc<AtomicUsize>,
    }

    impl ProviderAdapter for FinalAdapter {
        fn capabilities(&self) -> ProviderCapabilities {
            ProviderCapabilities {
                structured_output: true,
                streaming_events: false,
                cancellation: true,
                usage_reporting: false,
            }
        }

        fn run(
            self: Box<Self>,
            _request: ProviderRequest,
            _cancellation: CancellationToken,
            events: ProviderEventSink,
        ) -> Result<(), ProviderAdapterError> {
            events.emit(ProviderEvent::Final(self.final_output))
        }
    }

    impl ProviderAdapter for WaitForCancellationAdapter {
        fn capabilities(&self) -> ProviderCapabilities {
            ProviderCapabilities {
                structured_output: true,
                streaming_events: false,
                cancellation: true,
                usage_reporting: false,
            }
        }

        fn run(
            self: Box<Self>,
            _request: ProviderRequest,
            cancellation: CancellationToken,
            _events: ProviderEventSink,
        ) -> Result<(), ProviderAdapterError> {
            self.started.fetch_add(1, Ordering::SeqCst);
            while !cancellation.is_cancelled() {
                std::thread::sleep(Duration::from_millis(2));
            }
            self.cancelled.fetch_add(1, Ordering::SeqCst);
            Err(ProviderAdapterError::Unavailable)
        }
    }

    fn valid_final() -> ProviderFinal {
        ProviderFinal {
            response_intent_json:
                br#"{"schema_version":1,"intent":"present_information","priority":"normal"}"#
                    .to_vec(),
            display_document_json: Some(
                serde_json::to_vec(&serde_json::json!({
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
                        "rows": [["需求发生变化", "有些烦", "先确认范围", "列出三个问题"]]
                    }],
                    "references": [],
                    "actions": []
                }))
                .unwrap(),
            ),
        }
    }

    fn entry(fingerprint: &'static str, created: Arc<AtomicUsize>) -> SupportSortProviderEntry {
        let descriptor = SupportSortProviderDescriptor::try_new(SupportSortProviderContext {
            destination: SupportSortDestination::LocalProvider,
            provider_key: "local-provider",
            provider_fingerprint: fingerprint,
            disclosure_version: SUPPORT_SORT_DISCLOSURE_VERSION,
        })
        .unwrap();
        SupportSortProviderEntry::try_new(
            descriptor,
            "本机合成整理器".to_owned(),
            "进程退出后不保留本次正文。".to_owned(),
            None,
            Box::new(move || {
                created.fetch_add(1, Ordering::SeqCst);
                Box::new(FinalAdapter {
                    final_output: valid_final(),
                }) as Box<dyn ProviderAdapter>
            }),
        )
        .unwrap()
    }

    fn host(created: Arc<AtomicUsize>) -> SupportSortCommandHost {
        let mut registry = SupportSortProviderRegistry::default();
        registry.set(entry(FINGERPRINT_A, created));
        SupportSortCommandHost::try_new(SESSION.to_owned(), registry).unwrap()
    }

    fn request(command: SupportSortIpcCommandV1) -> SupportSortIpcRequestV1 {
        SupportSortIpcRequestV1 {
            protocol_version: SUPPORT_SORT_IPC_PROTOCOL_VERSION,
            request_id: "request-1".to_owned(),
            session_binding: SESSION.to_owned(),
            command,
        }
    }

    fn describe(host: &mut SupportSortCommandHost) -> (String, String, String, u16) {
        let response = host
            .handle(
                request(SupportSortIpcCommandV1::DescribeProvider {
                    destination: SupportSortIpcDestination::LocalProvider,
                }),
                NOW,
            )
            .unwrap();
        let SupportSortIpcResultV1::ProviderDescription {
            provider_key,
            provider_fingerprint,
            disclosure_digest,
            disclosure_version,
            ..
        } = &response.result
        else {
            panic!("expected provider description")
        };
        (
            provider_key.clone(),
            provider_fingerprint.clone(),
            disclosure_digest.clone(),
            *disclosure_version,
        )
    }

    fn issue(host: &mut SupportSortCommandHost) -> String {
        let (key, fingerprint, digest, version) = describe(host);
        let response = host
            .handle(
                request(SupportSortIpcCommandV1::IssueAuthorization {
                    destination: SupportSortIpcDestination::LocalProvider,
                    provider_key: key,
                    provider_fingerprint: fingerprint,
                    disclosure_version: version,
                    disclosure_digest: digest,
                    user_confirmed: true,
                }),
                NOW,
            )
            .unwrap();
        let SupportSortIpcResultV1::AuthorizationIssued {
            authorization_token,
            one_use,
            ..
        } = &response.result
        else {
            panic!("expected authorization")
        };
        assert!(*one_use);
        authorization_token.clone()
    }

    #[test]
    fn describe_issue_submit_returns_only_the_four_tool_fields() {
        let created = Arc::new(AtomicUsize::new(0));
        let mut host = host(created.clone());
        let token = issue(&mut host);
        assert_eq!(created.load(Ordering::SeqCst), 0);
        let response = host
            .handle(
                request(SupportSortIpcCommandV1::Submit {
                    authorization_token: token,
                    destination: SupportSortIpcDestination::LocalProvider,
                    provider_key: "local-provider".to_owned(),
                    provider_fingerprint: FINGERPRINT_A.to_owned(),
                    disclosure_version: 1,
                    user_entered_text: "帮我理一理".to_owned(),
                }),
                NOW + 1,
            )
            .unwrap();
        assert_eq!(created.load(Ordering::SeqCst), 1);
        assert!(matches!(
            &response.result,
            SupportSortIpcResultV1::SortCompleted {
                fact,
                feeling,
                controllable,
                next_step,
            } if fact == "需求发生变化"
                && feeling == "有些烦"
                && controllable == "先确认范围"
                && next_step == "列出三个问题"
        ));
    }

    #[test]
    fn invalid_session_cannot_describe_or_issue() {
        let created = Arc::new(AtomicUsize::new(0));
        let mut host = host(created);
        let mut invalid = request(SupportSortIpcCommandV1::DescribeProvider {
            destination: SupportSortIpcDestination::LocalProvider,
        });
        invalid.session_binding = FINGERPRINT_A.to_owned();
        let response = host.handle(invalid, NOW).unwrap();
        assert!(matches!(
            &response.result,
            SupportSortIpcResultV1::Rejected {
                code: SupportSortIpcRejectionCode::InvalidSession
            }
        ));
    }

    #[test]
    fn disclosure_or_provider_mismatch_never_issues_authorization() {
        let created = Arc::new(AtomicUsize::new(0));
        let mut host = host(created);
        let (key, fingerprint, _, version) = describe(&mut host);
        let response = host
            .handle(
                request(SupportSortIpcCommandV1::IssueAuthorization {
                    destination: SupportSortIpcDestination::LocalProvider,
                    provider_key: key,
                    provider_fingerprint: fingerprint,
                    disclosure_version: version,
                    disclosure_digest: FINGERPRINT_A.to_owned(),
                    user_confirmed: true,
                }),
                NOW,
            )
            .unwrap();
        assert!(matches!(
            &response.result,
            SupportSortIpcResultV1::Rejected {
                code: SupportSortIpcRejectionCode::ProviderChanged
            }
        ));
    }

    #[test]
    fn replay_never_creates_a_second_adapter() {
        let created = Arc::new(AtomicUsize::new(0));
        let mut host = host(created.clone());
        let token = issue(&mut host);
        let submit = || SupportSortIpcCommandV1::Submit {
            authorization_token: token.clone(),
            destination: SupportSortIpcDestination::LocalProvider,
            provider_key: "local-provider".to_owned(),
            provider_fingerprint: FINGERPRINT_A.to_owned(),
            disclosure_version: 1,
            user_entered_text: "帮我理一理".to_owned(),
        };
        assert!(matches!(
            host.handle(request(submit()), NOW + 1).unwrap().result,
            SupportSortIpcResultV1::SortCompleted { .. }
        ));
        assert!(matches!(
            host.handle(request(submit()), NOW + 2).unwrap().result,
            SupportSortIpcResultV1::Rejected {
                code: SupportSortIpcRejectionCode::AuthorizationMissingOrUsed
            }
        ));
        assert_eq!(created.load(Ordering::SeqCst), 1);
    }

    #[test]
    fn trusted_provider_replacement_revokes_old_authorization() {
        let created = Arc::new(AtomicUsize::new(0));
        let mut host = host(created.clone());
        let token = issue(&mut host);
        host.replace_provider(entry(FINGERPRINT_B, created.clone()));
        let response = host
            .handle(
                request(SupportSortIpcCommandV1::Submit {
                    authorization_token: token,
                    destination: SupportSortIpcDestination::LocalProvider,
                    provider_key: "local-provider".to_owned(),
                    provider_fingerprint: FINGERPRINT_A.to_owned(),
                    disclosure_version: 1,
                    user_entered_text: "帮我理一理".to_owned(),
                }),
                NOW + 1,
            )
            .unwrap();
        assert!(matches!(
            &response.result,
            SupportSortIpcResultV1::Rejected {
                code: SupportSortIpcRejectionCode::ProviderChanged
            }
        ));
        assert_eq!(created.load(Ordering::SeqCst), 0);
    }

    #[test]
    fn cancel_and_revoke_all_prevent_adapter_creation() {
        let created = Arc::new(AtomicUsize::new(0));
        let mut host = host(created.clone());
        let first = issue(&mut host);
        assert!(matches!(
            host.handle(
                request(SupportSortIpcCommandV1::Cancel {
                    authorization_token: first,
                }),
                NOW + 1,
            )
            .unwrap()
            .result,
            SupportSortIpcResultV1::Cancelled
        ));
        let second = issue(&mut host);
        assert!(matches!(
            host.handle(request(SupportSortIpcCommandV1::RevokeAll), NOW + 2)
                .unwrap()
                .result,
            SupportSortIpcResultV1::RevokedAll
        ));
        let response = host
            .handle(
                request(SupportSortIpcCommandV1::Submit {
                    authorization_token: second,
                    destination: SupportSortIpcDestination::LocalProvider,
                    provider_key: "local-provider".to_owned(),
                    provider_fingerprint: FINGERPRINT_A.to_owned(),
                    disclosure_version: 1,
                    user_entered_text: "帮我理一理".to_owned(),
                }),
                NOW + 3,
            )
            .unwrap();
        assert!(matches!(
            &response.result,
            SupportSortIpcResultV1::Rejected {
                code: SupportSortIpcRejectionCode::AuthorizationMissingOrUsed
            }
        ));
        assert_eq!(created.load(Ordering::SeqCst), 0);
    }

    #[test]
    fn json_entry_rejects_unknown_context_before_registry_or_adapter_use() {
        let created = Arc::new(AtomicUsize::new(0));
        let mut host = host(created.clone());
        let input = serde_json::to_vec(&serde_json::json!({
            "protocol_version": 1,
            "request_id": "request-1",
            "session_binding": SESSION,
            "command": {
                "kind": "describe_provider",
                "destination": "local_provider",
                "workspace": "C:\\private"
            }
        }))
        .unwrap();
        assert!(matches!(
            host.handle_json(&input, NOW),
            Err(SupportSortIpcProtocolError::InvalidJson)
        ));
        assert_eq!(created.load(Ordering::SeqCst), 0);
    }

    #[cfg(windows)]
    #[test]
    fn real_identity_bound_pipe_reaches_the_host_and_returns_validated_disclosure() {
        use std::{sync::mpsc, thread, time::Duration};

        use yuanyuan_bridge::current_process_identity;

        let created = Arc::new(AtomicUsize::new(0));
        let mut host = host(created.clone());
        let pipe_name = format!("yuanyuan.support-sort.once.{}", std::process::id());
        let server_name = pipe_name.clone();
        let expected_client = current_process_identity().unwrap();
        let (ready_sender, ready_receiver) = mpsc::sync_channel(1);
        let server = thread::spawn(move || {
            serve_one_support_sort_request_with_ready(
                &server_name,
                expected_client,
                &mut host,
                NOW,
                || ready_sender.send(()).unwrap(),
            )
        });
        ready_receiver.recv_timeout(Duration::from_secs(1)).unwrap();

        let response = send_one_support_sort_request(
            &pipe_name,
            &request(SupportSortIpcCommandV1::DescribeProvider {
                destination: SupportSortIpcDestination::LocalProvider,
            }),
        )
        .unwrap();
        assert!(matches!(
            &response.result,
            SupportSortIpcResultV1::ProviderDescription {
                provider_key,
                provider_fingerprint,
                ..
            } if provider_key == "local-provider" && provider_fingerprint == FINGERPRINT_A
        ));
        assert_eq!(created.load(Ordering::SeqCst), 0);
        server.join().unwrap().unwrap();
    }

    #[cfg(windows)]
    #[test]
    fn private_service_rebinds_after_invalid_input_and_stops_while_idle() {
        use std::time::{Duration, Instant};

        use yuanyuan_bridge::{current_process_identity, NamedPipeEventSink};

        let bootstrap =
            crate::SupportSortSessionBootstrap::generate(current_process_identity().unwrap())
                .unwrap();
        let pipe_name = Zeroizing::new(bootstrap.support_pipe_name().to_owned());
        let session_binding = Zeroizing::new(bootstrap.session_binding().to_owned());
        let service =
            SupportSortService::start(bootstrap, SupportSortProviderRegistry::default(), || NOW)
                .unwrap();

        let valid_but_abandoned = SupportSortIpcRequestV1 {
            protocol_version: SUPPORT_SORT_IPC_PROTOCOL_VERSION,
            request_id: "abandoned-response-1".to_owned(),
            session_binding: session_binding.to_string(),
            command: SupportSortIpcCommandV1::DescribeProvider {
                destination: SupportSortIpcDestination::LocalProvider,
            },
        };
        let valid_payload = Zeroizing::new(valid_but_abandoned.to_json().unwrap());
        write_pipe_message_and_disconnect(
            &pipe_name,
            br#"{"protocol_version":1,"request_id":"half-write"#,
        );
        write_pipe_message_and_disconnect(&pipe_name, &valid_payload);

        for invalid in [
            br#"{"protocol_version":1,"unknown":"must-fail-closed"}"#.as_slice(),
            br#"{"protocol_version":1,"request_id":"truncated"#.as_slice(),
        ] {
            assert!(NamedPipeEventSink::new(&pipe_name)
                .unwrap()
                .send_validated_payload_and_receive_response_with_timeout(
                    invalid,
                    MAX_SUPPORT_SORT_IPC_RESPONSE_BYTES,
                    Duration::from_secs(1),
                )
                .is_err());
        }

        let response = send_one_support_sort_request(
            &pipe_name,
            &SupportSortIpcRequestV1 {
                protocol_version: SUPPORT_SORT_IPC_PROTOCOL_VERSION,
                request_id: "service-request-1".to_owned(),
                session_binding: session_binding.to_string(),
                command: SupportSortIpcCommandV1::DescribeProvider {
                    destination: SupportSortIpcDestination::LocalProvider,
                },
            },
        )
        .unwrap();
        assert!(matches!(
            response.result,
            SupportSortIpcResultV1::Rejected {
                code: SupportSortIpcRejectionCode::ProviderUnavailable
            }
        ));

        let started = Instant::now();
        service.shutdown();
        assert!(started.elapsed() < Duration::from_secs(1));
    }

    #[cfg(windows)]
    #[test]
    fn caller_disconnect_cancels_the_in_flight_provider_and_service_recovers() {
        use std::time::{Duration, Instant};

        use yuanyuan_bridge::{current_process_identity, NamedPipeEventSink, SinkError};

        let provider_started = Arc::new(AtomicUsize::new(0));
        let provider_cancelled = Arc::new(AtomicUsize::new(0));
        let descriptor = SupportSortProviderDescriptor::try_new(SupportSortProviderContext {
            destination: SupportSortDestination::LocalProvider,
            provider_key: "local-provider",
            provider_fingerprint: FINGERPRINT_A,
            disclosure_version: SUPPORT_SORT_DISCLOSURE_VERSION,
        })
        .unwrap();
        let started_for_factory = provider_started.clone();
        let cancelled_for_factory = provider_cancelled.clone();
        let entry = SupportSortProviderEntry::try_new(
            descriptor,
            "本机取消测试器".to_owned(),
            "进程退出后不保留本次正文。".to_owned(),
            None,
            Box::new(move || {
                Box::new(WaitForCancellationAdapter {
                    started: started_for_factory.clone(),
                    cancelled: cancelled_for_factory.clone(),
                }) as Box<dyn ProviderAdapter>
            }),
        )
        .unwrap();
        let mut registry = SupportSortProviderRegistry::default();
        registry.set(entry);
        let bootstrap =
            crate::SupportSortSessionBootstrap::generate(current_process_identity().unwrap())
                .unwrap();
        let pipe_name = Zeroizing::new(bootstrap.support_pipe_name().to_owned());
        let session_binding = Zeroizing::new(bootstrap.session_binding().to_owned());
        let service = SupportSortService::start(bootstrap, registry, || NOW).unwrap();
        let make_request = |request_id: &str, command| SupportSortIpcRequestV1 {
            protocol_version: SUPPORT_SORT_IPC_PROTOCOL_VERSION,
            request_id: request_id.to_owned(),
            session_binding: session_binding.to_string(),
            command,
        };

        let description = send_one_support_sort_request(
            &pipe_name,
            &make_request(
                "disconnect-describe-1",
                SupportSortIpcCommandV1::DescribeProvider {
                    destination: SupportSortIpcDestination::LocalProvider,
                },
            ),
        )
        .unwrap();
        let SupportSortIpcResultV1::ProviderDescription {
            provider_key,
            provider_fingerprint,
            disclosure_version,
            disclosure_digest,
            ..
        } = &description.result
        else {
            panic!("expected provider description")
        };
        let authorization = send_one_support_sort_request(
            &pipe_name,
            &make_request(
                "disconnect-authorize-1",
                SupportSortIpcCommandV1::IssueAuthorization {
                    destination: SupportSortIpcDestination::LocalProvider,
                    provider_key: provider_key.clone(),
                    provider_fingerprint: provider_fingerprint.clone(),
                    disclosure_version: *disclosure_version,
                    disclosure_digest: disclosure_digest.clone(),
                    user_confirmed: true,
                },
            ),
        )
        .unwrap();
        let SupportSortIpcResultV1::AuthorizationIssued {
            authorization_token,
            ..
        } = &authorization.result
        else {
            panic!("expected authorization")
        };
        let submit = make_request(
            "disconnect-submit-1",
            SupportSortIpcCommandV1::Submit {
                authorization_token: authorization_token.clone(),
                destination: SupportSortIpcDestination::LocalProvider,
                provider_key: provider_key.clone(),
                provider_fingerprint: provider_fingerprint.clone(),
                disclosure_version: *disclosure_version,
                user_entered_text: "这次调用应在断连后停止".to_owned(),
            },
        );
        let payload = Zeroizing::new(submit.to_json().unwrap());
        let submit_pipe_name = pipe_name.to_string();
        let submit_client = std::thread::spawn(move || {
            NamedPipeEventSink::new(&submit_pipe_name)
                .unwrap()
                .send_validated_payload_and_receive_response_with_timeout(
                    &payload,
                    MAX_SUPPORT_SORT_IPC_RESPONSE_BYTES,
                    Duration::from_millis(300),
                )
        });
        let start_deadline = Instant::now() + Duration::from_secs(1);
        while Instant::now() < start_deadline && provider_started.load(Ordering::SeqCst) == 0 {
            std::thread::sleep(Duration::from_millis(5));
        }
        assert_eq!(provider_started.load(Ordering::SeqCst), 1);

        let concurrent = make_request(
            "disconnect-concurrent-1",
            SupportSortIpcCommandV1::DescribeProvider {
                destination: SupportSortIpcDestination::LocalProvider,
            },
        );
        let concurrent_payload = Zeroizing::new(concurrent.to_json().unwrap());
        assert!(matches!(
            NamedPipeEventSink::new(&pipe_name)
                .unwrap()
                .send_validated_payload_and_receive_response_with_timeout(
                    &concurrent_payload,
                    MAX_SUPPORT_SORT_IPC_RESPONSE_BYTES,
                    Duration::from_millis(50),
                ),
            Err(SinkError::Timeout)
        ));
        assert!(matches!(
            submit_client.join().unwrap(),
            Err(SinkError::Timeout)
        ));

        let cancellation_deadline = Instant::now() + Duration::from_secs(1);
        while Instant::now() < cancellation_deadline
            && provider_cancelled.load(Ordering::SeqCst) == 0
        {
            std::thread::sleep(Duration::from_millis(5));
        }
        assert_eq!(provider_cancelled.load(Ordering::SeqCst), 1);

        let recovered = send_one_support_sort_request(
            &pipe_name,
            &make_request(
                "disconnect-describe-2",
                SupportSortIpcCommandV1::DescribeProvider {
                    destination: SupportSortIpcDestination::LocalProvider,
                },
            ),
        )
        .unwrap();
        assert!(matches!(
            recovered.result,
            SupportSortIpcResultV1::ProviderDescription { .. }
        ));

        let second_authorization = send_one_support_sort_request(
            &pipe_name,
            &make_request(
                "shutdown-authorize-1",
                SupportSortIpcCommandV1::IssueAuthorization {
                    destination: SupportSortIpcDestination::LocalProvider,
                    provider_key: provider_key.clone(),
                    provider_fingerprint: provider_fingerprint.clone(),
                    disclosure_version: *disclosure_version,
                    disclosure_digest: disclosure_digest.clone(),
                    user_confirmed: true,
                },
            ),
        )
        .unwrap();
        let SupportSortIpcResultV1::AuthorizationIssued {
            authorization_token: second_token,
            ..
        } = &second_authorization.result
        else {
            panic!("expected second authorization")
        };
        let shutdown_submit = make_request(
            "shutdown-submit-1",
            SupportSortIpcCommandV1::Submit {
                authorization_token: second_token.clone(),
                destination: SupportSortIpcDestination::LocalProvider,
                provider_key: provider_key.clone(),
                provider_fingerprint: provider_fingerprint.clone(),
                disclosure_version: *disclosure_version,
                user_entered_text: "这次调用应在服务停机后停止".to_owned(),
            },
        );
        let shutdown_payload = Zeroizing::new(shutdown_submit.to_json().unwrap());
        let shutdown_pipe_name = pipe_name.to_string();
        let shutdown_client = std::thread::spawn(move || {
            NamedPipeEventSink::new(&shutdown_pipe_name)
                .unwrap()
                .send_validated_payload_and_receive_response_with_timeout(
                    &shutdown_payload,
                    MAX_SUPPORT_SORT_IPC_RESPONSE_BYTES,
                    Duration::from_secs(2),
                )
        });
        let second_start_deadline = Instant::now() + Duration::from_secs(1);
        while Instant::now() < second_start_deadline && provider_started.load(Ordering::SeqCst) < 2
        {
            std::thread::sleep(Duration::from_millis(5));
        }
        assert_eq!(provider_started.load(Ordering::SeqCst), 2);
        let shutdown_started = Instant::now();
        service.shutdown();
        assert!(shutdown_started.elapsed() < Duration::from_secs(1));
        assert!(shutdown_client.join().is_ok());
        let shutdown_cancellation_deadline = Instant::now() + Duration::from_secs(1);
        while Instant::now() < shutdown_cancellation_deadline
            && provider_cancelled.load(Ordering::SeqCst) < 2
        {
            std::thread::sleep(Duration::from_millis(5));
        }
        assert_eq!(provider_cancelled.load(Ordering::SeqCst), 2);
    }
}
