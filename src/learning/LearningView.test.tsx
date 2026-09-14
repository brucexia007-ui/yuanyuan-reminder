// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const backend = vi.hoisted(() => ({
  abandonLearningSession: vi.fn(),
  answerLearningQuestion: vi.fn(),
  cancelLearningImport: vi.fn(),
  confirmLearningImport: vi.fn(),
  confirmLegacyLearningMigration: vi.fn(),
  deleteLearningData: vi.fn(),
  exportLearningData: vi.fn(),
  getCurrentLearningCard: vi.fn(),
  getCurrentLearningQuestion: vi.fn(),
  getLearningDataSummary: vi.fn(),
  getLearningDashboard: vi.fn(),
  getLearningHome: vi.fn(),
  getLearningSessionSummary: vi.fn(),
  listLearningRecords: vi.fn(),
  listLegacyLearningSources: vi.fn(),
  pauseLearningSession: vi.fn(),
  previewLearningImport: vi.fn(),
  previewLegacyLearningMigration: vi.fn(),
  rateLearningCard: vi.fn(),
  resumeLearningSession: vi.fn(),
  startManualLearningSession: vi.fn(),
  updateLearningSettings: vi.fn(),
}));
const runtime = vi.hoisted(() => ({
  tauriAvailable: vi.fn(() => false),
  onBackendEvent: vi.fn(async () => () => undefined),
}));

vi.mock("./backend", () => backend);
vi.mock("../lib/backend", () => runtime);

import type {
  LearningCardDto,
  LearningDashboardSnapshot,
  LearningDataSummary,
  LearningHomeSnapshot,
  LearningQuestionDto,
  LearningSessionSnapshot,
  LearningSessionSummary,
} from "../types";
import {
  LEARNING_PACK_AGENT_PROMPT,
  LEARNING_PACK_TEMPLATE_FILENAME,
  LearningView,
} from "./LearningView";

it("downloads the learning-pack template with an importable file suffix", () => {
  expect(LEARNING_PACK_TEMPLATE_FILENAME.endsWith(".learning-pack.json")).toBe(true);
});

it("copies a branded agent prompt with exact repository-local input paths", () => {
  expect(LEARNING_PACK_AGENT_PROMPT).toContain("圆圆提醒 learning-pack v1 JSON");
  expect(LEARNING_PACK_AGENT_PROMPT).toContain(
    "customization/learning/LEARNING_IMPORT_PROMPT.zh-CN.md",
  );
  expect(LEARNING_PACK_AGENT_PROMPT).not.toContain("饺饺提醒");
});

const session: LearningSessionSnapshot = {
  schemaVersion: 1,
  sessionId: "session-1",
  entrySource: "manual",
  sessionKind: "daily",
  status: "active",
  stateRevision: 2,
  currentItemId: "card-1",
  plannedCount: 1,
  completedCount: 0,
  startedAtUnixMs: 1_800_000_000_000,
  pausedAtUnixMs: null,
  pauseReason: null,
  lastActivityAtUnixMs: 1_800_000_000_000,
  expiresAtUnixMs: 1_800_086_400_000,
  endedAtUnixMs: null,
  exitReason: null,
};

const card: LearningCardDto = {
  schemaVersion: 1,
  cardId: "card-1",
  headword: "address",
  phonetic: "/əˈdres/",
  partOfSpeech: ["v."],
  meaningsZh: ["处理；设法解决"],
  wordFamily: ["addressable"],
  stage: "learning",
  sourceIds: ["user.local"],
};

const question: LearningQuestionDto = {
  schemaVersion: 1,
  questionId: "question-1",
  kind: "multiple_choice",
  cardId: "card-1",
  headword: "address",
  phonetic: "/əˈdres/",
  partOfSpeech: ["v."],
  stage: "learning",
  isRemediation: false,
  options: [
    { optionId: "option-correct", meaningZh: "处理；设法解决" },
    { optionId: "option-wrong", meaningZh: "树木；木材" },
  ],
};

const remediationQuestion: LearningQuestionDto = {
  ...question,
  questionId: "question-1-remediation",
  isRemediation: true,
};

