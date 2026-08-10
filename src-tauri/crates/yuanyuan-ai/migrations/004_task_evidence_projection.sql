BEGIN IMMEDIATE;

ALTER TABLE watched_tasks
    ADD COLUMN evidence_level TEXT NOT NULL DEFAULT 'unknown'
    CHECK(evidence_level IN ('authoritative', 'partial', 'presence_only', 'unknown'));

INSERT INTO ai_schema_meta(schema_version, migration_name, applied_at_unix_ms)
VALUES(4, '004_task_evidence_projection', CAST(strftime('%s', 'now') AS INTEGER) * 1000);

PRAGMA user_version = 4;
COMMIT;
