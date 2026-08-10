#![cfg(windows)]

use std::{
    ffi::OsStr,
    io::Write,
    os::windows::ffi::OsStrExt,
    process::{Command, Output, Stdio},
    thread,
    time::SystemTime,
};

use windows_sys::Win32::Security::Credentials::{
    CredDeleteW, CredWriteW, CREDENTIALW, CRED_PERSIST_SESSION, CRED_TYPE_GENERIC,
};
use yuanyuan_bridge::{
    seal_event, verify_authenticated_signature, AuthenticationError, AuthenticationKey,
    AuthenticationKeyResolver, ConnectorTrustStore, CredentialPersistence, CredentialTrustManager,
    TrustEnforcingKeyResolver, WindowsCredentialKeyResolver, WindowsCredentialSecretStore,
    WindowsNamedPipeServer, AUTH_NONCE_BYTES, CREDENTIAL_TARGET_PREFIX, KEY_ROTATION_GRACE,
};
use yuanyuan_protocol::TaskEventEnvelope;

struct TestCredential {
    target: Vec<u16>,
    created: bool,
}

impl TestCredential {
    fn new(key_id: &str) -> Self {
        let mut target: Vec<u16> = OsStr::new(&format!("{CREDENTIAL_TARGET_PREFIX}{key_id}"))
            .encode_wide()
            .collect();
        target.push(0);
        Self {
            target,
            created: false,
        }
    }

    fn write(&mut self, secret: &[u8]) {
        let mut blob = secret.to_vec();
        let credential = CREDENTIALW {
            Type: CRED_TYPE_GENERIC,
            TargetName: self.target.as_mut_ptr(),
            CredentialBlobSize: blob.len() as u32,
            CredentialBlob: blob.as_mut_ptr(),
            Persist: CRED_PERSIST_SESSION,
            ..CREDENTIALW::default()
        };
        // SAFETY: every pointer references storage that remains alive for the
        // duration of CredWriteW, and the target is NUL-terminated.
        assert_ne!(unsafe { CredWriteW(&credential, 0) }, 0);
        self.created = true;
    }

    fn delete(&mut self) {
        if self.created {
            // SAFETY: the target remains NUL-terminated and owned by this guard.
            let _ = unsafe { CredDeleteW(self.target.as_ptr(), CRED_TYPE_GENERIC, 0) };
            self.created = false;
        }
    }
}

impl Drop for TestCredential {
    fn drop(&mut self) {
        self.delete();
    }
}

#[derive(Default)]
struct GeneratedCredentialCleanup(Vec<String>);

impl Drop for GeneratedCredentialCleanup {
    fn drop(&mut self) {
        let secrets = WindowsCredentialSecretStore::with_persistence(
            CredentialPersistence::CurrentLogonSession,
        );
        for key_id in &self.0 {
            let _ = secrets.delete(key_id);
        }
    }
}

fn unique_key_id(label: &str) -> String {
    let suffix = SystemTime::now()
        .duration_since(SystemTime::UNIX_EPOCH)
        .unwrap()
        .as_nanos();
    format!("test.{label}.{}.{suffix}", std::process::id())
}

fn now_unix_ms() -> i64 {
    SystemTime::now()
        .duration_since(SystemTime::UNIX_EPOCH)
        .ok()
        .and_then(|duration| i64::try_from(duration.as_millis()).ok())
        .unwrap()
}

fn event(event_id: &str) -> TaskEventEnvelope {
    serde_json::from_value(serde_json::json!({
        "protocol_version": 1,
        "event": {
            "event_id": event_id,
            "connector_id": "connector-credential-test",
            "source_instance": "codex-install-credential-test",
            "task_id": "task-credential-test",
            "run_id": "run-credential-test",
            "source": "openai.codex",
            "external_id": "thread-credential-test",
            "title": "Verify Windows Credential Manager",
            "workspace": "yuanyuan-reminder",
            "state": "running",
            "progress": 0.25,
            "evidence_type": "hook",
            "evidence_level": "authoritative",
            "sequence": 1,
            "occurred_at": "2026-08-04T00:00:00Z",
            "received_at": "2026-08-04T00:00:00Z",
            "updated_at": "2026-08-04T00:00:00Z",
            "finality": "provisional",
            "payload_digest": "sha256:0123456789abcdef"
        }
    }))
    .unwrap()
}

