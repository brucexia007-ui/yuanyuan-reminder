// @vitest-environment jsdom

import { describe, expect, it } from "vitest";

import {
  applyConnectorTrustChange,
  applyProjectHookInspection,
  cancelProjectHookInspection,
  clearAiDiagnostics,
  completeOccurrence,
  DELETE_ALL_LOCAL_DATA_CONFIRMATION,
  deleteAllLocalDataAndExit,
  discoverBuiltinConnectors,
  deferTaskWatchAttention,
  exportAiDiagnostics,
  finishPetInteraction,
  getAiSupervisorStatus,
  getCompanionExpressionSnapshot,
  getConnectorTrustStatus,
  getRuntimeCapabilities,
  inspectConnectorHookConfig,
  getSettings,
  getTaskWatchSnapshot,
  listToday,
  onBackendEvent,
  previewAiDiagnostics,
  previewConnectorTrustChange,
  startPetInteraction,
  updateSettings,
  retryAiAfterFailure,
  resumeTaskWatchAttention,
  selectProjectForHookInspection,
} from "./backend";
import type { PetInteractionStarted } from "../types";

describe("浏览器演示后端", () => {
  it("统一产品的浏览器演示提供通用学习能力但不启用自动邀请", async () => {
    expect(await getRuntimeCapabilities()).toEqual({
      schemaVersion: 1,
      learning: {
        compiled: true,
        available: true,
        contentPackReady: true,
        autoInvitationAvailable: false,
        failureReason: null,
      },
    });
  });

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

  it("浏览器演示把面板互动事件送到桌宠监听器", async () => {
    const received: Array<{ id: string; kind: string }> = [];
    const unlisten = await onBackendEvent<{ id: string; kind: string }>(
      "pet-interaction-started",
      (payload) => received.push(payload),
    );

    await startPetInteraction("treat");

    expect(received).toHaveLength(1);
    expect(received[0]?.kind).toBe("treat");
    expect(received[0]?.id).toMatch(/^[0-9a-f-]{36}$/i);
    unlisten();
  });

  it("浏览器演示不会伪造全部本地数据已删除", async () => {
    await expect(
      deleteAllLocalDataAndExit(DELETE_ALL_LOCAL_DATA_CONFIRMATION, true),
    ).rejects.toThrow("local data deletion is unavailable");
  });

  it("互动结束必须匹配当前租约，迟到请求不影响新互动", async () => {
    const received: PetInteractionStarted[] = [];
    const unlisten = await onBackendEvent<PetInteractionStarted>(
      "pet-interaction-started", (payload) => received.push(payload),
    );
    const before = Date.now();
    await startPetInteraction("ball");
    await startPetInteraction("wand");
    const [first, second] = received;
    expect(first.expiresAtUnixMs).toBeGreaterThanOrEqual(before + 30_000);
    expect(second.leaseRevision).toBeGreaterThan(first.leaseRevision);
    expect(await finishPetInteraction(first.id, first.leaseRevision)).toBe(false);
    expect(await finishPetInteraction(second.id, second.leaseRevision + 1)).toBe(false);
    expect(await finishPetInteraction(second.id, second.leaseRevision)).toBe(true);
    expect(await finishPetInteraction(second.id, second.leaseRevision)).toBe(false);
    unlisten();
  });

  it("浏览器表达快照只有固定非语言字段", async () => {
    const snapshot = await getCompanionExpressionSnapshot();
    expect(snapshot.schemaVersion).toBe(2);
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
