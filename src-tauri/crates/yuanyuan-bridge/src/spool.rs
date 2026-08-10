use std::{
    fs::{self, File, OpenOptions},
    io::{Read, Write},
    path::{Path, PathBuf},
};

use sha2::{Digest, Sha256};
use thiserror::Error;

use crate::MAX_BRIDGE_INPUT_BYTES;

const FRAME_MAGIC: &[u8; 8] = b"YYSPV001";
const FRAME_SCHEMA_VERSION: u16 = 1;
const FRAME_HEADER_BYTES: usize = 8 + 2 + 4 + 4 + 8;
const LOCK_FILE_NAME: &str = ".spool.lock";

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct SpoolLimits {
    pub pending_files: usize,
    pub pending_bytes: u64,
    pub quarantine_files: usize,
    pub quarantine_bytes: u64,
    pub replay_batch: usize,
}

impl Default for SpoolLimits {
    fn default() -> Self {
        Self {
            pending_files: 256,
            pending_bytes: 8 * 1024 * 1024,
            quarantine_files: 64,
            quarantine_bytes: 4 * 1024 * 1024,
            replay_batch: 64,
        }
    }
}

impl SpoolLimits {
    fn validate(self) -> Result<Self, SpoolError> {
        if self.pending_files == 0
            || self.pending_bytes < (FRAME_HEADER_BYTES + MAX_BRIDGE_INPUT_BYTES) as u64
            || self.quarantine_files == 0
            || self.quarantine_bytes < FRAME_HEADER_BYTES as u64
            || self.replay_batch == 0
        {
            Err(SpoolError::InvalidLimits)
        } else {
            Ok(self)
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SpoolEnqueueOutcome {
    Stored,
    Duplicate,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ReplayDisposition {
    Acknowledge,
    RetryLater,
    Quarantine,
}

#[derive(Debug, Default, Clone, Copy, PartialEq, Eq)]
pub struct ReplayReport {
    pub acknowledged: usize,
    pub quarantined: usize,
    pub deferred: usize,
}

#[derive(Debug, Default, Clone, Copy, PartialEq, Eq)]
pub struct SpoolUsage {
    pub pending_files: u32,
    pub pending_bytes: u64,
    pub quarantined_files: u32,
    pub quarantined_bytes: u64,
}

#[derive(Debug, Error, Clone, Copy, PartialEq, Eq)]
pub enum SpoolError {
    #[error("spool limits are invalid")]
    InvalidLimits,
    #[error("spool path is unsafe")]
    UnsafePath,
    #[error("spool storage is unavailable")]
    Unavailable,
    #[error("spool is busy")]
    Busy,
    #[error("spool payload exceeds the byte limit")]
    InputTooLarge,
    #[error("spool timestamp is invalid")]
    InvalidTimestamp,
    #[error("spool capacity is full")]
    Full,
}

pub struct Spool {
    root: PathBuf,
    pending: PathBuf,
    quarantine: PathBuf,
    lock_path: PathBuf,
    limits: SpoolLimits,
}

impl Spool {
    pub fn open(root: impl AsRef<Path>, limits: SpoolLimits) -> Result<Self, SpoolError> {
        let limits = limits.validate()?;
        let root = root.as_ref().to_path_buf();
        ensure_directory(&root)?;
        let pending = root.join("pending");
        let quarantine = root.join("quarantine");
        ensure_directory(&pending)?;
        ensure_directory(&quarantine)?;
        let spool = Self {
            lock_path: root.join(LOCK_FILE_NAME),
            root,
            pending,
            quarantine,
            limits,
        };
        {
            let _lock = spool.lock()?;
            spool.cleanup_temporary_files()?;
        }
        Ok(spool)
    }

    pub fn root(&self) -> &Path {
        &self.root
    }

    pub fn usage(&self) -> Result<SpoolUsage, SpoolError> {
        let _lock = self.lock()?;
        spool_usage(&self.pending, &self.quarantine)
    }

    pub fn enqueue(
        &self,
        payload: &[u8],
        created_at_unix_ms: i64,
    ) -> Result<SpoolEnqueueOutcome, SpoolError> {
        if payload.len() > MAX_BRIDGE_INPUT_BYTES {
            return Err(SpoolError::InputTooLarge);
        }
        if created_at_unix_ms < 0 {
            return Err(SpoolError::InvalidTimestamp);
        }
        let _lock = self.lock()?;
        let digest = payload_digest(payload);
        if self.pending_contains_digest(&digest)? {
            return Ok(SpoolEnqueueOutcome::Duplicate);
        }
        let frame = encode_frame(payload, created_at_unix_ms);
        let (files, bytes) = directory_usage(&self.pending, "evt")?;
        if files >= self.limits.pending_files
            || bytes.saturating_add(frame.len() as u64) > self.limits.pending_bytes
        {
            return Err(SpoolError::Full);
        }

        let filename = format!("{created_at_unix_ms:020}-{digest}.evt");
        let final_path = self.pending.join(filename);
        let temp_path = self.pending.join(format!(
            ".write-{}-{}-{digest}.tmp",
            std::process::id(),
            created_at_unix_ms
        ));
        let mut temp = TemporaryFile::create(temp_path)?;
        temp.file
            .as_mut()
            .expect("temporary spool file must exist before commit")
            .write_all(&frame)
            .map_err(|_| SpoolError::Unavailable)?;
        temp.file
            .as_ref()
            .expect("temporary spool file must exist before commit")
            .sync_all()
            .map_err(|_| SpoolError::Unavailable)?;
        drop(temp.file.take());
        fs::rename(&temp.path, &final_path).map_err(|_| SpoolError::Unavailable)?;
        temp.committed = true;
        Ok(SpoolEnqueueOutcome::Stored)
    }

    pub fn replay<F>(&self, mut consumer: F) -> Result<ReplayReport, SpoolError>
    where
        F: FnMut(&[u8]) -> ReplayDisposition,
    {
        let _lock = self.lock()?;
        let mut entries = queue_entries(&self.pending, "evt")?;
        entries.sort();
        let mut report = ReplayReport::default();
        for path in entries.into_iter().take(self.limits.replay_batch) {
            let payload = match read_frame(&path) {
                Ok(payload) => payload,
                Err(FrameError::Corrupt) => {
                    self.move_to_quarantine(&path)?;
                    report.quarantined += 1;
                    continue;
                }
                Err(FrameError::Unavailable) => return Err(SpoolError::Unavailable),
            };
            match consumer(&payload) {
                ReplayDisposition::Acknowledge => {
                    fs::remove_file(&path).map_err(|_| SpoolError::Unavailable)?;
                    report.acknowledged += 1;
                }
                ReplayDisposition::RetryLater => {
                    report.deferred = 1;
                    break;
                }
                ReplayDisposition::Quarantine => {
                    self.move_to_quarantine(&path)?;
                    report.quarantined += 1;
                }
            }
        }
        Ok(report)
    }

    fn lock(&self) -> Result<File, SpoolError> {
        let file = OpenOptions::new()
            .read(true)
            .write(true)
            .create(true)
            .truncate(false)
            .open(&self.lock_path)
            .map_err(|_| SpoolError::Unavailable)?;
        for _ in 0..10 {
            match file.try_lock() {
                Ok(()) => return Ok(file),
                Err(std::fs::TryLockError::WouldBlock) => {
                    std::thread::sleep(std::time::Duration::from_millis(5));
                }
                Err(std::fs::TryLockError::Error(_)) => return Err(SpoolError::Unavailable),
            }
        }
        Err(SpoolError::Busy)
    }

    fn cleanup_temporary_files(&self) -> Result<(), SpoolError> {
        for entry in fs::read_dir(&self.pending).map_err(|_| SpoolError::Unavailable)? {
            let entry = entry.map_err(|_| SpoolError::Unavailable)?;
            let name = entry.file_name();
            let name = name.to_string_lossy();
            if entry
                .file_type()
                .map_err(|_| SpoolError::Unavailable)?
                .is_file()
                && name.starts_with(".write-")
                && name.ends_with(".tmp")
            {
                fs::remove_file(entry.path()).map_err(|_| SpoolError::Unavailable)?;
            }
        }
        Ok(())
    }

    fn pending_contains_digest(&self, digest: &str) -> Result<bool, SpoolError> {
        let suffix = format!("-{digest}.evt");
        Ok(queue_entries(&self.pending, "evt")?.iter().any(|path| {
            path.file_name()
                .and_then(|name| name.to_str())
                .is_some_and(|name| name.ends_with(&suffix))
        }))
    }

    fn move_to_quarantine(&self, source: &Path) -> Result<(), SpoolError> {
        let size = fs::metadata(source)
            .map_err(|_| SpoolError::Unavailable)?
            .len();
        self.make_quarantine_room(size)?;
        let filename = source
            .file_stem()
            .and_then(|name| name.to_str())
            .ok_or(SpoolError::UnsafePath)?;
        let destination = self.quarantine.join(format!("{filename}.bad"));
        if destination.exists() {
            fs::remove_file(source).map_err(|_| SpoolError::Unavailable)?;
        } else {
            fs::rename(source, destination).map_err(|_| SpoolError::Unavailable)?;
        }
        Ok(())
    }

    fn make_quarantine_room(&self, incoming_bytes: u64) -> Result<(), SpoolError> {
        let mut entries = queue_entries(&self.quarantine, "bad")?;
        entries.sort();
        let (_, mut bytes) = directory_usage(&self.quarantine, "bad")?;
        while entries.len() >= self.limits.quarantine_files
            || bytes.saturating_add(incoming_bytes) > self.limits.quarantine_bytes
        {
            let Some(oldest) = entries.first().cloned() else {
                return Err(SpoolError::Full);
            };
            let removed = fs::metadata(&oldest)
                .map_err(|_| SpoolError::Unavailable)?
                .len();
            fs::remove_file(&oldest).map_err(|_| SpoolError::Unavailable)?;
            entries.remove(0);
            bytes = bytes.saturating_sub(removed);
        }
        Ok(())
    }
}

/// Reads only bounded file counts and sizes from an existing spool. It does
/// not create directories, replay events, decode payloads or clean files.
pub fn inspect_spool_usage(root: impl AsRef<Path>) -> Result<SpoolUsage, SpoolError> {
    let root = root.as_ref();
    require_existing_directory(root)?;
    let pending = root.join("pending");
    let quarantine = root.join("quarantine");
    require_existing_directory(&pending)?;
    require_existing_directory(&quarantine)?;
    spool_usage(&pending, &quarantine)
}

struct TemporaryFile {
    path: PathBuf,
    file: Option<File>,
    committed: bool,
}

impl TemporaryFile {
    fn create(path: PathBuf) -> Result<Self, SpoolError> {
        let file = OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&path)
            .map_err(|_| SpoolError::Unavailable)?;
        Ok(Self {
            path,
            file: Some(file),
            committed: false,
        })
    }
}

impl Drop for TemporaryFile {
    fn drop(&mut self) {
        if !self.committed {
            let _ = fs::remove_file(&self.path);
        }
    }
}

fn ensure_directory(path: &Path) -> Result<(), SpoolError> {
    if path.exists() {
        let metadata = fs::symlink_metadata(path).map_err(|_| SpoolError::Unavailable)?;
        if !metadata.is_dir() || metadata.file_type().is_symlink() {
            return Err(SpoolError::UnsafePath);
        }
    } else {
        fs::create_dir_all(path).map_err(|_| SpoolError::Unavailable)?;
    }
    Ok(())
}

fn require_existing_directory(path: &Path) -> Result<(), SpoolError> {
    let metadata = fs::symlink_metadata(path).map_err(|_| SpoolError::Unavailable)?;
    if !metadata.is_dir() || metadata.file_type().is_symlink() {
        return Err(SpoolError::UnsafePath);
    }
    Ok(())
}

fn queue_entries(directory: &Path, extension: &str) -> Result<Vec<PathBuf>, SpoolError> {
    let mut entries = Vec::new();
    for entry in fs::read_dir(directory).map_err(|_| SpoolError::Unavailable)? {
        let entry = entry.map_err(|_| SpoolError::Unavailable)?;
        let file_type = entry.file_type().map_err(|_| SpoolError::Unavailable)?;
        if entry.path().extension().and_then(|value| value.to_str()) == Some(extension) {
            if !file_type.is_file() || file_type.is_symlink() {
                return Err(SpoolError::UnsafePath);
            }
            entries.push(entry.path());
        }
    }
    Ok(entries)
}

fn spool_usage(pending: &Path, quarantine: &Path) -> Result<SpoolUsage, SpoolError> {
    let (pending_files, pending_bytes) = directory_usage(pending, "evt")?;
    let (quarantined_files, quarantined_bytes) = directory_usage(quarantine, "bad")?;
    Ok(SpoolUsage {
        pending_files: pending_files
            .try_into()
            .map_err(|_| SpoolError::Unavailable)?,
        pending_bytes,
        quarantined_files: quarantined_files
            .try_into()
            .map_err(|_| SpoolError::Unavailable)?,
        quarantined_bytes,
    })
}

fn directory_usage(directory: &Path, extension: &str) -> Result<(usize, u64), SpoolError> {
    let entries = queue_entries(directory, extension)?;
    let mut bytes = 0_u64;
    for entry in &entries {
        bytes = bytes.saturating_add(
            fs::metadata(entry)
                .map_err(|_| SpoolError::Unavailable)?
                .len(),
        );
    }
    Ok((entries.len(), bytes))
}

fn encode_frame(payload: &[u8], created_at_unix_ms: i64) -> Vec<u8> {
    let mut frame = Vec::with_capacity(FRAME_HEADER_BYTES + payload.len());
    frame.extend_from_slice(FRAME_MAGIC);
    frame.extend_from_slice(&FRAME_SCHEMA_VERSION.to_be_bytes());
    frame.extend_from_slice(&(payload.len() as u32).to_be_bytes());
    frame.extend_from_slice(&crc32c(payload).to_be_bytes());
    frame.extend_from_slice(&created_at_unix_ms.to_be_bytes());
    frame.extend_from_slice(payload);
    frame
}

enum FrameError {
    Corrupt,
    Unavailable,
}

fn read_frame(path: &Path) -> Result<Vec<u8>, FrameError> {
    let maximum = FRAME_HEADER_BYTES + MAX_BRIDGE_INPUT_BYTES;
    let metadata = fs::symlink_metadata(path).map_err(|_| FrameError::Unavailable)?;
    if !metadata.is_file() || metadata.file_type().is_symlink() || metadata.len() > maximum as u64 {
        return Err(FrameError::Corrupt);
    }
    let file = File::open(path).map_err(|_| FrameError::Unavailable)?;
    let mut frame = Vec::with_capacity(metadata.len() as usize);
    file.take((maximum + 1) as u64)
        .read_to_end(&mut frame)
        .map_err(|_| FrameError::Unavailable)?;
    if frame.len() < FRAME_HEADER_BYTES || &frame[..8] != FRAME_MAGIC {
        return Err(FrameError::Corrupt);
    }
    let schema = u16::from_be_bytes(frame[8..10].try_into().unwrap());
    let payload_length = u32::from_be_bytes(frame[10..14].try_into().unwrap()) as usize;
    let expected_crc = u32::from_be_bytes(frame[14..18].try_into().unwrap());
    let created_at = i64::from_be_bytes(frame[18..26].try_into().unwrap());
    if schema != FRAME_SCHEMA_VERSION
        || created_at < 0
        || payload_length > MAX_BRIDGE_INPUT_BYTES
        || frame.len() != FRAME_HEADER_BYTES + payload_length
        || crc32c(&frame[FRAME_HEADER_BYTES..]) != expected_crc
    {
        return Err(FrameError::Corrupt);
    }
    Ok(frame.split_off(FRAME_HEADER_BYTES))
}

fn payload_digest(payload: &[u8]) -> String {
    let digest = Sha256::digest(payload);
    let mut output = String::with_capacity(digest.len() * 2);
    for byte in digest {
        use std::fmt::Write as _;
        let _ = write!(output, "{byte:02x}");
    }
    output
}

fn crc32c(bytes: &[u8]) -> u32 {
    let mut crc = !0_u32;
    for byte in bytes {
        crc ^= u32::from(*byte);
        for _ in 0..8 {
            crc = (crc >> 1) ^ (0x82f6_3b78 & 0_u32.wrapping_sub(crc & 1));
        }
    }
    !crc
}

#[cfg(test)]
mod tests {
    use std::{sync::Arc, thread};

    use super::*;

    fn spool(limits: SpoolLimits) -> (tempfile::TempDir, Spool) {
        let directory = tempfile::tempdir().unwrap();
        let spool = Spool::open(directory.path(), limits).unwrap();
        (directory, spool)
    }

    #[test]
    fn crc32c_matches_the_castagnoli_reference_vector() {
        assert_eq!(crc32c(b"123456789"), 0xe306_9283);
    }

    #[test]
    fn stores_frames_atomically_and_deletes_only_after_acknowledgement() {
        let (_directory, spool) = spool(SpoolLimits::default());
        assert_eq!(
            spool.enqueue(b"event-one", 1),
            Ok(SpoolEnqueueOutcome::Stored)
        );
        assert_eq!(
            spool.enqueue(b"event-one", 2),
            Ok(SpoolEnqueueOutcome::Duplicate)
        );
        assert!(queue_entries(&spool.pending, "tmp").unwrap().is_empty());

        let report = spool
            .replay(|payload| {
                assert_eq!(payload, b"event-one");
                ReplayDisposition::Acknowledge
            })
            .unwrap();
        assert_eq!(report.acknowledged, 1);
        assert!(queue_entries(&spool.pending, "evt").unwrap().is_empty());
    }

    #[test]
    fn retry_later_preserves_the_oldest_event_and_order() {
        let (_directory, spool) = spool(SpoolLimits::default());
        spool.enqueue(b"first", 1).unwrap();
        spool.enqueue(b"second", 2).unwrap();
        let report = spool.replay(|_| ReplayDisposition::RetryLater).unwrap();
        assert_eq!(report.deferred, 1);
        assert_eq!(queue_entries(&spool.pending, "evt").unwrap().len(), 2);

        let mut seen = Vec::new();
        spool
            .replay(|payload| {
                seen.push(payload.to_vec());
                ReplayDisposition::Acknowledge
            })
            .unwrap();
        assert_eq!(seen, [b"first".to_vec(), b"second".to_vec()]);
    }

    #[test]
    fn crc_damage_is_isolated_without_reaching_the_consumer() {
        let (_directory, spool) = spool(SpoolLimits::default());
        spool.enqueue(b"damaged", 1).unwrap();
        let path = queue_entries(&spool.pending, "evt").unwrap().remove(0);
        let mut frame = fs::read(&path).unwrap();
        *frame.last_mut().unwrap() ^= 0xff;
        fs::write(&path, frame).unwrap();
        let mut calls = 0;
        let report = spool
            .replay(|_| {
                calls += 1;
                ReplayDisposition::Acknowledge
            })
            .unwrap();
        assert_eq!(calls, 0);
        assert_eq!(report.quarantined, 1);
        assert_eq!(queue_entries(&spool.quarantine, "bad").unwrap().len(), 1);
    }

    #[test]
    fn pending_capacity_is_a_hard_limit() {
        let limits = SpoolLimits {
            pending_files: 1,
            ..SpoolLimits::default()
        };
        let (_directory, spool) = spool(limits);
        spool.enqueue(b"first", 1).unwrap();
        assert_eq!(spool.enqueue(b"second", 2), Err(SpoolError::Full));
    }

    #[test]
    fn pending_byte_capacity_is_a_hard_limit() {
        let limits = SpoolLimits {
            pending_bytes: (FRAME_HEADER_BYTES + MAX_BRIDGE_INPUT_BYTES) as u64,
            ..SpoolLimits::default()
        };
        let (_directory, spool) = spool(limits);
        spool.enqueue(&vec![7; MAX_BRIDGE_INPUT_BYTES], 1).unwrap();
        assert_eq!(spool.enqueue(b"next", 2), Err(SpoolError::Full));
    }

    #[test]
    fn usage_reports_only_counts_and_bytes_without_decoding_payloads() {
        let (directory, spool) = spool(SpoolLimits::default());
        spool.enqueue(b"first-sensitive-payload", 1).unwrap();
        spool.enqueue(b"second-sensitive-payload", 2).unwrap();

        let direct = spool.usage().unwrap();
        let inspected = inspect_spool_usage(directory.path()).unwrap();
        assert_eq!(direct, inspected);
        assert_eq!(direct.pending_files, 2);
        assert!(direct.pending_bytes > 2);
        assert_eq!(direct.quarantined_files, 0);
        assert_eq!(direct.quarantined_bytes, 0);
        assert!(!format!("{direct:?}").contains("sensitive-payload"));
    }

    #[test]
    fn usage_inspection_never_creates_a_missing_or_unsafe_spool() {
        let directory = tempfile::tempdir().unwrap();
        let missing = directory.path().join("missing");
        assert_eq!(inspect_spool_usage(&missing), Err(SpoolError::Unavailable));
        assert!(!missing.exists());

        let occupied = directory.path().join("occupied");
        fs::write(&occupied, b"not a directory").unwrap();
        assert_eq!(inspect_spool_usage(&occupied), Err(SpoolError::UnsafePath));
    }

    #[test]
    fn schema_and_length_damage_are_quarantined() {
        let (_directory, spool) = spool(SpoolLimits::default());
        spool.enqueue(b"schema", 1).unwrap();
        let schema_path = queue_entries(&spool.pending, "evt").unwrap().remove(0);
        let mut schema_frame = fs::read(&schema_path).unwrap();
        schema_frame[8..10].copy_from_slice(&2_u16.to_be_bytes());
        fs::write(&schema_path, schema_frame).unwrap();

        spool.enqueue(b"length", 2).unwrap();
        let length_path = queue_entries(&spool.pending, "evt")
            .unwrap()
            .into_iter()
            .find(|path| path != &schema_path)
            .unwrap();
        let mut length_frame = fs::read(&length_path).unwrap();
        length_frame[10..14].copy_from_slice(&99_u32.to_be_bytes());
        fs::write(&length_path, length_frame).unwrap();

        let report = spool
            .replay(|_| panic!("corrupt frames must not reach consumer"))
            .unwrap();
        assert_eq!(report.quarantined, 2);
    }

    #[test]
    fn reopening_cleans_only_owned_crash_temporary_files() {
        let directory = tempfile::tempdir().unwrap();
        {
            let spool = Spool::open(directory.path(), SpoolLimits::default()).unwrap();
            fs::write(spool.pending.join(".write-crashed.tmp"), b"partial").unwrap();
            fs::write(spool.pending.join("unrelated.tmp"), b"keep").unwrap();
        }
        let reopened = Spool::open(directory.path(), SpoolLimits::default()).unwrap();
        assert!(!reopened.pending.join(".write-crashed.tmp").exists());
        assert!(reopened.pending.join("unrelated.tmp").exists());
    }

    #[test]
    fn quarantine_rotates_the_oldest_file_within_its_limit() {
        let limits = SpoolLimits {
            quarantine_files: 1,
            ..SpoolLimits::default()
        };
        let (_directory, spool) = spool(limits);
        for (timestamp, payload) in [(1, b"one".as_slice()), (2, b"two".as_slice())] {
            spool.enqueue(payload, timestamp).unwrap();
            let path = queue_entries(&spool.pending, "evt").unwrap().remove(0);
            fs::write(&path, b"corrupt").unwrap();
            spool.replay(|_| ReplayDisposition::Acknowledge).unwrap();
        }
        let entries = queue_entries(&spool.quarantine, "bad").unwrap();
        assert_eq!(entries.len(), 1);
        assert!(entries[0]
            .file_name()
            .unwrap()
            .to_string_lossy()
            .starts_with("00000000000000000002"));
    }

    #[test]
    fn cross_thread_lock_keeps_duplicate_enqueue_atomic() {
        let directory = tempfile::tempdir().unwrap();
        let spool = Arc::new(Spool::open(directory.path(), SpoolLimits::default()).unwrap());
        let workers = [spool.clone(), spool]
            .map(|spool| thread::spawn(move || spool.enqueue(b"same-event", 1)));
        let results = workers.map(|worker| worker.join().unwrap());
        assert_eq!(
            results
                .into_iter()
                .filter(|result| *result == Ok(SpoolEnqueueOutcome::Stored))
                .count(),
            1
        );
    }

    #[test]
    fn lock_contention_returns_busy_without_writing_an_event() {
        let (_directory, spool) = spool(SpoolLimits::default());
        let lock = OpenOptions::new()
            .read(true)
            .write(true)
            .open(&spool.lock_path)
            .unwrap();
        lock.lock().unwrap();
        assert_eq!(spool.enqueue(b"blocked", 1), Err(SpoolError::Busy));
        assert!(queue_entries(&spool.pending, "evt").unwrap().is_empty());
    }

    #[test]
    fn a_file_or_link_cannot_be_used_as_the_spool_root() {
        let directory = tempfile::tempdir().unwrap();
        let file = directory.path().join("not-a-directory");
        fs::write(&file, b"existing").unwrap();
        assert!(matches!(
            Spool::open(file, SpoolLimits::default()),
            Err(SpoolError::UnsafePath)
        ));
    }
}
