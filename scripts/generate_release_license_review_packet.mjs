import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { licenseFallbackReviewItems } from "./generate_third_party_licenses.mjs";

const projectRoot = path.resolve(import.meta.dirname, "..");
const releaseRoot = path.join(projectRoot, "src-tauri", "target", "release");
const outputPath = path.join(releaseRoot, "release-license-review-packet.json");
const productBrand = JSON.parse(await readFile(path.join(projectRoot, "product-brand.json"), "utf8"));

export const LICENSE_REVIEW_ATTESTATION_TEXT =
  "I attest that the named reviewer completed the candidate-specific license, NOTICE, source-availability, asset-rights, channel, trademark, and applicable professional legal review described by this packet, and that no unresolved finding remains.";

export const LICENSE_REVIEW_DECISION_FIELDS = [
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

const MATERIALS = [
  ["sbom", path.join(releaseRoot, "sbom.cdx.json")],
  ["licenseInventory", path.join(releaseRoot, "third-party-licenses.json")],
  ["licenseArchive", path.join(projectRoot, "THIRD_PARTY_LICENSES.txt")],
  ["thirdPartyNotices", path.join(projectRoot, "THIRD_PARTY_NOTICES.md")],
  ["assetsLicense", path.join(projectRoot, productBrand.assets.licenseFile)],
  ["projectLicense", path.join(projectRoot, "LICENSE")],
  [
    "licensePolicy",
    path.join(projectRoot, "docs", "release", "THIRD_PARTY_LICENSE_POLICY_V1.json"),
  ],
  ["releasePolicy", path.join(projectRoot, "docs", "release", "RELEASE_POLICY_V1.json")],
];

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex").toUpperCase();
}

function exact(value, expected) {
  return JSON.stringify(value) === JSON.stringify(expected);
}

function uniqueSorted(values) {
  return [...new Set(values)].sort((left, right) => left.localeCompare(right, "en"));
}

function isFirstParty(purl) {
  return /^pkg:cargo\/yuanyuan-(ai|bridge|connectors|protocol|reminder)@/.test(purl);
}

