import type {
  LearningAnswerResult,
  LearningCardDto,
  LearningDataSummary,
  LearningDashboardSnapshot,
  LearningDeleteResult,
  LearningDeleteScope,
  LearningHomeSnapshot,
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
} from "../types";

const cards: LearningCardDto[] = [
  {
    schemaVersion: 1,
    cardId: "demo-address",
    headword: "address",
    phonetic: "/əˈdres/",
    partOfSpeech: ["v.", "n."],
    meaningsZh: ["处理；设法解决", "地址"],
    wordFamily: ["addressable", "addressee"],
    stage: "learning",
    sourceIds: ["demo.local"],
  },
  {
    schemaVersion: 1,
    cardId: "demo-subject",
    headword: "subject",
    phonetic: "/ˈsʌbdʒɪkt/",
    partOfSpeech: ["n.", "adj."],
    meaningsZh: ["主题；研究对象", "易受……影响的"],
    wordFamily: ["subjective", "subjection"],
    stage: "new",
    sourceIds: ["demo.local"],
  },
  {
    schemaVersion: 1,
    cardId: "demo-account",
    headword: "account",
    phonetic: "/əˈkaʊnt/",
    partOfSpeech: ["n.", "v."],
    meaningsZh: ["解释；说明", "账户"],
    wordFamily: ["accountable", "accounting"],
    stage: "stable",
    sourceIds: ["demo.local"],
  },
];

function defaultSettings(): LearningSettings {
  return {
    mode: "manual_only",
    cardsPerSession: 3,
    dailyNewLimit: 5,
    dailyGoal: 0,
    focusFinishedEnabled: true,
    scheduledWindowsEnabled: false,
    workGapExperimentalEnabled: false,
    dailyInvitationLimit: 2,
    invitationCooldownMinutes: 120,
    invitationTtlSeconds: 20,
    pausedForLocalDay: null,
    updatedAtUnixMs: Date.now(),
  };
}

let settings = defaultSettings();

let activeSession: LearningSessionSnapshot | null = null;
let queue: LearningCardDto[] = [];
let queueIndex = 0;
let reviews = 4;
let completedSessions = 1;
let contentAvailable = true;
const recordStats = new Map<
  string,
  {
    correct: number;
    wrong: number;
    originalCorrect: number;
    originalCount: number;
    lastStudied: number;
    lastWrong: number | null;
    latest: "correct" | "incorrect";
    latestOriginal: "correct" | "incorrect";
    mistakeStatus: "needs_correction" | "pending_recheck" | "consolidated" | null;
  }
>();
const sessionStats = new Map<
  string,
  {
    session: LearningSessionSnapshot;
    correct: number;
    wrong: number;
    responseTotalMs: number;
    responseCount: number;
    newCount: number;
    wrongCardIds: string[];
  }
>();

export async function getLearningHome(): Promise<LearningHomeSnapshot> {
  const newCards = cards.filter((card) => card.stage === "new");
  const newStudiedTodayCount = newCards.filter((card) => recordStats.has(card.cardId)).length;
  const newAvailableCount = contentAvailable
    ? newCards.length - newStudiedTodayCount
    : 0;
  return {
    schemaVersion: 1,
    capabilities: {
      compiled: true,
      available: true,
      contentPackReady: contentAvailable,
      autoInvitationAvailable: false,
      failureReason: null,
    },
    dueCount: contentAvailable ? 2 : 0,
    newAvailableCount,
    newRemainingCount: newAvailableCount,
    newStudiedTodayCount,
    mistakeCount: [...recordStats.values()].filter((item) => item.mistakeStatus === "needs_correction").length,
    pendingRecheckCount: [...recordStats.values()].filter((item) => item.mistakeStatus === "pending_recheck").length,
    stableCount: contentAvailable ? 1 : 0,
    tomorrowDueCount: contentAvailable ? 2 : 0,
    averageResponseMs: 8_500,
    reviewsLast7Days: reviews,
    completedSessionsLast7Days: completedSessions,
    settings: structuredClone(settings),
    activeSession: activeSession ? structuredClone(activeSession) : null,
  };
}

