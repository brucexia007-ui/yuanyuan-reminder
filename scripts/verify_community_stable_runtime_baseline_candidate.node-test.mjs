import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  validateV2RuntimeWaiver,
  validateRuntimeBaselineCandidateManifest,
  validateRuntimeBaselineSourceBindingManifest,
} from "./verify_community_stable_runtime_baseline_candidate.mjs";

test("V2 runtime waiver accepts only a failed raw gate with exact event failures and full duration", () => {
  const report = {
    request: { acceptanceGateRequested: true },
    smokePassed: true,
    ready: false,
    acceptanceGate: { passed: false, failures: ["power_suspend_resume_pair_missing", "session_lock_unlock_pair_missing"] },
    transitions: { powerSuspendResumeObserved: false, sessionLockUnlockObserved: false },
    clock: { wallClockObservedSeconds: 86_400, activeSampleCoverageSeconds: 72_000 },
    isolation: { applicationErrorCount: 0 },
    storage: { formalUserFilesWritten: 0 },
  };
  assert.equal(validateV2RuntimeWaiver(report), true);
  for (const mutate of [
    (value) => { value.acceptanceGate.passed = true; },
    (value) => { value.ready = true; },
    (value) => { value.acceptanceGate.failures.push("cpu_limit_exceeded"); },
    (value) => { value.clock.activeSampleCoverageSeconds = 71_999; },
    (value) => { value.isolation.applicationErrorCount = 1; },
  ]) {
    const invalid = structuredClone(report);
    mutate(invalid);
    assert.throws(() => validateV2RuntimeWaiver(invalid));
  }
});

const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex").toUpperCase();
const testedCommit = "a".repeat(40);
const configurationPaths = [
  "product-version.json",
  "product-brand.json",
  "package.json",
  "package-lock.json",
  "src-tauri/Cargo.toml",
  "src-tauri/Cargo.lock",
  "src-tauri/tauri.conf.json",
];
const artifactPaths = {
  application: "src-tauri/target/runtime-qa-learning/release/yuanyuan-reminder.exe",
  fixture: "src-tauri/target/runtime-qa-learning/release/yuanyuan-runtime-qa-fixture.exe",
  measureScript: "scripts/measure_runtime_baseline.ps1",
};
const toolPaths = {
  buildScript: "scripts/build_community_stable_runtime_baseline_candidate.ps1",
  runScript: "scripts/run_community_stable_runtime_baseline.ps1",
  exclusivityScript: "scripts/assert_runtime_qa_exclusive.ps1",
  prepareScript: "scripts/prepare_community_stable_runtime_baseline_candidate.mjs",
  verifyScript: "scripts/verify_community_stable_runtime_baseline_candidate.mjs",
  sourceBindingVerifyScript: "scripts/verify_community_stable_runtime_source_binding.mjs",
};

function fixture() {
  const observedConfiguration = Object.fromEntries(
    configurationPaths.map((relativePath) => [relativePath, { bytes: Buffer.from(`config:${relativePath}`) }]),
  );
  const observedArtifacts = Object.fromEntries(
    Object.entries(artifactPaths).map(([key, relativePath]) => [key, { bytes: Buffer.from(`artifact:${relativePath}`) }]),
  );
  const observedTools = Object.fromEntries(
    Object.entries(toolPaths).map(([key, relativePath]) => [key, { bytes: Buffer.from(`tool:${relativePath}`) }]),
  );
  const fileBinding = (relativePath, observed) => ({
    path: relativePath,
    bytes: observed.bytes.length,
    sha256: sha256(observed.bytes),
  });
  const binding = {
    schemaVersion: 1,
    capturedAt: "2026-08-29T06:00:00.000Z",
    buildStartedAt: "2026-08-29T05:50:00.000Z",
    buildVariant: "runtime-qa-learning",
    source: { commit: testedCommit, branch: "feat/unified-v1-5", dirty: false },
    product: {
      name: "饺饺提醒",
      identifier: "com.brucexia.jiaojiao.reminder",
      version: "1.5.7",
    },
    configuration: Object.fromEntries(
      configurationPaths.map((relativePath) => [relativePath, sha256(observedConfiguration[relativePath].bytes)]),
    ),
    artifacts: Object.fromEntries(
      Object.entries(artifactPaths).map(([key, relativePath]) => [key, fileBinding(relativePath, observedArtifacts[key])]),
    ),
    tools: Object.fromEntries(
      Object.entries(toolPaths).map(([key, relativePath]) => [key, fileBinding(relativePath, observedTools[key])]),
    ),
  };
  return {
    binding,
    testedCommit,
    currentSource: structuredClone(binding.source),
    authority: {
      productName: binding.product.name,
      identifier: binding.product.identifier,
      version: binding.product.version,
    },
    brand: {
      application: {
        displayName: binding.product.name,
        identifier: binding.product.identifier,
      },
    },
    observedConfiguration,
    observedArtifacts,
    observedTools,
    report: {
      clock: { launchUtc: "2026-08-29T06:01:00.000Z" },
      bindings: {
        applicationSha256: binding.artifacts.application.sha256,
        fixtureSha256: binding.artifacts.fixture.sha256,
        scriptSha256: binding.artifacts.measureScript.sha256,
      },
    },
  };
}

test("accepts one clean tested commit bound to the integrated learning runtime", () => {
  const value = fixture();
  assert.equal(validateRuntimeBaselineCandidateManifest(value), value.binding);
  for (const source of [
    readFileSync(new URL("./prepare_community_stable_runtime_baseline_candidate.mjs", import.meta.url), "utf8"),
    readFileSync(new URL("./verify_community_stable_runtime_baseline_candidate.mjs", import.meta.url), "utf8"),
  ]) {
    assert.match(
      source,
      /sourceBindingVerifyScript: "scripts\/verify_community_stable_runtime_source_binding\.mjs"/u,
    );
  }
});

test("the same clean candidate binding can authorize a later 20000-card run", () => {
  const { report: _report, ...sourceBinding } = fixture();
  assert.equal(validateRuntimeBaselineSourceBindingManifest(sourceBinding), sourceBinding.binding);
});

test("rejects learning-off, cross-commit, tool drift, and a report started before binding", () => {
  const learningOff = fixture();
  learningOff.binding.buildVariant = "runtime-qa";
  assert.throws(() => validateRuntimeBaselineCandidateManifest(learningOff), /integrated learning/u);

  const crossCommit = fixture();
  crossCommit.binding.source.commit = "b".repeat(40);
  assert.throws(() => validateRuntimeBaselineCandidateManifest(crossCommit), /testedCommit/u);

  const toolDrift = fixture();
  toolDrift.observedTools.sourceBindingVerifyScript.bytes = Buffer.from("changed source binding verifier");
  assert.throws(() => validateRuntimeBaselineCandidateManifest(toolDrift), /size changed|SHA-256 changed/u);

  const earlyReport = fixture();
  earlyReport.report.clock.launchUtc = "2026-08-29T05:59:59.000Z";
  assert.throws(() => validateRuntimeBaselineCandidateManifest(earlyReport), /started before/u);
});
