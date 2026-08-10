#[cfg(windows)]
use std::{
    sync::mpsc::{Receiver, RecvTimeoutError},
    time::Duration,
};

#[cfg(windows)]
const RETENTION_INITIAL_DELAY: Duration = Duration::from_secs(5);
#[cfg(windows)]
const RETENTION_INTERVAL: Duration = Duration::from_secs(6 * 60 * 60);

#[cfg(windows)]
fn run_retention_schedule<F, E>(
    stop: Receiver<()>,
    initial_delay: Duration,
    interval: Duration,
    mut run_cycle: F,
) where
    F: FnMut() -> Result<(), E>,
{
    if interval.is_zero() {
        return;
    }
    let mut delay = initial_delay;
    loop {
        match stop.recv_timeout(delay) {
            Ok(()) | Err(RecvTimeoutError::Disconnected) => return,
            Err(RecvTimeoutError::Timeout) => {
                let _ = run_cycle();
                delay = interval;
            }
        }
    }
}

#[cfg(windows)]
fn main() {
    use std::time::SystemTime;

    #[cfg(debug_assertions)]
    use yuanyuan_ai::run_task_service_with_control_version;
    use yuanyuan_ai::{
        receive_commit_and_ack_one, replay_authenticated_spool, request_task_service_shutdown,
        run_task_service_with_ready, TaskRetentionPolicy, TaskStore,
        RETENTION_INCREMENTAL_VACUUM_PAGES_PER_CYCLE,
    };
    use yuanyuan_bridge::{
        Spool, SpoolLimits, TrustEnforcingKeyResolver, WindowsCredentialKeyResolver,
        WindowsNamedPipeServer,
    };

    let Some(options) = Options::parse(std::env::args().skip(1)) else {
        return;
    };
    let shutdown_pipe = format!("{}.shutdown", options.pipe_name);
    if options.shutdown {
        let _ = request_task_service_shutdown(&shutdown_pipe);
        return;
    }
    if yuanyuan_ai::enforce_sensitive_process_crash_policy().is_err() {
        return;
    }
    let support_sort_bootstrap = if options.support_bootstrap_stdin {
        let stdin = std::io::stdin();
        let Ok(bootstrap) = yuanyuan_ai::SupportSortSessionBootstrap::read_from(stdin.lock())
        else {
            return;
        };
        if bootstrap.validate_current_parent().is_err() {
            return;
        }
        Some(bootstrap)
    } else {
        None
    };
    let Some(local_app_data) = std::env::var_os("LOCALAPPDATA") else {
        return;
    };
    let root = std::path::PathBuf::from(local_app_data).join("Yuanyuan");
    if std::fs::create_dir_all(&root).is_err()
        || yuanyuan_bridge::apply_current_user_only_dacl(&root).is_err()
    {
        return;
    }
    let Some(_instance_lock) = acquire_instance_lock(&root) else {
        return;
    };
    let database_path = options
        .database
        .unwrap_or_else(|| root.join("yuanyuan-ai.sqlite3"));
    let spool_path = options.spool.unwrap_or_else(|| root.join("bridge-spool"));
    let Ok(mut store) = TaskStore::open(&database_path) else {
        return;
    };
    let keys = TrustEnforcingKeyResolver::new(
        WindowsCredentialKeyResolver,
        root.join("connector-trust.sqlite3"),
    );
    let support_sort_service = match support_sort_bootstrap {
        Some(bootstrap) => {
            let registry = yuanyuan_ai::SupportSortProviderRegistry::default();
            #[cfg(any(debug_assertions, feature = "crash-privacy-qa"))]
            let registry = if options.test_support_sort_canary_provider {
                #[cfg(feature = "crash-privacy-qa")]
                let crash_after_submit = options.test_support_sort_crash_after_submit;
                #[cfg(not(feature = "crash-privacy-qa"))]
                let crash_after_submit = false;
                let Some(test_registry) = test_support_sort_registry(crash_after_submit) else {
                    return;
                };
                test_registry
            } else {
                registry
            };
            let Ok(service) =
                yuanyuan_ai::SupportSortService::start(bootstrap, registry, unix_time_ms)
            else {
                return;
            };
            Some(service)
        }
        None => None,
    };

    if spool_path.is_dir() {
        if let Ok(spool) = Spool::open(&spool_path, SpoolLimits::default()) {
            let _ = replay_authenticated_spool(&spool, &mut store, &keys, unix_time_ms());
        }
    }

    if options.once {
        let Ok(server) = WindowsNamedPipeServer::bind(&options.pipe_name) else {
            return;
        };
        let _ = receive_commit_and_ack_one(server, &mut store, &keys, unix_time_ms());
    } else {
        #[cfg(debug_assertions)]
        if let Some(version) = options.test_control_protocol_version {
            let _ = run_task_service_with_control_version(
                &options.pipe_name,
                &shutdown_pipe,
                &mut store,
                &keys,
                unix_time_ms,
                version,
            );
            return;
        }
        let retention_database = database_path.clone();
        let (retention_stop, retention_stop_receiver) = std::sync::mpsc::channel();
        let mut retention_thread = None;
        let service_result = run_task_service_with_ready(
            &options.pipe_name,
            &shutdown_pipe,
            &mut store,
            &keys,
            unix_time_ms,
            || {
                retention_thread = Some(std::thread::spawn(move || {
                    run_retention_schedule(
                        retention_stop_receiver,
                        RETENTION_INITIAL_DELAY,
                        RETENTION_INTERVAL,
                        || {
                            let mut retention_store = TaskStore::open(&retention_database)?;
                            let outcome = retention_store
                                .apply_retention(TaskRetentionPolicy::default(), unix_time_ms())?;
                            if outcome.event_rows_deleted > 0 || outcome.task_rows_deleted > 0 {
                                let _ = retention_store.apply_incremental_vacuum(
                                    RETENTION_INCREMENTAL_VACUUM_PAGES_PER_CYCLE,
                                );
                            }
                            Ok::<(), yuanyuan_ai::TaskStoreError>(())
                        },
                    );
                }));
            },
        );
        let _ = retention_stop.send(());
        if let Some(thread) = retention_thread {
            let _ = thread.join();
        }
        if let Some(service) = support_sort_service {
            service.shutdown();
        }
        let _ = service_result;
    }

    fn unix_time_ms() -> i64 {
        SystemTime::now()
            .duration_since(SystemTime::UNIX_EPOCH)
            .ok()
            .and_then(|duration| i64::try_from(duration.as_millis()).ok())
            .unwrap_or(0)
    }
}

