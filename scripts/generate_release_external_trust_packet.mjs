import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = path.resolve(import.meta.dirname, "..");
const releaseRoot = path.join(projectRoot, "src-tauri", "target", "release");
const manifestPath = path.join(releaseRoot, "release-manifest.json");
const policyPath = path.join(projectRoot, "docs", "release", "RELEASE_POLICY_V1.json");
const outputPath = path.join(releaseRoot, "release-external-trust-test-packet.json");

export const EXTERNAL_TRUST_ATTESTATION_TEXT =
  "I attest that the recorded SmartScreen and security-product observations were performed by the named human testers on the exact candidate artifacts and clean Windows environments described by this packet, with no omitted detection or unresolved result.";

export const SMARTSCREEN_STAGES = [
  "internetZoneTransfer",
  "installerLaunch",
  "install",
  "firstStart",
  "residentOperation",
  "uninstall",
];

export const SECURITY_PRODUCT_STAGES = [
  "preInstallScan",
  "installerLaunch",
  "install",
  "firstStart",
  "residentOperation",
  "uninstall",
  "postUninstallScan",
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

export function createReleaseExternalTrustPacket({
  manifest,
  manifestSha256,
  releasePolicy,
  releasePolicySha256,
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
    !Number.isInteger(releasePolicy.manualReleaseGates?.minimumThirdPartySecurityProducts) ||
    releasePolicy.manualReleaseGates.minimumThirdPartySecurityProducts < 2 ||
    releasePolicy.manualReleaseGates.requireSmartScreenCleanMachineObservation !== true
  ) {
    throw new Error("external_trust_packet_input_schema_mismatch");
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
      throw new Error("external_trust_packet_artifact_mismatch");
    }
    return { id, bytes: artifact.bytes, sha256: artifact.sha256 };
  });
  return {
    schemaVersion: 1,
    mode: "release_external_trust_test_packet",
    candidate: {
      productVersion: manifest.productVersion,
      manifestSha256,
      releasePolicySha256,
      releaseArtifacts,
    },
    requirements: {
      smartScreen: {
        cleanMachineRequired: true,
        internetZoneMarkRequired: true,
        previousYuanyuanInstallForbidden: true,
        previousCandidateExecutionForbidden: true,
        networkReputationRequired: true,
        requiredPromptDisposition: "no_warning",
        stages: SMARTSCREEN_STAGES,
      },
      thirdPartySecurity: {
        minimumDistinctProducts:
          releasePolicy.manualReleaseGates.minimumThirdPartySecurityProducts,
        microsoftDefenderDoesNotCountAsThirdParty: true,
        realTimeProtectionRequired: true,
        zeroDetectionsRequired: true,
        stages: SECURITY_PRODUCT_STAGES,
      },
    },
    reviewContract: {
      requiredTesterFields: ["name", "role", "organization", "humanTester"],
      requiredEnvironmentFields: [
        "machineAlias",
        "windowsEdition",
        "windowsVersion",
        "osBuild",
        "accountType",
        "cleanSnapshotSha256",
      ],
      minimumEvidenceReferencesPerObservation: 2,
      requiredEvidenceReference:
        "docs/release/P0_RELEASE_SIGNING_AND_FALSE_POSITIVE_SOP.md",
      attestationText: EXTERNAL_TRUST_ATTESTATION_TEXT,
    },
  };
}

export function canonicalExternalTrustPacketText(packet) {
  return `${JSON.stringify(packet, null, 2)}\n`;
}

export async function buildReleaseExternalTrustPacket() {
  const [manifestBytes, policyBytes] = await Promise.all([
    readFile(manifestPath),
    readFile(policyPath),
  ]);
  return createReleaseExternalTrustPacket({
    manifest: readJsonBytes(manifestBytes),
    manifestSha256: sha256(manifestBytes),
    releasePolicy: readJsonBytes(policyBytes),
    releasePolicySha256: sha256(policyBytes),
  });
}

export async function main(args = process.argv.slice(2)) {
  if (args.some((arg) => arg !== "--check") || args.length > 1) {
    throw new Error(
      "usage: node scripts/generate_release_external_trust_packet.mjs [--check]",
    );
  }
  const packet = await buildReleaseExternalTrustPacket();
  const expected = canonicalExternalTrustPacketText(packet);
  if (args.includes("--check")) {
    const existing = (await readFile(outputPath, "utf8")).replace(/^\uFEFF/, "");
    if (existing !== expected) throw new Error("release_external_trust_packet_is_stale");
    process.stdout.write(
      `Release external trust packet is current: ${sha256(Buffer.from(expected))}.\n`,
    );
    return packet;
  }
  await writeFile(outputPath, expected, "utf8");
  process.stdout.write(`Release external trust packet written: ${outputPath}\n`);
  return packet;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  main().catch((error) => {
    process.stderr.write(`Release external trust packet failed: ${error.message}\n`);
    process.exitCode = 2;
  });
}
