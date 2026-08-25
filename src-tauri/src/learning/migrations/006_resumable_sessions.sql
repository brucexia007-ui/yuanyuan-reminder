BEGIN IMMEDIATE;

ALTER TABLE review_logs RENAME TO review_logs_v5;
ALTER TABLE learning_question_attempts RENAME TO learning_question_attempts_v5;
ALTER TABLE learning_remediation_queue RENAME TO learning_remediation_queue_v5;
ALTER TABLE learning_session_targets RENAME TO learning_session_targets_v5;
ALTER TABLE learning_sessions RENAME TO learning_sessions_v5;

CREATE TABLE learning_sessions (
    session_id TEXT PRIMARY KEY CHECK (length(session_id) BETWEEN 1 AND 64),
    entry_source TEXT NOT NULL CHECK (
        entry_source IN ('manual', 'focus_finished', 'scheduled_window', 'work_gap_experimental')
    ),
    session_kind TEXT NOT NULL DEFAULT 'daily' CHECK (session_kind IN ('daily', 'mistakes')),
    status TEXT NOT NULL CHECK (
        status IN ('created', 'active', 'paused', 'completed', 'abandoned', 'expired')
    ),
    state_revision INTEGER NOT NULL CHECK (state_revision >= 1),
    current_item_id TEXT CHECK (
        current_item_id IS NULL OR (
            length(current_item_id) = 64
            AND current_item_id NOT GLOB '*[^0-9a-f]*'
        )
    ),
    planned_count INTEGER NOT NULL CHECK (planned_count BETWEEN 1 AND 10),
    completed_count INTEGER NOT NULL CHECK (completed_count BETWEEN 0 AND planned_count),
    started_at_unix_ms INTEGER NOT NULL CHECK (started_at_unix_ms >= 0),
    paused_at_unix_ms INTEGER CHECK (
        paused_at_unix_ms IS NULL OR paused_at_unix_ms >= started_at_unix_ms
    ),
    pause_reason TEXT CHECK (pause_reason IS NULL OR length(pause_reason) <= 64),
    last_activity_at_unix_ms INTEGER NOT NULL CHECK (
        last_activity_at_unix_ms >= started_at_unix_ms
    ),
    expires_at_unix_ms INTEGER NOT NULL CHECK (
        expires_at_unix_ms >= last_activity_at_unix_ms
    ),
    ended_at_unix_ms INTEGER CHECK (
        ended_at_unix_ms IS NULL OR ended_at_unix_ms >= started_at_unix_ms
    ),
    exit_reason TEXT CHECK (exit_reason IS NULL OR length(exit_reason) <= 64),
    CHECK (
        (status = 'paused' AND paused_at_unix_ms IS NOT NULL AND pause_reason IS NOT NULL)
        OR (status <> 'paused' AND paused_at_unix_ms IS NULL AND pause_reason IS NULL)
    ),
    CHECK (
        (status IN ('completed', 'abandoned', 'expired') AND ended_at_unix_ms IS NOT NULL)
        OR (status IN ('created', 'active', 'paused') AND ended_at_unix_ms IS NULL)
    )
);

INSERT INTO learning_sessions(
    session_id, entry_source, session_kind, status, state_revision,
    current_item_id, planned_count, completed_count, started_at_unix_ms,
    paused_at_unix_ms, pause_reason, last_activity_at_unix_ms,
    expires_at_unix_ms, ended_at_unix_ms, exit_reason
)
SELECT
    session_id,
    entry_source,
    session_kind,
    CASE status
        WHEN 'active' THEN 'paused'
        WHEN 'interrupted' THEN 'paused'
        WHEN 'completed' THEN 'completed'
        WHEN 'exited' THEN 'abandoned'
    END,
    1,
    NULL,
    planned_count,
    completed_count,
    started_at_unix_ms,
    CASE WHEN status IN ('active', 'interrupted')
        THEN COALESCE(ended_at_unix_ms, started_at_unix_ms)
        ELSE NULL
    END,
    CASE
        WHEN status = 'active' THEN 'migration_recovery'
        WHEN status = 'interrupted' THEN COALESCE(exit_reason, 'migration_recovery')
        ELSE NULL
    END,
    COALESCE(ended_at_unix_ms, started_at_unix_ms),
    COALESCE(ended_at_unix_ms, started_at_unix_ms) + 86400000,
    CASE WHEN status IN ('completed', 'exited')
        THEN COALESCE(ended_at_unix_ms, started_at_unix_ms)
        ELSE NULL
    END,
    CASE
        WHEN status = 'exited' THEN COALESCE(exit_reason, 'user_exit')
        WHEN status = 'completed' THEN exit_reason
        ELSE NULL
    END
