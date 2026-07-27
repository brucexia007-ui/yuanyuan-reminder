import { describe, expect, it } from "vitest";

import {
  completeOccurrence,
  getSettings,
  listToday,
  updateSettings,
} from "./backend";

describe("浏览器演示后端", () => {
  it("完成喝水提醒会同步增加一杯且不会重复计数", async () => {
    const before = await listToday();
    const water = before.occurrences.find(
      (item) =>
        item.category === "water" &&
        ["pending", "overdue", "snoozed"].includes(item.status),
    );
    expect(water).toBeDefined();

    await completeOccurrence(water!.id);
    const completed = await listToday();
    expect(completed.waterCompleted).toBe(before.waterCompleted + 1);
    expect(
      completed.occurrences.find((item) => item.id === water!.id)?.status,
    ).toBe("completed");

    await completeOccurrence(water!.id);
    expect((await listToday()).waterCompleted).toBe(
      before.waterCompleted + 1,
    );
  });

  it("设置修改在演示会话内保持有效", async () => {
    await updateSettings({ activityIntervalMinutes: 45 });
    expect((await getSettings()).activityIntervalMinutes).toBe(45);
  });
});
