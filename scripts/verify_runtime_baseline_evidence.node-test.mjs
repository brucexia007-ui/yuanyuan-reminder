import assert from "node:assert/strict";
import test from "node:test";

import {
  parseRuntimeBaselineEvidence,
  validateRuntimeBaselineEvidence,
} from "./verify_runtime_baseline_evidence.mjs";

const BINDINGS = {
  applicationSha256: "A".repeat(64),
  fixtureSha256: "B".repeat(64),
  scriptSha256: "C".repeat(64),
};
const LIMITS = {
  averageNormalizedCpuPercent: 2,
  p95NormalizedCpuPercent: 5,
  workingSetSlopeBytesPerHour: 4194304,
  workingSetSegmentGrowthBytes: 67108864,
  privateMemorySlopeBytesPerHour: 2097152,
  privateMemorySegmentGrowthBytes: 33554432,
  handleSlopePerHour: 2,
  handleSegmentGrowth: 32,
  threadSlopePerHour: 0.5,
  threadSegmentGrowth: 8,
  databaseGrowthBytes: 1048576,
};

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
    buckets[Math.min(5, Math.floor(((sample.elapsedSeconds - first) / span) * 6))].push(sample);
  }
  const segments = buckets.map((bucket, index) => ({
    index: index + 1,
    medianElapsedSeconds: Math.round(median(bucket.map((sample) => sample.elapsedSeconds)) * 1000) / 1000,
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
    segmentGrowth: Math.round((segments.at(-1).medianValue - segments[0].medianValue) * 10000) / 10000,
    segments,
  };
}

function validEvidence() {
  const launch = Date.parse("2026-08-01T00:00:00.000Z");
  const finish = launch + 86_405_000;
  const samples = Array.from({ length: 1201 }, (_, index) => {
    const elapsedSeconds = 300 + index * 60;
    return {
      observedAtUtc: new Date(launch + elapsedSeconds * 1000).toISOString(),
      elapsedSeconds,
      cpuPercent: 0.1 + (index % 10) / 100,
      workingSetBytes: 400_000_000 + index * 50_000,
      privateMemoryBytes: 200_000_000 + index * 20_000,
      handleCount: 400 + Math.floor(index / 100),
      threadCount: 80 + Math.floor(index / 400),
      processCount: 7,
    };
  });
  const values = (key) => samples.map((sample) => sample[key]);
  const average = (items) => items.reduce((sum, value) => sum + value, 0) / items.length;
  const p95 = (items) => [...items].sort((a, b) => a - b)[Math.floor((items.length - 1) * 0.95)];
  const transitions = [
    { observedAtUtc: new Date(launch + 5 * 3600_000).toISOString(), kind: "power", reason: "suspend" },
    { observedAtUtc: new Date(launch + 6 * 3600_000).toISOString(), kind: "power", reason: "resume" },
    { observedAtUtc: new Date(launch + 10 * 3600_000).toISOString(), kind: "session", reason: "lock" },
    { observedAtUtc: new Date(launch + 11 * 3600_000).toISOString(), kind: "session", reason: "unlock" },
  ];
  return {
    schemaVersion: 2,
    generatedAt: new Date(finish).toISOString(),
    profile: "ai-off-isolated-runtime-qa",
    bindings: { ...BINDINGS },
    request: {
      durationSeconds: 86400,
      sampleIntervalSeconds: 60,
      warmupSeconds: 300,
      acceptanceGateRequested: true,
    },
    clock: {
      launchUtc: new Date(launch).toISOString(),
      finishUtc: new Date(finish).toISOString(),
      wallClockObservedSeconds: 86405,
      monotonicObservedSeconds: 86405,
      wallClockMinusMonotonicSeconds: 0,
      activeSampleCoverageSeconds: 72000,
      maxSampleGapSeconds: 60,
    },
    startupToVisibleWindowMilliseconds: 250,
    process: {
      controlledExit: true,
      exitCode: 0,
      sampleCount: samples.length,
      logicalProcessors: 8,
      averageNormalizedCpuPercent: Math.round(average(values("cpuPercent")) * 10000) / 10000,
      p95NormalizedCpuPercent: p95(values("cpuPercent")),
      peakWorkingSetBytes: Math.max(...values("workingSetBytes")),
      averageWorkingSetBytes: Math.round(average(values("workingSetBytes"))),
      p95WorkingSetBytes: p95(values("workingSetBytes")),
      firstWorkingSetBytes: values("workingSetBytes")[0],
      lastWorkingSetBytes: values("workingSetBytes").at(-1),
      workingSetGrowthBytes: values("workingSetBytes").at(-1) - values("workingSetBytes")[0],
      peakPrivateMemoryBytes: Math.max(...values("privateMemoryBytes")),
      averagePrivateMemoryBytes: Math.round(average(values("privateMemoryBytes"))),
      p95PrivateMemoryBytes: p95(values("privateMemoryBytes")),
      firstPrivateMemoryBytes: values("privateMemoryBytes")[0],
      lastPrivateMemoryBytes: values("privateMemoryBytes").at(-1),
      privateMemoryGrowthBytes:
        values("privateMemoryBytes").at(-1) - values("privateMemoryBytes")[0],
      peakHandleCount: Math.max(...values("handleCount")),
      firstHandleCount: values("handleCount")[0],
      lastHandleCount: values("handleCount").at(-1),
      handleGrowth: values("handleCount").at(-1) - values("handleCount")[0],
      peakThreadCount: Math.max(...values("threadCount")),
      firstThreadCount: values("threadCount")[0],
      lastThreadCount: values("threadCount").at(-1),
      threadGrowth: values("threadCount").at(-1) - values("threadCount")[0],
      peakProcessCount: 7,
    },
    storage: {
      start: { fileCount: 3, bytes: 1_000_000 },
      end: { fileCount: 3, bytes: 1_004_096 },
      growthBytes: 4096,
      formalUserFilesWritten: 0,
      qaRootRemoved: true,
    },
    isolation: {
      aiChildQueryAvailable: true,
      aiChildProcessCount: 0,
      applicationErrorQueryAvailable: true,
      applicationErrorCount: 0,
    },
    transitions: {
      powerSuspendResumeObserved: true,
      sessionLockUnlockObserved: true,
      events: transitions,
    },
    trends: {
      workingSetBytes: trend(samples, "workingSetBytes"),
      privateMemoryBytes: trend(samples, "privateMemoryBytes"),
      handleCount: trend(samples, "handleCount"),
      threadCount: trend(samples, "threadCount"),
    },
    acceptanceGate: {
      requested: true,
      minimumDurationSeconds: 86400,
      minimumActiveCoverageSeconds: 72000,
      maximumSampleIntervalSeconds: 60,
      limits: { ...LIMITS },
      passed: true,
      failures: [],
    },
    smokePassed: true,
    ready: true,
    limitations: [
      "The application and fixture are an isolated runtime-QA build, not the signed production candidate.",
      "Segmented trends are release evidence only when the 24-hour acceptance gate is requested.",
      "Sleep-resume and lock-unlock pass only after matching Windows system events are observed during this run.",
      "This does not replace clean-machine, security-software, multi-DPI, or signed-candidate evidence.",
    ],
    samples,
  };
}

test("accepts a source-bound 24-hour run with real transition pairs", () => {
  assert.equal(
    validateRuntimeBaselineEvidence(validEvidence(), BINDINGS, { requireAcceptance: true }),
    true,
  );
});

test("parses UTF-8 evidence with or without a Windows BOM", () => {
  const evidence = validEvidence();
  const json = JSON.stringify(evidence);
  assert.deepEqual(parseRuntimeBaselineEvidence(Buffer.from(json)), evidence);
  assert.deepEqual(
    parseRuntimeBaselineEvidence(
      Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(json)]),
    ),
    evidence,
  );
});

