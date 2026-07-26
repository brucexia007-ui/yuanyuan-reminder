export type BallGamePhase =
  | "ready"
  | "charging"
  | "flying"
  | "chasing"
  | "batting"
  | "pickup"
  | "returning"
  | "dropping";

export const BALL_GAME_PHASE_MS: Partial<Record<BallGamePhase, number>> = {
  chasing: 760,
  batting: 1_360,
  pickup: 1_520,
  returning: 1_800,
  dropping: 1_720,
};

export function nextBallGamePhase(
  phase: BallGamePhase,
): BallGamePhase | null {
  switch (phase) {
    case "flying":
      return "chasing";
    case "chasing":
      return "batting";
    case "batting":
      return "pickup";
    case "pickup":
      return "returning";
    case "returning":
      return "dropping";
    case "dropping":
      return null;
    default:
      return phase;
  }
}

export function ballStageWidth(petWidth: number): number {
  return Math.max(petWidth, Math.min(320, petWidth + 128));
}

export function ballChargeFromElapsed(elapsedMs: number): number {
  return Math.max(0.12, Math.min(1, elapsedMs / 1_500));
}

export function ballFlightDuration(charge: number): number {
  return Math.round(520 + Math.max(0, Math.min(1, charge)) * 430);
}

export function ballHomeX(petWidth: number): number {
  return Math.round(petWidth * 0.72);
}

export function ballTargetX(
  stageWidth: number,
  petWidth: number,
  charge: number,
): number {
  const home = ballHomeX(petWidth);
  const farthest = Math.max(home + 48, stageWidth - 58);
  const power = 0.32 + Math.max(0, Math.min(1, charge)) * 0.68;
  return Math.round(home + (farthest - home) * power);
}

export function ballChaseOffset(
  targetX: number,
  stageWidth: number,
  petWidth: number,
): number {
  return Math.round(
    Math.max(0, Math.min(stageWidth - petWidth, targetX - petWidth * 0.64)),
  );
}
