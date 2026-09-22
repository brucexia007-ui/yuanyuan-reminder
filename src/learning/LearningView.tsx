import { petText, getPetSnapshot } from "../pet/petProfile";
import { emit } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { useCallback, useEffect, useRef, useState, type CSSProperties } from "react";

import type {
  LearningCardDto,
  LearningAnswerResult,
  LearningDataSummary,
  LearningDashboardSnapshot,
  LearningDeleteScope,
  LearningExportFormat,
  LearningHomeSnapshot,
  LearningImportPreview,
  LearningQuestionDto,
  LearningRecordFilter,
  LearningRecordPage,
  LearningRating,
  LearningSessionSnapshot,
  LearningSessionSummary,
  LearningSessionKind,
  LearningSettingsPatch,
  LegacyLearningEdition,
  LegacyLearningMigrationPreview,
  LegacyLearningSourceSummary,
} from "../types";
import {
  cancelLearningImport,
  confirmLearningImport,
  confirmLegacyLearningMigration,
  abandonLearningSession,
  answerLearningQuestion,
  deleteLearningData,
  exportLearningData,
  getCurrentLearningCard,
  getCurrentLearningQuestion,
  getLearningDashboard,
  getLearningHome,
  getLearningDataSummary,
  getLearningSessionSummary,
  listLearningRecords,
  listLegacyLearningSources,
  pauseLearningSession,
  previewLearningImport,
  previewLegacyLearningMigration,
  rateLearningCard,
  resumeLearningSession,
  startManualLearningSession,
  updateLearningSettings,
} from "./backend";
import { onBackendEvent, tauriAvailable } from "../lib/backend";
import { SpriteAnimator } from "../pet/SpriteAnimator";
import type { AnimationName } from "../pet/manifest";
import "./learning.css";

export const LEARNING_PACK_AGENT_PROMPT = petText(`请把我提供且有权使用的资料整理为圆圆提醒 learning-pack v1 JSON。请先读取 customization/learning/learning-pack.schema.json 和 customization/learning/LEARNING_IMPORT_PROMPT.zh-CN.md；原样记录我的权利基础，unknown 必须停止最终制包，personal_use_only 必须禁止公开分发。每张卡使用稳定 cardId、recall 或 choice、prompt、answer、sourceRefs 和 scheduleEpoch；无法保证干扰项无歧义时改为 recall。完成后运行本地验证器和报告生成器，并把结果放在 work/personal-learning/<run-id>/，不要放入 Git、public、Tauri resources、安装包、Release 或测试日志。`);
export const LEARNING_PACK_TEMPLATE_FILENAME = "learning-pack.template.learning-pack.json";

const LEARNING_PACK_TEMPLATE = `${JSON.stringify({
  schemaVersion: 1,
  packId: "my.private.pack",
  version: "1.0.0",
  title: "我的本地知识",
  description: "",
  rights: {
    basis: "unknown",
    statement: "请填写你声明的权利基础；unknown 会阻止最终制包。",
    redistributable: false,
  },
  sources: [{ sourceRef: "source-001", label: "我的资料" }],
  contentSha256: "由验证工具计算并填写",
  cards: [{
    cardId: "card-001",
    exerciseKind: "recall",
    prompt: "问题",
    answer: "答案",
    sourceRefs: ["source-001"],
    scheduleEpoch: 1,
  }],
}, null, 2)}\n`;

type LearningScreen = "home" | "card" | "complete";
type LearningHubSection = "start" | "dashboard" | "words";
type LearningOperation =
  | "import_picker"
  | "import_commit"
  | "export_picker"
  | "legacy_migration"
  | "delete";

interface LearningImportProgress {
  phase:
    | "reading_input"
    | "validating_input"
    | "validating_text"
    | "scanning_syntax"
    | "decoding"
    | "validating_structure"
    | "validating_cards"
    | "finalizing"
    | "complete";
  unit: "bytes" | "values" | "cards";
  completedUnits: number;
  totalUnits: number | null;
}

