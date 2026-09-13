import { useSyncExternalStore } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { fallbackManifest, type PetManifest, type AnimationName } from "./manifest";
import { fallbackAnimationForScene } from "./sceneWardrobe";

export const BUILTIN_PET = "builtin:yuanyuan";
export interface PetProfile { schemaVersion: 1; selectedPackId: string; nicknames: Record<string, string> }
export interface PetCapabilities { learning: boolean; scene: boolean }
export interface PetPackSummary {
  packId: string; displayName: string; builtin: boolean; capabilities: PetCapabilities;
  manifest: PetManifest; fallbackImage: string;
}
export interface PetProfileSnapshot {
  revision: number; selectedPackId: string; effectivePackId: string; nickname: string;
  capabilities: PetCapabilities; manifest: PetManifest; fallbackImage: string;
  fallbackReason: string | null; staticOnly: boolean;
}
export interface PetImportPreview { token: string; pack: PetPackSummary; license: string; alreadyInstalled: boolean }
export const defaultPetProfile = (): PetProfile => ({ schemaVersion: 1, selectedPackId: BUILTIN_PET, nicknames: {} });
export const builtinPet: PetPackSummary = { packId: BUILTIN_PET, displayName: "圆圆", builtin: true, capabilities: { learning: true, scene: true }, manifest: fallbackManifest, fallbackImage: "/assets/pet/fallback.png" };
const initial: PetProfileSnapshot = { revision: 0, selectedPackId: BUILTIN_PET, effectivePackId: BUILTIN_PET, nickname: "圆圆", capabilities: builtinPet.capabilities, manifest: fallbackManifest, fallbackImage: builtinPet.fallbackImage, fallbackReason: null, staticOnly: false };
let snapshot = initial;
const subscribers = new Set<() => void>();
let generation = 0;
let requestedRevision = 0;
let syncGeneration = 0;
export const getPetSnapshot = () => snapshot;
export function usePetProfile() { return useSyncExternalStore((listener) => { subscribers.add(listener); return () => { subscribers.delete(listener); }; }, getPetSnapshot, getPetSnapshot); }
export function validatePetNickname(value: string): string {
  if (/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/u.test(value)) throw new Error("昵称不能含换行或控制字符。");
  // Unicode White_Space matches Rust's str::trim (JS trim also removes FEFF).
  const result = value.replace(/^\p{White_Space}+|\p{White_Space}+$/gu, "");
  if (Array.from(result).length < 1 || Array.from(result).length > 24) throw new Error("昵称需要 1–24 个字符。");
  return result;
}
/** Only application-owned templates pass here; never reminder/card/user text. */
export function petText(template: string, name = snapshot.nickname): string { return template.replaceAll("{pet}", name); }

