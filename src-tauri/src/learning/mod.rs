mod import;
mod invitation;
mod legacy_migration;
mod models;
mod pack;
#[cfg(test)]
mod unified_tests;
mod quiz;
mod repository;
mod scheduler_adapter;
#[cfg(windows)]
mod windows_suitability;
#[cfg(windows)]
pub(crate) use windows_suitability::current_system_suitability;

use std::{
    collections::BTreeMap,
    fs,
    path::{Path, PathBuf},
};

use crate::error::{AppError, AppResult};
use crate::models::LearningCapabilities;

pub(crate) use self::models::{
    ImportCommitResult, LearningAnswerResult, LearningCardDto, LearningDashboardSnapshot,
    LearningHomeSnapshot, LearningImportPreview, LearningQuestionDto, LearningRateResult,
    LearningRating, LearningRecordFilter, LearningRecordPage, LearningSessionKind,
    LearningSessionSnapshot, LearningSessionSummary, LearningSettings, LearningSettingsPatch,
};
use self::models::{ImportProgressHint, ParsedUserImport};
use invitation::evaluate_learning_invitation;
pub(crate) use invitation::{
    LearningInvitationContext, LearningInvitationDecision, LearningInvitationDto,
    LearningInvitationEnvironment, LearningSuppressionReason, LearningTriggerSource,
};
pub(crate) use legacy_migration::{
    LegacyLearningEdition, LegacyLearningMigrationPreview, LegacyLearningMigrationResult,
    LegacyLearningSourceSummary,
};
use repository::portability::NativeLearningExport;
pub(crate) use repository::portability::{
    write_new_file_atomically, LearningDataSummary, LearningDeleteResult, LearningDeleteScope,
    LearningExportFormat, LearningExportResult,
};

const IMPORT_PREVIEW_TTL_MILLIS: i64 = 10 * 60 * 1_000;
const MAX_PENDING_IMPORT_PREVIEWS: usize = 8;
const LEARNING_INVITATION_TTL_MILLIS: i64 = 20_000;

pub(crate) fn record_invitation_suppression(
    runtime: &parking_lot::Mutex<LearningRuntime>,
    context: &LearningInvitationContext,
    invitation_id: &str,
) -> AppResult<bool> {
    // Rust 2021 keeps an if-let scrutinee's temporary guard alive in its body.
    // Use one explicit guard so a suppressed invitation cannot relock itself
    // and stop the scheduler (or every subsequent learning command).
    let mut runtime = runtime.lock();
    if let LearningInvitationDecision::Suppressed(reason) = runtime.evaluate_invitation(context) {
        runtime.record_invitation_event(
            invitation_id,
            context.trigger_source,
            "suppressed",
            Some(reason),
            context.now_unix_ms,
        )?;
        return Ok(true);
    }
    Ok(false)
}

struct PendingImportPreview {
    expires_at_unix_ms: i64,
    import: PendingLearningImport,
}

enum PendingLearningImport {
    Csv(ParsedUserImport),
    NativeJson(NativeLearningExport),
    GenericPack {
        import: pack::GenericPackImport,
        source_path: PathBuf,
    },
}

struct PendingLearningInvitation {
    invitation_id: String,
    trigger_source: LearningTriggerSource,
    expires_at_unix_ms: i64,
    due_review_count: u32,
}

pub struct LearningRuntime {
    repository: Option<repository::LearningRepository>,
    database_path: Option<PathBuf>,
    initialization_failed: bool,
    pending_imports: BTreeMap<String, PendingImportPreview>,
    pending_legacy_migrations: BTreeMap<String, legacy_migration::PendingLegacyMigration>,
    pending_invitation: Option<PendingLearningInvitation>,
}

impl Default for LearningRuntime {
    fn default() -> Self {
        Self {
            repository: None,
            database_path: None,
            initialization_failed: false,
            pending_imports: BTreeMap::new(),
            pending_legacy_migrations: BTreeMap::new(),
            pending_invitation: None,
        }
    }
}

impl LearningRuntime {
    pub fn configured(path: &Path) -> Self {
        if path.exists() {
            return Self::initialize(path);
        }
        Self {
            database_path: Some(path.to_path_buf()),
            ..Self::default()
        }
    }

    pub fn initialize(path: &Path) -> Self {
        match repository::LearningRepository::open(path) {
            Ok(repository) => Self {
                repository: Some(repository),
                database_path: Some(path.to_path_buf()),
                initialization_failed: false,
                pending_imports: BTreeMap::new(),
                pending_legacy_migrations: BTreeMap::new(),
                pending_invitation: None,
            },
            Err(_) => {
                tracing::warn!("learning database is unavailable; learning remains disabled");
                Self {
                    database_path: Some(path.to_path_buf()),
                    initialization_failed: true,
                    ..Self::default()
                }
            }
        }
    }

    fn ensure_repository(&mut self) -> AppResult<&mut repository::LearningRepository> {
        if self.repository.is_none() {
            let path = self.database_path.clone().ok_or_else(|| {
                AppError::Validation("learning database path is unavailable".into())
            })?;
            match repository::LearningRepository::open(&path) {
                Ok(repository) => {
                    self.repository = Some(repository);
                    self.initialization_failed = false;
                }
                Err(error) => {
                    self.initialization_failed = true;
                    tracing::warn!(error = %error, "learning database activation failed");
                    return Err(error);
                }
            }
        }
        Ok(self
            .repository
            .as_mut()
            .expect("learning repository must exist after successful activation"))
    }

    pub(crate) fn backup_to_if_present(&self, path: &Path) -> AppResult<bool> {
        let Some(database_path) = self.database_path.as_ref() else {
            return Ok(false);
        };
        if !database_path.is_file() {
            return Ok(false);
        }
        let repository = self.repository.as_ref().ok_or_else(|| {
            AppError::Validation("learning database is unavailable for backup".into())
        })?;
        repository.backup_to(path)?;
        repository::LearningRepository::validate_database_file(path)?;
        Ok(true)
    }

    pub(crate) fn validate_backup_file(path: &Path) -> AppResult<()> {
        repository::LearningRepository::validate_database_file(path)
    }

    pub(crate) fn restore_from_backup(&mut self, path: &Path) -> AppResult<()> {
        self.ensure_repository()?.restore_from(path)
    }

    pub(crate) fn rollback_restore_to_absent_database(&mut self) -> AppResult<()> {
        self.repository.take();
        let path = self
            .database_path
            .clone()
            .ok_or_else(|| AppError::Validation("learning database path is unavailable".into()))?;
        for candidate in [
            path.clone(),
            path.with_extension("sqlite3-wal"),
            path.with_extension("sqlite3-shm"),
        ] {
            if candidate.exists() {
                fs::remove_file(candidate)?;
            }
        }
        self.initialization_failed = false;
        self.pending_imports.clear();
        self.pending_legacy_migrations.clear();
        self.pending_invitation = None;
        Ok(())
    }

    pub fn automatic_invitation_state_loaded(&self) -> bool {
        self.repository.is_some()
    }

