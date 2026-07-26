import { describe, expect, it } from "vitest";
import {
  ballChargeFromElapsed,
  ballChaseOffset,
  ballFlightDuration,
  ballHomeX,
  ballStageWidth,
  ballTargetX,
  nextBallGamePhase,
} from "./ballGame";

describe("ball fetch game geometry", () => {
  it("clamps charging between a visible minimum and full power", () => {
    expect(ballChargeFromElapsed(0)).toBe(0.12);
    expect(ballChargeFromElapsed(750)).toBe(0.5);
    expect(ballChargeFromElapsed(5_000)).toBe(1);
  });

  it("expands the default pet stage without exceeding the window limit", () => {
    expect(ballStageWidth(192)).toBe(320);
    expect(ballStageWidth(280)).toBe(320);
    expect(ballStageWidth(320)).toBe(320);
  });

  it("throws farther and longer with more charge", () => {
    const home = ballHomeX(192);
    const near = ballTargetX(320, 192, 0.12);
    const far = ballTargetX(320, 192, 1);
    expect(near).toBeGreaterThan(home);
    expect(far).toBeGreaterThan(near);
    expect(ballFlightDuration(1)).toBeGreaterThan(ballFlightDuration(0.12));
  });

  it("keeps the chasing cat inside the expanded stage", () => {
    const offset = ballChaseOffset(262, 320, 192);
    expect(offset).toBeGreaterThan(0);
    expect(offset).toBeLessThanOrEqual(128);
  });

  it("runs the complete one-shot fetch sequence and then ends", () => {
    const phases = [
      "flying",
      "chasing",
      "batting",
      "pickup",
      "returning",
      "dropping",
    ] as const;
    expect(phases.map(nextBallGamePhase)).toEqual([
      "chasing",
      "batting",
      "pickup",
      "returning",
      "dropping",
      null,
    ]);
  });
});
