import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  SIGNING_PROTOCOL_ATTESTATION_TEXT,
  buildReleaseSigningProtocolPacket,
  canonicalSigningProtocolPacketText,
} from "./generate_release_signing_protocol_packet.mjs";

export const SIGNING_PROTOCOL_PACKET_REFERENCE =
  "src-tauri/target/release/release-signing-protocol-packet.json";
export const SIGNING_PROTOCOL_ATTESTATION_REFERENCE =
  "docs/release/RELEASE_SIGNING_PROTOCOL_ATTESTATION_V1.json";
const REQUIRED_SIGNING_REFERENCE =
  "docs/release/P0_RELEASE_SIGNING_AND_FALSE_POSITIVE_SOP.md";

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

function validHumanOperator(operator) {
  if (
    !hasExactKeys(operator, ["name", "role", "organization", "humanOperator"]) ||
    !validText(operator.name, 3, 80) ||
    !validText(operator.role, 3, 80) ||
    !validText(operator.organization, 2, 120) ||
    operator.humanOperator !== true
  ) {
    return false;
  }
  const combined = `${operator.name} ${operator.role} ${operator.organization}`;
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
    references.includes(REQUIRED_SIGNING_REFERENCE)
  );
}

function containsCredentialMaterial(attestation) {
  return /(?:password|passwd|access[_ -]?token|client[_ -]?secret|private[_ -]?key)\s*[=:]|-----BEGIN (?:PRIVATE KEY|ENCRYPTED PRIVATE KEY|PKCS12)/i.test(
    JSON.stringify(attestation),
  );
}

function validCertificateTime(value) {
  return typeof value === "string" && Number.isFinite(Date.parse(value));
}

function signatureRecordMatches(record, operation, expectedArtifact, publisherSubject) {
  return (
    record?.id === expectedArtifact.id &&
    record.status === "Valid" &&
    record.signerSubject === publisherSubject &&
    validText(record.signerThumbprint, 8, 128) &&
    validCertificateTime(record.signerNotBefore) &&
    validCertificateTime(record.signerNotAfter) &&
    record.timestampPresent === true &&
    validText(record.timestampSubject, 3, 300) &&
    validCertificateTime(record.timestampNotBefore) &&
    validCertificateTime(record.timestampNotAfter) &&
    operation.signerSubject === record.signerSubject &&
    operation.signerThumbprint === record.signerThumbprint &&
    operation.timestampSubject === record.timestampSubject &&
    operation.timestampNotBefore === record.timestampNotBefore &&
    operation.timestampNotAfter === record.timestampNotAfter
  );
}

