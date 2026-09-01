// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { petDisplayName } from "../brand";
import { ConnectorDisconnectReview } from "./ConnectorDisconnectReview";
import type {
  ConnectorDisconnectResultFacts,
  ConnectorDisconnectReviewState,
} from "./connectorDisconnectUi";

let container: HTMLDivElement;
let root: Root;

const readyState: ConnectorDisconnectReviewState = {
  phase: "preview",
  preview: {
    status: "ready_for_confirmation",
    mode: "remove_configuration_and_revoke_trust",
    expectedRemovedHandlers: 6,
    trustOnlyAvailable: true,
    trustAlreadyRevoked: false,
  },
};

function result(overrides: Partial<ConnectorDisconnectResultFacts>): ConnectorDisconnectResultFacts {
  return {
    status: "disconnected",
    mode: "remove_configuration_and_revoke_trust",
    removedHandlers: 6,
    configurationWritePerformed: true,
    configurationBackupCreated: true,
    trustAuthorityRevoked: true,
    trustAuthorityVerified: true,
    credentialCleanupPending: false,
    localMaintenancePending: false,
    retryRequired: false,
    recoveryAction: "none",
    ...overrides,
  };
}

describe("connector disconnect review", () => {
  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
  });

  it("is closed by default and requires explicit acknowledgement", async () => {
    const onConfirm = vi.fn();
    await act(async () => root.render(<ConnectorDisconnectReview state={readyState} onConfirm={onConfirm} />));
    const radios = [...container.querySelectorAll<HTMLInputElement>('input[type="radio"]')];
    expect(radios).toHaveLength(2);
    expect(container.textContent).toContain(`先精确移除仍由${petDisplayName}所有的 Hook`);
    expect(container.textContent).toContain("不会读取或修改 Hook 配置");
    expect(container.textContent).toContain("Bridge 签名、工具信任复核和安装升级门完成前，不开放执行");
    expect(container.textContent).not.toMatch(/builtin\.codex|00000000|[A-Z]:\\/);

    const confirmation = container.querySelector<HTMLInputElement>('input[type="checkbox"]')!;
    const button = [...container.querySelectorAll<HTMLButtonElement>("button")].find((item) =>
      item.textContent?.includes("确认安全断开"),
    )!;
    expect(button.disabled).toBe(true);
    await act(async () => confirmation.click());
    expect(button.disabled).toBe(true);
    expect(onConfirm).not.toHaveBeenCalled();
  });

  it("enables an approved execution only after acknowledgement and resets it on mode change", async () => {
    const onConfirm = vi.fn();
    const onModeChange = vi.fn();
    await act(async () =>
      root.render(
        <ConnectorDisconnectReview
          state={readyState}
          executionAvailable
          onConfirm={onConfirm}
          onModeChange={onModeChange}
        />,
      ),
    );
    const checkbox = container.querySelector<HTMLInputElement>('input[type="checkbox"]')!;
    const confirm = [...container.querySelectorAll<HTMLButtonElement>("button")].find((item) =>
      item.textContent?.includes("确认安全断开"),
    )!;
    await act(async () => checkbox.click());
    expect(confirm.disabled).toBe(false);
    await act(async () => confirm.click());
    expect(onConfirm).toHaveBeenCalledTimes(1);

    const trustOnly = container.querySelector<HTMLInputElement>(
      'input[value="revoke_trust_only"]',
    )!;
    await act(async () => trustOnly.click());
    expect(onModeChange).toHaveBeenCalledWith("revoke_trust_only");
  });

  it("blocks ambiguous configuration removal and offers only the explicit trust-only choice", async () => {
    const state: ConnectorDisconnectReviewState = {
      phase: "preview",
      preview: {
        ...readyState.preview,
        status: "configuration_manual_review",
      },
    };
    await act(async () => root.render(<ConnectorDisconnectReview state={state} />));
    expect(container.querySelector('[role="alert"]')?.textContent).toContain(
      `${petDisplayName}不会删除被改动、重复或无法证明所有权的内容`,
    );
    expect(container.textContent).toContain("明确改选“仅撤销认证权限”");
    expect(container.querySelector('input[type="checkbox"]')).toBeNull();
    expect(container.textContent).not.toContain("确认安全断开");
  });

  it("announces ordered stages without implying the source task was stopped", async () => {
    const state: ConnectorDisconnectReviewState = {
      phase: "applying",
      mode: "remove_configuration_and_revoke_trust",
      configurationStage: "complete",
      trustStage: "pending",
    };
    await act(async () => root.render(<ConnectorDisconnectReview state={state} />));
    const live = container.querySelector('[aria-live="polite"]')!;
    expect(live.textContent?.indexOf(`${petDisplayName} Hook 已安全处理`)).toBeLessThan(
      live.textContent!.indexOf("正在撤销并复核认证权限"),
    );
    expect(container.textContent).toContain("来源工具中的任务不受影响");
  });

  it("keeps recovery disabled until the product gate opens and emits only the typed action", async () => {
    const state: ConnectorDisconnectReviewState = {
      phase: "result",
      result: result({
        status: "disconnected_credential_cleanup_pending",
        credentialCleanupPending: true,
        retryRequired: true,
        recoveryAction: "retry_credential_cleanup",
      }),
    };
    const onRecovery = vi.fn();
    await act(async () =>
      root.render(<ConnectorDisconnectReview state={state} onRecovery={onRecovery} />),
    );
    let button = [...container.querySelectorAll<HTMLButtonElement>("button")].find((item) =>
      item.textContent?.includes("重试凭据清理"),
    )!;
    expect(button.disabled).toBe(true);
    expect(container.textContent).toContain("安全边界已关闭");

    await act(async () =>
      root.render(
        <ConnectorDisconnectReview
          state={state}
          executionAvailable
          onRecovery={onRecovery}
        />,
      ),
    );
    button = [...container.querySelectorAll<HTMLButtonElement>("button")].find((item) =>
      item.textContent?.includes("重试凭据清理"),
    )!;
    expect(button.disabled).toBe(false);
    await act(async () => button.click());
    expect(onRecovery).toHaveBeenCalledWith("retry_credential_cleanup");
  });
});
