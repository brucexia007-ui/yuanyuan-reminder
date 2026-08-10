use std::{ffi::OsStr, mem, os::windows::ffi::OsStrExt, path::Path, ptr};

use thiserror::Error;
use windows_sys::Win32::{
    Foundation::{
        CloseHandle, GetLastError, LocalFree, ERROR_BROKEN_PIPE, ERROR_INSUFFICIENT_BUFFER,
        ERROR_MORE_DATA, ERROR_NO_DATA, ERROR_PIPE_CONNECTED, FILETIME, HANDLE,
        INVALID_HANDLE_VALUE,
    },
    Security::{
        Authorization::{
            ConvertSidToStringSidW, ConvertStringSecurityDescriptorToSecurityDescriptorW,
            SDDL_REVISION_1,
        },
        GetTokenInformation, SetFileSecurityW, TokenUser, DACL_SECURITY_INFORMATION,
        PROTECTED_DACL_SECURITY_INFORMATION, SECURITY_ATTRIBUTES, TOKEN_QUERY, TOKEN_USER,
    },
    Storage::FileSystem::{ReadFile, WriteFile, PIPE_ACCESS_DUPLEX},
    System::{
        Diagnostics::ToolHelp::{
            CreateToolhelp32Snapshot, Process32FirstW, Process32NextW, PROCESSENTRY32W,
            TH32CS_SNAPPROCESS,
        },
        Pipes::{
            ConnectNamedPipe, CreateNamedPipeW, GetNamedPipeClientProcessId, PeekNamedPipe,
            PIPE_READMODE_BYTE, PIPE_REJECT_REMOTE_CLIENTS, PIPE_TYPE_MESSAGE, PIPE_WAIT,
        },
        Threading::{
            GetCurrentProcess, GetCurrentProcessId, GetProcessTimes, OpenProcess, OpenProcessToken,
            PROCESS_QUERY_LIMITED_INFORMATION,
        },
    },
};
use zeroize::Zeroizing;

use crate::{DELIVERY_ACK_V1, MAX_BRIDGE_INPUT_BYTES};

const PIPE_PREFIX: &str = r"\\.\pipe\";
const MAX_LOGICAL_PIPE_NAME_BYTES: usize = 96;

#[derive(Debug, Error, Clone, Copy, PartialEq, Eq)]
pub enum NamedPipeServerError {
    #[error("named pipe name is invalid")]
    InvalidName,
    #[error("current Windows user identity is unavailable")]
    CurrentUserUnavailable,
    #[error("current-user security descriptor could not be created")]
    SecurityDescriptor,
    #[error("named pipe server could not be created")]
    Create,
    #[error("named pipe client could not be accepted")]
    Connect,
    #[error("named pipe client process identity did not match")]
    ClientIdentity,
    #[error("named pipe request was rejected before reading")]
    PreReadRejected,
    #[error("named pipe event could not be read")]
    Read,
    #[error("named pipe event exceeds the byte limit")]
    InputTooLarge,
    #[error("named pipe acknowledgement could not be written")]
    Acknowledge,
    #[error("named pipe response exceeds the byte limit")]
    ResponseTooLarge,
    #[error("named pipe response could not be written")]
    Response,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct WindowsProcessIdentity {
    pub process_id: u32,
    pub creation_time_100ns: u64,
}

pub struct WindowsNamedPipeServer {
    handle: OwnedHandle,
    expected_client: Option<WindowsProcessIdentity>,
}

impl WindowsNamedPipeServer {
    pub fn bind(logical_name: &str) -> Result<Self, NamedPipeServerError> {
        Self::bind_internal(logical_name, None)
    }

    pub fn bind_for_client(
        logical_name: &str,
        expected_client: WindowsProcessIdentity,
    ) -> Result<Self, NamedPipeServerError> {
        if expected_client.process_id == 0 || expected_client.creation_time_100ns == 0 {
            return Err(NamedPipeServerError::ClientIdentity);
        }
        Self::bind_internal(logical_name, Some(expected_client))
    }

