import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import {
  parseRustParallelStabilityEvidence,
  validateRustParallelStabilityReport,
} from "./verify_rust_parallel_stability_evidence.mjs";

const HASH = "A".repeat(64);
const EMPTY_SHA256 = createHash("sha256").update("").digest("hex").toUpperCase();
const LIMITATIONS = [
  "The scan exercises one Windows test process per round with 24 Rust test threads.",
  "The process-wide lock serializes WinVerifyTrust provider-state lifecycles and bounded MZ/e_lfanew/PE-signature preflight rejects non-PE files before WinVerifyTrust; the exact native fault instruction and module remain unknown because no crash dump or WER record was captured.",
  "Passing rounds demonstrate repeatability on this device and source state, not a proof that Windows native APIs can never fail.",
  "The supervisor unhealthy-child fixture uses a single PowerShell process so test cleanup does not leave a 30-second descendant.",
];

function sha256(value) {
  return createHash("sha256").update(value).digest("hex").toUpperCase();
}

function percentile(values, fraction) {
  const ordered = [...values].sort((left, right) => left - right);
  return Number(ordered[Math.max(0, Math.ceil(fraction * ordered.length) - 1)].toFixed(3));
}

function makeSample(profile, round) {
  const passed = profile === "default" ? 213 : 271;
  const harnessSeconds = profile === "default" ? 1.5 : 1.8;
  const resultLine = `test result: ok. ${passed} passed; 0 failed; 1 ignored; 0 measured; 0 filtered out; finished in ${harnessSeconds}s`;
  return {
    profile,
    round,
    exitCode: 0,
    wallMilliseconds: harnessSeconds * 1000 + round,
    harnessSeconds,
    status: "ok",
    passed,
    failed: 0,
    ignored: 1,
    measured: 0,
    filteredOut: 0,
    resultLine,
    resultLineSha256: sha256(resultLine),
    stderrSha256: EMPTY_SHA256,
  };
}

function makeSummary(samples) {
  const walls = samples.map((sample) => sample.wallMilliseconds);
  return {
    rounds: samples.length,
    failures: 0,
    consistentCounts: true,
    passedPerRound: samples[0].passed,
    ignoredPerRound: samples[0].ignored,
    measuredPerRound: samples[0].measured,
    filteredOutPerRound: samples[0].filteredOut,
    minimumWallMilliseconds: Math.min(...walls),
    p50WallMilliseconds: percentile(walls, 0.5),
    p95WallMilliseconds: percentile(walls, 0.95),
    maximumWallMilliseconds: Math.max(...walls),
  };
}

function makeBindings() {
  return {
    measurementScriptSha256: HASH,
    verifierSha256: HASH,
    windowsArtifactTrustSourceSha256: HASH,
    connectorToolTrustSourceSha256: HASH,
    connectorDiscoverySourceSha256: HASH,
    aiSupervisorSourceSha256: HASH,
    cargoLockSha256: HASH,
    defaultTestExecutablePath:
      "src-tauri/target/debug/deps/yuanyuan_reminder_lib-0123456789abcdef.exe",
    defaultTestExecutableSha256: HASH,
    learningTestExecutablePath:
      "src-tauri/target/debug/deps/yuanyuan_reminder_lib-fedcba9876543210.exe",
    learningTestExecutableSha256: HASH,
  };
}

function makeReport({ defaultRounds = 20, learningRounds = 10, baselineGate = true } = {}) {
  const defaultSamples = Array.from({ length: defaultRounds }, (_, index) =>
    makeSample("default", index + 1),
  );
  const learningSamples = Array.from({ length: learningRounds }, (_, index) =>
    makeSample("learning", index + 1),
  );
  const formalGate = baselineGate && defaultRounds >= 20 && learningRounds >= 10;
  return {
    schemaVersion: 1,
    generatedAt: "2026-08-21T15:45:00.000Z",
    profile: "rust-parallel-stability",
    bindings: makeBindings(),
    device: {
      windowsVersion: "Microsoft Windows NT 10.0.26200.0",
      processArchitecture: "X64",
      logicalProcessors: 24,
    },
    request: { defaultRounds, learningRounds, testThreads: 24, baselineGate },
    gate: {
      requiredDefaultRounds: 20,
      requiredLearningRounds: 10,
      requiredTestThreads: 24,
      maximumP95Milliseconds: 10000,
      formalGate,
      outcomesPassed: true,
    },
    samples: [...defaultSamples, ...learningSamples],
    summary: {
      default: makeSummary(defaultSamples),
      learning: makeSummary(learningSamples),
    },
    ready: formalGate,
    limitations: LIMITATIONS,
    failure: null,
  };
}

test("accepts a source-bound 20 plus 10 round formal gate", () => {
  const report = makeReport();
  assert.deepEqual(validateRustParallelStabilityReport(report, makeBindings()), []);
});

test("accepts a clean smoke only when a formal gate is not required", () => {
  const report = makeReport({ defaultRounds: 2, learningRounds: 1, baselineGate: false });
  assert.deepEqual(
    validateRustParallelStabilityReport(report, makeBindings(), { requireGate: false }),
    [],
  );
  assert.match(validateRustParallelStabilityReport(report, makeBindings()).join("\n"), /formal/);
});

test("rejects stale source or executable bindings", () => {
  const report = makeReport();
  report.bindings.windowsArtifactTrustSourceSha256 = "B".repeat(64);
  report.bindings.defaultTestExecutablePath = "outside.exe";
  assert.match(
    validateRustParallelStabilityReport(report, makeBindings()).join("\n"),
    /stale|outside/,
  );
});

test("rejects a crash, forged result line, or nonempty stderr", () => {
  const report = makeReport();
  report.samples[0].exitCode = -1073741819;
  report.samples[1].resultLine = report.samples[1].resultLine.replace("ok", "FAILED");
  report.samples[2].stderrSha256 = HASH;
  assert.match(
    validateRustParallelStabilityReport(report, makeBindings()).join("\n"),
    /sample|outcome|readiness/,
  );
});

test("rejects summaries or readiness not recomputed from samples", () => {
  const report = makeReport();
  report.summary.default.p95WallMilliseconds += 100;
  report.gate.outcomesPassed = false;
  report.ready = false;
  assert.match(
    validateRustParallelStabilityReport(report, makeBindings()).join("\n"),
    /summary|outcome|readiness/,
  );
});

test("rejects a short fake gate, changed limitations, and unknown fields", () => {
  const report = makeReport({ defaultRounds: 2, learningRounds: 1 });
  report.limitations = [];
  assert.match(
    validateRustParallelStabilityReport(report, makeBindings()).join("\n"),
    /formal|limitations|baseline/,
  );

  const extra = makeReport();
  extra.extra = true;
  assert.deepEqual(validateRustParallelStabilityReport(extra, makeBindings()), [
    "report schema is not exact",
  ]);
});

test("parses PowerShell UTF-8 BOM output", () => {
  assert.equal(
    parseRustParallelStabilityEvidence(`\uFEFF${JSON.stringify(makeReport())}`).profile,
    "rust-parallel-stability",
  );
});
