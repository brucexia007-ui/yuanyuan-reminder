BEGIN IMMEDIATE;

CREATE TABLE learning_schema_meta (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    schema_version INTEGER NOT NULL CHECK (schema_version = 1),
    created_at_unix_ms INTEGER NOT NULL CHECK (created_at_unix_ms >= 0),
    migrated_at_unix_ms INTEGER NOT NULL CHECK (migrated_at_unix_ms >= 0)
);

CREATE TABLE learning_settings (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    mode TEXT NOT NULL CHECK (mode IN ('manual_only', 'automatic_opt_in')),
    cards_per_session INTEGER NOT NULL CHECK (cards_per_session IN (1, 3, 5)),
    daily_new_limit INTEGER NOT NULL CHECK (daily_new_limit IN (0, 5, 10, 20, 30)),
    focus_finished_enabled INTEGER NOT NULL CHECK (focus_finished_enabled IN (0, 1)),
    scheduled_windows_enabled INTEGER NOT NULL CHECK (scheduled_windows_enabled IN (0, 1)),
    work_gap_experimental_enabled INTEGER NOT NULL CHECK (work_gap_experimental_enabled IN (0, 1)),
    daily_invitation_limit INTEGER NOT NULL CHECK (daily_invitation_limit BETWEEN 1 AND 3),
    invitation_cooldown_minutes INTEGER NOT NULL CHECK (invitation_cooldown_minutes IN (60, 120, 240)),
    invitation_ttl_seconds INTEGER NOT NULL CHECK (invitation_ttl_seconds = 20),
    paused_for_local_day TEXT CHECK (
        paused_for_local_day IS NULL OR (
            length(paused_for_local_day) = 10
            AND substr(paused_for_local_day, 5, 1) = '-'
            AND substr(paused_for_local_day, 8, 1) = '-'
        )
    ),
    updated_at_unix_ms INTEGER NOT NULL CHECK (updated_at_unix_ms >= 0)
);

CREATE TABLE content_sources (
    source_id TEXT PRIMARY KEY CHECK (length(source_id) BETWEEN 1 AND 96),
    source_kind TEXT NOT NULL CHECK (source_kind IN ('user_import', 'authorized', 'open_data')),
    version TEXT NOT NULL CHECK (length(version) BETWEEN 1 AND 128),
    source_url TEXT CHECK (source_url IS NULL OR length(source_url) <= 2048),
    license_expression TEXT CHECK (license_expression IS NULL OR length(license_expression) <= 128),
    notice_text TEXT CHECK (notice_text IS NULL OR length(notice_text) <= 4096),
    content_sha256 TEXT NOT NULL CHECK (
        length(content_sha256) = 64
        AND content_sha256 NOT GLOB '*[^0-9a-f]*'
    ),
    created_at_unix_ms INTEGER NOT NULL CHECK (created_at_unix_ms >= 0)
);

CREATE TABLE content_packs (
    pack_id TEXT PRIMARY KEY CHECK (length(pack_id) BETWEEN 1 AND 128),
    stable_namespace TEXT NOT NULL CHECK (length(stable_namespace) BETWEEN 1 AND 128),
    version TEXT NOT NULL CHECK (length(version) BETWEEN 1 AND 128),
    title TEXT NOT NULL CHECK (length(title) BETWEEN 1 AND 160),
    exam_scope TEXT NOT NULL CHECK (length(exam_scope) BETWEEN 1 AND 160),
    status TEXT NOT NULL CHECK (status IN ('preview', 'ready', 'disabled')),
    manifest_sha256 TEXT NOT NULL CHECK (
        length(manifest_sha256) = 64
        AND manifest_sha256 NOT GLOB '*[^0-9a-f]*'
    ),
    created_at_unix_ms INTEGER NOT NULL CHECK (created_at_unix_ms >= 0),
    UNIQUE(stable_namespace, version)
);

CREATE TABLE learning_cards (
    card_id TEXT PRIMARY KEY CHECK (
        length(card_id) = 64
        AND card_id NOT GLOB '*[^0-9a-f]*'
    ),
    pack_id TEXT NOT NULL REFERENCES content_packs(pack_id) ON DELETE CASCADE,
    headword TEXT NOT NULL CHECK (
        length(trim(headword)) BETWEEN 1 AND 128
        AND instr(headword, char(0)) = 0
    ),
    normalized_headword TEXT NOT NULL CHECK (length(normalized_headword) BETWEEN 1 AND 128),
    phonetic TEXT CHECK (phonetic IS NULL OR length(phonetic) <= 160),
    part_of_speech_json TEXT NOT NULL CHECK (
        json_valid(part_of_speech_json)
        AND json_type(part_of_speech_json) = 'array'
        AND json_array_length(part_of_speech_json) BETWEEN 1 AND 8
    ),
    meanings_zh_json TEXT NOT NULL CHECK (
        json_valid(meanings_zh_json)
        AND json_type(meanings_zh_json) = 'array'
        AND json_array_length(meanings_zh_json) BETWEEN 1 AND 2
    ),
    word_family_json TEXT NOT NULL CHECK (
        json_valid(word_family_json)
        AND json_type(word_family_json) = 'array'
        AND json_array_length(word_family_json) BETWEEN 0 AND 3
    ),
    frequency_band TEXT NOT NULL CHECK (
        frequency_band IN ('user_import', 'exam_mid', 'exam_other', 'general', 'unknown')
    ),
    sense_basis_json TEXT NOT NULL CHECK (json_valid(sense_basis_json)),
    source_ids_json TEXT NOT NULL CHECK (
        json_valid(source_ids_json)
        AND json_type(source_ids_json) = 'array'
        AND json_array_length(source_ids_json) BETWEEN 1 AND 8
    ),
    content_sha256 TEXT NOT NULL CHECK (
        length(content_sha256) = 64
        AND content_sha256 NOT GLOB '*[^0-9a-f]*'
    ),
    created_at_unix_ms INTEGER NOT NULL CHECK (created_at_unix_ms >= 0),
    UNIQUE(pack_id, normalized_headword)
);