    fn bind_internal(
        logical_name: &str,
        expected_client: Option<WindowsProcessIdentity>,
    ) -> Result<Self, NamedPipeServerError> {
        let path = pipe_path(logical_name)?;
        let security_descriptor = current_user_security_descriptor(false)?;
        let security_attributes = SECURITY_ATTRIBUTES {
            nLength: mem::size_of::<SECURITY_ATTRIBUTES>() as u32,
            lpSecurityDescriptor: security_descriptor.0,
            bInheritHandle: 0,
        };
        // SAFETY: the path is NUL-terminated, security attributes reference a
        // live descriptor for the duration of the call, and the handle is
        // checked before ownership.
        let handle = unsafe {
            CreateNamedPipeW(
                path.as_ptr(),
                PIPE_ACCESS_DUPLEX,
                server_pipe_mode(),
                1,
                0,
                MAX_BRIDGE_INPUT_BYTES as u32,
                1_000,
                &security_attributes,
            )
        };
        if handle == INVALID_HANDLE_VALUE {
            return Err(NamedPipeServerError::Create);
        }
        Ok(Self {
            handle: OwnedHandle(handle),
            expected_client,
        })
    }

    pub fn accept_one(self) -> Result<ReceivedPipeEvent, NamedPipeServerError> {
        self.accept_one_with_pre_read_guard(|| true)
    }

    /// Accepts and authenticates the connected client, then runs a fixed-data
    /// policy guard before allocating or reading the request payload. A false
    /// result closes the pipe without consuming caller-controlled bytes.
    pub fn accept_one_with_pre_read_guard<F>(
        self,
        authorize_read: F,
    ) -> Result<ReceivedPipeEvent, NamedPipeServerError>
    where
        F: FnOnce() -> bool,
    {
        // SAFETY: the owned handle is a synchronous named-pipe server handle.
        let connected = unsafe { ConnectNamedPipe(self.handle.0, ptr::null_mut()) };
        if connected == 0 {
            let error = unsafe { GetLastError() };
            if error != ERROR_PIPE_CONNECTED && error != ERROR_NO_DATA {
                return Err(NamedPipeServerError::Connect);
            }
        }

        if let Some(expected) = self.expected_client {
            validate_connected_client(self.handle.0, expected)?;
        }
        if !authorize_read() {
            return Err(NamedPipeServerError::PreReadRejected);
        }

        let mut payload = Zeroizing::new(vec![0_u8; MAX_BRIDGE_INPUT_BYTES + 1]);
        let mut read = 0;
        // SAFETY: the vector exposes a valid writable region and the byte-count
        // pointer remains valid for this synchronous message read.
        let succeeded = unsafe {
            ReadFile(
                self.handle.0,
                payload.as_mut_ptr(),
                payload.len() as u32,
                &mut read,
                ptr::null_mut(),
            )
        };
        if succeeded == 0 {
            let error = unsafe { GetLastError() };
            if error == ERROR_MORE_DATA || read as usize > MAX_BRIDGE_INPUT_BYTES {
                return Err(NamedPipeServerError::InputTooLarge);
            }
            if matches!(error, ERROR_BROKEN_PIPE | ERROR_NO_DATA) {
                return Err(NamedPipeServerError::Read);
            }
            return Err(NamedPipeServerError::Read);
        }
        payload.truncate(read as usize);
        if payload.is_empty() {
            return Err(NamedPipeServerError::Read);
        }
        if payload.len() > MAX_BRIDGE_INPUT_BYTES {
            return Err(NamedPipeServerError::InputTooLarge);
        }
        Ok(ReceivedPipeEvent {
            handle: self.handle,
            payload,
        })
    }
}

pub struct ReceivedPipeEvent {
    handle: OwnedHandle,
    payload: Zeroizing<Vec<u8>>,
}

impl ReceivedPipeEvent {
    pub fn payload(&self) -> &[u8] {
        self.payload.as_slice()
    }

    /// Returns true when the client side can no longer be proven connected.
    /// This check is non-consuming and allows a long-running request handler to
    /// cancel sensitive downstream work after the bounded caller closes its
    /// pipe handle.
    pub fn client_disconnected(&self) -> bool {
        let mut available = 0_u32;
        // SAFETY: the connected server handle remains owned by `self`; all
        // optional buffer/count arguments are null except the valid byte-count
        // output. PeekNamedPipe never consumes request bytes.
        unsafe {
            PeekNamedPipe(
                self.handle.0,
                ptr::null_mut(),
                0,
                ptr::null_mut(),
                &mut available,
                ptr::null_mut(),
            ) == 0
        }
    }

