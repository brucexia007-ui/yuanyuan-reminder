BEGIN IMMEDIATE;

ALTER TABLE learning_sessions
ADD COLUMN session_kind TEXT NOT NULL DEFAULT 'daily'
CHECK (session_kind IN ('daily', 'mistakes'));

CREATE INDEX idx_learning_sessions_kind_started
ON learning_sessions(session_kind, started_at_unix_ms);

PRAGMA user_version = 4;

COMMIT;
