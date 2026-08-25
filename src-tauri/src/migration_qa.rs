use std::{
    collections::BTreeMap,
    ffi::{OsStr, OsString},
    fs,
    io::{BufReader, Read, Write},
    path::{Path, PathBuf},
};

use chrono::Utc;
use rusqlite::{backup::Progress, Connection, OpenFlags, MAIN_DB};
use serde::Serialize;
use sha2::{Digest, Sha256};
use uuid::Uuid;

use crate::{
    backups,
    error::{AppError, AppResult},
    models::CreateReminderInput,
    repository::Repository,
};

const V132_SCHEMA_VERSION: u32 = 6;
const CURRENT_SCHEMA_VERSION: u32 = if cfg!(feature = "learning") { 12 } else { 11 };
const CURRENT_MIGRATION_CHECK_DETAIL: &str = if cfg!(feature = "learning") {
    "production Repository::open migrated the copy to unified schema version 12"
} else {
    "production Repository::open migrated the copy to compatibility schema version 11"
};
const MAX_FIXTURE_BYTES: u64 = 512 * 1024 * 1024;

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct MigrationQaReport {
    schema_version: u32,
    status: &'static str,
    generated_at: String,
    expected_source_release: &'static str,
    source_release_evidence: &'static str,
    source_release_evidence_limit: &'static str,
    source_file_name: String,
    source_size_bytes: u64,
    source_sha256: String,
    source_database_version: u32,
    migrated_database_version: u32,
    source_logical_sha256: String,
    migrated_matched_source_rows_sha256: String,
    source_table_counts: BTreeMap<String, u64>,
    migrated_table_counts: BTreeMap<String, u64>,
    checks: Vec<MigrationQaCheck>,
    privacy: &'static str,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct MigrationQaCheck {
    id: &'static str,
    passed: bool,
    detail: &'static str,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct RuntimeFixtureCaptureReport {
    schema_version: u32,
    status: &'static str,
    generated_at: String,
    expected_source_release: &'static str,
    source_release_evidence: &'static str,
    source_database_version: u32,
    source_main_size_bytes: u64,
    source_main_sha256: String,
    source_wal_present: bool,
    source_wal_size_bytes: Option<u64>,
    source_wal_sha256: Option<String>,
    source_shm_present: bool,
    source_stable_during_capture: bool,
    fixture_file_name: String,
    fixture_size_bytes: u64,
    fixture_sha256: String,
    fixture_logical_sha256: String,
    fixture_table_counts: BTreeMap<String, u64>,
    checks: Vec<MigrationQaCheck>,
    privacy: &'static str,
}

#[derive(Debug, PartialEq, Eq)]
struct OptionalFileIdentity {
    size_bytes: u64,
    sha256: String,
}

struct TempQaArea(PathBuf);

impl Drop for TempQaArea {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

struct PendingFixtureOutput {
    path: PathBuf,
    persist: bool,
}

impl PendingFixtureOutput {
    fn new(path: PathBuf) -> Self {
        Self {
            path,
            persist: false,
        }
    }

