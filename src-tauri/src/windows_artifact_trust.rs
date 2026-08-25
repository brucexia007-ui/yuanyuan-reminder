#![cfg(windows)]

use std::{
    ffi::c_void,
    fs::{File, OpenOptions},
    os::windows::{
        ffi::OsStrExt,
        fs::{FileExt, OpenOptionsExt},
        io::AsRawHandle,
    },
    path::Path,
    slice,
    sync::Mutex,
};

use sha2::{Digest, Sha256};
use windows_sys::Win32::{
    Foundation::{HANDLE, HWND},
    Security::{
        Cryptography::{CertGetNameStringW, CERT_NAME_SIMPLE_DISPLAY_TYPE},
        WinTrust::{
            WTHelperGetProvCertFromChain, WTHelperGetProvSignerFromChain,
            WTHelperProvDataFromStateData, WinVerifyTrust, WINTRUST_ACTION_GENERIC_VERIFY_V2,
            WINTRUST_DATA, WINTRUST_FILE_INFO, WTD_CACHE_ONLY_URL_RETRIEVAL, WTD_CHOICE_FILE,
            WTD_REVOCATION_CHECK_CHAIN, WTD_REVOKE_WHOLECHAIN, WTD_STATEACTION_CLOSE,
            WTD_STATEACTION_VERIFY, WTD_UI_NONE,
        },
    },
    Storage::FileSystem::{
        GetFileInformationByHandle, BY_HANDLE_FILE_INFORMATION, FILE_ATTRIBUTE_REPARSE_POINT,
        FILE_SHARE_DELETE, FILE_SHARE_READ, FILE_SHARE_WRITE,
    },
};

const MAX_CERTIFICATE_DISPLAY_NAME_UTF16: u32 = 32 * 1024;
const MAX_SIGNER_CERTIFICATE_BYTES: usize = 1024 * 1024;
const DOS_HEADER_BYTES: usize = 64;
static AUTHENTICODE_PROVIDER_STATE_LOCK: Mutex<()> = Mutex::new(());

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct ArtifactFileIdentity {
    volume_serial: u32,
    file_index: u64,
}

#[derive(Clone, PartialEq, Eq)]
pub(crate) struct AuthenticodeIdentity {
    pub(crate) publisher: String,
    pub(crate) certificate_sha256: [u8; 32],
}

#[derive(Clone, PartialEq, Eq)]
pub(crate) enum AuthenticodeEvidence {
    Verified(AuthenticodeIdentity),
    Invalid,
    Unavailable,
}

pub(crate) fn open_ordinary_artifact(path: &Path) -> Result<(File, ArtifactFileIdentity), ()> {
    open_artifact(path, FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE)
}

/// Opens a release artifact without granting later writers or replacers a
/// share. Retaining the returned File closes the path replacement window from
/// verification through every supervised process restart.
pub(crate) fn open_locked_release_artifact(
    path: &Path,
) -> Result<(File, ArtifactFileIdentity), ()> {
    open_artifact(path, FILE_SHARE_READ)
}

fn open_artifact(path: &Path, share_mode: u32) -> Result<(File, ArtifactFileIdentity), ()> {
    use std::os::windows::fs::MetadataExt;

    let metadata = std::fs::symlink_metadata(path).map_err(|_| ())?;
    if !metadata.is_file()
        || metadata.len() == 0
        || metadata.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT != 0
    {
        return Err(());
    }
    let file = OpenOptions::new()
        .read(true)
        .share_mode(share_mode)
        .open(path)
        .map_err(|_| ())?;
    let identity = artifact_file_identity(&file)?;
    Ok((file, identity))
}

pub(crate) fn file_identity_at(path: &Path) -> Result<ArtifactFileIdentity, ()> {
    open_ordinary_artifact(path).map(|(_, identity)| identity)
}