export function LearningView() {
  const desktopAvailable = tauriAvailable();
  const [home, setHome] = useState<LearningHomeSnapshot | null>(null);
  const [dashboard, setDashboard] = useState<LearningDashboardSnapshot | null>(null);
  const [dataSummary, setDataSummary] = useState<LearningDataSummary | null>(null);
  const [legacySources, setLegacySources] = useState<LegacyLearningSourceSummary[]>([]);
  const [session, setSession] = useState<LearningSessionSnapshot | null>(null);
  const [card, setCard] = useState<LearningCardDto | null>(null);
  const [question, setQuestion] = useState<LearningQuestionDto | null>(null);
  const [answer, setAnswer] = useState<LearningAnswerResult | null>(null);
  const [petAnimation, setPetAnimation] = useState<AnimationName>("ball-pickup");
  const [sessionWrongCount, setSessionWrongCount] = useState(0);
  const [sessionSummary, setSessionSummary] = useState<LearningSessionSummary | null>(null);
  const [screen, setScreen] = useState<LearningScreen>("home");
  const [hubSection, setHubSection] = useState<LearningHubSection>("start");
  const [sessionKind, setSessionKind] = useState<LearningSessionKind>("daily");
  const [flipped, setFlipped] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [importPreview, setImportPreview] =
    useState<LearningImportPreview | null>(null);
  const [legacyMigrationPreview, setLegacyMigrationPreview] =
    useState<LegacyLearningMigrationPreview | null>(null);
  const [deleteScope, setDeleteScope] = useState<LearningDeleteScope | null>(null);
  const [feedback, setFeedback] = useState<string | null>(null);
  const [pendingOperation, setPendingOperation] =
    useState<LearningOperation | null>(null);
  const [importCancellationBusy, setImportCancellationBusy] = useState(false);
  const [importProgress, setImportProgress] = useState<LearningImportProgress | null>(null);
  const [recordFilter, setRecordFilter] = useState<LearningRecordFilter>("mistakes");
  const [recordPage, setRecordPage] = useState<LearningRecordPage | null>(null);
  const [recordBusy, setRecordBusy] = useState(false);
  const [dashboardBusy, setDashboardBusy] = useState(false);
  const [recordQuery, setRecordQuery] = useState("");
  const [recordDraft, setRecordDraft] = useState("");
  const [exitConfirmationOpen, setExitConfirmationOpen] = useState(false);
  const cardHeadingRef = useRef<HTMLHeadingElement>(null);
  const firstOptionRef = useRef<HTMLButtonElement>(null);
  const firstRatingRef = useRef<HTMLButtonElement>(null);
  const nextButtonRef = useRef<HTMLButtonElement>(null);
  const questionStartedAtRef = useRef(Date.now());
  const correctAdvanceTimerRef = useRef<number | null>(null);

  const clearCorrectAdvanceTimer = useCallback(() => {
    if (correctAdvanceTimerRef.current === null) return;
    window.clearTimeout(correctAdvanceTimerRef.current);
    correctAdvanceTimerRef.current = null;
  }, []);

  useEffect(() => clearCorrectAdvanceTimer, [clearCorrectAdvanceTimer]);

  const prepareQuestion = useCallback(async (sessionId: string) => {
    clearCorrectAdvanceTimer();
    const nextQuestion = await getCurrentLearningQuestion(sessionId);
    const fallbackCard = nextQuestion.kind === "recall_fallback"
      ? await getCurrentLearningCard(sessionId)
      : null;
    setQuestion(nextQuestion);
    setCard(fallbackCard);
    setAnswer(null);
    setFlipped(false);
    setPetAnimation("ball-pickup");
    questionStartedAtRef.current = Date.now();
  }, [clearCorrectAdvanceTimer]);

  const loadHome = useCallback(async () => {
    setBusy(true);
    setError(null);
    try {
      const [next, nextDataSummary, nextLegacySources] = await Promise.all([
        getLearningHome(),
        getLearningDataSummary(),
        listLegacyLearningSources(),
      ]);
      setHome(next);
      setDataSummary(nextDataSummary);
      setLegacySources(nextLegacySources);
      if (
        next.activeSession
        && ["created", "active", "paused"].includes(next.activeSession.status)
      ) {
        setSession(next.activeSession);
        setSessionKind(next.activeSession.sessionKind);
        if (tauriAvailable()) {
          setCard(null);
          setQuestion(null);
          setAnswer(null);
          setScreen("home");
        } else if (next.activeSession.status === "active") {
          await prepareQuestion(next.activeSession.sessionId);
          setScreen("card");
        }
      } else {
        setSession(null);
        setSessionSummary(null);
        setCard(null);
        setQuestion(null);
        setAnswer(null);
        setScreen("home");
      }
    } catch (reason) {
      setError(`学习页暂时不可用：${learningErrorMessage(reason)}`);
    } finally {
      setBusy(false);
    }
  }, [prepareQuestion]);

  const loadDashboard = useCallback(async () => {
    setDashboardBusy(true);
    setError(null);
    try {
      setDashboard(await getLearningDashboard());
    } catch (reason) {
      setError(`学习看板暂时无法打开：${learningErrorMessage(reason)}`);
    } finally {
      setDashboardBusy(false);
    }
  }, []);

  useEffect(() => {
    void loadHome();
  }, [loadHome]);

  useEffect(() => {
    let disposed = false;
    const cleanups: Array<() => void> = [];
    void Promise.all([
      onBackendEvent("learning-session-interrupted", () => {
        if (disposed) return;
        void loadHome().then(() => {
          if (!disposed) setError("更重要的提醒到了，这张未评分卡没有计入；稍后可继续上一轮。");
        });
      }),
      onBackendEvent("learning-data-updated", () => { if (!disposed) void loadHome(); }),
      onBackendEvent<LearningImportProgress>("learning-import-progress", (progress) => { if (!disposed) setImportProgress(progress); }),
    ]).then((unlisten) => {
      if (disposed) unlisten.forEach((stop) => stop());
      else cleanups.push(...unlisten);
    });
    return () => { disposed = true; cleanups.forEach((stop) => stop()); };
  }, [loadHome]);

  useEffect(() => {
    if (screen === "card") cardHeadingRef.current?.focus();
  }, [question?.questionId, screen]);

  useEffect(() => {
    if (screen === "card" && question?.kind === "multiple_choice" && !answer) {
      firstOptionRef.current?.focus();
    }
  }, [answer, question?.questionId, question?.kind, screen]);

  useEffect(() => {
    if (screen === "card" && flipped) firstRatingRef.current?.focus();
  }, [card?.cardId, flipped, screen]);

  useEffect(() => {
    if (screen === "card" && answer && !answer.correct) nextButtonRef.current?.focus();
  }, [answer, screen]);

  const exitSession = useCallback(async () => {
    if (!session || session.status !== "active" || busy) return;
    setBusy(true);
    setError(null);
    try {
      await abandonLearningSession(session.sessionId, session.stateRevision);
      setExitConfirmationOpen(false);
      await loadHome();
    } catch (reason) {
      setError(`这次学习暂时无法退出：${learningErrorMessage(reason)}`);
      setBusy(false);
    }
  }, [busy, loadHome, session]);

  const pauseSession = useCallback(async () => {
    if (!session || session.status !== "active" || busy) return;
    setBusy(true);
    setError(null);
    try {
      await pauseLearningSession(session.sessionId, session.stateRevision);
      setExitConfirmationOpen(false);
      await loadHome();
    } catch (reason) {
      setError(`这次学习暂时无法暂停：${learningErrorMessage(reason)}`);
      setBusy(false);
    }
  }, [busy, loadHome, session]);

  const requestExitSession = useCallback(() => {
    if (!session || busy) return;
    if (
      session.status === "active"
      && session.completedCount < session.plannedCount
    ) {
      setExitConfirmationOpen(true);
      return;
    }
    void exitSession();
  }, [busy, exitSession, session]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape" && screen === "card") {
        event.preventDefault();
        if (exitConfirmationOpen) setExitConfirmationOpen(false);
        else requestExitSession();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [exitConfirmationOpen, requestExitSession, screen]);

  const start = async (
    count: 3 | 5 | 10,
    kind: LearningSessionKind = sessionKind,
    sourceSessionId: string | null = null,
  ) => {
    setBusy(true);
    setError(null);
    try {
      const nextSession = await startManualLearningSession(count, kind, sourceSessionId);
      setSession(nextSession);
      setSessionSummary(null);
      setSessionWrongCount(0);
      if (tauriAvailable()) {
        await loadHome();
        await getCurrentWindow().hide();
      } else {
        await prepareQuestion(nextSession.sessionId);
        setScreen("card");
      }
    } catch (reason) {
      await loadHome();
      setError(`现在还不能开始：${learningErrorMessage(reason)}`);
    } finally {
      setBusy(false);
    }
  };

  const resumeDesktopSession = async () => {
    if (!session) return;
    setBusy(true);
    setError(null);
    try {
      const resumed = session.status === "active"
        ? session
        : await resumeLearningSession(session.sessionId, session.stateRevision);
      setSession(resumed);
      if (tauriAvailable()) {
        await emit("learning-session-updated", resumed);
        await getCurrentWindow().hide();
      } else {
        await prepareQuestion(resumed.sessionId);
        setScreen("card");
      }
    } catch (reason) {
      setError(`上一轮暂时无法继续：${learningErrorMessage(reason)}`);
    } finally {
      setBusy(false);
    }
  };

  const submitAnswer = useCallback(async (optionId: string) => {
    if (!session || !question || question.kind !== "multiple_choice" || answer || busy) return;
    setBusy(true);
    setError(null);
    try {
      const result = await answerLearningQuestion(
        session.sessionId,
        question.questionId,
        optionId,
        crypto.randomUUID(),
        Math.max(0, Date.now() - questionStartedAtRef.current),
      );
      setAnswer(result);
      setSession(result.session);
      setPetAnimation("alert-glass-paws");
      if (!result.correct && !result.isRemediation) {
        setSessionWrongCount((value) => value + 1);
      }
    } catch (reason) {
      setError(`这道题暂时没有记入：${learningErrorMessage(reason)}`);
    } finally {
      setBusy(false);
    }
  }, [answer, busy, question, session]);

  const continueSession = useCallback(async () => {
    if (!session || !answer || busy) return;
    if (answer.session.status === "completed") {
      try {
        setSessionSummary(await getLearningSessionSummary(answer.session.sessionId));
      } catch {
        setSessionSummary(null);
      }
      setScreen("complete");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await prepareQuestion(session.sessionId);
    } catch (reason) {
      setError(`下一道题暂时无法打开：${learningErrorMessage(reason)}`);
    } finally {
      setBusy(false);
    }
  }, [answer, busy, prepareQuestion, session]);

  useEffect(() => {
    clearCorrectAdvanceTimer();
    if (screen !== "card" || !answer?.correct || busy) return;
    correctAdvanceTimerRef.current = window.setTimeout(() => {
      correctAdvanceTimerRef.current = null;
      void continueSession();
    }, 1_200);
    return clearCorrectAdvanceTimer;
  }, [answer, busy, clearCorrectAdvanceTimer, continueSession, screen]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (exitConfirmationOpen) return;
      if (event.key === "Enter" && answer?.correct && !busy && screen === "card") {
        event.preventDefault();
        clearCorrectAdvanceTimer();
        void continueSession();
        return;
      }
      if (
        screen !== "card"
        || !question
        || question.kind !== "multiple_choice"
        || answer
        || busy
      ) return;
      const index = Number(event.key) - 1;
      const option = question.options[index];
      if (!option) return;
      event.preventDefault();
      void submitAnswer(option.optionId);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [answer, busy, clearCorrectAdvanceTimer, continueSession, exitConfirmationOpen, question, screen, submitAnswer]);

  const rate = async (rating: LearningRating) => {
    if (!session || !card || !flipped || busy) return;
    setBusy(true);
    setError(null);
    try {
      const result = await rateLearningCard(
        session.sessionId,
        card.cardId,
        rating,
        session.stateRevision,
      );
      setSession(result.session);
      setFlipped(false);
      if (result.session.status === "completed") {
        try {
          setSessionSummary(await getLearningSessionSummary(result.session.sessionId));
        } catch {
          setSessionSummary(null);
        }
        setScreen("complete");
      } else {
        await prepareQuestion(result.session.sessionId);
      }
    } catch (reason) {
      setError(`这张卡暂时没有记入：${learningErrorMessage(reason)}`);
    } finally {
      setBusy(false);
    }
  };

  const saveSettings = async (patch: LearningSettingsPatch) => {
    if (!home) return;
    setBusy(true);
    setError(null);
    try {
      await updateLearningSettings(patch);
      await loadHome();
    } catch (reason) {
      setError(`学习设置没有保存：${learningErrorMessage(reason)}`);
    } finally {
      setBusy(false);
    }
  };

  const previewImport = async () => {
    setBusy(true);
    setPendingOperation("import_picker");
    setImportProgress(null);
    setError(null);
    try {
      const preview = await previewLearningImport();
      if (preview.status === "confirmation_required") setImportPreview(preview);
    } catch (reason) {
      if (learningImportWasCancelled(reason)) {
        setFeedback("导入已安全停止，没有写入不完整数据。");
      } else {
        setError(`词表未能预览：${learningErrorMessage(reason)}`);
      }
    } finally {
      setPendingOperation(null);
      setImportProgress(null);
      setBusy(false);
    }
  };

  const confirmImport = async () => {
    const token = importPreview?.previewToken;
    if (!token) return;
    setBusy(true);
    setPendingOperation("import_commit");
    setImportProgress(null);
    setError(null);
    try {
      await confirmLearningImport(token);
      setImportPreview(null);
      await loadHome();
    } catch (reason) {
      setImportPreview(null);
      if (learningImportWasCancelled(reason)) {
        setFeedback("导入已安全停止，没有写入不完整数据。");
      } else {
        setError(`词表没有导入：${learningErrorMessage(reason)}`);
      }
    } finally {
      setPendingOperation(null);
      setImportProgress(null);
      setBusy(false);
    }
  };

  const requestImportCancellation = async () => {
    if (!pendingOperation?.startsWith("import_")) return;
    setImportCancellationBusy(true);
    setError(null);
    try {
      const accepted = await cancelLearningImport();
      setFeedback(accepted
        ? "已请求停止；当前数据库事务会先安全回滚。"
        : "导入操作已经结束，无需再次停止。");
    } catch (reason) {
      setError(`暂时无法停止导入：${learningErrorMessage(reason)}`);
    } finally {
      setImportCancellationBusy(false);
    }
  };

  const copyLearningPackPrompt = async () => {
    try {
      await navigator.clipboard.writeText(LEARNING_PACK_AGENT_PROMPT);
      setFeedback("已复制智能体整理提示词；生成的私人知识包不会进入安装包。");
    } catch (reason) {
      setError(`暂时无法复制提示词：${learningErrorMessage(reason)}`);
    }
  };

  const downloadLearningPackTemplate = () => {
    const url = URL.createObjectURL(
      new Blob([LEARNING_PACK_TEMPLATE], { type: "application/json" }),
    );
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = LEARNING_PACK_TEMPLATE_FILENAME;
    anchor.click();
    URL.revokeObjectURL(url);
    setFeedback("已下载空白知识包模板；填写后请先用本地验证工具检查。");
  };

  const previewLegacyMigration = async (edition: LegacyLearningEdition) => {
    setBusy(true);
    setPendingOperation("legacy_migration");
    setError(null);
    setFeedback(null);
    try {
      const preview = await previewLegacyLearningMigration(edition);
      if (preview.status === "already_migrated") {
        setFeedback("这份旧版学习数据已经迁移过，当前数据没有重复改写。");
      } else {
        setLegacyMigrationPreview(preview);
      }
    } catch (reason) {
      setError(`旧版学习数据未能预览：${learningErrorMessage(reason)}`);
    } finally {
      setPendingOperation(null);
      setBusy(false);
    }
  };

  const confirmLegacyMigration = async () => {
    const token = legacyMigrationPreview?.previewToken;
    if (!token) return;
    setBusy(true);
    setPendingOperation("legacy_migration");
    setError(null);
    setFeedback(null);
    try {
      const result = await confirmLegacyLearningMigration(token);
      setLegacyMigrationPreview(null);
      setFeedback(
        result.status === "already_migrated"
          ? "这份旧版数据已经迁移过，未重复写入。"
          : `已迁移 ${result.importedCardCount} 张卡片和 ${result.importedReviewCount} 条复习记录；旧版目录仍完整保留。`,
      );
      await loadHome();
    } catch (reason) {
      setError(`旧版学习数据没有迁移：${learningErrorMessage(reason)}`);
    } finally {
      setPendingOperation(null);
      setBusy(false);
    }
  };

  const exportData = async (format: LearningExportFormat) => {
    setBusy(true);
    setPendingOperation("export_picker");
    setError(null);
    setFeedback(null);
    try {
      const result = await exportLearningData(format);
      if (result.status === "saved") {
        setFeedback(`已在你选择的位置导出 ${result.recordCount} 条本地学习数据。`);
        setDataSummary(await getLearningDataSummary());
      }
    } catch (reason) {
      setError(`学习数据没有导出：${learningErrorMessage(reason)}`);
    } finally {
      setPendingOperation(null);
      setBusy(false);
    }
  };

  const confirmDelete = async (scope: LearningDeleteScope) => {
    setBusy(true);
    setPendingOperation("delete");
    setError(null);
    setFeedback(null);
    try {
      const confirmation =
        scope === "progress_only"
          ? "CLEAR LEARNING PROGRESS"
          : "DELETE ALL LEARNING DATA";
      const result = await deleteLearningData(scope, confirmation);
      setDeleteScope(null);
      setFeedback(
        scope === "progress_only"
          ? `已清空 ${result.deletedReviewCount} 条复习记录，词表仍保留。`
          : "本机学习库已删除；提醒、喝水、活动和专注数据未受影响。",
      );
      await loadHome();
    } catch (reason) {
      setError(`学习数据没有删除：${learningErrorMessage(reason)}`);
    } finally {
      setPendingOperation(null);
      setBusy(false);
    }
  };

  const loadRecords = async (
    filter: LearningRecordFilter,
    page: number,
    query: string,
  ) => {
    setRecordBusy(true);
    setError(null);
    try {
      const result = await listLearningRecords(filter, query, page, 20);
      setRecordFilter(filter);
      setRecordQuery(query);
      setRecordPage(result);
    } catch (reason) {
      setError(`学习记录暂时无法打开：${learningErrorMessage(reason)}`);
    } finally {
      setRecordBusy(false);
    }
  };

  const openHubSection = async (section: LearningHubSection) => {
    setHubSection(section);
    if (section === "dashboard") await loadDashboard();
    if (section === "words") await loadRecords(recordFilter, 0, recordQuery);
  };

  if (busy && !home && !session) {
    return (
      <div className="learning-loading-shell" role="status" aria-label="正在加载英语复习">
        <div className="learning-loading-heading" />
        <div className="learning-loading-tabs" />
        <div className="learning-loading-card" />
        <span>{petText("{pet}正在整理复习卡，通常只需几秒…")}</span>
      </div>
    );
  }

  if (!home) {
    return (
      <div className="learning-empty module-error" role="alert">
        <strong>学习模块没有打开</strong>
        <span>{error ?? "提醒、喝水和专注仍可正常使用。"}</span>
        <button className="primary compact" type="button" onClick={() => void loadHome()}>
          重新查看
        </button>
      </div>
    );
  }

  return (
    <div className="learning-view" aria-busy={busy}>
      {pendingOperation && (
        <div className="learning-operation-status" role="status" aria-live="polite">
          <span>
            {pendingOperation.startsWith("import_") && importProgress
              ? learningImportProgressMessage(importProgress, pendingOperation)
              : learningOperationMessage(pendingOperation)}
          </span>
          {pendingOperation.startsWith("import_") && (
            <button
              type="button"
              disabled={importCancellationBusy}
              onClick={() => void requestImportCancellation()}
            >
              {importCancellationBusy ? "正在停止" : "停止导入"}
            </button>
          )}
        </div>
      )}
      {error && (
        <div className="learning-error" role="alert">
          <span>{error}</span>
          <button type="button" onClick={() => setError(null)} aria-label="关闭学习错误">
            ×
          </button>
        </div>
      )}
      {feedback && (
        <div className="learning-feedback" role="status">
          <span>{feedback}</span>
          <button type="button" onClick={() => setFeedback(null)} aria-label="关闭学习提示">
            ×
          </button>
        </div>
      )}

      {screen === "home" && (
        <>
          <LearningHubNavigation
            active={hubSection}
            onSelect={(section) => void openHubSection(section)}
          />
          {hubSection === "start" && (
            <LearningHome
              home={home}
              dataSummary={dataSummary}
              legacySources={legacySources}
              busy={busy}
              sessionKind={sessionKind}
              onSessionKind={setSessionKind}
              onStart={start}
              onResume={resumeDesktopSession}
              onImport={previewImport}
              onCopyAgentPrompt={copyLearningPackPrompt}
              onDownloadTemplate={downloadLearningPackTemplate}
              onSettings={saveSettings}
              onExport={exportData}
              onDelete={setDeleteScope}
              onLegacyMigration={previewLegacyMigration}
              onOpenWords={() => void openHubSection("words")}
              desktopAvailable={desktopAvailable}
            />
          )}
          {hubSection === "dashboard" && (
            <LearningDashboard
              dashboard={dashboard}
              loading={dashboardBusy}
              onOpenRecords={(filter) => {
                setRecordFilter(filter);
                if (filter === "mistakes") setSessionKind("mistakes");
                setHubSection("words");
                void loadRecords(filter, 0, "");
              }}
            />
          )}
          {hubSection === "words" && (
            <LearningRecords
              page={recordPage}
              filter={recordFilter}
              draft={recordDraft}
              loading={recordBusy}
              onDraftChange={setRecordDraft}
              onFilter={(filter) => void loadRecords(filter, 0, recordQuery)}
              onSearch={() => void loadRecords(recordFilter, 0, recordDraft)}
              onPage={(page) => void loadRecords(recordFilter, page, recordQuery)}
              onStartMistakes={() => {
                setSessionKind("mistakes");
                setHubSection("start");
              }}
            />
          )}
        </>
      )}

      {screen === "card" && session && question && (
        <LearningStage
          session={session}
          question={question}
          fallbackCard={card}
          answer={answer}
          busy={busy}
          flipped={flipped}
          petAnimation={petAnimation}
          headingRef={cardHeadingRef}
          firstOptionRef={firstOptionRef}
          firstRatingRef={firstRatingRef}
          nextButtonRef={nextButtonRef}
          onPetAnimationComplete={() => setPetAnimation("waiting")}
          onSelect={(optionId) => void submitAnswer(optionId)}
          onContinue={() => void continueSession()}
          onFlip={() => setFlipped(true)}
          onRate={(rating) => void rate(rating)}
          onExit={requestExitSession}
        />
      )}

      {screen === "complete" && session && (
        <section className="learning-complete" aria-live="polite">
          <div className="learning-card-stack" aria-hidden="true" />
          <h2>这轮小黑板完成了</h2>
          <div className="learning-round-summary">
            <div><strong>{sessionSummary?.correctCount ?? session.completedCount}</strong><span>首答正确</span></div>
            <div><strong>{sessionSummary?.wrongCount ?? sessionWrongCount}</strong><span>本轮错题</span></div>
            <div><strong>{formatDuration(sessionSummary?.durationSeconds ?? 0)}</strong><span>本轮用时</span></div>
          </div>
          <p>
            新认识 {sessionSummary?.newCount ?? 0} 个，复习 {sessionSummary?.reviewCount ?? 0} 个。
            每轮独立结束，想继续时再开始即可。
          </p>
          <div className="learning-complete-actions">
            <button
              className="primary"
              type="button"
              disabled={busy}
              onClick={() => void start(home.settings.cardsPerSession, "daily")}
            >
              再学一轮 · {home.settings.cardsPerSession} 个
            </button>
            {(sessionSummary?.targetableWrongCount ?? 0) > 0 && (
              <button
                type="button"
                disabled={busy}
                onClick={() => void start(
                  home.settings.cardsPerSession,
                  "mistakes",
                  session.sessionId,
                )}
              >
                订正本轮错题 · {sessionSummary?.targetableWrongCount} 个
              </button>
            )}
            <button type="button" disabled={busy} onClick={() => void loadHome()}>
              先休息一下
            </button>
          </div>
        </section>
      )}

      {importPreview && (
        <ImportConfirmation
          preview={importPreview}
          busy={busy}
          onCancel={() => setImportPreview(null)}
          onConfirm={confirmImport}
        />
      )}
      {legacyMigrationPreview && (
        <LegacyMigrationConfirmation
          preview={legacyMigrationPreview}
          busy={busy}
          onCancel={() => setLegacyMigrationPreview(null)}
          onConfirm={confirmLegacyMigration}
        />
      )}
      {deleteScope && (
        <DeleteConfirmation
          scope={deleteScope}
          busy={busy}
          onCancel={() => setDeleteScope(null)}
          onConfirm={confirmDelete}
        />
      )}
      {exitConfirmationOpen && session && (
        <LearningExitConfirmation
          remaining={Math.max(0, session.plannedCount - session.completedCount)}
          busy={busy}
          onCancel={() => setExitConfirmationOpen(false)}
          onPause={pauseSession}
          onAbandon={exitSession}
        />
      )}
    </div>
  );
}

