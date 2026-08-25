import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const panelCss = readFileSync(new URL("./panel.css", import.meta.url), "utf8");
const petCss = readFileSync(new URL("../pet/pet.css", import.meta.url), "utf8");
const learningCss = readFileSync(new URL("../learning/learning.css", import.meta.url), "utf8");

describe("Windows high-contrast styles", () => {
  it("keeps ordinary keyboard focus visible before high-contrast overrides", () => {
    expect(panelCss).toContain(
      ".panel-shell :is(button, input, select, textarea):focus-visible",
    );
    expect(panelCss).toContain("outline: 3px solid rgb(91 121 100 / 58%)");
  });

  it("keeps the panel, support choices, selected state and focus visible", () => {
    expect(panelCss).toContain("@media (forced-colors: active)");
    expect(panelCss).toContain(".basic-support-paths > button");
    expect(panelCss).toContain(".task-watch-overview");
    expect(panelCss).toContain(".task-watch-state");
    expect(panelCss).toContain('[aria-pressed="true"]');
    expect(panelCss).toContain("outline: 3px solid Highlight");
    expect(panelCss).toContain("background: Canvas");
    expect(panelCss).toContain("color: HighlightText");
  });

  it("keeps pet system cards, actions and invisible hit targets focus-visible", () => {
    expect(petCss).toContain("@media (forced-colors: active)");
    expect(petCss).toContain(".pet-system-card:focus-visible");
    expect(petCss).toContain(".pet-alert-actions button:focus-visible:not(:disabled)");
    expect(petCss).toContain(".pet-head-zone:focus-visible");
    expect(petCss).toContain("outline: 3px solid Highlight");
  });

  it("keeps learning errors and destructive-action feedback visible while scrolled", () => {
    expect(learningCss).toContain(".learning-error,");
    expect(learningCss).toContain(".learning-feedback {");
    expect(learningCss).toContain("position: sticky");
    expect(learningCss).toContain("top: 0");
  });
});
