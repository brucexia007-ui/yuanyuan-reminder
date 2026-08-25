import assert from "node:assert/strict";
import test from "node:test";

import {
  expectedLearningMemoryFixtureContentSha256,
  parseLearningMemoryEvidence,
  validateLearningMemoryReport,
} from "./verify_learning_memory_evidence.mjs";

const APP = "A".repeat(64);
const FIXTURE = "B".repeat(64);
const SCRIPT = "C".repeat(64);
const DATABASE = "D".repeat(64);
const STATUS = "E".repeat(64);
const FIXTURE_CONTENT = "B5135DD0B175370E39A1D2FBDD623249CEE646EF173A008B28D06DCC34BD52E8";
const BINDINGS = {
  applicationSha256: APP,
  fixtureExecutableSha256: FIXTURE,
  scriptSha256: SCRIPT,
};
const LIMITS = {
  workingSetSlopeBytesPerHour: 4194304,
  workingSetSegmentGrowthBytes: 67108864,
  privateMemorySlopeBytesPerHour: 2097152,
  privateMemorySegmentGrowthBytes: 33554432,
  handleSlopePerHour: 2,
  handleSegmentGrowth: 32,
  threadSlopePerHour: 0.5,
  threadSegmentGrowth: 8,
};
const LIMITATIONS = [
  "The application and fixture are an isolated learning runtime-QA build, not a signed production candidate.",
  "The 4,533 cards are deterministic synthetic data and contain no personal learning material.",
  "The fixed operation visits the learning page, completes one round by choosing the first enabled option, then samples the completed blackboard steady state.",
  "The isolated fixture pauses reminder claims beyond the observation window; reminder latency and preemption are measured by separate gates.",
  "The investigation limits reuse the registered stable-runtime trend limits; this two-hour result does not replace the independent 24-hour runtime gate.",
  "This report does not cover generic 20,000-card import, search pagination, multi-DPI, Narrator, reduced motion, or signed-candidate behavior.",
];

test("reconstructs the exact Rust 4,533-card fixture hash", () => {
  assert.equal(expectedLearningMemoryFixtureContentSha256(), FIXTURE_CONTENT);
});

function median(values) {
  const ordered = [...values].sort((left, right) => left - right);
  const middle = Math.floor(ordered.length / 2);
  return ordered.length % 2 === 1
    ? ordered[middle]
    : (ordered[middle - 1] + ordered[middle]) / 2;
}

function trend(samples, metric) {
  const first = samples[0].elapsedSeconds;
  const span = samples.at(-1).elapsedSeconds - first;
  const buckets = Array.from({ length: 6 }, () => []);
  for (const sample of samples) {
    const bucket = Math.min(5, Math.floor(((sample.elapsedSeconds - first) / span) * 6));
    buckets[bucket].push(sample);
  }
  const segments = buckets.map((bucket, index) => ({
    index: index + 1,
    medianElapsedSeconds:
      Math.round(median(bucket.map((sample) => sample.elapsedSeconds)) * 1000) / 1000,
    medianValue: Math.round(median(bucket.map((sample) => sample[metric])) * 10000) / 10000,
    sampleCount: bucket.length,
  }));
  const meanElapsed = segments.reduce((sum, segment) => sum + segment.medianElapsedSeconds, 0) / 6;
  const meanValue = segments.reduce((sum, segment) => sum + segment.medianValue, 0) / 6;
  let numerator = 0;
  let denominator = 0;
  for (const segment of segments) {
    const elapsedDelta = segment.medianElapsedSeconds - meanElapsed;
    numerator += elapsedDelta * (segment.medianValue - meanValue);
    denominator += elapsedDelta ** 2;
  }
  return {
    metric,
    segmentCount: 6,
    slopePerHour: Math.round(((numerator / denominator) * 3600) * 10000) / 10000,
    firstMedian: segments[0].medianValue,
    lastMedian: segments.at(-1).medianValue,
    segmentGrowth:
      Math.round((segments.at(-1).medianValue - segments[0].medianValue) * 10000) / 10000,
    segments,
  };
}

function p95(values) {
  const ordered = [...values].sort((left, right) => left - right);
  return ordered[Math.floor((ordered.length - 1) * 0.95)];
}

