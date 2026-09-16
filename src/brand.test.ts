// @vitest-environment jsdom

import { describe, expect, it } from "vitest";
import {
  applicationDisplayName,
  petBreed,
  petDisplayName,
  petIdentityDescription,
  petPersonality,
  petSex,
  petText,
} from "./brand";

describe("product brand copy", () => {
  it("replaces only copy explicitly passed through the brand helper", () => {
    document.body.innerHTML = '<article aria-label="用户的圆圆">用户的圆圆提醒笔记</article>';

    expect(petText("圆圆提醒正在陪你")).toBe(`${applicationDisplayName}正在陪你`);
    expect(petText("圆圆正在陪你")).toBe(`${petDisplayName}正在陪你`);
    expect(document.body.textContent).toBe("用户的圆圆提醒笔记");
    expect(document.querySelector("article")?.getAttribute("aria-label")).toBe("用户的圆圆");
  });

  it("keeps the unified application's built-in Yuanyuan identity", () => {
    expect(petDisplayName).toBe("圆圆");
    expect(petSex).toBe("unknown");
    expect(petBreed).toBe("英国短毛猫");
    expect(petPersonality).toBe("温和陪伴");
    expect(petIdentityDescription).toBe("圆圆：英国短毛猫猫咪，性格温和陪伴");
  });
});
