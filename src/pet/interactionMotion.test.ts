import { describe, expect, it } from "vitest";
import {
  advanceInteractionFrame,
  followOffsetTowardPointer,
  gentleHeadOffsetTowardPointer,
  shouldAdvancePettingFrame,
  shouldMirrorTowardPointer,
  shouldMirrorTowardPointerWithHysteresis,
  transitionToolInteraction,
  treatFrameFromPointerHeight,
  wandDirectionFrame,
} from "./interactionMotion";

describe("pointer-driven pet interactions", () => {
  it("mirrors YuanYuan toward left-side tools and keeps right-side tools unmirrored", () => {
    expect(shouldMirrorTowardPointer(40, 192)).toBe(true);
    expect(shouldMirrorTowardPointer(152, 192)).toBe(false);
  });

  it("maps a raised treat to a standing pose and a low treat to a crouch", () => {
    expect(treatFrameFromPointerHeight(12, 208)).toBe(7);
    expect(treatFrameFromPointerHeight(196, 208)).toBe(0);
  });

  it("moves the sprite only a small bounded distance toward the tool", () => {
    expect(followOffsetTowardPointer(0, 192)).toBe(-14);
    expect(followOffsetTowardPointer(192, 192)).toBe(14);
    expect(followOffsetTowardPointer(96, 192)).toBe(0);
  });

  it("keeps petting direction stable around the center of the head", () => {
    expect(shouldMirrorTowardPointerWithHysteresis(92, 192, true)).toBe(true);
    expect(shouldMirrorTowardPointerWithHysteresis(100, 192, false)).toBe(false);
    expect(shouldMirrorTowardPointerWithHysteresis(70, 192, false)).toBe(true);
    expect(shouldMirrorTowardPointerWithHysteresis(122, 192, true)).toBe(false);
  });

  it("keeps the cat-treat gaze on one side until the pointer clearly crosses center", () => {
    expect(shouldMirrorTowardPointerWithHysteresis(94, 192, false)).toBe(false);
    expect(shouldMirrorTowardPointerWithHysteresis(82, 192, false)).toBe(true);
    expect(shouldMirrorTowardPointerWithHysteresis(100, 192, true)).toBe(true);
    expect(shouldMirrorTowardPointerWithHysteresis(112, 192, true)).toBe(false);
  });

  it("uses a gentler body offset while the head follows the pointer", () => {
    expect(gentleHeadOffsetTowardPointer(0, 192)).toBe(-5);
    expect(gentleHeadOffsetTowardPointer(192, 192)).toBe(5);
    expect(gentleHeadOffsetTowardPointer(96, 192)).toBe(0);
  });

  it("advances petting only after enough movement and elapsed time", () => {
    expect(shouldAdvancePettingFrame(5, 120)).toBe(false);
    expect(shouldAdvancePettingFrame(12, 60)).toBe(false);
    expect(shouldAdvancePettingFrame(8, 100)).toBe(true);
  });

  it("maps every teaser-wand sector to its matching directional pose", () => {
    const width = 192;
    const height = 208;
    expect(wandDirectionFrame(96, 10, width, height)).toBe(0);
    expect(wandDirectionFrame(170, 25, width, height)).toBe(1);
    expect(wandDirectionFrame(180, 96, width, height)).toBe(2);
    expect(wandDirectionFrame(170, 180, width, height)).toBe(3);
    expect(wandDirectionFrame(96, 196, width, height)).toBe(4);
    expect(wandDirectionFrame(22, 180, width, height)).toBe(5);
    expect(wandDirectionFrame(12, 96, width, height)).toBe(6);
    expect(wandDirectionFrame(22, 25, width, height)).toBe(7);
  });

  it("keeps the current wand pose inside the chest deadzone", () => {
    expect(wandDirectionFrame(96, 96, 192, 208, 7)).toBe(7);
  });

  it("advances action frames from pointer motion instead of a slow autonomous loop", () => {
    expect(advanceInteractionFrame(0, 6)).toBe(1);
    expect(advanceInteractionFrame(7, 24)).toBe(1);
  });

  it("replaces a previous tool when another interaction starts", () => {
    const treat = { id: "treat-1", kind: "treat" };
    const wand = { id: "wand-1", kind: "wand" };
    expect(
      transitionToolInteraction(treat, {
        type: "start",
        interaction: wand,
      }),
    ).toEqual(wand);
  });

  it("ends the active tool when another activity takes over", () => {
    expect(
      transitionToolInteraction(
        { id: "treat-1", kind: "treat" },
        { type: "end" },
      ),
    ).toBeNull();
  });

  it("does not let an old timeout close the replacement interaction", () => {
    const wand = { id: "wand-1", kind: "wand" };
    expect(
      transitionToolInteraction(wand, {
        type: "timeout",
        interactionId: "treat-1",
      }),
    ).toEqual(wand);
    expect(
      transitionToolInteraction(wand, {
        type: "timeout",
        interactionId: "wand-1",
      }),
    ).toBeNull();
  });
});
