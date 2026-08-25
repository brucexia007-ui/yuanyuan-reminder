import { invoke } from "@tauri-apps/api/core";

import type {
  LearningCardDto,
  LearningAnswerResult,
  LearningDataSummary,
  LearningDashboardSnapshot,
  LearningDeleteResult,
  LearningDeleteScope,
  LearningExportFormat,
  LearningExportResult,
  LearningHomeSnapshot,
  LearningImportCommitResult,
  LearningImportPreview,
  LearningInvitationDto,
  LearningQuestionDto,
  LearningRateResult,
  LearningRating,
  LearningRecordFilter,
  LearningRecordPage,
  LearningSessionSnapshot,
  LearningSessionSummary,
  LearningSessionKind,
  LearningSettings,
  LearningSettingsPatch,
  LegacyLearningEdition,
  LegacyLearningMigrationPreview,
  LegacyLearningMigrationResult,
  LegacyLearningSourceSummary,
} from "../types";

const isTauri =
  typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

async function demo() {
  if (!import.meta.env.DEV) {
    throw new Error("学习演示仅在本地开发模式可用");
  }
  return import("./demoBackend");
}

export async function getLearningHome(): Promise<LearningHomeSnapshot> {
  return isTauri
    ? invoke<LearningHomeSnapshot>("get_learning_home")
    : (await demo()).getLearningHome();
}

export async function getLearningDashboard(): Promise<LearningDashboardSnapshot> {
  return isTauri
    ? invoke<LearningDashboardSnapshot>("get_learning_dashboard")
    : (await demo()).getLearningDashboard();
}

export async function updateLearningSettings(
  patch: LearningSettingsPatch,
): Promise<LearningSettings> {
  return isTauri
    ? invoke<LearningSettings>("update_learning_settings", { patch })
    : (await demo()).updateLearningSettings(patch);
}

export async function startManualLearningSession(
  cardCount: 3 | 5 | 10,
  sessionKind: LearningSessionKind = "daily",
  sourceSessionId: string | null = null,
): Promise<LearningSessionSnapshot> {
  return isTauri
    ? invoke<LearningSessionSnapshot>("start_manual_learning_session", {
      cardCount,
      sessionKind,
      sourceSessionId,
    })
    : (await demo()).startManualLearningSession(cardCount, sessionKind, sourceSessionId);
}

export async function getLearningSessionSummary(
  sessionId: string,
): Promise<LearningSessionSummary> {
  return isTauri
    ? invoke<LearningSessionSummary>("get_learning_session_summary", { sessionId })
    : (await demo()).getLearningSessionSummary(sessionId);
}

export async function getCurrentLearningCard(
  sessionId: string,
): Promise<LearningCardDto> {
  return isTauri
    ? invoke<LearningCardDto>("get_current_learning_card", { sessionId })
    : (await demo()).getCurrentLearningCard(sessionId);
}

export async function getCurrentLearningQuestion(
  sessionId: string,
): Promise<LearningQuestionDto> {
  return isTauri
    ? invoke<LearningQuestionDto>("get_current_learning_question", { sessionId })
    : (await demo()).getCurrentLearningQuestion(sessionId);
}

export async function answerLearningQuestion(
  sessionId: string,
  questionId: string,
  selectedOptionId: string,
  clientAnswerId: string,
  responseMs: number | null,
): Promise<LearningAnswerResult> {
  return isTauri
    ? invoke<LearningAnswerResult>("answer_learning_question", {
        sessionId,
        questionId,
        selectedOptionId,
        clientAnswerId,
        responseMs,
      })
    : (await demo()).answerLearningQuestion(
        sessionId,
        questionId,
        selectedOptionId,
        clientAnswerId,
        responseMs,
      );
}

export async function rateLearningCard(
  sessionId: string,
  cardId: string,
  rating: LearningRating,
  expectedRevision: number,
): Promise<LearningRateResult> {
  return isTauri
    ? invoke<LearningRateResult>("rate_learning_card", {
        sessionId,
        cardId,
        rating,
        expectedRevision,
      })
    : (await demo()).rateLearningCard(sessionId, cardId, rating, expectedRevision);
}

export async function finishLearningSession(
  sessionId: string,
  exitReason: "user_exit" | "content_unavailable" | "completed",
  expectedRevision: number,
): Promise<LearningSessionSnapshot> {
  return isTauri
    ? invoke<LearningSessionSnapshot>("finish_learning_session", {
        sessionId,
        exitReason,
        expectedRevision,
      })
    : (await demo()).finishLearningSession(sessionId, exitReason, expectedRevision);
}

export async function dismissCompletedLearningSession(
  sessionId: string,
  expectedRevision: number,
): Promise<LearningSessionSnapshot> {
  return finishLearningSession(sessionId, "completed", expectedRevision);
}

export async function getResumableLearningSession(): Promise<LearningSessionSnapshot | null> {
  return isTauri
    ? invoke<LearningSessionSnapshot | null>("get_resumable_learning_session")
    : (await demo()).getResumableLearningSession();
}