pub(crate) fn artifact_file_identity(file: &File) -> Result<ArtifactFileIdentity, ()> {
    let mut information = BY_HANDLE_FILE_INFORMATION {
        dwFileAttributes: 0,
        ftCreationTime: Default::default(),
        ftLastAccessTime: Default::default(),
        ftLastWriteTime: Default::default(),
        dwVolumeSerialNumber: 0,
        nFileSizeHigh: 0,
        nFileSizeLow: 0,
        nNumberOfLinks: 0,
        nFileIndexHigh: 0,
        nFileIndexLow: 0,
    };
    // SAFETY: the handle belongs to the live File and the output pointer is
    // valid for the duration of this call.
    let ok = unsafe {
        GetFileInformationByHandle(
            file.as_raw_handle() as HANDLE,
            std::ptr::addr_of_mut!(information),
        )
    };
    if ok == 0 || information.dwFileAttributes & FILE_ATTRIBUTE_REPARSE_POINT != 0 {
        return Err(());
    }
    Ok(ArtifactFileIdentity {
        volume_serial: information.dwVolumeSerialNumber,
        file_index: (u64::from(information.nFileIndexHigh) << 32)
            | u64::from(information.nFileIndexLow),
    })
}

pub(crate) fn verify_authenticode(file: &File, path: &Path) -> AuthenticodeEvidence {
    match has_portable_executable_headers(file) {
        Ok(true) => {}
        Ok(false) => return AuthenticodeEvidence::Invalid,
        Err(()) => return AuthenticodeEvidence::Unavailable,
    }
    // WinVerifyTrust provider state is process-global enough that overlapping
    // VERIFY/helper/CLOSE lifecycles have produced native access violations in
    // the Windows test process. Keep the complete lifecycle under one lock.
    with_authenticode_provider_state_lock(|| verify_authenticode_inner(file, path))
        .unwrap_or(AuthenticodeEvidence::Unavailable)
}

fn has_portable_executable_headers(file: &File) -> Result<bool, ()> {
    let file_length = file.metadata().map_err(|_| ())?.len();
    if file_length < (DOS_HEADER_BYTES + 4) as u64 {
        return Ok(false);
    }
    let mut dos_header = [0u8; DOS_HEADER_BYTES];
    if file.seek_read(&mut dos_header, 0).map_err(|_| ())? != dos_header.len()
        || &dos_header[..2] != b"MZ"
    {
        return Ok(false);
    }
    let pe_offset = u64::from(u32::from_le_bytes(
        dos_header[0x3c..0x40].try_into().map_err(|_| ())?,
    ));
    if pe_offset < DOS_HEADER_BYTES as u64 || pe_offset > file_length.saturating_sub(4) {
        return Ok(false);
    }
    let mut signature = [0u8; 4];
    if file.seek_read(&mut signature, pe_offset).map_err(|_| ())? != signature.len() {
        return Ok(false);
    }
    Ok(signature == *b"PE\0\0")
}

fn with_authenticode_provider_state_lock<T>(work: impl FnOnce() -> T) -> Option<T> {
    let _guard = AUTHENTICODE_PROVIDER_STATE_LOCK.lock().ok()?;
    Some(work())
}

