import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const petCss = readFileSync(new URL("./pet.css", import.meta.url), "utf8");

function rule(selector: string) {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return petCss.match(new RegExp(`${escaped}\\s*\\{([^}]+)\\}`, "u"))?.[1] ?? "";
}

describe("interaction bubble animation-safe geometry", () => {
  it("puts every tool hint in a lane outside the animation playfield", () => {
    const hitRegionRule = rule(".pet-hit-region.tool-interaction-stage");
    const animationRule = rule(
      ".tool-interaction-stage .pet-animation-stage",
    );
    const toolRule = rule(".pet-system-card.tool-card");
    const laneCardRule = rule(
      ".tool-interaction-stage .pet-system-card.tool-card",
    );

    expect(hitRegionRule).toContain("aspect-ratio: auto");
    expect(animationRule).toContain("left: var(--tool-card-lane-width)");
    expect(animationRule).toContain("width: var(--interaction-playfield-width)");
    expect(toolRule).toContain("top: auto");
    expect(toolRule).toContain("bottom: 6px");
    expect(laneCardRule).toContain(
      "width: 156px",
    );
    expect(laneCardRule).toContain(
      "max-width: 156px",
    );
  });
});
