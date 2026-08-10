use std::{
    ffi::OsString,
    io::Write,
    path::{Path, PathBuf},
    process::{Child, Command, Stdio},
    sync::{
        atomic::{AtomicBool, AtomicU8, Ordering},
        Arc, Mutex,
    },
    thread,
    time::{Duration, Instant},
};

use std::os::windows::process::CommandExt;
use thiserror::Error;
use yuanyuan_ai::{
    request_task_service_health_with_timeout, request_task_service_shutdown,
    request_task_service_shutdown_with_timeout, send_one_support_sort_request,
    RestartCircuitBreaker, RestartDecision, SupportSortSessionBootstrap,
};
use yuanyuan_bridge::current_process_identity;
use yuanyuan_protocol::{
    SupportSortIpcCommandV1, SupportSortIpcRequestV1, SupportSortIpcResponseV1,
    SUPPORT_SORT_IPC_PROTOCOL_VERSION,
};

use crate::ai_sidecar_trust::{verify_production_ai_release, TrustedAiRelease};

const TASK_PIPE_NAME: &str = "yuanyuan.task-events.v1";
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[repr(u8)]
pub enum AiSupervisorStatus {
    Unavailable = 0,
    Starting = 1,
    Running = 2,
    BackingOff = 3,
    CircuitOpen = 4,
    Stopped = 5,
}

impl AiSupervisorStatus {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Unavailable => "unavailable",
            Self::Starting => "starting",
            Self::Running => "running",
            Self::BackingOff => "backing_off",
            Self::CircuitOpen => "circuit_open",
            Self::Stopped => "stopped",
        }
    }
}

pub struct AiSupervisor {
    stop: Arc<AtomicBool>,
    status: Arc<AtomicU8>,
    worker: Mutex<Option<thread::JoinHandle<()>>>,
    private_support_session: Arc<Mutex<Option<SupportSortSessionBootstrap>>>,
    config: Option<SupervisorConfig>,
}

#[derive(Debug, Clone, Copy, Error, PartialEq, Eq)]
#[cfg_attr(not(test), allow(dead_code))]
pub enum AiSupportSortRequestError {
    #[error("AI support service is unavailable")]
    Unavailable,
    #[error("AI support session is unavailable")]
    SessionUnavailable,
    #[error("AI support request failed")]
    Delivery,
}

#[derive(Clone)]
struct SupervisorConfig {
    executable: PathBuf,
    trusted_release: Option<Arc<TrustedAiRelease>>,
    arguments: Vec<OsString>,
    control_pipe_name: String,
    startup_timeout: Duration,
    breaker: RestartCircuitBreaker,
    private_support_bootstrap: bool,
}

impl AiSupervisor {
    pub fn start_if_available() -> Self {
        let config = std::env::current_exe().ok().and_then(|stable_core| {
            let ai_executable = ai_binary_next_to(&stable_core)?;
            verify_production_ai_release(&stable_core, &ai_executable)
                .map(production_supervisor_config)
        });
        Self::start_with_config(config)
    }

    #[cfg(test)]
    pub(crate) fn start(executable: Option<PathBuf>) -> Self {
        let config = executable
            .filter(|path| path.is_file())
            .map(test_supervisor_config);
        Self::start_with_config(config)
    }

    fn start_with_config(config: Option<SupervisorConfig>) -> Self {
        let stop = Arc::new(AtomicBool::new(false));
        let status = Arc::new(AtomicU8::new(AiSupervisorStatus::Unavailable as u8));
        let private_support_session = Arc::new(Mutex::new(None));
        let retained_config = config.clone();
        let worker = config.map(|config| {
            let stop = stop.clone();
            let status = status.clone();
            let private_support_session = private_support_session.clone();
            thread::spawn(move || supervise(config, stop, status, private_support_session))
        });
        Self {
            stop,
            status,
            worker: Mutex::new(worker),
            private_support_session,
            config: retained_config,
        }
    }