function validateReviewPacketInputs({ manifest, releasePolicy, licensePolicy, inventory, sbom }) {
  if (
    manifest?.schemaVersion !== 1 ||
    typeof manifest.productVersion !== "string" ||
    !Array.isArray(manifest.artifacts) ||
    releasePolicy?.schemaVersion !== 1 ||
    !Array.isArray(releasePolicy.releaseArtifacts) ||
    releasePolicy.releaseArtifacts.length === 0 ||
    licensePolicy?.schemaVersion !== 1 ||
    licensePolicy.releaseTarget !== "x86_64-pc-windows-msvc" ||
    licensePolicy.noticeArchiveRequired !== true ||
    !Array.isArray(licensePolicy.permittedProductionLicenseExpressions) ||
    !Array.isArray(licensePolicy.sourceAvailability) ||
    inventory?.schemaVersion !== 1 ||
    inventory.productVersion !== manifest.productVersion ||
    inventory.reviewStatus !== "not_performed" ||
    inventory.summary?.components !== inventory.components?.length ||
    inventory.summary?.unresolved !== 0 ||
    inventory.summary?.uniqueLicenseExpressions !== inventory.licenseExpressions?.length ||
    !Array.isArray(inventory.components) ||
    !Array.isArray(inventory.licenseExpressions) ||
    !Array.isArray(inventory.unresolvedComponents) ||
    inventory.unresolvedComponents.length !== 0 ||
    sbom?.bomFormat !== "CycloneDX" ||
    sbom.specVersion !== "1.6" ||
    sbom.metadata?.component?.version !== manifest.productVersion ||
    !Array.isArray(sbom.components)
  ) {
    throw new Error("license_review_packet_input_schema_mismatch");
  }

  const componentPurls = new Set();
  for (const component of inventory.components) {
    if (
      !hasExactComponentKeys(component) ||
      typeof component.purl !== "string" ||
      componentPurls.has(component.purl) ||
      !["required", "excluded"].includes(component.scope) ||
      !Array.isArray(component.licenses) ||
      component.licenses.length === 0 ||
      !component.licenses.every((license) => typeof license === "string" && license.length > 0)
    ) {
      throw new Error("license_review_packet_component_identity_mismatch");
    }
    componentPurls.add(component.purl);
  }
  const allExpressions = uniqueSorted(
    inventory.components.flatMap((component) => component.licenses),
  );
  if (!exact(allExpressions, inventory.licenseExpressions)) {
    throw new Error("license_review_packet_expression_summary_mismatch");
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
  if (!exact(inventoryIdentity, sbomIdentity)) {
    throw new Error("license_review_packet_sbom_inventory_mismatch");
  }

  const artifacts = new Map(manifest.artifacts.map((artifact) => [artifact.id, artifact]));
  for (const id of releasePolicy.releaseArtifacts) {
    const artifact = artifacts.get(id);
    if (
      !artifact ||
      !Number.isInteger(artifact.bytes) ||
      artifact.bytes <= 0 ||
      typeof artifact.sha256 !== "string" ||
      !/^[A-F0-9]{64}$/.test(artifact.sha256)
    ) {
      throw new Error("license_review_packet_release_artifact_mismatch");
    }
  }

  const productionThirdParty = inventory.components.filter(
    (component) => component.scope === "required" && !isFirstParty(component.purl),
  );
  const productionExpressions = uniqueSorted(
    productionThirdParty.flatMap((component) => component.licenses),
  );
  if (!exact(productionExpressions, licensePolicy.permittedProductionLicenseExpressions)) {
    throw new Error("license_review_packet_production_expression_mismatch");
  }
  const mplPurls = productionThirdParty
    .filter((component) => component.licenses.includes("MPL-2.0"))
    .map((component) => component.purl)
    .sort((left, right) => left.localeCompare(right, "en"));
  const sourcePurls = licensePolicy.sourceAvailability
    .map((item) => item.purl)
    .sort((left, right) => left.localeCompare(right, "en"));
  if (!exact(mplPurls, sourcePurls)) {
    throw new Error("license_review_packet_mpl_source_mismatch");
  }
}

function hasExactComponentKeys(component) {
  return (
    component !== null &&
    typeof component === "object" &&
    !Array.isArray(component) &&
    exact(Object.keys(component).sort(), ["licenses", "purl", "scope"])
  );
}

export function createReleaseLicenseReviewPacket({
  manifest,
  manifestSha256,
  releasePolicy,
  licensePolicy,
  inventory,
  sbom,
  materials,
  fallbackMappings,
  archiveProductionComponents,
}) {
  validateReviewPacketInputs({ manifest, releasePolicy, licensePolicy, inventory, sbom });
  const productionComponents = inventory.components.filter(
    (component) => component.scope === "required",
  );
  const firstPartyProductionComponents = productionComponents.filter((component) =>
    isFirstParty(component.purl),
  );
  const thirdPartyProductionComponents = productionComponents.length -
    firstPartyProductionComponents.length;
  if (
    typeof manifestSha256 !== "string" ||
    !/^[A-F0-9]{64}$/.test(manifestSha256) ||
    archiveProductionComponents !== thirdPartyProductionComponents ||
    fallbackMappings.length !== 12 ||
    licensePolicy.permittedProductionLicenseExpressions.length !== 24 ||
    licensePolicy.sourceAvailability.length !== 6
  ) {
    throw new Error("license_review_packet_frozen_inventory_count_mismatch");
  }
  const expectedMaterialKeys = [
    "assetsLicense",
    "licenseArchive",
    "licenseInventory",
    "licensePolicy",
    "projectLicense",
    "releasePolicy",
    "sbom",
    "thirdPartyNotices",
  ];
  if (
    materials === null ||
    typeof materials !== "object" ||
    Array.isArray(materials) ||
    !exact(Object.keys(materials).sort(), expectedMaterialKeys) ||
    !Object.values(materials).every(
      (material) =>
        material !== null &&
        typeof material === "object" &&
        !Array.isArray(material) &&
        exact(Object.keys(material).sort(), ["bytes", "fileName", "sha256"]) &&
        typeof material.fileName === "string" &&
        !material.fileName.includes("/") &&
        !material.fileName.includes("\\") &&
        Number.isInteger(material.bytes) &&
        material.bytes > 0 &&
        /^[A-F0-9]{64}$/.test(material.sha256),
    ) ||
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
        Array.isArray(mapping.fileNames),
    )
  ) {
    throw new Error("license_review_packet_material_contract_mismatch");
  }

  const artifacts = new Map(manifest.artifacts.map((artifact) => [artifact.id, artifact]));
  return {
    schemaVersion: 1,
    mode: "release_license_review_packet",
    candidate: {
      productVersion: manifest.productVersion,
      manifestSha256,
      releaseArtifacts: releasePolicy.releaseArtifacts.map((id) => ({
        id,
        bytes: artifacts.get(id).bytes,
        sha256: artifacts.get(id).sha256,
      })),
    },
    materials,
    inventory: {
      lockedComponents: inventory.components.length,
      productionComponents: productionComponents.length,
      firstPartyProductionComponents: firstPartyProductionComponents.length,
      thirdPartyProductionComponents,
      excludedComponents: inventory.components.filter(
        (component) => component.scope === "excluded",
      ).length,
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
        "publisherSubject",
        "targetRegions",
        "commercialUse",
      ],
      requiredDecisionFields: LICENSE_REVIEW_DECISION_FIELDS,
      commercialAssetPermissionValues: ["confirmed", "not_applicable"],
      unresolvedFindingsMustBeEmpty: true,
      requiredEvidenceReference:
        "docs/P0_THIRD_PARTY_LICENSE_QA_2026-08-09.md",
      attestationText: LICENSE_REVIEW_ATTESTATION_TEXT,
    },
  };
}

