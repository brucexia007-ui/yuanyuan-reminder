import { describe, expect, it } from "vitest";
import type { CompanionExpressionSnapshot } from "../types";
import { companionPresentation } from "./companionPresentation";

function snapshot(
  overrides: Partial<CompanionExpressionSnapshot> = {},
): CompanionExpressionSnapshot {
  return {
    schemaVersion: 2,
    revision: 1,
    tier: "n2",
    intent: "watch",
    pose: "watch_computer",
    props: ["computer"],
    label: "running",
    attention: "silent",
    motion: "full",
    movePropForward: false,
    queueInBasket: false,
    taskSource: "codex",
    groupedCount: 1,
    focusDeferredCount: 0,
    accessibleState: "task_running",
    sceneAppearance: { kind: "work", stage: "fresh" },
    ...overrides,
  };
}

describe("companionPresentation", () => {
  it("turns fixed task state into fixed prop copy without accepting task text", () => {
    expect(companionPresentation(snapshot())).toEqual({
      shortLabel: "守望中",
      accessibleLabel: "圆圆正在电脑旁守望任务",
      sourceLabel: "Codex",
      props: ["computer"],
      groupLabel: null,
    });
  });

  it("keeps routine task labels hidden in adaptive mode", () => {
    expect(companionPresentation(snapshot(), "adaptive")).toMatchObject({
      shortLabel: null,
      sourceLabel: "Codex",
      accessibleLabel: "圆圆正在电脑旁守望任务",
    });
  });

  it("shows only critical task labels in adaptive mode", () => {
    expect(
      companionPresentation(
        snapshot({ label: "failed", accessibleState: "task_failed" }),
        "adaptive",
      ).shortLabel,
    ).toBe("没成功");
  });

  it("lets the user permanently choose pure motion or always-visible labels", () => {
    const failed = snapshot({
      label: "failed",
      accessibleState: "task_failed",
    });
    expect(companionPresentation(failed, "motion_only").shortLabel).toBeNull();
    expect(companionPresentation(snapshot(), "always").shortLabel).toBe("守望中");
  });

  it("deduplicates and bounds props and caps the visible grouped count", () => {
    const unsafe = snapshot({
      props: [
        "task_card",
        "task_card",
        "basket",
        "bell",
        "computer",
        "prompter",
        "system_card",
      ],
      groupedCount: 65_535,
    });
    const presentation = companionPresentation(unsafe);
    expect(presentation.props).toEqual([
      "task_card",
      "basket",
      "bell",
      "computer",
      "prompter",
      "system_card",
    ]);
    expect(presentation.groupLabel).toBe("99+");
  });

  it("falls back to quiet accessible copy for an unknown future state", () => {
    const future = snapshot({
      accessibleState: "future_state" as CompanionExpressionSnapshot["accessibleState"],
      label: "future_label" as CompanionExpressionSnapshot["label"],
      taskSource: "future_source" as CompanionExpressionSnapshot["taskSource"],
    });
    expect(companionPresentation(future)).toMatchObject({
      shortLabel: null,
      accessibleLabel: "圆圆正在安静陪伴",
      sourceLabel: null,
    });
  });

  it("provides fixed accessible meaning for the silent focus-finished ritual", () => {
    expect(
      companionPresentation(
        snapshot({
          tier: "n1",
          intent: "stay_close",
          pose: "stretch",
          props: [],
          label: null,
          taskSource: null,
          accessibleState: "focus_finished",
        }),
      ).accessibleLabel,
    ).toBe("专注结束，圆圆伸了个懒腰");
  });

  it("provides fixed accessible meaning for the nonverbal reunion ritual", () => {
    expect(
      companionPresentation(
        snapshot({
          tier: "n1",
          intent: "approach",
          pose: "reunion",
          props: [],
          label: null,
          taskSource: null,
          accessibleState: "welcoming_return",
        }),
      ).accessibleLabel,
    ).toBe("圆圆起身靠近，轻轻蹭了蹭你");
  });
});