    fn persist(mut self) {
        self.persist = true;
    }
}

impl Drop for PendingFixtureOutput {
    fn drop(&mut self) {
        if self.persist {
            return;
        }
        for suffix in ["-wal", "-shm", "-journal"] {
            let _ = fs::remove_file(append_suffix(&self.path, suffix));
        }
        let _ = fs::remove_file(&self.path);
    }
}

pub fn run_v132_database_qa(source_path: &Path, report_path: &Path) -> Result<PathBuf, String> {
    run_v132_database_qa_inner(source_path, report_path).map_err(|error| error.to_string())
}

pub fn capture_v132_runtime_fixture(
    source_path: &Path,
    fixture_path: &Path,
    report_path: &Path,
) -> Result<PathBuf, String> {
    capture_v132_runtime_fixture_inner(source_path, fixture_path, report_path)
        .map_err(|error| error.to_string())
}

fn capture_v132_runtime_fixture_inner(
    source_path: &Path,
    fixture_path: &Path,
    report_path: &Path,
) -> AppResult<PathBuf> {
    let source_path = validate_runtime_source(source_path)?;
    let fixture_path = resolve_new_output(fixture_path, "fixture", "sqlite3", &[&source_path])?;
    let report_path = resolve_new_output(
        report_path,
        "capture report",
        "json",
        &[&source_path, &fixture_path],
    )?;
    let pending_fixture = PendingFixtureOutput::new(fixture_path.clone());
    let source_main_before = required_file_identity(&source_path)?;
    let source_wal_path = append_suffix(&source_path, "-wal");
    let source_shm_path = append_suffix(&source_path, "-shm");
    let source_wal_before = optional_file_identity(&source_wal_path)?;
    let source_shm_present = source_shm_path.exists();

    let source = Connection::open_with_flags(&source_path, OpenFlags::SQLITE_OPEN_READ_ONLY)?;
    assert_integrity(&source)?;
    let source_version = database_version(&source)?;
    if source_version != V132_SCHEMA_VERSION {
        return Err(AppError::Validation(format!(
            "expected a v1.3.2 schema-version-{V132_SCHEMA_VERSION} database, found version {source_version}"
        )));
    }
    let source_counts = table_counts(&source)?;
    let source_schema = table_columns(&source)?;
    let source_rows = canonical_rows(&source, &source_schema)?;
    let source_logical_sha256 = logical_digest(&source_schema, &source_rows);
    source.backup(MAIN_DB, &fixture_path, None::<fn(Progress)>)?;
    drop(source);

    let source_main_after = required_file_identity(&source_path)?;
    let source_wal_after = optional_file_identity(&source_wal_path)?;
    if source_main_after != source_main_before || source_wal_after != source_wal_before {
        let _ = fs::remove_file(&fixture_path);
        return Err(AppError::Validation(
            "runtime source database changed during capture; stop the old application and retry"
                .into(),
        ));
    }

    let fixture_writer = Connection::open(&fixture_path)?;
    let journal_mode: String =
        fixture_writer.query_row("PRAGMA journal_mode = DELETE", [], |row| row.get(0))?;
    drop(fixture_writer);
    if !journal_mode.eq_ignore_ascii_case("delete") {
        let _ = fs::remove_file(&fixture_path);
        return Err(AppError::Validation(
            "captured fixture could not be normalized to a standalone rollback journal".into(),
        ));
    }

    for suffix in ["-wal", "-shm"] {
        if append_suffix(&fixture_path, suffix).exists() {
            let _ = fs::remove_file(&fixture_path);
            return Err(AppError::Validation(format!(
                "captured fixture unexpectedly has a {suffix} sidecar"
            )));
        }
    }
    let fixture = Connection::open_with_flags(&fixture_path, OpenFlags::SQLITE_OPEN_READ_ONLY)?;
    assert_integrity(&fixture)?;
    let fixture_version = database_version(&fixture)?;
    if fixture_version != V132_SCHEMA_VERSION {
        drop(fixture);
        let _ = fs::remove_file(&fixture_path);
        return Err(AppError::Validation(format!(
            "captured fixture has schema version {fixture_version}, expected {V132_SCHEMA_VERSION}"
        )));
    }
    let fixture_counts = table_counts(&fixture)?;
    let fixture_schema = table_columns(&fixture)?;
    let fixture_rows = canonical_rows(&fixture, &fixture_schema)?;
    let fixture_logical_sha256 = logical_digest(&fixture_schema, &fixture_rows);
    drop(fixture);
    if fixture_counts != source_counts || fixture_logical_sha256 != source_logical_sha256 {
        let _ = fs::remove_file(&fixture_path);
        return Err(AppError::Validation(
            "captured fixture does not exactly match the runtime source logical contents".into(),
        ));
    }

    let fixture_identity = required_file_identity(&fixture_path)?;
    let fixture_file_name = fixture_path
        .file_name()
        .and_then(OsStr::to_str)
        .ok_or_else(|| AppError::Validation("fixture file name is not valid UTF-8".into()))?
        .to_owned();
    let report = RuntimeFixtureCaptureReport {
        schema_version: 1,
        status: "passed",
        generated_at: Utc::now().to_rfc3339(),
        expected_source_release: "1.3.2",
        source_release_evidence: "exact_tag_runtime_plus_operator_attestation",
        source_database_version: source_version,
        source_main_size_bytes: source_main_before.size_bytes,
        source_main_sha256: source_main_before.sha256,
        source_wal_present: source_wal_before.is_some(),
        source_wal_size_bytes: source_wal_before.as_ref().map(|value| value.size_bytes),
        source_wal_sha256: source_wal_before.map(|value| value.sha256),
        source_shm_present,
        source_stable_during_capture: true,
        fixture_file_name,
        fixture_size_bytes: fixture_identity.size_bytes,
        fixture_sha256: fixture_identity.sha256,
        fixture_logical_sha256,
        fixture_table_counts: fixture_counts,
        checks: vec![
            check("source_integrity", "runtime source PRAGMA quick_check returned ok"),
            check("v132_schema_identity", "runtime source PRAGMA user_version was exactly 6"),
            check("source_stability", "source database and WAL hashes were unchanged during capture"),
            check("sqlite_backup", "SQLite backup API produced a standalone fixture without sidecars"),
            check("logical_identity", "captured table, column and value digest exactly matched the runtime source"),
        ],
        privacy: "Contains only database hashes, sizes, schema version, aggregate table counts and fixed check results; no source path or user content.",
    };
    write_new_json(&report_path, &report)?;
    pending_fixture.persist();
    Ok(report_path)
}

fn run_v132_database_qa_inner(source_path: &Path, report_path: &Path) -> AppResult<PathBuf> {
    let source_path = validate_source_fixture(source_path)?;
    let report_path = resolve_report_destination(report_path, &source_path)?;
    let source_metadata = fs::metadata(&source_path)?;
    let source_sha256 = sha256_file(&source_path)?;
    let source_file_name = source_path
        .file_name()
        .and_then(OsStr::to_str)
        .ok_or_else(|| AppError::Validation("fixture file name is not valid UTF-8".into()))?
        .to_owned();

    let source = Connection::open_with_flags(&source_path, OpenFlags::SQLITE_OPEN_READ_ONLY)?;
    assert_integrity(&source)?;
    let source_version = database_version(&source)?;
    if source_version != V132_SCHEMA_VERSION {
        return Err(AppError::Validation(format!(
            "expected a v1.3.2 schema-version-{V132_SCHEMA_VERSION} database, found version {source_version}"
        )));
    }
    let source_counts = table_counts(&source)?;
    let source_schema = table_columns(&source)?;
    let source_rows = canonical_rows(&source, &source_schema)?;
    let source_logical_sha256 = logical_digest(&source_schema, &source_rows);

    let temp = TempQaArea(
        std::env::temp_dir().join(format!("yuanyuan-v132-migration-qa-{}", Uuid::new_v4())),
    );
    fs::create_dir(&temp.0)?;
    let working_path = temp.0.join("working.sqlite3");
    source.backup(MAIN_DB, &working_path, None::<fn(Progress)>)?;
    drop(source);

    let mut repository = Repository::open(&working_path)?;
    repository.get_settings()?;
    repository.list_today(false)?;
    repository.get_pet_care()?;
    repository.list_history(Some(30), None, None, None, 20)?;
    let migrated_version = read_database_version(&working_path)?;
    if migrated_version != CURRENT_SCHEMA_VERSION {
        return Err(AppError::Validation(format!(
            "production migration ended at schema version {migrated_version}, expected {CURRENT_SCHEMA_VERSION}"
        )));
    }
    let migrated_counts = read_table_counts(&working_path)?;
    assert_no_source_rows_lost(&source_counts, &migrated_counts)?;
    let migrated_rows = {
        let connection =
            Connection::open_with_flags(&working_path, OpenFlags::SQLITE_OPEN_READ_ONLY)?;
        canonical_rows(&connection, &source_schema)?
    };
    let matched_source_rows = match_source_rows(&source_rows, &migrated_rows)?;
    let migrated_matched_source_rows_sha256 = logical_digest(&source_schema, &matched_source_rows);

    let backup_dir = temp.0.join("backups");
    let baseline_backup = backups::create_manual_backup(&repository, &backup_dir)?;
    let mutation = repository.create_reminder(qa_reminder("restore-mutation"))?;
    if repository.get_reminder(&mutation.id)?.is_none() {
        return Err(AppError::Validation(
            "isolated restore mutation was not written".into(),
        ));
    }
    backups::restore_backup(&mut repository, &backup_dir, &baseline_backup.file_name)?;
    if repository.get_reminder(&mutation.id)?.is_some() {
        return Err(AppError::Validation(
            "successful restore did not remove the isolated mutation".into(),
        ));
    }
    if read_table_counts(&working_path)? != migrated_counts {
        return Err(AppError::Validation(
            "successful restore did not reproduce the migrated database table counts".into(),
        ));
    }

    let rollback_sentinel = repository.create_reminder(qa_reminder("rollback-sentinel"))?;
    let failing_name = "manual-forced-migration-failure.sqlite3";
    let failing_path = backup_dir.join(failing_name);
    let source = Connection::open_with_flags(&source_path, OpenFlags::SQLITE_OPEN_READ_ONLY)?;
    source.backup(MAIN_DB, &failing_path, None::<fn(Progress)>)?;
    drop(source);
    let failing = Connection::open(&failing_path)?;
    failing.execute_batch("ALTER TABLE reminders ADD COLUMN archived_at TEXT;")?;
    drop(failing);
    Repository::validate_database_file(&failing_path)?;

    if backups::restore_backup(&mut repository, &backup_dir, failing_name).is_ok() {
        return Err(AppError::Validation(
            "the deliberately incompatible v6 restore unexpectedly succeeded".into(),
        ));
    }
    if repository.get_reminder(&rollback_sentinel.id)?.is_none() {
        return Err(AppError::Validation(
            "failed restore did not roll back to its safety snapshot".into(),
        ));
    }
    repository.get_settings()?;
    repository.list_today(false)?;
    drop(repository);

    let source_sha256_after = sha256_file(&source_path)?;
    if source_sha256_after != source_sha256 {
        return Err(AppError::Validation(
            "source fixture changed during QA; evidence is invalid".into(),
        ));
    }

    let report = MigrationQaReport {
        schema_version: 1,
        status: "passed",
        generated_at: Utc::now().to_rfc3339(),
        expected_source_release: "1.3.2",
        source_release_evidence: "operator_attested_copy_plus_schema_version_6",
        source_release_evidence_limit: "Schema version 6 is necessary but does not independently prove which application release created the fixture.",
        source_file_name,
        source_size_bytes: source_metadata.len(),
        source_sha256,
        source_database_version: source_version,
        migrated_database_version: migrated_version,
        source_logical_sha256,
        migrated_matched_source_rows_sha256,
        source_table_counts: source_counts,
        migrated_table_counts: migrated_counts,
        checks: vec![
            check("source_read_only", "source hash unchanged before and after QA"),
            check("source_integrity", "source PRAGMA quick_check returned ok"),
            check("v132_schema_identity", "source PRAGMA user_version was exactly 6"),
            check("production_migration", CURRENT_MIGRATION_CHECK_DETAIL),
            check("row_preservation", "every original table, column and value has the same canonical logical digest after migration"),
            check("backup_restore", "a production backup removed an isolated post-backup mutation"),
            check("failed_restore_rollback", "an injected migration failure restored the safety snapshot"),
            check("post_restore_health", "production settings and today reads succeeded after rollback"),
        ],
        privacy: "Contains only file identity, schema versions, aggregate table counts and fixed check results; no user content or source path.",
    };
    let mut report_file = fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&report_path)?;
    report_file.write_all(&serde_json::to_vec_pretty(&report)?)?;
    report_file.sync_all()?;
    Ok(report_path)
}

