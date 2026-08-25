import assert from "node:assert/strict";
import test from "node:test";

import {
  parseLearningPackSpikeEvidence,
  validateLearningPackSpikeReport,
} from "./verify_learning_pack_parse_spike_evidence.mjs";

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
const LIMITATIONS = [
  "This is an authorized pre-GEN pure parser spike, not PACK-001 and not a public schema freeze.",
  "The standalone release binary performs no database, preview-token, staging, install, Tauri command, WebView, or user-data operation.",
  "Synthetic fixtures contain no personal learning content; 20,000-card cases are valid near-limit inputs between 25,900,000 bytes and the frozen 25 MiB ceiling.",
  "Process-wall timing includes standalone process startup; internal timing covers bounded standalone file reading plus all pure-parser phases.",
  "This evidence covers cooperative UI progress checkpoints between at most 4 MiB file reads and across preflight, chunk-safe UTF-8 validation, syntax scan, decoding, structure validation, card validation, and streaming finalization; separate lightweight cancel probes bound serde_json/csv decoder input consumption and cumulative per-item string security, Unicode normalization input, delimiter and optional-field scanning, bounded cloning, hashing, or canonical serialization work to at most 16 KiB between polls without adding UI progress events. It does not bound cancellation while the operating system is blocked inside one file read, and does not replace file-replacement/token semantics, Tauri background scheduling, IPC progress delivery, WebView responsiveness, database commit/growth, search pagination, token replay, half-install, or signed-candidate QA.",
];
const bindingKeys = [
  "binarySha256",
  "librarySourceSha256",
  "binarySourceSha256",
  "crateManifestSha256",
  "measurementScriptSha256",
];
const BINDINGS = {
  ...Object.fromEntries(bindingKeys.map((key, index) => [key, String.fromCharCode(65 + index).repeat(64)])),
  fixtures: Object.fromEntries(
    CASES.map((entry, index) => [
      entry.fixture,
      {
        sha256: ["F", "1", "2", "3"][index].repeat(64),
        bytes: [1_001_898, 571_219, 26_020_105, 26_120_061][index],
      },
    ]),
  ),
};

function percentile(values, fraction) {
  const ordered = [...values].sort((left, right) => left - right);
  return Math.round(ordered[Math.max(0, Math.ceil(fraction * ordered.length) - 1)] * 1000) / 1000;
}

function makeReport({ gate = true, small = 10, large = 5 } = {}) {
  const fixtures = CASES.map((entry) => ({
    format: entry.format,
    cardCount: entry.cardCount,
    path: entry.fixture,
    bytes: BINDINGS.fixtures[entry.fixture].bytes,
    sha256: BINDINGS.fixtures[entry.fixture].sha256,
  }));
  const samples = CASES.flatMap((entry, caseIndex) => {
    const count = entry.kind === "small" ? small : large;
    return Array.from({ length: count }, (_, index) => {
      const progressPhaseCounts = {
        readingInput: 2,
        validatingInput: 2,
        validatingText: 2,
        scanningSyntax: entry.format === "json" ? 2 : 0,
        decoding: 2,
        validatingStructure: entry.format === "json" ? 3 : 1,
        validatingCards: Math.ceil(entry.cardCount / 256) + 1,
        finalizing: 2,
        complete: 1,
      };
      const progressCallbacks = Object.values(progressPhaseCounts).reduce(
        (total, value) => total + value,
        0,
      );
      return {
        format: entry.format,
        cardCount: entry.cardCount,
        sample: index + 1,
        exitCode: 0,
        wallMilliseconds: 50 + caseIndex * 50 + index,
        cpuMilliseconds: 40 + caseIndex * 40 + index,
        workingSetBytes: 10_000_000 + caseIndex * 10_000_000,
        peakWorkingSetBytes: 20_000_000 + caseIndex * 20_000_000 + index * 1000,
        privateMemoryBytes: 8_000_000 + caseIndex * 10_000_000,
        peakPrivateMemoryBytes: 18_000_000 + caseIndex * 20_000_000 + index * 1000,
        internalParseMilliseconds: 30 + caseIndex * 30 + index,
        progressCallbacks,
        progressCardInterval: 256,
        progressByteInterval: 4194304,
        progressValueInterval: 16384,
        controlDecodeByteInterval: 16384,
        controlItemByteInterval: 16384,
        progressPhaseCounts,
        finalProgressPhase: "complete",
        finalProgressUnit: "cards",
        finalProgressCompletedUnits: entry.cardCount,
        finalProgressTotalUnits: entry.cardCount,
        reportedFileBytes: BINDINGS.fixtures[entry.fixture].bytes,
        reportedFileSha256: BINDINGS.fixtures[entry.fixture].sha256,
        contentSha256: ["4", "5", "6", "7"][caseIndex].repeat(64),
        databaseWrites: 0,
        passed: true,
        failure: null,
      };
    });
  });
  const summaries = CASES.map((entry) => {
    const selected = samples.filter(
      (sample) => sample.format === entry.format && sample.cardCount === entry.cardCount,
    );
    const values = (key) => selected.map((sample) => sample[key]);
    return {
      format: entry.format,
      cardCount: entry.cardCount,
      requestedSamples: selected.length,
      passedSamples: selected.length,
      internalParseP50Milliseconds: percentile(values("internalParseMilliseconds"), 0.5),
      internalParseP95Milliseconds: percentile(values("internalParseMilliseconds"), 0.95),
      processWallP50Milliseconds: percentile(values("wallMilliseconds"), 0.5),
      processWallP95Milliseconds: percentile(values("wallMilliseconds"), 0.95),
      peakWorkingSetBytes: Math.max(...values("peakWorkingSetBytes")),
      peakPrivateMemoryBytes: Math.max(...values("peakPrivateMemoryBytes")),
    };
  });
  return {
    schemaVersion: 7,
    generatedAt: "2026-08-19T08:00:00.000Z",
    profile: "pre-gen-pure-parser-spike",
    scope: {
      databaseWritesAllowed: false,
      installAllowed: false,
      previewTokensAllowed: false,
      tauriCommandsRegistered: 0,
      pack001Implementation: false,
    },
    source: {
      gitCommit: "a".repeat(40),
      gitDirty: true,
      gitStatusSha256: "9".repeat(64),
    },
    bindings: Object.fromEntries(bindingKeys.map((key) => [key, BINDINGS[key]])),
    device: {
      windowsProductName: "Windows 11 Pro",
      windowsDisplayVersion: "25H2",
      windowsBuild: "26200.1",
      processorArchitecture: "AMD64",
      processorIdentifier: "Synthetic CPU",
      logicalProcessors: 24,
      powerLineStatus: "Online",
    },
    request: {
      smallCardCount: 4533,
      largeCardCount: 20000,
      smallSampleCount: small,
      largeSampleCount: large,
      baselineGateRequested: gate,
    },
    budgets: {
      maximumPackageBytes: 26214400,
      minimumNearLimitPackageBytes: 25900000,
      maximumCards: 20000,
      maximumJsonDepth: 8,
      progressCardInterval: 256,
      progressByteInterval: 4194304,
      progressValueInterval: 16384,
      controlDecodeByteInterval: 16384,
      controlItemByteInterval: 16384,
      maximumProgressCallbacks: 256,
    },
    fixtures,
    summaries,
    samples,
    isolation: {
      databaseFileCount: 0,
      allChildReportsDeclaredZeroDatabaseWrites: true,
    },
    baselineGate: {
      requested: gate,
      minimumSmallSamples: 10,
      minimumLargeSamples: 5,
      candidateLimits: { ...LIMITS },
      passed: gate ? true : null,
      failures: [],
    },
    ready: true,
    limitations: [...LIMITATIONS],
  };
}

