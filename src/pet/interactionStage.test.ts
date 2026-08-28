import { describe, expect, it } from "vitest";

import {
  COMPACT_PET_WINDOW_GUTTER,
  MAX_TOOL_ANIMATION_LEFT_SHIFT,
  TOOL_ANIMATION_CLEARANCE,
  TOOL_CARD_EDGE_INSET,
  TOOL_CARD_LANE_WIDTH,
  TOOL_CARD_WIDTH,
  interactionStagePosition,
  interactionStageWidth,
  interactionWindowWidth,
} from "./interactionStage";

describe("tool interaction stage geometry", () => {
  it("reserves a card lane that never intersects the animation playfield", () => {
    for (const playfieldWidth of [120, 192, 320]) {
      const cardRect = {
        left: TOOL_CARD_EDGE_INSET,
        right: TOOL_CARD_EDGE_INSET + TOOL_CARD_WIDTH,
      };
      const animationRect = {
        left: TOOL_CARD_LANE_WIDTH - MAX_TOOL_ANIMATION_LEFT_SHIFT,
        right: interactionStageWidth(playfieldWidth),
      };

      expect(cardRect.right).toBeLessThan(animationRect.left);
      expect(animationRect.left - cardRect.right).toBe(
        TOOL_ANIMATION_CLEARANCE,
      );
      expect(
        interactionStageWidth(playfieldWidth) - TOOL_CARD_LANE_WIDTH,
      ).toBe(playfieldWidth);
      expect(interactionWindowWidth(playfieldWidth)).toBe(
        interactionStageWidth(playfieldWidth) + COMPACT_PET_WINDOW_GUTTER,
      );
    }
  });

  it("keeps the pet anchored when there is room for the expanded stage", () => {
    const position = interactionStagePosition(
      { x: 500, y: 300 },
      { width: 220, height: 240 },
      192,
      208,
      1,
    );

    expect(position).toEqual({ x: 320, y: 304 });
    expect(position.x + TOOL_CARD_LANE_WIDTH).toBe(500);
    expect(position.y + 208 + COMPACT_PET_WINDOW_GUTTER).toBe(540);
  });

  it("keeps the entire expanded stage inside the monitor work area", () => {
    const workArea = {
      position: { x: 100, y: 80 },
      size: { width: 900, height: 620 },
    };
    const position = interactionStagePosition(
      { x: 110, y: 600 },
      { width: 220, height: 240 },
      320,
      347,
      1.5,
      workArea,
    );
    const targetWidth = interactionWindowWidth(320) * 1.5;
    const targetHeight = (347 + COMPACT_PET_WINDOW_GUTTER) * 1.5;

    expect(position.x).toBe(workArea.position.x);
    expect(position.y).toBeLessThanOrEqual(
      workArea.position.y + workArea.size.height - targetHeight,
    );
    expect(position.x + targetWidth).toBeLessThanOrEqual(
      workArea.position.x + workArea.size.width,
    );
  });
});
