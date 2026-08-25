import { createHash } from "node:crypto";
import { lstat, readFile } from "node:fs/promises";
import path from "node:path";

const projectRoot = path.resolve(import.meta.dirname, "..");
const scriptPath = path.join(projectRoot, "scripts", "measure_startup_matrix.ps1");
const SHA256 = /^[A-F0-9]{64}$/;
const LIMITATIONS = [
  "The application and fixture are isolated runtime-QA builds, not signed production candidates.",
  "Cold mode uses a new application and WebView data root for every sample.",
  "Warm mode performs one uncounted initialization launch and reuses its isolated data root.",
  "Startup ends at the first visible application-owned top-level window.",
  "The exact QA root process is terminated after the timing target; controlled-exit behavior is covered by separate runtime evidence.",
  "This does not replace clean-machine, signed-candidate, security-software, or multi-DPI evidence.",
];

function exactKeys(value, expected) {
  return (
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    JSON.stringify(Object.keys(value).sort()) === JSON.stringify([...expected].sort())
  );
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex").toUpperCase();
}

function percentile(values, fraction) {
  if (values.length === 0) return null;
  const ordered = [...values].sort((left, right) => left - right);
  return Math.round(ordered[Math.max(0, Math.ceil(fraction * ordered.length) - 1)] * 10) / 10;
}

function closeEnough(actual, expected) {
  return Number.isFinite(actual) && Math.abs(actual - expected) <= 0.05;
}

function validDatabaseSnapshot(snapshot) {
  return (
    exactKeys(snapshot, ["sha256", "fileCount", "bytes"]) &&
    typeof snapshot.sha256 === "string" &&
    SHA256.test(snapshot.sha256) &&
    Number.isInteger(snapshot.fileCount) &&
    snapshot.fileCount >= 0 &&
    Number.isInteger(snapshot.bytes) &&
    snapshot.bytes >= 0 &&
    (snapshot.fileCount > 0 || snapshot.bytes === 0)
  );
}

export function validateStartupMatrixReport(report, expectedBindings) {
  const errors = [];
  if (
    !exactKeys(report, [
      "schemaVersion",
      "generatedAt",
      "profile",
      "buildVariant",
      "startupMode",
      "requestedSamples",
      "passedSamples",
      "ready",
      "bindings",
      "device",
      "baselineGate",
      "summary",
      "cleanup",
      "samples",
      "limitations",
    ])
  ) {
    return ["report schema is not exact"];
  }
  if (
    report.schemaVersion !== 1 ||
    report.profile !== "startup-matrix" ||
    !["learning-off", "learning-on"].includes(report.buildVariant) ||
    !["cold", "warm"].includes(report.startupMode) ||
    !Number.isFinite(Date.parse(report.generatedAt))
  ) {
    errors.push("report identity is invalid");
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
    !exactKeys(report.bindings, ["applicationSha256", "fixtureSha256", "scriptSha256"]) ||
    Object.values(report.bindings).some((value) => typeof value !== "string" || !SHA256.test(value))
  ) {
    errors.push("binding schema is invalid");
  } else if (
    report.bindings.applicationSha256 !== expectedBindings.applicationSha256 ||
    report.bindings.fixtureSha256 !== expectedBindings.fixtureSha256 ||
    report.bindings.scriptSha256 !== expectedBindings.scriptSha256
  ) {
    errors.push("report bindings are stale or inconsistent");
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
    !exactKeys(report.baselineGate, ["requested", "minimumSamples", "passed", "failures"]) ||
    typeof report.baselineGate?.requested !== "boolean" ||
    report.baselineGate?.minimumSamples !== 20 ||
    !Array.isArray(report.baselineGate?.failures) ||
    !exactKeys(report.summary, ["startupP50Ms", "startupP95Ms"]) ||
    !exactKeys(report.cleanup, ["rootRemoved"]) ||
    typeof report.cleanup?.rootRemoved !== "boolean"
  ) {
    errors.push("gate, summary, or cleanup schema is invalid");
  }
  if (!Array.isArray(report.samples) || report.samples.length !== report.requestedSamples) {
    errors.push("raw sample count does not match the request");
  }

  const passed = [];
  for (const [index, sample] of (report.samples ?? []).entries()) {
    if (
      !exactKeys(sample, [
        "sample",
        "startupToVisibleWindowMilliseconds",
        "terminatedAfterTarget",
        "passed",
        "failure",
        "inputDatabase",
        "outputDatabase",
        "rootRemoved",
      ])
    ) {
      errors.push(`sample ${index + 1} schema is not exact`);
      continue;
    }
    if (
      sample.sample !== index + 1 ||
      !Number.isFinite(sample.startupToVisibleWindowMilliseconds) ||
      sample.startupToVisibleWindowMilliseconds <= 0 ||
      sample.terminatedAfterTarget !== true ||
      sample.passed !== true ||
      sample.failure !== null ||
      !validDatabaseSnapshot(sample.inputDatabase) ||
      !validDatabaseSnapshot(sample.outputDatabase) ||
      sample.outputDatabase.fileCount < 1 ||
      (report.startupMode === "cold" &&
        (sample.inputDatabase.fileCount !== 0 ||
          sample.inputDatabase.bytes !== 0 ||
          sample.rootRemoved !== true)) ||
      (report.startupMode === "warm" &&
        (sample.inputDatabase.fileCount < 1 || sample.rootRemoved !== null))
    ) {
      errors.push(`sample ${index + 1} is invalid or did not pass cleanly`);
    } else {
      passed.push(sample);
    }
  }
  if (report.passedSamples !== passed.length) {
    errors.push("passed sample count is optimistic");
  }
  const latencies = passed.map((sample) => sample.startupToVisibleWindowMilliseconds);
  if (
    !closeEnough(report.summary?.startupP50Ms, percentile(latencies, 0.5)) ||
    !closeEnough(report.summary?.startupP95Ms, percentile(latencies, 0.95))
  ) {
    errors.push("startup percentiles do not match raw samples");
  }
  const sampleSetPassed = passed.length === report.requestedSamples && report.cleanup?.rootRemoved;
  if (report.baselineGate?.requested) {
    const gatePassed = report.requestedSamples >= 20 && sampleSetPassed;
    if (
      report.baselineGate.passed !== gatePassed ||
      (gatePassed && report.baselineGate.failures.length !== 0) ||
      (!gatePassed && report.baselineGate.failures.length === 0) ||
      report.ready !== gatePassed
    ) {
      errors.push("baseline gate result is inconsistent");
    }
  } else if (
    report.baselineGate?.passed !== null ||
    report.baselineGate?.failures.length !== 0 ||
    report.ready !== Boolean(sampleSetPassed)
  ) {
    errors.push("smoke readiness is inconsistent");
  }
  if (JSON.stringify(report.limitations) !== JSON.stringify(LIMITATIONS)) {
    errors.push("limitations are missing or changed");
  }
  return errors;
}

