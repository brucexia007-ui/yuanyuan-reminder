import { describe, expect, it } from "vitest";

import { definitionForSceneAvailability } from "./SpriteAnimator";
import { fallbackManifest } from "./manifest";

describe("SpriteAnimator scene availability", () => {
  it("falls back to a legacy definition when the scene atlas cannot load", () => {
    expect(
      definitionForSceneAvailability(
        fallbackManifest,
        "hydration-alert",
        "alert-glass-paws",
        false,
      ),
    ).toBe(fallbackManifest.animations["alert-glass-paws"]);
    expect(
      definitionForSceneAvailability(
        fallbackManifest,
        "hydration-alert",
        "alert-glass-paws",
        true,
      ),
    ).toBe(fallbackManifest.animations["hydration-alert"]);
  });
});
