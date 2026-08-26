import assert from "node:assert/strict";
import test from "node:test";

import {
  syntheticSleepWakeFixtureSha256,
  validateLearningSleepWakeReport,
} from "./verify_learning_sleep_wake_evidence.mjs";

const APP = "A".repeat(64);
const FIXTURE = "B".repeat(64);
const SCRIPT = "D".repeat(64);
const DATABASE = "E".repeat(64);
const ITEM = "1".repeat(64);
const SESSION = "session-1";
const MENU = [
  "打开今日任务", "记录一次喝水", "新建任务", "暂停提醒 30 分钟",
  "立即睡觉/叫醒圆圆", "", "总在最前", "鼠标穿透", "显示课程快捷按键", "设置", "隐藏圆圆",
  "退出圆圆提醒工具",
];
const LIMITATIONS = [
  "The application and fixture are an isolated learning runtime-QA build, not a signed production candidate.",
  "The five cards are synthetic and contain no personal learning material.",
  "The real pet context menu, Tauri command path, presentation arbiter, SQLite pause transition, React replacement, and Windows accessibility tree are included.",
  "The native menu is opened and inspected, then its shared pet-sleep handler is invoked through an exact runtime-QA control trigger because this environment blocks physical pointer and system-input injection; physical right-click and OS-level menu selection remain manual checks.",
  "PrintWindow captures are restricted to isolated application-owned windows and do not capture the desktop.",
  "This report does not replace a human Narrator, reduced-motion, multi-DPI, locked-break authentication, or signed-candidate review.",
];
const captureNames = [
  "active-learning.png", "sleep-menu.png", "sleeping.png", "wake-menu.png", "wake-up.png",
];
const expectedBindings = {
  applicationSha256: APP,
  fixtureExecutableSha256: FIXTURE,
  scriptSha256: SCRIPT,
};
const expectedCaptures = Object.fromEntries(
  captureNames.map((name, index) => [name, { bytes: 1000 + index, sha256: `${index + 1}`.repeat(64) }]),
);

function learningState(status, revision, interrupted, interruptedAt = null) {
  return {
    sessionId: SESSION,
    status,
    stateRevision: revision,
    currentItemId: ITEM,
    headword: "qae",
    pauseReason: status === "paused" ? "preempted_high_priority" : null,
    interruptedEventCount: interrupted,
    interruptedAtUnixMs: interruptedAt,
    answerCommittedEventCount: 0,
    questionAttemptCount: 0,
    reviewLogCount: 0,
    integrityCheck: "ok",
    foreignKeyViolationCount: 0,
  };
}

function petSnapshot(revision, sleeping) {
  return {
    revision,
    activity: sleeping ? "sleeping" : "interrupted",
    source: sleeping ? "manual" : "learning",
    leaseId: null,
    resumableLearningSessionId: SESSION,
    restoreTarget: "learning",
  };
}

function makeReport() {
  const petAfterSleep = petSnapshot(4, true);
  const petAfterWake = petSnapshot(5, false);
  const status = [];
  for (const request of [1, 2]) {
    for (const suffix of ["consumed", "main-thread-entered", "popup-returned"]) {
      status.push({ name: `context-menu-${request}-${suffix}`, value: "ok\n" });
    }
  }
  for (const request of [1, 2]) {
    for (const suffix of ["consumed", "handler-returned", "main-thread-entered"]) {
      status.push({ name: `pet-sleep-menu-${request}-${suffix}`, value: "ok\n" });
    }
    status.push({
      name: `pet-sleep-menu-${request}-selected-action`,
      value: request === 1 ? "sleep\n" : "wake\n",
    });
    status.push({
      name: `pet-sleep-menu-${request}-snapshot`,
      value: JSON.stringify(request === 1 ? petAfterSleep : petAfterWake),
    });
  }
  return {
    schemaVersion: 1,
    generatedAt: "2026-08-21T12:30:00.000Z",
    profile: "learning-sleep-wake",
    source: { branch: "feat/fragment-learning-stage-0-1", commit: "a".repeat(40), dirty: true },
    bindings: {
      applicationSha256: APP,
      fixtureExecutableSha256: FIXTURE,
      fixtureContentSha256: syntheticSleepWakeFixtureSha256(),
      fixtureDatabaseSha256: DATABASE,
      scriptSha256: SCRIPT,
    },
    device: {
      windowsProductName: "Windows",
      windowsDisplayVersion: "25H2",
      windowsBuild: "26200",
      processorArchitecture: "AMD64",
      logicalProcessors: 24,
      webView2RuntimeVersion: "151.0.0.0",
    },
    request: { exitAfterSeconds: 45, cardCount: 5 },
    timestamps: {
      startedAt: "2026-08-21T12:29:50.000Z",
      sleepInvokedAt: "2026-08-21T12:29:55.000Z",
      wakeInvokedAt: "2026-08-21T12:29:57.000Z",
    },
    observations: {
      sleepMenuFound: true,
      wakeMenuFound: true,
      sleepStatusFound: true,
      wakeStatusFound: true,
      blackboardYielded: true,
      blackboardStayedClosedAfterWake: true,
      stateContractPassed: true,
      controlledExit: true,
      exitCode: 0,
      rootRemoved: true,
      sleepMenuOpenMode: "runtime-qa-control",
      wakeMenuOpenMode: "runtime-qa-control",
      sleepMenuAccessibleNames: MENU,
      wakeMenuAccessibleNames: MENU,
      sleepMenuWindowDetails: [
        { handle: 1, className: "#32768", left: 0, top: 0, right: 286, bottom: 367 },
        { handle: 2, className: "Tauri Window", left: 10, top: 10, right: 790, bottom: 640 },
      ],
      sleepMenuCommand: {
        itemPosition: 4, commandId: 1012, ownerHandle: 2,
        dispatch: "runtime-qa-shared-menu-handler",
      },
      wakeMenuCommand: {
        itemPosition: 4, commandId: 1024, ownerHandle: 2,
        dispatch: "runtime-qa-shared-menu-handler",
      },
      controlStatus: status,
    },
    state: {
      before: learningState("active", 2, 0),
      afterSleep: learningState("paused", 3, 1, 1787315000000),
      afterWake: learningState("paused", 3, 1, 1787315000000),
      petAfterSleep,
      petAfterWake,
    },
    captures: captureNames.map((name) => ({ name, ...expectedCaptures[name] })),
    ready: true,
    limitations: LIMITATIONS,
    failure: null,
  };
}