    /// Confirms that the receiver has finished authentication, nonce
    /// registration and durable acceptance. Dropping without calling this
    /// method deliberately causes the sender to treat delivery as failed.
    pub fn acknowledge(self) -> Result<(), NamedPipeServerError> {
        let mut written = 0;
        // SAFETY: the handle is connected and the fixed acknowledgement bytes
        // remain alive for this synchronous write.
        let succeeded = unsafe {
            WriteFile(
                self.handle.0,
                DELIVERY_ACK_V1.as_ptr(),
                DELIVERY_ACK_V1.len() as u32,
                &mut written,
                ptr::null_mut(),
            )
        };
        if succeeded == 0 || written as usize != DELIVERY_ACK_V1.len() {
            Err(NamedPipeServerError::Acknowledge)
        } else {
            Ok(())
        }
    }

    /// Writes one already validated response. The caller selects an operation-
    /// specific limit no larger than the transport's global 64 KiB ceiling.
    pub fn respond_bounded(
        self,
        response: &[u8],
        maximum_bytes: usize,
    ) -> Result<(), NamedPipeServerError> {
        if response.is_empty()
            || maximum_bytes == 0
            || maximum_bytes > MAX_BRIDGE_INPUT_BYTES
            || response.len() > maximum_bytes
        {
            return Err(NamedPipeServerError::ResponseTooLarge);
        }
        let mut written = 0;
        // SAFETY: the connected handle and response buffer remain valid for
        // the duration of this synchronous single-message write.
        let succeeded = unsafe {
            WriteFile(
                self.handle.0,
                response.as_ptr(),
                response.len() as u32,
                &mut written,
                ptr::null_mut(),
            )
        };
        if succeeded == 0 || written as usize != response.len() {
            Err(NamedPipeServerError::Response)
        } else {
            Ok(())
        }
    }
}

pub fn current_process_identity() -> Result<WindowsProcessIdentity, NamedPipeServerError> {
    let process_id = unsafe { GetCurrentProcessId() };
    process_identity_from_handle(process_id, unsafe { GetCurrentProcess() })
}

pub fn current_parent_process_identity() -> Result<WindowsProcessIdentity, NamedPipeServerError> {
    // SAFETY: the snapshot handle is checked before ownership and enumerated
    // only with a correctly sized PROCESSENTRY32W structure.
    let snapshot = unsafe { CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0) };
    if snapshot == INVALID_HANDLE_VALUE {
        return Err(NamedPipeServerError::ClientIdentity);
    }
    let snapshot = OwnedHandle(snapshot);
    let mut entry = unsafe { mem::zeroed::<PROCESSENTRY32W>() };
    entry.dwSize = mem::size_of::<PROCESSENTRY32W>() as u32;
    let mut found_parent = None;
    let current_process_id = unsafe { GetCurrentProcessId() };
    if unsafe { Process32FirstW(snapshot.0, &mut entry) } != 0 {
        loop {
            if entry.th32ProcessID == current_process_id {
                found_parent = Some(entry.th32ParentProcessID);
                break;
            }
            if unsafe { Process32NextW(snapshot.0, &mut entry) } == 0 {
                break;
            }
        }
    }
    let parent_process_id = found_parent
        .filter(|process_id| *process_id != 0)
        .ok_or(NamedPipeServerError::ClientIdentity)?;
    let parent = unsafe { OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, parent_process_id) };
    if parent.is_null() {
        return Err(NamedPipeServerError::ClientIdentity);
    }
    let parent = OwnedHandle(parent);
    process_identity_from_handle(parent_process_id, parent.0)
}

