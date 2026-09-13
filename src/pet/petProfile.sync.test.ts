// @vitest-environment jsdom
import { expect, it, vi } from "vitest";
const bridge = vi.hoisted(() => ({ invoke: vi.fn(), listen: vi.fn(async (_event: string, _callback: unknown) => vi.fn()) }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: bridge.invoke }));
vi.mock("@tauri-apps/api/event", () => ({ listen: bridge.listen }));
import { builtinPet, getPetSnapshot, startPetProfileSync, type PetProfileSnapshot } from "./petProfile";

it("StrictMode's old cleanup cannot cancel the new subscription or its startup snapshot", async () => {
  vi.stubGlobal("__TAURI_INTERNALS__", {});
  class LoadedImage {
    onload: (() => void) | null = null; onerror: (() => void) | null = null;
    set src(_url: string) { queueMicrotask(() => this.onload?.()); }
  }
  vi.stubGlobal("Image", LoadedImage);
  const requests: Array<(value: PetProfileSnapshot) => void> = [];
  bridge.invoke.mockImplementation(() => new Promise(resolve => requests.push(resolve)));
  const oldCleanup = await startPetProfileSync();
  const latestCleanup = await startPetProfileSync();
  oldCleanup();
  const newest = { ...getPetSnapshot(), revision: 100, selectedPackId: "imported", effectivePackId: "imported", manifest: builtinPet.manifest, nickname: "重启后宠物" };
  requests[1](newest);
  requests[0]({ ...newest, revision: 99, nickname: "旧结果" });
  await vi.waitFor(() => expect(getPetSnapshot().nickname).toBe("重启后宠物"));
  expect(bridge.listen.mock.invocationCallOrder[0]).toBeLessThan(bridge.invoke.mock.invocationCallOrder[0]);
  latestCleanup(); vi.unstubAllGlobals();
});
