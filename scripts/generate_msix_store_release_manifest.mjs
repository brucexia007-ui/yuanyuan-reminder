import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const storeTargetRoot = path.join(projectRoot, "src-tauri", "target", "msix-store");
const unpackRoot = path.join(storeTargetRoot, "unpacked");
const outputPath = path.join(storeTargetRoot, "msix-store-release-manifest.json");
const candidateReportPath = path.join(storeTargetRoot, "msix-store-candidate-report.json");
const identityPath = path.join(projectRoot, "docs", "release", "MSIX_STORE_IDENTITY_V1.json");
const submissionInputsPath = path.join(
  projectRoot,
  "docs",
  "release",
  "MSIX_STORE_SUBMISSION_INPUTS_V1.json",
);
const releasePolicyPath = path.join(projectRoot, "docs", "release", "RELEASE_POLICY_V1.json");
const privacyPolicyPath = path.join(projectRoot, "PRIVACY.md");
const sbomPath = path.join(projectRoot, "src-tauri", "target", "release", "sbom.cdx.json");
const licenseInventoryPath = path.join(
  projectRoot,
  "src-tauri",
  "target",
  "release",
  "third-party-licenses.json",
);
const sourceFiles = {
  "licenses/ASSETS_LICENSE.md": path.join(projectRoot, "ASSETS_LICENSE.md"),
  "licenses/LICENSE.txt": path.join(projectRoot, "LICENSE"),
  "licenses/THIRD_PARTY_LICENSES.txt": path.join(projectRoot, "THIRD_PARTY_LICENSES.txt"),
  "licenses/THIRD_PARTY_NOTICES.md": path.join(projectRoot, "THIRD_PARTY_NOTICES.md"),
};
const candidateVerifierPath = path.join(projectRoot, "scripts", "verify_msix_store_candidate.mjs");
const submissionVerifierPath = path.join(
  projectRoot,
  "scripts",
  "verify_msix_store_submission_inputs.mjs",
);
const licenseVerifierPath = path.join(projectRoot, "scripts", "generate_third_party_licenses.mjs");
const generatorPath = fileURLToPath(import.meta.url);

export const STORE_RELEASE_PAYLOAD = [
  { path: "AppxBlockMap.xml", role: "package_metadata" },
  { path: "AppxManifest.xml", role: "package_manifest" },
  { path: "Assets/Square150x150Logo.png", role: "store_asset" },
  { path: "Assets/Square44x44Logo.png", role: "store_asset" },
  { path: "Assets/StoreLogo.png", role: "store_asset" },
  { path: "licenses/ASSETS_LICENSE.md", role: "asset_license" },
  { path: "licenses/LICENSE.txt", role: "code_license" },
  { path: "licenses/THIRD_PARTY_LICENSES.txt", role: "third_party_license_archive" },
  { path: "licenses/THIRD_PARTY_NOTICES.md", role: "third_party_notices" },
  { path: "yuanyuan-reminder.exe", role: "primary_application" },
];

export class StoreReleaseManifestError extends Error {}

function fail(message) {
  throw new StoreReleaseManifestError(message);
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

function exactKeys(value, keys, label) {
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    !exact(Object.keys(value).sort(), [...keys].sort())
  ) {
    fail(`${label} fields do not match the Store release-manifest contract`);
  }
}

function parseTime(value, label, now) {
  const parsed = Date.parse(value);
  if (
    typeof value !== "string" ||
    !Number.isFinite(parsed) ||
    parsed < Date.parse("2026-08-10T00:00:00.000Z") ||
    parsed > now.getTime() + 5 * 60 * 1000
  ) {
    fail(`${label} must be a valid, non-future Store build timestamp`);
  }
}

function validateSbom(sbom, licenseInventory, productVersion) {
  if (
    sbom?.bomFormat !== "CycloneDX" ||
    sbom.specVersion !== "1.6" ||
    sbom.metadata?.component?.name !== "yuanyuan-reminder" ||
    sbom.metadata.component.version !== productVersion ||
    !Array.isArray(sbom.components) ||
    sbom.components.length === 0
  ) {
    fail("CycloneDX SBOM does not describe this Store product version");
  }
  if (
    licenseInventory?.schemaVersion !== 1 ||
    licenseInventory.productVersion !== productVersion ||
    licenseInventory.summary?.components !== sbom.components.length ||
    licenseInventory.summary.unresolved !== 0 ||
    !Array.isArray(licenseInventory.components) ||
    licenseInventory.components.length !== sbom.components.length
  ) {
    fail("third-party license inventory is incomplete or drifted from the SBOM");
  }
  const requiredComponents = sbom.components.filter((component) => component.scope === "required").length;
  if (requiredComponents < 1) fail("SBOM contains no required Store runtime components");
  return { totalComponents: sbom.components.length, requiredComponents };
}

