import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import {
  canonicalMsixStoreLicenseReviewPacketText,
  createMsixStoreLicenseReviewPacket,
  MSIX_STORE_LICENSE_REVIEW_ATTESTATION_TEXT,
  MSIX_STORE_LICENSE_REVIEW_DECISION_FIELDS,
} from "./generate_msix_store_license_review_packet.mjs";
import {
  MsixStoreLicenseReviewVerificationError,
  validateMsixStoreLicenseReviewAcceptance,
} from "./verify_msix_store_license_review.mjs";

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex").toUpperCase();
}

function jsonBytes(document) {
  return Buffer.from(`${JSON.stringify(document, null, 2)}\n`);
}

function fixture() {
  const productionExpressions = [
    "MPL-2.0",
    "MIT",
    ...Array.from({ length: 20 }, (_, index) => `License-${String(index).padStart(2, "0")}`),
  ].sort((left, right) => left.localeCompare(right, "en"));
  const nonMplExpressions = productionExpressions.filter((item) => item !== "MPL-2.0");
  const thirdParty = Array.from({ length: 301 }, (_, index) => ({
    purl: `pkg:cargo/third-party-${String(index).padStart(3, "0")}@1.0.0`,
    scope: "required",
    licenses: [index < 5 ? "MPL-2.0" : nonMplExpressions[(index - 5) % nonMplExpressions.length]],
  }));
  const firstParty = ["ai", "bridge", "connectors", "protocol", "reminder"].map(
    (name, index) => ({
      purl: `pkg:cargo/yuanyuan-${name}@${index === 4 ? "1.4.0" : "0.1.0"}`,
      scope: "required",
      licenses: ["MIT"],
    }),
  );
  const excludedExpressions = ["BSD-2-Clause", "CC-BY-4.0", "ISC", "MIT-0"];
  const excluded = Array.from({ length: 201 }, (_, index) => ({
    purl: `pkg:npm/excluded-${String(index).padStart(3, "0")}@1.0.0`,
    scope: "excluded",
    licenses: [excludedExpressions[index % excludedExpressions.length]],
  }));
  const components = [...thirdParty, ...firstParty, ...excluded];
  const inventory = {
    schemaVersion: 1,
    productVersion: "1.4.0",
    reviewStatus: "not_performed",
    summary: { components: 507, unresolved: 0, uniqueLicenseExpressions: 26 },
    licenseExpressions: [...productionExpressions, ...excludedExpressions].sort((left, right) =>
      left.localeCompare(right, "en"),
    ),
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
  const identity = {
    schemaVersion: 1,
    status: "partner_center_confirmed",
    product: { reservedProductName: "Yuanyuan", storeId: "9N1234567890" },
    package: {
      identityName: "12345Publisher.Yuanyuan",
      publisher: "CN=12345678-1234-1234-1234-123456789012",
      publisherDisplayName: "Yuanyuan Open Source",
      packageFamilyName: "12345Publisher.Yuanyuan_abcd1234",
    },
    platform: { version: "1.4.0.0", architecture: "x64" },
  };
  const submissionInputs = {
    schemaVersion: 1,
    status: "human_confirmed_ready_for_partner_center_entry",
  };
  const releasePolicy = {
    schemaVersion: 1,
    distribution: {
      strategy: "low_cost_staged",
      selectedChannel: "pending",
      plannedStableChannel: "microsoft_store",
    },
  };
  const licensePolicy = {
    schemaVersion: 1,
    releaseTarget: "x86_64-pc-windows-msvc",
    noticeArchiveRequired: true,
    permittedProductionLicenseExpressions: productionExpressions,
    sourceAvailability: thirdParty.slice(0, 5).map((component) => ({
      purl: component.purl,
      url: `https://example.test/${encodeURIComponent(component.purl)}`,
    })),
  };
  const sourceBytes = {
    assetsLicense: Buffer.from("asset license"),
    licenseArchive: Buffer.from("Third-party production components: 301\nlicense archive"),
    projectLicense: Buffer.from("MIT license"),
    thirdPartyNotices: Buffer.from("third-party notices"),
  };
  const payloadPathToMaterial = {
    "licenses/ASSETS_LICENSE.md": "assetsLicense",
    "licenses/LICENSE.txt": "projectLicense",
    "licenses/THIRD_PARTY_LICENSES.txt": "licenseArchive",
    "licenses/THIRD_PARTY_NOTICES.md": "thirdPartyNotices",
  };
  const storeReleaseManifest = {
    schemaVersion: 1,
    mode: "msix_store_release_manifest",
    generatedAt: "2026-08-10T08:00:00.000Z",
    product: {
      storeId: identity.product.storeId,
      identityName: identity.package.identityName,
      packageFamilyName: identity.package.packageFamilyName,
      version: identity.platform.version,
    },
    candidate: {
      path: "src-tauri/target/msix-store/Yuanyuan_1.4.0.0_x64-store.msix",
      bytes: 120000,
      sha256: "A".repeat(64),
      signatureStatus: "NotSigned",
      distribution: "microsoft_store_intake_only",
    },
    payload: {
      files: Object.entries(payloadPathToMaterial).map(([payloadPath, materialId]) => ({
        path: payloadPath,
        bytes: sourceBytes[materialId].length,
        sha256: sha256(sourceBytes[materialId]),
      })),
    },
    compliance: {
      sbom: { totalComponents: 507, requiredComponents: 306 },
      licenseInventory: { unresolved: 0 },
      bundledLicensePaths: Object.keys(payloadPathToMaterial).sort(),
    },
    bindings: {},
    boundary: {
      directDistributionAllowed: false,
      microsoftStoreResigningRequired: true,
      storeCertification: "pending",
    },
  };
  const materialArtifacts = {
    ...sourceBytes,
    licenseInventory: jsonBytes(inventory),
    licensePolicy: jsonBytes(licensePolicy),
    releasePolicy: jsonBytes(releasePolicy),
    sbom: jsonBytes(sbom),
    storeIdentity: jsonBytes(identity),
    storeReleaseManifest: jsonBytes(storeReleaseManifest),
    storeSubmissionInputs: jsonBytes(submissionInputs),
  };
  storeReleaseManifest.bindings = {
    storeIdentitySha256: sha256(materialArtifacts.storeIdentity),
    storeSubmissionInputsSha256: sha256(materialArtifacts.storeSubmissionInputs),
    releasePolicySha256: sha256(materialArtifacts.releasePolicy),
    sbomSha256: sha256(materialArtifacts.sbom),
    licenseInventorySha256: sha256(materialArtifacts.licenseInventory),
  };
  materialArtifacts.storeReleaseManifest = jsonBytes(storeReleaseManifest);
  const fallbackMappings = Array.from({ length: 11 }, (_, index) => ({
    purl: `pkg:cargo/fallback-${index}@1.0.0`,
    selectedLicense: "MIT",
    reason: "reviewed_test_fallback",
    sourcePurl: `pkg:cargo/source-${index}@1.0.0`,
    sourceFile: null,
    fileNames: [],
  }));
  const packet = createMsixStoreLicenseReviewPacket({
    storeReleaseManifest,
    identity,
    submissionInputs,
    releasePolicy,
    licensePolicy,
    inventory,
    sbom,
    materialArtifacts,
    fallbackMappings,
    archiveProductionComponents: 301,
    generatorBytes: Buffer.from("Store license packet generator"),
  });
  const packetBytes = Buffer.from(canonicalMsixStoreLicenseReviewPacketText(packet));
  const acceptance = {
    schemaVersion: 1,
    status: "human_accepted_store_license_review",
    reviewedAt: "2026-08-10T10:00:00.000Z",
    packetSha256: sha256(packetBytes),
    storeReleaseManifestSha256: sha256(materialArtifacts.storeReleaseManifest),
    unsignedStoreCandidateSha256: storeReleaseManifest.candidate.sha256,
    reviewer: {
      name: "Release Reviewer",
      role: "Publishing counsel",
      organization: "Yuanyuan Publisher",
      humanReviewer: true,
    },
    context: {
      distributionChannel: "microsoft_store",
      storePublisherDisplayName: identity.package.publisherDisplayName,
      targetRegions: ["CN", "US"],
      commercialUse: false,
    },
    decisions: {
      ...Object.fromEntries(MSIX_STORE_LICENSE_REVIEW_DECISION_FIELDS.map((field) => [field, true])),
      commercialAssetPermission: "not_applicable",
    },
    unresolvedFindings: [],
    evidenceReferences: [
      "docs/P0_THIRD_PARTY_LICENSE_QA_2026-08-09.md",
      "docs/release/store-license-human-review.md",
    ],
    outcome: {
      approvedBy: "Project Maintainer",
      approvedAt: "2026-08-10T11:00:00.000Z",
      accepted: true,
    },
    attestationText: MSIX_STORE_LICENSE_REVIEW_ATTESTATION_TEXT,
  };
  return {
    document: acceptance,
    packet,
    expectedPacket: packet,
    packetBytes,
    storeReleaseManifest,
    storeReleaseManifestBytes: materialArtifacts.storeReleaseManifest,
    identity,
    releasePolicy,
    now: new Date("2026-08-11T00:00:00.000Z"),
  };
}

function rejects(input, pattern) {
  assert.throws(
    () => validateMsixStoreLicenseReviewAcceptance(input.document, input),
    (error) =>
      error instanceof MsixStoreLicenseReviewVerificationError && pattern.test(error.message),
  );
}

test("builds and accepts the Store-specific frozen human license review", () => {
  const input = fixture();
  assert.equal(input.packet.inventory.lockedComponents, 507);
  assert.equal(input.packet.inventory.productionComponents, 306);
  assert.equal(input.packet.inventory.thirdPartyProductionComponents, 301);
  assert.equal(input.packet.inventory.productionLicenseExpressions.length, 22);
  assert.equal(input.packet.inventory.fallbackMappings.length, 11);
  assert.equal(input.packet.inventory.mplSourceAvailability.length, 5);
  assert.equal(validateMsixStoreLicenseReviewAcceptance(input.document, input), input.document);
});

test("rejects NSIS or release-policy channel reuse", () => {
  const contextDrift = fixture();
  contextDrift.document.context.distributionChannel = "github_releases";
  rejects(contextDrift, /channel/u);

  const policyDrift = fixture();
  policyDrift.releasePolicy.distribution.selectedChannel = "microsoft_store";
  rejects(policyDrift, /channel/u);
});

test("rejects AI reviewers and automation approvers", () => {
  const reviewer = fixture();
  reviewer.document.reviewer.name = "Codex Bot";
  rejects(reviewer, /human/u);

  const approver = fixture();
  approver.document.outcome.approvedBy = "AI automation";
  rejects(approver, /human/u);
});

test("rejects incomplete decisions and unresolved findings", () => {
  const incomplete = fixture();
  incomplete.document.decisions.noticeAndAttributionReviewed = false;
  rejects(incomplete, /decisions/u);

  const finding = fixture();
  finding.document.unresolvedFindings = ["Asset permission still pending"];
  rejects(finding, /must be empty/u);
});

test("rejects candidate, packet, and material drift", () => {
  const candidate = fixture();
  candidate.document.unsignedStoreCandidateSha256 = "F".repeat(64);
  rejects(candidate, /binding drifted/u);

  const packet = fixture();
  packet.expectedPacket = {
    ...packet.packet,
    materials: {
      ...packet.packet.materials,
      assetsLicense: { ...packet.packet.materials.assetsLicense, bytes: 999 },
    },
  };
  rejects(packet, /packet drifted/u);
});

test("rejects publisher, region, and commercial-asset permission drift", () => {
  const publisher = fixture();
  publisher.document.context.storePublisherDisplayName = "Another Publisher";
  rejects(publisher, /publisher/u);

  const regions = fixture();
  regions.document.context.targetRegions = ["US", "CN"];
  rejects(regions, /regions/u);

  const commercial = fixture();
  commercial.document.context.commercialUse = true;
  rejects(commercial, /commercialAssetPermission/u);
});
