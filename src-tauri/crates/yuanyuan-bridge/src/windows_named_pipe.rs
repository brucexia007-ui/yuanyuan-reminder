use std::{
    ffi::OsStr,
    os::windows::ffi::OsStrExt,
    ptr, thread,
    time::{Duration, Instant},
};

use thiserror::Error;
use windows_sys::Win32::{
    Foundation::{
        CloseHandle, GetLastError, ERROR_BROKEN_PIPE, ERROR_FILE_NOT_FOUND, ERROR_MORE_DATA,
        ERROR_NO_DATA, ERROR_PIPE_BUSY, ERROR_PIPE_NOT_CONNECTED, ERROR_SEM_TIMEOUT, GENERIC_READ,
        GENERIC_WRITE, INVALID_HANDLE_VALUE,
    },
    Storage::FileSystem::{CreateFileW, ReadFile, WriteFile, FILE_ATTRIBUTE_NORMAL, OPEN_EXISTING},
    System::Pipes::{SetNamedPipeHandleState, WaitNamedPipeW, PIPE_NOWAIT, PIPE_READMODE_MESSAGE},
};
use yuanyuan_protocol::TaskEventEnvelope;
use zeroize::Zeroizing;

use crate::{
    EventSink, SinkError, DELIVERY_ACK_V1, MAX_BRIDGE_INPUT_BYTES, TARGET_DELIVERY_BUDGET,
};

const PIPE_PREFIX: &str = r"\\.\pipe\";
const MAX_LOGICAL_PIPE_NAME_BYTES: usize = 96;

#[derive(Debug, Error, Clone, Copy, PartialEq, Eq)]
pub enum NamedPipeNameError {
    #[error("named pipe name must not be empty")]
    Empty,
    #[error("named pipe name exceeds the byte limit")]
    TooLong,
    #[error("named pipe name contains unsupported characters")]
    InvalidCharacter,
}

#[derive(Debug, Clone)]
pub struct NamedPipeEventSink {
    pipe_path: Vec<u16>,
    connect_timeout: Duration,
}

impl NamedPipeEventSink {
    pub fn new(logical_name: &str) -> Result<Self, NamedPipeNameError> {
        Self::with_connect_timeout(logical_name, TARGET_DELIVERY_BUDGET)
    }

    pub fn with_connect_timeout(
        logical_name: &str,
        connect_timeout: Duration,
    ) -> Result<Self, NamedPipeNameError> {
        validate_logical_name(logical_name)?;
        let pipe_path = format!("{PIPE_PREFIX}{logical_name}");
        let mut wide: Vec<u16> = OsStr::new(&pipe_path).encode_wide().collect();
        wide.push(0);
        Ok(Self {
            pipe_path: wide,
            connect_timeout,
        })
    }

    /// Sends an already validated protocol or authenticated envelope verbatim.
    /// Callers must perform validation before invoking this raw transport API.
    pub fn send_validated_payload(&self, payload: &[u8]) -> Result<(), SinkError> {
        let acknowledgement =
            self.send_validated_payload_and_receive_response(payload, DELIVERY_ACK_V1.len())?;
        if acknowledgement != DELIVERY_ACK_V1 {
            return Err(SinkError::Rejected);
        }
        Ok(())
    }

    /// Sends one validated request and reads one size-bounded response. This
    /// primitive performs no JSON interpretation; the caller owns protocol
    /// validation before sending and after receiving.
    pub fn send_validated_payload_and_receive_response(
        &self,
        payload: &[u8],
        maximum_response_bytes: usize,
    ) -> Result<Vec<u8>, SinkError> {
        if payload.is_empty()
            || payload.len() > MAX_BRIDGE_INPUT_BYTES
            || maximum_response_bytes == 0
            || maximum_response_bytes > MAX_BRIDGE_INPUT_BYTES
        {
            return Err(SinkError::Rejected);
        }
        let handle = open_pipe(&self.pipe_path, self.connect_timeout)?;
        let mut written = 0;
        // SAFETY: `handle` is valid for this scope, the payload remains alive for
        // the synchronous call, and `written` points to writable stack memory.
        let succeeded = unsafe {
            WriteFile(
                handle.0,
                payload.as_ptr(),
                payload.len() as u32,
                &mut written,
                ptr::null_mut(),
            )
        };
        if succeeded == 0 {
            return Err(map_pipe_error(unsafe { GetLastError() }));
        }
        if written != payload.len() as u32 {
            return Err(SinkError::Rejected);
        }

        let mut response = vec![0_u8; maximum_response_bytes + 1];
        let mut read = 0;
        // SAFETY: the response buffer and byte-count pointer remain valid for
        // the duration of this synchronous single-message read.
        let succeeded = unsafe {
            ReadFile(
                handle.0,
                response.as_mut_ptr(),
                response.len() as u32,
                &mut read,
                ptr::null_mut(),
            )
        };
        if succeeded == 0 {
            let error = unsafe { GetLastError() };
            if error == ERROR_MORE_DATA {
                return Err(SinkError::Rejected);
            }
            return Err(map_pipe_error(error));
        }
        if read == 0 || read as usize > maximum_response_bytes {
            return Err(SinkError::Rejected);
        }
        response.truncate(read as usize);
        Ok(response)
    }