fn validate_source_fixture(path: &Path) -> AppResult<PathBuf> {
    if !path.is_absolute() {
        return Err(AppError::Validation(
            "fixture path must be absolute so the evidence target is unambiguous".into(),
        ));
    }
    let link_metadata = fs::symlink_metadata(path)?;
    if link_metadata.file_type().is_symlink() || !link_metadata.file_type().is_file() {
        return Err(AppError::Validation(
            "fixture must be an ordinary database file, not a link or directory".into(),
        ));
    }
    if link_metadata.len() == 0 || link_metadata.len() > MAX_FIXTURE_BYTES {
        return Err(AppError::Validation(format!(
            "fixture size must be between 1 byte and {MAX_FIXTURE_BYTES} bytes"
        )));
    }
    for suffix in ["-wal", "-shm"] {
        let sidecar = append_suffix(path, suffix);
        if sidecar.exists() {
            return Err(AppError::Validation(format!(
                "fixture has a {suffix} sidecar; close the old app and provide a stable copied database"
            )));
        }
    }
    fs::canonicalize(path).map_err(Into::into)
}

fn validate_runtime_source(path: &Path) -> AppResult<PathBuf> {
    if !path.is_absolute() {
        return Err(AppError::Validation(
            "runtime source path must be absolute so the evidence target is unambiguous".into(),
        ));
    }
    let metadata = fs::symlink_metadata(path)?;
    if metadata.file_type().is_symlink() || !metadata.file_type().is_file() {
        return Err(AppError::Validation(
            "runtime source must be an ordinary database file, not a link or directory".into(),
        ));
    }
    if metadata.len() == 0 || metadata.len() > MAX_FIXTURE_BYTES {
        return Err(AppError::Validation(format!(
            "runtime source size must be between 1 byte and {MAX_FIXTURE_BYTES} bytes"
        )));
    }
    fs::canonicalize(path).map_err(Into::into)
}

