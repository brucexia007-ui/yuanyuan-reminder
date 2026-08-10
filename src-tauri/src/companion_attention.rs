use crate::companion_core::{TaskOutcome, TaskSource};

pub const TERMINAL_AGGREGATION_WINDOW_MS: i64 = 30_000;
pub const TERMINAL_SUMMARY_COOLDOWN_MS: i64 = 10 * 60 * 1_000;
pub const TERMINAL_DEFERRED_MAX_AGE_MS: i64 = 24 * 60 * 60 * 1_000;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct TerminalObservation {
    pub source: TaskSource,
    pub outcome: TaskOutcome,
    pub updated_at_unix_ms: i64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct TerminalSummary {
    pub source: TaskSource,
    pub outcome: TaskOutcome,
    pub count: u16,
}

#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct AttentionBudgetRecord {
    pub last_observed_terminal_at_unix_ms: i64,
    pub deferred_count: u16,
    pub deferred_source: Option<TaskSource>,
    pub deferred_outcome: Option<TaskOutcome>,
    pub deferred_latest_at_unix_ms: Option<i64>,
    pub visible_count: u16,
    pub visible_source: Option<TaskSource>,
    pub visible_outcome: Option<TaskOutcome>,
    pub visible_until_unix_ms: Option<i64>,
    pub last_summary_shown_at_unix_ms: Option<i64>,
}

impl AttentionBudgetRecord {
    pub fn observe_terminal_summaries(
        &mut self,
        observations: &[TerminalObservation],
        now_unix_ms: i64,
        suppress_presentation: bool,
    ) -> Option<TerminalSummary> {
        self.expire_old_deferred(now_unix_ms);
        self.expire_visible(now_unix_ms);

        if suppress_presentation {
            self.clear_visible();
        }

        let mut newest_observed = self.last_observed_terminal_at_unix_ms;
        for observation in observations.iter().copied().filter(|observation| {
            observation.updated_at_unix_ms > self.last_observed_terminal_at_unix_ms
                && observation.updated_at_unix_ms <= now_unix_ms
                && now_unix_ms.saturating_sub(observation.updated_at_unix_ms)
                    <= TERMINAL_AGGREGATION_WINDOW_MS
        }) {
            newest_observed = newest_observed.max(observation.updated_at_unix_ms);
            if self.visible_count > 0 && !suppress_presentation {
                merge_summary(
                    &mut self.visible_count,
                    &mut self.visible_source,
                    &mut self.visible_outcome,
                    observation.source,
                    observation.outcome,
                );
                self.visible_until_unix_ms = Some(
                    self.visible_until_unix_ms.unwrap_or(now_unix_ms).max(
                        observation
                            .updated_at_unix_ms
                            .saturating_add(TERMINAL_AGGREGATION_WINDOW_MS),
                    ),
                );
            } else {
                merge_summary(
                    &mut self.deferred_count,
                    &mut self.deferred_source,
                    &mut self.deferred_outcome,
                    observation.source,
                    observation.outcome,
                );
                self.deferred_latest_at_unix_ms = Some(
                    self.deferred_latest_at_unix_ms
                        .unwrap_or(observation.updated_at_unix_ms)
                        .max(observation.updated_at_unix_ms),
                );
            }
        }
        self.last_observed_terminal_at_unix_ms = newest_observed;

        if suppress_presentation {
            return None;
        }
        if self.visible_count > 0 {
            return self.visible_summary();
        }
        if self.deferred_count == 0 || !self.cooldown_elapsed(now_unix_ms) {
            return None;
        }

        self.visible_count = self.deferred_count;
        self.visible_source = self.deferred_source;
        self.visible_outcome = self.deferred_outcome;
        self.visible_until_unix_ms =
            Some(now_unix_ms.saturating_add(TERMINAL_AGGREGATION_WINDOW_MS));
        self.last_summary_shown_at_unix_ms = Some(now_unix_ms);
        self.clear_deferred();
        self.visible_summary()
    }

