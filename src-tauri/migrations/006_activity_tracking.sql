CREATE TABLE IF NOT EXISTS activity_tracking_state (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    active_seconds INTEGER NOT NULL DEFAULT 0,
    updated_at TEXT NOT NULL
);

INSERT OR IGNORE INTO activity_tracking_state(id, active_seconds, updated_at)
VALUES(1, 0, CURRENT_TIMESTAMP);

PRAGMA user_version = 6;
