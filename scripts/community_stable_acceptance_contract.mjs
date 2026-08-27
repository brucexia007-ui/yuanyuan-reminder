import { validateCommunityStableAuthority } from "./community_release_contract.mjs";

export class CommunityStableAcceptanceError extends Error {}

const SHA256 = /^[A-F0-9]{64}$/u;
const COMMIT = /^[0-9a-f]{40}$/u;
const ALLOWED_PROMOTION_CHANGES = [
  "docs/release/COMMUNITY_STABLE_ACCEPTANCE_V1.json",
  "product-version.json",
];
const AUTOMATED_OPERATOR = /(?:^|[^a-z])(?:ai|bot)(?:[^a-z]|$)|automation|chatgpt|claude|codex|openai/iu;

function fail(message) {
  throw new CommunityStableAcceptanceError(message);
}

function exactKeys(value, keys, label) {
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    JSON.stringify(Object.keys(value).sort()) !== JSON.stringify([...keys].sort())
  ) {
    fail(`${label} fields do not match the community stable acceptance contract`);
  }
}

function passed(value, label) {
  if (value !== true) fail(`${label} must be explicitly passed`);
}

function sha256(value, label) {
  if (typeof value !== "string" || !SHA256.test(value)) {
    fail(`${label} must be an uppercase SHA-256 digest`);
  }
}

function safeIntegerAtLeast(value, minimum, label) {
  if (!Number.isSafeInteger(value) || value < minimum) {
    fail(`${label} is below the frozen community stable minimum`);
  }
}

function validateEndurance(check) {
  exactKeys(
    check,
    [
      "status",
      "reportSha256",
      "observedSeconds",
      "activeCoverageSeconds",
      "suspendResumeObserved",
      "lockUnlockObserved",
      "controlledExit",
      "applicationErrorCount",
      "formalUserFilesWritten",
    ],
    "checks.endurance24h",
  );
  if (check.status !== "passed") fail("24-hour endurance evidence is pending");
  sha256(check.reportSha256, "checks.endurance24h.reportSha256");
  safeIntegerAtLeast(check.observedSeconds, 86_400, "24-hour observed duration");
  safeIntegerAtLeast(check.activeCoverageSeconds, 72_000, "24-hour active coverage");
  passed(check.suspendResumeObserved, "sleep/resume observation");
  passed(check.lockUnlockObserved, "lock/unlock observation");
  passed(check.controlledExit, "endurance controlled exit");
  if (check.applicationErrorCount !== 0 || check.formalUserFilesWritten !== 0) {
    fail("endurance evidence must have zero application errors and zero formal-user writes");
  }
}

function validateInstalledE2e(check, installerSha256) {
  exactKeys(
    check,
    [
      "status",
      "reportSha256",
      "installerSha256",
      "scenarios",
      "formalUserDataUsed",
      "cleanupVerified",
    ],
    "checks.installedCandidateE2e",
  );
  if (check.status !== "passed") fail("installed candidate E2E is pending");
  sha256(check.reportSha256, "checks.installedCandidateE2e.reportSha256");
  sha256(check.installerSha256, "checks.installedCandidateE2e.installerSha256");
  if (check.installerSha256 !== installerSha256) {
    fail("installed candidate E2E is not bound to the accepted installer");
  }
  exactKeys(
    check.scenarios,
    [
      "installAndLaunch",
      "reminderDelivery",
      "hideAndRestorePet",
      "panelDrag",
      "backupAndRestore",
      "restartPersistence",
      "uninstallKeepsDataByDefault",
    ],
    "checks.installedCandidateE2e.scenarios",
  );
  for (const [scenario, result] of Object.entries(check.scenarios)) {
    passed(result, `installed E2E scenario ${scenario}`);
  }
  if (check.formalUserDataUsed !== false) {
    fail("installed candidate E2E must not use formal user data");
  }
  passed(check.cleanupVerified, "installed candidate E2E cleanup");
}

function validateLegacyData(check) {
  exactKeys(
    check,
    [
      "status",
      "sourceVersion",
      "normalizedSourceSha256",
      "reportSha256",
      "sourceUnchanged",
      "allRowsPreserved",
      "backupRestorePassed",
      "failureRollbackPassed",
    ],
    "checks.legacyDataCompatibility",
  );
  if (check.status !== "passed" || check.sourceVersion !== "1.3.2") {
    fail("authentic v1.3.2 data compatibility evidence is pending");
  }
  sha256(check.normalizedSourceSha256, "legacy source database digest");
  sha256(check.reportSha256, "legacy migration report digest");
  passed(check.sourceUnchanged, "legacy source preservation");
  passed(check.allRowsPreserved, "legacy row preservation");
  passed(check.backupRestorePassed, "legacy backup and restore");
  passed(check.failureRollbackPassed, "legacy migration rollback");
}

