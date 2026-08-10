import assert from "node:assert/strict";
import test from "node:test";

import {
  parseReminderLatencyEvidence,
  validateReminderLatencyEvidence,
} from "./verify_reminder_latency_evidence.mjs";

const BINDINGS = {
  applicationSha256: "A".repeat(64),
  fixtureSha256: "B".repeat(64),
  scriptSha256: "C".repeat(64),
};
const PHASES = [2, 5, 8, 11, 14];

function nearestRank(values, percentile) {
  const ordered = [...values].sort((left, right) => left - right);
  return Math.round(ordered[Math.ceil(percentile * ordered.length) - 1] * 10) / 10;
}

function validEvidence() {
  const backendByPhase = new Map([
    [2, 12900],
    [5, 9900],
    [8, 6900],
    [11, 3900],
    [14, 900],
  ]);
  const samples = Array.from({ length: 20 }, (_, index) => {
    const phase = PHASES[index % PHASES.length];
    const backendLatencyMs = backendByPhase.get(phase) + Math.floor(index / 5) * 10;
    const handoffLatencyMs = 250 + (index % 4) * 5;
    const presentationLatencyMs = backendLatencyMs + handoffLatencyMs;
    const scheduledAt = Date.UTC(2026, 7, 8, 0, index, 0);
    const token = index.toString(16).padStart(8, "0");
    return {
      sample: index + 1,
      dueAfterSeconds: phase,
      reminderId: `${token}-0000-4000-8000-${index.toString(16).padStart(12, "0")}`,
      scheduledAt: new Date(scheduledAt).toISOString(),
      claimedAt: new Date(scheduledAt + backendLatencyMs).toISOString(),
      presentedAt: new Date(scheduledAt + presentationLatencyMs).toISOString(),
      backendLatencyMs,
      presentationLatencyMs,
      handoffLatencyMs,
      maxVisibleWindows: 3,
      maxAccessibleNodes: 30,
      observedAccessibleNames: [`事项提醒：运行验收事项-${token}，打开今日任务`],
      backendClaimObservedOnFailure: false,
      controlledExit: true,
      exitCode: 0,
      rootRemoved: true,
      passed: true,
      failure: null,
    };
  });
  const backend = samples.map((sample) => sample.backendLatencyMs);
  const presentation = samples.map((sample) => sample.presentationLatencyMs);
  const handoff = samples.map((sample) => sample.handoffLatencyMs);
  return {
    schemaVersion: 2,
    generatedAt: "2026-08-08T00:30:00.000Z",
    profile: "reminder-latency",
    schedulerIntervalSeconds: 15,
    requestedSamples: 20,
    passedSamples: 20,
    ready: true,
    bindings: { ...BINDINGS },
    baselineGate: {
      requested: true,
      minimumSamples: 20,
      phaseOffsetsSeconds: [...PHASES],
      limits: {
        backendLatencyP95Ms: 16000,
        handoffLatencyP95Ms: 1000,
        presentationLatencyP95Ms: 17000,
      },
      passed: true,
      failures: [],
    },
    summary: {
      backendLatencyP50Ms: nearestRank(backend, 0.5),
      backendLatencyP95Ms: nearestRank(backend, 0.95),
      presentationLatencyP50Ms: nearestRank(presentation, 0.5),
      presentationLatencyP95Ms: nearestRank(presentation, 0.95),
      handoffLatencyP50Ms: nearestRank(handoff, 0.5),
      handoffLatencyP95Ms: nearestRank(handoff, 0.95),
    },
    samples,
    limitations: [
      "Synthetic reminders and an isolated runtime-QA build are used.",
      "Presentation time is the first matching node observed through Windows UI Automation at 50 ms polling.",
      "This does not replace sleep-resume, lock-screen, cold-boot, or signed production-candidate evidence.",
    ],
  };
}

test("accepts a source-bound 20-sample five-phase baseline", () => {
  assert.equal(validateReminderLatencyEvidence(validEvidence(), BINDINGS), true);

  const reordered = validEvidence();
  reordered.bindings = {
    scriptSha256: BINDINGS.scriptSha256,
    applicationSha256: BINDINGS.applicationSha256,
    fixtureSha256: BINDINGS.fixtureSha256,
  };
  reordered.baselineGate.limits = {
    presentationLatencyP95Ms: 17000,
    backendLatencyP95Ms: 16000,
    handoffLatencyP95Ms: 1000,
  };
  assert.equal(validateReminderLatencyEvidence(reordered, BINDINGS), true);
});

test("parses UTF-8 evidence with or without a Windows BOM", () => {
  const json = JSON.stringify(validEvidence());
  assert.deepEqual(parseReminderLatencyEvidence(Buffer.from(json, "utf8")), validEvidence());
  assert.deepEqual(
    parseReminderLatencyEvidence(Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(json)])),
    validEvidence(),
  );
});

test("rejects missing samples, phase drift, and optimistic readiness", () => {
  const missing = validEvidence();
  missing.samples.pop();
  missing.requestedSamples = 19;
  missing.passedSamples = 19;
  assert.equal(validateReminderLatencyEvidence(missing, BINDINGS), false);

  const phaseDrift = validEvidence();
  phaseDrift.samples[7].dueAfterSeconds = 9;
  assert.equal(validateReminderLatencyEvidence(phaseDrift, BINDINGS), false);

  const pending = validEvidence();
  pending.baselineGate.passed = false;
  pending.baselineGate.failures = ["too slow"];
  assert.equal(validateReminderLatencyEvidence(pending, BINDINGS), false);
});

test("recomputes timestamps, latencies, percentiles, and frozen limits", () => {
  for (const mutate of [
    (report) => {
      report.samples[0].presentedAt = report.samples[0].scheduledAt;
    },
    (report) => {
      report.samples[0].backendLatencyMs += 100;
    },
    (report) => {
      report.summary.presentationLatencyP95Ms += 100;
    },
    (report) => {
      report.baselineGate.limits.presentationLatencyP95Ms = 99999;
    },
  ]) {
    const report = validEvidence();
    mutate(report);
    assert.equal(validateReminderLatencyEvidence(report, BINDINGS), false);
  }
});

test("rejects stale bindings, duplicate alert names, and unknown fields", () => {
  assert.equal(
    validateReminderLatencyEvidence(validEvidence(), { ...BINDINGS, scriptSha256: "D".repeat(64) }),
    false,
  );

  const duplicate = validEvidence();
  duplicate.samples[1].observedAccessibleNames = [...duplicate.samples[0].observedAccessibleNames];
  assert.equal(validateReminderLatencyEvidence(duplicate, BINDINGS), false);

  const unknown = { ...validEvidence(), userDataPath: "must-not-exist" };
  assert.equal(validateReminderLatencyEvidence(unknown, BINDINGS), false);
});
