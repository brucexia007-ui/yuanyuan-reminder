use rusqlite::{params, TransactionBehavior};

use crate::{TaskStore, TaskStoreError};

const DAY_MS: i64 = 24 * 60 * 60 * 1_000;
const MAX_RETENTION_MS: i64 = 3_650 * DAY_MS;
pub const RETENTION_INCREMENTAL_VACUUM_PAGES_PER_CYCLE: u32 = 256;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct TaskRetentionPolicy {
    pub progress_event_retention_ms: i64,
    pub priority_event_retention_ms: i64,
    pub terminal_task_retention_ms: i64,
    pub stale_task_retention_ms: i64,
    pub maximum_event_deletes_per_run: u32,
    pub maximum_task_deletes_per_run: u32,
}

impl Default for TaskRetentionPolicy {
    fn default() -> Self {
        Self {
            progress_event_retention_ms: 7 * DAY_MS,
            priority_event_retention_ms: 90 * DAY_MS,
            terminal_task_retention_ms: 180 * DAY_MS,
            stale_task_retention_ms: 365 * DAY_MS,
            maximum_event_deletes_per_run: 1_000,
            maximum_task_deletes_per_run: 250,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct TaskRetentionOutcome {
    pub event_rows_deleted: u64,
    pub task_rows_deleted: u64,
    pub expired_nonces_deleted: u64,
}

impl TaskRetentionPolicy {
    pub fn validate(self) -> Result<(), TaskStoreError> {
        let ordered = self.progress_event_retention_ms > 0
            && self.progress_event_retention_ms <= self.priority_event_retention_ms
            && self.priority_event_retention_ms <= self.terminal_task_retention_ms
            && self.terminal_task_retention_ms <= self.stale_task_retention_ms
            && self.stale_task_retention_ms <= MAX_RETENTION_MS;
        if !ordered
            || !(1..=10_000).contains(&self.maximum_event_deletes_per_run)
            || !(1..=1_000).contains(&self.maximum_task_deletes_per_run)
        {
            return Err(TaskStoreError::Database(rusqlite::Error::InvalidQuery));
        }
        Ok(())
    }
}

impl TaskStore {
    /// Applies bounded retention in one immediate transaction. The latest
    /// event for every surviving task is always preserved. Waiting-user and
    /// terminal/corrected evidence use the longer priority window; only stale
    /// task summaries age out, and no state is invented during cleanup.
    pub fn apply_retention(
        &mut self,
        policy: TaskRetentionPolicy,
        now_unix_ms: i64,
    ) -> Result<TaskRetentionOutcome, TaskStoreError> {
        policy.validate()?;
        if now_unix_ms < 0 {
            return Err(TaskStoreError::Database(rusqlite::Error::InvalidQuery));
        }
        let progress_cutoff = now_unix_ms - policy.progress_event_retention_ms;
        let priority_cutoff = now_unix_ms - policy.priority_event_retention_ms;
        let terminal_task_cutoff = now_unix_ms - policy.terminal_task_retention_ms;
        let stale_task_cutoff = now_unix_ms - policy.stale_task_retention_ms;

        let transaction = self
            .connection
            .transaction_with_behavior(TransactionBehavior::Immediate)?;
        let events_before: u64 =
            transaction.query_row("SELECT COUNT(*) FROM task_events", [], |row| row.get(0))?;
        let expired_nonces_deleted = transaction.execute(
            "DELETE FROM task_event_nonces WHERE expires_at_unix_ms < ?1",
            [now_unix_ms],
        )? as u64;

        transaction.execute(
            "DELETE FROM task_events
             WHERE event_id IN (
               SELECT event.event_id
               FROM task_events AS event
               JOIN watched_tasks AS task ON task.task_key = event.task_key
               WHERE event.event_id <> task.latest_event_id
                 AND (
                   (
                     event.state IN ('waiting_user', 'succeeded', 'failed', 'cancelled')
                     OR event.finality IN ('terminal', 'corrected')
                   ) AND event.persisted_at_unix_ms < ?1
                   OR (
                     event.state NOT IN ('waiting_user', 'succeeded', 'failed', 'cancelled')
                     AND event.finality NOT IN ('terminal', 'corrected')
                   ) AND event.persisted_at_unix_ms < ?2
                 )
               ORDER BY event.persisted_at_unix_ms, event.event_id
               LIMIT ?3
             )",
            params![
                priority_cutoff,
                progress_cutoff,
                policy.maximum_event_deletes_per_run,
            ],
        )?;

        let task_rows_deleted = transaction.execute(
            "DELETE FROM watched_tasks
             WHERE task_key IN (
               SELECT task_key
               FROM watched_tasks
               WHERE (
                 state IN ('succeeded', 'failed', 'cancelled')
                 AND updated_at_unix_ms < ?1
               ) OR (
                 state NOT IN ('succeeded', 'failed', 'cancelled')
                 AND updated_at_unix_ms < ?2
               )
               ORDER BY updated_at_unix_ms, task_key
               LIMIT ?3
             )",
            params![
                terminal_task_cutoff,
                stale_task_cutoff,
                policy.maximum_task_deletes_per_run,
            ],
        )? as u64;
        let events_after: u64 =
            transaction.query_row("SELECT COUNT(*) FROM task_events", [], |row| row.get(0))?;
        transaction.commit()?;

        Ok(TaskRetentionOutcome {
            event_rows_deleted: events_before.saturating_sub(events_after),
            task_rows_deleted,
            expired_nonces_deleted,
        })
    }

    /// Reclaims at most a fixed number of free pages for databases created
    /// with incremental auto-vacuum. Existing databases that predate this
    /// storage policy are left untouched instead of being silently rebuilt.
    pub fn apply_incremental_vacuum(&mut self, maximum_pages: u32) -> Result<u64, TaskStoreError> {
        if !(1..=1_024).contains(&maximum_pages) {
            return Err(TaskStoreError::Database(rusqlite::Error::InvalidQuery));
        }
        let mode: u32 = self
            .connection
            .query_row("PRAGMA auto_vacuum", [], |row| row.get(0))?;
        if mode != 2 {
            return Ok(0);
        }
        let before: u64 = self
            .connection
            .query_row("PRAGMA freelist_count", [], |row| row.get(0))?;
        let mut remaining = before;
        for _ in 0..maximum_pages {
            if remaining == 0 {
                break;
            }
            self.connection
                .execute_batch("PRAGMA incremental_vacuum(1);")?;
            let next: u64 = self
                .connection
                .query_row("PRAGMA freelist_count", [], |row| row.get(0))?;
            if next >= remaining {
                break;
            }
            remaining = next;
        }
        Ok(before.saturating_sub(remaining))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const NOW: i64 = 1_800_000_000_000;

    fn insert_task(
        store: &TaskStore,
        task_key: &str,
        state: &str,
        updated_at: i64,
        latest_event_id: &str,
        events: &[(&str, &str, &str, i64)],
    ) {
        store
            .connection
            .execute(
                "INSERT INTO watched_tasks(
                    task_key, connector_id, source_instance, source, workspace,
                    external_id, task_id, current_run_id, parent_task_id, title,
                    state, sequence, finality, latest_event_id, latest_envelope_json,
                    created_at_unix_ms, updated_at_unix_ms
                 ) VALUES(?1, 'connector', 'instance', 'test.source', NULL,
                          ?1, ?1, 'run', NULL, 'redacted', ?2, 9, 'provisional',
                          ?3, '{}', ?4, ?4)",
                params![task_key, state, latest_event_id, updated_at],
            )
            .unwrap();
        for (index, (event_id, event_state, finality, persisted_at)) in events.iter().enumerate() {
            store
                .connection
                .execute(
                    "INSERT INTO task_events(
                        event_id, task_key, run_id, sequence, state, finality,
                        key_id, nonce, envelope_json, disposition, persisted_at_unix_ms
                     ) VALUES(?1, ?2, 'run', ?3, ?4, ?5,
                              'key', ?6, '{}', 'applied', ?7)",
                    params![
                        event_id,
                        task_key,
                        index as i64 + 1,
                        event_state,
                        finality,
                        vec![index as u8; 16],
                        persisted_at,
                    ],
                )
                .unwrap();
        }
    }

    #[test]
    fn progress_and_priority_events_use_different_windows_while_latest_survives() {
        let mut store = TaskStore::open_in_memory().unwrap();
        insert_task(
            &store,
            "active-task",
            "running",
            NOW,
            "latest-old",
            &[
                ("progress-old", "running", "provisional", NOW - 8 * DAY_MS),
                (
                    "priority-old",
                    "waiting_user",
                    "provisional",
                    NOW - 91 * DAY_MS,
                ),
                ("fresh", "running", "provisional", NOW - DAY_MS),
                ("latest-old", "running", "provisional", NOW - 100 * DAY_MS),
            ],
        );
        store
            .connection
            .execute(
                "INSERT INTO task_event_nonces(key_id, nonce, expires_at_unix_ms)
                 VALUES('expired', ?1, ?2), ('current', ?3, ?4)",
                params![vec![1_u8; 16], NOW - 1, vec![2_u8; 16], NOW + 1],
            )
            .unwrap();

        let outcome = store
            .apply_retention(TaskRetentionPolicy::default(), NOW)
            .unwrap();
        assert_eq!(outcome.event_rows_deleted, 2);
        assert_eq!(outcome.expired_nonces_deleted, 1);
        let remaining: Vec<String> = store
            .connection
            .prepare("SELECT event_id FROM task_events ORDER BY event_id")
            .unwrap()
            .query_map([], |row| row.get(0))
            .unwrap()
            .map(Result::unwrap)
            .collect();
        assert_eq!(remaining, vec!["fresh", "latest-old"]);
    }

    #[test]
    fn terminal_and_stale_task_summaries_expire_without_touching_recent_tasks() {
        let mut store = TaskStore::open_in_memory().unwrap();
        for (key, state, age_days) in [
            ("old-terminal", "failed", 181),
            ("recent-terminal", "succeeded", 179),
            ("old-stale", "running", 366),
            ("recent-stale", "waiting_user", 364),
        ] {
            let event_id = format!("{key}-latest");
            insert_task(
                &store,
                key,
                state,
                NOW - age_days * DAY_MS,
                &event_id,
                &[(&event_id, state, "terminal", NOW - age_days * DAY_MS)],
            );
        }

        let outcome = store
            .apply_retention(TaskRetentionPolicy::default(), NOW)
            .unwrap();
        assert_eq!(outcome.task_rows_deleted, 2);
        assert_eq!(outcome.event_rows_deleted, 2);
        let remaining: Vec<String> = store
            .connection
            .prepare("SELECT task_key FROM watched_tasks ORDER BY task_key")
            .unwrap()
            .query_map([], |row| row.get(0))
            .unwrap()
            .map(Result::unwrap)
            .collect();
        assert_eq!(remaining, vec!["recent-stale", "recent-terminal"]);
    }

    #[test]
    fn cleanup_is_bounded_and_repeatable() {
        let mut store = TaskStore::open_in_memory().unwrap();
        for index in 0..3 {
            let key = format!("terminal-{index}");
            let event_id = format!("event-{index}");
            insert_task(
                &store,
                &key,
                "cancelled",
                NOW - 200 * DAY_MS,
                &event_id,
                &[(&event_id, "cancelled", "terminal", NOW - 200 * DAY_MS)],
            );
        }
        let policy = TaskRetentionPolicy {
            maximum_task_deletes_per_run: 1,
            ..TaskRetentionPolicy::default()
        };
        for expected_remaining in [2, 1, 0] {
            let outcome = store.apply_retention(policy, NOW).unwrap();
            assert_eq!(outcome.task_rows_deleted, 1);
            assert_eq!(store.task_count().unwrap(), expected_remaining);
        }
    }

    #[test]
    fn retention_failure_rolls_back_events_tasks_and_nonce_cleanup() {
        let mut store = TaskStore::open_in_memory().unwrap();
        insert_task(
            &store,
            "active-task",
            "running",
            NOW,
            "latest",
            &[
                ("old", "running", "provisional", NOW - 8 * DAY_MS),
                ("latest", "running", "provisional", NOW),
            ],
        );
        store
            .connection
            .execute(
                "INSERT INTO task_event_nonces(key_id, nonce, expires_at_unix_ms)
                 VALUES('expired', ?1, ?2)",
                params![vec![1_u8; 16], NOW - 1],
            )
            .unwrap();
        store
            .connection
            .execute_batch(
                "CREATE TRIGGER reject_retention BEFORE DELETE ON task_events
                 BEGIN SELECT RAISE(ABORT, 'test'); END;",
            )
            .unwrap();

        assert!(store
            .apply_retention(TaskRetentionPolicy::default(), NOW)
            .is_err());
        assert_eq!(store.event_count().unwrap(), 2);
        assert_eq!(
            store
                .connection
                .query_row("SELECT COUNT(*) FROM task_event_nonces", [], |row| {
                    row.get::<_, u64>(0)
                })
                .unwrap(),
            1
        );
    }

    #[test]
    fn invalid_or_unbounded_policies_fail_before_writing() {
        let mut store = TaskStore::open_in_memory().unwrap();
        for policy in [
            TaskRetentionPolicy {
                progress_event_retention_ms: 0,
                ..TaskRetentionPolicy::default()
            },
            TaskRetentionPolicy {
                priority_event_retention_ms: DAY_MS,
                progress_event_retention_ms: 2 * DAY_MS,
                ..TaskRetentionPolicy::default()
            },
            TaskRetentionPolicy {
                maximum_event_deletes_per_run: 0,
                ..TaskRetentionPolicy::default()
            },
        ] {
            assert!(store.apply_retention(policy, NOW).is_err());
        }
    }

    #[test]
    fn incremental_vacuum_is_bounded_and_legacy_none_mode_is_a_noop() {
        let mut fresh = TaskStore::open_in_memory().unwrap();
        assert_eq!(
            fresh
                .connection
                .query_row("PRAGMA auto_vacuum", [], |row| row.get::<_, u32>(0))
                .unwrap(),
            2
        );
        assert!(fresh.apply_incremental_vacuum(0).is_err());
        assert!(fresh.apply_incremental_vacuum(1_025).is_err());
        fresh
            .connection
            .execute("CREATE TABLE vacuum_fixture(payload BLOB NOT NULL)", [])
            .unwrap();
        {
            let transaction = fresh.connection.transaction().unwrap();
            for _ in 0..600 {
                transaction
                    .execute("INSERT INTO vacuum_fixture VALUES(zeroblob(4096))", [])
                    .unwrap();
            }
            transaction.commit().unwrap();
        }
        fresh
            .connection
            .execute("DELETE FROM vacuum_fixture", [])
            .unwrap();
        let free_before: u64 = fresh
            .connection
            .query_row("PRAGMA freelist_count", [], |row| row.get(0))
            .unwrap();
        let reclaimed = fresh.apply_incremental_vacuum(32).unwrap();
        let free_after: u64 = fresh
            .connection
            .query_row("PRAGMA freelist_count", [], |row| row.get(0))
            .unwrap();
        assert!(free_before >= 32);
        assert_eq!(reclaimed, 32);
        assert_eq!(free_before - free_after, reclaimed);

        let connection = rusqlite::Connection::open_in_memory().unwrap();
        connection
            .execute_batch(include_str!("../migrations/001_task_watcher.sql"))
            .unwrap();
        let mut legacy = TaskStore::from_connection(connection).unwrap();
        assert_eq!(
            legacy
                .connection
                .query_row("PRAGMA auto_vacuum", [], |row| row.get::<_, u32>(0))
                .unwrap(),
            0
        );
        assert_eq!(legacy.apply_incremental_vacuum(256).unwrap(), 0);
    }
}