fn resolve_new_output(
    path: &Path,
    label: &str,
    extension: &str,
    excluded_paths: &[&Path],
) -> AppResult<PathBuf> {
    if !path.is_absolute() {
        return Err(AppError::Validation(format!(
            "{label} path must be absolute"
        )));
    }
    if path.extension() != Some(OsStr::new(extension)) {
        return Err(AppError::Validation(format!(
            "{label} file name must end in .{extension}"
        )));
    }
    let file_name = path.file_name().ok_or_else(|| {
        AppError::Validation(format!("{label} path must include a plain file name"))
    })?;
    let parent = path.parent().ok_or_else(|| {
        AppError::Validation(format!(
            "{label} path must have an existing parent directory"
        ))
    })?;
    let parent_metadata = fs::symlink_metadata(parent)?;
    if parent_metadata.file_type().is_symlink() || !parent_metadata.is_dir() {
        return Err(AppError::Validation(format!(
            "{label} parent must be an existing ordinary directory"
        )));
    }
    let resolved = fs::canonicalize(parent)?.join(file_name);
    if excluded_paths.iter().any(|excluded| resolved == **excluded) {
        return Err(AppError::Validation(format!(
            "{label} path must not overwrite an input or other output"
        )));
    }
    if resolved.exists() {
        return Err(AppError::Validation(format!(
            "{label} target already exists; choose a new file name so evidence is never overwritten"
        )));
    }
    Ok(resolved)
}

