import { describe, expect, it } from "vitest";
import {
  animationForSceneAppearance,
  completionAnimationForCategory,
  exitAnimationForScene,
  fallbackAnimationForScene,
  recoveryAnimationForScene,
  settledSceneAnimation,
} from "./sceneWardrobe";

describe("scene wardrobe controller", () => {
  it("honors all three wardrobe modes", () => {
    expect(animationForSceneAppearance({ kind: "meal" }, "reminders_only")).toBe("meal-alert");
    expect(animationForSceneAppearance({ kind: "spa" }, "reminders_only")).toBeNull();
    expect(animationForSceneAppearance({ kind: "meal" }, "off")).toBeNull();
    expect(animationForSceneAppearance({ kind: "spa" }, "full")).toBe("spa-enter");
  });

  it("maps all 18 rows and reduced-motion stable frames", () => {
    const rows = [
      "spa-enter", "spa-loop", "spa-exit", "meal-alert", "meal-wait",
      "hydration-alert", "hydration-wait", "work-focus-loop",
      "work-fatigue-enter", "work-fatigue-loop", "work-recover",
      "warmup-alert", "warmup-loop", "study-focus-loop", "study-curious",
      "night-enter", "night-loop", "night-exit",
    ];
    expect(new Set(rows).size).toBe(18);
    expect(animationForSceneAppearance({ kind: "hydration" }, "full", true)).toBe("hydration-wait");
    expect(animationForSceneAppearance({ kind: "work", stage: "transition" }, "full", true)).toBe("work-fatigue-enter");
  });

  it("holds transition until Rust reports fatigued and ignores stale stage assumptions", () => {
    expect(settledSceneAnimation("work-fatigue-enter", { kind: "work", stage: "transition" }, "full")).toBe("work-fatigue-enter");
    expect(settledSceneAnimation("work-fatigue-enter", { kind: "work", stage: "fatigued" }, "full")).toBe("work-fatigue-loop");
    expect(settledSceneAnimation("work-fatigue-enter", { kind: "work", stage: "fresh" }, "full")).toBe("work-focus-loop");
    expect(settledSceneAnimation("work-fatigue-enter", { kind: "meal" }, "full")).toBeNull();
    expect(settledSceneAnimation("work-fatigue-enter", { kind: "work", stage: "transition" }, "off")).toBeNull();
  });

  it("settles one-shots, exits recoverably, and maps legacy fallbacks", () => {
    expect(settledSceneAnimation("spa-enter", { kind: "spa" }, "full")).toBe("spa-loop");
    expect(exitAnimationForScene({ kind: "spa" }, { kind: "none" }, "full")).toBe("spa-exit");
    expect(exitAnimationForScene({ kind: "spa" }, { kind: "hydration" }, "full")).toBeNull();
    expect(fallbackAnimationForScene("work-fatigue-loop")).toBe("focus-calm");
    expect(recoveryAnimationForScene(
      { kind: "work", stage: "fatigued" },
      { kind: "work", stage: "fresh" },
      "full",
    )).toBe("work-recover");
    expect(completionAnimationForCategory("water")).toBe("drinking-water");
    expect(completionAnimationForCategory("meal")).toBe("eating-food");
  });
});
