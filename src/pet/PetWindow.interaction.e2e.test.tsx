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

  beforeEach(async () => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    Object.defineProperty(window, "matchMedia", {
      configurable: true,
      value: vi.fn(() => ({ matches: false })),
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

  it("keeps every interaction hint in its face-safe dock while replacing controls", async () => {
    let card = await startInteraction("treat-1", "treat");
    expect(card?.classList.contains("tool-card")).toBe(true);
    expect(card?.classList.contains("card-left")).toBe(true);
    expect(container.querySelector(".pet-tool-treat")).not.toBeNull();

    card = await startInteraction("wand-1", "wand");
    expect(card?.classList.contains("tool-card")).toBe(true);
    expect(container.querySelector(".pet-tool-treat")).toBeNull();
    expect(container.querySelector(".pet-tool-wand")).not.toBeNull();

    card = await startInteraction("pet-1", "pet");
    expect(card?.classList.contains("card-right")).toBe(true);
    expect(container.querySelector(".pet-tool")).toBeNull();
    expect(container.querySelector(".pet-head-zone")).not.toBeNull();

    card = await startInteraction("ball-1", "ball");
    expect(card?.classList.contains("tool-card")).toBe(true);
    expect(card?.classList.contains("ball-card")).toBe(true);
    expect(card?.classList.contains("card-right")).toBe(true);
    expect(container.querySelector(".pet-head-zone")).toBeNull();
    expect(container.querySelector(".pet-tool-ball")).not.toBeNull();
  });
});
