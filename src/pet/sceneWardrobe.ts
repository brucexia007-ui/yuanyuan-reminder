import type {
  AppSettings,
  SceneAppearance,
} from "../types";
import type { AnimationName, SceneAnimationName } from "./manifest";

export function sceneWardrobeEnabled(
  appearance: SceneAppearance,
  mode: AppSettings["sceneWardrobeMode"],
): boolean {
  if (mode === "off" || appearance.kind === "none") return false;
  return mode === "full" || ["meal", "hydration"].includes(appearance.kind);
}

export function animationForSceneAppearance(
  appearance: SceneAppearance,
  mode: AppSettings["sceneWardrobeMode"],
  reducedMotion = false,
): SceneAnimationName | null {
  if (!sceneWardrobeEnabled(appearance, mode)) return null;
  switch (appearance.kind) {
    case "spa":
      return reducedMotion ? "spa-loop" : "spa-enter";
    case "meal":
      return reducedMotion ? "meal-wait" : "meal-alert";
    case "hydration":
      return reducedMotion ? "hydration-wait" : "hydration-alert";
    case "warmup":
      return reducedMotion ? "warmup-loop" : "warmup-alert";
    case "study":
      return "study-focus-loop";
    case "night":
      return reducedMotion ? "night-loop" : "night-enter";
    case "work":
      if (appearance.stage === "fatigued") return "work-fatigue-loop";
      if (appearance.stage === "transition") {
        return "work-fatigue-enter";
      }
      return "work-focus-loop";
    case "none":
      return null;
  }
}

export function settledSceneAnimation(
  finished: AnimationName,
  appearance: SceneAppearance,
  mode: AppSettings["sceneWardrobeMode"],
): SceneAnimationName | null {
  if (!sceneWardrobeEnabled(appearance, mode)) return null;
  switch (finished) {
    case "spa-enter":
      return appearance.kind === "spa" ? "spa-loop" : null;
    case "meal-alert":
      return appearance.kind === "meal" ? "meal-wait" : null;
    case "hydration-alert":
      return appearance.kind === "hydration" ? "hydration-wait" : null;
    case "warmup-alert":
      return appearance.kind === "warmup" ? "warmup-loop" : null;
    case "night-enter":
      return appearance.kind === "night" ? "night-loop" : null;
    case "work-fatigue-enter":
      return appearance.kind === "work"
        ? appearance.stage === "transition"
          ? "work-fatigue-enter"
          : animationForSceneAppearance(appearance, mode)
        : null;
    case "work-recover":
      return appearance.kind === "work" ? "work-focus-loop" : null;
    case "study-curious":
      return appearance.kind === "study" ? "study-focus-loop" : null;
    default:
      return null;
  }
}

export function exitAnimationForScene(
  previous: SceneAppearance,
  next: SceneAppearance,
  mode: AppSettings["sceneWardrobeMode"],
): SceneAnimationName | null {
  if (!sceneWardrobeEnabled(previous, mode) || previous.kind === next.kind) return null;
  // Higher-priority scenes interrupt immediately. Rest/night exits are reserved
  // for an actual stop/wake transition so a temporary reminder can reveal them
  // again from a clean semantic snapshot.
  if (previous.kind === "spa" && ["none", "night"].includes(next.kind)) return "spa-exit";
  if (previous.kind === "night" && next.kind === "none") return "night-exit";
  return null;
}

export function recoveryAnimationForScene(
  previous: SceneAppearance,
  next: SceneAppearance,
  mode: AppSettings["sceneWardrobeMode"],
): SceneAnimationName | null {
  if (mode !== "full" || next.kind !== "work" || next.stage !== "fresh") return null;
  if (
    previous.kind === "warmup" ||
    (previous.kind === "work" && previous.stage !== "fresh")
  ) {
    return "work-recover";
  }
  return null;
}

export function fallbackAnimationForScene(
  animation: AnimationName,
): AnimationName {
  if (["meal-alert", "hydration-alert"].includes(animation)) return "alert-glass-paws";
  if (["meal-wait", "hydration-wait"].includes(animation)) return "waiting";
  if (["warmup-alert", "warmup-loop"].includes(animation)) return "activity-jumping";
  if (["study-focus-loop", "study-curious"].includes(animation)) return "learning-study-sit";
  if (["night-enter", "night-loop"].includes(animation)) return "sleeping";
  if (animation === "night-exit") return "wake-up";
  if (animation.startsWith("work-") || animation.startsWith("spa-")) return "focus-calm";
  return animation;
}

export function completionAnimationForCategory(
  category: string,
): AnimationName | null {
  if (category === "water") return "drinking-water";
  if (category === "meal") return "eating-food";
  return null;
}
