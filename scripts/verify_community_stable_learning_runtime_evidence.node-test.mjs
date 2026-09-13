import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  CommunityStableLearningEvidenceError,
  validateCommunityStableLearningEvidence,
} from "./verify_community_stable_learning_runtime_evidence.mjs";

const digest = "A".repeat(64);
const commit = "a".repeat(40);

function validInput() {
  return {
    envelope: {
      schemaVersion: 1,
      status: "passed",
      generatedAtUtc: "2026-08-27T08:00:00.000Z",
      productVersion: "1.5.4",
      buildVariant: "runtime-qa-learning",
      sourceCommit: commit,
      sourceDirty: false,
      sourceBindingSha256: digest,
      applicationSha256: digest,
      runtimeReportFile: "learning-scale-runtime-20260827T080000000Z.json",
      runtimeReportSha256: digest,
      formalUserDataUsed: false,
      formalUserDataChanged: false,
      formalHandleAuditPassed: true,
      externalFormalProcessObserved: false,
      controlledExit: true,
      cleanupVerified: true,
      privacy: "Synthetic aggregate evidence; no user content or user paths.",
    },
    runtime: {
      schemaVersion: 1,
      status: "passed",
      productVersion: "1.5.4",
      runtimeIdentifier: "com.yuanyuan.reminder.runtime-qa",
      tauriProcessId: 1234,
      syntheticDataOnly: true,
      tauriImportPassed: true,
      cancellationPassed: true,
      importedCards: 20_000,
      paginationPassed: true,
      answersApplied: 1_000,
      databaseGrowthWithinLimit: true,
      backupRestorePassed: true,
      sourceCsvSha256: digest,
      cancellationCheckCount: 1_024,
      databaseBytesAfterImport: 20_000_000,
      databaseBytesAfterAnswers: 25_000_000,
      answerGrowthBytes: 5_000_000,
      maximumDatabaseBytes: 128 * 1024 * 1024,
      maximumAnswerGrowthBytes: 32 * 1024 * 1024,
      restoredCardCount: 20_000,
      restoredReviewCount: 1_000,
      integrityCheck: "ok",
      foreignKeyViolationCount: 0,
      elapsedMilliseconds: 120_000,
      privacy: "Synthetic aggregate evidence; no user content or user paths.",
    },
    authority: { schemaVersion: 1, version: "1.5.4" },
    source: { commit, dirty: false },
    sourceBinding: {
      sha256: digest,
      commit,
      dirty: false,
      capturedAt: "2026-08-27T07:00:00.000Z",
      applicationSha256: digest,
    },
    applicationSha256: digest,
    runtimeReportSha256: digest,
    now: new Date("2026-08-27T09:00:00.000Z"),
  };
}

test("accepts exact clean 20000-card Tauri learning evidence", () => {
  assert.doesNotThrow(() => validateCommunityStableLearningEvidence(validInput()));
});

test("rejects every stable learning minimum when it is weakened", () => {
  const mutations = [
    (value) => { value.runtime.tauriImportPassed = false; },
    (value) => { value.runtime.cancellationPassed = false; },
    (value) => { value.runtime.importedCards = 19_999; },
    (value) => { value.runtime.paginationPassed = false; },
    (value) => { value.runtime.answersApplied = 999; },
    (value) => { value.runtime.databaseGrowthWithinLimit = false; },
    (value) => { value.runtime.backupRestorePassed = false; },
    (value) => { value.runtime.restoredReviewCount = 999; },
    (value) => { value.runtime.foreignKeyViolationCount = 1; },
    (value) => { value.envelope.cleanupVerified = false; },
    (value) => { value.envelope.formalHandleAuditPassed = false; },
  ];
  for (const mutate of mutations) {
    const input = validInput();
    mutate(input);
    assert.throws(
      () => validateCommunityStableLearningEvidence(input),
      CommunityStableLearningEvidenceError,
    );
  }
});

test("accepts unrelated formal-directory activity only with an external owner", () => {
  const input = validInput();
  input.envelope.formalUserDataChanged = true;
  assert.throws(
    () => validateCommunityStableLearningEvidence(input),
    CommunityStableLearningEvidenceError,
  );
  input.envelope.externalFormalProcessObserved = true;
  assert.doesNotThrow(() => validateCommunityStableLearningEvidence(input));
});

test("permits dirty evidence only when explicitly requested", () => {
  const input = validInput();
  input.envelope.sourceDirty = true;
  input.envelope.sourceBindingSha256 = null;
  input.source.dirty = true;
  input.sourceBinding = null;
  assert.throws(
    () => validateCommunityStableLearningEvidence(input),
    CommunityStableLearningEvidenceError,
  );
  input.allowDirty = true;
  assert.doesNotThrow(() => validateCommunityStableLearningEvidence(input));
});

test("rejects stale, mismatched, or missing formal source bindings", () => {
  const mutations = [
    (value) => { value.sourceBinding = null; },
    (value) => { value.envelope.sourceBindingSha256 = "B".repeat(64); },
    (value) => { value.sourceBinding.commit = "b".repeat(40); },
    (value) => { value.sourceBinding.applicationSha256 = "B".repeat(64); },
    (value) => { value.sourceBinding.dirty = true; },
    (value) => { value.sourceBinding.capturedAt = "2026-08-27T08:01:00.000Z"; },
  ];
  for (const mutate of mutations) {
    const input = validInput();
    mutate(input);
    assert.throws(
      () => validateCommunityStableLearningEvidence(input),
      CommunityStableLearningEvidenceError,
    );
  }
});

test("rejects unknown fields and digest mismatches", () => {
  const unknown = validInput();
  unknown.runtime.extra = true;
  assert.throws(
    () => validateCommunityStableLearningEvidence(unknown),
    CommunityStableLearningEvidenceError,
  );

  const mismatch = validInput();
  mismatch.runtimeReportSha256 = "B".repeat(64);
  assert.throws(
    () => validateCommunityStableLearningEvidence(mismatch),
    CommunityStableLearningEvidenceError,
  );
});

test("formal 20000-card execution validates the shared clean candidate before launch", async () => {
  const [measureScript, buildWrapper, packageJson] = await Promise.all([
    readFile(new URL("./measure_community_stable_learning_runtime.ps1", import.meta.url), "utf8"),
    readFile(new URL("./build_runtime_qa_learning_guarded.ps1", import.meta.url), "utf8"),
    readFile(new URL("../package.json", import.meta.url), "utf8").then(JSON.parse),
  ]);
  const bindingRequirementIndex = measureScript.indexOf("formal learning evidence requires -SourceBindingPath");
  const bindingVerifierIndex = measureScript.indexOf("verify_community_stable_runtime_source_binding.mjs");
  const launchIndex = measureScript.indexOf("Start-Process -FilePath $appPath");
  assert.ok(bindingRequirementIndex >= 0 && bindingVerifierIndex > bindingRequirementIndex && launchIndex > bindingVerifierIndex);
  assert.match(measureScript, /sourceBindingSha256 = \$sourceBindingSha256/u);
  assert.match(measureScript, /--binding", \$sourceBindingPath/u);
  assert.match(
    packageJson.scripts["release:community:learning:gate"],
    /measure_community_stable_learning_runtime\.ps1/u,
  );
  assert.match(
    packageJson.scripts["runtime:qa:learning:build"],
    /build_runtime_qa_learning_guarded\.ps1/u,
  );
  assert.ok(
    buildWrapper.indexOf("Assert-YuanyuanRuntimeQaExclusive") < buildWrapper.indexOf("& npm.cmd run unified:ui:build"),
  );
});
