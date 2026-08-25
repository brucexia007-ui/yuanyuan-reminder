mod import;
mod invitation;
mod models;
mod quiz;
mod repository;
mod scheduler_adapter;
#[cfg(windows)]
mod windows_suitability;
#[cfg(windows)]
pub(crate) use windows_suitability::current_system_suitability;

use std::{
    collections::BTreeMap,
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
use repository::portability::NativeLearningExport;
pub(crate) use repository::portability::{
    write_new_file_atomically, LearningDataSummary, LearningDeleteResult, LearningDeleteScope,
    LearningExportFormat, LearningExportResult,
};

const IMPORT_PREVIEW_TTL_MILLIS: i64 = 10 * 60 * 1_000;
const MAX_PENDING_IMPORT_PREVIEWS: usize = 8;
const LEARNING_INVITATION_TTL_MILLIS: i64 = 20_000;

struct PendingImportPreview {
    expires_at_unix_ms: i64,
    import: PendingLearningImport,
}

enum PendingLearningImport {
    Csv(ParsedUserImport),
    NativeJson(NativeLearningExport),
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
    pending_invitation: Option<PendingLearningInvitation>,
}

impl Default for LearningRuntime {
    fn default() -> Self {
        Self {
            repository: None,
            database_path: None,
            initialization_failed: false,
            pending_imports: BTreeMap::new(),
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

    pub fn preview_csv_import(
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
        let import = import::parse_user_csv(bytes)?;
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
            selected_path_returned: false,
        };
        self.pending_imports.insert(
            token,
            PendingImportPreview {
                expires_at_unix_ms,
                import: PendingLearningImport::Csv(import),
            },
        );
        Ok(preview)
    }

    pub fn preview_import_file(
        &mut self,
        path: &Path,
        now_unix_ms: i64,
    ) -> AppResult<LearningImportPreview> {
        match path
            .extension()
            .and_then(|value| value.to_str())
            .map(str::to_ascii_lowercase)
            .as_deref()
        {
            Some("csv") => {
                let bytes = import::read_bounded_import_file(path)?;
                self.preview_csv_import(&bytes, now_unix_ms)
            }
            Some("json") => {
                let bytes = repository::portability::read_native_import_file(path)?;
                self.preview_native_json_import(&bytes, now_unix_ms)
            }
            _ => Err(AppError::Validation(
                "learning import file type is unsupported".into(),
            )),
        }
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

    pub fn confirm_import(
        &mut self,
        preview_token: &str,
        now_unix_ms: i64,
    ) -> AppResult<ImportCommitResult> {
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
        let repository = self.ensure_repository()?;
        match pending.import {
            PendingLearningImport::Csv(import) => {
                repository.commit_user_import(&import, now_unix_ms)
            }
            PendingLearningImport::NativeJson(import) => {
                repository.restore_native_export(&import, now_unix_ms)
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
}
