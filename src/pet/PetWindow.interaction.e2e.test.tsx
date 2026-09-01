// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type {
  AppSettings,
  CompanionExpressionSnapshot,
  PetActivitySnapshot,
  TodaySnapshot,
} from "../types";

const backend = vi.hoisted(() => ({
  completeOccurrence: vi.fn(),
  getBasicSupportState: vi.fn(),
  getCompanionExpressionSnapshot: vi.fn(),
  getFocusState: vi.fn(),
  getPetActivitySnapshot: vi.fn(),
  getSettings: vi.fn(),
  listToday: vi.fn(),
  onBackendEvent: vi.fn(),
  setPetSize: vi.fn(),
  showTaskPanel: vi.fn(),
  skipOccurrence: vi.fn(),
  snoozeOccurrence: vi.fn(),
  tauriAvailable: vi.fn(() => false),
}));

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
    lookFrame,
    frameOverride,
    mirrored,
    offsetX,
    onComplete,
  }: {
    animation: string;
    lookFrame?: number | null;
    frameOverride?: number | null;
    mirrored?: boolean;
    offsetX?: number;
    onComplete?: (animation: string) => void;
  }) => (
    <button
      className="sprite-animator"
      type="button"
      data-animation={animation}
      data-look-frame={lookFrame ?? ""}
      data-frame-override={frameOverride ?? ""}
      data-mirrored={mirrored ? "true" : "false"}
      data-offset-x={offsetX ?? 0}
      onClick={() => onComplete?.(animation)}
    />
  ),
}));
vi.mock("./CompanionPropStage", () => ({
  CompanionPropStage: () => <div data-testid="companion-prop" />,
}));

import { PetWindow } from "./PetWindow";

