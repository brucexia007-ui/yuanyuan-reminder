import { useCallback, useEffect, useRef, useState } from "react";

import {
  clearAiDiagnostics,
  exportAiDiagnostics,
  getAiSupervisorDiagnostics,
  previewAiDiagnostics,
  retryAiAfterFailure,
  tauriAvailable,
  type AiSupervisorDiagnostics,
  type AiSupervisorStatus,
  type DiagnosticPreviewResult,
} from "../lib/backend";
import { petText } from "../brand";

const statusCopy: Record<
  AiSupervisorStatus,
  { label: string; description: string }
> = {
  unavailable: {
    label: "暂时不可用",
    description: "智能陪伴组件没有启动，提醒和桌面陪伴仍会照常工作。",
  },
  starting: {
    label: "正在醒来",
    description: petText("圆圆正在检查智能陪伴组件，请稍候。"),
  },
  running: {
    label: "运行正常",
    description: "智能陪伴实验组件已就绪，不会读取未授权的内容。",
  },
  backing_off: {
    label: "稍后重试",
    description: petText("组件刚才没有正常启动，圆圆会短暂等待后再试。"),
  },
  circuit_open: {
    label: "已暂停重试",
    description: petText("组件连续启动失败，圆圆已停止自动重试，提醒功能不受影响。"),
  },
  stopped: {
    label: "已经停止",
    description: petText("智能陪伴组件已停止，下次启动圆圆时会重新检查。"),
  },
};

function developmentPreview(): AiSupervisorDiagnostics | null {
  if (!import.meta.env.DEV || tauriAvailable()) return null;
  const status = new URLSearchParams(window.location.search).get("aiDiagnostics");
  if (!status || !(status in statusCopy)) return null;
  return {
    status: status as AiSupervisorStatus,
    binaryPresent: true,
    localDiagnosticsPresent: false,
    canRetry: status === "circuit_open",
    controlProtocolVersion: 1,
  };
}

async function loadDiagnosticPreview(): Promise<DiagnosticPreviewResult> {
  if (import.meta.env.DEV && !tauriAvailable()) {
    return {
      schemaVersion: 1,
      estimatedBytes: 428,
      exportFileCount: 1,
      pendingFiles: 3,
      pendingBytes: 12_480,
      quarantinedFiles: 1,
      diagnosticCodeCategories: 2,
      diagnosticOccurrences: 4,
      sensitiveFieldsIncluded: false,
      sensitiveScanStatus: "clean",
      sensitiveScanVersion: 1,
      sensitiveScanChecks: 4,
      selectedLocationRequired: true,
      internalCopyCreated: false,
      automaticUpload: false,
    };
  }
  return previewAiDiagnostics();
}

