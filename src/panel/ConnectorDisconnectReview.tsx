import { useEffect, useId, useState } from "react";
import { petText } from "../brand";

import {
  disconnectModeCopy,
  presentDisconnectResult,
  type ConnectorDisconnectMode,
  type ConnectorDisconnectRecoveryAction,
  type ConnectorDisconnectReviewState,
} from "./connectorDisconnectUi";
import "./connectorDisconnectReview.css";

interface ConnectorDisconnectReviewProps {
  state: ConnectorDisconnectReviewState;
  executionAvailable?: boolean;
  onModeChange?: (mode: ConnectorDisconnectMode) => void;
  onConfirm?: () => void;
  onRecovery?: (action: ConnectorDisconnectRecoveryAction) => void;
  onCancel?: () => void;
}
export function ConnectorDisconnectReview({
  state,
  executionAvailable = false,
  onModeChange,
  onConfirm,
  onRecovery,
  onCancel,
}: ConnectorDisconnectReviewProps) {
  const titleId = useId();
  const [acknowledged, setAcknowledged] = useState(false);
  const mode = state.phase === "preview" ? state.preview.mode : state.phase === "applying" ? state.mode : state.result.mode;

  useEffect(() => {
    setAcknowledged(false);
  }, [mode, state.phase]);

  return (
    <section className="connector-disconnect-review" aria-labelledby={titleId}>
      <header>
        <div>
          <strong id={titleId}>安全断开任务守望</strong>
          <small>{petText("圆圆不会用一个含糊按钮同时代表删配置和撤权限")}</small>
        </div>
        {onCancel && state.phase !== "applying" ? (
          <button className="connector-disconnect-close" type="button" onClick={onCancel}>
            关闭
          </button>
        ) : null}
      </header>

      {state.phase === "preview" ? (
        <PreviewStep
          preview={state.preview}
          acknowledged={acknowledged}
          executionAvailable={executionAvailable}
          onAcknowledged={setAcknowledged}
          onModeChange={onModeChange}
          onConfirm={onConfirm}
        />
      ) : state.phase === "applying" ? (
        <ApplyingStep state={state} />
      ) : (
        <ResultStep
          state={state}
          executionAvailable={executionAvailable}
          onRecovery={onRecovery}
        />
      )}

      <p className="connector-disconnect-invariant">
        {petText("无论结果如何，圆圆都不会停止、批准或改变来源工具中的任务。")}
      </p>
    </section>
  );
}