CREATE TABLE card_schedule (
    card_id TEXT PRIMARY KEY REFERENCES learning_cards(card_id) ON DELETE CASCADE,
    stage TEXT NOT NULL CHECK (stage IN ('new', 'learning', 'stable')),
    due_at_unix_ms INTEGER NOT NULL CHECK (due_at_unix_ms >= 0),
    stability REAL CHECK (stability IS NULL OR stability > 0),
    difficulty REAL CHECK (difficulty IS NULL OR difficulty BETWEEN 1 AND 10),
    reps INTEGER NOT NULL CHECK (reps >= 0),
    lapses INTEGER NOT NULL CHECK (lapses >= 0 AND lapses <= reps),
    last_review_at_unix_ms INTEGER CHECK (
        last_review_at_unix_ms IS NULL OR last_review_at_unix_ms >= 0
    ),
    CHECK (
        (reps = 0 AND stability IS NULL AND difficulty IS NULL AND last_review_at_unix_ms IS NULL)
        OR
        (reps > 0 AND stability IS NOT NULL AND difficulty IS NOT NULL AND last_review_at_unix_ms IS NOT NULL)
    )
);

CREATE TABLE learning_sessions (
    session_id TEXT PRIMARY KEY CHECK (length(session_id) BETWEEN 1 AND 64),
    entry_source TEXT NOT NULL CHECK (
        entry_source IN ('manual', 'focus_finished', 'scheduled_window', 'work_gap_experimental')
    ),
    status TEXT NOT NULL CHECK (status IN ('active', 'completed', 'interrupted', 'exited')),
    planned_count INTEGER NOT NULL CHECK (planned_count BETWEEN 1 AND 5),
    completed_count INTEGER NOT NULL CHECK (completed_count BETWEEN 0 AND planned_count),
    started_at_unix_ms INTEGER NOT NULL CHECK (started_at_unix_ms >= 0),
    ended_at_unix_ms INTEGER CHECK (ended_at_unix_ms IS NULL OR ended_at_unix_ms >= started_at_unix_ms),
    exit_reason TEXT CHECK (exit_reason IS NULL OR length(exit_reason) <= 64)
);

CREATE TABLE review_logs (
    review_id TEXT PRIMARY KEY CHECK (length(review_id) BETWEEN 1 AND 64),
    card_id TEXT NOT NULL REFERENCES learning_cards(card_id) ON DELETE CASCADE,
    session_id TEXT NOT NULL REFERENCES learning_sessions(session_id) ON DELETE CASCADE,
    rating TEXT NOT NULL CHECK (rating IN ('again', 'hard', 'good')),
    reviewed_at_unix_ms INTEGER NOT NULL CHECK (reviewed_at_unix_ms >= 0),
    elapsed_days INTEGER NOT NULL CHECK (elapsed_days >= 0),
    scheduled_days INTEGER NOT NULL CHECK (scheduled_days >= 1),
    stability REAL NOT NULL CHECK (stability > 0),
    difficulty REAL NOT NULL CHECK (difficulty BETWEEN 1 AND 10)
);

CREATE TABLE learning_invitation_events (
    event_id TEXT PRIMARY KEY CHECK (length(event_id) BETWEEN 1 AND 64),
    invitation_id TEXT NOT NULL CHECK (length(invitation_id) BETWEEN 1 AND 64),
    trigger_source TEXT NOT NULL CHECK (
        trigger_source IN ('focus_finished', 'scheduled_window', 'work_gap_experimental')
    ),
    stage TEXT NOT NULL CHECK (
        stage IN ('candidate', 'eligible', 'claimed', 'presented', 'engaged', 'dismissed', 'ignored', 'withdrawn', 'suppressed', 'delivery_failed')
    ),
    reason_code TEXT CHECK (reason_code IS NULL OR length(reason_code) <= 64),
    occurred_at_unix_ms INTEGER NOT NULL CHECK (occurred_at_unix_ms >= 0)
);

CREATE INDEX idx_learning_cards_pack ON learning_cards(pack_id);
CREATE INDEX idx_card_schedule_due ON card_schedule(stage, due_at_unix_ms, card_id);
CREATE INDEX idx_review_logs_card_time ON review_logs(card_id, reviewed_at_unix_ms);
CREATE INDEX idx_review_logs_session ON review_logs(session_id);
CREATE INDEX idx_learning_sessions_started ON learning_sessions(started_at_unix_ms);
CREATE INDEX idx_invitation_events_time ON learning_invitation_events(occurred_at_unix_ms);
CREATE INDEX idx_invitation_events_invitation ON learning_invitation_events(invitation_id);

INSERT INTO learning_schema_meta(
    id, schema_version, created_at_unix_ms, migrated_at_unix_ms
) VALUES(1, 1, 0, 0);

INSERT INTO learning_settings(
    id,
    mode,
    cards_per_session,
    daily_new_limit,
    focus_finished_enabled,
    scheduled_windows_enabled,
    work_gap_experimental_enabled,
    daily_invitation_limit,
    invitation_cooldown_minutes,
    invitation_ttl_seconds,
    paused_for_local_day,
    updated_at_unix_ms
) VALUES(1, 'manual_only', 3, 5, 1, 0, 0, 2, 120, 20, NULL, 0);

PRAGMA user_version = 1;

COMMIT;