fn signed_input(event_id: &str, key_id: &str, secret: &[u8], nonce_byte: u8) -> Vec<u8> {
    let key = AuthenticationKey::new(secret.to_vec()).unwrap();
    serde_json::to_vec(
        &seal_event(
            event(event_id),
            key_id,
            [nonce_byte; AUTH_NONCE_BYTES],
            now_unix_ms(),
            &key,
        )
        .unwrap(),
    )
    .unwrap()
}

fn run_bridge(pipe_name: &str, input: &[u8], local_app_data: &std::path::Path) -> Output {
    run_bridge_with_args(
        &["--pipe-name".to_owned(), pipe_name.to_owned()],
        input,
        local_app_data,
    )
}

fn run_bridge_with_args(args: &[String], input: &[u8], local_app_data: &std::path::Path) -> Output {
    let mut child = Command::new(env!("CARGO_BIN_EXE_yuanyuan-bridge"))
        .args(args)
        .env("LOCALAPPDATA", local_app_data)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .unwrap();
    child.stdin.take().unwrap().write_all(input).unwrap();
    child.wait_with_output().unwrap()
}

fn register_trust(
    local_app_data: &std::path::Path,
    connector_id: &str,
    source_instance: &str,
    key_id: &str,
) {
    let root = local_app_data.join("Yuanyuan");
    std::fs::create_dir_all(&root).unwrap();
    let mut trust = ConnectorTrustStore::open(root.join("connector-trust.sqlite3")).unwrap();
    trust
        .register(
            connector_id,
            source_instance,
            key_id,
            now_unix_ms().saturating_sub(1_000),
        )
        .unwrap();
}

#[test]
fn real_cli_converts_redacts_signs_and_delivers_a_raw_codex_notification() {
    let key_id = unique_key_id("raw-codex");
    let secret = [0x6a; 32];
    let mut credential = TestCredential::new(&key_id);
    credential.write(&secret);

    let pipe_name = format!("yuanyuan.{}", unique_key_id("raw-codex-pipe"));
    let pipe_for_server = pipe_name.clone();
    let (ready_sender, ready_receiver) = std::sync::mpsc::sync_channel(1);
    let server_thread = thread::spawn(move || {
        let server = WindowsNamedPipeServer::bind(&pipe_for_server).unwrap();
        ready_sender.send(()).unwrap();
        let received = server.accept_one().unwrap();
        let payload = received.payload().to_vec();
        received.acknowledge().unwrap();
        payload
    });
    ready_receiver.recv().unwrap();

    let raw = br#"{
        "type":"agent-turn-complete",
        "thread-id":"thread-sensitive-fixture",
        "cwd":"C:\\Users\\private\\secret-project",
        "input_messages":["secret prompt must not leave the adapter"],
        "last_assistant_message":"private model response",
        "timestamp":"2026-08-04T10:00:00Z",
        "sequence":42
    }"#;
    let local_app_data = tempfile::tempdir().unwrap();
    register_trust(
        local_app_data.path(),
        "connector-raw-test",
        "instance-raw-test",
        &key_id,
    );
    let output = run_bridge_with_args(
        &[
            "--source".to_owned(),
            "codex-notify".to_owned(),
            "--connector-id".to_owned(),
            "connector-raw-test".to_owned(),
            "--source-instance".to_owned(),
            "instance-raw-test".to_owned(),
            "--key-id".to_owned(),
            key_id.clone(),
            "--workspace-alias".to_owned(),
            "yuanyuan".to_owned(),
            "--pipe-name".to_owned(),
            pipe_name,
        ],
        raw,
        local_app_data.path(),
    );

    assert!(output.status.success());
    assert!(output.stdout.is_empty());
    assert!(output.stderr.is_empty());
    let signed_payload = server_thread.join().unwrap();
    let envelope = verify_authenticated_signature(
        &signed_payload,
        &WindowsCredentialKeyResolver,
        now_unix_ms(),
    )
    .unwrap();
    assert_eq!(envelope.event.source, "openai.codex");
    assert_eq!(envelope.event.title, "Codex 任务");
    assert_eq!(envelope.event.sequence, 42);
    assert_eq!(
        envelope.event.state,
        yuanyuan_protocol::TaskState::Succeeded
    );
    let signed_text = String::from_utf8(signed_payload).unwrap();
    assert!(!signed_text.contains("secret prompt"));
    assert!(!signed_text.contains("secret-project"));
    assert!(!signed_text.contains("private model response"));
    assert!(!signed_text.contains("thread-sensitive-fixture"));
    assert!(!local_app_data
        .path()
        .join("Yuanyuan")
        .join("bridge-spool")
        .exists());
}

