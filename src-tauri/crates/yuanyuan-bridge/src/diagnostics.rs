use std::{
    collections::HashSet,
    fs::{self, OpenOptions},
    io::Write,
    path::{Path, PathBuf},
};

#[cfg(windows)]
use std::os::windows::{ffi::OsStrExt, fs::MetadataExt};

use getrandom::fill as fill_random;
use rusqlite::{params, Connection, OpenFlags, TransactionBehavior};
use serde::{Deserialize, Serialize};
use thiserror::Error;

#[cfg(windows)]
use windows_sys::Win32::Storage::FileSystem::{GetDriveTypeW, MoveFileExW, MOVEFILE_WRITE_THROUGH};

use crate::BridgeDiagnosticCode;

pub const DIAGNOSTIC_SNAPSHOT_SCHEMA_VERSION: u16 = 1;
pub const DIAGNOSTIC_SENSITIVE_SCAN_VERSION: u16 = 1;
pub const DIAGNOSTIC_SENSITIVE_SCAN_CHECKS: u8 = 4;
pub const MAX_DIAGNOSTIC_SNAPSHOT_BYTES: usize = 64 * 1024;
pub const MAX_DIAGNOSTIC_BUNDLES: usize = 5;

const MAX_VERSION_BYTES: usize = 32;
const FINAL_PREFIX: &str = "diagnostics-v1-";
const FINAL_SUFFIX: &str = ".json";
const COUNTER_DATABASE_NAME: &str = "bridge-diagnostics-v1.sqlite3";
const COUNTER_AUXILIARY_NAMES: [&str; 3] = [
    "bridge-diagnostics-v1.sqlite3-journal",
    "bridge-diagnostics-v1.sqlite3-wal",
    "bridge-diagnostics-v1.sqlite3-shm",
];

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum DiagnosticAiStatus {
    NotInstalled,
    Unavailable,
    Starting,
    Running,
    BackingOff,
    CircuitOpen,
    Stopped,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct DiagnosticCount {
    pub code: BridgeDiagnosticCode,
    pub count: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct DiagnosticQueueSummary {
    pub pending_files: u32,
    pub pending_bytes: u64,
    pub quarantined_files: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct DiagnosticSnapshotV1 {
    pub schema_version: u16,
    pub generated_at_unix_ms: i64,
    pub core_version: String,
    pub task_event_protocol_version: u16,
    pub control_protocol_version: u16,
    pub ai_status: DiagnosticAiStatus,
    pub bridge_diagnostics: Vec<DiagnosticCount>,
    pub queue: DiagnosticQueueSummary,
}

#[derive(Debug, Default, Clone, Copy, PartialEq, Eq)]
pub struct DiagnosticStoreUsage {
    pub snapshot_files: u8,
    pub counter_files: u8,
}

#[derive(Debug, Default, Clone, Copy, PartialEq, Eq)]
pub struct DiagnosticClearReport {
    pub removed_snapshot_files: u8,
    pub removed_counter_files: u8,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct DiagnosticSensitiveScanReport {
    pub scan_version: u16,
    pub checks_performed: u8,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct DiagnosticExportWriteReport {
    pub bytes: u64,
    pub sensitive_scan: DiagnosticSensitiveScanReport,
}

#[derive(Debug, Error)]
pub enum DiagnosticSnapshotError {
    #[error("diagnostic snapshot is invalid")]
    InvalidSnapshot,
    #[error("diagnostic snapshot exceeds the byte limit")]
    InputTooLarge,
    #[error("diagnostic root is not an owned directory")]
    InvalidRoot,
    #[error("diagnostic bundle capacity is full")]
    Full,
    #[error("diagnostic sensitive scan failed")]
    SensitiveContent,
    #[error("diagnostic export target is unsafe")]
    InvalidExportTarget,
    #[error("diagnostic export target already exists")]
    ExportTargetExists,
    #[error("diagnostic file operation failed")]
    Io(#[from] std::io::Error),
    #[cfg(windows)]
    #[error("diagnostic ACL could not be applied")]
    Security(#[from] crate::NamedPipeServerError),
}

#[derive(Debug, Error)]
pub enum DiagnosticCounterError {
    #[error("diagnostic counter root is unsafe")]
    UnsafeRoot,
    #[error("diagnostic counter storage is unavailable")]
    Database(#[from] rusqlite::Error),
    #[error("diagnostic counter file operation failed")]
    Io(#[from] std::io::Error),
    #[cfg(windows)]
    #[error("diagnostic counter ACL could not be applied")]
    Security(#[from] crate::NamedPipeServerError),
}

/// Best-effort local counter storage for the fixed diagnostic enum. It never
/// accepts error text, paths or connector payloads.
pub fn record_bridge_diagnostic(
    root: &Path,
    code: BridgeDiagnosticCode,
) -> Result<(), DiagnosticCounterError> {
    prepare_counter_root(root)?;
    let database = root.join(COUNTER_DATABASE_NAME);
    reject_unsafe_counter_path(&database)?;
    let mut connection = Connection::open(&database)?;
    connection.busy_timeout(std::time::Duration::ZERO)?;
    connection.execute_batch(
        "PRAGMA journal_mode=DELETE;
         PRAGMA synchronous=NORMAL;
         CREATE TABLE IF NOT EXISTS bridge_diagnostic_counts (
           code TEXT PRIMARY KEY NOT NULL,
           count INTEGER NOT NULL CHECK(count > 0)
         ) WITHOUT ROWID;",
    )?;
    secure_counter_path(&database)?;
    let transaction = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
    transaction.execute(
        "INSERT INTO bridge_diagnostic_counts(code, count) VALUES (?1, 1)
         ON CONFLICT(code) DO UPDATE SET count =
           CASE WHEN count = 9223372036854775807 THEN count ELSE count + 1 END",
        params![code.as_str()],
    )?;
    transaction.commit()?;
    Ok(())
}

/// Reads existing fixed counters without creating a directory or database.
pub fn read_bridge_diagnostics(
    root: &Path,
) -> Result<Vec<DiagnosticCount>, DiagnosticCounterError> {
    match fs::symlink_metadata(root) {
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
        Ok(metadata) if metadata.is_dir() && !metadata.file_type().is_symlink() => {}
        Ok(_) => return Err(DiagnosticCounterError::UnsafeRoot),
        Err(error) => return Err(error.into()),
    }
    let database = root.join(COUNTER_DATABASE_NAME);
    match fs::symlink_metadata(&database) {
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
        Ok(metadata) if metadata.is_file() && !metadata.file_type().is_symlink() => {}
        Ok(_) => return Err(DiagnosticCounterError::UnsafeRoot),
        Err(error) => return Err(error.into()),
    }
    let connection = Connection::open_with_flags(
        database,
        OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX,
    )?;
    connection.busy_timeout(std::time::Duration::ZERO)?;
    let mut statement = connection
        .prepare("SELECT code, count FROM bridge_diagnostic_counts ORDER BY code LIMIT 11")?;
    let rows = statement.query_map([], |row| {
        Ok((row.get::<_, String>(0)?, row.get::<_, i64>(1)?))
    })?;
    let mut counts = Vec::new();
    for row in rows {
        let (code, count) = row?;
        let code =
            BridgeDiagnosticCode::parse_code(&code).ok_or(DiagnosticCounterError::UnsafeRoot)?;
        if count <= 0 || counts.len() >= BridgeDiagnosticCode::ALL.len() {
            return Err(DiagnosticCounterError::UnsafeRoot);
        }
        counts.push(DiagnosticCount {
            code,
            count: count as u64,
        });
    }
    Ok(counts)
}

fn prepare_counter_root(root: &Path) -> Result<(), DiagnosticCounterError> {
    match fs::symlink_metadata(root) {
        Ok(metadata) if metadata.is_dir() && !metadata.file_type().is_symlink() => {}
        Ok(_) => return Err(DiagnosticCounterError::UnsafeRoot),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => fs::create_dir_all(root)?,
        Err(error) => return Err(error.into()),
    }
    secure_counter_path(root)
}

fn reject_unsafe_counter_path(path: &Path) -> Result<(), DiagnosticCounterError> {
    match fs::symlink_metadata(path) {
        Ok(metadata) if metadata.is_file() && !metadata.file_type().is_symlink() => Ok(()),
        Ok(_) => Err(DiagnosticCounterError::UnsafeRoot),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(error.into()),
    }
}

#[cfg(windows)]
fn secure_counter_path(path: &Path) -> Result<(), DiagnosticCounterError> {
    crate::apply_current_user_only_dacl(path)?;
    Ok(())
}

#[cfg(not(windows))]
fn secure_counter_path(_path: &Path) -> Result<(), DiagnosticCounterError> {
    Ok(())
}

/// Inspects only the fixed files owned by diagnostics and never creates state.
pub fn inspect_diagnostic_store(
    root: &Path,
) -> Result<DiagnosticStoreUsage, DiagnosticSnapshotError> {
    if !validate_existing_root(root)? {
        return Ok(DiagnosticStoreUsage::default());
    }
    let targets = owned_diagnostic_targets(root)?;
    Ok(DiagnosticStoreUsage {
        snapshot_files: targets
            .iter()
            .filter(|target| target.snapshot)
            .count()
            .try_into()
            .map_err(|_| DiagnosticSnapshotError::InvalidRoot)?,
        counter_files: targets
            .iter()
            .filter(|target| !target.snapshot)
            .count()
            .try_into()
            .map_err(|_| DiagnosticSnapshotError::InvalidRoot)?,
    })
}

/// Removes only reviewed snapshot and counter filenames after validating every
/// target. The directory and unrelated files are deliberately preserved.
pub fn clear_diagnostic_store(
    root: &Path,
) -> Result<DiagnosticClearReport, DiagnosticSnapshotError> {
    if !validate_existing_root(root)? {
        return Ok(DiagnosticClearReport::default());
    }
    let targets = owned_diagnostic_targets(root)?;
    let mut report = DiagnosticClearReport::default();
    for target in targets {
        fs::remove_file(target.path)?;
        if target.snapshot {
            report.removed_snapshot_files = report.removed_snapshot_files.saturating_add(1);
        } else {
            report.removed_counter_files = report.removed_counter_files.saturating_add(1);
        }
    }
    Ok(report)
}

struct OwnedDiagnosticTarget {
    path: PathBuf,
    snapshot: bool,
}

fn validate_existing_root(root: &Path) -> Result<bool, DiagnosticSnapshotError> {
    match fs::symlink_metadata(root) {
        Ok(metadata) if metadata.is_dir() && !metadata.file_type().is_symlink() => Ok(true),
        Ok(_) => Err(DiagnosticSnapshotError::InvalidRoot),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(false),
        Err(error) => Err(error.into()),
    }
}

fn owned_diagnostic_targets(
    root: &Path,
) -> Result<Vec<OwnedDiagnosticTarget>, DiagnosticSnapshotError> {
    let mut targets = Vec::new();
    for entry in fs::read_dir(root)? {
        let entry = entry?;
        let name = entry.file_name();
        let name = name.to_string_lossy();
        let snapshot = is_snapshot_name(&name);
        let counter =
            name == COUNTER_DATABASE_NAME || COUNTER_AUXILIARY_NAMES.contains(&name.as_ref());
        if !snapshot && !counter {
            continue;
        }
        let metadata = fs::symlink_metadata(entry.path())?;
        if !metadata.is_file() || metadata.file_type().is_symlink() {
            return Err(DiagnosticSnapshotError::InvalidRoot);
        }
        targets.push(OwnedDiagnosticTarget {
            path: entry.path(),
            snapshot,
        });
    }
    Ok(targets)
}

fn is_snapshot_name(name: &str) -> bool {
    name.strip_prefix(FINAL_PREFIX)
        .and_then(|value| value.strip_suffix(FINAL_SUFFIX))
        .is_some_and(|timestamp| {
            !timestamp.is_empty() && timestamp.bytes().all(|byte| byte.is_ascii_digit())
        })
}

impl DiagnosticSnapshotV1 {
    pub fn validate(&self) -> Result<(), DiagnosticSnapshotError> {
        if self.schema_version != DIAGNOSTIC_SNAPSHOT_SCHEMA_VERSION
            || self.generated_at_unix_ms < 0
            || self.task_event_protocol_version == 0
            || self.control_protocol_version == 0
            || !valid_version(&self.core_version)
            || self.bridge_diagnostics.len() > BridgeDiagnosticCode::ALL.len()
        {
            return Err(DiagnosticSnapshotError::InvalidSnapshot);
        }
        let mut codes = HashSet::new();
        if self
            .bridge_diagnostics
            .iter()
            .any(|entry| entry.count == 0 || !codes.insert(entry.code))
        {
            return Err(DiagnosticSnapshotError::InvalidSnapshot);
        }
        Ok(())
    }
}

pub fn serialize_diagnostic_snapshot(
    snapshot: &DiagnosticSnapshotV1,
) -> Result<Vec<u8>, DiagnosticSnapshotError> {
    snapshot.validate()?;
    let bytes = serde_json::to_vec_pretty(snapshot)
        .map_err(|_| DiagnosticSnapshotError::InvalidSnapshot)?;
    if bytes.len() > MAX_DIAGNOSTIC_SNAPSHOT_BYTES {
        return Err(DiagnosticSnapshotError::InputTooLarge);
    }
    Ok(bytes)
}

/// Independently checks the exact bytes shown or written by the diagnostic
/// export flow. The scan accepts only the canonical reviewed v1 schema and
/// rejects path, credential, prompt, user and private-key canaries even when
/// they are placed in a syntactically valid free string.
pub fn scan_serialized_diagnostic_snapshot(
    bytes: &[u8],
) -> Result<DiagnosticSensitiveScanReport, DiagnosticSnapshotError> {
    if bytes.is_empty() || bytes.len() > MAX_DIAGNOSTIC_SNAPSHOT_BYTES + 1 {
        return Err(DiagnosticSnapshotError::SensitiveContent);
    }
    let payload = bytes.strip_suffix(b"\n").unwrap_or(bytes);
    if payload.is_empty() || payload.len() > MAX_DIAGNOSTIC_SNAPSHOT_BYTES {
        return Err(DiagnosticSnapshotError::SensitiveContent);
    }
    let snapshot: DiagnosticSnapshotV1 =
        serde_json::from_slice(payload).map_err(|_| DiagnosticSnapshotError::SensitiveContent)?;
    snapshot
        .validate()
        .map_err(|_| DiagnosticSnapshotError::SensitiveContent)?;
    let canonical = serialize_diagnostic_snapshot(&snapshot)
        .map_err(|_| DiagnosticSnapshotError::SensitiveContent)?;
    if canonical != payload {
        return Err(DiagnosticSnapshotError::SensitiveContent);
    }

    let text = std::str::from_utf8(payload)
        .map_err(|_| DiagnosticSnapshotError::SensitiveContent)?
        .to_ascii_lowercase();
    const SENSITIVE_MARKERS: [&str; 14] = [
        "password",
        "passwd",
        "secret",
        "credential",
        "access_token",
        "refresh_token",
        "authorization",
        "workspace",
        "prompt",
        "task_title",
        "task_id",
        "user_name",
        "username",
        "private_key",
    ];
    const SECRET_OR_PATH_SIGNATURES: [&str; 13] = [
        "sk-",
        "ghp_",
        "github_pat_",
        "akia",
        "bearer ",
        "-----begin ",
        ":\\",
        "\\\\",
        "file://",
        "/home/",
        "/users/",
        "%userprofile%",
        "@",
    ];
    if SENSITIVE_MARKERS
        .iter()
        .chain(SECRET_OR_PATH_SIGNATURES.iter())
        .any(|marker| text.contains(marker))
    {
        return Err(DiagnosticSnapshotError::SensitiveContent);
    }

    Ok(DiagnosticSensitiveScanReport {
        scan_version: DIAGNOSTIC_SENSITIVE_SCAN_VERSION,
        checks_performed: DIAGNOSTIC_SENSITIVE_SCAN_CHECKS,
    })
}

pub fn diagnostic_export_file_name(snapshot: &DiagnosticSnapshotV1) -> String {
    format!(
        "{FINAL_PREFIX}{}{FINAL_SUFFIX}",
        snapshot.generated_at_unix_ms
    )
}

/// Writes one user-selected export without creating a second application-owned
/// copy. Existing destinations are never overwritten. The bytes are scanned
/// before the write, after the temporary file is flushed, and after the final
/// no-clobber move.
pub fn write_selected_diagnostic_export(
    target: &Path,
    snapshot: &DiagnosticSnapshotV1,
) -> Result<DiagnosticExportWriteReport, DiagnosticSnapshotError> {
    let mut bytes = serialize_diagnostic_snapshot(snapshot)?;
    bytes.push(b'\n');
    let sensitive_scan = scan_serialized_diagnostic_snapshot(&bytes)?;
    let parent = validate_diagnostic_export_target(target)?;

    let mut random = [0_u8; 12];
    fill_random(&mut random)
        .map_err(|error| DiagnosticSnapshotError::Io(std::io::Error::other(error.to_string())))?;
    let random = random
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect::<String>();
    let temporary_path = parent.join(format!(".yuanyuan-diagnostic-export-{random}.tmp"));
    let mut final_created = false;
    let write_result = (|| {
        let mut file = OpenOptions::new()
            .create_new(true)
            .write(true)
            .open(&temporary_path)?;
        file.write_all(&bytes)?;
        file.sync_all()?;
        secure_path(&temporary_path)?;
        let temporary_bytes = fs::read(&temporary_path)?;
        scan_serialized_diagnostic_snapshot(&temporary_bytes)?;
        if temporary_bytes != bytes {
            return Err(DiagnosticSnapshotError::SensitiveContent);
        }
        move_new_export(&temporary_path, target)?;
        final_created = true;
        secure_path(target)?;
        let final_metadata = fs::symlink_metadata(target)?;
        if !final_metadata.is_file() || final_metadata.file_type().is_symlink() {
            return Err(DiagnosticSnapshotError::InvalidExportTarget);
        }
        let final_bytes = fs::read(target)?;
        let final_scan = scan_serialized_diagnostic_snapshot(&final_bytes)?;
        if final_bytes != bytes || final_scan != sensitive_scan {
            return Err(DiagnosticSnapshotError::SensitiveContent);
        }
        Ok(DiagnosticExportWriteReport {
            bytes: final_metadata.len(),
            sensitive_scan: final_scan,
        })
    })();
    if write_result.is_err() {
        let _ = fs::remove_file(&temporary_path);
        if final_created {
            remove_matching_export(target, &bytes);
        }
    }
    write_result
}

fn validate_diagnostic_export_target(target: &Path) -> Result<&Path, DiagnosticSnapshotError> {
    if !target.is_absolute()
        || target.file_name().is_none()
        || !target
            .extension()
            .and_then(|extension| extension.to_str())
            .is_some_and(|extension| extension.eq_ignore_ascii_case("json"))
    {
        return Err(DiagnosticSnapshotError::InvalidExportTarget);
    }
    #[cfg(windows)]
    if !is_local_windows_path(target) {
        return Err(DiagnosticSnapshotError::InvalidExportTarget);
    }
    let parent = target
        .parent()
        .ok_or(DiagnosticSnapshotError::InvalidExportTarget)?;
    for ancestor in parent.ancestors() {
        let metadata = fs::symlink_metadata(ancestor)
            .map_err(|_| DiagnosticSnapshotError::InvalidExportTarget)?;
        if !metadata.is_dir()
            || metadata.file_type().is_symlink()
            || metadata_is_reparse_point(&metadata)
        {
            return Err(DiagnosticSnapshotError::InvalidExportTarget);
        }
    }
    match fs::symlink_metadata(target) {
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(parent),
        Ok(_) => Err(DiagnosticSnapshotError::ExportTargetExists),
        Err(error) => Err(error.into()),
    }
}

#[cfg(windows)]
fn is_local_windows_path(path: &Path) -> bool {
    use std::path::{Component, Prefix};

    // Stable Win32 GetDriveTypeW values from fileapi.h. windows-sys exposes
    // the function but not these constants in every generated feature set.
    const DRIVE_REMOVABLE: u32 = 2;
    const DRIVE_FIXED: u32 = 3;
    const DRIVE_RAMDISK: u32 = 6;

    let drive = match path.components().next() {
        Some(Component::Prefix(prefix)) => match prefix.kind() {
            Prefix::Disk(drive) | Prefix::VerbatimDisk(drive) => drive,
            _ => return false,
        },
        _ => return false,
    };
    let root = format!("{}:\\", char::from(drive));
    let wide = std::ffi::OsStr::new(&root)
        .encode_wide()
        .chain(std::iter::once(0))
        .collect::<Vec<_>>();
    // SAFETY: `wide` is a live NUL-terminated root path.
    matches!(
        unsafe { GetDriveTypeW(wide.as_ptr()) },
        DRIVE_FIXED | DRIVE_REMOVABLE | DRIVE_RAMDISK
    )
}

#[cfg(windows)]
fn metadata_is_reparse_point(metadata: &fs::Metadata) -> bool {
    const FILE_ATTRIBUTE_REPARSE_POINT: u32 = 0x0000_0400;
    metadata.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT != 0
}

#[cfg(not(windows))]
fn metadata_is_reparse_point(_metadata: &fs::Metadata) -> bool {
    false
}

#[cfg(windows)]
fn move_new_export(source: &Path, destination: &Path) -> std::io::Result<()> {
    let source = source
        .as_os_str()
        .encode_wide()
        .chain(std::iter::once(0))
        .collect::<Vec<_>>();
    let destination = destination
        .as_os_str()
        .encode_wide()
        .chain(std::iter::once(0))
        .collect::<Vec<_>>();
    // SAFETY: both buffers are live and NUL terminated. Replace-existing is
    // deliberately omitted, so a target created after validation is preserved.
    if unsafe {
        MoveFileExW(
            source.as_ptr(),
            destination.as_ptr(),
            MOVEFILE_WRITE_THROUGH,
        )
    } == 0
    {
        Err(std::io::Error::last_os_error())
    } else {
        Ok(())
    }
}

#[cfg(not(windows))]
fn move_new_export(source: &Path, destination: &Path) -> std::io::Result<()> {
    fs::hard_link(source, destination)?;
    fs::remove_file(source)
}

fn remove_matching_export(path: &Path, expected: &[u8]) {
    if fs::symlink_metadata(path)
        .ok()
        .is_some_and(|metadata| metadata.is_file() && !metadata.file_type().is_symlink())
        && fs::read(path).ok().as_deref() == Some(expected)
    {
        let _ = fs::remove_file(path);
    }
}

/// Writes a bounded, local-only diagnostic snapshot into an application-owned
/// directory. The schema intentionally has no free-text task, prompt, path,
/// support-session, credential or provider-payload field.
pub fn write_diagnostic_snapshot(
    root: &Path,
    snapshot: &DiagnosticSnapshotV1,
) -> Result<PathBuf, DiagnosticSnapshotError> {
    let bytes = serialize_diagnostic_snapshot(snapshot)?;
    prepare_owned_root(root)?;
    if existing_bundle_count(root)? >= MAX_DIAGNOSTIC_BUNDLES {
        return Err(DiagnosticSnapshotError::Full);
    }

    let final_path = root.join(format!(
        "{FINAL_PREFIX}{}{FINAL_SUFFIX}",
        snapshot.generated_at_unix_ms
    ));
    if fs::symlink_metadata(&final_path).is_ok() {
        return Err(DiagnosticSnapshotError::InvalidRoot);
    }

    let mut random = [0_u8; 12];
    fill_random(&mut random)
        .map_err(|error| DiagnosticSnapshotError::Io(std::io::Error::other(error.to_string())))?;
    let random = random
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect::<String>();
    let temporary_path = root.join(format!(".{FINAL_PREFIX}{random}.tmp"));
    let write_result = (|| {
        let mut file = OpenOptions::new()
            .create_new(true)
            .write(true)
            .open(&temporary_path)?;
        file.write_all(&bytes)?;
        file.write_all(b"\n")?;
        file.sync_all()?;
        secure_path(&temporary_path)?;
        fs::rename(&temporary_path, &final_path)?;
        secure_path(&final_path)?;
        Ok::<(), DiagnosticSnapshotError>(())
    })();
    if write_result.is_err() {
        let _ = fs::remove_file(&temporary_path);
    }
    write_result?;
    Ok(final_path)
}

fn valid_version(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= MAX_VERSION_BYTES
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'-' | b'+' | b'_'))
}

fn prepare_owned_root(root: &Path) -> Result<(), DiagnosticSnapshotError> {
    match fs::symlink_metadata(root) {
        Ok(metadata) if metadata.is_dir() && !metadata.file_type().is_symlink() => {}
        Ok(_) => return Err(DiagnosticSnapshotError::InvalidRoot),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => fs::create_dir_all(root)?,
        Err(error) => return Err(error.into()),
    }
    secure_path(root)
}

fn existing_bundle_count(root: &Path) -> Result<usize, DiagnosticSnapshotError> {
    let mut count = 0;
    for entry in fs::read_dir(root)? {
        let entry = entry?;
        let name = entry.file_name();
        let name = name.to_string_lossy();
        if is_snapshot_name(&name) {
            let metadata = fs::symlink_metadata(entry.path())?;
            if !metadata.is_file() || metadata.file_type().is_symlink() {
                return Err(DiagnosticSnapshotError::InvalidRoot);
            }
            count += 1;
        }
    }
    Ok(count)
}

#[cfg(windows)]
fn secure_path(path: &Path) -> Result<(), DiagnosticSnapshotError> {
    crate::apply_current_user_only_dacl(path)?;
    Ok(())
}

#[cfg(not(windows))]
fn secure_path(_path: &Path) -> Result<(), DiagnosticSnapshotError> {
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn snapshot(timestamp: i64) -> DiagnosticSnapshotV1 {
        DiagnosticSnapshotV1 {
            schema_version: DIAGNOSTIC_SNAPSHOT_SCHEMA_VERSION,
            generated_at_unix_ms: timestamp,
            core_version: "1.4.0".to_owned(),
            task_event_protocol_version: 1,
            control_protocol_version: 1,
            ai_status: DiagnosticAiStatus::CircuitOpen,
            bridge_diagnostics: vec![
                DiagnosticCount {
                    code: BridgeDiagnosticCode::AuthenticationFailed,
                    count: 2,
                },
                DiagnosticCount {
                    code: BridgeDiagnosticCode::QueueFull,
                    count: 1,
                },
            ],
            queue: DiagnosticQueueSummary {
                pending_files: 3,
                pending_bytes: 1_024,
                quarantined_files: 1,
            },
        }
    }

    #[test]
    fn schema_has_no_place_for_sensitive_free_text() {
        let bytes = serialize_diagnostic_snapshot(&snapshot(1_000)).unwrap();
        let json = String::from_utf8(bytes).unwrap();
        assert!(json.len() < MAX_DIAGNOSTIC_SNAPSHOT_BYTES);
        for forbidden in [
            "my-secret-api-key",
            "C:\\Users\\private-user\\project",
            "the original prompt",
            "我真的撑不住了",
            "tool_input",
            "task_title",
            "workspace",
        ] {
            assert!(!json.contains(forbidden));
        }
        assert!(json.contains("authentication_failed"));
        assert!(json.contains("circuit_open"));
    }

    #[test]
    fn independent_sensitive_scan_accepts_only_canonical_reviewed_bytes() {
        let clean = serialize_diagnostic_snapshot(&snapshot(1_000)).unwrap();
        assert_eq!(
            scan_serialized_diagnostic_snapshot(&clean).unwrap(),
            DiagnosticSensitiveScanReport {
                scan_version: DIAGNOSTIC_SENSITIVE_SCAN_VERSION,
                checks_performed: DIAGNOSTIC_SENSITIVE_SCAN_CHECKS,
            }
        );
        let mut with_newline = clean.clone();
        with_newline.push(b'\n');
        assert!(scan_serialized_diagnostic_snapshot(&with_newline).is_ok());

        let mut secret = snapshot(1_001);
        secret.core_version = "sk-live-canary".to_owned();
        let secret = serialize_diagnostic_snapshot(&secret).unwrap();
        assert!(matches!(
            scan_serialized_diagnostic_snapshot(&secret),
            Err(DiagnosticSnapshotError::SensitiveContent)
        ));

        let mut unknown = serde_json::to_value(snapshot(1_002)).unwrap();
        unknown
            .as_object_mut()
            .unwrap()
            .insert("workspace".to_owned(), serde_json::json!("private"));
        let unknown = serde_json::to_vec_pretty(&unknown).unwrap();
        assert!(matches!(
            scan_serialized_diagnostic_snapshot(&unknown),
            Err(DiagnosticSnapshotError::SensitiveContent)
        ));

        let compact = serde_json::to_vec(&snapshot(1_003)).unwrap();
        assert!(matches!(
            scan_serialized_diagnostic_snapshot(&compact),
            Err(DiagnosticSnapshotError::SensitiveContent)
        ));
    }

    #[test]
    fn selected_export_is_scanned_atomic_private_and_never_clobbers() {
        let directory = tempfile::tempdir().unwrap();
        let target = directory.path().join("chosen-diagnostics.json");
        let report = write_selected_diagnostic_export(&target, &snapshot(1_000)).unwrap();
        let bytes = fs::read(&target).unwrap();
        assert_eq!(report.bytes, bytes.len() as u64);
        assert_eq!(
            report.sensitive_scan,
            scan_serialized_diagnostic_snapshot(&bytes).unwrap()
        );
        assert!(bytes.ends_with(b"\n"));
        assert!(directory.path().read_dir().unwrap().all(|entry| !entry
            .unwrap()
            .file_name()
            .to_string_lossy()
            .ends_with(".tmp")));

        let original = bytes.clone();
        assert!(matches!(
            write_selected_diagnostic_export(&target, &snapshot(2_000)),
            Err(DiagnosticSnapshotError::ExportTargetExists)
        ));
        assert_eq!(fs::read(&target).unwrap(), original);
    }

    #[test]
    fn selected_export_rejects_relative_non_json_and_missing_parent_targets() {
        let directory = tempfile::tempdir().unwrap();
        assert!(matches!(
            write_selected_diagnostic_export(
                Path::new("relative-diagnostics.json"),
                &snapshot(1_000)
            ),
            Err(DiagnosticSnapshotError::InvalidExportTarget)
        ));
        assert!(matches!(
            write_selected_diagnostic_export(
                &directory.path().join("diagnostics.txt"),
                &snapshot(1_000)
            ),
            Err(DiagnosticSnapshotError::InvalidExportTarget)
        ));
        assert!(matches!(
            write_selected_diagnostic_export(
                &directory
                    .path()
                    .join("missing-parent")
                    .join("diagnostics.json"),
                &snapshot(1_000)
            ),
            Err(DiagnosticSnapshotError::InvalidExportTarget)
        ));
    }

    #[test]
    fn unknown_versions_duplicate_codes_and_zero_counts_fail_closed() {
        let mut invalid = snapshot(1_000);
        invalid.core_version = "1.4.0/private path".to_owned();
        assert!(invalid.validate().is_err());

        let mut duplicate = snapshot(1_000);
        duplicate.bridge_diagnostics.push(DiagnosticCount {
            code: BridgeDiagnosticCode::QueueFull,
            count: 4,
        });
        assert!(duplicate.validate().is_err());

        let mut zero = snapshot(1_000);
        zero.bridge_diagnostics[0].count = 0;
        assert!(zero.validate().is_err());
    }

    #[test]
    fn owned_store_writes_atomic_bounded_snapshots_and_stops_at_capacity() {
        let directory = tempfile::tempdir().unwrap();
        let root = directory.path().join("diagnostics");
        for index in 0..MAX_DIAGNOSTIC_BUNDLES {
            let output = write_diagnostic_snapshot(&root, &snapshot(1_000 + index as i64)).unwrap();
            assert!(output.is_file());
            assert!(
                fs::metadata(output).unwrap().len() <= MAX_DIAGNOSTIC_SNAPSHOT_BYTES as u64 + 1
            );
        }
        assert!(matches!(
            write_diagnostic_snapshot(&root, &snapshot(2_000)),
            Err(DiagnosticSnapshotError::Full)
        ));
        assert!(fs::read_dir(&root).unwrap().all(|entry| !entry
            .unwrap()
            .file_name()
            .to_string_lossy()
            .ends_with(".tmp")));
    }

    #[test]
    fn file_or_matching_link_cannot_be_used_as_the_diagnostic_root_or_bundle() {
        let directory = tempfile::tempdir().unwrap();
        let root_file = directory.path().join("not-a-directory");
        fs::write(&root_file, b"occupied").unwrap();
        assert!(matches!(
            write_diagnostic_snapshot(&root_file, &snapshot(1_000)),
            Err(DiagnosticSnapshotError::InvalidRoot)
        ));

        let root = directory.path().join("diagnostics");
        fs::create_dir(&root).unwrap();
        fs::write(root.join("diagnostics-v1-1000.json"), b"occupied").unwrap();
        assert!(matches!(
            write_diagnostic_snapshot(&root, &snapshot(1_000)),
            Err(DiagnosticSnapshotError::InvalidRoot)
        ));
    }

    #[cfg(windows)]
    #[test]
    fn anonymous_windows_token_cannot_read_a_diagnostic_snapshot() {
        use std::os::windows::ffi::OsStrExt;

        use windows_sys::Win32::{
            Foundation::{
                CloseHandle, GetLastError, ERROR_ACCESS_DENIED, GENERIC_READ, INVALID_HANDLE_VALUE,
            },
            Security::{ImpersonateAnonymousToken, RevertToSelf},
            Storage::FileSystem::{CreateFileW, FILE_ATTRIBUTE_NORMAL, OPEN_EXISTING},
            System::Threading::GetCurrentThread,
        };

        struct RevertImpersonation;
        impl Drop for RevertImpersonation {
            fn drop(&mut self) {
                // SAFETY: this guard exists only after successful impersonation.
                unsafe {
                    RevertToSelf();
                }
            }
        }

        let directory = tempfile::tempdir().unwrap();
        let output = write_diagnostic_snapshot(directory.path(), &snapshot(1_000)).unwrap();
        let mut wide: Vec<u16> = output.as_os_str().encode_wide().collect();
        wide.push(0);

        // SAFETY: the current thread pseudo-handle is valid for impersonation.
        assert_ne!(unsafe { ImpersonateAnonymousToken(GetCurrentThread()) }, 0);
        let _revert = RevertImpersonation;
        // SAFETY: `wide` is a live NUL-terminated path. No handle is transferred.
        let handle = unsafe {
            CreateFileW(
                wide.as_ptr(),
                GENERIC_READ,
                0,
                std::ptr::null(),
                OPEN_EXISTING,
                FILE_ATTRIBUTE_NORMAL,
                std::ptr::null_mut(),
            )
        };
        if handle != INVALID_HANDLE_VALUE {
            unsafe { CloseHandle(handle) };
        }
        assert_eq!(handle, INVALID_HANDLE_VALUE);
        assert_eq!(unsafe { GetLastError() }, ERROR_ACCESS_DENIED);
    }

    #[test]
    fn fixed_bridge_diagnostic_counts_persist_without_error_text() {
        let directory = tempfile::tempdir().unwrap();
        let root = directory.path().join("diagnostics");
        record_bridge_diagnostic(&root, BridgeDiagnosticCode::Timeout).unwrap();
        record_bridge_diagnostic(&root, BridgeDiagnosticCode::Timeout).unwrap();
        record_bridge_diagnostic(&root, BridgeDiagnosticCode::QueueFull).unwrap();

        assert_eq!(
            read_bridge_diagnostics(&root).unwrap(),
            vec![
                DiagnosticCount {
                    code: BridgeDiagnosticCode::QueueFull,
                    count: 1,
                },
                DiagnosticCount {
                    code: BridgeDiagnosticCode::Timeout,
                    count: 2,
                },
            ]
        );
        let schema = fs::read(root.join(COUNTER_DATABASE_NAME)).unwrap();
        assert!(!schema.windows(6).any(|window| window == b"secret"));
        assert!(!schema.windows(5).any(|window| window == b"title"));
    }

    #[test]
    fn reading_missing_bridge_counters_never_creates_storage() {
        let directory = tempfile::tempdir().unwrap();
        let root = directory.path().join("missing");
        assert!(read_bridge_diagnostics(&root).unwrap().is_empty());
        assert!(!root.exists());
    }

    #[test]
    fn unknown_or_non_positive_counter_rows_fail_closed() {
        let directory = tempfile::tempdir().unwrap();
        let root = directory.path().join("diagnostics");
        record_bridge_diagnostic(&root, BridgeDiagnosticCode::Timeout).unwrap();
        let database = root.join(COUNTER_DATABASE_NAME);
        let connection = Connection::open(database).unwrap();
        connection
            .execute(
                "INSERT INTO bridge_diagnostic_counts(code, count) VALUES ('unknown', 1)",
                [],
            )
            .unwrap();
        assert!(matches!(
            read_bridge_diagnostics(&root),
            Err(DiagnosticCounterError::UnsafeRoot)
        ));
    }

    #[test]
    fn counter_lock_contention_fails_immediately_without_changing_counts() {
        let directory = tempfile::tempdir().unwrap();
        let root = directory.path().join("diagnostics");
        record_bridge_diagnostic(&root, BridgeDiagnosticCode::Timeout).unwrap();
        let mut blocker = Connection::open(root.join(COUNTER_DATABASE_NAME)).unwrap();
        let transaction = blocker
            .transaction_with_behavior(TransactionBehavior::Exclusive)
            .unwrap();
        let started = std::time::Instant::now();

        assert!(record_bridge_diagnostic(&root, BridgeDiagnosticCode::Timeout).is_err());
        assert!(started.elapsed() < std::time::Duration::from_millis(100));
        transaction.rollback().unwrap();
        assert_eq!(read_bridge_diagnostics(&root).unwrap()[0].count, 1);
    }

    #[test]
    fn store_inspection_is_read_only_and_clear_preserves_unrelated_files() {
        let directory = tempfile::tempdir().unwrap();
        let missing = directory.path().join("missing");
        assert_eq!(
            inspect_diagnostic_store(&missing).unwrap(),
            DiagnosticStoreUsage::default()
        );
        assert!(!missing.exists());

        let root = directory.path().join("diagnostics");
        write_diagnostic_snapshot(&root, &snapshot(1_000)).unwrap();
        record_bridge_diagnostic(&root, BridgeDiagnosticCode::Timeout).unwrap();
        fs::write(root.join("user-note.txt"), b"keep me").unwrap();
        fs::write(root.join("diagnostics-v1-not-a-time.json"), b"keep me too").unwrap();
        assert_eq!(
            inspect_diagnostic_store(&root).unwrap(),
            DiagnosticStoreUsage {
                snapshot_files: 1,
                counter_files: 1,
            }
        );

        assert_eq!(
            clear_diagnostic_store(&root).unwrap(),
            DiagnosticClearReport {
                removed_snapshot_files: 1,
                removed_counter_files: 1,
            }
        );
        assert_eq!(fs::read(root.join("user-note.txt")).unwrap(), b"keep me");
        assert_eq!(
            fs::read(root.join("diagnostics-v1-not-a-time.json")).unwrap(),
            b"keep me too"
        );
        assert_eq!(
            inspect_diagnostic_store(&root).unwrap(),
            DiagnosticStoreUsage::default()
        );
    }

    #[test]
    fn clear_validates_every_owned_target_before_deleting_any_file() {
        let directory = tempfile::tempdir().unwrap();
        let root = directory.path().join("diagnostics");
        write_diagnostic_snapshot(&root, &snapshot(1_000)).unwrap();
        fs::create_dir(root.join("diagnostics-v1-2000.json")).unwrap();

        assert!(matches!(
            clear_diagnostic_store(&root),
            Err(DiagnosticSnapshotError::InvalidRoot)
        ));
        assert!(root.join("diagnostics-v1-1000.json").is_file());
    }
}
