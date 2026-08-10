import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import type { TaskWatchSnapshot } from "../types";
import { TaskWatchView } from "./TaskPanel";

function render(snapshot: TaskWatchSnapshot) {
  return renderToStaticMarkup(
    <TaskWatchView
      snapshot={snapshot}
      onRefresh={vi.fn(async () => undefined)}
      onDefer={vi.fn(async () => undefined)}
      onResume={vi.fn(async () => undefined)}
    />,
  );
}

describe("TaskWatchView", () => {
  it("shows only fixed source, state, and bounded counts", () => {
    const markup = render({
      schemaVersion: 2,
      available: true,
      observedCount: 4,
      needsUserCount: 1,
      states: [
        { source: "codex", state: "running", count: 3, deferredUntilUnixMs: null },
        {
          source: "claude_code",
          state: "waiting_user",
          count: 1,
          deferredUntilUnixMs: 3_000_000,
        },
      ],
    });

    expect(markup).toContain("Codex");
    expect(markup).toContain("Claude Code");
    expect(markup).toContain("守望中");
    expect(markup).toContain("需要你");
    expect(markup).toContain("共 4 项，1 项需要你");
    expect(markup).toContain("不显示任务标题、项目路径、任务标识或精确活动时间");
    expect(markup).toContain("任务会一直保留在这里");
    expect(markup).toContain("10 分钟后再提醒");
    expect(markup).toContain("已暂缓主动提醒");
    expect(markup).toContain("恢复提醒");
    expect(markup).not.toMatch(/task[_-]?id|workspace|prompt|message|任务正文[:：]/i);
  });

  it("does not pretend a connector is available when the trusted store is absent", () => {
    const markup = render({
      schemaVersion: 2,
      available: false,
      observedCount: 0,
      needsUserCount: 0,
      states: [],
    });
    expect(markup).toContain("还没有可信任务状态");
    expect(markup).toContain("不会自行修改 Codex 或 Claude Code 的配置");
  });
});