function PreviewStep({
  preview,
  acknowledged,
  executionAvailable,
  onAcknowledged,
  onModeChange,
  onConfirm,
}: {
  preview: Extract<ConnectorDisconnectReviewState, { phase: "preview" }>["preview"];
  acknowledged: boolean;
  executionAvailable: boolean;
  onAcknowledged: (checked: boolean) => void;
  onModeChange?: (mode: ConnectorDisconnectMode) => void;
  onConfirm?: () => void;
}) {
  const modeCopy = disconnectModeCopy[preview.mode];
  const ready = preview.status === "ready_for_confirmation";
  const canConfirm = ready && acknowledged && executionAvailable && Boolean(onConfirm);

  return (
    <div className="connector-disconnect-step">
      <fieldset className="connector-disconnect-modes">
        <legend>选择断开方式</legend>
        {(Object.keys(disconnectModeCopy) as ConnectorDisconnectMode[]).map((mode) => (
          <label key={mode}>
            <input
              type="radio"
              name="connector-disconnect-mode"
              value={mode}
              checked={preview.mode === mode}
              onChange={() => onModeChange?.(mode)}
            />
            <span>
              <strong>{disconnectModeCopy[mode].title}</strong>
              <small>{disconnectModeCopy[mode].detail}</small>
            </span>
          </label>
        ))}
      </fieldset>

      {preview.status === "configuration_manual_review" ? (
        <div className="connector-disconnect-notice danger" role="alert">
          <strong>Hook 配置需要人工复核</strong>
          <p>
            {petText("圆圆不会删除被改动、重复或无法证明所有权的内容。")}
            {preview.trustOnlyAvailable
              ? "如需立即关闭权限，请明确改选“仅撤销认证权限”。"
              : preview.trustAlreadyRevoked
                ? "认证权限已撤销；残留配置只能人工复核。"
                : "当前没有可安全执行的自动操作。"}
          </p>
        </div>
      ) : preview.status === "no_change" ? (
        <div className="connector-disconnect-notice neutral" role="status">
          <strong>无需更改</strong>
          <p>{preview.trustAlreadyRevoked ? "认证权限已经撤销。" : "所选方式已经满足。"}</p>
        </div>
      ) : (
        <div className="connector-disconnect-summary" aria-label="断开影响预览">
          <strong>{modeCopy.title}</strong>
          <ol>
            {preview.mode === "remove_configuration_and_revoke_trust" ? (
              <li>{petText(`精确移除 ${preview.expectedRemovedHandlers} 项仍由圆圆所有的 Hook，并创建配置备份。`)}</li>
            ) : (
              <li>跳过 Hook 配置读取与写入。</li>
            )}
            <li>撤销该实例全部认证权限；历史密钥不能重新使用。</li>
            <li>重新检查权限状态，再显示最终结果。</li>
          </ol>
        </div>
      )}

      {ready ? (
        <label className="connector-disconnect-acknowledgement">
          <input
            type="checkbox"
            checked={acknowledged}
            onChange={(event) => onAcknowledged(event.currentTarget.checked)}
          />
          <span>{modeCopy.acknowledgement}</span>
        </label>
      ) : null}

      {!executionAvailable ? (
        <p className="connector-disconnect-gate" role="note">
          当前仅验证交互契约。Bridge 签名、工具信任复核和安装升级门完成前，不开放执行。
        </p>
      ) : null}

      {ready ? (
        <button
          className="connector-disconnect-danger-button"
          type="button"
          disabled={!canConfirm}
          onClick={onConfirm}
        >
          确认安全断开
        </button>
      ) : null}
    </div>
  );
}

function ApplyingStep({
  state,
}: {
  state: Extract<ConnectorDisconnectReviewState, { phase: "applying" }>;
}) {
  const configurationCopy =
    state.configurationStage === "complete"
      ? petText("圆圆 Hook 已安全处理")
      : state.configurationStage === "skipped"
        ? "已按选择跳过 Hook 配置"
        : petText("正在复核并处理圆圆 Hook");
  const trustCopy =
    state.trustStage === "complete"
      ? "认证权限已撤销"
      : state.trustStage === "pending"
        ? "正在撤销并复核认证权限"
        : "等待配置阶段完成";
  return (
    <div className="connector-disconnect-step" aria-live="polite" aria-busy="true">
      <strong>正在按安全顺序断开</strong>
      <ol className="connector-disconnect-progress">
        <li data-state={state.configurationStage}>{configurationCopy}</li>
        <li data-state={state.trustStage}>{trustCopy}</li>
      </ol>
      <p>{petText("请不要关闭圆圆；来源工具中的任务不受影响。")}</p>
    </div>
  );
}

function ResultStep({
  state,
  executionAvailable,
  onRecovery,
}: {
  state: Extract<ConnectorDisconnectReviewState, { phase: "result" }>;
  executionAvailable: boolean;
  onRecovery?: (action: ConnectorDisconnectRecoveryAction) => void;
}) {
  const presentation = presentDisconnectResult(state.result);
  const canRecover =
    state.result.recoveryAction !== "none" &&
    state.result.retryRequired &&
    executionAvailable &&
    Boolean(onRecovery);
  return (
    <div
      className={`connector-disconnect-result ${presentation.tone}`}
      role={presentation.tone === "danger" ? "alert" : "status"}
      aria-live="polite"
    >
      <strong>{presentation.title}</strong>
      <p>{presentation.detail}</p>
      <p className="connector-disconnect-authority">{presentation.authorityCopy}</p>
      {presentation.recoveryLabel ? (
        <button
          type="button"
          disabled={!canRecover}
          onClick={() => onRecovery?.(state.result.recoveryAction)}
        >
          {presentation.recoveryLabel}
        </button>
      ) : null}
      {!executionAvailable && presentation.recoveryLabel ? (
        <p className="connector-disconnect-gate" role="note">
          恢复动作尚未接入正式产品入口。
        </p>
      ) : null}
    </div>
  );
}
