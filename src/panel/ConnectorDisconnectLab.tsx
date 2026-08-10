import { useState } from "react";

import { ConnectorDisconnectReview } from "./ConnectorDisconnectReview";
import type {
  ConnectorDisconnectMode,
  ConnectorDisconnectReviewState,
} from "./connectorDisconnectUi";
import "./connectorDisconnectLab.css";

type Scenario = "ready" | "conflict" | "applying" | "cleanup" | "still_active";

function stateFor(scenario: Scenario, mode: ConnectorDisconnectMode): ConnectorDisconnectReviewState {
  if (scenario === "ready" || scenario === "conflict") {
    const configurationConflict =
      scenario === "conflict" && mode === "remove_configuration_and_revoke_trust";
    return {
      phase: "preview",
      preview: {
        status: configurationConflict
          ? "configuration_manual_review"
          : "ready_for_confirmation",
        mode,
        expectedRemovedHandlers: mode === "remove_configuration_and_revoke_trust" ? 6 : 0,
        trustOnlyAvailable: true,
        trustAlreadyRevoked: false,
      },
    };
  }
  if (scenario === "applying") {
    return {
      phase: "applying",
      mode,
      configurationStage:
        mode === "remove_configuration_and_revoke_trust" ? "complete" : "skipped",
      trustStage: "pending",
    };
  }
  const cleanup = scenario === "cleanup";
  return {
    phase: "result",
    result: {
      status: cleanup
        ? "disconnected_credential_cleanup_pending"
        : "trust_revocation_failed_still_active",
      mode,
      removedHandlers: mode === "remove_configuration_and_revoke_trust" ? 6 : 0,
      configurationWritePerformed: mode === "remove_configuration_and_revoke_trust",
      configurationBackupCreated: mode === "remove_configuration_and_revoke_trust",
      trustAuthorityRevoked: cleanup,
      trustAuthorityVerified: true,
      credentialCleanupPending: cleanup,
      localMaintenancePending: false,
      retryRequired: true,
      recoveryAction: cleanup ? "retry_credential_cleanup" : "retry_trust_revocation",
    },
  };
}

export function ConnectorDisconnectLab() {
  const [scenario, setScenario] = useState<Scenario>("ready");
  const [mode, setMode] = useState<ConnectorDisconnectMode>(
    "remove_configuration_and_revoke_trust",
  );
  return (
    <main className="connector-disconnect-lab">
      <header>
        <h1>断开与恢复交互实验台</h1>
        <p>仅用于检查文案、键盘、读屏和窄屏布局；所有执行入口保持关闭。</p>
      </header>
      <nav aria-label="测试场景">
        {(
          ["ready", "conflict", "applying", "cleanup", "still_active"] as Scenario[]
        ).map((item) => (
          <button
            key={item}
            type="button"
            aria-pressed={scenario === item}
            onClick={() => setScenario(item)}
          >
            {item}
          </button>
        ))}
      </nav>
      <ConnectorDisconnectReview
        state={stateFor(scenario, mode)}
        onModeChange={setMode}
        onCancel={() => undefined}
      />
    </main>
  );
}
