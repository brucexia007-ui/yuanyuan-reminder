use tauri::{AppHandle, Emitter, Manager};

use crate::{
    error::{AppError, AppResult},
    presentation_arbiter::{
        AcquireResult, PetActivitySnapshot, PetActivitySource, PresentationArbiter,
        PresentationLeaseState, PresentationOwner,
    },
    state::AppState,
};

pub const PRESENTATION_LEASE_CHANGED_EVENT: &str = "presentation-lease-changed";
pub const PET_ACTIVITY_SNAPSHOT_UPDATED_EVENT: &str = "pet-activity-snapshot-updated";

#[derive(Debug, Default)]
pub struct PresentationTransition {
    pub granted: bool,
    pub preempted_learning_session: bool,
    pub preempted_learning_invitation: bool,
}

pub fn snapshot(app: &AppHandle) -> PetActivitySnapshot {
    app.state::<AppState>()
        .presentation_arbiter
        .lock()
        .snapshot()
}

pub fn reconcile_local_context(
    app: &AppHandle,
    reminder_owner: Option<PresentationOwner>,
    focus_active: bool,
    scene_rest_active: bool,
    now_unix_ms: i64,
) -> AppResult<PresentationTransition> {
    debug_assert!(reminder_owner.is_none_or(PresentationOwner::is_reminder));
    mutate(app, |arbiter| {
        let mut transition = PresentationTransition::default();
        let current_reminder = arbiter
            .active_lease()
            .map(|lease| lease.owner)
            .filter(|owner| owner.is_reminder());
        if current_reminder.is_some() && current_reminder != reminder_owner {
            arbiter.release_owner(current_reminder.unwrap(), now_unix_ms);
        }

        if focus_active {
            record_result(
                &mut transition,
                arbiter.acquire(PresentationOwner::Focus, now_unix_ms, None, None),
            );
        } else {
            arbiter.release_owner(PresentationOwner::Focus, now_unix_ms);
        }

        if let Some(owner) = reminder_owner {
            record_result(
                &mut transition,
                arbiter.acquire(owner, now_unix_ms, None, None),
            );
        }
        if scene_rest_active {
            record_result(
                &mut transition,
                arbiter.acquire(PresentationOwner::SceneRest, now_unix_ms, None, None),
            );
        }
        transition
    })
}

pub fn reconcile_task_watch(
    app: &AppHandle,
    active: bool,
    attention: bool,
    focus_active: bool,
    scene_rest_active: bool,
    now_unix_ms: i64,
) -> AppResult<PresentationTransition> {
    mutate(app, |arbiter| {
        let mut transition = PresentationTransition::default();
        let desired = active.then_some(if attention {
            PresentationOwner::TaskWatchAttention
        } else {
            PresentationOwner::TaskWatch
        });
        for owner in [
            PresentationOwner::TaskWatch,
            PresentationOwner::TaskWatchAttention,
        ] {
            if Some(owner) != desired {
                arbiter.release_owner(owner, now_unix_ms);
            }
        }
        if focus_active {
            record_result(
                &mut transition,
                arbiter.acquire(PresentationOwner::Focus, now_unix_ms, None, None),
            );
        }
        if active {
            record_result(
                &mut transition,
                arbiter.acquire(
                    desired.expect("active task has an owner"),
                    now_unix_ms,
                    None,
                    None,
                ),
            );
        }
        if scene_rest_active {
            record_result(
                &mut transition,
                arbiter.acquire(PresentationOwner::SceneRest, now_unix_ms, None, None),
            );
        }
        transition
    })
}

pub fn acquire_scene_rest(
    app: &AppHandle,
    now_unix_ms: i64,
    expires_at_unix_ms: i64,
) -> AppResult<bool> {
    mutate(app, |arbiter| {
        arbiter
            .acquire(
                PresentationOwner::SceneRest,
                now_unix_ms,
                Some(expires_at_unix_ms),
                None,
            )
            .granted_lease()
            .is_some()
    })
}

pub fn release_scene_rest(app: &AppHandle, now_unix_ms: i64) -> AppResult<bool> {
    mutate(app, |arbiter| {
        arbiter.release_owner(PresentationOwner::SceneRest, now_unix_ms)
    })
}

pub fn acquire_user_interaction(
    app: &AppHandle,
    now_unix_ms: i64,
    expires_at_unix_ms: i64,
) -> AppResult<Option<crate::presentation_arbiter::PresentationLease>> {
    mutate(app, |arbiter| {
        arbiter.release_owner(PresentationOwner::UserInteraction, now_unix_ms);
        arbiter
            .acquire(
                PresentationOwner::UserInteraction,
                now_unix_ms,
                Some(expires_at_unix_ms),
                None,
            )
            .granted_lease()
            .cloned()
    })
}

