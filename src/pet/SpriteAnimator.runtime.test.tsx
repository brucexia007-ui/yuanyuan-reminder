// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { fallbackManifest } from "./manifest";
import { SpriteAnimator } from "./SpriteAnimator";
import { builtinPet } from "./petProfile";

let imageLoads = true;

class ProbeImage {
  onload: null | (() => void) = null;
  onerror: null | (() => void) = null;

  set src(_value: string) {
    queueMicrotask(() => {
      if (imageLoads) this.onload?.();
      else this.onerror?.();
    });
  }
}

describe("SpriteAnimator scene runtime fallback", () => {
  let container: HTMLDivElement;
  let root: Root;

  const flush = async () => {
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
  };

  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    imageLoads = true;
    vi.stubGlobal("Image", ProbeImage);
    vi.stubGlobal("fetch", vi.fn(async () => ({
      ok: true,
      json: async () => structuredClone(fallbackManifest),
    })));
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    vi.unstubAllGlobals();
    vi.useRealTimers();
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = false;
  });

  it("renders the required stable frame immediately when animation is off", async () => {
    await act(async () => root.render(
      <SpriteAnimator
        animation="spa-enter"
        fallbackAnimation="focus-calm"
        settings={{ animationMode: "off", animationSpeed: 1 }}
      />,
    ));
    await flush();

    const sprite = container.querySelector<HTMLElement>(".sprite-animator");
    expect(sprite?.dataset.renderedAnimation).toBe("spa-enter");
    expect(sprite?.style.backgroundPosition).toBe("100% 0%");
  });

  it("keeps work focus still and resumes motion for other actions", async () => {
    vi.useFakeTimers();
    const complete = vi.fn();
    const renderAction = async (animation: "work-focus-loop" | "work-recover") => {
      await act(async () => root.render(<SpriteAnimator previewPack={builtinPet}
        animation={animation} settings={{ animationMode: "always", animationSpeed: 1 }}
        onComplete={complete} />));
    };
    await renderAction("work-focus-loop");
    const sprite = container.querySelector<HTMLElement>(".sprite-animator")!;
    const restingPosition = sprite.style.backgroundPosition;
    expect(parseFloat(restingPosition)).toBeCloseTo(
      (fallbackManifest.animations["work-focus-loop"].staticFrame! / 7) * 100,
    );
    await act(async () => vi.advanceTimersByTime(30_000));
    expect(sprite.style.backgroundPosition).toBe(restingPosition);
    expect(complete).not.toHaveBeenCalled();

    await renderAction("work-recover");
    const recoveryStart = sprite.style.backgroundPosition;
    await act(async () => vi.advanceTimersByTime(
      fallbackManifest.animations["work-recover"].durations[0],
    ));
    expect(sprite.style.backgroundPosition).not.toBe(recoveryStart);

    await renderAction("work-focus-loop");
    expect(sprite.style.backgroundPosition).toBe(restingPosition);
    await act(async () => vi.advanceTimersByTime(30_000));
    expect(sprite.style.backgroundPosition).toBe(restingPosition);
    expect(complete).not.toHaveBeenCalled();
  });

  it("keeps a basic work pose still for 30 seconds and releases it for interaction", async () => {
    vi.useFakeTimers();
    const pack = { ...builtinPet, capabilities: { learning: true, scene: false } };
    const renderPose = async (forceStill: boolean) => {
      await act(async () => root.render(<SpriteAnimator previewPack={pack}
        animation="focus-calm" forceStill={forceStill}
        settings={{ animationMode: "always", animationSpeed: 1 }} />));
    };
    await renderPose(true);
    const sprite = container.querySelector<HTMLElement>(".sprite-animator")!;
    const restingPosition = sprite.style.backgroundPosition;
    await act(async () => vi.advanceTimersByTime(30_000));
    expect(sprite.style.backgroundPosition).toBe(restingPosition);
    await renderPose(false);
    const start = sprite.style.backgroundPosition;
    await act(async () => vi.advanceTimersByTime(fallbackManifest.animations["focus-calm"].durations[0]));
    expect(sprite.style.backgroundPosition).not.toBe(start);
  });

  it("switches a failed scene atlas request to the declared legacy animation", async () => {
    imageLoads = false;
    await act(async () => root.render(
      <SpriteAnimator
        animation="hydration-alert"
        fallbackAnimation="alert-glass-paws"
        settings={{ animationMode: "always", animationSpeed: 1 }}
      />,
    ));
    await flush();

    const sprite = container.querySelector<HTMLElement>(".sprite-animator");
    expect(sprite?.dataset.animation).toBe("hydration-alert");
    expect(sprite?.dataset.renderedAnimation).toBe("alert-glass-paws");
    expect(sprite?.style.backgroundImage).toContain(
      fallbackManifest.lifeSpritesheet,
    );
  });

  it.each([true, false])("holds the selected pack's stable column after transition (scene=%s)", async (scene) => {
    vi.useFakeTimers();
    const manifest = structuredClone(fallbackManifest);
    manifest.animations[scene ? "work-fatigue-enter" : "focus-calm"] = {
      sheet: scene ? "scene" : "life", row: scene ? 8 : 7,
      frames: [0, 1, 2], durations: [40, 40, 40], loopStart: scene ? null : 0,
      staticFrame: scene ? 5 : 3,
    };
    const pack = { ...builtinPet, packId: "test-stable", manifest, capabilities: { learning: true, scene } };
    const complete = vi.fn();
    await act(async () => root.render(<SpriteAnimator previewPack={pack}
      animation="work-fatigue-enter" fallbackAnimation="focus-calm" settleAtStaticFrame
      settings={{ animationMode: "always", animationSpeed: 1 }} onComplete={complete} />));
    await act(async () => vi.advanceTimersByTime(120));
    const sprite = container.querySelector<HTMLElement>(".sprite-animator")!;
    const stablePosition = sprite.style.backgroundPosition;
    expect(parseFloat(stablePosition)).toBeCloseTo(((scene ? 5 : 3) / 7) * 100);
    expect(complete).toHaveBeenCalledExactlyOnceWith("work-fatigue-enter");
    await act(async () => vi.advanceTimersByTime(10_000));
    expect(sprite.style.backgroundPosition).toBe(stablePosition);
    expect(complete).toHaveBeenCalledTimes(1);

    await act(async () => root.render(<SpriteAnimator previewPack={pack}
      animation="work-fatigue-loop" fallbackAnimation="focus-calm"
      settings={{ animationMode: "always", animationSpeed: 1 }} onComplete={complete} />));
    expect(sprite.dataset.animation).toBe("work-fatigue-loop");
    expect(parseFloat(sprite.style.backgroundPosition)).toBe(0);
  });

  it.each(["off", "system"] as const)("shows transition staticFrame immediately with %s animation", async (animationMode) => {
    vi.useFakeTimers();
    vi.stubGlobal("matchMedia", vi.fn(() => ({ matches: true })));
    const complete = vi.fn();
    await act(async () => root.render(<SpriteAnimator previewPack={builtinPet}
      animation="work-fatigue-enter" settleAtStaticFrame
      settings={{ animationMode, animationSpeed: 1 }} onComplete={complete} />));
    const sprite = container.querySelector<HTMLElement>(".sprite-animator")!;
    expect(parseFloat(sprite.style.backgroundPosition)).toBe(100);
    await act(async () => vi.advanceTimersByTime(10_000));
    expect(parseFloat(sprite.style.backgroundPosition)).toBe(100);
    expect(complete).not.toHaveBeenCalled();
  });
});