    pub fn is_valid(&self) -> bool {
        self.last_observed_terminal_at_unix_ms >= 0
            && slot_is_valid(
                self.deferred_count,
                self.deferred_source,
                self.deferred_outcome,
            )
            && slot_is_valid(
                self.visible_count,
                self.visible_source,
                self.visible_outcome,
            )
            && (self.deferred_count > 0) == self.deferred_latest_at_unix_ms.is_some()
            && (self.visible_count > 0) == self.visible_until_unix_ms.is_some()
            && self
                .deferred_latest_at_unix_ms
                .is_none_or(|value| value >= 0)
            && self.visible_until_unix_ms.is_none_or(|value| value >= 0)
            && self
                .last_summary_shown_at_unix_ms
                .is_none_or(|value| value >= 0)
    }

    fn cooldown_elapsed(&self, now_unix_ms: i64) -> bool {
        self.last_summary_shown_at_unix_ms
            .is_none_or(|last| now_unix_ms.saturating_sub(last) >= TERMINAL_SUMMARY_COOLDOWN_MS)
    }

    fn expire_visible(&mut self, now_unix_ms: i64) {
        if self
            .visible_until_unix_ms
            .is_some_and(|until| until <= now_unix_ms)
        {
            self.clear_visible();
        }
    }

    fn expire_old_deferred(&mut self, now_unix_ms: i64) {
        if self
            .deferred_latest_at_unix_ms
            .is_some_and(|latest| now_unix_ms.saturating_sub(latest) > TERMINAL_DEFERRED_MAX_AGE_MS)
        {
            self.clear_deferred();
        }
    }

    fn visible_summary(&self) -> Option<TerminalSummary> {
        Some(TerminalSummary {
            source: self.visible_source?,
            outcome: self.visible_outcome?,
            count: self.visible_count,
        })
        .filter(|summary| summary.count > 0)
    }

    fn clear_deferred(&mut self) {
        self.deferred_count = 0;
        self.deferred_source = None;
        self.deferred_outcome = None;
        self.deferred_latest_at_unix_ms = None;
    }

    fn clear_visible(&mut self) {
        self.visible_count = 0;
        self.visible_source = None;
        self.visible_outcome = None;
        self.visible_until_unix_ms = None;
    }
}

pub fn task_source_name(source: TaskSource) -> &'static str {
    match source {
        TaskSource::Codex => "codex",
        TaskSource::ClaudeCode => "claude_code",
    }
}

pub fn parse_task_source(value: &str) -> Option<TaskSource> {
    match value {
        "codex" => Some(TaskSource::Codex),
        "claude_code" => Some(TaskSource::ClaudeCode),
        _ => None,
    }
}

pub fn task_outcome_name(outcome: TaskOutcome) -> &'static str {
    match outcome {
        TaskOutcome::Succeeded => "succeeded",
        TaskOutcome::Failed => "failed",
        TaskOutcome::Cancelled => "cancelled",
    }
}

pub fn parse_task_outcome(value: &str) -> Option<TaskOutcome> {
    match value {
        "succeeded" => Some(TaskOutcome::Succeeded),
        "failed" => Some(TaskOutcome::Failed),
        "cancelled" => Some(TaskOutcome::Cancelled),
        _ => None,
    }
}

fn merge_summary(
    count: &mut u16,
    source: &mut Option<TaskSource>,
    outcome: &mut Option<TaskOutcome>,
    next_source: TaskSource,
    next_outcome: TaskOutcome,
) {
    if *count == 0
        || outcome.is_none_or(|current| outcome_rank(next_outcome) > outcome_rank(current))
    {
        *source = Some(next_source);
        *outcome = Some(next_outcome);
    }
    *count = count.saturating_add(1);
}

fn outcome_rank(outcome: TaskOutcome) -> u8 {
    match outcome {
        TaskOutcome::Failed => 3,
        TaskOutcome::Succeeded => 2,
        TaskOutcome::Cancelled => 1,
    }
}

