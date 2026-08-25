import { createHash } from "node:crypto";
import { lstat, readFile } from "node:fs/promises";
import path from "node:path";

const projectRoot = path.resolve(import.meta.dirname, "..");
const releaseRoot = path.join(
  projectRoot,
  "src-tauri",
  "target",
  "learning-pack-spike",
  "release",
);
const evidenceRoot = path.join(releaseRoot, "evidence");
const fixtureRoot = path.join(evidenceRoot, "fixtures");
const binaryPath = path.join(releaseRoot, "yuanyuan-learning-pack-spike.exe");
const sourcePaths = {
  librarySourceSha256: path.join(
    projectRoot,
    "src-tauri",
    "crates",
    "learning-pack-spike",
    "src",
    "lib.rs",
  ),
  binarySourceSha256: path.join(
    projectRoot,
    "src-tauri",
    "crates",
    "learning-pack-spike",
    "src",
    "main.rs",
  ),
  crateManifestSha256: path.join(
    projectRoot,
    "src-tauri",
    "crates",
    "learning-pack-spike",
    "Cargo.toml",
  ),
  measurementScriptSha256: path.join(
    projectRoot,
    "scripts",
    "measure_learning_pack_parse_spike.ps1",
  ),
};

const SHA256 = /^[A-F0-9]{64}$/;
const COMMIT = /^[a-f0-9]{40,64}$/;
const CASES = [
  { format: "json", cardCount: 4533, fixture: "synthetic-json-4533.json", kind: "small" },
  { format: "csv", cardCount: 4533, fixture: "synthetic-csv-4533.csv", kind: "small" },
  { format: "json", cardCount: 20000, fixture: "synthetic-json-20000.json", kind: "large" },
  { format: "csv", cardCount: 20000, fixture: "synthetic-csv-20000.csv", kind: "large" },
];
const LIMITS = {
  internalParseP95Milliseconds: 1000,
  processWallP95Milliseconds: 2000,
  peakWorkingSetBytes: 536870912,
};
const PROGRESS_PHASE_KEYS = [
  "readingInput",
  "validatingInput",
  "validatingText",
  "scanningSyntax",
  "decoding",
  "validatingStructure",
  "validatingCards",
  "finalizing",
  "complete",
];
const LIMITATIONS = [
  "This is an authorized pre-GEN pure parser spike, not PACK-001 and not a public schema freeze.",
  "The standalone release binary performs no database, preview-token, staging, install, Tauri command, WebView, or user-data operation.",
  "Synthetic fixtures contain no personal learning content; 20,000-card cases are valid near-limit inputs between 25,900,000 bytes and the frozen 25 MiB ceiling.",
  "Process-wall timing includes standalone process startup; internal timing covers bounded standalone file reading plus all pure-parser phases.",
  "This evidence covers cooperative UI progress checkpoints between at most 4 MiB file reads and across preflight, chunk-safe UTF-8 validation, syntax scan, decoding, structure validation, card validation, and streaming finalization; separate lightweight cancel probes bound serde_json/csv decoder input consumption and cumulative per-item string security, Unicode normalization input, delimiter and optional-field scanning, bounded cloning, hashing, or canonical serialization work to at most 16 KiB between polls without adding UI progress events. It does not bound cancellation while the operating system is blocked inside one file read, and does not replace file-replacement/token semantics, Tauri background scheduling, IPC progress delivery, WebView responsiveness, database commit/growth, search pagination, token replay, half-install, or signed-candidate QA.",
];

function exactKeys(value, expected) {
  return (
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    JSON.stringify(Object.keys(value).sort()) === JSON.stringify([...expected].sort())
  );
}

function closeEnough(actual, expected) {
  return Number.isFinite(actual) && Math.abs(actual - expected) <= 0.005;
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex").toUpperCase();
}

function percentile(values, fraction) {
  const ordered = [...values].sort((left, right) => left - right);
  const index = Math.max(0, Math.ceil(fraction * ordered.length) - 1);
  return Math.round(ordered[index] * 1000) / 1000;
}

