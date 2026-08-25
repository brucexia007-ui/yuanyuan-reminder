import { describe, expect, it } from "vitest";

import { LEARNING_BUNDLE_MARKER, learningBuildEnabled } from "./featureGate";

describe("integrated learning build contract", () => {
  it("keeps learning enabled in the unified product", () => {
    expect(learningBuildEnabled).toBe(true);
    expect(LEARNING_BUNDLE_MARKER).toBe("yuanyuan-learning-integrated-ui");
  });
});
