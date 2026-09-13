import assert from "node:assert/strict";
import test from "node:test";

import { brandPetText } from "./product_brand_contract.mjs";
import { validateLearningInteractionReport } from "./verify_learning_interaction_evidence.mjs";

const APP = "A".repeat(64);
const FIXTURE = "B".repeat(64);
const CONTENT = "C".repeat(64);
const SCRIPT = "D".repeat(64);
const DATABASE = "E".repeat(64);
const LIMITATIONS = [
  "The application and fixture are an isolated learning runtime-QA build, not the signed production candidate.",
  "The content is deterministic synthetic data and contains no personal learning material.",
  "UI timing uses Windows UI Automation at 50 ms polling resolution.",
  "This report does not replace multi-DPI, keyboard, reduced-motion, import, pagination, or two-hour memory evidence.",
];
const bindings = {
  applicationSha256: APP,
  fixtureExecutableSha256: FIXTURE,
  scriptSha256: SCRIPT,
};

function percentile(values, fraction) {
  const ordered = [...values].sort((left, right) => left - right);
  return ordered[Math.max(0, Math.ceil(fraction * ordered.length) - 1)];
}

function makeReport(scenario = "page", count = 20, gate = true) {
  const target = scenario === "page" ? "学习页面" : brandPetText("圆圆桌面英语复习");
  const cardCount = scenario === "page" ? 4533 : 5;
  const samples = Array.from({ length: count }, (_, index) => ({
    sample: index + 1,
    fixtureCardCount: cardCount,
    fixtureDatabaseSha256: DATABASE,
    fixtureDatabaseBytes: 262144 + index,
    pageReadyMilliseconds: 700 + index,
    targetLatencyMilliseconds: (scenario === "page" ? 700 : 300) + index,
    maxVisibleWindows: 4,
    maxAccessibleNodes: 60,
    observedAccessibleNames: [target],
    controlledExit: true,
    exitCode: 0,
    rootRemoved: true,
    passed: true,
    failure: null,
  }));
  const targetValues = samples.map((sample) => sample.targetLatencyMilliseconds);
  const pageValues = samples.map((sample) => sample.pageReadyMilliseconds);
  return {
    schemaVersion: 1,
    generatedAt: "2026-08-14T17:00:00.000Z",
    profile: "learning-interaction",
    scenario,
    targetAccessibleName: target,
    requestedSamples: count,
    passedSamples: count,
    ready: true,
    bindings: {
      applicationSha256: APP,
      fixtureExecutableSha256: FIXTURE,
      fixtureContentSha256: CONTENT,
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
    fixture: { cardCount, contentKind: "deterministic-synthetic-english-csv" },
    baselineGate: {
      requested: gate,
      minimumSamples: 20,
      passed: gate ? true : null,
      failures: [],
    },
    summary: {
      targetLatencyP50Ms: percentile(targetValues, 0.5),
      targetLatencyP95Ms: percentile(targetValues, 0.95),
      pageReadyP50Ms: percentile(pageValues, 0.5),
      pageReadyP95Ms: percentile(pageValues, 0.95),
    },
    samples,
    limitations: LIMITATIONS,
  };
}

test("accepts source-bound page and blackboard evidence", () => {
  assert.deepEqual(validateLearningInteractionReport(makeReport("page"), bindings), []);
  assert.deepEqual(validateLearningInteractionReport(makeReport("blackboard"), bindings), []);
});

test("accepts a clean smoke report without calling it a baseline gate", () => {
  assert.deepEqual(validateLearningInteractionReport(makeReport("page", 1, false), bindings), []);
});

test("rejects altered bindings, device evidence, and fixture identity", () => {
  const report = makeReport();
  report.bindings.scriptSha256 = "F".repeat(64);
  report.device.webView2RuntimeVersion = "";
  report.fixture.cardCount = 5;
  const errors = validateLearningInteractionReport(report, bindings).join("\n");
  assert.match(errors, /stale|device|fixture/);
});

test("rejects optimistic samples and recomputes percentiles", () => {
  const report = makeReport();
  report.samples[0].controlledExit = false;
  report.samples[1].targetLatencyMilliseconds += 5000;
  const errors = validateLearningInteractionReport(report, bindings).join("\n");
  assert.match(errors, /did not pass cleanly|passed sample count|P50|P95|gate/);
});

test("rejects unknown fields and an invalid formal gate", () => {
  const report = makeReport("page", 1, false);
  report.extra = true;
  assert.deepEqual(validateLearningInteractionReport(report, bindings), [
    "report schema is not exact",
  ]);

  const shortGate = makeReport("page", 1, false);
  shortGate.baselineGate.requested = true;
  shortGate.baselineGate.passed = true;
  assert.match(
    validateLearningInteractionReport(shortGate, bindings).join("\n"),
    /baseline gate/,
  );
});
