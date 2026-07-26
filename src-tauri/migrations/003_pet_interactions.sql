CREATE TABLE IF NOT EXISTS pet_interactions (
    id TEXT PRIMARY KEY NOT NULL,
    kind TEXT NOT NULL CHECK (kind IN ('food', 'water', 'treat', 'wand', 'pet', 'brush')),
    created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_pet_interactions_created
    ON pet_interactions(created_at, kind);

PRAGMA user_version = 3;
