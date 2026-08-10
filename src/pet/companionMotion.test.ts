import { describe, expect, it } from "vitest";

import {
  animationForCompanionExpression,
  settledAnimationAfterCompanionCue,
} from "./companionMotion";

describe("圆圆任务结果动作", () => {
  it("把没成功表达为一次察觉动作，再回到安静陪伴", () => {
    const snapshot = {
      pose: "stay_close",
      motion: "full",
      accessibleState: "task_failed",
    } as const;
    expect(animationForCompanionExpression(snapshot)).toBe("failed");
    expect(settledAnimationAfterCompanionCue("failed", snapshot)).toBe(
      "focus-calm",
    );
  });

  it("减少动态时直接保持安静陪伴，不播放失败动作", () => {
    expect(
      animationForCompanionExpression({
        pose: "stay_close",
        motion: "reduced",
        accessibleState: "task_failed",
      }),
    ).toBe("focus-calm");
  });

  it("长时间运行和用户主动陪伴只安静待在身边，不借用失败动作", () => {
    expect(
      animationForCompanionExpression({
        pose: "stay_close",
        motion: "full",
        accessibleState: "task_still_running",
      }),
    ).toBe("focus-calm");
    expect(
      animationForCompanionExpression({
        pose: "stay_close",
        motion: "full",
        accessibleState: "staying_close",
      }),
    ).toBe("focus-calm");
  });

  it("不会把其他完成动作或普通陪伴误判成失败后的陪伴过渡", () => {
    expect(
      settledAnimationAfterCompanionCue("jumping", {
        pose: "celebrate",
        motion: "full",
        accessibleState: "task_completed",
      }),
    ).toBeNull();
    expect(
      settledAnimationAfterCompanionCue("failed", {
        pose: "stay_close",
        motion: "full",
        accessibleState: "staying_close",
      }),
    ).toBeNull();
  });

  it("需要用户只提醒一次，随后保持安静等待", () => {
    const snapshot = {
      pose: "alert",
      motion: "full",
      accessibleState: "task_needs_user",
    } as const;
    expect(animationForCompanionExpression(snapshot)).toBe("alert-glass-paws");
    expect(
      settledAnimationAfterCompanionCue("alert-glass-paws", snapshot),
    ).toBe("waiting");
    expect(
      animationForCompanionExpression({ ...snapshot, motion: "reduced" }),
    ).toBe("waiting");
  });

  it("检查和收起任务牌只做一次，随后回到安静陪伴", () => {
    for (const snapshot of [
      {
        pose: "review",
        motion: "full",
        accessibleState: "task_possibly_stalled",
      },
      {
        pose: "put_away",
        motion: "full",
        accessibleState: "task_cancelled",
      },
    ] as const) {
      expect(animationForCompanionExpression(snapshot)).toBe("review");
      expect(settledAnimationAfterCompanionCue("review", snapshot)).toBe(
        "focus-calm",
      );
      expect(
        animationForCompanionExpression({ ...snapshot, motion: "reduced" }),
      ).toBe("focus-calm");
    }
  });

  it("减少动态的完成状态保留任务牌语义但不播放庆祝动作", () => {
    expect(
      animationForCompanionExpression({
        pose: "celebrate",
        motion: "reduced",
        accessibleState: "task_completed",
      }),
    ).toBe("focus-calm");
  });
});
