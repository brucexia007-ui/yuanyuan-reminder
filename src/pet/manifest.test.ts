import { describe, expect, it } from "vitest";

import { fallbackManifest, lookDirections } from "./manifest";

describe("圆圆动画清单", () => {
  it("包含完整标准动作、16 个视线方向和三段睡眠动作", () => {
    expect(fallbackManifest.rows).toBe(11);
    expect(lookDirections).toHaveLength(16);
    expect(Object.keys(fallbackManifest.animations)).toEqual(
      expect.arrayContaining([
        "idle",
        "running-right",
        "running-left",
        "waving",
        "jumping",
        "activity-jumping",
        "failed",
        "waiting",
        "running",
        "review",
        "sleep-enter",
        "sleeping",
        "wake-up",
        "grooming",
        "grooming-chest",
        "grooming-flank",
        "stretching",
        "yawning",
        "meowing",
        "belly-up",
        "belly-down",
        "focus-calm",
        "eating-food",
        "drinking-water",
        "treat-follow",
        "wand-play",
        "wand-reach",
        "wand-swipe",
        "wand-return",
        "pet-nuzzle",
        "ball-bat",
        "ball-pickup",
        "ball-carry",
        "ball-drop",
        "alert-glass-paws",
      ]),
    );
  });

  it("每段睡眠动作都使用独立睡眠图集的八个连续帧", () => {
    for (const name of ["sleep-enter", "sleeping", "wake-up"] as const) {
      const animation = fallbackManifest.animations[name];
      expect(animation.sheet).toBe("sleep");
      expect(animation.frames).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
      expect(animation.durations).toHaveLength(8);
      expect(animation.durations.every((duration) => duration >= 100)).toBe(true);
    }
  });

  it("入睡和唤醒是一次性过渡，睡眠呼吸保持循环", () => {
    expect(fallbackManifest.animations["sleep-enter"].loopStart).toBeNull();
    expect(fallbackManifest.animations.sleeping.loopStart).toBe(0);
    expect(fallbackManifest.animations["wake-up"].loopStart).toBeNull();
  });

  it("活动提醒使用专属的连续蹦跳循环", () => {
    const animation = fallbackManifest.animations["activity-jumping"];
    expect(animation.row).toBe(fallbackManifest.animations.jumping.row);
    expect(animation.frames).toEqual([0, 1, 2, 3, 4, 3, 2, 1]);
    expect(animation.loopStart).toBe(0);
  });

  it("没成功动作只播放一次，不让圆圆持续表现沮丧", () => {
    expect(fallbackManifest.animations.failed.loopStart).toBeNull();
  });

  it("需要用户和检查动作只播放一次，不持续催促", () => {
    expect(fallbackManifest.animations["alert-glass-paws"].loopStart).toBeNull();
    expect(fallbackManifest.animations.review.loopStart).toBeNull();
  });

  it("五组生活动作使用独立图集并保持八帧完整过渡", () => {
    for (const name of [
      "grooming",
      "grooming-chest",
      "grooming-flank",
      "stretching",
      "yawning",
      "meowing",
      "belly-up",
    ] as const) {
      const animation = fallbackManifest.animations[name];
      expect(animation.sheet).toBe("life");
      expect(animation.frames.length).toBeGreaterThanOrEqual(8);
      expect(animation.durations).toHaveLength(animation.frames.length);
      expect(animation.frames.every((frame) => frame >= 0 && frame < 8)).toBe(
        true,
      );
      expect(animation.loopStart).toBeNull();
    }
  });

  it("翻肚皮恢复动作严格倒序复用同一行", () => {
    const animation = fallbackManifest.animations["belly-down"];
    expect(animation.sheet).toBe("life");
    expect(animation.row).toBe(fallbackManifest.animations["belly-up"].row);
    expect(animation.frames).toEqual([7, 6, 5, 4, 3, 2, 1, 0]);
  });

  it("专注与互动动作使用扩展生活图集", () => {
    expect(fallbackManifest.lifeRows).toBe(21);
    for (const name of [
      "focus-calm",
      "eating-food",
      "drinking-water",
      "treat-follow",
      "wand-play",
      "wand-reach",
      "wand-swipe",
      "wand-return",
      "pet-nuzzle",
      "ball-bat",
      "ball-pickup",
      "ball-carry",
      "ball-drop",
      "alert-glass-paws",
    ] as const) {
      expect(fallbackManifest.animations[name].sheet).toBe("life");
    }
    expect(fallbackManifest.animations["focus-calm"].loopStart).toBe(0);
    expect(fallbackManifest.animations["treat-follow"].frames).toHaveLength(8);
    expect(fallbackManifest.animations["wand-reach"].row).toBe(14);
    expect(fallbackManifest.animations["wand-swipe"].row).toBe(15);
    expect(fallbackManifest.animations["wand-return"].row).toBe(16);
    expect(fallbackManifest.animations["ball-bat"].row).toBe(13);
    expect(fallbackManifest.animations["ball-pickup"].row).toBe(17);
    expect(fallbackManifest.animations["ball-carry"].row).toBe(18);
    expect(fallbackManifest.animations["ball-drop"].row).toBe(19);
    expect(fallbackManifest.animations["alert-glass-paws"].row).toBe(20);
    expect(fallbackManifest.animations["alert-glass-paws"].loopStart).toBeNull();
  });

  it("keeps the complete grooming routine around eleven seconds", () => {
    const total = [
      "grooming",
      "grooming-chest",
      "grooming-flank",
    ] as const;
    const duration = total.reduce(
      (sum, name) =>
        sum +
        fallbackManifest.animations[name].durations.reduce(
          (animationTotal, frameDuration) =>
            animationTotal + frameDuration,
          0,
        ),
      0,
    );
    expect(duration).toBeGreaterThanOrEqual(10_000);
    expect(duration).toBeLessThanOrEqual(12_000);
  });
});