    pub fn status(&self) -> AiSupervisorStatus {
        match self.status.load(Ordering::SeqCst) {
            1 => AiSupervisorStatus::Starting,
            2 => AiSupervisorStatus::Running,
            3 => AiSupervisorStatus::BackingOff,
            4 => AiSupervisorStatus::CircuitOpen,
            5 => AiSupervisorStatus::Stopped,
            _ => AiSupervisorStatus::Unavailable,
        }
    }

    pub fn binary_present(&self) -> bool {
        self.config.is_some()
    }

    /// Stable-core-only request boundary. The caller supplies a typed command,
    /// while the private pipe name and session binding never leave Rust or the
    /// supervisor-owned process epoch. This remains deliberately unregistered
    /// with Tauri until the later product/privacy gate is complete.
    #[cfg_attr(not(test), allow(dead_code))]
    pub fn request_support_sort(
        &self,
        request_id: String,
        command: SupportSortIpcCommandV1,
    ) -> Result<SupportSortIpcResponseV1, AiSupportSortRequestError> {
        if self.status() != AiSupervisorStatus::Running {
            return Err(AiSupportSortRequestError::Unavailable);
        }
        let session = self
            .private_support_session
            .lock()
            .map_err(|_| AiSupportSortRequestError::SessionUnavailable)?;
        let bootstrap = session
            .as_ref()
            .ok_or(AiSupportSortRequestError::SessionUnavailable)?;
        let request = SupportSortIpcRequestV1 {
            protocol_version: SUPPORT_SORT_IPC_PROTOCOL_VERSION,
            request_id,
            session_binding: bootstrap.session_binding().to_owned(),
            command,
        };
        send_one_support_sort_request(bootstrap.support_pipe_name(), &request)
            .map_err(|_| AiSupportSortRequestError::Delivery)
    }

    #[cfg(test)]
    fn private_support_session_ready(&self) -> bool {
        self.status() == AiSupervisorStatus::Running
            && self
                .private_support_session
                .lock()
                .map(|session| session.is_some())
                .unwrap_or(false)
    }

    #[cfg(test)]
    pub(crate) fn install_running_test_support_session(
        &self,
        bootstrap: SupportSortSessionBootstrap,
    ) -> bool {
        if !install_private_support_session(&self.private_support_session, Some(bootstrap)) {
            return false;
        }
        self.status
            .store(AiSupervisorStatus::Running as u8, Ordering::SeqCst);
        true
    }

    pub fn shutdown(&self) {
        self.stop.store(true, Ordering::SeqCst);
        clear_private_support_session(&self.private_support_session);
        let control_pipe = self
            .config
            .as_ref()
            .map(|config| config.control_pipe_name.as_str())
            .unwrap_or("yuanyuan.task-events.v1.shutdown");
        let _ = request_task_service_shutdown(control_pipe);
        if let Ok(mut worker) = self.worker.lock() {
            if let Some(worker) = worker.take() {
                let _ = worker.join();
            }
        }
        self.status
            .store(AiSupervisorStatus::Stopped as u8, Ordering::SeqCst);
    }

    /// Starts a new supervision epoch only after a user-visible circuit break.
    pub fn restart_after_circuit(&self) -> bool {
        if self.status() != AiSupervisorStatus::CircuitOpen {
            return false;
        }
        let Some(config) = self.config.clone() else {
            return false;
        };
        let Ok(mut worker) = self.worker.lock() else {
            return false;
        };
        if let Some(previous) = worker.take() {
            let _ = previous.join();
        }
        self.stop.store(false, Ordering::SeqCst);
        clear_private_support_session(&self.private_support_session);
        self.status
            .store(AiSupervisorStatus::Starting as u8, Ordering::SeqCst);
        let stop = self.stop.clone();
        let status = self.status.clone();
        let private_support_session = self.private_support_session.clone();
        *worker = Some(thread::spawn(move || {
            supervise(config, stop, status, private_support_session)
        }));
        true
    }
}

