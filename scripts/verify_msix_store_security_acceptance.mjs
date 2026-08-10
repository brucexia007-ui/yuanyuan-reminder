import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import { inspectPng } from "./verify_msix_store_submission_inputs.mjs";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const storeTargetRoot = path.join(projectRoot, "src-tauri", "target", "msix-store");
const securityEvidenceRoot = path.join(
  projectRoot,
  "src-tauri",
  "target",
  "msix-store-security",
);
const acceptancePath = path.join(
  projectRoot,
  "docs",
  "release",
  "MSIX_STORE_SECURITY_ACCEPTANCE_V1.json",
);
const storeReleaseManifestPath = path.join(storeTargetRoot, "msix-store-release-manifest.json");
const storeDefenderReportPath = path.join(storeTargetRoot, "msix-store-defender-scan.json");
const releasePolicyPath = path.join(projectRoot, "docs", "release", "RELEASE_POLICY_V1.json");
const storeReleaseManifestVerifierPath = path.join(
  projectRoot,
  "scripts",
  "generate_msix_store_release_manifest.mjs",
);
const storeDefenderVerifierPath = path.join(
  projectRoot,
  "scripts",
  "verify_msix_store_defender.mjs",
);
const verifierPath = fileURLToPath(import.meta.url);

export const STORE_SECURITY_ATTESTATION_TEXT =
  "I attest that the recorded third-party security-product observations were performed by the named human testers on the exact unsigned Microsoft Store intake candidate and unpacked payload bound by this document, with real-time protection enabled and no omitted detection or unresolved result.";

export class StoreSecurityAcceptanceError extends Error {}

function fail(message) {
  throw new StoreSecurityAcceptanceError(message);
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
    fail(`${label} fields do not match the Store security-acceptance contract`);
  }
}

function canonicalHash(value, label) {
  if (typeof value !== "string" || !/^[A-F0-9]{64}$/u.test(value)) {
    fail(`${label} must be an uppercase SHA-256 digest`);
  }
}

function validText(value, label, minimum = 1, maximum = 200) {
  if (
    typeof value !== "string" ||
    value !== value.trim() ||
    value.length < minimum ||
    value.length > maximum ||
    /[\u0000-\u001F\u007F]/u.test(value)
  ) {
    fail(`${label} must be a trimmed, non-control string`);
  }
}

function humanTester(value, label) {
  exactKeys(value, ["name", "role", "organization", "humanTester"], label);
  validText(value.name, `${label}.name`, 2, 80);
  validText(value.role, `${label}.role`, 3, 80);
  validText(value.organization, `${label}.organization`, 2, 120);
  if (
    value.humanTester !== true ||
    /(?:\bcodex\b|\bchatgpt\b|\bai\b|\bbot\b|automated|automation|人工智能|自动化)/iu.test(
      `${value.name} ${value.role} ${value.organization}`,
    )
  ) {
    fail(`${label} must identify a human tester`);
  }
}

function humanName(value, label) {
  validText(value, label, 2, 128);
  if (/(?:\bcodex\b|\bchatgpt\b|\bai\b|\bbot\b|automated|automation|人工智能|自动化)/iu.test(value)) {
    fail(`${label} must identify a human approver`);
  }
}

function timestamp(value, label, minimumTime, now) {
  const parsed = Date.parse(value);
  if (
    typeof value !== "string" ||
    !Number.isFinite(parsed) ||
    parsed < minimumTime ||
    parsed > now.getTime() + 5 * 60 * 1000
  ) {
    fail(`${label} must be a valid, non-future timestamp after the Store candidate`);
  }
  return parsed;
}

function expectedTargets(storeReleaseManifest) {
  return [
    {
      id: "unsigned_store_candidate",
      path: storeReleaseManifest.candidate.path,
      bytes: storeReleaseManifest.candidate.bytes,
      sha256: storeReleaseManifest.candidate.sha256,
    },
    ...storeReleaseManifest.payload.files.map((payload) => ({
      id: `payload:${payload.path}`,
      path: `src-tauri/target/msix-store/unpacked/${payload.path}`,
      bytes: payload.bytes,
      sha256: payload.sha256,
    })),
  ];
}

