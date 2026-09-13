PRAGMA foreign_keys = OFF;
BEGIN IMMEDIATE;

ALTER TABLE occurrences RENAME TO occurrences_v12;
ALTER TABLE reminders RENAME TO reminders_v12;

CREATE TABLE reminders (
    id TEXT PRIMARY KEY NOT NULL,
    title TEXT NOT NULL CHECK (length(title) BETWEEN 1 AND 120),
    category TEXT NOT NULL CHECK (category IN ('water', 'meal', 'work', 'personal')),
    schedule_kind TEXT NOT NULL CHECK (schedule_kind IN ('once', 'interval', 'daily', 'weekly')),
    schedule_json TEXT NOT NULL,
    timezone TEXT NOT NULL,
    enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
    next_due_at TEXT,
    last_fired_at TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    archived_at TEXT,
    system_kind TEXT CHECK (system_kind IS NULL OR system_kind IN ('water', 'activity'))
);

INSERT INTO reminders(
    id, title, category, schedule_kind, schedule_json, timezone, enabled,
    next_due_at, last_fired_at, created_at, updated_at, archived_at, system_kind
)
SELECT
    id, title, category, schedule_kind, schedule_json, timezone, enabled,
    next_due_at, last_fired_at, created_at, updated_at, archived_at, system_kind
FROM reminders_v12;

CREATE TABLE occurrences (
    id TEXT PRIMARY KEY NOT NULL,
    reminder_id TEXT NOT NULL REFERENCES reminders(id),
    scheduled_at TEXT NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('pending', 'completed', 'snoozed', 'skipped', 'overdue')),
    acted_at TEXT,
    snoozed_until TEXT,
    notification_id INTEGER,
    created_at TEXT NOT NULL,
    resolution_reason TEXT,
    UNIQUE(reminder_id, scheduled_at)
);

INSERT INTO occurrences(
    id, reminder_id, scheduled_at, status, acted_at, snoozed_until,
    notification_id, created_at, resolution_reason
)
SELECT
    id, reminder_id, scheduled_at, status, acted_at, snoozed_until,
    notification_id, created_at, resolution_reason
FROM occurrences_v12;

DROP TABLE occurrences_v12;
DROP TABLE reminders_v12;

CREATE INDEX idx_reminders_next_due ON reminders(enabled, next_due_at);
CREATE INDEX idx_reminders_management
    ON reminders(archived_at, system_kind, enabled, next_due_at);
CREATE INDEX idx_occurrences_status ON occurrences(status, scheduled_at);
CREATE INDEX idx_occurrences_history ON occurrences(status, acted_at DESC);

PRAGMA user_version = 13;
COMMIT;
PRAGMA foreign_keys = ON;
