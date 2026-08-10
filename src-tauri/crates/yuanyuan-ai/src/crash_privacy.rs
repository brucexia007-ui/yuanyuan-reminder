use std::ptr;

use thiserror::Error;
use windows_sys::Win32::{
    Foundation::{ERROR_FILE_NOT_FOUND, ERROR_PATH_NOT_FOUND, ERROR_SUCCESS},
    System::{
        ErrorReporting::{
            WerGetFlags, WerSetFlags, WER_FAULT_REPORTING_FLAG_NOHEAP,
            WER_FAULT_REPORTING_FLAG_QUEUE, WER_FAULT_REPORTING_FLAG_QUEUE_UPLOAD,
        },
        Registry::{
            RegCloseKey, RegOpenKeyExW, RegQueryValueExW, HKEY, HKEY_LOCAL_MACHINE,
            KEY_QUERY_VALUE, KEY_WOW64_64KEY,
        },
        Threading::GetCurrentProcess,
    },
};

const LOCAL_DUMPS_REGISTRY_KEY: &str =
    r"SOFTWARE\Microsoft\Windows\Windows Error Reporting\LocalDumps";
const AI_LOCAL_DUMPS_REGISTRY_KEY: &str =
    r"SOFTWARE\Microsoft\Windows\Windows Error Reporting\LocalDumps\yuanyuan-ai.exe";
const LOCAL_DUMP_VALUE_NAMES: [&str; 4] =
    ["DumpFolder", "DumpCount", "DumpType", "CustomDumpFlags"];

#[derive(Debug, Error, Clone, Copy, PartialEq, Eq)]
pub enum SensitiveProcessCrashPolicyError {
    #[error("sensitive-process error reporting policy is unavailable")]
    ErrorReportingUnavailable,
    #[error("sensitive-process local dump policy could not be inspected")]
    LocalDumpPolicyUnavailable,
    #[error("sensitive-process local dump capture is enabled")]
    LocalDumpCaptureEnabled,
}

/// Applies the process-local WER no-heap policy and refuses to run on a host
/// with a machine-wide or `yuanyuan-ai.exe` LocalDumps configuration. This is
/// intentionally called before private bootstrap bytes, databases, or user
/// text enter the AI process.
pub fn enforce_sensitive_process_crash_policy() -> Result<(), SensitiveProcessCrashPolicyError> {
    apply_and_verify_wer_no_heap()?;
    reject_enabled_local_dump_capture()
}

fn apply_and_verify_wer_no_heap() -> Result<(), SensitiveProcessCrashPolicyError> {
    // SAFETY: WerSetFlags applies only to the calling process and accepts the
    // documented NOHEAP flag on supported desktop Windows versions.
    if unsafe { WerSetFlags(WER_FAULT_REPORTING_FLAG_NOHEAP) } < 0 {
        return Err(SensitiveProcessCrashPolicyError::ErrorReportingUnavailable);
    }
    let mut flags = 0;
    // SAFETY: GetCurrentProcess returns a valid pseudo-handle and `flags` is a
    // writable output for this synchronous query.
    if unsafe { WerGetFlags(GetCurrentProcess(), &mut flags) } < 0
        || flags & WER_FAULT_REPORTING_FLAG_NOHEAP == 0
        || flags & (WER_FAULT_REPORTING_FLAG_QUEUE | WER_FAULT_REPORTING_FLAG_QUEUE_UPLOAD) != 0
    {
        return Err(SensitiveProcessCrashPolicyError::ErrorReportingUnavailable);
    }
    Ok(())
}

fn reject_enabled_local_dump_capture() -> Result<(), SensitiveProcessCrashPolicyError> {
    let Some(global) = open_machine_key(LOCAL_DUMPS_REGISTRY_KEY)? else {
        return evaluate_local_dump_configuration(false, false);
    };
    let mut global_configuration_present = false;
    for value_name in LOCAL_DUMP_VALUE_NAMES {
        if registry_value_exists(global.0, value_name)? {
            global_configuration_present = true;
            break;
        }
    }
    evaluate_local_dump_configuration(
        global_configuration_present,
        open_machine_key(AI_LOCAL_DUMPS_REGISTRY_KEY)?.is_some(),
    )
}

fn evaluate_local_dump_configuration(
    global_configuration_present: bool,
    ai_configuration_present: bool,
) -> Result<(), SensitiveProcessCrashPolicyError> {
    if global_configuration_present || ai_configuration_present {
        return Err(SensitiveProcessCrashPolicyError::LocalDumpCaptureEnabled);
    }
    Ok(())
}