function makeReport({ duration = 7200, interval = 60, gate = true } = {}) {
  const samples = Array.from(
    { length: Math.floor(duration / interval) + 1 },
    (_, index) => ({
      observedAtUtc: new Date(Date.parse("2026-08-14T00:01:00.000Z") + index * interval * 1000).toISOString(),
      elapsedSeconds: index * interval,
      cpuPercent: 0.1 + (index % 4) * 0.01,
      workingSetBytes: 400_000_000 + index * 20_000,
      privateMemoryBytes: 200_000_000 + index * 10_000,
      handleCount: 400,
      threadCount: 80,
      processCount: 7,
    }),
  );
  const values = (key) => samples.map((sample) => sample[key]);
  const average = (items) => items.reduce((sum, value) => sum + value, 0) / items.length;
  return {
    schemaVersion: 1,
    generatedAt: "2026-08-14T02:04:30.000Z",
    profile: "learning-memory",
    source: {
      gitCommit: "a".repeat(40),
      gitDirty: true,
      gitStatusSha256: STATUS,
    },
    bindings: {
      applicationSha256: APP,
      fixtureExecutableSha256: FIXTURE,
      fixtureContentSha256: expectedLearningMemoryFixtureContentSha256(),
      fixtureDatabaseSha256: DATABASE,
      scriptSha256: SCRIPT,
    },
    device: {
      windowsProductName: "Windows 11 Pro",
      windowsDisplayVersion: "25H2",
      windowsBuild: "26200.1",
      processorArchitecture: "AMD64",
      logicalProcessors: 24,
      powerLineStatus: "Online",
      webView2RuntimeVersion: "151.0.0.0",
    },
    request: {
      durationSeconds: duration,
      sampleIntervalSeconds: interval,
      warmupSeconds: 30,
      evidenceGateRequested: gate,
    },
    fixture: {
      cardCount: 4533,
      contentKind: "deterministic-synthetic-english-csv",
      initialDatabaseBytes: 4_000_000,
      reminderPauseUntilUtc: "2026-08-14T05:00:00.000Z",
    },
    operations: {
      pageReady: true,
      pageReadyMilliseconds: 800,
      roundStarted: true,
      blackboardReadyMilliseconds: 400,
      answerStrategy: "first-enabled-choice",
      answersSubmitted: 5,
      wrongContinuations: 2,
      roundCompleted: true,
      roundCompletionMilliseconds: 10_500,
      steadyState: "completed-blackboard",
      steadyStateValidatedAtEnd: true,
    },
    clock: {
      launchUtc: "2026-08-14T00:00:00.000Z",
      samplingStartUtc: "2026-08-14T00:01:00.000Z",
      finishUtc: "2026-08-14T02:04:30.000Z",
      observedSeconds: duration,
      maxSampleGapSeconds: interval,
    },
    process: {
      controlledExit: true,
      exitCode: 0,
      sampleCount: samples.length,
      averageNormalizedCpuPercent: Math.round(average(values("cpuPercent")) * 10000) / 10000,
      p95NormalizedCpuPercent: p95(values("cpuPercent")),
      peakWorkingSetBytes: Math.max(...values("workingSetBytes")),
      p95WorkingSetBytes: p95(values("workingSetBytes")),
      firstWorkingSetBytes: values("workingSetBytes")[0],
      lastWorkingSetBytes: values("workingSetBytes").at(-1),
      peakPrivateMemoryBytes: Math.max(...values("privateMemoryBytes")),
      p95PrivateMemoryBytes: p95(values("privateMemoryBytes")),
      firstPrivateMemoryBytes: values("privateMemoryBytes")[0],
      lastPrivateMemoryBytes: values("privateMemoryBytes").at(-1),
      peakHandleCount: Math.max(...values("handleCount")),
      firstHandleCount: values("handleCount")[0],
      lastHandleCount: values("handleCount").at(-1),
      peakThreadCount: Math.max(...values("threadCount")),
      firstThreadCount: values("threadCount")[0],
      lastThreadCount: values("threadCount").at(-1),
      peakProcessCount: Math.max(...values("processCount")),
    },
    storage: {
      start: { fileCount: 3, bytes: 4_000_000 },
      end: { fileCount: 3, bytes: 4_020_000 },
      growthBytes: 20_000,
      formalUserFilesWritten: 0,
      qaRootRemoved: true,
    },
    isolation: {
      applicationErrorQueryAvailable: true,
      applicationErrorCount: 0,
    },
    trends: {
      workingSetBytes: trend(samples, "workingSetBytes"),
      privateMemoryBytes: trend(samples, "privateMemoryBytes"),
      handleCount: trend(samples, "handleCount"),
      threadCount: trend(samples, "threadCount"),
    },
    evidenceGate: {
      requested: gate,
      minimumDurationSeconds: 7200,
      maximumSampleIntervalSeconds: 60,
      investigationLimits: { ...LIMITS },
      passed: gate ? true : null,
      failures: [],
    },
    ready: true,
    limitations: [...LIMITATIONS],
    samples,
  };
}

test("accepts a complete two-hour learning memory report", () => {
  assert.deepEqual(validateLearningMemoryReport(makeReport(), BINDINGS), []);
});

test("accepts a clean short smoke without promoting it to evidence", () => {
  assert.deepEqual(
    validateLearningMemoryReport(makeReport({ duration: 120, interval: 20, gate: false }), BINDINGS),
    [],
  );
});

test("rejects stale artifacts, incomplete source state, and incomplete device data", () => {
  const report = makeReport();
  report.bindings.applicationSha256 = "F".repeat(64);
  report.source.gitCommit = "not-a-commit";
  report.device.webView2RuntimeVersion = "";
  assert.match(
    validateLearningMemoryReport(report, BINDINGS).join("\n"),
    /stale|source|device/,
  );
});

test("rejects a raw sample that no longer agrees with summaries and trends", () => {
  const report = makeReport();
  report.samples[60].workingSetBytes += 100_000_000;
  const errors = validateLearningMemoryReport(report, BINDINGS).join("\n");
  assert.match(errors, /process|trend/);
});

test("rejects a fake short formal gate and an unknown report field", () => {
  const report = makeReport({ duration: 120, interval: 20, gate: false });
  report.request.evidenceGateRequested = true;
  report.evidenceGate.requested = true;
  report.evidenceGate.passed = true;
  assert.match(validateLearningMemoryReport(report, BINDINGS).join("\n"), /gate/);

  const extra = makeReport();
  extra.extra = true;
  assert.deepEqual(validateLearningMemoryReport(extra, BINDINGS), ["report schema is not exact"]);
});

test("rejects a run that left the completed blackboard steady state", () => {
  const report = makeReport();
  report.operations.steadyStateValidatedAtEnd = false;
  report.evidenceGate.passed = false;
  report.evidenceGate.failures = ["steady_state_not_completed_blackboard"];
  report.ready = false;
  const errors = validateLearningMemoryReport(report, BINDINGS).join("\n");
  assert.match(errors, /did not pass/);
  assert.doesNotMatch(errors, /failures do not match/);
});

test("parses PowerShell UTF-8 BOM output", () => {
  assert.equal(parseLearningMemoryEvidence(`\uFEFF${JSON.stringify(makeReport())}`).profile, "learning-memory");
});
