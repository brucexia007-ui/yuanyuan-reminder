// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const backend = vi.hoisted(() => ({
  abandonLearningSession: vi.fn(),
  answerLearningQuestion: vi.fn(),
  dismissCompletedLearningSession: vi.fn(),
  getCurrentLearningCard: vi.fn(),
  getCurrentLearningQuestion: vi.fn(),
  getLearningSessionSummary: vi.fn(),
  pauseLearningSession: vi.fn(),
  rateLearningCard: vi.fn(),
  startManualLearningSession: vi.fn(),
}));

vi.mock("./backend", () => backend);
vi.mock("../pet/SpriteAnimator", () => ({
  SpriteAnimator: ({
    animation,
    mirrored = false,
    forceStill = false,
    onFrameChange,
    onComplete,
  }: {
    animation: string;
    mirrored?: boolean;
    forceStill?: boolean;
    onFrameChange?: (animation: string, frameIndex: number) => void;
    onComplete?: (animation: string) => void;
  }) => (
    <div
      data-testid="sprite"
      data-animation={animation}
      data-mirrored={String(mirrored)}
      data-force-still={String(forceStill)}
    >
      {[4, 5, 6].map((frameIndex) => (
        <button
          key={frameIndex}
          data-testid={`frame-${frameIndex}`}
          type="button"
          onClick={() => onFrameChange?.(animation, frameIndex)}
        />
      ))}
      <button
        data-testid="complete-animation"
        type="button"
        onClick={() => onComplete?.(animation)}
      />
    </div>
  ),
}));

import type {
  LearningAnswerResult,
  LearningQuestionDto,
  LearningSessionSnapshot,
} from "../types";
import { LearningDesktopStage } from "./LearningDesktopStage";
import { acceptPetSnapshot, builtinPet, getPetSnapshot } from "../pet/petProfile";

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
  startedAtUnixMs: 1,
  pausedAtUnixMs: null,
  pauseReason: null,
  lastActivityAtUnixMs: 1,
  expiresAtUnixMs: 86_400_001,
  endedAtUnixMs: null,
  exitReason: null,
};

const question: LearningQuestionDto = {
  schemaVersion: 1,
  questionId: "question-1",
  kind: "multiple_choice",
  cardId: "card-1",
  headword: "address",
  phonetic: "/address/",
  partOfSpeech: ["verb"],
  stage: "learning",
  isRemediation: false,
  options: [
    { optionId: "correct", meaningZh: "correct meaning" },
    { optionId: "wrong", meaningZh: "wrong meaning" },
  ],
};

function answerResult(correct: boolean): LearningAnswerResult {
  return {
    schemaVersion: 1,
    questionId: question.questionId,
    selectedOptionId: correct ? "correct" : "wrong",
    correctOptionId: "correct",
    correctMeaningZh: "correct meaning",
    correct,
    isRemediation: false,
    replayed: false,
    session: correct
      ? {
          ...session,
          status: "completed",
          completedCount: 1,
          endedAtUnixMs: 2,
        }
      : session,
  };
}

let container: HTMLDivElement;
let root: Root;

async function flushPromises() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

async function advanceTimers(milliseconds: number) {
  await act(async () => {
    vi.advanceTimersByTime(milliseconds);
    await Promise.resolve();
  });
}

async function finishQuestionWriting() {
  await advanceTimers(280);
}

function testButton(testId: string): HTMLButtonElement {
  return container.querySelector<HTMLButtonElement>(`[data-testid="${testId}"]`)!;
}

function choice(optionId: string): HTMLButtonElement {
  return [...container.querySelectorAll<HTMLButtonElement>(".desktop-learning-option")]
    .find((item) => item.textContent?.includes(`${optionId} meaning`))!;
}

function sprite(): HTMLElement {
  return container.querySelector<HTMLElement>('[data-testid="sprite"]')!;
}

