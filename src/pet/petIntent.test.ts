import { describe, expect, it } from "vitest";
import type { PetIntent } from "../types";
import { formatRemaining, shouldAcceptIntent } from "./petIntent";

function intent(patch: Partial<PetIntent> = {}): PetIntent {
  return {
    id: "one",
    kind: "reminder",
    priority: 100,
    animation: "waving",
    route: "today",
    title: "提醒",
    message: "事项",
    occurrenceId: "occurrence-1",
    persistent: true,
    expiresAt: null,
    ...patch,
  };
}

describe("pet intent priority", () => {
  it("does not let a low-priority state replace a reminder", () => {
    expect(
      shouldAcceptIntent(intent(), intent({ id: "focus", kind: "focus", priority: 50 })),
    ).toBe(false);
  });

  it("lets an outcome replace the reminder it resolves", () => {
    expect(
      shouldAcceptIntent(
        intent(),
        intent({ id: "done", kind: "success", priority: 70 }),
      ),
    ).toBe(true);
  });

  it("accepts a new intent after the current one expires", () => {
    expect(
      shouldAcceptIntent(
        intent({ expiresAt: "2026-01-01T00:00:00.000Z" }),
        intent({ id: "focus", kind: "focus", priority: 50 }),
        Date.parse("2026-01-01T00:00:01.000Z"),
      ),
    ).toBe(true);
  });

  it("keeps a simultaneous water reminder ahead of activity", () => {
    expect(
      shouldAcceptIntent(
        intent({ title: "该喝水啦", priority: 100 }),
        intent({
          id: "activity",
          kind: "activity",
          animation: "activity-jumping",
          priority: 90,
          occurrenceId: "activity-occurrence",
        }),
      ),
    ).toBe(false);
  });
});

describe("focus countdown", () => {
  it("formats a non-negative mm:ss value", () => {
    expect(
      formatRemaining(
        "2026-01-01T00:25:00.000Z",
        Date.parse("2026-01-01T00:00:00.000Z"),
      ),
    ).toBe("25:00");
    expect(
      formatRemaining(
        "2026-01-01T00:00:00.000Z",
        Date.parse("2026-01-01T00:00:01.000Z"),
      ),
    ).toBe("00:00");
  });
});
