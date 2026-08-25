import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";

const projectRoot = path.resolve(import.meta.dirname, "..");
const runtimeRoot = path.join(
  projectRoot,
  "src-tauri",
  "target",
  "runtime-qa-learning",
  "release",
);
const applicationPath = path.join(runtimeRoot, "yuanyuan-reminder.exe");
const fixturePath = path.join(runtimeRoot, "yuanyuan-runtime-qa-fixture.exe");
const scriptPath = path.join(projectRoot, "scripts", "measure_learning_interaction.ps1");

const LIMITATIONS = [
  "The application and fixture are an isolated learning runtime-QA build, not the signed production candidate.",
  "The content is deterministic synthetic data and contains no personal learning material.",
  "UI timing uses Windows UI Automation at 50 ms polling resolution.",
  "This report does not replace multi-DPI, keyboard, reduced-motion, import, pagination, or two-hour memory evidence.",
];
const SCENARIOS = {
  page: { target: "学习页面", cardCount: 4533 },
  blackboard: { target: "圆圆桌面英语复习", cardCount: 5 },
};
const SHA256 = /^[A-F0-9]{64}$/;

function exactKeys(value, expected) {
  return (
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    JSON.stringify(Object.keys(value).sort()) === JSON.stringify([...expected].sort())
  );
}

function closeEnough(actual, expected) {
  return Number.isFinite(actual) && Math.abs(actual - expected) <= 0.05;
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

export function validateLearningInteractionReport(report, expectedBindings) {
  const errors = [];
  if (
    !exactKeys(report, [
      "schemaVersion",
      "generatedAt",
      "profile",
      "scenario",
      "targetAccessibleName",
      "requestedSamples",
      "passedSamples",
      "ready",
      "bindings",
      "device",
      "fixture",
      "baselineGate",
      "summary",
      "samples",
      "limitations",
    ])
  ) {
    return ["report schema is not exact"];
  }
  const scenario = SCENARIOS[report.scenario];
  if (report.schemaVersion !== 1 || report.profile !== "learning-interaction" || !scenario) {
    errors.push("report identity is invalid");
  }
  if (!Number.isFinite(Date.parse(report.generatedAt))) {
    errors.push("generatedAt is invalid");
  }
  if (scenario && report.targetAccessibleName !== scenario.target) {
    errors.push("target accessible name does not match the scenario");
  }
  if (
    !Number.isInteger(report.requestedSamples) ||
    report.requestedSamples < 1 ||
    report.requestedSamples > 20 ||
    !Number.isInteger(report.passedSamples) ||
    report.passedSamples < 0 ||
    report.passedSamples > report.requestedSamples ||
    typeof report.ready !== "boolean"
  ) {
    errors.push("sample counts or ready state are invalid");
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
    !exactKeys(report.fixture, ["cardCount", "contentKind"]) ||
    report.fixture?.cardCount !== scenario?.cardCount ||
    report.fixture?.contentKind !== "deterministic-synthetic-english-csv"
  ) {
    errors.push("fixture declaration is invalid");
  }
  if (
    !exactKeys(report.baselineGate, ["requested", "minimumSamples", "passed", "failures"]) ||
    typeof report.baselineGate?.requested !== "boolean" ||
    report.baselineGate?.minimumSamples !== 20 ||
    !Array.isArray(report.baselineGate?.failures)
  ) {
    errors.push("baseline gate schema is invalid");
  }
  if (
    !exactKeys(report.summary, [
      "targetLatencyP50Ms",
      "targetLatencyP95Ms",
      "pageReadyP50Ms",
      "pageReadyP95Ms",
    ])
  ) {
    errors.push("summary schema is invalid");
  }
  if (!Array.isArray(report.samples) || report.samples.length !== report.requestedSamples) {
    errors.push("raw sample count does not match the request");
  }

  const passed = [];
  for (const [index, sample] of (report.samples ?? []).entries()) {
    if (
      !exactKeys(sample, [
        "sample",
        "fixtureCardCount",
        "fixtureDatabaseSha256",
        "fixtureDatabaseBytes",
        "pageReadyMilliseconds",
        "targetLatencyMilliseconds",
        "maxVisibleWindows",
        "maxAccessibleNodes",
        "observedAccessibleNames",
        "controlledExit",
        "exitCode",
        "rootRemoved",
        "passed",
        "failure",
      ])
    ) {
      errors.push(`sample ${index + 1} schema is not exact`);
      continue;
    }
    if (
      sample.sample !== index + 1 ||
      sample.fixtureCardCount !== scenario?.cardCount ||
      typeof sample.fixtureDatabaseSha256 !== "string" ||
      !SHA256.test(sample.fixtureDatabaseSha256) ||
      !Number.isInteger(sample.fixtureDatabaseBytes) ||
      sample.fixtureDatabaseBytes <= 0 ||
      !Number.isFinite(sample.pageReadyMilliseconds) ||
      sample.pageReadyMilliseconds <= 0 ||
      !Number.isFinite(sample.targetLatencyMilliseconds) ||
      sample.targetLatencyMilliseconds <= 0 ||
      !Number.isInteger(sample.maxVisibleWindows) ||
      sample.maxVisibleWindows < 1 ||
      !Number.isInteger(sample.maxAccessibleNodes) ||
      sample.maxAccessibleNodes < 1 ||
      !Array.isArray(sample.observedAccessibleNames) ||
      !sample.observedAccessibleNames.some(
        (name) => typeof name === "string" && name.includes(scenario?.target ?? ""),
      )
    ) {
      errors.push(`sample ${index + 1} measurements are invalid`);
    }
    if (
      sample.passed !== true ||
      sample.controlledExit !== true ||
      sample.exitCode !== 0 ||
      sample.rootRemoved !== true ||
      sample.failure !== null
    ) {
      errors.push(`sample ${index + 1} did not pass cleanly`);
    } else {
      passed.push(sample);
    }
  }
  if (report.passedSamples !== passed.length) {
    errors.push("passed sample count is optimistic");
  }
  const target = passed.map((sample) => sample.targetLatencyMilliseconds);
  const page = passed.map((sample) => sample.pageReadyMilliseconds);
  const expectedSummary = {
    targetLatencyP50Ms: percentile(target, 0.5),
    targetLatencyP95Ms: percentile(target, 0.95),
    pageReadyP50Ms: percentile(page, 0.5),
    pageReadyP95Ms: percentile(page, 0.95),
  };
  for (const [key, value] of Object.entries(expectedSummary)) {
    if (!closeEnough(report.summary?.[key], value)) {
      errors.push(`${key} does not match the raw samples`);
    }
  }

  const sampleSetPassed = passed.length === report.requestedSamples;
  if (report.baselineGate?.requested) {
    const expectedGatePassed = report.requestedSamples >= 20 && sampleSetPassed;
    if (
      report.baselineGate.passed !== expectedGatePassed ||
      (expectedGatePassed && report.baselineGate.failures.length !== 0) ||
      (!expectedGatePassed && report.baselineGate.failures.length === 0) ||
      report.ready !== expectedGatePassed
    ) {
      errors.push("baseline gate result is inconsistent");
    }
  } else if (
    report.baselineGate?.passed !== null ||
    report.baselineGate?.failures.length !== 0 ||
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
  const errors = validateLearningInteractionReport(report, {
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
    `Learning interaction evidence passed: ${report.scenario} ${report.passedSamples}/${report.requestedSamples}, P95 ${report.summary.targetLatencyP95Ms} ms.`,
  );
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(import.meta.filename)) {
  await main();
}
