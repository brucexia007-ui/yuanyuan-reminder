// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { AppSettings, TodaySnapshot } from "../types";

const backend = vi.hoisted(() => ({
  listToday: vi.fn(),
  getRuntimeCapabilities: vi.fn(),
  getSettings: vi.fn(),
  getFocusState: vi.fn(),
  getPetCare: vi.fn(),
  getTaskWatchSnapshot: vi.fn(),
  deferTaskWatchAttention: vi.fn(),
  resumeTaskWatchAttention: vi.fn(),
  listHistory: vi.fn(),
  listBackups: vi.fn(),
  createBackup: vi.fn(),
  restoreBackup: vi.fn(),
  createReminder: vi.fn(),
  updateReminder: vi.fn(),
  deleteReminder: vi.fn(),
  setReminderEnabled: vi.fn(),
  completeOccurrence: vi.fn(),
  snoozeOccurrence: vi.fn(),
  skipOccurrence: vi.fn(),
  recordWater: vi.fn(),
  startFocus: vi.fn(),
  cancelFocus: vi.fn(),
  getBasicSupportState: vi.fn(),
  startBasicSupport: vi.fn(),
  stopBasicSupport: vi.fn(),
  startPetInteraction: vi.fn(),
  updateSettings: vi.fn(),
  deleteAllLocalDataAndExit: vi.fn(),
  pauseReminders: vi.fn(),
  requestSleep: vi.fn(),
  requestWake: vi.fn(),
  quitApplication: vi.fn(),
  onBackendEvent: vi.fn(),
  tauriAvailable: vi.fn(),
}));

vi.mock("../lib/backend", () => ({
  ...backend,
  DELETE_ALL_LOCAL_DATA_CONFIRMATION: "删除圆圆全部本地数据",
}));

vi.mock("@tauri-apps/plugin-notification", () => ({
  isPermissionGranted: vi.fn(async () => true),
  requestPermission: vi.fn(async () => "granted"),
}));

vi.mock("@tauri-apps/api/window", () => ({
  getCurrentWindow: vi.fn(),
}));

import { TaskPanel } from "./TaskPanel";

const settings: AppSettings = {
  animationMode: "always",
  companionIntensity: "everyday",
  companionLabelMode: "adaptive",
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
  missedReminderPolicy: "notify",
  missedReminderGraceMinutes: 120,
};

let snapshot: TodaySnapshot;
let container: HTMLDivElement;
let root: Root;

async function flush() {
  await act(async () => {
    await new Promise((resolve) => window.setTimeout(resolve, 0));
  });
}

function button(label: string): HTMLButtonElement {
  const match = [...container.querySelectorAll("button")].find(
    (item) => item.textContent?.trim() === label,
  );
  if (!match) throw new Error(`button not found: ${label}`);
  return match;
}