pub fn release_user_interaction(
    app: &AppHandle,
    lease_id: &str,
    lease_revision: u64,
    now_unix_ms: i64,
) -> AppResult<bool> {
    mutate(app, |arbiter| {
        arbiter.release_matching_owner(
            PresentationOwner::UserInteraction,
            lease_id,
            lease_revision,
            now_unix_ms,
        )
    })
}

pub fn cancel_user_interaction(app: &AppHandle, now_unix_ms: i64) -> AppResult<bool> {
    mutate(app, |arbiter| {
        arbiter.release_owner(PresentationOwner::UserInteraction, now_unix_ms)
    })
}

#[cfg(feature = "learning")]
pub fn acquire_learning_invitation(
    app: &AppHandle,
    now_unix_ms: i64,
    expires_at_unix_ms: i64,
) -> AppResult<bool> {
    mutate(app, |arbiter| {
        arbiter
            .acquire(
                PresentationOwner::LearningInvitation,
                now_unix_ms,
                Some(expires_at_unix_ms),
                None,
            )
            .granted_lease()
            .is_some()
    })
}

#[cfg(feature = "learning")]
pub fn release_learning_invitation(app: &AppHandle, now_unix_ms: i64) -> AppResult<bool> {
    mutate(app, |arbiter| {
        arbiter.release_owner(PresentationOwner::LearningInvitation, now_unix_ms)
    })
}

#[cfg(feature = "learning")]
pub fn acquire_learning_session(
    app: &AppHandle,
    session_id: &str,
    now_unix_ms: i64,
) -> AppResult<PresentationTransition> {
    mutate(app, |arbiter| {
        let mut transition = PresentationTransition::default();
        record_result(
            &mut transition,
            arbiter.acquire(
                PresentationOwner::LearningSession,
                now_unix_ms,
                None,
                Some(session_id),
            ),
        );
        transition
    })
}

#[cfg(feature = "learning")]
pub fn mark_learning_completed(app: &AppHandle, session_id: &str) -> AppResult<bool> {
    mutate(app, |arbiter| arbiter.mark_learning_completed(session_id))
}

#[cfg(feature = "learning")]
pub fn finish_learning_session(app: &AppHandle, now_unix_ms: i64) -> AppResult<bool> {
    mutate(app, |arbiter| arbiter.finish_learning(now_unix_ms))
}

#[cfg(feature = "learning")]
pub fn finish_learning_session_for(
    app: &AppHandle,
    session_id: &str,
    now_unix_ms: i64,
) -> AppResult<bool> {
    mutate(app, |arbiter| {
        arbiter.finish_learning_session(session_id, now_unix_ms)
    })
}

pub fn set_sleeping(app: &AppHandle, sleeping: bool, source: PetActivitySource) -> AppResult<bool> {
    mutate(app, |arbiter| arbiter.set_sleeping(sleeping, source))
}

fn record_result(transition: &mut PresentationTransition, result: AcquireResult) {
    transition.granted |= result.granted_lease().is_some();
    transition.preempted_learning_session |=
        result.displaced_owner() == Some(PresentationOwner::LearningSession);
    transition.preempted_learning_invitation |=
        result.displaced_owner() == Some(PresentationOwner::LearningInvitation);
}

fn mutate<T>(
    app: &AppHandle,
    operation: impl FnOnce(&mut PresentationArbiter) -> T,
) -> AppResult<T> {
    let state = app.state::<AppState>();
    let (result, lease_state, snapshot, changed) = {
        let mut arbiter = state.presentation_arbiter.lock();
        let previous_revision = arbiter.revision();
        let result = operation(&mut arbiter);
        #[cfg(feature = "learning")]
        arbiter.reconcile_completed_learning(chrono::Utc::now().timestamp_millis());
        (
            result,
            arbiter.lease_state(),
            arbiter.snapshot(),
            arbiter.revision() != previous_revision,
        )
    };
    if changed {
        emit(app, &lease_state, &snapshot)?;
    }
    Ok(result)
}

fn emit(
    app: &AppHandle,
    lease_state: &PresentationLeaseState,
    snapshot: &PetActivitySnapshot,
) -> AppResult<()> {
    app.emit(PRESENTATION_LEASE_CHANGED_EVENT, lease_state)
        .and_then(|_| app.emit(PET_ACTIVITY_SNAPSHOT_UPDATED_EVENT, snapshot))
        .map_err(|error| AppError::Window(error.to_string()))
}
