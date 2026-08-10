import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import {
  defaultStoreIdentityPath,
  readAndValidateStoreIdentity,
} from "./verify_msix_store_identity.mjs";
import { inspectPng } from "./verify_msix_store_submission_inputs.mjs";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const acceptancePath = path.join(
  projectRoot,
  "docs",
  "release",
  "MSIX_STORE_PRE_SUBMISSION_ACCEPTANCE_V1.json",
);
const storeTargetRoot = path.join(projectRoot, "src-tauri", "target", "msix-store");
const candidateReportPath = path.join(storeTargetRoot, "msix-store-candidate-report.json");
const wackExecutionReportPath = path.join(storeTargetRoot, "wack-execution-report.json");
const wackRawReportPath = path.join(storeTargetRoot, "wack-report.xml");
const runtimeReportPath = path.join(
  projectRoot,
  "src-tauri",
  "target",
  "msix-store-runtime",
  "msix-store-runtime-report.json",
);
const submissionInputsPath = path.join(
  projectRoot,
  "docs",
  "release",
  "MSIX_STORE_SUBMISSION_INPUTS_V1.json",
);
const storeReleaseManifestPath = path.join(
  storeTargetRoot,
  "msix-store-release-manifest.json",
);
const storeLicenseReviewPacketPath = path.join(
  storeTargetRoot,
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
const storeDefenderReportPath = path.join(storeTargetRoot, "msix-store-defender-scan.json");
const storeSecurityAcceptancePath = path.join(
  projectRoot,
  "docs",
  "release",
  "MSIX_STORE_SECURITY_ACCEPTANCE_V1.json",
);
const privacyPolicyPath = path.join(projectRoot, "PRIVACY.md");
const candidateVerifierPath = path.join(projectRoot, "scripts", "verify_msix_store_candidate.mjs");
const submissionInputsVerifierPath = path.join(
  projectRoot,
  "scripts",
  "verify_msix_store_submission_inputs.mjs",
);
const storeReleaseManifestVerifierPath = path.join(
  projectRoot,
  "scripts",
  "generate_msix_store_release_manifest.mjs",
);
const storeLicenseReviewVerifierPath = path.join(
  projectRoot,
  "scripts",
  "verify_msix_store_license_review.mjs",
);
const storeDataLifecycleVerifierPath = path.join(
  projectRoot,
  "scripts",
  "verify_msix_store_data_lifecycle.mjs",
);
const storeDefenderVerifierPath = path.join(
  projectRoot,
  "scripts",
  "verify_msix_store_defender.mjs",
);
const storeSecurityVerifierPath = path.join(
  projectRoot,
  "scripts",
  "verify_msix_store_security_acceptance.mjs",
);
const runtimeVerifierPath = path.join(projectRoot, "scripts", "verify_msix_store_runtime.mjs");
const wackVerifierPath = path.join(projectRoot, "scripts", "verify_msix_store_wack.mjs");

export const STORE_PRE_SUBMISSION_CHECK_NAMES = [
  "trustedInstallAndLaunch",
  "trayPresence",
  "autostartAfterSignIn",
  "notificationDelivery",
  "singleInstance",
  "webView2Startup",
  "nsisToMsixMigration",
  "backupRestore",
  "updateForward",
  "uninstallKeepData",
  "uninstallDeleteData",
  "accessibility",
  "wackReportReview",
];

const storePreSubmissionEvidenceRoot = path.join(
  projectRoot,
  "src-tauri",
  "target",
  "msix-store-pre-submission",
);

export function storePreSubmissionEvidenceRelativePath(checkName) {
  if (!STORE_PRE_SUBMISSION_CHECK_NAMES.includes(checkName)) {
    fail(`unknown Store pre-submission check: ${checkName}`);
  }
  return `src-tauri/target/msix-store-pre-submission/${checkName}-redacted-evidence.png`;
}

export class StorePreSubmissionVerificationError extends Error {}

function fail(message) {
  throw new StorePreSubmissionVerificationError(message);
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
    fail(`${label} fields do not match the pre-submission contract`);
  }
}

function canonicalHash(value, label) {
  if (typeof value !== "string" || !/^[A-F0-9]{64}$/.test(value)) {
    fail(`${label} must be an uppercase SHA-256 digest`);
  }
}

function humanName(value, label) {
  if (typeof value !== "string" || value !== value.trim() || value.length < 2 || value.length > 128) {
    fail(`${label} must identify a human`);
  }
  if (/\b(?:ai|bot|automation|codex|chatgpt)\b/i.test(value)) {
    fail(`${label} must identify a human`);
  }
}