function caseKey(format, cardCount) {
  return `${format}:${cardCount}`;
}

function validateFixture(fixture, expected, bindings, errors) {
  if (
    !exactKeys(fixture, ["format", "cardCount", "path", "bytes", "sha256"]) ||
    fixture.format !== expected.format ||
    fixture.cardCount !== expected.cardCount ||
    fixture.path !== expected.fixture ||
    !Number.isInteger(fixture.bytes) ||
    fixture.bytes <= 0 ||
    fixture.bytes > 26214400 ||
    (expected.kind === "large" && fixture.bytes < 25900000) ||
    !SHA256.test(fixture.sha256 ?? "")
  ) {
    errors.push(`fixture ${expected.fixture} is invalid`);
    return;
  }
  const actual = bindings.fixtures[expected.fixture];
  if (!actual || actual.sha256 !== fixture.sha256 || actual.bytes !== fixture.bytes) {
    errors.push(`fixture ${expected.fixture} is stale or changed`);
  }
}

function expectedSummary(samples, format, cardCount) {
  const selected = samples.filter(
    (sample) => sample.format === format && sample.cardCount === cardCount,
  );
  const passed = selected.filter((sample) => sample.passed === true);
  const values = (key) => passed.map((sample) => sample[key]);
  return {
    format,
    cardCount,
    requestedSamples: selected.length,
    passedSamples: passed.length,
    internalParseP50Milliseconds: percentile(values("internalParseMilliseconds"), 0.5),
    internalParseP95Milliseconds: percentile(values("internalParseMilliseconds"), 0.95),
    processWallP50Milliseconds: percentile(values("wallMilliseconds"), 0.5),
    processWallP95Milliseconds: percentile(values("wallMilliseconds"), 0.95),
    peakWorkingSetBytes: Math.max(...values("peakWorkingSetBytes")),
    peakPrivateMemoryBytes: Math.max(...values("peakPrivateMemoryBytes")),
  };
}

export function parseLearningPackSpikeEvidence(raw) {
  return JSON.parse(raw.replace(/^\uFEFF/, ""));
}

