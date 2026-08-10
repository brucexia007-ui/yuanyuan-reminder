import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import {
  defaultStoreIdentityPath,
  readAndValidateStoreIdentity,
} from "./verify_msix_store_identity.mjs";
import { storePreSubmissionEvidenceRelativePath } from "./verify_msix_store_pre_submission.mjs";
import { inspectPng } from "./verify_msix_store_submission_inputs.mjs";
import {
  STORE_DATA_CAPTURE_REPORTS,
  validateStoreDataCaptureIndex,
} from "./msix_store_data_lifecycle_capture_contract.mjs";
import { readAndValidateUnsignedBetaGithubReport } from "./verify_unsigned_beta_github_release.mjs";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const storeTargetRoot = path.join(projectRoot, "src-tauri", "target", "msix-store");
const dataCaptureRoot = path.join(
  projectRoot,
  "src-tauri",
  "target",
  "msix-store-data-lifecycle",
);
const acceptancePath = path.join(
  projectRoot,
  "docs",
  "release",
  "MSIX_STORE_DATA_LIFECYCLE_ACCEPTANCE_V1.json",
);
const storeReleaseManifestPath = path.join(storeTargetRoot, "msix-store-release-manifest.json");
const runtimeReportPath = path.join(
  projectRoot,
  "src-tauri",
  "target",
  "msix-store-runtime",
  "msix-store-runtime-report.json",
);
const releasePolicyPath = path.join(projectRoot, "docs", "release", "RELEASE_POLICY_V1.json");
const releaseManifestVerifierPath = path.join(
  projectRoot,
  "scripts",
  "generate_msix_store_release_manifest.mjs",
);
const runtimeVerifierPath = path.join(projectRoot, "scripts", "verify_msix_store_runtime.mjs");
const verifierPath = fileURLToPath(import.meta.url);

export const STORE_DATA_LIFECYCLE_ATTESTATION_TEXT =
  "I attest that the named human tester completed the exact-candidate Microsoft Store data lifecycle scenarios using synthetic data only, verified NSIS-to-MSIX continuity, backup restore, a higher-version MSIX update, uninstall data preservation, and explicit in-app deletion before uninstall, and omitted no unresolved result.";

export const STORE_DATA_LIFECYCLE_SCENARIOS = [
  "nsisToMsixMigration",
  "backupRestore",
  "updateForward",
  "uninstallKeepData",
  "uninstallDeleteData",
];

export class StoreDataLifecycleVerificationError extends Error {}

function fail(message) {
  throw new StoreDataLifecycleVerificationError(message);
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex").toUpperCase();
}

function exact(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

function exactKeys(value, keys, label) {
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    !exact(Object.keys(value).sort(), [...keys].sort())
  ) {
    fail(`${label} fields do not match the Store data-lifecycle contract`);
  }
}

function canonicalHash(value, label) {
  if (typeof value !== "string" || !/^[A-F0-9]{64}$/u.test(value)) {
    fail(`${label} must be an uppercase SHA-256 digest`);
  }
}

function validText(value, label, minimum = 2, maximum = 300) {
  if (
    typeof value !== "string" ||
    value !== value.trim() ||
    value.length < minimum ||
    value.length > maximum ||
    /[\u0000-\u001F\u007F]/u.test(value)
  ) {
    fail(`${label} must be a final, trimmed value`);
  }
}

function humanName(value, label) {
  validText(value, label, 2, 128);
  if (/(?:\bcodex\b|\bchatgpt\b|\bai\b|\bbot\b|automated|automation|人工智能|自动化|机器人)/iu.test(value)) {
    fail(`${label} must identify a human`);
  }
}

function validTimestamp(value, label, now) {
  if (typeof value !== "string") fail(`${label} must be an ISO timestamp`);
  const parsed = Date.parse(value);
  if (
    !Number.isFinite(parsed) ||
    parsed < Date.parse("2026-08-10T00:00:00.000Z") ||
    parsed > now.getTime() + 5 * 60 * 1000
  ) {
    fail(`${label} must be a valid, non-future ISO timestamp`);
  }
  return parsed;
}

function validCounts(value, label) {
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.keys(value).length === 0 ||
    Object.keys(value).length > 32 ||
    !Object.entries(value).every(
      ([name, count]) =>
        /^[a-z][a-z0-9_]{0,63}$/u.test(name) && Number.isInteger(count) && count >= 0,
    ) ||
    !exact(Object.keys(value), Object.keys(value).sort((left, right) => left.localeCompare(right, "en")))
  ) {
    fail(`${label} must contain sorted, aggregate non-negative record counts`);
  }
}

