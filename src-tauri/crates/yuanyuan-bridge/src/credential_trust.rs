use std::collections::HashSet;

use thiserror::Error;

use crate::{ConnectorTrustStore, TrustChangeReason, TrustStatus, TrustStoreError};

#[derive(Debug, Clone, Copy, Error, PartialEq, Eq)]
pub enum SecretStoreError {
    #[error("credential key id is invalid")]
    InvalidKeyId,
    #[error("credential target already exists")]
    AlreadyExists,
    #[error("credential storage is unavailable")]
    Unavailable,
}

/// Minimal write-side capability used by the stable core. It deliberately
/// cannot read or export secret bytes.
pub trait CredentialSecretStore {
    fn create_generated(&self, key_id: &str) -> Result<(), SecretStoreError>;
    fn delete(&self, key_id: &str) -> Result<bool, SecretStoreError>;
}

#[derive(Debug, Error)]
pub enum CredentialTrustError {
    #[error("connector trust storage rejected the operation")]
    Trust(#[from] TrustStoreError),
    #[error("credential storage rejected the operation")]
    Secret(#[from] SecretStoreError),
    #[error("secure key id generation is unavailable")]
    KeyIdGenerationUnavailable,
    #[error("trust mutation rolled back but its new credential could not be cleaned up")]
    RolledBackCredentialCleanup {
        #[source]
        trust: TrustStoreError,
        cleanup: SecretStoreError,
    },
    #[error("trust was revoked first, but one or more obsolete credentials could not be removed")]
    ObsoleteCredentialCleanupIncomplete { failed_count: usize },
}

pub struct CredentialTrustManager<S> {
    trust: ConnectorTrustStore,
    secrets: S,
}

impl<S: CredentialSecretStore> CredentialTrustManager<S> {
    pub fn new(trust: ConnectorTrustStore, secrets: S) -> Self {
        Self { trust, secrets }
    }

    pub fn status(
        &self,
        connector_id: &str,
        source_instance: &str,
    ) -> Result<Option<TrustStatus>, CredentialTrustError> {
        Ok(self.trust.status(connector_id, source_instance)?)
    }

    pub fn register(
        &mut self,
        connector_id: &str,
        source_instance: &str,
        now_unix_ms: i64,
    ) -> Result<String, CredentialTrustError> {
        let key_id = generate_key_id(1)?;
        self.secrets.create_generated(&key_id)?;
        if let Err(trust) = self
            .trust
            .register(connector_id, source_instance, &key_id, now_unix_ms)
        {
            return Err(self.cleanup_after_rollback(&key_id, trust));
        }
        Ok(key_id)
    }

    pub fn begin_rotation(
        &mut self,
        connector_id: &str,
        source_instance: &str,
        now_unix_ms: i64,
    ) -> Result<String, CredentialTrustError> {
        self.begin_rotation_with_reason(
            connector_id,
            source_instance,
            TrustChangeReason::UserRequested,
            now_unix_ms,
        )
    }

    pub fn begin_rotation_with_reason(
        &mut self,
        connector_id: &str,
        source_instance: &str,
        reason: TrustChangeReason,
        now_unix_ms: i64,
    ) -> Result<String, CredentialTrustError> {
        let generation = self
            .trust
            .status(connector_id, source_instance)?
            .map_or(1, |status| status.generation.saturating_add(1));
        let key_id = generate_key_id(generation)?;
        self.secrets.create_generated(&key_id)?;
        if let Err(trust) = self.trust.begin_rotation_with_reason(
            connector_id,
            source_instance,
            &key_id,
            reason,
            now_unix_ms,
        ) {
            return Err(self.cleanup_after_rollback(&key_id, trust));
        }
        Ok(key_id)
    }

    pub fn reconnect(
        &mut self,
        connector_id: &str,
        source_instance: &str,
        now_unix_ms: i64,
    ) -> Result<String, CredentialTrustError> {
        self.reconnect_with_reason(
            connector_id,
            source_instance,
            TrustChangeReason::UserRequested,
            now_unix_ms,
        )
    }

    pub fn reconnect_with_reason(
        &mut self,
        connector_id: &str,
        source_instance: &str,
        reason: TrustChangeReason,
        now_unix_ms: i64,
    ) -> Result<String, CredentialTrustError> {
        let generation = self
            .trust
            .status(connector_id, source_instance)?
            .map_or(1, |status| status.generation.saturating_add(1));
        let key_id = generate_key_id(generation)?;
        self.secrets.create_generated(&key_id)?;
        if let Err(trust) = self.trust.reconnect_with_reason(
            connector_id,
            source_instance,
            &key_id,
            reason,
            now_unix_ms,
        ) {
            return Err(self.cleanup_after_rollback(&key_id, trust));
        }
        Ok(key_id)
    }

    /// Revokes authority in SQLite before attempting best-effort secret
    /// deletion. A deletion failure can leave an orphaned secret, never a live
    /// authentication authority.
    pub fn reset_trust(
        &mut self,
        connector_id: &str,
        source_instance: &str,
        now_unix_ms: i64,
    ) -> Result<(), CredentialTrustError> {
        self.reset_trust_with_reason(
            connector_id,
            source_instance,
            TrustChangeReason::UserRequested,
            now_unix_ms,
        )
    }

    pub fn reset_trust_with_reason(
        &mut self,
        connector_id: &str,
        source_instance: &str,
        reason: TrustChangeReason,
        now_unix_ms: i64,
    ) -> Result<(), CredentialTrustError> {
        self.trust
            .reset_trust_with_reason(connector_id, source_instance, reason, now_unix_ms)?;
        self.retry_revoked_credential_cleanup(connector_id, source_instance, now_unix_ms, 256)
            .map(|_| ())
    }

    /// Retries only credential targets that the trust database proves belong
    /// to this exact identity and are already revoked. Successful (including
    /// already-absent) deletions are durably marked so a bounded retry can
    /// advance without rescanning or guessing Credential Manager contents.
    pub fn retry_revoked_credential_cleanup(
        &mut self,
        connector_id: &str,
        source_instance: &str,
        now_unix_ms: i64,
        limit: u16,
    ) -> Result<usize, CredentialTrustError> {
        if now_unix_ms < 0 {
            return Err(TrustStoreError::InvalidInput.into());
        }
        let (key_ids, has_more) =
            self.trust
                .pending_revoked_credential_keys(connector_id, source_instance, limit)?;
        let attempted = key_ids.len();
        let mut failed_count = 0;
        for key_id in key_ids {
            match self.secrets.delete(&key_id) {
                Ok(_) => {
                    if self
                        .trust
                        .mark_revoked_credential_deleted(&key_id, now_unix_ms)
                        .is_err()
                    {
                        failed_count += 1;
                    }
                }
                Err(_) => failed_count += 1,
            }
        }
        if has_more {
            failed_count += 1;
        }
        if failed_count == 0 {
            Ok(attempted)
        } else {
            Err(CredentialTrustError::ObsoleteCredentialCleanupIncomplete { failed_count })
        }
    }

    /// Removes expired old-key authority first, then removes the corresponding
    /// exact credential targets.
    pub fn finalize_expired_rotations(
        &mut self,
        now_unix_ms: i64,
        limit: u16,
    ) -> Result<usize, CredentialTrustError> {
        let obsolete = self.trust.finalize_expired_rotations(now_unix_ms, limit)?;
        let count = obsolete.len();
        self.delete_obsolete(obsolete)?;
        Ok(count)
    }

    fn cleanup_after_rollback(&self, key_id: &str, trust: TrustStoreError) -> CredentialTrustError {
        match self.secrets.delete(key_id) {
            Ok(_) => CredentialTrustError::Trust(trust),
            Err(cleanup) => CredentialTrustError::RolledBackCredentialCleanup { trust, cleanup },
        }
    }

    fn delete_obsolete(&self, key_ids: Vec<String>) -> Result<(), CredentialTrustError> {
        let mut unique = HashSet::with_capacity(key_ids.len());
        let mut failed_count = 0;
        for key_id in key_ids {
            if unique.insert(key_id.clone()) && self.secrets.delete(&key_id).is_err() {
                failed_count += 1;
            }
        }
        if failed_count == 0 {
            Ok(())
        } else {
            Err(CredentialTrustError::ObsoleteCredentialCleanupIncomplete { failed_count })
        }
    }
}

fn generate_key_id(generation: u64) -> Result<String, CredentialTrustError> {
    let mut random = [0_u8; 16];
    getrandom::fill(&mut random).map_err(|_| CredentialTrustError::KeyIdGenerationUnavailable)?;
    let mut suffix = String::with_capacity(random.len() * 2);
    for byte in random {
        use std::fmt::Write as _;
        write!(&mut suffix, "{byte:02x}").expect("writing to String cannot fail");
    }
    Ok(format!("yy.g{generation}.{suffix}"))
}

#[cfg(test)]
mod tests {
    use std::sync::Mutex;

    use super::*;
    use crate::{TrustDecision, KEY_ROTATION_GRACE};

    const CONNECTOR: &str = "connector.codex";
    const INSTANCE: &str = "instance-1";
    const NOW: i64 = 1_775_212_800_000;

    #[derive(Default)]
    struct FakeSecrets {
        live: Mutex<HashSet<String>>,
        fail_delete: Mutex<bool>,
    }

    impl CredentialSecretStore for FakeSecrets {
        fn create_generated(&self, key_id: &str) -> Result<(), SecretStoreError> {
            if self.live.lock().unwrap().insert(key_id.to_owned()) {
                Ok(())
            } else {
                Err(SecretStoreError::AlreadyExists)
            }
        }

        fn delete(&self, key_id: &str) -> Result<bool, SecretStoreError> {
            if *self.fail_delete.lock().unwrap() {
                return Err(SecretStoreError::Unavailable);
            }
            Ok(self.live.lock().unwrap().remove(key_id))
        }
    }

    #[test]
    fn lifecycle_creates_unique_keys_and_revokes_metadata_before_cleanup() {
        let trust = ConnectorTrustStore::open_in_memory().unwrap();
        let secrets = FakeSecrets::default();
        let mut manager = CredentialTrustManager::new(trust, secrets);

        let old_key = manager.register(CONNECTOR, INSTANCE, NOW).unwrap();
        let new_key = manager
            .begin_rotation(CONNECTOR, INSTANCE, NOW + 1_000)
            .unwrap();
        assert_ne!(old_key, new_key);
        assert!(old_key.starts_with("yy.g1."));
        assert!(new_key.starts_with("yy.g2."));
        manager
            .reset_trust(CONNECTOR, INSTANCE, NOW + 2_000)
            .unwrap();

        assert!(manager.secrets.live.lock().unwrap().is_empty());
        assert_eq!(
            manager
                .trust
                .authorize(&new_key, NOW + 1_000, NOW + 2_000)
                .unwrap(),
            TrustDecision::Rejected
        );
        assert_eq!(
            manager.trust.authorize(&old_key, NOW, NOW + 2_000).unwrap(),
            TrustDecision::Rejected
        );
    }

    #[test]
    fn failed_trust_mutation_deletes_the_uncommitted_new_credential() {
        let mut trust = ConnectorTrustStore::open_in_memory().unwrap();
        trust
            .register(CONNECTOR, INSTANCE, "existing.g1", NOW)
            .unwrap();
        let secrets = FakeSecrets::default();
        let mut manager = CredentialTrustManager::new(trust, secrets);

        assert!(matches!(
            manager.register(CONNECTOR, INSTANCE, NOW + 1),
            Err(CredentialTrustError::Trust(
                TrustStoreError::InvalidTransition
            ))
        ));
        assert!(manager.secrets.live.lock().unwrap().is_empty());
    }

    #[test]
    fn deletion_failure_never_restores_expired_or_reset_authority() {
        let trust = ConnectorTrustStore::open_in_memory().unwrap();
        let secrets = FakeSecrets::default();
        let mut manager = CredentialTrustManager::new(trust, secrets);
        let old_key = manager.register(CONNECTOR, INSTANCE, NOW).unwrap();
        manager
            .begin_rotation(CONNECTOR, INSTANCE, NOW + 1)
            .unwrap();
        *manager.secrets.fail_delete.lock().unwrap() = true;
        let after_grace = NOW + 1 + KEY_ROTATION_GRACE.as_millis() as i64 + 1;

        assert!(matches!(
            manager.finalize_expired_rotations(after_grace, 1),
            Err(CredentialTrustError::ObsoleteCredentialCleanupIncomplete { failed_count: 1 })
        ));
        assert_eq!(
            manager.trust.authorize(&old_key, NOW, after_grace).unwrap(),
            TrustDecision::Rejected
        );
    }

    #[test]
    fn revoked_credential_cleanup_is_bounded_retryable_and_idempotent() {
        let trust = ConnectorTrustStore::open_in_memory().unwrap();
        let secrets = FakeSecrets::default();
        let mut manager = CredentialTrustManager::new(trust, secrets);
        let key_id = manager.register(CONNECTOR, INSTANCE, NOW).unwrap();
        *manager.secrets.fail_delete.lock().unwrap() = true;

        assert!(matches!(
            manager.reset_trust(CONNECTOR, INSTANCE, NOW + 1),
            Err(CredentialTrustError::ObsoleteCredentialCleanupIncomplete { failed_count: 1 })
        ));
        assert!(!manager.status(CONNECTOR, INSTANCE).unwrap().unwrap().active);
        assert!(manager.secrets.live.lock().unwrap().contains(&key_id));

        *manager.secrets.fail_delete.lock().unwrap() = false;
        assert_eq!(
            manager
                .retry_revoked_credential_cleanup(CONNECTOR, INSTANCE, NOW + 2, 1)
                .unwrap(),
            1
        );
        assert!(manager.secrets.live.lock().unwrap().is_empty());
        assert_eq!(
            manager
                .retry_revoked_credential_cleanup(CONNECTOR, INSTANCE, NOW + 3, 1)
                .unwrap(),
            0
        );
    }
}
