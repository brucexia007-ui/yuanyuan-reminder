#[cfg(windows)]
fn main() {
    use std::{io::Read, time::SystemTime};

    use yuanyuan_bridge::{
        deliver_authenticated_or_spool_observed, inspect_authentication_claims,
        record_bridge_diagnostic, BridgeDiagnosticCode, BufferedDeliveryOutcome,
        NamedPipeEventSink, SpoolError, TrustEnforcingKeyResolver, WindowsCredentialKeyResolver,
        HARD_DELIVERY_TIMEOUT, MAX_BRIDGE_INPUT_BYTES,
    };
    use yuanyuan_connectors::MAX_CONNECTOR_PAYLOAD_BYTES;

    let Some(options) = parse_cli_options(std::env::args().skip(1)) else {
        return;
    };
    let Ok(client) = NamedPipeEventSink::new(options.pipe_name()) else {
        return;
    };

    let mut input = Vec::new();
    if std::io::stdin()
        .take((MAX_BRIDGE_INPUT_BYTES.max(MAX_CONNECTOR_PAYLOAD_BYTES) + 1) as u64)
        .read_to_end(&mut input)
        .is_err()
    {
        return;
    }

    let Ok(now_unix_ms) = SystemTime::now()
        .duration_since(SystemTime::UNIX_EPOCH)
        .ok()
        .and_then(|duration| i64::try_from(duration.as_millis()).ok())
        .ok_or(())
    else {
        return;
    };
    let spool_root = default_spool_root(std::env::var_os("LOCALAPPDATA"));
    let diagnostics_root = default_diagnostics_root(std::env::var_os("LOCALAPPDATA"));
    let Some(trust_database) = default_trust_database(std::env::var_os("LOCALAPPDATA")) else {
        return;
    };
    let authentication_health_database =
        default_authentication_health_database(std::env::var_os("LOCALAPPDATA"));
    let worker_diagnostics_root = diagnostics_root.clone();
    let result = run_with_timeout(HARD_DELIVERY_TIMEOUT, move || {
        let raw_claims = raw_authentication_claims(&options, now_unix_ms);
        if raw_claims.as_ref().is_some_and(|claims| {
            authentication_health_database.as_ref().is_some_and(|path| {
                authentication_is_paused(path, &claims.connector_id, &claims.source_instance)
            })
        }) {
            if let Some(root) = worker_diagnostics_root.as_deref() {
                let _ = record_bridge_diagnostic(root, BridgeDiagnosticCode::AuthenticationPaused);
            }
            return Some(BufferedDeliveryOutcome::Dropped(
                BridgeDiagnosticCode::AuthenticationPaused,
            ));
        }
        let authenticated_input =
            match prepare_authenticated_input(&options, input, now_unix_ms, &trust_database) {
                Ok(input) => input,
                Err(code) => {
                    if matches!(
                        code,
                        BridgeDiagnosticCode::AuthenticationFailed
                            | BridgeDiagnosticCode::AuthenticationUnavailable
                    ) {
                        let error = match code {
                            BridgeDiagnosticCode::AuthenticationUnavailable => {
                                yuanyuan_bridge::AuthenticationError::KeyStoreUnavailable
                            }
                            _ => yuanyuan_bridge::AuthenticationError::UnknownOrRevokedKey,
                        };
                        observe_authentication_health(
                            authentication_health_database.as_deref(),
                            &trust_database,
                            raw_claims.as_ref(),
                            yuanyuan_bridge::AuthenticationObservation::Rejected(&error),
                            now_unix_ms,
                        );
                    }
                    if let Some(root) = worker_diagnostics_root.as_deref() {
                        let _ = record_bridge_diagnostic(root, code);
                    }
                    return Some(BufferedDeliveryOutcome::Dropped(code));
                }
            };
        let claims = inspect_authentication_claims(&authenticated_input, now_unix_ms).ok();
        if claims.as_ref().is_some_and(|claims| {
            authentication_health_database.as_ref().is_some_and(|path| {
                authentication_is_paused(path, &claims.connector_id, &claims.source_instance)
            })
        }) {
            if let Some(root) = worker_diagnostics_root.as_deref() {
                let _ = record_bridge_diagnostic(root, BridgeDiagnosticCode::AuthenticationPaused);
            }
            return Some(BufferedDeliveryOutcome::Dropped(
                BridgeDiagnosticCode::AuthenticationPaused,
            ));
        }
        let trust_database_for_observer = trust_database.clone();
        let health_database_for_observer = authentication_health_database.clone();
        let keys = TrustEnforcingKeyResolver::new(WindowsCredentialKeyResolver, &trust_database);
        let outcome = deliver_authenticated_or_spool_observed(
            &authenticated_input,
            &keys,
            now_unix_ms,
            |payload| client.send_validated_payload(payload),
            || {
                let root = spool_root.as_deref().ok_or(SpoolError::Unavailable)?;
                open_secure_spool(root)
            },
            |observation| {
                observe_authentication_health(
                    health_database_for_observer.as_deref(),
                    &trust_database_for_observer,
                    claims.as_ref(),
                    observation,
                    now_unix_ms,
                );
            },
        );
        if let (BufferedDeliveryOutcome::Dropped(code), Some(root)) =
            (outcome, worker_diagnostics_root.as_deref())
        {
            let _ = record_bridge_diagnostic(root, code);
        }
        Some(outcome)
    });
    if result.is_none() {
        if let Some(root) = diagnostics_root {
            let _ = run_with_timeout(std::time::Duration::from_millis(100), move || {
                record_bridge_diagnostic(&root, BridgeDiagnosticCode::Timeout)
            });
        }
    }
}

