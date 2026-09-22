import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

import {
  COMMUNITY_STABLE_PROMOTION_PATHS,
  validateCommunityStableAcceptance,
} from "./community_stable_acceptance_contract.mjs";
import { communityProductFromBrand } from "./community_release_contract.mjs";

const projectRoot = path.resolve(import.meta.dirname, "..");
const brand = JSON.parse(await readFile(path.join(projectRoot, "product-brand.json"), "utf8"));
const expectedProduct = communityProductFromBrand(brand);
const authorizationRecordSha256 = createHash("sha256").update(
  await readFile(path.join(projectRoot, "docs/release/COMMUNITY_STABLE_V2_WAIVER_DECISION.md")),
).digest("hex").toUpperCase();
const authority = {
  schemaVersion: 1,
  productName: expectedProduct.name,
  identifier: expectedProduct.identifier,
  version: "1.5.2",
  releaseTrain: "unified-product",
  channel: "stable",
};
const installerSha256 = "A".repeat(64);
const acceptance = {
  schemaVersion: 2,
  status: "accepted",
  product: {
    name: expectedProduct.name,
    identifier: expectedProduct.identifier,
    version: "1.5.2",
  },
  candidate: {
    testedCommit: "a".repeat(40),
    installerSha256,
  },
  checks: {
    endurance24h: {
      status: "passed_with_waivers",
      reportSha256: "B".repeat(64),
      sourceBindingSha256: "9".repeat(64),
      observedSeconds: 86_401,
      activeCoverageSeconds: 72_001,
      suspendResumeObserved: false,
      lockUnlockObserved: false,
      controlledExit: true,
      applicationErrorCount: 0,
      formalUserFilesWritten: 0,
      rawReportPassed: false,
      rawFailureCodes: ["power_suspend_resume_pair_missing", "session_lock_unlock_pair_missing"],
    },
    installedCandidateE2e: {
      status: "passed",
      reportSha256: "C".repeat(64),
      installerSha256,
      scenarios: {
        installAndLaunch: true,
        snoozeThirtyMinutes: true,
        missedReminderNotify: true,
        missedReminderSkipOld: true,
        reminderDelivery: true,
        hideAndRestorePet: true,
        panelDrag: true,
        automaticBackup: true,
        backupAndRestore: true,
        restartPersistence: true,
        uninstallKeepsDataByDefault: true,
      },
      formalUserDataUsed: false,
      cleanupVerified: true,
    },
    legacyDataCompatibility: {
      status: "waived_with_substitutes",
      sourceVersion: "1.3.2",
      realHistoricalDataVerified: false,
      officialBinarySha256: "D".repeat(64),
      syntheticMigrationReportSha256: "E".repeat(64),
      v1527UpgradeRollbackReportSha256: "1".repeat(64),
      syntheticRowsPreserved: true,
      syntheticBackupRestorePassed: true,
      syntheticFailureRollbackPassed: true,
      v1527UpgradeRollbackPassed: true,
    },
    learningRuntime: {
      status: "passed",
      reportSha256: "F".repeat(64),
      sourceBindingSha256: "9".repeat(64),
      tauriImportPassed: true,
      cancellationPassed: true,
      importedCards: 20_000,
      paginationPassed: true,
      answersApplied: 1_000,
      databaseGrowthWithinLimit: true,
      backupRestorePassed: true,
    },
  },
  waivers: {
    authorizationRecordSha256,
    candidateCommit: "a".repeat(40),
    ids: ["power_suspend_resume_pair_missing", "session_lock_unlock_pair_missing", "real_1_3_2_user_history_unavailable"],
    evidenceSha256: { endurance: "B".repeat(64), synthetic132: "E".repeat(64), upgrade1527: "1".repeat(64) },
  },
  review: {
    operator: "maintainer-chen",
    completedAt: "2026-08-27T03:00:00.000Z",
    permissionSha256: "4".repeat(64),
    unresolvedFindings: [],
  },
};
const options = {
  authority,
  expectedProduct,
  releaseCommit: "b".repeat(40),
  changedPaths: COMMUNITY_STABLE_PROMOTION_PATHS,
  now: new Date("2026-08-27T04:00:00.000Z"),
};

test("accepts exact V2 waivers with complete substitute evidence", () => {
  assert.equal(validateCommunityStableAcceptance(acceptance, options), acceptance);
  assert.doesNotMatch(JSON.stringify(acceptance), /sign|certificate|publisher/iu);
});

