use std::{io::ErrorKind, path::Path, time::Duration};

use rusqlite::{params, Connection, OpenFlags, OptionalExtension, TransactionBehavior};
use thiserror::Error;

pub const AUTHENTICATION_FAILURE_THRESHOLD: u8 = 3;
pub const AUTHENTICATION_FAILURE_WINDOW: Duration = Duration::from_secs(10 * 60);

const SCHEMA: &str = r#"
CREATE TABLE IF NOT EXISTS connector_authentication_health (
  connector_id TEXT NOT NULL,
  source_instance TEXT NOT NULL,
  consecutive_failures INTEGER NOT NULL CHECK(consecutive_failures > 0 AND consecutive_failures <= 3),
  first_failure_at_unix_ms INTEGER NOT NULL CHECK(first_failure_at_unix_ms >= 0),
  last_failure_at_unix_ms INTEGER NOT NULL CHECK(last_failure_at_unix_ms >= first_failure_at_unix_ms),
  paused_at_unix_ms INTEGER,
  PRIMARY KEY(connector_id, source_instance),
  CHECK(paused_at_unix_ms IS NULL OR consecutive_failures = 3)
) WITHOUT ROWID;
"#;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct AuthenticationHealthStatus {
    pub consecutive_failures: u8,
    pub paused: bool,
    pub paused_at_unix_ms: Option<i64>,
}

