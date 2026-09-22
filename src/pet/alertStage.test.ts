import { describe, expect, it } from "vitest";
import tauriConfig from "../../src-tauri/tauri.conf.json";

import {
  ALERT_STAGE_HEIGHT,
  ALERT_STAGE_WIDTH,
  alertPetHeight,
  alertPetWidth,
  alertStagePosition,
  warmupStageLayout,
} from "./alertStage";

describe("强提醒舞台", () => {
  it.each([120, 192, 256, 320])("热身在尺寸 %s 保持坐姿尺度并为卡片留出空间", (width) => {
    const layout = warmupStageLayout(width);
    expect(Math.abs(layout.spriteWidth * 124 / 192 - width * 198 / 192)).toBeLessThan(1);
    expect(layout.height - 2 - layout.spriteHeight).toBeGreaterThanOrEqual(138);
    expect(layout.width - layout.spriteWidth).toBeGreaterThanOrEqual(40);
    const nativePet = tauriConfig.app.windows.find(window => window.label === "pet")!;
    expect(layout.width).toBeLessThanOrEqual(nativePet.maxWidth);
    expect(layout.height).toBeLessThanOrEqual(nativePet.maxHeight);
    for (const scale of [1, 1.25, 1.5]) {
      const next = alertStagePosition({ x: 1500, y: 900 }, { width: 220, height: 240 }, scale, undefined, layout);
      expect(next.x + Math.round(layout.width * scale)).toBe(1720);
      expect(next.y + Math.round(layout.height * scale)).toBe(1140);
    }
  });
  it("正常情况下保持原窗口右下角锚点", () => {
    const current = { x: 1500, y: 760 };
    const currentSize = { width: 220, height: 240 };
    const next = alertStagePosition(current, currentSize, 1);

    expect(next.x + ALERT_STAGE_WIDTH).toBe(current.x + currentSize.width);
    expect(next.y + ALERT_STAGE_HEIGHT).toBe(current.y + currentSize.height);
  });

  it("会限制在当前显示器工作区内", () => {
    const workArea = {
      position: { x: 1920, y: 0 },
      size: { width: 1280, height: 984 },
    };
    const next = alertStagePosition(
      { x: 1930, y: 10 },
      { width: 220, height: 240 },
      1,
      workArea,
    );

    expect(next.x).toBeGreaterThanOrEqual(workArea.position.x);
    expect(next.y).toBeGreaterThanOrEqual(workArea.position.y);
    expect(next.x + ALERT_STAGE_WIDTH).toBeLessThanOrEqual(
      workArea.position.x + workArea.size.width,
    );
    expect(next.y + ALERT_STAGE_HEIGHT).toBeLessThanOrEqual(
      workArea.position.y + workArea.size.height,
    );
  });

  it("正确处理高 DPI 缩放", () => {
    const next = alertStagePosition(
      { x: 1200, y: 600 },
      { width: 330, height: 360 },
      1.5,
    );

    expect(next).toEqual({
      x: 1200 + 330 - ALERT_STAGE_WIDTH * 1.5,
      y: 600 + 360 - ALERT_STAGE_HEIGHT * 1.5,
    });
  });

  it("提醒时圆圆会比默认体型明显放大且保持上限", () => {
    expect(alertPetWidth(192)).toBe(259);
    expect(alertPetWidth(120)).toBe(244);
    expect(alertPetWidth(320)).toBe(284);
  });

  it("最大尺寸也会在提醒卡片下方为圆圆的脸留出安全区", () => {
    const spriteTop = ALERT_STAGE_HEIGHT - 2 - alertPetHeight(320);
    expect(spriteTop).toBeGreaterThanOrEqual(100);
  });
});