export function signingProtocolAttestationMatches({
  attestation,
  packet,
  expectedPacket,
  packetSha256,
  manifest,
  manifestSha256,
  releasePolicy,
  signatureRecords,
  now = new Date(),
}) {
  if (
    !exact(packet, expectedPacket) ||
    !hasExactKeys(attestation, [
      "schemaVersion",
      "mode",
      "attestedAt",
      "packetSha256",
      "candidateManifestSha256",
      "operator",
      "signingTool",
      "protocol",
      "artifactRecords",
      "unresolvedFindings",
      "evidenceReferences",
      "attestationText",
    ]) ||
    attestation.schemaVersion !== 1 ||
    attestation.mode !== "release_signing_protocol_attestation" ||
    attestation.packetSha256 !== packetSha256 ||
    attestation.candidateManifestSha256 !== manifestSha256 ||
    attestation.candidateManifestSha256 !== packet.candidate.manifestSha256 ||
    attestation.attestationText !== SIGNING_PROTOCOL_ATTESTATION_TEXT ||
    !validHumanOperator(attestation.operator) ||
    containsCredentialMaterial(attestation)
  ) {
    return false;
  }

  const attestedAt = Date.parse(attestation.attestedAt);
  const manifestGeneratedAt = Date.parse(manifest.generatedAt);
  if (
    !Number.isFinite(attestedAt) ||
    !Number.isFinite(manifestGeneratedAt) ||
    attestedAt < manifestGeneratedAt ||
    attestedAt > now.getTime() + 5 * 60 * 1000
  ) {
    return false;
  }

  if (
    !hasExactKeys(attestation.signingTool, ["name", "version", "executableSha256"]) ||
    !validText(attestation.signingTool.name, 2, 120) ||
    !validText(attestation.signingTool.version, 1, 80) ||
    !/^[A-F0-9]{64}$/.test(attestation.signingTool.executableSha256)
  ) {
    return false;
  }

  const policy = packet.frozenPolicy;
  const signingPolicy = releasePolicy?.signing;
  if (
    policy.decisionsFrozen !== true ||
    !releasePolicy.distribution.allowedChannels.includes(policy.selectedChannel) ||
    policy.selectedChannel !== releasePolicy.distribution.selectedChannel ||
    !validText(policy.publisherSubject, 3, 300) ||
    policy.publisherSubject !== signingPolicy?.publisherSubject ||
    !/^https:\/\//.test(policy.timestampUrl) ||
    policy.timestampUrl !== signingPolicy.timestampUrl
  ) {
    return false;
  }

  if (
    !hasExactKeys(attestation.protocol, [
      "fileDigest",
      "fileDigestArgument",
      "timestampProtocol",
      "timestampUrl",
      "timestampUrlArgument",
      "timestampDigest",
      "timestampDigestArgument",
      "legacyTimestampArgumentPresent",
    ]) ||
    attestation.protocol.fileDigest !== "sha256" ||
    attestation.protocol.fileDigestArgument !== "/fd SHA256" ||
    attestation.protocol.timestampProtocol !== "rfc3161" ||
    attestation.protocol.timestampUrl !== policy.timestampUrl ||
    attestation.protocol.timestampUrlArgument !== "/tr" ||
    attestation.protocol.timestampDigest !== "sha256" ||
    attestation.protocol.timestampDigestArgument !== "/td SHA256" ||
    attestation.protocol.legacyTimestampArgumentPresent !== false
  ) {
    return false;
  }

  const expectedArtifacts = packet.candidate.releaseArtifacts;
  if (
    !Array.isArray(attestation.artifactRecords) ||
    attestation.artifactRecords.length !== expectedArtifacts.length ||
    !Array.isArray(signatureRecords)
  ) {
    return false;
  }
  const signatures = new Map(signatureRecords.map((record) => [record.id, record]));
  const signerSubjects = new Set();
  const signerThumbprints = new Set();
  for (let index = 0; index < expectedArtifacts.length; index += 1) {
    const expectedArtifact = expectedArtifacts[index];
    const operation = attestation.artifactRecords[index];
    const signature = signatures.get(expectedArtifact.id);
    if (
      !hasExactKeys(operation, [
        "artifactId",
        "bytes",
        "sha256",
        "signerSubject",
        "signerThumbprint",
        "timestampSubject",
        "timestampNotBefore",
        "timestampNotAfter",
        "executionEvidenceSha256",
        "evidenceReferences",
        "passed",
      ]) ||
      operation.artifactId !== expectedArtifact.id ||
      operation.bytes !== expectedArtifact.bytes ||
      operation.sha256 !== expectedArtifact.sha256 ||
      !/^[A-F0-9]{64}$/.test(operation.executionEvidenceSha256) ||
      !validReferences(operation.evidenceReferences) ||
      operation.passed !== true ||
      !signatureRecordMatches(signature, operation, expectedArtifact, policy.publisherSubject)
    ) {
      return false;
    }
    signerSubjects.add(signature.signerSubject);
    signerThumbprints.add(signature.signerThumbprint);
  }

  return (
    signerSubjects.size === 1 &&
    signerThumbprints.size === 1 &&
    Array.isArray(attestation.unresolvedFindings) &&
    attestation.unresolvedFindings.length === 0 &&
    validReferences(attestation.evidenceReferences)
  );
}

