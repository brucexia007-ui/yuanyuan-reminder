BEGIN IMMEDIATE;

ALTER TABLE content_packs ADD COLUMN description TEXT NOT NULL DEFAULT '' CHECK (length(description) <= 1000);
ALTER TABLE content_packs ADD COLUMN rights_basis TEXT NOT NULL DEFAULT 'authorized'
    CHECK (rights_basis IN ('self_authored', 'public_domain', 'open_license', 'authorized', 'personal_use_only'));
ALTER TABLE content_packs ADD COLUMN rights_statement TEXT NOT NULL DEFAULT 'Legacy local learning content' CHECK (length(rights_statement) BETWEEN 1 AND 2000);
ALTER TABLE content_packs ADD COLUMN redistributable INTEGER NOT NULL DEFAULT 0 CHECK (redistributable IN (0, 1));
ALTER TABLE content_packs ADD COLUMN content_sha256 TEXT CHECK (
    content_sha256 IS NULL OR (length(content_sha256) = 64 AND content_sha256 NOT GLOB '*[^0-9a-f]*')
);

ALTER TABLE learning_cards ADD COLUMN external_card_id TEXT CHECK (
    external_card_id IS NULL OR length(external_card_id) BETWEEN 1 AND 128
);
ALTER TABLE learning_cards ADD COLUMN exercise_kind TEXT NOT NULL DEFAULT 'choice'
    CHECK (exercise_kind IN ('choice', 'recall'));
ALTER TABLE learning_cards ADD COLUMN prompt_text TEXT CHECK (
    prompt_text IS NULL OR length(trim(prompt_text)) BETWEEN 1 AND 2000
);
ALTER TABLE learning_cards ADD COLUMN answer_text TEXT CHECK (
    answer_text IS NULL OR length(trim(answer_text)) BETWEEN 1 AND 4000
);
ALTER TABLE learning_cards ADD COLUMN choices_json TEXT NOT NULL DEFAULT '[]' CHECK (
    json_valid(choices_json) AND json_type(choices_json) = 'array' AND json_array_length(choices_json) BETWEEN 0 AND 4
);
ALTER TABLE learning_cards ADD COLUMN explanation_text TEXT CHECK (
    explanation_text IS NULL OR length(explanation_text) <= 8000
);
ALTER TABLE learning_cards ADD COLUMN tags_json TEXT NOT NULL DEFAULT '[]' CHECK (
    json_valid(tags_json) AND json_type(tags_json) = 'array' AND json_array_length(tags_json) BETWEEN 0 AND 32
);
ALTER TABLE learning_cards ADD COLUMN source_refs_json TEXT NOT NULL DEFAULT '[]' CHECK (
    json_valid(source_refs_json) AND json_type(source_refs_json) = 'array' AND json_array_length(source_refs_json) BETWEEN 0 AND 8
);
ALTER TABLE learning_cards ADD COLUMN extensions_json TEXT NOT NULL DEFAULT '{}' CHECK (
    json_valid(extensions_json) AND json_type(extensions_json) = 'object'
);
ALTER TABLE learning_cards ADD COLUMN prompt_sha256 TEXT CHECK (
    prompt_sha256 IS NULL OR (length(prompt_sha256) = 64 AND prompt_sha256 NOT GLOB '*[^0-9a-f]*')
);
ALTER TABLE learning_cards ADD COLUMN answer_sha256 TEXT CHECK (
    answer_sha256 IS NULL OR (length(answer_sha256) = 64 AND answer_sha256 NOT GLOB '*[^0-9a-f]*')
);
ALTER TABLE learning_cards ADD COLUMN schedule_epoch INTEGER NOT NULL DEFAULT 1 CHECK (schedule_epoch >= 1);

CREATE INDEX idx_learning_cards_pack_external ON learning_cards(pack_id, external_card_id);

PRAGMA user_version = 8;

COMMIT;
