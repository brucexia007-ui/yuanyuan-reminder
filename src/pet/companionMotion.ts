import type { AppSettings, CompanionExpressionSnapshot, SceneAppearance } from "../types";
import type { AnimationName } from "./manifest";
import { animationForSceneAppearance, settledSceneAnimation } from "./sceneWardrobe";

type MotionSnapshot = Pick<
  CompanionExpressionSnapshot,
  "pose" | "motion" | "accessibleState"
> & { sceneAppearance?: SceneAppearance };

export function animationForCompanionExpression(
  snapshot: MotionSnapshot,
  wardrobeMode: AppSettings["sceneWardrobeMode"] = "full",
): AnimationName {
  const scene = animationForSceneAppearance(
    snapshot.sceneAppearance ?? { kind: "none" },
    wardrobeMode,
    snapshot.motion === "reduced",
  );
  if (scene) return scene;
  switch (snapshot.pose) {
    case "focus_calm":
      return "focus-calm";
    case "stretch":
      return "stretching";
    case "sleeping":
      return "sleeping";
    case "alert":
      return snapshot.motion === "reduced" ? "waiting" : "alert-glass-paws";
    case "celebrate":
      return snapshot.motion === "reduced" ? "focus-calm" : "jumping";
    case "review":
    case "put_away":
    case "step_aside":
      return snapshot.motion === "reduced" ? "focus-calm" : "review";
    case "give_space":
      return "running-right";
    case "stay_close":
      return snapshot.accessibleState === "task_failed" &&
        snapshot.motion === "full"
        ? "failed"
        : "focus-calm";
    case "watch_computer":
    case "observe_information":
      return "waiting";
    case "approach":
    case "acknowledge":
      return "grooming";
    case "reunion":
      return "pet-nuzzle";
    default:
      return "idle";
  }
}

export function settledAnimationAfterCompanionCue(
  finished: AnimationName,
  snapshot: MotionSnapshot | null,
  wardrobeMode: AppSettings["sceneWardrobeMode"] = "full",
): AnimationName | null {
  if (!snapshot) return null;
  const scene = settledSceneAnimation(
    finished,
    snapshot.sceneAppearance ?? { kind: "none" },
    wardrobeMode,
  );
  if (scene) return scene;
  if (
    finished === "failed" &&
    snapshot.pose === "stay_close" &&
    snapshot.accessibleState === "task_failed"
  ) {
    return "focus-calm";
  }
  if (finished === "alert-glass-paws" && snapshot.pose === "alert") {
    return "waiting";
  }
  if (
    finished === "review" &&
    ["review", "put_away", "step_aside"].includes(snapshot.pose)
  ) {
    return "focus-calm";
  }
  return null;
}