fn verify_authenticode_inner(file: &File, path: &Path) -> AuthenticodeEvidence {
    let wide_path = path
        .as_os_str()
        .encode_wide()
        .chain(std::iter::once(0))
        .collect::<Vec<_>>();
    let mut file_info = WINTRUST_FILE_INFO {
        cbStruct: std::mem::size_of::<WINTRUST_FILE_INFO>() as u32,
        pcwszFilePath: wide_path.as_ptr(),
        hFile: file.as_raw_handle() as HANDLE,
        pgKnownSubject: std::ptr::null_mut(),
    };
    let mut trust_data = WINTRUST_DATA {
        cbStruct: std::mem::size_of::<WINTRUST_DATA>() as u32,
        pPolicyCallbackData: std::ptr::null_mut(),
        pSIPClientData: std::ptr::null_mut(),
        dwUIChoice: WTD_UI_NONE,
        fdwRevocationChecks: WTD_REVOKE_WHOLECHAIN,
        dwUnionChoice: WTD_CHOICE_FILE,
        Anonymous: windows_sys::Win32::Security::WinTrust::WINTRUST_DATA_0 {
            pFile: std::ptr::addr_of_mut!(file_info),
        },
        dwStateAction: WTD_STATEACTION_VERIFY,
        hWVTStateData: std::ptr::null_mut(),
        pwszURLReference: std::ptr::null_mut(),
        dwProvFlags: WTD_CACHE_ONLY_URL_RETRIEVAL | WTD_REVOCATION_CHECK_CHAIN,
        dwUIContext: 0,
        pSignatureSettings: std::ptr::null_mut(),
    };
    let mut action = WINTRUST_ACTION_GENERIC_VERIFY_V2;
    // SAFETY: all pointers refer to live stack values or the live File; UI is
    // disabled and URL retrieval is restricted to the local cache.
    let result = unsafe {
        WinVerifyTrust(
            std::ptr::null_mut::<c_void>() as HWND,
            std::ptr::addr_of_mut!(action),
            std::ptr::addr_of_mut!(trust_data).cast(),
        )
    };
    let evidence = if result == 0 {
        signer_identity(trust_data.hWVTStateData)
            .map(AuthenticodeEvidence::Verified)
            .unwrap_or(AuthenticodeEvidence::Unavailable)
    } else {
        AuthenticodeEvidence::Invalid
    };
    if !trust_data.hWVTStateData.is_null() {
        trust_data.dwStateAction = WTD_STATEACTION_CLOSE;
        // SAFETY: closes only the non-null state created by the preceding
        // verification. A failed call that produced no state needs no close.
        unsafe {
            WinVerifyTrust(
                std::ptr::null_mut::<c_void>() as HWND,
                std::ptr::addr_of_mut!(action),
                std::ptr::addr_of_mut!(trust_data).cast(),
            );
        }
    }
    evidence
}

#[cfg(test)]
mod tests {
    use super::{
        has_portable_executable_headers, verify_authenticode,
        with_authenticode_provider_state_lock, AuthenticodeEvidence, DOS_HEADER_BYTES,
    };
    use std::{
        fs::File,
        sync::{
            atomic::{AtomicUsize, Ordering},
            Arc, Barrier,
        },
        thread,
        time::Duration,
    };
    use tempfile::tempdir;

    #[test]
    fn portable_executable_preflight_rejects_non_pe_and_bounded_offsets() {
        let directory = tempdir().unwrap();
        for (name, bytes) in [
            ("plain.exe", b"not a portable executable".to_vec()),
            ("short-mz.exe", b"MZ".to_vec()),
            ("wrong-signature.exe", {
                let mut bytes = vec![0u8; DOS_HEADER_BYTES + 4];
                bytes[..2].copy_from_slice(b"MZ");
                bytes[0x3c..0x40].copy_from_slice(&(DOS_HEADER_BYTES as u32).to_le_bytes());
                bytes[DOS_HEADER_BYTES..].copy_from_slice(b"PX\0\0");
                bytes
            }),
            ("out-of-bounds.exe", {
                let mut bytes = vec![0u8; DOS_HEADER_BYTES + 4];
                bytes[..2].copy_from_slice(b"MZ");
                bytes[0x3c..0x40].copy_from_slice(&u32::MAX.to_le_bytes());
                bytes
            }),
        ] {
            let path = directory.path().join(name);
            std::fs::write(&path, bytes).unwrap();
            let file = File::open(&path).unwrap();
            assert!(!has_portable_executable_headers(&file).unwrap());
            assert!(matches!(
                verify_authenticode(&file, &path),
                AuthenticodeEvidence::Invalid
            ));
        }
    }

    #[test]
    fn portable_executable_preflight_accepts_bounded_dos_and_pe_signatures() {
        let directory = tempdir().unwrap();
        let path = directory.path().join("minimal.exe");
        let mut bytes = vec![0u8; DOS_HEADER_BYTES + 4];
        bytes[..2].copy_from_slice(b"MZ");
        bytes[0x3c..0x40].copy_from_slice(&(DOS_HEADER_BYTES as u32).to_le_bytes());
        bytes[DOS_HEADER_BYTES..].copy_from_slice(b"PE\0\0");
        std::fs::write(&path, bytes).unwrap();
        let file = File::open(path).unwrap();
        assert!(has_portable_executable_headers(&file).unwrap());
    }

