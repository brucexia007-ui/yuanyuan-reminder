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

  it("locks 饺饺's requested identity in the brand source", () => {
    expect(petDisplayName).toBe("饺饺");
    expect(petSex).toBe("female");
    expect(petBreed).toBe("英短金点");
    expect(petPersonality).toBe("乖巧高冷");
    expect(petIdentityDescription).toBe("饺饺：英短金点母猫，性格乖巧高冷");
  });
});