const learningPetSettings = {
  animationMode: "system",
  animationSpeed: 1,
} as const;

function LearningStage({
  session,
  question,
  fallbackCard,
  answer,
  busy,
  flipped,
  petAnimation,
  headingRef,
  firstOptionRef,
  firstRatingRef,
  nextButtonRef,
  onPetAnimationComplete,
  onSelect,
  onContinue,
  onFlip,
  onRate,
  onExit,
}: {
  session: LearningSessionSnapshot;
  question: LearningQuestionDto;
  fallbackCard: LearningCardDto | null;
  answer: LearningAnswerResult | null;
  busy: boolean;
  flipped: boolean;
  petAnimation: AnimationName;
  headingRef: React.RefObject<HTMLHeadingElement | null>;
  firstOptionRef: React.RefObject<HTMLButtonElement | null>;
  firstRatingRef: React.RefObject<HTMLButtonElement | null>;
  nextButtonRef: React.RefObject<HTMLButtonElement | null>;
  onPetAnimationComplete: () => void;
  onSelect: (optionId: string) => void;
  onContinue: () => void;
  onFlip: () => void;
  onRate: (rating: LearningRating) => void;
  onExit: () => void;
}) {
  const progress = question.isRemediation
    ? "本轮错题回看"
    : `${answer ? session.completedCount : session.completedCount + 1} / ${session.plannedCount}`;
  return (
    <section className="learning-session learning-blackboard-stage" aria-label={petText("{pet}小黑板英语复习")}>
      <div className="learning-session-meta">
        <span>{progress}</span>
        <button type="button" disabled={busy} onClick={onExit}>结束本轮</button>
      </div>

      <article className="learning-blackboard">
        <p className="learning-stage">{stageLabel(question.stage)}</p>
        <h2 ref={headingRef} tabIndex={-1} lang={question.partOfSpeech.includes("generic") ? undefined : "en"}>{question.headword}</h2>
        {question.phonetic && <p className="learning-phonetic">{question.phonetic}</p>}
        <p className="learning-pos">{question.partOfSpeech.filter((part) => part !== "generic").join(" · ")}</p>

        {question.kind === "multiple_choice" ? (
          <div className="learning-options" aria-label="请选择答案">
            {question.options.map((option, index) => {
              const isSelected = answer?.selectedOptionId === option.optionId;
              const isCorrect = answer?.correctOptionId === option.optionId;
              return (
                <button
                  key={option.optionId}
                  ref={index === 0 ? firstOptionRef : undefined}
                  className={[
                    "learning-option",
                    isCorrect ? "is-correct" : "",
                    isSelected && !answer?.correct ? "is-wrong" : "",
                    answer && !isCorrect && !isSelected ? "is-muted" : "",
                  ].filter(Boolean).join(" ")}
                  type="button"
                  disabled={busy || Boolean(answer)}
                  aria-label={`${index + 1}，${option.meaningZh}`}
                  onClick={() => onSelect(option.optionId)}
                >
                  <span aria-hidden="true">{index + 1}</span>
                  <strong>{option.meaningZh}</strong>
                </button>
              );
            })}
          </div>
        ) : fallbackCard ? (
          <div className="learning-recall-fallback">
            {!flipped ? (
              <button className="learning-chalk-action" type="button" disabled={busy} onClick={onFlip}>
                先回忆，再查看答案
              </button>
            ) : (
              <div className="learning-answer" aria-live="polite">
                <p>{fallbackCard.meaningsZh.join("；")}</p>
                <fieldset className="learning-ratings" disabled={busy}>
                  <legend>这次想得怎么样？</legend>
                  <button ref={firstRatingRef} type="button" onClick={() => onRate("again")}>忘了</button>
                  <button type="button" onClick={() => onRate("hard")}>模糊</button>
                  <button type="button" onClick={() => onRate("good")}>记得</button>
                </fieldset>
              </div>
            )}
          </div>
        ) : null}

        {answer && (
          <div className={`learning-result ${answer.correct ? "is-correct" : "is-wrong"}`} role="status" aria-live="polite">
            <strong>{answer.correct ? "回答正确" : "这次需要再看"}</strong>
            {!answer.correct && <span>正确答案：{answer.correctMeaningZh}</span>}
          </div>
        )}
      </article>

      <div className="learning-pet-console" aria-label={petText("{pet}用按钮反馈答题结果")}>
        <div className="learning-stage-pet">
          <SpriteAnimator
            animation={petAnimation}
            settings={learningPetSettings}
            onComplete={onPetAnimationComplete}
          />
        </div>
        <div className="learning-result-buttons" aria-hidden="true">
          <span className={`learning-result-button green ${answer?.correct ? "is-pressed" : ""}`}>✓</span>
          <span className={`learning-result-button red ${answer && !answer.correct ? "is-pressed" : ""}`}>×</span>
        </div>
      </div>

      {answer?.correct && (
        <p className="learning-auto-next" role="status">
          {answer.session.status === "completed" ? "即将显示本次结果…" : "即将自动进入下一题…"}
        </p>
      )}
      {answer && !answer.correct && (
        <button ref={nextButtonRef} className="primary learning-next" type="button" disabled={busy} onClick={onContinue}>
          {answer.session.status === "completed" ? "查看本次结果" : "我看懂了，下一题"}
        </button>
      )}
      <p className="learning-keyboard-hint">
        {question.kind === "multiple_choice" ? "数字键 1—4 选择 · " : "Tab 选择 · "}Esc 结束本轮
      </p>
    </section>
  );
}