    /// Sends one validated request and receives one bounded response without
    /// allowing either I/O direction to wait past `operation_timeout`.
    ///
    /// This is intentionally separate from the legacy task-event ACK path:
    /// Support Sort uses a request/response channel and must not let an
    /// unresponsive AI process block the stable core indefinitely.
    pub fn send_validated_payload_and_receive_response_with_timeout(
        &self,
        payload: &[u8],
        maximum_response_bytes: usize,
        operation_timeout: Duration,
    ) -> Result<Zeroizing<Vec<u8>>, SinkError> {
        if payload.is_empty()
            || payload.len() > MAX_BRIDGE_INPUT_BYTES
            || maximum_response_bytes == 0
            || maximum_response_bytes > MAX_BRIDGE_INPUT_BYTES
            || operation_timeout.is_zero()
        {
            return Err(SinkError::Rejected);
        }

        let deadline = Instant::now() + operation_timeout;
        let handle = open_pipe(&self.pipe_path, self.connect_timeout.min(operation_timeout))?;
        set_nonblocking_message_mode(handle.0)?;
        write_before_deadline(handle.0, payload, deadline)?;
        read_before_deadline(handle.0, maximum_response_bytes, deadline)
    }
}

impl EventSink for NamedPipeEventSink {
    fn enqueue(&self, event: &TaskEventEnvelope) -> Result<(), SinkError> {
        let payload = serde_json::to_vec(event).map_err(|_| SinkError::Rejected)?;
        self.send_validated_payload(&payload)
    }
}

fn validate_logical_name(name: &str) -> Result<(), NamedPipeNameError> {
    if name.is_empty() {
        return Err(NamedPipeNameError::Empty);
    }
    if name.len() > MAX_LOGICAL_PIPE_NAME_BYTES {
        return Err(NamedPipeNameError::TooLong);
    }
    if !name
        .bytes()
        .all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit() || b"._-".contains(&byte))
    {
        return Err(NamedPipeNameError::InvalidCharacter);
    }
    Ok(())
}

struct OwnedHandle(windows_sys::Win32::Foundation::HANDLE);

impl Drop for OwnedHandle {
    fn drop(&mut self) {
        // SAFETY: this wrapper is only constructed for a valid owned handle.
        unsafe {
            CloseHandle(self.0);
        }
    }
}

fn open_pipe(path: &[u16], timeout: Duration) -> Result<OwnedHandle, SinkError> {
    let started = Instant::now();
    loop {
        match try_open_pipe(path) {
            Ok(handle) => return Ok(handle),
            Err(ERROR_FILE_NOT_FOUND) => {
                let Some(remaining) = remaining_connect_time(started, timeout) else {
                    return Err(SinkError::Unavailable);
                };
                thread::sleep(remaining.min(Duration::from_millis(1)));
            }
            Err(ERROR_PIPE_BUSY) => {
                let Some(remaining) = remaining_connect_time(started, timeout) else {
                    return Err(SinkError::Timeout);
                };
                // SAFETY: `path` is a NUL-terminated UTF-16 buffer owned by the sink.
                let available = unsafe { WaitNamedPipeW(path.as_ptr(), timeout_millis(remaining)) };
                if available == 0 {
                    let error = unsafe { GetLastError() };
                    if error == ERROR_FILE_NOT_FOUND {
                        continue;
                    }
                    return Err(map_pipe_error(error));
                }
            }
            Err(error) => return Err(map_pipe_error(error)),
        }
    }
}

