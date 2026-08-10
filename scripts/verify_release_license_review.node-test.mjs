import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import {
  LICENSE_REVIEW_ATTESTATION_TEXT,
  LICENSE_REVIEW_DECISION_FIELDS,
  canonicalLicenseReviewPacketText,
  createReleaseLicenseReviewPacket,
} from "./generate_release_license_review_packet.mjs";
import {
  LICENSE_REVIEW_ATTESTATION_REFERENCE,
  LICENSE_REVIEW_PACKET_REFERENCE,
  licenseReviewAttestationMatches,
  releaseLicenseReviewEvidenceMatches,
} from "./verify_release_license_review.mjs";

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex").toUpperCase();
}

function buildInputs() {
  const productionExpressions = [
    "MPL-2.0",
    "MIT",
    ...Array.from({ length: 20 }, (_, index) => `License-${String(index).padStart(2, "0")}`),
  ].sort((left, right) => left.localeCompare(right, "en"));
  const thirdParty = Array.from({ length: 301 }, (_, index) => ({
    purl: `pkg:cargo/third-party-${String(index).padStart(3, "0")}@1.0.0`,
    scope: "required",
    licenses: [productionExpressions[index % productionExpressions.length]],
  }));
  const firstPartyNames = ["ai", "bridge", "connectors", "protocol", "reminder"];
  const firstParty = firstPartyNames.map((name, index) => ({
    purl: `pkg:cargo/yuanyuan-${name}@${index === 4 ? "1.4.0" : "0.1.0"}`,
    scope: "required",
    licenses: ["MIT"],
  }));
  const excludedExpressions = ["BSD-2-Clause", "CC-BY-4.0", "ISC", "MIT-0"];
  const excluded = Array.from({ length: 201 }, (_, index) => ({
    purl: `pkg:npm/excluded-${String(index).padStart(3, "0")}@1.0.0`,
    scope: "excluded",
    licenses: [excludedExpressions[index % excludedExpressions.length]],
  }));
  const components = [...thirdParty, ...firstParty, ...excluded];
  const manifest = {
    schemaVersion: 1,
    productVersion: "1.4.0",
    generatedAt: "2026-08-10T00:00:00.000Z",
    artifacts: [
      { id: "stable_core", bytes: 10, sha256: "A".repeat(64) },
      { id: "nsis_installed_core", bytes: 11, sha256: "B".repeat(64) },
      { id: "nsis_installer", bytes: 12, sha256: "C".repeat(64) },
    ],
  };
  const releasePolicy = {
    schemaVersion: 1,
    distribution: {
      selectedChannel: "ca_code_signing_certificate",
      allowedChannels: [
        "microsoft_store",
        "artifact_signing_public_trust",
        "ca_code_signing_certificate",
      ],
    },
    signing: { publisherSubject: "CN=Yuanyuan Test Publisher" },
    releaseArtifacts: ["stable_core", "nsis_installed_core", "nsis_installer"],
  };
  const mplComponents = thirdParty.filter((component) =>
    component.licenses.includes("MPL-2.0"),
  );
  const licensePolicy = {
    schemaVersion: 1,
    releaseTarget: "x86_64-pc-windows-msvc",
    noticeArchiveRequired: true,
    permittedProductionLicenseExpressions: productionExpressions,
    sourceAvailability: mplComponents.map((component) => ({
      purl: component.purl,
      url: `https://example.test/${encodeURIComponent(component.purl)}`,
    })),
  };
  // Keep the frozen five-item MPL source contract exercised by the packet.
  licensePolicy.sourceAvailability = licensePolicy.sourceAvailability.slice(0, 5);
  for (let index = 5; index < mplComponents.length; index += 1) {
    mplComponents[index].licenses = [productionExpressions[1]];
  }
  const inventory = {
    schemaVersion: 1,
    productVersion: "1.4.0",
    reviewStatus: "not_performed",
    summary: { components: 507, unresolved: 0, uniqueLicenseExpressions: 26 },
    licenseExpressions: [...productionExpressions, ...excludedExpressions]
      .filter((value, index, array) => array.indexOf(value) === index)
      .sort((left, right) => left.localeCompare(right, "en")),
    unresolvedComponents: [],
    components,
  };
  const sbom = {
    bomFormat: "CycloneDX",
    specVersion: "1.6",
    metadata: { component: { version: "1.4.0" } },
    components: components.map((component) => ({
      purl: component.purl,
      scope: component.scope,
      licenses: component.licenses.map((expression) => ({ expression })),
    })),
  };
  const fallbackMappings = Array.from({ length: 11 }, (_, index) => ({
    purl: `pkg:cargo/fallback-${index}@1.0.0`,
    selectedLicense: "MIT",
    reason: "reviewed_test_fallback",
    sourcePurl: `pkg:cargo/source-${index}@1.0.0`,
    sourceFile: null,
    fileNames: [],
  }));
  const materials = Object.fromEntries(
    [
      "sbom",
      "licenseInventory",
      "licenseArchive",
      "thirdPartyNotices",
      "assetsLicense",
      "projectLicense",
      "licensePolicy",
      "releasePolicy",
    ].map((id) => [
      id,
      { fileName: `${id}.txt`, bytes: 10, sha256: sha256(Buffer.from(id)) },
    ]),
  );
  const manifestBytes = Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`);
  const packet = createReleaseLicenseReviewPacket({
    manifest,
    manifestSha256: sha256(manifestBytes),
    releasePolicy,
    licensePolicy,
    inventory,
    sbom,
    materials,
    fallbackMappings,
    archiveProductionComponents: 301,
  });
  return { manifest, manifestBytes, releasePolicy, packet };
}

function buildAttestation(packet, packetSha256) {
  return {
    schemaVersion: 1,
    mode: "release_license_review_attestation",
    reviewedAt: "2026-08-11T00:00:00.000Z",
    packetSha256,
    candidateManifestSha256: packet.candidate.manifestSha256,
    reviewer: {
      name: "Release Reviewer",
      role: "Publishing counsel",
      organization: "Yuanyuan Publisher",
      humanReviewer: true,
    },
    context: {
      distributionChannel: "ca_code_signing_certificate",
      publisherSubject: "CN=Yuanyuan Test Publisher",
      targetRegions: ["CN", "US"],
      commercialUse: false,
    },
    decisions: {
      ...Object.fromEntries(LICENSE_REVIEW_DECISION_FIELDS.map((field) => [field, true])),
      commercialAssetPermission: "not_applicable",
    },
    unresolvedFindings: [],
    evidenceReferences: [
      "docs/P0_THIRD_PARTY_LICENSE_QA_2026-08-09.md",
      "docs/release/reviewer-legal-opinion.md",
    ],
    attestationText: LICENSE_REVIEW_ATTESTATION_TEXT,
  };
}

test("builds the frozen candidate-specific manual review contract", () => {
  const { packet } = buildInputs();
  assert.equal(packet.inventory.lockedComponents, 507);
  assert.equal(packet.inventory.productionComponents, 306);
  assert.equal(packet.inventory.thirdPartyProductionComponents, 301);
  assert.equal(packet.inventory.productionLicenseExpressions.length, 22);
  assert.equal(packet.inventory.fallbackMappings.length, 11);
  assert.equal(packet.inventory.mplSourceAvailability.length, 5);
  assert.deepEqual(packet.reviewContract.requiredDecisionFields, LICENSE_REVIEW_DECISION_FIELDS);
});

test("accepts only a human, channel-bound, candidate-bound completed review", () => {
  const { manifest, manifestBytes, releasePolicy, packet } = buildInputs();
  const packetBytes = Buffer.from(canonicalLicenseReviewPacketText(packet));
  const attestation = buildAttestation(packet, sha256(packetBytes));
  const args = {
    attestation,
    packet,
    expectedPacket: packet,
    packetSha256: sha256(packetBytes),
    manifest,
    manifestSha256: sha256(manifestBytes),
    releasePolicy,
    now: new Date("2026-08-12T00:00:00.000Z"),
  };
  assert.equal(licenseReviewAttestationMatches(args), true);
  const releaseEvidence = {
    licenseReviewVerified: true,
    releaseCandidateSha256: "C".repeat(64),
    evidenceReferences: [
      LICENSE_REVIEW_PACKET_REFERENCE,
      LICENSE_REVIEW_ATTESTATION_REFERENCE,
    ],
  };
  assert.equal(releaseLicenseReviewEvidenceMatches({ ...args, releaseEvidence }), true);
});

test("rejects AI signers, incomplete decisions, context drift, findings, and packet drift", () => {
  const { manifest, manifestBytes, releasePolicy, packet } = buildInputs();
  const packetBytes = Buffer.from(canonicalLicenseReviewPacketText(packet));
  const attestation = buildAttestation(packet, sha256(packetBytes));
  const base = {
    packet,
    expectedPacket: packet,
    packetSha256: sha256(packetBytes),
    manifest,
    manifestSha256: sha256(manifestBytes),
    releasePolicy,
    now: new Date("2026-08-12T00:00:00.000Z"),
  };
  const rejects = [
    { ...attestation, reviewer: { ...attestation.reviewer, name: "Codex Reviewer" } },
    {
      ...attestation,
      decisions: { ...attestation.decisions, fallbackMappingsReviewed: false },
    },
    {
      ...attestation,
      context: { ...attestation.context, distributionChannel: "microsoft_store" },
    },
    { ...attestation, unresolvedFindings: ["missing permission"] },
  ];
  for (const candidate of rejects) {
    assert.equal(licenseReviewAttestationMatches({ ...base, attestation: candidate }), false);
  }
  assert.equal(
    licenseReviewAttestationMatches({
      ...base,
      attestation,
      expectedPacket: { ...packet, schemaVersion: 2 },
    }),
    false,
  );
});
