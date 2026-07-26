import { describe, expect, it } from "vitest";

import type { Occurrence, Reminder } from "../types";
import { plannedDueLabel, plannedReminders } from "./todayReminders";

function reminder(patch: Partial<Reminder> = {}): Reminder {
  return {
    id: "reminder-1",
    title: "整理工作总结",
    category: "work",
    scheduleKind: "once",
    scheduleJson: "{}",
    timezone: "Asia/Shanghai",
    enabled: true,
    nextDueAt: "2026-07-25T10:30:00+08:00",
    createdAt: "2026-07-25T09:00:00+08:00",
    updatedAt: "2026-07-25T09:00:00+08:00",
    ...patch,
  };
}

function occurrence(patch: Partial<Occurrence> = {}): Occurrence {
  return {
    id: "occurrence-1",
    reminderId: "reminder-1",
    reminderTitle: "整理工作总结",
    category: "work",
    scheduledAt: "2026-07-25T10:30:00+08:00",
    status: "pending",
    actedAt: null,
    snoozedUntil: null,
    ...patch,
  };
}

describe("今日计划提醒", () => {
  it("新建后立即显示尚未到点的提醒", () => {
    expect(plannedReminders([reminder()], [])).toHaveLength(1);
  });

  it("已有待处理 occurrence 时不会重复显示计划卡片", () => {
    expect(plannedReminders([reminder()], [occurrence()])).toHaveLength(0);
  });

  it("不会把喝水计划或已停用提醒重复放进待办", () => {
    expect(
      plannedReminders(
        [
          reminder({ id: "water", category: "water" }),
          reminder({ id: "disabled", enabled: false }),
        ],
        [],
      ),
    ).toHaveLength(0);
  });

  it("今天和明天使用易读日期标签", () => {
    const now = new Date(2026, 6, 25, 9, 0);
    const todayDue = new Date(2026, 6, 25, 10, 30).toISOString();
    const tomorrowDue = new Date(2026, 6, 26, 8, 0).toISOString();

    expect(plannedDueLabel(todayDue, now)).toEqual({
      date: "今天",
      time: "10:30",
    });
    expect(plannedDueLabel(tomorrowDue, now).date).toBe("明天");
  });
});