    pub fn capabilities(&self) -> LearningCapabilities {
        let Some(repository) = self.repository.as_ref() else {
            let configured = self.database_path.is_some();
            return LearningCapabilities {
                compiled: true,
                available: configured && !self.initialization_failed,
                content_pack_ready: false,
                auto_invitation_available: false,
                failure_reason: if self.initialization_failed {
                    Some("database".into())
                } else if configured {
                    None
                } else {
                    Some("not_configured".into())
                },
            };
        };
        match repository.has_ready_content() {
            Ok(content_pack_ready) => LearningCapabilities {
                compiled: true,
                available: true,
                content_pack_ready,
                auto_invitation_available: cfg!(windows) && content_pack_ready,
                failure_reason: None,
            },
            Err(_) => LearningCapabilities {
                compiled: true,
                available: false,
                content_pack_ready: false,
                auto_invitation_available: false,
                failure_reason: Some("database".into()),
            },
        }
    }

    #[allow(dead_code)]
    pub fn preview_csv_import(
        &mut self,
        bytes: &[u8],
        now_unix_ms: i64,
    ) -> AppResult<LearningImportPreview> {
        self.preview_csv_import_with_cancellation(bytes, now_unix_ms, &|| false)
    }

    pub fn preview_csv_import_with_cancellation<F>(
        &mut self,
        bytes: &[u8],
        now_unix_ms: i64,
        is_cancelled: &F,
    ) -> AppResult<LearningImportPreview>
    where
        F: Fn() -> bool,
    {
        import::ensure_import_not_cancelled(is_cancelled)?;
        if now_unix_ms < 0 {
            return Err(AppError::Validation(
                "learning import is unavailable".into(),
            ));
        }
        self.ensure_repository()?;
        self.pending_imports
            .retain(|_, pending| pending.expires_at_unix_ms > now_unix_ms);
        if self.pending_imports.len() >= MAX_PENDING_IMPORT_PREVIEWS {
            return Err(AppError::Validation(
                "too many learning import previews are pending".into(),
            ));
        }
        let import = import::parse_user_csv_with_cancellation(bytes, is_cancelled)?;
        let expires_at_unix_ms = now_unix_ms
            .checked_add(IMPORT_PREVIEW_TTL_MILLIS)
            .ok_or_else(|| AppError::Validation("learning preview time overflowed".into()))?;
        let token = uuid::Uuid::new_v4().to_string();
        let mut new_count = 0_u32;
        let mut learning_count = 0_u32;
        let mut review_known_count = 0_u32;
        for card in &import.cards {
            match card.progress_hint {
                ImportProgressHint::New => new_count += 1,
                ImportProgressHint::Learning => learning_count += 1,
                ImportProgressHint::ReviewKnown => review_known_count += 1,
            }
        }
        let preview = LearningImportPreview {
            schema_version: 1,
            status: "confirmation_required",
            preview_token: Some(token.clone()),
            expires_at_unix_ms: Some(expires_at_unix_ms),
            format: Some("csv"),
            source_label: Some(import.source_label.clone()),
            card_count: import.cards.len() as u32,
            new_count,
            learning_count,
            review_known_count,
            sample_headwords: import
                .cards
                .iter()
                .take(3)
                .map(|card| card.headword.clone())
                .collect(),
            added_count: import.cards.len() as u32,
            changed_count: 0,
            disabled_count: 0,
            reset_count: 0,
            rights_basis: None,
            rights_statement: None,
            redistributable: None,
            source_details: Vec::new(),
            selected_path_returned: false,
        };
        self.pending_imports.insert(
            token.clone(),
            PendingImportPreview {
                expires_at_unix_ms,
                import: PendingLearningImport::Csv(import),
            },
        );
        if let Err(error) = import::ensure_import_not_cancelled(is_cancelled) {
            self.pending_imports.remove(&token);
            return Err(error);
        }
        Ok(preview)
    }

    #[allow(dead_code)]
    pub fn preview_import_file(
        &mut self,
        path: &Path,
        now_unix_ms: i64,
    ) -> AppResult<LearningImportPreview> {
        self.preview_import_file_with_cancellation(path, now_unix_ms, &|| false)
    }

    pub fn preview_import_file_with_cancellation<F>(
        &mut self,
        path: &Path,
        now_unix_ms: i64,
        is_cancelled: &F,
    ) -> AppResult<LearningImportPreview>
    where
        F: Fn() -> bool,
    {
        self.preview_import_file_with_progress_and_cancellation(
            path,
            now_unix_ms,
            is_cancelled,
            &mut |_| {},
        )
    }

    pub fn preview_import_file_with_progress_and_cancellation<F, P>(
        &mut self,
        path: &Path,
        now_unix_ms: i64,
        is_cancelled: &F,
        on_progress: &mut P,
    ) -> AppResult<LearningImportPreview>
    where
        F: Fn() -> bool,
        P: FnMut(pack::ParseProgress),
    {
        import::ensure_import_not_cancelled(is_cancelled)?;
        let file_name = path
            .file_name()
            .and_then(|value| value.to_str())
            .unwrap_or_default();
        if file_name.ends_with(".yuanyuan-learning.json")
            || file_name.ends_with(".learning-pack.json")
        {
            return self.preview_generic_pack_file_with_cancellation(
                path,
                now_unix_ms,
                is_cancelled,
                on_progress,
            );
        }
        match path
            .extension()
            .and_then(|value| value.to_str())
            .map(str::to_ascii_lowercase)
            .as_deref()
        {
            Some("csv") => {
                let bytes = import::read_bounded_import_file_with_cancellation(path, is_cancelled)?;
                self.preview_csv_import_with_cancellation(&bytes, now_unix_ms, is_cancelled)
            }
            Some("json") => {
                let bytes = repository::portability::read_native_import_file(path)?;
                import::ensure_import_not_cancelled(is_cancelled)?;
                let preview = self.preview_native_json_import(&bytes, now_unix_ms)?;
                if let Err(error) = import::ensure_import_not_cancelled(is_cancelled) {
                    if let Some(token) = preview.preview_token.as_deref() {
                        self.pending_imports.remove(token);
                    }
                    return Err(error);
                }
                Ok(preview)
            }
            _ => Err(AppError::Validation(
                "learning import file type is unsupported".into(),
            )),
        }
    }

    pub fn preview_generic_pack_file_with_cancellation<F, P>(
        &mut self,
        path: &Path,
        now_unix_ms: i64,
        is_cancelled: &F,
        on_progress: &mut P,
    ) -> AppResult<LearningImportPreview>
    where
        F: Fn() -> bool,
        P: FnMut(pack::ParseProgress),
    {
        import::ensure_import_not_cancelled(is_cancelled)?;
        if now_unix_ms < 0 {
            return Err(AppError::Validation(
                "learning import is unavailable".into(),
            ));
        }
        self.ensure_repository()?;
        self.pending_imports
            .retain(|_, pending| pending.expires_at_unix_ms > now_unix_ms);
        if self.pending_imports.len() >= MAX_PENDING_IMPORT_PREVIEWS {
            return Err(AppError::Validation(
                "too many learning import previews are pending".into(),
            ));
        }
        let parsed =
            pack::parse_file_with_progress_and_cancellation(path, is_cancelled, on_progress)?;
        let (added_count, changed_count, disabled_count, reset_count) =
            self.ensure_repository()?.generic_pack_diff(&parsed)?;
        let expires_at_unix_ms = now_unix_ms
            .checked_add(IMPORT_PREVIEW_TTL_MILLIS)
            .ok_or_else(|| AppError::Validation("learning preview time overflowed".into()))?;
        let token = uuid::Uuid::new_v4().to_string();
        let preview = LearningImportPreview {
            schema_version: 1,
            status: "confirmation_required",
            preview_token: Some(token.clone()),
            expires_at_unix_ms: Some(expires_at_unix_ms),
            format: Some("learning_pack"),
            source_label: Some(parsed.title.clone()),
            card_count: parsed.cards.len() as u32,
            new_count: added_count,
            learning_count: 0,
            review_known_count: parsed.cards.len() as u32 - added_count,
            sample_headwords: parsed
                .cards
                .iter()
                .take(3)
                .map(|card| card.prompt.clone())
                .collect(),
            added_count,
            changed_count,
            disabled_count,
            reset_count,
            rights_basis: Some(parsed.rights_basis.clone()),
            rights_statement: Some(parsed.rights_statement.clone()),
            redistributable: Some(parsed.redistributable),
            source_details: parsed.sources.iter().map(|source| {
                [Some(source.label.clone()), source.url.clone(), source.license.clone()]
                    .into_iter().flatten().collect::<Vec<_>>().join(" · ")
            }).collect(),
            selected_path_returned: false,
        };
        self.pending_imports.insert(
            token.clone(),
            PendingImportPreview {
                expires_at_unix_ms,
                import: PendingLearningImport::GenericPack {
                    import: parsed,
                    source_path: path.to_path_buf(),
                },
            },
        );
        if let Err(error) = import::ensure_import_not_cancelled(is_cancelled) {
            self.pending_imports.remove(&token);
            return Err(error);
        }
        Ok(preview)
    }