export function createMsixStoreReleaseManifest(
  {
    candidateReport,
    candidateReportBytes,
    identity,
    identityBytes,
    submissionInputs,
    submissionInputsBytes,
    releasePolicy,
    releasePolicyBytes,
    privacyPolicyBytes,
    candidatePackageBytes,
    payloadArtifacts,
    sourceLicenseArtifacts,
    sbom,
    sbomBytes,
    licenseInventory,
    licenseInventoryBytes,
    generatorBytes,
  },
  { now = new Date() } = {},
) {
  parseTime(candidateReport?.generatedAt, "candidateReport.generatedAt", now);
  if (
    candidateReport?.schemaVersion !== 1 ||
    candidateReport.mode !== "msix_store_candidate" ||
    candidateReport.candidate?.signatureStatus !== "NotSigned" ||
    candidateReport.candidate.storeSubmissionReady !== false ||
    candidateReport.candidate.sha256 !== sha256(candidatePackageBytes) ||
    candidateReport.candidate.bytes !== candidatePackageBytes.length ||
    !exact(candidateReport.payload?.files, STORE_RELEASE_PAYLOAD.map((entry) => entry.path)) ||
    candidateReport.payload.exactBoundaryVerified !== true ||
    candidateReport.payload.prototypeSidecarsExcluded !== true ||
    candidateReport.payload.nestedInstallerExcluded !== true
  ) {
    fail("candidate report is not an exact unsigned Store intake package");
  }
  if (
    identity?.schemaVersion !== 1 ||
    identity.status !== "partner_center_confirmed" ||
    candidateReport.manifest?.storeId !== identity.product?.storeId ||
    candidateReport.manifest?.identityName !== identity.package?.identityName ||
    candidateReport.manifest?.packageFamilyName !== identity.package?.packageFamilyName ||
    candidateReport.candidate.version !== identity.platform?.version
  ) {
    fail("Store identity drifted from the candidate report");
  }
  if (
    submissionInputs?.schemaVersion !== 1 ||
    submissionInputs.status !== "human_confirmed_ready_for_partner_center_entry" ||
    submissionInputs.product?.identitySha256 !== sha256(identityBytes) ||
    submissionInputs.outcome?.readyForPartnerCenterEntry !== true ||
    submissionInputs.outcome.partnerCenterSubmissionComplete !== false
  ) {
    fail("Store submission inputs are not the human-confirmed pre-entry record");
  }
  if (
    releasePolicy?.schemaVersion !== 1 ||
    releasePolicy.distribution?.strategy !== "low_cost_staged" ||
    releasePolicy.distribution.selectedChannel !== "pending" ||
    releasePolicy.distribution.plannedStableChannel !== "microsoft_store"
  ) {
    fail("release policy is not the pending low-cost Microsoft Store strategy");
  }

  const payloadKeys = Object.keys(payloadArtifacts ?? {}).sort();
  const expectedPayloadKeys = STORE_RELEASE_PAYLOAD.map((entry) => entry.path).sort();
  if (!exact(payloadKeys, expectedPayloadKeys)) fail("unpacked Store payload files are missing or expanded");
  const payload = STORE_RELEASE_PAYLOAD.map((definition) => {
    const bytes = payloadArtifacts[definition.path];
    if (!Buffer.isBuffer(bytes) || bytes.length === 0) fail(`Store payload file is empty: ${definition.path}`);
    return {
      path: definition.path,
      role: definition.role,
      bytes: bytes.length,
      sha256: sha256(bytes),
    };
  });
  for (const [payloadPath, sourceBytes] of Object.entries(sourceLicenseArtifacts ?? {})) {
    if (!Object.hasOwn(sourceFiles, payloadPath) || !Buffer.isBuffer(sourceBytes)) {
      fail("source license artifact set contains an unexpected entry");
    }
    if (!payloadArtifacts[payloadPath].equals(sourceBytes)) {
      fail(`bundled license drifted from its source: ${payloadPath}`);
    }
  }
  if (!exact(Object.keys(sourceLicenseArtifacts ?? {}).sort(), Object.keys(sourceFiles).sort())) {
    fail("source license artifact set is incomplete");
  }

  const sbomSummary = validateSbom(sbom, licenseInventory, identity.platform.version.replace(/\.0$/u, ""));
  if (!canonicalHash(sha256(generatorBytes))) fail("generator hash could not be computed");
  return {
    schemaVersion: 1,
    mode: "msix_store_release_manifest",
    generatedAt: candidateReport.generatedAt,
    product: {
      storeId: identity.product.storeId,
      reservedProductName: identity.product.reservedProductName,
      identityName: identity.package.identityName,
      packageFamilyName: identity.package.packageFamilyName,
      version: identity.platform.version,
      architecture: identity.platform.architecture,
    },
    sourceControl: {
      gitHead: candidateReport.sourceControl.gitHead,
      cleanCommittedSource: true,
    },
    candidate: {
      path: candidateReport.candidate.path,
      bytes: candidatePackageBytes.length,
      sha256: sha256(candidatePackageBytes),
      signatureStatus: "NotSigned",
      distribution: "microsoft_store_intake_only",
    },
    bindings: {
      candidateReportSha256: sha256(candidateReportBytes),
      storeIdentitySha256: sha256(identityBytes),
      storeSubmissionInputsSha256: sha256(submissionInputsBytes),
      releasePolicySha256: sha256(releasePolicyBytes),
      privacyPolicySha256: sha256(privacyPolicyBytes),
      sbomSha256: sha256(sbomBytes),
      licenseInventorySha256: sha256(licenseInventoryBytes),
      generatorSha256: sha256(generatorBytes),
    },
    payload: {
      fileCount: payload.length,
      files: payload,
      exactBoundaryVerified: true,
    },
    compliance: {
      sbom: {
        path: "src-tauri/target/release/sbom.cdx.json",
        format: "CycloneDX-1.6",
        totalComponents: sbomSummary.totalComponents,
        requiredComponents: sbomSummary.requiredComponents,
      },
      licenseInventory: {
        path: "src-tauri/target/release/third-party-licenses.json",
        unresolved: 0,
      },
      bundledLicensePaths: Object.keys(sourceFiles).sort(),
      privacyPolicyPath: "PRIVACY.md",
      storeSubmissionInputsPath: "docs/release/MSIX_STORE_SUBMISSION_INPUTS_V1.json",
    },
    boundary: {
      prototypeSidecarsExcluded: true,
      qaHarnessesExcluded: true,
      nestedInstallerExcluded: true,
      directDistributionAllowed: false,
      microsoftStoreResigningRequired: true,
      storeCertification: "pending",
    },
  };
}

