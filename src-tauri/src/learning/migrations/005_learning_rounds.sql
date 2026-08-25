BEGIN IMMEDIATE;

ALTER TABLE learning_settings RENAME TO learning_settings_v4;

CREATE TABLE learning_settings (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    mode TEXT NOT NULL CHECK (mode IN ('manual_only', 'automatic_opt_in')),
    cards_per_session INTEGER NOT NULL CHECK (cards_per_session IN (3, 5, 10)),
    daily_new_limit INTEGER NOT NULL CHECK (daily_new_limit IN (0, 5, 10, 20, 30)),
    daily_goal INTEGER NOT NULL CHECK (daily_goal IN (0, 5, 10, 20, 30, 50)),
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

INSERT INTO learning_settings(
    id, mode, cards_per_session, daily_new_limit, daily_goal,
    focus_finished_enabled, scheduled_windows_enabled,
    work_gap_experimental_enabled, daily_invitation_limit,
    invitation_cooldown_minutes, invitation_ttl_seconds,
    paused_for_local_day, updated_at_unix_ms
)
SELECT id, mode,
    CASE cards_per_session WHEN 1 THEN 3 ELSE cards_per_session END,
    daily_new_limit, 0,
    focus_finished_enabled, scheduled_windows_enabled,
    work_gap_experimental_enabled, daily_invitation_limit,
    invitation_cooldown_minutes, invitation_ttl_seconds,
    paused_for_local_day, updated_at_unix_ms
FROM learning_settings_v4;

DROP TABLE learning_settings_v4;

ALTER TABLE review_logs RENAME TO review_logs_v4;
ALTER TABLE learning_question_attempts RENAME TO learning_question_attempts_v4;
ALTER TABLE learning_remediation_queue RENAME TO learning_remediation_queue_v4;
ALTER TABLE learning_sessions RENAME TO learning_sessions_v4;

CREATE TABLE learning_sessions (
    session_id TEXT PRIMARY KEY CHECK (length(session_id) BETWEEN 1 AND 64),
    entry_source TEXT NOT NULL CHECK (
        entry_source IN ('manual', 'focus_finished', 'scheduled_window', 'work_gap_experimental')
    ),
    session_kind TEXT NOT NULL DEFAULT 'daily' CHECK (session_kind IN ('daily', 'mistakes')),
    status TEXT NOT NULL CHECK (status IN ('active', 'completed', 'interrupted', 'exited')),
    planned_count INTEGER NOT NULL CHECK (planned_count BETWEEN 1 AND 10),
    completed_count INTEGER NOT NULL CHECK (completed_count BETWEEN 0 AND planned_count),
    started_at_unix_ms INTEGER NOT NULL CHECK (started_at_unix_ms >= 0),
    ended_at_unix_ms INTEGER CHECK (ended_at_unix_ms IS NULL OR ended_at_unix_ms >= started_at_unix_ms),
    exit_reason TEXT CHECK (exit_reason IS NULL OR length(exit_reason) <= 64)
);

INSERT INTO learning_sessions(
    session_id, entry_source, session_kind, status, planned_count,
    completed_count, started_at_unix_ms, ended_at_unix_ms, exit_reason
)
SELECT session_id, entry_source, session_kind, status, planned_count,
    completed_count, started_at_unix_ms, ended_at_unix_ms, exit_reason
FROM learning_sessions_v4;

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

INSERT INTO review_logs SELECT * FROM review_logs_v4;

CREATE TABLE learning_question_attempts (
    attempt_id TEXT PRIMARY KEY CHECK (length(attempt_id) BETWEEN 1 AND 64),
    client_answer_id TEXT NOT NULL UNIQUE CHECK (length(client_answer_id) BETWEEN 1 AND 64),
    question_id TEXT NOT NULL UNIQUE CHECK (
        length(question_id) = 64 AND question_id NOT GLOB '*[^0-9a-f]*'
    ),
    session_id TEXT NOT NULL REFERENCES learning_sessions(session_id) ON DELETE CASCADE,
    card_id TEXT NOT NULL REFERENCES learning_cards(card_id) ON DELETE CASCADE,
    selected_option_id TEXT NOT NULL CHECK (
        length(selected_option_id) = 64 AND selected_option_id NOT GLOB '*[^0-9a-f]*'
    ),
    correct_option_id TEXT NOT NULL CHECK (
        length(correct_option_id) = 64 AND correct_option_id NOT GLOB '*[^0-9a-f]*'
    ),
    outcome TEXT NOT NULL CHECK (outcome IN ('correct', 'incorrect')),
    is_remediation INTEGER NOT NULL CHECK (is_remediation IN (0, 1)),
    scheduled_rating TEXT CHECK (scheduled_rating IS NULL OR scheduled_rating IN ('again', 'good')),
    response_ms INTEGER CHECK (response_ms IS NULL OR response_ms BETWEEN 0 AND 3600000),
    answered_at_unix_ms INTEGER NOT NULL CHECK (answered_at_unix_ms >= 0)
);

INSERT INTO learning_question_attempts SELECT * FROM learning_question_attempts_v4;

CREATE TABLE learning_remediation_queue (
    session_id TEXT NOT NULL REFERENCES learning_sessions(session_id) ON DELETE CASCADE,
    card_id TEXT NOT NULL REFERENCES learning_cards(card_id) ON DELETE CASCADE,
    position INTEGER NOT NULL CHECK (position BETWEEN 1 AND 10),
    created_at_unix_ms INTEGER NOT NULL CHECK (created_at_unix_ms >= 0),
    completed_at_unix_ms INTEGER CHECK (
        completed_at_unix_ms IS NULL OR completed_at_unix_ms >= created_at_unix_ms
    ),
    PRIMARY KEY(session_id, card_id),
    UNIQUE(session_id, position)
);

INSERT INTO learning_remediation_queue SELECT * FROM learning_remediation_queue_v4;

CREATE TABLE learning_session_targets (
    session_id TEXT NOT NULL REFERENCES learning_sessions(session_id) ON DELETE CASCADE,
    card_id TEXT NOT NULL REFERENCES learning_cards(card_id) ON DELETE CASCADE,
    position INTEGER NOT NULL CHECK (position BETWEEN 1 AND 10),
    PRIMARY KEY(session_id, card_id),
    UNIQUE(session_id, position)
);

DROP TABLE learning_remediation_queue_v4;
DROP TABLE learning_question_attempts_v4;
DROP TABLE review_logs_v4;
DROP TABLE learning_sessions_v4;

CREATE INDEX idx_review_logs_card_time ON review_logs(card_id, reviewed_at_unix_ms);
CREATE INDEX idx_review_logs_session ON review_logs(session_id);
CREATE INDEX idx_learning_sessions_started ON learning_sessions(started_at_unix_ms);
CREATE INDEX idx_learning_sessions_kind_started ON learning_sessions(session_kind, started_at_unix_ms);
CREATE INDEX idx_question_attempts_card_time ON learning_question_attempts(card_id, answered_at_unix_ms DESC);
CREATE INDEX idx_question_attempts_outcome_time ON learning_question_attempts(outcome, answered_at_unix_ms DESC);
CREATE INDEX idx_remediation_queue_pending ON learning_remediation_queue(session_id, completed_at_unix_ms, position);
CREATE INDEX idx_learning_session_targets_position ON learning_session_targets(session_id, position);

PRAGMA user_version = 5;

COMMIT;
