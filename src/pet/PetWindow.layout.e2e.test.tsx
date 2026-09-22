// @vitest-environment jsdom

import { act, useEffect } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AppSettings, LearningSessionSnapshot, PetActivitySnapshot } from "../types";

const backend = vi.hoisted(() => ({
  completeOccurrence: vi.fn(), getBasicSupportState: vi.fn(),
  finishPetInteraction: vi.fn(async () => true),
  getCompanionExpressionSnapshot: vi.fn(), getFocusState: vi.fn(),
  getPetActivitySnapshot: vi.fn(), getSettings: vi.fn(), listToday: vi.fn(),
  getRuntimeCapabilities: vi.fn(),
  onBackendEvent: vi.fn(), setPetSize: vi.fn(), showTaskPanel: vi.fn(),
  skipOccurrence: vi.fn(), snoozeOccurrence: vi.fn(), tauriAvailable: () => true,
}));
const learning = vi.hoisted(() => ({
  getLearningHome: vi.fn(), getPendingLearningInvitation: vi.fn(),
}));
const native = vi.hoisted(() => ({
  outerPosition: vi.fn(), outerSize: vi.fn(), scaleFactor: vi.fn(),
  setSize: vi.fn(), setPosition: vi.fn(), setIgnoreCursorEvents: vi.fn(),
  setFocus: vi.fn(), monitor: vi.fn(), invoke: vi.fn(), mounts: vi.fn(),
}));
vi.mock("../lib/backend", () => backend);
vi.mock("@tauri-apps/api/core", () => ({ invoke: native.invoke }));
vi.mock("@tauri-apps/api/window", () => ({
  currentMonitor: native.monitor, getCurrentWindow: () => native,
}));
// Use the real DPI value types, while observing all native effects.
vi.mock("../learning/featureGate", () => ({ learningBuildEnabled: true }));
vi.mock("../learning/backend", () => learning);
vi.mock("../learning/LearningDesktopStage", () => ({
  LearningDesktopStage: ({ session, onClose }: {
    session: LearningSessionSnapshot; onClose: () => void;
  }) => {
    useEffect(() => { native.mounts(); }, []);
    return <section data-testid="learning" data-session={session.sessionId}>
      <input aria-label="feedback state" defaultValue="answer retained" />
      <button onClick={onClose}>close learning</button>
    </section>;
  },
}));
vi.mock("./SpriteAnimator", () => ({ SpriteAnimator: () => <div /> }));
vi.mock("./CompanionPropStage", () => ({ CompanionPropStage: () => <div /> }));

import { PetWindow } from "./PetWindow";
import { ALERT_STAGE_HEIGHT, ALERT_STAGE_WIDTH, warmupStageLayout } from "./alertStage";
import { LEARNING_STAGE_HEIGHT, LEARNING_STAGE_WIDTH } from "./learningStage";
import { interactionWindowWidth } from "./interactionStage";

const settings: AppSettings = {
  animationMode: "always", sceneWardrobeMode: "full",
  petProfile: { schemaVersion: 1, selectedPackId: "builtin:yuanyuan", nicknames: {} },
  companionIntensity: "everyday", companionLabelMode: "adaptive", animationSpeed: 1,
  cursorFollow: true, alwaysOnTop: true, clickThrough: false,
  learningQuickStartVisible: true, petWidth: 192, quietStart: "23:00", quietEnd: "07:30",
  idleSleepMinutes: 20, autostart: false, pauseUntil: null, waterStart: "09:00",
  waterEnd: "18:00", waterIntervalMinutes: 60, activityEnabled: true,
  activityStart: "09:00", activityEnd: "18:00", activityIntervalMinutes: 60,
  missedReminderPolicy: "notify", missedReminderGraceMinutes: 120,
};
const session: LearningSessionSnapshot = {
  schemaVersion: 1, sessionId: "session-1", entrySource: "manual", sessionKind: "daily",
  status: "completed", stateRevision: 5, currentItemId: null, plannedCount: 3,
  completedCount: 3, startedAtUnixMs: 1, pausedAtUnixMs: null, pauseReason: null,
  lastActivityAtUnixMs: 10, expiresAtUnixMs: 86400001, endedAtUnixMs: 10, exitReason: null,
};
const activity = (value: PetActivitySnapshot["activity"], revision = 1): PetActivitySnapshot => ({
  activity: value, revision, source: "manual", leaseId: null,
  resumableLearningSessionId: null, restoreTarget: null,
});

