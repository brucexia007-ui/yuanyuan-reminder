// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../pet/SpriteAnimator", () => ({
  SpriteAnimator: ({ animation }: { animation: string }) => (
    <div data-testid="sprite" data-animation={animation} />
  ),
}));

import { SupportSortBoundaryLab } from "./SupportSortBoundaryLab";
import componentSource from "./SupportSortBoundaryLab.tsx?raw";

let container: HTMLDivElement;
let root: Root;

function button(label: string): HTMLButtonElement {
  const match = [...container.querySelectorAll("button")].find(
    (item) => item.textContent?.replace(/\s+/g, "").includes(label.replace(/\s+/g, "")),
  );
  if (!match) throw new Error(`button not found: ${label}`);
  return match;
}

async function click(label: string) {
  await act(async () => {
    button(label).dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
}

async function check(label: string) {
  const input = [...container.querySelectorAll("label")].find((item) =>
    item.textContent?.includes(label),
  )?.querySelector("input");
  if (!input) throw new Error(`checkbox not found: ${label}`);
  await act(async () => {
    input.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
}

describe("SupportSortBoundaryLab", () => {
  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
  });

  it("shows destination and exclusion details before any input or authorization", async () => {
    await act(async () => root.render(<SupportSortBoundaryLab />));
    expect(container.textContent).toContain("现在还没有输入框");
    expect(container.querySelector("textarea")).toBeNull();
    expect(container.querySelector("input[type='text']")).toBeNull();

    await click("交给云服务整理");
    expect(container.textContent).toContain("演示云服务（本页不会发送）");
    expect(container.textContent).toContain("不会附带：任务正文、文件、历史倾诉");
    expect(button("仅授权这一次").disabled).toBe(true);
  });

  it("requires review, authorizes once and then returns to reauthorization", async () => {
    await act(async () => root.render(<SupportSortBoundaryLab />));
    await click("仅在本机整理");
    await check("我已看清本次正文的去向");
    expect(button("仅授权这一次").disabled).toBe(false);
    await click("仅授权这一次");
    expect(container.textContent).toContain("本次授权已就绪");
    expect(container.textContent).toContain("五分钟内最多使用一次");
    await click("模拟使用一次授权");
    expect(container.textContent).toContain("需要重新授权");
    expect(container.textContent).toContain("Provider 请求：0；正文收集：0");
  });

  it("switching destination starts a fresh unacknowledged review", async () => {
    await act(async () => root.render(<SupportSortBoundaryLab />));
    await click("仅在本机整理");
    await check("我已看清本次正文的去向");
    await click("改选去向");
    await click("交给云服务整理");
    const disclosure = [...container.querySelectorAll("label")].find((item) =>
      item.textContent?.includes("我已看清本次正文的去向"),
    )?.querySelector("input") as HTMLInputElement;
    expect(disclosure.checked).toBe(false);
    expect(button("仅授权这一次").disabled).toBe(true);
  });

  it("cancels before submission with zero provider requests and no text field", async () => {
    await act(async () => root.render(<SupportSortBoundaryLab />));
    await click("交给云服务整理");
    await check("我已看清本次正文的去向");
    await click("仅授权这一次");
    await click("取消并清除授权");
    expect(container.textContent).toContain("已取消，本次没有发送");
    expect(container.textContent).toContain("Provider 请求均为 0");
    expect(container.querySelector("textarea")).toBeNull();
  });

  it("keeps cat motion separate from tool information and has no dialogue bubble", async () => {
    await act(async () => root.render(<SupportSortBoundaryLab />));
    expect(container.querySelector(".pet-intent-bubble")).toBeNull();
    expect(container.querySelector("[data-information-surface]")).toBeNull();
    expect(container.textContent).toContain("数据说明和授权属于工具，不是小猫对白");
    await click("仅在本机整理");
    expect(container.querySelector("[data-animation='review']")).not.toBeNull();
  });

  it("keeps the prototype offline and non-persistent", () => {
    for (const forbidden of [
      "fetch(",
      "invoke(",
      "localStorage",
      "sessionStorage",
      "indexedDB",
      "console.",
    ]) {
      expect(componentSource).not.toContain(forbidden);
    }
  });
});
