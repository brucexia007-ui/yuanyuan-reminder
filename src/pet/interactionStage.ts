import type { LearningStageBounds, LearningStagePoint, LearningStageSize } from "./learningStage";

export const TOOL_CARD_WIDTH = 156;
export const TOOL_CARD_EDGE_INSET = 6;
export const MAX_TOOL_ANIMATION_LEFT_SHIFT = 14;
export const TOOL_ANIMATION_CLEARANCE = 4;
export const TOOL_CARD_LANE_WIDTH =
  TOOL_CARD_EDGE_INSET +
  TOOL_CARD_WIDTH +
  MAX_TOOL_ANIMATION_LEFT_SHIFT +
  TOOL_ANIMATION_CLEARANCE;
export const COMPACT_PET_WINDOW_GUTTER = 28;

export function interactionStageWidth(playfieldWidth: number): number {
  return TOOL_CARD_LANE_WIDTH + playfieldWidth;
}

export function interactionWindowWidth(playfieldWidth: number): number {
  return interactionStageWidth(playfieldWidth) + COMPACT_PET_WINDOW_GUTTER;
}

/**
 * Adds the information lane to the left while keeping the pet/playfield at its
 * previous screen position. The result is clamped so the complete interaction
 * window remains available on the current monitor.
 */
export function interactionStagePosition(
  currentPosition: LearningStagePoint,
  currentSize: LearningStageSize,
  playfieldWidth: number,
  petHeight: number,
  scaleFactor: number,
  workArea?: LearningStageBounds,
): LearningStagePoint {
  const targetWidth = Math.round(interactionWindowWidth(playfieldWidth) * scaleFactor);
  const targetHeight = Math.round(
    (petHeight + COMPACT_PET_WINDOW_GUTTER) * scaleFactor,
  );
  let x = Math.round(currentPosition.x - TOOL_CARD_LANE_WIDTH * scaleFactor);
  let y = Math.round(currentPosition.y + currentSize.height - targetHeight);

  if (workArea) {
    const maxX = Math.max(
      workArea.position.x,
      workArea.position.x + workArea.size.width - targetWidth,
    );
    const maxY = Math.max(
      workArea.position.y,
      workArea.position.y + workArea.size.height - targetHeight,
    );
    x = Math.min(Math.max(x, workArea.position.x), maxX);
    y = Math.min(Math.max(y, workArea.position.y), maxY);
  }

  return { x, y };
}
