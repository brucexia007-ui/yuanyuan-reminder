import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import {
  REQUIRED_UPGRADE_AUTOMATIC_GATES,
  createReleaseUpgradeCompletionPacket,
} from "./generate_release_upgrade_completion_packet.mjs";
import {
  UPGRADE_COMPLETION_ATTESTATION_REFERENCE,
  UPGRADE_COMPLETION_PACKET_REFERENCE,
  authenticMigrationReportMatches,
  upgradeCompletionAttestationMatches,
} from "./verify_release_upgrade_completion.mjs";

const MANIFEST_SHA256 = "A".repeat(64);
const POLICY_SHA256 = "B".repeat(64);
const PACKET_SHA256 = "C".repeat(64);
const NOW = new Date("2026-08-11T00:00:00.000Z");
const MATERIAL_PATHS = [
  ["isolatedTransitionReport", "src-tauri/target/release/release-upgrade-rollback-probe.json"],
  ["defaultPathTransitionReport", "src-tauri/target/release/release-default-upgrade-rollback-probe.json"],
  ["installFailureRecoveryReport", "src-tauri/target/release/release-install-failure-recovery-probe.json"],
  ["firstStartRecoveryReport", "src-tauri/target/release/release-first-start-recovery-probe.json"],
  ["firstStartDatabaseReport", "src-tauri/target/release/release-first-start-recovery-database.json"],
  ["firstStartDatabaseFixture", "src-tauri/target/release/release-first-start-recovery.sqlite3"],
  ["uninstallDataChoiceReport", "src-tauri/target/release/release-uninstall-data-choice-probe.json"],
  ["authenticV132MigrationReport", "src-tauri/target/release/release-authentic-v132-database-migration.json"],
  ["signingProtocolPacket", "src-tauri/target/release/release-signing-protocol-packet.json"],
  ["signingProtocolAttestation", "docs/release/RELEASE_SIGNING_PROTOCOL_ATTESTATION_V1.json"],
];

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex").toUpperCase();
}

function manifest() {
  return {
    schemaVersion: 1,
    generatedAt: "2026-08-10T10:00:00.000Z",
    productVersion: "1.4.0",
    artifacts: [
      { id: "stable_core", bytes: 101, sha256: "1".repeat(64) },
      { id: "nsis_installed_core", bytes: 102, sha256: "2".repeat(64) },
      { id: "nsis_installer", bytes: 103, sha256: "3".repeat(64) },
    ],
  };
}

function policy() {
  return {
    schemaVersion: 1,
    releaseArtifacts: ["stable_core", "nsis_installed_core", "nsis_installer"],
    manualReleaseGates: { requireUpgradeRollbackDrill: true },
  };
}

function migrationReport() {
  return {
    schemaVersion: 1,
    status: "passed",
    generatedAt: "2026-08-10T11:00:00.000Z",
    expectedSourceRelease: "1.3.2",
    sourceReleaseEvidence: "operator_attested_copy_plus_schema_version_6",
    sourceReleaseEvidenceLimit:
      "Schema version 6 is necessary but does not independently prove which application release created the fixture.",
    sourceFileName: "v132-copy.sqlite3",
    sourceSizeBytes: 2 * 1024 * 1024,
    sourceSha256: "4".repeat(64),
    sourceDatabaseVersion: 6,
    migratedDatabaseVersion: 11,
    sourceLogicalSha256: "5".repeat(64),
    migratedMatchedSourceRowsSha256: "5".repeat(64),
    sourceTableCounts: { reminders: 12, settings: 1 },
    migratedTableCounts: { reminders: 12, settings: 1 },
    checks: [
      "source_read_only",
      "source_integrity",
      "v132_schema_identity",
      "production_migration",
      "row_preservation",
      "backup_restore",
      "failed_restore_rollback",
      "post_restore_health",
    ].map((id) => ({ id, passed: true, detail: `Verified ${id}` })),
    privacy:
      "Contains only file identity, schema versions, aggregate table counts and fixed check results; no user content or source path.",
  };
}

