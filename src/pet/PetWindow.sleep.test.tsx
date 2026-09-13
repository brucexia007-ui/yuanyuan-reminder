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
    onComplete,
  }: {
    animation: string;
    onComplete: (animation: never) => void;
  }) => {
    sprite.complete = () => onComplete(animation as never);
    return <div className="sprite-animator" data-animation={animation} />;
  },
}));
vi.mock("./CompanionPropStage", () => ({
  CompanionPropStage: () => <div data-testid="companion-prop" />,
}));

import {
  isManualSleepRequest,
  PetWindow,
  petSleepAccessibleStatus,
} from "./PetWindow";

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
  overrides: Partial<CompanionExpressionSnapshot> = {},
): CompanionExpressionSnapshot => ({
  schemaVersion: 2,
  revision: 1,
  tier: "n3",
  intent: "needs_attention",
  pose: "alert",
  props: ["system_card"],
  label: "reminder_due",
  attention: "ring_once",
  motion: "full",
  movePropForward: true,
  queueInBasket: false,
  taskSource: null,
  groupedCount: 1,
  focusDeferredCount: 0,
  accessibleState: "work_reminder_due",
  sceneAppearance: { kind: "none" },
  ...overrides,
});

const activity = (
  overrides: Partial<PetActivitySnapshot> = {},
): PetActivitySnapshot => ({
  revision: 1,
  activity: "reminding",
  source: "reminder",
  leaseId: "lease-reminder",
  resumableLearningSessionId: null,
  restoreTarget: null,
  ...overrides,
});

const today: TodaySnapshot = {
  reminders: [],
  occurrences: [{
    id: "occurrence-1",
    reminderId: "work-1",
    reminderTitle: "提交工作总结",
    category: "work",
    scheduledAt: new Date().toISOString(),
    status: "pending",
    actedAt: null,
    snoozedUntil: null,
    resolutionReason: null,
  }],
  waterCompleted: 0,
  waterGoal: 9,
  notificationAvailable: true,
};

describe("PetWindow manual sleep presentation", () => {
  let container: HTMLDivElement;
  let root: Root;
  let handlers: Map<string, (payload: unknown) => void>;

  const flush = async () => {
    await act(async () => {
      await new Promise((resolve) => window.setTimeout(resolve, 0));
    });
  };

  const emit = async (event: string, payload?: unknown) => {
    await act(async () => handlers.get(event)?.(payload));
    await flush();
  };

  const animation = () =>
    container.querySelector<HTMLElement>(".sprite-animator")?.dataset.animation;

  beforeEach(async () => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    Object.defineProperty(window, "matchMedia", {
      configurable: true,
      value: vi.fn(() => ({ matches: false })),
    });
    handlers = new Map();
    backend.getSettings.mockResolvedValue(structuredClone(settings));
    backend.getRuntimeCapabilities.mockResolvedValue({ learning: { available: false } });
    backend.getFocusState.mockResolvedValue({ session: null });
    backend.listToday.mockResolvedValue(structuredClone(today));
    backend.getCompanionExpressionSnapshot.mockResolvedValue(expression());
    backend.getPetActivitySnapshot.mockResolvedValue(activity());
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
    sprite.complete = null;
    vi.clearAllMocks();
  });

  it("lets explicit sleep hide a pending reminder, then restores it after wake", async () => {
    expect(container.textContent).toContain("提交工作总结");
    expect(animation()).toBe("alert-glass-paws");

    await emit("pet-request-sleep", { source: "manual" });
    expect(container.textContent).not.toContain("提交工作总结");
    expect(animation()).toBe("sleep-enter");

    await emit("companion-expression", expression({
      revision: 2,
      tier: "n0",
      intent: "quiet_presence",
      pose: "sleeping",
      props: [],
      label: null,
      attention: "silent",
      movePropForward: false,
      accessibleState: "sleeping",
    }));
    expect(animation()).toBe("sleeping");

    await emit("companion-expression", expression({
      revision: 3,
      tier: "n0",
      intent: "quiet_presence",
      pose: "idle",
      props: [],
      label: null,
      attention: "silent",
      movePropForward: false,
      accessibleState: "quiet_presence",
    }));
    await emit("pet-request-wake");
    expect(animation()).toBe("idle");
    await act(async () => sprite.complete?.());
    await flush();
    await flush();
    expect(container.textContent).toContain("提交工作总结");
    expect(animation()).not.toBe("sleeping");
    expect(animation()).not.toBe("sleep-enter");
  });

  it("treats explicit and legacy requests as manual but keeps scheduler requests automatic", () => {
    expect(isManualSleepRequest({ source: "manual" })).toBe(true);
    expect(isManualSleepRequest(undefined)).toBe(true);
    expect(isManualSleepRequest({ source: "automatic" })).toBe(false);
  });

  it("announces authoritative sleep and resumable wake states", () => {
    expect(
      petSleepAccessibleStatus(
        activity({
          activity: "sleeping",
          source: "manual",
          leaseId: null,
          resumableLearningSessionId: "session-1",
          restoreTarget: "learning",
        }),
      ),
    ).toBe("圆圆正在睡觉");
    expect(
      petSleepAccessibleStatus(
        activity({
          activity: "interrupted",
          source: "learning",
          leaseId: null,
          resumableLearningSessionId: "session-1",
          restoreTarget: "learning",
        }),
      ),
    ).toBe("圆圆已醒，上一轮学习可以继续");
    expect(petSleepAccessibleStatus(activity())).toBeNull();
  });

  it("keeps automatic sleep subordinate to an active reminder", async () => {
    expect(container.textContent).toContain("提交工作总结");

    await emit("pet-request-sleep", { source: "automatic" });

    expect(container.textContent).toContain("提交工作总结");
    expect(animation()).toBe("alert-glass-paws");
  });

  it("drops stale activity snapshots", async () => {
    await emit(
      "pet-activity-snapshot-updated",
      activity({
        revision: 2,
        activity: "sleeping",
        source: "schedule",
        leaseId: null,
      }),
    );
    expect(animation()).toBe("sleep-enter");
    expect(container.textContent).toContain("圆圆正在睡觉");

    await emit("pet-activity-snapshot-updated", activity({ revision: 1 }));
    expect(animation()).toBe("sleep-enter");
  });

  it("renders sleep while learning remains resumable and wakes without reopening it", async () => {
    await emit(
      "pet-activity-snapshot-updated",
      activity({
        revision: 2,
        activity: "sleeping",
        source: "manual",
        leaseId: null,
        resumableLearningSessionId: "session-1",
        restoreTarget: "learning",
      }),
    );
    expect(animation()).toBe("sleep-enter");

    await emit(
      "pet-activity-snapshot-updated",
      activity({
        revision: 3,
        activity: "interrupted",
        source: "learning",
        leaseId: null,
        resumableLearningSessionId: "session-1",
        restoreTarget: "learning",
      }),
    );
    expect(animation()).toBe("wake-up");
    expect(container.textContent).toContain("圆圆已醒，上一轮学习可以继续");
    expect(container.textContent).not.toContain("圆圆桌面英语复习");
  });
});