function LearningHubNavigation({
  active,
  onSelect,
}: {
  active: LearningHubSection;
  onSelect: (section: LearningHubSection) => void;
}) {
  return (
    <nav className="learning-hub-navigation" aria-label="学习页面">
      {([
        ["start", "开始学习"],
        ["dashboard", "学习看板"],
        ["words", "单词本"],
      ] as const).map(([section, label]) => (
        <button
          key={section}
          type="button"
          aria-current={active === section ? "page" : undefined}
          onClick={() => onSelect(section)}
        >
          {label}
        </button>
      ))}
    </nav>
  );
}

function LearningDashboard({
  dashboard,
  loading,
  onOpenRecords,
}: {
  dashboard: LearningDashboardSnapshot | null;
  loading: boolean;
  onOpenRecords: (filter: LearningRecordFilter) => void;
}) {
  if (loading && !dashboard) {
    return <p className="learning-dashboard-loading" role="status">{petText("{pet}正在整理学习看板…")}</p>;
  }
  if (!dashboard) {
    return <p className="learning-dashboard-loading">暂时没有可展示的学习数据。</p>;
  }
  const progress = dashboard.totalCount > 0
    ? (dashboard.studiedCount / dashboard.totalCount) * 100
    : 0;
  const accuracy = dashboard.firstAnswerCount7Days > 0
    ? Math.round(
        (dashboard.firstAnswerCorrectCount7Days / dashboard.firstAnswerCount7Days) * 100,
      )
    : null;
  const maxDayCount = Math.max(
    1,
    ...dashboard.days.flatMap((day) => [day.reviewCount, day.newCount]),
  );
  const stageTotal = Math.max(1, dashboard.totalCount);
  const stages = [
    ["new", "未学习", dashboard.newCount, "new"],
    ["learning", "学习中", dashboard.learningCount, "learning"],
    ["mistakes", "待订正", dashboard.mistakeCount, "mistakes"],
    ["pending", "待复查", dashboard.pendingRecheckCount, "mistakes"],
    ["stable", "稳定掌握", dashboard.stableCount, "stable"],
  ] as const;
  return (
    <section className="learning-dashboard" aria-label="本机学习看板">
      <header className="learning-dashboard-progress">
        <div>
          <p className="eyebrow">考研词库进度</p>
          <h2>已接触 {dashboard.studiedCount} / {dashboard.totalCount}</h2>
          <span>一次答对不会被当作稳定掌握</span>
        </div>
        <strong>{progress.toFixed(1)}%</strong>
      </header>
      <div className="learning-progress-track" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={progress}>
        <span style={{ width: `${Math.max(progress, progress > 0 ? 0.8 : 0)}%` }} />
      </div>

      <div className="learning-dashboard-metrics">
        <div><strong>{dashboard.newCount}</strong><span>尚未学习</span></div>
        <div><strong>{dashboard.stableCount}</strong><span>稳定掌握</span></div>
        <div><strong>{accuracy === null ? "—" : `${accuracy}%`}</strong><span>7天首答正确率</span></div>
      </div>
      <p className="learning-dashboard-insight">
        {dashboardInsight(dashboard, accuracy)}
      </p>

      <section className="learning-dashboard-chart">
        <header><h3>近 7 天学习节奏</h3><span>新词 / 总复习</span></header>
        <div
          className="learning-activity-chart"
          role="img"
          aria-label={`近七天共完成 ${dashboard.days.reduce((sum, day) => sum + day.reviewCount, 0)} 次复习`}
        >
          {dashboard.days.map((day) => (
            <div className="learning-activity-day" key={day.localDay}>
              <div className="learning-activity-bars" aria-hidden="true">
                <i
                  className="is-new"
                  style={{
                    height: day.newCount > 0
                      ? `${Math.max(3, (day.newCount / maxDayCount) * 100)}%`
                      : 0,
                  }}
                />
                <i
                  className="is-review"
                  style={{
                    height: day.reviewCount > 0
                      ? `${Math.max(3, (day.reviewCount / maxDayCount) * 100)}%`
                      : 0,
                  }}
                />
              </div>
              <span>{formatDashboardDay(day.localDay)}</span>
            </div>
          ))}
        </div>
        <div className="learning-chart-legend" aria-hidden="true">
          <span><i className="is-new" />新词</span>
          <span><i className="is-review" />总复习</span>
        </div>
      </section>

      <section className="learning-dashboard-chart">
        <header><h3>掌握阶段</h3><span>共 {dashboard.totalCount} 个词</span></header>
        <div className="learning-stage-distribution" aria-label="单词掌握阶段分布">
          {stages.map(([key, label, count]) => (
            <span
              key={key}
              className={`is-${key}`}
              style={{
                flexGrow: count / stageTotal,
                minWidth: count > 0 ? 4 : 0,
              } as CSSProperties}
              title={`${label} ${count}`}
            />
          ))}
        </div>
        <div className="learning-stage-legend">
          {stages.map(([key, label, count, filter]) => (
            <button key={key} type="button" onClick={() => onOpenRecords(filter)}>
              <i className={`is-${key}`} />{label} {count}
            </button>
          ))}
        </div>
      </section>

      <button className="learning-dashboard-mistakes" type="button" onClick={() => onOpenRecords("mistakes")}>
        <span>
          <strong>待订正 {dashboard.mistakeCount} · 待复查 {dashboard.pendingRecheckCount}</strong>
          <small>已有 {dashboard.correctedMistakeCount} 个错题完成后续巩固</small>
        </span>
        <b>查看错题 →</b>
      </button>
    </section>
  );
}

