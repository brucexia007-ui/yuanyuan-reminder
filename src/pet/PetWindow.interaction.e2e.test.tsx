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
  SpriteAnimator: ({ animation }: { animation: string }) => (
    <div className="sprite-animator" data-animation={animation} />
  ),
}));
vi.mock("./CompanionPropStage", () => ({
  CompanionPropStage: () => <div data-testid="companion-prop" />,
}));

import { PetWindow } from "./PetWindow";

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

const expression: CompanionExpressionSnapshot = {
  schemaVersion: 2,
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
  sceneAppearance: { kind: "none" },
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
  let interactionRevision: number;

  const flush = async () => {
    await act(async () => {
      await new Promise((resolve) => window.setTimeout(resolve, 0));
    });
  };

  const startInteraction = async (id: string, kind: string) => {
    await act(async () =>
      handlers.get("pet-interaction-started")?.({ id, kind, leaseRevision: ++interactionRevision, expiresAtUnixMs: Date.now() + 30_000 }),
    );
    await flush();
    return container.querySelector<HTMLElement>(
      '[data-information-surface="tool"]',
    );
  };

  beforeEach(async () => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    Object.defineProperty(window, "matchMedia", {
      configurable: true,
      value: vi.fn(() => ({ matches: false })),
    });
    handlers = new Map();
    interactionRevision = 1;
    backend.getSettings.mockResolvedValue(structuredClone(settings));
    backend.getRuntimeCapabilities.mockResolvedValue({ learning: { available: true } });
    backend.getFocusState.mockResolvedValue({ session: null });
    backend.listToday.mockResolvedValue(structuredClone(today));
    backend.getCompanionExpressionSnapshot.mockResolvedValue(
      structuredClone(expression),
    );
    backend.getPetActivitySnapshot.mockResolvedValue(structuredClone(activity));
    backend.getBasicSupportState.mockResolvedValue(null);
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
});