fn slot_is_valid(count: u16, source: Option<TaskSource>, outcome: Option<TaskOutcome>) -> bool {
    (count == 0 && source.is_none() && outcome.is_none())
        || (count > 0 && source.is_some() && outcome.is_some())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn observation(
        source: TaskSource,
        outcome: TaskOutcome,
        updated_at_unix_ms: i64,
    ) -> TerminalObservation {
        TerminalObservation {
            source,
            outcome,
            updated_at_unix_ms,
        }
    }

    #[test]
    fn terminal_summary_is_bounded_to_one_presentation_per_ten_minutes() {
        let mut budget = AttentionBudgetRecord::default();
        let first = budget.observe_terminal_summaries(
            &[observation(
                TaskSource::Codex,
                TaskOutcome::Succeeded,
                1_000,
            )],
            1_000,
            false,
        );
        assert_eq!(first.unwrap().count, 1);

        assert!(budget
            .observe_terminal_summaries(&[], 31_001, false)
            .is_none());
        assert!(budget
            .observe_terminal_summaries(
                &[observation(
                    TaskSource::ClaudeCode,
                    TaskOutcome::Failed,
                    40_000,
                )],
                40_000,
                false,
            )
            .is_none());
        let second = budget
            .observe_terminal_summaries(&[], 601_000, false)
            .unwrap();
        assert_eq!(second.count, 1);
        assert_eq!(second.outcome, TaskOutcome::Failed);
    }

    #[test]
    fn suppression_collects_one_dominant_aggregate_without_recounting_polls() {
        let mut budget = AttentionBudgetRecord::default();
        let observations = [
            observation(TaskSource::ClaudeCode, TaskOutcome::Succeeded, 10_000),
            observation(TaskSource::Codex, TaskOutcome::Failed, 11_000),
        ];
        assert!(budget
            .observe_terminal_summaries(&observations, 12_000, true)
            .is_none());
        assert!(budget
            .observe_terminal_summaries(&observations, 20_000, true)
            .is_none());

        let summary = budget
            .observe_terminal_summaries(&observations, 21_000, false)
            .unwrap();
        assert_eq!(summary.count, 2);
        assert_eq!(summary.source, TaskSource::Codex);
        assert_eq!(summary.outcome, TaskOutcome::Failed);
    }

    #[test]
    fn visible_summary_extends_for_a_new_event_but_future_and_old_events_are_ignored() {
        let mut budget = AttentionBudgetRecord::default();
        budget.observe_terminal_summaries(
            &[observation(
                TaskSource::Codex,
                TaskOutcome::Succeeded,
                10_000,
            )],
            10_000,
            false,
        );
        let summary = budget
            .observe_terminal_summaries(
                &[
                    observation(TaskSource::Codex, TaskOutcome::Cancelled, 35_000),
                    observation(TaskSource::Codex, TaskOutcome::Failed, 70_000),
                ],
                35_000,
                false,
            )
            .unwrap();
        assert_eq!(summary.count, 2);
        assert_eq!(summary.outcome, TaskOutcome::Succeeded);
        assert_eq!(budget.last_observed_terminal_at_unix_ms, 35_000);
        assert!(budget
            .observe_terminal_summaries(&[], 65_000, false)
            .is_none());
    }

    #[test]
    fn stale_deferred_summary_expires_and_record_invariants_are_checkable() {
        let mut budget = AttentionBudgetRecord::default();
        budget.observe_terminal_summaries(
            &[observation(
                TaskSource::Codex,
                TaskOutcome::Cancelled,
                1_000,
            )],
            1_000,
            true,
        );
        assert!(budget.is_valid());
        assert!(budget
            .observe_terminal_summaries(&[], 1_000 + TERMINAL_DEFERRED_MAX_AGE_MS + 1, false,)
            .is_none());
        assert_eq!(budget.deferred_count, 0);
        assert!(budget.is_valid());
    }
}