function LearningRecords({
  page,
  filter,
  draft,
  loading,
  onDraftChange,
  onFilter,
  onSearch,
  onPage,
  onStartMistakes,
}: {
  page: LearningRecordPage | null;
  filter: LearningRecordFilter;
  draft: string;
  loading: boolean;
  onDraftChange: (value: string) => void;
  onFilter: (filter: LearningRecordFilter) => void;
  onSearch: () => void;
  onPage: (page: number) => void;
  onStartMistakes: () => void;
}) {
  const maxPage = page ? Math.max(0, Math.ceil(page.total / page.pageSize) - 1) : 0;
  return (
    <section className="learning-records" aria-busy={loading}>
      <header>
        <div>
          <p className="eyebrow">本机单词本</p>
          <h2>{recordFilterLabel(filter)}</h2>
        </div>
        {filter === "mistakes" && page && page.total > 0 && (
          <button className="primary compact" type="button" onClick={onStartMistakes}>
            仅练错题
          </button>
        )}
      </header>
      <div className="learning-record-tabs" role="tablist" aria-label="学习记录分类">
        {([
          ["mistakes", "错题"],
          ["learning", "学习中"],
          ["stable", "稳定掌握"],
          ["all", "全部词汇"],
        ] as const).map(([value, label]) => (
          <button
            key={value}
            type="button"
            role="tab"
            aria-selected={filter === value}
            className={filter === value ? "active" : ""}
            disabled={loading}
            onClick={() => onFilter(value)}
          >
            {label}
          </button>
        ))}
      </div>
      <form
        className="learning-record-search"
        onSubmit={(event) => {
          event.preventDefault();
          onSearch();
        }}
      >
        <input
          value={draft}
          maxLength={100}
          placeholder="搜索英文或中文释义"
          aria-label="搜索学习记录"
          onChange={(event) => onDraftChange(event.target.value)}
        />
        <button type="submit" disabled={loading}>搜索</button>
      </form>
      {loading && !page ? (
        <p className="learning-record-empty" role="status">{petText("{pet}正在翻记录…")}</p>
      ) : page && page.items.length > 0 ? (
        <div className="learning-record-list">
          {page.items.map((item) => (
            <article key={item.cardId}>
              <div className="learning-record-word">
                <strong lang="en">{item.headword}</strong>
                <span>{stageLabel(item.stage)}</span>
              </div>
              <p>{item.meaningsZh.join("；")}</p>
              <div className="learning-record-meta">
                <span>答对 {item.correctCount}</span>
                <span>答错 {item.wrongCount}</span>
                {item.mistakeStatus && (
                  <span className={`learning-mistake-status is-${item.mistakeStatus}`}>
                    {mistakeStatusLabel(item.mistakeStatus)}
                  </span>
                )}
                {item.lastWrongAtUnixMs && <span>最近错题 {formatLocalDate(item.lastWrongAtUnixMs)}</span>}
              </div>
            </article>
          ))}
        </div>
      ) : (
        <p className="learning-record-empty">
          {filter === "mistakes" ? "这里还没有错题。" : "这里还没有符合条件的单词。"}
        </p>
      )}
      {page && page.total > page.pageSize && (
        <nav className="learning-record-pagination" aria-label="学习记录分页">
          <button type="button" disabled={loading || page.page === 0} onClick={() => onPage(page.page - 1)}>上一页</button>
          <span>{page.page + 1} / {maxPage + 1}</span>
          <button type="button" disabled={loading || page.page >= maxPage} onClick={() => onPage(page.page + 1)}>下一页</button>
        </nav>
      )}
    </section>
  );
}

