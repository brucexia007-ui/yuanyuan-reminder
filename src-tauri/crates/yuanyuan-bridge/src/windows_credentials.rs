use std::{ffi::OsStr, os::windows::ffi::OsStrExt, ptr, sync::Mutex};

use thiserror::Error;
use windows_sys::Win32::{
    Foundation::{GetLastError, ERROR_NOT_FOUND},
    Security::Credentials::{
        CredDeleteW, CredFree, CredReadW, CredWriteW, CREDENTIALW, CRED_PERSIST_LOCAL_MACHINE,
        CRED_PERSIST_SESSION, CRED_TYPE_GENERIC,
    },
};
use zeroize::Zeroize;

use crate::{
    AuthenticationKey, AuthenticationKeyResolver, CredentialSecretStore, KeyResolutionError,
    SecretStoreError,
};

pub const CREDENTIAL_TARGET_PREFIX: &str = "Yuanyuan/TaskEventKey/";
const MAX_CREDENTIAL_BLOB_BYTES: usize = 512;
const GENERATED_SECRET_BYTES: usize = 32;
static CREDENTIAL_WRITE_LOCK: Mutex<()> = Mutex::new(());

#[derive(Debug, Default, Clone, Copy)]
pub struct WindowsCredentialKeyResolver;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CredentialPersistence {
    CurrentLogonSession,
    LocalMachine,
}

#[derive(Debug, Clone, Copy)]
pub struct WindowsCredentialSecretStore {
    persistence: CredentialPersistence,
}

impl Default for WindowsCredentialSecretStore {
    fn default() -> Self {
        Self {
            persistence: CredentialPersistence::LocalMachine,
        }
    }
}

#[derive(Debug, Clone, Copy, Error, PartialEq, Eq)]
pub enum WindowsCredentialError {
    #[error("credential key id is invalid")]
    InvalidKeyId,
    #[error("credential target already exists")]
    AlreadyExists,
    #[error("credential manager is unavailable")]
    Unavailable,
}

impl AuthenticationKeyResolver for WindowsCredentialKeyResolver {
    fn resolve(&self, key_id: &str) -> Result<AuthenticationKey, KeyResolutionError> {
        let target = credential_target(key_id).ok_or(KeyResolutionError::UnknownOrRevoked)?;
        let mut target_wide: Vec<u16> = OsStr::new(&target).encode_wide().collect();
        target_wide.push(0);
        let mut raw_credential = ptr::null_mut();
        // SAFETY: the target is NUL-terminated and the output pointer remains
        // valid until wrapped and released with CredFree.
        let found = unsafe {
            CredReadW(
                target_wide.as_ptr(),
                CRED_TYPE_GENERIC,
                0,
                &mut raw_credential,
            )
        };
        if found == 0 {
            return match unsafe { GetLastError() } {
                ERROR_NOT_FOUND => Err(KeyResolutionError::UnknownOrRevoked),
                _ => Err(KeyResolutionError::Unavailable),
            };
        }
        let credential = OwnedCredential(raw_credential);
        // SAFETY: CredReadW returned a valid CREDENTIALW allocation owned by
        // `credential` for the duration of this copy.
        let record = unsafe { &*credential.0 };
        let blob_length = record.CredentialBlobSize as usize;
        if record.CredentialBlob.is_null()
            || !(32..=MAX_CREDENTIAL_BLOB_BYTES).contains(&blob_length)
        {
            return Err(KeyResolutionError::Unavailable);
        }
        // SAFETY: CredentialBlobSize describes the readable allocation returned
        // by CredReadW. AuthenticationKey immediately owns and later zeroizes it.
        let secret = unsafe {
            std::slice::from_raw_parts(record.CredentialBlob.cast_const(), blob_length).to_vec()
        };
        AuthenticationKey::new(secret).map_err(|_| KeyResolutionError::Unavailable)
    }
}

impl WindowsCredentialSecretStore {
    pub const fn with_persistence(persistence: CredentialPersistence) -> Self {
        Self { persistence }
    }

    pub fn create_generated(&self, key_id: &str) -> Result<(), WindowsCredentialError> {
        let target = credential_target(key_id).ok_or(WindowsCredentialError::InvalidKeyId)?;
        let _guard = CREDENTIAL_WRITE_LOCK
            .lock()
            .map_err(|_| WindowsCredentialError::Unavailable)?;
        if credential_exists(&target)? {
            return Err(WindowsCredentialError::AlreadyExists);
        }

        let mut secret = [0_u8; GENERATED_SECRET_BYTES];
        getrandom::fill(&mut secret).map_err(|_| WindowsCredentialError::Unavailable)?;
        let result = write_secret(&target, &mut secret, self.persistence);
        secret.zeroize();
        result
    }