fn supervise(
    config: SupervisorConfig,
    stop: Arc<AtomicBool>,
    status: Arc<AtomicU8>,
    private_support_session: Arc<Mutex<Option<SupportSortSessionBootstrap>>>,
) {
    let SupervisorConfig {
        executable,
        trusted_release: _trusted_release,
        arguments,
        control_pipe_name,
        startup_timeout,
        mut breaker,
        private_support_bootstrap,
    } = config;
    while !stop.load(Ordering::SeqCst) {
        status.store(AiSupervisorStatus::Starting as u8, Ordering::SeqCst);
        let Ok(mut spawned) = spawn_ai(&executable, &arguments, private_support_bootstrap) else {
            clear_private_support_session(&private_support_session);
            status.store(AiSupervisorStatus::Unavailable as u8, Ordering::SeqCst);
            return;
        };
        if !install_private_support_session(
            &private_support_session,
            spawned.private_support_session.take(),
        ) {
            terminate_owned_child(&mut spawned.child);
            status.store(AiSupervisorStatus::Unavailable as u8, Ordering::SeqCst);
            return;
        }
        let mut child = spawned.child;
        let started = Instant::now();
        if !wait_for_health(&stop, &control_pipe_name, startup_timeout) {
            terminate_owned_child(&mut child);
        } else {
            status.store(AiSupervisorStatus::Running as u8, Ordering::SeqCst);
            monitor_child(&stop, &mut child);
        }

        clear_private_support_session(&private_support_session);

        if stop.load(Ordering::SeqCst) {
            graceful_stop(&mut child, &control_pipe_name);
            break;
        }
        breaker.record_healthy_run(started.elapsed());
        match breaker.record_failure(Instant::now()) {
            RestartDecision::OpenCircuit => {
                status.store(AiSupervisorStatus::CircuitOpen as u8, Ordering::SeqCst);
                return;
            }
            RestartDecision::RestartAfter(delay) => {
                status.store(AiSupervisorStatus::BackingOff as u8, Ordering::SeqCst);
                wait_interruptibly(&stop, delay);
            }
        }
    }
    clear_private_support_session(&private_support_session);
    status.store(AiSupervisorStatus::Stopped as u8, Ordering::SeqCst);
}

struct SpawnedAi {
    child: Child,
    private_support_session: Option<SupportSortSessionBootstrap>,
}

fn spawn_ai(
    executable: &Path,
    arguments: &[OsString],
    private_support_bootstrap: bool,
) -> std::io::Result<SpawnedAi> {
    let bootstrap = if private_support_bootstrap {
        Some(
            SupportSortSessionBootstrap::generate(current_process_identity().map_err(|_| {
                std::io::Error::other("stable core process identity is unavailable")
            })?)
            .map_err(|_| std::io::Error::other("private AI bootstrap generation failed"))?,
        )
    } else {
        None
    };

    let mut command = Command::new(executable);
    command.args(arguments);
    if bootstrap.is_some() {
        command
            .arg("--support-bootstrap-stdin")
            .stdin(Stdio::piped());
    } else {
        command.stdin(Stdio::null());
    }
    let mut child = command
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .creation_flags(CREATE_NO_WINDOW)
        .spawn()?;

    if let Some(bootstrap) = bootstrap.as_ref() {
        let write_result = child
            .stdin
            .take()
            .ok_or_else(|| std::io::Error::other("private AI bootstrap pipe is unavailable"))
            .and_then(|mut stdin| {
                bootstrap
                    .write_to(&mut stdin)
                    .map_err(|_| std::io::Error::other("private AI bootstrap write failed"))?;
                stdin.flush()
            });
        if let Err(error) = write_result {
            terminate_owned_child(&mut child);
            return Err(error);
        }
    }

    Ok(SpawnedAi {
        child,
        private_support_session: bootstrap,
    })
}

