import { describe, expect, it } from "vitest";

import { parseLearningBuildFlag } from "./featureGate";

describe("learning preview build gate", () => {
  it("requires the exact explicit opt-in value", () => {
    expect(parseLearningBuildFlag("1")).toBe(true);
    for (const value of [undefined, null, "", "0", "true", 1]) {
      expect(parseLearningBuildFlag(value)).toBe(false);
    }
  });
});
