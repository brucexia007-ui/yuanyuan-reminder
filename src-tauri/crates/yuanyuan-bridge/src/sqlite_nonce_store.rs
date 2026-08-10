use std::{path::Path, sync::Mutex, time::Duration};

use rusqlite::{params, Connection, TransactionBehavior};
use thiserror::Error;

use crate::{NonceStore, NonceStoreError};

const SCHEMA: &str = r#"
CREATE TABLE IF NOT EXISTS task_event_nonces (
    key_id TEXT NOT NULL,
    nonce BLOB NOT NULL,
    expires_at_unix_ms INTEGER NOT NULL,
    PRIMARY KEY (key_id, nonce)
) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS idx_task_event_nonces_expiry
ON task_event_nonces(expires_at_unix_ms);
"#;

#[derive(Debug, Error)]
pub enum SqliteNonceStoreOpenError {
    #[error("nonce database could not be opened or initialized")]
    Database(#[source] rusqlite::Error),
}

pub struct SqliteNonceStore {
    connection: Mutex<Connection>,
}

impl SqliteNonceStore {
    pub fn open(path: impl AsRef<Path>) -> Result<Self, SqliteNonceStoreOpenError> {
        let connection = Connection::open(path).map_err(SqliteNonceStoreOpenError::Database)?;
        Self::from_connection(connection)
    }

    pub fn open_in_memory() -> Result<Self, SqliteNonceStoreOpenError> {
        let connection =
            Connection::open_in_memory().map_err(SqliteNonceStoreOpenError::Database)?;
        Self::from_connection(connection)
    }

    fn from_connection(connection: Connection) -> Result<Self, SqliteNonceStoreOpenError> {
        connection
            .busy_timeout(Duration::from_secs(1))
            .map_err(SqliteNonceStoreOpenError::Database)?;
        connection
            .execute_batch(SCHEMA)
            .map_err(SqliteNonceStoreOpenError::Database)?;
        Ok(Self {
            connection: Mutex::new(connection),
        })
    }
}

impl NonceStore for SqliteNonceStore {
    fn record_if_new(
        &self,
        key_id: &str,
        nonce: &[u8],
        expires_at_unix_ms: i64,
        now_unix_ms: i64,
    ) -> Result<bool, NonceStoreError> {
        let mut connection = self
            .connection
            .lock()
            .map_err(|_| NonceStoreError::Unavailable)?;
        let transaction = connection
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(|_| NonceStoreError::Unavailable)?;
        transaction
            .execute(
                "DELETE FROM task_event_nonces WHERE expires_at_unix_ms < ?1",
                params![now_unix_ms],
            )
            .map_err(|_| NonceStoreError::Unavailable)?;
        let inserted = transaction
            .execute(
                "INSERT OR IGNORE INTO task_event_nonces
                 (key_id, nonce, expires_at_unix_ms) VALUES (?1, ?2, ?3)",
                params![key_id, nonce, expires_at_unix_ms],
            )
            .map_err(|_| NonceStoreError::Unavailable)?;
        transaction
            .commit()
            .map_err(|_| NonceStoreError::Unavailable)?;
        Ok(inserted == 1)
    }
}

#[cfg(test)]
mod tests {
    use std::{sync::Arc, thread};

    use super::*;

    const NOW: i64 = 1_775_212_800_000;
    const EXPIRES: i64 = NOW + 300_000;

    #[test]
    fn records_each_key_and_nonce_pair_only_once() {
        let store = SqliteNonceStore::open_in_memory().unwrap();
        assert_eq!(
            store.record_if_new("codex.one", &[1; 16], EXPIRES, NOW),
            Ok(true)
        );
        assert_eq!(
            store.record_if_new("codex.one", &[1; 16], EXPIRES, NOW),
            Ok(false)
        );
        assert_eq!(
            store.record_if_new("codex.two", &[1; 16], EXPIRES, NOW),
            Ok(true)
        );
    }

    #[test]
    fn nonce_uniqueness_survives_reopen() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("nonces.sqlite3");
        {
            let store = SqliteNonceStore::open(&path).unwrap();
            assert_eq!(
                store.record_if_new("codex.one", &[2; 16], EXPIRES, NOW),
                Ok(true)
            );
        }
        let reopened = SqliteNonceStore::open(&path).unwrap();
        assert_eq!(
            reopened.record_if_new("codex.one", &[2; 16], EXPIRES, NOW),
            Ok(false)
        );
    }

    #[test]
    fn expired_nonces_are_removed_before_insertion() {
        let store = SqliteNonceStore::open_in_memory().unwrap();
        assert_eq!(
            store.record_if_new("codex.one", &[3; 16], NOW + 1, NOW),
            Ok(true)
        );
        assert_eq!(
            store.record_if_new("codex.one", &[3; 16], EXPIRES, NOW + 2),
            Ok(true)
        );
    }

    #[test]
    fn concurrent_database_connections_allow_only_one_winner() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("concurrent-nonces.sqlite3");
        let first = Arc::new(SqliteNonceStore::open(&path).unwrap());
        let second = Arc::new(SqliteNonceStore::open(&path).unwrap());
        let workers = [first, second].map(|store| {
            thread::spawn(move || {
                store
                    .record_if_new("codex.one", &[4; 16], EXPIRES, NOW)
                    .unwrap()
            })
        });
        let results = workers.map(|worker| worker.join().unwrap());
        assert_eq!(results.into_iter().filter(|inserted| *inserted).count(), 1);
    }
}