#[cfg(windows)]
fn authentication_is_paused(
    database: &std::path::Path,
    connector_id: &str,
    source_instance: &str,
) -> bool {
    if !database.is_file() {
        return false;
    }
    yuanyuan_bridge::ConnectorAuthenticationHealthStore::open_existing_read_only(database)
        .and_then(|store| store.status(connector_id, source_instance))
        .ok()
        .flatten()
        .is_some_and(|status| status.paused)
}

#[cfg(windows)]
fn observe_authentication_health(
    database: Option<&std::path::Path>,
    trust_database: &std::path::Path,
    claims: Option<&yuanyuan_bridge::AuthenticationClaims>,
    observation: yuanyuan_bridge::AuthenticationObservation<'_>,
    now_unix_ms: i64,
) {
    use yuanyuan_bridge::{AuthenticationError, ConnectorTrustStore, TrustDecision};

    let Some(database) = database else {
        return;
    };
    let identity = match observation {
        yuanyuan_bridge::AuthenticationObservation::Verified(verified) => Some((
            verified.envelope.event.connector_id.as_str(),
            verified.envelope.event.source_instance.as_str(),
            false,
        )),
        yuanyuan_bridge::AuthenticationObservation::Rejected(
            AuthenticationError::InvalidMac
            | AuthenticationError::UnknownOrRevokedKey
            | AuthenticationError::KeyStoreUnavailable,
        ) => claims.map(|claims| {
            (
                claims.connector_id.as_str(),
                claims.source_instance.as_str(),
                true,
            )
        }),
        yuanyuan_bridge::AuthenticationObservation::Rejected(_) => None,
    };
    let Some((connector_id, source_instance, failed)) = identity else {
        return;
    };
    if failed {
        let Some(claims) = claims else {
            return;
        };
        let trusted = ConnectorTrustStore::open_existing_read_only(trust_database)
            .and_then(|store| {
                store.authorize_for_identity(
                    connector_id,
                    source_instance,
                    &claims.key_id,
                    claims.signed_at_unix_ms,
                    now_unix_ms,
                )
            })
            .ok()
            .is_some_and(|decision| decision != TrustDecision::Rejected);
        if !trusted {
            return;
        }
    }
    let Some(parent) = database.parent() else {
        return;
    };
    if std::fs::create_dir_all(parent).is_err()
        || yuanyuan_bridge::apply_current_user_only_dacl(parent).is_err()
    {
        return;
    }
    let Ok(mut store) = yuanyuan_bridge::ConnectorAuthenticationHealthStore::open(database) else {
        return;
    };
    if failed {
        let _ = store.record_failure(connector_id, source_instance, now_unix_ms);
    } else {
        let _ = store.record_success(connector_id, source_instance);
    }
}