const home: LearningHomeSnapshot = {
  schemaVersion: 1,
  capabilities: {
    compiled: true,
    available: true,
    contentPackReady: true,
    autoInvitationAvailable: false,
    failureReason: null,
  },
  dueCount: 1,
  newAvailableCount: 0,
  newRemainingCount: 0,
  newStudiedTodayCount: 0,
  mistakeCount: 0,
  pendingRecheckCount: 0,
  stableCount: 0,
  tomorrowDueCount: 2,
  averageResponseMs: 8_500,
  reviewsLast7Days: 2,
  completedSessionsLast7Days: 1,
  settings: {
    mode: "manual_only",
    cardsPerSession: 5,
    dailyNewLimit: 5,
    dailyGoal: 0,
    focusFinishedEnabled: true,
    scheduledWindowsEnabled: false,
    workGapExperimentalEnabled: false,
    dailyInvitationLimit: 2,
    invitationCooldownMinutes: 120,
    invitationTtlSeconds: 20,
    pausedForLocalDay: null,
    updatedAtUnixMs: 1,
  },
  activeSession: null,
};

const dataSummary: LearningDataSummary = {
  schemaVersion: 1,
  cardCount: 1,
  reviewCount: 2,
  lastSuccessfulExportAtUnixMs: null,
  sources: [
    {
      sourceId: "user.local",
      sourceKind: "user_import",
      version: "v1",
      sourceUrl: null,
      licenseExpression: null,
      noticeText: null,
    },
  ],
  packs: [
    {
      packId: "pack-1",
      title: "我的词表",
      examScope: "考研英语·用户导入",
      status: "ready",
    },
  ],
};

const sessionSummary: LearningSessionSummary = {
  schemaVersion: 1,
  session: {
    ...session,
    status: "completed",
    completedCount: 1,
    endedAtUnixMs: 1_800_000_030_000,
  },
  correctCount: 1,
  wrongCount: 0,
  newCount: 0,
  reviewCount: 1,
  durationSeconds: 30,
  averageResponseMs: 8_000,
  targetableWrongCount: 0,
};

const dashboard: LearningDashboardSnapshot = {
  schemaVersion: 1,
  totalCount: 4_533,
  studiedCount: 12,
  newCount: 4_521,
  learningCount: 6,
  mistakeCount: 2,
  pendingRecheckCount: 1,
  stableCount: 4,
  correctedMistakeCount: 1,
  firstAnswerCorrectCount7Days: 8,
  firstAnswerCount7Days: 10,
  days: [
    ["2026-08-07", 0, 0],
    ["2026-08-08", 1, 1],
    ["2026-08-09", 2, 3],
    ["2026-08-10", 1, 2],
    ["2026-08-11", 2, 2],
    ["2026-08-12", 1, 1],
    ["2026-08-13", 3, 4],
  ].map(([localDay, newCount, reviewCount]) => ({
    localDay: String(localDay),
    newCount: Number(newCount),
    reviewCount: Number(reviewCount),
    firstAnswerCorrectCount: 1,
    firstAnswerCount: 1,
  })),
};

let container: HTMLDivElement;
let root: Root;

async function flush() {
  await act(async () => {
    await new Promise((resolve) => window.setTimeout(resolve, 0));
  });
}

function button(label: string) {
  return [...container.querySelectorAll("button")].find(
    (item) => item.textContent?.trim() === label,
  )!;
}

function details(label: string) {
  return [...container.querySelectorAll("details")].find(
    (item) => item.querySelector("summary")?.textContent?.trim() === label,
  )!;
}

