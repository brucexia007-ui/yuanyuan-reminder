import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join, resolve, basename } from "node:path";
import { fileURLToPath } from "node:url";

import { verifyRuntimeBaselineSourceBinding } from "./verify_community_stable_runtime_baseline_candidate.mjs";

export class CommunityStableLearningEvidenceError extends Error {}

const SHA256 = /^[A-F0-9]{64}$/u;
const COMMIT = /^[0-9a-f]{40}$/u;
const RUNTIME_REPORT = /^learning-scale-runtime-\d{8}T\d{9}Z\.json$/u;
const ENVELOPE_KEYS = [
  "schemaVersion",
  "status",
  "generatedAtUtc",
  "productVersion",
  "buildVariant",
  "sourceCommit",
  "sourceDirty",
  "sourceBindingSha256",
  "applicationSha256",
  "runtimeReportFile",
  "runtimeReportSha256",
  "formalUserDataUsed",
  "formalUserDataChanged",
  "formalHandleAuditPassed",
  "externalFormalProcessObserved",
  "controlledExit",
  "cleanupVerified",
  "privacy",
];
const RUNTIME_KEYS = [
  "schemaVersion",
  "status",
  "productVersion",
  "runtimeIdentifier",
  "tauriProcessId",
  "syntheticDataOnly",
  "tauriImportPassed",
  "cancellationPassed",
  "importedCards",
  "paginationPassed",
  "answersApplied",
  "databaseGrowthWithinLimit",
  "backupRestorePassed",
  "sourceCsvSha256",
  "cancellationCheckCount",
  "databaseBytesAfterImport",
  "databaseBytesAfterAnswers",
  "answerGrowthBytes",
  "maximumDatabaseBytes",
  "maximumAnswerGrowthBytes",
  "restoredCardCount",
  "restoredReviewCount",
  "integrityCheck",
  "foreignKeyViolationCount",
  "elapsedMilliseconds",
  "privacy",
];

function fail(message) {
  throw new CommunityStableLearningEvidenceError(message);
}

function exactKeys(value, keys, label) {
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    JSON.stringify(Object.keys(value).sort()) !== JSON.stringify([...keys].sort())
  ) {
    fail(`${label} fields do not match the frozen contract`);
  }
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex").toUpperCase();
}

function parseJson(bytes, label) {
  try {
    return JSON.parse(bytes.toString("utf8"));
  } catch {
    fail(`${label} is not valid JSON`);
  }
}

function currentSource(projectRoot) {
  const commit = execFileSync("git", ["-C", projectRoot, "rev-parse", "HEAD"], {
    encoding: "utf8",
  }).trim();
  const dirty = execFileSync(
    "git",
    ["-C", projectRoot, "status", "--porcelain=v1", "--untracked-files=all"],
    { encoding: "utf8" },
  ).trim().length > 0;
  return { commit, dirty };
}

function positiveSafeInteger(value, label) {
  if (!Number.isSafeInteger(value) || value <= 0) fail(`${label} must be a positive integer`);
}