fn remaining_connect_time(started: Instant, timeout: Duration) -> Option<Duration> {
    timeout
        .checked_sub(started.elapsed())
        .filter(|time| !time.is_zero())
}

fn try_open_pipe(path: &[u16]) -> Result<OwnedHandle, u32> {
    // SAFETY: `path` is NUL-terminated; the remaining pointer parameters are
    // intentionally null and the returned handle is checked before ownership.
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
    if handle == INVALID_HANDLE_VALUE {
        Err(unsafe { GetLastError() })
    } else {
        Ok(OwnedHandle(handle))
    }
}

fn set_nonblocking_message_mode(
    handle: windows_sys::Win32::Foundation::HANDLE,
) -> Result<(), SinkError> {
    let mode = PIPE_READMODE_MESSAGE | PIPE_NOWAIT;
    // SAFETY: `handle` is an open duplex named-pipe client handle. Only the
    // mode pointer is supplied; collection parameters are not changed.
    let succeeded = unsafe { SetNamedPipeHandleState(handle, &mode, ptr::null(), ptr::null()) };
    if succeeded == 0 {
        Err(map_pipe_error(unsafe { GetLastError() }))
    } else {
        Ok(())
    }
}

fn write_before_deadline(
    handle: windows_sys::Win32::Foundation::HANDLE,
    payload: &[u8],
    deadline: Instant,
) -> Result<(), SinkError> {
    loop {
        if Instant::now() >= deadline {
            return Err(SinkError::Timeout);
        }
        let mut written = 0;
        // SAFETY: nonblocking pipe mode makes this call return immediately;
        // the payload and byte-count pointer remain valid for the call.
        let succeeded = unsafe {
            WriteFile(
                handle,
                payload.as_ptr(),
                payload.len() as u32,
                &mut written,
                ptr::null_mut(),
            )
        };
        if succeeded != 0 {
            if Instant::now() >= deadline {
                return Err(SinkError::Timeout);
            }
            return if written == payload.len() as u32 {
                Ok(())
            } else {
                Err(SinkError::Rejected)
            };
        }
        let error = unsafe { GetLastError() };
        if error != ERROR_NO_DATA && error != ERROR_PIPE_BUSY {
            return Err(map_pipe_error(error));
        }
        wait_until_next_poll(deadline)?;
    }
}

fn read_before_deadline(
    handle: windows_sys::Win32::Foundation::HANDLE,
    maximum_response_bytes: usize,
    deadline: Instant,
) -> Result<Zeroizing<Vec<u8>>, SinkError> {
    let mut response = Zeroizing::new(vec![0_u8; maximum_response_bytes + 1]);
    loop {
        if Instant::now() >= deadline {
            return Err(SinkError::Timeout);
        }
        let mut read = 0;
        // SAFETY: nonblocking pipe mode makes this call return immediately;
        // the response buffer and byte-count pointer remain valid for the call.
        let succeeded = unsafe {
            ReadFile(
                handle,
                response.as_mut_ptr(),
                response.len() as u32,
                &mut read,
                ptr::null_mut(),
            )
        };
        if succeeded != 0 {
            if Instant::now() >= deadline {
                return Err(SinkError::Timeout);
            }
            if read == 0 || read as usize > maximum_response_bytes {
                return Err(SinkError::Rejected);
            }
            response.truncate(read as usize);
            return Ok(response);
        }
        let error = unsafe { GetLastError() };
        if error == ERROR_MORE_DATA {
            return Err(SinkError::Rejected);
        }
        if error != ERROR_NO_DATA && error != ERROR_PIPE_BUSY {
            return Err(map_pipe_error(error));
        }
        wait_until_next_poll(deadline)?;
    }
}

fn wait_until_next_poll(deadline: Instant) -> Result<(), SinkError> {
    let now = Instant::now();
    if now >= deadline {
        return Err(SinkError::Timeout);
    }
    thread::sleep((deadline - now).min(Duration::from_millis(1)));
    Ok(())
}

fn timeout_millis(timeout: Duration) -> u32 {
    timeout
        .as_millis()
        .clamp(1, u128::from(u32::MAX))
        .try_into()
        .unwrap_or(u32::MAX)
}

