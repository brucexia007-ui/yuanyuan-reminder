import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const desktopLearningCss = readFileSync(
  new URL("./learningDesktop.css", import.meta.url),
  "utf8",
);

describe("desktop learning completion styles", () => {
  it("keeps every completion action legible on the dark blackboard", () => {
    expect(desktopLearningCss).toContain(
      ".desktop-learning-complete-actions button {",
    );
    expect(desktopLearningCss).toContain("color: #fff8e6");
    expect(desktopLearningCss).toContain("background: rgb(255 255 255 / 8%)");
    expect(desktopLearningCss).toContain(
      ".desktop-learning-complete-actions .desktop-learning-primary",
    );
    expect(desktopLearningCss).toContain("background: #7d604b");
  });

  it("keeps the seated pet inside the 520 by 420 learning window", () => {
    expect(desktopLearningCss).toContain("height: 160px");
    expect(desktopLearningCss).toContain("width: 154px");
    expect(desktopLearningCss).toContain("height: 167px");
    expect(desktopLearningCss).toContain("bottom: 12px");
  });

  it("renders a modal confirmation before an unfinished round exits", () => {
    expect(desktopLearningCss).toContain(".desktop-learning-exit-confirm {");
    expect(desktopLearningCss).toContain("z-index: 12");
    expect(desktopLearningCss).toContain("backdrop-filter: blur(2px)");
  });

  it("maps the blackboard and its controls to Windows forced colors", () => {
    expect(desktopLearningCss).toContain("@media (forced-colors: active)");
    expect(desktopLearningCss).toContain("background: Canvas");
    expect(desktopLearningCss).toContain("background: ButtonFace");
    expect(desktopLearningCss).toContain("outline: 3px solid Highlight");
    expect(desktopLearningCss).toContain("color: CanvasText !important");
    expect(desktopLearningCss).toContain("color: GrayText !important");
  });
});
