use std::cell::{Cell, RefCell};

use super::finish_created_learning_start;
use crate::{
    error::{AppError, AppResult},
    learning::{LearningRuntime, LearningSessionKind, LearningSessionSnapshot},
    presentation_arbiter::{PresentationArbiter, PresentationOwner},
};

fn runtime(path: &std::path::Path) -> RefCell<LearningRuntime> {
    let mut runtime = LearningRuntime::initialize(path);
    let preview = runtime
        .preview_csv_import(
            "headword,meanings_zh\napple,苹果\nbook,书\ncat,猫\n".as_bytes(),
            1_000,
        )
        .unwrap();
    runtime
        .confirm_import(preview.preview_token.as_deref().unwrap(), 2_000)
        .unwrap();
    RefCell::new(runtime)
}

fn created(runtime: &RefCell<LearningRuntime>) -> LearningSessionSnapshot {
    runtime
        .borrow_mut()
        .start_manual_session(3, LearningSessionKind::Daily, None, 3_000)
        .unwrap()
}

fn abandon(runtime: &RefCell<LearningRuntime>, session: &LearningSessionSnapshot) -> AppResult<()> {
    runtime
        .borrow_mut()
        .abandon_session(
            &session.session_id,
            session.state_revision,
            "presentation_denied",
            4_000,
        )
        .map(|_| ())
}

#[test]
fn denied_learning_start_does_not_strand_a_session_or_change_the_blocker() {
    for owner in [
        PresentationOwner::WaterReminder,
        PresentationOwner::MealReminder,
        PresentationOwner::StrongReminder,
        PresentationOwner::NormalReminder,
        PresentationOwner::MovementReminder,
        PresentationOwner::TaskWatchAttention,
        PresentationOwner::UserInteraction,
        PresentationOwner::Focus,
    ] {
        let dir = tempfile::tempdir().unwrap();
        let runtime = runtime(&dir.path().join("learning.sqlite3"));
        let session = created(&runtime);
        let arbiter = RefCell::new(PresentationArbiter::default());
        arbiter.borrow_mut().acquire(owner, 3_000, None, None);
        let blocker = arbiter.borrow().active_lease().cloned().unwrap();
        let result = finish_created_learning_start(
            || {
                let result = arbiter.borrow_mut().acquire(
                    PresentationOwner::LearningSession,
                    3_001,
                    None,
                    Some(&session.session_id),
                );
                if result.granted_lease().is_none() {
                    Err(AppError::Validation(
                        "a higher priority presentation is active".into(),
                    ))
                } else {
                    Ok(())
                }
            },
            || panic!("denied presentation must not activate the database session"),
            || abandon(&runtime, &session),
            || {
                arbiter
                    .borrow_mut()
                    .finish_learning_session(&session.session_id, 4_000);
                Ok(())
            },
        );
        assert!(result.unwrap_err().to_string().contains("higher priority"));
        assert!(
            runtime
                .borrow_mut()
                .resumable_session(4_000)
                .unwrap()
                .is_none(),
            "{owner:?}"
        );
        assert_eq!(arbiter.borrow().active_lease(), Some(&blocker));
        assert_eq!(
            runtime
                .borrow_mut()
                .session_summary(&session.session_id, 4_000)
                .unwrap()
                .session
                .status,
            "abandoned"
        );
        arbiter.borrow_mut().release_owner(owner, 4_001);
        let retry = runtime
            .borrow_mut()
            .start_manual_session(3, LearningSessionKind::Daily, None, 5_000)
            .unwrap();
        let active = finish_created_learning_start(
            || {
                assert!(arbiter
                    .borrow_mut()
                    .acquire(
                        PresentationOwner::LearningSession,
                        5_001,
                        None,
                        Some(&retry.session_id)
                    )
                    .granted_lease()
                    .is_some());
                Ok(())
            },
            || {
                runtime
                    .borrow_mut()
                    .present_session(&retry.session_id, retry.state_revision, 5_002)
            },
            || panic!("successful retry must not be abandoned"),
            || panic!("successful retry must keep its lease"),
        )
        .unwrap();
        assert_eq!(active.status, "active");
        assert_eq!(active.completed_count, 0);
        let summary = runtime
            .borrow_mut()
            .session_summary(&active.session_id, 5_003)
            .unwrap();
        assert_eq!(summary.correct_count + summary.wrong_count, 0);
    }
}