function validateLearningRuntime(check) {
  exactKeys(
    check,
    [
      "status",
      "reportSha256",
      "tauriImportPassed",
      "cancellationPassed",
      "importedCards",
      "paginationPassed",
      "answersApplied",
      "databaseGrowthWithinLimit",
      "backupRestorePassed",
    ],
    "checks.learningRuntime",
  );
  if (check.status !== "passed") fail("integrated learning runtime evidence is pending");
  sha256(check.reportSha256, "learning runtime report digest");
  passed(check.tauriImportPassed, "real Tauri learning import");
  passed(check.cancellationPassed, "real Tauri learning import cancellation");
  safeIntegerAtLeast(check.importedCards, 20_000, "learning imported card count");
  passed(check.paginationPassed, "learning pagination");
  safeIntegerAtLeast(check.answersApplied, 1_000, "learning applied answer count");
  passed(check.databaseGrowthWithinLimit, "learning database growth");
  passed(check.backupRestorePassed, "learning backup and restore");
}

export function validateCommunityStableAcceptance(
  acceptance,
  { authority, releaseCommit, changedPaths, now = new Date() },
) {
  validateCommunityStableAuthority(authority);
  exactKeys(
    acceptance,
    ["schemaVersion", "status", "product", "candidate", "checks", "review"],
    "acceptance",
  );
  if (acceptance.schemaVersion !== 1 || acceptance.status !== "accepted") {
    fail("community stable acceptance has not been completed");
  }
  exactKeys(acceptance.product, ["name", "identifier", "version"], "acceptance.product");
  if (
    acceptance.product.name !== authority.productName ||
    acceptance.product.identifier !== authority.identifier ||
    acceptance.product.version !== authority.version
  ) {
    fail("community stable acceptance product identity does not match the release authority");
  }
  exactKeys(
    acceptance.candidate,
    ["testedCommit", "installerSha256"],
    "acceptance.candidate",
  );
  if (!COMMIT.test(acceptance.candidate.testedCommit) || !COMMIT.test(releaseCommit)) {
    fail("community stable acceptance requires canonical tested and release commits");
  }
  sha256(acceptance.candidate.installerSha256, "accepted installer digest");

  const normalizedChanges = [...new Set(changedPaths.map((entry) => entry.replaceAll("\\", "/")))].sort();
  if (
    JSON.stringify(normalizedChanges) !== JSON.stringify([...ALLOWED_PROMOTION_CHANGES].sort())
  ) {
    fail("release source changed beyond the acceptance file and stable channel promotion");
  }

  exactKeys(
    acceptance.checks,
    ["endurance24h", "installedCandidateE2e", "legacyDataCompatibility", "learningRuntime"],
    "acceptance.checks",
  );
  validateEndurance(acceptance.checks.endurance24h);
  validateInstalledE2e(
    acceptance.checks.installedCandidateE2e,
    acceptance.candidate.installerSha256,
  );
  validateLegacyData(acceptance.checks.legacyDataCompatibility);
  validateLearningRuntime(acceptance.checks.learningRuntime);

  exactKeys(
    acceptance.review,
    ["operator", "completedAt", "unresolvedFindings"],
    "acceptance.review",
  );
  if (
    typeof acceptance.review.operator !== "string" ||
    acceptance.review.operator.trim().length < 2 ||
    acceptance.review.operator.length > 100 ||
    AUTOMATED_OPERATOR.test(acceptance.review.operator)
  ) {
    fail("community stable acceptance requires a named non-automated operator");
  }
  const completedAt = Date.parse(acceptance.review.completedAt);
  if (
    !Number.isFinite(completedAt) ||
    completedAt > now.getTime() + 300_000 ||
    !Array.isArray(acceptance.review.unresolvedFindings) ||
    acceptance.review.unresolvedFindings.length !== 0
  ) {
    fail("community stable acceptance review is incomplete or has unresolved findings");
  }
  return acceptance;
}

export const COMMUNITY_STABLE_PROMOTION_PATHS = [...ALLOWED_PROMOTION_CHANGES];
