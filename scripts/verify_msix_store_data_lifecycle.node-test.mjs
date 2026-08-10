import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  parseUnsignedBetaInstallerSha256,
  STORE_DATA_LIFECYCLE_ATTESTATION_TEXT,
  STORE_DATA_LIFECYCLE_SCENARIOS,
  StoreDataLifecycleVerificationError,
  validateMsixStoreDataLifecycleAcceptance,
} from "./verify_msix_store_data_lifecycle.mjs";
import { storePreSubmissionEvidenceRelativePath } from "./verify_msix_store_pre_submission.mjs";
import {
  createStoreDataCaptureIndex,
  STORE_DATA_CAPTURE_CHECKPOINTS,
  STORE_DATA_CAPTURE_REPORTS,
} from "./msix_store_data_lifecycle_capture_contract.mjs";
import { buildStoreDataLifecycleDraft } from "./assemble_msix_store_data_lifecycle_capture.mjs";

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex").toUpperCase();
}

function jsonBytes(document) {
  return Buffer.from(`${JSON.stringify(document, null, 2)}\n`);
}

function fixture() {
  const identity = {
    schemaVersion: 1,
    status: "partner_center_confirmed",
    product: { storeId: "9N1234567890" },
    package: {
      identityName: "12345Yuanyuan.Reminder",
      publisher: "CN=12345678-1234-1234-1234-1234567890AB",
      publisherDisplayName: "Yuanyuan Project",
      packageFamilyName: "12345Yuanyuan.Reminder_abcdefghjkmnp",
    },
    platform: { version: "1.4.0.0" },
  };
  const storeReleaseManifest = {
    schemaVersion: 1,
    mode: "msix_store_release_manifest",
    product: {
      storeId: identity.product.storeId,
      identityName: identity.package.identityName,
      packageFamilyName: identity.package.packageFamilyName,
      version: identity.platform.version,
    },
    candidate: { sha256: "A".repeat(64) },
    boundary: {
      directDistributionAllowed: false,
      microsoftStoreResigningRequired: true,
    },
  };
  const identityBytes = jsonBytes(identity);
  const storeReleaseManifestBytes = jsonBytes(storeReleaseManifest);
  const runtimeReport = {
    schemaVersion: 1,
    mode: "msix_store_runtime_test",
    testedAt: "2026-08-10T09:00:00.000Z",
    candidate: {
      sha256Before: "B".repeat(64),
      signatureStatus: "Valid",
      signatureOrigin: "disposable_test_certificate",
      signerSubject: identity.package.publisher,
    },
    lineage: {
      storeReleaseManifestSha256: sha256(storeReleaseManifestBytes),
      unsignedStoreCandidateSha256: storeReleaseManifest.candidate.sha256,
    },
  };
  const releasePolicy = {
    schemaVersion: 1,
    distribution: {
      strategy: "low_cost_staged",
      selectedChannel: "pending",
      plannedStableChannel: "microsoft_store",
    },
  };
  const runtimeReportBytes = jsonBytes(runtimeReport);
  const releasePolicyBytes = jsonBytes(releasePolicy);
  const betaChecksumBytes = Buffer.from(
    `${"C".repeat(64)} *Yuanyuan_1.4.0_x64-setup.exe\n`,
  );
  const betaFreezeReport = {
    status: "frozen_unsigned_beta_candidate",
    artifacts: { candidate: { sha256: "C".repeat(64) } },
  };
  const betaFreezeReportBytes = jsonBytes(betaFreezeReport);
  const betaGithubReport = {
    status: "github_unsigned_beta_prerelease_verified",
    freeze: {
      reportSha256: sha256(betaFreezeReportBytes),
      candidateSha256: "C".repeat(64),
    },
    assets: { candidate: { sha256: "C".repeat(64) } },
    outcome: {
      publishedAsGithubPrerelease: true,
      readyForUnsignedBetaDistribution: true,
      stableRelease: false,
    },
  };
  const betaGithubReportBytes = jsonBytes(betaGithubReport);
  const verifierBytes = Buffer.from("Store data lifecycle verifier");
  const evidenceArtifacts = Object.fromEntries(
    STORE_DATA_LIFECYCLE_SCENARIOS.map((scenarioName) => [
      storePreSubmissionEvidenceRelativePath(scenarioName),
      {
        format: "png",
        width: 1600,
        height: 900,
        sha256: sha256(Buffer.from(`evidence:${scenarioName}`)),
      },
    ]),
  );
  const counts = {
    activity_tracking_state: 1,
    companion_attention_budget: 1,
    companion_proactive_attention: 0,
    focus_sessions: 2,
    occurrences: 3,
    pet_interactions: 1,
    reminders: 3,
    settings: 1,
    task_watch_attention_deferrals: 0,
    water_log: 2,
  };
  const baseline = "D".repeat(64);
  const evidence = (scenarioName) => ({
    evidencePath: storePreSubmissionEvidenceRelativePath(scenarioName),
    evidenceSha256: evidenceArtifacts[storePreSubmissionEvidenceRelativePath(scenarioName)].sha256,
    redacted: true,
    notes: `Observed the complete ${scenarioName} scenario with synthetic Store test data.`,
    passed: true,
  });
  const document = {
    schemaVersion: 1,
    status: "human_accepted_store_data_lifecycle",
    testedAt: "2026-08-10T12:00:00.000Z",
    bindings: {
      storeIdentitySha256: sha256(identityBytes),
      storeReleaseManifestSha256: sha256(storeReleaseManifestBytes),
      unsignedStoreCandidateSha256: storeReleaseManifest.candidate.sha256,
      disposableRuntimeReportSha256: sha256(runtimeReportBytes),
      disposableTestSignedPackageSha256: runtimeReport.candidate.sha256Before,
      releasePolicySha256: sha256(releasePolicyBytes),
      betaFreezeReportSha256: sha256(betaFreezeReportBytes),
      betaGithubPublicationReportSha256: sha256(betaGithubReportBytes),
      betaChecksumFileSha256: sha256(betaChecksumBytes),
      sourceNsisInstallerSha256: parseUnsignedBetaInstallerSha256(betaChecksumBytes),
      verifierSha256: sha256(verifierBytes),
    },
    machineEvidence: null,
    tester: {
      name: "Release Tester",
      role: "Windows release tester",
      organization: "Independent Test Lab",
      humanTester: true,
    },
    environment: {
      machineAlias: "clean-store-data-01",
      windowsEdition: "Windows 11 Pro",
      windowsVersion: "24H2",
      osBuild: "10.0.26100.1000",
      accountType: "administrator",
      cleanSnapshotSha256: "E".repeat(64),
    },
    dataBoundary: {
      applicationIdentifier: "com.yuanyuan.reminder",
      logicalDataRoot: "LOCALAPPDATA/com.yuanyuan.reminder",
      databaseFileName: "yuanyuan-reminder.sqlite3",
      expectedSchemaVersion: 11,
      syntheticDataOnly: true,
      realUserDataAccessed: false,
      rawUserContentRecorded: false,
    },
    scenarios: {
      nsisToMsixMigration: {
        sourceVersion: "1.4.0",
        targetVersion: "1.4.0.0",
        sourceProcessFullyExited: true,
        safetyBackupCreated: true,
        sameLogicalDataRootObserved: true,
        existingDatabaseOpened: true,
        sourceSchemaVersion: 11,
        targetSchemaVersion: 11,
        sourceLogicalStateSha256: baseline,
        targetLogicalStateSha256: baseline,
        recordCountsBefore: { ...counts },
        recordCountsAfter: { ...counts },
        quickCheckOk: true,
        ...evidence("nsisToMsixMigration"),
      },
      backupRestore: {
        baselineLogicalStateSha256: baseline,
        backupFileSha256: "F".repeat(64),
        mutatedLogicalStateSha256: "1".repeat(64),
        restoredLogicalStateSha256: baseline,
        backupCreated: true,
        mutationObserved: true,
        restoreSucceeded: true,
        recordCountsBefore: { ...counts },
        recordCountsAfter: { ...counts },
        quickCheckOk: true,
        ...evidence("backupRestore"),
      },
      updateForward: {
        fromVersion: "1.4.0.0",
        toVersion: "1.4.1.0",
        updateMethod: "higher_version_test_signed_msix",
        sourcePackageSha256: runtimeReport.candidate.sha256Before,
        updatePackageSha256: "2".repeat(64),
        samePackageFamilyName: true,
        samePublisher: true,
        updateInstalled: true,
        applicationLaunched: true,
        preUpdateLogicalStateSha256: baseline,
        postUpdateLogicalStateSha256: baseline,
        recordCountsBefore: { ...counts },
        recordCountsAfter: { ...counts },
        quickCheckOk: true,
        updatePackageRemovedAfterTest: true,
        ...evidence("updateForward"),
      },
      uninstallKeepData: {
        packageRemoved: true,
        externalDataRootPreserved: true,
        reinstallOpenedExistingDatabase: true,
        preUninstallLogicalStateSha256: baseline,
        postReinstallLogicalStateSha256: baseline,
        recordCountsBefore: { ...counts },
        recordCountsAfter: { ...counts },
        quickCheckOk: true,
        ...evidence("uninstallKeepData"),
      },
      uninstallDeleteData: {
        deleteMechanism: "in_app_delete_all_local_data_before_msix_uninstall",
        destructiveActionExplicitlyConfirmed: true,
        syntheticSentinelPresentBefore: true,
        applicationExitedAfterDeletion: true,
        packageRemoved: true,
        dataRootAbsentAfterUninstall: true,
        databaseAbsentAfterUninstall: true,
        backupDirectoryAbsentAfterUninstall: true,
        logsDirectoryAbsentAfterUninstall: true,
        realUserDataAccessed: false,
        ...evidence("uninstallDeleteData"),
      },
    },
    unresolvedFindings: [],
    outcome: {
      approvedBy: "Project Maintainer",
      approvedAt: "2026-08-10T13:00:00.000Z",
      accepted: true,
    },
    attestationText: STORE_DATA_LIFECYCLE_ATTESTATION_TEXT,
  };
  const sessionId = "12345678-1234-4567-89ab-1234567890ab";
  const session = {
    schemaVersion: 1,
    mode: "synthetic_store_data_lifecycle_session",
    initializedAt: "2026-08-10T10:00:00.000Z",
    sessionId,
    applicationIdentifier: "com.yuanyuan.reminder",
    logicalDataRoot: "LOCALAPPDATA/com.yuanyuan.reminder",
    databaseFileName: "yuanyuan-reminder.sqlite3",
    expectedSchemaVersion: 11,
    candidateSha256: storeReleaseManifest.candidate.sha256,
    storeReleaseManifestSha256: sha256(storeReleaseManifestBytes),
    runtimeReportSha256: sha256(runtimeReportBytes),
    syntheticDataOnly: true,
    disposableWindows11Attested: true,
  };
  const sessionBytes = jsonBytes(session);
  const checkpointDigest = (name) =>
    name === "backup_mutated" ? "1".repeat(64) : baseline;
  const report = (name) => ({
    schemaVersion: 1,
    status: "captured_synthetic_store_data_lifecycle_checkpoint",
    generatedAt: "2026-08-10T11:00:00.000Z",
    sessionId,
    checkpoint: name,
    applicationIdentifier: "com.yuanyuan.reminder",
    logicalDataRoot: "LOCALAPPDATA/com.yuanyuan.reminder",
    bindings: {
      candidateSha256: session.candidateSha256,
      storeReleaseManifestSha256: session.storeReleaseManifestSha256,
      runtimeReportSha256: session.runtimeReportSha256,
      sessionManifestSha256: sha256(sessionBytes),
    },
    database: {
      fileName: "yuanyuan-reminder.sqlite3",
      schemaVersion: 11,
      quickCheckOk: true,
      logicalStateSha256: checkpointDigest(name),
      tableCounts: { ...counts },
      mainFileSha256: "6".repeat(64),
      walPresent: false,
      walSha256: null,
      shmPresent: false,
      sourceStableDuringCapture: true,
    },
    privacy: {
      syntheticDataOnly: true,
      realUserDataAccessed: false,
      rawUserContentRecorded: false,
      dataPathRecorded: false,
    },
  });
  const reports = Object.fromEntries(
    STORE_DATA_CAPTURE_CHECKPOINTS.map((name) => [name, report(name)]),
  );
  reports.delete_after = {
    schemaVersion: 1,
    status: "observed_explicit_store_data_lifecycle_deletion",
    generatedAt: "2026-08-10T11:30:00.000Z",
    sessionId,
    checkpoint: "delete_after",
    applicationIdentifier: "com.yuanyuan.reminder",
    logicalDataRoot: "LOCALAPPDATA/com.yuanyuan.reminder",
    sessionManifestSha256: sha256(sessionBytes),
    dataRootAbsent: true,
    databaseAbsent: true,
    backupDirectoryAbsent: true,
    logsDirectoryAbsent: true,
    privacy: {
      syntheticDataOnly: true,
      realUserDataAccessed: false,
      rawUserContentRecorded: false,
      dataPathRecorded: false,
    },
  };
  const reportBytes = Object.fromEntries(
    STORE_DATA_CAPTURE_REPORTS.map((name) => [name, jsonBytes(reports[name])]),
  );
  const captureInput = { sessionId, session, sessionBytes, reports, reportBytes };
  const captureIndex = createStoreDataCaptureIndex(
    captureInput,
    "2026-08-10T11:45:00.000Z",
  );
  const captureIndexBytes = jsonBytes(captureIndex);
  document.machineEvidence = {
    sessionId,
    captureIndexPath: `src-tauri/target/msix-store-data-lifecycle/${sessionId}/capture-index.json`,
    captureIndexSha256: sha256(captureIndexBytes),
    syntheticCaptureComplete: true,
  };
  return {
    document,
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
    now: new Date("2026-08-11T00:00:00.000Z"),
  };
}

