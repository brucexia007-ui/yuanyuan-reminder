BEGIN;

DROP TABLE IF EXISTS pet_interactions_v4;

CREATE TABLE pet_interactions_v4 (
    id TEXT PRIMARY KEY NOT NULL,
    kind TEXT NOT NULL CHECK (kind IN ('food', 'water', 'treat', 'wand', 'pet', 'ball')),
    created_at TEXT NOT NULL
);

INSERT INTO pet_interactions_v4(id, kind, created_at)
SELECT
    id,
    CASE WHEN kind = 'brush' THEN 'ball' ELSE kind END,
    created_at
FROM pet_interactions;

DROP TABLE pet_interactions;
ALTER TABLE pet_interactions_v4 RENAME TO pet_interactions;

CREATE INDEX idx_pet_interactions_created
    ON pet_interactions(created_at, kind);

PRAGMA user_version = 4;

COMMIT;
