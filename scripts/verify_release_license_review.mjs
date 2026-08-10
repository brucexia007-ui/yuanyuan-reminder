import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  LICENSE_REVIEW_ATTESTATION_TEXT,
  LICENSE_REVIEW_DECISION_FIELDS,
  buildReleaseLicenseReviewPacket,
  canonicalLicenseReviewPacketText,
} from "./generate_release_license_review_packet.mjs";

export const LICENSE_REVIEW_PACKET_REFERENCE =
  "src-tauri/target/release/release-license-review-packet.json";
export const LICENSE_REVIEW_ATTESTATION_REFERENCE =
  "docs/release/RELEASE_LICENSE_REVIEW_ATTESTATION_V1.json";
const REQUIRED_REVIEW_REFERENCE = "docs/P0_THIRD_PARTY_LICENSE_QA_2026-08-09.md";

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

function validIdentity(value, minimum, maximum) {
  return (
    typeof value === "string" &&
    value === value.trim() &&
    value.length >= minimum &&
    value.length <= maximum &&
    !/[\u0000-\u001F\u007F]/.test(value)
  );
}

function validHumanReviewer(reviewer) {
  if (
    !hasExactKeys(reviewer, ["name", "role", "organization", "humanReviewer"]) ||
    !validIdentity(reviewer.name, 3, 80) ||
    !validIdentity(reviewer.role, 3, 80) ||
    !validIdentity(reviewer.organization, 2, 120) ||
    reviewer.humanReviewer !== true
  ) {
    return false;
  }
  const combined = `${reviewer.name} ${reviewer.role} ${reviewer.organization}`;
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
    reference.startsWith("docs/")
  );
}

export function licenseReviewAttestationMatches({
  attestation,
  packet,
  expectedPacket,
  packetSha256,
  manifest,
  manifestSha256,
  releasePolicy,
  now = new Date(),
}) {
  if (
    !exact(packet, expectedPacket) ||
    !hasExactKeys(attestation, [
      "schemaVersion",
      "mode",
      "reviewedAt",
      "packetSha256",
      "candidateManifestSha256",
      "reviewer",
      "context",
      "decisions",
      "unresolvedFindings",
      "evidenceReferences",
      "attestationText",
    ]) ||
    attestation.schemaVersion !== 1 ||
    attestation.mode !== "release_license_review_attestation" ||
    attestation.packetSha256 !== packetSha256 ||
    attestation.candidateManifestSha256 !== packet.candidate.manifestSha256 ||
    attestation.candidateManifestSha256 !== manifestSha256 ||
    !validHumanReviewer(attestation.reviewer) ||
    attestation.attestationText !== LICENSE_REVIEW_ATTESTATION_TEXT
  ) {
    return false;
  }

  const reviewedAt = Date.parse(attestation.reviewedAt);
  const manifestGeneratedAt = Date.parse(manifest.generatedAt);
  if (
    !Number.isFinite(reviewedAt) ||
    !Number.isFinite(manifestGeneratedAt) ||
    reviewedAt < manifestGeneratedAt ||
    reviewedAt > now.getTime() + 5 * 60 * 1000
  ) {
    return false;
  }

  const context = attestation.context;
  const allowedChannels = releasePolicy?.distribution?.allowedChannels;
  if (
    !hasExactKeys(context, [
      "distributionChannel",
      "publisherSubject",
      "targetRegions",
      "commercialUse",
    ]) ||
    !Array.isArray(allowedChannels) ||
    releasePolicy.distribution.selectedChannel === "pending" ||
    context.distributionChannel !== releasePolicy.distribution.selectedChannel ||
    !allowedChannels.includes(context.distributionChannel) ||
    !validIdentity(releasePolicy.signing?.publisherSubject, 3, 300) ||
    context.publisherSubject !== releasePolicy.signing.publisherSubject ||
    !Array.isArray(context.targetRegions) ||
    context.targetRegions.length === 0 ||
    context.targetRegions.length > 32 ||
    !context.targetRegions.every((region) => /^[A-Z]{2}$/.test(region)) ||
    !exact(context.targetRegions, [...new Set(context.targetRegions)].sort()) ||
    typeof context.commercialUse !== "boolean"
  ) {
    return false;
  }

  if (
    !hasExactKeys(attestation.decisions, [
      ...LICENSE_REVIEW_DECISION_FIELDS,
      "commercialAssetPermission",
    ]) ||
    !LICENSE_REVIEW_DECISION_FIELDS.every(
      (field) => attestation.decisions[field] === true,
    ) ||
    (context.commercialUse
      ? attestation.decisions.commercialAssetPermission !== "confirmed"
      : attestation.decisions.commercialAssetPermission !== "not_applicable")
  ) {
    return false;
  }

  if (
    !Array.isArray(attestation.unresolvedFindings) ||
    attestation.unresolvedFindings.length !== 0 ||
    !Array.isArray(attestation.evidenceReferences) ||
    attestation.evidenceReferences.length < 2 ||
    !attestation.evidenceReferences.every(validEvidenceReference) ||
    !exact(
      attestation.evidenceReferences,
      [...new Set(attestation.evidenceReferences)].sort((left, right) =>
        left.localeCompare(right, "en"),
      ),
    ) ||
    !attestation.evidenceReferences.includes(REQUIRED_REVIEW_REFERENCE)
  ) {
    return false;
  }
  return true;
}

