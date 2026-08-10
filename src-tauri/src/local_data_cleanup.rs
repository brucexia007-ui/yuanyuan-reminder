use std::{
    fs::{self, File, OpenOptions},
    io::{ErrorKind, Read, Write},
    os::windows::{fs::MetadataExt, process::CommandExt},
    path::{Path, PathBuf},
    process::Command,
    thread,
    time::{Duration, Instant},
};

use chrono::Utc;
use serde::{Deserialize, Serialize};
use uuid::Uuid;
use windows_sys::Win32::{
    Foundation::{CloseHandle, GetLastError, ERROR_INVALID_PARAMETER, WAIT_FAILED, WAIT_OBJECT_0},
    Storage::FileSystem::{FILE_ATTRIBUTE_DIRECTORY, FILE_ATTRIBUTE_REPARSE_POINT},
    System::Threading::{OpenProcess, WaitForSingleObject, CREATE_NO_WINDOW, PROCESS_SYNCHRONIZE},
};

use crate::error::{AppError, AppResult};

pub const DELETE_ALL_LOCAL_DATA_CONFIRMATION: &str = "删除圆圆全部本地数据";

const APPLICATION_IDENTIFIER: &str = "com.yuanyuan.reminder";
const CLEANUP_MODE: &str = "delete-all-local-data-after-exit";
const CLEANUP_MODE_ARG: &str = "--yuanyuan-delete-all-local-data-after-exit";
const PARENT_PID_ARG: &str = "--yuanyuan-cleanup-parent-pid=";
const REQUEST_NONCE_ARG: &str = "--yuanyuan-cleanup-request-nonce=";
const MARKER_FILE_NAME: &str = ".com.yuanyuan.reminder.delete-all-local-data.json";
const MARKER_MAX_BYTES: u64 = 4 * 1024;
const PARENT_WAIT_MILLIS: u32 = 60_000;
const DELETE_RETRY_WINDOW: Duration = Duration::from_secs(30);
const DELETE_RETRY_INTERVAL: Duration = Duration::from_millis(250);

