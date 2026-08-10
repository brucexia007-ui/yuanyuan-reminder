import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  REQUIRED_UPGRADE_AUTOMATIC_GATES,
  UPGRADE_COMPLETION_ATTESTATION_TEXT,
  buildReleaseUpgradeCompletionPacket,
  canonicalUpgradeCompletionPacketText,
} from "./generate_release_upgrade_completion_packet.mjs";

export const UPGRADE_COMPLETION_PACKET_REFERENCE =
  "src-tauri/target/release/release-upgrade-completion-packet.json";
export const UPGRADE_COMPLETION_ATTESTATION_REFERENCE =
  "docs/release/RELEASE_UPGRADE_COMPLETION_ATTESTATION_V1.json";
const REQUIRED_UPGRADE_REFERENCE =
  "docs/P0_RELEASE_UPGRADE_ROLLBACK_PROBE_2026-08-09.md";
const MIGRATION_REPORT_PATH =
  "src-tauri/target/release/release-authentic-v132-database-migration.json";
const MIGRATION_CHECKS = [
  "source_read_only",
  "source_integrity",
  "v132_schema_identity",
  "production_migration",
  "row_preservation",
  "backup_restore",
  "failed_restore_rollback",
  "post_restore_health",
];

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex").toUpperCase();
}

function exact(value, expected) {
  return JSON.stringify(value) === JSON.stringify(expected);
}

function hasExactKeys(value, keys) {
  return (
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    exact(Object.keys(value).sort(), [...keys].sort())
  );
}

function validText(value, minimum, maximum) {
  return (
    typeof value === "string" &&
    value === value.trim() &&
    value.length >= minimum &&
    value.length <= maximum &&
    !/[\u0000-\u001F\u007F]/.test(value)
  );
}

function validHuman(value, flagName) {
  if (
    !hasExactKeys(value, ["name", "role", "organization", flagName]) ||
    !validText(value.name, 3, 80) ||
    !validText(value.role, 3, 80) ||
    !validText(value.organization, 2, 120) ||
    value[flagName] !== true
  ) {
    return false;
  }
  const combined = `${value.name} ${value.role} ${value.organization}`;
  return !/(?:\bcodex\b|\bchatgpt\b|\bai\b|\bbot\b|automated|automation|人工智能|自动化)/i.test(
    combined,
  );
}