function versionParts(value, label) {
  if (typeof value !== "string" || !/^\d{1,5}(?:\.\d{1,5}){3}$/u.test(value)) {
    fail(`${label} must be a four-part MSIX version`);
  }
  const parts = value.split(".").map(Number);
  if (parts.some((part) => part > 65535)) fail(`${label} contains an out-of-range version part`);
  return parts;
}

function laterStoreVersion(fromVersion, toVersion) {
  const from = versionParts(fromVersion, "scenarios.updateForward.fromVersion");
  const to = versionParts(toVersion, "scenarios.updateForward.toVersion");
  if (to[3] !== 0) fail("scenarios.updateForward.toVersion fourth part must remain 0");
  for (let index = 0; index < 4; index += 1) {
    if (to[index] > from[index]) return true;
    if (to[index] < from[index]) return false;
  }
  return false;
}

function validateEvidence(scenario, scenarioName, evidenceArtifacts) {
  const expectedPath = storePreSubmissionEvidenceRelativePath(scenarioName);
  if (scenario.evidencePath !== expectedPath) {
    fail(`scenarios.${scenarioName}.evidencePath must use the fixed pre-submission evidence path`);
  }
  canonicalHash(scenario.evidenceSha256, `scenarios.${scenarioName}.evidenceSha256`);
  if (scenario.redacted !== true) fail(`scenarios.${scenarioName}.redacted must be true`);
  validText(scenario.notes, `scenarios.${scenarioName}.notes`, 10, 1000);
  if (scenario.passed !== true) fail(`scenarios.${scenarioName}.passed must be true`);
  const artifact = evidenceArtifacts?.[expectedPath];
  if (
    !artifact ||
    artifact.format !== "png" ||
    artifact.width < 320 ||
    artifact.height < 180 ||
    artifact.sha256 !== scenario.evidenceSha256
  ) {
    fail(`scenarios.${scenarioName} evidence file is missing, invalid, or hash-drifted`);
  }
}

