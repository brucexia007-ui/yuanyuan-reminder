BEGIN IMMEDIATE;

CREATE TABLE task_watch_attention_deferrals (
    source TEXT NOT NULL CHECK(source IN ('codex', 'claude_code')),
    state TEXT NOT NULL CHECK(state IN (
        'running', 'waiting_user', 'failed', 'stalled', 'unknown'
    )),
    deferred_until_unix_ms INTEGER NOT NULL CHECK(deferred_until_unix_ms > 0),
    updated_at_unix_ms INTEGER NOT NULL CHECK(updated_at_unix_ms >= 0),
    PRIMARY KEY(source, state)
) WITHOUT ROWID;

PRAGMA user_version = 11;

COMMIT;