#[derive(Debug, Clone, PartialEq, Eq)]
struct CleanupArguments {
    parent_pid: u32,
    request_nonce: Uuid,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct CleanupMarker {
    schema_version: u32,
    mode: String,
    application_identifier: String,
    parent_pid: u32,
    request_nonce: Uuid,
    requested_at: String,
}

pub fn validate_delete_request(confirmation: &str, understands_no_recovery: bool) -> AppResult<()> {
    if confirmation != DELETE_ALL_LOCAL_DATA_CONFIRMATION {
        return Err(AppError::Validation(
            "the local data deletion confirmation phrase does not match".into(),
        ));
    }
    if !understands_no_recovery {
        return Err(AppError::Validation(
            "local data deletion requires the no-recovery acknowledgement".into(),
        ));
    }
    Ok(())
}

pub fn schedule_after_exit(identifier: &str) -> AppResult<()> {
    let base = local_data_base()?;
    let root = owned_data_root(&base, identifier)?;
    ensure_root_is_safe(&base, &root)?;

    let request_nonce = Uuid::new_v4();
    let marker = CleanupMarker {
        schema_version: 1,
        mode: CLEANUP_MODE.into(),
        application_identifier: APPLICATION_IDENTIFIER.into(),
        parent_pid: std::process::id(),
        request_nonce,
        requested_at: Utc::now().to_rfc3339(),
    };
    let marker_path = marker_path(&base);
    write_marker_atomically(&base, &marker_path, &marker)?;

    let executable = std::env::current_exe()?;
    let spawn_result = Command::new(executable)
        .arg(CLEANUP_MODE_ARG)
        .arg(format!("{PARENT_PID_ARG}{}", marker.parent_pid))
        .arg(format!("{REQUEST_NONCE_ARG}{}", marker.request_nonce))
        .creation_flags(CREATE_NO_WINDOW)
        .spawn();

    if let Err(error) = spawn_result {
        let _ = fs::remove_file(&marker_path);
        return Err(error.into());
    }

    Ok(())
}

/// Handles the dedicated cleanup process, or retries a pending cleanup before
/// any database or log handles are opened. `true` means this process must exit.
pub fn handle_startup(identifier: &str) -> AppResult<bool> {
    let base = local_data_base()?;
    let root = owned_data_root(&base, identifier)?;
    let supplied_arguments = parse_cleanup_arguments(std::env::args().skip(1))?;
    let marker_path = marker_path(&base);
    let marker_exists = path_exists_without_following(&marker_path)?;

    if supplied_arguments.is_none() && !marker_exists {
        return Ok(false);
    }
    if !marker_exists {
        return Err(AppError::Validation(
            "the local data cleanup marker is missing".into(),
        ));
    }

    let marker = read_and_validate_marker(&marker_path)?;
    if let Some(arguments) = supplied_arguments {
        validate_supplied_arguments(&marker, &arguments)?;
    }

    wait_for_parent(marker.parent_pid)?;
    delete_owned_root_with_retry(&base, &root)?;
    match fs::remove_file(&marker_path) {
        Ok(()) => {}
        Err(error) if error.kind() == ErrorKind::NotFound => {}
        Err(error) => return Err(error.into()),
    }
    Ok(true)
}

fn local_data_base() -> AppResult<PathBuf> {
    dirs::data_local_dir()
        .ok_or_else(|| AppError::Window("local app data directory is unavailable".into()))
}

fn owned_data_root(base: &Path, identifier: &str) -> AppResult<PathBuf> {
    if identifier != APPLICATION_IDENTIFIER {
        return Err(AppError::Validation(
            "local data cleanup is restricted to the production application identifier".into(),
        ));
    }
    Ok(base.join(APPLICATION_IDENTIFIER))
}

fn marker_path(base: &Path) -> PathBuf {
    base.join(MARKER_FILE_NAME)
}

fn write_marker_atomically(
    base: &Path,
    marker_path: &Path,
    marker: &CleanupMarker,
) -> AppResult<()> {
    if path_exists_without_following(marker_path)? {
        return Err(AppError::Validation(
            "a local data cleanup request is already pending".into(),
        ));
    }

    let temporary_path = base.join(format!("{MARKER_FILE_NAME}.{}.tmp", marker.request_nonce));
    let result = (|| -> AppResult<()> {
        let mut file = OpenOptions::new()
            .create_new(true)
            .write(true)
            .open(&temporary_path)?;
        serde_json::to_writer(&mut file, marker)?;
        file.write_all(b"\n")?;
        file.sync_all()?;
        fs::rename(&temporary_path, marker_path)?;
        Ok(())
    })();
    if result.is_err() {
        let _ = fs::remove_file(&temporary_path);
    }
    result
}

fn read_and_validate_marker(path: &Path) -> AppResult<CleanupMarker> {
    let metadata = fs::symlink_metadata(path)?;
    if is_reparse_point(&metadata) || !metadata.is_file() || metadata.len() > MARKER_MAX_BYTES {
        return Err(AppError::Validation(
            "the local data cleanup marker is not a safe regular file".into(),
        ));
    }
    let mut bytes = Vec::with_capacity(metadata.len() as usize);
    File::open(path)?
        .take(MARKER_MAX_BYTES + 1)
        .read_to_end(&mut bytes)?;
    if bytes.len() as u64 > MARKER_MAX_BYTES {
        return Err(AppError::Validation(
            "the local data cleanup marker is too large".into(),
        ));
    }
    let marker: CleanupMarker = serde_json::from_slice(&bytes)?;
    validate_marker(&marker)?;
    Ok(marker)
}

fn validate_marker(marker: &CleanupMarker) -> AppResult<()> {
    if marker.schema_version != 1
        || marker.mode != CLEANUP_MODE
        || marker.application_identifier != APPLICATION_IDENTIFIER
        || marker.parent_pid == 0
        || marker.request_nonce.is_nil()
        || chrono::DateTime::parse_from_rfc3339(&marker.requested_at).is_err()
    {
        return Err(AppError::Validation(
            "the local data cleanup marker is invalid".into(),
        ));
    }
    Ok(())
}

fn validate_supplied_arguments(
    marker: &CleanupMarker,
    arguments: &CleanupArguments,
) -> AppResult<()> {
    if arguments.parent_pid != marker.parent_pid || arguments.request_nonce != marker.request_nonce
    {
        return Err(AppError::Validation(
            "the local data cleanup request does not match its marker".into(),
        ));
    }
    Ok(())
}

fn parse_cleanup_arguments(
    arguments: impl IntoIterator<Item = String>,
) -> AppResult<Option<CleanupArguments>> {
    let mut cleanup_mode = false;
    let mut parent_pid = None;
    let mut request_nonce = None;
    let mut cleanup_argument_seen = false;

    for argument in arguments {
        if argument == CLEANUP_MODE_ARG {
            if cleanup_mode {
                return Err(AppError::Validation(
                    "the local data cleanup mode argument is duplicated".into(),
                ));
            }
            cleanup_mode = true;
            cleanup_argument_seen = true;
        } else if let Some(value) = argument.strip_prefix(PARENT_PID_ARG) {
            if parent_pid.is_some() {
                return Err(AppError::Validation(
                    "the local data cleanup parent process argument is duplicated".into(),
                ));
            }
            parent_pid = Some(value.parse::<u32>().map_err(|_| {
                AppError::Validation("the local data cleanup parent process is invalid".into())
            })?);
            cleanup_argument_seen = true;
        } else if let Some(value) = argument.strip_prefix(REQUEST_NONCE_ARG) {
            if request_nonce.is_some() {
                return Err(AppError::Validation(
                    "the local data cleanup nonce argument is duplicated".into(),
                ));
            }
            request_nonce = Some(Uuid::parse_str(value).map_err(|_| {
                AppError::Validation("the local data cleanup nonce is invalid".into())
            })?);
            cleanup_argument_seen = true;
        }
    }

    if !cleanup_argument_seen {
        return Ok(None);
    }
    if !cleanup_mode {
        return Err(AppError::Validation(
            "local data cleanup details were supplied without cleanup mode".into(),
        ));
    }
    let parent_pid = parent_pid.ok_or_else(|| {
        AppError::Validation("the local data cleanup parent process is missing".into())
    })?;
    if parent_pid == 0 {
        return Err(AppError::Validation(
            "the local data cleanup parent process is invalid".into(),
        ));
    }
    let request_nonce = request_nonce
        .ok_or_else(|| AppError::Validation("the local data cleanup nonce is missing".into()))?;
    Ok(Some(CleanupArguments {
        parent_pid,
        request_nonce,
    }))
}

fn wait_for_parent(parent_pid: u32) -> AppResult<()> {
    if parent_pid == std::process::id() {
        return Ok(());
    }

    let handle = unsafe { OpenProcess(PROCESS_SYNCHRONIZE, 0, parent_pid) };
    if handle.is_null() {
        let error_code = unsafe { GetLastError() };
        if error_code == ERROR_INVALID_PARAMETER {
            return Ok(());
        }
        return Err(std::io::Error::from_raw_os_error(error_code as i32).into());
    }

    let wait_result = unsafe { WaitForSingleObject(handle, PARENT_WAIT_MILLIS) };
    let wait_error = if wait_result == WAIT_FAILED {
        Some(unsafe { GetLastError() })
    } else {
        None
    };
    unsafe {
        CloseHandle(handle);
    }

    if wait_result == WAIT_OBJECT_0 {
        Ok(())
    } else if let Some(error_code) = wait_error {
        Err(std::io::Error::from_raw_os_error(error_code as i32).into())
    } else {
        Err(std::io::Error::new(
            ErrorKind::TimedOut,
            "the parent application did not exit before local data cleanup",
        )
        .into())
    }
}

fn delete_owned_root_with_retry(base: &Path, root: &Path) -> AppResult<()> {
    let deadline = Instant::now() + DELETE_RETRY_WINDOW;
    loop {
        match delete_owned_root_once(base, root) {
            Ok(()) => return Ok(()),
            Err(error) if Instant::now() < deadline => {
                let _ = error;
                thread::sleep(DELETE_RETRY_INTERVAL);
            }
            Err(error) => return Err(error),
        }
    }
}

fn delete_owned_root_once(base: &Path, root: &Path) -> AppResult<()> {
    let expected = base.join(APPLICATION_IDENTIFIER);
    if root != expected {
        return Err(AppError::Validation(
            "local data cleanup refused a path outside the owned data root".into(),
        ));
    }
    match fs::symlink_metadata(root) {
        Ok(metadata) => {
            if is_reparse_point(&metadata) || !metadata.is_dir() {
                return Err(AppError::Validation(
                    "the owned local data root is not a safe directory".into(),
                ));
            }
        }
        Err(error) if error.kind() == ErrorKind::NotFound => return Ok(()),
        Err(error) => return Err(error.into()),
    }
    remove_tree_without_following_reparse_points(root)?;
    Ok(())
}

fn ensure_root_is_safe(base: &Path, root: &Path) -> AppResult<()> {
    if root != base.join(APPLICATION_IDENTIFIER) {
        return Err(AppError::Validation(
            "local data cleanup refused a path outside the owned data root".into(),
        ));
    }
    let metadata = fs::symlink_metadata(root)?;
    if is_reparse_point(&metadata) || !metadata.is_dir() {
        return Err(AppError::Validation(
            "the owned local data root is not a safe directory".into(),
        ));
    }
    Ok(())
}

fn remove_tree_without_following_reparse_points(path: &Path) -> AppResult<()> {
    let metadata = fs::symlink_metadata(path)?;
    if is_reparse_point(&metadata) {
        if metadata.file_attributes() & FILE_ATTRIBUTE_DIRECTORY != 0 {
            fs::remove_dir(path)?;
        } else {
            fs::remove_file(path)?;
        }
        return Ok(());
    }
    if metadata.is_dir() {
        for entry in fs::read_dir(path)? {
            remove_tree_without_following_reparse_points(&entry?.path())?;
        }
        fs::remove_dir(path)?;
    } else {
        make_writable_if_needed(path, &metadata)?;
        fs::remove_file(path)?;
    }
    Ok(())
}

fn make_writable_if_needed(path: &Path, metadata: &fs::Metadata) -> AppResult<()> {
    let mut permissions = metadata.permissions();
    if permissions.readonly() {
        permissions.set_readonly(false);
        fs::set_permissions(path, permissions)?;
    }
    Ok(())
}

fn is_reparse_point(metadata: &fs::Metadata) -> bool {
    metadata.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT != 0
}

fn path_exists_without_following(path: &Path) -> AppResult<bool> {
    match fs::symlink_metadata(path) {
        Ok(_) => Ok(true),
        Err(error) if error.kind() == ErrorKind::NotFound => Ok(false),
        Err(error) => Err(error.into()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn deletion_confirmation_requires_exact_phrase_and_acknowledgement() {
        assert!(validate_delete_request(DELETE_ALL_LOCAL_DATA_CONFIRMATION, true).is_ok());
        assert!(validate_delete_request(" 删除圆圆全部本地数据", true).is_err());
        assert!(validate_delete_request("删除圆圆全部本地资料", true).is_err());
        assert!(validate_delete_request(DELETE_ALL_LOCAL_DATA_CONFIRMATION, false).is_err());
    }

    #[test]
    fn cleanup_arguments_require_a_complete_exact_request() {
        let nonce = Uuid::new_v4();
        let parsed = parse_cleanup_arguments([
            CLEANUP_MODE_ARG.to_owned(),
            format!("{PARENT_PID_ARG}42"),
            format!("{REQUEST_NONCE_ARG}{nonce}"),
        ])
        .unwrap();
        assert_eq!(
            parsed,
            Some(CleanupArguments {
                parent_pid: 42,
                request_nonce: nonce,
            })
        );
        assert!(parse_cleanup_arguments([CLEANUP_MODE_ARG.to_owned()]).is_err());
        assert!(parse_cleanup_arguments([format!("{PARENT_PID_ARG}42")]).is_err());
        assert!(parse_cleanup_arguments(Vec::<String>::new())
            .unwrap()
            .is_none());
    }

    #[test]
    fn marker_schema_is_strict_and_identity_bound() {
        let marker = CleanupMarker {
            schema_version: 1,
            mode: CLEANUP_MODE.into(),
            application_identifier: APPLICATION_IDENTIFIER.into(),
            parent_pid: 42,
            request_nonce: Uuid::new_v4(),
            requested_at: "2026-08-11T00:00:00Z".into(),
        };
        assert!(validate_marker(&marker).is_ok());

        let mut value = serde_json::to_value(&marker).unwrap();
        value["unexpectedField"] = serde_json::json!(true);
        assert!(serde_json::from_value::<CleanupMarker>(value).is_err());

        let mismatched_arguments = CleanupArguments {
            parent_pid: marker.parent_pid,
            request_nonce: Uuid::new_v4(),
        };
        assert!(validate_supplied_arguments(&marker, &mismatched_arguments).is_err());

        let mut wrong_identity = marker;
        wrong_identity.application_identifier = "com.example.other".into();
        assert!(validate_marker(&wrong_identity).is_err());
    }

    #[test]
    fn deletion_removes_only_the_exact_owned_root() {
        let temporary = tempfile::tempdir().unwrap();
        let base = temporary.path();
        let root = owned_data_root(base, APPLICATION_IDENTIFIER).unwrap();
        let sibling = base.join("keep-me");
        fs::create_dir_all(root.join("backups")).unwrap();
        fs::write(root.join("yuanyuan-reminder.sqlite3"), b"synthetic").unwrap();
        fs::write(root.join("backups").join("backup.sqlite3"), b"synthetic").unwrap();
        fs::write(&sibling, b"unrelated").unwrap();

        delete_owned_root_once(base, &root).unwrap();

        assert!(!root.exists());
        assert_eq!(fs::read(sibling).unwrap(), b"unrelated");
        assert!(delete_owned_root_once(base, &base.join("other")).is_err());
    }
}
