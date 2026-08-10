import test from "node:test";
import assert from "node:assert/strict";

import {
  storePreSubmissionEvidenceRelativePath,
  StorePreSubmissionVerificationError,
  validateStorePreSubmissionAcceptance,
} from "./verify_msix_store_pre_submission.mjs";

const hash = "A".repeat(64);
const checks = [
  "trustedInstallAndLaunch",
  "trayPresence",
  "autostartAfterSignIn",
  "notificationDelivery",
  "singleInstance",
  "webView2Startup",
  "nsisToMsixMigration",
  "backupRestore",
  "updateForward",
  "uninstallKeepData",
  "uninstallDeleteData",
  "accessibility",
  "wackReportReview",
];

function evidenceArtifacts() {
  return Object.fromEntries(
    checks.map((name) => [
      storePreSubmissionEvidenceRelativePath(name),
      { format: "png", width: 1600, height: 900, sha256: hash },
    ]),
  );
}

function fixture() {
  return {
    schemaVersion: 1,
    status: "human_accepted_for_store_submission",
    candidate: {
      storeIdentitySha256: hash,
      storeSubmissionInputsSha256: hash,
      storeReleaseManifestSha256: hash,
      storeLicenseReviewPacketSha256: hash,
      storeLicenseReviewAcceptanceSha256: hash,
      storeDataLifecycleAcceptanceSha256: hash,
      storeDefenderReportSha256: hash,
      storeSecurityAcceptanceSha256: hash,
      privacyPolicySha256: hash,
      storeCandidateReportSha256: hash,
      unsignedStoreCandidateSha256: hash,
      disposableTestSignedPackageSha256: hash,
      runtimeReportSha256: hash,
      wackExecutionReportSha256: hash,
      wackRawReportSha256: hash,
    },
    environment: {
      tester: "Release Maintainer",
      testedAt: "2026-08-10T13:00:00.000Z",
      windowsVersion: "10.0.26100.1000",
      machineType: "clean_windows_11_vm_or_dedicated_machine",
    },
    checks: Object.fromEntries(
      checks.map((name) => [
        name,
        {
          status: "passed",
          evidencePath: storePreSubmissionEvidenceRelativePath(name),
          evidenceSha256: hash,
          redacted: true,
          notes: `Observed ${name} on the clean test machine.`,
        },
      ]),
    ),
    outcome: {
      blockingFindings: [],
      approvedBy: "Release Maintainer",
      approvedAt: "2026-08-10T14:00:00.000Z",
      preSubmissionAccepted: true,
      storeCertification: "pending",
    },
  };
}

function rejects(mutator, pattern) {
  const value = fixture();
  mutator(value);
  assert.throws(
    () => validate(value),
    (error) => error instanceof StorePreSubmissionVerificationError && pattern.test(error.message),
  );
}

function validate(value, artifacts = evidenceArtifacts()) {
  return validateStorePreSubmissionAcceptance(value, {
    now: new Date("2026-08-11T00:00:00.000Z"),
    evidenceArtifacts: artifacts,
  });
}

function rejectsWithEvidence(mutator, pattern) {
  const value = fixture();
  const artifacts = evidenceArtifacts();
  mutator(value, artifacts);
  assert.throws(
    () => validate(value, artifacts),
    (error) => error instanceof StorePreSubmissionVerificationError && pattern.test(error.message),
  );
}

test("accepts a complete human pre-submission matrix while Store certification stays pending", () => {
  const value = fixture();
  assert.equal(
    validate(value),
    value,
  );
});

test("rejects missing, unredacted, or hash-drifted evidence files", () => {
  rejectsWithEvidence((value, artifacts) => {
    delete artifacts[value.checks.trayPresence.evidencePath];
  }, /trayPresence evidence file/u);
  rejectsWithEvidence((value) => {
    value.checks.notificationDelivery.redacted = false;
  }, /notificationDelivery\.redacted/u);
  rejectsWithEvidence((value) => {
    value.checks.accessibility.evidenceSha256 = "B".repeat(64);
  }, /accessibility evidence file/u);
});

test("rejects pending, automated, or incomplete human evidence", () => {
  rejects((value) => {
    value.status = "pending";
  }, /human_accepted/);
  rejects((value) => {
    value.environment.tester = "Codex automation";
  }, /human/);
  rejects((value) => {
    value.checks.trayPresence.status = "pending";
  }, /trayPresence/);
});

test("rejects candidate drift and blocking findings", () => {
  rejects((value) => {
    value.candidate.runtimeReportSha256 = "not-a-hash";
  }, /SHA-256/);
  rejects((value) => {
    value.outcome.blockingFindings = ["Notification launch failed"];
  }, /must be empty/);
});

test("rejects claims that Partner Center certification already passed", () => {
  rejects((value) => {
    value.outcome.storeCertification = "passed";
  }, /must remain pending/);
});
