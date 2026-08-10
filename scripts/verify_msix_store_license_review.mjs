import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  buildMsixStoreLicenseReviewPacket,
  canonicalMsixStoreLicenseReviewPacketText,
  MSIX_STORE_LICENSE_REQUIRED_EVIDENCE,
  MSIX_STORE_LICENSE_REVIEW_ATTESTATION_TEXT,
  MSIX_STORE_LICENSE_REVIEW_DECISION_FIELDS,
} from "./generate_msix_store_license_review_packet.mjs";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const packetPath = path.join(
  projectRoot,
  "src-tauri",
  "target",
  "msix-store",
  "msix-store-license-review-packet.json",
);
const acceptancePath = path.join(
  projectRoot,
  "docs",
  "release",
  "MSIX_STORE_LICENSE_REVIEW_ACCEPTANCE_V1.json",
);
const storeReleaseManifestPath = path.join(
  projectRoot,
  "src-tauri",
  "target",
  "msix-store",
  "msix-store-release-manifest.json",
);
const identityPath = path.join(projectRoot, "docs", "release", "MSIX_STORE_IDENTITY_V1.json");
const releasePolicyPath = path.join(projectRoot, "docs", "release", "RELEASE_POLICY_V1.json");

export class MsixStoreLicenseReviewVerificationError extends Error {}

function fail(message) {
  throw new MsixStoreLicenseReviewVerificationError(message);
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex").toUpperCase();
}

function exact(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

function exactKeys(value, keys, label) {
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    !exact(Object.keys(value).sort(), [...keys].sort())
  ) {
    fail(`${label} fields do not match the Store license-review contract`);
  }
}

function canonicalHash(value, label) {
  if (typeof value !== "string" || !/^[A-F0-9]{64}$/u.test(value)) {
    fail(`${label} must be an uppercase SHA-256 digest`);
  }
}

function validIdentity(value, label, minimum = 2, maximum = 128) {
  if (
    typeof value !== "string" ||
    value !== value.trim() ||
    value.length < minimum ||
    value.length > maximum ||
    /[\u0000-\u001F\u007F]/u.test(value)
  ) {
    fail(`${label} must be a final, trimmed value`);
  }
}

function humanIdentity(value, label) {
  validIdentity(value, label);
  if (/(?:\bcodex\b|\bchatgpt\b|\bai\b|\bbot\b|automated|automation|人工智能|自动化|机器人)/iu.test(value)) {
    fail(`${label} must identify a human`);
  }
}

function validateHumanReviewer(reviewer) {
  exactKeys(reviewer, ["name", "role", "organization", "humanReviewer"], "reviewer");
  humanIdentity(reviewer.name, "reviewer.name");
  validIdentity(reviewer.role, "reviewer.role", 3, 80);
  validIdentity(reviewer.organization, "reviewer.organization", 2, 120);
  if (reviewer.humanReviewer !== true) fail("reviewer.humanReviewer must be true");
  const combined = `${reviewer.name} ${reviewer.role} ${reviewer.organization}`;
  if (/(?:\bcodex\b|\bchatgpt\b|\bai\b|\bbot\b|automated|automation|人工智能|自动化|机器人)/iu.test(combined)) {
    fail("reviewer must be a human, not AI or automation");
  }
}

function timestamp(value, label, now) {
  if (typeof value !== "string") fail(`${label} must be an ISO timestamp`);
  const parsed = Date.parse(value);
  if (
    !Number.isFinite(parsed) ||
    parsed < Date.parse("2026-08-10T00:00:00.000Z") ||
    parsed > now.getTime() + 5 * 60 * 1000
  ) {
    fail(`${label} must be a valid, non-future ISO timestamp`);
  }
  return parsed;
}

