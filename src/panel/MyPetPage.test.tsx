// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { beforeEach, afterEach, it, expect, vi } from "vitest";
const bridge = vi.hoisted(() => ({ invoke: vi.fn(), listen: vi.fn(async () => () => {}) }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: bridge.invoke }));
vi.mock("../lib/backend", () => ({ tauriAvailable: () => true, onBackendEvent: bridge.listen }));
vi.mock("../pet/SpriteAnimator", () => ({ SpriteAnimator: ({ previewPack }: { previewPack: { packId: string } }) => <div data-preview={previewPack.packId} /> }));
import { MyPetPage } from "./MyPetPage";
import { acceptPetSnapshot, builtinPet, getPetSnapshot } from "../pet/petProfile";
import type { AppSettings } from "../types";

let container: HTMLDivElement, root: Root;
const originalScrollIntoView = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "scrollIntoView");
const installed = { ...builtinPet, packId: "a".repeat(64), builtin: false, displayName: "测试形象", capabilities: { learning: false, scene: false } };
const settings = { animationMode: "off", animationSpeed: 1 } as AppSettings;
const button = (text: string) => [...container.querySelectorAll<HTMLButtonElement>("button")].find(b => b.textContent === text)!;
const click = async (text: string) => { await act(async () => button(text).click()); };
beforeEach(async () => {
  Object.defineProperty(HTMLElement.prototype, "scrollIntoView", { configurable: true, value: vi.fn() });
  vi.stubGlobal("__TAURI_INTERNALS__", {});
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  acceptPetSnapshot({ ...getPetSnapshot(), revision: getPetSnapshot().revision + 1, selectedPackId: builtinPet.packId, effectivePackId: builtinPet.packId, nickname: "圆圆", capabilities: builtinPet.capabilities, manifest: builtinPet.manifest });
  bridge.invoke.mockImplementation(async (command: string, args?: { value: string }) => {
    if (command === "get_pet_catalog") return [builtinPet];
    if (command === "set_pet_nickname") return { ...getPetSnapshot(), revision: getPetSnapshot().revision + 1, nickname: args?.value ?? "圆圆" };
    if (command === "get_pet_profile") return getPetSnapshot();
    if (command === "preview_pet_pack_import") return { token: "one-use", pack: installed, license: "仅本地测试许可", alreadyInstalled: false };
    return installed;
  });
  container = document.createElement("div"); document.body.append(container); root = createRoot(container);
  await act(async () => root.render(<MyPetPage settings={settings} onBack={vi.fn()} />));
});
afterEach(async () => {
  await act(async () => root.unmount()); container.remove(); vi.clearAllMocks(); vi.restoreAllMocks(); vi.unstubAllGlobals();
  if (originalScrollIntoView) Object.defineProperty(HTMLElement.prototype, "scrollIntoView", originalScrollIntoView);
  else Reflect.deleteProperty(HTMLElement.prototype, "scrollIntoView");
});
it("subscribes before listing and saves only a validated nickname with the expected revision", async () => {
  expect(bridge.listen.mock.invocationCallOrder[0]).toBeLessThan(bridge.invoke.mock.invocationCallOrder[0]);
  const field = container.querySelector("input")!;
  await act(async () => { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(field, "  团子🐈  "); field.dispatchEvent(new Event("input", { bubbles: true })); });
  const revision = getPetSnapshot().revision;
  await act(async () => container.querySelector("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })));
  expect(bridge.invoke).toHaveBeenCalledWith("set_pet_nickname", { packId: builtinPet.packId, value: "团子🐈", expectedRevision: revision });
  expect(container.textContent).toContain("昵称已保存");
});
it("previews license and capabilities, then commits without activating or recording care", async () => {
  await click("导入宠物包");
  expect(container.textContent).toContain("仅本地测试许可");
  expect(container.textContent).toContain("学习时使用安静坐姿");
  expect(container.querySelector('[data-preview]')?.getAttribute("data-preview")).toBe(installed.packId);
  await click("确认加入");
  expect(bridge.invoke).toHaveBeenCalledWith("commit_pet_pack_import", { token: "one-use" });
  expect(bridge.invoke.mock.calls.map(c => c[0])).not.toContain("activate_pet_pack");
  expect(getPetSnapshot().effectivePackId).toBe(builtinPet.packId);
});
it("cancels a staged import and never exposes removal for the built-in pet", async () => {
  expect(button("移除")).toBeUndefined();
  await click("导入宠物包"); await click("取消导入");
  expect(bridge.invoke).toHaveBeenCalledWith("cancel_pet_pack_import", { token: "one-use" });
  expect(container.textContent).not.toContain("确认加入这个形象");
});
it("reveals and focuses an import error without smooth motion, allowing keyboard retry", async () => {
  const scroll = vi.mocked(HTMLElement.prototype.scrollIntoView);
  bridge.invoke.mockRejectedValueOnce(new Error("重复文件，无法导入"));
  await click("导入宠物包");
  const error = container.querySelector<HTMLElement>('[role="alert"]')!;
  expect(error.textContent).toContain("重复文件");
  expect(document.activeElement).toBe(error);
  expect(scroll).toHaveBeenCalledWith({ block: "nearest", behavior: "instant" });
  expect(button("导入宠物包").disabled).toBe(false);
  expect(bridge.invoke.mock.calls.some(c => c[0] === "commit_pet_pack_import")).toBe(false);
  await click("导入宠物包");
  expect(container.querySelector('[role="alert"]')).toBeNull();
  expect(container.textContent).toContain("确认加入这个形象");
});
it("waits for native removal consent; cancellation and dialog failure preserve the pack", async () => {
  let resolve!: (value: string) => void;
  const dialog = vi.fn(() => new Promise<string>(r => { resolve = r; }));
  bridge.invoke.mockImplementation(async (command: string) => {
    if (command === "plugin:dialog|message") return dialog();
    if (command === "get_pet_catalog") return [builtinPet, installed];
    return getPetSnapshot();
  });
  await act(async () => root.render(<MyPetPage key="removal" settings={settings} onBack={vi.fn()} />));
  const confirm = vi.fn(() => true);
  vi.stubGlobal("confirm", confirm);
  await click("移除");
  expect(button("移除").disabled).toBe(true);
  expect(bridge.invoke.mock.calls.some(c => c[0] === "remove_pet_pack")).toBe(false);
  expect(bridge.invoke).toHaveBeenCalledWith("plugin:dialog|message", expect.objectContaining({ buttons: "OkCancel" }));
  await act(async () => resolve("Cancel"));
  expect(button("移除").disabled).toBe(false);
  expect(bridge.invoke.mock.calls.some(c => c[0] === "remove_pet_pack")).toBe(false);
  dialog.mockRejectedValueOnce(new Error("dialog denied"));
  await click("移除");
  expect(container.textContent).toContain("dialog denied");
  expect(bridge.invoke.mock.calls.some(c => c[0] === "remove_pet_pack")).toBe(false);
  dialog.mockResolvedValueOnce("Ok");
  await click("移除");
  expect(bridge.invoke.mock.calls.filter(c => c[0] === "remove_pet_pack")).toHaveLength(1);
  expect(confirm).not.toHaveBeenCalled();
});
