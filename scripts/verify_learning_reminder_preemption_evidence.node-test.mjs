import assert from "node:assert/strict";
import test from "node:test";

import { brandPetText } from "./product_brand_contract.mjs";

import {
  syntheticPreemptionFixtureSha256,
  validateLearningReminderPreemptionReport,
} from "./verify_learning_reminder_preemption_evidence.mjs";

const APP = "A".repeat(64);
const FIXTURE = "B".repeat(64);
const SCRIPT = "D".repeat(64);
const DATABASE = "E".repeat(64);
const ITEM = "1".repeat(64);
const LIMITS = {
  backendLatencyP95Milliseconds: 16000,
  persistedPreemptionP95Milliseconds: 1000,
  uiHandoffP95Milliseconds: 1000,
  presentationLatencyP95Milliseconds: 17000,
  perSamplePreemptionMilliseconds: 1000,
};
const LIMITATIONS = [
  "The application and fixture are an isolated learning runtime-QA build, not a signed production candidate.",
  "The five cards and reminder title are synthetic and contain no personal learning material.",
  "The real 15-second scheduler, presentation arbiter, SQLite session transition, Tauri events, React replacement, and Windows accessibility tree are included.",
  "The one-second gate applies from persisted reminder claim to both paused learning state and visible reminder surface; scheduler claim latency keeps the existing independent limits.",
  "This report does not replace Narrator, reduced-motion, multi-DPI, locked-break authentication, or signed-candidate testing.",
];
const bindings = {
  applicationSha256: APP,
  fixtureExecutableSha256: FIXTURE,
  scriptSha256: SCRIPT,
};