export function validateMsixStoreSecurityAcceptance(
  document,
  {
    storeReleaseManifest,
    storeReleaseManifestBytes,
    storeDefenderReportBytes,
    releasePolicy,
    releasePolicyBytes,
    verifierBytes,
    evidenceArtifacts,
    now = new Date(),
  } = {},
) {
  exactKeys(
    document,
    ["schemaVersion", "status", "bindings", "requirements", "securityProducts", "outcome", "attestationText"],
    "acceptance",
  );
  if (document.schemaVersion !== 1 || document.status !== "human_accepted_store_security_matrix") {
    fail("Store security acceptance must be human_accepted_store_security_matrix");
  }
  if (
    storeReleaseManifest?.schemaVersion !== 1 ||
    storeReleaseManifest.mode !== "msix_store_release_manifest" ||
    storeReleaseManifest.boundary?.directDistributionAllowed !== false ||
    storeReleaseManifest.boundary?.microsoftStoreResigningRequired !== true
  ) {
    fail("Store release manifest does not authorize the Store-only security matrix");
  }
  const minimumProducts = releasePolicy?.manualReleaseGates?.minimumThirdPartySecurityProducts;
  if (
    !Number.isInteger(minimumProducts) ||
    minimumProducts < 2 ||
    releasePolicy.manualReleaseGates.requireDefenderScan !== true
  ) {
    fail("release policy must require Defender and at least two third-party security products");
  }
  exactKeys(
    document.bindings,
    [
      "storeReleaseManifestSha256",
      "storeDefenderReportSha256",
      "unsignedStoreCandidateSha256",
      "releasePolicySha256",
      "verifierSha256",
    ],
    "bindings",
  );
  const expectedBindings = {
    storeReleaseManifestSha256: sha256(storeReleaseManifestBytes),
    storeDefenderReportSha256: sha256(storeDefenderReportBytes),
    unsignedStoreCandidateSha256: storeReleaseManifest.candidate.sha256,
    releasePolicySha256: sha256(releasePolicyBytes),
    verifierSha256: sha256(verifierBytes),
  };
  for (const [name, value] of Object.entries(document.bindings)) canonicalHash(value, `bindings.${name}`);
  if (!exact(document.bindings, expectedBindings)) fail("Store security evidence bindings drifted");

  exactKeys(
    document.requirements,
    [
      "minimumThirdPartySecurityProducts",
      "defenderEvidenceRequired",
      "smartScreenDisposition",
      "directDistributionAllowed",
    ],
    "requirements",
  );
  if (
    document.requirements.minimumThirdPartySecurityProducts !== minimumProducts ||
    document.requirements.defenderEvidenceRequired !== true ||
    document.requirements.smartScreenDisposition !== "not_applicable_store_managed_distribution" ||
    document.requirements.directDistributionAllowed !== false
  ) {
    fail("Store security requirements drifted from the Store-only distribution boundary");
  }
  if (
    !Array.isArray(document.securityProducts) ||
    document.securityProducts.length < minimumProducts ||
    document.securityProducts.length > 6
  ) {
    fail(`securityProducts must contain ${minimumProducts}-6 observations`);
  }
  const candidateTime = Date.parse(storeReleaseManifest.generatedAt);
  if (!Number.isFinite(candidateTime)) fail("Store release manifest timestamp is invalid");
  const targets = expectedTargets(storeReleaseManifest);
  const productNames = new Set();
  const vendorNames = new Set();
  const snapshotHashes = new Set();
  const evidencePaths = new Set();
  let latestTestTime = candidateTime;
  for (const [index, observation] of document.securityProducts.entries()) {
    const label = `securityProducts[${index}]`;
    exactKeys(
      observation,
      [
        "vendorName",
        "productName",
        "productVersion",
        "engineVersion",
        "definitionVersion",
        "definitionsUpdatedAt",
        "testedAt",
        "tester",
        "environment",
        "targets",
        "realTimeProtectionEnabled",
        "scanMode",
        "detections",
        "evidence",
        "notes",
        "passed",
      ],
      label,
    );
    validText(observation.vendorName, `${label}.vendorName`, 2, 100);
    validText(observation.productName, `${label}.productName`, 2, 120);
    if (/(?:windows|microsoft)\s*defender/iu.test(`${observation.vendorName} ${observation.productName}`)) {
      fail(`${label} must be a non-Defender security product`);
    }
    const productKey = observation.productName.toLocaleLowerCase("en-US");
    const vendorKey = observation.vendorName.toLocaleLowerCase("en-US");
    if (productNames.has(productKey) || vendorNames.has(vendorKey)) {
      fail("security products and vendors must be distinct");
    }
    productNames.add(productKey);
    vendorNames.add(vendorKey);
    validText(observation.productVersion, `${label}.productVersion`, 1, 80);
    validText(observation.engineVersion, `${label}.engineVersion`, 1, 80);
    validText(observation.definitionVersion, `${label}.definitionVersion`, 1, 120);
    const testedAt = timestamp(observation.testedAt, `${label}.testedAt`, candidateTime, now);
    const definitionsUpdatedAt = timestamp(
      observation.definitionsUpdatedAt,
      `${label}.definitionsUpdatedAt`,
      candidateTime - 7 * 24 * 60 * 60 * 1000,
      now,
    );
    if (definitionsUpdatedAt > testedAt + 5 * 60 * 1000 || testedAt - definitionsUpdatedAt > 72 * 60 * 60 * 1000) {
      fail(`${label} security definitions must be no more than 72 hours old`);
    }
    latestTestTime = Math.max(latestTestTime, testedAt);
    humanTester(observation.tester, `${label}.tester`);
    exactKeys(
      observation.environment,
      ["machineAlias", "windowsEdition", "windowsVersion", "osBuild", "accountType", "cleanSnapshotSha256"],
      `${label}.environment`,
    );
    validText(observation.environment.machineAlias, `${label}.environment.machineAlias`, 3, 80);
    validText(observation.environment.windowsEdition, `${label}.environment.windowsEdition`, 3, 80);
    validText(observation.environment.windowsVersion, `${label}.environment.windowsVersion`, 2, 40);
    if (!/^10\.0\.(?:2[2-9][0-9]{3}|[3-9][0-9]{4,})\.\d+$/u.test(observation.environment.osBuild)) {
      fail(`${label}.environment.osBuild must identify Windows 11`);
    }
    if (!['standard_user', 'administrator'].includes(observation.environment.accountType)) {
      fail(`${label}.environment.accountType is invalid`);
    }
    canonicalHash(observation.environment.cleanSnapshotSha256, `${label}.environment.cleanSnapshotSha256`);
    if (snapshotHashes.has(observation.environment.cleanSnapshotSha256)) {
      fail("each security product must use a distinct clean snapshot");
    }
    snapshotHashes.add(observation.environment.cleanSnapshotSha256);
    if (!exact(observation.targets, targets)) fail(`${label}.targets drifted from the Store manifest`);
    if (
      observation.realTimeProtectionEnabled !== true ||
      observation.scanMode !== "full_candidate_and_unpacked_payload" ||
      !Array.isArray(observation.detections) ||
      observation.detections.length !== 0 ||
      observation.passed !== true
    ) {
      fail(`${label} must record real-time protection, complete scans, zero detections, and pass`);
    }
    exactKeys(observation.evidence, ["path", "sha256", "redacted"], `${label}.evidence`);
    if (!/^src-tauri\/target\/msix-store-security\/[a-z0-9][a-z0-9-]{1,62}-redacted-evidence\.png$/u.test(observation.evidence.path)) {
      fail(`${label}.evidence.path must use the fixed ignored evidence directory`);
    }
    canonicalHash(observation.evidence.sha256, `${label}.evidence.sha256`);
    if (observation.evidence.redacted !== true || evidencePaths.has(observation.evidence.path)) {
      fail("security evidence must be redacted and uniquely referenced");
    }
    evidencePaths.add(observation.evidence.path);
    const evidenceArtifact = evidenceArtifacts?.[observation.evidence.path];
    if (!evidenceArtifact || evidenceArtifact.format !== "png" || evidenceArtifact.sha256 !== observation.evidence.sha256) {
      fail(`${label}.evidence does not match the redacted PNG artifact`);
    }
    validText(observation.notes, `${label}.notes`, 20, 1000);
  }

  exactKeys(
    document.outcome,
    ["blockingFindings", "verifiedThirdPartySecurityProducts", "approvedBy", "approvedAt", "accepted"],
    "outcome",
  );
  if (!Array.isArray(document.outcome.blockingFindings) || document.outcome.blockingFindings.length !== 0) {
    fail("outcome.blockingFindings must be empty");
  }
  if (document.outcome.verifiedThirdPartySecurityProducts !== document.securityProducts.length) {
    fail("verifiedThirdPartySecurityProducts must equal the observation count");
  }
  humanName(document.outcome.approvedBy, "outcome.approvedBy");
  const approvedAt = timestamp(document.outcome.approvedAt, "outcome.approvedAt", candidateTime, now);
  if (approvedAt < latestTestTime || document.outcome.accepted !== true) {
    fail("Store security approval must follow all tests and be accepted");
  }
  if (document.attestationText !== STORE_SECURITY_ATTESTATION_TEXT) {
    fail("Store security attestation text was changed");
  }
  return document;
}

