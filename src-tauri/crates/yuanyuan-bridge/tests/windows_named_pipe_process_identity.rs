#![cfg(windows)]

use std::{
    process::{Command, Stdio},
    thread,
    time::{Duration, Instant},
};

use yuanyuan_bridge::{
    current_process_identity, NamedPipeEventSink, NamedPipeServerError, WindowsNamedPipeServer,
};

const HELPER_PIPE_ENV: &str = "YUANYUAN_TEST_UNAUTHORIZED_PIPE";

#[test]
fn a_different_same_user_process_is_rejected_before_payload_read() {
    if let Some(pipe_name) = std::env::var_os(HELPER_PIPE_ENV) {
        let pipe_name = pipe_name.to_string_lossy();
        let result = NamedPipeEventSink::new(&pipe_name)
            .unwrap()
            .send_validated_payload_and_receive_response_with_timeout(
                b"must-not-be-read",
                64,
                Duration::from_secs(1),
            );
        assert!(result.is_err());
        return;
    }

    let pipe_name = format!("yuanyuan.identity.foreign-process.{}", std::process::id());
    let expected_stable_core = current_process_identity().unwrap();
    let server = WindowsNamedPipeServer::bind_for_client(&pipe_name, expected_stable_core).unwrap();
    let mut client = Command::new(std::env::current_exe().unwrap())
        .args([
            "--exact",
            "a_different_same_user_process_is_rejected_before_payload_read",
            "--nocapture",
        ])
        .env(HELPER_PIPE_ENV, &pipe_name)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .unwrap();

    assert_eq!(
        server.accept_one().map(|_| ()),
        Err(NamedPipeServerError::ClientIdentity)
    );

    let deadline = Instant::now() + Duration::from_secs(2);
    let status = loop {
        if let Some(status) = client.try_wait().unwrap() {
            break status;
        }
        if Instant::now() >= deadline {
            let _ = client.kill();
            let _ = client.wait();
            panic!("unauthorized client did not stop within its bounded deadline");
        }
        thread::sleep(Duration::from_millis(10));
    };
    assert!(status.success());
}
