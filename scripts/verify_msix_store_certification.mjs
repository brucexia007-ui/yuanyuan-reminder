import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import {
  defaultStoreIdentityPath,
  readAndValidateStoreIdentity,
} from "./verify_msix_store_identity.mjs";
import {
  readStorePreSubmissionEvidenceArtifacts,
  validateStorePreSubmissionAcceptance,
} from "./verify_msix_store_pre_submission.mjs";
import { msixStoreRuntimeEvidenceMatches } from "./verify_msix_store_runtime.mjs";
import { inspectPng } from "./verify_msix_store_submission_inputs.mjs";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const certificationAcceptancePath = path.join(
  projectRoot,
  "docs",
  "release",
  "MSIX_STORE_CERTIFICATION_ACCEPTANCE_V1.json",
);
const submissionInputsPath = path.join(
  projectRoot,
  "docs",
  "release",
  "MSIX_STORE_SUBMISSION_INPUTS_V1.json",
);
const preSubmissionAcceptancePath = path.join(
  projectRoot,
  "docs",
  "release",
  "MSIX_STORE_PRE_SUBMISSION_ACCEPTANCE_V1.json",
);
const storeReleaseManifestPath = path.join(
  projectRoot,
  "src-tauri",
  "target",
  "msix-store",
  "msix-store-release-manifest.json",
);
const storeLicenseReviewPacketPath = path.join(
  projectRoot,
  "src-tauri",
  "target",
  "msix-store",
  "msix-store-license-review-packet.json",
);
const storeLicenseReviewAcceptancePath = path.join(
  projectRoot,
  "docs",
  "release",
  "MSIX_STORE_LICENSE_REVIEW_ACCEPTANCE_V1.json",
);
const storeDataLifecycleAcceptancePath = path.join(
  projectRoot,
  "docs",
  "release",
  "MSIX_STORE_DATA_LIFECYCLE_ACCEPTANCE_V1.json",
);
const storeDefenderReportPath = path.join(
  projectRoot,
  "src-tauri",
  "target",
  "msix-store",
  "msix-store-defender-scan.json",
);
const storeSecurityAcceptancePath = path.join(
  projectRoot,
  "docs",
  "release",
  "MSIX_STORE_SECURITY_ACCEPTANCE_V1.json",
);
const certifiedRuntimeReportPath = path.join(
  projectRoot,
  "src-tauri",
  "target",
  "msix-store-runtime",
  "msix-store-certified-runtime-report.json",
);
const runtimeUnpackRoot = path.join(
  projectRoot,
  "src-tauri",
  "target",
  "msix-store-runtime",
  "unpacked",
);
const releasePolicyPath = path.join(projectRoot, "docs", "release", "RELEASE_POLICY_V1.json");
const evidenceRelativePath =
  "src-tauri/target/msix-store-certification/partner-center-redacted-evidence.png";
const evidencePath = path.join(projectRoot, ...evidenceRelativePath.split("/"));
const preSubmissionVerifierPath = path.join(
  projectRoot,
  "scripts",
  "verify_msix_store_pre_submission.mjs",
);
const certifiedRuntimeVerifierPath = path.join(
  projectRoot,
  "scripts",
  "verify_msix_store_runtime.mjs",
);

export class StoreCertificationVerificationError extends Error {}

function fail(message) {
  throw new StoreCertificationVerificationError(message);
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
    fail(`${label} fields do not match the Store certification contract`);
  }
}

function canonicalHash(value, label) {
  if (typeof value !== "string" || !/^[A-F0-9]{64}$/u.test(value)) {
    fail(`${label} must be an uppercase SHA-256 digest`);
  }
}

function validText(value, label, minimum = 1, maximum = 256) {
  if (
    typeof value !== "string" ||
    value !== value.trim() ||
    value.length < minimum ||
    value.length > maximum ||
    /[\u0000-\u001F\u007F]/u.test(value) ||
    /pending|placeholder|example|sample|replace|todo/iu.test(value)
  ) {
    fail(`${label} must contain a final, trimmed value`);
  }
}

