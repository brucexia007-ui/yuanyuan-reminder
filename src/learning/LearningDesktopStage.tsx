import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type CSSProperties,
  type PointerEvent as ReactPointerEvent,
} from "react";

import type {
  AppSettings,
  LearningAnswerResult,
  LearningCardDto,
  LearningQuestionDto,
  LearningRating,
  LearningSessionSnapshot,
  LearningSessionSummary,
} from "../types";
import { SpriteAnimator } from "../pet/SpriteAnimator";
import type { AnimationName } from "../pet/manifest";
import {
  abandonLearningSession,
  answerLearningQuestion,
  dismissCompletedLearningSession,
  getCurrentLearningCard,
  getCurrentLearningQuestion,
  getLearningSessionSummary,
  pauseLearningSession,
  rateLearningCard,
  startManualLearningSession,
} from "./backend";
import "./learningDesktop.css";

type AnswerTarget = "correct" | "wrong";
type FeedbackPhase = "awaiting" | "pressing" | "ready";
type DesktopStageScreen = "question" | "complete";
type StageMotion = "entering" | "steady" | "closing";
type QuestionMotion = "writing" | "steady" | "erasing";

const CONTACT_FRAME_INDEX = 5;
const BOARD_ENTER_MS = 460;
const BOARD_EXIT_MS = 280;
const QUESTION_WRITE_MS = 260;
const QUESTION_ERASE_MS = 140;
const BUTTON_REBOUND_MS = 170;
const CURIOUS_DELAY_MS = 15_000;
const FEEDBACK_BUBBLE_MS = 1_200;
const CORRECT_AUTO_ADVANCE_MS = 200;

function pressAnimationFor(target: AnswerTarget): AnimationName {
  return target === "correct"
    ? "learning-press-correct"
    : "learning-press-wrong";
}

function feedbackAnnouncementFor(target: AnswerTarget): string {
  return target === "correct" ? "回答正确，真棒" : "回答错误，可惜了";
}

function animationsEnabled(
  mode: AppSettings["animationMode"],
  systemReducedMotion: boolean,
): boolean {
  if (mode === "always") return true;
  if (mode === "off") return false;
  return !systemReducedMotion;
}

function useMediaQuery(query: string): boolean {
  const read = () =>
    typeof window.matchMedia === "function" && window.matchMedia(query).matches;
  const [matches, setMatches] = useState(read);
  useEffect(() => {
    if (typeof window.matchMedia !== "function") return;
    const media = window.matchMedia(query);
    const update = () => setMatches(media.matches);
    update();
    media.addEventListener("change", update);
    return () => media.removeEventListener("change", update);
  }, [query]);
  return matches;
}

function stopStagePointer(event: ReactPointerEvent<HTMLElement>) {
  event.stopPropagation();
}

function scaledMotionDuration(duration: number, speed: number): number {
  return Math.round(duration / Math.max(0.4, Math.min(2, speed)));
}