export function resolvePetManifest(manifest: PetManifest, capabilities: PetCapabilities): PetManifest {
  const animations = { ...manifest.animations };
  const learningFallbacks = { "learning-study-sit": "focus-calm", "learning-study-curious": "review", "learning-press-correct": "waving", "learning-press-wrong": "failed" } as const;
  if (!capabilities.learning) {
    for (const [key, base] of Object.entries(learningFallbacks)) animations[key as AnimationName] = { ...animations[base], loopStart: fallbackManifest.animations[key as AnimationName].loopStart };
  }
  if (!capabilities.scene) {
    for (const [key, def] of Object.entries(fallbackManifest.animations)) {
      if (def.sheet !== "scene") continue;
      const base = fallbackAnimationForScene(key as AnimationName);
      animations[key as AnimationName] = { ...animations[base], loopStart: def.loopStart };
    }
  }
  return { ...manifest, animations };
}
export function acceptPetSnapshot(next: PetProfileSnapshot) {
  if (!next || next.revision < snapshot.revision) return;
  const sameResources = snapshot.revision > 0 && next.effectivePackId === snapshot.effectivePackId && next.capabilities.scene === snapshot.capabilities.scene && next.capabilities.learning === snapshot.capabilities.learning;
  snapshot = { ...next, manifest: sameResources ? snapshot.manifest : resolvePetManifest(next.manifest, next.capabilities) };
  subscribers.forEach((listener) => listener());
}
function loadImage(url: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const image = new Image();
    const timer = window.setTimeout(() => { image.onload = image.onerror = null; reject(new Error("图片加载超时")); }, 10000);
    image.onload = () => { clearTimeout(timer); image.onload = image.onerror = null; resolve(); };
    image.onerror = () => { clearTimeout(timer); image.onload = image.onerror = null; reject(new Error("图片加载失败")); };
    image.src = url;
  });
}
export async function preparePetSnapshot(next: PetProfileSnapshot) {
  if (!next || next.revision < Math.max(snapshot.revision, requestedRevision)) return;
  requestedRevision = next.revision;
  const token = ++generation;
  if (next.effectivePackId === snapshot.effectivePackId && next.staticOnly === snapshot.staticOnly) { acceptPetSnapshot(next); return; }
  const sources = next.staticOnly ? [["fallback", next.fallbackImage]] : [["standard", next.manifest.spritesheet], ["sleep", next.manifest.sleepSpritesheet], ["life", next.manifest.lifeSpritesheet]];
  let failed: string | null = null;
  await Promise.all(sources.map(async ([sheet, url]) => { try { await loadImage(url); } catch { failed ??= sheet; } }));
  if (token !== generation) return;
  if (failed) {
    if (next.effectivePackId === BUILTIN_PET && next.staticOnly) { acceptPetSnapshot(next); return; }
    if ("__TAURI_INTERNALS__" in window) {
      const replacement = await invoke<PetProfileSnapshot>("report_pet_resource_failure", { packId: next.effectivePackId, sheet: failed, expectedRevision: next.revision });
      if (token === generation) await preparePetSnapshot(replacement);
    }
    return;
  }
  acceptPetSnapshot(next);
}
export async function reportPetResourceFailure(sheet: string, expected = snapshot) {
  if (!("__TAURI_INTERNALS__" in window) || expected.revision !== snapshot.revision) return;
  const result = await invoke<PetProfileSnapshot>("report_pet_resource_failure", { packId: expected.effectivePackId, sheet, expectedRevision: expected.revision });
  await preparePetSnapshot(result);
}
export async function startPetProfileSync(): Promise<() => void> {
  const session = ++syncGeneration;
  if (!("__TAURI_INTERNALS__" in window)) {
    try { const saved = localStorage.getItem("yuanyuan-demo-pet-name"); if (saved) acceptPetSnapshot({ ...initial, revision: 1, nickname: validatePetNickname(saved) }); } catch { /* optional demo persistence */ }
    return () => {};
  }
  let stopped = false;
  const active = () => !stopped && session === syncGeneration;
  const unlisten = await listen<PetProfileSnapshot>("pet-profile-updated", (event) => { if (active()) void preparePetSnapshot(event.payload).catch(() => {}); });
  if (!active()) { unlisten(); return () => {}; }
  // Return cleanup as soon as subscribed, not after slow atlas loading.
  void invoke<PetProfileSnapshot>("get_pet_profile").then((next) => {
    if (active()) return preparePetSnapshot(next);
  }).catch(() => { /* Core reminders remain available with the built-in pet. */ });
  return () => { stopped = true; if (session === syncGeneration) generation++; unlisten(); };
}

export async function petCommand<T>(command: string, args?: Record<string, unknown>): Promise<T> {
  if ("__TAURI_INTERNALS__" in window) return invoke<T>(command, args);
  if (command === "get_pet_catalog") return [builtinPet] as T;
  if (command === "get_pet_profile") return snapshot as T;
  if (command === "set_pet_nickname" || command === "reset_pet_profile" || command === "activate_pet_pack") {
    const name = command === "set_pet_nickname" && args?.value != null ? validatePetNickname(String(args.value)) : "圆圆";
    const next = { ...snapshot, revision: snapshot.revision + 1, nickname: name };
    localStorage.setItem("yuanyuan-demo-pet-name", name); acceptPetSnapshot(next); return next as T;
  }
  throw new Error("请在桌面应用中导入和管理本地宠物包。");
}