FROM learning_sessions_v5;

CREATE TABLE learning_session_events (
    event_id TEXT PRIMARY KEY CHECK (length(event_id) BETWEEN 1 AND 64),
    session_id TEXT NOT NULL REFERENCES learning_sessions(session_id) ON DELETE CASCADE,
    event_kind TEXT NOT NULL CHECK (
        event_kind IN (
            'created', 'board_presented', 'user_paused', 'interrupted',
            'resumed', 'answer_committed', 'completed', 'abandoned',
            'expired', 'crash_recovered', 'migrated'
        )
    ),
    from_state TEXT CHECK (
        from_state IS NULL OR from_state IN (
            'created', 'active', 'paused', 'completed', 'abandoned', 'expired'
        )
    ),
    to_state TEXT NOT NULL CHECK (
        to_state IN ('created', 'active', 'paused', 'completed', 'abandoned', 'expired')
    ),
    item_id TEXT CHECK (
        item_id IS NULL OR (length(item_id) = 64 AND item_id NOT GLOB '*[^0-9a-f]*')
    ),
    reason TEXT CHECK (reason IS NULL OR length(reason) <= 64),
    occurred_at_unix_ms INTEGER NOT NULL CHECK (occurred_at_unix_ms >= 0),
    state_revision INTEGER NOT NULL CHECK (state_revision >= 1)
);

INSERT INTO learning_session_events(
    event_id, session_id, event_kind, from_state, to_state,
    item_id, reason, occurred_at_unix_ms, state_revision
)
SELECT
    'm6:' || substr(session_id, 1, 60),
    session_id,
    'migrated',
    NULL,
    status,
    current_item_id,
    CASE WHEN status = 'paused' THEN pause_reason ELSE 'v5_to_v6' END,
    last_activity_at_unix_ms,
    1
FROM learning_sessions;

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

INSERT INTO review_logs SELECT * FROM review_logs_v5;

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

INSERT INTO learning_question_attempts SELECT * FROM learning_question_attempts_v5;

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

INSERT INTO learning_remediation_queue SELECT * FROM learning_remediation_queue_v5;

CREATE TABLE learning_session_targets (
    session_id TEXT NOT NULL REFERENCES learning_sessions(session_id) ON DELETE CASCADE,
    card_id TEXT NOT NULL REFERENCES learning_cards(card_id) ON DELETE CASCADE,
    position INTEGER NOT NULL CHECK (position BETWEEN 1 AND 10),
    PRIMARY KEY(session_id, card_id),
    UNIQUE(session_id, position)
);

INSERT INTO learning_session_targets SELECT * FROM learning_session_targets_v5;

DROP TABLE learning_session_targets_v5;
DROP TABLE learning_remediation_queue_v5;
DROP TABLE learning_question_attempts_v5;
DROP TABLE review_logs_v5;
DROP TABLE learning_sessions_v5;

CREATE INDEX idx_review_logs_card_time ON review_logs(card_id, reviewed_at_unix_ms);
CREATE INDEX idx_review_logs_session ON review_logs(session_id);
CREATE INDEX idx_learning_sessions_started ON learning_sessions(started_at_unix_ms);
CREATE INDEX idx_learning_sessions_kind_started ON learning_sessions(session_kind, started_at_unix_ms);
CREATE UNIQUE INDEX idx_learning_sessions_single_active
ON learning_sessions((1)) WHERE status = 'active';
CREATE INDEX idx_learning_sessions_resumable
ON learning_sessions(status, expires_at_unix_ms DESC, last_activity_at_unix_ms DESC);
CREATE INDEX idx_learning_session_events_session_revision
ON learning_session_events(session_id, state_revision);
CREATE INDEX idx_question_attempts_card_time ON learning_question_attempts(card_id, answered_at_unix_ms DESC);
CREATE INDEX idx_question_attempts_outcome_time ON learning_question_attempts(outcome, answered_at_unix_ms DESC);
CREATE INDEX idx_remediation_queue_pending ON learning_remediation_queue(session_id, completed_at_unix_ms, position);
CREATE INDEX idx_learning_session_targets_position ON learning_session_targets(session_id, position);

PRAGMA user_version = 6;

COMMIT;
