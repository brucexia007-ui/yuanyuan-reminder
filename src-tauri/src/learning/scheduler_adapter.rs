use chrono::{Duration, TimeZone, Utc};
use fsrs::{ItemState, MemoryState, FSRS};

use crate::error::{AppError, AppResult};

use super::models::{LearningRating, LearningStage, ScheduleInput, ScheduleOutcome};

const DESIRED_RETENTION: f32 = 0.9;
const RELATIVELY_STABLE_DAYS: f32 = 21.0;
const MIN_STABLE_REPS: u32 = 3;
const MILLIS_PER_DAY: i64 = 24 * 60 * 60 * 1_000;

#[derive(Debug, Default, Clone)]
pub struct FsrsScheduler {
    fsrs: FSRS,
}

impl FsrsScheduler {
    pub fn schedule(
        &self,
        input: &ScheduleInput,
        rating: LearningRating,
        now_unix_ms: i64,
    ) -> AppResult<ScheduleOutcome> {
        validate_input(input, now_unix_ms)?;
        let now = Utc
            .timestamp_millis_opt(now_unix_ms)
            .single()
            .ok_or_else(|| AppError::Time("learning review clock is invalid".into()))?;
        let elapsed_days = input
            .last_review_at_unix_ms
            .map(|last| ((now_unix_ms - last) / MILLIS_PER_DAY) as u32)
            .unwrap_or(0);
        let memory = match (input.stability, input.difficulty) {
            (Some(stability), Some(difficulty)) => Some(MemoryState {
                stability,
                difficulty,
            }),
            (None, None) => None,
            _ => {
                return Err(AppError::Validation(
                    "learning schedule memory is incomplete".into(),
                ));
            }
        };
        let choices = self
            .fsrs
            .next_states(memory, DESIRED_RETENTION, elapsed_days)
            .map_err(|_| AppError::Validation("learning schedule input is invalid".into()))?;
        let selected = match rating {
            LearningRating::Again => choices.again,
            LearningRating::Hard => choices.hard,
            LearningRating::Good => choices.good,
        };
        outcome(input, rating, now, elapsed_days, selected)
    }
}

fn validate_input(input: &ScheduleInput, now_unix_ms: i64) -> AppResult<()> {
    if now_unix_ms < 0 || input.lapses > input.reps {
        return Err(AppError::Validation(
            "learning schedule counters or clock are invalid".into(),
        ));
    }
    match (
        input.reps,
        input.stability,
        input.difficulty,
        input.last_review_at_unix_ms,
    ) {
        (0, None, None, None) => Ok(()),
        (reps, Some(stability), Some(difficulty), Some(last_review))
            if reps > 0
                && stability.is_finite()
                && stability > 0.0
                && difficulty.is_finite()
                && (1.0..=10.0).contains(&difficulty)
                && last_review >= 0
                && last_review <= now_unix_ms =>
        {
            Ok(())
        }
        (_, _, _, Some(last_review)) if last_review > now_unix_ms => Err(AppError::Time(
            "learning review clock moved backwards".into(),
        )),
        _ => Err(AppError::Validation(
            "learning schedule state is invalid".into(),
        )),
    }
}

fn outcome(
    input: &ScheduleInput,
    rating: LearningRating,
    now: chrono::DateTime<Utc>,
    elapsed_days: u32,
    selected: ItemState,
) -> AppResult<ScheduleOutcome> {
    if !selected.interval.is_finite()
        || !selected.memory.stability.is_finite()
        || !selected.memory.difficulty.is_finite()
    {
        return Err(AppError::Validation(
            "learning scheduler returned a non-finite value".into(),
        ));
    }
    let scheduled_days = selected.interval.round().clamp(1.0, 36_500.0) as u32;
    let due_at_unix_ms = now
        .checked_add_signed(Duration::days(i64::from(scheduled_days)))
        .ok_or_else(|| AppError::Time("learning due date is out of range".into()))?
        .timestamp_millis();
    let reps = input.reps.saturating_add(1);
    let lapses = input
        .lapses
        .saturating_add(u32::from(rating == LearningRating::Again && input.reps > 0));
    let stage = if reps >= MIN_STABLE_REPS && selected.memory.stability >= RELATIVELY_STABLE_DAYS {
        LearningStage::Stable
    } else {
        LearningStage::Learning
    };
    Ok(ScheduleOutcome {
        stage,
        due_at_unix_ms,
        stability: selected.memory.stability,
        difficulty: selected.memory.difficulty,
        reps,
        lapses,
        elapsed_days,
        scheduled_days,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    const NOW: i64 = 1_800_000_000_000;

    #[test]
    fn three_visible_ratings_map_to_fsrs_without_easy() {
        let scheduler = FsrsScheduler::default();
        let again = scheduler
            .schedule(&ScheduleInput::default(), LearningRating::Again, NOW)
            .unwrap();
        let hard = scheduler
            .schedule(&ScheduleInput::default(), LearningRating::Hard, NOW)
            .unwrap();
        let good = scheduler
            .schedule(&ScheduleInput::default(), LearningRating::Good, NOW)
            .unwrap();

        assert!((again.stability - 0.212).abs() < 0.0001);
        assert!((hard.stability - 1.2931).abs() < 0.0001);
        assert!((good.stability - 2.3065).abs() < 0.0001);
        assert!(again.difficulty > hard.difficulty);
        assert!(hard.difficulty > good.difficulty);
        assert_eq!(again.scheduled_days, 1);
        assert_eq!(hard.scheduled_days, 1);
        assert_eq!(good.scheduled_days, 2);
    }

    #[test]
    fn frozen_good_review_vector_is_deterministic() {
        let scheduler = FsrsScheduler::default();
        let mut input = ScheduleInput::default();
        let mut now = NOW;
        let mut intervals = Vec::new();
        for _ in 0..5 {
            let outcome = scheduler
                .schedule(&input, LearningRating::Good, now)
                .unwrap();
            intervals.push(outcome.scheduled_days);
            input = ScheduleInput {
                reps: outcome.reps,
                lapses: outcome.lapses,
                stability: Some(outcome.stability),
                difficulty: Some(outcome.difficulty),
                last_review_at_unix_ms: Some(now),
            };
            now = outcome.due_at_unix_ms;
        }
        assert_eq!(intervals, [2, 11, 46, 163, 497]);
    }

    #[test]
    fn clock_rollback_and_partial_memory_fail_closed() {
        let scheduler = FsrsScheduler::default();
        let rollback = ScheduleInput {
            reps: 1,
            lapses: 0,
            stability: Some(2.0),
            difficulty: Some(5.0),
            last_review_at_unix_ms: Some(NOW + 1),
        };
        assert!(matches!(
            scheduler.schedule(&rollback, LearningRating::Good, NOW),
            Err(AppError::Time(_))
        ));
        let partial = ScheduleInput {
            reps: 1,
            lapses: 0,
            stability: Some(2.0),
            difficulty: None,
            last_review_at_unix_ms: Some(NOW),
        };
        assert!(matches!(
            scheduler.schedule(&partial, LearningRating::Good, NOW),
            Err(AppError::Validation(_))
        ));
    }
}