function validEvidenceReference(reference) {
  if (typeof reference !== "string" || reference.length < 5 || reference.length > 300) return false;
  if (/^https:\/\//u.test(reference)) return true;
  return (
    !path.isAbsolute(reference) &&
    !reference.includes("\\") &&
    !reference.split("/").includes("..") &&
    reference.startsWith("docs/")
  );
}

export function validateMsixStoreLicenseReviewAcceptance(
  document,
  {
    packet,
    expectedPacket,
    packetBytes,
    storeReleaseManifest,
    storeReleaseManifestBytes,
    identity,
    releasePolicy,
    now = new Date(),
  } = {},
) {
  if (!exact(packet, expectedPacket)) fail("Store license review packet drifted from its inputs");
  exactKeys(
    document,
    [
      "schemaVersion",
      "status",
      "reviewedAt",
      "packetSha256",
      "storeReleaseManifestSha256",
      "unsignedStoreCandidateSha256",
      "reviewer",
      "context",
      "decisions",
      "unresolvedFindings",
      "evidenceReferences",
      "outcome",
      "attestationText",
    ],
    "acceptance",
  );
  if (document.schemaVersion !== 1) fail("schemaVersion must be 1");
  if (document.status !== "human_accepted_store_license_review") {
    fail("status must be human_accepted_store_license_review");
  }
  canonicalHash(document.packetSha256, "packetSha256");
  canonicalHash(document.storeReleaseManifestSha256, "storeReleaseManifestSha256");
  canonicalHash(document.unsignedStoreCandidateSha256, "unsignedStoreCandidateSha256");
  if (
    !Buffer.isBuffer(packetBytes) ||
    document.packetSha256 !== sha256(packetBytes) ||
    !Buffer.isBuffer(storeReleaseManifestBytes) ||
    document.storeReleaseManifestSha256 !== sha256(storeReleaseManifestBytes) ||
    document.storeReleaseManifestSha256 !== packet.bindings.storeReleaseManifestSha256 ||
    document.unsignedStoreCandidateSha256 !== packet.candidate.sha256 ||
    document.unsignedStoreCandidateSha256 !== storeReleaseManifest?.candidate?.sha256 ||
    packet.candidate.storeId !== identity?.product?.storeId ||
    packet.candidate.identityName !== identity?.package?.identityName ||
    packet.candidate.publisherDisplayName !== identity?.package?.publisherDisplayName
  ) {
    fail("Store license review candidate, manifest, identity, or packet binding drifted");
  }
  if (
    releasePolicy?.schemaVersion !== 1 ||
    releasePolicy.distribution?.strategy !== "low_cost_staged" ||
    releasePolicy.distribution.selectedChannel !== "pending" ||
    releasePolicy.distribution.plannedStableChannel !== "microsoft_store" ||
    packet.boundary?.currentSelectedChannel !== "pending" ||
    packet.boundary.plannedStableChannel !== "microsoft_store" ||
    packet.boundary.nsisLicenseAttestationReusable !== false
  ) {
    fail("Store license review channel or NSIS non-reuse boundary drifted");
  }

  validateHumanReviewer(document.reviewer);
  if (document.attestationText !== MSIX_STORE_LICENSE_REVIEW_ATTESTATION_TEXT) {
    fail("attestationText does not match the Store license-review contract");
  }
  const reviewedAt = timestamp(document.reviewedAt, "reviewedAt", now);
  const packetGeneratedAt = Date.parse(packet.generatedAt);
  if (!Number.isFinite(packetGeneratedAt) || reviewedAt < packetGeneratedAt) {
    fail("reviewedAt must follow Store candidate generation");
  }

  exactKeys(
    document.context,
    ["distributionChannel", "storePublisherDisplayName", "targetRegions", "commercialUse"],
    "context",
  );
  if (
    document.context.distributionChannel !== "microsoft_store" ||
    document.context.storePublisherDisplayName !== identity.package.publisherDisplayName ||
    document.context.storePublisherDisplayName !== packet.candidate.publisherDisplayName ||
    !Array.isArray(document.context.targetRegions) ||
    document.context.targetRegions.length === 0 ||
    document.context.targetRegions.length > 32 ||
    !document.context.targetRegions.every((region) => /^[A-Z]{2}$/u.test(region)) ||
    !exact(
      document.context.targetRegions,
      [...new Set(document.context.targetRegions)].sort((left, right) =>
        left.localeCompare(right, "en"),
      ),
    ) ||
    typeof document.context.commercialUse !== "boolean"
  ) {
    fail("Store license review channel, publisher, regions, or commercial context drifted");
  }

  exactKeys(
    document.decisions,
    [...MSIX_STORE_LICENSE_REVIEW_DECISION_FIELDS, "commercialAssetPermission"],
    "decisions",
  );
  if (!MSIX_STORE_LICENSE_REVIEW_DECISION_FIELDS.every((field) => document.decisions[field] === true)) {
    fail("all Store license review decisions must be completed by the human reviewer");
  }
  const expectedPermission = document.context.commercialUse ? "confirmed" : "not_applicable";
  if (document.decisions.commercialAssetPermission !== expectedPermission) {
    fail(`commercialAssetPermission must be ${expectedPermission} for this distribution context`);
  }
  if (!Array.isArray(document.unresolvedFindings) || document.unresolvedFindings.length !== 0) {
    fail("unresolvedFindings must be empty");
  }
  if (
    !Array.isArray(document.evidenceReferences) ||
    document.evidenceReferences.length < 2 ||
    !document.evidenceReferences.every(validEvidenceReference) ||
    !exact(
      document.evidenceReferences,
      [...new Set(document.evidenceReferences)].sort((left, right) =>
        left.localeCompare(right, "en"),
      ),
    ) ||
    !document.evidenceReferences.includes(MSIX_STORE_LICENSE_REQUIRED_EVIDENCE)
  ) {
    fail("evidenceReferences must be unique, sorted, and include the required license QA record");
  }

  exactKeys(document.outcome, ["approvedBy", "approvedAt", "accepted"], "outcome");
  humanIdentity(document.outcome.approvedBy, "outcome.approvedBy");
  const approvedAt = timestamp(document.outcome.approvedAt, "outcome.approvedAt", now);
  if (approvedAt < reviewedAt) fail("outcome.approvedAt must not precede reviewedAt");
  if (document.outcome.accepted !== true) fail("outcome.accepted must be true");
  return document;
}

async function readJsonBytes(filePath) {
  const bytes = await readFile(filePath);
  return { bytes, document: JSON.parse(bytes.toString("utf8").replace(/^\uFEFF/u, "")) };
}

export async function verifyMsixStoreLicenseReviewFiles() {
  const expectedPacket = await buildMsixStoreLicenseReviewPacket();
  const [packetRecord, acceptanceRecord, manifestRecord, identityRecord, policyRecord] =
    await Promise.all([
      readJsonBytes(packetPath),
      readJsonBytes(acceptancePath),
      readJsonBytes(storeReleaseManifestPath),
      readJsonBytes(identityPath),
      readJsonBytes(releasePolicyPath),
    ]);
  if (
    packetRecord.bytes.toString("utf8").replace(/^\uFEFF/u, "") !==
    canonicalMsixStoreLicenseReviewPacketText(expectedPacket)
  ) {
    fail("Store license review packet is missing, stale, or modified");
  }
  return validateMsixStoreLicenseReviewAcceptance(acceptanceRecord.document, {
    packet: packetRecord.document,
    expectedPacket,
    packetBytes: packetRecord.bytes,
    storeReleaseManifest: manifestRecord.document,
    storeReleaseManifestBytes: manifestRecord.bytes,
    identity: identityRecord.document,
    releasePolicy: policyRecord.document,
  });
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  verifyMsixStoreLicenseReviewFiles()
    .then((acceptance) => {
      process.stdout.write(
        `MSIX Store license review verified for ${acceptance.reviewer.name}; channel remains pending until Store certification.\n`,
      );
    })
    .catch((error) => {
      process.stderr.write(`MSIX Store license review pending: ${error.message}\n`);
      process.exitCode = 2;
    });
}