function LearningHome({
  home,
  dataSummary,
  legacySources,
  busy,
  sessionKind,
  onSessionKind,
  onStart,
  onResume,
  onImport,
  onCopyAgentPrompt,
  onDownloadTemplate,
  onSettings,
  onExport,
  onDelete,
  onLegacyMigration,
  onOpenWords,
  desktopAvailable,
}: {
  home: LearningHomeSnapshot;
  dataSummary: LearningDataSummary | null;
  legacySources: LegacyLearningSourceSummary[];
  busy: boolean;
  sessionKind: LearningSessionKind;
  onSessionKind: (kind: LearningSessionKind) => void;
  onStart: (
    count: 3 | 5 | 10,
    kind?: LearningSessionKind,
    sourceSessionId?: string | null,
  ) => Promise<void>;
  onResume: () => Promise<void>;
  onImport: () => Promise<void>;
  onCopyAgentPrompt: () => Promise<void>;
  onDownloadTemplate: () => void;
  onSettings: (patch: LearningSettingsPatch) => Promise<void>;
  onExport: (format: LearningExportFormat) => Promise<void>;
  onDelete: (scope: LearningDeleteScope) => void;
  onLegacyMigration: (edition: LegacyLearningEdition) => Promise<void>;
  onOpenWords: () => void;
  desktopAvailable: boolean;
}) {
  const dailyAvailable = home.dueCount + home.newAvailableCount;
  const available = sessionKind === "mistakes" ? home.mistakeCount : dailyAvailable;
  const dailyUnavailableMessage = "词库已经学完，目前也没有到期复习";
  const unavailableMessage = sessionKind === "mistakes"
    ? home.pendingRecheckCount > 0
      ? `没有待订正错题；另有 ${home.pendingRecheckCount} 个已订正词会在到期后复查`
      : "目前没有待订正错题，答错的单词会自动出现在这里"
    : dailyUnavailableMessage;
  const estimatedMinutes = estimateRoundMinutes(
    home.settings.cardsPerSession,
    home.averageResponseMs,
  );
  const goalEnabled = home.settings.dailyGoal > 0;
  return (
    <>
      <section className="learning-home-hero">
        <div className="learning-home-copy">
          <p className="eyebrow">考研英语 · 碎片复习</p>
          <h2>{sessionKind === "mistakes" ? `待订正错题 ${home.mistakeCount} 个` : "想学就再来一轮"}</h2>
          <p>
            {sessionKind === "mistakes"
              ? `只练还没订正的词；${home.pendingRecheckCount} 个已订正词等待日后复查。`
              : `到期复习优先，再用新词补满本轮；今天已经学习 ${home.newStudiedTodayCount} 个新词。`}
          </p>
        </div>
        <div
          className="learning-today-progress"
          aria-label={goalEnabled
            ? `今日新词 ${home.newStudiedTodayCount}，软目标 ${home.settings.dailyGoal}`
            : `今日已学新词 ${home.newStudiedTodayCount}`}
        >
          <strong>{home.newStudiedTodayCount}{goalEnabled ? `/${home.settings.dailyGoal}` : ""}</strong>
          <span>{goalEnabled ? "今日软目标" : "今日已学"}</span>
        </div>
      </section>

      <details className="learning-quick-guide">
        <summary>第一次用？1 分钟了解</summary>
        <ul>
          <li>{petText("{pet}会先安排到期复习，再用新词补满这一轮；没有每日上限。")}</li>
          <li>回忆题：忘了会尽快重现，模糊会缩短间隔，记得会逐步延长间隔。</li>
          <li>词表与进度只保存在本机；“完整 JSON”可用于备份和恢复。</li>
        </ul>
      </details>

      <section className="learning-mode-picker" aria-label="选择学习模式">
        <button
          type="button"
          aria-pressed={sessionKind === "daily"}
          onClick={() => onSessionKind("daily")}
        >
          <strong>今日学习</strong>
          <span>到期优先，再学新词</span>
        </button>
        <button
          type="button"
          aria-pressed={sessionKind === "mistakes"}
          onClick={() => onSessionKind("mistakes")}
        >
          <strong>仅练错题</strong>
          <span>{home.mistakeCount > 0 ? `${home.mistakeCount} 个待订正` : "目前没有待订正"}</span>
        </button>
      </section>

      <section className="learning-home-summary" aria-label="本地学习概览">
        <div><b>{home.dueCount}</b><span>到期复习</span></div>
        <div><b>{home.mistakeCount}</b><span>待订正错题</span></div>
        <div><b>{home.stableCount}</b><span>稳定掌握</span></div>
      </section>

      {(home.tomorrowDueCount > 0 || home.newStudiedTodayCount >= 30) && (
        <p className="learning-forecast-note">
          {home.newStudiedTodayCount >= 30
            ? `今天已经认识 ${home.newStudiedTodayCount} 个新词；仍可继续，`
            : ""}
          预计明天有 {home.tomorrowDueCount} 个词需要复习。
        </p>
      )}

      {home.capabilities.contentPackReady ? (
        <section className="learning-start">
          {home.activeSession && ["created", "active", "paused"].includes(home.activeSession.status) ? (
            <>
              <span>
                {home.activeSession.status === "active"
                  ? "小黑板正在桌面上"
                  : "上一轮已暂停，原题和已答记录都已保留"}
              </span>
              <button
                className="primary"
                type="button"
                disabled={busy}
                onClick={() => void onResume()}
              >
                {home.activeSession.status === "active" ? "回到桌面小黑板" : "继续上一轮"}
              </button>
            </>
          ) : (
            <>
              {available === 0 && (
                <p className="learning-start-note" role="status">
                  {unavailableMessage}
                </p>
              )}
              <label htmlFor="learning-card-count">每轮学几个</label>
          <select
            id="learning-card-count"
            value={home.settings.cardsPerSession}
            disabled={busy}
            onChange={(event) =>
              void onSettings({
                cardsPerSession: Number(event.target.value) as 3 | 5 | 10,
              })
            }
          >
            <option value={3}>3 个 · 约 1 分钟</option>
            <option value={5}>5 个 · 约 2 分钟</option>
            <option value={10}>10 个 · 约 4 分钟</option>
          </select>
          <button
            className="primary"
            type="button"
            disabled={busy || available === 0}
            onClick={() => void onStart(home.settings.cardsPerSession, sessionKind)}
          >
            {available > 0
              ? sessionKind === "mistakes"
                ? `开始订正 · ${Math.min(home.settings.cardsPerSession, available)} 个`
                : `开始一轮 · ${Math.min(home.settings.cardsPerSession, available)} 个 · 约 ${estimatedMinutes} 分钟`
              : sessionKind === "mistakes" ? "目前没有待订正错题" : "当前暂无可学卡片"}
          </button>
          <button className="learning-wordbook-link" type="button" disabled={busy} onClick={onOpenWords}>
            查看单词本
          </button>
            </>
          )}
        </section>
      ) : (
        <section className="learning-no-content">
          <h3>导入你的本地知识</h3>
          <p>应用不内置来源不明的课程。词表、知识包和学习进度只在本机解析和保存。</p>
          <div className="learning-empty-actions">
            <button
              className="primary"
              type="button"
              disabled={busy || !desktopAvailable}
              title={desktopAvailable ? undefined : "仅桌面版可导入本机文件"}
              onClick={() => void onImport()}
            >
              {desktopAvailable ? "导入本地知识" : "导入本地知识 · 仅桌面版"}
            </button>
            <button type="button" disabled={busy} onClick={() => void onCopyAgentPrompt()}>
              复制智能体整理提示词
            </button>
            <button type="button" disabled={busy} onClick={onDownloadTemplate}>
              下载空白模板
            </button>
          </div>
          <details className="learning-rights-note">
            <summary>查看内容来源与权利说明</summary>
            <p>知识包必须记录用户声明的权利基础。unknown 会阻止最终制包；personal_use_only 只允许本机导入，不能公开分发。应用只记录声明，不替用户作出法律结论。</p>
          </details>
        </section>
      )}

      <details className="learning-settings">
        <summary>学习与防打扰设置</summary>
        <label>
          <span>使用方式</span>
          <select
            value={home.settings.mode}
            disabled={busy}
            onChange={(event) =>
              void onSettings({
                mode: event.target.value as "manual_only" | "automatic_opt_in",
              })
            }
          >
            <option value="manual_only">完全手动</option>
            <option
              value="automatic_opt_in"
              disabled={!home.capabilities.autoInvitationAvailable}
            >
              允许低频邀请
            </option>
          </select>
        </label>
        {!home.capabilities.autoInvitationAvailable && (
          <p className="learning-auto-unavailable">
            自动邀请仅在 Windows、本机词表和防打扰能力均可用时开放；手动复习不受影响。
          </p>
        )}
        {home.settings.mode === "automatic_opt_in" && (
          <div className="learning-auto-note">
            <p>自动邀请只做不含单词的招手动作；点击后才拉出小黑板。</p>
            <label>
              <input
                type="checkbox"
                checked={home.settings.focusFinishedEnabled}
                disabled={busy}
                onChange={(event) =>
                  void onSettings({ focusFinishedEnabled: event.target.checked })
                }
              />
              专注自然结束后，可邀请一次到期复习
            </label>
          </div>
        )}
        <label>
          <span>每日学习目标（可选，不限量）</span>
          <select
            value={home.settings.dailyGoal}
            disabled={busy}
            onChange={(event) =>
              void onSettings({
                dailyGoal: Number(event.target.value) as 0 | 5 | 10 | 20 | 30 | 50,
              })
            }
          >
            {[0, 5, 10, 20, 30, 50].map((value) => (
              <option key={value} value={value}>{value === 0 ? "关闭目标" : `${value} 个`}</option>
            ))}
          </select>
        </label>
        <button
          type="button"
          disabled={busy || !desktopAvailable}
          title={desktopAvailable ? undefined : "仅桌面版可导入本机文件"}
          onClick={() => void onImport()}
        >
          {desktopAvailable ? "导入或恢复本机学习数据" : "导入或恢复本机学习数据 · 仅桌面版"}
        </button>
        <p className="learning-privacy">离线运行 · 不读取工作内容 · 不上传词表或学习记录</p>
      </details>

      <details className="learning-settings learning-data-settings">
        <summary>来源、导出与删除</summary>
        <p className="learning-data-intro">学习库与提醒主库分开保存，统一备份可同时保存两者；完整 JSON 用于导出学习内容和进度。所有数据保留在本机。</p>
        {dataSummary && dataSummary.packs.length > 0 ? (
          <div className="learning-source-list">
            {dataSummary.packs.map((pack) => (
              <article key={pack.packId}>
                <strong>{pack.title}</strong>
                <span>{pack.examScope} · {pack.status === "ready" ? "正在使用" : "已停用"}</span>
                <small>权利基础：{pack.rightsBasis ?? "用户声明"} · {pack.redistributable ? "用户声明可分发" : "仅限本机"}</small>
              </article>
            ))}
            {dataSummary.sources.map((source) => (
              <article key={source.sourceId}>
                <strong>{sourceKindLabel(source.sourceKind)}</strong>
                <span>
                  版本 {source.version} · {source.licenseExpression ?? "内容权利由用户负责"}
                </span>
                {source.noticeText && <small>{source.noticeText}</small>}
              </article>
            ))}
          </div>
        ) : (
          <p className="learning-data-intro">当前没有本机词表或来源记录。</p>
        )}
        {legacySources.some((source) => source.status !== "missing") && (
          <section aria-label="旧版本学习数据">
            <h3>旧版本学习数据</h3>
            <p className="learning-data-intro">
              这里只读检查旧版，不会自动搬运或删除。确认迁移前会备份当前学习库，迁移后旧目录仍保留。
            </p>
            <div className="learning-source-list">
              {legacySources
                .filter((source) => source.status !== "missing")
                .map((source) => (
                  <article key={source.edition}>
                    <strong>{legacyEditionLabel(source.edition)}</strong>
                    <span>{legacySourceStatusLabel(source)}</span>
                    {source.status === "available" && (
                      <button
                        type="button"
                        disabled={busy || !desktopAvailable}
                        onClick={() => void onLegacyMigration(source.edition)}
                      >
                        查看迁移影响
                      </button>
                    )}
                  </article>
                ))}
            </div>
          </section>
        )}
        <div className="learning-export-actions" aria-label="导出学习数据">
          <button type="button" disabled={busy || !desktopAvailable} title={desktopAvailable ? undefined : "仅桌面版可导出文件"} onClick={() => void onExport("native_json")}>
            完整 JSON
          </button>
          <button type="button" disabled={busy || !desktopAvailable} title={desktopAvailable ? undefined : "仅桌面版可导出文件"} onClick={() => void onExport("cards_csv")}>
            卡片 CSV
          </button>
          <button type="button" disabled={busy || !desktopAvailable} title={desktopAvailable ? undefined : "仅桌面版可导出文件"} onClick={() => void onExport("review_logs_csv")}>
            复习记录 CSV
          </button>
        </div>
        {!desktopAvailable && (
          <p className="learning-desktop-only-note">浏览器预览不会读取或写入本机文件；导入与导出仅桌面版可用。</p>
        )}
        {dataSummary?.lastSuccessfulExportAtUnixMs && (
          <p className="learning-last-export">
            上次成功导出：{formatLocalTime(dataSummary.lastSuccessfulExportAtUnixMs)}
          </p>
        )}
        <div className="learning-delete-actions">
          <button type="button" disabled={busy} onClick={() => onDelete("progress_only")}>
            只清空学习进度
          </button>
          <button
            className="learning-danger"
            type="button"
            disabled={busy}
            onClick={() => onDelete("all_learning_data")}
          >
            删除全部学习数据
          </button>
        </div>
      </details>
    </>
  );
}

