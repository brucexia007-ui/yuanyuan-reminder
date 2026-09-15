use serde::{Deserialize, Serialize};

// Reserved for the existing Windows lock/auth surface, which remains outside
// this foreground pet lease enum but must stay above every pet presentation.
#[allow(dead_code)]
pub const LOCKED_AUTH_PRIORITY: u8 = 120;
pub const WATER_REMINDER_PRIORITY: u8 = 104;
pub const MEAL_REMINDER_PRIORITY: u8 = 103;
pub const STRONG_REMINDER_PRIORITY: u8 = 102;
pub const NORMAL_REMINDER_PRIORITY: u8 = 102;
pub const TASK_WATCH_ATTENTION_PRIORITY: u8 = 101;
pub const USER_INTERACTION_PRIORITY: u8 = 95;
pub const MOVEMENT_REMINDER_PRIORITY: u8 = 90;
pub const FOCUS_PRIORITY: u8 = 80;
pub const MANUAL_LEARNING_PRIORITY: u8 = 80;
pub const TASK_WATCH_PRIORITY: u8 = 70;
pub const LEARNING_INVITATION_PRIORITY: u8 = 60;
pub const SCENE_REST_PRIORITY: u8 = 40;
pub const AMBIENT_PET_PRIORITY: u8 = 10;

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum PresentationOwner {
    StrongReminder,
    WaterReminder,
    MealReminder,
    UserInteraction,
    MovementReminder,
    NormalReminder,
    Focus,
    LearningSession,
    LearningInvitation,
    TaskWatch,
    TaskWatchAttention,
    SceneRest,
    AmbientPet,
}

impl PresentationOwner {
    pub const fn priority(self) -> u8 {
        match self {
            Self::StrongReminder => STRONG_REMINDER_PRIORITY,
            Self::Focus => FOCUS_PRIORITY,
            Self::WaterReminder => WATER_REMINDER_PRIORITY,
            Self::MealReminder => MEAL_REMINDER_PRIORITY,
            Self::UserInteraction => USER_INTERACTION_PRIORITY,
            Self::MovementReminder => MOVEMENT_REMINDER_PRIORITY,
            Self::NormalReminder => NORMAL_REMINDER_PRIORITY,
            Self::LearningSession => MANUAL_LEARNING_PRIORITY,
            Self::TaskWatch => TASK_WATCH_PRIORITY,
            Self::TaskWatchAttention => TASK_WATCH_ATTENTION_PRIORITY,
            Self::LearningInvitation => LEARNING_INVITATION_PRIORITY,
            Self::SceneRest => SCENE_REST_PRIORITY,
            Self::AmbientPet => AMBIENT_PET_PRIORITY,
        }
    }

    pub const fn preemptible(self) -> bool {
        true
    }