#[cfg(windows)]
fn prepare_authenticated_input(
    options: &CliOptions,
    input: Vec<u8>,
    now_unix_ms: i64,
    trust_database: &std::path::Path,
) -> Result<Vec<u8>, yuanyuan_bridge::BridgeDiagnosticCode> {
    use std::time::SystemTime;

    use yuanyuan_bridge::{
        seal_event, AuthenticationKeyResolver, BridgeDiagnosticCode, ConnectorTrustStore,
        KeyResolutionError, TrustDecision, WindowsCredentialKeyResolver, AUTH_NONCE_BYTES,
    };
    use yuanyuan_connectors::{parse_connector_payload, ConnectorContext, ConnectorDisposition};

    match options {
        CliOptions::Authenticated { .. } => Ok(input),
        CliOptions::RawConnector {
            kind,
            connector_id,
            source_instance,
            key_id,
            workspace_alias,
            ..
        } => {
            let ingress_sequence = SystemTime::now()
                .duration_since(SystemTime::UNIX_EPOCH)
                .ok()
                .and_then(|duration| u64::try_from(duration.as_nanos()).ok())
                .unwrap_or(now_unix_ms as u64);
            let context = ConnectorContext {
                connector_id: connector_id.clone(),
                source_instance: source_instance.clone(),
                received_at: unix_millis_timestamp(now_unix_ms),
                ingress_sequence,
                workspace_alias: workspace_alias.clone(),
            };
            let Ok(ConnectorDisposition::Event(parsed)) =
                parse_connector_payload(*kind, &input, &context)
            else {
                return Err(BridgeDiagnosticCode::InvalidProtocol);
            };
            let parsed = *parsed;
            let trust = ConnectorTrustStore::open_existing_read_only(trust_database)
                .map_err(|_| BridgeDiagnosticCode::AuthenticationUnavailable)?;
            if trust
                .authorize_for_identity(
                    &parsed.envelope.event.connector_id,
                    &parsed.envelope.event.source_instance,
                    key_id,
                    now_unix_ms,
                    now_unix_ms,
                )
                .ok()
                != Some(TrustDecision::Active)
            {
                return Err(BridgeDiagnosticCode::AuthenticationFailed);
            }
            let resolver = WindowsCredentialKeyResolver;
            let key = resolver.resolve(key_id).map_err(|error| match error {
                KeyResolutionError::UnknownOrRevoked => BridgeDiagnosticCode::AuthenticationFailed,
                KeyResolutionError::Unavailable => BridgeDiagnosticCode::AuthenticationUnavailable,
            })?;
            let mut nonce = [0_u8; AUTH_NONCE_BYTES];
            if getrandom::fill(&mut nonce).is_err() {
                return Err(BridgeDiagnosticCode::AuthenticationUnavailable);
            }
            let sealed = seal_event(parsed.envelope, key_id, nonce, now_unix_ms, &key)
                .map_err(|_| BridgeDiagnosticCode::AuthenticationFailed)?;
            serde_json::to_vec(&sealed).map_err(|_| BridgeDiagnosticCode::AuthenticationUnavailable)
        }
    }
}

#[cfg(windows)]
fn raw_authentication_claims(
    options: &CliOptions,
    now_unix_ms: i64,
) -> Option<yuanyuan_bridge::AuthenticationClaims> {
    let CliOptions::RawConnector {
        connector_id,
        source_instance,
        key_id,
        ..
    } = options
    else {
        return None;
    };
    Some(yuanyuan_bridge::AuthenticationClaims {
        connector_id: connector_id.clone(),
        source_instance: source_instance.clone(),
        key_id: key_id.clone(),
        signed_at_unix_ms: now_unix_ms,
    })
}