function materialInputs(reportBytes, missingId = null) {
  return MATERIAL_PATHS.map(([id, materialPath], index) => {
    if (id === missingId) {
      return { id, path: materialPath, present: false, bytes: null, sha256: null };
    }
    const bytes = id === "authenticV132MigrationReport" ? reportBytes.length : 100 + index;
    const digest = id === "authenticV132MigrationReport" ? sha256(reportBytes) : `${index}`.repeat(64);
    return { id, path: materialPath, present: true, bytes, sha256: digest };
  });
}

function references(label) {
  return [
    "docs/P0_RELEASE_UPGRADE_ROLLBACK_PROBE_2026-08-09.md",
    `docs/release/evidence/${label}.json`,
  ].sort((left, right) => left.localeCompare(right, "en"));
}

function scenario(fields, label) {
  return { ...fields, evidenceReferences: references(label), passed: true };
}

function buildInput() {
  const report = migrationReport();
  const reportBytes = Buffer.from(JSON.stringify(report, null, 2));
  const packet = createReleaseUpgradeCompletionPacket({
    manifest: manifest(),
    manifestSha256: MANIFEST_SHA256,
    releasePolicy: policy(),
    releasePolicySha256: POLICY_SHA256,
    evidenceMaterials: materialInputs(reportBytes),
  });
  const migrationMaterial = packet.evidenceMaterials.find(
    (material) => material.id === "authenticV132MigrationReport",
  );
  const attestation = {
    schemaVersion: 1,
    mode: "release_upgrade_completion_attestation",
    testedAt: "2026-08-10T12:00:00.000Z",
    packetSha256: PACKET_SHA256,
    candidateManifestSha256: MANIFEST_SHA256,
    tester: {
      name: "Release Tester",
      role: "Release Engineer",
      organization: "Yuanyuan Test Organization",
      humanTester: true,
    },
    environment: {
      machineAlias: "clean-vm-01",
      windowsEdition: "Windows 11 Pro",
      windowsVersion: "24H2",
      osBuild: "26100.1",
      accountType: "standard_user",
      cleanSnapshotSha256: "6".repeat(64),
    },
    authenticHistoricalDatabase: {
      migrationReportSha256: migrationMaterial.sha256,
      sourceDatabaseSha256: report.sourceSha256,
      sourceSizeBytes: report.sourceSizeBytes,
      sourceApplicationDisplayedVersion: "1.3.2",
      sourceApplicationFullyExitedBeforeCopy: true,
      sourceProvider: {
        name: "Database Provider",
        role: "Release Tester",
        organization: "Yuanyuan Test Organization",
        humanProvider: true,
      },
      sourceDatabaseNotCommitted: true,
    },
    scenarios: {
      defaultPathRegistration: scenario(
        {
          controlPanelEntryObserved: true,
          displayedVersion: "1.4.0",
          installLocationMatched: true,
          uninstallCommandMatched: true,
        },
        "default-registration",
      ),
      authenticDatabaseUpgrade: scenario(
        {
          sourceSchemaVersion: 6,
          migratedSchemaVersion: 11,
          sourceLogicalSha256: report.sourceLogicalSha256,
          migratedMatchedSourceRowsSha256: report.migratedMatchedSourceRowsSha256,
          quickCheckOk: true,
          allRowsPreserved: true,
        },
        "database-upgrade",
      ),
      physicalPowerLossRecovery: scenario(
        {
          interruptionStage: "first_start_wal_write",
          physicalPowerLossOrHypervisorHardReset: true,
          gracefulShutdownRequested: false,
          writeBoundaryObserved: true,
          recoveryUsedUnmodifiedCandidate: true,
          recoveredToVisibleWindow: true,
          quickCheckOk: true,
          dataPreserved: true,
        },
        "power-loss",
      ),
      windowsRestartRecovery: scenario(
        {
          restartStage: "during_first_start_migration",
          actualWindowsRestart: true,
          applicationProcessStoppedByRestart: true,
          recoveredToVisibleWindow: true,
          quickCheckOk: true,
          dataPreserved: true,
        },
        "windows-restart",
      ),
      safeHistoricalRollback: scenario(
        {
          preUpgradeDatabaseCopyCreated: true,
          restoredPreUpgradeDatabaseCopy: true,
          migratedV11DatabaseOpenedByHistoricalVersion: false,
          historicalVersionLaunchedAfterRestore: true,
          restoredLogicalSha256: report.sourceLogicalSha256,
        },
        "safe-rollback",
      ),
      signedCandidateRevalidatedAfterRecovery: true,
    },
    unresolvedFindings: [],
    evidenceReferences: references("upgrade-summary"),
    attestationText:
      "I attest that the named human tester completed the exact-candidate default-path registration, authentic v1.3.2 database upgrade, physical power-loss or hard-reset recovery, real Windows restart recovery, signed-candidate revalidation, and safe rollback scenarios described by this packet, restored only owned test data, and omitted no unresolved result.",
  };
  return {
    attestation,
    packet,
    expectedPacket: structuredClone(packet),
    packetSha256: PACKET_SHA256,
    manifest: manifest(),
    manifestSha256: MANIFEST_SHA256,
    releaseEvidence: {
      upgradeRollbackDrillVerified: true,
      releaseCandidateSha256: "3".repeat(64),
      evidenceReferences: [
        UPGRADE_COMPLETION_PACKET_REFERENCE,
        UPGRADE_COMPLETION_ATTESTATION_REFERENCE,
      ],
    },
    automaticGates: Object.fromEntries(REQUIRED_UPGRADE_AUTOMATIC_GATES.map((id) => [id, true])),
    signatureGate: {
      signed: true,
      timestamped: true,
      sameCertificate: true,
      identityFrozen: true,
      publisherMatches: true,
    },
    signingProtocolEvidenceValid: true,
    migrationReport: report,
    migrationReportBytes: reportBytes,
    now: NOW,
  };
}