#[cfg(windows)]
struct Options {
    pipe_name: String,
    database: Option<std::path::PathBuf>,
    spool: Option<std::path::PathBuf>,
    once: bool,
    shutdown: bool,
    support_bootstrap_stdin: bool,
    #[cfg(any(debug_assertions, feature = "crash-privacy-qa"))]
    test_support_sort_canary_provider: bool,
    #[cfg(feature = "crash-privacy-qa")]
    test_support_sort_crash_after_submit: bool,
    #[cfg(debug_assertions)]
    test_control_protocol_version: Option<u16>,
}

#[cfg(windows)]
impl Options {
    fn parse(mut args: impl Iterator<Item = String>) -> Option<Self> {
        let mut options = Self {
            pipe_name: "yuanyuan.task-events.v1".into(),
            database: None,
            spool: None,
            once: false,
            shutdown: false,
            support_bootstrap_stdin: false,
            #[cfg(any(debug_assertions, feature = "crash-privacy-qa"))]
            test_support_sort_canary_provider: false,
            #[cfg(feature = "crash-privacy-qa")]
            test_support_sort_crash_after_submit: false,
            #[cfg(debug_assertions)]
            test_control_protocol_version: None,
        };
        while let Some(argument) = args.next() {
            match argument.as_str() {
                "--pipe-name" => options.pipe_name = args.next()?,
                "--database" => options.database = Some(args.next()?.into()),
                "--spool" => options.spool = Some(args.next()?.into()),
                "--once" => options.once = true,
                "--shutdown" => options.shutdown = true,
                "--support-bootstrap-stdin" => options.support_bootstrap_stdin = true,
                #[cfg(any(debug_assertions, feature = "crash-privacy-qa"))]
                "--test-support-sort-canary-provider" => {
                    options.test_support_sort_canary_provider = true;
                }
                #[cfg(feature = "crash-privacy-qa")]
                "--test-support-sort-crash-after-submit" => {
                    options.test_support_sort_crash_after_submit = true;
                }
                #[cfg(debug_assertions)]
                "--test-control-protocol-version" => {
                    let version = args.next()?.parse::<u16>().ok()?;
                    if version == 0 {
                        return None;
                    }
                    options.test_control_protocol_version = Some(version);
                }
                _ => return None,
            }
        }
        if options.shutdown && options.support_bootstrap_stdin {
            return None;
        }
        #[cfg(any(debug_assertions, feature = "crash-privacy-qa"))]
        if options.test_support_sort_canary_provider && !options.support_bootstrap_stdin {
            return None;
        }
        #[cfg(feature = "crash-privacy-qa")]
        if options.test_support_sort_crash_after_submit
            && !options.test_support_sort_canary_provider
        {
            return None;
        }
        Some(options)
    }
}