#[cfg(windows)]
fn unix_millis_timestamp(unix_ms: i64) -> String {
    chrono::DateTime::from_timestamp_millis(unix_ms)
        .map(|timestamp| timestamp.to_rfc3339_opts(chrono::SecondsFormat::Millis, true))
        .unwrap_or_else(|| "1970-01-01T00:00:00.000Z".to_owned())
}

#[cfg(windows)]
fn run_with_timeout<T, F>(timeout: std::time::Duration, operation: F) -> Option<T>
where
    T: Send + 'static,
    F: FnOnce() -> T + Send + 'static,
{
    let (sender, receiver) = std::sync::mpsc::sync_channel(1);
    std::thread::spawn(move || {
        let _ = sender.send(operation());
    });
    receiver.recv_timeout(timeout).ok()
}

#[cfg(windows)]
fn open_secure_spool(
    root: &std::path::Path,
) -> Result<yuanyuan_bridge::Spool, yuanyuan_bridge::SpoolError> {
    std::fs::create_dir_all(root).map_err(|_| yuanyuan_bridge::SpoolError::Unavailable)?;
    yuanyuan_bridge::apply_current_user_only_dacl(root)
        .map_err(|_| yuanyuan_bridge::SpoolError::UnsafePath)?;
    let spool = yuanyuan_bridge::Spool::open(root, yuanyuan_bridge::SpoolLimits::default())?;
    for path in [
        spool.root().join("pending"),
        spool.root().join("quarantine"),
        spool.root().join(".spool.lock"),
    ] {
        yuanyuan_bridge::apply_current_user_only_dacl(&path)
            .map_err(|_| yuanyuan_bridge::SpoolError::UnsafePath)?;
    }
    Ok(spool)
}

#[cfg(windows)]
fn default_spool_root(local_app_data: Option<std::ffi::OsString>) -> Option<std::path::PathBuf> {
    local_app_data.map(|root| {
        std::path::PathBuf::from(root)
            .join("Yuanyuan")
            .join("bridge-spool")
    })
}

#[cfg(windows)]
fn default_trust_database(
    local_app_data: Option<std::ffi::OsString>,
) -> Option<std::path::PathBuf> {
    local_app_data.map(|root| {
        std::path::PathBuf::from(root)
            .join("Yuanyuan")
            .join("connector-trust.sqlite3")
    })
}

#[cfg(windows)]
fn default_authentication_health_database(
    local_app_data: Option<std::ffi::OsString>,
) -> Option<std::path::PathBuf> {
    local_app_data.map(|root| {
        std::path::PathBuf::from(root)
            .join("Yuanyuan")
            .join("connector-authentication-health.sqlite3")
    })
}

#[cfg(windows)]
fn default_diagnostics_root(
    local_app_data: Option<std::ffi::OsString>,
) -> Option<std::path::PathBuf> {
    local_app_data.map(|root| {
        std::path::PathBuf::from(root)
            .join("Yuanyuan")
            .join("diagnostics")
    })
}

#[cfg(windows)]
#[derive(Debug, Clone, PartialEq, Eq)]
enum CliOptions {
    Authenticated {
        pipe_name: String,
    },
    RawConnector {
        kind: yuanyuan_connectors::ConnectorKind,
        connector_id: String,
        source_instance: String,
        key_id: String,
        workspace_alias: Option<String>,
        pipe_name: String,
    },
}

impl CliOptions {
    fn pipe_name(&self) -> &str {
        match self {
            Self::Authenticated { pipe_name } | Self::RawConnector { pipe_name, .. } => pipe_name,
        }
    }
}