export async function main(arguments_ = process.argv.slice(2)) {
  if (
    ![2, 4].includes(arguments_.length) ||
    arguments_[0] !== "--report" ||
    (arguments_.length === 4 && arguments_[2] !== "--build-variant")
  ) {
    throw new Error(
      "usage: node scripts/verify_startup_matrix_evidence.mjs --report <absolute-json> [--build-variant learning-off|learning-on]",
    );
  }
  const reportPath = arguments_[1];
  const buildVariant = arguments_[3] ?? "learning-off";
  if (!new Set(["learning-off", "learning-on"]).has(buildVariant)) {
    throw new Error("startup matrix build variant is invalid");
  }
  const targetName = buildVariant === "learning-on" ? "runtime-qa-learning" : "runtime-qa";
  const releaseRoot = path.join(projectRoot, "src-tauri", "target", targetName, "release");
  const evidenceRoot = path.join(releaseRoot, "evidence");
  if (!path.isAbsolute(reportPath)) throw new Error("startup report path must be absolute");
  if (
    path.dirname(path.resolve(reportPath)) !== path.resolve(evidenceRoot) ||
    !/^startup-(cold|warm)-\d{8}T\d{6}Z\.json$/.test(path.basename(reportPath))
  ) {
    throw new Error("startup report must be in the owned evidence directory");
  }
  const metadata = await lstat(reportPath);
  if (!metadata.isFile() || metadata.isSymbolicLink()) {
    throw new Error("startup report must be an ordinary file");
  }
  const [reportBytes, applicationBytes, fixtureBytes, scriptBytes] = await Promise.all([
    readFile(reportPath),
    readFile(path.join(releaseRoot, "yuanyuan-reminder.exe")),
    readFile(path.join(releaseRoot, "yuanyuan-runtime-qa-fixture.exe")),
    readFile(scriptPath),
  ]);
  let report;
  try {
    report = JSON.parse(reportBytes.toString("utf8").replace(/^\uFEFF/, ""));
  } catch {
    throw new Error("startup report is not valid JSON");
  }
  if (report.buildVariant !== buildVariant) {
    throw new Error("startup report build variant does not match the selected artifacts");
  }
  const errors = validateStartupMatrixReport(report, {
    applicationSha256: sha256(applicationBytes),
    fixtureSha256: sha256(fixtureBytes),
    scriptSha256: sha256(scriptBytes),
  });
  if (errors.length > 0) {
    throw new Error(`startup report is pending, stale, or inconsistent: ${errors.join("; ")}`);
  }
  console.log(
    `Startup evidence passed: ${buildVariant} ${report.startupMode} ${report.passedSamples}/${report.requestedSamples}, P95 ${report.summary.startupP95Ms} ms.`,
  );
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(import.meta.filename)) {
  await main();
}
