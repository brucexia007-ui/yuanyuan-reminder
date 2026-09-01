export type ConnectorDisconnectMode =
  | "remove_configuration_and_revoke_trust"
  | "revoke_trust_only";

export type ConnectorDisconnectPreviewStatus =
  | "ready_for_confirmation"
  | "configuration_manual_review"
  | "no_change";

export type ConnectorDisconnectResultStatus =
  | "disconnected"
  | "disconnected_credential_cleanup_pending"
  | "disconnected_local_maintenance_pending"
  | "disconnected_credential_cleanup_and_local_maintenance_pending"
  | "configuration_removal_failed_trust_not_attempted"
  | "trust_revocation_failed_still_active"
  | "trust_revocation_unverified"
  | "no_change";

export type ConnectorDisconnectRecoveryAction =
  | "none"
  | "retry_disconnect_preview"
  | "retry_trust_revocation"
  | "retry_credential_cleanup"
  | "retry_local_maintenance"
  | "retry_credential_cleanup_and_local_maintenance"
  | "recheck_authority";

export interface ConnectorDisconnectPreviewFacts {
  status: ConnectorDisconnectPreviewStatus;
  mode: ConnectorDisconnectMode;
  expectedRemovedHandlers: number;
  trustOnlyAvailable: boolean;
  trustAlreadyRevoked: boolean;
}

export interface ConnectorDisconnectResultFacts {
  status: ConnectorDisconnectResultStatus;
  mode: ConnectorDisconnectMode;
  removedHandlers: number;
  configurationWritePerformed: boolean;
  configurationBackupCreated: boolean;
  trustAuthorityRevoked: boolean;
  trustAuthorityVerified: boolean;
  credentialCleanupPending: boolean;
  localMaintenancePending: boolean;
  retryRequired: boolean;
  recoveryAction: ConnectorDisconnectRecoveryAction;
}

export type ConnectorDisconnectReviewState =
  | {
      phase: "preview";
      preview: ConnectorDisconnectPreviewFacts;
    }
  | {
      phase: "applying";
      mode: ConnectorDisconnectMode;
      configurationStage: "pending" | "complete" | "skipped";
      trustStage: "waiting" | "pending" | "complete";
    }
  | {
      phase: "result";
      result: ConnectorDisconnectResultFacts;
    };

export interface DisconnectResultPresentation {
  tone: "success" | "warning" | "danger" | "neutral";
  title: string;
  detail: string;
  authorityCopy: string;
  recoveryLabel: string | null;
}

export const disconnectModeCopy: Record<
  ConnectorDisconnectMode,
  { title: string; detail: string; acknowledgement: string }
> = {
  remove_configuration_and_revoke_trust: {
    title: petText("移除圆圆 Hook，并撤销认证权限"),
    detail: petText("先精确移除仍由圆圆所有的 Hook；只有配置阶段成功，才会撤销该实例的认证权限。"),
    acknowledgement: petText("我已确认：这会移除上方列出的圆圆 Hook，并撤销该实例的认证权限。"),
  },
  revoke_trust_only: {
    title: "仅撤销认证权限",
    detail: petText("不会读取或修改 Hook 配置。残留 Hook 可能仍被来源工具调用，但无法取得有效密钥或向圆圆提交可信事件。"),
    acknowledgement: "我已确认：立即撤销该实例的认证权限，并保留现有 Hook 配置不变。",
  },
};

export function presentDisconnectResult(
  result: ConnectorDisconnectResultFacts,
): DisconnectResultPresentation {
  switch (result.status) {
    case "disconnected":
      return {
        tone: "success",
        title: "已安全断开",
        detail: result.configurationWritePerformed
          ? petText(`已移除 ${result.removedHandlers} 项圆圆 Hook${result.configurationBackupCreated ? "，并已创建配置备份" : ""}。`)
          : "未修改 Hook 配置。",
        authorityCopy: "认证权限已经复核为撤销状态。",
        recoveryLabel: null,
      };
    case "disconnected_credential_cleanup_pending":
      return {
        tone: "warning",
        title: "权限已撤销，凭据清理待完成",
        detail: petText("该实例已经不能提交可信事件；一个或多个仅属于圆圆的旧凭据仍需重试清理。"),
        authorityCopy: "安全边界已关闭；认证权限已复核为撤销状态。",
        recoveryLabel: "重试凭据清理",
      };
    case "disconnected_local_maintenance_pending":
      return {
        tone: "warning",
        title: "权限已撤销，本地维护待完成",
        detail: "认证权限已关闭，但信任库的本地访问控制仍需重新应用。",
        authorityCopy: "安全边界已关闭；本地维护失败不会改变撤权结论。",
        recoveryLabel: "重试本地维护",
      };
    case "disconnected_credential_cleanup_and_local_maintenance_pending":
      return {
        tone: "warning",
        title: "权限已撤销，两项本地维护待完成",
        detail: "旧凭据清理和信任库访问控制都需要重试；两项操作都不会重新授权。",
        authorityCopy: "安全边界已关闭，来源任务不受影响。",
        recoveryLabel: "重试两项本地维护",
      };
    case "configuration_removal_failed_trust_not_attempted":
      return {
        tone: "danger",
        title: "配置未移除，尚未撤销权限",
        detail: "配置在确认后发生变化或无法安全写入，因此没有擅自继续断权。请重新检查差异，或明确改选“仅撤销认证权限”。",
        authorityCopy: "当前不能宣称已经断开。",
        recoveryLabel: "重新检查断开内容",
      };
    case "trust_revocation_failed_still_active":
      return {
        tone: "danger",
        title: "配置已处理，但认证权限仍有效",
        detail: "不要重复删除配置；下一步只重试撤销认证权限。",
        authorityCopy: petText("在复核为撤销前，圆圆持续显示此警告。"),
        recoveryLabel: "仅重试撤销权限",
      };
    case "trust_revocation_unverified":
      return {
        tone: "danger",
        title: "无法确认认证权限状态",
        detail: petText("信任库暂时不可读，圆圆不会把未知状态显示为成功。"),
        authorityCopy: "请先重新检查权限状态；不要根据 Hook 是否存在推断权限。",
        recoveryLabel: "重新检查权限状态",
      };
    case "no_change":
      return {
        tone: "neutral",
        title: "无需更改",
        detail: "所选断开方式已经满足。",
        authorityCopy: result.trustAuthorityVerified
          ? "认证权限已经复核为撤销状态。"
          : "没有执行新的变更。",
        recoveryLabel: null,
      };
  }
}
import { petText } from "../brand";