fn map_pipe_error(error: u32) -> SinkError {
    match error {
        ERROR_FILE_NOT_FOUND | ERROR_BROKEN_PIPE | ERROR_NO_DATA | ERROR_PIPE_NOT_CONNECTED => {
            SinkError::Unavailable
        }
        ERROR_SEM_TIMEOUT | ERROR_PIPE_BUSY => SinkError::Timeout,
        _ => SinkError::Rejected,
    }
}

#[cfg(test)]
mod tests {
    use std::sync::mpsc;

    use windows_sys::Win32::{
        Foundation::ERROR_PIPE_CONNECTED,
        Storage::FileSystem::{ReadFile, WriteFile, PIPE_ACCESS_DUPLEX},
        System::Pipes::{
            ConnectNamedPipe, CreateNamedPipeW, PIPE_READMODE_BYTE, PIPE_REJECT_REMOTE_CLIENTS,
            PIPE_TYPE_MESSAGE, PIPE_WAIT,
        },
    };

    use super::*;

    #[test]
    fn accepts_only_local_logical_pipe_names() {
        assert!(NamedPipeEventSink::new("yuanyuan.task-events.v1").is_ok());
        assert_eq!(
            NamedPipeEventSink::new(r"\\server\pipe\other").unwrap_err(),
            NamedPipeNameError::InvalidCharacter
        );
        assert_eq!(
            NamedPipeEventSink::new("Yuanyuan Events").unwrap_err(),
            NamedPipeNameError::InvalidCharacter
        );
    }

    #[test]
    fn missing_local_server_fails_open_as_unavailable() {
        let sink = NamedPipeEventSink::with_connect_timeout(
            "yuanyuan.test.definitely-missing",
            Duration::from_millis(10),
        )
        .unwrap();
        assert_eq!(
            sink.send_validated_payload(b"{}"),
            Err(SinkError::Unavailable)
        );
    }

    #[test]
    fn sends_payload_to_a_local_named_pipe_server() {
        let logical_name = format!("yuanyuan.test.{}", std::process::id());
        let sink = NamedPipeEventSink::new(&logical_name).unwrap();
        let server = create_test_server(&sink.pipe_path);
        let raw_server = server.0 as usize;
        std::mem::forget(server);
        let (sender, receiver) = mpsc::sync_channel(1);

        let server_thread = std::thread::spawn(move || {
            let server = OwnedHandle(raw_server as windows_sys::Win32::Foundation::HANDLE);
            // SAFETY: `server` is a valid named-pipe handle and this test uses
            // synchronous I/O with a null OVERLAPPED pointer.
            let connected = unsafe { ConnectNamedPipe(server.0, ptr::null_mut()) };
            if connected == 0 {
                let error = unsafe { GetLastError() };
                if error != ERROR_PIPE_CONNECTED && error != ERROR_NO_DATA {
                    let _ = sender.send(Err(error));
                    return;
                }
            }

            let mut buffer = [0_u8; 128];
            let mut read = 0;
            // SAFETY: the buffer and byte-count pointer are valid for the
            // duration of the synchronous read.
            let succeeded = unsafe {
                ReadFile(
                    server.0,
                    buffer.as_mut_ptr(),
                    buffer.len() as u32,
                    &mut read,
                    ptr::null_mut(),
                )
            };
            let payload = if succeeded == 0 {
                Err(unsafe { GetLastError() })
            } else {
                Ok(buffer[..read as usize].to_vec())
            };
            let mut acknowledged = 0;
            let ack_succeeded = unsafe {
                WriteFile(
                    server.0,
                    DELIVERY_ACK_V1.as_ptr(),
                    DELIVERY_ACK_V1.len() as u32,
                    &mut acknowledged,
                    ptr::null_mut(),
                )
            };
            if ack_succeeded == 0 || acknowledged as usize != DELIVERY_ACK_V1.len() {
                let _ = sender.send(Err(unsafe { GetLastError() }));
                return;
            }
            let _ = sender.send(payload);
        });

        assert_eq!(sink.send_validated_payload(b"local-pipe-event"), Ok(()));
        assert_eq!(
            receiver
                .recv_timeout(Duration::from_secs(1))
                .unwrap()
                .unwrap(),
            b"local-pipe-event"
        );
        server_thread.join().unwrap();
    }