function rejects(input, pattern) {
  assert.throws(
    () => validateMsixStoreDataLifecycleAcceptance(input.document, input),
    (error) =>
      error instanceof StoreDataLifecycleVerificationError && pattern.test(error.message),
  );
}

test("accepts five exact-candidate synthetic Store data lifecycle scenarios", () => {
  const input = fixture();
  assert.equal(validateMsixStoreDataLifecycleAcceptance(input.document, input), input.document);
});

test("assembler pre-fills machine facts but leaves human approval pending", () => {
  const input = fixture();
  const template = JSON.parse(
    readFileSync(
      new URL("../docs/release/MSIX_STORE_DATA_LIFECYCLE_ACCEPTANCE_V1.template.json", import.meta.url),
      "utf8",
    ),
  );
  const draft = buildStoreDataLifecycleDraft({
    template,
    identityBytes: input.identityBytes,
    storeReleaseManifest: input.storeReleaseManifest,
    storeReleaseManifestBytes: input.storeReleaseManifestBytes,
    runtimeReport: input.runtimeReport,
    runtimeReportBytes: input.runtimeReportBytes,
    releasePolicyBytes: input.releasePolicyBytes,
    betaFreezeReportBytes: input.betaFreezeReportBytes,
    betaGithubReportBytes: input.betaGithubReportBytes,
    betaChecksumBytes: input.betaChecksumBytes,
    verifierBytes: input.verifierBytes,
    captureIndex: input.captureIndex,
    captureIndexBytes: input.captureIndexBytes,
    captureInput: input.captureInput,
  });
  assert.equal(draft.status, "pending");
  assert.equal(draft.tester.name, null);
  assert.equal(draft.outcome.accepted, false);
  assert.equal(draft.scenarios.nsisToMsixMigration.sourceSchemaVersion, 11);
  assert.equal(
    draft.scenarios.backupRestore.mutationObserved,
    true,
  );
  assert.equal(draft.scenarios.uninstallDeleteData.dataRootAbsentAfterUninstall, true);
  assert.equal(draft.scenarios.uninstallDeleteData.packageRemoved, false);
  assert.equal(draft.machineEvidence.syntheticCaptureComplete, true);
});

