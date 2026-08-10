BEGIN IMMEDIATE;

CREATE TABLE ai_schema_meta (
    schema_version INTEGER PRIMARY KEY,
    migration_name TEXT NOT NULL,
    applied_at_unix_ms INTEGER NOT NULL
);

INSERT INTO ai_schema_meta(schema_version, migration_name, applied_at_unix_ms)
VALUES
    (1, '001_task_watcher', CAST(strftime('%s', 'now') AS INTEGER) * 1000),
    (2, '002_memory_lifecycle', CAST(strftime('%s', 'now') AS INTEGER) * 1000);

CREATE TABLE memories (
    memory_id TEXT PRIMARY KEY,
    kind TEXT NOT NULL CHECK(kind IN (
        'user_preference', 'habit_rule', 'event', 'work_context'
    )),
    content TEXT NOT NULL,
    source_class TEXT NOT NULL CHECK(source_class IN (
        'user_asserted', 'user_confirmed', 'system_observed',
        'model_inferred', 'untrusted_external'
    )),
    source_reference TEXT,
    confidence TEXT NOT NULL CHECK(confidence IN (
        'high', 'medium', 'low', 'unknown'
    )),
    sensitivity TEXT NOT NULL CHECK(sensitivity IN (
        'public', 'personal', 'sensitive', 'restricted'
    )),
    state TEXT NOT NULL CHECK(state IN (
        'draft', 'active', 'superseded', 'expired'
    )),
    review_state TEXT NOT NULL CHECK(review_state IN (
        'pending', 'confirmed', 'rejected'
    )),
    cloud_allowed INTEGER NOT NULL CHECK(cloud_allowed IN (0, 1)),
    valid_until_unix_ms INTEGER,
    created_at_unix_ms INTEGER NOT NULL,
    updated_at_unix_ms INTEGER NOT NULL,
    confirmed_at_unix_ms INTEGER,
    CHECK(valid_until_unix_ms IS NULL OR valid_until_unix_ms > created_at_unix_ms),
    CHECK(state != 'active' OR review_state = 'confirmed'),
    CHECK(sensitivity != 'restricted' OR cloud_allowed = 0)
);

CREATE INDEX idx_memories_state_updated
    ON memories(state, review_state, updated_at_unix_ms);

CREATE INDEX idx_memories_expiry
    ON memories(valid_until_unix_ms)
    WHERE valid_until_unix_ms IS NOT NULL;

CREATE TABLE memory_links (
    link_id TEXT PRIMARY KEY,
    from_memory_id TEXT NOT NULL REFERENCES memories(memory_id) ON DELETE CASCADE,
    to_memory_id TEXT NOT NULL REFERENCES memories(memory_id) ON DELETE CASCADE,
    kind TEXT NOT NULL CHECK(kind IN (
        'derived_from', 'conflicts_with', 'supersedes', 'duplicates'
    )),
    created_at_unix_ms INTEGER NOT NULL,
    CHECK(from_memory_id != to_memory_id),
    UNIQUE(from_memory_id, to_memory_id, kind)
);

CREATE INDEX idx_memory_links_to
    ON memory_links(to_memory_id, kind);

CREATE TABLE memory_retrievals (
    retrieval_id TEXT NOT NULL,
    memory_id TEXT NOT NULL REFERENCES memories(memory_id) ON DELETE CASCADE,
    purpose TEXT NOT NULL CHECK(purpose IN (
        'companion_response', 'display_document', 'user_review'
    )),
    used_at_unix_ms INTEGER NOT NULL,
    PRIMARY KEY(retrieval_id, memory_id)
) WITHOUT ROWID;

CREATE INDEX idx_memory_retrievals_memory_time
    ON memory_retrievals(memory_id, used_at_unix_ms);

CREATE TABLE deletion_tombstones (
    entity_type TEXT NOT NULL CHECK(entity_type IN (
        'memory', 'interaction_session', 'display_document', 'skill'
    )),
    entity_id TEXT NOT NULL,
    content_digest BLOB NOT NULL CHECK(length(content_digest) = 32),
    deleted_at_unix_ms INTEGER NOT NULL,
    retain_until_unix_ms INTEGER NOT NULL,
    PRIMARY KEY(entity_type, entity_id),
    CHECK(retain_until_unix_ms > deleted_at_unix_ms)
) WITHOUT ROWID;

CREATE INDEX idx_deletion_tombstones_retention
    ON deletion_tombstones(retain_until_unix_ms);

CREATE VIRTUAL TABLE memory_search
    USING fts5(memory_id UNINDEXED, content, tokenize='trigram');

PRAGMA user_version = 2;
COMMIT;
