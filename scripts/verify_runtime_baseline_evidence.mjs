import { createHash } from "node:crypto";
import { lstat, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";

const projectRoot = path.resolve(import.meta.dirname, "..");
const scriptPath = path.join(projectRoot, "scripts", "measure_runtime_baseline.ps1");

const LIMITATIONS = [
  "The application and fixture are an isolated runtime-QA build, not the signed production candidate.",
  "Segmented trends are release evidence only when the 24-hour acceptance gate is requested.",
  "Sleep-resume and lock-unlock pass only after matching Windows system events are observed during this run.",
  "This does not replace clean-machine, security-software, multi-DPI, or signed-candidate evidence.",
];
const ACCEPTANCE = {
  minimumDurationSeconds: 86400,
  minimumActiveCoverageSeconds: 72000,
  maximumSampleIntervalSeconds: 60,
  limits: {
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
  },
};
const METRICS = ["workingSetBytes", "privateMemoryBytes", "handleCount", "threadCount"];

function hasExactKeys(value, expected) {
  return (
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    JSON.stringify(Object.keys(value).sort()) === JSON.stringify([...expected].sort())
  );
}

function closeEnough(actual, expected, tolerance = 0.01) {
  return Number.isFinite(actual) && Math.abs(actual - expected) <= tolerance;
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex").toUpperCase();
}

function median(values) {
  const ordered = [...values].sort((left, right) => left - right);
  const middle = Math.floor(ordered.length / 2);
  return ordered.length % 2 === 1
    ? ordered[middle]
    : (ordered[middle - 1] + ordered[middle]) / 2;
}

function roundToEven(value, digits) {
  if (value < 0) return -roundToEven(-value, digits);
  const factor = 10 ** digits;
  const scaled = value * factor;
  const lower = Math.floor(scaled);
  const fraction = scaled - lower;
  if (Math.abs(fraction - 0.5) <= 1e-8) {
    return (lower % 2 === 0 ? lower : lower + 1) / factor;
  }
  return Math.round(scaled) / factor;
}

export function summarizeRuntimeTrend(samples, metric) {
  if (samples.length < 6) return null;
  const firstElapsed = samples[0].elapsedSeconds;
  const lastElapsed = samples.at(-1).elapsedSeconds;
  const span = lastElapsed - firstElapsed;
  if (!(span > 0)) return null;
  const buckets = Array.from({ length: 6 }, () => []);
  for (const sample of samples) {
    const position = (sample.elapsedSeconds - firstElapsed) / span;
    const index = Math.min(5, Math.floor(position * 6));
    buckets[index].push(sample);
  }
  if (buckets.some((bucket) => bucket.length === 0)) return null;
  const segments = buckets.map((bucket, index) => ({
    index: index + 1,
    medianElapsedSeconds: roundToEven(
      median(bucket.map((sample) => sample.elapsedSeconds)),
      3,
    ),
    medianValue: roundToEven(median(bucket.map((sample) => sample[metric])), 4),
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
  if (!(denominator > 0)) return null;
  return {
    metric,
    segmentCount: 6,
    slopePerHour: roundToEven((numerator / denominator) * 3600, 4),
    firstMedian: segments[0].medianValue,
    lastMedian: segments.at(-1).medianValue,
    segmentGrowth: roundToEven(
      segments.at(-1).medianValue - segments[0].medianValue,
      4,
    ),
    segments,
  };
}

function transitionPair(events, kind, startReason, endReason) {
  let waitingForEnd = false;
  for (const event of events) {
    if (event.kind !== kind) continue;
    if (!waitingForEnd && event.reason === startReason) {
      waitingForEnd = true;
    } else if (waitingForEnd && event.reason === endReason) {
      return true;
    }
  }
  return false;
}

function expectedAcceptanceFailures(report, trends, smokePassed) {
  if (!report.request.acceptanceGateRequested) return [];
  const failures = [];
  if (!smokePassed) failures.push("smoke_boundary_failed");
  if (report.request.durationSeconds < ACCEPTANCE.minimumDurationSeconds) {
    failures.push("requested_duration_below_24_hours");
  }
  if (report.clock.wallClockObservedSeconds < report.request.durationSeconds) {
    failures.push("wall_clock_observation_shorter_than_requested");
  }
  if (report.clock.activeSampleCoverageSeconds < ACCEPTANCE.minimumActiveCoverageSeconds) {
    failures.push("active_sample_coverage_below_20_hours");
  }
  if (report.request.sampleIntervalSeconds > ACCEPTANCE.maximumSampleIntervalSeconds) {
    failures.push("sample_interval_above_60_seconds");
  }
  if (!report.transitions.powerSuspendResumeObserved) {
    failures.push("power_suspend_resume_pair_missing");
  }
  if (!report.transitions.sessionLockUnlockObserved) {
    failures.push("session_lock_unlock_pair_missing");
  }
  if (report.process.averageNormalizedCpuPercent > ACCEPTANCE.limits.averageNormalizedCpuPercent) {
    failures.push("average_cpu_limit_exceeded");
  }
  if (report.process.p95NormalizedCpuPercent > ACCEPTANCE.limits.p95NormalizedCpuPercent) {
    failures.push("p95_cpu_limit_exceeded");
  }
  if (trends.workingSetBytes.slopePerHour > ACCEPTANCE.limits.workingSetSlopeBytesPerHour) {
    failures.push("working_set_slope_limit_exceeded");
  }
  if (trends.workingSetBytes.segmentGrowth > ACCEPTANCE.limits.workingSetSegmentGrowthBytes) {
    failures.push("working_set_segment_growth_limit_exceeded");
  }
  if (trends.privateMemoryBytes.slopePerHour > ACCEPTANCE.limits.privateMemorySlopeBytesPerHour) {
    failures.push("private_memory_slope_limit_exceeded");
  }
  if (trends.privateMemoryBytes.segmentGrowth > ACCEPTANCE.limits.privateMemorySegmentGrowthBytes) {
    failures.push("private_memory_segment_growth_limit_exceeded");
  }
  if (trends.handleCount.slopePerHour > ACCEPTANCE.limits.handleSlopePerHour) {
    failures.push("handle_slope_limit_exceeded");
  }
  if (trends.handleCount.segmentGrowth > ACCEPTANCE.limits.handleSegmentGrowth) {
    failures.push("handle_segment_growth_limit_exceeded");
  }
  if (trends.threadCount.slopePerHour > ACCEPTANCE.limits.threadSlopePerHour) {
    failures.push("thread_slope_limit_exceeded");
  }
  if (trends.threadCount.segmentGrowth > ACCEPTANCE.limits.threadSegmentGrowth) {
    failures.push("thread_segment_growth_limit_exceeded");
  }
  if (report.storage.growthBytes > ACCEPTANCE.limits.databaseGrowthBytes) {
    failures.push("database_growth_limit_exceeded");
  }
  return failures;
}

function validateTrend(actual, expected) {
  if (
    !hasExactKeys(actual, [
      "metric",
      "segmentCount",
      "slopePerHour",
      "firstMedian",
      "lastMedian",
      "segmentGrowth",
      "segments",
    ]) ||
    actual.metric !== expected.metric ||
    actual.segmentCount !== 6 ||
    !Array.isArray(actual.segments) ||
    actual.segments.length !== 6 ||
    !closeEnough(actual.slopePerHour, expected.slopePerHour, 0.1) ||
    !closeEnough(actual.firstMedian, expected.firstMedian, 0.01) ||
    !closeEnough(actual.lastMedian, expected.lastMedian, 0.01) ||
    !closeEnough(actual.segmentGrowth, expected.segmentGrowth, 0.01)
  ) {
    return false;
  }
  return actual.segments.every((segment, index) => {
    const expectedSegment = expected.segments[index];
    return (
      hasExactKeys(segment, ["index", "medianElapsedSeconds", "medianValue", "sampleCount"]) &&
      segment.index === expectedSegment.index &&
      segment.sampleCount === expectedSegment.sampleCount &&
      closeEnough(segment.medianElapsedSeconds, expectedSegment.medianElapsedSeconds, 0.002) &&
      closeEnough(segment.medianValue, expectedSegment.medianValue, 0.01)
    );
  });
}

export function validateRuntimeBaselineEvidence(
  report,
  expectedBindings,
  { requireAcceptance = false } = {},
) {
  if (
    !hasExactKeys(report, [
      "schemaVersion",
      "generatedAt",
      "profile",
      "bindings",
      "request",
      "clock",
      "startupToVisibleWindowMilliseconds",
      "process",
      "storage",
      "isolation",
      "transitions",
      "trends",
      "acceptanceGate",
      "smokePassed",
      "ready",
      "limitations",
      "samples",
    ]) ||
    report.schemaVersion !== 2 ||
    report.profile !== "ai-off-isolated-runtime-qa" ||
    JSON.stringify(report.limitations) !== JSON.stringify(LIMITATIONS) ||
    !hasExactKeys(report.bindings, ["applicationSha256", "fixtureSha256", "scriptSha256"]) ||
    Object.entries(expectedBindings).some(([key, value]) => report.bindings[key] !== value) ||
    !hasExactKeys(report.request, [
      "durationSeconds",
      "sampleIntervalSeconds",
      "warmupSeconds",
      "acceptanceGateRequested",
    ]) ||
    !Number.isSafeInteger(report.request.durationSeconds) ||
    report.request.durationSeconds < 30 ||
    report.request.durationSeconds > 259200 ||
    !Number.isSafeInteger(report.request.sampleIntervalSeconds) ||
    report.request.sampleIntervalSeconds < 1 ||
    report.request.sampleIntervalSeconds > 60 ||
    !Number.isSafeInteger(report.request.warmupSeconds) ||
    report.request.warmupSeconds < 5 ||
    report.request.warmupSeconds > 300 ||
    typeof report.request.acceptanceGateRequested !== "boolean" ||
    !Number.isFinite(report.startupToVisibleWindowMilliseconds) ||
    report.startupToVisibleWindowMilliseconds <= 0
  ) {
    return false;
  }

  if (
    !hasExactKeys(report.clock, [
      "launchUtc",
      "finishUtc",
      "wallClockObservedSeconds",
      "monotonicObservedSeconds",
      "wallClockMinusMonotonicSeconds",
      "activeSampleCoverageSeconds",
      "maxSampleGapSeconds",
    ]) ||
    report.generatedAt !== report.clock.finishUtc
  ) {
    return false;
  }
  const launchUtc = Date.parse(report.clock.launchUtc);
  const finishUtc = Date.parse(report.clock.finishUtc);
  if (
    !Number.isFinite(launchUtc) ||
    !Number.isFinite(finishUtc) ||
    finishUtc <= launchUtc ||
    !closeEnough(report.clock.wallClockObservedSeconds, (finishUtc - launchUtc) / 1000, 0.01) ||
    !(report.clock.monotonicObservedSeconds > 0) ||
    !closeEnough(
      report.clock.wallClockMinusMonotonicSeconds,
      report.clock.wallClockObservedSeconds - report.clock.monotonicObservedSeconds,
      0.01,
    )
  ) {
    return false;
  }

  if (!Array.isArray(report.samples) || report.samples.length < 6) return false;
  let maxGap = 0;
  let activeCoverage = 0;
  let previousElapsed = null;
  let previousObservedAt = null;
  for (const sample of report.samples) {
    if (
      !hasExactKeys(sample, [
        "observedAtUtc",
        "elapsedSeconds",
        "cpuPercent",
        "workingSetBytes",
        "privateMemoryBytes",
        "handleCount",
        "threadCount",
        "processCount",
      ]) ||
      !Number.isFinite(Date.parse(sample.observedAtUtc)) ||
      !Number.isFinite(sample.elapsedSeconds) ||
      sample.elapsedSeconds <= 0 ||
      !Number.isFinite(sample.cpuPercent) ||
      sample.cpuPercent < 0 ||
      !Number.isSafeInteger(sample.workingSetBytes) ||
      sample.workingSetBytes < 0 ||
      !Number.isSafeInteger(sample.privateMemoryBytes) ||
      sample.privateMemoryBytes < 0 ||
      !Number.isSafeInteger(sample.handleCount) ||
      sample.handleCount < 0 ||
      !Number.isSafeInteger(sample.threadCount) ||
      sample.threadCount < 0 ||
      !Number.isSafeInteger(sample.processCount) ||
      sample.processCount < 1
    ) {
      return false;
    }
    const observedAt = Date.parse(sample.observedAtUtc);
    if (
      observedAt < launchUtc ||
      observedAt > finishUtc + 1000 ||
      (previousElapsed !== null && sample.elapsedSeconds <= previousElapsed) ||
      (previousObservedAt !== null && observedAt < previousObservedAt)
    ) {
      return false;
    }
    if (previousElapsed !== null) {
      const gap = sample.elapsedSeconds - previousElapsed;
      maxGap = Math.max(maxGap, gap);
      activeCoverage += Math.min(Math.max(gap, 0), report.request.sampleIntervalSeconds * 2);
    }
    previousElapsed = sample.elapsedSeconds;
    previousObservedAt = observedAt;
  }
  if (
    !closeEnough(report.clock.maxSampleGapSeconds, maxGap, 0.01) ||
    !closeEnough(report.clock.activeSampleCoverageSeconds, activeCoverage, 0.01)
  ) {
    return false;
  }

  if (
    !hasExactKeys(report.process, [
      "controlledExit",
      "exitCode",
      "sampleCount",
      "logicalProcessors",
      "averageNormalizedCpuPercent",
      "p95NormalizedCpuPercent",
      "peakWorkingSetBytes",
      "averageWorkingSetBytes",
      "p95WorkingSetBytes",
      "firstWorkingSetBytes",
      "lastWorkingSetBytes",
      "workingSetGrowthBytes",
      "peakPrivateMemoryBytes",
      "averagePrivateMemoryBytes",
      "p95PrivateMemoryBytes",
      "firstPrivateMemoryBytes",
      "lastPrivateMemoryBytes",
      "privateMemoryGrowthBytes",
      "peakHandleCount",
      "firstHandleCount",
      "lastHandleCount",
      "handleGrowth",
      "peakThreadCount",
      "firstThreadCount",
      "lastThreadCount",
      "threadGrowth",
      "peakProcessCount",
    ]) ||
    typeof report.process.controlledExit !== "boolean" ||
    (!Number.isSafeInteger(report.process.exitCode) && report.process.exitCode !== null) ||
    report.process.sampleCount !== report.samples.length ||
    !Number.isSafeInteger(report.process.logicalProcessors) ||
    report.process.logicalProcessors < 1
  ) {
    return false;
  }

  const values = (key) => report.samples.map((sample) => sample[key]);
  const percentile95 = (items) => [...items].sort((a, b) => a - b)[Math.floor((items.length - 1) * 0.95)];
  const average = (items) => items.reduce((sum, value) => sum + value, 0) / items.length;
  const processExpectations = {
    averageNormalizedCpuPercent: average(values("cpuPercent")),
    p95NormalizedCpuPercent: percentile95(values("cpuPercent")),
    peakWorkingSetBytes: Math.max(...values("workingSetBytes")),
    averageWorkingSetBytes: average(values("workingSetBytes")),
    p95WorkingSetBytes: percentile95(values("workingSetBytes")),
    firstWorkingSetBytes: values("workingSetBytes")[0],
    lastWorkingSetBytes: values("workingSetBytes").at(-1),
    workingSetGrowthBytes: values("workingSetBytes").at(-1) - values("workingSetBytes")[0],
    peakPrivateMemoryBytes: Math.max(...values("privateMemoryBytes")),
    averagePrivateMemoryBytes: average(values("privateMemoryBytes")),
    p95PrivateMemoryBytes: percentile95(values("privateMemoryBytes")),
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
    peakProcessCount: Math.max(...values("processCount")),
  };
  for (const [key, expected] of Object.entries(processExpectations)) {
    const tolerance = key.includes("average") || key.includes("Cpu") ? 1 : 0;
    if (!closeEnough(report.process[key], expected, tolerance)) return false;
  }

  if (
    !hasExactKeys(report.storage, ["start", "end", "growthBytes", "formalUserFilesWritten", "qaRootRemoved"]) ||
    !hasExactKeys(report.storage.start, ["fileCount", "bytes"]) ||
    !hasExactKeys(report.storage.end, ["fileCount", "bytes"]) ||
    !Number.isSafeInteger(report.storage.start.fileCount) ||
    !Number.isSafeInteger(report.storage.start.bytes) ||
    !Number.isSafeInteger(report.storage.end.fileCount) ||
    !Number.isSafeInteger(report.storage.end.bytes) ||
    report.storage.growthBytes !== report.storage.end.bytes - report.storage.start.bytes ||
    !Number.isSafeInteger(report.storage.formalUserFilesWritten) ||
    report.storage.formalUserFilesWritten < 0 ||
    typeof report.storage.qaRootRemoved !== "boolean" ||
    !hasExactKeys(report.isolation, [
      "aiChildQueryAvailable",
      "aiChildProcessCount",
      "applicationErrorQueryAvailable",
      "applicationErrorCount",
    ]) ||
    report.isolation.aiChildQueryAvailable !== true ||
    !Number.isSafeInteger(report.isolation.aiChildProcessCount) ||
    report.isolation.aiChildProcessCount < 0 ||
    typeof report.isolation.applicationErrorQueryAvailable !== "boolean" ||
    !Number.isSafeInteger(report.isolation.applicationErrorCount) ||
    report.isolation.applicationErrorCount < 0
  ) {
    return false;
  }

  if (
    !hasExactKeys(report.transitions, [
      "powerSuspendResumeObserved",
      "sessionLockUnlockObserved",
      "events",
    ]) ||
    !Array.isArray(report.transitions.events)
  ) {
    return false;
  }
  let previousEventAt = null;
  for (const event of report.transitions.events) {
    const observedAt = Date.parse(event.observedAtUtc);
    if (
      !hasExactKeys(event, ["observedAtUtc", "kind", "reason"]) ||
      !Number.isFinite(observedAt) ||
      observedAt < launchUtc ||
      observedAt > finishUtc + 1000 ||
      (previousEventAt !== null && observedAt < previousEventAt) ||
      !(
        (event.kind === "power" && ["suspend", "resume"].includes(event.reason)) ||
        (event.kind === "session" && ["lock", "unlock"].includes(event.reason))
      )
    ) {
      return false;
    }
    previousEventAt = observedAt;
  }
  const powerPair = transitionPair(report.transitions.events, "power", "suspend", "resume");
  const sessionPair = transitionPair(report.transitions.events, "session", "lock", "unlock");
  if (
    report.transitions.powerSuspendResumeObserved !== powerPair ||
    report.transitions.sessionLockUnlockObserved !== sessionPair
  ) {
    return false;
  }

  if (!hasExactKeys(report.trends, METRICS)) return false;
  const recomputedTrends = {};
  for (const metric of METRICS) {
    recomputedTrends[metric] = summarizeRuntimeTrend(report.samples, metric);
    if (!recomputedTrends[metric] || !validateTrend(report.trends[metric], recomputedTrends[metric])) {
      return false;
    }
  }

  if (
    !hasExactKeys(report.acceptanceGate, [
      "requested",
      "minimumDurationSeconds",
      "minimumActiveCoverageSeconds",
      "maximumSampleIntervalSeconds",
      "limits",
      "passed",
      "failures",
    ]) ||
    report.acceptanceGate.requested !== report.request.acceptanceGateRequested ||
    report.acceptanceGate.minimumDurationSeconds !== ACCEPTANCE.minimumDurationSeconds ||
    report.acceptanceGate.minimumActiveCoverageSeconds !== ACCEPTANCE.minimumActiveCoverageSeconds ||
    report.acceptanceGate.maximumSampleIntervalSeconds !== ACCEPTANCE.maximumSampleIntervalSeconds ||
    !hasExactKeys(report.acceptanceGate.limits, Object.keys(ACCEPTANCE.limits)) ||
    Object.entries(ACCEPTANCE.limits).some(
      ([key, value]) => report.acceptanceGate.limits[key] !== value,
    ) ||
    !Array.isArray(report.acceptanceGate.failures)
  ) {
    return false;
  }

  const smokePassed =
    report.process.controlledExit === true &&
    report.process.exitCode === 0 &&
    report.storage.qaRootRemoved === true &&
    report.storage.formalUserFilesWritten === 0 &&
    report.isolation.aiChildQueryAvailable === true &&
    report.isolation.aiChildProcessCount === 0 &&
    report.isolation.applicationErrorQueryAvailable === true &&
    report.isolation.applicationErrorCount === 0;
  const failures = expectedAcceptanceFailures(report, recomputedTrends, smokePassed);
  const acceptancePassed = report.request.acceptanceGateRequested && failures.length === 0;
  const ready = smokePassed && (!report.request.acceptanceGateRequested || acceptancePassed);
  if (
    report.smokePassed !== smokePassed ||
    report.acceptanceGate.passed !==
      (report.request.acceptanceGateRequested ? acceptancePassed : null) ||
    JSON.stringify(report.acceptanceGate.failures) !== JSON.stringify(failures) ||
    report.ready !== ready ||
    (requireAcceptance && (!acceptancePassed || !ready))
  ) {
    return false;
  }
  return true;
}

export function parseRuntimeBaselineEvidence(reportBytes) {
  const text = Buffer.isBuffer(reportBytes)
    ? reportBytes.toString("utf8")
    : Buffer.from(reportBytes).toString("utf8");
  return JSON.parse(text.replace(/^\uFEFF/, ""));
}

export async function main(arguments_ = process.argv.slice(2)) {
  if (arguments_.length < 2 || arguments_[0] !== "--report") {
    throw new Error(
      "usage: node scripts/verify_runtime_baseline_evidence.mjs --report <absolute-json> [--build-variant learning-off|learning-on] [--allow-smoke]",
    );
  }
  const reportPath = arguments_[1];
  let buildVariant = "learning-off";
  let allowSmoke = false;
  for (let index = 2; index < arguments_.length; index += 1) {
    const argument = arguments_[index];
    if (argument === "--allow-smoke") {
      allowSmoke = true;
      continue;
    }
    if (argument === "--build-variant" && index + 1 < arguments_.length) {
      buildVariant = arguments_[index + 1];
      index += 1;
      continue;
    }
    throw new Error("runtime baseline verifier arguments are invalid");
  }
  if (!new Set(["learning-off", "learning-on"]).has(buildVariant)) {
    throw new Error("runtime baseline build variant is invalid");
  }
  const runtimeTargetName = buildVariant === "learning-on"
    ? "runtime-qa-learning"
    : "runtime-qa";
  const runtimeReleaseRoot = path.join(
    projectRoot,
    "src-tauri",
    "target",
    runtimeTargetName,
    "release",
  );
  const evidenceRoot = path.join(runtimeReleaseRoot, "evidence");
  const applicationPath = path.join(runtimeReleaseRoot, "yuanyuan-reminder.exe");
  const fixturePath = path.join(runtimeReleaseRoot, "yuanyuan-runtime-qa-fixture.exe");
  if (!path.isAbsolute(reportPath)) throw new Error("runtime baseline report path must be absolute");
  if (
    path.dirname(path.resolve(reportPath)) !== path.resolve(evidenceRoot) ||
    !/^runtime-baseline-\d{8}T\d{6}Z\.json$/.test(path.basename(reportPath))
  ) {
    throw new Error("runtime baseline report must be in the owned evidence directory");
  }
  const metadata = await lstat(reportPath);
  if (!metadata.isFile() || metadata.isSymbolicLink()) {
    throw new Error("runtime baseline report must be an ordinary file");
  }
  const [reportBytes, applicationBytes, fixtureBytes, scriptBytes] = await Promise.all([
    readFile(reportPath),
    readFile(applicationPath),
    readFile(fixturePath),
    readFile(scriptPath),
  ]);
  let report;
  try {
    report = parseRuntimeBaselineEvidence(reportBytes);
  } catch {
    throw new Error("runtime baseline report is not valid JSON");
  }
  const expectedBindings = {
    applicationSha256: sha256(applicationBytes),
    fixtureSha256: sha256(fixtureBytes),
    scriptSha256: sha256(scriptBytes),
  };
  if (!validateRuntimeBaselineEvidence(report, expectedBindings, { requireAcceptance: !allowSmoke })) {
    throw new Error("runtime baseline report is pending, stale, or inconsistent");
  }
  const evidenceKind = allowSmoke ? "smoke" : "acceptance";
  console.log(
    `Runtime ${evidenceKind} evidence passed: ${report.clock.wallClockObservedSeconds} seconds, ${report.process.sampleCount} samples.`,
  );
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main();
}