const settings: AppSettings = {
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

const expression: CompanionExpressionSnapshot = {
  schemaVersion: 1,
  revision: 1,
  tier: "n0",
  intent: "quiet_presence",
  pose: "idle",
  props: [],
  label: null,
  attention: "silent",
  motion: "full",
  movePropForward: false,
  queueInBasket: false,
  taskSource: null,
  groupedCount: 0,
  focusDeferredCount: 0,
  accessibleState: "quiet_presence",
};

const activity: PetActivitySnapshot = {
  revision: 1,
  activity: "idle",
  source: "manual",
  leaseId: null,
  resumableLearningSessionId: null,
  restoreTarget: null,
};

const today: TodaySnapshot = {
  reminders: [],
  occurrences: [],
  waterCompleted: 0,
  waterGoal: 9,
  notificationAvailable: true,
};

describe("PetWindow interaction bubble E2E", () => {
  let container: HTMLDivElement;
  let root: Root;
  let handlers: Map<string, (payload: unknown) => void>;

  const flush = async () => {
    await act(async () => {
      await new Promise((resolve) => window.setTimeout(resolve, 0));
    });
  };

  const startInteraction = async (id: string, kind: string) => {
    await act(async () =>
      handlers.get("pet-interaction-started")?.({ id, kind }),
    );
    await flush();
    return container.querySelector<HTMLElement>(
      '[data-information-surface="tool"]',
    );
  };

  const setInteractionBounds = () => {
    const stage = container.querySelector<HTMLElement>(
      "[data-animation-stage='true']",
    );
    if (!stage) throw new Error("interaction stage missing");
    stage.getBoundingClientRect = () =>
      ({
        x: 0,
        y: 0,
        left: 0,
        top: 0,
        right: 192,
        bottom: 208,
        width: 192,
        height: 208,
        toJSON: () => ({}),
      }) as DOMRect;
  };

  const dispatchPointer = async (
    target: Element,
    type: string,
    clientX: number,
    clientY: number,
    eventTime?: number,
  ) => {
    const event = new MouseEvent(type, {
      bubbles: true,
      button: 0,
      clientX,
      clientY,
    });
    Object.defineProperty(event, "pointerId", { value: 7 });
    if (eventTime !== undefined) {
      Object.defineProperty(event, "timeStamp", { value: eventTime });
    }
    await act(async () => target.dispatchEvent(event));
    await flush();
  };

  beforeEach(async () => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    Object.defineProperty(window, "matchMedia", {
      configurable: true,
      value: vi.fn(() => ({ matches: false })),
    });
    Object.defineProperties(HTMLElement.prototype, {
      setPointerCapture: {
        configurable: true,
        value: vi.fn(),
      },
      hasPointerCapture: {
        configurable: true,
        value: vi.fn(() => true),
      },
      releasePointerCapture: {
        configurable: true,
        value: vi.fn(),
      },
    });
    handlers = new Map();
    backend.getSettings.mockResolvedValue(structuredClone(settings));
    backend.getFocusState.mockResolvedValue({ session: null });
    backend.listToday.mockResolvedValue(structuredClone(today));
    backend.getCompanionExpressionSnapshot.mockResolvedValue(
      structuredClone(expression),
    );
    backend.getPetActivitySnapshot.mockResolvedValue(structuredClone(activity));
    backend.getBasicSupportState.mockResolvedValue(null);
    backend.snoozeOccurrence.mockResolvedValue(undefined);
    backend.tauriAvailable.mockReturnValue(false);
    backend.onBackendEvent.mockImplementation(
      async (event: string, handler: (payload: unknown) => void) => {
        handlers.set(event, handler);
        return () => handlers.delete(event);
      },
    );
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    await act(async () => root.render(<PetWindow />));
    await flush();
    await flush();
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    vi.clearAllMocks();
  });

  it("immediately follows the persisted course shortcut visibility setting", async () => {
    const quickStart = () =>
      container.querySelector<HTMLButtonElement>(
        'button[aria-label="不用打开菜单，直接开始英语复习"]',
      );

    expect(quickStart()).not.toBeNull();

    await act(async () => {
      handlers.get("settings-updated")?.({
        ...settings,
        learningQuickStartVisible: false,
      });
    });
    expect(quickStart()).toBeNull();

    await act(async () => {
      handlers.get("settings-updated")?.({
        ...settings,
        learningQuickStartVisible: true,
      });
    });
    expect(quickStart()).not.toBeNull();
  });

  it("keeps every interaction hint outside the animation stage while replacing controls", async () => {
    let card = await startInteraction("treat-1", "treat");
    let hitRegion = container.querySelector<HTMLElement>(".pet-hit-region");
    let animationStage = container.querySelector<HTMLElement>(
      "[data-animation-stage='true']",
    );
    expect(card?.classList.contains("tool-card")).toBe(true);
    expect(card?.classList.contains("card-left")).toBe(true);
    expect(hitRegion?.dataset.interactionLayout).toBe("separate-lane");
    expect(hitRegion?.style.width).toBe("372px");
    expect(card?.parentElement).toBe(hitRegion);
    expect(animationStage?.parentElement).toBe(hitRegion);
    expect(animationStage?.contains(card ?? null)).toBe(false);
    expect(animationStage?.querySelector(".pet-tool-treat")).not.toBeNull();

    card = await startInteraction("wand-1", "wand");
    expect(card?.classList.contains("tool-card")).toBe(true);
    expect(container.querySelector(".pet-tool-treat")).toBeNull();
    expect(container.querySelector(".pet-tool-wand")).not.toBeNull();

    card = await startInteraction("pet-1", "pet");
    expect(card?.classList.contains("card-left")).toBe(true);
    expect(container.querySelector(".pet-tool")).toBeNull();
    expect(container.querySelector(".pet-head-zone")).not.toBeNull();

    card = await startInteraction("ball-1", "ball");
    hitRegion = container.querySelector<HTMLElement>(".pet-hit-region");
    animationStage = container.querySelector<HTMLElement>(
      "[data-animation-stage='true']",
    );
    expect(card?.classList.contains("tool-card")).toBe(true);
    expect(card?.classList.contains("ball-card")).toBe(true);
    expect(card?.classList.contains("card-left")).toBe(true);
    expect(hitRegion?.style.width).toBe("500px");
    expect(container.querySelector(".pet-head-zone")).toBeNull();
    expect(animationStage?.querySelector(".pet-tool-ball")).not.toBeNull();
  });

  it("matches the original Yuanyuan treat height, mirror, and lean behavior", async () => {
    await startInteraction("treat-original", "treat");
    setInteractionBounds();
    const tool = container.querySelector<HTMLButtonElement>(".pet-tool-treat");
    expect(tool).not.toBeNull();
    if (!tool) return;

    await dispatchPointer(tool, "pointerdown", 170, 196);
    let sprite = container.querySelector<HTMLElement>(".sprite-animator");
    expect(sprite?.dataset.animation).toBe("treat-follow");
    expect(sprite?.dataset.lookFrame).toBe("");
    expect(sprite?.dataset.frameOverride).toBe("0");
    expect(sprite?.dataset.mirrored).toBe("false");
    expect(sprite?.dataset.offsetX).toBe("13");

    await dispatchPointer(tool, "pointermove", 22, 12);
    sprite = container.querySelector<HTMLElement>(".sprite-animator");
    expect(sprite?.dataset.lookFrame).toBe("");
    expect(sprite?.dataset.frameOverride).toBe("7");
    expect(sprite?.dataset.mirrored).toBe("true");
    expect(sprite?.dataset.offsetX).toBe("-13");
    expect(tool.style.left).toBe("22px");
    expect(tool.style.top).toBe("12px");
  });

  it("matches the original Yuanyuan pointer-driven wand row", async () => {
    await startInteraction("wand-original", "wand");
    setInteractionBounds();
    const tool = container.querySelector<HTMLButtonElement>(".pet-tool-wand");
    expect(tool).not.toBeNull();
    if (!tool) return;

    let sprite = container.querySelector<HTMLButtonElement>(".sprite-animator");
    expect(sprite?.dataset.animation).toBe("idle");
    expect(sprite?.dataset.frameOverride).toBe("");

    await dispatchPointer(tool, "pointerdown", 138, 48, 0);
    sprite = container.querySelector<HTMLButtonElement>(".sprite-animator");
    expect(sprite?.dataset.animation).toBe("wand-play");
    expect(sprite?.dataset.frameOverride).toBe("0");
    expect(sprite?.dataset.mirrored).toBe("false");
    expect(sprite?.dataset.offsetX).toBe("0");

    await dispatchPointer(tool, "pointermove", 134, 48, 30);
    sprite = container.querySelector<HTMLButtonElement>(".sprite-animator");
    expect(sprite?.dataset.frameOverride).toBe("0");

    await dispatchPointer(tool, "pointermove", 126, 48, 90);
    sprite = container.querySelector<HTMLButtonElement>(".sprite-animator");
    expect(sprite?.dataset.frameOverride).toBe("1");

    await dispatchPointer(tool, "pointermove", 90, 48, 100);
    sprite = container.querySelector<HTMLButtonElement>(".sprite-animator");
    expect(sprite?.dataset.frameOverride).toBe("1");

    await dispatchPointer(tool, "pointermove", 90, 48, 180);
    sprite = container.querySelector<HTMLButtonElement>(".sprite-animator");
    expect(sprite?.dataset.frameOverride).toBe("3");

    await dispatchPointer(tool, "pointermove", 90, 48, 190);
    sprite = container.querySelector<HTMLButtonElement>(".sprite-animator");
    expect(sprite?.dataset.frameOverride).toBe("3");

    await dispatchPointer(tool, "pointermove", 22, 48, 270);
    sprite = container.querySelector<HTMLButtonElement>(".sprite-animator");
    expect(sprite?.dataset.frameOverride).toBe("5");
    expect(sprite?.dataset.mirrored).toBe("true");

    await dispatchPointer(tool, "pointerup", 22, 48, 280);
    sprite = container.querySelector<HTMLButtonElement>(".sprite-animator");
    expect(sprite?.dataset.animation).toBe("idle");
    expect(sprite?.dataset.frameOverride).toBe("");
    expect(sprite?.dataset.mirrored).toBe("false");
  });

  it("exposes every snooze level and sends the selected duration from a strong reminder", async () => {
    backend.tauriAvailable.mockReturnValue(true);
    backend.snoozeOccurrence.mockImplementation(async () => {
      handlers.get("pet-activity-snapshot-updated")?.({
        ...activity,
        revision: 3,
      });
    });
    await act(async () => {
      handlers.get("pet-activity-snapshot-updated")?.({
        ...activity,
        revision: 2,
        activity: "reminding",
        source: "reminder",
      });
      handlers.get("pet-intent")?.({
        id: "intent-snooze",
        kind: "reminder",
        priority: 120,
        animation: "jumping",
        route: "today",
        title: "测试提醒",
        message: "现在处理",
        occurrenceId: "occurrence-snooze",
        persistent: true,
        expiresAt: null,
      });
    });
    await flush();

    const select = container.querySelector<HTMLSelectElement>(
      'select[aria-label="稍后提醒时长，可选 5、10、30、60 分钟"]',
    );
    expect(select).not.toBeNull();
    expect(Array.from(select?.options ?? []).map((option) => Number(option.value))).toEqual([
      5, 10, 30, 60,
    ]);

    await act(async () => {
      if (!select) return;
      select.value = "30";
      select.dispatchEvent(new Event("change", { bubbles: true }));
    });
    const snooze = Array.from(container.querySelectorAll("button"))
      .find((button) => button.textContent?.trim() === "稍后");
    await act(async () => snooze?.click());
    await flush();
    expect(backend.snoozeOccurrence).toHaveBeenCalledWith("occurrence-snooze", 30);
    expect(
      container.querySelector(
        '[role="status"][aria-label="提醒已延后；饺饺安静等候"]',
      ),
    ).not.toBeNull();
  });
});