#[derive(Debug, Error)]
pub enum AuthenticationHealthError {
    #[error("connector authentication health input is invalid")]
    InvalidInput,
    #[error("connector authentication health database path is unsafe")]
    UnsafePath,
    #[error("connector authentication health filesystem is unavailable")]
    Filesystem(#[from] std::io::Error),
    #[error("connector authentication health storage is unavailable")]
    Database(#[from] rusqlite::Error),
    #[cfg(windows)]
    #[error("connector authentication health ACL could not be applied")]
    Security(#[from] crate::NamedPipeServerError),
}

pub struct ConnectorAuthenticationHealthStore {
    connection: Connection,
}

impl ConnectorAuthenticationHealthStore {
    pub fn open(path: impl AsRef<Path>) -> Result<Self, AuthenticationHealthError> {
        let path = path.as_ref();
        validate_database_path(path, true)?;
        let connection = Connection::open(path)?;
        validate_database_path(path, false)?;
        let store = Self::from_connection(connection)?;
        secure_path(path)?;
        Ok(store)
    }

    pub fn open_existing_read_only(
        path: impl AsRef<Path>,
    ) -> Result<Self, AuthenticationHealthError> {
        let path = path.as_ref();
        validate_database_path(path, false)?;
        let connection = Connection::open_with_flags(
            path,
            OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX,
        )?;
        validate_database_path(path, false)?;
        connection.busy_timeout(Duration::ZERO)?;
        Ok(Self { connection })
    }

    pub fn open_in_memory() -> Result<Self, AuthenticationHealthError> {
        Self::from_connection(Connection::open_in_memory()?)
    }

    fn from_connection(connection: Connection) -> Result<Self, AuthenticationHealthError> {
        connection.busy_timeout(Duration::ZERO)?;
        connection.execute_batch(SCHEMA)?;
        Ok(Self { connection })
    }

    pub fn status(
        &self,
        connector_id: &str,
        source_instance: &str,
    ) -> Result<Option<AuthenticationHealthStatus>, AuthenticationHealthError> {
        validate_identity(connector_id, source_instance)?;
        self.connection
            .query_row(
                "SELECT consecutive_failures, paused_at_unix_ms
                 FROM connector_authentication_health
                 WHERE connector_id=?1 AND source_instance=?2",
                params![connector_id, source_instance],
                |row| {
                    let failures = row.get::<_, u8>(0)?;
                    let paused_at_unix_ms: Option<i64> = row.get(1)?;
                    Ok(AuthenticationHealthStatus {
                        consecutive_failures: failures,
                        paused: paused_at_unix_ms.is_some(),
                        paused_at_unix_ms,
                    })
                },
            )
            .optional()
            .map_err(Into::into)
    }

    pub fn record_failure(
        &mut self,
        connector_id: &str,
        source_instance: &str,
        now_unix_ms: i64,
    ) -> Result<AuthenticationHealthStatus, AuthenticationHealthError> {
        validate_input(connector_id, source_instance, now_unix_ms)?;
        let transaction = self
            .connection
            .transaction_with_behavior(TransactionBehavior::Immediate)?;
        let current = transaction
            .query_row(
                "SELECT consecutive_failures, last_failure_at_unix_ms, paused_at_unix_ms
                 FROM connector_authentication_health
                 WHERE connector_id=?1 AND source_instance=?2",
                params![connector_id, source_instance],
                |row| {
                    Ok((
                        row.get::<_, u8>(0)?,
                        row.get::<_, i64>(1)?,
                        row.get::<_, Option<i64>>(2)?,
                    ))
                },
            )
            .optional()?;
        let window_ms = AUTHENTICATION_FAILURE_WINDOW.as_millis() as i64;
        let (failures, first_failure_at, paused_at) = match current {
            Some((_, _, Some(paused_at))) => {
                (AUTHENTICATION_FAILURE_THRESHOLD, paused_at, Some(paused_at))
            }
            Some((failures, last_failure_at, None))
                if now_unix_ms.saturating_sub(last_failure_at) <= window_ms =>
            {
                let next = failures
                    .saturating_add(1)
                    .min(AUTHENTICATION_FAILURE_THRESHOLD);
                (
                    next,
                    transaction.query_row(
                        "SELECT first_failure_at_unix_ms FROM connector_authentication_health
                         WHERE connector_id=?1 AND source_instance=?2",
                        params![connector_id, source_instance],
                        |row| row.get(0),
                    )?,
                    (next >= AUTHENTICATION_FAILURE_THRESHOLD).then_some(now_unix_ms),
                )
            }
            _ => (1, now_unix_ms, None),
        };
        transaction.execute(
            "INSERT INTO connector_authentication_health(
               connector_id, source_instance, consecutive_failures,
               first_failure_at_unix_ms, last_failure_at_unix_ms, paused_at_unix_ms
             ) VALUES (?1, ?2, ?3, ?4, ?5, ?6)
             ON CONFLICT(connector_id, source_instance) DO UPDATE SET
               consecutive_failures=excluded.consecutive_failures,
               first_failure_at_unix_ms=excluded.first_failure_at_unix_ms,
               last_failure_at_unix_ms=excluded.last_failure_at_unix_ms,
               paused_at_unix_ms=excluded.paused_at_unix_ms",
            params![
                connector_id,
                source_instance,
                failures,
                first_failure_at,
                now_unix_ms,
                paused_at
            ],
        )?;
        transaction.commit()?;
        Ok(AuthenticationHealthStatus {
            consecutive_failures: failures,
            paused: paused_at.is_some(),
            paused_at_unix_ms: paused_at,
        })
    }

    pub fn record_success(
        &mut self,
        connector_id: &str,
        source_instance: &str,
    ) -> Result<(), AuthenticationHealthError> {
        validate_identity(connector_id, source_instance)?;
        self.connection.execute(
            "DELETE FROM connector_authentication_health
             WHERE connector_id=?1 AND source_instance=?2 AND paused_at_unix_ms IS NULL",
            params![connector_id, source_instance],
        )?;
        Ok(())
    }

    pub fn clear_after_reauthorization(
        &mut self,
        connector_id: &str,
        source_instance: &str,
    ) -> Result<(), AuthenticationHealthError> {
        validate_identity(connector_id, source_instance)?;
        self.connection.execute(
            "DELETE FROM connector_authentication_health
             WHERE connector_id=?1 AND source_instance=?2",
            params![connector_id, source_instance],
        )?;
        Ok(())
    }
}

fn validate_input(
    connector_id: &str,
    source_instance: &str,
    now_unix_ms: i64,
) -> Result<(), AuthenticationHealthError> {
    validate_identity(connector_id, source_instance)?;
    if now_unix_ms < 0 {
        return Err(AuthenticationHealthError::InvalidInput);
    }
    Ok(())
}

fn validate_identity(
    connector_id: &str,
    source_instance: &str,
) -> Result<(), AuthenticationHealthError> {
    if valid_identifier(connector_id) && valid_identifier(source_instance) {
        Ok(())
    } else {
        Err(AuthenticationHealthError::InvalidInput)
    }
}

fn valid_identifier(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 128
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'_' | b'-' | b':'))
}