export function canonicalLicenseReviewPacketText(packet) {
  return `${JSON.stringify(packet, null, 2)}\n`;
}

async function readJson(filePath) {
  return JSON.parse((await readFile(filePath, "utf8")).replace(/^\uFEFF/, ""));
}

export async function buildReleaseLicenseReviewPacket() {
  const manifestPath = path.join(releaseRoot, "release-manifest.json");
  const inventoryPath = path.join(releaseRoot, "third-party-licenses.json");
  const sbomPath = path.join(releaseRoot, "sbom.cdx.json");
  const licensePolicyPath = MATERIALS.find(([id]) => id === "licensePolicy")[1];
  const releasePolicyPath = MATERIALS.find(([id]) => id === "releasePolicy")[1];
  const [manifestBytes, manifest, inventory, sbom, licensePolicy, releasePolicy] =
    await Promise.all([
      readFile(manifestPath),
      readJson(manifestPath),
      readJson(inventoryPath),
      readJson(sbomPath),
      readJson(licensePolicyPath),
      readJson(releasePolicyPath),
    ]);
  const materialEntries = await Promise.all(
    MATERIALS.map(async ([id, filePath]) => {
      const bytes = await readFile(filePath);
      return [
        id,
        {
          fileName: path.basename(filePath),
          bytes: bytes.length,
          sha256: sha256(bytes),
        },
      ];
    }),
  );
  const archiveText = await readFile(
    MATERIALS.find(([id]) => id === "licenseArchive")[1],
    "utf8",
  );
  const archiveCountMatch = archiveText.match(/Third-party production components: (\d+)/);
  if (!archiveCountMatch) throw new Error("license_review_packet_archive_count_missing");
  return createReleaseLicenseReviewPacket({
    manifest,
    manifestSha256: sha256(manifestBytes),
    releasePolicy,
    licensePolicy,
    inventory,
    sbom,
    materials: Object.fromEntries(materialEntries),
    fallbackMappings: licenseFallbackReviewItems(),
    archiveProductionComponents: Number(archiveCountMatch[1]),
  });
}

export async function main(args = process.argv.slice(2)) {
  if (args.some((arg) => arg !== "--check") || args.length > 1) {
    throw new Error(
      "usage: node scripts/generate_release_license_review_packet.mjs [--check]",
    );
  }
  const packet = await buildReleaseLicenseReviewPacket();
  const expected = canonicalLicenseReviewPacketText(packet);
  if (args.includes("--check")) {
    const existing = await readFile(outputPath, "utf8");
    if (existing.replace(/^\uFEFF/, "") !== expected) {
      throw new Error("release_license_review_packet_is_stale");
    }
    process.stdout.write(`Release license review packet is current: ${sha256(Buffer.from(expected))}.\n`);
    return packet;
  }
  await writeFile(outputPath, expected, "utf8");
  process.stdout.write(`Release license review packet written: ${outputPath}\n`);
  return packet;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  main().catch((error) => {
    process.stderr.write(`Release license review packet failed: ${error.message}\n`);
    process.exitCode = 2;
  });
}