    #[test]
    fn consecutive_deliveries_wait_across_the_server_instance_rebind_gap() {
        let logical_name = format!("yuanyuan.test.rebind-gap.{}", std::process::id());
        let sink =
            NamedPipeEventSink::with_connect_timeout(&logical_name, Duration::from_millis(250))
                .unwrap();
        let path = sink.pipe_path.clone();
        let first_server = create_test_server(&path);
        let raw_server = first_server.0 as usize;
        std::mem::forget(first_server);

        let server_thread = std::thread::spawn(move || {
            let first = OwnedHandle(raw_server as windows_sys::Win32::Foundation::HANDLE);
            accept_payload_and_ack(&first, b"first");
            drop(first);
            std::thread::sleep(Duration::from_millis(25));
            let second = create_test_server(&path);
            accept_payload_and_ack(&second, b"second");
        });

        assert_eq!(sink.send_validated_payload(b"first"), Ok(()));
        assert_eq!(sink.send_validated_payload(b"second"), Ok(()));
        server_thread.join().unwrap();
    }

    #[test]
    fn rejects_a_non_protocol_acknowledgement() {
        let logical_name = format!("yuanyuan.test.bad-ack.{}", std::process::id());
        let sink = NamedPipeEventSink::new(&logical_name).unwrap();
        let server = create_test_server(&sink.pipe_path);
        let raw_server = server.0 as usize;
        std::mem::forget(server);

        let server_thread = std::thread::spawn(move || {
            let server = OwnedHandle(raw_server as windows_sys::Win32::Foundation::HANDLE);
            let connected = unsafe { ConnectNamedPipe(server.0, ptr::null_mut()) };
            if connected == 0 && unsafe { GetLastError() } != ERROR_PIPE_CONNECTED {
                return;
            }
            let mut buffer = [0_u8; 32];
            let mut read = 0;
            unsafe {
                ReadFile(
                    server.0,
                    buffer.as_mut_ptr(),
                    buffer.len() as u32,
                    &mut read,
                    ptr::null_mut(),
                );
            }
            let mut written = 0;
            unsafe {
                WriteFile(
                    server.0,
                    b"BADACK!!".as_ptr(),
                    8,
                    &mut written,
                    ptr::null_mut(),
                );
            }
        });

        assert_eq!(
            sink.send_validated_payload(b"event"),
            Err(SinkError::Rejected)
        );
        server_thread.join().unwrap();
    }

    #[test]
    fn missing_acknowledgement_is_not_delivery_success() {
        let logical_name = format!("yuanyuan.test.no-ack.{}", std::process::id());
        let sink = NamedPipeEventSink::new(&logical_name).unwrap();
        let server = create_test_server(&sink.pipe_path);
        let raw_server = server.0 as usize;
        std::mem::forget(server);

        let server_thread = std::thread::spawn(move || {
            let server = OwnedHandle(raw_server as windows_sys::Win32::Foundation::HANDLE);
            let connected = unsafe { ConnectNamedPipe(server.0, ptr::null_mut()) };
            if connected == 0 && unsafe { GetLastError() } != ERROR_PIPE_CONNECTED {
                return;
            }
            let mut buffer = [0_u8; 32];
            let mut read = 0;
            unsafe {
                ReadFile(
                    server.0,
                    buffer.as_mut_ptr(),
                    buffer.len() as u32,
                    &mut read,
                    ptr::null_mut(),
                );
            }
        });

        assert_eq!(
            sink.send_validated_payload(b"event"),
            Err(SinkError::Unavailable)
        );
        server_thread.join().unwrap();
    }

    #[test]
    fn bounded_duplex_timeout_returns_before_a_silent_server_can_block_the_caller() {
        let logical_name = format!("yuanyuan.test.response-timeout.{}", std::process::id());
        let sink = NamedPipeEventSink::new(&logical_name).unwrap();
        let server = create_test_server(&sink.pipe_path);
        let raw_server = server.0 as usize;
        std::mem::forget(server);

        let server_thread = std::thread::spawn(move || {
            let server = OwnedHandle(raw_server as windows_sys::Win32::Foundation::HANDLE);
            let connected = unsafe { ConnectNamedPipe(server.0, ptr::null_mut()) };
            if connected == 0 {
                let error = unsafe { GetLastError() };
                if error != ERROR_PIPE_CONNECTED && error != ERROR_NO_DATA {
                    return;
                }
            }
            let mut buffer = [0_u8; 32];
            let mut read = 0;
            unsafe {
                ReadFile(
                    server.0,
                    buffer.as_mut_ptr(),
                    buffer.len() as u32,
                    &mut read,
                    ptr::null_mut(),
                );
            }
            std::thread::sleep(Duration::from_millis(100));
        });

        let started = Instant::now();
        assert_eq!(
            sink.send_validated_payload_and_receive_response_with_timeout(
                b"request",
                64,
                Duration::from_millis(25),
            ),
            Err(SinkError::Timeout)
        );
        assert!(started.elapsed() < Duration::from_millis(250));
        server_thread.join().unwrap();
    }

