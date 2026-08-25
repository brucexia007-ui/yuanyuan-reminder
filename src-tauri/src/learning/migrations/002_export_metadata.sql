BEGIN IMMEDIATE;

ALTER TABLE learning_schema_meta
ADD COLUMN last_successful_export_at_unix_ms INTEGER
CHECK (
    last_successful_export_at_unix_ms IS NULL
    OR last_successful_export_at_unix_ms >= 0
);

PRAGMA user_version = 2;

COMMIT;