export function releaseLicenseReviewEvidenceMatches({
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
  return (
    releaseEvidence?.licenseReviewVerified === true &&
    releaseEvidence.releaseCandidateSha256 === installer?.sha256 &&
    Array.isArray(releaseEvidence.evidenceReferences) &&
    releaseEvidence.evidenceReferences.includes(LICENSE_REVIEW_PACKET_REFERENCE) &&
    releaseEvidence.evidenceReferences.includes(LICENSE_REVIEW_ATTESTATION_REFERENCE) &&
    licenseReviewAttestationMatches({
      attestation,
      packet,
      expectedPacket,
      packetSha256,
      manifest,
      manifestSha256,
      releasePolicy,
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

export async function verifyReleaseLicenseReviewFiles() {
  const projectRoot = path.resolve(import.meta.dirname, "..");
  const releaseRoot = path.join(projectRoot, "src-tauri", "target", "release");
  const packetPath = path.join(releaseRoot, "release-license-review-packet.json");
  const attestationPath = path.join(
    projectRoot,
    "docs",
    "release",
    "RELEASE_LICENSE_REVIEW_ATTESTATION_V1.json",
  );
  const manifestPath = path.join(releaseRoot, "release-manifest.json");
  const releasePolicyPath = path.join(
    projectRoot,
    "docs",
    "release",
    "RELEASE_POLICY_V1.json",
  );
  const releaseEvidencePath = path.join(
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
      readJsonBytes(releasePolicyPath),
      readJsonBytes(releaseEvidencePath),
    ]);
  const expectedPacket = await buildReleaseLicenseReviewPacket();
  if (
    packetFile.bytes.toString("utf8").replace(/^\uFEFF/, "") !==
    canonicalLicenseReviewPacketText(expectedPacket)
  ) {
    throw new Error("release_license_review_packet_is_stale");
  }
  const matches = releaseLicenseReviewEvidenceMatches({
    attestation: attestationFile.value,
    packet: packetFile.value,
    expectedPacket,
    packetSha256: sha256(packetFile.bytes),
    manifest: manifestFile.value,
    manifestSha256: sha256(manifestFile.bytes),
    releasePolicy: policyFile.value,
    releaseEvidence: evidenceFile.value,
  });
  if (!matches) throw new Error("release_license_review_attestation_mismatch");
  return { packet: packetFile.value, attestation: attestationFile.value };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  verifyReleaseLicenseReviewFiles()
    .then(({ attestation }) => {
      process.stdout.write(
        `Release license review verified for ${attestation.reviewer.name}.\n`,
      );
    })
    .catch((error) => {
      process.stderr.write(`Release license review verification failed: ${error.message}\n`);
      process.exitCode = 2;
    });
}
