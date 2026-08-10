import { describe, expect, it } from "vitest";

import {
  DELETE_ALL_LOCAL_DATA_CONFIRMATION,
  applyConnectorTrustChange,
  applyProjectHookInspection,
  cancelProjectHookInspection,
  clearAiDiagnostics,
  completeOccurrence,
  discoverBuiltinConnectors,
  deferTaskWatchAttention,
  deleteAllLocalDataAndExit,
  exportAiDiagnostics,
  getAiSupervisorStatus,
  getCompanionExpressionSnapshot,
  getConnectorTrustStatus,
  inspectConnectorHookConfig,
  getSettings,
  getTaskWatchSnapshot,
  listToday,
  previewAiDiagnostics,
  previewConnectorTrustChange,
  updateSettings,
  retryAiAfterFailure,
  resumeTaskWatchAttention,
  selectProjectForHookInspection,
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

  it("浏览器演示不会伪造全部本地数据已删除", async () => {
    await expect(
      deleteAllLocalDataAndExit(DELETE_ALL_LOCAL_DATA_CONFIRMATION, true),
    ).rejects.toThrow("local data deletion is unavailable");
  });

  it("浏览器表达快照只有固定非语言字段", async () => {
    const snapshot = await getCompanionExpressionSnapshot();
    expect(snapshot.schemaVersion).toBe(1);
    expect(snapshot.tier).toBe("n0");
    expect(snapshot.props).toEqual([]);
    expect(JSON.stringify(snapshot)).not.toMatch(
      /title|message|dialogue|speech|animation|resource|prompt|圆圆说/,
    );
  });

  it("浏览器演示不会假装智能守望进程已经安装", async () => {
    expect(await getAiSupervisorStatus()).toBe("unavailable");
    expect(await getTaskWatchSnapshot()).toEqual({
      schemaVersion: 2,
      available: false,
      observedCount: 0,
      needsUserCount: 0,
      states: [],
    });
    await expect(
      deferTaskWatchAttention("codex", "running", 10),
    ).rejects.toThrow("task watch attention deferral is unavailable");
    await expect(
      resumeTaskWatchAttention("codex", "running"),
    ).rejects.toThrow("task watch attention resume is unavailable");
    expect(await retryAiAfterFailure()).toBe(false);
    await expect(exportAiDiagnostics()).rejects.toThrow(
      "diagnostic export is unavailable",
    );
    await expect(previewAiDiagnostics()).rejects.toThrow(
      "diagnostic preview is unavailable",
    );
    await expect(clearAiDiagnostics()).rejects.toThrow(
      "diagnostic cleanup is unavailable",
    );
    await expect(selectProjectForHookInspection("connector", "instance")).rejects.toThrow(
      "native project picker is unavailable",
    );
    await expect(applyProjectHookInspection("token")).rejects.toThrow(
      "project hook inspection is unavailable",
    );
    await expect(cancelProjectHookInspection("token")).resolves.toBeUndefined();
  });
  it("浏览器演示不会伪造连接器信任或修改Hook", async () => {
    expect(
      await getConnectorTrustStatus(
        "builtin.codex",
        "00000000-0000-4000-8000-000000000001",
      ),
    ).toEqual({
      connectorId: "builtin.codex",
      configured: false,
      active: false,
      needsReconnect: false,
      rotationGraceActive: false,
      generation: null,
      sourceInstance: "00000000-0000-4000-8000-000000000001",
      legacyIdentity: false,
      hookConfigurationChanged: false,
    });
    await expect(
      previewConnectorTrustChange(
        "register",
        "builtin.codex",
      ),
    ).rejects.toThrow("connector trust preview is unavailable");
    await expect(applyConnectorTrustChange("unused")).rejects.toThrow(
      "connector trust change is unavailable",
    );
    await expect(
      inspectConnectorHookConfig(
        "builtin.codex.00000000-0000-4000-8000-000000000010",
        "00000000-0000-4000-8000-000000000001",
      ),
    ).rejects.toThrow("connector hook inspection is unavailable");
  });

  it("浏览器连接器发现保持未配置且不触碰来源工具", async () => {
    const snapshot = await discoverBuiltinConnectors();
    expect(snapshot.connectors).toHaveLength(2);
    expect(
      snapshot.connectors.every((item) => item.installationState === "not_detected"),
    ).toBe(true);
    expect(snapshot.connectors.every((item) => item.hookConfiguration === "unknown")).toBe(
      true,
    );
      expect(snapshot.connectors.every((item) => item.eventHealth === "not_observed")).toBe(true);
      expect(snapshot.connectors.every((item) => item.toolTrust.status === "not_detected")).toBe(
        true,
      );
    expect(snapshot.connectors.every((item) => item.authorizationProbe === "unconfigured")).toBe(
      true,
    );
    expect(snapshot.connectors.every((item) => item.trustedInstances.length === 0)).toBe(true);
    expect(snapshot.privacy).toEqual({
      sourceProcessesExecuted: false,
      privateConfigurationRead: false,
      taskDataRead: false,
      hookConfigurationChanged: false,
    });
  });
});