#[cfg(all(windows, any(debug_assertions, feature = "crash-privacy-qa")))]
const TEST_SUPPORT_SORT_CANARY_TEXT: &str = "YUANYUAN_SUPPORT_SORT_PRIVATE_TEXT_CANARY_7F2C19A4";

#[cfg(all(windows, feature = "crash-privacy-qa"))]
const TEST_CRASH_PRIVACY_CANARY_PREFIX: &str = "YUANYUAN_CRASH_PRIVACY_CANARY_V1_";

#[cfg(all(windows, any(debug_assertions, feature = "crash-privacy-qa")))]
fn test_support_sort_registry(
    crash_after_submit: bool,
) -> Option<yuanyuan_ai::SupportSortProviderRegistry> {
    let descriptor = yuanyuan_ai::SupportSortProviderDescriptor::try_new(
        yuanyuan_ai::SupportSortProviderContext {
            destination: yuanyuan_ai::SupportSortDestination::LocalProvider,
            provider_key: "privacy-canary-provider",
            provider_fingerprint:
                "DDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDD",
            disclosure_version: yuanyuan_ai::SUPPORT_SORT_DISCLOSURE_VERSION,
        },
    )
    .ok()?;
    let entry = yuanyuan_ai::SupportSortProviderEntry::try_new(
        descriptor,
        "隔离隐私测试Provider".to_owned(),
        "仅用于自动测试，不保留输入".to_owned(),
        None,
        Box::new(move || -> Box<dyn yuanyuan_ai::ProviderAdapter> {
            Box::new(TestSupportSortCanaryProvider { crash_after_submit })
        }),
    )
    .ok()?;
    let mut registry = yuanyuan_ai::SupportSortProviderRegistry::default();
    registry.set(entry);
    Some(registry)
}

#[cfg(all(windows, any(debug_assertions, feature = "crash-privacy-qa")))]
struct TestSupportSortCanaryProvider {
    crash_after_submit: bool,
}

#[cfg(all(windows, any(debug_assertions, feature = "crash-privacy-qa")))]
impl yuanyuan_ai::ProviderAdapter for TestSupportSortCanaryProvider {
    fn capabilities(&self) -> yuanyuan_ai::ProviderCapabilities {
        yuanyuan_ai::ProviderCapabilities {
            structured_output: true,
            streaming_events: false,
            cancellation: true,
            usage_reporting: false,
        }
    }