    pub const fn is_reminder(self) -> bool {
        matches!(
            self,
            Self::StrongReminder
                | Self::WaterReminder
                | Self::MealReminder
                | Self::MovementReminder
                | Self::NormalReminder
        )
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct PresentationLease {
    pub lease_id: String,
    pub owner: PresentationOwner,
    pub priority: u8,
    pub preemptible: bool,
    pub revision: u64,
    pub acquired_at_unix_ms: i64,
    pub expires_at_unix_ms: Option<i64>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum AcquireResult {
    Granted(PresentationLease),
    Denied(PresentationLease),
    Preempted {
        displaced: PresentationLease,
        granted: PresentationLease,
    },
}

impl AcquireResult {
    pub fn granted_lease(&self) -> Option<&PresentationLease> {
        match self {
            Self::Granted(lease) | Self::Preempted { granted: lease, .. } => Some(lease),
            Self::Denied(_) => None,
        }
    }

    pub fn displaced_owner(&self) -> Option<PresentationOwner> {
        match self {
            Self::Preempted { displaced, .. } => Some(displaced.owner),
            _ => None,
        }
    }
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum PetActivity {
    Idle,
    Sleeping,
    Reminding,
    Focusing,
    Learning,
    Interrupted,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum PetActivitySource {
    Manual,
    Schedule,
    Reminder,
    Focus,
    Learning,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum PetRestoreTarget {
    Idle,
    Sleeping,
    Focusing,
    Learning,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct PetActivitySnapshot {
    pub revision: u64,
    pub activity: PetActivity,
    pub source: PetActivitySource,
    pub lease_id: Option<String>,
    pub resumable_learning_session_id: Option<String>,
    pub restore_target: Option<PetRestoreTarget>,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct PresentationLeaseState {
    pub revision: u64,
    pub lease: Option<PresentationLease>,
}

#[derive(Debug, Default)]
pub struct PresentationArbiter {
    revision: u64,
    active: Option<PresentationLease>,
    active_learning_session_id: Option<String>,
    resumable_learning_session_id: Option<String>,
    #[cfg(feature = "learning")]
    completed_learning_session_id: Option<String>,
    restore_target: Option<PetRestoreTarget>,
    sleeping: bool,
    sleep_source: Option<PetActivitySource>,
}

impl PresentationArbiter {
    pub fn revision(&self) -> u64 {
        self.revision
    }

    pub fn active_lease(&self) -> Option<&PresentationLease> {
        self.active.as_ref()
    }

    pub fn lease_state(&self) -> PresentationLeaseState {
        PresentationLeaseState {
            revision: self.revision,
            lease: self.active.clone(),
        }
    }

    pub fn acquire(
        &mut self,
        owner: PresentationOwner,
        now_unix_ms: i64,
        expires_at_unix_ms: Option<i64>,
        learning_session_id: Option<&str>,
    ) -> AcquireResult {
        self.expire(now_unix_ms);
        if let Some(active) = self.active.as_ref() {
            if active.owner == owner {
                if owner == PresentationOwner::LearningSession
                    && self.active_learning_session_id.as_deref() != learning_session_id
                {
                    return AcquireResult::Denied(active.clone());
                }
                return AcquireResult::Granted(active.clone());
            }
            if !active.preemptible || active.priority >= owner.priority() {
                let denied_by = active.clone();
                self.remember_denied_restore(owner, learning_session_id);
                return AcquireResult::Denied(denied_by);
            }
        }

        let displaced = self.active.take();
        if let Some(previous) = displaced.as_ref() {
            self.remember_preempted(previous.owner);
        } else if self.sleeping {
            self.restore_target = Some(PetRestoreTarget::Sleeping);
        }
        self.revision = self.revision.saturating_add(1);
        let lease = PresentationLease {
            lease_id: uuid::Uuid::new_v4().to_string(),
            owner,
            priority: owner.priority(),
            preemptible: owner.preemptible(),
            revision: self.revision,
            acquired_at_unix_ms: now_unix_ms,
            expires_at_unix_ms,
        };
        self.active = Some(lease.clone());
        self.active_learning_session_id = if owner == PresentationOwner::LearningSession {
            learning_session_id.map(str::to_owned)
        } else {
            None
        };
        self.clear_restored_target(owner, learning_session_id);

        match displaced {
            Some(displaced) => AcquireResult::Preempted {
                displaced,
                granted: lease,
            },
            None => AcquireResult::Granted(lease),
        }
    }

    pub fn release(&mut self, lease_id: &str, lease_revision: u64, now_unix_ms: i64) -> bool {
        self.expire(now_unix_ms);
        let Some(active) = self.active.as_ref() else {
            return false;
        };
        if active.lease_id != lease_id || active.revision != lease_revision {
            return false;
        }
        self.active = None;
        self.active_learning_session_id = None;
        if self.sleeping && self.restore_target == Some(PetRestoreTarget::Sleeping) {
            self.restore_target = None;
        }
        self.revision = self.revision.saturating_add(1);
        true
    }

    pub fn release_matching_owner(
        &mut self,
        owner: PresentationOwner,
        lease_id: &str,
        lease_revision: u64,
        now_unix_ms: i64,
    ) -> bool {
        if !self
            .active
            .as_ref()
            .is_some_and(|lease| lease.owner == owner)
        {
            return false;
        }
        self.release(lease_id, lease_revision, now_unix_ms)
    }

    pub fn release_owner(&mut self, owner: PresentationOwner, now_unix_ms: i64) -> bool {
        if let Some(active) = self.active.as_ref().filter(|lease| lease.owner == owner) {
            let lease_id = active.lease_id.clone();
            let revision = active.revision;
            return self.release(&lease_id, revision, now_unix_ms);
        }
        let target = restore_target_for_owner(owner);
        if self.restore_target == target {
            self.restore_target = None;
            if owner == PresentationOwner::LearningSession {
                self.resumable_learning_session_id = None;
            }
            self.revision = self.revision.saturating_add(1);
            return true;
        }
        false
    }

    #[cfg(feature = "learning")]
    pub fn acquire_learning_session(
        &mut self,
        session_id: &str,
        now_unix_ms: i64,
    ) -> AcquireResult {
        self.expire(now_unix_ms);
        let completed = self.completed_learning_session_id.clone();
        if let Some(previous) = completed.as_deref().filter(|id| *id != session_id) {
            if let Some(active) = self.active.as_ref().filter(|lease| {
                lease.owner != PresentationOwner::LearningSession
                    && (!lease.preemptible
                        || lease.priority >= PresentationOwner::LearningSession.priority())
            }) {
                // A failed next-round attempt must not replace the old result's
                // restore identity with an unpresented session's identity.
                return AcquireResult::Denied(active.clone());
            }
            // The committed result can hand its presentation to the next round.
            // An unfinished question or a higher-priority overlay still owns its lease.
            if self.active_learning_session_id.as_deref() == Some(previous) {
                self.finish_learning_session(previous, now_unix_ms);
            }
        }
        let result = self.acquire(
            PresentationOwner::LearningSession,
            now_unix_ms,
            None,
            Some(session_id),
        );
        if result.granted_lease().is_some() {
            if let Some(previous) = completed.as_deref().filter(|id| *id != session_id) {
                self.completed_learning_session_id = None;
                if self.resumable_learning_session_id.as_deref() == Some(previous) {
                    self.resumable_learning_session_id = None;
                }
            }
        }
        result
    }

    #[cfg(feature = "learning")]
    pub fn finish_learning(&mut self, now_unix_ms: i64) -> bool {
        let previous_revision = self.revision;
        let mut changed = self.release_owner(PresentationOwner::LearningSession, now_unix_ms);
        if self.completed_learning_session_id.take().is_some() {
            changed = true;
        }
        if self.resumable_learning_session_id.take().is_some() {
            changed = true;
        }
        if self.restore_target == Some(PetRestoreTarget::Learning) {
            self.restore_target = None;
            changed = true;
        }
        if changed && self.revision == previous_revision {
            self.revision = self.revision.saturating_add(1);
        }
        changed
    }

    #[cfg(feature = "learning")]
    pub fn finish_learning_session(&mut self, session_id: &str, now_unix_ms: i64) -> bool {
        if self.active_learning_session_id.as_deref() != Some(session_id)
            && self.resumable_learning_session_id.as_deref() != Some(session_id)
            && self.completed_learning_session_id.as_deref() != Some(session_id)
        {
            return false;
        }
        self.finish_learning(now_unix_ms)
    }

    #[cfg(feature = "learning")]
    pub fn completed_learning_session_id(&self) -> Option<&str> {
        self.completed_learning_session_id.as_deref()
    }

    /// Called only after the final answer/rating has committed. A late replay
    /// cannot recreate a result whose session has been dismissed or replaced.
    #[cfg(feature = "learning")]
    pub fn mark_learning_completed(&mut self, session_id: &str) -> bool {
        if self.sleeping
            || (self.active_learning_session_id.as_deref() != Some(session_id)
                && self.resumable_learning_session_id.as_deref() != Some(session_id))
            || self.completed_learning_session_id.as_deref() == Some(session_id)
        {
            return false;
        }
        self.completed_learning_session_id = Some(session_id.to_owned());
        self.revision = self.revision.saturating_add(1);
        true
    }

    /// Reconcile once after a complete backend transition, before publishing.
    /// Active questions still require an explicit resume; only their finished
    /// result may return automatically, under the normal learning priority.
    #[cfg(feature = "learning")]
    pub fn reconcile_completed_learning(&mut self, now_unix_ms: i64) {
        let Some(session_id) = self.completed_learning_session_id.clone() else {
            return;
        };
        if self.sleeping
            || self.active.as_ref().is_some_and(|lease| {
                lease.priority >= PresentationOwner::LearningSession.priority()
            })
        {
            return;
        }
        self.acquire(
            PresentationOwner::LearningSession,
            now_unix_ms,
            None,
            Some(&session_id),
        );
    }

    pub fn set_sleeping(&mut self, sleeping: bool, source: PetActivitySource) -> bool {
        let next_source = sleeping.then_some(source);
        let interrupts_learning = sleeping
            && self
                .active
                .as_ref()
                .is_some_and(|lease| lease.owner == PresentationOwner::LearningSession);
        if self.sleeping == sleeping && self.sleep_source == next_source && !interrupts_learning {
            return false;
        }

        if interrupts_learning {
            self.active.take();
            self.remember_preempted(PresentationOwner::LearningSession);
            self.active_learning_session_id = None;
        }
        self.sleeping = sleeping;
        self.sleep_source = next_source;
        if sleeping && self.active.is_none() && self.resumable_learning_session_id.is_none() {
            self.restore_target = None;
        } else if sleeping && self.restore_target.is_none() {
            self.restore_target = Some(PetRestoreTarget::Sleeping);
        } else if !sleeping && self.restore_target == Some(PetRestoreTarget::Sleeping) {
            self.restore_target = None;
        }
        self.revision = self.revision.saturating_add(1);
        true
    }

    pub fn expire(&mut self, now_unix_ms: i64) -> bool {
        let expired = self
            .active
            .as_ref()
            .and_then(|lease| lease.expires_at_unix_ms)
            .is_some_and(|expires_at| expires_at <= now_unix_ms);
        if !expired {
            return false;
        }
        self.active = None;
        self.active_learning_session_id = None;
        self.revision = self.revision.saturating_add(1);
        true
    }

    pub fn snapshot(&self) -> PetActivitySnapshot {
        let (activity, source) = match self.active.as_ref().map(|lease| lease.owner) {
            Some(owner) if owner.is_reminder() => {
                (PetActivity::Reminding, PetActivitySource::Reminder)
            }
            Some(PresentationOwner::Focus) => (PetActivity::Focusing, PetActivitySource::Focus),
            Some(PresentationOwner::LearningSession) => {
                (PetActivity::Learning, PetActivitySource::Learning)
            }
            Some(PresentationOwner::TaskWatch | PresentationOwner::TaskWatchAttention) => {
                (PetActivity::Reminding, PetActivitySource::Schedule)
            }
            Some(PresentationOwner::LearningInvitation) => {
                (PetActivity::Idle, PetActivitySource::Learning)
            }
            Some(PresentationOwner::UserInteraction) => {
                (PetActivity::Idle, PetActivitySource::Manual)
            }
            Some(PresentationOwner::SceneRest) => (PetActivity::Idle, PetActivitySource::Manual),
            Some(PresentationOwner::AmbientPet) => (PetActivity::Idle, PetActivitySource::Schedule),
            Some(_) => (PetActivity::Idle, PetActivitySource::Schedule),
            None if self.sleeping => (
                PetActivity::Sleeping,
                self.sleep_source.unwrap_or(PetActivitySource::Schedule),
            ),
            None if self.resumable_learning_session_id.is_some() => {
                (PetActivity::Interrupted, PetActivitySource::Learning)
            }
            None => (PetActivity::Idle, PetActivitySource::Schedule),
        };
        PetActivitySnapshot {
            revision: self.revision,
            activity,
            source,
            lease_id: self.active.as_ref().map(|lease| lease.lease_id.clone()),
            resumable_learning_session_id: self.resumable_learning_session_id.clone(),
            restore_target: self.restore_target,
        }
    }

    fn remember_preempted(&mut self, owner: PresentationOwner) {
        self.restore_target = restore_target_for_owner(owner);
        if owner == PresentationOwner::LearningSession {
            self.resumable_learning_session_id = self.active_learning_session_id.clone();
        }
    }

    fn remember_denied_restore(
        &mut self,
        owner: PresentationOwner,
        learning_session_id: Option<&str>,
    ) {
        let target = restore_target_for_owner(owner);
        let session_id = (owner == PresentationOwner::LearningSession)
            .then(|| learning_session_id.map(str::to_owned))
            .flatten();
        if self.restore_target == target
            && (owner != PresentationOwner::LearningSession
                || self.resumable_learning_session_id == session_id)
        {
            return;
        }
        self.restore_target = target;
        if owner == PresentationOwner::LearningSession {
            self.resumable_learning_session_id = session_id;
        }
        self.revision = self.revision.saturating_add(1);
    }

    fn clear_restored_target(
        &mut self,
        owner: PresentationOwner,
        learning_session_id: Option<&str>,
    ) {
        if self.restore_target == restore_target_for_owner(owner) {
            self.restore_target = None;
        }
        if owner == PresentationOwner::LearningSession
            && self.resumable_learning_session_id.as_deref() == learning_session_id
        {
            self.resumable_learning_session_id = None;
        }
    }
}

fn restore_target_for_owner(owner: PresentationOwner) -> Option<PetRestoreTarget> {
    match owner {
        PresentationOwner::Focus => Some(PetRestoreTarget::Focusing),
        PresentationOwner::LearningSession => Some(PetRestoreTarget::Learning),
        PresentationOwner::AmbientPet => Some(PetRestoreTarget::Idle),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::{Arc, Mutex};

    #[cfg(feature = "learning")]
    #[test]
    fn next_round_replaces_only_a_committed_result_and_ignores_stale_cleanup() {
        let mut arbiter = PresentationArbiter::default();
        arbiter.acquire_learning_session("first", 1);
        assert!(arbiter
            .acquire_learning_session("next", 2)
            .granted_lease()
            .is_none());
        assert!(arbiter.mark_learning_completed("first"));
        let old = arbiter.active_lease().unwrap().clone();
        assert!(arbiter
            .acquire_learning_session("next", 3)
            .granted_lease()
            .is_some());
        assert_ne!(arbiter.active_lease().unwrap().lease_id, old.lease_id);
        assert_eq!(arbiter.completed_learning_session_id(), None);
        assert_eq!(arbiter.snapshot().resumable_learning_session_id, None);
        assert!(!arbiter.finish_learning_session("first", 4));
        assert!(!arbiter.mark_learning_completed("first"));
        assert!(!arbiter.release(&old.lease_id, old.revision, 4));
        arbiter.reconcile_completed_learning(5);
        assert_eq!(arbiter.active_learning_session_id.as_deref(), Some("next"));
    }

    #[cfg(feature = "learning")]
    #[test]
    fn next_round_does_not_bypass_an_overlay_or_lose_the_previous_result_when_denied() {
        for overlay in [
            PresentationOwner::WaterReminder,
            PresentationOwner::Focus,
            PresentationOwner::UserInteraction,
            PresentationOwner::StrongReminder,
        ] {
            let mut arbiter = PresentationArbiter::default();
            arbiter.acquire_learning_session("first", 1);
            arbiter.mark_learning_completed("first");
            // Focus has equal priority, so it starts while a reminder has
            // already displaced the completed result.
            arbiter.acquire(PresentationOwner::WaterReminder, 2, None, None);
            arbiter.release_owner(PresentationOwner::WaterReminder, 2);
            assert!(arbiter
                .acquire(overlay, 2, None, None)
                .granted_lease()
                .is_some());
            assert!(arbiter
                .acquire_learning_session("next", 3)
                .granted_lease()
                .is_none());
            assert_eq!(arbiter.active_lease().unwrap().owner, overlay);
            assert_eq!(arbiter.completed_learning_session_id(), Some("first"));
            assert!(!arbiter.finish_learning_session("next", 4));
            arbiter.release_owner(overlay, 5);
            arbiter.reconcile_completed_learning(5);
            assert_eq!(arbiter.active_learning_session_id.as_deref(), Some("first"));
            assert!(arbiter
                .acquire_learning_session("next", 6)
                .granted_lease()
                .is_some());
            arbiter.finish_learning_session("next", 7);
            arbiter.reconcile_completed_learning(7);
            assert_eq!(arbiter.snapshot().activity, PetActivity::Idle);
        }
    }

    #[cfg(feature = "learning")]
    #[test]
    fn next_round_clears_a_displaced_result_without_restoring_it_over_the_new_session() {
        let mut arbiter = PresentationArbiter::default();
        arbiter.acquire_learning_session("first", 1);
        arbiter.mark_learning_completed("first");
        arbiter.acquire(PresentationOwner::WaterReminder, 2, None, None);
        arbiter.release_owner(PresentationOwner::WaterReminder, 3);
        assert!(arbiter
            .acquire_learning_session("next", 4)
            .granted_lease()
            .is_some());
        assert!(!arbiter.finish_learning_session("first", 5));
        arbiter.finish_learning_session("next", 6);
        arbiter.reconcile_completed_learning(7);
        assert_eq!(arbiter.snapshot().activity, PetActivity::Idle);
    }

    #[cfg(feature = "learning")]
    #[test]
    fn completed_result_restores_after_each_higher_priority_overlay() {
        for overlay in [
            PresentationOwner::WaterReminder,
            PresentationOwner::MealReminder,
            PresentationOwner::StrongReminder,
            PresentationOwner::NormalReminder,
            PresentationOwner::MovementReminder,
            PresentationOwner::TaskWatchAttention,
            PresentationOwner::UserInteraction,
        ] {
            let mut arbiter = PresentationArbiter::default();
            arbiter.acquire(PresentationOwner::LearningSession, 1, None, Some("done"));
            assert!(arbiter.mark_learning_completed("done"));
            arbiter.acquire(overlay, 2, None, None);
            arbiter.reconcile_completed_learning(3);
            assert_eq!(arbiter.active_lease().unwrap().owner, overlay);
            assert_eq!(
                arbiter.snapshot().resumable_learning_session_id.as_deref(),
                Some("done")
            );
            arbiter.release_owner(overlay, 4);
            arbiter.reconcile_completed_learning(4);
            assert_eq!(
                arbiter.snapshot().activity,
                PetActivity::Learning,
                "{overlay:?}"
            );
            let revision = arbiter.revision();
            arbiter.reconcile_completed_learning(5);
            assert_eq!(arbiter.revision(), revision);
            assert!(arbiter.finish_learning_session("done", 6));
            assert!(!arbiter.mark_learning_completed("done"));
            arbiter.reconcile_completed_learning(7);
            assert_eq!(arbiter.snapshot().activity, PetActivity::Idle);
        }
    }

    #[cfg(feature = "learning")]
    #[test]
    fn completion_racing_a_reminder_is_retained_but_an_active_question_is_not_resumed() {
        for completed in [false, true] {
            let mut arbiter = PresentationArbiter::default();
            arbiter.acquire(PresentationOwner::LearningSession, 1, None, Some("session"));
            arbiter.acquire(PresentationOwner::WaterReminder, 2, None, None);
            if completed {
                assert!(arbiter.mark_learning_completed("session"));
            }
            arbiter.release_owner(PresentationOwner::WaterReminder, 3);
            arbiter.reconcile_completed_learning(3);
            assert_eq!(
                arbiter.snapshot().activity,
                if completed {
                    PetActivity::Learning
                } else {
                    PetActivity::Interrupted
                }
            );
        }
    }

    #[cfg(feature = "learning")]
    #[test]
    fn completed_result_waits_for_reminder_queue_and_focus_then_precedes_a_running_task() {
        let mut arbiter = PresentationArbiter::default();
        arbiter.acquire(PresentationOwner::LearningSession, 1, None, Some("done"));
        arbiter.mark_learning_completed("done");
        arbiter.acquire(PresentationOwner::WaterReminder, 2, None, None);
        arbiter.release_owner(PresentationOwner::WaterReminder, 3);
        arbiter.acquire(PresentationOwner::MealReminder, 3, None, None);
        arbiter.reconcile_completed_learning(3);
        assert_eq!(
            arbiter.active_lease().unwrap().owner,
            PresentationOwner::MealReminder
        );
        arbiter.release_owner(PresentationOwner::MealReminder, 4);
        arbiter.acquire(PresentationOwner::Focus, 4, None, None);
        arbiter.reconcile_completed_learning(4);
        assert_eq!(arbiter.snapshot().activity, PetActivity::Focusing);
        arbiter.release_owner(PresentationOwner::Focus, 5);
        arbiter.acquire(PresentationOwner::TaskWatch, 5, None, None);
        arbiter.reconcile_completed_learning(5);
        assert_eq!(arbiter.snapshot().activity, PetActivity::Learning);
        assert!(!arbiter.finish_learning_session("stale", 6));
        assert_eq!(arbiter.snapshot().activity, PetActivity::Learning);
    }

    #[cfg(feature = "learning")]
    #[test]
    fn closing_a_result_before_sleep_or_under_an_overlay_prevents_ghost_learning() {
        for sleeping in [false, true] {
            let mut arbiter = PresentationArbiter::default();
            arbiter.acquire(PresentationOwner::LearningSession, 1, None, Some("done"));
            arbiter.mark_learning_completed("done");
            arbiter.acquire(PresentationOwner::WaterReminder, 2, None, None);
            arbiter.finish_learning_session("done", 3);
            arbiter.set_sleeping(sleeping, PetActivitySource::Manual);
            arbiter.release_owner(PresentationOwner::WaterReminder, 4);
            arbiter.reconcile_completed_learning(4);
            assert_eq!(
                arbiter.snapshot().activity,
                if sleeping {
                    PetActivity::Sleeping
                } else {
                    PetActivity::Idle
                }
            );
            arbiter.set_sleeping(false, PetActivitySource::Manual);
            assert!(!arbiter.mark_learning_completed("done"));
            arbiter.reconcile_completed_learning(5);
            assert_eq!(arbiter.snapshot().activity, PetActivity::Idle);
            assert_eq!(arbiter.snapshot().resumable_learning_session_id, None);
        }
    }

    const ALL_OWNERS: [PresentationOwner; 13] = [
        PresentationOwner::StrongReminder,
        PresentationOwner::Focus,
        PresentationOwner::WaterReminder,
        PresentationOwner::MealReminder,
        PresentationOwner::UserInteraction,
        PresentationOwner::MovementReminder,
        PresentationOwner::NormalReminder,
        PresentationOwner::LearningSession,
        PresentationOwner::TaskWatch,
        PresentationOwner::TaskWatchAttention,
        PresentationOwner::LearningInvitation,
        PresentationOwner::SceneRest,
        PresentationOwner::AmbientPet,
    ];

    fn learning_session_id(owner: PresentationOwner) -> Option<&'static str> {
        (owner == PresentationOwner::LearningSession).then_some("session-a")
    }

    const fn frozen_priority(owner: PresentationOwner) -> u8 {
        match owner {
            PresentationOwner::WaterReminder => 104,
            PresentationOwner::MealReminder => 103,
            PresentationOwner::StrongReminder | PresentationOwner::NormalReminder => 102,
            PresentationOwner::TaskWatchAttention => 101,
            PresentationOwner::UserInteraction => 95,
            PresentationOwner::MovementReminder => 90,
            PresentationOwner::Focus | PresentationOwner::LearningSession => 80,
            PresentationOwner::TaskWatch => 70,
            PresentationOwner::LearningInvitation => 60,
            PresentationOwner::SceneRest => 40,
            PresentationOwner::AmbientPet => 10,
        }
    }

    const fn frozen_preemptible(_owner: PresentationOwner) -> bool {
        true
    }

    #[test]
    fn priorities_are_backend_owned_and_frozen() {
        assert_eq!(LOCKED_AUTH_PRIORITY, 120);
        for owner in ALL_OWNERS {
            assert_eq!(
                owner.priority(),
                frozen_priority(owner),
                "{owner:?} priority"
            );
            assert_eq!(
                owner.preemptible(),
                frozen_preemptible(owner),
                "{owner:?} preemptibility"
            );
        }
    }

    #[test]
    fn every_ordered_owner_pair_follows_the_frozen_preemption_contract() {
        let mut pair_count = 0;
        for incumbent_owner in ALL_OWNERS {
            for challenger_owner in ALL_OWNERS {
                if incumbent_owner == challenger_owner {
                    continue;
                }
                pair_count += 1;
                let mut arbiter = PresentationArbiter::default();
                let incumbent = arbiter
                    .acquire(
                        incumbent_owner,
                        1_000,
                        None,
                        learning_session_id(incumbent_owner),
                    )
                    .granted_lease()
                    .expect("an empty arbiter must grant the first lease")
                    .clone();

                let result = arbiter.acquire(
                    challenger_owner,
                    1_001,
                    None,
                    learning_session_id(challenger_owner),
                );
                let should_preempt = frozen_preemptible(incumbent_owner)
                    && frozen_priority(incumbent_owner) < frozen_priority(challenger_owner);

                if should_preempt {
                    let AcquireResult::Preempted { displaced, granted } = result else {
                        panic!(
                            "{challenger_owner:?} must preempt lower-priority {incumbent_owner:?}"
                        );
                    };
                    assert_eq!(displaced, incumbent);
                    assert_eq!(granted.owner, challenger_owner);
                    assert_eq!(granted.priority, challenger_owner.priority());
                    assert_eq!(granted.preemptible, challenger_owner.preemptible());
                    assert_eq!(granted.revision, incumbent.revision + 1);
                    assert_ne!(granted.lease_id, incumbent.lease_id);
                    assert_eq!(
                        arbiter.active_lease().map(|lease| lease.lease_id.as_str()),
                        Some(granted.lease_id.as_str())
                    );
                    assert!(!arbiter.release(&incumbent.lease_id, incumbent.revision, 1_002));
                    assert_eq!(
                        arbiter.active_lease().map(|lease| lease.owner),
                        Some(challenger_owner)
                    );
                } else {
                    let AcquireResult::Denied(blocker) = result else {
                        panic!(
                            "{challenger_owner:?} must not displace {incumbent_owner:?} at equal or higher priority"
                        );
                    };
                    assert_eq!(blocker, incumbent);
                    assert_eq!(
                        arbiter.active_lease().map(|lease| lease.lease_id.as_str()),
                        Some(incumbent.lease_id.as_str())
                    );
                }

                assert!(arbiter.snapshot().lease_id.is_some());
            }
        }
        assert_eq!(pair_count, 156);
    }

    #[test]
    fn same_owner_retry_is_idempotent_but_learning_cannot_rebind_its_lease() {
        for owner in ALL_OWNERS {
            let mut arbiter = PresentationArbiter::default();
            let first = arbiter
                .acquire(owner, 1_000, None, learning_session_id(owner))
                .granted_lease()
                .expect("an empty arbiter must grant the first lease")
                .clone();
            let revision = arbiter.revision();
            let retry = arbiter.acquire(owner, 1_001, None, learning_session_id(owner));
            assert_eq!(retry, AcquireResult::Granted(first.clone()));
            assert_eq!(arbiter.revision(), revision);
            assert_eq!(
                arbiter.active_lease().map(|lease| lease.lease_id.as_str()),
                Some(first.lease_id.as_str())
            );
        }

        let mut arbiter = PresentationArbiter::default();
        let first = arbiter
            .acquire(
                PresentationOwner::LearningSession,
                1_000,
                None,
                Some("session-a"),
            )
            .granted_lease()
            .unwrap()
            .clone();
        let revision = arbiter.revision();
        let rebound = arbiter.acquire(
            PresentationOwner::LearningSession,
            1_001,
            None,
            Some("session-b"),
        );
        assert_eq!(rebound, AcquireResult::Denied(first.clone()));
        assert_eq!(arbiter.revision(), revision);
        assert_eq!(
            arbiter.active_lease().map(|lease| lease.lease_id.as_str()),
            Some(first.lease_id.as_str())
        );
    }

    #[test]
    fn only_one_lease_is_active_and_strong_reminder_preempts_learning() {
        let mut arbiter = PresentationArbiter::default();
        let learning = arbiter.acquire(
            PresentationOwner::LearningSession,
            1_000,
            None,
            Some("session-1"),
        );
        assert!(learning.granted_lease().is_some());
        let reminder = arbiter.acquire(PresentationOwner::StrongReminder, 1_001, None, None);
        assert_eq!(
            reminder.displaced_owner(),
            Some(PresentationOwner::LearningSession)
        );
        let snapshot = arbiter.snapshot();
        assert_eq!(snapshot.activity, PetActivity::Reminding);
        assert_eq!(snapshot.restore_target, Some(PetRestoreTarget::Learning));
        assert_eq!(
            snapshot.resumable_learning_session_id.as_deref(),
            Some("session-1")
        );
        assert_eq!(
            arbiter.active_lease().map(|lease| lease.owner),
            Some(PresentationOwner::StrongReminder)
        );
    }

    #[test]
    fn highest_reminder_beats_focus_and_manual_learning_beats_invitation() {
        let mut arbiter = PresentationArbiter::default();
        arbiter.acquire(PresentationOwner::StrongReminder, 1_000, None, None);
        let denied = arbiter.acquire(PresentationOwner::Focus, 1_001, None, None);
        assert!(matches!(denied, AcquireResult::Denied(_)));
        assert_eq!(
            arbiter.active_lease().map(|lease| lease.owner),
            Some(PresentationOwner::StrongReminder)
        );

        let mut arbiter = PresentationArbiter::default();
        arbiter.acquire(
            PresentationOwner::LearningInvitation,
            1_000,
            Some(2_000),
            None,
        );
        let manual = arbiter.acquire(
            PresentationOwner::LearningSession,
            1_001,
            None,
            Some("manual"),
        );
        assert_eq!(
            manual.displaced_owner(),
            Some(PresentationOwner::LearningInvitation)
        );
    }

    #[test]
    fn short_interaction_preempts_work_but_not_user_attention() {
        for work_owner in [PresentationOwner::TaskWatch, PresentationOwner::Focus] {
            let mut arbiter = PresentationArbiter::default();
            arbiter.acquire(work_owner, 1_000, None, None);
            let interaction = arbiter.acquire(
                PresentationOwner::UserInteraction,
                1_001,
                Some(15_001),
                None,
            );
            assert_eq!(interaction.displaced_owner(), Some(work_owner));
            assert_eq!(
                arbiter.active_lease().map(|lease| lease.owner),
                Some(PresentationOwner::UserInteraction)
            );
        }

        for attention_owner in [
            PresentationOwner::TaskWatchAttention,
            PresentationOwner::NormalReminder,
            PresentationOwner::MealReminder,
            PresentationOwner::WaterReminder,
        ] {
            let mut arbiter = PresentationArbiter::default();
            arbiter.acquire(attention_owner, 1_000, None, None);
            assert!(matches!(
                arbiter.acquire(
                    PresentationOwner::UserInteraction,
                    1_001,
                    Some(15_001),
                    None,
                ),
                AcquireResult::Denied(_)
            ));
            assert_eq!(
                arbiter.active_lease().map(|lease| lease.owner),
                Some(attention_owner)
            );
        }
    }

    #[test]
    fn finishing_interaction_requires_matching_owner_id_and_revision() {
        let mut arbiter = PresentationArbiter::default();
        let focus = arbiter
            .acquire(PresentationOwner::Focus, 1_000, None, None)
            .granted_lease()
            .unwrap()
            .clone();
        assert!(!arbiter.release_matching_owner(
            PresentationOwner::UserInteraction,
            &focus.lease_id,
            focus.revision,
            1_001
        ));
        let first = arbiter
            .acquire(
                PresentationOwner::UserInteraction,
                1_002,
                Some(31_002),
                None,
            )
            .granted_lease()
            .unwrap()
            .clone();
        assert!(!arbiter.release_matching_owner(
            PresentationOwner::UserInteraction,
            &first.lease_id,
            first.revision + 1,
            1_003
        ));
        assert!(arbiter.release_matching_owner(
            PresentationOwner::UserInteraction,
            &first.lease_id,
            first.revision,
            1_004
        ));
        let second = arbiter
            .acquire(
                PresentationOwner::UserInteraction,
                1_005,
                Some(31_005),
                None,
            )
            .granted_lease()
            .unwrap()
            .clone();
        assert!(!arbiter.release_matching_owner(
            PresentationOwner::UserInteraction,
            &first.lease_id,
            first.revision,
            1_006
        ));
        assert_eq!(arbiter.active_lease(), Some(&second));
        let reminder = arbiter
            .acquire(PresentationOwner::WaterReminder, 1_007, None, None)
            .granted_lease()
            .unwrap()
            .clone();
        assert!(!arbiter.release_matching_owner(
            PresentationOwner::UserInteraction,
            &second.lease_id,
            second.revision,
            1_008
        ));
        assert!(!arbiter.release_matching_owner(
            PresentationOwner::UserInteraction,
            &reminder.lease_id,
            reminder.revision,
            1_009
        ));
        assert_eq!(arbiter.active_lease(), Some(&reminder));
    }

    #[test]
    fn stale_release_cannot_clear_a_newer_lease() {
        let mut arbiter = PresentationArbiter::default();
        let first = arbiter
            .acquire(
                PresentationOwner::LearningSession,
                1_000,
                None,
                Some("session-1"),
            )
            .granted_lease()
            .unwrap()
            .clone();
        let second = arbiter
            .acquire(PresentationOwner::StrongReminder, 1_001, None, None)
            .granted_lease()
            .unwrap()
            .clone();
        assert!(!arbiter.release(&first.lease_id, first.revision, 1_002));
        assert_eq!(
            arbiter.active_lease().map(|lease| lease.lease_id.as_str()),
            Some(second.lease_id.as_str())
        );
    }

    #[cfg(feature = "learning")]
    #[test]
    fn completed_learning_release_is_bound_to_its_session() {
        let mut arbiter = PresentationArbiter::default();
        arbiter.acquire(
            PresentationOwner::LearningSession,
            1_000,
            None,
            Some("session-new"),
        );

        assert!(!arbiter.finish_learning_session("session-old", 1_001));
        assert_eq!(
            arbiter.snapshot().resumable_learning_session_id.as_deref(),
            None
        );
        assert_eq!(
            arbiter.active_lease().map(|lease| lease.owner),
            Some(PresentationOwner::LearningSession)
        );
        assert!(arbiter.finish_learning_session("session-new", 1_002));
        assert!(arbiter.active_lease().is_none());
    }

    #[test]
    fn focus_can_be_restored_after_a_strong_reminder() {
        let mut arbiter = PresentationArbiter::default();
        arbiter.acquire(PresentationOwner::Focus, 1_000, None, None);
        let reminder = arbiter
            .acquire(PresentationOwner::StrongReminder, 1_001, None, None)
            .granted_lease()
            .unwrap()
            .clone();
        assert_eq!(
            arbiter.snapshot().restore_target,
            Some(PetRestoreTarget::Focusing)
        );
        assert!(arbiter.release(&reminder.lease_id, reminder.revision, 1_002));
        arbiter.acquire(PresentationOwner::Focus, 1_003, None, None);
        let snapshot = arbiter.snapshot();
        assert_eq!(snapshot.activity, PetActivity::Focusing);
        assert_eq!(snapshot.restore_target, None);
    }

    #[test]
    fn sleep_interrupts_learning_and_wake_keeps_the_session_resumable() {
        let mut arbiter = PresentationArbiter::default();
        arbiter.acquire(
            PresentationOwner::LearningSession,
            1_000,
            None,
            Some("session-1"),
        );

        assert!(arbiter.set_sleeping(true, PetActivitySource::Manual));
        let sleeping = arbiter.snapshot();
        assert_eq!(sleeping.activity, PetActivity::Sleeping);
        assert_eq!(sleeping.source, PetActivitySource::Manual);
        assert_eq!(sleeping.lease_id, None);
        assert_eq!(
            sleeping.resumable_learning_session_id.as_deref(),
            Some("session-1")
        );
        assert_eq!(sleeping.restore_target, Some(PetRestoreTarget::Learning));

        assert!(arbiter.set_sleeping(false, PetActivitySource::Manual));
        let awake = arbiter.snapshot();
        assert_eq!(awake.activity, PetActivity::Interrupted);
        assert_eq!(awake.source, PetActivitySource::Learning);
        assert_eq!(
            awake.resumable_learning_session_id.as_deref(),
            Some("session-1")
        );
        assert_eq!(awake.restore_target, Some(PetRestoreTarget::Learning));
    }

    #[test]
    fn sleep_waits_for_a_reminder_then_becomes_visible() {
        let mut arbiter = PresentationArbiter::default();
        let reminder = arbiter
            .acquire(PresentationOwner::StrongReminder, 1_000, None, None)
            .granted_lease()
            .unwrap()
            .clone();

        assert!(arbiter.set_sleeping(true, PetActivitySource::Manual));
        let reminding = arbiter.snapshot();
        assert_eq!(reminding.activity, PetActivity::Reminding);
        assert_eq!(reminding.restore_target, Some(PetRestoreTarget::Sleeping));

        assert!(arbiter.release(&reminder.lease_id, reminder.revision, 1_001));
        let sleeping = arbiter.snapshot();
        assert_eq!(sleeping.activity, PetActivity::Sleeping);
        assert_eq!(sleeping.source, PetActivitySource::Manual);

        assert!(arbiter.set_sleeping(false, PetActivitySource::Manual));
        assert_eq!(arbiter.snapshot().activity, PetActivity::Idle);
    }

    #[test]
    fn sleep_after_learning_preemption_preserves_the_resumable_target() {
        let mut arbiter = PresentationArbiter::default();
        arbiter.acquire(
            PresentationOwner::LearningSession,
            1_000,
            None,
            Some("session-1"),
        );
        let reminder = arbiter
            .acquire(PresentationOwner::StrongReminder, 1_001, None, None)
            .granted_lease()
            .unwrap()
            .clone();

        assert!(arbiter.set_sleeping(true, PetActivitySource::Schedule));
        assert_eq!(arbiter.snapshot().activity, PetActivity::Reminding);
        assert!(arbiter.release(&reminder.lease_id, reminder.revision, 1_002));

        let sleeping = arbiter.snapshot();
        assert_eq!(sleeping.activity, PetActivity::Sleeping);
        assert_eq!(sleeping.source, PetActivitySource::Schedule);
        assert_eq!(
            sleeping.resumable_learning_session_id.as_deref(),
            Some("session-1")
        );
        assert_eq!(sleeping.restore_target, Some(PetRestoreTarget::Learning));

        assert!(arbiter.set_sleeping(false, PetActivitySource::Schedule));
        assert_eq!(arbiter.snapshot().activity, PetActivity::Interrupted);
    }

    #[test]
    fn concurrent_requests_still_leave_exactly_one_active_lease() {
        let arbiter = Arc::new(Mutex::new(PresentationArbiter::default()));
        let mut workers = Vec::new();
        for index in 0..64 {
            let arbiter = Arc::clone(&arbiter);
            workers.push(std::thread::spawn(move || {
                let owner = ALL_OWNERS[index as usize % ALL_OWNERS.len()];
                arbiter.lock().unwrap().acquire(
                    owner,
                    1_000 + index,
                    None,
                    learning_session_id(owner),
                );
            }));
        }
        for worker in workers {
            worker.join().unwrap();
        }
        let arbiter = arbiter.lock().unwrap();
        assert_eq!(
            arbiter.active_lease().map(|lease| lease.owner),
            Some(PresentationOwner::WaterReminder)
        );
        assert!(arbiter.snapshot().lease_id.is_some());
    }

    #[test]
    fn expired_invitation_releases_its_process_only_lease() {
        let mut arbiter = PresentationArbiter::default();
        arbiter.acquire(
            PresentationOwner::LearningInvitation,
            1_000,
            Some(1_500),
            None,
        );
        assert!(!arbiter.expire(1_499));
        assert!(arbiter.expire(1_500));
        assert!(arbiter.active_lease().is_none());
        assert_eq!(arbiter.snapshot().activity, PetActivity::Idle);
    }
}