fn open_machine_key(
    path: &str,
) -> Result<Option<OwnedRegistryKey>, SensitiveProcessCrashPolicyError> {
    let path = wide_null(path);
    let mut key = ptr::null_mut();
    // SAFETY: the path is NUL terminated, the output pointer is valid, and a
    // successful handle is immediately wrapped for deterministic closure.
    let status = unsafe {
        RegOpenKeyExW(
            HKEY_LOCAL_MACHINE,
            path.as_ptr(),
            0,
            KEY_QUERY_VALUE | KEY_WOW64_64KEY,
            &mut key,
        )
    };
    match status {
        ERROR_SUCCESS => Ok(Some(OwnedRegistryKey(key))),
        ERROR_FILE_NOT_FOUND | ERROR_PATH_NOT_FOUND => Ok(None),
        _ => Err(SensitiveProcessCrashPolicyError::LocalDumpPolicyUnavailable),
    }
}

fn registry_value_exists(
    key: HKEY,
    value_name: &str,
) -> Result<bool, SensitiveProcessCrashPolicyError> {
    let value_name = wide_null(value_name);
    let mut value_type = 0;
    let mut value_bytes = 0;
    // SAFETY: `key` is live, the value name is NUL terminated, and the type
    // and size outputs are writable. A null data buffer performs a size-only
    // existence query without reading the configured folder or value bytes.
    let status = unsafe {
        RegQueryValueExW(
            key,
            value_name.as_ptr(),
            ptr::null(),
            &mut value_type,
            ptr::null_mut(),
            &mut value_bytes,
        )
    };
    match status {
        ERROR_SUCCESS => Ok(true),
        ERROR_FILE_NOT_FOUND | ERROR_PATH_NOT_FOUND => Ok(false),
        _ => Err(SensitiveProcessCrashPolicyError::LocalDumpPolicyUnavailable),
    }
}

fn wide_null(value: &str) -> Vec<u16> {
    value.encode_utf16().chain(std::iter::once(0)).collect()
}

struct OwnedRegistryKey(HKEY);

impl Drop for OwnedRegistryKey {
    fn drop(&mut self) {
        // SAFETY: this wrapper owns a handle returned by RegOpenKeyExW.
        unsafe { RegCloseKey(self.0) };
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn current_process_applies_no_heap_without_queue_or_upload_flags() {
        enforce_sensitive_process_crash_policy().unwrap();
        let mut flags = 0;
        assert!(unsafe { WerGetFlags(GetCurrentProcess(), &mut flags) } >= 0);
        assert_ne!(flags & WER_FAULT_REPORTING_FLAG_NOHEAP, 0);
        assert_eq!(
            flags & (WER_FAULT_REPORTING_FLAG_QUEUE | WER_FAULT_REPORTING_FLAG_QUEUE_UPLOAD),
            0
        );
    }

    #[test]
    fn policy_is_applied_before_private_bootstrap_or_local_storage() {
        let main_source = include_str!("main.rs");
        let policy = main_source
            .find("enforce_sensitive_process_crash_policy")
            .unwrap();
        let bootstrap = main_source
            .find("SupportSortSessionBootstrap::read_from")
            .unwrap();
        let local_app_data = main_source.find("var_os(\"LOCALAPPDATA\")").unwrap();
        assert!(policy < bootstrap);
        assert!(policy < local_app_data);

        let policy_source = include_str!("crash_privacy.rs");
        let policy_start = policy_source
            .find("pub fn enforce_sensitive_process_crash_policy")
            .unwrap();
        let policy_body = &policy_source[policy_start
            ..policy_source[policy_start..]
                .find("\n}\n\nfn apply_and_verify_wer_no_heap")
                .map(|offset| policy_start + offset)
                .unwrap()];
        assert!(
            policy_body.find("apply_and_verify_wer_no_heap").unwrap()
                < policy_body
                    .find("reject_enabled_local_dump_capture")
                    .unwrap()
        );

        let host_source = include_str!("support_sort_host.rs");
        assert_eq!(
            host_source
                .matches("accept_one_with_pre_read_guard")
                .count(),
            2
        );
        assert_eq!(
            host_source
                .matches("enforce_sensitive_process_crash_policy")
                .count(),
            2
        );
    }

    #[test]
    fn local_dump_configuration_names_are_fixed_and_content_free() {
        assert_eq!(LOCAL_DUMP_VALUE_NAMES.len(), 4);
        assert!(LOCAL_DUMP_VALUE_NAMES.into_iter().all(|name| matches!(
            name,
            "DumpFolder" | "DumpCount" | "DumpType" | "CustomDumpFlags"
        )));
        assert!(AI_LOCAL_DUMPS_REGISTRY_KEY.ends_with("yuanyuan-ai.exe"));
    }

    #[test]
    fn any_global_or_ai_specific_local_dump_configuration_fails_closed() {
        assert_eq!(evaluate_local_dump_configuration(false, false), Ok(()));
        for observation in [(true, false), (false, true), (true, true)] {
            assert_eq!(
                evaluate_local_dump_configuration(observation.0, observation.1),
                Err(SensitiveProcessCrashPolicyError::LocalDumpCaptureEnabled)
            );
        }
    }
}
