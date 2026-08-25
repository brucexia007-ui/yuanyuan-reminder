import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

const projectRoot = path.resolve(import.meta.dirname, "..");
const SHA256 = /^[A-F0-9]{64}$/;
const EXECUTABLE_PATH = /^src-tauri\/target\/debug\/deps\/yuanyuan_reminder_lib-[a-f0-9]+\.exe$/;
const RESULT_LINE = /^test result: (ok|FAILED)\. (\d+) passed; (\d+) failed; (\d+) ignored; (\d+) measured; (\d+) filtered out; finished in ([0-9.]+)s\.?$/;
const EMPTY_SHA256 = createHash("sha256").update("").digest("hex").toUpperCase();
const LIMITATIONS = [
  "The scan exercises one Windows test process per round with 24 Rust test threads.",
  "The process-wide lock serializes WinVerifyTrust provider-state lifecycles and bounded MZ/e_lfanew/PE-signature preflight rejects non-PE files before WinVerifyTrust; the exact native fault instruction and module remain unknown because no crash dump or WER record was captured.",
  "Passing rounds demonstrate repeatability on this device and source state, not a proof that Windows native APIs can never fail.",
  "The supervisor unhealthy-child fixture uses a single PowerShell process so test cleanup does not leave a 30-second descendant.",
];
const BINDING_KEYS = [
  "measurementScriptSha256",
  "verifierSha256",
  "windowsArtifactTrustSourceSha256",
  "connectorToolTrustSourceSha256",
  "connectorDiscoverySourceSha256",
  "aiSupervisorSourceSha256",
  "cargoLockSha256",
  "defaultTestExecutablePath",
  "defaultTestExecutableSha256",
  "learningTestExecutablePath",
  "learningTestExecutableSha256",
];
const SAMPLE_KEYS = [
  "profile",
  "round",
  "exitCode",
  "wallMilliseconds",
  "harnessSeconds",
  "status",
  "passed",
  "failed",
  "ignored",
  "measured",
  "filteredOut",
  "resultLine",
  "resultLineSha256",
  "stderrSha256",
];
const SUMMARY_KEYS = [
  "rounds",
  "failures",
  "consistentCounts",
  "passedPerRound",
  "ignoredPerRound",
  "measuredPerRound",
  "filteredOutPerRound",
  "minimumWallMilliseconds",
  "p50WallMilliseconds",
  "p95WallMilliseconds",
  "maximumWallMilliseconds",
];

function exactKeys(value, expected) {
  return (
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    JSON.stringify(Object.keys(value).sort()) === JSON.stringify([...expected].sort())
  );
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex").toUpperCase();
}

function percentile(values, fraction) {
  const ordered = [...values].sort((left, right) => left - right);
  const index = Math.max(0, Math.ceil(fraction * ordered.length) - 1);
  return Number(ordered[index].toFixed(3));
}

function numberEquals(left, right) {
  return Number.isFinite(left) && Number.isFinite(right) && Math.abs(left - right) < 0.001;
}

function recomputeSummary(samples) {
  const reference = samples[0];
  const walls = samples.map((sample) => sample.wallMilliseconds);
  const failures = samples.filter(
    (sample) => sample.exitCode !== 0 || sample.status !== "ok" || sample.failed !== 0,
  ).length;
  const consistentCounts = samples.every(
    (sample) =>
      sample.passed === reference.passed &&
      sample.ignored === reference.ignored &&
      sample.measured === reference.measured &&
      sample.filteredOut === reference.filteredOut,
  );
  return {
    rounds: samples.length,
    failures,
    consistentCounts,
    passedPerRound: reference.passed,
    ignoredPerRound: reference.ignored,
    measuredPerRound: reference.measured,
    filteredOutPerRound: reference.filteredOut,
    minimumWallMilliseconds: Number(Math.min(...walls).toFixed(3)),
    p50WallMilliseconds: percentile(walls, 0.5),
    p95WallMilliseconds: percentile(walls, 0.95),
    maximumWallMilliseconds: Number(Math.max(...walls).toFixed(3)),
  };
}

