// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type {
  AppSettings,
  CompanionExpressionSnapshot,
  Occurrence,
  PetActivitySnapshot,
  PetIntent,
  TodaySnapshot,
} from "../types";

const backend = vi.hoisted(() => ({
  completeOccurrence: vi.fn(),
  finishPetInteraction: vi.fn(async () => true),
  getBasicSupportState: vi.fn(),
  getCompanionExpressionSnapshot: vi.fn(),
  getFocusState: vi.fn(),
  getPetActivitySnapshot: vi.fn(),
  getSettings: vi.fn(),
  getRuntimeCapabilities: vi.fn(),
  listToday: vi.fn(),
  onBackendEvent: vi.fn(),
  setPetSize: vi.fn(),
  showTaskPanel: vi.fn(),
  skipOccurrence: vi.fn(),
  snoozeOccurrence: vi.fn(),
  tauriAvailable: vi.fn(() => false),
}));

const sprite = vi.hoisted(() => ({ complete: null as null | (() => void) }));

vi.mock("../lib/backend", () => backend);
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/dpi", () => ({
  LogicalSize: class {},
  PhysicalPosition: class {},
  PhysicalSize: class {},
}));
vi.mock("@tauri-apps/api/window", () => ({
  currentMonitor: vi.fn(async () => null),
  getCurrentWindow: vi.fn(),
}));
vi.mock("./SpriteAnimator", () => ({
  SpriteAnimator: ({
    animation,
    fallbackAnimation,
    lookFrame,
    onComplete,
  }: {
    animation: string;
    fallbackAnimation: string;
    lookFrame: number | null;
    onComplete: (animation: never) => void;
  }) => {
    sprite.complete = () => onComplete(animation as never);
    return (
      <div
        className="sprite-animator"
        data-animation={animation}
        data-fallback-animation={fallbackAnimation}
        data-look-frame={lookFrame ?? "none"}
      />
    );
  },
}));
vi.mock("./CompanionPropStage", () => ({
  CompanionPropStage: () => <div data-testid="companion-prop" />,
}));

import { PetWindow } from "./PetWindow";
import { acceptPetSnapshot, builtinPet, getPetSnapshot } from "./petProfile";