test("rejects Store candidate, runtime, policy, and frozen NSIS beta drift", () => {
  const candidate = fixture();
  candidate.document.bindings.unsignedStoreCandidateSha256 = "9".repeat(64);
  rejects(candidate, /bindings drifted/u);

  const policy = fixture();
  policy.releasePolicy.distribution.selectedChannel = "microsoft_store";
  rejects(policy, /channel contract/u);

  const beta = fixture();
  beta.betaChecksumBytes = Buffer.from(`${"C".repeat(64)} *other.exe\n`);
  rejects(beta, /frozen v1\.4\.0/u);

  const unpublished = fixture();
  unpublished.betaGithubReport.outcome.publishedAsGithubPrerelease = false;
  rejects(unpublished, /published unsigned beta evidence/u);

  const freeze = fixture();
  freeze.betaFreezeReport.artifacts.candidate.sha256 = "D".repeat(64);
  rejects(freeze, /published unsigned beta evidence/u);
});

test("rejects capture-index, checkpoint, and session-lineage drift", () => {
  const index = fixture();
  index.document.machineEvidence.captureIndexSha256 = "9".repeat(64);
  rejects(index, /machineEvidence/u);

  const checkpoint = fixture();
  checkpoint.captureInput.reports.msix_after.database.logicalStateSha256 = "8".repeat(64);
  rejects(checkpoint, /capture bundle/u);

  const session = fixture();
  session.captureInput.session.candidateSha256 = "7".repeat(64);
  rejects(session, /capture bundle|candidate lineage/u);
});

