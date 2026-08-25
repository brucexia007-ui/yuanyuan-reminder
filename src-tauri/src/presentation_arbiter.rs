use serde::{Deserialize, Serialize};

// Reserved for the existing Windows lock/auth surface, which remains outside
// this foreground pet lease enum but must stay above every pet presentation.
#[allow(dead_code)]
pub const LOCKED_AUTH_PRIORITY: u8 = 120;
pub const STRONG_REMINDER_PRIORITY: u8 = 100;
pub const FOCUS_PRIORITY: u8 = 90;
pub const WATER_REMINDER_PRIORITY: u8 = 80;
pub const MOVEMENT_REMINDER_PRIORITY: u8 = 70;
pub const NORMAL_REMINDER_PRIORITY: u8 = 70;
pub const MANUAL_LEARNING_PRIORITY: u8 = 60;
pub const TASK_WATCH_PRIORITY: u8 = 50;
pub const LEARNING_INVITATION_PRIORITY: u8 = 30;
pub const AMBIENT_PET_PRIORITY: u8 = 10;

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum PresentationOwner {
    StrongReminder,
    WaterReminder,
    MovementReminder,
    NormalReminder,
    Focus,
    LearningSession,
    LearningInvitation,
    TaskWatch,
    AmbientPet,
}

impl PresentationOwner {
    pub const fn priority(self) -> u8 {
        match self {
            Self::StrongReminder => STRONG_REMINDER_PRIORITY,
            Self::Focus => FOCUS_PRIORITY,
            Self::WaterReminder => WATER_REMINDER_PRIORITY,
            Self::MovementReminder => MOVEMENT_REMINDER_PRIORITY,
            Self::NormalReminder => NORMAL_REMINDER_PRIORITY,
            Self::LearningSession => MANUAL_LEARNING_PRIORITY,
            Self::TaskWatch => TASK_WATCH_PRIORITY,
            Self::LearningInvitation => LEARNING_INVITATION_PRIORITY,
            Self::AmbientPet => AMBIENT_PET_PRIORITY,
        }
    }

    pub const fn preemptible(self) -> bool {
        !matches!(self, Self::StrongReminder)
    }

    pub const fn is_reminder(self) -> bool {
        matches!(
            self,
            Self::StrongReminder
                | Self::WaterReminder
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
    pub fn finish_learning(&mut self, now_unix_ms: i64) -> bool {
        let previous_revision = self.revision;
        let mut changed = self.release_owner(PresentationOwner::LearningSession, now_unix_ms);
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
        {
            return false;
        }
        self.finish_learning(now_unix_ms)
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
            Some(PresentationOwner::TaskWatch) => {
                (PetActivity::Reminding, PetActivitySource::Schedule)
            }
            Some(PresentationOwner::LearningInvitation) => {
                (PetActivity::Idle, PetActivitySource::Learning)
            }
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

    const ALL_OWNERS: [PresentationOwner; 9] = [
        PresentationOwner::StrongReminder,
        PresentationOwner::Focus,
        PresentationOwner::WaterReminder,
        PresentationOwner::MovementReminder,
        PresentationOwner::NormalReminder,
        PresentationOwner::LearningSession,
        PresentationOwner::TaskWatch,
        PresentationOwner::LearningInvitation,
        PresentationOwner::AmbientPet,
    ];

    fn learning_session_id(owner: PresentationOwner) -> Option<&'static str> {
        (owner == PresentationOwner::LearningSession).then_some("session-a")
    }

    const fn frozen_priority(owner: PresentationOwner) -> u8 {
        match owner {
            PresentationOwner::StrongReminder => 100,
            PresentationOwner::Focus => 90,
            PresentationOwner::WaterReminder => 80,
            PresentationOwner::MovementReminder | PresentationOwner::NormalReminder => 70,
            PresentationOwner::LearningSession => 60,
            PresentationOwner::TaskWatch => 50,
            PresentationOwner::LearningInvitation => 30,
            PresentationOwner::AmbientPet => 10,
        }
    }

    const fn frozen_preemptible(owner: PresentationOwner) -> bool {
        !matches!(owner, PresentationOwner::StrongReminder)
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
        assert_eq!(pair_count, 72);
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
    fn strong_reminder_is_nonpreemptible_and_manual_learning_beats_invitation() {
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
            Some(PresentationOwner::StrongReminder)
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
