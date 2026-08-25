BEGIN IMMEDIATE;

CREATE TABLE learning_question_attempts (
    attempt_id TEXT PRIMARY KEY CHECK (length(attempt_id) BETWEEN 1 AND 64),
    client_answer_id TEXT NOT NULL UNIQUE CHECK (length(client_answer_id) BETWEEN 1 AND 64),
    question_id TEXT NOT NULL UNIQUE CHECK (
        length(question_id) = 64
        AND question_id NOT GLOB '*[^0-9a-f]*'
    ),
    session_id TEXT NOT NULL REFERENCES learning_sessions(session_id) ON DELETE CASCADE,
    card_id TEXT NOT NULL REFERENCES learning_cards(card_id) ON DELETE CASCADE,
    selected_option_id TEXT NOT NULL CHECK (
        length(selected_option_id) = 64
        AND selected_option_id NOT GLOB '*[^0-9a-f]*'
    ),
    correct_option_id TEXT NOT NULL CHECK (
        length(correct_option_id) = 64
        AND correct_option_id NOT GLOB '*[^0-9a-f]*'
    ),
    outcome TEXT NOT NULL CHECK (outcome IN ('correct', 'incorrect')),
    is_remediation INTEGER NOT NULL CHECK (is_remediation IN (0, 1)),
    scheduled_rating TEXT CHECK (scheduled_rating IS NULL OR scheduled_rating IN ('again', 'good')),
    response_ms INTEGER CHECK (response_ms IS NULL OR response_ms BETWEEN 0 AND 3600000),
    answered_at_unix_ms INTEGER NOT NULL CHECK (answered_at_unix_ms >= 0)
);

CREATE TABLE learning_remediation_queue (
    session_id TEXT NOT NULL REFERENCES learning_sessions(session_id) ON DELETE CASCADE,
    card_id TEXT NOT NULL REFERENCES learning_cards(card_id) ON DELETE CASCADE,
    position INTEGER NOT NULL CHECK (position BETWEEN 1 AND 5),
    created_at_unix_ms INTEGER NOT NULL CHECK (created_at_unix_ms >= 0),
    completed_at_unix_ms INTEGER CHECK (
        completed_at_unix_ms IS NULL OR completed_at_unix_ms >= created_at_unix_ms
    ),
    PRIMARY KEY(session_id, card_id),
    UNIQUE(session_id, position)
);

CREATE INDEX idx_question_attempts_card_time
ON learning_question_attempts(card_id, answered_at_unix_ms DESC);

CREATE INDEX idx_question_attempts_outcome_time
ON learning_question_attempts(outcome, answered_at_unix_ms DESC);

CREATE INDEX idx_remediation_queue_pending
ON learning_remediation_queue(session_id, completed_at_unix_ms, position);

PRAGMA user_version = 3;

COMMIT;