test("rejects stale bindings, altered samples, trends, and unknown fields", () => {
  assert.equal(
    validateRuntimeBaselineEvidence(validEvidence(), {
      ...BINDINGS,
      scriptSha256: "D".repeat(64),
    }),
    false,
  );

  const alteredSample = validEvidence();
  alteredSample.samples[600].privateMemoryBytes += 10_000_000;
  assert.equal(validateRuntimeBaselineEvidence(alteredSample, BINDINGS), false);

  const alteredTrend = validEvidence();
  alteredTrend.trends.handleCount.slopePerHour = 0;
  assert.equal(validateRuntimeBaselineEvidence(alteredTrend, BINDINGS), false);

  const unknown = { ...validEvidence(), machineName: "must-not-exist" };
  assert.equal(validateRuntimeBaselineEvidence(unknown, BINDINGS), false);
});

test("rejects missing system transitions and optimistic acceptance", () => {
  const missingResume = validEvidence();
  missingResume.transitions.events = missingResume.transitions.events.filter(
    (event) => event.reason !== "resume",
  );
  assert.equal(validateRuntimeBaselineEvidence(missingResume, BINDINGS), false);

  const optimistic = validEvidence();
  optimistic.clock.activeSampleCoverageSeconds = 71999;
  assert.equal(
    validateRuntimeBaselineEvidence(optimistic, BINDINGS, { requireAcceptance: true }),
    false,
  );
});

test("allows a structurally valid smoke report but never treats it as acceptance", () => {
  const smoke = validEvidence();
  smoke.request.acceptanceGateRequested = false;
  smoke.acceptanceGate.requested = false;
  smoke.acceptanceGate.passed = null;
  smoke.acceptanceGate.failures = [];
  assert.equal(validateRuntimeBaselineEvidence(smoke, BINDINGS), true);
  assert.equal(
    validateRuntimeBaselineEvidence(smoke, BINDINGS, { requireAcceptance: true }),
    false,
  );
});