export async function pauseLearningSession(
  sessionId: string,
  expectedRevision: number,
  reason: "user_pause" = "user_pause",
): Promise<LearningSessionSnapshot> {
  return isTauri
    ? invoke<LearningSessionSnapshot>("pause_learning_session", {
        sessionId,
        expectedRevision,
        reason,
      })
    : (await demo()).pauseLearningSession(sessionId, expectedRevision, reason);
}

export async function resumeLearningSession(
  sessionId: string,
  expectedRevision: number,
): Promise<LearningSessionSnapshot> {
  return isTauri
    ? invoke<LearningSessionSnapshot>("resume_learning_session", {
        sessionId,
        expectedRevision,
      })
    : (await demo()).resumeLearningSession(sessionId, expectedRevision);
}

export async function abandonLearningSession(
  sessionId: string,
  expectedRevision: number,
): Promise<LearningSessionSnapshot> {
  return isTauri
    ? invoke<LearningSessionSnapshot>("abandon_learning_session", {
        sessionId,
        expectedRevision,
      })
    : (await demo()).abandonLearningSession(sessionId, expectedRevision);
}

export async function previewLearningImport(): Promise<LearningImportPreview> {
  if (!isTauri) throw new Error("浏览器演示不会读取本机文件");
  return invoke<LearningImportPreview>("preview_learning_import");
}

export async function confirmLearningImport(
  previewToken: string,
): Promise<LearningImportCommitResult> {
  if (!isTauri) throw new Error("浏览器演示不会写入本机词表");
  return invoke<LearningImportCommitResult>("confirm_learning_import", {
    previewToken,
  });
}

export async function listLegacyLearningSources(): Promise<LegacyLearningSourceSummary[]> {
  return isTauri
    ? invoke<LegacyLearningSourceSummary[]>("list_legacy_learning_sources")
    : ["preview", "personal"].map((edition) => ({
        schemaVersion: 1 as const,
        edition: edition as LegacyLearningEdition,
        status: "missing" as const,
        sourceSchemaVersion: null,
        cardCount: 0,
        reviewCount: 0,
        failureReason: null,
      }));
}

export async function previewLegacyLearningMigration(
  edition: LegacyLearningEdition,
): Promise<LegacyLearningMigrationPreview> {
  if (!isTauri) throw new Error("浏览器演示不会读取旧版本机数据");
  return invoke<LegacyLearningMigrationPreview>("preview_legacy_learning_migration", {
    edition,
  });
}

export async function confirmLegacyLearningMigration(
  previewToken: string,
): Promise<LegacyLearningMigrationResult> {
  if (!isTauri) throw new Error("浏览器演示不会迁移旧版本机数据");
  return invoke<LegacyLearningMigrationResult>("confirm_legacy_learning_migration", {
    previewToken,
  });
}

export async function getPendingLearningInvitation(): Promise<LearningInvitationDto | null> {
  return isTauri
    ? invoke<LearningInvitationDto | null>("get_pending_learning_invitation")
    : null;
}

export async function acceptLearningInvitation(
  invitationId: string,
): Promise<LearningSessionSnapshot> {
  if (!isTauri) throw new Error("浏览器演示没有自动邀请");
  return invoke<LearningSessionSnapshot>("accept_learning_invitation", {
    invitationId,
  });
}

export async function dismissLearningInvitation(
  invitationId: string,
): Promise<boolean> {
  if (!isTauri) return false;
  return invoke<boolean>("dismiss_learning_invitation", { invitationId });
}

export async function pauseLearningInvitesToday(): Promise<LearningSettings> {
  if (!isTauri) return (await demo()).updateLearningSettings({ mode: "manual_only" });
  return invoke<LearningSettings>("pause_learning_invites_today");
}

export async function getLearningDataSummary(): Promise<LearningDataSummary> {
  return isTauri
    ? invoke<LearningDataSummary>("get_learning_data_summary")
    : (await demo()).getLearningDataSummary();
}

export async function listLearningRecords(
  filter: LearningRecordFilter,
  query: string,
  page: number,
  pageSize = 20,
): Promise<LearningRecordPage> {
  return isTauri
    ? invoke<LearningRecordPage>("list_learning_records", {
        filter,
        query,
        page,
        pageSize,
      })
    : (await demo()).listLearningRecords(filter, query, page, pageSize);
}

export async function exportLearningData(
  format: LearningExportFormat,
): Promise<LearningExportResult> {
  if (!isTauri) throw new Error("浏览器演示不会在本机创建导出文件");
  return invoke<LearningExportResult>("export_learning_data", { format });
}

export async function deleteLearningData(
  scope: LearningDeleteScope,
  confirmation: string,
): Promise<LearningDeleteResult> {
  return isTauri
    ? invoke<LearningDeleteResult>("delete_learning_data", {
        scope,
        confirmation,
      })
    : (await demo()).deleteLearningData(scope, confirmation);
}
