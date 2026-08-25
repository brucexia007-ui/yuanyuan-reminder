import assert from "node:assert/strict";
import test from "node:test";

import { validateStartupMatrixReport } from "./verify_startup_matrix_evidence.mjs";

const APP = "A".repeat(64);
const FIXTURE = "B".repeat(64);
const SCRIPT = "C".repeat(64);
const DATABASE = "D".repeat(64);
const EMPTY_DATABASE = "E".repeat(64);
const bindings = { applicationSha256: APP, fixtureSha256: FIXTURE, scriptSha256: SCRIPT };
const limitations = [
  "The application and fixture are isolated runtime-QA builds, not signed production candidates.",
  "Cold mode uses a new application and WebView data root for every sample.",
  "Warm mode performs one uncounted initialization launch and reuses its isolated data root.",
  "Startup ends at the first visible application-owned top-level window.",
  "The exact QA root process is terminated after the timing target; controlled-exit behavior is covered by separate runtime evidence.",
  "This does not replace clean-machine, signed-candidate, security-software, or multi-DPI evidence.",
];

function makeReport(mode = "cold", count = 20, gate = true) {
  const samples = Array.from({ length: count }, (_, index) => ({
    sample: index + 1,
    startupToVisibleWindowMilliseconds: 100 + index,
    terminatedAfterTarget: true,
    passed: true,
    failure: null,
    inputDatabase: mode === "cold"
      ? { sha256: EMPTY_DATABASE, fileCount: 0, bytes: 0 }
      : { sha256: DATABASE, fileCount: 3, bytes: 1000 + index },
    outputDatabase: { sha256: DATABASE, fileCount: 3, bytes: 1200 + index },
    rootRemoved: mode === "cold" ? true : null,
  }));
  return {
    schemaVersion: 1,
    generatedAt: "2026-08-14T18:00:00.000Z",
    profile: "startup-matrix",
    buildVariant: "learning-off",
    startupMode: mode,
    requestedSamples: count,
    passedSamples: count,
    ready: true,
    bindings: { applicationSha256: APP, fixtureSha256: FIXTURE, scriptSha256: SCRIPT },
    device: {
      windowsProductName: "Windows",
      windowsDisplayVersion: "25H2",
      windowsBuild: "26200.1",
      processorArchitecture: "AMD64",
      logicalProcessors: 24,
      powerLineStatus: "Online",
      webView2RuntimeVersion: "151.0.0.0",
    },
    baselineGate: {
      requested: gate,
      minimumSamples: 20,
      passed: gate ? true : null,
      failures: [],
    },
    summary: {
      startupP50Ms: count === 20 ? 109 : 100,
      startupP95Ms: count === 20 ? 118 : 100,
    },
    cleanup: { rootRemoved: true },
    samples,
    limitations,
  };
}

test("accepts cold and warm 20-sample matrices", () => {
  assert.deepEqual(validateStartupMatrixReport(makeReport("cold"), bindings), []);
  assert.deepEqual(validateStartupMatrixReport(makeReport("warm"), bindings), []);
});

test("accepts a single clean smoke without promoting it to a gate", () => {
  assert.deepEqual(validateStartupMatrixReport(makeReport("cold", 1, false), bindings), []);
});

test("rejects stale bindings and incomplete device evidence", () => {
  const report = makeReport();
  report.bindings.scriptSha256 = "F".repeat(64);
  report.device.webView2RuntimeVersion = "";
  assert.match(validateStartupMatrixReport(report, bindings).join("\n"), /stale|device/);
});

test("rejects optimistic samples, wrong database state, and altered percentiles", () => {
  const report = makeReport();
  report.samples[0].terminatedAfterTarget = false;
  report.samples[1].inputDatabase.fileCount = 1;
  report.samples[2].startupToVisibleWindowMilliseconds += 5000;
  assert.match(
    validateStartupMatrixReport(report, bindings).join("\n"),
    /sample|optimistic|percentile|gate/,
  );
});

test("rejects unknown fields and a fake short formal gate", () => {
  const report = makeReport();
  report.extra = true;
  assert.deepEqual(validateStartupMatrixReport(report, bindings), ["report schema is not exact"]);

  const short = makeReport("cold", 1, false);
  short.baselineGate.requested = true;
  short.baselineGate.passed = true;
  assert.match(validateStartupMatrixReport(short, bindings).join("\n"), /baseline gate/);
});