test("accepts a source-bound formal pure parser matrix", () => {
  assert.deepEqual(validateLearningPackSpikeReport(makeReport(), BINDINGS), []);
});

test("accepts a clean smoke only when smoke is explicitly allowed", () => {
  const report = makeReport({ gate: false, small: 1, large: 1 });
  assert.deepEqual(validateLearningPackSpikeReport(report, BINDINGS, { requireGate: false }), []);
  assert.match(validateLearningPackSpikeReport(report, BINDINGS).join("\n"), /formal baseline/);
});

test("rejects stale source, binary, and fixture bindings", () => {
  const report = makeReport();
  report.bindings.binarySha256 = "Z".repeat(64);
  report.fixtures[0].sha256 = "Y".repeat(64);
  assert.match(validateLearningPackSpikeReport(report, BINDINGS).join("\n"), /binding|stale|changed/);
});

test("rejects optimistic raw samples and recomputes summaries", () => {
  const report = makeReport();
  report.samples[0].databaseWrites = 1;
  report.samples[1].internalParseMilliseconds += 500;
  assert.match(validateLearningPackSpikeReport(report, BINDINGS).join("\n"), /sample|summary/);
});

test("rejects fabricated or incomplete cooperative progress evidence", () => {
  const report = makeReport();
  report.samples[0].progressPhaseCounts.decoding = 0;
  report.samples[1].finalProgressUnit = "bytes";
  report.samples[2].controlDecodeByteInterval = 32768;
  report.samples[2].controlItemByteInterval = 32768;
  report.budgets.controlDecodeByteInterval = 32768;
  report.budgets.controlItemByteInterval = 32768;
  assert.match(validateLearningPackSpikeReport(report, BINDINGS).join("\n"), /sample|budget/);
});

test("rejects scope expansion, unknown fields, and a fake short gate", () => {
  const scope = makeReport();
  scope.scope.installAllowed = true;
  assert.match(validateLearningPackSpikeReport(scope, BINDINGS).join("\n"), /scope/);

  const extra = makeReport();
  extra.extra = true;
  assert.deepEqual(validateLearningPackSpikeReport(extra, BINDINGS), ["report schema is not exact"]);

  const short = makeReport({ gate: true, small: 1, large: 1 });
  assert.match(validateLearningPackSpikeReport(short, BINDINGS).join("\n"), /gate/);
});

test("parses PowerShell UTF-8 BOM output", () => {
  assert.equal(
    parseLearningPackSpikeEvidence(`\uFEFF${JSON.stringify(makeReport())}`).profile,
    "pre-gen-pure-parser-spike",
  );
});