test("rejects AI testers, real-user data, or raw user content", () => {
  const automated = fixture();
  automated.document.tester.name = "Codex Bot";
  rejects(automated, /human/u);

  const realData = fixture();
  realData.document.dataBoundary.realUserDataAccessed = true;
  rejects(realData, /privacy/u);

  const raw = fixture();
  raw.document.dataBoundary.rawUserContentRecorded = true;
  rejects(raw, /privacy/u);
});

test("rejects migration logical-state, schema, or aggregate-count loss", () => {
  const logical = fixture();
  logical.document.scenarios.nsisToMsixMigration.targetLogicalStateSha256 = "3".repeat(64);
  rejects(logical, /migration did not preserve/u);

  const schema = fixture();
  schema.document.scenarios.nsisToMsixMigration.targetSchemaVersion = 12;
  rejects(schema, /migration did not preserve/u);

  const counts = fixture();
  counts.document.scenarios.nsisToMsixMigration.recordCountsAfter.reminders = 2;
  rejects(counts, /migration did not preserve/u);
});

test("rejects ineffective backup restore or identity-breaking forward updates", () => {
  const backup = fixture();
  backup.document.scenarios.backupRestore.restoredLogicalStateSha256 = "4".repeat(64);
  rejects(backup, /backup\/restore/u);

  const sameVersion = fixture();
  sameVersion.document.scenarios.updateForward.toVersion = "1.4.0.0";
  rejects(sameVersion, /higher-version/u);

  const publisher = fixture();
  publisher.document.scenarios.updateForward.samePublisher = false;
  rejects(publisher, /higher-version/u);
});

test("rejects uninstall data-loss, missing explicit deletion, and stale evidence", () => {
  const lost = fixture();
  lost.document.scenarios.uninstallKeepData.externalDataRootPreserved = false;
  rejects(lost, /did not preserve/u);

  const implicitDelete = fixture();
  implicitDelete.document.scenarios.uninstallDeleteData.deleteMechanism = "msix_uninstall_only";
  rejects(implicitDelete, /explicit Store data deletion/u);

  const evidence = fixture();
  delete evidence.evidenceArtifacts[
    evidence.document.scenarios.backupRestore.evidencePath
  ];
  rejects(evidence, /evidence file/u);
});