#[cfg(windows)]
fn parse_cli_options(mut args: impl Iterator<Item = String>) -> Option<CliOptions> {
    const DEFAULT_PIPE_NAME: &str = "yuanyuan.task-events.v1";

    let mut pipe_name = DEFAULT_PIPE_NAME.to_owned();
    let mut source = None;
    let mut owner_id = None;
    let mut connector_id = None;
    let mut source_instance = None;
    let mut key_id = None;
    let mut workspace_alias = None;
    while let Some(argument) = args.next() {
        match argument.as_str() {
            "--pipe-name" => pipe_name = args.next()?,
            "--source" => set_once(&mut source, args.next()?)?,
            "--owner-id" => set_once(&mut owner_id, args.next()?)?,
            "--connector-id" => set_once(&mut connector_id, args.next()?)?,
            "--source-instance" => set_once(&mut source_instance, args.next()?)?,
            "--key-id" => set_once(&mut key_id, args.next()?)?,
            "--workspace-alias" => set_once(&mut workspace_alias, args.next()?)?,
            _ => return None,
        }
    }
    match source.as_deref() {
        None if owner_id.is_none()
            && connector_id.is_none()
            && source_instance.is_none()
            && key_id.is_none()
            && workspace_alias.is_none() =>
        {
            Some(CliOptions::Authenticated { pipe_name })
        }
        Some(source) => {
            if owner_id
                .as_deref()
                .is_some_and(|value| value != "yuanyuan-reminder")
            {
                return None;
            }
            let kind = match source {
                "codex-notify" => yuanyuan_connectors::ConnectorKind::CodexNotify,
                "codex-hooks" => yuanyuan_connectors::ConnectorKind::CodexHooks,
                "claude-code-hooks" => yuanyuan_connectors::ConnectorKind::ClaudeCodeHooks,
                _ => return None,
            };
            Some(CliOptions::RawConnector {
                kind,
                connector_id: connector_id?,
                source_instance: source_instance?,
                key_id: key_id?,
                workspace_alias,
                pipe_name,
            })
        }
        None => None,
    }
}

#[cfg(windows)]
fn set_once(slot: &mut Option<String>, value: String) -> Option<()> {
    if slot.is_some() || value.trim().is_empty() {
        return None;
    }
    *slot = Some(value);
    Some(())
}

#[cfg(not(windows))]
fn main() {}

#[cfg(all(test, windows))]
mod tests {
    use std::time::{Duration, Instant};

    use super::*;

    #[test]
    fn uses_the_versioned_local_pipe_by_default() {
        assert_eq!(
            parse_cli_options(std::iter::empty()),
            Some(CliOptions::Authenticated {
                pipe_name: "yuanyuan.task-events.v1".to_owned()
            })
        );
    }

    #[test]
    fn rejects_unknown_or_incomplete_arguments() {
        assert_eq!(
            parse_cli_options(["--unknown".to_owned()].into_iter()),
            None
        );
        assert_eq!(
            parse_cli_options(["--pipe-name".to_owned()].into_iter()),
            None
        );
        assert_eq!(
            parse_cli_options(["--connector-id".to_owned(), "only".to_owned()].into_iter()),
            None
        );
    }

    #[test]
    fn parses_a_complete_raw_connector_mode_without_accepting_duplicates() {
        assert_eq!(
            parse_cli_options(
                [
                    "--owner-id",
                    "yuanyuan-reminder",
                    "--source",
                    "codex-notify",
                    "--connector-id",
                    "connector-1",
                    "--source-instance",
                    "instance-1",
                    "--key-id",
                    "codex.installation-1",
                    "--workspace-alias",
                    "yuanyuan",
                ]
                .map(str::to_owned)
                .into_iter()
            ),
            Some(CliOptions::RawConnector {
                kind: yuanyuan_connectors::ConnectorKind::CodexNotify,
                connector_id: "connector-1".to_owned(),
                source_instance: "instance-1".to_owned(),
                key_id: "codex.installation-1".to_owned(),
                workspace_alias: Some("yuanyuan".to_owned()),
                pipe_name: "yuanyuan.task-events.v1".to_owned(),
            })
        );
        assert_eq!(
            parse_cli_options(
                [
                    "--source",
                    "codex-hooks",
                    "--source",
                    "claude-code-hooks",
                    "--connector-id",
                    "connector-1",
                    "--source-instance",
                    "instance-1",
                    "--key-id",
                    "key-1",
                ]
                .map(str::to_owned)
                .into_iter()
            ),
            None
        );
        assert_eq!(
            parse_cli_options(
                [
                    "--owner-id",
                    "another-product",
                    "--source",
                    "codex-hooks",
                    "--connector-id",
                    "connector-1",
                    "--source-instance",
                    "instance-1",
                    "--key-id",
                    "key-1",
                ]
                .map(str::to_owned)
                .into_iter()
            ),
            None
        );
    }