    fn run(
        self: Box<Self>,
        request: yuanyuan_ai::ProviderRequest,
        cancellation: yuanyuan_ai::CancellationToken,
        events: yuanyuan_ai::ProviderEventSink,
    ) -> Result<(), yuanyuan_ai::ProviderAdapterError> {
        #[cfg(feature = "crash-privacy-qa")]
        if self.crash_after_submit {
            let valid_crash_input = request.operation
                == yuanyuan_ai::ProviderOperation::SupportSort
                && request
                    .input
                    .get("schema_version")
                    .and_then(|value| value.as_u64())
                    == Some(1)
                && request
                    .input
                    .get("content_class")
                    .and_then(|value| value.as_str())
                    == Some("user_entered_text")
                && request
                    .input
                    .get("user_entered_text")
                    .and_then(|value| value.as_str())
                    .is_some_and(|text| {
                        text.len() == TEST_CRASH_PRIVACY_CANARY_PREFIX.len() + 64
                            && text.starts_with(TEST_CRASH_PRIVACY_CANARY_PREFIX)
                            && text[TEST_CRASH_PRIVACY_CANARY_PREFIX.len()..]
                                .bytes()
                                .all(|byte| byte.is_ascii_digit() || matches!(byte, b'A'..=b'F'))
                    });
            if !valid_crash_input || cancellation.is_cancelled() {
                return Err(yuanyuan_ai::ProviderAdapterError::Rejected);
            }
            std::hint::black_box(&request);
            std::process::abort();
        }
        #[cfg(not(feature = "crash-privacy-qa"))]
        let _ = self.crash_after_submit;
        let valid_input = request.operation == yuanyuan_ai::ProviderOperation::SupportSort
            && request
                .input
                .get("schema_version")
                .and_then(|value| value.as_u64())
                == Some(1)
            && request
                .input
                .get("content_class")
                .and_then(|value| value.as_str())
                == Some("user_entered_text")
            && request
                .input
                .get("user_entered_text")
                .and_then(|value| value.as_str())
                == Some(TEST_SUPPORT_SORT_CANARY_TEXT);
        if !valid_input || cancellation.is_cancelled() {
            return Err(yuanyuan_ai::ProviderAdapterError::Rejected);
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
        events.emit(yuanyuan_ai::ProviderEvent::Final(
            yuanyuan_ai::ProviderFinal {
                response_intent_json:
                    br#"{"schema_version":1,"intent":"present_information","priority":"normal"}"#
                        .to_vec(),
                display_document_json: serde_json::to_vec(&document).ok(),
            },
        ))
    }
}

#[cfg(windows)]
fn acquire_instance_lock(root: &std::path::Path) -> Option<std::fs::File> {
    let path = root.join(".yuanyuan-ai.lock");
    let file = std::fs::OpenOptions::new()
        .create(true)
        .truncate(false)
        .read(true)
        .write(true)
        .open(&path)
        .ok()?;
    yuanyuan_bridge::apply_current_user_only_dacl(&path).ok()?;
    file.try_lock().ok()?;
    Some(file)
}

#[cfg(not(windows))]
fn main() {}

#[cfg(all(test, windows))]
mod tests {
    use super::*;
    use std::sync::{
        atomic::{AtomicUsize, Ordering},
        Arc,
    };

    #[test]
    fn defaults_are_versioned_and_paths_remain_optional() {
        let options = Options::parse(std::iter::empty()).unwrap();
        assert_eq!(options.pipe_name, "yuanyuan.task-events.v1");
        assert!(options.database.is_none());
        assert!(options.spool.is_none());
        assert!(!options.once);
        assert!(!options.shutdown);
        assert!(!options.support_bootstrap_stdin);
        assert!(!options.test_support_sort_canary_provider);
        #[cfg(feature = "crash-privacy-qa")]
        assert!(!options.test_support_sort_crash_after_submit);
        assert!(options.test_control_protocol_version.is_none());
    }

    #[test]
    fn rejects_unknown_or_incomplete_arguments() {
        assert!(Options::parse(["--unknown".into()].into_iter()).is_none());
        assert!(Options::parse(["--database".into()].into_iter()).is_none());
        assert!(
            Options::parse(["--test-control-protocol-version".into(), "0".into()].into_iter())
                .is_none()
        );
        assert!(Options::parse(
            ["--shutdown".into(), "--support-bootstrap-stdin".into()].into_iter()
        )
        .is_none());
        assert!(
            Options::parse(["--test-support-sort-canary-provider".into()].into_iter()).is_none()
        );
    }