function validEvidenceReference(reference) {
  if (typeof reference !== "string" || reference.length < 5 || reference.length > 300) {
    return false;
  }
  if (/^https:\/\//.test(reference)) return true;
  return (
    !path.isAbsolute(reference) &&
    !reference.includes("\\") &&
    !reference.split("/").includes("..") &&
    (reference.startsWith("docs/") || reference.startsWith("src-tauri/target/release/"))
  );
}

function validReferences(references) {
  return (
    Array.isArray(references) &&
    references.length >= 2 &&
    references.every(validEvidenceReference) &&
    exact(
      references,
      [...new Set(references)].sort((left, right) => left.localeCompare(right, "en")),
    ) &&
    references.includes(REQUIRED_UPGRADE_REFERENCE)
  );
}

function validCounts(value) {
  return (
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    Object.keys(value).length > 0 &&
    Object.entries(value).every(
      ([name, count]) => /^[a-z][a-z0-9_]{0,63}$/.test(name) && Number.isInteger(count) && count >= 0,
    )
  );
}

export function authenticMigrationReportMatches({
  report,
  reportBytes,
  material,
  manifestGeneratedAt,
  now = new Date(),
}) {
  if (
    !material?.present ||
    material.path !== MIGRATION_REPORT_PATH ||
    reportBytes?.length !== material.bytes ||
    sha256(reportBytes) !== material.sha256 ||
    !hasExactKeys(report, [
      "schemaVersion",
      "status",
      "generatedAt",
      "expectedSourceRelease",
      "sourceReleaseEvidence",
      "sourceReleaseEvidenceLimit",
      "sourceFileName",
      "sourceSizeBytes",
      "sourceSha256",
      "sourceDatabaseVersion",
      "migratedDatabaseVersion",
      "sourceLogicalSha256",
      "migratedMatchedSourceRowsSha256",
      "sourceTableCounts",
      "migratedTableCounts",
      "checks",
      "privacy",
    ]) ||
    report.schemaVersion !== 1 ||
    report.status !== "passed" ||
    report.expectedSourceRelease !== "1.3.2" ||
    report.sourceReleaseEvidence !== "operator_attested_copy_plus_schema_version_6" ||
    report.sourceReleaseEvidenceLimit !==
      "Schema version 6 is necessary but does not independently prove which application release created the fixture." ||
    !/^[^\\/:*?\"<>|]{1,255}$/.test(report.sourceFileName) ||
    !Number.isInteger(report.sourceSizeBytes) ||
    report.sourceSizeBytes < 1024 * 1024 ||
    report.sourceSizeBytes > 512 * 1024 * 1024 ||
    !/^[A-F0-9]{64}$/.test(report.sourceSha256) ||
    report.sourceDatabaseVersion !== 6 ||
    report.migratedDatabaseVersion !== 11 ||
    !/^[A-F0-9]{64}$/.test(report.sourceLogicalSha256) ||
    report.migratedMatchedSourceRowsSha256 !== report.sourceLogicalSha256 ||
    !validCounts(report.sourceTableCounts) ||
    !validCounts(report.migratedTableCounts) ||
    !Array.isArray(report.checks) ||
    !exact(report.checks.map((check) => check?.id), MIGRATION_CHECKS) ||
    !report.checks.every(
      (check) =>
        hasExactKeys(check, ["id", "passed", "detail"]) &&
        check.passed === true &&
        validText(check.detail, 5, 300),
    ) ||
    report.privacy !==
      "Contains only file identity, schema versions, aggregate table counts and fixed check results; no user content or source path."
  ) {
    return false;
  }
  const generatedAt = Date.parse(report.generatedAt);
  const candidateGeneratedAt = Date.parse(manifestGeneratedAt);
  return (
    Number.isFinite(generatedAt) &&
    Number.isFinite(candidateGeneratedAt) &&
    generatedAt >= candidateGeneratedAt &&
    generatedAt <= now.getTime() + 5 * 60 * 1000
  );
}

function validEnvironment(environment) {
  return (
    hasExactKeys(environment, [
      "machineAlias",
      "windowsEdition",
      "windowsVersion",
      "osBuild",
      "accountType",
      "cleanSnapshotSha256",
    ]) &&
    validText(environment.machineAlias, 2, 80) &&
    validText(environment.windowsEdition, 3, 120) &&
    validText(environment.windowsVersion, 2, 80) &&
    validText(environment.osBuild, 3, 80) &&
    ["standard_user", "administrator"].includes(environment.accountType) &&
    /^[A-F0-9]{64}$/.test(environment.cleanSnapshotSha256)
  );
}

function validScenario(scenario, keys) {
  return hasExactKeys(scenario, [...keys, "evidenceReferences", "passed"]) &&
    validReferences(scenario.evidenceReferences) &&
    scenario.passed === true;
}

export function upgradeCompletionAttestationMatches({
  attestation,
  packet,
  expectedPacket,
  packetSha256,
  manifest,
  manifestSha256,
  releaseEvidence,
  automaticGates,
  signatureGate,
  signingProtocolEvidenceValid,
  migrationReport,
  migrationReportBytes,
  now = new Date(),
}) {
  if (
    !exact(packet, expectedPacket) ||
    packet.requirements.materialsComplete !== true ||
    !hasExactKeys(attestation, [
      "schemaVersion",
      "mode",
      "testedAt",
      "packetSha256",
      "candidateManifestSha256",
      "tester",
      "environment",
      "authenticHistoricalDatabase",
      "scenarios",
      "unresolvedFindings",
      "evidenceReferences",
      "attestationText",
    ]) ||
    attestation.schemaVersion !== 1 ||
    attestation.mode !== "release_upgrade_completion_attestation" ||
    attestation.packetSha256 !== packetSha256 ||
    attestation.candidateManifestSha256 !== manifestSha256 ||
    attestation.candidateManifestSha256 !== packet.candidate.manifestSha256 ||
    attestation.attestationText !== UPGRADE_COMPLETION_ATTESTATION_TEXT ||
    !validHuman(attestation.tester, "humanTester") ||
    !validEnvironment(attestation.environment)
  ) {
    return false;
  }
  const testedAt = Date.parse(attestation.testedAt);
  const manifestGeneratedAt = Date.parse(manifest.generatedAt);
  if (
    !Number.isFinite(testedAt) ||
    !Number.isFinite(manifestGeneratedAt) ||
    testedAt < manifestGeneratedAt ||
    testedAt > now.getTime() + 5 * 60 * 1000
  ) {
    return false;
  }

  if (
    !hasExactKeys(automaticGates, REQUIRED_UPGRADE_AUTOMATIC_GATES) ||
    !REQUIRED_UPGRADE_AUTOMATIC_GATES.every((id) => automaticGates[id] === true) ||
    !hasExactKeys(signatureGate, [
      "signed",
      "timestamped",
      "sameCertificate",
      "identityFrozen",
      "publisherMatches",
    ]) ||
    !Object.values(signatureGate).every((value) => value === true) ||
    signingProtocolEvidenceValid !== true
  ) {
    return false;
  }

  const migrationMaterial = packet.evidenceMaterials.find(
    (material) => material.id === "authenticV132MigrationReport",
  );
  if (
    !authenticMigrationReportMatches({
      report: migrationReport,
      reportBytes: migrationReportBytes,
      material: migrationMaterial,
      manifestGeneratedAt: manifest.generatedAt,
      now,
    }) ||
    !hasExactKeys(attestation.authenticHistoricalDatabase, [
      "migrationReportSha256",
      "sourceDatabaseSha256",
      "sourceSizeBytes",
      "sourceApplicationDisplayedVersion",
      "sourceApplicationFullyExitedBeforeCopy",
      "sourceProvider",
      "sourceDatabaseNotCommitted",
    ]) ||
    attestation.authenticHistoricalDatabase.migrationReportSha256 !== migrationMaterial.sha256 ||
    attestation.authenticHistoricalDatabase.sourceDatabaseSha256 !== migrationReport.sourceSha256 ||
    attestation.authenticHistoricalDatabase.sourceSizeBytes !== migrationReport.sourceSizeBytes ||
    attestation.authenticHistoricalDatabase.sourceApplicationDisplayedVersion !== "1.3.2" ||
    attestation.authenticHistoricalDatabase.sourceApplicationFullyExitedBeforeCopy !== true ||
    !validHuman(attestation.authenticHistoricalDatabase.sourceProvider, "humanProvider") ||
    attestation.authenticHistoricalDatabase.sourceDatabaseNotCommitted !== true
  ) {
    return false;
  }

  const scenarios = attestation.scenarios;
  if (
    !hasExactKeys(scenarios, [
      "defaultPathRegistration",
      "authenticDatabaseUpgrade",
      "physicalPowerLossRecovery",
      "windowsRestartRecovery",
      "safeHistoricalRollback",
      "signedCandidateRevalidatedAfterRecovery",
    ]) ||
    !validScenario(scenarios.defaultPathRegistration, [
      "controlPanelEntryObserved",
      "displayedVersion",
      "installLocationMatched",
      "uninstallCommandMatched",
    ]) ||
    scenarios.defaultPathRegistration.controlPanelEntryObserved !== true ||
    scenarios.defaultPathRegistration.displayedVersion !== packet.candidate.productVersion ||
    scenarios.defaultPathRegistration.installLocationMatched !== true ||
    scenarios.defaultPathRegistration.uninstallCommandMatched !== true ||
    !validScenario(scenarios.authenticDatabaseUpgrade, [
      "sourceSchemaVersion",
      "migratedSchemaVersion",
      "sourceLogicalSha256",
      "migratedMatchedSourceRowsSha256",
      "quickCheckOk",
      "allRowsPreserved",
    ]) ||
    scenarios.authenticDatabaseUpgrade.sourceSchemaVersion !== 6 ||
    scenarios.authenticDatabaseUpgrade.migratedSchemaVersion !== 11 ||
    scenarios.authenticDatabaseUpgrade.sourceLogicalSha256 !== migrationReport.sourceLogicalSha256 ||
    scenarios.authenticDatabaseUpgrade.migratedMatchedSourceRowsSha256 !==
      migrationReport.migratedMatchedSourceRowsSha256 ||
    scenarios.authenticDatabaseUpgrade.quickCheckOk !== true ||
    scenarios.authenticDatabaseUpgrade.allRowsPreserved !== true ||
    !validScenario(scenarios.physicalPowerLossRecovery, [
      "interruptionStage",
      "physicalPowerLossOrHypervisorHardReset",
      "gracefulShutdownRequested",
      "writeBoundaryObserved",
      "recoveryUsedUnmodifiedCandidate",
      "recoveredToVisibleWindow",
      "quickCheckOk",
      "dataPreserved",
    ]) ||
    !["installer_file_write", "database_migration_write", "first_start_wal_write"].includes(
      scenarios.physicalPowerLossRecovery.interruptionStage,
    ) ||
    scenarios.physicalPowerLossRecovery.physicalPowerLossOrHypervisorHardReset !== true ||
    scenarios.physicalPowerLossRecovery.gracefulShutdownRequested !== false ||
    scenarios.physicalPowerLossRecovery.writeBoundaryObserved !== true ||
    scenarios.physicalPowerLossRecovery.recoveryUsedUnmodifiedCandidate !== true ||
    scenarios.physicalPowerLossRecovery.recoveredToVisibleWindow !== true ||
    scenarios.physicalPowerLossRecovery.quickCheckOk !== true ||
    scenarios.physicalPowerLossRecovery.dataPreserved !== true ||
    !validScenario(scenarios.windowsRestartRecovery, [
      "restartStage",
      "actualWindowsRestart",
      "applicationProcessStoppedByRestart",
      "recoveredToVisibleWindow",
      "quickCheckOk",
      "dataPreserved",
    ]) ||
    !["after_upgrade_before_first_start", "during_first_start_migration"].includes(
      scenarios.windowsRestartRecovery.restartStage,
    ) ||
    scenarios.windowsRestartRecovery.actualWindowsRestart !== true ||
    scenarios.windowsRestartRecovery.applicationProcessStoppedByRestart !== true ||
    scenarios.windowsRestartRecovery.recoveredToVisibleWindow !== true ||
    scenarios.windowsRestartRecovery.quickCheckOk !== true ||
    scenarios.windowsRestartRecovery.dataPreserved !== true ||
    !validScenario(scenarios.safeHistoricalRollback, [
      "preUpgradeDatabaseCopyCreated",
      "restoredPreUpgradeDatabaseCopy",
      "migratedV11DatabaseOpenedByHistoricalVersion",
      "historicalVersionLaunchedAfterRestore",
      "restoredLogicalSha256",
    ]) ||
    scenarios.safeHistoricalRollback.preUpgradeDatabaseCopyCreated !== true ||
    scenarios.safeHistoricalRollback.restoredPreUpgradeDatabaseCopy !== true ||
    scenarios.safeHistoricalRollback.migratedV11DatabaseOpenedByHistoricalVersion !== false ||
    scenarios.safeHistoricalRollback.historicalVersionLaunchedAfterRestore !== true ||
    scenarios.safeHistoricalRollback.restoredLogicalSha256 !== migrationReport.sourceLogicalSha256 ||
    scenarios.signedCandidateRevalidatedAfterRecovery !== true
  ) {
    return false;
  }

  const installer = manifest.artifacts?.find((artifact) => artifact.id === "nsis_installer");
  return (
    releaseEvidence?.upgradeRollbackDrillVerified === true &&
    releaseEvidence.releaseCandidateSha256 === installer?.sha256 &&
    Array.isArray(releaseEvidence.evidenceReferences) &&
    releaseEvidence.evidenceReferences.includes(UPGRADE_COMPLETION_PACKET_REFERENCE) &&
    releaseEvidence.evidenceReferences.includes(UPGRADE_COMPLETION_ATTESTATION_REFERENCE) &&
    Array.isArray(attestation.unresolvedFindings) &&
    attestation.unresolvedFindings.length === 0 &&
    validReferences(attestation.evidenceReferences)
  );
}

async function readJsonBytes(filePath) {
  const bytes = await readFile(filePath);
  return {
    bytes,
    value: JSON.parse(bytes.toString("utf8").replace(/^\uFEFF/, "")),
  };
}

export async function verifyReleaseUpgradeCompletionFiles() {
  const projectRoot = path.resolve(import.meta.dirname, "..");
  const releaseRoot = path.join(projectRoot, "src-tauri", "target", "release");
  const paths = {
    packet: path.join(releaseRoot, "release-upgrade-completion-packet.json"),
    attestation: path.join(
      projectRoot,
      "docs",
      "release",
      "RELEASE_UPGRADE_COMPLETION_ATTESTATION_V1.json",
    ),
    manifest: path.join(releaseRoot, "release-manifest.json"),
    evidence: path.join(projectRoot, "docs", "release", "RELEASE_EVIDENCE_STATUS_V1.json"),
    preflight: path.join(releaseRoot, "release-preflight.json"),
    migration: path.join(releaseRoot, "release-authentic-v132-database-migration.json"),
  };
  const [packetFile, attestationFile, manifestFile, evidenceFile, preflightFile, migrationFile] =
    await Promise.all([
      readJsonBytes(paths.packet),
      readJsonBytes(paths.attestation),
      readJsonBytes(paths.manifest),
      readJsonBytes(paths.evidence),
      readJsonBytes(paths.preflight),
      readJsonBytes(paths.migration),
    ]);
  const expectedPacket = await buildReleaseUpgradeCompletionPacket();
  if (
    packetFile.bytes.toString("utf8").replace(/^\uFEFF/, "") !==
    canonicalUpgradeCompletionPacketText(expectedPacket)
  ) {
    throw new Error("release_upgrade_completion_packet_is_stale");
  }
  const checks = new Map(preflightFile.value.checks.map((check) => [check.id, check.status]));
  const automaticGates = Object.fromEntries(
    REQUIRED_UPGRADE_AUTOMATIC_GATES.map((id) => [id, checks.get(id) === "passed"]),
  );
  const signatureGate = {
    signed: checks.get("release_artifacts_signed") === "passed",
    timestamped: checks.get("trusted_timestamp_present") === "passed",
    sameCertificate: checks.get("one_certificate_per_release") === "passed",
    identityFrozen: checks.get("publisher_identity_frozen") === "passed",
    publisherMatches: checks.get("publisher_identity_matches") === "passed",
  };
  if (
    !upgradeCompletionAttestationMatches({
      attestation: attestationFile.value,
      packet: packetFile.value,
      expectedPacket,
      packetSha256: sha256(packetFile.bytes),
      manifest: manifestFile.value,
      manifestSha256: sha256(manifestFile.bytes),
      releaseEvidence: evidenceFile.value,
      automaticGates,
      signatureGate,
      signingProtocolEvidenceValid: checks.get("rfc3161_protocol_verified") === "passed",
      migrationReport: migrationFile.value,
      migrationReportBytes: migrationFile.bytes,
    })
  ) {
    throw new Error("release_upgrade_completion_attestation_mismatch");
  }
  return attestationFile.value;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  verifyReleaseUpgradeCompletionFiles()
    .then(() => {
      process.stdout.write("Release upgrade completion evidence verified.\n");
    })
    .catch((error) => {
      process.stderr.write(`Release upgrade completion verification failed: ${error.message}\n`);
      process.exitCode = 2;
    });
}