    pub fn preview_native_json_import(
        &mut self,
        bytes: &[u8],
        now_unix_ms: i64,
    ) -> AppResult<LearningImportPreview> {
        if now_unix_ms < 0 {
            return Err(AppError::Validation(
                "learning import is unavailable".into(),
            ));
        }
        self.ensure_repository()?;
        self.pending_imports
            .retain(|_, pending| pending.expires_at_unix_ms > now_unix_ms);
        if self.pending_imports.len() >= MAX_PENDING_IMPORT_PREVIEWS {
            return Err(AppError::Validation(
                "too many learning import previews are pending".into(),
            ));
        }
        let import = repository::portability::parse_native_learning_export(bytes)?;
        let data = import.preview();
        let expires_at_unix_ms = now_unix_ms
            .checked_add(IMPORT_PREVIEW_TTL_MILLIS)
            .ok_or_else(|| AppError::Validation("learning preview time overflowed".into()))?;
        let token = uuid::Uuid::new_v4().to_string();
        let preview = LearningImportPreview {
            schema_version: 1,
            status: "confirmation_required",
            preview_token: Some(token.clone()),
            expires_at_unix_ms: Some(expires_at_unix_ms),
            format: Some("json"),
            source_label: Some("圆圆原生学习数据".into()),
            card_count: data.card_count,
            new_count: data.new_count,
            learning_count: data.learning_count,
            review_known_count: data.review_known_count,
            sample_headwords: data.sample_headwords,
            added_count: 0,
            changed_count: 0,
            disabled_count: 0,
            reset_count: 0,
            rights_basis: None,
            rights_statement: None,
            redistributable: None,
            source_details: Vec::new(),
            selected_path_returned: false,
        };
        self.pending_imports.insert(
            token,
            PendingImportPreview {
                expires_at_unix_ms,
                import: PendingLearningImport::NativeJson(import),
            },
        );
        Ok(preview)
    }

    #[allow(dead_code)]
    pub fn confirm_import(
        &mut self,
        preview_token: &str,
        now_unix_ms: i64,
    ) -> AppResult<ImportCommitResult> {
        self.confirm_import_with_cancellation(preview_token, now_unix_ms, &|| false)
    }

    pub fn confirm_import_with_cancellation<F>(
        &mut self,
        preview_token: &str,
        now_unix_ms: i64,
        is_cancelled: &F,
    ) -> AppResult<ImportCommitResult>
    where
        F: Fn() -> bool,
    {
        self.confirm_import_with_progress_and_cancellation(
            preview_token,
            now_unix_ms,
            is_cancelled,
            &mut |_| {},
        )
    }

    pub fn confirm_import_with_progress_and_cancellation<F, P>(
        &mut self,
        preview_token: &str,
        now_unix_ms: i64,
        is_cancelled: &F,
        on_progress: &mut P,
    ) -> AppResult<ImportCommitResult>
    where
        F: Fn() -> bool,
        P: FnMut(pack::ParseProgress),
    {
        import::ensure_import_not_cancelled(is_cancelled)?;
        if uuid::Uuid::parse_str(preview_token).is_err() || now_unix_ms < 0 {
            return Err(AppError::Validation(
                "learning import preview is invalid or expired".into(),
            ));
        }
        self.pending_imports
            .retain(|_, pending| pending.expires_at_unix_ms > now_unix_ms);
        let pending = self.pending_imports.remove(preview_token).ok_or_else(|| {
            AppError::Validation("learning import preview is invalid or expired".into())
        })?;
        import::ensure_import_not_cancelled(is_cancelled)?;
        let repository = self.ensure_repository()?;
        match pending.import {
            PendingLearningImport::Csv(import) => {
                repository.commit_user_import_with_cancellation(&import, now_unix_ms, is_cancelled)
            }
            PendingLearningImport::NativeJson(import) => repository
                .restore_native_export_with_cancellation(&import, now_unix_ms, is_cancelled),
            PendingLearningImport::GenericPack {
                import,
                source_path,
            } => {
                pack::verify_file_identity_with_progress_and_cancellation(
                    &source_path,
                    &import.file_sha256,
                    is_cancelled,
                    on_progress,
                )?;
                repository.commit_generic_pack_with_cancellation(&import, now_unix_ms, is_cancelled)
            }
        }
    }

    pub fn export_payload(
        &mut self,
        format: LearningExportFormat,
        now_unix_ms: i64,
    ) -> AppResult<repository::portability::LearningExportPayload> {
        self.ensure_repository()?
            .export_payload(format, now_unix_ms)
    }

    pub fn mark_export_succeeded(&mut self, now_unix_ms: i64) -> AppResult<()> {
        self.ensure_repository()?.mark_export_succeeded(now_unix_ms)
    }

    pub fn data_summary(&mut self) -> AppResult<LearningDataSummary> {
        self.ensure_repository()?.data_summary()
    }

    pub fn delete_data(
        &mut self,
        scope: LearningDeleteScope,
        confirmation: &str,
        now_unix_ms: i64,
    ) -> AppResult<LearningDeleteResult> {
        if confirmation != scope.confirmation() {
            return Err(AppError::Validation(
                "learning data deletion confirmation does not match".into(),
            ));
        }
        self.pending_imports.clear();
        self.pending_invitation = None;
        match scope {
            LearningDeleteScope::ProgressOnly => self
                .ensure_repository()?
                .clear_learning_progress(now_unix_ms),
            LearningDeleteScope::AllLearningData => {
                let review_count = self.data_summary()?.review_count;
                let path = self.database_path.clone().ok_or_else(|| {
                    AppError::Validation("learning database path is unavailable".into())
                })?;
                self.repository.take();
                let deletion = (|| -> AppResult<()> {
                    for suffix in ["-wal", "-shm"] {
                        let mut sidecar = path.as_os_str().to_os_string();
                        sidecar.push(suffix);
                        remove_file_if_present(Path::new(&sidecar))?;
                    }
                    remove_file_if_present(&path)
                })();
                *self = Self::initialize(&path);
                deletion?;
                if self.repository.is_none() {
                    return Err(AppError::Validation(
                        "learning database could not be recreated after deletion".into(),
                    ));
                }
                Ok(LearningDeleteResult {
                    schema_version: 1,
                    scope,
                    kept_card_count: 0,
                    deleted_review_count: review_count,
                })
            }
        }
    }

