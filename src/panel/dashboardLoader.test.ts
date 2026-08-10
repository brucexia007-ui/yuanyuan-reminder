import { describe, expect, it } from "vitest";
import { loadDashboard } from "./dashboardLoader";

describe("loadDashboard", () => {
  it("keeps healthy modules available when one module fails", async () => {
    const result = await loadDashboard({
      today: async () => ({ marker: "today" }) as never,
      settings: async () => {
        throw new Error("settings database error");
      },
      focus: async () => ({ marker: "focus" }) as never,
      care: async () => ({ marker: "care" }) as never,
    });

    expect(result.today).toEqual({ ok: true, value: { marker: "today" } });
    expect(result.settings).toEqual({
      ok: false,
      error: "Error: settings database error",
    });
    expect(result.focus.ok).toBe(true);
    expect(result.care.ok).toBe(true);
  });
});