fn install_private_support_session(
    state: &Mutex<Option<SupportSortSessionBootstrap>>,
    session: Option<SupportSortSessionBootstrap>,
) -> bool {
    state
        .lock()
        .map(|mut current| {
            *current = session;
        })
        .is_ok()
}

fn clear_private_support_session(state: &Mutex<Option<SupportSortSessionBootstrap>>) {
    if let Ok(mut session) = state.lock() {
        session.take();
    }
}

fn wait_for_health(stop: &AtomicBool, control_pipe_name: &str, timeout: Duration) -> bool {
    let deadline = Instant::now() + timeout;
    while !stop.load(Ordering::SeqCst) {
        let Some(remaining) = deadline.checked_duration_since(Instant::now()) else {
            break;
        };
        if remaining.is_zero() {
            break;
        }
        let probe_timeout = remaining.min(Duration::from_millis(50));
        if request_task_service_health_with_timeout(control_pipe_name, probe_timeout).is_ok() {
            return true;
        }
        let Some(remaining) = deadline.checked_duration_since(Instant::now()) else {
            break;
        };
        if !remaining.is_zero() {
            thread::sleep(remaining.min(Duration::from_millis(10)));
        }
    }
    false
}

fn monitor_child(stop: &AtomicBool, child: &mut Child) {
    while !stop.load(Ordering::SeqCst) {
        match child.try_wait() {
            Ok(Some(_)) | Err(_) => return,
            Ok(None) => thread::sleep(Duration::from_millis(250)),
        }
    }
}

fn graceful_stop(child: &mut Child, control_pipe_name: &str) {
    const SHUTDOWN_TIMEOUT: Duration = Duration::from_secs(2);
    let deadline = Instant::now() + SHUTDOWN_TIMEOUT;
    let _ = request_task_service_shutdown_with_timeout(control_pipe_name, SHUTDOWN_TIMEOUT);
    while Instant::now() < deadline {
        if matches!(child.try_wait(), Ok(Some(_))) {
            return;
        }
        thread::sleep(Duration::from_millis(50));
    }
    terminate_owned_child(child);
}

fn terminate_owned_child(child: &mut Child) {
    let _ = child.kill();
    let _ = child.wait();
}

fn wait_interruptibly(stop: &AtomicBool, duration: Duration) {
    let deadline = Instant::now() + duration;
    while Instant::now() < deadline && !stop.load(Ordering::SeqCst) {
        thread::sleep(Duration::from_millis(50));
    }
}

fn control_pipe_name() -> String {
    format!("{TASK_PIPE_NAME}.shutdown")
}

fn production_supervisor_config(trusted_release: Arc<TrustedAiRelease>) -> SupervisorConfig {
    SupervisorConfig {
        executable: trusted_release.executable().to_path_buf(),
        trusted_release: Some(trusted_release),
        arguments: Vec::new(),
        control_pipe_name: control_pipe_name(),
        startup_timeout: Duration::from_secs(3),
        breaker: RestartCircuitBreaker::default(),
        private_support_bootstrap: true,
    }
}

#[cfg(test)]
fn test_supervisor_config(executable: PathBuf) -> SupervisorConfig {
    SupervisorConfig {
        executable,
        trusted_release: None,
        arguments: Vec::new(),
        control_pipe_name: control_pipe_name(),
        startup_timeout: Duration::from_secs(3),
        breaker: RestartCircuitBreaker::default(),
        private_support_bootstrap: true,
    }
}

