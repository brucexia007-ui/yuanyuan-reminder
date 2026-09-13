// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import capability from "../../src-tauri/capabilities/panel-confirmation.json";
const desktop = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: desktop.invoke }));
import { confirmAction } from "./confirmation";

afterEach(() => { vi.unstubAllGlobals(); desktop.invoke.mockReset(); });
it("supports browser confirmation but rejects truthy non-consent values", async () => {
  for (const value of [false, undefined, null, "true", 1, {}]) {
    vi.stubGlobal("confirm", vi.fn(() => value));
    expect(await confirmAction("确认？")).toBe(false);
  }
  vi.stubGlobal("confirm", vi.fn(() => true));
  expect(await confirmAction("确认？")).toBe(true);
});
it("waits for an asynchronous browser confirmation without approving an unresolved Promise", async () => {
  let resolve!: (value: boolean) => void;
  vi.stubGlobal("confirm", vi.fn(() => new Promise<boolean>(r => { resolve = r; })));
  const completed = vi.fn();
  const pending = confirmAction("删除？").then(completed);
  await Promise.resolve();
  expect(completed).not.toHaveBeenCalled();
  resolve(false);
  await pending;
  expect(completed).toHaveBeenCalledWith(false);
  vi.stubGlobal("confirm", vi.fn(async () => true));
  expect(await confirmAction("删除？")).toBe(true);
});
it("propagates dialog errors without approving the action", async () => {
  vi.stubGlobal("confirm", vi.fn(async () => { throw new Error("dialog denied"); }));
  await expect(confirmAction("恢复？")).rejects.toThrow("dialog denied");
});
it("uses the native message command with OkCancel and waits for an explicit Ok", async () => {
  vi.stubGlobal("__TAURI_INTERNALS__", {});
  const legacy = vi.fn(() => true);
  vi.stubGlobal("confirm", legacy);
  let resolve!: (value: string) => void;
  desktop.invoke.mockImplementation(() => new Promise<string>(r => { resolve = r; }));
  const completed = vi.fn();
  const pending = confirmAction("恢复测试备份？").then(completed);
  await Promise.resolve();
  expect(desktop.invoke).toHaveBeenCalledWith("plugin:dialog|message", {
    title: "确认操作", message: "恢复测试备份？", kind: "warning", buttons: "OkCancel",
  });
  expect(completed).not.toHaveBeenCalled();
  resolve("Cancel");
  await pending;
  expect(completed).toHaveBeenCalledWith(false);
  desktop.invoke.mockResolvedValueOnce("Ok");
  expect(await confirmAction("恢复测试备份？")).toBe(true);
  expect(legacy).not.toHaveBeenCalled();
});
it("fails closed on unexpected native results and never falls back after native errors", async () => {
  vi.stubGlobal("__TAURI_INTERNALS__", {});
  const legacy = vi.fn(() => true);
  vi.stubGlobal("confirm", legacy);
  for (const result of [true, false, "Yes", "No", "Cancel", "ok", 1, {}, undefined]) {
    desktop.invoke.mockResolvedValueOnce(result);
    expect(await confirmAction("删除？")).toBe(false);
  }
  desktop.invoke.mockRejectedValueOnce(new Error("native dialog denied"));
  await expect(confirmAction("删除？")).rejects.toThrow("native dialog denied");
  expect(legacy).not.toHaveBeenCalled();
});
it("grants the matching message permission to the panel only", () => {
  expect(capability.windows).toEqual(["panel"]);
  expect(capability.permissions).toEqual(["dialog:allow-message"]);
});
