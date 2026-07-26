PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS reminders (
    id TEXT PRIMARY KEY NOT NULL,
    title TEXT NOT NULL CHECK (length(title) BETWEEN 1 AND 120),
    category TEXT NOT NULL CHECK (category IN ('water', 'work', 'personal')),
    schedule_kind TEXT NOT NULL CHECK (schedule_kind IN ('once', 'interval', 'daily', 'weekly')),
    schedule_json TEXT NOT NULL,
    timezone TEXT NOT NULL,
    enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
    next_due_at TEXT,
    last_fired_at TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_reminders_next_due
    ON reminders(enabled, next_due_at);

CREATE TABLE IF NOT EXISTS occurrences (
    id TEXT PRIMARY KEY NOT NULL,
    reminder_id TEXT NOT NULL REFERENCES reminders(id),
    scheduled_at TEXT NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('pending', 'completed', 'snoozed', 'skipped', 'overdue')),
    acted_at TEXT,
    snoozed_until TEXT,
    notification_id INTEGER,
    created_at TEXT NOT NULL,
    UNIQUE(reminder_id, scheduled_at)
);

CREATE INDEX IF NOT EXISTS idx_occurrences_status
    ON occurrences(status, scheduled_at);

CREATE TABLE IF NOT EXISTS settings (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    schema_version INTEGER NOT NULL,
    data_json TEXT NOT NULL,
    updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS water_log (
    id TEXT PRIMARY KEY NOT NULL,
    completed_at TEXT NOT NULL
);

PRAGMA user_version = 1;

