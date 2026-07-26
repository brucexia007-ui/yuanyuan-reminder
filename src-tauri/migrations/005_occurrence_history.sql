CREATE INDEX IF NOT EXISTS idx_occurrences_history
    ON occurrences(status, acted_at DESC);

PRAGMA user_version = 5;
