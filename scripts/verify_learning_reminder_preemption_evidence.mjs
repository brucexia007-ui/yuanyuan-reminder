import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";

const projectRoot = path.resolve(import.meta.dirname, "..");
const runtimeRoot = path.join(
  projectRoot,
  "src-tauri",
  "target",
  "runtime-qa-learning-preemption",
  "release",
);
const applicationPath = path.join(runtimeRoot, "yuanyuan-reminder.exe");
const fixturePath = path.join(runtimeRoot, "yuanyuan-runtime-qa-fixture.exe");
const scriptPath = path.join(projectRoot, "scripts", "measure_learning_reminder_preemption.ps1");

const SHA256 = /^[A-F0-9]{64}$/;
const LOWER_SHA256 = /^[a-f0-9]{64}$/;
const COMMIT = /^[a-f0-9]{40}$/;
const HEADWORD = /^qa[a-z]+$/;
const DUE_OFFSETS = [2, 5, 8, 11, 14];
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
const STATE_KEYS = [
  "sessionId",
  "status",
  "stateRevision",
  "currentItemId",
  "headword",
  "pauseReason",
  "interruptedEventCount",
  "interruptedAtUnixMs",
  "answerCommittedEventCount",
  "questionAttemptCount",
  "reviewLogCount",
  "integrityCheck",
  "foreignKeyViolationCount",
];

function exactKeys(value, expected) {
  return (
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    JSON.stringify(Object.keys(value).sort()) === JSON.stringify([...expected].sort())
  );
}

function closeEnough(actual, expected, tolerance = 1) {
  return Number.isFinite(actual) && Math.abs(actual - expected) <= tolerance;
}

function percentile(values, fraction) {
  if (values.length === 0) return null;
  const ordered = [...values].sort((left, right) => left - right);
  const index = Math.max(0, Math.ceil(fraction * ordered.length) - 1);
  return Math.round(ordered[index] * 10) / 10;
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex").toUpperCase();
}

function alphabeticIndex(rawIndex) {
  let index = rawIndex;
  const characters = [];
  for (;;) {
    characters.push(String.fromCharCode("a".charCodeAt(0) + (index % 26)));
    index = Math.floor(index / 26);
    if (index === 0) break;
    index -= 1;
  }
  return characters.reverse().join("");
}

export function syntheticPreemptionFixtureSha256() {
  let csv = "headword,meanings_zh\n";
  for (let index = 0; index < 5; index += 1) {
    csv += `qa${alphabeticIndex(index)},合成释义 ${index + 1}\n`;
  }
  return sha256(Buffer.from(csv, "utf8"));
}

function validateState(state, phase, errors) {
  if (!exactKeys(state, STATE_KEYS)) {
    errors.push(`${phase} state schema is not exact`);
    return;
  }
  if (
    typeof state.sessionId !== "string" ||
    state.sessionId.length < 1 ||
    state.sessionId.length > 64 ||
    !["active", "paused"].includes(state.status) ||
    !Number.isInteger(state.stateRevision) ||
    state.stateRevision < 1 ||
    !LOWER_SHA256.test(state.currentItemId) ||
    !HEADWORD.test(state.headword) ||
    !Number.isInteger(state.interruptedEventCount) ||
    state.interruptedEventCount < 0
  ) {
    errors.push(`${phase} session identity is invalid`);
  }
  for (const field of [
    "answerCommittedEventCount",
    "questionAttemptCount",
    "reviewLogCount",
    "foreignKeyViolationCount",
  ]) {
    if (!Number.isInteger(state[field]) || state[field] < 0) {
      errors.push(`${phase} ${field} is invalid`);
    }
  }
  if (
    state.answerCommittedEventCount !== 0 ||
    state.questionAttemptCount !== 0 ||
    state.reviewLogCount !== 0 ||
    state.integrityCheck !== "ok" ||
    state.foreignKeyViolationCount !== 0
  ) {
    errors.push(`${phase} does not prove an unanswered and healthy database state`);
  }
}

