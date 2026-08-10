import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import { licenseFallbackReviewItems } from "./generate_third_party_licenses.mjs";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const releaseRoot = path.join(projectRoot, "src-tauri", "target", "release");
const storeTargetRoot = path.join(projectRoot, "src-tauri", "target", "msix-store");
const outputPath = path.join(storeTargetRoot, "msix-store-license-review-packet.json");
const storeReleaseManifestVerifierPath = path.join(
  projectRoot,
  "scripts",
  "generate_msix_store_release_manifest.mjs",
);
const licenseInventoryVerifierPath = path.join(
  projectRoot,
  "scripts",
  "generate_third_party_licenses.mjs",
);
const generatorPath = fileURLToPath(import.meta.url);

export const MSIX_STORE_LICENSE_REVIEW_ATTESTATION_TEXT =
  "I attest that the named human reviewer completed the Microsoft Store candidate-specific license, NOTICE, source-availability, asset-rights, channel, trademark, and applicable professional legal review described by this packet, and that no unresolved finding remains.";

export const MSIX_STORE_LICENSE_REVIEW_DECISION_FIELDS = [
  "assetsRightsConfirmed",
  "channelAndTrademarkTermsReviewed",
  "distributionMaterialsMatchReviewed",
  "fallbackMappingsReviewed",
  "licenseExpressionsReviewed",
  "mplSourceAvailabilityReviewed",
  "noticeAndAttributionReviewed",
  "professionalLegalReviewCompleted",
  "thirdPartyModificationsDeclared",
];

export const MSIX_STORE_LICENSE_REQUIRED_EVIDENCE =
  "docs/P0_THIRD_PARTY_LICENSE_QA_2026-08-09.md";

const materialDefinitions = {
  assetsLicense: ["ASSETS_LICENSE.md", path.join(projectRoot, "ASSETS_LICENSE.md")],
  licenseArchive: ["THIRD_PARTY_LICENSES.txt", path.join(projectRoot, "THIRD_PARTY_LICENSES.txt")],
  licenseInventory: [
    "src-tauri/target/release/third-party-licenses.json",
    path.join(releaseRoot, "third-party-licenses.json"),
  ],
  licensePolicy: [
    "docs/release/THIRD_PARTY_LICENSE_POLICY_V1.json",
    path.join(projectRoot, "docs", "release", "THIRD_PARTY_LICENSE_POLICY_V1.json"),
  ],
  projectLicense: ["LICENSE", path.join(projectRoot, "LICENSE")],
  releasePolicy: [
    "docs/release/RELEASE_POLICY_V1.json",
    path.join(projectRoot, "docs", "release", "RELEASE_POLICY_V1.json"),
  ],
  sbom: ["src-tauri/target/release/sbom.cdx.json", path.join(releaseRoot, "sbom.cdx.json")],
  storeIdentity: [
    "docs/release/MSIX_STORE_IDENTITY_V1.json",
    path.join(projectRoot, "docs", "release", "MSIX_STORE_IDENTITY_V1.json"),
  ],
  storeReleaseManifest: [
    "src-tauri/target/msix-store/msix-store-release-manifest.json",
    path.join(storeTargetRoot, "msix-store-release-manifest.json"),
  ],
  storeSubmissionInputs: [
    "docs/release/MSIX_STORE_SUBMISSION_INPUTS_V1.json",
    path.join(projectRoot, "docs", "release", "MSIX_STORE_SUBMISSION_INPUTS_V1.json"),
  ],
  thirdPartyNotices: ["THIRD_PARTY_NOTICES.md", path.join(projectRoot, "THIRD_PARTY_NOTICES.md")],
};

const bundledLicenseMaterialIds = {
  "licenses/ASSETS_LICENSE.md": "assetsLicense",
  "licenses/LICENSE.txt": "projectLicense",
  "licenses/THIRD_PARTY_LICENSES.txt": "licenseArchive",
  "licenses/THIRD_PARTY_NOTICES.md": "thirdPartyNotices",
};

export class MsixStoreLicenseReviewPacketError extends Error {}

function fail(message) {
  throw new MsixStoreLicenseReviewPacketError(message);
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex").toUpperCase();
}

