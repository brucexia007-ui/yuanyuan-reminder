// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { petDisplayName } from "../brand";

const backend = vi.hoisted(() => ({
  applyProjectHookInspection: vi.fn(),
  cancelProjectHookInspection: vi.fn(),
  discoverBuiltinConnectors: vi.fn(),
  inspectConnectorHookConfig: vi.fn(),
  selectProjectForHookInspection: vi.fn(),
}));

vi.mock("../lib/backend", () => backend);

import { ConnectorDiscoveryStatusCard } from "./ConnectorDiscoveryStatus";

let container: HTMLDivElement;
let root: Root;

async function flush() {
  await act(async () => {
    await new Promise((resolve) => window.setTimeout(resolve, 0));
  });
}

describe("connector discovery status", () => {
  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    vi.clearAllMocks();
  });

  it("separates installation, authorization, Hook and event health", async () => {
    backend.discoverBuiltinConnectors.mockResolvedValue({
      connectors: [
        {
          kind: "codex",
          installationState: "detected",
          installationChannels: ["windows_desktop_app"],
          toolTrust: {
            status: "verified",
            reason: "official_distribution_verified",
            artifactsChecked: 1,
            authenticodeChecked: true,
            authenticodeValid: true,
            publisherMatched: true,
            packageIdentityAttested: true,
            manifestAttested: false,
            sourceProcessesExecuted: false,
            networkAccessed: false,
            artifactPathReturned: false,
            certificateMaterialReturned: false,
          },
          compatibility: "limited",
          hookConfiguration: "unknown",
          eventHealth: "not_observed",
          authorizationProbe: "available",
          trustedInstances: [
            {
              connectorId: "builtin.codex.00000000-0000-4000-8000-000000000010",
              sourceInstance: "00000000-0000-4000-8000-000000000001",
              authorizationState: "active",
              rotationGraceActive: false,
              generation: 1,
              legacyIdentity: false,
            },
          ],
        },
        {
          kind: "claude_code",
          installationState: "not_detected",
          installationChannels: [],
          toolTrust: {
            status: "not_detected",
            reason: "not_detected",
            artifactsChecked: 0,
            authenticodeChecked: false,
            authenticodeValid: false,
            publisherMatched: false,
            packageIdentityAttested: false,
            manifestAttested: false,
            sourceProcessesExecuted: false,
            networkAccessed: false,
            artifactPathReturned: false,
            certificateMaterialReturned: false,
          },
          compatibility: "limited",
          hookConfiguration: "unknown",
          eventHealth: "not_observed",
          authorizationProbe: "unconfigured",
          trustedInstances: [],
        },
      ],
      privacy: {
        sourceProcessesExecuted: false,
        privateConfigurationRead: false,
        taskDataRead: false,
        hookConfigurationChanged: false,
      },
    });

    await act(async () => root.render(<ConnectorDiscoveryStatusCard />));
    await flush();

    expect(container.textContent).toContain("检测到：Windows 桌面应用");
    expect(container.textContent).toContain("程序签名与官方分发身份均有效");
    expect(container.textContent).toContain("本机授权有效");
    expect(container.textContent).toContain("尚未检查 Hook 配置");
    expect(container.textContent).toContain("尚未收到可信任务事件");
    expect(container.textContent).toContain("不会启动 Codex 或 Claude");
    expect(container.textContent).not.toContain("00000000");

    backend.inspectConnectorHookConfig.mockResolvedValue({
      status: "checked",
      preview: {
        tool: "codex",
        conflict: "none",
        proposedAction: "add_missing",
        sourceFiles: 1,
        parsedSources: 1,
        sourcesWithHooks: 1,
        sourcesWithOwnedHandlers: 1,
        preferredSourcePresent: true,
        expectedHandlers: 6,
        exactHandlers: 2,
        missingHandlers: 4,
        modifiedHandlers: 0,
        duplicateHandlers: 0,
        unexpectedOwnedHandlers: 0,
        configWritePerformed: false,
        sourceTaskBehaviorChanged: false,
      },
      privateConfigurationRead: true,
      projectConfigurationRead: false,
      taskDataRead: false,
      sourceProcessesExecuted: false,
      configWritePerformed: false,
      sourceTaskBehaviorChanged: false,
    });
    const inspect = [...container.querySelectorAll("button")].find(
      (button) => button.textContent?.includes("只读检查 Hook 配置"),
    )!;
    await act(async () => inspect.click());
    await flush();
    expect(backend.inspectConnectorHookConfig).toHaveBeenCalledWith(
      "builtin.codex.00000000-0000-4000-8000-000000000010",
      "00000000-0000-4000-8000-000000000001",
    );
    expect(container.textContent).toContain("已有 2 项、缺少 4 项");
    expect(container.textContent).toContain("未作修改");

    backend.selectProjectForHookInspection.mockResolvedValue({
      status: "confirmation_required",
      preview: {
        confirmationToken: "project-token-must-not-render",
        expiresInSeconds: 120,
        tool: "codex",
        projectDirectoryVerified: true,
        userHookConfigurationMayBeRead: true,
        projectHookConfigurationMayBeRead: true,
        taskDataRead: false,
        sourceProcessesExecuted: false,
        configWritePerformed: false,
        sourceTaskBehaviorChanged: false,
        selectedPathReturned: false,
        selectionPersisted: false,
      },
      selectedPathReturned: false,
      selectionPersisted: false,
    });
    backend.applyProjectHookInspection.mockResolvedValue({
      status: "checked",
      preview: {
        tool: "codex",
        conflict: "none",
        proposedAction: "add_missing",
        sourceFiles: 3,
        parsedSources: 3,
        sourcesWithHooks: 1,
        sourcesWithOwnedHandlers: 0,
        preferredSourcePresent: true,
        expectedHandlers: 6,
        exactHandlers: 0,
        missingHandlers: 6,
        modifiedHandlers: 0,
        duplicateHandlers: 0,
        unexpectedOwnedHandlers: 0,
        losslessEditSupported: false,
        configWritePerformed: false,
        sourceTaskBehaviorChanged: false,
      },
      projectDirectoryChecked: true,
      userConfigurationFilesRead: 1,
      projectConfigurationFilesRead: 2,
      privateConfigurationRead: true,
      projectConfigurationRead: true,
      taskDataRead: false,
      sourceProcessesExecuted: false,
      configWritePerformed: false,
      sourceTaskBehaviorChanged: false,
      selectedPathReturned: false,
      selectionPersisted: false,
    });
    const chooseProject = [...container.querySelectorAll("button")].find(
      (button) => button.textContent === "选择项目进行只读检查",
    )!;
    await act(async () => chooseProject.click());
    await flush();
    expect(backend.selectProjectForHookInspection).toHaveBeenCalledWith(
      "builtin.codex.00000000-0000-4000-8000-000000000010",
      "00000000-0000-4000-8000-000000000001",
    );
    expect(container.textContent).toContain("所选项目文件夹已安全验证");
    expect(container.textContent).toContain("不读取代码、任务、对话或 Git 内容");
    expect(container.textContent).not.toContain("project-token-must-not-render");

    const confirmProject = [...container.querySelectorAll("button")].find(
      (button) => button.textContent === "确认只读检查",
    )!;
    await act(async () => confirmProject.click());
    await flush();
    expect(backend.applyProjectHookInspection).toHaveBeenCalledWith(
      "project-token-must-not-render",
    );
    expect(container.textContent).toContain("已只读检查 2 个项目配置和 1 个用户配置");
    expect(container.textContent).toContain("未作修改");

    const preview = [...container.querySelectorAll("button")].find(
      (button) => button.textContent === "查看未来授权范围",
    )!;
    await act(async () => preview.click());
    expect(container.textContent).toContain("尚未执行任何变更");
    expect(container.textContent).toContain("不会安装、合并、覆盖或删除任何 Hook 配置");
    expect(container.textContent).toContain("暂不提供确认执行");
  });

  it("shows unreadable trust storage as unavailable rather than unconfigured", async () => {
    backend.discoverBuiltinConnectors.mockResolvedValue({
      connectors: [
        {
          kind: "codex",
          installationState: "detected",
          installationChannels: ["cli_on_path"],
          toolTrust: {
            status: "review_required",
            reason: "unsupported_wrapper",
            artifactsChecked: 1,
            authenticodeChecked: false,
            authenticodeValid: false,
            publisherMatched: false,
            packageIdentityAttested: false,
            manifestAttested: false,
            sourceProcessesExecuted: false,
            networkAccessed: false,
            artifactPathReturned: false,
            certificateMaterialReturned: false,
          },
          compatibility: "limited",
          hookConfiguration: "unknown",
          eventHealth: "not_observed",
          authorizationProbe: "unavailable",
          trustedInstances: [],
        },
      ],
      privacy: {
        sourceProcessesExecuted: false,
        privateConfigurationRead: false,
        taskDataRead: false,
        hookConfigurationChanged: false,
      },
    });

    await act(async () => root.render(<ConnectorDiscoveryStatusCard />));
    await flush();
    expect(container.textContent).toContain("授权状态暂时无法读取");
    expect(container.textContent).toContain("来源需要人工复核");
    expect(container.textContent).not.toContain(`尚未授权${petDisplayName}守望`);
  });

  it("explains authentication pause without implying the source task was stopped", async () => {
    backend.discoverBuiltinConnectors.mockResolvedValue({
      connectors: [
        {
          kind: "codex",
          installationState: "detected",
          installationChannels: ["windows_desktop_app"],
          toolTrust: {
            status: "unavailable",
            reason: "verifier_unavailable",
            artifactsChecked: 1,
            authenticodeChecked: true,
            authenticodeValid: false,
            publisherMatched: false,
            packageIdentityAttested: false,
            manifestAttested: false,
            sourceProcessesExecuted: false,
            networkAccessed: false,
            artifactPathReturned: false,
            certificateMaterialReturned: false,
          },
          compatibility: "limited",
          hookConfiguration: "unknown",
          eventHealth: "paused_authentication_failure",
          authorizationProbe: "available",
          trustedInstances: [],
        },
      ],
      privacy: {
        sourceProcessesExecuted: false,
        privateConfigurationRead: false,
        taskDataRead: false,
        hookConfigurationChanged: false,
      },
    });

    await act(async () => root.render(<ConnectorDiscoveryStatusCard />));
    await flush();
    expect(container.textContent).toContain(`${petDisplayName}已暂停接收`);
    expect(container.textContent).toContain("来源任务不受影响");
  });
});