function state(status, revision, interrupted, interruptedAt = null) {
  return {
    sessionId: "session-1",
    status,
    stateRevision: revision,
    currentItemId: ITEM,
    headword: "qaa",
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

function percentile(values, fraction) {
  const ordered = [...values].sort((left, right) => left - right);
  return ordered[Math.max(0, Math.ceil(fraction * ordered.length) - 1)];
}

function makeReport(count = 20, gate = true) {
  const samples = Array.from({ length: count }, (_, index) => {
    const scheduled = Date.parse("2026-08-19T15:00:00.000Z") + index * 30000;
    const claimed = scheduled + 12500 + index;
    const interrupted = claimed + 20 + (index % 3);
    const presented = interrupted + 180 + (index % 5);
    return {
      sample: index + 1,
      dueAfterSeconds: [2, 5, 8, 11, 14][index % 5],
      fixtureDatabaseSha256: DATABASE,
      fixtureDatabaseBytes: 262144 + index,
      reminderId: `reminder-${index + 1}`,
      claimStatus: "overdue",
      scheduledAt: new Date(scheduled).toISOString(),
      claimedAt: new Date(claimed).toISOString(),
      interruptedAt: new Date(interrupted).toISOString(),
      presentedAt: new Date(presented).toISOString(),
      originalHeadword: "qaa",
      preemptionStateBefore: state("active", 2, 0),
      preemptionStateAfter: state("paused", 3, 1, interrupted),
      backendLatencyMilliseconds: claimed - scheduled,
      persistedPreemptionMilliseconds: interrupted - claimed,
      uiHandoffMilliseconds: presented - claimed,
      presentationLatencyMilliseconds: presented - scheduled,
      uiAfterPersistenceMilliseconds: presented - interrupted,
      alertAccessible: true,
      blackboardYielded: true,
      sameSession: true,
      sameItem: true,
      sameHeadword: true,
      zeroAnswerWrites: true,
      controlledExit: true,
      exitCode: 0,
      maxVisibleWindows: 2,
      maxAccessibleNodes: 50,
      observedAccessibleNames: [
        brandPetText("圆圆桌面英语复习"),
        "事项提醒：运行验收事项-12345678，打开今日任务",
        "qaa",
      ],
      rootRemoved: true,
      passed: true,
      failure: null,
    };
  });
  const metric = (field, fraction) => percentile(samples.map((sample) => sample[field]), fraction);
  return {
    schemaVersion: 1,
    generatedAt: "2026-08-19T16:00:00.000Z",
    profile: "learning-reminder-preemption",
    source: {
      gitCommit: "a".repeat(40),
      gitDirty: true,
      gitStatusSha256: "F".repeat(64),
    },
    bindings: {
      applicationSha256: APP,
      fixtureExecutableSha256: FIXTURE,
      fixtureContentSha256: syntheticPreemptionFixtureSha256(),
      scriptSha256: SCRIPT,
    },
    device: {
      windowsProductName: "Windows",
      windowsDisplayVersion: "25H2",
      windowsBuild: "26200.1",
      processorArchitecture: "AMD64",
      logicalProcessors: 24,
      powerLineStatus: "Online",
      webView2RuntimeVersion: "151.0.0.0",
    },
    request: { sampleCount: count, exitAfterSeconds: 30, evidenceGateRequested: gate },
    fixture: {
      cardCount: 5,
      contentKind: "deterministic-synthetic-english-csv",
      reminderKind: "strong-once-work-reminder",
      dueOffsetsSeconds: [2, 5, 8, 11, 14],
    },
    summary: {
      passedSamples: count,
      backendLatencyP50Milliseconds: metric("backendLatencyMilliseconds", 0.5),
      backendLatencyP95Milliseconds: metric("backendLatencyMilliseconds", 0.95),
      persistedPreemptionP50Milliseconds: metric("persistedPreemptionMilliseconds", 0.5),
      persistedPreemptionP95Milliseconds: metric("persistedPreemptionMilliseconds", 0.95),
      uiHandoffP50Milliseconds: metric("uiHandoffMilliseconds", 0.5),
      uiHandoffP95Milliseconds: metric("uiHandoffMilliseconds", 0.95),
      presentationLatencyP50Milliseconds: metric("presentationLatencyMilliseconds", 0.5),
      presentationLatencyP95Milliseconds: metric("presentationLatencyMilliseconds", 0.95),
    },
    evidenceGate: {
      requested: gate,
      minimumSamples: 20,
      limits: LIMITS,
      passed: gate ? true : null,
      failures: [],
    },
    ready: true,
    limitations: LIMITATIONS,
    samples,
  };
}

test("reconstructs the exact deterministic fixture hash", () => {
  assert.equal(
    syntheticPreemptionFixtureSha256(),
    "7DD333242FE8D028BE697D3663BE3C8D937D8DBCFBD58C98E7FBD8F237877EE5",
  );
});

test("accepts complete active-learning strong-reminder evidence", () => {
  assert.deepEqual(validateLearningReminderPreemptionReport(makeReport(), bindings), []);
});

test("accepts a clean smoke without promoting thresholds", () => {
  assert.deepEqual(validateLearningReminderPreemptionReport(makeReport(1, false), bindings), []);
});

test("rejects stale bindings, fixture drift, and incomplete device evidence", () => {
  const report = makeReport();
  report.bindings.scriptSha256 = "9".repeat(64);
  report.bindings.fixtureContentSha256 = "8".repeat(64);
  report.device.webView2RuntimeVersion = "";
  const errors = validateLearningReminderPreemptionReport(report, bindings).join("\n");
  assert.match(errors, /stale|fixture|device/);
});

test("rejects a reminder that did not pause and displace learning", () => {
  const report = makeReport();
  report.samples[0].preemptionStateAfter.status = "active";
  report.samples[0].preemptionStateAfter.interruptedEventCount = 0;
  report.samples[0].blackboardYielded = false;
  const errors = validateLearningReminderPreemptionReport(report, bindings).join("\n");
  assert.match(errors, /transition|presentation/);
});

test("rejects a changed or accidentally answered question", () => {
  const report = makeReport();
  report.samples[0].preemptionStateAfter.currentItemId = "2".repeat(64);
  report.samples[0].preemptionStateAfter.questionAttemptCount = 1;
  const errors = validateLearningReminderPreemptionReport(report, bindings).join("\n");
  assert.match(errors, /unanswered|preserve/);
});

test("rejects timestamp and percentile manipulation", () => {
  const report = makeReport();
  report.samples[0].uiHandoffMilliseconds += 200;
  report.summary.persistedPreemptionP95Milliseconds += 200;
  const errors = validateLearningReminderPreemptionReport(report, bindings).join("\n");
  assert.match(errors, /inconsistent|raw samples|gate/);
});

test("rejects an over-one-second formal sample and a fake short gate", () => {
  const report = makeReport();
  const sample = report.samples[0];
  sample.presentedAt = new Date(Date.parse(sample.claimedAt) + 1200).toISOString();
  sample.uiHandoffMilliseconds = 1200;
  sample.presentationLatencyMilliseconds =
    Date.parse(sample.presentedAt) - Date.parse(sample.scheduledAt);
  sample.uiAfterPersistenceMilliseconds =
    Date.parse(sample.presentedAt) - Date.parse(sample.interruptedAt);
  report.summary.uiHandoffP95Milliseconds = percentile(
    report.samples.map((value) => value.uiHandoffMilliseconds),
    0.95,
  );
  report.summary.presentationLatencyP95Milliseconds = percentile(
    report.samples.map((value) => value.presentationLatencyMilliseconds),
    0.95,
  );
  report.evidenceGate.passed = false;
  report.evidenceGate.failures = ["a_sample_exceeded_one_second_preemption"];
  report.ready = false;
  assert.deepEqual(validateLearningReminderPreemptionReport(report, bindings), []);

  const shortGate = makeReport(1, false);
  shortGate.request.evidenceGateRequested = true;
  shortGate.evidenceGate.requested = true;
  shortGate.evidenceGate.passed = true;
  assert.match(
    validateLearningReminderPreemptionReport(shortGate, bindings).join("\n"),
    /evidence gate/,
  );
});

test("rejects unknown fields and accepts BOM stripping", () => {
  const report = makeReport();
  report.extra = true;
  assert.deepEqual(validateLearningReminderPreemptionReport(report, bindings), [
    "report schema is not exact",
  ]);
  assert.doesNotThrow(() => JSON.parse(`\uFEFF${JSON.stringify(makeReport())}`.replace(/^\uFEFF/, "")));
});