fn resolve_report_destination(report: &Path, source: &Path) -> AppResult<PathBuf> {
    if !report.is_absolute() {
        return Err(AppError::Validation("report path must be absolute".into()));
    }
    if report.extension() != Some(OsStr::new("json")) {
        return Err(AppError::Validation(
            "report file name must end in .json".into(),
        ));
    }
    let file_name = report
        .file_name()
        .ok_or_else(|| AppError::Validation("report path must include a plain file name".into()))?;
    let parent = report.parent().ok_or_else(|| {
        AppError::Validation("report path must have an existing parent directory".into())
    })?;
    let parent_metadata = fs::symlink_metadata(parent)?;
    if parent_metadata.file_type().is_symlink() || !parent_metadata.is_dir() {
        return Err(AppError::Validation(
            "report parent must be an existing ordinary directory".into(),
        ));
    }
    let resolved = fs::canonicalize(parent)?.join(file_name);
    if resolved == source {
        return Err(AppError::Validation(
            "report path must not overwrite the source fixture".into(),
        ));
    }
    if resolved.exists() {
        return Err(AppError::Validation(
            "report target already exists; choose a new file name so evidence is never overwritten"
                .into(),
        ));
    }
    Ok(resolved)
}

fn append_suffix(path: &Path, suffix: &str) -> PathBuf {
    let mut value: OsString = path.as_os_str().to_owned();
    value.push(suffix);
    PathBuf::from(value)
}