function runVerifier(script, args = []) {
  const result = spawnSync(process.execPath, [script, ...args], {
    cwd: projectRoot,
    encoding: "utf8",
  });
  if (result.status !== 0) fail(result.stderr.trim() || `${path.basename(script)} failed`);
}

async function main() {
  runVerifier(storeReleaseManifestVerifierPath, ["--check"]);
  runVerifier(storeDefenderVerifierPath);
  const [
    acceptanceBytes,
    storeReleaseManifestBytes,
    storeDefenderReportBytes,
    releasePolicyBytes,
    verifierBytes,
  ] = await Promise.all([
    readFile(acceptancePath),
    readFile(storeReleaseManifestPath),
    readFile(storeDefenderReportPath),
    readFile(releasePolicyPath),
    readFile(verifierPath),
  ]);
  const document = JSON.parse(acceptanceBytes.toString("utf8").replace(/^\uFEFF/u, ""));
  const storeReleaseManifest = JSON.parse(
    storeReleaseManifestBytes.toString("utf8").replace(/^\uFEFF/u, ""),
  );
  const releasePolicy = JSON.parse(releasePolicyBytes.toString("utf8").replace(/^\uFEFF/u, ""));
  const evidenceEntries = await Promise.all(
    document.securityProducts.map(async (observation) => {
      const absolutePath = path.resolve(projectRoot, ...observation.evidence.path.split("/"));
      const ownedPrefix = `${path.resolve(securityEvidenceRoot)}${path.sep}`.toLowerCase();
      if (!absolutePath.toLowerCase().startsWith(ownedPrefix)) fail("security evidence path escaped its ignored directory");
      return [observation.evidence.path, inspectPng(await readFile(absolutePath))];
    }),
  );
  const accepted = validateMsixStoreSecurityAcceptance(document, {
    storeReleaseManifest,
    storeReleaseManifestBytes,
    storeDefenderReportBytes,
    releasePolicy,
    releasePolicyBytes,
    verifierBytes,
    evidenceArtifacts: Object.fromEntries(evidenceEntries),
  });
  process.stdout.write(
    `MSIX Store security acceptance verified for ${accepted.securityProducts.length} distinct non-Defender products.\n`,
  );
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    process.stderr.write(`MSIX Store security acceptance pending: ${error.message}\n`);
    process.exitCode = 2;
  });
}