export function LearningDesktopStage({
  session,
  settings,
  onSessionChange,
  onClose,
}: {
  session: LearningSessionSnapshot;
  settings: Pick<AppSettings, "animationMode" | "animationSpeed">;
  onSessionChange: (session: LearningSessionSnapshot) => void;
  onClose: () => void;
}) {
  const [currentSession, setCurrentSession] =
    useState<LearningSessionSnapshot>(session);
  const [question, setQuestion] = useState<LearningQuestionDto | null>(null);
  const [fallbackCard, setFallbackCard] = useState<LearningCardDto | null>(null);
  const [answer, setAnswer] = useState<LearningAnswerResult | null>(null);
  const [busy, setBusy] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [flipped, setFlipped] = useState(false);
  const [screen, setScreen] = useState<DesktopStageScreen>(
    session.status === "completed" ? "complete" : "question",
  );
  const [petAnimation, setPetAnimation] =
    useState<AnimationName>("learning-study-sit");
  const [feedbackPhase, setFeedbackPhase] =
    useState<FeedbackPhase>("awaiting");
  const [pressTarget, setPressTarget] = useState<AnswerTarget | null>(null);
  const [pressedTarget, setPressedTarget] = useState<AnswerTarget | null>(null);
  const [confirmedTarget, setConfirmedTarget] =
    useState<AnswerTarget | null>(null);
  const [bubbleTarget, setBubbleTarget] = useState<AnswerTarget | null>(null);
  const [feedbackAnnouncement, setFeedbackAnnouncement] = useState("");
  const [curiousPlayed, setCuriousPlayed] = useState(false);
  const [wrongCount, setWrongCount] = useState(0);
  const [summary, setSummary] = useState<LearningSessionSummary | null>(null);
  const [exitConfirmationOpen, setExitConfirmationOpen] = useState(false);
  const systemReducedMotion = useMediaQuery("(prefers-reduced-motion: reduce)");
  const forcedColorsActive = useMediaQuery("(forced-colors: active)");
  const motionEnabled = animationsEnabled(
    settings.animationMode,
    systemReducedMotion,
  );
  const [stageMotion, setStageMotion] = useState<StageMotion>(
    motionEnabled ? "entering" : "steady",
  );
  const [questionMotion, setQuestionMotion] = useState<QuestionMotion>(
    motionEnabled ? "writing" : "steady",
  );
  const firstOptionRef = useRef<HTMLButtonElement>(null);
  const nextButtonRef = useRef<HTMLButtonElement>(null);
  const questionStartedAtRef = useRef(Date.now());
  const curiousTimerRef = useRef<number | null>(null);
  const autoAdvanceTimerRef = useRef<number | null>(null);
  const answerInFlightRef = useRef(false);
  const contactHandledRef = useRef(false);
  const motionEnabledRef = useRef(motionEnabled);
  motionEnabledRef.current = motionEnabled;

  const clearCuriousTimer = useCallback(() => {
    if (curiousTimerRef.current === null) return;
    window.clearTimeout(curiousTimerRef.current);
    curiousTimerRef.current = null;
  }, []);

  const clearAutoAdvanceTimer = useCallback(() => {
    if (autoAdvanceTimerRef.current === null) return;
    window.clearTimeout(autoAdvanceTimerRef.current);
    autoAdvanceTimerRef.current = null;
  }, []);

  useEffect(
    () => () => {
      clearCuriousTimer();
      clearAutoAdvanceTimer();
    },
    [clearAutoAdvanceTimer, clearCuriousTimer],
  );

  const motionDelay = useCallback(
    (duration: number) =>
      motionEnabled
        ? new Promise<void>((resolve) => {
            window.setTimeout(
              resolve,
              scaledMotionDuration(duration, settings.animationSpeed),
            );
          })
        : Promise.resolve(),
    [motionEnabled, settings.animationSpeed],
  );

  const updateSession = useCallback(
    (next: LearningSessionSnapshot) => {
      setCurrentSession(next);
      onSessionChange(next);
    },
    [onSessionChange],
  );

  const settleFeedbackImmediately = useCallback((target: AnswerTarget) => {
    contactHandledRef.current = true;
    setPressedTarget(target);
    setConfirmedTarget(target);
    setBubbleTarget(target);
    setFeedbackAnnouncement(feedbackAnnouncementFor(target));
    setFeedbackPhase("ready");
    setPetAnimation("learning-study-sit");
  }, []);

  const prepareQuestion = useCallback(async (sessionId: string) => {
    clearAutoAdvanceTimer();
    setBusy(true);
    setError(null);
    try {
      const nextQuestion = await getCurrentLearningQuestion(sessionId);
      const nextFallback =
        nextQuestion.kind === "recall_fallback"
          ? await getCurrentLearningCard(sessionId)
          : null;
      setQuestion(nextQuestion);
      setFallbackCard(nextFallback);
      setAnswer(null);
      setFlipped(false);
      setFeedbackPhase("awaiting");
      setPressTarget(null);
      setPressedTarget(null);
      setConfirmedTarget(null);
      setBubbleTarget(null);
      setFeedbackAnnouncement("");
      setCuriousPlayed(false);
      contactHandledRef.current = false;
      setPetAnimation("learning-study-sit");
      setScreen("question");
      setQuestionMotion(motionEnabledRef.current ? "writing" : "steady");
      questionStartedAtRef.current = Date.now();
    } catch (reason) {
      setError(`这道题暂时打不开：${learningErrorMessage(reason)}`);
      setQuestionMotion("steady");
    } finally {
      setBusy(false);
    }
  }, [clearAutoAdvanceTimer]);

  useEffect(() => {
    if (!motionEnabled) {
      setStageMotion((current) =>
        current === "closing" ? current : "steady",
      );
      setQuestionMotion("steady");
      return;
    }
    if (stageMotion !== "entering") return;
    const timer = window.setTimeout(
      () => setStageMotion("steady"),
      scaledMotionDuration(BOARD_ENTER_MS, settings.animationSpeed),
    );
    return () => window.clearTimeout(timer);
  }, [motionEnabled, settings.animationSpeed, stageMotion]);

  useEffect(() => {
    if (questionMotion !== "writing") return;
    if (!motionEnabled) {
      setQuestionMotion("steady");
      return;
    }
    const timer = window.setTimeout(
      () => setQuestionMotion("steady"),
      scaledMotionDuration(QUESTION_WRITE_MS, settings.animationSpeed),
    );
    return () => window.clearTimeout(timer);
  }, [motionEnabled, question?.questionId, questionMotion, settings.animationSpeed]);

  useEffect(() => {
    if (!pressedTarget) return;
    const timer = window.setTimeout(
      () => setPressedTarget(null),
      scaledMotionDuration(BUTTON_REBOUND_MS, settings.animationSpeed),
    );
    return () => window.clearTimeout(timer);
  }, [pressedTarget, settings.animationSpeed]);

  useEffect(() => {
    if (!bubbleTarget) return;
    const timer = window.setTimeout(
      () => setBubbleTarget(null),
      FEEDBACK_BUBBLE_MS,
    );
    return () => window.clearTimeout(timer);
  }, [bubbleTarget]);

  useEffect(() => {
    clearCuriousTimer();
    if (
      !motionEnabled ||
      screen !== "question" ||
      busy ||
      Boolean(answer) ||
      feedbackPhase !== "awaiting" ||
      questionMotion !== "steady" ||
      question?.kind !== "multiple_choice" ||
      curiousPlayed
    ) {
      if (
        !motionEnabled &&
        screen === "question" &&
        feedbackPhase === "awaiting"
      ) {
        setPetAnimation("learning-study-sit");
      }
      return;
    }

    curiousTimerRef.current = window.setTimeout(() => {
      curiousTimerRef.current = null;
      if (answerInFlightRef.current) return;
      setCuriousPlayed(true);
      setPetAnimation("learning-study-curious");
    }, CURIOUS_DELAY_MS);

    return clearCuriousTimer;
  }, [
    answer,
    busy,
    clearCuriousTimer,
    curiousPlayed,
    feedbackPhase,
    motionEnabled,
    question?.kind,
    questionMotion,
    screen,
  ]);

  useEffect(() => {
    if (motionEnabled || feedbackPhase !== "pressing" || !pressTarget) return;
    settleFeedbackImmediately(pressTarget);
  }, [
    feedbackPhase,
    motionEnabled,
    pressTarget,
    settleFeedbackImmediately,
  ]);

  useEffect(() => {
    setCurrentSession(session);
    if (session.status === "completed") {
      setScreen("complete");
      setPetAnimation("waving");
      setQuestionMotion("steady");
      setBusy(false);
      void getLearningSessionSummary(session.sessionId)
        .then(setSummary)
        .catch(() => setSummary(null));
      return;
    }
    void prepareQuestion(session.sessionId);
  }, [prepareQuestion, session.sessionId]);

  useEffect(() => {
    if (
      !busy &&
      feedbackPhase === "awaiting" &&
      questionMotion === "steady"
    ) {
      firstOptionRef.current?.focus();
    }
  }, [busy, feedbackPhase, question?.questionId, questionMotion]);

  useEffect(() => {
    if (feedbackPhase === "ready" && answer && !answer.correct) {
      nextButtonRef.current?.focus();
    }
  }, [answer, feedbackPhase]);

  const finishAndClose = useCallback(async () => {
    if (busy) return;
    const feedbackTargetToRestore =
      pressTarget && feedbackPhase !== "awaiting" ? pressTarget : null;
    clearCuriousTimer();
    clearAutoAdvanceTimer();
    setBubbleTarget(null);
    setFeedbackAnnouncement("");
    setPressedTarget(null);
    setConfirmedTarget(null);
    setPetAnimation("learning-study-sit");
    setExitConfirmationOpen(false);
    setBusy(true);
    setStageMotion("closing");
    try {
      const finishRequest =
        currentSession.status === "active"
          ? abandonLearningSession(
              currentSession.sessionId,
              currentSession.stateRevision,
            )
          : dismissCompletedLearningSession(
              currentSession.sessionId,
              currentSession.stateRevision,
            );
      await Promise.all([finishRequest, motionDelay(BOARD_EXIT_MS)]);
      onClose();
    } catch (reason) {
      setStageMotion("steady");
      setError(`本轮暂时无法结束：${learningErrorMessage(reason)}`);
      if (feedbackTargetToRestore) {
        settleFeedbackImmediately(feedbackTargetToRestore);
      }
      setBusy(false);
    }
  }, [
    busy,
    clearAutoAdvanceTimer,
    clearCuriousTimer,
    currentSession,
    feedbackPhase,
    motionDelay,
    onClose,
    pressTarget,
    settleFeedbackImmediately,
  ]);

  const pauseAndClose = useCallback(async () => {
    if (busy || currentSession.status !== "active") return;
    clearCuriousTimer();
    clearAutoAdvanceTimer();
    setExitConfirmationOpen(false);
    setBusy(true);
    setStageMotion("closing");
    try {
      await Promise.all([
        pauseLearningSession(
          currentSession.sessionId,
          currentSession.stateRevision,
        ),
        motionDelay(BOARD_EXIT_MS),
      ]);
      onClose();
    } catch (reason) {
      setStageMotion("steady");
      setError(`本轮暂时无法暂停：${learningErrorMessage(reason)}`);
      setBusy(false);
    }
  }, [
    busy,
    clearAutoAdvanceTimer,
    clearCuriousTimer,
    currentSession,
    motionDelay,
    onClose,
  ]);

  const requestExit = useCallback(() => {
    if (busy) return;
    clearAutoAdvanceTimer();
    if (
      currentSession.status === "active"
      && currentSession.completedCount < currentSession.plannedCount
    ) {
      setExitConfirmationOpen(true);
      return;
    }
    void finishAndClose();
  }, [busy, clearAutoAdvanceTimer, currentSession, finishAndClose]);

  const submitAnswer = useCallback(
    async (optionId: string) => {
      if (
        !question ||
        question.kind !== "multiple_choice" ||
        answer ||
        busy ||
        feedbackPhase !== "awaiting"
      ) {
        return;
      }
      answerInFlightRef.current = true;
      clearCuriousTimer();
      setPetAnimation("learning-study-sit");
      setBusy(true);
      setError(null);
      try {
        const result = await answerLearningQuestion(
          currentSession.sessionId,
          question.questionId,
          optionId,
          crypto.randomUUID(),
          Math.max(0, Date.now() - questionStartedAtRef.current),
        );
        const target: AnswerTarget = result.correct ? "correct" : "wrong";
        setAnswer(result);
        updateSession(result.session);
        setPressTarget(target);
        setConfirmedTarget(null);
        setBubbleTarget(null);
        setFeedbackAnnouncement("");
        contactHandledRef.current = false;
        if (!result.correct && !result.isRemediation) {
          setWrongCount((value) => value + 1);
        }
        if (motionEnabledRef.current) {
          setFeedbackPhase("pressing");
          setPetAnimation(pressAnimationFor(target));
        } else {
          settleFeedbackImmediately(target);
        }
      } catch (reason) {
        setError(`这道题暂时没有记入：${learningErrorMessage(reason)}`);
      } finally {
        answerInFlightRef.current = false;
        setBusy(false);
      }
    },
    [
      answer,
      busy,
      clearCuriousTimer,
      currentSession.sessionId,
      feedbackPhase,
      question,
      settleFeedbackImmediately,
      updateSession,
    ],
  );

  const onPetFrame = useCallback(
    (animation: AnimationName, frameIndex: number) => {
      const expectedAnimation = pressTarget
        ? pressAnimationFor(pressTarget)
        : null;
      if (
        animation === expectedAnimation &&
        frameIndex === CONTACT_FRAME_INDEX &&
        pressTarget &&
        !contactHandledRef.current
      ) {
        contactHandledRef.current = true;
        setPressedTarget(pressTarget);
        setConfirmedTarget(pressTarget);
        setBubbleTarget(pressTarget);
        setFeedbackAnnouncement(feedbackAnnouncementFor(pressTarget));
      }
    },
    [pressTarget],
  );

  const onPetAnimationComplete = useCallback(
    (animation: AnimationName) => {
      if (animation === "learning-study-curious") {
        if (
          feedbackPhase === "awaiting" &&
          !answer &&
          !answerInFlightRef.current
        ) {
          setPetAnimation("learning-study-sit");
        }
        return;
      }
      const expectedAnimation = pressTarget
        ? pressAnimationFor(pressTarget)
        : null;
      if (
        animation === expectedAnimation &&
        feedbackPhase === "pressing"
      ) {
        setFeedbackPhase("ready");
        setPetAnimation("learning-study-sit");
      }
    },
    [answer, feedbackPhase, pressTarget],
  );

  const transitionToQuestion = useCallback(
    async (sessionId: string) => {
      clearCuriousTimer();
      clearAutoAdvanceTimer();
      setBubbleTarget(null);
      setFeedbackAnnouncement("");
      setPressedTarget(null);
      setConfirmedTarget(null);
      setPetAnimation("learning-study-sit");
      setBusy(true);
      if (motionEnabled) {
        setQuestionMotion("erasing");
        await motionDelay(QUESTION_ERASE_MS);
      }
      await prepareQuestion(sessionId);
    },
    [clearAutoAdvanceTimer, clearCuriousTimer, motionDelay, motionEnabled, prepareQuestion],
  );

  const showCompletion = useCallback(async () => {
    clearCuriousTimer();
    clearAutoAdvanceTimer();
    setBubbleTarget(null);
    setFeedbackAnnouncement("");
    setPressedTarget(null);
    setConfirmedTarget(null);
    setBusy(true);
    if (motionEnabled) {
      setQuestionMotion("erasing");
      await motionDelay(QUESTION_ERASE_MS);
    }
    setQuestionMotion("steady");
    try {
      setSummary(await getLearningSessionSummary(currentSession.sessionId));
    } catch {
      setSummary(null);
    }
    setScreen("complete");
    setPetAnimation("waving");
    setBusy(false);
  }, [clearAutoAdvanceTimer, clearCuriousTimer, currentSession.sessionId, motionDelay, motionEnabled]);

  const startNextRound = useCallback(async (
    kind: LearningSessionSnapshot["sessionKind"],
    sourceSessionId: string | null = null,
  ) => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const count = normalizedRoundSize(currentSession.plannedCount);
      const next = await startManualLearningSession(count, kind, sourceSessionId);
      setSummary(null);
      setWrongCount(0);
      updateSession(next);
      await prepareQuestion(next.sessionId);
    } catch (reason) {
      setError(`下一轮暂时不能开始：${learningErrorMessage(reason)}`);
      setBusy(false);
    }
  }, [busy, currentSession.plannedCount, prepareQuestion, updateSession]);

  const continueSession = useCallback(async () => {
    if (!answer || busy || feedbackPhase !== "ready") return;
    if (answer.session.status === "completed") {
      await showCompletion();
      return;
    }
    await transitionToQuestion(answer.session.sessionId);
  }, [answer, busy, feedbackPhase, showCompletion, transitionToQuestion]);

  useEffect(() => {
    clearAutoAdvanceTimer();
    if (
      !answer?.correct
      || busy
      || feedbackPhase !== "ready"
      || screen !== "question"
      || exitConfirmationOpen
    ) {
      return;
    }
    autoAdvanceTimerRef.current = window.setTimeout(() => {
      autoAdvanceTimerRef.current = null;
      void continueSession();
    }, motionEnabled ? CORRECT_AUTO_ADVANCE_MS : 600);
    return clearAutoAdvanceTimer;
  }, [
    answer,
    busy,
    clearAutoAdvanceTimer,
    continueSession,
    feedbackPhase,
    exitConfirmationOpen,
    motionEnabled,
    screen,
  ]);

  const rateFallback = useCallback(
    async (rating: LearningRating) => {
      if (!fallbackCard || !flipped || busy) return;
      setBusy(true);
      setError(null);
      try {
        const result = await rateLearningCard(
          currentSession.sessionId,
          fallbackCard.cardId,
          rating,
          currentSession.stateRevision,
        );
        updateSession(result.session);
        if (result.session.status === "completed") {
          await showCompletion();
        } else {
          await transitionToQuestion(result.session.sessionId);
        }
      } catch (reason) {
        setError(`这张卡暂时没有记入：${learningErrorMessage(reason)}`);
      } finally {
        setBusy(false);
      }
    },
    [
      busy,
      currentSession.sessionId,
      currentSession.stateRevision,
      fallbackCard,
      flipped,
      showCompletion,
      transitionToQuestion,
      updateSession,
    ],
  );

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        if (exitConfirmationOpen) setExitConfirmationOpen(false);
        else requestExit();
        return;
      }
      if (exitConfirmationOpen) return;
      if (
        event.key === "Enter"
        && answer?.correct
        && feedbackPhase === "ready"
        && !busy
      ) {
        event.preventDefault();
        clearAutoAdvanceTimer();
        void continueSession();
        return;
      }
      if (
        screen !== "question" ||
        !question ||
        question.kind !== "multiple_choice" ||
        answer ||
        busy ||
        feedbackPhase !== "awaiting" ||
        questionMotion !== "steady"
      ) {
        return;
      }
      const option = question.options[Number(event.key) - 1];
      if (!option) return;
      event.preventDefault();
      void submitAnswer(option.optionId);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [
    answer,
    busy,
    clearAutoAdvanceTimer,
    continueSession,
    exitConfirmationOpen,
    feedbackPhase,
    question,
    questionMotion,
    requestExit,
    screen,
    submitAnswer,
  ]);

  const stageClassName = [
    "desktop-learning-stage",
    screen === "complete" ? "is-complete" : "",
    motionEnabled ? "" : "is-motion-reduced",
  ]
    .filter(Boolean)
    .join(" ");
  const stageStyle = {
    "--learning-enter-duration": `${scaledMotionDuration(
      BOARD_ENTER_MS,
      settings.animationSpeed,
    )}ms`,
    "--learning-exit-duration": `${scaledMotionDuration(
      BOARD_EXIT_MS,
      settings.animationSpeed,
    )}ms`,
    "--learning-write-duration": `${scaledMotionDuration(
      QUESTION_WRITE_MS,
      settings.animationSpeed,
    )}ms`,
    "--learning-erase-duration": `${scaledMotionDuration(
      QUESTION_ERASE_MS,
      settings.animationSpeed,
    )}ms`,
  } as CSSProperties;
  const feedbackTarget = answer
    ? answer.correct
      ? "correct"
      : "wrong"
    : "none";
  const environmentStatus = [
    !motionEnabled ? "已减少动态效果" : null,
    forcedColorsActive ? "已启用 Windows 强制颜色" : null,
  ].filter(Boolean).join("；");

  if (screen === "complete") {
    return (
      <section
        className={stageClassName}
        data-stage-motion={stageMotion}
        data-question-motion={questionMotion}
        data-feedback="complete"
        style={stageStyle}
        aria-label="英语复习完成"
        aria-busy={busy}
        onPointerDown={stopStagePointer}
        onPointerMove={stopStagePointer}
        onPointerUp={stopStagePointer}
        onPointerCancel={stopStagePointer}
      >
        {environmentStatus && (
          <p className="desktop-learning-environment-status">{environmentStatus}</p>
        )}
        <article className="desktop-learning-board desktop-learning-complete">
          <p className="desktop-learning-eyebrow">本轮完成</p>
          <h2>小黑板复习完成</h2>
          <div className="desktop-learning-summary-grid">
            <span><strong>{summary?.correctCount ?? currentSession.completedCount - wrongCount}</strong><small>首答正确</small></span>
            <span><strong>{summary?.wrongCount ?? wrongCount}</strong><small>本轮错题</small></span>
            <span><strong>{formatRoundDuration(summary?.durationSeconds ?? 0)}</strong><small>本轮用时</small></span>
          </div>
          <p>新认识 {summary?.newCount ?? 0} 个，复习 {summary?.reviewCount ?? 0} 个。想继续就再来一轮。</p>
          {error && <p className="desktop-learning-complete-error" role="alert">{error}</p>}
          <div className="desktop-learning-complete-actions">
            <button
              className="desktop-learning-primary"
              type="button"
              disabled={busy}
              onClick={() => void startNextRound("daily")}
            >
              再学一轮 · {normalizedRoundSize(currentSession.plannedCount)} 个
            </button>
            {(summary?.targetableWrongCount ?? 0) > 0 && (
              <button
                type="button"
                disabled={busy}
                onClick={() => void startNextRound("mistakes", currentSession.sessionId)}
              >
                订正本轮错题 · {summary?.targetableWrongCount} 个
              </button>
            )}
            <button type="button" disabled={busy} onClick={requestExit}>
              先休息一下
            </button>
          </div>
        </article>
        <div className="desktop-learning-pet is-complete" aria-hidden="true">
          <SpriteAnimator animation="waving" settings={settings} />
        </div>
      </section>
    );
  }

  return (
    <section
      className={stageClassName}
      data-stage-motion={stageMotion}
      data-question-motion={questionMotion}
      data-feedback={feedbackTarget}
      data-feedback-phase={feedbackPhase}
      data-feedback-contact={confirmedTarget ?? "none"}
      style={stageStyle}
      aria-label="圆圆桌面英语复习"
      aria-busy={busy}
      onPointerDown={stopStagePointer}
      onPointerMove={stopStagePointer}
      onPointerUp={stopStagePointer}
      onPointerCancel={stopStagePointer}
    >
      {environmentStatus && (
        <p className="desktop-learning-environment-status">{environmentStatus}</p>
      )}
      <article className="desktop-learning-board">
        <header className="desktop-learning-meta">
          <span>
            {question?.isRemediation
              ? "本轮错题回看"
              : `${answer ? currentSession.completedCount : currentSession.completedCount + 1} / ${currentSession.plannedCount}`}
            <small> · 数字键 1–4</small>
          </span>
          <button type="button" disabled={busy} onClick={requestExit}>
            结束本轮
          </button>
        </header>

        {error ? (
          <div className="desktop-learning-error" role="alert">
            <span>{error}</span>
            <button type="button" onClick={() => setError(null)} aria-label="关闭错误">×</button>
          </div>
        ) : question ? (
          <div
            key={question.questionId}
            className="desktop-learning-question"
          >
            <div className="desktop-learning-word-row">
              <span>{stageLabel(question.stage)}</span>
              <h2 lang="en">{question.headword}</h2>
              <small>{question.phonetic ?? question.partOfSpeech.join(" · ")}</small>
            </div>

            {question.kind === "multiple_choice" ? (
              <div className="desktop-learning-options" aria-label="请选择中文释义">
                {question.options.map((option, index) => {
                  const selected = answer?.selectedOptionId === option.optionId;
                  const correct = answer?.correctOptionId === option.optionId;
                  return (
                    <button
                      key={option.optionId}
                      ref={index === 0 ? firstOptionRef : undefined}
                      className={[
                        "desktop-learning-option",
                        correct ? "is-correct" : "",
                        selected && !answer?.correct ? "is-wrong" : "",
                        answer && !correct && !selected ? "is-muted" : "",
                      ].filter(Boolean).join(" ")}
                      type="button"
                      disabled={
                        busy ||
                        Boolean(answer) ||
                        questionMotion !== "steady"
                      }
                      onClick={() => void submitAnswer(option.optionId)}
                    >
                      <span aria-hidden="true">{index + 1}</span>
                      <strong>{option.meaningZh}</strong>
                    </button>
                  );
                })}
              </div>
            ) : fallbackCard ? (
              <div className="desktop-learning-fallback">
                {!flipped ? (
                  <button type="button" disabled={busy} onClick={() => setFlipped(true)}>
                    选项不足，看看含义
                  </button>
                ) : (
                  <>
                    <p>{fallbackCard.meaningsZh.join("；")}</p>
                    <div role="group" aria-label="这次想得怎么样">
                      <button type="button" onClick={() => void rateFallback("again")}>忘了</button>
                      <button type="button" onClick={() => void rateFallback("hard")}>模糊</button>
                      <button type="button" onClick={() => void rateFallback("good")}>记得</button>
                    </div>
                  </>
                )}
              </div>
            ) : null}

            {answer && (
              <div
                className={`desktop-learning-feedback ${answer.correct ? "is-correct" : "is-wrong"}`}
              >
                <span>
                  <strong>{answer.correct ? "回答正确" : "这次需要再看"}</strong>
                  {!answer.correct && ` · 正确释义：${answer.correctMeaningZh}`}
                </span>
                {answer.correct ? (
                  <small className="desktop-learning-auto-next">
                    {feedbackPhase === "ready"
                      ? answer.session.status === "completed"
                        ? "即将显示本次结果…"
                        : "即将自动进入下一题…"
                      : "圆圆正在按按钮…"}
                  </small>
                ) : (
                  <button
                    ref={nextButtonRef}
                    className="desktop-learning-primary"
                    type="button"
                    disabled={busy || feedbackPhase !== "ready"}
                    onClick={() => void continueSession()}
                  >
                    {feedbackPhase === "ready"
                      ? answer.session.status === "completed"
                        ? "查看结果"
                        : "我看懂了，下一题"
                      : "圆圆正在按按钮…"}
                  </button>
                )}
              </div>
            )}
          </div>
        ) : (
          <div className="desktop-learning-loading" role="status">圆圆正在写题目…</div>
        )}
      </article>

      {exitConfirmationOpen && (
        <div className="desktop-learning-exit-confirm" role="dialog" aria-modal="true" aria-labelledby="desktop-learning-exit-title">
          <div>
            <strong id="desktop-learning-exit-title">暂停，还是结束本轮？</strong>
            <p>暂停会保留当前题，可在 24 小时内继续；结束后，剩余 {Math.max(0, currentSession.plannedCount - currentSession.completedCount)} 题回到未来选卡池。</p>
            <span>
              <button type="button" autoFocus onClick={() => setExitConfirmationOpen(false)}>继续学习</button>
              <button className="desktop-learning-primary" type="button" onClick={() => void pauseAndClose()}>暂停，稍后继续</button>
              <button className="desktop-learning-exit-danger" type="button" onClick={() => void finishAndClose()}>结束本轮</button>
            </span>
          </div>
        </div>
      )}

      <p
        className="desktop-learning-live-status"
        role="status"
        aria-live="polite"
        aria-atomic="true"
      >
        {feedbackAnnouncement}
      </p>

      <div className="desktop-learning-console" aria-label="圆圆用按钮反馈答题结果">
        <span
          className={[
            "desktop-learning-result-button",
            "green",
            pressedTarget === "correct" ? "is-pressed" : "",
            confirmedTarget === "correct" ? "is-confirmed" : "",
          ]
            .filter(Boolean)
            .join(" ")}
          aria-hidden="true"
        >
          ✓
          {bubbleTarget === "correct" && (
            <span className="desktop-learning-result-bubble">真棒！</span>
          )}
        </span>
        <div className="desktop-learning-pet" aria-hidden="true">
          <SpriteAnimator
            animation={petAnimation}
            settings={settings}
            onFrameChange={onPetFrame}
            onComplete={onPetAnimationComplete}
          />
        </div>
        <span
          className={[
            "desktop-learning-result-button",
            "red",
            pressedTarget === "wrong" ? "is-pressed" : "",
            confirmedTarget === "wrong" ? "is-confirmed" : "",
          ]
            .filter(Boolean)
            .join(" ")}
          aria-hidden="true"
        >
          ×
          {bubbleTarget === "wrong" && (
            <span className="desktop-learning-result-bubble">可惜了</span>
          )}
        </span>
      </div>

    </section>
  );
}

function stageLabel(stage: LearningQuestionDto["stage"]): string {
  return { new: "新卡", learning: "学习中", stable: "复习" }[stage];
}

function normalizedRoundSize(value: number): 3 | 5 | 10 {
  if (value <= 3) return 3;
  if (value <= 5) return 5;
  return 10;
}

function formatRoundDuration(seconds: number): string {
  if (seconds < 60) return `${Math.max(1, seconds)}秒`;
  return `${Math.floor(seconds / 60)}分${String(seconds % 60).padStart(2, "0")}秒`;
}

function learningErrorMessage(reason: unknown): string {
  const message = reason instanceof Error ? reason.message : String(reason);
  if (message.includes("no unresolved learning mistakes are currently available")) {
    return "本轮错题已经订正，后续会按计划复查";
  }
  if (message.includes("no learning cards are currently available")) {
    return "词库已经学完，目前也没有到期复习";
  }
  return message;
}