#[test]
fn real_cli_converts_and_delivers_a_raw_claude_failure_without_tool_content() {
    let key_id = unique_key_id("raw-claude");
    let secret = [0x7b; 32];
    let mut credential = TestCredential::new(&key_id);
    credential.write(&secret);

    let pipe_name = format!("yuanyuan.{}", unique_key_id("raw-claude-pipe"));
    let pipe_for_server = pipe_name.clone();
    let (ready_sender, ready_receiver) = std::sync::mpsc::sync_channel(1);
    let server_thread = thread::spawn(move || {
        let server = WindowsNamedPipeServer::bind(&pipe_for_server).unwrap();
        ready_sender.send(()).unwrap();
        let received = server.accept_one().unwrap();
        let payload = received.payload().to_vec();
        received.acknowledge().unwrap();
        payload
    });
    ready_receiver.recv().unwrap();

    let raw = br#"{
        "hook_event_name":"StopFailure",
        "session_id":"claude-session-sensitive",
        "error":"rate_limit",
        "error_details":"private provider error",
        "last_assistant_message":"private rendered error",
        "tool_input":{"command":"private command"},
        "tool_response":"private error output",
        "timestamp":"2026-08-04T10:10:00Z",
        "sequence":43
    }"#;
    let local_app_data = tempfile::tempdir().unwrap();
    register_trust(
        local_app_data.path(),
        "connector-raw-claude-test",
        "instance-raw-claude-test",
        &key_id,
    );
    let output = run_bridge_with_args(
        &[
            "--source".to_owned(),
            "claude-code-hooks".to_owned(),
            "--connector-id".to_owned(),
            "connector-raw-claude-test".to_owned(),
            "--source-instance".to_owned(),
            "instance-raw-claude-test".to_owned(),
            "--key-id".to_owned(),
            key_id,
            "--pipe-name".to_owned(),
            pipe_name,
        ],
        raw,
        local_app_data.path(),
    );

    assert!(output.status.success());
    assert!(output.stdout.is_empty());
    assert!(output.stderr.is_empty());
    let signed_payload = server_thread.join().unwrap();
    let envelope = verify_authenticated_signature(
        &signed_payload,
        &WindowsCredentialKeyResolver,
        now_unix_ms(),
    )
    .unwrap();
    assert_eq!(envelope.event.source, "anthropic.claude-code");
    assert_eq!(envelope.event.title, "Claude Code 任务");
    assert_eq!(envelope.event.sequence, 43);
    assert_eq!(envelope.event.state, yuanyuan_protocol::TaskState::Failed);
    let signed_text = String::from_utf8(signed_payload).unwrap();
    assert!(!signed_text.contains("private command"));
    assert!(!signed_text.contains("private error output"));
    assert!(!signed_text.contains("private provider error"));
    assert!(!signed_text.contains("private rendered error"));
    assert!(!signed_text.contains("claude-session-sensitive"));
    assert!(!local_app_data
        .path()
        .join("Yuanyuan")
        .join("bridge-spool")
        .exists());
}

#[test]
fn credential_manager_reads_rotates_and_revokes_a_scoped_test_key() {
    let old_key_id = unique_key_id("rotation-old");
    let new_key_id = unique_key_id("rotation-new");
    let first_secret = [0x31; 32];
    let second_secret = [0x72; 32];
    let first_input = signed_input("evt-credential-first", &old_key_id, &first_secret, 1);
    let second_input = signed_input("evt-credential-second", &new_key_id, &second_secret, 2);
    let resolver = WindowsCredentialKeyResolver;
    let mut old_credential = TestCredential::new(&old_key_id);
    let mut new_credential = TestCredential::new(&new_key_id);

    old_credential.write(&first_secret);
    assert!(verify_authenticated_signature(&first_input, &resolver, now_unix_ms()).is_ok());

    new_credential.write(&second_secret);
    assert!(verify_authenticated_signature(&first_input, &resolver, now_unix_ms()).is_ok());
    assert!(verify_authenticated_signature(&second_input, &resolver, now_unix_ms()).is_ok());

    old_credential.delete();
    assert!(matches!(
        verify_authenticated_signature(&first_input, &resolver, now_unix_ms()),
        Err(AuthenticationError::UnknownOrRevokedKey)
    ));
    assert!(verify_authenticated_signature(&second_input, &resolver, now_unix_ms()).is_ok());
    new_credential.delete();
    assert!(matches!(
        verify_authenticated_signature(&second_input, &resolver, now_unix_ms()),
        Err(AuthenticationError::UnknownOrRevokedKey)
    ));
}