    #[test]
    fn authenticode_provider_state_lifecycle_is_process_serialized() {
        const WORKERS: usize = 16;

        let barrier = Arc::new(Barrier::new(WORKERS));
        let active = Arc::new(AtomicUsize::new(0));
        let max_active = Arc::new(AtomicUsize::new(0));
        let handles = (0..WORKERS)
            .map(|_| {
                let barrier = Arc::clone(&barrier);
                let active = Arc::clone(&active);
                let max_active = Arc::clone(&max_active);
                thread::spawn(move || {
                    barrier.wait();
                    with_authenticode_provider_state_lock(|| {
                        let current = active.fetch_add(1, Ordering::SeqCst) + 1;
                        max_active.fetch_max(current, Ordering::SeqCst);
                        thread::sleep(Duration::from_millis(2));
                        active.fetch_sub(1, Ordering::SeqCst);
                    })
                    .expect("the Authenticode provider-state lock must remain usable");
                })
            })
            .collect::<Vec<_>>();

        for handle in handles {
            handle.join().expect("worker must finish");
        }

        assert_eq!(max_active.load(Ordering::SeqCst), 1);
    }
}

fn signer_identity(state: HANDLE) -> Option<AuthenticodeIdentity> {
    if state.is_null() {
        return None;
    }
    // SAFETY: state is owned by the active WinVerifyTrust call.
    let provider = unsafe { WTHelperProvDataFromStateData(state) };
    if provider.is_null() {
        return None;
    }
    // SAFETY: provider remains valid until WTD_STATEACTION_CLOSE.
    let signer = unsafe { WTHelperGetProvSignerFromChain(provider, 0, 0, 0) };
    if signer.is_null() {
        return None;
    }
    // SAFETY: the provider helper validates the signer chain and returns the
    // requested certificate record, or null when no first certificate exists.
    let provider_certificate = unsafe { WTHelperGetProvCertFromChain(signer, 0) };
    if provider_certificate.is_null() {
        return None;
    }
    // SAFETY: the provider certificate remains valid until the trust state is
    // closed by the caller.
    let certificate = unsafe { (*provider_certificate).pCert };
    if certificate.is_null() {
        return None;
    }
    // SAFETY: certificate remains valid until the trust state is closed.
    let length = unsafe {
        CertGetNameStringW(
            certificate,
            CERT_NAME_SIMPLE_DISPLAY_TYPE,
            0,
            std::ptr::null(),
            std::ptr::null_mut(),
            0,
        )
    };
    if length <= 1 || length > MAX_CERTIFICATE_DISPLAY_NAME_UTF16 {
        return None;
    }
    let mut buffer = vec![0u16; length as usize];
    // SAFETY: buffer has exactly the capacity requested by the first call.
    let written = unsafe {
        CertGetNameStringW(
            certificate,
            CERT_NAME_SIMPLE_DISPLAY_TYPE,
            0,
            std::ptr::null(),
            buffer.as_mut_ptr(),
            length,
        )
    };
    if written <= 1 || written > length {
        return None;
    }
    buffer.truncate((written - 1) as usize);
    let publisher = String::from_utf16(&buffer).ok()?;

    // SAFETY: the encoded certificate bytes are owned by the live certificate
    // context and remain valid until the trust state is closed.
    let (encoded, encoded_length) = unsafe {
        (
            (*certificate).pbCertEncoded,
            (*certificate).cbCertEncoded as usize,
        )
    };
    if encoded.is_null() || encoded_length == 0 || encoded_length > MAX_SIGNER_CERTIFICATE_BYTES {
        return None;
    }
    // SAFETY: the pointer and bounded length come from the live certificate
    // context checked immediately above.
    let certificate_bytes = unsafe { slice::from_raw_parts(encoded, encoded_length) };
    let certificate_sha256 = Sha256::digest(certificate_bytes).into();
    Some(AuthenticodeIdentity {
        publisher,
        certificate_sha256,
    })
}
