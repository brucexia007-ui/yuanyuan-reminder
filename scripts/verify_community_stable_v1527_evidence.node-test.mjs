import assert from "node:assert/strict";
import test from "node:test";
import { validateV1527UpgradeReport } from "./verify_community_stable_v1527_evidence.mjs";

const sha = "A".repeat(64);
const testedCommit = "b".repeat(40);
const installerSha256 = "C".repeat(64);
const bindings = {
  installerSha256: "424E2D607E08CA274672DFF343D12393DE3CF9C4FBC7BA3789FC7A8ACFFF4C7E",
  fullBaselineHashes: Object.fromEntries(Array.from({ length: 218 }, (_, index) => [`file-${index}`, sha])),
};
const report = {
  schemaVersion: 1, status: "passed", candidateCommit: testedCommit, candidateInstallerSha256: installerSha256,
  baselineInstallerSha256: bindings.installerSha256, baselineFileCount: 218,
  databaseMigration7to8Passed: true, oldRowsAndSettingsPreserved: true,
  petPackRecoveryPassed: true, rollbackBothDatabasesIntegrityPassed: true,
  rollbackVisibleStatePassed: true, syntheticDataOnly: true,
  actualInstallersUsed: true, olderProgramRestored: true, completePreUpgradeDataRestored: true,
  evidenceFiles: ["guestLog", "upgradeScreenshot", "rollbackScreenshot", "databaseAudit"]
    .map((id) => ({ id, file: `${id}.txt`, sha256: sha })),
};
const options = { testedCommit, installerSha256, bindings };

test("requires actual 1.5.27 installer, complete baseline, both databases and paired rollback", () => {
  assert.equal(validateV1527UpgradeReport(report, options), report);
  for (const mutate of [
    (value) => { value.candidateCommit = "d".repeat(40); },
    (value) => { value.baselineFileCount = 217; },
    (value) => { value.rollbackBothDatabasesIntegrityPassed = false; },
    (value) => { value.actualInstallersUsed = false; },
    (value) => { value.completePreUpgradeDataRestored = false; },
    (value) => { value.evidenceFiles[2].sha256 = "wrong"; },
  ]) {
    const invalid = structuredClone(report);
    mutate(invalid);
    assert.throws(() => validateV1527UpgradeReport(invalid, options));
  }
});