function ImportConfirmation({
  preview,
  busy,
  onCancel,
  onConfirm,
}: {
  preview: LearningImportPreview;
  busy: boolean;
  onCancel: () => void;
  onConfirm: () => Promise<void>;
}) {
  const dialogRef = useRef<HTMLElement>(null);
  useModalInitialFocus(dialogRef);
  return (
    <div className="learning-dialog-backdrop">
      <section
        ref={dialogRef}
        className="learning-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="import-title"
        onKeyDown={(event) => handleModalKeyDown(event, onCancel)}
      >
        <h2 id="import-title">
          {preview.format === "json"
            ? "确认恢复这份学习数据"
            : preview.format === "learning_pack"
              ? "确认导入这份本地知识包"
              : "确认导入这份词表"}
        </h2>
        <p>{preview.sourceLabel ?? "用户导入"} · {preview.cardCount} 张卡片</p>
        {preview.format === "learning_pack" ? (
          <dl>
            <div><dt>新增</dt><dd>{preview.addedCount ?? 0}</dd></div>
            <div><dt>变化</dt><dd>{preview.changedCount ?? 0}</dd></div>
            <div><dt>停用</dt><dd>{preview.disabledCount ?? 0}</dd></div>
            <div><dt>重置进度</dt><dd>{preview.resetCount ?? 0}</dd></div>
          </dl>
        ) : (
          <dl>
            <div><dt>新词</dt><dd>{preview.newCount}</dd></div>
            <div><dt>学习中</dt><dd>{preview.learningCount}</dd></div>
            <div><dt>已知提示</dt><dd>{preview.reviewKnownCount}</dd></div>
          </dl>
        )}
        {preview.sampleHeadwords.length > 0 && (
          <p className="learning-import-sample">
            示例：{preview.sampleHeadwords.join(" · ")}
          </p>
        )}
        <p>
          {preview.format === "json"
            ? "原生 JSON 会替换当前学习库中的词表、设置、调度状态和复习记录；提醒主库不受影响。"
            : preview.format === "learning_pack"
              ? `权利基础：${preview.rightsBasis ?? "未声明"}。未变化卡片保留进度；答案变化或内容包要求重新学习时，只重置对应卡片；删除卡片先停用。`
              : "“进度提示”只决定初始队列，不会冒充原应用的精确调度。"}
        </p>
        {preview.format === "learning_pack" && (
          <section aria-label="知识包来源与许可">
            <p>{preview.rightsStatement}</p>
            <p>{preview.redistributable ? "内容提供者声明允许分发" : "内容提供者声明不允许公开分发"}</p>
            <ul>{preview.sourceDetails?.map((source, index) => <li key={index}>{source}</li>)}</ul>
          </section>
        )}
        <div className="learning-dialog-actions">
          <button type="button" disabled={busy} onClick={onCancel}>取消</button>
          <button className="primary" type="button" disabled={busy} onClick={() => void onConfirm()}>
            {preview.format === "json" ? "确认恢复" : "确认导入"}
          </button>
        </div>
      </section>
    </div>
  );
}

function LearningExitConfirmation({
  remaining,
  busy,
  onCancel,
  onPause,
  onAbandon,
}: {
  remaining: number;
  busy: boolean;
  onCancel: () => void;
  onPause: () => Promise<void>;
  onAbandon: () => Promise<void>;
}) {
  const dialogRef = useRef<HTMLElement>(null);
  useModalInitialFocus(dialogRef);
  return (
    <div className="learning-dialog-backdrop">
      <section
        ref={dialogRef}
        className="learning-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="learning-exit-title"
        onKeyDown={(event) => handleModalKeyDown(event, onCancel)}
      >
        <h2 id="learning-exit-title">暂停，还是结束本轮？</h2>
        <p>暂停会保留当前题和已答记录，可在 24 小时内继续。结束本轮后，剩余 {remaining} 题回到未来选卡池。</p>
        <div className="learning-dialog-actions">
          <button type="button" disabled={busy} onClick={onCancel}>继续学习</button>
          <button className="primary" type="button" disabled={busy} onClick={() => void onPause()}>
            暂停，稍后继续
          </button>
          <button className="learning-danger" type="button" disabled={busy} onClick={() => void onAbandon()}>
            结束本轮
          </button>
        </div>
      </section>
    </div>
  );
}

function LegacyMigrationConfirmation({
  preview,
  busy,
  onCancel,
  onConfirm,
}: {
  preview: LegacyLearningMigrationPreview;
  busy: boolean;
  onCancel: () => void;
  onConfirm: () => Promise<void>;
}) {
  const dialogRef = useRef<HTMLElement>(null);
  useModalInitialFocus(dialogRef);
  return (
    <div className="learning-dialog-backdrop">
      <section
        ref={dialogRef}
        className="learning-dialog"
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="legacy-migration-title"
        aria-describedby="legacy-migration-description"
        onKeyDown={(event) => handleModalKeyDown(event, onCancel)}
      >
        <h2 id="legacy-migration-title">
          迁移{legacyEditionLabel(preview.edition)}数据？
        </h2>
        <p id="legacy-migration-description">
          将导入 {preview.sourceCardCount} 张卡片和 {preview.sourceReviewCount} 条复习记录。
          {preview.replacesDestination
            ? ` 当前 ${preview.destinationCardCount} 张卡片和 ${preview.destinationReviewCount} 条记录会被替换。`
            : " 当前学习库没有需要替换的内容。"}
        </p>
        <ul>
          <li>写入前自动备份当前学习库；失败会保留原数据。</li>
          <li>迁移通过事务提交并重新打开核验。</li>
          <li>旧版目录不会自动删除，稍后仍可自行归档。</li>
        </ul>
        {preview.edition === "personal" && (
          <p>个人版内容只在你本机之间显式迁移，不会进入公开安装包或自动上传。</p>
        )}
        <div className="learning-dialog-actions">
          <button type="button" disabled={busy} onClick={onCancel}>取消</button>
          <button className="primary" type="button" disabled={busy} onClick={() => void onConfirm()}>
            备份并迁移
          </button>
        </div>
      </section>
    </div>
  );
}

