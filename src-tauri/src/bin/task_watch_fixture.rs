#[cfg(windows)]
fn main() {
    use std::path::PathBuf;

    use yuanyuan_ai::TaskStore;
    use yuanyuan_bridge::{
        seal_event, AuthenticationKey, AuthenticationKeyResolver, KeyResolutionError,
        AUTH_NONCE_BYTES,
    };
    use yuanyuan_protocol::{
        EventFinality, EvidenceLevel, EvidenceType, TaskEventEnvelope, TaskEventV1, TaskState,
        TASK_EVENT_PROTOCOL_VERSION,
    };

    const KEY_ID: &str = "runtime-qa-key";

    struct QaKey;
    impl AuthenticationKeyResolver for QaKey {
        fn resolve(&self, key_id: &str) -> Result<AuthenticationKey, KeyResolutionError> {
            if key_id == KEY_ID {
                AuthenticationKey::new(vec![0x51; 32]).map_err(|_| KeyResolutionError::Unavailable)
            } else {
                Err(KeyResolutionError::UnknownOrRevoked)
            }
        }
    }

    let mut arguments = std::env::args().skip(1);
    let mut root = None;
    let mut prepare_only = false;
    let mut scenario = String::from("all");
    let mut scenario_supplied = false;
    let mut animation_mode = None;
    while let Some(argument) = arguments.next() {
        match argument.as_str() {
            "--root" if root.is_none() => {
                root = arguments.next().map(PathBuf::from);
                if root.is_none() {
                    std::process::exit(2);
                }
            }
            "--prepare-only" if !prepare_only => prepare_only = true,
            "--scenario" if !scenario_supplied => {
                scenario = arguments.next().unwrap_or_else(|| std::process::exit(2));
                if !matches!(
                    scenario.as_str(),
                    "all" | "failed-only" | "waiting-user-only" | "stalled-only"
                ) {
                    std::process::exit(2);
                }
                scenario_supplied = true;
            }
            "--animation-mode" if animation_mode.is_none() => {
                let value = arguments.next().unwrap_or_else(|| std::process::exit(2));
                if !matches!(value.as_str(), "always" | "off") {
                    std::process::exit(2);
                }
                animation_mode = Some(value);
            }
            _ => std::process::exit(2),
        }
    }
    let Some(root) = root else {
        std::process::exit(2);
    };

    let root = yuanyuan_reminder_lib::runtime_qa::create_root(&root)
        .unwrap_or_else(|_| std::process::exit(3));
    if prepare_only {
        return;
    }
    std::env::set_var("YUANYUAN_RUNTIME_QA_ROOT", &root);
    if let Some(animation_mode) = animation_mode {
        yuanyuan_reminder_lib::runtime_qa::seed_animation_mode(&animation_mode)
            .unwrap_or_else(|_| std::process::exit(3));
    }
    let database = yuanyuan_reminder_lib::runtime_qa::task_database()
        .unwrap_or_else(|_| std::process::exit(3));
    let mut store = TaskStore::open(database).unwrap_or_else(|_| std::process::exit(4));
    let now = chrono::Utc::now();
    let now_unix_ms = now.timestamp_millis();
    let timestamp = now.to_rfc3339();
    let states = match scenario.as_str() {
        "failed-only" => vec![("anthropic.claude-code", TaskState::Failed)],
        "waiting-user-only" => vec![("anthropic.claude-code", TaskState::WaitingUser)],
        "stalled-only" => vec![("anthropic.claude-code", TaskState::Stalled)],
        _ => vec![
            ("openai.codex", TaskState::Running),
            ("openai.codex", TaskState::Running),
            ("openai.codex", TaskState::Running),
            ("openai.codex", TaskState::WaitingUser),
            ("openai.codex", TaskState::Succeeded),
            ("anthropic.claude-code", TaskState::WaitingUser),
            ("anthropic.claude-code", TaskState::Stalled),
            ("anthropic.claude-code", TaskState::Failed),
        ],
    };
    let expected_count = states.len() as u64;

    for (index, (source, state)) in states.into_iter().enumerate() {
        let terminal = state.is_terminal();
        let identity = index + 1;
        let envelope = TaskEventEnvelope {
            protocol_version: TASK_EVENT_PROTOCOL_VERSION,
            event: TaskEventV1 {
                event_id: format!("runtime-qa-event-{identity}"),
                connector_id: if source == "openai.codex" {
                    "codex-runtime-qa".into()
                } else {
                    "claude-runtime-qa".into()
                },
                source_instance: if source == "openai.codex" {
                    "codex-install-runtime-qa".into()
                } else {
                    "claude-install-runtime-qa".into()
                },
                task_id: format!("runtime-qa-task-{identity}"),
                run_id: format!("runtime-qa-run-{identity}"),
                parent_task_id: None,
                source: source.into(),
                external_id: format!("runtime-qa-external-{identity}"),
                title: format!("Synthetic runtime QA task {identity}"),
                workspace: None,
                state,
                progress: None,
                summary: None,
                attention_reason: (state == TaskState::WaitingUser)
                    .then(|| "confirmation_required".into()),
                evidence_type: EvidenceType::Hook,
                evidence_level: EvidenceLevel::Authoritative,
                sequence: 1,
                occurred_at: timestamp.clone(),
                received_at: timestamp.clone(),
                started_at: None,
                updated_at: timestamp.clone(),
                completed_at: terminal.then(|| timestamp.clone()),
                finality: if terminal {
                    EventFinality::Terminal
                } else {
                    EventFinality::Provisional
                },
                return_action: None,
                payload_digest: format!("sha256:runtime-qa-{identity}"),
                raw_payload_ref: None,
            },
        };
        let nonce = [identity as u8; AUTH_NONCE_BYTES];
        let signed = seal_event(
            envelope,
            KEY_ID,
            nonce,
            now_unix_ms,
            &QaKey.resolve(KEY_ID).unwrap(),
        )
        .unwrap_or_else(|_| std::process::exit(5));
        let payload = serde_json::to_vec(&signed).unwrap_or_else(|_| std::process::exit(5));
        store
            .accept_authenticated(&payload, &QaKey, now_unix_ms)
            .unwrap_or_else(|_| std::process::exit(5));
    }

    if store.task_count().ok() != Some(expected_count)
        || store.event_count().ok() != Some(expected_count)
    {
        std::process::exit(6);
    }
}

#[cfg(not(windows))]
fn main() {
    std::process::exit(2);
}