function summaryMatches(actual, expected) {
  if (!exactKeys(actual, SUMMARY_KEYS)) return false;
  for (const key of SUMMARY_KEYS) {
    if (typeof expected[key] === "number" && !Number.isInteger(expected[key])) {
      if (!numberEquals(actual[key], expected[key])) return false;
    } else if (actual[key] !== expected[key]) {
      return false;
    }
  }
  return true;
}

export function parseRustParallelStabilityEvidence(text) {
  return JSON.parse(text.replace(/^\uFEFF/, ""));
}

export function validateRustParallelStabilityReport(
  report,
  expectedBindings,
  { requireGate = true } = {},
) {
  const errors = [];
  if (
    !exactKeys(report, [
      "schemaVersion",
      "generatedAt",
      "profile",
      "bindings",
      "device",
      "request",
      "gate",
      "samples",
      "summary",
      "ready",
      "limitations",
      "failure",
    ])
  ) {
    return ["report schema is not exact"];
  }
  if (
    report.schemaVersion !== 1 ||
    report.profile !== "rust-parallel-stability" ||
    typeof report.generatedAt !== "string" ||
    !Number.isFinite(Date.parse(report.generatedAt))
  ) {
    errors.push("report identity is invalid");
  }

  if (!exactKeys(report.bindings, BINDING_KEYS)) {
    errors.push("binding schema is not exact");
  } else {
    for (const key of BINDING_KEYS.filter((key) => key.endsWith("Sha256"))) {
      if (!SHA256.test(report.bindings[key])) errors.push(`${key} is not SHA-256`);
      if (expectedBindings?.[key] !== undefined && report.bindings[key] !== expectedBindings[key]) {
        errors.push(`${key} binding is stale`);
      }
    }
    for (const key of ["defaultTestExecutablePath", "learningTestExecutablePath"]) {
      if (!EXECUTABLE_PATH.test(report.bindings[key])) {
        errors.push(`${key} is outside the bound test target`);
      }
      if (expectedBindings?.[key] !== undefined && report.bindings[key] !== expectedBindings[key]) {
        errors.push(`${key} binding is stale`);
      }
    }
  }

  if (
    !exactKeys(report.device, ["windowsVersion", "processArchitecture", "logicalProcessors"]) ||
    typeof report.device.windowsVersion !== "string" ||
    !report.device.windowsVersion.includes("Windows") ||
    typeof report.device.processArchitecture !== "string" ||
    report.device.processArchitecture.length < 2 ||
    !Number.isInteger(report.device.logicalProcessors) ||
    report.device.logicalProcessors < 1
  ) {
    errors.push("device evidence is invalid");
  }

  if (
    !exactKeys(report.request, [
      "defaultRounds",
      "learningRounds",
      "testThreads",
      "baselineGate",
    ]) ||
    !Number.isInteger(report.request.defaultRounds) ||
    report.request.defaultRounds < 1 ||
    !Number.isInteger(report.request.learningRounds) ||
    report.request.learningRounds < 1 ||
    !Number.isInteger(report.request.testThreads) ||
    report.request.testThreads < 1 ||
    typeof report.request.baselineGate !== "boolean"
  ) {
    errors.push("request schema is invalid");
  }
  if (
    !exactKeys(report.gate, [
      "requiredDefaultRounds",
      "requiredLearningRounds",
      "requiredTestThreads",
      "maximumP95Milliseconds",
      "formalGate",
      "outcomesPassed",
    ]) ||
    report.gate.requiredDefaultRounds !== 20 ||
    report.gate.requiredLearningRounds !== 10 ||
    report.gate.requiredTestThreads !== 24 ||
    report.gate.maximumP95Milliseconds !== 10000
  ) {
    errors.push("gate contract is invalid");
  }

  const expectedSampleCount = report.request.defaultRounds + report.request.learningRounds;
  if (!Array.isArray(report.samples) || report.samples.length !== expectedSampleCount) {
    errors.push("sample count does not match the request");
  }
  const samples = Array.isArray(report.samples) ? report.samples : [];
  for (const sample of samples) {
    if (!exactKeys(sample, SAMPLE_KEYS)) {
      errors.push("sample schema is not exact");
      continue;
    }
    const match = typeof sample.resultLine === "string" ? RESULT_LINE.exec(sample.resultLine) : null;
    if (
      !["default", "learning"].includes(sample.profile) ||
      !Number.isInteger(sample.round) ||
      sample.round < 1 ||
      !Number.isInteger(sample.exitCode) ||
      !Number.isFinite(sample.wallMilliseconds) ||
      sample.wallMilliseconds <= 0 ||
      !Number.isFinite(sample.harnessSeconds) ||
      sample.harnessSeconds < 0 ||
      !["ok", "FAILED"].includes(sample.status) ||
      ![sample.passed, sample.failed, sample.ignored, sample.measured, sample.filteredOut].every(
        (value) => Number.isInteger(value) && value >= 0,
      ) ||
      sample.passed < 1 ||
      !match
    ) {
      errors.push("sample outcome is invalid");
      continue;
    }
    const parsed = {
      status: match[1],
      passed: Number(match[2]),
      failed: Number(match[3]),
      ignored: Number(match[4]),
      measured: Number(match[5]),
      filteredOut: Number(match[6]),
      harnessSeconds: Number(match[7]),
    };
    if (
      Object.entries(parsed).some(([key, value]) =>
        key === "harnessSeconds" ? !numberEquals(sample[key], value) : sample[key] !== value,
      ) ||
      sample.resultLineSha256 !== sha256(sample.resultLine) ||
      sample.stderrSha256 !== EMPTY_SHA256 ||
      sample.wallMilliseconds + 50 < sample.harnessSeconds * 1000
    ) {
      errors.push("sample summary or hash is inconsistent");
    }
  }

  const grouped = {};
  for (const profile of ["default", "learning"]) {
    grouped[profile] = samples.filter((sample) => sample.profile === profile);
    const expectedRounds = report.request[`${profile}Rounds`];
    const roundSet = new Set(grouped[profile].map((sample) => sample.round));
    if (
      grouped[profile].length !== expectedRounds ||
      roundSet.size !== expectedRounds ||
      !Array.from({ length: expectedRounds }, (_, index) => index + 1).every((round) =>
        roundSet.has(round),
      )
    ) {
      errors.push(`${profile} rounds are incomplete or duplicated`);
    }
  }

  let recomputedOutcomesPassed = false;
  if (
    exactKeys(report.summary, ["default", "learning"]) &&
    grouped.default.length > 0 &&
    grouped.learning.length > 0
  ) {
    const expectedDefault = recomputeSummary(grouped.default);
    const expectedLearning = recomputeSummary(grouped.learning);
    if (!summaryMatches(report.summary.default, expectedDefault)) {
      errors.push("default summary is not recomputed from samples");
    }
    if (!summaryMatches(report.summary.learning, expectedLearning)) {
      errors.push("learning summary is not recomputed from samples");
    }
    recomputedOutcomesPassed =
      expectedDefault.failures === 0 &&
      expectedLearning.failures === 0 &&
      expectedDefault.consistentCounts &&
      expectedLearning.consistentCounts &&
      expectedDefault.p95WallMilliseconds <= report.gate.maximumP95Milliseconds &&
      expectedLearning.p95WallMilliseconds <= report.gate.maximumP95Milliseconds;
  } else {
    errors.push("summary schema is invalid");
  }

  const expectedFormalGate =
    report.request.baselineGate &&
    report.request.defaultRounds >= report.gate.requiredDefaultRounds &&
    report.request.learningRounds >= report.gate.requiredLearningRounds &&
    report.request.testThreads === report.gate.requiredTestThreads;
  if (report.gate.formalGate !== expectedFormalGate) {
    errors.push("formal gate status is inconsistent");
  }
  if (report.gate.outcomesPassed !== recomputedOutcomesPassed) {
    errors.push("outcome gate status is inconsistent");
  }
  if (report.ready !== (expectedFormalGate && recomputedOutcomesPassed)) {
    errors.push("readiness is inconsistent");
  }
  if (recomputedOutcomesPassed ? report.failure !== null : typeof report.failure !== "string") {
    errors.push("failure field is inconsistent");
  }
  if (JSON.stringify(report.limitations) !== JSON.stringify(LIMITATIONS)) {
    errors.push("limitations are incomplete or changed");
  }
  if (requireGate && !report.ready) {
    errors.push("report is not a passing formal baseline gate");
  }
  return errors;
}

