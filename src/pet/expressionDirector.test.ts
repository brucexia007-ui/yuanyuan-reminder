import { describe, expect, it } from "vitest";
import {
  directTaskExpression,
  taskWatchStates,
  type TaskExpressionInput,
} from "./expressionDirector";

const base: TaskExpressionInput = {
  state: "running",
  labelMode: "adaptive",
  vocabularyFamiliar: true,
  reduceMotion: false,
  focusActive: false,
  sourceLabel: "Codex",
};

describe("non-verbal task expression director", () => {
  it("covers every frozen watcher state at N2 without dialogue", () => {
    for (const state of taskWatchStates) {
      const plan = directTaskExpression({ ...base, state });
      expect(plan.tier).toBe("N2");
      expect(plan.props.length).toBeGreaterThan(0);
      expect(plan.accessibleName).toMatch(/^Codex，任务/);
      expect(plan.accessibleName).not.toMatch(/圆圆说|我觉得|我来/);
    }
  });

  it("uses a bell and task card only when the user is needed", () => {
    const waiting = directTaskExpression({ ...base, state: "waiting_user" });
    expect(waiting.props).toEqual(["bell", "task_card"]);
    expect(waiting.attention).toBe("ring_once");
    expect(waiting.movePropForward).toBe(true);

    const running = directTaskExpression(base);
    expect(running.props).toEqual(["computer"]);
    expect(running.attention).toBe("silent");
  });

  it("never treats unknown or stalled as success or failure", () => {
    for (const state of ["unknown", "stalled"] as const) {
      const plan = directTaskExpression({ ...base, state });
      expect(plan.intent).toBe("inspect");
      expect(plan.animation).toBe("review");
      expect(plan.labelVisible).toBe(true);
    }
  });

  it("keeps labels off in motion-only mode and permanently on in label mode", () => {
    expect(
      directTaskExpression({ ...base, state: "waiting_user", labelMode: "motion_only" })
        .labelVisible,
    ).toBe(false);
    expect(
      directTaskExpression({ ...base, state: "running", labelMode: "always" })
        .labelVisible,
    ).toBe(true);
  });

  it("shows adaptive labels during learning and for ambiguous or urgent states", () => {
    expect(directTaskExpression(base).labelVisible).toBe(false);
    expect(
      directTaskExpression({ ...base, vocabularyFamiliar: false }).labelVisible,
    ).toBe(true);
    expect(
      directTaskExpression({ ...base, state: "waiting_user" }).labelVisible,
    ).toBe(true);
    expect(directTaskExpression({ ...base, state: "unknown" }).labelVisible).toBe(
      true,
    );
  });

  it("suppresses non-urgent presentation during focus but never hides waiting_user", () => {
    const completed = directTaskExpression({
      ...base,
      state: "succeeded",
      focusActive: true,
    });
    expect(completed.attention).toBe("silent");
    expect(completed.movePropForward).toBe(false);
    expect(completed.queueInBasket).toBe(true);

    const waiting = directTaskExpression({
      ...base,
      state: "waiting_user",
      focusActive: true,
    });
    expect(waiting.attention).toBe("ring_once");
    expect(waiting.movePropForward).toBe(true);
  });

  it("preserves meaning while reducing motion", () => {
    const full = directTaskExpression({ ...base, state: "failed" });
    const reduced = directTaskExpression({
      ...base,
      state: "failed",
      reduceMotion: true,
    });
    expect(reduced.motion).toBe("reduced");
    expect(reduced.intent).toBe(full.intent);
    expect(reduced.props).toEqual(full.props);
    expect(reduced.accessibleName).toBe(full.accessibleName);
    expect(full.animation).toBe("failed");
    expect(reduced.animation).toBe("focus-calm");

    const expected = {
      waiting_user: "waiting",
      succeeded: "focus-calm",
      stalled: "focus-calm",
      cancelled: "focus-calm",
      unknown: "focus-calm",
    } as const;
    for (const [state, animation] of Object.entries(expected)) {
      const fullPlan = directTaskExpression({
        ...base,
        state: state as keyof typeof expected,
      });
      const reducedPlan = directTaskExpression({
        ...base,
        state: state as keyof typeof expected,
        reduceMotion: true,
      });
      expect(reducedPlan.intent).toBe(fullPlan.intent);
      expect(reducedPlan.props).toEqual(fullPlan.props);
      expect(reducedPlan.accessibleName).toBe(fullPlan.accessibleName);
      expect(reducedPlan.animation).toBe(animation);
    }
  });
});