    #[test]
    fn spool_root_is_scoped_to_the_current_users_local_app_data() {
        assert_eq!(
            default_spool_root(Some("C:\\Users\\test\\AppData\\Local".into())).unwrap(),
            std::path::PathBuf::from("C:\\Users\\test\\AppData\\Local")
                .join("Yuanyuan")
                .join("bridge-spool")
        );
        assert_eq!(default_spool_root(None), None);
        assert_eq!(
            default_trust_database(Some("C:\\Users\\test\\AppData\\Local".into())).unwrap(),
            std::path::PathBuf::from("C:\\Users\\test\\AppData\\Local")
                .join("Yuanyuan")
                .join("connector-trust.sqlite3")
        );
        assert_eq!(default_trust_database(None), None);
        assert_eq!(
            default_authentication_health_database(Some("C:\\Users\\test\\AppData\\Local".into()))
                .unwrap(),
            std::path::PathBuf::from("C:\\Users\\test\\AppData\\Local")
                .join("Yuanyuan")
                .join("connector-authentication-health.sqlite3")
        );
        assert_eq!(default_authentication_health_database(None), None);
        assert_eq!(
            default_diagnostics_root(Some("C:\\Users\\test\\AppData\\Local".into())).unwrap(),
            std::path::PathBuf::from("C:\\Users\\test\\AppData\\Local")
                .join("Yuanyuan")
                .join("diagnostics")
        );
        assert_eq!(default_diagnostics_root(None), None);
    }

    #[test]
    fn secure_spool_directory_remains_usable_by_the_current_user() {
        let directory = tempfile::tempdir().unwrap();
        let root = directory.path().join("secure-spool");
        let spool = open_secure_spool(&root).unwrap();
        assert_eq!(
            spool.enqueue(b"authenticated-placeholder", 1),
            Ok(yuanyuan_bridge::SpoolEnqueueOutcome::Stored)
        );
    }

    #[test]
    fn cli_watchdog_returns_before_a_blocked_worker_finishes() {
        let started = Instant::now();
        let result = run_with_timeout(Duration::from_millis(25), || {
            std::thread::sleep(Duration::from_millis(250));
            1
        });
        assert_eq!(result, None);
        assert!(started.elapsed() < Duration::from_millis(150));
    }

    #[test]
    fn trusted_identity_authentication_failures_pause_without_failing_the_source_hook() {
        let directory = tempfile::tempdir().unwrap();
        let trust_database = directory.path().join("connector-trust.sqlite3");
        let health_database = directory
            .path()
            .join("connector-authentication-health.sqlite3");
        let connector_id = "builtin.codex";
        let source_instance = "00000000-0000-4000-8000-000000000001";
        let key_id = "codex.test.g1";
        let now = 1_775_212_800_000;
        let mut trust = yuanyuan_bridge::ConnectorTrustStore::open(&trust_database).unwrap();
        trust
            .register(connector_id, source_instance, key_id, now)
            .unwrap();
        let claims = yuanyuan_bridge::AuthenticationClaims {
            connector_id: connector_id.to_owned(),
            source_instance: source_instance.to_owned(),
            key_id: key_id.to_owned(),
            signed_at_unix_ms: now,
        };
        let error = yuanyuan_bridge::AuthenticationError::InvalidMac;

        for offset in 0..3 {
            observe_authentication_health(
                Some(&health_database),
                &trust_database,
                Some(&claims),
                yuanyuan_bridge::AuthenticationObservation::Rejected(&error),
                now + offset,
            );
        }

        assert!(authentication_is_paused(
            &health_database,
            connector_id,
            source_instance
        ));
        assert_eq!(
            yuanyuan_bridge::BufferedDeliveryOutcome::Dropped(
                yuanyuan_bridge::BridgeDiagnosticCode::AuthenticationPaused
            )
            .hook_exit_code(),
            0
        );
    }
}
