BEGIN IMMEDIATE;

ALTER TABLE companion_proactive_attention
RENAME TO companion_proactive_attention_v11;

DROP INDEX idx_companion_proactive_attention_time;
DROP INDEX idx_companion_proactive_attention_day;

CREATE TABLE companion_proactive_attention (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    kind TEXT NOT NULL CHECK (kind IN (
        'focus_finished', 'reunion', 'learning_invitation'
    )),
    shown_at_unix_ms INTEGER NOT NULL CHECK (shown_at_unix_ms >= 0),
    local_day TEXT NOT NULL CHECK (
        length(local_day) = 10
        AND substr(local_day, 5, 1) = '-'
        AND substr(local_day, 8, 1) = '-'
    )
);

INSERT INTO companion_proactive_attention(id, kind, shown_at_unix_ms, local_day)
SELECT id, kind, shown_at_unix_ms, local_day
FROM companion_proactive_attention_v11;

DROP TABLE companion_proactive_attention_v11;

CREATE INDEX idx_companion_proactive_attention_time
ON companion_proactive_attention(shown_at_unix_ms);

CREATE INDEX idx_companion_proactive_attention_day
ON companion_proactive_attention(local_day);

PRAGMA user_version = 12;

COMMIT;