export function parseUnsignedBetaInstallerSha256(bytes) {
  if (!Buffer.isBuffer(bytes)) fail("unsigned beta checksum source must be bytes");
  const text = bytes.toString("utf8").replace(/^\uFEFF/u, "");
  const lines = text.split(/\r?\n/u).filter((line) => line.length > 0);
  if (lines.length !== 1) fail("unsigned beta checksum file must contain exactly one artifact");
  const match = lines[0].match(/^([A-F0-9]{64}) \*([^\\/:*?"<>|]{1,255})$/u);
  if (!match || !/_1\.4\.0_x64-setup\.exe$/u.test(match[2])) {
    fail("unsigned beta checksum file does not identify the frozen v1.4.0 NSIS installer");
  }
  return match[1];
}

export function validateMsixStoreDataLifecycleAcceptance(
  document,
  {
    identity,
    identityBytes,
    storeReleaseManifest,
    storeReleaseManifestBytes,
    runtimeReport,
    runtimeReportBytes,
    releasePolicy,
    releasePolicyBytes,
    betaFreezeReport,
    betaFreezeReportBytes,
    betaGithubReport,
    betaGithubReportBytes,
    betaChecksumBytes,
    verifierBytes,
    evidenceArtifacts,
    captureIndex,
    captureIndexBytes,
    captureInput,
    now = new Date(),
  } = {},
) {
  exactKeys(
    document,
    [
      "schemaVersion",
      "status",
      "testedAt",
      "bindings",
      "machineEvidence",
      "tester",
      "environment",
      "dataBoundary",
      "scenarios",
      "unresolvedFindings",
      "outcome",
      "attestationText",
    ],
    "acceptance",
  );
  if (document.schemaVersion !== 1) fail("schemaVersion must be 1");
  if (document.status !== "human_accepted_store_data_lifecycle") {
    fail("status must be human_accepted_store_data_lifecycle");
  }
  if (
    !Buffer.isBuffer(identityBytes) ||
    !Buffer.isBuffer(storeReleaseManifestBytes) ||
    !Buffer.isBuffer(runtimeReportBytes) ||
    !Buffer.isBuffer(releasePolicyBytes) ||
    !Buffer.isBuffer(betaFreezeReportBytes) ||
    !Buffer.isBuffer(betaGithubReportBytes) ||
    !Buffer.isBuffer(betaChecksumBytes) ||
    !Buffer.isBuffer(verifierBytes)
  ) {
    fail("Store data-lifecycle source bytes are incomplete");
  }
  const sourceNsisInstallerSha256 = parseUnsignedBetaInstallerSha256(betaChecksumBytes);
  if (
    betaFreezeReport?.status !== "frozen_unsigned_beta_candidate" ||
    betaFreezeReport?.artifacts?.candidate?.sha256 !== sourceNsisInstallerSha256 ||
    betaGithubReport?.status !== "github_unsigned_beta_prerelease_verified" ||
    betaGithubReport?.freeze?.reportSha256 !== sha256(betaFreezeReportBytes) ||
    betaGithubReport?.freeze?.candidateSha256 !== sourceNsisInstallerSha256 ||
    betaGithubReport?.assets?.candidate?.sha256 !== sourceNsisInstallerSha256 ||
    betaGithubReport?.outcome?.publishedAsGithubPrerelease !== true ||
    betaGithubReport?.outcome?.readyForUnsignedBetaDistribution !== true ||
    betaGithubReport?.outcome?.stableRelease !== false
  ) {
    fail("published unsigned beta evidence drifted from the frozen NSIS source candidate");
  }
  const expectedBindings = {
    storeIdentitySha256: sha256(identityBytes),
    storeReleaseManifestSha256: sha256(storeReleaseManifestBytes),
    unsignedStoreCandidateSha256: storeReleaseManifest?.candidate?.sha256,
    disposableRuntimeReportSha256: sha256(runtimeReportBytes),
    disposableTestSignedPackageSha256: runtimeReport?.candidate?.sha256Before,
    releasePolicySha256: sha256(releasePolicyBytes),
    betaFreezeReportSha256: sha256(betaFreezeReportBytes),
    betaGithubPublicationReportSha256: sha256(betaGithubReportBytes),
    betaChecksumFileSha256: sha256(betaChecksumBytes),
    sourceNsisInstallerSha256,
    verifierSha256: sha256(verifierBytes),
  };
  exactKeys(document.bindings, Object.keys(expectedBindings), "bindings");
  for (const [name, digest] of Object.entries(document.bindings)) {
    canonicalHash(digest, `bindings.${name}`);
  }
  if (!exact(document.bindings, expectedBindings)) fail("Store data-lifecycle bindings drifted");

  exactKeys(
    document.machineEvidence,
    ["sessionId", "captureIndexPath", "captureIndexSha256", "syntheticCaptureComplete"],
    "machineEvidence",
  );
  if (
    typeof document.machineEvidence.sessionId !== "string" ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(
      document.machineEvidence.sessionId,
    ) ||
    document.machineEvidence.captureIndexPath !==
      `src-tauri/target/msix-store-data-lifecycle/${document.machineEvidence.sessionId}/capture-index.json` ||
    document.machineEvidence.syntheticCaptureComplete !== true ||
    !Buffer.isBuffer(captureIndexBytes) ||
    document.machineEvidence.captureIndexSha256 !== sha256(captureIndexBytes)
  ) {
    fail("machineEvidence is incomplete, path-unsafe, or hash-drifted");
  }
  let captureFacts;
  try {
    captureFacts = validateStoreDataCaptureIndex(captureIndex, captureInput);
  } catch (error) {
    fail(`machineEvidence capture bundle is invalid: ${error.message}`);
  }
  if (
    captureInput?.sessionId !== document.machineEvidence.sessionId ||
    captureFacts.session.candidateSha256 !== expectedBindings.unsignedStoreCandidateSha256 ||
    captureFacts.session.storeReleaseManifestSha256 !== expectedBindings.storeReleaseManifestSha256 ||
    captureFacts.session.runtimeReportSha256 !== expectedBindings.disposableRuntimeReportSha256
  ) {
    fail("machineEvidence session drifted from the exact Store candidate lineage");
  }

  if (
    identity?.schemaVersion !== 1 ||
    identity.status !== "partner_center_confirmed" ||
    storeReleaseManifest?.schemaVersion !== 1 ||
    storeReleaseManifest.mode !== "msix_store_release_manifest" ||
    storeReleaseManifest.product?.storeId !== identity.product?.storeId ||
    storeReleaseManifest.product?.identityName !== identity.package?.identityName ||
    storeReleaseManifest.product?.packageFamilyName !== identity.package?.packageFamilyName ||
    storeReleaseManifest.product?.version !== identity.platform?.version ||
    storeReleaseManifest.boundary?.directDistributionAllowed !== false ||
    storeReleaseManifest.boundary.microsoftStoreResigningRequired !== true ||
    runtimeReport?.schemaVersion !== 1 ||
    runtimeReport.mode !== "msix_store_runtime_test" ||
    runtimeReport.candidate?.signatureStatus !== "Valid" ||
    runtimeReport.candidate.signatureOrigin !== "disposable_test_certificate" ||
    runtimeReport.candidate.signerSubject !== identity.package.publisher ||
    runtimeReport.lineage?.storeReleaseManifestSha256 !== sha256(storeReleaseManifestBytes) ||
    runtimeReport.lineage.unsignedStoreCandidateSha256 !== storeReleaseManifest.candidate.sha256 ||
    releasePolicy?.schemaVersion !== 1 ||
    releasePolicy.distribution?.strategy !== "low_cost_staged" ||
    releasePolicy.distribution.selectedChannel !== "pending" ||
    releasePolicy.distribution.plannedStableChannel !== "microsoft_store"
  ) {
    fail("Store data-lifecycle identity, candidate, runtime, or channel contract drifted");
  }

  const testedAt = validTimestamp(document.testedAt, "testedAt", now);
  const runtimeTestedAt = Date.parse(runtimeReport.testedAt);
  if (!Number.isFinite(runtimeTestedAt) || testedAt < runtimeTestedAt) {
    fail("testedAt must follow the disposable Store runtime test");
  }
  exactKeys(document.tester, ["name", "role", "organization", "humanTester"], "tester");
  humanName(document.tester.name, "tester.name");
  validText(document.tester.role, "tester.role", 3, 80);
  validText(document.tester.organization, "tester.organization", 2, 120);
  if (document.tester.humanTester !== true) fail("tester.humanTester must be true");
  if (/(?:\bcodex\b|\bchatgpt\b|\bai\b|\bbot\b|automated|automation|人工智能|自动化|机器人)/iu.test(
    `${document.tester.name} ${document.tester.role} ${document.tester.organization}`,
  )) {
    fail("tester must be a human, not AI or automation");
  }

  exactKeys(
    document.environment,
    ["machineAlias", "windowsEdition", "windowsVersion", "osBuild", "accountType", "cleanSnapshotSha256"],
    "environment",
  );
  validText(document.environment.machineAlias, "environment.machineAlias", 2, 80);
  validText(document.environment.windowsEdition, "environment.windowsEdition", 3, 120);
  if (!/^Windows 11/iu.test(document.environment.windowsEdition)) {
    fail("environment.windowsEdition must identify Windows 11");
  }
  validText(document.environment.windowsVersion, "environment.windowsVersion", 2, 80);
  if (!/^10\.0\.(?:2[2-9][0-9]{3}|[3-9][0-9]{4,})\.\d+$/u.test(document.environment.osBuild)) {
    fail("environment.osBuild must identify a Windows 11 build");
  }
  if (!['standard_user', 'administrator'].includes(document.environment.accountType)) {
    fail("environment.accountType must be standard_user or administrator");
  }
  canonicalHash(document.environment.cleanSnapshotSha256, "environment.cleanSnapshotSha256");

  exactKeys(
    document.dataBoundary,
    [
      "applicationIdentifier",
      "logicalDataRoot",
      "databaseFileName",
      "expectedSchemaVersion",
      "syntheticDataOnly",
      "realUserDataAccessed",
      "rawUserContentRecorded",
    ],
    "dataBoundary",
  );
  if (
    document.dataBoundary.applicationIdentifier !== "com.yuanyuan.reminder" ||
    document.dataBoundary.logicalDataRoot !== "LOCALAPPDATA/com.yuanyuan.reminder" ||
    document.dataBoundary.databaseFileName !== "yuanyuan-reminder.sqlite3" ||
    document.dataBoundary.expectedSchemaVersion !== 11 ||
    document.dataBoundary.syntheticDataOnly !== true ||
    document.dataBoundary.realUserDataAccessed !== false ||
    document.dataBoundary.rawUserContentRecorded !== false
  ) {
    fail("Store data-lifecycle privacy or logical data-root boundary drifted");
  }

  exactKeys(document.scenarios, STORE_DATA_LIFECYCLE_SCENARIOS, "scenarios");
  const migration = document.scenarios.nsisToMsixMigration;
  exactKeys(
    migration,
    [
      "sourceVersion",
      "targetVersion",
      "sourceProcessFullyExited",
      "safetyBackupCreated",
      "sameLogicalDataRootObserved",
      "existingDatabaseOpened",
      "sourceSchemaVersion",
      "targetSchemaVersion",
      "sourceLogicalStateSha256",
      "targetLogicalStateSha256",
      "recordCountsBefore",
      "recordCountsAfter",
      "quickCheckOk",
      "evidencePath",
      "evidenceSha256",
      "redacted",
      "notes",
      "passed",
    ],
    "scenarios.nsisToMsixMigration",
  );
  validCounts(migration.recordCountsBefore, "scenarios.nsisToMsixMigration.recordCountsBefore");
  validCounts(migration.recordCountsAfter, "scenarios.nsisToMsixMigration.recordCountsAfter");
  canonicalHash(migration.sourceLogicalStateSha256, "scenarios.nsisToMsixMigration.sourceLogicalStateSha256");
  if (
    migration.sourceVersion !== "1.4.0" ||
    migration.targetVersion !== identity.platform.version ||
    migration.sourceProcessFullyExited !== true ||
    migration.safetyBackupCreated !== true ||
    migration.sameLogicalDataRootObserved !== true ||
    migration.existingDatabaseOpened !== true ||
    migration.sourceSchemaVersion !== 11 ||
    migration.targetSchemaVersion !== 11 ||
    migration.targetLogicalStateSha256 !== migration.sourceLogicalStateSha256 ||
    !exact(migration.recordCountsAfter, migration.recordCountsBefore) ||
    migration.quickCheckOk !== true
  ) {
    fail("NSIS-to-MSIX migration did not preserve the schema and logical state");
  }
  if (
    migration.sourceSchemaVersion !== captureFacts.checkpoints.nsis_before.database.schemaVersion ||
    migration.targetSchemaVersion !== captureFacts.checkpoints.msix_after.database.schemaVersion ||
    migration.sourceLogicalStateSha256 !==
      captureFacts.checkpoints.nsis_before.database.logicalStateSha256 ||
    migration.targetLogicalStateSha256 !==
      captureFacts.checkpoints.msix_after.database.logicalStateSha256 ||
    !exact(
      migration.recordCountsBefore,
      captureFacts.checkpoints.nsis_before.database.tableCounts,
    ) ||
    !exact(migration.recordCountsAfter, captureFacts.checkpoints.msix_after.database.tableCounts)
  ) {
    fail("NSIS-to-MSIX acceptance values drifted from machine capture evidence");
  }
  validateEvidence(migration, "nsisToMsixMigration", evidenceArtifacts);

  const backup = document.scenarios.backupRestore;
  exactKeys(
    backup,
    [
      "baselineLogicalStateSha256",
      "backupFileSha256",
      "mutatedLogicalStateSha256",
      "restoredLogicalStateSha256",
      "backupCreated",
      "mutationObserved",
      "restoreSucceeded",
      "recordCountsBefore",
      "recordCountsAfter",
      "quickCheckOk",
      "evidencePath",
      "evidenceSha256",
      "redacted",
      "notes",
      "passed",
    ],
    "scenarios.backupRestore",
  );
  for (const name of ["baselineLogicalStateSha256", "backupFileSha256", "mutatedLogicalStateSha256", "restoredLogicalStateSha256"]) {
    canonicalHash(backup[name], `scenarios.backupRestore.${name}`);
  }
  validCounts(backup.recordCountsBefore, "scenarios.backupRestore.recordCountsBefore");
  validCounts(backup.recordCountsAfter, "scenarios.backupRestore.recordCountsAfter");
  if (
    backup.baselineLogicalStateSha256 !== migration.targetLogicalStateSha256 ||
    backup.mutatedLogicalStateSha256 === backup.baselineLogicalStateSha256 ||
    backup.restoredLogicalStateSha256 !== backup.baselineLogicalStateSha256 ||
    backup.backupCreated !== true ||
    backup.mutationObserved !== true ||
    backup.restoreSucceeded !== true ||
    !exact(backup.recordCountsAfter, backup.recordCountsBefore) ||
    backup.quickCheckOk !== true
  ) {
    fail("Store backup/restore did not reproduce the pre-mutation logical state");
  }
  if (
    backup.baselineLogicalStateSha256 !==
      captureFacts.checkpoints.backup_baseline.database.logicalStateSha256 ||
    backup.mutatedLogicalStateSha256 !==
      captureFacts.checkpoints.backup_mutated.database.logicalStateSha256 ||
    backup.restoredLogicalStateSha256 !==
      captureFacts.checkpoints.backup_restored.database.logicalStateSha256 ||
    !exact(
      backup.recordCountsBefore,
      captureFacts.checkpoints.backup_baseline.database.tableCounts,
    ) ||
    !exact(
      backup.recordCountsAfter,
      captureFacts.checkpoints.backup_restored.database.tableCounts,
    )
  ) {
    fail("backup/restore acceptance values drifted from machine capture evidence");
  }
  validateEvidence(backup, "backupRestore", evidenceArtifacts);

  const update = document.scenarios.updateForward;
  exactKeys(
    update,
    [
      "fromVersion",
      "toVersion",
      "updateMethod",
      "sourcePackageSha256",
      "updatePackageSha256",
      "samePackageFamilyName",
      "samePublisher",
      "updateInstalled",
      "applicationLaunched",
      "preUpdateLogicalStateSha256",
      "postUpdateLogicalStateSha256",
      "recordCountsBefore",
      "recordCountsAfter",
      "quickCheckOk",
      "updatePackageRemovedAfterTest",
      "evidencePath",
      "evidenceSha256",
      "redacted",
      "notes",
      "passed",
    ],
    "scenarios.updateForward",
  );
  for (const name of ["sourcePackageSha256", "updatePackageSha256", "preUpdateLogicalStateSha256", "postUpdateLogicalStateSha256"]) {
    canonicalHash(update[name], `scenarios.updateForward.${name}`);
  }
  validCounts(update.recordCountsBefore, "scenarios.updateForward.recordCountsBefore");
  validCounts(update.recordCountsAfter, "scenarios.updateForward.recordCountsAfter");
  if (
    update.fromVersion !== identity.platform.version ||
    !laterStoreVersion(update.fromVersion, update.toVersion) ||
    update.updateMethod !== "higher_version_test_signed_msix" ||
    update.sourcePackageSha256 !== runtimeReport.candidate.sha256Before ||
    update.updatePackageSha256 === update.sourcePackageSha256 ||
    update.samePackageFamilyName !== true ||
    update.samePublisher !== true ||
    update.updateInstalled !== true ||
    update.applicationLaunched !== true ||
    update.preUpdateLogicalStateSha256 !== backup.restoredLogicalStateSha256 ||
    update.postUpdateLogicalStateSha256 !== update.preUpdateLogicalStateSha256 ||
    !exact(update.recordCountsAfter, update.recordCountsBefore) ||
    update.quickCheckOk !== true ||
    update.updatePackageRemovedAfterTest !== true
  ) {
    fail("higher-version MSIX update did not preserve package identity and logical state");
  }
  if (
    update.preUpdateLogicalStateSha256 !==
      captureFacts.checkpoints.update_before.database.logicalStateSha256 ||
    update.postUpdateLogicalStateSha256 !==
      captureFacts.checkpoints.update_after.database.logicalStateSha256 ||
    !exact(
      update.recordCountsBefore,
      captureFacts.checkpoints.update_before.database.tableCounts,
    ) ||
    !exact(update.recordCountsAfter, captureFacts.checkpoints.update_after.database.tableCounts)
  ) {
    fail("forward-update acceptance values drifted from machine capture evidence");
  }
  validateEvidence(update, "updateForward", evidenceArtifacts);

  const keep = document.scenarios.uninstallKeepData;
  exactKeys(
    keep,
    [
      "packageRemoved",
      "externalDataRootPreserved",
      "reinstallOpenedExistingDatabase",
      "preUninstallLogicalStateSha256",
      "postReinstallLogicalStateSha256",
      "recordCountsBefore",
      "recordCountsAfter",
      "quickCheckOk",
      "evidencePath",
      "evidenceSha256",
      "redacted",
      "notes",
      "passed",
    ],
    "scenarios.uninstallKeepData",
  );
  canonicalHash(keep.preUninstallLogicalStateSha256, "scenarios.uninstallKeepData.preUninstallLogicalStateSha256");
  validCounts(keep.recordCountsBefore, "scenarios.uninstallKeepData.recordCountsBefore");
  validCounts(keep.recordCountsAfter, "scenarios.uninstallKeepData.recordCountsAfter");
  if (
    keep.packageRemoved !== true ||
    keep.externalDataRootPreserved !== true ||
    keep.reinstallOpenedExistingDatabase !== true ||
    keep.preUninstallLogicalStateSha256 !== update.postUpdateLogicalStateSha256 ||
    keep.postReinstallLogicalStateSha256 !== keep.preUninstallLogicalStateSha256 ||
    !exact(keep.recordCountsAfter, keep.recordCountsBefore) ||
    keep.quickCheckOk !== true
  ) {
    fail("MSIX uninstall/reinstall did not preserve external application data");
  }
  if (
    keep.preUninstallLogicalStateSha256 !==
      captureFacts.checkpoints.uninstall_keep_before.database.logicalStateSha256 ||
    keep.postReinstallLogicalStateSha256 !==
      captureFacts.checkpoints.uninstall_keep_reinstalled.database.logicalStateSha256 ||
    !exact(
      keep.recordCountsBefore,
      captureFacts.checkpoints.uninstall_keep_before.database.tableCounts,
    ) ||
    !exact(
      keep.recordCountsAfter,
      captureFacts.checkpoints.uninstall_keep_reinstalled.database.tableCounts,
    )
  ) {
    fail("uninstall/reinstall acceptance values drifted from machine capture evidence");
  }
  validateEvidence(keep, "uninstallKeepData", evidenceArtifacts);

  const remove = document.scenarios.uninstallDeleteData;
  exactKeys(
    remove,
    [
      "deleteMechanism",
      "destructiveActionExplicitlyConfirmed",
      "syntheticSentinelPresentBefore",
      "applicationExitedAfterDeletion",
      "packageRemoved",
      "dataRootAbsentAfterUninstall",
      "databaseAbsentAfterUninstall",
      "backupDirectoryAbsentAfterUninstall",
      "logsDirectoryAbsentAfterUninstall",
      "realUserDataAccessed",
      "evidencePath",
      "evidenceSha256",
      "redacted",
      "notes",
      "passed",
    ],
    "scenarios.uninstallDeleteData",
  );
  if (
    remove.deleteMechanism !== "in_app_delete_all_local_data_before_msix_uninstall" ||
    remove.destructiveActionExplicitlyConfirmed !== true ||
    remove.syntheticSentinelPresentBefore !== true ||
    remove.applicationExitedAfterDeletion !== true ||
    remove.packageRemoved !== true ||
    remove.dataRootAbsentAfterUninstall !== true ||
    remove.databaseAbsentAfterUninstall !== true ||
    remove.backupDirectoryAbsentAfterUninstall !== true ||
    remove.logsDirectoryAbsentAfterUninstall !== true ||
    remove.realUserDataAccessed !== false
  ) {
    fail("explicit Store data deletion and uninstall did not remove the owned synthetic data root");
  }
  if (
    remove.dataRootAbsentAfterUninstall !== captureFacts.deletion.dataRootAbsent ||
    remove.databaseAbsentAfterUninstall !== captureFacts.deletion.databaseAbsent ||
    remove.backupDirectoryAbsentAfterUninstall !==
      captureFacts.deletion.backupDirectoryAbsent ||
    remove.logsDirectoryAbsentAfterUninstall !== captureFacts.deletion.logsDirectoryAbsent ||
    remove.realUserDataAccessed !== captureFacts.deletion.privacy.realUserDataAccessed
  ) {
    fail("explicit-delete acceptance values drifted from machine capture evidence");
  }
  validateEvidence(remove, "uninstallDeleteData", evidenceArtifacts);

  if (
    !Array.isArray(document.unresolvedFindings) ||
    document.unresolvedFindings.length !== 0
  ) {
    fail("unresolvedFindings must be empty");
  }
  exactKeys(document.outcome, ["approvedBy", "approvedAt", "accepted"], "outcome");
  humanName(document.outcome.approvedBy, "outcome.approvedBy");
  const approvedAt = validTimestamp(document.outcome.approvedAt, "outcome.approvedAt", now);
  if (approvedAt < testedAt) fail("outcome.approvedAt must not precede testedAt");
  if (document.outcome.accepted !== true) fail("outcome.accepted must be true");
  if (document.attestationText !== STORE_DATA_LIFECYCLE_ATTESTATION_TEXT) {
    fail("attestationText does not match the Store data-lifecycle contract");
  }
  return document;
}

function runVerifier(script, args = []) {
  const result = spawnSync(process.execPath, [script, ...args], {
    cwd: projectRoot,
    encoding: "utf8",
  });
  if (result.status !== 0) fail(result.stderr.trim() || `${path.basename(script)} failed`);
}

async function readJsonBytes(filePath) {
  const bytes = await readFile(filePath);
  return { bytes, document: JSON.parse(bytes.toString("utf8").replace(/^\uFEFF/u, "")) };
}

async function readStoreDataCaptureBundle(machineEvidence) {
  const sessionId = machineEvidence?.sessionId;
  if (
    typeof sessionId !== "string" ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(sessionId) ||
    machineEvidence.captureIndexPath !==
      `src-tauri/target/msix-store-data-lifecycle/${sessionId}/capture-index.json`
  ) {
    fail("machineEvidence does not identify one fixed capture session");
  }
  const directory = path.join(dataCaptureRoot, sessionId);
  const [captureIndexRecord, sessionRecord, ...reportRecords] = await Promise.all([
    readJsonBytes(path.join(directory, "capture-index.json")),
    readJsonBytes(path.join(directory, "session.json")),
    ...STORE_DATA_CAPTURE_REPORTS.map((name) =>
      readJsonBytes(path.join(directory, `${name}.json`)),
    ),
  ]);
  return {
    captureIndex: captureIndexRecord.document,
    captureIndexBytes: captureIndexRecord.bytes,
    captureInput: {
      sessionId,
      session: sessionRecord.document,
      sessionBytes: sessionRecord.bytes,
      reports: Object.fromEntries(
        STORE_DATA_CAPTURE_REPORTS.map((name, index) => [name, reportRecords[index].document]),
      ),
      reportBytes: Object.fromEntries(
        STORE_DATA_CAPTURE_REPORTS.map((name, index) => [name, reportRecords[index].bytes]),
      ),
    },
  };
}

export async function readMsixStoreDataLifecycleEvidenceArtifacts() {
  return Object.fromEntries(
    await Promise.all(
      STORE_DATA_LIFECYCLE_SCENARIOS.map(async (scenarioName) => {
        const relativePath = storePreSubmissionEvidenceRelativePath(scenarioName);
        const bytes = await readFile(path.join(projectRoot, ...relativePath.split("/")));
        return [relativePath, inspectPng(bytes)];
      }),
    ),
  );
}

export async function verifyMsixStoreDataLifecycleFiles() {
  readAndValidateStoreIdentity(defaultStoreIdentityPath);
  runVerifier(releaseManifestVerifierPath, ["--check"]);
  runVerifier(runtimeVerifierPath);
  const betaPublicationEvidence = await readAndValidateUnsignedBetaGithubReport();
  const acceptanceRecord = await readJsonBytes(acceptancePath);
  const captureBundle = await readStoreDataCaptureBundle(
    acceptanceRecord.document.machineEvidence,
  );
  const [
    identityRecord,
    manifestRecord,
    runtimeRecord,
    policyRecord,
    verifierBytes,
    evidenceArtifacts,
  ] = await Promise.all([
    readJsonBytes(defaultStoreIdentityPath),
    readJsonBytes(storeReleaseManifestPath),
    readJsonBytes(runtimeReportPath),
    readJsonBytes(releasePolicyPath),
    readFile(verifierPath),
    readMsixStoreDataLifecycleEvidenceArtifacts(),
  ]);
  return validateMsixStoreDataLifecycleAcceptance(acceptanceRecord.document, {
    identity: identityRecord.document,
    identityBytes: identityRecord.bytes,
    storeReleaseManifest: manifestRecord.document,
    storeReleaseManifestBytes: manifestRecord.bytes,
    runtimeReport: runtimeRecord.document,
    runtimeReportBytes: runtimeRecord.bytes,
    releasePolicy: policyRecord.document,
    releasePolicyBytes: policyRecord.bytes,
    betaFreezeReport: betaPublicationEvidence.freezeEvidence.report,
    betaFreezeReportBytes: betaPublicationEvidence.freezeEvidence.reportBytes,
    betaGithubReport: betaPublicationEvidence.report,
    betaGithubReportBytes: betaPublicationEvidence.reportBytes,
    betaChecksumBytes: betaPublicationEvidence.freezeEvidence.checksumBytes,
    verifierBytes,
    evidenceArtifacts,
    ...captureBundle,
  });
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  verifyMsixStoreDataLifecycleFiles()
    .then((document) => {
      process.stdout.write(
        `MSIX Store data lifecycle verified for ${document.tester.name}; five synthetic-data scenarios passed.\n`,
      );
    })
    .catch((error) => {
      process.stderr.write(`MSIX Store data lifecycle pending: ${error.message}\n`);
      process.exitCode = 2;
    });
}
