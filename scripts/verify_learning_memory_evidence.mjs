import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";

const projectRoot = path.resolve(import.meta.dirname, "..");
const runtimeRoot = path.join(
  projectRoot,
  "src-tauri",
  "target",
  "runtime-qa-learning-memory",
  "release",
);
const applicationPath = path.join(runtimeRoot, "yuanyuan-reminder.exe");
const fixturePath = path.join(runtimeRoot, "yuanyuan-runtime-qa-fixture.exe");
const scriptPath = path.join(projectRoot, "scripts", "measure_learning_memory.ps1");

const SHA256 = /^[A-F0-9]{64}$/;
const COMMIT = /^[a-f0-9]{40,64}$/;
const MINIMUM_DURATION_SECONDS = 7200;
const MAXIMUM_SAMPLE_INTERVAL_SECONDS = 60;
const FIXTURE_CARD_COUNT = 4533;
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

function exactKeys(value, expected) {
  return (
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    JSON.stringify(Object.keys(value).sort()) === JSON.stringify([...expected].sort())
  );
}

function closeEnough(actual, expected, tolerance = 0.05) {
  const effectiveTolerance = Math.max(tolerance, Math.abs(expected) * 2e-5);
  return Number.isFinite(actual) && Math.abs(actual - expected) <= effectiveTolerance;
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex").toUpperCase();
}

function alphabeticIndex(initial) {
  let index = initial;
  const characters = [];
  while (true) {
    characters.push(String.fromCharCode("a".charCodeAt(0) + (index % 26)));
    index = Math.floor(index / 26);
    if (index === 0) break;
    index -= 1;
  }
  return characters.reverse().join("");
}

export function expectedLearningMemoryFixtureContentSha256() {
  let csv = "headword,meanings_zh\n";
  for (let index = 0; index < FIXTURE_CARD_COUNT; index += 1) {
    csv += `qa${alphabeticIndex(index)},合成释义 ${index + 1}\n`;
  }
  return sha256(Buffer.from(csv, "utf8"));
}

function median(values) {
  const ordered = [...values].sort((left, right) => left - right);
  const middle = Math.floor(ordered.length / 2);
  return ordered.length % 2 === 1
    ? ordered[middle]
    : (ordered[middle - 1] + ordered[middle]) / 2;
}