    pub fn home(&mut self, now_unix_ms: i64) -> AppResult<LearningHomeSnapshot> {
        let mut home = self.ensure_repository()?.learning_home(now_unix_ms)?;
        home.capabilities = self.capabilities();
        Ok(home)
    }

    pub fn update_settings(
        &mut self,
        patch: LearningSettingsPatch,
        now_unix_ms: i64,
    ) -> AppResult<LearningSettings> {
        self.ensure_repository()?
            .update_learning_settings(patch, now_unix_ms)
    }

    pub fn start_manual_session(
        &mut self,
        card_count: u8,
        session_kind: LearningSessionKind,
        source_session_id: Option<&str>,
        now_unix_ms: i64,
    ) -> AppResult<LearningSessionSnapshot> {
        self.ensure_repository()?.create_manual_session_scoped(
            card_count,
            session_kind,
            source_session_id,
            now_unix_ms,
        )
    }

    pub fn dashboard(&mut self, now_unix_ms: i64) -> AppResult<LearningDashboardSnapshot> {
        self.ensure_repository()?.learning_dashboard(now_unix_ms)
    }

    pub fn current_card(&mut self, session_id: &str) -> AppResult<LearningCardDto> {
        self.ensure_repository()?.current_learning_card(session_id)
    }

    pub fn current_question(&mut self, session_id: &str) -> AppResult<LearningQuestionDto> {
        self.ensure_repository()?
            .current_learning_question(session_id)
    }

    pub fn session_summary(
        &mut self,
        session_id: &str,
        now_unix_ms: i64,
    ) -> AppResult<LearningSessionSummary> {
        self.ensure_repository()?
            .learning_session_summary(session_id, now_unix_ms)
    }

    pub fn completed_session(
        &mut self,
        session_id: &str,
        expected_revision: u64,
    ) -> AppResult<LearningSessionSnapshot> {
        self.ensure_repository()?
            .completed_learning_session(session_id, expected_revision)
    }

    pub fn answer_question(
        &mut self,
        session_id: &str,
        question_id: &str,
        selected_option_id: &str,
        client_answer_id: &str,
        response_ms: Option<u32>,
        now_unix_ms: i64,
    ) -> AppResult<LearningAnswerResult> {
        self.ensure_repository()?.answer_learning_question(
            session_id,
            question_id,
            selected_option_id,
            client_answer_id,
            response_ms,
            now_unix_ms,
        )
    }

    pub fn list_records(
        &mut self,
        filter: LearningRecordFilter,
        query: &str,
        page: u32,
        page_size: u8,
    ) -> AppResult<LearningRecordPage> {
        self.ensure_repository()?
            .list_learning_records(filter, query, page, page_size)
    }

    pub fn rate_card(
        &mut self,
        session_id: &str,
        card_id: &str,
        rating: LearningRating,
        expected_revision: u64,
        now_unix_ms: i64,
    ) -> AppResult<LearningRateResult> {
        self.ensure_repository()?.rate_learning_card_with_revision(
            session_id,
            card_id,
            rating,
            expected_revision,
            now_unix_ms,
        )
    }

    pub fn present_session(
        &mut self,
        session_id: &str,
        expected_revision: u64,
        now_unix_ms: i64,
    ) -> AppResult<LearningSessionSnapshot> {
        self.ensure_repository()?.present_learning_session(
            session_id,
            expected_revision,
            now_unix_ms,
        )
    }

    pub fn pause_session(
        &mut self,
        session_id: &str,
        expected_revision: u64,
        reason: &str,
        now_unix_ms: i64,
    ) -> AppResult<LearningSessionSnapshot> {
        self.ensure_repository()?.pause_learning_session(
            session_id,
            expected_revision,
            reason,
            now_unix_ms,
        )
    }

    pub fn resume_session(
        &mut self,
        session_id: &str,
        expected_revision: u64,
        now_unix_ms: i64,
    ) -> AppResult<LearningSessionSnapshot> {
        self.present_session(session_id, expected_revision, now_unix_ms)
    }

    pub fn abandon_session(
        &mut self,
        session_id: &str,
        expected_revision: u64,
        reason: &str,
        now_unix_ms: i64,
    ) -> AppResult<LearningSessionSnapshot> {
        self.ensure_repository()?.abandon_learning_session(
            session_id,
            expected_revision,
            reason,
            now_unix_ms,
        )
    }

    pub fn resumable_session(
        &mut self,
        now_unix_ms: i64,
    ) -> AppResult<Option<LearningSessionSnapshot>> {
        self.ensure_repository()?
            .get_resumable_learning_session(now_unix_ms)
    }

    #[cfg(test)]
    pub fn finish_session(
        &mut self,
        session_id: &str,
        exit_reason: &str,
        now_unix_ms: i64,
    ) -> AppResult<LearningSessionSnapshot> {
        self.ensure_repository()?
            .finish_learning_session(session_id, exit_reason, now_unix_ms)
    }

    pub fn invitation_context(
        &self,
        trigger_source: LearningTriggerSource,
        environment: LearningInvitationEnvironment,
        now_unix_ms: i64,
        local_day: &str,
    ) -> AppResult<LearningInvitationContext> {
        let repository = self
            .repository
            .as_ref()
            .ok_or_else(|| AppError::Validation("learning is unavailable".into()))?;
        let data = repository.invitation_data(now_unix_ms, local_day)?;
        let source_enabled = match trigger_source {
            LearningTriggerSource::FocusFinished => data.focus_finished_enabled,
            LearningTriggerSource::ScheduledWindow => data.scheduled_windows_enabled,
            LearningTriggerSource::WorkGapExperimental => data.work_gap_experimental_enabled,
        };
        Ok(LearningInvitationContext {
            trigger_source,
            now_unix_ms,
            learning_available: true,
            learning_mode: data.learning_mode,
            due_review_count: data.due_review_count,
            source_enabled,
            timing_valid: environment.timing_valid,
            focus_or_break_active: environment.focus_or_break_active,
            quiet_time: environment.quiet_time,
            paused_today: data.paused_today,
            basic_support_active: environment.basic_support_active,
            session_interactive: environment.session_interactive,
            system_suitability: environment.system_suitability,
            pending_local_reminder: environment.pending_local_reminder,
            task_attention_pending: environment.task_attention_pending,
            global_budget_available: environment.global_budget_available,
            invitations_presented_today: data.invitations_presented_today,
            daily_invitation_limit: data.daily_invitation_limit,
            last_invitation_at_unix_ms: data.last_invitation_at_unix_ms,
            invitation_cooldown_minutes: data.invitation_cooldown_minutes,
            content_and_database_healthy: environment.content_and_database_healthy,
        })
    }

    pub fn evaluate_invitation(
        &self,
        context: &LearningInvitationContext,
    ) -> LearningInvitationDecision {
        evaluate_learning_invitation(context)
    }

    pub fn record_invitation_event(
        &mut self,
        invitation_id: &str,
        trigger_source: LearningTriggerSource,
        stage: &str,
        reason: Option<LearningSuppressionReason>,
        now_unix_ms: i64,
    ) -> AppResult<()> {
        self.ensure_repository()?.record_invitation_event(
            invitation_id,
            trigger_source,
            stage,
            reason,
            now_unix_ms,
        )
    }