async function hashFile(filePath) {
  return sha256(await readFile(filePath));
}

async function expectedBindingsFor(report) {
  const bindings = {
    measurementScriptSha256: await hashFile(
      path.join(projectRoot, "scripts", "measure_rust_parallel_stability.ps1"),
    ),
    verifierSha256: await hashFile(
      path.join(projectRoot, "scripts", "verify_rust_parallel_stability_evidence.mjs"),
    ),
    windowsArtifactTrustSourceSha256: await hashFile(
      path.join(projectRoot, "src-tauri", "src", "windows_artifact_trust.rs"),
    ),
    connectorToolTrustSourceSha256: await hashFile(
      path.join(projectRoot, "src-tauri", "src", "connector_tool_trust.rs"),
    ),
    connectorDiscoverySourceSha256: await hashFile(
      path.join(projectRoot, "src-tauri", "src", "connector_discovery.rs"),
    ),
    aiSupervisorSourceSha256: await hashFile(
      path.join(projectRoot, "src-tauri", "src", "ai_supervisor.rs"),
    ),
    cargoLockSha256: await hashFile(path.join(projectRoot, "src-tauri", "Cargo.lock")),
    defaultTestExecutablePath: report.bindings.defaultTestExecutablePath,
    defaultTestExecutableSha256: "",
    learningTestExecutablePath: report.bindings.learningTestExecutablePath,
    learningTestExecutableSha256: "",
  };
  for (const profile of ["default", "learning"]) {
    const pathKey = `${profile}TestExecutablePath`;
    const hashKey = `${profile}TestExecutableSha256`;
    if (!EXECUTABLE_PATH.test(bindings[pathKey])) continue;
    const executable = path.resolve(projectRoot, ...bindings[pathKey].split("/"));
    const allowedRoot = `${path.resolve(projectRoot, "src-tauri", "target", "debug", "deps")}${path.sep}`;
    if (!executable.startsWith(allowedRoot)) continue;
    bindings[hashKey] = await hashFile(executable);
  }
  return bindings;
}

function reportArgument(argv) {
  const index = argv.indexOf("--report");
  return index >= 0 ? argv[index + 1] : undefined;
}

async function main() {
  const reportPath = reportArgument(process.argv.slice(2));
  if (!reportPath) throw new Error("usage: node verify_rust_parallel_stability_evidence.mjs --report <path>");
  const report = parseRustParallelStabilityEvidence(await readFile(reportPath, "utf8"));
  const errors = validateRustParallelStabilityReport(report, await expectedBindingsFor(report));
  if (errors.length > 0) throw new Error(errors.join("\n"));
  console.log(
    `Rust parallel stability evidence verified: default ${report.summary.default.rounds}/${report.summary.default.rounds}, learning ${report.summary.learning.rounds}/${report.summary.learning.rounds}.`,
  );
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