fn validate_connected_client(
    pipe: HANDLE,
    expected: WindowsProcessIdentity,
) -> Result<(), NamedPipeServerError> {
    let process_id_before = connected_client_process_id(pipe)?;
    if process_id_before != expected.process_id {
        return Err(NamedPipeServerError::ClientIdentity);
    }
    // SAFETY: access is limited to process metadata; the handle is checked and
    // immediately wrapped for deterministic closure.
    let process = unsafe { OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, process_id_before) };
    if process.is_null() {
        return Err(NamedPipeServerError::ClientIdentity);
    }
    let process = OwnedHandle(process);
    let actual = process_identity_from_handle(process_id_before, process.0)?;
    let process_id_after = connected_client_process_id(pipe)?;
    validate_client_identity_observations(expected, process_id_before, actual, process_id_after)
}

fn connected_client_process_id(pipe: HANDLE) -> Result<u32, NamedPipeServerError> {
    let mut process_id = 0_u32;
    // SAFETY: `pipe` is a connected server-side named-pipe handle and the PID
    // output pointer is valid for this synchronous call.
    if unsafe { GetNamedPipeClientProcessId(pipe, &mut process_id) } == 0 || process_id == 0 {
        return Err(NamedPipeServerError::ClientIdentity);
    }
    Ok(process_id)
}

fn validate_client_identity_observations(
    expected: WindowsProcessIdentity,
    process_id_before: u32,
    actual: WindowsProcessIdentity,
    process_id_after: u32,
) -> Result<(), NamedPipeServerError> {
    (process_id_before != 0
        && process_id_before == process_id_after
        && process_id_before == expected.process_id
        && actual == expected)
        .then_some(())
        .ok_or(NamedPipeServerError::ClientIdentity)
}

fn process_identity_from_handle(
    process_id: u32,
    process: HANDLE,
) -> Result<WindowsProcessIdentity, NamedPipeServerError> {
    let mut creation = FILETIME::default();
    let mut exit = FILETIME::default();
    let mut kernel = FILETIME::default();
    let mut user = FILETIME::default();
    // SAFETY: `process` has query rights (or is the current-process pseudo
    // handle) and all FILETIME output pointers are valid.
    if unsafe { GetProcessTimes(process, &mut creation, &mut exit, &mut kernel, &mut user) } == 0 {
        return Err(NamedPipeServerError::ClientIdentity);
    }
    let creation_time_100ns =
        (u64::from(creation.dwHighDateTime) << 32) | u64::from(creation.dwLowDateTime);
    let exit_time_100ns = (u64::from(exit.dwHighDateTime) << 32) | u64::from(exit.dwLowDateTime);
    if process_id == 0 || creation_time_100ns == 0 || exit_time_100ns != 0 {
        return Err(NamedPipeServerError::ClientIdentity);
    }
    Ok(WindowsProcessIdentity {
        process_id,
        creation_time_100ns,
    })
}

pub fn apply_current_user_only_dacl(path: &Path) -> Result<(), NamedPipeServerError> {
    let descriptor = current_user_security_descriptor(true)?;
    let mut wide: Vec<u16> = path.as_os_str().encode_wide().collect();
    wide.push(0);
    // SAFETY: the path is NUL-terminated and the descriptor remains live for
    // the duration of the SetFileSecurityW call.
    let applied = unsafe {
        SetFileSecurityW(
            wide.as_ptr(),
            DACL_SECURITY_INFORMATION | PROTECTED_DACL_SECURITY_INFORMATION,
            descriptor.0,
        )
    };
    if applied == 0 {
        Err(NamedPipeServerError::SecurityDescriptor)
    } else {
        Ok(())
    }
}

struct OwnedHandle(HANDLE);

// SAFETY: this wrapper has unique ownership of one Windows kernel handle.
// Windows process and named-pipe handles may be used and closed from a
// different thread; the wrapper is not Clone and exposes no shared access.
unsafe impl Send for OwnedHandle {}

impl Drop for OwnedHandle {
    fn drop(&mut self) {
        // SAFETY: this wrapper owns one valid kernel handle.
        unsafe {
            CloseHandle(self.0);
        }
    }
}

struct LocalAllocation(*mut core::ffi::c_void);

impl Drop for LocalAllocation {
    fn drop(&mut self) {
        // SAFETY: this pointer came from a Windows API documented for LocalFree.
        unsafe {
            LocalFree(self.0);
        }
    }
}