const settings: AppSettings = {
  animationMode: "always",
  sceneWardrobeMode: "full",
  petProfile: { schemaVersion: 1, selectedPackId: "builtin:yuanyuan", nicknames: {} },
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

const expression = (
  revision: number,
  sceneAppearance: CompanionExpressionSnapshot["sceneAppearance"],
  overrides: Partial<CompanionExpressionSnapshot> = {},
): CompanionExpressionSnapshot => ({
  schemaVersion: 2,
  revision,
  tier: "n2",
  intent: "quiet_presence",
  pose: "focus_calm",
  props: [],
  label: null,
  attention: "silent",
  motion: "full",
  movePropForward: false,
  queueInBasket: false,
  taskSource: null,
  groupedCount: 0,
  focusDeferredCount: 0,
  accessibleState: "working",
  sceneAppearance,
  ...overrides,
});

const activity = (
  revision: number,
  value: PetActivitySnapshot["activity"],
): PetActivitySnapshot => ({
  revision,
  activity: value,
  source: value === "reminding" ? "reminder" : "focus",
  leaseId: `lease-${revision}`,
  resumableLearningSessionId: null,
  restoreTarget: value === "reminding" ? "focusing" : null,
});

const occurrence = (id: string, category: Occurrence["category"]): Occurrence => ({
  id,
  reminderId: `${category}-reminder`,
  reminderTitle: category === "water" ? "喝水" : "吃饭",
  category,
  scheduledAt: new Date().toISOString(),
  status: "pending",
  actedAt: null,
  snoozedUntil: null,
  resolutionReason: null,
});

const reminderIntent = (item: Occurrence): PetIntent => ({
  id: `intent-${item.id}`,
  kind: "reminder",
  priority: 100,
  animation: "alert-glass-paws",
  route: "today",
  title: item.category === "water" ? "喝水提醒" : "吃饭提醒",
  message: item.reminderTitle,
  occurrenceId: item.id,
  persistent: true,
  expiresAt: null,
});

describe("PetWindow scene wardrobe integration", () => {
  let container: HTMLDivElement;
  let root: Root;
  let handlers: Map<string, (payload: never) => void>;
  let today: TodaySnapshot;

  const flush = async () => {
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
  };

  const emit = async (event: string, payload: unknown) => {
    await act(async () => handlers.get(event)?.(payload as never));
    await flush();
  };

  const animation = () =>
    container.querySelector<HTMLElement>(".sprite-animator")?.dataset.animation;

  beforeEach(async () => {
    acceptPetSnapshot({ ...getPetSnapshot(), revision: getPetSnapshot().revision + 1, effectivePackId: builtinPet.packId, selectedPackId: builtinPet.packId, nickname: "圆圆", capabilities: builtinPet.capabilities, manifest: builtinPet.manifest, staticOnly: false });
    vi.useFakeTimers();
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    Object.defineProperty(window, "matchMedia", {
      configurable: true,
      value: vi.fn(() => ({ matches: false })),
    });
    handlers = new Map();
    today = {
      reminders: [],
      occurrences: [],
      waterCompleted: 0,
      waterGoal: 9,
      notificationAvailable: true,
    };
    backend.getSettings.mockResolvedValue(structuredClone(settings));
    backend.getRuntimeCapabilities.mockResolvedValue({ learning: { available: false } });
    backend.getFocusState.mockResolvedValue({
      session: {
        id: "focus-1",
        phase: "focus",
        status: "active",
        durationMinutes: 25,
        startedAt: new Date().toISOString(),
        endsAt: new Date(Date.now() + 25 * 60_000).toISOString(),
        completedAt: null,
      },
    });
    backend.listToday.mockImplementation(async () => structuredClone(today));
    backend.getCompanionExpressionSnapshot.mockResolvedValue(
      expression(1, { kind: "work", stage: "fresh" }),
    );
    backend.getPetActivitySnapshot.mockResolvedValue(activity(1, "focusing"));
    backend.getBasicSupportState.mockResolvedValue(null);
    backend.onBackendEvent.mockImplementation(
      async (event: string, handler: (payload: never) => void) => {
        handlers.set(event, handler);
        return () => handlers.delete(event);
      },
    );
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    await act(async () => root.render(<PetWindow />));
    await flush();
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    sprite.complete = null;
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  it("restores the authoritative fatigue stage after a completed hydration reminder", async () => {
    expect(animation()).toBe("work-focus-loop");

    await emit("companion-expression", expression(2, { kind: "work", stage: "transition" }));
    expect(animation()).toBe("work-fatigue-enter");
    await act(async () => sprite.complete?.());
    expect(animation()).toBe("work-fatigue-enter");

    // Switching the renderer must reread the ongoing business state, not restart focus.
    backend.getCompanionExpressionSnapshot.mockResolvedValue(expression(2, { kind: "work", stage: "transition" }));
    await act(async () => acceptPetSnapshot({ ...getPetSnapshot(), revision: getPetSnapshot().revision + 1, selectedPackId: "other-pet", effectivePackId: "other-pet", capabilities: { learning: false, scene: false } }));
    await flush();
    expect(animation()).toBe("work-fatigue-enter");
    await act(async () => sprite.complete?.());
    expect(animation()).toBe("work-fatigue-enter");

    const water = occurrence("water-1", "water");
    today.occurrences = [water];
    await emit(
      "companion-expression",
      expression(3, { kind: "hydration" }, {
        tier: "n3",
        intent: "needs_attention",
        pose: "alert",
        props: ["bell", "task_card"],
        label: "water_due",
        attention: "ring_once",
        accessibleState: "water_reminder_due",
      }),
    );
    await emit("pet-activity-snapshot-updated", activity(2, "reminding"));
    await emit("pet-intent", reminderIntent(water));
    expect(animation()).toBe("hydration-alert");
    await act(async () => sprite.complete?.());
    expect(animation()).toBe("hydration-wait");

    today.occurrences = [];
    await emit("companion-expression", expression(4, { kind: "work", stage: "fatigued" }));
    await emit("pet-intent-resolved", {
      occurrenceId: water.id,
      category: "water",
      action: "complete",
    });
    expect(animation()).toBe("drinking-water");

    await act(async () => vi.advanceTimersByTime(2_600));
    await flush();
    expect(animation()).toBe("work-fatigue-loop");
  });

  it.each(["snooze", "skip"] as const)(
    "%s restores work directly without a meal completion animation",
    async (action) => {
      const meal = occurrence("meal-1", "meal");
      today.occurrences = [meal];
      await emit(
        "companion-expression",
        expression(2, { kind: "meal" }, {
          tier: "n3",
          intent: "needs_attention",
          pose: "alert",
          props: ["task_card"],
          label: "reminder_due",
          attention: "ring_once",
          accessibleState: "meal_reminder_due",
        }),
      );
      await emit("pet-activity-snapshot-updated", activity(2, "reminding"));
      await emit("pet-intent", reminderIntent(meal));
      expect(animation()).toBe("meal-alert");

      today.occurrences = [];
      await emit("companion-expression", expression(3, { kind: "work", stage: "fresh" }));
      await emit("pet-intent-resolved", {
        occurrenceId: meal.id,
        category: "meal",
        action,
      });
      expect(animation()).toBe("work-focus-loop");
    },
  );

  it("restarts a spa entrance after a temporary high-priority interruption", async () => {
    await emit("pet-activity-snapshot-updated", activity(2, "idle"));
    await emit("companion-expression", expression(2, { kind: "spa" }, {
      tier: "n0",
      intent: "quiet_presence",
      pose: "idle",
      props: [],
      accessibleState: "resting_care",
    }));
    expect(animation()).toBe("spa-enter");
    await act(async () => sprite.complete?.());
    expect(animation()).toBe("spa-loop");

    await emit("companion-expression", expression(3, { kind: "hydration" }, {
      tier: "n3",
      intent: "needs_attention",
      pose: "alert",
      props: ["bell", "task_card"],
      label: "water_due",
      attention: "ring_once",
      accessibleState: "water_reminder_due",
    }));
    expect(animation()).toBe("hydration-alert");

    await emit("companion-expression", expression(4, { kind: "spa" }, {
      tier: "n0",
      intent: "quiet_presence",
      pose: "idle",
      props: [],
      accessibleState: "resting_care",
    }));
    expect(animation()).toBe("spa-enter");
  });

  it("applies wardrobe mode changes immediately to the current semantic scene", async () => {
    expect(animation()).toBe("work-focus-loop");
    await emit("settings-updated", { ...settings, sceneWardrobeMode: "off" });
    expect(animation()).toBe("focus-calm");
    await emit("settings-updated", {
      ...settings,
      sceneWardrobeMode: "reminders_only",
    });
    expect(animation()).toBe("focus-calm");
    await emit("companion-expression", expression(2, { kind: "hydration" }, {
      tier: "n3",
      intent: "needs_attention",
      pose: "alert",
      accessibleState: "water_reminder_due",
    }));
    expect(animation()).toBe("hydration-alert");
  });

  it("keeps focus active while a short interaction temporarily covers the latest work stage", async () => {
    await emit("companion-expression", expression(2, { kind: "work", stage: "fatigued" }));
    expect(animation()).toBe("work-fatigue-loop");

    expect(container.querySelector(".scene-work-props")).not.toBeNull();
    await emit("pet-interaction-started", { id: "treat-1", kind: "treat", leaseRevision: 2, expiresAtUnixMs: Date.now() + 30_000 });
    expect(animation()).toBe("treat-follow");
    expect(container.querySelector(".scene-work-props")).toBeNull();
    expect(container.querySelector('[data-information-surface="timer"]')).toBeNull();
    expect(container.querySelector('[data-information-surface="tool"]')).not.toBeNull();
    expect(container.querySelector("main")?.getAttribute("aria-label")).toContain("正在和你互动");
    expect(backend.getFocusState).toHaveBeenCalledTimes(1);

    await emit("focus-updated", await backend.getFocusState.mock.results[0].value);
    await emit("pet-activity-snapshot-updated", { ...activity(2, "idle"), source: "manual", leaseId: "treat-1" });
    expect(animation()).toBe("treat-follow");
    expect(container.querySelector(".scene-work-props")).toBeNull();

    await act(async () => vi.advanceTimersByTime(30_000));
    expect(animation()).toBe("work-fatigue-loop");
    expect(container.querySelector(".scene-work-props")).not.toBeNull();
    expect(backend.finishPetInteraction).toHaveBeenCalledWith("treat-1", 2);
    expect(backend.getFocusState).toHaveBeenCalledTimes(1);
  });

  it("ends on the authoritative lease deadline and rejects expired or replayed starts", async () => {
    const started = { id: "ball-1", kind: "ball", leaseRevision: 2, expiresAtUnixMs: Date.now() + 5_000 };
    await emit("pet-interaction-started", started);
    expect(container.querySelector(".pet-tool-ball")).not.toBeNull();
    await act(async () => vi.advanceTimersByTime(4_999));
    expect(container.querySelector(".pet-tool-ball")).not.toBeNull();
    await act(async () => vi.advanceTimersByTime(1));
    expect(container.querySelector(".pet-tool-ball")).toBeNull();
    await emit("pet-interaction-started", { ...started, expiresAtUnixMs: Date.now() + 30_000 });
    await emit("pet-interaction-started", { ...started, leaseRevision: 3, expiresAtUnixMs: Date.now() - 1 });
    expect(container.querySelector(".pet-tool-ball")).toBeNull();
    expect(backend.finishPetInteraction).toHaveBeenCalledTimes(1);
  });

  it.each(["fresh", "transition", "fatigued"] as const)(
    "clears interaction gaze when restoring %s work without a new expression revision",
    async (stage) => {
      await emit("companion-expression", expression(2, { kind: "work", stage }));
      const expected = animation();
      await emit("pet-interaction-started", {
        id: "ball-gaze", kind: "ball", leaseRevision: 2,
        expiresAtUnixMs: Date.now() + 5_000,
      });
      await emit("cursor-direction-changed", { frame: 3 });
      expect(container.querySelector<HTMLElement>(".sprite-animator")?.dataset.lookFrame).toBe("3");
      await act(async () => vi.advanceTimersByTime(5_000));
      expect(animation()).toBe(expected);
      expect(container.querySelector<HTMLElement>(".sprite-animator")?.dataset.lookFrame).toBe("none");
      expect(container.querySelector(".pet-tool-ball")).toBeNull();
      expect(backend.getFocusState).toHaveBeenCalledTimes(1);
    },
  );

  it("clears stale gaze when Rust ends the tool lease before the frontend timer", async () => {
    await emit("pet-interaction-started", {
      id: "ball-gaze", kind: "ball", leaseRevision: 2,
      expiresAtUnixMs: Date.now() + 30_000,
    });
    await emit("cursor-direction-changed", { frame: 3 });
    await emit("pet-activity-snapshot-updated", activity(3, "focusing"));
    expect(animation()).toBe("work-focus-loop");
    expect(container.querySelector<HTMLElement>(".sprite-animator")?.dataset.lookFrame).toBe("none");
    expect(container.querySelector(".pet-tool-ball")).toBeNull();
  });

  it("ignores old interaction timers and ends immediately when ownership is preempted", async () => {
    await emit("pet-interaction-started", { id: "ball-old", kind: "ball", leaseRevision: 2, expiresAtUnixMs: Date.now() + 5_000 });
    await act(async () => vi.advanceTimersByTime(1_000));
    await emit("pet-interaction-started", { id: "wand-new", kind: "wand", leaseRevision: 3, expiresAtUnixMs: Date.now() + 10_000 });
    await act(async () => vi.advanceTimersByTime(4_000));
    expect(container.querySelector(".pet-tool-ball")).toBeNull();
    expect(container.querySelector(".pet-tool-wand")).not.toBeNull();
    expect(backend.finishPetInteraction).toHaveBeenCalledWith("ball-old", 2);
    await emit("pet-activity-snapshot-updated", activity(4, "reminding"));
    expect(container.querySelector(".pet-tool-wand")).toBeNull();
    expect(backend.finishPetInteraction).toHaveBeenCalledWith("wand-new", 3);
  });

  it.each(["water", "meal"] as const)("plays %s completion after Rust has already cleared the active reminder", async (category) => {
    const item = occurrence("resolved-1", category);
    today.occurrences = [item];
    await emit("pet-activity-snapshot-updated", activity(2, "reminding"));
    await emit("pet-intent", reminderIntent(item));
    today.occurrences = [];
    // Exact production ordering: reconcile ownership/expression, occurrence-updated, then resolution.
    await emit("pet-activity-snapshot-updated", activity(3, "focusing"));
    await emit("companion-expression", expression(2, { kind: "work", stage: "fatigued" }));
    await emit("occurrence-updated", undefined);
    await emit("pet-intent-resolved", { occurrenceId: item.id, category, action: "complete" });
    const expected = category === "water" ? "drinking-water" : "eating-food";
    expect(animation()).toBe(expected);
    expect(container.querySelector(".scene-work-props")).toBeNull();
    await emit("companion-expression", expression(3, { kind: "work", stage: "fatigued" }));
    await emit("focus-updated", await backend.getFocusState.mock.results[0].value);
    await act(async () => vi.advanceTimersByTime(2_000));
    await emit("pet-intent-resolved", { occurrenceId: item.id, category, action: "complete" });
    expect(animation()).toBe(expected);
    await act(async () => vi.advanceTimersByTime(600));
    expect(animation()).toBe("work-fatigue-loop");
    expect(container.querySelector(".scene-work-props")).not.toBeNull();
  });

  it("cancels a completion when a new reminder takes ownership, without an old timer restoring work", async () => {
    const water = occurrence("water-old", "water"), meal = occurrence("meal-new", "meal");
    today.occurrences = [water];
    await emit("pet-activity-snapshot-updated", activity(2, "reminding"));
    await emit("pet-intent", reminderIntent(water));
    today.occurrences = [];
    await emit("pet-activity-snapshot-updated", activity(3, "focusing"));
    await emit("pet-intent-resolved", { occurrenceId: water.id, category: "water", action: "complete" });
    expect(animation()).toBe("drinking-water");
    today.occurrences = [meal];
    await emit("companion-expression", expression(2, { kind: "meal" }, { pose: "alert", accessibleState: "meal_reminder_due" }));
    await emit("pet-activity-snapshot-updated", activity(4, "reminding"));
    await emit("pet-intent", reminderIntent(meal));
    await act(async () => vi.advanceTimersByTime(3_000));
    expect(animation()).toBe("meal-alert");
    expect(container.querySelector(".scene-work-props")).toBeNull();
  });

  it("plays night enter, loop, and exit around authoritative sleep state", async () => {
    await emit("pet-activity-snapshot-updated", activity(2, "sleeping"));
    await emit("companion-expression", expression(2, { kind: "night" }, {
      tier: "n0",
      intent: "quiet_presence",
      pose: "sleeping",
      props: [],
      accessibleState: "sleeping",
    }));
    expect(animation()).toBe("night-enter");
    await act(async () => sprite.complete?.());
    expect(animation()).toBe("night-loop");

    await emit("companion-expression", expression(3, { kind: "none" }, {
      tier: "n0",
      intent: "quiet_presence",
      pose: "idle",
      props: [],
      accessibleState: "quiet_presence",
    }));
    await emit("pet-activity-snapshot-updated", activity(3, "idle"));
    expect(animation()).toBe("night-exit");
    await act(async () => sprite.complete?.());
    expect(animation()).toBe("idle");
  });

  it.each(["pending", "playing"] as const)("invalidates a %s completion when the pet resources change", async (phase) => {
    const water = occurrence(`switch-${phase}`, "water");
    today.occurrences = [water];
    await emit("pet-activity-snapshot-updated", activity(2, "reminding"));
    await emit("pet-intent", reminderIntent(water));
    today.occurrences = [];
    await emit("pet-activity-snapshot-updated", activity(3, "focusing"));
    let resolveToday: ((value: TodaySnapshot) => void) | undefined;
    if (phase === "pending") {
      backend.listToday.mockImplementationOnce(() => new Promise<TodaySnapshot>((resolve) => { resolveToday = resolve; }));
    }
    await emit("pet-intent-resolved", { occurrenceId: water.id, category: "water", action: "complete" });
    if (phase === "playing") expect(animation()).toBe("drinking-water");
    backend.getCompanionExpressionSnapshot.mockResolvedValue(expression(4, { kind: "work", stage: "transition" }));
    backend.getPetActivitySnapshot.mockResolvedValue(activity(4, "focusing"));
    await act(async () => acceptPetSnapshot({ ...getPetSnapshot(), revision: getPetSnapshot().revision + 1,
      selectedPackId: `switch-${phase}`, effectivePackId: `switch-${phase}`, capabilities: { learning: false, scene: false } }));
    await flush();
    await act(async () => resolveToday?.(structuredClone(today)));
    await act(async () => vi.advanceTimersByTime(3_000));
    expect(animation()).toBe("work-fatigue-enter");
    expect(backend.completeOccurrence).not.toHaveBeenCalled();
    expect(backend.getFocusState).toHaveBeenCalledTimes(1);
  });

  it.each(["off", "system"] as const)("restores work without an animation callback in %s mode", async (animationMode) => {
    Object.defineProperty(window, "matchMedia", { configurable: true, value: vi.fn(() => ({ matches: true })) });
    await emit("settings-updated", { ...settings, animationMode });
    const meal = occurrence(`static-${animationMode}`, "meal");
    today.occurrences = [meal];
    await emit("pet-activity-snapshot-updated", activity(2, "reminding"));
    await emit("pet-intent", reminderIntent(meal));
    today.occurrences = [];
    await emit("pet-activity-snapshot-updated", activity(3, "focusing"));
    await emit("companion-expression", expression(2, { kind: "work", stage: "fatigued" }));
    await emit("pet-intent-resolved", { occurrenceId: meal.id, category: "meal", action: "complete" });
    expect(animation()).toBe("eating-food");
    await act(async () => vi.advanceTimersByTime(2_600));
    expect(animation()).toBe("work-fatigue-loop");
    expect(backend.completeOccurrence).not.toHaveBeenCalled();
  });

  it("lets waiting_user interrupt completion even without a wardrobe scene", async () => {
    const meal = occurrence("before-waiting-user", "meal");
    today.occurrences = [meal];
    await emit("pet-activity-snapshot-updated", activity(2, "reminding"));
    await emit("pet-intent", reminderIntent(meal));
    today.occurrences = [];
    await emit("pet-activity-snapshot-updated", activity(3, "focusing"));
    await emit("pet-intent-resolved", { occurrenceId: meal.id, category: "meal", action: "complete" });
    expect(animation()).toBe("eating-food");
    await emit("companion-expression", expression(2, { kind: "none" }, {
      tier: "n3", intent: "needs_attention", pose: "alert", label: "needs_user", accessibleState: "task_needs_user",
    }));
    const attentionAnimation = animation();
    expect(attentionAnimation).not.toBe("eating-food");
    await act(async () => vi.advanceTimersByTime(3_000));
    expect(animation()).toBe(attentionAnimation);
  });

  it("ignores an interrupted animation callback and starts the loop only at the fatigued stage", async () => {
    await emit("companion-expression", expression(2, { kind: "hydration" }));
    const interruptedComplete = sprite.complete;
    await emit("companion-expression", expression(3, { kind: "work", stage: "transition" }));
    await act(async () => interruptedComplete?.());
    expect(animation()).toBe("work-fatigue-enter");
    await act(async () => sprite.complete?.());
    expect(animation()).toBe("work-fatigue-enter");
    await emit("companion-expression", expression(4, { kind: "work", stage: "fatigued" }));
    expect(animation()).toBe("work-fatigue-loop");
  });

  it("plays work recovery after a completed warmup scene", async () => {
    await emit("companion-expression", expression(2, { kind: "warmup" }, {
      tier: "n2",
      intent: "needs_attention",
      pose: "approach",
      props: ["task_card"],
      label: "time_to_move",
      accessibleState: "activity_reminder_due",
    }));
    expect(animation()).toBe("warmup-alert");
    await act(async () => sprite.complete?.());
    expect(animation()).toBe("warmup-loop");

    await emit("companion-expression", expression(3, { kind: "work", stage: "fresh" }));
    expect(animation()).toBe("work-recover");
    await act(async () => sprite.complete?.());
    expect(animation()).toBe("work-focus-loop");
  });
});