function exact(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

function canonicalHash(value) {
  return typeof value === "string" && /^[A-F0-9]{64}$/u.test(value);
}

function uniqueSorted(values) {
  return [...new Set(values)].sort((left, right) => left.localeCompare(right, "en"));
}

function isFirstParty(purl) {
  return /^pkg:cargo\/yuanyuan-(ai|bridge|connectors|protocol|reminder)@/u.test(purl);
}

function parseJsonBytes(bytes, label) {
  try {
    return JSON.parse(bytes.toString("utf8").replace(/^\uFEFF/u, ""));
  } catch {
    fail(`${label} is not valid JSON`);
  }
}

function materialRecords(materialArtifacts) {
  const expectedIds = Object.keys(materialDefinitions).sort();
  if (
    materialArtifacts === null ||
    typeof materialArtifacts !== "object" ||
    Array.isArray(materialArtifacts) ||
    !exact(Object.keys(materialArtifacts).sort(), expectedIds)
  ) {
    fail("Store license review material set is incomplete or expanded");
  }
  return Object.fromEntries(
    Object.entries(materialDefinitions).map(([id, [relativePath]]) => {
      const bytes = materialArtifacts[id];
      if (!Buffer.isBuffer(bytes) || bytes.length === 0) {
        fail(`Store license review material is empty: ${id}`);
      }
      return [id, { path: relativePath, bytes: bytes.length, sha256: sha256(bytes) }];
    }),
  );
}

function validateJsonBindings({
  materialArtifacts,
  storeReleaseManifest,
  identity,
  submissionInputs,
  releasePolicy,
  licensePolicy,
  inventory,
  sbom,
}) {
  const documents = {
    storeReleaseManifest,
    storeIdentity: identity,
    storeSubmissionInputs: submissionInputs,
    releasePolicy,
    licensePolicy,
    licenseInventory: inventory,
    sbom,
  };
  for (const [id, document] of Object.entries(documents)) {
    if (!exact(parseJsonBytes(materialArtifacts[id], id), document)) {
      fail(`Store license review parsed document drifted from ${id} bytes`);
    }
  }
}

function validateInventory({ storeReleaseManifest, licensePolicy, inventory, sbom }) {
  const productVersion = storeReleaseManifest.product.version.replace(/\.0$/u, "");
  if (
    inventory?.schemaVersion !== 1 ||
    inventory.productVersion !== productVersion ||
    inventory.reviewStatus !== "not_performed" ||
    inventory.summary?.components !== 507 ||
    inventory.summary?.unresolved !== 0 ||
    inventory.summary?.uniqueLicenseExpressions !== inventory.licenseExpressions?.length ||
    !Array.isArray(inventory.components) ||
    inventory.components.length !== 507 ||
    !Array.isArray(inventory.licenseExpressions) ||
    !Array.isArray(inventory.unresolvedComponents) ||
    inventory.unresolvedComponents.length !== 0 ||
    sbom?.bomFormat !== "CycloneDX" ||
    sbom.specVersion !== "1.6" ||
    sbom.metadata?.component?.version !== productVersion ||
    !Array.isArray(sbom.components) ||
    sbom.components.length !== inventory.components.length ||
    licensePolicy?.schemaVersion !== 1 ||
    licensePolicy.releaseTarget !== "x86_64-pc-windows-msvc" ||
    licensePolicy.noticeArchiveRequired !== true ||
    !Array.isArray(licensePolicy.permittedProductionLicenseExpressions) ||
    licensePolicy.permittedProductionLicenseExpressions.length !== 22 ||
    !Array.isArray(licensePolicy.sourceAvailability) ||
    licensePolicy.sourceAvailability.length !== 5
  ) {
    fail("Store license review inventory or SBOM contract drifted");
  }

  const seen = new Set();
  for (const component of inventory.components) {
    if (
      component === null ||
      typeof component !== "object" ||
      Array.isArray(component) ||
      !exact(Object.keys(component).sort(), ["licenses", "purl", "scope"]) ||
      typeof component.purl !== "string" ||
      seen.has(component.purl) ||
      !["required", "excluded"].includes(component.scope) ||
      !Array.isArray(component.licenses) ||
      component.licenses.length === 0 ||
      !component.licenses.every((license) => typeof license === "string" && license.length > 0)
    ) {
      fail("Store license review component identity drifted");
    }
    seen.add(component.purl);
  }
  const allExpressions = uniqueSorted(inventory.components.flatMap((component) => component.licenses));
  if (!exact(allExpressions, inventory.licenseExpressions)) {
    fail("Store license expression summary drifted");
  }

  const inventoryIdentity = inventory.components.map((component) => ({
    purl: component.purl,
    scope: component.scope,
    licenses: component.licenses,
  }));
  const sbomIdentity = sbom.components.map((component) => ({
    purl: component.purl,
    scope: component.scope,
    licenses: component.licenses?.map((item) => item.expression),
  }));
  if (!exact(inventoryIdentity, sbomIdentity)) fail("Store SBOM and license inventory drifted");

  const production = inventory.components.filter((component) => component.scope === "required");
  const firstParty = production.filter((component) => isFirstParty(component.purl));
  const thirdParty = production.filter((component) => !isFirstParty(component.purl));
  const excluded = inventory.components.filter((component) => component.scope === "excluded");
  const productionExpressions = uniqueSorted(thirdParty.flatMap((component) => component.licenses));
  if (
    production.length !== 306 ||
    firstParty.length !== 5 ||
    thirdParty.length !== 301 ||
    excluded.length !== 201 ||
    !exact(productionExpressions, licensePolicy.permittedProductionLicenseExpressions)
  ) {
    fail("Store license review frozen component counts drifted");
  }
  const mplPurls = thirdParty
    .filter((component) => component.licenses.includes("MPL-2.0"))
    .map((component) => component.purl)
    .sort((left, right) => left.localeCompare(right, "en"));
  const sourcePurls = licensePolicy.sourceAvailability
    .map((item) => item.purl)
    .sort((left, right) => left.localeCompare(right, "en"));
  if (!exact(mplPurls, sourcePurls)) fail("Store MPL source-availability list drifted");
  return { production, firstParty, thirdParty, excluded };
}

export function createMsixStoreLicenseReviewPacket({
  storeReleaseManifest,
  identity,
  submissionInputs,
  releasePolicy,
  licensePolicy,
  inventory,
  sbom,
  materialArtifacts,
  fallbackMappings,
  archiveProductionComponents,
  generatorBytes,
}) {
  const materials = materialRecords(materialArtifacts);
  validateJsonBindings({
    materialArtifacts,
    storeReleaseManifest,
    identity,
    submissionInputs,
    releasePolicy,
    licensePolicy,
    inventory,
    sbom,
  });
  const counts = validateInventory({ storeReleaseManifest, licensePolicy, inventory, sbom });
  if (
    storeReleaseManifest?.schemaVersion !== 1 ||
    storeReleaseManifest.mode !== "msix_store_release_manifest" ||
    storeReleaseManifest.candidate?.signatureStatus !== "NotSigned" ||
    storeReleaseManifest.candidate.distribution !== "microsoft_store_intake_only" ||
    storeReleaseManifest.boundary?.directDistributionAllowed !== false ||
    storeReleaseManifest.boundary.microsoftStoreResigningRequired !== true ||
    storeReleaseManifest.boundary.storeCertification !== "pending" ||
    identity?.schemaVersion !== 1 ||
    identity.status !== "partner_center_confirmed" ||
    submissionInputs?.schemaVersion !== 1 ||
    submissionInputs.status !== "human_confirmed_ready_for_partner_center_entry" ||
    releasePolicy?.schemaVersion !== 1 ||
    releasePolicy.distribution?.strategy !== "low_cost_staged" ||
    releasePolicy.distribution.selectedChannel !== "pending" ||
    releasePolicy.distribution.plannedStableChannel !== "microsoft_store" ||
    !Array.isArray(fallbackMappings) ||
    fallbackMappings.length !== 11 ||
    !fallbackMappings.every(
      (mapping) =>
        mapping !== null &&
        typeof mapping === "object" &&
        !Array.isArray(mapping) &&
        exact(Object.keys(mapping).sort(), [
          "fileNames",
          "purl",
          "reason",
          "selectedLicense",
          "sourceFile",
          "sourcePurl",
        ]) &&
        typeof mapping.purl === "string" &&
        typeof mapping.reason === "string" &&
        typeof mapping.selectedLicense === "string" &&
        (mapping.sourceFile === null || typeof mapping.sourceFile === "string") &&
        (mapping.sourcePurl === null || typeof mapping.sourcePurl === "string") &&
        Array.isArray(mapping.fileNames) &&
        mapping.fileNames.every((fileName) => typeof fileName === "string"),
    ) ||
    archiveProductionComponents !== 301 ||
    !Buffer.isBuffer(generatorBytes) ||
    generatorBytes.length === 0
  ) {
    fail("Store license review candidate or low-cost channel contract drifted");
  }
  if (
    storeReleaseManifest.bindings?.storeIdentitySha256 !== materials.storeIdentity.sha256 ||
    storeReleaseManifest.bindings.storeSubmissionInputsSha256 !==
      materials.storeSubmissionInputs.sha256 ||
    storeReleaseManifest.bindings.releasePolicySha256 !== materials.releasePolicy.sha256 ||
    storeReleaseManifest.bindings.sbomSha256 !== materials.sbom.sha256 ||
    storeReleaseManifest.bindings.licenseInventorySha256 !== materials.licenseInventory.sha256
  ) {
    fail("Store release-manifest compliance bindings drifted from license-review materials");
  }
  if (
    storeReleaseManifest.product.storeId !== identity.product?.storeId ||
    storeReleaseManifest.product.identityName !== identity.package?.identityName ||
    storeReleaseManifest.product.packageFamilyName !== identity.package?.packageFamilyName ||
    storeReleaseManifest.product.version !== identity.platform?.version ||
    !canonicalHash(storeReleaseManifest.candidate.sha256) ||
    !Number.isInteger(storeReleaseManifest.candidate.bytes) ||
    storeReleaseManifest.candidate.bytes <= 0
  ) {
    fail("Store identity or unsigned candidate drifted from the release manifest");
  }

  const payloadByPath = new Map(
    storeReleaseManifest.payload?.files?.map((item) => [item.path, item]) ?? [],
  );
  const bundledLicensePayload = Object.entries(bundledLicenseMaterialIds).map(
    ([payloadPath, materialId]) => {
      const payload = payloadByPath.get(payloadPath);
      const material = materials[materialId];
      if (
        !payload ||
        !Number.isInteger(payload.bytes) ||
        !canonicalHash(payload.sha256) ||
        payload.bytes !== material.bytes ||
        payload.sha256 !== material.sha256
      ) {
        fail(`Bundled Store license payload drifted from source: ${payloadPath}`);
      }
      return { path: payloadPath, bytes: payload.bytes, sha256: payload.sha256 };
    },
  );
  if (
    storeReleaseManifest.compliance?.sbom?.totalComponents !== 507 ||
    storeReleaseManifest.compliance.sbom.requiredComponents !== 306 ||
    storeReleaseManifest.compliance.licenseInventory?.unresolved !== 0 ||
    !exact(
      storeReleaseManifest.compliance.bundledLicensePaths,
      Object.keys(bundledLicenseMaterialIds).sort(),
    )
  ) {
    fail("Store release-manifest license compliance summary drifted");
  }

  return {
    schemaVersion: 1,
    mode: "msix_store_license_review_packet",
    generatedAt: storeReleaseManifest.generatedAt,
    candidate: {
      storeId: identity.product.storeId,
      identityName: identity.package.identityName,
      packageFamilyName: identity.package.packageFamilyName,
      publisher: identity.package.publisher,
      publisherDisplayName: identity.package.publisherDisplayName,
      version: identity.platform.version,
      path: storeReleaseManifest.candidate.path,
      bytes: storeReleaseManifest.candidate.bytes,
      sha256: storeReleaseManifest.candidate.sha256,
      signatureStatus: "NotSigned",
      distributionChannel: "microsoft_store",
      directDistributionAllowed: false,
    },
    bindings: {
      storeReleaseManifestSha256: materials.storeReleaseManifest.sha256,
      storeIdentitySha256: materials.storeIdentity.sha256,
      storeSubmissionInputsSha256: materials.storeSubmissionInputs.sha256,
      releasePolicySha256: materials.releasePolicy.sha256,
      sbomSha256: materials.sbom.sha256,
      licenseInventorySha256: materials.licenseInventory.sha256,
      generatorSha256: sha256(generatorBytes),
    },
    materials,
    bundledLicensePayload,
    inventory: {
      lockedComponents: inventory.components.length,
      productionComponents: counts.production.length,
      firstPartyProductionComponents: counts.firstParty.length,
      thirdPartyProductionComponents: counts.thirdParty.length,
      excludedComponents: counts.excluded.length,
      unresolvedComponents: inventory.summary.unresolved,
      allLicenseExpressions: inventory.licenseExpressions,
      productionLicenseExpressions: licensePolicy.permittedProductionLicenseExpressions,
      fallbackMappings,
      mplSourceAvailability: licensePolicy.sourceAvailability,
    },
    reviewContract: {
      requiredReviewerFields: ["name", "role", "organization", "humanReviewer"],
      requiredContextFields: [
        "distributionChannel",
        "storePublisherDisplayName",
        "targetRegions",
        "commercialUse",
      ],
      requiredDecisionFields: MSIX_STORE_LICENSE_REVIEW_DECISION_FIELDS,
      commercialAssetPermissionValues: ["confirmed", "not_applicable"],
      unresolvedFindingsMustBeEmpty: true,
      requiredEvidenceReference: MSIX_STORE_LICENSE_REQUIRED_EVIDENCE,
      attestationText: MSIX_STORE_LICENSE_REVIEW_ATTESTATION_TEXT,
    },
    boundary: {
      automaticReviewIsLegalAdvice: false,
      humanReviewRequired: true,
      currentSelectedChannel: "pending",
      plannedStableChannel: "microsoft_store",
      microsoftStoreResigningRequired: true,
      nsisLicenseAttestationReusable: false,
    },
  };
}

export function canonicalMsixStoreLicenseReviewPacketText(packet) {
  return `${JSON.stringify(packet, null, 2)}\n`;
}

function runVerifier(script, args = []) {
  const result = spawnSync(process.execPath, [script, ...args], {
    cwd: projectRoot,
    encoding: "utf8",
  });
  if (result.status !== 0) fail(result.stderr.trim() || `${path.basename(script)} failed`);
}

export async function buildMsixStoreLicenseReviewPacket() {
  runVerifier(storeReleaseManifestVerifierPath, ["--check"]);
  runVerifier(licenseInventoryVerifierPath, ["--check"]);
  const artifacts = Object.fromEntries(
    await Promise.all(
      Object.entries(materialDefinitions).map(async ([id, [, filePath]]) => [id, await readFile(filePath)]),
    ),
  );
  const storeReleaseManifest = parseJsonBytes(artifacts.storeReleaseManifest, "storeReleaseManifest");
  const identity = parseJsonBytes(artifacts.storeIdentity, "storeIdentity");
  const submissionInputs = parseJsonBytes(artifacts.storeSubmissionInputs, "storeSubmissionInputs");
  const releasePolicy = parseJsonBytes(artifacts.releasePolicy, "releasePolicy");
  const licensePolicy = parseJsonBytes(artifacts.licensePolicy, "licensePolicy");
  const inventory = parseJsonBytes(artifacts.licenseInventory, "licenseInventory");
  const sbom = parseJsonBytes(artifacts.sbom, "sbom");
  const archiveMatch = artifacts.licenseArchive
    .toString("utf8")
    .match(/Third-party production components: (\d+)/u);
  if (!archiveMatch) fail("Store license archive production-component count is missing");
  return createMsixStoreLicenseReviewPacket({
    storeReleaseManifest,
    identity,
    submissionInputs,
    releasePolicy,
    licensePolicy,
    inventory,
    sbom,
    materialArtifacts: artifacts,
    fallbackMappings: licenseFallbackReviewItems(),
    archiveProductionComponents: Number(archiveMatch[1]),
    generatorBytes: await readFile(generatorPath),
  });
}

export async function main(args = process.argv.slice(2)) {
  if (args.some((arg) => arg !== "--check") || args.length > 1) {
    fail("usage: node scripts/generate_msix_store_license_review_packet.mjs [--check]");
  }
  const packet = await buildMsixStoreLicenseReviewPacket();
  const expected = canonicalMsixStoreLicenseReviewPacketText(packet);
  if (args.includes("--check")) {
    const existing = (await readFile(outputPath, "utf8")).replace(/^\uFEFF/u, "");
    if (existing !== expected) fail("Store license review packet is missing, stale, or modified");
    process.stdout.write(`MSIX Store license review packet verified: ${sha256(Buffer.from(expected))}.\n`);
    return packet;
  }
  await writeFile(outputPath, expected, "utf8");
  process.stdout.write(`MSIX Store license review packet written: ${outputPath}\n`);
  return packet;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    process.stderr.write(`MSIX Store license review packet pending: ${error.message}\n`);
    process.exitCode = 2;
  });
}
