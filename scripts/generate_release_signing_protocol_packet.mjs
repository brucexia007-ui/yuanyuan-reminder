import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = path.resolve(import.meta.dirname, "..");
const releaseRoot = path.join(projectRoot, "src-tauri", "target", "release");
const manifestPath = path.join(releaseRoot, "release-manifest.json");
const policyPath = path.join(projectRoot, "docs", "release", "RELEASE_POLICY_V1.json");
const signatureInspectionScriptPath = path.join(
  projectRoot,
  "scripts",
  "inspect_release_signatures.ps1",
);
const outputPath = path.join(releaseRoot, "release-signing-protocol-packet.json");

export const SIGNING_PROTOCOL_ATTESTATION_TEXT =
  "I attest that the named human operator verified the exact candidate artifacts, signing identity, signing tool, SHA-256 file digest, RFC 3161 timestamp URL, SHA-256 timestamp digest, execution evidence, and resulting Authenticode records described by this packet, with no omitted credential exposure or unresolved result.";

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex").toUpperCase();
}

function exact(value, expected) {
  return JSON.stringify(value) === JSON.stringify(expected);
}

function readJsonBytes(bytes) {
  return JSON.parse(bytes.toString("utf8").replace(/^\uFEFF/, ""));
}

export function createReleaseSigningProtocolPacket({
  manifest,
  manifestSha256,
  releasePolicy,
  releasePolicySha256,
  signatureInspectionScriptSha256,
}) {
  if (
    manifest?.schemaVersion !== 1 ||
    typeof manifest.productVersion !== "string" ||
    !Number.isFinite(Date.parse(manifest.generatedAt)) ||
    !Array.isArray(manifest.artifacts) ||
    !/^[A-F0-9]{64}$/.test(manifestSha256) ||
    releasePolicy?.schemaVersion !== 1 ||
    !/^[A-F0-9]{64}$/.test(releasePolicySha256) ||
    !/^[A-F0-9]{64}$/.test(signatureInspectionScriptSha256) ||
    !Array.isArray(releasePolicy.releaseArtifacts) ||
    !exact(releasePolicy.releaseArtifacts, [
      "stable_core",
      "nsis_installed_core",
      "nsis_installer",
    ]) ||
    !Array.isArray(releasePolicy.distribution?.allowedChannels) ||
    releasePolicy.distribution.allowedChannels.length === 0 ||
    releasePolicy.signing?.fileDigest !== "sha256" ||
    releasePolicy.signing?.timestampProtocol !== "rfc3161" ||
    releasePolicy.signing?.timestampDigest !== "sha256" ||
    releasePolicy.signing?.requireOneCertificatePerRelease !== true ||
    releasePolicy.manualReleaseGates?.requireRfc3161ProtocolEvidence !== true
  ) {
    throw new Error("signing_protocol_packet_input_schema_mismatch");
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
      throw new Error("signing_protocol_packet_artifact_mismatch");
    }
    return { id, bytes: artifact.bytes, sha256: artifact.sha256 };
  });

  const selectedChannel = releasePolicy.distribution.selectedChannel;
  const publisherSubject = releasePolicy.signing.publisherSubject;
  const timestampUrl = releasePolicy.signing.timestampUrl;
  const decisionsFrozen =
    releasePolicy.distribution.allowedChannels.includes(selectedChannel) &&
    typeof publisherSubject === "string" &&
    publisherSubject.trim().length >= 3 &&
    typeof timestampUrl === "string" &&
    /^https:\/\//.test(timestampUrl);

  return {
    schemaVersion: 1,
    mode: "release_signing_protocol_packet",
    candidate: {
      productVersion: manifest.productVersion,
      manifestSha256,
      releasePolicySha256,
      signatureInspectionScriptSha256,
      releaseArtifacts,
    },
    frozenPolicy: {
      selectedChannel,
      allowedChannels: releasePolicy.distribution.allowedChannels,
      publisherSubject,
      fileDigest: "sha256",
      timestampProtocol: "rfc3161",
      timestampDigest: "sha256",
      timestampUrl,
      oneCertificatePerRelease: true,
      decisionsFrozen,
    },
    requirements: {
      requiredAuthenticodeStatus: "Valid",
      requireExactPublisherSubject: true,
      requireOneSignerSubjectAndThumbprint: true,
      requireTimestampCertificateForEveryArtifact: true,
      requireHumanOperator: true,
      requireSigningToolExecutableSha256: true,
      requireExecutionEvidenceSha256PerArtifact: true,
      forbidLegacyTimestampSwitch: true,
      forbidCredentialsInAttestation: true,
      requiredProtocolFields: [
        "fileDigest",
        "fileDigestArgument",
        "timestampProtocol",
        "timestampUrl",
        "timestampUrlArgument",
        "timestampDigest",
        "timestampDigestArgument",
        "legacyTimestampArgumentPresent",
      ],
      requiredArtifactRecordFields: [
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
      ],
      minimumEvidenceReferencesPerArtifact: 2,
      requiredEvidenceReference:
        "docs/release/P0_RELEASE_SIGNING_AND_FALSE_POSITIVE_SOP.md",
      attestationText: SIGNING_PROTOCOL_ATTESTATION_TEXT,
    },
  };
}

export function canonicalSigningProtocolPacketText(packet) {
  return `${JSON.stringify(packet, null, 2)}\n`;
}

export async function buildReleaseSigningProtocolPacket() {
  const [manifestBytes, policyBytes, signatureInspectionScriptBytes] =
    await Promise.all([
      readFile(manifestPath),
      readFile(policyPath),
      readFile(signatureInspectionScriptPath),
    ]);
  return createReleaseSigningProtocolPacket({
    manifest: readJsonBytes(manifestBytes),
    manifestSha256: sha256(manifestBytes),
    releasePolicy: readJsonBytes(policyBytes),
    releasePolicySha256: sha256(policyBytes),
    signatureInspectionScriptSha256: sha256(signatureInspectionScriptBytes),
  });
}

export async function main(args = process.argv.slice(2)) {
  if (args.some((arg) => arg !== "--check") || args.length > 1) {
    throw new Error(
      "usage: node scripts/generate_release_signing_protocol_packet.mjs [--check]",
    );
  }
  const packet = await buildReleaseSigningProtocolPacket();
  const expected = canonicalSigningProtocolPacketText(packet);
  if (args.includes("--check")) {
    const existing = (await readFile(outputPath, "utf8")).replace(/^\uFEFF/, "");
    if (existing !== expected) throw new Error("release_signing_protocol_packet_is_stale");
    process.stdout.write(
      `Release signing protocol packet is current: ${sha256(Buffer.from(expected))}.\n`,
    );
    return packet;
  }
  await writeFile(outputPath, expected, "utf8");
  process.stdout.write(`Release signing protocol packet written: ${outputPath}\n`);
  return packet;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  main().catch((error) => {
    process.stderr.write(`Release signing protocol packet failed: ${error.message}\n`);
    process.exitCode = 2;
  });
}
