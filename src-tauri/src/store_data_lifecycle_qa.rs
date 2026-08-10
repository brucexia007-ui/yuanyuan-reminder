use std::{
    collections::BTreeMap,
    fs,
    io::{BufReader, Read, Write},
    path::{Path, PathBuf},
};

use chrono::{DateTime, Utc};
use rusqlite::{Connection, OpenFlags};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use uuid::Uuid;

use crate::error::{AppError, AppResult};

pub const APPLICATION_IDENTIFIER: &str = "com.yuanyuan.reminder";
pub const LOGICAL_DATA_ROOT: &str = "LOCALAPPDATA/com.yuanyuan.reminder";
pub const DATABASE_FILE_NAME: &str = "yuanyuan-reminder.sqlite3";
pub const EXPECTED_SCHEMA_VERSION: u32 = 11;
const SESSION_MARKER_FILE_NAME: &str = ".yuanyuan-store-data-lifecycle-v1.json";
const SESSION_MANIFEST_FILE_NAME: &str = "session.json";
const MAX_MARKER_BYTES: u64 = 16 * 1024;
const MAX_TABLES: usize = 32;
const EXPECTED_TABLES: [&str; 10] = [
    "activity_tracking_state",
    "companion_attention_budget",
    "companion_proactive_attention",
    "focus_sessions",
    "occurrences",
    "pet_interactions",
    "reminders",
    "settings",
    "task_watch_attention_deferrals",
    "water_log",
];

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum Checkpoint {
    NsisBefore,
    MsixAfter,
    BackupBaseline,
    BackupMutated,
    BackupRestored,
    UpdateBefore,
    UpdateAfter,
    UninstallKeepBefore,
    UninstallKeepReinstalled,
    DeleteBefore,
}

impl Checkpoint {
    pub fn parse(value: &str) -> AppResult<Self> {
        match value {
            "nsis_before" => Ok(Self::NsisBefore),
            "msix_after" => Ok(Self::MsixAfter),
            "backup_baseline" => Ok(Self::BackupBaseline),
            "backup_mutated" => Ok(Self::BackupMutated),
            "backup_restored" => Ok(Self::BackupRestored),
            "update_before" => Ok(Self::UpdateBefore),
            "update_after" => Ok(Self::UpdateAfter),
            "uninstall_keep_before" => Ok(Self::UninstallKeepBefore),
            "uninstall_keep_reinstalled" => Ok(Self::UninstallKeepReinstalled),
            "delete_before" => Ok(Self::DeleteBefore),
            _ => Err(AppError::Validation(format!(
                "unsupported Store data-lifecycle checkpoint: {value}"
            ))),
        }
    }

    pub fn as_str(self) -> &'static str {
        match self {
            Self::NsisBefore => "nsis_before",
            Self::MsixAfter => "msix_after",
            Self::BackupBaseline => "backup_baseline",
            Self::BackupMutated => "backup_mutated",
            Self::BackupRestored => "backup_restored",
            Self::UpdateBefore => "update_before",
            Self::UpdateAfter => "update_after",
            Self::UninstallKeepBefore => "uninstall_keep_before",
            Self::UninstallKeepReinstalled => "uninstall_keep_reinstalled",
            Self::DeleteBefore => "delete_before",
        }
    }
}