export function validateCommunityStableLearningEvidence({
  envelope,
  runtime,
  authority,
  source,
  sourceBinding = null,
  applicationSha256,
  runtimeReportSha256,
  allowDirty = false,
  now = new Date(),
}) {
  exactKeys(envelope, ENVELOPE_KEYS, "evidence envelope");
  exactKeys(runtime, RUNTIME_KEYS, "runtime report");
  if (envelope.schemaVersion !== 1 || envelope.status !== "passed") {
    fail("evidence envelope did not pass");
  }
  if (runtime.schemaVersion !== 1 || runtime.status !== "passed") {
    fail("runtime report did not pass");
  }
  if (
    authority.schemaVersion !== 1 ||
    typeof authority.version !== "string" ||
    envelope.productVersion !== authority.version ||
    runtime.productVersion !== authority.version
  ) {
    fail("product version does not match the version authority");
  }
  if (
    envelope.buildVariant !== "runtime-qa-learning" ||
    runtime.runtimeIdentifier !== "com.yuanyuan.reminder.runtime-qa"
  ) {
    fail("runtime build identity is invalid");
  }
  if (!COMMIT.test(source.commit) || envelope.sourceCommit !== source.commit) {
    fail("source commit does not match the current checkout");
  }
  if (envelope.sourceDirty !== source.dirty) {
    fail("source dirty state does not match the current checkout");
  }
  if (source.dirty && !allowDirty) {
    fail("strict learning evidence requires a clean worktree");
  }
  if (allowDirty) {
    if (envelope.sourceBindingSha256 !== null || sourceBinding !== null) {
      fail("development learning evidence cannot claim a formal source binding");
    }
  } else {
    if (
      sourceBinding === null ||
      !SHA256.test(envelope.sourceBindingSha256) ||
      envelope.sourceBindingSha256 !== sourceBinding.sha256 ||
      sourceBinding.commit !== source.commit ||
      sourceBinding.applicationSha256 !== applicationSha256 ||
      sourceBinding.dirty !== false ||
      Date.parse(envelope.generatedAtUtc) < Date.parse(sourceBinding.capturedAt)
    ) {
      fail("formal learning evidence is not bound to the clean integrated-learning candidate");
    }
  }
  if (
    !SHA256.test(envelope.applicationSha256) ||
    envelope.applicationSha256 !== applicationSha256 ||
    !SHA256.test(envelope.runtimeReportSha256) ||
    envelope.runtimeReportSha256 !== runtimeReportSha256
  ) {
    fail("evidence artifact digest does not match");
  }
  if (!RUNTIME_REPORT.test(envelope.runtimeReportFile)) {
    fail("runtime report file name is invalid");
  }
  const generatedAt = Date.parse(envelope.generatedAtUtc);
  if (!Number.isFinite(generatedAt) || generatedAt > now.getTime() + 300_000) {
    fail("evidence generation time is invalid");
  }
  if (
    envelope.formalUserDataUsed !== false ||
    envelope.formalHandleAuditPassed !== true ||
    (envelope.formalUserDataChanged === true &&
      envelope.externalFormalProcessObserved !== true) ||
    typeof envelope.formalUserDataChanged !== "boolean" ||
    typeof envelope.externalFormalProcessObserved !== "boolean" ||
    envelope.controlledExit !== true ||
    envelope.cleanupVerified !== true
  ) {
    fail("isolation, exit, or cleanup evidence did not pass");
  }
  if (
    typeof envelope.privacy !== "string" ||
    !envelope.privacy.includes("no user content or user paths") ||
    runtime.syntheticDataOnly !== true ||
    typeof runtime.privacy !== "string" ||
    !runtime.privacy.includes("no user content or user paths")
  ) {
    fail("privacy disclosure is incomplete");
  }
  positiveSafeInteger(runtime.tauriProcessId, "Tauri process id");
  if (
    runtime.tauriImportPassed !== true ||
    runtime.cancellationPassed !== true ||
    runtime.importedCards !== 20_000 ||
    runtime.paginationPassed !== true ||
    runtime.answersApplied !== 1_000 ||
    runtime.databaseGrowthWithinLimit !== true ||
    runtime.backupRestorePassed !== true
  ) {
    fail("one or more stable learning runtime checks did not pass");
  }
  if (!SHA256.test(runtime.sourceCsvSha256) || runtime.cancellationCheckCount < 1_024) {
    fail("synthetic source or cooperative cancellation evidence is invalid");
  }
  for (const [label, value] of [
    ["database bytes after import", runtime.databaseBytesAfterImport],
    ["database bytes after answers", runtime.databaseBytesAfterAnswers],
    ["elapsed milliseconds", runtime.elapsedMilliseconds],
  ]) {
    positiveSafeInteger(value, label);
  }
  if (
    runtime.maximumDatabaseBytes !== 128 * 1024 * 1024 ||
    runtime.maximumAnswerGrowthBytes !== 32 * 1024 * 1024 ||
    runtime.answerGrowthBytes !== Math.max(
      0,
      runtime.databaseBytesAfterAnswers - runtime.databaseBytesAfterImport,
    ) ||
    runtime.databaseBytesAfterAnswers > runtime.maximumDatabaseBytes ||
    runtime.answerGrowthBytes > runtime.maximumAnswerGrowthBytes ||
    runtime.elapsedMilliseconds > 900_000
  ) {
    fail("database growth or runtime duration exceeded the frozen limit");
  }
  if (
    runtime.restoredCardCount !== 20_000 ||
    runtime.restoredReviewCount !== 1_000 ||
    runtime.integrityCheck !== "ok" ||
    runtime.foreignKeyViolationCount !== 0
  ) {
    fail("restored learning database health is invalid");
  }
  return { envelope, runtime };
}

function parseArguments(argv) {
  let report;
  let binding;
  let allowDirty = false;
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === "--report" && argv[index + 1]) {
      report = resolve(argv[index + 1]);
      index += 1;
    } else if (argv[index] === "--binding" && argv[index + 1]) {
      binding = resolve(argv[index + 1]);
      index += 1;
    } else if (argv[index] === "--allow-dirty") {
      allowDirty = true;
    } else {
      fail(`unknown argument: ${argv[index]}`);
    }
  }
  if (!report) fail("--report is required");
  if (!allowDirty && !binding) fail("--binding is required for strict learning evidence");
  if (allowDirty && binding) fail("--binding cannot be combined with --allow-dirty");
  return { report, binding, allowDirty };
}

async function main() {
  const { report, binding, allowDirty } = parseArguments(process.argv.slice(2));
  const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const envelopeBytes = readFileSync(report);
  const envelope = parseJson(envelopeBytes, "evidence envelope");
  if (basename(envelope.runtimeReportFile) !== envelope.runtimeReportFile) {
    fail("runtime report path traversal is not allowed");
  }
  const runtimePath = join(dirname(report), envelope.runtimeReportFile);
  const runtimeBytes = readFileSync(runtimePath);
  const runtime = parseJson(runtimeBytes, "runtime report");
  const authority = parseJson(
    readFileSync(join(projectRoot, "product-version.json")),
    "version authority",
  );
  const source = currentSource(projectRoot);
  const applicationPath = join(
    projectRoot,
    "src-tauri",
    "target",
    "runtime-qa-learning",
    "release",
    "yuanyuan-reminder.exe",
  );
  const verifiedBinding = binding
    ? await verifyRuntimeBaselineSourceBinding({
      bindingPath: binding,
      testedCommit: source.commit,
      observedAt: envelope.generatedAtUtc,
    })
    : null;
  validateCommunityStableLearningEvidence({
    envelope,
    runtime,
    authority,
    source,
    sourceBinding: verifiedBinding
      ? {
        sha256: verifiedBinding.bindingSha256,
        commit: verifiedBinding.binding.source.commit,
        dirty: verifiedBinding.binding.source.dirty,
        capturedAt: verifiedBinding.binding.capturedAt,
        applicationSha256: verifiedBinding.binding.artifacts.application.sha256,
      }
      : null,
    applicationSha256: sha256(readFileSync(applicationPath)),
    runtimeReportSha256: sha256(runtimeBytes),
    allowDirty,
  });
  process.stdout.write(
    `Community stable learning runtime evidence OK: ${report}\n` +
      `Evidence SHA-256: ${sha256(envelopeBytes)}\n` +
      `Runtime SHA-256: ${sha256(runtimeBytes)}\n`,
  );
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
