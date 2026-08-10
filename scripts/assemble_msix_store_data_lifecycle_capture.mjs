import { open, readFile, rm } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  captureSha256,
  createStoreDataCaptureIndex,
  STORE_DATA_CAPTURE_REPORTS,
  validateStoreDataCaptureIndex,
} from "./msix_store_data_lifecycle_capture_contract.mjs";
import { parseUnsignedBetaInstallerSha256 } from "./verify_msix_store_data_lifecycle.mjs";
import { readAndValidateUnsignedBetaGithubReport } from "./verify_unsigned_beta_github_release.mjs";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const releaseRoot = path.join(projectRoot, "docs", "release");
const captureRoot = path.join(
  projectRoot,
  "src-tauri",
  "target",
  "msix-store-data-lifecycle",
);
const templatePath = path.join(
  releaseRoot,
  "MSIX_STORE_DATA_LIFECYCLE_ACCEPTANCE_V1.template.json",
);
const identityPath = path.join(releaseRoot, "MSIX_STORE_IDENTITY_V1.json");
const releasePolicyPath = path.join(releaseRoot, "RELEASE_POLICY_V1.json");
const storeReleaseManifestPath = path.join(
  projectRoot,
  "src-tauri",
  "target",
  "msix-store",
  "msix-store-release-manifest.json",
);
const runtimeReportPath = path.join(
  projectRoot,
  "src-tauri",
  "target",
  "msix-store-runtime",
  "msix-store-runtime-report.json",
);
const verifierPath = path.join(projectRoot, "scripts", "verify_msix_store_data_lifecycle.mjs");