async function click(label: string) {
  await act(async () => {
    button(label).dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
  await flush();
}

async function remount() {
  await act(async () => root.unmount());
  root = createRoot(container);
  await act(async () => {
    root.render(<TaskPanel />);
  });
  await flush();
}

describe("TaskPanel complete reminder workflows", () => {
  beforeEach(async () => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    window.history.replaceState(null, "", "/");
    snapshot = {
      reminders: [
        {
          id: "system-water",
          title: "喝水时间",
          category: "water",
          scheduleKind: "interval",
          scheduleJson: JSON.stringify({
            title: "喝水时间",
            category: "water",
            scheduleKind: "interval",
            everyMinutes: 60,
            activeStartLocal: "09:00",
            activeEndLocal: "18:00",
            weekdays: [0, 1, 2, 3, 4, 5, 6],
          }),
          timezone: "Asia/Shanghai",
          enabled: true,
          nextDueAt: "2030-01-01T10:00:00+08:00",
          createdAt: "2026-01-01T00:00:00Z",
          updatedAt: "2026-01-01T00:00:00Z",
          archivedAt: null,
          systemKind: "water",
        },
        {
          id: "work-1",
          title: "提交工作总结",
          category: "work",
          scheduleKind: "daily",
          scheduleJson: JSON.stringify({
            title: "提交工作总结",
            category: "work",
            scheduleKind: "daily",
            atLocal: "2030-01-01T17:30",
            weekdays: [1, 2, 3, 4, 5],
          }),
          timezone: "Asia/Shanghai",
          enabled: true,
          nextDueAt: "2030-01-01T17:30:00+08:00",
          createdAt: "2026-01-01T00:00:00Z",
          updatedAt: "2026-01-01T00:00:00Z",
          archivedAt: null,
          systemKind: null,
        },
      ],
      occurrences: [
        {
          id: "occurrence-1",
          reminderId: "work-1",
          reminderTitle: "提交工作总结",
          category: "work",
          scheduledAt: new Date().toISOString(),
          status: "pending",
          actedAt: null,
          snoozedUntil: null,
          resolutionReason: null,
        },
      ],
      waterCompleted: 2,
      waterGoal: 9,
      notificationAvailable: true,
    };
    backend.listToday.mockImplementation(async () => structuredClone(snapshot));
    backend.getRuntimeCapabilities.mockResolvedValue({
      schemaVersion: 1,
      learning: {
        compiled: true,
        available: false,
        contentPackReady: false,
        autoInvitationAvailable: false,
        failureReason: "database",
      },
    });
    backend.getSettings.mockResolvedValue(structuredClone(settings));
    backend.getFocusState.mockResolvedValue({ session: null });
    backend.getBasicSupportState.mockResolvedValue(null);
    backend.getTaskWatchSnapshot.mockResolvedValue({
      schemaVersion: 2,
      available: false,
      observedCount: 0,
      needsUserCount: 0,
      states: [],
    });
    backend.startBasicSupport.mockImplementation(async (path: string, durationMinutes: number) => ({
      id: "support-1",
      path,
      durationMinutes,
      startedAt: "2030-01-01T09:00:00Z",
      endsAt: "2030-01-01T09:01:00Z",
    }));
    backend.stopBasicSupport.mockResolvedValue(true);
    backend.updateSettings.mockImplementation(async (patch: Partial<AppSettings>) => ({
      ...settings,
      ...patch,
    }));
    backend.getPetCare.mockRejectedValue(new Error("care database failure"));
    backend.listHistory.mockResolvedValue([]);
    backend.listBackups.mockResolvedValue([
      {
        fileName: "manual-2030-01-01-090000-test.sqlite3",
        createdAt: "2030-01-01T09:00:00Z",
        sizeBytes: 4096,
        automatic: false,
        learningIncluded: true,
      },
    ]);
    backend.onBackendEvent.mockResolvedValue(() => {});
    backend.tauriAvailable.mockReturnValue(false);
    backend.setReminderEnabled.mockImplementation(async (id: string, enabled: boolean) => {
      const reminder = snapshot.reminders.find((item) => item.id === id)!;
      reminder.enabled = enabled;
      return structuredClone(reminder);
    });
    backend.snoozeOccurrence.mockResolvedValue(undefined);

    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    await act(async () => {
      root.render(<TaskPanel />);
    });
    await flush();
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    vi.clearAllMocks();
  });

  it("keeps Today usable when Care fails, and sends the selected snooze duration", async () => {
    expect(container.textContent).toContain("提交工作总结");
    const select = container.querySelector<HTMLSelectElement>(".snooze-control select")!;
    await act(async () => {
      select.value = "30";
      select.dispatchEvent(new Event("change", { bubbles: true }));
    });
    await click("稍后");
    expect(backend.snoozeOccurrence).toHaveBeenCalledWith("occurrence-1", 30);

    await click("互动");
    expect(container.textContent).toContain("互动记录暂时未能加载");
    expect(container.textContent).toContain("重新读取");
  });

  it("manages ordinary reminders while routing protected system reminders to settings", async () => {
    await click("管理");
    expect(container.textContent).toContain("喝水时间");
    expect(container.textContent).toContain("系统");

    await click("暂停");
    expect(backend.setReminderEnabled).toHaveBeenCalledWith("work-1", false);
    expect(container.textContent).toContain("已暂停");

    await click("前往设置");
    expect(container.textContent).toContain("错过提醒");
    expect(container.textContent).toContain("数据备份");
    expect(container.textContent).toContain("含学习数据");
    expect(container.textContent).toContain("删除全部本地数据");
    expect(container.textContent).toContain("道具标签");
    expect(button("永久删除本地数据并退出").disabled).toBe(true);
    expect(backend.deleteAllLocalDataAndExit).not.toHaveBeenCalled();

    const labelMode = [...container.querySelectorAll("select")].find((select) =>
      [...select.options].some((option) => option.value === "motion_only"),
    );
    expect(labelMode?.value).toBe("adaptive");
    const labelTitleId = labelMode?.getAttribute("aria-labelledby");
    const labelDescriptionId = labelMode?.getAttribute("aria-describedby");
    expect(document.getElementById(labelTitleId ?? "")?.textContent).toBe(
      "道具标签",
    );
    expect(document.getElementById(labelDescriptionId ?? "")?.textContent).toContain(
      "不会变成圆圆的对白",
    );
    const cursorSwitch = [...container.querySelectorAll('[role="switch"]')].find(
      (item) =>
        document.getElementById(item.getAttribute("aria-labelledby") ?? "")
          ?.textContent === "看向鼠标",
    );
    expect(cursorSwitch).toBeTruthy();
    expect(
      container.querySelector('input[aria-label="安静时段开始"]'),
    ).toBeTruthy();
    expect(
      container.querySelector('input[aria-label="安静时段结束"]'),
    ).toBeTruthy();
    await act(async () => {
      if (!labelMode) throw new Error("companion label mode select not found");
      labelMode.value = "motion_only";
      labelMode.dispatchEvent(new Event("change", { bubbles: true }));
    });
    await flush();
    expect(backend.updateSettings).toHaveBeenCalledWith({
      companionLabelMode: "motion_only",
    });

    backend.requestSleep.mockResolvedValue(undefined);
    await click("让圆圆睡觉");
    expect(backend.requestSleep).toHaveBeenCalledOnce();
    expect(container.textContent).toContain("圆圆已经去睡觉了");
  });

  it("starts an explicit non-diagnostic support path with only a fixed path and duration", async () => {
    await click("互动");
    backend.getPetCare.mockResolvedValue({
      total: 0,
      food: 0,
      water: 0,
      treat: 0,
      wand: 0,
      pet: 0,
      ball: 0,
      lastInteractionAt: null,
    });
    await click("重新读取");

    expect(container.textContent).toContain("不判断你的情绪");
    expect(container.textContent).toContain("关闭应用即结束");
    await click("打开三张陪伴小牌");
    expect(document.activeElement?.textContent).toContain("只陪我一会");
    await click("取消");
    expect(document.activeElement).toBe(button("打开三张陪伴小牌"));
    await click("打开三张陪伴小牌");
    expect(document.activeElement?.textContent).toContain("只陪我一会");
    await click("陪我动一动圆圆先伸懒腰，不计分");
    await click("开始");

    expect(backend.startBasicSupport).toHaveBeenCalledWith("move_together", 1);
    expect(container.textContent).toContain("陪我动一动");
    expect(container.textContent).toContain("结束本次陪伴");
    expect(document.activeElement).toBe(button("结束本次陪伴"));

    await click("结束本次陪伴");
    expect(backend.stopBasicSupport).toHaveBeenCalledOnce();
    expect(document.activeElement).toBe(button("打开三张陪伴小牌"));
  });

  it("requires the exact phrase, acknowledgement, and final dialog before local deletion", async () => {
    backend.tauriAvailable.mockReturnValue(true);
    backend.deleteAllLocalDataAndExit.mockResolvedValue(undefined);
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(true);
    await remount();
    await click("设置");

    const destructiveButton = button("永久删除本地数据并退出");
    const confirmationInput = container.querySelector<HTMLInputElement>(
      ".delete-data-confirmation input",
    )!;
    const acknowledgement = container.querySelector<HTMLInputElement>(
      ".delete-data-acknowledgement input",
    )!;
    expect(destructiveButton.disabled).toBe(true);

    await act(async () => {
      const setInputValue = Object.getOwnPropertyDescriptor(
        HTMLInputElement.prototype,
        "value",
      )?.set;
      if (!setInputValue) throw new Error("native input value setter is unavailable");
      setInputValue.call(confirmationInput, "删除圆圆全部本地数据");
      confirmationInput.dispatchEvent(new Event("input", { bubbles: true }));
      acknowledgement.click();
    });
    await flush();

    expect(button("永久删除本地数据并退出").disabled).toBe(false);
    await click("永久删除本地数据并退出");
    expect(confirm).toHaveBeenCalledOnce();
    expect(backend.deleteAllLocalDataAndExit).toHaveBeenCalledWith(
      "删除圆圆全部本地数据",
      true,
    );
  });

  it("opens the sanitized task-watch route without exposing task identity fields", async () => {
    const visibleSnapshot = {
      schemaVersion: 2,
      available: true,
      observedCount: 8,
      needsUserCount: 2,
      states: [
        { source: "codex", state: "waiting_user", count: 1, deferredUntilUnixMs: null },
        { source: "codex", state: "running", count: 3, deferredUntilUnixMs: null },
        { source: "codex", state: "succeeded", count: 1, deferredUntilUnixMs: null },
        { source: "claude_code", state: "waiting_user", count: 1, deferredUntilUnixMs: null },
        { source: "claude_code", state: "stalled", count: 1, deferredUntilUnixMs: null },
        { source: "claude_code", state: "failed", count: 1, deferredUntilUnixMs: null },
      ],
    } as const;
    backend.getTaskWatchSnapshot.mockResolvedValue(visibleSnapshot);
    backend.deferTaskWatchAttention.mockResolvedValue({
      ...visibleSnapshot,
      states: visibleSnapshot.states.map((item) =>
        item.source === "codex" && item.state === "waiting_user"
          ? { ...item, deferredUntilUnixMs: 3_000_000 }
          : item,
      ),
    });
    backend.resumeTaskWatchAttention.mockResolvedValue(visibleSnapshot);
    await remount();

    await click("守望");
    expect(container.textContent).toContain("只看状态，不看正文");
    expect(container.textContent).toContain("共 8 项，2 项需要你");
    expect(container.querySelectorAll(".task-watch-state")).toHaveLength(6);
    expect(container.textContent).not.toMatch(/task[_-]?id|workspace|prompt|message/i);

    await click("10 分钟后再提醒");
    expect(backend.deferTaskWatchAttention).toHaveBeenCalledWith(
      "codex",
      "waiting_user",
      10,
    );
    expect(container.textContent).toContain("已暂缓主动提醒");
    expect(container.textContent).toContain("任务仍保留在守望台");

    await click("恢复提醒");
    expect(backend.resumeTaskWatchAttention).toHaveBeenCalledWith(
      "codex",
      "waiting_user",
    );

    const callsBeforeRefresh = backend.getTaskWatchSnapshot.mock.calls.length;
    await click("重新查看");
    expect(backend.getTaskWatchSnapshot.mock.calls.length).toBeGreaterThan(
      callsBeforeRefresh,
    );
  });

  it("isolates task-watch read failures and keeps the reminder dashboard usable", async () => {
    backend.getTaskWatchSnapshot.mockRejectedValue(
      new Error("private fixture detail must not reach the interface"),
    );
    window.history.replaceState(null, "", "/?tab=taskwatch");
    await remount();

    expect(container.textContent).toContain("任务守望台暂时未能读取");
    expect(container.textContent).toContain("来源任务不会受影响");
    expect(container.textContent).not.toContain("private fixture detail");

    await click("今日");
    expect(container.textContent).toContain("提交工作总结");
    expect(container.querySelector(".panel-header h1")?.textContent).toBe("今天");
  });
});