function validTimestamp(value, label, now) {
  if (typeof value !== "string") fail(`${label} must be an ISO timestamp`);
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed) || parsed > now.getTime() + 5 * 60 * 1000) {
    fail(`${label} must be a valid, non-future ISO timestamp`);
  }
}

export function validateStorePreSubmissionAcceptance(
  document,
  { now = new Date(), evidenceArtifacts } = {},
) {
  exactKeys(
    document,
    ["schemaVersion", "status", "candidate", "environment", "checks", "outcome"],
    "acceptance",
  );
  if (document.schemaVersion !== 1) fail("schemaVersion must be 1");
  if (document.status !== "human_accepted_for_store_submission") {
    fail("status must be human_accepted_for_store_submission");
  }
  exactKeys(
    document.candidate,
    [
      "storeIdentitySha256",
      "storeSubmissionInputsSha256",
      "storeReleaseManifestSha256",
      "storeLicenseReviewPacketSha256",
      "storeLicenseReviewAcceptanceSha256",
      "storeDataLifecycleAcceptanceSha256",
      "storeDefenderReportSha256",
      "storeSecurityAcceptanceSha256",
      "privacyPolicySha256",
      "storeCandidateReportSha256",
      "unsignedStoreCandidateSha256",
      "disposableTestSignedPackageSha256",
      "runtimeReportSha256",
      "wackExecutionReportSha256",
      "wackRawReportSha256",
    ],
    "candidate",
  );
  for (const [name, digest] of Object.entries(document.candidate)) canonicalHash(digest, `candidate.${name}`);

  exactKeys(document.environment, ["tester", "testedAt", "windowsVersion", "machineType"], "environment");
  humanName(document.environment.tester, "environment.tester");
  validTimestamp(document.environment.testedAt, "environment.testedAt", now);
  if (!/^10\.0\.(?:2[2-9][0-9]{3}|[3-9][0-9]{4,})\.\d+$/.test(document.environment.windowsVersion)) {
    fail("environment.windowsVersion must identify Windows 11");
  }
  if (document.environment.machineType !== "clean_windows_11_vm_or_dedicated_machine") {
    fail("environment.machineType must be clean_windows_11_vm_or_dedicated_machine");
  }

  exactKeys(document.checks, STORE_PRE_SUBMISSION_CHECK_NAMES, "checks");
  for (const checkName of STORE_PRE_SUBMISSION_CHECK_NAMES) {
    const check = document.checks[checkName];
    exactKeys(
      check,
      ["status", "evidencePath", "evidenceSha256", "redacted", "notes"],
      `checks.${checkName}`,
    );
    if (check.status !== "passed") fail(`checks.${checkName}.status must be passed`);
    const expectedPath = storePreSubmissionEvidenceRelativePath(checkName);
    if (check.evidencePath !== expectedPath) {
      fail(`checks.${checkName}.evidencePath must use the fixed redacted evidence path`);
    }
    canonicalHash(check.evidenceSha256, `checks.${checkName}.evidenceSha256`);
    if (check.redacted !== true) fail(`checks.${checkName}.redacted must be true`);
    const artifact = evidenceArtifacts?.[expectedPath];
    if (
      !artifact ||
      artifact.format !== "png" ||
      artifact.width < 320 ||
      artifact.height < 180 ||
      artifact.sha256 !== check.evidenceSha256
    ) {
      fail(`checks.${checkName} evidence file is missing, invalid, or hash-drifted`);
    }
    if (typeof check.notes !== "string" || check.notes.trim().length < 10 || check.notes.length > 1000) {
      fail(`checks.${checkName}.notes must contain a concrete observation`);
    }
  }

  exactKeys(
    document.outcome,
    ["blockingFindings", "approvedBy", "approvedAt", "preSubmissionAccepted", "storeCertification"],
    "outcome",
  );
  if (!Array.isArray(document.outcome.blockingFindings) || document.outcome.blockingFindings.length !== 0) {
    fail("outcome.blockingFindings must be empty");
  }
  humanName(document.outcome.approvedBy, "outcome.approvedBy");
  validTimestamp(document.outcome.approvedAt, "outcome.approvedAt", now);
  if (document.outcome.preSubmissionAccepted !== true) {
    fail("outcome.preSubmissionAccepted must be true");
  }
  if (document.outcome.storeCertification !== "pending") {
    fail("outcome.storeCertification must remain pending until Partner Center certifies the submission");
  }
  return document;
}

export async function readStorePreSubmissionEvidenceArtifacts() {
  return Object.fromEntries(
    await Promise.all(
      STORE_PRE_SUBMISSION_CHECK_NAMES.map(async (checkName) => {
        const relativePath = storePreSubmissionEvidenceRelativePath(checkName);
        const bytes = await readFile(
          path.join(storePreSubmissionEvidenceRoot, `${checkName}-redacted-evidence.png`),
        );
        return [relativePath, inspectPng(bytes)];
      }),
    ),
  );
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex").toUpperCase();
}