function runVerifier(script, args = []) {
  const result = spawnSync(process.execPath, [script, ...args], {
    cwd: projectRoot,
    encoding: "utf8",
  });
  if (result.status !== 0) fail(result.stderr.trim() || `${path.basename(script)} failed`);
}

async function readJsonWithBytes(filePath) {
  const bytes = await readFile(filePath);
  return { bytes, document: JSON.parse(bytes.toString("utf8").replace(/^\uFEFF/u, "")) };
}

async function buildExpectedManifest() {
  runVerifier(candidateVerifierPath);
  runVerifier(submissionVerifierPath);
  runVerifier(licenseVerifierPath, ["--check"]);
  const candidateReportRecord = await readJsonWithBytes(candidateReportPath);
  const identityRecord = await readJsonWithBytes(identityPath);
  const submissionRecord = await readJsonWithBytes(submissionInputsPath);
  const releasePolicyRecord = await readJsonWithBytes(releasePolicyPath);
  const sbomRecord = await readJsonWithBytes(sbomPath);
  const licenseInventoryRecord = await readJsonWithBytes(licenseInventoryPath);
  const [
    privacyPolicyBytes,
    candidatePackageBytes,
    generatorBytes,
    payloadEntries,
    sourceLicenseEntries,
  ] = await Promise.all([
    readFile(privacyPolicyPath),
    readFile(path.resolve(projectRoot, candidateReportRecord.document.candidate.path)),
    readFile(generatorPath),
    Promise.all(
      STORE_RELEASE_PAYLOAD.map(async ({ path: relativePath }) => [
        relativePath,
        await readFile(path.join(unpackRoot, ...relativePath.split("/"))),
      ]),
    ),
    Promise.all(
      Object.entries(sourceFiles).map(async ([relativePath, sourcePath]) => [
        relativePath,
        await readFile(sourcePath),
      ]),
    ),
  ]);
  return createMsixStoreReleaseManifest({
    candidateReport: candidateReportRecord.document,
    candidateReportBytes: candidateReportRecord.bytes,
    identity: identityRecord.document,
    identityBytes: identityRecord.bytes,
    submissionInputs: submissionRecord.document,
    submissionInputsBytes: submissionRecord.bytes,
    releasePolicy: releasePolicyRecord.document,
    releasePolicyBytes: releasePolicyRecord.bytes,
    privacyPolicyBytes,
    candidatePackageBytes,
    payloadArtifacts: Object.fromEntries(payloadEntries),
    sourceLicenseArtifacts: Object.fromEntries(sourceLicenseEntries),
    sbom: sbomRecord.document,
    sbomBytes: sbomRecord.bytes,
    licenseInventory: licenseInventoryRecord.document,
    licenseInventoryBytes: licenseInventoryRecord.bytes,
    generatorBytes,
  });
}

async function main() {
  const expected = await buildExpectedManifest();
  if (process.argv.includes("--check")) {
    const actual = JSON.parse((await readFile(outputPath, "utf8")).replace(/^\uFEFF/u, ""));
    if (!exact(actual, expected)) fail("Store release manifest is missing, stale, or modified");
    process.stdout.write(`MSIX Store release manifest verified: ${expected.candidate.sha256}.\n`);
    return;
  }
  await writeFile(outputPath, `${JSON.stringify(expected, null, 2)}\n`, "utf8");
  process.stdout.write(`MSIX Store release manifest written: ${outputPath}\n`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    process.stderr.write(`MSIX Store release manifest pending: ${error.message}\n`);
    process.exitCode = 2;
  });
}