export async function getLearningDashboard(): Promise<LearningDashboardSnapshot> {
  const mistakeIds = new Set(
    [...recordStats.entries()]
      .filter(([, item]) => item.mistakeStatus === "needs_correction")
      .map(([cardId]) => cardId),
  );
  const mistakeCount = mistakeIds.size;
  const pendingRecheckCount = [...recordStats.values()].filter(
    (item) => item.mistakeStatus === "pending_recheck",
  ).length;
  const answered = [...recordStats.values()].reduce(
    (sum, item) => sum + item.originalCount,
    0,
  );
  const correct = [...recordStats.values()].reduce(
    (sum, item) => sum + item.originalCorrect,
    0,
  );
  const newCount = contentAvailable
    ? cards.filter((item) => item.stage === "new" && !recordStats.has(item.cardId)).length
    : 0;
  const stableCount = contentAvailable
    ? cards.filter((item) => item.stage === "stable" && !mistakeIds.has(item.cardId)).length
    : 0;
  const learningCount = contentAvailable
    ? Math.max(0, cards.length - newCount - stableCount - mistakeCount - pendingRecheckCount)
    : 0;
  return {
    schemaVersion: 1,
    totalCount: contentAvailable ? cards.length : 0,
    studiedCount: contentAvailable ? cards.length - newCount : 0,
    newCount,
    learningCount,
    mistakeCount,
    pendingRecheckCount,
    stableCount,
    correctedMistakeCount: [...recordStats.values()].filter(
      (item) => item.mistakeStatus === "consolidated",
    ).length,
    firstAnswerCorrectCount7Days: correct,
    firstAnswerCount7Days: answered,
    days: Array.from({ length: 7 }, (_, index) => ({
      localDay: localDayOffset(6 - index),
      newCount: index === 6 ? Math.min(1, answered) : 0,
      reviewCount: index === 6 ? answered : 0,
      firstAnswerCorrectCount: index === 6 ? correct : 0,
      firstAnswerCount: index === 6 ? answered : 0,
    })),
  };
}

export async function updateLearningSettings(
  patch: LearningSettingsPatch,
): Promise<LearningSettings> {
  settings = { ...settings, ...patch, updatedAtUnixMs: Date.now() };
  return structuredClone(settings);
}

export async function startManualLearningSession(
  cardCount: 3 | 5 | 10,
  sessionKind: LearningSessionKind = "daily",
  sourceSessionId: string | null = null,
): Promise<LearningSessionSnapshot> {
  if (!contentAvailable) throw new Error("还没有可复习的本机词表");
  if (activeSession && ["created", "active", "paused"].includes(activeSession.status)) {
    throw new Error("已有学习会话正在进行或等待继续");
  }
  const targetedIds = sourceSessionId
    ? new Set(sessionStats.get(sourceSessionId)?.wrongCardIds ?? [])
    : null;
  const candidates = sessionKind === "mistakes"
    ? cards.filter((item) =>
        recordStats.get(item.cardId)?.mistakeStatus === "needs_correction"
        && (!targetedIds || targetedIds.has(item.cardId)),
      )
    : cards;
  queue = candidates.slice(0, Math.min(cardCount, candidates.length));
  if (queue.length === 0) throw new Error("当前没有待巩固错题");
  queueIndex = 0;
  const startedAtUnixMs = Date.now();
  activeSession = {
    schemaVersion: 1,
    sessionId: crypto.randomUUID(),
    entrySource: "manual",
    sessionKind,
    status: "active",
    stateRevision: 2,
    currentItemId: queue[0]?.cardId ?? null,
    plannedCount: queue.length,
    completedCount: 0,
    startedAtUnixMs,
    pausedAtUnixMs: null,
    pauseReason: null,
    lastActivityAtUnixMs: startedAtUnixMs,
    expiresAtUnixMs: startedAtUnixMs + 86_400_000,
    endedAtUnixMs: null,
    exitReason: null,
  };
  sessionStats.set(activeSession.sessionId, {
    session: structuredClone(activeSession),
    correct: 0,
    wrong: 0,
    responseTotalMs: 0,
    responseCount: 0,
    newCount: queue.filter((card) => card.stage === "new").length,
    wrongCardIds: [],
  });
  return structuredClone(activeSession);
}

export async function getCurrentLearningCard(
  sessionId: string,
): Promise<LearningCardDto> {
  requireActive(sessionId);
  const current = queue[queueIndex];
  if (!current) throw new Error("当前没有待复习卡片");
  return structuredClone(current);
}