export function validateLearningReminderPreemptionReport(report, expectedBindings) {
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
      "summary",
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
    report.profile !== "learning-reminder-preemption" ||
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
      "scriptSha256",
    ])
  ) {
    errors.push("binding schema is not exact");
  } else {
    for (const value of Object.values(report.bindings)) {
      if (typeof value !== "string" || !SHA256.test(value)) {
        errors.push("a binding is not an uppercase SHA-256 value");
        break;
      }
    }
    if (
      report.bindings.applicationSha256 !== expectedBindings.applicationSha256 ||
      report.bindings.fixtureExecutableSha256 !== expectedBindings.fixtureExecutableSha256 ||
      report.bindings.scriptSha256 !== expectedBindings.scriptSha256
    ) {
      errors.push("report bindings are stale or do not match the measured artifacts");
    }
    if (report.bindings.fixtureContentSha256 !== syntheticPreemptionFixtureSha256()) {
      errors.push("deterministic fixture content hash is invalid");
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
    !exactKeys(report.request, ["sampleCount", "exitAfterSeconds", "evidenceGateRequested"]) ||
    !Number.isInteger(report.request?.sampleCount) ||
    report.request.sampleCount < 1 ||
    report.request.sampleCount > 20 ||
    !Number.isInteger(report.request.exitAfterSeconds) ||
    report.request.exitAfterSeconds < 30 ||
    report.request.exitAfterSeconds > 120 ||
    typeof report.request.evidenceGateRequested !== "boolean"
  ) {
    errors.push("request contract is invalid");
  }
  if (
    !exactKeys(report.fixture, [
      "cardCount",
      "contentKind",
      "reminderKind",
      "dueOffsetsSeconds",
    ]) ||
    report.fixture?.cardCount !== 5 ||
    report.fixture?.contentKind !== "deterministic-synthetic-english-csv" ||
    report.fixture?.reminderKind !== "strong-once-work-reminder" ||
    JSON.stringify(report.fixture?.dueOffsetsSeconds) !== JSON.stringify(DUE_OFFSETS)
  ) {
    errors.push("fixture declaration is invalid");
  }
  const summaryKeys = [
    "passedSamples",
    "backendLatencyP50Milliseconds",
    "backendLatencyP95Milliseconds",
    "persistedPreemptionP50Milliseconds",
    "persistedPreemptionP95Milliseconds",
    "uiHandoffP50Milliseconds",
    "uiHandoffP95Milliseconds",
    "presentationLatencyP50Milliseconds",
    "presentationLatencyP95Milliseconds",
  ];
  if (!exactKeys(report.summary, summaryKeys) || !Number.isInteger(report.summary?.passedSamples)) {
    errors.push("summary schema is invalid");
  }
  if (
    !exactKeys(report.evidenceGate, [
      "requested",
      "minimumSamples",
      "limits",
      "passed",
      "failures",
    ]) ||
    typeof report.evidenceGate?.requested !== "boolean" ||
    report.evidenceGate?.minimumSamples !== 20 ||
    JSON.stringify(report.evidenceGate?.limits) !== JSON.stringify(LIMITS) ||
    !Array.isArray(report.evidenceGate?.failures)
  ) {
    errors.push("evidence gate schema is invalid");
  }
  if (!Array.isArray(report.samples) || report.samples.length !== report.request?.sampleCount) {
    errors.push("raw sample count does not match the request");
  }

  const passed = [];
  for (const [index, sample] of (report.samples ?? []).entries()) {
    if (
      !exactKeys(sample, [
        "sample",
        "dueAfterSeconds",
        "fixtureDatabaseSha256",
        "fixtureDatabaseBytes",
        "reminderId",
        "claimStatus",
        "scheduledAt",
        "claimedAt",
        "interruptedAt",
        "presentedAt",
        "originalHeadword",
        "preemptionStateBefore",
        "preemptionStateAfter",
        "backendLatencyMilliseconds",
        "persistedPreemptionMilliseconds",
        "uiHandoffMilliseconds",
        "presentationLatencyMilliseconds",
        "uiAfterPersistenceMilliseconds",
        "alertAccessible",
        "blackboardYielded",
        "sameSession",
        "sameItem",
        "sameHeadword",
        "zeroAnswerWrites",
        "controlledExit",
        "exitCode",
        "maxVisibleWindows",
        "maxAccessibleNodes",
        "observedAccessibleNames",
        "rootRemoved",
        "passed",
        "failure",
      ])
    ) {
      errors.push(`sample ${index + 1} schema is not exact`);
      continue;
    }
    const expectedDue = DUE_OFFSETS[index % DUE_OFFSETS.length];
    const scheduled = Date.parse(sample.scheduledAt);
    const claimed = Date.parse(sample.claimedAt);
    const interrupted = Date.parse(sample.interruptedAt);
    const presented = Date.parse(sample.presentedAt);
    if (
      sample.sample !== index + 1 ||
      sample.dueAfterSeconds !== expectedDue ||
      !SHA256.test(sample.fixtureDatabaseSha256 ?? "") ||
      !Number.isInteger(sample.fixtureDatabaseBytes) ||
      sample.fixtureDatabaseBytes <= 0 ||
      typeof sample.reminderId !== "string" ||
      sample.reminderId.length < 1 ||
      sample.reminderId.length > 64 ||
      sample.claimStatus !== "overdue" ||
      ![scheduled, claimed, interrupted, presented].every(Number.isFinite) ||
      !HEADWORD.test(sample.originalHeadword ?? "") ||
      !Number.isInteger(sample.maxVisibleWindows) ||
      sample.maxVisibleWindows < 1 ||
      !Number.isInteger(sample.maxAccessibleNodes) ||
      sample.maxAccessibleNodes < 1 ||
      !Array.isArray(sample.observedAccessibleNames)
    ) {
      errors.push(`sample ${index + 1} measurements are invalid`);
    }
    const expectedLatencies = {
      backendLatencyMilliseconds: claimed - scheduled,
      persistedPreemptionMilliseconds: interrupted - claimed,
      uiHandoffMilliseconds: presented - claimed,
      presentationLatencyMilliseconds: presented - scheduled,
      uiAfterPersistenceMilliseconds: presented - interrupted,
    };
    for (const [field, value] of Object.entries(expectedLatencies)) {
      if (value < 0 || !closeEnough(sample[field], value)) {
        errors.push(`sample ${index + 1} ${field} is inconsistent`);
      }
    }
    validateState(sample.preemptionStateBefore, `sample ${index + 1} before`, errors);
    validateState(sample.preemptionStateAfter, `sample ${index + 1} after`, errors);
    const before = sample.preemptionStateBefore ?? {};
    const after = sample.preemptionStateAfter ?? {};
    if (
      before.status !== "active" ||
      before.pauseReason !== null ||
      before.interruptedEventCount !== 0 ||
      before.interruptedAtUnixMs !== null ||
      after.status !== "paused" ||
      after.pauseReason !== "preempted_high_priority" ||
      after.stateRevision !== before.stateRevision + 1 ||
      after.interruptedEventCount !== 1 ||
      after.interruptedAtUnixMs !== interrupted
    ) {
      errors.push(`sample ${index + 1} persisted preemption transition is invalid`);
    }
    if (
      before.sessionId !== after.sessionId ||
      before.currentItemId !== after.currentItemId ||
      before.headword !== after.headword ||
      before.headword !== sample.originalHeadword ||
      sample.sameSession !== true ||
      sample.sameItem !== true ||
      sample.sameHeadword !== true ||
      sample.zeroAnswerWrites !== true
    ) {
      errors.push(`sample ${index + 1} did not preserve the unanswered question`);
    }
    if (
      !sample.observedAccessibleNames.some(
        (name) => typeof name === "string" && name.includes("圆圆桌面英语复习"),
      ) ||
      !sample.observedAccessibleNames.some(
        (name) => typeof name === "string" && name.includes("事项提醒："),
      ) ||
      !sample.observedAccessibleNames.includes(sample.originalHeadword)
    ) {
      errors.push(`sample ${index + 1} accessibility evidence is incomplete`);
    }
    if (
      sample.alertAccessible !== true ||
      sample.blackboardYielded !== true ||
      sample.controlledExit !== true ||
      sample.exitCode !== 0 ||
      sample.rootRemoved !== true ||
      sample.passed !== true ||
      sample.failure !== null
    ) {
      errors.push(`sample ${index + 1} presentation, exit, or cleanup evidence is invalid`);
    } else {
      passed.push(sample);
    }
  }

  const metricMap = {
    backendLatency: "backendLatencyMilliseconds",
    persistedPreemption: "persistedPreemptionMilliseconds",
    uiHandoff: "uiHandoffMilliseconds",
    presentationLatency: "presentationLatencyMilliseconds",
  };
  if (report.summary?.passedSamples !== passed.length) {
    errors.push("passed sample count is optimistic");
  }
  for (const [summaryPrefix, sampleField] of Object.entries(metricMap)) {
    const values = passed.map((sample) => sample[sampleField]);
    for (const [suffix, fraction] of [["P50Milliseconds", 0.5], ["P95Milliseconds", 0.95]]) {
      const key = `${summaryPrefix}${suffix}`;
      if (!closeEnough(report.summary?.[key], percentile(values, fraction), 0.05)) {
        errors.push(`${key} does not match raw samples`);
      }
    }
  }

  const sampleSetPassed = passed.length === report.request?.sampleCount;
  const expectedFailures = [];
  if (report.evidenceGate?.requested) {
    if (report.request.sampleCount < 20) {
      expectedFailures.push("evidence gate requires at least 20 samples");
    }
    if (!sampleSetPassed) {
      expectedFailures.push("not all requested preemption samples passed");
    }
    if (report.summary.backendLatencyP95Milliseconds > LIMITS.backendLatencyP95Milliseconds) {
      expectedFailures.push("backend_latency_p95_exceeded");
    }
    if (
      report.summary.persistedPreemptionP95Milliseconds >
      LIMITS.persistedPreemptionP95Milliseconds
    ) {
      expectedFailures.push("persisted_preemption_p95_exceeded");
    }
    if (report.summary.uiHandoffP95Milliseconds > LIMITS.uiHandoffP95Milliseconds) {
      expectedFailures.push("ui_handoff_p95_exceeded");
    }
    if (
      report.summary.presentationLatencyP95Milliseconds >
      LIMITS.presentationLatencyP95Milliseconds
    ) {
      expectedFailures.push("presentation_latency_p95_exceeded");
    }
    if (
      passed.some(
        (sample) =>
          sample.persistedPreemptionMilliseconds > LIMITS.perSamplePreemptionMilliseconds ||
          sample.uiHandoffMilliseconds > LIMITS.perSamplePreemptionMilliseconds,
      )
    ) {
      expectedFailures.push("a_sample_exceeded_one_second_preemption");
    }
    const expectedGatePassed = expectedFailures.length === 0;
    if (
      report.request.evidenceGateRequested !== true ||
      report.evidenceGate.passed !== expectedGatePassed ||
      JSON.stringify(report.evidenceGate.failures) !== JSON.stringify(expectedFailures) ||
      report.ready !== expectedGatePassed
    ) {
      errors.push("evidence gate result is inconsistent");
    }
  } else if (
    report.request?.evidenceGateRequested !== false ||
    report.evidenceGate?.passed !== null ||
    report.evidenceGate?.failures.length !== 0 ||
    report.ready !== sampleSetPassed
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
  const report = JSON.parse(raw.replace(/^\uFEFF/, ""));
  const errors = validateLearningReminderPreemptionReport(report, {
    applicationSha256: sha256(application),
    fixtureExecutableSha256: sha256(fixture),
    scriptSha256: sha256(script),
  });
  if (errors.length > 0) {
    for (const error of errors) console.error(`- ${error}`);
    process.exitCode = 1;
    return;
  }
  if (!report.ready) {
    console.error("- learning reminder preemption report is valid but did not pass its gate");
    process.exitCode = 1;
    return;
  }
  console.log(
    `Learning reminder preemption evidence passed: ${report.summary.passedSamples}/${report.request.sampleCount}, persisted P95 ${report.summary.persistedPreemptionP95Milliseconds} ms, UI P95 ${report.summary.uiHandoffP95Milliseconds} ms.`,
  );
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(import.meta.filename)) {
  await main();
}
