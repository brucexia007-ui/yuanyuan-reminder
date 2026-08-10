import assert from "node:assert/strict";
import test from "node:test";

import { validatePidReuseEvidence } from "./verify_pid_reuse_qa_evidence.mjs";

const SOURCE_SHA256 = "A".repeat(64);

function validEvidence() {
  return {
    schemaVersion: 1,
    mode: "windows_pid_reuse_named_pipe_identity",
    generatedAtUtc: "2026-08-07T00:00:00Z",
    attestation: "isolated_windows_pid_reuse_stress_v1",
    identityImplementationSha256: SOURCE_SHA256,
    requestedIterations: 100,
    completedIterations: 50,
    distinctProcessIds: 49,
    samePidDifferentCreationTimeObserved: true,
    staleIdentityRejectedBeforePayloadRead: true,
    outcome: "passed",
    ready: true,
    elapsedMilliseconds: 1000,
  };
}

test("accepts only direct real PID reuse with stale-identity rejection", () => {
  assert.equal(validatePidReuseEvidence(validEvidence(), SOURCE_SHA256), true);
});

test("pending churn without PID reuse never becomes evidence", () => {
  const report = validEvidence();
  report.distinctProcessIds = report.completedIterations;
  report.samePidDifferentCreationTimeObserved = false;
  report.staleIdentityRejectedBeforePayloadRead = false;
  report.outcome = "pending_no_pid_reuse_observed";
  report.ready = false;
  assert.equal(validatePidReuseEvidence(report, SOURCE_SHA256), false);
});

test("source changes and optimistic flag edits fail closed", () => {
  assert.equal(validatePidReuseEvidence(validEvidence(), "B".repeat(64)), false);
  for (const key of [
    "samePidDifferentCreationTimeObserved",
    "staleIdentityRejectedBeforePayloadRead",
    "ready",
  ]) {
    const report = validEvidence();
    report[key] = false;
    assert.equal(validatePidReuseEvidence(report, SOURCE_SHA256), false);
  }
});

test("unknown fields and impossible counts are rejected", () => {
  const unknown = { ...validEvidence(), userName: "must-not-exist" };
  assert.equal(validatePidReuseEvidence(unknown, SOURCE_SHA256), false);
  const impossible = validEvidence();
  impossible.distinctProcessIds = impossible.completedIterations + 1;
  assert.equal(validatePidReuseEvidence(impossible, SOURCE_SHA256), false);
});
