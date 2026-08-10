#![cfg(windows)]

use std::{
    collections::HashMap,
    fs::{File, OpenOptions},
    io::{Read, Write},
    os::windows::{ffi::OsStrExt, io::AsRawHandle},
    path::{Path, PathBuf},
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};

use parking_lot::Mutex;
use serde::Serialize;
use sha2::{Digest, Sha256};
use uuid::Uuid;
use windows_sys::Win32::{
    Foundation::HANDLE,
    Storage::FileSystem::{
        GetFileInformationByHandle, MoveFileExW, ReplaceFileW, BY_HANDLE_FILE_INFORMATION,
        MOVEFILE_WRITE_THROUGH, REPLACEFILE_WRITE_THROUGH,
    },
};
use yuanyuan_bridge::apply_current_user_only_dacl;
use yuanyuan_connectors::{
    config_edit::{
        prepare_lossless_hook_config_addition, prepare_lossless_hook_config_removal,
        PreparedHookConfigEdit,
    },
    config_preview::{HookConfigFormat, OwnedCommandHookSpec, MAX_HOOK_CONFIG_BYTES},
};

const CONFIRMATION_LIFETIME: Duration = Duration::from_secs(2 * 60);
const MAX_PENDING_WRITES: usize = 16;
const FILE_ATTRIBUTE_REPARSE_POINT: u32 = 0x0000_0400;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct FileIdentity {
    volume_serial: u32,
    file_index: u64,
}

#[derive(Debug)]
pub(crate) enum FileSnapshot {
    Missing,
    Existing {
        bytes: Vec<u8>,
        identity: FileIdentity,
    },
}

impl FileSnapshot {
    pub(crate) fn exists(&self) -> bool {
        matches!(self, Self::Existing { .. })
    }

    pub(crate) fn digest(&self) -> [u8; 32] {
        match self {
            Self::Missing => Sha256::digest([]).into(),
            Self::Existing { bytes, .. } => Sha256::digest(bytes).into(),
        }
    }

    pub(crate) fn bytes(&self) -> &[u8] {
        match self {
            Self::Missing => &[],
            Self::Existing { bytes, .. } => bytes,
        }
    }

    pub(crate) fn identity(&self) -> Option<FileIdentity> {
        match self {
            Self::Missing => None,
            Self::Existing { identity, .. } => Some(*identity),
        }
    }
}

