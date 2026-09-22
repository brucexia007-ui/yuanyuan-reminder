// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fallbackManifest, type AnimationName } from "./manifest";
import { acceptPetSnapshot, builtinPet, getPetSnapshot, petText, preparePetSnapshot, resolvePetManifest, validatePetNickname } from "./petProfile";
import { SpriteAnimator } from "./SpriteAnimator";

class LoadedImage {
  onload: (() => void) | null = null; onerror: (() => void) | null = null;
  set src(url: string) { queueMicrotask(() => url.includes("broken") ? this.onerror?.() : this.onload?.()); }
}
function sample(id: string) {
  const manifest = structuredClone(fallbackManifest);
  manifest.spritesheet = `/test/${id}/standard.webp`; manifest.sleepSpritesheet = `/test/${id}/sleep.webp`; manifest.lifeSpritesheet = `/test/${id}/life.webp`;
  return { ...getPetSnapshot(), revision: getPetSnapshot().revision + 1, selectedPackId: id, effectivePackId: id, nickname: id, capabilities: { learning: false, scene: false }, manifest, fallbackImage: `/test/${id}/fallback.png`, staticOnly: false, fallbackReason: null };
}
beforeEach(() => {
  vi.stubGlobal("Image", LoadedImage);
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  acceptPetSnapshot({ ...getPetSnapshot(), revision: getPetSnapshot().revision + 1, selectedPackId: builtinPet.packId, effectivePackId: builtinPet.packId, nickname: "圆圆", manifest: fallbackManifest, capabilities: builtinPet.capabilities, staticOnly: false });
});
afterEach(() => { vi.unstubAllGlobals(); });
describe("runtime pet profile", () => {
  it("validates Unicode consistently and substitutes only an owned template", () => {
    expect(validatePetNickname("  团子🐈  ")).toBe("团子🐈");
    expect(validatePetNickname("🐈".repeat(24))).toHaveLength(48);
    expect(validatePetNickname("\u2003团子\u3000")).toBe("团子");
    expect(validatePetNickname("\ufeff团子\ufeff")).toBe("\ufeff团子\ufeff");
    for (const invalid of ["", "\n团子", "团子\u0085", "团\u2028子", "团子\u2029", "🐈".repeat(25)]) expect(() => validatePetNickname(invalid)).toThrow();
    const userTitle = "圆圆提醒我保留 {pet} 原文";
    acceptPetSnapshot({ ...getPetSnapshot(), revision: getPetSnapshot().revision + 1, nickname: "团子" });
    expect(petText("{pet}提醒你")).toBe("团子提醒你");
    expect(userTitle).toBe("圆圆提醒我保留 {pet} 原文");
  });
  it("resolves all 18 missing scene actions using only the imported pet's definitions", () => {
    const source = structuredClone(fallbackManifest);
    for (const key of Object.keys(source.animations) as AnimationName[]) if (["scene", "learning"].includes(source.animations[key].sheet ?? "")) delete source.animations[key];
    source.spritesheet = "/test/imported.webp";
    const resolved = resolvePetManifest(source, { learning: false, scene: false });
    let count = 0;
    for (const [key, definition] of Object.entries(fallbackManifest.animations)) {
      if (definition.sheet !== "scene") continue;
      count++;
      const action = resolved.animations[key as AnimationName];
      expect(["scene", "learning"]).not.toContain(action.sheet);
      expect(action.loopStart === null).toBe(definition.loopStart === null);
      expect(action.staticFrame).toBeGreaterThanOrEqual(0);
    }
    expect(count).toBe(18); expect(resolved.spritesheet).toBe("/test/imported.webp");
  });
  it("keeps current resources on failed preparation and ignores late revisions", async () => {
    await preparePetSnapshot(sample("first"));
    const current = getPetSnapshot();
    await preparePetSnapshot(sample("broken"));
    expect(getPetSnapshot()).toBe(current);
    acceptPetSnapshot({ ...sample("late"), revision: current.revision - 1 });
    expect(getPetSnapshot()).toBe(current);
    const manifest = current.manifest;
    acceptPetSnapshot({ ...current, revision: current.revision + 1, nickname: "新昵称" });
    expect(getPetSnapshot().manifest).toBe(manifest);
  });
  it("waits for learning and scene atlases before publishing a first switch", async () => {
    const pending = new Map<string, () => void>();
    class DeferredImage {
      onload: (() => void) | null = null; onerror: (() => void) | null = null;
      set src(url: string) { pending.set(url, () => this.onload?.()); }
    }
    vi.stubGlobal("Image", DeferredImage);
    const next = { ...sample("optional"), capabilities: { learning: true, scene: true } };
    const previous = getPetSnapshot();
    const preparation = preparePetSnapshot(next);
    for (const [url, finish] of pending) if (url !== next.manifest.learningSpritesheet && url !== next.manifest.sceneSpritesheet) finish();
    await Promise.resolve();
    expect(getPetSnapshot()).toBe(previous);
    expect(pending.has(next.manifest.learningSpritesheet)).toBe(true);
    expect(pending.has(next.manifest.sceneSpritesheet)).toBe(true);
    pending.get(next.manifest.learningSpritesheet)!();
    await Promise.resolve();
    expect(getPetSnapshot()).toBe(previous);
    pending.get(next.manifest.sceneSpritesheet)!();
    await preparation;
    expect(getPetSnapshot().effectivePackId).toBe("optional");
  });
  it("only commits the last overlapping resource preparation", async () => {
    const first = sample("first"), last = { ...sample("last"), revision: first.revision + 1 };
    await Promise.all([preparePetSnapshot(first), preparePetSnapshot(last)]);
    expect(getPetSnapshot().effectivePackId).toBe("last");
  });
  it("ignores an older result that arrives while a newer pack is still loading", async () => {
    const older = sample("older"), newest = { ...sample("newest"), revision: older.revision + 1 };
    await Promise.all([preparePetSnapshot(newest), preparePetSnapshot(older)]);
    expect(getPetSnapshot().effectivePackId).toBe("newest");
  });
  it("replaces an active renderer without showing another pet's atlas", async () => {
    const container = document.createElement("div"), root = createRoot(container);
    await act(async () => { root.render(<SpriteAnimator animation="work-focus-loop" settings={{ animationMode: "off", animationSpeed: 1 }} />); });
    await act(async () => { await preparePetSnapshot(sample("new-pet")); });
    expect(container.querySelector<HTMLElement>(".sprite-animator")?.style.backgroundImage).toContain("/test/new-pet/life.webp");
    await act(async () => { acceptPetSnapshot({ ...getPetSnapshot(), revision: getPetSnapshot().revision + 1, staticOnly: true }); });
    expect(container.querySelector("img")?.src).toContain("/test/new-pet/fallback.png");
    await act(async () => root.unmount());
  });
});