fn pipe_path(logical_name: &str) -> Result<Vec<u16>, NamedPipeServerError> {
    let valid = !logical_name.is_empty()
        && logical_name.len() <= MAX_LOGICAL_PIPE_NAME_BYTES
        && logical_name.bytes().all(|byte| {
            byte.is_ascii_lowercase() || byte.is_ascii_digit() || b"._-".contains(&byte)
        });
    if !valid {
        return Err(NamedPipeServerError::InvalidName);
    }
    let mut path: Vec<u16> = OsStr::new(&format!("{PIPE_PREFIX}{logical_name}"))
        .encode_wide()
        .collect();
    path.push(0);
    Ok(path)
}

fn server_pipe_mode() -> u32 {
    PIPE_TYPE_MESSAGE | PIPE_READMODE_BYTE | PIPE_WAIT | PIPE_REJECT_REMOTE_CLIENTS
}

fn current_user_security_descriptor(
    inheritable: bool,
) -> Result<LocalAllocation, NamedPipeServerError> {
    let sid = current_user_sid_string()?;
    let ace_flags = if inheritable { "OICI" } else { "" };
    let sddl = format!("D:P(A;{ace_flags};GA;;;{sid})");
    let mut wide: Vec<u16> = OsStr::new(&sddl).encode_wide().collect();
    wide.push(0);
    let mut descriptor = ptr::null_mut();
    // SAFETY: the SDDL string is NUL-terminated and the returned descriptor is
    // captured by a LocalFree-backed owner.
    let converted = unsafe {
        ConvertStringSecurityDescriptorToSecurityDescriptorW(
            wide.as_ptr(),
            SDDL_REVISION_1,
            &mut descriptor,
            ptr::null_mut(),
        )
    };
    if converted == 0 || descriptor.is_null() {
        Err(NamedPipeServerError::SecurityDescriptor)
    } else {
        Ok(LocalAllocation(descriptor))
    }
}

fn current_user_sid_string() -> Result<String, NamedPipeServerError> {
    let mut token = ptr::null_mut();
    // SAFETY: GetCurrentProcess returns a pseudo-handle and `token` is writable.
    let opened = unsafe { OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &mut token) };
    if opened == 0 {
        return Err(NamedPipeServerError::CurrentUserUnavailable);
    }
    let token = OwnedHandle(token);
    let mut required = 0;
    // SAFETY: the first call intentionally queries the required buffer size.
    unsafe {
        GetTokenInformation(token.0, TokenUser, ptr::null_mut(), 0, &mut required);
    }
    if required == 0 || unsafe { GetLastError() } != ERROR_INSUFFICIENT_BUFFER {
        return Err(NamedPipeServerError::CurrentUserUnavailable);
    }
    let word_size = mem::size_of::<usize>();
    let mut storage = vec![0_usize; (required as usize).div_ceil(word_size)];
    // SAFETY: usize storage is sufficiently aligned and has at least `required`
    // writable bytes; the returned TOKEN_USER points inside this buffer.
    let loaded = unsafe {
        GetTokenInformation(
            token.0,
            TokenUser,
            storage.as_mut_ptr().cast(),
            required,
            &mut required,
        )
    };
    if loaded == 0 {
        return Err(NamedPipeServerError::CurrentUserUnavailable);
    }
    let token_user = unsafe { &*storage.as_ptr().cast::<TOKEN_USER>() };
    let mut sid_string = ptr::null_mut();
    // SAFETY: TokenUser contains a valid SID for the lifetime of `storage`.
    let converted = unsafe { ConvertSidToStringSidW(token_user.User.Sid, &mut sid_string) };
    if converted == 0 || sid_string.is_null() {
        return Err(NamedPipeServerError::CurrentUserUnavailable);
    }
    let allocation = LocalAllocation(sid_string.cast());
    let mut length = 0;
    // SAFETY: ConvertSidToStringSidW returns a NUL-terminated UTF-16 string.
    while unsafe { *sid_string.add(length) } != 0 {
        length += 1;
    }
    let sid = String::from_utf16(unsafe { std::slice::from_raw_parts(sid_string, length) })
        .map_err(|_| NamedPipeServerError::CurrentUserUnavailable)?;
    drop(allocation);
    Ok(sid)
}