    #[test]
    fn bounded_duplex_timeout_path_accepts_a_prompt_bounded_response() {
        let logical_name = format!("yuanyuan.test.response-ready.{}", std::process::id());
        let sink = NamedPipeEventSink::new(&logical_name).unwrap();
        let server = create_test_server(&sink.pipe_path);
        let raw_server = server.0 as usize;
        std::mem::forget(server);

        let server_thread = std::thread::spawn(move || {
            let server = OwnedHandle(raw_server as windows_sys::Win32::Foundation::HANDLE);
            let connected = unsafe { ConnectNamedPipe(server.0, ptr::null_mut()) };
            if connected == 0 {
                let error = unsafe { GetLastError() };
                if error != ERROR_PIPE_CONNECTED && error != ERROR_NO_DATA {
                    return;
                }
            }
            let mut buffer = [0_u8; 32];
            let mut read = 0;
            let read_succeeded = unsafe {
                ReadFile(
                    server.0,
                    buffer.as_mut_ptr(),
                    buffer.len() as u32,
                    &mut read,
                    ptr::null_mut(),
                )
            };
            assert_ne!(read_succeeded, 0);
            assert_eq!(&buffer[..read as usize], b"request");
            let mut written = 0;
            let write_succeeded = unsafe {
                WriteFile(
                    server.0,
                    b"response".as_ptr(),
                    8,
                    &mut written,
                    ptr::null_mut(),
                )
            };
            assert_ne!(write_succeeded, 0);
            assert_eq!(written, 8);
        });

        assert_eq!(
            sink.send_validated_payload_and_receive_response_with_timeout(
                b"request",
                64,
                Duration::from_secs(1),
            )
            .unwrap()
            .as_slice(),
            b"response"
        );
        server_thread.join().unwrap();
    }

    #[test]
    fn timeout_rounding_never_produces_an_infinite_wait() {
        assert_eq!(timeout_millis(Duration::ZERO), 1);
        assert_eq!(timeout_millis(Duration::from_micros(999)), 1);
        assert_eq!(timeout_millis(Duration::from_millis(25)), 25);
    }

    fn create_test_server(path: &[u16]) -> OwnedHandle {
        // SAFETY: `path` is a NUL-terminated local pipe path. The null security
        // attributes intentionally use the process default for this transport
        // test; production DACL construction is a separate P0 gate.
        let handle = unsafe {
            CreateNamedPipeW(
                path.as_ptr(),
                PIPE_ACCESS_DUPLEX,
                PIPE_TYPE_MESSAGE | PIPE_READMODE_BYTE | PIPE_WAIT | PIPE_REJECT_REMOTE_CLIENTS,
                1,
                0,
                128,
                1_000,
                ptr::null(),
            )
        };
        assert_ne!(handle, INVALID_HANDLE_VALUE);
        OwnedHandle(handle)
    }

    fn accept_payload_and_ack(server: &OwnedHandle, expected: &[u8]) {
        let connected = unsafe { ConnectNamedPipe(server.0, ptr::null_mut()) };
        if connected == 0 {
            let error = unsafe { GetLastError() };
            assert!(matches!(error, ERROR_PIPE_CONNECTED | ERROR_NO_DATA));
        }
        let mut buffer = [0_u8; 32];
        let mut read = 0;
        let read_succeeded = unsafe {
            ReadFile(
                server.0,
                buffer.as_mut_ptr(),
                buffer.len() as u32,
                &mut read,
                ptr::null_mut(),
            )
        };
        assert_ne!(read_succeeded, 0);
        assert_eq!(&buffer[..read as usize], expected);
        let mut written = 0;
        let write_succeeded = unsafe {
            WriteFile(
                server.0,
                DELIVERY_ACK_V1.as_ptr(),
                DELIVERY_ACK_V1.len() as u32,
                &mut written,
                ptr::null_mut(),
            )
        };
        assert_ne!(write_succeeded, 0);
        assert_eq!(written as usize, DELIVERY_ACK_V1.len());
    }
}
