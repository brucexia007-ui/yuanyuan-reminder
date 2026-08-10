import { describe, expect, it } from "vitest";

import {
  availableSupportPaths,
  EphemeralSupportSession,
  supportReleaseMode,
} from "./supportSession";
import supportSessionSource from "./supportSession.ts?raw";

const unreviewed = {
  professionalReviewPassed: false,
  regionalSafetyResourcesReady: false,
};

const fullyReviewed = {
  professionalReviewPassed: true,
  regionalSafetyResourcesReady: true,
};

describe("support release gate", () => {
  it("keeps the ephemeral module free of browser persistence, network and backend calls", () => {
    for (const forbidden of [
      "localStorage",
      "sessionStorage",
      "indexedDB",
      "fetch(",
      "invoke(",
      "sendBeacon",
      "console.",
    ]) {
      expect(supportSessionSource).not.toContain(forbidden);
    }
  });

  it("exposes only the three local paths before every independent gate passes", () => {
    expect(supportReleaseMode(unreviewed)).toBe("basic_three_paths");
    expect(availableSupportPaths(unreviewed)).toEqual([
      "stay_close",
      "move_together",
      "give_space",
    ]);
    expect(
      availableSupportPaths({
        professionalReviewPassed: true,
        regionalSafetyResourcesReady: false,
      }),
    ).toEqual(availableSupportPaths(unreviewed));
  });

  it("exposes all six paths only after professional and regional gates pass", () => {
    expect(supportReleaseMode(fullyReviewed)).toBe("full_support_box");
    expect(availableSupportPaths(fullyReviewed)).toEqual([
      "stay_close",
      "vent_ephemeral",
      "gentle_reset",
      "move_together",
      "sort_things_out",
      "give_space",
    ]);
  });
});

describe("ephemeral support session", () => {
  it("cannot enter an unreviewed listening or breathing path", () => {
    const session = new EphemeralSupportSession(unreviewed);
    session.offerChoices();
    expect(() => session.choose("vent_ephemeral")).toThrow("unavailable");
    expect(() => session.choose("gentle_reset")).toThrow("unavailable");
    expect(session.state).toEqual({ stage: "choosing" });
  });

  it("holds listening text only while the listening path is active", () => {
    const session = new EphemeralSupportSession(fullyReviewed);
    session.offerChoices();
    session.choose("vent_ephemeral");
    session.replaceVentText("刚才的沟通让我很难受，但我暂时不想整理。");
    expect(session.ventText).toContain("沟通让我很难受");
    session.finishActivePath();
    expect(session.ventText).toBe("");
    expect(session.state).toEqual({
      stage: "optional_check_in",
      path: "vent_ephemeral",
    });
    session.skipOptionalCheckIn();
    expect(session.state).toEqual({ stage: "closed" });
  });

  it("clears sensitive text on every direct exit and a fresh session cannot recover it", () => {
    const first = new EphemeralSupportSession(fullyReviewed);
    first.offerChoices();
    first.choose("vent_ephemeral");
    first.replaceVentText("只存在这次内存会话的内容");
    first.close();
    expect(first.ventText).toBe("");

    const afterRestart = new EphemeralSupportSession(fullyReviewed);
    expect(afterRestart.ventText).toBe("");
    expect(afterRestart.state).toEqual({ stage: "approach" });
  });

  it("bounds in-memory text and rejects bidi controls used for visual spoofing", () => {
    const session = new EphemeralSupportSession(fullyReviewed);
    session.offerChoices();
    session.choose("vent_ephemeral");
    expect(() => session.replaceVentText("x".repeat(16 * 1024 + 1))).toThrow("invalid");
    expect(() => session.replaceVentText("伪装内容\u202eexe.txt")).toThrow("invalid");
    expect(session.ventText).toBe("");
  });

  it("allows at most one low-burden check-in and never loops back into support", () => {
    const session = new EphemeralSupportSession(fullyReviewed);
    session.offerChoices();
    session.choose("stay_close");
    session.finishActivePath();
    session.answerOptionalCheckIn();
    expect(session.state).toEqual({ stage: "closed" });
    expect(() => session.answerOptionalCheckIn()).toThrow("unavailable");
  });

  it("give-space closes immediately without a follow-up", () => {
    const session = new EphemeralSupportSession(unreviewed);
    session.offerChoices();
    session.choose("give_space");
    session.finishActivePath();
    expect(session.state).toEqual({ stage: "closed" });
  });
});
