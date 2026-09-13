import { useEffect, useMemo, useState } from "react";
import type { AppSettings } from "../types";
import { usePetProfile, reportPetResourceFailure, resolvePetManifest, type PetPackSummary } from "./petProfile";
import {
  fallbackManifest,
  type AnimationName,
  type PetManifest,
  type SpriteSheetName,
} from "./manifest";

interface SpriteAnimatorProps {
  previewPack?: PetPackSummary;
  animation: AnimationName;
  fallbackAnimation?: AnimationName;
  lookFrame?: number | null;
  frameOverride?: number | null;
  mirrored?: boolean;
  offsetX?: number;
  settleAtStaticFrame?: boolean;
  forceStill?: boolean;
  settings: Pick<AppSettings, "animationMode" | "animationSpeed">;
  onComplete?: (animation: AnimationName) => void;
  onFrameChange?: (animation: AnimationName, frameIndex: number) => void;
}

function shouldAnimate(mode: AppSettings["animationMode"]): boolean {
  if (mode === "always") return true;
  if (mode === "off") return false;
  return typeof window.matchMedia !== "function"
    || !window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

export function definitionForSceneAvailability(
  manifest: PetManifest,
  animation: AnimationName,
  fallbackAnimation: AnimationName,
  sceneSheetAvailable: boolean,
) {
  const requested =
    manifest.animations[animation] ?? fallbackManifest.animations.idle;
  return requested.sheet === "scene" && !sceneSheetAvailable
    ? (manifest.animations[fallbackAnimation] ?? fallbackManifest.animations.idle)
    : requested;
}

export function SpriteAnimator({
  previewPack,
  animation,
  fallbackAnimation = "idle",
  lookFrame = null,
  frameOverride = null,
  mirrored = false,
  offsetX = 0,
  settleAtStaticFrame = false,
  forceStill = false,
  settings,
  onComplete,
  onFrameChange,
}: SpriteAnimatorProps) {
  const profile = usePetProfile();
  const manifest = useMemo(() => previewPack ? resolvePetManifest(previewPack.manifest, previewPack.capabilities) : profile.manifest, [previewPack, profile.manifest]);
  const [frameIndex, setFrameIndex] = useState(0);
  const [completed, setCompleted] = useState(false);
  const [sleepSheetAvailable, setSleepSheetAvailable] = useState(true);
  const [lifeSheetAvailable, setLifeSheetAvailable] = useState(true);
  const [learningSheetAvailable, setLearningSheetAvailable] = useState(true);
  const [sceneSheetAvailable, setSceneSheetAvailable] = useState(true);

  useEffect(() => {
    setSleepSheetAvailable(true); setLifeSheetAvailable(true);
    setLearningSheetAvailable(true); setSceneSheetAvailable(true);
  }, [manifest]);

  const requestedDefinition =
    manifest.animations[animation] ?? fallbackManifest.animations.idle;
  const definition = definitionForSceneAvailability(
    manifest,
    animation,
    fallbackAnimation,
    sceneSheetAvailable,
  );
  // Work focus stays in the pack's resting pose so it cannot distract the user.
  const animate = !forceStill && animation !== "work-focus-loop"
    && shouldAnimate(settings.animationMode) && (Boolean(previewPack) || !profile.staticOnly);

  useEffect(() => {
    setFrameIndex(0);
    setCompleted(false);
    onFrameChange?.(animation, 0);
    if (
      lookFrame !== null ||
      frameOverride !== null ||
      !animate ||
      definition.frames.length <= 1
    ) {
      if (settleAtStaticFrame) setCompleted(true);
      return;
    }

    let cancelled = false;
    let timer = 0;

    const schedule = (index: number) => {
      const speed = Math.max(0.4, Math.min(2, settings.animationSpeed));
      timer = window.setTimeout(
        () => {
          if (cancelled) return;
          const next = index + 1;
          if (next < definition.frames.length) {
            setFrameIndex(next);
            onFrameChange?.(animation, next);
            schedule(next);
            return;
          }
          if (definition.loopStart !== null && !settleAtStaticFrame) {
            setFrameIndex(definition.loopStart);
            schedule(definition.loopStart);
          } else {
            setCompleted(true);
            onComplete?.(animation);
          }
        },
        definition.durations[index] / speed,
      );
    };

    schedule(0);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [
    animation,
    animate,
    definition,
    frameOverride,
    lookFrame,
    onComplete,
    onFrameChange,
    settings.animationSpeed,
    settleAtStaticFrame,
  ]);

  const frame = useMemo(() => {
    if (lookFrame !== null) {
      const normalized = ((lookFrame % 16) + 16) % 16;
      return {
        column: normalized % 8,
        row: normalized < 8 ? 9 : 10,
        columns: manifest.columns,
        rows: manifest.rows,
        sheet: "standard" as const,
      };
    }
    if (frameOverride !== null) {
      const requestedSheet = definition.sheet ?? "standard";
      const frame = Math.max(
        0,
        Math.min(definition.frames.length - 1, Math.round(frameOverride)),
      );
      return {
        column: definition.frames[frame],
        row: definition.row,
        columns: manifest.columns,
        rows:
          requestedSheet === "sleep"
            ? 3
            : requestedSheet === "life"
              ? manifest.lifeRows
              : requestedSheet === "learning"
                ? manifest.learningRows
                : requestedSheet === "scene"
                  ? manifest.sceneRows
                  : manifest.rows,
        sheet: requestedSheet,
      };
    }
    const requestedSheet = definition.sheet ?? "standard";
    const sheetAvailable =
      requestedSheet === "sleep"
        ? sleepSheetAvailable
        : requestedSheet === "life"
          ? lifeSheetAvailable
          : requestedSheet === "learning"
            ? learningSheetAvailable
            : requestedSheet === "scene"
              ? sceneSheetAvailable
              : true;
    const sheet: SpriteSheetName = sheetAvailable ? requestedSheet : "standard";
    if (sheet === "standard" && requestedSheet !== "standard") {
      return {
        column: 0,
        row: 0,
        columns: manifest.columns,
        rows: manifest.rows,
        sheet,
      };
    }
    return {
      column:
        (!animate || (completed && settleAtStaticFrame)) && definition.staticFrame !== undefined
          ? definition.staticFrame
          : definition.frames[Math.min(frameIndex, definition.frames.length - 1)],
      row: definition.row,
      columns: manifest.columns,
      rows:
        requestedSheet === "sleep"
          ? 3
          : requestedSheet === "life"
            ? manifest.lifeRows
            : requestedSheet === "learning"
              ? manifest.learningRows
              : requestedSheet === "scene"
                ? manifest.sceneRows
                : manifest.rows,
      sheet,
    };
  }, [
    definition,
    animate,
    completed,
    settleAtStaticFrame,
    frameOverride,
    frameIndex,
    lifeSheetAvailable,
    learningSheetAvailable,
    lookFrame,
    manifest,
    sceneSheetAvailable,
    sleepSheetAvailable,
  ]);

  const image =
    frame.sheet === "sleep"
      ? manifest.sleepSpritesheet
      : frame.sheet === "life"
        ? manifest.lifeSpritesheet
        : frame.sheet === "learning"
          ? manifest.learningSpritesheet
          : frame.sheet === "scene"
            ? manifest.sceneSpritesheet
            : manifest.spritesheet;
  const x = (frame.column / (frame.columns - 1)) * 100;
  const y = frame.rows <= 1 ? 0 : (frame.row / (frame.rows - 1)) * 100;

  useEffect(() => {
    const requestedSheet = requestedDefinition.sheet ?? "standard";
    if (requestedSheet === "standard" && (previewPack || profile.effectivePackId === "builtin:yuanyuan")) return;
    let cancelled = false;
    const probe = new Image();
    const updateAvailability = (available: boolean) => {
      if (requestedSheet === "sleep") setSleepSheetAvailable(available);
      else if (requestedSheet === "life") setLifeSheetAvailable(available);
      else if (requestedSheet === "learning") setLearningSheetAvailable(available);
      else setSceneSheetAvailable(available);
    };
    probe.onload = () => { if (!cancelled) updateAvailability(true); };
    probe.onerror = () => {
      if (cancelled) return;
      updateAvailability(false);
      if (!previewPack) void reportPetResourceFailure(requestedSheet, profile).catch(() => {});
    };
    probe.src =
      requestedSheet === "sleep"
        ? manifest.sleepSpritesheet
        : requestedSheet === "life"
          ? manifest.lifeSpritesheet
          : requestedSheet === "standard"
            ? manifest.spritesheet
          : requestedSheet === "learning"
            ? manifest.learningSpritesheet
            : manifest.sceneSpritesheet;
    return () => { cancelled = true; probe.onload = probe.onerror = null; };
  }, [
    requestedDefinition.sheet,
    manifest.lifeSpritesheet,
    manifest.learningSpritesheet,
    manifest.sceneSpritesheet,
    manifest.sleepSpritesheet,
    manifest.spritesheet,
    previewPack,
    profile.effectivePackId,
    profile.revision,
  ]);

  if (!previewPack && profile.staticOnly) return <img className="sprite-animator pet-static-fallback" src={profile.fallbackImage} alt="" aria-hidden="true" onError={() => { void reportPetResourceFailure("fallback", profile).catch(() => {}); }} />;

  return (
    <div
      className="sprite-animator"
      data-animation={animation}
      data-rendered-animation={definition === requestedDefinition ? animation : fallbackAnimation}
      data-mirrored={mirrored ? "true" : "false"}
      aria-hidden="true"
      style={{
        backgroundImage: `url("${image}")`,
        backgroundPosition: `${x}% ${y}%`,
        backgroundSize: `${frame.columns * 100}% ${frame.rows * 100}%`,
        transform: `translateX(${offsetX}px) scaleX(${mirrored ? -1 : 1})`,
      }}
    />
  );
}