    pub fn delete(&self, key_id: &str) -> Result<bool, WindowsCredentialError> {
        let target = credential_target(key_id).ok_or(WindowsCredentialError::InvalidKeyId)?;
        let _guard = CREDENTIAL_WRITE_LOCK
            .lock()
            .map_err(|_| WindowsCredentialError::Unavailable)?;
        let mut target_wide = nul_terminated(&target);
        // SAFETY: the target is a valid NUL-terminated UTF-16 buffer for the
        // duration of the call. Only this exact generic credential is removed.
        if unsafe { CredDeleteW(target_wide.as_mut_ptr(), CRED_TYPE_GENERIC, 0) } != 0 {
            return Ok(true);
        }
        match unsafe { GetLastError() } {
            ERROR_NOT_FOUND => Ok(false),
            _ => Err(WindowsCredentialError::Unavailable),
        }
    }
}

impl CredentialSecretStore for WindowsCredentialSecretStore {
    fn create_generated(&self, key_id: &str) -> Result<(), SecretStoreError> {
        self.create_generated(key_id).map_err(map_secret_error)
    }

    fn delete(&self, key_id: &str) -> Result<bool, SecretStoreError> {
        self.delete(key_id).map_err(map_secret_error)
    }
}

fn map_secret_error(error: WindowsCredentialError) -> SecretStoreError {
    match error {
        WindowsCredentialError::InvalidKeyId => SecretStoreError::InvalidKeyId,
        WindowsCredentialError::AlreadyExists => SecretStoreError::AlreadyExists,
        WindowsCredentialError::Unavailable => SecretStoreError::Unavailable,
    }
}

fn credential_exists(target: &str) -> Result<bool, WindowsCredentialError> {
    let mut target_wide = nul_terminated(target);
    let mut raw_credential = ptr::null_mut();
    // SAFETY: the target is NUL-terminated and a successful output is released
    // immediately through OwnedCredential.
    if unsafe {
        CredReadW(
            target_wide.as_mut_ptr(),
            CRED_TYPE_GENERIC,
            0,
            &mut raw_credential,
        )
    } != 0
    {
        drop(OwnedCredential(raw_credential));
        return Ok(true);
    }
    match unsafe { GetLastError() } {
        ERROR_NOT_FOUND => Ok(false),
        _ => Err(WindowsCredentialError::Unavailable),
    }
}

fn write_secret(
    target: &str,
    secret: &mut [u8],
    persistence: CredentialPersistence,
) -> Result<(), WindowsCredentialError> {
    let mut target_wide = nul_terminated(target);
    // SAFETY: zero is the documented empty value for all pointer/count fields;
    // the required fields are populated below with buffers that outlive the call.
    let mut credential: CREDENTIALW = unsafe { std::mem::zeroed() };
    credential.Type = CRED_TYPE_GENERIC;
    credential.TargetName = target_wide.as_mut_ptr();
    credential.CredentialBlobSize = secret.len() as u32;
    credential.CredentialBlob = secret.as_mut_ptr();
    credential.Persist = match persistence {
        CredentialPersistence::CurrentLogonSession => CRED_PERSIST_SESSION,
        CredentialPersistence::LocalMachine => CRED_PERSIST_LOCAL_MACHINE,
    };
    // SAFETY: every pointer references a live mutable buffer for the duration
    // of CredWriteW; the API copies the supplied credential data.
    if unsafe { CredWriteW(&credential, 0) } == 0 {
        return Err(WindowsCredentialError::Unavailable);
    }
    Ok(())
}

struct OwnedCredential(*mut CREDENTIALW);

impl Drop for OwnedCredential {
    fn drop(&mut self) {
        // SAFETY: this pointer came from a successful CredReadW call and is
        // released exactly once by this owner.
        unsafe { CredFree(self.0.cast()) };
    }
}

fn credential_target(key_id: &str) -> Option<String> {
    let valid = !key_id.is_empty()
        && key_id.len() <= 64
        && key_id.bytes().all(|byte| {
            byte.is_ascii_lowercase() || byte.is_ascii_digit() || b"._-".contains(&byte)
        });
    valid.then(|| format!("{CREDENTIAL_TARGET_PREFIX}{key_id}"))
}

fn nul_terminated(value: &str) -> Vec<u16> {
    OsStr::new(value).encode_wide().chain(Some(0)).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn credential_targets_are_scoped_and_do_not_accept_paths() {
        assert_eq!(
            credential_target("codex.installation-1").as_deref(),
            Some("Yuanyuan/TaskEventKey/codex.installation-1")
        );
        assert_eq!(credential_target("../other"), None);
        assert_eq!(credential_target("Codex Installation"), None);
    }

    #[test]
    fn a_missing_credential_is_reported_as_unknown_without_writing_state() {
        let resolver = WindowsCredentialKeyResolver;
        let key_id = format!("test.missing.{}", std::process::id());
        assert!(matches!(
            resolver.resolve(&key_id),
            Err(KeyResolutionError::UnknownOrRevoked)
        ));
    }
}
