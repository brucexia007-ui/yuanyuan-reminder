import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = path.resolve(import.meta.dirname, "..");
const releaseRoot = path.join(projectRoot, "src-tauri", "target", "release");
const manifestPath = path.join(releaseRoot, "release-manifest.json");
const policyPath = path.join(projectRoot, "docs", "release", "RELEASE_POLICY_V1.json");
const outputPath = path.join(releaseRoot, "release-upgrade-completion-packet.json");

export const UPGRADE_COMPLETION_ATTESTATION_TEXT =
  "I attest that the named human tester completed the exact-candidate default-path registration, authentic v1.3.2 database upgrade, physical power-loss or hard-reset recovery, real Windows restart recovery, signed-candidate revalidation, and safe rollback scenarios described by this packet, restored only owned test data, and omitted no unresolved result.";

export const REQUIRED_UPGRADE_AUTOMATIC_GATES = [
  "isolated_installer_transition_probe",
  "default_install_path_transition_probe",
  "default_install_control_panel_registration",
  "isolated_install_failure_recovery_probe",
  "default_release_first_start_database_recovery",
  "uninstall_data_choice_probe",
];

const MATERIALS = [
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

function exact(value, expected) {
  return JSON.stringify(value) === JSON.stringify(expected);
}

function readJsonBytes(bytes) {
  return JSON.parse(bytes.toString("utf8").replace(/^\uFEFF/, ""));
}

async function materialIdentity([id, relativePath]) {
  const absolutePath = path.join(projectRoot, ...relativePath.split("/"));
  try {
    const bytes = await readFile(absolutePath);
    return { id, path: relativePath, present: true, bytes: bytes.length, sha256: sha256(bytes) };
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
    return { id, path: relativePath, present: false, bytes: null, sha256: null };
  }
}

export function createReleaseUpgradeCompletionPacket({
  manifest,
  manifestSha256,
  releasePolicy,
  releasePolicySha256,
  evidenceMaterials,
}) {
  if (
    manifest?.schemaVersion !== 1 ||
    typeof manifest.productVersion !== "string" ||
    !Number.isFinite(Date.parse(manifest.generatedAt)) ||
    !Array.isArray(manifest.artifacts) ||
    !/^[A-F0-9]{64}$/.test(manifestSha256) ||
    releasePolicy?.schemaVersion !== 1 ||
    !/^[A-F0-9]{64}$/.test(releasePolicySha256) ||
    !Array.isArray(releasePolicy.releaseArtifacts) ||
    !exact(releasePolicy.releaseArtifacts, [
      "stable_core",
      "nsis_installed_core",
      "nsis_installer",
    ]) ||
    releasePolicy.manualReleaseGates?.requireUpgradeRollbackDrill !== true ||
    !Array.isArray(evidenceMaterials) ||
    evidenceMaterials.length !== MATERIALS.length ||
    !evidenceMaterials.every((material, index) => {
      const [expectedId, expectedPath] = MATERIALS[index];
      return (
        material?.id === expectedId &&
        material.path === expectedPath &&
        typeof material.present === "boolean" &&
        (material.present
          ? Number.isInteger(material.bytes) &&
            material.bytes > 0 &&
            /^[A-F0-9]{64}$/.test(material.sha256)
          : material.bytes === null && material.sha256 === null)
      );
    })
  ) {
    throw new Error("upgrade_completion_packet_input_schema_mismatch");
  }

  const artifacts = new Map(manifest.artifacts.map((artifact) => [artifact.id, artifact]));
  const releaseArtifacts = releasePolicy.releaseArtifacts.map((id) => {
    const artifact = artifacts.get(id);
    if (
      !artifact ||
      !Number.isInteger(artifact.bytes) ||
      artifact.bytes <= 0 ||
      !/^[A-F0-9]{64}$/.test(artifact.sha256)
    ) {
      throw new Error("upgrade_completion_packet_artifact_mismatch");
    }
    return { id, bytes: artifact.bytes, sha256: artifact.sha256 };
  });

  return {
    schemaVersion: 1,
    mode: "release_upgrade_completion_packet",
    candidate: {
      productVersion: manifest.productVersion,
      manifestSha256,
      releasePolicySha256,
      releaseArtifacts,
    },
    historicalRelease: {
      version: "1.3.2",
      databaseSchemaVersion: 6,
      installerSha256: "FD08FAC044D32995FA7BB153A06E5ED092FCCA827DCAA4154608F579541FF4F1",
      installedCoreSha256: "864209F2D6385205CA15E35677C64BA94388B315DB555EBA08369D57717F3FCF",
    },
    evidenceMaterials,
    requirements: {
      materialsComplete: evidenceMaterials.every((material) => material.present),
      requiredAutomaticGates: REQUIRED_UPGRADE_AUTOMATIC_GATES,
      requireSignedCandidateAndRfc3161Evidence: true,
      requireAuthenticHistoricalDatabase: true,
      requireSourceApplicationDisplayedVersion: true,
      requireSourceApplicationFullyExitedBeforeCopy: true,
      requirePhysicalPowerLossOrHypervisorHardReset: true,
      gracefulShutdownCannotSatisfyPowerLoss: true,
      requireActualWindowsRestart: true,
      requirePreUpgradeDatabaseCopyBeforeHistoricalRollback: true,
      historicalVersionMustNotOpenMigratedV11Database: true,
      requireHumanTester: true,
      minimumEvidenceReferencesPerScenario: 2,
      requiredEvidenceReference:
        "docs/P0_RELEASE_UPGRADE_ROLLBACK_PROBE_2026-08-09.md",
      attestationText: UPGRADE_COMPLETION_ATTESTATION_TEXT,
    },
  };
}

export function canonicalUpgradeCompletionPacketText(packet) {
  return `${JSON.stringify(packet, null, 2)}\n`;
}

export async function buildReleaseUpgradeCompletionPacket() {
  const [manifestBytes, policyBytes, evidenceMaterials] = await Promise.all([
    readFile(manifestPath),
    readFile(policyPath),
    Promise.all(MATERIALS.map(materialIdentity)),
  ]);
  return createReleaseUpgradeCompletionPacket({
    manifest: readJsonBytes(manifestBytes),
    manifestSha256: sha256(manifestBytes),
    releasePolicy: readJsonBytes(policyBytes),
    releasePolicySha256: sha256(policyBytes),
    evidenceMaterials,
  });
}

export async function main(args = process.argv.slice(2)) {
  if (args.some((arg) => arg !== "--check") || args.length > 1) {
    throw new Error(
      "usage: node scripts/generate_release_upgrade_completion_packet.mjs [--check]",
    );
  }
  const packet = await buildReleaseUpgradeCompletionPacket();
  const expected = canonicalUpgradeCompletionPacketText(packet);
  if (args.includes("--check")) {
    const existing = (await readFile(outputPath, "utf8")).replace(/^\uFEFF/, "");
    if (existing !== expected) throw new Error("release_upgrade_completion_packet_is_stale");
    process.stdout.write(
      `Release upgrade completion packet is current: ${sha256(Buffer.from(expected))}.\n`,
    );
    return packet;
  }
  await writeFile(outputPath, expected, "utf8");
  process.stdout.write(`Release upgrade completion packet written: ${outputPath}\n`);
  return packet;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  main().catch((error) => {
    process.stderr.write(`Release upgrade completion packet failed: ${error.message}\n`);
    process.exitCode = 2;
  });
}