#[test]
#[ignore = "requires a full interactive Windows logon credential set"]
fn production_store_persists_a_generated_key_for_subsequent_logon_sessions() {
    let key_id = unique_key_id("persistent-production");
    let mut cleanup = GeneratedCredentialCleanup(vec![key_id.clone()]);
    let secrets = WindowsCredentialSecretStore::default();

    secrets.create_generated(&key_id).unwrap();
    assert!(WindowsCredentialKeyResolver.resolve(&key_id).is_ok());
    assert!(secrets.delete(&key_id).unwrap());
    cleanup.0.clear();
    assert!(matches!(
        WindowsCredentialKeyResolver.resolve(&key_id),
        Err(yuanyuan_bridge::KeyResolutionError::UnknownOrRevoked)
    ));
}

#[test]
fn managed_credentials_enforce_two_stage_rotation_and_immediate_reset() {
    const CONNECTOR: &str = "connector-credential-test";
    const INSTANCE: &str = "codex-install-credential-test";
    let directory = tempfile::tempdir().unwrap();
    let database = directory.path().join("connector-trust.sqlite3");
    let trust = ConnectorTrustStore::open(&database).unwrap();
    let mut manager = CredentialTrustManager::new(
        trust,
        WindowsCredentialSecretStore::with_persistence(CredentialPersistence::CurrentLogonSession),
    );
    let mut cleanup = GeneratedCredentialCleanup::default();
    let started_at = now_unix_ms();

    let old_key_id = manager.register(CONNECTOR, INSTANCE, started_at).unwrap();
    cleanup.0.push(old_key_id.clone());
    let old_key = WindowsCredentialKeyResolver.resolve(&old_key_id).unwrap();
    let old_before_switch = serde_json::to_vec(
        &seal_event(
            event("evt-managed-old-before-switch"),
            &old_key_id,
            [0x41; AUTH_NONCE_BYTES],
            started_at,
            &old_key,
        )
        .unwrap(),
    )
    .unwrap();

    let switched_at = started_at + 1_000;
    let new_key_id = manager
        .begin_rotation(CONNECTOR, INSTANCE, switched_at)
        .unwrap();
    cleanup.0.push(new_key_id.clone());
    let resolver = TrustEnforcingKeyResolver::new(WindowsCredentialKeyResolver, &database);
    assert!(verify_authenticated_signature(&old_before_switch, &resolver, switched_at + 1).is_ok());

    let old_after_switch = serde_json::to_vec(
        &seal_event(
            event("evt-managed-old-after-switch"),
            &old_key_id,
            [0x42; AUTH_NONCE_BYTES],
            switched_at + 1,
            &old_key,
        )
        .unwrap(),
    )
    .unwrap();
    assert!(matches!(
        verify_authenticated_signature(&old_after_switch, &resolver, switched_at + 1),
        Err(AuthenticationError::UnknownOrRevokedKey)
    ));
    drop(resolver);

    let after_grace = switched_at + KEY_ROTATION_GRACE.as_millis() as i64 + 1;
    assert_eq!(
        manager.finalize_expired_rotations(after_grace, 1).unwrap(),
        1
    );
    assert!(matches!(
        WindowsCredentialKeyResolver.resolve(&old_key_id),
        Err(yuanyuan_bridge::KeyResolutionError::UnknownOrRevoked)
    ));
    assert!(WindowsCredentialKeyResolver.resolve(&new_key_id).is_ok());

    manager
        .reset_trust(CONNECTOR, INSTANCE, after_grace + 1)
        .unwrap();
    assert!(matches!(
        WindowsCredentialKeyResolver.resolve(&new_key_id),
        Err(yuanyuan_bridge::KeyResolutionError::UnknownOrRevoked)
    ));
}

