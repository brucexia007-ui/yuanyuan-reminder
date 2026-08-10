import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  EXTERNAL_TRUST_ATTESTATION_TEXT,
  SECURITY_PRODUCT_STAGES,
  SMARTSCREEN_STAGES,
  buildReleaseExternalTrustPacket,
  canonicalExternalTrustPacketText,
} from "./generate_release_external_trust_packet.mjs";

export const EXTERNAL_TRUST_PACKET_REFERENCE =
  "src-tauri/target/release/release-external-trust-test-packet.json";
export const EXTERNAL_TRUST_ATTESTATION_REFERENCE =
  "docs/release/RELEASE_EXTERNAL_TRUST_ATTESTATION_V1.json";
const REQUIRED_REFERENCE = "docs/release/P0_RELEASE_SIGNING_AND_FALSE_POSITIVE_SOP.md";

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

function validHumanTester(tester) {
  if (
    !hasExactKeys(tester, ["name", "role", "organization", "humanTester"]) ||
    !validText(tester.name, 3, 80) ||
    !validText(tester.role, 3, 80) ||
    !validText(tester.organization, 2, 120) ||
    tester.humanTester !== true
  ) {
    return false;
  }
  return !/(?:\bcodex\b|\bchatgpt\b|\bai\b|\bbot\b|automated|automation|人工智能|自动化)/i.test(
    `${tester.name} ${tester.role} ${tester.organization}`,
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
    validText(environment.machineAlias, 3, 80) &&
    validText(environment.windowsEdition, 3, 80) &&
    validText(environment.windowsVersion, 2, 40) &&
    validText(environment.osBuild, 3, 40) &&
    ["standard_user", "administrator"].includes(environment.accountType) &&
    /^[A-F0-9]{64}$/.test(environment.cleanSnapshotSha256)
  );
}

function validReference(reference) {
  if (typeof reference !== "string" || reference.length < 5 || reference.length > 300) {
    return false;
  }
  if (reference.startsWith("https://")) return true;
  return (
    !path.isAbsolute(reference) &&
    !reference.includes("\\") &&
    !reference.split("/").includes("..") &&
    reference.startsWith("docs/")
  );
}

function validReferences(references) {
  return (
    Array.isArray(references) &&
    references.length >= 2 &&
    references.every(validReference) &&
    exact(
      references,
      [...new Set(references)].sort((left, right) => left.localeCompare(right, "en")),
    ) &&
    references.includes(REQUIRED_REFERENCE)
  );
}

function validTimestamp(value, manifestGeneratedAt, now) {
  const timestamp = Date.parse(value);
  const manifestTimestamp = Date.parse(manifestGeneratedAt);
  return (
    Number.isFinite(timestamp) &&
    Number.isFinite(manifestTimestamp) &&
    timestamp >= manifestTimestamp &&
    timestamp <= now.getTime() + 5 * 60 * 1000
  );
}

function stagesPassed(stages, expectedNames) {
  return (
    hasExactKeys(stages, expectedNames) &&
    expectedNames.every((stage) => stages[stage] === "passed")
  );
}

function attestationBindingsMatch({
  attestation,
  packet,
  expectedPacket,
  packetSha256,
  manifestSha256,
}) {
  return (
    exact(packet, expectedPacket) &&
    hasExactKeys(attestation, [
      "schemaVersion",
      "mode",
      "packetSha256",
      "candidateManifestSha256",
      "smartScreen",
      "securityProducts",
      "attestationText",
    ]) &&
    attestation.schemaVersion === 1 &&
    attestation.mode === "release_external_trust_attestation" &&
    attestation.packetSha256 === packetSha256 &&
    attestation.candidateManifestSha256 === manifestSha256 &&
    attestation.candidateManifestSha256 === packet.candidate.manifestSha256 &&
    attestation.attestationText === EXTERNAL_TRUST_ATTESTATION_TEXT &&
    Array.isArray(attestation.securityProducts)
  );
}

function smartScreenObservationMatches(observation, packet, manifest, now) {
  const installer = packet.candidate.releaseArtifacts.find(
    (artifact) => artifact.id === "nsis_installer",
  );
  return (
    hasExactKeys(observation, [
      "testedAt",
      "tester",
      "environment",
      "candidateInstallerSha256",
      "networkReputationAvailable",
      "previousYuanyuanInstall",
      "previousCandidateExecution",
      "markOfWebPresent",
      "sourceZone",
      "stages",
      "promptDisposition",
      "evidenceReferences",
      "passed",
    ]) &&
    validTimestamp(observation.testedAt, manifest.generatedAt, now) &&
    validHumanTester(observation.tester) &&
    validEnvironment(observation.environment) &&
    observation.candidateInstallerSha256 === installer?.sha256 &&
    observation.networkReputationAvailable === true &&
    observation.previousYuanyuanInstall === false &&
    observation.previousCandidateExecution === false &&
    observation.markOfWebPresent === true &&
    observation.sourceZone === "internet" &&
    stagesPassed(observation.stages, SMARTSCREEN_STAGES) &&
    observation.promptDisposition === "no_warning" &&
    validReferences(observation.evidenceReferences) &&
    observation.passed === true
  );
}

