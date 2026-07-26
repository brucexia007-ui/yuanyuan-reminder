export const ALERT_STAGE_WIDTH = 520;
export const ALERT_STAGE_HEIGHT = 420;

export interface PixelPoint {
  x: number;
  y: number;
}

export interface PixelSize {
  width: number;
  height: number;
}

export interface AlertStageBounds {
  position: PixelPoint;
  size: PixelSize;
}

export function alertPetWidth(petWidth: number): number {
  return Math.round(Math.max(244, Math.min(284, petWidth * 1.35)));
}

export function alertPetHeight(petWidth: number): number {
  return Math.round((alertPetWidth(petWidth) * 208) / 192);
}

export function alertStagePosition(
  currentPosition: PixelPoint,
  currentSize: PixelSize,
  scaleFactor: number,
  workArea?: AlertStageBounds,
): PixelPoint {
  const targetWidth = Math.round(ALERT_STAGE_WIDTH * scaleFactor);
  const targetHeight = Math.round(ALERT_STAGE_HEIGHT * scaleFactor);
  const originalRight = currentPosition.x + currentSize.width;
  const originalBottom = currentPosition.y + currentSize.height;
  let x = originalRight - targetWidth;
  let y = originalBottom - targetHeight;

  if (workArea) {
    const minX = workArea.position.x;
    const minY = workArea.position.y;
    const maxX = workArea.position.x + workArea.size.width - targetWidth;
    const maxY = workArea.position.y + workArea.size.height - targetHeight;
    x = Math.min(Math.max(x, minX), Math.max(minX, maxX));
    y = Math.min(Math.max(y, minY), Math.max(minY, maxY));
  }

  return { x: Math.round(x), y: Math.round(y) };
}