function jsonBytes(value) {
  return Buffer.from(`${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function parseJson(bytes, label) {
  try {
    return JSON.parse(bytes.toString("utf8").replace(/^\uFEFF/u, ""));
  } catch (error) {
    throw new Error(`${label} is not valid JSON: ${error.message}`);
  }
}

function requireSessionId(value) {
  if (
    typeof value !== "string" ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(value) ||
    value === "00000000-0000-0000-0000-000000000000"
  ) {
    throw new Error("--session-id must be a lowercase non-nil UUID");
  }
  return value;
}

function clone(value) {
  return structuredClone(value);
}

export function buildStoreDataLifecycleDraft({
  template,
  identityBytes,
  storeReleaseManifest,
  storeReleaseManifestBytes,
  runtimeReport,
  runtimeReportBytes,
  releasePolicyBytes,
  betaFreezeReportBytes,
  betaGithubReportBytes,
  betaChecksumBytes,
  verifierBytes,
  captureIndex,
  captureIndexBytes,
  captureInput,
}) {
  const facts = validateStoreDataCaptureIndex(captureIndex, captureInput);
  if (
    facts.session.candidateSha256 !== storeReleaseManifest?.candidate?.sha256 ||
    facts.session.storeReleaseManifestSha256 !== captureSha256(storeReleaseManifestBytes) ||
    facts.session.runtimeReportSha256 !== captureSha256(runtimeReportBytes)
  ) {
    throw new Error("capture session drifted from the current Store candidate evidence");
  }
  const document = clone(template);
  document.machineEvidence = {
    sessionId: captureInput.sessionId,
    captureIndexPath: `src-tauri/target/msix-store-data-lifecycle/${captureInput.sessionId}/capture-index.json`,
    captureIndexSha256: captureSha256(captureIndexBytes),
    syntheticCaptureComplete: true,
  };
  document.bindings = {
    storeIdentitySha256: captureSha256(identityBytes),
    storeReleaseManifestSha256: captureSha256(storeReleaseManifestBytes),
    unsignedStoreCandidateSha256: storeReleaseManifest.candidate.sha256,
    disposableRuntimeReportSha256: captureSha256(runtimeReportBytes),
    disposableTestSignedPackageSha256: runtimeReport.candidate.sha256Before,
    releasePolicySha256: captureSha256(releasePolicyBytes),
    betaFreezeReportSha256: captureSha256(betaFreezeReportBytes),
    betaGithubPublicationReportSha256: captureSha256(betaGithubReportBytes),
    betaChecksumFileSha256: captureSha256(betaChecksumBytes),
    sourceNsisInstallerSha256: parseUnsignedBetaInstallerSha256(betaChecksumBytes),
    verifierSha256: captureSha256(verifierBytes),
  };

  const checkpoint = facts.checkpoints;
  const migration = document.scenarios.nsisToMsixMigration;
  migration.sameLogicalDataRootObserved = true;
  migration.existingDatabaseOpened = true;
  migration.sourceSchemaVersion = checkpoint.nsis_before.database.schemaVersion;
  migration.targetSchemaVersion = checkpoint.msix_after.database.schemaVersion;
  migration.sourceLogicalStateSha256 = checkpoint.nsis_before.database.logicalStateSha256;
  migration.targetLogicalStateSha256 = checkpoint.msix_after.database.logicalStateSha256;
  migration.recordCountsBefore = clone(checkpoint.nsis_before.database.tableCounts);
  migration.recordCountsAfter = clone(checkpoint.msix_after.database.tableCounts);
  migration.quickCheckOk = checkpoint.msix_after.database.quickCheckOk;

  const backup = document.scenarios.backupRestore;
  backup.baselineLogicalStateSha256 = checkpoint.backup_baseline.database.logicalStateSha256;
  backup.mutatedLogicalStateSha256 = checkpoint.backup_mutated.database.logicalStateSha256;
  backup.restoredLogicalStateSha256 = checkpoint.backup_restored.database.logicalStateSha256;
  backup.mutationObserved =
    backup.mutatedLogicalStateSha256 !== backup.baselineLogicalStateSha256;
  backup.restoreSucceeded =
    backup.restoredLogicalStateSha256 === backup.baselineLogicalStateSha256;
  backup.recordCountsBefore = clone(checkpoint.backup_baseline.database.tableCounts);
  backup.recordCountsAfter = clone(checkpoint.backup_restored.database.tableCounts);
  backup.quickCheckOk = checkpoint.backup_restored.database.quickCheckOk;

  const update = document.scenarios.updateForward;
  update.preUpdateLogicalStateSha256 = checkpoint.update_before.database.logicalStateSha256;
  update.postUpdateLogicalStateSha256 = checkpoint.update_after.database.logicalStateSha256;
  update.recordCountsBefore = clone(checkpoint.update_before.database.tableCounts);
  update.recordCountsAfter = clone(checkpoint.update_after.database.tableCounts);
  update.quickCheckOk = checkpoint.update_after.database.quickCheckOk;

  const keep = document.scenarios.uninstallKeepData;
  keep.preUninstallLogicalStateSha256 =
    checkpoint.uninstall_keep_before.database.logicalStateSha256;
  keep.postReinstallLogicalStateSha256 =
    checkpoint.uninstall_keep_reinstalled.database.logicalStateSha256;
  keep.recordCountsBefore = clone(checkpoint.uninstall_keep_before.database.tableCounts);
  keep.recordCountsAfter = clone(checkpoint.uninstall_keep_reinstalled.database.tableCounts);
  keep.quickCheckOk = checkpoint.uninstall_keep_reinstalled.database.quickCheckOk;

  const remove = document.scenarios.uninstallDeleteData;
  remove.dataRootAbsentAfterUninstall = facts.deletion.dataRootAbsent;
  remove.databaseAbsentAfterUninstall = facts.deletion.databaseAbsent;
  remove.backupDirectoryAbsentAfterUninstall = facts.deletion.backupDirectoryAbsent;
  remove.logsDirectoryAbsentAfterUninstall = facts.deletion.logsDirectoryAbsent;
  remove.realUserDataAccessed = facts.deletion.privacy.realUserDataAccessed;
  return document;
}

async function readCaptureInput(sessionId) {
  const directory = path.join(captureRoot, sessionId);
  const sessionBytes = await readFile(path.join(directory, "session.json"));
  const reports = {};
  const reportBytes = {};
  await Promise.all(
    STORE_DATA_CAPTURE_REPORTS.map(async (name) => {
      const bytes = await readFile(path.join(directory, `${name}.json`));
      reportBytes[name] = bytes;
      reports[name] = parseJson(bytes, `capture report ${name}`);
    }),
  );
  return {
    sessionId,
    session: parseJson(sessionBytes, "capture session"),
    sessionBytes,
    reports,
    reportBytes,
  };
}

async function writeNewPair(indexPath, indexBytes, draftPath, draftBytes) {
  let indexHandle;
  let draftHandle;
  try {
    indexHandle = await open(indexPath, "wx");
    draftHandle = await open(draftPath, "wx");
    await indexHandle.writeFile(indexBytes);
    await indexHandle.sync();
    await draftHandle.writeFile(draftBytes);
    await draftHandle.sync();
  } catch (error) {
    if (indexHandle) {
      await indexHandle.close().catch(() => {});
      indexHandle = undefined;
      await rm(indexPath, { force: true });
    }
    if (draftHandle) {
      await draftHandle.close().catch(() => {});
      draftHandle = undefined;
      await rm(draftPath, { force: true });
    }
    throw error;
  } finally {
    await indexHandle?.close();
    await draftHandle?.close();
  }
}

async function main() {
  const sessionIdIndex = process.argv.indexOf("--session-id");
  if (sessionIdIndex < 0 || sessionIdIndex + 2 !== process.argv.length) {
    throw new Error("usage: node scripts/assemble_msix_store_data_lifecycle_capture.mjs --session-id <uuid>");
  }
  const sessionId = requireSessionId(process.argv[sessionIdIndex + 1]);
  const captureInput = await readCaptureInput(sessionId);
  const captureIndex = createStoreDataCaptureIndex(captureInput);
  const captureIndexBytes = jsonBytes(captureIndex);
  const betaPublicationEvidence = await readAndValidateUnsignedBetaGithubReport();
  const [
    templateBytes,
    identityBytes,
    storeReleaseManifestBytes,
    runtimeReportBytes,
    releasePolicyBytes,
    verifierBytes,
  ] = await Promise.all([
    readFile(templatePath),
    readFile(identityPath),
    readFile(storeReleaseManifestPath),
    readFile(runtimeReportPath),
    readFile(releasePolicyPath),
    readFile(verifierPath),
  ]);
  const draft = buildStoreDataLifecycleDraft({
    template: parseJson(templateBytes, "acceptance template"),
    identityBytes,
    storeReleaseManifest: parseJson(storeReleaseManifestBytes, "Store release manifest"),
    storeReleaseManifestBytes,
    runtimeReport: parseJson(runtimeReportBytes, "Store runtime report"),
    runtimeReportBytes,
    releasePolicyBytes,
    betaFreezeReportBytes: betaPublicationEvidence.freezeEvidence.reportBytes,
    betaGithubReportBytes: betaPublicationEvidence.reportBytes,
    betaChecksumBytes: betaPublicationEvidence.freezeEvidence.checksumBytes,
    verifierBytes,
    captureIndex,
    captureIndexBytes,
    captureInput,
  });
  const directory = path.join(captureRoot, sessionId);
  const indexPath = path.join(directory, "capture-index.json");
  const draftPath = path.join(directory, "acceptance.draft.json");
  await writeNewPair(indexPath, captureIndexBytes, draftPath, jsonBytes(draft));
  process.stdout.write(
    `Store data-lifecycle machine evidence assembled without human approval fields: ${draftPath}\n`,
  );
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    process.stderr.write(`Store data-lifecycle assembly stopped: ${error.message}\n`);
    process.exitCode = 2;
  });
}
