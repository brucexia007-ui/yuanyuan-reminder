BEGIN IMMEDIATE;

CREATE TABLE support_preferences (
    preference_id TEXT PRIMARY KEY,
    preference_kind TEXT NOT NULL CHECK(preference_kind IN (
        'approach_distance', 'failure_first_response', 'avoid_method', 'follow_up'
    )),
    preference_value TEXT NOT NULL,
    scope TEXT NOT NULL CHECK(scope IN ('global', 'project')),
    workspace_key TEXT,
    created_at_unix_ms INTEGER NOT NULL,
    updated_at_unix_ms INTEGER NOT NULL,
    confirmed_at_unix_ms INTEGER NOT NULL,
    CHECK(
        (scope = 'global' AND workspace_key IS NULL)
        OR (scope = 'project' AND workspace_key IS NOT NULL)
    ),
    CHECK(
        (preference_kind = 'approach_distance'
         AND preference_value IN ('near', 'comfortable', 'far'))
        OR (preference_kind = 'failure_first_response'
            AND preference_value IN ('quiet_presence', 'offer_choices', 'show_evidence'))
        OR (preference_kind = 'avoid_method'
            AND preference_value IN ('breathing', 'listening', 'movement', 'check_in'))
        OR (preference_kind = 'follow_up'
            AND preference_value IN ('none', 'once'))
    )
);

CREATE INDEX idx_support_preferences_scope
    ON support_preferences(scope, workspace_key, preference_kind);

DROP INDEX idx_deletion_tombstones_retention;
ALTER TABLE deletion_tombstones RENAME TO deletion_tombstones_v2;

CREATE TABLE deletion_tombstones (
    entity_type TEXT NOT NULL CHECK(entity_type IN (
        'memory', 'support_preference', 'interaction_session',
        'display_document', 'skill'
    )),
    entity_id TEXT NOT NULL,
    content_digest BLOB NOT NULL CHECK(length(content_digest) = 32),
    deleted_at_unix_ms INTEGER NOT NULL,
    retain_until_unix_ms INTEGER NOT NULL,
    PRIMARY KEY(entity_type, entity_id),
    CHECK(retain_until_unix_ms > deleted_at_unix_ms)
) WITHOUT ROWID;

INSERT INTO deletion_tombstones(
    entity_type, entity_id, content_digest,
    deleted_at_unix_ms, retain_until_unix_ms
)
SELECT entity_type, entity_id, content_digest,
       deleted_at_unix_ms, retain_until_unix_ms
FROM deletion_tombstones_v2;

DROP TABLE deletion_tombstones_v2;

CREATE INDEX idx_deletion_tombstones_retention
    ON deletion_tombstones(retain_until_unix_ms);

INSERT INTO ai_schema_meta(schema_version, migration_name, applied_at_unix_ms)
VALUES(3, '003_support_preferences', CAST(strftime('%s', 'now') AS INTEGER) * 1000);

PRAGMA user_version = 3;
COMMIT;