function humanName(value, label) {
  validText(value, label, 2, 128);
  if (/\b(?:ai|bot|automation|codex|chatgpt)\b/iu.test(value)) {
    fail(`${label} must identify a human`);
  }
}

function validTimestamp(value, label, now) {
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

function validateReleasePolicy(policy, promoted) {
  if (
    policy?.schemaVersion !== 1 ||
    policy?.distribution?.strategy !== "low_cost_staged" ||
    policy.distribution.previewChannel !== "github_releases" ||
    policy.distribution.previewArtifactPolicy !== "unsigned_beta_with_sha256" ||
    policy.distribution.plannedStableChannel !== "microsoft_store" ||
    !Array.isArray(policy.distribution.allowedChannels) ||
    !policy.distribution.allowedChannels.includes("microsoft_store")
  ) {
    fail("release policy no longer matches the approved low-cost staged strategy");
  }
  const expectedChannel = promoted ? "microsoft_store" : "pending";
  if (policy.distribution.selectedChannel !== expectedChannel) {
    fail(`release policy selectedChannel must be ${expectedChannel}`);
  }
}

export function validateStoreCertificationAcceptance(
  document,
  {
    expectedStoreId,
    expectedBindings,
    evidenceArtifact,
    promoted = false,
    now = new Date(),
  } = {},
) {
  exactKeys(
    document,
    ["schemaVersion", "status", "partnerCenter", "evidence", "bindings", "outcome"],
    "certification acceptance",
  );
  if (document.schemaVersion !== 1) fail("schemaVersion must be 1");
  const expectedStatus = promoted
    ? "store_certified_channel_promoted"
    : "store_certified_ready_for_channel_promotion";
  if (document.status !== expectedStatus) fail(`status must be ${expectedStatus}`);

  exactKeys(
    document.partnerCenter,
    [
      "productStoreId",
      "submissionId",
      "certificationStatus",
      "publicationStatus",
      "certifiedAt",
      "publishedAt",
      "storeListingUrl",
      "restrictedCapabilityApproval",
      "iarc",
    ],
    "partnerCenter",
  );
  if (document.partnerCenter.productStoreId !== expectedStoreId) {
    fail("partnerCenter.productStoreId drifted from the Store identity");
  }
  validText(document.partnerCenter.submissionId, "partnerCenter.submissionId", 1, 128);
  if (!/^[A-Za-z0-9._-]+$/u.test(document.partnerCenter.submissionId)) {
    fail("partnerCenter.submissionId contains unsupported characters");
  }
  if (document.partnerCenter.certificationStatus !== "passed") {
    fail("Partner Center certification must be passed");
  }
  if (document.partnerCenter.publicationStatus !== "in_microsoft_store") {
    fail("Partner Center publication status must be in_microsoft_store");
  }
  const certifiedAt = validTimestamp(document.partnerCenter.certifiedAt, "partnerCenter.certifiedAt", now);
  const publishedAt = validTimestamp(document.partnerCenter.publishedAt, "partnerCenter.publishedAt", now);
  if (publishedAt < certifiedAt) fail("partnerCenter.publishedAt must not precede certifiedAt");
  let listingUrl;
  try {
    listingUrl = new URL(document.partnerCenter.storeListingUrl);
  } catch {
    fail("partnerCenter.storeListingUrl must be a valid URL");
  }
  if (
    listingUrl.protocol !== "https:" ||
    listingUrl.hostname.toLowerCase() !== "apps.microsoft.com" ||
    !listingUrl.href.toLowerCase().includes(String(expectedStoreId).toLowerCase())
  ) {
    fail("partnerCenter.storeListingUrl must be the HTTPS Microsoft Store listing for this Store ID");
  }
  if (document.partnerCenter.restrictedCapabilityApproval !== "approved") {
    fail("runFullTrust restricted-capability approval must be approved");
  }
  exactKeys(document.partnerCenter.iarc, ["ratingId", "ratings"], "partnerCenter.iarc");
  validText(document.partnerCenter.iarc.ratingId, "partnerCenter.iarc.ratingId", 1, 128);
  if (
    !Array.isArray(document.partnerCenter.iarc.ratings) ||
    document.partnerCenter.iarc.ratings.length < 1 ||
    document.partnerCenter.iarc.ratings.length > 30
  ) {
    fail("partnerCenter.iarc.ratings must record the Partner Center ratings");
  }
  const ratingSystems = new Set();
  for (const [index, rating] of document.partnerCenter.iarc.ratings.entries()) {
    exactKeys(rating, ["system", "rating"], `partnerCenter.iarc.ratings[${index}]`);
    validText(rating.system, `partnerCenter.iarc.ratings[${index}].system`, 1, 64);
    validText(rating.rating, `partnerCenter.iarc.ratings[${index}].rating`, 1, 64);
    const key = rating.system.toLowerCase();
    if (ratingSystems.has(key)) fail("partnerCenter.iarc.ratings contains duplicate systems");
    ratingSystems.add(key);
  }

  exactKeys(document.evidence, ["path", "sha256", "redacted", "reviewedBy", "reviewedAt"], "evidence");
  if (document.evidence.path !== evidenceRelativePath) fail("evidence.path must use the fixed local evidence path");
  canonicalHash(document.evidence.sha256, "evidence.sha256");
  if (document.evidence.redacted !== true) fail("Partner Center evidence must be redacted");
  humanName(document.evidence.reviewedBy, "evidence.reviewedBy");
  validTimestamp(document.evidence.reviewedAt, "evidence.reviewedAt", now);
  if (
    !evidenceArtifact ||
    document.evidence.sha256 !== evidenceArtifact.sha256 ||
    evidenceArtifact.format !== "png"
  ) {
    fail("redacted Partner Center evidence hash or format does not match");
  }

  exactKeys(
    document.bindings,
    [
      "storeIdentitySha256",
      "storeSubmissionInputsSha256",
      "storeReleaseManifestSha256",
      "storeLicenseReviewPacketSha256",
      "storeLicenseReviewAcceptanceSha256",
      "storeDataLifecycleAcceptanceSha256",
      "storeDefenderReportSha256",
      "storeSecurityAcceptanceSha256",
      "preSubmissionAcceptanceSha256",
      "certifiedRuntimeReportSha256",
      "microsoftSignedPackageSha256",
      "releasePolicyBeforePromotionSha256",
    ],
    "bindings",
  );
  for (const [name, digest] of Object.entries(document.bindings)) canonicalHash(digest, `bindings.${name}`);
  if (!exact(document.bindings, expectedBindings)) fail("certification evidence bindings drifted");

  exactKeys(
    document.outcome,
    [
      "blockingFindings",
      "readyToSelectMicrosoftStore",
      "approvedBy",
      "approvedAt",
      "selectedChannel",
      "releasePolicyAfterPromotionSha256",
      "promotedBy",
      "promotedAt",
    ],
    "outcome",
  );
  if (!Array.isArray(document.outcome.blockingFindings) || document.outcome.blockingFindings.length !== 0) {
    fail("outcome.blockingFindings must be empty");
  }
  if (document.outcome.readyToSelectMicrosoftStore !== true) {
    fail("outcome.readyToSelectMicrosoftStore must be true");
  }
  humanName(document.outcome.approvedBy, "outcome.approvedBy");
  const approvedAt = validTimestamp(document.outcome.approvedAt, "outcome.approvedAt", now);
  if (approvedAt < publishedAt) fail("outcome.approvedAt must not precede Store publication");

  if (!promoted) {
    if (
      document.outcome.selectedChannel !== "pending" ||
      document.outcome.releasePolicyAfterPromotionSha256 !== null ||
      document.outcome.promotedBy !== null ||
      document.outcome.promotedAt !== null
    ) {
      fail("channel promotion fields must remain pending until the release policy is changed");
    }
  } else {
    if (document.outcome.selectedChannel !== "microsoft_store") {
      fail("outcome.selectedChannel must be microsoft_store after promotion");
    }
    canonicalHash(
      document.outcome.releasePolicyAfterPromotionSha256,
      "outcome.releasePolicyAfterPromotionSha256",
    );
    humanName(document.outcome.promotedBy, "outcome.promotedBy");
    const promotedAt = validTimestamp(document.outcome.promotedAt, "outcome.promotedAt", now);
    if (promotedAt < approvedAt) fail("outcome.promotedAt must not precede approvedAt");
  }
  return document;
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex").toUpperCase();
}

export function derivePendingPolicyHashFromPromotedBytes(bytes) {
  const text = bytes.toString("utf8").replace(/^\uFEFF/u, "");
  const marker = '"selectedChannel": "microsoft_store"';
  const first = text.indexOf(marker);
  if (first < 0 || text.indexOf(marker, first + marker.length) >= 0) {
    fail("promoted release policy must contain exactly one canonical Microsoft Store channel field");
  }
  const pendingText = `${text.slice(0, first)}"selectedChannel": "pending"${text.slice(first + marker.length)}`;
  return sha256(Buffer.from(pendingText, "utf8"));
}

function runVerifier(verifierPath, args = []) {
  const result = spawnSync(process.execPath, [verifierPath, ...args], {
    cwd: projectRoot,
    encoding: "utf8",
  });
  if (result.status !== 0) fail(result.stderr.trim() || `${path.basename(verifierPath)} failed`);
}

async function main() {
  const promoted = process.argv.includes("--promoted");
  const identity = readAndValidateStoreIdentity(defaultStoreIdentityPath);
  if (!promoted) {
    runVerifier(preSubmissionVerifierPath);
    runVerifier(certifiedRuntimeVerifierPath, ["--certified"]);
  }

  const [
    acceptanceBytes,
    identityBytes,
    submissionInputsBytes,
    storeReleaseManifestBytes,
    storeLicenseReviewPacketBytes,
    storeLicenseReviewAcceptanceBytes,
    storeDataLifecycleAcceptanceBytes,
    storeDefenderReportBytes,
    storeSecurityAcceptanceBytes,
    preSubmissionBytes,
    certifiedRuntimeBytes,
    releasePolicyBytes,
    evidenceBytes,
    preSubmissionEvidenceArtifacts,
  ] = await Promise.all([
    readFile(certificationAcceptancePath),
    readFile(defaultStoreIdentityPath),
    readFile(submissionInputsPath),
    readFile(storeReleaseManifestPath),
    readFile(storeLicenseReviewPacketPath),
    readFile(storeLicenseReviewAcceptancePath),
    readFile(storeDataLifecycleAcceptancePath),
    readFile(storeDefenderReportPath),
    readFile(storeSecurityAcceptancePath),
    readFile(preSubmissionAcceptancePath),
    readFile(certifiedRuntimeReportPath),
    readFile(releasePolicyPath),
    readFile(evidencePath),
    readStorePreSubmissionEvidenceArtifacts(),
  ]);
  const document = JSON.parse(acceptanceBytes.toString("utf8").replace(/^\uFEFF/u, ""));
  const preSubmission = validateStorePreSubmissionAcceptance(
    JSON.parse(preSubmissionBytes.toString("utf8").replace(/^\uFEFF/u, "")),
    { evidenceArtifacts: preSubmissionEvidenceArtifacts },
  );
  if (preSubmission.outcome.storeCertification !== "pending") {
    fail("the pre-submission record must remain an immutable pending-certification snapshot");
  }
  const runtimeReport = JSON.parse(certifiedRuntimeBytes.toString("utf8").replace(/^\uFEFF/u, ""));
  const packageBytes = await readFile(path.resolve(runtimeReport.candidate.sourcePath));
  const storeReleaseManifest = JSON.parse(
    storeReleaseManifestBytes.toString("utf8").replace(/^\uFEFF/u, ""),
  );
  const trustedPayloadArtifacts = Object.fromEntries(
    await Promise.all(
      storeReleaseManifest.payload.files
        .filter((item) => item.path !== "AppxBlockMap.xml")
        .map(async (item) => [
          item.path,
          await readFile(path.join(runtimeUnpackRoot, ...item.path.split("/"))),
        ]),
    ),
  );
  if (
    !msixStoreRuntimeEvidenceMatches({
      report: runtimeReport,
      identity,
      packageBytes,
      storeReleaseManifest,
      storeReleaseManifestBytes,
      trustedPayloadArtifacts,
      expectedSignatureOrigin: "microsoft_store",
    })
  ) {
    fail("Microsoft-signed runtime evidence does not match the Store identity or package");
  }
  const releasePolicy = JSON.parse(releasePolicyBytes.toString("utf8").replace(/^\uFEFF/u, ""));
  validateReleasePolicy(releasePolicy, promoted);
  const evidenceArtifact = inspectPng(evidenceBytes);
  const expectedBindings = {
    storeIdentitySha256: sha256(identityBytes),
    storeSubmissionInputsSha256: sha256(submissionInputsBytes),
    storeReleaseManifestSha256: sha256(storeReleaseManifestBytes),
    storeLicenseReviewPacketSha256: sha256(storeLicenseReviewPacketBytes),
    storeLicenseReviewAcceptanceSha256: sha256(storeLicenseReviewAcceptanceBytes),
    storeDataLifecycleAcceptanceSha256: sha256(storeDataLifecycleAcceptanceBytes),
    storeDefenderReportSha256: sha256(storeDefenderReportBytes),
    storeSecurityAcceptanceSha256: sha256(storeSecurityAcceptanceBytes),
    preSubmissionAcceptanceSha256: sha256(preSubmissionBytes),
    certifiedRuntimeReportSha256: sha256(certifiedRuntimeBytes),
    microsoftSignedPackageSha256: sha256(packageBytes),
    releasePolicyBeforePromotionSha256: promoted
      ? document.bindings.releasePolicyBeforePromotionSha256
      : sha256(releasePolicyBytes),
  };
  const accepted = validateStoreCertificationAcceptance(document, {
    expectedStoreId: identity.product.storeId,
    expectedBindings,
    evidenceArtifact,
    promoted,
  });
  const runtimeTime = Date.parse(runtimeReport.testedAt);
  if (
    Date.parse(accepted.evidence.reviewedAt) < runtimeTime ||
    Date.parse(accepted.outcome.approvedAt) < runtimeTime
  ) {
    fail("evidence review and release approval must occur after the certified-package runtime test");
  }
  if (promoted) {
    const currentPolicyHash = sha256(releasePolicyBytes);
    if (
      accepted.outcome.releasePolicyAfterPromotionSha256 !== currentPolicyHash ||
      accepted.bindings.releasePolicyBeforePromotionSha256 === currentPolicyHash ||
      accepted.bindings.releasePolicyBeforePromotionSha256 !==
        derivePendingPolicyHashFromPromotedBytes(releasePolicyBytes)
    ) {
      fail("release policy promotion changed more than selectedChannel or its hash is stale");
    }
    process.stdout.write(
      `Microsoft Store channel promotion verified: ${identity.product.storeId}, package ${accepted.bindings.microsoftSignedPackageSha256}.\n`,
    );
  } else {
    process.stdout.write(
      `Store certification and publication evidence verified for ${identity.product.storeId}; release policy is ready for human promotion.\n`,
    );
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    process.stderr.write(`MSIX Store certification gate pending: ${error.message}\n`);
    process.exitCode = 2;
  });
}
