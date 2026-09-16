// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { petDisplayName } from "../brand";

const backend = vi.hoisted(() => ({
  clearAiDiagnostics: vi.fn(),
  exportAiDiagnostics: vi.fn(),
  getAiSupervisorDiagnostics: vi.fn(),
  previewAiDiagnostics: vi.fn(),
  retryAiAfterFailure: vi.fn(),
}));

vi.mock("../lib/backend", () => ({
  ...backend,
  tauriAvailable: () => true,
}));

import { AiCompanionStatusCard } from "./AiCompanionStatus";

let container: HTMLDivElement;
let root: Root;

async function flush() {
  await act(async () => {
    await new Promise((resolve) => window.setTimeout(resolve, 0));
  });
}

describe("AI companion diagnostics", () => {
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

  it("stays hidden when the optional AI binary is not installed", async () => {
    backend.getAiSupervisorDiagnostics.mockResolvedValue({
      status: "unavailable",
      binaryPresent: false,
      localDiagnosticsPresent: false,
      canRetry: false,
      controlProtocolVersion: 1,
    });
    await act(async () => root.render(<AiCompanionStatusCard onNotice={vi.fn()} />));
    await flush();
    expect(container.textContent).toBe("");
  });

  it("explains an open circuit and allows one explicit recovery", async () => {
    backend.getAiSupervisorDiagnostics
      .mockResolvedValueOnce({
        status: "circuit_open",
        binaryPresent: true,
        localDiagnosticsPresent: false,
        canRetry: true,
        controlProtocolVersion: 1,
      })
      .mockResolvedValue({
        status: "starting",
        binaryPresent: true,
        localDiagnosticsPresent: false,
        canRetry: false,
        controlProtocolVersion: 1,
      });
    backend.retryAiAfterFailure.mockResolvedValue(true);
    const onNotice = vi.fn();
    await act(async () => root.render(<AiCompanionStatusCard onNotice={onNotice} />));
    await flush();
    expect(container.textContent).toContain("已暂停重试");
    expect(container.textContent).toContain("提醒功能不受影响");

    const retry = [...container.querySelectorAll("button")].find(
      (button) => button.textContent === "重新检查",
    )!;
    await act(async () => retry.click());
    await flush();
    expect(backend.retryAiAfterFailure).toHaveBeenCalledTimes(1);
    expect(onNotice).toHaveBeenCalledWith(`${petDisplayName}正在重新检查智能陪伴组件。`);
    expect(container.textContent).toContain("正在醒来");
    expect(
      [...container.querySelectorAll("button")].some(
        (button) => button.textContent === "重新检查",
      ),
    ).toBe(false);
    expect(container.textContent).toContain("查看诊断快照内容");
  });

  it("scans and saves a diagnostic snapshot only to a user-selected location", async () => {
    backend.getAiSupervisorDiagnostics.mockResolvedValue({
      status: "running",
      binaryPresent: true,
      localDiagnosticsPresent: false,
      canRetry: false,
      controlProtocolVersion: 1,
    });
    backend.exportAiDiagnostics.mockResolvedValue({
      status: "saved",
      fileName: "diagnostics-v1-1000.json",
      bytes: 320,
      schemaVersion: 1,
      sensitiveFieldsIncluded: false,
      sensitiveScanStatus: "clean",
      sensitiveScanVersion: 1,
      sensitiveScanChecks: 4,
      selectedPathReturned: false,
      internalCopyCreated: false,
      automaticUpload: false,
    });
    backend.previewAiDiagnostics.mockResolvedValue({
      schemaVersion: 1,
      estimatedBytes: 320,
      exportFileCount: 1,
      pendingFiles: 2,
      pendingBytes: 2048,
      quarantinedFiles: 0,
      diagnosticCodeCategories: 1,
      diagnosticOccurrences: 3,
      sensitiveFieldsIncluded: false,
      sensitiveScanStatus: "clean",
      sensitiveScanVersion: 1,
      sensitiveScanChecks: 4,
      selectedLocationRequired: true,
      internalCopyCreated: false,
      automaticUpload: false,
    });
    const onNotice = vi.fn();
    await act(async () => root.render(<AiCompanionStatusCard onNotice={onNotice} />));
    await flush();

    expect(backend.exportAiDiagnostics).not.toHaveBeenCalled();
    const previewButton = [...container.querySelectorAll("button")].find(
      (item) => item.textContent === "查看诊断快照内容",
    )!;
    await act(async () => previewButton.click());
    await flush();

    expect(backend.previewAiDiagnostics).toHaveBeenCalledTimes(1);
    expect(backend.exportAiDiagnostics).not.toHaveBeenCalled();
    expect(container.textContent).toContain("不包含：任务内容");
    expect(container.textContent).toContain("不会自动上传");
    expect(container.textContent).toContain("独立敏感扫描 v1：已通过");
    expect(container.textContent).toContain("Windows 选择本机保存位置");
    let confirm = [...container.querySelectorAll("button")].find(
      (item) => item.textContent === "选择保存位置",
    )!;
    expect(document.activeElement).toBe(confirm);
    const cancel = [...container.querySelectorAll("button")].find(
      (item) => item.textContent === "取消",
    )!;
    await act(async () => cancel.click());
    const restoredPreviewButton = [...container.querySelectorAll("button")].find(
      (item) => item.textContent === "查看诊断快照内容",
    )!;
    expect(document.activeElement).toBe(restoredPreviewButton);

    await act(async () => restoredPreviewButton.click());
    await flush();
    expect(backend.previewAiDiagnostics).toHaveBeenCalledTimes(2);
    confirm = [...container.querySelectorAll("button")].find(
      (item) => item.textContent === "选择保存位置",
    )!;
    expect(document.activeElement).toBe(confirm);
    await act(async () => confirm.click());
    await flush();
    expect(backend.exportAiDiagnostics).toHaveBeenCalledTimes(1);
    expect(onNotice).toHaveBeenCalledWith(
      "已将诊断快照 diagnostics-v1-1000.json（320 字节）保存到你选择的位置。独立敏感扫描已通过；应用内未保留副本，也不会自动上传。",
    );
  });

  it("keeps the reviewed preview open when the native save picker is cancelled", async () => {
    backend.getAiSupervisorDiagnostics.mockResolvedValue({
      status: "running",
      binaryPresent: true,
      localDiagnosticsPresent: false,
      canRetry: false,
      controlProtocolVersion: 1,
    });
    backend.previewAiDiagnostics.mockResolvedValue({
      schemaVersion: 1,
      estimatedBytes: 320,
      exportFileCount: 1,
      pendingFiles: 0,
      pendingBytes: 0,
      quarantinedFiles: 0,
      diagnosticCodeCategories: 0,
      diagnosticOccurrences: 0,
      sensitiveFieldsIncluded: false,
      sensitiveScanStatus: "clean",
      sensitiveScanVersion: 1,
      sensitiveScanChecks: 4,
      selectedLocationRequired: true,
      internalCopyCreated: false,
      automaticUpload: false,
    });
    backend.exportAiDiagnostics.mockResolvedValue({
      status: "cancelled",
      fileName: null,
      bytes: 0,
      schemaVersion: 1,
      sensitiveFieldsIncluded: false,
      sensitiveScanStatus: "clean",
      sensitiveScanVersion: 1,
      sensitiveScanChecks: 4,
      selectedPathReturned: false,
      internalCopyCreated: false,
      automaticUpload: false,
    });
    const onNotice = vi.fn();
    await act(async () => root.render(<AiCompanionStatusCard onNotice={onNotice} />));
    await flush();
    const previewButton = [...container.querySelectorAll("button")].find(
      (item) => item.textContent === "查看诊断快照内容",
    )!;
    await act(async () => previewButton.click());
    await flush();
    const choose = [...container.querySelectorAll("button")].find(
      (item) => item.textContent === "选择保存位置",
    )!;
    await act(async () => choose.click());
    await flush();

    expect(onNotice).toHaveBeenCalledWith("已取消保存，未创建诊断快照。");
    expect(container.textContent).toContain("保存前确认");
    expect(container.textContent).toContain("选择保存位置");
  });

  it("never exposes an internal diagnostic error to the notice", async () => {
    backend.getAiSupervisorDiagnostics.mockResolvedValue({
      status: "running",
      binaryPresent: true,
      localDiagnosticsPresent: false,
      canRetry: false,
      controlProtocolVersion: 1,
    });
    backend.exportAiDiagnostics.mockRejectedValue(
      new Error("C:\\Users\\private\\bridge-spool secret-token"),
    );
    backend.previewAiDiagnostics.mockResolvedValue({
      schemaVersion: 1,
      estimatedBytes: 320,
      exportFileCount: 1,
      pendingFiles: 0,
      pendingBytes: 0,
      quarantinedFiles: 0,
      diagnosticCodeCategories: 0,
      diagnosticOccurrences: 0,
      sensitiveFieldsIncluded: false,
      sensitiveScanStatus: "clean",
      sensitiveScanVersion: 1,
      sensitiveScanChecks: 4,
      selectedLocationRequired: true,
      internalCopyCreated: false,
      automaticUpload: false,
    });
    const onNotice = vi.fn();
    await act(async () => root.render(<AiCompanionStatusCard onNotice={onNotice} />));
    await flush();

    const button = [...container.querySelectorAll("button")].find(
      (item) => item.textContent === "查看诊断快照内容",
    )!;
    await act(async () => button.click());
    await flush();
    const confirm = [...container.querySelectorAll("button")].find(
      (item) => item.textContent === "选择保存位置",
    )!;
    await act(async () => confirm.click());
    await flush();

    expect(onNotice).toHaveBeenCalledWith(
      "诊断快照未保存，请选择新的本机 JSON 文件位置后重试。",
    );
    expect(onNotice.mock.calls.flat().join(" ")).not.toContain("private");
    expect(onNotice.mock.calls.flat().join(" ")).not.toContain("secret-token");
  });

  it("keeps cleanup available for residual data after the optional binary is removed", async () => {
    backend.getAiSupervisorDiagnostics
      .mockResolvedValueOnce({
        status: "unavailable",
        binaryPresent: false,
        localDiagnosticsPresent: true,
        canRetry: false,
        controlProtocolVersion: 1,
      })
      .mockResolvedValue({
        status: "unavailable",
        binaryPresent: false,
        localDiagnosticsPresent: false,
        canRetry: false,
        controlProtocolVersion: 1,
      });
    backend.clearAiDiagnostics.mockResolvedValue({
      removedSnapshotFiles: 2,
      removedCounterFiles: 1,
    });
    const onNotice = vi.fn();
    await act(async () => root.render(<AiCompanionStatusCard onNotice={onNotice} />));
    await flush();

    expect(container.textContent).not.toContain("查看诊断快照内容");
    const clear = [...container.querySelectorAll("button")].find(
      (item) => item.textContent === "清除本地诊断数据",
    )!;
    clear.focus();
    await act(async () => clear.click());
    expect(backend.clearAiDiagnostics).not.toHaveBeenCalled();
    expect(container.textContent).toContain("不会删除任务队列、提醒或备份");
    let confirm = [...container.querySelectorAll("button")].find(
      (item) => item.textContent === "确认清除",
    )!;
    expect(document.activeElement).toBe(confirm);
    const keep = [...container.querySelectorAll("button")].find(
      (item) => item.textContent === "保留",
    )!;
    await act(async () => keep.click());
    const restoredClear = [...container.querySelectorAll("button")].find(
      (item) => item.textContent === "清除本地诊断数据",
    )!;
    expect(document.activeElement).toBe(restoredClear);

    await act(async () => restoredClear.click());
    confirm = [...container.querySelectorAll("button")].find(
      (item) => item.textContent === "确认清除",
    )!;
    expect(document.activeElement).toBe(confirm);
    await act(async () => confirm.click());
    await flush();

    expect(backend.clearAiDiagnostics).toHaveBeenCalledTimes(1);
    expect(onNotice).toHaveBeenCalledWith("已清除 2 份诊断快照和 1 个计数文件。");
    expect(container.textContent).toBe("");
  });
});