function segmentedTrend(samples, metric) {
  const first = samples[0].elapsedSeconds;
  const span = samples.at(-1).elapsedSeconds - first;
  if (!(span > 0)) return null;
  const buckets = Array.from({ length: 6 }, () => []);
  for (const sample of samples) {
    const bucket = Math.min(5, Math.floor(((sample.elapsedSeconds - first) / span) * 6));
    buckets[bucket].push(sample);
  }
  if (buckets.some((bucket) => bucket.length === 0)) return null;
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

function percentile95(values) {
  const ordered = [...values].sort((left, right) => left - right);
  return ordered[Math.floor((ordered.length - 1) * 0.95)];
}

function validateTrend(actual, expected, metric, errors) {
  if (
    !exactKeys(actual, [
      "metric",
      "segmentCount",
      "slopePerHour",
      "firstMedian",
      "lastMedian",
      "segmentGrowth",
      "segments",
    ]) ||
    actual.metric !== metric ||
    actual.segmentCount !== 6 ||
    !Array.isArray(actual.segments) ||
    actual.segments.length !== 6 ||
    !expected
  ) {
    errors.push(`${metric} trend schema is invalid`);
    return;
  }
  for (const key of ["slopePerHour", "firstMedian", "lastMedian", "segmentGrowth"]) {
    if (!closeEnough(actual[key], expected[key])) {
      errors.push(`${metric} trend ${key} does not match raw samples`);
    }
  }
  for (let index = 0; index < 6; index += 1) {
    const segment = actual.segments[index];
    const expectedSegment = expected.segments[index];
    if (
      !exactKeys(segment, ["index", "medianElapsedSeconds", "medianValue", "sampleCount"]) ||
      segment.index !== expectedSegment.index ||
      segment.sampleCount !== expectedSegment.sampleCount ||
      !closeEnough(segment.medianElapsedSeconds, expectedSegment.medianElapsedSeconds) ||
      !closeEnough(segment.medianValue, expectedSegment.medianValue)
    ) {
      errors.push(`${metric} trend segment ${index + 1} does not match raw samples`);
    }
  }
}

export function parseLearningMemoryEvidence(raw) {
  return JSON.parse(raw.replace(/^\uFEFF/, ""));
}

export function validateLearningMemoryReport(report, expectedBindings) {
  const errors = [];
  if (
    !exactKeys(report, [
      "schemaVersion",
      "generatedAt",
      "profile",
      "source",
      "bindings",
      "device",
      "request",
      "fixture",
      "operations",
      "clock",
      "process",
      "storage",
      "isolation",
      "trends",
      "evidenceGate",
      "ready",
      "limitations",
      "samples",
    ])
  ) {
    return ["report schema is not exact"];
  }
  if (
    report.schemaVersion !== 1 ||
    report.profile !== "learning-memory" ||
    !Number.isFinite(Date.parse(report.generatedAt)) ||
    typeof report.ready !== "boolean"
  ) {
    errors.push("report identity is invalid");
  }
  if (
    !exactKeys(report.source, ["gitCommit", "gitDirty", "gitStatusSha256"]) ||
    !COMMIT.test(report.source?.gitCommit ?? "") ||
    typeof report.source?.gitDirty !== "boolean" ||
    !SHA256.test(report.source?.gitStatusSha256 ?? "")
  ) {
    errors.push("source state is incomplete");
  }
  if (
    !exactKeys(report.bindings, [
      "applicationSha256",
      "fixtureExecutableSha256",
      "fixtureContentSha256",
      "fixtureDatabaseSha256",
      "scriptSha256",
    ]) ||
    Object.values(report.bindings ?? {}).some((value) => !SHA256.test(value))
  ) {
    errors.push("binding schema is invalid");
  } else {
    if (
      report.bindings.applicationSha256 !== expectedBindings.applicationSha256 ||
      report.bindings.fixtureExecutableSha256 !== expectedBindings.fixtureExecutableSha256 ||
      report.bindings.scriptSha256 !== expectedBindings.scriptSha256
    ) {
      errors.push("report bindings are stale or do not match measured artifacts");
    }
    if (
      report.bindings.fixtureContentSha256 !==
      expectedLearningMemoryFixtureContentSha256()
    ) {
      errors.push("fixture content hash is not the deterministic 4,533-card fixture");
    }
  }
  if (
    !exactKeys(report.device, [
      "windowsProductName",
      "windowsDisplayVersion",
      "windowsBuild",
      "processorArchitecture",
      "logicalProcessors",
      "powerLineStatus",
      "webView2RuntimeVersion",
    ]) ||
    !Number.isInteger(report.device?.logicalProcessors) ||
    report.device.logicalProcessors < 1 ||
    !["Online", "Offline", "Unknown"].includes(report.device?.powerLineStatus) ||
    [
      report.device?.windowsProductName,
      report.device?.windowsBuild,
      report.device?.processorArchitecture,
      report.device?.webView2RuntimeVersion,
    ].some((value) => typeof value !== "string" || value.length === 0)
  ) {
    errors.push("device evidence is incomplete");
  }
  if (
    !exactKeys(report.request, [
      "durationSeconds",
      "sampleIntervalSeconds",
      "warmupSeconds",
      "evidenceGateRequested",
    ]) ||
    !Number.isInteger(report.request?.durationSeconds) ||
    report.request.durationSeconds < 120 ||
    !Number.isInteger(report.request?.sampleIntervalSeconds) ||
    report.request.sampleIntervalSeconds < 1 ||
    report.request.sampleIntervalSeconds > 60 ||
    !Number.isInteger(report.request?.warmupSeconds) ||
    report.request.warmupSeconds < 5 ||
    typeof report.request?.evidenceGateRequested !== "boolean"
  ) {
    errors.push("request is invalid");
  }
  if (
    !exactKeys(report.fixture, [
      "cardCount",
      "contentKind",
      "initialDatabaseBytes",
      "reminderPauseUntilUtc",
    ]) ||
    report.fixture?.cardCount !== FIXTURE_CARD_COUNT ||
    report.fixture?.contentKind !== "deterministic-synthetic-english-csv" ||
    !Number.isInteger(report.fixture?.initialDatabaseBytes) ||
    report.fixture.initialDatabaseBytes <= 0 ||
    !Number.isFinite(Date.parse(report.fixture?.reminderPauseUntilUtc)) ||
    Date.parse(report.fixture.reminderPauseUntilUtc) <= Date.parse(report.clock?.finishUtc)
  ) {
    errors.push("fixture declaration is invalid");
  }
  if (
    !exactKeys(report.operations, [
      "pageReady",
      "pageReadyMilliseconds",
      "roundStarted",
      "blackboardReadyMilliseconds",
      "answerStrategy",
      "answersSubmitted",
      "wrongContinuations",
      "roundCompleted",
      "roundCompletionMilliseconds",
      "steadyState",
      "steadyStateValidatedAtEnd",
    ]) ||
    report.operations?.pageReady !== true ||
    !(report.operations?.pageReadyMilliseconds > 0) ||
    report.operations?.roundStarted !== true ||
    !(report.operations?.blackboardReadyMilliseconds > 0) ||
    report.operations?.answerStrategy !== "first-enabled-choice" ||
    !Number.isInteger(report.operations?.answersSubmitted) ||
    report.operations.answersSubmitted < 3 ||
    report.operations.answersSubmitted > 12 ||
    !Number.isInteger(report.operations?.wrongContinuations) ||
    report.operations.wrongContinuations < 0 ||
    report.operations.wrongContinuations > report.operations.answersSubmitted ||
    report.operations?.roundCompleted !== true ||
    !(report.operations?.roundCompletionMilliseconds > 0) ||
    report.operations?.steadyState !== "completed-blackboard" ||
    typeof report.operations?.steadyStateValidatedAtEnd !== "boolean"
  ) {
    errors.push("fixed learning operations are incomplete");
  }
  if (
    !exactKeys(report.clock, [
      "launchUtc",
      "samplingStartUtc",
      "finishUtc",
      "observedSeconds",
      "maxSampleGapSeconds",
    ]) ||
    [report.clock?.launchUtc, report.clock?.samplingStartUtc, report.clock?.finishUtc].some(
      (value) => !Number.isFinite(Date.parse(value)),
    ) ||
    Date.parse(report.clock.launchUtc) > Date.parse(report.clock.samplingStartUtc) ||
    Date.parse(report.clock.samplingStartUtc) > Date.parse(report.clock.finishUtc) ||
    !(report.clock?.observedSeconds > 0) ||
    !(report.clock?.maxSampleGapSeconds > 0)
  ) {
    errors.push("clock evidence is invalid");
  }
  if (!Array.isArray(report.samples) || report.samples.length < 6) {
    errors.push("raw samples are missing");
    return errors;
  }
  let previousElapsed = -1;
  let calculatedMaxGap = 0;
  for (const [index, sample] of report.samples.entries()) {
    if (
      !exactKeys(sample, [
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
      sample.elapsedSeconds < 0 ||
      sample.elapsedSeconds <= previousElapsed ||
      !Number.isFinite(sample.cpuPercent) ||
      sample.cpuPercent < 0 ||
      !Number.isInteger(sample.workingSetBytes) ||
      sample.workingSetBytes <= 0 ||
      !Number.isInteger(sample.privateMemoryBytes) ||
      sample.privateMemoryBytes <= 0 ||
      !Number.isInteger(sample.handleCount) ||
      sample.handleCount <= 0 ||
      !Number.isInteger(sample.threadCount) ||
      sample.threadCount <= 0 ||
      !Number.isInteger(sample.processCount) ||
      sample.processCount <= 0
    ) {
      errors.push(`sample ${index + 1} is invalid`);
    }
    if (index > 0) calculatedMaxGap = Math.max(calculatedMaxGap, sample.elapsedSeconds - previousElapsed);
    previousElapsed = sample.elapsedSeconds;
  }
  if (!closeEnough(report.clock.maxSampleGapSeconds, calculatedMaxGap)) {
    errors.push("maximum sample gap does not match raw samples");
  }
  if (report.clock.observedSeconds + 0.05 < report.samples.at(-1).elapsedSeconds) {
    errors.push("observed duration is shorter than the final raw sample");
  }

  const values = (key) => report.samples.map((sample) => sample[key]);
  const average = (items) => items.reduce((sum, value) => sum + value, 0) / items.length;
  const expectedProcess = {
    sampleCount: report.samples.length,
    averageNormalizedCpuPercent:
      Math.round(average(values("cpuPercent")) * 10000) / 10000,
    p95NormalizedCpuPercent: percentile95(values("cpuPercent")),
    peakWorkingSetBytes: Math.max(...values("workingSetBytes")),
    p95WorkingSetBytes: percentile95(values("workingSetBytes")),
    firstWorkingSetBytes: values("workingSetBytes")[0],
    lastWorkingSetBytes: values("workingSetBytes").at(-1),
    peakPrivateMemoryBytes: Math.max(...values("privateMemoryBytes")),
    p95PrivateMemoryBytes: percentile95(values("privateMemoryBytes")),
    firstPrivateMemoryBytes: values("privateMemoryBytes")[0],
    lastPrivateMemoryBytes: values("privateMemoryBytes").at(-1),
    peakHandleCount: Math.max(...values("handleCount")),
    firstHandleCount: values("handleCount")[0],
    lastHandleCount: values("handleCount").at(-1),
    peakThreadCount: Math.max(...values("threadCount")),
    firstThreadCount: values("threadCount")[0],
    lastThreadCount: values("threadCount").at(-1),
    peakProcessCount: Math.max(...values("processCount")),
  };
  if (
    !exactKeys(report.process, [
      "controlledExit",
      "exitCode",
      ...Object.keys(expectedProcess),
    ]) ||
    report.process?.controlledExit !== true ||
    report.process?.exitCode !== 0
  ) {
    errors.push("process exit or schema is invalid");
  }
  for (const [key, expected] of Object.entries(expectedProcess)) {
    if (!closeEnough(report.process?.[key], expected)) {
      errors.push(`process ${key} does not match raw samples`);
    }
  }
  if (
    !exactKeys(report.storage, [
      "start",
      "end",
      "growthBytes",
      "formalUserFilesWritten",
      "qaRootRemoved",
    ]) ||
    !exactKeys(report.storage?.start, ["fileCount", "bytes"]) ||
    !exactKeys(report.storage?.end, ["fileCount", "bytes"]) ||
    !Number.isInteger(report.storage?.start?.fileCount) ||
    !Number.isInteger(report.storage?.start?.bytes) ||
    !Number.isInteger(report.storage?.end?.fileCount) ||
    !Number.isInteger(report.storage?.end?.bytes) ||
    report.storage.growthBytes !== report.storage.end.bytes - report.storage.start.bytes ||
    report.storage.formalUserFilesWritten !== 0 ||
    report.storage.qaRootRemoved !== true
  ) {
    errors.push("storage isolation is invalid");
  }
  if (
    !exactKeys(report.isolation, [
      "applicationErrorQueryAvailable",
      "applicationErrorCount",
    ]) ||
    report.isolation?.applicationErrorQueryAvailable !== true ||
    report.isolation?.applicationErrorCount !== 0
  ) {
    errors.push("application error isolation is invalid");
  }
  if (
    !exactKeys(report.trends, [
      "workingSetBytes",
      "privateMemoryBytes",
      "handleCount",
      "threadCount",
    ])
  ) {
    errors.push("trend collection schema is invalid");
  } else {
    for (const metric of ["workingSetBytes", "privateMemoryBytes", "handleCount", "threadCount"]) {
      validateTrend(report.trends[metric], segmentedTrend(report.samples, metric), metric, errors);
    }
  }
  if (
    !exactKeys(report.evidenceGate, [
      "requested",
      "minimumDurationSeconds",
      "maximumSampleIntervalSeconds",
      "investigationLimits",
      "passed",
      "failures",
    ]) ||
    report.evidenceGate?.requested !== report.request?.evidenceGateRequested ||
    report.evidenceGate?.minimumDurationSeconds !== MINIMUM_DURATION_SECONDS ||
    report.evidenceGate?.maximumSampleIntervalSeconds !== MAXIMUM_SAMPLE_INTERVAL_SECONDS ||
    JSON.stringify(report.evidenceGate?.investigationLimits) !== JSON.stringify(LIMITS) ||
    !Array.isArray(report.evidenceGate?.failures)
  ) {
    errors.push("evidence gate schema is invalid");
  } else if (report.evidenceGate.requested) {
    const expectedFailures = [];
    if (report.request.durationSeconds < MINIMUM_DURATION_SECONDS) {
      expectedFailures.push("requested_duration_below_two_hours");
    }
    if (report.clock.observedSeconds < report.request.durationSeconds) {
      expectedFailures.push("observed_duration_shorter_than_requested");
    }
    if (report.request.sampleIntervalSeconds > MAXIMUM_SAMPLE_INTERVAL_SECONDS) {
      expectedFailures.push("sample_interval_above_60_seconds");
    }
    if (report.clock.maxSampleGapSeconds > report.request.sampleIntervalSeconds + 10) {
      expectedFailures.push("sample_gap_exceeded_tolerance");
    }
    if (!report.operations.steadyStateValidatedAtEnd) {
      expectedFailures.push("steady_state_not_completed_blackboard");
    }
    const checks = [
      ["workingSetBytes", "slopePerHour", "workingSetSlopeBytesPerHour", "working_set_slope_limit_exceeded"],
      ["workingSetBytes", "segmentGrowth", "workingSetSegmentGrowthBytes", "working_set_segment_growth_limit_exceeded"],
      ["privateMemoryBytes", "slopePerHour", "privateMemorySlopeBytesPerHour", "private_memory_slope_limit_exceeded"],
      ["privateMemoryBytes", "segmentGrowth", "privateMemorySegmentGrowthBytes", "private_memory_segment_growth_limit_exceeded"],
      ["handleCount", "slopePerHour", "handleSlopePerHour", "handle_slope_limit_exceeded"],
      ["handleCount", "segmentGrowth", "handleSegmentGrowth", "handle_segment_growth_limit_exceeded"],
      ["threadCount", "slopePerHour", "threadSlopePerHour", "thread_slope_limit_exceeded"],
      ["threadCount", "segmentGrowth", "threadSegmentGrowth", "thread_segment_growth_limit_exceeded"],
    ];
    for (const [metric, value, limit, failure] of checks) {
      if (report.trends?.[metric]?.[value] > LIMITS[limit]) expectedFailures.push(failure);
    }
    if (JSON.stringify(report.evidenceGate.failures) !== JSON.stringify(expectedFailures)) {
      errors.push("evidence gate failures do not match raw evidence");
    }
    const expectedPassed = expectedFailures.length === 0;
    if (report.evidenceGate.passed !== expectedPassed || report.ready !== expectedPassed) {
      errors.push("evidence gate outcome is inconsistent");
    }
    if (!expectedPassed) errors.push("evidence gate did not pass");
  } else if (
    report.evidenceGate.passed !== null ||
    report.evidenceGate.failures.length !== 0 ||
    report.ready !== true
  ) {
    errors.push("smoke readiness is inconsistent");
  }
  if (JSON.stringify(report.limitations) !== JSON.stringify(LIMITATIONS)) {
    errors.push("limitations are missing or changed");
  }
  return errors;
}

function argumentValue(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : null;
}

async function main() {
  const reportArgument = argumentValue("--report");
  if (!reportArgument) throw new Error("--report is required");
  const reportPath = path.resolve(reportArgument);
  const [raw, application, fixture, script] = await Promise.all([
    readFile(reportPath, "utf8"),
    readFile(applicationPath),
    readFile(fixturePath),
    readFile(scriptPath),
  ]);
  const report = parseLearningMemoryEvidence(raw);
  const errors = validateLearningMemoryReport(report, {
    applicationSha256: sha256(application),
    fixtureExecutableSha256: sha256(fixture),
    scriptSha256: sha256(script),
  });
  if (errors.length > 0) {
    for (const error of errors) console.error(`- ${error}`);
    process.exitCode = 1;
    return;
  }
  console.log(
    `Learning memory evidence passed: ${report.clock.observedSeconds}s, ` +
      `${report.process.sampleCount} samples, working-set slope ` +
      `${report.trends.workingSetBytes.slopePerHour} bytes/hour.`,
  );
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(import.meta.filename)) {
  await main();
}
