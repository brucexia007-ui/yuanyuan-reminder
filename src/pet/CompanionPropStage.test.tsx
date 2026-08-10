// @vitest-environment jsdom

import { act } from "react";
import { createRoot } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { CompanionExpressionSnapshot } from "../types";
import { CompanionPropStage } from "./CompanionPropStage";

function snapshot(
  overrides: Partial<CompanionExpressionSnapshot> = {},
): CompanionExpressionSnapshot {
  return {
    schemaVersion: 1,
    revision: 1,
    tier: "n2",
    intent: "watch",
    pose: "watch_computer",
    props: ["task_card"],
    label: "running",
    attention: "silent",
    motion: "full",
    movePropForward: false,
    queueInBasket: false,
    taskSource: "codex",
    groupedCount: 1,
    focusDeferredCount: 0,
    accessibleState: "task_running",
    ...overrides,
  };
}

function render(
  labelMode: "motion_only" | "adaptive" | "always",
  overrides: Partial<CompanionExpressionSnapshot> = {},
  interactive = false,
) {
  return renderToStaticMarkup(
    <CompanionPropStage
      snapshot={snapshot(overrides)}
      labelMode={labelMode}
      onOpenTaskWatch={interactive ? () => undefined : undefined}
    />,
  );
}

describe("CompanionPropStage label modes", () => {
  it("keeps source and accessible meaning without inventing a fallback label", () => {
    const markup = render("motion_only", {
      label: "failed",
      accessibleState: "task_failed",
    });
    expect(markup).toContain("Codex");
    expect(markup).toContain("圆圆发现任务没有成功，正在你身边陪着");
    expect(markup).not.toContain("没成功");
    expect(markup).not.toContain(">任务<");
  });

  it("shows adaptive copy only for a critical state", () => {
    expect(render("adaptive")).not.toContain("守望中");
    expect(
      render("adaptive", {
        label: "failed",
        accessibleState: "task_failed",
      }),
    ).toContain("没成功");
  });

  it("shows routine fixed copy when labels are always enabled", () => {
    expect(render("always")).toContain("守望中");
  });

  it("makes only trusted external task props an explicit task-watch control", () => {
    const taskMarkup = render("adaptive", {}, true);
    expect(taskMarkup).toContain("<button");
    expect(taskMarkup).toContain("打开任务守望台");

    const localMarkup = render(
      "always",
      {
        taskSource: null,
        label: "reminder_due",
        accessibleState: "work_reminder_due",
      },
      true,
    );
    expect(localMarkup).not.toContain("<button");
    expect(localMarkup).not.toContain("打开任务守望台");
  });

  it("invokes the task-watch route exactly once from the external task prop", async () => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    const onOpenTaskWatch = vi.fn();
    await act(async () => {
      root.render(
        <CompanionPropStage
          snapshot={snapshot()}
          labelMode="adaptive"
          onOpenTaskWatch={onOpenTaskWatch}
        />,
      );
    });

    const control = container.querySelector<HTMLButtonElement>(
      'button[aria-label*="打开任务守望台"]',
    );
    expect(control).toBeTruthy();
    await act(async () => {
      control?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(onOpenTaskWatch).toHaveBeenCalledOnce();

    await act(async () => root.unmount());
    container.remove();
  });
});