describe("pet window runtime capabilities and expanded settings reconciliation", () => {
  let root: Root;
  let container: HTMLDivElement;
  let handlers: Map<string, (payload: never) => void>;
  const flush = async () => { await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }); };
  const emit = async (name: string, payload: unknown) => {
    if (name === "pet-activity-snapshot-updated") backend.getPetActivitySnapshot.mockResolvedValue(payload);
    if (name === "settings-updated") backend.getSettings.mockResolvedValue(payload);
    await act(async () => handlers.get(name)?.(payload as never));
    await flush();
  };
  const enterLearning = async () => {
    await emit("pet-activity-snapshot-updated", activity("learning", 2));
    await emit("learning-session-updated", session);
    await flush();
    expect(native.setSize).toHaveBeenLastCalledWith(expect.objectContaining({
      width: LEARNING_STAGE_WIDTH, height: LEARNING_STAGE_HEIGHT,
    }));
  };
  const resetNativeGeometry = () => {
    // Rust applies a compact size before publishing settings-updated.
    native.setSize.mockClear(); native.setPosition.mockClear(); native.setFocus.mockClear();
    native.setIgnoreCursorEvents.mockClear();
  };
  const dragPointer = () => {
    const region = container.querySelector<HTMLDivElement>(".pet-hit-region")!;
    const captures = new Set<number>();
    region.setPointerCapture = vi.fn((id) => { captures.add(id); });
    region.hasPointerCapture = vi.fn((id) => captures.has(id));
    region.releasePointerCapture = vi.fn((id) => { captures.delete(id); });
    return async (type: string, screenX: number, screenY: number) => {
      const event = new MouseEvent(type, { bubbles: true, button: 0, screenX, screenY });
      Object.defineProperty(event, "pointerId", { value: 1 });
      await act(async () => region.dispatchEvent(event)); await flush();
    };
  };
  beforeEach(async () => {
    vi.resetAllMocks();
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    Object.defineProperty(window, "matchMedia", { configurable: true, value: () => ({ matches: false }) });
    handlers = new Map();
    native.outerPosition.mockResolvedValue({ x: 100, y: 100 });
    native.outerSize.mockResolvedValue({ width: 220, height: 236 });
    native.scaleFactor.mockResolvedValue(1);
    native.monitor.mockResolvedValue(null);
    for (const fn of [native.setSize, native.setPosition, native.setFocus,
      native.setIgnoreCursorEvents, native.invoke]) fn.mockResolvedValue(undefined);
    backend.getSettings.mockResolvedValue(structuredClone(settings));
    backend.getRuntimeCapabilities.mockResolvedValue({ learning: { available: true } });
    learning.getLearningHome.mockResolvedValue(null);
    learning.getPendingLearningInvitation.mockResolvedValue(null);
    backend.getFocusState.mockResolvedValue({ session: null });
    backend.getBasicSupportState.mockResolvedValue(null);
    backend.getCompanionExpressionSnapshot.mockResolvedValue({
      schemaVersion: 2, revision: 1, tier: "n0", intent: "quiet_presence", pose: "idle",
      props: [], label: null, attention: "silent", motion: "full", movePropForward: false,
      queueInBasket: false, taskSource: null, groupedCount: 0, focusDeferredCount: 0,
      accessibleState: "quiet_presence", sceneAppearance: { kind: "none" },
    });
    backend.getPetActivitySnapshot.mockResolvedValue(activity("idle"));
    backend.listToday.mockResolvedValue({ reminders: [], occurrences: [], waterCompleted: 0,
      waterGoal: 9, notificationAvailable: true });
    backend.onBackendEvent.mockImplementation(async (name, handler) => {
      handlers.set(name, handler); return () => handlers.delete(name);
    });
    container = document.createElement("div"); document.body.append(container);
    root = createRoot(container);
    await act(async () => root.render(<PetWindow />)); await flush(); await flush();
  });
  afterEach(async () => { await act(async () => root.unmount()); container.remove(); });

  const remount = async () => {
    await act(async () => root.render(null));
    learning.getLearningHome.mockClear(); learning.getPendingLearningInvitation.mockClear();
    await act(async () => root.render(<PetWindow />)); await flush(); await flush();
  };

  it.each(["disabled", "database"])("hides all learning entry points when runtime reports %s", async (failureReason) => {
    backend.getRuntimeCapabilities.mockResolvedValue({ learning: {
      compiled: failureReason !== "disabled", available: false, failureReason,
    } });
    await remount();
    expect(container.querySelector(".pet-learning-quick-start")).toBeNull();
    expect(learning.getLearningHome).not.toHaveBeenCalled();
    expect(learning.getPendingLearningInvitation).not.toHaveBeenCalled();
    expect(handlers.has("learning-session-updated")).toBe(false);
    expect(handlers.has("learning-invitation-presented")).toBe(false);
    await emit("settings-updated", { ...settings, animationMode: "off" });
    expect(container.querySelector(".pet-learning-quick-start")).toBeNull();
    expect(container.querySelector(".learning-stage")).toBeNull();
  });

  it("fails closed when runtime capability lookup fails", async () => {
    backend.getRuntimeCapabilities.mockRejectedValue(new Error("unavailable"));
    await remount();
    expect(container.querySelector(".pet-learning-quick-start")).toBeNull();
    expect(learning.getLearningHome).not.toHaveBeenCalled();
  });

  it("does not flash the quick start or request learning before capability confirmation", async () => {
    let finish!: (value: { learning: { available: boolean } }) => void;
    backend.getRuntimeCapabilities.mockImplementation(() => new Promise((resolve) => { finish = resolve; }));
    await remount();
    expect(container.querySelector(".pet-learning-quick-start")).toBeNull();
    expect(learning.getLearningHome).not.toHaveBeenCalled();
    await act(async () => finish({ learning: { available: true } })); await flush(); await flush();
    expect(container.querySelector(".pet-learning-quick-start")).not.toBeNull();
    expect(learning.getLearningHome).toHaveBeenCalledTimes(1);
  });

  it("ignores a capability response after the pet window unmounts", async () => {
    let finish!: (value: { learning: { available: boolean } }) => void;
    backend.getRuntimeCapabilities.mockImplementation(() => new Promise((resolve) => { finish = resolve; }));
    await remount();
    await act(async () => root.render(null));
    await act(async () => finish({ learning: { available: true } })); await flush();
    expect(learning.getLearningHome).not.toHaveBeenCalled();
    expect(handlers.has("learning-session-updated")).toBe(false);
  });

  it("keeps the full-build quick start usable before a content pack is imported", async () => {
    backend.getRuntimeCapabilities.mockResolvedValue({ learning: { available: true, contentPackReady: false } });
    learning.getLearningHome.mockResolvedValue({ activeSession: null, capabilities: { contentPackReady: false } });
    await remount();
    const button = container.querySelector<HTMLButtonElement>(".pet-learning-quick-start");
    expect(button).not.toBeNull();
    await act(async () => button!.click()); await flush();
    expect(backend.showTaskPanel).toHaveBeenCalledWith("learning");
  });

  it("restores an existing learning session after runtime capability confirmation", async () => {
    learning.getLearningHome.mockResolvedValue({ activeSession: { ...session, status: "active" } });
    await remount();
    await emit("pet-activity-snapshot-updated", activity("learning", 2));
    expect(container.querySelector('[data-testid="learning"]')?.getAttribute("data-session")).toBe(session.sessionId);
  });

  it.each(["off", "system"] as const)("keeps the completed board intact on animation mode %s", async (mode) => {
    await enterLearning();
    const board = container.querySelector('[data-testid="learning"]');
    resetNativeGeometry();
    await emit("settings-updated", { ...settings, animationMode: mode });
    expect(native.setSize).toHaveBeenLastCalledWith(expect.objectContaining({
      width: LEARNING_STAGE_WIDTH, height: LEARNING_STAGE_HEIGHT,
    }));
    expect(native.setIgnoreCursorEvents).toHaveBeenLastCalledWith(false);
    expect(native.setFocus).not.toHaveBeenCalled();
    expect(container.querySelector('[data-testid="learning"]')).toBe(board);
    expect(native.mounts).toHaveBeenCalledTimes(1);
    expect(container.querySelector("input")?.value).toBe("answer retained");
  });

  it.each(["reminding", "focusing", "idle"] as const)("restores a completed board after temporary %s without another session event", async (overlay) => {
    await enterLearning();
    await emit("pet-activity-snapshot-updated", {
      ...activity(overlay, 3), restoreTarget: "learning",
      resumableLearningSessionId: session.sessionId,
    });
    expect(container.querySelector('[data-testid="learning"]')).toBeNull();
    await emit("pet-activity-snapshot-updated", activity("learning", 4));
    expect(container.querySelector('[data-testid="learning"]')?.getAttribute("data-session")).toBe(session.sessionId);
    // An old overlay must not hide the restored result again.
    await emit("pet-activity-snapshot-updated", activity(overlay, 3));
    expect(container.querySelector('[data-testid="learning"]')).not.toBeNull();
  });

  it.each(["active", "completed"] as const)("does not resurrect a %s session after a real interruption", async (status) => {
    await emit("pet-activity-snapshot-updated", activity("learning", 2));
    await emit("learning-session-updated", { ...session, status });
    await emit("pet-activity-snapshot-updated", {
      ...activity("reminding", 3), restoreTarget: "learning",
      resumableLearningSessionId: session.sessionId,
    });
    await emit("learning-session-interrupted", { session: { ...session, status: "paused" } });
    await emit("pet-activity-snapshot-updated", activity("learning", 4));
    expect(container.querySelector('[data-testid="learning"]')).toBeNull();
  });

  it.each(["sleeping", "idle"] as const)("discards a completed board when %s has no matching restore session", async (next) => {
    await enterLearning();
    await emit("pet-activity-snapshot-updated", activity(next, 3));
    await emit("pet-activity-snapshot-updated", activity("learning", 4));
    expect(container.querySelector('[data-testid="learning"]')).toBeNull();
  });

  it("reasserts the current stage even when the saved settings have identical values", async () => {
    await enterLearning(); resetNativeGeometry();
    await emit("settings-updated", structuredClone(settings));
    expect(native.setSize).toHaveBeenLastCalledWith(expect.objectContaining({ width: 520, height: 420 }));
    expect(native.setFocus).not.toHaveBeenCalled();
  });

  it("restores the latest compact size after a width update during learning", async () => {
    await enterLearning(); resetNativeGeometry();
    await emit("settings-updated", { ...settings, petWidth: 240 });
    expect(native.setSize).toHaveBeenLastCalledWith(expect.objectContaining({ width: 520, height: 420 }));
    await act(async () => container.querySelector<HTMLButtonElement>("button")!.click());
    await flush();
    expect(native.setSize).toHaveBeenLastCalledWith(expect.objectContaining({ width: 268, height: 288 }));
  });

  it("keeps a reminder expanded and clickable after a settings update", async () => {
    backend.listToday.mockResolvedValue({ reminders: [], occurrences: [{ id: "due-1",
      reminderId: "reminder-1", reminderTitle: "original body", category: "work",
      scheduledAt: new Date().toISOString(), status: "pending", actedAt: null,
      snoozedUntil: null, resolutionReason: null }], waterCompleted: 0, waterGoal: 9,
      notificationAvailable: true });
    await emit("pet-activity-snapshot-updated", activity("reminding", 2));
    await emit("pet-intent", { id: "due-1", kind: "reminder", priority: 100,
      animation: "alert-glass-paws", route: "today", title: "test", message: "original body",
      occurrenceId: "due-1", persistent: true, expiresAt: null });
    resetNativeGeometry();
    await emit("settings-updated", { ...settings, clickThrough: true, animationMode: "off" });
    expect(native.setSize).toHaveBeenLastCalledWith(expect.objectContaining({
      width: ALERT_STAGE_WIDTH, height: ALERT_STAGE_HEIGHT,
    }));
    expect(native.setIgnoreCursorEvents).toHaveBeenLastCalledWith(false);
    expect(container.textContent).toContain("original body");
  });

  it("does not open an expanded stage for ordinary idle settings updates", async () => {
    resetNativeGeometry();
    await emit("settings-updated", { ...settings, animationMode: "off" });
    expect(native.setSize).not.toHaveBeenCalled();
    expect(native.setFocus).not.toHaveBeenCalled();
  });

  it.each([1, 1.25, 1.5])("keeps the supported warmup card and native stage aligned at scale %s", async (scale) => {
    native.scaleFactor.mockResolvedValue(scale);
    const warmup = { ...await backend.getCompanionExpressionSnapshot(), revision: 2,
      tier: "n2", intent: "needs_attention", pose: "approach", props: ["task_card"],
      label: "time_to_move", sceneAppearance: { kind: "warmup" } };
    backend.getCompanionExpressionSnapshot.mockResolvedValue(warmup);
    await emit("companion-expression", warmup);
    backend.listToday.mockResolvedValue({ reminders: [], occurrences: [{ id: "move-1",
      reminderId: "system-activity-reminder", reminderTitle: "活动一下", category: "personal",
      scheduledAt: new Date().toISOString(), status: "pending", actedAt: null,
      snoozedUntil: null, resolutionReason: null }], waterCompleted: 0, waterGoal: 9,
      notificationAvailable: true });
    await emit("pet-activity-snapshot-updated", activity("reminding", 2));
    await emit("pet-intent", { id: "move-1", kind: "activity", priority: 90,
      animation: "activity-jumping", route: "care", title: "活动一下", message: "伸展一下",
      occurrenceId: "move-1", persistent: true, expiresAt: null });
    for (const petWidth of [120, 192, 256, 320]) {
      await emit("settings-updated", { ...settings, petWidth });
      const layout = warmupStageLayout(petWidth);
      expect(native.setSize).toHaveBeenLastCalledWith(expect.objectContaining({ width: layout.width, height: layout.height }));
      expect(native.setPosition).toHaveBeenLastCalledWith(expect.objectContaining({
        x: 320 - Math.round(layout.width * scale), y: 336 - Math.round(layout.height * scale),
      }));
      const region = container.querySelector<HTMLElement>(".supported-warmup")!;
      expect(region.style.width).toBe(`${layout.width}px`);
      expect(region.style.height).toBe(`${layout.height}px`);
      expect(region.style.getPropertyValue("--alert-pet-width")).toBe(`${layout.spriteWidth}px`);
    }
    await emit("settings-updated", { ...settings, animationMode: "off" });
    expect(container.querySelector(".supported-warmup.pet-motion-reduced")).not.toBeNull();
  });

  it.each([1, 1.25, 1.5])("waits for a pending native drag before persisting at scale %s", async (scale) => {
    const pointer = dragPointer();
    let position = { x: 100, y: 100 };
    let completeMove!: () => void;
    native.scaleFactor.mockResolvedValue(scale);
    native.outerPosition.mockImplementation(async () => position);
    native.setPosition.mockImplementation((next: { x: number; y: number }) =>
      new Promise<void>((resolve) => {
        completeMove = () => { position = { x: next.x, y: next.y }; resolve(); };
      }),
    );
    native.invoke.mockClear();
    await pointer("pointerdown", 150, 150);
    await pointer("pointermove", 350, 450);
    const expected = { x: 100 + 200 * scale, y: 100 + 300 * scale };
    expect(native.setPosition).toHaveBeenCalledWith(expect.objectContaining(expected));
    await pointer("pointerup", 350, 450);
    expect(native.invoke).not.toHaveBeenCalledWith("save_pet_position", expect.anything());
    await act(async () => completeMove()); await flush();
    expect(native.invoke).toHaveBeenCalledWith("save_pet_position", expected);
    expect(backend.showTaskPanel).not.toHaveBeenCalled();
  });

  it("serializes rapid move requests and persists only after the last acknowledgement", async () => {
    const pointer = dragPointer();
    let position = { x: 100, y: 100 };
    const completeMoves: Array<() => void> = [];
    native.outerPosition.mockImplementation(async () => position);
    native.setPosition.mockImplementation((next: { x: number; y: number }) =>
      new Promise<void>((resolve) => {
        completeMoves.push(() => { position = { x: next.x, y: next.y }; resolve(); });
      }),
    );
    native.invoke.mockClear(); native.setPosition.mockClear();
    await pointer("pointerdown", 150, 150);
    await pointer("pointermove", 200, 250);
    await pointer("pointermove", 250, 350);
    await pointer("pointerup", 250, 350);
    expect(native.setPosition).toHaveBeenCalledTimes(1);
    expect(native.invoke).not.toHaveBeenCalled();
    await act(async () => completeMoves[0]()); await flush();
    expect(native.setPosition).toHaveBeenCalledTimes(2);
    expect(native.invoke).not.toHaveBeenCalled();
    await act(async () => completeMoves[1]()); await flush();
    expect(native.invoke).toHaveBeenCalledExactlyOnceWith("save_pet_position", { x: 200, y: 300 });
  });

  it("starts a successive drag from the previously acknowledged and saved position", async () => {
    const pointer = dragPointer();
    let position = { x: 100, y: 100 };
    let completeMove!: () => void;
    native.outerPosition.mockImplementation(async () => position);
    native.setPosition.mockImplementationOnce((next: { x: number; y: number }) =>
      new Promise<void>((resolve) => {
        completeMove = () => { position = { x: next.x, y: next.y }; resolve(); };
      }),
    );
    native.setPosition.mockImplementation(async (next: { x: number; y: number }) => {
      position = { x: next.x, y: next.y };
    });
    native.invoke.mockClear(); native.outerPosition.mockClear();
    await pointer("pointerdown", 150, 150);
    await pointer("pointermove", 350, 450);
    await pointer("pointerup", 350, 450);
    await pointer("pointerdown", 350, 450);
    expect(native.outerPosition).toHaveBeenCalledTimes(1);
    await act(async () => completeMove()); await flush();
    await pointer("pointermove", 450, 550);
    await pointer("pointerup", 450, 550);
    expect(native.invoke.mock.calls).toEqual([
      ["save_pet_position", { x: 300, y: 400 }],
      ["save_pet_position", { x: 400, y: 500 }],
    ]);
  });

  it("does not overwrite the saved position when native movement fails and allows the next drag", async () => {
    const pointer = dragPointer();
    native.setPosition.mockRejectedValueOnce(new Error("native position unavailable"));
    native.invoke.mockClear();
    await pointer("pointerdown", 150, 150);
    await pointer("pointermove", 350, 450);
    await pointer("pointerup", 350, 450);
    expect(native.invoke).not.toHaveBeenCalled();
    await pointer("pointerdown", 150, 150);
    await pointer("pointermove", 250, 250);
    native.outerPosition.mockResolvedValue({ x: 200, y: 200 });
    await pointer("pointerup", 250, 250);
    expect(native.invoke).toHaveBeenCalledExactlyOnceWith("save_pet_position", { x: 200, y: 200 });
  });

  it.each(["pointerup", "pointercancel"])("invalidates pending drag geometry on early %s", async (end) => {
    const pointer = dragPointer();
    let finishGeometry!: (value: { x: number; y: number }) => void;
    native.outerPosition.mockImplementationOnce(() => new Promise((resolve) => { finishGeometry = resolve; }));
    native.invoke.mockClear(); native.setPosition.mockClear();
    await pointer("pointerdown", 150, 150);
    await pointer(end, 150, 150);
    await act(async () => finishGeometry({ x: 100, y: 100 })); await flush();
    await pointer("pointermove", 350, 450);
    expect(native.setPosition).not.toHaveBeenCalled();
    expect(native.invoke).not.toHaveBeenCalled();
    expect(backend.showTaskPanel).toHaveBeenCalledTimes(end === "pointerup" ? 1 : 0);
  });

  it.each([1, 1.25, 1.5])("retains a fast drag released before geometry resolves at scale %s", async (scale) => {
    const pointer = dragPointer();
    let finishGeometry!: (value: { x: number; y: number }) => void;
    let position = { x: 100, y: 100 };
    native.scaleFactor.mockResolvedValue(scale);
    native.outerPosition.mockImplementation(async () => position);
    native.outerPosition.mockImplementationOnce(() => new Promise((resolve) => { finishGeometry = resolve; }));
    native.setPosition.mockImplementation(async (next: { x: number; y: number }) => {
      position = { x: next.x, y: next.y };
    });
    native.invoke.mockClear(); native.setPosition.mockClear();
    await pointer("pointerdown", 150, 150);
    await pointer("pointermove", 350, 450);
    await pointer("pointerup", 350, 450);
    expect(native.setPosition).not.toHaveBeenCalled();
    await act(async () => finishGeometry({ x: 100, y: 100 })); await flush();
    const expected = { x: 100 + 200 * scale, y: 100 + 300 * scale };
    expect(native.setPosition).toHaveBeenCalledExactlyOnceWith(expect.objectContaining(expected));
    expect(native.invoke).toHaveBeenCalledExactlyOnceWith("save_pet_position", expected);
    expect(backend.showTaskPanel).not.toHaveBeenCalled();
  });

  it("uses the release coordinates when no pointermove was delivered", async () => {
    const pointer = dragPointer();
    let position = { x: 100, y: 100 };
    native.outerPosition.mockImplementation(async () => position);
    native.setPosition.mockImplementation(async (next: { x: number; y: number }) => {
      position = { x: next.x, y: next.y };
    });
    native.invoke.mockClear(); native.setPosition.mockClear();
    await pointer("pointerdown", 150, 150);
    await pointer("pointerup", 350, 450);
    expect(native.invoke).toHaveBeenCalledExactlyOnceWith("save_pet_position", { x: 300, y: 400 });
    expect(backend.showTaskPanel).not.toHaveBeenCalled();
  });

  it("retains movement while only the scale lookup is pending", async () => {
    const pointer = dragPointer();
    let finishScale!: (value: number) => void;
    let position = { x: 100, y: 100 };
    native.scaleFactor.mockImplementationOnce(() => new Promise((resolve) => { finishScale = resolve; }));
    native.outerPosition.mockImplementation(async () => position);
    native.setPosition.mockImplementation(async (next: { x: number; y: number }) => {
      position = { x: next.x, y: next.y };
    });
    native.invoke.mockClear(); native.setPosition.mockClear();
    await pointer("pointerdown", 150, 150);
    await pointer("pointermove", 250, 250);
    await pointer("pointerup", 350, 450);
    expect(native.setPosition).not.toHaveBeenCalled();
    await act(async () => finishScale(1.25)); await flush();
    expect(native.setPosition.mock.calls.map(([value]) => ({ x: value.x, y: value.y }))).toEqual([
      { x: 225, y: 225 }, { x: 350, y: 475 },
    ]);
    expect(native.invoke).toHaveBeenCalledExactlyOnceWith("save_pet_position", { x: 350, y: 475 });
    expect(backend.showTaskPanel).not.toHaveBeenCalled();
  });

  it("retains two completed fast drags while the first origin is still pending", async () => {
    const pointer = dragPointer();
    let finishGeometry!: (value: { x: number; y: number }) => void;
    let position = { x: 100, y: 100 };
    native.outerPosition.mockImplementation(async () => position);
    native.outerPosition.mockImplementationOnce(() => new Promise((resolve) => { finishGeometry = resolve; }));
    native.setPosition.mockImplementation(async (next: { x: number; y: number }) => {
      position = { x: next.x, y: next.y };
    });
    native.invoke.mockClear(); native.outerPosition.mockClear();
    await pointer("pointerdown", 150, 150);
    await pointer("pointermove", 350, 450);
    await pointer("pointerup", 350, 450);
    await pointer("pointerdown", 350, 450);
    await pointer("pointermove", 450, 550);
    await pointer("pointerup", 450, 550);
    expect(native.outerPosition).toHaveBeenCalledTimes(1);
    await act(async () => finishGeometry({ x: 100, y: 100 })); await flush();
    expect(native.invoke.mock.calls).toEqual([
      ["save_pet_position", { x: 300, y: 400 }],
      ["save_pet_position", { x: 400, y: 500 }],
    ]);
    expect(backend.showTaskPanel).not.toHaveBeenCalled();
  });

  it("discards a cancelled fast drag before geometry resolves", async () => {
    const pointer = dragPointer();
    let finishGeometry!: (value: { x: number; y: number }) => void;
    native.outerPosition.mockImplementationOnce(() => new Promise((resolve) => { finishGeometry = resolve; }));
    native.invoke.mockClear(); native.setPosition.mockClear();
    await pointer("pointerdown", 150, 150);
    await pointer("pointermove", 350, 450);
    await pointer("pointercancel", 350, 450);
    await act(async () => finishGeometry({ x: 100, y: 100 })); await flush();
    expect(native.setPosition).not.toHaveBeenCalled();
    expect(native.invoke).not.toHaveBeenCalled();
    expect(backend.showTaskPanel).not.toHaveBeenCalled();
  });

  it("cancels queued moves but saves the actual acknowledged position after pointer cancellation", async () => {
    const pointer = dragPointer();
    let completeMove!: () => void;
    let position = { x: 100, y: 100 };
    native.outerPosition.mockImplementation(async () => position);
    native.setPosition.mockImplementationOnce((next: { x: number; y: number }) => new Promise<void>((resolve) => {
      completeMove = () => { position = { x: next.x, y: next.y }; resolve(); };
    }));
    native.invoke.mockClear(); native.setPosition.mockClear();
    await pointer("pointerdown", 150, 150);
    await pointer("pointermove", 250, 250);
    await pointer("pointermove", 350, 450);
    await pointer("pointercancel", 350, 450);
    await act(async () => completeMove()); await flush();
    expect(native.setPosition).toHaveBeenCalledTimes(1);
    expect(native.invoke).toHaveBeenCalledExactlyOnceWith("save_pet_position", { x: 200, y: 200 });
    expect(backend.showTaskPanel).not.toHaveBeenCalled();
  });

  it.each(["geometry", "movement", "persistence"])("invalidates late drag callbacks on unmount during %s", async (phase) => {
    const pointer = dragPointer();
    let finish!: () => void;
    let position = { x: 100, y: 100 };
    native.outerPosition.mockImplementation(async () => position);
    native.setPosition.mockImplementation(async (next: { x: number; y: number }) => {
      position = { x: next.x, y: next.y };
    });
    if (phase === "geometry") {
      native.outerPosition.mockImplementationOnce(() => new Promise((resolve) => {
        finish = () => resolve(position);
      }));
    } else if (phase === "movement") {
      native.setPosition.mockImplementationOnce((next: { x: number; y: number }) => new Promise<void>((resolve) => {
        finish = () => { position = { x: next.x, y: next.y }; resolve(); };
      }));
    }
    native.invoke.mockClear(); native.setPosition.mockClear();
    await pointer("pointerdown", 150, 150);
    await pointer("pointermove", 350, 450);
    if (phase === "persistence") {
      native.outerPosition.mockImplementationOnce(() => new Promise((resolve) => {
        finish = () => resolve(position);
      }));
    }
    await pointer("pointerup", 350, 450);
    await act(async () => root.render(null));
    await act(async () => finish()); await flush();
    expect(native.setPosition).toHaveBeenCalledTimes(phase === "geometry" ? 0 : 1);
    expect(native.invoke).not.toHaveBeenCalled();
    expect(backend.showTaskPanel).not.toHaveBeenCalled();
  });

  it.each(["outerPosition", "scaleFactor"] as const)("recovers after a delayed %s failure without turning the drag into a click", async (lookup) => {
    const pointer = dragPointer();
    let fail!: (error: Error) => void;
    native[lookup].mockImplementationOnce(() => new Promise((_, reject) => { fail = reject; }));
    native.invoke.mockClear(); native.setPosition.mockClear();
    await pointer("pointerdown", 150, 150);
    await pointer("pointermove", 350, 450);
    await pointer("pointerup", 350, 450);
    await act(async () => fail(new Error("geometry unavailable"))); await flush();
    expect(native.setPosition).not.toHaveBeenCalled();
    expect(native.invoke).not.toHaveBeenCalled();
    expect(backend.showTaskPanel).not.toHaveBeenCalled();
    await pointer("pointerdown", 150, 150);
    await pointer("pointermove", 250, 250);
    native.outerPosition.mockResolvedValue({ x: 200, y: 200 });
    await pointer("pointerup", 250, 250);
    expect(native.invoke).toHaveBeenCalledExactlyOnceWith("save_pet_position", { x: 200, y: 200 });
  });

  it.each([false, true])("keeps sub-threshold jitter as one click with delayed geometry %s", async (delayed) => {
    const pointer = dragPointer();
    let finishGeometry: (() => void) | undefined;
    if (delayed) native.outerPosition.mockImplementationOnce(() => new Promise((resolve) => {
      finishGeometry = () => resolve({ x: 100, y: 100 });
    }));
    native.invoke.mockClear(); native.setPosition.mockClear();
    await pointer("pointerdown", 150, 150);
    await pointer("pointermove", 151, 152);
    await pointer("pointerup", 152, 151);
    await act(async () => finishGeometry?.()); await flush();
    expect(native.setPosition).not.toHaveBeenCalled();
    expect(native.invoke).not.toHaveBeenCalled();
    expect(backend.showTaskPanel).toHaveBeenCalledExactlyOnceWith("today");
  });

  it.each([1.25, 1.5])("restores compact physical bounds at scale %s without resizing the logical board", async (scale) => {
    native.scaleFactor.mockResolvedValue(scale);
    await enterLearning(); resetNativeGeometry();
    await emit("settings-updated", { ...settings, petWidth: 240 });
    expect(native.setSize).toHaveBeenLastCalledWith(expect.objectContaining({ width: 520, height: 420 }));
    await act(async () => container.querySelector<HTMLButtonElement>("button")!.click());
    await flush();
    expect(native.setSize).toHaveBeenLastCalledWith(expect.objectContaining({
      width: Math.round(268 * scale), height: Math.round(288 * scale),
    }));
  });

  it("keeps the current toy and its expanded stage when animation is disabled", async () => {
    await emit("pet-activity-snapshot-updated", activity("idle", 2));
    await emit("pet-interaction-started", { id: "wand-1", kind: "wand", leaseRevision: 3, expiresAtUnixMs: Date.now() + 30_000 });
    const playfield = container.querySelector(".tool-interaction-stage");
    expect(playfield).not.toBeNull(); resetNativeGeometry();
    await emit("settings-updated", { ...settings, animationMode: "off" });
    expect(native.setSize).toHaveBeenLastCalledWith(expect.objectContaining({
      width: interactionWindowWidth(settings.petWidth), height: 236,
    }));
    expect(container.querySelector(".tool-interaction-stage")).toBe(playfield);
    expect(native.setFocus).not.toHaveBeenCalled();
  });

  it("invalidates a slow settings resize when the learning stage closes", async () => {
    await enterLearning(); resetNativeGeometry();
    let finishMonitor!: (value: null) => void;
    native.monitor.mockImplementationOnce(() => new Promise((resolve) => { finishMonitor = resolve; }));
    await emit("settings-updated", { ...settings, animationMode: "off" });
    await emit("learning-session-interrupted", {});
    expect(native.setSize).toHaveBeenLastCalledWith(expect.objectContaining({ width: 220, height: 236 }));
    const writes = native.setSize.mock.calls.length;
    await act(async () => finishMonitor(null)); await flush();
    expect(native.setSize).toHaveBeenCalledTimes(writes);
    expect(native.setFocus).not.toHaveBeenCalled();
  });

  it("focuses a newly started learning session, but not a session revision update", async () => {
    await enterLearning(); resetNativeGeometry();
    await emit("learning-session-updated", { ...session, stateRevision: 6 });
    expect(native.setFocus).not.toHaveBeenCalled();
    await emit("learning-session-updated", { ...session, sessionId: "session-2", status: "active" });
    expect(native.setFocus).toHaveBeenCalledTimes(1);
  });
});