export async function getCurrentLearningQuestion(
  sessionId: string,
): Promise<LearningQuestionDto> {
  const current = await getCurrentLearningCard(sessionId);
  const isRemediation = false;
  const questionId = `demo-question-${sessionId}-${current.cardId}-${isRemediation ? "retry" : "first"}`;
  const optionCards = [
    current,
    ...cards.filter((item) => item.cardId !== current.cardId),
  ].slice(0, 4);
  return {
    schemaVersion: 1,
    questionId,
    kind: optionCards.length >= 2 ? "multiple_choice" : "recall_fallback",
    cardId: current.cardId,
    headword: current.headword,
    phonetic: current.phonetic,
    partOfSpeech: current.partOfSpeech,
    stage: current.stage,
    isRemediation,
    options: optionCards.map((item) => ({
      optionId: `${questionId}-${item.cardId}`,
      meaningZh: item.meaningsZh.join("；"),
    })),
  };
}

export async function answerLearningQuestion(
  sessionId: string,
  questionId: string,
  selectedOptionId: string,
  _clientAnswerId: string,
  responseMs: number | null,
): Promise<LearningAnswerResult> {
  const question = await getCurrentLearningQuestion(sessionId);
  if (question.questionId !== questionId) throw new Error("题目已经变化，请重新选择");
  const correctOptionId = `${questionId}-${question.cardId}`;
  if (!question.options.some((option) => option.optionId === selectedOptionId)) {
    throw new Error("答案不属于当前题目");
  }
  const correct = selectedOptionId === correctOptionId;
  const now = Date.now();
  const previous = recordStats.get(question.cardId) ?? {
    correct: 0,
    wrong: 0,
    originalCorrect: 0,
    originalCount: 0,
    lastStudied: now,
    lastWrong: null,
    latest: "correct" as const,
    latestOriginal: "correct" as const,
    mistakeStatus: null,
  };
  const nextMistakeStatus = correct
    ? previous.wrong === 0
      ? null
      : activeSession?.sessionKind === "mistakes"
        ? "pending_recheck" as const
        : "consolidated" as const
    : "needs_correction" as const;
  recordStats.set(question.cardId, {
    correct: previous.correct + (correct ? 1 : 0),
    wrong: previous.wrong + (correct ? 0 : 1),
    originalCorrect: previous.originalCorrect + (!question.isRemediation && correct ? 1 : 0),
    originalCount: previous.originalCount + (question.isRemediation ? 0 : 1),
    lastStudied: now,
    lastWrong: correct ? previous.lastWrong : now,
    latest: correct ? "correct" : "incorrect",
    latestOriginal: question.isRemediation
      ? previous.latestOriginal
      : correct ? "correct" : "incorrect",
    mistakeStatus: nextMistakeStatus,
  });
  if (!question.isRemediation) {
    activeSession = {
      ...activeSession!,
      completedCount: activeSession!.completedCount + 1,
      stateRevision: activeSession!.stateRevision + 1,
      lastActivityAtUnixMs: now,
      expiresAtUnixMs: now + 86_400_000,
    };
    reviews += 1;
    const stats = sessionStats.get(sessionId)!;
    stats.correct += correct ? 1 : 0;
    stats.wrong += correct ? 0 : 1;
    stats.responseTotalMs += responseMs ?? 0;
    stats.responseCount += responseMs == null ? 0 : 1;
    if (!correct && !stats.wrongCardIds.includes(question.cardId)) {
      stats.wrongCardIds.push(question.cardId);
    }
  }
  queueIndex += 1;
  if (queueIndex >= queue.length) {
    activeSession = {
      ...activeSession!,
      status: "completed",
      currentItemId: null,
      expiresAtUnixMs: now,
      endedAtUnixMs: now,
    };
  } else {
    activeSession = {
      ...activeSession!,
      currentItemId: queue[queueIndex]?.cardId ?? null,
    };
    completedSessions += 1;
  }
  const stored = sessionStats.get(sessionId);
  if (stored) stored.session = structuredClone(activeSession!);
  return {
    schemaVersion: 1,
    questionId,
    selectedOptionId,
    correctOptionId,
    correctMeaningZh: queue[Math.max(0, queueIndex - 1)]!.meaningsZh.join("；"),
    correct,
    isRemediation: question.isRemediation,
    replayed: false,
    session: structuredClone(activeSession!),
  };
}

