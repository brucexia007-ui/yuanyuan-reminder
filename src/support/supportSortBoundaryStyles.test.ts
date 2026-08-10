import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const styles = readFileSync(
  new URL("./supportSortBoundaryLab.css", import.meta.url),
  "utf8",
);

describe("sort data boundary accessibility styles", () => {
  it("keeps keyboard focus, reduced motion, forced colors and narrow layouts explicit", () => {
    expect(styles).toContain("button:focus-visible");
    expect(styles).toContain("@media (prefers-reduced-motion: reduce)");
    expect(styles).toContain("@media (forced-colors: active)");
    expect(styles).toContain("@media (max-width: 760px)");
  });
});
