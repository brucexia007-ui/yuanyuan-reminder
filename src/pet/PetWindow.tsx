import { invoke } from "@tauri-apps/api/core";
import {
  LogicalSize,
  PhysicalPosition,
  PhysicalSize,
} from "@tauri-apps/api/dpi";
import { currentMonitor, getCurrentWindow } from "@tauri-apps/api/window";
import {
  lazy,
  Suspense,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
} from "react";
import {
  completeOccurrence,
  getBasicSupportState,
  getCompanionExpressionSnapshot,
  getFocusState,
  getPetActivitySnapshot,
  getSettings,
  listToday,
  onBackendEvent,
  setPetSize,
  showTaskPanel,
  skipOccurrence,
  snoozeOccurrence,
  tauriAvailable,
} from "../lib/backend";
import type {
  AppSettings,
  BasicSupportSession,
  CompanionExpressionSnapshot,
  FocusState,
  PetInteractionStarted,
  PetIntent,
  LearningInvitationDto,
  LearningSessionSnapshot,
  PetActivitySnapshot,
  TodaySnapshot,
} from "../types";
import { learningBuildEnabled } from "../learning/featureGate";
import { SpriteAnimator } from "./SpriteAnimator";
import { CompanionPropStage } from "./CompanionPropStage";
import {
  animationForCompanionExpression,
  settledAnimationAfterCompanionCue,
} from "./companionMotion";
import type { AnimationName, LifeAnimationName } from "./manifest";
import {
  formatRemaining,
  basicSupportSuppressesIntent,
  intentTextSurface,
  motionOnlyAccessibleLabel,
  quietSuppressesIntent,
  remindersPaused,
} from "./petIntent";
import {
  BALL_GAME_PHASE_MS,
  ballChargeFromElapsed,
  ballChaseOffset,
  ballFlightDuration,
  ballHomeX,
  ballStageWidth,
  ballTargetX,
  nextBallGamePhase,
  type BallGamePhase,
} from "./ballGame";
import {
  ALERT_STAGE_HEIGHT,
  ALERT_STAGE_WIDTH,
  alertPetHeight,
  alertPetWidth,
  alertStagePosition,
} from "./alertStage";
import {
  LEARNING_STAGE_HEIGHT,
  LEARNING_STAGE_WIDTH,
  learningStagePosition,
  restoredPetPosition,
  scaledScreenWorkArea,
  visibleMonitorWorkArea,
} from "./learningStage";
import {
  advanceInteractionFrame,
  followOffsetTowardPointer,
  gentleHeadOffsetTowardPointer,
  shouldAdvancePettingFrame,
  shouldMirrorTowardPointer,
  shouldMirrorTowardPointerWithHysteresis,
  transitionToolInteraction,
  treatFrameFromPointerHeight,
  wandDirectionFrame,
} from "./interactionMotion";
import {
  COMPACT_PET_WINDOW_GUTTER,
  TOOL_CARD_LANE_WIDTH,
  interactionStagePosition,
  interactionStageWidth,
  interactionWindowWidth,
} from "./interactionStage";
import "./pet.css";

const LazyLearningDesktopStage = learningBuildEnabled
  ? lazy(() =>
      import("../learning/LearningDesktopStage").then(
        ({ LearningDesktopStage }) => ({ default: LearningDesktopStage }),
      ),
    )
  : null;

const defaultSettings: AppSettings = {
  animationMode: "always",
  companionIntensity: "everyday",
  companionLabelMode: "adaptive",
  animationSpeed: 1,
  cursorFollow: true,
  alwaysOnTop: true,
  clickThrough: false,
  learningQuickStartVisible: true,
  petWidth: 192,
  quietStart: "23:00",
  quietEnd: "07:30",
  idleSleepMinutes: 20,
  autostart: false,
  pauseUntil: null,
  waterStart: "09:00",
  waterEnd: "18:00",
  waterIntervalMinutes: 60,
  activityEnabled: true,
  activityStart: "09:00",
  activityEnd: "18:00",
  activityIntervalMinutes: 60,
  missedReminderPolicy: "notify",
  missedReminderGraceMinutes: 120,
};

interface DragState {
  pointerId: number;
  startScreenX: number;
  startScreenY: number;
  windowX: number;
  windowY: number;
  scaleFactor: number;
  moved: boolean;
}

interface WindowSnapshot {
  position: PhysicalPosition;
  size: PhysicalSize;
}

type ExpandedWindowStage = "alert" | "learning" | "tool";

export interface PetSleepRequest {
  source?: "manual" | "automatic";
}

export function isManualSleepRequest(
  request: PetSleepRequest | null | undefined,
): boolean {
  // Older packaged callers emitted no payload; those calls came from explicit UI actions.
  return request?.source !== "automatic";
}

interface ActiveToolInteraction {
  id: string;
  kind: "treat" | "wand" | "pet" | "ball";
  x: number;
  y: number;
  frame: number;
  mirrored: boolean;
  offsetX: number;
  engaged: boolean;
  frameX: number;
  frameY: number;
  lastFrameAt: number;
  phase: number;
  ballPhase: BallGamePhase | null;
  charge: number;
  chargeStartedAt: number | null;
  stageWidth: number;
  targetX: number;
  flightDuration: number;
  ballVisible: boolean;
}

const wandPhaseAnimations = [
  "wand-reach",
  "wand-swipe",
  "wand-return",
  "wand-swipe",
] as const satisfies readonly AnimationName[];

const lifeAnimations: Array<{
  name: Exclude<LifeAnimationName, "belly-down">;
  weight: number;
}> = [
  { name: "grooming", weight: 0.3 },
  { name: "stretching", weight: 0.22 },
  { name: "yawning", weight: 0.2 },
  { name: "meowing", weight: 0.16 },
  { name: "belly-up", weight: 0.12 },
];

export function chooseLifeAnimation(
  randomValue: number,
): Exclude<LifeAnimationName, "belly-down"> {
  const normalized = Math.max(0, Math.min(0.999999, randomValue));
  let cursor = 0;
  for (const activity of lifeAnimations) {
    cursor += activity.weight;
    if (normalized < cursor) return activity.name;
  }
  return "grooming";
}

function isLifeAnimation(animation: AnimationName): animation is LifeAnimationName {
  return [
    "grooming",
    "grooming-chest",
    "grooming-flank",
    "stretching",
    "yawning",
    "meowing",
    "belly-up",
    "belly-down",
    "focus-calm",
    "eating-food",
    "drinking-water",
    "treat-follow",
    "wand-play",
    "wand-reach",
    "wand-swipe",
    "wand-return",
    "pet-nuzzle",
    "ball-bat",
    "ball-pickup",
    "ball-carry",
    "ball-drop",
    "alert-glass-paws",
  ].includes(animation);
}

function pendingIntentFromSnapshot(snapshot: TodaySnapshot): PetIntent | null {
  const active = snapshot.occurrences.filter((item) =>
    ["pending", "overdue"].includes(item.status),
  );
  const pending =
    active.find(
      (item) =>
        item.category !== "water" &&
        item.reminderId !== "system-activity-reminder",
    ) ??
    active.find((item) => item.category === "water") ??
    active.find((item) => item.reminderId === "system-activity-reminder");
  if (!pending) return null;
  const activity = pending.reminderId === "system-activity-reminder";
  return {
    id: `restored-${pending.id}-${pending.status}`,
    kind: activity ? "activity" : "overdue",
    // Restored content never creates presentation authority. The backend
    // activity snapshot decides whether this surface is allowed to appear.
    priority: 0,
    animation: activity ? "activity-jumping" : "alert-glass-paws",
    route: "today",
    title: activity ? "起来活动一下" : "还有事项等你处理",
    message: activity
      ? "你已经连续使用电脑一段时间，可以起来活动一下。"
      : pending.reminderTitle,
    occurrenceId: pending.id,
    persistent: true,
    expiresAt: null,
  };
}

function isStrongAlertIntent(intent: PetIntent | null): boolean {
  return Boolean(
    intent &&
      isCoreDirectedOccurrence(intent) &&
      intentTextSurface(intent) === "system_card",
  );
}

function isCoreDirectedOccurrence(intent: PetIntent): boolean {
  return (
    intent.occurrenceId !== null &&
    ["reminder", "overdue", "activity"].includes(intent.kind)
  );
}

function animationForPetIntent(
  intent: PetIntent,
  companion: CompanionExpressionSnapshot | null,
): AnimationName {
  return isCoreDirectedOccurrence(intent) && companion
    ? animationForCompanionExpression(companion)
    : intent.animation;
}

