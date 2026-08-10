BEGIN IMMEDIATE;

CREATE TABLE task_event_nonces (
    key_id TEXT NOT NULL,
    nonce BLOB NOT NULL,
    expires_at_unix_ms INTEGER NOT NULL,
    PRIMARY KEY (key_id, nonce)
) WITHOUT ROWID;

CREATE INDEX idx_task_event_nonces_expiry
    ON task_event_nonces(expires_at_unix_ms);

CREATE TABLE watched_tasks (
    task_key TEXT PRIMARY KEY,
    connector_id TEXT NOT NULL,
    source_instance TEXT NOT NULL,
    source TEXT NOT NULL,
    workspace TEXT,
    external_id TEXT NOT NULL,
    task_id TEXT NOT NULL,
    current_run_id TEXT NOT NULL,
    parent_task_id TEXT,
    title TEXT NOT NULL,
    state TEXT NOT NULL,
    sequence INTEGER NOT NULL,
    finality TEXT NOT NULL,
    latest_event_id TEXT NOT NULL,
    latest_envelope_json TEXT NOT NULL,
    created_at_unix_ms INTEGER NOT NULL,
    updated_at_unix_ms INTEGER NOT NULL
);

CREATE UNIQUE INDEX idx_watched_tasks_identity
    ON watched_tasks(connector_id, source_instance, source,
                     COALESCE(workspace, ''), external_id, task_id);

CREATE TABLE task_events (
    event_id TEXT PRIMARY KEY,
    task_key TEXT NOT NULL REFERENCES watched_tasks(task_key) ON DELETE CASCADE,
    run_id TEXT NOT NULL,
    sequence INTEGER NOT NULL,
    state TEXT NOT NULL,
    finality TEXT NOT NULL,
    key_id TEXT NOT NULL,
    nonce BLOB NOT NULL,
    envelope_json TEXT NOT NULL,
    disposition TEXT NOT NULL,
    persisted_at_unix_ms INTEGER NOT NULL
);

CREATE INDEX idx_task_events_task_sequence
    ON task_events(task_key, sequence, persisted_at_unix_ms);

PRAGMA user_version = 1;
COMMIT;