fn ai_binary_next_to(current_executable: &Path) -> Option<PathBuf> {
    current_executable
        .parent()
        .filter(|directory| !directory.as_os_str().is_empty())
        .map(|directory| directory.join("yuanyuan-ai.exe"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::{self, Write};
    use yuanyuan_ai::{
        CancellationToken, ProviderAdapter, ProviderAdapterError, ProviderCapabilities,
        ProviderEvent, ProviderEventSink, ProviderFinal, ProviderOperation, ProviderRequest,
        SupportSortDestination, SupportSortProviderContext, SupportSortProviderDescriptor,
        SupportSortProviderEntry, SupportSortProviderRegistry, SupportSortService,
        SUPPORT_SORT_DISCLOSURE_VERSION,
    };
    use yuanyuan_protocol::{
        SupportSortIpcDestination, SupportSortIpcRejectionCode, SupportSortIpcResultV1,
    };

    fn wait_for_status(
        supervisor: &AiSupervisor,
        expected: AiSupervisorStatus,
        timeout: Duration,
    ) -> bool {
        let deadline = Instant::now() + timeout;
        while Instant::now() < deadline {
            if supervisor.status() == expected {
                return true;
            }
            thread::sleep(Duration::from_millis(10));
        }
        false
    }

    fn command_interpreter() -> PathBuf {
        std::env::var_os("COMSPEC")
            .map(PathBuf::from)
            .filter(|path| path.is_file())
            .unwrap_or_else(|| PathBuf::from(r"C:\Windows\System32\cmd.exe"))
    }

    const STABLE_CORE_PRIVACY_CANARY: &str = "YUANYUAN_SUPPORT_SORT_PRIVATE_TEXT_CANARY_7F2C19A4";

    struct StableCoreCanaryProvider;

    impl ProviderAdapter for StableCoreCanaryProvider {
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
            request: ProviderRequest,
            _cancellation: CancellationToken,
            events: ProviderEventSink,
        ) -> Result<(), ProviderAdapterError> {
            if request.operation != ProviderOperation::SupportSort
                || request
                    .input
                    .get("user_entered_text")
                    .and_then(|value| value.as_str())
                    != Some(STABLE_CORE_PRIVACY_CANARY)
            {
                return Err(ProviderAdapterError::Rejected);
            }
            let document = serde_json::json!({
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
                    "rows": [["需求发生变化", "感到不悦", "可以确认范围", "先列出一个问题"]]
                }],
                "references": [],
                "actions": []
            });
            events.emit(ProviderEvent::Final(ProviderFinal {
                response_intent_json:
                    br#"{"schema_version":1,"intent":"present_information","priority":"normal"}"#
                        .to_vec(),
                display_document_json: serde_json::to_vec(&document).ok(),
            }))
        }
    }

    fn stable_core_canary_registry() -> SupportSortProviderRegistry {
        let descriptor = SupportSortProviderDescriptor::try_new(SupportSortProviderContext {
            destination: SupportSortDestination::LocalProvider,
            provider_key: "stable-core-canary-provider",
            provider_fingerprint:
                "EEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEE",
            disclosure_version: SUPPORT_SORT_DISCLOSURE_VERSION,
        })
        .unwrap();
        let entry = SupportSortProviderEntry::try_new(
            descriptor,
            "稳定核心隐私测试Provider".to_owned(),
            "仅用于自动测试，不保留输入".to_owned(),
            None,
            Box::new(|| -> Box<dyn ProviderAdapter> { Box::new(StableCoreCanaryProvider) }),
        )
        .unwrap();
        let mut registry = SupportSortProviderRegistry::default();
        registry.set(entry);
        registry
    }

    #[derive(Clone)]
    struct CapturedLogWriter(Arc<Mutex<Vec<u8>>>);

    impl Write for CapturedLogWriter {
        fn write(&mut self, buffer: &[u8]) -> io::Result<usize> {
            self.0.lock().unwrap().extend_from_slice(buffer);
            Ok(buffer.len())
        }

        fn flush(&mut self) -> io::Result<()> {
            Ok(())
        }
    }

    #[test]
    fn ai_binary_is_resolved_only_next_to_the_stable_core() {
        assert_eq!(
            ai_binary_next_to(Path::new(
                r"C:\Program Files\Yuanyuan\yuanyuan-reminder.exe"
            )),
            Some(PathBuf::from(r"C:\Program Files\Yuanyuan\yuanyuan-ai.exe"))
        );
        assert_eq!(ai_binary_next_to(Path::new("yuanyuan-reminder.exe")), None);

        let config =
            test_supervisor_config(PathBuf::from(r"C:\Program Files\Yuanyuan\yuanyuan-ai.exe"));
        assert!(config.trusted_release.is_none());
        assert!(config.private_support_bootstrap);
        assert!(config.arguments.is_empty());
    }

    #[test]
    fn unavailable_binary_does_not_start_a_worker() {
        let supervisor = AiSupervisor::start(None);
        assert_eq!(supervisor.status(), AiSupervisorStatus::Unavailable);
        supervisor.shutdown();
        assert_eq!(supervisor.status(), AiSupervisorStatus::Stopped);
    }

    #[test]
    fn ai_unavailable_keeps_full_offline_reminder_core_usable() {
        let supervisor = AiSupervisor::start(None);
        assert_eq!(supervisor.status(), AiSupervisorStatus::Unavailable);
        assert!(!supervisor.binary_present());
        assert!(!supervisor.private_support_session_ready());
        assert!(!supervisor.restart_after_circuit());
        assert!(supervisor.worker.lock().unwrap().is_none());

        let database = std::env::temp_dir().join(format!(
            "yuanyuan-ai-disabled-core-{}.sqlite3",
            uuid::Uuid::new_v4()
        ));
        let mut repository = crate::repository::Repository::open(&database).unwrap();
        repository.get_settings().unwrap();
        let reminder = repository
            .create_reminder(crate::models::CreateReminderInput {
                title: "AI关闭回归事项".into(),
                category: "work".into(),
                schedule_kind: "once".into(),
                at_local: Some(
                    (chrono::Local::now() - chrono::Duration::minutes(1))
                        .format("%Y-%m-%dT%H:%M")
                        .to_string(),
                ),
                every_minutes: None,
                active_start_local: None,
                active_end_local: None,
                weekdays: None,
            })
            .unwrap();
        let due = repository.claim_due(chrono::Utc::now()).unwrap();
        let occurrence = due
            .iter()
            .find(|item| item.occurrence.reminder_id == reminder.id)
            .expect("offline reminder must still become due");
        assert!(occurrence.notify);
        let occurrence_id = occurrence.occurrence.id.clone();
        assert!(repository
            .start_focus("focus", 1)
            .unwrap()
            .session
            .is_some());

        supervisor.shutdown();
        assert_eq!(supervisor.status(), AiSupervisorStatus::Stopped);
        assert!(!repository.complete_occurrence(&occurrence_id).unwrap());
        assert!(repository.list_today(false).is_ok());

        drop(repository);
        for candidate in [
            database.clone(),
            database.with_extension("sqlite3-wal"),
            database.with_extension("sqlite3-shm"),
        ] {
            let _ = std::fs::remove_file(candidate);
        }
    }

    #[test]
    fn real_crashing_children_open_the_circuit_while_reminders_keep_working() {
        let config = SupervisorConfig {
            executable: command_interpreter(),
            trusted_release: None,
            arguments: ["/C", "exit 23"].map(OsString::from).into(),
            control_pipe_name: format!("yuanyuan.supervisor.crash-test.{}", std::process::id()),
            startup_timeout: Duration::from_millis(20),
            breaker: RestartCircuitBreaker::with_policy(
                3,
                Duration::from_secs(5),
                Duration::from_millis(10),
                Duration::from_millis(20),
            ),
            private_support_bootstrap: false,
        };
        let database = std::env::temp_dir().join(format!(
            "yuanyuan-supervisor-core-{}.sqlite3",
            uuid::Uuid::new_v4()
        ));
        let repository = crate::repository::Repository::open(&database).unwrap();
        let supervisor = AiSupervisor::start_with_config(Some(config));

        let deadline = Instant::now() + Duration::from_secs(2);
        while Instant::now() < deadline && supervisor.status() != AiSupervisorStatus::CircuitOpen {
            repository.get_settings().unwrap();
            repository.list_today(false).unwrap();
            thread::sleep(Duration::from_millis(5));
        }
        assert_eq!(supervisor.status(), AiSupervisorStatus::CircuitOpen);
        assert!(repository
            .start_focus("focus", 1)
            .unwrap()
            .session
            .is_some());
        assert!(supervisor.restart_after_circuit());
        assert!(wait_for_status(
            &supervisor,
            AiSupervisorStatus::CircuitOpen,
            Duration::from_secs(2)
        ));
        assert!(repository.get_focus_state().unwrap().session.is_some());
        supervisor.shutdown();
        drop(repository);
        let _ = std::fs::remove_file(&database);
        let _ = std::fs::remove_file(database.with_extension("sqlite3-wal"));
        let _ = std::fs::remove_file(database.with_extension("sqlite3-shm"));
    }

    #[test]
    fn real_unhealthy_child_is_terminated_and_fused() {
        let config = SupervisorConfig {
            executable: command_interpreter(),
            trusted_release: None,
            arguments: ["/C", "ping -n 30 127.0.0.1 >nul"]
                .map(OsString::from)
                .into(),
            control_pipe_name: format!("yuanyuan.supervisor.unhealthy-test.{}", std::process::id()),
            startup_timeout: Duration::from_millis(50),
            breaker: RestartCircuitBreaker::with_policy(
                1,
                Duration::from_secs(5),
                Duration::ZERO,
                Duration::ZERO,
            ),
            private_support_bootstrap: false,
        };
        let supervisor = AiSupervisor::start_with_config(Some(config));
        assert!(wait_for_status(
            &supervisor,
            AiSupervisorStatus::CircuitOpen,
            Duration::from_secs(2)
        ));
        supervisor.shutdown();
        assert_eq!(supervisor.status(), AiSupervisorStatus::Stopped);
    }

    #[test]
    fn private_support_session_is_visible_only_during_a_running_epoch() {
        let supervisor = AiSupervisor::start(None);
        let bootstrap =
            SupportSortSessionBootstrap::generate(current_process_identity().unwrap()).unwrap();
        assert!(install_private_support_session(
            &supervisor.private_support_session,
            Some(bootstrap)
        ));
        assert!(!supervisor.private_support_session_ready());

        supervisor
            .status
            .store(AiSupervisorStatus::Running as u8, Ordering::SeqCst);
        assert!(supervisor.private_support_session_ready());

        supervisor
            .status
            .store(AiSupervisorStatus::CircuitOpen as u8, Ordering::SeqCst);
        assert!(!supervisor.private_support_session_ready());
        supervisor.shutdown();
        assert!(supervisor.private_support_session.lock().unwrap().is_none());
    }

    #[test]
    fn stable_core_injects_the_private_session_into_typed_support_requests() {
        let generated =
            SupportSortSessionBootstrap::generate(current_process_identity().unwrap()).unwrap();
        let mut encoded = Vec::new();
        generated.write_to(&mut encoded).unwrap();
        let service_bootstrap = SupportSortSessionBootstrap::read_from(encoded.as_slice()).unwrap();
        let supervisor_bootstrap =
            SupportSortSessionBootstrap::read_from(encoded.as_slice()).unwrap();
        encoded.fill(0);
        let service = SupportSortService::start(
            service_bootstrap,
            SupportSortProviderRegistry::default(),
            || 1_775_212_800_000,
        )
        .unwrap();
        let supervisor = AiSupervisor::start(None);
        assert!(install_private_support_session(
            &supervisor.private_support_session,
            Some(supervisor_bootstrap)
        ));
        supervisor
            .status
            .store(AiSupervisorStatus::Running as u8, Ordering::SeqCst);

        let response = supervisor
            .request_support_sort(
                "stable-core-request-1".to_owned(),
                SupportSortIpcCommandV1::DescribeProvider {
                    destination: SupportSortIpcDestination::LocalProvider,
                },
            )
            .unwrap();
        assert!(matches!(
            response.result,
            SupportSortIpcResultV1::Rejected {
                code: SupportSortIpcRejectionCode::ProviderUnavailable
            }
        ));

        supervisor.shutdown();
        service.shutdown();
    }

    #[test]
    fn stable_core_typed_support_flow_never_logs_the_exact_user_text() {
        let generated =
            SupportSortSessionBootstrap::generate(current_process_identity().unwrap()).unwrap();
        let mut encoded = Vec::new();
        generated.write_to(&mut encoded).unwrap();
        let service_bootstrap = SupportSortSessionBootstrap::read_from(encoded.as_slice()).unwrap();
        let supervisor_bootstrap =
            SupportSortSessionBootstrap::read_from(encoded.as_slice()).unwrap();
        encoded.fill(0);
        let service =
            SupportSortService::start(service_bootstrap, stable_core_canary_registry(), || {
                1_775_212_800_000
            })
            .unwrap();
        let supervisor = AiSupervisor::start(None);
        assert!(install_private_support_session(
            &supervisor.private_support_session,
            Some(supervisor_bootstrap)
        ));
        supervisor
            .status
            .store(AiSupervisorStatus::Running as u8, Ordering::SeqCst);

        let captured = Arc::new(Mutex::new(Vec::new()));
        let writer = captured.clone();
        let subscriber = tracing_subscriber::fmt()
            .without_time()
            .with_ansi(false)
            .with_writer(move || CapturedLogWriter(writer.clone()))
            .finish();
        tracing::subscriber::with_default(subscriber, || {
            let description = supervisor
                .request_support_sort(
                    "stable-core-privacy-describe".to_owned(),
                    SupportSortIpcCommandV1::DescribeProvider {
                        destination: SupportSortIpcDestination::LocalProvider,
                    },
                )
                .unwrap();
            let (provider_key, provider_fingerprint, disclosure_version, disclosure_digest) =
                match &description.result {
                    SupportSortIpcResultV1::ProviderDescription {
                        provider_key,
                        provider_fingerprint,
                        disclosure_version,
                        disclosure_digest,
                        ..
                    } => (
                        provider_key.clone(),
                        provider_fingerprint.clone(),
                        *disclosure_version,
                        disclosure_digest.clone(),
                    ),
                    _ => panic!("stable-core canary provider was not described"),
                };
            let authorization = supervisor
                .request_support_sort(
                    "stable-core-privacy-authorize".to_owned(),
                    SupportSortIpcCommandV1::IssueAuthorization {
                        destination: SupportSortIpcDestination::LocalProvider,
                        provider_key: provider_key.clone(),
                        provider_fingerprint: provider_fingerprint.clone(),
                        disclosure_version,
                        disclosure_digest,
                        user_confirmed: true,
                    },
                )
                .unwrap();
            let authorization_token = match &authorization.result {
                SupportSortIpcResultV1::AuthorizationIssued {
                    authorization_token,
                    one_use: true,
                    ..
                } => authorization_token.clone(),
                _ => panic!("stable-core canary authorization was not issued"),
            };
            let completed = supervisor
                .request_support_sort(
                    "stable-core-privacy-submit".to_owned(),
                    SupportSortIpcCommandV1::Submit {
                        authorization_token,
                        destination: SupportSortIpcDestination::LocalProvider,
                        provider_key,
                        provider_fingerprint,
                        disclosure_version,
                        user_entered_text: STABLE_CORE_PRIVACY_CANARY.to_owned(),
                    },
                )
                .unwrap();
            assert!(matches!(
                &completed.result,
                SupportSortIpcResultV1::SortCompleted { .. }
            ));
        });

        supervisor.shutdown();
        service.shutdown();
        let logs = captured.lock().unwrap();
        assert!(!logs
            .windows(STABLE_CORE_PRIVACY_CANARY.len())
            .any(|window| window == STABLE_CORE_PRIVACY_CANARY.as_bytes()));
    }
}
