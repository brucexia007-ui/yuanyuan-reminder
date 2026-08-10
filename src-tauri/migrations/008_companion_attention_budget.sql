BEGIN IMMEDIATE;

CREATE TABLE companion_attention_budget (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    schema_version INTEGER NOT NULL CHECK (schema_version = 1),
    last_observed_terminal_at_unix_ms INTEGER NOT NULL DEFAULT 0
        CHECK (last_observed_terminal_at_unix_ms >= 0),
    deferred_count INTEGER NOT NULL DEFAULT 0 CHECK (deferred_count BETWEEN 0 AND 65535),
    deferred_source TEXT CHECK (deferred_source IS NULL OR deferred_source IN ('codex', 'claude_code')),
    deferred_outcome TEXT CHECK (deferred_outcome IS NULL OR deferred_outcome IN ('succeeded', 'failed', 'cancelled')),
    deferred_latest_at_unix_ms INTEGER CHECK (deferred_latest_at_unix_ms IS NULL OR deferred_latest_at_unix_ms >= 0),
    visible_count INTEGER NOT NULL DEFAULT 0 CHECK (visible_count BETWEEN 0 AND 65535),
    visible_source TEXT CHECK (visible_source IS NULL OR visible_source IN ('codex', 'claude_code')),
    visible_outcome TEXT CHECK (visible_outcome IS NULL OR visible_outcome IN ('succeeded', 'failed', 'cancelled')),
    visible_until_unix_ms INTEGER CHECK (visible_until_unix_ms IS NULL OR visible_until_unix_ms >= 0),
    last_summary_shown_at_unix_ms INTEGER CHECK (last_summary_shown_at_unix_ms IS NULL OR last_summary_shown_at_unix_ms >= 0),
    updated_at_unix_ms INTEGER NOT NULL CHECK (updated_at_unix_ms >= 0),
    CHECK (
        (deferred_count = 0 AND deferred_source IS NULL AND deferred_outcome IS NULL AND deferred_latest_at_unix_ms IS NULL)
        OR
        (deferred_count > 0 AND deferred_source IS NOT NULL AND deferred_outcome IS NOT NULL AND deferred_latest_at_unix_ms IS NOT NULL)
    ),
    CHECK (
        (visible_count = 0 AND visible_source IS NULL AND visible_outcome IS NULL AND visible_until_unix_ms IS NULL)
        OR
        (visible_count > 0 AND visible_source IS NOT NULL AND visible_outcome IS NOT NULL AND visible_until_unix_ms IS NOT NULL)
    )
);

INSERT INTO companion_attention_budget(id, schema_version, updated_at_unix_ms)
VALUES(1, 1, 0);

PRAGMA user_version = 8;

COMMIT;