#[cfg(test)]
mod tests {
    use std::{
        fs, os::windows::io::AsRawHandle, process::Command, sync::mpsc, thread, time::Duration,
    };

    use windows_sys::Win32::{
        Foundation::{ERROR_ACCESS_DENIED, GENERIC_READ, GENERIC_WRITE},
        Security::{ImpersonateAnonymousToken, RevertToSelf},
        Storage::FileSystem::{CreateFileW, FILE_ATTRIBUTE_NORMAL, OPEN_EXISTING},
        System::Threading::GetCurrentThread,
    };

    use yuanyuan_protocol::{
        EventFinality, EvidenceLevel, EvidenceType, TaskEventEnvelope, TaskEventV1, TaskState,
        TASK_EVENT_PROTOCOL_VERSION,
    };

    use crate::{EventSink, NamedPipeEventSink};

    use super::*;

    #[test]
    fn current_user_dacl_contains_only_one_explicit_user_ace() {
        let sid = current_user_sid_string().unwrap();
        assert!(sid.starts_with("S-1-"));
        let sddl = format!("D:P(A;;GA;;;{sid})");
        assert_eq!(sddl.matches("(A;;GA;;;").count(), 1);
        assert!(!sddl.contains(";;;WD"));
        assert!(!sddl.contains(";;;AN"));
        assert!(current_user_security_descriptor(false).is_ok());
    }

    #[test]
    fn current_user_directory_dacl_allows_owned_files() {
        let directory = tempfile::tempdir().unwrap();
        apply_current_user_only_dacl(directory.path()).unwrap();
        let child = directory.path().join("owned.tmp");
        fs::write(&child, b"owned").unwrap();
        assert_eq!(fs::read(child).unwrap(), b"owned");
    }

    #[test]
    fn server_mode_rejects_remote_clients() {
        assert_ne!(server_pipe_mode() & PIPE_REJECT_REMOTE_CLIENTS, 0);
    }

    #[test]
    fn anonymous_windows_token_cannot_open_the_current_user_pipe() {
        struct RevertImpersonation;
        impl Drop for RevertImpersonation {
            fn drop(&mut self) {
                // SAFETY: this guard is created only after successful thread
                // impersonation and restores the original process identity.
                unsafe {
                    RevertToSelf();
                }
            }
        }

        let logical_name = format!("yuanyuan.anonymous-denied.{}", std::process::id());
        let path = pipe_path(&logical_name).unwrap();
        let _server = WindowsNamedPipeServer::bind(&logical_name).unwrap();
        // SAFETY: GetCurrentThread returns a valid pseudo-handle for the
        // calling thread; no token handle is transferred to this test.
        assert_ne!(unsafe { ImpersonateAnonymousToken(GetCurrentThread()) }, 0);
        let _revert = RevertImpersonation;
        // SAFETY: `path` is a live NUL-terminated local pipe path. The call is
        // deliberately made under an anonymous token to exercise the DACL.
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
        let error = unsafe { GetLastError() };
        if handle != INVALID_HANDLE_VALUE {
            unsafe { CloseHandle(handle) };
        }
        assert_eq!(handle, INVALID_HANDLE_VALUE);
        assert_eq!(error, ERROR_ACCESS_DENIED);
    }

    #[test]
    fn current_user_client_can_send_to_the_protected_server() {
        let logical_name = format!("yuanyuan.secure-test.{}", std::process::id());
        let server_name = logical_name.clone();
        let (ready_sender, ready_receiver) = mpsc::sync_channel(1);
        let server = thread::spawn(move || {
            let server = WindowsNamedPipeServer::bind(&server_name).unwrap();
            ready_sender.send(()).unwrap();
            let received = server.accept_one().unwrap();
            let payload = received.payload().to_vec();
            received.acknowledge().unwrap();
            payload
        });
        ready_receiver.recv_timeout(Duration::from_secs(1)).unwrap();

        let event = test_event();
        NamedPipeEventSink::new(&logical_name)
            .unwrap()
            .enqueue(&event)
            .unwrap();
        let received = server.join().unwrap();
        assert_eq!(
            serde_json::from_slice::<TaskEventEnvelope>(&received).unwrap(),
            event
        );
    }