describe("desktop learning pet feedback", () => {
  beforeEach(() => {
    acceptPetSnapshot({ ...getPetSnapshot(), revision: getPetSnapshot().revision + 1, effectivePackId: builtinPet.packId, selectedPackId: builtinPet.packId, nickname: "圆圆", capabilities: builtinPet.capabilities, manifest: builtinPet.manifest, staticOnly: false });
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-12T08:00:00Z"));
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    backend.getCurrentLearningQuestion.mockResolvedValue(structuredClone(question));
    backend.getLearningSessionSummary.mockResolvedValue({
      schemaVersion: 1,
      session: { ...session, status: "completed", completedCount: 1, endedAtUnixMs: 31_000 },
      correctCount: 0,
      wrongCount: 1,
      newCount: 1,
      reviewCount: 0,
      durationSeconds: 30,
      averageResponseMs: 8_000,
      targetableWrongCount: 1,
    });
    backend.abandonLearningSession.mockResolvedValue({ ...session, status: "abandoned" });
    backend.dismissCompletedLearningSession.mockResolvedValue({
      ...session,
      status: "completed",
      completedCount: 1,
    });
    backend.pauseLearningSession.mockResolvedValue({ ...session, status: "paused" });
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    vi.clearAllTimers();
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  it("supports revealing and rating a generic recall card with keyboard focus", async () => {
    backend.getCurrentLearningQuestion.mockResolvedValue({
      ...question, kind: "recall_fallback", headword: "首先确认什么？", phonetic: null,
      partOfSpeech: ["generic"], options: [],
    });
    backend.getCurrentLearningCard.mockResolvedValue({
      schemaVersion: 1, cardId: "card-1", headword: "首先确认什么？", phonetic: null,
      partOfSpeech: ["generic"], meaningsZh: ["确认可观察的结果。"], wordFamily: [],
      stage: "learning", sourceIds: [],
    });
    await act(async () => root.render(<LearningDesktopStage session={session}
      settings={{ animationMode: "off", animationSpeed: 1 }} onSessionChange={vi.fn()} onClose={vi.fn()} />));
    await flushPromises();
    expect(document.activeElement?.textContent).toBe("先回忆，再查看答案");
    expect(container.textContent).not.toContain("选项不足");
    expect(container.querySelector(".desktop-learning-word-row")?.textContent).not.toContain("generic");
    await act(async () => (document.activeElement as HTMLButtonElement).click());
    expect(container.textContent).toContain("确认可观察的结果。");
    expect(document.activeElement?.textContent).toBe("忘了");
  });

  it("moves DOM focus to the first answer after the question finishes writing", async () => {
    await act(async () =>
      root.render(
        <LearningDesktopStage
          session={session}
          settings={{ animationMode: "always", animationSpeed: 1 }}
          onSessionChange={vi.fn()}
          onClose={vi.fn()}
        />,
      ),
    );
    await flushPromises();
    await finishQuestionWriting();

    expect(document.activeElement).toBe(choice("correct"));
  });

  it.each([true, false])("settles in-flight answer feedback when switching to a pack with learning=%s", async (learning) => {
    backend.answerLearningQuestion.mockResolvedValue(answerResult(true));
    await act(async () => root.render(<LearningDesktopStage session={session} settings={{ animationMode: "always", animationSpeed: 1 }} onSessionChange={vi.fn()} onClose={vi.fn()} />));
    await flushPromises(); await finishQuestionWriting();
    await act(async () => choice("correct").click()); await flushPromises();
    expect(sprite().dataset.animation).toBe("learning-press-correct");
    await act(async () => acceptPetSnapshot({ ...getPetSnapshot(), revision: getPetSnapshot().revision + 1, selectedPackId: "next-pet", effectivePackId: "next-pet", capabilities: { learning, scene: false } }));
    expect(container.querySelector('[role="status"]')?.textContent).toBe("回答正确，真棒");
    await advanceTimers(1000);
    expect(container.querySelector(".desktop-learning-complete")).not.toBeNull();
    expect(backend.answerLearningQuestion).toHaveBeenCalledTimes(1);
  });

  it("presses the green button only at the contact frame for a correct answer", async () => {
    backend.answerLearningQuestion.mockResolvedValue(answerResult(true));
    await act(async () =>
      root.render(
        <LearningDesktopStage
          session={session}
          settings={{ animationMode: "always", animationSpeed: 1 }}
          onSessionChange={vi.fn()}
          onClose={vi.fn()}
        />,
      ),
    );
    await flushPromises();
    expect(choice("correct").disabled).toBe(true);
    await finishQuestionWriting();
    expect(sprite().dataset.animation).toBe("learning-study-sit");

    await act(async () => choice("correct").click());
    await flushPromises();

    expect(sprite().dataset.animation).toBe("learning-press-correct");
    expect(sprite().dataset.mirrored).toBe("false");
    expect(container.querySelector(".desktop-learning-result-button.green")?.classList)
      .not.toContain("is-pressed");
    expect(container.querySelector(".desktop-learning-result-bubble")).toBeNull();
    expect(container.querySelector('[role="status"]')?.textContent).toBe("");

    await act(async () => testButton("frame-4").click());
    expect(container.querySelector(".desktop-learning-result-button.green")?.classList)
      .not.toContain("is-pressed");
    expect(container.querySelector(".desktop-learning-result-bubble")).toBeNull();

    await act(async () => testButton("frame-5").click());
    expect(container.querySelector(".desktop-learning-result-button.green")?.classList)
      .toContain("is-pressed");
    expect(container.querySelector(".desktop-learning-result-button.green")?.classList)
      .toContain("is-confirmed");
    expect(container.querySelector(".desktop-learning-result-button.red")?.classList)
      .not.toContain("is-pressed");
    expect(container.querySelector(".desktop-learning-result-button.green .desktop-learning-result-bubble")?.textContent)
      .toBe("真棒！");
    expect(container.querySelector('[role="status"]')?.textContent)
      .toBe("回答正确，真棒");

    await act(async () => testButton("frame-6").click());
    await advanceTimers(170);
    expect(container.querySelector(".desktop-learning-result-button.green")?.classList)
      .not.toContain("is-pressed");
    expect(container.querySelector(".desktop-learning-result-button.green")?.classList)
      .toContain("is-confirmed");

    await act(async () => testButton("complete-animation").click());
    expect(sprite().dataset.animation).toBe("learning-study-sit");
    expect(container.querySelector(".desktop-learning-feedback button")).toBeNull();
    expect(container.querySelector(".desktop-learning-auto-next")?.textContent)
      .toContain("即将显示本次结果");

    await advanceTimers(199);
    expect(container.querySelector(".desktop-learning-board")?.textContent)
      .toContain("address");
    await advanceTimers(1);
    expect(container.querySelector(".desktop-learning-result-bubble")).toBeNull();
    await advanceTimers(170);
    expect(container.querySelector(".desktop-learning-complete")?.textContent)
      .toContain("小黑板复习完成");
  });

  it("shows the authoritative round summary and can target only this round's mistakes", async () => {
    const completed = {
      ...session,
      status: "completed" as const,
      completedCount: 1,
      endedAtUnixMs: 31_000,
    };
    const next = {
      ...session,
      sessionId: "session-2",
      sessionKind: "mistakes" as const,
    };
    backend.startManualLearningSession.mockResolvedValue(next);
    const onSessionChange = vi.fn();
    await act(async () =>
      root.render(
        <LearningDesktopStage
          session={completed}
          settings={{ animationMode: "always", animationSpeed: 1 }}
          onSessionChange={onSessionChange}
          onClose={vi.fn()}
        />,
      ),
    );
    await flushPromises();

    expect(container.textContent).toContain("0首答正确");
    expect(container.textContent).toContain("1本轮错题");
    expect(container.textContent).toContain("30秒本轮用时");
    const correction = [...container.querySelectorAll<HTMLButtonElement>("button")]
      .find((item) => item.textContent?.includes("订正本轮错题"))!;
    await act(async () => correction.click());
    await flushPromises();

    expect(backend.startManualLearningSession).toHaveBeenCalledWith(
      3,
      "mistakes",
      "session-1",
    );
    expect(onSessionChange).toHaveBeenCalledWith(next);
  });

  it.each([
    ["a higher priority presentation is active", "当前有优先展示的提醒或活动，请处理完后再试"],
    ["a learning session is already active or resumable", "上一轮还未结束，请先继续或结束上一轮"],
    ["learning startup cleanup failed; a higher priority presentation is active", "学习启动后的状态清理未完成，请重新打开学习页核对上一轮后再试"],
  ])("keeps the completed board usable when the next round is denied: %s", async (failure, message) => {
    const completed = { ...session, status: "completed" as const, completedCount: 1, endedAtUnixMs: 31_000 };
    const next = { ...session, sessionId: "session-2", sessionKind: "mistakes" as const };
    backend.startManualLearningSession.mockRejectedValueOnce(new Error(`validation error: ${failure}`)).mockResolvedValue(next);
    const onSessionChange = vi.fn();
    await act(async () => root.render(
      <LearningDesktopStage session={completed} settings={{ animationMode: "always", animationSpeed: 1 }} onSessionChange={onSessionChange} onClose={vi.fn()} />,
    ));
    await flushPromises();
    const correction = () => [...container.querySelectorAll<HTMLButtonElement>("button")].find((item) => item.textContent?.includes("订正本轮错题"))!;
    await act(async () => correction().click());
    await flushPromises();
    expect(container.textContent).toContain(message);
    expect(container.textContent).not.toContain("validation error");
    expect(onSessionChange).not.toHaveBeenCalled();
    expect(correction().disabled).toBe(false);
    await act(async () => correction().click());
    await flushPromises();
    expect(onSessionChange).toHaveBeenCalledWith(next);
    expect(backend.answerLearningQuestion).not.toHaveBeenCalled();
  });

  it("releases the completed presentation only when the completion board closes", async () => {
    const completed = {
      ...session,
      status: "completed" as const,
      completedCount: 1,
      endedAtUnixMs: 31_000,
    };
    const onClose = vi.fn();
    await act(async () =>
      root.render(
        <LearningDesktopStage
          session={completed}
          settings={{ animationMode: "always", animationSpeed: 1 }}
          onSessionChange={vi.fn()}
          onClose={onClose}
        />,
      ),
    );
    await flushPromises();

    expect(backend.dismissCompletedLearningSession).not.toHaveBeenCalled();
    await act(async () =>
      [...container.querySelectorAll<HTMLButtonElement>("button")]
        .find((item) => item.textContent === "先休息一下")?.click(),
    );
    expect(backend.dismissCompletedLearningSession).toHaveBeenCalledWith(
      "session-1",
      2,
    );
    expect(onClose).not.toHaveBeenCalled();
    await advanceTimers(280);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("uses the independent left-paw row without mirroring for a wrong answer", async () => {
    backend.answerLearningQuestion.mockResolvedValue(answerResult(false));
    await act(async () =>
      root.render(
        <LearningDesktopStage
          session={session}
          settings={{ animationMode: "always", animationSpeed: 1 }}
          onSessionChange={vi.fn()}
          onClose={vi.fn()}
        />,
      ),
    );
    await flushPromises();
    await finishQuestionWriting();

    await act(async () => choice("wrong").click());
    await flushPromises();

    expect(sprite().dataset.animation).toBe("learning-press-wrong");
    expect(sprite().dataset.mirrored).toBe("false");
    await act(async () => testButton("frame-5").click());
    expect(container.querySelector(".desktop-learning-result-button.red")?.classList)
      .toContain("is-pressed");
    expect(container.querySelector(".desktop-learning-result-button.green")?.classList)
      .not.toContain("is-pressed");
    expect(container.querySelector(".desktop-learning-result-button.red .desktop-learning-result-bubble")?.textContent)
      .toBe("可惜了");
    expect(container.querySelector('[role="status"]')?.textContent)
      .toBe("回答错误，可惜了");

    await act(async () => testButton("complete-animation").click());
    expect(sprite().dataset.animation).toBe("learning-study-sit");
    expect(container.querySelector<HTMLButtonElement>(".desktop-learning-feedback button")?.disabled)
      .toBe(false);
    await advanceTimers(2_000);
    expect(container.querySelector(".desktop-learning-word-row h2")?.textContent)
      .toBe("address");
    expect(container.querySelector(".desktop-learning-feedback button")?.textContent)
      .toContain("我看懂了，下一题");
  });

  it("rests still for a minute, makes one brief curious gesture, then rests again", async () => {
    await act(async () =>
      root.render(
        <LearningDesktopStage
          session={session}
          settings={{ animationMode: "always", animationSpeed: 1 }}
          onSessionChange={vi.fn()}
          onClose={vi.fn()}
        />,
      ),
    );
    await flushPromises();
    await finishQuestionWriting();

    expect(sprite().dataset.animation).toBe("learning-study-sit");
    expect(sprite().dataset.forceStill).toBe("true");
    await advanceTimers(59_999);
    expect(sprite().dataset.animation).toBe("learning-study-sit");
    await advanceTimers(1);
    expect(sprite().dataset.animation).toBe("learning-study-curious");
    expect(sprite().dataset.forceStill).toBe("false");

    await act(async () => testButton("complete-animation").click());
    expect(sprite().dataset.animation).toBe("learning-study-sit");
    expect(sprite().dataset.forceStill).toBe("true");
    await advanceTimers(30_000);
    expect(sprite().dataset.animation).toBe("learning-study-sit");
  });

  it("cancels the unanswered timer as soon as the user chooses", async () => {
    let resolveAnswer!: (result: LearningAnswerResult) => void;
    backend.answerLearningQuestion.mockImplementation(
      () => new Promise<LearningAnswerResult>((resolve) => {
        resolveAnswer = resolve;
      }),
    );
    await act(async () =>
      root.render(
        <LearningDesktopStage
          session={session}
          settings={{ animationMode: "always", animationSpeed: 1 }}
          onSessionChange={vi.fn()}
          onClose={vi.fn()}
        />,
      ),
    );
    await flushPromises();
    await finishQuestionWriting();
    await advanceTimers(59_950);

    act(() => choice("correct").click());
    await advanceTimers(100);
    expect(sprite().dataset.animation).toBe("learning-study-sit");

    await act(async () => {
      resolveAnswer(answerResult(true));
      await Promise.resolve();
    });
    expect(sprite().dataset.animation).toBe("learning-press-correct");
  });

  it("lets answer feedback interrupt an in-progress curious pose", async () => {
    backend.answerLearningQuestion.mockResolvedValue(answerResult(false));
    await act(async () =>
      root.render(
        <LearningDesktopStage
          session={session}
          settings={{ animationMode: "always", animationSpeed: 1 }}
          onSessionChange={vi.fn()}
          onClose={vi.fn()}
        />,
      ),
    );
    await flushPromises();
    await finishQuestionWriting();
    await advanceTimers(60_000);
    expect(sprite().dataset.animation).toBe("learning-study-curious");

    await act(async () => choice("wrong").click());
    await flushPromises();
    expect(sprite().dataset.animation).toBe("learning-press-wrong");
  });

  it("clears the bubble and gives the next question its own curious timeout", async () => {
    const nextQuestion = {
      ...structuredClone(question),
      questionId: "question-2",
      headword: "stone",
    };
    backend.getCurrentLearningQuestion
      .mockResolvedValueOnce(structuredClone(question))
      .mockResolvedValueOnce(nextQuestion);
    backend.answerLearningQuestion.mockResolvedValue(answerResult(false));
    await act(async () =>
      root.render(
        <LearningDesktopStage
          session={session}
          settings={{ animationMode: "always", animationSpeed: 1 }}
          onSessionChange={vi.fn()}
          onClose={vi.fn()}
        />,
      ),
    );
    await flushPromises();
    await finishQuestionWriting();
    await act(async () => choice("wrong").click());
    await flushPromises();
    await act(async () => testButton("frame-5").click());
    await act(async () => testButton("complete-animation").click());

    expect(container.querySelector(".desktop-learning-result-bubble")?.textContent)
      .toBe("可惜了");
    await act(async () =>
      container.querySelector<HTMLButtonElement>(".desktop-learning-feedback button")?.click(),
    );
    expect(container.querySelector(".desktop-learning-result-bubble")).toBeNull();

    await advanceTimers(180);
    await flushPromises();
    expect(container.querySelector(".desktop-learning-word-row h2")?.textContent)
      .toBe("stone");
    await finishQuestionWriting();
    await advanceTimers(60_000);
    expect(sprite().dataset.animation).toBe("learning-study-curious");
  });

  it("settles interrupted feedback when closing the board fails", async () => {
    const onClose = vi.fn();
    backend.answerLearningQuestion.mockResolvedValue(answerResult(false));
    backend.abandonLearningSession.mockRejectedValueOnce(new Error("database busy"));
    await act(async () =>
      root.render(
        <LearningDesktopStage
          session={session}
          settings={{ animationMode: "always", animationSpeed: 1 }}
          onSessionChange={vi.fn()}
          onClose={onClose}
        />,
      ),
    );
    await flushPromises();
    await finishQuestionWriting();
    await act(async () => choice("wrong").click());
    await flushPromises();
    expect(sprite().dataset.animation).toBe("learning-press-wrong");
    expect(container.querySelector<HTMLButtonElement>(".desktop-learning-feedback button")?.disabled)
      .toBe(true);

    await act(async () =>
      container.querySelector<HTMLButtonElement>(".desktop-learning-meta button")?.click(),
    );
    expect(backend.abandonLearningSession).not.toHaveBeenCalled();
    await act(async () =>
      [...container.querySelectorAll<HTMLButtonElement>(".desktop-learning-exit-confirm button")]
        .find((item) => item.textContent === "结束本轮")?.click(),
    );
    await flushPromises();

    expect(onClose).not.toHaveBeenCalled();
    expect(container.querySelector(".desktop-learning-stage")?.getAttribute("data-stage-motion"))
      .toBe("steady");
    expect(container.querySelector('[role="alert"]')?.textContent)
      .toContain("本轮暂时无法结束");
    expect(sprite().dataset.animation).toBe("learning-study-sit");
    expect(container.querySelector(".desktop-learning-result-button.red")?.classList)
      .toContain("is-confirmed");
    expect(container.querySelector(".desktop-learning-result-bubble")?.textContent)
      .toBe("可惜了");
    expect(container.querySelector('[role="status"]')?.textContent)
      .toBe("回答错误，可惜了");
    expect(container.querySelector(".desktop-learning-stage")?.getAttribute("data-feedback-phase"))
      .toBe("ready");
    await act(async () =>
      container.querySelector<HTMLButtonElement>(".desktop-learning-error button")?.click(),
    );
    expect(container.querySelector<HTMLButtonElement>(".desktop-learning-feedback button")?.disabled)
      .toBe(false);
  });

  it("uses the latest motion setting when an answer request resolves", async () => {
    let resolveAnswer!: (result: LearningAnswerResult) => void;
    const onSessionChange = vi.fn();
    const onClose = vi.fn();
    backend.answerLearningQuestion.mockImplementation(
      () => new Promise<LearningAnswerResult>((resolve) => {
        resolveAnswer = resolve;
      }),
    );
    await act(async () =>
      root.render(
        <LearningDesktopStage
          session={session}
          settings={{ animationMode: "always", animationSpeed: 1 }}
          onSessionChange={onSessionChange}
          onClose={onClose}
        />,
      ),
    );
    await flushPromises();
    await finishQuestionWriting();
    act(() => choice("correct").click());

    await act(async () =>
      root.render(
        <LearningDesktopStage
          session={session}
          settings={{ animationMode: "off", animationSpeed: 1 }}
          onSessionChange={onSessionChange}
          onClose={onClose}
        />,
      ),
    );
    await act(async () => {
      resolveAnswer(answerResult(true));
      await Promise.resolve();
    });

    expect(sprite().dataset.animation).toBe("learning-study-sit");
    expect(container.querySelector(".desktop-learning-result-button.green")?.classList)
      .toContain("is-confirmed");
    expect(container.querySelector(".desktop-learning-result-bubble")?.textContent)
      .toBe("真棒！");
    expect(container.querySelector('[role="status"]')?.textContent)
      .toBe("回答正确，真棒");
    expect(container.querySelector(".desktop-learning-feedback button")).toBeNull();
    expect(container.querySelector(".desktop-learning-auto-next")?.textContent)
      .toContain("即将显示本次结果");
  });

  it("settles pressing feedback when motion is turned off", async () => {
    const onSessionChange = vi.fn();
    const onClose = vi.fn();
    backend.answerLearningQuestion.mockResolvedValue(answerResult(false));
    await act(async () =>
      root.render(
        <LearningDesktopStage
          session={session}
          settings={{ animationMode: "always", animationSpeed: 1 }}
          onSessionChange={onSessionChange}
          onClose={onClose}
        />,
      ),
    );
    await flushPromises();
    await finishQuestionWriting();
    await act(async () => choice("wrong").click());
    await flushPromises();
    expect(sprite().dataset.animation).toBe("learning-press-wrong");

    await act(async () =>
      root.render(
        <LearningDesktopStage
          session={session}
          settings={{ animationMode: "off", animationSpeed: 1 }}
          onSessionChange={onSessionChange}
          onClose={onClose}
        />,
      ),
    );

    expect(sprite().dataset.animation).toBe("learning-study-sit");
    expect(container.querySelector(".desktop-learning-result-button.red")?.classList)
      .toContain("is-confirmed");
    expect(container.querySelector(".desktop-learning-result-bubble")?.textContent)
      .toBe("可惜了");
    expect(container.querySelector('[role="status"]')?.textContent)
      .toBe("回答错误，可惜了");
    expect(container.querySelector<HTMLButtonElement>(".desktop-learning-feedback button")?.disabled)
      .toBe(false);
  });

  it("keeps reduced-motion learning immediate without skipping clear feedback", async () => {
    backend.answerLearningQuestion.mockResolvedValue(answerResult(true));
    await act(async () =>
      root.render(
        <LearningDesktopStage
          session={session}
          settings={{ animationMode: "off", animationSpeed: 1 }}
          onSessionChange={vi.fn()}
          onClose={vi.fn()}
        />,
      ),
    );
    await flushPromises();

    expect(container.querySelector(".desktop-learning-stage")?.classList)
      .toContain("is-motion-reduced");
    expect(container.querySelector(".desktop-learning-environment-status")?.textContent)
      .toBe("已减少动态效果");
    expect(choice("correct").disabled).toBe(false);
    await act(async () => choice("correct").click());
    await flushPromises();

    expect(sprite().dataset.animation).toBe("learning-study-sit");
    expect(container.querySelector(".desktop-learning-result-button.green")?.classList)
      .toContain("is-confirmed");
    expect(container.querySelector(".desktop-learning-result-bubble")?.textContent)
      .toBe("真棒！");
    expect(container.querySelector('[role="status"]')?.textContent)
      .toBe("回答正确，真棒");
    expect(container.querySelector(".desktop-learning-feedback button")).toBeNull();
    expect(container.querySelector(".desktop-learning-auto-next")?.textContent)
      .toContain("即将显示本次结果");

    await advanceTimers(599);
    expect(container.querySelector(".desktop-learning-complete")).toBeNull();
    await advanceTimers(1);
    expect(container.querySelector(".desktop-learning-complete")?.textContent)
      .toContain("小黑板复习完成");
  });

  it("honors the system motion preference and exposes forced-color state", async () => {
    const original = Object.getOwnPropertyDescriptor(window, "matchMedia");
    Object.defineProperty(window, "matchMedia", {
      configurable: true,
      value: (query: string) => ({
        matches: [
          "(prefers-reduced-motion: reduce)",
          "(forced-colors: active)",
        ].includes(query),
        media: query,
        onchange: null,
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
        addListener: vi.fn(),
        removeListener: vi.fn(),
        dispatchEvent: vi.fn(),
      }),
    });
    try {
      await act(async () =>
        root.render(
          <LearningDesktopStage
            session={session}
            settings={{ animationMode: "system", animationSpeed: 1 }}
            onSessionChange={vi.fn()}
            onClose={vi.fn()}
          />,
        ),
      );
      await flushPromises();

      expect(container.querySelector(".desktop-learning-stage")?.classList)
        .toContain("is-motion-reduced");
      expect(container.querySelector(".desktop-learning-environment-status")?.textContent)
        .toBe("已减少动态效果；已启用 Windows 强制颜色");
    } finally {
      if (original) Object.defineProperty(window, "matchMedia", original);
      else Reflect.deleteProperty(window, "matchMedia");
    }
  });

  it("keeps the stage mounted until the retract animation has finished", async () => {
    const onClose = vi.fn();
    await act(async () =>
      root.render(
        <LearningDesktopStage
          session={session}
          settings={{ animationMode: "always", animationSpeed: 1 }}
          onSessionChange={vi.fn()}
          onClose={onClose}
        />,
      ),
    );
    await flushPromises();
    await finishQuestionWriting();

    await act(async () =>
      container.querySelector<HTMLButtonElement>(".desktop-learning-meta button")?.click(),
    );
    expect(container.querySelector('[role="dialog"]')?.textContent)
      .toContain("剩余 1 题回到未来选卡池");
    expect(backend.abandonLearningSession).not.toHaveBeenCalled();
    await act(async () =>
      [...container.querySelectorAll<HTMLButtonElement>(".desktop-learning-exit-confirm button")]
        .find((item) => item.textContent === "结束本轮")?.click(),
    );
    expect(container.querySelector(".desktop-learning-stage")?.getAttribute("data-stage-motion"))
      .toBe("closing");
    expect(onClose).not.toHaveBeenCalled();

    await advanceTimers(310);
    expect(backend.abandonLearningSession).toHaveBeenCalledWith("session-1", 2);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("pauses the current question with its revision before retracting", async () => {
    const onClose = vi.fn();
    await act(async () =>
      root.render(
        <LearningDesktopStage
          session={session}
          settings={{ animationMode: "always", animationSpeed: 1 }}
          onSessionChange={vi.fn()}
          onClose={onClose}
        />,
      ),
    );
    await flushPromises();
    await finishQuestionWriting();
    await act(async () =>
      container.querySelector<HTMLButtonElement>(".desktop-learning-meta button")?.click(),
    );
    await act(async () =>
      [...container.querySelectorAll<HTMLButtonElement>(".desktop-learning-exit-confirm button")]
        .find((item) => item.textContent === "暂停，稍后继续")?.click(),
    );
    expect(backend.pauseLearningSession).toHaveBeenCalledWith("session-1", 2);
    expect(onClose).not.toHaveBeenCalled();
    await advanceTimers(310);
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
