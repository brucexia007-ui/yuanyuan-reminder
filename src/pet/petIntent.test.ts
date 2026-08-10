import { describe, expect, it } from "vitest";
import type { PetIntent } from "../types";
import {
  formatRemaining,
  basicSupportSuppressesIntent,
  intentTextSurface,
  motionOnlyAccessibleLabel,
  quietSuppressesIntent,
  remindersPaused,
  shouldAcceptIntent,
} from "./petIntent";

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

describe("one-click quiet", () => {
  it("uses an absolute pause deadline and fails quiet for invalid input", () => {
    const now = Date.parse("2026-08-05T10:00:00.000Z");
    expect(remindersPaused({ pauseUntil: "2026-08-05T10:30:00.000Z" }, now)).toBe(
      true,
    );
    expect(remindersPaused({ pauseUntil: "2026-08-05T09:59:59.000Z" }, now)).toBe(
      false,
    );
    expect(remindersPaused({ pauseUntil: "invalid" }, now)).toBe(false);
  });

  it("suppresses system notices but preserves user-initiated focus and play", () => {
    expect(quietSuppressesIntent(intent({ kind: "reminder" }))).toBe(true);
    expect(quietSuppressesIntent(intent({ kind: "activity" }))).toBe(true);
    expect(quietSuppressesIntent(intent({ kind: "break" }))).toBe(true);
    expect(quietSuppressesIntent(intent({ kind: "focus" }))).toBe(false);
    expect(quietSuppressesIntent(intent({ kind: "play" }))).toBe(false);
  });
});

describe("nonverbal text routing", () => {
  it("allows text only on transactional system cards", () => {
    for (const kind of ["reminder", "overdue", "activity"] as const) {
      expect(intentTextSurface(intent({ kind }))).toBe("system_card");
    }
  });

  it("keeps simple acknowledgements, care and play as motion-only feedback", () => {
    for (const kind of [
      "success",
      "snoozed",
      "skipped",
      "care",
      "play",
      "idle",
      "focus",
      "break",
      "sleep",
    ] as const) {
      expect(intentTextSurface(intent({ kind, occurrenceId: null }))).toBe("none");
    }
  });

  it("fails closed when a transaction lacks a registered occurrence", () => {
    expect(intentTextSurface(intent({ occurrenceId: null }))).toBe("none");
  });

  it("derives motion accessibility from fixed enums and never from event text", () => {
    expect(
      motionOnlyAccessibleLabel(
        intent({
          kind: "success",
          occurrenceId: null,
          title: "untrusted title",
          message: "untrusted message",
        }),
      ),
    ).toBe("记录完成；圆圆高兴地跳了一下");
    expect(
      motionOnlyAccessibleLabel(
        intent({
          kind: "care",
          animation: "eating-food",
          occurrenceId: null,
        }),
      ),
    ).toBe("圆圆正在吃猫粮");
    expect(
      motionOnlyAccessibleLabel(
        intent({ kind: "play", occurrenceId: null }),
      ),
    ).toBeNull();
  });
});

describe("user-started basic support", () => {
  it("keeps user transactions but suppresses activity and outcome noise", () => {
    expect(basicSupportSuppressesIntent(intent({ kind: "reminder" }))).toBe(false);
    expect(basicSupportSuppressesIntent(intent({ kind: "overdue" }))).toBe(false);
    expect(basicSupportSuppressesIntent(intent({ kind: "activity" }))).toBe(true);
    expect(basicSupportSuppressesIntent(intent({ kind: "success" }))).toBe(true);
    expect(basicSupportSuppressesIntent(intent({ kind: "care" }))).toBe(true);
  });
});