describe("learning micro-session", () => {
  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    runtime.tauriAvailable.mockReturnValue(false);
    backend.getLearningHome.mockResolvedValue(structuredClone(home));
    backend.getLearningDashboard.mockResolvedValue(structuredClone(dashboard));
    backend.getLearningDataSummary.mockResolvedValue(structuredClone(dataSummary));
    backend.listLegacyLearningSources.mockResolvedValue([
      {
        schemaVersion: 1,
        edition: "preview",
        status: "missing",
        sourceSchemaVersion: null,
        cardCount: 0,
        reviewCount: 0,
        failureReason: null,
      },
      {
        schemaVersion: 1,
        edition: "personal",
        status: "missing",
        sourceSchemaVersion: null,
        cardCount: 0,
        reviewCount: 0,
        failureReason: null,
      },
    ]);
    backend.getLearningSessionSummary.mockResolvedValue(structuredClone(sessionSummary));
    backend.startManualLearningSession.mockResolvedValue(structuredClone(session));
    backend.getCurrentLearningCard.mockResolvedValue(structuredClone(card));
    backend.getCurrentLearningQuestion.mockResolvedValue(structuredClone(question));
    backend.listLearningRecords.mockResolvedValue({
      schemaVersion: 1,
      filter: "mistakes",
      query: "",
      page: 0,
      pageSize: 20,
      total: 0,
      items: [],
    });
    backend.abandonLearningSession.mockResolvedValue({
      ...session,
      status: "abandoned",
      endedAtUnixMs: 2,
      exitReason: "user_exit",
    });
    backend.exportLearningData.mockResolvedValue({
      schemaVersion: 1,
      status: "cancelled",
      format: "native_json",
      recordCount: 0,
      bytes: 0,
      exportedAtUnixMs: null,
      selectedPathReturned: false,
    });
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    vi.clearAllMocks();
  });

  it("keeps active learning available after five new words because five is a round size", async () => {
    backend.getLearningHome.mockResolvedValue({
      ...structuredClone(home),
      dueCount: 0,
      newAvailableCount: 4_528,
      newRemainingCount: 4_528,
      newStudiedTodayCount: 5,
      settings: {
        ...structuredClone(home.settings),
        cardsPerSession: 5,
      },
    });

    await act(async () => root.render(<LearningView />));
    await flush();

    expect(container.textContent).toContain("想学就再来一轮");
    expect(container.textContent).toContain("5今日已学");
    expect(container.textContent).toContain("没有每日上限");
    const startButton = button("开始一轮 · 5 个 · 约 2 分钟");
    expect(startButton.disabled).toBe(false);

    await act(async () => startButton.click());
    expect(backend.startManualLearningSession).toHaveBeenCalledWith(5, "daily", null);
  });

  it("saves a daily soft goal without turning it into a learning cap", async () => {
    const refreshed = {
      ...structuredClone(home),
      settings: {
        ...structuredClone(home.settings),
        dailyGoal: 10 as const,
      },
    };
    backend.getLearningHome
      .mockResolvedValueOnce(structuredClone(home))
      .mockResolvedValue(refreshed);
    backend.updateLearningSettings.mockResolvedValue(refreshed.settings);

    await act(async () => root.render(<LearningView />));
    await flush();

    const settingsDetails = details("学习与防打扰设置");
    await act(async () => settingsDetails.querySelector("summary")!.click());
    const goalSelect = [...settingsDetails.querySelectorAll("select")].find(
      (item) => item.value === "0",
    )!;
    await act(async () => {
      goalSelect.value = "10";
      goalSelect.dispatchEvent(new Event("change", { bubbles: true }));
    });
    await flush();

    expect(backend.updateLearningSettings).toHaveBeenCalledWith({
      dailyGoal: 10,
    });
    expect(backend.getLearningHome).toHaveBeenCalledTimes(2);
    expect(button("开始一轮 · 1 个 · 约 2 分钟").disabled).toBe(false);
    expect(container.textContent).toContain("0/10今日软目标");
  });

  it("explains first use and disables file operations in browser preview", async () => {
    await act(async () => root.render(<LearningView />));
    await flush();

    expect(container.textContent).toContain("第一次用？1 分钟了解");
    expect(container.textContent).toContain("没有每日上限");

    const settingsDetails = details("学习与防打扰设置");
    await act(async () => settingsDetails.querySelector("summary")!.click());
    expect(button("导入或恢复本机学习数据 · 仅桌面版").disabled).toBe(true);

    const dataDetails = details("来源、导出与删除");
    await act(async () => dataDetails.querySelector("summary")!.click());
    expect(button("完整 JSON").disabled).toBe(true);
    expect(button("卡片 CSV").disabled).toBe(true);
    expect(button("复习记录 CSV").disabled).toBe(true);
    expect(container.textContent).toContain("导入与导出仅桌面版可用");
    expect(backend.previewLearningImport).not.toHaveBeenCalled();
    expect(backend.exportLearningData).not.toHaveBeenCalled();
  });

  it("translates a stale availability race instead of exposing backend validation", async () => {
    backend.startManualLearningSession.mockRejectedValueOnce(
      new Error("validation error: no learning cards are currently available"),
    );

    await act(async () => root.render(<LearningView />));
    await flush();
    await act(async () => button("开始一轮 · 1 个 · 约 2 分钟").click());
    await flush();

    expect(container.textContent).toContain(
      "现在还不能开始：词库已经学完，目前也没有到期复习",
    );
    expect(container.textContent).not.toContain("validation error");
  });

  it.each([
    ["a higher priority presentation is active", "当前有优先展示的提醒或活动，请处理完后再试"],
    ["a learning session is already active or resumable", "上一轮还未结束，请先继续或结束上一轮"],
    ["learning startup cleanup failed (disk failure); startup error: a higher priority presentation is active", "学习启动后的状态清理未完成，请重新打开学习页核对上一轮后再试"],
  ])("explains a rejected learning start and refreshes the actual state: %s", async (failure, message) => {
    backend.startManualLearningSession.mockRejectedValueOnce(new Error(`validation error: ${failure}`));
    await act(async () => root.render(<LearningView />));
    await flush();
    await act(async () => button("开始一轮 · 1 个 · 约 2 分钟").click());
    await flush();
    expect(container.textContent).toContain(`现在还不能开始：${message}`);
    expect(container.textContent).not.toContain("validation error");
    expect(backend.getLearningHome).toHaveBeenCalledTimes(2);
    expect(button("开始一轮 · 1 个 · 约 2 分钟").disabled).toBe(false);
    await act(async () => button("开始一轮 · 1 个 · 约 2 分钟").click());
    await flush();
    expect(backend.startManualLearningSession).toHaveBeenCalledTimes(2);
    expect(container.textContent).toContain("address");
  });

  it("refreshes and offers an existing unpresented round after a rejected start", async () => {
    const pending = { ...structuredClone(session), status: "created" as const, stateRevision: 1, currentItemId: null };
    backend.getLearningHome.mockResolvedValueOnce(structuredClone(home)).mockResolvedValue({
      ...structuredClone(home), activeSession: pending,
    });
    backend.startManualLearningSession.mockRejectedValueOnce(new Error("validation error: a learning session is already active or resumable"));
    backend.resumeLearningSession.mockResolvedValue(structuredClone(session));
    await act(async () => root.render(<LearningView />));
    await flush();
    await act(async () => button("开始一轮 · 1 个 · 约 2 分钟").click());
    await flush();
    expect(container.textContent).toContain("上一轮还未结束，请先继续或结束上一轮");
    await act(async () => button("继续上一轮").click());
    await flush();
    expect(backend.resumeLearningSession).toHaveBeenCalledWith("session-1", 1);
    expect(container.textContent).toContain("address");
    expect(backend.abandonLearningSession).not.toHaveBeenCalled();
    expect(backend.answerLearningQuestion).not.toHaveBeenCalled();
  });

  it("submits one objective choice and shows the result through the blackboard controls", async () => {
    backend.answerLearningQuestion.mockResolvedValue({
      schemaVersion: 1,
      questionId: "question-1",
      selectedOptionId: "option-correct",
      correctOptionId: "option-correct",
      correctMeaningZh: "处理；设法解决",
      correct: true,
      isRemediation: false,
      replayed: false,
      session: {
        ...session,
        status: "completed",
        completedCount: 1,
        endedAtUnixMs: 2,
      },
    });
    await act(async () => root.render(<LearningView />));
    await flush();
    expect(container.textContent).toContain("到期复习优先，再用新词补满本轮");
    await act(async () => button("开始一轮 · 1 个 · 约 2 分钟").click());
    await flush();
    expect(container.textContent).toContain("address");
    expect(container.textContent).toContain("处理；设法解决");
    expect(container.textContent).not.toContain("回答正确");
    const correctChoice = container.querySelector<HTMLButtonElement>('[aria-label="1，处理；设法解决"]')!;
    expect(document.activeElement).toBe(correctChoice);
    vi.useFakeTimers();
    await act(async () => correctChoice.click());
    await act(async () => Promise.resolve());
    expect(backend.answerLearningQuestion).toHaveBeenCalledWith(
      "session-1", "question-1", "option-correct", expect.any(String), expect.any(Number),
    );
    expect(container.textContent).toContain("回答正确");
    expect(button("看看本次结果")).toBeUndefined();
    expect(container.textContent).toContain("即将显示本次结果");
    await act(async () => {
      vi.advanceTimersByTime(1_200);
      await Promise.resolve();
    });
    expect(container.textContent).toContain("这轮小黑板完成了");
    expect(container.textContent).toContain("1首答正确");
    expect(container.textContent).toContain("再学一轮 · 5 个");
    vi.useRealTimers();
  });

  it("keeps a wrong answer manual and offers targeted correction after the round", async () => {
    backend.answerLearningQuestion.mockResolvedValue({
      schemaVersion: 1,
      questionId: "question-1",
      selectedOptionId: "option-wrong",
      correctOptionId: "option-correct",
      correctMeaningZh: "处理；设法解决",
      correct: false,
      isRemediation: false,
      replayed: false,
      session: {
        ...session,
        status: "completed",
        completedCount: 1,
        endedAtUnixMs: 2,
      },
    });
    backend.getLearningSessionSummary.mockResolvedValue({
      ...structuredClone(sessionSummary),
      correctCount: 0,
      wrongCount: 1,
      targetableWrongCount: 1,
    });

    await act(async () => root.render(<LearningView />));
    await flush();
    await act(async () => button("开始一轮 · 1 个 · 约 2 分钟").click());
    await flush();
    const wrongChoice = container.querySelector<HTMLButtonElement>(
      '[aria-label="2，树木；木材"]',
    )!;
    await act(async () => wrongChoice.click());
    await flush();

    expect(container.textContent).toContain("这次需要再看");
    expect(container.textContent).toContain("正确答案：处理；设法解决");
    expect(container.querySelector(".learning-result-button.red")?.classList).toContain("is-pressed");
    expect(container.querySelector(".learning-option.is-wrong")?.textContent).toContain("树木；木材");

    await act(async () => button("查看本次结果").click());
    await flush();
    expect(container.textContent).toContain("订正本轮错题 · 1 个");
    expect(backend.getCurrentLearningQuestion).toHaveBeenCalledTimes(1);
    backend.startManualLearningSession.mockResolvedValue({
      ...structuredClone(session),
      sessionKind: "mistakes",
    });
    await act(async () => button("订正本轮错题 · 1 个").click());
    await flush();
    expect(backend.startManualLearningSession).toHaveBeenLastCalledWith(
      5,
      "mistakes",
      "session-1",
    );
  });

  it("opens the local mistake list with counts and meanings", async () => {
    backend.listLearningRecords.mockResolvedValue({
      schemaVersion: 1,
      filter: "mistakes",
      query: "",
      page: 0,
      pageSize: 20,
      total: 1,
      items: [{
        cardId: "card-1",
        headword: "address",
        phonetic: "/əˈdres/",
        partOfSpeech: ["v."],
        meaningsZh: ["处理；设法解决"],
        stage: "learning",
        dueAtUnixMs: 1_800_000_000_000,
        reviewCount: 3,
        correctCount: 2,
        wrongCount: 1,
        lastStudiedAtUnixMs: 1_800_000_000_000,
        lastWrongAtUnixMs: 1_800_000_000_000,
        latestOutcome: "incorrect",
        mistakeStatus: "needs_correction",
      }],
    });

    await act(async () => root.render(<LearningView />));
    await flush();
    await act(async () => button("单词本").click());
    await flush();

    expect(backend.listLearningRecords).toHaveBeenCalledWith("mistakes", "", 0, 20);
    expect(container.textContent).toContain("错题订正");
    expect(container.textContent).toContain("address");
    expect(container.textContent).toContain("答对 2");
    expect(container.textContent).toContain("答错 1");
    expect(container.textContent).toContain("待订正");
  });

  it("opens a local dashboard with progress, activity, and mastery charts", async () => {
    await act(async () => root.render(<LearningView />));
    await flush();

    await act(async () => button("学习看板").click());
    await flush();

    expect(backend.getLearningDashboard).toHaveBeenCalledTimes(1);
    expect(container.textContent).toContain("已接触 12 / 4533");
    expect(container.textContent).toContain("80%7天首答正确率");
    expect(container.textContent).toContain("近 7 天学习节奏");
    expect(container.textContent).toContain("稳定掌握 4");
    expect(container.querySelector('[role="img"]')?.getAttribute("aria-label"))
      .toContain("共完成 13 次复习");
    await act(async () => button("待订正 2").click());
    await flush();
    expect(backend.listLearningRecords).toHaveBeenLastCalledWith("mistakes", "", 0, 20);
  });

  it("starts an independent wrong-only session without changing the daily mode", async () => {
    backend.getLearningHome.mockResolvedValue({
      ...structuredClone(home),
      mistakeCount: 2,
    });
    backend.startManualLearningSession.mockResolvedValue({
      ...structuredClone(session),
      sessionKind: "mistakes",
    });

    await act(async () => root.render(<LearningView />));
    await flush();
    const mistakeMode = [...container.querySelectorAll<HTMLButtonElement>(
      ".learning-mode-picker button",
    )].find((item) => item.textContent?.includes("仅练错题"))!;
    await act(async () => mistakeMode.click());

    expect(container.textContent).toContain("待订正错题 2 个");
    expect(container.textContent).toContain("只练还没订正的词");
    await act(async () => button("开始订正 · 2 个").click());
    await flush();

    expect(backend.startManualLearningSession).toHaveBeenCalledWith(5, "mistakes", null);
    expect(container.textContent).toContain("address");
  });

  it("Escape confirms before ending without rating the unseen card", async () => {
    await act(async () => root.render(<LearningView />));
    await flush();
    await act(async () => button("开始一轮 · 1 个 · 约 2 分钟").click());
    await flush();
    await act(async () =>
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" })),
    );
    await flush();
    expect(container.textContent).toContain("暂停，还是结束本轮？");
    expect(backend.abandonLearningSession).not.toHaveBeenCalled();
    const confirmExit = [...container.querySelectorAll<HTMLButtonElement>(
      ".learning-dialog button",
    )].find((item) => item.textContent?.trim() === "结束本轮")!;
    await act(async () => confirmExit.click());
    await flush();
    expect(backend.abandonLearningSession).toHaveBeenCalledWith("session-1", 2);
    expect(backend.rateLearningCard).not.toHaveBeenCalled();
    expect(backend.answerLearningQuestion).not.toHaveBeenCalled();
  });

  it("offers a paused round and resumes the exact persisted revision", async () => {
    const paused = {
      ...structuredClone(session),
      status: "paused" as const,
      stateRevision: 3,
      pausedAtUnixMs: session.startedAtUnixMs + 1_000,
      pauseReason: "user_pause",
      lastActivityAtUnixMs: session.startedAtUnixMs + 1_000,
      expiresAtUnixMs: session.startedAtUnixMs + 86_401_000,
    };
    backend.getLearningHome.mockResolvedValue({
      ...structuredClone(home),
      activeSession: paused,
    });
    backend.resumeLearningSession.mockResolvedValue({
      ...paused,
      status: "active",
      stateRevision: 4,
      pausedAtUnixMs: null,
      pauseReason: null,
    });

    await act(async () => root.render(<LearningView />));
    await flush();
    expect(container.textContent).toContain("上一轮已暂停");
    await act(async () => button("继续上一轮").click());
    await flush();

    expect(backend.resumeLearningSession).toHaveBeenCalledWith("session-1", 3);
    expect(container.textContent).toContain("address");
  });

  it("requires a second confirmation after a zero-write import preview", async () => {
    runtime.tauriAvailable.mockReturnValue(true);
    backend.getLearningHome
      .mockResolvedValueOnce({
        ...structuredClone(home),
        capabilities: { ...home.capabilities, contentPackReady: false },
      })
      .mockResolvedValue(structuredClone(home));
    backend.previewLearningImport.mockResolvedValue({
      schemaVersion: 1,
      status: "confirmation_required",
      previewToken: "preview-1",
      expiresAtUnixMs: Date.now() + 60_000,
      format: "csv",
      sourceLabel: "我的词表",
      cardCount: 3,
      newCount: 2,
      learningCount: 1,
      reviewKnownCount: 0,
      sampleHeadwords: ["address"],
      selectedPathReturned: false,
    });
    backend.confirmLearningImport.mockResolvedValue({
      schemaVersion: 1,
      packId: "pack-1",
      importedCount: 3,
      preservedScheduleCount: 0,
    });
    await act(async () => root.render(<LearningView />));
    await flush();
    await act(async () => button("导入本地知识").click());
    await flush();
    expect(backend.confirmLearningImport).not.toHaveBeenCalled();
    expect(container.textContent).toContain("确认导入这份词表");
    await act(async () => button("确认导入").click());
    await flush();
    expect(backend.confirmLearningImport).toHaveBeenCalledWith("preview-1");
  });

  it("can stop an active import and reports a safe rollback", async () => {
    runtime.tauriAvailable.mockReturnValue(true);
    backend.getLearningHome.mockResolvedValue({
      ...structuredClone(home),
      capabilities: { ...home.capabilities, contentPackReady: false },
    });
    backend.previewLearningImport.mockResolvedValue({
      schemaVersion: 1,
      status: "confirmation_required",
      previewToken: "preview-cancel",
      expiresAtUnixMs: Date.now() + 60_000,
      format: "csv",
      sourceLabel: "大词表",
      cardCount: 20_000,
      newCount: 20_000,
      learningCount: 0,
      reviewKnownCount: 0,
      sampleHeadwords: ["worda"],
      selectedPathReturned: false,
    });
    let rejectImport!: (reason: Error) => void;
    backend.confirmLearningImport.mockImplementation(
      () => new Promise((_resolve, reject) => { rejectImport = reject; }),
    );
    backend.cancelLearningImport.mockResolvedValue(true);

    await act(async () => root.render(<LearningView />));
    await flush();
    await act(async () => button("导入本地知识").click());
    await flush();
    await act(async () => button("确认导入").click());
    await flush();
    expect(container.textContent).toContain("正在把所选内容写入本机学习库");

    await act(async () => button("停止导入").click());
    await flush();
    expect(backend.cancelLearningImport).toHaveBeenCalledTimes(1);
    expect(container.textContent).toContain("当前数据库事务会先安全回滚");

    await act(async () => rejectImport(
      new Error("validation error: learning import was cancelled"),
    ));
    await flush();
    expect(container.textContent).toContain("导入已安全停止，没有写入不完整数据");
    expect(container.textContent).not.toContain("词表没有导入");
    expect(container.textContent).not.toContain("确认导入这份词表");
  });

  it("opens source controls and recovers after the native export dialog is cancelled", async () => {
    runtime.tauriAvailable.mockReturnValue(true);
    let finishExport!: (value: {
      schemaVersion: 1;
      status: "cancelled";
      format: "native_json";
      recordCount: number;
      bytes: number;
      exportedAtUnixMs: null;
      selectedPathReturned: false;
    }) => void;
    backend.exportLearningData.mockImplementation(
      () => new Promise((resolve) => { finishExport = resolve; }),
    );

    await act(async () => root.render(<LearningView />));
    await flush();
    const dataDetails = details("来源、导出与删除");
    await act(async () => dataDetails.querySelector("summary")!.click());
    expect(dataDetails.open).toBe(true);

    await act(async () => button("完整 JSON").click());
    await flush();
    expect(container.textContent).toContain("正在等待导出位置");
    expect(button("完整 JSON").disabled).toBe(true);

    await act(async () => finishExport({
      schemaVersion: 1,
      status: "cancelled",
      format: "native_json",
      recordCount: 0,
      bytes: 0,
      exportedAtUnixMs: null,
      selectedPathReturned: false,
    }));
    await flush();
    expect(container.textContent).not.toContain("正在等待导出位置");
    expect(button("完整 JSON").disabled).toBe(false);
  });

  it("requires a reviewed backup-and-migrate confirmation for legacy personal data", async () => {
    runtime.tauriAvailable.mockReturnValue(true);
    backend.listLegacyLearningSources.mockResolvedValue([
      {
        schemaVersion: 1,
        edition: "preview",
        status: "missing",
        sourceSchemaVersion: null,
        cardCount: 0,
        reviewCount: 0,
        failureReason: null,
      },
      {
        schemaVersion: 1,
        edition: "personal",
        status: "available",
        sourceSchemaVersion: 6,
        cardCount: 4_533,
        reviewCount: 120,
        failureReason: null,
      },
    ]);
    backend.previewLegacyLearningMigration.mockResolvedValue({
      schemaVersion: 1,
      status: "confirmation_required",
      edition: "personal",
      previewToken: "legacy-preview-1",
      expiresAtUnixMs: Date.now() + 60_000,
      sourceCardCount: 4_533,
      sourceReviewCount: 120,
      destinationCardCount: 1,
      destinationReviewCount: 2,
      replacesDestination: true,
      backupRequired: true,
      sourceDirectoryPreserved: true,
    });
    backend.confirmLegacyLearningMigration.mockResolvedValue({
      schemaVersion: 1,
      status: "migrated",
      edition: "personal",
      importedCardCount: 4_533,
      importedReviewCount: 120,
      backupFileName: "legacy-before-personal.sqlite3",
      sourceDirectoryPreserved: true,
      destinationVerified: true,
    });

    await act(async () => root.render(<LearningView />));
    await flush();
    const dataDetails = details("来源、导出与删除");
    await act(async () => dataDetails.querySelector("summary")!.click());
    expect(container.textContent).toContain("旧个人版");
    expect(container.textContent).toContain("4533 张卡片");

    await act(async () => button("查看迁移影响").click());
    await flush();
    expect(backend.confirmLegacyLearningMigration).not.toHaveBeenCalled();
    expect(container.textContent).toContain("当前 1 张卡片和 2 条记录会被替换");
    expect(container.textContent).toContain("旧版目录不会自动删除");
    expect(container.textContent).toContain("不会进入公开安装包");

    await act(async () => button("备份并迁移").click());
    await flush();
    expect(backend.confirmLegacyLearningMigration).toHaveBeenCalledWith("legacy-preview-1");
    expect(container.textContent).toContain("旧版目录仍完整保留");
  });

  it("keeps the learning panel responsive while the native import dialog is open", async () => {
    runtime.tauriAvailable.mockReturnValue(true);
    let cancelImport!: () => void;
    backend.previewLearningImport.mockImplementation(
      () => new Promise((resolve) => {
        cancelImport = () => resolve({
          schemaVersion: 1,
          status: "cancelled",
          previewToken: null,
          expiresAtUnixMs: null,
          format: null,
          sourceLabel: null,
          cardCount: 0,
          newCount: 0,
          learningCount: 0,
          reviewKnownCount: 0,
          sampleHeadwords: [],
          selectedPathReturned: false,
        });
      }),
    );

    await act(async () => root.render(<LearningView />));
    await flush();
    const settingsDetails = details("学习与防打扰设置");
    await act(async () => settingsDetails.querySelector("summary")!.click());
    await act(async () => button("导入或恢复本机学习数据").click());
    await flush();
    expect(container.textContent).toContain("正在等待系统文件窗口");

    await act(async () => cancelImport());
    await flush();
    expect(container.textContent).not.toContain("正在等待系统文件窗口");
    expect(button("导入或恢复本机学习数据").disabled).toBe(false);
  });

  it("requires an explicit second confirmation before deleting only learning data", async () => {
    let finishDelete!: () => void;
    backend.deleteLearningData.mockImplementation(
      () => new Promise((resolve) => {
        finishDelete = () => resolve({
          schemaVersion: 1,
          scope: "all_learning_data",
          keptCardCount: 0,
          deletedReviewCount: 2,
        });
      }),
    );
    await act(async () => root.render(<LearningView />));
    await flush();
    const dataDetails = details("来源、导出与删除");
    await act(async () => dataDetails.querySelector("summary")!.click());
    expect(dataDetails.open).toBe(true);
    await act(async () => button("删除全部学习数据").click());
    expect(backend.deleteLearningData).not.toHaveBeenCalled();
    expect(container.textContent).toContain("删除全部本机学习数据？");
    await act(async () => button("确认全部删除").click());
    await flush();
    expect(container.textContent).toContain("正在处理本机学习数据");
    expect(backend.deleteLearningData).toHaveBeenCalledWith(
      "all_learning_data",
      "DELETE ALL LEARNING DATA",
    );
    await act(async () => finishDelete());
    await flush();
    expect(container.textContent).not.toContain("正在处理本机学习数据");
  });

  it("shows a user-readable backend error without the JavaScript Error prefix", async () => {
    runtime.tauriAvailable.mockReturnValue(true);
    backend.previewLearningImport.mockRejectedValue(
      new Error("浏览器演示不会读取本机文件"),
    );
    await act(async () => root.render(<LearningView />));
    await flush();
    const settingsDetails = details("学习与防打扰设置");
    await act(async () => settingsDetails.querySelector("summary")!.click());

    await act(async () => button("导入或恢复本机学习数据").click());
    await flush();

    expect(container.textContent).toContain(
      "词表未能预览：浏览器演示不会读取本机文件",
    );
    expect(container.textContent).not.toContain("Error:");
  });
});