fn validate_database_path(
    path: &Path,
    allow_missing_file: bool,
) -> Result<(), AuthenticationHealthError> {
    if path.file_name().is_none() {
        return Err(AuthenticationHealthError::UnsafePath);
    }
    let parent = path.parent().ok_or(AuthenticationHealthError::UnsafePath)?;
    let parent_metadata = std::fs::symlink_metadata(parent).map_err(|error| {
        if error.kind() == ErrorKind::NotFound {
            AuthenticationHealthError::UnsafePath
        } else {
            AuthenticationHealthError::Filesystem(error)
        }
    })?;
    if parent_metadata.file_type().is_symlink() || !parent_metadata.is_dir() {
        return Err(AuthenticationHealthError::UnsafePath);
    }
    match std::fs::symlink_metadata(path) {
        Ok(metadata) if !metadata.file_type().is_symlink() && metadata.is_file() => Ok(()),
        Ok(_) => Err(AuthenticationHealthError::UnsafePath),
        Err(error) if error.kind() == ErrorKind::NotFound && allow_missing_file => Ok(()),
        Err(error) if error.kind() == ErrorKind::NotFound => {
            Err(AuthenticationHealthError::UnsafePath)
        }
        Err(error) => Err(AuthenticationHealthError::Filesystem(error)),
    }
}

#[cfg(windows)]
fn secure_path(path: &Path) -> Result<(), AuthenticationHealthError> {
    crate::apply_current_user_only_dacl(path)?;
    Ok(())
}

#[cfg(not(windows))]
fn secure_path(_path: &Path) -> Result<(), AuthenticationHealthError> {
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    const CONNECTOR: &str = "builtin.codex";
    const INSTANCE: &str = "00000000-0000-4000-8000-000000000001";
    const NOW: i64 = 1_775_212_800_000;

    #[test]
    fn three_consecutive_failures_pause_until_explicit_reauthorization() {
        let mut store = ConnectorAuthenticationHealthStore::open_in_memory().unwrap();
        assert!(
            !store
                .record_failure(CONNECTOR, INSTANCE, NOW)
                .unwrap()
                .paused
        );
        assert!(
            !store
                .record_failure(CONNECTOR, INSTANCE, NOW + 1)
                .unwrap()
                .paused
        );
        assert!(
            store
                .record_failure(CONNECTOR, INSTANCE, NOW + 2)
                .unwrap()
                .paused
        );

        store.record_success(CONNECTOR, INSTANCE).unwrap();
        assert!(store.status(CONNECTOR, INSTANCE).unwrap().unwrap().paused);
        store
            .clear_after_reauthorization(CONNECTOR, INSTANCE)
            .unwrap();
        assert_eq!(store.status(CONNECTOR, INSTANCE).unwrap(), None);
    }

    #[test]
    fn a_success_resets_unpaused_failures_and_old_failures_do_not_accumulate() {
        let mut store = ConnectorAuthenticationHealthStore::open_in_memory().unwrap();
        store.record_failure(CONNECTOR, INSTANCE, NOW).unwrap();
        store.record_success(CONNECTOR, INSTANCE).unwrap();
        assert_eq!(store.status(CONNECTOR, INSTANCE).unwrap(), None);

        let outside_window = NOW + AUTHENTICATION_FAILURE_WINDOW.as_millis() as i64 + 1;
        store.record_failure(CONNECTOR, INSTANCE, NOW).unwrap();
        let status = store
            .record_failure(CONNECTOR, INSTANCE, outside_window)
            .unwrap();
        assert_eq!(status.consecutive_failures, 1);
        assert!(!status.paused);
    }
}