    #[test]
    fn accepts_private_support_bootstrap_stdin_flag() {
        let options = Options::parse(["--support-bootstrap-stdin".into()].into_iter()).unwrap();
        assert!(options.support_bootstrap_stdin);
        assert!(!options.shutdown);
    }

    #[test]
    fn accepts_canary_provider_only_with_private_bootstrap() {
        let options = Options::parse(
            [
                "--support-bootstrap-stdin".into(),
                "--test-support-sort-canary-provider".into(),
            ]
            .into_iter(),
        )
        .unwrap();
        assert!(options.support_bootstrap_stdin);
        assert!(options.test_support_sort_canary_provider);
    }

    #[cfg(feature = "crash-privacy-qa")]
    #[test]
    fn accepts_crash_injection_only_with_private_canary_provider() {
        assert!(Options::parse(
            [
                "--support-bootstrap-stdin".into(),
                "--test-support-sort-crash-after-submit".into(),
            ]
            .into_iter()
        )
        .is_none());
        let options = Options::parse(
            [
                "--support-bootstrap-stdin".into(),
                "--test-support-sort-canary-provider".into(),
                "--test-support-sort-crash-after-submit".into(),
            ]
            .into_iter(),
        )
        .unwrap();
        assert!(options.test_support_sort_crash_after_submit);
    }

    #[test]
    fn instance_lock_allows_only_one_owner() {
        let directory = tempfile::tempdir().unwrap();
        yuanyuan_bridge::apply_current_user_only_dacl(directory.path()).unwrap();
        let first = acquire_instance_lock(directory.path()).unwrap();
        assert!(acquire_instance_lock(directory.path()).is_none());
        drop(first);
        assert!(acquire_instance_lock(directory.path()).is_some());
    }

    #[test]
    fn retention_schedule_stops_before_the_first_cycle() {
        let (stop, stop_receiver) = std::sync::mpsc::channel();
        let cycles = Arc::new(AtomicUsize::new(0));
        let cycles_for_thread = cycles.clone();
        let thread = std::thread::spawn(move || {
            run_retention_schedule(
                stop_receiver,
                Duration::from_secs(60),
                Duration::from_secs(60),
                || {
                    cycles_for_thread.fetch_add(1, Ordering::SeqCst);
                    Ok::<(), ()>(())
                },
            );
        });

        stop.send(()).unwrap();
        thread.join().unwrap();
        assert_eq!(cycles.load(Ordering::SeqCst), 0);
    }

    #[test]
    fn retention_schedule_repeats_after_a_failed_cycle_and_stops_cleanly() {
        let (stop, stop_receiver) = std::sync::mpsc::channel();
        let (cycle_observed, observed_cycles) = std::sync::mpsc::channel();
        let cycles = Arc::new(AtomicUsize::new(0));
        let cycles_for_thread = cycles.clone();
        let thread = std::thread::spawn(move || {
            run_retention_schedule(
                stop_receiver,
                Duration::from_millis(1),
                Duration::from_millis(1),
                || {
                    let cycle = cycles_for_thread.fetch_add(1, Ordering::SeqCst) + 1;
                    cycle_observed.send(cycle).unwrap();
                    if cycle == 1 {
                        Err("injected retention failure")
                    } else {
                        Ok(())
                    }
                },
            );
        });

        assert_eq!(observed_cycles.recv_timeout(Duration::from_secs(2)), Ok(1));
        assert_eq!(observed_cycles.recv_timeout(Duration::from_secs(2)), Ok(2));
        stop.send(()).unwrap();
        thread.join().unwrap();
        assert!(cycles.load(Ordering::SeqCst) >= 2);
    }

    #[test]
    fn retention_schedule_rejects_a_zero_repeat_interval() {
        let (_stop, stop_receiver) = std::sync::mpsc::channel();
        let cycles = AtomicUsize::new(0);
        run_retention_schedule(stop_receiver, Duration::ZERO, Duration::ZERO, || {
            cycles.fetch_add(1, Ordering::SeqCst);
            Ok::<(), ()>(())
        });
        assert_eq!(cycles.load(Ordering::SeqCst), 0);
    }
}
