BEGIN IMMEDIATE;

CREATE TABLE legacy_learning_migrations (
    source_edition TEXT PRIMARY KEY
        CHECK (source_edition IN ('preview', 'personal')),
    source_fingerprint TEXT NOT NULL
        CHECK (length(source_fingerprint) = 64),
    migrated_at_unix_ms INTEGER NOT NULL
        CHECK (migrated_at_unix_ms >= 0),
    card_count INTEGER NOT NULL
        CHECK (card_count >= 0),
    review_count INTEGER NOT NULL
        CHECK (review_count >= 0)
);

PRAGMA user_version = 7;

COMMIT;