    #[test]
    fn pre_read_guard_rejects_after_identity_without_consuming_payload() {
        let logical_name = format!("yuanyuan.pre-read-denied.{}", std::process::id());
        let expected_client = current_process_identity().unwrap();
        let server_name = logical_name.clone();
        let (ready_sender, ready_receiver) = mpsc::sync_channel(1);
        let server = thread::spawn(move || {
            let server =
                WindowsNamedPipeServer::bind_for_client(&server_name, expected_client).unwrap();
            ready_sender.send(()).unwrap();
            server.accept_one_with_pre_read_guard(|| false).map(|_| ())
        });
        ready_receiver.recv_timeout(Duration::from_secs(1)).unwrap();

        let event = test_event();
        assert!(NamedPipeEventSink::new(&logical_name)
            .unwrap()
            .enqueue(&event)
            .is_err());
        assert_eq!(
            server.join().unwrap(),
            Err(NamedPipeServerError::PreReadRejected)
        );
    }

    #[test]
    fn pre_read_guard_is_ordered_between_identity_and_payload_allocation() {
        let source = include_str!("windows_named_pipe_server.rs");
        let method_start = source
            .find("pub fn accept_one_with_pre_read_guard")
            .unwrap();
        let method = &source[method_start
            ..source[method_start..]
                .find("\n    }\n}\n\npub struct ReceivedPipeEvent")
                .map(|offset| method_start + offset)
                .unwrap()];
        let identity = method.find("validate_connected_client").unwrap();
        let guard = method.find("if !authorize_read()").unwrap();
        let payload = method.find("let mut payload").unwrap();
        assert!(identity < guard);
        assert!(guard < payload);
    }

    #[test]
    fn process_identity_is_stable_and_contains_pid_reuse_evidence() {
        let first = current_process_identity().unwrap();
        let second = current_process_identity().unwrap();
        assert_eq!(first, second);
        assert_eq!(first.process_id, std::process::id());
        assert_ne!(first.creation_time_100ns, 0);
    }

    #[test]
    fn exited_process_handle_is_not_accepted_as_a_live_identity() {
        let mut child = Command::new("cmd.exe")
            .args(["/D", "/C", "exit 0"])
            .spawn()
            .unwrap();
        let process_id = child.id();
        assert!(child.wait().unwrap().success());

        assert_eq!(
            process_identity_from_handle(process_id, child.as_raw_handle()),
            Err(NamedPipeServerError::ClientIdentity)
        );
    }

    #[test]
    fn client_identity_observation_matrix_is_fail_closed() {
        let expected = current_process_identity().unwrap();
        assert_eq!(
            validate_client_identity_observations(
                expected,
                expected.process_id,
                expected,
                expected.process_id,
            ),
            Ok(())
        );

        let other_process_id = expected.process_id.wrapping_add(1).max(1);
        let other_creation = WindowsProcessIdentity {
            creation_time_100ns: expected.creation_time_100ns.wrapping_add(1).max(1),
            ..expected
        };
        let rejected = [
            (0, expected, expected.process_id),
            (expected.process_id, expected, 0),
            (other_process_id, expected, expected.process_id),
            (expected.process_id, other_creation, expected.process_id),
            (expected.process_id, expected, other_process_id),
        ];
        for (before, actual, after) in rejected {
            assert_eq!(
                validate_client_identity_observations(expected, before, actual, after),
                Err(NamedPipeServerError::ClientIdentity)
            );
        }
    }

    #[test]
    fn direct_parent_identity_is_queryable_and_distinct_from_the_current_process() {
        let current = current_process_identity().unwrap();
        let parent = current_parent_process_identity().unwrap();
        assert_ne!(parent.process_id, current.process_id);
        assert_ne!(parent.creation_time_100ns, 0);
    }