#[test]
fn partial_acquisition_failure_releases_the_exact_learning_lease() {
    let dir = tempfile::tempdir().unwrap();
    let runtime = runtime(&dir.path().join("learning.sqlite3"));
    let session = created(&runtime);
    let arbiter = RefCell::new(PresentationArbiter::default());
    let result = finish_created_learning_start(
        || {
            arbiter.borrow_mut().acquire(
                PresentationOwner::LearningSession,
                3_001,
                None,
                Some(&session.session_id),
            );
            Err(AppError::Window("injected event delivery failure".into()))
        },
        || panic!("failed acquisition cannot present"),
        || abandon(&runtime, &session),
        || {
            assert!(arbiter
                .borrow_mut()
                .finish_learning_session(&session.session_id, 4_000));
            Ok(())
        },
    );
    assert!(result
        .unwrap_err()
        .to_string()
        .contains("event delivery failure"));
    assert!(arbiter.borrow().active_lease().is_none());
    assert!(runtime
        .borrow_mut()
        .resumable_session(4_000)
        .unwrap()
        .is_none());
}

#[test]
fn presentation_failure_abandons_unstarted_session_without_hiding_the_error() {
    let dir = tempfile::tempdir().unwrap();
    let runtime = runtime(&dir.path().join("learning.sqlite3"));
    let session = created(&runtime);
    let released = Cell::new(false);
    let result = finish_created_learning_start(
        || Ok(()),
        || Err(AppError::Window("injected presentation failure".into())),
        || abandon(&runtime, &session),
        || {
            released.set(true);
            Ok(())
        },
    );
    assert!(result
        .unwrap_err()
        .to_string()
        .contains("presentation failure"));
    assert!(released.get());
    assert!(runtime
        .borrow_mut()
        .resumable_session(4_000)
        .unwrap()
        .is_none());
}

#[test]
fn stale_startup_cleanup_cannot_abandon_or_release_a_newer_active_session() {
    let dir = tempfile::tempdir().unwrap();
    let runtime = runtime(&dir.path().join("learning.sqlite3"));
    let session = created(&runtime);
    let active = runtime
        .borrow_mut()
        .present_session(&session.session_id, session.state_revision, 3_001)
        .unwrap();
    let result = finish_created_learning_start(
        || Ok(()),
        || {
            runtime
                .borrow_mut()
                .present_session(&session.session_id, session.state_revision, 3_002)
        },
        || abandon(&runtime, &session),
        || panic!("stale cleanup must not release the newer presentation"),
    );
    assert!(result.unwrap_err().to_string().contains("cleanup failed"));
    let current = runtime
        .borrow_mut()
        .resumable_session(4_000)
        .unwrap()
        .unwrap();
    assert_eq!(current.status, "active");
    assert_eq!(current.state_revision, active.state_revision);
}

#[test]
fn cleanup_failure_is_reported_and_never_claimed_as_a_clean_denial() {
    let result = finish_created_learning_start(
        || {
            Err(AppError::Validation(
                "a higher priority presentation is active".into(),
            ))
        },
        || panic!("denied presentation must not activate"),
        || Err(AppError::Window("injected database write failure".into())),
        || panic!("cannot release a possibly newer session after failed revision-safe cleanup"),
    );
    let message = result.unwrap_err().to_string();
    assert!(message.contains("cleanup failed"));
    assert!(message.contains("database write failure"));
    assert!(message.contains("higher priority"));
}

#[test]
fn release_failure_is_reported_after_database_cleanup() {
    let dir = tempfile::tempdir().unwrap();
    let runtime = runtime(&dir.path().join("learning.sqlite3"));
    let session = created(&runtime);
    let result = finish_created_learning_start(
        || Err(AppError::Window("injected acquire failure".into())),
        || panic!("failed acquisition cannot present"),
        || abandon(&runtime, &session),
        || Err(AppError::Window("injected release failure".into())),
    );
    let message = result.unwrap_err().to_string();
    assert!(message.contains("cleanup failed"));
    assert!(message.contains("release failure"));
    assert!(runtime
        .borrow_mut()
        .resumable_session(4_000)
        .unwrap()
        .is_none());
}