export function validateLearningPackSpikeReport(
  report,
  bindings,
  { requireGate = true } = {},
) {
  const errors = [];
  if (
    !exactKeys(report, [
      "schemaVersion",
      "generatedAt",
      "profile",
      "scope",
      "source",
      "bindings",
      "device",
      "request",
      "budgets",
      "fixtures",
      "summaries",
      "samples",
      "isolation",
      "baselineGate",
      "ready",
      "limitations",
    ])
  ) {
    return ["report schema is not exact"];
  }
  if (
    report.schemaVersion !== 7 ||
    report.profile !== "pre-gen-pure-parser-spike" ||
    !Number.isFinite(Date.parse(report.generatedAt)) ||
    typeof report.ready !== "boolean"
  ) {
    errors.push("report identity is invalid");
  }
  if (
    !exactKeys(report.scope, [
      "databaseWritesAllowed",
      "installAllowed",
      "previewTokensAllowed",
      "tauriCommandsRegistered",
      "pack001Implementation",
    ]) ||
    report.scope.databaseWritesAllowed !== false ||
    report.scope.installAllowed !== false ||
    report.scope.previewTokensAllowed !== false ||
    report.scope.tauriCommandsRegistered !== 0 ||
    report.scope.pack001Implementation !== false
  ) {
    errors.push("pure parser scope boundary is invalid");
  }
  if (
    !exactKeys(report.source, ["gitCommit", "gitDirty", "gitStatusSha256"]) ||
    !COMMIT.test(report.source?.gitCommit ?? "") ||
    typeof report.source?.gitDirty !== "boolean" ||
    !SHA256.test(report.source?.gitStatusSha256 ?? "")
  ) {
    errors.push("source state is incomplete");
  }
  const bindingKeys = [
    "binarySha256",
    "librarySourceSha256",
    "binarySourceSha256",
    "crateManifestSha256",
    "measurementScriptSha256",
  ];
  if (
    !exactKeys(report.bindings, bindingKeys) ||
    Object.values(report.bindings ?? {}).some((value) => !SHA256.test(value))
  ) {
    errors.push("artifact binding schema is invalid");
  } else {
    for (const key of bindingKeys) {
      if (report.bindings[key] !== bindings[key]) {
        errors.push(`${key} is stale or changed`);
      }
    }
  }
  if (
    !exactKeys(report.device, [
      "windowsProductName",
      "windowsDisplayVersion",
      "windowsBuild",
      "processorArchitecture",
      "processorIdentifier",
      "logicalProcessors",
      "powerLineStatus",
    ]) ||
    !Number.isInteger(report.device?.logicalProcessors) ||
    report.device.logicalProcessors < 1 ||
    !["Online", "Offline", "Unknown"].includes(report.device?.powerLineStatus) ||
    [
      report.device?.windowsProductName,
      report.device?.windowsBuild,
      report.device?.processorArchitecture,
      report.device?.processorIdentifier,
    ].some((value) => typeof value !== "string" || value.length === 0)
  ) {
    errors.push("device evidence is incomplete");
  }
  if (
    !exactKeys(report.request, [
      "smallCardCount",
      "largeCardCount",
      "smallSampleCount",
      "largeSampleCount",
      "baselineGateRequested",
    ]) ||
    report.request?.smallCardCount !== 4533 ||
    report.request?.largeCardCount !== 20000 ||
    !Number.isInteger(report.request?.smallSampleCount) ||
    report.request.smallSampleCount < 1 ||
    !Number.isInteger(report.request?.largeSampleCount) ||
    report.request.largeSampleCount < 1 ||
    typeof report.request?.baselineGateRequested !== "boolean"
  ) {
    errors.push("measurement request is invalid");
  }
  if (
    !exactKeys(report.budgets, [
      "maximumPackageBytes",
      "minimumNearLimitPackageBytes",
      "maximumCards",
      "maximumJsonDepth",
      "progressCardInterval",
      "progressByteInterval",
      "progressValueInterval",
      "controlDecodeByteInterval",
      "controlItemByteInterval",
      "maximumProgressCallbacks",
    ]) ||
    report.budgets?.maximumPackageBytes !== 26214400 ||
    report.budgets?.minimumNearLimitPackageBytes !== 25900000 ||
    report.budgets?.maximumCards !== 20000 ||
    report.budgets?.maximumJsonDepth !== 8 ||
    report.budgets?.progressCardInterval !== 256 ||
    report.budgets?.progressByteInterval !== 4194304 ||
    report.budgets?.progressValueInterval !== 16384 ||
    report.budgets?.controlDecodeByteInterval !== 16384 ||
    report.budgets?.controlItemByteInterval !== 16384 ||
    report.budgets?.maximumProgressCallbacks !== 256
  ) {
    errors.push("frozen parser budgets are invalid");
  }
  if (!Array.isArray(report.fixtures) || report.fixtures.length !== CASES.length) {
    errors.push("fixture matrix is incomplete");
  } else {
    CASES.forEach((expected, index) =>
      validateFixture(report.fixtures[index], expected, bindings, errors),
    );
  }
  const expectedSampleCounts = new Map(
    CASES.map((entry) => [
      caseKey(entry.format, entry.cardCount),
      entry.kind === "small" ? report.request.smallSampleCount : report.request.largeSampleCount,
    ]),
  );
  const observedSampleCounts = new Map();
  const contentHashes = new Map();
  if (!Array.isArray(report.samples) || report.samples.length === 0) {
    errors.push("raw samples are missing");
  } else {
    for (const [index, sample] of report.samples.entries()) {
      if (
        !exactKeys(sample, [
          "format",
          "cardCount",
          "sample",
          "exitCode",
          "wallMilliseconds",
          "cpuMilliseconds",
          "workingSetBytes",
          "peakWorkingSetBytes",
          "privateMemoryBytes",
          "peakPrivateMemoryBytes",
          "internalParseMilliseconds",
          "progressCallbacks",
          "progressCardInterval",
          "progressByteInterval",
          "progressValueInterval",
          "controlDecodeByteInterval",
          "controlItemByteInterval",
          "progressPhaseCounts",
          "finalProgressPhase",
          "finalProgressUnit",
          "finalProgressCompletedUnits",
          "finalProgressTotalUnits",
          "reportedFileBytes",
          "reportedFileSha256",
          "contentSha256",
          "databaseWrites",
          "passed",
          "failure",
        ])
      ) {
        errors.push(`sample ${index + 1} schema is not exact`);
        continue;
      }
      const key = caseKey(sample.format, sample.cardCount);
      const expectedCase = CASES.find(
        (entry) => entry.format === sample.format && entry.cardCount === sample.cardCount,
      );
      const ordinal = (observedSampleCounts.get(key) ?? 0) + 1;
      observedSampleCounts.set(key, ordinal);
      const fixture = expectedCase
        ? report.fixtures.find((entry) => entry.path === expectedCase.fixture)
        : null;
      const phaseCountsValid =
        exactKeys(sample.progressPhaseCounts, PROGRESS_PHASE_KEYS) &&
        PROGRESS_PHASE_KEYS.every(
          (phase) =>
            Number.isInteger(sample.progressPhaseCounts[phase]) &&
            sample.progressPhaseCounts[phase] >= 0,
        );
      const phaseCallbackTotal = phaseCountsValid
        ? PROGRESS_PHASE_KEYS.reduce(
            (total, phase) => total + sample.progressPhaseCounts[phase],
            0,
          )
        : -1;
      const requiredProgressPhasesValid =
        phaseCountsValid &&
        sample.progressPhaseCounts.readingInput >= 2 &&
        sample.progressPhaseCounts.validatingInput >= 2 &&
        sample.progressPhaseCounts.validatingText >= 2 &&
        sample.progressPhaseCounts.decoding >= 2 &&
        sample.progressPhaseCounts.validatingStructure >= 1 &&
        sample.progressPhaseCounts.validatingCards >= 1 &&
        sample.progressPhaseCounts.finalizing >= 2 &&
        sample.progressPhaseCounts.complete === 1 &&
        (sample.format === "json"
          ? sample.progressPhaseCounts.scanningSyntax >= 2
          : sample.progressPhaseCounts.scanningSyntax === 0);
      if (
        !expectedCase ||
        sample.sample !== ordinal ||
        sample.exitCode !== 0 ||
        !(sample.wallMilliseconds > 0) ||
        !(sample.cpuMilliseconds >= 0) ||
        !(sample.internalParseMilliseconds > 0) ||
        sample.internalParseMilliseconds > sample.wallMilliseconds + 5 ||
        !Number.isInteger(sample.workingSetBytes) ||
        sample.workingSetBytes <= 0 ||
        !Number.isInteger(sample.peakWorkingSetBytes) ||
        sample.peakWorkingSetBytes < sample.workingSetBytes ||
        !Number.isInteger(sample.privateMemoryBytes) ||
        sample.privateMemoryBytes <= 0 ||
        !Number.isInteger(sample.peakPrivateMemoryBytes) ||
        sample.peakPrivateMemoryBytes < sample.privateMemoryBytes ||
        !Number.isInteger(sample.progressCallbacks) ||
        sample.progressCallbacks <= 0 ||
        sample.progressCallbacks > report.budgets.maximumProgressCallbacks ||
        sample.progressCallbacks !== phaseCallbackTotal ||
        sample.progressCardInterval !== 256 ||
        sample.progressByteInterval !== 4194304 ||
        sample.progressValueInterval !== 16384 ||
        sample.controlDecodeByteInterval !== 16384 ||
        sample.controlItemByteInterval !== 16384 ||
        !requiredProgressPhasesValid ||
        sample.finalProgressPhase !== "complete" ||
        sample.finalProgressUnit !== "cards" ||
        sample.finalProgressCompletedUnits !== sample.cardCount ||
        sample.finalProgressTotalUnits !== sample.cardCount ||
        sample.reportedFileBytes !== fixture?.bytes ||
        sample.reportedFileSha256 !== fixture?.sha256 ||
        !SHA256.test(sample.contentSha256 ?? "") ||
        sample.databaseWrites !== 0 ||
        sample.passed !== true ||
        sample.failure !== null
      ) {
        errors.push(`sample ${index + 1} is invalid or optimistic`);
      }
      const previousContent = contentHashes.get(key);
      if (previousContent && previousContent !== sample.contentSha256) {
        errors.push(`sample ${index + 1} normalized content hash changed within a case`);
      }
      contentHashes.set(key, sample.contentSha256);
    }
  }
  for (const [key, count] of expectedSampleCounts) {
    if (observedSampleCounts.get(key) !== count) {
      errors.push(`sample count for ${key} is incomplete`);
    }
  }
  if (!Array.isArray(report.summaries) || report.summaries.length !== CASES.length) {
    errors.push("summary matrix is incomplete");
  } else {
    CASES.forEach((entry, index) => {
      const actual = report.summaries[index];
      const expected = expectedSummary(report.samples, entry.format, entry.cardCount);
      if (
        !exactKeys(actual, [
          "format",
          "cardCount",
          "requestedSamples",
          "passedSamples",
          "internalParseP50Milliseconds",
          "internalParseP95Milliseconds",
          "processWallP50Milliseconds",
          "processWallP95Milliseconds",
          "peakWorkingSetBytes",
          "peakPrivateMemoryBytes",
        ]) ||
        actual.format !== expected.format ||
        actual.cardCount !== expected.cardCount ||
        actual.requestedSamples !== expected.requestedSamples ||
        actual.passedSamples !== expected.passedSamples
      ) {
        errors.push(`summary ${entry.format}:${entry.cardCount} identity is invalid`);
        return;
      }
      for (const key of [
        "internalParseP50Milliseconds",
        "internalParseP95Milliseconds",
        "processWallP50Milliseconds",
        "processWallP95Milliseconds",
        "peakWorkingSetBytes",
        "peakPrivateMemoryBytes",
      ]) {
        if (!closeEnough(actual[key], expected[key])) {
          errors.push(`summary ${entry.format}:${entry.cardCount} ${key} is inconsistent`);
        }
      }
    });
  }
  if (
    !exactKeys(report.isolation, [
      "databaseFileCount",
      "allChildReportsDeclaredZeroDatabaseWrites",
    ]) ||
    report.isolation?.databaseFileCount !== 0 ||
    report.isolation?.allChildReportsDeclaredZeroDatabaseWrites !== true
  ) {
    errors.push("database write isolation is invalid");
  }
  if (
    !exactKeys(report.baselineGate, [
      "requested",
      "minimumSmallSamples",
      "minimumLargeSamples",
      "candidateLimits",
      "passed",
      "failures",
    ]) ||
    report.baselineGate?.requested !== report.request?.baselineGateRequested ||
    report.baselineGate?.minimumSmallSamples !== 10 ||
    report.baselineGate?.minimumLargeSamples !== 5 ||
    JSON.stringify(report.baselineGate?.candidateLimits) !== JSON.stringify(LIMITS) ||
    !Array.isArray(report.baselineGate?.failures)
  ) {
    errors.push("baseline gate schema is invalid");
  } else if (report.baselineGate.requested) {
    const expectedFailures = [];
    if (report.request.smallSampleCount < 10) expectedFailures.push("small_sample_count_below_gate");
    if (report.request.largeSampleCount < 5) expectedFailures.push("large_sample_count_below_gate");
    for (const summary of report.summaries) {
      if (summary.passedSamples !== summary.requestedSamples) {
        expectedFailures.push(`sample_count_incomplete_${summary.format}_${summary.cardCount}`);
      }
      if (summary.internalParseP95Milliseconds > LIMITS.internalParseP95Milliseconds) {
        expectedFailures.push(`internal_parse_p95_limit_${summary.format}_${summary.cardCount}`);
      }
      if (summary.processWallP95Milliseconds > LIMITS.processWallP95Milliseconds) {
        expectedFailures.push(`process_wall_p95_limit_${summary.format}_${summary.cardCount}`);
      }
      if (summary.peakWorkingSetBytes > LIMITS.peakWorkingSetBytes) {
        expectedFailures.push(`peak_working_set_limit_${summary.format}_${summary.cardCount}`);
      }
    }
    if (JSON.stringify(report.baselineGate.failures) !== JSON.stringify(expectedFailures)) {
      errors.push("baseline gate failures do not match raw evidence");
    }
    const expectedPassed = expectedFailures.length === 0;
    if (report.baselineGate.passed !== expectedPassed || report.ready !== expectedPassed) {
      errors.push("baseline gate outcome is inconsistent");
    }
    if (requireGate && !expectedPassed) errors.push("baseline gate did not pass");
  } else if (
    report.baselineGate.passed !== null ||
    report.baselineGate.failures.length !== 0 ||
    report.ready !== true
  ) {
    errors.push("smoke readiness is inconsistent");
  } else if (requireGate) {
    errors.push("formal baseline gate was not requested");
  }
  if (JSON.stringify(report.limitations) !== JSON.stringify(LIMITATIONS)) {
    errors.push("limitations are missing or changed");
  }
  return errors;
}