fn assert_integrity(connection: &Connection) -> AppResult<()> {
    let integrity: String = connection.query_row("PRAGMA quick_check", [], |row| row.get(0))?;
    if integrity != "ok" {
        return Err(AppError::Validation(format!(
            "fixture integrity check failed: {integrity}"
        )));
    }
    Ok(())
}

fn database_version(connection: &Connection) -> AppResult<u32> {
    Ok(connection.query_row("PRAGMA user_version", [], |row| row.get(0))?)
}

fn read_database_version(path: &Path) -> AppResult<u32> {
    let connection = Connection::open_with_flags(path, OpenFlags::SQLITE_OPEN_READ_ONLY)?;
    database_version(&connection)
}

fn read_table_counts(path: &Path) -> AppResult<BTreeMap<String, u64>> {
    let connection = Connection::open_with_flags(path, OpenFlags::SQLITE_OPEN_READ_ONLY)?;
    table_counts(&connection)
}

fn table_counts(connection: &Connection) -> AppResult<BTreeMap<String, u64>> {
    let mut statement = connection.prepare(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
    )?;
    let names = statement
        .query_map([], |row| row.get::<_, String>(0))?
        .collect::<Result<Vec<_>, _>>()?;
    let mut counts = BTreeMap::new();
    for name in names {
        let escaped = name.replace('"', "\"\"");
        let count: u64 =
            connection.query_row(&format!("SELECT COUNT(*) FROM \"{escaped}\""), [], |row| {
                row.get(0)
            })?;
        counts.insert(name, count);
    }
    Ok(counts)
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
        let mut canonical_rows = Vec::new();
        while let Some(row) = rows.next()? {
            let mut encoded = Vec::new();
            for index in 0..columns.len() {
                let value: String = row.get(index)?;
                encoded.extend_from_slice(&(value.len() as u64).to_le_bytes());
                encoded.extend_from_slice(value.as_bytes());
            }
            canonical_rows.push(encoded);
        }
        canonical_rows.sort();
        snapshot.insert(table.clone(), canonical_rows);
    }
    Ok(snapshot)
}

