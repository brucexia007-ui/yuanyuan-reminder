import { invoke } from "@tauri-apps/api/core";
import {
  LogicalSize,
  PhysicalPosition,
  PhysicalSize,
} from "@tauri-apps/api/dpi";
import { currentMonitor, getCurrentWindow } from "@tauri-apps/api/window";
import {
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
  getFocusState,
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
  FocusState,
  PetInteractionStarted,
  PetIntent,
  TodaySnapshot,
} from "../types";
import { SpriteAnimator } from "./SpriteAnimator";
import type { AnimationName, LifeAnimationName } from "./manifest";
import { formatRemaining, shouldAcceptIntent } from "./petIntent";
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
import "./pet.css";

const defaultSettings: AppSettings = {
  animationMode: "always",
  animationSpeed: 1,
  cursorFollow: true,
  alwaysOnTop: true,
  clickThrough: false,
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
    active.find((item) => item.category === "water") ??
    active.find((item) => item.reminderId !== "system-activity-reminder") ??
    active.find((item) => item.reminderId === "system-activity-reminder");
  if (!pending) return null;
  const activity = pending.reminderId === "system-activity-reminder";
  return {
    id: `restored-${pending.id}-${pending.status}`,
    kind: activity ? "activity" : "overdue",
    priority: activity ? 90 : 95,
    animation: activity ? "activity-jumping" : "alert-glass-paws",
    route: "today",
    title: activity ? "起来活动一下" : "还有事项等你处理",
    message: activity
      ? "你已经连续使用电脑一段时间啦，和圆圆一起动一动吧。"
      : pending.reminderTitle,
    occurrenceId: pending.id,
    persistent: true,
    expiresAt: null,
  };
}

