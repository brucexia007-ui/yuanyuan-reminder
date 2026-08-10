BEGIN IMMEDIATE;

CREATE TABLE companion_proactive_attention (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    kind TEXT NOT NULL CHECK (kind IN ('focus_finished')),
    shown_at_unix_ms INTEGER NOT NULL CHECK (shown_at_unix_ms >= 0),
    local_day TEXT NOT NULL CHECK (
        length(local_day) = 10
        AND substr(local_day, 5, 1) = '-'
        AND substr(local_day, 8, 1) = '-'
    )
);

CREATE INDEX idx_companion_proactive_attention_time
ON companion_proactive_attention(shown_at_unix_ms);

CREATE INDEX idx_companion_proactive_attention_day
ON companion_proactive_attention(local_day);

PRAGMA user_version = 9;

COMMIT;