    pub fn begin_invitation(
        &mut self,
        invitation_id: String,
        trigger_source: LearningTriggerSource,
        due_review_count: u32,
        now_unix_ms: i64,
    ) -> AppResult<LearningInvitationDto> {
        if self
            .pending_invitation
            .as_ref()
            .is_some_and(|pending| pending.expires_at_unix_ms > now_unix_ms)
        {
            return Err(AppError::Validation(
                "a learning invitation is already visible".into(),
            ));
        }
        let expires_at_unix_ms = now_unix_ms
            .checked_add(LEARNING_INVITATION_TTL_MILLIS)
            .ok_or_else(|| AppError::Time("learning invitation expiry overflowed".into()))?;
        self.pending_invitation = Some(PendingLearningInvitation {
            invitation_id: invitation_id.clone(),
            trigger_source,
            expires_at_unix_ms,
            due_review_count,
        });
        Ok(LearningInvitationDto {
            schema_version: 1,
            invitation_id,
            trigger_source,
            expires_at_unix_ms,
            due_review_count,
        })
    }

    pub fn withdraw_invitation(
        &mut self,
        invitation_id: &str,
        stage: &str,
        reason: Option<LearningSuppressionReason>,
        now_unix_ms: i64,
    ) -> AppResult<bool> {
        let Some(pending) = self.pending_invitation.take() else {
            return Ok(false);
        };
        if pending.invitation_id != invitation_id {
            self.pending_invitation = Some(pending);
            return Ok(false);
        }
        self.record_invitation_event(
            invitation_id,
            pending.trigger_source,
            stage,
            reason,
            now_unix_ms,
        )?;
        Ok(true)
    }

    pub fn accept_invitation(
        &mut self,
        invitation_id: &str,
        now_unix_ms: i64,
    ) -> AppResult<LearningSessionSnapshot> {
        let pending = self.pending_invitation.take().ok_or_else(|| {
            AppError::Validation("learning invitation is invalid or expired".into())
        })?;
        if pending.invitation_id != invitation_id {
            self.pending_invitation = Some(pending);
            return Err(AppError::Validation(
                "learning invitation is invalid or expired".into(),
            ));
        }
        if pending.expires_at_unix_ms <= now_unix_ms {
            let _ = self.record_invitation_event(
                &pending.invitation_id,
                pending.trigger_source,
                "ignored",
                None,
                now_unix_ms,
            );
            return Err(AppError::Validation(
                "learning invitation is invalid or expired".into(),
            ));
        }
        let repository = self.ensure_repository()?;
        let result =
            repository.start_invitation_session(invitation_id, pending.trigger_source, now_unix_ms);
        if result.is_err() {
            self.pending_invitation = Some(pending);
        }
        result
    }

    pub fn pause_invitations_today(
        &mut self,
        local_day: &str,
        now_unix_ms: i64,
    ) -> AppResult<LearningSettings> {
        self.ensure_repository()?
            .pause_invitations_for_day(local_day, now_unix_ms)
    }

    pub fn pending_invitation(&self) -> Option<LearningInvitationDto> {
        self.pending_invitation
            .as_ref()
            .map(|pending| LearningInvitationDto {
                schema_version: 1,
                invitation_id: pending.invitation_id.clone(),
                trigger_source: pending.trigger_source,
                expires_at_unix_ms: pending.expires_at_unix_ms,
                due_review_count: pending.due_review_count,
            })
    }

    pub fn interrupt_active_session(
        &mut self,
        now_unix_ms: i64,
    ) -> AppResult<Option<LearningSessionSnapshot>> {
        self.ensure_repository()?
            .interrupt_active_session(now_unix_ms)
    }
}

fn remove_file_if_present(path: &Path) -> AppResult<()> {
    match std::fs::remove_file(path) {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(error.into()),
    }
}

#[cfg(test)]
mod tests {
    use tempfile::tempdir;

    use super::*;

    #[test]
    fn suppressed_invitation_returns_and_releases_learning_for_the_next_tick() {
        let (sender, receiver) = std::sync::mpsc::channel();
        std::thread::spawn(move || {
            let directory = tempdir().unwrap();
            let path = directory.path().join("learning.sqlite3");
            let runtime = parking_lot::Mutex::new(LearningRuntime::initialize(&path));
            let context = runtime
                .lock()
                .invitation_context(
                    LearningTriggerSource::FocusFinished,
                    LearningInvitationEnvironment {
                        focus_or_break_active: false,
                        quiet_time: false,
                        basic_support_active: false,
                        session_interactive: true,
                        system_suitability:
                            invitation::SystemNotificationSuitability::AcceptsNotifications,
                        pending_local_reminder: false,
                        task_attention_pending: false,
                        global_budget_available: true,
                        content_and_database_healthy: false,
                        timing_valid: true,
                    },
                    1_800_000_000_000,
                    "2027-01-15",
                )
                .unwrap();
            let invitation_id = uuid::Uuid::new_v4().to_string();
            assert!(record_invitation_suppression(&runtime, &context, &invitation_id).unwrap());
            assert!(
                runtime.try_lock().is_some(),
                "learning lock leaked after suppression"
            );
            assert!(runtime.lock().home(context.now_unix_ms + 15_000).is_ok());
            let connection = rusqlite::Connection::open_with_flags(
                &path,
                rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY,
            )
            .unwrap();
            let event: (String, String) = connection.query_row(
                "SELECT stage, reason_code FROM learning_invitation_events WHERE invitation_id = ?1",
                [&invitation_id],
                |row| Ok((row.get(0)?, row.get(1)?)),
            ).unwrap();
            assert_eq!(event, ("suppressed".into(), "manual_only".into()));
            sender.send(()).unwrap();
        });
        receiver
            .recv_timeout(std::time::Duration::from_secs(10))
            .expect("focus-finished suppression blocked the scheduler and learning reads");
    }

    fn invitation_test_context(
        runtime: &parking_lot::Mutex<LearningRuntime>,
    ) -> LearningInvitationContext {
        runtime
            .lock()
            .invitation_context(
                LearningTriggerSource::FocusFinished,
                LearningInvitationEnvironment {
                    focus_or_break_active: false,
                    quiet_time: false,
                    basic_support_active: false,
                    session_interactive: true,
                    system_suitability:
                        invitation::SystemNotificationSuitability::AcceptsNotifications,
                    pending_local_reminder: false,
                    task_attention_pending: false,
                    global_budget_available: true,
                    content_and_database_healthy: true,
                    timing_valid: true,
                },
                1_800_000_000_000,
                "2027-01-15",
            )
            .unwrap()
    }

    #[test]
    fn invitation_suppression_rechecks_the_latest_context_without_leaking_a_lock() {
        let directory = tempdir().unwrap();
        let path = directory.path().join("learning.sqlite3");
        let runtime = parking_lot::Mutex::new(LearningRuntime::initialize(&path));
        let mut context = invitation_test_context(&runtime);
        context.learning_mode = models::LearningMode::AutomaticOptIn;
        context.due_review_count = 3;
        context.source_enabled = true;
        let eligible_id = uuid::Uuid::new_v4().to_string();
        let suppressed_id = uuid::Uuid::new_v4().to_string();
        assert!(!record_invitation_suppression(&runtime, &context, &eligible_id).unwrap());
        assert!(runtime.try_lock().is_some());
        context.pending_local_reminder = true;
        assert!(record_invitation_suppression(&runtime, &context, &suppressed_id).unwrap());
        assert!(runtime.try_lock().is_some());
        let connection = rusqlite::Connection::open_with_flags(
            &path,
            rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY,
        )
        .unwrap();
        let events: Vec<(String, String)> = connection.prepare(
            "SELECT invitation_id, reason_code FROM learning_invitation_events ORDER BY occurred_at_unix_ms"
        ).unwrap().query_map([], |row| Ok((row.get(0)?, row.get(1)?))).unwrap()
            .collect::<Result<_, _>>().unwrap();
        assert_eq!(events, vec![(suppressed_id, "reminder_pending".into())]);
    }

