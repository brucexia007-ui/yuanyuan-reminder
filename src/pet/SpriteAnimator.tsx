import { useEffect, useMemo, useState } from "react";
import type { AppSettings } from "../types";
import {
  fallbackManifest,
  loadPetManifest,
  type AnimationName,
  type PetManifest,
  type SpriteSheetName,
} from "./manifest";

interface SpriteAnimatorProps {
  animation: AnimationName;
  lookFrame?: number | null;
  frameOverride?: number | null;
  mirrored?: boolean;
  offsetX?: number;
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

export function SpriteAnimator({
  animation,
  lookFrame = null,
  frameOverride = null,
  mirrored = false,
  offsetX = 0,
  settings,
  onComplete,
  onFrameChange,
}: SpriteAnimatorProps) {
  const [manifest, setManifest] = useState<PetManifest>(fallbackManifest);
  const [frameIndex, setFrameIndex] = useState(0);
  const [sleepSheetAvailable, setSleepSheetAvailable] = useState(true);
  const [lifeSheetAvailable, setLifeSheetAvailable] = useState(true);
  const [learningSheetAvailable, setLearningSheetAvailable] = useState(true);

  useEffect(() => {
    void loadPetManifest().then(setManifest);
  }, []);

  const definition = manifest.animations[animation];
  const animate = shouldAnimate(settings.animationMode);

  useEffect(() => {
    setFrameIndex(0);
    onFrameChange?.(animation, 0);
    if (
      lookFrame !== null ||
      frameOverride !== null ||
      !animate ||
      definition.frames.length <= 1
    ) {
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
          if (definition.loopStart !== null) {
            setFrameIndex(definition.loopStart);
            schedule(definition.loopStart);
          } else {
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
      column: definition.frames[Math.min(frameIndex, definition.frames.length - 1)],
      row: definition.row,
      columns: manifest.columns,
      rows:
        requestedSheet === "sleep"
          ? 3
          : requestedSheet === "life"
            ? manifest.lifeRows
            : requestedSheet === "learning"
              ? manifest.learningRows
              : manifest.rows,
      sheet,
    };
  }, [
    definition,
    frameOverride,
    frameIndex,
    lifeSheetAvailable,
    learningSheetAvailable,
    lookFrame,
    manifest,
    sleepSheetAvailable,
  ]);

  const image =
    frame.sheet === "sleep"
      ? manifest.sleepSpritesheet
      : frame.sheet === "life"
        ? manifest.lifeSpritesheet
        : frame.sheet === "learning"
          ? manifest.learningSpritesheet
          : manifest.spritesheet;
  const x = (frame.column / (frame.columns - 1)) * 100;
  const y = frame.rows <= 1 ? 0 : (frame.row / (frame.rows - 1)) * 100;

  useEffect(() => {
    const requestedSheet = definition.sheet ?? "standard";
    if (requestedSheet === "standard") return;
    const probe = new Image();
    const updateAvailability = (available: boolean) => {
      if (requestedSheet === "sleep") setSleepSheetAvailable(available);
      else if (requestedSheet === "life") setLifeSheetAvailable(available);
      else setLearningSheetAvailable(available);
    };
    probe.onload = () => updateAvailability(true);
    probe.onerror = () => updateAvailability(false);
    probe.src =
      requestedSheet === "sleep"
        ? manifest.sleepSpritesheet
        : requestedSheet === "life"
          ? manifest.lifeSpritesheet
          : manifest.learningSpritesheet;
  }, [
    definition.sheet,
    manifest.lifeSpritesheet,
    manifest.learningSpritesheet,
    manifest.sleepSpritesheet,
  ]);

  return (
    <div
      className="sprite-animator"
      data-animation={animation}
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