export function AiCompanionStatusCard({
  onNotice,
}: {
  onNotice: (notice: string) => void;
}) {
  const [diagnostics, setDiagnostics] =
    useState<AiSupervisorDiagnostics | null>(developmentPreview);
  const [retrying, setRetrying] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [previewing, setPreviewing] = useState(false);
  const [preview, setPreview] = useState<DiagnosticPreviewResult | null>(null);
  const [confirmingClear, setConfirmingClear] = useState(false);
  const [clearing, setClearing] = useState(false);
  const previewTriggerRef = useRef<HTMLButtonElement>(null);
  const previewConfirmRef = useRef<HTMLButtonElement>(null);
  const previewWasOpen = useRef(false);
  const clearTriggerRef = useRef<HTMLButtonElement>(null);
  const clearConfirmRef = useRef<HTMLButtonElement>(null);
  const clearWasOpen = useRef(false);

  const refresh = useCallback(async () => {
    const next = await getAiSupervisorDiagnostics();
    setDiagnostics(next);
  }, []);

  useEffect(() => {
    if (!tauriAvailable()) return;
    let active = true;
    let timer = 0;
    const load = async () => {
      try {
        const next = await getAiSupervisorDiagnostics();
        if (active) {
          setDiagnostics(next);
          if (next.binaryPresent) {
            timer = window.setTimeout(() => void load(), 2_000);
          }
        }
      } catch {
        // Diagnostics are optional and must never make settings unusable.
      }
    };
    void load();
    return () => {
      active = false;
      window.clearTimeout(timer);
    };
  }, []);

  useEffect(() => {
    if (preview) {
      previewWasOpen.current = true;
      previewConfirmRef.current?.focus();
    } else if (previewWasOpen.current) {
      previewWasOpen.current = false;
      previewTriggerRef.current?.focus();
    }
  }, [preview]);

  useEffect(() => {
    if (confirmingClear) {
      clearWasOpen.current = true;
      clearConfirmRef.current?.focus();
    } else if (clearWasOpen.current) {
      clearWasOpen.current = false;
      clearTriggerRef.current?.focus();
    }
  }, [confirmingClear]);

  if (
    !diagnostics ||
    (!diagnostics.binaryPresent && !diagnostics.localDiagnosticsPresent)
  ) {
    return null;
  }

  const copy = statusCopy[diagnostics.status];
  return (
    <section className="ai-status-section" aria-labelledby="ai-status-title">
      <div className="ai-status-heading">
        <div>
          <strong id="ai-status-title">智能陪伴实验组件</strong>
          <small>本地独立运行 · 控制协议 v{diagnostics.controlProtocolVersion}</small>
        </div>
        <span
          className={`ai-status-badge status-${diagnostics.status}`}
          role="status"
          aria-live="polite"
        >
          {copy.label}
        </span>
      </div>
      <p>{copy.description}</p>
      {diagnostics.binaryPresent && !preview && (
        <button
          ref={previewTriggerRef}
          className="secondary compact"
          type="button"
          disabled={previewing}
          aria-busy={previewing}
          onClick={async () => {
            setPreviewing(true);
            try {
              setPreview(await loadDiagnosticPreview());
            } catch {
              onNotice("诊断快照预览失败，请稍后再试。");
            } finally {
              setPreviewing(false);
            }
          }}
        >
          {previewing ? "正在检查…" : "查看诊断快照内容"}
        </button>
      )}
      {preview && (
        <div
          className="diagnostic-preview"
          role="region"
          aria-label="诊断快照预览"
          aria-busy={exporting}
        >
          <strong>保存前确认</strong>
          <p>
            Schema v{preview.schemaVersion} · 将保存 {preview.exportFileCount} 个 JSON 文件 ·
            预计 {preview.estimatedBytes} 字节
          </p>
          <p>
            独立敏感扫描 v{preview.sensitiveScanVersion}：已通过
            （{preview.sensitiveScanChecks} 项检查）。
          </p>
          <p>
            包含：组件状态、协议版本、{preview.diagnosticCodeCategories} 类固定错误
            （共 {preview.diagnosticOccurrences} 次）、待处理 {preview.pendingFiles} 个/
            {preview.pendingBytes} 字节、隔离 {preview.quarantinedFiles} 个。
          </p>
          <p>
            不包含：任务内容、工作区路径、用户名、提示词、代码、凭据或倾诉内容；不会自动上传。
          </p>
          <p>{petText("确认后由 Windows 选择本机保存位置；圆圆不会在应用目录额外保留副本。")}</p>
          <div className="diagnostic-actions">
            <button
              ref={previewConfirmRef}
              className="primary compact"
              type="button"
              disabled={exporting}
              onClick={async () => {
                setExporting(true);
                try {
                  const result = await exportAiDiagnostics();
                  if (result.status === "cancelled") {
                    onNotice("已取消保存，未创建诊断快照。");
                    return;
                  }
                  if (!result.fileName) {
                    throw new Error("diagnostic export did not return a file name");
                  }
                  onNotice(
                    `已将诊断快照 ${result.fileName}（${result.bytes} 字节）保存到你选择的位置。独立敏感扫描已通过；应用内未保留副本，也不会自动上传。`,
                  );
                  setPreview(null);
                  await refresh();
                } catch {
                  onNotice("诊断快照未保存，请选择新的本机 JSON 文件位置后重试。");
                } finally {
                  setExporting(false);
                }
              }}
            >
              {exporting ? "正在保存…" : "选择保存位置"}
            </button>
            <button
              className="ghost compact"
              type="button"
              disabled={exporting}
              onClick={() => setPreview(null)}
            >
              取消
            </button>
          </div>
        </div>
      )}
      {diagnostics.localDiagnosticsPresent && !confirmingClear && (
        <button
          ref={clearTriggerRef}
          className="ghost compact"
          type="button"
          onClick={() => setConfirmingClear(true)}
        >
          清除本地诊断数据
        </button>
      )}
      {confirmingClear && (
        <div className="diagnostic-clear-confirm" role="alert">
          <p>只会删除诊断快照和固定错误计数，不会删除任务队列、提醒或备份。</p>
          <div className="diagnostic-actions">
            <button
              ref={clearConfirmRef}
              className="danger compact"
              type="button"
              disabled={clearing}
              aria-busy={clearing}
              onClick={async () => {
                setClearing(true);
                try {
                  const result = await clearAiDiagnostics();
                  onNotice(
                    `已清除 ${result.removedSnapshotFiles} 份诊断快照和 ${result.removedCounterFiles} 个计数文件。`,
                  );
                  setPreview(null);
                  setConfirmingClear(false);
                  await refresh();
                } catch {
                  onNotice("诊断数据清理失败，请稍后再试。");
                } finally {
                  setClearing(false);
                }
              }}
            >
              {clearing ? "正在清理…" : "确认清除"}
            </button>
            <button
              className="ghost compact"
              type="button"
              disabled={clearing}
              onClick={() => setConfirmingClear(false)}
            >
              保留
            </button>
          </div>
        </div>
      )}
      {diagnostics.canRetry && (
        <button
          className="primary compact"
          type="button"
          disabled={retrying}
          onClick={async () => {
            setRetrying(true);
            try {
              const accepted = await retryAiAfterFailure();
              onNotice(
                accepted
                  ? petText("圆圆正在重新检查智能陪伴组件。")
                  : "组件当前不需要手动恢复。",
              );
              await refresh();
            } catch (error) {
              onNotice(`组件恢复失败：${String(error)}`);
            } finally {
              setRetrying(false);
            }
          }}
        >
          {retrying ? "正在重试…" : "重新检查"}
        </button>
      )}
    </section>
  );
}
