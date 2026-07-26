export function shouldMirrorTowardPointer(x: number, width: number): boolean {
  return x < width / 2;
}

export function shouldMirrorTowardPointerWithHysteresis(
  x: number,
  width: number,
  currentlyMirrored: boolean,
): boolean {
  const leftThreshold = width * 0.43;
  const rightThreshold = width * 0.57;
  if (x <= leftThreshold) return true;
  if (x >= rightThreshold) return false;
  return currentlyMirrored;
}

export function followOffsetTowardPointer(x: number, width: number): number {
  return Math.round(Math.max(-14, Math.min(14, (x - width / 2) * 0.18)));
}

export function gentleHeadOffsetTowardPointer(
  x: number,
  width: number,
): number {
  return Math.round(Math.max(-5, Math.min(5, (x - width / 2) * 0.06)));
}

export function shouldAdvancePettingFrame(
  distance: number,
  elapsedMs: number,
): boolean {
  return distance >= 6 && elapsedMs >= 90;
}

export function wandDirectionFrame(
  x: number,
  y: number,
  width: number,
  height: number,
  currentFrame = 2,
): number {
  const dx = x - width / 2;
  const dy = y - height * 0.46;
  if (Math.hypot(dx, dy) < Math.min(width, height) * 0.08) {
    return currentFrame;
  }
  const clockwiseFromTop = (Math.atan2(dx, -dy) * 180) / Math.PI;
  return Math.round((clockwiseFromTop + 360) / 45) % 8;
}

export function treatFrameFromPointerHeight(y: number, height: number): number {
  const normalizedHeight = 1 - (y - 12) / Math.max(1, height - 24);
  return Math.max(0, Math.min(7, Math.round(normalizedHeight * 7)));
}

export function advanceInteractionFrame(
  currentFrame: number,
  distance: number,
): number {
  const motionSteps = Math.max(1, Math.min(2, Math.round(distance / 10)));
  return (currentFrame + motionSteps) % 8;
}

export type ToolInteractionTransition<T extends { id: string }> =
  | { type: "start"; interaction: T }
  | { type: "end" }
  | { type: "timeout"; interactionId: string };

export function transitionToolInteraction<T extends { id: string }>(
  current: T | null,
  transition: ToolInteractionTransition<T>,
): T | null {
  if (transition.type === "start") return transition.interaction;
  if (transition.type === "end") return null;
  return current?.id === transition.interactionId ? null : current;
}