test("accepts the complete signed authentic-database power-loss restart and rollback matrix", () => {
  const input = buildInput();
  assert.equal(upgradeCompletionAttestationMatches(input), true);
  const material = input.packet.evidenceMaterials.find(
    (candidate) => candidate.id === "authenticV132MigrationReport",
  );
  assert.equal(
    authenticMigrationReportMatches({
      report: input.migrationReport,
      reportBytes: input.migrationReportBytes,
      material,
      manifestGeneratedAt: input.manifest.generatedAt,
      now: NOW,
    }),
    true,
  );
});

test("rejects fake humans, graceful interruption, missing restart, unsafe rollback, and weak gates", () => {
  const mutations = [
    (input) => {
      input.attestation.tester.name = "Codex Tester";
    },
    (input) => {
      input.attestation.authenticHistoricalDatabase.sourceProvider.name = "AI Provider";
    },
    (input) => {
      input.attestation.scenarios.physicalPowerLossRecovery.gracefulShutdownRequested = true;
    },
    (input) => {
      input.attestation.scenarios.windowsRestartRecovery.actualWindowsRestart = false;
    },
    (input) => {
      input.attestation.scenarios.safeHistoricalRollback.migratedV11DatabaseOpenedByHistoricalVersion = true;
    },
    (input) => {
      input.signingProtocolEvidenceValid = false;
    },
    (input) => {
      input.signatureGate.timestamped = false;
    },
    (input) => {
      input.automaticGates.default_install_control_panel_registration = false;
    },
    (input) => {
      input.migrationReport.checks[0].passed = false;
    },
    (input) => {
      input.releaseEvidence.upgradeRollbackDrillVerified = false;
    },
  ];
  for (const mutate of mutations) {
    const input = buildInput();
    mutate(input);
    assert.equal(upgradeCompletionAttestationMatches(input), false);
  }
});

test("packet records missing real materials without allowing completion", () => {
  const report = migrationReport();
  const reportBytes = Buffer.from(JSON.stringify(report, null, 2));
  const packet = createReleaseUpgradeCompletionPacket({
    manifest: manifest(),
    manifestSha256: MANIFEST_SHA256,
    releasePolicy: policy(),
    releasePolicySha256: POLICY_SHA256,
    evidenceMaterials: materialInputs(reportBytes, "authenticV132MigrationReport"),
  });
  assert.equal(packet.requirements.materialsComplete, false);

  const input = buildInput();
  input.packet = packet;
  input.expectedPacket = structuredClone(packet);
  assert.equal(upgradeCompletionAttestationMatches(input), false);
});