test("final acceptance rejects cross-candidate 24-hour and learning evidence", () => {
  const invalid = structuredClone(acceptance);
  invalid.checks.learningRuntime.sourceBindingSha256 = "8".repeat(64);
  assert.throws(
    () => validateCommunityStableAcceptance(invalid, options),
    /different source bindings/u,
  );
});

test("rejects every missing core product acceptance result", () => {
  const mutations = [
    (value) => (value.checks.endurance24h.observedSeconds = 86_399),
    (value) => (value.checks.endurance24h.suspendResumeObserved = true),
    (value) => (value.checks.installedCandidateE2e.scenarios.snoozeThirtyMinutes = false),
    (value) => (value.checks.installedCandidateE2e.scenarios.missedReminderNotify = false),
    (value) => (value.checks.installedCandidateE2e.scenarios.missedReminderSkipOld = false),
    (value) => (value.checks.installedCandidateE2e.scenarios.hideAndRestorePet = false),
    (value) => (value.checks.installedCandidateE2e.scenarios.panelDrag = false),
    (value) => (value.checks.installedCandidateE2e.scenarios.automaticBackup = false),
    (value) => (value.checks.legacyDataCompatibility.syntheticRowsPreserved = false),
    (value) => (value.checks.learningRuntime.importedCards = 19_999),
    (value) => (value.checks.learningRuntime.answersApplied = 999),
  ];
  for (const mutate of mutations) {
    const invalid = structuredClone(acceptance);
    mutate(invalid);
    assert.throws(
      () => validateCommunityStableAcceptance(invalid, options),
      /pending|passed|minimum|preservation|observation|unobserved|event/u,
    );
  }
});

test("rejects forged raw pass, broad waiver, missing authorization, evidence mismatch, and candidate drift", () => {
  const mutations = [
    (value) => { value.checks.endurance24h.rawReportPassed = true; },
    (value) => { value.checks.endurance24h.rawFailureCodes.push("working_set_slope_limit_exceeded"); },
    (value) => { value.waivers.ids.push("arbitrary_waiver"); },
    (value) => { value.waivers.authorizationRecordSha256 = null; },
    (value) => { value.waivers.evidenceSha256.endurance = "3".repeat(64); },
    (value) => { value.waivers.candidateCommit = "c".repeat(40); },
    (value) => { value.checks.legacyDataCompatibility.realHistoricalDataVerified = true; },
  ];
  for (const mutate of mutations) {
    const invalid = structuredClone(acceptance);
    mutate(invalid);
    assert.throws(() => validateCommunityStableAcceptance(invalid, options));
  }
});

test("rejects source drift, automated approval, unresolved findings, and version drift", () => {
  assert.throws(
    () =>
      validateCommunityStableAcceptance(acceptance, {
        ...options,
        changedPaths: [...COMMUNITY_STABLE_PROMOTION_PATHS, "src/pet/PetWindow.tsx"],
      }),
    /changed beyond/u,
  );
  const automated = structuredClone(acceptance);
  automated.review.operator = "Codex Bot";
  assert.throws(
    () => validateCommunityStableAcceptance(automated, options),
    /non-automated/u,
  );
  const unresolved = structuredClone(acceptance);
  unresolved.review.unresolvedFindings.push("panel drag occasionally fails");
  assert.throws(
    () => validateCommunityStableAcceptance(unresolved, options),
    /unresolved findings/u,
  );
  const wrongVersion = structuredClone(acceptance);
  wrongVersion.product.version = "1.5.1";
  assert.throws(
    () => validateCommunityStableAcceptance(wrongVersion, options),
    /product identity/u,
  );
});

test("keeps the checked-in acceptance template pending and non-optimistic", async () => {
  const template = JSON.parse(
    await readFile(
      path.join(
        projectRoot,
        "docs",
        "release",
        "COMMUNITY_STABLE_ACCEPTANCE_V2.template.json",
      ),
      "utf8",
    ),
  );
  assert.equal(template.status, "pending");
  assert.equal(template.checks.endurance24h.status, "pending");
  assert.equal(template.checks.installedCandidateE2e.formalUserDataUsed, null);
  assert.throws(
    () => validateCommunityStableAcceptance(template, options),
    /not been completed/u,
  );
});
