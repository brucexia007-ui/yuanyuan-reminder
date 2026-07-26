CREATE TABLE IF NOT EXISTS focus_sessions (
    id TEXT PRIMARY KEY NOT NULL,
    phase TEXT NOT NULL CHECK (phase IN ('focus', 'break')),
    status TEXT NOT NULL CHECK (status IN ('active', 'completed', 'cancelled')),
    duration_minutes INTEGER NOT NULL CHECK (duration_minutes BETWEEN 1 AND 240),
    started_at TEXT NOT NULL,
    ends_at TEXT NOT NULL,
    completed_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_focus_sessions_status_end
    ON focus_sessions(status, ends_at);

PRAGMA user_version = 2;