function securityProductObservationMatches(observation, packet, manifest, now) {
  return (
    hasExactKeys(observation, [
      "productName",
      "productVersion",
      "engineVersion",
      "definitionVersion",
      "testedAt",
      "tester",
      "environment",
      "candidateArtifacts",
      "realTimeProtectionEnabled",
      "stages",
      "detections",
      "evidenceReferences",
      "passed",
    ]) &&
    validText(observation.productName, 2, 100) &&
    !/(?:windows|microsoft) defender/i.test(observation.productName) &&
    validText(observation.productVersion, 1, 80) &&
    validText(observation.engineVersion, 1, 80) &&
    validText(observation.definitionVersion, 1, 120) &&
    validTimestamp(observation.testedAt, manifest.generatedAt, now) &&
    validHumanTester(observation.tester) &&
    validEnvironment(observation.environment) &&
    exact(observation.candidateArtifacts, packet.candidate.releaseArtifacts) &&
    observation.realTimeProtectionEnabled === true &&
    stagesPassed(observation.stages, SECURITY_PRODUCT_STAGES) &&
    Array.isArray(observation.detections) &&
    observation.detections.length === 0 &&
    validReferences(observation.evidenceReferences) &&
    observation.passed === true
  );
}

export function smartScreenExternalEvidenceMatches({
  attestation,
  packet,
  expectedPacket,
  packetSha256,
  manifest,
  manifestSha256,
  releaseEvidence,
  now = new Date(),
}) {
  const installer = manifest.artifacts?.find((artifact) => artifact.id === "nsis_installer");
  return (
    releaseEvidence?.smartScreenCleanMachineObserved === true &&
    releaseEvidence.releaseCandidateSha256 === installer?.sha256 &&
    Array.isArray(releaseEvidence.evidenceReferences) &&
    releaseEvidence.evidenceReferences.includes(EXTERNAL_TRUST_PACKET_REFERENCE) &&
    releaseEvidence.evidenceReferences.includes(EXTERNAL_TRUST_ATTESTATION_REFERENCE) &&
    attestationBindingsMatch({
      attestation,
      packet,
      expectedPacket,
      packetSha256,
      manifestSha256,
    }) &&
    smartScreenObservationMatches(attestation.smartScreen, packet, manifest, now)
  );
}

export function thirdPartySecurityExternalEvidenceMatches({
  attestation,
  packet,
  expectedPacket,
  packetSha256,
  manifest,
  manifestSha256,
  releasePolicy,
  releaseEvidence,
  now = new Date(),
}) {
  const installer = manifest.artifacts?.find((artifact) => artifact.id === "nsis_installer");
  const required = releasePolicy.manualReleaseGates?.minimumThirdPartySecurityProducts;
  if (
    !Number.isInteger(required) ||
    required < 2 ||
    releaseEvidence?.releaseCandidateSha256 !== installer?.sha256 ||
    releaseEvidence.thirdPartySecurityProductsVerified !== attestation?.securityProducts?.length ||
    releaseEvidence.thirdPartySecurityProductsVerified < required ||
    !Array.isArray(releaseEvidence.evidenceReferences) ||
    !releaseEvidence.evidenceReferences.includes(EXTERNAL_TRUST_PACKET_REFERENCE) ||
    !releaseEvidence.evidenceReferences.includes(EXTERNAL_TRUST_ATTESTATION_REFERENCE) ||
    !attestationBindingsMatch({
      attestation,
      packet,
      expectedPacket,
      packetSha256,
      manifestSha256,
    }) ||
    attestation.securityProducts.length < required
  ) {
    return false;
  }
  const names = new Set();
  for (const product of attestation.securityProducts) {
    const normalizedName = product?.productName?.trim().toLocaleLowerCase("en-US");
    if (
      typeof normalizedName !== "string" ||
      names.has(normalizedName) ||
      !securityProductObservationMatches(product, packet, manifest, now)
    ) {
      return false;
    }
    names.add(normalizedName);
  }
  return true;
}

async function readJsonBytes(filePath) {
  const bytes = await readFile(filePath);
  return {
    bytes,
    value: JSON.parse(bytes.toString("utf8").replace(/^\uFEFF/, "")),
  };
}

export async function verifyReleaseExternalTrustFiles() {
  const projectRoot = path.resolve(import.meta.dirname, "..");
  const releaseRoot = path.join(projectRoot, "src-tauri", "target", "release");
  const [packetFile, attestationFile, manifestFile, policyFile, evidenceFile] =
    await Promise.all([
      readJsonBytes(path.join(releaseRoot, "release-external-trust-test-packet.json")),
      readJsonBytes(
        path.join(
          projectRoot,
          "docs",
          "release",
          "RELEASE_EXTERNAL_TRUST_ATTESTATION_V1.json",
        ),
      ),
      readJsonBytes(path.join(releaseRoot, "release-manifest.json")),
      readJsonBytes(path.join(projectRoot, "docs", "release", "RELEASE_POLICY_V1.json")),
      readJsonBytes(
        path.join(projectRoot, "docs", "release", "RELEASE_EVIDENCE_STATUS_V1.json"),
      ),
    ]);
  const expectedPacket = await buildReleaseExternalTrustPacket();
  if (
    packetFile.bytes.toString("utf8").replace(/^\uFEFF/, "") !==
    canonicalExternalTrustPacketText(expectedPacket)
  ) {
    throw new Error("release_external_trust_packet_is_stale");
  }
  const args = {
    attestation: attestationFile.value,
    packet: packetFile.value,
    expectedPacket,
    packetSha256: sha256(packetFile.bytes),
    manifest: manifestFile.value,
    manifestSha256: sha256(manifestFile.bytes),
    releasePolicy: policyFile.value,
    releaseEvidence: evidenceFile.value,
  };
  if (
    !smartScreenExternalEvidenceMatches(args) ||
    !thirdPartySecurityExternalEvidenceMatches(args)
  ) {
    throw new Error("release_external_trust_attestation_mismatch");
  }
  return attestationFile.value;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  verifyReleaseExternalTrustFiles()
    .then((attestation) => {
      process.stdout.write(
        `Release external trust evidence verified for ${attestation.securityProducts.length} products.\n`,
      );
    })
    .catch((error) => {
      process.stderr.write(`Release external trust verification failed: ${error.message}\n`);
      process.exitCode = 2;
    });
}