struct PendingWrite {
    target: PathBuf,
    format: HookConfigFormat,
    action: HookConfigEditAction,
    expected: Vec<OwnedCommandHookSpec>,
    target_existed: bool,
    original_sha256: [u8; 32],
    original_identity: Option<FileIdentity>,
    output_sha256: [u8; 32],
    added_handlers: usize,
    removed_handlers: usize,
    expires_at: Instant,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum HookConfigEditAction {
    Add,
    Remove,
}

#[derive(Default)]
pub(crate) struct HookConfigWriteCoordinator {
    pending: Mutex<HashMap<String, PendingWrite>>,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct HookConfigWritePreview {
    pub confirmation_token: Option<String>,
    pub expires_in_seconds: u64,
    pub target_existed: bool,
    pub added_handlers: usize,
    pub removed_handlers: usize,
    pub backup_required: bool,
    pub lossless_edit_prepared: bool,
    pub config_write_performed: bool,
    pub hook_configuration_changed: bool,
    pub source_task_behavior_changed: bool,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct HookConfigWriteResult {
    pub added_handlers: usize,
    pub removed_handlers: usize,
    pub backup_created: bool,
    pub config_write_performed: bool,
    pub hook_configuration_changed: bool,
    pub source_task_behavior_changed: bool,
}

#[derive(Debug, thiserror::Error, Clone, Copy, PartialEq, Eq)]
pub(crate) enum HookConfigWriteError {
    #[error("hook configuration target is not supported")]
    InvalidTarget,
    #[error("hook configuration path is unsafe")]
    UnsafePath,
    #[error("hook configuration cannot be edited safely")]
    ManualReviewRequired,
    #[error("too many hook configuration changes are awaiting confirmation")]
    ConfirmationCapacityReached,
    #[error("hook configuration confirmation is invalid or expired")]
    InvalidConfirmation,
    #[error("hook configuration changed after preview")]
    ConfigurationChanged,
    #[error("hook configuration backup could not be created safely")]
    BackupFailed,
    #[error("hook configuration atomic replacement failed")]
    AtomicReplaceFailed,
    #[error("hook configuration validation failed and the original was restored")]
    ValidationFailedRolledBack,
    #[error("hook configuration recovery requires manual attention")]
    RollbackFailed,
}

impl HookConfigWriteCoordinator {
    pub(crate) fn preview_addition(
        &self,
        format: HookConfigFormat,
        target: PathBuf,
        expected: Vec<OwnedCommandHookSpec>,
    ) -> Result<HookConfigWritePreview, HookConfigWriteError> {
        self.preview_edit_at(
            HookConfigEditAction::Add,
            format,
            target,
            expected,
            Instant::now(),
        )
    }

    pub(crate) fn preview_removal(
        &self,
        format: HookConfigFormat,
        target: PathBuf,
        expected: Vec<OwnedCommandHookSpec>,
    ) -> Result<HookConfigWritePreview, HookConfigWriteError> {
        self.preview_edit_at(
            HookConfigEditAction::Remove,
            format,
            target,
            expected,
            Instant::now(),
        )
    }

    fn preview_edit_at(
        &self,
        action: HookConfigEditAction,
        format: HookConfigFormat,
        target: PathBuf,
        expected: Vec<OwnedCommandHookSpec>,
        now: Instant,
    ) -> Result<HookConfigWritePreview, HookConfigWriteError> {
        validate_target(format, &target)?;
        let snapshot = read_snapshot(&target)?;
        let edit = prepare_edit(action, format, snapshot.bytes(), &expected)?;
        if edit.added_handlers == 0 && edit.removed_handlers == 0 {
            return Ok(HookConfigWritePreview {
                confirmation_token: None,
                expires_in_seconds: 0,
                target_existed: snapshot.exists(),
                added_handlers: 0,
                removed_handlers: 0,
                backup_required: false,
                lossless_edit_prepared: true,
                config_write_performed: false,
                hook_configuration_changed: false,
                source_task_behavior_changed: false,
            });
        }

        let mut pending = self.pending.lock();
        pending.retain(|_, item| item.expires_at > now);
        if pending.len() >= MAX_PENDING_WRITES {
            return Err(HookConfigWriteError::ConfirmationCapacityReached);
        }
        let token = Uuid::new_v4().to_string();
        pending.insert(
            token.clone(),
            PendingWrite {
                target,
                format,
                action,
                expected,
                target_existed: snapshot.exists(),
                original_sha256: snapshot.digest(),
                original_identity: snapshot.identity(),
                output_sha256: edit.output_sha256,
                added_handlers: edit.added_handlers,
                removed_handlers: edit.removed_handlers,
                expires_at: now + CONFIRMATION_LIFETIME,
            },
        );
        Ok(HookConfigWritePreview {
            confirmation_token: Some(token),
            expires_in_seconds: CONFIRMATION_LIFETIME.as_secs(),
            target_existed: snapshot.exists(),
            added_handlers: edit.added_handlers,
            removed_handlers: edit.removed_handlers,
            backup_required: snapshot.exists(),
            lossless_edit_prepared: true,
            config_write_performed: false,
            hook_configuration_changed: false,
            source_task_behavior_changed: false,
        })
    }

    pub(crate) fn apply(
        &self,
        confirmation_token: &str,
    ) -> Result<HookConfigWriteResult, HookConfigWriteError> {
        self.apply_at(confirmation_token, Instant::now(), SystemTime::now())
    }

    pub(crate) fn discard_confirmation(&self, confirmation_token: &str) {
        self.pending.lock().remove(confirmation_token);
    }

    fn apply_at(
        &self,
        confirmation_token: &str,
        now: Instant,
        wall_clock: SystemTime,
    ) -> Result<HookConfigWriteResult, HookConfigWriteError> {
        if Uuid::parse_str(confirmation_token).is_err() {
            return Err(HookConfigWriteError::InvalidConfirmation);
        }
        let pending = self
            .pending
            .lock()
            .remove(confirmation_token)
            .filter(|item| item.expires_at > now)
            .ok_or(HookConfigWriteError::InvalidConfirmation)?;
        validate_target(pending.format, &pending.target)?;
        let current = read_snapshot(&pending.target)?;
        if current.exists() != pending.target_existed
            || current.digest() != pending.original_sha256
            || current.identity() != pending.original_identity
        {
            return Err(HookConfigWriteError::ConfigurationChanged);
        }
        let edit = prepare_edit(
            pending.action,
            pending.format,
            current.bytes(),
            &pending.expected,
        )
        .map_err(|_| HookConfigWriteError::ConfigurationChanged)?;
        if edit.output_sha256 != pending.output_sha256
            || edit.added_handlers != pending.added_handlers
            || edit.removed_handlers != pending.removed_handlers
        {
            return Err(HookConfigWriteError::ConfigurationChanged);
        }
        atomic_replace(
            &pending.target,
            &current,
            &edit.output,
            edit.output_sha256,
            wall_clock,
        )?;
        Ok(HookConfigWriteResult {
            added_handlers: edit.added_handlers,
            removed_handlers: edit.removed_handlers,
            backup_created: current.exists(),
            config_write_performed: true,
            hook_configuration_changed: true,
            source_task_behavior_changed: false,
        })
    }
}

fn prepare_edit(
    action: HookConfigEditAction,
    format: HookConfigFormat,
    input: &[u8],
    expected: &[OwnedCommandHookSpec],
) -> Result<PreparedHookConfigEdit, HookConfigWriteError> {
    match action {
        HookConfigEditAction::Add => prepare_lossless_hook_config_addition(format, input, expected),
        HookConfigEditAction::Remove => {
            prepare_lossless_hook_config_removal(format, input, expected)
        }
    }
    .map_err(|_| HookConfigWriteError::ManualReviewRequired)
}

fn validate_target(format: HookConfigFormat, target: &Path) -> Result<(), HookConfigWriteError> {
    if !target.is_absolute() {
        return Err(HookConfigWriteError::InvalidTarget);
    }
    let expected_name = match format {
        HookConfigFormat::CodexHooksJson => "hooks.json",
        HookConfigFormat::ClaudeSettingsJson => "settings.json",
        HookConfigFormat::CodexConfigToml => return Err(HookConfigWriteError::InvalidTarget),
    };
    if target.file_name().and_then(|name| name.to_str()) != Some(expected_name) {
        return Err(HookConfigWriteError::InvalidTarget);
    }
    let parent = target.parent().ok_or(HookConfigWriteError::UnsafePath)?;
    if !ordinary_directory(parent) {
        return Err(HookConfigWriteError::UnsafePath);
    }
    Ok(())
}

pub(crate) fn ordinary_directory(path: &Path) -> bool {
    use std::os::windows::fs::MetadataExt;

    std::fs::symlink_metadata(path).is_ok_and(|metadata| {
        metadata.is_dir() && metadata.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT == 0
    })
}

pub(crate) fn read_snapshot(path: &Path) -> Result<FileSnapshot, HookConfigWriteError> {
    use std::os::windows::fs::MetadataExt;

    match std::fs::symlink_metadata(path) {
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(FileSnapshot::Missing),
        Err(_) => Err(HookConfigWriteError::UnsafePath),
        Ok(metadata)
            if metadata.is_file()
                && metadata.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT == 0
                && metadata.len() <= MAX_HOOK_CONFIG_BYTES as u64 =>
        {
            let file = File::open(path).map_err(|_| HookConfigWriteError::UnsafePath)?;
            let identity = file_identity(&file)?;
            let mut bytes = Vec::with_capacity(metadata.len() as usize);
            file.take((MAX_HOOK_CONFIG_BYTES + 1) as u64)
                .read_to_end(&mut bytes)
                .map_err(|_| HookConfigWriteError::UnsafePath)?;
            if bytes.len() > MAX_HOOK_CONFIG_BYTES {
                return Err(HookConfigWriteError::UnsafePath);
            }
            Ok(FileSnapshot::Existing { bytes, identity })
        }
        Ok(_) => Err(HookConfigWriteError::UnsafePath),
    }
}

fn file_identity(file: &File) -> Result<FileIdentity, HookConfigWriteError> {
    let mut information = BY_HANDLE_FILE_INFORMATION {
        dwFileAttributes: 0,
        ftCreationTime: Default::default(),
        ftLastAccessTime: Default::default(),
        ftLastWriteTime: Default::default(),
        dwVolumeSerialNumber: 0,
        nFileSizeHigh: 0,
        nFileSizeLow: 0,
        nNumberOfLinks: 0,
        nFileIndexHigh: 0,
        nFileIndexLow: 0,
    };
    // SAFETY: the handle is owned by the live File and the output pointer
    // remains valid for the duration of the call.
    let ok = unsafe {
        GetFileInformationByHandle(
            file.as_raw_handle() as HANDLE,
            std::ptr::addr_of_mut!(information),
        )
    };
    if ok == 0 {
        return Err(HookConfigWriteError::UnsafePath);
    }
    // The path-level metadata check happens before opening the file. Recheck
    // the opened handle so a path swap cannot turn the target into a reparse
    // point between those two operations.
    if information.dwFileAttributes & FILE_ATTRIBUTE_REPARSE_POINT != 0 {
        return Err(HookConfigWriteError::UnsafePath);
    }
    Ok(FileIdentity {
        volume_serial: information.dwVolumeSerialNumber,
        file_index: (u64::from(information.nFileIndexHigh) << 32)
            | u64::from(information.nFileIndexLow),
    })
}

fn atomic_replace(
    target: &Path,
    original: &FileSnapshot,
    output: &[u8],
    expected_output_sha256: [u8; 32],
    wall_clock: SystemTime,
) -> Result<(), HookConfigWriteError> {
    let parent = target.parent().ok_or(HookConfigWriteError::UnsafePath)?;
    let backup_timestamp = if original.exists() {
        Some(
            wall_clock
                .duration_since(UNIX_EPOCH)
                .ok()
                .and_then(|duration| u64::try_from(duration.as_millis()).ok())
                .ok_or(HookConfigWriteError::BackupFailed)?,
        )
    } else {
        None
    };
    let temp = parent.join(format!(".yuanyuan-hook-write-{}.tmp", Uuid::new_v4()));
    let temp_identity =
        write_new_owned_file(&temp, output, HookConfigWriteError::AtomicReplaceFailed)?;
    let backup = if original.exists() {
        let timestamp = backup_timestamp.ok_or(HookConfigWriteError::BackupFailed)?;
        let name = target
            .file_name()
            .and_then(|name| name.to_str())
            .ok_or(HookConfigWriteError::InvalidTarget)?;
        let path = parent.join(format!(
            "{name}.yuanyuan-backup-{timestamp}-{}.bak",
            Uuid::new_v4()
        ));
        match write_new_owned_file(&path, original.bytes(), HookConfigWriteError::BackupFailed) {
            Ok(identity) => Some((path, identity)),
            Err(error) => {
                remove_owned_file(&temp, temp_identity);
                return Err(error);
            }
        }
    } else {
        None
    };

    let unchanged = match read_snapshot(target) {
        Ok(snapshot) => snapshot,
        Err(error) => {
            remove_owned_file(&temp, temp_identity);
            if let Some((backup, identity)) = &backup {
                remove_owned_file(backup, *identity);
            }
            return Err(error);
        }
    };
    if unchanged.exists() != original.exists()
        || unchanged.digest() != original.digest()
        || unchanged.identity() != original.identity()
    {
        remove_owned_file(&temp, temp_identity);
        if let Some((backup, identity)) = &backup {
            remove_owned_file(backup, *identity);
        }
        return Err(HookConfigWriteError::ConfigurationChanged);
    }

    let replaced = if original.exists() {
        replace_existing(target, &temp)
    } else {
        move_new(&temp, target)
    };
    if !replaced {
        remove_owned_file(&temp, temp_identity);
        if let Some((backup, identity)) = &backup {
            remove_owned_file(backup, *identity);
        }
        return Err(HookConfigWriteError::AtomicReplaceFailed);
    }

    let installed = read_snapshot(target);
    let valid = installed.as_ref().is_ok_and(|snapshot| {
        snapshot.digest() == expected_output_sha256 && snapshot.identity() == Some(temp_identity)
    });
    if valid {
        return Ok(());
    }

    if let Some((backup, backup_identity)) = backup {
        let backup_snapshot = read_snapshot(&backup);
        let backup_is_valid = backup_snapshot.as_ref().is_ok_and(|snapshot| {
            snapshot.digest() == original.digest() && snapshot.identity() == Some(backup_identity)
        });
        let installed_is_ours = installed
            .as_ref()
            .is_ok_and(|snapshot| snapshot.identity() == Some(temp_identity));
        if installed_is_ours && backup_is_valid && replace_existing(target, &backup) {
            let restored = read_snapshot(target);
            if restored
                .as_ref()
                .is_ok_and(|snapshot| snapshot.digest() == original.digest())
            {
                return Err(HookConfigWriteError::ValidationFailedRolledBack);
            }
        }
        Err(HookConfigWriteError::RollbackFailed)
    } else if installed
        .as_ref()
        .is_ok_and(|snapshot| snapshot.identity() == Some(temp_identity))
        && std::fs::remove_file(target).is_ok()
    {
        Err(HookConfigWriteError::ValidationFailedRolledBack)
    } else {
        Err(HookConfigWriteError::RollbackFailed)
    }
}

fn write_new_owned_file(
    path: &Path,
    contents: &[u8],
    error: HookConfigWriteError,
) -> Result<FileIdentity, HookConfigWriteError> {
    let mut file = OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(path)
        .map_err(|_| error)?;
    let identity = file_identity(&file).map_err(|_| error)?;
    if let Err(write_error) = file.write_all(contents).and_then(|_| file.sync_all()) {
        drop(file);
        remove_owned_file(path, identity);
        let _ = write_error;
        return Err(error);
    }
    drop(file);
    if apply_current_user_only_dacl(path).is_err() {
        remove_owned_file(path, identity);
        return Err(error);
    }
    let file = File::open(path).map_err(|_| error)?;
    let current = file_identity(&file).map_err(|_| error)?;
    (current == identity).then_some(identity).ok_or(error)
}

fn remove_owned_file(path: &Path, identity: FileIdentity) {
    if File::open(path)
        .ok()
        .and_then(|file| file_identity(&file).ok())
        == Some(identity)
    {
        let _ = std::fs::remove_file(path);
    }
}

fn replace_existing(target: &Path, replacement: &Path) -> bool {
    let target = wide_null(target);
    let replacement = wide_null(replacement);
    // SAFETY: both path buffers are NUL terminated and remain alive for the
    // call. No backup path or exclusion callback is supplied.
    unsafe {
        ReplaceFileW(
            target.as_ptr(),
            replacement.as_ptr(),
            std::ptr::null(),
            REPLACEFILE_WRITE_THROUGH,
            std::ptr::null_mut(),
            std::ptr::null_mut(),
        ) != 0
    }
}

fn move_new(source: &Path, destination: &Path) -> bool {
    let source = wide_null(source);
    let destination = wide_null(destination);
    // SAFETY: both path buffers are NUL terminated and remain alive for the
    // call. MOVEFILE_REPLACE_EXISTING is deliberately omitted.
    unsafe {
        MoveFileExW(
            source.as_ptr(),
            destination.as_ptr(),
            MOVEFILE_WRITE_THROUGH,
        ) != 0
    }
}

fn wide_null(path: &Path) -> Vec<u16> {
    path.as_os_str()
        .encode_wide()
        .chain(std::iter::once(0))
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::os::windows::fs::OpenOptionsExt;
    use windows_sys::Win32::Storage::FileSystem::FILE_SHARE_READ;

    fn temp_root(label: &str) -> PathBuf {
        let root =
            std::env::temp_dir().join(format!("yuanyuan-hook-write-{label}-{}", Uuid::new_v4()));
        std::fs::create_dir_all(&root).unwrap();
        root
    }

    fn codex_specs() -> Vec<OwnedCommandHookSpec> {
        ["SessionStart", "Stop"]
            .into_iter()
            .map(|event| OwnedCommandHookSpec {
                event: event.to_owned(),
                matcher: None,
                command: r#""C:\Program Files\Yuanyuan\yuanyuan-bridge.exe" --owner-id yuanyuan-reminder --source codex-hooks --connector-id builtin.codex.00000000-0000-4000-8000-000000000010 --source-instance 00000000-0000-4000-8000-000000000001 --key-id credential-reference-1"#.to_owned(),
                args: Vec::new(),
                timeout_seconds: Some(1),
                owner_id: "yuanyuan-reminder".to_owned(),
                connector_id:
                    "builtin.codex.00000000-0000-4000-8000-000000000010".to_owned(),
                source_instance: "00000000-0000-4000-8000-000000000001".to_owned(),
            })
            .collect()
    }

    fn existing_bytes_are_preserved(original: &[u8], edited: &[u8]) -> bool {
        let mut original = original.iter();
        let mut next = original.next();
        for byte in edited {
            if next == Some(byte) {
                next = original.next();
            }
        }
        next.is_none()
    }

    fn owned_artifacts(root: &Path) -> Vec<PathBuf> {
        std::fs::read_dir(root)
            .unwrap()
            .map(|entry| entry.unwrap().path())
            .filter(|path| {
                path.file_name()
                    .and_then(|name| name.to_str())
                    .is_some_and(|name| name.contains(".yuanyuan-"))
            })
            .collect()
    }

    #[test]
    fn confirmed_existing_file_write_keeps_exact_backup_and_token_is_single_use() {
        let root = temp_root("existing");
        let target = root.join("hooks.json");
        let original = br#"{
  // user content
  "description": "keep",
  "future": {"enabled":true}
}"#;
        std::fs::write(&target, original).unwrap();
        let coordinator = HookConfigWriteCoordinator::default();
        let preview = coordinator
            .preview_addition(
                HookConfigFormat::CodexHooksJson,
                target.clone(),
                codex_specs(),
            )
            .unwrap();
        assert!(preview.target_existed);
        assert!(preview.backup_required);
        assert_eq!(preview.added_handlers, 2);
        assert!(!preview.config_write_performed);
        assert_eq!(std::fs::read(&target).unwrap(), original);

        let token = preview.confirmation_token.unwrap();
        let result = coordinator.apply(&token).unwrap();
        assert_eq!(result.added_handlers, 2);
        assert!(result.backup_created);
        assert!(result.config_write_performed);
        assert!(result.hook_configuration_changed);
        assert!(!result.source_task_behavior_changed);
        let installed = std::fs::read(&target).unwrap();
        assert!(existing_bytes_are_preserved(original, &installed));

        let artifacts = owned_artifacts(&root);
        assert_eq!(artifacts.len(), 1);
        assert_eq!(std::fs::read(&artifacts[0]).unwrap(), original);
        assert_eq!(
            coordinator.apply(&token),
            Err(HookConfigWriteError::InvalidConfirmation)
        );
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn missing_target_is_created_atomically_without_a_backup() {
        let root = temp_root("missing");
        let target = root.join("hooks.json");
        let coordinator = HookConfigWriteCoordinator::default();
        let preview = coordinator
            .preview_addition(
                HookConfigFormat::CodexHooksJson,
                target.clone(),
                codex_specs(),
            )
            .unwrap();
        assert!(!preview.target_existed);
        assert!(!preview.backup_required);
        assert!(!target.exists());
        let result = coordinator
            .apply(preview.confirmation_token.as_deref().unwrap())
            .unwrap();
        assert!(!result.backup_created);
        assert!(target.is_file());
        assert!(owned_artifacts(&root).is_empty());
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn concurrent_content_or_identity_change_consumes_confirmation_without_writing() {
        let root = temp_root("changed");
        let target = root.join("hooks.json");
        let original = b"{\"user\":1}";
        std::fs::write(&target, original).unwrap();
        let coordinator = HookConfigWriteCoordinator::default();
        let preview = coordinator
            .preview_addition(
                HookConfigFormat::CodexHooksJson,
                target.clone(),
                codex_specs(),
            )
            .unwrap();
        std::fs::write(&target, b"{\"user\":2}").unwrap();
        let token = preview.confirmation_token.unwrap();
        assert_eq!(
            coordinator.apply(&token),
            Err(HookConfigWriteError::ConfigurationChanged)
        );
        assert_eq!(std::fs::read(&target).unwrap(), b"{\"user\":2}");
        assert!(owned_artifacts(&root).is_empty());
        assert_eq!(
            coordinator.apply(&token),
            Err(HookConfigWriteError::InvalidConfirmation)
        );

        let preview = coordinator
            .preview_addition(
                HookConfigFormat::CodexHooksJson,
                target.clone(),
                codex_specs(),
            )
            .unwrap();
        let bytes = std::fs::read(&target).unwrap();
        std::fs::remove_file(&target).unwrap();
        std::fs::write(&target, bytes).unwrap();
        assert_eq!(
            coordinator.apply(preview.confirmation_token.as_deref().unwrap()),
            Err(HookConfigWriteError::ConfigurationChanged)
        );
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn expired_confirmation_and_no_change_preview_never_write() {
        let root = temp_root("expiry");
        let target = root.join("hooks.json");
        std::fs::write(&target, b"{}").unwrap();
        let coordinator = HookConfigWriteCoordinator::default();
        let now = Instant::now();
        let preview = coordinator
            .preview_edit_at(
                HookConfigEditAction::Add,
                HookConfigFormat::CodexHooksJson,
                target.clone(),
                codex_specs(),
                now,
            )
            .unwrap();
        assert_eq!(
            coordinator.apply_at(
                preview.confirmation_token.as_deref().unwrap(),
                now + CONFIRMATION_LIFETIME + Duration::from_millis(1),
                SystemTime::now(),
            ),
            Err(HookConfigWriteError::InvalidConfirmation)
        );
        assert_eq!(std::fs::read(&target).unwrap(), b"{}");

        let preview = coordinator
            .preview_addition(
                HookConfigFormat::CodexHooksJson,
                target.clone(),
                codex_specs(),
            )
            .unwrap();
        coordinator
            .apply(preview.confirmation_token.as_deref().unwrap())
            .unwrap();
        let no_change = coordinator
            .preview_addition(HookConfigFormat::CodexHooksJson, target, codex_specs())
            .unwrap();
        assert_eq!(no_change.added_handlers, 0);
        assert!(no_change.confirmation_token.is_none());
        assert!(!no_change.backup_required);
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn replacement_failure_preserves_original_and_removes_owned_artifacts() {
        let root = temp_root("locked");
        let target = root.join("hooks.json");
        let original = b"{\"user\":true}";
        std::fs::write(&target, original).unwrap();
        let coordinator = HookConfigWriteCoordinator::default();
        let preview = coordinator
            .preview_addition(
                HookConfigFormat::CodexHooksJson,
                target.clone(),
                codex_specs(),
            )
            .unwrap();
        let lock = OpenOptions::new()
            .read(true)
            .share_mode(FILE_SHARE_READ)
            .open(&target)
            .unwrap();
        assert_eq!(
            coordinator.apply(preview.confirmation_token.as_deref().unwrap()),
            Err(HookConfigWriteError::AtomicReplaceFailed)
        );
        drop(lock);
        assert_eq!(std::fs::read(&target).unwrap(), original);
        assert!(owned_artifacts(&root).is_empty());
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn confirmed_removal_keeps_exact_installed_backup_and_preserves_user_content() {
        let root = temp_root("remove-existing");
        let target = root.join("hooks.json");
        let user_original = b"{\"user\":true}";
        let specs = codex_specs();
        let installed = prepare_lossless_hook_config_addition(
            HookConfigFormat::CodexHooksJson,
            user_original,
            &specs,
        )
        .unwrap()
        .output;
        std::fs::write(&target, &installed).unwrap();
        let coordinator = HookConfigWriteCoordinator::default();
        let preview = coordinator
            .preview_removal(
                HookConfigFormat::CodexHooksJson,
                target.clone(),
                specs.clone(),
            )
            .unwrap();
        assert_eq!(preview.added_handlers, 0);
        assert_eq!(preview.removed_handlers, 2);
        assert!(preview.backup_required);

        let token = preview.confirmation_token.unwrap();
        let result = coordinator.apply(&token).unwrap();
        assert_eq!(result.added_handlers, 0);
        assert_eq!(result.removed_handlers, 2);
        assert!(result.backup_created);
        let output = std::fs::read(&target).unwrap();
        assert!(String::from_utf8(output).unwrap().contains("\"user\":true"));
        assert_eq!(owned_artifacts(&root).len(), 1);
        assert_eq!(
            std::fs::read(&owned_artifacts(&root)[0]).unwrap(),
            installed
        );

        let no_change = coordinator
            .preview_removal(HookConfigFormat::CodexHooksJson, target, specs)
            .unwrap();
        assert_eq!(no_change.removed_handlers, 0);
        assert!(no_change.confirmation_token.is_none());
        assert_eq!(
            coordinator.apply(&token),
            Err(HookConfigWriteError::InvalidConfirmation)
        );
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn removal_refuses_reformatted_owned_bytes_and_locked_failure_keeps_installation() {
        let root = temp_root("remove-guard");
        let target = root.join("hooks.json");
        let specs = codex_specs();
        let installed =
            prepare_lossless_hook_config_addition(HookConfigFormat::CodexHooksJson, b"{}", &specs)
                .unwrap()
                .output;
        let reformatted = String::from_utf8(installed.clone())
            .unwrap()
            .replacen("\"timeout\":1", "\"timeout\": 1", 1)
            .into_bytes();
        std::fs::write(&target, &reformatted).unwrap();
        let coordinator = HookConfigWriteCoordinator::default();
        assert_eq!(
            coordinator.preview_removal(
                HookConfigFormat::CodexHooksJson,
                target.clone(),
                specs.clone()
            ),
            Err(HookConfigWriteError::ManualReviewRequired)
        );

        std::fs::write(&target, &installed).unwrap();
        let preview = coordinator
            .preview_removal(HookConfigFormat::CodexHooksJson, target.clone(), specs)
            .unwrap();
        let lock = OpenOptions::new()
            .read(true)
            .share_mode(FILE_SHARE_READ)
            .open(&target)
            .unwrap();
        assert_eq!(
            coordinator.apply(preview.confirmation_token.as_deref().unwrap()),
            Err(HookConfigWriteError::AtomicReplaceFailed)
        );
        drop(lock);
        assert_eq!(std::fs::read(&target).unwrap(), installed);
        assert!(owned_artifacts(&root).is_empty());
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn backup_timestamp_failure_happens_before_any_owned_file_is_created() {
        let root = temp_root("clock");
        let target = root.join("hooks.json");
        let original = b"{\"user\":true}";
        std::fs::write(&target, original).unwrap();
        let coordinator = HookConfigWriteCoordinator::default();
        let now = Instant::now();
        let preview = coordinator
            .preview_edit_at(
                HookConfigEditAction::Add,
                HookConfigFormat::CodexHooksJson,
                target.clone(),
                codex_specs(),
                now,
            )
            .unwrap();
        assert_eq!(
            coordinator.apply_at(
                preview.confirmation_token.as_deref().unwrap(),
                now,
                UNIX_EPOCH - Duration::from_secs(1),
            ),
            Err(HookConfigWriteError::BackupFailed)
        );
        assert_eq!(std::fs::read(&target).unwrap(), original);
        assert!(owned_artifacts(&root).is_empty());
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn unsupported_paths_and_pending_capacity_fail_before_writing() {
        let coordinator = HookConfigWriteCoordinator::default();
        assert_eq!(
            coordinator.preview_addition(
                HookConfigFormat::CodexHooksJson,
                PathBuf::from("hooks.json"),
                codex_specs(),
            ),
            Err(HookConfigWriteError::InvalidTarget)
        );
        let root = temp_root("invalid");
        assert_eq!(
            coordinator.preview_addition(
                HookConfigFormat::CodexConfigToml,
                root.join("config.toml"),
                codex_specs(),
            ),
            Err(HookConfigWriteError::InvalidTarget)
        );
        assert_eq!(
            coordinator.preview_addition(
                HookConfigFormat::CodexHooksJson,
                root.join("other.json"),
                codex_specs(),
            ),
            Err(HookConfigWriteError::InvalidTarget)
        );

        let target = root.join("hooks.json");
        for _ in 0..MAX_PENDING_WRITES {
            assert!(coordinator
                .preview_addition(
                    HookConfigFormat::CodexHooksJson,
                    target.clone(),
                    codex_specs(),
                )
                .is_ok());
        }
        assert_eq!(
            coordinator.preview_addition(HookConfigFormat::CodexHooksJson, target, codex_specs(),),
            Err(HookConfigWriteError::ConfirmationCapacityReached)
        );
        assert!(std::fs::read_dir(&root).unwrap().next().is_none());
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn serialized_contracts_and_errors_never_expose_paths_or_identity_material() {
        let root = temp_root("redaction");
        let target = root.join("hooks.json");
        let coordinator = HookConfigWriteCoordinator::default();
        let preview = coordinator
            .preview_addition(HookConfigFormat::CodexHooksJson, target, codex_specs())
            .unwrap();
        let encoded = serde_json::to_string(&preview).unwrap();
        for sensitive in [
            root.to_string_lossy().as_ref(),
            "credential-reference-1",
            "builtin.codex.",
            "source-instance",
            "Program Files",
        ] {
            assert!(!encoded.contains(sensitive));
        }
        let error = format!("{:?}", HookConfigWriteError::ConfigurationChanged);
        assert!(!error.contains(root.to_string_lossy().as_ref()));
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    #[ignore = "requires Windows symbolic-link creation privilege"]
    fn reparse_point_parent_and_target_are_rejected_before_read_or_write() {
        let root = temp_root("reparse");
        let real = root.join("real");
        std::fs::create_dir_all(&real).unwrap();
        let linked = root.join("linked");
        std::os::windows::fs::symlink_dir(&real, &linked).unwrap();
        let coordinator = HookConfigWriteCoordinator::default();
        assert_eq!(
            coordinator.preview_addition(
                HookConfigFormat::CodexHooksJson,
                linked.join("hooks.json"),
                codex_specs(),
            ),
            Err(HookConfigWriteError::UnsafePath)
        );

        let real_file = real.join("real-hooks.json");
        std::fs::write(&real_file, b"{}").unwrap();
        let linked_file = real.join("hooks.json");
        std::os::windows::fs::symlink_file(&real_file, &linked_file).unwrap();
        assert_eq!(
            coordinator.preview_addition(
                HookConfigFormat::CodexHooksJson,
                linked_file,
                codex_specs(),
            ),
            Err(HookConfigWriteError::UnsafePath)
        );
        std::fs::remove_dir_all(root).unwrap();
    }
}