function argumentValue(arguments_, name) {
  const index = arguments_.indexOf(name);
  return index >= 0 ? arguments_[index + 1] : null;
}

export async function main(arguments_ = process.argv.slice(2)) {
  const reportArgument = argumentValue(arguments_, "--report");
  const allowSmoke = arguments_.includes("--allow-smoke");
  if (!reportArgument) {
    throw new Error("--report is required");
  }
  const reportPath = path.resolve(reportArgument);
  if (
    path.dirname(reportPath) !== path.resolve(evidenceRoot) ||
    !/^learning-pack-parse-spike-\d{8}T\d{6}Z\.json$/.test(path.basename(reportPath))
  ) {
    throw new Error("report must be an owned learning pack spike evidence file");
  }
  const metadata = await lstat(reportPath);
  if (!metadata.isFile() || metadata.isSymbolicLink()) {
    throw new Error("report must be an ordinary file");
  }
  const artifactEntries = await Promise.all([
    readFile(reportPath, "utf8"),
    readFile(binaryPath),
    ...Object.values(sourcePaths).map((sourcePath) => readFile(sourcePath)),
    ...CASES.map((entry) => readFile(path.join(fixtureRoot, entry.fixture))),
  ]);
  const [raw, binary, ...rest] = artifactEntries;
  const sourceBytes = rest.slice(0, Object.keys(sourcePaths).length);
  const fixtureBytes = rest.slice(Object.keys(sourcePaths).length);
  const bindings = {
    binarySha256: sha256(binary),
    ...Object.fromEntries(
      Object.keys(sourcePaths).map((key, index) => [key, sha256(sourceBytes[index])]),
    ),
    fixtures: Object.fromEntries(
      CASES.map((entry, index) => [
        entry.fixture,
        { sha256: sha256(fixtureBytes[index]), bytes: fixtureBytes[index].length },
      ]),
    ),
  };
  const report = parseLearningPackSpikeEvidence(raw);
  const errors = validateLearningPackSpikeReport(report, bindings, {
    requireGate: !allowSmoke,
  });
  if (errors.length > 0) {
    throw new Error(`parser spike report is pending, stale, or inconsistent: ${errors.join("; ")}`);
  }
  console.log(
    `Learning pack parser spike evidence passed: ${report.samples.length} samples, ` +
      `20,000-card JSON P95 ${report.summaries[2].internalParseP95Milliseconds} ms, ` +
      `CSV P95 ${report.summaries[3].internalParseP95Milliseconds} ms.`,
  );
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(import.meta.filename)) {
  await main();
}