function isStrongAlertIntent(intent: PetIntent | null): boolean {
  if (!intent || intent.priority < 80) return false;
  return ["reminder", "overdue", "success", "break", "activity"].includes(
    intent.kind,
  );
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
  const [focusState, setFocusState] = useState<FocusState>({ session: null });
  const [toolInteraction, setToolInteraction] =
    useState<ActiveToolInteraction | null>(null);
  const [clock, setClock] = useState(Date.now());
  const drag = useRef<DragState | null>(null);
  const stateBeforeTransient = useRef<AnimationName>("idle");
  const currentAnimation = useRef<AnimationName>("idle");
  const cursorFollowEnabled = useRef(true);
  const bellyHoldTimer = useRef<number | null>(null);
  const activeIntentRef = useRef<PetIntent | null>(null);
  const focusStateRef = useRef<FocusState>({ session: null });
  const automaticSleepRequested = useRef(false);
  const queuedAfterWake = useRef<PetIntent | null>(null);
  const deferredIntent = useRef<PetIntent | null>(null);
  const toolInteractionRef = useRef<ActiveToolInteraction | null>(null);
  const settingsRef = useRef(defaultSettings);
  const alertWindowSnapshot = useRef<WindowSnapshot | null>(null);
  const alertStageRequested = useRef(false);

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

  const showStrongAlertStage = useCallback(async () => {
    if (!windowApi) return;
    if (alertWindowSnapshot.current) return;
    alertStageRequested.current = true;
    const [position, size, scaleFactor, monitor] = await Promise.all([
      windowApi.outerPosition(),
      windowApi.outerSize(),
      windowApi.scaleFactor(),
      currentMonitor(),
    ]);
    if (!alertStageRequested.current || alertWindowSnapshot.current) return;

    alertWindowSnapshot.current = { position, size };
    const target = alertStagePosition(
      position,
      size,
      scaleFactor,
      monitor
        ? {
            position: monitor.workArea.position,
            size: monitor.workArea.size,
          }
        : undefined,
    );
    await windowApi.setPosition(new PhysicalPosition(target.x, target.y));
    await windowApi.setSize(
      new LogicalSize(ALERT_STAGE_WIDTH, ALERT_STAGE_HEIGHT),
    );
  }, [windowApi]);

  const hideStrongAlertStage = useCallback(async () => {
    alertStageRequested.current = false;
    const snapshot = alertWindowSnapshot.current;
    if (!snapshot) return;
    alertWindowSnapshot.current = null;
    if (!windowApi) return;
    await windowApi.setSize(
      new PhysicalSize(snapshot.size.width, snapshot.size.height),
    );
    await windowApi.setPosition(snapshot.position);
  }, [windowApi]);

  const restorePetWindowSize = useCallback(() => {
    if (!windowApi) return;
    const width = settingsRef.current.petWidth;
    void windowApi.setSize(
      new LogicalSize(width + 28, Math.round((width * 208) / 192) + 28),
    );
  }, [windowApi]);

  const endToolInteraction = useCallback(() => {
    const current = toolInteractionRef.current;
    const next = transitionToolInteraction(toolInteractionRef.current, {
      type: "end",
    });
    toolInteractionRef.current = next;
    setToolInteraction(next);
    if (current?.kind === "ball") restorePetWindowSize();
  }, [restorePetWindowSize]);

  const restoreFunctionalAnimation = useCallback(() => {
    const currentIntent = activeIntentRef.current;
    if (currentIntent) {
      setAnimation(currentIntent.animation);
      return;
    }
    const session = focusStateRef.current.session;
    if (session) {
      setAnimation(session.phase === "focus" ? "focus-calm" : "waiting");
      return;
    }
    setAnimation(automaticSleepRequested.current ? "sleep-enter" : "idle");
  }, []);

  const applyIntent = useCallback(
    (incomingIntent: PetIntent) => {
      const intent = withStrongAlertAnimation(incomingIntent);
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
      if (!shouldAcceptIntent(activeIntentRef.current, intent)) {
        if (
          !deferredIntent.current ||
          intent.priority > deferredIntent.current.priority
        ) {
          deferredIntent.current = intent;
        }
        return;
      }
      endToolInteraction();
      clearBellyHold();
      setLookFrame(null);
      updateActiveIntent(intent);
      const sleeping = ["sleep-enter", "sleeping"].includes(currentAnimation.current);
      if (sleeping && intent.priority >= 80) {
        queuedAfterWake.current = intent;
        setAnimation("wake-up");
      } else if (!sleeping) {
        setAnimation(intent.animation);
      }
    },
    [clearBellyHold, endToolInteraction, updateActiveIntent],
  );

  useEffect(() => {
    cursorFollowEnabled.current = settings.cursorFollow;
  }, [settings.cursorFollow]);

  useEffect(() => {
    void Promise.all([getSettings(), getFocusState(), listToday()]).then(
      ([nextSettings, nextFocus, today]) => {
        setSettings(nextSettings);
        focusStateRef.current = nextFocus;
        setFocusState(nextFocus);
        if (nextFocus.session) {
          setAnimation(
            nextFocus.session.phase === "focus" ? "focus-calm" : "waiting",
          );
        }
        const pending = pendingIntentFromSnapshot(today);
        if (pending) applyIntent(pending);
      },
    );
    const cleanups: Array<() => void> = [];
    void Promise.all([
      onBackendEvent<AppSettings>("settings-updated", setSettings),
      onBackendEvent<PetIntent>("pet-intent", applyIntent),
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
        if (nextFocus.session) {
          endToolInteraction();
          if ((activeIntentRef.current?.priority ?? 0) < 80) {
            updateActiveIntent(null);
            setLookFrame(null);
            setAnimation(
              nextFocus.session.phase === "focus" ? "focus-calm" : "waiting",
            );
            return;
          }
        }
        if (!activeIntentRef.current) {
          if (nextFocus.session) {
            setLookFrame(null);
            setAnimation(
              nextFocus.session.phase === "focus" ? "focus-calm" : "waiting",
            );
          } else {
            restoreFunctionalAnimation();
          }
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
      onBackendEvent<void>("pet-request-sleep", () => {
        automaticSleepRequested.current = true;
        endToolInteraction();
        clearBellyHold();
        setLookFrame(null);
        if (!activeIntentRef.current && !focusStateRef.current.session) {
          setAnimation("sleep-enter");
        }
      }),
      onBackendEvent<void>("pet-request-wake", () => {
        automaticSleepRequested.current = false;
        clearBellyHold();
        setLookFrame(null);
        if (["sleep-enter", "sleeping"].includes(currentAnimation.current)) {
          setAnimation("wake-up");
        }
      }),
      onBackendEvent<PetInteractionStarted>(
        "pet-interaction-started",
        ({ id, kind }) => {
          if (
            focusStateRef.current.session?.phase === "focus" ||
            (activeIntentRef.current?.priority ?? 0) >= 50 ||
            !["treat", "wand", "pet", "ball"].includes(kind)
          ) {
            return;
          }
          clearBellyHold();
          setLookFrame(null);
          if (
            toolInteractionRef.current?.kind === "ball" &&
            kind !== "ball"
          ) {
            restorePetWindowSize();
          }
          const nextStageWidth =
            kind === "ball"
              ? ballStageWidth(settings.petWidth)
              : settings.petWidth;
          if (kind === "ball") {
            void windowApi?.setSize(
              new LogicalSize(
                nextStageWidth + 28,
                Math.round((settings.petWidth * 208) / 192) + 28,
              ),
            );
          }
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
    applyIntent,
    clearBellyHold,
    endToolInteraction,
    restoreFunctionalAnimation,
    restorePetWindowSize,
    settings.petWidth,
    windowApi,
  ]);

  useEffect(() => {
    if (isStrongAlertIntent(activeIntent)) {
      void showStrongAlertStage();
    } else {
      void hideStrongAlertStage();
    }
  }, [activeIntent, hideStrongAlertStage, showStrongAlertStage]);

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
    const systemAllowsMotion =
      settings.animationMode !== "system" ||
      !window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    if (
      animation !== "idle" ||
      activeIntent !== null ||
      focusState.session !== null ||
      automaticSleepRequested.current ||
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
  }, [activeIntent, animation, focusState.session, settings.animationMode]);

  const finishAnimation = useCallback((finished: AnimationName) => {
    if (
      toolInteractionRef.current?.kind === "ball" &&
      ["ball-bat", "ball-pickup", "ball-carry", "ball-drop"].includes(finished)
    ) {
      return;
    }
    if (finished === "sleep-enter") {
      setAnimation("sleeping");
    } else if (finished === "wake-up") {
      const queued = queuedAfterWake.current;
      queuedAfterWake.current = null;
      if (queued) setAnimation(queued.animation);
      else restoreFunctionalAnimation();
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
    } else if (activeIntentRef.current?.animation === finished) {
      if (
        activeIntentRef.current.persistent &&
        activeIntentRef.current.kind === "reminder" &&
        finished === "meowing"
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
  }, [clearBellyHold, restoreFunctionalAnimation]);

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

  const openBubbleRoute = (route: PetIntent["route"]) => {
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
        await snoozeOccurrence(intent.occurrenceId);
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
  const strongAlertActive = isStrongAlertIntent(activeIntent);
  const bubble = activeIntent
    ? {
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
      : focusSession
      ? {
          label: focusSession.phase === "focus" ? "专注" : "休息",
          title: focusSession.phase === "focus" ? "专注中" : "休息中",
          message: `${formatRemaining(focusSession.endsAt, clock)} · 点击查看`,
          route: "focus" as const,
        }
      : toolInteraction
        ? {
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
  const activeStageWidth = strongAlertActive
    ? ALERT_STAGE_WIDTH
    : ballGameActive
      ? toolInteraction.stageWidth
      : settings.petWidth;
  const hitRegionStyle = {
    width: activeStageWidth,
    height: strongAlertActive
      ? ALERT_STAGE_HEIGHT
      : ballGameActive
        ? petHeight
        : undefined,
    "--pet-width": `${settings.petWidth}px`,
    "--pet-height": `${petHeight}px`,
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

  return (
    <main className="pet-window" aria-label="圆圆桌面宠物">
      <div
        className={`pet-hit-region ${
          toolInteraction?.kind === "pet" ? "petting-active" : ""
        } ${ballGameActive ? `ball-game-active ball-${toolInteraction.ballPhase}` : ""} ${
          strongAlertActive ? "alert-stage" : ""
        } ${activeIntent?.kind === "activity" ? "activity-alert" : ""}`}
        style={hitRegionStyle}
        onContextMenu={onContextMenu}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={finishPointer}
        onPointerCancel={finishPointer}
      >
        {bubble && strongAlertActive ? (
          <div
            className={`pet-intent-bubble alert-banner ${
              activeIntent?.kind === "activity" ? "activity-banner" : ""
            } ${activeIntent?.occurrenceId ? "has-actions" : ""}`}
            onPointerDown={(event) => event.stopPropagation()}
            onPointerMove={(event) => event.stopPropagation()}
            onPointerUp={(event) => event.stopPropagation()}
            onPointerCancel={(event) => event.stopPropagation()}
          >
            <button
              className="pet-alert-copy"
              type="button"
              aria-label={`${bubble.title}：${bubble.message}，打开今日任务`}
              onClick={(event) => {
                event.stopPropagation();
                openBubbleRoute(bubble.route);
              }}
            >
              <small>{bubble.label}</small>
              <span className="pet-bubble-detail">
                <strong>{bubble.title}</strong>
                <span>{bubble.message}</span>
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
                <button
                  type="button"
                  disabled={alertActionPending}
                  onClick={() => void handleAlertAction("snooze")}
                >
                  10 分钟后
                </button>
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
        ) : bubble ? (
          <button
            className={`pet-intent-bubble ${
              toolInteraction &&
              toolInteraction.kind !== "pet" &&
              toolInteraction.x >= settings.petWidth / 2
                ? "bubble-left"
                : "bubble-right"
            }`}
            type="button"
            aria-label={`${bubble.title}：${bubble.message}`}
            onPointerDown={(event) => event.stopPropagation()}
            onPointerMove={(event) => event.stopPropagation()}
            onPointerUp={(event) => event.stopPropagation()}
            onPointerCancel={(event) => event.stopPropagation()}
            onClick={(event) => {
              event.stopPropagation();
              openBubbleRoute(bubble.route);
            }}
          >
            <small>{bubble.label}</small>
            <span className="pet-bubble-detail">
              <strong>{bubble.title}</strong>
              <span>{bubble.message}</span>
            </span>
          </button>
        ) : null}
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
              : toolInteraction?.offsetX ?? 0
          }
          settings={settings}
          onComplete={finishAnimation}
        />
        {toolInteraction?.kind === "pet" && (
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
        {toolInteraction &&
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
        <button
          className={`resize-handle ${strongAlertActive ? "is-hidden" : ""}`}
          type="button"
          aria-label="调整圆圆大小"
          onPointerDown={onResizePointerDown}
        />
      </div>
    </main>
  );
}