    #[test]
    fn failed_invitation_suppression_write_releases_learning_and_allows_retry() {
        let directory = tempdir().unwrap();
        let path = directory.path().join("learning.sqlite3");
        let runtime = parking_lot::Mutex::new(LearningRuntime::initialize(&path));
        let context = invitation_test_context(&runtime);
        let connection = rusqlite::Connection::open(&path).unwrap();
        connection.execute_batch(
            "CREATE TRIGGER fail_suppression BEFORE INSERT ON learning_invitation_events
             WHEN NEW.stage = 'suppressed' BEGIN SELECT RAISE(FAIL, 'injected suppression failure'); END;"
        ).unwrap();
        let invitation_id = uuid::Uuid::new_v4().to_string();
        let error = record_invitation_suppression(&runtime, &context, &invitation_id).unwrap_err();
        assert!(error.to_string().contains("injected suppression failure"));
        assert!(runtime.try_lock().is_some());
        assert!(runtime.lock().home(context.now_unix_ms + 15_000).is_ok());
        connection
            .execute_batch("DROP TRIGGER fail_suppression")
            .unwrap();
        assert!(record_invitation_suppression(&runtime, &context, &invitation_id).unwrap());
        let count: i64 = connection
            .query_row(
                "SELECT COUNT(*) FROM learning_invitation_events",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(count, 1);
    }

    #[test]
    fn configured_runtime_defers_database_creation_until_first_learning_use() {
        let directory = tempdir().unwrap();
        let path = directory
            .path()
            .join("learning-data")
            .join("learning.sqlite3");
        let mut runtime = LearningRuntime::configured(&path);

        assert!(!path.exists());
        assert!(!path.parent().unwrap().exists());
        assert!(!runtime.automatic_invitation_state_loaded());
        assert_eq!(
            runtime.capabilities(),
            LearningCapabilities {
                compiled: true,
                available: true,
                content_pack_ready: false,
                auto_invitation_available: false,
                failure_reason: None,
            }
        );

        let home = runtime.home(1_000).unwrap();
        assert!(path.exists());
        assert!(runtime.automatic_invitation_state_loaded());
        assert!(home.capabilities.available);
        assert!(!home.capabilities.content_pack_ready);
        assert!(!home.capabilities.auto_invitation_available);
        assert_eq!(home.settings.mode, models::LearningMode::ManualOnly);
    }

    #[test]
    fn configured_runtime_opens_existing_database_without_changing_identity() {
        let directory = tempdir().unwrap();
        let path = directory.path().join("learning.sqlite3");
        drop(LearningRuntime::initialize(&path));

        let runtime = LearningRuntime::configured(&path);

        assert!(runtime.automatic_invitation_state_loaded());
        assert!(runtime.capabilities().available);
    }

    #[test]
    fn corrupt_existing_database_fails_learning_closed() {
        let directory = tempdir().unwrap();
        let path = directory.path().join("learning.sqlite3");
        std::fs::write(&path, b"not a sqlite database").unwrap();

        let runtime = LearningRuntime::configured(&path);

        assert!(!runtime.automatic_invitation_state_loaded());
        assert_eq!(
            runtime.capabilities().failure_reason.as_deref(),
            Some("database")
        );
    }

    #[test]
    fn runtime_becomes_available_without_claiming_content_or_auto_invites() {
        let directory = tempdir().unwrap();
        let runtime = LearningRuntime::initialize(&directory.path().join("learning.sqlite3"));
        assert_eq!(
            runtime.capabilities(),
            LearningCapabilities {
                compiled: true,
                available: true,
                content_pack_ready: false,
                auto_invitation_available: false,
                failure_reason: None,
            }
        );
    }

    #[test]
    fn import_preview_is_zero_write_and_confirm_token_is_single_use() {
        let directory = tempdir().unwrap();
        let mut runtime = LearningRuntime::initialize(&directory.path().join("learning.sqlite3"));
        let preview = runtime
            .preview_csv_import(
                "headword,meanings_zh,progress_hint\nword,单词,review_known\n".as_bytes(),
                1_000,
            )
            .unwrap();
        assert_eq!(preview.status, "confirmation_required");
        assert_eq!(preview.review_known_count, 1);
        assert!(!runtime.capabilities().content_pack_ready);
        let token = preview.preview_token.unwrap();
        let committed = runtime.confirm_import(&token, 2_000).unwrap();
        assert_eq!(committed.imported_count, 1);
        assert!(runtime.capabilities().content_pack_ready);
        assert!(runtime.confirm_import(&token, 3_000).is_err());
    }

    #[test]
    fn import_preview_expires_and_capacity_is_bounded() {
        let directory = tempdir().unwrap();
        let mut runtime = LearningRuntime::initialize(&directory.path().join("learning.sqlite3"));
        let bytes = "headword,meanings_zh\nword,单词\n".as_bytes();
        let expired = runtime.preview_csv_import(bytes, 1_000).unwrap();
        assert!(runtime
            .confirm_import(
                expired.preview_token.as_deref().unwrap(),
                1_000 + IMPORT_PREVIEW_TTL_MILLIS,
            )
            .is_err());
        for _ in 0..MAX_PENDING_IMPORT_PREVIEWS {
            runtime.preview_csv_import(bytes, 2_000).unwrap();
        }
        assert!(runtime.preview_csv_import(bytes, 2_000).is_err());
    }

    #[test]
    fn native_json_preview_is_zero_write_and_confirm_restores_content() {
        let directory = tempdir().unwrap();
        let mut source = LearningRuntime::initialize(&directory.path().join("source.sqlite3"));
        let preview = source
            .preview_csv_import("headword,meanings_zh\nword,meaning\n".as_bytes(), 1_000)
            .unwrap();
        source
            .confirm_import(preview.preview_token.as_deref().unwrap(), 2_000)
            .unwrap();
        let payload = source
            .export_payload(LearningExportFormat::NativeJson, 3_000)
            .unwrap();

        let mut target = LearningRuntime::initialize(&directory.path().join("target.sqlite3"));
        let preview = target
            .preview_native_json_import(&payload.bytes, 4_000)
            .unwrap();
        assert_eq!(preview.format, Some("json"));
        assert_eq!(preview.card_count, 1);
        assert!(!target.capabilities().content_pack_ready);
        target
            .confirm_import(preview.preview_token.as_deref().unwrap(), 5_000)
            .unwrap();
        assert!(target.capabilities().content_pack_ready);
    }

    #[test]
    fn cancelled_native_restore_rolls_back_the_existing_learning_database() {
        use std::cell::Cell;

        let directory = tempdir().unwrap();
        let mut source = LearningRuntime::initialize(&directory.path().join("source.sqlite3"));
        let preview = source
            .preview_csv_import(
                "headword,meanings_zh\nalpha,甲\nbeta,乙\ngamma,丙\n".as_bytes(),
                1_000,
            )
            .unwrap();
        source
            .confirm_import(preview.preview_token.as_deref().unwrap(), 2_000)
            .unwrap();
        let payload = source
            .export_payload(LearningExportFormat::NativeJson, 3_000)
            .unwrap();

        let mut target = LearningRuntime::initialize(&directory.path().join("target.sqlite3"));
        let baseline = target
            .preview_csv_import("headword,meanings_zh\nbaseline,原内容\n".as_bytes(), 4_000)
            .unwrap();
        target
            .confirm_import(baseline.preview_token.as_deref().unwrap(), 5_000)
            .unwrap();
        let restore = target
            .preview_native_json_import(&payload.bytes, 6_000)
            .unwrap();
        let checks = Cell::new(0_u32);
        let error = target
            .confirm_import_with_cancellation(
                restore.preview_token.as_deref().unwrap(),
                7_000,
                &|| {
                    checks.set(checks.get() + 1);
                    checks.get() >= 8
                },
            )
            .unwrap_err();

        assert!(error.to_string().contains("learning import was cancelled"));
        let summary = target.data_summary().unwrap();
        assert_eq!(summary.card_count, 1);
        assert_eq!(summary.packs.len(), 1);
        assert_eq!(summary.packs[0].title, "用户导入");
    }

    #[test]
    fn cancelled_preview_does_not_leave_an_unreachable_pending_token() {
        use std::cell::Cell;

        let directory = tempdir().unwrap();
        let mut runtime = LearningRuntime::initialize(&directory.path().join("learning.sqlite3"));
        let csv_checks = Cell::new(0_u32);
        let error = runtime
            .preview_csv_import_with_cancellation(
                "headword,meanings_zh\nword,含义\n".as_bytes(),
                1_000,
                &|| {
                    csv_checks.set(csv_checks.get() + 1);
                    csv_checks.get() >= 5
                },
            )
            .unwrap_err();
        assert!(error.to_string().contains("learning import was cancelled"));
        assert!(runtime.pending_imports.is_empty());

        let mut source = LearningRuntime::initialize(&directory.path().join("source.sqlite3"));
        let source_preview = source
            .preview_csv_import("headword,meanings_zh\nsource,原生含义\n".as_bytes(), 2_000)
            .unwrap();
        source
            .confirm_import(source_preview.preview_token.as_deref().unwrap(), 3_000)
            .unwrap();
        let payload = source
            .export_payload(LearningExportFormat::NativeJson, 4_000)
            .unwrap();
        let native_path = directory.path().join("learning.json");
        std::fs::write(&native_path, payload.bytes).unwrap();
        let native_checks = Cell::new(0_u32);
        let error = runtime
            .preview_import_file_with_cancellation(&native_path, 5_000, &|| {
                native_checks.set(native_checks.get() + 1);
                native_checks.get() >= 3
            })
            .unwrap_err();
        assert!(error.to_string().contains("learning import was cancelled"));
        assert!(runtime.pending_imports.is_empty());
    }

    #[test]
    fn full_learning_delete_requires_exact_confirmation_and_recreates_empty_database() {
        let directory = tempdir().unwrap();
        let path = directory.path().join("learning.sqlite3");
        let mut runtime = LearningRuntime::initialize(&path);
        let preview = runtime
            .preview_csv_import("headword,meanings_zh\nword,meaning\n".as_bytes(), 1_000)
            .unwrap();
        runtime
            .confirm_import(preview.preview_token.as_deref().unwrap(), 2_000)
            .unwrap();
        assert!(runtime
            .delete_data(LearningDeleteScope::AllLearningData, "delete", 3_000,)
            .is_err());
        assert!(runtime.capabilities().content_pack_ready);

        let deleted = runtime
            .delete_data(
                LearningDeleteScope::AllLearningData,
                LearningDeleteScope::AllLearningData.confirmation(),
                4_000,
            )
            .unwrap();
        assert_eq!(deleted.kept_card_count, 0);
        assert!(path.exists());
        assert!(runtime.capabilities().available);
        assert!(!runtime.capabilities().content_pack_ready);
    }

    #[test]
    fn forged_expired_and_replayed_invitation_acceptance_fail_closed() {
        let directory = tempdir().unwrap();
        let mut runtime = LearningRuntime::initialize(&directory.path().join("learning.sqlite3"));
        let preview = runtime
            .preview_csv_import(
                "headword,meanings_zh,progress_hint\nreview,meaning,learning\n".as_bytes(),
                1_000,
            )
            .unwrap();
        runtime
            .confirm_import(preview.preview_token.as_deref().unwrap(), 2_000)
            .unwrap();
        let invitation_id = uuid::Uuid::new_v4().to_string();
        runtime
            .begin_invitation(
                invitation_id.clone(),
                LearningTriggerSource::FocusFinished,
                1,
                3_000,
            )
            .unwrap();
        assert!(runtime
            .accept_invitation(&uuid::Uuid::new_v4().to_string(), 3_001)
            .is_err());
        assert_eq!(
            runtime.pending_invitation().unwrap().invitation_id,
            invitation_id
        );
        let session = runtime.accept_invitation(&invitation_id, 3_002).unwrap();
        assert_eq!(session.status, "created");
        assert!(runtime.accept_invitation(&invitation_id, 3_003).is_err());

        runtime
            .finish_session(&session.session_id, "user_exit", 3_004)
            .unwrap();
        let expired_id = uuid::Uuid::new_v4().to_string();
        let expired = runtime
            .begin_invitation(
                expired_id.clone(),
                LearningTriggerSource::FocusFinished,
                1,
                4_000,
            )
            .unwrap();
        assert!(runtime
            .accept_invitation(&expired_id, expired.expires_at_unix_ms)
            .is_err());
        assert!(runtime.pending_invitation().is_none());
    }

    fn write_generic_pack(path: &Path, version: &str, cards: serde_json::Value) {
        use sha2::{Digest, Sha256};

        let mut value = serde_json::json!({
            "schemaVersion": 1,
            "packId": "test.generic",
            "version": version,
            "title": "Generic test",
            "description": "Synthetic",
            "rights": {
                "basis": "self_authored",
                "statement": "Synthetic test content",
                "redistributable": true
            },
            "sources": [{ "sourceRef": "notes", "label": "Synthetic notes" }],
            "contentSha256": "",
            "cards": cards
        });
        let mut canonical = value.clone();
        canonical.as_object_mut().unwrap().remove("contentSha256");
        let digest = format!(
            "{:x}",
            Sha256::digest(pack::canonical_json(&canonical).as_bytes())
        );
        value["contentSha256"] = serde_json::Value::String(digest);
        std::fs::write(path, serde_json::to_vec_pretty(&value).unwrap()).unwrap();
    }

    #[test]
    fn generic_pack_preview_update_and_disable_are_atomic_and_diffed() {
        let directory = tempdir().unwrap();
        let database = directory.path().join("learning.sqlite3");
        let pack_path = directory.path().join("test.learning-pack.json");
        let mut runtime = LearningRuntime::initialize(&database);

        write_generic_pack(
            &pack_path,
            "1.0.0",
            serde_json::json!([{
                "cardId": "c1",
                "exerciseKind": "choice",
                "prompt": "Question one",
                "answer": "Answer one",
                "choices": ["Answer one", "Other"],
                "sourceRefs": ["notes"],
                "scheduleEpoch": 1
            }]),
        );
        let preview = runtime.preview_import_file(&pack_path, 1_000).unwrap();
        assert_eq!(preview.format, Some("learning_pack"));
        assert_eq!(
            (
                preview.added_count,
                preview.changed_count,
                preview.disabled_count,
                preview.reset_count
            ),
            (1, 0, 0, 0)
        );
        runtime
            .confirm_import(preview.preview_token.as_deref().unwrap(), 2_000)
            .unwrap();

        write_generic_pack(
            &pack_path,
            "1.1.0",
            serde_json::json!([
                {
                    "cardId": "c1",
                    "exerciseKind": "recall",
                    "prompt": "Question one updated",
                    "answer": "Answer one changed",
                    "sourceRefs": ["notes"],
                    "scheduleEpoch": 1
                },
                {
                    "cardId": "c2",
                    "exerciseKind": "recall",
                    "prompt": "Question two",
                    "answer": "Answer two",
                    "sourceRefs": ["notes"],
                    "scheduleEpoch": 1
                }
            ]),
        );
        let preview = runtime.preview_import_file(&pack_path, 3_000).unwrap();
        assert_eq!(
            (
                preview.added_count,
                preview.changed_count,
                preview.disabled_count,
                preview.reset_count
            ),
            (1, 1, 0, 1)
        );
        runtime
            .confirm_import(preview.preview_token.as_deref().unwrap(), 4_000)
            .unwrap();

        write_generic_pack(
            &pack_path,
            "1.2.0",
            serde_json::json!([{
                "cardId": "c2",
                "exerciseKind": "recall",
                "prompt": "Question two",
                "answer": "Answer two",
                "sourceRefs": ["notes"],
                "scheduleEpoch": 1
            }]),
        );
        let preview = runtime.preview_import_file(&pack_path, 5_000).unwrap();
        assert_eq!(
            (
                preview.added_count,
                preview.changed_count,
                preview.disabled_count,
                preview.reset_count
            ),
            (0, 0, 1, 0)
        );
        runtime
            .confirm_import(preview.preview_token.as_deref().unwrap(), 6_000)
            .unwrap();
        assert_eq!(runtime.data_summary().unwrap().card_count, 2);
    }

    #[test]
    fn generic_pack_confirmation_rejects_file_replacement_without_live_writes() {
        let directory = tempdir().unwrap();
        let database = directory.path().join("learning.sqlite3");
        let pack_path = directory.path().join("test.learning-pack.json");
        let mut runtime = LearningRuntime::initialize(&database);

        write_generic_pack(
            &pack_path,
            "1.0.0",
            serde_json::json!([{
                "cardId": "c1",
                "exerciseKind": "recall",
                "prompt": "Original question",
                "answer": "Original answer",
                "sourceRefs": ["notes"],
                "scheduleEpoch": 1
            }]),
        );
        let preview = runtime.preview_import_file(&pack_path, 1_000).unwrap();
        let token = preview.preview_token.unwrap();

        write_generic_pack(
            &pack_path,
            "1.0.1",
            serde_json::json!([{
                "cardId": "c1",
                "exerciseKind": "recall",
                "prompt": "Replacement question",
                "answer": "Replacement answer",
                "sourceRefs": ["notes"],
                "scheduleEpoch": 1
            }]),
        );

        let error = runtime.confirm_import(&token, 2_000).unwrap_err();
        assert!(error.to_string().contains("file changed after preview"));
        assert_eq!(runtime.data_summary().unwrap().card_count, 0);
        assert!(runtime.confirm_import(&token, 3_000).is_err());
    }

    #[test]
    fn generic_pack_schedule_epoch_resets_only_the_requested_card() {
        let directory = tempdir().unwrap();
        let database = directory.path().join("learning.sqlite3");
        let pack_path = directory.path().join("test.learning-pack.json");
        let mut runtime = LearningRuntime::initialize(&database);

        let cards = serde_json::json!([
            {
                "cardId": "c1",
                "exerciseKind": "recall",
                "prompt": "Question one",
                "answer": "Answer one",
                "sourceRefs": ["notes"],
                "scheduleEpoch": 1
            },
            {
                "cardId": "c2",
                "exerciseKind": "recall",
                "prompt": "Question two",
                "answer": "Answer two",
                "sourceRefs": ["notes"],
                "scheduleEpoch": 1
            }
        ]);
        write_generic_pack(&pack_path, "1.0.0", cards.clone());
        let preview = runtime.preview_import_file(&pack_path, 1_000).unwrap();
        runtime
            .confirm_import(preview.preview_token.as_deref().unwrap(), 2_000)
            .unwrap();
        runtime
            .repository
            .as_ref()
            .unwrap()
            .connection()
            .execute(
                "UPDATE card_schedule
                 SET stage = 'stable', due_at_unix_ms = 90000, stability = 3.5,
                     difficulty = 5.2, reps = 3, lapses = 0,
                     last_review_at_unix_ms = 80000",
                [],
            )
            .unwrap();

        let mut updated_cards = cards.as_array().unwrap().clone();
        updated_cards[1]["scheduleEpoch"] = serde_json::json!(2);
        write_generic_pack(&pack_path, "1.1.0", serde_json::Value::Array(updated_cards));
        let preview = runtime.preview_import_file(&pack_path, 3_000).unwrap();
        assert_eq!(
            (
                preview.added_count,
                preview.changed_count,
                preview.disabled_count,
                preview.reset_count
            ),
            (0, 1, 0, 1)
        );
        let committed = runtime
            .confirm_import(preview.preview_token.as_deref().unwrap(), 4_000)
            .unwrap();
        assert_eq!(committed.preserved_schedule_count, 1);

        let schedules = runtime
            .repository
            .as_ref()
            .unwrap()
            .connection()
            .prepare(
                "SELECT c.external_card_id, s.stage, s.due_at_unix_ms, s.reps
                 FROM learning_cards c JOIN card_schedule s USING(card_id)
                 WHERE c.pack_id = 'test.generic'
                 ORDER BY c.external_card_id",
            )
            .unwrap()
            .query_map([], |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, i64>(2)?,
                    row.get::<_, i64>(3)?,
                ))
            })
            .unwrap()
            .collect::<Result<Vec<_>, _>>()
            .unwrap();
        assert_eq!(
            schedules,
            vec![
                ("c1".into(), "stable".into(), 90_000, 3),
                ("c2".into(), "new".into(), 4_000, 0),
            ]
        );

        let regressed_cards = cards.as_array().unwrap().clone();
        write_generic_pack(
            &pack_path,
            "1.2.0",
            serde_json::Value::Array(regressed_cards),
        );
        let error = runtime.preview_import_file(&pack_path, 5_000).unwrap_err();
        assert!(error.to_string().contains("scheduleEpoch cannot decrease"));
        let regressed_import =
            pack::parse_file_with_progress_and_cancellation(&pack_path, &|| false, &mut |_| {})
                .unwrap();
        let error = runtime
            .repository
            .as_mut()
            .unwrap()
            .commit_generic_pack_with_cancellation(&regressed_import, 6_000, &|| false)
            .unwrap_err();
        assert!(error.to_string().contains("scheduleEpoch cannot decrease"));
        let stored_epoch: u32 = runtime
            .repository
            .as_ref()
            .unwrap()
            .connection()
            .query_row(
                "SELECT schedule_epoch FROM learning_cards
                 WHERE pack_id = 'test.generic' AND external_card_id = 'c2'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(stored_epoch, 2);
    }
}
