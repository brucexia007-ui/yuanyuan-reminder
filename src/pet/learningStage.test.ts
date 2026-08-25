import { describe, expect, it } from "vitest";

import {
  LEARNING_STAGE_HEIGHT,
  LEARNING_STAGE_BOTTOM_LIFT,
  LEARNING_STAGE_EDGE_INSET,
  LEARNING_STAGE_WIDTH,
  learningStagePosition,
  restoredPetPosition,
  scaledScreenWorkArea,
  visibleMonitorWorkArea,
} from "./learningStage";

describe("restoredPetPosition", () => {
  it("lifts a compact pet above the taskbar after a high-DPI stage closes", () => {
    expect(
      restoredPetPosition(
        { x: 77, y: 1280 },
        { width: 522, height: 563 },
        {
          position: { x: 0, y: 0 },
          size: { width: 2560, height: 1392 },
        },
      ),
    ).toEqual({ x: 77, y: 829 });
  });

  it("keeps an already visible compact pet in place", () => {
    expect(
      restoredPetPosition(
        { x: 1200, y: 700 },
        { width: 522, height: 563 },
        {
          position: { x: 0, y: 0 },
          size: { width: 2560, height: 1392 },
        },
      ),
    ).toEqual({ x: 1200, y: 700 });
  });
});

describe("scaledScreenWorkArea", () => {
  it("converts WebView logical work-area bounds to physical pixels", () => {
    expect(
      scaledScreenWorkArea(
        {
          availLeft: 0,
          availTop: 0,
          availWidth: 1706.6667,
          availHeight: 928,
        },
        1.5,
      ),
    ).toEqual({
      position: { x: 0, y: 0 },
      size: { width: 2560, height: 1392 },
    });
  });

  it("rejects invalid screen metrics", () => {
    expect(
      scaledScreenWorkArea(
        { availLeft: 0, availTop: 0, availWidth: 0, availHeight: 928 },
        1.5,
      ),
    ).toBeUndefined();
  });
});

describe("visibleMonitorWorkArea", () => {
  it("intersects an over-reported work area with the physical monitor", () => {
    expect(
      visibleMonitorWorkArea(
        {
          position: { x: 0, y: 0 },
          size: { width: 2560, height: 1462 },
        },
        {
          position: { x: 0, y: 0 },
          size: { width: 2560, height: 1440 },
        },
      ),
    ).toEqual({
      position: { x: 0, y: 0 },
      size: { width: 2560, height: 1440 },
    });
  });

  it("keeps the smaller taskbar-aware work area", () => {
    expect(
      visibleMonitorWorkArea(
        {
          position: { x: 0, y: 0 },
          size: { width: 2560, height: 1392 },
        },
        {
          position: { x: 0, y: 0 },
          size: { width: 2560, height: 1440 },
        },
      ).size.height,
    ).toBe(1392);
  });
});

describe("learningStagePosition", () => {
  it("keeps the pet centre and bottom anchored at 100% scaling", () => {
    const current = { x: 900, y: 700 };
    const size = { width: 220, height: 240 };
    const next = learningStagePosition(current, size, 1);

    expect(next.x + LEARNING_STAGE_WIDTH / 2).toBe(
      current.x + size.width / 2,
    );
    expect(next.y + LEARNING_STAGE_HEIGHT).toBe(
      current.y + size.height - LEARNING_STAGE_BOTTOM_LIFT,
    );
  });

  it("uses physical pixels at 150% scaling", () => {
    const current = { x: 1200, y: 720 };
    const size = { width: 330, height: 360 };
    const next = learningStagePosition(current, size, 1.5);

    expect(next.x).toBe(1200 + 165 - Math.round(LEARNING_STAGE_WIDTH * 1.5) / 2);
    expect(next.y).toBe(
      720 +
        360 -
        Math.round(LEARNING_STAGE_HEIGHT * 1.5) -
        Math.round(LEARNING_STAGE_BOTTOM_LIFT * 1.5),
    );
  });

  it("clamps the expanded stage to the monitor work area", () => {
    const workArea = {
      position: { x: 1920, y: 0 },
      size: { width: 1280, height: 720 },
    };
    const next = learningStagePosition(
      { x: 3100, y: 620 },
      { width: 220, height: 240 },
      1,
      workArea,
    );

    expect(next.x).toBe(
      1920 + 1280 - LEARNING_STAGE_WIDTH - LEARNING_STAGE_EDGE_INSET,
    );
    expect(next.y).toBe(
      720 - LEARNING_STAGE_HEIGHT - LEARNING_STAGE_EDGE_INSET,
    );
  });

  it("keeps a scaled safety inset on high-DPI work-area edges", () => {
    const next = learningStagePosition(
      { x: 0, y: 1090 },
      { width: 330, height: 360 },
      1.5,
      {
        position: { x: 0, y: 0 },
        size: { width: 2560, height: 1450 },
      },
    );

    expect(next.x).toBe(Math.round(LEARNING_STAGE_EDGE_INSET * 1.5));
    expect(next.y + Math.round(LEARNING_STAGE_HEIGHT * 1.5)).toBe(
      1450 - Math.round(LEARNING_STAGE_EDGE_INSET * 1.5),
    );
  });
});
