import { useCallback, useEffect, useState } from "react";

import {
  applyProjectHookInspection,
  cancelProjectHookInspection,
  discoverBuiltinConnectors,
  inspectConnectorHookConfig,
  selectProjectForHookInspection,
  type ConnectorHookConfigInspection,
  type ConnectorDiscoverySnapshot,
  type ConnectorDiscoveryStatus,
  type ConnectorInstallationChannel,
  type ProjectInspectionAuthorizationPreview,
  type ProjectInspectionResult,
} from "../lib/backend";

type InspectionState = ConnectorHookConfigInspection | "loading" | "failed";

type ProjectInspectionState =
  | "selecting"
  | "checking"
  | "failed"
  | { stage: "confirmation"; preview: ProjectInspectionAuthorizationPreview }
  | { stage: "result"; result: ProjectInspectionResult };

const connectorNames: Record<ConnectorDiscoveryStatus["kind"], string> = {
  codex: "Codex",
  claude_code: "Claude Code",
};

const channelNames: Record<ConnectorInstallationChannel, string> = {
  windows_desktop_app: "Windows 桌面应用",
  cli_on_path: "命令行工具",
  native_user_install: "本机用户安装",
};

function authorizationCopy(connector: ConnectorDiscoveryStatus): string {
  if (connector.authorizationProbe === "unavailable") {
    return "授权状态暂时无法读取";
  }
  if (connector.authorizationProbe === "unconfigured") {
    return "尚未授权圆圆守望";
  }
  const active = connector.trustedInstances.filter(
    (instance) => instance.authorizationState === "active",
  ).length;
  return active > 0
    ? `本机授权有效${connector.trustedInstances.length > 1 ? `（${active}/${connector.trustedInstances.length}）` : ""}`
    : "需要重新授权";
}

function installationCopy(connector: ConnectorDiscoveryStatus): string {
  if (connector.installationState === "not_detected") return "未检测到安装";
  return `检测到：${connector.installationChannels.map((channel) => channelNames[channel]).join("、")}`;
}

function toolTrustCopy(connector: ConnectorDiscoveryStatus): string {
  switch (connector.toolTrust.status) {
    case "verified":
      return "来源校验通过：程序签名与官方分发身份均有效";
    case "review_required":
      return "来源需要人工复核，暂不应启用真实任务守望";
    case "unavailable":
      return "来源校验暂时不可用，暂不应启用真实任务守望";
    default:
      return "尚无可校验的来源工具";
  }
}

function eventHealthCopy(connector: ConnectorDiscoveryStatus): string {
  switch (connector.eventHealth) {
    case "paused_authentication_failure":
      return "连续认证失败，圆圆已暂停接收；来源任务不受影响";
    case "unavailable":
      return "事件健康状态暂时无法读取";
    default:
      return "尚未收到可信任务事件";
  }
}

function hookInspectionCopy(inspection: InspectionState | undefined): string {
  if (inspection === "loading") return "正在只读检查用户级 Hook 配置…";
  if (inspection === "failed") return "暂时无法检查 Hook 配置，请稍后重试";
  if (!inspection) return "尚未检查 Hook 配置";
  if (inspection.status === "manual_review" || !inspection.preview) {
    return "配置路径、文件类型或大小需要人工复核；未作修改";
  }
  const preview = inspection.preview;
  if (preview.conflict !== "none" || preview.proposedAction === "manual_review") {
    return "发现需要人工复核的 Hook 配置冲突；未作修改";
  }
  if (preview.proposedAction === "no_change") {
    return `圆圆 Hook 与预期一致（${preview.exactHandlers}/${preview.expectedHandlers}）；未作修改`;
  }
  return `只读检查完成：已有 ${preview.exactHandlers} 项、缺少 ${preview.missingHandlers} 项；未作修改`;
}

function projectInspectionCopy(result: ProjectInspectionResult): string {
  if (result.status === "manual_review" || !result.preview) {
    return "项目 Hook 配置需要人工复核；未作修改";
  }
  if (result.preview.conflict !== "none" || result.preview.proposedAction === "manual_review") {
    return "项目与用户级 Hook 存在需要人工复核的关系；未作修改";
  }
  if (result.projectConfigurationFilesRead === 0) {
    return "已完成所选项目检查，未发现项目级 Hook 配置；未作修改";
  }
  return `已只读检查 ${result.projectConfigurationFilesRead} 个项目配置和 ${result.userConfigurationFilesRead} 个用户配置；未作修改`;
}

