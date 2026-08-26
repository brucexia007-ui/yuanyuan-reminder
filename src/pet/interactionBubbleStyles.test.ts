import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const petCss = readFileSync(new URL("./pet.css", import.meta.url), "utf8");

function rule(selector: string) {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return petCss.match(new RegExp(`${escaped}\\s*\\{([^}]+)\\}`, "u"))?.[1] ?? "";
}

describe("interaction bubble face-safe geometry", () => {
  it("docks normal tools below the face and lifts ball hints above the control", () => {
    const toolRule = rule(".pet-system-card.tool-card");
    const ballRule = rule(".pet-system-card.tool-card.ball-card");
    expect(toolRule).toContain("top: auto");
    expect(toolRule).toContain("bottom: 6px");
    expect(ballRule).toContain("bottom: 63px");

    const stageHeight = 208;
    const cardHeight = 42;
    const faceBottom = stageHeight * 0.46;
    const ballControlTop = stageHeight - 25 - 24;
    for (const scale of [1, 1.25, 1.5]) {
      const normalCardTop = (stageHeight - 6 - cardHeight) * scale;
      const ballCardTop = (stageHeight - 63 - cardHeight) * scale;
      const ballCardBottom = (stageHeight - 63) * scale;
      expect(normalCardTop).toBeGreaterThan(faceBottom * scale);
      expect(ballCardTop).toBeGreaterThan(faceBottom * scale);
      expect(ballCardBottom).toBeLessThan(ballControlTop * scale);
    }
  });
});