function DeleteConfirmation({
  scope,
  busy,
  onCancel,
  onConfirm,
}: {
  scope: LearningDeleteScope;
  busy: boolean;
  onCancel: () => void;
  onConfirm: (scope: LearningDeleteScope) => Promise<void>;
}) {
  const deletesAll = scope === "all_learning_data";
  const dialogRef = useRef<HTMLElement>(null);
  useModalInitialFocus(dialogRef);
  return (
    <div className="learning-dialog-backdrop">
      <section
        ref={dialogRef}
        className="learning-dialog"
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="delete-learning-title"
        aria-describedby="delete-learning-description"
        onKeyDown={(event) => handleModalKeyDown(event, onCancel)}
      >
        <h2 id="delete-learning-title">
          {deletesAll ? "删除全部本机学习数据？" : "清空学习进度？"}
        </h2>
        <p id="delete-learning-description">
          {deletesAll
            ? "将删除词表、调度状态、设置与复习记录。提醒、喝水、活动、专注和任务守望数据不会被删除。"
            : "将删除复习记录并把所有卡片重置为新卡；词表、来源和学习设置仍会保留。"}
        </p>
        <p>此操作不能撤销。需要保留时，请先导出完整 JSON。</p>
        <div className="learning-dialog-actions">
          <button type="button" disabled={busy} onClick={onCancel}>取消</button>
          <button
            className={deletesAll ? "learning-danger" : "primary"}
            type="button"
            disabled={busy}
            onClick={() => void onConfirm(scope)}
          >
            {deletesAll ? "确认全部删除" : "确认清空进度"}
          </button>
        </div>
      </section>
    </div>
  );
}

function useModalInitialFocus(dialogRef: React.RefObject<HTMLElement | null>) {
  useEffect(() => {
    const previous = document.activeElement instanceof HTMLElement
      ? document.activeElement
      : null;
    dialogRef.current?.querySelector<HTMLElement>("button:not(:disabled)")?.focus();
    return () => previous?.focus();
  }, [dialogRef]);
}

function handleModalKeyDown(
  event: React.KeyboardEvent<HTMLElement>,
  onCancel: () => void,
) {
  if (event.key === "Escape") {
    event.preventDefault();
    onCancel();
    return;
  }
  if (event.key !== "Tab") return;
  const controls = [
    ...event.currentTarget.querySelectorAll<HTMLElement>(
      'button:not(:disabled), select:not(:disabled), [tabindex]:not([tabindex="-1"])',
    ),
  ];
  if (controls.length === 0) return;
  const current = controls.indexOf(document.activeElement as HTMLElement);
  const next = event.shiftKey
    ? current <= 0
      ? controls.length - 1
      : current - 1
    : current === controls.length - 1
      ? 0
      : current + 1;
  event.preventDefault();
  controls[next]?.focus();
}

function sourceKindLabel(kind: LearningDataSummary["sources"][number]["sourceKind"]) {
  return {
    user_import: "用户导入内容",
    authorized: "已授权内容",
    open_data: "开放数据",
  }[kind];
}

function legacyEditionLabel(edition: LegacyLearningEdition) {
  return edition === "preview" ? "学习预览版" : "旧个人版";
}

function legacySourceStatusLabel(source: LegacyLearningSourceSummary) {
  if (source.status === "invalid") return "检测到数据库，但无法安全读取";
  if (source.status === "already_migrated") {
    return `已迁移 · ${source.cardCount} 张卡片 · ${source.reviewCount} 条复习记录`;
  }
  return `可迁移 · schema ${source.sourceSchemaVersion ?? "?"} · ${source.cardCount} 张卡片 · ${source.reviewCount} 条复习记录`;
}

function formatLocalTime(unixMs: number) {
  return new Intl.DateTimeFormat("zh-CN", {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(new Date(unixMs));
}

function formatLocalDate(unixMs: number) {
  return new Intl.DateTimeFormat("zh-CN", {
    month: "numeric",
    day: "numeric",
  }).format(new Date(unixMs));
}

function formatDashboardDay(localDay: string) {
  const [, month, day] = localDay.split("-").map(Number);
  return Number.isFinite(month) && Number.isFinite(day) ? `${month}/${day}` : localDay;
}

function estimateRoundMinutes(cardCount: number, averageResponseMs: number | null) {
  const secondsPerCard = Math.max(10, Math.round((averageResponseMs ?? 10_000) / 1_000) + 4);
  return Math.max(1, Math.ceil((cardCount * secondsPerCard) / 60));
}

function formatDuration(seconds: number) {
  if (seconds < 60) return `${Math.max(1, seconds)} 秒`;
  return `${Math.floor(seconds / 60)}分${String(seconds % 60).padStart(2, "0")}秒`;
}

function recordFilterLabel(filter: LearningRecordFilter) {
  return {
    mistakes: "错题订正",
    studied: "学习过的词",
    new: "尚未学习",
    learning: "学习中的词",
    stable: "稳定掌握",
    all: "全部词汇",
  }[filter];
}

function mistakeStatusLabel(status: NonNullable<LearningRecordPage["items"][number]["mistakeStatus"]>) {
  return {
    needs_correction: "待订正",
    pending_recheck: "已订正，待复查",
    consolidated: "已巩固",
  }[status];
}

function dashboardInsight(
  dashboard: LearningDashboardSnapshot,
  accuracy: number | null,
) {
  if (dashboard.mistakeCount > 0) {
    return `有 ${dashboard.mistakeCount} 个错题等待订正，建议先巩固再学新词。`;
  }
  if (dashboard.pendingRecheckCount > 0) {
    return `${dashboard.pendingRecheckCount} 个错题已经订正，${getPetSnapshot().nickname}会在到期复习时再次验证。`;
  }
  if (accuracy !== null) {
    return `近 7 天首答正确率 ${accuracy}%，学习节奏会按到期复习自动安排。`;
  }
  return "完成第一轮后，这里会给出学习节奏和下一步建议。";
}

function stageLabel(stage: LearningCardDto["stage"]) {
  return { new: "新卡", learning: "学习中", stable: "较稳定" }[stage];
}

function learningOperationMessage(operation: LearningOperation) {
  return {
    import_picker: "正在等待系统文件窗口；如果没有看到，请查看任务栏。",
    import_commit: "正在把所选内容写入本机学习库，请稍候。",
    export_picker: "正在等待导出位置；如果没有看到文件窗口，请查看任务栏。",
    legacy_migration: "正在只读核查旧版数据或执行已确认迁移，请稍候。",
    delete: "正在处理本机学习数据，请稍候。",
  }[operation];
}

function learningImportProgressMessage(
  progress: LearningImportProgress,
  operation: LearningOperation,
) {
  const phase = {
    reading_input: "正在读取本地文件",
    validating_input: "正在检查文件安全性",
    validating_text: "正在检查文字内容",
    scanning_syntax: "正在检查内容结构",
    decoding: "正在解析知识卡",
    validating_structure: "正在核对知识包结构",
    validating_cards: "正在逐张核对知识卡",
    finalizing: operation === "import_commit" ? "正在准备写入本机学习库" : "正在生成导入预览",
    complete: "导入已完成",
  }[progress.phase];
  const percent = progress.totalUnits && progress.totalUnits > 0
    ? Math.min(100, Math.round((progress.completedUnits / progress.totalUnits) * 100))
    : null;
  return percent === null ? `${phase}…` : `${phase}（${percent}%）`;
}

function learningErrorMessage(reason: unknown) {
  const message =
    typeof reason === "string"
      ? reason.trim()
      : reason instanceof Error
        ? reason.message.trim()
        : "";
  if (message.includes("learning startup cleanup failed")) {
    return "学习启动后的状态清理未完成，请重新打开学习页核对上一轮后再试";
  }
  if (message.includes("a higher priority presentation is active")) {
    return "当前有优先展示的提醒或活动，请处理完后再试";
  }
  if (message.includes("a learning session is already active or resumable")) {
    return "上一轮还未结束，请先继续或结束上一轮";
  }
  if (message.includes("no unresolved learning mistakes are currently available")) {
    return "目前没有待订正错题，已订正的词会在到期后复查";
  }
  if (message.includes("no learning cards are currently available")) {
    return "词库已经学完，目前也没有到期复习";
  }
  if (message) return message;
  return "发生了未预期错误，请稍后重试";
}

function learningImportWasCancelled(reason: unknown) {
  const message =
    typeof reason === "string"
      ? reason
      : reason instanceof Error
        ? reason.message
        : "";
  return message.includes("learning import was cancelled");
}
