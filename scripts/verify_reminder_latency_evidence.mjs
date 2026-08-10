import { createHash } from "node:crypto";
import { lstat, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";

const projectRoot = path.resolve(import.meta.dirname, "..");
const runtimeReleaseRoot = path.join(
  projectRoot,
  "src-tauri",
  "target",
  "runtime-qa",
  "release",
);
const evidenceRoot = path.join(runtimeReleaseRoot, "evidence");
const applicationPath = path.join(runtimeReleaseRoot, "yuanyuan-reminder.exe");
const fixturePath = path.join(runtimeReleaseRoot, "yuanyuan-runtime-qa-fixture.exe");
const scriptPath = path.join(projectRoot, "scripts", "measure_reminder_latency.ps1");

const EXPECTED_REPORT_KEYS = [
  "baselineGate",
  "bindings",
  "generatedAt",
  "limitations",
  "passedSamples",
  "profile",
  "ready",
  "requestedSamples",
  "samples",
  "schedulerIntervalSeconds",
  "schemaVersion",
  "summary",
];
const EXPECTED_BINDING_KEYS = ["applicationSha256", "fixtureSha256", "scriptSha256"];
const EXPECTED_GATE_KEYS = [
  "failures",
  "limits",
  "minimumSamples",
  "passed",
  "phaseOffsetsSeconds",
  "requested",
];
const EXPECTED_LIMIT_KEYS = [
  "backendLatencyP95Ms",
  "handoffLatencyP95Ms",
  "presentationLatencyP95Ms",
];
const EXPECTED_SUMMARY_KEYS = [
  "backendLatencyP50Ms",
  "backendLatencyP95Ms",
  "handoffLatencyP50Ms",
  "handoffLatencyP95Ms",
  "presentationLatencyP50Ms",
  "presentationLatencyP95Ms",
];
const EXPECTED_SAMPLE_KEYS = [
  "backendClaimObservedOnFailure",
  "backendLatencyMs",
  "claimedAt",
  "controlledExit",
  "dueAfterSeconds",
  "exitCode",
  "failure",
  "handoffLatencyMs",
  "maxAccessibleNodes",
  "maxVisibleWindows",
  "observedAccessibleNames",
  "passed",
  "presentationLatencyMs",
  "presentedAt",
  "reminderId",
  "rootRemoved",
  "sample",
  "scheduledAt",
];
const EXPECTED_PHASES = [2, 5, 8, 11, 14];
const EXPECTED_LIMITS = {
  backendLatencyP95Ms: 16000,
  handoffLatencyP95Ms: 1000,
  presentationLatencyP95Ms: 17000,
};
const EXPECTED_LIMITATIONS = [
  "Synthetic reminders and an isolated runtime-QA build are used.",
  "Presentation time is the first matching node observed through Windows UI Automation at 50 ms polling.",
  "This does not replace sleep-resume, lock-screen, cold-boot, or signed production-candidate evidence.",
];
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const STRONG_ALERT_NAME = /^事项提醒：运行验收事项-[0-9a-f]{8}，打开今日任务$/i;

function hasExactKeys(value, expected) {
  return (
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    JSON.stringify(Object.keys(value).sort()) === JSON.stringify(expected)
  );
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex").toUpperCase();
}

function roundTenth(value) {
  return Math.round((value + Number.EPSILON) * 10) / 10;
}

function nearestRank(values, percentile) {
  const ordered = [...values].sort((left, right) => left - right);
  return roundTenth(ordered[Math.max(0, Math.ceil(percentile * ordered.length) - 1)]);
}

function closeEnough(actual, expected) {
  return Number.isFinite(actual) && Math.abs(actual - expected) <= 1;
}

export function validateReminderLatencyEvidence(report, expectedBindings) {
  if (!hasExactKeys(report, EXPECTED_REPORT_KEYS)) return false;
  if (!hasExactKeys(report.bindings, EXPECTED_BINDING_KEYS)) return false;
  if (!hasExactKeys(report.baselineGate, EXPECTED_GATE_KEYS)) return false;
  if (!hasExactKeys(report.baselineGate.limits, EXPECTED_LIMIT_KEYS)) return false;
  if (!hasExactKeys(report.summary, EXPECTED_SUMMARY_KEYS)) return false;
  if (
    EXPECTED_BINDING_KEYS.some((key) => report.bindings[key] !== expectedBindings[key])
  ) {
    return false;
  }
  if (JSON.stringify(report.limitations) !== JSON.stringify(EXPECTED_LIMITATIONS)) return false;
  if (!Number.isFinite(Date.parse(report.generatedAt))) return false;
  if (
    report.schemaVersion !== 2 ||
    report.profile !== "reminder-latency" ||
    report.schedulerIntervalSeconds !== 15 ||
    report.requestedSamples !== 20 ||
    report.passedSamples !== 20 ||
    report.ready !== true ||
    report.baselineGate.requested !== true ||
    report.baselineGate.minimumSamples !== 20 ||
    JSON.stringify(report.baselineGate.phaseOffsetsSeconds) !== JSON.stringify(EXPECTED_PHASES) ||
    EXPECTED_LIMIT_KEYS.some(
      (key) => report.baselineGate.limits[key] !== EXPECTED_LIMITS[key],
    ) ||
    report.baselineGate.passed !== true ||
    !Array.isArray(report.baselineGate.failures) ||
    report.baselineGate.failures.length !== 0 ||
    !Array.isArray(report.samples) ||
    report.samples.length !== 20
  ) {
    return false;
  }

  const reminderIds = new Set();
  const strongAlertNames = new Set();
  const backend = [];
  const presentation = [];
  const handoff = [];

  for (const [index, sample] of report.samples.entries()) {
    if (!hasExactKeys(sample, EXPECTED_SAMPLE_KEYS)) return false;
    if (
      sample.sample !== index + 1 ||
      sample.dueAfterSeconds !== EXPECTED_PHASES[index % EXPECTED_PHASES.length] ||
      !UUID_V4.test(sample.reminderId) ||
      reminderIds.has(sample.reminderId) ||
      sample.backendClaimObservedOnFailure !== false ||
      sample.controlledExit !== true ||
      sample.exitCode !== 0 ||
      sample.rootRemoved !== true ||
      sample.passed !== true ||
      sample.failure !== null ||
      !Number.isSafeInteger(sample.maxVisibleWindows) ||
      sample.maxVisibleWindows < 1 ||
      sample.maxVisibleWindows > 16 ||
      !Number.isSafeInteger(sample.maxAccessibleNodes) ||
      sample.maxAccessibleNodes < 1 ||
      sample.maxAccessibleNodes > 10000 ||
      !Array.isArray(sample.observedAccessibleNames) ||
      sample.observedAccessibleNames.length < 1 ||
      sample.observedAccessibleNames.length > 64 ||
      sample.observedAccessibleNames.some(
        (name) => typeof name !== "string" || name.length < 1 || name.length > 256,
      )
    ) {
      return false;
    }
    reminderIds.add(sample.reminderId);

    const matchingNames = sample.observedAccessibleNames.filter((name) => STRONG_ALERT_NAME.test(name));
    if (matchingNames.length !== 1 || strongAlertNames.has(matchingNames[0])) return false;
    strongAlertNames.add(matchingNames[0]);

    const scheduledAt = Date.parse(sample.scheduledAt);
    const claimedAt = Date.parse(sample.claimedAt);
    const presentedAt = Date.parse(sample.presentedAt);
    if (
      !Number.isFinite(scheduledAt) ||
      !Number.isFinite(claimedAt) ||
      !Number.isFinite(presentedAt) ||
      scheduledAt > claimedAt ||
      claimedAt > presentedAt ||
      !closeEnough(sample.backendLatencyMs, claimedAt - scheduledAt) ||
      !closeEnough(sample.handoffLatencyMs, presentedAt - claimedAt) ||
      !closeEnough(sample.presentationLatencyMs, presentedAt - scheduledAt)
    ) {
      return false;
    }
    backend.push(sample.backendLatencyMs);
    presentation.push(sample.presentationLatencyMs);
    handoff.push(sample.handoffLatencyMs);
  }

  const recomputed = {
    backendLatencyP50Ms: nearestRank(backend, 0.5),
    backendLatencyP95Ms: nearestRank(backend, 0.95),
    presentationLatencyP50Ms: nearestRank(presentation, 0.5),
    presentationLatencyP95Ms: nearestRank(presentation, 0.95),
    handoffLatencyP50Ms: nearestRank(handoff, 0.5),
    handoffLatencyP95Ms: nearestRank(handoff, 0.95),
  };
  for (const [key, value] of Object.entries(recomputed)) {
    if (!closeEnough(report.summary[key], value)) return false;
  }
  return (
    report.summary.backendLatencyP95Ms <= EXPECTED_LIMITS.backendLatencyP95Ms &&
    report.summary.handoffLatencyP95Ms <= EXPECTED_LIMITS.handoffLatencyP95Ms &&
    report.summary.presentationLatencyP95Ms <= EXPECTED_LIMITS.presentationLatencyP95Ms
  );
}

export function parseReminderLatencyEvidence(reportBytes) {
  const text = Buffer.isBuffer(reportBytes)
    ? reportBytes.toString("utf8")
    : Buffer.from(reportBytes).toString("utf8");
  return JSON.parse(text.replace(/^\uFEFF/, ""));
}

export async function main(arguments_ = process.argv.slice(2)) {
  if (arguments_.length !== 2 || arguments_[0] !== "--report") {
    throw new Error(
      "usage: node scripts/verify_reminder_latency_evidence.mjs --report <absolute-json>",
    );
  }
  const reportPath = arguments_[1];
  if (!path.isAbsolute(reportPath)) throw new Error("reminder latency report path must be absolute");
  if (
    path.dirname(path.resolve(reportPath)) !== path.resolve(evidenceRoot) ||
    !/^reminder-latency-\d{8}T\d{6}Z\.json$/.test(path.basename(reportPath))
  ) {
    throw new Error("reminder latency report must be in the owned evidence directory");
  }
  const metadata = await lstat(reportPath);
  if (!metadata.isFile() || metadata.isSymbolicLink()) {
    throw new Error("reminder latency report must be an ordinary file");
  }
  const [reportBytes, applicationBytes, fixtureBytes, scriptBytes] = await Promise.all([
    readFile(reportPath),
    readFile(applicationPath),
    readFile(fixturePath),
    readFile(scriptPath),
  ]);
  let report;
  try {
    report = parseReminderLatencyEvidence(reportBytes);
  } catch {
    throw new Error("reminder latency report is not valid JSON");
  }
  const expectedBindings = {
    applicationSha256: sha256(applicationBytes),
    fixtureSha256: sha256(fixtureBytes),
    scriptSha256: sha256(scriptBytes),
  };
  if (!validateReminderLatencyEvidence(report, expectedBindings)) {
    throw new Error("reminder latency report is pending, stale, or inconsistent");
  }
  console.log(
    `Reminder latency evidence passed: ${report.passedSamples}/${report.requestedSamples} samples, presentation P95 ${report.summary.presentationLatencyP95Ms} ms.`,
  );
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main();
}