fn match_source_rows(
    source: &BTreeMap<String, Vec<Vec<u8>>>,
    migrated: &BTreeMap<String, Vec<Vec<u8>>>,
) -> AppResult<BTreeMap<String, Vec<Vec<u8>>>> {
    let mut matched = BTreeMap::new();
    for (table, source_rows) in source {
        let migrated_rows = migrated.get(table).ok_or_else(|| {
            AppError::Validation(format!("migration removed source table {table}"))
        })?;
        let mut migrated_index = 0;
        let mut matched_rows = Vec::with_capacity(source_rows.len());
        for source_row in source_rows {
            while migrated_index < migrated_rows.len()
                && migrated_rows[migrated_index] < *source_row
            {
                migrated_index += 1;
            }
            if migrated_index == migrated_rows.len() || migrated_rows[migrated_index] != *source_row
            {
                return Err(AppError::Validation(format!(
                    "migration changed or removed an existing row from {table}"
                )));
            }
            matched_rows.push(migrated_rows[migrated_index].clone());
            migrated_index += 1;
        }
        matched.insert(table.clone(), matched_rows);
    }
    Ok(matched)
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

fn assert_no_source_rows_lost(
    source: &BTreeMap<String, u64>,
    migrated: &BTreeMap<String, u64>,
) -> AppResult<()> {
    for (table, source_count) in source {
        let Some(migrated_count) = migrated.get(table) else {
            return Err(AppError::Validation(format!(
                "migration removed source table {table}"
            )));
        };
        if migrated_count < source_count {
            return Err(AppError::Validation(format!(
                "migration lost rows from {table}: {source_count} -> {migrated_count}"
            )));
        }
    }
    Ok(())
}

fn qa_reminder(label: &str) -> CreateReminderInput {
    CreateReminderInput {
        title: format!("migration-qa-{label}"),
        category: "work".into(),
        schedule_kind: "once".into(),
        at_local: Some("2035-01-01T09:00".into()),
        every_minutes: None,
        active_start_local: None,
        active_end_local: None,
        weekdays: None,
    }
}

fn check(id: &'static str, detail: &'static str) -> MigrationQaCheck {
    MigrationQaCheck {
        id,
        passed: true,
        detail,
    }
}

fn sha256_file(path: &Path) -> AppResult<String> {
    let file = fs::File::open(path)?;
    let mut reader = BufReader::new(file);
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

fn required_file_identity(path: &Path) -> AppResult<OptionalFileIdentity> {
    let metadata = fs::symlink_metadata(path)?;
    if metadata.file_type().is_symlink() || !metadata.file_type().is_file() {
        return Err(AppError::Validation(format!(
            "evidence component is not an ordinary file: {}",
            path.display()
        )));
    }
    Ok(OptionalFileIdentity {
        size_bytes: metadata.len(),
        sha256: sha256_file(path)?,
    })
}

fn optional_file_identity(path: &Path) -> AppResult<Option<OptionalFileIdentity>> {
    if !path.exists() {
        return Ok(None);
    }
    required_file_identity(path).map(Some)
}

fn write_new_json(path: &Path, value: &impl Serialize) -> AppResult<()> {
    let result = (|| {
        let mut file = fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(path)?;
        file.write_all(&serde_json::to_vec_pretty(value)?)?;
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

    fn synthetic_v132_fixture(path: &Path) {
        let connection = Connection::open(path).unwrap();
        for migration in [
            include_str!("../migrations/001_initial.sql"),
            include_str!("../migrations/002_focus_sessions.sql"),
            include_str!("../migrations/003_pet_interactions.sql"),
            include_str!("../migrations/004_ball_interaction.sql"),
            include_str!("../migrations/005_occurrence_history.sql"),
            include_str!("../migrations/006_activity_tracking.sql"),
        ] {
            connection.execute_batch(migration).unwrap();
        }
        connection
            .execute(
                "INSERT INTO reminders(
                    id, title, category, schedule_kind, schedule_json, timezone,
                    enabled, next_due_at, created_at, updated_at
                 ) VALUES(
                    'preserved-v132-reminder', 'preserve me', 'work', 'once', '{}',
                    'Asia/Shanghai', 1, '2034-01-01T09:00:00Z',
                    '2026-07-27T00:00:00Z', '2026-07-27T00:00:00Z'
                 )",
                [],
            )
            .unwrap();
    }

    #[test]
    fn captures_a_stable_runtime_v132_database_through_sqlite_backup() {
        let root =
            std::env::temp_dir().join(format!("yuanyuan-runtime-capture-test-{}", Uuid::new_v4()));
        fs::create_dir(&root).unwrap();
        let source = root.join("runtime.sqlite3");
        let fixture = root.join("captured.sqlite3");
        let report = root.join("capture.json");
        synthetic_v132_fixture(&source);
        let source_connection = Connection::open(&source).unwrap();
        source_connection
            .pragma_update(None, "journal_mode", "WAL")
            .unwrap();
        source_connection
            .execute(
                "INSERT INTO water_log(id, completed_at) VALUES('runtime-water', '2026-08-09T00:00:00Z')",
                [],
            )
            .unwrap();
        assert!(append_suffix(&source, "-wal").exists());

        capture_v132_runtime_fixture_inner(&source, &fixture, &report).unwrap();

        let captured =
            Connection::open_with_flags(&fixture, OpenFlags::SQLITE_OPEN_READ_ONLY).unwrap();
        assert_eq!(database_version(&captured).unwrap(), V132_SCHEMA_VERSION);
        let count: u32 = captured
            .query_row("SELECT COUNT(*) FROM water_log", [], |row| row.get(0))
            .unwrap();
        assert_eq!(count, 1);
        drop(captured);
        assert!(!append_suffix(&fixture, "-wal").exists());
        assert!(!append_suffix(&fixture, "-shm").exists());
        let value: serde_json::Value = serde_json::from_slice(&fs::read(&report).unwrap()).unwrap();
        assert_eq!(value["status"], "passed");
        assert_eq!(value["sourceDatabaseVersion"], 6);
        assert_eq!(value["sourceWalPresent"], true);
        assert_eq!(value["sourceStableDuringCapture"], true);
        assert_eq!(value["checks"].as_array().unwrap().len(), 5);

        drop(source_connection);
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn runtime_capture_rejects_non_v132_without_creating_outputs() {
        let root = std::env::temp_dir().join(format!(
            "yuanyuan-runtime-capture-reject-test-{}",
            Uuid::new_v4()
        ));
        fs::create_dir(&root).unwrap();
        let source = root.join("runtime.sqlite3");
        let fixture = root.join("captured.sqlite3");
        let report = root.join("capture.json");
        drop(Repository::open(&source).unwrap());

        let error = capture_v132_runtime_fixture_inner(&source, &fixture, &report).unwrap_err();

        assert!(error.to_string().contains("expected a v1.3.2"));
        assert!(!fixture.exists());
        assert!(!report.exists());
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn synthetic_v132_exercises_full_copy_migrate_restore_and_rollback_path() {
        let root =
            std::env::temp_dir().join(format!("yuanyuan-migration-qa-test-{}", Uuid::new_v4()));
        fs::create_dir(&root).unwrap();
        let fixture = root.join("v132.sqlite3");
        let report = root.join("report.json");
        synthetic_v132_fixture(&fixture);
        let before = sha256_file(&fixture).unwrap();

        run_v132_database_qa_inner(&fixture, &report).unwrap();

        assert_eq!(sha256_file(&fixture).unwrap(), before);
        let value: serde_json::Value = serde_json::from_slice(&fs::read(&report).unwrap()).unwrap();
        assert_eq!(value["status"], "passed");
        assert_eq!(value["sourceDatabaseVersion"], 6);
        assert_eq!(value["migratedDatabaseVersion"], CURRENT_SCHEMA_VERSION);
        assert_eq!(value["sourceTableCounts"]["reminders"], 1);
        assert_eq!(
            value["sourceLogicalSha256"],
            value["migratedMatchedSourceRowsSha256"]
        );
        assert_eq!(value["checks"].as_array().unwrap().len(), 8);

        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn rejects_non_v132_fixture_without_writing_a_report() {
        let root =
            std::env::temp_dir().join(format!("yuanyuan-migration-qa-reject-{}", Uuid::new_v4()));
        fs::create_dir(&root).unwrap();
        let fixture = root.join("current.sqlite3");
        let report = root.join("report.json");
        drop(Repository::open(&fixture).unwrap());

        let error = run_v132_database_qa_inner(&fixture, &report).unwrap_err();

        assert!(error.to_string().contains("expected a v1.3.2"));
        assert!(!report.exists());
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn refuses_to_overwrite_an_existing_report() {
        let root = std::env::temp_dir().join(format!(
            "yuanyuan-migration-qa-existing-report-{}",
            Uuid::new_v4()
        ));
        fs::create_dir(&root).unwrap();
        let fixture = root.join("v132.sqlite3");
        let report = root.join("report.json");
        synthetic_v132_fixture(&fixture);
        fs::write(&report, b"keep-existing-evidence").unwrap();

        let error = run_v132_database_qa_inner(&fixture, &report).unwrap_err();

        assert!(error.to_string().contains("already exists"));
        assert_eq!(fs::read(&report).unwrap(), b"keep-existing-evidence");
        fs::remove_dir_all(root).unwrap();
    }
}