export function ConnectorDiscoveryStatusCard() {
  const [snapshot, setSnapshot] = useState<ConnectorDiscoverySnapshot | null>(null);
  const [loading, setLoading] = useState(true);
  const [failed, setFailed] = useState(false);
  const [showTrustPreview, setShowTrustPreview] = useState(false);
  const [inspections, setInspections] = useState<
    Partial<Record<ConnectorDiscoveryStatus["kind"], InspectionState>>
  >({});
  const [projectInspections, setProjectInspections] = useState<
    Partial<Record<ConnectorDiscoveryStatus["kind"], ProjectInspectionState>>
  >({});

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      setSnapshot(await discoverBuiltinConnectors());
      setFailed(false);
    } catch {
      setFailed(true);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const inspectHooks = useCallback(async (connector: ConnectorDiscoveryStatus) => {
    const instance = connector.trustedInstances.find(
      (item) => item.authorizationState === "active" && !item.legacyIdentity,
    );
    if (!instance) return;
    setInspections((current) => ({ ...current, [connector.kind]: "loading" }));
    try {
      const inspection = await inspectConnectorHookConfig(
        instance.connectorId,
        instance.sourceInstance,
      );
      setInspections((current) => ({ ...current, [connector.kind]: inspection }));
    } catch {
      setInspections((current) => ({ ...current, [connector.kind]: "failed" }));
    }
  }, []);

  const chooseProject = useCallback(async (connector: ConnectorDiscoveryStatus) => {
    const instance = connector.trustedInstances.find(
      (item) => item.authorizationState === "active" && !item.legacyIdentity,
    );
    if (!instance || connector.toolTrust.status !== "verified") return;
    setProjectInspections((current) => ({ ...current, [connector.kind]: "selecting" }));
    try {
      const selection = await selectProjectForHookInspection(
        instance.connectorId,
        instance.sourceInstance,
      );
      if (selection.status === "cancelled") {
        setProjectInspections((current) => {
          const next = { ...current };
          delete next[connector.kind];
          return next;
        });
      } else if (selection.preview) {
        setProjectInspections((current) => ({
          ...current,
          [connector.kind]: { stage: "confirmation", preview: selection.preview! },
        }));
      } else {
        setProjectInspections((current) => ({ ...current, [connector.kind]: "failed" }));
      }
    } catch {
      setProjectInspections((current) => ({ ...current, [connector.kind]: "failed" }));
    }
  }, []);

  const confirmProjectInspection = useCallback(
    async (kind: ConnectorDiscoveryStatus["kind"], preview: ProjectInspectionAuthorizationPreview) => {
      setProjectInspections((current) => ({ ...current, [kind]: "checking" }));
      try {
        const result = await applyProjectHookInspection(preview.confirmationToken);
        setProjectInspections((current) => ({
          ...current,
          [kind]: { stage: "result", result },
        }));
      } catch {
        setProjectInspections((current) => ({ ...current, [kind]: "failed" }));
      }
    },
    [],
  );

  const cancelProjectInspection = useCallback(
    async (kind: ConnectorDiscoveryStatus["kind"], confirmationToken: string) => {
      try {
        await cancelProjectHookInspection(confirmationToken);
      } finally {
        setProjectInspections((current) => {
          const next = { ...current };
          delete next[kind];
          return next;
        });
      }
    },
    [],
  );

  return (
    <section className="connector-status-section" aria-labelledby="connector-status-title">
      <div className="connector-status-heading">
        <div>
          <strong id="connector-status-title">任务守望连接器</strong>
          <small>只读发现 · 有限兼容 · 尚未修改任何 Hook</small>
        </div>
        <button className="ghost compact" type="button" disabled={loading} onClick={refresh}>
          {loading ? "正在检查…" : "重新检查"}
        </button>
      </div>

      {failed ? (
        <p className="connector-status-error" role="status">
          暂时无法读取连接器状态，提醒和桌面陪伴不受影响。
        </p>
      ) : snapshot ? (
        <div className="connector-status-list">
          {snapshot.connectors.map((connector) => {
            const projectState = projectInspections[connector.kind];
            const projectSelectionBusy =
              projectState === "selecting" ||
              projectState === "checking" ||
              (typeof projectState === "object" && projectState.stage === "confirmation");
            return (
            <article className="connector-status-item" key={connector.kind}>
              <div>
                <strong>{connectorNames[connector.kind]}</strong>
                <span>{installationCopy(connector)}</span>
              </div>
              <ul>
                <li>{toolTrustCopy(connector)}</li>
                <li>{authorizationCopy(connector)}</li>
                <li>{hookInspectionCopy(inspections[connector.kind])}</li>
                <li>{eventHealthCopy(connector)}</li>
              </ul>
              {connector.trustedInstances.some(
                (item) => item.authorizationState === "active" && !item.legacyIdentity,
              ) && (
                <button
                  className="ghost compact"
                  type="button"
                  disabled={inspections[connector.kind] === "loading"}
                  onClick={() => void inspectHooks(connector)}
                >
                  只读检查 Hook 配置
                </button>
              )}
              {connector.toolTrust.status === "verified" &&
                connector.trustedInstances.some(
                  (item) => item.authorizationState === "active" && !item.legacyIdentity,
                ) && (
                  <button
                    className="ghost compact"
                    type="button"
                    disabled={projectSelectionBusy}
                    onClick={() => void chooseProject(connector)}
                  >
                    {projectState === "selecting" ? "正在打开选择器…" : "选择项目进行只读检查"}
                  </button>
                )}
              {projectState === "checking" && (
                <p className="project-inspection-status" role="status">
                  正在只读检查所选项目的 Hook 配置…
                </p>
              )}
              {projectState === "failed" && (
                <p className="project-inspection-error" role="status">
                  项目检查未完成。目录、授权或来源状态可能已变化；没有读取任务，也没有修改文件。
                </p>
              )}
              {typeof projectState === "object" && projectState.stage === "confirmation" && (
                <div className="project-inspection-review" role="region" aria-label="项目检查确认">
                  <strong>所选项目文件夹已安全验证</strong>
                  <p>路径不会返回页面或保存。确认后只读取用户级与所选项目中固定的 Hook 配置，不读取代码、任务、对话或 Git 内容。</p>
                  <div>
                    <button
                      className="primary compact"
                      type="button"
                      onClick={() =>
                        void confirmProjectInspection(connector.kind, projectState.preview)
                      }
                    >
                      确认只读检查
                    </button>
                    <button
                      className="ghost compact"
                      type="button"
                      onClick={() =>
                        void cancelProjectInspection(
                          connector.kind,
                          projectState.preview.confirmationToken,
                        )
                      }
                    >
                      取消
                    </button>
                  </div>
                </div>
              )}
              {typeof projectState === "object" && projectState.stage === "result" && (
                <p className="project-inspection-status" role="status">
                  {projectInspectionCopy(projectState.result)}
                </p>
              )}
            </article>
          );})}
        </div>
      ) : null}

      <p className="connector-privacy-note">
        自动发现不会启动 Codex 或 Claude；来源校验使用 Windows 本地信任链和随圆圆发布的离线分发证据且不联网，也不会返回程序路径、哈希或证书材料。
        自动发现不会读取配置、会话、项目或任务内容。
        只有点击“只读检查 Hook 配置”后，才会读取对应工具的用户级 Hook 配置；只有再次通过原生选择器选择项目并确认，才会读取该项目固定的 Hook 设置。不会读取项目任务或代码正文，也不会写入文件或保存选择。
      </p>
      <button
        className="connector-preview-toggle"
        type="button"
        aria-expanded={showTrustPreview}
        onClick={() => setShowTrustPreview((current) => !current)}
      >
        {showTrustPreview ? "收起授权范围" : "查看未来授权范围"}
      </button>
      {showTrustPreview && (
        <div className="connector-trust-preview" role="region" aria-label="连接器授权范围预览">
          <strong>尚未执行任何变更</strong>
          <ul>
            <li>确认后只会创建圆圆专用的本机凭据与随机实例身份。</li>
            <li>密钥正文不会显示、导出或写入诊断。</li>
            <li>不会改变来源任务行为，也不会读取任务正文。</li>
            <li>当前预览不会安装、合并、覆盖或删除任何 Hook 配置。</li>
          </ul>
          <p>Bridge 尚未进入正式安装包，因此这里暂不提供确认执行。</p>
        </div>
      )}
    </section>
  );
}
