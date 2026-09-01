// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { petDisplayName } from "../brand";

vi.mock("../pet/SpriteAnimator", () => ({
  SpriteAnimator: ({ animation }: { animation: string }) => (
    <div data-testid="sprite" data-animation={animation} />
  ),
}));

import { SupportLab } from "./SupportLab";

let container: HTMLDivElement;
let root: Root;

function button(label: string): HTMLButtonElement {
  const match = [...container.querySelectorAll("button")].find(
    (item) => item.textContent?.trim() === label,
  );
  if (!match) throw new Error(`button not found: ${label}`);
  return match;
}

async function click(label: string) {
  await act(async () => {
    button(label).dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
}

describe("SupportLab", () => {
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

  it("exposes only the three basic user-triggered paths", async () => {
    await act(async () => root.render(<SupportLab />));
    expect(container.textContent).toContain(`让${petDisplayName}靠近`);
    expect(container.textContent).not.toContain("只听不记");
    expect(container.textContent).not.toContain("缓一缓");
    expect(container.textContent).not.toContain("理一理");

    await click(`让${petDisplayName}靠近`);
    expect(container.textContent).toContain("只陪我一会");
    expect(container.textContent).toContain("陪我动一动");
    expect(container.textContent).toContain("先别管我");
  });

  it("honors give-space without an optional check-in", async () => {
    await act(async () => root.render(<SupportLab />));
    await click(`让${petDisplayName}靠近`);
    await click(`先别管我${petDisplayName}后退，不再回看`);
    expect(container.querySelector("[data-animation='running-right']")).not.toBeNull();
    await click("关闭，不再回看");
    expect(container.textContent).toContain("空间已留出来");
    expect(container.textContent).not.toContain("收好小牌");
  });
});