function runVerifier(verifierPath, args = []) {
  const result = spawnSync(process.execPath, [verifierPath, ...args], {
    cwd: projectRoot,
    encoding: "utf8",
  });
  if (result.status !== 0) {
    fail(result.stderr.trim() || `${path.basename(verifierPath)} failed`);
  }
}

async function main() {
  readAndValidateStoreIdentity(defaultStoreIdentityPath);
  runVerifier(candidateVerifierPath);
  runVerifier(submissionInputsVerifierPath);
  runVerifier(storeReleaseManifestVerifierPath, ["--check"]);
  runVerifier(storeLicenseReviewVerifierPath);
  runVerifier(storeDefenderVerifierPath);
  runVerifier(storeSecurityVerifierPath);
  runVerifier(runtimeVerifierPath);
  runVerifier(storeDataLifecycleVerifierPath);
  runVerifier(wackVerifierPath);
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
    privacyPolicyBytes,
    candidateReportBytes,
    runtimeReportBytes,
    wackExecutionReportBytes,
    wackRawReportBytes,
    evidenceArtifacts,
  ] = await Promise.all([
    readFile(acceptancePath),
    readFile(defaultStoreIdentityPath),
    readFile(submissionInputsPath),
    readFile(storeReleaseManifestPath),
    readFile(storeLicenseReviewPacketPath),
    readFile(storeLicenseReviewAcceptancePath),
    readFile(storeDataLifecycleAcceptancePath),
    readFile(storeDefenderReportPath),
    readFile(storeSecurityAcceptancePath),
    readFile(privacyPolicyPath),
    readFile(candidateReportPath),
    readFile(runtimeReportPath),
    readFile(wackExecutionReportPath),
    readFile(wackRawReportPath),
    readStorePreSubmissionEvidenceArtifacts(),
  ]);
  const acceptance = validateStorePreSubmissionAcceptance(
    JSON.parse(acceptanceBytes.toString("utf8").replace(/^\uFEFF/, "")),
    { evidenceArtifacts },
  );
  const candidateReport = JSON.parse(candidateReportBytes.toString("utf8").replace(/^\uFEFF/, ""));
  const runtimeReport = JSON.parse(runtimeReportBytes.toString("utf8").replace(/^\uFEFF/, ""));
  const unsignedCandidatePath = path.resolve(projectRoot, candidateReport.candidate.path);
  const disposableTestSignedPackagePath = path.resolve(runtimeReport.candidate.sourcePath);
  const [unsignedCandidateBytes, disposableTestSignedPackageBytes] = await Promise.all([
    readFile(unsignedCandidatePath),
    readFile(disposableTestSignedPackagePath),
  ]);
  const expected = {
    storeIdentitySha256: sha256(identityBytes),
    storeSubmissionInputsSha256: sha256(submissionInputsBytes),
    storeReleaseManifestSha256: sha256(storeReleaseManifestBytes),
    storeLicenseReviewPacketSha256: sha256(storeLicenseReviewPacketBytes),
    storeLicenseReviewAcceptanceSha256: sha256(storeLicenseReviewAcceptanceBytes),
    storeDataLifecycleAcceptanceSha256: sha256(storeDataLifecycleAcceptanceBytes),
    storeDefenderReportSha256: sha256(storeDefenderReportBytes),
    storeSecurityAcceptanceSha256: sha256(storeSecurityAcceptanceBytes),
    privacyPolicySha256: sha256(privacyPolicyBytes),
    storeCandidateReportSha256: sha256(candidateReportBytes),
    unsignedStoreCandidateSha256: sha256(unsignedCandidateBytes),
    disposableTestSignedPackageSha256: sha256(disposableTestSignedPackageBytes),
    runtimeReportSha256: sha256(runtimeReportBytes),
    wackExecutionReportSha256: sha256(wackExecutionReportBytes),
    wackRawReportSha256: sha256(wackRawReportBytes),
  };
  if (!exact(acceptance.candidate, expected)) {
    fail("candidate evidence hashes drifted from the pre-submission acceptance");
  }
  process.stdout.write(
    `MSIX Store pre-submission acceptance verified for ${acceptance.candidate.disposableTestSignedPackageSha256}; Store certification remains pending.\n`,
  );
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    const message =
      error instanceof StorePreSubmissionVerificationError ? error.message : error.message;
    process.stderr.write(`MSIX Store pre-submission acceptance pending: ${message}\n`);
    process.exitCode = 2;
  });
}