#[test]
fn crash_gap_orphan_credentials_never_gain_or_regain_authority() {
    const CONNECTOR: &str = "connector-credential-test";
    const INSTANCE: &str = "codex-install-credential-test";
    let directory = tempfile::tempdir().unwrap();
    let database = directory.path().join("connector-trust.sqlite3");
    let mut trust = ConnectorTrustStore::open(&database).unwrap();
    let secret = [0x5d; 32];

    // Simulates termination after CredWriteW but before the trust transaction.
    let uncommitted_key_id = unique_key_id("crash-before-trust-commit");
    let mut uncommitted = TestCredential::new(&uncommitted_key_id);
    uncommitted.write(&secret);
    let uncommitted_input = signed_input(
        "evt-crash-before-trust-commit",
        &uncommitted_key_id,
        &secret,
        0x51,
    );
    let enforcing = TrustEnforcingKeyResolver::new(WindowsCredentialKeyResolver, &database);
    assert!(WindowsCredentialKeyResolver
        .resolve(&uncommitted_key_id)
        .is_ok());
    assert!(matches!(
        verify_authenticated_signature(&uncommitted_input, &enforcing, now_unix_ms()),
        Err(AuthenticationError::UnknownOrRevokedKey)
    ));
    drop(enforcing);

    // Simulates termination after trust revocation commits but before the exact
    // credential target is deleted.
    let revoked_key_id = unique_key_id("crash-after-trust-revoke");
    let mut revoked = TestCredential::new(&revoked_key_id);
    revoked.write(&secret);
    let signed_at = now_unix_ms();
    trust
        .register(CONNECTOR, INSTANCE, &revoked_key_id, signed_at)
        .unwrap();
    trust
        .reset_trust(CONNECTOR, INSTANCE, signed_at + 1)
        .unwrap();
    drop(trust);
    let revoked_input = signed_input(
        "evt-crash-after-trust-revoke",
        &revoked_key_id,
        &secret,
        0x52,
    );
    let enforcing = TrustEnforcingKeyResolver::new(WindowsCredentialKeyResolver, &database);
    assert!(WindowsCredentialKeyResolver
        .resolve(&revoked_key_id)
        .is_ok());
    assert!(matches!(
        verify_authenticated_signature(&revoked_input, &enforcing, now_unix_ms()),
        Err(AuthenticationError::UnknownOrRevokedKey)
    ));
}

#[test]
fn real_cli_delivers_a_credential_signed_event_and_remains_silent() {
    let key_id = unique_key_id("cli");
    let secret = [0x55; 32];
    let input = signed_input("evt-credential-cli", &key_id, &secret, 3);
    let mut credential = TestCredential::new(&key_id);
    credential.write(&secret);

    let pipe_name = format!("yuanyuan.test.credential-cli.{}", std::process::id());
    let pipe_for_server = pipe_name.clone();
    let (ready_sender, ready_receiver) = std::sync::mpsc::sync_channel(1);
    let server_thread = thread::spawn(move || {
        let server = WindowsNamedPipeServer::bind(&pipe_for_server).unwrap();
        ready_sender.send(()).unwrap();
        let received = server.accept_one().unwrap();
        let payload = received.payload().to_vec();
        received.acknowledge().unwrap();
        payload
    });
    ready_receiver.recv().unwrap();
    let local_app_data = tempfile::tempdir().unwrap();
    register_trust(
        local_app_data.path(),
        "connector-credential-test",
        "codex-install-credential-test",
        &key_id,
    );
    let output = run_bridge(&pipe_name, &input, local_app_data.path());

    assert!(output.status.success());
    assert!(output.stdout.is_empty());
    assert!(output.stderr.is_empty());
    assert_eq!(server_thread.join().unwrap(), input);
    assert!(!local_app_data
        .path()
        .join("Yuanyuan")
        .join("bridge-spool")
        .exists());
    credential.delete();
    assert!(matches!(
        verify_authenticated_signature(&input, &WindowsCredentialKeyResolver, now_unix_ms()),
        Err(AuthenticationError::UnknownOrRevokedKey)
    ));
}