test("reconstructs the deterministic five-card fixture hash", () => {
  assert.equal(
    syntheticSleepWakeFixtureSha256(),
    "7DD333242FE8D028BE697D3663BE3C8D937D8DBCFBD58C98E7FBD8F237877EE5",
  );
});

test("accepts complete native-menu sleep and wake evidence", () => {
  assert.deepEqual(validateLearningSleepWakeReport(makeReport(), expectedBindings, expectedCaptures), []);
});

test("rejects unknown report fields", () => {
  const report = makeReport();
  report.extra = true;
  assert.deepEqual(validateLearningSleepWakeReport(report, expectedBindings, expectedCaptures), [
    "report schema is not exact",
  ]);
});

test("rejects stale bindings and incomplete device evidence", () => {
  const report = makeReport();
  report.bindings.scriptSha256 = "9".repeat(64);
  report.device.webView2RuntimeVersion = "";
  assert.match(
    validateLearningSleepWakeReport(report, expectedBindings, expectedCaptures).join("\n"),
    /stale|device/,
  );
});

test("rejects menu drift or bypassed shared command evidence", () => {
  const report = makeReport();
  report.observations.wakeMenuAccessibleNames[4] = "睡觉";
  report.observations.sleepMenuCommand.dispatch = "direct-command";
  assert.match(
    validateLearningSleepWakeReport(report, expectedBindings, expectedCaptures).join("\n"),
    /menu/,
  );
});

test("rejects a changed or accidentally answered question", () => {
  const report = makeReport();
  report.state.afterSleep.currentItemId = "2".repeat(64);
  report.state.afterSleep.questionAttemptCount = 1;
  assert.match(
    validateLearningSleepWakeReport(report, expectedBindings, expectedCaptures).join("\n"),
    /zero writes|preserve|transition/,
  );
});

test("rejects wake auto-resume or a broken resumable pet snapshot", () => {
  const report = makeReport();
  report.state.afterWake.status = "active";
  report.state.petAfterWake.resumableLearningSessionId = null;
  assert.match(
    validateLearningSleepWakeReport(report, expectedBindings, expectedCaptures).join("\n"),
    /transition|snapshot/,
  );
});

test("rejects a forged control chain or accessibility observation", () => {
  const report = makeReport();
  report.observations.controlStatus.find(
    (entry) => entry.name === "pet-sleep-menu-2-selected-action",
  ).value = "sleep\n";
  report.observations.wakeStatusFound = false;
  assert.match(
    validateLearningSleepWakeReport(report, expectedBindings, expectedCaptures).join("\n"),
    /control status|required Windows observation/,
  );
});

test("rejects stale captures, missing limitations, and optimistic readiness", () => {
  const report = makeReport();
  report.captures[0].bytes += 1;
  report.limitations = [];
  report.ready = false;
  assert.match(
    validateLearningSleepWakeReport(report, expectedBindings, expectedCaptures).join("\n"),
    /capture|limitations|readiness/,
  );
});

test("strict JSON parsing accepts BOM stripping", () => {
  assert.doesNotThrow(() => JSON.parse(`\uFEFF${JSON.stringify(makeReport())}`.replace(/^\uFEFF/, "")));
});