export function releaseSigningProtocolEvidenceMatches({
  attestation,
  packet,
  expectedPacket,
  packetSha256,
  manifest,
  manifestSha256,
  releasePolicy,
  releaseEvidence,
  signatureRecords,
  now = new Date(),
}) {
  const installer = manifest.artifacts?.find((artifact) => artifact.id === "nsis_installer");
  return (
    releaseEvidence?.rfc3161ProtocolVerified === true &&
    releaseEvidence.releaseCandidateSha256 === installer?.sha256 &&
    Array.isArray(releaseEvidence.evidenceReferences) &&
    releaseEvidence.evidenceReferences.includes(SIGNING_PROTOCOL_PACKET_REFERENCE) &&
    releaseEvidence.evidenceReferences.includes(SIGNING_PROTOCOL_ATTESTATION_REFERENCE) &&
    signingProtocolAttestationMatches({
      attestation,
      packet,
      expectedPacket,
      packetSha256,
      manifest,
      manifestSha256,
      releasePolicy,
      signatureRecords,
      now,
    })
  );
}

async function readJsonBytes(filePath) {
  const bytes = await readFile(filePath);
  return {
    bytes,
    value: JSON.parse(bytes.toString("utf8").replace(/^\uFEFF/, "")),
  };
}

function inspectSignatures(projectRoot, manifestPath) {
  const systemRoot = process.env.SystemRoot ?? "C:\\Windows";
  const powershell = path.join(
    systemRoot,
    "System32",
    "WindowsPowerShell",
    "v1.0",
    "powershell.exe",
  );
  const scriptPath = path.join(projectRoot, "scripts", "inspect_release_signatures.ps1");
  const result = spawnSync(
    powershell,
    [
      "-NoProfile",
      "-NonInteractive",
      "-ExecutionPolicy",
      "Bypass",
      "-File",
      scriptPath,
      "-ManifestPath",
      manifestPath,
    ],
    { encoding: "utf8", windowsHide: true, maxBuffer: 4 * 1024 * 1024 },
  );
  if (result.status !== 0) {
    throw new Error(`authenticode_inspection_failed_${result.status}`);
  }
  const parsed = JSON.parse(result.stdout.replace(/^\uFEFF/, "").trim());
  return Array.isArray(parsed) ? parsed : [parsed];
}

export async function verifyReleaseSigningProtocolFiles() {
  const projectRoot = path.resolve(import.meta.dirname, "..");
  const releaseRoot = path.join(projectRoot, "src-tauri", "target", "release");
  const packetPath = path.join(releaseRoot, "release-signing-protocol-packet.json");
  const attestationPath = path.join(
    projectRoot,
    "docs",
    "release",
    "RELEASE_SIGNING_PROTOCOL_ATTESTATION_V1.json",
  );
  const manifestPath = path.join(releaseRoot, "release-manifest.json");
  const policyPath = path.join(projectRoot, "docs", "release", "RELEASE_POLICY_V1.json");
  const evidencePath = path.join(
    projectRoot,
    "docs",
    "release",
    "RELEASE_EVIDENCE_STATUS_V1.json",
  );
  const [packetFile, attestationFile, manifestFile, policyFile, evidenceFile] =
    await Promise.all([
      readJsonBytes(packetPath),
      readJsonBytes(attestationPath),
      readJsonBytes(manifestPath),
      readJsonBytes(policyPath),
      readJsonBytes(evidencePath),
    ]);
  const expectedPacket = await buildReleaseSigningProtocolPacket();
  if (
    packetFile.bytes.toString("utf8").replace(/^\uFEFF/, "") !==
    canonicalSigningProtocolPacketText(expectedPacket)
  ) {
    throw new Error("release_signing_protocol_packet_is_stale");
  }
  const signatureRecords = inspectSignatures(projectRoot, manifestPath);
  if (
    !releaseSigningProtocolEvidenceMatches({
      attestation: attestationFile.value,
      packet: packetFile.value,
      expectedPacket,
      packetSha256: sha256(packetFile.bytes),
      manifest: manifestFile.value,
      manifestSha256: sha256(manifestFile.bytes),
      releasePolicy: policyFile.value,
      releaseEvidence: evidenceFile.value,
      signatureRecords,
    })
  ) {
    throw new Error("release_signing_protocol_attestation_mismatch");
  }
  return attestationFile.value;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  verifyReleaseSigningProtocolFiles()
    .then((attestation) => {
      process.stdout.write(
        `Release signing protocol evidence verified for ${attestation.artifactRecords.length} artifacts.\n`,
      );
    })
    .catch((error) => {
      process.stderr.write(`Release signing protocol verification failed: ${error.message}\n`);
      process.exitCode = 2;
    });
}
