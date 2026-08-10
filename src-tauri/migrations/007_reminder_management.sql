BEGIN IMMEDIATE;

ALTER TABLE reminders ADD COLUMN archived_at TEXT;
ALTER TABLE reminders ADD COLUMN system_kind TEXT
    CHECK (system_kind IS NULL OR system_kind IN ('water', 'activity'));
ALTER TABLE occurrences ADD COLUMN resolution_reason TEXT;

UPDATE reminders
SET system_kind = 'activity'
WHERE id = 'system-activity-reminder';

UPDATE reminders
SET system_kind = 'water'
WHERE id = (
    SELECT id
    FROM reminders
    WHERE category = 'water' AND archived_at IS NULL
    ORDER BY created_at ASC
    LIMIT 1
);

CREATE INDEX IF NOT EXISTS idx_reminders_management
    ON reminders(archived_at, system_kind, enabled, next_due_at);

PRAGMA user_version = 7;

COMMIT;
