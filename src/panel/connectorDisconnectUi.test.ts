import { describe, expect, it } from "vitest";

import {
  presentDisconnectResult,
  type ConnectorDisconnectResultFacts,
  type ConnectorDisconnectResultStatus,
  type ConnectorDisconnectRecoveryAction,
} from "./connectorDisconnectUi";

const expected: Array<
  [ConnectorDisconnectResultStatus, ConnectorDisconnectRecoveryAction, string]
> = [
  ["disconnected", "none", "已安全断开"],
  [
    "disconnected_credential_cleanup_pending",
    "retry_credential_cleanup",
    "权限已撤销，凭据清理待完成",
  ],
  [
    "disconnected_local_maintenance_pending",
    "retry_local_maintenance",
    "权限已撤销，本地维护待完成",
  ],
  [
    "disconnected_credential_cleanup_and_local_maintenance_pending",
    "retry_credential_cleanup_and_local_maintenance",
    "权限已撤销，两项本地维护待完成",
  ],
  [
    "configuration_removal_failed_trust_not_attempted",
    "retry_disconnect_preview",
    "配置未移除，尚未撤销权限",
  ],
  [
    "trust_revocation_failed_still_active",
    "retry_trust_revocation",
    "配置已处理，但认证权限仍有效",
  ],
  ["trust_revocation_unverified", "recheck_authority", "无法确认认证权限状态"],
  ["no_change", "none", "无需更改"],
];

function result(
  status: ConnectorDisconnectResultStatus,
  recoveryAction: ConnectorDisconnectRecoveryAction,
): ConnectorDisconnectResultFacts {
  return {
    status,
    mode: "remove_configuration_and_revoke_trust",
    removedHandlers: 6,
    configurationWritePerformed: status === "disconnected",
    configurationBackupCreated: status === "disconnected",
    trustAuthorityRevoked: status.startsWith("disconnected"),
    trustAuthorityVerified: status !== "trust_revocation_unverified",
    credentialCleanupPending: status.includes("credential_cleanup"),
    localMaintenancePending: status.includes("local_maintenance"),
    retryRequired: recoveryAction !== "none",
    recoveryAction,
  };
}

describe("connector disconnect presentation", () => {
  it.each(expected)("maps %s to an exact recovery contract", (status, action, title) => {
    const presentation = presentDisconnectResult(result(status, action));
    expect(presentation.title).toBe(title);
    expect(`${presentation.title}${presentation.detail}${presentation.authorityCopy}`).not.toMatch(
      /builtin\.codex|00000000|[A-Z]:\\|USERPROFILE/,
    );
    expect(presentation.recoveryLabel === null).toBe(action === "none");
  });

  it("never describes post-revocation cleanup as live authority", () => {
    for (const [status, action] of expected.filter(([item]) => item.startsWith("disconnected_"))) {
      const presentation = presentDisconnectResult(result(status, action));
      expect(presentation.authorityCopy).toContain("安全边界已关闭");
      expect(presentation.authorityCopy).not.toContain("仍有效");
      expect(presentation.authorityCopy).not.toContain("仍有权限");
    }
  });
});