#[derive(Clone, Debug)]
pub struct InitializeRequest {
    pub session_id: Uuid,
    pub candidate_sha256: String,
    pub store_release_manifest_sha256: String,
    pub runtime_report_sha256: String,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct SessionRecord {
    schema_version: u16,
    mode: String,
    initialized_at: String,
    session_id: Uuid,
    application_identifier: String,
    logical_data_root: String,
    database_file_name: String,
    expected_schema_version: u32,
    candidate_sha256: String,
    store_release_manifest_sha256: String,
    runtime_report_sha256: String,
    synthetic_data_only: bool,
    disposable_windows_11_attested: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct CaptureBindings {
    candidate_sha256: String,
    store_release_manifest_sha256: String,
    runtime_report_sha256: String,
    session_manifest_sha256: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct DatabaseEvidence {
    file_name: &'static str,
    schema_version: u32,
    quick_check_ok: bool,
    logical_state_sha256: String,
    table_counts: BTreeMap<String, u64>,
    main_file_sha256: String,
    wal_present: bool,
    wal_sha256: Option<String>,
    shm_present: bool,
    source_stable_during_capture: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct PrivacyEvidence {
    synthetic_data_only: bool,
    real_user_data_accessed: bool,
    raw_user_content_recorded: bool,
    data_path_recorded: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct CheckpointReport {
    schema_version: u16,
    status: &'static str,
    generated_at: String,
    session_id: Uuid,
    checkpoint: Checkpoint,
    application_identifier: &'static str,
    logical_data_root: &'static str,
    bindings: CaptureBindings,
    database: DatabaseEvidence,
    privacy: PrivacyEvidence,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct DeletionReport {
    schema_version: u16,
    status: &'static str,
    generated_at: String,
    session_id: Uuid,
    checkpoint: &'static str,
    application_identifier: &'static str,
    logical_data_root: &'static str,
    session_manifest_sha256: String,
    data_root_absent: bool,
    database_absent: bool,
    backup_directory_absent: bool,
    logs_directory_absent: bool,
    privacy: PrivacyEvidence,
}

#[derive(Clone, Debug, PartialEq, Eq)]
struct OptionalFileIdentity {
    size_bytes: u64,
    sha256: String,
}

pub fn default_data_root() -> AppResult<PathBuf> {
    let base = dirs::data_local_dir().ok_or_else(|| {
        AppError::Validation("Windows LOCALAPPDATA directory is unavailable".into())
    })?;
    Ok(base.join(APPLICATION_IDENTIFIER))
}

pub fn default_evidence_root() -> AppResult<PathBuf> {
    let current = std::env::current_dir()?;
    let cargo_toml = current.join("Cargo.toml");
    let cargo_source = fs::read_to_string(&cargo_toml).map_err(|_| {
        AppError::Validation(
            "run the Store data-lifecycle QA tool from the project's src-tauri directory".into(),
        )
    })?;
    if !cargo_source.contains("name = \"yuanyuan-reminder\"") {
        return Err(AppError::Validation(
            "current directory is not the yuanyuan-reminder src-tauri directory".into(),
        ));
    }
    Ok(current.join("target").join("msix-store-data-lifecycle"))
}

pub fn initialize_session(
    data_root: &Path,
    evidence_root: &Path,
    request: &InitializeRequest,
) -> AppResult<PathBuf> {
    validate_session_id(request.session_id)?;
    validate_sha256("candidate", &request.candidate_sha256)?;
    validate_sha256(
        "Store release manifest",
        &request.store_release_manifest_sha256,
    )?;
    validate_sha256("runtime report", &request.runtime_report_sha256)?;
    if data_root.exists() {
        return Err(AppError::Validation(
            "fixed application data root already exists; use a fresh disposable Windows account and never reuse real user data"
                .into(),
        ));
    }

    fs::create_dir_all(evidence_root)?;
    let session_directory = session_directory(evidence_root, request.session_id);
    fs::create_dir(&session_directory).map_err(|error| {
        AppError::Validation(format!(
            "new evidence session directory could not be created without reuse: {error}"
        ))
    })?;
    fs::create_dir(data_root)?;
    reject_reparse_point(data_root, "application data root")?;

    let record = SessionRecord {
        schema_version: 1,
        mode: "synthetic_store_data_lifecycle_session".into(),
        initialized_at: Utc::now().to_rfc3339(),
        session_id: request.session_id,
        application_identifier: APPLICATION_IDENTIFIER.into(),
        logical_data_root: LOGICAL_DATA_ROOT.into(),
        database_file_name: DATABASE_FILE_NAME.into(),
        expected_schema_version: EXPECTED_SCHEMA_VERSION,
        candidate_sha256: request.candidate_sha256.clone(),
        store_release_manifest_sha256: request.store_release_manifest_sha256.clone(),
        runtime_report_sha256: request.runtime_report_sha256.clone(),
        synthetic_data_only: true,
        disposable_windows_11_attested: true,
    };
    let manifest_path = session_directory.join(SESSION_MANIFEST_FILE_NAME);
    write_new_json(&manifest_path, &record)?;
    write_new_json(&data_root.join(SESSION_MARKER_FILE_NAME), &record)?;
    Ok(manifest_path)
}

pub fn capture_checkpoint(
    data_root: &Path,
    evidence_root: &Path,
    session_id: Uuid,
    checkpoint: Checkpoint,
) -> AppResult<PathBuf> {
    validate_session_id(session_id)?;
    require_ordinary_directory(data_root, "application data root")?;
    let marker = read_session_record(&data_root.join(SESSION_MARKER_FILE_NAME))?;
    let manifest_path =
        session_directory(evidence_root, session_id).join(SESSION_MANIFEST_FILE_NAME);
    let manifest = read_session_record(&manifest_path)?;
    validate_matching_session(&marker, &manifest, session_id)?;

    let database_path = data_root.join(DATABASE_FILE_NAME);
    let before = database_file_set(&database_path)?;
    let connection = Connection::open_with_flags(
        &database_path,
        OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX,
    )?;
    let quick_check: String = connection.query_row("PRAGMA quick_check", [], |row| row.get(0))?;
    if quick_check != "ok" {
        return Err(AppError::Validation(format!(
            "database quick_check failed: {quick_check}"
        )));
    }
    let schema_version: u32 = connection.query_row("PRAGMA user_version", [], |row| row.get(0))?;
    if schema_version != EXPECTED_SCHEMA_VERSION {
        return Err(AppError::Validation(format!(
            "Store lifecycle database schema is {schema_version}, expected {EXPECTED_SCHEMA_VERSION}"
        )));
    }
    let schema = table_columns(&connection)?;
    if schema.len() > MAX_TABLES {
        return Err(AppError::Validation(format!(
            "database exposes {} application tables; privacy contract permits at most {MAX_TABLES}",
            schema.len()
        )));
    }
    let actual_tables = schema.keys().map(String::as_str).collect::<Vec<_>>();
    if actual_tables != EXPECTED_TABLES {
        return Err(AppError::Validation(
            "schema-11 database table boundary drifted from the fixed production table set".into(),
        ));
    }
    let counts = table_counts(&connection, schema.keys())?;
    let rows = canonical_rows(&connection, &schema)?;
    let logical_state_sha256 = logical_digest(&schema, &rows);
    drop(connection);
    let after = database_file_set(&database_path)?;
    if before != after {
        return Err(AppError::Validation(
            "database, WAL, or SHM changed during capture; fully exit the application and retry with a new checkpoint report"
                .into(),
        ));
    }

    let main = before
        .get("main")
        .and_then(Clone::clone)
        .ok_or_else(|| AppError::Validation("fixed application database is missing".into()))?;
    let wal = before.get("wal").and_then(Clone::clone);
    let report = CheckpointReport {
        schema_version: 1,
        status: "captured_synthetic_store_data_lifecycle_checkpoint",
        generated_at: Utc::now().to_rfc3339(),
        session_id,
        checkpoint,
        application_identifier: APPLICATION_IDENTIFIER,
        logical_data_root: LOGICAL_DATA_ROOT,
        bindings: CaptureBindings {
            candidate_sha256: marker.candidate_sha256,
            store_release_manifest_sha256: marker.store_release_manifest_sha256,
            runtime_report_sha256: marker.runtime_report_sha256,
            session_manifest_sha256: sha256_file(&manifest_path)?,
        },
        database: DatabaseEvidence {
            file_name: DATABASE_FILE_NAME,
            schema_version,
            quick_check_ok: true,
            logical_state_sha256,
            table_counts: counts,
            main_file_sha256: main.sha256,
            wal_present: wal.is_some(),
            wal_sha256: wal.map(|identity| identity.sha256),
            shm_present: before.get("shm").is_some_and(Option::is_some),
            source_stable_during_capture: true,
        },
        privacy: privacy_evidence(),
    };
    let report_path =
        session_directory(evidence_root, session_id).join(format!("{}.json", checkpoint.as_str()));
    write_new_json(&report_path, &report)?;
    Ok(report_path)
}

pub fn observe_explicit_deletion(
    data_root: &Path,
    evidence_root: &Path,
    session_id: Uuid,
) -> AppResult<PathBuf> {
    validate_session_id(session_id)?;
    if data_root.exists() {
        return Err(AppError::Validation(
            "fixed application data root still exists after explicit in-app deletion".into(),
        ));
    }
    let manifest_path =
        session_directory(evidence_root, session_id).join(SESSION_MANIFEST_FILE_NAME);
    let manifest = read_session_record(&manifest_path)?;
    validate_session_record(&manifest, session_id)?;
    let report = DeletionReport {
        schema_version: 1,
        status: "observed_explicit_store_data_lifecycle_deletion",
        generated_at: Utc::now().to_rfc3339(),
        session_id,
        checkpoint: "delete_after",
        application_identifier: APPLICATION_IDENTIFIER,
        logical_data_root: LOGICAL_DATA_ROOT,
        session_manifest_sha256: sha256_file(&manifest_path)?,
        data_root_absent: true,
        database_absent: true,
        backup_directory_absent: true,
        logs_directory_absent: true,
        privacy: privacy_evidence(),
    };
    let report_path = session_directory(evidence_root, session_id).join("delete_after.json");
    write_new_json(&report_path, &report)?;
    Ok(report_path)
}

fn privacy_evidence() -> PrivacyEvidence {
    PrivacyEvidence {
        synthetic_data_only: true,
        real_user_data_accessed: false,
        raw_user_content_recorded: false,
        data_path_recorded: false,
    }
}

fn session_directory(evidence_root: &Path, session_id: Uuid) -> PathBuf {
    evidence_root.join(session_id.hyphenated().to_string())
}

fn validate_session_id(session_id: Uuid) -> AppResult<()> {
    if session_id.is_nil() {
        return Err(AppError::Validation(
            "session ID must be a non-nil UUID".into(),
        ));
    }
    Ok(())
}

fn validate_sha256(label: &str, value: &str) -> AppResult<()> {
    if value.len() != 64
        || !value
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'A'..=b'F').contains(&byte))
    {
        return Err(AppError::Validation(format!(
            "{label} SHA-256 must be 64 uppercase hexadecimal characters"
        )));
    }
    Ok(())
}

fn read_session_record(path: &Path) -> AppResult<SessionRecord> {
    let metadata = fs::symlink_metadata(path)?;
    if metadata.len() > MAX_MARKER_BYTES {
        return Err(AppError::Validation(
            "session record exceeds the fixed size limit".into(),
        ));
    }
    reject_non_ordinary_file(path, "session record")?;
    let record: SessionRecord = serde_json::from_slice(&fs::read(path)?)?;
    Ok(record)
}

fn validate_matching_session(
    marker: &SessionRecord,
    manifest: &SessionRecord,
    session_id: Uuid,
) -> AppResult<()> {
    validate_session_record(marker, session_id)?;
    validate_session_record(manifest, session_id)?;
    let marker_bytes = serde_json::to_vec(marker)?;
    let manifest_bytes = serde_json::to_vec(manifest)?;
    if marker_bytes != manifest_bytes {
        return Err(AppError::Validation(
            "application data marker drifted from the external session manifest".into(),
        ));
    }
    Ok(())
}

fn validate_session_record(record: &SessionRecord, session_id: Uuid) -> AppResult<()> {
    if record.schema_version != 1
        || record.mode != "synthetic_store_data_lifecycle_session"
        || record.session_id != session_id
        || record.application_identifier != APPLICATION_IDENTIFIER
        || record.logical_data_root != LOGICAL_DATA_ROOT
        || record.database_file_name != DATABASE_FILE_NAME
        || record.expected_schema_version != EXPECTED_SCHEMA_VERSION
        || !record.synthetic_data_only
        || !record.disposable_windows_11_attested
        || DateTime::parse_from_rfc3339(&record.initialized_at).is_err()
    {
        return Err(AppError::Validation(
            "Store data-lifecycle session record is invalid or belongs to another boundary".into(),
        ));
    }
    validate_sha256("candidate", &record.candidate_sha256)?;
    validate_sha256(
        "Store release manifest",
        &record.store_release_manifest_sha256,
    )?;
    validate_sha256("runtime report", &record.runtime_report_sha256)
}

fn require_ordinary_directory(path: &Path, label: &str) -> AppResult<()> {
    let metadata = fs::symlink_metadata(path)?;
    if !metadata.file_type().is_dir() || metadata.file_type().is_symlink() {
        return Err(AppError::Validation(format!(
            "{label} is not an ordinary directory"
        )));
    }
    reject_reparse_point(path, label)
}

fn reject_non_ordinary_file(path: &Path, label: &str) -> AppResult<()> {
    let metadata = fs::symlink_metadata(path)?;
    if !metadata.file_type().is_file() || metadata.file_type().is_symlink() {
        return Err(AppError::Validation(format!(
            "{label} is not an ordinary file"
        )));
    }
    reject_reparse_point(path, label)
}

#[cfg(windows)]
fn reject_reparse_point(path: &Path, label: &str) -> AppResult<()> {
    use std::os::windows::fs::MetadataExt;
    const FILE_ATTRIBUTE_REPARSE_POINT: u32 = 0x400;
    if fs::symlink_metadata(path)?.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT != 0 {
        return Err(AppError::Validation(format!(
            "{label} must not be a reparse point"
        )));
    }
    Ok(())
}

#[cfg(not(windows))]
fn reject_reparse_point(_path: &Path, _label: &str) -> AppResult<()> {
    Ok(())
}

fn database_file_set(
    path: &Path,
) -> AppResult<BTreeMap<&'static str, Option<OptionalFileIdentity>>> {
    let mut files = BTreeMap::new();
    files.insert("main", optional_file_identity(path)?);
    files.insert("wal", optional_file_identity(&append_suffix(path, "-wal"))?);
    files.insert("shm", optional_file_identity(&append_suffix(path, "-shm"))?);
    Ok(files)
}

fn append_suffix(path: &Path, suffix: &str) -> PathBuf {
    let mut value = path.as_os_str().to_owned();
    value.push(suffix);
    PathBuf::from(value)
}

fn optional_file_identity(path: &Path) -> AppResult<Option<OptionalFileIdentity>> {
    if !path.exists() {
        return Ok(None);
    }
    reject_non_ordinary_file(path, "database evidence component")?;
    let metadata = fs::metadata(path)?;
    Ok(Some(OptionalFileIdentity {
        size_bytes: metadata.len(),
        sha256: sha256_file(path)?,
    }))
}

fn table_columns(connection: &Connection) -> AppResult<BTreeMap<String, Vec<String>>> {
    let mut statement = connection.prepare(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
    )?;
    let names = statement
        .query_map([], |row| row.get::<_, String>(0))?
        .collect::<Result<Vec<_>, _>>()?;
    let mut schema = BTreeMap::new();
    for name in names {
        let escaped = name.replace('"', "\"\"");
        let mut columns_statement =
            connection.prepare(&format!("PRAGMA table_info(\"{escaped}\")"))?;
        let columns = columns_statement
            .query_map([], |row| row.get::<_, String>(1))?
            .collect::<Result<Vec<_>, _>>()?;
        schema.insert(name, columns);
    }
    Ok(schema)
}

fn table_counts<'a>(
    connection: &Connection,
    tables: impl Iterator<Item = &'a String>,
) -> AppResult<BTreeMap<String, u64>> {
    let mut counts = BTreeMap::new();
    for name in tables {
        let escaped = name.replace('"', "\"\"");
        let count: u64 =
            connection.query_row(&format!("SELECT COUNT(*) FROM \"{escaped}\""), [], |row| {
                row.get(0)
            })?;
        counts.insert(name.clone(), count);
    }
    Ok(counts)
}

fn canonical_rows(
    connection: &Connection,
    schema: &BTreeMap<String, Vec<String>>,
) -> AppResult<BTreeMap<String, Vec<Vec<u8>>>> {
    let mut snapshot = BTreeMap::new();
    for (table, columns) in schema {
        let table_sql = table.replace('"', "\"\"");
        let projections = columns
            .iter()
            .map(|column| format!("quote(\"{}\")", column.replace('"', "\"\"")))
            .collect::<Vec<_>>()
            .join(", ");
        let mut statement =
            connection.prepare(&format!("SELECT {projections} FROM \"{table_sql}\""))?;
        let mut rows = statement.query([])?;
        let mut canonical = Vec::new();
        while let Some(row) = rows.next()? {
            let mut encoded = Vec::new();
            for index in 0..columns.len() {
                let value: String = row.get(index)?;
                encoded.extend_from_slice(&(value.len() as u64).to_le_bytes());
                encoded.extend_from_slice(value.as_bytes());
            }
            canonical.push(encoded);
        }
        canonical.sort();
        snapshot.insert(table.clone(), canonical);
    }
    Ok(snapshot)
}

fn logical_digest(
    schema: &BTreeMap<String, Vec<String>>,
    rows: &BTreeMap<String, Vec<Vec<u8>>>,
) -> String {
    let mut hasher = Sha256::new();
    for (table, columns) in schema {
        digest_field(&mut hasher, table.as_bytes());
        for column in columns {
            digest_field(&mut hasher, column.as_bytes());
        }
        for row in rows.get(table).into_iter().flatten() {
            digest_field(&mut hasher, row);
        }
    }
    format!("{:X}", hasher.finalize())
}

fn digest_field(hasher: &mut Sha256, value: &[u8]) {
    hasher.update((value.len() as u64).to_le_bytes());
    hasher.update(value);
}

fn sha256_file(path: &Path) -> AppResult<String> {
    let mut reader = BufReader::new(fs::File::open(path)?);
    let mut hasher = Sha256::new();
    let mut buffer = [0_u8; 64 * 1024];
    loop {
        let read = reader.read(&mut buffer)?;
        if read == 0 {
            break;
        }
        hasher.update(&buffer[..read]);
    }
    Ok(format!("{:X}", hasher.finalize()))
}

fn write_new_json(path: &Path, value: &impl Serialize) -> AppResult<()> {
    let mut file = fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(path)?;
    let result = (|| {
        file.write_all(&serde_json::to_vec_pretty(value)?)?;
        file.write_all(b"\n")?;
        file.sync_all()?;
        Ok(())
    })();
    if result.is_err() {
        let _ = fs::remove_file(path);
    }
    result
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    fn request(session_id: Uuid) -> InitializeRequest {
        InitializeRequest {
            session_id,
            candidate_sha256: "A".repeat(64),
            store_release_manifest_sha256: "B".repeat(64),
            runtime_report_sha256: "C".repeat(64),
        }
    }

    fn create_schema_11_database(path: &Path, rows: &[(&str, &str)]) {
        let connection = Connection::open(path).unwrap();
        for migration in [
            include_str!("../migrations/001_initial.sql"),
            include_str!("../migrations/002_focus_sessions.sql"),
            include_str!("../migrations/003_pet_interactions.sql"),
            include_str!("../migrations/004_ball_interaction.sql"),
            include_str!("../migrations/005_occurrence_history.sql"),
            include_str!("../migrations/006_activity_tracking.sql"),
            include_str!("../migrations/007_reminder_management.sql"),
            include_str!("../migrations/008_companion_attention_budget.sql"),
            include_str!("../migrations/009_companion_proactive_attention.sql"),
            include_str!("../migrations/010_companion_reunion_attention.sql"),
            include_str!("../migrations/011_task_watch_attention_deferrals.sql"),
        ] {
            connection.execute_batch(migration).unwrap();
        }
        connection
            .execute(
                "UPDATE activity_tracking_state SET updated_at = '2026-08-11 00:00:00' WHERE id = 1",
                [],
            )
            .unwrap();
        for (id, title) in rows {
            connection
                .execute(
                    "INSERT INTO reminders(
                        id, title, category, schedule_kind, schedule_json, timezone,
                        enabled, next_due_at, created_at, updated_at
                    ) VALUES(
                        ?1, ?2, 'work', 'once', '{}', 'Asia/Shanghai', 1,
                        '2035-01-01T09:00:00Z', '2026-08-11T00:00:00Z',
                        '2026-08-11T00:00:00Z'
                    )",
                    [id, title],
                )
                .unwrap();
        }
    }

    fn read_json(path: &Path) -> serde_json::Value {
        serde_json::from_slice(&fs::read(path).unwrap()).unwrap()
    }

    #[test]
    fn checkpoint_allowlist_is_exact() {
        for value in [
            "nsis_before",
            "msix_after",
            "backup_baseline",
            "backup_mutated",
            "backup_restored",
            "update_before",
            "update_after",
            "uninstall_keep_before",
            "uninstall_keep_reinstalled",
            "delete_before",
        ] {
            assert_eq!(Checkpoint::parse(value).unwrap().as_str(), value);
        }
        assert!(Checkpoint::parse("arbitrary_dump").is_err());
        assert!(Checkpoint::parse("delete_after").is_err());
    }

    #[test]
    fn initialization_requires_a_new_root_and_preserves_siblings() {
        let temp = TempDir::new().unwrap();
        let data_root = temp
            .path()
            .join("LocalAppData")
            .join(APPLICATION_IDENTIFIER);
        let evidence_root = temp.path().join("evidence");
        let sibling = temp.path().join("LocalAppData").join("sibling.txt");
        fs::create_dir_all(sibling.parent().unwrap()).unwrap();
        fs::write(&sibling, b"preserve").unwrap();
        let session_id = Uuid::new_v4();
        initialize_session(&data_root, &evidence_root, &request(session_id)).unwrap();
        assert_eq!(fs::read(&sibling).unwrap(), b"preserve");
        assert!(initialize_session(&data_root, &evidence_root, &request(Uuid::new_v4())).is_err());
    }

    #[test]
    fn captures_only_aggregate_counts_and_a_canonical_digest() {
        let temp = TempDir::new().unwrap();
        let data_root = temp.path().join(APPLICATION_IDENTIFIER);
        let evidence_root = temp.path().join("evidence");
        let session_id = Uuid::new_v4();
        initialize_session(&data_root, &evidence_root, &request(session_id)).unwrap();
        create_schema_11_database(
            &data_root.join(DATABASE_FILE_NAME),
            &[("2", "private beta"), ("1", "private alpha")],
        );
        let report_path = capture_checkpoint(
            &data_root,
            &evidence_root,
            session_id,
            Checkpoint::NsisBefore,
        )
        .unwrap();
        let report_text = fs::read_to_string(&report_path).unwrap();
        assert!(!report_text.contains("private alpha"));
        assert!(!report_text.contains(temp.path().to_string_lossy().as_ref()));
        let report = read_json(&report_path);
        assert_eq!(report["database"]["tableCounts"]["reminders"], 2);
        assert_eq!(report["database"]["schemaVersion"], 11);
        assert_eq!(report["privacy"]["rawUserContentRecorded"], false);
        assert_eq!(
            report["database"]["logicalStateSha256"]
                .as_str()
                .unwrap()
                .len(),
            64
        );
    }

    #[test]
    fn logical_digest_is_row_order_independent_and_changes_with_content() {
        fn digest_for(rows: &[(&str, &str)]) -> String {
            let temp = TempDir::new().unwrap();
            let path = temp.path().join("test.sqlite3");
            create_schema_11_database(&path, rows);
            let connection =
                Connection::open_with_flags(path, OpenFlags::SQLITE_OPEN_READ_ONLY).unwrap();
            let schema = table_columns(&connection).unwrap();
            logical_digest(&schema, &canonical_rows(&connection, &schema).unwrap())
        }
        let first = digest_for(&[("1", "alpha"), ("2", "beta")]);
        let reordered = digest_for(&[("2", "beta"), ("1", "alpha")]);
        let changed = digest_for(&[("1", "alpha"), ("2", "changed")]);
        assert_eq!(first, reordered);
        assert_ne!(first, changed);
    }

    #[test]
    fn rejects_marker_drift_schema_drift_and_report_overwrite() {
        let temp = TempDir::new().unwrap();
        let data_root = temp.path().join(APPLICATION_IDENTIFIER);
        let evidence_root = temp.path().join("evidence");
        let session_id = Uuid::new_v4();
        initialize_session(&data_root, &evidence_root, &request(session_id)).unwrap();
        let marker_path = data_root.join(SESSION_MARKER_FILE_NAME);
        let mut marker = read_json(&marker_path);
        marker["unexpected"] = serde_json::json!(true);
        fs::write(&marker_path, serde_json::to_vec(&marker).unwrap()).unwrap();
        create_schema_11_database(&data_root.join(DATABASE_FILE_NAME), &[]);
        assert!(capture_checkpoint(
            &data_root,
            &evidence_root,
            session_id,
            Checkpoint::NsisBefore
        )
        .is_err());

        fs::write(
            &marker_path,
            fs::read(
                session_directory(&evidence_root, session_id).join(SESSION_MANIFEST_FILE_NAME),
            )
            .unwrap(),
        )
        .unwrap();
        let connection = Connection::open(data_root.join(DATABASE_FILE_NAME)).unwrap();
        connection
            .execute_batch("PRAGMA user_version = 10;")
            .unwrap();
        drop(connection);
        assert!(capture_checkpoint(
            &data_root,
            &evidence_root,
            session_id,
            Checkpoint::NsisBefore
        )
        .is_err());

        let connection = Connection::open(data_root.join(DATABASE_FILE_NAME)).unwrap();
        connection
            .execute_batch("PRAGMA user_version = 11;")
            .unwrap();
        drop(connection);
        capture_checkpoint(
            &data_root,
            &evidence_root,
            session_id,
            Checkpoint::NsisBefore,
        )
        .unwrap();
        let first_report_path =
            session_directory(&evidence_root, session_id).join("nsis_before.json");
        let first_report_bytes = fs::read(&first_report_path).unwrap();
        assert!(capture_checkpoint(
            &data_root,
            &evidence_root,
            session_id,
            Checkpoint::NsisBefore
        )
        .is_err());
        assert_eq!(fs::read(first_report_path).unwrap(), first_report_bytes);
    }

    #[test]
    fn deletion_observation_requires_the_entire_fixed_root_to_be_absent() {
        let temp = TempDir::new().unwrap();
        let data_root = temp.path().join(APPLICATION_IDENTIFIER);
        let evidence_root = temp.path().join("evidence");
        let session_id = Uuid::new_v4();
        initialize_session(&data_root, &evidence_root, &request(session_id)).unwrap();
        assert!(observe_explicit_deletion(&data_root, &evidence_root, session_id).is_err());
        fs::remove_dir_all(&data_root).unwrap();
        let report = observe_explicit_deletion(&data_root, &evidence_root, session_id).unwrap();
        let json = read_json(&report);
        assert_eq!(json["dataRootAbsent"], true);
        assert_eq!(json["databaseAbsent"], true);
        assert_eq!(json["privacy"]["realUserDataAccessed"], false);
    }
}
