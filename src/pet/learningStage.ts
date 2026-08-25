export const LEARNING_STAGE_WIDTH = 520;
export const LEARNING_STAGE_HEIGHT = 420;
export const LEARNING_STAGE_EDGE_INSET = 32;
export const LEARNING_STAGE_BOTTOM_LIFT = 16;

export interface LearningStagePoint {
  x: number;
  y: number;
}

export interface LearningStageSize {
  width: number;
  height: number;
}

export interface LearningStageBounds {
  position: LearningStagePoint;
  size: LearningStageSize;
}

export function visibleMonitorWorkArea(
  workArea: LearningStageBounds,
  monitorBounds: LearningStageBounds,
): LearningStageBounds {
  const left = Math.max(workArea.position.x, monitorBounds.position.x);
  const top = Math.max(workArea.position.y, monitorBounds.position.y);
  const right = Math.min(
    workArea.position.x + workArea.size.width,
    monitorBounds.position.x + monitorBounds.size.width,
  );
  const bottom = Math.min(
    workArea.position.y + workArea.size.height,
    monitorBounds.position.y + monitorBounds.size.height,
  );

  if (right <= left || bottom <= top) return monitorBounds;
  return {
    position: { x: left, y: top },
    size: { width: right - left, height: bottom - top },
  };
}

export function scaledScreenWorkArea(
  screenArea: {
    availLeft?: number;
    availTop?: number;
    availWidth: number;
    availHeight: number;
  },
  scaleFactor: number,
): LearningStageBounds | undefined {
  if (
    !Number.isFinite(scaleFactor) ||
    scaleFactor <= 0 ||
    !Number.isFinite(screenArea.availWidth) ||
    !Number.isFinite(screenArea.availHeight) ||
    screenArea.availWidth <= 0 ||
    screenArea.availHeight <= 0
  ) {
    return undefined;
  }
  return {
    position: {
      x: Math.round((screenArea.availLeft ?? 0) * scaleFactor),
      y: Math.round((screenArea.availTop ?? 0) * scaleFactor),
    },
    size: {
      width: Math.round(screenArea.availWidth * scaleFactor),
      height: Math.round(screenArea.availHeight * scaleFactor),
    },
  };
}

/**
 * Restores the compact pet window without allowing a stale high-DPI position
 * to leave its body or quick actions behind the taskbar. All values are
 * physical pixels, matching Tauri's outer window APIs.
 */
export function restoredPetPosition(
  position: LearningStagePoint,
  size: LearningStageSize,
  workArea?: LearningStageBounds,
): LearningStagePoint {
  if (!workArea) return position;

  const maxX = Math.max(
    workArea.position.x,
    workArea.position.x + workArea.size.width - size.width,
  );
  const maxY = Math.max(
    workArea.position.y,
    workArea.position.y + workArea.size.height - size.height,
  );

  return {
    x: Math.min(Math.max(position.x, workArea.position.x), maxX),
    y: Math.min(Math.max(position.y, workArea.position.y), maxY),
  };
}

/**
 * Expands around the pet's visual centre while keeping its bottom edge stable.
 * This makes the board appear above/around Yuanyuan instead of teleporting the
 * pet to a detached panel. Physical coordinates are used because monitor work
 * areas and Tauri's outer window bounds are reported in physical pixels.
 */
export function learningStagePosition(
  currentPosition: LearningStagePoint,
  currentSize: LearningStageSize,
  scaleFactor: number,
  workArea?: LearningStageBounds,
): LearningStagePoint {
  const targetWidth = Math.round(LEARNING_STAGE_WIDTH * scaleFactor);
  const targetHeight = Math.round(LEARNING_STAGE_HEIGHT * scaleFactor);
  const bottomLift = Math.round(LEARNING_STAGE_BOTTOM_LIFT * scaleFactor);
  const originalCenterX = currentPosition.x + currentSize.width / 2;
  const originalBottom = currentPosition.y + currentSize.height;
  let x = Math.round(originalCenterX - targetWidth / 2);
  let y = Math.round(originalBottom - targetHeight - bottomLift);

  if (workArea) {
    const inset = Math.round(LEARNING_STAGE_EDGE_INSET * scaleFactor);
    const minX = workArea.position.x + inset;
    const minY = workArea.position.y + inset;
    const maxX =
      workArea.position.x + workArea.size.width - targetWidth - inset;
    const maxY =
      workArea.position.y + workArea.size.height - targetHeight - inset;
    x = Math.min(Math.max(x, minX), Math.max(minX, maxX));
    y = Math.min(Math.max(y, minY), Math.max(minY, maxY));
  }

  return { x, y };
}