export async function getLearningSessionSummary(
  sessionId: string,
): Promise<LearningSessionSummary> {
  const stats = sessionStats.get(sessionId);
  if (!stats) throw new Error("学习会话不存在");
  const session = stats.session;
  const endedAt = session.endedAtUnixMs ?? Date.now();
  return {
    schemaVersion: 1,
    session: structuredClone(session),
    correctCount: stats.correct,
    wrongCount: stats.wrong,
    newCount: stats.newCount,
    reviewCount: Math.max(0, stats.correct + stats.wrong - stats.newCount),
    durationSeconds: Math.max(0, Math.round((endedAt - session.startedAtUnixMs) / 1_000)),
    averageResponseMs: stats.responseCount > 0
      ? Math.round(stats.responseTotalMs / stats.responseCount)
      : null,
    targetableWrongCount: stats.wrongCardIds.filter(
      (cardId) => recordStats.get(cardId)?.mistakeStatus === "needs_correction",
    ).length,
  };
}

function localDayOffset(daysAgo: number): string {
  const date = new Date();
  date.setHours(12, 0, 0, 0);
  date.setDate(date.getDate() - daysAgo);
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${date.getFullYear()}-${month}-${day}`;
}

export async function rateLearningCard(
  sessionId: string,
  cardId: string,
  _rating: LearningRating,
  expectedRevision: number,
): Promise<LearningRateResult> {
  requireActive(sessionId);
  if (activeSession!.stateRevision !== expectedRevision) {
    throw new Error("学习会话版本已变化");
  }
  const current = queue[queueIndex];
  if (!current || current.cardId !== cardId) throw new Error("评分卡片已过期");
  activeSession = {
    ...activeSession!,
    completedCount: activeSession!.completedCount + 1,
    stateRevision: activeSession!.stateRevision + 1,
    lastActivityAtUnixMs: Date.now(),
    expiresAtUnixMs: Date.now() + 86_400_000,
  };
  reviews += 1;
  queueIndex += 1;
  if (activeSession.completedCount >= activeSession.plannedCount) {
    activeSession = {
      ...activeSession,
      status: "completed",
      currentItemId: null,
      expiresAtUnixMs: Date.now(),
      endedAtUnixMs: Date.now(),
    };
    completedSessions += 1;
  }
  return {
    schemaVersion: 1,
    session: structuredClone(activeSession),
    nextCard:
      activeSession.status === "active"
        ? structuredClone(queue[activeSession.completedCount])
        : null,
  };
}

export async function finishLearningSession(
  sessionId: string,
  exitReason: "user_exit" | "content_unavailable" | "completed",
  expectedRevision: number,
): Promise<LearningSessionSnapshot> {
  if (!activeSession || activeSession.sessionId !== sessionId) {
    throw new Error("学习会话不存在");
  }
  if (activeSession.stateRevision !== expectedRevision) {
    throw new Error("学习会话版本已变化");
  }
  if (exitReason === "completed" && activeSession.status !== "completed") {
    throw new Error("学习会话尚未完成");
  }
  if (["created", "active", "paused"].includes(activeSession.status)) {
    const now = Date.now();
    activeSession = {
      ...activeSession,
      status: "abandoned",
      stateRevision: activeSession.stateRevision + 1,
      currentItemId: null,
      pausedAtUnixMs: null,
      pauseReason: null,
      lastActivityAtUnixMs: now,
      expiresAtUnixMs: now,
      endedAtUnixMs: now,
      exitReason,
    };
  }
  return structuredClone(activeSession);
}

export async function getResumableLearningSession(): Promise<LearningSessionSnapshot | null> {
  if (!activeSession || !["created", "active", "paused"].includes(activeSession.status)) {
    return null;
  }
  return structuredClone(activeSession);
}

export async function pauseLearningSession(
  sessionId: string,
  expectedRevision: number,
  reason: "user_pause",
): Promise<LearningSessionSnapshot> {
  requireActive(sessionId);
  if (activeSession!.stateRevision !== expectedRevision) throw new Error("学习会话版本已变化");
  const now = Date.now();
  activeSession = {
    ...activeSession!,
    status: "paused",
    stateRevision: activeSession!.stateRevision + 1,
    pausedAtUnixMs: now,
    pauseReason: reason,
    lastActivityAtUnixMs: now,
    expiresAtUnixMs: now + 86_400_000,
  };
  return structuredClone(activeSession);
}

export async function resumeLearningSession(
  sessionId: string,
  expectedRevision: number,
): Promise<LearningSessionSnapshot> {
  if (!activeSession || activeSession.sessionId !== sessionId) throw new Error("学习会话不存在");
  if (!["created", "paused"].includes(activeSession.status)) throw new Error("学习会话不能继续");
  if (activeSession.stateRevision !== expectedRevision) throw new Error("学习会话版本已变化");
  const now = Date.now();
  activeSession = {
    ...activeSession,
    status: "active",
    stateRevision: activeSession.stateRevision + 1,
    currentItemId: queue[queueIndex]?.cardId ?? null,
    pausedAtUnixMs: null,
    pauseReason: null,
    lastActivityAtUnixMs: now,
    expiresAtUnixMs: now + 86_400_000,
    endedAtUnixMs: null,
    exitReason: null,
  };
  return structuredClone(activeSession);
}

export async function abandonLearningSession(
  sessionId: string,
  expectedRevision: number,
): Promise<LearningSessionSnapshot> {
  return finishLearningSession(sessionId, "user_exit", expectedRevision);
}

function requireActive(sessionId: string) {
  if (
    !activeSession ||
    activeSession.sessionId !== sessionId ||
    activeSession.status !== "active"
  ) {
    throw new Error("学习会话已结束或不可用");
  }
}

export async function getLearningDataSummary(): Promise<LearningDataSummary> {
  return {
    schemaVersion: 1,
    cardCount: contentAvailable ? cards.length : 0,
    reviewCount: reviews,
    lastSuccessfulExportAtUnixMs: null,
    sources: contentAvailable
      ? [
          {
            sourceId: "demo.local",
            sourceKind: "user_import",
            version: "demo",
            sourceUrl: null,
            licenseExpression: null,
            noticeText: "浏览器内存演示数据，不会写入本机。",
          },
        ]
      : [],
    packs: contentAvailable
      ? [
          {
            packId: "demo.local",
            title: "开发演示词表",
            examScope: "通用英语演示",
            status: "ready",
          },
        ]
      : [],
  };
}

export async function listLearningRecords(
  filter: LearningRecordFilter,
  query: string,
  page: number,
  pageSize: number,
): Promise<LearningRecordPage> {
  const normalized = query.trim().toLocaleLowerCase();
  const filtered = cards.filter((card) => {
    const stats = recordStats.get(card.cardId);
    const included = filter === "all"
      || (filter === "mistakes" ? stats?.mistakeStatus === "needs_correction" || stats?.mistakeStatus === "pending_recheck"
        : filter === "new" ? card.stage === "new"
          : filter === "learning" ? card.stage === "learning"
        : filter === "stable" ? card.stage === "stable"
          : Boolean(stats));
    return included && (!normalized || `${card.headword} ${card.meaningsZh.join(" ")}`.toLocaleLowerCase().includes(normalized));
  });
  return {
    schemaVersion: 1,
    filter,
    query: query.trim(),
    page,
    pageSize,
    total: filtered.length,
    items: filtered.slice(page * pageSize, (page + 1) * pageSize).map((card) => {
      const stats = recordStats.get(card.cardId);
      return {
        cardId: card.cardId,
        headword: card.headword,
        phonetic: card.phonetic,
        partOfSpeech: card.partOfSpeech,
        meaningsZh: card.meaningsZh,
        stage: card.stage,
        dueAtUnixMs: Date.now(),
        reviewCount: (stats?.correct ?? 0) + (stats?.wrong ?? 0),
        correctCount: stats?.correct ?? 0,
        wrongCount: stats?.wrong ?? 0,
        lastStudiedAtUnixMs: stats?.lastStudied ?? null,
        lastWrongAtUnixMs: stats?.lastWrong ?? null,
        latestOutcome: stats?.latest ?? null,
        mistakeStatus: stats?.mistakeStatus ?? null,
      };
    }),
  };
}

export async function deleteLearningData(
  scope: LearningDeleteScope,
  confirmation: string,
): Promise<LearningDeleteResult> {
  const expected =
    scope === "progress_only"
      ? "CLEAR LEARNING PROGRESS"
      : "DELETE ALL LEARNING DATA";
  if (confirmation !== expected) throw new Error("删除确认不匹配");
  const deletedReviewCount = reviews;
  reviews = 0;
  completedSessions = 0;
  activeSession = null;
  queue = [];
  queueIndex = 0;
  recordStats.clear();
  sessionStats.clear();
  if (scope === "all_learning_data") {
    contentAvailable = false;
    settings = defaultSettings();
  }
  return {
    schemaVersion: 1,
    scope,
    keptCardCount: contentAvailable ? cards.length : 0,
    deletedReviewCount,
  };
}