function withStrongAlertAnimation(intent: PetIntent): PetIntent {
  return isStrongAlertIntent(intent) && intent.kind !== "activity"
    ? { ...intent, animation: "alert-glass-paws" }
    : intent;
}

function ballPhaseMessage(phase: BallGamePhase | null): string {
  switch (phase) {
    case "charging":
      return "继续按住蓄力，松手扔出";
    case "flying":
      return "球飞出去啦";
    case "chasing":
      return "圆圆正在追球";
    case "batting":
      return "先扒拉两下";
    case "pickup":
      return "圆圆叼起球了";
    case "returning":
      return "圆圆正慢慢走回来";
    case "dropping":
      return "把球放回脚边";
    default:
      return "按住球蓄力，松手扔出";
  }
}

export function petSleepAccessibleStatus(
  snapshot: PetActivitySnapshot | null | undefined,
): string | null {
  if (snapshot?.activity === "sleeping") return "圆圆正在睡觉";
  if (
    snapshot?.activity === "interrupted" &&
    snapshot.resumableLearningSessionId &&
    snapshot.restoreTarget === "learning"
  ) {
    return "圆圆已醒，上一轮学习可以继续";
  }
  return null;
}

export function PetWindow() {
  const windowApi = useMemo(
    () => (tauriAvailable() ? getCurrentWindow() : null),
    [],
  );
  const [settings, setSettings] = useState(defaultSettings);
  const [animation, setAnimation] = useState<AnimationName>("idle");
  const [lookFrame, setLookFrame] = useState<number | null>(null);
  const [activeIntent, setActiveIntent] = useState<PetIntent | null>(null);
  const [alertActionPending, setAlertActionPending] = useState(false);
  const [alertSnoozeMinutes, setAlertSnoozeMinutes] = useState(10);
  const [focusState, setFocusState] = useState<FocusState>({ session: null });
  const [companionExpression, setCompanionExpression] =
    useState<CompanionExpressionSnapshot | null>(null);
  const [petActivity, setPetActivity] =
    useState<PetActivitySnapshot | null>(null);
  const [learningInvitation, setLearningInvitation] =
    useState<LearningInvitationDto | null>(null);
  const [desktopLearningSession, setDesktopLearningSession] =
    useState<LearningSessionSnapshot | null>(null);
  const [learningStartPending, setLearningStartPending] = useState(false);
  const [sleepPresentationActive, setSleepPresentationActive] = useState(false);
  const [toolInteraction, setToolInteraction] =
    useState<ActiveToolInteraction | null>(null);
  const [clock, setClock] = useState(Date.now());
  const drag = useRef<DragState | null>(null);
  const stateBeforeTransient = useRef<AnimationName>("idle");
  const currentAnimation = useRef<AnimationName>("idle");
  const cursorFollowEnabled = useRef(true);
  const bellyHoldTimer = useRef<number | null>(null);
  const activeIntentRef = useRef<PetIntent | null>(null);
  const basicSupportRef = useRef<BasicSupportSession | null>(null);
  const focusStateRef = useRef<FocusState>({ session: null });
  const sleepRequested = useRef(false);
  const queuedAfterWake = useRef<PetIntent | null>(null);
  const deferredIntent = useRef<PetIntent | null>(null);
  const toolInteractionRef = useRef<ActiveToolInteraction | null>(null);
  const settingsRef = useRef(defaultSettings);
  const companionExpressionRef = useRef<CompanionExpressionSnapshot | null>(null);
  const petActivityRef = useRef<PetActivitySnapshot | null>(null);
  const expandedWindowSnapshot = useRef<WindowSnapshot | null>(null);
  const expandedStageRevision = useRef(0);

  const clearBellyHold = useCallback(() => {
    if (bellyHoldTimer.current !== null) {
      window.clearTimeout(bellyHoldTimer.current);
      bellyHoldTimer.current = null;
    }
  }, []);

  useEffect(() => {
    currentAnimation.current = animation;
  }, [animation]);

  useEffect(() => {
    toolInteractionRef.current = toolInteraction;
  }, [toolInteraction]);

  useEffect(() => {
    settingsRef.current = settings;
  }, [settings]);

  const updateActiveIntent = useCallback((intent: PetIntent | null) => {
    activeIntentRef.current = intent;
    setActiveIntent(intent);
  }, []);

  const applyCompanionExpression = useCallback(
    (snapshot: CompanionExpressionSnapshot) => {
      if (
        companionExpressionRef.current &&
        snapshot.revision <= companionExpressionRef.current.revision
      ) {
        return;
      }
      companionExpressionRef.current = snapshot;
      setCompanionExpression(snapshot);
      const activity = petActivityRef.current?.activity;
      if (activity === "sleeping") return;
      if (
        !toolInteractionRef.current &&
        (activity !== "reminding" || !activeIntentRef.current)
      ) {
        setLookFrame(null);
        setAnimation(animationForCompanionExpression(snapshot));
      }
    },
    [],
  );

  const applyExpandedWindowStage = useCallback(
    async (stage: ExpandedWindowStage | null) => {
      const revision = ++expandedStageRevision.current;
      if (!windowApi) return;

      if (!stage) {
        const snapshot = expandedWindowSnapshot.current;
        if (!snapshot) return;

        const [scaleFactor, monitor] = await Promise.all([
          windowApi.scaleFactor(),
          currentMonitor(),
        ]);
        if (revision !== expandedStageRevision.current) return;
        let workArea = monitor
          ? visibleMonitorWorkArea(
              {
                position: monitor.workArea.position,
                size: monitor.workArea.size,
              },
              {
                position: monitor.position,
                size: monitor.size,
              },
            )
          : undefined;
        const browserWorkArea = scaledScreenWorkArea(window.screen, scaleFactor);
        if (browserWorkArea) {
          workArea = workArea
            ? visibleMonitorWorkArea(workArea, browserWorkArea)
            : browserWorkArea;
        }
        const restoredPosition = restoredPetPosition(
          snapshot.position,
          snapshot.size,
          workArea,
        );

        await windowApi.setSize(
          new PhysicalSize(snapshot.size.width, snapshot.size.height),
        );
        await windowApi.setPosition(
          new PhysicalPosition(restoredPosition.x, restoredPosition.y),
        );
        if (revision === expandedStageRevision.current) {
          expandedWindowSnapshot.current = null;
          if (
            restoredPosition.x !== snapshot.position.x ||
            restoredPosition.y !== snapshot.position.y
          ) {
            await invoke("save_pet_position", {
              x: restoredPosition.x,
              y: restoredPosition.y,
            }).catch(() => undefined);
          }
          await windowApi
            .setIgnoreCursorEvents(settingsRef.current.clickThrough)
            .catch(() => undefined);
        }
        return;
      }

      let snapshot = expandedWindowSnapshot.current;
      if (!snapshot) {
        const [position, size] = await Promise.all([
          windowApi.outerPosition(),
          windowApi.outerSize(),
        ]);
        if (revision !== expandedStageRevision.current) return;
        snapshot = { position, size };
        expandedWindowSnapshot.current = snapshot;
      }

      const [scaleFactor, monitor] = await Promise.all([
        windowApi.scaleFactor(),
        currentMonitor(),
      ]);
      if (revision !== expandedStageRevision.current) return;
      let workArea = monitor
        ? visibleMonitorWorkArea(
            {
              position: monitor.workArea.position,
              size: monitor.workArea.size,
            },
            {
              position: monitor.position,
              size: monitor.size,
            },
          )
        : undefined;
      const browserWorkArea = scaledScreenWorkArea(window.screen, scaleFactor);
      if (browserWorkArea) {
        workArea = workArea
          ? visibleMonitorWorkArea(workArea, browserWorkArea)
          : browserWorkArea;
      }
      const activeTool = stage === "tool" ? toolInteractionRef.current : null;
      if (stage === "tool" && !activeTool) return;
      const petHeight = Math.round(
        (settingsRef.current.petWidth * 208) / 192,
      );
      const target =
        stage === "alert"
          ? alertStagePosition(
              snapshot.position,
              snapshot.size,
              scaleFactor,
              workArea,
            )
          : stage === "learning"
            ? learningStagePosition(
                snapshot.position,
                snapshot.size,
                scaleFactor,
                workArea,
              )
            : interactionStagePosition(
                snapshot.position,
                snapshot.size,
                activeTool!.stageWidth,
                petHeight,
                scaleFactor,
                workArea,
              );
      const width =
        stage === "alert"
          ? ALERT_STAGE_WIDTH
          : stage === "learning"
            ? LEARNING_STAGE_WIDTH
            : interactionWindowWidth(activeTool!.stageWidth);
      const height =
        stage === "alert"
          ? ALERT_STAGE_HEIGHT
          : stage === "learning"
            ? LEARNING_STAGE_HEIGHT
            : petHeight + COMPACT_PET_WINDOW_GUTTER;

      await windowApi.setIgnoreCursorEvents(false).catch(() => undefined);
      await windowApi.setSize(new LogicalSize(width, height));
      // Windows can re-anchor a transparent high-DPI window while it grows.
      // Size first so the calculated physical position is the final operation.
      await windowApi.setPosition(new PhysicalPosition(target.x, target.y));
      if (stage === "learning") {
        await windowApi.setFocus().catch(() => undefined);
      }
    },
    [windowApi],
  );

  const endToolInteraction = useCallback(() => {
    const next = transitionToolInteraction(toolInteractionRef.current, {
      type: "end",
    });
    toolInteractionRef.current = next;
    setToolInteraction(next);
  }, []);

  const restoreFunctionalAnimation = useCallback(() => {
    const activity = petActivityRef.current?.activity;
    if (activity === "sleeping") {
      setSleepPresentationActive(true);
      if (!["sleep-enter", "sleeping"].includes(currentAnimation.current)) {
        setAnimation("sleep-enter");
      }
      return;
    }
    setSleepPresentationActive(false);
    const currentIntent = activeIntentRef.current;
    if (activity === "reminding" && currentIntent) {
      setAnimation(
        animationForPetIntent(currentIntent, companionExpressionRef.current),
      );
      return;
    }
    const companion = companionExpressionRef.current;
    if (companion && activity !== "focusing") {
      setAnimation(animationForCompanionExpression(companion));
      return;
    }
    const session = focusStateRef.current.session;
    if (activity === "focusing" && session) {
      setAnimation(session.phase === "focus" ? "focus-calm" : "waiting");
      return;
    }
    setSleepPresentationActive(false);
    setAnimation("idle");
  }, []);

  const applyPetActivitySnapshot = useCallback(
    (snapshot: PetActivitySnapshot) => {
      if (
        petActivityRef.current &&
        snapshot.revision <= petActivityRef.current.revision
      ) {
        return;
      }
      const previous = petActivityRef.current;
      petActivityRef.current = snapshot;
      setPetActivity(snapshot);
      sleepRequested.current =
        snapshot.activity === "sleeping" || snapshot.restoreTarget === "sleeping";

      if (snapshot.activity !== "reminding") {
        const current = activeIntentRef.current;
        if (current && isCoreDirectedOccurrence(current)) {
          queuedAfterWake.current = null;
          deferredIntent.current = null;
          updateActiveIntent(null);
        }
      }
      if (snapshot.activity !== "learning") {
        setDesktopLearningSession(null);
      }
      if (snapshot.activity === "sleeping") {
        endToolInteraction();
        clearBellyHold();
        setLookFrame(null);
        setSleepPresentationActive(true);
        if (!["sleep-enter", "sleeping"].includes(currentAnimation.current)) {
          setAnimation("sleep-enter");
        }
        return;
      }

      setSleepPresentationActive(false);
      if (
        previous?.activity === "sleeping" &&
        ["sleep-enter", "sleeping"].includes(currentAnimation.current)
      ) {
        setAnimation("wake-up");
        return;
      }
      if (snapshot.activity === "reminding" && !activeIntentRef.current) {
        const deferred = deferredIntent.current;
        if (deferred && isCoreDirectedOccurrence(deferred)) {
          deferredIntent.current = null;
          updateActiveIntent(deferred);
          setLookFrame(null);
          setAnimation(
            animationForPetIntent(deferred, companionExpressionRef.current),
          );
          return;
        }
      }
      restoreFunctionalAnimation();
    },
    [
      clearBellyHold,
      endToolInteraction,
      restoreFunctionalAnimation,
      updateActiveIntent,
    ],
  );

  const applyIntent = useCallback(
    (incomingIntent: PetIntent) => {
      if (
        remindersPaused(settingsRef.current) &&
        quietSuppressesIntent(incomingIntent)
      ) {
        return;
      }
      if (
        basicSupportRef.current &&
        basicSupportSuppressesIntent(incomingIntent)
      ) {
        return;
      }
      const intent = withStrongAlertAnimation(incomingIntent);
      const activity = petActivityRef.current?.activity;
      if (isCoreDirectedOccurrence(intent) && activity && activity !== "reminding") {
        deferredIntent.current = intent;
        return;
      }
      if (
        intent.persistent &&
        (intent.kind === "focus" || intent.kind === "break")
      ) {
        if (!activeIntentRef.current) {
          setLookFrame(null);
          setAnimation(intent.animation);
        }
        return;
      }
      if (
        !isCoreDirectedOccurrence(intent) &&
        activity &&
        activity !== "idle"
      ) {
        deferredIntent.current = intent;
        return;
      }
      endToolInteraction();
      clearBellyHold();
      setLookFrame(null);
      updateActiveIntent(intent);
      const directedAnimation = animationForPetIntent(
        intent,
        companionExpressionRef.current,
      );
      setSleepPresentationActive(false);
      setAnimation(directedAnimation);
    },
    [clearBellyHold, endToolInteraction, updateActiveIntent],
  );

  const reconcileReminderState = useCallback(async () => {
    try {
      if (remindersPaused(settingsRef.current)) {
        const current = activeIntentRef.current;
        if (current && quietSuppressesIntent(current)) {
          queuedAfterWake.current = null;
          deferredIntent.current = null;
          updateActiveIntent(null);
          setLookFrame(null);
          restoreFunctionalAnimation();
        }
        return;
      }
      const today = await listToday();
      const current = activeIntentRef.current;
      if (current?.occurrenceId) {
        const stillActive = today.occurrences.some(
          (item) =>
            item.id === current.occurrenceId &&
            ["pending", "overdue", "snoozed"].includes(item.status),
        );
        if (!stillActive) {
          queuedAfterWake.current = null;
          deferredIntent.current = null;
          updateActiveIntent(null);
          setLookFrame(null);
          const next = pendingIntentFromSnapshot(today);
          if (next) applyIntent(next);
          else restoreFunctionalAnimation();
        }
        return;
      }
      if (!current) {
        const next = pendingIntentFromSnapshot(today);
        if (next) applyIntent(next);
      }
    } catch {
      // The scheduler or the next backend event will retry reconciliation.
    }
  }, [applyIntent, restoreFunctionalAnimation, updateActiveIntent]);

  useEffect(() => {
    cursorFollowEnabled.current = settings.cursorFollow;
  }, [settings.cursorFollow]);

  const activateDesktopLearning = useCallback(
    (session: LearningSessionSnapshot) => {
      clearBellyHold();
      endToolInteraction();
      setLearningInvitation(null);
      setDesktopLearningSession(session);
    },
    [clearBellyHold, endToolInteraction],
  );

  useEffect(() => {
    if (!learningBuildEnabled) return;
    const cleanups: Array<() => void> = [];
    void import("../learning/backend").then(
      async ({ getLearningHome, getPendingLearningInvitation }) => {
        const [invitation, home] = await Promise.all([
          getPendingLearningInvitation().catch(() => null),
          getLearningHome().catch(() => null),
        ]);
        setLearningInvitation(invitation);
        if (home?.activeSession?.status === "active") {
          activateDesktopLearning(home.activeSession);
        }
      },
    );
    void Promise.all([
      onBackendEvent<LearningInvitationDto>(
        "learning-invitation-presented",
        setLearningInvitation,
      ),
      onBackendEvent<{ invitationId: string }>(
        "learning-invitation-withdrawn",
        ({ invitationId }) =>
          setLearningInvitation((current) =>
            current?.invitationId === invitationId ? null : current,
          ),
      ),
      onBackendEvent<LearningSessionSnapshot>(
        "learning-session-updated",
        activateDesktopLearning,
      ),
      onBackendEvent("learning-session-interrupted", () => {
        setDesktopLearningSession(null);
      }),
    ]).then((unlisten) => cleanups.push(...unlisten));
    return () => cleanups.forEach((cleanup) => cleanup());
  }, [activateDesktopLearning]);

  const openLearningInvitation = useCallback(async () => {
    if (!learningBuildEnabled || !learningInvitation) return;
    try {
      const { acceptLearningInvitation } = await import("../learning/backend");
      const session = await acceptLearningInvitation(
        learningInvitation.invitationId,
      );
      activateDesktopLearning(session);
    } catch {
      setLearningInvitation(null);
    }
  }, [activateDesktopLearning, learningInvitation]);

  const startDesktopLearning = useCallback(async () => {
    if (
      !learningBuildEnabled ||
      learningStartPending ||
      desktopLearningSession
    ) {
      return;
    }
    setLearningStartPending(true);
    try {
      const { getLearningHome, startManualLearningSession } = await import(
        "../learning/backend"
      );
      const home = await getLearningHome();
      if (home.activeSession?.status === "active") {
        activateDesktopLearning(home.activeSession);
        return;
      }
      if (
        !home.capabilities.contentPackReady ||
        home.dueCount + home.newAvailableCount === 0
      ) {
        await showTaskPanel("learning");
        return;
      }
      const session = await startManualLearningSession(
        home.settings.cardsPerSession,
      );
      activateDesktopLearning(session);
    } catch {
      await showTaskPanel("learning");
    } finally {
      setLearningStartPending(false);
    }
  }, [
    activateDesktopLearning,
    desktopLearningSession,
    learningStartPending,
  ]);

  const dismissLearningInvitation = useCallback(async () => {
    if (!learningBuildEnabled || !learningInvitation) return;
    const invitationId = learningInvitation.invitationId;
    setLearningInvitation(null);
    try {
      const { dismissLearningInvitation: dismiss } = await import(
        "../learning/backend"
      );
      await dismiss(invitationId);
    } catch {
      // The invitation expires quickly and the backend remains authoritative.
    }
  }, [learningInvitation]);

  const pauseLearningInvitesToday = useCallback(async () => {
    if (!learningBuildEnabled || !learningInvitation) return;
    setLearningInvitation(null);
    try {
      const { pauseLearningInvitesToday: pauseToday } = await import(
        "../learning/backend"
      );
      await pauseToday();
    } catch {
      // A later backend snapshot restores the true invitation state if needed.
    }
  }, [learningInvitation]);

  useEffect(() => {
    void Promise.all([
      getSettings(),
      getFocusState(),
      listToday(),
      getCompanionExpressionSnapshot(),
      getPetActivitySnapshot(),
      getBasicSupportState(),
    ]).then(
      ([
        nextSettings,
        nextFocus,
        today,
        nextExpression,
        nextPetActivity,
        nextBasicSupport,
      ]) => {
        settingsRef.current = nextSettings;
        setSettings(nextSettings);
        focusStateRef.current = nextFocus;
        setFocusState(nextFocus);
        applyPetActivitySnapshot(nextPetActivity);
        applyCompanionExpression(nextExpression);
        basicSupportRef.current = nextBasicSupport;
        const pending = pendingIntentFromSnapshot(today);
        if (pending && !remindersPaused(nextSettings)) applyIntent(pending);
      },
    );
    const cleanups: Array<() => void> = [];
    void Promise.all([
      onBackendEvent<AppSettings>("settings-updated", (nextSettings) => {
        settingsRef.current = nextSettings;
        setSettings(nextSettings);
        if (remindersPaused(nextSettings)) {
          const current = activeIntentRef.current;
          if (current && quietSuppressesIntent(current)) {
            queuedAfterWake.current = null;
            deferredIntent.current = null;
            updateActiveIntent(null);
            setLookFrame(null);
            restoreFunctionalAnimation();
          }
          return;
        }
        void reconcileReminderState();
      }),
      onBackendEvent<void>("occurrence-updated", reconcileReminderState),
      onBackendEvent<void>("reminders-updated", reconcileReminderState),
      onBackendEvent<PetIntent>("pet-intent", applyIntent),
      onBackendEvent<CompanionExpressionSnapshot>(
        "companion-expression",
        applyCompanionExpression,
      ),
      onBackendEvent<PetActivitySnapshot>(
        "pet-activity-snapshot-updated",
        applyPetActivitySnapshot,
      ),
      onBackendEvent<BasicSupportSession | null>(
        "basic-support-updated",
        (nextBasicSupport) => {
          basicSupportRef.current = nextBasicSupport;
          if (nextBasicSupport) {
            endToolInteraction();
            const current = activeIntentRef.current;
            if (current && basicSupportSuppressesIntent(current)) {
              queuedAfterWake.current = null;
              deferredIntent.current = null;
              updateActiveIntent(null);
              setLookFrame(null);
              restoreFunctionalAnimation();
            }
            return;
          }
          void reconcileReminderState();
        },
      ),
      onBackendEvent<{ occurrenceId: string }>(
        "pet-intent-resolved",
        ({ occurrenceId }) => {
          if (activeIntentRef.current?.occurrenceId !== occurrenceId) return;
          queuedAfterWake.current = null;
          const deferred = deferredIntent.current;
          deferredIntent.current = null;
          updateActiveIntent(null);
          setLookFrame(null);
          restoreFunctionalAnimation();
          void listToday().then((today) => {
            if (activeIntentRef.current) return;
            const pending = pendingIntentFromSnapshot(today);
            if (pending) applyIntent(pending);
            else if (deferred) applyIntent(deferred);
          });
        },
      ),
      onBackendEvent<FocusState>("focus-updated", (nextFocus) => {
        focusStateRef.current = nextFocus;
        setFocusState(nextFocus);
        if (petActivityRef.current?.activity === "focusing") {
          restoreFunctionalAnimation();
        }
      }),
      onBackendEvent<{ frame: number | null }>(
        "cursor-direction-changed",
        ({ frame }) => {
          if (
            cursorFollowEnabled.current &&
            currentAnimation.current === "idle"
          ) {
            setLookFrame(frame);
          }
        },
      ),
      onBackendEvent<PetSleepRequest>("pet-request-sleep", (request) => {
        // Compatibility fallback for older emitters. Current builds publish the
        // authoritative activity snapshot before this animation hint.
        if (!tauriAvailable() || !petActivityRef.current) {
          const manual = isManualSleepRequest(request);
          sleepRequested.current = true;
          if (manual) {
            queuedAfterWake.current = null;
            deferredIntent.current = null;
            updateActiveIntent(null);
            setDesktopLearningSession(null);
            setSleepPresentationActive(true);
            setAnimation("sleep-enter");
          } else if (!activeIntentRef.current && !focusStateRef.current.session) {
            setSleepPresentationActive(true);
            setAnimation("sleep-enter");
          }
        }
      }),
      onBackendEvent<void>("pet-request-wake", () => {
        if (!tauriAvailable() || !petActivityRef.current) {
          sleepRequested.current = false;
          setSleepPresentationActive(false);
          setAnimation("wake-up");
        }
        void reconcileReminderState();
      }),
      onBackendEvent<PetInteractionStarted>(
        "pet-interaction-started",
        ({ id, kind }) => {
          if (
            petActivityRef.current?.activity !== "idle" ||
            !["treat", "wand", "pet", "ball"].includes(kind)
          ) {
            return;
          }
          clearBellyHold();
          setLookFrame(null);
          const nextStageWidth =
            kind === "ball"
              ? ballStageWidth(settings.petWidth)
              : settings.petWidth;
          const next: ActiveToolInteraction = {
            id,
            kind: kind as ActiveToolInteraction["kind"],
            x:
              kind === "ball"
                ? ballHomeX(settings.petWidth)
                : settings.petWidth * 0.72,
            y:
              kind === "ball"
                ? Math.round((settings.petWidth * 208) / 192) - 25
                : kind === "treat"
                  ? 30
                  : 48,
            frame: kind === "treat" ? 6 : kind === "wand" ? 1 : 0,
            mirrored: false,
            offsetX: kind === "pet" || kind === "ball" ? 0 : 8,
            engaged: kind !== "pet" && kind !== "wand" && kind !== "ball",
            frameX: settings.petWidth * 0.72,
            frameY:
              kind === "ball"
                ? Math.round((settings.petWidth * 208) / 192) - 25
                : kind === "treat"
                  ? 30
                  : 48,
            lastFrameAt: 0,
            phase: 0,
            ballPhase: kind === "ball" ? "ready" : null,
            charge: 0.12,
            chargeStartedAt: null,
            stageWidth: nextStageWidth,
            targetX: ballHomeX(settings.petWidth),
            flightDuration: ballFlightDuration(0.12),
            ballVisible: kind === "ball",
          };
          const replacement = transitionToolInteraction(
            toolInteractionRef.current,
            { type: "start", interaction: next },
          );
          toolInteractionRef.current = replacement;
          setToolInteraction(replacement);
          setAnimation(
            kind === "treat"
              ? "treat-follow"
              : kind === "wand"
                ? "idle"
                : kind === "pet"
                  ? "idle"
                  : "idle",
          );
        },
      ),
    ]).then((unlisten) => cleanups.push(...unlisten));
    return () => cleanups.forEach((cleanup) => cleanup());
  }, [
    applyCompanionExpression,
    applyIntent,
    applyPetActivitySnapshot,
    clearBellyHold,
    endToolInteraction,
    restoreFunctionalAnimation,
    reconcileReminderState,
    settings.petWidth,
  ]);

  useEffect(() => {
    const stage: ExpandedWindowStage | null =
      petActivity?.activity === "reminding" && isStrongAlertIntent(activeIntent)
      ? "alert"
      : petActivity?.activity === "learning" && desktopLearningSession
        ? "learning"
        : toolInteraction?.id
          ? "tool"
          : null;
    void applyExpandedWindowStage(stage);
  }, [
    activeIntent,
    applyExpandedWindowStage,
    desktopLearningSession,
    petActivity?.activity,
    toolInteraction?.id,
    toolInteraction?.stageWidth,
  ]);

  useEffect(() => {
    if (!toolInteraction?.id) return;
    const interactionId = toolInteraction.id;
    const timer = window.setTimeout(() => {
      const current = toolInteractionRef.current;
      if (current?.id !== interactionId) return;
      endToolInteraction();
      restoreFunctionalAnimation();
    }, 30_000);
    return () => window.clearTimeout(timer);
  }, [
    endToolInteraction,
    restoreFunctionalAnimation,
    toolInteraction?.id,
  ]);

  useEffect(() => {
    if (toolInteraction?.kind !== "wand" || !toolInteraction.engaged) return;
    const timer = window.setInterval(() => {
      const current = toolInteractionRef.current;
      if (!current || current.kind !== "wand" || !current.engaged) return;
      const phase = (current.phase + 1) % wandPhaseAnimations.length;
      const next: ActiveToolInteraction = { ...current, phase };
      toolInteractionRef.current = next;
      setToolInteraction(next);
      setAnimation(wandPhaseAnimations[phase]);
    }, 130);
    return () => window.clearInterval(timer);
  }, [toolInteraction?.engaged, toolInteraction?.id, toolInteraction?.kind]);

  useEffect(() => {
    if (
      toolInteraction?.kind !== "ball" ||
      toolInteraction.ballPhase !== "charging" ||
      toolInteraction.chargeStartedAt === null
    ) {
      return;
    }
    const timer = window.setInterval(() => {
      const current = toolInteractionRef.current;
      if (
        !current ||
        current.kind !== "ball" ||
        current.ballPhase !== "charging" ||
        current.chargeStartedAt === null
      ) {
        return;
      }
      const charge = ballChargeFromElapsed(
        performance.now() - current.chargeStartedAt,
      );
      if (Math.abs(charge - current.charge) < 0.01) return;
      const next = { ...current, charge };
      toolInteractionRef.current = next;
      setToolInteraction(next);
    }, 40);
    return () => window.clearInterval(timer);
  }, [
    toolInteraction?.ballPhase,
    toolInteraction?.chargeStartedAt,
    toolInteraction?.id,
    toolInteraction?.kind,
  ]);

  useEffect(() => {
    if (
      toolInteraction?.kind !== "ball" ||
      !toolInteraction.ballPhase ||
      ["ready", "charging"].includes(toolInteraction.ballPhase)
    ) {
      return;
    }
    const currentPhase = toolInteraction.ballPhase;
    const delay =
      currentPhase === "flying"
        ? toolInteraction.flightDuration
        : BALL_GAME_PHASE_MS[currentPhase];
    if (!delay) return;

    const timer = window.setTimeout(() => {
      const current = toolInteractionRef.current;
      if (
        !current ||
        current.kind !== "ball" ||
        current.id !== toolInteraction.id ||
        current.ballPhase !== currentPhase
      ) {
        return;
      }

      const nextPhase = nextBallGamePhase(currentPhase);
      if (nextPhase === null) {
        endToolInteraction();
        restoreFunctionalAnimation();
        return;
      }
      const next: ActiveToolInteraction = {
        ...current,
        ballPhase: nextPhase,
        offsetX:
          nextPhase === "chasing"
            ? ballChaseOffset(
                current.targetX,
                current.stageWidth,
                settingsRef.current.petWidth,
              )
            : nextPhase === "returning"
              ? 0
              : current.offsetX,
        ballVisible: !["batting", "pickup", "returning", "dropping"].includes(
          nextPhase,
        ),
      };
      toolInteractionRef.current = next;
      setToolInteraction(next);
      setLookFrame(null);
      setAnimation(
        nextPhase === "chasing"
          ? "running-right"
          : nextPhase === "batting"
            ? "ball-bat"
            : nextPhase === "pickup"
              ? "ball-pickup"
              : nextPhase === "returning"
                ? "ball-carry"
                : "ball-drop",
      );
    }, delay);
    return () => window.clearTimeout(timer);
  }, [
    endToolInteraction,
    restoreFunctionalAnimation,
    toolInteraction?.ballPhase,
    toolInteraction?.flightDuration,
    toolInteraction?.id,
    toolInteraction?.kind,
  ]);

  useEffect(() => {
    if (!activeIntent?.expiresAt) return;
    const delay = Math.max(
      0,
      new Date(activeIntent.expiresAt).getTime() - Date.now(),
    );
    const timer = window.setTimeout(() => {
      if (activeIntentRef.current?.id !== activeIntent.id) return;
      updateActiveIntent(null);
      void listToday()
        .then((today) => {
          const pending = pendingIntentFromSnapshot(today);
          if (pending) applyIntent(pending);
          else if (deferredIntent.current) {
            const deferred = deferredIntent.current;
            deferredIntent.current = null;
            applyIntent(deferred);
          } else restoreFunctionalAnimation();
        })
        .catch(restoreFunctionalAnimation);
    }, delay);
    return () => window.clearTimeout(timer);
  }, [
    activeIntent,
    applyIntent,
    restoreFunctionalAnimation,
    updateActiveIntent,
  ]);

  useEffect(() => {
    if (!focusState.session) return;
    const timer = window.setInterval(() => setClock(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [focusState.session]);

  useEffect(() => {
    if (
      companionExpression?.pose !== "give_space" ||
      animation !== "running-right" ||
      activeIntent !== null ||
      toolInteraction !== null
    ) {
      return;
    }
    const timer = window.setTimeout(() => {
      if (
        companionExpressionRef.current?.pose === "give_space" &&
        !activeIntentRef.current &&
        !toolInteractionRef.current
      ) {
        setAnimation("waiting");
      }
    }, 980);
    return () => window.clearTimeout(timer);
  }, [activeIntent, animation, companionExpression?.pose, toolInteraction]);

  useEffect(() => {
    const systemAllowsMotion =
      settings.animationMode !== "system" ||
      !window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    if (
      animation !== "idle" ||
      activeIntent !== null ||
      petActivity?.activity !== "idle" ||
      settings.animationMode === "off" ||
      !systemAllowsMotion
    ) {
      return;
    }

    const delay = 12_000 + Math.round(Math.random() * 12_000);
    const timer = window.setTimeout(() => {
      stateBeforeTransient.current = "idle";
      setLookFrame(null);
      setAnimation(chooseLifeAnimation(Math.random()));
    }, delay);
    return () => window.clearTimeout(timer);
  }, [activeIntent, animation, petActivity?.activity, settings.animationMode]);

  const finishAnimation = useCallback(
    (finished: AnimationName) => {
      if (
        toolInteractionRef.current?.kind === "ball" &&
        ["ball-bat", "ball-pickup", "ball-carry", "ball-drop"].includes(
          finished,
        )
      ) {
        return;
      }
      const settledCompanionAnimation = settledAnimationAfterCompanionCue(
        finished,
        companionExpressionRef.current,
      );
      if (finished === "sleep-enter") {
        setAnimation("sleeping");
      } else if (finished === "wake-up") {
        const queued = queuedAfterWake.current;
        queuedAfterWake.current = null;
        if (queued) {
          setAnimation(
            animationForPetIntent(queued, companionExpressionRef.current),
          );
        } else restoreFunctionalAnimation();
      } else if (finished === "grooming") {
        setAnimation("grooming-chest");
      } else if (finished === "grooming-chest") {
        setAnimation("grooming-flank");
      } else if (finished === "grooming-flank") {
        setAnimation("idle");
      } else if (finished === "belly-up") {
        clearBellyHold();
        bellyHoldTimer.current = window.setTimeout(() => {
          bellyHoldTimer.current = null;
          setAnimation("belly-down");
        }, 2800);
      } else if (settledCompanionAnimation) {
        setAnimation(settledCompanionAnimation);
      } else if (
        activeIntentRef.current &&
        animationForPetIntent(
          activeIntentRef.current,
          companionExpressionRef.current,
        ) === finished
      ) {
        if (
          activeIntentRef.current.persistent &&
          isCoreDirectedOccurrence(activeIntentRef.current)
        ) {
          setAnimation("waiting");
        } else {
          setAnimation("idle");
        }
      } else if (
        finished === "jumping" ||
        finished === "belly-down" ||
        isLifeAnimation(finished)
      ) {
        setAnimation("idle");
      } else {
        setAnimation(stateBeforeTransient.current);
      }
    },
    [clearBellyHold, restoreFunctionalAnimation],
  );

  const onPointerDown = async (event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    if (isStrongAlertIntent(activeIntentRef.current)) {
      await showTaskPanel(activeIntentRef.current?.route ?? "today");
      return;
    }
    if (focusStateRef.current.session?.phase === "focus") {
      await showTaskPanel("focus");
      return;
    }
    if (toolInteractionRef.current) {
      return;
    }
    if (!windowApi) {
      await showTaskPanel("today");
      return;
    }
    clearBellyHold();
    if (isLifeAnimation(currentAnimation.current)) {
      setAnimation("idle");
    }
    event.currentTarget.setPointerCapture(event.pointerId);
    const [position, scaleFactor] = await Promise.all([
      windowApi.outerPosition(),
      windowApi.scaleFactor(),
    ]);
    drag.current = {
      pointerId: event.pointerId,
      startScreenX: event.screenX,
      startScreenY: event.screenY,
      windowX: position.x,
      windowY: position.y,
      scaleFactor,
      moved: false,
    };
  };

  const onPointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    const active = drag.current;
    if (!windowApi || !active || active.pointerId !== event.pointerId) {
      return;
    }
    const dx = event.screenX - active.startScreenX;
    const dy = event.screenY - active.startScreenY;
    if (!active.moved && Math.hypot(dx, dy) < 4) return;
    active.moved = true;
    setLookFrame(null);
    if (dx >= 4) setAnimation("running-right");
    else if (dx <= -4) setAnimation("running-left");
    void windowApi.setPosition(
      new PhysicalPosition(
        Math.round(active.windowX + dx * active.scaleFactor),
        Math.round(active.windowY + dy * active.scaleFactor),
      ),
    );
  };

  const finishPointer = async (event: ReactPointerEvent<HTMLDivElement>) => {
    const active = drag.current;
    if (!active || active.pointerId !== event.pointerId) return;
    drag.current = null;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    if (active.moved) {
      restoreFunctionalAnimation();
      if (windowApi) {
        const position = await windowApi.outerPosition();
        await invoke("save_pet_position", { x: position.x, y: position.y });
      }
    } else {
      await showTaskPanel(
        activeIntentRef.current?.route ??
          (focusStateRef.current.session ? "focus" : "today"),
      );
    }
  };

  const onResizePointerDown = async (event: ReactPointerEvent<HTMLButtonElement>) => {
    event.preventDefault();
    event.stopPropagation();
    const startX = event.screenX;
    const startWidth = settings.petWidth;
    let latestWidth = startWidth;
    event.currentTarget.setPointerCapture(event.pointerId);

    const move = (moveEvent: PointerEvent) => {
      const width = Math.round(
        Math.max(120, Math.min(320, startWidth + moveEvent.screenX - startX)),
      );
      latestWidth = width;
      setSettings((current) => ({ ...current, petWidth: width }));
      void windowApi?.setSize(
        new LogicalSize(width + 28, Math.round((width * 208) / 192) + 28),
      );
    };
    const up = async () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      await setPetSize(latestWidth);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up, { once: true });
  };

  const onContextMenu = (event: ReactMouseEvent<HTMLDivElement>) => {
    event.preventDefault();
    if (tauriAvailable()) void invoke("show_pet_context_menu");
  };

  const updateInteractionPosition = useCallback(
    (
      clientX: number,
      clientY: number,
      bounds: DOMRect,
      eventTime = performance.now(),
    ) => {
      const current = toolInteractionRef.current;
      if (!current) return;
      const x = Math.max(12, Math.min(bounds.width - 12, clientX - bounds.left));
      const y = Math.max(12, Math.min(bounds.height - 12, clientY - bounds.top));
      const distance = Math.hypot(x - current.frameX, y - current.frameY);
      if (distance < 2 && current.kind !== "treat") return;
      const advancePetting =
        current.kind !== "pet" ||
        shouldAdvancePettingFrame(
          distance,
          Math.max(0, eventTime - current.lastFrameAt),
        );
      const mirrored =
        current.kind === "wand"
          ? false
          : current.kind === "pet" || current.kind === "treat"
          ? shouldMirrorTowardPointerWithHysteresis(
              x,
              bounds.width,
              current.mirrored,
            )
          : shouldMirrorTowardPointer(x, bounds.width);
      const offsetX =
        current.kind === "wand"
          ? 0
          : current.kind === "pet"
          ? gentleHeadOffsetTowardPointer(x, bounds.width)
          : followOffsetTowardPointer(x, bounds.width);
      const next: ActiveToolInteraction = {
        ...current,
        x,
        y,
        frame:
          current.kind === "treat"
            ? treatFrameFromPointerHeight(y, bounds.height)
            : current.kind === "wand"
              ? wandDirectionFrame(
                  x,
                  y,
                  bounds.width,
                  bounds.height,
                  current.frame,
                )
            : advancePetting
              ? advanceInteractionFrame(current.frame, distance)
              : current.frame,
        mirrored,
        offsetX,
        frameX: advancePetting ? x : current.frameX,
        frameY: advancePetting ? y : current.frameY,
        lastFrameAt:
          current.kind === "pet" && advancePetting
            ? eventTime
            : current.lastFrameAt,
      };
      toolInteractionRef.current = next;
      setToolInteraction(next);
    },
    [],
  );

  const setPettingEngaged = useCallback((engaged: boolean) => {
    const current = toolInteractionRef.current;
    if (!current || current.kind !== "pet" || current.engaged === engaged) return;
    const next: ActiveToolInteraction = {
      ...current,
      engaged,
      offsetX: engaged ? current.offsetX : 0,
    };
    toolInteractionRef.current = next;
    setToolInteraction(next);
    setLookFrame(null);
    setAnimation(engaged ? "pet-nuzzle" : "idle");
  }, []);

  const updatePettingFromPointer = (
    event: ReactPointerEvent<HTMLButtonElement>,
  ) => {
    event.preventDefault();
    event.stopPropagation();
    setPettingEngaged(true);
    const region = event.currentTarget.parentElement;
    if (region) {
      updateInteractionPosition(
        event.clientX,
        event.clientY,
        region.getBoundingClientRect(),
        event.timeStamp,
      );
    }
  };

  const setWandEngaged = useCallback((engaged: boolean) => {
    const current = toolInteractionRef.current;
    if (!current || current.kind !== "wand" || current.engaged === engaged) {
      return;
    }
    const next: ActiveToolInteraction = {
      ...current,
      engaged,
      phase: 0,
      offsetX: 0,
      mirrored: false,
    };
    toolInteractionRef.current = next;
    setToolInteraction(next);
    setLookFrame(null);
    setAnimation(engaged ? "wand-reach" : "idle");
  }, []);

  const startBallCharge = useCallback(() => {
    const current = toolInteractionRef.current;
    if (
      !current ||
      current.kind !== "ball" ||
      current.ballPhase !== "ready"
    ) {
      return;
    }
    const next: ActiveToolInteraction = {
      ...current,
      ballPhase: "charging",
      engaged: true,
      charge: 0.12,
      chargeStartedAt: performance.now(),
    };
    toolInteractionRef.current = next;
    setToolInteraction(next);
    setLookFrame(null);
    setAnimation("idle");
  }, []);

  const throwBall = useCallback(() => {
    const current = toolInteractionRef.current;
    if (
      !current ||
      current.kind !== "ball" ||
      current.ballPhase !== "charging"
    ) {
      return;
    }
    const charge = ballChargeFromElapsed(
      performance.now() - (current.chargeStartedAt ?? performance.now()),
    );
    const targetX = ballTargetX(
      current.stageWidth,
      settingsRef.current.petWidth,
      charge,
    );
    const next: ActiveToolInteraction = {
      ...current,
      ballPhase: "flying",
      engaged: false,
      charge,
      chargeStartedAt: null,
      x: targetX,
      targetX,
      flightDuration: ballFlightDuration(charge),
      ballVisible: true,
    };
    toolInteractionRef.current = next;
    setToolInteraction(next);
    setLookFrame(null);
    setAnimation("idle");
  }, []);

  const onToolPointerDown = (event: ReactPointerEvent<HTMLButtonElement>) => {
    if (event.button !== 0) return;
    event.preventDefault();
    event.stopPropagation();
    if (toolInteractionRef.current?.kind === "ball") {
      startBallCharge();
      event.currentTarget.setPointerCapture(event.pointerId);
      return;
    }
    setWandEngaged(true);
    event.currentTarget.setPointerCapture(event.pointerId);
    const region = event.currentTarget.parentElement;
    if (region) {
      updateInteractionPosition(
        event.clientX,
        event.clientY,
        region.getBoundingClientRect(),
        event.timeStamp,
      );
    }
  };

  const onToolPointerMove = (event: ReactPointerEvent<HTMLButtonElement>) => {
    if (!event.currentTarget.hasPointerCapture(event.pointerId)) return;
    event.preventDefault();
    event.stopPropagation();
    if (toolInteractionRef.current?.kind === "ball") return;
    const region = event.currentTarget.parentElement;
    if (region) {
      updateInteractionPosition(
        event.clientX,
        event.clientY,
        region.getBoundingClientRect(),
        event.timeStamp,
      );
    }
  };

  const releaseToolPointer = (event: ReactPointerEvent<HTMLButtonElement>) => {
    event.preventDefault();
    event.stopPropagation();
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    if (toolInteractionRef.current?.kind === "ball") {
      throwBall();
      return;
    }
    setWandEngaged(false);
  };

  const openInformationRoute = (route: PetIntent["route"]) => {
    if (toolInteractionRef.current) {
      endToolInteraction();
      restoreFunctionalAnimation();
    }
    void showTaskPanel(route);
  };

  const handleAlertAction = async (
    action: "complete" | "snooze" | "skip",
  ) => {
    const intent = activeIntentRef.current;
    if (!intent?.occurrenceId || alertActionPending) return;
    setAlertActionPending(true);
    try {
      if (action === "complete") {
        await completeOccurrence(intent.occurrenceId);
      } else if (action === "snooze") {
        await snoozeOccurrence(intent.occurrenceId, alertSnoozeMinutes);
      } else {
        await skipOccurrence(intent.occurrenceId);
      }
      if (!tauriAvailable()) {
        updateActiveIntent(null);
        const today = await listToday();
        const pending = pendingIntentFromSnapshot(today);
        if (pending) applyIntent(pending);
        else restoreFunctionalAnimation();
      }
    } catch {
      await showTaskPanel(intent.route);
    } finally {
      setAlertActionPending(false);
    }
  };

  const focusSession = focusState.session;
  const strongAlertActive =
    petActivity?.activity === "reminding" && isStrongAlertIntent(activeIntent);
  const desktopLearningActive =
    petActivity?.activity === "learning" &&
    Boolean(desktopLearningSession) &&
    !strongAlertActive;
  const activeIntentSurface = activeIntent
    ? intentTextSurface(activeIntent)
    : "none";
  const motionAccessibleLabel =
    petActivity?.activity === "reminding" && activeIntent
    ? motionOnlyAccessibleLabel(activeIntent)
    : null;
  const informationCard = sleepPresentationActive
    ? null
    : activeIntent && activeIntentSurface === "system_card"
    ? {
        surface: "system" as const,
        label:
          activeIntent.kind === "activity"
            ? "活动"
            : activeIntent.kind === "reminder" || activeIntent.kind === "overdue"
            ? "提醒"
            : "状态",
        title: activeIntent.title,
        message: activeIntent.message,
        route: activeIntent.route,
      }
      : focusSession && petActivity?.activity === "focusing"
      ? {
          surface: "timer" as const,
          label: focusSession.phase === "focus" ? "专注" : "休息",
          title: focusSession.phase === "focus" ? "专注中" : "休息中",
          message: `${formatRemaining(focusSession.endsAt, clock)} · 点击查看`,
          route: "focus" as const,
        }
      : toolInteraction
        ? {
            surface: "tool" as const,
            label:
              toolInteraction.kind === "treat"
                ? "猫条"
                : toolInteraction.kind === "wand"
                  ? "玩耍"
                  : toolInteraction.kind === "pet"
                    ? "摸摸"
                    : "取球",
            title:
              toolInteraction.kind === "treat"
                ? "猫条时间"
                : toolInteraction.kind === "wand"
                  ? "逗圆圆玩"
                  : toolInteraction.kind === "pet"
                    ? "摸摸圆圆"
                    : "扔球游戏",
            message:
              toolInteraction.kind === "treat"
                ? "按住猫条向任意方向移动"
                : toolInteraction.kind === "wand"
                  ? "按住逗猫棒移动"
                  : toolInteraction.kind === "pet"
                    ? "把鼠标放在圆圆头上轻轻移动"
                    : ballPhaseMessage(toolInteraction.ballPhase),
            route: "care" as const,
          }
        : null;
  const ballGameActive = toolInteraction?.kind === "ball";
  const petHeight = Math.round((settings.petWidth * 208) / 192);
  const strongAlertPetWidth = alertPetWidth(settings.petWidth);
  const strongAlertPetHeight = alertPetHeight(settings.petWidth);
  const activeStageWidth = strongAlertActive || desktopLearningActive
    ? strongAlertActive
      ? ALERT_STAGE_WIDTH
      : LEARNING_STAGE_WIDTH
    : toolInteraction
      ? interactionStageWidth(toolInteraction.stageWidth)
      : settings.petWidth;
  const hitRegionStyle = {
    width: activeStageWidth,
    height: strongAlertActive || desktopLearningActive
      ? strongAlertActive
        ? ALERT_STAGE_HEIGHT
        : LEARNING_STAGE_HEIGHT
      : toolInteraction
        ? petHeight
        : undefined,
    "--pet-width": `${settings.petWidth}px`,
    "--pet-height": `${petHeight}px`,
    "--tool-card-lane-width": `${TOOL_CARD_LANE_WIDTH}px`,
    "--interaction-playfield-width": `${toolInteraction?.stageWidth ?? settings.petWidth}px`,
    "--alert-pet-width": `${strongAlertPetWidth}px`,
    "--alert-pet-height": `${strongAlertPetHeight}px`,
    "--ball-charge": toolInteraction?.charge ?? 0.12,
    "--ball-charge-angle": `${Math.round(
      (toolInteraction?.charge ?? 0.12) * 300,
    )}deg`,
    "--ball-charge-x": 1 + (toolInteraction?.charge ?? 0.12) * 0.1,
    "--ball-charge-y": 1 - (toolInteraction?.charge ?? 0.12) * 0.16,
    "--ball-flight-duration": `${toolInteraction?.flightDuration ?? 620}ms`,
    "--ball-arc-height": `-${Math.round(
      34 + (toolInteraction?.charge ?? 0.12) * 52,
    )}px`,
  } as CSSProperties;
  const petMotionReduced =
    settings.animationMode === "off" ||
    (settings.animationMode === "system" &&
      typeof window.matchMedia === "function" &&
      window.matchMedia("(prefers-reduced-motion: reduce)").matches);

  return (
    <main className="pet-window" aria-label="圆圆桌面宠物">
      <div
        className={`pet-hit-region ${
          toolInteraction?.kind === "pet" ? "petting-active" : ""
        } ${toolInteraction ? "tool-interaction-stage" : ""} ${
          ballGameActive ? `ball-game-active ball-${toolInteraction.ballPhase}` : ""
        } ${
          strongAlertActive ? "alert-stage" : ""
         } ${desktopLearningActive ? "learning-stage" : ""
        } ${activeIntent?.kind === "activity" ? "activity-alert" : ""} ${
          petMotionReduced ? "pet-motion-reduced" : ""
        }`}
        data-companion-tier={companionExpression?.tier ?? "n0"}
        data-interaction-layout={toolInteraction ? "separate-lane" : undefined}
        style={hitRegionStyle}
        onContextMenu={onContextMenu}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={finishPointer}
        onPointerCancel={finishPointer}
      >
        {desktopLearningActive &&
          desktopLearningSession &&
          LazyLearningDesktopStage && (
            <Suspense
              fallback={
                <div
                  className="desktop-learning-stage-loading"
                  role="status"
                  onPointerDown={(event) => event.stopPropagation()}
                >
                  圆圆正在拉出小黑板…
                </div>
              }
            >
              <LazyLearningDesktopStage
                session={desktopLearningSession}
                settings={settings}
                onSessionChange={setDesktopLearningSession}
                onClose={() => setDesktopLearningSession(null)}
              />
            </Suspense>
          )}
        {!desktopLearningActive && informationCard && strongAlertActive ? (
          <div
            className={`pet-system-card alert-banner ${
              activeIntent?.kind === "activity" ? "activity-banner" : ""
            } ${activeIntent?.occurrenceId ? "has-actions" : ""}`}
            data-information-surface="system"
            onPointerDown={(event) => event.stopPropagation()}
            onPointerMove={(event) => event.stopPropagation()}
            onPointerUp={(event) => event.stopPropagation()}
            onPointerCancel={(event) => event.stopPropagation()}
          >
            <button
              className="pet-alert-copy"
              type="button"
              aria-label={`${informationCard.title}：${informationCard.message}，打开今日任务`}
              onClick={(event) => {
                event.stopPropagation();
                openInformationRoute(informationCard.route);
              }}
            >
              <small>{informationCard.label}</small>
              <span className="pet-card-detail">
                <strong>{informationCard.title}</strong>
                <span>{informationCard.message}</span>
              </span>
            </button>
            {activeIntent?.occurrenceId && (
              <div className="pet-alert-actions" aria-label="处理提醒">
                <button
                  className="primary"
                  type="button"
                  disabled={alertActionPending}
                  onClick={() => void handleAlertAction("complete")}
                >
                  {activeIntent.kind === "activity" ? "活动完成" : "完成"}
                </button>
                <label className="pet-alert-snooze">
                  <span className="sr-only">稍后提醒时长</span>
                  <select
                    value={alertSnoozeMinutes}
                    disabled={alertActionPending}
                    onChange={(event) => setAlertSnoozeMinutes(Number(event.target.value))}
                  >
                    {[5, 10, 30, 60].map((minutes) => (
                      <option key={minutes} value={minutes}>{minutes} 分钟</option>
                    ))}
                  </select>
                  <button
                    type="button"
                    disabled={alertActionPending}
                    onClick={() => void handleAlertAction("snooze")}
                  >
                    稍后
                  </button>
                </label>
                <button
                  type="button"
                  disabled={alertActionPending}
                  onClick={() => void handleAlertAction("skip")}
                >
                  跳过
                </button>
              </div>
            )}
          </div>
        ) : !desktopLearningActive && informationCard ? (
          <button
            className={`pet-system-card ${
              informationCard.surface === "tool" ? "tool-card" : ""
            } ${
              toolInteraction
                ? `${toolInteraction.kind === "ball" ? "ball-card " : ""}card-left`
                : "card-right"
            }`}
            data-information-surface={informationCard.surface}
            type="button"
            aria-label={`${informationCard.title}：${informationCard.message}`}
            onPointerDown={(event) => event.stopPropagation()}
            onPointerMove={(event) => event.stopPropagation()}
            onPointerUp={(event) => event.stopPropagation()}
            onPointerCancel={(event) => event.stopPropagation()}
            onClick={(event) => {
              event.stopPropagation();
              openInformationRoute(informationCard.route);
            }}
          >
            <small>{informationCard.label}</small>
            <span className="pet-card-detail">
              <strong>{informationCard.title}</strong>
              <span>{informationCard.message}</span>
            </span>
          </button>
        ) : null}
        {motionAccessibleLabel && (
          <span className="sr-only" role="status" aria-live="polite">
            {motionAccessibleLabel}
          </span>
        )}
        {petSleepAccessibleStatus(petActivity) && (
          <span className="sr-only" role="status" aria-live="polite">
            {petSleepAccessibleStatus(petActivity)}
          </span>
        )}
        {!desktopLearningActive &&
          !sleepPresentationActive &&
          !informationCard &&
          !activeIntent &&
          !focusSession &&
          !toolInteraction &&
          companionExpression && (
          <CompanionPropStage
            key={companionExpression.revision}
            snapshot={companionExpression}
            labelMode={settings.companionLabelMode}
            onOpenTaskWatch={() => void showTaskPanel("taskwatch")}
            onOpenLearning={
              learningInvitation
                ? () => void openLearningInvitation()
                : undefined
            }
            onDismissLearning={
              learningInvitation
                ? () => void dismissLearningInvitation()
                : undefined
            }
            onPauseLearningToday={
              learningInvitation
                ? () => void pauseLearningInvitesToday()
                : undefined
            }
          />
          )}
        <div className="pet-animation-stage" data-animation-stage="true">
          {!desktopLearningActive && (
            <SpriteAnimator
              animation={animation}
              lookFrame={lookFrame}
              frameOverride={
                toolInteraction?.kind === "ball"
                  ? null
                  : (toolInteraction?.kind === "pet" ||
                        toolInteraction?.kind === "wand") &&
                      !toolInteraction.engaged
                    ? null
                    : toolInteraction?.frame ?? null
              }
              mirrored={
                (toolInteraction?.kind === "pet" ||
                  toolInteraction?.kind === "wand") &&
                !toolInteraction.engaged
                  ? false
                  : toolInteraction?.mirrored ?? false
              }
              offsetX={
                (toolInteraction?.kind === "pet" ||
                  toolInteraction?.kind === "wand") &&
                !toolInteraction.engaged
                  ? 0
                  : toolInteraction?.offsetX ??
                    (companionExpression?.pose === "give_space"
                      ? Math.round(settings.petWidth * 0.14)
                      : 0)
              }
              settings={settings}
              onComplete={finishAnimation}
            />
          )}
          {!desktopLearningActive && toolInteraction?.kind === "pet" && (
            <button
              key={toolInteraction.id}
              className={`pet-head-zone ${
                toolInteraction.engaged ? "is-engaged" : ""
              }`}
              type="button"
              aria-label="轻轻摸摸圆圆的头"
              onPointerEnter={updatePettingFromPointer}
              onPointerMove={updatePettingFromPointer}
              onPointerDown={updatePettingFromPointer}
              onPointerLeave={(event) => {
                event.stopPropagation();
                setPettingEngaged(false);
              }}
            />
          )}
          {!desktopLearningActive &&
            toolInteraction &&
            toolInteraction.kind !== "pet" &&
            (toolInteraction.kind !== "ball" || toolInteraction.ballVisible) && (
              <button
                key={toolInteraction.id}
                className={`pet-tool pet-tool-${toolInteraction.kind} ${
                  toolInteraction.kind === "ball"
                    ? `ball-tool-${toolInteraction.ballPhase}`
                    : ""
                }`}
                type="button"
                disabled={
                  toolInteraction.kind === "ball" &&
                  !["ready", "charging"].includes(toolInteraction.ballPhase ?? "")
                }
                aria-label={
                  toolInteraction.kind === "treat"
                    ? "拖动猫条"
                    : toolInteraction.kind === "wand"
                      ? "拖动逗猫棒"
                      : "按住球蓄力，松手扔出"
                }
                style={{
                  left: toolInteraction.x,
                  top: toolInteraction.y,
                }}
                onPointerDown={onToolPointerDown}
                onPointerMove={onToolPointerMove}
                onPointerUp={releaseToolPointer}
                onPointerCancel={releaseToolPointer}
              >
                <span />
              </button>
            )}
        </div>
        {learningBuildEnabled &&
          settings.learningQuickStartVisible &&
          !desktopLearningActive &&
          !strongAlertActive &&
          !activeIntent &&
          !focusSession &&
          !toolInteraction &&
          !sleepPresentationActive &&
          !learningInvitation && (
            <button
              className="pet-learning-quick-start"
              type="button"
              disabled={learningStartPending}
              aria-label="不用打开菜单，直接开始英语复习"
              onPointerDown={(event) => event.stopPropagation()}
              onPointerMove={(event) => event.stopPropagation()}
              onPointerUp={(event) => event.stopPropagation()}
              onPointerCancel={(event) => event.stopPropagation()}
              onClick={(event) => {
                event.stopPropagation();
                void startDesktopLearning();
              }}
            >
              <span aria-hidden="true">A</span>
            </button>
          )}
        <button
          className={`resize-handle ${strongAlertActive || desktopLearningActive || toolInteraction ? "is-hidden" : ""}`}
          type="button"
          aria-label="调整圆圆大小"
          onPointerDown={onResizePointerDown}
        />
      </div>
    </main>
  );
}