    #[test]
    fn exact_client_process_identity_can_exchange_a_bounded_response() {
        let logical_name = format!("yuanyuan.identity-test.{}", std::process::id());
        let server_name = logical_name.clone();
        let expected = current_process_identity().unwrap();
        let (ready_sender, ready_receiver) = mpsc::sync_channel(1);
        let server = thread::spawn(move || {
            let server = WindowsNamedPipeServer::bind_for_client(&server_name, expected).unwrap();
            ready_sender.send(()).unwrap();
            let received = server.accept_one().unwrap();
            assert_eq!(received.payload(), b"bounded-request");
            received.respond_bounded(b"bounded-response", 64).unwrap();
        });
        ready_receiver.recv_timeout(Duration::from_secs(1)).unwrap();

        let response = NamedPipeEventSink::new(&logical_name)
            .unwrap()
            .send_validated_payload_and_receive_response(b"bounded-request", 64)
            .unwrap();
        assert_eq!(response, b"bounded-response");
        server.join().unwrap();
    }

    #[test]
    fn wrong_pid_or_creation_time_is_rejected_before_payload_read() {
        let actual = current_process_identity().unwrap();
        let wrong = [
            WindowsProcessIdentity {
                process_id: actual.process_id.wrapping_add(1).max(1),
                ..actual
            },
            WindowsProcessIdentity {
                creation_time_100ns: actual.creation_time_100ns.wrapping_add(1).max(1),
                ..actual
            },
        ];
        for (index, expected) in wrong.into_iter().enumerate() {
            let logical_name = format!("yuanyuan.identity-reject.{index}.{}", std::process::id());
            let server_name = logical_name.clone();
            let (ready_sender, ready_receiver) = mpsc::sync_channel(1);
            let server = thread::spawn(move || {
                let server =
                    WindowsNamedPipeServer::bind_for_client(&server_name, expected).unwrap();
                ready_sender.send(()).unwrap();
                server.accept_one().map(|_| ())
            });
            ready_receiver.recv_timeout(Duration::from_secs(1)).unwrap();

            let result = NamedPipeEventSink::new(&logical_name)
                .unwrap()
                .send_validated_payload_and_receive_response(b"must-not-be-read", 64);
            assert!(result.is_err());
            assert_eq!(
                server.join().unwrap(),
                Err(NamedPipeServerError::ClientIdentity)
            );
        }
    }

    #[test]
    fn response_limits_fail_before_writing() {
        let logical_name = format!("yuanyuan.response-limit.{}", std::process::id());
        let server_name = logical_name.clone();
        let expected = current_process_identity().unwrap();
        let (ready_sender, ready_receiver) = mpsc::sync_channel(1);
        let server = thread::spawn(move || {
            let server = WindowsNamedPipeServer::bind_for_client(&server_name, expected).unwrap();
            ready_sender.send(()).unwrap();
            let received = server.accept_one().unwrap();
            received.respond_bounded(b"too-large", 4)
        });
        ready_receiver.recv_timeout(Duration::from_secs(1)).unwrap();

        let result = NamedPipeEventSink::new(&logical_name)
            .unwrap()
            .send_validated_payload_and_receive_response(b"request", 64);
        assert!(result.is_err());
        assert_eq!(
            server.join().unwrap(),
            Err(NamedPipeServerError::ResponseTooLarge)
        );
    }

    fn test_event() -> TaskEventEnvelope {
        TaskEventEnvelope {
            protocol_version: TASK_EVENT_PROTOCOL_VERSION,
            event: TaskEventV1 {
                event_id: "evt-secure-pipe".into(),
                connector_id: "connector-secure-pipe".into(),
                source_instance: "codex-install-1".into(),
                task_id: "task-secure-pipe".into(),
                run_id: "run-secure-pipe".into(),
                parent_task_id: None,
                source: "openai.codex".into(),
                external_id: "thread-secure-pipe".into(),
                title: "Secure pipe round trip".into(),
                workspace: Some("yuanyuan-reminder".into()),
                state: TaskState::Running,
                progress: None,
                summary: None,
                attention_reason: None,
                evidence_type: EvidenceType::Hook,
                evidence_level: EvidenceLevel::Authoritative,
                sequence: 1,
                occurred_at: "2026-08-04T00:00:00Z".into(),
                received_at: "2026-08-04T00:00:00Z".into(),
                started_at: None,
                updated_at: "2026-08-04T00:00:00Z".into(),
                completed_at: None,
                finality: EventFinality::Provisional,
                return_action: None,
                payload_digest: "sha256:0123456789abcdef".into(),
                raw_payload_ref: None,
            },
        }
    }
}
